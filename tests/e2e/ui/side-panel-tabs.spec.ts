import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, defaultProject, nonGitCwd } from "../e2e-setup.js";
import { openApp, createSessionViaUI, navigateToHash, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

const PANEL_TAB_SELECTOR = ".goal-tab-pill";
const PREVIEW_OPEN_BUTTON_SELECTOR = '[data-testid="preview-open-button"]';
const PROPOSAL_OPEN_BUTTON_SELECTOR = '[data-testid="proposal-open-button"]';
const SIDE_PANEL_FULLSCREEN = '[data-testid="side-panel-fullscreen"]';
const SIDE_PANEL_COLLAPSE = '[data-testid="side-panel-collapse"]';
const SIDE_PANEL_RESTORE = '[data-testid="side-panel-restore"]';
const SIDE_PANEL_POPOUT = '[data-testid="side-panel-popout"]';
const PRW_PACK = "pr-walkthrough";
const PRW_PANEL_ID = "pr-walkthrough.panel";
const PRW_TAB_ID = `pack:${PRW_PACK}:${PRW_PANEL_ID}:default`;
const ARTIFACTS_PACK = "artifacts";
const ARTIFACTS_PANEL_ID = "artifacts.viewer";
const ARTIFACTS_SOURCE_DIR = fileURLToPath(new URL("../../../market-packs", import.meta.url));

type PanelTab = {
	index: number;
	id: string;
	kind: string;
	label: string;
	title: string;
	active: boolean;
	closable: boolean;
};

type PreviewMountSnapshot = {
	url: string;
	path: string;
	entry: string;
	mtime: number;
	contentHash: string;
	artifactId?: string;
};

const previewId = (entry: string) => `preview:entry:${encodeURIComponent(entry)}`;
const previewVersionId = (entry: string, version: number) => `${previewId(entry)}:v:${version}`;

function previewHtml(bodyText: string): string {
	return `<!DOCTYPE html><html><body><main data-preview-story="${bodyText}"><h1>${bodyText}</h1></main></body></html>`;
}

async function createRegularSessionViaApi(page: Page): Promise<string> {
	const sid = await createSession({ cwd: nonGitCwd() });
	await navigateToSession(page, sid);
	return sid;
}

async function createGoalAssistantSessionViaApi(page: Page): Promise<string> {
	const resp = await apiFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ cwd: nonGitCwd(), assistantType: "goal" }),
	});
	const text = await resp.text();
	expect(resp.status, `create goal assistant session: ${text}`).toBe(201);
	const sid = JSON.parse(text).id as string;
	await navigateToSession(page, sid);
	return sid;
}

async function navigateToSession(page: Page, sessionId: string): Promise<void> {
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 20_000 });
	await expect.poll(
		() => page.evaluate(() => (window as any).bobbitState?.selectedSessionId ?? ""),
		{ timeout: 10_000, message: `selected session should be ${sessionId}` },
	).toBe(sessionId);
}

async function visiblePanelTabs(page: Page): Promise<PanelTab[]> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button, index) => {
			const el = button as HTMLElement;
			const rect = el.getBoundingClientRect();
			const style = window.getComputedStyle(el);
			if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") return null;
			// The mobile Chat pill is a UI affordance for swiping to the chat
			// pane; it is NOT part of the persisted panel-tab list. Filter it
			// out so visible-tab assertions match the persisted shape.
			if (button.getAttribute("data-panel-tab-kind") === "chat") return null;
			const label = (button.textContent || "").replace(/\s+/g, " ").replace(/[×✕]/g, "").trim();
			const title = (button.getAttribute("data-panel-tab-title") || button.getAttribute("title") || label).replace(/\s+/g, " ").trim();
			return {
				index,
				id: button.getAttribute("data-panel-tab-id") || "",
				kind: button.getAttribute("data-panel-tab-kind") || "",
				label: label || title,
				title,
				active: button.classList.contains("goal-tab-pill--active"),
				closable: !!button.querySelector(".goal-tab-close"),
			};
		})
		.filter(Boolean) as PanelTab[]);
}

async function visiblePanelTabIds(page: Page): Promise<string[]> {
	return (await visiblePanelTabs(page)).map((tab) => tab.id);
}

async function visiblePanelTabLabels(page: Page): Promise<string[]> {
	return (await visiblePanelTabs(page)).map((tab) => tab.label);
}

async function expectPanelTabs(page: Page, expectedIds: string[], message: string): Promise<void> {
	await expect.poll(() => visiblePanelTabIds(page), { timeout: 15_000, message }).toEqual(expectedIds);
	await expectNoChatTab(page);
}

async function settleClosedTabRehydratePath(page: Page): Promise<void> {
	await page.evaluate(() => new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => window.setTimeout(resolve, 150)));
	}));
}

async function expectClosedSidePanelTabAbsent(page: Page, sessionId: string, tabId: string, message: string): Promise<void> {
	await expect.poll(async () => {
		await settleClosedTabRehydratePath(page);
		return {
			visible: (await visiblePanelTabIds(page)).filter((id) => id === tabId),
			server: (await workspace(sessionId)).tabs.map((tab: any) => tab.id).filter((id: string) => id === tabId),
		};
	}, {
		timeout: 5_000,
		message: `closed side-panel tab should remain absent (${message})`,
	}).toEqual({ visible: [], server: [] });
}

async function tabById(page: Page, id: string) {
	return page.locator(`${PANEL_TAB_SELECTOR}[data-panel-tab-id="${id}"]`).first();
}

async function clickTabById(page: Page, id: string, message: string): Promise<void> {
	const tab = await tabById(page, id);
	await expect(tab, message).toBeVisible({ timeout: 10_000 });
	await tab.scrollIntoViewIfNeeded();
	await tab.click();
	await expectActivePanelTabId(page, id, `${message}: active id should be exact`);
}

async function closeTabById(page: Page, id: string, message: string): Promise<void> {
	const tab = await tabById(page, id);
	await expect(tab, message).toBeVisible({ timeout: 10_000 });
	await expect(tab.locator(".goal-tab-close"), `${message}: tab should be closable`).toBeVisible({ timeout: 5_000 });
	await tab.locator(".goal-tab-close").click();
	await expect.poll(async () => (await visiblePanelTabIds(page)).includes(id), {
		timeout: 10_000,
		message: `${message}: closed tab should disappear`,
	}).toBe(false);
}

