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

type SplitGeometry = { row: number; chat: number; panel: number };

async function splitGeometry(page: Page): Promise<SplitGeometry> {
	return page.locator(".side-panel-split-layout").evaluate((layout) => ({
		row: layout.getBoundingClientRect().width,
		chat: layout.querySelector<HTMLElement>(".side-panel-chat-pane")?.getBoundingClientRect().width ?? 0,
		panel: layout.querySelector<HTMLElement>(".side-panel-workspace")?.getBoundingClientRect().width ?? 0,
	}));
}

async function beginDividerDrag(page: Page, rawPercent?: number, pointerId = 701): Promise<void> {
	await page.getByRole("separator", { name: "Resize side panel" }).evaluate((element, input) => {
		const handle = element as HTMLElement;
		const layout = handle.closest<HTMLElement>(".side-panel-split-layout");
		const panel = layout?.querySelector<HTMLElement>(":scope > .side-panel-workspace");
		if (!layout || !panel) throw new Error("side-panel resize handle has no split geometry");
		const handleBox = handle.getBoundingClientRect();
		const layoutBox = layout.getBoundingClientRect();
		const drag = {
			layout,
			pointerId: input.pointerId,
			startX: handleBox.x + handleBox.width / 2,
			startY: handleBox.y + Math.max(handleBox.height / 2, 1),
			startPercent: panel.getBoundingClientRect().width / layoutBox.width * 100,
			layoutWidth: layoutBox.width,
		};
		(window as any).__sidePanelSpecDrag = drag;
		const dispatch = (target: EventTarget, type: string, raw: number, buttons: number) => {
			const clientX = drag.startX + (drag.startPercent - raw) * drag.layoutWidth / 100;
			target.dispatchEvent(new PointerEvent(type, {
				pointerId: drag.pointerId,
				pointerType: "touch",
				isPrimary: true,
				clientX,
				clientY: drag.startY,
				button: type === "pointerdown" || type === "pointerup" ? 0 : -1,
				buttons,
				bubbles: true,
			}));
		};
		dispatch(handle, "pointerdown", drag.startPercent, 1);
		if (input.rawPercent !== undefined) dispatch(window, "pointermove", input.rawPercent, 1);
	}, { rawPercent, pointerId });
}

async function moveDividerDrag(page: Page, rawPercent: number, pointerId = 701): Promise<void> {
	await page.evaluate(({ rawPercent, pointerId }) => {
		const drag = (window as any).__sidePanelSpecDrag;
		if (!drag || drag.pointerId !== pointerId) throw new Error("no matching side-panel spec drag");
		const clientX = drag.startX + (drag.startPercent - rawPercent) * drag.layoutWidth / 100;
		window.dispatchEvent(new PointerEvent("pointermove", {
			pointerId,
			pointerType: "touch",
			isPrimary: true,
			clientX,
			clientY: drag.startY,
			button: -1,
			buttons: 1,
			bubbles: true,
		}));
	}, { rawPercent, pointerId });
}

async function endDividerDrag(page: Page, rawPercent: number, pointerId = 701): Promise<void> {
	await page.evaluate(({ rawPercent, pointerId }) => {
		const drag = (window as any).__sidePanelSpecDrag;
		if (!drag || drag.pointerId !== pointerId) throw new Error("no matching side-panel spec drag");
		const clientX = drag.startX + (drag.startPercent - rawPercent) * drag.layoutWidth / 100;
		window.dispatchEvent(new PointerEvent("pointerup", {
			pointerId,
			pointerType: "touch",
			isPrimary: true,
			clientX,
			clientY: drag.startY,
			button: 0,
			buttons: 0,
			bubbles: true,
		}));
	}, { rawPercent, pointerId });
}

