/**
 * Pinned regression: when a team-lead calls `goal_merge_child` (the MCP
 * tool, which routes to `POST /api/goals/:parentId/integrate-child/:childId`),
 * a successful merge must auto-archive the child — same pattern as the
 * verification-harness's runSubgoalStep post-merge cleanup (c95f8f60).
 *
 * Pre-fix: the route called `goalMgr.mergeChild` and surfaced the
 * commit SHA in the response, but never archived the child. Result:
 * children manually merged via the MCP tool stayed `state: complete`
 * but `archived: false`, cluttering the dashboard and pinning disk +
 * memory. Live test (PR #409): a3236363 + 0e69c650 hung in this state.
 *
 * Fix: after a successful merge in the integrate-child route, fire-and-
 * forget `teamManager.teardownTeam(childId)` followed by
 * `goalMgr.archiveGoal(childId)`. Best-effort — doesn't block the route
 * response. Idempotent on already-archived children.
 *
 * The unit test below pins the pure decision predicate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface MergeResult {
	merged: boolean;
	conflict?: boolean;
	commitSha?: string;
	output?: string;
}

interface ChildLike {
	archived?: boolean;
}

/**
 * Replicates the production decision rule. Pure / no I/O.
 * Returns true iff the integrate-child route should auto-archive the
 * child after the merge attempt.
 */
function shouldAutoArchiveAfterMerge(merge: MergeResult, child: ChildLike): boolean {
	if (!merge.merged) return false;
	if (child.archived) return false;
	return true;
}

describe("integrate-child auto-archive predicate", () => {
	it("auto-archives on a clean merge of a non-archived child", () => {
		assert.equal(
			shouldAutoArchiveAfterMerge({ merged: true, commitSha: "abc1234" }, { archived: false }),
			true,
		);
	});

	it("does NOT auto-archive on a merge conflict", () => {
		// Merge conflict means the work isn't actually integrated; the
		// child must stay live so the team-lead can fix and retry.
		// Symmetric to the runSubgoalStep guard at c95f8f60.
		assert.equal(
			shouldAutoArchiveAfterMerge(
				{ merged: false, conflict: true, output: "CONFLICT" },
				{ archived: false },
			),
			false,
		);
	});

	it("does NOT auto-archive on a non-conflict failed merge", () => {
		// e.g. mergeChild returned merged:false for some other reason
		assert.equal(
			shouldAutoArchiveAfterMerge(
				{ merged: false, output: "some other failure" },
				{ archived: false },
			),
			false,
		);
	});

	it("is idempotent on an already-archived child (no-op)", () => {
		// The child was archived on a previous merge attempt (or by
		// manual goal_archive_child). Don't re-archive — wasted work.
		assert.equal(
			shouldAutoArchiveAfterMerge({ merged: true, commitSha: "abc1234" }, { archived: true }),
			false,
		);
	});

	it("handles missing commitSha (defensive: still archives)", () => {
		// commitSha may be omitted by some merge paths (e.g. "already up
		// to date" no-op merges). The merged-true signal is what counts.
		assert.equal(
			shouldAutoArchiveAfterMerge({ merged: true }, { archived: false }),
			true,
		);
	});
});
