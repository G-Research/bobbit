// Test entry — bundles the REAL <message-editor> Lit component to pin the S3
// IME composition guard against production handleKeyDown (not a replica) and the
// S31 aggregate-size guard against production handleSend.
import "../../src/ui/components/MessageEditor.js";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";
(window as any).MessageEditorClass = MessageEditor;
(window as any).__setAttachments = (el: any, atts: any[]) => { el.attachments = atts; };

const sendCalls: Array<{ text: string }> = [];

function mount(container: HTMLElement) {
	container.innerHTML = "";
	const el = document.createElement("message-editor") as any;
	el.sessionId = "ime-test";
	el.onSend = (text: string) => sendCalls.push({ text });
	container.appendChild(el);
	return el;
}

(window as any).__mountEditor = mount;
(window as any).__getSendCalls = () => sendCalls;
(window as any).__resetSendCalls = () => { sendCalls.length = 0; };
// Find the internal textarea and dispatch a keydown with the given init.
(window as any).__pressEnter = (el: any, init: KeyboardEventInit) => {
	const ta = el.querySelector("textarea") as HTMLTextAreaElement | null;
	if (!ta) throw new Error("textarea not found in message-editor");
	ta.focus();
	ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
};
(window as any).__setValue = (el: any, v: string) => {
	const ta = el.querySelector("textarea") as HTMLTextAreaElement | null;
	if (ta) { ta.value = v; }
	el.value = v;
};
(window as any).__ready = true;
