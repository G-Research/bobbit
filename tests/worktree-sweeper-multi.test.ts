/**
 * worktree-sweeper.classifyWorktrees — multi-repo classification (Phase 4a).
 *
 * Pure function — feeds canned `git worktree list --porcelain` output as if
 * the sweeper had enumerated each repo, and asserts per-repo classification
 * against goals/sessions whose `repoWorktrees` map records which worktrees
 * each record owns across multiple repos.
 *
 * Note: `classifyWorktrees` is a pure helper that takes a single porcelain
 * stdout (one repo at a time). The multi-repo sweeper enumerates per-repo
 * and aggregates classifications. This test asserts both shapes:
 *   1. The classifier honors per-repo `repoWorktrees` entries when matching
 *      ownership by path (a session that owns `<container>/api/` and
 *      `<container>/web/` is treated as active in both repos).
 *   2. Aggregating two per-repo classifications yields the expected union.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyWorktrees } from "../src/server/agent/worktree-sweeper.ts";

describe("worktree-sweeper — multi-repo classification", () => {
	it("recognises per-repo worktrees of the same session as active in both repos", () => {
		// Multi-repo session: branch `session/multi-12345678`, container at
		// `/tmp/proj-wt/session-multi-12345678/`, with per-repo worktrees
		// `<container>/api/` and `<container>/web/`.
		const apiPorcelain = `worktree /tmp/proj/api
HEAD aaaa
branch refs/heads/master

worktree /tmp/proj-wt/session-multi-12345678/api
HEAD bbbb
branch refs/heads/session/multi-12345678
`;
		const webPorcelain = `worktree /tmp/proj/web
HEAD cccc
branch refs/heads/master

worktree /tmp/proj-wt/session-multi-12345678/web
HEAD dddd
branch refs/heads/session/multi-12345678
`;

		const sessions = [{
			id: "s1",
			branch: "session/multi-12345678",
			worktreePath: "/tmp/proj-wt/session-multi-12345678",
			repoWorktrees: {
				api: "/tmp/proj-wt/session-multi-12345678/api",
				web: "/tmp/proj-wt/session-multi-12345678/web",
			},
		}];

		const apiOut = classifyWorktrees({
			porcelainStdout: apiPorcelain,
			repoPath: "/tmp/proj/api",
			goals: [],
			sessions,
			staff: [],
		});
		const webOut = classifyWorktrees({
			porcelainStdout: webPorcelain,
			repoPath: "/tmp/proj/web",
			goals: [],
			sessions,
			staff: [],
		});

		// Each repo's per-repo worktree must be classified as active.
		assert.equal(apiOut.active.length, 1, `api active: got ${apiOut.active.map(a => a.path)}`);
		assert.equal(apiOut.active[0].path, "/tmp/proj-wt/session-multi-12345678/api");
		assert.equal(webOut.active.length, 1);
		assert.equal(webOut.active[0].path, "/tmp/proj-wt/session-multi-12345678/web");

		// Neither should appear as orphan.
		assert.equal(apiOut.orphan.length, 0);
		assert.equal(webOut.orphan.length, 0);
	});

	it("per-repo worktree on owned branch but not in repoWorktrees — marked as repair (path drift)", () => {
		// One session owns api; web is on the same branch but not listed in
		// `repoWorktrees` (e.g. server died after creating api but before the
		// rename completed for web). The classifier sees branch ownership but
		// not path ownership, so it falls through to `repair` against the
		// record's container path — the sweeper will try `git worktree repair`.
		const webPorcelain = `worktree /tmp/proj/web
branch refs/heads/master

worktree /tmp/proj-wt/session-multi-87654321/web
branch refs/heads/session/multi-87654321
`;
		const sessions = [{
			id: "s1",
			branch: "session/multi-87654321",
			worktreePath: "/tmp/proj-wt/session-multi-87654321",
			repoWorktrees: {
				api: "/tmp/proj-wt/session-multi-87654321/api",
			},
		}];

		const webOut = classifyWorktrees({
			porcelainStdout: webPorcelain,
			repoPath: "/tmp/proj/web",
			goals: [],
			sessions,
			staff: [],
		});

		// branch is owned, path is not in repoWorktrees — this is repair (drift).
		assert.equal(webOut.active.length, 0);
		assert.equal(webOut.orphan.length, 0);
		assert.equal(webOut.repair.length, 1);
		assert.equal(webOut.repair[0].path, "/tmp/proj-wt/session-multi-87654321/web");
	});

	it("multi-repo goal worktree set: each repo classified active under repoWorktrees", () => {
		const apiPorcelain = `worktree /tmp/proj/api
branch refs/heads/master

worktree /tmp/proj-wt/goal-fix-abcdef12/api
branch refs/heads/goal/fix-abcdef12
`;
		const sharedPorcelain = `worktree /tmp/proj/shared
branch refs/heads/master

worktree /tmp/proj-wt/goal-fix-abcdef12/shared
branch refs/heads/goal/fix-abcdef12
`;
		const goals = [{
			id: "g1",
			branch: "goal/fix-abcdef12",
			worktreePath: "/tmp/proj-wt/goal-fix-abcdef12",
			repoWorktrees: {
				api: "/tmp/proj-wt/goal-fix-abcdef12/api",
				shared: "/tmp/proj-wt/goal-fix-abcdef12/shared",
			},
		}];

		const apiOut = classifyWorktrees({
			porcelainStdout: apiPorcelain,
			repoPath: "/tmp/proj/api",
			goals,
			sessions: [],
			staff: [],
		});
		const sharedOut = classifyWorktrees({
			porcelainStdout: sharedPorcelain,
			repoPath: "/tmp/proj/shared",
			goals,
			sessions: [],
			staff: [],
		});

		assert.equal(apiOut.active.length, 1);
		assert.equal(apiOut.orphan.length, 0);
		assert.equal(sharedOut.active.length, 1);
		assert.equal(sharedOut.orphan.length, 0);
	});
});
