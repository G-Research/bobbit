import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	NO_PROMPT_AUTHOR_LABELS,
	presentPromptAuthor,
	selectPromptAuthorDisplayMode,
} from "../../src/ui/message-author-presentation.js";

const USER = { kind: "user", id: "user:local", label: "User" } as const;
const OTHER_USER = { kind: "user", id: "user:other", label: "Other" } as const;
const AGENT = {
	kind: "agent",
	id: "session:1ae73f53-dc48-4ca4",
	label: "  Test\n Coordinator  ",
} as const;
const SYSTEM = { kind: "system", id: "system:bobbit", label: "Bobbit" } as const;

const prompt = (id: string, author: unknown, role = "user") => ({
	id,
	role,
	content: [{ type: "text", text: id }],
	timestamp: 100,
	author,
});

beforeAll(async () => {
	await import("../../src/app/session-manager.js");
	await import("../../src/ui/components/Messages.js");
	await import("../../src/ui/components/MessageList.js");
	await import("../../src/ui/components/PreCompactionHistory.js");
	await import("../../src/ui/components/AgentInterface.js");
	await import("../../src/ui/lazy/safe-markdown-block.js");
	__syncCE();

	(HTMLCanvasElement.prototype as any).getContext = () => ({
		imageSmoothingEnabled: false,
		fillStyle: "",
		clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
		createLinearGradient: () => ({ addColorStop() {} }),
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		putImageData() {}, drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
	});
	(HTMLCanvasElement.prototype as any).toDataURL = () => "data:image/png;base64,static-bobbit";
});

afterEach(() => {
	document.body.innerHTML = "";
});

async function settle(root: ParentNode = document.body): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await Promise.resolve();
		const elements = Array.from(root.querySelectorAll("*")) as Array<Element & { updateComplete?: Promise<unknown> }>;
		await Promise.all(elements.map((el) => el.updateComplete?.catch?.(() => undefined) ?? undefined));
	}
}

async function renderMessageList(messages: any[], mode = selectPromptAuthorDisplayMode(messages)): Promise<HTMLElement> {
	const list = document.createElement("message-list") as any;
	list.messages = messages;
	list.tools = [];
	list.promptAuthorDisplayMode = mode;
	list.resolvePromptAuthorAppearance = () => ({
		sessionId: "1ae73f53-dc48-4ca4",
		hueRotate: 40,
		accessoryId: "bandana",
	});
	document.body.appendChild(list);
	await list.updateComplete;
	await settle(list);
	return list;
}

