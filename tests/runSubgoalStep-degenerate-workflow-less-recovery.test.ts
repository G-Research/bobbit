/**
 * Phase 3 / Lesson 4.4 — Workflow-less complete child recovery.
 *
 * SUBGOALS-SPEC §5: pre-fix children created without a workflow (Lesson 4.3
 * defect) end up stuck — state=complete, archived=null, workflow=null. They
 * never naturally reach ready-to-merge. The harness recovers them by trying
 * mergeChild directly + archiveAfterMerge.
 *
 * Predicate is conjunctive AND narrow:
 *   state === "complete" && !archived && !workflow
 *
 * Each variation that misses one of those three conditions does NOT trigger
 * the recovery branch.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { buildFixture, buildActive, buildSubgoalStep } from "./helpers/run-subgoal-step-fixture.ts";

describe("runSubgoalStep — Lesson 4.4: workflow-less complete child recovery", () => {
	it("on workflow-less complete child → mergeChild + teardownTeam + archiveAfterMerge are invoked", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-degen";
		fx.goalStore.put({
			id: "degen", title: "Degen", cwd: fx.tmpRoot,
			state: "complete", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			// archived=undefined, workflow=undefined → triggers recovery.
		} as any);

		const step = buildSubgoalStep({ planId, title: "Degen" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, true);
		assert.match(result.output, /workflow-less complete child/i);

		// All three recovery actions ran.
		const merged = fx.calls.find(c => c.kind === "mergeChild");
		assert.ok(merged && merged.kind === "mergeChild");
		assert.equal(merged.parentId, fx.parent.id);
		assert.equal(merged.childId, "degen");

		const tornDown = fx.calls.find(c => c.kind === "teardownTeam");
		assert.ok(tornDown);

		const archived = fx.calls.find(c => c.kind === "archiveGoalAfterMerge");
		assert.ok(archived && archived.kind === "archiveGoalAfterMerge");
		assert.equal(archived.childId, "degen");
	});

	it("on conflict during workflow-less recovery → step fails with manual-recovery message", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-degen-conflict";
		fx.goalStore.put({
			id: "degen2", title: "Degen2", cwd: fx.tmpRoot,
			state: "complete", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);
		fx.setMergeOutcome({ conflict: true, output: "<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>>\n" });

		const step = buildSubgoalStep({ planId, title: "Degen2" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, false);
		assert.match(result.output, /merge conflict|manual recovery|conflict/i);
		// No teardownTeam, no archiveAfterMerge — work preserved (anti-pattern §9).
		assert.equal(fx.calls.find(c => c.kind === "teardownTeam"), undefined);
		assert.equal(fx.calls.find(c => c.kind === "archiveGoalAfterMerge"), undefined);
	});

	it("predicate is conjunctive — state=complete + archived → falls into success terminal short-circuit, NOT recovery", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-archived-complete";
		fx.goalStore.put({
			id: "archived-complete", title: "AC", cwd: fx.tmpRoot,
			state: "complete", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			archived: true, archivedAt: 2,
		} as any);

		const step = buildSubgoalStep({ planId, title: "AC" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		assert.equal(result.passed, true);
		// No mergeChild — the success terminal short-circuited.
		assert.equal(fx.calls.find(c => c.kind === "mergeChild"), undefined);
	});

	it("predicate is conjunctive — state=complete + has workflow → does NOT recover, runs through normal wait+merge", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-with-wf";
		fx.goalStore.put({
			id: "withwf", title: "W", cwd: fx.tmpRoot,
			state: "complete", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
			workflow: { id: "feature", name: "Feature", description: "", gates: [], createdAt: 0, updatedAt: 0 } as any,
		} as any);

		const step = buildSubgoalStep({ planId, title: "W" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		// Falls into the normal wait + merge path (default hook returns "passed").
		assert.equal(result.passed, true);
		// Output is "Subgoal merged + archived" — NOT "Recovered workflow-less"
		assert.doesNotMatch(result.output, /workflow-less/i);
	});

	it("predicate is conjunctive — state=todo + !archived + !workflow → does NOT trigger recovery", async () => {
		const fx = await buildFixture();
		after(() => fx.cleanup());

		const planId = "p-todo";
		fx.goalStore.put({
			id: "todo-no-wf", title: "T", cwd: fx.tmpRoot,
			state: "todo", spec: "", createdAt: 1, updatedAt: 1,
			parentGoalId: fx.parent.id, spawnedFromPlanId: planId,
		} as any);

		const step = buildSubgoalStep({ planId, title: "T" });
		const { signal, active, stepIndex } = buildActive(fx.parent.id, planId);
		const result = await fx.harness.runSubgoalStep(step, signal, active, stepIndex);

		// Recovery did NOT fire (state is todo, not complete).
		assert.doesNotMatch(result.output, /workflow-less/i);
	});
});
