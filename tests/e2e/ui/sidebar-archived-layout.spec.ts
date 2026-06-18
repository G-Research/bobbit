/**
 * Minimal full-stack smoke for archived sidebar rendering.
 * Matrix coverage lives in tests/ui-fixtures/sidebar-archived-fixture.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import {
	apiFetch,
	createGoal,
	createSession,
	deleteGoal,
	deleteSession,
	waitForSessionStatus,
} from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";
import { filtersButton, clickShowArchivedToggle } from "./utils/sidebar-filters.js";

function suffix(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe("Archived sidebar full-stack smoke", () => {
	let sessionId = "";
	let goalId = "";
	const tag = suffix();
	const goalTitle = `Archived Smoke Goal ${tag}`;

	test.afterAll(async () => {
		if (sessionId) await deleteSession(sessionId).catch(() => {});
		if (goalId) await deleteGoal(goalId).catch(() => {});
	});

	test("Show Archived reveals archived session/goal, survives reload, and hides on toggle off", async ({ page }) => {
		sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		await deleteSession(sessionId);

		const goal = await createGoal({ title: goalTitle, worktree: false });
		goalId = goal.id;
		await apiFetch(`/api/goals/${goalId}?cascade=false`, { method: "DELETE" });

		await openApp(page);
		await expect(page.getByText(goalTitle, { exact: false })).toHaveCount(0, { timeout: 3_000 });

		const showArchived = filtersButton(page);
		await expect(showArchived).toBeVisible({ timeout: 10_000 });
		await clickShowArchivedToggle(page);
		await expect(page.locator("span.uppercase").filter({ hasText: /^Archived$/ }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText(goalTitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[style*='grayscale(1)']").first()).toBeVisible({ timeout: 10_000 });

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByText(goalTitle, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

		await clickShowArchivedToggle(page);
		await expect(page.getByText(goalTitle, { exact: false })).toHaveCount(0, { timeout: 5_000 });
		await expect(showArchived).not.toHaveClass(/text-primary/, { timeout: 5_000 });
	});
});
