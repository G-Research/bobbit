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
import type { GoalStore, PersistedGoal } from "../src/server/agent/goal-store.ts";
import type { MissionGit } from "../src/server/agent/mission-git.ts";

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

describe("MissionManager — replan loop cap", () => {
	it("rejects 4th replan with 429 and pauses mission", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const mgr = new MissionManager(store, {
			goalManager: noopGoalManager(), goalStore: noopGoalStore(),
			projectId: "p",
		});
		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });

		// Initial plan + freeze.
		await mgr.proposePlan(m.id, PLAN);
		mgr.freezePlan(m.id);

		const replan = async (v: number) => {
			await mgr.pauseMission(m.id, "r");
			const result = await mgr.proposePlan(m.id, { ...PLAN, version: v }, { replanReason: "r" });
			if (result.ok) {
				// Re-freeze for the next iteration so isReplan is true again.
				mgr.freezePlan(m.id);
			}
			return result;
		};

		assert.equal((await replan(2)).ok, true);
		assert.equal((await replan(3)).ok, true);
		assert.equal((await replan(4)).ok, true);
		// 4th replan attempt — over the cap.
		const fourth = await replan(5);
		assert.equal(fourth.ok, false);
		if (!fourth.ok) {
			assert.equal(fourth.status, 429);
			assert.match(fourth.reason, /Too many replans/);
		}
		const final = store.get(m.id)!;
		assert.equal(final.state, "paused");
		assert.match(final.pausedReason ?? "", /Replan loop/);
	});
});

describe("MissionManager — restartPlanning", () => {
	it("resets gates, clears plan + freeze + replanCount, drives state to planning", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const gateStore = new GateStore(dir);
		const mgr = new MissionManager(store, {
			goalManager: noopGoalManager(), goalStore: noopGoalStore(),
			projectId: "p",
			gateStore,
		});
		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });

		// Set up: plan, frozen, gates passed, replanCount > 0, paused.
		await mgr.proposePlan(m.id, PLAN);
		mgr.freezePlan(m.id);
		gateStore.initGatesFor("mission", m.id, ["charter", "plan-review", "goal-plan"]);
		gateStore.updateGateStatusFor("mission", m.id, "charter", "passed");
		gateStore.updateGateStatusFor("mission", m.id, "plan-review", "passed");
		gateStore.updateGateStatusFor("mission", m.id, "goal-plan", "passed");
		store.incrementReplanCount(m.id);
		await mgr.pauseMission(m.id, "reason");

		const result = await mgr.restartPlanning(m.id);
		assert.equal(result.ok, true);

		const fresh = new MissionStore(dir).get(m.id)!;
		assert.equal(fresh.plan, undefined, "plan cleared");
		assert.equal(fresh.planFrozenAt, undefined, "planFrozenAt cleared");
		assert.equal(fresh.replanCount, 0, "replanCount reset");
		assert.equal(fresh.state, "planning", "state reset to planning");
		assert.equal(fresh.pausedAt, undefined, "pausedAt cleared");
		assert.equal(fresh.pausedReason, undefined, "pausedReason cleared");
		for (const gid of ["charter", "plan-review", "goal-plan"]) {
			assert.equal(
				gateStore.getGateFor("mission", m.id, gid)?.status,
				"pending",
				`${gid} reset to pending`,
			);
		}
	});

	it("refuses when mission is complete (409)", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const mgr = new MissionManager(store, {
			goalManager: noopGoalManager(), goalStore: noopGoalStore(), projectId: "p",
		});
		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });
		store.update(m.id, { state: "complete" });
		const result = await mgr.restartPlanning(m.id);
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.status, 409);
			assert.match(result.reason, /complete/i);
		}
	});

	it("refuses when mission archived (409)", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const mgr = new MissionManager(store, {
			goalManager: noopGoalManager(), goalStore: noopGoalStore(), projectId: "p",
		});
		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });
		store.archive(m.id);
		const result = await mgr.restartPlanning(m.id);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.status, 409);
	});

	it("returns 404 for unknown mission", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const mgr = new MissionManager(store, {
			goalManager: noopGoalManager(), goalStore: noopGoalStore(), projectId: "p",
		});
		const result = await mgr.restartPlanning("does-not-exist");
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.status, 404);
	});
});

