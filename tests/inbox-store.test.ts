/**
 * Unit tests for InboxStore — per-staff JSON-file persistence with FIFO
 * ordering, reload semantics, and last-writer-wins on id collision.
 *
 * Pinned by docs/design/staff-inbox.md §2, §3.1.
 *
 * Test pattern mirrors tests/staff-sandboxed-persistence.test.ts — exercise
 * the real store against tmp directories rooted under os.tmpdir().
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-store-"));

const { InboxStore } = await import("../src/server/agent/inbox-store.ts");
type InboxEntry = import("../src/server/agent/inbox-store.ts").InboxEntry;

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

function freshStateDir(label: string): string {
	return fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
}

function makeEntry(overrides: Partial<InboxEntry> & { id: string; staffId: string }): InboxEntry {
	return {
		id: overrides.id,
		staffId: overrides.staffId,
		source: overrides.source ?? { type: "trigger", triggerId: "t1" },
		title: overrides.title ?? "test entry",
		prompt: overrides.prompt ?? "do the thing",
		context: overrides.context,
		state: overrides.state ?? "pending",
		createdAt: overrides.createdAt ?? 100,
		completedAt: overrides.completedAt,
		result: overrides.result,
		error: overrides.error,
	};
}

describe("InboxStore — put/get/list", () => {
	it("put + get round-trips a pending entry", () => {
		const store = new InboxStore(freshStateDir("rt"));
		const e = makeEntry({ id: "e1", staffId: "s1" });
		store.put(e);
		assert.deepEqual(store.get("s1", "e1"), e);
	});

	it("get returns undefined for unknown staff or entry", () => {
		const store = new InboxStore(freshStateDir("missing"));
		store.put(makeEntry({ id: "e1", staffId: "s1" }));
		assert.equal(store.get("s1", "missing"), undefined);
		assert.equal(store.get("s-missing", "e1"), undefined);
	});

	it("list returns entries in FIFO (insertion) order", () => {
		const store = new InboxStore(freshStateDir("fifo"));
		store.put(makeEntry({ id: "a", staffId: "s1", createdAt: 1, title: "first" }));
		store.put(makeEntry({ id: "b", staffId: "s1", createdAt: 2, title: "second" }));
		store.put(makeEntry({ id: "c", staffId: "s1", createdAt: 3, title: "third" }));
		const ids = store.list("s1").map((e) => e.id);
		assert.deepEqual(ids, ["a", "b", "c"]);
	});

	it("list isolates entries per staff", () => {
		const store = new InboxStore(freshStateDir("multi"));
		store.put(makeEntry({ id: "a", staffId: "s1" }));
		store.put(makeEntry({ id: "b", staffId: "s2" }));
		assert.deepEqual(store.list("s1").map((e) => e.id), ["a"]);
		assert.deepEqual(store.list("s2").map((e) => e.id), ["b"]);
		assert.deepEqual(store.list("s-unknown"), []);
	});

	it("list returns a defensive copy (caller mutations don't bleed in)", () => {
		const store = new InboxStore(freshStateDir("copy"));
		store.put(makeEntry({ id: "a", staffId: "s1" }));
		const first = store.list("s1");
		first.pop();
		assert.equal(store.list("s1").length, 1, "internal store is unchanged");
	});
});

describe("InboxStore — listPending", () => {
	it("filters to pending entries only", () => {
		const store = new InboxStore(freshStateDir("pending"));
		store.put(makeEntry({ id: "a", staffId: "s1", state: "pending" }));
		store.put(makeEntry({ id: "b", staffId: "s1", state: "completed" }));
		store.put(makeEntry({ id: "c", staffId: "s1", state: "pending" }));
		store.put(makeEntry({ id: "d", staffId: "s1", state: "failed" }));
		store.put(makeEntry({ id: "e", staffId: "s1", state: "cancelled" }));
		assert.deepEqual(store.listPending("s1").map((x) => x.id), ["a", "c"]);
	});

	it("returns [] for unknown staff", () => {
		const store = new InboxStore(freshStateDir("empty"));
		assert.deepEqual(store.listPending("unknown"), []);
	});
});

describe("InboxStore — update", () => {
	it("applies partial updates and persists them", () => {
		const store = new InboxStore(freshStateDir("upd"));
		store.put(makeEntry({ id: "e1", staffId: "s1" }));
		const ok = store.update("s1", "e1", { state: "completed", completedAt: 200, result: "ok" });
		assert.equal(ok, true);
		const after = store.get("s1", "e1")!;
		assert.equal(after.state, "completed");
		assert.equal(after.completedAt, 200);
		assert.equal(after.result, "ok");
	});

	it("returns false for unknown staff or entry", () => {
		const store = new InboxStore(freshStateDir("upd-missing"));
		store.put(makeEntry({ id: "e1", staffId: "s1" }));
		assert.equal(store.update("s1", "missing", { state: "completed" }), false);
		assert.equal(store.update("s-missing", "e1", { state: "completed" }), false);
	});

	it("skips undefined values and treats null as field deletion", () => {
		const store = new InboxStore(freshStateDir("upd-clear"));
		store.put(makeEntry({ id: "e1", staffId: "s1", result: "kept" }));
		store.update("s1", "e1", { result: undefined });
		assert.equal(store.get("s1", "e1")!.result, "kept");
		store.update("s1", "e1", { result: null as any });
		assert.equal(Object.prototype.hasOwnProperty.call(store.get("s1", "e1")!, "result"), false);
	});
});

describe("InboxStore — remove / removeAll", () => {
	it("remove deletes one entry and returns true", () => {
		const store = new InboxStore(freshStateDir("rm"));
		store.put(makeEntry({ id: "a", staffId: "s1" }));
		store.put(makeEntry({ id: "b", staffId: "s1" }));
		assert.equal(store.remove("s1", "a"), true);
		assert.deepEqual(store.list("s1").map((e) => e.id), ["b"]);
	});

	it("remove returns false when entry is missing", () => {
		const store = new InboxStore(freshStateDir("rm-missing"));
		store.put(makeEntry({ id: "a", staffId: "s1" }));
		assert.equal(store.remove("s1", "missing"), false);
		assert.equal(store.remove("s-missing", "a"), false);
	});

	it("removeAll wipes the staff file and clears the in-memory cache", () => {
		const stateDir = freshStateDir("rm-all");
		const store = new InboxStore(stateDir);
		store.put(makeEntry({ id: "a", staffId: "s1" }));
		store.put(makeEntry({ id: "b", staffId: "s1" }));
		store.removeAll("s1");
		assert.deepEqual(store.list("s1"), []);
		// File should be gone too.
		const expected = path.join(stateDir, "inbox", "s1.json");
		assert.equal(fs.existsSync(expected), false, "file must be unlinked");
	});

	it("removeAll on a never-touched staff is a no-op (no throw)", () => {
		const store = new InboxStore(freshStateDir("rm-all-empty"));
		store.removeAll("never-existed");
		assert.deepEqual(store.list("never-existed"), []);
	});
});

describe("InboxStore — reload from disk", () => {
	it("recovers all entries through a fresh InboxStore over the same stateDir", () => {
		const stateDir = freshStateDir("reload");
		const s1 = new InboxStore(stateDir);
		s1.put(makeEntry({ id: "a", staffId: "s1", createdAt: 1 }));
		s1.put(makeEntry({ id: "b", staffId: "s1", createdAt: 2, state: "completed" }));
		s1.put(makeEntry({ id: "c", staffId: "s2", createdAt: 3 }));

		const s2 = new InboxStore(stateDir);
		assert.deepEqual(s2.list("s1").map((e) => e.id), ["a", "b"]);
		assert.deepEqual(s2.listPending("s1").map((e) => e.id), ["a"]);
		assert.deepEqual(s2.list("s2").map((e) => e.id), ["c"]);
	});

	it("missing or corrupt files yield an empty list (no throw)", () => {
		const stateDir = freshStateDir("corrupt");
		// Pre-create a malformed file.
		fs.mkdirSync(path.join(stateDir, "inbox"), { recursive: true });
		fs.writeFileSync(path.join(stateDir, "inbox", "s1.json"), "not-json", "utf-8");
		const store = new InboxStore(stateDir);
		assert.deepEqual(store.list("s1"), []);
	});
});

describe("InboxStore — concurrent / repeated put", () => {
	it("last-writer-wins on id collision (no duplicates)", () => {
		const store = new InboxStore(freshStateDir("collide"));
		store.put(makeEntry({ id: "x", staffId: "s1", title: "v1" }));
		store.put(makeEntry({ id: "x", staffId: "s1", title: "v2" }));
		store.put(makeEntry({ id: "x", staffId: "s1", title: "v3" }));
		const all = store.list("s1");
		assert.equal(all.length, 1);
		assert.equal(all[0].title, "v3");
	});
});
