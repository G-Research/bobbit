// v2-native deterministic coverage for archived team ownership reconciliation.

import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

vi.mock("../../src/server/agent/orphan-cleanup.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/server/agent/orphan-cleanup.ts")>();
	return {
		...original,
		scanOrphanedTranscriptsAsync: async () => ({ count: 0, paths: [] }),
	};
});

import { SessionManager } from "../../src/server/agent/session-manager.ts";
import { TeamManager, TeamStartError } from "../../src/server/agent/team-manager.ts";

interface GoalRow {
	id: string;
	projectId: string;
	title: string;
	cwd: string;
	state: string;
	team: boolean;
	archived: boolean;
	setupStatus?: string;
	spec?: string;
}

interface TeamRow {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: Array<{ sessionId: string; role: string; task: string; createdAt: number; kind?: "worker" | "reviewer" }>;
	maxConcurrent: number;
}

function session(id: string, ownership: Record<string, unknown> = {}): any {
	return {
		id,
		title: id,
		cwd: path.resolve("/pure/archived-goal-reconciliation"),
		agentSessionFile: path.resolve("/pure/archived-goal-reconciliation", `${id}.jsonl`),
		projectId: "project-1",
		createdAt: 1,
		lastActivity: 1,
		wasStreaming: false,
		messageQueue: [],
		archived: false,
		...ownership,
	};
}

function goal(id: string, archived = true): GoalRow {
	return {
		id,
		projectId: "project-1",
		title: id,
		cwd: path.resolve("/pure/archived-goal-reconciliation"),
		state: "in-progress",
		team: false,
		archived,
		setupStatus: "ready",
		spec: "Test goal",
	};
}

class MemorySessionStore {
	readonly rows = new Map<string, any>();
	readonly puts: string[] = [];
	readonly archives: string[] = [];

	constructor(initial: any[]) {
		for (const row of initial) this.rows.set(row.id, row);
	}

	get(id: string): any { return this.rows.get(id); }
	getAll(): any[] { return [...this.rows.values()]; }
	getLive(): any[] { return this.getAll().filter((row) => row.archived !== true); }
	put(row: any): void { this.rows.set(row.id, row); this.puts.push(row.id); }
	archive(id: string): void {
		const row = this.rows.get(id);
		if (row) { row.archived = true; this.archives.push(id); }
	}
}

class MemoryTeamStore {
	readonly rows = new Map<string, TeamRow>();
	readonly puts: string[] = [];
	readonly removals: string[] = [];
	failRemoval = false;

	constructor(initial: TeamRow[]) {
		for (const row of initial) this.rows.set(row.goalId, structuredClone(row));
	}

	get(goalId: string): TeamRow | undefined { return this.rows.get(goalId); }
	getAll(): TeamRow[] { return [...this.rows.values()]; }
	put(row: TeamRow): void { this.rows.set(row.goalId, structuredClone(row)); this.puts.push(row.goalId); }
	remove(goalId: string): void { this.rows.delete(goalId); this.removals.push(goalId); }
	async removeAsync(goalId: string): Promise<void> {
		this.removals.push(goalId);
		if (this.failRemoval) throw new Error("team-state write unavailable");
		this.rows.delete(goalId);
	}
}

const noTimerClock = {
	now: () => 1_700_000_000_000,
	setTimeout: (() => ({ unref() {} })) as any,
	clearTimeout: (() => {}) as any,
	setInterval: (() => ({ unref() {} })) as any,
	clearInterval: (() => {}) as any,
};

const managers: TeamManager[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose();
	vi.restoreAllMocks();
});

