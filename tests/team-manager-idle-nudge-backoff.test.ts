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

	// Mirror real SessionManager.enqueuePrompt: set lastPromptSource on the
	// target session. TeamManager.subscribeTeamLeadEvents reads it on
	// agent_start to decide whether to reset idle-nudge counters.
	const enqueuePrompt = mock.fn((sid: string, _msg: string, opts?: any) => {
		const s = sm._sessions.get(sid);
		if (s) s.lastPromptSource = opts?.source ?? "user";
	});
	const retryLastPrompt = mock.fn(async (_sid: string, _opts?: any) => {});
	const deliverLiveSteer = mock.fn(async (_sid: string, _msg: string, _opts?: any) => {});
	sm.enqueuePrompt = enqueuePrompt;
	sm.retryLastPrompt = retryLastPrompt;
	sm.deliverLiveSteer = deliverLiveSteer;

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

	return { team, sm, tlSession, enqueuePrompt, retryLastPrompt, deliverLiveSteer, fire };
}

// ---------------------------------------------------------------------------
// Bug repro scenarios
// ---------------------------------------------------------------------------

describe("TeamManager — errored idle team lead auto-retry (regression)", () => {
	it("retries an errored idle team lead instead of enqueueing no-workers [AUTO-NUDGE] cards", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		try {
			const { tlSession, enqueuePrompt, retryLastPrompt, deliverLiveSteer, fire } = await setupTeamWithCapturedEvents();
			tlSession.status = "idle";
			tlSession.lastTurnErrored = true;
			tlSession.lastTurnErrorMessage = "server_error: upstream provider returned retryable server error";
			tlSession.lastPromptText = "continue coordinating the team";

			fire("agent_end");

			// Base no-workers delay is 5 minutes. The timer path should recover via
			// retryLastPrompt({ auto: true }) rather than append a fresh auto-nudge.
			t.mock.timers.tick(5 * 60 * 1000 + 1_000);
			await Promise.resolve();
			await Promise.resolve();

			assert.equal(
				retryLastPrompt.mock.callCount(),
				1,
				"errored idle team lead should be recovered through retryLastPrompt, not a new prompt card",
			);
			assert.deepEqual(
				retryLastPrompt.mock.calls[0].arguments,
				[tlSession.id, { auto: true }],
				"team-manager retry should use the existing automatic retry path",
			);
			const autoNudgePrompts = enqueuePrompt.mock.calls.filter((call: any) =>
				String(call.arguments[1] ?? "").includes("[AUTO-NUDGE]"),
			);
			assert.equal(
				autoNudgePrompts.length,
				0,
				"errored idle recovery must not enqueue duplicate [AUTO-NUDGE] transcript cards",
			);
			const autoNudgeSteers = deliverLiveSteer.mock.calls.filter((call: any) =>
				String(call.arguments[1] ?? "").includes("[AUTO-NUDGE]"),
			);
			assert.equal(
				autoNudgeSteers.length,
				0,
				"errored idle recovery must not steer duplicate [AUTO-NUDGE] transcript cards",
			);
		} finally {
			t.mock.timers.reset();
		}
	});

	it("suppresses unknown errored idle sessions without retrying or enqueueing [AUTO-NUDGE] cards", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		try {
			const { tlSession, enqueuePrompt, retryLastPrompt, deliverLiveSteer, fire } = await setupTeamWithCapturedEvents();
			tlSession.status = "idle";
			tlSession.lastTurnErrored = true;
			tlSession.lastTurnErrorMessage = "model stopped with an unexplained deterministic failure";
			tlSession.lastPromptText = "continue coordinating the team";

			fire("agent_end");
			t.mock.timers.tick(5 * 60 * 1000 + 1_000);
			await Promise.resolve();
			await Promise.resolve();

			assert.equal(retryLastPrompt.mock.callCount(), 0,
				"unknown/unclassified errors must not be auto-retried by the team-manager nudge path");
			assert.equal(enqueuePrompt.mock.calls.filter((call: any) =>
				String(call.arguments[1] ?? "").includes("[AUTO-NUDGE]"),
			).length, 0,
				"unknown errored idle sessions must suppress auto-nudge transcript cards");
			assert.equal(deliverLiveSteer.mock.calls.filter((call: any) =>
				String(call.arguments[1] ?? "").includes("[AUTO-NUDGE]"),
			).length, 0,
				"unknown errored idle sessions must suppress auto-nudge steer cards");
		} finally {
			t.mock.timers.reset();
		}
	});

	it("suppresses non-retryable errored idle sessions without retrying or enqueueing [AUTO-NUDGE] cards", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		try {
			const { tlSession, enqueuePrompt, retryLastPrompt, fire } = await setupTeamWithCapturedEvents();
			tlSession.status = "idle";
			tlSession.lastTurnErrored = true;
			tlSession.lastTurnErrorMessage = "Authentication failed: invalid API key for provider";
			tlSession.lastPromptText = "continue coordinating the team";

			fire("agent_end");
			t.mock.timers.tick(5 * 60 * 1000 + 1_000);
			await Promise.resolve();

			assert.equal(retryLastPrompt.mock.callCount(), 0,
				"non-retryable errors must leave manual Retry instead of using retryLastPrompt(auto)");
			assert.equal(enqueuePrompt.mock.calls.filter((call: any) =>
				String(call.arguments[1] ?? "").includes("[AUTO-NUDGE]"),
			).length, 0,
				"non-retryable errored idle sessions must suppress auto-nudge transcript cards");
		} finally {
			t.mock.timers.reset();
		}
	});

	it("does not emit duplicate [AUTO-NUDGE] cards while session auto-retry is pending", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
		let pendingAutoRetryTimer: ReturnType<typeof setTimeout> | undefined;

		try {
			const { tlSession, enqueuePrompt, retryLastPrompt, deliverLiveSteer, fire } = await setupTeamWithCapturedEvents();
			tlSession.status = "idle";
			tlSession.lastTurnErrored = true;
			tlSession.lastTurnErrorMessage = "server_error: upstream provider returned retryable server error";
			tlSession.lastPromptText = "continue coordinating the team";
			pendingAutoRetryTimer = setTimeout(() => {}, 60 * 60 * 1000);
			tlSession.pendingAutoRetryTimer = pendingAutoRetryTimer as any;

			for (let i = 0; i < 3; i++) {
				fire("agent_end");
				t.mock.timers.tick(5 * 60 * 1000 + 1_000);
				await Promise.resolve();
			}

			assert.equal(retryLastPrompt.mock.callCount(), 0,
				"team-manager must not start another retry while SessionManager auto-retry is pending");
			assert.equal(enqueuePrompt.mock.calls.filter((call: any) =>
				String(call.arguments[1] ?? "").includes("[AUTO-NUDGE]"),
			).length, 0,
				"repeated timer ticks while auto-retry is pending must not enqueue duplicate auto-nudge cards");
			assert.equal(deliverLiveSteer.mock.calls.filter((call: any) =>
				String(call.arguments[1] ?? "").includes("[AUTO-NUDGE]"),
			).length, 0,
				"repeated timer ticks while auto-retry is pending must not steer duplicate auto-nudge cards");
		} finally {
			if (pendingAutoRetryTimer) clearTimeout(pendingAutoRetryTimer);
			t.mock.timers.reset();
		}
	});
});

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

