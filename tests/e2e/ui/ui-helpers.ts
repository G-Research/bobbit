/**
 * Shared page-object helpers for browser-based E2E tests.
 *
 * All helpers use Playwright's built-in waiting (locator assertions,
 * expect().toBeVisible()). No fixed-duration setTimeout sleeps.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { readE2EToken, base, apiFetch, waitForSessionStatus } from "../e2e-setup.js";

/**
 * Open the app authenticated via token query param.
 * Waits for the sidebar "New session" button to confirm the app has loaded.
 */
export async function openApp(page: Page): Promise<void> {
	const token = readE2EToken();
	const baseUrl = base();
	await page.goto(`${baseUrl}/?token=${encodeURIComponent(token)}`);
	// Wait for sidebar to be fully loaded — Settings button is always present
	// regardless of single-project or multi-project mode
	await expect(
		page.locator("button").filter({ hasText: "Settings" }).first(),
	).toBeVisible({ timeout: 20_000 });
}

/**
 * Click "New session" button in the sidebar and wait for the chat textarea.
 */
export async function createSessionViaUI(page: Page): Promise<void> {
	// In multi-project mode the button title is "New session in <project>"
	await page.locator("button[title^='New session']").first().click();
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
}

/**
 * Type a message in the textarea and press Enter to send it.
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
	const textarea = page.locator("textarea").first();
	await textarea.fill(text);
	await textarea.press("Enter");
}

/**
 * Wait for an assistant response to appear in the chat.
 * If opts.text is provided, waits for that specific text; otherwise waits for "OK".
 */
export async function waitForAgentResponse(
	page: Page,
	opts?: { text?: string; timeout?: number },
): Promise<void> {
	const timeout = opts?.timeout ?? 15_000;
	const text = opts?.text ?? "OK";
	await expect(
		page.getByText(text, { exact: text === "OK" }).first(),
	).toBeVisible({ timeout });
}

/**
 * Navigate to a hash route by setting window.location.hash.
 * Uses Playwright's waitForFunction to confirm the hash change took effect.
 */
export async function navigateToHash(page: Page, hash: string): Promise<void> {
	// Retry hash assignment + check up to 3 times; under heavy parallel load
	// Chromium can drop or delay the assignment, and the subsequent
	// waitForFunction just polls the stale value. Reassigning resets the
	// polling baseline and reliably lands.
	//
	// Accept "contains" rather than strict equality because the app's router
	// may normalize the hash (e.g. append a trailing slash, strip query
	// params). `contains` is enough to prove the navigation happened —
	// tests that care about the exact form use `url_equals` separately.
	for (let attempt = 0; attempt < 3; attempt++) {
		await page.evaluate((h) => { window.location.hash = h; }, hash);
		try {
			await page.waitForFunction(
				(h) => window.location.hash.startsWith(h),
				hash,
				{ timeout: attempt === 2 ? 10_000 : 3_000 },
			);
			return;
		} catch (err) {
			if (attempt === 2) throw err;
			// brief pause before retry
			await page.waitForTimeout(100);
		}
	}
}

/**
 * Navigate to the goal dashboard for a specific goal.
 * The route format is #/goal/<goalId>.
 */
export async function navigateToGoalDashboard(page: Page, goalId: string): Promise<void> {
	await navigateToHash(page, `#/goal/${goalId}`);
	// Wait for goal dashboard content to appear (tab bar is always present)
	await expect(page.locator(".tab").first()).toBeVisible({ timeout: 10_000 });
}

/**
 * Click a sidebar entry by its text label.
 */
export async function clickSidebarItem(page: Page, label: string): Promise<void> {
	await page.getByText(label).first().click();
}

/**
 * Return visible session entry texts from the sidebar.
 * Sessions are rendered as clickable rows — we grab their truncated title spans.
 */
export async function getVisibleSessions(page: Page): Promise<string[]> {
	// Session rows contain a .truncate span with the session title
	const items = page.locator(".sidebar-session-active, [class*='cursor-pointer']").locator(".truncate");
	const count = await items.count();
	const texts: string[] = [];
	for (let i = 0; i < count; i++) {
		const t = await items.nth(i).textContent();
		if (t) texts.push(t.trim());
	}
	return texts;
}

/**
 * Wait for a session to reach idle status via the API.
 * Delegates to the polling helper in e2e-setup.
 */
export async function waitForSessionIdle(sessionId: string): Promise<void> {
	await waitForSessionStatus(sessionId, "idle");
}
