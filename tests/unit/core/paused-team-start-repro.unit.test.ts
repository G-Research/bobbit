// Focused regression coverage for an explicit Start team request on a paused goal.
// The injected lifecycle pins TeamManager's lock/composition boundary without
// coupling this focused core test to the HTTP server.

import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { TeamManager, TeamStartError, type TeamManagerConfig } from "../../../src/server/agent/team-manager.ts";
import { GoalPausedError } from "../../../src/server/agent/goal-paused-guard.ts";

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
	archived?: boolean;
	setupStatus?: "ready" | "preparing" | "error";
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

function createFixture(goal = createGoal(), resumeImpl?: () => Promise<void>) {
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
	const resumeGoal = vi.fn(async () => {
		events.push("resume");
		if (resumeImpl) return resumeImpl();
		const stored = goals.get(goal.id);
		assert.ok(stored, "resume lifecycle must receive the paused goal");
		await goalManager.updateGoal(goal.id, {
			paused: false,
			...(stored.mergeConflict ? { mergeConflict: false } : {}),
		});
		broadcasts.push({ type: "goal_state_changed", goalId: goal.id });
		events.push("broadcast");
	});
	const sessionManager = {
		createSession: vi.fn(async (cwd: string, _args: string[], goalId: string) => {
			events.push("create");
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
	const config: TeamManagerConfig = {
		roleStore: createRoleStore() as any,
		colorStore: createColorStore() as any,
		taskManager: { getTasksForSession: () => [] } as any,
		projectContextManager: {
			all: () => [context],
			getContextForGoal: (id: string) => goals.has(id) ? context : undefined,
		} as any,
		resumeGoal,
	};
	const team = new TeamManager(sessionManager as any, config);
	team.stopStuckSweep();
	managers.push(team);
	return { goal, team, resumeGoal, sessionManager, sessions, events, broadcasts };
}

const explicitPausedStart = { explicitIdempotent: true, resumePaused: true } as const;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("TeamManager paused team start", () => {
	it("PAUSED_TEAM_START_AUTO_RESUME resumes once through the lifecycle before creating one lead", async () => {
		const fixture = createFixture();
		const [lead, sameLead] = await Promise.all([
			fixture.team.startTeam(fixture.goal.id, explicitPausedStart),
			fixture.team.startTeam(fixture.goal.id, explicitPausedStart),
		]);

		assert.equal(lead.id, sameLead.id, "concurrent start requests must share the in-flight team result");
		assert.equal(fixture.resumeGoal.mock.calls.length, 1, "PAUSED_TEAM_START_AUTO_RESUME must resume exactly once");
		assert.equal(fixture.goal.paused, false, "PAUSED_TEAM_START_AUTO_RESUME must clear the paused flag");
		assert.equal(fixture.goal.mergeConflict, false, "resume must clear stale merge-conflict state");
		assert.deepEqual(
			fixture.events,
			["resume", "broadcast", "create"],
			"PAUSED_TEAM_START_AUTO_RESUME must durably resume and broadcast before createSession",
		);
		assert.deepEqual(fixture.broadcasts, [{ type: "goal_state_changed", goalId: fixture.goal.id }]);
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 1, "resume must finish before one lead is created");
		assert.equal(fixture.team.getTeamState(fixture.goal.id)?.teamLeadSessionId, lead.id);

		const repeatedLead = await fixture.team.startTeam(fixture.goal.id, explicitPausedStart);
		assert.equal(repeatedLead.id, lead.id, "an explicit repeated start must return the established live lead");
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 1, "a repeated start must not create a duplicate lead");
	});

	it("retries an authorized explicit request after a scheduler-first pause rejection", async () => {
		const fixture = createFixture();
		const schedulerStart = fixture.team.startTeam(fixture.goal.id);
		const explicitStart = fixture.team.startTeam(fixture.goal.id, explicitPausedStart);

		const [scheduler, explicit] = await Promise.allSettled([schedulerStart, explicitStart]);
		assert.equal(scheduler.status, "rejected");
		assert.ok(scheduler.reason instanceof GoalPausedError, "scheduler keeps its own pause rejection");
		assert.equal(explicit.status, "fulfilled", "authorized explicit start retries with its own resume authority");
		assert.equal(fixture.resumeGoal.mock.calls.length, 1);
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 1);
	});

	it("shares an authorized explicit start with a scheduler request after it succeeds", async () => {
		const resume = deferred();
		const goal = createGoal();
		const fixture = createFixture(goal, async () => {
			await resume.promise;
			goal.paused = false;
			goal.mergeConflict = false;
		});
		const mutableExplicitStart = { explicitIdempotent: true, resumePaused: true };
		const explicitStart = fixture.team.startTeam(goal.id, mutableExplicitStart);
		// The in-flight operation must not observe caller mutation after it starts.
		mutableExplicitStart.resumePaused = false;
		const schedulerStart = fixture.team.startTeam(goal.id);
		resume.resolve();

		const [explicit, scheduler] = await Promise.all([explicitStart, schedulerStart]);
		assert.equal(explicit.id, scheduler.id, "a successful authorized start must share its established lead");
		assert.equal(fixture.resumeGoal.mock.calls.length, 1);
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 1);
	});

	it("does not return a missing established lead on an explicit retry", async () => {
		const fixture = createFixture();
		const lead = await fixture.team.startTeam(fixture.goal.id, explicitPausedStart);
		fixture.sessions.delete(lead.id);

		await assert.rejects(
			() => fixture.team.startTeam(fixture.goal.id, explicitPausedStart),
			(err: unknown) => err instanceof TeamStartError && err.code === "TEAM_LEAD_UNAVAILABLE",
		);
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 1, "a missing lead must not create a second session");
	});

	it("does not return a terminated established lead after resuming", async () => {
		const fixture = createFixture();
		const lead = await fixture.team.startTeam(fixture.goal.id, explicitPausedStart);
		fixture.goal.paused = true;
		fixture.sessions.get(lead.id).status = "terminated";

		await assert.rejects(
			() => fixture.team.startTeam(fixture.goal.id, explicitPausedStart),
			(err: unknown) => err instanceof TeamStartError && err.code === "TEAM_LEAD_UNAVAILABLE",
		);
		assert.equal(fixture.resumeGoal.mock.calls.length, 2, "the paused goal must resume before checking its existing lead");
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 1, "a terminated lead must not create a second session");
	});

	it("starts an active goal normally without invoking the resume lifecycle", async () => {
		const goal = createGoal();
		goal.paused = false;
		const fixture = createFixture(goal);

		await fixture.team.startTeam(goal.id, explicitPausedStart);

		assert.equal(fixture.resumeGoal.mock.calls.length, 0);
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 1);
	});

	it("preserves ordinary non-paused completed-goal starts", async () => {
		const goal = createGoal();
		goal.paused = false;
		goal.state = "complete";
		const fixture = createFixture(goal);

		await fixture.team.startTeam(goal.id, explicitPausedStart);

		assert.equal(fixture.resumeGoal.mock.calls.length, 0, "ordinary starts must not enter the resume lifecycle");
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 1, "a completed goal may restart its team after teardown");
	});

	it("revalidates paused-only eligibility after resume before creating a lead", async () => {
		const goal = createGoal();
		const fixture = createFixture(goal, async () => {
			goal.paused = false;
			goal.state = "complete";
		});

		await assert.rejects(
			() => fixture.team.startTeam(goal.id, explicitPausedStart),
			(err: unknown) => err instanceof TeamStartError && err.code === "GOAL_COMPLETE",
		);
		assert.equal(fixture.resumeGoal.mock.calls.length, 1);
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 0, "post-resume state changes must prevent createSession");
		assert.equal(fixture.team.getTeamState(goal.id), undefined);
	});

	it("keeps scheduler starts paused unless an operator explicitly requests resume", async () => {
		const fixture = createFixture();

		await assert.rejects(
			() => fixture.team.startTeam(fixture.goal.id),
			(err: any) => err?.code === "GOAL_PAUSED",
		);
		assert.equal(fixture.resumeGoal.mock.calls.length, 0);
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 0);
	});

	it("keeps resume authority separate from explicit idempotency", async () => {
		const fixture = createFixture();
		await fixture.team.startTeam(fixture.goal.id, explicitPausedStart);

		await assert.rejects(
			() => fixture.team.startTeam(fixture.goal.id, { resumePaused: true }),
			(err: unknown) => err instanceof TeamStartError && err.code === "TEAM_ALREADY_ACTIVE",
			"resume authority alone must not make internal starts idempotent",
		);
		await assert.rejects(
			() => fixture.team.startTeam(fixture.goal.id),
			(err: unknown) => err instanceof TeamStartError && err.code === "TEAM_ALREADY_ACTIVE",
			"no-options internal starts must retain TEAM_ALREADY_ACTIVE",
		);
	});

	it("does not resume or spawn when an active REST snapshot races a pause", async () => {
		const noTeam = createGoal();
		noTeam.paused = false;
		const noTeamFixture = createFixture(noTeam);
		noTeam.paused = true;
		await assert.rejects(
			() => noTeamFixture.team.startTeam(noTeam.id, { explicitIdempotent: true, resumePaused: false }),
			(err: unknown) => (err as any)?.code === "GOAL_PAUSED",
		);
		assert.equal(noTeamFixture.resumeGoal.mock.calls.length, 0);
		assert.equal(noTeamFixture.sessionManager.createSession.mock.calls.length, 0);

		const withTeam = createGoal();
		withTeam.paused = false;
		const withTeamFixture = createFixture(withTeam);
		const lead = await withTeamFixture.team.startTeam(withTeam.id, { explicitIdempotent: true });
		withTeam.paused = true;
		const sameLead = await withTeamFixture.team.startTeam(withTeam.id, { explicitIdempotent: true, resumePaused: false });
		assert.equal(sameLead.id, lead.id, "a raced pause may only return the existing live lead");
		assert.equal(withTeam.paused, true, "an active snapshot must not clear a raced pause");
		assert.equal(withTeamFixture.resumeGoal.mock.calls.length, 0);
		assert.equal(withTeamFixture.sessionManager.createSession.mock.calls.length, 1);
	});

	it("does not create a team when the canonical resume lifecycle fails", async () => {
		const fixture = createFixture(createGoal(), async () => {
			throw new Error("durable store unavailable");
		});

		await assert.rejects(
			() => fixture.team.startTeam(fixture.goal.id, explicitPausedStart),
			(err: unknown) => err instanceof TeamStartError && err.code === "TEAM_START_RESUME_FAILED",
		);
		assert.equal(fixture.sessionManager.createSession.mock.calls.length, 0);
		assert.equal(fixture.team.getTeamState(fixture.goal.id), undefined);
	});

	it("does not resume or spawn non-startable paused goals", async () => {
		const cases: Array<{ label: string; patch: Partial<MockGoal>; code: string }> = [
			{ label: "blocked", patch: { state: "blocked" }, code: "GOAL_BLOCKED" },
			{ label: "archived", patch: { archived: true }, code: "GOAL_ARCHIVED" },
			{ label: "complete", patch: { state: "complete" }, code: "GOAL_COMPLETE" },
			{ label: "shelved", patch: { state: "shelved" }, code: "GOAL_SHELVED" },
			{ label: "setup incomplete", patch: { setupStatus: "preparing" }, code: "GOAL_SETUP_INCOMPLETE" },
			{ label: "team disabled", patch: { team: false }, code: "TEAM_DISABLED" },
		];
		for (const testCase of cases) {
			const fixture = createFixture({ ...createGoal(), ...testCase.patch });
			await assert.rejects(
				() => fixture.team.startTeam(fixture.goal.id, explicitPausedStart),
				(err: unknown) => err instanceof TeamStartError && err.code === testCase.code,
				`${testCase.label} goal must retain its startability error`,
			);
			assert.equal(fixture.resumeGoal.mock.calls.length, 0, `${testCase.label} goal must not be resumed`);
			assert.equal(fixture.sessionManager.createSession.mock.calls.length, 0, `${testCase.label} goal must not create a lead`);
		}
	});
});
