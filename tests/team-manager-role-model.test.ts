/**
 * Tests: TeamManager honours the role's `model` / `thinkingLevel` overrides
 * when spawning the team-lead session (via startTeam → _startTeamImpl) and
 * worker sessions (via spawnRole).
 *
 * Bug: previously, both spawn sites built the role prompt but never passed
 * `initialModel` / `initialThinkingLevel` to `SessionManager.createSession`,
 * so role-level model pins were silently ignored. The team-lead path also
 * skipped the inline-roles cascade by calling `roleStore.get()` directly.
 *
 * These tests assert the captured `createSession` opts.
 */

import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate from real ~/.pi state
const TEST_PI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-team-role-model-"));
process.env.BOBBIT_DIR = TEST_PI_DIR;

const { TeamManager } = await import("../src/server/agent/team-manager.ts");

const TEAM_STORE_FILE = path.join(TEST_PI_DIR, "state", "team-state.json");
function clearTeamStore() { try { fs.unlinkSync(TEAM_STORE_FILE); } catch { /* ignore */ } }
clearTeamStore();

// ---------------------------------------------------------------------------
// Mock helpers (parallel pattern to tests/team-manager.test.ts)
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
	inlineRoles?: Record<string, any>;
}

function createMockGoal(overrides: Partial<MockGoal> = {}): MockGoal {
	return {
		id: "goal-1",
		title: "Test Goal",
		cwd: "/tmp/test-project",
		state: "todo",
		spec: "# Test",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		branch: "feat/test",
		// No repoPath → spawnRole skips git worktree work and uses goal.cwd directly.
		...overrides,
	};
}

interface CapturedCall {
	cwd: string;
	args?: string[];
	goalId?: string;
	assistantType?: string;
	opts?: any;
}

