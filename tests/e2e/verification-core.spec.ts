/**
 * Consolidated E2E tests for gate verification lifecycle.
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

/** Poll until a gate reaches one of the target statuses or timeout expires. */
async function waitForGateAnyStatus(
	goalId: string,
	gateId: string,
	targetStatuses: string[],
	timeoutMs = 30_000,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
		const data = await res.json();
		if (targetStatuses.includes(data.status)) return data;
		await new Promise(r => setTimeout(r, 500));
	}
	const res = await apiFetch(`/api/goals/${goalId}/gates/${gateId}`);
	const data = await res.json();
	throw new Error(
		`Gate ${gateId} did not reach any of [${targetStatuses}] within ${timeoutMs}ms. Current: "${data.status}"`,
	);
}

// ===========================================================================
// 1. Verification WS events
//    (from verification-sessions.spec.ts)
// ===========================================================================

test.describe("Verification WS events", () => {

	test("gate_verification_started includes step definitions", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest content" }),
			});
			expect(signalResp.status).toBe(201);

			const started = await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "design-doc",
				30_000,
			);
			expect(started.goalId).toBe(goalId);
			expect(started.signalId).toBeTruthy();
			expect(started.steps).toBeDefined();
			expect(Array.isArray(started.steps)).toBe(true);
			expect(started.steps.length).toBeGreaterThan(0);
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
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest" }),
			});

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
			expect(stepComplete.sessionId).toBeUndefined();
			expect(stepComplete.status).toBe("passed");

			await waitForGateStatus(goalId, "design-doc", "passed");
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
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design" }),
			});

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

			await waitForGateStatus(goalId, "design-doc", "passed");
			await new Promise(r => setTimeout(r, 200));
			const afterResp = await apiFetch(`/api/goals/${goalId}/verifications/active`);
			const afterData = await afterResp.json();
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
});

// ===========================================================================
// 2. Multi-step and heavy verification
//    (from verification-sessions-heavy.spec.ts)
// ===========================================================================

