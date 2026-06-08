/**
 * Phase 3 — concurrency semaphore (SUBGOALS-SPEC §3.5).
 *
 * All `runSubgoalStep` invocations across one tree share a single semaphore
 * keyed by `rootGoalId`. Permits resolved via
 * `goalManager.resolveRootMaxConcurrentChildren(rootGoalId)`. Default 3,
 * hard max 8.
 *
 * Test asserts that with maxConcurrentChildren=2 and five plan steps under
 * the same root, at most 2 are running concurrently — the third waits until
 * one completes.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

/**
 * Deterministic concurrency probe. Each in-flight hook increments a counter,
 * records the running peak, then BLOCKS on a shared barrier until either the
 * expected peak is simultaneously occupied (all `expectedPeak` permit slots
 * held at once) or a short safety timeout fires.
 *
 * This removes the timing dependence of a fixed `setTimeout` sleep: under
 * parallel CPU load a sleep-based hook could let an earlier step's timer fire
 * and free its permit before the last slot was acquired, under-counting the
 * peak (observed flake: cap=5 measured 4). With the barrier, a CORRECT
 * semaphore deterministically parks exactly `expectedPeak` steps at once; an
 * over-admitting one drives the peak above `expectedPeak`; an under-admitting
 * one never reaches the barrier and the safety timeout releases it so the
 * assertion fails (instead of hanging). All three are detected without relying
 * on wall-clock timing.
 */
function makeConcurrencyProbe(expectedPeak: number) {
	let inFlight = 0;
	let maxObserved = 0;
	let release!: () => void;
	const gate = new Promise<void>(r => { release = r; });
	const safety = setTimeout(() => release(), 2000);
	(safety as { unref?: () => void }).unref?.();
	const hook = async (): Promise<"passed"> => {
		inFlight++;
		maxObserved = Math.max(maxObserved, inFlight);
		if (inFlight >= expectedPeak) { clearTimeout(safety); release(); }
		await gate;
		inFlight--;
		return "passed";
	};
	return { hook, getMax: () => maxObserved };
}

describe("runSubgoalStep — concurrency semaphore (§3.5)", () => {
	it("at most maxConcurrentChildren steps run simultaneously across the tree", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		// Cap = 2.
		fx.goalStore.update(fx.parent.id, { maxConcurrentChildren: 2 });
		assert.equal(fx.goalManager.resolveRootMaxConcurrentChildren(fx.parent.id), 2);

		// Barrier-based probe: parks all in-flight steps until the cap is
		// simultaneously occupied (deterministic, no wall-clock dependence).
		const probe = makeConcurrencyProbe(2);
		fx.setReadyToMergeHook(probe.hook);

		// Spawn five plan steps in parallel — all under the same parent root.
		const steps = [0, 1, 2, 3, 4].map(i => buildSubgoalStep({ planId: `p-${i}`, title: `Leaf ${i}` }));
		const actives = steps.map(() => buildActive(fx.parent.id));

		const results = await Promise.all(steps.map((s, i) =>
			fx.harness.runSubgoalStep(s, actives[i].signal, actives[i].active, 0),
		));

		assert.equal(results.every(r => r.passed), true);
		assert.equal(probe.getMax(), 2,
			`semaphore must cap concurrency at 2, observed peak ${probe.getMax()}`);
	});

	it("uses default cap=5 when maxConcurrentChildren is unset on root", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		// No maxConcurrentChildren set on parent.
		assert.equal(fx.goalManager.resolveRootMaxConcurrentChildren(fx.parent.id), 5);

		const probe = makeConcurrencyProbe(5);
		fx.setReadyToMergeHook(probe.hook);

		const steps = [0, 1, 2, 3, 4, 5, 6].map(i => buildSubgoalStep({ planId: `d-${i}`, title: `Leaf ${i}` }));
		const actives = steps.map(() => buildActive(fx.parent.id));
		await Promise.all(steps.map((s, i) =>
			fx.harness.runSubgoalStep(s, actives[i].signal, actives[i].active, 0),
		));

		assert.equal(probe.getMax(), 5, `default cap=5, observed peak ${probe.getMax()}`);
	});

	it("clamps user-supplied cap above 8 to the hard max of 8", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		fx.goalStore.update(fx.parent.id, { maxConcurrentChildren: 100 });
		assert.equal(fx.goalManager.resolveRootMaxConcurrentChildren(fx.parent.id), 8);
	});

	it("the semaphore is shared across runSubgoalStep invocations for the same rootGoalId", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		fx.goalStore.update(fx.parent.id, { maxConcurrentChildren: 1 });

		const probe = makeConcurrencyProbe(1);
		fx.setReadyToMergeHook(probe.hook);

		// Two parallel steps on the same parent — second must wait for first.
		const stepA = buildSubgoalStep({ planId: "a", title: "A" });
		const stepB = buildSubgoalStep({ planId: "b", title: "B" });
		const aA = buildActive(fx.parent.id);
		const aB = buildActive(fx.parent.id);

		await Promise.all([
			fx.harness.runSubgoalStep(stepA, aA.signal, aA.active, 0),
			fx.harness.runSubgoalStep(stepB, aB.signal, aB.active, 0),
		]);

		assert.equal(probe.getMax(), 1,
			`with cap=1 the semaphore must serialise siblings, observed peak ${probe.getMax()}`);
	});
});
