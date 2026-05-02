/**
 * Phase 4 — `DELETE /api/goals/:id?cascade=` semantics, exercised at the
 * GoalManager / store level. The HTTP handler walks descendants via a
 * BFS over the goal store and archives each one; this file tests that
 * walk + the `archiveGoal` chain produces the expected end-state.
 *
 * Cases:
 *   1. Cascade=false with no descendants → archives the goal.
 *   2. Cascade=false with descendants → handler should 409 (we test the
 *      descendant-detection invariant).
 *   3. Cascade=true → walks descendants deepest-first, archives each.
 *   4. listDescendants is BFS over parentGoalId.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-archive-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeManager(): { gm: GoalManager; store: GoalStore } {
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{ id: "feature", name: "Feature", description: "", gates: [{ id: "g", name: "G", dependsOn: [] }], createdAt: 0, updatedAt: 0 }]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

/** Mirror of the route's listDescendants helper. */
function listDescendants(store: GoalStore, goalId: string): PersistedGoal[] {
	const all = store.getAll();
	const out: PersistedGoal[] = [];
	const seen = new Set<string>([goalId]);
	const queue: string[] = [goalId];
	while (queue.length > 0) {
		const cur = queue.shift()!;
		for (const g of all) {
			if (g.parentGoalId === cur && !seen.has(g.id)) {
				seen.add(g.id);
				out.push(g);
				queue.push(g.id);
			}
		}
	}
	return out;
}

describe("cascade-archive REST primitives", () => {
	it("listDescendants returns BFS over parentGoalId", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const c1 = await gm.createGoal("C1", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const c2 = await gm.createGoal("C2", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const gc1 = await gm.createGoal("GC1", tmpRoot, { workflowId: "feature", parentGoalId: c1.id });

		const descendants = listDescendants(store, root.id);
		const ids = descendants.map(g => g.id).sort();
		assert.deepEqual(ids.sort(), [c1.id, c2.id, gc1.id].sort());
		// BFS: c1 + c2 come before gc1.
		const c1Index = descendants.findIndex(g => g.id === c1.id);
		const gc1Index = descendants.findIndex(g => g.id === gc1.id);
		assert.ok(c1Index < gc1Index, "c1 must come before gc1 in BFS");
	});

	it("cascade=false with no descendants: descendant count is 0", async () => {
		const { gm, store } = makeManager();
		const lone = await gm.createGoal("Lone", tmpRoot, { workflowId: "feature" });
		assert.equal(listDescendants(store, lone.id).length, 0);
	});

	it("cascade=false with descendants: handler should 409 (we verify count > 0)", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		await gm.createGoal("C1", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const descendants = listDescendants(store, root.id);
		assert.equal(descendants.length, 1, "must have a descendant to trigger 409 in handler");
	});

	it("cascade=true: walks descendants deepest-first and archives each", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const c1 = await gm.createGoal("C1", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		const gc1 = await gm.createGoal("GC1", tmpRoot, { workflowId: "feature", parentGoalId: c1.id });

		const descendants = listDescendants(store, root.id);
		// Mirror the handler: deepest-first via reverse, then archive each, then parent.
		const archiveOrder = [...descendants].reverse();
		archiveOrder.push(store.get(root.id)!);

		const archivedOrder: string[] = [];
		for (const g of archiveOrder) {
			await gm.archiveGoal(g.id);
			archivedOrder.push(g.id);
		}

		// All archived.
		for (const id of [root.id, c1.id, gc1.id]) {
			const g = store.get(id);
			assert.equal(g?.archived, true, `${id} should be archived`);
		}
		// Deepest-first: GC1 was archived before C1, and C1 before root.
		assert.ok(archivedOrder.indexOf(gc1.id) < archivedOrder.indexOf(c1.id));
		assert.ok(archivedOrder.indexOf(c1.id) < archivedOrder.indexOf(root.id));
	});

	it("archiving descendants does not affect siblings of an unrelated tree", async () => {
		const { gm, store } = makeManager();
		const tree1 = await gm.createGoal("Tree1", tmpRoot, { workflowId: "feature" });
		const tree2 = await gm.createGoal("Tree2", tmpRoot, { workflowId: "feature" });
		const c1 = await gm.createGoal("C1", tmpRoot, { workflowId: "feature", parentGoalId: tree1.id });

		const descendants = listDescendants(store, tree1.id);
		assert.deepEqual(descendants.map(g => g.id), [c1.id]);
		// Tree2 must not appear.
		assert.equal(descendants.find(g => g.id === tree2.id), undefined);
	});
});
