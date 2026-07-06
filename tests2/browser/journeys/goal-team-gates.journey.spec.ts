/**
 * Journey: Goal → Team → Gates — v2 browser smoke
 */
import { test, expect, openApp, navigateToHash, createGoal, deleteGoal } from "../_helpers/journey-fixture.js";

test.describe("Journey: Goal → Team → Gates", () => {
	test("goal dashboard renders after navigation", async ({ page }) => {
		const goal = await createGoal({ title: "v2-journey-smoke-goal" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			const dashboard = page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first();
			await expect(dashboard).toBeVisible({ timeout: 20_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal title visible in dashboard", async ({ page }) => {
		const title = "v2-journey-title-visible";
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

	test("sidebar shows sidebar-edge after goal navigation", async ({ page }) => {
		const goal = await createGoal({ title: "v2-journey-sidebar-goal" });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal API returns goal after creation", async ({ page }) => {
		const { apiFetch } = await import("../../../tests/e2e/e2e-setup.js");
		const goal = await createGoal({ title: "v2-journey-api-check" });
		try {
			const resp = await apiFetch(`/api/goals/${goal.id}`);
			expect(resp.ok).toBe(true);
			const data = await resp.json();
			expect(data.id).toBe(goal.id);
		} finally {
			await deleteGoal(goal.id, true);
		}
	});
});
