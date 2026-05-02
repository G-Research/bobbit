/**
 * Unit tests for plan-synthesis (Phase 5a, Lesson 4.20).
 *
 * Covers:
 *  - Living-plan mode (no formalSteps): clustering by createdAt gap
 *  - Formal-plan mode: verbatim copy + childGoalId resolution
 *  - Formal-plan + ad-hoc orphans appended past max formal phase
 *  - Phase indices increment correctly
 *  - Custom phaseClusterGapMs honored
 *  - planId derivation rules: formalPlanId / spawnedFromPlanId / synth:<childId>
 *  - childGoalId picked from spawnedFromPlanId match
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildPlanSteps,
	type FormalPlanStep,
	type SynthesisGoal,
} from "../src/app/plan-synthesis.ts";

function child(over: Partial<SynthesisGoal> & { id: string; createdAt: number }): SynthesisGoal {
	return {
		id: over.id,
		parentGoalId: over.parentGoalId ?? "root",
		spawnedFromPlanId: over.spawnedFromPlanId,
		createdAt: over.createdAt,
		state: over.state ?? "todo",
		archived: over.archived,
		title: over.title ?? `Child ${over.id}`,
		workflowId: over.workflowId,
	};
}

const SECOND = 1_000;
const MINUTE = 60_000;

describe("plan-synthesis — living plan (no formal)", () => {
	it("3 children within 60s → 1 phase, 3 steps in createdAt order", () => {
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "a", createdAt: 0 }),
				child({ id: "b", createdAt: 10 * SECOND }),
				child({ id: "c", createdAt: 30 * SECOND }),
			],
		});
		assert.equal(steps.length, 3);
		assert.deepEqual(steps.map(s => s.phase), [0, 0, 0]);
		assert.deepEqual(steps.map(s => s.childGoalId), ["a", "b", "c"]);
	});

	it("2 + 60s gap + 2 → 2 phases of 2", () => {
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "a", createdAt: 0 }),
				child({ id: "b", createdAt: 10 * SECOND }),
				// gap > 60s
				child({ id: "c", createdAt: 90 * SECOND }),
				child({ id: "d", createdAt: 100 * SECOND }),
			],
		});
		assert.deepEqual(steps.map(s => s.phase), [0, 0, 1, 1]);
	});

	it("custom phaseClusterGapMs honored", () => {
		const steps = buildPlanSteps({
			phaseClusterGapMs: 5 * SECOND,
			childGoals: [
				child({ id: "a", createdAt: 0 }),
				// > 5s gap
				child({ id: "b", createdAt: 7 * SECOND }),
			],
		});
		assert.deepEqual(steps.map(s => s.phase), [0, 1]);
	});

	it("planId derivation: spawnedFromPlanId set → use it; else synth:<childId>", () => {
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "a", createdAt: 0, spawnedFromPlanId: "planA" }),
				child({ id: "b", createdAt: 1 }),
			],
		});
		assert.equal(steps[0].planId, "planA");
		assert.equal(steps[1].planId, "synth:b");
	});

	it("excludes archived children from living plan", () => {
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "a", createdAt: 0 }),
				child({ id: "b", createdAt: 10, archived: true }),
			],
		});
		assert.equal(steps.length, 1);
		assert.equal(steps[0].childGoalId, "a");
	});
});

describe("plan-synthesis — formal plan", () => {
	it("returns formal verbatim, childGoalId resolved from spawnedFromPlanId", () => {
		const formal: FormalPlanStep[] = [
			{ planId: "p1", title: "First", spec: "spec1", phase: 0 },
			{ planId: "p2", title: "Second", spec: "spec2", phase: 1 },
		];
		const steps = buildPlanSteps({
			formalSteps: formal,
			childGoals: [
				child({ id: "g1", createdAt: 0, spawnedFromPlanId: "p1" }),
				child({ id: "g2", createdAt: 10, spawnedFromPlanId: "p2" }),
			],
		});
		assert.equal(steps.length, 2);
		assert.equal(steps[0].planId, "p1");
		assert.equal(steps[0].title, "First");
		assert.equal(steps[0].spec, "spec1");
		assert.equal(steps[0].childGoalId, "g1");
		assert.equal(steps[1].childGoalId, "g2");
	});

	it("formal-plan + orphans → orphans appended past max formal phase", () => {
		const formal: FormalPlanStep[] = [
			{ planId: "p1", title: "First", phase: 0 },
			{ planId: "p2", title: "Second", phase: 2 },
		];
		const steps = buildPlanSteps({
			formalSteps: formal,
			childGoals: [
				// matches p1
				child({ id: "g1", createdAt: 0, spawnedFromPlanId: "p1" }),
				// orphan ad-hoc, no spawnedFromPlanId
				child({ id: "orphan-a", createdAt: MINUTE * 5 }),
				// orphan with unrecognised spawnedFromPlanId
				child({ id: "orphan-b", createdAt: MINUTE * 5 + SECOND, spawnedFromPlanId: "not-in-plan" }),
				// orphan after large gap
				child({ id: "orphan-c", createdAt: MINUTE * 10 }),
			],
		});
		// 2 formal + 3 orphans
		assert.equal(steps.length, 5);
		// orphans must follow formals (formal max phase = 2 → orphans start at 3)
		const orphanSteps = steps.slice(2);
		assert.ok(orphanSteps.every(s => s.phase >= 3));
		// orphan-a + orphan-b clustered (createdAt within 60s) at phase 3
		// orphan-c after 60s+ gap → phase 4
		assert.deepEqual(orphanSteps.map(s => s.phase), [3, 3, 4]);
		// planId derivation per orphan
		assert.equal(orphanSteps[0].planId, "synth:orphan-a");
		assert.equal(orphanSteps[1].planId, "not-in-plan");
		assert.equal(orphanSteps[2].planId, "synth:orphan-c");
		// childGoalId propagated
		assert.deepEqual(orphanSteps.map(s => s.childGoalId), ["orphan-a", "orphan-b", "orphan-c"]);
	});

	it("childGoalId undefined when no matching child exists", () => {
		const steps = buildPlanSteps({
			formalSteps: [{ planId: "p1", title: "T1", phase: 0 }],
			childGoals: [],
		});
		assert.equal(steps.length, 1);
		assert.equal(steps[0].childGoalId, undefined);
	});

	it("most-recent matching child wins when planId has dupes", () => {
		const steps = buildPlanSteps({
			formalSteps: [{ planId: "p1", title: "T1", phase: 0 }],
			childGoals: [
				child({ id: "old", createdAt: 100, spawnedFromPlanId: "p1" }),
				child({ id: "new", createdAt: 200, spawnedFromPlanId: "p1" }),
			],
		});
		assert.equal(steps[0].childGoalId, "new");
	});
});
