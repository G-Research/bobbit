/**
 * Unit tests for MissionManager — focus on field clearing on resume/replan
 * and cascade-reset of upstream gates.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionStore, type MissionPlan } from "../src/server/agent/mission-store.ts";
import { MissionManager } from "../src/server/agent/mission-manager.ts";
import { GateStore } from "../src/server/agent/gate-store.ts";
import type { GoalManager } from "../src/server/agent/goal-manager.ts";
import type { GoalStore } from "../src/server/agent/goal-store.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-mission-mgr-"));
}

function noopGoalStore(): GoalStore {
	return { get: () => undefined } as unknown as GoalStore;
}
function noopGoalManager(): GoalManager {
	return {
		createGoal: async () => ({ id: "g1", title: "x", branch: "goal/x", state: "todo" }),
		updateGoal: async () => true,
	} as unknown as GoalManager;
}

const PLAN: MissionPlan = {
	goals: [{ planId: "a", title: "A", spec: "", workflowId: "feature" }],
	dependencies: [],
	rationale: "",
	estimatedConcurrency: 1,
	version: 1,
};

describe("MissionManager — field clearing", () => {
	it("resumeMission clears pausedAt and pausedReason on disk", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const mgr = new MissionManager(store, {
			goalManager: noopGoalManager(), goalStore: noopGoalStore(),
			projectId: "p",
		});
		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });
		await mgr.pauseMission(m.id, "human");
		const paused = store.get(m.id)!;
		assert.ok(paused.pausedAt && paused.pausedAt > 0);
		assert.equal(paused.pausedReason, "human");

		const ok = await mgr.resumeMission(m.id);
		assert.equal(ok, true);
		// Reload from disk to ensure persistence really cleared the fields.
		const fresh = new MissionStore(dir).get(m.id)!;
		assert.equal(fresh.pausedAt, undefined);
		assert.equal(fresh.pausedReason, undefined);
		assert.equal(fresh.state, "planning");
	});

	it("proposePlan with replan_reason clears planFrozenAt and resets upstream gates", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const gateStore = new GateStore(dir);
		const mgr = new MissionManager(store, {
			goalManager: noopGoalManager(), goalStore: noopGoalStore(),
			projectId: "p",
			gateStore,
		});
		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });

		// Set a plan, freeze it, mark gates passed, then pause + replan.
		await mgr.proposePlan(m.id, PLAN);
		mgr.freezePlan(m.id);
		assert.ok(store.get(m.id)!.planFrozenAt);

		gateStore.initGatesFor("mission", m.id, ["charter", "plan-review", "goal-plan"]);
		gateStore.updateGateStatusFor("mission", m.id, "charter", "passed");
		gateStore.updateGateStatusFor("mission", m.id, "plan-review", "passed");
		gateStore.updateGateStatusFor("mission", m.id, "goal-plan", "passed");

		await mgr.pauseMission(m.id, "replan");
		const v2: MissionPlan = { ...PLAN, version: 2, rationale: "v2" };
		const result = await mgr.proposePlan(m.id, v2, { replanReason: "structural change" });
		assert.equal(result.ok, true);

		const fresh = new MissionStore(dir).get(m.id)!;
		assert.equal(fresh.planFrozenAt, undefined, "planFrozenAt cleared on replan");
		// Gates cascaded back to pending.
		for (const gid of ["charter", "plan-review", "goal-plan"]) {
			assert.equal(gateStore.getGateFor("mission", m.id, gid)?.status, "pending", `${gid} reset`);
		}
	});
});
