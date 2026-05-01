/**
 * Unit tests for `DelegateHarness` — the restart-resilient blocking-tool
 * harness for the `delegate` tool. See
 * `docs/design/delegate-restart-resilience.md` \u00a72.1 and \u00a710.1.
 *
 * Mirrors `verification-harness` persistence behavior: atomic
 * write-then-rename, tolerant load, idempotent submit.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DelegateHarness, resolveSessionKind, type ActiveDelegate, type DelegateResultPayload } from "../src/server/agent/delegate-harness.ts";

let tmpRoot: string;
let stateDir: string;
let persistPath: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-harness-test-"));
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	persistPath = path.join(stateDir, "active-delegates.json");
});

afterEach(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeActive(overrides: Partial<ActiveDelegate> = {}): ActiveDelegate {
	return {
		parentSessionId: "parent-1",
		toolUseId: "tu_1",
		delegateSessionId: "child-1",
		cwd: "/tmp/delegate",
		instructions: "do the thing",
		timeoutMs: 60_000,
		createdAt: Date.now(),
		...overrides,
	};
}

describe("DelegateHarness", () => {
	it("register then submit resolves the parked Promise with the supplied result", async () => {
		const h = new DelegateHarness(stateDir);
		const active = makeActive();
		const p = h.register(active);

		const result: DelegateResultPayload = { status: "completed", output: "hello" };
		const drained = h.submit(active.parentSessionId, active.toolUseId, result);

		assert.equal(drained, true);
		const got = await p;
		assert.deepEqual(got, result);
		// pending map is empty after drain
		assert.deepEqual(h.getActiveDelegates(), []);
	});

	it("submit before register latches; subsequent register drains; latch persists until acknowledge", async () => {
		const h = new DelegateHarness(stateDir);
		const result: DelegateResultPayload = { status: "completed", output: "early" };
		const drained = h.submit("parent-1", "tu_1", result);
		assert.equal(drained, false, "no pending entry, must latch");

		const got = await h.register(makeActive());
		assert.deepEqual(got, result);

		// Durability invariant: the latch must persist across register() so
		// a crash between register-return and HTTP-flush doesn't lose the
		// result. A retried register() returns the same latched value
		// (idempotent redelivery). Only `acknowledge()` clears it.
		const retried = await h.register(makeActive());
		assert.deepEqual(retried, result, "second register returns the same latched result (durability)");

		// Acknowledge clears the latch. Subsequent register returns the
		// synthetic already-delivered idempotency payload.
		h.acknowledge("parent-1", "tu_1");
		const third = await h.register(makeActive());
		assert.equal(third.status, "completed");
		assert.match(third.error || "", /already.delivered|idempotent.retry/i);
	});

	it("register against an existing pending key supersedes the prior resolver", async () => {
		const h = new DelegateHarness(stateDir);
		const first = h.register(makeActive());

		// Suppress unhandled-rejection by attaching a catch handler before the
		// reject fires.
		const firstSettled = first.then(
			() => ({ kind: "resolved" as const }),
			(err: Error) => ({ kind: "rejected" as const, message: err.message }),
		);

		const second = h.register(makeActive());
		assert.notEqual(second, first);

		const outcome = await firstSettled;
		assert.equal(outcome.kind, "rejected");
		if (outcome.kind === "rejected") assert.equal(outcome.message, "superseded");

		// The second is still pending and resolvable.
		h.submit("parent-1", "tu_1", { status: "completed", output: "ok" });
		const got = await second;
		assert.equal(got.output, "ok");
	});

	it("rejectAllForSession rejects every pending key with that parent prefix and clears matching latched entries", async () => {
		const h = new DelegateHarness(stateDir);
		// Two delegates from parent-1 (parallel: i=0,1) plus latched, plus an
		// unrelated parent-2 entry that must be untouched.
		const p1a = h.register(makeActive({ parentSessionId: "parent-1", toolUseId: "tu_a", delegateSessionId: "child-a" }));
		const p1b = h.register(makeActive({ parentSessionId: "parent-1", toolUseId: "tu_b", delegateSessionId: "child-b" }));
		h.submit("parent-1", "tu_latched", { status: "completed", output: "stale" });
		const p2 = h.register(makeActive({ parentSessionId: "parent-2", toolUseId: "tu_x", delegateSessionId: "child-x" }));

		const p1aSettled = p1a.catch((e: Error) => ({ rejected: e.message }));
		const p1bSettled = p1b.catch((e: Error) => ({ rejected: e.message }));

		const killed = h.rejectAllForSession("parent-1");
		assert.deepEqual(killed.sort(), ["child-a", "child-b"]);

		assert.deepEqual(await p1aSettled, { rejected: "Parent session terminated" });
		assert.deepEqual(await p1bSettled, { rejected: "Parent session terminated" });

		// Latched entry for parent-1 dropped.
		const persisted = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
		assert.equal(persisted.latched.filter((l: { key: string }) => l.key.startsWith("parent-1:")).length, 0);

		// parent-2 untouched — submit still resolves it.
		h.submit("parent-2", "tu_x", { status: "completed", output: "ok" });
		const got = await p2;
		assert.equal(got.output, "ok");
	});

	it("persistence round-trip: register on instance A, submit on instance B latches; subsequent register drains", async () => {
		const a = new DelegateHarness(stateDir);
		const active = makeActive();
		// Attach a catch so the orphaned Promise from instance A doesn't crash
		// the test runner with an unhandled rejection (the closures from A
		// have no awaiter once we instantiate B).
		const orphan = a.register(active);
		orphan.catch(() => { /* ignore — A's closures are dead */ });

		// Persisted to disk.
		assert.ok(fs.existsSync(persistPath), "persistPath must exist after register");
		const persistedA = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
		assert.equal(persistedA.pending.length, 1);
		assert.equal(persistedA.pending[0].parentSessionId, "parent-1");

		// New instance picks up the pending shell.
		const b = new DelegateHarness(stateDir);
		assert.equal(b.getActiveDelegates().length, 1);
		assert.equal(b.getActiveDelegateSessionIds().has("child-1"), true);

		// Submit on B — no live resolver in B for the shell, so the result
		// must be latched (not resolved).
		const result: DelegateResultPayload = { status: "completed", output: "post-restart" };
		const drained = b.submit(active.parentSessionId, active.toolUseId, result);
		assert.equal(drained, false, "shell has no awaiter; must latch");

		// Parent re-registers on B → drains the latch (latch retained on disk
		// until the HTTP handler explicitly acknowledges; this is the durability
		// invariant for restart-survival of a re-delivered result).
		const got = await b.register(active);
		assert.deepEqual(got, result);

		// Latch retained pending acknowledge; shell cleared.
		const persistedB = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
		assert.equal(persistedB.pending.length, 0, "shell cleared");
		assert.equal(persistedB.latched.length, 1, "latch retained until acknowledge");

		// Acknowledge clears the latch.
		assert.equal(b.acknowledge(active.parentSessionId, active.toolUseId), true);
		assert.deepEqual(JSON.parse(fs.readFileSync(persistPath, "utf-8")), { pending: [], latched: [] });
	});

	it("register-after-restart durability: latch survives even if redelivery crashes mid-flush", async () => {
		// Models the high-severity bug from code-review #7: latched result
		// must remain on disk while the redelivery HTTP response is being
		// written, so a crash mid-flush still leaves a recoverable record
		// for the parent's retried /wait.
		const a = new DelegateHarness(stateDir);
		a.recordActive(makeActive());
		a.submit("parent-1", "tu_1", { status: "completed", output: "durable-redelivery" });

		// Simulate restart: new harness instance picks up the latched result
		// from disk. Parent's /wait POST arrives — register() returns the
		// latched value but DOES NOT delete it (durability hold).
		const b = new DelegateHarness(stateDir);
		const first = await b.register(makeActive());
		assert.equal(first.output, "durable-redelivery");
		assert.equal(JSON.parse(fs.readFileSync(persistPath, "utf-8")).latched.length, 1);

		// Crash mid-HTTP-write: another harness instance comes up and the
		// parent retries /wait. Latch is still there; second register() drains
		// the same value (still no acknowledge yet).
		const c = new DelegateHarness(stateDir);
		const retry = await c.register(makeActive());
		assert.equal(retry.output, "durable-redelivery");
		assert.equal(JSON.parse(fs.readFileSync(persistPath, "utf-8")).latched.length, 1);

		// Parent's HTTP flush finally succeeds — acknowledge clears the latch.
		assert.equal(c.acknowledge("parent-1", "tu_1"), true);
		assert.deepEqual(JSON.parse(fs.readFileSync(persistPath, "utf-8")), { pending: [], latched: [] });
	});

	it("submit on pending: durability — result is latched on disk before resolving the awaiter", async () => {
		// Regression test for the durability gap: if the gateway crashes
		// between submit() and the parent's HTTP-response-finished, the
		// terminal result must remain on disk so a retried /wait can drain it.
		const h = new DelegateHarness(stateDir);
		const pending = h.register(makeActive());
		const drained = h.submit("parent-1", "tu_1", { status: "completed", output: "durable" });
		assert.equal(drained, true, "resolved a pending awaiter");
		const got = await pending;
		assert.deepEqual(got, { status: "completed", output: "durable" });
		// Latch still on disk — not yet acknowledged.
		const persisted = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
		assert.equal(persisted.latched.length, 1, "latch retained until acknowledge");
		assert.equal(persisted.latched[0].result.output, "durable");
	});

	it("acknowledge clears the latch and locks future submits to no-op", async () => {
		const h = new DelegateHarness(stateDir);
		const pending = h.register(makeActive());
		h.submit("parent-1", "tu_1", { status: "completed", output: "x" });
		await pending;
		const ackHad = h.acknowledge("parent-1", "tu_1");
		assert.equal(ackHad, true);
		const persisted = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
		assert.equal(persisted.latched.length, 0);
		// Subsequent submit for same key is a no-op (completed mark).
		const dup = h.submit("parent-1", "tu_1", { status: "failed", output: "" });
		assert.equal(dup, false);
		assert.equal(JSON.parse(fs.readFileSync(persistPath, "utf-8")).latched.length, 0);
	});

	it("acknowledge is idempotent and a no-op on unknown key", () => {
		const h = new DelegateHarness(stateDir);
		assert.equal(h.acknowledge("nope", "none"), false);
	});

	it("register-after-acknowledge: returns idempotent already-delivered payload, does not park forever", async () => {
		// Regression test for the high-severity finding from code-review #6:
		// register() used to clear `completed` first, so a retried /wait after
		// the server-side acknowledge() would park a fresh resolver no future
		// submit could satisfy — wedging the retried request until timeout.
		const h = new DelegateHarness(stateDir);
		const pending = h.register(makeActive());
		h.submit("parent-1", "tu_1", { status: "completed", output: "x" });
		await pending;
		h.acknowledge("parent-1", "tu_1");

		// Retried /wait against the same key after ack — must NOT park.
		const retry = h.register(makeActive());
		// Race: must resolve synchronously (Promise.resolve), not park.
		let settled: { status: string; error?: string } | null = null;
		retry.then(r => { settled = r; });
		// Yield microtasks once — a parked Promise would still be null after one tick.
		await Promise.resolve();
		assert.notEqual(settled, null, "retry must resolve, not park");
		assert.equal(settled!.status, "completed");
		assert.match(settled!.error || "", /already.delivered|idempotent.retry/i);
	});

	it("cancel: shell-only key cleans up entirely (does NOT latch — prevents abort leak)", () => {
		// Regression for code-review #8: the /api/internal/delegate/cancel
		// endpoint previously called submit({status:"terminated"}), which
		// against a shell-only key (parent aborts before /wait registers)
		// would *latch* the terminated result and leave the shell live. No
		// parent would ever drain or acknowledge that latch —
		// active-delegates.json would retain orphan state across restarts.
		const h = new DelegateHarness(stateDir);
		h.recordActive(makeActive());
		assert.equal(h.getActiveDelegateSessionIds().has("child-1"), true);
		const found = h.cancel("parent-1", "tu_1", "abort");
		assert.equal(found, true);
		assert.equal(h.getActiveDelegateSessionIds().has("child-1"), false);
		const persisted = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
		assert.deepEqual(persisted, { pending: [], latched: [] });
		// Racing submit after cancel is a no-op.
		const drained = h.submit("parent-1", "tu_1", { status: "completed", output: "late" });
		assert.equal(drained, false);
		assert.equal(JSON.parse(fs.readFileSync(persistPath, "utf-8")).latched.length, 0);
	});

	it("cancel: pending awaiter resolves with structured terminated payload", async () => {
		const h = new DelegateHarness(stateDir);
		const pending = h.register(makeActive());
		h.cancel("parent-1", "tu_1", "Aborted by user");
		const result = await pending;
		assert.equal(result.status, "terminated");
		assert.equal(result.error, "Aborted by user");
	});

	it("cancel: drops latched result, preventing stale redelivery", () => {
		const h = new DelegateHarness(stateDir);
		h.submit("parent-1", "tu_1", { status: "completed", output: "stale" });
		assert.equal(JSON.parse(fs.readFileSync(persistPath, "utf-8")).latched.length, 1);
		h.cancel("parent-1", "tu_1", "abort");
		assert.equal(JSON.parse(fs.readFileSync(persistPath, "utf-8")).latched.length, 0);
	});

	it("recordActive after acknowledge clears completed mark (key recycle)", async () => {
		// A parent that legitimately re-uses a tool_use_id should get a fresh
		// lifecycle, not a synthetic already-delivered payload.
		const h = new DelegateHarness(stateDir);
		const pending = h.register(makeActive());
		h.submit("parent-1", "tu_1", { status: "completed", output: "first" });
		await pending;
		h.acknowledge("parent-1", "tu_1");

		// Recycle the key with fresh metadata.
		h.recordActive(makeActive({ title: "second-call" }));
		// New submit should latch on the fresh shell, not be dropped as
		// duplicate.
		const drained = h.submit("parent-1", "tu_1", { status: "completed", output: "second" });
		assert.equal(drained, false);
		const result = await h.register(makeActive());
		assert.equal(result.output, "second", "key recycle delivered fresh result");
	});

	it("durability across simulated restart: submit → _loadFromDisk → register drains latch", async () => {
		const a = new DelegateHarness(stateDir);
		const pending = a.register(makeActive());
		pending.catch(() => { /* A's closure is dead after restart */ });
		a.submit("parent-1", "tu_1", { status: "completed", output: "survives-restart" });
		await pending;
		// "Crash" mid-HTTP-write: don't acknowledge.
		// New harness instance reads disk and finds the latch.
		const b = new DelegateHarness(stateDir);
		const result = await b.register(makeActive());
		assert.deepEqual(result, { status: "completed", output: "survives-restart" });
	});

	it("submit twice for the same key is idempotent (second call is a no-op)", () => {
		const h = new DelegateHarness(stateDir);
		const r1 = h.submit("parent-1", "tu_1", { status: "completed", output: "first" });
		assert.equal(r1, false, "no pending — latch");
		const r2 = h.submit("parent-1", "tu_1", { status: "completed", output: "second" });
		assert.equal(r2, false, "already latched — no-op");
		// First-write-wins: latched value should still be "first".
		const persisted = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
		assert.equal(persisted.latched[0].result.output, "first");
	});

	it("_loadFromDisk tolerates absent file (empty state)", () => {
		assert.ok(!fs.existsSync(persistPath));
		const h = new DelegateHarness(stateDir);
		assert.deepEqual(h.getActiveDelegates(), []);
		assert.deepEqual([...h.getActiveDelegateSessionIds()], []);
	});

	it("_loadFromDisk tolerates malformed file (empty state, no throw)", () => {
		fs.writeFileSync(persistPath, "{not json", "utf-8");
		const h = new DelegateHarness(stateDir);
		assert.deepEqual(h.getActiveDelegates(), []);
	});

	it("_loadFromDisk tolerates partially-valid records", () => {
		fs.writeFileSync(
			persistPath,
			JSON.stringify({
				pending: [
					null,
					{ parentSessionId: 42 }, // wrong type — skipped
					{ parentSessionId: "p", toolUseId: "t", delegateSessionId: "d", cwd: "/x", instructions: "", timeoutMs: 1, createdAt: 1 },
				],
				latched: [
					null,
					{ key: "p:t", result: { status: "completed", output: "y" } },
					{ key: 99, result: { status: "completed", output: "y" } }, // wrong type — skipped
				],
			}),
			"utf-8",
		);
		const h = new DelegateHarness(stateDir);
		assert.equal(h.getActiveDelegates().length, 1);
		// Latched valid entry survived.
		const drained = h.submit("never-registered", "x", { status: "completed", output: "z" });
		assert.equal(drained, false);
	});

	it("atomic write: persistPath is rewritten on every mutation via .tmp rename", () => {
		const h = new DelegateHarness(stateDir);
		assert.ok(!fs.existsSync(persistPath), "no file before any mutation");

		h.register(makeActive()).catch(() => { /* ignore — no awaiter survival */ });
		const stat1 = fs.statSync(persistPath);

		// Force enough mtime resolution.
		const sleep = () => new Promise(r => setTimeout(r, 20));
		return sleep().then(() => {
			h.submit("parent-1", "tu_1", { status: "completed", output: "x" });
			const stat2 = fs.statSync(persistPath);
			assert.notEqual(stat2.mtimeMs, stat1.mtimeMs, "file rewritten on submit");
			// .tmp must not be left behind after a successful rename.
			assert.ok(!fs.existsSync(`${persistPath}.tmp`), "no orphan .tmp after rename");
		});
	});

	it("constructor does NOT auto-subscribe addTerminationListener (cascade is owned by server.ts)", () => {
		let subscribed = false;
		const mockSm = {
			addTerminationListener(_fn: (sessionId: string, info: { reason: "terminated" | "archived" | "purged" }) => void) {
				subscribed = true;
			},
		};
		const h = new DelegateHarness(stateDir, mockSm);
		assert.equal(subscribed, false, "harness must NOT auto-subscribe — server.ts owns cascade so killed children can be terminated");
		void h;
	});

	it("constructor tolerates a SessionManager stub without addTerminationListener", () => {
		const h = new DelegateHarness(stateDir, {});
		// Just constructing without throwing is the contract.
		h.register(makeActive()).catch(() => { /* ignore */ });
		h.submit("parent-1", "tu_1", { status: "completed", output: "" });
	});

	it("recordActive: persists shell metadata without creating a pending Promise", () => {
		const h = new DelegateHarness(stateDir);
		h.recordActive(makeActive());
		assert.equal(h.getActiveDelegates().length, 1);
		// submit BEFORE register (live-path race) latches into latched, not pending.
		h.submit("parent-1", "tu_1", { status: "completed", output: "early" });
		// Now the parent's wait POST arrives — register drains the latch.
		return h.register(makeActive()).then(result => {
			assert.equal(result.status, "completed");
			assert.equal(result.output, "early");
		});
	});

	it("recordActive: idempotent — second call with same key is a no-op when shell already exists", () => {
		const h = new DelegateHarness(stateDir);
		h.recordActive(makeActive({ title: "first" }));
		h.recordActive(makeActive({ title: "second" }));
		const all = h.getActiveDelegates();
		assert.equal(all.length, 1);
		assert.equal(all[0].title, "first", "first wins; second is a no-op");
	});

	it("recordActive: no-op when a real pending Promise already exists for the key", async () => {
		const h = new DelegateHarness(stateDir);
		const p = h.register(makeActive({ title: "real" }));
		h.recordActive(makeActive({ title: "shell-attempt" }));
		h.submit("parent-1", "tu_1", { status: "completed", output: "" });
		await p;
		// Pending entry kept its real resolver; recordActive did not overwrite.
		// (No assertion needed beyond the awaited submit completing successfully.)
	});

	it("getActiveDelegateSessionIds returns the in-flight delegate child ids", () => {
		const h = new DelegateHarness(stateDir);
		h.register(makeActive({ delegateSessionId: "c1" })).catch(() => { /* ignore */ });
		h.register(makeActive({ toolUseId: "tu_2", delegateSessionId: "c2" })).catch(() => { /* ignore */ });
		const ids = h.getActiveDelegateSessionIds();
		assert.deepEqual([...ids].sort(), ["c1", "c2"]);
	});

	it("resumeInterruptedDelegates re-loads from disk and returns the active list", () => {
		const a = new DelegateHarness(stateDir);
		a.register(makeActive()).catch(() => { /* ignore */ });

		// Brand new instance — simulate restart.
		const b = new DelegateHarness(stateDir);
		assert.equal(b.getActiveDelegates().length, 1, "shell loaded on construct");
		// Manually wipe in-memory state and verify resume re-reads from disk.
		(b as unknown as { shells: Map<string, unknown>; pending: Map<string, unknown> }).shells = new Map();
		(b as unknown as { shells: Map<string, unknown>; pending: Map<string, unknown> }).pending = new Map();
		const list = b.resumeInterruptedDelegates();
		assert.equal(list.length, 1);
		assert.equal(list[0].delegateSessionId, "child-1");
	});
});

describe("resolveSessionKind", () => {
	it("returns explicit kind when present", () => {
		assert.equal(resolveSessionKind({ kind: "reviewer" }), "reviewer");
		assert.equal(resolveSessionKind({ kind: "delegate" }), "delegate");
		assert.equal(resolveSessionKind({ kind: "worker" }), "worker");
	});
	it("infers delegate from delegateOf when kind absent (legacy records)", () => {
		assert.equal(resolveSessionKind({ delegateOf: "parent-1" }), "delegate");
	});
	it("defaults to worker when both kind and delegateOf are absent", () => {
		assert.equal(resolveSessionKind({}), "worker");
	});
	it("ignores garbage kind values and falls back to inference", () => {
		assert.equal(resolveSessionKind({ kind: "bogus" as unknown as undefined, delegateOf: "p" }), "delegate");
		assert.equal(resolveSessionKind({ kind: "" as unknown as undefined }), "worker");
	});
});
