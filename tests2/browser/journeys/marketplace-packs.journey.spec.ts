/**
 * Journey: Marketplace Packs — v2 browser smoke
 * Covers: journey-marketplace-packs
 * Consolidated from: artifacts-pack, terminal-pack, pr-walkthrough-pack, etc.
 */
import { test, expect, openApp } from "../_helpers/journey-fixture.js";

test.describe("Journey: Marketplace Packs", () => {
	test("marketplace settings route renders", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/marketplace"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("sidebar is present on marketplace route", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/marketplace"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("app shell stable across settings navigation", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/marketplace"; });
		await page.waitForFunction(() => window.location.hash.includes("marketplace"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 5_000 });
	});
});
