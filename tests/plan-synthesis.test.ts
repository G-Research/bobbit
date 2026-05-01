/**
 * Pinned regression: living-plan synthesis from live children.
 *
 * Post-PR #409 user feedback: "Brisket has no Plan tab (by-design)"
 * felt wrong. The Plan tab is a powerful visualisation regardless of
 * workflow. Even goals on `general` / `feature` / `bug-fix` that
 * spawn children ad-hoc via `goal_spawn_child` have an implicit plan
 * \u2014 the children themselves. The Plan tab now synthesises one when
 * no formal plan exists.
 *
 * Living-document property: every render recomputes from the live
 * goals tree, so plan-evolution is automatic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	clusterChildrenIntoPhases,
	synthesizePlanStepsFromChildren,
	buildPlanSteps,
	isAdHocPlan,
	type PlanSynthChildLike,
	type PlanStepLike,
} from "../src/app/plan-synthesis.js";

const child = (over: Partial<PlanSynthChildLike> & Pick<PlanSynthChildLike, "id">): PlanSynthChildLike => ({
	parentGoalId: "p1",
	archived: false,
	createdAt: 1_000_000_000_000,
	...over,
});

const formalStep = (planId: string, phase: number, title = planId): PlanStepLike => ({
	type: "subgoal",
	name: title,
	phase,
	subgoal: { planId, title, phase },
});

describe("clusterChildrenIntoPhases", () => {
	it("clusters children created within the window into the same phase", () => {
		// Three children spawned within 30s of each other \u2014 should be ONE phase.
		const t = 1_700_000_000_000;
		const children = [
			child({ id: "a", createdAt: t }),
			child({ id: "b", createdAt: t + 10_000 }),
			child({ id: "c", createdAt: t + 30_000 }),
		];
		const phases = clusterChildrenIntoPhases(children, 60_000);
		assert.equal(phases.length, 1, "all three in one phase");
		assert.equal(phases[0].length, 3);
	});

	it("starts a new phase when gap exceeds the window", () => {
		// First two within 30s, third 5 minutes later \u2014 two phases.
		const t = 1_700_000_000_000;
		const children = [
			child({ id: "a", createdAt: t }),
			child({ id: "b", createdAt: t + 30_000 }),
			child({ id: "c", createdAt: t + 5 * 60_000 }),
		];
		const phases = clusterChildrenIntoPhases(children, 60_000);
		assert.equal(phases.length, 2);
		assert.equal(phases[0].length, 2);
		assert.equal(phases[1].length, 1);
	});

	it("each child in its own phase when all gaps exceed window", () => {
		const t = 1_700_000_000_000;
		const children = [
			child({ id: "a", createdAt: t }),
			child({ id: "b", createdAt: t + 5 * 60_000 }),
			child({ id: "c", createdAt: t + 10 * 60_000 }),
		];
		const phases = clusterChildrenIntoPhases(children, 60_000);
		assert.equal(phases.length, 3);
	});

	it("empty input returns empty phases", () => {
		assert.deepEqual(clusterChildrenIntoPhases([], 60_000), []);
	});
});

describe("synthesizePlanStepsFromChildren", () => {
	it("builds one step per non-archived child of the parent", () => {
		const t = 1_700_000_000_000;
		const goals: PlanSynthChildLike[] = [
			child({ id: "c1", parentGoalId: "p1", title: "Storage", createdAt: t }),
			child({ id: "c2", parentGoalId: "p1", title: "Policy", createdAt: t + 1000 }),
			// Archived child \u2014 excluded.
			child({ id: "c-old", parentGoalId: "p1", archived: true, createdAt: t - 60_000 }),
			// Different parent \u2014 excluded.
			child({ id: "other", parentGoalId: "p2", createdAt: t }),
		];
		const steps = synthesizePlanStepsFromChildren("p1", goals);
		assert.equal(steps.length, 2);
		assert.deepEqual(steps.map(s => s.subgoal!.title).sort(), ["Policy", "Storage"]);
	});

	it("uses spawnedFromPlanId for planId when set, synthesises 'auto:<id>' otherwise", () => {
		const goals: PlanSynthChildLike[] = [
			child({ id: "c1", title: "Storage", spawnedFromPlanId: "v0.1-storage" }),
			child({ id: "c2", title: "Adhoc" }),
		];
		const steps = synthesizePlanStepsFromChildren("p1", goals);
		const planIds = steps.map(s => s.subgoal!.planId);
		assert.ok(planIds.includes("v0.1-storage"), "uses real planId when present");
		assert.ok(planIds.some(p => p.startsWith("auto:c2")), "synthesises auto: prefix otherwise");
	});

	it("returns [] when no non-archived children exist", () => {
		const goals: PlanSynthChildLike[] = [
			child({ id: "c-old", parentGoalId: "p1", archived: true }),
		];
		assert.deepEqual(synthesizePlanStepsFromChildren("p1", goals), []);
	});

	it("assigns sequential phase numbers (1, 2, 3) by createdAt clusters", () => {
		const t = 1_700_000_000_000;
		const goals: PlanSynthChildLike[] = [
			child({ id: "c1", title: "Phase1A", createdAt: t }),
			child({ id: "c2", title: "Phase1B", createdAt: t + 30_000 }),
			child({ id: "c3", title: "Phase2A", createdAt: t + 5 * 60_000 }),
		];
		const steps = synthesizePlanStepsFromChildren("p1", goals);
		const byTitle = Object.fromEntries(steps.map(s => [s.subgoal!.title, s.phase]));
		assert.equal(byTitle.Phase1A, 1);
		assert.equal(byTitle.Phase1B, 1);
		assert.equal(byTitle.Phase2A, 2);
	});

	it("links each synthetic step to its child via subgoal.childGoalId (so node-state resolution works)", () => {
		const goals: PlanSynthChildLike[] = [
			child({ id: "c1-id", title: "Storage" }),
		];
		const steps = synthesizePlanStepsFromChildren("p1", goals);
		assert.equal(steps[0].subgoal!.childGoalId, "c1-id");
	});
});

describe("buildPlanSteps \u2014 formal + ad-hoc composition", () => {
	it("when no formal plan exists, returns the synthesis unchanged", () => {
		const goals: PlanSynthChildLike[] = [
			child({ id: "c1", title: "C1" }),
		];
		const formal: PlanStepLike[] = [];
		const composed = buildPlanSteps("p1", formal, goals);
		assert.equal(composed.length, 1);
		assert.equal(composed[0].subgoal!.title, "C1");
	});

	it("when formal plan exists with NO orphans, returns the formal plan unchanged", () => {
		const goals: PlanSynthChildLike[] = [
			child({ id: "c1", spawnedFromPlanId: "v0.1-storage" }),
		];
		const formal: PlanStepLike[] = [formalStep("v0.1-storage", 1, "Storage")];
		const composed = buildPlanSteps("p1", formal, goals);
		assert.deepEqual(composed, formal);
	});

	it("when formal plan exists with orphan children, appends them in a phase past the highest formal phase", () => {
		// Two formal phases (1, 2). One orphan child not tied to any
		// planId. Should slot into phase 3.
		const t = 1_700_000_000_000;
		const goals: PlanSynthChildLike[] = [
			child({ id: "c1", spawnedFromPlanId: "v0.1-storage", createdAt: t }),
			child({ id: "orphan", title: "Adhoc", createdAt: t + 60 * 60_000 }),
		];
		const formal: PlanStepLike[] = [
			formalStep("v0.1-storage", 1, "Storage"),
			formalStep("v0.1-rest-cli", 2, "Rest CLI"),
		];
		const composed = buildPlanSteps("p1", formal, goals);
		assert.equal(composed.length, 3, "2 formal + 1 orphan");
		const orphanStep = composed.find(s => s.subgoal!.title === "Adhoc");
		assert.ok(orphanStep, "orphan included");
		assert.equal(orphanStep!.phase, 3, "orphan slotted past formal max phase 2");
	});

	it("multiple orphans cluster among themselves into successive phases past the formal max", () => {
		const t = 1_700_000_000_000;
		const goals: PlanSynthChildLike[] = [
			child({ id: "o1", title: "Orphan1", createdAt: t }),
			child({ id: "o2", title: "Orphan2", createdAt: t + 30_000 }), // same cluster
			child({ id: "o3", title: "Orphan3", createdAt: t + 5 * 60_000 }), // new cluster
		];
		const formal: PlanStepLike[] = [formalStep("v0.1-x", 2, "X")];
		const composed = buildPlanSteps("p1", formal, goals);
		const phasesByTitle = Object.fromEntries(
			composed.filter(s => s.subgoal!.title.startsWith("Orphan"))
				.map(s => [s.subgoal!.title, s.phase])
		);
		// Formal max phase = 2; orphans start at phase 3.
		assert.equal(phasesByTitle.Orphan1, 3);
		assert.equal(phasesByTitle.Orphan2, 3);
		assert.equal(phasesByTitle.Orphan3, 4);
	});
});

describe("isAdHocPlan", () => {
	it("true when no formal steps but at least one child", () => {
		assert.equal(isAdHocPlan([], 1), true);
		assert.equal(isAdHocPlan([], 5), true);
	});

	it("false when formal plan exists", () => {
		assert.equal(isAdHocPlan([formalStep("v0.1-x", 1)], 0), false);
		assert.equal(isAdHocPlan([formalStep("v0.1-x", 1)], 5), false);
	});

	it("false when no formal plan AND no children (empty state)", () => {
		assert.equal(isAdHocPlan([], 0), false);
	});
});
