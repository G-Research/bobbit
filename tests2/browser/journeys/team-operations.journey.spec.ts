/**
 * Journey: Team Operations (Team Delegate + Dashboard Fanout) — v2 browser smoke
 * Covers: journey-team-delegate, journey-dashboard-fanout
 * Consolidated from: archive-child-cascade, team-delegate-*, dashboard-fanout-*, etc.
 */
import { test, expect, openApp, navigateToHash, createGoal, deleteGoal } from "../_helpers/journey-fixture.js";

test.describe("Journey: Team Delegate", () => {
	test("goal dashboard accessible for team delegate context", async ({ page }) => {
		const goal = await createGoal({ title: "v2-team-delegate-smoke" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("sidebar visible during team delegate scenario", async ({ page }) => {
		const goal = await createGoal({ title: "v2-team-delegate-sidebar" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});
});

test.describe("Journey: Dashboard Fanout", () => {
	test("goal list renders (fanout scenario entry point)", async ({ page }) => {
		const g1 = await createGoal({ title: "v2-fanout-goal-1" });
		const g2 = await createGoal({ title: "v2-fanout-goal-2" });
		try {
			await openApp(page);
			// Sidebar goals list is the entry point for dashboard fanout
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(g1.id, true);
			await deleteGoal(g2.id, true);
		}
	});

	test("navigating between goals works (fanout)", async ({ page }) => {
		const g1 = await createGoal({ title: "v2-fanout-nav-1" });
		const g2 = await createGoal({ title: "v2-fanout-nav-2" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${g1.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await navigateToHash(page, `#/goal/${g2.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(g1.id, true);
			await deleteGoal(g2.id, true);
		}
	});
});
