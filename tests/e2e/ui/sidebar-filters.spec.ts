/**
 * Retained full-stack smoke for sidebar filter/search integration.
 * Exhaustive filter/search matrices live in tests/ui-fixtures/sidebar-filter-search-fixture.spec.ts.
 */
import { test, expect, type Page } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, nonGitCwd, waitForHealth } from "../e2e-setup.js";
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

async function openPopover(page: Page) {
	await page.locator("[data-testid='sidebar-filters-button']").first().click();
	const popover = page.locator("[data-testid='sidebar-filters-popover']");
	await expect(popover).toBeVisible({ timeout: 5_000 });
	return popover;
}

test.describe("Sidebar filter/search full-stack smoke", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("Show Read OFF hides a read idle row while search bypasses the filter @smoke", async ({ page }) => {
		const idle = await createSession({ cwd: nonGitCwd() });
		const active = await createSession({ cwd: nonGitCwd() });
		try {
			await apiFetch(`/api/sessions/${idle}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "IdleReadFilterSmoke" }),
			});
			await apiFetch(`/api/sessions/${active}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "ActiveReadFilterSmoke" }),
			});
			await apiFetch(`/api/sessions/${idle}/mark-read`, { method: "POST" });
			await apiFetch(`/api/sessions/${active}/mark-read`, { method: "POST" });

			await openApp(page);
			await resetFilters(page);
			await expect(page.locator(`[data-session-id="${idle}"]`).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(`[data-session-id="${active}"]`).first()).toBeVisible({ timeout: 5_000 });

			await page.locator(`[data-session-id="${active}"]`).first().click();
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

			const popover = await openPopover(page);
			await popover.locator("[data-testid='sidebar-filter-read'] input[type='checkbox']").uncheck();
			await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("false");
			await expect(page.locator(`[data-session-id="${active}"]`).first()).toBeVisible({ timeout: 5_000 });
			await expect(page.locator(`[data-session-id="${idle}"]`)).toHaveCount(0, { timeout: 5_000 });

			const searchInput = page.locator("input[data-search]");
			await searchInput.fill("IdleReadFilterSmoke");
			await expect(page.locator(`[data-session-id="${idle}"]`).first()).toBeVisible({ timeout: 5_000 });
			await searchInput.fill("");
			await expect(page.locator(`[data-session-id="${idle}"]`)).toHaveCount(0, { timeout: 5_000 });
		} finally {
			await deleteSession(idle).catch(() => {});
			await deleteSession(active).catch(() => {});
		}
	});
});
