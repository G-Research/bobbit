/**
 * Pause-semantics consolidation — `state: 'blocked'` discipline.
 *
 * After the v3 consolidation, the scheduler uses `state: 'blocked'` for
 * dep-blocked children — not `paused: true`. Operator pause is the ONLY
 * writer of `paused`. These tests pin that contract.
 *
 *  - Boot migration: legacy `paused: true` with unresolved deps becomes
 *    `state: 'blocked', paused: false`. Operator-paused (no deps or all
 *    resolved) is preserved.
 *  - GoalState type accepts 'blocked'.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pause-blocked-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeWfStore(): InlineWorkflowStore {
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "feature",
		name: "Feature",
		description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0,
		updatedAt: 0,
	}]);
	return wf;
}

describe("pause semantics: state='blocked' for dep-blocked children", () => {
	it("setting state='blocked' via updateGoal persists and reads back", async () => {
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store, makeWfStore());
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		await gm.updateGoal(root.id, { state: "blocked" });
		assert.equal(store.get(root.id)?.state, "blocked");
		assert.notEqual(store.get(root.id)?.paused, true);
	});

	it("blocked state can be transitioned back to 'todo' (auto-unblock)", async () => {
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store, makeWfStore());
		const g = await gm.createGoal("G", tmpRoot, { workflowId: "feature" });
		await gm.updateGoal(g.id, { state: "blocked" });
		await gm.updateGoal(g.id, { state: "todo" });
		assert.equal(store.get(g.id)?.state, "todo");
	});

	it("paused=true and state='blocked' are orthogonal", async () => {
		// Operator could pause a blocked child; resume should clear paused
		// without touching the scheduler-managed 'blocked' state.
		const store = new GoalStore(stateDir);
		const gm = new GoalManager(store, makeWfStore());
		const g = await gm.createGoal("G", tmpRoot, { workflowId: "feature" });
		await gm.updateGoal(g.id, { state: "blocked", paused: true });
		assert.equal(store.get(g.id)?.state, "blocked");
		assert.equal(store.get(g.id)?.paused, true);
		// Resume clears paused only.
		await gm.updateGoal(g.id, { paused: false });
		assert.equal(store.get(g.id)?.state, "blocked");
		assert.notEqual(store.get(g.id)?.paused, true);
	});
});

describe("pause semantics: boot migration (legacy paused-deps → state='blocked')", () => {
	it("migrates paused=true + unresolved deps to state='blocked', paused=false", async () => {
		// Seed: a paused child whose dep is NOT complete.
		const seedStore = new GoalStore(stateDir);
		const seedGm = new GoalManager(seedStore, makeWfStore());
		const parent = await seedGm.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const depSib = await seedGm.createGoal("Dep", tmpRoot, { workflowId: "feature", parentGoalId: parent.id });
		await seedGm.updateGoal(depSib.id, { spawnedFromPlanId: "dep-plan", state: "in-progress" });
		const blockedChild = await seedGm.createGoal("Blocked", tmpRoot, { workflowId: "feature", parentGoalId: parent.id });
		await seedGm.updateGoal(blockedChild.id, {
			spawnedFromPlanId: "blocked-plan",
			dependsOnPlanIds: ["dep-plan"],
			paused: true, // legacy bug: scheduler set paused for dep-blocked child
		});

		// Re-construct a GoalManager → boot migration runs.
		const freshStore = new GoalStore(stateDir);
		void new GoalManager(freshStore, makeWfStore());
		const migrated = freshStore.get(blockedChild.id);
		assert.equal(migrated?.state, "blocked", "blocked child should be migrated to state='blocked'");
		assert.notEqual(migrated?.paused, true, "blocked child should no longer be paused");
	});

	it("preserves operator-paused goals (no deps or all resolved)", async () => {
		const seedStore = new GoalStore(stateDir);
		const seedGm = new GoalManager(seedStore, makeWfStore());
		// Operator-paused root: no deps at all.
		const root = await seedGm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		await seedGm.updateGoal(root.id, { paused: true });
		// Operator-paused child whose dep IS complete.
		const parent = await seedGm.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const depSib = await seedGm.createGoal("Dep", tmpRoot, { workflowId: "feature", parentGoalId: parent.id });
		await seedGm.updateGoal(depSib.id, { spawnedFromPlanId: "dep-plan", state: "complete" });
		const child = await seedGm.createGoal("Child", tmpRoot, { workflowId: "feature", parentGoalId: parent.id });
		await seedGm.updateGoal(child.id, {
			spawnedFromPlanId: "child-plan",
			dependsOnPlanIds: ["dep-plan"],
			paused: true,
		});

		// Boot migration.
		const freshStore = new GoalStore(stateDir);
		void new GoalManager(freshStore, makeWfStore());

		assert.equal(freshStore.get(root.id)?.paused, true, "root operator-pause preserved");
		assert.equal(freshStore.get(child.id)?.paused, true, "child operator-pause preserved (deps resolved)");
		assert.notEqual(freshStore.get(child.id)?.state, "blocked");
	});
});
