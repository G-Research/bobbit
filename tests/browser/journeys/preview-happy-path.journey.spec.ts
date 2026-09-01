/**
 * Retained served-app preview journey: drive the real UI + mock gateway from
 * preview mode through mount, iframe display, new-tab href, and Refresh.
 *
 * Cheaper fixture/API coverage owns fullscreen controls, reopen semantics,
 * archived snapshots, and content-origin details.
 */
import { test, expect } from "../../e2e/ui/fixtures.js";
import { openApp, createSessionViaUI } from "../../e2e/ui/ui-helpers.js";

test.describe("Preview panel retained full-stack smoke", () => {
	test("opens mounted preview and refreshes iframe cache-buster", async ({ page }) => {
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
			const text = await r.text();
			let body: any = null;
			try { body = text ? JSON.parse(text) : null; } catch { /* assertion below reports the raw body */ }
			return { status: r.status, text, body };
		}, { baseUrl, sessionId });
		expect(mountResp.status, `mount POST should succeed: ${mountResp.text}`).toBe(200);
		const mount = mountResp.body as { entry?: string; mtime?: number; contentHash?: string; artifactId?: string } | null;
		const expectedEntry = String(mount?.entry || "");
		const expectedMtime = Number(mount?.mtime || 0);
		const expectedHash = String(mount?.contentHash || "");
		const expectedArtifactId = String(mount?.artifactId || "");
		expect(expectedEntry).toBe("report.html");
		expect(expectedMtime).toBeGreaterThan(0);
		expect(expectedHash).toMatch(/^[a-f0-9]{64}$/);
		expect(expectedArtifactId).not.toBe("");

		// Wait for the mount identity to arrive through the product readiness path
		// (live SSE or its bootstrap frame) before asserting DOM URL shape.
		await expect.poll(
			async () => await page.evaluate(() => {
				const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
				return {
					activeTab: s.previewPanelActiveTab || "",
					entry: s.previewPanelEntry || "",
					mtime: Number(s.previewPanelMtime) || 0,
					contentHash: s.previewPanelContentHash || "",
				};
			}),
			{ timeout: 10_000, message: "preview mount should reach client state via SSE/bootstrap" },
		).toEqual({
			activeTab: "preview",
			entry: expectedEntry,
			mtime: expectedMtime,
			contentHash: expectedHash,
		});

		const encodedSessionId = encodeURIComponent(sessionId);
		const encodedArtifactId = encodeURIComponent(expectedArtifactId);
		const encodedEntry = encodeURIComponent(expectedEntry);
		const expectedPath = `/preview/${encodedSessionId}/_artifact/${encodedArtifactId}/${encodedEntry}`;

		// Wait for the iframe to mount with the immutable artifact URL and exact
		// server-confirmed cache-buster.
		const iframe = page.locator(".goal-preview-panel iframe").first();
		await expect(iframe, "preview iframe should expose an absolute gateway URL").toHaveAttribute("src", /^https?:\/\//, { timeout: 10_000 });
		await expect(iframe).toBeVisible();
		const src = await iframe.getAttribute("src");
		expect(src).not.toBeNull();
		const srcUrl = new URL(src!);
		expect(srcUrl.origin, "preview iframe should stay on the active gateway origin").toBe(baseUrl);
		expect(srcUrl.pathname).toBe(expectedPath);
		expect([...srcUrl.searchParams.keys()], "preview iframe should carry only the cache buster").toEqual(["mtime"]);
		expect(srcUrl.searchParams.get("mtime")).toMatch(/^\d+$/);
		expect(Number(srcUrl.searchParams.get("mtime"))).toBe(expectedMtime);
		expect(srcUrl.hash).toBe("");
		expect(src).not.toContain("/api/preview/render");
		await expect(
			page.frameLocator(".goal-preview-panel iframe").first().locator("body"),
			"mounted preview iframe should load report.html content",
		).toContainText("x", { timeout: 10_000 });

		// Open-in-new-tab anchor uses the same immutable artifact without a
		// cache-buster.
		const link = page.locator('a[title="Open preview in new tab"]').first();
		await expect(link).toBeVisible({ timeout: 10_000 });
		await expect(link, "preview popout should expose an absolute gateway URL").toHaveAttribute("href", /^https?:\/\//);
		const href = await link.getAttribute("href");
		expect(href).not.toBeNull();
		const hrefUrl = new URL(href!);
		expect(hrefUrl.origin, "preview popout should stay on the active gateway origin").toBe(baseUrl);
		expect(hrefUrl.pathname).toBe(expectedPath);
		expect(hrefUrl.search, "preview popout must not carry the iframe cache buster").toBe("");
		expect(hrefUrl.hash).toBe("");

		// Refresh bumps mtime while preserving the immutable artifact route.
		const refresh = page.locator('button[title="Refresh preview"]').first();
		await expect(refresh).toBeVisible();
		await refresh.click();
		await expect.poll(
			async () => await page.evaluate(() => {
				const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
				return Number(s.previewPanelMtime) || 0;
			}),
			{ timeout: 5000, message: "Refresh should bump previewPanelMtime" },
		).toBeGreaterThan(expectedMtime);
		await expect.poll(async () => await iframe.getAttribute("src"), {
			timeout: 5000,
			message: "Refresh should update the iframe cache-buster",
		}).not.toEqual(src);
		const src2 = await iframe.getAttribute("src");
		expect(src2).not.toBeNull();
		const refreshedSrcUrl = new URL(src2!);
		expect(refreshedSrcUrl.origin).toBe(baseUrl);
		expect(refreshedSrcUrl.pathname).toBe(expectedPath);
		expect([...refreshedSrcUrl.searchParams.keys()]).toEqual(["mtime"]);
		expect(refreshedSrcUrl.searchParams.get("mtime")).toMatch(/^\d+$/);
		expect(Number(refreshedSrcUrl.searchParams.get("mtime"))).toBeGreaterThan(Number(srcUrl.searchParams.get("mtime")));
		expect(refreshedSrcUrl.hash).toBe("");
	});
});
