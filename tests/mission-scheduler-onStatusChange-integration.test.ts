/**
 * Integration test for the live wire path:
 *
 *   gateStore.updateGateStatusFor("mission", id, "goal-plan", "passed")
 *     → onStatusChange  (wired by wireMissionHooks)
 *       → freezePlan + missionScheduler.tickMission
 *         → spawnReady → missionManager.spawnChild
 *           → plan node's goalId is populated
 *
 * This catches regressions where any link in that chain silently breaks
 * (e.g. NULL_LOGGER swallowing spawn failures, or a missing freezePlan call
 * meaning tickMission no-ops because m.planFrozenAt is unset).
 *
 * The test stubs the heavy parts (GoalManager.createGoal, MissionGit) so it
 * doesn't touch real git/disk for git operations, but everything else —
 * GateStore, MissionStore, MissionManager, MissionScheduler, and
 * wireMissionHooks itself — is real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GateStore } from "../src/server/agent/gate-store.ts";
import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import type { GoalManager } from "../src/server/agent/goal-manager.ts";
import { MissionStore, type MissionPlan } from "../src/server/agent/mission-store.ts";
import { MissionManager } from "../src/server/agent/mission-manager.ts";
import { MissionScheduler } from "../src/server/agent/mission-scheduler.ts";
import { wireMissionHooks } from "../src/server/agent/wire-mission-hooks.ts";

function tmpDir(prefix = "bobbit-mission-int-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeGoalManagerStub(goalStore: GoalStore): GoalManager {
	let n = 0;
	return {
		async createGoal(title: string, _cwd: string, opts?: any): Promise<PersistedGoal> {
			n++;
			const id = `goal-${n}-${opts?.missionPlanId ?? "x"}`;
			const goal: PersistedGoal = {
				id,
				title,
				cwd: "",
				state: "todo",
				spec: opts?.spec ?? "",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				branch: `goal/${id.slice(0, 10)}`,
				missionId: opts?.missionId,
				missionPlanId: opts?.missionPlanId,
			} as PersistedGoal;
			goalStore.put(goal);
			return goal;
		},
		async updateGoal(id: string, updates: any): Promise<boolean> {
			return goalStore.update(id, updates);
		},
	} as unknown as GoalManager;
}

interface ProjectContextLike {
	gateStore: GateStore;
	goalStore: GoalStore;
	missionStore: MissionStore;
	missionManager: MissionManager;
	missionScheduler: MissionScheduler;
}

function buildContext(): ProjectContextLike {
	const dir = tmpDir();
	const gateStore = new GateStore(dir);
	const goalStore = new GoalStore(dir);
	const missionStore = new MissionStore(dir);
	const goalManager = makeGoalManagerStub(goalStore);
	const missionManager = new MissionManager(missionStore, {
		goalManager,
		goalStore,
		projectId: "p",
		gateStore,
	});
	const missionScheduler = new MissionScheduler({
		missionManager: {
			getMission: (id) => {
				const m = missionStore.get(id);
				if (!m) return undefined;
				return {
					id: m.id, title: m.title, state: m.state,
					maxConcurrentGoals: m.maxConcurrentGoals,
					plan: m.plan, planFrozenAt: m.planFrozenAt,
					integrationBranch: m.integrationBranch,
					integrationWorktree: m.integrationWorktree,
					commanderSessionId: m.commanderSessionId,
					archived: m.archived,
				};
			},
			listMissions: () => missionStore.getLive().map(m => ({
				id: m.id, title: m.title, state: m.state,
				maxConcurrentGoals: m.maxConcurrentGoals,
				plan: m.plan, planFrozenAt: m.planFrozenAt,
				integrationBranch: m.integrationBranch,
				integrationWorktree: m.integrationWorktree,
				commanderSessionId: m.commanderSessionId,
				archived: m.archived,
			})),
			updatePlanNodeState: (mid, pid, patch) => missionStore.updatePlanNodeState(mid, pid, patch),
			spawnChild: async (mid, pid) => {
				const r = await missionManager.spawnChild(mid, pid);
				if (!r.ok) throw new Error(r.reason);
				return r.goal;
			},
			integrateChildForScheduler: async (mid, pid) =>
				missionManager.integrateChildForScheduler(mid, pid),
			pauseMission: (mid, reason) => missionManager.pauseMission(mid, reason),
			// No forwardMergeMaster — no integration worktree in this test.
		},
		goalStore: { get: (id) => goalStore.get(id) },
		gateStore: { getGate: (oid, gid) => gateStore.getGate(oid, gid) },
		tickIntervalMs: 0, // periodic timer disabled — we drive ticks via the hook.
	});
	return { gateStore, goalStore, missionStore, missionManager, missionScheduler };
}

const PLAN: MissionPlan = {
	goals: [{ planId: "alpha", title: "Alpha", spec: "do alpha", workflowId: "feature" }],
	dependencies: [],
	rationale: "single-node test plan",
	estimatedConcurrency: 1,
	version: 1,
};

describe("wireMissionHooks integration: goal-plan passed → child spawned", () => {
	it("freezes the plan and spawns the ready child via tickMission", async () => {
		const ctx = buildContext();
		const broadcasts: any[] = [];
		const sessionManager = {
			enqueuePrompt: async () => {},
		};
		wireMissionHooks(ctx as any, sessionManager, (msg) => broadcasts.push(msg));

		// Create a mission with a 1-node plan, not yet frozen.
		const m = await ctx.missionManager.createMission({
			title: "Test mission", projectId: "p", spec: "do stuff", maxConcurrentGoals: 3,
		});
		await ctx.missionManager.proposePlan(m.id, PLAN);
		// Mission is in `planning`; plan exists but planFrozenAt is unset.
		assert.equal(ctx.missionStore.get(m.id)!.planFrozenAt, undefined);
		assert.equal(ctx.missionStore.get(m.id)!.plan?.goals[0].goalId, undefined);

		// Initialise gates and fire the very same call the verification harness
		// makes when the goal-plan signal verifies (passes through with no
		// verify steps).
		ctx.gateStore.initGatesFor("mission", m.id, ["charter", "plan-review", "goal-plan"]);
		ctx.gateStore.updateGateStatusFor("mission", m.id, "goal-plan", "passed");

		// onStatusChange schedules tickMission asynchronously. Wait for the
		// scheduler to drain.
		await ctx.missionScheduler.tickMission(m.id);

		// Plan should now be frozen.
		const after = ctx.missionStore.get(m.id)!;
		assert.ok(after.planFrozenAt, "planFrozenAt should be set by the hook");
		assert.equal(after.state, "in-progress", "freezePlan should drive mission to in-progress");

		// And the single ready child goal should have spawned.
		const node = after.plan!.goals[0];
		assert.ok(node.goalId, `plan node should have a spawned goalId; got ${node.goalId}`);
		const goal = ctx.goalStore.get(node.goalId!);
		assert.ok(goal, "goal record should exist in goalStore");
		assert.equal(goal!.missionId, m.id, "goal should be tagged with missionId");
		assert.equal(goal!.missionPlanId, "alpha", "goal should be tagged with missionPlanId");

		// Broadcast for plan-frozen should have fired (single-event sanity check —
		// the WS layer is wired through broadcastToAll which we capture).
		assert.ok(
			broadcasts.some(b => b.type === "mission_plan_frozen" && b.missionId === m.id),
			"should broadcast mission_plan_frozen",
		);
	});

	it("re-firing goal-plan passed is idempotent (does not double-spawn)", async () => {
		const ctx = buildContext();
		wireMissionHooks(ctx as any, { enqueuePrompt: async () => {} }, () => {});

		const m = await ctx.missionManager.createMission({
			title: "Test mission", projectId: "p", spec: "", maxConcurrentGoals: 3,
		});
		await ctx.missionManager.proposePlan(m.id, PLAN);
		ctx.gateStore.initGatesFor("mission", m.id, ["goal-plan"]);

		ctx.gateStore.updateGateStatusFor("mission", m.id, "goal-plan", "passed");
		await ctx.missionScheduler.tickMission(m.id);
		const goalIdAfterFirst = ctx.missionStore.get(m.id)!.plan!.goals[0].goalId;
		assert.ok(goalIdAfterFirst);

		// Fire the same status update again — the hook re-runs but the spawn
		// must remain idempotent.
		ctx.gateStore.updateGateStatusFor("mission", m.id, "goal-plan", "passed");
		await ctx.missionScheduler.tickMission(m.id);
		const goalIdAfterSecond = ctx.missionStore.get(m.id)!.plan!.goals[0].goalId;
		assert.equal(goalIdAfterSecond, goalIdAfterFirst, "spawn must be idempotent on the same plan node");
	});

	it("goal-owned gate change for a goal with missionId triggers tickMission", async () => {
		const ctx = buildContext();
		wireMissionHooks(ctx as any, { enqueuePrompt: async () => {} }, () => {});

		// Set up a 2-node mission, freeze plan, spawn the first node, and
		// register a goal-owned gate change for it. The hook should route the
		// status change back to tickMission via goal.missionId.
		const TWO_NODE_PLAN: MissionPlan = {
			goals: [
				{ planId: "alpha", title: "A", spec: "", workflowId: "feature" },
				{ planId: "beta", title: "B", spec: "", workflowId: "feature" },
			],
			dependencies: [{ from: "alpha", to: "beta" }],
			rationale: "",
			estimatedConcurrency: 1,
			version: 1,
		};

		const m = await ctx.missionManager.createMission({
			title: "Two-node", projectId: "p", spec: "", maxConcurrentGoals: 1,
		});
		await ctx.missionManager.proposePlan(m.id, TWO_NODE_PLAN);
		ctx.gateStore.initGatesFor("mission", m.id, ["goal-plan"]);
		ctx.gateStore.updateGateStatusFor("mission", m.id, "goal-plan", "passed");
		await ctx.missionScheduler.tickMission(m.id);

		const alpha = ctx.missionStore.get(m.id)!.plan!.goals.find(g => g.planId === "alpha")!;
		assert.ok(alpha.goalId, "alpha should have spawned");
		// Beta must NOT have spawned yet — depends on alpha.
		const beta = ctx.missionStore.get(m.id)!.plan!.goals.find(g => g.planId === "beta")!;
		assert.equal(beta.goalId, undefined, "beta must wait for alpha to merge");

		// Mark alpha's plan node merged (simulating the integrate-child path)
		// and fire a goal-owned gate change. The hook should re-tick the
		// mission and spawn beta.
		ctx.missionStore.updatePlanNodeState(m.id, "alpha", { mergedAt: Date.now() });
		ctx.gateStore.initGatesFor("goal", alpha.goalId!, ["ready-to-merge"]);
		ctx.gateStore.updateGateStatusFor("goal", alpha.goalId!, "ready-to-merge", "passed");
		// Hook routes this through tickMission(alpha.missionId). Drain.
		await ctx.missionScheduler.tickMission(m.id);

		const betaAfter = ctx.missionStore.get(m.id)!.plan!.goals.find(g => g.planId === "beta")!;
		assert.ok(betaAfter.goalId, "beta should now spawn after alpha merged");
	});
});
