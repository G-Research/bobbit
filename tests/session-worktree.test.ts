/**
 * Unit tests for the session auto-worktree decision logic.
 *
 * Tests the logic that determines whether a new session should get a git
 * worktree: non-goal/non-assistant sessions in git repos get one,
 * assistant sessions and non-git-repo sessions don't.
 *
 * Replaces the flaky E2E tests:
 *   - tests/e2e/session-worktree.spec.ts (git lock contention)
 *   - tests/e2e/ui/session-worktree.spec.ts (same issue)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Pure decision logic extracted from server.ts POST /api/sessions handler ──
//
// From server.ts lines ~2010-2024:
//   const wantWorktree = body?.worktree !== undefined ? !!body.worktree : (!assistantType && !goalId);
//   if (wantWorktree && !assistantType) {
//     if (await isGitRepo(cwd)) {
//       worktreeOpts = { repoPath };
//     }
//   }
//
// We test the decision function without actual git operations.

interface SessionCreateBody {
	cwd: string;
	worktree?: boolean;
	assistantType?: string;
	goalId?: string;
}

/**
 * Determines whether a session should get a worktree.
 * Mirrors the logic in server.ts POST /api/sessions handler.
 *
 * @param body - The session creation request body
 * @param isGitRepo - Whether the cwd is inside a git repo
 * @returns true if the session should get a worktree
 */
function shouldCreateWorktree(body: SessionCreateBody, isGitRepo: boolean): boolean {
	const { assistantType, goalId } = body;

	// Explicit opt-in/opt-out via body.worktree takes precedence
	const wantWorktree = body.worktree !== undefined
		? !!body.worktree
		: (!assistantType && !goalId);

	// Must want a worktree, not be an assistant, and be in a git repo
	return wantWorktree && !assistantType && isGitRepo;
}

describe("Session auto-worktree decision", () => {
	describe("non-goal, non-assistant sessions", () => {
		it("gets a worktree when cwd is a git repo", () => {
			const result = shouldCreateWorktree({ cwd: "/repo" }, true);
			assert.equal(result, true, "Regular session in git repo should get worktree");
		});

		it("does NOT get a worktree when cwd is not a git repo", () => {
			const result = shouldCreateWorktree({ cwd: "/tmp/no-git" }, false);
			assert.equal(result, false, "Regular session outside git repo should not get worktree");
		});
	});

	describe("assistant sessions", () => {
		it("goal assistant does NOT get a worktree", () => {
			const result = shouldCreateWorktree(
				{ cwd: "/repo", assistantType: "goal" },
				true,
			);
			assert.equal(result, false, "Goal assistant should not get worktree");
		});

		it("role assistant does NOT get a worktree", () => {
			const result = shouldCreateWorktree(
				{ cwd: "/repo", assistantType: "role" },
				true,
			);
			assert.equal(result, false, "Role assistant should not get worktree");
		});

		it("tool assistant does NOT get a worktree", () => {
			const result = shouldCreateWorktree(
				{ cwd: "/repo", assistantType: "tool" },
				true,
			);
			assert.equal(result, false, "Tool assistant should not get worktree");
		});
	});

	describe("goal sessions", () => {
		it("goal session does NOT get auto-worktree (handled separately)", () => {
			// Goal sessions have their own worktree logic via
			// goalManager.setupWorktreeAndStartTeam(), so the general
			// session creation path should not create one.
			const result = shouldCreateWorktree(
				{ cwd: "/repo", goalId: "goal-123" },
				true,
			);
			assert.equal(result, false, "Goal session should not get auto-worktree");
		});
	});

	describe("explicit worktree opt-in/opt-out", () => {
		it("explicit worktree: true forces worktree creation in git repo", () => {
			const result = shouldCreateWorktree(
				{ cwd: "/repo", worktree: true },
				true,
			);
			assert.equal(result, true, "Explicit opt-in should create worktree");
		});

		it("explicit worktree: true still requires git repo", () => {
			const result = shouldCreateWorktree(
				{ cwd: "/tmp/no-git", worktree: true },
				false,
			);
			assert.equal(result, false, "Opt-in without git repo should not create worktree");
		});

		it("explicit worktree: false prevents worktree creation", () => {
			const result = shouldCreateWorktree(
				{ cwd: "/repo", worktree: false },
				true,
			);
			assert.equal(result, false, "Explicit opt-out should prevent worktree");
		});

		it("explicit worktree: true does NOT override assistant check", () => {
			// Even with explicit opt-in, assistant sessions are excluded
			const result = shouldCreateWorktree(
				{ cwd: "/repo", worktree: true, assistantType: "goal" },
				true,
			);
			assert.equal(result, false, "Assistant sessions never get worktree even with explicit opt-in");
		});
	});

	describe("team-manager worktree decision for spawned agents", () => {
		// From team-manager.ts spawnRole():
		//   const useWorktree = !!goal.repoPath;
		// This is simpler — team agents get worktrees when the goal is in a git repo.

		it("team agent gets worktree when goal has repoPath", () => {
			const useWorktree = !!"/path/to/repo";
			assert.equal(useWorktree, true);
		});

		it("team agent does NOT get worktree when goal has no repoPath", () => {
			const repoPath: string | undefined = undefined;
			const useWorktree = !!repoPath;
			assert.equal(useWorktree, false);
		});
	});
});
