import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToSession, selectSession, uncacheSession } from "../../src/app/session-manager.js";
import { RemoteAgent } from "../../src/app/remote-agent.js";
import { setRenderApp, state } from "../../src/app/state.js";
import { AgentInterface } from "../../src/ui/components/AgentInterface.js";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";
import {
	ensureBgProcessPill,
	ensureContinueSessionChooser,
	ensureCostPopover,
	ensureGitStatusWidget,
	ensureGoalStatusWidget,
} from "../../src/app/lazy-widgets.js";
import "../../src/ui/lazy/safe-markdown-block.js";

setRenderApp(() => {});

const SESSION_ID = "retired-model-dom-session";
const RETIRED = { provider: "retired-provider", id: "retired-model", name: "Retired model", reasoning: true };
const CONDITION = {
	code: "MODEL_SELECTION_REQUIRED" as const,
	provider: RETIRED.provider,
	modelId: RETIRED.id,
};

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
	(HTMLCanvasElement.prototype as any).getContext = () => ({
		clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, arc() {},
		createLinearGradient: () => ({ addColorStop() {} }),
		getImageData: () => ({ data: new Uint8ClampedArray(4) }),
		putImageData() {}, drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
	});
	(HTMLElement.prototype as any).getAnimations ??= () => [];
	(HTMLCanvasElement.prototype as any).getAnimations = () => [];
});

beforeEach(() => {
	document.body.innerHTML = "";
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.chatPanel = null;
	state.remoteAgent = null;
	state.selectedSessionId = null;
	state.connectionStatus = "disconnected";
});

afterEach(() => {
	uncacheSession(SESSION_ID);
	document.body.innerHTML = "";
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.chatPanel = null;
	state.remoteAgent = null;
	state.selectedSessionId = null;
	state.connectionStatus = "disconnected";
	localStorage.clear();
	sessionStorage.clear();
	vi.restoreAllMocks();
});

async function settle(root: ParentNode = document.body): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
		const updatables = Array.from(root.querySelectorAll("*")) as Array<Element & { updateComplete?: Promise<unknown> }>;
		await Promise.all(updatables.map((el) => el.updateComplete?.catch?.(() => undefined) ?? undefined));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function sessionRecord(extra: Record<string, unknown> = {}) {
	return {
		id: SESSION_ID,
		title: "Historical conversation",
		cwd: "/project",
		status: "terminated",
		createdAt: 1,
		lastActivity: 2,
		clientCount: 0,
		dormant: true,
		condition: CONDITION,
		...extra,
	} as any;
}

async function interactionModeFor(
	record: Record<string, unknown>,
	options?: { readOnly?: boolean },
): Promise<{ readOnly: boolean; nonInteractive: boolean }> {
	uncacheSession(SESSION_ID);
	const agentInterface = {
		readOnly: false,
		nonInteractive: false,
		session: null as any,
	};
	const remote = {
		connected: true,
		gatewaySessionId: SESSION_ID,
		state: { isArchived: false },
		registerHostApiTransports: vi.fn(),
		disconnect: vi.fn(),
	};
	agentInterface.session = remote;
	const panel = {
		agent: remote,
		agentInterface,
		classList: { add: vi.fn(), remove: vi.fn() },
		addEventListener: vi.fn(),
	};

	state.gatewaySessions = [record as any];
	state.selectedSessionId = SESSION_ID;
	state.remoteAgent = remote as any;
	state.chatPanel = panel as any;

	// Exercise the real cache/reactivation path where list-backed restrictions are
	// applied synchronously before the first hydration await.
	selectSession("parking-session");
	const pending = connectToSession(SESSION_ID, true, options);
	const result = {
		readOnly: agentInterface.readOnly,
		nonInteractive: agentInterface.nonInteractive,
	};
	state.switchGeneration++;
	await pending;
	state.remoteAgent = null;
	state.chatPanel = null;
	state.selectedSessionId = null;
	return result;
}

