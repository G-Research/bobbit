// Reproducing test for the idle-nudge backoff bug in TeamManager.
//
// Bug: subscribeTeamLeadEvents() calls clearIdleNudgeTimer(goalId) on every
// team-lead `agent_start` event. clearIdleNudgeTimer() resets idleNudgeCount.
// But `agent_start` ALSO fires when the team lead is replying to its own
// auto-nudge. So every nudge → reply cycle resets the counter, the exponential
// backoff never escapes the base delay, and the lead is nagged forever at the
// base cadence (5m no-workers / 10m workers).
//
// These tests use Node's --test fake timers and reproduce the cycle directly.
// On the current (buggy) master, the count of dispatched nudges is much larger
// than 1 across multiple cycles. After the fix, only the first nudge of the
// first cycle fires within these short windows; subsequent cycles will not
// re-fire at the base delay because the preserved counter doubles the wait.

import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate from real ~/.bobbit state by using a temp directory. Set BEFORE
// importing TeamManager so bobbitDir() picks it up.
const TEST_BOBBIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-nudge-backoff-test-"));
process.env.BOBBIT_DIR = TEST_BOBBIT_DIR;

const { TeamManager } = await import("../src/server/agent/team-manager.ts");

const TEAM_STORE_FILE = path.join(TEST_BOBBIT_DIR, "state", "team-state.json");
function clearTeamStore() { try { fs.unlinkSync(TEAM_STORE_FILE); } catch { /* ignore */ } }
clearTeamStore();

// ---------------------------------------------------------------------------
// Minimal local mock helpers (copy of the pattern used in team-manager.test.ts,
// kept self-contained so we don't touch the existing test file).
// ---------------------------------------------------------------------------

interface MockGoal {
	id: string;
	title: string;
	cwd: string;
	state: string;
	spec: string;
	createdAt: number;
	updatedAt: number;
	worktreePath?: string;
	branch?: string;
	repoPath?: string;
	team?: boolean;
	teamLeadSessionId?: string;
}

function createMockGoal(overrides: Partial<MockGoal> = {}): MockGoal {
	return {
		id: "goal-1",
		title: "Test Goal",
		cwd: "/tmp/test-project",
		state: "in-progress",
		spec: "# Test Goal\nDo something",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		branch: "feat/test",
		repoPath: "/tmp/test-repo",
		...overrides,
	};
}

function createMockSessionManager(goals: Map<string, MockGoal> = new Map()): any {
	const sessions = new Map<string, any>();
	let nextSessionId = 0;
	return {
		goalManager: {
			getGoal: (id: string) => goals.get(id),
			updateGoal: (id: string, updates: any) => {
				const g = goals.get(id);
				if (g) Object.assign(g, updates);
				return !!g;
			},
		},
		createSession: async (
			cwd: string,
			_args?: string[],
			goalId?: string,
			_goalAssistant?: boolean,
			_opts?: any,
		) => {
			const id = `session-${nextSessionId++}`;
			const session = {
				id,
				title: "New session",
				cwd,
				status: "idle" as const,
				titleGenerated: false,
				goalId,
				rpcClient: {
					prompt: mock.fn(async () => {}),
					onEvent: mock.fn(() => () => {}),
				},
				clients: new Set(),
			};
			sessions.set(id, session);
			return session;
		},
		getSession: (id: string) => sessions.get(id),
		setTitle: (id: string, title: string) => {
			const s = sessions.get(id);
			if (s) s.title = title;
			return !!s;
		},
		updateSessionMeta: (id: string, updates: any) => {
			const s = sessions.get(id);
			if (s) Object.assign(s, updates);
			return !!s;
		},
		terminateSession: mock.fn(async (id: string) => {
			sessions.delete(id);
			return true;
		}),
		_sessions: sessions,
	};
}

