/**
 * Browser E2E reproducer for durable HTML preview restore across gateway restarts.
 *
 * This intentionally drives the real server-backed preview mount and
 * side-panel workspace paths. It must not seed client preview caches directly;
 * the persisted workspace tab and live mount/artifact files are the source of
 * truth before and after restart.
 */
import type { Page } from "@playwright/test";
import { test, expect, type GatewayInfo } from "../gateway-harness.js";
import { apiFetch, base, createSession, nonGitCwd, readE2ETokenAsync } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const ENTRY = "durable-preview.html";
const BODY_TEXT = "DURABLE_PREVIEW_RESTART";
const PREVIEW_TAB_ID = `preview:entry:${encodeURIComponent(ENTRY)}`;
const PANEL_TAB_SELECTOR = ".goal-tab-pill";

function previewHtml(): string {
	return `<!doctype html><html><body><main><h1>${BODY_TEXT}</h1></main></body></html>`;
}

function previewTab(page: Page) {
	return page.locator(`${PANEL_TAB_SELECTOR}[data-panel-tab-id="${PREVIEW_TAB_ID}"]`).first();
}

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000, message: "session route should be active" },
	).toBe(sessionId);
}

async function openSessionDirectly(page: Page, sessionId: string): Promise<void> {
	const token = await readE2ETokenAsync();
	await page.goto(`${base()}/?token=${encodeURIComponent(token)}#/session/${sessionId}`, { waitUntil: "domcontentloaded" });
	await expect(page.locator("button").filter({ hasText: "Settings" }).first()).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000, message: "direct session route should be active" },
	).toBe(sessionId);
}

async function createRegularSession(page: Page): Promise<string> {
	const sessionId = await createSession({ cwd: nonGitCwd() });
	await navigateToSession(page, sessionId);
	return sessionId;
}

async function enablePreviewSession(sessionId: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sessionId}`, {
		method: "PATCH",
		body: JSON.stringify({ preview: true }),
	});
	const text = await resp.text();
	expect(resp.status, `PATCH preview=true should succeed: ${text}`).toBe(200);
}

async function mountPreview(sessionId: string): Promise<{ entry: string; mtime: number; contentHash: string; url?: string }> {
	const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`, {
		method: "POST",
		body: JSON.stringify({ entry: ENTRY, html: previewHtml() }),
	});
	const text = await resp.text();
	expect(resp.status, `POST /api/preview/mount should succeed: ${text}`).toBe(200);
	const body = JSON.parse(text) as { entry?: string; mtime?: number; contentHash?: string; url?: string };
	expect(body.entry).toBe(ENTRY);
	expect(body.mtime).toBeGreaterThan(0);
	expect(body.contentHash).toMatch(/^[a-f0-9]{64}$/);
	return body as { entry: string; mtime: number; contentHash: string; url?: string };
}

