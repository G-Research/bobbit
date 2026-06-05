/**
 * Phase 5 — `runSubgoalStep` stamps `dependsOnPlanIds` on the spawned child
 * from the verify-step's `subgoal.dependsOn`. Stamped in the same atomic
 * `updateGoal` call that carries `spawnedFromPlanId` (stamp `spawnedFromPlanId` IMMEDIATELY after createGoal — no awaits between).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — dependsOn stamping", () => {
	it("stamps dependsOnPlanIds from subgoal.dependsOn on the spawned child", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "p2", dependsOn: ["p1"] });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		const children = fx.goalStore.getAll().filter(g => g.parentGoalId === fx.parent.id);
		assert.equal(children.length, 1);
		assert.deepEqual(children[0].dependsOnPlanIds, ["p1"]);

		// Single atomic write: same updateGoal that carries spawnedFromPlanId
		// also carries dependsOnPlanIds.
		const stamp = fx.calls.find(c => c.kind === "updateGoal" && c.updates.spawnedFromPlanId);
		assert.ok(stamp && stamp.kind === "updateGoal");
		assert.deepEqual(stamp.updates.dependsOnPlanIds, ["p1"]);
	});

	it("omits dependsOnPlanIds when the verify-step has no dependsOn", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "solo" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		const children = fx.goalStore.getAll().filter(g => g.parentGoalId === fx.parent.id);
		assert.equal(children.length, 1);
		assert.equal(children[0].dependsOnPlanIds, undefined);
	});

	it("stamps an empty array when dependsOn is explicitly empty", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "empty-deps", dependsOn: [] });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		const children = fx.goalStore.getAll().filter(g => g.parentGoalId === fx.parent.id);
		assert.equal(children.length, 1);
		assert.deepEqual(children[0].dependsOnPlanIds, []);
	});
});
