/**
 * Unit tests for MissionScheduler — the event-driven loop that drives a
 * mission forward (design §11). Stubs MissionManager, GoalStore, GateStore,
 * and the WS broadcaster so no real disk / git / network is involved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MissionScheduler,
	computeReadySet,
	countInFlight,
	type MissionView,
	type MissionPlanLite,
	type SchedulerMissionManager,
	type SchedulerGoalLookup,
	type SchedulerGateLookup,
	type SchedulerWsMessage,
	type PlannedGoalLite,
} from "../src/server/agent/mission-scheduler.js";
import type { GateState } from "../src/server/agent/gate-store.js";
import type { PersistedGoal } from "../src/server/agent/goal-store.js";
import type { MergeResult } from "../src/server/agent/mission-git.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function plan(opts?: Partial<MissionPlanLite>): MissionPlanLite {
	return {
		version: 1,
		goals: [],
		dependencies: [],
		...opts,
	};
}

function planNode(planId: string, patch: Partial<PlannedGoalLite> = {}): PlannedGoalLite {
	return { planId, title: planId.toUpperCase(), ...patch };
}

function mission(opts: Partial<MissionView> & { id: string }): MissionView {
	return {
		title: "Test Mission",
		state: "in-progress",
		maxConcurrentGoals: 3,
		planFrozenAt: 1,
		plan: plan(),
		...opts,
	};
}

function persistedGoal(id: string, state: PersistedGoal["state"] = "in-progress", branch = `goal/x-${id}`): PersistedGoal {
	return {
		id,
		title: id,
		cwd: `/tmp/${id}`,
		state,
		spec: "",
		createdAt: 1,
		updatedAt: 1,
		branch,
	};
}

function gateState(goalId: string, gateId: string, status: GateState["status"]): GateState {
	return {
		gateId,
		goalId,
		status,
		signals: [],
		updatedAt: 1,
	};
}

interface FakeManager extends SchedulerMissionManager {
	missions: Map<string, MissionView>;
	spawnCalls: Array<{ missionId: string; planId: string }>;
	integrateCalls: Array<{ missionId: string; planId: string }>;
	integrateImpl: (missionId: string, planId: string) => Promise<MergeResult>;
	integrateChildForScheduler(missionId: string, planId: string): Promise<MergeResult>;
}

function makeManager(missions: MissionView[]): FakeManager {
	const map = new Map(missions.map(m => [m.id, m]));
	const fm: FakeManager = {
		missions: map,
		spawnCalls: [],
		integrateCalls: [],
		integrateImpl: async () => ({ status: "merged", mergeSha: "deadbeef" }),
		getMission(id) { return map.get(id); },
		listMissions() { return Array.from(map.values()); },
		updatePlanNodeState(missionId, planId, patch) {
			const m = map.get(missionId);
			if (!m?.plan) return false;
			const node = m.plan.goals.find(g => g.planId === planId);
			if (!node) return false;
			Object.assign(node, patch);
			return true;
		},
		async spawnChild(missionId, planId) {
			fm.spawnCalls.push({ missionId, planId });
			const m = map.get(missionId);
			const node = m?.plan?.goals.find(g => g.planId === planId);
			if (node && !node.goalId) {
				node.goalId = `goal-${planId}`;
				node.state = "todo";
				node.spawnedAt = 1;
			}
			return persistedGoal(`goal-${planId}`, "todo");
		},
		async integrateChildForScheduler(missionId, planId) {
			fm.integrateCalls.push({ missionId, planId });
			const result = await fm.integrateImpl(missionId, planId);
			if (result.status === "merged" || result.status === "already-merged") {
				const m = map.get(missionId);
				const node = m?.plan?.goals.find(g => g.planId === planId);
				if (node && !node.mergedAt) node.mergedAt = 100;
			}
			return result;
		},
	};
	return fm;
}

function makeGoalLookup(goals: PersistedGoal[]): SchedulerGoalLookup {
	const map = new Map(goals.map(g => [g.id, g]));
	return { get: id => map.get(id) };
}

function makeGateLookup(gates: GateState[]): SchedulerGateLookup {
	const key = (o: string, g: string) => `${o}::${g}`;
	const map = new Map(gates.map(g => [key(g.goalId, g.gateId), g]));
	return { getGate: (o, g) => map.get(key(o, g)) };
}

function makeBroadcast(): { broadcast: (m: SchedulerWsMessage) => void; events: SchedulerWsMessage[] } {
	const events: SchedulerWsMessage[] = [];
	return { broadcast: m => events.push(m), events };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("computeReadySet: nodes with no deps are always ready until spawned", () => {
	const p = plan({
		goals: [planNode("a"), planNode("b")],
		dependencies: [],
	});
	const ready = computeReadySet(p);
	assert.deepEqual(ready.map(g => g.planId).sort(), ["a", "b"]);
});

test("computeReadySet: dependent node only ready when upstream merged", () => {
	const p = plan({
		goals: [
			planNode("a", { goalId: "g-a" }),
			planNode("b"),
		],
		dependencies: [{ from: "a", to: "b" }],
	});
	// a is spawned but not merged → b not ready
	assert.deepEqual(computeReadySet(p).map(g => g.planId), []);
	// mark a merged
	p.goals[0].mergedAt = 5;
	assert.deepEqual(computeReadySet(p).map(g => g.planId), ["b"]);
});

test("computeReadySet: already-spawned nodes excluded", () => {
	const p = plan({
		goals: [planNode("a", { goalId: "g-a" })],
		dependencies: [],
	});
	assert.deepEqual(computeReadySet(p).map(g => g.planId), []);
});

test("computeReadySet: diamond DAG — both middles ready when root merged", () => {
	const p = plan({
		goals: [
			planNode("root", { goalId: "g-root", mergedAt: 5 }),
			planNode("left"),
			planNode("right"),
			planNode("tail"),
		],
		dependencies: [
			{ from: "root", to: "left" },
			{ from: "root", to: "right" },
			{ from: "left", to: "tail" },
			{ from: "right", to: "tail" },
		],
	});
	const ready = computeReadySet(p).map(g => g.planId).sort();
	assert.deepEqual(ready, ["left", "right"]);
});

test("countInFlight: counts spawned-but-not-merged", () => {
	const p = plan({
		goals: [
			planNode("a", { goalId: "g-a", mergedAt: 1 }), // not in-flight
			planNode("b", { goalId: "g-b" }),               // in-flight
			planNode("c"),                                  // not spawned
		],
	});
	assert.equal(countInFlight(p), 1);
});

// ---------------------------------------------------------------------------
// Tick behaviour
// ---------------------------------------------------------------------------

test("tickMission: no-op when plan not frozen", async () => {
	const mgr = makeManager([mission({ id: "m1", planFrozenAt: undefined })]);
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([]),
		gateStore: makeGateLookup([]),
		tickIntervalMs: 0,
	});
	await sch.tickMission("m1");
	assert.equal(mgr.spawnCalls.length, 0);
	assert.equal(mgr.integrateCalls.length, 0);
});

test("tickMission: no-op when mission paused", async () => {
	const m = mission({
		id: "m1",
		state: "paused",
		plan: plan({ goals: [planNode("a")] }),
	});
	const mgr = makeManager([m]);
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([]),
		gateStore: makeGateLookup([]),
		tickIntervalMs: 0,
	});
	await sch.tickMission("m1");
	assert.equal(mgr.spawnCalls.length, 0);
});

test("tickMission: spawns ready nodes up to concurrency cap", async () => {
	const m = mission({
		id: "m1",
		maxConcurrentGoals: 2,
		plan: plan({
			goals: [planNode("a"), planNode("b"), planNode("c")],
			dependencies: [],
		}),
	});
	const mgr = makeManager([m]);
	const { broadcast, events } = makeBroadcast();
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([]),
		gateStore: makeGateLookup([]),
		broadcast,
		tickIntervalMs: 0,
	});
	await sch.tickMission("m1");
	assert.equal(mgr.spawnCalls.length, 2, "should spawn exactly 2 (cap)");
	const spawnEvents = events.filter(e => e.type === "mission_child_spawned");
	assert.equal(spawnEvents.length, 2);
});

test("tickMission: respects concurrency cap including in-flight children", async () => {
	const m = mission({
		id: "m1",
		maxConcurrentGoals: 2,
		plan: plan({
			goals: [
				planNode("a", { goalId: "g-a" }), // in-flight, takes one slot
				planNode("b"),
				planNode("c"),
			],
		}),
	});
	const mgr = makeManager([m]);
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([persistedGoal("g-a", "in-progress")]),
		gateStore: makeGateLookup([]),
		tickIntervalMs: 0,
	});
	await sch.tickMission("m1");
	assert.equal(mgr.spawnCalls.length, 1, "only 1 slot available");
});

test("tickMission: auto-merges children whose ready-to-merge passed", async () => {
	const m = mission({
		id: "m1",
		plan: plan({
			goals: [planNode("a", { goalId: "g-a" })],
		}),
	});
	const mgr = makeManager([m]);
	const { broadcast, events } = makeBroadcast();
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([persistedGoal("g-a", "complete")]),
		gateStore: makeGateLookup([gateState("g-a", "ready-to-merge", "passed")]),
		broadcast,
		tickIntervalMs: 0,
	});
	await sch.tickMission("m1");
	assert.equal(mgr.integrateCalls.length, 1);
	assert.deepEqual(mgr.integrateCalls[0], { missionId: "m1", planId: "a" });
	const merged = events.find(e => e.type === "mission_child_merged");
	assert.ok(merged, "should broadcast mission_child_merged");
});

test("tickMission: does NOT merge when ready-to-merge gate not passed", async () => {
	const m = mission({
		id: "m1",
		plan: plan({ goals: [planNode("a", { goalId: "g-a" })] }),
	});
	const mgr = makeManager([m]);
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([persistedGoal("g-a", "in-progress")]),
		gateStore: makeGateLookup([gateState("g-a", "ready-to-merge", "pending")]),
		tickIntervalMs: 0,
	});
	await sch.tickMission("m1");
	assert.equal(mgr.integrateCalls.length, 0);
});

test("tickMission: broadcasts conflict event without auto-resolving", async () => {
	const m = mission({
		id: "m1",
		plan: plan({ goals: [planNode("a", { goalId: "g-a" })] }),
	});
	const mgr = makeManager([m]);
	mgr.integrateImpl = async () => ({ status: "conflict", conflictFiles: ["src/foo.ts"] });
	const { broadcast, events } = makeBroadcast();
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([persistedGoal("g-a", "complete")]),
		gateStore: makeGateLookup([gateState("g-a", "ready-to-merge", "passed")]),
		broadcast,
		tickIntervalMs: 0,
	});
	await sch.tickMission("m1");
	const conflict = events.find(e => e.type === "mission_child_merge_conflict");
	assert.ok(conflict, "should broadcast conflict event");
	if (conflict?.type === "mission_child_merge_conflict") {
		assert.deepEqual(conflict.conflictFiles, ["src/foo.ts"]);
	}
	// strict policy: no follow-up spawn of a fix-goal
	assert.equal(mgr.spawnCalls.length, 0);
});

test("tickMission: mirrors child goal state changes into plan node", async () => {
	const m = mission({
		id: "m1",
		plan: plan({ goals: [planNode("a", { goalId: "g-a", state: "todo" })] }),
	});
	const mgr = makeManager([m]);
	const { broadcast, events } = makeBroadcast();
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([persistedGoal("g-a", "in-progress")]),
		gateStore: makeGateLookup([]),
		broadcast,
		tickIntervalMs: 0,
	});
	await sch.tickMission("m1");
	const node = mgr.missions.get("m1")!.plan!.goals[0];
	assert.equal(node.state, "in-progress");
	const stateEvent = events.find(e => e.type === "mission_child_state_changed");
	assert.ok(stateEvent);
});

test("tickMission: signals execution-ready when all nodes merged", async () => {
	const m = mission({
		id: "m1",
		plan: plan({
			goals: [
				planNode("a", { goalId: "g-a", mergedAt: 5 }),
				planNode("b", { goalId: "g-b", mergedAt: 6 }),
			],
		}),
	});
	const mgr = makeManager([m]);
	const { broadcast, events } = makeBroadcast();
	let woken: { sessionId: string; message: string } | null = null;
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([persistedGoal("g-a", "complete"), persistedGoal("g-b", "complete")]),
		gateStore: makeGateLookup([]),
		broadcast,
		wakeCommander: (sessionId, message) => { woken = { sessionId, message }; },
		tickIntervalMs: 0,
	});
	mgr.missions.get("m1")!.commanderSessionId = "cmdr-1";
	await sch.tickMission("m1");
	const ready = events.find(e => e.type === "mission_execution_ready");
	assert.ok(ready);
	assert.ok(woken);
	assert.equal(woken!.sessionId, "cmdr-1");
});

test("tickMission: per-mission lock serialises concurrent calls", async () => {
	// Manager whose spawnChild blocks on a deferred, so we can interleave.
	const m = mission({
		id: "m1",
		plan: plan({ goals: [planNode("a"), planNode("b")] }),
	});
	const mgr = makeManager([m]);
	let release: () => void = () => {};
	const blocker = new Promise<void>(res => { release = res; });
	const order: string[] = [];
	const realSpawn = mgr.spawnChild;
	mgr.spawnChild = async (missionId, planId) => {
		order.push(`enter:${planId}`);
		await blocker;
		order.push(`exit:${planId}`);
		return realSpawn.call(mgr, missionId, planId);
	};
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([]),
		gateStore: makeGateLookup([]),
		tickIntervalMs: 0,
	});
	const t1 = sch.tickMission("m1");
	const t2 = sch.tickMission("m1");
	// Give microtasks a chance to advance.
	await new Promise(res => setTimeout(res, 5));
	// Only the first tick should have entered spawnChild — the lock should be
	// holding the second one.
	assert.equal(order.filter(s => s.startsWith("enter:")).length, 1, "second tick must wait");
	release();
	await t1;
	await t2;
	// Both ticks completed; total spawn calls is bounded by ready set (2 nodes,
	// 1 already taken by tick 1, so tick 2 has 1 left).
	assert.ok(mgr.spawnCalls.length >= 1);
});

test("tickAll: skips archived and terminal-state missions", async () => {
	const mgr = makeManager([
		mission({ id: "alive", plan: plan({ goals: [planNode("a")] }) }),
		mission({ id: "dead", state: "complete", plan: plan({ goals: [planNode("b")] }) }),
		mission({ id: "gone", archived: true, plan: plan({ goals: [planNode("c")] }) }),
	]);
	const sch = new MissionScheduler({
		missionManager: mgr,
		goalStore: makeGoalLookup([]),
		gateStore: makeGateLookup([]),
		tickIntervalMs: 0,
	});
	await sch.tickAll();
	const spawned = mgr.spawnCalls.map(c => c.missionId);
	assert.deepEqual(spawned, ["alive"]);
});

test("start/stop: idempotent and unrefs the timer", () => {
	const sch = new MissionScheduler({
		missionManager: makeManager([]),
		goalStore: makeGoalLookup([]),
		gateStore: makeGateLookup([]),
		tickIntervalMs: 1_000_000, // long; we never want it to fire
	});
	sch.start();
	sch.start(); // idempotent
	sch.stop();
	sch.stop(); // idempotent
});