describe("retired-model session interaction mode", () => {
	it("keeps a conditioned terminated dormant session interactive while preserving explicit restrictions", async () => {
		expect(await interactionModeFor(sessionRecord())).toEqual({
			readOnly: false,
			nonInteractive: false,
		});
		expect(await interactionModeFor(sessionRecord({ readOnly: true }))).toEqual({
			readOnly: true,
			nonInteractive: false,
		});
		expect(await interactionModeFor(sessionRecord({ nonInteractive: true }))).toEqual({
			readOnly: true,
			nonInteractive: true,
		});
		expect(await interactionModeFor(sessionRecord(), { readOnly: true })).toEqual({
			readOnly: true,
			nonInteractive: false,
		});
	});

	it("leaves ordinary terminated sessions read-only", async () => {
		expect(await interactionModeFor(sessionRecord({ condition: undefined }))).toEqual({
			readOnly: true,
			nonInteractive: false,
		});
	});
});

describe("retired-model recovery surface", () => {
	it("shows the exact tuple and keeps the warning until an explicit verified state clears it", async () => {
		const agent = new RemoteAgent() as any;
		const sent: Array<Record<string, unknown>> = [];
		agent._sessionId = SESSION_ID;
		agent.ws = {
			readyState: WebSocket.OPEN,
			send: (frame: string) => sent.push(JSON.parse(frame)),
		};
		await agent.handleServerMessage({
			type: "state",
			data: {
				status: "terminated",
				model: RETIRED,
				thinkingLevel: "high",
				condition: CONDITION,
			},
		});

		const ui = document.createElement("agent-interface") as AgentInterface;
		ui.session = agent;
		ui.gitRepoKnown = "no";
		document.body.appendChild(ui);
		await ui.updateComplete;
		await settle(ui);

		const banner = ui.querySelector('[data-testid="model-selection-required-banner"]') as HTMLElement;
		expect(banner).toBeTruthy();
		expect(banner.dataset.provider).toBe(RETIRED.provider);
		expect(banner.dataset.modelId).toBe(RETIRED.id);
		expect(banner.textContent).toContain(`${RETIRED.provider}/${RETIRED.id}`);
		const choose = banner.querySelector('button[aria-label="Choose replacement model"]') as HTMLButtonElement;
		expect(choose).toBeTruthy();
		expect(choose.disabled).toBe(false);
		expect(ui.querySelector("message-editor")).toBeTruthy();
		expect(ui.querySelector(".thinking-select-compact")).toBeNull();

		await agent.handleServerMessage({ type: "state", data: { status: "terminated", serverCost: null } });
		await settle(ui);
		expect(ui.querySelector('[data-testid="model-selection-required-banner"]')).toBeTruthy();

		const replacement = { provider: "available-provider", id: "available-model", name: "Available model" };
		agent.setModel(replacement, "medium");
		expect(agent.state.model).toEqual(RETIRED);
		expect(agent.state.condition).toEqual(CONDITION);
		expect(agent.state.modelSelectionPending).toEqual({
			provider: replacement.provider,
			modelId: replacement.id,
		});
		expect(sent.at(-1)).toEqual({
			type: "set_model",
			provider: replacement.provider,
			modelId: replacement.id,
			thinkingLevel: "medium",
		});
		await settle(ui);
		expect((ui.querySelector('[data-testid="choose-replacement-model"]') as HTMLButtonElement).disabled).toBe(true);
		const footerModelButton = ui.querySelector('[data-testid="footer-model-id"]')?.closest("button") as HTMLButtonElement;
		expect(footerModelButton.disabled).toBe(true);
		agent.setModel({ provider: "second-provider", id: "second-model" }, "low");
		expect(sent.filter((frame) => frame.type === "set_model")).toHaveLength(1);

		await agent.handleServerMessage({
			type: "state",
			data: { status: "idle", model: replacement, thinkingLevel: "medium", condition: null },
		});
		await settle(ui);
		expect(agent.state.condition).toBeNull();
		expect(agent.state.modelSelectionPending).toBeNull();
		expect(ui.querySelector('[data-testid="model-selection-required-banner"]')).toBeNull();
		expect((ui.querySelector("message-editor") as any).blockedSendReason).toBeUndefined();
	});
});

