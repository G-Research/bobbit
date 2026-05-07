/**
 * Phase 5 — `PATCH /api/goals/:id/plan` validates explicit `dependsOn`
 * references on the proposed plan via `validatePlanDependsOn` before
 * routing through the mutation classifier.
 *
 * The pure validator + classifier interaction is covered in-process here
 * (mirrors `api-goals-plan-mutation.test.ts`'s style — handler-shape unit
 * test, no HTTP server).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validatePlanDependsOn } from "../src/server/agent/depends-on-validation.ts";
import { classifyMutation, type ClassifierPlanStep } from "../src/server/agent/plan-mutation.ts";

function step(planId: string, opts: Partial<ClassifierPlanStep> = {}): ClassifierPlanStep {
	return {
		planId,
		title: opts.title ?? `Title ${planId}`,
		spec: opts.spec ?? `spec for ${planId}`,
		phase: opts.phase,
		dependsOn: opts.dependsOn,
		subgoal: opts.subgoal ?? {
			planId,
			title: opts.title ?? `Title ${planId}`,
			spec: opts.spec ?? `spec for ${planId}`,
			...(opts.dependsOn !== undefined ? { dependsOn: opts.dependsOn } : {}),
		},
	};
}

describe("PATCH /api/goals/:id/plan — dependsOn validation", () => {
	it("rejects SELF_DEPENDENCY", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["a"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "SELF_DEPENDENCY");
	});

	it("rejects UNKNOWN_PLAN_ID", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["zzz"] },
			{ planId: "b" },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) {
			assert.equal(r.code, "UNKNOWN_PLAN_ID");
			assert.deepEqual(r.missing, ["zzz"]);
		}
	});

	it("rejects DEPENDS_ON_CYCLE", () => {
		const r = validatePlanDependsOn([
			{ planId: "a", dependsOn: ["b"] },
			{ planId: "b", dependsOn: ["a"] },
		]);
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "DEPENDS_ON_CYCLE");
	});

	it("happy path: linear chain validates", () => {
		const r = validatePlanDependsOn([
			{ planId: "a" },
			{ planId: "b", dependsOn: ["a"] },
			{ planId: "c", dependsOn: ["b"] },
		]);
		assert.equal(r.ok, true);
	});

	it("happy path: classifier sees fix-up when adding a step with deps", () => {
		// New step with deps on existing → expansion (new column past max).
		const current: ClassifierPlanStep[] = [step("a", { phase: 0 })];
		const proposed: ClassifierPlanStep[] = [
			step("a", { phase: 0 }),
			step("b", { phase: 0, subgoal: { planId: "b", title: "Title b", spec: "spec for b", dependsOn: ["a"] } }),
		];
		const v = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		// Adding a new step at phase 0 with no phase-bump → fix-up.
		assert.equal(v.kind, "fix-up");
		assert.ok(v.diff.added.includes("b"));
	});

	it("dependsOn change on existing step \u2192 restructure (severity bump)", () => {
		const current: ClassifierPlanStep[] = [
			step("a", { phase: 0 }),
			step("b", { phase: 0, subgoal: { planId: "b", title: "Title b", spec: "spec for b", dependsOn: [] } }),
		];
		const proposed: ClassifierPlanStep[] = [
			step("a", { phase: 0 }),
			step("b", { phase: 0, subgoal: { planId: "b", title: "Title b", spec: "spec for b", dependsOn: ["a"] } }),
		];
		const v = classifyMutation({
			current,
			proposed,
			rootAcceptanceCriteria: [],
			rootSpec: "",
		});
		assert.equal(v.kind, "restructure");
	});
});
