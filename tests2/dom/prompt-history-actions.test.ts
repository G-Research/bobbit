import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { reloadPerfFlags } from "../../src/app/perf-flags.js";
import { state as appState } from "../../src/app/state.js";
import { selectPromptAuthorDisplayMode } from "../../src/ui/message-author-presentation.js";

const USER = { kind: "user", id: "user:local", label: "User" } as const;
const HELP_TEXT = "The new session will include the conversation up to, but not including, this prompt.";
const originalInnerWidth = window.innerWidth;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalPerfFlags = localStorage.getItem("bobbitPerfFlags");
let isEligibleHistoryPrompt: (message: any, context: any) => boolean;
let userVisiblePromptText: (message: any) => string;
let headerToast: () => unknown;
let RemoteAgentCtor: new () => any;

beforeAll(async () => {
	await import("../../src/app/session-manager.js");
	const messagesModule = await import("../../src/ui/components/Messages.js");
	const listModule = await import("../../src/ui/components/MessageList.js");
	({ headerToast } = await import("../../src/app/header-toast.js"));
	({ RemoteAgent: RemoteAgentCtor } = await import("../../src/app/remote-agent.js"));
	userVisiblePromptText = (messagesModule as any).userVisiblePromptText;
	isEligibleHistoryPrompt = (listModule as any).isEligibleHistoryPrompt;
	await import("../../src/ui/components/AgentInterface.js");
	await import("../../src/ui/lazy/safe-markdown-block.js");
	__syncCE();
	(HTMLElement.prototype as any).getAnimations ??= () => [];
});

afterEach(() => {
	document.body.innerHTML = "";
	Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
	appState.gatewaySessions = [];
	appState.archivedSessions = [];
	appState.creatingSession = false;
	if (originalClipboardDescriptor) Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
	else delete (navigator as any).clipboard;
	delete (document as any).execCommand;
	if (originalPerfFlags === null) localStorage.removeItem("bobbitPerfFlags");
	else localStorage.setItem("bobbitPerfFlags", originalPerfFlags);
	reloadPerfFlags();
});

async function settle(root: ParentNode = document.body): Promise<void> {
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
		const elements = Array.from(root.querySelectorAll("*")) as Array<Element & { updateComplete?: Promise<unknown> }>;
		await Promise.all(elements.map((el) => el.updateComplete?.catch?.(() => undefined) ?? undefined));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function durablePrompt(id: string, text = id, extra: Record<string, unknown> = {}): any {
	return {
		id: `render-${id}`,
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 100,
		author: USER,
		_origin: "server",
		entryId: id,
		_entryIdSource: "pi-transcript",
		...extra,
	};
}

async function renderList(messages: any[], options: { canForkSource?: boolean; isStreaming?: boolean } = {}): Promise<any> {
	const list = document.createElement("message-list") as any;
	list.messages = messages;
	list.tools = [];
	list.sessionId = "source-session";
	list.canForkSource = options.canForkSource ?? true;
	list.isStreaming = options.isStreaming ?? false;
	list.promptAuthorDisplayMode = selectPromptAuthorDisplayMode(messages);
	document.body.appendChild(list);
	await list.updateComplete;
	await settle();
	return list;
}

function promptTriggers(root: ParentNode = document): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>("button[aria-label^='Actions for prompt']"));
}

async function openPromptMenu(trigger: HTMLElement): Promise<HTMLElement> {
	trigger.click();
	await settle();
	const popover = document.body.querySelector<HTMLElement>("sidebar-actions-popover");
	if (!popover) throw new Error("prompt actions popover did not open");
	return popover;
}

function setDeferredRendering(enabled: boolean): void {
	localStorage.setItem(
		"bobbitPerfFlags",
		enabled ? "deferOffscreenRender" : "-deferOffscreenRender",
	);
	reloadPerfFlags();
}

