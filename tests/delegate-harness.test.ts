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

	it("submit before register latches; subsequent register drains and clears the latch", async () => {
		const h = new DelegateHarness(stateDir);
		const result: DelegateResultPayload = { status: "completed", output: "early" };
		const drained = h.submit("parent-1", "tu_1", result);
		assert.equal(drained, false, "no pending entry, must latch");

		const got = await h.register(makeActive());
		assert.deepEqual(got, result);

		// Latch is gone — a second register should not auto-resolve.
		let resolved = false;
		const second = h.register(makeActive({ toolUseId: "tu_1" }));
		second.then(() => { resolved = true; }, () => { /* superseded later */ });
		await new Promise(r => setTimeout(r, 5));
		assert.equal(resolved, false);
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

		// Parent re-registers on B → drains the latch.
		const got = await b.register(active);
		assert.deepEqual(got, result);

		// Persisted state is now empty.
		const persistedB = JSON.parse(fs.readFileSync(persistPath, "utf-8"));
		assert.deepEqual(persistedB, { pending: [], latched: [] });
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

	it("constructor wires addTerminationListener when SessionManager exposes it; rejects pending on parent terminate", async () => {
		let captured: ((sessionId: string, info: { reason: "terminated" | "archived" | "purged" }) => void) | null = null;
		const mockSm = {
			addTerminationListener(fn: (sessionId: string, info: { reason: "terminated" | "archived" | "purged" }) => void) {
				captured = fn;
			},
		};
		const h = new DelegateHarness(stateDir, mockSm);
		assert.ok(captured, "harness must register a termination listener");

		const p = h.register(makeActive());
		const settled = p.catch((e: Error) => e.message);
		// Synthesise a parent-archive event.
		(captured as unknown as (sessionId: string, info: { reason: "terminated" | "archived" | "purged" }) => void)("parent-1", { reason: "archived" });
		assert.equal(await settled, "Parent session archived");
	});

	it("constructor tolerates a SessionManager stub without addTerminationListener", () => {
		const h = new DelegateHarness(stateDir, {});
		// Just constructing without throwing is the contract.
		h.register(makeActive()).catch(() => { /* ignore */ });
		h.submit("parent-1", "tu_1", { status: "completed", output: "" });
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
