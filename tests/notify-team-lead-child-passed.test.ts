/**
 * Pure unit tests for buildParentReadyNotification — pins the contract
 * the verification harness uses to wake up a parent goal's team-lead
 * after one of its children finishes (`ready-to-merge` passes).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildParentReadyNotification,
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

describe("buildParentReadyNotification — null cases (no notification)", () => {
	it("returns null for non-passed status", () => {
		assert.equal(
			buildParentReadyNotification(
				child({ id: "c", title: "x", parentGoalId: "p" }),
				"ready-to-merge",
				"failed",
			),
			null,
		);
		assert.equal(
			buildParentReadyNotification(
				child({ id: "c", title: "x", parentGoalId: "p" }),
				"ready-to-merge",
				"pending",
			),
			null,
		);
	});

	it("returns null for non-ready-to-merge gates (intra-child gates don't notify)", () => {
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
