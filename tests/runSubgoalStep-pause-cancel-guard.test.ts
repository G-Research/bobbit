/**
 * Finding 2 — runSubgoalStep must NOT spawn a child after pause/cancel.
 *
 * The harness spawn path historically only checked nesting/spec before
 * `createGoal`; `active.cancelled` was checked too late (in the wait loop)
 * and a paused parent was never checked at all on this path. This pins the
 * guard: when `parent.paused` or `active.cancelled` is set, runSubgoalStep
 * returns WITHOUT calling createGoal — both before acquiring the semaphore
 * and after acquisition (pause/cancel can race during the acquire await).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — pause/cancel guard", () => {
	it("paused parent → returns passed=false without spawning a child", async () => {
		const fx = await buildFixture({ parentOver: { paused: true } });
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "p-paused" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);

		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, false);
		assert.match(result.output, /paused/i);
		assert.equal(fx.calls.filter(c => c.kind === "createGoal").length, 0, "must not call createGoal when parent is paused");
	});

	it("cancelled verification → returns passed=false without spawning a child", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const step = buildSubgoalStep({ planId: "p-cancelled" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		(active as any).cancelled = true;

		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, false);
		assert.match(result.output, /cancel/i);
		assert.equal(fx.calls.filter(c => c.kind === "createGoal").length, 0, "must not call createGoal when cancelled");
	});

	it("pause that lands DURING semaphore acquisition is caught before createGoal", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		// Race: the pre-acquire guard passes (parent not yet paused), but the
		// parent is paused WHILE the semaphore acquire awaits. The post-acquire
		// re-check (immediately before createGoal) must catch it. We simulate
		// the race deterministically by overriding the semaphore-factory to
		// pause the parent inside `acquire()`.
		(fx.harness as any)._acquireRootSubgoalSemaphore = () => ({
			acquire: async () => {
				// Pause lands during the acquire await — after the pre-acquire
				// guard already saw an unpaused parent.
				fx.goalStore.update(fx.parent.id, { paused: true });
			},
			release: () => {},
		});

		const step = buildSubgoalStep({ planId: "p-race" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);

		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, false);
		assert.match(result.output, /paused/i);
		assert.equal(fx.calls.filter(c => c.kind === "createGoal").length, 0, "must not call createGoal when pause races during acquire");
	});
});
