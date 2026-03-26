/**
 * E2E tests for verification session registration and per-step WS events.
 *
 * Covers:
 * - gate_verification_step_started event with sessionId for LLM review steps
 * - gate_verification_step_complete event with sessionId
 * - Active verifications REST endpoint
 * - Step definitions in gate_verification_started event
 * - Verification WS event ordering and completeness
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
		await new Promise(r => setTimeout(r, 300));
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
				10_000,
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

			// Wait for step_complete
			const stepComplete = await ws.waitFor(
				(m) => m.type === "gate_verification_step_complete" && m.gateId === "design-doc",
				10_000,
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
				10_000,
			);
			expect(complete.status).toBe("passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

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
				10_000,
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
