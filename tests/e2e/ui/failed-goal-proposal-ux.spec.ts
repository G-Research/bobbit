/**
 * Reproducer — a failed propose_goal seed (MISSING_WORKFLOW) must not look like
 * a normal successful proposal. The failed draft stays inspectable, but the
 * proposal panel must show the workflow error, keep Create disabled, and avoid
 * silently selecting the first workflow. A later corrected propose_goal in the
 * same conversation must render as a normal rev-backed proposal.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

const WORKFLOW_ERROR_RE = /Workflow is required for this project/i;

test.describe("Failed goal proposal workflow validation", () => {
	test("missing-workflow failure remains inspectable, then a corrected retry succeeds", async ({ page }) => {
		test.setTimeout(120_000);
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Please run GOAL_PROPOSAL_MISSING_WORKFLOW now");

		const openButtons = page.locator('[data-testid="proposal-open-button"]');
		await expect(openButtons).toHaveCount(1, { timeout: 20_000 });
		await expect(page.getByText("Missing Workflow Goal").first()).toBeVisible({ timeout: 10_000 });
		await openButtons.first().click();

		const titleInput = page.locator('input[placeholder="Goal title"]').first();
		await expect(titleInput).toBeVisible({ timeout: 10_000 });
		await expect(titleInput).toHaveValue("Missing Workflow Goal", { timeout: 10_000 });

		const workflowError = page.locator('[data-testid="goal-proposal-workflow-error"]');
		await expect(workflowError, "workflow validation error must be surfaced in the proposal footer/status area")
			.toContainText(WORKFLOW_ERROR_RE, { timeout: 10_000 });
		await expect(workflowError).toContainText(/general/i);
		await expect(workflowError).toContainText(/feature/i);

		const createGoal = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await expect(createGoal, "Create Goal must stay disabled until workflow is corrected").toBeDisabled();

		await page.locator('[data-testid="goal-proposal-tab-workflow"]').click();
		const workflowSelect = page.locator('[data-testid="goal-proposal-workflow-select"]');
		await expect(workflowSelect, "failed missing-workflow draft should render an explicit empty workflow selection")
			.toBeVisible({ timeout: 10_000 });
		await expect(workflowSelect, "workflow selector must not silently default to the first available workflow")
			.toHaveValue("");

		await sendMessage(page, "Please run GOAL_PROPOSAL_FIXED_WORKFLOW now");

		await expect(openButtons).toHaveCount(2, { timeout: 20_000 });
		await expect(page.getByText("Fixed Workflow Goal").first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-testid="proposal-rev"]').last()).toHaveText(/rev \d+/, { timeout: 15_000 });

		await openButtons.last().click();
		await page.locator('[data-testid="goal-proposal-tab-goal"]').click();
		await expect(titleInput).toHaveValue("Fixed Workflow Goal", { timeout: 10_000 });
		await expect(page.locator('[data-testid="proposal-panel-rev"]').first()).toHaveText(/rev \d+/, { timeout: 10_000 });
		await expect(createGoal, "corrected proposal should use the normal enabled create flow").toBeEnabled({ timeout: 10_000 });
	});
});
