/**
 * WP-E URL-shape regression: when the unified preview panel renders the
 * Preview tab, its iframe `src` must point at the per-session content
 * mount with the correct `#mtime=<n>` cache-buster.
 *
 * This test is intentionally minimal — full asset-loading coverage lives
 * in preview-mount-route.spec.ts and preview-new-tab.spec.ts. We just
 * validate that the Preview tab now produces a `/preview/<sid>/<entry>#mtime=<n>`
 * iframe and not the legacy `/api/preview/render` (file mode) or `srcdoc=`
 * (inline mode) shapes.
 */
import { test, expect } from "./fixtures.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

test.describe("Preview panel iframe URL (WP-E)", () => {
	test("iframe src is /preview/<sid>/<entry>#mtime=<n>", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		// Capture the session id from the URL hash (createSessionViaUI returns void).
		await page.waitForFunction(() => /#\/session\/[\w-]+/.test(location.hash), null, { timeout: 10_000 });
		const sessionId = await page.evaluate(() => {
			const m = location.hash.match(/#\/session\/([\w-]+)/);
			return m?.[1] ?? "";
		});
		expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);

		// Drive the unified preview panel through the natural product flow:
		// 1. PATCH preview=true → WS broadcast flips state.isPreviewSession on
		//    the client and starts the SSE preview-events subscription.
		// 2. POST /api/preview/mount → server emits preview-changed → SSE
		//    bumps state.previewPanelMtime and triggers renderApp().
		const baseUrl = new URL(page.url()).origin;
		const patchResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
			const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
				method: "PATCH",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ preview: true }),
			});
			return { status: r.status, text: await r.text() };
		}, { baseUrl, sessionId });
		expect(patchResp.status).toBe(200);

		await expect.poll(
			async () => await page.evaluate(() => {
				const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
				return s.isPreviewSession === true;
			}),
			{ timeout: 10_000 },
		).toBe(true);

		// Switch to Preview tab so the iframe is visible. The SSE handler
		// forwards `entry` from the broadcast — no client-side pre-seed needed.
		await page.evaluate(() => {
			const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			s.previewPanelActiveTab = "preview";
		});

		const mountResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
			const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ html: "<!DOCTYPE html><body>x</body>", entry: "report.html" }),
			});
			return { status: r.status, text: await r.text() };
		}, { baseUrl, sessionId });
		expect(mountResp.status).toBe(200);

		// Wait for the iframe to appear and read its src attribute.
		const iframe = page.locator(".goal-preview-panel iframe").first();
		await expect(iframe).toBeVisible({ timeout: 10_000 });
		const src = await iframe.getAttribute("src");
		expect(src).not.toBeNull();
		expect(src).toContain(`/preview/${encodeURIComponent(sessionId)}/`);
		expect(src).toContain("report.html");
		expect(src).toMatch(/\?mtime=\d+$/);
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
		await expect.poll(async () => await iframe.getAttribute("src"), {
			timeout: 5000,
		}).not.toEqual(src);
		const src2 = await iframe.getAttribute("src");
		expect(src2).not.toBeNull();
		expect(src2).toMatch(/\?mtime=\d+$/);
	});
});
