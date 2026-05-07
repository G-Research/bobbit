/**
 * Regression test for the child→parent ready-to-merge notification dispatch.
 *
 * `tests/notify-team-lead-child-passed.test.ts` already covers the pure
 * helper (`buildParentReadyNotification`). This test pins the *integration*
 * pattern — the verification harness's `notifyTeamLead` dispatch loop must
 * forward the parent's nudge to `notifyTeamLeadFn` when a child's
 * `ready-to-merge` gate resolves to passed OR failed.
 *
 * We mirror the harness's dispatch shape inline (line ~1175 of
 * `verification-harness.ts`) so the test pins the contract without booting
 * the full harness — keeping it pure and fast.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildParentReadyNotification,
	type ChildGoalForParentNotify,
} from "../src/server/agent/notify-team-lead-child-passed.ts";

/**
 * Mirror of `VerificationHarness.notifyTeamLead`'s parent-propagation block.
 * Pure: no I/O, no class state.
 */
function dispatch(
	notifyTeamLeadFn: (goalId: string, message: string) => void,
	child: ChildGoalForParentNotify | undefined,
	gateId: string,
	status: string,
): void {
	const parentNotify = buildParentReadyNotification(child, gateId, status);
	if (parentNotify) {
		notifyTeamLeadFn(parentNotify.parentGoalId, parentNotify.message);
	}
}

describe("verification-harness child-RTM → parent-team-lead dispatch", () => {
	it("forwards to parent on ready-to-merge passed", () => {
		const calls: Array<{ goalId: string; message: string }> = [];
		const fn = (goalId: string, message: string) => calls.push({ goalId, message });

		dispatch(
			fn,
			{ id: "child-1", title: "Child Title", parentGoalId: "parent-1" },
			"ready-to-merge",
			"passed",
		);

		assert.equal(calls.length, 1, "dispatch fires exactly once");
		assert.equal(calls[0].goalId, "parent-1", "parent's goalId is the recipient");
		assert.match(calls[0].message, /Child Title/);
		assert.match(calls[0].message, /goal_merge_child/);
	});

	it("forwards to parent on ready-to-merge failed (different message)", () => {
		const calls: Array<{ goalId: string; message: string }> = [];
		const fn = (goalId: string, message: string) => calls.push({ goalId, message });

		dispatch(
			fn,
			{ id: "child-2", title: "Failed Child", parentGoalId: "parent-1" },
			"ready-to-merge",
			"failed",
		);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].goalId, "parent-1");
		assert.match(calls[0].message, /Failed Child/);
		assert.match(calls[0].message, /FAILED at ready-to-merge/);
		// Failed branch should NOT advise goal_merge_child.
		assert.doesNotMatch(calls[0].message, /goal_merge_child/);
	});

	it("does NOT forward for non-RTM gate transitions", () => {
		const calls: Array<{ goalId: string; message: string }> = [];
		const fn = (goalId: string, message: string) => calls.push({ goalId, message });

		dispatch(fn, { id: "c", title: "T", parentGoalId: "p" }, "design-doc", "passed");
		dispatch(fn, { id: "c", title: "T", parentGoalId: "p" }, "implementation", "failed");
		dispatch(fn, { id: "c", title: "T", parentGoalId: "p" }, "qa", "passed");

		assert.equal(calls.length, 0, "intra-child gates do not propagate");
	});

	it("does NOT forward for pending / aborted RTM transitions", () => {
		const calls: Array<{ goalId: string; message: string }> = [];
		const fn = (goalId: string, message: string) => calls.push({ goalId, message });

		dispatch(fn, { id: "c", title: "T", parentGoalId: "p" }, "ready-to-merge", "pending");
		dispatch(fn, { id: "c", title: "T", parentGoalId: "p" }, "ready-to-merge", "aborted");

		assert.equal(calls.length, 0, "non-terminal RTM transitions do not propagate");
	});

	it("does NOT forward for root goals (no parentGoalId)", () => {
		const calls: Array<{ goalId: string; message: string }> = [];
		const fn = (goalId: string, message: string) => calls.push({ goalId, message });

		dispatch(fn, { id: "root", title: "Root", parentGoalId: undefined }, "ready-to-merge", "passed");
		dispatch(fn, { id: "root", title: "Root", parentGoalId: undefined }, "ready-to-merge", "failed");

		assert.equal(calls.length, 0, "root goals have no parent to wake up");
	});

	it("does NOT forward when child lookup misses (defensive)", () => {
		const calls: Array<{ goalId: string; message: string }> = [];
		const fn = (goalId: string, message: string) => calls.push({ goalId, message });

		dispatch(fn, undefined, "ready-to-merge", "passed");
		dispatch(fn, undefined, "ready-to-merge", "failed");

		assert.equal(calls.length, 0);
	});
});
