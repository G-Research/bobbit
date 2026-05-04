/**
 * WP-E URL-shape regression: when the unified preview panel renders the
 * Preview tab, its iframe `src` must point at the per-session content
 * mount with the correct `#mtime=<n>` cache-buster.
 *
 * This test is intentionally minimal — full asset-loading coverage lives
 * in WP-H. We just validate that the Preview tab now produces a
 * `/preview/<sid>/<entry>#mtime=<n>` iframe and not the legacy
 * `/api/preview/render` (file mode) or `srcdoc=` (inline mode) shapes.
 */
import { test, expect } from "./fixtures.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

test.describe("Preview panel iframe URL (WP-E)", () => {
	test("iframe src is /preview/<sid>/<entry>#mtime=<n>", async ({ page }) => {
		await openApp(page);
		const sessionId = await createSessionViaUI(page);

		// Drive the unified preview panel into the Preview tab via the public
		// state handle exposed on window (`bobbitState` / `__bobbitState`).
		// We're validating URL-shape, not the SSE bootstrap path — that lives
		// in WP-H.
		await page.evaluate(() => {
			const w = window as any;
			const state = w.bobbitState ?? w.__bobbitState;
			if (!state) throw new Error("bobbitState not exposed on window");
			state.isPreviewSession = true;
			state.previewPanelActiveTab = "preview";
			state.previewPanelEntry = "report.html";
			state.previewPanelMtime = 1234567890;
			// Trigger a render by dispatching a hashchange or mutating a
			// dummy field; rely on the next animation frame in case the
			// app uses microtask-batched rendering.
			document.dispatchEvent(new Event("visibilitychange"));
			w.dispatchEvent?.(new Event("resize"));
		});

		// Force a render via the global render hook if available.
		await page.evaluate(() => {
			const w = window as any;
			const fn = w.bobbitRenderApp ?? w.__bobbitRenderApp ?? null;
			if (typeof fn === "function") fn();
		});

		// Wait for the iframe to appear and read its src attribute.
		const iframe = page.locator(".goal-preview-panel iframe").first();
		await expect(iframe).toBeVisible({ timeout: 10_000 });
		const src = await iframe.getAttribute("src");
		expect(src).not.toBeNull();
		expect(src).toContain(`/preview/${encodeURIComponent(sessionId)}/`);
		expect(src).toContain("report.html");
		expect(src).toContain("#mtime=1234567890");
		expect(src).not.toContain("/api/preview/render");

		// Open-in-new-tab anchor renders with matching href.
		const link = page.locator('a[title="Open preview in new tab"]').first();
		await expect(link).toBeVisible();
		const href = await link.getAttribute("href");
		expect(href).toContain(`/preview/${encodeURIComponent(sessionId)}/`);
		expect(href).toContain("report.html");
		// New-tab link must NOT carry the cache-buster fragment.
		expect(href).not.toContain("#mtime=");

		// Refresh button bumps mtime → iframe src changes.
		const refresh = page.locator('button[title="Refresh preview"]').first();
		await expect(refresh).toBeVisible();
		await refresh.click();
		await page.waitForTimeout(50);
		const src2 = await iframe.getAttribute("src");
		expect(src2).not.toBeNull();
		expect(src2).not.toEqual(src);
		expect(src2).toMatch(/#mtime=\d+$/);
	});
});
