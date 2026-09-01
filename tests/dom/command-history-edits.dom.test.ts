import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "../../tests/support/helpers/dom/setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// v2-native — real <message-editor> coverage for command-history edit retention.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";
import { setAppStorage } from "../../src/ui/storage/app-storage.js";
import { CommandHistoryStore } from "../../src/ui/storage/stores/command-history-store.js";
import type { StorageBackend } from "../../src/ui/storage/types.js";

// Under vitest isolate:false the module-level @customElement define only runs in
// the window active at first import (a different test file may own it), so
// re-register the tag in this file's window if needed.
if (!customElements.get("message-editor")) customElements.define("message-editor", MessageEditor);

function memBackend(): StorageBackend {
	const values = new Map<string, unknown>();
	return {
		async get(_store, key) { return (values.get(key) ?? null) as any; },
		async set(_store, key, value) { values.set(key, value); },
		async delete(_store, key) { values.delete(key); },
		async keys(_store, prefix) { return [...values.keys()].filter((key) => !prefix || key.startsWith(prefix)); },
		async getAllFromIndex() { return []; },
		async clear() { values.clear(); },
		async has(_store, key) { return values.has(key); },
		async transaction(_stores, _mode, operation) {
			return operation({
				get: async (_store, key) => (values.get(key) ?? null) as any,
				set: async (_store, key, value) => { values.set(key, value); },
				delete: async (_store, key) => { values.delete(key); },
			});
		},
		async getQuotaInfo() { return { usage: 0, quota: 1, percent: 0 }; },
		async requestPersistence() { return true; },
	} as StorageBackend;
}

async function mount(history: string[], options: { sessionId?: string; onSend?: (text: string) => void } = {}) {
	const el = document.createElement("message-editor") as any;
	el.showModelSelector = false;
	el.showThinkingSelector = false;
	el.showAttachmentButton = false;
	el.sessionId = options.sessionId;
	el.onSend = options.onSend;
	document.body.appendChild(el);
	await el.updateComplete;
	el._history = history.slice();
	el._historyIndex = -1;
	return el;
}

const textarea = (el: any): HTMLTextAreaElement => el.querySelector("textarea");

async function setValue(el: any, value: string): Promise<void> {
	const input = textarea(el);
	input.value = value;
	input.setSelectionRange(value.length, value.length);
	input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	await el.updateComplete;
}

async function key(el: any, key: string, caret: "start" | "end" = "end"): Promise<void> {
	const input = textarea(el);
	const position = caret === "start" ? 0 : input.value.length;
	input.setSelectionRange(position, position);
	input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	await el.updateComplete;
}

async function settle(el: any): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await el.updateComplete;
}

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => { document.body.innerHTML = ""; });

describe("MessageEditor command-history browsing edits", () => {
	it("recalls the edited text after leaving and returning to a history entry", async () => {
		const el = await mount(["older", "newest"]);

		await key(el, "ArrowUp", "start");
		await setValue(el, "newest (edited)");
		await key(el, "ArrowUp", "start");
		expect(el.value).toBe("older");
		await key(el, "ArrowDown", "end");

		expect(el.value).toBe("newest (edited)");
	});

	it("keeps an untouched neighbouring history entry pristine", async () => {
		const el = await mount(["older (pristine)", "newest"]);

		await key(el, "ArrowUp", "start");
		await setValue(el, "newest (edited)");
		await key(el, "ArrowUp", "start");

		expect(el.value).toBe("older (pristine)");
	});

	it("keeps live-draft edits through a history round trip", async () => {
		const el = await mount(["history entry"]);
		await setValue(el, "draft v1");

		await key(el, "ArrowUp", "start");
		await key(el, "ArrowDown", "end");
		expect(el.value).toBe("draft v1");
		await setValue(el, "draft v2 (edited)");
		await key(el, "ArrowUp", "start");
		await key(el, "ArrowDown", "end");

		expect(el.value).toBe("draft v2 (edited)");
	});

	it("clears retained edits after a successful normal send", async () => {
		const sent: string[] = [];
		const el = await mount(["pristine history entry"], {
			onSend: (text) => {
				sent.push(text);
				// The owning composer clears after its successful normal send.
				el.value = "";
			},
		});

		await key(el, "ArrowUp", "start");
		await setValue(el, "edited history entry");
		await key(el, "Enter");
		await settle(el);
		expect(sent).toEqual(["edited history entry"]);
		await key(el, "ArrowUp", "start");

		expect(el.value).toBe("pristine history entry");
	});

	it("does not mutate persisted command history while browsing edits", async () => {
		const sessionId = "history-edit-storage";
		const store = new CommandHistoryStore();
		store.setBackend(memBackend());
		setAppStorage({ commandHistory: store } as any);
		await store.addEntry(sessionId, "persisted older");
		await store.addEntry(sessionId, "persisted newest");
		const persistedBefore = await store.getHistory(sessionId);
		const el = await mount(persistedBefore, { sessionId });

		await key(el, "ArrowUp", "start");
		await setValue(el, "edited only in composer");
		await key(el, "ArrowUp", "start");

		expect(await store.getHistory(sessionId)).toEqual(persistedBefore);
	});
});