function actionRow(popover: ParentNode, id: string): HTMLElement {
	const row = popover.querySelector<HTMLElement>(`[role='menuitem'][data-session-action-id='${id}']`);
	if (!row) throw new Error(`missing action row ${id}`);
	return row;
}

function menuLabels(popover: ParentNode): string[] {
	return Array.from(popover.querySelectorAll<HTMLElement>("[role='menuitem'] [data-sidebar-actions-label]"))
		.map((label) => label.textContent?.trim() ?? "");
}

describe("history prompt eligibility", () => {
	it("fails closed across the role, provenance, cursor, forkability, and pending matrix", () => {
		const eligible = durablePrompt("entry-eligible");
		const context = { canForkSource: true };
		expect(isEligibleHistoryPrompt(eligible, context)).toBe(true);

		const ineligible = [
			{ ...eligible, role: "assistant" },
			{ ...eligible, role: "toolResult" },
			{ ...eligible, content: [{ type: "toolResult", toolCallId: "call-1" }] },
			{ ...eligible, _origin: "optimistic" },
			{ ...eligible, _origin: "synthetic" },
			{ ...eligible, _origin: "permission" },
			{ ...eligible, _origin: undefined },
			{ ...eligible, entryId: undefined },
			{ ...eligible, entryId: "" },
			{ ...eligible, entryId: "x".repeat(257) },
			{ ...eligible, _entryIdSource: undefined },
			{ ...eligible, _entryIdSource: "render-message" },
			{ ...eligible, _pending: true },
		];
		for (const message of ineligible) {
			expect(isEligibleHistoryPrompt(message, context), JSON.stringify(message)).toBe(false);
		}
		expect(isEligibleHistoryPrompt(eligible, { canForkSource: false })).toBe(false);
	});

	it("renders actions only for eligible durable historic rows", async () => {
		const valid = durablePrompt("valid");
		const list = await renderList([
			valid,
			durablePrompt("optimistic", "optimistic", { _origin: "optimistic" }),
			durablePrompt("synthetic", "synthetic", { _origin: "synthetic" }),
			durablePrompt("missing-provenance", "missing", { _entryIdSource: undefined }),
			{ id: "assistant", role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 101 },
			{ id: "tool", role: "toolResult", toolCallId: "call-1", toolName: "read", content: [], timestamp: 102 },
		]);
		expect(promptTriggers(list)).toHaveLength(1);
		expect(promptTriggers(list)[0].closest("user-message")?.textContent).toContain("valid");

		document.body.innerHTML = "";
		const streaming = await renderList([
			durablePrompt("older"),
			durablePrompt("current"),
		], { isStreaming: true });
		expect(promptTriggers(streaming)).toHaveLength(2);
		expect(promptTriggers(streaming)[1].closest("user-message")?.textContent).toContain("current");

		document.body.innerHTML = "";
		const nonForkable = await renderList([durablePrompt("archived-source")], { canForkSource: false });
		expect(promptTriggers(nonForkable)).toHaveLength(0);
	});

	it.each([
		["optimistic", durablePrompt("current-optimistic", "current optimistic", { _origin: "optimistic" })],
		["id-less server", durablePrompt("current-idless", "current id-less server", { entryId: undefined })],
	] as const)("keeps the prior durable prompt actionable for an %s current row", async (_kind, current) => {
		const prior = durablePrompt("prior-durable");
		const list = await renderList([prior]);
		const initialTrigger = promptTriggers(list)[0];
		const initialPopover = await openPromptMenu(initialTrigger);

		list.messages = [prior, current];
		list.isStreaming = true;
		await list.updateComplete;
		await settle();

		const [priorTrigger] = promptTriggers(list);
		expect(promptTriggers(list)).toHaveLength(1);
		expect(priorTrigger.closest("user-message")?.textContent).toContain("prior-durable");
		expect(initialPopover.isConnected).toBe(true);
		expect(initialPopover.querySelector("[role='menu']")).toBeTruthy();

		priorTrigger.click();
		await settle();
		expect(document.body.querySelector("sidebar-actions-popover")).toBeNull();
		const reopened = await openPromptMenu(promptTriggers(list)[0]);
		expect(actionRow(reopened, "history-fork")).toBeTruthy();
	});

	it("keeps a trusted durable current row actionable while streaming", async () => {
		const prior = durablePrompt("prior-trusted");
		const current = durablePrompt("current-trusted");
		const list = await renderList([prior, current], { isStreaming: true });

		expect(promptTriggers(list)).toHaveLength(2);
		expect(promptTriggers(list)[1].closest("user-message")?.textContent).toContain("current-trusted");
		const popover = await openPromptMenu(promptTriggers(list)[1]);
		expect(actionRow(popover, "history-fork")).toBeTruthy();
	});
});

