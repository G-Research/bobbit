/**
 * Shared page-object helpers for UI E2E tests.
 * STUB — will be replaced by Coder 1's full implementation.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { readE2EToken, apiFetch, waitForSessionStatus } from "../e2e-setup.js";

/** Open the app authenticated via token query param, wait for sidebar. */
export async function openApp(page: Page): Promise<void> {
	const token = readE2EToken();
	const base = `http://127.0.0.1:${process.env.E2E_PORT}`;
	await page.goto(`${base}/?token=${encodeURIComponent(token)}`);
	// Wait for any "New session" button (exact or per-project variant)
	await expect(
		page.locator("button[title^='New session']").first(),
	).toBeVisible({ timeout: 15_000 });
}

/** Click "New session" button, wait for textarea. */
export async function createSessionViaUI(page: Page): Promise<void> {
	await page.locator("button[title='New session']").first().click();
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
}

/** Fill textarea, press Enter, wait for assistant response. */
export async function sendMessage(page: Page, text: string): Promise<void> {
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await textarea.fill(text);
	await textarea.press("Enter");
}

/** Wait for an assistant message to appear. If opts.text provided, wait for that text. */
export async function waitForAgentResponse(
	page: Page,
	opts?: { text?: string; timeout?: number },
): Promise<void> {
	const timeout = opts?.timeout ?? 15_000;
	if (opts?.text) {
		await expect(page.getByText(opts.text).first()).toBeVisible({ timeout });
	} else {
		await expect(page.getByText("OK", { exact: true }).first()).toBeVisible({ timeout });
	}
}

/** Navigate by setting window.location.hash. */
export async function navigateToHash(page: Page, hash: string): Promise<void> {
	await page.evaluate((h) => { window.location.hash = h; }, hash);
	// Brief wait for view transition
	await page.waitForTimeout(300);
}

/** Navigate to goal dashboard and wait for content. */
export async function navigateToGoalDashboard(page: Page, goalId: string): Promise<void> {
	await navigateToHash(page, `#/goal-dashboard/${goalId}`);
	// Wait for dashboard to render
	await page.waitForTimeout(500);
}

/** Click a sidebar entry by text content. */
export async function clickSidebarItem(page: Page, label: string): Promise<void> {
	await page.getByText(label).first().click();
}

/** Return visible session names in the sidebar. */
export async function getVisibleSessions(page: Page): Promise<string[]> {
	const entries = page.locator(".sidebar-session-entry, [class*='session']");
	const texts: string[] = [];
	const count = await entries.count();
	for (let i = 0; i < count; i++) {
		const text = await entries.nth(i).textContent();
		if (text) texts.push(text.trim());
	}
	return texts;
}

/** Wait for a session to reach idle status via API polling. */
export async function waitForSessionIdle(sessionId: string): Promise<void> {
	await waitForSessionStatus(sessionId, "idle");
}
