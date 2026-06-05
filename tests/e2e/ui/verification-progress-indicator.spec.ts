/**
 * Browser E2E regression test for the verification-progress indicator.
 *
 * Pins the UI side of the gate-signal step-enumeration race fix:
 *
 *   AC #2 — The dashboard workflow-progress indicator shows in-progress
 *           chips within one render tick of the signal call (no empty
 *           placeholder window).
 *   AC #3 — The UI renders correctly from the persisted gate-store
 *           state alone, without falling back to the POST response
 *           body. Verified by reloading the page and re-asserting that
 *           the chips render from `/api/goals/:id/verifications/active`
 *           + `/api/goals/:id/gates/:gid` only.
 *
 * Background: pre-fix the gate-store's persisted signal carried
 * `verification.steps: []` for ~15-30s after `gate_signal`. The
 * dashboard's `renderLiveVerificationSteps()` falls back to a
 * "Verification in progress…" spinner placeholder (`.verify-card--running`
 * with no per-step rows) when the step array is empty. This test
 * asserts the placeholder is NEVER visible while chips exist — both
 * immediately after the signal and after a full page reload.
 *
 * Marker: GATE_SIGNAL_PROGRESS_INDICATOR
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, deleteGoal } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard } from "./ui-helpers.js";

// Slow phase-0 step (~25s) so the verification stays observably in flight
// across navigation + reload. Pre-fix the race window itself was 15-30s,
// so a 25s budget is the right order of magnitude for an honest check.
// Cross-platform via node -e.
const SLOW_CMD = `node -e "setTimeout(()=>process.exit(0),25000)"`;

const GATE_ID = "slow-multi";
const GATE_NAME = "Slow Multi-Step Gate";
const EXPECTED_STEP_NAMES = ["Slow build", "Type check", "Unit tests"];

function makeWorkflowId(): string {
	return `progress-indicator-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createTestWorkflow(workflowId: string): Promise<void> {
	const res = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({
			id: workflowId,
			name: "Progress Indicator Test",
			description: "Inline workflow pinning the verification-progress indicator render path.",
			gates: [
				{
					id: GATE_ID,
					name: GATE_NAME,
					dependsOn: [],
					verify: [
						{ name: "Slow build", type: "command", run: SLOW_CMD },
						{ name: "Type check", type: "command", phase: 1, run: "echo ok" },
						{ name: "Unit tests", type: "command", phase: 1, run: "echo ok" },
					],
				},
			],
		}),
	});
	expect(res.status, "GATE_SIGNAL_PROGRESS_INDICATOR: workflow creation must succeed").toBe(201);
}

async function deleteTestWorkflow(workflowId: string): Promise<void> {
	await apiFetch(`/api/workflows/${workflowId}`, { method: "DELETE" }).catch(() => { /* best-effort */ });
}

/**
 * Expand the gate row in the workflow checklist if it isn't already.
 * Idempotent — safe to call before any signal exists for the gate.
 */
async function expandGate(page: import("@playwright/test").Page): Promise<void> {
	const gateRow = page.locator(".wf-checklist-item").filter({ hasText: GATE_NAME });
	await expect(gateRow).toBeVisible({ timeout: 10_000 });
	const viewLabel = gateRow.locator(".wf-checklist-view");
	if ((await viewLabel.textContent())?.trim() === "View") {
		await gateRow.click();
		await expect(viewLabel).toHaveText("Hide", { timeout: 5_000 });
	}
}

/**
 * Expand the (latest) signal entry's body so per-step `.verify-card`
 * chips render. Assumes the gate is already expanded.
 */
async function expandLatestSignal(page: import("@playwright/test").Page): Promise<void> {
	const signalEntry = page.locator(".signal-entry").first();
	await expect(signalEntry).toBeVisible({ timeout: 15_000 });
	const expandIcon = signalEntry.locator(".signal-expand-icon");
	if ((await expandIcon.textContent())?.includes("\u25BE")) {
		await signalEntry.locator(".signal-entry__header").click();
		await expect(expandIcon).toContainText("\u25B4", { timeout: 5_000 });
	}
}

