// Migrated from tests/message-editor-ctrl-arrow.spec.ts (v2-dom tier).
// The legacy fixture mirrored MessageEditor's history+arrow logic in plain JS; per
// the porting guide we render the REAL <message-editor> component instead and drive
// its keydown handler. The command-history array is seeded directly on the private
// field (the real component otherwise hydrates it from per-session storage). All
// assertions use an EMPTY textarea, so the visual-row check short-circuits at
// caret position 0 and never needs real layout geometry.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";

// Under vitest isolate:false the module-level @customElement define only runs in the
// window active at first import (a different test file may own it), so re-register
// the tag in THIS file's window if needed.
if (!customElements.get("message-editor")) customElements.define("message-editor", MessageEditor);

afterEach(() => { document.body.innerHTML = ""; });

async function mount(history: string[]) {
	const el = document.createElement("message-editor") as any;
	el.showModelSelector = false;
	el.showThinkingSelector = false;
	el.showAttachmentButton = false;
	document.body.appendChild(el);
	await el.updateComplete;
	el._history = history.slice();
	el._historyIndex = -1;
	return el;
}
const ta = (el: any): HTMLTextAreaElement => el.querySelector("textarea");
async function key(el: any, k: string, mods: Partial<KeyboardEventInit> = {}) {
	ta(el).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));
	await el.updateComplete;
}
const getState = (el: any) => ({ value: el.value, historyIndex: el._historyIndex });

describe("Ctrl+Arrow does not trigger history", () => {
	beforeEach(() => { document.body.innerHTML = ""; });

	it("Ctrl+ArrowUp does not enter history mode", async () => {
		const el = await mount(["old command 1", "old command 2", "old command 3"]);
		await key(el, "ArrowUp", { ctrlKey: true });
		expect(getState(el)).toEqual({ value: "", historyIndex: -1 });
	});

	it("Ctrl+ArrowDown does not cycle history", async () => {
		const el = await mount(["old command 1", "old command 2", "old command 3"]);
		await key(el, "ArrowUp");
		const afterUp = getState(el);
		expect(afterUp.historyIndex).not.toBe(-1);
		expect(afterUp.value).toBe("old command 3");

		await key(el, "ArrowDown", { ctrlKey: true });
		const afterCtrlDown = getState(el);
		expect(afterCtrlDown.historyIndex).toBe(afterUp.historyIndex);
		expect(afterCtrlDown.value).toBe("old command 3");
	});

	it("Meta+ArrowUp does not enter history mode", async () => {
		const el = await mount(["old command 1", "old command 2", "old command 3"]);
		await key(el, "ArrowUp", { metaKey: true });
		expect(getState(el)).toEqual({ value: "", historyIndex: -1 });
	});

	it("Alt+ArrowUp does not enter history mode", async () => {
		const el = await mount(["old command 1", "old command 2", "old command 3"]);
		await key(el, "ArrowUp", { altKey: true });
		expect(getState(el)).toEqual({ value: "", historyIndex: -1 });
	});

	it("plain ArrowUp still works for history", async () => {
		const el = await mount(["old command 1", "old command 2", "old command 3"]);
		await key(el, "ArrowUp");
		expect(getState(el)).toEqual({ value: "old command 3", historyIndex: 2 });
	});

	it("rapid Ctrl+Arrow switching never triggers history", async () => {
		const el = await mount(["old command 1", "old command 2", "old command 3"]);
		for (let i = 0; i < 10; i++) {
			await key(el, "ArrowUp", { ctrlKey: true });
			await key(el, "ArrowDown", { ctrlKey: true });
		}
		expect(getState(el)).toEqual({ value: "", historyIndex: -1 });
	});
});
