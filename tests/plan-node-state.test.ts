/**
 * Pinned regression: plan-DAG node state resolution.
 *
 * Live test (PR #409): every plan node was rendering as PENDING even
 * after children completed and merged \u2014 see screenshot from
 * v0.1-foundation Plan tab. Cause: the original code keyed off
 * `step.subgoal.childGoalId`, but the snapshotted plan steps in
 * `goal.inlineWorkflow.gates[execution].verify[]` are FROZEN at goal-
 * plan time and the harness never writes back to them; it records
 * `childGoalId` on the GATE SIGNAL verification record (live), not on
 * the snapshot. Result: `step.subgoal.childGoalId` was always
 * undefined and state always fell through to "pending".
 *
 * Fix: walk by `spawnedFromPlanId` on the live goals array. Same
 * source-of-truth the harness's `runSubgoalStep` uses for idempotency
 * tier (c).
 *
 * Adds a new "needs-input" state for paused / pending-mutation
 * children so the user can distinguish "agent is working" from
 * "agent is blocked on me".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePlanNodeState, type PlanGoalLike, type PlanStepLike } from "../src/app/plan-node-state.js";

const step = (planId: string, childGoalId?: string): PlanStepLike => ({
	subgoal: { planId, childGoalId },
});

describe("resolvePlanNodeState \u2014 the bug regression", () => {
	it("returns 'running' for a live in-progress child found via spawnedFromPlanId (the live-test bug)", () => {
		// This is the exact v0.1-foundation case: planStep with no
		// childGoalId on its snapshot, but a live child carrying
		// `spawnedFromPlanId === planId` and `state: in-progress`.
		const goals: PlanGoalLike[] = [
			{ id: "9dbbce41", state: "in-progress", spawnedFromPlanId: "v0.1-storage" },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-storage"), goals), "running");
	});

	it("returns 'passed' for a complete + archived (auto-archive after merge) child", () => {
		// runSubgoalStep auto-archives on clean merge; the integrate-
		// child route now does the same. Archived+complete is the
		// success terminal state.
		const goals: PlanGoalLike[] = [
			{ id: "a3236363", state: "complete", archived: true, spawnedFromPlanId: "v0.1-idempotency" },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-idempotency"), goals), "passed");
	});

	it("returns 'failed' for an archived non-complete child (zombie / shelved)", () => {
		// Pre-fix interrupted spawns end up as `state=shelved &&
		// archived=true`. They should render red, not as success.
		const goals: PlanGoalLike[] = [
			{ id: "0b1a0ec0", state: "shelved", archived: true, spawnedFromPlanId: "v0.1-policy" },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-policy"), goals), "failed");
	});

	it("returns 'pending' when no live or archived child carries the planId", () => {
		// Rest-cli-and-rebuild before Phase 3 spawns: the plan step
		// exists but no child has been created yet.
		const goals: PlanGoalLike[] = [
			{ id: "9dbbce41", state: "in-progress", spawnedFromPlanId: "v0.1-storage" },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-rest-cli"), goals), "pending");
	});

	it("prefers a live child over an archived one when both share the same planId (re-spawn)", () => {
		// First attempt failed and was archived; a fresh re-spawn is now
		// running. The plan node should reflect the live attempt.
		const goals: PlanGoalLike[] = [
			{ id: "old", state: "shelved", archived: true, spawnedFromPlanId: "v0.1-storage", createdAt: 1000 },
			{ id: "new", state: "in-progress", spawnedFromPlanId: "v0.1-storage", createdAt: 2000 },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-storage"), goals), "running");
	});

	it("when multiple LIVE children share a planId (defensive), prefers the most recent", () => {
		// Shouldn't happen post-fix but might during edits / restarts.
		// Most-recent createdAt wins.
		const goals: PlanGoalLike[] = [
			{ id: "older-live", state: "in-progress", spawnedFromPlanId: "v0.1-storage", createdAt: 1000 },
			{ id: "newer-live", state: "complete", spawnedFromPlanId: "v0.1-storage", createdAt: 2000 },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-storage"), goals), "passed");
	});

	it("falls back to childGoalId when explicit linkage IS set (legacy / fresh-signal path)", () => {
		// If the snapshot somehow has childGoalId (e.g. fresh spawn
		// recorded before goal-plan freeze), prefer that.
		const goals: PlanGoalLike[] = [
			{ id: "explicit-child", state: "in-progress" },
			{ id: "spawn-link-child", state: "shelved", spawnedFromPlanId: "v0.1-storage" },
		];
		assert.equal(
			resolvePlanNodeState(step("v0.1-storage", "explicit-child"), goals),
			"running",
		);
	});

	it("returns 'pending' when explicit childGoalId points at a non-existent goal AND no spawnedFromPlanId match", () => {
		// Defensive: stale linkage shouldn't crash, just renders pending.
		const goals: PlanGoalLike[] = [];
		assert.equal(resolvePlanNodeState(step("v0.1-storage", "ghost"), goals), "pending");
	});
});

describe("resolvePlanNodeState \u2014 needs-input state", () => {
	it("returns 'needs-input' for a paused live child (yellow \u2014 user-blocked)", () => {
		const goals: PlanGoalLike[] = [
			{ id: "9dbbce41", state: "in-progress", paused: true, spawnedFromPlanId: "v0.1-storage" },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-storage"), goals), "needs-input");
	});

	it("returns 'needs-input' for a child with a buffered mutation awaiting approval", () => {
		const goals: PlanGoalLike[] = [
			{ id: "9dbbce41", state: "in-progress", pendingMutationCount: 1, spawnedFromPlanId: "v0.1-storage" },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-storage"), goals), "needs-input");
	});

	it("does NOT return 'needs-input' if the child is archived (terminal beats live state)", () => {
		// An archived+complete child is terminal-success; the paused
		// flag from a previous lifecycle shouldn't override that.
		const goals: PlanGoalLike[] = [
			{ id: "a3236363", state: "complete", archived: true, paused: true, spawnedFromPlanId: "v0.1-idem" },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-idem"), goals), "passed");
	});

	it("treats pendingMutationCount = 0 as not-needing-input", () => {
		const goals: PlanGoalLike[] = [
			{ id: "9dbbce41", state: "in-progress", pendingMutationCount: 0, spawnedFromPlanId: "v0.1-storage" },
		];
		assert.equal(resolvePlanNodeState(step("v0.1-storage"), goals), "running");
	});
});

describe("resolvePlanNodeState \u2014 state-mapping table", () => {
	const cases: Array<[string, PlanGoalLike["state"], boolean | undefined, "pending" | "running" | "passed" | "failed"]> = [
		["complete + not archived (yet to merge)", "complete", false, "passed"],
		["in-progress + not archived",             "in-progress", false, "running"],
		["shelved + not archived",                 "shelved", false, "failed"],
		["todo + not archived",                    "todo" as any, false, "pending"],
	];
	for (const [label, st, archived, expected] of cases) {
		it(`maps state=${label} \u2192 ${expected}`, () => {
			const goals: PlanGoalLike[] = [
				{ id: "c1", state: st, archived, spawnedFromPlanId: "p1" },
			];
			assert.equal(resolvePlanNodeState(step("p1"), goals), expected);
		});
	}
});
