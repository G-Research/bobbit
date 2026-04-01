/**
 * Goal creation E2E tests: assistant flow with mock agent proposal, API creation.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, nonGitCwd } from "../e2e-setup.js";
import { openApp, sendMessage, waitForAgentResponse, navigateToHash } from "./ui-helpers.js";

test.describe("Goal creation (full-stack UI)", () => {
	test("create goal via assistant flow", async ({ page }) => {
		await openApp(page);

		// Click the "New Goal" button in the sidebar (title="New goal (Alt+G)")
		const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
		await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
		await newGoalBtn.click();

		// Wait for the textarea to appear (goal assistant session is created)
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });

		// Send a message with GOAL_PROPOSAL keyword to trigger mock agent
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		// The proposal parser should detect the <goal_proposal> block and populate
		// the preview panel. On desktop, the goal preview panel always shows for
		// assistantType="goal". Wait for the title field to be populated.
		// The title input is in the goal-preview-panel with placeholder "Goal title"
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 10_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// Now the Create Goal button should be enabled
		const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await expect(createGoalBtn).toBeVisible({ timeout: 5_000 });

		// Click "Create Goal"
		await createGoalBtn.click();

		// After creating, the app navigates to the goal dashboard.
		// Wait for the URL to change to a goal-related view
		await expect(page).toHaveURL(/#\/goal(-dashboard)?\//, { timeout: 15_000 });

		// Verify the goal was created via API
		const goalsResp = await apiFetch("/api/goals");
		expect(goalsResp.ok).toBe(true);
		const goalsData = await goalsResp.json();
		const goals = goalsData.goals || goalsData;
		const createdGoal = (goals as any[]).find((g: any) => g.title === "E2E Test Goal");
		expect(createdGoal).toBeTruthy();

		// Clean up
		if (createdGoal) {
			await apiFetch(`/api/goals/${createdGoal.id}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("goal appears after API creation", async ({ page }) => {
		// Create goal via API first
		const goal = await createGoal({ title: "API Created Goal" });

		try {
			await openApp(page);

			// The goal should appear somewhere in the UI — check the sidebar goals section
			// Goals appear in the sidebar as clickable entries
			await expect(page.getByText("API Created Goal").first()).toBeVisible({ timeout: 10_000 });
		} finally {
			await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
