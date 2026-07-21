import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { TeamManager, type TeamManagerConfig } from "../../src/server/agent/team-manager.ts";
import { createManualClock } from "../harness/clock.ts";

interface MockGoal {
	id: string;
	title: string;
	cwd: string;
	state: string;
	spec: string;
	createdAt: number;
	updatedAt: number;
	team: boolean;
	branch?: string;
	repoPath?: string;
	projectId?: string;
	sandboxed?: boolean;
	paused?: boolean;
	teamLeadSessionId?: string;
}

function makeGoal(overrides: Partial<MockGoal> = {}): MockGoal {
	return {
		id: "goal-1",
		title: "Decision test goal",
		cwd: path.join(os.tmpdir(), "bobbit-team-decisions-project"),
		state: "todo",
		spec: "Exercise orchestration decisions",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		branch: "feat/decision-test",
		projectId: "project-1",
		sandboxed: true,
		...overrides,
	};
}

function makeSessionManager(goals: Map<string, MockGoal>) {
	const sessions = new Map<string, any>();
	const resolvedAuthors = new Map<string, { kind: "agent"; id: string; label: string }>();
	let sequence = 0;
	const sandboxExec = vi.fn(async () => "0123456789abcdef0123456789abcdef01234567\n");
	return {
		goalManager: {
			getGoal: (id: string) => goals.get(id),
			updateGoal: (id: string, patch: Partial<MockGoal>) => {
				const goal = goals.get(id);
				if (!goal) return false;
				Object.assign(goal, patch);
				return true;
			},
		},
		createSession: vi.fn(async (cwd: string, _args?: string[], goalId?: string, _assistant?: boolean, opts?: any) => {
			const session = {
				id: `session-${sequence++}`,
				title: "New session",
				cwd,
				goalId,
				status: "idle",
				titleGenerated: false,
				createOpts: opts,
				rpcClient: {
					prompt: vi.fn(async () => undefined),
					onEvent: vi.fn(() => () => undefined),
				},
				clients: new Set(),
			};
			sessions.set(session.id, session);
			return session;
		}),
		getSession: (id: string) => sessions.get(id),
		resolveSessionAgentAuthor: (id: string) => {
			const resolved = resolvedAuthors.get(id);
			if (resolved) return resolved;
			const session = sessions.get(id);
			return session ? { kind: "agent" as const, id: `session:${id}`, label: session.title } : undefined;
		},
		enqueuePrompt: vi.fn(async (id: string, text: string, opts?: any) => {
			const session = sessions.get(id);
			if (session) session.lastPromptSource = opts?.source ?? "user";
			await session?.rpcClient.prompt(text);
			return { status: "dispatched" as const };
		}),
		getPersistedSession: (_id: string) => undefined,
		setTitle: (id: string, title: string) => {
			const session = sessions.get(id);
			if (!session) return false;
			session.title = title;
			return true;
		},
		updateSessionMeta: (id: string, patch: Record<string, unknown>) => {
			const session = sessions.get(id);
			if (!session) return false;
			Object.assign(session, patch);
			return true;
		},
		terminateSession: vi.fn(async (id: string) => sessions.delete(id)),
		markChildTerminal: vi.fn(),
		dispatchGoalProvisionedForWorktree: vi.fn(async () => undefined),
		isSandboxEnabled: true,
		getSandboxManager: () => ({ get: () => ({ exec: sandboxExec }) }),
		_sessions: sessions,
		_resolvedAuthors: resolvedAuthors,
		_sandboxExec: sandboxExec,
	};
}

