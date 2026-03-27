import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/setup-wizard-visibility.html")}`;

test.describe("Setup wizard visibility", () => {
	test("banner shows when setupComplete is false and no setup session exists", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Set state: setup not complete, no active setup sessions
		await page.evaluate(() => {
			(window as any).__state.setupComplete = false;
			(window as any).__state.gatewaySessions = [];
			(window as any).__renderAll();
		});

		// Banner should be visible
		await expect(page.locator(".setup-banner")).toBeVisible();
		// Mobile and desktop "Start Setup" should be visible
		await expect(page.locator(".start-setup-mobile")).toBeVisible();
		await expect(page.locator(".start-setup-desktop")).toBeVisible();
	});

	test("banner hidden when setupComplete is true", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Set state: setup complete
		await page.evaluate(() => {
			(window as any).__state.setupComplete = true;
			(window as any).__state.gatewaySessions = [];
			(window as any).__renderAll();
		});

		// Banner should NOT be visible
		await expect(page.locator(".setup-banner")).not.toBeVisible();
		// Mobile and desktop should show the non-setup state
		await expect(page.locator(".no-setup-mobile")).toBeVisible();
		await expect(page.locator(".select-session-desktop")).toBeVisible();
	});

	test("banner hidden when setup wizard session is active", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Set state: setup not complete, but a setup wizard session IS active
		await page.evaluate(() => {
			(window as any).__state.setupComplete = false;
			(window as any).__state.gatewaySessions = [
				{ id: "session-1", assistantType: "setup", createdAt: Date.now() },
			];
			(window as any).__renderAll();
		});

		// BUG: The current code does NOT check for active setup sessions,
		// so the banner and buttons will still show. These assertions will FAIL.
		const banner = page.locator(".setup-banner");
		await expect(banner).not.toBeVisible({
			timeout: 1000,
		}).catch(() => {
			throw new Error("Expected setup banner to be hidden when setup wizard session is active");
		});
	});

	test("mobile empty state hidden when setup wizard session is active", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.evaluate(() => {
			(window as any).__state.setupComplete = false;
			(window as any).__state.gatewaySessions = [
				{ id: "session-1", assistantType: "setup", createdAt: Date.now() },
			];
			(window as any).__renderAll();
		});

		const mobileSetup = page.locator(".start-setup-mobile");
		await expect(mobileSetup).not.toBeVisible({
			timeout: 1000,
		}).catch(() => {
			throw new Error("Expected setup banner to be hidden when setup wizard session is active");
		});
	});

	test("desktop empty state hidden when setup wizard session is active", async ({ page }) => {
		await page.goto(TEST_PAGE);

		await page.evaluate(() => {
			(window as any).__state.setupComplete = false;
			(window as any).__state.gatewaySessions = [
				{ id: "session-1", assistantType: "setup", createdAt: Date.now() },
			];
			(window as any).__renderAll();
		});

		const desktopSetup = page.locator(".start-setup-desktop");
		await expect(desktopSetup).not.toBeVisible({
			timeout: 1000,
		}).catch(() => {
			throw new Error("Expected setup banner to be hidden when setup wizard session is active");
		});
	});

	test("non-setup assistant sessions do not hide the banner", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// A session exists but it's NOT a setup wizard session
		await page.evaluate(() => {
			(window as any).__state.setupComplete = false;
			(window as any).__state.gatewaySessions = [
				{ id: "session-1", assistantType: "goal", createdAt: Date.now() },
				{ id: "session-2", assistantType: undefined, createdAt: Date.now() },
			];
			(window as any).__renderAll();
		});

		// Banner should still show because no setup-type session exists
		await expect(page.locator(".setup-banner")).toBeVisible();
		await expect(page.locator(".start-setup-mobile")).toBeVisible();
		await expect(page.locator(".start-setup-desktop")).toBeVisible();
	});
});