describe("MissionManager — spawnChild base branch", () => {
	it("freezePlan after createMission unblocks spawnChild", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const goals = new Map<string, PersistedGoal>();
		const goalManager = {
			createGoal: async (title: string, _cwd: string, opts: any) => {
				const id = `g-${Math.random().toString(36).slice(2, 8)}`;
				const goal: PersistedGoal = {
					id,
					title,
					cwd: _cwd,
					state: "todo",
					spec: opts?.spec ?? "",
					createdAt: 1, updatedAt: 1,
					branch: `goal/${title}-${id}`,
					baseBranch: opts?.baseBranch,
				};
				goals.set(id, goal);
				return goal;
			},
			updateGoal: async () => true,
		} as unknown as GoalManager;
		const goalStore = { get: (id: string) => goals.get(id) } as unknown as GoalStore;
		const mgr = new MissionManager(store, {
			goalManager, goalStore, projectId: "p",
		});

		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });
		await mgr.proposePlan(m.id, PLAN);

		// Without freezePlan: spawnChild fails 409.
		const blocked = await mgr.spawnChild(m.id, "a");
		assert.equal(blocked.ok, false);
		if (!blocked.ok) assert.equal(blocked.status, 409);

		// freezePlan unblocks it.
		mgr.freezePlan(m.id);
		const ok = await mgr.spawnChild(m.id, "a");
		assert.equal(ok.ok, true);
	});

	it("spawnChild pins child baseBranch to integration branch HEAD via childStartPoint", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const goals = new Map<string, PersistedGoal>();

		// Capture the baseBranch that createGoal received.
		let receivedBaseBranch: string | undefined;
		const goalManager = {
			createGoal: async (title: string, cwd: string, opts: any) => {
				receivedBaseBranch = opts?.baseBranch;
				const goal: PersistedGoal = {
					id: "g1", title, cwd, state: "todo", spec: "",
					createdAt: 1, updatedAt: 1,
					branch: `goal/${title}-g1`,
					baseBranch: opts?.baseBranch,
				};
				goals.set(goal.id, goal);
				return goal;
			},
			updateGoal: async () => true,
		} as unknown as GoalManager;
		const goalStore = { get: (id: string) => goals.get(id) } as unknown as GoalStore;

		// Fake MissionGit — childStartPoint returns a fixed SHA.
		const missionGit = {
			childStartPoint: async (_wt: string) => "abc123def456",
		} as unknown as MissionGit;

		const mgr = new MissionManager(store, {
			goalManager, goalStore, projectId: "p", missionGit,
		});

		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });
		// Manually wire integration branch + worktree.
		store.update(m.id, {
			integrationBranch: "mission/t-x",
			integrationWorktree: "/tmp/mission-wt",
		});
		await mgr.proposePlan(m.id, PLAN);
		mgr.freezePlan(m.id);

		const result = await mgr.spawnChild(m.id, "a");
		assert.equal(result.ok, true);
		assert.equal(receivedBaseBranch, "abc123def456", "baseBranch should be the SHA from childStartPoint");
		if (result.ok) {
			assert.equal(result.goal.baseBranch, "abc123def456");
		}
	});

	it("spawnChild falls back to integrationBranch name when missionGit not configured", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		let receivedBaseBranch: string | undefined;
		const goalManager = {
			createGoal: async (title: string, cwd: string, opts: any) => {
				receivedBaseBranch = opts?.baseBranch;
				return { id: "g1", title, cwd, state: "todo", spec: "", createdAt: 1, updatedAt: 1, branch: "goal/x" } as PersistedGoal;
			},
			updateGoal: async () => true,
		} as unknown as GoalManager;
		const mgr = new MissionManager(store, {
			goalManager, goalStore: noopGoalStore(), projectId: "p",
		});
		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });
		store.update(m.id, { integrationBranch: "mission/t-x" });
		await mgr.proposePlan(m.id, PLAN);
		mgr.freezePlan(m.id);
		await mgr.spawnChild(m.id, "a");
		assert.equal(receivedBaseBranch, "mission/t-x");
	});
});