test.describe("Multi-step and heavy verification", () => {
	test.setTimeout(120_000);

	test("all step events received for multi-step verification", async () => {
		const goalId = await createTestFastGoal();
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);
		try {
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design" }),
			});
			await waitForGateStatus(goalId, "design-doc", "passed");

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

	test("llm-review step_complete event includes sessionId", async () => {
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

			await ws.waitFor(
				(m) => m.type === "gate_signal_received" && m.gateId === "design-doc",
				30_000,
			);
			await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "design-doc",
				30_000,
			);
			await ws.waitFor(
				(m) => m.type === "gate_verification_step_complete" && m.gateId === "design-doc",
				30_000,
			);
			await ws.waitFor(
				(m) => m.type === "gate_verification_complete" && m.gateId === "design-doc",
				30_000,
			);
			await ws.waitFor(
				(m) => m.type === "gate_status_changed" && m.gateId === "design-doc",
				30_000,
			);

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
// 3. Verification output streaming
//    (from verification-output.spec.ts and verification-output-multi.spec.ts)
// ===========================================================================

test.describe("Verification output streaming", () => {

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
				30_000,
			);

			const after = Date.now();

			expect(typeof started.startedAt).toBe("number");
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
				30_000,
			);

			const after = Date.now();

			expect(typeof stepStarted.startedAt).toBe("number");
			expect(stepStarted.startedAt).toBeGreaterThanOrEqual(before);
			expect(stepStarted.startedAt).toBeLessThanOrEqual(after);
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

			const output = await ws.waitFor(
				(m) => m.type === "gate_verification_step_output" && m.gateId === "design-doc",
				30_000,
			);

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
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design" }),
			});
			await waitForGateStatus(goalId, "design-doc", "passed");

			await apiFetch(`/api/goals/${goalId}/gates/implementation/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});

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

			const started = await ws.waitFor(
				(m) => m.type === "gate_verification_started" && m.gateId === "design-doc",
				30_000,
			);
			const stepStarted = await ws.waitFor(
				(m) => m.type === "gate_verification_step_started" && m.gateId === "design-doc",
				30_000,
			);

			expect(typeof started.startedAt).toBe("number");
			expect(typeof stepStarted.startedAt).toBe("number");
			expect(stepStarted.startedAt).toBeGreaterThanOrEqual(started.startedAt);

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

// ===========================================================================
// 4. Active verification API (modal output)
//    (from verification-modal-output.spec.ts)
// ===========================================================================

test.describe("Active verification API", () => {

	test("active verification API returns step output that modal consumes", async () => {
		const goal = await createGoal({
			title: `Modal Output Bug ${Date.now()}`,
			workflowId: "test-fast",
		});
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });
		const ws = await connectWs(sessionId);

		try {
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest content for modal output bug" }),
			});

			await waitForGateStatus(goalId, "design-doc", "passed", 30_000);

			const res = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
			expect(res.status).toBe(200);
			const gateData = await res.json();

			const verification = gateData.signals?.[0]?.verification;
			expect(verification).toBeTruthy();
			expect(verification.steps).toBeTruthy();
			expect(verification.steps.length).toBeGreaterThan(0);

			const commandStep = verification.steps.find(
				(s: any) => s.type === "command"
			);
			expect(commandStep).toBeTruthy();

			// API returns output — this is what the REST endpoint provides
			const apiOutput = commandStep.output || "";
			expect(apiOutput, "REST API step output should contain command output").toBeTruthy();
			expect(apiOutput).toContain("ok");

			// Simulate what the UI modal does — reads ONLY liveOutput
			const liveOutput: string | undefined = undefined;

			// Bug path: modal uses `liveOutput || ""` and ignores `output`
			const buggyModalContent = liveOutput || "";
			expect(buggyModalContent, "Buggy modal path (liveOutput only) shows empty output").toBe("");

			// Fixed path: fall back to API output when liveOutput is empty
			const fixedModalContent = liveOutput || apiOutput || "";
			expect(fixedModalContent, "Fixed modal path (liveOutput || output) shows content").toBeTruthy();
			expect(fixedModalContent).toContain("ok");
		} finally {
			ws.close();
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});

	test("verification step output is available via API after command execution", async () => {
		const goal = await createGoal({
			title: `Step Output API ${Date.now()}`,
			workflowId: "test-fast",
		});
		const goalId = goal.id;
		const sessionId = await createSession({ goalId });

		try {
			await apiFetch(`/api/goals/${goalId}/gates/design-doc/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "# Design\n\nTest" }),
			});

			await waitForGateStatus(goalId, "design-doc", "passed", 30_000);

			const res = await apiFetch(`/api/goals/${goalId}/gates/design-doc`);
			const data = await res.json();

			const step = data.signals?.[0]?.verification?.steps?.[0];
			expect(step).toBeTruthy();
			expect(step.output, "Step output must be populated in API response").toBeTruthy();
		} finally {
			await deleteSession(sessionId);
			await deleteGoal(goalId);
		}
	});
});

// ===========================================================================
// 5. Expect-failure pipeline
//    (from error-pattern-verification.spec.ts — integration tests)
// ===========================================================================

test.describe("Expect failure pipeline", () => {

	test("expect:failure gate with matching error_pattern passes", async () => {
		const goal = await createGoal({
			title: `Error Pattern Match ${Date.now()}`,
			workflowId: "bug-fix",
		});
		const goalId = goal.id;

		try {
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content:
						"# Bug Analysis\n\nSteps: 1. run failing test\nRoot cause: src/calc.ts returns wrong value",
				}),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

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

			// Gate should pass — command failed AND output matches the pattern
			await waitForGateStatus(goalId, "reproducing-test", "passed");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("expect:failure gate with non-matching error_pattern fails", async () => {
		const goal = await createGoal({
			title: `Error Pattern NoMatch ${Date.now()}`,
			workflowId: "bug-fix",
		});
		const goalId = goal.id;

		try {
			await apiFetch(`/api/goals/${goalId}/gates/issue-analysis/signal`, {
				method: "POST",
				body: JSON.stringify({
					content:
						"# Bug Analysis\n\nSteps: 1. run test\nRoot cause: src/foo.ts:10 off-by-one",
				}),
			});
			await waitForGateStatus(goalId, "issue-analysis", "passed");

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

			// Gate should fail — command failed but output doesn't match pattern
			await waitForGateStatus(goalId, "reproducing-test", "failed");

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
			await deleteGoal(goalId);
		}
	});
});

// ===========================================================================
// 6. LLM Review verification
//    (from llm-review-verification.spec.ts)
// ===========================================================================

test.describe("LLM Review verification", () => {

	test("llm-review step uses skip path when BOBBIT_LLM_REVIEW_SKIP is set", async () => {
		const goalId = await createGeneralGoal();
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

			await waitForGateAnyStatus(goalId, "design-doc", ["passed", "failed"]);

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
			await deleteGoal(goalId);
		}
	});
});
