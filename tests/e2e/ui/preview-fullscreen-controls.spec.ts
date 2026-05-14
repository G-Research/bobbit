/**
 * Reproducing test for Bug 1 — Fullscreen header missing controls.
 *
 * The half-panel header renders Open-in-new-tab → Refresh → Fullscreen → Collapse.
 * The fullscreen header (when state.previewPanelFullscreen === true) currently
 * only renders the Exit-fullscreen button. After the fix it should also expose
 * "Open preview in new tab" and "Refresh preview".
 *
 * This test will FAIL on master because the fullscreen header does not contain
 * those controls.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

test.describe("Preview fullscreen header controls (Bug 1)", () => {
	test("fullscreen header exposes Open-in-new-tab and Refresh buttons", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await page.waitForFunction(() => /#\/session\/[\w-]+/.test(location.hash), null, { timeout: 10_000 });
		const sessionId = await page.evaluate(() => {
			const m = location.hash.match(/#\/session\/([\w-]+)/);
			return m?.[1] ?? "";
		});
		expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);

		const baseUrl = new URL(page.url()).origin;

		// Enable preview mode on the session.
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

		// Mount a preview so the entry exists and Fullscreen button is rendered.
		const mountResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
			const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ html: "<!DOCTYPE html><body>fs-test</body>", entry: "report.html" }),
			});
			return { status: r.status, text: await r.text() };
		}, { baseUrl, sessionId });
		expect(mountResp.status).toBe(200);

		// Half-panel: Fullscreen button should be visible.
		const fullscreenBtn = page.locator('button[title^="Fullscreen preview"]').first();
		await expect(fullscreenBtn).toBeVisible({ timeout: 10_000 });
		await fullscreenBtn.click();

		// Wait for fullscreen mode.
		await expect.poll(
			async () => await page.evaluate(() => {
				const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
				return s.previewPanelFullscreen === true;
			}),
			{ timeout: 5_000 },
		).toBe(true);

		// Exit-fullscreen button must be visible (sanity).
		const exitBtn = page.locator('button[title^="Collapse preview"]').first();
		await expect(exitBtn).toBeVisible({ timeout: 5_000 });

		// THE BUG: in fullscreen mode the Open-in-new-tab and Refresh controls
		// are missing. After the fix they must be present.
		const openLink = page.locator('a[title="Open preview in new tab"]').first();
		const refreshBtn = page.locator('button[title="Refresh preview"]').first();
		await expect(openLink, "Open-in-new-tab anchor must be visible in fullscreen header").toBeVisible({ timeout: 5_000 });
		await expect(refreshBtn, "Refresh button must be visible in fullscreen header").toBeVisible({ timeout: 5_000 });
	});
});
