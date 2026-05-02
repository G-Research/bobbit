/**
 * Pinned regression: planStep child resolution preserves linkage to
 * archived (merged + cleaned-up) children.
 *
 * Live test (PR #409 team-lead-317cdb83): after the Phase 2 trio
 * merged + auto-archived, `goal_plan_status` started returning
 * planSteps with no `child` field for the completed work. The
 * fallback walker filtered out archived children, but "archived" in
 * post-PR #409 means "merged + cleaned up" (one of the four auto-
 * archive paths fired). Filtering them out blinded the harness to
 * dependency satisfaction (Phase N+1 wouldn't auto-spawn) and hid
 * "this work is done" from the Plan tab UI.
 *
 * Fix: `resolvePlanStepChild` includes archived children in the
 * walk. Re-spawn handling: prefers live (non-archived) over
 * archived, then most-recent createdAt among ties.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePlanStepChild, type PlanStepChildLike } from "../src/server/agent/resolve-plan-step-child.js";

const c = (over: Partial<PlanStepChildLike> & Pick<PlanStepChildLike, "id">): PlanStepChildLike => ({
	parentGoalId: "p1",
	archived: false,
	spawnedFromPlanId: "v0.1-storage",
	createdAt: 1000,
	...over,
});

describe("resolvePlanStepChild — the bug regression", () => {
	it("the canonical case: returns live child when one exists", () => {
		const goals = [c({ id: "live-child" })];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "live-child");
	});

	it("THE bug: returns ARCHIVED child when no live one exists (post-merge auto-archive)", () => {
		// Live test pattern: storage merged + auto-archived. The plan
		// view + harness must still resolve this planStep to its
		// (archived) child so dep-sat works and the UI shows passed.
		const goals = [c({ id: "archived-merged", archived: true })];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "archived-merged");
		assert.equal(result?.archived, true);
	});

	it("returns undefined when no child carries that planId", () => {
		const goals = [c({ id: "wrong-plan", spawnedFromPlanId: "v0.1-other" })];
		assert.equal(resolvePlanStepChild("p1", "v0.1-storage", goals), undefined);
	});

	it("returns undefined when child has different parent", () => {
		const goals = [c({ id: "wrong-parent", parentGoalId: "p2" })];
		assert.equal(resolvePlanStepChild("p1", "v0.1-storage", goals), undefined);
	});

	it("returns undefined for an empty store", () => {
		assert.equal(resolvePlanStepChild("p1", "v0.1-storage", []), undefined);
	});
});

describe("resolvePlanStepChild — re-spawn preference order", () => {
	it("prefers LIVE non-archived child over archived one (re-spawn after a failed attempt)", () => {
		// First attempt failed and was archived; a fresh re-spawn is now
		// running. The plan view should reflect the live attempt.
		const goals = [
			c({ id: "old-attempt", archived: true, createdAt: 1000 }),
			c({ id: "fresh-respawn", archived: false, createdAt: 2000 }),
		];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "fresh-respawn");
	});

	it("prefers LIVE over archived even when archived is more recent (defensive)", () => {
		// Shouldn't happen in normal flows, but pin the rule.
		const goals = [
			c({ id: "live-but-old", archived: false, createdAt: 1000 }),
			c({ id: "archived-but-newer", archived: true, createdAt: 2000 }),
		];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "live-but-old");
	});

	it("among LIVE ties: prefers most-recent createdAt", () => {
		// Two live children sharing a planId (defensive — shouldn't
		// happen post-fix but might during edits / restarts).
		const goals = [
			c({ id: "older-live", createdAt: 1000 }),
			c({ id: "newer-live", createdAt: 2000 }),
		];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "newer-live");
	});

	it("among ARCHIVED ties: prefers most-recent createdAt", () => {
		// Multiple archived attempts — the most recent is the canonical
		// integration-source.
		const goals = [
			c({ id: "older-archived", archived: true, createdAt: 1000 }),
			c({ id: "newer-archived", archived: true, createdAt: 2000 }),
		];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "newer-archived");
	});

	it("missing createdAt treated as 0 (deterministic)", () => {
		const goals = [
			c({ id: "no-ts", createdAt: undefined }),
			c({ id: "ts1", createdAt: 1 }),
		];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "ts1");
	});
});

describe("resolvePlanStepChild — tier-based preference (BUG #2 regression)", () => {
	it("BUG: archived+complete (merged) beats archived+in-progress (zombie sibling), even with newer createdAt", () => {
		// Live test PR #409 v0.1-foundation: storage-sqlite-and-markdown
		// rendered FAILED because a sibling "Storage live test" child
		// shared its planId, was archived in-progress, and had a newer
		// createdAt than the real merged child. The earlier preference
		// rule (live > archived, then most-recent within ties) shadowed
		// the success when both were archived.
		const goals = [
			c({ id: "real-merged", state: "complete", archived: true, createdAt: 1000 }),
			c({ id: "sibling-test", state: "in-progress", archived: true, createdAt: 2000 }),
		];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "real-merged");
	});

	it("live in-progress beats live-but-complete (top tier wins)", () => {
		// A live goal that's `state: complete` is mid-merge or paused-
		// before-merge. The live in-progress one is what's actively
		// being driven — surface that.
		const goals = [
			c({ id: "live-running", state: "in-progress", createdAt: 1000 }),
			c({ id: "live-complete", state: "complete", createdAt: 2000 }),
		];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "live-running");
	});

	it("archived+complete beats live-but-shelved (success terminal beats failure-in-flight)", () => {
		// A merged sibling vs a live but shelved (= failed) sibling. The
		// merged child is the canonical source of truth.
		const goals = [
			c({ id: "merged", state: "complete", archived: true, createdAt: 1000 }),
			c({ id: "shelved-live", state: "shelved", archived: false, createdAt: 2000 }),
		];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "merged");
	});

	it("archived non-complete is the lowest tier (zombie / aborted)", () => {
		// All else equal, archived+shelved/in-progress are last-resort.
		const goals = [
			c({ id: "zombie", state: "shelved", archived: true, createdAt: 2000 }),
			c({ id: "live-todo", state: "todo", archived: false, createdAt: 1000 }),
		];
		const result = resolvePlanStepChild("p1", "v0.1-storage", goals);
		assert.equal(result?.id, "live-todo");
	});
});

describe("resolvePlanStepChild — tier-4 title fallback (orphan-child rescue)", () => {
	// Live test (PR #409 v0.2-embeddings-mcp-retrieval): 4 Phase 2
	// leaves spawned BEFORE the spawnedFromPlanId-on-spawn change
	// shipped (interrupted by server restart). They have state=complete
	// but spawnedFromPlanId=null. Title-fallback rescues them.

	it("THE bug: rescues orphan child by title when no spawnedFromPlanId match", () => {
		const goals = [
			{ id: "orphan", parentGoalId: "p1", state: "complete" as const, title: "streaming-scrubber (v0.2 leaf)", spawnedFromPlanId: undefined, createdAt: 1000 },
		];
		const result = resolvePlanStepChild("p1", "v0.2-streaming-scrubber", goals, "streaming-scrubber (v0.2 leaf)");
		assert.equal(result?.id, "orphan");
	});

	it("does NOT rescue when planTitle is not supplied", () => {
		const goals = [
			{ id: "orphan", parentGoalId: "p1", state: "complete" as const, title: "streaming-scrubber", spawnedFromPlanId: undefined, createdAt: 1000 },
		];
		// No planTitle arg.
		const result = resolvePlanStepChild("p1", "v0.2-streaming-scrubber", goals);
		assert.equal(result, undefined);
	});

	it("does NOT match a child that has a DIFFERENT spawnedFromPlanId (would be re-binding)", () => {
		// Defensive: a child legitimately spawned for a DIFFERENT planId
		// must not be rebound just because its title matches another
		// planStep's title. Tier-4 only matches truly-orphan children.
		const goals = [
			{ id: "taken", parentGoalId: "p1", state: "complete" as const, title: "streaming-scrubber", spawnedFromPlanId: "v0.2-different", createdAt: 1000 },
		];
		const result = resolvePlanStepChild("p1", "v0.2-streaming-scrubber", goals, "streaming-scrubber");
		assert.equal(result, undefined);
	});

	it("does NOT match a child of a DIFFERENT parent", () => {
		const goals = [
			{ id: "orphan", parentGoalId: "p2", state: "complete" as const, title: "streaming-scrubber", spawnedFromPlanId: undefined, createdAt: 1000 },
		];
		const result = resolvePlanStepChild("p1", "v0.2-streaming-scrubber", goals, "streaming-scrubber");
		assert.equal(result, undefined);
	});

	it("prefers spawnedFromPlanId match over title match (tier 1-3 wins over tier 4)", () => {
		// Both kinds present — the proper linkage wins. Title-fallback
		// only fires when no spawnedFromPlanId match exists.
		const goals = [
			{ id: "properly-linked", parentGoalId: "p1", state: "complete" as const, title: "different-title", spawnedFromPlanId: "v0.2-storage", createdAt: 1000 },
			{ id: "orphan-by-title", parentGoalId: "p1", state: "complete" as const, title: "matches-the-plan-title", spawnedFromPlanId: undefined, createdAt: 2000 },
		];
		const result = resolvePlanStepChild("p1", "v0.2-storage", goals, "matches-the-plan-title");
		assert.equal(result?.id, "properly-linked");
	});

	it("among multiple orphans matching by title, applies tier preference", () => {
		const goals = [
			{ id: "orphan-shelved", parentGoalId: "p1", state: "shelved" as const, archived: true, title: "X", spawnedFromPlanId: undefined, createdAt: 2000 },
			{ id: "orphan-live", parentGoalId: "p1", state: "in-progress" as const, title: "X", spawnedFromPlanId: undefined, createdAt: 1000 },
		];
		const result = resolvePlanStepChild("p1", "v0.2-x", goals, "X");
		assert.equal(result?.id, "orphan-live");
	});
});
