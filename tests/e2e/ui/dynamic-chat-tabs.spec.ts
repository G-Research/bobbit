/**
 * Retained browser E2E smokes for Dynamic Chat Tabs.
 *
 * Broad renderer/workspace combinations live in
 * tests/ui-fixtures/dynamic-panel-workspace-fixture.spec.ts so the full
 * browser suite keeps only the gateway-backed preview journeys that need a
 * spawned app, live preview mount, reload, and transcript hydration.
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
const CHAT_TAB_RE = /^Chat$/i;

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

async function createRegularSessionViaApi(page: Page): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd() }),
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

	const mountResp = await page.evaluate(async ({ baseUrl, sessionId, entry, bodyText }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				entry,
				html: `<!DOCTYPE html><html><body><h1>${bodyText}</h1></body></html>`,
			}),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId, entry, bodyText });
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

async function visiblePanelTabs(page: Page): Promise<Array<{ index: number; label: string; id: string; kind: string }>> {
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
				id: button.getAttribute("data-panel-tab-id") || "",
				kind: button.getAttribute("data-panel-tab-kind") || "",
			} : null;
		})
		.filter(Boolean) as Array<{ index: number; label: string; id: string; kind: string }>);
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

async function expectGoalProposalAccessible(page: Page, errorPrefix: string): Promise<void> {
	await selectTopLevelTab(page, GOAL_TAB_RE, `${errorPrefix}: Goal proposal tab should remain selectable`);
	await expectGoalProposalPanel(page, `${errorPrefix}: Goal proposal tab should render the proposal form`);
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
	return `__preview_snapshot_v3__\n${JSON.stringify({ kind: "preview", url: mounted.url, path: mounted.path, entry: mounted.entry, contentHash: mounted.contentHash })}\n`;
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
});
