import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/search-preview-maintenance-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "search-preview-maintenance-bundle.js");
const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const API_SRC = path.resolve("src/app/api.ts");
const SEARCH_DOT_SRC = path.resolve("src/app/components/search-status-dot.ts");

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__maintenanceFixtureReady === true, null, { timeout: 10_000 });
}

async function setupMaintenance(page: Page, opts: Record<string, unknown> = {}): Promise<void> {
	await page.evaluate((fixtureOpts) => (window as any).__setMaintenanceFixture(fixtureOpts), opts);
	await expect(page.getByRole("heading", { name: "Orphaned Worktrees" })).toBeVisible({ timeout: 10_000 });
}

async function maintenanceFetchLog(page: Page): Promise<Array<{ url: string; method: string; body: unknown }>> {
	return await page.evaluate(() => (window as any).__getMaintenanceFetchLog());
}

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, SETTINGS_SRC, API_SRC, SEARCH_DOT_SRC],
	});
});

test.describe("Maintenance tab fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders maintenance sections with actions disabled before scan", async ({ page }) => {
		await setupMaintenance(page);

		await expect(page.getByText("Orphaned Sessions")).toBeVisible();
		await expect(page.getByText("Expired Archives")).toBeVisible();
		await expect(page).toHaveURL(/#\/settings\/system\/maintenance/);
		await expect(page.getByRole("button", { name: /Clean Up/ })).toBeDisabled();
		await expect(page.getByRole("button", { name: /Terminate/ })).toBeDisabled();
		await expect(page.getByRole("button", { name: /Purge/ })).toBeDisabled();
	});

	test("scan buttons call APIs and render empty results", async ({ page }) => {
		await setupMaintenance(page);

		await page.getByRole("button", { name: "Scan" }).nth(0).click();
		await expect(page.getByText(/No orphaned worktrees found/)).toBeVisible({ timeout: 5_000 });

		await page.getByRole("button", { name: "Scan" }).nth(1).click();
		await expect(page.getByText(/No orphaned sessions found/)).toBeVisible({ timeout: 5_000 });

		await page.getByRole("button", { name: "Scan" }).nth(2).click();
		await expect(page.getByText(/No expired archives found/)).toBeVisible({ timeout: 5_000 });

		await expect.poll(async () => (await maintenanceFetchLog(page)).map(e => e.url)).toEqual(expect.arrayContaining([
			"/api/maintenance/orphaned-worktrees",
			"/api/maintenance/orphaned-sessions",
			"/api/maintenance/expired-archives",
		]));
	});

	test("cleanup actions POST and then rescan", async ({ page }) => {
		await setupMaintenance(page, {
			worktrees: [{ path: "C:/tmp/orphan", branch: "session/orphan" }],
			sessions: [{ id: "12345678-aaaa-bbbb-cccc-123456789abc", title: "Verifier orphan" }],
			archives: { count: 1, totalSizeBytes: 2048 },
		});

		await page.getByRole("button", { name: "Scan" }).nth(0).click();
		const cleanUp = page.getByRole("button", { name: /Clean Up \(1\)/ });
		await expect(cleanUp).toBeEnabled({ timeout: 5_000 });
		await cleanUp.click();
		await expect(page.getByText(/No orphaned worktrees found/)).toBeVisible({ timeout: 5_000 });

		await page.getByRole("button", { name: "Scan" }).nth(1).click();
		const terminate = page.getByRole("button", { name: /Terminate \(1\)/ });
		await expect(terminate).toBeEnabled({ timeout: 5_000 });
		await terminate.click();
		await expect(page.getByText(/No orphaned sessions found/)).toBeVisible({ timeout: 5_000 });

		await page.getByRole("button", { name: "Scan" }).nth(2).click();
		const purge = page.getByRole("button", { name: /Purge \(1\)/ });
		await expect(purge).toBeEnabled({ timeout: 5_000 });
		await purge.click();
		await expect(page.getByText(/No expired archives found/)).toBeVisible({ timeout: 5_000 });

		await expect.poll(async () => (await maintenanceFetchLog(page)).map(e => `${e.method} ${e.url}`)).toEqual(expect.arrayContaining([
			"POST /api/maintenance/cleanup-worktrees",
			"POST /api/maintenance/cleanup-sessions",
			"POST /api/maintenance/purge-archives",
		]));
	});

	test("worktree scan state persists when switching tabs and back", async ({ page }) => {
		await setupMaintenance(page);

		await page.getByRole("button", { name: "Scan" }).nth(0).click();
		await expect(page.getByText(/No orphaned worktrees found/)).toBeVisible({ timeout: 5_000 });

		await page.locator("button").filter({ hasText: "General" }).first().click();
		await expect(page.getByText("Show message timestamps")).toBeVisible({ timeout: 5_000 });

		await page.locator("button").filter({ hasText: "Maintenance" }).first().click();
		await expect(page.getByRole("heading", { name: "Orphaned Worktrees" })).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText(/No orphaned worktrees found/)).toBeVisible({ timeout: 5_000 });
	});
});
