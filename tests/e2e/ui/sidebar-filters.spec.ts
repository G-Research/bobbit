/**
 * E2E tests for the Sidebar Filters popover.
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

test.describe("Sidebar Filters popover", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("popover defaults, click persistence, and keyboard shortcuts @smoke", async ({ page }) => {
		await openApp(page);
		await resetFilters(page);

		const filtersBtn = page.locator("[data-testid='sidebar-filters-button']").first();
		await expect(filtersBtn).toBeVisible({ timeout: 10_000 });
		await expect(filtersBtn).toHaveText(/Filters/);
		await expect(page.locator("[data-testid='sidebar-filters-popover']")).toHaveCount(0);

		const popover = await openPopover(page);
		const archived = popover.locator("[data-testid='sidebar-filter-archived'] input[type='checkbox']");
		const busy = popover.locator("[data-testid='sidebar-filter-busy'] input[type='checkbox']");
		const read = popover.locator("[data-testid='sidebar-filter-read'] input[type='checkbox']");
		await expect(archived).not.toBeChecked();
		await expect(busy).toBeChecked();
		await expect(read).toBeChecked();

		await archived.click();
		await busy.click();
		await read.click();
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-archived"))).toBe("true");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-busy"))).toBe("false");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("false");

		await page.reload();
		await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 15_000 });
		const persisted = await openPopover(page);
		await expect(persisted.locator("[data-testid='sidebar-filter-archived'] input")).toBeChecked();
		await expect(persisted.locator("[data-testid='sidebar-filter-busy'] input")).not.toBeChecked();
		await expect(persisted.locator("[data-testid='sidebar-filter-read'] input")).not.toBeChecked();

		await page.keyboard.press("Escape");
		await expect.poll(() => page.evaluate(() => document.body.dataset.shortcutsReady)).toBe("1");
		await page.keyboard.press("Alt+Shift+KeyA");
		await page.keyboard.press("Alt+Shift+KeyB");
		await page.keyboard.press("Alt+Shift+KeyR");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-archived"))).toBe("false");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-busy"))).toBe("true");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("true");

		const restored = await openPopover(page);
		await expect(restored.locator("[data-testid='sidebar-filter-archived'] input")).not.toBeChecked();
		await expect(restored.locator("[data-testid='sidebar-filter-busy'] input")).toBeChecked();
		await expect(restored.locator("[data-testid='sidebar-filter-read'] input")).toBeChecked();
	});

	test("Show Read OFF hides read idle sessions but keeps active session", async ({ page }) => {
		const idle = await createSession({ cwd: nonGitCwd() });
		const other = await createSession({ cwd: nonGitCwd() });
		try {
			await apiFetch(`/api/sessions/${idle}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "IdleReadSession" }),
			});
			await apiFetch(`/api/sessions/${other}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "ActiveSession" }),
			});
			await apiFetch(`/api/sessions/${idle}/mark-read`, { method: "POST" });
			await apiFetch(`/api/sessions/${other}/mark-read`, { method: "POST" });

			await openApp(page);
			await resetFilters(page);

			await expect(page.locator(`[data-session-id="${idle}"]`).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(`[data-session-id="${other}"]`).first()).toBeVisible({ timeout: 5_000 });

			await page.locator(`[data-session-id="${other}"]`).first().click();
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

			await expect.poll(() => page.evaluate(() => document.body.dataset.shortcutsReady)).toBe("1");
			await page.keyboard.press("Alt+Shift+KeyR");
			await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("false");

			await expect(page.locator(`[data-session-id="${other}"]`).first()).toBeVisible({ timeout: 5_000 });
			await expect(page.locator(`[data-session-id="${idle}"]`)).toHaveCount(0, { timeout: 5_000 });

			const searchInput = page.locator("input[data-search]");
			await searchInput.fill("IdleRead");
			await expect(page.locator(`[data-session-id="${idle}"]`).first()).toBeVisible({ timeout: 5_000 });
			await searchInput.fill("");
			await expect(page.locator(`[data-session-id="${idle}"]`)).toHaveCount(0, { timeout: 5_000 });

			await page.keyboard.press("Alt+Shift+KeyR");
		} finally {
			await deleteSession(idle).catch(() => {});
			await deleteSession(other).catch(() => {});
		}
	});
});