function createMockSessionManager(goals: Map<string, MockGoal>) {
	const sessions = new Map<string, any>();
	let nextId = 0;
	const captured: CapturedCall[] = [];

	const sm: any = {
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
			args?: string[],
			goalId?: string,
			assistantType?: string,
			opts?: any,
		) => {
			captured.push({ cwd, args, goalId, assistantType, opts });
			const id = `session-${nextId++}`;
			const session = {
				id,
				title: "New session",
				cwd,
				status: "idle" as const,
				titleGenerated: false,
				goalId,
				spawnPinnedModel: opts?.initialModel,
				spawnPinnedThinkingLevel: opts?.initialThinkingLevel,
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
		terminateSession: mock.fn(async (id: string) => { sessions.delete(id); return true; }),
		_sessions: sessions,
		_captured: captured,
	};
	return sm;
}

function role(name: string, extras: Partial<{ model: string; thinkingLevel: string }> = {}) {
	return {
		name,
		label: name,
		promptTemplate: `You are ${name}. Branch: {{GOAL_BRANCH}}, Agent: {{AGENT_ID}}`,
		toolPolicies: { bash: "allow", read: "allow", write: "allow" },
		accessory: "headphones",
		createdAt: 0,
		updatedAt: 0,
		...extras,
	};
}

function createMockRoleStore(roles: Record<string, any>) {
	const map = new Map<string, any>(Object.entries(roles));
	return {
		get: (n: string) => map.get(n),
		getAll: () => Array.from(map.values()),
		put: (r: any) => map.set(r.name, r),
		remove: (n: string) => map.delete(n),
		reload: () => {},
		update: () => true,
	};
}

function createMockColorStore() {
	const colors = new Map<string, number>();
	return {
		get: (id: string) => colors.get(id),
		set: (id: string, idx: number) => colors.set(id, idx),
		remove: (id: string) => colors.delete(id),
		getAll: () => Object.fromEntries(colors),
	};
}

function createMockTaskManager() {
	const tasks: any[] = [];
	return {
		getTasksByGoal: () => tasks,
		getTasksForSession: () => tasks,
		createTask: (_g: string, t: any) => { tasks.push(t); return t; },
		getTask: (id: string) => tasks.find(t => t.id === id),
		updateTask: () => true,
		deleteTask: () => true,
	};
}

const _createdManagers: InstanceType<typeof TeamManager>[] = [];

function makeManager(sm: any, roleStore: any) {
	clearTeamStore();
	const tm = new TeamManager(sm, {
		gatewayUrl: "https://10.5.0.2:3000",
		authToken: "test-token",
		roleStore,
		colorStore: createMockColorStore(),
		taskManager: createMockTaskManager(),
	});
	_createdManagers.push(tm);
	return tm;
}

after(() => {
	for (const tm of _createdManagers) {
		for (const [, timer] of (tm as any).idleNudgeTimers ?? []) clearTimeout(timer);
		(tm as any).idleNudgeTimers?.clear?.();
		for (const [, timer] of (tm as any).noWorkersNudgeTimers ?? []) clearInterval(timer);
		(tm as any).noWorkersNudgeTimers?.clear?.();
	}
	try { fs.rmSync(TEST_PI_DIR, { recursive: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TeamManager role model override", () => {
	describe("_startTeamImpl (team-lead spawn)", () => {
		it("passes role.model as initialModel to createSession", async () => {
			const goals = new Map<string, MockGoal>([["goal-1", createMockGoal()]]);
			const sm = createMockSessionManager(goals);
			const roleStore = createMockRoleStore({
				"team-lead": role("team-lead", { model: "anthropic/claude-sonnet-4-6" }),
			});
			const team = makeManager(sm, roleStore);

			await team.startTeam("goal-1");

			assert.equal(sm._captured.length, 1, "createSession called once");
			const opts = sm._captured[0].opts;
			assert.equal(opts.initialModel, "anthropic/claude-sonnet-4-6");
			assert.equal(opts.roleName, "team-lead");
			// Captured session also exposes the pinned model (for header / UI parity).
			const session = sm._sessions.get("session-0");
			assert.equal(session.spawnPinnedModel, "anthropic/claude-sonnet-4-6");
		});

		it("passes role.thinkingLevel as initialThinkingLevel to createSession", async () => {
			const goals = new Map<string, MockGoal>([["goal-1", createMockGoal()]]);
			const sm = createMockSessionManager(goals);
			const roleStore = createMockRoleStore({
				"team-lead": role("team-lead", { model: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" }),
			});
			const team = makeManager(sm, roleStore);

			await team.startTeam("goal-1");

			const opts = sm._captured[0].opts;
			assert.equal(opts.initialThinkingLevel, "high");
		});

		it("honours inline-role override (cascade precedence: inline > store)", async () => {
			const inlineRole = role("team-lead", { model: "openai/gpt-5-mini" });
			const goals = new Map<string, MockGoal>([[
				"goal-1",
				createMockGoal({ inlineRoles: { "team-lead": inlineRole } }),
			]]);
			const sm = createMockSessionManager(goals);
			// Store has a DIFFERENT model — inline must win.
			const roleStore = createMockRoleStore({
				"team-lead": role("team-lead", { model: "anthropic/claude-opus-4-7" }),
			});
			const team = makeManager(sm, roleStore);

			await team.startTeam("goal-1");

			const opts = sm._captured[0].opts;
			assert.equal(
				opts.initialModel, "openai/gpt-5-mini",
				"inline role model should win over the project/server store",
			);
		});

		it("falls through to undefined when role.model is absent (system default)", async () => {
			const goals = new Map<string, MockGoal>([["goal-1", createMockGoal()]]);
			const sm = createMockSessionManager(goals);
			const roleStore = createMockRoleStore({
				"team-lead": role("team-lead"), // no model field
			});
			const team = makeManager(sm, roleStore);

			await team.startTeam("goal-1");

			const opts = sm._captured[0].opts;
			assert.equal(opts.initialModel, undefined, "absent model → undefined, not empty string");
			assert.equal(opts.initialThinkingLevel, undefined);
		});

		it("treats empty-string role.model as undefined (no override)", async () => {
			const goals = new Map<string, MockGoal>([["goal-1", createMockGoal()]]);
			const sm = createMockSessionManager(goals);
			const roleStore = createMockRoleStore({
				"team-lead": role("team-lead", { model: "", thinkingLevel: "" }),
			});
			const team = makeManager(sm, roleStore);

			await team.startTeam("goal-1");

			const opts = sm._captured[0].opts;
			assert.equal(opts.initialModel, undefined);
			assert.equal(opts.initialThinkingLevel, undefined);
		});
	});

	describe("spawnRole (worker spawn)", () => {
		it("passes role.model / role.thinkingLevel as initialModel/Level to createSession", async () => {
			// No repoPath → spawnRole uses goal.cwd directly (no git worktree work).
			const goals = new Map<string, MockGoal>([[
				"goal-1",
				createMockGoal({ repoPath: undefined, cwd: "/tmp/no-repo" }),
			]]);
			const sm = createMockSessionManager(goals);
			const roleStore = createMockRoleStore({
				"team-lead": role("team-lead"),
				"coder": role("coder", { model: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" }),
			});
			const team = makeManager(sm, roleStore);

			await team.startTeam("goal-1");
			// Reset captured to isolate the worker-spawn call
			sm._captured.length = 0;

			const result = await team.spawnRole("goal-1", "coder", "do work");

			assert.ok(result.sessionId);
			assert.equal(sm._captured.length, 1, "spawnRole calls createSession once");
			const opts = sm._captured[0].opts;
			assert.equal(opts.roleName, "coder");
			assert.equal(opts.initialModel, "anthropic/claude-sonnet-4-6");
			assert.equal(opts.initialThinkingLevel, "medium");
		});

		it("worker role without model → initialModel is undefined", async () => {
			const goals = new Map<string, MockGoal>([[
				"goal-1",
				createMockGoal({ repoPath: undefined, cwd: "/tmp/no-repo" }),
			]]);
			const sm = createMockSessionManager(goals);
			const roleStore = createMockRoleStore({
				"team-lead": role("team-lead"),
				"coder": role("coder"),
			});
			const team = makeManager(sm, roleStore);

			await team.startTeam("goal-1");
			sm._captured.length = 0;

			await team.spawnRole("goal-1", "coder", "do work");

			const opts = sm._captured[0].opts;
			assert.equal(opts.initialModel, undefined);
			assert.equal(opts.initialThinkingLevel, undefined);
		});

		it("honours inline-role override for workers", async () => {
			const inlineCoder = role("coder", { model: "openai/gpt-5-mini" });
			const goals = new Map<string, MockGoal>([[
				"goal-1",
				createMockGoal({
					repoPath: undefined,
					cwd: "/tmp/no-repo",
					inlineRoles: { "coder": inlineCoder },
				}),
			]]);
			const sm = createMockSessionManager(goals);
			const roleStore = createMockRoleStore({
				"team-lead": role("team-lead"),
				"coder": role("coder", { model: "anthropic/claude-opus-4-7" }),
			});
			const team = makeManager(sm, roleStore);

			await team.startTeam("goal-1");
			sm._captured.length = 0;

			await team.spawnRole("goal-1", "coder", "do work");

			const opts = sm._captured[0].opts;
			assert.equal(opts.initialModel, "openai/gpt-5-mini", "inline-role should win for workers too");
		});
	});
});
