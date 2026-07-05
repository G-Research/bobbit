// Reproducing test (TDD red) for the transient-worker-idle-blip bug in
// TeamManager.
//
// Bug: when a worker (team member) session emits a transient `agent_end` event
// (e.g. a flaky tool call) and then resumes with `agent_start` a moment later,
// TeamManager fires `notifyTeamLead(...)` SYNCHRONOUSLY on the `agent_end`,
// steering the team lead with a worker-completion message. The worker was
// never actually done — just momentarily idle — so the lead is nudged for
// nothing. Both worker-event subscription sites (`spawnRole` ~line 1771 and the
// boot re-subscribe path in `resubscribeTeamEvents` ~line 886) only listen for
// `agent_end` and call `notifyTeamLead` with no debounce and no `agent_start`
// cancellation. The existing 30s `lastNotifyTime` debounce inside
// `notifyTeamLead` only suppresses *repeats*; the first nudge still fires.
//
// Intended fix (NOT implemented here — this file only proves the bug): a 5s
// debounce. `agent_end` schedules `notifyTeamLead` after 5s; an `agent_start`
// within that window cancels it.
//
// These tests use Node's --test fake timers. On the current (buggy) master the
// blip case (#1) FAILS because the nudge fires synchronously on `agent_end`
// before the cancelling `agent_start` can take effect.

import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate from real ~/.bobbit state by using a temp directory. Set BEFORE
// importing TeamManager so bobbitDir() picks it up.
const TEST_BOBBIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-worker-idle-test-"));
process.env.BOBBIT_DIR = TEST_BOBBIT_DIR;

const { TeamManager } = await import("../src/server/agent/team-manager.ts");

const TEAM_STORE_FILE = path.join(TEST_BOBBIT_DIR, "state", "team-state.json");
function clearTeamStore() { try { fs.unlinkSync(TEAM_STORE_FILE); } catch { /* ignore */ } }
clearTeamStore();

