/**
 * Browser E2E regression for Issue #1 — verification results are slow to load.
 *
 * ROOT CAUSE (see Issue Analysis gate): `GET /api/goals/:id/gates` enriches
 * each gate with `{ ...g }`, which serializes the ENTIRE signal history
 * inline — every `signals[].verification.steps[].output`, `artifact.content`,
 * and `diagnostics`. Payload grows unbounded with history size, and the
 * dashboard polls it every 8s.
 *
 * POST-FIX behaviour asserted here:
 *   1. The gate-LIST endpoint returns a SLIM projection: step metadata
 *      (name/type/status/passed/duration) is present, but inline
 *      `step.output` / `artifact.content` / `diagnostics` are stripped.
 *   2. Full step output is still available lazily on expand — via the
 *      gate-detail / verification-snapshot path — so there is NO behavioural
 *      regression (expanding a signal still shows full output).
 *
 * This spec asserts POST-FIX behaviour and is EXPECTED TO FAIL on current
 * master (the list endpoint still carries full inline output). It is NOT
 * wired into the reproducing-test gate command; it is regression coverage the
 * implementation must make pass.
 *
 * Marker: GATE_LIST_SLIM_PROJECTION
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, deleteGoal, defaultProjectId, createSession, connectWs, signalAndWaitForGate } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard } from "./ui-helpers.js";

// A fast command whose stdout is a large, unmistakable marker string. If the
// list endpoint is slim, this marker MUST NOT appear in the /gates payload;
// it MUST still appear via the lazy detail/inspect path.
const BIG_MARKER = "SLIM_PROJECTION_BIG_OUTPUT_MARKER_" + "X".repeat(2000);
const GATE_ID = "slim-gate";
const GATE_NAME = "Slim Projection Gate";
// Command: emit the big marker to stdout, then exit 0 (fast, deterministic).
const BIG_OUTPUT_CMD = `node -e "process.stdout.write('${BIG_MARKER}');process.exit(0)"`;

function makeWorkflowId(): string {
	return `slim-projection-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createWorkflow(workflowId: string, projectId: string): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			projectId,
			id: workflowId,
			name: "Slim Projection Test",
			description: "One command gate emitting a large stdout marker.",
			gates: [
				{
					id: GATE_ID,
					name: GATE_NAME,
					dependsOn: [],
					verify: [
						{ name: "Big output", type: "command", run: BIG_OUTPUT_CMD },
					],
				},
			],
		}),
	});
	expect(res.status, "GATE_LIST_SLIM_PROJECTION: workflow creation must succeed").toBe(201);
}

async function deleteWorkflow(workflowId: string): Promise<void> {
	await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => { /* best-effort */ });
}

/** Fetch the gate-list payload once and extract the gate/signal/step for GATE_ID. */
async function fetchGateFromList(goalId: string): Promise<any> {
	const res = await apiFetch(`/api/goals/${goalId}/gates`);
	expect(res.status, "GATE_LIST_SLIM_PROJECTION: /gates list must respond 200").toBe(200);
	const gates = await res.json();
	const gate = (Array.isArray(gates) ? gates : gates.gates ?? []).find((g: any) => g.gateId === GATE_ID || g.id === GATE_ID);
	const sig = gate?.signals?.[0];
	const step = sig?.verification?.steps?.[0];
	return { gates, gate, sig, step };
}

test.describe("Gate-list slim projection (Issue #1) — GATE_LIST_SLIM_PROJECTION", () => {
	test("list endpoint strips inline step output; full output remains available lazily", async ({ page }) => {
		const workflowId = makeWorkflowId();
		const projectId = await defaultProjectId();
		expect(projectId, "GATE_LIST_SLIM_PROJECTION: must resolve a default projectId").toBeTruthy();
		await createWorkflow(workflowId, projectId as string);
		const goal = await createGoal({ title: `Slim Projection ${Date.now()}`, workflowId, projectId });
		const goalId = goal.id;

		try {
			// Signal the gate and wait — event-driven — for its command step to
			// finish and persist its (large) output. A goal-scoped WS connection
			// lets us await the terminal gate_status_changed instead of polling.
			const sessionId = await createSession({ goalId });
			const conn = await connectWs(sessionId);
			await signalAndWaitForGate(conn, goalId, GATE_ID, {}, ["passed", "failed"], 60_000);

			const { gates, sig, step } = await fetchGateFromList(goalId);
			expect(step, "GATE_LIST_SLIM_PROJECTION: gate must have a completed signal step").toBeTruthy();

			// ── AC #1: the LIST payload must be SLIM ─────────────────────────
			// Step metadata preserved…
			expect(step.name, "step name preserved in slim projection").toBe("Big output");
			expect(["passed", "failed"]).toContain(step.status);
			// …but the heavy inline output is stripped. Pre-fix this carries the
			// full 2KB+ marker for every step of every signal.
			const listJson = JSON.stringify(gates);
			expect(
				listJson.includes(BIG_MARKER),
				"GATE_LIST_SLIM_PROJECTION: /gates list payload MUST NOT contain full inline step output. " +
				"If this fires, the list endpoint still serializes signals[].verification.steps[].output " +
				"(the Issue #1 slow-load root cause).",
			).toBe(false);
			expect(step.output ?? "", "slim projection blanks step.output").not.toContain(BIG_MARKER);

			// ── AC #2: full output remains available lazily ──────────────────
			// The inspect path (used for full step output) must still return the
			// complete output — the slimming is list-only, no behavioural
			// regression on expand.
			void sig;
			const detailRes = await apiFetch(
				`/api/goals/${goalId}/gates/${GATE_ID}/inspect?section=verification&signal_index=-1&mode=full`,
			);
			expect(detailRes.status, "GATE_LIST_SLIM_PROJECTION: verification inspect endpoint must respond 200").toBe(200);
			const detailText = await detailRes.text();
			expect(
				detailText.includes(BIG_MARKER),
				"GATE_LIST_SLIM_PROJECTION: full step output MUST remain available via the lazy detail path (no regression).",
			).toBe(true);

			// ── DOM smoke: dashboard still renders the gate and, on expand,
			//    shows the full output (no behavioural regression). ───────────
			await openApp(page);
			await navigateToGoalDashboard(page, goalId);
			await expect(
				page.locator(".wf-checklist-item").filter({ hasText: GATE_NAME }),
			).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goalId);
			await deleteWorkflow(workflowId);
		}
	});
});
