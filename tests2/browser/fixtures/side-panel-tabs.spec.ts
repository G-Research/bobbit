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

async function postPreviewHtml(page: Page, sessionId: string, entry: string, bodyText: string): Promise<{ artifactId: string }> {
	const baseUrl = new URL(page.url()).origin;
	const result = await page.evaluate(async ({ baseUrl, sessionId, entry, html }) => {
		const response = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ entry, html }),
		});
		return { status: response.status, text: await response.text() };
	}, { baseUrl, sessionId, entry, html: previewHtml(bodyText) });
	expect(result.status, `preview mount for ${entry} should succeed: ${result.text}`).toBe(200);
	const parsed = JSON.parse(result.text);
	expect(parsed.artifactId, `preview mount for ${entry} should return immutable artifact identity`).toBeTruthy();
	return { artifactId: parsed.artifactId };
}

async function tabSurfaceColors(page: Page, mobile = false): Promise<{ strip: string; inactive: string; active: string }> {
	const selector = mobile ? ".goal-tab-bar--mobile [data-panel-tab-bar]" : '[data-panel-workspace="content"] [data-panel-tab-bar]';
	return page.locator(selector).evaluate((bar) => {
		const strip = bar.closest(".goal-tab-bar") || bar.parentElement?.parentElement;
		const inactive = bar.querySelector<HTMLElement>(".goal-tab-pill:not(.goal-tab-pill--active)");
		const active = bar.querySelector<HTMLElement>(".goal-tab-pill--active");
		return {
			strip: strip ? getComputedStyle(strip).backgroundColor : "",
			inactive: inactive ? getComputedStyle(inactive).backgroundColor : "",
			active: active ? getComputedStyle(active).backgroundColor : "",
		};
	});
}

