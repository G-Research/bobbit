/**
 * Finding 1 (harness half) — durable `mergeConflict` flag on the child goal.
 *
 * When a child merge hits a conflict in runSubgoalStep, the child goal record
 * must persist `mergeConflict: true` (data contract consumed by GET
 * /descendants and the Plan tab). A subsequent successful merge clears it back
 * to `false`. The child is preserved (not auto-archived) on conflict.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

function findChild(fx: Awaited<ReturnType<typeof buildFixture>>): any {
	return fx.goalStore.getAll().find(g => g.parentGoalId === fx.parent.id);
}

describe("runSubgoalStep — durable mergeConflict flag", () => {
	it("merge conflict → child record persists mergeConflict=true (preserved, not archived)", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		fx.setMergeOutcome({ conflict: true, output: "CONFLICT (content): merge conflict in file.txt" });

		const step = buildSubgoalStep({ planId: "p-conflict-durable" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, false);
		const child = findChild(fx);
		assert.ok(child, "child goal must exist (preserved on conflict)");
		assert.equal(child.mergeConflict, true, "child must carry durable mergeConflict=true");
		assert.notEqual(child.archived, true, "conflict must NOT auto-archive the child");
	});

	it("successful re-merge clears mergeConflict back to false", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		// First run: conflict stamps mergeConflict=true.
		fx.setMergeOutcome({ conflict: true, output: "CONFLICT" });
		const step = buildSubgoalStep({ planId: "p-remerge" });
		const a1 = buildActive(fx.parent.id);
		await fx.harness.runSubgoalStep(step, a1.signal, a1.active, a1.stepIndex);

		const childAfterConflict = findChild(fx);
		assert.equal(childAfterConflict.mergeConflict, true);

		// Second run resolves to the SAME live child (tier resolution) and the
		// merge now succeeds → mergeConflict cleared.
		fx.setMergeOutcome({ merged: true });
		const a2 = buildActive(fx.parent.id);
		const result = await fx.harness.runSubgoalStep(step, a2.signal, a2.active, a2.stepIndex);

		assert.equal(result.passed, true);
		// The child is archived after a successful merge; the flag was cleared
		// BEFORE archive, so the persisted record reflects mergeConflict=false.
		const child = fx.goalStore.getAll().find(g => g.parentGoalId === fx.parent.id);
		assert.ok(child, "child still resolvable after merge");
		assert.equal(child.mergeConflict, false, "successful merge must clear mergeConflict");
	});
});