async function workspace(sessionId: string): Promise<any> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace`);
	const text = await resp.text();
	expect(resp.status, `workspace GET failed: ${text}`).toBe(200);
	return JSON.parse(text);
}

async function currentMount(sessionId: string): Promise<any> {
	const resp = await apiFetch(`/api/preview/mount?sessionId=${sessionId}`);
	const text = await resp.text();
	expect(resp.status, `GET /api/preview/mount should still succeed: ${text}`).toBe(200);
	return JSON.parse(text);
}

async function waitForWorkspacePreviewTab(sessionId: string): Promise<void> {
	await expect.poll(async () => {
		const ws = await workspace(sessionId);
		return {
			activeTabId: ws.activeTabId,
			tabs: (ws.tabs || []).map((tab: any) => ({ id: tab.id, entry: tab.source?.entry, contentHash: tab.source?.contentHash })),
		};
	}, {
		timeout: 15_000,
		message: "server-backed side-panel workspace should persist the current preview tab",
	}).toEqual({
		activeTabId: PREVIEW_TAB_ID,
		tabs: [expect.objectContaining({ id: PREVIEW_TAB_ID, entry: ENTRY, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })],
	});
}

async function expectPreviewTabActive(page: Page, message: string): Promise<void> {
	const tab = previewTab(page);
	await expect(tab, `${message}: preview side-panel tab should be visible`).toBeVisible({ timeout: 15_000 });
	await expect(tab, `${message}: preview side-panel tab should be active`).toHaveClass(/goal-tab-pill--active/, { timeout: 10_000 });
	await expect(tab, `${message}: preview side-panel tab should show the entry label`).toContainText(ENTRY);
}

async function previewDiagnostics(page: Page): Promise<string> {
	return page.evaluate(() => {
		const tab = document.querySelector(`[data-panel-tab-id="${CSS.escape("preview:entry:durable-preview.html")}"]`) as HTMLElement | null;
		const panel = document.querySelector(".goal-preview-panel") as HTMLElement | null;
		const iframe = document.querySelector(".goal-preview-panel iframe") as HTMLIFrameElement | null;
		let iframeBodyText = "";
		try { iframeBodyText = iframe?.contentDocument?.body?.innerText || ""; } catch (err) { iframeBodyText = `iframe-read-error:${String(err)}`; }
		return JSON.stringify({
			tabVisible: !!tab && tab.getBoundingClientRect().width > 0 && tab.getBoundingClientRect().height > 0,
			tabActive: !!tab?.classList.contains("goal-tab-pill--active"),
			iframeSrc: iframe?.getAttribute("src") || "",
			panelText: (panel?.innerText || "").replace(/\s+/g, " ").trim(),
			iframeBodyText: iframeBodyText.replace(/\s+/g, " ").trim(),
		});
	});
}

async function expectPreviewIframeContains(page: Page, message: string): Promise<void> {
	await expect.poll(
		() => previewDiagnostics(page),
		{
			timeout: 15_000,
			message: `${message}: expected preview iframe diagnostics to contain ${BODY_TEXT}; empty previews usually report "No preview yet."`,
		},
	).toContain(BODY_TEXT);

	const iframe = page.locator(".goal-preview-panel iframe").first();
	await expect(iframe, `${message}: iframe should have preview content src`).toHaveAttribute(
		"src",
		new RegExp(`^/preview/${sessionIdPattern()}/${ENTRY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?mtime=\\d+$`),
		{ timeout: 10_000 },
	);
}

function sessionIdPattern(): string {
	return "[a-f0-9-]+";
}

/**
 * Crash + restart the in-process gateway on the same port/state dir, then wait
 * for the app to reconnect if the page is still alive.
 */
async function crashAndRestart(gateway: GatewayInfo, page: Page): Promise<void> {
	await gateway.crash();
	if (!page.isClosed()) {
		await page.waitForFunction(() => {
			const s = (window as any).bobbitState;
			return !!s && s.connectionStatus !== "connected";
		}, undefined, { timeout: 5_000 }).catch(() => { /* best-effort */ });
	}

	await gateway.restart();
	await expect.poll(async () => {
		try { return (await apiFetch("/api/health")).ok; } catch { return false; }
	}, { timeout: 20_000, intervals: [250], message: "gateway should be healthy after restart" }).toBe(true);

	if (!page.isClosed()) {
		await page.waitForFunction(() => {
			const s = (window as any).bobbitState;
			return !!s && s.connectionStatus === "connected";
		}, undefined, { timeout: 15_000, polling: 250 }).catch(() => { /* best-effort; reload below also reconnects */ });
	}
}

async function reloadAndReturnToSession(page: Page, sessionId: string): Promise<void> {
	await page.reload({ waitUntil: "domcontentloaded" });
	await navigateToSession(page, sessionId);
}

async function closePreviewTab(page: Page): Promise<void> {
	await previewTab(page).locator('[data-testid="side-panel-close"]').click();
	await expect(previewTab(page), "preview tab should disappear after the user closes it").toHaveCount(0, { timeout: 10_000 });
}

async function expectWorkspaceHasNoPreviewTab(sessionId: string): Promise<void> {
	await expect.poll(async () => {
		const ws = await workspace(sessionId);
		return {
			activeTabId: ws.activeTabId,
			hasPreviewTab: (ws.tabs || []).some((tab: any) => tab.id === PREVIEW_TAB_ID),
		};
	}, { timeout: 10_000, message: "closed preview tab should be removed from server workspace" }).toEqual({ activeTabId: "", hasPreviewTab: false });
}

async function expectPreviewTabStaysClosed(page: Page): Promise<void> {
	// Bootstrap and SSE reconciliation are asynchronous; require a stable closed
	// window so a delayed mount bootstrap cannot recreate a user-closed tab unnoticed.
	const stayedClosed = await page.waitForFunction((tabId) => new Promise<boolean>((resolve) => {
		const selector = `[data-panel-tab-id="${CSS.escape(tabId)}"]`;
		const deadline = performance.now() + 3_000;
		const tick = () => {
			if (document.querySelector(selector)) return resolve(false);
			if (performance.now() >= deadline) return resolve(true);
			requestAnimationFrame(tick);
		};
		tick();
	}), PREVIEW_TAB_ID, { timeout: 4_000 });
	expect(await stayedClosed.jsonValue(), "closed preview tab must not be resurrected from mount bootstrap").toBe(true);
}

test.describe.configure({ mode: "serial" });

test.describe("Durable HTML preview restart restore", () => {
	test("shows preview refresh immediately when a persisted preview tab restores before the preview mirror", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		const sessionId = await createSession({ cwd: nonGitCwd() });
		await enablePreviewSession(sessionId);
		const mount = await mountPreview(sessionId);
		await waitForWorkspacePreviewTab(sessionId);

		await openSessionDirectly(page, sessionId);
		await expectPreviewTabActive(page, "direct navigation restore");
		await expectPreviewIframeContains(page, "direct navigation restore");

		// Recreate the restore race: the active server-persisted preview tab has
		// the entry in its source/state, while the transient previewPanelEntry
		// mirror is still empty. The iframe can render from the tab entry; the
		// header controls must use the same source instead of hiding.
		await page.evaluate(() => {
			const s: any = (window as any).bobbitState ?? (window as any).__bobbitState;
			s.previewPanelEntry = "";
			s.previewPanelMtime = 0;
			(window as any).__bobbitRenderApp?.();
		});
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.previewPanelEntry ?? ""),
			{ timeout: 2_000, message: "test setup should leave the previewPanelEntry mirror empty" },
		).toBe("");
		await expectPreviewIframeContains(page, "direct navigation restore with empty preview mirror");

		await expect(
			page.locator('button[title="Refresh preview"]').first(),
			"Refresh preview should be visible immediately from the restored preview tab entry, before collapse/expand",
		).toBeVisible({ timeout: 5_000 });

		const encodedSessionId = encodeURIComponent(sessionId);
		const encodedEntry = encodeURIComponent(mount.entry);
		const openPreview = page.locator('a[title="Open preview in new tab"]').first();
		await expect(openPreview, "open-preview action should use the restored preview tab entry").toBeVisible({ timeout: 5_000 });
		await expect(openPreview).toHaveAttribute("href", `/preview/${encodedSessionId}/${encodedEntry}`);
	});

	test("restores the mounted preview tab and iframe after restart, but keeps a user-closed tab closed", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		const sessionId = await createRegularSession(page);

		await enablePreviewSession(sessionId);
		await mountPreview(sessionId);
		await waitForWorkspacePreviewTab(sessionId);

		await expectPreviewTabActive(page, "before restart");
		await expectPreviewIframeContains(page, "before restart");

		await crashAndRestart(gateway, page);
		await reloadAndReturnToSession(page, sessionId);

		await waitForWorkspacePreviewTab(sessionId);
		await expectPreviewTabActive(page, "after restart");
		await expectPreviewIframeContains(page, "after restart");

		await closePreviewTab(page);
		await expectWorkspaceHasNoPreviewTab(sessionId);
		const stillMounted = await currentMount(sessionId);
		expect(stillMounted.entry).toBe(ENTRY);
		expect(stillMounted.contentHash).toMatch(/^[a-f0-9]{64}$/);

		await crashAndRestart(gateway, page);
		await reloadAndReturnToSession(page, sessionId);
		await expectWorkspaceHasNoPreviewTab(sessionId);
		await expectPreviewTabStaysClosed(page);
	});
});