// ---------------------------------------------------------------------------
// Sticky nudgePending guard — delivery that parks before agent_start
// ---------------------------------------------------------------------------

describe("TeamManager — nudgePending clears when delivery does not start a turn (regression)", () => {
	it("does not count or log an async rejected no-workers nudge as sent before agent_start", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		try {
			const { team, sm, tlSession, enqueuePrompt, fire } = await setupTeamWithCapturedEvents();
			const log = mock.method(console, "log", () => {});
			mock.method(console, "error", () => {});
			let rejectDelivery: ((err: Error) => void) | undefined;
			enqueuePrompt.mock.mockImplementation((sid: string, _msg: string, opts?: any) => {
				const s = sm._sessions.get(sid);
				if (s) {
					// Mirror SessionManager: provenance is recorded when delivery is attempted,
					// but no agent_start has happened yet.
					s.lastPromptSource = opts?.source ?? "user";
				}
				return new Promise((_resolve, reject) => { rejectDelivery = reject; });
			});

			const BASE = 5 * 60 * 1000;
			const SLACK = 1_000;

			tlSession.status = "idle";
			fire("agent_end");
			t.mock.timers.tick(BASE + SLACK);

			assert.equal(enqueuePrompt.mock.callCount(), 1,
				"first no-workers nudge delivery should be attempted at the base delay");

			rejectDelivery?.(new Error("fetch failed"));
			await Promise.resolve();
			await Promise.resolve();

			assert.equal((team as any).nudgePending.get("goal-1"), undefined,
				"nudgePending should clear after rejected delivery before agent_start");
			assert.equal((team as any).noWorkersNudgeCount.get("goal-1") ?? 0, 0,
				"nudge should not be counted as sent before agent_start");
			const sentLogs = log.mock.calls.filter((call: any) =>
				String(call.arguments[0] ?? "").includes("Sent no-workers nudge"),
			);
			assert.equal(sentLogs.length, 0,
				"nudge should not be logged as sent before agent_start");
		} finally {
			t.mock.timers.reset();
		}
	});

	it("does not count or log a queued parked no-workers nudge as sent before agent_start", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		try {
			const { team, sm, tlSession, enqueuePrompt, fire } = await setupTeamWithCapturedEvents();
			const log = mock.method(console, "log", () => {});
			enqueuePrompt.mock.mockImplementation((sid: string, _msg: string, opts?: any) => {
				const s = sm._sessions.get(sid);
				if (s) {
					// Mirror SessionManager's cap path: provenance is recorded but the
					// prompt is parked/queued and no agent_start event is emitted.
					s.lastPromptSource = opts?.source ?? "user";
				}
				return Promise.resolve({ status: "queued", queued: true, parked: true, id: "parked-auto-nudge" });
			});

			const BASE = 5 * 60 * 1000;
			const SLACK = 1_000;

			tlSession.status = "idle";
			fire("agent_end");
			t.mock.timers.tick(BASE + SLACK);
			await Promise.resolve();
			t.mock.timers.tick(0);
			await Promise.resolve();

			assert.equal(enqueuePrompt.mock.callCount(), 1,
				"first parked no-workers nudge delivery should be attempted at the base delay");
			assert.equal((team as any).nudgePending.get("goal-1"), undefined,
				"nudgePending should clear after queued/parked delivery before agent_start");
			assert.equal((team as any).noWorkersNudgeCount.get("goal-1") ?? 0, 0,
				"nudge should not be counted as sent before agent_start");
			const sentLogs = log.mock.calls.filter((call: any) =>
				String(call.arguments[0] ?? "").includes("Sent no-workers nudge"),
			);
			assert.equal(sentLogs.length, 0,
				"nudge should not be logged as sent before agent_start");
		} finally {
			t.mock.timers.reset();
		}
	});

	it("does not permanently suppress later no-workers nudges after a parked auto-nudge", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		try {
			const { sm, tlSession, enqueuePrompt, fire } = await setupTeamWithCapturedEvents();
			enqueuePrompt.mock.mockImplementation((sid: string, _msg: string, opts?: any) => {
				const s = sm._sessions.get(sid);
				if (s) {
					// Mirror SessionManager's cap path: provenance is recorded but the
					// prompt is parked/queued and no agent_start event is emitted.
					s.lastPromptSource = opts?.source ?? "user";
				}
				return Promise.resolve({ queued: true, parked: true, id: "parked-auto-nudge" });
			});

			const BASE = 5 * 60 * 1000;
			const SLACK = 1_000;

			tlSession.status = "idle";
			fire("agent_end");

			// First no-workers nudge reaches SessionManager but is parked behind the
			// errored/capped team-lead state. No agent_start follows.
			t.mock.timers.tick(BASE + SLACK);
			assert.equal(enqueuePrompt.mock.callCount(), 1,
				"first parked no-workers nudge should be enqueued at the base delay");
			assert.equal((enqueuePrompt.mock.calls[0].arguments[2] as any)?.source, "auto-nudge",
				"the parked delivery must still be tagged as an auto-nudge");

			// The next eligible no-workers nudge should still fire after the normal
			// backoff delay. A sticky nudgePending flag suppresses this forever today.
			tlSession.status = "idle";
			t.mock.timers.tick(BASE * 2 + SLACK);
			assert.equal(
				enqueuePrompt.mock.callCount(),
				2,
				"nudgePending sticky regression: expected a second no-workers auto-nudge " +
					"after the parked delivery did not start a lead turn",
			);
		} finally {
			t.mock.timers.reset();
		}
	});
});

