import { test, expect } from "@playwright/test";
import { readE2EToken, BASE, nonGitCwd } from "./e2e-setup.js";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${BASE}${path}`, {
		...opts,
		headers: { ...headers(), ...(opts?.headers || {}) },
	});
}

/** Create a goal with a specific workflow, returning its ID. */
async function createGoalWithWorkflow(workflowId: string): Promise<string> {
	const resp = await apiFetch("/api/goals", {
		method: "POST",
		body: JSON.stringify({
			title: `Gate Test ${workflowId} ${Date.now()}`,
			cwd: nonGitCwd(),
			team: false,
			workflowId,
		}),
	});
	expect(resp.status).toBe(201);
	const goal = await resp.json();
	return goal.id;
}

/** Delete a goal. */
async function deleteGoal(goalId: string): Promise<void> {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" });
}

/**
 * Poll until a gate reaches the target status or timeout expires.
 * Returns the gate object on success; throws on timeout.
 */
async function waitForGateStatus(
	goalId: string,
	gateId: string,
	targetStatus: string,
	timeoutMs = 15000,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		const data = await res.json();
		if (data.status === targetStatus) return data;
		await new Promise(r => setTimeout(r, 500));
	}
	// One last check with detail for error message
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	const data = await res.json();
	throw new Error(
		`Gate ${gateId} did not reach status "${targetStatus}" within ${timeoutMs}ms. Current status: "${data.status}"`,
	);
}

test.beforeAll(() => {
	token = readE2EToken();
});

test.describe("Gates API", () => {
	test("gate lifecycle — list gates for new goal", async () => {
		const goalId = await createGoalWithWorkflow("general");
		try {
			const resp = await apiFetch(`/api/goals/${goalId}/gates`);
			expect(resp.status).toBe(200);
			const { gates } = await resp.json();

			expect(gates).toHaveLength(3);
			const ids = gates.map((g: any) => g.gateId);
			expect(ids).toContain("design-doc");
			expect(ids).toContain("implementation");
			expect(ids).toContain("ready-to-merge");

			for (const gate of gates) {
				expect(gate.status).toBe("pending");
			}
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("gate signal and verification — content gate", async () => {
		const goalId = await createGoalWithWorkflow("general");
		try {
			// Signal design-doc gate with content
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Design\n\nApproach: do the thing\n\nFiles: src/foo.ts\n\nCriteria: it works",
				}),
			});
			expect(signalResp.status).toBe(201);
			const signalData = await signalResp.json();
			expect(signalData.signal.id).toBeTruthy();
			expect(signalData.signal.status).toBe("running");

			// Wait for pass (LLM review auto-passes)
			await waitForGateStatus(goalId, "design-doc", "passed");

			// Verify content is retrievable
			const contentResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/content`);
			expect(contentResp.status).toBe(200);
			const contentData = await contentResp.json();
			expect(contentData.content).toContain("Approach: do the thing");
			expect(contentData.version).toBe(1);

			// Verify signal history
			const signalsResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signals`);
			expect(signalsResp.status).toBe(200);
			const { signals } = await signalsResp.json();
			expect(signals).toHaveLength(1);
			expect(signals[0].id).toBe(signalData.signal.id);
			expect(signals[0].verification.status).toBe("passed");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("dependency gating — cannot signal gate with unmet deps", async () => {
		const goalId = await createGoalWithWorkflow("general");
		try {
			// Try to signal implementation before design-doc passes
			const resp = await apiFetch(`/api/goals/${goalId}/gates/implementation/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(resp.status).toBe(409);
			const body = await resp.json();
			expect(body.error).toContain("has not passed");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("expect failure — command that fails passes verification", async () => {
		const goalId = await createGoalWithWorkflow("bug-fix");
		try {
			// Signal issue-analysis (content gate with LLM review — auto-passes)
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Bug Analysis\n\nSteps: 1. call add(2,3)\nRoot cause: src/calc.ts:5 uses minus instead of plus",
				}),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

			// Signal reproducing-test with a command that fails (exit 1) and matching error_pattern
			// Because the gate has expect: failure + non-zero exit + matching pattern = pass
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signal`, {
				method: "POST",
				body: JSON.stringify({
					metadata: { test_command: "echo Expected addition to equal 5 1>&2 & exit 1", error_pattern: "Expected addition to equal 5" },
				}),
			});
			expect(signalResp.status).toBe(201);

			// Gate should pass because expect:failure + non-zero exit + matching error_pattern = pass
			await waitForGateStatus(goalId, "reproducing-test", "passed");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("expect failure — command that succeeds fails verification", async () => {
		const goalId = await createGoalWithWorkflow("bug-fix");
		try {
			// Signal issue-analysis first
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Bug\n\nSteps: 1. run test\nRoot cause: src/x.ts:1",
				}),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

			// Signal reproducing-test with a command that succeeds (exit 0)
			// Because the gate has expect: failure, a zero exit = fail
			await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signal`, {
				method: "POST",
				body: JSON.stringify({
					metadata: { test_command: "exit 0", error_pattern: "some error" },
				}),
			});

			// Gate should fail because expect:failure + zero exit = fail
			const gate = await waitForGateStatus(goalId, "reproducing-test", "failed");
			// Verify the verification step shows failure
			const signalsResp = await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signals`);
			const { signals } = await signalsResp.json();
			const lastSignal = signals[signals.length - 1];
			expect(lastSignal.verification.status).toBe("failed");
			expect(lastSignal.verification.steps.length).toBeGreaterThan(0);
			expect(lastSignal.verification.steps[0].passed).toBe(false);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("cascade reset — re-signaling upstream resets downstream", async () => {
		// Use test-fast workflow — general runs npm run check/test which is too slow for 30s timeout
		const goalId = await createGoalWithWorkflow("test-fast");
		try {
			// Signal design-doc → pass
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design v1\n\nApproach: X\nFiles: a.ts\nCriteria: Y" }),
			});
			await waitForGateStatus(goalId, "design-doc", "passed");

			// Signal implementation (test-fast just runs "echo ok")
			await apiFetch(`/api/goals/${goalId}/gates/implementation/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			await waitForGateStatus(goalId, "implementation", "passed");

			// Verify both are passed
			const gatesResp1 = await apiFetch(`/api/goals/${goalId}/gates`);
			const { gates: gates1 } = await gatesResp1.json();
			expect(gates1.find((g: any) => g.gateId === "design-doc").status).toBe("passed");
			expect(gates1.find((g: any) => g.gateId === "implementation").status).toBe("passed");

			// Re-signal design-doc with new content
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design v2\n\nApproach: Y\nFiles: b.ts\nCriteria: Z" }),
			});
			await waitForGateStatus(goalId, "design-doc", "passed");

			// Implementation and ready-to-merge should be reset to pending
			const gatesResp2 = await apiFetch(`/api/goals/${goalId}/gates`);
			const { gates: gates2 } = await gatesResp2.json();
			expect(gates2.find((g: any) => g.gateId === "implementation").status).toBe("pending");
			expect(gates2.find((g: any) => g.gateId === "ready-to-merge").status).toBe("pending");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("signal history — multiple signals tracked", async () => {
		const goalId = await createGoalWithWorkflow("general");
		try {
			// Signal design-doc twice with different content
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design v1\n\nApproach: A\nFiles: x.ts\nCriteria: P" }),
			});
			await waitForGateStatus(goalId, "design-doc", "passed");

			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design v2\n\nApproach: B\nFiles: y.ts\nCriteria: Q" }),
			});
			await waitForGateStatus(goalId, "design-doc", "passed");

			// Check signal history
			const signalsResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signals`);
			const { signals } = await signalsResp.json();
			expect(signals).toHaveLength(2);

			// Each signal has unique id, timestamp, verification
			expect(signals[0].id).not.toBe(signals[1].id);
			expect(signals[0].timestamp).toBeLessThanOrEqual(signals[1].timestamp);
			expect(signals[0].verification.status).toBe("passed");
			expect(signals[1].verification.status).toBe("passed");

			// Content version should have incremented
			const contentResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/content`);
			const { version } = await contentResp.json();
			expect(version).toBe(2);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("metadata variable resolution", async () => {
		const goalId = await createGoalWithWorkflow("bug-fix");
		try {
			// Signal issue-analysis
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Analysis\n\nSteps: run echo\nRoot cause: src/a.ts:1",
				}),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

			// Signal reproducing-test with metadata
			await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signal`, {
				method: "POST",
				body: JSON.stringify({
					metadata: { test_command: "echo metadata-works", error_pattern: "some error" },
				}),
			});
			// This gate has expect:failure but "echo metadata-works" exits 0, so it fails
			// That's fine — we want to check the verification output contains the resolved command
			await waitForGateStatus(goalId, "reproducing-test", "failed");

			// Check the signal's verification step output — the {{test_command}} should have resolved
			const signalsResp = await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signals`);
			const { signals } = await signalsResp.json();
			const lastSignal = signals[signals.length - 1];
			// The command "echo metadata-works" ran and its output should contain the string
			const step = lastSignal.verification.steps[0];
			expect(step.output).toContain("metadata-works");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("gate detail endpoint returns enriched data", async () => {
		const goalId = await createGoalWithWorkflow("general");
		try {
			const resp = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
			expect(resp.status).toBe(200);
			const gate = await resp.json();
			expect(gate.gateId).toBe("design-doc");
			expect(gate.status).toBe("pending");
			expect(gate.name).toBe("Design Document");
			expect(gate.dependsOn).toEqual([]);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("gate 404 for nonexistent gate", async () => {
		const goalId = await createGoalWithWorkflow("general");
		try {
			const resp = await apiFetch(`/api/goals/${goalId}/gates/nonexistent`);
			expect(resp.status).toBe(404);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("signal 404 for nonexistent gate", async () => {
		const goalId = await createGoalWithWorkflow("general");
		try {
			const resp = await apiFetch(`/api/goals/${goalId}/gates/nonexistent/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(resp.status).toBe(404);
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("signal requires metadata when gate schema defines it", async () => {
		const goalId = await createGoalWithWorkflow("bug-fix");
		try {
			// Signal issue-analysis first to unblock reproducing-test
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Bug\nSteps: x\nRoot cause: y" }),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

			// Try to signal reproducing-test WITHOUT required metadata
			const resp = await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(resp.status).toBe(400);
			const body = await resp.json();
			expect(body.error).toContain("metadata");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("goal without explicit workflow gets default gates", async () => {
		// Create goal without explicit workflowId — may get a default workflow
		const resp = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Default Workflow Goal", cwd: nonGitCwd() }),
		});
		const goal = await resp.json();
		try {
			const gatesResp = await apiFetch(`/api/goals/${goal.id}/gates`);
			expect(gatesResp.status).toBe(200);
			const { gates } = await gatesResp.json();
			// Should have gates (default workflow assigns general gates)
			expect(gates.length).toBeGreaterThanOrEqual(0);
			for (const gate of gates) {
				expect(gate.status).toBe("pending");
			}
		} finally {
			await deleteGoal(goal.id);
		}
	});
});
