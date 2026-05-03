/**
 * Pure unit tests for buildParentReadyNotification — pins the contract
 * the verification harness uses to wake up a parent goal's team-lead
 * after one of its children finishes (`ready-to-merge` passes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildParentReadyNotification,
	buildParentPausedNotification,
	type ChildGoalForParentNotify,
} from "../src/server/agent/notify-team-lead-child-passed.ts";

const child = (over: Partial<ChildGoalForParentNotify> & { id: string }): ChildGoalForParentNotify => ({
	title: undefined,
	parentGoalId: undefined,
	...over,
});

describe("buildParentReadyNotification — passes", () => {
	it("returns a notification when status=passed AND gateId=ready-to-merge AND child has parentGoalId", () => {
		const out = buildParentReadyNotification(
			child({ id: "child-1", title: "Audit Bobbit harness", parentGoalId: "parent-1" }),
			"ready-to-merge",
			"passed",
		);
		assert.ok(out, "expected non-null notification");
		assert.equal(out!.parentGoalId, "parent-1");
		assert.match(out!.message, /Audit Bobbit harness/);
		assert.match(out!.message, /passed ready-to-merge/);
		assert.match(out!.message, /goal_merge_child/);
		assert.match(out!.message, /goal_archive_child/);
	});

	it("falls back to id-prefix when title is empty", () => {
		const out = buildParentReadyNotification(
			child({ id: "abc12345-rest", title: "", parentGoalId: "p" }),
			"ready-to-merge",
			"passed",
		);
		assert.ok(out);
		assert.match(out!.message, /"abc12345"/);
	});

	it("falls back to id-prefix when title is whitespace-only", () => {
		const out = buildParentReadyNotification(
			child({ id: "ffeeddcc", title: "   ", parentGoalId: "p" }),
			"ready-to-merge",
			"passed",
		);
		assert.ok(out);
		assert.match(out!.message, /"ffeeddcc"/);
	});

	it("falls back to id-prefix when title is undefined", () => {
		const out = buildParentReadyNotification(
			child({ id: "11223344", parentGoalId: "p" }),
			"ready-to-merge",
			"passed",
		);
		assert.ok(out);
		assert.match(out!.message, /"11223344"/);
	});
});

describe("buildParentReadyNotification — failed cases (also notify)", () => {
	it("returns a notification when status=failed AND gateId=ready-to-merge AND child has parentGoalId", () => {
		const out = buildParentReadyNotification(
			child({ id: "c1", title: "Audit X", parentGoalId: "p1" }),
			"ready-to-merge",
			"failed",
		);
		assert.ok(out);
		assert.equal(out!.parentGoalId, "p1");
		assert.match(out!.message, /Audit X/);
		assert.match(out!.message, /FAILED at ready-to-merge/);
		assert.match(out!.message, /goal_archive_child/);
	});

	it("failed message differs from passed message", () => {
		const passed = buildParentReadyNotification(
			child({ id: "c", title: "T", parentGoalId: "p" }),
			"ready-to-merge",
			"passed",
		)!;
		const failed = buildParentReadyNotification(
			child({ id: "c", title: "T", parentGoalId: "p" }),
			"ready-to-merge",
			"failed",
		)!;
		assert.notEqual(passed.message, failed.message);
		assert.match(passed.message, /goal_merge_child/);
		assert.doesNotMatch(failed.message, /goal_merge_child/);
	});
});

describe("buildParentReadyNotification — null cases (no notification)", () => {
	it("returns null for status pending / aborted / unknown", () => {
		assert.equal(
			buildParentReadyNotification(
				child({ id: "c", title: "x", parentGoalId: "p" }),
				"ready-to-merge",
				"pending",
			),
			null,
		);
		assert.equal(
			buildParentReadyNotification(
				child({ id: "c", title: "x", parentGoalId: "p" }),
				"ready-to-merge",
				"aborted",
			),
			null,
		);
	});

	it("returns null for non-ready-to-merge gates (intra-child gates don't notify, even on failure)", () => {
		// Intra-child gate passes/fails are noise for the parent — only the
		// terminal ready-to-merge gate is propagation-worthy.
		assert.equal(
			buildParentReadyNotification(
				child({ id: "c", title: "x", parentGoalId: "p" }),
				"design-doc",
				"passed",
			),
			null,
		);
		assert.equal(
			buildParentReadyNotification(
				child({ id: "c", title: "x", parentGoalId: "p" }),
				"implementation",
				"failed",
			),
			null,
		);
		assert.equal(
			buildParentReadyNotification(
				child({ id: "c", title: "x", parentGoalId: "p" }),
				"qa",
				"passed",
			),
			null,
		);
	});

	it("returns null for root goals (no parentGoalId)", () => {
		assert.equal(
			buildParentReadyNotification(
				child({ id: "root", title: "Root goal", parentGoalId: undefined }),
				"ready-to-merge",
				"passed",
			),
			null,
		);
	});

	it("returns null when child is undefined (defensive lookup miss)", () => {
		assert.equal(
			buildParentReadyNotification(undefined, "ready-to-merge", "passed"),
			null,
		);
	});
});

describe("buildParentPausedNotification — auto-pause propagation", () => {
	it("returns notification with the right parentGoalId and reason text", () => {
		const out = buildParentPausedNotification(
			child({ id: "c1", title: "Stuck Subgoal", parentGoalId: "p1" }),
			"replan-overflow",
		);
		assert.ok(out);
		assert.equal(out!.parentGoalId, "p1");
		assert.match(out!.message, /Stuck Subgoal/);
		assert.match(out!.message, /replan count/);
		assert.match(out!.message, /goal_resume/);
		assert.match(out!.message, /goal_archive_child/);
	});

	it("each reason produces a distinct message", () => {
		const c = child({ id: "c", title: "T", parentGoalId: "p" });
		const replan = buildParentPausedNotification(c, "replan-overflow")!;
		const restructure = buildParentPausedNotification(c, "restructure-requires-pause")!;
		const manual = buildParentPausedNotification(c, "manual")!;
		const other = buildParentPausedNotification(c, "other")!;
		const messages = [replan.message, restructure.message, manual.message, other.message];
		assert.equal(new Set(messages).size, 4, "all four reasons produce distinct messages");
	});

	it("falls back to id-prefix when title is missing", () => {
		const out = buildParentPausedNotification(
			child({ id: "deadbeef-rest", parentGoalId: "p" }),
			"replan-overflow",
		);
		assert.match(out!.message, /"deadbeef"/);
	});

	it("returns null for root goals (no parentGoalId)", () => {
		assert.equal(
			buildParentPausedNotification(child({ id: "root", title: "Root" }), "manual"),
			null,
		);
	});

	it("returns null when child is undefined", () => {
		assert.equal(buildParentPausedNotification(undefined, "manual"), null);
	});
});
