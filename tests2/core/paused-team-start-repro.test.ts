// Focused failing-first regression for an explicit Start team request on a paused goal.
// The paused-goal resume lifecycle is injected so this test pins its durable
// update + broadcast contract as well as TeamManager's start boundary.

import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { TeamManager, type TeamManagerConfig } from "../../src/server/agent/team-manager.ts";

interface MockGoal {
	id: string;
	title: string;
	cwd: string;
	state: "todo" | "in-progress" | "complete" | "shelved" | "blocked";
	spec: string;
	createdAt: number;
	updatedAt: number;
	team: boolean;
	branch: string;
	paused?: boolean;
	mergeConflict?: boolean;
}

function createGoal(): MockGoal {
	return {
		id: "paused-team-goal",
		title: "Paused team goal",
		cwd: "/tmp/paused-team-goal",
		state: "todo",
		spec: "# Resume then start\n\nStart this team after resuming it.",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		branch: "goal/paused-team",
		paused: true,
		mergeConflict: true,
	};
}

function createRoleStore() {
	const teamLead = {
		name: "team-lead",
		label: "Team Lead",
		promptTemplate: "Lead {{GOAL_BRANCH}} as {{AGENT_ID}}",
		toolPolicies: {},
		accessory: "crown",
		createdAt: 0,
		updatedAt: 0,
	};
	return {
		get: (name: string) => name === "team-lead" ? teamLead : undefined,
		getAll: () => [teamLead],
	};
}

function createColorStore() {
	return {
		get: () => undefined,
		set: vi.fn(),
		remove: vi.fn(),
		getAll: () => ({}),
	};
}

const managers: TeamManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
});

describe("TeamManager paused team start", () => {
	it("PAUSED_TEAM_START_AUTO_RESUME resumes through the lifecycle before creating one lead", async () => {
		const goal = createGoal();
		const goals = new Map([[goal.id, goal]]);
		const sessions = new Map<string, any>();
		const events: string[] = [];
		const broadcasts: any[] = [];
		const persistedTeams = new Map<string, any>();
		let nextSession = 0;

		const goalManager = {
			updateGoal: vi.fn(async (id: string, updates: Partial<MockGoal>) => {
				const stored = goals.get(id);
				assert.ok(stored, `goal ${id} must exist before its lifecycle update`);
				Object.assign(stored, updates);
			}),
			listLiveGoals: () => [...goals.values()],
		};
		const resumeGoal = vi.fn(async (id: string) => {
			events.push("resume");
			const stored = goals.get(id);
			assert.ok(stored, "resume lifecycle must receive the paused goal");
			await goalManager.updateGoal(id, {
				paused: false,
				...(stored.mergeConflict ? { mergeConflict: false } : {}),
			});
			broadcasts.push({ type: "goal_state_changed", goalId: id });
			events.push("broadcast");
		});

		const sessionManager = {
			createSession: vi.fn(async (cwd: string, _args: string[], goalId: string) => {
				assert.deepEqual(
					events,
					["resume", "broadcast"],
					"PAUSED_TEAM_START_AUTO_RESUME must durably resume and broadcast before createSession",
				);
				const session = {
					id: `lead-${nextSession++}`,
					title: "New session",
					cwd,
					goalId,
					status: "idle" as const,
					titleGenerated: false,
					rpcClient: { onEvent: vi.fn(() => () => {}) },
					clients: new Set(),
				};
				sessions.set(session.id, session);
				return session;
			}),
			getSession: (id: string) => sessions.get(id),
			setTitle: vi.fn((id: string, title: string) => {
				const session = sessions.get(id);
				if (session) session.title = title;
				return !!session;
			}),
			updateSessionMeta: vi.fn((id: string, updates: Record<string, unknown>) => {
				const session = sessions.get(id);
				if (session) Object.assign(session, updates);
				return !!session;
			}),
			enqueuePrompt: vi.fn(async () => ({ status: "dispatched" })),
			isSandboxEnabled: false,
		};

		const context = {
			goalStore: { get: (id: string) => goals.get(id), getAll: () => [...goals.values()] },
			goalManager,
			teamStore: {
				get: (id: string) => persistedTeams.get(id),
				getAll: () => [...persistedTeams.values()],
				put: (entry: any) => persistedTeams.set(entry.goalId, structuredClone(entry)),
				remove: (id: string) => persistedTeams.delete(id),
			},
			sessionStore: { get: () => undefined, getAll: () => [] },
			taskStore: { getBySessionId: () => [], getByGoalId: () => [] },
			gateStore: { getGatesForGoal: () => [] },
		};
		const config = {
			gatewayUrl: "https://gateway.test",
			authToken: "test-token",
			roleStore: createRoleStore(),
			colorStore: createColorStore(),
			taskManager: { getTasksForSession: () => [] },
			projectContextManager: {
				all: () => [context],
				getContextForGoal: (id: string) => goals.has(id) ? context : undefined,
			},
			// The production implementation must compose this canonical lifecycle
			// inside its existing per-goal start lock, rather than clear paused itself.
			resumeGoal,
		} as TeamManagerConfig & { resumeGoal: typeof resumeGoal };
		const team = new TeamManager(sessionManager as any, config);
		team.stopStuckSweep();
		managers.push(team);

		const lead = await team.startTeam(goal.id);

		assert.equal(resumeGoal.mock.calls.length, 1, "PAUSED_TEAM_START_AUTO_RESUME must resume exactly once");
		assert.equal(goal.paused, false, "PAUSED_TEAM_START_AUTO_RESUME must clear the paused flag");
		assert.equal(goal.mergeConflict, false, "resume must clear stale merge-conflict state");
		assert.deepEqual(broadcasts, [{ type: "goal_state_changed", goalId: goal.id }]);
		assert.equal(sessionManager.createSession.mock.calls.length, 1, "must create exactly one team lead");
		assert.equal(team.getTeamState(goal.id)?.teamLeadSessionId, lead.id);
	});
});
