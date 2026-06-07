/**
 * Phase 3 — `GoalManager.resolveRootMaxConcurrentChildren`.
 *
 * SUBGOALS-SPEC §3.5: per-tree concurrency cap consulted by `runSubgoalStep`.
 * Default 3, hard max 8 (defensive cap on user input), floor 1 (never zero —
 * would deadlock the harness). Unknown rootGoalId → 3 (defensive).
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
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "max-concurrent-"));
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
	wf.setBuiltins([{
		id: "general", name: "General", description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0, updatedAt: 0,
	}]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

describe("GoalManager.resolveRootMaxConcurrentChildren", () => {
	it("returns 3 when maxConcurrentChildren is unset", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		assert.equal(store.get(root.id)?.maxConcurrentChildren, undefined);
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 3);
	});

	it("returns the configured value when in [1, 8]", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: 5 });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 5);
	});

	it("clamps to 8 when value exceeds hard max", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: 100 });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 8);
	});

	it("clamps to 1 when value is below floor (never zero — would deadlock)", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: 0 });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 1);
	});

	it("clamps negative value to 1", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: -5 });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 1);
	});

	it("returns 3 when rootGoalId is unknown (defensive — orphaned semaphore)", () => {
		const { gm } = makeManager();
		assert.equal(gm.resolveRootMaxConcurrentChildren("nonexistent"), 3);
	});

	it("returns 8 when value is exactly 8 (boundary check)", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: 8 });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 8);
	});

	it("returns 1 when value is exactly 1 (boundary check)", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: 1 });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 1);
	});

	// C4 — integer clamp. A fractional stored value must never let an extra
	// child slip through the per-root semaphore.
	it("floors a fractional value (1.5 → 1, not 2 children)", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: 1.5 as number });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 1);
	});

	it("floors 8.9 to 8 (in-range after floor, not rejected)", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: 8.9 as number });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 8);
	});

	it("floors 2.999 to 2", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: 2.999 as number });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 2);
	});

	it("a sub-1 fractional value (0.5) clamps to floor 1", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "general" });
		store.update(root.id, { maxConcurrentChildren: 0.5 as number });
		assert.equal(gm.resolveRootMaxConcurrentChildren(root.id), 1);
	});
});
