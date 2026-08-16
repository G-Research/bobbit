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

/** By default the steer mock confirms the send (resolves true) so the editor
 *  runs its post-send lifecycle. Individual tests override `el.onSteerSend` to
 *  simulate failure/cancellation or a controllable in-flight promise. */
async function mount(): Promise<{ el: any; spies: Spies }> {
	const el = document.createElement("message-editor") as any;
	el.showModelSelector = false;
	el.showThinkingSelector = false;
	el.showAttachmentButton = false;
	const spies: Spies = { onSend: [], onSteerSend: [] };
	el.onSend = (text: string) => spies.onSend.push(text);
	el.onSteerSend = (text: string) => { spies.onSteerSend.push(text); return true; };
	document.body.appendChild(el);
	await el.updateComplete;
	return { el, spies };
}

/** Drain the microtask queue so the async `handleSteerShortcut` chain (await
 *  onSteerSend → addToHistory → clear) settles, then flush the Lit render. */
async function settle(el: any): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await el.updateComplete;
}

const ta = (el: any): HTMLTextAreaElement => el.querySelector("textarea");

/** Set the composer value + fire one input event so the real component syncs. */
async function setValue(el: any, value: string): Promise<void> {
	const t = ta(el);
	t.value = value;
	t.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	await el.updateComplete;
}

function dispatchKey(el: any, k: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
	const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods });
	ta(el).dispatchEvent(ev);
	return ev;
}

