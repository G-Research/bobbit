/**
 * Retained browser E2E smoke for Dynamic Chat Tabs.
 * Broad tab derivation/order/history matrices live in tests/ui-fixtures/dynamic-panel-workspace-fixture.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, sendMessage, createGoalAssistantViaUI } from "./ui-helpers.js";

const PANEL_TAB_SELECTOR = ".goal-tab-pill";
const GOAL_TAB_RE = /^Goal( Proposal)?$/i;
const PREVIEW_TAB_RE = /\.html(?:\s*\(v\d+\))?$/i;

async function sessionIdFromHash(page: Page): Promise<string> {
	return page.evaluate(() => location.hash.match(/#\/session\/([\w-]+)/)?.[1] ?? "");
}

async function openGoalAssistantProposal(page: Page): Promise<string> {
	await openApp(page);
	await createGoalAssistantViaUI(page);

	const sessionId = await sessionIdFromHash(page);
	expect(sessionId).toMatch(/^[a-f0-9-]{36}$/);

	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for dynamic chat tabs testing");
	await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		if (state) state.assistantType = "goal";
		(window as any).__bobbitRenderApp?.();
	});
	await expectGoalProposalPanel(page, "goal proposal panel should be visible before opening an HTML preview");
	return sessionId;
}

async function mountPreviewHtmlViaApi(page: Page, sessionId: string, entry: string, bodyText: string): Promise<void> {
	const baseUrl = new URL(page.url()).origin;
	const mountResp = await page.evaluate(async ({ baseUrl, sessionId, entry, bodyText }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ entry, html: `<!DOCTYPE html><html><body><h1>${bodyText}</h1></body></html>` }),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId, entry, bodyText });
	expect(mountResp.status, `preview HTML mount for ${entry} should succeed: ${mountResp.text}`).toBe(200);
	const mounted = JSON.parse(mountResp.text) as { entry?: string; mtime?: number; contentHash?: string };
	await page.evaluate(({ sessionId, entry, mtime, contentHash }) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		if (!state) return;
		const label = entry.split(/[?#]/, 1)[0].replace(/\\/g, "/").split("/").filter(Boolean).pop() || "inline.html";
		const tabId = `preview:entry:${encodeURIComponent(label)}`;
		state.isPreviewSession = true;
		state.previewPanelEntry = label;
		state.previewPanelMtime = typeof mtime === "number" ? mtime : Date.now();
		state.previewPanelContentHash = contentHash || "";
		state.panelTabsBySession ||= {};
		const tabs = Array.isArray(state.panelTabsBySession[sessionId]) ? state.panelTabsBySession[sessionId] : [];
		const tab = {
			id: tabId,
			kind: "preview",
			title: label,
			label,
			legacyTab: "preview",
			source: { type: "preview", entry: label, sessionId, live: true, contentHash },
			state: { entry: label, contentHash, historical: false },
		};
		const idx = tabs.findIndex((candidate: any) => candidate?.id === tabId);
		if (idx >= 0) tabs[idx] = { ...tabs[idx], ...tab };
		else tabs.push(tab);
		state.panelTabsBySession[sessionId] = tabs;
		state.panelTabs = tabs;
		state.panelWorkspaceActiveBySession ||= {};
		state.panelWorkspaceActiveBySession[sessionId] = tabId;
		state.activePanelTabId = tabId;
		state.previewPanelTab = "preview";
		state.previewPanelActiveTab = "preview";
		state.assistantTab = "preview";
		(window as any).__bobbitRenderApp?.();
	}, { sessionId, entry: mounted.entry || entry, mtime: mounted.mtime, contentHash: mounted.contentHash || "" });
	await expect.poll(() => page.evaluate(() => (window as any).bobbitState?.previewPanelEntry || ""), { timeout: 10_000 }).toBe(entry);
}

async function openHtmlPreviewViaPreviewOpenFlow(page: Page, sessionId: string): Promise<string> {
	const baseUrl = new URL(page.url()).origin;
	const bodyText = "Dynamic Tabs Preview Content";
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
	await mountPreviewHtmlViaApi(page, sessionId, "dynamic-tabs.html", bodyText);
	return bodyText;
}

async function visiblePanelTabs(page: Page): Promise<Array<{ index: number; label: string; id: string; kind: string }>> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button, index) => {
			const el = button as HTMLElement;
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return null;
			const label = (button.getAttribute("title") || button.textContent || "").replace(/\s+/g, " ").trim();
			return label ? { index, label, id: button.getAttribute("data-panel-tab-id") || "", kind: button.getAttribute("data-panel-tab-kind") || "" } : null;
		})
		.filter(Boolean) as Array<{ index: number; label: string; id: string; kind: string }>);
}

async function visiblePanelTabLabels(page: Page): Promise<string[]> {
	return (await visiblePanelTabs(page)).map((tab) => tab.label);
}

async function waitForGoalAndPreviewTabs(page: Page): Promise<void> {
	await expect.poll(async () => {
		const labels = await visiblePanelTabLabels(page);
		return labels.some((label) => GOAL_TAB_RE.test(label)) && labels.some((label) => PREVIEW_TAB_RE.test(label));
	}, { timeout: 10_000, message: "side panel tabs should include Goal proposal and HTML Preview" }).toBe(true);
}

async function selectTopLevelTab(page: Page, label: RegExp, errorPrefix: string): Promise<void> {
	const tabs = await visiblePanelTabs(page);
	const match = tabs.find((tab) => label.test(tab.label));
	if (!match) throw new Error(`${errorPrefix}: missing tab ${label}; visible=${tabs.map((tab) => tab.label).join(", ")}`);
	await page.locator(PANEL_TAB_SELECTOR).nth(match.index).click();
}

async function expectGoalProposalPanel(page: Page, message: string): Promise<void> {
	const titleInput = page.locator(".goal-preview-panel input[placeholder='Goal title']").first();
	await expect(titleInput, message).toBeVisible({ timeout: 15_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

async function expectPreviewContains(page: Page, expectedText: string, errorPrefix: string): Promise<void> {
	const iframe = page.locator(".goal-preview-panel iframe").first();
	await expect(iframe, `${errorPrefix}: selected HTML Preview tab should show the preview iframe`).toBeVisible({ timeout: 10_000 });
	await expect(page.frameLocator(".goal-preview-panel iframe").locator("body")).toContainText(expectedText, { timeout: 10_000 });
}

test.describe("Dynamic chat tabs", () => {
	test("goal assistant proposal and HTML preview coexist as selectable side-panel tabs @smoke", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		const sessionId = await openGoalAssistantProposal(page);
		const previewText = await openHtmlPreviewViaPreviewOpenFlow(page, sessionId);

		await waitForGoalAndPreviewTabs(page);
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_BUG");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_BUG");
		await selectTopLevelTab(page, GOAL_TAB_RE, "DYNAMIC_CHAT_TABS_BUG");
		await expectGoalProposalPanel(page, "DYNAMIC_CHAT_TABS_BUG: Goal proposal tab should remain accessible after viewing the HTML preview");
	});
});
