/**
 * Unit tests for `resolveWorkflowForGoal`.
 *
 * Exercises the four-tier resolution order (own inline → ancestor inline
 * walk → cascade) and the goal-not-found / no-match cases.
 *
 * See `docs/design/nested-goals.md` §7.1.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import type { Workflow } from "../src/server/agent/workflow-store.ts";
import type { ConfigCascade, ResolvedItem } from "../src/server/agent/config-cascade.ts";
import { resolveWorkflowForGoal } from "../src/server/agent/workflow-resolution.ts";

let stateDir: string;
beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-resolution-"));
});

function wf(id: string, name = id, hidden = false): Workflow {
	return {
		id,
		name,
		description: `${id} desc`,
		gates: [],
		createdAt: 0,
		updatedAt: 0,
		hidden,
	};
}

function mkGoal(over: Partial<PersistedGoal> & { id: string }): PersistedGoal {
	return {
		title: `t-${over.id}`,
		cwd: "/tmp",
		state: "todo",
		spec: "",
		createdAt: 0,
		updatedAt: 0,
		...over,
	} as PersistedGoal;
}

/** Minimal ConfigCascade stub — only `resolveWorkflows` is consulted. */
function fakeCascade(workflows: Workflow[], by: "builtin" | "server" | "project" = "project"): ConfigCascade {
	const items: ResolvedItem<Workflow>[] = workflows.map(w => ({ item: w, origin: by }));
	return {
		resolveWorkflows: (_projectId?: string) => items,
	} as unknown as ConfigCascade;
}

describe("resolveWorkflowForGoal", () => {
	it("returns undefined when the goal does not exist", () => {
		const store = new GoalStore(stateDir);
		const cascade = fakeCascade([wf("feature")]);
		assert.equal(resolveWorkflowForGoal(store, cascade, "missing", "feature"), undefined);
	});

	it("returns the goal's own inlineWorkflow when no workflowId is requested", () => {
		const store = new GoalStore(stateDir);
		const inline = wf("custom-flow");
		store.put(mkGoal({ id: "g1", inlineWorkflow: inline }));
		const cascade = fakeCascade([]);
		const out = resolveWorkflowForGoal(store, cascade, "g1");
		assert.strictEqual(out, inline);
	});

	it("returns own inlineWorkflow when its id matches the requested workflowId", () => {
		const store = new GoalStore(stateDir);
		const inline = wf("custom-flow");
		store.put(mkGoal({ id: "g1", inlineWorkflow: inline }));
		const cascade = fakeCascade([wf("custom-flow", "shadowed")]);
		const out = resolveWorkflowForGoal(store, cascade, "g1", "custom-flow");
		assert.strictEqual(out, inline, "own inline must shadow the cascade entry of the same id");
	});

	it("falls through to cascade when own inlineWorkflow id does not match the requested id", () => {
		const store = new GoalStore(stateDir);
		const inline = wf("other-flow");
		store.put(mkGoal({ id: "g1", inlineWorkflow: inline }));
		const wanted = wf("feature");
		const cascade = fakeCascade([wanted]);
		const out = resolveWorkflowForGoal(store, cascade, "g1", "feature");
		assert.strictEqual(out, wanted);
	});

	it("walks the ancestor chain (closest-first) for a matching inlineWorkflow", () => {
		// 3-level tree: root → child → grandchild
		// Root and grandparent each define their own custom flow with the
		// same id; the closer ancestor (parent) must win.
		const store = new GoalStore(stateDir);
		const rootInline = wf("custom-flow", "root-defined");
		const parentInline = wf("custom-flow", "parent-defined");
		store.put(mkGoal({ id: "root", rootGoalId: "root", inlineWorkflow: rootInline }));
		store.put(mkGoal({ id: "parent", parentGoalId: "root", rootGoalId: "root", inlineWorkflow: parentInline }));
		store.put(mkGoal({ id: "leaf", parentGoalId: "parent", rootGoalId: "root" }));

		const cascade = fakeCascade([wf("custom-flow", "cascade-defined")]);
		const out = resolveWorkflowForGoal(store, cascade, "leaf", "custom-flow");
		assert.strictEqual(out, parentInline, "closest ancestor must shadow further ancestors and cascade");
	});

	it("falls through to cascade when no ancestor inline matches", () => {
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "root", rootGoalId: "root" }));
		store.put(mkGoal({ id: "child", parentGoalId: "root", rootGoalId: "root" }));

		const wanted = wf("feature");
		const cascade = fakeCascade([wanted]);
		const out = resolveWorkflowForGoal(store, cascade, "child", "feature");
		assert.strictEqual(out, wanted);
	});

	it("returns undefined when no inline and cascade has no match", () => {
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "g1" }));
		const cascade = fakeCascade([wf("other")]);
		const out = resolveWorkflowForGoal(store, cascade, "g1", "feature");
		assert.equal(out, undefined);
	});

	it("returns undefined when no workflowId is given and the goal has no inline", () => {
		// Without a key there is nothing to match against in the cascade.
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "g1" }));
		const cascade = fakeCascade([wf("feature")]);
		assert.equal(resolveWorkflowForGoal(store, cascade, "g1"), undefined);
	});

	it("resolves from cascade for a project-only workflow when there are no inline overrides", () => {
		// Independently exercises the cascade layer even though
		// fake-cascade does not differentiate origins for selection.
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "g1", projectId: "p1" }));
		const projectFlow = wf("project-flow");
		const cascade = fakeCascade([projectFlow], "project");
		const out = resolveWorkflowForGoal(store, cascade, "g1", "project-flow");
		assert.strictEqual(out, projectFlow);
	});

	it("resolves a server-layer workflow via the cascade when no inline match", () => {
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "g1" }));
		const serverFlow = wf("server-flow");
		const cascade = fakeCascade([serverFlow], "server");
		const out = resolveWorkflowForGoal(store, cascade, "g1", "server-flow");
		assert.strictEqual(out, serverFlow);
	});

	it("resolves a builtin-layer workflow via the cascade when no inline match", () => {
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "g1" }));
		const builtinFlow = wf("builtin-flow");
		const cascade = fakeCascade([builtinFlow], "builtin");
		const out = resolveWorkflowForGoal(store, cascade, "g1", "builtin-flow");
		assert.strictEqual(out, builtinFlow);
	});

	it("inline override on a child shadows a project-cascade workflow with the same id", () => {
		const store = new GoalStore(stateDir);
		const inline = wf("feature", "child-custom");
		store.put(mkGoal({ id: "root", rootGoalId: "root" }));
		store.put(mkGoal({ id: "child", parentGoalId: "root", rootGoalId: "root", inlineWorkflow: inline }));
		const projectFlow = wf("feature", "project-version");
		const cascade = fakeCascade([projectFlow], "project");
		const out = resolveWorkflowForGoal(store, cascade, "child", "feature");
		assert.strictEqual(out, inline, "own inline must override project layer");
	});
});