describe("history prompt trigger and canonical menu", () => {
	it.each([
		["direct", false],
		["deferred", true],
	] as const)("opens from a real trigger click in %s render mode", async (_mode, deferred) => {
		setDeferredRendering(deferred);
		const list = await renderList([durablePrompt(`entry-${_mode}`)]);
		expect(list.querySelectorAll("deferred-block")).toHaveLength(deferred ? 1 : 0);
		const trigger = promptTriggers(list)[0];
		const popover = await openPromptMenu(trigger);
		expect(popover.querySelector("[role='menu']")).toBeTruthy();
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
	});

	it("uses one always-visible trigger and identical desktop/mobile actions", async () => {
		const snapshots: Array<{ triggerClass: string; icon: string; labels: string[] }> = [];
		for (const width of [1280, 390]) {
			document.body.innerHTML = "";
			Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
			const list = await renderList([durablePrompt(`entry-${width}`)]);
			const [trigger] = promptTriggers(list);
			expect(trigger).toBeTruthy();
			expect(trigger.hidden).toBe(false);
			expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
			expect(trigger.getAttribute("aria-expanded")).toBe("false");
			const popover = await openPromptMenu(trigger);
			snapshots.push({
				triggerClass: trigger.className,
				icon: trigger.querySelector("svg")?.innerHTML ?? "",
				labels: menuLabels(popover),
			});
		}
		expect(snapshots[0]).toEqual(snapshots[1]);
		expect(snapshots[0].labels).toEqual(["Fork before this point", "Copy prompt"]);
	});

	it("places prompt actions and timestamps in a right-aligned footer beneath every bubble", async () => {
		const legacy = await renderList([durablePrompt("legacy")]);
		const legacyTrigger = promptTriggers(legacy)[0];
		const legacyFooter = legacyTrigger.closest(".prompt-metadata-row");
		expect(legacyTrigger.closest(".user-message-container")).toBeNull();
		expect(legacyFooter?.querySelector(".message-timestamp")).toBeTruthy();
		expect(legacyFooter?.previousElementSibling?.classList.contains("user-message-container")).toBe(true);
		expect(legacyFooter?.closest(".prompt-content-column")).toBeTruthy();
		expect(legacyFooter?.closest(".prompt-row")).toBeTruthy();

		document.body.innerHTML = "";
		const labelled = await renderList([
			durablePrompt("labelled"),
			durablePrompt("system", "system", { author: { kind: "system", id: "system:bobbit", label: "Bobbit" } }),
		]);
		const labelledTrigger = promptTriggers(labelled)[0];
		const labelledFooter = labelledTrigger.closest(".prompt-metadata-row");
		expect(labelledTrigger.closest(".user-message-container")).toBeNull();
		expect(labelledFooter?.querySelector(".message-timestamp")).toBeTruthy();
		expect(labelledFooter?.previousElementSibling?.classList.contains("prompt-bubble-shell")).toBe(true);
		expect(labelledFooter?.closest(".prompt-content-column")).toBeTruthy();
		expect(labelledFooter?.closest(".prompt-row--labelled")).toBeTruthy();
	});

	it("resets New worktree off on every open and never fires Fork while toggling", async () => {
		const list = await renderList([durablePrompt("toggle-entry")]);
		const trigger = promptTriggers(list)[0];
		const forks: any[] = [];
		list.addEventListener("prompt-history-fork", (event: Event) => forks.push((event as CustomEvent).detail));
		let popover = await openPromptMenu(trigger);
		let toggle = popover.querySelector<HTMLElement>("[role='menuitemcheckbox']")!;
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(toggle.getAttribute("aria-label")).toBe("New worktree (off) — reuse the source worktree");
		toggle.click();
		await settle();
		toggle = popover.querySelector<HTMLElement>("[role='menuitemcheckbox']")!;
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		expect(forks).toEqual([]);
		expect((popover as any).open).toBe(true);

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();
		popover = await openPromptMenu(trigger);
		toggle = popover.querySelector<HTMLElement>("[role='menuitemcheckbox']")!;
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		actionRow(popover, "history-fork").click();
		actionRow(popover, "history-fork").click();
		await settle();
		expect(forks).toEqual([{ entryId: "toggle-entry", newWorktree: false }]);
	});

	it("puts the fork explanation in the row tooltip without a separate help control", async () => {
		const list = await renderList([durablePrompt("help-entry")]);
		const popover = await openPromptMenu(promptTriggers(list)[0]);
		const fork = actionRow(popover, "history-fork");

		expect(fork.textContent?.trim()).toBe("Fork before this point");
		expect(fork.getAttribute("title")).toBe(HELP_TEXT);
		expect(popover.querySelector("[data-sidebar-actions-help]")).toBeNull();
		expect(popover.textContent).not.toContain("(?)");
	});

	it("restores trigger focus after Escape and suppresses duplicate select dispatch", async () => {
		const list = await renderList([durablePrompt("dedupe-entry")]);
		const trigger = promptTriggers(list)[0];
		await openPromptMenu(trigger);
		expect(document.body.querySelectorAll("sidebar-actions-popover [role='menu']")).toHaveLength(1);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await settle();
		expect(document.activeElement).toBe(trigger);

		const forks: any[] = [];
		list.addEventListener("prompt-history-fork", (event: Event) => forks.push((event as CustomEvent).detail));
		const reopened = await openPromptMenu(trigger);
		const row = actionRow(reopened, "history-fork");
		row.click();
		row.click();
		await settle();
		expect(forks).toHaveLength(1);
	});
});

