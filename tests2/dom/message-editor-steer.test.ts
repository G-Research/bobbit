import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// v2-native — NOT a migrated legacy test. Listed in tests-map.json `v2Native`.
//
// Real-component DOM coverage for the Ctrl/Cmd+Enter composer steer shortcut
// (goal edbb4afd). Renders the REAL <message-editor> under happy-dom and drives
// its keydown handler with dispatched KeyboardEvents, mirroring the harness used
// by message-editor-ctrl-arrow.test.ts / message-editor-slash.test.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";

// Under vitest isolate:false the module-level @customElement define only runs in
// the window active at first import (a different test file may own it), so
// re-register the tag in THIS file's window if needed.
if (!customElements.get("message-editor")) customElements.define("message-editor", MessageEditor);

afterEach(() => { document.body.innerHTML = ""; });
beforeEach(() => { document.body.innerHTML = ""; });

interface Spies {
	onSend: string[];
	onSteerSend: string[];
}

async function mount(): Promise<{ el: any; spies: Spies }> {
	const el = document.createElement("message-editor") as any;
	el.showModelSelector = false;
	el.showThinkingSelector = false;
	el.showAttachmentButton = false;
	const spies: Spies = { onSend: [], onSteerSend: [] };
	el.onSend = (text: string) => spies.onSend.push(text);
	el.onSteerSend = (text: string) => spies.onSteerSend.push(text);
	document.body.appendChild(el);
	await el.updateComplete;
	return { el, spies };
}

const ta = (el: any): HTMLTextAreaElement => el.querySelector("textarea");

/** Set the composer value + fire one input event so the real component syncs. */
async function setValue(el: any, value: string): Promise<void> {
	const t = ta(el);
	t.value = value;
	t.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	await el.updateComplete;
}

async function key(el: any, k: string, mods: Partial<KeyboardEventInit> = {}): Promise<KeyboardEvent> {
	const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
	ta(el).dispatchEvent(ev);
	await el.updateComplete;
	return ev;
}

