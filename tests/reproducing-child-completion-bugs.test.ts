/**
 * Reproducing tests for the child goal completion notification bugs.
 * See goal spec: "Fix child goal completion notifications and merge rendering"
 *
 * These tests FAIL before the fix and PASS after it.
 *
 * Bug 1: `buildParentCompletionNotification` is not exported from
 *         notify-team-lead-child-passed.ts — child goal completion (team_complete)
 *         never notifies the parent team lead.
 *
 * Bug 2: The `goal_merge_child` tool has no `force` parameter and uses `api()`
 *         which throws on 409, discarding structured `{ conflict, rtmFailed }`
 *         bodies that the renderer needs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — deliberately testing the export surface
import * as notifyMod from "../src/server/agent/notify-team-lead-child-passed.ts";

describe("Bug 1: buildParentCompletionNotification missing", () => {
	it("should export buildParentCompletionNotification from notify-team-lead-child-passed", () => {
		// Fails before fix: function is not exported
		assert.equal(
			typeof notifyMod.buildParentCompletionNotification,
			"function",
			"buildParentCompletionNotification must be exported — child completion must notify parent",
		);
	});

	it("returns null for root goals (no parentGoalId)", () => {
		const fn = notifyMod.buildParentCompletionNotification as (c: unknown) => unknown;
		assert.equal(fn({ id: "abc" }), null, "root goals must not notify anyone");
	});

	it("returns null for undefined child", () => {
		const fn = notifyMod.buildParentCompletionNotification as (c: unknown) => unknown;
		assert.equal(fn(undefined), null);
	});

	it("returns a notification with parentGoalId and goal_merge_child mention", () => {
		const fn = notifyMod.buildParentCompletionNotification as (
			c: unknown,
		) => { parentGoalId: string; message: string } | null;
		const result = fn({ id: "abc12345", title: "My Feature", parentGoalId: "parent-1" });
		assert.ok(result, "should return a notification for child goals");
		assert.equal(result.parentGoalId, "parent-1");
		assert.match(result.message, /My Feature/, "message should include child title");
		assert.match(result.message, /goal_merge_child/, "message should mention goal_merge_child");
	});

	it("uses id prefix as display when title is empty", () => {
		const fn = notifyMod.buildParentCompletionNotification as (
			c: unknown,
		) => { parentGoalId: string; message: string } | null;
		const result = fn({ id: "deadbeef1234", parentGoalId: "parent-2" });
		assert.ok(result);
		assert.match(result.message, /deadbeef/);
	});
});

describe("Bug 2: goal_merge_child extension uses apiCallDetailed for 409 body", () => {
	it("extension.ts imports apiCallDetailed from _shared/gateway", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync("defaults/tools/children/extension.ts", "utf-8");
		// Fails before fix: only apiCall is imported
		assert.ok(
			/apiCallDetailed/.test(src),
			"extension.ts must import and use apiCallDetailed so 409 bodies are returned to the renderer",
		);
	});

	it("extension.ts goal_merge_child has a force parameter", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync("defaults/tools/children/extension.ts", "utf-8");
		// Fails before fix: no force param
		assert.ok(
			/force/.test(src),
			"goal_merge_child must expose a force parameter to bypass the ready-to-merge gate check",
		);
	});
});
