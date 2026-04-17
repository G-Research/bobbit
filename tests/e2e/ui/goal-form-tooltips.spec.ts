/**
 * Goal form tooltip E2E tests — verify ⓘ tooltip icons on optional step toggles.
 *
 * Tests that the `description` field from workflow YAML is rendered as a tooltip
 * next to optional step toggles (e.g. "Enable QA Testing") in the goal creation form.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage } from "./ui-helpers.js";

/** Helper: open goal assistant, send GOAL_PROPOSAL, switch to feature workflow. */
async function openGoalFormWithFeatureWorkflow(page: import("@playwright/test").Page) {
	await openApp(page);

	// Open the goal assistant
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await newGoalBtn.click();

	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 15_000 });

	// Send GOAL_PROPOSAL — mock agent responds with a proposal (workflow=general)
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

	// Wait for the proposal panel to render
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 10_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

	// Switch workflow to "feature" which has optional QA step with description
	const workflowSelect = page.locator(".goal-preview-panel select").first();
	await expect(workflowSelect).toBeVisible({ timeout: 5_000 });
	await workflowSelect.selectOption("feature");

	// Wait for the workflow switch to settle: the select must show 'feature'
	// AND the toggle must be attached with the real tooltip icon (which
	// appears only for optional steps that carry a description — present
	// only in the 'feature' workflow).
	await expect(workflowSelect).toHaveValue("feature", { timeout: 5_000 });
	await expect(page.getByText("Enable QA Testing").first()).toBeVisible({ timeout: 5_000 });
	await expect(
		page.locator(".goal-preview-panel span.cursor-help").first(),
	).toBeVisible({ timeout: 5_000 });
}

test.describe("Step description tooltips", () => {
	test("optional step shows ⓘ tooltip when description is set", async ({ page }) => {
		await openGoalFormWithFeatureWorkflow(page);

		// Find the ⓘ icon next to the QA Testing optional step (not the auto-start toggle tooltip)
		const qaLabel = page.getByText("Enable QA Testing").first();
		const tooltipIcon = qaLabel.locator("..").locator("span.cursor-help");
		await expect(tooltipIcon).toBeVisible({ timeout: 5_000 });

		// Verify the icon text is ⓘ
		await expect(tooltipIcon).toHaveText("ⓘ");

		// Verify the title attribute contains expected description text from the feature workflow YAML
		await expect(tooltipIcon).toHaveAttribute("title", /ephemeral server/i);
	});

	test("tooltip title matches the full workflow YAML description", async ({ page }) => {
		await openGoalFormWithFeatureWorkflow(page);

		const qaLabel = page.getByText("Enable QA Testing").first();
		const tooltipIcon = qaLabel.locator("..").locator("span.cursor-help");
		await expect(tooltipIcon).toBeVisible({ timeout: 5_000 });

		// Check for multiple substrings from the expected description using
		// auto-retrying assertions — the tooltip renders before the full
		// description is wired up so a one-shot getAttribute can race.
		await expect(tooltipIcon).toHaveAttribute("title", /QA agent/, { timeout: 5_000 });
		await expect(tooltipIcon).toHaveAttribute("title", /ephemeral server/);
		await expect(tooltipIcon).toHaveAttribute("title", /browser/);
		await expect(tooltipIcon).toHaveAttribute("title", /end-to-end/);
	});

	test("tooltip icon has correct CSS classes", async ({ page }) => {
		await openGoalFormWithFeatureWorkflow(page);

		const qaLabel = page.getByText("Enable QA Testing").first();
		const tooltipIcon = qaLabel.locator("..").locator("span.cursor-help");
		await expect(tooltipIcon).toBeVisible({ timeout: 5_000 });

		// Verify it follows the sandbox tooltip pattern: text-[9px], text-muted-foreground, cursor-help
		await expect(tooltipIcon).toHaveClass(/text-\[9px\]/);
		await expect(tooltipIcon).toHaveClass(/text-muted-foreground/);
		await expect(tooltipIcon).toHaveClass(/cursor-help/);
	});

	test("general workflow has no tooltip icons (no optional steps)", async ({ page }) => {
		await openApp(page);

		// Open goal assistant
		const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
		await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
		await newGoalBtn.click();

		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });

		// Send GOAL_PROPOSAL — mock agent uses "general" workflow by default
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 10_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// General workflow has no optional steps — no ⓘ icons should be present
		const tooltipIcons = page.locator(".goal-preview-panel span.cursor-help");
		// There might be a sandbox tooltip, but no step-description tooltips.
		// The "Optional Steps" label itself should not appear for general workflow.
		await expect(page.getByText("Optional Steps")).not.toBeVisible();
	});
});