function createMockRoleStore() {
	const roles = new Map<string, any>([
		["team-lead", { name: "team-lead", label: "Team Lead", promptTemplate: "lead {{GOAL_BRANCH}} {{AGENT_ID}}", toolPolicies: {}, accessory: "crown", createdAt: 0, updatedAt: 0 }],
		["coder", { name: "coder", label: "Coder", promptTemplate: "coder {{GOAL_BRANCH}} {{AGENT_ID}}", toolPolicies: {}, accessory: "headphones", createdAt: 0, updatedAt: 0 }],
	]);
	return {
		get: (name: string) => roles.get(name),
		getAll: () => Array.from(roles.values()),
		put: (role: any) => roles.set(role.name, role),
		remove: (name: string) => roles.delete(name),
		reload: () => {},
		update: () => true,
	};
}

function createMockColorStore() {
	const colors = new Map<string, number>();
	return {
		get: (sid: string) => colors.get(sid),
		set: (sid: string, idx: number) => colors.set(sid, idx),
		remove: (sid: string) => colors.delete(sid),
		getAll: () => Object.fromEntries(colors),
	};
}

function createMockTaskManager() {
	const tasks: any[] = [];
	return {
		getTasksByGoal: () => tasks,
		getTasksForSession: () => [],
		createTask: (_g: string, t: any) => { tasks.push(t); return t; },
		getTask: (id: string) => tasks.find((t: any) => t.id === id),
		updateTask: () => true,
		deleteTask: () => true,
	};
}

const DEFAULT_CONFIG = {
	gatewayUrl: "https://10.5.0.2:3000",
	authToken: "test-token-backoff",
	roleStore: createMockRoleStore(),
	colorStore: createMockColorStore(),
	taskManager: createMockTaskManager(),
};

const _createdManagers: InstanceType<typeof TeamManager>[] = [];

function createTeamManager(sm: any) {
	clearTeamStore();
	const tm = new TeamManager(sm, DEFAULT_CONFIG);
	_createdManagers.push(tm);
	return tm;
}