function makeFixture(options: {
	goals: GoalRow[];
	sessions: any[];
	teams?: TeamRow[];
	terminate?: (id: string, fixture: ReturnType<typeof makeFixture>) => Promise<boolean>;
	archive?: (id: string, fixture: ReturnType<typeof makeFixture>) => Promise<boolean>;
}) {
	const goals = new Map(options.goals.map((row) => [row.id, row]));
	const sessionStore = new MemorySessionStore(options.sessions);
	const teamStore = new MemoryTeamStore(options.teams ?? []);
	const live = new Map<string, any>();
	const subscriptions: string[] = [];
	for (const row of options.sessions) {
		live.set(row.id, {
			...row,
			status: "idle",
			clients: new Set(),
			rpcClient: {
				onEvent: vi.fn(() => {
					subscriptions.push(row.id);
					return () => {};
				}),
			},
		});
	}

	const terminateCalls: string[] = [];
	const archiveCalls: string[] = [];
	const createCalls: string[] = [];
	let fixture!: any;
	const goalStore = {
		get: (id: string) => goals.get(id),
		getAll: () => [...goals.values()],
	};
	const goalManager = {
		getGoal: (id: string) => goals.get(id),
		updateGoal: async (id: string, patch: Record<string, unknown>) => {
			const row = goals.get(id);
			if (row) Object.assign(row, patch);
			return row;
		},
	};
	const context = { project: { id: "project-1" }, goalStore, goalManager, sessionStore, teamStore };
	const projectContextManager = {
		all: () => [context],
		getContextForGoal: (id: string) => goals.has(id) ? context : undefined,
		getOrCreate: () => context,
		getAllLiveSessions: () => sessionStore.getLive(),
		getAllSessions: () => sessionStore.getAll(),
	};
	const sessionManager: any = {
		_testStore: sessionStore,
		isSandboxEnabled: false,
		isSubgoalsEnabled: false,
		getSandboxManager: () => undefined,
		getPersistedSession: (id: string) => sessionStore.get(id),
		getSession: (id: string) => live.get(id),
		getSessionInfo: (id: string) => live.get(id),
		terminateSession: vi.fn(async (id: string) => {
			terminateCalls.push(id);
			if (options.terminate) return options.terminate(id, fixture);
			sessionStore.archive(id);
			live.delete(id);
			return true;
		}),
		storeArchive: vi.fn(async (id: string) => {
			archiveCalls.push(id);
			if (options.archive) return options.archive(id, fixture);
			sessionStore.archive(id);
			live.delete(id);
			return true;
		}),
		setTitle: (id: string, title: string) => {
			const row = sessionStore.get(id);
			if (row) row.title = title;
			const active = live.get(id);
			if (active) active.title = title;
			return !!row;
		},
		updateSessionMeta: (id: string, patch: Record<string, unknown>) => {
			const row = sessionStore.get(id);
			if (row) Object.assign(row, patch);
			const active = live.get(id);
			if (active) Object.assign(active, patch);
			return !!row;
		},
		enqueuePrompt: vi.fn(async () => ({ status: "dispatched" })),
	};
	const roleStore = {
		get: (name: string) => name === "team-lead" ? {
			name: "team-lead",
			label: "Team Lead",
			promptTemplate: "Lead {{GOAL_BRANCH}} as {{AGENT_ID}}. {{AVAILABLE_ROLES}}",
			toolPolicies: {},
			createdAt: 0,
			updatedAt: 0,
		} : undefined,
		getAll: () => [],
	};
	const manager = new TeamManager(sessionManager, {
		projectContextManager: projectContextManager as any,
		roleStore: roleStore as any,
		toolManager: { getExtensionPath: () => path.resolve("/pure/team-extension.ts") } as any,
		taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] } as any,
		colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) } as any,
	}, undefined, noTimerClock as any);
	managers.push(manager);

	fixture = {
		manager,
		goals,
		goalStore,
		goalManager,
		sessionStore,
		teamStore,
		context,
		projectContextManager,
		sessionManager,
		live,
		subscriptions,
		terminateCalls,
		archiveCalls,
		createCalls,
	};
	return fixture;
}

function teamEntry(goalId: string, lead: string | null, agents: string[] = []): TeamRow {
	return {
		goalId,
		teamLeadSessionId: lead,
		agents: agents.map((sessionId) => ({ sessionId, role: "coder", task: "test", createdAt: 1 })),
		maxConcurrent: 4,
	};
}