// ---------------------------------------------------------------------------
// PromptSource semantics — reset vs. preserve behaviour of subscribeTeamLeadEvents
// ---------------------------------------------------------------------------

describe("TeamManager — PromptSource semantics", () => {
	it("resets both counters on agent_start when lastPromptSource = 'user'", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, tlSession, enqueuePrompt, fire } = await setupTeamWithCapturedEvents({
			addIdleWorker: true,
		});

		// Seed counters as if several auto-nudges had already fired.
		(team as any).idleNudgeCount.set("goal-1", 5);
		(team as any).noWorkersNudgeCount.set("goal-1", 5);

		// External user prompt arrives — mirror real SessionManager behaviour.
		tlSession.lastPromptSource = "user";
		fire("agent_start");

		assert.equal((team as any).idleNudgeCount.get("goal-1"), undefined,
			"workers counter must be cleared on external user prompt");
		assert.equal((team as any).noWorkersNudgeCount.get("goal-1"), undefined,
			"no-workers counter must be cleared on external user prompt");

		// Next idle cycle: workers-nudge should fire at the BASE delay again,
		// proving the counter really was reset (not just the timer cancelled).
		tlSession.status = "idle";
		fire("agent_end");
		t.mock.timers.tick(10 * 60 * 1000 + 1_000);
		assert.equal(enqueuePrompt.mock.callCount(), 1,
			"workers-nudge must fire at base 10m delay after counter reset");

		t.mock.timers.reset();
	});

	it("resets both counters on agent_start when lastPromptSource = 'system'", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, tlSession, fire } = await setupTeamWithCapturedEvents();

		(team as any).idleNudgeCount.set("goal-1", 3);
		(team as any).noWorkersNudgeCount.set("goal-1", 7);

		tlSession.lastPromptSource = "system";
		fire("agent_start");

		assert.equal((team as any).idleNudgeCount.get("goal-1"), undefined,
			"system-source prompt must reset workers counter");
		assert.equal((team as any).noWorkersNudgeCount.get("goal-1"), undefined,
			"system-source prompt must reset no-workers counter");

		t.mock.timers.reset();
	});

	it("preserves both counters on agent_start when source is auto-nudge / task-notification / verification / agent", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		for (const source of ["auto-nudge", "task-notification", "verification", "agent"] as const) {
			const { team, tlSession, fire } = await setupTeamWithCapturedEvents();
			(team as any).idleNudgeCount.set("goal-1", 4);
			(team as any).noWorkersNudgeCount.set("goal-1", 6);

			tlSession.lastPromptSource = source;
			fire("agent_start");

			assert.equal((team as any).idleNudgeCount.get("goal-1"), 4,
				`source="${source}" must preserve workers counter`);
			assert.equal((team as any).noWorkersNudgeCount.get("goal-1"), 6,
				`source="${source}" must preserve no-workers counter`);
		}

		t.mock.timers.reset();
	});

	it("defaults lastPromptSource to 'user' when callers don't supply source (backward compat)", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, tlSession, sm, fire } = await setupTeamWithCapturedEvents();

		// Caller does NOT pass `source` — mock's default is "user".
		sm.enqueuePrompt(tlSession.id, "hello", { isSteered: false });
		assert.equal(tlSession.lastPromptSource, "user",
			"default source must be 'user' to preserve byte-equal behaviour for legacy callers");

		// And that default DOES reset counters on agent_start.
		(team as any).idleNudgeCount.set("goal-1", 2);
		(team as any).noWorkersNudgeCount.set("goal-1", 2);
		fire("agent_start");
		assert.equal((team as any).idleNudgeCount.get("goal-1"), undefined,
			"default 'user' source must reset workers counter");
		assert.equal((team as any).noWorkersNudgeCount.get("goal-1"), undefined,
			"default 'user' source must reset no-workers counter");

		t.mock.timers.reset();
	});
});

