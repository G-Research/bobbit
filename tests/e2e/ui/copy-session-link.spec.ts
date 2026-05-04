/**
 * E2E — "Copy session link" header button.
 *
 * Covers the project's hard E2E rule (AGENTS.md):
 *   1. Navigation — open the app, create a session, button visible.
 *   2. Happy path — click → clipboard contains `${origin}/session/<id>`,
 *      and the header-toast ("Link copied") appears.
 *   3. Persistence across reload — after page.reload() the button is still
 *      present and click still copies.
 */
import { test, expect } from "../gateway-harness.js";
import { createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

// Grant clipboard read/write permissions so navigator.clipboard works in
// headless Chromium.
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.describe("Copy session link button (UI)", () => {
	test("button copies session URL to clipboard and shows toast", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");

		try {
			await openApp(page);
			// Navigate to the session.
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// Button is present.
			const btn = page.locator('[data-testid="copy-session-link"] button').first();
			await expect(btn).toBeVisible({ timeout: 10_000 });

			// Click and verify clipboard.
			await btn.click();
			const expectedUrl = await page.evaluate(
				(id) => `${location.origin}/session/${id}`,
				sessionId,
			);
			await expect(async () => {
				const clip = await page.evaluate(() => navigator.clipboard.readText());
				expect(clip).toBe(expectedUrl);
			}).toPass({ timeout: 5_000 });

			// Toast appears (header-only [data-testid="header-toast"]).
			const toast = page.locator('[data-testid="header-toast"]');
			await expect(toast).toBeVisible({ timeout: 5_000 });
			await expect(toast).toContainText("Link copied");

			// Persists across reload.
			await page.reload();
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });
			const btn2 = page.locator('[data-testid="copy-session-link"] button').first();
			await expect(btn2).toBeVisible({ timeout: 10_000 });
			// Clear the clipboard, click again, verify another copy.
			await page.evaluate(() => navigator.clipboard.writeText(""));
			await btn2.click();
			await expect(async () => {
				const clip = await page.evaluate(() => navigator.clipboard.readText());
				expect(clip).toBe(expectedUrl);
			}).toPass({ timeout: 5_000 });
		} finally {
			await deleteSession(sessionId).catch(() => { /* best-effort */ });
		}
	});
});