describe("MissionManager — spawnChild auto-starts team-lead", () => {
	it("invokes setupWorktreeAndStartTeam + startTeamForGoal with the spawned goalId", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const goals = new Map<string, PersistedGoal>();
		const createdGoalIds: string[] = [];
		const goalManager = {
			createGoal: async (title: string, cwd: string, opts: any) => {
				const id = `g-${Math.random().toString(36).slice(2, 8)}`;
				createdGoalIds.push(id);
				const goal: PersistedGoal = {
					id, title, cwd, state: "todo", spec: opts?.spec ?? "",
					createdAt: 1, updatedAt: 1,
					branch: `goal/${title}-${id}`,
					baseBranch: opts?.baseBranch,
				};
				goals.set(id, goal);
				return goal;
			},
			updateGoal: async () => true,
		} as unknown as GoalManager;
		const goalStore = { get: (id: string) => goals.get(id) } as unknown as GoalStore;

		// Track invocations of the team-starter callbacks.
		const setupCalls: Array<{ goalId: string; startFnReturned: any }> = [];
		const startCalls: string[] = [];
		const startedBroadcasts: string[] = [];
		const failedBroadcasts: Array<{ goalId: string; err: Error }> = [];

		const startTeamForGoal = async (goalId: string) => {
			startCalls.push(goalId);
			return { sessionId: `session-${goalId}` };
		};
		const setupWorktreeAndStartTeam = async (goalId: string, fn: () => Promise<any>) => {
			// Real goal-manager calls fn() after worktree setup; we mirror that.
			const result = await fn();
			setupCalls.push({ goalId, startFnReturned: result });
		};

		const mgr = new MissionManager(store, {
			goalManager,
			goalStore,
			projectId: "p",
			setupWorktreeAndStartTeam,
			startTeamForGoal,
			onChildTeamStarted: (goalId) => startedBroadcasts.push(goalId),
			onChildTeamStartFailed: (goalId, err) => failedBroadcasts.push({ goalId, err }),
		});

		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });
		await mgr.proposePlan(m.id, PLAN);
		mgr.freezePlan(m.id);

		const r = await mgr.spawnChild(m.id, "a");
		assert.equal(r.ok, true);
		if (!r.ok) return;
		const spawnedId = r.goal.id;
		assert.equal(createdGoalIds[0], spawnedId);

		// spawnChild must NOT block on team-lead start — it's fire-and-forget.
		// Drain microtasks until the chain resolves.
		for (let i = 0; i < 10 && (setupCalls.length === 0 || startedBroadcasts.length === 0); i++) {
			await new Promise(resolve => setImmediate(resolve));
		}

		assert.equal(setupCalls.length, 1, "setupWorktreeAndStartTeam called once");
		assert.equal(setupCalls[0].goalId, spawnedId, "setup called with spawned goalId");
		assert.equal(startCalls.length, 1, "startTeamForGoal called once");
		assert.equal(startCalls[0], spawnedId, "start called with spawned goalId");
		assert.deepEqual(startedBroadcasts, [spawnedId], "onChildTeamStarted fired exactly once");
		assert.equal(failedBroadcasts.length, 0, "onChildTeamStartFailed should not fire on success");
	});

	it("setTeamStarter wires the callbacks post-construction", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const goals = new Map<string, PersistedGoal>();
		const goalManager = {
			createGoal: async (title: string, cwd: string, opts: any) => {
				const id = "g1";
				const goal: PersistedGoal = {
					id, title, cwd, state: "todo", spec: opts?.spec ?? "",
					createdAt: 1, updatedAt: 1,
					branch: `goal/${title}-${id}`,
				};
				goals.set(id, goal);
				return goal;
			},
			updateGoal: async () => true,
		} as unknown as GoalManager;
		const goalStore = { get: (id: string) => goals.get(id) } as unknown as GoalStore;

		const mgr = new MissionManager(store, {
			goalManager, goalStore, projectId: "p",
		});

		let started = false;
		mgr.setTeamStarter({
			setupWorktreeAndStartTeam: async (_goalId, fn) => { await fn(); },
			startTeamForGoal: async () => { started = true; return {}; },
		});

		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });
		await mgr.proposePlan(m.id, PLAN);
		mgr.freezePlan(m.id);
		await mgr.spawnChild(m.id, "a");

		for (let i = 0; i < 10 && !started; i++) {
			await new Promise(resolve => setImmediate(resolve));
		}
		assert.equal(started, true, "setTeamStarter must wire callbacks used by spawnChild");
	});

	it("updateGoal is called with autoStartTeam:true for mission children", async () => {
		const dir = tmpDir();
		const store = new MissionStore(dir);
		const goals = new Map<string, PersistedGoal>();
		const updateCalls: Array<{ id: string; updates: any }> = [];
		const goalManager = {
			createGoal: async (title: string, cwd: string, opts: any) => {
				const id = "g1";
				const goal: PersistedGoal = {
					id, title, cwd, state: "todo", spec: opts?.spec ?? "",
					createdAt: 1, updatedAt: 1, branch: "goal/x",
				};
				goals.set(id, goal);
				return goal;
			},
			updateGoal: async (id: string, updates: any) => {
				updateCalls.push({ id, updates });
				return true;
			},
		} as unknown as GoalManager;
		const goalStore = { get: (id: string) => goals.get(id) } as unknown as GoalStore;
		const mgr = new MissionManager(store, { goalManager, goalStore, projectId: "p" });
		const m = await mgr.createMission({ title: "T", projectId: "p", spec: "" });
		await mgr.proposePlan(m.id, PLAN);
		mgr.freezePlan(m.id);
		await mgr.spawnChild(m.id, "a");
		assert.equal(updateCalls.length, 1);
		assert.equal(updateCalls[0].updates.autoStartTeam, true, "mission children must be flagged autoStartTeam:true");
		assert.equal(updateCalls[0].updates.projectId, "p");
	});
});
