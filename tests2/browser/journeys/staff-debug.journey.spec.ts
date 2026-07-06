/**
 * Journey: Staff + Debug Tools — v2 browser smoke
 * Covers: journey-staff, journey-debug-tools
 * Consolidated from: staff-inbox, debug-panel, api-error-modal, etc.
 */
import { test, expect, openApp } from "../_helpers/journey-fixture.js";

test.describe("Journey: Staff", () => {
	test("settings staff section navigable", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("sidebar remains stable during staff route", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 5_000 });
	});
});

test.describe("Journey: Debug Tools", () => {
	test("app shell loads correctly for debug scenario", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("app title is set", async ({ page }) => {
		await openApp(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
		const title = await page.title();
		expect(title).toBeTruthy();
	});
});
