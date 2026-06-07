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

		// Pre-create the declared dependency as an already-merged sibling so the
		// child is NOT held by dependsOn scheduling. This test pins the stamp,
		// not the blocking path (see runSubgoalStep-dependsOn-blocking.test.ts).
		// In production, plan validation rejects deps on unknown plan steps
		// before the harness runs, so a dep always resolves to a real sibling.
		const dep = await fx.goalManager.createGoal("Dep p1", fx.tmpRoot, { workflowId: "feature", projectId: "p" });
		fx.goalStore.update(dep.id, { parentGoalId: fx.parent.id, spawnedFromPlanId: "p1", state: "complete" });

		const step = buildSubgoalStep({ planId: "p2", dependsOn: ["p1"] });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		const child = fx.goalStore.getAll().find(g => g.parentGoalId === fx.parent.id && g.spawnedFromPlanId === "p2");
		assert.ok(child, "p2 child should be spawned");
		assert.deepEqual(child.dependsOnPlanIds, ["p1"]);

		// Single atomic write: same updateGoal that carries spawnedFromPlanId
		// also carries dependsOnPlanIds. A satisfied dep must NOT stamp blocked.
		const stamp = fx.calls.find(c => c.kind === "updateGoal" && c.updates.spawnedFromPlanId === "p2");
		assert.ok(stamp && stamp.kind === "updateGoal");
		assert.deepEqual(stamp.updates.dependsOnPlanIds, ["p1"]);
		assert.equal(stamp.updates.state, undefined, "satisfied dep must not stamp state='blocked'");
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
