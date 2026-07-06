/**
 * Journey: Marketplace Packs — v2 browser smoke
 * Covers: journey-marketplace-packs
 * Consolidated from: artifacts-pack, terminal-pack, pr-walkthrough-pack, etc.
 * Note: the marketplace route is #/market, not #/settings/marketplace.
 */
import { test, expect, openApp } from "../_helpers/journey-fixture.js";

test.describe("Journey: Marketplace Packs", () => {
	test("marketplace route renders", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/market"; });
		await page.waitForFunction(() => window.location.hash.includes("market"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
	});

	test("sidebar is present on marketplace route", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/market"; });
		await page.waitForFunction(() => window.location.hash.includes("market"), null, { timeout: 10_000 });
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("app shell stable across marketplace navigation", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
		await page.evaluate(() => { window.location.hash = "#/market"; });
		await page.waitForFunction(() => window.location.hash.includes("market"), null, { timeout: 10_000 });
		await expect(page.locator("body")).toBeVisible({ timeout: 5_000 });
	});

	test("marketplace page renders pack list or install form", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/market"; });
		await page.waitForFunction(() => window.location.hash.includes("market"), null, { timeout: 10_000 });
		// The marketplace page should show either a pack source list, an install form, or pack cards
		const packContent = page.locator(
			"[data-testid='marketplace-sources'], [data-testid='pack-list'], .pack-card, " +
			"input[placeholder*='source' i], input[placeholder*='url' i], input[placeholder*='pack' i], " +
			"h2, h3"
		).first();
		await expect(packContent).toBeVisible({ timeout: 15_000 });
	});

	test("marketplace shows Installed / Browse / Sources tab buttons", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/market"; });
		await page.waitForFunction(() => window.location.hash.includes("market"), null, { timeout: 10_000 });

		// All three tabs must be present.
		await expect(page.getByTestId("market-tab-installed")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("market-tab-browse")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByTestId("market-tab-sources")).toBeVisible({ timeout: 5_000 });
	});

	test("Sources tab opens the sources panel with an add-source button", async ({ page }) => {
		await openApp(page);
		await page.evaluate(() => { window.location.hash = "#/market"; });
		await page.waitForFunction(() => window.location.hash.includes("market"), null, { timeout: 10_000 });
		await expect(page.getByTestId("market-tab-sources")).toBeVisible({ timeout: 15_000 });

		// Click the Sources tab.
		await page.getByTestId("market-tab-sources").click();

		// The sources panel and the Add-source button must become visible.
		await expect(page.getByTestId("market-sources-panel")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("market-add-source")).toBeVisible({ timeout: 5_000 });
	});
});