async function expectSplitPercent(page: Page, percent: number): Promise<void> {
	await expect.poll(async () => {
		const geometry = await splitGeometry(page);
		return geometry.panel / geometry.row * 100;
	}, { message: `workspace should occupy ${percent}% of the split` }).toBeCloseTo(percent, 0);
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

	test("desktop resizing persists, follows the separator APG contract, and restores a non-default split through terminal modes", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		await page.evaluate(() => localStorage.removeItem("bobbit-side-panel-width-percent"));
		await page.reload({ waitUntil: "domcontentloaded" });
		const sessionId = await createRegularSessionViaApi(page);
		await mountPreviewHtml(page, sessionId, "resizable.html", "Resizable preview");

		const handle = page.getByRole("separator", { name: "Resize side panel" });
		const splitLayout = page.locator(".side-panel-split-layout");
		await expect(handle).toBeVisible();
		await expect(handle).toHaveAttribute("aria-valuemin", "25");
		await expect(handle).toHaveAttribute("aria-valuemax", "75");
		await expect(handle).toHaveAttribute("aria-valuenow", "50");
		await expect(handle).toHaveAttribute("aria-controls", "side-panel-workspace");
		await expect(page.locator("#side-panel-workspace")).toHaveCount(1);
		expect(await page.evaluate(() => localStorage.getItem("bobbit-side-panel-width-percent")), "the even default must not manufacture a stored preference").toBeNull();
		const initial = await splitGeometry(page);
		expect(initial.panel, "the default workspace is half the row").toBeCloseTo(initial.row / 2, 0);
		expect(initial.chat, "the default chat pane is half the row").toBeCloseTo(initial.row / 2, 0);

		await beginDividerDrag(page, 63);
		await endDividerDrag(page, 63);
		await expect(handle).toHaveAttribute("aria-valuenow", "63");
		await expectSplitPercent(page, 63);
		expect(await page.evaluate(() => localStorage.getItem("bobbit-side-panel-width-percent"))).toBe("63");
		await expect.poll(async () => (await workspace(sessionId)).sizeMode).toBe("split");

		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectPreviewContains(page, "Resizable preview", "resizable preview after reload");
		await expect(handle).toHaveAttribute("aria-valuenow", "63");
		await expectSplitPercent(page, 63);

		await handle.focus();
		expect(await handle.evaluate((element) => document.activeElement === element), "the separator remains keyboard-focusable").toBe(true);
		expect(await handle.evaluate((element) => getComputedStyle(element, "::after").backgroundColor), "focus-visible must expose the divider accent").not.toBe("rgba(0, 0, 0, 0)");
		await handle.dblclick();
		await expect(handle).toHaveAttribute("aria-valuenow", "50");
		await handle.press("ArrowLeft");
		await expect(handle).toHaveAttribute("aria-valuenow", "52");
		await handle.press("Shift+ArrowLeft");
		await expect(handle).toHaveAttribute("aria-valuenow", "62");
		await handle.press("ArrowRight");
		await expect(handle).toHaveAttribute("aria-valuenow", "60");
		await handle.press("Shift+ArrowRight");
		await expect(handle).toHaveAttribute("aria-valuenow", "50");
		await handle.press("Home");
		await expect(handle).toHaveAttribute("aria-valuenow", "25");
		await handle.press("ArrowRight");
		await expect(handle, "keyboard changes clamp at the APG minimum").toHaveAttribute("aria-valuenow", "25");
		await handle.press("End");
		await expect(handle).toHaveAttribute("aria-valuenow", "75");
		await handle.press("ArrowLeft");
		await expect(handle, "keyboard changes clamp at the APG maximum").toHaveAttribute("aria-valuenow", "75");
		await handle.dblclick();
		await expectSplitPercent(page, 50);

		const [handleBox, panelBox] = await Promise.all([handle.boundingBox(), page.locator(".side-panel-workspace").boundingBox()]);
		expect(handleBox && panelBox ? handleBox.x < panelBox.x && handleBox.x + handleBox.width > panelBox.x : false,
			"the divider hit target extends into both panes and is not clipped").toBe(true);

		// Set the split restored after both terminal modes and override the live theme
		// accent so the cue assertions cannot pass on a hard-coded legacy colour.
		await beginDividerDrag(page, 63);
		await endDividerDrag(page, 63);
		await page.evaluate(() => document.documentElement.style.setProperty("--primary", "rgb(12, 34, 56)"));

		await beginDividerDrag(page, 24);
		await expect(splitLayout).toHaveAttribute("data-resize-intent", "collapse");
		await expect.poll(() => page.locator(".side-panel-workspace").evaluate((panel) => Number(getComputedStyle(panel).opacity))).toBeLessThan(0.4);
		const collapseCue = await splitLayout.evaluate((layout) => {
			const cue = getComputedStyle(layout, "::after");
			return { content: cue.content, left: cue.left, right: cue.right, background: cue.backgroundImage, animation: cue.animationName };
		});
		expect(collapseCue).toMatchObject({ content: '\"\"', right: "0px" });
		await expect.poll(() => splitLayout.evaluate((layout) => getComputedStyle(layout.querySelector(".side-panel-resize-handle")!, "::after").backgroundColor),
			{ message: "the collapse divider cue resolves the current --primary after its transition" }).toBe("rgb(12, 34, 56)");
		expect(collapseCue.left).not.toBe("0px");
		expect(collapseCue.background).toContain("linear-gradient");
		expect(collapseCue.animation).toContain("side-panel-terminal-edge-pulse");
		await moveDividerDrag(page, 25);
		await expect(splitLayout, "retreating to the inclusive bound clears the terminal cue").not.toHaveAttribute("data-resize-intent");
		await expect.poll(() => page.locator(".side-panel-workspace").evaluate((panel) => Number(getComputedStyle(panel).opacity))).toBeGreaterThan(0.9);
		await endDividerDrag(page, 25);
		await expect.poll(async () => (await workspace(sessionId)).sizeMode).toBe("split");
		await beginDividerDrag(page, 63, 706);
		await endDividerDrag(page, 63, 706);

		await beginDividerDrag(page, undefined, 702);
		await endDividerDrag(page, 24, 702);
		await expect(page.getByTestId("side-panel-restore"), "pointerup itself crossing 25 must collapse").toBeVisible();
		await expect.poll(async () => (await workspace(sessionId)).sizeMode).toBe("collapsed");
		expect(await page.evaluate(() => localStorage.getItem("bobbit-side-panel-width-percent"))).toBe("63");
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expect(page.getByTestId("side-panel-restore"), "collapsed mode survives reload").toBeVisible();
		await page.getByTestId("side-panel-restore").click();
		await expect(handle).toHaveAttribute("aria-valuenow", "63");
		await expectSplitPercent(page, 63);

		await page.evaluate(() => document.documentElement.style.setProperty("--primary", "rgb(12, 34, 56)"));
		await beginDividerDrag(page, 76, 703);
		await expect(splitLayout).toHaveAttribute("data-resize-intent", "fullscreen");
		await expect.poll(() => page.locator(".side-panel-chat-pane").evaluate((chat) => Number(getComputedStyle(chat).opacity))).toBeLessThan(0.4);
		const fullscreenCue = await splitLayout.evaluate((layout) => {
			const cue = getComputedStyle(layout, "::after");
			return { content: cue.content, left: cue.left, right: cue.right, background: cue.backgroundImage, animation: cue.animationName };
		});
		expect(fullscreenCue).toMatchObject({ content: '\"\"', left: "0px" });
		await expect.poll(() => splitLayout.evaluate((layout) => getComputedStyle(layout.querySelector(".side-panel-resize-handle")!, "::after").backgroundColor),
			{ message: "the fullscreen divider cue resolves the current --primary after its transition" }).toBe("rgb(12, 34, 56)");
		expect(fullscreenCue.right).not.toBe("0px");
		expect(fullscreenCue.background).toContain("linear-gradient");
		expect(fullscreenCue.animation).toContain("side-panel-terminal-edge-pulse");
		await moveDividerDrag(page, 75, 703);
		await expect(splitLayout, "retreating to the inclusive bound clears the fullscreen cue").not.toHaveAttribute("data-resize-intent");
		await expect.poll(() => page.locator(".side-panel-chat-pane").evaluate((chat) => Number(getComputedStyle(chat).opacity))).toBeGreaterThan(0.9);
		await endDividerDrag(page, 75, 703);
		await expect.poll(async () => (await workspace(sessionId)).sizeMode).toBe("split");

		await beginDividerDrag(page, 63, 704);
		await endDividerDrag(page, 63, 704);
		await beginDividerDrag(page, undefined, 705);
		await endDividerDrag(page, 76, 705);
		await expect(page.locator('[data-side-panel-mode="fullscreen"]'), "pointerup itself crossing 75 must enter fullscreen").toBeVisible();
		await expect.poll(async () => (await workspace(sessionId)).sizeMode).toBe("fullscreen");
		expect(await page.evaluate(() => localStorage.getItem("bobbit-side-panel-width-percent"))).toBe("63");
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""), { timeout: 20_000 }).toBe(sessionId);
		await expect(page.locator('[data-side-panel-mode="fullscreen"]'), "fullscreen mode survives reload").toBeVisible({ timeout: 20_000 });
		await page.getByTestId("side-panel-collapse").click();
		await expect(handle).toHaveAttribute("aria-valuenow", "63");
		await expectSplitPercent(page, 63);

		// Mobile keeps its full-width slider/navigation and never consumes or mutates
		// the desktop-only preference.
		await handle.press("End");
		await expect(handle).toHaveAttribute("aria-valuenow", "75");
		await page.setViewportSize({ width: 390, height: 780 });
		await expect(handle).toHaveCount(0);
		const mobileBar = page.locator(".goal-tab-bar--mobile");
		await expect(mobileBar.locator('[data-panel-tab-kind="chat"]')).toBeVisible();
		const previewTab = mobileBar.locator(`[data-panel-tab-id="${previewId("resizable.html")}"]`);
		await expect(previewTab).toBeVisible();
		const mobileGeometry = await page.locator(".side-panel-slider").evaluate((slider) => {
			const sliderBox = slider.getBoundingClientRect();
			const visiblePane = [...slider.querySelectorAll<HTMLElement>("[data-mobile-pane-key]")]
				.find((pane) => pane.getBoundingClientRect().width > 0 && getComputedStyle(pane).visibility !== "hidden");
			return { slider: sliderBox.width, pane: visiblePane?.getBoundingClientRect().width ?? 0 };
		});
		expect(mobileGeometry.slider, "the mobile slider fills the viewport-width main surface").toBeGreaterThan(350);
		expect(mobileGeometry.pane, "each mobile navigation pane remains full slider width").toBeCloseTo(mobileGeometry.slider, 0);
		await mobileBar.locator('[data-panel-tab-kind="chat"]').click();
		await expect(page.locator("textarea").first()).toBeVisible();
		await previewTab.click();
		await expectPreviewContains(page, "Resizable preview", "mobile navigation still reaches the panel");
		expect(await page.evaluate(() => localStorage.getItem("bobbit-side-panel-width-percent"))).toBe("75");
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(handle).toHaveAttribute("aria-valuenow", "75");
		await expectSplitPercent(page, 75);
	});

	test("desktop divider ignores unrelated pointers until the initiating pointer completes", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		await page.evaluate(() => localStorage.removeItem("bobbit-side-panel-width-percent"));
		await page.reload({ waitUntil: "domcontentloaded" });
		const sessionId = await createRegularSessionViaApi(page);
		await mountPreviewHtml(page, sessionId, "pointer-owner.html", "Pointer owner preview");

		const handle = page.getByRole("separator", { name: "Resize side panel" });
		await expect(handle).toHaveAttribute("aria-valuenow", "50");
		const result = await handle.evaluate((element) => {
			const handle = element as HTMLElement;
			const layout = handle.closest<HTMLElement>(".side-panel-split-layout");
			if (!layout) throw new Error("side-panel resize handle has no split layout");
			const handleBox = handle.getBoundingClientRect();
			const layoutBox = layout.getBoundingClientRect();
			const startX = handleBox.x + handleBox.width / 2;
			const startY = handleBox.y + handleBox.height / 2;
			const dispatch = (target: EventTarget, type: string, pointerId: number, clientX: number, buttons: number) => {
				target.dispatchEvent(new PointerEvent(type, {
					pointerId,
					pointerType: "touch",
					isPrimary: pointerId === 41,
					clientX,
					clientY: startY,
					button: type === "pointerdown" || type === "pointerup" ? 0 : -1,
					buttons,
					bubbles: true,
				}));
			};

			dispatch(handle, "pointerdown", 41, startX, 1);
			dispatch(window, "pointermove", 99, layoutBox.right - 1, 1);
			const afterForeignMove = {
				value: handle.getAttribute("aria-valuenow"),
				persisted: localStorage.getItem("bobbit-side-panel-width-percent"),
				intent: layout.dataset.resizeIntent ?? null,
			};
			dispatch(window, "pointerup", 99, layoutBox.right - 1, 0);
			dispatch(window, "pointercancel", 100, layoutBox.right - 1, 0);
			const afterForeignEnd = {
				cursor: document.body.style.cursor,
				userSelect: document.body.style.userSelect,
			};
			dispatch(window, "pointermove", 41, startX - 80, 1);
			const afterOwnerMove = {
				value: Number(handle.getAttribute("aria-valuenow")),
				persisted: Number(localStorage.getItem("bobbit-side-panel-width-percent")),
			};
			dispatch(window, "pointerup", 41, startX - 80, 0);
			return {
				afterForeignMove,
				afterForeignEnd,
				afterOwnerMove,
				afterOwnerEnd: {
					cursor: document.body.style.cursor,
					userSelect: document.body.style.userSelect,
				},
			};
		});

		expect(result.afterForeignMove).toEqual({ value: "50", persisted: null, intent: null });
		expect(result.afterForeignEnd).toEqual({ cursor: "col-resize", userSelect: "none" });
		expect(result.afterOwnerMove.value).toBeGreaterThan(50);
		expect(result.afterOwnerMove.persisted).toBeGreaterThan(50);
		expect(result.afterOwnerEnd).toEqual({ cursor: "", userSelect: "" });
		await expect.poll(async () => (await workspace(sessionId)).sizeMode, { timeout: 10_000 }).toBe("split");

		const preferredSplit = result.afterOwnerMove.persisted;
		const otherSessionId = await createRegularSessionViaApi(page);
		await mountPreviewHtml(page, otherSessionId, "pointer-owner-other.html", "Other pointer owner preview");
		await navigateToSession(page, sessionId);
		await expect(handle).toBeVisible();
		await handle.evaluate((element) => {
			const handle = element as HTMLElement;
			const layout = handle.closest<HTMLElement>(".side-panel-split-layout");
			if (!layout) throw new Error("side-panel resize handle has no split layout");
			const handleBox = handle.getBoundingClientRect();
			const layoutBox = layout.getBoundingClientRect();
			const startX = handleBox.x + handleBox.width / 2;
			const startY = handleBox.y + handleBox.height / 2;
			(window as any).__removedResizeLayout = layout;
			handle.dispatchEvent(new PointerEvent("pointerdown", {
				pointerId: 51,
				pointerType: "touch",
				isPrimary: true,
				clientX: startX,
				clientY: startY,
				button: 0,
				buttons: 1,
				bubbles: true,
			}));
			window.dispatchEvent(new PointerEvent("pointermove", {
				pointerId: 51,
				pointerType: "touch",
				isPrimary: true,
				clientX: layoutBox.right - 1,
				clientY: startY,
				button: -1,
				buttons: 1,
			}));
		});
		await expect(page.locator(".side-panel-split-layout")).toHaveAttribute("data-resize-intent", "collapse");
		expect(await page.evaluate(() => Number(localStorage.getItem("bobbit-side-panel-width-percent")))).toBe(25);

		await navigateToSession(page, otherSessionId);
		await expect.poll(() => page.evaluate(() => ({
			cursor: document.body.style.cursor,
			userSelect: document.body.style.userSelect,
		}))).toEqual({ cursor: "", userSelect: "" });
		const restoredPreference = await page.evaluate(() => Number(localStorage.getItem("bobbit-side-panel-width-percent")));
		expect(restoredPreference).toBeCloseTo(preferredSplit, 3);
		expect(await page.evaluate(() => (window as any).__removedResizeLayout?.dataset.resizeIntent ?? null), "navigation cleanup clears intent on the removed layout").toBeNull();
		await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerup", {
			pointerId: 51,
			pointerType: "touch",
			isPrimary: true,
			clientX: window.innerWidth - 1,
			clientY: window.innerHeight / 2,
			button: 0,
			buttons: 0,
		})));
		await expect.poll(async () => (await workspace(sessionId)).sizeMode, { timeout: 10_000 }).toBe("split");
		await expect.poll(async () => (await workspace(otherSessionId)).sizeMode, { timeout: 10_000 }).toBe("split");

		// A mode change that removes the divider must cancel before a stale owner-up
		// can reinterpret the drag as a second mode change.
		await beginDividerDrag(page, 24, 61);
		await expect(page.locator(".side-panel-split-layout")).toHaveAttribute("data-resize-intent", "collapse");
		await page.getByTestId("side-panel-fullscreen").click();
		await expect(handle).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => ({ cursor: document.body.style.cursor, userSelect: document.body.style.userSelect })))
			.toEqual({ cursor: "", userSelect: "" });
		expect(await page.evaluate(() => Number(localStorage.getItem("bobbit-side-panel-width-percent")))).toBeCloseTo(preferredSplit, 3);
		expect(await page.evaluate(() => (window as any).__sidePanelSpecDrag.layout.dataset.resizeIntent ?? null), "mode cleanup clears intent on the removed layout").toBeNull();
		await endDividerDrag(page, 24, 61);
		await expect.poll(async () => (await workspace(otherSessionId)).sizeMode).toBe("fullscreen");
		expect(await page.evaluate(() => Number(localStorage.getItem("bobbit-side-panel-width-percent")))).toBeCloseTo(preferredSplit, 3);
		await page.getByTestId("side-panel-collapse").click();
		await expect(handle).toBeVisible();

		// Crossing to mobile removes the desktop divider without changing mobile
		// navigation or allowing the stale desktop pointer to commit.
		await beginDividerDrag(page, 24, 62);
		await expect(page.locator(".side-panel-split-layout")).toHaveAttribute("data-resize-intent", "collapse");
		await page.setViewportSize({ width: 390, height: 780 });
		await expect(handle).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => ({ cursor: document.body.style.cursor, userSelect: document.body.style.userSelect })))
			.toEqual({ cursor: "", userSelect: "" });
		expect(await page.evaluate(() => Number(localStorage.getItem("bobbit-side-panel-width-percent")))).toBeCloseTo(preferredSplit, 3);
		expect(await page.evaluate(() => (window as any).__sidePanelSpecDrag.layout.dataset.resizeIntent ?? null), "mobile cleanup clears intent on the removed layout").toBeNull();
		await endDividerDrag(page, 24, 62);
		await expect.poll(async () => (await workspace(sessionId)).sizeMode).toBe("split");
		await expect.poll(async () => (await workspace(otherSessionId)).sizeMode).toBe("split");
		expect(await page.evaluate(() => Number(localStorage.getItem("bobbit-side-panel-width-percent")))).toBeCloseTo(preferredSplit, 3);

		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(handle).toBeVisible();
		await beginDividerDrag(page, 57, 63);
		await endDividerDrag(page, 57, 63);
		await expect(handle, "a fresh drag must work after every cleanup path").toHaveAttribute("aria-valuenow", "57");
		await expectSplitPercent(page, 57);
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
