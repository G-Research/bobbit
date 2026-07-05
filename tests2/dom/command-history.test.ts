// Migrated from tests/command-history.spec.ts (v2-dom tier).
//
// The legacy spec had two describe blocks:
//   1. "CommandHistoryStore dedup" — ported here against the REAL
//      CommandHistoryStore (src/ui/storage/stores/command-history-store.ts) backed
//      by an in-memory StorageBackend. Date.now() is stubbed to a monotonic counter
//      so the composite `${sessionId}:${timestamp}` ids never collide within a ms.
//   2. "Command history" (ArrowUp/ArrowDown draft state machine) — NOT ported.
//      That behaviour lives in <message-editor> (MessageEditor.ts) and is driven by
//      `_isCursorOnVisualTopRow()`/`_isCursorOnVisualBottomRow()` caret geometry plus
//      the IME composition guard (`e.isComposing`/keyCode 229) and textarea
//      autoresize — none of which happy-dom provides (no caret rects, no layout).
//      It also loads history asynchronously from IndexedDB. Mounting the editor to
//      exercise the nav is therefore not feasible under happy-dom; left for the
//      browser tier.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandHistoryStore } from "../../src/ui/storage/stores/command-history-store.js";
import type { StorageBackend } from "../../src/ui/storage/types.js";

function memBackend(): StorageBackend {
	const m = new Map<string, unknown>();
	return {
		async get(_s, key) { return (m.get(key) ?? null) as any; },
		async set(_s, key, value) { m.set(key, value); },
		async delete(_s, key) { m.delete(key); },
		async keys(_s, prefix) { return [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)); },
	} as StorageBackend;
}

let store: CommandHistoryStore;
let clock: number;

beforeEach(() => {
	clock = 1000;
	// Monotonic Date.now() — the real store keys entries by `${sid}:${Date.now()}`,
	// so identical timestamps within a ms would collide. Production entries are
	// seconds apart; the counter reproduces that distinctness deterministically.
	vi.spyOn(Date, "now").mockImplementation(() => clock++);
	store = new CommandHistoryStore();
	store.setBackend(memBackend());
});

afterEach(() => { vi.restoreAllMocks(); });

describe("CommandHistoryStore dedup", () => {
	it("consecutive duplicate entries are deduped (story 29)", async () => {
		await store.addEntry("test-session", "dup");
		await store.addEntry("test-session", "dup");
		await store.addEntry("test-session", "dup");
		const history = await store.getHistory("test-session");
		expect(history).toEqual(["dup"]);
		expect(history).toHaveLength(1);
	});

	it("non-consecutive duplicates are kept", async () => {
		await store.addEntry("test-session", "alpha");
		await store.addEntry("test-session", "beta");
		await store.addEntry("test-session", "alpha");
		expect(await store.getHistory("test-session")).toEqual(["alpha", "beta", "alpha"]);
	});

	it("empty/whitespace entries are ignored", async () => {
		await store.addEntry("test-session", "real");
		await store.addEntry("test-session", "");
		await store.addEntry("test-session", "   ");
		expect(await store.getHistory("test-session")).toEqual(["real"]);
	});
});
