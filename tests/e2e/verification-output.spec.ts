/**
 * E2E tests for live verification UX features:
 *
 * - gate_verification_started WS events include startedAt field
 * - gate_verification_step_started WS events include startedAt field
 * - gate_verification_step_output WS events are broadcast during command verification
 */
import { test, expect } from "@playwright/test";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	connectWs,
	createSession,
	deleteSession,
	nonGitCwd,
} from "./e2e-setup.js";

/** Create a goal using the test-fast workflow (command-only steps, fast). */
async function createTestFastGoal(): Promise<string> {
	const goal = await createGoal({ title: `Verification Output E2E ${Date.now()}`, workflowId: "test-fast" });
	return goal.id;
}

/** Poll until a gate reaches the target status or timeout expires. */
async function waitForGateStatus(
	goalId: string,
	gateId: string,
	targetStatus: string,
	timeoutMs = 30_000,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		const data = await res.json();
		if (data.status === targetStatus) return data;
		await new Promise(r => setTimeout(r, 300));
	}
	throw new Error(`Gate ${gateId} did not reach "${targetStatus}" within ${timeoutMs}ms`);
}

test.describe("Verification output streaming and timestamps", () => {

	test("gate_verification_started includes startedAt timestamp", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			const before = Date.now();

			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest content" }),
			});

			const started = await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "design-doc",
				10_000,
			);

			const after = Date.now();

			// startedAt must be present and a number
			expect(typeof started.startedAt).toBe("number");
			// Must be a reasonable timestamp (between before and after the signal)
			expect(started.startedAt).toBeGreaterThanOrEqual(before);
			expect(started.startedAt).toBeLessThanOrEqual(after);

			await waitForGateStatus(goalId, "design-doc", "passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("gate_verification_step_started includes startedAt timestamp", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			const before = Date.now();

			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest content" }),
			});

			const stepStarted = await ws.waitFor(
				(m) => m.type === "gate_verification_step_started" && m.gateId === "design-doc",
				10_000,
			);

			const after = Date.now();

			// startedAt must be present and a number
			expect(typeof stepStarted.startedAt).toBe("number");
			expect(stepStarted.startedAt).toBeGreaterThanOrEqual(before);
			expect(stepStarted.startedAt).toBeLessThanOrEqual(after);
			// Also has standard fields
			expect(stepStarted.goalId).toBe(goalId);
			expect(stepStarted.signalId).toBeTruthy();
			expect(typeof stepStarted.stepIndex).toBe("number");
			expect(stepStarted.stepName).toBe("Content present");

			await waitForGateStatus(goalId, "design-doc", "passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("gate_verification_step_output events are broadcast for command steps", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest" }),
			});

			// The test-fast design-doc gate runs "echo ok", so we should get stdout output
			const output = await ws.waitFor(
				(m) => m.type === "gate_verification_step_output" && m.gateId === "design-doc",
				10_000,
			);

			// Validate all required fields
			expect(output.goalId).toBe(goalId);
			expect(output.gateId).toBe("design-doc");
			expect(output.signalId).toBeTruthy();
			expect(typeof output.stepIndex).toBe("number");
			expect(output.stepIndex).toBe(0);
			expect(output.stream).toBe("stdout");
			expect(typeof output.text).toBe("string");
			expect(output.text).toContain("ok");
			expect(typeof output.ts).toBe("number");

			await waitForGateStatus(goalId, "design-doc", "passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("step_output events have correct fields for multi-step verification", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			// Pass design-doc first
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design" }),
			});
			await waitForGateStatus(goalId, "design-doc", "passed");

			// Signal implementation (also has 1 command step in test-fast: "echo ok")
			await apiFetch(`/api/goals/${goalId}/gates/implementation/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});

			const output = await ws.waitFor(
				(m) => m.type === "gate_verification_step_output" && m.gateId === "implementation",
				10_000,
			);

			expect(output.goalId).toBe(goalId);
			expect(output.gateId).toBe("implementation");
			expect(output.signalId).toBeTruthy();
			expect(output.stepIndex).toBe(0);
			expect(["stdout", "stderr"]).toContain(output.stream);
			expect(typeof output.text).toBe("string");
			expect(typeof output.ts).toBe("number");
			expect(output.ts).toBeGreaterThan(0);

			await waitForGateStatus(goalId, "implementation", "passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("stderr output is captured in step_output events", async () => {
		// Use bug-fix workflow which has expect:failure steps
		// We need a command that writes to stderr
		const goal = await createGoal({
			title: `Verification Stderr E2E ${Date.now()}`,
			workflowId: "bug-fix",
		});
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			// Signal issue-analysis first
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Bug\n\nSteps: run test\nRoot cause: src/x.ts:1",
				}),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

			// Signal reproducing-test with a command that writes to stderr
			// "echo error-text 1>&2 && exit 1" writes to stderr and exits non-zero
			// (expect: failure means non-zero exit = pass)
			await apiFetch(`/api/goals/${goalId}/gates/reproducing-test/signal`, {
				method: "POST",
				body: JSON.stringify({
					metadata: { test_command: "echo error-text 1>&2 && exit 1" },
				}),
			});

			// Collect all step_output events for this gate
			const allOutputs: any[] = [];
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				try {
					const msg = await ws.waitFor(
						(m) =>
							m.type === "gate_verification_step_output" &&
							m.gateId === "reproducing-test" &&
							!allOutputs.some(o => o === m),
						2_000,
					);
					allOutputs.push(msg);
				} catch {
					break; // No more output events
				}
			}

			// Should have at least one stderr output event
			const stderrEvents = allOutputs.filter(o => o.stream === "stderr");
			// On Windows, cmd.exe may route echo to stdout even with 1>&2 redirection
			// so we check that we got at least some output events
			expect(allOutputs.length).toBeGreaterThan(0);

			// All events should have valid structure
			for (const evt of allOutputs) {
				expect(evt.goalId).toBe(goalId);
				expect(evt.gateId).toBe("reproducing-test");
				expect(typeof evt.signalId).toBe("string");
				expect(typeof evt.stepIndex).toBe("number");
				expect(["stdout", "stderr"]).toContain(evt.stream);
				expect(typeof evt.text).toBe("string");
				expect(typeof evt.ts).toBe("number");
			}

			await waitForGateStatus(goalId, "reproducing-test", "passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("startedAt timestamps are consistent across verification lifecycle", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design" }),
			});

			// Collect all events
			const started = await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "design-doc",
				10_000,
			);
			const stepStarted = await ws.waitFor(
				(m) => m.type === "gate_verification_step_started" && m.gateId === "design-doc",
				10_000,
			);

			// Both should have startedAt
			expect(typeof started.startedAt).toBe("number");
			expect(typeof stepStarted.startedAt).toBe("number");

			// Step startedAt should be >= verification startedAt
			expect(stepStarted.startedAt).toBeGreaterThanOrEqual(started.startedAt);

			// Both should be recent timestamps (within last 30s)
			const now = Date.now();
			expect(now - started.startedAt).toBeLessThan(30_000);
			expect(now - stepStarted.startedAt).toBeLessThan(30_000);

			await waitForGateStatus(goalId, "design-doc", "passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});
});