function badgeText(badge: Element): string {
	return (badge.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("prompt author presentation selector", () => {
	it("keeps one or many all-human prompts label-free while retaining ordered ids", () => {
		const one = selectPromptAuthorDisplayMode([prompt("one", USER)]);
		expect(one.showLabels).toBe(false);
		expect(one.distinctHumanIds).toEqual(["user:local"]);

		const many = selectPromptAuthorDisplayMode([
			prompt("one", USER),
			prompt("two", OTHER_USER),
			prompt("repeat", USER),
		]);
		expect(many.showLabels).toBe(false);
		expect(many.distinctHumanIds).toEqual(["user:local", "user:other"]);
	});

	it("triggers only for validated accountable agent/system prompts", () => {
		expect(selectPromptAuthorDisplayMode([prompt("agent", AGENT)]).showLabels).toBe(true);
		expect(selectPromptAuthorDisplayMode([prompt("system", SYSTEM)]).showLabels).toBe(true);
		expect(selectPromptAuthorDisplayMode([prompt("assistant", AGENT, "assistant")])).toBe(NO_PROMPT_AUTHOR_LABELS);
		expect(selectPromptAuthorDisplayMode([prompt("invalid", { ...AGENT, kind: "robot" })])).toBe(NO_PROMPT_AUTHOR_LABELS);
		expect(selectPromptAuthorDisplayMode([{
			role: "user",
			content: [{ type: "toolResult", toolCallId: "call-1", text: "done" }],
			author: AGENT,
		}])).toBe(NO_PROMPT_AUTHOR_LABELS);
	});

	it("uses exact human, system, and normalized agent copy without fabrication", () => {
		expect(presentPromptAuthor(USER)).toEqual({
			kind: "user",
			visibleName: "User",
			accessibleName: "Prompt author: User",
		});
		expect(presentPromptAuthor(SYSTEM)).toEqual({
			kind: "system",
			visibleName: "System",
			accessibleName: "Prompt author: System",
		});
		expect(presentPromptAuthor(AGENT)).toEqual({
			kind: "agent",
			visibleName: "Test Coordinator | Agent",
			accessibleName: "Prompt author: Test Coordinator | Agent",
			normalizedAgentLabel: "Test Coordinator",
		});
		expect(presentPromptAuthor({ ...AGENT, label: "\u0000\n\t" })).toBeUndefined();
		expect(presentPromptAuthor(undefined)).toBeUndefined();
	});
});

describe("prompt author badge DOM", () => {
	it("leaves all-human markup unlabelled", async () => {
		const list = await renderMessageList([prompt("human", USER)]);
		expect(list.querySelector(".prompt-author-badge")).toBeNull();
		expect(list.querySelector(".prompt-bubble-shell")).toBeNull();
		expect(list.querySelector("user-message > div")?.className).toBe("flex justify-start mx-2 sm:mx-4 my-1");
	});

	it("renders exact contextual User, exact System, and agent label/kind strings", async () => {
		const messages = [
			prompt("human", USER),
			prompt("system", SYSTEM),
			prompt("agent", AGENT),
		];
		const list = await renderMessageList(messages);
		const badges = Array.from(list.querySelectorAll(".prompt-author-badge"));
		expect(badges.map(badgeText)).toEqual(["User", "System", "Test Coordinator | Agent"]);
		expect(badges.map((badge) => badge.getAttribute("aria-label"))).toEqual([
			"Prompt author: User",
			"Prompt author: System",
			"Prompt author: Test Coordinator | Agent",
		]);
		expect(list.textContent).not.toContain("Human");
		expect(badges[1].textContent).not.toContain("Bobbit");
		expect(badges[2].getAttribute("title")).toBe("Test Coordinator | Agent");
	});

	it("renders only the agent avatar through the static canonical sprite path", async () => {
		const list = await renderMessageList([prompt("system", SYSTEM), prompt("agent", AGENT)]);
		expect(list.querySelectorAll(".prompt-author-avatar")).toHaveLength(1);
		const avatar = list.querySelector(".prompt-author-avatar")!;
		expect(avatar.getAttribute("aria-hidden")).toBe("true");
		expect(avatar.querySelectorAll("img").length).toBeGreaterThan(1);
		expect(avatar.innerHTML).toContain("hue-rotate(40deg)");
		expect(avatar.innerHTML).not.toMatch(/animation\s*:|animate-|breathe|bobbit-bob|unread-blink/i);
	});

	it("does not fabricate a badge for missing/invalid legacy metadata in labelled mode", async () => {
		const messages = [
			prompt("trigger", SYSTEM),
			prompt("missing", undefined),
			prompt("invalid", { kind: "agent", id: "session:x", label: "" }),
		];
		const list = await renderMessageList(messages);
		expect(list.querySelectorAll(".prompt-author-badge")).toHaveLength(1);
		expect(badgeText(list.querySelector(".prompt-author-badge")!)).toBe("System");
	});
});

describe("AgentInterface transcript-owner mode", () => {
	function compactionMessage(): any {
		return {
			id: "compact",
			role: "assistant",
			content: [{
				type: "toolCall",
				id: "compact-call",
				name: "__compaction_summary",
				arguments: { compactionId: "slice-1" },
			}],
			timestamp: 101,
		};
	}

	function owner(messages: any[]): any {
		const element = document.createElement("agent-interface") as any;
		element.session = {
			sessionId: "owner-session",
			state: {
				messages,
				tools: [],
				pendingToolCalls: new Set(),
				streamingMessage: null,
				isStreaming: false,
			},
		};
		return element;
	}

	async function renderOwner(element: any): Promise<HTMLElement> {
		const host = document.createElement("div");
		document.body.appendChild(host);
		render(element.renderMessages(), host);
		await settle(host);
		return host;
	}

	it("lets an asynchronously loaded nested trigger label a main human row", async () => {
		const element = owner([prompt("main-human", USER), compactionMessage()]);
		element._reportPromptAuthorSlice("owner-session", "slice-1", [prompt("nested-agent", AGENT)]);
		const host = await renderOwner(element);
		const mainList = host.querySelector("message-list") as any;
		const nestedOwner = host.querySelector("bobbit-pre-compaction-history") as any;
		expect(mainList.promptAuthorDisplayMode.showLabels).toBe(true);
		expect(nestedOwner.promptAuthorDisplayMode).toBe(mainList.promptAuthorDisplayMode);
		expect(badgeText(host.querySelector(".prompt-author-badge")!)).toBe("User");
	});

	it("passes a main trigger's same mode object into hydrated nested human rows", async () => {
		const element = owner([prompt("main-agent", AGENT), compactionMessage()]);
		const host = await renderOwner(element);
		const mainList = host.querySelector("message-list") as any;
		const nestedOwner = host.querySelector("bobbit-pre-compaction-history") as any;
		expect(nestedOwner.promptAuthorDisplayMode).toBe(mainList.promptAuthorDisplayMode);

		nestedOwner._total = 1;
		nestedOwner._expanded = true;
		nestedOwner._rows = [{
			index: 0,
			role: "user",
			ts: null,
			content: "nested-human",
			message: prompt("nested-human", USER),
		}];
		nestedOwner.requestUpdate();
		await nestedOwner.updateComplete;
		await settle(nestedOwner);
		const nestedList = nestedOwner.querySelector("message-list") as any;
		expect(nestedList.promptAuthorDisplayMode).toBe(mainList.promptAuthorDisplayMode);
		expect(badgeText(nestedOwner.querySelector(".prompt-author-badge")!)).toBe("User");
	});

	it("rejects stale slice reports from the previous session", async () => {
		const element = owner([prompt("main-human", USER)]);
		element._reportPromptAuthorSlice("previous-session", "slice-1", [prompt("stale-agent", AGENT)]);
		const host = await renderOwner(element);
		expect((host.querySelector("message-list") as any).promptAuthorDisplayMode.showLabels).toBe(false);
		expect(host.querySelector(".prompt-author-badge")).toBeNull();
	});
});