async function closeWorkspaceTabViaApi(page: Page, sessionId: string, tabId: string, message: string): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/tabs/${encodeURIComponent(tabId)}`, { method: "DELETE" });
	const text = await resp.text();
	expect(resp.status, `${message}: workspace DELETE should succeed: ${text}`).toBe(200);
	await expect.poll(async () => (await visiblePanelTabIds(page)).includes(tabId), {
		timeout: 10_000,
		message: `${message}: closed tab should disappear`,
	}).toBe(false);
}

async function expectActivePanelTabId(page: Page, expected: string, message: string): Promise<void> {
	await expect.poll(
		() => page.evaluate(() => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			const sid = state.selectedSessionId || "";
			return {
				activePanelTabId: state.activePanelTabId || "",
				stored: sid ? (state.panelWorkspaceActiveBySession?.[sid] || "") : "",
			};
		}),
		{ timeout: 10_000, message },
	).toEqual({ activePanelTabId: expected, stored: expected });
}

async function expectNoChatTab(page: Page): Promise<void> {
	// visiblePanelTabs filters the mobile Chat pill out (kind="chat"), so this
	// check ensures no LEGACY chat tab leaked into the persisted panel-tab list.
	const tabs = await visiblePanelTabs(page);
	expect(
		tabs.filter((tab) => tab.id === "chat" || tab.kind === "chat" || /^Chat$/i.test(tab.label) || /^Chat$/i.test(tab.title)),
		`persisted side-pane tabs must not expose Chat; tabs=${JSON.stringify(tabs)}`,
	).toEqual([]);
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
	await expect.poll(
		() => page.evaluate(() => !!((window as any).bobbitState ?? (window as any).__bobbitState)?.isPreviewSession),
		{ timeout: 10_000, message: "session should become preview-capable" },
	).toBe(true);
}

async function mountPreviewHtml(page: Page, sessionId: string, entry: string, bodyText: string): Promise<PreviewMountSnapshot> {
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
	const mounted = JSON.parse(mountResp.text) as PreviewMountSnapshot;
	expect(mounted.entry).toBe(entry);
	expect(mounted.contentHash).toMatch(/^[a-f0-9]{64}$/);
	await waitForCurrentPreviewTab(page, entry, bodyText);
	return mounted;
}

async function mountPreviewFile(page: Page, sessionId: string, filePath: string, expectedEntry: string, expectedText: string): Promise<PreviewMountSnapshot> {
	await enablePreview(page, sessionId);
	const baseUrl = new URL(page.url()).origin;
	const mountResp = await page.evaluate(async ({ baseUrl, sessionId, filePath }) => {
		const r = await fetch(`${baseUrl}/api/preview/mount?sessionId=${sessionId}`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ file: filePath }),
		});
		return { status: r.status, text: await r.text() };
	}, { baseUrl, sessionId, filePath });
	expect(mountResp.status, `preview file mount for ${filePath} should succeed: ${mountResp.text}`).toBe(200);
	const mounted = JSON.parse(mountResp.text) as PreviewMountSnapshot;
	expect(mounted.entry).toBe(expectedEntry);
	expect(mounted.contentHash).toMatch(/^[a-f0-9]{64}$/);
	await waitForCurrentPreviewTab(page, expectedEntry, expectedText);
	return mounted;
}

async function waitForCurrentPreviewTab(page: Page, entry: string, expectedText: string): Promise<void> {
	const id = previewId(entry);
	await expect.poll(async () => (await visiblePanelTabs(page)).some((tab) => tab.id === id && tab.label === entry), {
		timeout: 15_000,
		message: `current preview tab ${entry} should be visible with an unversioned label`,
	}).toBe(true);
	await expectActivePanelTabId(page, id, `current preview ${entry} should take focus`);
	await expectPreviewContains(page, expectedText, `current preview ${entry}`);
}

async function expectPreviewContains(page: Page, expectedText: string, message: string): Promise<void> {
	const iframe = page.locator(".goal-preview-panel iframe").first();
	await expect(iframe, `${message}: iframe should be visible`).toBeVisible({ timeout: 15_000 });
	await expect(page.frameLocator(".goal-preview-panel iframe").first().locator("body"), message).toContainText(expectedText, { timeout: 15_000 });
}

async function rawPreviewBodyText(page: Page): Promise<string> {
	return ((await page.frameLocator(".goal-preview-panel iframe").first().locator("body").textContent({ timeout: 1_000 }).catch(() => "")) || "").replace(/\s+/g, " ").trim();
}

function v3SnapshotBlock(mounted: PreviewMountSnapshot): string {
	const payload: Record<string, unknown> = {
		kind: "preview",
		url: mounted.url,
		path: mounted.path,
		entry: mounted.entry,
		contentHash: mounted.contentHash,
	};
	if (mounted.artifactId) {
		payload.artifactId = mounted.artifactId;
		payload.a = mounted.artifactId;
	}
	return `__preview_snapshot_v3__\n${JSON.stringify(payload)}\n`;
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

function v3PreviewToolCardMessages(toolId: string, mounted: PreviewMountSnapshot, input: Record<string, unknown>): any[] {
	return previewToolCardMessages(toolId, input, v3SnapshotBlock(mounted));
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

async function refreshTranscriptFromGateway(page: Page, expectedOpenButtons: number, message: string): Promise<void> {
	await expect.poll(async () => {
		await page.evaluate(() => (window as any).bobbitState?.remoteAgent?.requestMessages?.());
		return page.locator(PREVIEW_OPEN_BUTTON_SELECTOR).count();
	}, { timeout: 15_000, message }).toBe(expectedOpenButtons);
}

async function openPreviewToolCard(page: Page, ordinal: number, message: string): Promise<void> {
	const button = page.locator(PREVIEW_OPEN_BUTTON_SELECTOR).nth(ordinal);
	await button.scrollIntoViewIfNeeded();
	await expect(button, message).toBeEnabled({ timeout: 10_000 });
	await button.click();
	await expect(button, `${message}: button should acknowledge open`).toHaveText(/Open|Opened/, { timeout: 10_000 });
}

async function openProposalToolCard(page: Page, expectedTabId: string, message: string): Promise<void> {
	const button = page.locator(PROPOSAL_OPEN_BUTTON_SELECTOR).last();
	await button.scrollIntoViewIfNeeded();
	await expect(button, `${message}: Open Proposal renderer should be visible`).toBeEnabled({ timeout: 10_000 });
	await button.click();
	await expect(page.locator('input[placeholder="Goal title"]').first(), `${message}: explicit Open Proposal should render the proposal panel`).toHaveValue(/Parity Goal A|E2E Test Goal/, { timeout: 15_000 });
	await expectPanelTabs(page, [expectedTabId], `${message}: explicit Open Proposal should reopen the durable-closed proposal workspace tab`);
	await expectActivePanelTabId(page, expectedTabId, `${message}: explicit Open Proposal should focus the reopened tab`);
}

async function navigateAwayAndBackToSession(page: Page, sessionId: string, message: string): Promise<void> {
	await navigateToHash(page, "#/settings");
	await expect(page.getByText("Settings").first(), `${message}: settings route should be visible before returning`).toBeVisible({ timeout: 10_000 });
	await navigateToSession(page, sessionId);
}

async function goalIdsByTitle(title: string): Promise<Set<string>> {
	const resp = await apiFetch("/api/goals");
	const text = await resp.text();
	expect(resp.status, `list goals for cleanup: ${text}`).toBe(200);
	const parsed = JSON.parse(text);
	const goals = Array.isArray(parsed) ? parsed : parsed.goals || [];
	return new Set((goals as any[]).filter((goal) => goal?.title === title && goal?.id).map((goal) => String(goal.id)));
}

async function cleanupNewGoalsByTitle(title: string, before: Set<string>): Promise<void> {
	const after = await goalIdsByTitle(title).catch(() => new Set<string>());
	for (const id of after) {
		if (!before.has(id)) await apiFetch(`/api/goals/${id}`, { method: "DELETE" }).catch(() => {});
	}
}

async function openGoalProposal(page: Page): Promise<string> {
	await sendMessage(page, "GOAL_PROPOSAL_PARITY");
	await expect(page.locator('input[placeholder="Goal title"]').first()).toHaveValue("Parity Goal A", { timeout: 20_000 });
	const proposal = (await visiblePanelTabs(page)).find((tab) => tab.kind === "proposal" && tab.id.startsWith("proposal:goal"));
	expect(proposal, `goal proposal tab should be visible; tabs=${JSON.stringify(await visiblePanelTabs(page))}`).toBeTruthy();
	return proposal!.id;
}

async function updateGoalProposal(page: Page): Promise<void> {
	await sendMessage(page, "GOAL_PROPOSAL_PARITY_EDIT");
	await expect(page.locator('input[placeholder="Goal title"]').first()).toHaveValue("Parity Goal A — edited", { timeout: 20_000 });
}

async function openReview(page: Page): Promise<string> {
	await sendMessage(page, "REVIEW_OPEN");
	await waitForAgentResponse(page, { text: "Done. Used review_open tool.", timeout: 20_000 });
	let reviewId = "";
	await expect.poll(async () => {
		const review = (await visiblePanelTabs(page)).find((tab) => tab.kind === "review" && tab.id.startsWith("review:"));
		reviewId = review?.id ?? "";
		return reviewId;
	}, { timeout: 10_000, message: "review tab should be visible after review_open" }).toMatch(/^review:/);
	await clickTabById(page, reviewId, "review tab should be selectable");
	await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible({ timeout: 10_000 });
	return reviewId;
}

// Wait until a tab's bounding box is stable across two animation frames before
// using it as a drag anchor. SortableJS animates reorders (animation: 180ms),
// so a box sampled mid-animation can be stale; this also confirms lit-html is
// not mid-reconcile, i.e. the tab strip + Sortable instance have settled.
async function stableTabBox(page: Page, locator: ReturnType<Page["locator"]>, label: string) {
	let previous: { x: number; y: number; width: number; height: number } | null = null;
	for (let i = 0; i < 40; i++) {
		const box = await locator.boundingBox();
		expect(box, `${label} should have a box`).not.toBeNull();
		if (
			previous &&
			Math.abs(previous.x - box!.x) < 0.5 &&
			Math.abs(previous.y - box!.y) < 0.5 &&
			Math.abs(previous.width - box!.width) < 0.5 &&
			Math.abs(previous.height - box!.height) < 0.5
		) {
			return box!;
		}
		previous = box!;
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
	}
	return previous!;
}

async function dragTab(page: Page, fromId: string, toId: string, options: { toLeftEdge?: boolean } = {}): Promise<void> {
	const from = await tabById(page, fromId);
	const to = await tabById(page, toId);
	await expect(from, `drag source ${fromId}`).toBeVisible({ timeout: 10_000 });
	await expect(to, `drag target ${toId}`).toBeVisible({ timeout: 10_000 });
	// Sync on a settled tab strip (boxes stable) so SortableJS has attached its
	// drag handlers and is not mid-animation before we synthesise the drag.
	const fromBox = await stableTabBox(page, from, `drag source ${fromId}`);
	const toBox = await stableTabBox(page, to, `drag target ${toId}`);
	const startX = fromBox.x + fromBox.width / 2;
	const startY = fromBox.y + fromBox.height / 2;
	const targetX = options.toLeftEdge ? toBox.x + 2 : toBox.x + toBox.width / 2;
	const targetY = toBox.y + toBox.height / 2;
	await page.mouse.move(startX, startY);
	await page.mouse.down();
	// Nudge past SortableJS's fallbackTolerance (4px) so the drag deterministically
	// begins before we glide to the destination.
	await page.mouse.move(startX - 8, startY, { steps: 3 });
	// Glide in many small steps so SortableJS's fallback drag loop evaluates an
	// onMove against every tab the cursor crosses — including the pinned target,
	// whose guard must observe the drag to reject a before-pinned drop.
	await page.mouse.move(targetX, targetY, { steps: 24 });
	// Dwell on the destination: each repeated move is another onMove the loop
	// processes, so the final drop position is evaluated deterministically rather
	// than racing mouse-up against a busy main thread under contention.
	for (let i = 0; i < 3; i++) {
		await page.mouse.move(targetX, targetY);
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
	}
	await page.mouse.up();
}

async function dispatchTouchTabDrag(page: Page, fromId: string, toId: string): Promise<void> {
	const from = await tabById(page, fromId);
	const to = await tabById(page, toId);
	const fromBox = await from.boundingBox();
	const toBox = await to.boundingBox();
	expect(fromBox).not.toBeNull();
	expect(toBox).not.toBeNull();
	await from.dispatchEvent("pointerdown", {
		pointerType: "touch",
		button: 0,
		buttons: 1,
		clientX: fromBox!.x + fromBox!.width / 2,
		clientY: fromBox!.y + fromBox!.height / 2,
	});
	await to.dispatchEvent("pointermove", {
		pointerType: "touch",
		button: 0,
		buttons: 1,
		clientX: toBox!.x + toBox!.width / 2,
		clientY: toBox!.y + toBox!.height / 2,
	});
	await to.dispatchEvent("pointerup", {
		pointerType: "touch",
		button: 0,
		buttons: 0,
		clientX: toBox!.x + toBox!.width / 2,
		clientY: toBox!.y + toBox!.height / 2,
	});
}

async function swipeApp(page: Page, fromX: number, toX: number, y: number): Promise<void> {
	await page.locator("#app").dispatchEvent("touchstart", {
		touches: [{ identifier: 1, clientX: fromX, clientY: y }],
		changedTouches: [{ identifier: 1, clientX: fromX, clientY: y }],
	});
	await page.locator("#app").dispatchEvent("touchmove", {
		touches: [{ identifier: 1, clientX: toX, clientY: y }],
		changedTouches: [{ identifier: 1, clientX: toX, clientY: y }],
	});
	await page.locator("#app").dispatchEvent("touchend", {
		touches: [],
		changedTouches: [{ identifier: 1, clientX: toX, clientY: y }],
	});
}

async function createStaff(name: string): Promise<{ id: string; currentSessionId: string }> {
	const project = await defaultProject();
	const resp = await apiFetch("/api/staff", {
		method: "POST",
		body: JSON.stringify({
			name,
			systemPrompt: "Side-panel tab contract test staff agent.",
			cwd: project.rootPath,
			projectId: project.id,
		}),
	});
	const text = await resp.text();
	expect(resp.status, `create staff ${name}: ${text}`).toBe(201);
	const staff = JSON.parse(text) as { id: string; currentSessionId?: string };
	let sid = staff.currentSessionId || "";
	await expect.poll(async () => {
		const r = await apiFetch(`/api/staff/${staff.id}`);
		if (!r.ok) return "";
		const body = await r.json();
		sid = body.currentSessionId || sid;
		return sid;
	}, { timeout: 20_000, intervals: [250, 500, 1_000], message: "staff current session should materialise" }).toMatch(/^[a-f0-9-]{36}$/);
	return { id: staff.id, currentSessionId: sid };
}

async function expectPanelHidden(page: Page): Promise<void> {
	await expect(page.locator('[data-panel-workspace="content"]')).toHaveCount(0, { timeout: 10_000 });
	await expect(page.locator(".goal-preview-panel")).toHaveCount(0, { timeout: 10_000 });
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
}

async function openStaffInboxPanel(page: Page): Promise<void> {
	await expect(page.locator('[data-testid="staff-inbox-open"]')).toBeVisible({ timeout: 15_000 });
	await page.locator('[data-testid="staff-inbox-open"]').click();
	await expectPanelTabs(page, ["inbox"], "explicit Staff Inbox action should open a side-panel tab");
	await expect(page.locator("inbox-panel")).toBeVisible({ timeout: 10_000 });
}

async function expectContentForTab(page: Page, tab: PanelTab, previewText: string): Promise<string> {
	await clickTabById(page, tab.id, `click ${tab.id}`);
	if (tab.kind === "preview") {
		await expectPreviewContains(page, previewText, `preview content for ${tab.id}`);
		return `preview:${await rawPreviewBodyText(page)}`;
	}
	if (tab.kind === "proposal") {
		await expect(page.locator('input[placeholder="Goal title"]').first()).toHaveValue(/Parity Goal A/, { timeout: 10_000 });
		return `proposal:${await page.locator('input[placeholder="Goal title"]').first().inputValue()}`;
	}
	if (tab.kind === "review") {
		await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible({ timeout: 10_000 });
		return "review:Section One";
	}
	if (tab.kind === "inbox") {
		await expect(page.locator("inbox-panel")).toBeVisible({ timeout: 10_000 });
		return "inbox:panel";
	}
	throw new Error(`unsupported tab kind ${tab.kind}`);
}

async function workspace(sessionId: string): Promise<any> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace`);
	const text = await resp.text();
	expect(resp.status, `workspace GET failed: ${text}`).toBe(200);
	return JSON.parse(text);
}

