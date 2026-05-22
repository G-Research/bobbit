/**
 * Reproducing browser E2E for Dynamic Chat Tabs.
 *
 * A goal assistant proposal and an HTML preview must coexist as separate
 * selectable side-panel tabs. This fails on the legacy assistant-only panel
 * model because the assistant "Preview" tab is actually the proposal pane and
 * the HTML iframe is never exposed.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch, nonGitCwd } from "../e2e-setup.js";
import { openApp, sendMessage, navigateToHash } from "./ui-helpers.js";

const PANEL_TAB_SELECTOR = "button.goal-tab-pill";
const PREVIEW_OPEN_BUTTON_SELECTOR = '[data-testid="preview-open-button"]';
const GOAL_TAB_RE = /^Goal( Proposal)?$/i;
const PREVIEW_TAB_RE = /^(HTML )?Preview(:|$)/i;
const PROJECT_PROPOSAL_TAB_RE = /^Project( Proposal)?/i;
const CHAT_TAB_RE = /^Chat$/i;

const REVIEW_DOCS = [
	{ title: "Document A", body: "First document content." },
	{ title: "Document B", body: "Second document content." },
	{ title: "Document C", body: "Third document content." },
] as const;

function reviewTabRe(title: string): RegExp {
	return new RegExp(`^(Review:\\s*)?${escapeRegExp(title)}$`, "i");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function previewHtmlForBodyText(bodyText: string): string {
	return `<!DOCTYPE html><html><body><h1>${bodyText}</h1></body></html>`;
}

async function openGoalAssistantProposal(page: Page): Promise<string> {
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });

	const sessionCreated = page.waitForResponse(
		(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 60_000 },
	);
	await newGoalBtn.click();
	await sessionCreated;
	await page.waitForURL(/#\/session\//, { timeout: 10_000 });

	const sessionId = await sessionIdFromHash(page);
	expect(sessionId, "goal assistant session id should be present in the URL").toMatch(/^[a-f0-9-]{36}$/);

	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for dynamic chat tabs testing");
	await expectGoalProposalPanel(page, "goal proposal panel should be visible before opening an HTML preview");
	return sessionId;
}

async function openGoalAssistantProposalViaApi(page: Page): Promise<string> {
	await openApp(page);
	const sessionId = await createRegularSessionViaApi(page, { assistantType: "goal" });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for dynamic chat tabs mobile testing");
	await expectGoalProposalPanel(page, "mobile goal proposal panel should be visible before opening mixed tabs");
	return sessionId;
}

async function createRegularSessionViaApi(
	page: Page,
	options: { assistantType?: string } = {},
): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), ...options }),
	});
	const bodyText = await resp.text();
	expect(resp.status, `create session via API: ${bodyText}`).toBe(201);
	const sessionId = JSON.parse(bodyText).id as string;
	expect(sessionId, "API session id should be valid").toMatch(/^[a-f0-9-]{36}$/);

	await navigateToSession(page, sessionId);
	return sessionId;
}

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000, message: `selected session should be ${sessionId}` },
	).toBe(sessionId);
}

async function sessionIdFromHash(page: Page): Promise<string> {
	return page.evaluate(() => {
		const m = location.hash.match(/#\/session\/([\w-]+)/);
		return m?.[1] ?? "";
	});
}

async function expectGoalProposalPanel(page: Page, message: string): Promise<void> {
	const titleInput = page.locator(".goal-preview-panel input[placeholder='Goal title']").first();
	await expect(titleInput, message).toBeVisible({ timeout: 15_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

async function openHtmlPreviewViaPreviewOpenFlow(
	page: Page,
	sessionId: string,
	options: { entry?: string; bodyText?: string } = {},
): Promise<string> {
	const baseUrl = new URL(page.url()).origin;
	const entry = options.entry ?? "dynamic-tabs.html";
	const bodyText = options.bodyText ?? "Dynamic Tabs Preview Content";

	// Mirrors defaults/tools/html/extension.ts: PATCH preview=true, then mount
	// HTML into the per-session preview route. This drives the same client
	// preview_changed/SSE path as preview_open without needing a real agent tool.
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

	await expect.poll(
		async () => page.evaluate(() => {
			const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			return s.isPreviewSession === true;
		}),
		{ timeout: 10_000, message: "preview_open flow should mark the assistant session as a preview session" },
	).toBe(true);

	const html = previewHtmlForBodyText(bodyText);
	const mountResp = await page.evaluate(async ({ baseUrl, sessionId, entry, html }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ entry, html }),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId, entry, html });
	expect(mountResp.status, `preview mount should succeed: ${mountResp.text}`).toBe(200);

	await expect.poll(
		async () => page.evaluate(() => {
			const s: any = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			return s.previewPanelEntry || "";
		}),
		{ timeout: 10_000, message: "preview_open flow should populate the preview panel entry" },
	).toBe(entry);

	return bodyText;
}

async function visiblePanelTabLabels(page: Page): Promise<string[]> {
	return (await visiblePanelTabs(page)).map((tab) => tab.label);
}

async function visiblePanelTabs(page: Page): Promise<Array<{ index: number; label: string; title: string; id: string; kind: string; active: boolean }>> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button, index) => {
			const el = button as HTMLElement;
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return null;
			const label = (button.getAttribute("title") || button.textContent || "").replace(/\s+/g, " ").trim();
			return label ? {
				index,
				label,
				title: (button.getAttribute("data-panel-tab-title") || "").replace(/\s+/g, " ").trim(),
				id: button.getAttribute("data-panel-tab-id") || "",
				kind: button.getAttribute("data-panel-tab-kind") || "",
				active: button.classList.contains("goal-tab-pill--active"),
			} : null;
		})
		.filter(Boolean) as Array<{ index: number; label: string; title: string; id: string; kind: string; active: boolean }>);
}

async function visiblePreviewTabPresentations(page: Page): Promise<Array<{ text: string; tooltip: string; dataTitle: string; id: string }>> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button) => {
			const el = button as HTMLElement;
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return null;
			if (button.getAttribute("data-panel-tab-kind") !== "preview") return null;
			const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
			return {
				text: normalize(button.textContent),
				tooltip: normalize(button.getAttribute("title")),
				dataTitle: normalize(button.getAttribute("data-panel-tab-title")),
				id: normalize(button.getAttribute("data-panel-tab-id")),
			};
		})
		.filter(Boolean) as Array<{ text: string; tooltip: string; dataTitle: string; id: string }>);
}

async function expectPreviewTabsExposeUserFacingSourceNames(page: Page, sources: RegExp[], errorPrefix: string): Promise<void> {
	try {
		await expect.poll(async () => {
			const tabs = await visiblePreviewTabPresentations(page);
			return sources.every((source) => tabs.some((tab) => source.test(tab.text) || source.test(tab.tooltip) || source.test(tab.dataTitle)));
		}, { timeout: 5_000, message: `${errorPrefix}: preview tab text, tooltip, or data-title should include each preview artifact source` }).toBe(true);
	} catch {
		const tabs = await visiblePreviewTabPresentations(page);
		throw new Error(`${errorPrefix}: preview tabs must expose artifact-derived user-facing names; presentations=${JSON.stringify(tabs)}`);
	}
}

async function waitForGoalAndPreviewTabs(page: Page): Promise<void> {
	await waitForTopLevelTabCounts(
		page,
		[
			{ name: "Goal proposal", match: GOAL_TAB_RE, min: 1 },
			{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 1 },
		],
		"DYNAMIC_CHAT_TABS_BUG: expected side panel tabs to include a Goal proposal tab and a distinct HTML Preview tab",
		5_000,
	);
}

async function waitForTopLevelTabCounts(
	page: Page,
	expectations: Array<{ name: string; match: RegExp; min: number }>,
	errorPrefix: string,
	timeout = 10_000,
): Promise<void> {
	try {
		await expect.poll(async () => {
			const labels = await visiblePanelTabLabels(page);
			return expectations.every((expected) => labels.filter((label) => expected.match.test(label)).length >= expected.min);
		}, { timeout, message: errorPrefix }).toBe(true);
	} catch {
		const labels = await visiblePanelTabLabels(page);
		const counts = expectations
			.map((expected) => `${expected.name}=${labels.filter((label) => expected.match.test(label)).length}/${expected.min}`)
			.join(", ");
		throw new Error(`${errorPrefix}; counts: ${counts}; visible tabs were: ${labels.join(", ") || "<none>"}`);
	}
}

async function selectTopLevelTab(page: Page, label: RegExp, errorPrefix: string): Promise<string> {
	const tabs = await visiblePanelTabs(page);
	const match = tabs.find((tab) => label.test(tab.label));
	if (!match) {
		throw new Error(`${errorPrefix}: expected selectable top-level tab ${label}; visible tabs were: ${tabs.map((tab) => tab.label).join(", ") || "<none>"}`);
	}
	await clickTopLevelTabByIndex(page, match.index, errorPrefix);
	return match.label;
}

async function selectTopLevelTabByTitle(page: Page, title: RegExp, errorPrefix: string): Promise<string> {
	const tabs = await visiblePanelTabs(page);
	const match = tabs.find((tab) => title.test(tab.title));
	if (!match) {
		throw new Error(`${errorPrefix}: expected selectable top-level tab title ${title}; visible tabs were: ${tabs.map((tab) => `${tab.label} [${tab.title}]`).join(", ") || "<none>"}`);
	}
	await clickTopLevelTabByIndex(page, match.index, errorPrefix);
	return match.title;
}

async function clickTopLevelTabByIndex(page: Page, index: number, errorPrefix: string): Promise<void> {
	const tab = page.locator(PANEL_TAB_SELECTOR).nth(index);
	await tab.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "center" }));
	await expect(tab, `${errorPrefix}: preview tab at index ${index} should be visible before click`).toBeVisible({ timeout: 5_000 });
	await tab.click();
}

async function matchingTabIndexes(page: Page, label: RegExp): Promise<number[]> {
	return (await visiblePanelTabs(page))
		.filter((tab) => label.test(tab.label))
		.map((tab) => tab.index);
}

async function ensureChatInput(page: Page, errorPrefix: string): Promise<void> {
	const textarea = page.locator("textarea").first();
	if (await textarea.isVisible().catch(() => false)) return;
	await selectTopLevelTab(page, CHAT_TAB_RE, `${errorPrefix}: chat tab should be available so the test can send the next message`);
	await expect(textarea, `${errorPrefix}: chat input should be visible after selecting Chat`).toBeVisible({ timeout: 5_000 });
}

async function sendChatMessage(page: Page, text: string, errorPrefix: string): Promise<void> {
	await ensureChatInput(page, errorPrefix);
	await sendMessage(page, text);
}

async function expectGoalProposalAccessible(page: Page, errorPrefix: string): Promise<void> {
	await selectTopLevelTab(page, GOAL_TAB_RE, `${errorPrefix}: Goal proposal tab should remain selectable`);
	await expectGoalProposalPanel(page, `${errorPrefix}: Goal proposal tab should render the proposal form`);
}

async function mobileGoalFormTopGap(page: Page): Promise<{ ready: boolean; gap: number; headerHeight: number; formTop: number; headerBottom: number }> {
	return page.evaluate(() => {
		const header = document.getElementById("app-header");
		const forms = [...document.querySelectorAll(
			'[data-panel="goal-proposal"] > .overflow-y-auto, .goal-preview-panel[data-panel-tab-id] > .overflow-y-auto',
		)] as HTMLElement[];
		const form = forms.find((el) => {
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth;
		}) ?? null;
		if (!header || !form) return { ready: false, gap: 9999, headerHeight: 0, formTop: 0, headerBottom: 0 };
		const headerRect = header.getBoundingClientRect();
		const formRect = form.getBoundingClientRect();
		return {
			ready: true,
			gap: Math.round(formRect.top - headerRect.bottom),
			headerHeight: Math.round(headerRect.height),
			formTop: Math.round(formRect.top),
			headerBottom: Math.round(headerRect.bottom),
		};
	});
}

async function expectMobileGoalFormStartsBelowHeader(page: Page, errorPrefix: string): Promise<void> {
	await expect.poll(async () => (await mobileGoalFormTopGap(page)).ready, {
		timeout: 5_000,
		message: `${errorPrefix}: mobile goal proposal form should be mounted`,
	}).toBe(true);
	await expect.poll(async () => (await mobileGoalFormTopGap(page)).gap, {
		timeout: 5_000,
		message: `${errorPrefix}: mobile goal proposal form should not be double-padded below the fixed header`,
	}).toBeLessThan(48);
	const diagnostics = await mobileGoalFormTopGap(page);
	expect(
		diagnostics.gap,
		`${errorPrefix}: mobile goal proposal form should start below the fixed header; diagnostics=${JSON.stringify(diagnostics)}`,
	).toBeGreaterThanOrEqual(-2);
}

async function expectPreviewContains(page: Page, expectedText: string, errorPrefix: string): Promise<void> {
	const iframe = page.locator(".goal-preview-panel iframe").first();
	await expect(iframe, `${errorPrefix}: selecting the HTML Preview tab should show the preview iframe`).toBeVisible({ timeout: 10_000 });
	await expect(
		page.frameLocator(".goal-preview-panel iframe").locator("body"),
		`${errorPrefix}: selected HTML Preview tab should load the expected preview content`,
	).toContainText(expectedText, { timeout: 10_000 });
}

async function rawPreviewBodyText(page: Page): Promise<string> {
	return (await page.frameLocator(".goal-preview-panel iframe").locator("body").textContent({ timeout: 500 }).catch(() => "") || "").trim();
}

async function collectPreviewTabTexts(page: Page, expectedCount: number, errorPrefix: string): Promise<string[]> {
	const previewTabIndexes = await matchingTabIndexes(page, PREVIEW_TAB_RE);
	if (previewTabIndexes.length < expectedCount) {
		const labels = await visiblePanelTabLabels(page);
		throw new Error(`${errorPrefix}: expected at least ${expectedCount} preview tabs, found ${previewTabIndexes.length}; visible tabs were: ${labels.join(", ") || "<none>"}`);
	}

	const texts: string[] = [];
	for (let i = 0; i < expectedCount; i++) {
		const beforeText = await rawPreviewBodyText(page);
		await clickTopLevelTabByIndex(page, previewTabIndexes[i], errorPrefix);
		if (beforeText && i > 0) {
			await expect.poll(() => rawPreviewBodyText(page), {
				timeout: 5_000,
				message: `${errorPrefix}: selecting preview tab ${i + 1} should switch away from the previous preview content`,
			}).not.toBe(beforeText);
		}
		await expect.poll(() => rawPreviewBodyText(page), {
			timeout: 10_000,
			message: `${errorPrefix}: preview tab ${i + 1} should render non-empty iframe content`,
		}).not.toBe("");
		texts.push(await rawPreviewBodyText(page));
	}
	return texts;
}

async function openPreviewSnapshotToolCard(page: Page, size: number, ordinal: number, errorPrefix: string): Promise<string> {
	const expectedText = "x".repeat(size);
	await ensureChatInput(page, errorPrefix);
	const beforeCount = await page.locator(PREVIEW_OPEN_BUTTON_SELECTOR).count();
	await sendMessage(page, `PREVIEW_OPEN_SNAPSHOT SIZE=${size}`);
	await expect(
		page.locator(PREVIEW_OPEN_BUTTON_SELECTOR),
		`${errorPrefix}: preview_open tool card ${ordinal} should render its own Open button`,
	).toHaveCount(beforeCount + 1, { timeout: 15_000 });

	const button = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR).nth(beforeCount);
	await button.scrollIntoViewIfNeeded();
	await expect(button, `${errorPrefix}: preview_open tool card ${ordinal} Open button should be enabled`).toBeEnabled({ timeout: 5_000 });
	await button.click();
	await expect(button, `${errorPrefix}: clicking preview_open tool card ${ordinal} should acknowledge that it opened`).toHaveText(/Opened/, { timeout: 5_000 });
	await expectPreviewContains(page, expectedText, `${errorPrefix}: opening preview_open tool card ${ordinal} should select that snapshot immediately`);
	return expectedText;
}

async function appendSyntheticToolCard(
	page: Page,
	args: { toolId: string; toolName: string; input: Record<string, unknown>; resultContent: string[] },
): Promise<void> {
	await page.evaluate(({ toolId, toolName, input, resultContent }) => {
		const agent = (window as any).bobbitState?.remoteAgent;
		if (!agent?.appendMessage) throw new Error("remote agent is not ready for synthetic tool card injection");
		const now = Date.now();
		agent.appendMessage({
			id: `assistant-${toolId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: toolId, name: toolName, arguments: input, input }],
			timestamp: now,
		});
		agent.appendMessage({
			id: `tool-result-${toolId}`,
			role: "toolResult",
			toolCallId: toolId,
			toolName,
			isError: false,
			content: resultContent.map((text) => ({ type: "text", text })),
			timestamp: now + 1,
		});
	}, args);
}

async function mountV3PreviewEntry(page: Page, sessionId: string, entry: string, bodyText: string): Promise<{ url: string; path: string; entry: string; contentHash: string }> {
	const baseUrl = new URL(page.url()).origin;
	const html = previewHtmlForBodyText(bodyText);
	const result = await page.evaluate(async ({ baseUrl, sessionId, entry, html }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ entry, html }),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId, entry, html });
	expect(result.status, `mount v3 preview entry ${entry}: ${result.text}`).toBe(200);
	const parsed = JSON.parse(result.text) as { url: string; path?: string; relPath?: string; entry: string; contentHash?: string };
	expect(parsed.contentHash, `mount v3 preview entry ${entry} should return contentHash`).toMatch(/^[a-f0-9]{64}$/);
	return { url: parsed.url, path: parsed.relPath || parsed.path || `${sessionId}/${entry}`, entry: parsed.entry, contentHash: parsed.contentHash! };
}

async function appendV3PreviewToolCard(page: Page, sessionId: string, toolId: string, entry: string, bodyText: string): Promise<string> {
	const mounted = await mountV3PreviewEntry(page, sessionId, entry, bodyText);
	const snapshot = `__preview_snapshot_v3__\n${JSON.stringify({ kind: "preview", url: mounted.url, path: mounted.path })}\n`;
	await appendSyntheticToolCard(page, {
		toolId,
		toolName: "preview_open",
		input: {},
		resultContent: ["Preview panel is open and will auto-update.", snapshot],
	});
	return bodyText;
}

type PreviewMountSnapshot = { url: string; path: string; entry: string; contentHash: string };

async function getCurrentPreviewMountSnapshot(page: Page, sessionId: string): Promise<PreviewMountSnapshot> {
	const baseUrl = new URL(page.url()).origin;
	const result = await page.evaluate(async ({ baseUrl, sessionId }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "GET",
			credentials: "include",
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId });
	expect(result.status, `GET current preview mount should succeed: ${result.text}`).toBe(200);
	const parsed = JSON.parse(result.text) as { url: string; path?: string; relPath?: string; entry: string; contentHash?: string };
	expect(parsed.contentHash, `GET current preview mount should include contentHash: ${result.text}`).toMatch(/^[a-f0-9]{64}$/);
	return {
		url: parsed.url,
		path: parsed.relPath || parsed.path || `${sessionId}/${parsed.entry}`,
		entry: parsed.entry,
		contentHash: parsed.contentHash!,
	};
}

function v3SnapshotBlock(mounted: PreviewMountSnapshot): string {
	return `__preview_snapshot_v3__\n${JSON.stringify({ kind: "preview", url: mounted.url, path: mounted.path, contentHash: mounted.contentHash })}\n`;
}

function previewToolCardMessages(toolId: string, input: Record<string, unknown>, snapshot: string): any[] {
	const now = Date.now();
	return [
		{
			id: `assistant-${toolId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: toolId, name: "preview_open", arguments: input, input }],
			timestamp: now,
		},
		{
			id: `tool-result-${toolId}`,
			role: "toolResult",
			toolCallId: toolId,
			toolName: "preview_open",
			isError: false,
			content: [
				{ type: "text", text: "Preview panel is open and will auto-update." },
				{ type: "text", text: snapshot },
			],
			timestamp: now + 1,
		},
	];
}

function v3PreviewToolCardMessages(toolId: string, mounted: PreviewMountSnapshot, bodyText: string): any[] {
	return previewToolCardMessages(toolId, { html: previewHtmlForBodyText(bodyText) }, v3SnapshotBlock(mounted));
}

function legacyV1InlinePreviewToolCardMessages(toolId: string, bodyText: string): any[] {
	const html = previewHtmlForBodyText(bodyText);
	return previewToolCardMessages(toolId, { html }, `__preview_snapshot_v1__\n${html}`);
}

function legacyV2FilePreviewToolCardMessages(toolId: string, filePath: string): any[] {
	return previewToolCardMessages(
		toolId,
		{ file: filePath },
		`__preview_snapshot_v2__\n${JSON.stringify({ kind: "file", path: filePath })}\n`,
	);
}

async function setMockTranscript(gateway: any, sessionId: string, messages: any[]): Promise<void> {
	const session = gateway.sessionManager?.getSession(sessionId);
	if (!session) throw new Error(`session ${sessionId} not found`);
	const mockAgent = session.rpcClient?._agent;
	if (!mockAgent || !Array.isArray(mockAgent.conversationMessages)) {
		throw new Error("expected in-process mock agent with conversationMessages");
	}
	mockAgent.conversationMessages = messages;
}

async function refreshTranscriptFromGateway(page: Page, expectedOpenButtons: number, errorPrefix: string): Promise<void> {
	await expect.poll(async () => {
		await page.evaluate(() => {
			const agent = (window as any).bobbitState?.remoteAgent;
			if (agent?.requestMessages) agent.requestMessages();
		});
		return page.locator(PREVIEW_OPEN_BUTTON_SELECTOR).count();
	}, {
		timeout: 15_000,
		message: `${errorPrefix}: expected persisted preview_open tool cards to hydrate from the server transcript`,
	}).toBe(expectedOpenButtons);
}

async function expectOnlyLivePreviewTab(page: Page, errorPrefix: string): Promise<void> {
	await expect.poll(async () => (await visiblePanelTabs(page))
		.filter((tab) => tab.kind === "preview")
		.map((tab) => tab.id)
		.sort(), {
		timeout: 10_000,
		message: `${errorPrefix}: matching historical preview should collapse to the single live preview tab`,
	}).toEqual(["preview:live"]);
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.activePanelTabId ?? ""),
		{ timeout: 5_000, message: `${errorPrefix}: collapsed preview should select the live preview tab` },
	).toBe("preview:live");
}

async function expectPreviewTabCount(page: Page, expectedCount: number, errorPrefix: string): Promise<void> {
	await expect.poll(async () => (await visiblePanelTabs(page)).filter((tab) => tab.kind === "preview").length, {
		timeout: 10_000,
		message: `${errorPrefix}: expected ${expectedCount} visible preview tabs`,
	}).toBe(expectedCount);
}

async function expectAtLeastPreviewTabCount(page: Page, expectedCount: number, errorPrefix: string): Promise<void> {
	await expect.poll(async () => (await visiblePanelTabs(page)).filter((tab) => tab.kind === "preview").length, {
		timeout: 10_000,
		message: `${errorPrefix}: expected at least ${expectedCount} visible preview tabs`,
	}).toBeGreaterThanOrEqual(expectedCount);
}

async function expectLegacyPreviewTabsRemainSeparate(page: Page, expectedTexts: string[], errorPrefix: string): Promise<void> {
	await expect.poll(async () => (await visiblePanelTabs(page))
		.filter((tab) => tab.kind === "preview" && tab.id !== "preview:live").length, {
		timeout: 10_000,
		message: `${errorPrefix}: legacy preview snapshots should remain historical tabs, not collapse into only preview:live`,
	}).toBeGreaterThanOrEqual(expectedTexts.length);
	const previewTabs = (await visiblePanelTabs(page)).filter((tab) => tab.kind === "preview");
	expect(
		previewTabs.map((tab) => tab.id),
		`${errorPrefix}: legacy preview tabs collapsed incorrectly; tabs=${JSON.stringify(previewTabs)}`,
	).not.toEqual(["preview:live"]);
	const previewTabTexts = await collectAllPreviewTabTexts(page, errorPrefix);
	for (const expectedText of expectedTexts) {
		expect(
			previewTabTexts.some((text) => text.includes(expectedText)),
			`${errorPrefix}: no legacy preview tab restored ${expectedText}; texts=${JSON.stringify(previewTabTexts)}`,
		).toBe(true);
	}
}

async function openLegacyPreviewToolCardAndExpectMountHash(page: Page, ordinal: number, expectedText: string, errorPrefix: string): Promise<string> {
	const button = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR).nth(ordinal);
	await button.scrollIntoViewIfNeeded();
	await expect(button, `${errorPrefix}: legacy preview_open tool card ${ordinal + 1} Open button should be enabled`).toBeEnabled({ timeout: 5_000 });
	const responsePromise = page.waitForResponse(
		(response) => response.url().includes("/api/preview/mount") && response.request().method() === "POST" && response.ok(),
		{ timeout: 15_000 },
	);
	await button.click();
	const response = await responsePromise;
	const body = await response.json() as { contentHash?: unknown };
	const contentHash = typeof body.contentHash === "string" ? body.contentHash : "";
	expect(contentHash, `${errorPrefix}: legacy remount POST should still return contentHash`).toMatch(/^[a-f0-9]{64}$/);
	await expect(button, `${errorPrefix}: clicking legacy preview_open tool card ${ordinal + 1} should acknowledge that it opened`).toHaveText(/Opened/, { timeout: 5_000 });
	await expectPreviewContains(page, expectedText, `${errorPrefix}: opening legacy preview_open tool card ${ordinal + 1} should select that snapshot immediately`);
	return contentHash;
}

async function collectAllPreviewTabTexts(page: Page, errorPrefix: string): Promise<string[]> {
	const previewTabIndexes = await matchingTabIndexes(page, PREVIEW_TAB_RE);
	if (previewTabIndexes.length === 0) {
		const labels = await visiblePanelTabLabels(page);
		throw new Error(`${errorPrefix}: expected at least one preview tab; visible tabs were: ${labels.join(", ") || "<none>"}`);
	}
	const texts: string[] = [];
	for (const index of previewTabIndexes) {
		await clickTopLevelTabByIndex(page, index, errorPrefix);
		await expect.poll(() => rawPreviewBodyText(page), {
			timeout: 10_000,
			message: `${errorPrefix}: preview tab ${index} should render non-empty iframe content`,
		}).not.toBe("");
		texts.push(await rawPreviewBodyText(page));
	}
	return texts;
}

async function reloadAndNavigateToSession(page: Page, sessionId: string): Promise<void> {
	await page.reload({ waitUntil: "domcontentloaded" });
	await navigateToSession(page, sessionId);
}

async function deliverReviewToolResult(page: Page, payload: Record<string, unknown>): Promise<void> {
	await page.evaluate((payload) => {
		const agent = (window as any).bobbitState?.remoteAgent;
		if (!agent?._checkReviewToolResult) throw new Error("remote agent review parser is not ready");
		agent._checkReviewToolResult({
			role: "toolResult",
			content: [{ type: "text", text: JSON.stringify(payload) }],
		}, true);
	}, payload);
}

async function seedProjectProposalRevision(page: Page, sessionId: string, fields: Record<string, unknown>): Promise<number> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/proposal/project/seed`, {
		method: "POST",
		body: JSON.stringify({ args: fields }),
	});
	const text = await resp.text();
	expect(resp.status, `seed project proposal revision: ${text}`).toBe(200);
	const body = JSON.parse(text) as { rev?: number };
	expect(typeof body.rev, `seed response should include rev: ${text}`).toBe("number");
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.project?.rev ?? 0),
		{ timeout: 10_000, message: `project proposal rev ${body.rev} should hydrate in the UI` },
	).toBe(body.rev);
	return body.rev!;
}

async function appendProjectProposalToolCard(page: Page, toolId: string, fields: Record<string, unknown>, rev: number): Promise<void> {
	await appendSyntheticToolCard(page, {
		toolId,
		toolName: "propose_project",
		input: fields,
		resultContent: [`Project proposal submitted.\n__proposal_rev_v1__:${rev}`],
	});
}

async function expectReviewDocumentAccessible(page: Page, title: string, body: string, errorPrefix: string): Promise<void> {
	await selectTopLevelTab(page, reviewTabRe(title), `${errorPrefix}: review document tab ${title} should be selectable`);
	await expect(page.locator("review-document").first(), `${errorPrefix}: selecting ${title} should show a review document`).toBeVisible({ timeout: 5_000 });
	await expect(
		page.locator("review-document").getByText(body).first(),
		`${errorPrefix}: selecting ${title} should show its document body`,
	).toBeVisible({ timeout: 5_000 });
}

async function setupMobileEmulation(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const orig = window.matchMedia;
		window.matchMedia = function (q: string) {
			if (q === "(pointer: coarse)") {
				return {
					matches: true,
					media: q,
					addEventListener: () => {},
					removeEventListener: () => {},
					addListener: () => {},
					removeListener: () => {},
					onchange: null,
					dispatchEvent: () => true,
				} as unknown as MediaQueryList;
			}
			return orig.call(window, q);
		};
	});
}

async function mobileTabBarDiagnostics(page: Page): Promise<{ labels: string[]; scrollWidth: number; clientWidth: number; hasHorizontalAccess: boolean; reason: string }> {
	return page.evaluate(() => {
		const normalize = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
		const bars = [...document.querySelectorAll(".goal-tab-bar")].map((bar) => {
			const labels = [...bar.querySelectorAll("button.goal-tab-pill")].map((button) => normalize(button.getAttribute("title") || button.textContent));
			const hasGoal = labels.some((label) => /^Goal( Proposal)?$/i.test(label));
			const hasPreview = labels.some((label) => /^(HTML )?Preview(:|$)/i.test(label));
			const reviewCount = labels.filter((label) => /^(Review:\s*)?Document [ABC]$/i.test(label)).length;
			return {
				labels,
				scrollWidth: (bar as HTMLElement).scrollWidth,
				clientWidth: (bar as HTMLElement).clientWidth,
				matchesMixedTabs: hasGoal && hasPreview && reviewCount >= 3,
			};
		});
		const selected = bars.find((bar) => bar.matchesMixedTabs) ?? bars.sort((a, b) => b.labels.length - a.labels.length)[0];
		if (!selected) return { labels: [], scrollWidth: 0, clientWidth: 0, hasHorizontalAccess: false, reason: "no .goal-tab-bar found" };
		return {
			labels: selected.labels,
			scrollWidth: selected.scrollWidth,
			clientWidth: selected.clientWidth,
			hasHorizontalAccess: selected.matchesMixedTabs && selected.scrollWidth > selected.clientWidth + 1,
			reason: selected.matchesMixedTabs ? "mixed tab bar selected" : "no tab bar contained the full mixed tab set",
		};
	});
}

async function expectMobileHorizontalTabAccess(page: Page, errorPrefix: string): Promise<void> {
	try {
		await expect.poll(async () => (await mobileTabBarDiagnostics(page)).hasHorizontalAccess, {
			timeout: 5_000,
			message: `${errorPrefix}: mobile mixed tabs should be reachable through horizontal tab-bar overflow`,
		}).toBe(true);
	} catch {
		const diagnostics = await mobileTabBarDiagnostics(page);
		throw new Error(`${errorPrefix}: expected mobile mixed tabs to have horizontal tab access; diagnostics=${JSON.stringify(diagnostics)}`);
	}
}

test.describe("Dynamic chat tabs", () => {
	test("goal assistant proposal and HTML preview coexist as selectable side-panel tabs", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		const sessionId = await openGoalAssistantProposal(page);
		const previewText = await openHtmlPreviewViaPreviewOpenFlow(page, sessionId);

		await waitForGoalAndPreviewTabs(page);

		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_BUG");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_BUG");

		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_BUG: Goal proposal tab should remain accessible after viewing the HTML preview");
	});

	test("multiple preview_open tool cards reopen distinct preview tabs without hiding the proposal", async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openGoalAssistantProposal(page);
		const firstPreviewText = await openPreviewSnapshotToolCard(page, 11, 1, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");
		const secondPreviewText = await openPreviewSnapshotToolCard(page, 29, 2, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");

		await waitForTopLevelTabCounts(
			page,
			[
				{ name: "Goal proposal", match: GOAL_TAB_RE, min: 1 },
				{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 },
			],
			"DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: expected two distinct top-level preview tabs plus the Goal proposal tab after opening two preview_open tool cards",
		);

		const previewTabTexts = await collectPreviewTabTexts(page, 2, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");
		expect(
			previewTabTexts.some((text) => text.includes(firstPreviewText)),
			`DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: no selectable preview tab rendered the first preview_open snapshot; tab texts were ${JSON.stringify(previewTabTexts)}`,
		).toBe(true);
		expect(
			previewTabTexts.some((text) => text.includes(secondPreviewText)),
			`DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: no selectable preview tab rendered the second preview_open snapshot; tab texts were ${JSON.stringify(previewTabTexts)}`,
		).toBe(true);

		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG");

		const buttons = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR);
		await buttons.nth(0).scrollIntoViewIfNeeded();
		await buttons.nth(0).click();
		await expectPreviewContains(page, firstPreviewText, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: reopening the first preview_open tool card should restore the first snapshot");
		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: Goal proposal tab should remain accessible after reopening the first preview snapshot");

		await buttons.nth(1).scrollIntoViewIfNeeded();
		await buttons.nth(1).click();
		await expectPreviewContains(page, secondPreviewText, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: reopening the second preview_open tool card should restore the second snapshot");
		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MULTIPREVIEW_BUG: Goal proposal tab should remain accessible after reopening the second preview snapshot");
	});

	test("per-session workspaces isolate historical preview tabs and restore them when switching back", async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		const sessionA = await createRegularSessionViaApi(page);
		const firstPreviewText = await openPreviewSnapshotToolCard(page, 13, 1, "DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG");
		const secondPreviewText = await openPreviewSnapshotToolCard(page, 31, 2, "DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG");
		await waitForTopLevelTabCounts(
			page,
			[{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 }],
			"DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG: session A should expose both historical preview tabs before switching away",
		);

		const sessionB = await createRegularSessionViaApi(page);
		await expect.poll(
			async () => (await visiblePanelTabLabels(page)).filter((label) => PREVIEW_TAB_RE.test(label)).length,
			{ timeout: 5_000, message: "DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG: session B must not inherit session A preview tabs" },
		).toBe(0);

		await sendChatMessage(page, "REVIEW_OPEN", "DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG");
		await expect(page.getByText("Done. Used review_open tool.").first(), "DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG: review_open should finish before asserting session B tabs").toBeVisible({ timeout: 15_000 });
		await expectReviewDocumentAccessible(page, "Test Document", "Some important text", "DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG: session B review should be available only in session B");

		await navigateToSession(page, sessionA);
		await waitForTopLevelTabCounts(
			page,
			[{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 }],
			"DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG: switching back to session A should restore its historical preview tabs",
		);
		await expect.poll(
			async () => (await visiblePanelTabLabels(page)).filter((label) => reviewTabRe("Test Document").test(label)).length,
			{ timeout: 5_000, message: "DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG: session B review tab must not bleed back into session A" },
		).toBe(0);
		const restoredTexts = await collectPreviewTabTexts(page, 2, "DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG");
		expect(restoredTexts.some((text) => text.includes(firstPreviewText))).toBe(true);
		expect(restoredTexts.some((text) => text.includes(secondPreviewText))).toBe(true);

		await navigateToSession(page, sessionB);
		await expectReviewDocumentAccessible(page, "Test Document", "Some important text", "DYNAMIC_CHAT_TABS_SESSION_ISOLATION_BUG: switching back to session B should restore its own review tab");
	});

	test("review document titles with reserved characters stay selectable after close and reopen", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		await createRegularSessionViaApi(page);
		const reservedTitle = "Doc / A?x#y%";
		await deliverReviewToolResult(page, {
			action: "review_open",
			title: reservedTitle,
			markdown: `# ${reservedTitle}\n\nReserved title body.`,
			replace: true,
		});
		await deliverReviewToolResult(page, {
			action: "review_open",
			title: "Plain Doc",
			markdown: "# Plain Doc\n\nPlain body.",
			replace: true,
		});

		await waitForTopLevelTabCounts(
			page,
			[
				{ name: "Reserved review", match: reviewTabRe(reservedTitle), min: 1 },
				{ name: "Plain review", match: reviewTabRe("Plain Doc"), min: 1 },
			],
			"DYNAMIC_CHAT_TABS_REVIEW_RESERVED_BUG: reserved-character and plain review docs should both be top-level tabs",
		);
		await expectReviewDocumentAccessible(page, reservedTitle, "Reserved title body.", "DYNAMIC_CHAT_TABS_REVIEW_RESERVED_BUG");
		await expectReviewDocumentAccessible(page, "Plain Doc", "Plain body.", "DYNAMIC_CHAT_TABS_REVIEW_RESERVED_BUG");

		await expectReviewDocumentAccessible(page, reservedTitle, "Reserved title body.", "DYNAMIC_CHAT_TABS_REVIEW_RESERVED_BUG: reserved title should be active before close");
		await page.locator("review-pane button.review-tab", { hasText: reservedTitle }).locator(".review-tab-close").click();
		await expect.poll(
			async () => (await visiblePanelTabLabels(page)).filter((label) => reviewTabRe(reservedTitle).test(label)).length,
			{ timeout: 10_000, message: "DYNAMIC_CHAT_TABS_REVIEW_RESERVED_BUG: closing the reserved title should remove its top-level tab" },
		).toBe(0);

		await deliverReviewToolResult(page, {
			action: "review_open",
			title: reservedTitle,
			markdown: `# ${reservedTitle}\n\nReserved title body reopened.`,
			replace: true,
		});
		await waitForTopLevelTabCounts(
			page,
			[{ name: "Reserved review", match: reviewTabRe(reservedTitle), min: 1 }],
			"DYNAMIC_CHAT_TABS_REVIEW_RESERVED_BUG: reopening the reserved title should recreate one selectable top-level tab",
		);
		await expectReviewDocumentAccessible(page, reservedTitle, "Reserved title body reopened.", "DYNAMIC_CHAT_TABS_REVIEW_RESERVED_BUG");
	});

	test("multiple preview tabs expose source-derived visible labels or tooltips", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		await appendV3PreviewToolCard(page, sessionId, "tool-label-a", "label-a.html", "Preview Label A Content");
		await appendV3PreviewToolCard(page, sessionId, "tool-label-b", "label-b.html", "Preview Label B Content");

		const buttons = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR);
		await expect(buttons, "DYNAMIC_CHAT_TABS_PREVIEW_LABEL_BUG: two preview_open tool cards should render Open buttons").toHaveCount(2, { timeout: 15_000 });
		await buttons.nth(0).click();
		await buttons.nth(1).click();

		await waitForTopLevelTabCounts(
			page,
			[{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 }],
			"DYNAMIC_CHAT_TABS_PREVIEW_LABEL_BUG: opening two preview artifacts should expose two preview tabs",
		);
		await expectPreviewTabsExposeUserFacingSourceNames(
			page,
			[/^Preview:\s*label-a\.html(?:\s+\(snapshot\))?$/i, /^Preview:\s*label-b\.html(?:\s+\(snapshot\))?$/i],
			"DYNAMIC_CHAT_TABS_PREVIEW_LABEL_BUG",
		);
	});

	test("same-name live and historical preview tabs are visually disambiguated", async ({ page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		await openHtmlPreviewViaPreviewOpenFlow(page, sessionId, {
			entry: "inline.html",
			bodyText: "Live Inline Preview Content",
		});
		await appendV3PreviewToolCard(page, sessionId, "tool-inline-snapshot", "inline.html", "Historical Inline Preview Content");

		const buttons = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR);
		await expect(buttons, "DYNAMIC_CHAT_TABS_PREVIEW_DUPLICATE_LABEL_BUG: inline preview tool card should render an Open button").toHaveCount(1, { timeout: 15_000 });
		await buttons.first().click();

		await waitForTopLevelTabCounts(
			page,
			[{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 }],
			"DYNAMIC_CHAT_TABS_PREVIEW_DUPLICATE_LABEL_BUG: live and historical inline previews should both be selectable",
		);
		const labels = (await visiblePreviewTabPresentations(page)).map((tab) => tab.text || tab.tooltip);
		expect(labels, `DYNAMIC_CHAT_TABS_PREVIEW_DUPLICATE_LABEL_BUG: preview labels were ${JSON.stringify(labels)}`).toContain("Preview: inline.html");
		expect(labels, `DYNAMIC_CHAT_TABS_PREVIEW_DUPLICATE_LABEL_BUG: preview labels were ${JSON.stringify(labels)}`).toContain("Preview: inline.html (snapshot)");
		expect(new Set(labels).size, `DYNAMIC_CHAT_TABS_PREVIEW_DUPLICATE_LABEL_BUG: duplicate preview labels: ${JSON.stringify(labels)}`).toBe(labels.length);
	});

	test("legacy v1 and v2 preview_open snapshots remain distinct across reload", async ({ page, gateway }, testInfo) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		const legacyInlineText = "Legacy V1 Inline Preview Content";
		const legacyFileText = "Legacy V2 File Preview Content";
		const legacyFilePath = testInfo.outputPath("legacy-v2-preview.html");
		await mkdir(dirname(legacyFilePath), { recursive: true });
		await writeFile(legacyFilePath, previewHtmlForBodyText(legacyFileText), "utf8");

		await setMockTranscript(gateway, sessionId, [
			...legacyV1InlinePreviewToolCardMessages("tool-legacy-v1-inline", legacyInlineText),
			...legacyV2FilePreviewToolCardMessages("tool-legacy-v2-file", legacyFilePath),
		]);
		await refreshTranscriptFromGateway(page, 2, "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG");

		const firstHash = await openLegacyPreviewToolCardAndExpectMountHash(page, 0, legacyInlineText, "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG");
		const secondHash = await openLegacyPreviewToolCardAndExpectMountHash(page, 1, legacyFileText, "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG");
		expect(firstHash, "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG: fixtures should produce distinct legacy remount hashes").not.toBe(secondHash);
		await expectLegacyPreviewTabsRemainSeparate(page, [legacyInlineText, legacyFileText], "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG");

		await reloadAndNavigateToSession(page, sessionId);
		await refreshTranscriptFromGateway(page, 2, "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG: after reload");
		await openLegacyPreviewToolCardAndExpectMountHash(page, 0, legacyInlineText, "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG: after reload");
		await openLegacyPreviewToolCardAndExpectMountHash(page, 1, legacyFileText, "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG: after reload");
		await expectLegacyPreviewTabsRemainSeparate(page, [legacyInlineText, legacyFileText], "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG: after reload");

		// Preview tabs currently have no per-tab close affordance. Switching away
		// and back is the available cleanup/non-collapse path for legacy history.
		await ensureChatInput(page, "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG: cleanup/no-collapse check");
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG: Preview should remain selectable for cleanup check");
		await expectLegacyPreviewTabsRemainSeparate(page, [legacyInlineText, legacyFileText], "DYNAMIC_CHAT_TABS_LEGACY_PREVIEW_BUG: cleanup/no-collapse check");
	});

	test("same-content historical v3 first-open collapses to the live preview tab", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		const previewText = await openHtmlPreviewViaPreviewOpenFlow(page, sessionId, {
			entry: "inline.html",
			bodyText: "Content Hash Same Preview Content",
		});
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: live preview tab should be selectable before opening history");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: live preview should be populated before opening matching history");

		const mounted = await getCurrentPreviewMountSnapshot(page, sessionId);
		await setMockTranscript(gateway, sessionId, v3PreviewToolCardMessages("tool-v3-same-hash", mounted, previewText));
		await refreshTranscriptFromGateway(page, 1, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG");

		let remountPosts = 0;
		page.on("request", (request) => {
			if (request.method() === "POST" && request.url().includes("/api/preview/mount")) remountPosts += 1;
		});

		const button = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR).first();
		await button.scrollIntoViewIfNeeded();
		await button.click();
		await expect(button, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: matching v3 preview should open without stale-file failure").toHaveText(/Opened/, { timeout: 5_000 });
		expect(remountPosts, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: matching contentHash should skip the remount POST").toBe(0);
		await expect(page.getByText("File no longer available"), "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: matching live content must not surface stale-file text").toHaveCount(0);
		await expectOnlyLivePreviewTab(page, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: collapsed live preview should still load the matching content");

		await reloadAndNavigateToSession(page, sessionId);
		await refreshTranscriptFromGateway(page, 1, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: after reload");
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: live preview tab should remain selectable after reload");
		await expectOnlyLivePreviewTab(page, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: after reload");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: live preview content should survive reload");

		await ensureChatInput(page, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: cleanup/no-duplicate check");
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: returning to Preview should not create duplicate history");
		await expectOnlyLivePreviewTab(page, "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: after Chat/Preview cleanup check");
		await expect(page.getByText("File no longer available"), "DYNAMIC_CHAT_TABS_V3_SAME_HASH_BUG: stale-file text should remain absent after reload cleanup").toHaveCount(0);
	});

	test("different-content historical v3 previews remain separately restorable across reload", async ({ page, gateway }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		const firstPreviewText = "Content Hash Preview A Content";
		const secondPreviewText = "Content Hash Preview B Content";
		const firstMounted = await mountV3PreviewEntry(page, sessionId, "inline.html", firstPreviewText);
		const secondMounted = await mountV3PreviewEntry(page, sessionId, "inline.html", secondPreviewText);
		expect(firstMounted.contentHash, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: fixtures should have different v3 content hashes").not.toBe(secondMounted.contentHash);

		await setMockTranscript(gateway, sessionId, [
			...v3PreviewToolCardMessages("tool-v3-different-a", firstMounted, firstPreviewText),
			...v3PreviewToolCardMessages("tool-v3-different-b", secondMounted, secondPreviewText),
		]);
		await refreshTranscriptFromGateway(page, 2, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG");

		const buttons = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR);
		await buttons.nth(0).scrollIntoViewIfNeeded();
		await buttons.nth(0).click();
		await expectPreviewContains(page, firstPreviewText, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: opening preview A should select A content");
		await buttons.nth(1).scrollIntoViewIfNeeded();
		await buttons.nth(1).click();
		await expectPreviewContains(page, secondPreviewText, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: opening preview B should select B content");
		await expectAtLeastPreviewTabCount(page, 2, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: opening A then B should retain two different-content preview tabs");
		let previewTabTexts = await collectAllPreviewTabTexts(page, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG");
		expect(previewTabTexts.some((text) => text.includes(firstPreviewText)), `DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: no preview tab restored A; texts=${JSON.stringify(previewTabTexts)}`).toBe(true);
		expect(previewTabTexts.some((text) => text.includes(secondPreviewText)), `DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: no preview tab restored B; texts=${JSON.stringify(previewTabTexts)}`).toBe(true);

		await reloadAndNavigateToSession(page, sessionId);
		await refreshTranscriptFromGateway(page, 2, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: after reload");
		const previewCountAfterReload = (await visiblePanelTabs(page)).filter((tab) => tab.kind === "preview").length;
		if (previewCountAfterReload < 2) {
			// Historical preview tabs do not expose a close/pin persistence control; the
			// persisted transcript is the durable artifact. Reopen the two v3 cards after
			// reload to prove the different content hashes remain separately restorable.
			await buttons.nth(0).scrollIntoViewIfNeeded();
			await buttons.nth(0).click();
			await expectPreviewContains(page, firstPreviewText, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: preview A should restore after reload");
			await buttons.nth(1).scrollIntoViewIfNeeded();
			await buttons.nth(1).click();
			await expectPreviewContains(page, secondPreviewText, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: preview B should restore after reload");
		}
		await expectAtLeastPreviewTabCount(page, 2, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: after reload");
		previewTabTexts = await collectAllPreviewTabTexts(page, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: after reload");
		expect(previewTabTexts.some((text) => text.includes(firstPreviewText)), `DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: no reloaded preview tab restored A; texts=${JSON.stringify(previewTabTexts)}`).toBe(true);
		expect(previewTabTexts.some((text) => text.includes(secondPreviewText)), `DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: no reloaded preview tab restored B; texts=${JSON.stringify(previewTabTexts)}`).toBe(true);

		// Preview tabs currently have no per-tab close affordance (unlike review tabs),
		// so cleanup coverage asserts there is no accidental same-content collapse when
		// moving focus away from and back to the preview workspace.
		await ensureChatInput(page, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: cleanup/no-collapse check");
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: Preview should remain selectable for cleanup check");
		await expectAtLeastPreviewTabCount(page, 2, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: cleanup should not collapse different-content preview tabs");
		previewTabTexts = await collectAllPreviewTabTexts(page, "DYNAMIC_CHAT_TABS_V3_DIFFERENT_HASH_BUG: cleanup/no-collapse check");
		expect(previewTabTexts.some((text) => text.includes(firstPreviewText))).toBe(true);
		expect(previewTabTexts.some((text) => text.includes(secondPreviewText))).toBe(true);
	});

	test("historical v3 preview tool-card reopen restores A and B as independent tabs", async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		const firstPreviewText = await appendV3PreviewToolCard(page, sessionId, "tool-v3-a", "v3-a.html", "V3 Preview A Content");
		const secondPreviewText = await appendV3PreviewToolCard(page, sessionId, "tool-v3-b", "v3-b.html", "V3 Preview B Content");

		const buttons = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR);
		await expect(buttons, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG: two v3 preview_open tool cards should render Open buttons").toHaveCount(2, { timeout: 15_000 });
		await buttons.nth(0).click();
		await expectPreviewContains(page, firstPreviewText, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG: opening preview A should show A content");
		await buttons.nth(1).click();
		await expectPreviewContains(page, secondPreviewText, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG: opening preview B should show B content");

		await waitForTopLevelTabCounts(
			page,
			[{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 2 }],
			"DYNAMIC_CHAT_TABS_V3_REOPEN_BUG: opening A and B should create two top-level historical preview tabs",
		);

		await buttons.nth(0).click();
		await expectPreviewContains(page, firstPreviewText, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG: reopening A from its tool card should restore A, not latest B");
		await selectTopLevelTabByTitle(page, /Preview:\s*v3-b\.html/i, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG");
		await expectPreviewContains(page, secondPreviewText, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG: selecting B tab should show B content after A was reopened");
		await selectTopLevelTabByTitle(page, /Preview:\s*v3-a\.html/i, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG");
		await expectPreviewContains(page, firstPreviewText, "DYNAMIC_CHAT_TABS_V3_REOPEN_BUG: selecting A tab should show A content after selecting B");
	});

	test("proposal revisions of the same type open as distinct tabs while the live proposal stays accessible", async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		const rev1Fields = { name: "Revision One Project", root_path: "/tmp/revision-one", build_command: "echo old" };
		const rev1 = await seedProjectProposalRevision(page, sessionId, rev1Fields);
		await appendProjectProposalToolCard(page, "tool-project-rev-1", rev1Fields, rev1);

		const rev2Fields = { name: "Revision Two Project", root_path: "/tmp/revision-two", build_command: "echo new" };
		const rev2 = await seedProjectProposalRevision(page, sessionId, rev2Fields);
		await appendProjectProposalToolCard(page, "tool-project-rev-2", rev2Fields, rev2);
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.activeProposals?.project?.fields?.name ?? ""),
			{ timeout: 10_000, message: "DYNAMIC_CHAT_TABS_PROPOSAL_REVISIONS_BUG: live proposal should be at rev 2 before opening a historical revision" },
		).toBe("Revision Two Project");

		await selectTopLevelTab(page, PROJECT_PROPOSAL_TAB_RE, "DYNAMIC_CHAT_TABS_PROPOSAL_REVISIONS_BUG: live project proposal tab should be selectable before opening history");
		await expect(page.locator('[data-panel="project-proposal"]').getByText("Revision Two Project").first()).toBeVisible({ timeout: 10_000 });

		const openButtons = page.locator('[data-testid="proposal-open-button"]');
		await expect(openButtons, "DYNAMIC_CHAT_TABS_PROPOSAL_REVISIONS_BUG: rev 1 and rev 2 proposal cards should both expose Open proposal").toHaveCount(2, { timeout: 15_000 });
		await openButtons.nth(0).click();

		await expect.poll(async () => (await visiblePanelTabs(page)).filter((tab) => tab.kind === "proposal" && PROJECT_PROPOSAL_TAB_RE.test(tab.label)).length, {
			timeout: 10_000,
			message: "DYNAMIC_CHAT_TABS_PROPOSAL_REVISIONS_BUG: opening rev 1 should create/select a distinct historical proposal tab without replacing the live project tab",
		}).toBeGreaterThanOrEqual(2);

		const proposalTabs = (await visiblePanelTabs(page)).filter((tab) => tab.kind === "proposal" && PROJECT_PROPOSAL_TAB_RE.test(tab.label));
		const panelTexts: string[] = [];
		for (const tab of proposalTabs) {
			await clickTopLevelTabByIndex(page, tab.index, "DYNAMIC_CHAT_TABS_PROPOSAL_REVISIONS_BUG");
			const panel = page.locator('[data-panel="project-proposal"]').first();
			await expect(panel).toBeVisible({ timeout: 10_000 });
			panelTexts.push((await panel.textContent()) || "");
		}
		expect(
			panelTexts.some((text) => text.includes("Revision One Project")),
			`DYNAMIC_CHAT_TABS_PROPOSAL_REVISIONS_BUG: no proposal tab rendered rev 1; panel texts were ${JSON.stringify(panelTexts)}`,
		).toBe(true);
		expect(
			panelTexts.some((text) => text.includes("Revision Two Project")),
			`DYNAMIC_CHAT_TABS_PROPOSAL_REVISIONS_BUG: no proposal tab kept the live rev 2 accessible; panel texts were ${JSON.stringify(panelTexts)}`,
		).toBe(true);
	});

	test("multiple review documents coexist as top-level tabs with a proposal and preview", async ({ page }) => {
		test.setTimeout(120_000);
		await page.setViewportSize({ width: 1280, height: 800 });

		const sessionId = await openGoalAssistantProposal(page);
		const previewText = await openHtmlPreviewViaPreviewOpenFlow(page, sessionId, {
			entry: "mixed-preview.html",
			bodyText: "Mixed Preview Content",
		});

		await sendChatMessage(page, "review_multi", "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG");
		await expect(page.getByText("Done. Used 3 tools.").first(), "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG: review_multi should open three review documents").toBeVisible({ timeout: 15_000 });

		await waitForTopLevelTabCounts(
			page,
			[
				{ name: "Goal proposal", match: GOAL_TAB_RE, min: 1 },
				{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 1 },
				...REVIEW_DOCS.map((doc) => ({ name: `Review ${doc.title}`, match: reviewTabRe(doc.title), min: 1 })),
			],
			"DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG: expected proposal, preview, and each review document to be separate top-level tabs",
		);

		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG");
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG: Preview tab should be selectable alongside review docs");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG");
		for (const doc of REVIEW_DOCS) {
			await expectReviewDocumentAccessible(page, doc.title, doc.body, "DYNAMIC_CHAT_TABS_REVIEW_MIX_BUG");
		}
	});

	test("mobile goal assistant proposal is not double-padded below the fixed header", async ({ page }) => {
		test.setTimeout(90_000);
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 1280, height: 800 });

		await openGoalAssistantProposal(page);
		await page.setViewportSize({ width: 360, height: 740 });
		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MOBILE_HEADER_GAP_BUG");

		const assistantPanel = page.locator('[data-panel="goal-proposal"]').first();
		await expect(
			assistantPanel,
			"DYNAMIC_CHAT_TABS_MOBILE_HEADER_GAP_BUG: assistant goal proposal renderer should be active",
		).toBeVisible({ timeout: 5_000 });
		await expect(
			assistantPanel.getByRole("button", { name: /Create Goal/ }).first(),
			"DYNAMIC_CHAT_TABS_MOBILE_HEADER_GAP_BUG: assistant goal proposal should expose Create Goal, not the normal-session Dismiss footer",
		).toBeVisible({ timeout: 5_000 });
		await expectMobileGoalFormStartsBelowHeader(page, "DYNAMIC_CHAT_TABS_MOBILE_HEADER_GAP_BUG");
	});

	test("mobile mixed proposal, review, and preview tabs are horizontally accessible", async ({ page }) => {
		test.setTimeout(120_000);
		await setupMobileEmulation(page);
		await page.setViewportSize({ width: 360, height: 740 });

		const sessionId = await openGoalAssistantProposalViaApi(page);
		await sendChatMessage(page, "review_multi", "DYNAMIC_CHAT_TABS_MOBILE_BUG");
		await expect(page.getByText("Done. Used 3 tools.").first(), "DYNAMIC_CHAT_TABS_MOBILE_BUG: review_multi should open three review documents on mobile").toBeVisible({ timeout: 15_000 });
		const previewText = await openHtmlPreviewViaPreviewOpenFlow(page, sessionId, {
			entry: "mobile-mixed-preview.html",
			bodyText: "Mobile Mixed Preview Content",
		});

		await waitForTopLevelTabCounts(
			page,
			[
				{ name: "Goal proposal", match: GOAL_TAB_RE, min: 1 },
				{ name: "HTML Preview", match: PREVIEW_TAB_RE, min: 1 },
				...REVIEW_DOCS.map((doc) => ({ name: `Review ${doc.title}`, match: reviewTabRe(doc.title), min: 1 })),
			],
			"DYNAMIC_CHAT_TABS_MOBILE_BUG: expected mobile tab bar to expose proposal, preview, and each review document as top-level tabs",
		);
		await expectMobileHorizontalTabAccess(page, "DYNAMIC_CHAT_TABS_MOBILE_BUG");

		await expectGoalProposalAccessible(page, "DYNAMIC_CHAT_TABS_MOBILE_BUG");
		await expectMobileGoalFormStartsBelowHeader(page, "DYNAMIC_CHAT_TABS_MOBILE_BUG");
		await selectTopLevelTab(page, PREVIEW_TAB_RE, "DYNAMIC_CHAT_TABS_MOBILE_BUG: mobile Preview tab should be selectable via horizontal tab access");
		await expectPreviewContains(page, previewText, "DYNAMIC_CHAT_TABS_MOBILE_BUG");
		for (const doc of REVIEW_DOCS) {
			await expectReviewDocumentAccessible(page, doc.title, doc.body, "DYNAMIC_CHAT_TABS_MOBILE_BUG");
		}
	});
});