describe("MessageEditor Ctrl/Cmd+Enter steer shortcut", () => {
	it("Ctrl+Enter with non-empty text calls onSteerSend, not onSend", async () => {
		const { el, spies } = await mount();
		await setValue(el, "steer this");
		const ev = await key(el, "Enter", { ctrlKey: true });
		expect(spies.onSteerSend).toEqual(["steer this"]);
		expect(spies.onSend).toEqual([]);
		expect(ev.defaultPrevented).toBe(true);
	});

	it("Cmd/Meta+Enter with non-empty text calls onSteerSend, not onSend", async () => {
		const { el, spies } = await mount();
		await setValue(el, "steer via meta");
		const ev = await key(el, "Enter", { metaKey: true });
		expect(spies.onSteerSend).toEqual(["steer via meta"]);
		expect(spies.onSend).toEqual([]);
		expect(ev.defaultPrevented).toBe(true);
	});

	it("plain Enter still sends a normal prompt (onSend), not onSteerSend", async () => {
		const { el, spies } = await mount();
		await setValue(el, "normal prompt");
		await key(el, "Enter");
		expect(spies.onSend).toEqual(["normal prompt"]);
		expect(spies.onSteerSend).toEqual([]);
	});

	it("Shift+Enter inserts a newline and neither sends nor steers", async () => {
		const { el, spies } = await mount();
		await setValue(el, "line one");
		const ev = await key(el, "Enter", { shiftKey: true });
		expect(spies.onSend).toEqual([]);
		expect(spies.onSteerSend).toEqual([]);
		// Shift+Enter is left to the textarea default (newline), not preventDefaulted.
		expect(ev.defaultPrevented).toBe(false);
	});

	it("Ctrl+Shift+Enter does not steer (Shift excludes the shortcut)", async () => {
		const { el, spies } = await mount();
		await setValue(el, "with shift");
		await key(el, "Enter", { ctrlKey: true, shiftKey: true });
		expect(spies.onSteerSend).toEqual([]);
		expect(spies.onSend).toEqual([]);
	});

	it("Ctrl+Enter with attachments blocks the steer and shows an accessible inline error", async () => {
		const { el, spies } = await mount();
		await setValue(el, "text with file");
		el.attachments = [{ id: "a1", type: "image", fileName: "f.png", mimeType: "image/png", content: "AAAA", preview: "AAAA" }];
		await el.updateComplete;

		const ev = await key(el, "Enter", { ctrlKey: true });

		expect(spies.onSteerSend).toEqual([]);
		expect(spies.onSend).toEqual([]);
		expect(ev.defaultPrevented).toBe(true);
		// State preserved: text + attachments untouched.
		expect(el.value).toBe("text with file");
		expect(el.attachments.length).toBe(1);
		// Inline error rendered, accessible, with the exact message.
		const errEl = el.querySelector('[data-testid="composer-steer-error"]');
		expect(errEl).not.toBeNull();
		expect(errEl?.getAttribute("role")).toBe("alert");
		expect(errEl?.textContent).toBe(MessageEditor.STEER_ATTACHMENT_ERROR);
	});

	it("removing the attachment dismisses the steer error", async () => {
		const { el } = await mount();
		await setValue(el, "text with file");
		el.attachments = [{ id: "a1", type: "image", fileName: "f.png", mimeType: "image/png", content: "AAAA", preview: "AAAA" }];
		await el.updateComplete;
		await key(el, "Enter", { ctrlKey: true });
		expect(el.querySelector('[data-testid="composer-steer-error"]')).not.toBeNull();

		// removeFile clears the error and the attachment.
		el.removeFile("a1");
		await el.updateComplete;
		expect(el.querySelector('[data-testid="composer-steer-error"]')).toBeNull();
		expect(el._steerError).toBe("");
	});

	it("editing the composer clears the steer error", async () => {
		const { el } = await mount();
		await setValue(el, "text with file");
		el.attachments = [{ id: "a1", type: "image", fileName: "f.png", mimeType: "image/png", content: "AAAA", preview: "AAAA" }];
		await el.updateComplete;
		await key(el, "Enter", { ctrlKey: true });
		expect(el._steerError).toBe(MessageEditor.STEER_ATTACHMENT_ERROR);

		await setValue(el, "text with file edited");
		expect(el._steerError).toBe("");
		expect(el.querySelector('[data-testid="composer-steer-error"]')).toBeNull();
	});

	it("Ctrl+Enter with empty/whitespace text is a no-op", async () => {
		const { el, spies } = await mount();
		await setValue(el, "   ");
		await key(el, "Enter", { ctrlKey: true });
		expect(spies.onSteerSend).toEqual([]);
		expect(spies.onSend).toEqual([]);
	});

	it("IME composition takes precedence: Ctrl+Enter while composing does not steer", async () => {
		const { el, spies } = await mount();
		await setValue(el, "composing");
		await key(el, "Enter", { ctrlKey: true, isComposing: true });
		expect(spies.onSteerSend).toEqual([]);
		// keyCode 229 variant (Chromium/Firefox report "Process").
		await key(el, "Enter", { ctrlKey: true, keyCode: 229 });
		expect(spies.onSteerSend).toEqual([]);
	});

	it("open slash autocomplete keeps Enter ownership: Ctrl+Enter selects the skill, does not steer", async () => {
		const { el, spies } = await mount();
		await setValue(el, "/dep");
		el._slashMenuOpen = true;
		el._slashFilteredSkills = [{ name: "deploy", description: "Deploy", source: "project" }];
		el._slashSelectedIndex = 0;
		el._slashTokenStart = 0;
		await el.updateComplete;

		await key(el, "Enter", { ctrlKey: true });

		expect(spies.onSteerSend).toEqual([]);
		// Slash-menu Enter handler ran: menu closed and the skill was inserted.
		expect(el._slashMenuOpen).toBe(false);
		expect(el.value).toContain("/deploy ");
	});

	it("open @-mention autocomplete keeps Enter ownership: Ctrl+Enter selects the file, does not steer", async () => {
		const { el, spies } = await mount();
		await setValue(el, "@sr");
		el._atMenuOpen = true;
		el._atFilteredFiles = ["src/index.ts"];
		el._atSelectedIndex = 0;
		el._atTokenStart = 0;
		await el.updateComplete;

		await key(el, "Enter", { ctrlKey: true });

		expect(spies.onSteerSend).toEqual([]);
		expect(el._atMenuOpen).toBe(false);
	});

	it("a successful steer resets history browsing state and records history", async () => {
		const { el, spies } = await mount();
		// Enter history browsing so _historyIndex is non -1, then steer.
		el._history = ["old one", "old two"];
		el._historyIndex = 0;
		el._savedDraft = "draft";
		const recorded: string[] = [];
		el.addToHistory = async (t: string) => { recorded.push(t); };
		await setValue(el, "steer me");
		await key(el, "Enter", { ctrlKey: true });

		expect(spies.onSteerSend).toEqual(["steer me"]);
		expect(el._historyIndex).toBe(-1);
		expect(el._savedDraft).toBe("");
		expect(recorded).toEqual(["steer me"]);
	});
});
