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

// Sync on the goal-group re-rendering after a filter/search change before
// sampling the read goal-session row. Under Chromium contention the sidebar
// re-render lags the state/localStorage write, so an optimistic single-row
// `toBeVisible()` reads before the full set has rendered (the #6 flake). We
// poll the row into existence (exact count) — optionally gated on the group
// header — rather than racing a one-shot read.
async function waitForGoalSessionRow(
	page: Page,
	sessionId: string,
	message: string,
	goalId?: string,
): Promise<void> {
	if (goalId) {
		await expect(page.locator(`[data-nav-id="goal:${goalId}"]`).first(), `${message}: goal group header`).toBeVisible({ timeout: 10_000 });
	}
	await expect.poll(() => page.locator(`[data-session-id="${sessionId}"]`).count(), { timeout: 10_000, message }).toBe(1);
	await expect(page.locator(`[data-session-id="${sessionId}"]`).first(), message).toBeVisible();
}

// Drive the sidebar search box to a known applied state. The search input
// debounces by 200ms before publishing to `state.searchQuery` (see
// ui/components/SearchBox.ts); under Chromium contention a single `fill`'s
// debounced dispatch can fail to land, leaving `searchQuery` empty so the
// filtered rows never re-render (the #6 flake). Re-issue the input until the
// app state actually reflects the query — synchronizing on the real
// precondition rather than racing one optimistic keystroke.
async function applySearch(page: Page, query: string): Promise<void> {
	const input = page.locator("input[data-search]");
	await expect(input).toBeVisible({ timeout: 10_000 });
	await expect.poll(async () => {
		await input.fill(query);
		return page.evaluate(() => (window as any).bobbitState?.searchQuery ?? "");
	}, { timeout: 10_000, intervals: [250, 400, 700, 1000], message: `search query should apply: ${JSON.stringify(query)}` }).toBe(query);
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

			await applySearch(page, "SearchableXYZ");
			await waitForGoalSessionRow(page, goalSessionId, "search must bypass Show Read and reveal the read goal session");
			await applySearch(page, "");
			await expect(page.locator(`[data-session-id="${goalSessionId}"]`)).toHaveCount(0, { timeout: 5_000 });

			await page.keyboard.press("Alt+Shift+KeyR");
			await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("true");
			await waitForGoalSessionRow(page, goalSessionId, "turning Show Read back on must restore the read goal session", goal.id);
		} finally {
			await deleteSession(goalSessionId).catch(() => {});
			await deleteSession(otherSessionId).catch(() => {});
			await deleteGoal(goal.id).catch(() => {});
		}
	});
});
