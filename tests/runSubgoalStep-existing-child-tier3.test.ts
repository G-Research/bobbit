/**
 * Finding 3 — harness Tier-3 existing-child handling.
 *
 * When `resolvePlanStepChild` returns an EXISTING live child (Tier 3:
 * todo / blocked / awaiting-setup — e.g. after a crash/restart or an
 * idempotent re-signal) the old code ONLY stamped `childGoalId` then fell
 * through to `_waitForChildReadyToMerge` WHILE holding the per-root permit:
 *   - a never-started `todo` child waited forever (no team ever started), and
 *   - a `blocked` child held the permit during the wait (cap=1 deadlock — the
 *     dependency could never acquire a slot to run + merge).
 *
 * These tests pin the state-aware branch:
 *   - existing `todo` child → its team IS started (under the held permit),
 *   - existing `blocked` child → the permit is RELEASED while waiting for the
 *     auto-unblock, then re-acquired + started.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — Finding 3: existing Tier-3 child handling", () => {
	it("existing `todo` child gets its team STARTED (not stranded) and merges", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-existing-todo";
		// A live, never-started child for this plan (crash/restart/idempotent
		// re-signal). state='todo' → Tier 3 "live-other".
		fx.goalStore.put({
			id: "existing-todo", title: "Existing todo child", cwd: fx.tmpRoot,
			state: "todo", spec: "", createdAt: 10, updatedAt: 10,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);

		const startedTeams: string[] = [];
		fx.setSetupHook(async (childGoalId) => { startedTeams.push(childGoalId); });
		fx.setReadyToMergeHook(async () => "passed");

		const step = buildSubgoalStep({ planId, title: "Existing todo child" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, true, result.output);
		assert.deepEqual(startedTeams, ["existing-todo"],
			"the existing todo child's team must be started, not stranded");
		// It must NOT spawn a fresh child — it reused the existing one.
		assert.equal(fx.calls.filter(c => c.kind === "createGoal").length, 0,
			"must reuse the existing child, not createGoal a new one");
		// And it merged + archived the existing child.
		assert.equal(fx.calls.some(c => c.kind === "mergeChild" && (c as any).childId === "existing-todo"), true);
	});

	it("existing `blocked` child does NOT hold the per-root permit while waiting for unblock (cap=1)", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		// cap=1 so a held permit would be observable as available===0.
		fx.goalStore.update(fx.parent.id, { maxConcurrentChildren: 1 });
		const rootGoalId = fx.parent.id;

		const planId = "p-existing-blocked";
		fx.goalStore.put({
			id: "existing-blocked", title: "Existing blocked child", cwd: fx.tmpRoot,
			state: "blocked", spec: "", createdAt: 10, updatedAt: 10,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			dependsOnPlanIds: ["dep-x"],
		} as any);

		const startedTeams: string[] = [];
		fx.setSetupHook(async (childGoalId) => { startedTeams.push(childGoalId); });
		fx.setReadyToMergeHook(async () => "passed");

		const step = buildSubgoalStep({ planId, title: "Existing blocked child" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);

		// Run in the background — it should park in _waitForChildUnblock having
		// RELEASED the permit (not started the team yet).
		const runPromise = fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		// Give the blocked branch a moment to resolve + release the permit.
		await new Promise(r => setTimeout(r, 40));
		const sem = (fx.harness as any)._acquireRootSubgoalSemaphore(rootGoalId, fx.parent.id);
		assert.equal(sem.available, 1,
			"a blocked existing child must RELEASE its permit while waiting for unblock");
		assert.deepEqual(startedTeams, [], "the team must NOT start while still blocked");

		// Simulate the dependency merging → auto-unblock flips state blocked→todo.
		await fx.goalManager.updateGoal("existing-blocked", { state: "todo" });

		const result = await runPromise;
		assert.equal(result.passed, true, result.output);
		assert.deepEqual(startedTeams, ["existing-blocked"],
			"after unblock the team is started (under a re-acquired permit)");
		assert.equal(fx.calls.filter(c => c.kind === "createGoal").length, 0,
			"must reuse the existing blocked child, not createGoal a new one");
	});

	it("existing `in-progress` child is NOT re-started — it just waits for ready-to-merge", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-existing-inprogress";
		fx.goalStore.put({
			id: "existing-inprogress", title: "Existing in-progress child", cwd: fx.tmpRoot,
			state: "in-progress", spec: "", createdAt: 10, updatedAt: 10,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);

		const startedTeams: string[] = [];
		fx.setSetupHook(async (childGoalId) => { startedTeams.push(childGoalId); });
		fx.setReadyToMergeHook(async () => "passed");

		const step = buildSubgoalStep({ planId, title: "Existing in-progress child" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, true, result.output);
		assert.deepEqual(startedTeams, [],
			"an in-progress child's team is already running — must NOT be re-started");
		assert.equal(fx.calls.some(c => c.kind === "mergeChild" && (c as any).childId === "existing-inprogress"), true);
	});
});
