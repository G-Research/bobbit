/**
 * CQ-02 regression test — TeamManager's two in-process spawn call sites
 * (`_startTeamImpl` and `spawnRole`) used to check only the DIRECT goal's
 * `paused` flag, never walking the ancestor chain the way the REST route
 * (`POST /api/goals` with `parentGoalId`, via `requireAncestorsNotPaused` in
 * server.ts) already did.
 *
 * Concretely reachable bypass this pins: pause a parent goal with
 * `cascade:true` (pausing it and its child), then resume the child alone
 * with `cascade:false` (clears only the child's own `paused` flag — the
 * parent stays paused). Before the fix, `team_spawn` from the child's
 * team-lead (`TeamManager.spawnRole`) — or a fresh `startTeam` on the
 * child — would silently succeed because both call sites inlined
 * `if (goal.paused) throw new GoalPausedError(goalId)` against the child
 * only. After the fix, both call sites use `requireAncestorsNotPaused`
 * (src/server/agent/goal-paused-guard.ts) and correctly refuse the spawn,
 * reporting the paused ANCESTOR's id — mirroring
 * tests/goal-paused-ancestor-guard.test.ts's coverage of the guard helper
 * itself, but exercised through the real TeamManager call sites.
 */
import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_PI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-team-pause-ancestor-test-"));
process.env.BOBBIT_DIR = TEST_PI_DIR;

// Import AFTER setting env var so bobbitDir() picks it up.
const { TeamManager } = await import("../src/server/agent/team-manager.ts");
const { GoalPausedError } = await import("../src/server/agent/goal-paused-guard.ts");

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
	paused?: boolean;
	parentGoalId?: string;
}

function makeGoal(overrides: Partial<MockGoal> & { id: string }): MockGoal {
	return {
		title: "Test Goal",
		cwd: "/tmp/cq-02-test-project",
		state: "todo",
		spec: "# Test Goal\nDo something",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		branch: `feat/${overrides.id}`,
		repoPath: "/tmp/cq-02-test-repo",
		...overrides,
	};
}

/** Mock RoleStore providing just the roles these tests spawn. */
function createMockRoleStore() {
	const roles = new Map<string, any>([
		["team-lead", { name: "team-lead", label: "Team Lead", promptTemplate: "Lead. Branch: {{GOAL_BRANCH}}, Agent: {{AGENT_ID}}", toolPolicies: { bash: "allow", read: "allow", write: "allow" }, accessory: "crown", createdAt: 0, updatedAt: 0 }],
		["coder", { name: "coder", label: "Coder", promptTemplate: "Coder. Branch: {{GOAL_BRANCH}}, Agent: {{AGENT_ID}}", toolPolicies: { bash: "allow", read: "allow", write: "allow", edit: "allow" }, accessory: "headphones", createdAt: 0, updatedAt: 0 }],
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
		get: (sessionId: string) => colors.get(sessionId),
		set: (sessionId: string, idx: number) => colors.set(sessionId, idx),
		remove: (sessionId: string) => colors.delete(sessionId),
		getAll: () => Object.fromEntries(colors),
	};
}

function createMockTaskManager() {
	const tasks: any[] = [];
	return {
		getTasksByGoal: (_goalId: string) => tasks,
		getTasksForGoal: (_goalId: string) => tasks,
		getTasksForSession: (id: string) => tasks.filter((t: any) => t.assignedSessionId === id),
		createTask: (_goalId: string, task: any) => { tasks.push(task); return task; },
		getTask: (id: string) => tasks.find((t: any) => t.id === id),
		updateTask: () => true,
		deleteTask: () => true,
	};
}

/** Non-PCM test path: sessionManager exposes goalManager.getGoal directly,
 *  which is exactly the lookup TeamManager.resolveGoal()/requireAncestorsNotPaused
 *  walk uses — a single shared `goals` map lets us wire up parent/child chains. */
function createMockSessionManager(goals: Map<string, MockGoal>): any {
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
		createSession: async (cwd: string, _args?: string[], goalId?: string) => {
			const id = `session-${nextSessionId++}`;
			const session = {
				id,
				title: "New session",
				cwd,
				status: "idle" as const,
				titleGenerated: false,
				goalId,
				rpcClient: { prompt: mock.fn(async () => {}), onEvent: mock.fn(() => {}) },
				clients: new Set(),
			};
			sessions.set(id, session);
			return session;
		},
		getSession: (id: string) => sessions.get(id),
		setTitle: (id: string, title: string) => { const s = sessions.get(id); if (s) s.title = title; return !!s; },
		updateSessionMeta: (id: string, updates: any) => { const s = sessions.get(id); if (s) Object.assign(s, updates); return !!s; },
		terminateSession: mock.fn(async (id: string) => { sessions.delete(id); return true; }),
		isSandboxEnabled: false,
		getSandboxManager: () => undefined,
		dispatchGoalProvisionedForWorktree: mock.fn(async () => {}),
	};
}

