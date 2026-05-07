/**
 * Tests for the stuck-team watchdog in TeamManager.
 *
 * The watchdog is a 60-second sweep that fires a recovery nudge when:
 *   - team-lead status === "idle"
 *   - workers.length > 0
 *   - every worker is idle
 *   - lead has been idle >= 5min
 *   - no stuck-nudge has fired in the last 5min
 *   - !shouldSkipNudge (paused / archived / in-flight / nudgePending all skip)
 *
 * Tests drive `_stuckSweepTick(now)` directly with a synthetic clock — no
 * real timers needed.
 */

import { describe, it, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_PI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-stuck-watchdog-test-"));
process.env.BOBBIT_DIR = TEST_PI_DIR;

const { TeamManager } = await import("../src/server/agent/team-manager.ts");

const TEAM_STORE_FILE = path.join(TEST_PI_DIR, "state", "team-state.json");
function clearTeamStore() { try { fs.unlinkSync(TEAM_STORE_FILE); } catch { /* ignore */ } }

interface MockGoal {
	id: string;
	title: string;
	cwd: string;
	state: string;
	spec: string;
	createdAt: number;
	updatedAt: number;
	team?: boolean;
	branch?: string;
	repoPath?: string;
	archived?: boolean;
	paused?: boolean;
}

function createMockGoal(over: Partial<MockGoal> = {}): MockGoal {
	return {
		id: "goal-1",
		title: "Stuck Test Goal",
		cwd: "/tmp/stuck-test",
		state: "in-progress",
		spec: "spec",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		branch: "feat/stuck",
		repoPath: "/tmp/stuck-repo",
		...over,
	};
}

function createMockSessionManager(goals: Map<string, MockGoal>): any {
	const sessions = new Map<string, any>();
	let nextId = 0;
	return {
		goalManager: {
			getGoal: (id: string) => goals.get(id),
			updateGoal: (id: string, updates: any) => {
				const g = goals.get(id);
				if (g) Object.assign(g, updates);
				return !!g;
			},
		},
		createSession: async (cwd: string, _args?: any, goalId?: string) => {
			const id = `session-${nextId++}`;
			const session = {
				id, title: "Lead", cwd, status: "idle", titleGenerated: false, goalId,
				rpcClient: { prompt: mock.fn(async () => {}), onEvent: mock.fn(() => () => {}) },
				clients: new Set(),
			};
			sessions.set(id, session);
			return session;
		},
		getSession: (id: string) => sessions.get(id),
		setTitle: (id: string, t: string) => { const s = sessions.get(id); if (s) s.title = t; return !!s; },
		updateSessionMeta: (id: string, u: any) => { const s = sessions.get(id); if (s) Object.assign(s, u); return !!s; },
		terminateSession: mock.fn(async (id: string) => { sessions.delete(id); return true; }),
		enqueuePrompt: mock.fn((_id: string, _msg: string, _opts?: any) => {}),
		_sessions: sessions,
	};
}

function createMockRoleStore() {
	const roles = new Map<string, any>([
		["team-lead", { name: "team-lead", label: "Team Lead", promptTemplate: "TL", toolPolicies: {}, accessory: "crown", createdAt: 0, updatedAt: 0 }],
		["coder", { name: "coder", label: "Coder", promptTemplate: "C", toolPolicies: {}, accessory: "headphones", createdAt: 0, updatedAt: 0 }],
	]);
	return {
		get: (n: string) => roles.get(n),
		getAll: () => Array.from(roles.values()),
		put: (r: any) => roles.set(r.name, r),
		remove: (n: string) => roles.delete(n),
		reload: () => {},
		update: () => true,
	};
}

const DEFAULT_CONFIG = {
	gatewayUrl: "https://x:1",
	authToken: "t",
	roleStore: createMockRoleStore(),
	colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
	taskManager: {
		getTasksByGoal: () => [],
		getTasksForSession: () => [],
		createTask: (_g: any, t: any) => t,
		getTask: () => undefined,
		updateTask: () => true,
		deleteTask: () => true,
	},
};

const _managers: any[] = [];
function makeTeamManager(sm: any) {
	clearTeamStore();
	const tm = new TeamManager(sm, DEFAULT_CONFIG as any);
	_managers.push(tm);
	return tm;
}

after(() => {
	for (const tm of _managers) {
		tm.dispose?.();
		for (const [, t] of (tm as any).idleNudgeTimers ?? []) clearTimeout(t);
		(tm as any).idleNudgeTimers?.clear?.();
		for (const [, t] of (tm as any).noWorkersNudgeTimers ?? []) clearInterval(t);
		(tm as any).noWorkersNudgeTimers?.clear?.();
	}
	try { fs.rmSync(TEST_PI_DIR, { recursive: true }); } catch { /* ignore */ }
});

/**
 * Build a team with one team-lead and `workerCount` workers. Both the lead
 * and all workers default to "idle" status. `leadIdleSince` is seeded on
 * `leadIdleSinceByGoal` so the watchdog has a starting timestamp.
 */
async function buildIdleTeam(workerCount: number, leadIdleSince: number) {
	const goals = new Map<string, MockGoal>();
	const goal = createMockGoal();
	goals.set(goal.id, goal);
	const sm = createMockSessionManager(goals);
	const tm = makeTeamManager(sm);
	await tm.startTeam("goal-1");

	const entry = (tm as any).teams.get("goal-1")!;
	const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
	tlSession.status = "idle";

	for (let i = 0; i < workerCount; i++) {
		const id = `worker-${i}`;
		sm._sessions.set(id, {
			id, status: "idle", cwd: "/tmp/w",
			rpcClient: { prompt: mock.fn(async () => {}), onEvent: mock.fn(() => () => {}) },
			clients: new Set(),
		});
		entry.agents.push({
			sessionId: id, role: "coder", kind: "worker",
			task: "work", createdAt: Date.now(),
		});
	}

	(tm as any).leadIdleSinceByGoal.set("goal-1", leadIdleSince);

	return { tm, sm, goal, entry };
}

describe("TeamManager.stuck-team watchdog", () => {
	beforeEach(() => clearTeamStore());

	it("does not nudge before the 5-minute quiet threshold", async () => {
		const T0 = 1_000_000;
		const { tm, sm } = await buildIdleTeam(1, T0);

		// At T+0 — tick same instant
		(tm as any)._stuckSweepTick(T0);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 0, "no nudge at T=0");

		// At T+4min
		(tm as any)._stuckSweepTick(T0 + 4 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 0, "no nudge at T=4min");
	});

	it("fires exactly one nudge at T=5min and respects the 5-min floor", async () => {
		const T0 = 1_000_000;
		const { tm, sm } = await buildIdleTeam(1, T0);

		(tm as any)._stuckSweepTick(T0 + 5 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 1, "nudge fires at T=5min");

		const [leadId, msg, opts] = sm.enqueuePrompt.mock.calls[0].arguments;
		assert.match(msg, /\[AUTO-NUDGE\]/);
		assert.match(msg, /task_list/);
		assert.match(msg, /gate_list/);
		assert.match(msg, /team_complete/);
		assert.equal(opts.isSteered, true);
		assert.ok(typeof leadId === "string" && leadId.length > 0);

		// Clear nudgePending so the only barrier left is the 5-min floor.
		(tm as any).nudgePending.delete("goal-1");

		// At T+6min — within floor — must not re-fire.
		(tm as any)._stuckSweepTick(T0 + 6 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 1, "no second nudge inside floor");

		// At T+11min — past 5-min floor — fires again.
		(tm as any).nudgePending.delete("goal-1");
		(tm as any)._stuckSweepTick(T0 + 11 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 2, "second nudge fires past floor");
	});

	it("does not nudge when the team-lead is streaming", async () => {
		const T0 = 1_000_000;
		const { tm, sm, entry } = await buildIdleTeam(1, T0);
		const tl = sm._sessions.get(entry.teamLeadSessionId)!;
		tl.status = "streaming";

		(tm as any)._stuckSweepTick(T0 + 10 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 0);
	});

	it("does not nudge when there are no workers", async () => {
		const T0 = 1_000_000;
		const { tm, sm } = await buildIdleTeam(0, T0);

		(tm as any)._stuckSweepTick(T0 + 10 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 0);
	});

	it("does not nudge when at least one worker is still streaming", async () => {
		const T0 = 1_000_000;
		const { tm, sm } = await buildIdleTeam(2, T0);

		// Flip one worker to streaming.
		const w0 = sm._sessions.get("worker-0")!;
		w0.status = "streaming";

		(tm as any)._stuckSweepTick(T0 + 10 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 0);
	});

	it("does not nudge when nudgePending is already true", async () => {
		const T0 = 1_000_000;
		const { tm, sm } = await buildIdleTeam(1, T0);
		(tm as any).nudgePending.set("goal-1", true);

		(tm as any)._stuckSweepTick(T0 + 10 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 0);
	});

	it("does not nudge a paused goal (delegates to shouldSkipNudge)", async () => {
		const T0 = 1_000_000;
		const { tm, sm, goal } = await buildIdleTeam(1, T0);
		goal.state = "shelved"; // shouldSkipNudge skips shelved/complete/archived

		(tm as any)._stuckSweepTick(T0 + 10 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 0);
	});

	it("does not nudge an archived goal", async () => {
		const T0 = 1_000_000;
		const { tm, sm, goal } = await buildIdleTeam(1, T0);
		goal.archived = true;

		(tm as any)._stuckSweepTick(T0 + 10 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 0);
	});

	it("nudge text includes the worker count and minutes idle", async () => {
		const T0 = 1_000_000;
		const { tm, sm } = await buildIdleTeam(3, T0);

		(tm as any)._stuckSweepTick(T0 + 7 * 60_000);
		assert.equal(sm.enqueuePrompt.mock.callCount(), 1);
		const msg = sm.enqueuePrompt.mock.calls[0].arguments[1] as string;
		assert.match(msg, /All 3 team agent\(s\) are idle/);
		assert.match(msg, /idle for 7 minutes/);
	});

	it("startStuckSweep is idempotent", () => {
		const goals = new Map<string, MockGoal>();
		goals.set("goal-1", createMockGoal());
		const sm = createMockSessionManager(goals);
		const tm = makeTeamManager(sm);

		const before = (tm as any).stuckSweepTimer;
		assert.ok(before, "watchdog timer started by constructor");
		tm.startStuckSweep();
		assert.strictEqual((tm as any).stuckSweepTimer, before, "second startStuckSweep is a no-op");
	});

	it("dispose() stops the watchdog timer", () => {
		const goals = new Map<string, MockGoal>();
		goals.set("goal-1", createMockGoal());
		const sm = createMockSessionManager(goals);
		const tm = makeTeamManager(sm);

		assert.ok((tm as any).stuckSweepTimer, "timer running before dispose");
		tm.dispose();
		assert.equal((tm as any).stuckSweepTimer, null, "timer cleared after dispose");
	});
});