describe("archived goal reconciliation", () => {
	it("uses teamGoalId without team state and current TeamStore references, but leaves goalId-only sessions live", async () => {
		const missingStateGoal = goal("goal-missing-team-state");
		const referencedGoal = goal("goal-team-reference");
		const owned = session("owned-without-team-state", { goalId: missingStateGoal.id, teamGoalId: missingStateGoal.id });
		const referenced = session("referenced-without-teamGoalId", { goalId: referencedGoal.id });
		const standalone = session("standalone-affiliation", { goalId: missingStateGoal.id });
		const fixture = makeFixture({
			goals: [missingStateGoal, referencedGoal],
			sessions: [owned, referenced, standalone],
			teams: [teamEntry(referencedGoal.id, referenced.id)],
		});
		await fixture.manager.waitForRestore();

		const suppressed = await fixture.manager.reconcileArchivedTeamOwnership();

		assert.deepEqual([...suppressed], []);
		assert.equal(fixture.sessionStore.get(owned.id).archived, true, "teamGoalId is authoritative without TeamStore state");
		assert.equal(fixture.sessionStore.get(referenced.id).archived, true, "a current TeamStore reference is authoritative");
		assert.equal(fixture.sessionStore.get(standalone.id).archived, false, "goalId affiliation alone must remain live");
		assert.equal(fixture.teamStore.get(referencedGoal.id), undefined);
		assert.deepEqual(new Set(fixture.terminateCalls), new Set([owned.id, referenced.id]));

		const writesAfterRepair = {
			terminate: fixture.terminateCalls.length,
			archive: fixture.archiveCalls.length,
			teamRemove: fixture.teamStore.removals.length,
		};
		const secondSuppressed = await fixture.manager.reconcileArchivedTeamOwnership();
		assert.deepEqual([...secondSuppressed], []);
		assert.deepEqual(
			{
				terminate: fixture.terminateCalls.length,
				archive: fixture.archiveCalls.length,
				teamRemove: fixture.teamStore.removals.length,
			},
			writesAfterRepair,
			"a clean second reconciliation must perform no writes",
		);
	});

	it("recursively archives descendants through direct fallback when termination fails", async () => {
		const archivedGoal = goal("goal-recursive-closure");
		const root = session("team-root", { teamGoalId: archivedGoal.id, goalId: archivedGoal.id });
		const delegate = session("delegate-child", { delegateOf: root.id, modelProvider: "exact", modelId: "model" });
		const visibleChild = session("visible-grandchild", { parentSessionId: delegate.id, childKind: "review" });
		const standalone = session("unrelated-goal-session", { goalId: archivedGoal.id });
		const fixture = makeFixture({
			goals: [archivedGoal],
			sessions: [root, delegate, visibleChild, standalone],
			terminate: async () => { throw new Error("runtime stop and cascade failed"); },
		});
		await fixture.manager.waitForRestore();

		const result = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });

		assert.equal(result.status, "complete");
		assert.deepEqual(new Set(result.archivedSessionIds), new Set([root.id, delegate.id, visibleChild.id]));
		assert.deepEqual(new Set(fixture.archiveCalls), new Set([root.id, delegate.id, visibleChild.id]));
		assert.equal(fixture.sessionStore.get(standalone.id).archived, false);
		assert.equal(fixture.sessionStore.get(delegate.id).modelId, "model", "soft archive preserves session metadata");
	});

	it("returns exact boot suppression after archive publication failure and still eagerly dispatches an unrelated live session", async () => {
		const archivedGoal = goal("goal-blocked-publication");
		const root = session("blocked-team-root", { teamGoalId: archivedGoal.id });
		const child = session("blocked-child", { parentSessionId: root.id, childKind: "review" });
		const control = session("live-control");
		const fixture = makeFixture({
			goals: [archivedGoal],
			sessions: [root, child, control],
			terminate: async () => false,
			archive: async () => { throw new Error("session archive write unavailable"); },
		});
		await fixture.manager.waitForRestore();

		const suppressed = await fixture.manager.reconcileArchivedTeamOwnership();
		assert.deepEqual(new Set(suppressed), new Set([root.id, child.id]));
		assert.equal(fixture.sessionStore.get(root.id).archived, false);
		assert.equal(fixture.sessionStore.get(child.id).archived, false);

		const restoreManager: any = Object.create(SessionManager.prototype);
		restoreManager.projectContextManager = fixture.projectContextManager;
		restoreManager.sessions = new Map();
		restoreManager.orchestrationCore = null;
		restoreManager.clock = { now: () => Date.now() };
		restoreManager._bootRestoreLagSampler = () => 0;
		restoreManager.yieldBootRestore = async () => {};
		const dispatched: string[] = [];
		restoreManager.restoreOneSession = async (row: any) => { dispatched.push(row.id); };

		await restoreManager.restoreSessions(suppressed);

		assert.deepEqual(dispatched, [control.id], "suppression is narrow and does not defer genuinely live sessions");
	});

	it("retains failed TeamStore removal only as passive evidence and never resubscribes the archived team", async () => {
		const archivedGoal = goal("goal-passive-team-evidence");
		const lead = session("passive-lead", { teamGoalId: archivedGoal.id, role: "team-lead" });
		const fixture = makeFixture({
			goals: [archivedGoal],
			sessions: [lead],
			teams: [teamEntry(archivedGoal.id, lead.id)],
		});
		fixture.teamStore.failRemoval = true;
		await fixture.manager.waitForRestore();
		assert.ok(fixture.manager.getTeamState(archivedGoal.id), "fixture begins with restored runtime team state");

		const result = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });

		assert.equal(result.status, "blocked");
		assert.equal(result.teamEntryRetained, true);
		assert.ok(fixture.teamStore.get(archivedGoal.id), "failed durable removal retains retry evidence");
		assert.equal(fixture.manager.getTeamState(archivedGoal.id), undefined, "runtime state is deactivated independently");
		fixture.manager.resubscribeTeamEvents();
		assert.deepEqual(fixture.subscriptions, [], "passive retry evidence must not reactivate event subscriptions");
	});

	it("serializes terminal reconciliation behind admitted creation, catches that session, and rejects later admission", async () => {
		const racingGoal = goal("goal-admission-race", false);
		racingGoal.team = true;
		racingGoal.state = "in-progress";
		const fixture = makeFixture({ goals: [racingGoal], sessions: [] });
		await fixture.manager.waitForRestore();

		let releaseCreate!: () => void;
		const createReleased = new Promise<void>((resolve) => { releaseCreate = resolve; });
		let signalCreateEntered!: () => void;
		const createEntered = new Promise<void>((resolve) => { signalCreateEntered = resolve; });
		fixture.sessionManager.createSession = vi.fn(async (cwd: string, _args: unknown, goalId: string) => {
			fixture.createCalls.push(goalId);
			signalCreateEntered();
			await createReleased;
			const row = session("racing-team-lead", { cwd, goalId });
			fixture.sessionStore.put(row);
			const active = {
				...row,
				status: "idle",
				clients: new Set(),
				rpcClient: { onEvent: vi.fn(() => () => {}) },
			};
			fixture.live.set(row.id, active);
			return active;
		});

		const starting = fixture.manager.startTeam(racingGoal.id);
		await createEntered;
		racingGoal.archived = true;
		const reconciling = fixture.manager.reconcileArchivedGoal(racingGoal.id, { audit: false });
		releaseCreate();
		await starting;
		const result = await reconciling;

		assert.equal(result.status, "complete");
		assert.deepEqual(result.archivedSessionIds, ["racing-team-lead"]);
		assert.equal(fixture.sessionStore.get("racing-team-lead").archived, true, "work admitted before closure is included");
		await assert.rejects(
			() => fixture.manager.startTeam(racingGoal.id),
			(error: unknown) => error instanceof TeamStartError && error.code === "GOAL_ARCHIVED",
		);
		assert.equal(fixture.createCalls.length, 1, "post-terminal admission creates no session");
	});

	it("caps boot audit error samples while suppressing every failed row", async () => {
		const archivedGoal = goal("goal-bounded-audit");
		const rows = Array.from({ length: 12 }, (_, index) => session(`failed-${index}`, { teamGoalId: archivedGoal.id }));
		const fixture = makeFixture({
			goals: [archivedGoal],
			sessions: rows,
			terminate: async (id) => { throw new Error(`stop-${id}`); },
			archive: async (id) => { throw new Error(`archive-${id}`); },
		});
		await fixture.manager.waitForRestore();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		const suppressed = await fixture.manager.reconcileArchivedTeamOwnership();

		assert.equal(suppressed.size, rows.length);
		const audit = log.mock.calls.map((args) => String(args[0])).find((line) => line.includes("Boot archived-team repair:"));
		assert.ok(audit, "boot repair emits one bounded audit summary");
		const encodedSamples = audit.match(/ samples=(\[.*\])$/)?.[1];
		assert.ok(encodedSamples, "failed repair includes bounded samples");
		const samples = JSON.parse(encodedSamples);
		assert.equal(samples.length, 10, "audit exposes at most ten samples");
		assert.match(audit, /suppressed=12/);
	});
});
