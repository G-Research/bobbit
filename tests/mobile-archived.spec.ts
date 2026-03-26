import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/mobile-archived.html")}`;

test.describe("Mobile archived sections", () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test("only live goals appear in main list", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const mainGoals = page.locator("#main-goals .goal-item");
		await expect(mainGoals).toHaveCount(2);
		// All main goals should not be archived
		for (const goal of await mainGoals.all()) {
			await expect(goal).toHaveAttribute("data-archived", "false");
		}
	});

	test("archived sections hidden when showArchived is false", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await expect(page.locator("#archived-goals-section")).toHaveClass(/hidden/);
		await expect(page.locator("#archived-sessions-section")).toHaveClass(/hidden/);
	});

	test("archived goals section appears when showArchived is true", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).setShowArchived(true));

		const section = page.locator("#archived-goals-section");
		await expect(section).not.toHaveClass(/hidden/);

		// Check header
		await expect(section.locator(".section-header")).toHaveText("Archived Goals");

		// Check archived goals have opacity-60
		const archivedGoals = section.locator(".goal-item");
		await expect(archivedGoals).toHaveCount(1);
		await expect(archivedGoals.first()).toHaveClass(/opacity-60/);
		await expect(archivedGoals.first()).toHaveAttribute("data-archived", "true");
	});

	test("archived goals do NOT appear in main list when showArchived is true", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).setShowArchived(true));

		const mainGoals = page.locator("#main-goals .goal-item");
		await expect(mainGoals).toHaveCount(2);
		for (const goal of await mainGoals.all()) {
			await expect(goal).toHaveAttribute("data-archived", "false");
		}
	});

	test("standalone archived sessions section appears when showArchived is true", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).setShowArchived(true));

		const section = page.locator("#archived-sessions-section");
		await expect(section).not.toHaveClass(/hidden/);

		// Check header
		await expect(section.locator(".section-header")).toHaveText("Archived");

		// Only standalone (not teamGoalId, not delegateOf) sessions
		const sessions = section.locator(".archived-session");
		await expect(sessions).toHaveCount(1);
		await expect(sessions.first()).toHaveAttribute("data-session-id", "s1");
	});

	test("toggling showArchived off hides both sections", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() => (window as any).setShowArchived(true));

		// Verify visible
		await expect(page.locator("#archived-goals-section")).not.toHaveClass(/hidden/);
		await expect(page.locator("#archived-sessions-section")).not.toHaveClass(/hidden/);

		// Toggle off
		await page.evaluate(() => (window as any).setShowArchived(false));

		await expect(page.locator("#archived-goals-section")).toHaveClass(/hidden/);
		await expect(page.locator("#archived-sessions-section")).toHaveClass(/hidden/);
	});
});
