/**
 * Orphan-cleanup regression tests.
 *
 * Two layers:
 *   1. `shouldKeepDespiteOrphan(ps)` predicate — used by SessionManager's
 *      boot sweep to refuse to archive a session whose worktree is still
 *      live AND whose agent JSONL was touched within the last 24h. The
 *      end-to-end integration with `SessionManager.restoreSessions()`
 *      lives in Task #2's tests.
 *   2. `SessionStore.scanOrphanedTranscripts()` divergence-signal helper
 *      — walks for `*.jsonl` transcripts not referenced by any persisted
 *      session and newer than the most recent `lastActivity`. Surfaces a
 *      banner; no auto-import.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-store-orphan-"));
const stateDir = path.join(tmpRoot, "state");
const transcriptsDir = path.join(tmpRoot, "agent-sessions");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(transcriptsDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const { SessionStore, shouldKeepDespiteOrphan } = await import("../src/server/agent/session-store.ts");
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

function clearAll() {
	for (const f of fs.readdirSync(stateDir)) {
		try { fs.unlinkSync(path.join(stateDir, f)); } catch { /* ignore */ }
	}
	const wipeDir = (d: string) => {
		for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, ent.name);
			if (ent.isDirectory()) {
				wipeDir(full);
				try { fs.rmdirSync(full); } catch { /* ignore */ }
			} else {
				try { fs.unlinkSync(full); } catch { /* ignore */ }
			}
		}
	};
	wipeDir(transcriptsDir);
}

function writeJsonl(rel: string, mtimeMs: number): string {
	const full = path.join(transcriptsDir, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, '{"hello":"world"}\n', "utf-8");
	fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000);
	return full;
}

function tracked(id: string, agentSessionFile: string, lastActivity: number): PersistedSession {
	return {
		id,
		title: id,
		cwd: "/tmp/test",
		agentSessionFile,
		createdAt: lastActivity,
		lastActivity,
	};
}

describe("shouldKeepDespiteOrphan predicate", () => {
	beforeEach(() => clearAll());
	afterEach(() => clearAll());

	it("Case A — no worktree, no recent transcript → false (would archive)", () => {
		const ps = { worktreePath: undefined, agentSessionFile: undefined };
		assert.equal(shouldKeepDespiteOrphan(ps), false);
	});

	it("Case A — worktree path missing on disk → false", () => {
		const now = Date.now();
		const recent = writeJsonl("recent.jsonl", now);
		const ps = { worktreePath: path.join(tmpRoot, "does-not-exist"), agentSessionFile: recent };
		assert.equal(shouldKeepDespiteOrphan(ps, now), false);
	});

	it("Case B — worktree exists + transcript within 24h → true (keep live)", () => {
		const now = Date.now();
		const wt = path.join(tmpRoot, "live-worktree");
		fs.mkdirSync(wt, { recursive: true });
		const recent = writeJsonl("keep-me.jsonl", now - 60_000);
		assert.equal(shouldKeepDespiteOrphan({ worktreePath: wt, agentSessionFile: recent }, now), true);
	});

	it("Case C — worktree exists but transcript older than 24h → false", () => {
		const now = Date.now();
		const wt = path.join(tmpRoot, "live-worktree-stale");
		fs.mkdirSync(wt, { recursive: true });
		const stale = writeJsonl("stale.jsonl", now - 25 * 60 * 60 * 1000);
		assert.equal(shouldKeepDespiteOrphan({ worktreePath: wt, agentSessionFile: stale }, now), false);
	});

	it("transcript path missing on disk → false even if worktree alive", () => {
		const now = Date.now();
		const wt = path.join(tmpRoot, "alive-no-transcript");
		fs.mkdirSync(wt, { recursive: true });
		assert.equal(shouldKeepDespiteOrphan({
			worktreePath: wt,
			agentSessionFile: path.join(tmpRoot, "missing.jsonl"),
		}, now), false);
	});

	// integration: see session-manager test (task #2)
});

