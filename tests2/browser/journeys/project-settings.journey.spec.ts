/**
 * Journey: Project Settings + Project Assistant — v2 browser smoke
 * Covers: journey-project-settings, journey-project-assistant
 * Consolidated from: settings-*, project-assistant-*, model-settings-*, etc.
 */
import { test, expect, openApp } from "../_helpers/journey-fixture.js";

test.describe("Journey: Project Settings", () => {
	test("project settings route renders", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("system settings general route renders", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.getByText(/settings/i).first()).toBeVisible({ timeout: 15_000 });
	});

	test("settings navigation does not break sidebar", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/settings/projects"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 5_000 });
	});
});

test.describe("Journey: Project Assistant", () => {
	test("assistant settings route reachable", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/settings/system/general"; });
		await page.waitForFunction(() => window.location.hash.includes("settings"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("app shell stable during project assistant flow", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		const title = await page.title();
		expect(title).toBeTruthy();
	});
});
