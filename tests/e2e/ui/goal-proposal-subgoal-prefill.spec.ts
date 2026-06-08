/**
 * Browser E2E: an agent can pre-fill everything a human sets on the goal
 * proposal's Sub-goals tab.
 *
 * The propose_goal tool now accepts subgoalsAllowed, maxNestingDepth,
 * divergencePolicy and maxConcurrentChildren (proposal-types.ts frontmatter +
 * extension.ts schema). syncProposalFormState() seeds the form controls from
 * those fields, so the panel opens with the agent's choices already selected
 * instead of leaving the toggle off / defaults at accept time.
 *
 * The mock agent emits these fields when the prompt contains
 * "GOAL_PROPOSAL_SUBGOAL_PREFILL":
 *   subgoalsAllowed: true, maxNestingDepth: 2,
 *   divergencePolicy: "autonomous", maxConcurrentChildren: 4
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, sendMessage, createSessionViaUI } from "./ui-helpers.js";

async function setSubgoals(value: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: value }),
	});
	expect(resp.status).toBe(200);
}

test.describe("Goal proposal — agent-prefilled Sub-goals tab", () => {
	test.afterEach(async () => { await setSubgoals(true); });

	test("the Sub-goals tab reflects the agent's subgoalsAllowed/depth/policy/concurrency @smoke", async ({ page }) => {
		await setSubgoals(true);
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Please GOAL_PROPOSAL_SUBGOAL_PREFILL now");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("Prefilled Goal", { timeout: 15_000 });

		// Open the Sub-goals tab.
		const subgoalsTab = page.locator("[data-testid='goal-proposal-tab-subgoals']");
		await expect(subgoalsTab).toBeVisible({ timeout: 10_000 });
		await subgoalsTab.click();

		// Allow-subgoals is pre-checked (agent set subgoalsAllowed: true).
		const toggle = page.locator("[data-testid='goal-form-subgoals-toggle']");
		await expect(toggle).toBeVisible({ timeout: 10_000 });
		await expect(toggle).toBeChecked();

		// Max-depth reflects the agent's value (2).
		await expect(page.locator("[data-testid='goal-form-max-depth']"))
			.toHaveValue("2", { timeout: 10_000 });

		// Concurrency reflects the agent's value (4).
		await expect(page.locator("[data-testid='goal-form-max-concurrent-children']"))
			.toHaveValue("4", { timeout: 10_000 });

		// Divergence policy 'autonomous' is the pressed segment.
		await expect(page.locator("[data-testid='goal-form-divergence-autonomous']"))
			.toHaveAttribute("aria-pressed", "true", { timeout: 10_000 });
		await expect(page.locator("[data-testid='goal-form-divergence-balanced']"))
			.toHaveAttribute("aria-pressed", "false", { timeout: 5_000 });
	});
});