async function selectPanelTab(page: Page, tabId: string, sessionId?: string): Promise<void> {
	const visibleTab = page.locator(`.goal-tab-pill[data-panel-tab-id="${tabId}"]`);
	if (await visibleTab.isVisible().catch(() => false)) {
		await visibleTab.click();
	} else {
		await page.getByRole("button", { name: "More tabs" }).click();
		await page.locator(`[role="menuitem"][data-panel-tab-id="${tabId}"]`).click();
	}
	await expect(page.locator(`.goal-tab-pill--active[data-panel-tab-id="${tabId}"]`)).toBeVisible({ timeout: 10_000 });
	if (sessionId) {
		await expect.poll(async () => (await workspace(sessionId)).activeTabId, {
			timeout: 10_000,
			message: `selection of ${tabId} should persist before another tab mutation`,
		}).toBe(tabId);
	}
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
		const curve = await page.locator(`${PANEL_TAB_SELECTOR}.goal-tab-pill--active`).first().evaluate((element) => {
			const style = getComputedStyle(element);
			const before = getComputedStyle(element, "::before");
			const after = getComputedStyle(element, "::after");
			return {
				overflow: style.overflow,
				before: { width: before.width, left: before.left, image: before.backgroundImage },
				after: { width: after.width, right: after.right, image: after.backgroundImage },
			};
		});
		expect(curve.overflow, "active tabs must not clip their outward bottom curves").toBe("visible");
		expect(curve.before).toMatchObject({ width: "8px", left: "-8px" });
		expect(curve.before.image).toContain("radial-gradient");
		expect(curve.after).toMatchObject({ width: "8px", right: "-8px" });
		expect(curve.after.image).toContain("radial-gradient");
		const naturalTabWidth = await page.locator(`${PANEL_TAB_SELECTOR}.goal-tab-pill--active`).first().evaluate((element) => element.getBoundingClientRect().width);
		expect(naturalTabWidth, "a lone tab should size to its title and controls instead of taking a fixed 220px slot").toBeLessThan(180);

		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectPanelTabs(page, [previewId("current.html")], "preview tab should survive reload");
		await expectNoPersistedChatTab(page, sessionId);
	});

	test("sequential preview files keep stable artifact routes across tabs and reload", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		await enablePreview(page, sessionId);

		const previews: Array<{ entry: string; body: string; artifactId: string }> = [];
		for (let index = 1; index <= 6; index++) {
			const entry = `sequential-${index}.html`;
			const body = `SEQUENTIAL_PREVIEW_${index}`;
			const { artifactId } = await postPreviewHtml(page, sessionId, entry, body);
			previews.push({ entry, body, artifactId });
		}
		await expect.poll(async () => (await workspace(sessionId)).tabs.length, { timeout: 15_000 }).toBe(previews.length);
		const more = page.getByRole("button", { name: "More tabs" });
		await expect(more, "many preview tabs should expose overflow access").toBeVisible({ timeout: 10_000 });
		const visibleWidths = await page.locator("[data-panel-tab-bar] > .goal-tab-pill").evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width));
		expect(visibleWidths.length).toBeLessThan(previews.length);
		expect(Math.min(...visibleWidths), "visible tabs should retain a readable label beside the close button").toBeGreaterThanOrEqual(103);
		await more.click();
		const menu = page.getByRole("menu", { name: "More side-panel tabs" });
		await expect(menu).toBeVisible();
		expect(await menu.evaluate((element) => ({
			popover: element.parentElement?.hasAttribute("popover") || false,
			insideStrip: !!element.closest("[data-panel-tab-bar]"),
		}))).toEqual({ popover: true, insideStrip: false });
		await page.mouse.click(4, 760);
		await expect(menu, "clicking the transparent area outside the menu card should dismiss it").toBeHidden();
		await expect(more).toHaveAttribute("aria-expanded", "false");
		await more.click();
		await expect(menu).toBeVisible();
		await page.keyboard.press("Escape");
		const desktopSurfaces = await tabSurfaceColors(page);
		expect(new Set(Object.values(desktopSurfaces)).size, `desktop selected, inactive, and strip surfaces should use three shades: ${JSON.stringify(desktopSurfaces)}`).toBe(3);

		const checkedPreviews = [previews[0], previews[3], previews[5], previews[1]];
		for (const preview of checkedPreviews) {
			await selectPanelTab(page, previewId(preview.entry), sessionId);
			const iframe = page.locator(".goal-preview-panel iframe").first();
			await expect(iframe, `${preview.entry} should use its immutable artifact rather than the mutable live mount`).toHaveAttribute(
				"src",
				new RegExp(`/_artifact/${preview.artifactId}/${preview.entry.replace(".", "\\.")}(?:\\?|$)`),
				{ timeout: 10_000 },
			);
			await expectPreviewContains(page, preview.body, `${preview.entry} should never transiently show file not found`);
		}

		await page.setViewportSize({ width: 390, height: 780 });
		const mobileBar = page.locator(".goal-tab-bar--mobile");
		await expect(mobileBar).toBeVisible({ timeout: 10_000 });
		await expect(mobileBar.locator('[data-panel-tab-kind="chat"]'), "mobile keeps Chat pinned beside desktop-style panel tabs").toBeVisible();
		const mobileMore = mobileBar.getByRole("button", { name: "More tabs" });
		await expect(mobileMore, "mobile should use the same overflow menu instead of a compressed scrolling strip").toBeVisible();
		await mobileMore.click();
		await expect(page.getByRole("menu", { name: "More side-panel tabs" })).toBeVisible();
		await page.mouse.click(4, 760);
		await expect(page.getByRole("menu", { name: "More side-panel tabs" }), "mobile outside click should dismiss the overflow menu").toBeHidden();
		const mobileOverflow = await mobileBar.evaluate((element) => element.scrollWidth - element.clientWidth);
		expect(mobileOverflow, "mobile tab chrome should not create horizontal scrolling").toBeLessThanOrEqual(1);
		const chatLabelGeometry = await mobileBar.locator('[data-panel-tab-kind="chat"] .goal-tab-pill-label').evaluate((label) => ({
			clientWidth: label.clientWidth,
			scrollWidth: label.scrollWidth,
		}));
		expect(chatLabelGeometry.clientWidth, "the pinned Chat tab should show its whole short title").toBeGreaterThanOrEqual(chatLabelGeometry.scrollWidth);
		const constrainedPanelWidths = await mobileBar.locator('[data-panel-tab-bar] > .goal-tab-pill:not([data-panel-tab-kind="chat"])').evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width));
		expect(Math.max(...constrainedPanelWidths) - Math.min(...constrainedPanelWidths), "long visible mobile tabs should share the same readable cap instead of flex-shrinking proportionally").toBeLessThanOrEqual(1);

		const mobileTarget = previews[5];
		await selectPanelTab(page, previewId(mobileTarget.entry), sessionId);
		await expectPreviewContains(page, mobileTarget.body, "mobile More-tabs selection should show the chosen preview");
		const mobileActions = mobileBar.locator(".side-panel-mobile-actions");
		const refreshPreview = mobileActions.getByTitle("Refresh preview");
		await expect(refreshPreview, "mobile should use spare tab-strip space for active preview controls").toBeVisible();
		await expect(mobileActions.getByTitle("Open preview in new tab")).toBeVisible();
		const [mobileBarBox, mobileActionsBox, moreTabsBox] = await Promise.all([
			mobileBar.boundingBox(),
			mobileActions.boundingBox(),
			mobileBar.getByRole("button", { name: "More tabs" }).boundingBox(),
		]);
		expect(mobileBarBox && mobileActionsBox ? mobileBarBox.x + mobileBarBox.width - (mobileActionsBox.x + mobileActionsBox.width) : Number.POSITIVE_INFINITY, "mobile controls should be right-aligned").toBeLessThanOrEqual(16);
		const hasTruncatedVisibleTitle = await mobileBar.locator('[data-panel-tab-bar] > .goal-tab-pill:not([data-panel-tab-kind="chat"]) .goal-tab-pill-label').evaluateAll((labels) => labels.some((label) => label.scrollWidth > label.clientWidth + 0.5));
		if (hasTruncatedVisibleTitle) {
			expect(mobileActionsBox && moreTabsBox ? mobileActionsBox.x - (moreTabsBox.x + moreTabsBox.width) : Number.POSITIVE_INFINITY, "truncated tabs should consume the usable remainder before the active-tab controls").toBeLessThanOrEqual(12);
		}
		const activePreviewFrame = page.locator(`.side-panel-pane[data-panel-tab-id="${previewId(mobileTarget.entry)}"] iframe`);
		const iframeSrcBeforeRefresh = await activePreviewFrame.getAttribute("src");
		await refreshPreview.click();
		await expect.poll(() => activePreviewFrame.getAttribute("src"), { message: "mobile Refresh preview should reload the active iframe" }).not.toBe(iframeSrcBeforeRefresh);
		const mobileSurfaces = await tabSurfaceColors(page, true);
		expect(new Set(Object.values(mobileSurfaces)).size, `mobile selected, inactive, and strip surfaces should use three shades: ${JSON.stringify(mobileSurfaces)}`).toBe(3);

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await selectPanelTab(page, previewId(mobileTarget.entry), sessionId);
		await expectPreviewContains(page, mobileTarget.body, "artifact-backed mobile selection should survive reload");
	});
});
