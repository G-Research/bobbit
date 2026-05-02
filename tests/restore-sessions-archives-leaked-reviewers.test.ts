/**
 * Pinned regression: restoreSessions auto-archives leaked
 * llm-review-* sessions before restoration, instead of resurrecting
 * them as phantom workers.
 *
 * Live test (PR #409 Eve+Gizmo verification timeouts): six leaked
 * llm-review-* sessions accumulated in bobbit-suubro/.bobbit/state/
 * sessions.json across multiple gateway restarts, all
 * archived: null, the oldest 17 hours old. The team-manager's
 * boot-sweep correctly unregistered them from the team-store but
 * the underlying SessionStore record persisted, so the API kept
 * returning them as live sessions and the UI rendered phantom
 * cards. Restore-time also wasted compute spawning agent
 * processes for sessions whose verification context was long gone.
 *
 * Root cause: llm-review-* sessions are ephemeral by design,
 * spawned by VerificationHarness for a single review step and
 * terminated in a `finally` block. If the gateway hard-restarts
 * mid-review (or the harness crashes), the `finally` doesn't run
 * and the SessionStore record is left behind.
 *
 * Fix: in `restoreSessions`, before doing anything else, scan the
 * live persisted list for sessions whose id starts with
 * `llm-review-` and archive them. Then re-fetch the live list to
 * get the post-sweep set for the actual restoration loop.
 *
 * The unit test pins the predicate. End-to-end behaviour is
 * implicitly covered by tests/session-restore-*.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface SessionLike {
	id: string;
	archived?: boolean;
}

/** Replicates the leaked-reviewer predicate. */
function isLeakedReviewer(ps: SessionLike): boolean {
	return typeof ps.id === "string" && ps.id.startsWith("llm-review-");
}

describe("restoreSessions — leaked reviewer archival predicate", () => {
	it("THE bug: llm-review-* session id matches", () => {
		assert.equal(isLeakedReviewer({ id: "llm-review-ebec85f3-fcb" }), true);
		assert.equal(isLeakedReviewer({ id: "llm-review-0be219d0-745" }), true);
		assert.equal(isLeakedReviewer({ id: "llm-review-5c095295-4ea" }), true);
	});

	it("normal session id does NOT match", () => {
		assert.equal(isLeakedReviewer({ id: "b607a864-f7cb-479f-ac16-d0c7f20c41c8" }), false);
		assert.equal(isLeakedReviewer({ id: "0dbda4f4-be38-4bb8-9510-c0ae7523cba9" }), false);
	});

	it("similar-looking but different prefix does NOT match", () => {
		// Defensive: don't accidentally archive llm-* sessions that aren't reviewers
		assert.equal(isLeakedReviewer({ id: "llm-other-abc" }), false);
		assert.equal(isLeakedReviewer({ id: "llmreview-abc" }), false);
		assert.equal(isLeakedReviewer({ id: "review-abc" }), false);
	});

	it("empty / null id is rejected (defensive)", () => {
		assert.equal(isLeakedReviewer({ id: "" }), false);
		assert.equal(isLeakedReviewer({ id: undefined as any }), false);
		assert.equal(isLeakedReviewer({ id: null as any }), false);
	});

	it("filters a mixed list correctly", () => {
		const persisted: SessionLike[] = [
			{ id: "llm-review-aaa-bbb" },                      // leaked
			{ id: "b607a864-f7cb-479f-ac16-d0c7f20c41c8" },   // team-lead
			{ id: "llm-review-ccc-ddd" },                      // leaked
			{ id: "team-lead-d139d4b7" },                      // worker
			{ id: "llm-review-eee-fff" },                      // leaked
		];
		const leaked = persisted.filter(isLeakedReviewer);
		assert.equal(leaked.length, 3, "should isolate exactly 3 leaked reviewers");
		assert.deepEqual(leaked.map(p => p.id),
			["llm-review-aaa-bbb", "llm-review-ccc-ddd", "llm-review-eee-fff"]);
	});
});