// ---------------------------------------------------------------------------
// Minimal local mock helpers (copied from team-manager-idle-nudge-backoff.test.ts,
// kept self-contained so we don't touch existing test files).
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
	authToken: "test-token-worker-idle",
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
			clearInterval(t);
			clearTimeout(t);
		}
		(tm as any).noWorkersNudgeTimers?.clear?.();
		// Clear notification timers defensively so the process exits cleanly.
		for (const [, t] of (tm as any).pendingIdleNotify ?? []) clearTimeout(t);
		(tm as any).pendingIdleNotify?.clear?.();
		for (const [, batch] of (tm as any).pendingLeadNotify ?? []) clearTimeout(batch.timer);
		(tm as any).pendingLeadNotify?.clear?.();
	}
	try { fs.rmSync(TEST_BOBBIT_DIR, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helper: set up a TeamManager with an idle team lead and worker agents whose
// RPC event callbacks we can drive manually. The worker subscription is
// wired through the REAL production code path (`resubscribeTeamEvents`).
// ---------------------------------------------------------------------------

async function setupTeamWithWorkers(workerCount = 1) {
	const goals = new Map<string, MockGoal>();
	const goal = createMockGoal();
	goals.set(goal.id, goal);
	const sm = createMockSessionManager(goals);

	// Mirror real SessionManager.enqueuePrompt: record the call and set
	// lastPromptSource on the target session.
	const enqueuePrompt = mock.fn((sid: string, _msg: string, opts?: any) => {
		const s = sm._sessions.get(sid);
		if (s) s.lastPromptSource = opts?.source ?? "user";
	});
	sm.enqueuePrompt = enqueuePrompt;
	// notifyTeamLead uses deliverLiveSteer only when the lead is streaming; the
	// lead is idle here so this should never be hit, but provide it so any
	// accidental streaming path is still observable.
	const deliverLiveSteer = mock.fn(async () => {});
	sm.deliverLiveSteer = deliverLiveSteer;

	const team = createTeamManager(sm);
	await team.startTeam("goal-1");
	// These tests focus on the per-worker idle debounce unless explicitly
	// overriding the lead-level coalescing window in a coalescing test.
	(team as any).teamLeadNotifyCoalesceMs = 1;

	const entry = (team as any).teams.get("goal-1")!;
	const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
	tlSession.status = "idle";

	// Register worker sessions whose onEvent callbacks we capture so we can
	// fire `agent_end` / `agent_start` at the real subscription.
	const workerSessionIds: string[] = [];
	const workerCallbacksById = new Map<string, Array<(event: any) => void>>();
	for (let i = 0; i < workerCount; i++) {
		const workerSessionId = `worker-${i + 1}`;
		workerSessionIds.push(workerSessionId);
		const workerCallbacks: Array<(event: any) => void> = [];
		workerCallbacksById.set(workerSessionId, workerCallbacks);
		const workerSession = {
			id: workerSessionId,
			status: "idle",
			cwd: `/tmp/${workerSessionId}`,
			rpcClient: {
				prompt: mock.fn(async () => {}),
				onEvent: mock.fn((cb: any) => {
					workerCallbacks.push(cb);
					return () => {};
				}),
			},
			clients: new Set(),
		};
		sm._sessions.set(workerSessionId, workerSession);
		entry.agents.push({
			sessionId: workerSessionId,
			role: "coder",
			kind: "worker",
			task: `work on feature ${i + 1}`,
			createdAt: Date.now(),
		});
		// dismissRole() resolves the goal via sessionToGoal — populate it so the
		// real removal path works (resubscribeTeamEvents does not set this).
		(team as any).sessionToGoal.set(workerSessionId, "goal-1");
	}

	// Wire the worker subscription through the REAL production code path.
	team.resubscribeTeamEvents();

	for (const workerSessionId of workerSessionIds) {
		assert.ok(
			(workerCallbacksById.get(workerSessionId)?.length ?? 0) > 0,
			`harness error: worker rpcClient.onEvent was never invoked for ${workerSessionId} — resubscribeTeamEvents did not wire the worker subscription`,
		);
	}

	function fireWorker(type: "agent_end" | "agent_start", workerSessionId = workerSessionIds[0]) {
		for (const cb of workerCallbacksById.get(workerSessionId) ?? []) cb({ type });
	}

	function dispatchedMessages(): string[] {
		return [
			...enqueuePrompt.mock.calls.map((c: any) => String(c.arguments?.[1] ?? "")),
			...deliverLiveSteer.mock.calls.map((c: any) => String(c.arguments?.[1] ?? "")),
		];
	}

	// Count of team-lead worker-completion nudges.
	function workerIdleNudgeCount(): number {
		return dispatchedMessages().filter((msg) => {
			return msg.includes("**Task complete**") || msg.includes("**Agent finished**");
		}).length;
	}

	return { team, sm, entry, tlSession, workerSessionId: workerSessionIds[0], workerSessionIds, enqueuePrompt, fireWorker, dispatchedMessages, workerIdleNudgeCount };
}

async function setupTeamWithWorker() {
	return setupTeamWithWorkers(1);
}

// ---------------------------------------------------------------------------
// Bug repro scenarios
// ---------------------------------------------------------------------------

describe("TeamManager — transient worker idle blip debounce (regression)", () => {
	it("does NOT nudge the lead when a worker blips agent_end → agent_start within 5s", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { fireWorker, workerIdleNudgeCount } = await setupTeamWithWorker();

		// Transient blip: worker momentarily finishes, then resumes immediately.
		fireWorker("agent_end");
		t.mock.timers.tick(1_000); // < 5s window
		fireWorker("agent_start");

		// Advance well past the intended 5s debounce window.
		t.mock.timers.tick(6_000);

		assert.equal(
			workerIdleNudgeCount(),
			0,
			"WORKER_IDLE_BLIP_NUDGED_LEAD: a transient worker agent_end→agent_start blip " +
				"(resumed within 5s) must NOT steer the team lead with a worker-completion nudge, " +
				"but notifyTeamLead fired anyway — the worker-idle notification is not debounced/cancelled",
		);

		t.mock.timers.reset();
	});

	it("delivers exactly one nudge when a worker genuinely goes idle for >=5s", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { fireWorker, workerIdleNudgeCount } = await setupTeamWithWorker();

		// Worker finishes and stays idle — no resume.
		fireWorker("agent_end");
		t.mock.timers.tick(6_000); // past the 5s debounce window
		t.mock.timers.tick(1); // past the test-shrunk lead coalescing window

		assert.equal(
			workerIdleNudgeCount(),
			1,
			"a worker that stays idle for >=5s must produce exactly one worker-completion nudge " +
				"(subject to the existing 30s repeat-debounce)",
		);

		t.mock.timers.reset();
	});

	it("does NOT nudge against a worker removed before the 5s window elapses", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, workerSessionId, fireWorker, workerIdleNudgeCount } = await setupTeamWithWorker();

		// Worker finishes, then is dismissed before the debounce window elapses.
		fireWorker("agent_end");
		t.mock.timers.tick(1_000);
		await team.dismissRole(workerSessionId);

		// Advance past the 5s window: a pending timer (post-fix) must have been
		// cleared on removal, so no nudge fires against the torn-down session.
		t.mock.timers.tick(6_000);

		assert.equal(
			workerIdleNudgeCount(),
			0,
			"a worker removed before the 5s debounce window elapses must not produce a " +
				"worker-completion nudge — the pending idle-notify timer must be cleared on removal",
		);

		t.mock.timers.reset();
	});
});

