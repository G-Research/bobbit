/**
 * Retained spawned-gateway side-panel tab smokes.
 * Broad side-panel workspace matrices live in tests/ui-fixtures/dynamic-panel-workspace-fixture.spec.ts.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, nonGitCwd } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

const PANEL_TAB_SELECTOR = ".goal-tab-pill";

type PanelTab = {
	index: number;
	id: string;
	kind: string;
	label: string;
	active: boolean;
	closable: boolean;
};

const previewId = (entry: string) => `preview:entry:${encodeURIComponent(entry)}`;

function previewHtml(bodyText: string): string {
	return `<!DOCTYPE html><html><body><main><h1>${bodyText}</h1></main></body></html>`;
}

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""), { timeout: 10_000 }).toBe(sessionId);
}

async function createRegularSessionViaApi(page: Page): Promise<string> {
	const sid = await createSession({ cwd: nonGitCwd() });
	await navigateToSession(page, sid);
	return sid;
}

async function visiblePanelTabs(page: Page): Promise<PanelTab[]> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button, index) => {
			const el = button as HTMLElement;
			const rect = el.getBoundingClientRect();
			const style = window.getComputedStyle(el);
			if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") return null;
			if (button.getAttribute("data-panel-tab-kind") === "chat") return null;
			const label = (button.textContent || "").replace(/\s+/g, " ").replace(/[×✕]/g, "").trim();
			const title = (button.getAttribute("data-panel-tab-title") || button.getAttribute("title") || label).replace(/\s+/g, " ").trim();
			return {
				index,
				id: button.getAttribute("data-panel-tab-id") || "",
				kind: button.getAttribute("data-panel-tab-kind") || "",
				label: label || title,
				active: button.classList.contains("goal-tab-pill--active"),
				closable: !!button.querySelector(".goal-tab-close"),
			};
		})
		.filter(Boolean) as PanelTab[]);
}

async function visiblePanelTabIds(page: Page): Promise<string[]> {
	return (await visiblePanelTabs(page)).map((tab) => tab.id);
}

async function expectPanelTabs(page: Page, expectedIds: string[], message: string): Promise<void> {
	await expect.poll(() => visiblePanelTabIds(page), { timeout: 15_000, message }).toEqual(expectedIds);
	await expectNoChatTab(page);
}

async function expectNoChatTab(page: Page): Promise<void> {
	const tabs = await visiblePanelTabs(page);
	expect(tabs.filter((tab) => tab.id === "chat" || tab.kind === "chat" || /^Chat$/i.test(tab.label)), `persisted side-pane tabs must not expose Chat; tabs=${JSON.stringify(tabs)}`).toEqual([]);
	await expect(page.locator(`${PANEL_TAB_SELECTOR}[data-panel-tab-id="chat"]`)).toHaveCount(0);
}

async function expectNoPersistedChatTab(page: Page, sessionId: string): Promise<void> {
	await expect.poll(() => page.evaluate((sid) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
		const rows = [
			...(Array.isArray(state.panelTabs) ? state.panelTabs : []),
			...(Array.isArray(state.panelTabsBySession?.[sid]) ? state.panelTabsBySession[sid] : []),
		];
		return rows.some((tab: any) => tab?.id === "chat" || tab?.kind === "chat" || tab?.legacyTab === "chat");
	}, sessionId), { timeout: 5_000, message: "persisted side-pane tab rows must not contain chat" }).toBe(false);
}

async function enablePreview(page: Page, sessionId: string): Promise<void> {
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
	expect(patchResp.status, `PATCH preview should succeed: ${patchResp.text}`).toBe(200);
	await expect.poll(() => page.evaluate(() => !!((window as any).bobbitState ?? (window as any).__bobbitState)?.isPreviewSession), { timeout: 10_000 }).toBe(true);
}

async function mountPreviewHtml(page: Page, sessionId: string, entry: string, bodyText: string): Promise<void> {
	await enablePreview(page, sessionId);
	const baseUrl = new URL(page.url()).origin;
	const mountResp = await page.evaluate(async ({ baseUrl, sessionId, entry, html }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ entry, html }),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId, entry, html: previewHtml(bodyText) });
	expect(mountResp.status, `preview mount for ${entry} should succeed: ${mountResp.text}`).toBe(200);
	await expectPanelTabs(page, [previewId(entry)], `current preview tab ${entry} should be visible`);
	await expectPreviewContains(page, bodyText, `current preview ${entry}`);
}

async function expectPreviewContains(page: Page, expectedText: string, message: string): Promise<void> {
	const iframe = page.locator(".goal-preview-panel iframe").first();
	await expect(iframe, `${message}: iframe should be visible`).toBeVisible({ timeout: 15_000 });
	await expect(page.frameLocator(".goal-preview-panel iframe").first().locator("body"), message).toContainText(expectedText, { timeout: 15_000 });
}

async function workspace(sessionId: string): Promise<any> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace`);
	const text = await resp.text();
	expect(resp.status, `workspace GET failed: ${text}`).toBe(200);
	return JSON.parse(text);
}

test.describe("Side-panel tab contract", () => {
	test("Chat is never a persisted tab and an empty non-staff side pane stays hidden @smoke", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
		await expect(page.locator('[data-panel-workspace="content"]')).toHaveCount(0, { timeout: 10_000 });
		await expect.poll(() => visiblePanelTabs(page), { timeout: 5_000 }).toEqual([]);
		await expectNoChatTab(page);
		await expectNoPersistedChatTab(page, sessionId);
		await expect.poll(async () => (await workspace(sessionId)).tabs.map((tab: any) => tab.id), { timeout: 10_000 }).toEqual([]);
	});

	test("current preview tab opens once, refreshes in place, and survives reload @smoke", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		await mountPreviewHtml(page, sessionId, "current.html", "Preview v1");
		await mountPreviewHtml(page, sessionId, "current.html", "Preview v2");
		await expectPanelTabs(page, [previewId("current.html")], "refreshing a preview should reuse one tab");
		await expectPreviewContains(page, "Preview v2", "refreshed preview tab should render updated content");

		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectPanelTabs(page, [previewId("current.html")], "preview tab should survive reload");
		await expectNoPersistedChatTab(page, sessionId);
	});
});
