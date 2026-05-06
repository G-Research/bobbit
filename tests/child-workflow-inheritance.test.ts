/**
 * Regression: children spawned under a `parent` meta-workflow MUST inherit
 * the workflow's structural scaffold (gates, dependencies, synthesis /
 * ready-to-merge / content gates / custom role references) but NOT the
 * parent-specific subgoal entries in `execution.verify[]`. Inheriting the
 * subgoal entries made each child re-execute the parent's plan — Lincoln
 * Logix bug. Skipping inheritance entirely produced a different bug: the
 * child fell back to the project's `feature` workflow (Design Doc →
 * Implementation → Docs → Ready) which doesn't match the parent's
 * Execution → Synthesis → Ready shape.
 *
 * Fix: `stripSubgoalStepsForChildInheritance()` inherits with surgical
 * strip of parent subgoal verify-steps. Both `server.ts::POST
 * /api/goals/:id/spawn-child` and `runSubgoalStep` route through it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	isParentMetaWorkflow,
	stripSubgoalStepsForChildInheritance,
	type Workflow,
} from "../src/server/agent/workflow-store.ts";

describe("isParentMetaWorkflow", () => {
	it("returns true when workflow id is 'parent'", () => {
		const wf: Workflow = {
			id: "parent",
			name: "Parent",
			description: "",
			gates: [{ id: "execution", name: "Execution", dependsOn: [] }],
			createdAt: 0, updatedAt: 0,
		};
		assert.equal(isParentMetaWorkflow(wf), true);
	});

	it("returns true when execution gate has any subgoal verify-step", () => {
		const wf: Workflow = {
			id: "memory-exploration-parent",
			name: "Memory Exploration",
			description: "",
			gates: [{
				id: "execution", name: "Execution", dependsOn: [],
				verify: [
					{ name: "Child A", type: "subgoal", subgoal: { planId: "child-a", title: "Child A", spec: "" } },
				],
			}],
			createdAt: 0, updatedAt: 0,
		};
		assert.equal(isParentMetaWorkflow(wf), true);
	});

	it("returns false for regular feature workflow", () => {
		const wf: Workflow = {
			id: "feature",
			name: "Feature",
			description: "",
			gates: [
				{ id: "design-doc", name: "Design", dependsOn: [] },
				{ id: "implementation", name: "Implementation", dependsOn: ["design-doc"], verify: [
					{ name: "Build", type: "command", run: "npm run build" },
				]},
				{ id: "ready-to-merge", name: "Ready", dependsOn: ["implementation"] },
			],
			createdAt: 0, updatedAt: 0,
		};
		assert.equal(isParentMetaWorkflow(wf), false);
	});

	it("returns false for undefined/null", () => {
		assert.equal(isParentMetaWorkflow(undefined), false);
		assert.equal(isParentMetaWorkflow(null), false);
	});

	it("returns false when execution gate exists but has no subgoal steps", () => {
		const wf: Workflow = {
			id: "simple",
			name: "Simple",
			description: "",
			gates: [{
				id: "execution", name: "Execution", dependsOn: [],
				verify: [
					{ name: "Tests", type: "command", run: "npm test" },
					{ name: "Review", type: "llm-review", role: "code-reviewer", prompt: "Review this." },
				],
			}],
			createdAt: 0, updatedAt: 0,
		};
		assert.equal(isParentMetaWorkflow(wf), false);
	});
});

describe("stripSubgoalStepsForChildInheritance", () => {
	it("meta-workflow: drops aggregation gates between execution and ready-to-merge, rewires rtm to depend on execution", () => {
		// Mirrors user's `memory-exploration-parent`: execution has subgoal
		// verify-steps, synthesis aggregates child artefacts (parent-only),
		// ready-to-merge at the end. Children shouldn't inherit synthesis —
		// they can't satisfy "all 5 sibling artefacts exist".
		const wf: Workflow = {
			id: "memory-exploration-parent",
			name: "Memory Exploration (Parent)",
			description: "",
			gates: [
				{
					id: "execution", name: "Execution", dependsOn: [],
					verify: [
						{ name: "Child A", type: "subgoal", subgoal: { planId: "child-a", title: "A", spec: "" } },
						{ name: "Child B", type: "subgoal", subgoal: { planId: "child-b", title: "B", spec: "" } },
						{ name: "Lint", type: "command", run: "npm run lint" },
					],
				},
				{
					id: "synthesis", name: "Synthesis", dependsOn: ["execution"],
					content: true, injectDownstream: true,
					verify: [
						{ name: "All 5 sibling files exist", type: "command", run: "test -s a.md && test -s b.md" },
						{ name: "Synthesis review", type: "llm-review", role: "synthesis-reviewer", prompt: "Review." },
					],
				},
				{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["synthesis"] },
			],
			createdAt: 0, updatedAt: 0,
		};
		const stripped = stripSubgoalStepsForChildInheritance(wf);

		// Synthesis (aggregation gate) dropped
		const ids = stripped.gates.map(g => g.id);
		assert.deepEqual(ids, ["execution", "ready-to-merge"]);

		// ready-to-merge rewired to depend directly on execution
		const rtm = stripped.gates.find(g => g.id === "ready-to-merge")!;
		assert.deepEqual(rtm.dependsOn, ["execution"]);

		// execution: subgoal entries stripped, non-subgoal preserved
		const execVerify = stripped.gates[0].verify!;
		assert.equal(execVerify.length, 1);
		assert.equal(execVerify[0].name, "Lint");
	});

	it("parent builtin: drops integration; rewires ready-to-merge; preserves upstream charter/plan-review/goal-plan", () => {
		const wf: Workflow = {
			id: "parent",
			name: "Parent",
			description: "",
			gates: [
				{ id: "charter", name: "Charter", dependsOn: [], content: true },
				{ id: "plan-review", name: "Plan Review", dependsOn: ["charter"], content: true },
				{ id: "goal-plan", name: "Goal Plan", dependsOn: ["plan-review"], manual: true },
				{ id: "execution", name: "Execution", dependsOn: ["goal-plan"] },
				{ id: "integration", name: "Integration", dependsOn: ["execution"], verify: [
					{ name: "Cross-component integration", type: "llm-review", role: "architect", prompt: "Integrate." },
				]},
				{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["integration"] },
			],
			createdAt: 0, updatedAt: 0,
		};
		const stripped = stripSubgoalStepsForChildInheritance(wf);
		const ids = stripped.gates.map(g => g.id);
		// integration (aggregation) gone; charter/plan-review/goal-plan/execution/ready-to-merge kept.
		assert.deepEqual(ids, ["charter", "plan-review", "goal-plan", "execution", "ready-to-merge"]);
		const rtm = stripped.gates.find(g => g.id === "ready-to-merge")!;
		assert.deepEqual(rtm.dependsOn, ["execution"]);
	});

	it("non-meta workflow: pure deep-clone; nothing stripped", () => {
		const wf: Workflow = {
			id: "feature",
			name: "Feature",
			description: "",
			gates: [
				{ id: "design-doc", name: "Design", dependsOn: [] },
				{
					id: "implementation", name: "Impl", dependsOn: ["design-doc"],
					verify: [{ name: "Build", type: "command", run: "npm run build" }],
				},
			],
			createdAt: 0, updatedAt: 0,
		};
		const cloned = stripSubgoalStepsForChildInheritance(wf);
		assert.deepEqual(cloned, wf);
		cloned.gates[0].name = "Mutated";
		assert.equal(wf.gates[0].name, "Design");
	});

	it("deep clone so caller mutations don't poison the source", () => {
		const wf: Workflow = {
			id: "parent",
			name: "Parent",
			description: "",
			gates: [{
				id: "execution", name: "Execution", dependsOn: [],
				verify: [{ name: "X", type: "subgoal", subgoal: { planId: "x", title: "X", spec: "" } }],
			}],
			createdAt: 0, updatedAt: 0,
		};
		const stripped = stripSubgoalStepsForChildInheritance(wf);
		assert.equal(wf.gates[0].verify!.length, 1);
		assert.equal(wf.gates[0].verify![0].type, "subgoal");
		assert.equal(stripped.gates[0].verify!.length, 0);
	});

	it("multi-branch aggregation: drops every aggregation gate between execution and ready-to-merge", () => {
		const wf: Workflow = {
			id: "parent-multibranch",
			name: "Parent Multi",
			description: "",
			gates: [
				{ id: "execution", name: "Exec", dependsOn: [], verify: [
					{ name: "C1", type: "subgoal", subgoal: { planId: "c1", title: "C1", spec: "" } },
				]},
				{ id: "synthesis", name: "Synth", dependsOn: ["execution"] },
				{ id: "review", name: "Review", dependsOn: ["synthesis"] },
				{ id: "ready-to-merge", name: "Ready", dependsOn: ["review"] },
			],
			createdAt: 0, updatedAt: 0,
		};
		const stripped = stripSubgoalStepsForChildInheritance(wf);
		const ids = stripped.gates.map(g => g.id);
		assert.deepEqual(ids, ["execution", "ready-to-merge"]);
		assert.deepEqual(stripped.gates.find(g => g.id === "ready-to-merge")!.dependsOn, ["execution"]);
	});
});
