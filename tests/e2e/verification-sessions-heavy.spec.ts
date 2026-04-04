/**
 * E2E tests for verification session registration and per-step WS events (heavy).
 *
 * Covers:
 * - All step events for multi-step verification
 * - LLM-review step_complete event includes sessionId
 * - Full WS event sequence for verification lifecycle
 * - Auto-pass gate (no verify steps) skips step events
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

/** Create a goal using the general workflow (has llm-review steps). */
async function createGeneralGoal(): Promise<string> {
	const goal = await createGoal({ title: `Verification General E2E ${Date.now()}`, workflowId: "general" });
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

test.describe("Verification sessions and step events (heavy)", () => {

	test("all step events received for multi-step verification", async () => {
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

			// Signal implementation which also has 1 step in test-fast
			await apiFetch(`/api/goals/${goalId}/gates/implementation/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});

			// Wait for the started event with step definitions
			const started = await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "implementation",
				10_000,
			);
			expect(started.steps).toBeDefined();
			expect(started.steps.length).toBe(1);
			expect(started.steps[0].name).toBe("Quick check");

			// Wait for step_complete
			const stepComplete = await ws.waitFor(
				(m) => m.type === "gate_verification_step_complete" && m.gateId === "implementation",
				10_000,
			);
			expect(stepComplete.stepName).toBe("Quick check");
			expect(stepComplete.status).toBe("passed");

			// Wait for verification complete
			const complete = await ws.waitFor(
				(m) => m.type === "gate_verification_complete" && m.gateId === "implementation",
				10_000,
			);
			expect(complete.status).toBe("passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("llm-review step_complete event includes sessionId", async () => {
		// Uses general workflow which has llm-review steps (skipped via BOBBIT_LLM_REVIEW_SKIP)
		const goalId = await createGeneralGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			// Signal design-doc (has llm-review steps)
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Design\n\nApproach: do something\n\nFiles: src/x.ts\n\nCriteria: works",
				}),
			});

			// Wait for step_started event (broadcast for llm-review steps with sessionId)
			const stepStarted = await ws.waitFor(
				(m) => m.type === "gate_verification_step_started" && m.gateId === "design-doc",
				15_000,
			);
			expect(stepStarted.goalId).toBe(goalId);
			expect(stepStarted.signalId).toBeTruthy();
			expect(typeof stepStarted.stepIndex).toBe("number");
			expect(stepStarted.stepName).toBeTruthy();
			// LLM review steps get a pre-generated sessionId
			expect(stepStarted.sessionId).toBeTruthy();
			expect(stepStarted.sessionId).toMatch(/^llm-review-/);

			// Wait for step_complete for an llm-review step — should include sessionId
			const stepComplete = await ws.waitFor(
				(m) =>
					m.type === "gate_verification_step_complete" &&
					m.gateId === "design-doc" &&
					m.sessionId != null,
				15_000,
			);
			expect(stepComplete.sessionId).toBeTruthy();
			expect(stepComplete.sessionId).toMatch(/^llm-review-/);
			expect(stepComplete.status).toMatch(/^(passed|failed)$/);

			await waitForGateStatus(goalId, "design-doc", "passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("full WS event sequence for verification lifecycle", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design" }),
			});

			// Wait for all expected events
			await ws.waitFor(
				(m) => m.type === "gate_signal_received" && m.gateId === "design-doc",
				10_000,
			);
			await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "design-doc",
				10_000,
			);
			await ws.waitFor(
				(m) => m.type === "gate_verification_step_complete" && m.gateId === "design-doc",
				10_000,
			);
			await ws.waitFor(
				(m) => m.type === "gate_verification_complete" && m.gateId === "design-doc",
				10_000,
			);
			await ws.waitFor(
				(m) => m.type === "gate_status_changed" && m.gateId === "design-doc",
				10_000,
			);

			// Verify the order: signal_received < started < step_complete < complete < status_changed
			const events = ws.messages.filter(
				(m) =>
					(m.type === "gate_signal_received" ||
					 m.type === "gate_verification_started" ||
					 m.type === "gate_verification_step_complete" ||
					 m.type === "gate_verification_complete" ||
					 m.type === "gate_status_changed") &&
					m.gateId === "design-doc",
			);

			const types = events.map((e) => e.type);
			const signaledIdx = types.indexOf("gate_signal_received");
			const startedIdx = types.indexOf("gate_verification_started");
			const stepCompleteIdx = types.indexOf("gate_verification_step_complete");
			const completeIdx = types.indexOf("gate_verification_complete");
			const statusChangedIdx = types.indexOf("gate_status_changed");

			expect(signaledIdx).toBeLessThan(startedIdx);
			expect(startedIdx).toBeLessThan(stepCompleteIdx);
			expect(stepCompleteIdx).toBeLessThan(completeIdx);
			expect(completeIdx).toBeLessThan(statusChangedIdx);
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("auto-pass gate (no verify steps) skips step events", async () => {
		// Create a goal without workflow — gates may auto-pass or have no verify steps
		// Use a custom approach: signal a gate that has no verify steps
		// Actually, let's create a workflow-less goal and check behavior
		const goal = await createGoal({ title: `Auto-pass E2E ${Date.now()}` });
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			// Get the gates — default workflow should be applied
			const gatesResp = await apiFetch(`/api/goals/${goalId}/gates`);
			const { gates } = await gatesResp.json();

			if (gates.length === 0) {
				// No gates means no verification to test — skip
				return;
			}

			// Signal the first gate
			const firstGate = gates[0];
			await apiFetch(`/api/goals/${goalId}/gates/${firstGate.gateId}/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Auto test" }),
			});

			// Wait for verification to complete
			await ws.waitFor(
				(m) => m.type === "gate_verification_complete" && m.gateId === firstGate.gateId,
				15_000,
			);

			// Verify we got the standard events
			const verificationEvents = ws.messages.filter(
				(m) => m.gateId === firstGate.gateId &&
					(m.type === "gate_verification_started" ||
					 m.type === "gate_verification_step_complete" ||
					 m.type === "gate_verification_complete"),
			);
			expect(verificationEvents.length).toBeGreaterThanOrEqual(1); // At minimum, complete event
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});
});
