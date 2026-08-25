// deterministic coverage for archived team ownership reconciliation.

import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

vi.mock("../../src/server/agent/orphan-cleanup.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/server/agent/orphan-cleanup.ts")>();
	return {
		...original,
		scanOrphanedTranscriptsAsync: async () => ({ count: 0, paths: [] }),
	};
});

import { collectTeamOwnedSessionClosure, SessionManager } from "../../../src/server/agent/session-manager.ts";
import { SessionStore } from "../../../src/server/agent/session-store.ts";
import { OrchestrationCore } from "../../../src/server/agent/orchestration-core.ts";
import { TeamManager, TeamStartError } from "../../../src/server/agent/team-manager.ts";
import { createMemFs } from "../../support/harnesses/mem-fs.ts";

interface GoalRow {
	id: string;
	projectId: string;
	title: string;
	cwd: string;
	state: string;
	team?: boolean;
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
	async archiveAsync(id: string): Promise<boolean> {
		if (!this.rows.has(id)) return false;
		this.archive(id);
		return true;
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
	sessionStore?: MemorySessionStore | SessionStore;
	teamStore?: MemoryTeamStore;
	restoreLive?: boolean;
	terminate?: (id: string, fixture: ReturnType<typeof makeFixture>) => Promise<boolean>;
	archive?: (id: string, fixture: ReturnType<typeof makeFixture>) => Promise<boolean>;
	markTeam?: (id: string, fixture: ReturnType<typeof makeFixture>) => Promise<boolean>;
}) {
	const goals = new Map(options.goals.map((row) => [row.id, row]));
	const sessionStore = options.sessionStore ?? new MemorySessionStore(options.sessions);
	const teamStore = options.teamStore ?? new MemoryTeamStore(options.teams ?? []);
	const live = new Map<string, any>();
	const subscriptions: string[] = [];
	if (options.restoreLive !== false) for (const row of options.sessions) {
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
	const terminateOptions: Array<Record<string, unknown>> = [];
	const archiveCalls: string[] = [];
	const createCalls: string[] = [];
	const markerCalls: string[] = [];
	const quiesceCalls: string[] = [];
	let admissionFence: (<T>(goalId: string, operation: () => Promise<T>) => Promise<T>) | undefined;
	let fixture!: any;
	const goalStore = {
		get: (id: string) => goals.get(id),
		getAll: () => [...goals.values()],
		updateStrict: vi.fn(async (id: string, patch: Record<string, unknown>) => {
			markerCalls.push(id);
			if (options.markTeam) return options.markTeam(id, fixture);
			const row = goals.get(id);
			if (!row) return false;
			Object.assign(row, patch);
			return true;
		}),
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
		getTrustedTeamGoalIdForSession: (id: string) => {
			const row = sessionStore.get(id);
			if (!row) return undefined;
			const currentLive = sessionStore.getLive();
			const ownershipRows = currentLive.some((candidate) => candidate.id === id) ? currentLive : [...currentLive, row];
			const candidates = new Set<string>();
			for (const liveRow of ownershipRows) {
				if (liveRow.teamGoalId) candidates.add(liveRow.teamGoalId);
			}
			for (const entry of teamStore.getAll()) candidates.add(entry.goalId);
			for (const goalId of candidates) {
				const entry = teamStore.get(goalId);
				const references = new Set<string>();
				if (entry?.teamLeadSessionId) references.add(entry.teamLeadSessionId);
				for (const agent of entry?.agents ?? []) references.add(agent.sessionId);
				if (collectTeamOwnedSessionClosure(goalId, ownershipRows, references).has(id)) return goalId;
			}
			return undefined;
		},
		setTeamGoalAdmissionFence: (fence: typeof admissionFence) => { admissionFence = fence; },
		runWithTeamGoalAdmission: <T>(goalId: string, operation: () => Promise<T>) =>
			admissionFence ? admissionFence(goalId, operation) : operation(),
		terminateSession: vi.fn(async (id: string, terminateOpts: Record<string, unknown> = {}) => {
			terminateCalls.push(id);
			terminateOptions.push(terminateOpts);
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
		quiesceSessionRuntime: vi.fn(async (id: string) => {
			quiesceCalls.push(id);
			live.delete(id);
			return true;
		}),
		createDelegateSession: vi.fn(async (parentId: string, delegateOpts: Record<string, unknown>) => {
			const parent = sessionStore.get(parentId);
			const id = `delegate-${createCalls.length + 1}`;
			createCalls.push(id);
			const trustedTeamGoalId = sessionManager.getTrustedTeamGoalIdForSession(parentId);
			const row = session(id, {
				...delegateOpts,
				delegateOf: parentId,
				projectId: parent?.projectId,
				teamGoalId: trustedTeamGoalId ?? parent?.goalId ?? parent?.teamGoalId,
			});
			sessionStore.put(row);
			const active = { ...row, status: "idle", clients: new Set(), rpcClient: { onEvent: vi.fn(() => () => {}) } };
			live.set(id, active);
			return active;
		}),
		createSession: vi.fn(async (cwd: string, _args: unknown, goalId: string | undefined, _assistant: unknown, createOpts: Record<string, unknown>) => {
			const id = `full-${createCalls.length + 1}`;
			createCalls.push(id);
			const row = session(id, { cwd, goalId, ...createOpts });
			sessionStore.put(row);
			const active = { ...row, status: "idle", clients: new Set(), rpcClient: { onEvent: vi.fn(() => () => {}) } };
			live.set(id, active);
			return active;
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
		terminateOptions,
		archiveCalls,
		createCalls,
		markerCalls,
		quiesceCalls,
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

	it("treats every matching teamGoalId as ownership regardless of standalone ancestry", async () => {
		const archivedGoal = goal("goal-standalone-delegate");
		const foreignGoal = goal("goal-foreign-descendant", false);
		const standalone = session("standalone-root", { goalId: archivedGoal.id });
		const delegate = session("standalone-delegate", { delegateOf: standalone.id, teamGoalId: archivedGoal.id });
		const grandchild = session("standalone-grandchild", {
			parentSessionId: delegate.id,
			childKind: "review",
			teamGoalId: archivedGoal.id,
		});
		const worker = session("genuine-worker", { teamGoalId: archivedGoal.id, role: "coder" });
		const mixedLinkChild = session("mixed-link-child", {
			delegateOf: standalone.id,
			parentSessionId: worker.id,
			childKind: "host-agents",
		});
		const foreignChild = session("foreign-owner-child", {
			delegateOf: worker.id,
			teamGoalId: foreignGoal.id,
		});
		const foreignGrandchild = session("foreign-owner-grandchild", { delegateOf: foreignChild.id });
		const fixture = makeFixture({
			goals: [archivedGoal, foreignGoal],
			sessions: [standalone, delegate, grandchild, worker, mixedLinkChild, foreignChild, foreignGrandchild],
		});
		await fixture.manager.waitForRestore();

		const result = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });

		assert.equal(fixture.sessionStore.get(standalone.id).archived, false, "goalId-only roots remain standalone");
		assert.equal(fixture.sessionStore.get(delegate.id).archived, true, "matching teamGoalId is an ownership root despite its parent");
		assert.equal(fixture.sessionStore.get(grandchild.id).archived, true, "every matching teamGoalId row is independently owned");
		assert.equal(fixture.sessionStore.get(worker.id).archived, true, "store-only matching ownership remains authoritative");
		assert.equal(fixture.sessionStore.get(mixedLinkChild.id).archived, true, "either canonical child link reaches a selected team parent");
		assert.equal(fixture.sessionStore.get(foreignChild.id).archived, false, "foreign non-empty team ownership wins over descendant discovery");
		assert.equal(fixture.sessionStore.get(foreignGrandchild.id).archived, false, "foreign-owned subtrees are not traversed");
		const workerOptions = fixture.terminateOptions[fixture.terminateCalls.indexOf(worker.id)];
		const cascadeIds = workerOptions.cascadeSessionIds as ReadonlySet<string>;
		assert.equal(cascadeIds.has(mixedLinkChild.id), true, "canonical selected descendants remain in the termination cascade");
		assert.equal(cascadeIds.has(foreignChild.id), false, "foreign conflicts are excluded from canonical cascade termination");
		assert.match(result.errors.join("\n"), /ownership conflict/);
	});

	it("uses matching teamGoalId as durable orchestration admission ownership", async () => {
		const archivedGoal = goal("goal-standalone-orchestration", false);
		const standalone = session("standalone-orchestration-root", { goalId: archivedGoal.id });
		const genuineWorker = session("genuine-orchestration-worker", { teamGoalId: archivedGoal.id, role: "coder" });
		const fixture = makeFixture({ goals: [archivedGoal], sessions: [standalone, genuineWorker] });
		await fixture.manager.waitForRestore();
		const core = new OrchestrationCore({
			sessionManager: fixture.sessionManager,
			resolveSessionModel: () => undefined,
		});

		const child = await core.spawn({ ownerSessionId: standalone.id, instructions: "team-owned metadata child" });
		assert.equal(fixture.sessionStore.get(child.sessionId).teamGoalId, archivedGoal.id, "effective-goal metadata is still copied");
		assert.equal(fixture.sessionManager.getTrustedTeamGoalIdForSession(child.sessionId), archivedGoal.id, "the exact durable stamp is ownership regardless of ancestry");

		archivedGoal.archived = true;
		const rowsBeforeRejectedCreate = fixture.sessionStore.getAll().length;
		await assert.rejects(
			() => core.spawn({ ownerSessionId: genuineWorker.id, instructions: "must be rejected" }),
			(error: unknown) => error instanceof TeamStartError && error.code === "GOAL_ARCHIVED",
		);
		assert.equal(fixture.sessionStore.getAll().length, rowsBeforeRejectedCreate, "terminal admission creates no row");

		const result = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });
		assert.equal(fixture.sessionStore.get(child.sessionId).archived, true, "matching child metadata is reconciled as ownership");
		assert.equal(fixture.sessionStore.get(standalone.id).archived, false);
		assert.equal(fixture.sessionStore.get(genuineWorker.id).archived, true, "matching team ownership remains terminal");
		assert.ok(result.archivedSessionIds.includes(child.sessionId));
	});

	it("durably propagates TeamStore-only ownership to bare and full children before cold repair", async () => {
		const archivedGoal = goal("goal-teamstore-child-stamps", false);
		const unstampedOwner = session("teamstore-only-owner", { role: "team-lead" });
		const goalOnlyControl = session("goal-only-control", { goalId: archivedGoal.id });
		const initial = makeFixture({
			goals: [archivedGoal],
			sessions: [unstampedOwner, goalOnlyControl],
			teams: [teamEntry(archivedGoal.id, unstampedOwner.id)],
		});
		await initial.manager.waitForRestore();
		const core = new OrchestrationCore({
			sessionManager: initial.sessionManager,
			resolveSessionModel: () => undefined,
		});

		const bare = await core.spawn({ ownerSessionId: unstampedOwner.id, instructions: "bare" });
		const shared = await core.spawn({ ownerSessionId: unstampedOwner.id, instructions: "shared", lifecycle: "full" });
		const branched = await core.spawn({
			ownerSessionId: unstampedOwner.id,
			instructions: "branched",
			lifecycle: "full",
			worktree: {
				mode: "sub-branch",
				repoPath: path.resolve("/pure/repo"),
				goalId: "child-worktree-goal",
				branch: "goal/child/helper",
				cwd: path.resolve("/pure/repo"),
			},
		});
		const children = [bare.sessionId, shared.sessionId, branched.sessionId];
		for (const id of children) {
			assert.equal(initial.sessionStore.get(id).teamGoalId, archivedGoal.id, `${id} carries exact initial ownership`);
		}

		initial.teamStore.remove(archivedGoal.id);
		archivedGoal.archived = true;
		const cold = makeFixture({
			goals: [archivedGoal],
			sessions: initial.sessionStore.getAll(),
			sessionStore: initial.sessionStore,
			teamStore: new MemoryTeamStore([]),
			restoreLive: false,
		});
		await cold.manager.waitForRestore();
		const suppressed = await cold.manager.reconcileArchivedTeamOwnership();
		assert.deepEqual([...suppressed], []);
		for (const id of children) assert.equal(cold.sessionStore.get(id).archived, true, `${id} is repaired without TeamStore`);
		assert.equal(cold.sessionStore.get(goalOnlyControl.id).archived, false, "goalId-only control stays live");

		const restoreManager: any = Object.create(SessionManager.prototype);
		restoreManager.projectContextManager = cold.projectContextManager;
		restoreManager.sessions = new Map();
		restoreManager.orchestrationCore = null;
		restoreManager.clock = { now: () => Date.now() };
		restoreManager._bootRestoreLagSampler = () => 0;
		restoreManager.yieldBootRestore = async () => {};
		const dispatched: string[] = [];
		restoreManager.restoreOneSession = async (row: any) => { dispatched.push(row.id); };
		await restoreManager.restoreSessions(suppressed);

		assert.equal(dispatched.includes(goalOnlyControl.id), true, "goalId-only control restores eagerly");
		for (const id of children) assert.equal(dispatched.includes(id), false, `${id} never dispatches`);
	});

	it("removes stale archived-goal team state while leaving a conflicting foreign owner live", async () => {
		const archivedGoal = goal("goal-stale-reference");
		const foreignGoal = goal("goal-foreign-owner", false);
		const foreign = session("foreign-team-session", { teamGoalId: foreignGoal.id });
		const fixture = makeFixture({
			goals: [archivedGoal, foreignGoal],
			sessions: [foreign],
			teams: [teamEntry(archivedGoal.id, foreign.id)],
		});
		await fixture.manager.waitForRestore();

		const result = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });

		assert.equal(result.status, "complete");
		assert.equal(fixture.sessionStore.get(foreign.id).archived, false, "foreign ownership wins over a stale team reference");
		assert.equal(fixture.teamStore.get(archivedGoal.id), undefined, "stale archived-goal team state is still removed");
		assert.match(result.errors.join("\n"), /ownership conflict/);
		const writes = fixture.teamStore.removals.length;
		await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });
		assert.equal(fixture.teamStore.removals.length, writes, "the clean retry performs no TeamStore write");
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
		assert.ok(
			fixture.terminateOptions.every((options: Record<string, unknown>) => options.preserveEvidence === true),
			"reconciliation propagates evidence-preserving termination to every selected descendant",
		);
		assert.equal(fixture.sessionStore.get(standalone.id).archived, false);
		assert.equal(fixture.sessionStore.get(delegate.id).modelId, "model", "soft archive preserves session metadata");
	});

	it("cold restore suppresses matching teamGoalId rows regardless of a goal-only parent", async () => {
		const archivedGoal = goal("goal-cold-restore-ownership");
		const standalone = session("cold-goal-only-root", { goalId: archivedGoal.id });
		const matchingDelegate = session("cold-matching-delegate", {
			delegateOf: standalone.id,
			teamGoalId: archivedGoal.id,
		});
		const matchingGrandchild = session("cold-matching-grandchild", {
			parentSessionId: matchingDelegate.id,
			childKind: "review",
			teamGoalId: archivedGoal.id,
		});
		const control = session("cold-live-control");
		const fixture = makeFixture({
			goals: [archivedGoal],
			sessions: [standalone, matchingDelegate, matchingGrandchild, control],
		});

		const restoreManager: any = Object.create(SessionManager.prototype);
		restoreManager.projectContextManager = fixture.projectContextManager;
		restoreManager.sessions = new Map();
		restoreManager.orchestrationCore = null;
		restoreManager.clock = { now: () => Date.now() };
		restoreManager._bootRestoreLagSampler = () => 0;
		restoreManager.yieldBootRestore = async () => {};
		const dispatched: string[] = [];
		restoreManager.restoreOneSession = async (row: any) => { dispatched.push(row.id); };

		await restoreManager.restoreSessions();

		assert.deepEqual(dispatched, [standalone.id, control.id]);
		assert.equal(fixture.sessionStore.get(standalone.id).archived, false, "goalId alone remains eagerly restorable");
		assert.equal(fixture.sessionStore.get(control.id).archived, false, "unrelated live sessions remain eager");
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

	it("retries a hidden in-memory archive until the same process durably publishes it", async () => {
		const archivedGoal = goal("goal-session-publication-fault");
		archivedGoal.team = true;
		const unstamped = session("teamstore-only-publication-fault", { goalId: archivedGoal.id });
		const control = session("publication-fault-live-control");
		const stateDir = path.resolve("/memfs/archived-goal-durable-ack/state");
		const storeFile = path.join(stateDir, "sessions.json");
		const memfs = createMemFs();
		memfs.mkdirSync(stateDir, { recursive: true });
		const initialStore = new SessionStore(stateDir, memfs);
		initialStore.put(unstamped);
		initialStore.put(control);
		await initialStore.flushAsync();

		const teamStore = new MemoryTeamStore([teamEntry(archivedGoal.id, unstamped.id)]);
		const originalRename = memfs.promises.rename.bind(memfs.promises);
		let failSessionPublication = true;
		(memfs.promises as any).rename = async (from: string, to: string) => {
			if (failSessionPublication && path.resolve(String(to)) === path.resolve(storeFile)) {
				throw new Error("injected session archive publication failure");
			}
			return originalRename(from, to);
		};
		const persistenceError = vi.spyOn(console, "error").mockImplementation(() => {});
		const fixture = makeFixture({
			goals: [archivedGoal],
			sessions: initialStore.getAll(),
			sessionStore: initialStore,
			teamStore,
			terminate: async (id, current) => {
				current.live.delete(id);
				await current.sessionStore.archiveAsync(id);
				return true;
			},
			archive: async (id, current) => {
				try { return await current.sessionStore.archiveAsync(id); }
				catch { return false; }
			},
		});
		await fixture.manager.waitForRestore();

		const failed = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });

		assert.equal(initialStore.get(unstamped.id)?.archived, true, "archiveAsync mutates the in-memory row before publication");
		assert.equal(failed.status, "blocked");
		assert.deepEqual(failed.archivedSessionIds, [], "an in-memory flag is not a durable acknowledgement");
		assert.deepEqual(failed.suppressedSessionIds, [unstamped.id]);
		assert.ok(teamStore.get(archivedGoal.id), "TeamStore remains durable retry authority");
		assert.equal(fixture.live.has(unstamped.id), false, "the stopped process remains deactivated");
		fixture.manager.resubscribeTeamEvents();
		assert.deepEqual(fixture.subscriptions, [], "blocked archived ownership cannot resubscribe events");
		assert.ok(persistenceError.mock.calls.length >= 1, "fixture exercised the real SessionStore publication failure");

		const sameProcessFailed = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });
		assert.equal(sameProcessFailed.status, "blocked", "a hidden archived=true memory row remains retryable while publication is broken");
		assert.deepEqual(sameProcessFailed.archivedSessionIds, []);
		assert.deepEqual(sameProcessFailed.suppressedSessionIds, [unstamped.id]);
		assert.ok(teamStore.get(archivedGoal.id), "the second failed retry retains its only durable authority");
		assert.ok(fixture.archiveCalls.filter((id: string) => id === unstamped.id).length >= 2, "the same process retries the hidden row");

		const crashedStore = new SessionStore(stateDir, memfs);
		assert.equal(crashedStore.get(unstamped.id)?.archived, false, "a crash reloads the still-live durable row after both failed retries");
		const crashed = makeFixture({
			goals: [archivedGoal],
			sessions: crashedStore.getAll(),
			sessionStore: crashedStore,
			teamStore,
			restoreLive: false,
			terminate: async () => false,
			archive: async (id, current) => {
				try { return await current.sessionStore.archiveAsync(id); }
				catch { return false; }
			},
		});
		await crashed.manager.waitForRestore();
		const crashSuppression = await crashed.manager.reconcileArchivedTeamOwnership();
		assert.deepEqual([...crashSuppression], [unstamped.id]);
		assert.ok(teamStore.get(archivedGoal.id), "restart failure still retains TeamStore authority");

		const restoreManager: any = Object.create(SessionManager.prototype);
		restoreManager.projectContextManager = crashed.projectContextManager;
		restoreManager.sessions = new Map();
		restoreManager.orchestrationCore = null;
		restoreManager.clock = { now: () => Date.now() };
		restoreManager._bootRestoreLagSampler = () => 0;
		restoreManager.yieldBootRestore = async () => {};
		const dispatched: string[] = [];
		restoreManager.restoreOneSession = async (row: any) => { dispatched.push(row.id); };
		await restoreManager.restoreSessions(crashSuppression);
		assert.deepEqual(dispatched, [control.id], "a failed restart suppresses the leaked row but preserves eager live restoration");

		failSessionPublication = false;
		const recovered = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });
		assert.equal(recovered.status, "complete");
		assert.deepEqual(recovered.suppressedSessionIds, []);
		assert.deepEqual(recovered.archivedSessionIds, [unstamped.id]);
		assert.equal(teamStore.get(archivedGoal.id), undefined, "TeamStore is removed only after durable session acknowledgement");

		const freshStore = new SessionStore(stateDir, memfs);
		assert.equal(freshStore.get(unstamped.id)?.archived, true, "same-process recovery survives a fresh-store restart");
		assert.equal(freshStore.get(control.id)?.archived, false);
		const clean = makeFixture({
			goals: [archivedGoal],
			sessions: freshStore.getAll(),
			sessionStore: freshStore,
			teamStore,
			restoreLive: false,
		});
		await clean.manager.waitForRestore();
		const cleanGeneration = freshStore.getGeneration();
		const removalsBeforeCleanBoot = teamStore.removals.length;

		assert.deepEqual([...(await clean.manager.reconcileArchivedTeamOwnership())], []);
		assert.equal(freshStore.getGeneration(), cleanGeneration, "clean second boot performs no session write");
		assert.equal(teamStore.removals.length, removalsBeforeCleanBoot, "clean second boot performs no team write");
		assert.deepEqual(clean.archiveCalls, []);
	});

	it("retries a direct teamGoalId row without TeamStore after an atomic archive failure", async () => {
		const archivedGoal = goal("goal-direct-publication-fault");
		const owned = session("direct-publication-fault", {
			goalId: archivedGoal.id,
			teamGoalId: archivedGoal.id,
		});
		const goalOnlyControl = session("direct-goal-only-control", { goalId: archivedGoal.id });
		const stateDir = path.resolve("/memfs/archived-goal-direct-durable-ack/state");
		const storeFile = path.join(stateDir, "sessions.json");
		const memfs = createMemFs();
		memfs.mkdirSync(stateDir, { recursive: true });
		const store = new SessionStore(stateDir, memfs);
		store.put(owned);
		store.put(goalOnlyControl);
		await store.flushAsync();

		const originalRename = memfs.promises.rename.bind(memfs.promises);
		let failPublication = true;
		(memfs.promises as any).rename = async (from: string, to: string) => {
			if (failPublication && path.resolve(String(to)) === path.resolve(storeFile)) {
				throw new Error("injected direct session archive publication failure");
			}
			return originalRename(from, to);
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		const teamStore = new MemoryTeamStore([]);
		const fixture = makeFixture({
			goals: [archivedGoal],
			sessions: store.getAll(),
			sessionStore: store,
			teamStore,
			terminate: async (id, current) => {
				current.live.delete(id);
				await current.sessionStore.archiveAsync(id);
				return true;
			},
			archive: async (id, current) => {
				try { return await current.sessionStore.archiveAsync(id); }
				catch { return false; }
			},
		});
		await fixture.manager.waitForRestore();

		const first = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });
		assert.equal(first.status, "blocked");
		assert.deepEqual(first.suppressedSessionIds, [owned.id]);
		assert.equal(store.get(owned.id)?.archived, true, "failed publication hides the row from getLive");
		assert.equal(teamStore.get(archivedGoal.id), undefined, "no TeamStore authority is synthesized");
		assert.equal(store.get(goalOnlyControl.id)?.archived, false);

		const secondSuppression = await fixture.manager.reconcileArchivedTeamOwnership();
		assert.deepEqual([...secondSuppression], [owned.id], "the same-process boot guard includes retry-only goals");
		assert.ok(fixture.archiveCalls.filter((id: string) => id === owned.id).length >= 2);
		assert.equal(store.get(goalOnlyControl.id)?.archived, false);

		failPublication = false;
		const recovered = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });
		assert.equal(recovered.status, "complete");
		assert.deepEqual(recovered.archivedSessionIds, [owned.id]);
		assert.deepEqual(recovered.suppressedSessionIds, []);
		assert.equal(store.get(goalOnlyControl.id)?.archived, false);

		const freshStore = new SessionStore(stateDir, memfs);
		const clean = makeFixture({
			goals: [archivedGoal],
			sessions: freshStore.getAll(),
			sessionStore: freshStore,
			teamStore,
			restoreLive: false,
		});
		await clean.manager.waitForRestore();
		const generation = freshStore.getGeneration();
		assert.deepEqual([...(await clean.manager.reconcileArchivedTeamOwnership())], []);
		assert.equal(freshStore.getGeneration(), generation, "clean restart performs no reconciliation write");
		assert.deepEqual(clean.archiveCalls, []);
		assert.equal(freshStore.get(goalOnlyControl.id)?.archived, false);
	});

	it("blocks on a strict team-marker failure, quiesces only owned runtime, and recovers without deleting evidence", async () => {
		const archivedGoal = goal("goal-marker-publication-fault");
		const owned = session("marker-fault-owned", {
			goalId: archivedGoal.id,
			teamGoalId: archivedGoal.id,
			branch: "goal/marker-evidence",
			worktreePath: path.resolve("/evidence/marker-worktree"),
			agentSessionFile: path.resolve("/evidence/transcripts/marker-fault-owned.jsonl"),
		});
		const standalone = session("marker-fault-standalone", { goalId: archivedGoal.id });
		const ownedEvidence = structuredClone(owned);
		const teamStore = new MemoryTeamStore([teamEntry(archivedGoal.id, owned.id)]);
		let markerAvailable = false;
		const fixture = makeFixture({
			goals: [archivedGoal],
			sessions: [owned, standalone],
			teamStore,
			markTeam: async (id, current) => {
				if (!markerAvailable) throw new Error("injected strict team marker failure");
				current.goals.get(id).team = true;
				return true;
			},
		});
		await fixture.manager.waitForRestore();

		const blocked = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });

		assert.equal(blocked.status, "blocked");
		assert.deepEqual(blocked.suppressedSessionIds, [owned.id], "suppression names the exact owned row");
		assert.match(blocked.errors.join("\n"), /team marker: injected strict team marker failure/);
		assert.deepEqual(fixture.quiesceCalls, [owned.id], "goalId-only standalone control is never quiesced");
		assert.deepEqual(fixture.terminateCalls, [], "session archival cannot precede the durable ownership marker");
		assert.deepEqual(fixture.archiveCalls, []);
		assert.equal(fixture.live.has(owned.id), false, "owned process runtime is stopped despite the persistence fault");
		assert.equal(fixture.live.has(standalone.id), true);
		assert.deepEqual(fixture.sessionStore.get(owned.id), ownedEvidence, "the complete persisted evidence row remains unchanged");
		assert.equal(fixture.sessionStore.get(standalone.id).archived, false);
		assert.ok(teamStore.get(archivedGoal.id), "TeamStore remains retry evidence");
		assert.equal(archivedGoal.team, false, "failed strict publication rolls back marker promotion");

		markerAvailable = true;
		const recovered = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });
		assert.equal(recovered.status, "complete");
		assert.equal(archivedGoal.team, true, "recovery publishes the sticky team marker first");
		assert.equal(fixture.sessionStore.get(owned.id).archived, true);
		assert.equal(fixture.sessionStore.get(standalone.id).archived, false);
		assert.equal(teamStore.get(archivedGoal.id), undefined);
		assert.deepEqual(fixture.markerCalls, [archivedGoal.id, archivedGoal.id]);
	});

	it("does not promote or quiesce a goalId-only standalone session", async () => {
		const archivedGoal = goal("goal-marker-standalone-control");
		const standalone = session("marker-standalone-only", { goalId: archivedGoal.id });
		const fixture = makeFixture({ goals: [archivedGoal], sessions: [standalone] });
		await fixture.manager.waitForRestore();

		const result = await fixture.manager.reconcileArchivedGoal(archivedGoal.id, { audit: false });

		assert.equal(result.status, "complete");
		assert.deepEqual(fixture.markerCalls, []);
		assert.deepEqual(fixture.quiesceCalls, []);
		assert.deepEqual(fixture.terminateCalls, []);
		assert.equal(archivedGoal.team, false);
		assert.equal(fixture.sessionStore.get(standalone.id).archived, false);
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
		fixture.sessionManager.createSession = vi.fn(async (cwd: string, _args: unknown, goalId: string, _assistant: unknown, createOpts: Record<string, unknown>) => {
			fixture.createCalls.push(goalId);
			signalCreateEntered();
			await createReleased;
			const row = session("racing-team-lead", { cwd, goalId, ...createOpts });
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
		assert.equal(
			fixture.sessionStore.get("racing-team-lead").teamGoalId,
			racingGoal.id,
			"lead ownership is present in the initial durable row before TeamStore publication",
		);
		assert.deepEqual(result.archivedSessionIds, ["racing-team-lead"]);
		assert.equal(fixture.sessionStore.get("racing-team-lead").archived, true, "work admitted before closure is included");
		await assert.rejects(
			() => fixture.manager.startTeam(racingGoal.id),
			(error: unknown) => error instanceof TeamStartError && error.code === "GOAL_ARCHIVED",
		);
		assert.equal(fixture.createCalls.length, 1, "post-terminal admission creates no session");
	});

	it("holds team admission through delayed full sub-branch setup before archival", async () => {
		const racingGoal = goal("goal-full-child-race", false);
		const owner = session("team-owner", { teamGoalId: racingGoal.id, role: "team-lead" });
		const fixture = makeFixture({ goals: [racingGoal], sessions: [owner] });
		await fixture.manager.waitForRestore();

		let releaseSetup!: () => void;
		const setupReleased = new Promise<void>((resolve) => { releaseSetup = resolve; });
		let signalSetupEntered!: () => void;
		const setupEntered = new Promise<void>((resolve) => { signalSetupEntered = resolve; });
		let bridgeStarts = 0;
		let capturedCreateOpts: Record<string, unknown> | undefined;
		fixture.sessionManager.createSession = vi.fn(async (cwd: string, _args: unknown, goalId: string | undefined, _assistant: unknown, createOpts: Record<string, unknown>) => {
			capturedCreateOpts = createOpts;
			fixture.createCalls.push("full-sub-branch-child");
			const row = session("full-sub-branch-child", { cwd, goalId, ...createOpts });
			fixture.sessionStore.put(row);
			const active = { ...row, status: "preparing", clients: new Set(), rpcClient: { onEvent: vi.fn(() => () => {}) } };
			fixture.live.set(row.id, active);
			const detachedSetup = (async () => {
				signalSetupEntered();
				await setupReleased;
				bridgeStarts++;
				active.status = "idle";
			})();
			if (createOpts.awaitWorktreeSetup === true) await detachedSetup;
			return active;
		});
		const core = new OrchestrationCore({
			sessionManager: fixture.sessionManager,
			resolveSessionModel: () => undefined,
		});

		const spawning = core.spawn({
			ownerSessionId: owner.id,
			instructions: "team child",
			lifecycle: "full",
			worktree: {
				mode: "sub-branch",
				repoPath: path.resolve("/pure/repo"),
				goalId: "child-goal",
				branch: "goal/child/helper",
				cwd: path.resolve("/pure/repo"),
			},
		});
		await setupEntered;
		assert.equal(capturedCreateOpts?.awaitWorktreeSetup, true, "canonical team ownership keeps setup inside admission");
		assert.equal(fixture.sessionStore.get("full-sub-branch-child").teamGoalId, racingGoal.id, "the preparing row is durably owned before setup");

		racingGoal.archived = true;
		let reconciliationSettled = false;
		const reconciling = fixture.manager.reconcileArchivedGoal(racingGoal.id, { audit: false });
		void reconciling.then(() => { reconciliationSettled = true; }, () => { reconciliationSettled = true; });
		await Promise.resolve();
		assert.equal(reconciliationSettled, false, "archive queues behind the admitted setup");
		assert.deepEqual(fixture.terminateCalls, [], "the preparing placeholder is not removed while setup can still publish a process");

		releaseSetup();
		const child = await spawning;
		const result = await reconciling;

		assert.equal(bridgeStarts, 1, "setup starts the process before reconciliation acquires admission");
		assert.equal(fixture.sessionStore.get(child.sessionId).archived, true, "reconciliation archives the actual child after setup");
		assert.equal(fixture.live.has(child.sessionId), false, "the reconciled process is stopped");
		assert.ok(result.archivedSessionIds.includes(child.sessionId));
		await Promise.resolve();
		assert.equal(bridgeStarts, 1, "no detached setup starts another process after reconciliation");
		await assert.rejects(
			() => core.spawn({ ownerSessionId: owner.id, instructions: "too late", lifecycle: "full" }),
			(error: unknown) => error instanceof TeamStartError && error.code === "GOAL_ARCHIVED",
		);
		assert.equal(fixture.createCalls.length, 1, "post-terminal full spawn creates no row or process");
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
