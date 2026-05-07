/**
 * Unit tests for plan-synthesis (Phase 5b — explicit dependsOn DAG).
 *
 * Covers:
 *  - Living-plan mode: explicit dependsOn → topological depth
 *  - Two no-deps children → both column 0, no edges implied
 *  - B depends on A → A=0, B=1
 *  - Cycle → no infinite loop, depths default to 0
 *  - Formal-plan mode: verbatim copy + childGoalId resolution
 *  - Formal-plan + ad-hoc orphans appended; deps span both
 *  - planId derivation rules: formalPlanId / spawnedFromPlanId / synth:<childId>
 *  - childGoalId picked from spawnedFromPlanId match
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildPlanSteps,
	computeDepth,
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
		dependsOnPlanIds: over.dependsOnPlanIds,
	};
}

describe("plan-synthesis — living plan (explicit dependsOn)", () => {
	it("two children with no deps → both column 0", () => {
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "a", createdAt: 0, spawnedFromPlanId: "planA" }),
				child({ id: "b", createdAt: 10, spawnedFromPlanId: "planB" }),
			],
		});
		assert.equal(steps.length, 2);
		assert.deepEqual(steps.map(s => s.phase), [0, 0]);
		assert.deepEqual(steps.map(s => s.dependsOn), [[], []]);
	});

	it("B depends on A → A column 0, B column 1", () => {
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "a", createdAt: 0, spawnedFromPlanId: "planA" }),
				child({ id: "b", createdAt: 10, spawnedFromPlanId: "planB", dependsOnPlanIds: ["planA"] }),
			],
		});
		assert.equal(steps.find(s => s.planId === "planA")!.phase, 0);
		assert.equal(steps.find(s => s.planId === "planB")!.phase, 1);
		assert.deepEqual(steps.find(s => s.planId === "planB")!.dependsOn, ["planA"]);
	});

	it("chain A ← B ← C → columns 0, 1, 2", () => {
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "a", createdAt: 0, spawnedFromPlanId: "planA" }),
				child({ id: "b", createdAt: 10, spawnedFromPlanId: "planB", dependsOnPlanIds: ["planA"] }),
				child({ id: "c", createdAt: 20, spawnedFromPlanId: "planC", dependsOnPlanIds: ["planB"] }),
			],
		});
		const byId = new Map(steps.map(s => [s.planId, s]));
		assert.equal(byId.get("planA")!.phase, 0);
		assert.equal(byId.get("planB")!.phase, 1);
		assert.equal(byId.get("planC")!.phase, 2);
	});

	it("cycle (A↔B) → no crash, defaults to depth 0", () => {
		// Defence in depth — synthesis should never spin or throw on a cycle.
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "a", createdAt: 0, spawnedFromPlanId: "planA", dependsOnPlanIds: ["planB"] }),
				child({ id: "b", createdAt: 10, spawnedFromPlanId: "planB", dependsOnPlanIds: ["planA"] }),
			],
		});
		assert.equal(steps.length, 2);
		// both default to depth 0 in the cycle
		assert.deepEqual(steps.map(s => s.phase), [0, 0]);
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

	it("INCLUDES archived children in living plan (renderer decides display state)", () => {
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "a", createdAt: 0 }),
				child({ id: "b", createdAt: 10, archived: true }),
			],
		});
		assert.equal(steps.length, 2);
		assert.deepEqual(steps.map(s => s.childGoalId), ["a", "b"]);
	});

	it("unknown dep ref filtered out at synthesis (depth 0)", () => {
		// API rejects unknown refs upstream; synthesis defends.
		const steps = buildPlanSteps({
			childGoals: [
				child({ id: "b", createdAt: 0, spawnedFromPlanId: "planB", dependsOnPlanIds: ["does-not-exist"] }),
			],
		});
		assert.equal(steps.length, 1);
		assert.equal(steps[0].phase, 0);
	});
});

describe("plan-synthesis — formal plan (explicit dependsOn)", () => {
	it("returns formal verbatim, childGoalId resolved from spawnedFromPlanId", () => {
		const formal: FormalPlanStep[] = [
			{ planId: "p1", title: "First", spec: "spec1" },
			{ planId: "p2", title: "Second", spec: "spec2", dependsOn: ["p1"] },
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
		assert.equal(steps[0].phase, 0);
		assert.equal(steps[0].childGoalId, "g1");
		assert.equal(steps[1].planId, "p2");
		assert.equal(steps[1].phase, 1);
		assert.deepEqual(steps[1].dependsOn, ["p1"]);
		assert.equal(steps[1].childGoalId, "g2");
	});

	it("formal-plan + orphans → orphans appended; depth from explicit deps", () => {
		const formal: FormalPlanStep[] = [
			{ planId: "p1", title: "First" },
			{ planId: "p2", title: "Second", dependsOn: ["p1"] },
		];
		const steps = buildPlanSteps({
			formalSteps: formal,
			childGoals: [
				child({ id: "g1", createdAt: 0, spawnedFromPlanId: "p1" }),
				// orphan ad-hoc that depends on a formal step
				child({ id: "orphan-a", createdAt: 100, spawnedFromPlanId: "orphan-plan-a", dependsOnPlanIds: ["p2"] }),
				// orphan with no deps
				child({ id: "orphan-b", createdAt: 200 }),
			],
		});
		// 2 formal + 2 orphans
		assert.equal(steps.length, 4);
		const byId = new Map(steps.map(s => [s.planId, s]));
		assert.equal(byId.get("p1")!.phase, 0);
		assert.equal(byId.get("p2")!.phase, 1);
		// orphan-a depends on p2 → column 2
		assert.equal(byId.get("orphan-plan-a")!.phase, 2);
		// orphan-b has no deps → column 0 (parallel sibling, even alongside formal steps)
		assert.equal(byId.get("synth:orphan-b")!.phase, 0);
	});

	it("childGoalId undefined when no matching child exists", () => {
		const steps = buildPlanSteps({
			formalSteps: [{ planId: "p1", title: "T1" }],
			childGoals: [],
		});
		assert.equal(steps.length, 1);
		assert.equal(steps[0].childGoalId, undefined);
		assert.equal(steps[0].phase, 0);
	});

	it("most-recent matching child wins when planId has dupes", () => {
		const steps = buildPlanSteps({
			formalSteps: [{ planId: "p1", title: "T1" }],
			childGoals: [
				child({ id: "old", createdAt: 100, spawnedFromPlanId: "p1" }),
				child({ id: "new", createdAt: 200, spawnedFromPlanId: "p1" }),
			],
		});
		assert.equal(steps[0].childGoalId, "new");
	});
});

describe("plan-synthesis — computeDepth", () => {
	it("empty input → empty map", () => {
		const d = computeDepth([]);
		assert.equal(d.size, 0);
	});

	it("single root → depth 0", () => {
		const d = computeDepth([{ planId: "a", dependsOn: [] }]);
		assert.equal(d.get("a"), 0);
	});

	it("diamond A ← {B,C} ← D → 0,1,1,2", () => {
		const d = computeDepth([
			{ planId: "a", dependsOn: [] },
			{ planId: "b", dependsOn: ["a"] },
			{ planId: "c", dependsOn: ["a"] },
			{ planId: "d", dependsOn: ["b", "c"] },
		]);
		assert.equal(d.get("a"), 0);
		assert.equal(d.get("b"), 1);
		assert.equal(d.get("c"), 1);
		assert.equal(d.get("d"), 2);
	});

	it("self-dep filtered (defence in depth) → depth 0", () => {
		const d = computeDepth([
			{ planId: "a", dependsOn: ["a"] },
		]);
		assert.equal(d.get("a"), 0);
	});
});
