import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "../fixtures/build-bundle.js";

const SHELL = path.resolve("tests/ui-fixtures/fixture-shell.html");
const ENTRY = path.resolve("tests/ui-fixtures/search-index-ui-entry.ts");
const BUNDLE_DIR = path.resolve(".bobbit/tmp/ui-fixtures");
const BUNDLE = path.join(BUNDLE_DIR, "search-index-ui-bundle.js");
const SETTINGS_SRC = path.resolve("src/app/settings-page.ts");
const SEARCH_DOT_SRC = path.resolve("src/app/components/search-status-dot.ts");
const API_SRC = path.resolve("src/app/api.ts");

test.beforeAll(() => {
	fs.mkdirSync(BUNDLE_DIR, { recursive: true });
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, SETTINGS_SRC, SEARCH_DOT_SRC, API_SRC],
	});
});

async function loadFixture(page: Page): Promise<void> {
	await page.goto(`file://${SHELL.replace(/\\/g, "/")}`);
	await page.addScriptTag({ path: BUNDLE });
	await page.waitForFunction(() => (window as any).__searchIndexReady === true, null, { timeout: 10_000 });
}

async function setupSearch(page: Page, opts: Record<string, unknown> = {}): Promise<void> {
	await page.evaluate((fixtureOpts) => (window as any).__setSearchFixture(fixtureOpts), opts);
	await expect(page.getByRole("heading", { name: "Search Index" })).toBeVisible({ timeout: 10_000 });
}

async function searchFetchLog(page: Page): Promise<Array<{ url: string; method: string; body: any }>> {
	return await page.evaluate(() => (window as any).__getSearchFetchLog());
}

test.describe("Search Index maintenance panel fixture", () => {
	test.beforeEach(async ({ page }) => {
		await loadFixture(page);
	});

	test("renders stats and section headings", async ({ page }) => {
		await setupSearch(page);

		await expect(page.getByRole("heading", { name: "Orphaned Index Rows" })).toBeVisible();
		await expect(page.locator("[data-search-state]")).toHaveAttribute("data-search-state", "ready");
		await expect(page.getByText("flexsearch (0.8.158)")).toBeVisible();
		await expect(page.getByText("goals: 3")).toBeVisible();
		await expect(page.getByRole("button", { name: "Rebuild Index" })).toBeEnabled();
		await expect(page.getByRole("button", { name: "Compact Dataset" })).toHaveCount(0);
	});

	test("Rebuild Index triggers yellow progress UI then green on complete", async ({ page }) => {
		await setupSearch(page);

		await page.getByRole("button", { name: "Rebuild Index" }).click();
		await expect.poll(async () =>
			(await searchFetchLog(page)).some(e => e.url === "/api/search/rebuild" && e.method === "POST"),
		).toBe(true);

		await expect(page.locator('[data-status-dot="yellow"]').first()).toBeVisible({ timeout: 5_000 });

		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("bobbit-index-event", {
				detail: { type: "index:progress", projectId: "", phase: "rebuild", total: 100, completed: 40, backlog: 0 },
			}));
		});
		await expect(page.locator("[data-search-progress]")).toBeVisible();
		await expect(page.locator("[data-search-progress]")).toContainText("40 / 100");

		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("bobbit-index-event", {
				detail: { type: "index:complete", projectId: "", phase: "rebuild", durationMs: 1000, rowsWritten: 100 },
			}));
		});
		await expect(page.locator('[data-status-dot="yellow"]')).toHaveCount(0, { timeout: 5_000 });
	});

	test("index:error shows red pill with Retry that recovers", async ({ page }) => {
		await setupSearch(page);

		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("bobbit-index-event", {
				detail: { type: "index:error", projectId: "", message: "embedding model download failed", recoverable: true },
			}));
		});

		const redPill = page.locator('[data-status-dot="red"]').first();
		await expect(redPill).toBeVisible();
		await expect(redPill).toContainText("Search unavailable");
		await expect(page.locator("[data-search-error]")).toContainText("embedding model download failed");

		await redPill.locator("[data-status-dot-retry]").click();
		await expect.poll(async () =>
			(await searchFetchLog(page)).some(e => e.url === "/api/search/rebuild" && e.method === "POST"),
		).toBe(true);
		await expect(page.locator('[data-status-dot="yellow"]').first()).toBeVisible({ timeout: 5_000 });
	});

	test("Orphan Index Rows scan/cleanup buttons work", async ({ page }) => {
		await setupSearch(page, {
			orphanRows: {
				count: 2,
				sample: [
					{ id: "message:abc:1", source_id: "messages", parent_id: null },
					{ id: "goal:xyz", source_id: "goals", parent_id: null },
				],
			},
		});

		const cleanupBtn = page.locator('[data-action="cleanup-orphan-index-rows"]');
		await expect(cleanupBtn).toBeDisabled();

		await page.locator('[data-action="scan-orphan-index-rows"]').click();
		await expect.poll(async () =>
			(await searchFetchLog(page)).some(e => e.url.startsWith("/api/maintenance/orphaned-index-rows")),
		).toBe(true);

		await expect(page.getByText("2 orphaned rows.")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("message:abc:1")).toBeVisible();
		await expect(cleanupBtn).toBeEnabled();
	});
});
