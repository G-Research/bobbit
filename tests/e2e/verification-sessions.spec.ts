/**
 * E2E tests for verification session registration and per-step WS events (light).
 *
 * Covers:
 * - Step definitions in gate_verification_started event
 * - gate_verification_step_complete event with sessionId
 * - Active verifications REST endpoint
 * - Active verifications for non-existent goal
 * - Command step_complete does not include sessionId
 */
import { test, expect } from "./in-process-harness.js";
import {
	apiFetch,
	createGoal,
	deleteGoal,
	connectWs,
	createSession,
	deleteSession,
	nonGitCwd,
	type WsMsg,
} from "./e2e-setup.js";

/** Create a goal using the test-fast workflow (command-only steps, fast). */
async function createTestFastGoal(): Promise<string> {
	const goal = await createGoal({ title: `Verification Sessions E2E ${Date.now()}`, workflowId: "test-fast" });
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
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	const data = await res.json();
	throw new Error(
		`Gate ${gateId} did not reach "${targetStatus}" within ${timeoutMs}ms. Current: "${data.status}"`,
	);
}

test.describe("Verification sessions and step events", () => {

	test("gate_verification_started includes step definitions", async () => {
		const goalId = await createTestFastGoal();
		// Connect a WS to an arbitrary session so we can observe broadcasts
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			// Signal design-doc gate
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest content" }),
			});
			expect(signalResp.status).toBe(201);

			// Wait for gate_verification_started with steps
			const started = await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "design-doc",
				30_000,
			);
			expect(started.goalId).toBe(goalId);
			expect(started.signalId).toBeTruthy();
			expect(started.steps).toBeDefined();
			expect(Array.isArray(started.steps)).toBe(true);
			expect(started.steps.length).toBeGreaterThan(0);
			// test-fast design-doc has one "Content present" command step
			expect(started.steps[0].name).toBe("Content present");
			expect(started.steps[0].type).toBe("command");

			await waitForGateStatus(goalId, "design-doc", "passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("gate_verification_step_complete events are broadcast for each step", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			// Signal design-doc
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest" }),
			});

			// Wait for step_complete — generous timeout for system load
			const stepComplete = await ws.waitFor(
				(m) => m.type === "gate_verification_step_complete" && m.gateId === "design-doc",
				30_000,
			);
			expect(stepComplete.goalId).toBe(goalId);
			expect(stepComplete.signalId).toBeTruthy();
			expect(stepComplete.stepIndex).toBe(0);
			expect(stepComplete.stepName).toBe("Content present");
			expect(stepComplete.status).toBe("passed");
			expect(typeof stepComplete.durationMs).toBe("number");
			expect(stepComplete.durationMs).toBeGreaterThanOrEqual(0);
			expect(typeof stepComplete.output).toBe("string");

			// Wait for overall complete
			const complete = await ws.waitFor(
				(m) => m.type === "gate_verification_complete" && m.gateId === "design-doc",
				30_000,
			);
			expect(complete.status).toBe("passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("active verifications REST endpoint returns running steps", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			// Signal design-doc
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design" }),
			});

			// Immediately check active verifications (may or may not be in-flight)
			const activeResp = await apiFetch(`/api/goals/${goalId}/verifications/active`);
			expect(activeResp.status).toBe(200);
			const { verifications } = await activeResp.json();
			expect(Array.isArray(verifications)).toBe(true);
			// The verification may have already completed (fast command), so we just check the shape
			// If still running, verify structure
			if (verifications.length > 0) {
				const v = verifications[0];
				expect(v.goalId).toBe(goalId);
				expect(v.gateId).toBe("design-doc");
				expect(v.signalId).toBeTruthy();
				expect(Array.isArray(v.steps)).toBe(true);
				expect(v.steps.length).toBeGreaterThan(0);
				expect(v.overallStatus).toMatch(/^(running|passed|failed)$/);
				expect(typeof v.startedAt).toBe("number");
				// Each step has required fields
				for (const step of v.steps) {
					expect(step.name).toBeTruthy();
					expect(step.type).toBeTruthy();
					expect(step.status).toMatch(/^(running|passed|failed)$/);
					expect(typeof step.startedAt).toBe("number");
				}
			}

			// Wait for completion, then verify the map is cleaned up
			await waitForGateStatus(goalId, "design-doc", "passed");
			// Give a brief pause for cleanup
			await new Promise(r => setTimeout(r, 200));
			const afterResp = await apiFetch(`/api/goals/${goalId}/verifications/active`);
			const afterData = await afterResp.json();
			// After completion, the active verifications map should have been cleaned up
			expect(afterData.verifications.length).toBe(0);
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("active verifications endpoint returns empty for non-existent goal", async () => {
		const resp = await apiFetch("/api/goals/nonexistent-goal-id/verifications/active");
		expect(resp.status).toBe(200);
		const { verifications } = await resp.json();
		expect(verifications).toEqual([]);
	});

	test("command step_complete does not include sessionId", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design" }),
			});

			const stepComplete = await ws.waitFor(
				(m) => m.type === "gate_verification_step_complete" && m.gateId === "design-doc",
				30_000,
			);
			// Command steps don't have a sessionId
			expect(stepComplete.sessionId).toBeUndefined();
			expect(stepComplete.status).toBe("passed");

			await waitForGateStatus(goalId, "design-doc", "passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});
});