describe("TeamManager — team-lead worker notification coalescing", () => {
	it("coalesces three workers finishing within the lead quiet window into one combined dispatch", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, workerSessionIds, fireWorker, dispatchedMessages, workerIdleNudgeCount } = await setupTeamWithWorkers(3);
		(team as any).workerIdleNudgeDebounceMs = 1;
		(team as any).teamLeadNotifyCoalesceMs = 100;

		for (const workerSessionId of workerSessionIds) fireWorker("agent_end", workerSessionId);
		t.mock.timers.tick(1);
		assert.equal(workerIdleNudgeCount(), 0, "first accepted notification should wait for the lead-level quiet window");

		t.mock.timers.tick(100);

		assert.equal(workerIdleNudgeCount(), 1, "three near-simultaneous worker finishes should dispatch one combined lead prompt");
		const [message] = dispatchedMessages().filter((msg) => msg.includes("**Team agents finished**"));
		assert.ok(message, "combined worker notification should use the team-agents heading");
		for (const workerSessionId of workerSessionIds) {
			assert.ok(
				message.includes(`\`coder-${workerSessionId.slice(0, 8)}\` (\`coder\`)`),
				`combined notification should include ${workerSessionId}`,
			);
		}
		assert.ok(
			message.indexOf("`coder-worker-1`") < message.indexOf("`coder-worker-2`")
				&& message.indexOf("`coder-worker-2`") < message.indexOf("`coder-worker-3`"),
			"combined notification should preserve worker arrival order",
		);

		t.mock.timers.reset();
	});

	it("sends a separate dispatch for a worker notification that arrives after the quiet window", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, workerSessionIds, fireWorker, workerIdleNudgeCount } = await setupTeamWithWorkers(2);
		(team as any).workerIdleNudgeDebounceMs = 1;
		(team as any).teamLeadNotifyCoalesceMs = 50;

		fireWorker("agent_end", workerSessionIds[0]);
		t.mock.timers.tick(1);
		t.mock.timers.tick(50);
		assert.equal(workerIdleNudgeCount(), 1, "first worker should flush after the quiet window");

		fireWorker("agent_end", workerSessionIds[1]);
		t.mock.timers.tick(1);
		t.mock.timers.tick(50);
		assert.equal(workerIdleNudgeCount(), 2, "worker finishing after the quiet window should produce a separate dispatch");

		t.mock.timers.reset();
	});

	it("keeps the existing per-worker 30s dedupe on top of lead coalescing", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, fireWorker, workerIdleNudgeCount } = await setupTeamWithWorker();
		(team as any).workerIdleNudgeDebounceMs = 1;
		(team as any).teamLeadNotifyCoalesceMs = 1;

		fireWorker("agent_end");
		t.mock.timers.tick(1);
		t.mock.timers.tick(1);
		assert.equal(workerIdleNudgeCount(), 1, "first worker finish should dispatch");

		fireWorker("agent_end");
		t.mock.timers.tick(1);
		t.mock.timers.tick(1);
		assert.equal(workerIdleNudgeCount(), 1, "repeat finish from same worker inside 30s should be deduped");

		t.mock.timers.reset();
	});

	it("flushes a pending lead notification batch during team teardown", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });

		const { team, fireWorker, workerIdleNudgeCount } = await setupTeamWithWorker();
		(team as any).workerIdleNudgeDebounceMs = 1;
		(team as any).teamLeadNotifyCoalesceMs = 100;

		fireWorker("agent_end");
		t.mock.timers.tick(1);
		assert.equal(workerIdleNudgeCount(), 0, "batch should still be pending before teardown");

		await team.teardownTeam("goal-1");

		assert.equal(workerIdleNudgeCount(), 1, "teardown should flush the pending worker notification before terminating the lead");
		assert.equal((team as any).pendingLeadNotify.size, 0, "teardown flush should clear the pending batch");

		t.mock.timers.reset();
	});
});