function makeConfig(goals: Map<string, MockGoal>): TeamManagerConfig {
	const roles = new Map<string, any>([
		["team-lead", { name: "team-lead", label: "Team Lead", promptTemplate: "Lead {{GOAL_BRANCH}} as {{AGENT_ID}}", toolPolicies: {}, accessory: "crown" }],
		["coder", { name: "coder", label: "Coder", promptTemplate: "Code {{GOAL_BRANCH}} as {{AGENT_ID}}", toolPolicies: { read: "allow", edit: "allow" }, accessory: "headphones" }],
		["reviewer", { name: "reviewer", label: "Reviewer", promptTemplate: "Review {{GOAL_BRANCH}} as {{AGENT_ID}}", toolPolicies: { read: "allow" }, accessory: "monocle" }],
	]);
	const persistedTeams = new Map<string, any>();
	const context = {
		goalStore: {
			get: (id: string) => goals.get(id),
			getAll: () => [...goals.values()],
		},
		goalManager: {
			updateGoal: async (id: string, patch: Partial<MockGoal>) => {
				const goal = goals.get(id);
				if (!goal) return false;
				Object.assign(goal, patch);
				return true;
			},
			listLiveGoals: () => [...goals.values()],
		},
		teamStore: {
			getAll: () => [...persistedTeams.values()],
			put: (entry: any) => persistedTeams.set(entry.goalId, structuredClone(entry)),
			remove: (id: string) => persistedTeams.delete(id),
		},
		sessionStore: { getAll: () => [], update: vi.fn() },
		taskStore: {},
		gateStore: {},
	};
	return {
		projectContextManager: {
			all: () => [context],
			getContextForGoal: (id: string) => goals.has(id) ? context : undefined,
		} as any,
		roleStore: {
			get: (name: string) => roles.get(name),
			getAll: () => [...roles.values()],
		} as any,
		colorStore: {
			get: () => undefined,
			set: () => undefined,
			remove: () => undefined,
			getAll: () => ({}),
		} as any,
		taskManager: {
			getTasksByGoal: () => [],
			getTasksForSession: () => [],
		} as any,
		commandRunner: {
			execFile: vi.fn(async () => ({ stdout: "", stderr: "" })),
			execFileSync: vi.fn(() => ""),
		} as any,
	};
}

const managers: TeamManager[] = [];

function makeTeam(goals: Map<string, MockGoal>) {
	const sessions = makeSessionManager(goals);
	const manager = new TeamManager(sessions as any, makeConfig(goals), undefined, createManualClock());
	managers.push(manager);
	return { manager, sessions };
}

function addGoal(overrides: Partial<MockGoal> = {}) {
	const goal = makeGoal(overrides);
	return { goal, goals: new Map([[goal.id, goal]]) };
}

afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
});

