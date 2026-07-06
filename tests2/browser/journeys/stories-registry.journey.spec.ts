/**
 * Journey: Stories Registry + Headquarters — v2 browser smoke
 * Covers: journey-stories-registry, journey-headquarters
 * Consolidated from: stories-navigation, stories-resilience, headquarters, etc.
 */
import { test, expect, openApp } from "../_helpers/journey-fixture.js";

test.describe("Journey: Stories Registry", () => {
	test("stories route renders without error", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/stories"; });
		await page.waitForFunction(() => window.location.hash.includes("stories"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("sidebar visible on stories route", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/stories"; });
		await page.waitForFunction(() => window.location.hash.includes("stories"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Journey: Headquarters", () => {
	test("headquarters route navigable", async ({ page }) => {
		await openApp(page);
		// Headquarters is usually accessible at /settings or a dedicated hash
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("app shell stable on headquarters/settings route", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 5_000 });
	});
});
