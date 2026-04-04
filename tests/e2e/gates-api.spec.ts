import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base, nonGitCwd } from "./e2e-setup.js";

let token: string;

const headers = () => ({
	Authorization: `Bearer ${token}`,
	"Content-Type": "application/json",
});

async function apiFetch(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${base()}${path}`, {
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
		await new Promise(r => setTimeout(r, 50));
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

			expect(gates).toHaveLength(4);
			const ids = gates.map((g: any) => g.gateId);
			expect(ids).toContain("design-doc");
			expect(ids).toContain("implementation");
			expect(ids).toContain("documentation");
			expect(ids).toContain("ready-to-merge");
			expect(ids).toContain("ready-to-merge");

			for (const gate of gates) {
				expect(gate.status).toBe("pending");
			}
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
});
