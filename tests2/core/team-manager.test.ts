// v2-e2e-vitest real-fidelity owner: exercises TeamManager against real Git
// repositories and worktrees. Intentionally excluded from the tier-1 unit gate.
// Source: tests/team-manager.test.ts

import { describe, it, beforeAll, afterEach, afterAll, vi } from "vitest";
// Preserve real-timer hygiene within this isolated E2E suite.
afterEach(() => { vi.useRealTimers(); });
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetAgentDirStateForTests } from "../../src/server/agent-dir-config.js";
import { createManualClock, type ManualClock } from "../harness/clock.js";

// Flush pending microtasks/IO after advancing the manual clock so async timer
// callbacks settle before assertions.
const flush = () => new Promise((r) => setImmediate(r));

// Isolate from real ~/.pi state by using a temp directory.
const previousBobbitDir = process.env.BOBBIT_DIR;
const TEST_PI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-team-test-"));
process.env.BOBBIT_DIR = TEST_PI_DIR;
resetAgentDirStateForTests();

// Import AFTER setting env var and resetting cached agent-dir state so bobbitDir() picks it up.
const { TeamManager } = await import("../../src/server/agent/team-manager.ts");
import type { TeamManagerConfig } from "../../src/server/agent/team-manager.ts";

const TEAM_STORE_FILE = path.join(TEST_PI_DIR, "state", "team-state.json");
function clearTeamStore() { try { fs.unlinkSync(TEAM_STORE_FILE); } catch { /* ignore */ } }
clearTeamStore();

// ---------------------------------------------------------------------------
// Mock helpers
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
	projectId?: string;
	sandboxed?: boolean;
	team?: boolean;
	teamLeadSessionId?: string;
	archived?: boolean;
	paused?: boolean;
	workflow?: any;
}

function createMockGoal(overrides: Partial<MockGoal> = {}): MockGoal {
	return {
		id: "goal-1",
		title: "Test Goal",
		cwd: "/tmp/test-project",
		state: "todo",
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
			opts?: any,
		) => {
			const id = `session-${nextSessionId++}`;
			const session = {
				id,
				title: "New session",
				cwd,
				status: "idle" as const,
				titleGenerated: false,
				goalId,
				createOpts: opts,
				rpcClient: {
					prompt: vi.fn(async () => {}),
					onEvent: vi.fn(() => {}),
				},
				clients: new Set(),
			};
			sessions.set(id, session);
			return session;
		},
		getSession: (id: string) => sessions.get(id),
		enqueuePrompt: vi.fn(async (id: string, text: string, opts?: any) => {
			const session = sessions.get(id);
			if (session) session.lastPromptSource = opts?.source ?? "user";
			await session?.rpcClient.prompt(text);
			return { status: "dispatched" };
		}),
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
		terminateSession: vi.fn(async (id: string) => {
			sessions.delete(id);
			return true;
		}),
		isSandboxEnabled: false,
		getSandboxManager: () => undefined,
		// Goal-metadata: team-manager dispatches the goalProvisioned lifecycle hook
		// for each member worktree it creates directly (finding 1). Mocked here so
		// the spawn path can invoke it and tests can assert it was called.
		dispatchGoalProvisionedForWorktree: vi.fn(async () => {}),
		_sessions: sessions, // for test assertions
	};
}

