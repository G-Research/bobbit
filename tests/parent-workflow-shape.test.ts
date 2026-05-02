/**
 * Phase 3 — `parent` meta-workflow shape.
 *
 * SUBGOALS-SPEC §5: gate sequence is
 *   charter → plan-review → goal-plan → execution → integration → ready-to-merge
 *
 * goal-plan is `manual: true` (no verify[]) — signaled by the team-lead to
 * freeze the execution gate's verify[]. The `execution` gate's verify[] starts
 * EMPTY; the team-lead populates it via propose-and-edit.
 *
 * The four prompt constants are exported for re-use; cover that they exist
 * and the workflow is wired into buildDefaultWorkflows().
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildParentWorkflow,
	buildDefaultWorkflows,
	CHARTER_REVIEW_PROMPT,
	PLAN_STRUCTURAL_PROMPT,
	CRITERIA_COVERAGE_PROMPT,
	INTEGRATION_PROMPT,
	readyToMergeGate,
} from "../src/server/state-migration/seed-default-workflows.ts";

test("buildParentWorkflow: gate sequence is charter → plan-review → goal-plan → execution → integration → ready-to-merge", () => {
	const wf = buildParentWorkflow();
	assert.equal(wf.id, "parent");
	const ids = wf.gates.map(g => g.id);
	assert.deepEqual(ids, ["charter", "plan-review", "goal-plan", "execution", "integration", "ready-to-merge"]);
});

test("buildParentWorkflow: dependency edges are sequential between gates", () => {
	const wf = buildParentWorkflow();
	const byId = new Map(wf.gates.map(g => [g.id, g]));
	assert.deepEqual(byId.get("charter")?.depends_on ?? [], []);
	assert.deepEqual(byId.get("plan-review")?.depends_on, ["charter"]);
	assert.deepEqual(byId.get("goal-plan")?.depends_on, ["plan-review"]);
	assert.deepEqual(byId.get("execution")?.depends_on, ["goal-plan"]);
	assert.deepEqual(byId.get("integration")?.depends_on, ["execution"]);
	assert.deepEqual(byId.get("ready-to-merge")?.depends_on, ["integration"]);
});

test("buildParentWorkflow: goal-plan gate is manual (no verify[])", () => {
	const wf = buildParentWorkflow();
	const gp = wf.gates.find(g => g.id === "goal-plan");
	assert.equal(gp?.manual, true, "goal-plan must be manual:true so the team-lead signals to freeze the plan");
	assert.equal(gp?.verify, undefined, "goal-plan should not declare verify[] — manual signal only");
});

test("buildParentWorkflow: execution.verify[] starts empty (populated by team-lead via propose+edit)", () => {
	const wf = buildParentWorkflow();
	const exec = wf.gates.find(g => g.id === "execution");
	assert.ok(exec, "execution gate must exist");
	assert.deepEqual(exec!.verify ?? [], [], "execution.verify[] must start empty — the project assistant designs subgoal steps");
});

test("buildParentWorkflow: charter / plan-review / integration each have their named verify steps", () => {
	const wf = buildParentWorkflow();
	const charter = wf.gates.find(g => g.id === "charter");
	assert.equal(charter?.verify?.length, 1);
	assert.equal(charter?.verify?.[0].type, "llm-review");
	assert.equal(charter?.verify?.[0].name, "Charter review");

	const planReview = wf.gates.find(g => g.id === "plan-review");
	assert.equal(planReview?.verify?.length, 2);
	const planNames = planReview?.verify?.map(v => v.name) ?? [];
	assert.ok(planNames.includes("Plan structural sanity"));
	assert.ok(planNames.includes("Acceptance criteria coverage"));

	const integration = wf.gates.find(g => g.id === "integration");
	assert.equal(integration?.verify?.length, 1);
	assert.equal(integration?.verify?.[0].name, "Cross-component integration");
});

test("buildParentWorkflow: ready-to-merge reuses readyToMergeGate() shape but depends on integration", () => {
	const wf = buildParentWorkflow();
	const rtm = wf.gates.find(g => g.id === "ready-to-merge");
	const reused = readyToMergeGate();
	// Verify-step list is reused verbatim.
	assert.deepEqual(rtm?.verify, reused.verify);
	// But depends_on is rewired off integration (not the documentation gate).
	assert.deepEqual(rtm?.depends_on, ["integration"]);
});

test("buildDefaultWorkflows includes parent workflow alongside general/feature/bug-fix/quick-fix", () => {
	const wfs = buildDefaultWorkflows("myapp");
	assert.ok(wfs.parent, "buildDefaultWorkflows must include `parent`");
	assert.equal(wfs.parent.id, "parent");
	// Sibling workflows still present.
	assert.ok(wfs.general);
	assert.ok(wfs.feature);
	assert.ok(wfs["bug-fix"]);
	assert.ok(wfs["quick-fix"]);
});

test("Prompt constants are concise (3-6 sentences each per spec §5)", () => {
	for (const [label, text] of [
		["CHARTER_REVIEW_PROMPT", CHARTER_REVIEW_PROMPT],
		["PLAN_STRUCTURAL_PROMPT", PLAN_STRUCTURAL_PROMPT],
		["CRITERIA_COVERAGE_PROMPT", CRITERIA_COVERAGE_PROMPT],
		["INTEGRATION_PROMPT", INTEGRATION_PROMPT],
	] as const) {
		assert.ok(text.length > 50, `${label} too short`);
		assert.ok(text.length < 1500, `${label} is too long (${text.length} chars) — keep prompts concise`);
	}
});
