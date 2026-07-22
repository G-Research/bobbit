import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import "../../src/app/session-manager.js";
import { setRenderApp } from "../../src/app/state.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import { ensureBgProcessPill, ensureContinueSessionChooser, ensureCostPopover, ensureGitStatusWidget, ensureGoalStatusWidget } from "../../src/app/lazy-widgets.js";
import "../../src/ui/components/AgentInterface.js";
import "../../src/ui/components/MessageList.js";
import "../../src/ui/components/Messages.js";
import "../../src/ui/components/ToolPermissionCard.js";

setRenderApp(() => {});

beforeAll(async () => {
	await Promise.all([
		ensureGitStatusWidget(),
		ensureGoalStatusWidget(),
		ensureBgProcessPill(),
		ensureCostPopover(),
		ensureContinueSessionChooser(),
	]);
	if (!(globalThis as any).ResizeObserver) {
		(globalThis as any).ResizeObserver = class ResizeObserver {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	// AgentInterface mounts the Bobbit canvas sprite; happy-dom has no 2D canvas.
	// Stub enough of the canvas API to keep this permission-card fixture focused.
	(HTMLCanvasElement.prototype as any).getContext = () => ({
		clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
		createLinearGradient: () => ({ addColorStop() {} }),
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		putImageData() {}, drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
	});
	(HTMLElement.prototype as any).getAnimations ??= () => [];
	(HTMLCanvasElement.prototype as any).getAnimations = () => [];
});

afterEach(() => {
	document.body.innerHTML = "";
});

function assistantToolMessage(id = "assistant-tool", toolCallId = "call-perm", toolName = "diagnostic_tool") {
	return {
		id,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: toolName,
				arguments: { command: "echo permission-blocked" },
			},
		],
		timestamp: 100,
	};
}

function permissionRow(id = "perm-1", toolName = "diagnostic_tool", extra: Record<string, unknown> = {}) {
	return {
		id,
		role: "tool_permission_needed",
		toolName,
		group: "Shell",
		roleName: "coder",
		roleLabel: "Coder",
		lastPromptText: "run the diagnostic",
		timestamp: 101,
		status: "active",
		...extra,
	};
}