// ---------------------------------------------------------------------------
// Cap at MAX_*_NUDGE_DELAY_MS (12h)
// ---------------------------------------------------------------------------

describe("TeamManager — 12h backoff cap", () => {
	it("no-workers schedule caps at MAX_NO_WORKERS_NUDGE_DELAY_MS", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, tlSession, enqueuePrompt, fire } = await setupTeamWithCapturedEvents();

		// Force the counter high enough that 2^count * BASE ≫ MAX.
		(team as any).noWorkersNudgeCount.set("goal-1", 12);

		tlSession.status = "idle";
		fire("agent_end");

		// Just under 12h — must NOT fire (capped delay is 12h).
		const TWELVE_H = 12 * 60 * 60 * 1000;
		t.mock.timers.tick(TWELVE_H - 10_000);
		assert.equal(enqueuePrompt.mock.callCount(), 0,
			"capped nudge must not fire before 12h");

		// Crossing 12h — must fire exactly once.
		t.mock.timers.tick(20_000);
		assert.equal(enqueuePrompt.mock.callCount(), 1,
			"capped nudge must fire at the 12h boundary, not at 2^12 * 5m");

		t.mock.timers.reset();
	});

	it("workers schedule caps at MAX_IDLE_NUDGE_DELAY_MS", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, tlSession, enqueuePrompt, fire } = await setupTeamWithCapturedEvents({
			addIdleWorker: true,
		});

		(team as any).idleNudgeCount.set("goal-1", 12);

		tlSession.status = "idle";
		fire("agent_end");

		const TWELVE_H = 12 * 60 * 60 * 1000;
		t.mock.timers.tick(TWELVE_H - 10_000);
		assert.equal(enqueuePrompt.mock.callCount(), 0,
			"capped workers-nudge must not fire before 12h");

		t.mock.timers.tick(20_000);
		assert.equal(enqueuePrompt.mock.callCount(), 1,
			"capped workers-nudge must fire at the 12h boundary");

		t.mock.timers.reset();
	});
});

