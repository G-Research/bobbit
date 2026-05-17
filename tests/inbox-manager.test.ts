/**
 * Unit tests for InboxManager — façade over InboxStore. Verifies:
 *   - enqueue persists, emits inbox.entry.added, calls nudger.poke exactly once
 *   - transitionToCompleted only allowed from pending; emits inbox.entry.updated
 *   - transitionToTerminal flips to failed / cancelled with reason → error
 *   - remove emits inbox.entry.removed
 *   - unknown staff / unknown entry → throws (manager) or returns false (remove)
 *
 * Pinned by docs/design/staff-inbox.md §3.2.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-mgr-"));

const { InboxStore } = await import("../src/server/agent/inbox-store.ts");
const { InboxManager } = await import("../src/server/agent/inbox-manager.ts");

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ok */ }
});

interface MockCtx {
	project: { id: string };
	staffStore: { get: (id: string) => unknown };
	inboxStore: InstanceType<typeof InboxStore>;
}

/** Build a minimal PCM with one project and one or more registered staff ids. */
function buildHarness(staffIds: string[]) {
	const stateDir = fs.mkdtempSync(path.join(tmpRoot, "h-"));
	const inboxStore = new InboxStore(stateDir);
	const staffSet = new Set(staffIds);
	const ctx: MockCtx = {
		project: { id: "p1" },
		staffStore: { get: (id: string) => (staffSet.has(id) ? { id } : undefined) },
		inboxStore,
	};
	const pcm = {
		all: () => [ctx][Symbol.iterator](),
	};
	const events: any[] = [];
	const broadcastToAll = (event: any) => { events.push(event); };
	const nudger = { poke: mock.fn((_id: string) => {}) };

	// InboxManager's typed signature wants real classes; we cast at the call
	// site because the methods we exercise touch only the subset we mock.
	const mgr = new InboxManager(pcm as any, {} as any, broadcastToAll);
	mgr.setNudger(nudger as any);

	return { mgr, events, nudger, inboxStore };
}

describe("InboxManager.enqueue", () => {
	it("persists a pending entry, emits inbox.entry.added, calls nudger.poke once", () => {
		const { mgr, events, nudger, inboxStore } = buildHarness(["staff-a"]);
		const entry = mgr.enqueue("staff-a", {
			title: "first",
			prompt: "do x",
			source: { type: "trigger", triggerId: "t1" },
		});

		assert.equal(entry.state, "pending");
		assert.equal(entry.staffId, "staff-a");
		assert.equal(typeof entry.id, "string");
		assert.equal(typeof entry.createdAt, "number");
		assert.equal(entry.title, "first");

		// Persisted
		assert.deepEqual(inboxStore.listPending("staff-a").map((e) => e.id), [entry.id]);

		// Event broadcast
		const added = events.filter((e) => e.type === "inbox.entry.added");
		assert.equal(added.length, 1);
		assert.equal(added[0].staffId, "staff-a");
		assert.equal(added[0].entry.id, entry.id);

		// Nudger poked exactly once
		assert.equal(nudger.poke.mock.callCount(), 1);
		assert.equal(nudger.poke.mock.calls[0].arguments[0], "staff-a");
	});

	it("throws when staff is unknown to all projects", () => {
		const { mgr } = buildHarness(["staff-a"]);
		assert.throws(() => mgr.enqueue("missing", {
			title: "x", prompt: "y", source: { type: "manual_api" },
		}), /Staff agent not found/);
	});

	it("each enqueue is a distinct entry (no coalescing)", () => {
		const { mgr, inboxStore, nudger } = buildHarness(["s"]);
		mgr.enqueue("s", { title: "a", prompt: "p", source: { type: "trigger", triggerId: "t" } });
		mgr.enqueue("s", { title: "a", prompt: "p", source: { type: "trigger", triggerId: "t" } });
		assert.equal(inboxStore.listPending("s").length, 2);
		assert.equal(nudger.poke.mock.callCount(), 2);
	});
});

describe("InboxManager.listForStaff", () => {
	it("filters by state and respects limit", () => {
		const { mgr } = buildHarness(["s"]);
		const a = mgr.enqueue("s", { title: "a", prompt: "p", source: { type: "manual_api" } });
		const b = mgr.enqueue("s", { title: "b", prompt: "p", source: { type: "manual_api" } });
		mgr.enqueue("s", { title: "c", prompt: "p", source: { type: "manual_api" } });
		// Complete one
		mgr.transitionToCompleted("s", a.id);

		const pending = mgr.listForStaff("s", "pending");
		assert.equal(pending.length, 2);
		assert.deepEqual(pending.map((e) => e.id).sort(), [b.id, pending[0].id === b.id ? pending[1].id : pending[0].id].sort());

		const completed = mgr.listForStaff("s", "completed");
		assert.equal(completed.length, 1);
		assert.equal(completed[0].id, a.id);

		const limited = mgr.listForStaff("s", undefined, 2);
		assert.equal(limited.length, 2);
	});

	it("returns [] for unknown staff", () => {
		const { mgr } = buildHarness(["s"]);
		assert.deepEqual(mgr.listForStaff("unknown"), []);
	});
});

