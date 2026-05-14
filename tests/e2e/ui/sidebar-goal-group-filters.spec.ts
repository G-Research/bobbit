/**
 * E2E tests for the bug "sidebar goal-group sessions ignore Show Busy /
 * Show Read filters" (`src/app/render-helpers.ts::renderGoalGroup`).
 *
 * The unit-level reproducing test (`tests/sidebar-goal-group-filters.spec.ts`)
 * pins the pure logic against a file:// fixture; this spec exercises the
 * actual rendered sidebar inside the live gateway:
 *
 *   1. Show Read OFF hides an idle, read goal-scoped session, but the goal
 *      header stays visible. Re-enabling Show Read brings it back.
 *   2. The hidden state persists across a full page reload (Show Read OFF
 *      and the session row stays hidden after reload).
 *   3. A non-empty sidebar search bypasses the filter — the session row
 *      reappears while the search query matches it, and disappears again
 *      when the search is cleared.
 *
 * Patterned after `tests/e2e/ui/sidebar-filters.spec.ts`.
 */
import { test, expect } from "../gateway-harness.js";
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

test.describe("Sidebar goal-group session filters", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	/**
	 * Reset the three filter toggles to their defaults (Archived OFF, Busy ON,
	 * Read ON) and reload. Run at the start of every test so prior worker
	 * state doesn't leak in via localStorage.
	 */
	async function resetFilters(page: import("@playwright/test").Page) {
		await page.evaluate(() => {
			localStorage.removeItem("bobbit-show-archived");
			localStorage.removeItem("bobbit-show-busy");
			localStorage.removeItem("bobbit-show-read");
		});
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
	}

	/**
	 * Force the goal-group to be expanded so its child session rows are in
	 * the DOM (the goal collapse state persists across reloads via
	 * localStorage). Idempotent.
	 */
	async function expandGoalInSidebar(page: import("@playwright/test").Page, goalId: string) {
		const goalHeader = page.locator(`[data-nav-id="goal:${goalId}"]`).first();
		await expect(goalHeader).toBeVisible({ timeout: 10_000 });
		await page.evaluate((id) => {
			try {
				const raw = localStorage.getItem("bobbit-expanded-goals");
				const arr = raw ? JSON.parse(raw) : [];
				if (!arr.includes(id)) {
					arr.push(id);
					localStorage.setItem("bobbit-expanded-goals", JSON.stringify(arr));
				}
			} catch { /* best-effort */ }
		}, goalId);
		// Reload so the expanded-goals localStorage is picked up by the
		// state.ts module-init read.  The header path renders unconditionally,
		// so we just need its expanded state to take effect.
		await page.reload();
		await expect(
			page.locator(`[data-nav-id="goal:${goalId}"]`).first(),
		).toBeVisible({ timeout: 10_000 });
	}

	test("Show Read OFF hides idle goal session — goal header stays visible @smoke", async ({ page }) => {
		const goal = await createGoal({
			title: "GoalGroupFilterReadGoal",
			worktree: false,
			team: false,
		});
		const goalSessionId = await createSession({ cwd: nonGitCwd(), goalId: goal.id });
		// Other ungrouped session — used as the active session so the goal
		// session itself isn't exempted by the active-session rule.
		const otherSessionId = await createSession({ cwd: nonGitCwd() });
		try {
			await apiFetch(`/api/sessions/${goalSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "GoalChildIdleRead" }),
			});
			await apiFetch(`/api/sessions/${otherSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "ActiveOther" }),
			});
			// Mark both as read so neither has unread activity.
			await apiFetch(`/api/sessions/${goalSessionId}/mark-read`, { method: "POST" });
			await apiFetch(`/api/sessions/${otherSessionId}/mark-read`, { method: "POST" });

			await openApp(page);
			await resetFilters(page);
			await expandGoalInSidebar(page, goal.id);

			// Goal header rendered.
			const goalHeader = page.locator(`[data-nav-id="goal:${goal.id}"]`).first();
			await expect(goalHeader).toBeVisible({ timeout: 10_000 });
			// Child goal session row rendered under the expanded goal.
			const goalSessionRow = page.locator(`[data-session-id="${goalSessionId}"]`).first();
			await expect(goalSessionRow).toBeVisible({ timeout: 10_000 });

			// Make the OTHER session the active one so the goal session is
			// not exempted by the active-session rule.
			await page.locator(`[data-session-id="${otherSessionId}"]`).first().click();
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

			// Wait until the keyboard-shortcut listener is mounted.
			await expect.poll(() =>
				page.evaluate(() => document.body.dataset.shortcutsReady),
			).toBe("1");

			// Turn Show Read OFF.
			await page.keyboard.press("Alt+Shift+KeyR");
			await expect.poll(() =>
				page.evaluate(() => localStorage.getItem("bobbit-show-read")),
			).toBe("false");

			// Goal session row disappears — but goal header MUST stay visible.
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`)).toHaveCount(0, { timeout: 5_000 });
			await expect(goalHeader).toBeVisible();

			// Active session (the other one) must still be visible.
			await expect(page.locator(`[data-session-id="${otherSessionId}"]`).first()).toBeVisible();

			// Toggle Show Read back ON — goal session reappears.
			await page.keyboard.press("Alt+Shift+KeyR");
			await expect.poll(() =>
				page.evaluate(() => localStorage.getItem("bobbit-show-read")),
			).toBe("true");
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`).first()).toBeVisible({ timeout: 5_000 });
		} finally {
			await deleteSession(goalSessionId).catch(() => {});
			await deleteSession(otherSessionId).catch(() => {});
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("Show Read OFF persists across reload — goal session stays hidden", async ({ page }) => {
		const goal = await createGoal({
			title: "GoalGroupFilterPersistGoal",
			worktree: false,
			team: false,
		});
		const goalSessionId = await createSession({ cwd: nonGitCwd(), goalId: goal.id });
		const otherSessionId = await createSession({ cwd: nonGitCwd() });
		try {
			await apiFetch(`/api/sessions/${goalSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "GoalChildPersist" }),
			});
			await apiFetch(`/api/sessions/${otherSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "ActivePersist" }),
			});
			await apiFetch(`/api/sessions/${goalSessionId}/mark-read`, { method: "POST" });
			await apiFetch(`/api/sessions/${otherSessionId}/mark-read`, { method: "POST" });

			await openApp(page);
			await resetFilters(page);
			await expandGoalInSidebar(page, goal.id);

			// Activate the OTHER session so the goal session is non-active.
			await page.locator(`[data-session-id="${otherSessionId}"]`).first().click();
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

			await expect.poll(() =>
				page.evaluate(() => document.body.dataset.shortcutsReady),
			).toBe("1");
			await page.keyboard.press("Alt+Shift+KeyR");
			await expect.poll(() =>
				page.evaluate(() => localStorage.getItem("bobbit-show-read")),
			).toBe("false");

			// Pre-reload: session hidden, goal visible.
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`)).toHaveCount(0, { timeout: 5_000 });
			await expect(page.locator(`[data-nav-id="goal:${goal.id}"]`).first()).toBeVisible();

			// Reload — filter must persist via localStorage.
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 15_000 });
			await expect.poll(() =>
				page.evaluate(() => localStorage.getItem("bobbit-show-read")),
			).toBe("false");

			// Goal session still hidden, goal header still visible.
			await expect(page.locator(`[data-nav-id="goal:${goal.id}"]`).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`)).toHaveCount(0, { timeout: 5_000 });

			// Restore default for other tests.
			await expect.poll(() =>
				page.evaluate(() => document.body.dataset.shortcutsReady),
			).toBe("1");
			await page.keyboard.press("Alt+Shift+KeyR");
		} finally {
			await deleteSession(goalSessionId).catch(() => {});
			await deleteSession(otherSessionId).catch(() => {});
			await deleteGoal(goal.id).catch(() => {});
		}
	});

	test("Non-empty search bypasses the Show Read filter for goal sessions", async ({ page }) => {
		const goal = await createGoal({
			title: "GoalGroupFilterSearchGoal",
			worktree: false,
			team: false,
		});
		const goalSessionId = await createSession({ cwd: nonGitCwd(), goalId: goal.id });
		const otherSessionId = await createSession({ cwd: nonGitCwd() });
		try {
			await apiFetch(`/api/sessions/${goalSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "GoalChildSearchableXYZ" }),
			});
			await apiFetch(`/api/sessions/${otherSessionId}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "ActiveSearch" }),
			});
			await apiFetch(`/api/sessions/${goalSessionId}/mark-read`, { method: "POST" });
			await apiFetch(`/api/sessions/${otherSessionId}/mark-read`, { method: "POST" });

			await openApp(page);
			await resetFilters(page);
			await expandGoalInSidebar(page, goal.id);

			// Activate the OTHER session.
			await page.locator(`[data-session-id="${otherSessionId}"]`).first().click();
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

			// Turn Show Read OFF — goal child hides.
			await expect.poll(() =>
				page.evaluate(() => document.body.dataset.shortcutsReady),
			).toBe("1");
			await page.keyboard.press("Alt+Shift+KeyR");
			await expect.poll(() =>
				page.evaluate(() => localStorage.getItem("bobbit-show-read")),
			).toBe("false");
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`)).toHaveCount(0, { timeout: 5_000 });

			// Type a search query that matches the goal session title.
			const searchInput = page.locator("input[data-search]");
			await searchInput.click();
			await searchInput.fill("SearchableXYZ");
			// Search bypasses the filter — goal child reappears.
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`).first()).toBeVisible({ timeout: 5_000 });

			// Clear search — filter re-applies, goal child hidden again.
			await searchInput.fill("");
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`)).toHaveCount(0, { timeout: 5_000 });

			// Restore default Show Read ON for other tests.
			await page.keyboard.press("Alt+Shift+KeyR");
		} finally {
			await deleteSession(goalSessionId).catch(() => {});
			await deleteSession(otherSessionId).catch(() => {});
			await deleteGoal(goal.id).catch(() => {});
		}
	});
});
