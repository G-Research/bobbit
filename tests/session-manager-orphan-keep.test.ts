/**
 * Unit tests for the orphan-cleanup gate (`shouldKeepDespiteOrphan`) and the
 * orphan-transcript scanner (`scanOrphanedTranscripts`) in session-manager.ts.
 *
 * Background: on 2026-05-09 the gateway crash-restart bulk-archived 9 sessions
 * whose worktrees and JSONL transcripts were healthy because `sessions.json`
 * had silently rolled back. The gate refuses to garbage-collect any session
 * whose worktree dir still exists AND whose agent JSONL was written within
 * the last 24h.
 *
 * Pinned by goal `goal-goal-sessions-p-14dc3ec7`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-keep-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { shouldKeepDespiteOrphan, scanOrphanedTranscripts } = await import(
	"../src/server/agent/orphan-cleanup.ts"
);
type PersistedSession = import("../src/server/agent/session-store.ts").PersistedSession;

function makePs(overrides: Partial<PersistedSession>): PersistedSession {
	return {
		id: "s-test",
		title: "test",
		cwd: tmpRoot,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		...overrides,
	} as PersistedSession;
}

describe("shouldKeepDespiteOrphan", () => {
	it("returns false when no worktree path is set", () => {
		const ps = makePs({ worktreePath: undefined, agentSessionFile: undefined });
		assert.equal(shouldKeepDespiteOrphan(ps), false);
	});

	it("returns false when the worktree directory does not exist", () => {
		const wt = path.join(tmpRoot, "missing-worktree");
		const transcript = path.join(tmpRoot, "case-a.jsonl");
		fs.writeFileSync(transcript, "{}\n");
		const ps = makePs({ worktreePath: wt, agentSessionFile: transcript });
		assert.equal(shouldKeepDespiteOrphan(ps), false);
	});

	it("returns false when worktree exists but transcript is older than 24h", () => {
		const wt = fs.mkdtempSync(path.join(tmpRoot, "wt-old-"));
		const transcript = path.join(tmpRoot, "case-old.jsonl");
		fs.writeFileSync(transcript, "{}\n");
		const ancient = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(transcript, ancient, ancient);
		const ps = makePs({ worktreePath: wt, agentSessionFile: transcript });
		assert.equal(shouldKeepDespiteOrphan(ps), false);
	});

	it("returns false when worktree exists but no transcript file is set", () => {
		const wt = fs.mkdtempSync(path.join(tmpRoot, "wt-noent-"));
		const ps = makePs({ worktreePath: wt, agentSessionFile: undefined });
		assert.equal(shouldKeepDespiteOrphan(ps), false);
	});

	it("returns false when transcript path is set but file missing", () => {
		const wt = fs.mkdtempSync(path.join(tmpRoot, "wt-missing-jsonl-"));
		const transcript = path.join(tmpRoot, "never-written.jsonl");
		const ps = makePs({ worktreePath: wt, agentSessionFile: transcript });
		assert.equal(shouldKeepDespiteOrphan(ps), false);
	});

	it("returns TRUE when worktree exists AND transcript mtime is within 24h", () => {
		const wt = fs.mkdtempSync(path.join(tmpRoot, "wt-live-"));
		const transcript = path.join(tmpRoot, "case-live.jsonl");
		fs.writeFileSync(transcript, "{}\n");
		// Just-written file — mtime is ~now.
		const ps = makePs({ worktreePath: wt, agentSessionFile: transcript });
		assert.equal(shouldKeepDespiteOrphan(ps), true);
	});
});

describe("scanOrphanedTranscripts", () => {
	it("returns 0 when the agent-sessions root does not exist", () => {
		const result = scanOrphanedTranscripts(
			path.join(tmpRoot, "nonexistent"),
			new Set(),
			0,
		);
		assert.equal(result.count, 0);
		assert.deepEqual(result.paths, []);
	});

	it("ignores tracked transcripts and old transcripts", () => {
		const root = fs.mkdtempSync(path.join(tmpRoot, "scan-"));
		const proj = path.join(root, "--project--");
		fs.mkdirSync(proj, { recursive: true });

		// Tracked — should be skipped.
		const tracked = path.join(proj, "tracked.jsonl");
		fs.writeFileSync(tracked, "{}\n");

		// Old — should be skipped.
		const old = path.join(proj, "old.jsonl");
		fs.writeFileSync(old, "{}\n");
		const ancient = (Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(old, ancient, ancient);

		// Non-jsonl — should be skipped.
		fs.writeFileSync(path.join(proj, "notes.txt"), "ignore me");

		// Orphan — should be reported.
		const orphan = path.join(proj, "orphan.jsonl");
		fs.writeFileSync(orphan, "{}\n");

		// Floor: 24h ago (so `old` is filtered out, but `orphan` and `tracked` qualify by mtime).
		const floor = Date.now() - 24 * 60 * 60 * 1000;
		const result = scanOrphanedTranscripts(root, new Set([tracked]), floor);
		assert.equal(result.count, 1);
		assert.deepEqual(result.paths, [orphan]);
	});

	it("caps the returned paths at 50", () => {
		const root = fs.mkdtempSync(path.join(tmpRoot, "scan-cap-"));
		const proj = path.join(root, "--many--");
		fs.mkdirSync(proj, { recursive: true });
		for (let i = 0; i < 75; i++) {
			fs.writeFileSync(path.join(proj, `t-${i}.jsonl`), "{}\n");
		}
		const result = scanOrphanedTranscripts(root, new Set(), 0);
		assert.equal(result.count, 75);
		assert.equal(result.paths.length, 50);
	});

	it("walks subdirectories recursively", () => {
		const root = fs.mkdtempSync(path.join(tmpRoot, "scan-deep-"));
		const sub = path.join(root, "a", "b", "c");
		fs.mkdirSync(sub, { recursive: true });
		const orphan = path.join(sub, "deep.jsonl");
		fs.writeFileSync(orphan, "{}\n");
		const result = scanOrphanedTranscripts(root, new Set(), 0);
		assert.equal(result.count, 1);
		assert.deepEqual(result.paths, [orphan]);
	});
});
