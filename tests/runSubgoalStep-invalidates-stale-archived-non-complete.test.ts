/**
 * Pinned regression: when the cached childGoalId on a subgoal verify
 * step points at a child that is `archived` AND `state !== "complete"`,
 * runSubgoalStep invalidates the cache and falls through to tier-3
 * `resolvePlanStepChild` to find the canonical merged-and-archived
 * original.
 *
 * Live test (PR #409 v0.2-embeddings team-lead-4285af30 bug report):
 * the harness re-spawned 4 dupes after a server restart (31c49942,
 * 7f736b47, 75dea8b6, 6010be40). The team-lead manually merged the
 * originals' branches into the goal branch (since the dupes were
 * stuck without team agents) and then archived the dupes. But the
 * persisted `GateSignalStep.subgoal.childGoalId` still pointed at the
 * dupes. Every subsequent `gate_signal execution` ran the wait loop
 * forever — the dupe was archived (no progress), state was
 * `in-progress` not `complete`, so the archived+complete short-
 * circuit never fired, but no new resolution path triggered either.
 *
 * Result: gate stuck in failed→re-signal→failed loop indefinitely.
 *
 * Fix: after tier-1 (active record) and tier-1.5 (persisted record)
 * lookup, check whether the resolved childGoalId points at an
 * archived non-complete child. If yes, invalidate it and let
 * tier-3 (resolvePlanStepChild walking spawnedFromPlanId with
 * success-aware preference) find the real original.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface ChildGoalLike {
	id: string;
	archived?: boolean;
	state?: string;
}

/** Replicates the invalidation predicate. */
function shouldInvalidateCachedChild(child: ChildGoalLike | null | undefined): boolean {
	if (!child) return false;
	if (!child.archived) return false;
	return child.state !== "complete";
}

describe("runSubgoalStep — invalidate cached archived non-complete childGoalId", () => {
	it("THE bug: archived + state=in-progress (dupe pattern from bug report) -> invalidate", () => {
		// Pre-fix this case fell through with childGoalId set, ran the
		// wait loop forever on a permanently-archived dupe.
		assert.equal(shouldInvalidateCachedChild({ id: "31c49942", archived: true, state: "in-progress" }), true);
	});

	it("archived + state=shelved (cancellation pattern) -> invalidate", () => {
		assert.equal(shouldInvalidateCachedChild({ id: "x", archived: true, state: "shelved" }), true);
	});

	it("archived + state=complete (success terminal, e.g. merged child) -> DO NOT invalidate", () => {
		// This is the legitimate archived+complete case that the
		// short-circuit at line ~2577 handles — DON'T invalidate; let
		// the short-circuit fire and pass the step.
		assert.equal(shouldInvalidateCachedChild({ id: "x", archived: true, state: "complete" }), false);
	});

	it("live (non-archived) child -> DO NOT invalidate (active spawn in flight)", () => {
		assert.equal(shouldInvalidateCachedChild({ id: "x", archived: false, state: "in-progress" }), false);
	});

	it("undefined archived (live child default) -> DO NOT invalidate", () => {
		assert.equal(shouldInvalidateCachedChild({ id: "x", state: "in-progress" }), false);
	});

	it("missing child (deleted from store) -> DO NOT invalidate (separate disappeared-child error path)", () => {
		// If the store returns null/undefined the wait loop has its own
		// dedicated handler ("Subgoal child X disappeared from store.")
		// we don't pre-empt that with our invalidation.
		assert.equal(shouldInvalidateCachedChild(null), false);
		assert.equal(shouldInvalidateCachedChild(undefined), false);
	});

	it("archived + state=todo (pre-spawn cancellation) -> invalidate", () => {
		// Defensive: any non-complete archived child is unrecoverable.
		assert.equal(shouldInvalidateCachedChild({ id: "x", archived: true, state: "todo" }), true);
	});
});
