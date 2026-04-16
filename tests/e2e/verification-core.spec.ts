/**
 * Consolidated E2E tests for gate verification lifecycle.
 *
 * Optimized for speed: tests that share identical setup (create goal →
 * session → WS → signal) are merged into single dense tests with multiple
 * assertions. All describe blocks run in parallel.
 *
 * Merges assertions from:
 * - verification-sessions.spec.ts (WS event shape)
 * - verification-sessions-heavy.spec.ts (multi-step, event ordering, auto-pass)
 * - verification-output.spec.ts (streaming timestamps, step_output events)
 * - verification-output-multi.spec.ts (multi-step output, timestamp consistency)
 * - verification-modal-output.spec.ts (active verification API output)
 * - error-pattern-verification.spec.ts (expect:failure pipeline — 1 integration test)
 * - llm-review-verification.spec.ts (LLM review skip path)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a goal using the test-fast workflow (command-only steps, fast). */
async function createTestFastGoal(): Promise<string> {
	const goal = await createGoal({ title: `Verification Core E2E ${Date.now()}`, workflowId: "test-fast" });
	return goal.id;
}

/** Create a goal using the general workflow (has llm-review steps). */
async function createGeneralGoal(): Promise<string> {
	const goal = await createGoal({ title: `Verification General E2E ${Date.now()}`, workflowId: "general" });
	return goal.id;
}

// Gate status waiting uses WS events via ws.waitFor() — no polling needed.

// ===========================================================================
// 1. Command verification WS event lifecycle
//    Combines: started event shape, step_complete shape, no sessionId on
//    command steps, startedAt timestamps, step_started timestamps,
//    step_output events, timestamp consistency, and event ordering.
// ===========================================================================

