/**
 * dependsOn scheduling enforcement on the parent-workflow subgoal path.
 *
 * Spec: "Full DAG dependencies: declare `dependsOn` between sibling sub-goals;
 * a child with unmet deps is created paused/blocked and auto-resumes when its
 * last dependency merges" and "The `subgoal` verify-step type IS the
 * scheduler." The direct `goal_spawn_child` REST path already blocks on unmet
 * deps (creates `state:"blocked"`, auto-unblocked by integrate-child); this
 * suite pins the equivalent behaviour on `runSubgoalStep` (the `parent`
 * meta-workflow execution path):
 *
 *   - A sibling step with an unmet `dependsOn` is created `state:"blocked"`
 *     and its team/worktree is NOT started.
 *   - Two sibling steps with an A→B dependency do NOT run concurrently:
 *     B's team only starts after A merges (harness auto-unblock scan).
 *   - When all of a step's deps are already merged, it spawns immediately
 *     (never blocked).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("runSubgoalStep — dependsOn scheduling enforcement", () => {
	it("B dependsOn A (same phase): A runs, B is blocked until A merges, then auto-unblocks", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const teamStarted: string[] = [];
		fx.setSetupHook(async (childGoalId) => { teamStarted.push(childGoalId); });

		// Hold A's ready-to-merge until we have observed that B is blocked.
		let releaseA!: () => void;
		const aHeld = new Promise<void>(res => { releaseA = res; });
		fx.setReadyToMergeHook(async (childGoalId) => {
			const g = fx.goalStore.get(childGoalId);
			if (g?.spawnedFromPlanId === "A") await aHeld;
			return "passed";
		});

		const stepA = buildSubgoalStep({ planId: "A", title: "Alpha" });
		const stepB = buildSubgoalStep({ planId: "B", title: "Beta", dependsOn: ["A"] });
		const aA = buildActive(fx.parent.id);
		const aB = buildActive(fx.parent.id);

		const runA = fx.harness.runSubgoalStep(stepA, aA.signal, aA.active, 0);
		const runB = fx.harness.runSubgoalStep(stepB, aB.signal, aB.active, 0);

		const findChild = (planId: string) =>
			fx.goalStore.getAll().find(g => g.parentGoalId === fx.parent.id && g.spawnedFromPlanId === planId);

		// Wait until B is created AND stamped blocked.
		let bChild = findChild("B");
		for (let i = 0; i < 400 && !(bChild && bChild.state === "blocked"); i++) {
			await sleep(5);
			bChild = findChild("B");
		}
		assert.ok(bChild, "B child should be created");
		assert.equal(bChild.state, "blocked", "B must be created blocked while A is unmerged");

		// A (no deps) should start its team; B (blocked) must NOT.
		const aChild = findChild("A");
		assert.ok(aChild, "A child should be created");
		for (let i = 0; i < 200 && !teamStarted.includes(aChild.id); i++) await sleep(5);
		assert.equal(teamStarted.includes(aChild.id), true, "A's team should start (no deps)");
		assert.equal(teamStarted.includes(bChild.id), false, "B's team must NOT start while blocked");

		// The atomic spawn stamp for B carries state='blocked'.
		const bStamp = fx.calls.find(c => c.kind === "updateGoal" && c.updates.spawnedFromPlanId === "B");
		assert.ok(bStamp && bStamp.kind === "updateGoal");
		assert.equal(bStamp.updates.state, "blocked", "B's spawn stamp must set state='blocked'");
		assert.deepEqual(bStamp.updates.dependsOnPlanIds, ["A"]);

		// Release A → A merges + archives → auto-unblock scan flips B → todo and
		// starts B's team → B proceeds to merge.
		releaseA();
		const [rA, rB] = await Promise.all([runA, runB]);
		assert.equal(rA.passed, true, rA.output);
		assert.equal(rB.passed, true, rB.output);
		assert.equal(teamStarted.includes(bChild.id), true, "B's team must start after A merges (auto-unblock)");

		// Both children end complete + archived.
		assert.equal(fx.goalStore.get(aChild.id)?.state, "complete");
		assert.equal(fx.goalStore.get(aChild.id)?.archived, true);
		assert.equal(fx.goalStore.get(bChild.id)?.state, "complete");
		assert.equal(fx.goalStore.get(bChild.id)?.archived, true);
	});

	it("spawns immediately (not blocked) when every dep is already merged", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const teamStarted: string[] = [];
		fx.setSetupHook(async (childGoalId) => { teamStarted.push(childGoalId); });

		// Run A to completion first so it is merged + archived (state=complete).
		const stepA = buildSubgoalStep({ planId: "A", title: "Alpha" });
		const aA = buildActive(fx.parent.id);
		const rA = await fx.harness.runSubgoalStep(stepA, aA.signal, aA.active, 0);
		assert.equal(rA.passed, true, rA.output);

		const aChild = fx.goalStore.getAll().find(g => g.spawnedFromPlanId === "A");
		assert.ok(aChild && aChild.state === "complete", "A should be complete after its run");

		// B dependsOn A — but A is already merged, so B must spawn immediately.
		const stepB = buildSubgoalStep({ planId: "B", title: "Beta", dependsOn: ["A"] });
		const aB = buildActive(fx.parent.id);
		const rB = await fx.harness.runSubgoalStep(stepB, aB.signal, aB.active, 0);
		assert.equal(rB.passed, true, rB.output);

		const bChild = fx.goalStore.getAll().find(g => g.spawnedFromPlanId === "B");
		assert.ok(bChild, "B child should be created");
		assert.equal(teamStarted.includes(bChild.id), true, "B's team should start immediately when deps satisfied");

		// The spawn stamp for B must NOT carry state='blocked'.
		const bStamp = fx.calls.find(c => c.kind === "updateGoal" && c.updates.spawnedFromPlanId === "B");
		assert.ok(bStamp && bStamp.kind === "updateGoal");
		assert.equal(bStamp.updates.state, undefined, "B must not be stamped blocked when deps are satisfied");
	});
});
