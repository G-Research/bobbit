/**
 * Journey: Goal → Team → Gates — v2 browser smoke
 */
import { test, expect, openApp, navigateToHash, createGoal, deleteGoal } from "../../../tests2/browser/_helpers/journey-fixture.js";

test.describe("Journey: Goal → Team → Gates", () => {
	test("goal dashboard renders its title and sidebar edge after navigation", async ({ page }) => {
		const title = "v2-journey-dashboard-title";
		const goal = await createGoal({ title });
		try {
			await openApp(page);
			await navigateToHash(page, `#/goal/${goal.id}`);
			await expect(page.locator(".dashboard-container, .goal-dashboard, goal-dashboard").first()).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
			await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteGoal(goal.id, true);
		}
	});

	test("goal API returns goal after creation", async () => {
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
