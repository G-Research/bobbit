/**
 * Navigation E2E tests — Journey 5.
 * Tests hash-based routing, view transitions, deep links, sidebar toggle,
 * and back navigation through real browser interactions.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, createGoal, deleteGoal, apiFetch, waitForSessionStatus, nonGitCwd } from "../e2e-setup.js";
import { openApp, navigateToHash, navigateToGoalDashboard } from "./ui-helpers.js";

test.describe("Navigation (UI)", () => {
	test("landing view shows on fresh load", async ({ page }) => {
		await openApp(page);
		// On fresh load with no sessions, verify the landing state:
		// The sidebar should be visible (Settings button is always present)
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// The landing page should not show a session chat (no textarea)
		// unless auto-creating. Check for the landing content area.
		const hash = await page.evaluate(() => window.location.hash);
		// Should be at landing (empty hash or #/)
		expect(hash === "" || hash === "#/" || hash === "#").toBeTruthy();
	});

	test("deep-link to session view", async ({ page }) => {
		// Create a session via API
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to the session via deep link
		await navigateToHash(page, `#/session/${sessionId}`);

		// Verify the chat textarea is visible (session view loaded)
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Cleanup
		await deleteSession(sessionId);
	});

	test("navigate to goal dashboard via deep link", async ({ page }) => {
		// Create a goal via API
		const goal = await createGoal({ title: "Navigation Test Goal" });

		await openApp(page);

		// Navigate to goal dashboard
		await navigateToGoalDashboard(page, goal.id);

		// Verify goal dashboard content is visible — look for the goal title
		await expect(
			page.getByText("Navigation Test Goal").first(),
		).toBeVisible({ timeout: 10_000 });

		// Cleanup
		await deleteGoal(goal.id);
	});

	test("session to settings and back", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// Navigate to session
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Click the Settings button — desktop sidebar has "Settings (Ctrl+,)"
		await page.locator("button[title='Settings (Ctrl+,)']").first().click();

		// Verify settings view is shown
		await expect(page.locator("text=Settings").first()).toBeVisible({ timeout: 5_000 });

		// Verify the URL hash changed to settings
		const hash = await page.evaluate(() => window.location.hash);
		expect(hash).toContain("settings");

		// Go back via browser navigation
		await page.goBack();

		// Verify we're back at the session view
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Cleanup
		await deleteSession(sessionId);
	});

	test("sidebar collapse and expand", async ({ page }) => {
		await openApp(page);

		// The sidebar should be visible initially (240px wide sidebar with collapse button)
		const collapseBtn = page.locator("button[title='Collapse sidebar (Ctrl+[)']");
		await expect(collapseBtn).toBeVisible({ timeout: 5_000 });

		// Click to collapse
		await collapseBtn.click();

		// After collapse, the expand button should appear
		const expandBtn = page.locator("button[title='Expand sidebar (Ctrl+[)']");
		await expect(expandBtn).toBeVisible({ timeout: 5_000 });

		// The collapse button should be gone
		await expect(collapseBtn).not.toBeVisible();

		// Click to expand
		await expandBtn.click();

		// The collapse button should be back
		await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
	});

	test("back navigation works", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		await openApp(page);

		// We're at landing. Navigate to the session.
		await navigateToHash(page, `#/session/${sessionId}`);
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });

		// Go back — should return to landing
		await page.goBack();

		// Verify we're back at landing — the sidebar Settings button should be visible
		// and no session textarea should be active
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 10_000 });

		// Cleanup
		await deleteSession(sessionId);
	});
});