test.describe("Command verification WS event lifecycle", () => {
	test.describe.configure({ mode: "parallel" });

	test("WS events have correct shape, timestamps, and ordering for design-doc signal @smoke", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			const before = Date.now();

			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest content" }),
			});
			expect(signalResp.status).toBe(201);

			// Collect all key events
			const signalReceived = await ws.waitFor(
				(m) => m.type === "gate_signal_received" && m.gateId === "design-doc",
				30_000,
			);
			const started = await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "design-doc",
				30_000,
			);
			const stepStarted = await ws.waitFor(
				(m) => m.type === "gate_verification_step_started" && m.gateId === "design-doc",
				30_000,
			);
			const stepOutput = await ws.waitFor(
				(m) => m.type === "gate_verification_step_output" && m.gateId === "design-doc",
				30_000,
			);
			const stepComplete = await ws.waitFor(
				(m) => m.type === "gate_verification_step_complete" && m.gateId === "design-doc",
				30_000,
			);
			const complete = await ws.waitFor(
				(m) => m.type === "gate_verification_complete" && m.gateId === "design-doc",
				30_000,
			);
			const statusChanged = await ws.waitFor(
				(m) => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "design-doc",
				30_000,
			);

			const after = Date.now();

			// --- gate_verification_started shape ---
			expect(started.goalId).toBe(goalId);
			expect(started.signalId).toBeTruthy();
			expect(started.steps).toBeDefined();
			expect(Array.isArray(started.steps)).toBe(true);
			expect(started.steps.length).toBeGreaterThan(0);
			expect(started.steps[0].name).toBe("Content present");
			expect(started.steps[0].type).toBe("command");
			// startedAt timestamp
			expect(typeof started.startedAt).toBe("number");
			expect(started.startedAt).toBeGreaterThanOrEqual(before);
			expect(started.startedAt).toBeLessThanOrEqual(after);

			// --- gate_verification_step_started shape ---
			expect(stepStarted.goalId).toBe(goalId);
			expect(stepStarted.signalId).toBeTruthy();
			expect(typeof stepStarted.stepIndex).toBe("number");
			expect(stepStarted.stepName).toBe("Content present");
			// startedAt timestamp
			expect(typeof stepStarted.startedAt).toBe("number");
			expect(stepStarted.startedAt).toBeGreaterThanOrEqual(before);
			expect(stepStarted.startedAt).toBeLessThanOrEqual(after);
			// Command steps do NOT include sessionId
			expect(stepStarted.sessionId).toBeUndefined();

			// --- Timestamp consistency: step starts at or after verification starts ---
			expect(stepStarted.startedAt).toBeGreaterThanOrEqual(started.startedAt);

			// --- gate_verification_step_output shape ---
			expect(stepOutput.goalId).toBe(goalId);
			expect(stepOutput.gateId).toBe("design-doc");
			expect(stepOutput.signalId).toBeTruthy();
			expect(stepOutput.stepIndex).toBe(0);
			expect(stepOutput.stream).toBe("stdout");
			expect(typeof stepOutput.text).toBe("string");
			expect(stepOutput.text).toContain("ok");
			expect(typeof stepOutput.ts).toBe("number");

			// --- gate_verification_step_complete shape ---
			expect(stepComplete.goalId).toBe(goalId);
			expect(stepComplete.signalId).toBeTruthy();
			expect(stepComplete.stepIndex).toBe(0);
			expect(stepComplete.stepName).toBe("Content present");
			expect(stepComplete.status).toBe("passed");
			expect(typeof stepComplete.durationMs).toBe("number");
			expect(stepComplete.durationMs).toBeGreaterThanOrEqual(0);
			expect(typeof stepComplete.output).toBe("string");
			// Command step_complete does NOT include sessionId
			expect(stepComplete.sessionId).toBeUndefined();

			// --- gate_verification_complete shape ---
			expect(complete.status).toBe("passed");

			// --- Event ordering ---
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

	test("auto-pass gate (no verify steps) skips step events @smoke", async () => {
		const goal = await createGoal({ title: `Auto-pass E2E ${Date.now()}` });
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			const gatesResp = await apiFetch(`/api/goals/${goalId}/gates`);
			const { gates } = await gatesResp.json();

			if (gates.length === 0) {
				return;
			}

			const firstGate = gates[0];
			await apiFetch(`/api/goals/${goalId}/gates/${firstGate.gateId}/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Auto test" }),
			});

			await ws.waitFor(
				(m) => m.type === "gate_verification_complete" && m.gateId === firstGate.gateId,
				15_000,
			);

			const verificationEvents = ws.messages.filter(
				(m) => m.gateId === firstGate.gateId &&
					(m.type === "gate_verification_started" ||
					 m.type === "gate_verification_step_complete" ||
					 m.type === "gate_verification_complete"),
			);
			expect(verificationEvents.length).toBeGreaterThanOrEqual(1);
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});
});

// ===========================================================================
// 2. Multi-step verification
//    Combines: all step events for multi-step + step_output field checks
// ===========================================================================

test.describe("Multi-step verification", () => {
	test.describe.configure({ mode: "parallel" });
	test.setTimeout(120_000);

	test("multi-step verification emits correct events and step_output fields", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			// Pass design-doc first (dependency)
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design" }),
			});
			await ws.waitFor(m => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "design-doc" && m.status === "passed", 15_000);

			// Signal implementation gate (depends on design-doc)
			await apiFetch(`/api/goals/${goalId}/gates/implementation/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});

			const started = await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "implementation",
				30_000,
			);
			expect(started.steps).toBeDefined();
			expect(started.steps.length).toBe(1);
			expect(started.steps[0].name).toBe("Quick check");

			// Check step_output event fields
			const output = await ws.waitFor(
				(m) => m.type === "gate_verification_step_output" && m.gateId === "implementation",
				30_000,
			);
			expect(output.goalId).toBe(goalId);
			expect(output.gateId).toBe("implementation");
			expect(output.signalId).toBeTruthy();
			expect(output.stepIndex).toBe(0);
			expect(["stdout", "stderr"]).toContain(output.stream);
			expect(typeof output.text).toBe("string");
			expect(typeof output.ts).toBe("number");
			expect(output.ts).toBeGreaterThan(0);

			const stepComplete = await ws.waitFor(
				(m) => m.type === "gate_verification_step_complete" && m.gateId === "implementation",
				30_000,
			);
			expect(stepComplete.stepName).toBe("Quick check");
			expect(stepComplete.status).toBe("passed");

			const complete = await ws.waitFor(
				(m) => m.type === "gate_verification_complete" && m.gateId === "implementation",
				30_000,
			);
			expect(complete.status).toBe("passed");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("llm-review step events include sessionId", async () => {
		const goalId = await createGeneralGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Design\n\nApproach: do something\n\nFiles: src/x.ts\n\nCriteria: works",
				}),
			});

			const stepStarted = await ws.waitFor(
				(m) => m.type === "gate_verification_step_started" && m.gateId === "design-doc",
				15_000,
			);
			expect(stepStarted.goalId).toBe(goalId);
			expect(stepStarted.signalId).toBeTruthy();
			expect(typeof stepStarted.stepIndex).toBe("number");
			expect(stepStarted.stepName).toBeTruthy();
			expect(stepStarted.sessionId).toBeTruthy();
			expect(stepStarted.sessionId).toMatch(/^llm-review-/);

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

			await ws.waitFor(m => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "design-doc" && m.status === "passed", 15_000);
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});
});

