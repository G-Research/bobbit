/**
 * `TeamManager.notifyTeamLeadOfSpecChange` — server-side throttled nudge
 * for goal-spec-edit-mid-flight (notify-on-spec-edit goal).
 *
 * Pattern mirrors the existing `tests/team-manager.test.ts` mock harness
 * — same MockGoal / MockSessionManager / RoleStore / ColorStore / TaskManager
 * shape — but kept in its own file so the new test won't accidentally
 * leak state into the existing test surface.
 */
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_PI_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-spec-nudge-test-"));
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
	worktreePath?: string;
	branch?: string;
	repoPath?: string;
	team?: boolean;
	teamLeadSessionId?: string;
}

function createMockGoal(overrides: Partial<MockGoal> = {}): MockGoal {
	return {
		id: "goal-1",
		title: "Spec-edit Test Goal",
		cwd: "/tmp/test-project",
		state: "todo",
		spec: "# Original spec",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		branch: "feat/test",
		repoPath: "/tmp/test-repo",
		...overrides,
	};
}

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
				rpcClient: { prompt: mock.fn(async () => {}), onEvent: mock.fn(() => () => {}) },
				clients: new Set(),
			};
			sessions.set(id, session);
			return session;
		},
		getSession: (id: string) => sessions.get(id),
		setTitle: (id: string, title: string) => { const s = sessions.get(id); if (s) s.title = title; return !!s; },
		updateSessionMeta: (id: string, updates: any) => { const s = sessions.get(id); if (s) Object.assign(s, updates); return !!s; },
		terminateSession: mock.fn(async (id: string) => { sessions.delete(id); return true; }),
		_sessions: sessions,
	};
}

