/**
 * Reproducing test for Bug 2 — Refresh button does not reload the iframe.
 *
 * The current Refresh handler bumps state.previewPanelMtime and re-renders,
 * which only changes the iframe `src` URL fragment (#mtime=<n>). A fragment-
 * only change is a same-document navigation; the browser does NOT reload the
 * iframe. So the document inside the iframe never re-runs its inline scripts.
 *
 * We seed an HTML document whose inline script writes a per-load counter into
 * a #count div. After clicking Refresh, the counter must increment to "2".
 * On master it stays at "1" → test fails.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

const COUNTING_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>count</title></head>
<body>
<div id="count">?</div>
<script>
(function(){
	try {
		var k = 'preview-load-count-' + location.pathname;
		var n = parseInt(sessionStorage.getItem(k) || '0', 10) + 1;
		sessionStorage.setItem(k, String(n));
		document.getElementById('count').textContent = String(n);
	} catch (e) {
		document.getElementById('count').textContent = 'err:' + e.message;
	}
})();
</script>
</body></html>`;

test.describe("Preview Refresh button reloads iframe (Bug 2)", () => {
	test("dismissed live preview tab stays closed across reload", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await page.waitForFunction(() => /#\/session\/[\w-]+/.test(location.hash), null, { timeout: 10_000 });
		const sessionId = await page.evaluate(() => location.hash.match(/#\/session\/([\w-]+)/)?.[1] ?? "");
		expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
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

		const mountResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
			const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ html: "<!doctype html><body>dismiss me</body>", entry: "inline.html" }),
			});
			return { status: r.status, text: await r.text() };
		}, { baseUrl, sessionId });
		expect(mountResp.status).toBe(200);

		const previewTab = page.locator('.goal-tab-pill[data-panel-tab-kind="preview"]').first();
		await expect(previewTab).toBeVisible({ timeout: 10_000 });
		await previewTab.locator(".goal-tab-close").click();
		await expect(previewTab, "preview tab should close immediately").toBeHidden({ timeout: 5_000 });

		await page.reload();
		await page.waitForFunction(() => /#\/session\/[\w-]+/.test(location.hash), null, { timeout: 10_000 });
		await expect(page.locator('.goal-tab-pill[data-panel-tab-kind="preview"]'), "dismissed live preview should not be rehydrated by preview bootstrap").toHaveCount(0, { timeout: 5_000 });

		const nextMountResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
			const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ html: "<!doctype html><body>new content</body>", entry: "inline.html" }),
			});
			return { status: r.status, text: await r.text() };
		}, { baseUrl, sessionId });
		expect(nextMountResp.status).toBe(200);
		await expect(page.locator('.goal-tab-pill[data-panel-tab-kind="preview"]'), "new preview content should still reopen the tab").toHaveCount(1, { timeout: 10_000 });
	});

	test("clicking Refresh causes the iframe document to re-execute", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await page.waitForFunction(() => /#\/session\/[\w-]+/.test(location.hash), null, { timeout: 10_000 });
		const sessionId = await page.evaluate(() => {
			const m = location.hash.match(/#\/session\/([\w-]+)/);
			return m?.[1] ?? "";
		});
		expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);
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

		await page.evaluate(() => {
			const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			s.previewPanelActiveTab = "preview";
		});

		const mountResp = await page.evaluate(async ({ baseUrl, sessionId, html }) => {
			const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ html, entry: "report.html" }),
			});
			return { status: r.status, text: await r.text() };
		}, { baseUrl, sessionId, html: COUNTING_HTML });
		expect(mountResp.status).toBe(200);

		const iframe = page.locator(".goal-preview-panel iframe").first();
		await expect(iframe).toBeVisible({ timeout: 10_000 });

		const frame = page.frameLocator(".goal-preview-panel iframe").first();
		const countDiv = frame.locator("#count");
		await expect(countDiv).toHaveText("1", { timeout: 10_000 });

		// Click Refresh — should cause the iframe to actually reload, re-running
		// the inline script and incrementing the counter.
		const refreshBtn = page.locator('button[title="Refresh preview"]').first();
		await expect(refreshBtn).toBeVisible();
		await refreshBtn.click();

		await expect(countDiv, "iframe must reload after Refresh — counter should increment to 2").toHaveText("2", { timeout: 5_000 });
	});
});
