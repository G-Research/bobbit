/**
 * Phase 3 / Lesson 4.13 — A paused child must NOT short-circuit the wait
 * loop. Paused != failed; the child can resume on user/parent action.
 *
 * Concretely: while `child.paused === true && child.archived === false`,
 * the harness keeps polling. Only an external archive (success terminal or
 * shelved-dupe) or `active.cancelled` exits the wait.
 *
 * This test exercises the real polling loop with a real GoalStore, swapping
 * the goal's `paused` flag mid-wait and then flipping it to "ready-to-merge
 * passed" to verify the wait completes only after the gate passes.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — paused child keeps waiting (Lesson 4.13)", () => {
	it("paused live child does NOT exit the wait loop until ready-to-merge passes", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		// Pre-create a live child so we go straight to the wait branch.
		const planId = "p-pause";
		fx.goalStore.put({
			id: "paused-child", title: "P", cwd: fx.tmpRoot,
			state: "in-progress", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			paused: true,
		} as any);

		// Use the REAL wait loop (no test seam) so we exercise the polling
		// path and the paused-child guard.
		(fx.harness as any)._subgoalHooks = {
			setupChildAndStartTeam: async () => {},
			waitForReadyToMerge: undefined, // force real path
		};

		const step = buildSubgoalStep({ planId, title: "P" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);

		let resolved = false;
		const promise = fx.harness.runSubgoalStep(step, signal, active, stepIndex)
			.then(r => { resolved = true; return r; });

		// Wait long enough that the wait loop has polled at least twice.
		await new Promise(r => setTimeout(r, 1200));
		assert.equal(resolved, false,
			"paused child + no ready-to-merge yet → wait loop must NOT have exited");

		// Now flip ready-to-merge to passed; the wait loop's next tick should resolve.
		fx.gateStore.initGatesForGoal("paused-child", ["ready-to-merge"]);
		fx.gateStore.updateGateStatus("paused-child", "ready-to-merge", "passed");

		const result = await promise;
		assert.equal(result.passed, true,
			"once ready-to-merge passes the harness should proceed to merge + archive");
	});

	it("paused → unpaused → archived externally with state=complete → success terminal", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-pause-then-archive";
		fx.goalStore.put({
			id: "auto-archive", title: "AA", cwd: fx.tmpRoot,
			state: "in-progress", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			paused: true,
		} as any);
		(fx.harness as any)._subgoalHooks = {
			setupChildAndStartTeam: async () => {},
			waitForReadyToMerge: undefined,
		};

		const step = buildSubgoalStep({ planId, title: "AA" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		const promise = fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		// Mid-wait: external code archives the child as state=complete.
		setTimeout(() => {
			fx.goalStore.update("auto-archive", { state: "complete", paused: false });
			fx.goalStore.archive("auto-archive");
		}, 600);

		const result = await promise;
		assert.equal(result.passed, true);
		assert.match(result.output, /already complete|during wait/i);
	});
});
