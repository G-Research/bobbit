/**
 * Pinned regression: runSubgoalStep recovers from the degenerate
 * "complete but workflow-less" child state by merging the child's
 * branch directly + archiving, instead of polling its (non-existent)
 * ready-to-merge gate forever.
 *
 * Live test (PR #409 v0.2-embeddings, context-fencing leaf
 * 48c314fd-d853-4935-ac5c-da2220e8b9b9): the per-project
 * GoalManager was constructed without a workflowStore (bug fixed
 * at a1767a89), so `createGoal({ workflowId: "feature" })` silently
 * produced a workflow-less goal. The coder Keanu Threads ran his
 * work, his task transitioned to complete, and the goal record was
 * stamped state=complete. But there were no gates, so:
 *   - ready-to-merge: never existed
 *   - parent's runSubgoalStep wait loop: polled forever
 *   - team-lead Meg Awatt: idle, no signal could ever bubble up
 *
 * The companion fix at a1767a89 prevents this happening for new
 * spawns. THIS commit's recovery branch unsticks pre-existing
 * leaves (and any future regression that slips past the guard).
 *
 * Recovery predicate: `child.state === "complete" && !child.archived
 * && !child.workflow`. When all three hold, runSubgoalStep skips
 * the wait loop and runs the merge+archive directly. If merge
 * succeeds: step passes. If conflict: step fails with a directive
 * pointing the team-lead at manual recovery (git merge + archive).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface ChildGoalLike {
	id?: string;
	state?: string;
	archived?: boolean;
	workflow?: { gates?: unknown[] } | null;
	branch?: string;
}

/** Replicates the recovery predicate. */
function isDegenerateWorkflowLessComplete(child: ChildGoalLike | null | undefined): boolean {
	if (!child) return false;
	if (child.archived) return false;
	if (child.state !== "complete") return false;
	if (child.workflow) return false; // truthy check — null, undefined, or empty all qualify
	return true;
}

describe("runSubgoalStep — degenerate workflow-less complete recovery predicate", () => {
	it("THE bug pattern: state=complete, archived=null, workflow=null -> recover", () => {
		// Exact 48c314fd state from the live bug report.
		assert.equal(isDegenerateWorkflowLessComplete({
			id: "48c314fd",
			state: "complete",
			archived: false,
			workflow: null,
			branch: "goal/context-fe-48c314fd",
		}), true);
	});

	it("workflow undefined (alternative serialisation) -> recover", () => {
		assert.equal(isDegenerateWorkflowLessComplete({
			state: "complete",
			archived: false,
			// workflow undefined
		}), true);
	});

	it("normal happy-path complete child WITH workflow -> normal flow (don't recover)", () => {
		// The legitimate state for a child that ran its workflow
		// through ready-to-merge. The standard wait loop / archived-
		// short-circuit handles this.
		assert.equal(isDegenerateWorkflowLessComplete({
			state: "complete",
			archived: false,
			workflow: { gates: [{ id: "ready-to-merge" }] },
		}), false);
	});

	it("already-archived complete child -> normal short-circuit (don't recover)", () => {
		// Distinct fast-path at line ~2629 handles this case.
		assert.equal(isDegenerateWorkflowLessComplete({
			state: "complete",
			archived: true,
			workflow: null,
		}), false);
	});

	it("in-progress workflow-less child -> wait (don't recover prematurely)", () => {
		// A workflow-less child still in flight (e.g. just spawned,
		// task pending) shouldn't be archived prematurely.
		assert.equal(isDegenerateWorkflowLessComplete({
			state: "in-progress",
			archived: false,
			workflow: null,
		}), false);
	});

	it("shelved workflow-less child -> wait (separate cancellation handler)", () => {
		// Shelved is the cancel-pending state; the wait loop's shelved-
		// check handles it.
		assert.equal(isDegenerateWorkflowLessComplete({
			state: "shelved",
			archived: false,
			workflow: null,
		}), false);
	});

	it("null child -> don't recover (separate disappeared-child error path)", () => {
		assert.equal(isDegenerateWorkflowLessComplete(null), false);
		assert.equal(isDegenerateWorkflowLessComplete(undefined), false);
	});

	it("workflow with empty gates array still counts as 'has workflow' (don't recover)", () => {
		// Defensive: even if a workflow snapshot exists with zero gates
		// (legitimate edge case for some workflows), don't treat it
		// as degenerate. The standard flow will pass the empty step
		// list trivially.
		assert.equal(isDegenerateWorkflowLessComplete({
			state: "complete",
			archived: false,
			workflow: { gates: [] },
		}), false);
	});
});
