/**
 * Plan-tab per-node gate status + merge/conflict propagation (Phase 5c).
 *
 * Pins the contract that `buildPlanSteps` (plan-synthesis.ts) carries the
 * resolved child's `gateStatus` and `mergeConflict` onto each emitted
 * PlanStep — an ADDITIONAL display dimension orthogonal to the tier-based
 * state resolution. The renderer (goal-dashboard-plan-tab.ts) reads these
 * to draw the gate-status dot (`plan-node-gate-dot`) and the
 * `plan-node-conflict-pill`.
 *
 * Covered:
 *  - living plan: gateStatus + mergeConflict propagate from resolved child
 *  - formal plan: gateStatus + mergeConflict propagate from resolved child
 *  - orphan child in a formal plan propagates its own fields
 *  - absent fields stay undefined (legacy payloads unaffected)
 *  - tier-based `resolvePlanNodeChild` carries the new fields through
 *    WITHOUT altering tier selection (additive dimension)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPlanSteps, type SynthesisGoal } from "../src/app/plan-synthesis.ts";
import { resolvePlanNodeChild, type PlanNodeChild } from "../src/app/plan-node-state.ts";

function child(over: Partial<SynthesisGoal> & { id: string; title: string }): SynthesisGoal {
	return {
		id: over.id,
		title: over.title,
		createdAt: over.createdAt ?? 0,
		state: over.state ?? "in-progress",
		parentGoalId: over.parentGoalId,
		spawnedFromPlanId: over.spawnedFromPlanId,
		archived: over.archived,
		paused: over.paused,
		dependsOnPlanIds: over.dependsOnPlanIds,
		mergeConflict: over.mergeConflict,
		gateStatus: over.gateStatus,
	};
}

describe("buildPlanSteps — gateStatus + mergeConflict propagation (living plan)", () => {
	it("propagates gateStatus and mergeConflict from the resolved child", () => {
		const childGoals: SynthesisGoal[] = [
			child({ id: "c1", title: "Running child", parentGoalId: "P", spawnedFromPlanId: "p1", state: "in-progress", gateStatus: "running", createdAt: 1 }),
			child({ id: "c2", title: "Conflicted child", parentGoalId: "P", spawnedFromPlanId: "p2", state: "in-progress", gateStatus: "failed", mergeConflict: true, createdAt: 2 }),
		];
		const steps = buildPlanSteps({ childGoals });
		const s1 = steps.find(s => s.planId === "p1")!;
		const s2 = steps.find(s => s.planId === "p2")!;
		assert.equal(s1.gateStatus, "running");
		assert.equal(s1.mergeConflict, undefined);
		assert.equal(s2.gateStatus, "failed");
		assert.equal(s2.mergeConflict, true);
	});

	it("leaves gateStatus + mergeConflict undefined for legacy payloads", () => {
		const childGoals: SynthesisGoal[] = [
			child({ id: "c1", title: "Legacy child", parentGoalId: "P", spawnedFromPlanId: "p1", state: "todo", createdAt: 1 }),
		];
		const steps = buildPlanSteps({ childGoals });
		assert.equal(steps[0].gateStatus, undefined);
		assert.equal(steps[0].mergeConflict, undefined);
	});
});

describe("buildPlanSteps — gateStatus + mergeConflict propagation (formal plan)", () => {
	it("propagates from the resolved child onto its formal step", () => {
		const childGoals: SynthesisGoal[] = [
			child({ id: "fc1", title: "Live formal child", parentGoalId: "PF", spawnedFromPlanId: "pf1", state: "in-progress", gateStatus: "passed", createdAt: 1 }),
		];
		const steps = buildPlanSteps({
			formalSteps: [
				{ planId: "pf1", title: "Step one" },
				{ planId: "pf2", title: "Unresolved step" },
			],
			childGoals,
		});
		const resolved = steps.find(s => s.planId === "pf1")!;
		const unresolved = steps.find(s => s.planId === "pf2")!;
		assert.equal(resolved.gateStatus, "passed");
		assert.equal(resolved.childGoalId, "fc1");
		// Unresolved formal step has no child -> no gate fields.
		assert.equal(unresolved.gateStatus, undefined);
		assert.equal(unresolved.mergeConflict, undefined);
	});

	it("propagates from an orphan child appended to a formal plan", () => {
		const childGoals: SynthesisGoal[] = [
			child({ id: "orphan", title: "Orphan", parentGoalId: "PF", spawnedFromPlanId: "p-orphan", state: "in-progress", gateStatus: "running", mergeConflict: true, createdAt: 5 }),
		];
		const steps = buildPlanSteps({
			formalSteps: [{ planId: "pf1", title: "Formal step" }],
			childGoals,
		});
		const orphanStep = steps.find(s => s.planId === "p-orphan")!;
		assert.ok(orphanStep, "orphan child must be appended as its own step");
		assert.equal(orphanStep.gateStatus, "running");
		assert.equal(orphanStep.mergeConflict, true);
	});
});

describe("resolvePlanNodeChild — carries gateStatus/mergeConflict without altering tier selection", () => {
	it("returns the same tier winner and exposes its gate fields", () => {
		const candidates: PlanNodeChild[] = [
			// Tier 2 (archived complete) should win over Tier 3 (live todo).
			{ id: "win", spawnedFromPlanId: "p", state: "complete", archived: true, createdAt: 2, gateStatus: "passed", mergeConflict: false },
			{ id: "lose", spawnedFromPlanId: "p", state: "todo", archived: false, createdAt: 9, gateStatus: "pending" },
		];
		const res = resolvePlanNodeChild("p", candidates);
		assert.equal(res.child?.id, "win", "tier selection must be unchanged by the new fields");
		assert.equal(res.state, "complete");
		assert.equal(res.child?.gateStatus, "passed");
		assert.equal(res.child?.mergeConflict, false);
	});
});
