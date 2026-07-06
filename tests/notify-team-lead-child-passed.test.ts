/**
 * Pure helper tests for `buildParentReadyNotification` and
 * `buildParentCompletionNotification` from notify-team-lead-child-passed.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	buildParentReadyNotification,
	buildParentCompletionNotification,
} from "../src/server/agent/notify-team-lead-child-passed.ts";

describe("buildParentReadyNotification", () => {
	it("returns null for non-ready-to-merge gate", () => {
		const child = { id: "abc", parentGoalId: "parent-1" };
		assert.equal(buildParentReadyNotification(child, "implementation", "passed"), null);
	});

	it("returns null when child has no parentGoalId", () => {
		assert.equal(buildParentReadyNotification({ id: "abc" }, "ready-to-merge", "passed"), null);
	});

	it("returns null when child is undefined", () => {
		assert.equal(buildParentReadyNotification(undefined, "ready-to-merge", "passed"), null);
	});

	it("returns passed notification for ready-to-merge/passed with goal_merge_child mention", () => {
		const child = { id: "abc12345", title: "Fix bug", parentGoalId: "parent-1" };
		const result = buildParentReadyNotification(child, "ready-to-merge", "passed");
		assert.ok(result);
		assert.equal(result.parentGoalId, "parent-1");
		assert.match(result.message, /Fix bug/);
		assert.match(result.message, /goal_merge_child/);
	});

	it("returns failed notification for ready-to-merge/failed", () => {
		const child = { id: "abc12345", title: "Fix bug", parentGoalId: "parent-1" };
		const result = buildParentReadyNotification(child, "ready-to-merge", "failed");
		assert.ok(result);
		assert.match(result.message, /FAILED/i);
	});

	it("returns null for status other than passed/failed", () => {
		const child = { id: "abc", parentGoalId: "parent-1" };
		assert.equal(buildParentReadyNotification(child, "ready-to-merge", "running"), null);
	});
});

describe("buildParentCompletionNotification", () => {
	it("returns null when child is undefined", () => {
		assert.equal(buildParentCompletionNotification(undefined), null);
	});

	it("returns null when child has no parentGoalId (root goal)", () => {
		assert.equal(buildParentCompletionNotification({ id: "abc" }), null);
	});

	it("returns notification with parentGoalId and goal_merge_child mention", () => {
		const child = { id: "abc12345", title: "My Feature", parentGoalId: "parent-1" };
		const result = buildParentCompletionNotification(child);
		assert.ok(result);
		assert.equal(result.parentGoalId, "parent-1");
		assert.match(result.message, /My Feature/);
		assert.match(result.message, /goal_merge_child/);
	});

	it("uses 8-char id prefix as display when title is empty", () => {
		const child = { id: "deadbeef1234", parentGoalId: "parent-2" };
		const result = buildParentCompletionNotification(child);
		assert.ok(result);
		assert.match(result.message, /deadbeef/);
	});

	it("uses 8-char id prefix as display when title is whitespace-only", () => {
		const child = { id: "cafebabe9999", title: "   ", parentGoalId: "parent-3" };
		const result = buildParentCompletionNotification(child);
		assert.ok(result);
		assert.match(result.message, /cafebabe/);
	});
});
