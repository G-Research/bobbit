/**
 * Journey: Sidebar Navigation — v2 browser smoke
 */
import { test, expect, openApp, navigateToHash, createSession, deleteSession, waitForSessionStatus } from "../_helpers/journey-fixture.js";

test.describe("Journey: Sidebar Navigation", () => {
	test("sidebar and new-session button visible on load", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("button", { name: /new session/i }).first()).toBeVisible({ timeout: 5_000 });
	});

	test("settings hash route renders settings text", async ({ page }) => {
		await openApp(page);
		await navigateToHash(page, "#/settings/system/general");
		await page.waitForFunction(() => window.location.hash.includes("/settings"), null, { timeout: 10_000 });
		await expect(page.getByText("Settings").first()).toBeVisible({ timeout: 15_000 });
	});

	test("session row visible in sidebar after creation", async ({ page }) => {
		const sessionId = await createSession();
		await waitForSessionStatus(sessionId, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(`[data-session-id="${sessionId}"]`).first()).toBeVisible({ timeout: 10_000 });
		} finally {
			await deleteSession(sessionId);
		}
	});

	test("switch between two sessions updates URL", async ({ page }) => {
		const s1 = await createSession();
		const s2 = await createSession();
		await waitForSessionStatus(s1, "idle");
		await waitForSessionStatus(s2, "idle");
		try {
			await openApp(page);
			await navigateToHash(page, `#/session/${s1}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			expect(await page.evaluate(() => window.location.hash)).toContain(s1);
			await navigateToHash(page, `#/session/${s2}`);
			await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 15_000 });
			expect(await page.evaluate(() => window.location.hash)).toContain(s2);
		} finally {
			await deleteSession(s1);
			await deleteSession(s2);
		}
	});
});
