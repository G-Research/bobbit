/**
 * R-003 — `resolveChildWorkflow` cascade tier coverage.
 *
 * Cascade order:
 *   1. body.workflow                 (full inline workflow object)
 *   2. body.workflowId / sg.workflowId (looked up in workflow store)
 *   3. parent.workflow               (deep-cloned + stripped)
 *   4. workflow store "feature"
 *   5. first non-hidden in workflow store
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	resolveChildWorkflow,
} from "../src/server/agent/spawn-child-workflow.ts";
import type { PersistedGoal } from "../src/server/agent/goal-store.ts";
import type {
	Workflow,
	WorkflowStore,
	VerifyStepSubgoal,
} from "../src/server/agent/workflow-store.ts";

function wf(id: string, hidden = false): Workflow {
	return {
		id,
		name: id,
		description: "",
		gates: [
			{ id: "execution", name: "Execution", dependsOn: [] },
			{ id: "ready-to-merge", name: "Ready to Merge", dependsOn: ["execution"] },
		],
		createdAt: 0,
		updatedAt: 0,
		...(hidden ? { hidden: true } : {}),
	};
}

function makeStore(workflows: Workflow[]): WorkflowStore {
	const map = new Map<string, Workflow>(workflows.map(w => [w.id, w]));
	return {
		get: (id: string) => map.get(id),
		getAll: () => Array.from(map.values()),
	} as unknown as WorkflowStore;
}

function makeParent(over: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id: "parent",
		title: "Parent",
		cwd: "/tmp",
		state: "in-progress",
		spec: "",
		createdAt: 0,
		updatedAt: 0,
		...over,
	} as PersistedGoal;
}

function sg(over: Partial<VerifyStepSubgoal> = {}): VerifyStepSubgoal {
	return {
		planId: "p1",
		title: "Child",
		spec: "",
		...over,
	};
}

describe("resolveChildWorkflow — cascade tiers", () => {
	it("Tier 1: body.workflow wins over everything else", () => {
		const inline = wf("custom-inline");
		const store = makeStore([wf("feature"), wf("general")]);
		const parent = makeParent({ workflow: wf("parent-wf") });

		const r = resolveChildWorkflow(parent, sg({ workflowId: "general" }), { workflow: inline }, store);
		assert.equal(r.workflowId, "custom-inline");
		assert.ok(r.workflow);
		assert.equal(r.workflow!.id, "custom-inline");
		// Confirm it's a deep clone, not the same reference.
		assert.notEqual(r.workflow, inline);
	});

	it("Tier 2: body.workflowId resolved from store wins over parent workflow + sg.workflowId", () => {
		const store = makeStore([wf("general"), wf("feature")]);
		const parent = makeParent({ workflow: wf("parent-wf") });

		const r = resolveChildWorkflow(parent, sg({ workflowId: "feature" }), { workflowId: "general" }, store);
		assert.equal(r.workflowId, "general");
		// Tier 2 returns id only — no snapshot.
		assert.equal(r.workflow, undefined);
	});

	it("Tier 2: sg.workflowId is honoured when body.workflowId is absent", () => {
		const store = makeStore([wf("feature"), wf("general")]);
		const parent = makeParent({ workflow: wf("parent-wf") });

		const r = resolveChildWorkflow(parent, sg({ workflowId: "general" }), undefined, store);
		assert.equal(r.workflowId, "general");
		assert.equal(r.workflow, undefined);
	});

	it("Tier 2 fall-through: unresolvable id falls through to parent.workflow inheritance (Tier 3)", () => {
		const store = makeStore([wf("feature")]);
		const parent = makeParent({ workflow: wf("inherited") });

		const r = resolveChildWorkflow(parent, sg({ workflowId: "does-not-exist" }), undefined, store);
		assert.equal(r.workflowId, "inherited");
		assert.ok(r.workflow);
	});

	it("Tier 3: inherits parent.workflow as a deep clone (not the same ref)", () => {
		const store = makeStore([wf("feature")]);
		const parentWf = wf("inherited-meta");
		const parent = makeParent({ workflow: parentWf });

		const r = resolveChildWorkflow(parent, sg(), undefined, store);
		assert.equal(r.workflowId, "inherited-meta");
		assert.ok(r.workflow);
		assert.notEqual(r.workflow, parentWf, "must be deep-cloned");
		assert.notEqual(r.workflow!.gates, parentWf.gates, "gates array must be cloned");
	});

	it("Tier 3: parent meta workflow has its subgoal verify-steps stripped on inheritance", () => {
		const parentMeta: Workflow = {
			id: "parent-meta",
			name: "Parent Meta",
			description: "",
			gates: [
				{
					id: "execution",
					name: "Execution",
					dependsOn: [],
					verify: [
						{ name: "phase-1", type: "subgoal", subgoal: { planId: "p1", title: "X", spec: "" } },
						{ name: "lint", type: "command", run: "npm run lint" },
					],
				},
				{ id: "ready-to-merge", name: "RTM", dependsOn: ["execution"] },
			],
			createdAt: 0, updatedAt: 0,
		};
		const parent = makeParent({ workflow: parentMeta });
		const store = makeStore([wf("feature")]);

		const r = resolveChildWorkflow(parent, sg(), undefined, store);
		assert.ok(r.workflow);
		const exec = r.workflow!.gates.find(g => g.id === "execution");
		assert.ok(exec);
		const subgoalSteps = (exec!.verify ?? []).filter(s => s.type === "subgoal");
		assert.equal(subgoalSteps.length, 0, "parent subgoal verify-steps must be stripped");
		// Parent's original isn't mutated.
		const parentExec = parentMeta.gates.find(g => g.id === "execution")!;
		const parentSubgoals = (parentExec.verify ?? []).filter(s => s.type === "subgoal");
		assert.equal(parentSubgoals.length, 1, "parent workflow must not be mutated by the helper");
	});

	it("Tier 4: 'feature' workflow from store when no inline / inherited is available", () => {
		const store = makeStore([wf("feature"), wf("general")]);
		const parent = makeParent(); // no parent.workflow

		const r = resolveChildWorkflow(parent, sg(), undefined, store);
		assert.equal(r.workflowId, "feature");
		assert.equal(r.workflow, undefined);
	});

	it("Tier 5: first non-hidden workflow in store when 'feature' is absent", () => {
		const store = makeStore([wf("hidden-one", true), wf("custom-default"), wf("alt")]);
		const parent = makeParent();

		const r = resolveChildWorkflow(parent, sg(), undefined, store);
		assert.equal(r.workflowId, "custom-default");
	});

	it("Tier 5: skips hidden workflows when picking the fallback", () => {
		const store = makeStore([wf("hidden-only", true)]);
		const parent = makeParent();

		assert.throws(() => {
			resolveChildWorkflow(parent, sg(), undefined, store);
		}, /no workflow available/);
	});

	it("throws when no tier resolves (no inline, no inherited, no store)", () => {
		const parent = makeParent();
		assert.throws(() => {
			resolveChildWorkflow(parent, sg(), undefined, undefined);
		}, /no workflow available/);
	});

	it("body.workflow without an id is ignored (treated as malformed)", () => {
		// id-less workflow shouldn't satisfy tier 1; falls through.
		const store = makeStore([wf("feature")]);
		const parent = makeParent();
		const malformed = { name: "no-id", description: "", gates: [], createdAt: 0, updatedAt: 0 } as unknown as Workflow;

		const r = resolveChildWorkflow(parent, sg(), { workflow: malformed }, store);
		assert.equal(r.workflowId, "feature");
	});
});
