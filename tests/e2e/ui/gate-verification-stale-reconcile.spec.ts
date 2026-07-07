/**
 * Browser E2E regression for Issue #2 — terminated/stale verification still
 * shows "running".
 *
 * ROOT CAUSE (see Issue Analysis gate): the live renderer
 * (`GateVerificationLive.ts`) is a WS-event state machine whose ONLY exit from
 * `running` is a `gate_verification_complete` event. If that event never
 * arrives (harness died / server restart / dropped WS), the spinner spins
 * forever. The sole reconciliation (`_fetchAndReconcile`) is a one-shot 300ms
 * post-mount timer and its running branch never transitions to a stale state.
 *
 * POST-FIX behaviour asserted here:
 *   - The live renderer reconciles against the authoritative REST snapshot on
 *     a repeating interval AND on WS-reconnect / tab-visibility regain.
 *   - When the server's snapshot reports the active verification is no longer
 *     alive (derived not-running / dead active entry), the renderer LEAVES the
 *     spinner and shows a stale/terminated state with a re-signal affordance —
 *     rather than a perpetual spinner.
 *
 * This spec asserts POST-FIX behaviour and is EXPECTED TO FAIL until the fix
 * lands. It is NOT wired into the reproducing-test gate command.
 *
 * ────────────────────────────────────────────────────────────────────────
 * TODO / FLAG TO TEAM LEAD — un-simulatable without a server hook.
 *
 * The core stale scenario ("start a verification, then make it silently die
 * WITHOUT emitting gate_verification_complete") cannot be produced from a
 * black-box browser E2E: it requires either killing the harness process or a
 * server-side test hook that removes/kills the active-verification entry (so
 * the REST snapshot derives not-running / dead) WITHOUT broadcasting a
 * completion event. Neither exists today.
 *
 * The `should show stale state ...` test below is therefore marked
 * `test.fixme` — it documents the exact intended assertions against the
 * reconcile path and should be un-fixme'd once the implementation adds one of:
 *   (a) a test-only endpoint to mark an active verification dead
 *       (e.g. POST /api/internal/verifications/:id/simulate-death), or
 *   (b) reuse of the restart path so `areVerificationSessionsAlive()` reports
 *       the entry dead and `buildGateVerificationSnapshot` returns stale:true.
 * The reconcile-path DOM contract (below) is what the fix must satisfy.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Marker: GATE_VERIFICATION_STALE_RECONCILE
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, deleteGoal, defaultProjectId } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard } from "./ui-helpers.js";

// Long-running command so the verification stays observably in-flight while we
// exercise reconcile. (~60s; the test asserts reconcile behaviour long before.)
const SLOW_CMD = `node -e "setTimeout(()=>process.exit(0),60000)"`;
const GATE_ID = "stale-gate";
const GATE_NAME = "Stale Reconcile Gate";

function makeWorkflowId(): string {
	return `stale-reconcile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createWorkflow(workflowId: string, projectId: string): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id: workflowId,
			name: "Stale Reconcile Test",
			description: "One slow command gate for stale-verification reconcile coverage.",
			gates: [
				{
					id: GATE_ID,
					name: GATE_NAME,
					dependsOn: [],
					verify: [{ name: "Slow step", type: "command", run: SLOW_CMD }],
				},
			],
		}),
	});
	expect(res.status, "GATE_VERIFICATION_STALE_RECONCILE: workflow creation must succeed").toBe(201);
}

async function deleteWorkflow(workflowId: string): Promise<void> {
	await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => { /* best-effort */ });
}

test.describe("Gate verification stale reconcile (Issue #2) — GATE_VERIFICATION_STALE_RECONCILE", () => {
	// Baseline that CAN run today: a live verification renders the running
	// spinner (per-step chips). Guards the alive path the fix must not break.
	test("live verification renders the running spinner (alive-path baseline)", async ({ page }) => {
		const workflowId = makeWorkflowId();
		const projectId = await defaultProjectId();
		expect(projectId, "must resolve a default projectId").toBeTruthy();
		await createWorkflow(workflowId, projectId as string);
		const goal = await createGoal({ title: `Stale Reconcile ${Date.now()}`, workflowId, projectId });
		const goalId = goal.id;

		try {
			await openApp(page);
			await navigateToGoalDashboard(page, goalId);
			await expect(
				page.locator(".wf-checklist-item").filter({ hasText: GATE_NAME }),
			).toBeVisible({ timeout: 15_000 });

			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(signalResp.status, "signal POST must succeed").toBe(201);

			// A running verification is visible (the alive path). The fix must
			// preserve this behaviour.
			await expect(page.locator(".verify-card").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goalId);
			await deleteWorkflow(workflowId);
		}
	});

	// See TODO/FLAG at the top of this file: needs a server hook to make the
	// active verification silently die (no gate_verification_complete). Once
	// available, un-fixme and drive the scenario via that hook.
	test.fixme(
		"should show stale/terminated state (not a perpetual spinner) with a re-signal affordance once the active verification is dead",
		async ({ page }) => {
			const workflowId = makeWorkflowId();
			const projectId = await defaultProjectId();
			await createWorkflow(workflowId, projectId as string);
			const goal = await createGoal({ title: `Stale Reconcile Dead ${Date.now()}`, workflowId, projectId });
			const goalId = goal.id;

			try {
				await openApp(page);
				await navigateToGoalDashboard(page, goalId);
				await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, {
					method: "POST",
					body: JSON.stringify({}),
				});
				await expect(page.locator(".verify-card").first()).toBeVisible({ timeout: 20_000 });

				// TODO(impl): make the active verification die WITHOUT a
				// completion event, e.g.:
				//   await apiFetch(`/api/internal/verifications/${goalId}/${GATE_ID}/simulate-death`, { method: "POST" });
				// The server snapshot must then derive not-running / stale.

				// After reconcile (repeating interval / visibility regain), the
				// renderer must leave the spinner and render a stale/terminated
				// affordance. Exact selector TBD by the implementation; assert on
				// a stable marker class + a re-signal control.
				await expect(
					page.locator('[data-verify-state="stale"], .verify-card--stale'),
					"GATE_VERIFICATION_STALE_RECONCILE: dead verification must render a stale/terminated state, not a spinner.",
				).toBeVisible({ timeout: 30_000 });
				await expect(
					page.getByRole("button", { name: /re-?signal/i }),
					"GATE_VERIFICATION_STALE_RECONCILE: a stale verification must expose a re-signal affordance.",
				).toBeVisible({ timeout: 30_000 });
			} finally {
				await deleteGoal(goalId);
				await deleteWorkflow(workflowId);
			}
		},
	);
});