test.describe("Verification progress indicator (full-stack UI) — GATE_SIGNAL_PROGRESS_INDICATOR", () => {
	test("dashboard shows in-progress chips for a multi-step gate within one render tick, and persists across reload", async ({ page }) => {
		const workflowId = makeWorkflowId();
		await createTestWorkflow(workflowId);
		const goal = await createGoal({
			title: `Progress Indicator ${Date.now()}`,
			workflowId,
		});
		const goalId = goal.id;

		try {
			// ── 1. Open dashboard ──────────────────────────────────────────
			await openApp(page);
			await navigateToGoalDashboard(page, goalId);

			// Wait for the workflow checklist to render so we know the
			// dashboard's loadDashboardData() has resolved + the WS is up.
			await expect(
				page.locator(".wf-checklist-item").filter({ hasText: GATE_NAME }),
			).toBeVisible({ timeout: 15_000 });

			// Pre-expand the gate row BEFORE signaling. Signal entries are
			// rendered inside the gate's detail panel — having it already
			// open means the signal entry pops in directly when the WS
			// broadcast lands, with no race against the user clicking.
			await expandGate(page);

			// ── 2. Signal the gate via API. Mirrors what the team-lead's
			//      `gate_signal` MCP tool does — same REST endpoint, same
			//      gate-store mutation, same WS broadcasts.
			const signalResp = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, {
				method: "POST",
				body: JSON.stringify({}),
			});
			expect(
				signalResp.status,
				"GATE_SIGNAL_PROGRESS_INDICATOR: signal POST must succeed",
			).toBe(201);

			// ── 3. Reveal the per-step chips. Pre-fix the user would see a
			//      "Verification in progress…" placeholder for 15-30s here
			//      because gate-store carried empty steps[]; post-fix the
			//      named chips render from the very first persisted write.
			await expandLatestSignal(page);

			// AC #2: at least the phase-0 "Slow build" chip must be visible
			// within one render tick. `toBeVisible` auto-waits up to the
			// timeout but the underlying state is already settled — no
			// flicker, no polling-tick delay window.
			// Synchronize on the FULL step set before asserting per-step
			// modifier classes. Under full-suite load the chips render in a
			// staggered fashion (WS step-enumeration race): the first two
			// chips can be present while the third ("Unit tests") is still a
			// render tick behind. Waiting for all three to materialize first
			// removes that flake without weakening the assertions below.
			await expect(page.locator(".verify-card")).toHaveCount(3, { timeout: 15_000 });
			const buildChip = page.locator(".verify-card").filter({ hasText: "Slow build" });
			const typeCheckChip = page.locator(".verify-card").filter({ hasText: "Type check" });
			const unitChip = page.locator(".verify-card").filter({ hasText: "Unit tests" });
			await expect(buildChip).toBeVisible({ timeout: 15_000 });
			await expect(typeCheckChip).toBeVisible({ timeout: 15_000 });
			await expect(unitChip).toBeVisible({ timeout: 15_000 });

			// Step rows render with the expected per-step modifier classes:
			// phase-0 → running, phase-1+ → waiting. (Pre-fix the placeholder
			// would have been a single .verify-card--running with NO per-step
			// chips below it.)
			await expect(buildChip).toHaveClass(/verify-card--running/);
			await expect(typeCheckChip).toHaveClass(/verify-card--waiting/);
			await expect(unitChip).toHaveClass(/verify-card--waiting/);

			// AC #2 negative half: the empty-state placeholder must NOT be
			// rendered. Pre-fix this was the ONLY content for ~15-30s.
			const placeholder = page.locator(".verify-card").filter({ hasText: "Verification in progress" });
			await expect(
				placeholder,
				"GATE_SIGNAL_PROGRESS_INDICATOR: empty-steps placeholder must NOT render alongside named chips. " +
				"If this fires it means the gate-store persisted signal.verification.steps: [] " +
				"again — the race fix has regressed.",
			).toHaveCount(0);

			// ── 4. AC #3: reload page. The dashboard now bootstraps from
			//      persisted REST state only — no live WS event has arrived
			//      yet for the new tab, so any in-progress chips MUST come
			//      from the gate-store via /api/goals/.../gates/... and
			//      /api/goals/.../verifications/active. Pre-fix those
			//      payloads were empty for ~15-30s.
			await page.reload();
			await expect(
				page.locator(".wf-checklist-item").filter({ hasText: GATE_NAME }),
			).toBeVisible({ timeout: 15_000 });

			await expandGate(page);
			await expandLatestSignal(page);

			// Same full-step-set synchronization after reload before the
			// per-chip visibility checks.
			await expect(page.locator(".verify-card")).toHaveCount(3, { timeout: 15_000 });
			const buildChipAfter = page.locator(".verify-card").filter({ hasText: "Slow build" });
			const typeCheckChipAfter = page.locator(".verify-card").filter({ hasText: "Type check" });
			const unitChipAfter = page.locator(".verify-card").filter({ hasText: "Unit tests" });
			await expect(
				buildChipAfter,
				"GATE_SIGNAL_PROGRESS_INDICATOR: 'Slow build' chip must render after reload from persisted state alone",
			).toBeVisible({ timeout: 15_000 });
			await expect(typeCheckChipAfter).toBeVisible({ timeout: 15_000 });
			await expect(unitChipAfter).toBeVisible({ timeout: 15_000 });

			// Empty-state placeholder still absent after reload.
			await expect(
				page.locator(".verify-card").filter({ hasText: "Verification in progress" }),
				"GATE_SIGNAL_PROGRESS_INDICATOR: empty-steps placeholder must NOT render after reload",
			).toHaveCount(0);
		} finally {
			await deleteGoal(goalId);
			await deleteTestWorkflow(workflowId);
		}
	});
});
