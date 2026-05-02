/**
 * Phase 3 / Lesson 4.2 — A cached `childGoalId` that points at an archived
 * non-complete child is a dead pointer. The harness MUST wipe the pointer
 * (and persist the wipe via `_persistActive`) before falling through to
 * spawn a fresh child.
 *
 * Without this, every subsequent `gate_signal execution` runs the wait loop
 * forever — the dupe is archived, no progress, but the existing
 * `archived && state === "complete"` short-circuit doesn't fire (state is
 * shelved, not complete).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — Lesson 4.2: stale archived non-complete cached pointer is wiped + spawns fresh", () => {
	it("cached pointer at archived+shelved → wiped + new child spawned", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-stale";
		// Pre-existing archived+shelved child
		fx.goalStore.put({
			id: "stale-child", title: "Stale", cwd: fx.tmpRoot,
			state: "shelved", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 2,
		} as any);

		const step = buildSubgoalStep({ planId, title: "Stale" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		// Seed the cached pointer at the dead record.
		active.steps[stepIndex].subgoal = { childGoalId: "stale-child", planId };

		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		// Step should pass (a fresh child was spawned, run, merged).
		assert.equal(result.passed, true);

		// The cached pointer must NOT still be the dead record — it must point
		// at the fresh child or be undefined-then-overwritten.
		const finalCachedId = active.steps[stepIndex].subgoal?.childGoalId;
		assert.notEqual(finalCachedId, "stale-child",
			"cached pointer must NOT still point at the archived shelved child");

		// And there must be a fresh child on disk now (in addition to the
		// pre-existing stale one). The default test fixture lets the new
		// child reach ready-to-merge → merge → archiveAfterMerge, so it ends
		// up archived+complete; the stale pre-existing one stays
		// archived+shelved. We assert that BOTH exist on disk and the IDs
		// differ.
		const matching = fx.goalStore.getAll().filter(g =>
			g.parentGoalId === fx.parent.id && g.spawnedFromPlanId === planId,
		);
		assert.equal(matching.length, 2, `expected 2 children on disk, got ${matching.length}`);
		const fresh = matching.find(g => g.id !== "stale-child");
		assert.ok(fresh, "fresh child should be spawned after stale-pointer invalidation");
		assert.equal(fresh!.state, "complete", "fresh child should have been merged + archived as complete");
	});

	it("cached pointer at vanished (deleted) goal → wiped + new child spawned", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-ghost";
		const step = buildSubgoalStep({ planId, title: "Ghost" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		active.steps[stepIndex].subgoal = { childGoalId: "deleted-id", planId };

		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, true);
		const fresh = fx.goalStore.getAll().find(g =>
			g.parentGoalId === fx.parent.id && g.spawnedFromPlanId === planId,
		);
		assert.ok(fresh);
		assert.notEqual(fresh!.id, "deleted-id");
	});

	it("cached pointer at archived+complete is preserved (success terminal — Lesson 4.2 second branch)", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-complete";
		fx.goalStore.put({
			id: "done-child", title: "Done", cwd: fx.tmpRoot,
			state: "complete", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 2,
		} as any);

		const step = buildSubgoalStep({ planId, title: "Done" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		active.steps[stepIndex].subgoal = { childGoalId: "done-child", planId };

		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);
		assert.equal(result.passed, true);
		assert.match(result.output, /already complete/i);
		// No spawn — the success terminal short-circuited.
		assert.equal(fx.calls.find(c => c.kind === "createGoal"), undefined);
	});

	it("cached pointer at live in-progress is preserved (still in flight)", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-live";
		fx.goalStore.put({
			id: "live-child", title: "Live", cwd: fx.tmpRoot,
			state: "in-progress", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);

		const r = fx.harness.resolvePlanStepChild(fx.parent.id, planId, {
			expectedTitle: "Live",
			active: {
				steps: [{ subgoal: { childGoalId: "live-child", planId } }],
			} as any,
			stepIndex: 0,
		});
		// tier-1 wins (live in-progress) — but cached-pointer is also valid.
		// Either way, the child must be the live one (no spawn).
		assert.equal(r.child?.id, "live-child");
	});
});
