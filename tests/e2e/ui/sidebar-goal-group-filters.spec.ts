/**
 * Browser coverage for goal-group sessions honoring sidebar Show Read filters.
 * Pure filter matrix coverage lives in tests/sidebar-goal-group-filters.spec.ts.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	nonGitCwd,
	waitForHealth,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function resetFilters(page: Page): Promise<void> {
	await page.evaluate(() => {
		localStorage.removeItem("bobbit-show-archived");
		localStorage.removeItem("bobbit-show-busy");
		localStorage.removeItem("bobbit-show-read");
	});
	await page.reload();
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
}

async function expandGoalInSidebar(page: Page, goalId: string): Promise<void> {
	await expect(page.locator(`[data-nav-id="goal:${goalId}"]`).first()).toBeVisible({ timeout: 10_000 });
	await page.evaluate((id) => {
		const raw = localStorage.getItem("bobbit-expanded-goals");
		const arr = raw ? JSON.parse(raw) : [];
		if (!arr.includes(id)) {
			arr.push(id);
			localStorage.setItem("bobbit-expanded-goals", JSON.stringify(arr));
		}
	}, goalId);
	await page.reload();
	await expect(page.locator(`[data-nav-id="goal:${goalId}"]`).first()).toBeVisible({ timeout: 10_000 });
}

test.describe("Sidebar goal-group session filters", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("Show Read OFF hides read goal sessions, persists across reload, and search bypasses", async ({ page }) => {
		const goal = await createGoal({ title: "GoalGroupFilterReadGoal", worktree: false, team: false });
		const goalSessionId = await createSession({ cwd: nonGitCwd(), goalId: goal.id });
		const otherSessionId = await createSession({ cwd: nonGitCwd() });
		try {
			await apiFetch(`/api/sessions/${goalSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "GoalChildSearchableXYZ" }),
			});
			await apiFetch(`/api/sessions/${otherSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "ActiveOther" }),
			});
			await apiFetch(`/api/sessions/${goalSessionId}/mark-read`, { method: "POST" });
			await apiFetch(`/api/sessions/${otherSessionId}/mark-read`, { method: "POST" });

			await openApp(page);
			await resetFilters(page);
			await expandGoalInSidebar(page, goal.id);

			const goalHeader = page.locator(`[data-nav-id="goal:${goal.id}"]`).first();
			const goalSessionRow = page.locator(`[data-session-id="${goalSessionId}"]`).first();
			await expect(goalHeader).toBeVisible({ timeout: 10_000 });
			await expect(goalSessionRow).toBeVisible({ timeout: 10_000 });

			await page.locator(`[data-session-id="${otherSessionId}"]`).first().click();
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
			await expect.poll(() => page.evaluate(() => document.body.dataset.shortcutsReady)).toBe("1");
			await page.keyboard.press("Alt+Shift+KeyR");
			await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("false");

			await expect(page.locator(`[data-session-id="${goalSessionId}"]`)).toHaveCount(0, { timeout: 5_000 });
			await expect(goalHeader).toBeVisible();
			await expect(page.locator(`[data-session-id="${otherSessionId}"]`).first()).toBeVisible();

			await page.reload();
			await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
			await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("false");
			await expect(page.locator(`[data-nav-id="goal:${goal.id}"]`).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`)).toHaveCount(0, { timeout: 5_000 });

			const searchInput = page.locator("input[data-search]");
			await searchInput.fill("SearchableXYZ");
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`).first()).toBeVisible({ timeout: 5_000 });
			await searchInput.fill("");
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`)).toHaveCount(0, { timeout: 5_000 });

			await page.keyboard.press("Alt+Shift+KeyR");
			await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("true");
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`).first()).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(goalSessionId).catch(() => {});
			await deleteSession(otherSessionId).catch(() => {});
			await deleteGoal(goal.id).catch(() => {});
		}
	});
});