describe("TeamManager seam decisions", () => {
	it("spawns a role without a host worktree and preserves role policy in session metadata", async () => {
		const { goals } = addGoal();
		const { manager, sessions } = makeTeam(goals);
		const lead = await manager.startTeam("goal-1");

		const result = await manager.spawnRole("goal-1", "coder", "Implement the decision path");
		const session = sessions.getSession(result.sessionId)!;
		const agent = manager.findAgentBySessionId(result.sessionId)!;

		assert.equal(result.worktreePath, undefined);
		assert.equal(session.cwd, goals.get("goal-1")!.cwd);
		assert.equal(session.createOpts.roleName, "coder");
		assert.equal(session.createOpts.sandboxed, true);
		assert.match(session.createOpts.rolePrompt, /^Code feat\/decision-test as coder-[0-9a-f]{4}$/);
		assert.equal(session.role, "coder");
		assert.equal(session.teamGoalId, "goal-1");
		assert.equal(session.teamLeadSessionId, "session-0");
		assert.equal(agent.task, "Implement the decision path");
		assert.equal(agent.baseSha, "0123456789abcdef0123456789abcdef01234567");
		assert.equal(sessions._sandboxExec.mock.calls.length, 1, "base SHA should use the injected sandbox seam");
		assert.deepEqual(
			sessions.enqueuePrompt.mock.calls,
			[
				[
					lead.id,
					"# Goal Spec\n\nExercise orchestration decisions\n\n---\n\nExecute the task described in your system prompt. Follow the instructions carefully.",
					{ source: "system", suppressTitleGen: true },
				],
				[
					result.sessionId,
					"Implement the decision path",
					{
						source: "agent",
						author: { kind: "agent", id: `session:${lead.id}`, label: lead.title },
					},
				],
			],
			"kickoff and worker task prompts must retain their system and accountable-agent provenance",
		);
	});

	it("uses the shared current-author resolver for a renamed-staff team lead's worker task", async () => {
		const { goals } = addGoal();
		const { manager, sessions } = makeTeam(goals);
		const lead = await manager.startTeam("goal-1");
		lead.staffId = "staff-1";
		lead.title = "Old staff name";
		const currentAuthor = { kind: "agent", id: "staff:staff-1", label: "Renamed staff" } as const;
		sessions._resolvedAuthors.set(lead.id, currentAuthor);
		sessions.enqueuePrompt.mockClear();

		const worker = await manager.spawnRole("goal-1", "coder", "worker task bytes");

		assert.deepEqual(sessions.enqueuePrompt.mock.calls, [[
			worker.sessionId,
			"worker task bytes",
			{ source: "agent", author: currentAuthor },
		]]);
		assert.equal(lead.title, "Old staff name", "producer resolution must not depend on the stale live-session title");
	});

	it("rejects unknown and team-lead roles before creating a worker session", async () => {
		const { goals } = addGoal();
		const { manager, sessions } = makeTeam(goals);
		await manager.startTeam("goal-1");

		await assert.rejects(() => manager.spawnRole("goal-1", "missing", "task"), /Role "missing" not found/);
		await assert.rejects(() => manager.spawnRole("goal-1", "team-lead", "task"), /Cannot spawn team-lead/);
		assert.equal(sessions.createSession.mock.calls.length, 1, "only the team lead should have been created");
	});

	it("requires an active team before spawning", async () => {
		const { goals } = addGoal();
		const { manager } = makeTeam(goals);
		await assert.rejects(() => manager.spawnRole("goal-1", "coder", "task"), /No active team/);
	});

	it("enforces pause and concurrency policy without creating worktrees", async () => {
		const pausedFixture = addGoal();
		const paused = makeTeam(pausedFixture.goals);
		await paused.manager.startTeam("goal-1");
		pausedFixture.goal.paused = true;
		await assert.rejects(() => paused.manager.spawnRole("goal-1", "coder", "task"), /paused/i);

		const limitedFixture = addGoal();
		const limited = makeTeam(limitedFixture.goals);
		await limited.manager.startTeam("goal-1");
		(limited.manager as any).teams.get("goal-1").maxConcurrent = 0;
		await assert.rejects(() => limited.manager.spawnRole("goal-1", "coder", "task"), /already has 0 agents/);
	});

	it("returns structured authorization outcomes for cross-goal, lead, and unrelated dismissals", async () => {
		const { goals } = addGoal();
		const { manager, sessions } = makeTeam(goals);
		const lead = await manager.startTeam("goal-1");
		const worker = await manager.spawnRole("goal-1", "coder", "task");
		sessions._sessions.set("unrelated", { id: "unrelated", status: "idle", teamGoalId: "goal-2" });

		assert.deepEqual(
			await manager.dismissRoleForGoal("goal-2", worker.sessionId),
			{ ok: false, status: "not-owned", sessionId: worker.sessionId, message: `Team agent ${worker.sessionId} belongs to a different goal.`, retryable: false },
		);
		assert.equal((await manager.dismissRoleForGoal("goal-1", lead.id)).status, "not-owned");
		assert.equal((await manager.dismissRoleForGoal("goal-1", "unrelated")).status, "not-owned");
		assert.equal((await manager.dismissRoleForGoal("goal-1", "missing")).status, "not-found");
	});

	it("dismisses only the owned worker and classifies a duplicate as already dismissed", async () => {
		const { goals } = addGoal();
		const { manager, sessions } = makeTeam(goals);
		const lead = await manager.startTeam("goal-1");
		const first = await manager.spawnRole("goal-1", "coder", "first");
		const second = await manager.spawnRole("goal-1", "reviewer", "second");
		sessions.getSession(lead.id)!.status = "streaming";

		assert.equal((await manager.dismissRoleForGoal("goal-1", first.sessionId)).status, "dismissed");
		assert.equal((await manager.dismissRoleForGoal("goal-1", first.sessionId)).status, "already-dismissed");
		assert.deepEqual(manager.listAgents("goal-1").map((agent) => agent.sessionId), [second.sessionId]);
		assert.equal(sessions.getSession(first.sessionId), undefined);
		assert.ok(sessions.getSession(second.sessionId));
		assert.deepEqual(sessions.terminateSession.mock.calls, [[first.sessionId]]);
	});
});
