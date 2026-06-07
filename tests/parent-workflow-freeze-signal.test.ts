/**
 * Gov-2 — signalling the `goal-plan` gate FREEZES the parent workflow's
 * execution.verify[] (sets execution.metadata.frozen = "true").
 *
 * `computePlanFreezeUpdate()` (parent-workflow-freeze.ts) is the pure helper
 * the gate-signal handler in server.ts calls. These tests pin:
 *   1. The helper's guards (only goal-plan + parent + execution-gate freezes).
 *   2. The freeze CONTRACT end-to-end at the data layer: apply the update the
 *      way the server.ts handler does (goalManager.getGoalStore().update),
 *      reload the store from disk, and confirm `frozen` is durably "true" and
 *      that the GET /plan frozen-read flips false → true.
 *   3. Idempotency: re-signalling is a harmless no-op write.
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
import { computePlanFreezeUpdate } from "../src/server/agent/parent-workflow-freeze.ts";
import type { PersistedGoal } from "../src/server/agent/goal-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freeze-signal-"));
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
	wf.setBuiltins([
		{
			id: "feature", name: "Feature", description: "",
			gates: [
				{ id: "implementation", name: "Implementation", dependsOn: [] },
				{ id: "ready-to-merge", name: "Ready", dependsOn: ["implementation"] },
			],
			createdAt: 0, updatedAt: 0,
		},
		{
			id: "parent", name: "Parent", description: "",
			gates: [
				{ id: "goal-plan", name: "Goal Plan", dependsOn: [] },
				{ id: "execution", name: "Execution", dependsOn: ["goal-plan"] },
				{ id: "ready-to-merge", name: "Ready", dependsOn: ["execution"] },
			],
			createdAt: 0, updatedAt: 0,
		},
	]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

/** Mirror of the GET /plan frozen-read (nested-goal-routes.ts). */
function readFrozen(goal: PersistedGoal | undefined, gateId = "execution"): boolean {
	const gate = goal?.workflow?.gates.find(g => g.id === gateId);
	return gate?.metadata?.frozen === "true";
}

/**
 * Mirror of the server.ts gate-signal handler's freeze step: compute the
 * update and persist it via the goal store the same way the route does.
 */
function applyFreezeLikeHandler(gm: GoalManager, goal: PersistedGoal, gateId: string): boolean {
	const result = computePlanFreezeUpdate(goal, gateId);
	if (result.freeze && result.workflow) {
		gm.getGoalStore().update(goal.id, { workflow: result.workflow });
		return true;
	}
	return false;
}

describe("computePlanFreezeUpdate guards", () => {
	it("non-goal-plan gate → no freeze", async () => {
		const { gm, store } = makeManager();
		const goal = await gm.createGoal("P", tmpRoot, { workflowId: "parent" });
		assert.equal(computePlanFreezeUpdate(store.get(goal.id)!, "execution").freeze, false);
		assert.equal(computePlanFreezeUpdate(store.get(goal.id)!, "charter").freeze, false);
	});

	it("non-parent workflow → no freeze even for goal-plan", async () => {
		const { gm, store } = makeManager();
		const goal = await gm.createGoal("F", tmpRoot, { workflowId: "feature" });
		assert.equal(computePlanFreezeUpdate(store.get(goal.id)!, "goal-plan").freeze, false);
	});

	it("goal-plan + parent + execution gate → freeze with frozen=true", async () => {
		const { gm, store } = makeManager();
		const goal = await gm.createGoal("P", tmpRoot, { workflowId: "parent" });
		const r = computePlanFreezeUpdate(store.get(goal.id)!, "goal-plan");
		assert.equal(r.freeze, true);
		const exec = r.workflow!.gates.find(g => g.id === "execution")!;
		assert.equal(exec.metadata?.frozen, "true");
	});
});

describe("Gov-2: goal-plan signal freezes execution.verify[] durably", () => {
	it("before signal frozen=false; after signal frozen=true and durable across reload", async () => {
		const { gm, store } = makeManager();
		const goal = await gm.createGoal("Parent", tmpRoot, { workflowId: "parent" });

		// Before: GET /plan reports frozen:false.
		assert.equal(readFrozen(store.get(goal.id)), false, "execution must not be frozen before signal");

		// Signal goal-plan → apply the freeze exactly like the handler.
		const did = applyFreezeLikeHandler(gm, store.get(goal.id)!, "goal-plan");
		assert.equal(did, true);

		// After: GET /plan reports frozen:true (same in-memory store).
		assert.equal(readFrozen(store.get(goal.id)), true, "execution must be frozen after goal-plan signal");

		// Durable: a fresh GoalStore over the same state dir still sees it.
		const reloaded = new GoalStore(stateDir);
		assert.equal(readFrozen(reloaded.get(goal.id)), true, "freeze must survive a store reload (persisted)");
	});

	it("re-signalling goal-plan is an idempotent no-op (still frozen)", async () => {
		const { gm, store } = makeManager();
		const goal = await gm.createGoal("Parent", tmpRoot, { workflowId: "parent" });

		applyFreezeLikeHandler(gm, store.get(goal.id)!, "goal-plan");
		assert.equal(readFrozen(store.get(goal.id)), true);

		// Second signal still resolves to freeze=true and leaves frozen=true.
		const did2 = applyFreezeLikeHandler(gm, store.get(goal.id)!, "goal-plan");
		assert.equal(did2, true);
		assert.equal(readFrozen(store.get(goal.id)), true);
	});
});
