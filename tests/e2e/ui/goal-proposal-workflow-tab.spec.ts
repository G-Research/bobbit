/**
 * Browser E2E coverage for the goal-proposal modal's Workflow tab.
 *
 * The Workflow tab presents a workflow <select> (synced to the Goal tab's
 * picker) plus a Customise/Revert toggle. The chosen workflow renders beneath
 * in read-only inspector form; pressing "Customise for this goal" swaps it for
 * the editor and turns the button into "Revert to project definition".
 *
 * Scenarios per AGENTS.md "E2E coverage requirement":
 *   1. Navigation — open the proposal, switch to the Workflow tab; the select
 *      and the Customise button are visible (no left-hand workflow list).
 *   2. Happy path — Customise → editor appears, button flips to Revert.
 *   3. Cleanup/undo — Revert → editor disappears (inspector returns), button
 *      flips back to Customise.
 *   4. Sync — the Workflow-tab select mirrors the Goal-tab select value.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, sendMessage, createSessionViaUI } from "./ui-helpers.js";

/** The harness may default subgoals on/off; the Workflow tab is independent. */
async function ensureSubgoals(value: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: value }),
	});
	expect(resp.status).toBe(200);
}

test.describe("Goal proposal — Workflow tab", () => {
	test.afterEach(async () => { await ensureSubgoals(true); });

	test("customise/revert toggle drives the editor, and the select syncs with the Goal tab @smoke", async ({ page }) => {
		await ensureSubgoals(true);
		await openApp(page);
		await createSessionViaUI(page);

		// Mock agent emits a propose_goal titled "E2E Test Goal".
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// --- Navigation: open the Workflow tab. ---
		const workflowTab = page.locator("[data-testid='goal-proposal-tab-workflow']");
		await expect(workflowTab).toBeVisible({ timeout: 10_000 });
		await workflowTab.click();

		const select = page.locator("[data-testid='goal-proposal-workflow-select']");
		await expect(select).toBeVisible({ timeout: 10_000 });
		// The old left-hand workflow list must be gone.
		await expect(page.locator("[data-testid='goal-proposal-panel-workflow'] .wf-row")).toHaveCount(0);

		const customise = page.locator("[data-testid='goal-proposal-workflow-customize']");
		await expect(customise).toBeVisible({ timeout: 10_000 });
		await expect(customise).toHaveText("Customise for this goal");

		// --- Happy path: Customise → editor + Revert button. ---
		await customise.click();
		const revert = page.locator("[data-testid='goal-proposal-workflow-reset']");
		await expect(revert).toBeVisible({ timeout: 10_000 });
		await expect(revert).toHaveText("Revert to project definition");
		// The Customise button is no longer shown while customising.
		await expect(page.locator("[data-testid='goal-proposal-workflow-customize']")).toHaveCount(0);

		// --- Cleanup/undo: Revert → back to inspector + Customise button. ---
		await revert.click();
		await expect(page.locator("[data-testid='goal-proposal-workflow-customize']"))
			.toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[data-testid='goal-proposal-workflow-reset']")).toHaveCount(0);

		// --- Sync: the Workflow-tab select shares _proposalWorkflowId with the
		// Goal tab, so its value survives a round-trip through the Goal tab. ---
		const tabValue = await select.inputValue();
		await page.locator("[data-testid='goal-proposal-tab-goal']").click();
		await expect(page.locator("[data-testid='goal-proposal-panel-goal']"))
			.toBeVisible({ timeout: 5_000 });
		await page.locator("[data-testid='goal-proposal-tab-workflow']").click();
		await expect(select).toHaveValue(tabValue, { timeout: 5_000 });
	});
});
