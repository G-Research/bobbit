/**
 * E2E tests for the Sidebar Filters popover.
 *
 * Replaces the legacy "See Archived" button with a Filters dropdown
 * containing three toggles (Archived/Busy/Read) plus their keyboard
 * shortcuts (Alt+Shift+A/B/R).
 *
 * Acceptance criteria covered:
 *   1. Filters button visible; opens popover with three switches.
 *   2. Defaults: Archived OFF, Busy ON, Read ON.
 *   3. Click each toggle → state changes; reload → persists.
 *   4. Keyboard shortcuts toggle each filter.
 *   5. Active session never filtered.
 *   6. Search bypasses Busy/Read/Archived filtering.
 *   7. Clearing search restores filters.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, nonGitCwd, waitForHealth } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

test.describe("Sidebar Filters popover", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("button visible, popover opens with three toggles, defaults correct @smoke", async ({ page }) => {
		await openApp(page);

		// Clear any persisted filter state from a prior test
		await page.evaluate(() => {
			localStorage.removeItem("bobbit-show-archived");
			localStorage.removeItem("bobbit-show-busy");
			localStorage.removeItem("bobbit-show-read");
		});
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		const filtersBtn = page.locator("[data-testid='sidebar-filters-button']").first();
		await expect(filtersBtn).toBeVisible({ timeout: 10_000 });
		await expect(filtersBtn).toHaveText(/Filters/);

		// Popover not open initially
		await expect(page.locator("[data-testid='sidebar-filters-popover']")).toHaveCount(0);

		// Open it
		await filtersBtn.click();
		const popover = page.locator("[data-testid='sidebar-filters-popover']");
		await expect(popover).toBeVisible({ timeout: 5_000 });

		// All three toggle rows present
		const archived = popover.locator("[data-testid='sidebar-filter-archived'] input[type='checkbox']");
		const busy = popover.locator("[data-testid='sidebar-filter-busy'] input[type='checkbox']");
		const read = popover.locator("[data-testid='sidebar-filter-read'] input[type='checkbox']");
		await expect(archived).toBeVisible();
		await expect(busy).toBeVisible();
		await expect(read).toBeVisible();

		// Defaults: archived OFF, busy ON, read ON
		await expect(archived).not.toBeChecked();
		await expect(busy).toBeChecked();
		await expect(read).toBeChecked();
	});

	test("toggles persist across reload", async ({ page }) => {
		await openApp(page);

		// Reset defaults first
		await page.evaluate(() => {
			localStorage.removeItem("bobbit-show-archived");
			localStorage.removeItem("bobbit-show-busy");
			localStorage.removeItem("bobbit-show-read");
		});
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		await page.locator("[data-testid='sidebar-filters-button']").first().click();
		const popover = page.locator("[data-testid='sidebar-filters-popover']");
		await expect(popover).toBeVisible({ timeout: 5_000 });

		// Toggle all three
		await popover.locator("[data-testid='sidebar-filter-archived'] input").click();
		await popover.locator("[data-testid='sidebar-filter-busy'] input").click();
		await popover.locator("[data-testid='sidebar-filter-read'] input").click();

		// Verify localStorage written
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-archived"))).toBe("true");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-busy"))).toBe("false");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("false");

		// Reload — state must persist
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });
		await page.locator("[data-testid='sidebar-filters-button']").first().click();
		const popover2 = page.locator("[data-testid='sidebar-filters-popover']");
		await expect(popover2).toBeVisible({ timeout: 5_000 });
		await expect(popover2.locator("[data-testid='sidebar-filter-archived'] input")).toBeChecked();
		await expect(popover2.locator("[data-testid='sidebar-filter-busy'] input")).not.toBeChecked();
		await expect(popover2.locator("[data-testid='sidebar-filter-read'] input")).not.toBeChecked();

		// Restore defaults so other tests aren't polluted.
		await popover2.locator("[data-testid='sidebar-filter-archived'] input").click();
		await popover2.locator("[data-testid='sidebar-filter-busy'] input").click();
		await popover2.locator("[data-testid='sidebar-filter-read'] input").click();
	});

	test("keyboard shortcuts Alt+Shift+A/B/R toggle each filter", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => {
			localStorage.removeItem("bobbit-show-archived");
			localStorage.removeItem("bobbit-show-busy");
			localStorage.removeItem("bobbit-show-read");
		});
		await page.reload();
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 15_000 });

		// Wait until the shortcut listener is wired up.
		await expect.poll(() =>
			page.evaluate(() => document.body.dataset.shortcutsReady),
		).toBe("1");

		// Alt+Shift+A → archived ON
		await page.keyboard.press("Alt+Shift+KeyA");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-archived"))).toBe("true");

		// Alt+Shift+B → busy OFF (default ON)
		await page.keyboard.press("Alt+Shift+KeyB");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-busy"))).toBe("false");

		// Alt+Shift+R → read OFF
		await page.keyboard.press("Alt+Shift+KeyR");
		await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("false");

		// Confirm popover state mirrors localStorage
		await page.locator("[data-testid='sidebar-filters-button']").first().click();
		const popover = page.locator("[data-testid='sidebar-filters-popover']");
		await expect(popover).toBeVisible({ timeout: 5_000 });
		await expect(popover.locator("[data-testid='sidebar-filter-archived'] input")).toBeChecked();
		await expect(popover.locator("[data-testid='sidebar-filter-busy'] input")).not.toBeChecked();
		await expect(popover.locator("[data-testid='sidebar-filter-read'] input")).not.toBeChecked();

		// Press shortcuts again to restore defaults
		await page.keyboard.press("Escape");
		await page.keyboard.press("Alt+Shift+KeyA");
		await page.keyboard.press("Alt+Shift+KeyB");
		await page.keyboard.press("Alt+Shift+KeyR");
	});

	test("Show Read OFF hides read idle sessions but keeps active session", async ({ page }) => {
		const idle = await createSession({ cwd: nonGitCwd() });
		const other = await createSession({ cwd: nonGitCwd() });
		try {
			// Rename for visibility/assertion
			await apiFetch(`/api/sessions/${idle}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "IdleReadSession" }),
			});
			await apiFetch(`/api/sessions/${other}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "ActiveSession" }),
			});
			// Mark both as read so neither has unread activity.
			await apiFetch(`/api/sessions/${idle}/mark-read`, { method: "POST" });
			await apiFetch(`/api/sessions/${other}/mark-read`, { method: "POST" });

			await openApp(page);
			// Reset filter defaults
			await page.evaluate(() => {
				localStorage.removeItem("bobbit-show-archived");
				localStorage.removeItem("bobbit-show-busy");
				localStorage.removeItem("bobbit-show-read");
			});
			await page.reload();
			await expect(
				page.locator("button").filter({ hasText: "Settings" }).first(),
			).toBeVisible({ timeout: 15_000 });

			// Both sessions visible initially.
			await expect(page.locator(`[data-session-id="${idle}"]`).first()).toBeVisible({ timeout: 10_000 });
			await expect(page.locator(`[data-session-id="${other}"]`).first()).toBeVisible({ timeout: 5_000 });

			// Make the "other" session the active one by clicking it in the sidebar.
			await page.locator(`[data-session-id="${other}"]`).first().click();
			// Wait for the chat textarea to render — proves the session is connected
			// and `activeSessionId()` resolves to `other`.
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });

			// Turn off Show Read.
			await expect.poll(() =>
				page.evaluate(() => document.body.dataset.shortcutsReady),
			).toBe("1");
			await page.keyboard.press("Alt+Shift+KeyR");
			await expect.poll(() => page.evaluate(() => localStorage.getItem("bobbit-show-read"))).toBe("false");

			// Active session must still be visible.
			await expect(page.locator(`[data-session-id="${other}"]`).first()).toBeVisible({ timeout: 5_000 });
			// Idle read session must be hidden.
			await expect(page.locator(`[data-session-id="${idle}"]`)).toHaveCount(0, { timeout: 5_000 });

			// Search bypasses the filter — typing should bring it back.
			const searchInput = page.locator("input[data-search]");
			await searchInput.click();
			await searchInput.fill("IdleRead");
			await expect(page.locator(`[data-session-id="${idle}"]`).first()).toBeVisible({ timeout: 5_000 });

			// Clearing search re-applies the filter.
			await searchInput.fill("");
			await expect(page.locator(`[data-session-id="${idle}"]`)).toHaveCount(0, { timeout: 5_000 });

			// Restore default (Show Read ON)
			await page.keyboard.press("Alt+Shift+KeyR");
		} finally {
			await deleteSession(idle).catch(() => {});
			await deleteSession(other).catch(() => {});
		}
	});
});
