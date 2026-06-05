import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, defaultProject, nonGitCwd } from "../e2e-setup.js";
import { openApp, navigateToHash, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

const PANEL_TAB_SELECTOR = ".goal-tab-pill";
const PREVIEW_OPEN_BUTTON_SELECTOR = '[data-testid="preview-open-button"]';

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
	const review = (await visiblePanelTabs(page)).find((tab) => tab.kind === "review" && tab.id.startsWith("review:"));
	expect(review, `review tab should be visible; tabs=${JSON.stringify(await visiblePanelTabs(page))}`).toBeTruthy();
	await clickTabById(page, review!.id, "review tab should be selectable");
	await expect(page.locator("review-document").getByText("Section One").first()).toBeVisible({ timeout: 10_000 });
	return review!.id;
}

async function dragTab(page: Page, fromId: string, toId: string, options: { toLeftEdge?: boolean } = {}): Promise<void> {
	const from = await tabById(page, fromId);
	const to = await tabById(page, toId);
	await expect(from, `drag source ${fromId}`).toBeVisible({ timeout: 10_000 });
	await expect(to, `drag target ${toId}`).toBeVisible({ timeout: 10_000 });
	const fromBox = await from.boundingBox();
	const toBox = await to.boundingBox();
	expect(fromBox, `drag source ${fromId} should have a box`).not.toBeNull();
	expect(toBox, `drag target ${toId} should have a box`).not.toBeNull();
	await page.mouse.move(fromBox!.x + fromBox!.width / 2, fromBox!.y + fromBox!.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		options.toLeftEdge ? toBox!.x + 2 : toBox!.x + toBox!.width / 2,
		toBox!.y + toBox!.height / 2,
		{ steps: 12 },
	);
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

	test("5. Staff Inbox is pinned first, non-closable, non-draggable, and survives closing other tabs", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		const staff = await createStaff(`SidePanelInbox-${Date.now()}`);
		staffCleanup.push(staff.id);
		await openApp(page);
		await navigateToSession(page, staff.currentSessionId);

		await expect.poll(async () => (await visiblePanelTabs(page))[0] ?? null, { timeout: 20_000, message: "staff sessions should always expose Inbox" })
			.toMatchObject({ id: "inbox", kind: "inbox" });
		let tabs = await visiblePanelTabs(page);
		expect(tabs[0]).toMatchObject({ id: "inbox", kind: "inbox" });
		expect(tabs[0].closable, "Inbox must not render a close control").toBe(false);
		await expect(page.locator('[data-panel-tab-id="inbox"] .goal-tab-close')).toHaveCount(0);

		await mountPreviewHtml(page, staff.currentSessionId, "staff.html", "Staff Preview");
		await expectPanelTabs(page, ["inbox", previewId("staff.html")], "preview should open beside pinned Inbox");
		const beforeDrag = await visiblePanelTabIds(page);
		await dragTab(page, "inbox", previewId("staff.html"));
		await expectPanelTabs(page, beforeDrag, "dragging pinned Inbox should not change order");

		await closeTabById(page, previewId("staff.html"), "closing staff preview tab");
		await expectPanelTabs(page, ["inbox"], "Inbox should remain after every other tab closes");
		await expectActivePanelTabId(page, "inbox", "Inbox should be active after other tabs close");
		await expect(page.locator("inbox-panel")).toBeVisible({ timeout: 10_000 });
	});

	// FIXME: Fails deterministically on origin/master HEAD 130595bb (4/4 attempts).
	// NOT introduced by this branch — verified by running on a fresh worktree of
	// origin/master with the same Playwright config; same symptom reproduces.
	// Symptom: dragging a non-pinned tab before the pinned Inbox is allowed,
	// failing the assertion "non-pinned tabs cannot be dropped before pinned Inbox".
	// Suspected culprit: SortableJS `onMove` filter logic in render.ts::ensurePanelSortable
	// — the pinned-tab guard either isn't firing for this specific drop target or
	// the order is re-committed by `onEnd` despite the guard.
	// Likely a real product bug introduced by the recent master chain:
	//   98f7f0ce Chrome-style panel tab strip with SortableJS drag-and-drop
	//   122f76fc Editable historical proposal tabs + render-time override
	//   dac36684 Update tests + docs for Chrome-style tab system
	// Restore to `test(...)` once those bugs are fixed on master.
	test("6. Desktop drag reorder persists and cannot move tabs before pinned Inbox", async ({ page }) => {
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
		await mountPreviewHtml(page, staff.currentSessionId, "pinned-a.html", "Pinned A");
		await mountPreviewHtml(page, staff.currentSessionId, "pinned-b.html", "Pinned B");
		const pinnedA = previewId("pinned-a.html");
		const pinnedB = previewId("pinned-b.html");
		await expectPanelTabs(page, ["inbox", pinnedA, pinnedB], "staff drag test should start with pinned Inbox first");
		await dragTab(page, pinnedB, "inbox", { toLeftEdge: true });
		await expectPanelTabs(page, ["inbox", pinnedA, pinnedB], "non-pinned tabs cannot be dropped before pinned Inbox");
		await expectNoChatTab(page);
	});

	test("7. Clicking each side-pane tab activates that exact id and renders matching content", async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		const staff = await createStaff(`SidePanelIdentity-${Date.now()}`);
		staffCleanup.push(staff.id);
		await openApp(page);
		await navigateToSession(page, staff.currentSessionId);

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

	test("9. Mobile side-pane tabs include pinned Chat pill (not persisted), swipes reveal chat/panel, and touch does not reorder tabs", async ({ page }) => {
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