const DEFAULT_CONFIG = {
	gatewayUrl: "https://10.5.0.2:3000",
	authToken: "test-token-123",
	roleStore: createMockRoleStore(),
	colorStore: createMockColorStore(),
	taskManager: createMockTaskManager(),
};

const createdManagers: InstanceType<typeof TeamManager>[] = [];

function createTeamManager(sm: any): InstanceType<typeof TeamManager> {
	clearTeamStore();
	const tm = new TeamManager(sm, DEFAULT_CONFIG);
	createdManagers.push(tm);
	return tm;
}

after(() => {
	for (const tm of createdManagers) {
		tm.dispose?.();
		for (const [, timer] of (tm as any).idleNudgeTimers ?? []) clearTimeout(timer);
		(tm as any).idleNudgeTimers?.clear?.();
		for (const [, timer] of (tm as any).noWorkersNudgeTimers ?? []) clearTimeout(timer);
		(tm as any).noWorkersNudgeTimers?.clear?.();
		for (const [, timer] of (tm as any).pendingIdleNotify ?? []) clearTimeout(timer);
		(tm as any).pendingIdleNotify?.clear?.();
	}
	try { fs.rmSync(TEST_PI_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function assertGoalPaused(err: unknown, expectedGoalId: string): true {
	assert.ok(err instanceof GoalPausedError, `expected GoalPausedError, got ${err}`);
	assert.equal((err as InstanceType<typeof GoalPausedError>).code, "GOAL_PAUSED");
	assert.equal((err as InstanceType<typeof GoalPausedError>).status, 409);
	assert.equal(
		(err as InstanceType<typeof GoalPausedError>).goalId,
		expectedGoalId,
		"reports the paused ancestor's id, not the goal the caller acted on",
	);
	return true;
}

describe("TeamManager pause-ancestor guard (CQ-02)", () => {
	describe("_startTeamImpl (startTeam)", () => {
		it("throws GoalPausedError naming the paused PARENT when the child itself is not paused", async () => {
			const goals = new Map<string, MockGoal>();
			goals.set("parent-1", makeGoal({ id: "parent-1", team: false, paused: true }));
			goals.set("child-1", makeGoal({ id: "child-1", parentGoalId: "parent-1", paused: false }));
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await assert.rejects(() => team.startTeam("child-1"), (err: unknown) => assertGoalPaused(err, "parent-1"));
		});

		it("spawns normally when neither the goal nor any ancestor is paused", async () => {
			const goals = new Map<string, MockGoal>();
			goals.set("parent-2", makeGoal({ id: "parent-2", team: false, paused: false }));
			goals.set("child-2", makeGoal({ id: "child-2", parentGoalId: "parent-2", paused: false }));
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			const session = await team.startTeam("child-2");
			assert.ok(session.id, "team-lead session should be created");
		});
	});

	describe("spawnRole (team_spawn)", () => {
		it("throws GoalPausedError when a targeted cascade:false resume left an ancestor paused", async () => {
			// Reproduces the exact bypass: parent+child both start unpaused so the
			// child's team can start; the parent is then paused on its own
			// (simulating cascade:true pause + cascade:false resume of the child
			// only — the child's `paused` flag never flips back to true). Before
			// the fix, spawnRole only checked the child's own (false) flag and
			// spawned anyway.
			const goals = new Map<string, MockGoal>();
			goals.set("parent-3", makeGoal({ id: "parent-3", team: false, paused: false }));
			goals.set("child-3", makeGoal({ id: "child-3", parentGoalId: "parent-3", paused: false }));
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("child-3");
			assert.equal(goals.get("child-3")!.paused, false, "child itself is not paused");

			// Operator pauses the parent only (targeted, or cascade already
			// resolved back to this state via a cascade:false child resume).
			goals.get("parent-3")!.paused = true;

			await assert.rejects(
				() => team.spawnRole("child-3", "coder", "do the work"),
				(err: unknown) => assertGoalPaused(err, "parent-3"),
			);
		});

		it("spawns normally when neither the goal nor any ancestor is paused", async () => {
			const goals = new Map<string, MockGoal>();
			goals.set("parent-4", makeGoal({ id: "parent-4", team: false, paused: false }));
			// repoPath: undefined skips real worktree creation (no git repo on
			// disk here) — mirrors team-manager.test.ts's "should skip worktree
			// and use goal.cwd when repoPath is undefined".
			goals.set("child-4", makeGoal({ id: "child-4", parentGoalId: "parent-4", paused: false, repoPath: undefined, cwd: "/tmp/cq-02-no-repo" }));
			const sm = createMockSessionManager(goals);
			const team = createTeamManager(sm);

			await team.startTeam("child-4");
			const result = await team.spawnRole("child-4", "coder", "do the work");
			assert.ok(result.sessionId, "should return a sessionId");
		});
	});
});