describe("MessageEditor retired-model send fence", () => {
	it("rejects before send, history, slash, or clear and retains text plus attachment draft", async () => {
		const editor = document.createElement("message-editor") as MessageEditor & any;
		editor.showModelSelector = false;
		editor.showThinkingSelector = false;
		editor.showAttachmentButton = false;
		editor.blockedSendReason = "Choose a replacement model before sending.";
		const onSend = vi.fn();
		const onInput = vi.fn();
		const onFilesChange = vi.fn();
		editor.onSend = onSend;
		editor.onInput = onInput;
		editor.onFilesChange = onFilesChange;
		const attachment = {
			id: "draft-attachment",
			type: "document",
			fileName: "notes.txt",
			mimeType: "text/plain",
			size: 12,
			content: "ZHJhZnQgYnl0ZXM=",
		};
		editor.attachments = [attachment];
		document.body.appendChild(editor);
		await editor.updateComplete;

		const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
		textarea.value = "/prw-preview keep this draft";
		textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		await editor.updateComplete;
		onInput.mockClear();
		const history = vi.spyOn(editor as any, "addToHistory");
		const messageSend = vi.fn();
		editor.addEventListener("message-send", messageSend);

		textarea.dispatchEvent(new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		}));
		await editor.updateComplete;

		expect(messageSend).not.toHaveBeenCalled();
		expect(onSend).not.toHaveBeenCalled();
		expect(onInput).not.toHaveBeenCalled();
		expect(onFilesChange).not.toHaveBeenCalled();
		expect(history).not.toHaveBeenCalled();
		expect(editor.value).toBe("/prw-preview keep this draft");
		expect(editor.attachments).toEqual([attachment]);
		expect(textarea.value).toBe("/prw-preview keep this draft");
		const alert = editor.querySelector('[data-testid="composer-model-selection-error"][role="alert"]');
		expect(alert?.textContent).toBe("Choose a replacement model before sending.");
	});

	it("blocks Ctrl/Cmd+Enter steer before send, history, or draft cleanup", async () => {
		const editor = document.createElement("message-editor") as MessageEditor & any;
		editor.showModelSelector = false;
		editor.showThinkingSelector = false;
		editor.showAttachmentButton = false;
		editor.blockedSendReason = "Choose a replacement model before sending.";
		const onSteerSend = vi.fn(async () => true);
		const onInput = vi.fn();
		editor.onSteerSend = onSteerSend;
		editor.onInput = onInput;
		document.body.appendChild(editor);
		await editor.updateComplete;
		const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
		textarea.value = "keep conditioned steer draft";
		textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		await editor.updateComplete;
		onInput.mockClear();
		const history = vi.spyOn(editor as any, "addToHistory");
		const messageSend = vi.fn();
		editor.addEventListener("message-send", messageSend);

		textarea.dispatchEvent(new KeyboardEvent("keydown", {
			key: "Enter",
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		}));
		await editor.updateComplete;

		expect(onSteerSend).not.toHaveBeenCalled();
		expect(messageSend).not.toHaveBeenCalled();
		expect(history).not.toHaveBeenCalled();
		expect(onInput).not.toHaveBeenCalled();
		expect(editor.value).toBe("keep conditioned steer draft");
		expect(textarea.value).toBe("keep conditioned steer draft");
		expect(editor.querySelector('[data-testid="composer-model-selection-error"]')?.textContent)
			.toBe("Choose a replacement model before sending.");
	});

	it("keeps the ordinary send path unchanged when no fence is present", async () => {
		const editor = document.createElement("message-editor") as MessageEditor & any;
		editor.showModelSelector = false;
		editor.showThinkingSelector = false;
		editor.showAttachmentButton = false;
		const onSend = vi.fn();
		editor.onSend = onSend;
		document.body.appendChild(editor);
		await editor.updateComplete;
		const messageSend = vi.fn();
		editor.addEventListener("message-send", messageSend);
		const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
		textarea.value = "ordinary prompt";
		textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		await editor.updateComplete;

		textarea.dispatchEvent(new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		}));
		for (let i = 0; i < 3; i++) await Promise.resolve();

		expect(messageSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledWith("ordinary prompt", []);
	});
});
