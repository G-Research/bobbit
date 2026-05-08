/**
 * Acceptance criterion #5: "Open in new tab" anchor in the preview panel
 * header opens a fresh browser tab on `/preview/<sid>/<entry>`, still authed
 * via the bobbit_session cookie.
 *
 * The anchor must:
 *   - have target="_blank" + rel="noopener noreferrer"
 *   - href = /preview/<sid>/<entry>  (no #mtime cache-buster)
 *   - actually load to 200 in a new context.waitForEvent("page") tab
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

test.describe("Preview Open-in-new-tab (criterion 5)", () => {
	test("renders authed external link and the new tab loads to 200", async ({ page, context }) => {
		await openApp(page);
		await createSessionViaUI(page);

		// Capture the session id from the URL hash.
		await page.waitForFunction(() => /#\/session\/[\w-]+/.test(location.hash), null, { timeout: 10_000 });
		const sessionId = await page.evaluate(() => {
			const m = location.hash.match(/#\/session\/([\w-]+)/);
			return m?.[1] ?? "";
		});
		expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);

		// Drive the unified preview panel through the natural product flow:
		// 1. PATCH the session preview=true → WS broadcast flips isPreviewSession
		//    on the client + starts the SSE preview-events subscription.
		// 2. POST /api/preview/mount to populate <stateDir>/preview/<sid>/report.html.
		//    The mount endpoint emits a preview-changed broadcast which arrives
		//    via SSE and bumps state.previewPanelEntry + previewPanelMtime,
		//    triggering renderApp().
		const patchResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
			const r = await fetch(`${baseUrl}/api/sessions/${sessionId}`, {
				method: "PATCH",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ preview: true }),
			});
			return { status: r.status, text: await r.text() };
		}, { baseUrl: new URL(page.url()).origin, sessionId });
		expect(patchResp.status, `PATCH preview should succeed: ${patchResp.text}`).toBe(200);

		// Wait for the WS preview_changed broadcast to flip isPreviewSession
		// on the client. Until then the preview panel header isn't rendered.
		await expect.poll(
			async () => await page.evaluate(() => {
				const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
				return s.isPreviewSession === true;
			}),
			{ timeout: 10_000 },
		).toBe(true);

		// Switch to the Preview tab so the panel header anchor is gated on.
		// `previewPanelEntry` arrives via the SSE preview-changed broadcast
		// emitted by the mount POST below — no client-side pre-seed needed.
		await page.evaluate(() => {
			const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			s.previewPanelActiveTab = "preview";
		});

		// Seed report.html on the server. The mount-changed broadcast lands
		// via SSE and the client bumps previewPanelEntry, which causes the
		// preview panel header (with the Open-in-new-tab anchor) to render.
		const baseUrl = new URL(page.url()).origin;
		const mountResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
			const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ html: "<!DOCTYPE html><body>new-tab-target</body>", entry: "report.html" }),
			});
			return { status: r.status, text: await r.text() };
		}, { baseUrl, sessionId });
		expect(mountResp.status, `mount POST should succeed: ${mountResp.text}`).toBe(200);

		// Anchor renders with the right attributes.
		const link = page.locator('a[title="Open preview in new tab"]').first();
		await expect.poll(async () => link.count(), { timeout: 15_000 }).toBeGreaterThan(0);
		await expect(link).toBeVisible({ timeout: 10_000 });
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link).toHaveAttribute("rel", /noopener.*noreferrer|noreferrer.*noopener/);

		const href = await link.getAttribute("href");
		expect(href).not.toBeNull();
		expect(href).toContain(`/preview/${encodeURIComponent(sessionId)}/`);
		expect(href).toContain("report.html");
		// New-tab link is meant for sharing — must NOT carry the cache-buster.
		expect(href).not.toContain("#mtime=");

		// Click the link — Playwright's context emits 'page' for window.open / target=_blank.
		const [newPage] = await Promise.all([
			context.waitForEvent("page", { timeout: 10_000 }),
			link.click(),
		]);
		await newPage.waitForLoadState("domcontentloaded");

		// The URL the new tab landed on should match the anchor href.
		const newUrl = newPage.url();
		expect(newUrl).toContain(`/preview/${encodeURIComponent(sessionId)}/`);
		expect(newUrl).toContain("report.html");

		// Re-fetch from inside the new tab via the browser's own fetch — that
		// path carries the bobbit_session cookie set on the same origin during
		// openApp()'s handshake. Playwright's APIRequestContext doesn't share
		// the BrowserContext cookie jar by default, hence the in-page approach.
		await newPage.waitForLoadState("domcontentloaded");
		const verify = await newPage.evaluate(async (u) => {
			const r = await fetch(u, { credentials: "include" });
			return { status: r.status, contentType: r.headers.get("content-type") || "", body: await r.text() };
		}, newUrl);
		expect(verify.status, `GET ${newUrl} should be 200`).toBe(200);
		expect(verify.contentType).toMatch(/text\/html/);
		expect(verify.body).toContain("new-tab-target");
		expect(verify.body).toContain(`<base href="/preview/${sessionId}/">`);
	});

	/**
	 * Reproducing test for Bug 3 — Standalone tab loses CSS theme tokens.
	 *
	 * In the embedded iframe the PREVIEW_THEME_BRIDGE pulls --background etc.
	 * from parent.document.documentElement. In a standalone tab parent === window,
	 * so the bridge silently no-ops and the served HTML has no inline theme
	 * snapshot — `var(--background)` resolves to empty.
	 *
	 * After the fix the served HTML must carry an inline <style> block defining
	 * the canonical theme tokens, so getComputedStyle reports a non-empty colour.
	 */
	test("standalone tab document has --background defined (Bug 3)", async ({ page, context }) => {
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
			return { status: r.status };
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

		const mountResp = await page.evaluate(async ({ baseUrl, sessionId }) => {
			const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					html: `<!DOCTYPE html><html><head></head><body><div id="box" style="background:var(--background);color:var(--foreground);">themed</div></body></html>`,
					entry: "report.html",
				}),
			});
			return { status: r.status };
		}, { baseUrl, sessionId });
		expect(mountResp.status).toBe(200);

		const link = page.locator('a[title="Open preview in new tab"]').first();
		await expect.poll(async () => link.count(), { timeout: 15_000 }).toBeGreaterThan(0);
		await expect(link).toBeVisible({ timeout: 10_000 });

		const [newPage] = await Promise.all([
			context.waitForEvent("page", { timeout: 10_000 }),
			link.click(),
		]);
		await newPage.waitForLoadState("domcontentloaded");
		await newPage.waitForLoadState("load");

		// Read the standalone document's --background custom property.
		const bg = await newPage.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
		);
		const fg = await newPage.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim(),
		);

		expect(bg, "--background must be defined in the standalone preview document").not.toEqual("");
		expect(fg, "--foreground must be defined in the standalone preview document").not.toEqual("");
		// Sanity: the resolved value should look like a colour (oklch / rgb / hsl / # / color()).
		expect(bg).toMatch(/^(oklch|rgb|rgba|hsl|hsla|color)\(|^#[0-9a-fA-F]{3,8}$/);
	});
});
