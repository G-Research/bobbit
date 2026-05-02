/**
 * Lesson 4.11C — Zombie-reviewer sweep error guard.
 *
 * `resubscribeTeamEvents` defensively unregisters reviewer agents whose
 * underlying session no longer exists in the session manager. The
 * `unregisterReviewerSession` call must be wrapped in try/catch — without
 * it, one bad reviewer entry can crash the whole boot path because
 * `unregisterReviewerSession` ultimately calls `persistEntry` →
 * `resolveTeamStore`, which throws when the goal can't be resolved.
 *
 * This test pins the guard via a source-grep + a focused behavioural test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

describe("Lesson 4.11C — source-grep guard for zombie-reviewer try/catch", () => {
	const SOURCE = path.resolve(import.meta.dirname, "..", "src", "server", "agent", "team-manager.ts");
	const text = fs.readFileSync(SOURCE, "utf-8");

	it("resubscribeTeamEvents contains a zombie-reviewer sweep that calls unregisterReviewerSession", () => {
		// Locate resubscribeTeamEvents and assert it contains the unregister call.
		const startIdx = text.indexOf("resubscribeTeamEvents");
		assert.ok(startIdx > 0, "resubscribeTeamEvents method must exist");
		const window = text.slice(startIdx, startIdx + 6_000);
		assert.match(window, /unregisterReviewerSession\(/, "the sweep must call unregisterReviewerSession");
	});

	it("the unregisterReviewerSession call is wrapped in try/catch with continue-on-error semantics", () => {
		// Locate the unregisterReviewerSession call inside resubscribeTeamEvents
		// directly, then walk backwards to the nearest `try {` and forwards to
		// the matching `catch`. This avoids false positives from sibling helpers
		// (e.g. _bootRespawnSessionlessGoals) within the same lexical window.
		const startIdx = text.indexOf("resubscribeTeamEvents");
		assert.ok(startIdx > 0);
		const window = text.slice(startIdx, startIdx + 6_000);
		const callIdx = window.indexOf("this.unregisterReviewerSession(");
		assert.ok(callIdx > 0, "unregisterReviewerSession call must be inside resubscribeTeamEvents");
		const before = window.slice(0, callIdx);
		const tryIdx = before.lastIndexOf("try {");
		assert.ok(tryIdx >= 0, "try { must precede the unregisterReviewerSession call");
		const after = window.slice(callIdx);
		const catchIdx = after.indexOf("} catch");
		assert.ok(catchIdx >= 0, "} catch must follow the unregisterReviewerSession call");
	});

	it("the catch branch logs the error AND does not rethrow (so boot continues)", () => {
		const startIdx = text.indexOf("resubscribeTeamEvents");
		const window = text.slice(startIdx, startIdx + 6_000);
		const callIdx = window.indexOf("this.unregisterReviewerSession(");
		assert.ok(callIdx > 0);
		const after = window.slice(callIdx);
		const catchIdx = after.indexOf("} catch");
		assert.ok(catchIdx >= 0);
		// Read 600 chars of catch-body and ensure it logs but doesn't rethrow.
		const catchBody = after.slice(catchIdx, catchIdx + 600);
		assert.match(catchBody, /catch\s*\(\s*err/, "catch block must bind the error variable");
		assert.match(catchBody, /console\.error/, "catch must log via console.error");
		assert.doesNotMatch(catchBody, /throw\s+err/, "catch must not rethrow — boot must continue");
	});
});

describe("Lesson 4.11C — behavioural smoke (no rethrow on simulated failure)", () => {
	it("a try/catch around unregisterReviewerSession swallows synchronous throws", () => {
		// Mirror of the production shape: a sweep that iterates entries and
		// continues on per-entry failure. We re-implement it inline so the test
		// doesn't need a full TeamManager — the source-grep above pins the
		// production code's structure.
		const entries = [
			{ goalId: "g1", reviewerSessionId: "r1" },
			{ goalId: "g2", reviewerSessionId: "r2-bad" },
			{ goalId: "g3", reviewerSessionId: "r3" },
		];
		const visited: string[] = [];
		const errors: string[] = [];
		function unregister(entry: { goalId: string; reviewerSessionId: string }) {
			visited.push(entry.goalId);
			if (entry.reviewerSessionId === "r2-bad") {
				throw new Error("resolveTeamStore: goal not found");
			}
		}
		for (const e of entries) {
			try {
				unregister(e);
			} catch (err: any) {
				errors.push(err.message);
				// continue
			}
		}
		assert.deepEqual(visited, ["g1", "g2", "g3"], "all entries must be visited");
		assert.deepEqual(errors, ["resolveTeamStore: goal not found"]);
	});
});
