/**
 * Pinned regression: when a child goal's `ready-to-merge` gate passes,
 * the parent's verification harness must perform the local merge
 * EAGERLY \u2014 not wait for the parent's execution-gate verifyGateSignal
 * loop to come around.
 *
 * Live test (PR #409 \u2014 team-lead-317cdb83): the parent's execution
 * gate's verifyGateSignal runs ONCE per signal. Once any subgoal step
 * fails (or even completes), the loop terminates. If a child's
 * ready-to-merge passes AFTER that single run, nothing was watching,
 * so the merge never fired \u2014 the team-lead had to manually call
 * goal_merge_child for every Phase 2 child.
 *
 * Fix: in `notifyTeamLead`'s parent-bubble path, fire-and-forget the
 * merge + auto-archive when the bubble is `gateId === "ready-to-merge"
 * && status === "passed"`. Skip if the child is already archived
 * (idempotency).
 *
 * The unit test below pins the pure decision predicate that
 * production code mirrors.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface ChildLike {
	id: string;
	parentGoalId?: string;
	archived?: boolean;
}

/**
 * Replicates the production decision rule. Pure / no I/O.
 * Returns true iff the harness should fire the eager-merge IIFE for
 * this notifyTeamLead bubble call.
 */
function shouldEagerMerge(opts: {
	gateId: string;
	status: "passed" | "failed";
	child: ChildLike | undefined;
	parentExists: boolean;
	pcmAvailable: boolean;
}): boolean {
	if (opts.gateId !== "ready-to-merge") return false;
	if (opts.status !== "passed") return false;
	if (!opts.pcmAvailable) return false;
	if (!opts.parentExists) return false;
	if (!opts.child) return false;
	if (!opts.child.parentGoalId) return false; // top-level goal \u2014 no parent
	if (opts.child.archived) return false; // already merged + archived
	return true;
}

const baseChild: ChildLike = { id: "c1", parentGoalId: "p1", archived: false };
const baseOpts = {
	gateId: "ready-to-merge",
	status: "passed" as const,
	child: baseChild,
	parentExists: true,
	pcmAvailable: true,
};

describe("eager-merge-on-bubble predicate", () => {
	it("fires for the canonical case (ready-to-merge passed on a non-archived child)", () => {
		assert.equal(shouldEagerMerge(baseOpts), true);
	});

	it("does NOT fire for a non-ready-to-merge gate (e.g. design-doc)", () => {
		// design-doc passing on a child shouldn't trigger a merge \u2014 only
		// ready-to-merge does.
		assert.equal(shouldEagerMerge({ ...baseOpts, gateId: "design-doc" }), false);
	});

	it("does NOT fire for goal-plan (which is also notable but doesn't imply 'ready to merge')", () => {
		assert.equal(shouldEagerMerge({ ...baseOpts, gateId: "goal-plan" }), false);
	});

	it("does NOT fire when status is failed", () => {
		// A failed ready-to-merge means the child's not actually ready;
		// don't try to merge.
		assert.equal(shouldEagerMerge({ ...baseOpts, status: "failed" }), false);
	});

	it("does NOT fire when the child is already archived (idempotency \u2014 already merged)", () => {
		// Auto-archive (c95f8f60) only fires AFTER a clean merge, so an
		// archived child is one whose merge has already been performed.
		// Re-firing would be a double-merge.
		assert.equal(
			shouldEagerMerge({ ...baseOpts, child: { ...baseChild, archived: true } }),
			false,
		);
	});

	it("does NOT fire for a top-level goal (no parent to merge into)", () => {
		// `parentGoalId` is the structural marker for a child goal; the
		// root goal has no parent.
		assert.equal(
			shouldEagerMerge({ ...baseOpts, child: { ...baseChild, parentGoalId: undefined } }),
			false,
		);
	});

	it("does NOT fire when the project context manager isn't available (test fixtures)", () => {
		// Defensive: minimal-mock harness without PCM should not crash.
		assert.equal(shouldEagerMerge({ ...baseOpts, pcmAvailable: false }), false);
	});

	it("does NOT fire when the parent goal record can't be loaded", () => {
		assert.equal(shouldEagerMerge({ ...baseOpts, parentExists: false }), false);
	});

	it("does NOT fire when no child record is provided", () => {
		assert.equal(shouldEagerMerge({ ...baseOpts, child: undefined }), false);
	});
});