// Clean up timers so the process can exit even if fake timers were reset.
after(() => {
	for (const tm of _createdManagers) {
		for (const [, t] of (tm as any).idleNudgeTimers) clearTimeout(t);
		(tm as any).idleNudgeTimers.clear();
		for (const [, t] of (tm as any).noWorkersNudgeTimers ?? []) {
			// Either flavour is safe to call on a setTimeout/setInterval handle.
			clearInterval(t);
			clearTimeout(t);
		}
		(tm as any).noWorkersNudgeTimers?.clear?.();
	}
	try { fs.rmSync(TEST_BOBBIT_DIR, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helper: wire up a TeamManager + team-lead session whose RPC event callbacks
// we can drive manually. Returns the captured callbacks list so the test can
// fire `agent_end` / `agent_start` events at will.
// ---------------------------------------------------------------------------

async function setupTeamWithCapturedEvents(opts: { addIdleWorker?: boolean } = {}) {
	const goals = new Map<string, MockGoal>();
	const goal = createMockGoal();
	goals.set(goal.id, goal);
	const sm = createMockSessionManager(goals);

	const enqueuePrompt = mock.fn((_sid: string, _msg: string, _o?: any) => {});
	sm.enqueuePrompt = enqueuePrompt;

	const eventCallbacks: Array<(event: any) => void> = [];
	const origCreateSession = sm.createSession.bind(sm);
	sm.createSession = async (
		cwd: string,
		args?: string[],
		goalId?: string,
		goalAssistant?: boolean,
		o?: any,
	) => {
		const session = await origCreateSession(cwd, args, goalId, goalAssistant, o);
		session.rpcClient.onEvent = mock.fn((cb: any) => {
			eventCallbacks.push(cb);
			return () => {};
		});
		return session;
	};

	const team = createTeamManager(sm);
	await team.startTeam("goal-1");

	const entry = (team as any).teams.get("goal-1")!;
	const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
	tlSession.status = "idle";

	if (opts.addIdleWorker) {
		const workerSession = {
			id: "worker-1",
			status: "idle",
			cwd: "/tmp/worker",
			rpcClient: { prompt: mock.fn(async () => {}), onEvent: mock.fn(() => () => {}) },
			clients: new Set(),
		};
		sm._sessions.set("worker-1", workerSession);
		entry.agents.push({
			sessionId: "worker-1",
			role: "coder",
			task: "work on feature",
			createdAt: Date.now(),
		});
	}

	function fire(type: "agent_end" | "agent_start") {
		for (const cb of eventCallbacks) cb({ type });
	}

	return { team, sm, tlSession, enqueuePrompt, fire };
}

// ---------------------------------------------------------------------------
// Bug repro scenarios
// ---------------------------------------------------------------------------

describe("TeamManager — idle-nudge exponential backoff (regression)", () => {
	it("should back off the no-workers nudge exponentially across nudge-reply cycles", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { tlSession, enqueuePrompt, fire } = await setupTeamWithCapturedEvents();

		// Base no-workers delay is 5 minutes. After the fix, the schedule should be
		// 5m, 15m (10m wait after #1), 35m (20m wait after #2), … across cycles.
		// On the buggy master, every cycle fires at 5m flat.
		const BASE = 5 * 60 * 1000;
		const SLACK = 1_000;

		// Cycle 1 — the legitimate first nudge.
		fire("agent_end");
		t.mock.timers.tick(BASE + SLACK);
		assert.equal(
			enqueuePrompt.mock.callCount(),
			1,
			"First nudge of the first idle cycle should fire at the base delay (5m).",
		);

		// Three more nudge → reply cycles. After each, advance by *only* the base
		// delay. With correct exponential backoff none of these ticks should be
		// enough to fire another nudge (next deadlines should be 10m, 20m, 40m).
		for (let cycle = 0; cycle < 3; cycle++) {
			fire("agent_start");
			// Lead "finishes" its one-line reply — stays idle for the next round.
			tlSession.status = "idle";
			fire("agent_end");
			t.mock.timers.tick(BASE + SLACK);
		}

		const totalCalls = enqueuePrompt.mock.callCount();
		assert.ok(
			totalCalls <= 1,
			`exponential backoff regression: expected <=1 no-workers nudge across ` +
				`one legitimate fire + three nudge-reply cycles at base cadence, ` +
				`but enqueuePrompt was called ${totalCalls} times — counter is being ` +
				`reset by agent_start on the lead's reply to its own auto-nudge`,
		);

		// Sanity: every nudge we did send was targeted at the team lead session.
		for (const call of enqueuePrompt.mock.calls) {
			const [sid, msg] = call.arguments as any[];
			assert.equal(typeof sid, "string");
			assert.ok(
				String(msg).includes("[AUTO-NUDGE]"),
				"nudge messages should be tagged [AUTO-NUDGE]",
			);
		}

		t.mock.timers.reset();
	});

	it("should back off the workers nudge exponentially across nudge-reply cycles", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { tlSession, enqueuePrompt, fire } = await setupTeamWithCapturedEvents({
			addIdleWorker: true,
		});

		// Base workers delay is 10 minutes. After the fix: 10m, 30m, 70m, …
		// On master: 10m flat every cycle.
		const BASE = 10 * 60 * 1000;
		const SLACK = 1_000;

		fire("agent_end");
		t.mock.timers.tick(BASE + SLACK);
		assert.equal(
			enqueuePrompt.mock.callCount(),
			1,
			"First workers-nudge should fire at the base delay (10m).",
		);

		for (let cycle = 0; cycle < 3; cycle++) {
			fire("agent_start");
			tlSession.status = "idle";
			fire("agent_end");
			t.mock.timers.tick(BASE + SLACK);
		}

		const totalCalls = enqueuePrompt.mock.callCount();
		assert.ok(
			totalCalls <= 1,
			`exponential backoff regression: expected <=1 workers-nudge across ` +
				`one legitimate fire + three nudge-reply cycles at base cadence, ` +
				`but enqueuePrompt was called ${totalCalls} times — counter is being ` +
				`reset by agent_start on the lead's reply to its own auto-nudge`,
		);

		t.mock.timers.reset();
	});
});