// ===========================================================================
// 3. Active verification & step output REST API
//    Combines: active verifications endpoint (running + empty), modal output
//    bug path, and step output availability after execution.
// ===========================================================================

test.describe("Verification REST API", () => {
	test.describe.configure({ mode: "parallel" });

	test("active verifications API and step output after completion", async () => {
		const goal = await createGoal({
			title: `Verification API ${Date.now()}`,
			workflowId: "test-fast",
		});
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);

		try {
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest content for API test" }),
			});

			// Check active verifications while running
			const activeResp = await apiFetch(`/api/goals/${goalId}/verifications/active`);
			expect(activeResp.status).toBe(200);
			const { verifications } = await activeResp.json();
			expect(Array.isArray(verifications)).toBe(true);
			if (verifications.length > 0) {
				const v = verifications[0];
				expect(v.goalId).toBe(goalId);
				expect(v.gateId).toBe("design-doc");
				expect(v.signalId).toBeTruthy();
				expect(Array.isArray(v.steps)).toBe(true);
				expect(v.steps.length).toBeGreaterThan(0);
				expect(v.overallStatus).toMatch(/^(running|passed|failed)$/);
				expect(typeof v.startedAt).toBe("number");
				for (const step of v.steps) {
					expect(step.name).toBeTruthy();
					expect(step.type).toBeTruthy();
					expect(step.status).toMatch(/^(running|passed|failed)$/);
					expect(typeof step.startedAt).toBe("number");
				}
			}

			// Wait for completion
			await ws.waitFor(m => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "design-doc" && m.status === "passed", 15_000);

			// Active verifications should be empty after completion
			await new Promise(r => setTimeout(r, 200));
			const afterResp = await apiFetch(`/api/goals/${goalId}/verifications/active`);
			const afterData = await afterResp.json();
			expect(afterData.verifications.length).toBe(0);

			// Step output available via gate REST API (modal output bug fix)
			const res = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
			expect(res.status).toBe(200);
			const gateData = await res.json();

			const verification = gateData.signals?.[0]?.verification;
			expect(verification).toBeTruthy();
			expect(verification.steps).toBeTruthy();
			expect(verification.steps.length).toBeGreaterThan(0);

			const commandStep = verification.steps.find((s: any) => s.type === "command");
			expect(commandStep).toBeTruthy();

			const apiOutput = commandStep.output || "";
			expect(apiOutput, "REST API step output should contain command output").toBeTruthy();
			expect(apiOutput).toContain("ok");

			// Modal bug path: liveOutput is undefined after completion, must fall back to API output
			const liveOutput: string | undefined = undefined;
			const fixedModalContent = liveOutput || apiOutput || "";
			expect(fixedModalContent, "Fixed modal path (liveOutput || output) shows content").toBeTruthy();
			expect(fixedModalContent).toContain("ok");
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
});

// ===========================================================================
// 4. Expect-failure pipeline
// ===========================================================================

