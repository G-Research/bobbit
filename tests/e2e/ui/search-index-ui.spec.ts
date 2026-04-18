/**
 * E2E: Settings \u2192 Maintenance \u2192 Search Index panel + status dot.
 *
 * These tests use `page.route` to mock the T11 REST endpoints and inject
 * synthetic `index:*` events via `window.dispatchEvent(CustomEvent)`, so they
 * pass regardless of whether T11 has merged.  Once T11 lands, the same specs
 * still exercise the UI \u2014 the mocks just become unused.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

async function mockSearchApis(page: import("@playwright/test").Page, stats: {
	lastRebuildAt?: number | null;
	rowCountsBySource?: Record<string, number>;
	datasetBytes?: number;
	embedderId?: string;
	embedderDim?: number;
	state?: string;
} = {}) {
	await page.route("**/api/search/stats*", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				lastRebuildAt: stats.lastRebuildAt ?? Date.now() - 60_000,
				rowCountsBySource: stats.rowCountsBySource ?? { goals: 3, sessions: 5, messages: 42, staff: 1 },
				datasetBytes: stats.datasetBytes ?? 12345678,
				embedderId: stats.embedderId ?? "nomic-embed-text-v1.5",
				embedderDim: stats.embedderDim ?? 768,
				state: stats.state ?? "ready",
			}),
		});
	});
	await page.route("**/api/search/rebuild", async (route) => {
		await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ queued: true }) });
	});
	await page.route("**/api/search/compact", async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
	});
	await page.route("**/api/maintenance/orphaned-index-rows*", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ count: 0, sample: [] }),
		});
	});
	await page.route("**/api/maintenance/cleanup-index-rows", async (route) => {
		await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ deleted: 0 }) });
	});
	// Auto-accept confirm dialogs.
	page.on("dialog", (d) => { void d.accept(); });
}

test.describe("Search Index maintenance panel", () => {
	test("renders stats and section headings", async ({ page }) => {
		await mockSearchApis(page);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.getByRole("heading", { name: "Search Index" })).toBeVisible({ timeout: 10_000 });
		await expect(page.getByRole("heading", { name: "Orphaned Index Rows" })).toBeVisible();
		// Stats rendered
		await expect(page.locator("[data-search-state]")).toHaveAttribute("data-search-state", "ready");
		await expect(page.getByText("nomic-embed-text-v1.5 (768)")).toBeVisible();
		// Row count chips
		await expect(page.getByText("goals: 3")).toBeVisible();
		// Buttons
		await expect(page.getByRole("button", { name: "Rebuild Index" })).toBeEnabled();
		await expect(page.getByRole("button", { name: "Compact Dataset" })).toBeEnabled();
	});

	test("Rebuild Index triggers yellow progress UI then green on complete", async ({ page }) => {
		await mockSearchApis(page);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");
		await expect(page.getByRole("heading", { name: "Search Index" })).toBeVisible({ timeout: 10_000 });

		const rebuildResp = page.waitForResponse(r => r.url().includes("/api/search/rebuild") && r.request().method() === "POST");
		await page.getByRole("button", { name: "Rebuild Index" }).click();
		await rebuildResp;

		// Optimistic yellow pill appears (dot inside the Search Index card, at minimum).
		await expect(page.locator('[data-status-dot="yellow"]').first()).toBeVisible({ timeout: 5_000 });

		// Push a WS-style progress event \u2192 progress bar appears.
		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("bobbit-index-event", {
				detail: { type: "index:progress", projectId: "", phase: "rebuild", total: 100, completed: 40, backlog: 0 },
			}));
		});
		await expect(page.locator("[data-search-progress]")).toBeVisible();
		await expect(page.locator("[data-search-progress]")).toContainText("40 / 100");

		// Completion \u2192 pill disappears.
		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("bobbit-index-event", {
				detail: { type: "index:complete", projectId: "", phase: "rebuild", durationMs: 1000, rowsWritten: 100 },
			}));
		});
		await expect(page.locator('[data-status-dot="yellow"]')).toHaveCount(0, { timeout: 5_000 });
	});

	test("index:error shows red pill with Retry that recovers", async ({ page }) => {
		await mockSearchApis(page);
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");
		await expect(page.getByRole("heading", { name: "Search Index" })).toBeVisible({ timeout: 10_000 });

		await page.evaluate(() => {
			window.dispatchEvent(new CustomEvent("bobbit-index-event", {
				detail: { type: "index:error", projectId: "", message: "embedding model download failed", recoverable: true },
			}));
		});

		const redPill = page.locator('[data-status-dot="red"]').first();
		await expect(redPill).toBeVisible();
		await expect(redPill).toContainText("Search unavailable");
		await expect(page.locator("[data-search-error]")).toContainText("embedding model download failed");

		const rebuildResp = page.waitForResponse(r => r.url().includes("/api/search/rebuild"));
		await redPill.locator("[data-status-dot-retry]").click();
		await rebuildResp;

		// Retry triggers rebuild \u2192 pill transitions to yellow via optimistic event.
		await expect(page.locator('[data-status-dot="yellow"]').first()).toBeVisible({ timeout: 5_000 });
	});

	test("Orphan Index Rows scan/cleanup buttons work", async ({ page }) => {
		await mockSearchApis(page);
		// Override the scan mock to return 2 rows.  Registered AFTER mockSearchApis
		// so that Playwright's LIFO handler order gives this one priority.
		await page.route("**/api/maintenance/orphaned-index-rows*", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					count: 2,
					sample: [
						{ id: "message:abc:1", source_id: "messages", parent_id: null },
						{ id: "goal:xyz", source_id: "goals", parent_id: null },
					],
				}),
			});
		});
		await openApp(page);
		await navigateToHash(page, "#/settings/system/maintenance");

		await expect(page.getByRole("heading", { name: "Orphaned Index Rows" })).toBeVisible({ timeout: 10_000 });

		const cleanupBtn = page.locator('[data-action="cleanup-orphan-index-rows"]');
		await expect(cleanupBtn).toBeDisabled();

		const scanResp = page.waitForResponse(r => r.url().includes("/api/maintenance/orphaned-index-rows"));
		await page.locator('[data-action="scan-orphan-index-rows"]').click();
		await scanResp;

		await expect(page.getByText("2 orphaned rows.")).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText("message:abc:1")).toBeVisible();
		await expect(cleanupBtn).toBeEnabled();
	});
});
