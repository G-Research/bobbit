/**
 * Phase 3 — Cancellation propagates through the wait loop.
 *
 * SUBGOALS-SPEC §2 step 7: when `active.cancelled === true`, the harness
 * exits the wait loop with `{ passed: false, output: "Cancelled" }` within
 * one second.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — cancellation", () => {
	it("active.cancelled flips during wait → returns passed=false output='Cancelled' within 1s", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		// Override the wait hook so it polls active.cancelled rather than auto-passing.
		fx.setReadyToMergeHook(async (_childId, signal) => {
			while (!signal.aborted) {
				await new Promise(r => setTimeout(r, 20));
			}
			return "cancelled";
		});

		const step = buildSubgoalStep({ planId: "p-cancel" });
		const { signal: sgSig, active, stepIndex } = buildActive(fx.parent.id);

		const promise = fx.harness.runSubgoalStep(step, sgSig, active, stepIndex);
		// Flip the cancelled flag mid-wait.
		setTimeout(() => { (active as any).cancelled = true; }, 50);

		const start = Date.now();
		const result = await promise;
		const elapsed = Date.now() - start;

		assert.equal(result.passed, false);
		assert.match(result.output, /cancel/i);
		assert.ok(elapsed < 1000, `must return within 1s, took ${elapsed}ms`);
	});

	it("when cancelled before wait begins → returns passed=false 'Cancelled'", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		fx.setReadyToMergeHook(async () => "cancelled");

		const step = buildSubgoalStep({ planId: "p-precancel" });
		const { signal: sgSig, active, stepIndex } = buildActive(fx.parent.id);
		(active as any).cancelled = true;

		const result = await fx.harness.runSubgoalStep(step, sgSig, active, stepIndex);
		assert.equal(result.passed, false);
		assert.match(result.output, /cancel/i);
	});
});