test.describe("Expect failure pipeline", () => {
	test.describe.configure({ mode: "parallel" });

	test("expect:failure gate with matching error_pattern passes", async () => {
		const goal = await createGoal({
			title: `Error Pattern Match ${Date.now()}`,
			workflowId: "bug-fix",
		});
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);

		try {
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content:
						"# Bug Analysis\n\nSteps: 1. run failing test\nRoot cause: src/calc.ts returns wrong value",
				}),
			});
			await ws.waitFor(m => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "issue-analysis" && m.status === "passed", 15_000);

			const signalResp = await apiFetch(
				`/api/goals/${goalId}/gates/reproducing-test/signal`,
				{
					method: "POST",
					body: JSON.stringify({
						metadata: {
							test_command: "echo Expected 5 but got 3 1>&2 & exit 1",
							error_pattern: "Expected 5 but got 3",
						},
					}),
				},
			);
			expect(signalResp.status).toBe(201);

			await ws.waitFor(m => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "reproducing-test" && m.status === "passed", 15_000);
		} finally {
			ws.close();
			await deleteGoal(goalId);
		}
	});

	test("expect:failure gate with non-matching error_pattern fails", async () => {
		const goal = await createGoal({
			title: `Error Pattern NoMatch ${Date.now()}`,
			workflowId: "bug-fix",
		});
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);

		try {
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content:
						"# Bug Analysis\n\nSteps: 1. run test\nRoot cause: src/foo.ts:10 off-by-one",
				}),
			});
			await ws.waitFor(m => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "issue-analysis" && m.status === "passed", 15_000);

			const signalResp = await apiFetch(
				`/api/goals/${goalId}/gates/reproducing-test/signal`,
				{
					method: "POST",
					body: JSON.stringify({
						metadata: {
							test_command: "echo Module not found 1>&2 & exit 1",
							error_pattern: "Expected 5 but got 3",
						},
					}),
				},
			);
			expect(signalResp.status).toBe(201);

			await ws.waitFor(m => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "reproducing-test" && m.status === "failed", 15_000);

			const signalsResp = await apiFetch(
				`/api/goals/${goalId}/gates/reproducing-test/signals`,
			);
			const { signals } = await signalsResp.json();
			const lastSignal = signals[signals.length - 1];
			expect(lastSignal.verification.status).toBe("failed");
			expect(lastSignal.verification.steps[0].passed).toBe(false);
			expect(lastSignal.verification.steps[0].output).toMatch(
				/did not match expected error pattern/i,
			);
		} finally {
			ws.close();
			await deleteGoal(goalId);
		}
	});
});

// ===========================================================================
// 5. LLM Review verification
// ===========================================================================

test.describe("LLM Review verification", () => {

	test("llm-review step uses skip path when BOBBIT_LLM_REVIEW_SKIP is set", async () => {
		const goalId = await createGeneralGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({
					content: "# Design\n\nApproach: implement feature X\n\nFiles: src/x.ts\n\nCriteria: passes tests",
				}),
			});
			expect(signalResp.status).toBe(201);
			const signalData = await signalResp.json();
			expect(signalData.signal.status).toBe("running");

			await ws.waitFor(m => m.type === "gate_status_changed" && m.goalId === goalId && m.gateId === "design-doc" && (m.status === "passed" || m.status === "failed"), 15_000);

			const signalsResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signals`);
			expect(signalsResp.status).toBe(200);
			const { signals } = await signalsResp.json();
			expect(signals.length).toBeGreaterThan(0);

			const lastSignal = signals[signals.length - 1];
			expect(lastSignal.verification.status).toMatch(/^(passed|failed)$/);
			expect(lastSignal.verification.steps.length).toBeGreaterThan(0);

			const reviewStep = lastSignal.verification.steps.find(
				(s: any) => s.type === "llm-review",
			);
			expect(reviewStep).toBeTruthy();

			expect(reviewStep.output).toContain("LLM review skipped");
			expect(reviewStep.output).toContain("BOBBIT_LLM_REVIEW_SKIP");

			expect(reviewStep.output).not.toContain("auto-passed");
			expect(reviewStep.output).not.toContain("not yet implemented");
		} finally {
			ws.close();
			await deleteGoal(goalId);
		}
	});
});
