/**
 * Journey: Marketplace Packs — v2 browser smoke
 * Covers: journey-marketplace-packs
 * Consolidated from: artifacts-pack, terminal-pack, pr-walkthrough-pack, etc.
 * Note: the marketplace route is #/market, not #/settings/marketplace.
 */
import { test, expect, navigateToHash, openApp } from "../_helpers/journey-fixture.js";

async function openMarketplace(page: import("@playwright/test").Page): Promise<void> {
	await openApp(page);
	await navigateToHash(page, "#/market");
}

test.describe("Journey: Marketplace Packs", () => {
	test("marketplace route renders", async ({ page }) => {
		await openMarketplace(page);
		await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
	});

	test("sidebar is present on marketplace route", async ({ page }) => {
		await openMarketplace(page);
		await expect(page.locator(".sidebar-edge").first()).toBeVisible({ timeout: 15_000 });
	});

	test("app shell stable across marketplace navigation", async ({ page }) => {
		await openApp(page);
		await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15_000 });
		await navigateToHash(page, "#/market");
		await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15_000 });
	});

	test("marketplace page renders pack list or install form", async ({ page }) => {
		await openMarketplace(page);
		// The marketplace page should show either a pack source list, an install form, or pack cards
		const packContent = page.locator(
			"[data-testid='marketplace-sources'], [data-testid='pack-list'], .pack-card, " +
			"input[placeholder*='source' i], input[placeholder*='url' i], input[placeholder*='pack' i], " +
			"h2, h3"
		).first();
		await expect(packContent).toBeVisible({ timeout: 15_000 });
	});

	test("marketplace shows Installed / Browse / Sources tab buttons", async ({ page }) => {
		await openMarketplace(page);

		// All three tabs must be present.
		await expect(page.getByTestId("market-tab-installed")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("market-tab-browse")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("market-tab-sources")).toBeVisible({ timeout: 15_000 });
	});

	test("Sources tab opens the sources panel with an add-source button", async ({ page }) => {
		await openMarketplace(page);
		await expect(page.getByTestId("market-tab-sources")).toBeVisible({ timeout: 15_000 });

		// Click the Sources tab.
		await page.getByTestId("market-tab-sources").click();

		// The sources panel and the Add-source button must become visible.
		await expect(page.getByTestId("market-sources-panel")).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId("market-add-source")).toBeVisible({ timeout: 15_000 });
	});

	// Ported from marketplace.spec.ts (audit: marketplace-packs PARTIAL): the
	// Market page must render the Research Preview banner.
	test("marketplace renders the research-preview banner", async ({ page }) => {
		await openMarketplace(page);
		await expect(page.getByTestId("market-research-preview-banner")).toBeVisible({ timeout: 20_000 });
	});

	test("projectless Market keeps server onboarding reachable", async ({ page }) => {
		// A fresh gateway may have no visible projects yet. Keep the project list
		// empty while preserving the real Market client and server-scoped APIs.
		await page.route(/\/api\/projects(?:\?.*)?$/, async (route) => {
			if (route.request().method() === "GET") {
				await route.fulfill({ json: [] });
				return;
			}
			await route.fallback();
		});
		await page.route("**/api/marketplace/sources**", route => route.fulfill({ json: { sources: [] } }));
		await page.route("**/api/marketplace/browse**", route => route.fulfill({ json: { sources: [], packs: [] } }));

		await openMarketplace(page);
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/market");
		await expect(page.getByTestId("market-no-project-context")).toHaveText("No visible projects");
		await expect(page.getByTestId("market-project-runtime-empty")).toContainText("No project selected");

		// With no canonical project route to write, tabs still switch locally and
		// Browse retains its server install scope while Sources remains operable.
		await page.getByTestId("market-tab-browse").click();
		await expect(page.getByTestId("market-browse-panel")).toBeVisible();
		await expect(page.getByTestId("market-install-scope")).toHaveValue("server");
		await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#/market");
		await page.getByTestId("market-tab-sources").click();
		await expect(page.getByTestId("market-sources-panel")).toBeVisible();
		await expect(page.getByTestId("market-add-source")).toBeVisible();
	});
});

// Ported from market-activation.spec.ts (audit: marketplace-packs GAP): the
// Installed tab opens the installed-panel.
test.describe("Journey: Marketplace Installed Panel", () => {
	test("Installed tab opens the installed-panel", async ({ page }) => {
		await openMarketplace(page);
		const tab = page.getByTestId("market-tab-installed");
		await expect(tab).toBeVisible({ timeout: 20_000 });
		await tab.click();
		await expect(page.getByTestId("market-installed-panel")).toBeVisible({ timeout: 15_000 });
	});
});
