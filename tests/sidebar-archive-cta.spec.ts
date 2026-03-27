import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-archive-cta.html")}`;

test.describe("Sidebar empty state — archive CTA", () => {
	test("archived goal shows 'archived'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() =>
			(window as any).getEmptyState(true, false, true),
		);
		expect(result).toBe("archived");
	});

	test("team goal (not archivable) shows 'start-team'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() =>
			(window as any).getEmptyState(false, false, true),
		);
		expect(result).toBe("start-team");
	});

	test("non-team goal shows 'start-session'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() =>
			(window as any).getEmptyState(false, false, false),
		);
		expect(result).toBe("start-session");
	});

	test("merged PR with no active team should show 'archive-goal', not 'start-team'", async ({ page }) => {
		await page.goto(TEST_PAGE);
		// canArchive=true means: PR merged, no active team, not archived
		// isTeamGoal=true because it IS a team goal (has workflow)
		const result = await page.evaluate(() =>
			(window as any).getEmptyState(false, true, true),
		);
		// BUG: current code returns 'start-team' because there is no canArchive branch
		expect(result, "Expected sidebar to show archive-goal CTA when PR is merged").toBe("archive-goal");
	});
});