async function expectSizeMode(page: Page, sessionId: string, expected: "collapsed" | "split" | "fullscreen", message: string): Promise<void> {
	await expect.poll(async () => ({
		server: (await workspace(sessionId)).sizeMode,
		client: await page.evaluate((sid) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			return state.sidePanelWorkspaceBySession?.[sid]?.sizeMode ?? state.panelWorkspace?.sizeMode ?? "";
		}, sessionId),
	}), { timeout: 10_000, message }).toEqual({ server: expected, client: expected });
}

async function openWorkspaceTab(sessionId: string, tab: any): Promise<void> {
	const resp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/open`, {
		method: "POST",
		body: JSON.stringify({ tab: { ...tab, updatedAt: Date.now() } }),
	});
	const text = await resp.text();
	expect(resp.status, `open workspace tab failed: ${text}`).toBe(200);
}

async function openPrWalkthroughPanel(page: Page, sessionId: string): Promise<void> {
	await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => {});
	await openWorkspaceTab(sessionId, {
		id: PRW_TAB_ID,
		kind: "pack",
		title: "PR Walkthrough",
		label: "PR Walkthrough",
		source: { type: "pack", sessionId, packId: PRW_PACK, panelId: PRW_PANEL_ID, instanceKey: "default", singleton: true, params: {} },
	});
	await expectPanelTabs(page, [PRW_TAB_ID], "PR walkthrough pack tab should open from the server workspace");
	await expect(page.locator('[data-testid="prw-panel-root"]').first()).toBeVisible({ timeout: 20_000 });
}

async function expectPopoutOpens(page: Page, tabId: string, message: string): Promise<void> {
	const kind = await page.locator(`${PANEL_TAB_SELECTOR}[data-panel-tab-id="${tabId}"]`).first().getAttribute("data-panel-tab-kind");
	const popout = page.locator(SIDE_PANEL_POPOUT).first();
	await expect(popout, `${message}: popout control`).toBeVisible({ timeout: 10_000 });
	const href = await popout.getAttribute("href");
	expect(href, `${message}: popout href`).toBeTruthy();
	const popupPromise = page.context().waitForEvent("page");
	await popout.click();
	const popup = await popupPromise;
	try {
		await popup.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
		if (tabId.startsWith("preview:")) {
			expect(popup.url(), `${message}: preview popout route`).toContain("/preview/");
		} else {
			const encoded = encodeURIComponent(tabId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			await expect.poll(() => popup.url(), { timeout: 15_000, message: `${message}: app popout route` })
				.toMatch(new RegExp(`/panel/${encoded}`));
			await expect(popup.locator('[data-testid="side-panel-route-content"]'), `${message}: standalone panel content shell`).toBeVisible({ timeout: 20_000 });
			await expect(popup.locator(`${PANEL_TAB_SELECTOR}[data-panel-tab-id="${tabId}"]`).first(), `${message}: standalone active tab`).toBeVisible({ timeout: 20_000 });
			if (kind === "inbox") await expect(popup.locator("inbox-panel"), `${message}: inbox popout content`).toBeVisible({ timeout: 20_000 });
			else if (kind === "review") await expect(popup.locator("review-pane"), `${message}: review popout content`).toBeVisible({ timeout: 20_000 });
			else if (kind === "proposal") await expect(popup.locator('input[placeholder="Goal title"]').first(), `${message}: proposal popout content`).toBeVisible({ timeout: 20_000 });
			else if (kind === "pack") await expect(popup.locator('[data-testid="pack-panel-root"], [data-testid="prw-panel-root"]').first(), `${message}: pack popout content`).toBeVisible({ timeout: 20_000 });
		}
	} finally {
		await popup.close().catch(() => {});
	}
}

async function exerciseSharedWindowControls(page: Page, sessionId: string, tabId: string, message: string): Promise<void> {
	await clickTabById(page, tabId, `${message}: tab should be selectable`);
	await expect(page.locator(SIDE_PANEL_FULLSCREEN).first(), `${message}: fullscreen control`).toBeVisible({ timeout: 10_000 });
	await expect(page.locator(SIDE_PANEL_COLLAPSE).first(), `${message}: collapse control`).toBeVisible({ timeout: 10_000 });
	await expectPopoutOpens(page, tabId, message);

	await page.locator(SIDE_PANEL_FULLSCREEN).first().click();
	await expect(page.locator(SIDE_PANEL_RESTORE).first(), `${message}: restore after fullscreen`).toBeVisible({ timeout: 10_000 });
	await expectSizeMode(page, sessionId, "fullscreen", `${message}: fullscreen persists to server`);

	await page.locator(SIDE_PANEL_RESTORE).first().click();
	await expect(page.locator(SIDE_PANEL_FULLSCREEN).first(), `${message}: fullscreen returns after restore`).toBeVisible({ timeout: 10_000 });
	await expectSizeMode(page, sessionId, "split", `${message}: split persists to server`);

	await page.locator(SIDE_PANEL_COLLAPSE).first().click();
	await expect(page.locator(SIDE_PANEL_RESTORE).first(), `${message}: restore after collapse`).toBeVisible({ timeout: 10_000 });
	await expectSizeMode(page, sessionId, "collapsed", `${message}: collapse persists to server`);

	await page.locator(SIDE_PANEL_RESTORE).first().click();
	await expect(page.locator(SIDE_PANEL_FULLSCREEN).first(), `${message}: restored split controls`).toBeVisible({ timeout: 10_000 });
	await expectSizeMode(page, sessionId, "split", `${message}: final split persists to server`);
}

async function installArtifactsPack(): Promise<string> {
	const addRes = await apiFetch("/api/marketplace/sources", {
		method: "POST",
		body: JSON.stringify({ url: ARTIFACTS_SOURCE_DIR }),
	});
	const addBody = await addRes.text();
	expect(addRes.status, addBody).toBe(201);
	const sourceId = (JSON.parse(addBody) as { source: { id: string } }).source.id;
	const instRes = await apiFetch("/api/marketplace/install", {
		method: "POST",
		body: JSON.stringify({ sourceId, dirName: ARTIFACTS_PACK, scope: "server" }),
	});
	const instBody = await instRes.text();
	expect(instRes.status, instBody).toBe(201);
	return sourceId;
}

async function cleanupArtifactsPack(sourceId?: string): Promise<void> {
	await apiFetch("/api/marketplace/installed", {
		method: "DELETE",
		body: JSON.stringify({ scope: "server", packName: ARTIFACTS_PACK }),
	}).catch(() => {});
	if (sourceId) await apiFetch(`/api/marketplace/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Side-panel tab contract", () => {
	test.describe.configure({ timeout: 120_000 });
	const staffCleanup: string[] = [];

	test.afterAll(async () => {
		for (const staffId of staffCleanup) {
			await apiFetch(`/api/staff/${staffId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("1. Chat is never a tab and an empty non-staff side pane stays hidden", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 10_000 });
		await expectPanelHidden(page);
		await expect.poll(() => visiblePanelTabs(page), {
			timeout: 5_000,
			message: "fresh non-staff session should have no side-pane tabs",
		}).toEqual([]);
		await expectNoChatTab(page);
		await expectNoPersistedChatTab(page, sessionId);
		await expectActivePanelTabId(page, "", "fresh non-staff session should not store an active side-pane id");
	});

	test("2. Current preview lifecycle keeps one unversioned filename tab per entry", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		await mountPreviewHtml(page, sessionId, "a.html", "Preview A v1");
		await mountPreviewHtml(page, sessionId, "b.html", "Preview B v1");
		await mountPreviewHtml(page, sessionId, "c.html", "Preview C v1");
		await expectPanelTabs(page, [previewId("a.html"), previewId("b.html"), previewId("c.html")], "a/b/c preview tabs should stay in creation order");
		await expectActivePanelTabId(page, previewId("c.html"), "latest preview c.html should take focus");

		await mountPreviewHtml(page, sessionId, "a.html", "Preview A v2");
		await expectPanelTabs(page, [previewId("a.html"), previewId("b.html"), previewId("c.html")], "refreshing a.html should reuse its tab without duplicates or reorder");
		await expectActivePanelTabId(page, previewId("a.html"), "refreshed a.html should take focus");
		await expectPreviewContains(page, "Preview A v2", "refreshed a.html tab should render updated content");
		const labels = await visiblePanelTabLabels(page);
		expect(labels.filter((label) => label === "a.html")).toHaveLength(1);
		expect(labels.some((label) => /a\.html\s*\(v\d+\)/.test(label))).toBe(false);
	});

	test("3. Immutable historical preview artifacts restore old bytes and matching hashes collapse", async ({ page, gateway }, testInfo) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		const filePath = testInfo.outputPath("preview-artifacts/a.html");
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, previewHtml("Artifact A v1 immutable"), "utf8");
		const v1 = await mountPreviewFile(page, sessionId, filePath, "a.html", "Artifact A v1 immutable");
		await writeFile(filePath, previewHtml("Artifact A v2 current"), "utf8");
		const v2 = await mountPreviewFile(page, sessionId, filePath, "a.html", "Artifact A v2 current");
		expect(v1.contentHash).not.toBe(v2.contentHash);

		await setMockTranscript(gateway, sessionId, [
			...v3PreviewToolCardMessages("tool-a-v1", v1, { file: filePath }),
			...v3PreviewToolCardMessages("tool-a-v2", v2, { file: filePath }),
		]);
		await refreshTranscriptFromGateway(page, 2, "preview_open cards for a.html v1/v2 should hydrate");

		let matchingHashRestorePosts = 0;
		page.on("request", (request) => {
			const url = request.url();
			if (request.method() === "POST" && (url.includes("/api/preview/mount") || url.includes("/api/preview/artifacts/"))) {
				matchingHashRestorePosts += 1;
			}
		});

		await openPreviewToolCard(page, 1, "latest a.html preview card should be openable");
		await expectPanelTabs(page, [previewId("a.html")], "opening latest v2 card should select the filename tab only");
		await expectActivePanelTabId(page, previewId("a.html"), "latest card should select preview:entry:a.html, not a versioned tab");
		await expectPreviewContains(page, "Artifact A v2 current", "latest card should render current bytes");
		expect(await visiblePanelTabLabels(page)).not.toContain("a.html (v2)");
		expect(matchingHashRestorePosts, "matching latest contentHash should not remount or create a historical tab").toBe(0);

		await openPreviewToolCard(page, 0, "older a.html v1 preview card should be openable");
		await expect.poll(() => visiblePanelTabIds(page), {
			timeout: 15_000,
			message: "older differing preview artifact should open a separate historical tab",
		}).toEqual([previewId("a.html"), previewVersionId("a.html", 1)]);
		await expectActivePanelTabId(page, previewVersionId("a.html", 1), "older differing artifact should select a.html (v1)");
		await expectPreviewContains(page, "Artifact A v1 immutable", "historical v1 tab should render original bytes after the source file was mutated");
		await expect(page.locator(".goal-tab-pill", { hasText: /^a\.html \(v1\)$/ })).toHaveCount(1);

		await clickTabById(page, previewId("a.html"), "current a.html tab should remain selectable after opening v1");
		await expectPreviewContains(page, "Artifact A v2 current", "current filename tab should still render v2");

		matchingHashRestorePosts = 0;
		await openPreviewToolCard(page, 1, "reopening a matching current hash should collapse to current");
		await expectActivePanelTabId(page, previewId("a.html"), "matching current hash should collapse to filename tab");
		await expectPanelTabs(page, [previewId("a.html"), previewVersionId("a.html", 1)], "matching current hash should not add a v2 duplicate");
		expect(await visiblePanelTabLabels(page)).not.toContain("a.html (v2)");
		expect(matchingHashRestorePosts, "matching current hash should skip remount on reopen").toBe(0);
	});

	test("4. Dismiss removes only the closed tab and active selection moves next-right then left", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		await mountPreviewHtml(page, sessionId, "one.html", "Dismiss One");
		await mountPreviewHtml(page, sessionId, "two.html", "Dismiss Two");
		await mountPreviewHtml(page, sessionId, "three.html", "Dismiss Three");
		const proposalId = await openGoalProposal(page);
		const reviewId = await openReview(page);

		const expectedInitial = [previewId("one.html"), previewId("two.html"), previewId("three.html"), proposalId, reviewId];
		await expectPanelTabs(page, expectedInitial, "preview/proposal/review tabs should share stored order");

		await clickTabById(page, previewId("two.html"), "middle preview tab should be selectable before close");
		await closeTabById(page, previewId("two.html"), "closing middle preview two.html");
		await expectPanelTabs(page, [previewId("one.html"), previewId("three.html"), proposalId, reviewId], "closing one preview tab should preserve the others and their order");
		await expectActivePanelTabId(page, previewId("three.html"), "closing active middle tab should activate next tab to the right");

		await closeTabById(page, previewId("three.html"), "closing active preview three.html");
		await expectActivePanelTabId(page, proposalId, "closing preview should activate next-right proposal");
		await closeTabById(page, proposalId, "closing active proposal tab");
		await expectActivePanelTabId(page, reviewId, "closing proposal should activate next-right review");
		await closeTabById(page, reviewId, "closing active review tab");
		await expectActivePanelTabId(page, previewId("one.html"), "closing last right-hand tab should activate left fallback");
		await closeTabById(page, previewId("one.html"), "closing final side-pane tab");
		await expect.poll(() => visiblePanelTabs(page), { timeout: 10_000, message: "all side-pane tabs should be gone" }).toEqual([]);
		await expectPanelHidden(page);
	});

	test("5. Staff Inbox opens explicitly, is closable, and stays closed across reload", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		const staff = await createStaff(`SidePanelInbox-${Date.now()}`);
		staffCleanup.push(staff.id);
		await openApp(page);
		await navigateToSession(page, staff.currentSessionId);

		await expect.poll(() => visiblePanelTabs(page), { timeout: 10_000, message: "staff session should not auto-open Inbox" }).toEqual([]);
		await openStaffInboxPanel(page);
		let tabs = await visiblePanelTabs(page);
		expect(tabs[0]).toMatchObject({ id: "inbox", kind: "inbox" });
		expect(tabs[0].closable, "Inbox must render a close control").toBe(true);

		await mountPreviewHtml(page, staff.currentSessionId, "staff.html", "Staff Preview");
		await expectPanelTabs(page, ["inbox", previewId("staff.html")], "preview should open beside explicit Inbox tab");
		await closeTabById(page, "inbox", "closing staff inbox tab");
		await expectPanelTabs(page, [previewId("staff.html")], "closing Inbox should delete only the Inbox tab");
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, staff.currentSessionId);
		await expectPanelTabs(page, [previewId("staff.html")], "closed Inbox should not auto-reopen after reload");
		await expect(page.locator('[data-testid="staff-inbox-open"]')).toBeVisible({ timeout: 10_000 });
	});

	test("6. Desktop drag reorder persists for all side-panel tabs", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		await mountPreviewHtml(page, sessionId, "drag-a.html", "Drag A");
		await mountPreviewHtml(page, sessionId, "drag-b.html", "Drag B");
		await mountPreviewHtml(page, sessionId, "drag-c.html", "Drag C");
		const a = previewId("drag-a.html");
		const b = previewId("drag-b.html");
		const c = previewId("drag-c.html");
		await expectPanelTabs(page, [a, b, c], "drag test tabs should start in creation order");

		await dragTab(page, c, a, { toLeftEdge: true });
		await expectPanelTabs(page, [c, a, b], "dragging c before a should persist in visible order");
		await expect.poll(() => page.evaluate((sid) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState ?? {};
			return (state.panelTabsBySession?.[sid] || []).map((tab: any) => tab?.id);
		}, sessionId), { timeout: 5_000, message: "drag order should be stored per session" }).toEqual([c, a, b]);

		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectPanelTabs(page, [c, a, b], "dragged order should survive reload");
		await expectNoPersistedChatTab(page, sessionId);

		const staff = await createStaff(`SidePanelDrag-${Date.now()}`);
		staffCleanup.push(staff.id);
		await navigateToSession(page, staff.currentSessionId);
		await openStaffInboxPanel(page);
		await mountPreviewHtml(page, staff.currentSessionId, "inbox-a.html", "Inbox A");
		const inboxA = previewId("inbox-a.html");
		await expectPanelTabs(page, ["inbox", inboxA], "staff drag test should start with explicit Inbox and preview");
		await dragTab(page, inboxA, "inbox", { toLeftEdge: true });
		await expectPanelTabs(page, [inboxA, "inbox"], "preview tabs can be dropped before Inbox because Inbox is a normal tab");
		await expectNoChatTab(page);
	});

	test("7. Clicking each side-pane tab activates that exact id and renders matching content", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		const staff = await createStaff(`SidePanelIdentity-${Date.now()}`);
		staffCleanup.push(staff.id);
		await openApp(page);
		await navigateToSession(page, staff.currentSessionId);
		await openStaffInboxPanel(page);

		const previewText = "Identity Preview";
		await mountPreviewHtml(page, staff.currentSessionId, "identity.html", previewText);
		const proposalId = await openGoalProposal(page);
		const reviewId = await openReview(page);
		const previewTabId = previewId("identity.html");
		await expectPanelTabs(page, ["inbox", previewTabId, proposalId, reviewId], "identity test should have inbox + preview + proposal + review visible");

		const signatures: string[] = [];
		for (const id of ["inbox", previewTabId, proposalId, reviewId]) {
			const tab = (await visiblePanelTabs(page)).find((candidate) => candidate.id === id)!;
			signatures.push(await expectContentForTab(page, tab, previewText));
		}
		expect(new Set(signatures).size, `every tab should render distinct content; signatures=${JSON.stringify(signatures)}`).toBe(signatures.length);

		await closeTabById(page, previewTabId, "closing representative preview tab in identity test");
		await closeTabById(page, proposalId, "closing representative proposal tab in identity test");
		for (const id of ["inbox", reviewId]) {
			const tab = (await visiblePanelTabs(page)).find((candidate) => candidate.id === id)!;
			await expectContentForTab(page, tab, previewText);
		}
		await expectPanelTabs(page, ["inbox", reviewId], "remaining identity tabs should keep exact ids after closes");
	});

	test("8. Agent-driven focus changes do not reorder existing tabs", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		const proposalId = await openGoalProposal(page);
		await expectPanelTabs(page, [proposalId], "initial proposal tab should be first");
		await expectActivePanelTabId(page, proposalId, "proposal should take focus when created");

		await mountPreviewHtml(page, sessionId, "focus.html", "Focus Preview v1");
		const focusId = previewId("focus.html");
		await expectPanelTabs(page, [proposalId, focusId], "new preview should append after existing proposal tab");
		await expectActivePanelTabId(page, focusId, "new preview should take focus without reordering proposal");

		await clickTabById(page, proposalId, "proposal should remain selectable after preview opens");
		await clickTabById(page, focusId, "preview should remain selectable after proposal click");
		await mountPreviewHtml(page, sessionId, "focus.html", "Focus Preview v2");
		await expectPanelTabs(page, [proposalId, focusId], "refreshing an existing preview should not reorder tabs");
		await expectActivePanelTabId(page, focusId, "refreshed preview should take focus in place");

		await updateGoalProposal(page);
		await expectPanelTabs(page, [proposalId, focusId], "updating an existing proposal should not reorder preview/proposal tabs");
		await expectActivePanelTabId(page, proposalId, "proposal update should focus its existing tab in place");
	});

	test("9. Server workspace is authoritative across close/open reloads", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		const proposalId = await openGoalProposal(page);
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectPanelTabs(page, [proposalId], "leaving a proposal tab open should survive reload/reconnect");
		await expect(page.locator('input[placeholder="Goal title"]').first()).toHaveValue("Parity Goal A", { timeout: 20_000 });

		await closeTabById(page, proposalId, "closing proposal before reload");
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectPanelTabs(page, [], "closed proposal tabs must not be re-derived from activeProposals on reload");
		await expect(page.locator('input[placeholder="Goal title"]')).toHaveCount(0);
		const refetched = await workspace(sessionId);
		expect(refetched.tabs.map((tab: any) => tab.id)).toEqual([]);
	});

	test("9b. Closing review tab preserves content but keeps closed workspace state across navigation and reload", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		const reviewId = await openReview(page);
		await closeTabById(page, reviewId, "closing review workspace tab should not delete review content");
		await expectPanelTabs(page, [], "closed review tab should disappear immediately");
		await expect.poll(() => page.evaluate(() => ((window as any).bobbitState?.reviewDocuments?.size ?? 0)), {
			timeout: 5_000,
			message: "closed review tab should preserve the cached review document for explicit reopen",
		}).toBeGreaterThan(0);
		await expect.poll(async () => (await workspace(sessionId)).tabs.map((tab: any) => tab.id), {
			timeout: 10_000,
			message: "server workspace should persist the closed review tab absence",
		}).toEqual([]);

		await navigateAwayAndBackToSession(page, sessionId, "closed review durable close");
		await expectPanelTabs(page, [], "closed review tab must not be re-derived from cached review documents after navigation away/back");
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectPanelTabs(page, [], "closed review tab must not be re-derived from restored review document caches after reload");
		await expect(page.locator("review-document")).toHaveCount(0);

		const reopenedId = await openReview(page);
		expect(reopenedId).toBe(reviewId);
		await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible({ timeout: 10_000 });
	});

	test("Persist Closed Panels: explicit Open Proposal reopens after durable close but draft rehydrate does not", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createGoalAssistantSessionViaApi(page);
		const proposalId = await openGoalProposal(page);
		let draft: { fields: Record<string, unknown>; rev: number } | undefined;
		await expect.poll(async () => {
			const resp = await apiFetch(`/api/sessions/${sessionId}/proposals`);
			if (!resp.ok) return [];
			const body = await resp.json() as { proposals?: Array<{ proposalType?: string; fields?: Record<string, unknown>; rev?: number }> };
			const goalDraft = (body.proposals || []).find((proposal) => proposal.proposalType === "goal" && typeof proposal.rev === "number" && proposal.fields);
			if (goalDraft?.fields && typeof goalDraft.rev === "number") draft = { fields: goalDraft.fields, rev: goalDraft.rev };
			return (body.proposals || []).map((proposal) => `${proposal.proposalType}:${proposal.rev}`);
		}, {
			timeout: 10_000,
			message: "goal proposal draft should be persisted before closing its workspace tab",
		}).toContain("goal:1");
		expect(draft, "goal proposal draft should be available for rehydrate replay").toBeTruthy();

		await closeWorkspaceTabViaApi(page, sessionId, proposalId, "closing proposal workspace tab before draft rehydrate");
		await expectClosedSidePanelTabAbsent(page, sessionId, proposalId, "proposal tab immediately after workspace close");

		await page.evaluate(({ fields, rev }) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			if (state?.activeProposals) delete state.activeProposals.goal;
			const remote = state?.remoteAgent;
			remote?.onProposal?.("goal", fields, false, rev, "rehydrate");
		}, draft!);

		await expectClosedSidePanelTabAbsent(page, sessionId, proposalId, "proposal tab after non-explicit draft rehydrate replay");
		await navigateAwayAndBackToSession(page, sessionId, "proposal durable close after draft rehydrate");
		await expectClosedSidePanelTabAbsent(page, sessionId, proposalId, "proposal tab after navigate away/back with draft still present");

		await openProposalToolCard(page, proposalId, "proposal durable close explicit reopen");
	});

	test("Persist Closed Panels: proposal Dismiss close path does not resurrect after navigation or reload", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		const proposalId = await openGoalProposal(page);

		const dismiss = page.locator("button").filter({ hasText: "Dismiss" }).first();
		await expect(dismiss, "regular-session proposal should expose Dismiss close path").toBeVisible({ timeout: 10_000 });
		await dismiss.click();
		await expectClosedSidePanelTabAbsent(page, sessionId, proposalId, "proposal tab after Dismiss close path");
		await expect(page.locator('input[placeholder="Goal title"]').first(), "Dismissed proposal form should disappear immediately").not.toBeVisible({ timeout: 5_000 });

		await navigateAwayAndBackToSession(page, sessionId, "dismissed proposal durable close");
		await expectClosedSidePanelTabAbsent(page, sessionId, proposalId, "dismissed proposal tab after navigation away/back");
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectClosedSidePanelTabAbsent(page, sessionId, proposalId, "dismissed proposal tab after reload/reconnect");
	});

	test("Persist Closed Panels: proposal Create Goal close path does not resurrect after returning to the source session", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createSessionViaUI(page);
		const proposalId = await openGoalProposal(page);
		const beforeGoals = await goalIdsByTitle("Parity Goal A");
		try {
			const createResp = page.waitForResponse(
				(resp) => resp.url().includes("/api/goals") && resp.request().method() === "POST",
				{ timeout: 30_000 },
			);
			const create = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(create, "proposal Create Goal action should be available").toBeVisible({ timeout: 10_000 });
			await create.click();
			const response = await createResp;
			expect(response.ok(), `Create Goal should succeed: ${await response.text().catch(() => "")}`).toBe(true);
			await expect(page, "Create Goal should navigate away from the source session").toHaveURL(/#\/goal(?:-dashboard)?\//, { timeout: 20_000 });

			await navigateToSession(page, sessionId);
			await expectClosedSidePanelTabAbsent(page, sessionId, proposalId, "accepted proposal tab after returning to source session");
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToSession(page, sessionId);
			await expectClosedSidePanelTabAbsent(page, sessionId, proposalId, "accepted proposal tab after source session reload/reconnect");
		} finally {
			await cleanupNewGoalsByTitle("Parity Goal A", beforeGoals);
		}
	});

	test("Persist Closed Panels: preview close survives bootstrap/reload and explicit preview Open reopens", async ({ page, gateway }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		const mounted = await mountPreviewHtml(page, sessionId, "durable-preview.html", "Durable Preview Mount");
		const previewTab = previewId("durable-preview.html");

		await closeTabById(page, previewTab, "closing preview while its mount still exists");
		await expectClosedSidePanelTabAbsent(page, sessionId, previewTab, "preview tab immediately after close with mount still present");

		await navigateAwayAndBackToSession(page, sessionId, "preview durable close with mount still present");
		await expectClosedSidePanelTabAbsent(page, sessionId, previewTab, "preview tab after navigation away/back with mount still present");
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectClosedSidePanelTabAbsent(page, sessionId, previewTab, "preview tab after reload/bootstrap with mount still present");
		await expect(page.locator(".goal-preview-panel"), "closed preview tab should not be re-rendered from preview bootstrap metadata").toHaveCount(0);

		await setMockTranscript(gateway, sessionId, [
			...v3PreviewToolCardMessages("tool-durable-preview", mounted, { entry: "durable-preview.html", html: previewHtml("Durable Preview Mount") }),
		]);
		await refreshTranscriptFromGateway(page, 1, "preview_open card should hydrate for explicit reopen after durable close");
		await openPreviewToolCard(page, 0, "explicit preview Open should reopen a durable-closed preview tab");
		await expectPanelTabs(page, [previewTab], "explicit preview Open should recreate only the requested preview tab");
		await expectPreviewContains(page, "Durable Preview Mount", "reopened durable-close preview");
	});

	test("10. Size mode persists across reload for collapsed, split, and fullscreen preview states", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		const previewTab = previewId("size.html");
		await mountPreviewHtml(page, sessionId, "size.html", "Size Persistence Preview");
		await exerciseSharedWindowControls(page, sessionId, previewTab, "preview shared controls");

		await page.locator(SIDE_PANEL_COLLAPSE).first().click();
		await expectSizeMode(page, sessionId, "collapsed", "collapsed state should be stored before reload");
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectSizeMode(page, sessionId, "collapsed", "collapsed state should survive reload");
		await expect(page.locator(SIDE_PANEL_RESTORE).first()).toBeVisible({ timeout: 10_000 });

		await page.locator(SIDE_PANEL_RESTORE).first().click();
		await expectSizeMode(page, sessionId, "split", "split state should be stored before reload");
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectSizeMode(page, sessionId, "split", "split state should survive reload");
		await expectPreviewContains(page, "Size Persistence Preview", "split preview after reload");

		await page.locator(SIDE_PANEL_FULLSCREEN).first().click();
		await expectSizeMode(page, sessionId, "fullscreen", "fullscreen state should be stored before reload");
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expectSizeMode(page, sessionId, "fullscreen", "fullscreen state should survive reload");
		await expect(page.locator(SIDE_PANEL_RESTORE).first()).toBeVisible({ timeout: 10_000 });
		await expectPreviewContains(page, "Size Persistence Preview", "fullscreen preview after reload");
	});

	test("11. Cross-device contexts sync open, close, active, reorder, and size mode", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		const browser = page.context().browser();
		expect(browser, "browser instance should be available for a second device context").toBeTruthy();
		const context2 = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
		const page2 = await context2.newPage();
		try {
			await openApp(page2);
			await navigateToSession(page2, sessionId);

			await mountPreviewHtml(page, sessionId, "sync.html", "Cross Device Preview");
			const proposalId = await openGoalProposal(page);
			const previewTab = previewId("sync.html");
			await expectPanelTabs(page2, [previewTab, proposalId], "second device should receive opened tabs over WS");

			await clickTabById(page, previewTab, "first device activates preview");
			const activeResp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/active`, {
				method: "POST",
				body: JSON.stringify({ activeTabId: previewTab }),
			});
			expect(activeResp.status, await activeResp.text()).toBe(200);
			await expectActivePanelTabId(page2, previewTab, "second device should receive active-tab changes");

			const beforeReorder = await workspace(sessionId);
			const reorderResp = await apiFetch(`/api/sessions/${sessionId}/side-panel-workspace/reorder`, {
				method: "POST",
				body: JSON.stringify({ baseRevision: beforeReorder.revision, tabIds: [proposalId, previewTab] }),
			});
			expect(reorderResp.status, await reorderResp.text()).toBe(200);
			await expectPanelTabs(page, [proposalId, previewTab], "first device should render server reorder");
			await expectPanelTabs(page2, [proposalId, previewTab], "second device should receive reorder over WS");

			await page.locator(SIDE_PANEL_FULLSCREEN).first().click();
			await expectSizeMode(page2, sessionId, "fullscreen", "second device should receive fullscreen size mode");
			await page.locator(SIDE_PANEL_RESTORE).first().click();
			await expectSizeMode(page2, sessionId, "split", "second device should receive split size mode");

			await closeTabById(page, previewTab, "first device closes preview");
			await expectPanelTabs(page2, [proposalId], "second device should receive tab close over WS");
		} finally {
			await context2.close().catch(() => {});
		}
	});

	test("12. Proposal, review, and staff inbox tabs expose shared controls and popout", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		const staff = await createStaff(`SidePanelControls-${Date.now()}`);
		staffCleanup.push(staff.id);
		await openApp(page);
		await navigateToSession(page, staff.currentSessionId);
		await openStaffInboxPanel(page);

		await exerciseSharedWindowControls(page, staff.currentSessionId, "inbox", "staff inbox shared controls");
		const proposalId = await openGoalProposal(page);
		await exerciseSharedWindowControls(page, staff.currentSessionId, proposalId, "proposal shared controls");
		const reviewId = await openReview(page);
		await exerciseSharedWindowControls(page, staff.currentSessionId, reviewId, "review shared controls");
	});

	test("13. PR walkthrough pack panel uses shared controls and popout", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);
		await openPrWalkthroughPanel(page, sessionId);
		await exerciseSharedWindowControls(page, sessionId, PRW_TAB_ID, "PR walkthrough pack shared controls");
	});

	test("14. Artifact-style pack viewer opens multiple independent panel instances", async ({ page }) => {
		await page.setViewportSize({ width: 1400, height: 900 });
		let sourceId: string | undefined;
		try {
			sourceId = await installArtifactsPack();
			await openApp(page);
			const sessionId = await createRegularSessionViaApi(page);
			await page.evaluate(() => (window as any).__bobbitReconcilePackRenderers?.()).catch(() => {});

			await sendMessage(page, "ARTIFACT_DEMO_TOOL please");
			await expect(page.locator('[data-testid="artifact-pill"][data-artifact-id="art-demo-1"]').first()).toBeVisible({ timeout: 25_000 });
			await sendMessage(page, "ARTIFACT_DEMO_MD please");
			await expect(page.locator('[data-testid="artifact-pill"][data-artifact-id="art-demo-md"]').first()).toBeVisible({ timeout: 25_000 });

			await page.locator('[data-testid="artifact-pill"][data-artifact-id="art-demo-1"]').first().click();
			await expect(page.locator('[data-testid="artifact-viewer-content"][data-artifact-id="art-demo-1"]').first()).toBeVisible({ timeout: 15_000 });
			await page.locator('[data-testid="artifact-pill"][data-artifact-id="art-demo-md"]').first().click();
			await expect(page.locator('[data-testid="artifact-viewer-content"][data-artifact-id="art-demo-md"]').first()).toBeVisible({ timeout: 15_000 });

			await expect.poll(async () => (await visiblePanelTabs(page)).filter((tab) => tab.kind === "pack" && tab.id.includes(`${ARTIFACTS_PACK}:${ARTIFACTS_PANEL_ID}`)).map((tab) => tab.id).sort(), {
				timeout: 15_000,
				message: "two artifact viewer instances should coexist as independent pack tabs",
			}).toEqual([
				`pack:${ARTIFACTS_PACK}:${ARTIFACTS_PANEL_ID}:art-demo-1`,
				`pack:${ARTIFACTS_PACK}:${ARTIFACTS_PANEL_ID}:art-demo-md`,
			].sort());

			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToSession(page, sessionId);
			await expectPanelTabs(page, [
				`pack:${ARTIFACTS_PACK}:${ARTIFACTS_PANEL_ID}:art-demo-1`,
				`pack:${ARTIFACTS_PACK}:${ARTIFACTS_PANEL_ID}:art-demo-md`,
			], "artifact pack tabs should persist independently across reload");
			await clickTabById(page, `pack:${ARTIFACTS_PACK}:${ARTIFACTS_PANEL_ID}:art-demo-md`, "markdown artifact tab after reload");
			await expect(page.locator('[data-testid="artifact-viewer-content"][data-artifact-id="art-demo-md"]').first()).toBeVisible({ timeout: 20_000 });
			await exerciseSharedWindowControls(page, sessionId, `pack:${ARTIFACTS_PACK}:${ARTIFACTS_PANEL_ID}:art-demo-md`, "artifact pack shared controls");
		} finally {
			await cleanupArtifactsPack(sourceId);
		}
	});

	test("15. Legacy localStorage workspace keys migrate once and stop being authoritative", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		const sessionId = await createSession({ cwd: nonGitCwd() });
		const legacyPreviewId = previewId("legacy.html");
		await page.addInitScript(({ sid, tabId }) => {
			const tab = {
				id: tabId,
				kind: "preview",
				title: "legacy.html",
				label: "legacy.html",
				source: { type: "preview", entry: "legacy.html", live: true },
			};
			localStorage.setItem("bobbit-panel-tabs-by-session", JSON.stringify({ [sid]: [tab] }));
			localStorage.setItem("bobbit-panel-active-by-session", JSON.stringify({ [sid]: tabId }));
			localStorage.setItem(`bobbit-preview-collapsed-${sid}`, "true");
		}, { sid: sessionId, tabId: legacyPreviewId });

		await openApp(page);
		await navigateToSession(page, sessionId);
		await expectSizeMode(page, sessionId, "collapsed", "legacy collapsed key should migrate to server size mode");
		await expect.poll(async () => {
			const migrated = await workspace(sessionId);
			return { ids: migrated.tabs.map((tab: any) => tab.id), active: migrated.activeTabId, stamped: migrated.metadata?.migratedFromLocalStorageAt > 0 };
		}, { timeout: 15_000, message: "legacy localStorage tabs should migrate into the server workspace" })
			.toEqual({ ids: [legacyPreviewId], active: legacyPreviewId, stamped: true });
		await page.locator(SIDE_PANEL_RESTORE).first().click();
		await expectPanelTabs(page, [legacyPreviewId], "restoring migrated collapsed workspace should reveal migrated tab");

		await page.evaluate(({ sid }) => {
			localStorage.setItem("bobbit-panel-tabs-by-session", JSON.stringify({ [sid]: [{ id: "proposal:goal", kind: "proposal", title: "Goal", label: "Goal", source: { type: "proposal", proposalType: "goal" } }] }));
			localStorage.setItem("bobbit-panel-active-by-session", JSON.stringify({ [sid]: "proposal:goal" }));
		}, { sid: sessionId });
		await page.reload({ waitUntil: "domcontentloaded" });
		await navigateToSession(page, sessionId);
		await expect.poll(async () => {
			const migrated = await workspace(sessionId);
			return { ids: migrated.tabs.map((tab: any) => tab.id), active: migrated.activeTabId };
		}, { timeout: 15_000, message: "post-migration localStorage edits must not replace server workspace" })
			.toEqual({ ids: [legacyPreviewId], active: legacyPreviewId });
		await expectActivePanelTabId(page, legacyPreviewId, "post-migration localStorage edits must not replace client active tab");
	});

	test("16. Mobile side-pane tabs include pinned Chat pill (not persisted), swipes reveal chat/panel, and touch does not reorder tabs", async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 800 });
		await openApp(page);
		const sessionId = await createRegularSessionViaApi(page);

		await mountPreviewHtml(page, sessionId, "mobile-a.html", "Mobile A");
		await mountPreviewHtml(page, sessionId, "mobile-b.html", "Mobile B");
		const mobileA = previewId("mobile-a.html");
		const mobileB = previewId("mobile-b.html");
		await expectPanelTabs(page, [mobileA, mobileB], "mobile tab strip should contain only side-pane preview tabs");
		// Mobile now includes a pinned Chat pill as the first tab — a UI
		// affordance that swipes the slider to the chat pane. It is rendered
		// outside the persisted panel-tab list, so it never appears in
		// `state.panelTabsBySession`.
		await expect(page.locator(".goal-tab-bar .goal-tab-pill[data-panel-tab-kind='chat']")).toHaveCount(1);
		await expectNoPersistedChatTab(page, sessionId);

		const beforeTouchDrag = await visiblePanelTabIds(page);
		await dispatchTouchTabDrag(page, mobileB, mobileA);
		await expectPanelTabs(page, beforeTouchDrag, "touch pointer drag should not reorder side-pane tabs");

		await clickTabById(page, mobileA, "first mobile preview side tab should be selectable");
		await expectPreviewContains(page, "Mobile A", "first mobile side pane should render preview");
		await swipeApp(page, 30, 320, 420);
		await expect(page.locator("textarea").first(), "right swipe from first side pane should reveal main chat").toBeVisible({ timeout: 10_000 });
		await expectNoChatTab(page);

		await swipeApp(page, 320, 30, 420);
		await expectPreviewContains(page, "Mobile A", "left swipe from main chat should reveal side pane again");
		await expectPanelTabs(page, beforeTouchDrag, "mobile swiping should not reorder tabs");
	});
});
