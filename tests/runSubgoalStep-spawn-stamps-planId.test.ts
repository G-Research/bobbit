/**
 * Phase 3 / Lesson 4.1 — `spawnedFromPlanId` MUST be stamped IMMEDIATELY
 * after `createGoal` in `runSubgoalStep`. No other awaits, no other manager
 * calls between `createGoal(...)` and `updateGoal(child.id, { spawnedFromPlanId })`.
 *
 * This test pins the invariant by recording the call sequence on the
 * goalManager and asserting the second call is the planId stamp. Pre-fix
 * code paths interleave `gate.initGatesForGoal`, `broadcast`, and
 * `setupWorktreeAndStartTeam` between the two — at every restart that
 * sequence can be interrupted, leaving children with `spawnedFromPlanId`
 * undefined and producing the duplicate-spawn cascade documented on PR
 * #409.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — Lesson 4.1: stamp spawnedFromPlanId immediately after createGoal", () => {
	it("the very next call after createGoal is updateGoal({ spawnedFromPlanId })", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "phase-1-leaf-a" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);

		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);
		assert.equal(result.passed, true, "happy-path should pass");

		// Find createGoal in the call list.
		const createIdx = fx.calls.findIndex(c => c.kind === "createGoal");
		assert.notEqual(createIdx, -1, "createGoal must be called");

		// The IMMEDIATELY next call MUST be updateGoal with spawnedFromPlanId.
		const next = fx.calls[createIdx + 1];
		assert.equal(next?.kind, "updateGoal",
			`Lesson 4.1 violated: call after createGoal was ${next?.kind}, expected updateGoal. ` +
			`Full sequence: ${fx.calls.map(c => c.kind).join(" → ")}`,
		);
		assert.ok(next.kind === "updateGoal");
		assert.equal(next.updates.spawnedFromPlanId, "phase-1-leaf-a",
			"updateGoal call must carry spawnedFromPlanId=<planId>");
	});

	it("createGoal is invoked with parentGoalId + workflowId='feature' + projectId from parent", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "p2" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		const create = fx.calls.find(c => c.kind === "createGoal");
		assert.ok(create);
		assert.ok(create.kind === "createGoal");
		assert.equal(create.opts.parentGoalId, fx.parent.id);
		assert.equal(create.opts.workflowId, "feature");
		assert.equal(create.opts.projectId, fx.parent.projectId ?? "p");
	});

	it("respects subgoal.workflowId override (defaults to 'feature' only when unset)", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "p3", workflowId: "general" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		const create = fx.calls.find(c => c.kind === "createGoal");
		assert.ok(create && create.kind === "createGoal");
		assert.equal(create.opts.workflowId, "general");
	});

	it("the persisted child goal record carries spawnedFromPlanId on disk", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "phase-2-leaf-x" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		const children = fx.goalStore.getAll().filter(g => g.parentGoalId === fx.parent.id);
		assert.equal(children.length, 1);
		assert.equal(children[0].spawnedFromPlanId, "phase-2-leaf-x");
	});

	it("re-running the step after spawn is idempotent — does NOT re-create the child", async () => {
		// Lesson 4.1 + 4.19: tier-1 lookup finds the live child by spawnedFromPlanId
		// and reuses it; no duplicate spawn.
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "phase-3" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, signal, active, stepIndex);
		const childrenAfter1 = fx.goalStore.getAll().filter(g => g.parentGoalId === fx.parent.id).length;
		assert.equal(childrenAfter1, 1);

		// Reset the calls log and re-run with a fresh active state.
		fx.calls.length = 0;
		const next = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, next.signal, next.active, next.stepIndex);

		const childrenAfter2 = fx.goalStore.getAll().filter(g => g.parentGoalId === fx.parent.id).length;
		assert.equal(childrenAfter2, 1, "must NOT spawn a duplicate child on re-entry");
		// And no createGoal in the second invocation's call log.
		assert.equal(fx.calls.find(c => c.kind === "createGoal"), undefined);
	});
});
