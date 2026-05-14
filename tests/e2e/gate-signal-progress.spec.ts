/**
 * API E2E regression test for the gate-signal step-enumeration race.
 *
 * See goal "Fix verification progress race" / issue-analysis gate.
 *
 * Pre-fix behaviour: when the team lead called `gate_signal`, the REST
 * response carried the enumerated `verification.steps[]`, but the
 * gate-store persisted the signal with `steps: []`. The harness's async
 * `verifyGateSignal()` would only populate the active map and the
 * persisted signal a handful of `await`s later. Any consumer that polled
 * `gate_status` between the POST returning and that async write — the
 * dashboard's gate poll, the team lead's follow-up `gate_status` call —
 * saw an empty `steps[]` and rendered no in-progress chips for 15-30s.
 *
 * Post-fix behaviour: `verificationHarness.beginVerification(signal, gate)`
 * synchronously enumerates the steps, seeds the `activeVerifications`
 * map, and returns the `GateSignalStep[]` for the REST handler to write
 * into `signal.verification.steps` BEFORE calling
 * `gateStore.recordSignal()`. From that moment on every reader (REST,
 * WS, persisted disk state) agrees on the step list.
 *
 * This test pins:
 *   AC #1 — `gate_status` and the POST response carry identical
 *           `steps[]` length and names with zero time-window between.
 *   AC #3 — Persisted gate-store state is the single source of truth;
 *           UI does not need a fallback to the POST body.
 *
 * The marker `GATE_SIGNAL_PROGRESS_RACE` appears in every assertion
 * message so a regression surfaces clearly in CI logs.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, createGoal, deleteGoal } from "./e2e-setup.js";

// A deterministic "slow" command that keeps the gate's phase-0 step
// running for ~3s — long enough to catch the in-flight active state
// even on a hot CI box, short enough not to bloat the suite. node -e
// is available on every test runner that runs this project.
const SLOW_CMD = `node -e "setTimeout(()=>process.exit(0),3000)"`;

/** Unique per-run workflow id so parallel workers don't collide. */
function makeWorkflowId(): string {
	return `progress-race-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Names + phases of the verify entries below — kept in sync with createWorkflow(). */
const EXPECTED_STEPS: Array<{ name: string; phase: number }> = [
	{ name: "Slow build",  phase: 0 }, // running
	{ name: "Type check",  phase: 1 }, // waiting
	{ name: "Unit tests",  phase: 1 }, // waiting
	{ name: "E2E tests",   phase: 2 }, // waiting
];

/**
 * Create a project-scoped workflow with 4 verify entries across 3 phases.
 * The phase-0 step is slow (`setTimeout(...,3s)`) so the verification is
 * still running when we read the gate-store back. Higher-phase steps
 * stay in `waiting` until phase-0 completes.
 */
async function createTestWorkflow(workflowId: string): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: workflowId,
			name: "Progress Race Test",
			description: "Inline workflow pinning the gate-signal step-enumeration race fix.",
			gates: [
				{
					id: "slow-multi",
					name: "Slow Multi-Step",
					dependsOn: [],
					verify: [
						{ name: "Slow build", type: "command", run: SLOW_CMD },
						{ name: "Type check", type: "command", phase: 1, run: "echo ok" },
						{ name: "Unit tests", type: "command", phase: 1, run: "echo ok" },
						{ name: "E2E tests",  type: "command", phase: 2, run: "echo ok" },
					],
				},
			],
		}),
	});
	expect(res.status, "GATE_SIGNAL_PROGRESS_RACE: workflow creation must succeed").toBe(201);
}

async function deleteTestWorkflow(workflowId: string): Promise<void> {
	await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => { /* best-effort */ });
}

test.describe("Gate-signal step enumeration race (verification-progress race)", () => {
	test("persisted gate-store steps[] matches POST response within the same scheduler tick — GATE_SIGNAL_PROGRESS_RACE", async () => {
		const workflowId = makeWorkflowId();
		await createTestWorkflow(workflowId);
		const goal = await createGoal({
			title: `Progress Race ${Date.now()}`,
			workflowId,
		});
		const goalId = goal.id;

		try {
			// ── 1. POST signal — capture response, no awaits between this and
			//      the follow-up GETs other than the response.json() necessary
			//      to read the body. This mirrors what the dashboard's polling
			//      reader would observe on the very next tick.
			const postResp = await apiFetch(`/api/goals/${goalId}/gates/slow-multi/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(
				postResp.status,
				"GATE_SIGNAL_PROGRESS_RACE: signal POST must succeed",
			).toBe(201);
			const postBody = await postResp.json();
			const postSignalId: string = postBody.signal.id;
			const postSteps: Array<{ name: string; type: string }> = postBody.signal.steps;

			// AC #1: POST response carries the enumerated step list.
			expect(
				postSteps.map((s) => s.name),
				"GATE_SIGNAL_PROGRESS_RACE: POST response steps[] must mirror gate.verify[] names",
			).toEqual(EXPECTED_STEPS.map((s) => s.name));
			expect(postBody.signal.status).toBe("running");

			// ── 2. Summary view — the path the dashboard's gate-status poll
			//      uses to decide whether to render in-progress chips. The
			//      core invariant: latestSignal.verification.steps is NEVER
			//      empty after the POST returns. Pre-fix this was empty for
			//      ~15-30s on multi-step gates; the fix makes it agree with
			//      the POST response from the first persisted write onwards.
			const sumResp = await apiFetch(`/api/goals/${goalId}/gates/slow-multi?view=summary`);
			expect(sumResp.status).toBe(200);
			const sumBody = await sumResp.json();
			expect(
				sumBody.latestSignal,
				"GATE_SIGNAL_PROGRESS_RACE: summary view must include latestSignal after POST",
			).toBeTruthy();
			expect(
				sumBody.latestSignal.id,
				"GATE_SIGNAL_PROGRESS_RACE: summary latestSignal.id must match POST response",
			).toBe(postSignalId);
			expect(
				sumBody.latestSignal.verification,
				"GATE_SIGNAL_PROGRESS_RACE: summary must include verification block",
			).toBeTruthy();
			expect(
				sumBody.latestSignal.verification.steps.length,
				`GATE_SIGNAL_PROGRESS_RACE: persisted steps[] length must equal POST steps[] length (${EXPECTED_STEPS.length}). ` +
				`Pre-fix this was 0 because the harness wrote steps several awaits after recordSignal.`,
			).toBe(EXPECTED_STEPS.length);
			expect(
				sumBody.latestSignal.verification.steps.map((s: { name: string }) => s.name),
				"GATE_SIGNAL_PROGRESS_RACE: persisted step names must match the POST response",
			).toEqual(postSteps.map((s) => s.name));

			// Persisted verification status must still be running because of
			// the 3-second phase-0 step. If this assertion fires it means the
			// signal raced through to completion before we could observe the
			// initial seeded state — bump SLOW_CMD's timeout.
			expect(
				sumBody.latestSignal.verification.status,
				"GATE_SIGNAL_PROGRESS_RACE: verification.status should still be 'running' " +
				"while the slow phase-0 step is in flight. If this fires the test's " +
				"SLOW_CMD is no longer slow enough relative to the harness.",
			).toBe("running");

			// ── 3. Inspect endpoint — same SSOT, scoped to verification.
			const insResp = await apiFetch(
				`/api/goals/${goalId}/gates/slow-multi/inspect?section=verification`,
			);
			expect(insResp.status).toBe(200);
			const insBody = await insResp.json();
			expect(
				insBody.steps.length,
				"GATE_SIGNAL_PROGRESS_RACE: inspect section=verification must return all enumerated steps",
			).toBe(EXPECTED_STEPS.length);
			for (let i = 0; i < EXPECTED_STEPS.length; i++) {
				const step = insBody.steps[i];
				expect(
					step.name,
					`GATE_SIGNAL_PROGRESS_RACE: inspect step[${i}].name`,
				).toBe(EXPECTED_STEPS[i].name);
				expect(
					step.type,
					`GATE_SIGNAL_PROGRESS_RACE: inspect step[${i}].type`,
				).toBe("command");
			}

			// ── 4. Active verifications endpoint — the dashboard's live
			//      reader. This is the OTHER store that the race fix had to
			//      reconcile with the gate-store. They must agree on names,
			//      order, and (because the gate is still running) phase /
			//      status: phase-0 → running, higher phases → waiting.
			const actResp = await apiFetch(`/api/goals/${goalId}/verifications/active`);
			expect(actResp.status).toBe(200);
			const { verifications } = await actResp.json();
			const matching = verifications.find((v: { signalId: string }) => v.signalId === postSignalId);
			expect(
				matching,
				"GATE_SIGNAL_PROGRESS_RACE: activeVerifications must contain an entry " +
				"for the signal we just posted — pre-fix this map was empty until " +
				"verifyGateSignal's async block ran several awaits later.",
			).toBeTruthy();
			expect(
				matching.steps.length,
				"GATE_SIGNAL_PROGRESS_RACE: active entry must have all enumerated steps",
			).toBe(EXPECTED_STEPS.length);
			expect(
				matching.steps.map((s: { name: string }) => s.name),
				"GATE_SIGNAL_PROGRESS_RACE: activeVerifications.steps[].name must match POST response order",
			).toEqual(postSteps.map((s) => s.name));
			expect(
				matching.overallStatus,
				"GATE_SIGNAL_PROGRESS_RACE: active.overallStatus must still be 'running'",
			).toBe("running");

			// AC #1 / phase-gating: phase-0 step is running, higher-phase
			// steps are waiting. This proves both stores agree on the
			// running/waiting partition derived from gate.verify[].phase.
			expect(
				matching.steps[0].status,
				"GATE_SIGNAL_PROGRESS_RACE: phase-0 'Slow build' step must be 'running'",
			).toBe("running");
			expect(
				matching.steps[1].status,
				"GATE_SIGNAL_PROGRESS_RACE: phase-1 'Type check' step must be 'waiting'",
			).toBe("waiting");
			expect(
				matching.steps[2].status,
				"GATE_SIGNAL_PROGRESS_RACE: phase-1 'Unit tests' step must be 'waiting'",
			).toBe("waiting");
			expect(
				matching.steps[3].status,
				"GATE_SIGNAL_PROGRESS_RACE: phase-2 'E2E tests' step must be 'waiting'",
			).toBe("waiting");

			// Counts derived from the above — at least one running, at least
			// one waiting. Belt-and-braces in case future workflow shuffles
			// move steps around.
			const runningCount = matching.steps.filter((s: { status: string }) => s.status === "running").length;
			const waitingCount = matching.steps.filter((s: { status: string }) => s.status === "waiting").length;
			expect(runningCount).toBeGreaterThanOrEqual(1);
			expect(waitingCount).toBeGreaterThanOrEqual(1);
		} finally {
			await deleteGoal(goalId);
			await deleteTestWorkflow(workflowId);
		}
	});
});
