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

describe("runSubgoalStep — concurrency semaphore (§3.5)", () => {
	it("at most maxConcurrentChildren steps run simultaneously across the tree", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		// Cap = 2.
		fx.goalStore.update(fx.parent.id, { maxConcurrentChildren: 2 });
		assert.equal(fx.goalManager.resolveRootMaxConcurrentChildren(fx.parent.id), 2);

		// Override the wait hook so each step takes ~150ms — enough to observe
		// the in-flight count without flakes.
		let inFlight = 0;
		let maxObserved = 0;
		fx.setReadyToMergeHook(async () => {
			inFlight++;
			maxObserved = Math.max(maxObserved, inFlight);
			await new Promise(r => setTimeout(r, 150));
			inFlight--;
			return "passed";
		});

		// Spawn five plan steps in parallel — all under the same parent root.
		const steps = [0, 1, 2, 3, 4].map(i => buildSubgoalStep({ planId: `p-${i}`, title: `Leaf ${i}` }));
		const actives = steps.map(() => buildActive(fx.parent.id));

		const results = await Promise.all(steps.map((s, i) =>
			fx.harness.runSubgoalStep(s, actives[i].signal, actives[i].active, 0),
		));

		assert.equal(results.every(r => r.passed), true);
		assert.equal(maxObserved, 2,
			`semaphore must cap concurrency at 2, observed peak ${maxObserved}`);
	});

	it("uses default cap=3 when maxConcurrentChildren is unset on root", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());
		// No maxConcurrentChildren set on parent.
		assert.equal(fx.goalManager.resolveRootMaxConcurrentChildren(fx.parent.id), 3);

		let inFlight = 0;
		let maxObserved = 0;
		fx.setReadyToMergeHook(async () => {
			inFlight++;
			maxObserved = Math.max(maxObserved, inFlight);
			await new Promise(r => setTimeout(r, 100));
			inFlight--;
			return "passed";
		});

		const steps = [0, 1, 2, 3, 4, 5].map(i => buildSubgoalStep({ planId: `d-${i}`, title: `Leaf ${i}` }));
		const actives = steps.map(() => buildActive(fx.parent.id));
		await Promise.all(steps.map((s, i) =>
			fx.harness.runSubgoalStep(s, actives[i].signal, actives[i].active, 0),
		));

		assert.equal(maxObserved, 3, `default cap=3, observed peak ${maxObserved}`);
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

		let inFlight = 0;
		let maxObserved = 0;
		fx.setReadyToMergeHook(async () => {
			inFlight++;
			maxObserved = Math.max(maxObserved, inFlight);
			await new Promise(r => setTimeout(r, 100));
			inFlight--;
			return "passed";
		});

		// Two parallel steps on the same parent — second must wait for first.
		const stepA = buildSubgoalStep({ planId: "a", title: "A" });
		const stepB = buildSubgoalStep({ planId: "b", title: "B" });
		const aA = buildActive(fx.parent.id);
		const aB = buildActive(fx.parent.id);

		await Promise.all([
			fx.harness.runSubgoalStep(stepA, aA.signal, aA.active, 0),
			fx.harness.runSubgoalStep(stepB, aB.signal, aB.active, 0),
		]);

		assert.equal(maxObserved, 1,
			`with cap=1 the semaphore must serialise siblings, observed peak ${maxObserved}`);
	});
});