// ---------------------------------------------------------------------------
// Workers appearing aborts the no-workers cycle without incrementing
// ---------------------------------------------------------------------------

describe("TeamManager — no-workers cycle aborts when workers appear", () => {
	it("adding a worker before the no-workers timer fires aborts cleanly", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, sm, tlSession, enqueuePrompt, fire } = await setupTeamWithCapturedEvents();

		const countBefore = (team as any).noWorkersNudgeCount.get("goal-1") ?? 0;

		tlSession.status = "idle";
		fire("agent_end");

		// Tick partway through the 5m delay — add an idle worker before deadline.
		t.mock.timers.tick(60_000);
		const entry = (team as any).teams.get("goal-1")!;
		const workerSession = {
			id: "worker-late", status: "idle", cwd: "/tmp/worker",
			rpcClient: { prompt: mock.fn(async () => {}), onEvent: mock.fn(() => () => {}) },
			clients: new Set(),
		};
		sm._sessions.set("worker-late", workerSession);
		entry.agents.push({
			sessionId: "worker-late", role: "coder", task: "work", createdAt: Date.now(),
		});

		// Cross the original 5m deadline.
		t.mock.timers.tick(5 * 60 * 1000 + 1_000);

		// No no-workers nudge was sent, and the counter was NOT incremented.
		const noWorkersFires = enqueuePrompt.mock.calls.filter((c: any) => {
			const msg = String(c.arguments[1] ?? "");
			return msg.includes("no active team agents");
		}).length;
		assert.equal(noWorkersFires, 0,
			"no-workers nudge must not fire once a worker has been added before the deadline");
		assert.equal((team as any).noWorkersNudgeCount.get("goal-1") ?? 0, countBefore,
			"aborted no-workers cycle must not increment the counter");

		t.mock.timers.reset();
	});
});