function createMockRoleStore() {
	const roles = new Map<string, any>([
		["team-lead", { name: "team-lead", label: "Team Lead", promptTemplate: "tl", toolPolicies: { bash: "allow" }, accessory: "crown", createdAt: 0, updatedAt: 0 }],
		["coder", { name: "coder", label: "Coder", promptTemplate: "c", toolPolicies: { bash: "allow" }, accessory: "headphones", createdAt: 0, updatedAt: 0 }],
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

const _createdManagers: any[] = [];

function createTeamManager(sm: any): any {
	clearTeamStore();
	const tm = new TeamManager(sm, {
		gatewayUrl: "https://10.5.0.2:3000",
		authToken: "test-token-123",
		roleStore: createMockRoleStore(),
		colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
		taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [], createTask: (_g: string, t: any) => t, getTask: () => undefined, updateTask: () => true, deleteTask: () => true },
	});
	_createdManagers.push(tm);
	return tm;
}

before(() => {
	clearTeamStore();
});

after(() => {
	for (const tm of _createdManagers) {
		for (const [, timer] of tm.idleNudgeTimers ?? []) clearTimeout(timer);
		tm.idleNudgeTimers?.clear?.();
		for (const [, timer] of tm.noWorkersNudgeTimers ?? []) clearInterval(timer);
		tm.noWorkersNudgeTimers?.clear?.();
	}
	try { fs.rmSync(TEST_PI_DIR, { recursive: true }); } catch { /* ignore */ }
});

describe("notifyTeamLeadOfSpecChange", () => {
	it("enqueues a high-priority nudge for an idle team lead", async () => {
		const goals = new Map<string, MockGoal>();
		goals.set("goal-1", createMockGoal());
		const sm = createMockSessionManager(goals);
		const enqueuePrompt = mock.fn((_id: string, _msg: string, _opts?: any) => {});
		sm.enqueuePrompt = enqueuePrompt;
		sm.deliverLiveSteer = mock.fn(async () => {});

		const team = createTeamManager(sm);
		await team.startTeam("goal-1");

		// Team lead is idle by default — enqueuePrompt path
		team.notifyTeamLeadOfSpecChange("goal-1", 100, 250);

		assert.equal(enqueuePrompt.mock.callCount(), 1, "exactly one nudge enqueued");
		const call = enqueuePrompt.mock.calls[0];
		const message = call.arguments[1] as string;
		const opts = call.arguments[2] as { isSteered?: boolean };
		assert.ok(/spec has been edited/i.test(message), `message mentions spec edit: ${message.slice(0, 200)}`);
		assert.ok(message.includes("100"), "message includes prev length");
		assert.ok(message.includes("250"), "message includes new length");
		assert.ok(/view_goal_spec/.test(message), "message references view_goal_spec tool");
		assert.equal(opts?.isSteered, true, "nudge marked as steered (high priority)");
	});

	it("delivers as a live steer when team lead is streaming", async () => {
		const goals = new Map<string, MockGoal>();
		goals.set("goal-1", createMockGoal());
		const sm = createMockSessionManager(goals);
		const enqueuePrompt = mock.fn((_id: string, _msg: string, _opts?: any) => {});
		const deliverLiveSteer = mock.fn(async (_id: string, _msg: string) => {});
		sm.enqueuePrompt = enqueuePrompt;
		sm.deliverLiveSteer = deliverLiveSteer;

		const team = createTeamManager(sm);
		await team.startTeam("goal-1");

		const entry = team.teams.get("goal-1");
		const tl = sm._sessions.get(entry.teamLeadSessionId)!;
		tl.status = "streaming";

		team.notifyTeamLeadOfSpecChange("goal-1", 50, 80);

		assert.equal(deliverLiveSteer.mock.callCount(), 1, "live steer called");
		assert.equal(enqueuePrompt.mock.callCount(), 0, "queue path NOT used while streaming");
	});

	it("throttles repeated nudges within 30s window", async () => {
		const goals = new Map<string, MockGoal>();
		goals.set("goal-1", createMockGoal());
		const sm = createMockSessionManager(goals);
		const enqueuePrompt = mock.fn((_id: string, _msg: string, _opts?: any) => {});
		sm.enqueuePrompt = enqueuePrompt;
		sm.deliverLiveSteer = mock.fn(async () => {});

		const team = createTeamManager(sm);
		await team.startTeam("goal-1");

		team.notifyTeamLeadOfSpecChange("goal-1", 100, 200);
		team.notifyTeamLeadOfSpecChange("goal-1", 200, 300);
		team.notifyTeamLeadOfSpecChange("goal-1", 300, 400);

		assert.equal(
			enqueuePrompt.mock.callCount(),
			1,
			"only the first nudge fires; subsequent calls are throttled",
		);
	});

	it("re-enables nudges after the throttle window elapses", async () => {
		const goals = new Map<string, MockGoal>();
		goals.set("goal-1", createMockGoal());
		const sm = createMockSessionManager(goals);
		const enqueuePrompt = mock.fn((_id: string, _msg: string, _opts?: any) => {});
		sm.enqueuePrompt = enqueuePrompt;
		sm.deliverLiveSteer = mock.fn(async () => {});

		const team = createTeamManager(sm);
		await team.startTeam("goal-1");

		team.notifyTeamLeadOfSpecChange("goal-1", 100, 200);
		assert.equal(enqueuePrompt.mock.callCount(), 1);

		// Reach into the private throttle map and rewind the timestamp by
		// (throttle window + 1s) so a second nudge is allowed without
		// having to advance real time. We avoid `mock.timers` here
		// because Node's Date mock doesn't compose with raw Date.now()
		// reads inside synchronous code under tick().
		const throttle = (team.constructor as any).SPEC_NUDGE_THROTTLE_MS as number;
		const rewound = Date.now() - throttle - 1_000;
		team.lastSpecNudgeTs.set("goal-1", rewound);

		team.notifyTeamLeadOfSpecChange("goal-1", 200, 300);
		assert.equal(enqueuePrompt.mock.callCount(), 2, "second nudge fires after throttle expires");
	});

	it("is a no-op when no team lead session exists", () => {
		const goals = new Map<string, MockGoal>();
		goals.set("goal-1", createMockGoal());
		const sm = createMockSessionManager(goals);
		const enqueuePrompt = mock.fn((_id: string, _msg: string, _opts?: any) => {});
		sm.enqueuePrompt = enqueuePrompt;
		sm.deliverLiveSteer = mock.fn(async () => {});

		// Don't start a team — no team-lead registered for goal-1
		const team = createTeamManager(sm);
		team.notifyTeamLeadOfSpecChange("goal-1", 100, 200);

		assert.equal(enqueuePrompt.mock.callCount(), 0);
	});

	it("is a no-op when team lead session is terminated", async () => {
		const goals = new Map<string, MockGoal>();
		goals.set("goal-1", createMockGoal());
		const sm = createMockSessionManager(goals);
		const enqueuePrompt = mock.fn((_id: string, _msg: string, _opts?: any) => {});
		sm.enqueuePrompt = enqueuePrompt;
		sm.deliverLiveSteer = mock.fn(async () => {});

		const team = createTeamManager(sm);
		await team.startTeam("goal-1");

		const entry = team.teams.get("goal-1");
		const tl = sm._sessions.get(entry.teamLeadSessionId)!;
		tl.status = "terminated";

		team.notifyTeamLeadOfSpecChange("goal-1", 100, 200);

		assert.equal(enqueuePrompt.mock.callCount(), 0);
	});
});