describe("InboxManager.transitionToCompleted", () => {
	it("flips pending → completed and emits updated event", () => {
		const { mgr, events } = buildHarness(["s"]);
		const e = mgr.enqueue("s", { title: "t", prompt: "p", source: { type: "manual_ui" } });
		const after = mgr.transitionToCompleted("s", e.id, "done well");
		assert.equal(after.state, "completed");
		assert.equal(after.result, "done well");
		assert.equal(typeof after.completedAt, "number");

		const upd = events.filter((x) => x.type === "inbox.entry.updated");
		assert.equal(upd.length, 1);
		assert.equal(upd[0].entry.state, "completed");
	});

	it("rejects when entry is already in a terminal state", () => {
		const { mgr } = buildHarness(["s"]);
		const e = mgr.enqueue("s", { title: "t", prompt: "p", source: { type: "manual_ui" } });
		mgr.transitionToCompleted("s", e.id);
		assert.throws(() => mgr.transitionToCompleted("s", e.id), /expected pending/);
	});

	it("rejects unknown staff or entry", () => {
		const { mgr } = buildHarness(["s"]);
		assert.throws(() => mgr.transitionToCompleted("missing", "any"), /Staff agent not found/);
		assert.throws(() => mgr.transitionToCompleted("s", "no-such-entry"), /Inbox entry not found/);
	});
});

describe("InboxManager.transitionToTerminal", () => {
	it("flips pending → failed with reason stored on error", () => {
		const { mgr, events } = buildHarness(["s"]);
		const e = mgr.enqueue("s", { title: "t", prompt: "p", source: { type: "manual_ui" } });
		const after = mgr.transitionToTerminal("s", e.id, "failed", "boom");
		assert.equal(after.state, "failed");
		assert.equal(after.error, "boom");
		assert.equal(typeof after.completedAt, "number");
		const upd = events.filter((x) => x.type === "inbox.entry.updated");
		assert.equal(upd.length, 1);
		assert.equal(upd[0].entry.state, "failed");
	});

	it("flips pending → cancelled with reason stored on error", () => {
		const { mgr } = buildHarness(["s"]);
		const e = mgr.enqueue("s", { title: "t", prompt: "p", source: { type: "manual_ui" } });
		const after = mgr.transitionToTerminal("s", e.id, "cancelled", "user dropped it");
		assert.equal(after.state, "cancelled");
		assert.equal(after.error, "user dropped it");
	});

	it("rejects when entry is non-pending", () => {
		const { mgr } = buildHarness(["s"]);
		const e = mgr.enqueue("s", { title: "t", prompt: "p", source: { type: "manual_ui" } });
		mgr.transitionToCompleted("s", e.id);
		assert.throws(() => mgr.transitionToTerminal("s", e.id, "failed", "x"), /expected pending/);
	});

	it("rejects unknown staff or entry", () => {
		const { mgr } = buildHarness(["s"]);
		assert.throws(() => mgr.transitionToTerminal("missing", "any", "failed", "x"), /Staff agent not found/);
		assert.throws(() => mgr.transitionToTerminal("s", "no-such-entry", "failed", "x"), /Inbox entry not found/);
	});
});

describe("InboxManager.remove", () => {
	it("removes the entry and emits inbox.entry.removed", () => {
		const { mgr, events, inboxStore } = buildHarness(["s"]);
		const e = mgr.enqueue("s", { title: "t", prompt: "p", source: { type: "manual_ui" } });
		const ok = mgr.remove("s", e.id);
		assert.equal(ok, true);
		assert.equal(inboxStore.list("s").length, 0);
		const rm = events.filter((x) => x.type === "inbox.entry.removed");
		assert.equal(rm.length, 1);
		assert.equal(rm[0].entryId, e.id);
	});

	it("returns false (no event) when staff or entry is unknown", () => {
		const { mgr, events } = buildHarness(["s"]);
		const before = events.length;
		assert.equal(mgr.remove("missing", "any"), false);
		assert.equal(mgr.remove("s", "no-such-entry"), false);
		// No new events should have been emitted.
		assert.equal(events.length, before);
	});
});
