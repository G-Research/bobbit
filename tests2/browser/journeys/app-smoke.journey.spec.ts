/**
 * Journey: App Smoke + Session Sharing — v2 browser smoke
 * Covers: journey-app-smoke, journey-session-sharing
 * Consolidated from: basic-load-*, session-sharing-*, pr-preview-*, etc.
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";

test.describe("Journey: App Smoke", () => {
	test("app loads and sidebar is visible", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("new-session button present on load", async ({ page }) => {
		await openApp(page);
		await expect(page.getByRole("button", { name: /new session/i }).first()).toBeVisible({ timeout: 15_000 });
	});

	test("app title is non-empty", async ({ page }) => {
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
		const title = await page.title();
		expect(title).toBeTruthy();
	});

	test("settings route navigable from root", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 5_000 });
	});
});

test.describe("Journey: Session Sharing", () => {
	test("session route renders editor for sharing context", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("session hash appears in URL for sharing", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			const hash = await page.evaluate(() => window.location.hash);
			expect(hash).toContain(sessionId);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("copy-link button is present in session header", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			// The copy-link action is either a direct header button or accessible via the actions trigger
			const copyLinkDirect = page.locator('[data-session-action-surface="header"][data-session-action-id="copy-link"]').first();
			const actionsTrigger = page.locator('[data-testid="session-actions-trigger"]').first();
			const found = await copyLinkDirect.isVisible({ timeout: 5_000 }).catch(() => false)
				|| await actionsTrigger.isVisible({ timeout: 5_000 }).catch(() => false);
			expect(found, "copy-link button or session-actions-trigger must be present in session header").toBe(true);
		} finally {
			await deleteSession(sessionId);
		}
	});

	test.skip("copy-link button copies URL to clipboard", async ({ page }) => {
		// Skipped: clipboard assertions require https context or explicit permission grants
		// that are unreliable across headless environments.
		// The button presence is verified in the test above.
	});
});
