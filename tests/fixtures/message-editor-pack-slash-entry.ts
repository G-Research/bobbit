// Test entry — bundles the REAL <message-editor> with the client pack launcher
// registry to pin typed pack composer-slash dispatch behavior.
import "../../src/ui/components/MessageEditor.js";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";
import { registerPackEntrypoints, launcherKey } from "../../src/app/pack-entrypoints.js";
import { setLauncherHostFactory } from "../../src/app/pack-panels.js";

(window as any).MessageEditorClass = MessageEditor;

type CallRouteCall = {
	route: string;
	sessionId: string | undefined;
	packId: string;
	contributionId: string;
	body?: unknown;
};

const sendCalls: Array<{ text: string; attachmentCount: number }> = [];
const inputCalls: string[] = [];
const callRouteCalls: CallRouteCall[] = [];
const messageSendEvents: string[] = [];

function installPrWalkthroughLauncher(): void {
	callRouteCalls.length = 0;
	registerPackEntrypoints([
		{
			id: "pr-walkthrough",
			packId: "pr-walkthrough",
			kind: "composer-slash",
			label: "PR Walkthrough",
			target: { action: "spawn", route: "run", panelId: "pr-walkthrough.panel" },
		},
	] as any, "project-a");
	setLauncherHostFactory((sessionId, packId, contributionId) => ({
		capabilities: { callRoute: true } as any,
		callRoute: async (route: string, init?: { body?: unknown }) => {
			callRouteCalls.push({ route, sessionId, packId, contributionId, body: init?.body });
			return { ok: true, childSessionId: "child-pr", jobId: "job-pr" };
		},
		ui: { openPanel: () => { /* not needed for these assertions */ } },
	}) as any);
}

function textarea(el: HTMLElement): HTMLTextAreaElement {
	const ta = el.querySelector("textarea") as HTMLTextAreaElement | null;
	if (!ta) throw new Error("textarea not found in message-editor");
	return ta;
}

function mount(container: HTMLElement): any {
	container.innerHTML = "";
	sendCalls.length = 0;
	inputCalls.length = 0;
	messageSendEvents.length = 0;
	installPrWalkthroughLauncher();
	const el = document.createElement("message-editor") as any;
	el.sessionId = "pack-slash-session";
	el.showAttachmentButton = false;
	el.showModelSelector = false;
	el.showThinkingSelector = false;
	el.onInput = (value: string) => inputCalls.push(value);
	el.onSend = (text: string, attachments: unknown[]) => sendCalls.push({ text, attachmentCount: attachments.length });
	el.addEventListener("message-send", () => { messageSendEvents.push(el.value); });
	container.appendChild(el);
	return el;
}

(window as any).__mountEditor = mount;
(window as any).__setValue = async (el: any, value: string): Promise<void> => {
	await el.updateComplete;
	const ta = textarea(el);
	ta.value = value;
	ta.setSelectionRange(value.length, value.length);
	ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	await el.updateComplete;
};
(window as any).__pressEnter = async (el: any): Promise<void> => {
	await el.updateComplete;
	const ta = textarea(el);
	ta.focus();
	ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	await new Promise((r) => setTimeout(r, 30));
	await el.updateComplete;
};
(window as any).__typeText = async (el: any, text: string): Promise<void> => {
	await el.updateComplete;
	const ta = textarea(el);
	ta.focus();
	for (const ch of text) {
		ta.value += ch;
		ta.setSelectionRange(ta.value.length, ta.value.length);
		ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		await el.updateComplete;
	}
};
(window as any).__isSlashMenuOpen = (el: any): boolean => !!el.querySelector(".slash-menu");
(window as any).__slashEntryKey = (): string => launcherKey("pr-walkthrough", "pr-walkthrough");
(window as any).__getSendCalls = () => sendCalls.slice();
(window as any).__getInputCalls = () => inputCalls.slice();
(window as any).__getCallRouteCalls = () => callRouteCalls.slice();
(window as any).__getMessageSendEvents = () => messageSendEvents.slice();
(window as any).__getValue = (el: any): string => textarea(el).value;
(window as any).__resetCalls = () => {
	sendCalls.length = 0;
	inputCalls.length = 0;
	callRouteCalls.length = 0;
	messageSendEvents.length = 0;
};
(window as any).__ready = true;
