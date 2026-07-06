/**
 * Journey: Goal Editing + Subgoals — v2 browser smoke
 * Covers: journey-goal-editing, journey-subgoals
 * Consolidated from: goal-edit-*, goal-spec-*, subgoals-*, etc.
 */
import { test, expect, openApp, navigateToHash, createGoal, deleteGoal } from "../_helpers/journey-fixture.js";

test.describe("Journey: Goal Editing", () => {
	test("goal dashboard renders goal title", async ({ page }) => {
		const title = "v2-goal-editing-smoke";
		const goal = await createGoal({ title });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(title).first()).toBeVisible({ timeout: 10_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal dashboard shows sidebar edge", async ({ page }) => {
		const goal = await createGoal({ title: "v2-goal-edit-sidebar" });
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

test.describe("Journey: Subgoals", () => {
	test("goal route renders for subgoal context", async ({ page }) => {
		const goal = await createGoal({ title: "v2-subgoal-smoke" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("multiple goals navigable without crash", async ({ page }) => {
		const g1 = await createGoal({ title: "v2-subgoal-a" });
		const g2 = await createGoal({ title: "v2-subgoal-b" });
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
