/**
 * E2E — "Open in new window" sidebar action + middle-click shortcut.
 *
 * Covers (per the design-doc gate):
 *   (a) The session row's actions popover shows an "Open in new window" item
 *       (with an icon); clicking it calls window.open(deepLink, "_blank").
 *   (b) Middle-clicking a session row opens that session's deep link in a new
 *       window AND does NOT change the currently active session in-place.
 *
 * window.open is stubbed so the assertions inspect (url, target) rather than
 * relying on a real popup window.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

function sessionRow(page: Page, sessionId: string): Locator {
	return page.locator(`[data-session-id="${sessionId}"]`).first();
}

function triggerFor(row: Locator, sessionId: string): Locator {
	return row.locator(`[data-testid="sidebar-actions-trigger"][data-sidebar-actions-kind="session"][data-sidebar-actions-id="${sessionId}"]`).first();
}

function menuItem(page: Page, actionId: string): Locator {
	return page.locator(`sidebar-actions-popover [role="menuitem"][data-sidebar-action-id="${actionId}"]`).first();
}

async function openMenu(row: Locator, sessionId: string): Promise<void> {
	await expect(row).toBeVisible({ timeout: 10_000 });
	const trigger = triggerFor(row, sessionId);
	await row.hover();
	await expect(trigger, "session hamburger should appear on hover").toBeVisible({ timeout: 5_000 });
	await trigger.click();
	await expect(row.page().locator("sidebar-actions-popover [role='menu']")).toBeVisible({ timeout: 5_000 });
}

async function openSession(page: Page, sessionId: string): Promise<Locator> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
	const row = sessionRow(page, sessionId);
	await expect(row).toBeVisible({ timeout: 10_000 });
	return row;
}

// Replace window.open with a capturing stub. Re-applied per use so a render
// pass can never restore the native implementation between actions.
async function stubWindowOpen(page: Page): Promise<void> {
	await page.evaluate(() => {
		(window as any).__opened = [];
		window.open = ((url?: string | URL, target?: string, features?: string) => {
			(window as any).__opened.push({
				url: url === undefined ? undefined : String(url),
				target: target === undefined ? undefined : String(target),
				features: features === undefined ? undefined : String(features),
			});
			return { opener: null } as any;
		}) as any;
	});
}

function expectedDeepLink(page: Page, sessionId: string): Promise<string> {
	return page.evaluate((id) => `${location.origin}${location.pathname}${location.search}#/session/${id}`, sessionId);
}

test.describe("Open session in new window (UI)", () => {
	const sessionIds: string[] = [];

	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 900 });
	});

	test.afterAll(async () => {
		for (const id of sessionIds.splice(0)) await deleteSession(id).catch(() => {});
	});

	test("actions menu item opens the session deep link in a new window", async ({ page }) => {
		const sessionId = await createSession();
		sessionIds.push(sessionId);
		await waitForSessionStatus(sessionId, "idle");

		const row = await openSession(page, sessionId);
		const deepLink = await expectedDeepLink(page, sessionId);
		await stubWindowOpen(page);

		await openMenu(row, sessionId);
		const item = menuItem(page, "open-new-window");
		await expect(item, "menu shows the Open in new window item").toBeVisible({ timeout: 5_000 });
		await expect(item).toContainText("Open in new window");
		await expect(item.locator("svg").first(), "item renders an icon (ExternalLink)").toBeVisible();

		await item.click();
		await expect(page.locator("sidebar-actions-popover")).toHaveCount(0, { timeout: 5_000 });

		await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual([
			{ url: deepLink, target: "_blank", features: "noopener" },
		]);
	});

	test("middle-click opens the deep link without changing the active session", async ({ page }) => {
		const activeId = await createSession();
		const otherId = await createSession();
		sessionIds.push(activeId, otherId);
		await waitForSessionStatus(activeId, "idle");
		await waitForSessionStatus(otherId, "idle");

		// Open `activeId`, then middle-click the OTHER session's row.
		await openSession(page, activeId);
		const otherRow = sessionRow(page, otherId);
		await expect(otherRow).toBeVisible({ timeout: 10_000 });
		const otherDeepLink = await expectedDeepLink(page, otherId);
		await stubWindowOpen(page);

		// Root cause of the flake: Playwright's real middle-click
		// (`click({ button: "middle" })`) issues a middle mousedown, which Chromium
		// can latch as autoscroll mode; the paired mouseup then cancels autoscroll
		// WITHOUT firing `auxclick`. The row's handler is `@auxclick` gated on
		// `e.button === 1` (src/app/render-helpers.ts), so under that race the
		// handler never runs and `__opened` stays empty until the 15s timeout —
		// the observed run-to-run flake. The product contract is precisely
		// "an auxclick with button===1 opens the deep link in a new window", so we
		// dispatch exactly that event. This exercises the real handler
		// deterministically and removes the synthetic-input autoscroll quirk
		// (the native middle-mousedown is browser behaviour, not Bobbit code).
		await otherRow.scrollIntoViewIfNeeded();
		await expect(otherRow).toBeVisible({ timeout: 10_000 });
		await otherRow.evaluate((el) =>
			el.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })),
		);
		await expect
			.poll(() => page.evaluate(() => (window as any).__opened.length), { timeout: 10_000 })
			.toBeGreaterThan(0);

		// The new window opened to the OTHER session's deep link...
		await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual([
			{ url: otherDeepLink, target: "_blank", features: "noopener" },
		]);
		// ...and the active session did NOT change in-place.
		await expect(page.evaluate(() => window.location.hash)).resolves.toBe(`#/session/${activeId}`);
		await expect(sessionRow(page, activeId)).toHaveAttribute("data-nav-active", "true");
	});
});