/** Mock RoleStore that provides the roles TeamManager expects */
function createMockRoleStore() {
	const roles = new Map<string, any>([
		["team-lead", { name: "team-lead", label: "Team Lead", promptTemplate: "You are a team lead. Branch: {{GOAL_BRANCH}}, Agent: {{AGENT_ID}}", toolPolicies: { bash: "allow", read: "allow", write: "allow" }, accessory: "crown", createdAt: 0, updatedAt: 0 }],
		["coder", { name: "coder", label: "Coder", promptTemplate: "You are a coder. Branch: {{GOAL_BRANCH}}, Agent: {{AGENT_ID}}", toolPolicies: { bash: "allow", read: "allow", write: "allow", edit: "allow" }, accessory: "headphones", createdAt: 0, updatedAt: 0 }],
		["reviewer", { name: "reviewer", label: "Reviewer", promptTemplate: "You are a reviewer. Branch: {{GOAL_BRANCH}}, Agent: {{AGENT_ID}}", toolPolicies: { bash: "allow", read: "allow" }, accessory: "monocle", createdAt: 0, updatedAt: 0 }],
		["tester", { name: "tester", label: "Tester", promptTemplate: "You are a tester. Branch: {{GOAL_BRANCH}}, Agent: {{AGENT_ID}}", toolPolicies: { bash: "allow", read: "allow", write: "allow" }, accessory: "magnifier", createdAt: 0, updatedAt: 0 }],
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

/** Mock ColorStore */
function createMockColorStore() {
	const colors = new Map<string, number>();
	return {
		get: (sessionId: string) => colors.get(sessionId),
		set: (sessionId: string, idx: number) => colors.set(sessionId, idx),
		remove: (sessionId: string) => colors.delete(sessionId),
		getAll: () => Object.fromEntries(colors),
	};
}

/** Mock TaskManager */
function createMockTaskManager() {
	const tasks: any[] = [];
	return {
		getTasksByGoal: (_goalId: string) => tasks,
		getTasksForSession: (_sessionId: string) => tasks.filter((t: any) => t.assignedSessionId === _sessionId),
		createTask: (_goalId: string, task: any) => { tasks.push(task); return task; },
		getTask: (id: string) => tasks.find((t: any) => t.id === id),
		updateTask: (_id: string, _updates: any) => true,
		deleteTask: (_id: string) => true,
	};
}

const DEFAULT_CONFIG = {
	gatewayUrl: "https://10.5.0.2:3000",
	authToken: "test-token-123",
	roleStore: createMockRoleStore(),
	colorStore: createMockColorStore(),
	taskManager: createMockTaskManager(),
} as unknown as TeamManagerConfig;

interface TeamLeadEventHarness {
	emit(event: any): void;
	activeListenerCount(): number;
	unsubscribeCalls: ReturnType<typeof vi.fn>;
}

/** Capture the live team-lead subscription, including completion/reopen teardown. */
function captureTeamLeadEvents(sm: any): TeamLeadEventHarness {
	const listeners = new Set<(event: any) => void>();
	const unsubscribeCalls = vi.fn();
	const origCreateSession = sm.createSession.bind(sm);
	sm.createSession = async (
		cwd: string,
		args?: string[],
		goalId?: string,
		goalAssistant?: boolean,
		opts?: any,
	) => {
		const session = await origCreateSession(cwd, args, goalId, goalAssistant, opts);
		session.rpcClient.onEvent = vi.fn((cb: (event: any) => void) => {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
				unsubscribeCalls();
			};
		});
		return session;
	};
	return {
		emit: (event) => { for (const cb of [...listeners]) cb(event); },
		activeListenerCount: () => listeners.size,
		unsubscribeCalls,
	};
}

/** Track managers to clean up idle-nudge timers after tests */
const _createdManagers: InstanceType<typeof TeamManager>[] = [];

/** Create a TeamManager with a clean persisted state. */
function createTeamManager(sm: any, config = DEFAULT_CONFIG, clock?: ManualClock): InstanceType<typeof TeamManager> {
	clearTeamStore();
	const tm = clock ? new TeamManager(sm, config, undefined, clock) : new TeamManager(sm, config);
	// When a virtual clock is injected, stop the separate stuck-team watchdog so
	// advancing time only drives the idle-nudge timers under test.
	if (clock) tm.stopStuckSweep();
	_createdManagers.push(tm);
	return tm;
}

function createEnqueuePromptMock(sm: any) {
	return vi.fn(async (id: string, _msg: string, opts?: any) => {
		if (opts?.source !== "system") {
			const session = sm._sessions.get(id);
			if (session) session.status = "streaming";
		}
		return { status: "dispatched" };
	});
}

function assertAndClearSystemKickoff(enqueuePrompt: ReturnType<typeof vi.fn>, sessionId = "session-0"): void {
	assert.deepEqual(
		enqueuePrompt.mock.calls[0],
		[
			sessionId,
			"# Goal Spec\n\n# Test Goal\nDo something\n\n---\n\nExecute the task described in your system prompt. Follow the instructions carefully.",
			{ source: "system", suppressTitleGen: true },
		],
		"team lead kickoff text must be unchanged and attributed to Bobbit system provenance",
	);
	enqueuePrompt.mockClear();
}

// ---------------------------------------------------------------------------
// Tests: startTeam
// ---------------------------------------------------------------------------

// Clean up idle-nudge timers so the process can exit.
afterAll(() => {
	try {
		for (const tm of _createdManagers) {
			for (const [, timer] of (tm as any).idleNudgeTimers) {
				clearTimeout(timer);
			}
			(tm as any).idleNudgeTimers.clear();
			for (const [, timer] of (tm as any).noWorkersNudgeTimers ?? []) {
				clearInterval(timer);
			}
			(tm as any).noWorkersNudgeTimers?.clear?.();
		}
	} finally {
		try { fs.rmSync(TEST_PI_DIR, { recursive: true }); } catch { /* ignore */ }
		if (previousBobbitDir === undefined) delete process.env.BOBBIT_DIR;
		else process.env.BOBBIT_DIR = previousBobbitDir;
		resetAgentDirStateForTests();
	}
});

describe("TeamManager", () => {
	describe("startTeam", () => {
		it("should create a team lead session for a valid team goal", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			assert.ok(session, "should return a session");
			assert.equal(session.id, "session-0");
			assert.ok(
				session.title.startsWith("Team Lead:"),
				`title should start with "Team Lead:", got: ${session.title}`,
			);
			assert.equal(session.titleGenerated, true);
		});

		it("should transition goal from todo to in-progress", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "todo" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			assert.equal(goal.state, "in-progress");
		});

		it("should NOT transition goal that is already in-progress", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "in-progress" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			assert.equal(goal.state, "in-progress");
		});

		it("should throw if goal not found", async () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			await assert.rejects(() => team.startTeam("nonexistent"), {
				message: /Goal not found/,
			});
		});

		it("should throw if goal does not have team mode enabled", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ team: false });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await assert.rejects(() => team.startTeam("goal-1"), {
				message: /does not have team mode enabled/,
			});
		});

		it("should throw if team is already active for the goal", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");
			await assert.rejects(() => team.startTeam("goal-1"), {
				message: /Team already active/,
			});
		});

		it("should use worktreePath from goal if available", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ worktreePath: "/tmp/goal-wt" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");
			assert.equal(session.cwd, "/tmp/goal-wt");
		});

		it("should fall back to goal.cwd when worktreePath is undefined", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ worktreePath: undefined, cwd: "/tmp/fallback" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");
			assert.equal(session.cwd, "/tmp/fallback");
		});

		it("should not pass allowedTools to createSession (resolved at session setup)", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);

			// Track the opts argument passed to createSession
			let capturedOpts: any = undefined;
			const origCreateSession = sm.createSession.bind(sm);
			sm.createSession = async (
				cwd: string,
				args?: string[],
				goalId?: string,
				goalAssistant?: boolean,
				opts?: any,
			) => {
				capturedOpts = opts;
				return origCreateSession(cwd, args, goalId, goalAssistant, opts);
			};

			const team = createTeamManager(sm);
			await team.startTeam("goal-1");

			assert.ok(capturedOpts, "createSession should have been called with opts");
			assert.equal(
				capturedOpts.allowedTools,
				undefined,
				"opts.allowedTools should not be passed — session setup resolves tools from toolPolicies",
			);
		});

		it("should store session metadata with role and teamGoalId", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			assert.equal(session.role, "team-lead");
			assert.equal(session.teamGoalId, "goal-1");
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: spawnRole — only validation/state (no real git)
	// ---------------------------------------------------------------------------

	describe("spawnRole (validation)", () => {
		it("should throw for an invalid role", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			await assert.rejects(() => team.spawnRole("goal-1", "hacker", "do stuff"), {
				message: /not found/,
			});
		});

		it("should throw if no active team for the goal", async () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			await assert.rejects(() => team.spawnRole("goal-1", "coder", "code stuff"), {
				message: /No active team/,
			});
		});

		it("should skip worktree and use goal.cwd when repoPath is undefined", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ repoPath: undefined, cwd: "/tmp/no-repo" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			const result = await team.spawnRole("goal-1", "coder", "code stuff");
			assert.ok(result.sessionId, "should return a sessionId");
			// worktreePath should be undefined since no worktree was created
			assert.equal(result.worktreePath, undefined);
		});

		it("should reject team-lead role in spawnRole", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			await assert.rejects(() => team.spawnRole("goal-1", "team-lead", "lead stuff"), {
				message: /Cannot spawn team-lead/,
			});
		});

		it("should throw when concurrency limit reached", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Access the internal team entry to set maxConcurrent to 0
			// Since we can't easily mock createWorktree, we use a trick:
			// set maxConcurrent to 0 so even the first spawn fails
			const state = team.getTeamState("goal-1");
			assert.ok(state, "team state should exist");
			// We need to manipulate internals — use any cast
			(team as any).teams.get("goal-1")!.maxConcurrent = 0;

			await assert.rejects(() => team.spawnRole("goal-1", "coder", "code stuff"), {
				message: /already has 0 agents/,
			});
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: dismissRole
	// ---------------------------------------------------------------------------

	describe("dismissRole", () => {
		it("should return not-found for an unknown session", async () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			const result = await team.dismissRole("nonexistent");
			assert.deepEqual(
				{ ok: result.ok, status: result.status, sessionId: result.sessionId, retryable: result.retryable },
				{ ok: false, status: "not-found", sessionId: "nonexistent", retryable: false },
			);
		});

		it("should return not-owned when trying to dismiss the team lead", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			const result = await team.dismissRole(session.id);
			assert.deepEqual(
				{ ok: result.ok, status: result.status, sessionId: result.sessionId, retryable: result.retryable },
				{ ok: false, status: "not-owned", sessionId: session.id, retryable: false },
			);
		});

		it("should return not-found if agent not found in team entry", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Manually register a session → goal mapping that has no agent entry
			(team as any).sessionToGoal.set("orphan-session", "goal-1");

			const result = await team.dismissRole("orphan-session");
			assert.deepEqual(
				{ ok: result.ok, status: result.status, sessionId: result.sessionId, retryable: result.retryable },
				{ ok: false, status: "not-found", sessionId: "orphan-session", retryable: false },
			);
		});

		it("should keep other agents tracked during overlapping duplicate dismisses", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");
			const entry = (team as any).teams.get("goal-1")!;
			const now = Date.now();
			entry.agents.push(
				{ sessionId: "agent-a", role: "coder", kind: "worker", task: "A", createdAt: now },
				{ sessionId: "agent-b", role: "tester", kind: "worker", task: "B", createdAt: now },
			);
			(team as any).sessionToGoal.set("agent-a", "goal-1");
			(team as any).sessionToGoal.set("agent-b", "goal-1");
			sm._sessions.set("agent-a", { id: "agent-a", title: "Agent A", status: "idle" });
			sm._sessions.set("agent-b", { id: "agent-b", title: "Agent B", status: "idle" });

			let releaseTerminate!: () => void;
			let terminateStarted!: () => void;
			const terminateStartedPromise = new Promise<void>((resolve) => { terminateStarted = resolve; });
			sm.terminateSession = vi.fn(async (id: string) => {
				assert.equal(id, "agent-a");
				terminateStarted();
				await new Promise<void>((resolve) => { releaseTerminate = resolve; });
				sm._sessions.delete(id);
				return true;
			});

			const first = team.dismissRoleForGoal("goal-1", "agent-a");
			await terminateStartedPromise;
			const duplicate = team.dismissRoleForGoal("goal-1", "agent-a");

			assert.deepEqual(team.listAgents("goal-1").map((a) => a.sessionId), ["agent-a", "agent-b"]);
			releaseTerminate();

			const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
			assert.equal(sm.terminateSession.mock.calls.length, 1, "duplicate dismiss should not terminate twice");
			assert.deepEqual(
				{ ok: firstResult.ok, status: firstResult.status, sessionId: firstResult.sessionId, retryable: firstResult.retryable },
				{ ok: true, status: "dismissed", sessionId: "agent-a", retryable: false },
			);
			assert.deepEqual(
				{ ok: duplicateResult.ok, status: duplicateResult.status, sessionId: duplicateResult.sessionId, retryable: duplicateResult.retryable },
				{ ok: true, status: "already-dismissed", sessionId: "agent-a", retryable: false },
			);
			assert.deepEqual(team.listAgents("goal-1").map((a) => a.sessionId), ["agent-b"]);
			assert.equal(sm.getSession("agent-b")?.status, "idle", "agent-b should remain live");
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: listAgents
	// ---------------------------------------------------------------------------

	describe("listAgents", () => {
		it("should return empty array for non-existent team", () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			const agents = team.listAgents("nonexistent");
			assert.deepEqual(agents, []);
		});

		it("should return empty array for team with no role agents", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			const agents = team.listAgents("goal-1");
			assert.deepEqual(agents, []);
		});

		it('should return "terminated" status for agents whose session is gone', async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Manually inject a fake agent entry whose session doesn't exist
			const entry = (team as any).teams.get("goal-1")!;
			entry.agents.push({
				sessionId: "dead-session",
				role: "coder",
				worktreePath: "/tmp/dead",
				branch: "dead-branch",
				task: "some task",
				createdAt: Date.now(),
			});

			const agents = team.listAgents("goal-1");
			assert.equal(agents.length, 1);
			assert.equal(agents[0].status, "terminated");
			assert.equal(agents[0].role, "coder");
			assert.equal(agents[0].task, "some task");
		});

		it("should return the session status for live agents", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Manually inject an agent entry whose session exists
			const fakeSession = {
				id: "live-session",
				status: "streaming",
				cwd: "/tmp/live",
			};
			sm._sessions.set("live-session", fakeSession);

			const entry = (team as any).teams.get("goal-1")!;
			entry.agents.push({
				sessionId: "live-session",
				role: "reviewer",
				worktreePath: "/tmp/live",
				branch: "live-branch",
				task: "review code",
				createdAt: Date.now(),
			});

			const agents = team.listAgents("goal-1");
			assert.equal(agents.length, 1);
			assert.equal(agents[0].status, "streaming");
			assert.equal(agents[0].role, "reviewer");
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: getTeamState
	// ---------------------------------------------------------------------------

	describe("getTeamState", () => {
		it("should return undefined for non-existent team", () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			const state = team.getTeamState("nonexistent");
			assert.equal(state, undefined);
		});

		it("should return full state for active team", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			const state = team.getTeamState("goal-1");
			assert.ok(state, "state should be defined");
			assert.equal(state!.goalId, "goal-1");
			assert.equal(state!.teamLeadSessionId, session.id);
			assert.equal(state!.maxConcurrent, 12);
			assert.deepEqual(state!.agents, []);
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: completeTeam
	// ---------------------------------------------------------------------------

	describe("completeTeam", () => {
		it("should throw if no active team", async () => {
			const sm = createMockSessionManager(new Map());
			const team = createTeamManager(sm);

			await assert.rejects(() => team.completeTeam("nonexistent"), {
				message: /No active team/,
			});
		});

		it("should update goal state and keep team lead alive", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("goal-1");

			await team.completeTeam("goal-1");

			// Goal state should be "complete"
			assert.equal(goal.state, "complete");

			// Team state should still exist (team lead remains for reporting)
			const state = team.getTeamState("goal-1");
			assert.ok(state, "team state should still exist");
			assert.equal(state!.teamLeadSessionId, session.id);

			// Team lead session should still be alive
			assert.equal(sm._sessions.has(session.id), true);
		});

		it("should dismiss all role agents during completion", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");

			// Manually inject agents (to avoid needing real git)
			const entry = (team as any).teams.get("goal-1")!;
			const agentSession1 = {
				id: "agent-1",
				title: "Coder Agent",
				cwd: "/tmp/wt1",
				status: "idle",
				rpcClient: { prompt: async () => {} },
				clients: new Set(),
			};
			const agentSession2 = {
				id: "agent-2",
				title: "Tester Agent",
				cwd: "/tmp/wt2",
				status: "idle",
				rpcClient: { prompt: async () => {} },
				clients: new Set(),
			};
			sm._sessions.set("agent-1", agentSession1);
			sm._sessions.set("agent-2", agentSession2);

			entry.agents.push(
				{
					sessionId: "agent-1",
					role: "coder",
					worktreePath: "/tmp/wt1",
					branch: "branch-1",
					task: "code stuff",
					createdAt: Date.now(),
				},
				{
					sessionId: "agent-2",
					role: "tester",
					worktreePath: "/tmp/wt2",
					branch: "branch-2",
					task: "test stuff",
					createdAt: Date.now(),
				},
			);
			(team as any).sessionToGoal.set("agent-1", "goal-1");
			(team as any).sessionToGoal.set("agent-2", "goal-1");

			await team.completeTeam("goal-1");

			// Role agents should be terminated, but team lead remains
			assert.equal(sm._sessions.has("agent-1"), false);
			assert.equal(sm._sessions.has("agent-2"), false);
			assert.equal(sm._sessions.has("session-0"), true); // team lead alive
			assert.ok(team.getTeamState("goal-1"), "team state should still exist");
			assert.equal(goal.state, "complete");
		});

		it("revalidates gates after awaited dismissals and rearms instead of completing after an interleaved reset", async () => {
			const clock = createManualClock();
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({
				state: "in-progress",
				workflow: { gates: [{ id: "implementation", name: "Implementation", dependsOn: [] }] },
			});
			goals.set(goal.id, goal);
			const gateStates = [{ gateId: "implementation", status: "passed" }];
			const gateStore = { getGatesForGoal: vi.fn(() => gateStates.map((gate) => ({ ...gate }))) };
			const sm = createMockSessionManager(goals);
			const events = captureTeamLeadEvents(sm);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;
			let releaseDismiss!: () => void;
			const dismissBlocked = new Promise<void>((resolve) => { releaseDismiss = resolve; });
			let markDismissStarted!: () => void;
			const dismissStarted = new Promise<void>((resolve) => { markDismissStarted = resolve; });
			sm.terminateSession = vi.fn(async (id: string) => {
				markDismissStarted();
				await dismissBlocked;
				sm._sessions.delete(id);
				return true;
			});
			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);
			(team as any).resolveGateStore = () => gateStore;

			await team.startTeam(goal.id);
			assertAndClearSystemKickoff(enqueuePrompt);
			const entry = (team as any).teams.get(goal.id)!;
			sm._sessions.set("worker-race", {
				id: "worker-race",
				status: "idle",
				cwd: "/tmp/worker-race",
				rpcClient: { onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			});
			entry.agents.push({ sessionId: "worker-race", role: "coder", task: "finish", createdAt: clock.now() });
			(team as any).sessionToGoal.set("worker-race", goal.id);

			const completing = team.completeTeam(goal.id);
			await dismissStarted;
			gateStates[0].status = "pending";
			releaseDismiss();

			await assert.rejects(completing, /Cannot complete: gates not passed: Implementation/);
			assert.equal(goal.state, "in-progress", "an interleaved reset must win over completion");
			assert.ok(gateStore.getGatesForGoal.mock.calls.length >= 2, "workflow gates must be read again after dismissal");
			assert.equal(events.activeListenerCount(), 1, "aborted completion must restore the lead subscription");
			assert.equal((team as any).noWorkersNudgeTimers.size, 1, "aborted completion must restore the base-delay timer");

			clock.advance(5 * 60 * 1000);
			await flush();
			assert.equal(enqueuePrompt.mock.calls.length, 1, "the restored idle lead must remain nudge eligible");
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: reset-driven completed-team reopen
	// ---------------------------------------------------------------------------

	describe("reopenCompletedTeam", () => {
		it("keeps a completed team unsubscribed and suppressed until explicitly reopened", async () => {
			const clock = createManualClock();
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "in-progress" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const events = captureTeamLeadEvents(sm);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;
			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);

			await team.startTeam(goal.id);
			assertAndClearSystemKickoff(enqueuePrompt);
			assert.equal(events.activeListenerCount(), 1);
			await team.completeTeam(goal.id);

			assert.equal(goal.state, "complete");
			assert.equal(events.activeListenerCount(), 0, "completion must remove the idle lifecycle subscription");
			(team as any).startIdleNudgeTimer(goal.id);
			clock.advance(10 * 60 * 1000);
			await flush();
			assert.equal(enqueuePrompt.mock.calls.length, 0, "completed-goal suppression must remain intact");
		});

		it("rearms an idle reset-reopened team at the base delay without duplicate subscriptions or timers", async () => {
			const clock = createManualClock();
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "in-progress" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const events = captureTeamLeadEvents(sm);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;
			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);

			const lead = await team.startTeam(goal.id);
			assertAndClearSystemKickoff(enqueuePrompt);
			await team.completeTeam(goal.id);
			assert.equal(events.activeListenerCount(), 0);

			// The reset coordinator owns the persisted state transition, then asks
			// TeamManager to rearm the existing lead/team runtime.
			goal.state = "in-progress";
			await (team as any).reopenCompletedTeam(goal.id);
			await (team as any).reopenCompletedTeam(goal.id);

			assert.equal(team.getTeamState(goal.id)?.teamLeadSessionId, lead.id, "reopen must preserve the lead session");
			assert.equal(events.activeListenerCount(), 1, "repeated reopen must replace, not duplicate, subscriptions");
			assert.equal((team as any).noWorkersNudgeTimers.size, 1, "only one no-workers timer may be armed");
			assert.equal((team as any).idleNudgeTimers.size, 1, "only one workers timer may be armed");

			clock.advance(5 * 60 * 1000);
			await flush();
			assert.equal(enqueuePrompt.mock.calls.length, 1, "reopened idle lead must receive one base-delay nudge");
			assert.match(enqueuePrompt.mock.calls[0][1], /no active team agents/i);
		});

		it("retries rearm after an old unsubscribe callback throws without duplicating runtime state", async () => {
			const clock = createManualClock();
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "in-progress" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const events = captureTeamLeadEvents(sm);
			sm.enqueuePrompt = createEnqueuePromptMock(sm);
			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);

			await team.startTeam(goal.id);
			await team.completeTeam(goal.id);
			goal.state = "in-progress";
			const entry = (team as any).teams.get(goal.id)!;
			let shouldThrow = true;
			const staleUnsubscribe = vi.fn(() => {
				if (shouldThrow) {
					shouldThrow = false;
					throw new Error("transient unsubscribe failure");
				}
			});
			entry.unsubscribeTeamLeadEvents = staleUnsubscribe;

			assert.equal(team.reopenCompletedTeam(goal.id), false, "failed cleanup must report that rearm did not happen");
			assert.equal(events.activeListenerCount(), 0);
			assert.equal((team as any).noWorkersNudgeTimers.size, 0);
			assert.equal(team.reopenCompletedTeam(goal.id), true, "a failed attempt must remain retryable");
			assert.equal(team.reopenCompletedTeam(goal.id), false, "a successful rearm must be idempotent");
			assert.equal(staleUnsubscribe.mock.calls.length, 2);
			assert.equal(events.activeListenerCount(), 1);
			assert.equal((team as any).noWorkersNudgeTimers.size, 1);
		});

		it("retries rearm after rpc onEvent throws without poisoning idempotency", async () => {
			const clock = createManualClock();
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "in-progress" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const events = captureTeamLeadEvents(sm);
			sm.enqueuePrompt = createEnqueuePromptMock(sm);
			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);

			const lead = await team.startTeam(goal.id);
			await team.completeTeam(goal.id);
			goal.state = "in-progress";
			const workingOnEvent = lead.rpcClient.onEvent.bind(lead.rpcClient);
			let shouldThrow = true;
			lead.rpcClient.onEvent = vi.fn((callback: (event: any) => void) => {
				if (shouldThrow) {
					shouldThrow = false;
					throw new Error("transient onEvent failure");
				}
				return workingOnEvent(callback);
			});

			assert.equal(team.reopenCompletedTeam(goal.id), false);
			assert.equal(events.activeListenerCount(), 0);
			assert.equal((team as any).noWorkersNudgeTimers.size, 0);
			assert.equal(team.reopenCompletedTeam(goal.id), true);
			assert.equal(team.reopenCompletedTeam(goal.id), false);
			assert.equal((lead.rpcClient.onEvent as any).mock.calls.length, 2);
			assert.equal(events.activeListenerCount(), 1);
			assert.equal((team as any).noWorkersNudgeTimers.size, 1);
		});

		it("restores workers-idle nudge eligibility after the reset transition", async () => {
			const clock = createManualClock();
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "in-progress" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			captureTeamLeadEvents(sm);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;
			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);

			await team.startTeam(goal.id);
			assertAndClearSystemKickoff(enqueuePrompt);
			await team.completeTeam(goal.id);
			goal.state = "in-progress";
			const entry = (team as any).teams.get(goal.id)!;
			sm._sessions.set("worker-reopened", {
				id: "worker-reopened",
				status: "idle",
				cwd: "/tmp/worker-reopened",
				rpcClient: { onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			});
			entry.agents.push({
				sessionId: "worker-reopened",
				role: "coder",
				task: "continue reset gate",
				createdAt: clock.now(),
			});

			await (team as any).reopenCompletedTeam(goal.id);
			clock.advance(10 * 60 * 1000);
			await flush();

			assert.equal(enqueuePrompt.mock.calls.length, 1, "workers-idle timer must resume after reopen");
			assert.match(enqueuePrompt.mock.calls[0][1], /team check-in/i);
		});

		it("restores stuck-sweep eligibility after the reset transition", async () => {
			const clock = createManualClock();
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "in-progress" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			captureTeamLeadEvents(sm);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;
			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);

			await team.startTeam(goal.id);
			assertAndClearSystemKickoff(enqueuePrompt);
			await team.completeTeam(goal.id);
			goal.state = "in-progress";
			const entry = (team as any).teams.get(goal.id)!;
			sm._sessions.set("worker-stuck", {
				id: "worker-stuck",
				status: "idle",
				cwd: "/tmp/worker-stuck",
				rpcClient: { onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			});
			entry.agents.push({
				sessionId: "worker-stuck",
				role: "coder",
				task: "continue reset gate",
				createdAt: clock.now(),
			});

			await (team as any).reopenCompletedTeam(goal.id);
			(team as any)._stuckSweepTick(clock.now() + 5 * 60 * 1000);

			assert.equal(enqueuePrompt.mock.calls.length, 1, "stuck sweep must resume after reopen");
			assert.match(enqueuePrompt.mock.calls[0][1], /workflow has stalled/i);
		});

		it.each([
			["archived", { state: "complete", archived: true }],
			["shelved", { state: "shelved" }],
			["paused", { state: "complete", paused: true }],
		] as const)("continues suppressing %s goals", async (_label, overrides) => {
			const clock = createManualClock();
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ state: "in-progress" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;
			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);
			await team.startTeam(goal.id);
			assertAndClearSystemKickoff(enqueuePrompt);
			Object.assign(goal, overrides);

			(team as any).startIdleNudgeTimer(goal.id);
			clock.advance(10 * 60 * 1000);
			await flush();

			assert.equal(enqueuePrompt.mock.calls.length, 0, `${_label} goal must never be resumed implicitly`);
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: idle nudge sleep guard (reproducing bug)
	// ---------------------------------------------------------------------------

	describe("idle nudge sleep guard", () => {
		it("should only enqueue one nudge after sleep wake (pending guard)", async () => {
			const clock = createManualClock();

			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);

			// Track prompt routing separately so the sleep guard can ignore the system kickoff.
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;

			// Capture onEvent callbacks so we can simulate lifecycle events
			const eventCallbacks: Array<(event: any) => void> = [];
			const origCreateSession = sm.createSession.bind(sm);
			sm.createSession = async (
				cwd: string,
				args?: string[],
				goalId?: string,
				goalAssistant?: boolean,
				opts?: any,
			) => {
				const session = await origCreateSession(cwd, args, goalId, goalAssistant, opts);
				// Replace onEvent to capture the callback
				session.rpcClient.onEvent = vi.fn((cb: any) => {
					eventCallbacks.push(cb);
					return () => {};
				});
				return session;
			};

			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);
			await team.startTeam("goal-1");
			assertAndClearSystemKickoff(enqueuePrompt);

			// Get the team lead session and inject a fake active worker
			const entry = (team as any).teams.get("goal-1")!;
			const workerSession = {
				id: "worker-1",
				status: "streaming",
				cwd: "/tmp/worker",
				rpcClient: { prompt: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			};
			sm._sessions.set("worker-1", workerSession);
			// Worker is idle — the workers-nudge fires regardless of streaming-threshold guard
			workerSession.status = "idle";
			entry.agents.push({
				sessionId: "worker-1",
				role: "coder",
				task: "work on feature",
				createdAt: Date.now(),
			});

			// Set the team lead to idle so shouldSkipNudge() passes
			const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
			tlSession.status = "idle";

			// Simulate agent_end on the team lead — this triggers startIdleNudgeTimer()
			for (const cb of eventCallbacks) {
				cb({ type: "agent_end" });
			}

			// Advance time by 5 hours — simulates a sleep/wake where all overdue intervals fire
			clock.advance(5 * 60 * 60 * 1000);
			await flush();

			// CORRECT behavior: only ONE nudge should be enqueued, not ~30
			const callCount = enqueuePrompt.mock.calls.length;
			assert.ok(
				callCount <= 1,
				`Expected enqueuePrompt to be called at most once (pending guard), but got ${callCount}`,
			);
		});

		it("should resume nudging after agent processes the pending nudge", async () => {
			const clock = createManualClock();

			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;

			const eventCallbacks: Array<(event: any) => void> = [];
			const origCreateSession = sm.createSession.bind(sm);
			sm.createSession = async (cwd: string, args?: string[], goalId?: string, goalAssistant?: boolean, opts?: any) => {
				const session = await origCreateSession(cwd, args, goalId, goalAssistant, opts);
				session.rpcClient.onEvent = vi.fn((cb: any) => { eventCallbacks.push(cb); return () => {}; });
				return session;
			};

			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);
			await team.startTeam("goal-1");
			assertAndClearSystemKickoff(enqueuePrompt);

			const entry = (team as any).teams.get("goal-1")!;
			const workerSession = {
				id: "worker-1", status: "idle", cwd: "/tmp/worker",
				rpcClient: { prompt: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			};
			sm._sessions.set("worker-1", workerSession);
			entry.agents.push({ sessionId: "worker-1", role: "coder", task: "work", createdAt: Date.now() });

			const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
			tlSession.status = "idle";

			// Trigger agent_end to start nudge timer
			for (const cb of eventCallbacks) cb({ type: "agent_end" });

			// Advance 5 hours — should get exactly 1 nudge (pending guard blocks the rest)
			clock.advance(5 * 60 * 60 * 1000);
			await flush();
			assert.equal(enqueuePrompt.mock.calls.length, 1, "First batch: exactly 1 nudge");

			// Simulate agent processing the nudge: agent_start then agent_end
			for (const cb of eventCallbacks) cb({ type: "agent_start" });
			tlSession.status = "idle";
			for (const cb of eventCallbacks) cb({ type: "agent_end" });

			// Advance another 15 minutes — should get a second nudge
			clock.advance(15 * 60 * 1000);
			await flush();
			assert.ok(enqueuePrompt.mock.calls.length >= 2, "Second nudge should fire after agent processes first");
		});

		it("should not nudge a team lead whose goal is already complete", async () => {
			const clock = createManualClock();

			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;

			const eventCallbacks: Array<(event: any) => void> = [];
			const origCreateSession = sm.createSession.bind(sm);
			sm.createSession = async (cwd: string, args?: string[], goalId?: string, goalAssistant?: boolean, opts?: any) => {
				const session = await origCreateSession(cwd, args, goalId, goalAssistant, opts);
				session.rpcClient.onEvent = vi.fn((cb: any) => { eventCallbacks.push(cb); return () => {}; });
				return session;
			};

			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);
			await team.startTeam("goal-1");
			assertAndClearSystemKickoff(enqueuePrompt);

			const entry = (team as any).teams.get("goal-1")!;
			const workerSession = {
				id: "worker-1", status: "idle", cwd: "/tmp/worker",
				rpcClient: { prompt: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			};
			sm._sessions.set("worker-1", workerSession);
			entry.agents.push({ sessionId: "worker-1", role: "coder", task: "work", createdAt: Date.now() });

			const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
			tlSession.status = "idle";

			// Mark the goal complete — workflow finished.
			goal.state = "complete";

			for (const cb of eventCallbacks) cb({ type: "agent_end" });
			clock.advance(5 * 60 * 60 * 1000);
			await flush();

			assert.equal(enqueuePrompt.mock.calls.length, 0, "Completed goal team lead must not be nudged");
		});

		it("should not nudge a team lead whose goal is archived", async () => {
			const clock = createManualClock();

			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;

			const eventCallbacks: Array<(event: any) => void> = [];
			const origCreateSession = sm.createSession.bind(sm);
			sm.createSession = async (cwd: string, args?: string[], goalId?: string, goalAssistant?: boolean, opts?: any) => {
				const session = await origCreateSession(cwd, args, goalId, goalAssistant, opts);
				session.rpcClient.onEvent = vi.fn((cb: any) => { eventCallbacks.push(cb); return () => {}; });
				return session;
			};

			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);
			await team.startTeam("goal-1");
			assertAndClearSystemKickoff(enqueuePrompt);

			const entry = (team as any).teams.get("goal-1")!;
			const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
			tlSession.status = "idle";
			(goal as any).archived = true;

			for (const cb of eventCallbacks) cb({ type: "agent_end" });
			clock.advance(5 * 60 * 60 * 1000);
			await flush();

			assert.equal(enqueuePrompt.mock.calls.length, 0, "Archived goal team lead must not be nudged");
		});

		it("should skip workers-nudge when all streaming workers are under 30 min", async () => {
			const clock = createManualClock();

			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;

			const eventCallbacks: Array<(event: any) => void> = [];
			const origCreateSession = sm.createSession.bind(sm);
			sm.createSession = async (cwd: string, args?: string[], goalId?: string, goalAssistant?: boolean, opts?: any) => {
				const session = await origCreateSession(cwd, args, goalId, goalAssistant, opts);
				session.rpcClient.onEvent = vi.fn((cb: any) => { eventCallbacks.push(cb); return () => {}; });
				return session;
			};

			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);
			await team.startTeam("goal-1");
			assertAndClearSystemKickoff(enqueuePrompt);

			const entry = (team as any).teams.get("goal-1")!;
			// Worker streaming since "now" (virtual clock) — well under 30m
			const workerSession = {
				id: "worker-1", status: "streaming", cwd: "/tmp/worker",
				streamingStartedAt: clock.now(), // virtual clock baseline
				rpcClient: { prompt: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			};
			sm._sessions.set("worker-1", workerSession);
			entry.agents.push({ sessionId: "worker-1", role: "coder", task: "work", createdAt: clock.now() });

			const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
			tlSession.status = "idle";

			for (const cb of eventCallbacks) cb({ type: "agent_end" });

			// Advance past the 10-minute base workers-nudge delay
			// (and keep worker streamingStartedAt under threshold by tick < 30m from its start)
			clock.advance(15 * 60 * 1000);
			await flush();

			assert.equal(
				enqueuePrompt.mock.calls.length, 0,
				"Should not nudge when all streaming workers are under the 30m threshold",
			);
		});

		it("should nudge when any streaming worker exceeds 30 min", async () => {
			const clock = createManualClock();

			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;

			const eventCallbacks: Array<(event: any) => void> = [];
			const origCreateSession = sm.createSession.bind(sm);
			sm.createSession = async (cwd: string, args?: string[], goalId?: string, goalAssistant?: boolean, opts?: any) => {
				const session = await origCreateSession(cwd, args, goalId, goalAssistant, opts);
				session.rpcClient.onEvent = vi.fn((cb: any) => { eventCallbacks.push(cb); return () => {}; });
				return session;
			};

			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);
			await team.startTeam("goal-1");
			assertAndClearSystemKickoff(enqueuePrompt);

			const entry = (team as any).teams.get("goal-1")!;
			// Worker that has been streaming for a long time already (45m ago, virtual clock)
			const workerSession = {
				id: "worker-1", status: "streaming", cwd: "/tmp/worker",
				streamingStartedAt: clock.now() - 45 * 60 * 1000,
				rpcClient: { prompt: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			};
			sm._sessions.set("worker-1", workerSession);
			entry.agents.push({ sessionId: "worker-1", role: "coder", task: "work", createdAt: clock.now() });

			const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
			tlSession.status = "idle";

			for (const cb of eventCallbacks) cb({ type: "agent_end" });

			// Advance past the 10-minute base workers-nudge delay
			clock.advance(15 * 60 * 1000);
			await flush();

			assert.equal(
				enqueuePrompt.mock.calls.length, 1,
				"Should nudge when a streaming worker has exceeded the 30m threshold",
			);
		});

		it("should still nudge when a worker is idle (not streaming)", async () => {
			const clock = createManualClock();

			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;

			const eventCallbacks: Array<(event: any) => void> = [];
			const origCreateSession = sm.createSession.bind(sm);
			sm.createSession = async (cwd: string, args?: string[], goalId?: string, goalAssistant?: boolean, opts?: any) => {
				const session = await origCreateSession(cwd, args, goalId, goalAssistant, opts);
				session.rpcClient.onEvent = vi.fn((cb: any) => { eventCallbacks.push(cb); return () => {}; });
				return session;
			};

			const team = createTeamManager(sm, DEFAULT_CONFIG, clock);
			await team.startTeam("goal-1");
			assertAndClearSystemKickoff(enqueuePrompt);

			const entry = (team as any).teams.get("goal-1")!;
			const workerSession = {
				id: "worker-1", status: "idle", cwd: "/tmp/worker",
				rpcClient: { prompt: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			};
			sm._sessions.set("worker-1", workerSession);
			entry.agents.push({ sessionId: "worker-1", role: "coder", task: "work", createdAt: clock.now() });

			const tlSession = sm._sessions.get(entry.teamLeadSessionId)!;
			tlSession.status = "idle";

			for (const cb of eventCallbacks) cb({ type: "agent_end" });
			clock.advance(15 * 60 * 1000);
			await flush();

			assert.equal(
				enqueuePrompt.mock.calls.length, 1,
				"Idle workers should not block the workers-nudge",
			);
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: notifyTeamLead retries errored idle team leads instead of nudging
	// ---------------------------------------------------------------------------

	describe("notifyTeamLead errored idle recovery", () => {
		it("retries worker agent_end nudge when team lead lastTurnErrored without enqueueing auto-nudge", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			const deliverLiveSteer = vi.fn(async (_id: string, _msg: string) => {});
			const retryLastPrompt = vi.fn((_id: string, _opts?: any) => ({ status: "queued" }));
			sm.enqueuePrompt = enqueuePrompt;
			sm.deliverLiveSteer = deliverLiveSteer;
			sm.retryLastPrompt = retryLastPrompt;

			const team = createTeamManager(sm);
			const teamLead = await team.startTeam("goal-1");
			assertAndClearSystemKickoff(enqueuePrompt);
			(teamLead as any).status = "idle";
			(teamLead as any).lastTurnErrored = true;
			(teamLead as any).lastTurnErrorMessage = "server_error: upstream provider returned retryable server error";

			const entry = (team as any).teams.get("goal-1")!;
			sm._sessions.set("worker-1", {
				id: "worker-1",
				status: "idle",
				cwd: "/tmp/worker",
				rpcClient: { prompt: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			});
			entry.agents.push({ sessionId: "worker-1", role: "coder", task: "work", createdAt: Date.now() });

			await (team as any).notifyTeamLead("goal-1", "worker-1", "coder", "coder-xyz");

			assert.equal(retryLastPrompt.mock.calls.length, 1);
			assert.deepEqual(retryLastPrompt.mock.calls[0], [teamLead.id, { auto: true }]);
			assert.equal(enqueuePrompt.mock.calls.length, 0, "errored idle team lead should not receive an auto-nudge prompt");
			assert.equal(deliverLiveSteer.mock.calls.length, 0, "errored idle team lead should not receive a live auto-nudge steer");
		});

		it("formats worker completion nudges as compact markdown with task_list next step", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const enqueuePrompt = createEnqueuePromptMock(sm);
			sm.enqueuePrompt = enqueuePrompt;
			sm.deliverLiveSteer = vi.fn(async (_id: string, _msg: string) => {});

			const taskManager = {
				getTasksForSession: (_sessionId: string) => [{
					id: "task-1",
					goalId: "goal-1",
					title: "Milestone 1 E2E inventory by feature and layer",
					type: "test",
					state: "complete",
					assignedSessionId: "worker-1",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					resultSummary: "Branch goal/f1b2cd81/test-engineer-5dac pushed at dca79a31d4ab72a3bc10abda358e6a98d19d7798. Updated `docs/testing-metrics/e2e-inventory.md`. Validation passed: `git diff --check`; tests skipped (docs-only). Working copy clean after push.",
				}],
			};
			const team = createTeamManager(sm, { ...DEFAULT_CONFIG, taskManager: taskManager as any });
			const teamLead = await team.startTeam("goal-1");
			assertAndClearSystemKickoff(enqueuePrompt);
			(teamLead as any).status = "idle";

			const entry = (team as any).teams.get("goal-1")!;
			sm._sessions.set("worker-1", {
				id: "worker-1",
				status: "idle",
				cwd: "/tmp/worker",
				rpcClient: { prompt: vi.fn(async () => {}), onEvent: vi.fn(() => () => {}) },
				clients: new Set(),
			});
			entry.agents.push({ sessionId: "worker-1", role: "test-engineer", task: "work", createdAt: Date.now() });

			await (team as any).notifyTeamLead("goal-1", "worker-1", "test-engineer", "test-engineer-5dac");

			const [, message, opts] = enqueuePrompt.mock.calls[0] as any[];
			assert.equal(opts?.source, "auto-nudge");
			assert.equal(
				message,
				"**Task complete**\n\n" +
					"- **Agent:** `test-engineer-5dac` (`test-engineer`)\n" +
					"- **Task:** **Milestone 1 E2E inventory by feature and layer** (`complete`)\n" +
					"- **Result:** Updated `docs/testing-metrics/e2e-inventory.md`\n" +
					"- **Branch:** `goal/f1b2cd81/test-engineer-5dac` @ `dca79a31`\n" +
					"- **Checks:** `git diff --check`; tests skipped (docs-only)\n" +
					"- **Next:** `task_list`, then review task and decide next step.",
			);
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: multiple teams for different goals
	// ---------------------------------------------------------------------------

	describe("multiple goals", () => {
		it("should manage independent teams for different goals", async () => {
			const goals = new Map<string, MockGoal>();
			const goal1 = createMockGoal({ id: "goal-1", title: "Goal 1" });
			const goal2 = createMockGoal({ id: "goal-2", title: "Goal 2" });
			goals.set(goal1.id, goal1);
			goals.set(goal2.id, goal2);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const s1 = await team.startTeam("goal-1");
			const s2 = await team.startTeam("goal-2");

			assert.notEqual(s1.id, s2.id);

			const state1 = team.getTeamState("goal-1");
			const state2 = team.getTeamState("goal-2");
			assert.ok(state1);
			assert.ok(state2);
			assert.equal(state1!.teamLeadSessionId, s1.id);
			assert.equal(state2!.teamLeadSessionId, s2.id);

			// Completing one team should not affect the other
			await team.completeTeam("goal-1");
			assert.ok(team.getTeamState("goal-1"), "completed team still has state");
			assert.ok(team.getTeamState("goal-2"), "other team unaffected");
		});
	});

	// ---------------------------------------------------------------------------
	// Tests: persistence (TeamStore)
	// ---------------------------------------------------------------------------

	describe("persistence", () => {
		it("should persist team state and restore on new TeamManager instance", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);

			// Clear store and create first manager
			clearTeamStore();
			const team1 = new TeamManager(sm, DEFAULT_CONFIG);

			await team1.startTeam("goal-1");

			// Manually inject an agent to simulate spawnRole (no real git)
			const entry = (team1 as any).teams.get("goal-1")!;
			entry.agents.push({
				sessionId: "agent-session-1",
				role: "coder",
				worktreePath: "/tmp/wt",
				branch: "goal-test-coder-abc",
				task: "build something",
				createdAt: Date.now(),
			});
			(team1 as any).sessionToGoal.set("agent-session-1", "goal-1");
			(team1 as any).persistEntry("goal-1");

			// Create a new TeamManager (simulates server restart)
			const team2 = new TeamManager(sm, DEFAULT_CONFIG);

			const state = team2.getTeamState("goal-1");
			assert.ok(state, "should restore team state");
			assert.equal(state!.teamLeadSessionId, "session-0");
			assert.equal(state!.agents.length, 1);
			assert.equal(state!.agents[0].role, "coder");
			assert.equal(state!.agents[0].task, "build something");
		});

		it("should persist state on completeTeam (team lead remains)", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal();
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);

			clearTeamStore();
			const team1 = new TeamManager(sm, DEFAULT_CONFIG);
			await team1.startTeam("goal-1");
			await team1.completeTeam("goal-1");

			// New manager should still see the team (team lead stays alive)
			const team2 = new TeamManager(sm, DEFAULT_CONFIG);
			const state = team2.getTeamState("goal-1");
			assert.ok(state, "completed team should be persisted");
			assert.equal(state!.agents.length, 0, "role agents should be cleared");
		});
	});

	// ---------------------------------------------------------------------------
	// Integration tests: spawnRole + dismissRole with real git worktrees
	// ---------------------------------------------------------------------------

	describe("spawnRole + dismissRole (integration with git)", () => {
		interface RealGitTemplate {
			rootPath: string;
			publishedOriginPath: string;
			unpublishedOriginPath: string;
			publishedRepoPath: string;
			unpublishedRepoPath: string;
		}

		interface GitFixture {
			repoPath: string;
			originPath: string;
		}

		let gitTemplate: RealGitTemplate | undefined;

		function runGit(args: string[], cwd?: string): string {
			return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		}

		function listedWorktreePaths(repoPath: string): string[] {
			return runGit(["worktree", "list", "--porcelain"], repoPath)
				.split(/\r?\n/)
				.filter((line) => line.startsWith("worktree "))
				.map((line) => path.resolve(line.slice("worktree ".length)));
		}

		function assertRegisteredWorktree(repoPath: string, worktreePath: string): void {
			assert.ok(
				listedWorktreePaths(repoPath).includes(path.resolve(worktreePath)),
				`${worktreePath} should remain registered in git worktree list`,
			);
		}

		function createRealGitTemplate(): RealGitTemplate {
			const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-team-template-"));
			const seedPath = path.join(rootPath, "seed");
			const unpublishedOriginPath = path.join(rootPath, "unpublished-origin.git");
			const publishedOriginPath = path.join(rootPath, "published-origin.git");
			const publishedRepoPath = path.join(rootPath, "published-repo");
			const unpublishedRepoPath = path.join(rootPath, "unpublished-repo");
			const commitArgs = (message: string) => [
				"-c", "user.email=test@test.com",
				"-c", "user.name=Test",
				"commit", "-m", message,
			];

			fs.mkdirSync(seedPath);
			runGit(["init", "--initial-branch=master"], seedPath);
			fs.writeFileSync(path.join(seedPath, "README.md"), "# test\n");
			runGit(["add", "README.md"], seedPath);
			runGit(commitArgs("init"), seedPath);

			// This immutable origin intentionally has only master. Its shared checkout
			// creates feat/test locally so local-ref-first selection stays real.
			runGit(["clone", "--bare", seedPath, unpublishedOriginPath]);

			runGit(["checkout", "-b", "feat/test"], seedPath);
			fs.writeFileSync(path.join(seedPath, "GOAL_BRANCH.txt"), "published goal branch\n");
			runGit(["add", "GOAL_BRANCH.txt"], seedPath);
			runGit(commitArgs("published goal branch"), seedPath);
			runGit(["clone", "--bare", seedPath, publishedOriginPath]);

			// Reuse protocol repositories for the whole file. Production still creates
			// every member worktree; retaining them until afterAll removes per-test Git
			// teardown from the 30-second lifecycle budget under process contention.
			runGit(["clone", "--local", "--branch", "feat/test", publishedOriginPath, publishedRepoPath]);
			runGit(["clone", "--local", unpublishedOriginPath, unpublishedRepoPath]);
			runGit(["checkout", "-b", "feat/test"], unpublishedRepoPath);
			fs.writeFileSync(path.join(unpublishedRepoPath, "GOAL_BRANCH.txt"), "local goal branch\n");
			runGit(["add", "GOAL_BRANCH.txt"], unpublishedRepoPath);
			runGit(commitArgs("local goal branch"), unpublishedRepoPath);

			return {
				rootPath,
				publishedOriginPath,
				unpublishedOriginPath,
				publishedRepoPath,
				unpublishedRepoPath,
			};
		}

		function createGitFixture(opts: { publishGoalBranch?: boolean } = {}): GitFixture {
			if (!gitTemplate) throw new Error("real git template not initialized");
			return (opts.publishGoalBranch ?? true)
				? { repoPath: gitTemplate.publishedRepoPath, originPath: gitTemplate.publishedOriginPath }
				: { repoPath: gitTemplate.unpublishedRepoPath, originPath: gitTemplate.unpublishedOriginPath };
		}

		function createRepoTeam(fixture: GitFixture, overrides: Partial<MockGoal> = {}) {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({
				repoPath: fixture.repoPath,
				cwd: fixture.repoPath,
				worktreePath: fixture.repoPath,
				...overrides,
			});
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);
			return { goal, sm, team };
		}

		beforeAll(() => {
			gitTemplate = createRealGitTemplate();
		});

		afterAll(() => {
			if (gitTemplate) {
				const rootPath = gitTemplate.rootPath;
				fs.rmSync(rootPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
				assert.equal(fs.existsSync(rootPath), false, "shared Git fixture root should be removed exactly");
				gitTemplate = undefined;
			}
		});

		// Real-Git protocol ownership matrix (one lifecycle per row; no generic canary):
		// - create/session: production worktree add, inherited files, branch, and session cwd
		// - unpublished base: local feat/test propagation plus local-only member branch
		// - sandbox base: local-ref selection passed to the container worktree boundary
		// - provisioning: hook dispatch only after the real member worktree is registered
		// - dismiss: session/tracking cleanup while the registered worktree is preserved
		// - complete: all-worker cleanup while team state and registered worktree survive
		// - persistence: real HEAD SHA survives the TeamStore reload boundary
		// - multi-member: three independently registered branches and worktree paths
		it("should create a worktree and session for a coder role", async () => {
			const fixture = createGitFixture();
			const { sm, team } = createRepoTeam(fixture);

			const teamLead = await team.startTeam("goal-1");
			sm.enqueuePrompt.mockClear();
			const result = await team.spawnRole("goal-1", "coder", "Implement feature X");

			assert.ok(result.sessionId);
			assert.ok(result.worktreePath);
			assert.ok(fs.existsSync(result.worktreePath), `worktree should exist at ${result.worktreePath}`);
			assert.ok(fs.existsSync(path.join(result.worktreePath, "README.md")), "README.md should exist in worktree");
			assert.ok(fs.existsSync(path.join(result.worktreePath, "GOAL_BRANCH.txt")), "goal branch content should exist in worktree");
			assertRegisteredWorktree(fixture.repoPath, result.worktreePath);

			const agents = team.listAgents("goal-1");
			assert.equal(agents.length, 1);
			assert.equal(agents[0].role, "coder");
			assert.equal(agents[0].task, "Implement feature X");
			assert.match(agents[0].branch!, /^goal\/goal-1\/coder-[0-9a-f]{4}$/);

			const session = sm.getSession(result.sessionId);
			assert.ok(session, "session should exist");
			assert.equal(session.cwd, result.worktreePath, "session cwd should be the production-created worktree");
			assert.equal(session.worktreePath, result.worktreePath, "session metadata should retain the member worktree");
			assert.equal(session.rpcClient.prompt.mock.calls.length, 1);
			assert.deepEqual(
				sm.enqueuePrompt.mock.calls[0],
				[
					result.sessionId,
					"Implement feature X",
					{
						source: "agent",
						author: { kind: "agent", id: `session:${teamLead.id}`, label: teamLead.title },
					},
				],
				"worker task text must be unchanged and attributed to the owning team lead",
			);
		});

		it("spawns from an unpublished local goal branch without publishing the member branch", async () => {
			const fixture = createGitFixture({ publishGoalBranch: false });
			assert.throws(
				() => runGit(["show-ref", "--verify", "--quiet", "refs/heads/feat/test"], fixture.originPath),
				"origin must not have the goal branch before spawn",
			);

			const goalId = "12345678-abcd-4000-8000-000000000001";
			const { sm, team } = createRepoTeam(fixture, { id: goalId });

			await team.startTeam(goalId);
			const previousNoPush = process.env.BOBBIT_TEST_NO_PUSH;
			process.env.BOBBIT_TEST_NO_PUSH = "1";
			let result: Awaited<ReturnType<typeof team.spawnRole>>;
			try {
				result = await team.spawnRole(goalId, "coder", "Implement from local branch");
			} finally {
				if (previousNoPush === undefined) delete process.env.BOBBIT_TEST_NO_PUSH;
				else process.env.BOBBIT_TEST_NO_PUSH = previousNoPush;
			}

			const agent = team.findAgentBySessionId(result.sessionId);
			assert.ok(agent?.branch, "agent branch should be recorded");
			assert.match(agent.branch, /^goal\/12345678\/coder-[0-9a-f]{4}$/);
			assert.ok(fs.existsSync(result.worktreePath!), "member worktree should be created from the local goal branch");
			assert.ok(
				fs.existsSync(path.join(result.worktreePath!, "GOAL_BRANCH.txt")),
				"member worktree should start from the unpublished local goal branch",
			);
			const [memberHead, goalHead] = runGit(["rev-parse", "HEAD", "feat/test"], result.worktreePath)
				.trim()
				.split(/\r?\n/);
			assert.equal(memberHead, goalHead, "member worktree HEAD should equal the unpublished local goal branch HEAD");
			assertRegisteredWorktree(fixture.repoPath, result.worktreePath!);
			const session = sm.getSession(result.sessionId);
			assert.ok(session, "member session should exist");
			assert.equal(Object.hasOwn(session, "worktreePushPolicy"), false, "new sessions must omit legacy push policy metadata");
			assert.equal(Object.hasOwn(session, "remotePublicationPolicy"), false, "new sessions must omit legacy publication metadata");
			assert.throws(
				() => runGit(["show-ref", "--verify", "--quiet", `refs/heads/${agent.branch}`], fixture.originPath),
				"local-only team member branch must not be published to origin",
			);
		});

		it("passes a local sandbox base branch for unpublished sandboxed goal branches", async () => {
			const fixture = createGitFixture({ publishGoalBranch: false });
			assert.throws(
				() => runGit(["show-ref", "--verify", "--quiet", "refs/heads/feat/test"], fixture.originPath),
				"origin must not have the goal branch before sandboxed member spawn",
			);

			const goalId = "12345678-abcd-4000-8000-000000000001";
			const { sm, team } = createRepoTeam(fixture, {
				id: goalId,
				projectId: "project-1",
				sandboxed: true,
			});
			sm.getSandboxManager = () => ({
				get: () => ({
					exec: vi.fn(async () => "0123456789abcdef0123456789abcdef01234567\n"),
				}),
			});

			await team.startTeam(goalId);
			const worktreesBeforeSpawn = listedWorktreePaths(fixture.repoPath);
			const result = await team.spawnRole(goalId, "coder", "Implement in sandbox from local branch");
			const session = sm.getSession(result.sessionId);
			assert.ok(session, "member session should exist");
			assert.equal(session.createOpts.sandboxBaseBranch, "feat/test");
			assert.notEqual(session.createOpts.sandboxBaseBranch, "origin/feat/test");
			assert.match(session.createOpts.sandboxBranch, /^goal\/12345678\/coder-[0-9a-f]{4}$/);
			assert.equal(Object.hasOwn(session, "worktreePushPolicy"), false, "new sandbox sessions must omit legacy push policy metadata");
			assert.equal(Object.hasOwn(session, "remotePublicationPolicy"), false, "new sandbox sessions must omit legacy publication metadata");
			assert.deepEqual(
				listedWorktreePaths(fixture.repoPath),
				worktreesBeforeSpawn,
				"sandbox path should delegate worktree creation instead of creating a host worktree",
			);
		});

		it("dispatches the goalProvisioned hook for the member worktree (finding 1)", async () => {
			const fixture = createGitFixture();
			const { sm, team } = createRepoTeam(fixture);
			sm.dispatchGoalProvisionedForWorktree = vi.fn(async (arg: any) => {
				assert.ok(fs.existsSync(arg.worktreePath), "hook must run after the member worktree exists");
				assertRegisteredWorktree(fixture.repoPath, arg.worktreePath);
			});

			await team.startTeam("goal-1");
			const result = await team.spawnRole("goal-1", "coder", "Implement feature X");
			const agent = team.findAgentBySessionId(result.sessionId);
			assert.ok(agent, "agent record should exist");

			const calls = sm.dispatchGoalProvisionedForWorktree.mock.calls;
			assert.ok(calls.length >= 1, "goalProvisioned must be dispatched for the member worktree");
			const arg = calls[calls.length - 1][0];
			assert.equal(arg.goalId, "goal-1", "dispatch must carry the effective goal id");
			assert.equal(arg.worktreePath, result.worktreePath, "dispatch must target the member worktree path");
			assert.equal(arg.branch, agent!.branch, "dispatch must carry the member branch");
			assert.equal(typeof arg.cwd, "string");
			assert.ok(arg.cwd.length > 0, "dispatch must carry the agent cwd");
		});

		it("should dismiss a role agent and preserve the worktree", async () => {
			const fixture = createGitFixture();
			const { sm, team } = createRepoTeam(fixture);

			await team.startTeam("goal-1");
			const result = await team.spawnRole("goal-1", "tester", "Run test suite");
			assert.ok(fs.existsSync(result.worktreePath!));
			assertRegisteredWorktree(fixture.repoPath, result.worktreePath!);

			const dismissed = await team.dismissRole(result.sessionId);
			assert.deepEqual(
				{ ok: dismissed.ok, status: dismissed.status, sessionId: dismissed.sessionId, retryable: dismissed.retryable },
				{ ok: true, status: "dismissed", sessionId: result.sessionId, retryable: false },
			);
			assert.ok(fs.existsSync(result.worktreePath!), "worktree should be preserved after dismissal");
			assertRegisteredWorktree(fixture.repoPath, result.worktreePath!);
			assert.equal(team.listAgents("goal-1").length, 0);
			assert.equal(sm._sessions.has(result.sessionId), false);
		});

		it("should handle completeTeam with real worktrees", async () => {
			const fixture = createGitFixture();
			const { goal, sm, team } = createRepoTeam(fixture);

			await team.startTeam("goal-1");
			const result = await team.spawnRole("goal-1", "coder", "Code stuff");
			assert.ok(fs.existsSync(result.worktreePath!));

			await team.completeTeam("goal-1");
			assert.ok(fs.existsSync(result.worktreePath!), "worktree should be preserved after completeTeam");
			assertRegisteredWorktree(fixture.repoPath, result.worktreePath!);
			assert.equal(sm._sessions.has(result.sessionId), false, "completeTeam should terminate the role session");
			assert.equal(team.listAgents("goal-1").length, 0, "completeTeam should clear tracked role agents");
			assert.equal(goal.state, "complete");
			assert.ok(team.getTeamState("goal-1"), "team state should still exist");
		});

		it("should persist baseSha in TeamAgent across state", async () => {
			const fixture = createGitFixture();
			const { sm, team } = createRepoTeam(fixture);

			await team.startTeam("goal-1");
			const result = await team.spawnRole("goal-1", "coder", "Persist test");
			const agent = team.findAgentBySessionId(result.sessionId);
			assert.ok(agent?.baseSha, "baseSha should be set");
			assert.match(agent.baseSha, /^[0-9a-f]{40}$/, "baseSha should be a 40-char hex SHA");

			const actualSha = runGit(["rev-parse", "HEAD"], result.worktreePath).trim();
			assert.equal(agent.baseSha, actualSha, "baseSha should match the actual HEAD SHA");

			const restoredTeam = new TeamManager(sm, DEFAULT_CONFIG);
			const restoredAgent = restoredTeam.findAgentBySessionId(result.sessionId);
			assert.equal(restoredAgent?.baseSha, actualSha, "real Git baseSha should survive TeamStore reload");
		});

		describe("distinct multi-role worktrees", () => {
			const roles = ["coder", "reviewer", "tester"] as const;
			let fixture: GitFixture;
			let team: ReturnType<typeof createRepoTeam>["team"];
			const results: { sessionId: string; worktreePath?: string }[] = [];

			beforeAll(async () => {
				fixture = createGitFixture();
				({ team } = createRepoTeam(fixture));
				await team.startTeam("goal-1");
			});

			afterAll(async () => {
				for (const result of results) await team.dismissRole(result.sessionId);
			});

			async function spawnMember(role: typeof roles[number]): Promise<void> {
				const result = await team.spawnRole("goal-1", role, `${role} task`);
				results.push(result);
				assert.ok(fs.existsSync(result.worktreePath!), `worktree for ${role} should exist`);
			}

			it("creates the coder worktree", async () => {
				await spawnMember("coder");
			});

			it("creates the reviewer worktree", async () => {
				await spawnMember("reviewer");
			});

			it("creates the tester worktree", async () => {
				await spawnMember("tester");
			});

			it("should create distinct worktrees for coder, reviewer, and tester", () => {
				assert.equal(team.listAgents("goal-1").length, roles.length);
				assert.equal(new Set(results.map((result) => result.worktreePath)).size, roles.length);
				const registeredPaths = new Set(listedWorktreePaths(fixture.repoPath));
				for (const result of results) {
					assert.ok(registeredPaths.has(path.resolve(result.worktreePath!)), `${result.worktreePath} should be registered`);
				}
			});
		});

		it("should enforce concurrency limit without real git", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ repoPath: undefined, cwd: "/tmp/no-repo" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");
			(team as any).teams.get("goal-1")!.maxConcurrent = 2;

			const r1 = await team.spawnRole("goal-1", "coder", "Task 1");
			const r2 = await team.spawnRole("goal-1", "tester", "Task 2");
			assert.equal(team.listAgents("goal-1").length, 2);
			await assert.rejects(() => team.spawnRole("goal-1", "reviewer", "Task 3"), {
				message: /already has 2 agents/,
			});

			await team.dismissRole(r1.sessionId);
			await team.dismissRole(r2.sessionId);
		});

		it("should set correct emoji title for each role without real git", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ repoPath: undefined, cwd: "/tmp/no-repo" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");
			const result = await team.spawnRole("goal-1", "reviewer", "Review PR #42");
			const session = sm.getSession(result.sessionId);
			assert.ok(session);
			assert.ok(session.title.startsWith("Reviewer:"), `title should start with "Reviewer:", got: ${session.title}`);
		});

		it("findAgentBySessionId should return the agent record without real git", async () => {
			const goals = new Map<string, MockGoal>();
			const goal = createMockGoal({ repoPath: undefined, cwd: "/tmp/no-repo" });
			goals.set(goal.id, goal);
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("goal-1");
			const result = await team.spawnRole("goal-1", "coder", "Test find agent");
			const agent = team.findAgentBySessionId(result.sessionId);
			assert.ok(agent, "should find agent by session ID");
			assert.equal(agent!.sessionId, result.sessionId);
			assert.equal(agent!.role, "coder");
			assert.equal(agent!.task, "Test find agent");
			assert.equal(team.findAgentBySessionId("nonexistent"), undefined);
		});

		it("team recovery scans configured and historical sessions roots instead of the legacy home default", () => {
			const source = fs.readFileSync(path.join(process.cwd(), "src/server/agent/team-manager.ts"), "utf-8");
			assert.match(source, /trustedAgentSessionsRoots\(\)/, "team recovery must use active, historical, and legacy agent session roots");
			assert.doesNotMatch(source, /homedir\(\).*\.bobbit.*agent.*sessions/s, "team recovery must not hard-code ~/.bobbit/agent/sessions");
		});
	});
});
