/**
 * E2E tests for multi-step verification output:
 *
 * - step_output events have correct fields for multi-step verification
 * - startedAt timestamps are consistent across verification lifecycle
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	connectWs,
	createSession,
	deleteSession,
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
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error(`Gate ${gateId} did not reach "${targetStatus}" within ${timeoutMs}ms`);
}

test.describe("Verification output streaming and timestamps (multi-step)", () => {

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