async function key(el: any, k: string, mods: Partial<KeyboardEventInit> = {}): Promise<KeyboardEvent> {
	const ev = dispatchKey(el, k, mods);
	// handleSteerShortcut is async & fire-and-forget from keydown — let it settle.
	await settle(el);
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
		el._historyEditBuffer = new Map([[-1, "draft"], [0, "edited old one"]]);
		const recorded: string[] = [];
		el.addToHistory = async (t: string) => { recorded.push(t); };
		await setValue(el, "steer me");
		await key(el, "Enter", { ctrlKey: true });

		expect(spies.onSteerSend).toEqual(["steer me"]);
		expect(el._historyIndex).toBe(-1);
		expect(el._historyEditBuffer).toEqual(new Map());
		expect(recorded).toEqual(["steer me"]);
	});

	it("a confirmed steer clears the composer and retains focus", async () => {
		const { el } = await mount();
		await setValue(el, "steer and clear");
		ta(el).focus();
		await key(el, "Enter", { ctrlKey: true });

		expect(el.value).toBe("");
		expect(ta(el).value).toBe("");
		expect(el.ownerDocument.activeElement).toBe(ta(el));
	});

	it("a confirmed steer dispatches the message-send draft-cleanup event", async () => {
		const { el } = await mount();
		let sends = 0;
		el.addEventListener("message-send", () => { sends++; });
		await setValue(el, "steer me");
		await key(el, "Enter", { ctrlKey: true });
		expect(sends).toBe(1);
	});

	it("a failed/cancelled readiness (onSteerSend false) leaves draft, history and value intact", async () => {
		const { el, spies } = await mount();
		el.onSteerSend = (t: string) => { spies.onSteerSend.push(t); return false; };
		el._historyIndex = -1;
		const recorded: string[] = [];
		el.addToHistory = async (t: string) => { recorded.push(t); };
		let sends = 0;
		el.addEventListener("message-send", () => { sends++; });
		await setValue(el, "unsent draft");

		await key(el, "Enter", { ctrlKey: true });

		expect(spies.onSteerSend).toEqual(["unsent draft"]);
		// No irreversible lifecycle work ran.
		expect(sends).toBe(0);
		expect(recorded).toEqual([]);
		expect(el._historyIndex).toBe(-1);
		expect(el.value).toBe("unsent draft");
	});

	it("a mid-flight attachment is preserved, not discarded, when the steer resolves", async () => {
		const { el } = await mount();
		let resolveSteer!: (v: boolean) => void;
		const recorded: string[] = [];
		el.addToHistory = async (t: string) => { recorded.push(t); };
		let sends = 0;
		el.addEventListener("message-send", () => { sends++; });
		el.onSteerSend = () => new Promise<boolean>((r) => { resolveSteer = r; });
		await setValue(el, "steer me");

		// Fire the shortcut; the send is still pending.
		dispatchKey(el, "Enter", { ctrlKey: true });
		await Promise.resolve();
		// User adds an attachment while the steer is in flight.
		el.attachments = [{ id: "a1", type: "image", fileName: "f.png", mimeType: "image/png", content: "AAAA", preview: "AAAA" }];
		resolveSteer(true);
		await settle(el);

		// Snapshot no longer matches (attachment present) → nothing cleared/discarded.
		expect(el.value).toBe("steer me");
		expect(el.attachments.length).toBe(1);
		expect(sends).toBe(0);
		// History still records the sent text (it was confirmed).
		expect(recorded).toEqual(["steer me"]);
	});

	it("a mid-flight text edit is preserved, not cleared, when the steer resolves", async () => {
		const { el } = await mount();
		let resolveSteer!: (v: boolean) => void;
		let sends = 0;
		el.addEventListener("message-send", () => { sends++; });
		el.onSteerSend = () => new Promise<boolean>((r) => { resolveSteer = r; });
		await setValue(el, "original");

		dispatchKey(el, "Enter", { ctrlKey: true });
		await Promise.resolve();
		// User keeps typing during the await.
		el.value = "original plus more";
		resolveSteer(true);
		await settle(el);

		// Newer text preserved because the snapshot no longer matches what we sent.
		expect(el.value).toBe("original plus more");
		expect(sends).toBe(0);
	});

	it("a re-entrant Ctrl+Enter while a steer is in flight is ignored (guard prevents duplicate sends)", async () => {
		const { el, spies } = await mount();
		let resolveSteer!: (v: boolean) => void;
		el.onSteerSend = (t: string) => {
			spies.onSteerSend.push(t);
			return new Promise<boolean>((r) => { resolveSteer = r; });
		};
		await setValue(el, "steer once");

		// Fire the shortcut twice while the first send is still pending. The second
		// press must be dropped by the in-flight reentrancy guard.
		dispatchKey(el, "Enter", { ctrlKey: true });
		await Promise.resolve();
		dispatchKey(el, "Enter", { ctrlKey: true });
		await Promise.resolve();

		expect(spies.onSteerSend).toEqual(["steer once"]);

		// Resolve the single in-flight send; the composer clears exactly once.
		resolveSteer(true);
		await settle(el);
		expect(spies.onSteerSend).toEqual(["steer once"]);
		expect(el.value).toBe("");

		// After the guard clears, a fresh Ctrl+Enter steers again as normal.
		await setValue(el, "steer twice");
		el.onSteerSend = (t: string) => { spies.onSteerSend.push(t); return true; };
		await key(el, "Enter", { ctrlKey: true });
		expect(spies.onSteerSend).toEqual(["steer once", "steer twice"]);
	});

	it("a DISTINCT edited steer is NOT dropped while an earlier steer is in flight", async () => {
		const { el, spies } = await mount();
		const resolvers: Array<(v: boolean) => void> = [];
		el.onSteerSend = (t: string) => {
			spies.onSteerSend.push(t);
			return new Promise<boolean>((r) => { resolvers.push(r); });
		};
		await setValue(el, "first");

		// First steer in flight.
		dispatchKey(el, "Enter", { ctrlKey: true });
		await Promise.resolve();
		expect(spies.onSteerSend).toEqual(["first"]);

		// User edits the composer to distinct text and steers again while the first is
		// still pending. The content-aware lock keys on text, so the DISTINCT edit is
		// allowed through (not blocked as a duplicate).
		el.value = "second";
		dispatchKey(el, "Enter", { ctrlKey: true });
		await Promise.resolve();
		expect(spies.onSteerSend).toEqual(["first", "second"]);

		// Resolve both in-flight sends.
		resolvers.forEach((r) => r(true));
		await settle(el);
	});

	it("a steer resolving AFTER a session switch does not touch the now-current session", async () => {
		const { el } = await mount();
		let resolveSteer!: (v: boolean) => void;
		let sends = 0;
		el.addEventListener("message-send", () => { sends++; });
		el.onSteerSend = () => new Promise<boolean>((r) => { resolveSteer = r; });
		el.sessionId = "A";
		await setValue(el, "steer on A");

		// Steer fired on session A; preflight still pending.
		dispatchKey(el, "Enter", { ctrlKey: true });
		await Promise.resolve();

		// Session switches to B (and its composer holds different text) before the steer
		// resolves. The same-session guard means the success cleanup must NOT clear or
		// tombstone session B's composer.
		el.sessionId = "B";
		el.value = "draft on B";
		resolveSteer(true);
		await settle(el);

		expect(sends).toBe(0);
		expect(el.value).toBe("draft on B");
	});

	it("a pending steer blocks the normal-send path (cross-path steer\u2192send)", async () => {
		const { el, spies } = await mount();
		let resolveSteer!: (v: boolean) => void;
		el.onSteerSend = (t: string) => {
			spies.onSteerSend.push(t);
			return new Promise<boolean>((r) => { resolveSteer = r; });
		};
		await setValue(el, "steer first");

		// Steer now in flight (shared submit-lock held).
		dispatchKey(el, "Enter", { ctrlKey: true });
		await Promise.resolve();
		expect(spies.onSteerSend).toEqual(["steer first"]);

		// A normal send (plain Enter) while the steer is pending must NOT fire onSend.
		await key(el, "Enter");
		expect(spies.onSend).toEqual([]);

		// Resolve the steer; the lock releases and a subsequent normal send works.
		resolveSteer(true);
		await settle(el);
		await setValue(el, "normal after");
		await key(el, "Enter");
		expect(spies.onSend).toEqual(["normal after"]);
	});

	it("a pending normal send blocks the steer path (cross-path send\u2192steer)", async () => {
		const { el, spies } = await mount();
		let resolveSend!: () => void;
		el.onSend = (t: string) => {
			spies.onSend.push(t);
			return new Promise<void>((r) => { resolveSend = r; });
		};
		await setValue(el, "send first");

		// Normal send now in flight (shared submit-lock held).
		dispatchKey(el, "Enter");
		await Promise.resolve();
		expect(spies.onSend).toEqual(["send first"]);

		// A steer (Ctrl+Enter) while the send is pending must NOT fire onSteerSend.
		await key(el, "Enter", { ctrlKey: true });
		expect(spies.onSteerSend).toEqual([]);

		// Resolve the send; the lock releases and a subsequent steer works.
		resolveSend();
		await settle(el);
		await key(el, "Enter", { ctrlKey: true });
		expect(spies.onSteerSend).toEqual(["send first"]);
	});

	it("a file mid-processing during steer preflight preserves the text draft (Defect 2)", async () => {
		const { el } = await mount();
		let resolveSteer!: (v: boolean) => void;
		let sends = 0;
		el.addEventListener("message-send", () => { sends++; });
		el.onSteerSend = () => new Promise<boolean>((r) => { resolveSteer = r; });
		await setValue(el, "steer with pending file");

		// Fire the shortcut; the steer is still pending.
		dispatchKey(el, "Enter", { ctrlKey: true });
		await Promise.resolve();
		// A file load starts mid-preflight: processingFiles flips true but attachments
		// has not been populated yet (length still 0).
		el.processingFiles = true;
		resolveSteer(true);
		await settle(el);

		// Text preserved (not wiped by the length-0 check) and no draft tombstone fired.
		expect(el.value).toBe("steer with pending file");
		expect(sends).toBe(0);
		el.processingFiles = false; // cleanup
	});

	it("handleSend clears a stale steer-attachment error (D2)", async () => {
		const { el, spies } = await mount();
		// Set the recovery text first (an input event of its own would clear the
		// error), THEN simulate the blocked-steer alert still being visible.
		await setValue(el, "recovered via enter");
		el._steerError = MessageEditor.STEER_ATTACHMENT_ERROR;
		await el.updateComplete;
		expect(el.querySelector('[data-testid="composer-steer-error"]')).not.toBeNull();

		// A plain-text normal send (Enter) must dismiss the stale alert.
		await key(el, "Enter");

		expect(spies.onSend).toEqual(["recovered via enter"]);
		expect(el._steerError).toBe("");
		expect(el.querySelector('[data-testid="composer-steer-error"]')).toBeNull();
	});
});
