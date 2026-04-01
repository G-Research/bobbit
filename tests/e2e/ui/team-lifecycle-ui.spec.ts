/**
 * E2E tests: Team Lifecycle (Journey 3)
 *
 * Tests starting a team via the goal dashboard UI, observing team sessions,
 * navigating to team member sessions, and verifying teardown cleanup.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createGoal, startTeam, teardownTeam, deleteGoal, nonGitCwd } from "../e2e-setup.js";
import { openApp, navigateToGoalDashboard } from "./ui-helpers.js";

test.describe("Team lifecycle (UI)", () => {
	const goalIds: string[] = [];

	test.afterAll(async () => {
		for (const id of goalIds) {
			await teardownTeam(id).catch(() => {});
			await deleteGoal(id);
		}
	});

	test("start team via UI and see team lead", async ({ page }) => {
		// Create a team-enabled goal via API
		const goal = await createGoal({ title: "Team UI Test", worktree: false, team: true });
		goalIds.push(goal.id);

		await openApp(page);

		// Debug: check what the page shows before navigating
		await navigateToGoalDashboard(page, goal.id);

		// The "Start Team" button should be in the nav bar
		// It's inside a .btn-split > button.btn-split-main with title containing "Start the goal team"
		const startBtn = page.locator(".btn-split-main").filter({ hasText: "Start Team" }).first();
		await expect(startBtn).toBeVisible({ timeout: 10_000 });
		// Check if button is disabled
		const isDisabled = await startBtn.isDisabled();
		if (isDisabled) {
			// setupStatus may not be "ready" — wait for it
			await expect(startBtn).toBeEnabled({ timeout: 10_000 });
		}
		await startBtn.click();

		// After clicking "Start Team", the UI calls startTeam() API then
		// connectToSession() which navigates to the team lead's session view.
		// Wait for the session view to load (textarea appears)
		await expect(
			page.locator("textarea").first(),
		).toBeVisible({ timeout: 25_000 });

		// Navigate back to the goal dashboard to verify the team is visible
		await navigateToGoalDashboard(page, goal.id);

		// Click the Agents tab to see the team lead
		const agentsTab = page.locator(".tab").filter({ hasText: "Agents" });
		await agentsTab.click();

		// The agents tab should show at least the team lead
		await expect(
			page.locator(".agent-card").first(),
		).toBeVisible({ timeout: 15_000 });
	});

	test("navigate to team member session", async ({ page }) => {
		// Create goal + start team via API for speed
		const goal = await createGoal({ title: "Team Nav Test", worktree: false, team: true });
		goalIds.push(goal.id);
		const sessionId = await startTeam(goal.id);

		await openApp(page);
		await navigateToGoalDashboard(page, goal.id);

		// Click the Agents tab
		const agentsTab = page.locator(".tab").filter({ hasText: "Agents" });
		await agentsTab.click();

		// Wait for agent card to appear then click it
		const agentCard = page.locator(".agent-card").first();
		await expect(agentCard).toBeVisible({ timeout: 15_000 });
		await agentCard.click();

		// Verify session view loads (textarea for sending messages should be visible)
		await expect(
			page.locator("textarea").first(),
		).toBeVisible({ timeout: 10_000 });
	});

	test("team teardown cleans up UI", async ({ page }) => {
		// Create goal + start team via API
		const goal = await createGoal({ title: "Teardown Test", worktree: false, team: true });
		goalIds.push(goal.id);
		await startTeam(goal.id);

		await openApp(page);
		await navigateToGoalDashboard(page, goal.id);

		// Click the Agents tab and verify team is visible
		const agentsTab = page.locator(".tab").filter({ hasText: "Agents" });
		await agentsTab.click();

		await expect(
			page.locator(".agent-card").first(),
		).toBeVisible({ timeout: 15_000 });

		// Teardown team via API
		await teardownTeam(goal.id);

		// Reload and navigate back to the dashboard
		await page.reload();
		await expect(
			page.locator("button[title='New session']").first(),
		).toBeVisible({ timeout: 15_000 });
		await navigateToGoalDashboard(page, goal.id);

		// Click Agents tab again
		const agentsTabAfter = page.locator(".tab").filter({ hasText: "Agents" });
		await agentsTabAfter.click();

		// No active agent cards should be shown (or empty state message)
		await expect(
			page.locator(".tab-empty, .agent-grid:empty").first(),
		).toBeVisible({ timeout: 10_000 });
	});
});
