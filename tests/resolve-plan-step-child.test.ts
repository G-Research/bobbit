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