describe("prompt text copy contract", () => {
	function attachmentPrompt(): any {
		return durablePrompt("copy-entry", "unused", {
			role: "user-with-attachments",
			content: [
				{ type: "text", text: "/qa-test first line\nReview @src/app.ts" },
				{ type: "image", data: "private-image-data", mimeType: "image/png" },
				{ type: "text", text: "\nLast line" },
			],
			attachments: [{
				id: "attachment-1",
				type: "image",
				fileName: "secret-screenshot.png",
				mimeType: "image/png",
				size: 18,
				content: "private-image-data",
				preview: "private-image-data",
			}],
			skillExpansions: [{ name: "qa-test", args: "first line", range: [0, 19], expanded: "PRIVATE EXPANDED SKILL" }],
			fileMentions: [{ path: "src/app.ts", range: [27, 38], kind: "text", content: "PRIVATE FILE CONTENT" }],
		});
	}

	it("extracts exact visible multiline slash/@path text and excludes attachment/model-only data", () => {
		const message = attachmentPrompt();
		const copied = userVisiblePromptText(message);
		expect(copied).toBe("/qa-test first line\nReview @src/app.ts\nLast line");
		expect(copied).not.toMatch(/secret-screenshot|private-image|PRIVATE EXPANDED|PRIVATE FILE/);
	});

	it("dispatches only the captured textual prompt from Copy prompt", async () => {
		const list = await renderList([attachmentPrompt()]);
		const copies: any[] = [];
		list.addEventListener("prompt-copy", (event: Event) => copies.push((event as CustomEvent).detail));
		const popover = await openPromptMenu(promptTriggers(list)[0]);
		actionRow(popover, "copy-prompt").click();
		await settle();
		expect(copies).toHaveLength(1);
		const detail = copies[0];
		const copied = typeof detail === "string" ? detail : detail?.promptText ?? detail?.text;
		expect(copied).toBe("/qa-test first line\nReview @src/app.ts\nLast line");
	});

	it("shows exact success and failure feedback from the AgentInterface clipboard flow", async () => {
		const message = attachmentPrompt();
		const sourceSession = {
			id: "source-session",
			title: "Source",
			cwd: "/tmp/source",
			status: "idle",
			createdAt: 1,
			updatedAt: 2,
			role: "assistant",
		} as any;
		appState.gatewaySessions = [sourceSession];
		const writes: string[] = [];
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: async (text: string) => { writes.push(text); } },
		});

		const element = document.createElement("agent-interface") as any;
		element.session = {
			sessionId: sourceSession.id,
			state: {
				messages: [message], tools: [], pendingToolCalls: new Set(),
				streamingMessage: null, isStreaming: false,
			},
		};
		const host = document.createElement("div");
		document.body.appendChild(host);
		render(element.renderMessages(), host);
		await settle();
		let popover = await openPromptMenu(promptTriggers(host)[0]);
		actionRow(popover, "copy-prompt").click();
		await settle();
		expect(writes).toEqual(["/qa-test first line\nReview @src/app.ts\nLast line"]);
		const toastHost = document.createElement("div");
		document.body.appendChild(toastHost);
		render(headerToast() as any, toastHost);
		expect(toastHost.querySelector("[data-testid='header-toast']")?.textContent).toBe("Prompt copied");

		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: async () => { throw new Error("denied"); } },
		});
		(document as any).execCommand = () => false;
		popover = await openPromptMenu(promptTriggers(host)[0]);
		actionRow(popover, "copy-prompt").click();
		await settle();
		render(headerToast() as any, toastHost);
		expect(toastHost.querySelector("[data-testid='header-toast']")?.textContent).toBe("Couldn't copy prompt");
	});

	it("applies settled cursor snapshots once and restores the pinned tail after child layout", async () => {
		const agent = new RemoteAgentCtor();
		agent.replaceMessages([
			{ id: "live-user", role: "user", content: [{ type: "text", text: "historic prompt" }], author: USER },
			{ id: "live-answer", role: "assistant", content: [{ type: "text", text: "answer" }] },
		]);
		const element = document.createElement("agent-interface") as any;
		const scroll = document.createElement("div");
		let scrollHeight = 1_000;
		Object.defineProperty(scroll, "scrollHeight", { configurable: true, get: () => scrollHeight });
		Object.defineProperty(scroll, "clientHeight", { configurable: true, get: () => 100 });
		scroll.scrollTop = 899;
		element.session = agent;
		element._scrollContainer = scroll;
		element._isAtBottom = true;
		element._escapedFromLock = false;
		element.requestUpdate = () => undefined;
		Object.defineProperty(element, "updateComplete", { configurable: true, get: () => Promise.resolve(true) });
		element.querySelector = (selector: string) => selector === "message-list"
			? { updateComplete: Promise.resolve(true) }
			: null;
		element.setupSessionSubscription();
		scrollHeight = 1_200;

		await agent.handleServerMessage({
			type: "messages",
			data: [
				{
					id: "live-user", role: "user", content: [{ type: "text", text: "historic prompt" }], author: USER,
					entryId: "cursor-historic", _entryIdSource: "pi-transcript",
				},
				{ id: "live-answer", role: "assistant", content: [{ type: "text", text: "answer" }] },
			],
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(agent.state.messages.map((message: any) => message.id)).toEqual(["live-user", "live-answer"]);
		expect(agent.state.messages.filter((message: any) => message.entryId === "cursor-historic")).toHaveLength(1);
		expect(scroll.scrollTop).toBe(1_099);
	});
});
