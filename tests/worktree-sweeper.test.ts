/**
 * Unit tests for worktree-sweeper.classifyWorktrees.
 *
 * Pure function — no git, no I/O. Feeds canned `git worktree list --porcelain`
 * output and asserts the classification buckets (pool / active / orphan / repair).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyWorktrees, sweepOrphanedWorktrees } from "../src/server/agent/worktree-sweeper.ts";

const REPO = "/tmp/repo";

const PORCELAIN = `worktree /tmp/repo
HEAD aaaa
branch refs/heads/master

worktree /tmp/repo-wt/pool-_pool-abcd1234
HEAD bbbb
branch refs/heads/pool/_pool-abcd1234

worktree /tmp/repo-wt/session-_pool-legacy55
HEAD cccc
branch refs/heads/session/_pool-legacy55

worktree /tmp/repo-wt/session-coder-12345678
HEAD dddd
branch refs/heads/session/coder-12345678

worktree /tmp/repo-wt/goal-fix-87654321
HEAD eeee
branch refs/heads/goal/fix-87654321

worktree /tmp/repo-wt/session-old-orphan
HEAD ffff
branch refs/heads/session/old-orphan

worktree /tmp/repo-wt/session-drift-aaaaaaaa
HEAD gggg
branch refs/heads/session/drift-aaaaaaaa
`;

describe("worktree-sweeper.classifyWorktrees", () => {
	it("buckets pool, legacy-pool, active, orphan, and drifted worktrees correctly", () => {
		const out = classifyWorktrees({
			porcelainStdout: PORCELAIN,
			repoPath: REPO,
			goals: [
				{ id: "g1", branch: "goal/fix-87654321", worktreePath: "/tmp/repo-wt/goal-fix-87654321" },
			],
			sessions: [
				{ id: "s1", branch: "session/coder-12345678", worktreePath: "/tmp/repo-wt/session-coder-12345678" },
				// Drift case: record says path X, git lists path Y.
				{ id: "s2", branch: "session/drift-aaaaaaaa", worktreePath: "/tmp/repo-wt/session-drift-OLDPATH" },
			],
			staff: [],
		});

		// Pool entries: new + legacy prefixes both classified as pool.
		assert.equal(out.pool.length, 2, `expected 2 pool entries, got ${out.pool.map(p => p.branch).join(",")}`);
		assert.ok(out.pool.some(p => p.branch === "pool/_pool-abcd1234"));
		assert.ok(out.pool.some(p => p.branch === "session/_pool-legacy55"));

		// Active: owned-by-record + path matches.
		assert.equal(out.active.length, 2, `expected 2 active, got ${out.active.map(a => a.branch).join(",")}`);
		assert.ok(out.active.some(a => a.branch === "session/coder-12345678"));
		assert.ok(out.active.some(a => a.branch === "goal/fix-87654321"));

		// Orphan: branch on disk with no live record.
		assert.equal(out.orphan.length, 1, `expected 1 orphan, got ${out.orphan.map(o => o.branch).join(",")}`);
		assert.equal(out.orphan[0].branch, "session/old-orphan");

		// Repair: drift case — record says path X, git path differs.
		assert.equal(out.repair.length, 1);
		assert.equal(out.repair[0].branch, "session/drift-aaaaaaaa");
	});

	it("classifies primary worktree as neither active nor orphan", () => {
		const out = classifyWorktrees({
			porcelainStdout: PORCELAIN,
			repoPath: REPO,
			goals: [],
			sessions: [],
			staff: [],
		});
		// Primary worktree (master) is filtered out — should not appear in any bucket.
		const all = [...out.pool, ...out.active, ...out.orphan, ...out.repair];
		assert.equal(all.some(w => w.path === REPO), false, "primary worktree must not appear");
	});

	it("treats archived records as if absent (their worktrees become orphans)", () => {
		const out = classifyWorktrees({
			porcelainStdout: `worktree /tmp/repo-wt/session-arch-deadbeef\nbranch refs/heads/session/arch-deadbeef\n`,
			repoPath: REPO,
			goals: [],
			sessions: [
				{ id: "s1", branch: "session/arch-deadbeef", worktreePath: "/tmp/repo-wt/session-arch-deadbeef", archived: true },
			],
			staff: [],
		});
		assert.equal(out.orphan.length, 1);
		assert.equal(out.active.length, 0);
	});
});

describe("worktree-sweeper.sweepOrphanedWorktrees", () => {
	it("skips a project whose rootPath has no .git (does not walk upward)", async () => {
		// Regression: when rootPath is a directory inside another git repo,
		// `git worktree list` walks upward and returns the parent's worktrees.
		// The sweeper would then try to clean unrelated worktrees — catastrophic.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweeper-no-git-"));
		try {
			const result = await sweepOrphanedWorktrees({
				projects: [{ id: "p1", rootPath: tmp }],
				goals: [],
				sessions: [],
				staff: [],
			});
			assert.equal(result.cleaned, 0, "must not clean any worktrees from a non-repo rootPath");
			assert.equal(result.repaired, 0);
			assert.equal(result.reclaimed, 0);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