describe("SessionStore.scanOrphanedTranscripts", () => {
	beforeEach(() => clearAll());
	afterEach(() => clearAll());

	it("returns empty when every jsonl is tracked", () => {
		const store = new SessionStore(stateDir);
		const now = Date.now();
		const a = writeJsonl("project/a.jsonl", now);
		const b = writeJsonl("project/b.jsonl", now);
		store.put(tracked("a", a, now));
		store.put(tracked("b", b, now));

		const result = store.scanOrphanedTranscripts(transcriptsDir);
		assert.equal(result.count, 0);
		assert.deepEqual(result.paths, []);
	});

	it("flags untracked jsonl files newer than the most recent lastActivity", () => {
		const store = new SessionStore(stateDir);
		const now = Date.now();
		const trackedFile = writeJsonl("project/tracked.jsonl", now - 60_000);
		const orphan = writeJsonl("project/orphan.jsonl", now);
		store.put(tracked("a", trackedFile, now - 60_000));

		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
		try {
			const result = store.scanOrphanedTranscripts(transcriptsDir);
			assert.equal(result.count, 1, `expected 1 orphan, got ${result.count}`);
			assert.equal(result.paths.length, 1);
			assert.equal(path.resolve(result.paths[0]), path.resolve(orphan));
		} finally {
			console.warn = origWarn;
		}
		assert.ok(
			warns.some(w => /\[session-store\] WARN: orphaned transcript:/.test(w)),
			`expected an 'orphaned transcript' warn line, got: ${warns.join("\n")}`,
		);
	});

	it("ignores untracked jsonl files older than the most recent lastActivity", () => {
		const store = new SessionStore(stateDir);
		const now = Date.now();
		const trackedFile = writeJsonl("project/tracked.jsonl", now);
		writeJsonl("project/old-orphan.jsonl", now - 7 * 24 * 60 * 60 * 1000); // 7 days old
		store.put(tracked("a", trackedFile, now));

		const result = store.scanOrphanedTranscripts(transcriptsDir);
		assert.equal(result.count, 0, "old orphan should be ignored — pre-dates last activity");
	});

	it("walks subdirectories recursively", () => {
		const store = new SessionStore(stateDir);
		const now = Date.now();
		store.put(tracked("a", "/nope/never.jsonl", now - 3600_000));
		writeJsonl("deep/nested/dir/lost.jsonl", now);
		writeJsonl("another/branch.jsonl", now);

		const result = store.scanOrphanedTranscripts(transcriptsDir);
		assert.equal(result.count, 2);
	});

	it("respects maxPaths cap but still counts all", () => {
		const store = new SessionStore(stateDir);
		const now = Date.now();
		store.put(tracked("a", "/nope/never.jsonl", now - 3600_000));
		for (let i = 0; i < 8; i++) writeJsonl(`bulk/orphan-${i}.jsonl`, now);

		const result = store.scanOrphanedTranscripts(transcriptsDir, { maxPaths: 3, maxLogLines: 0 });
		assert.equal(result.count, 8);
		assert.equal(result.paths.length, 3);
	});

	it("caps log lines at maxLogLines", () => {
		const store = new SessionStore(stateDir);
		const now = Date.now();
		store.put(tracked("a", "/nope/never.jsonl", now - 3600_000));
		for (let i = 0; i < 5; i++) writeJsonl(`bulk/orphan-${i}.jsonl`, now);

		const warns: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
		try {
			store.scanOrphanedTranscripts(transcriptsDir, { maxLogLines: 2 });
		} finally {
			console.warn = origWarn;
		}
		const orphanWarns = warns.filter(w => /orphaned transcript:/.test(w));
		assert.equal(orphanWarns.length, 2, `expected 2 capped log lines, got ${orphanWarns.length}`);
	});

	it("returns count=0 when agentSessionsRoot does not exist", () => {
		const store = new SessionStore(stateDir);
		const result = store.scanOrphanedTranscripts(path.join(tmpRoot, "does-not-exist"));
		assert.equal(result.count, 0);
		assert.deepEqual(result.paths, []);
	});
});