async function settle(root: ParentNode = document.body) {
	await Promise.resolve();
	for (let i = 0; i < 4; i++) {
		const updatables = Array.from(root.querySelectorAll("*")) as Array<Element & { updateComplete?: Promise<unknown> }>;
		await Promise.all(updatables.map((el) => el.updateComplete?.catch?.(() => undefined) ?? undefined));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function renderMessageList(messages: any[], pendingToolCalls = new Set<string>()) {
	const list = document.createElement("message-list") as any;
	list.messages = messages;
	list.tools = [];
	list.pendingToolCalls = pendingToolCalls;
	list.isStreaming = false;
	document.body.appendChild(list);
	await list.updateComplete;
	await settle(list);
	return list as HTMLElement;
}

class FixtureSession {
	sessionId = "permission-card-dom-fixture";
	grantCalls: any[] = [];
	denyCalls: any[] = [];
	private listeners = new Set<(event: any) => void>();
	state: any = {
		messages: [],
		tools: [],
		pendingToolCalls: new Set<string>(),
		streamingMessage: null,
		isStreaming: false,
		status: "idle",
		model: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
		thinkingLevel: "off",
		usage: null,
		cost: 0,
	};

	constructor(messages: any[]) {
		this.state.messages = messages;
	}

	subscribe(listener: (event: any) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: any) {
		for (const listener of this.listeners) listener(event);
	}

	grantToolPermission(toolName: string, scope: "tool" | "group", group?: string, lastPromptText?: string, mode?: string) {
		this.grantCalls.push({ toolName, scope, group, lastPromptText, mode });
	}

	denyToolPermission(id: string, toolName?: string) {
		this.denyCalls.push({ id, toolName });
		this.state.messages = this.state.messages.map((m: any) => m.id === id ? { ...m, status: "denied", actionable: false } : m);
		this.emit({ type: "state_update" });
	}

	getQueue() { return []; }
	abort() {}
	async prompt() {}
}

async function mountSession<T>(session: T) {
	const el = document.createElement("agent-interface") as any;
	el.session = session;
	el.gitRepoKnown = "no";
	document.body.appendChild(el);
	await el.updateComplete;
	await settle(el);
	return { el: el as HTMLElement & { requestUpdate: () => void; updateComplete: Promise<unknown> }, session };
}

async function mountAgentInterface(messages: any[]) {
	return mountSession(new FixtureSession(messages));
}

function pinnedCards(root: ParentNode): HTMLElement[] {
	return Array.from(root.querySelectorAll("[data-permission-pinned] tool-permission-card, [data-pinned-permission-controls] tool-permission-card, .pinned-permission-controls tool-permission-card")) as HTMLElement[];
}

function inlineCards(root: ParentNode): HTMLElement[] {
	const pinned = new Set(pinnedCards(root));
	return Array.from(root.querySelectorAll("tool-permission-card")).filter((el) => !pinned.has(el as HTMLElement)) as HTMLElement[];
}

function clickButton(card: HTMLElement, label: RegExp) {
	const button = Array.from(card.querySelectorAll("button")).find((b) => label.test(b.textContent || "")) as HTMLButtonElement | undefined;
	assert.ok(button, `button ${label} not found`);
	button.click();
}

describe("AgentInterface stream bridge", () => {
	it("installs the proxy wrapper on RemoteAgent.streamFn without repeated wrapping", async () => {
		const session = new RemoteAgent() as RemoteAgent & { streamFn?: { __isDefault?: boolean } };
		const { el } = await mountSession(session);

		const wrapped = session.streamFn;
		assert.equal(typeof wrapped, "function");
		assert.equal(wrapped.__isDefault, true);
		assert.equal("streamFunction" in session, false, "RemoteAgent should keep using its streamFn bridge");

		(el as any).setupSessionSubscription();
		assert.equal(session.streamFn, wrapped, "re-subscribing must preserve the existing default wrapper");
	});

	it("installs the proxy wrapper on Pi Agent.streamFunction without repeated wrapping", async () => {
		const session = new Agent({ streamFn: (() => undefined) as never });
		const { el } = await mountSession(session);

		const wrapped = session.streamFunction as typeof session.streamFunction & { __isDefault?: boolean };
		assert.equal(wrapped.__isDefault, true);
		assert.equal("streamFn" in session, false, "Pi Agent should keep using its streamFunction property");

		(el as any).setupSessionSubscription();
		assert.equal(session.streamFunction, wrapped, "re-subscribing must preserve the existing default wrapper");
	});
});

describe("Permission Card UX reproductions", () => {
	it("renders a committed permission-blocked tool call as pending/blocked, not complete/success", async () => {
		const list = await renderMessageList([
			assistantToolMessage(),
			permissionRow("perm-diagnostic"),
		], new Set());

		const toolCard = list.querySelector('[data-tool-name="diagnostic_tool"]') as HTMLElement | null;
		assert.ok(toolCard, "permission-blocked tool card should remain visible");
		if (toolCard.querySelector('span[class*="text-green"]')) {
			assert.fail("permission-blocked tool rendered as complete");
		}
		expect(toolCard.textContent || "", "permission-blocked tool should communicate pending/blocked state").toMatch(/permission|blocked|pending|waiting/i);
	});

	it("clears the stale streaming preview when the blocked tool placeholder is committed", async () => {
		const streaming = assistantToolMessage("streaming-assistant", "stream-call", "diagnostic_tool");
		const { el, session } = await mountAgentInterface([permissionRow("perm-stream", "diagnostic_tool")]);
		session.state.streamingMessage = streaming;
		(session as any).streamingMessageId = streaming.id;

		(el as any)._clearStreamingIfPermissionBlocked();
		await settle(el);

		assert.equal(session.state.streamingMessage, null, "permission-blocked streaming preview should be cleared so tool cards do not duplicate");
		assert.equal((session as any).streamingMessageId, undefined);
	});

	it("preserves the streaming tool-call context when tool_permission_needed arrives", async () => {
		const agent: any = new RemoteAgent();
		agent.send = () => {};
		agent.emit = () => {};
		const streaming = assistantToolMessage("streaming-assistant", "stream-call", "diagnostic_tool");
		agent.state.streamingMessage = streaming;
		agent.streamingMessageId = streaming.id;
		agent.state.pendingToolCalls = new Set(["stream-call"]);
		agent.state.status = "streaming";

		await agent.handleServerMessage({
			type: "tool_permission_needed",
			seq: 1,
			ts: 10,
			toolName: "diagnostic_tool",
			group: "Shell",
			roleName: "coder",
			roleLabel: "Coder",
		});

		const stillStreaming = agent.state.streamingMessage?.content?.some((c: any) => c.type === "toolCall" && c.id === "stream-call");
		const frozenInTranscript = agent.state.messages?.some((m: any) => m.role === "assistant" && m.content?.some?.((c: any) => c.type === "toolCall" && c.id === "stream-call"));
		if (!stillStreaming && !frozenInTranscript) assert.fail("blocked streaming tool call disappeared");
	});

	it("clears grant spinner and marks the row stale/error after a grant failure", async () => {
		const { el, session } = await mountAgentInterface([permissionRow("perm-error")]);
		const card = pinnedCards(el)[0];
		assert.ok(card, "pinned permission card should render");
		assert.equal(inlineCards(el).length, 0, "active permission card should not duplicate inline while pinned");
		clickButton(card, /Allow just/i);
		await settle(el);
		expect(el.textContent || "").toContain("Granting permission");

		session.state.messages = session.state.messages.map((m: any) => m.id === "perm-error" ? { ...m, status: "error", actionable: false, error: "stale grant request" } : m);
		session.emit({ type: "state_update" });
		el.requestUpdate();
		await el.updateComplete;
		await settle(el);

		if ((el.textContent || "").includes("Granting permission")) assert.fail("Granting spinner did not clear");
		expect(el.textContent || "", "stale grant error should be visible").toMatch(/stale|error|failed/i);
	});

	it("uses pinned controls only for active permission requests", async () => {
		const { el, session } = await mountAgentInterface([permissionRow("perm-shared")]);
		const pinned = pinnedCards(el)[0];
		if (!pinned) assert.fail("pinned permission controls not visible");
		assert.equal(inlineCards(el).length, 0, "active permission history card should be hidden while pinned");

		const pinnedSelect = pinned.querySelector("select") as HTMLSelectElement | null;
		assert.ok(pinnedSelect, "pinned duration select should be visible");
		pinnedSelect.value = "persistent";
		pinnedSelect.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
		await settle(el);

		clickButton(pinned, /Allow just/i);
		await settle(el);

		assert.equal(session.grantCalls.length, 1, "duplicate grant clicks should be suppressed");
		assert.equal(session.grantCalls[0].mode, "persistent", "pinned grant should use selected duration");
		expect(pinned.textContent || "").toMatch(/Granting|Permission granted/i);
		assert.equal(inlineCards(el).length, 0, "granting permission card should not duplicate inline while pinned");
	});

	it("groups parallel same-tool permission requests into one pinned batch", async () => {
		const { el, session } = await mountAgentInterface([
			permissionRow("perm-a", "diagnostic_tool", { requestCount: 2 }),
			permissionRow("perm-b", "diagnostic_tool", { requestCount: 2 }),
		]);
		const pinned = pinnedCards(el);
		assert.equal(pinned.length, 1, "same-tool requests should render as one pinned permission card");
		expect(pinned[0].textContent || "").toMatch(/2 calls|Just for now/i);

		const select = pinned[0].querySelector("select") as HTMLSelectElement | null;
		assert.ok(select, "duration selector should render");
		select.value = "one-time";
		select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
		await settle(el);
		clickButton(pinned[0], /Allow just/i);
		await settle(el);

		assert.equal(session.grantCalls.length, 1);
		assert.equal(session.grantCalls[0].mode, "one-time");
		assert.equal(inlineCards(el).length, 0, "batched active rows should not duplicate inline while granting");
	});

	it("grant and deny from pinned controls use the same session payloads, settle pinned rows, and keep inline history", async () => {
		const { el, session } = await mountAgentInterface([
			permissionRow("perm-grant", "diagnostic_tool"),
			permissionRow("perm-deny", "danger_tool"),
		]);
		let pinned = pinnedCards(el);
		if (pinned.length === 0) assert.fail("pinned permission controls not visible");

		clickButton(pinned[0], /Allow just/i);
		clickButton(pinned[0], /Allow just/i);
		await settle(el);
		assert.equal(session.grantCalls.length, 1, "duplicate pinned grant clicks should be suppressed");
		assert.deepEqual(session.grantCalls[0], {
			toolName: "diagnostic_tool",
			scope: "tool",
			group: "Shell",
			lastPromptText: "run the diagnostic",
			mode: "session-only",
		});

		clickButton(pinned[pinned.length - 1], /Deny/i);
		await settle(el);
		assert.deepEqual(session.denyCalls.at(-1), { id: "perm-deny", toolName: "danger_tool" });
		pinned = pinnedCards(el);
		assert.equal(pinned.some((card) => (card.textContent || "").includes("danger_tool")), false, "denied permission should be removed from pinned stack");
		assert.ok(inlineCards(el).some((card) => /denied|danger_tool/i.test(card.textContent || "")), "inline denied permission history should remain visible");
	});

	it("derives pinned controls from current rows for reconnect and alive-socket navigate-back", async () => {
		const replayed = permissionRow("perm-reconnect", "diagnostic_tool");
		const first = await mountAgentInterface([replayed]);
		if (pinnedCards(first.el).length === 0) assert.fail("pinned permission controls not visible");

		first.el.remove();
		const second = await mountAgentInterface([replayed]);
		if (pinnedCards(second.el).length === 0) assert.fail("pinned permission controls not visible after alive-socket navigate-back");
	});
});
