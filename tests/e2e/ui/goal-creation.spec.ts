/**
 * Goal creation E2E tests: assistant flow with mock agent proposal, API creation,
 * optional steps toggle, and dismiss button behavior.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, nonGitCwd } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";

/** Helper: open goal assistant, send GOAL_PROPOSAL, wait for title input. */
async function openGoalAssistantProposal(page: import("@playwright/test").Page) {
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await newGoalBtn.click();
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 15_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 10_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

/** Helper: open regular session, send GOAL_PROPOSAL, wait for proposal panel. */
async function openRegularSessionProposal(page: import("@playwright/test").Page) {
	await openApp(page);
	await createSessionViaUI(page);
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	// In a regular session the proposal panel appears as a "Goal" tab in the preview pane.
	// Wait for the title input to be populated — it may take a moment for the
	// proposal to be parsed and the panel to render.
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 15_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

/** Helper: find the last created goal matching a title via API. */
async function findGoalByTitle(title: string) {
	const resp = await apiFetch("/api/goals");
	const data = await resp.json();
	const goals = data.goals || data;
	return (goals as any[]).find((g: any) => g.title === title);
}

/** Helper: delete a goal by ID (best-effort). */
async function deleteGoal(goalId: string) {
	await apiFetch(`/api/goals/${goalId}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Goal creation (full-stack UI)", () => {
	test("create goal via assistant flow", async ({ page }) => {
		await openGoalAssistantProposal(page);

		// Now the Create Goal button should be enabled
		const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await expect(createGoalBtn).toBeVisible({ timeout: 5_000 });

		// Click "Create Goal"
		await createGoalBtn.click();

		// After creating, the app navigates to the goal dashboard.
		await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 15_000 });

		// Verify the goal was created via API
		const createdGoal = await findGoalByTitle("E2E Test Goal");
		expect(createdGoal).toBeTruthy();

		// Clean up
		if (createdGoal) await deleteGoal(createdGoal.id);
	});

	test("goal appears after API creation @smoke", async ({ page }) => {
		const goal = await createGoal({ title: "API Created Goal" });

		try {
			await openApp(page);
			await expect(page.getByText("API Created Goal").first()).toBeVisible({ timeout: 10_000 });
		} finally {
			await deleteGoal(goal.id);
		}
	});

	test("optional steps toggle in assistant panel", async ({ page }) => {
		await openGoalAssistantProposal(page);

		// The mock agent uses workflow "general" which has no optional steps.
		// The "Optional Steps" label should NOT be visible yet.
		await expect(page.getByText("Optional Steps")).not.toBeVisible();

		// Change workflow dropdown to "feature" which has an optional QA step.
		const workflowSelect = page.locator(".goal-preview-panel select").first();
		await expect(workflowSelect).toBeVisible({ timeout: 5_000 });
		await workflowSelect.selectOption("feature");

		// Now "Enable QA Testing" checkbox should appear
		const qaCheckbox = page.getByText("Enable QA Testing").first();
		await expect(qaCheckbox).toBeVisible({ timeout: 5_000 });

		// Click the checkbox label to check it
		await qaCheckbox.click();

		// Verify the checkbox is now checked
		const checkbox = page.locator(".goal-preview-panel input[type='checkbox'].toggle-switch").first();
		await expect(checkbox).toBeChecked();

		// Listen for the goal creation POST *before* clicking, so a fast
		// response can't slip past under parallel load.
		const createPromise = page.waitForResponse(
			resp => resp.url().includes("/api/goals") && resp.request().method() === "POST" && resp.ok(),
			{ timeout: 15_000 },
		);
		const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await createGoalBtn.click();
		await createPromise;

		// Wait for navigation to goal dashboard
		await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 15_000 });

		// Verify the created goal has enabledOptionalSteps set
		const createdGoal = await findGoalByTitle("E2E Test Goal");
		expect(createdGoal).toBeTruthy();
		expect(createdGoal.enabledOptionalSteps).toContain("QA testing");

		// Clean up
		if (createdGoal) await deleteGoal(createdGoal.id);
	});

	test("optional steps toggle in proposal panel", async ({ page }) => {
		await openRegularSessionProposal(page);

		// The mock agent uses workflow "general" — no optional steps yet.
		await expect(page.getByText("Optional Steps")).not.toBeVisible();

		// Change workflow to "feature"
		const workflowSelect = page.locator(".goal-preview-panel select").first();
		await expect(workflowSelect).toBeVisible({ timeout: 5_000 });
		await workflowSelect.selectOption("feature");

		// "Enable QA Testing" checkbox should appear
		const qaCheckbox = page.locator(".goal-preview-panel input[type='checkbox'].toggle-switch").first();
		await expect(qaCheckbox).toBeVisible({ timeout: 5_000 });

		// Use dispatchEvent to toggle the checkbox, mirroring what a real click does.
		// Direct Playwright click may race with lit's .checked property binding.
		await qaCheckbox.evaluate((el: HTMLInputElement) => {
			el.checked = true;
			el.dispatchEvent(new Event("change", { bubbles: true }));
		});
		// Allow lit re-render to settle
		await page.waitForTimeout(300);

		// Create the goal
		const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await createGoalBtn.click();

		// Wait for navigation
		await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 15_000 });

		// Verify enabledOptionalSteps via API
		const createdGoal = await findGoalByTitle("E2E Test Goal");
		expect(createdGoal).toBeTruthy();
		expect(createdGoal.enabledOptionalSteps).toContain("QA testing");

		// Clean up
		if (createdGoal) await deleteGoal(createdGoal.id);
	});

	test("dismiss button absent in assistant panel", async ({ page }) => {
		await openGoalAssistantProposal(page);
		const assistantPanel = page.locator(".goal-preview-panel").first();
		await expect(assistantPanel).toBeVisible({ timeout: 5_000 });

		// Verify dismiss button does NOT exist in the assistant panel
		const dismissInAssistant = assistantPanel.locator("button").filter({ hasText: "Dismiss" });
		await expect(dismissInAssistant).toHaveCount(0);
	});

	test("dismiss button present in proposal panel", async ({ page }) => {
		await openRegularSessionProposal(page);

		// The proposal panel should have a dismiss button
		const dismissBtn = page.locator("button").filter({ hasText: "Dismiss" }).first();
		await expect(dismissBtn).toBeVisible({ timeout: 5_000 });

		// Click dismiss — the proposal panel title input should disappear
		await dismissBtn.click();
		const titleInput = page.locator("input[placeholder='Goal title']");
		await expect(titleInput).not.toBeVisible({ timeout: 5_000 });
	});
});
