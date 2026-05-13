/**
 * Pause-cascade — acceptance criterion 4 ("llm-review-* cancelled with
 * the rest").
 *
 * The same code path that cancels llm-review verifier sessions also
 * cancels every other in-flight verification step (command, agent-qa).
 * Under the in-process E2E harness real `llm-review` runs are skipped
 * by `BOBBIT_LLM_REVIEW_SKIP=1`, so we exercise the cancel-on-pause
 * contract through a long-running `command` step instead — which goes
 * through the SAME `cancelAllVerifications` path the pause handler
 * invokes.
 *
 * Acceptance:
 *  - While a verification is running, `POST /pause {cascade:false}`
 *    must transition that verification out of `running` within 5s.
 *  - No replacement verification step appears.
 *
 * See `docs/design/pause-cascade.md` §Call-site 1 + §Call-site 8.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, assertStaysFalse, createGoal, deleteGoal } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

test.setTimeout(60_000);

const SLOW_WORKFLOW_ID = `pause-verif-slow-${Date.now()}`;

async function createSlowWorkflow(): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: SLOW_WORKFLOW_ID,
			name: "Pause-cancels-verifier slow workflow",
			description: "Slow command for pause-cancel test",
			gates: [
				{
					id: "slow-gate",
					name: "Slow Gate",
					dependsOn: [],
					verify: [
						{
							name: "Slow check",
							type: "command",
							run: 'node -e "setTimeout(()=>{process.exit(0)},15000)"',
						},
					],
				},
			],
		}),
	});
	expect(res.status).toBe(201);
}

async function deleteSlowWorkflow(): Promise<void> {
	await apiFetch(`/api/workflows/${SLOW_WORKFLOW_ID}`, { method: "DELETE" }).catch(() => {});
}

async function getActiveVerifications(goalId: string): Promise<any[]> {
	const res = await apiFetch(`/api/goals/${goalId}/verifications/active`);
	if (!res.ok) return [];
	const data = await res.json();
	return data.verifications || [];
}

test.describe("pause cascade — cancels in-flight verifications", () => {
	test.beforeAll(async () => {
		await createSlowWorkflow();
	});
	test.afterAll(async () => {
		await deleteSlowWorkflow();
	});

	test("pause transitions running verification out of running within 5s; no replacement", async () => {
		const goal = await createGoal({
			title: `pause-verif-${Date.now()}`,
			workflowId: SLOW_WORKFLOW_ID,
			worktree: false,
		});
		const goalId = goal.id;
		try {
			// Kick off the slow verification.
			const signalRes = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "kick" }),
			});
			expect(signalRes.status).toBe(201);

			// Wait for it to be in "running" state.
			await pollUntil(async () => {
				const v = await getActiveVerifications(goalId);
				return v.some(a => a.gateId === "slow-gate" && a.overallStatus === "running");
			}, { timeoutMs: 10_000, intervalMs: 100, label: "verification running" });

			// Pause the goal.
			const pauseRes = await apiFetch(`/api/goals/${goalId}/pause`, {
				method: "POST",
				body: JSON.stringify({ cascade: false }),
			});
			expect(pauseRes.status).toBe(200);

			// Within 5s the verification must NOT be running anymore.
			await pollUntil(async () => {
				const v = await getActiveVerifications(goalId);
				return !v.some(a => a.gateId === "slow-gate" && a.overallStatus === "running");
			}, { timeoutMs: 5_000, intervalMs: 100, label: "verification cancelled by pause" });

			// And no replacement appears in the next 5s — pause guard blocks
			// a re-signal from spawning another verification. Polling-based
			// negative assertion via assertStaysFalse; the underlying state
			// is queried each tick so we fail fast on a regression.
			let sawRunning = false;
			let lastCheck = 0;
			let cached: any[] = [];
			await assertStaysFalse(() => {
				// Refresh at most every 250ms to bound REST load.
				const now = Date.now();
				if (now - lastCheck >= 250) {
					lastCheck = now;
					getActiveVerifications(goalId).then(v => { cached = v; }).catch(() => {});
				}
				sawRunning = cached.some(a => a.gateId === "slow-gate" && a.overallStatus === "running");
				return sawRunning;
			}, { durationMs: 5_000, intervalMs: 100, message: "replacement verification appeared after pause" });

			// And re-signalling while paused must 409 GOAL_PAUSED.
			const reSignal = await apiFetch(`/api/goals/${goalId}/gates/slow-gate/signal`, {
				method: "POST",
				body: JSON.stringify({ content: "should-be-blocked" }),
			});
			expect(reSignal.status).toBe(409);
			const body = await reSignal.json();
			expect(body.code).toBe("GOAL_PAUSED");
			expect(body.goalId).toBe(goalId);
		} finally {
			await deleteGoal(goalId).catch(() => {});
		}
	});
});
