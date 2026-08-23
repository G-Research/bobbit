import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, vi } from "vitest";
import { trustedAgentSessionsRoots } from "../../src/server/agent/agent-session-path.ts";
import { sidecarPathFor, type SessionSidecar } from "../../src/server/agent/session-sidecar.ts";
import { TeamManager, type TeamRecoverySidecars } from "../../src/server/agent/team-manager.ts";
import type { TeamRecoveryCheckpointStore } from "../../src/server/agent/team-recovery-checkpoint.ts";
import { slugDirNameForCwd } from "../../src/server/agent/team-store-consistency.ts";
import { TeamRecoveryFsFake, microtaskTurns, sessionHeader } from "./team-recovery-test-fake.ts";

interface MemoryTeamEntry {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: any[];
	maxConcurrent: number;
}

class MemoryStore<T extends { id: string }> {
	readonly records = new Map<string, T>();
	readonly puts: string[] = [];
	readonly updates: string[] = [];

	constructor(initial: readonly T[] = []) {
		for (const record of initial) this.records.set(record.id, { ...record });
	}

	get(id: string): T | undefined { return this.records.get(id); }
	getAll(): T[] { return [...this.records.values()]; }
	put(record: T): void {
		this.records.set(record.id, { ...record });
		this.puts.push(record.id);
	}
	update(id: string, patch: Partial<T>): void {
		const current = this.records.get(id);
		if (!current) throw new Error(`missing record: ${id}`);
		this.records.set(id, { ...current, ...patch });
		this.updates.push(id);
	}
	async flush(): Promise<void> {}
}

class MemorySessionStore extends MemoryStore<any> {
	flushCalls = 0;
	flushError: Error | undefined;

	async flushAsync(): Promise<void> {
		this.flushCalls++;
		if (this.flushError) throw this.flushError;
	}

	flush(): Promise<void> { return this.flushAsync(); }
}

class MemoryTeamStore {
	readonly records = new Map<string, MemoryTeamEntry>();
	readonly mutations: string[] = [];

	constructor(initial: readonly MemoryTeamEntry[]) {
		for (const record of initial) this.records.set(record.goalId, structuredClone(record));
	}

	get(goalId: string): MemoryTeamEntry | undefined { return this.records.get(goalId); }
	getAll(): MemoryTeamEntry[] { return [...this.records.values()]; }
	put(record: MemoryTeamEntry): void {
		this.records.set(record.goalId, structuredClone(record));
		this.mutations.push(`put:${record.goalId}`);
	}
	remove(goalId: string): void {
		this.records.delete(goalId);
		this.mutations.push(`remove:${goalId}`);
	}
}

class MemoryRecoveryCheckpoints implements TeamRecoveryCheckpointStore {
	readonly statuses = new Map<string, "running" | "complete">();
	readonly completionPending = new Set<string>();
	readonly calls: string[] = [];
	failBegin = false;
	failCompleteAfterPublication = false;
	failFenceClearAcknowledgement = false;

	async isComplete(stateDir: string): Promise<boolean> {
		this.calls.push(`isComplete:${stateDir}`);
		return this.statuses.get(stateDir) === "complete" && !this.completionPending.has(stateDir);
	}
	async begin(stateDir: string): Promise<void> {
		this.calls.push(`begin:${stateDir}`);
		if (this.failBegin) throw new Error("INJECTED_CHECKPOINT_BEGIN_FAILURE");
		this.statuses.set(stateDir, "running");
	}
	async complete(stateDir: string): Promise<void> {
		this.calls.push(`complete:${stateDir}`);
		this.completionPending.add(stateDir);
		this.statuses.set(stateDir, "complete");
		if (this.failCompleteAfterPublication) throw new Error("INJECTED_POST_RENAME_DIRECTORY_FSYNC_EIO");
		this.completionPending.delete(stateDir);
		if (this.failFenceClearAcknowledgement) {
			this.completionPending.add(stateDir);
			throw new Error("INJECTED_FENCE_CLEAR_DIRECTORY_FSYNC_EIO");
		}
	}
}

class MemoryRecoverySidecars implements TeamRecoverySidecars {
	readonly values = new Map<string, SessionSidecar>();
	readonly existing = new Set<string>();
	readonly reads: string[] = [];
	readonly writes: string[] = [];

	async exists(filePath: string): Promise<boolean> { return this.existing.has(filePath); }
	async read(jsonlPath: string): Promise<SessionSidecar | null> {
		this.reads.push(jsonlPath);
		return this.values.get(jsonlPath) ?? null;
	}
	async write(jsonlPath: string): Promise<void> { this.writes.push(jsonlPath); }
}

const noTimerClock = {
	now: () => Date.parse("2025-01-01T00:00:00.000Z"),
	setTimeout: (() => ({ unref() {} })) as any,
	clearTimeout: (() => {}) as any,
	setInterval: (() => ({ unref() {} })) as any,
	clearInterval: (() => {}) as any,
};

function sidecar(id: string, agentSessionId: string, role: string, title: string, goalId: string, leadId?: string): SessionSidecar {
	return {
		version: 1,
		bobbitSessionId: id,
		agentSessionId,
		role,
		teamGoalId: goalId,
		teamLeadSessionId: leadId,
		title,
		createdAt: Date.parse("2023-03-04T05:06:07.000Z"),
		modelProvider: "exact-provider",
		modelId: "exact-model",
	};
}

function seedTranscript(
	fs: TeamRecoveryFsFake,
	root: string,
	cwd: string,
	name: string,
	agentSessionId: string,
	mtime: string,
	size: number,
): string {
	const directory = path.join(root, slugDirNameForCwd(cwd));
	const current = fs.directories.get(directory) ?? [];
	fs.dir(directory, [...current, name]);
	const transcript = path.join(directory, name);
	fs.file(transcript, sessionHeader(cwd, agentSessionId, "2022-02-03T04:05:06.000Z"), { mtime: new Date(mtime), size });
	return transcript;
}

function makeFixture(options: { deferFirstScan?: boolean; completedCheckpoint?: boolean } = {}) {
	const roots = trustedAgentSessionsRoots();
	assert.ok(roots.length > 0);
	const firstRoot = roots[0]!;
	const fs = new TeamRecoveryFsFake();
	const sidecars = new MemoryRecoverySidecars();
	const checkpoints = new MemoryRecoveryCheckpoints();
	const stateDir = "/project-state";
	if (options.completedCheckpoint) checkpoints.statuses.set(stateDir, "complete");

	const goalPass2 = {
		id: "goal-pass2",
		title: "Dangling team entry",
		projectId: "project-1",
		team: true,
		worktreePath: "/worktrees/goal-pass2",
		repoPath: "/repo",
		branch: "goal/pass2",
		archived: false,
	};
	const goalPass2Failure = {
		id: "goal-pass2-failure",
		title: "Unreadable sibling",
		projectId: "project-1",
		team: true,
		worktreePath: "/worktrees/goal-pass2-failure",
		archived: false,
	};
	const goalPass3 = {
		id: "goal-pass3",
		title: "Fully orphaned goal",
		projectId: "project-1",
		team: true,
		worktreePath: "/worktrees/goal-pass3",
		repoPath: "/repo",
		branch: "goal/pass3",
		archived: true,
	};
	const goalUntracked = {
		id: "goal-untracked",
		title: "Current-master untracked lead",
		projectId: "project-1",
		team: true,
		worktreePath: "/worktrees/goal-untracked",
		archived: false,
	};
	const goals = new MemoryStore<any>([goalPass2, goalPass2Failure, goalPass3, goalUntracked]);
	const teams = new MemoryTeamStore([
		{ goalId: goalPass2.id, teamLeadSessionId: "lead-pass2", agents: [], maxConcurrent: 4 },
		{ goalId: goalPass2Failure.id, teamLeadSessionId: "lead-failure", agents: [], maxConcurrent: 2 },
	]);
	const sessions = new MemorySessionStore([{
		id: "existing-untracked-lead",
		title: "Team Lead: Existing",
		cwd: goalUntracked.worktreePath,
		createdAt: 1,
		lastActivity: 1,
		role: "team-lead",
		teamGoalId: goalUntracked.id,
		archived: false,
	}]);

	const pass2Older = seedTranscript(fs, firstRoot, goalPass2.worktreePath, "older.jsonl", "pi-pass2-old", "2024-01-01T00:00:00.000Z", 999);
	const pass2Canonical = seedTranscript(fs, firstRoot, goalPass2.worktreePath, "canonical.jsonl", "pi-pass2", "2024-02-01T00:00:00.000Z", 100);
	const pass3Canonical = seedTranscript(fs, firstRoot, goalPass3.worktreePath, "lead.jsonl", "pi-pass3", "2024-03-01T00:00:00.000Z", 200);
	assert.notEqual(pass2Older, pass2Canonical);

	const agentCwd = "/worktrees/goal-goal-pass2-coder-deadbeef";
	const agentSlug = slugDirNameForCwd(agentCwd);
	const unreadableAgentCwd = "/worktrees/goal-goal-pass2-reviewer-bad0cafe";
	const unreadableAgentSlug = slugDirNameForCwd(unreadableAgentCwd);
	fs.dir(firstRoot, [unreadableAgentSlug, agentSlug]);
	const agentTranscript = seedTranscript(fs, firstRoot, agentCwd, "worker.jsonl", "pi-worker", "2024-04-01T00:00:00.000Z", 300);
	// The unreadable matching agent directory is deliberately absent.

	for (const root of roots.slice(1)) fs.dir(root, []);
	if (options.deferFirstScan) {
		fs.defer("readdir", path.join(firstRoot, slugDirNameForCwd(goalPass2.worktreePath)));
	}

	sidecars.values.set(pass2Canonical, sidecar("lead-pass2", "pi-pass2", "team-lead", "Team Lead: Exact Pass Two", goalPass2.id));
	sidecars.values.set(pass3Canonical, sidecar("lead-pass3-exact", "pi-pass3", "team-lead", "Team Lead: Exact Pass Three", goalPass3.id));
	sidecars.values.set(agentTranscript, sidecar("worker-exact", "pi-worker", "coder", "Coder: Exact Worker", goalPass2.id, "lead-pass2"));
	for (const transcript of [pass2Canonical, pass3Canonical, agentTranscript]) sidecars.existing.add(sidecarPathFor(transcript));

	const context = {
		stateDir,
		goalStore: goals,
		teamStore: teams,
		sessionStore: sessions,
	};
	const projectContextManager = {
		all: () => [context],
		getContextForGoal: (goalId: string) => goals.get(goalId) ? context : undefined,
	};
	const sessionManager = {
		getSession: () => undefined,
		getSessionInfo: () => undefined,
	};
	const managerConfig = {
		projectContextManager,
		taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] },
		colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
		recoveryFs: fs,
		recoverySidecars: sidecars,
		recoveryCheckpoints: checkpoints,
	};
	const manager = new TeamManager(sessionManager as any, managerConfig as any, undefined, noTimerClock as any);

	return {
		manager,
		managerConfig,
		sessionManager,
		fs,
		sidecars,
		checkpoints,
		stateDir,
		sessions,
		teams,
		roots,
		goalPass2,
		goalPass2Failure,
		goalPass3,
		goalUntracked,
		pass2Canonical,
		pass3Canonical,
		agentTranscript,
	};
}

async function makeAdoptedAdmissionFixture(options: { durablePromptIntents?: Set<string> } = {}) {
	const ownerSessionId = "regular-owner";
	const projectId = "project-admission";
	const goal = {
		id: "goal-admission",
		title: "Adopted admission goal",
		projectId,
		state: "todo",
		team: true,
		cwd: "/worktrees/session-owner",
		archived: false,
		paused: false,
		setupStatus: "ready",
		worktreeOwnerSessionId: ownerSessionId,
	};
	let subscriptionCount = 0;
	let unsubscribeCount = 0;
	let activeSubscriptions = 0;
	const promptCalls: Array<{
		sessionId: string;
		text: string;
		opts: Record<string, unknown> | undefined;
		goalState: string | undefined;
		liveRole: string | undefined;
		durableRole: string | undefined;
		teamLeadSessionId: string | null | undefined;
	}> = [];
	const durablePromptIntents = options.durablePromptIntents ?? new Set<string>();
	const promptOccurrences: Array<{ sessionId: string; text: string; intentId: string }> = [];
	let failNextTransition = false;
	let pauseDuringNextTransition = false;
	const source = {
		id: ownerSessionId,
		title: "Regular session",
		projectId,
		cwd: goal.cwd,
		status: "idle",
		role: "general",
		rpcClient: {
			onEvent: () => {
				subscriptionCount += 1;
				activeSubscriptions += 1;
				let active = true;
				return () => {
					if (!active) return;
					active = false;
					unsubscribeCount += 1;
					activeSubscriptions -= 1;
				};
			},
		},
		createdAt: 1,
		lastActivity: 1,
	};
	const goals = new MemoryStore<any>();
	const sessions = new MemoryStore<any>();
	const teams = new MemoryTeamStore([]);
	const liveSessions = new Map<string, any>();
	let workerSequence = 0;
	const goalManager = {
		updateGoal: async (goalId: string, patch: any) => {
			if (failNextTransition) {
				failNextTransition = false;
				throw new Error("injected transition failure");
			}
			goals.update(goalId, patch);
			if (pauseDuringNextTransition) {
				pauseDuringNextTransition = false;
				goals.update(goalId, { paused: true });
			}
			return goals.get(goalId);
		},
	};
	const gateStore = {
		initGatesForGoal: () => {},
		removeGoalGates: () => {},
		flush: async () => {},
	};
	const context = {
		project: { id: projectId },
		goalStore: goals,
		goalManager,
		teamStore: teams,
		sessionStore: sessions,
		gateStore,
	};
	const projectContextManager = {
		all: () => [context],
		getContextForGoal: (goalId: string) => goals.get(goalId) ? context : undefined,
	};
	const sessionManager = {
		getSession: (id: string) => liveSessions.get(id),
		getSessionInfo: (id: string) => liveSessions.get(id),
		getPersistedSession: (id: string) => sessions.get(id),
		createSession: async (cwd: string, _args?: string[], goalId?: string) => {
			const id = `worker-${++workerSequence}`;
			const worker = {
				id,
				title: "Worker",
				cwd,
				status: "idle",
				goalId,
				titleGenerated: false,
				rpcClient: { onEvent: () => () => {}, prompt: async () => {} },
				clients: new Set(),
				createdAt: 2,
				lastActivity: 2,
			};
			liveSessions.set(id, worker);
			sessions.put(worker);
			return worker;
		},
		setTitle: (id: string, title: string) => {
			const live = liveSessions.get(id);
			if (live) live.title = title;
			return !!live;
		},
		updateSessionMeta: (id: string, patch: any) => {
			const live = liveSessions.get(id);
			if (live) Object.assign(live, patch);
			if (sessions.get(id)) sessions.update(id, patch);
			return !!live;
		},
		resolveSessionAgentAuthor: () => undefined,
		enqueuePrompt: async (sessionId: string, text: string, opts?: Record<string, unknown>) => {
			promptCalls.push({
				sessionId,
				text,
				opts,
				goalState: goals.get(goal.id)?.state,
				liveRole: liveSessions.get(sessionId)?.role,
				durableRole: sessions.get(sessionId)?.role,
				teamLeadSessionId: teams.get(goal.id)?.teamLeadSessionId,
			});
			const intentId = typeof opts?.intentId === "string" ? opts.intentId : `unstable:${promptCalls.length}`;
			if (!durablePromptIntents.has(intentId)) {
				durablePromptIntents.add(intentId);
				promptOccurrences.push({ sessionId, text, intentId });
			}
			return { status: "dispatched" };
		},
		isSubgoalsEnabled: false,
		isSandboxEnabled: false,
		getSandboxManager: () => undefined,
		dispatchGoalProvisionedForWorktree: async () => {},
	};
	const recoveryFs = new TeamRecoveryFsFake();
	for (const root of trustedAgentSessionsRoots()) recoveryFs.dir(root, []);
	const roles = [{
		name: "team-lead",
		label: "Team Lead",
		promptTemplate: "Lead the goal",
		accessory: "lead-crown",
		createdAt: 0,
		updatedAt: 0,
	}, {
		name: "coder",
		label: "Coder",
		promptTemplate: "Implement the task",
		accessory: "headphones",
		createdAt: 0,
		updatedAt: 0,
	}];
	const managerConfig = {
		projectContextManager,
		roleStore: { get: (name: string) => roles.find(role => role.name === name), getAll: () => roles },
		taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] },
		colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
		recoveryFs,
		recoverySidecars: new MemoryRecoverySidecars(),
	};
	const manager = new TeamManager(sessionManager as any, managerConfig as any, undefined, noTimerClock as any);
	await manager.waitForRestore();

	goals.put(goal);
	sessions.put(source);
	liveSessions.set(source.id, { ...source });
	await manager.adoptExistingLead(goal.id, source.id);

	return {
		manager,
		managerConfig,
		sessionManager,
		goal,
		source,
		goals,
		sessions,
		teams,
		liveSessions,
		failNextTransition: () => { failNextTransition = true; },
		pauseDuringNextTransition: () => { pauseDuringNextTransition = true; },
		get workerCount() { return workerSequence; },
		get subscriptionCount() { return subscriptionCount; },
		get unsubscribeCount() { return unsubscribeCount; },
		get activeSubscriptions() { return activeSubscriptions; },
		simulateProcessRestart: () => { activeSubscriptions = 0; },
		promptCalls,
		promptOccurrences,
		durablePromptIntents,
	};
}

function makeAdoptedGoalRestartFixture(options: { reservation: boolean; role: string }) {
	const ownerSessionId = "regular-owner";
	const projectId = "project-adopted";
	const goal = {
		id: "goal-adopted",
		title: "Adopted goal",
		projectId,
		state: "todo",
		team: true,
		cwd: "/worktrees/session-owner",
		worktreePath: "/worktrees/session-owner",
		repoPath: "/repo",
		branch: "session/owner",
		repoWorktrees: { app: "/worktrees/session-owner/app" },
		sandboxed: true,
		archived: false,
		worktreeOwnerSessionId: ownerSessionId,
		workflow: { gates: [{ id: "design-doc" }] },
	};
	const source = {
		id: ownerSessionId,
		title: "Regular session",
		projectId,
		cwd: goal.cwd,
		worktreePath: goal.worktreePath,
		repoPath: goal.repoPath,
		branch: goal.branch,
		repoWorktrees: goal.repoWorktrees,
		sandboxed: goal.sandboxed,
		role: options.role,
		accessory: "regular-cap",
		createdAt: 1,
		lastActivity: 1,
	};
	const goals = new MemoryStore<any>([goal]);
	const sessions = new MemoryStore<any>([source]);
	const teams = new MemoryTeamStore(options.reservation ? [{
		goalId: goal.id,
		teamLeadSessionId: ownerSessionId,
		agents: [],
		maxConcurrent: 12,
	}] : []);
	const initializedGates: string[] = [];
	const gateStore = {
		initGatesForGoal: (goalId: string) => { initializedGates.push(goalId); },
		removeGoalGates: () => {},
		flush: async () => {},
	};
	const deletedAttempts: string[] = [];
	const context = {
		project: { id: projectId },
		goalStore: goals,
		teamStore: teams,
		sessionStore: sessions,
		gateStore,
		goalManager: {
			deleteAdoptedGoalAttempt: async (goalId: string) => {
				deletedAttempts.push(goalId);
				return false;
			},
			updateGoal: async (goalId: string, patch: any) => {
				goals.update(goalId, patch);
				return goals.get(goalId);
			},
		},
	};
	const projectContextManager = {
		all: () => [context],
		getContextForGoal: (goalId: string) => goals.get(goalId) ? context : undefined,
	};
	const recoveryFs = new TeamRecoveryFsFake();
	for (const root of trustedAgentSessionsRoots()) recoveryFs.dir(root, []);
	const sessionManager = {
		getSession: () => undefined,
		getSessionInfo: () => undefined,
	};
	const role = {
		name: "team-lead",
		label: "Team Lead",
		promptTemplate: "Lead the goal",
		accessory: "lead-crown",
		createdAt: 0,
		updatedAt: 0,
	};
	const manager = new TeamManager(sessionManager as any, {
		projectContextManager,
		roleStore: { get: (name: string) => name === role.name ? role : undefined, getAll: () => [role] },
		taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] },
		colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
		recoveryFs,
		recoverySidecars: new MemoryRecoverySidecars(),
	} as any, undefined, noTimerClock as any);

	return { manager, goal, source, goals, sessions, teams, initializedGates, deletedAttempts };
}

describe("TeamManager adopted-lead worker admission", () => {
	it("rejects a worker in the pending window after reservation and releases the untouched reservation", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			await assert.rejects(
				() => fixture.manager.spawnRole(fixture.goal.id, "coder", "must not start yet"),
				(error: any) => error?.code === "ADOPTED_LEAD_ATTACHMENT_PENDING",
			);
			assert.equal(fixture.workerCount, 0);
			assert.deepEqual(fixture.manager.getTeamState(fixture.goal.id)?.agents, []);
			assert.equal(await fixture.manager.releaseAdoptedLead(fixture.goal.id, fixture.source.id), true);
			assert.equal(fixture.manager.getTeamState(fixture.goal.id), undefined);
		} finally {
			fixture.manager.dispose();
		}
	});

	it("allows workers only after both the live and durable source carry the exact committed attachment", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			const attachment = { goalId: fixture.goal.id, teamGoalId: fixture.goal.id, role: "team-lead" };
			Object.assign(fixture.liveSessions.get(fixture.source.id), attachment);
			fixture.sessions.update(fixture.source.id, attachment);

			const worker = await fixture.manager.spawnRole(fixture.goal.id, "coder", "start after commit");
			assert.equal(worker.sessionId, "worker-1");
			assert.equal(fixture.manager.getTeamState(fixture.goal.id)?.agents.length, 1);
		} finally {
			fixture.manager.dispose();
		}
	});

	it("keeps ordinary team worker admission unchanged", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			const ordinaryGoal = { ...fixture.goal, id: "goal-ordinary", title: "Ordinary goal", worktreeOwnerSessionId: undefined };
			const ordinaryLead = {
				...fixture.source,
				id: "ordinary-lead",
				goalId: ordinaryGoal.id,
				teamGoalId: ordinaryGoal.id,
				role: "team-lead",
			};
			fixture.goals.put(ordinaryGoal);
			fixture.sessions.put(ordinaryLead);
			fixture.liveSessions.set(ordinaryLead.id, ordinaryLead);
			(fixture.manager as any).teams.set(ordinaryGoal.id, {
				goalId: ordinaryGoal.id,
				teamLeadSessionId: ordinaryLead.id,
				agents: [],
				maxConcurrent: 12,
			});
			(fixture.manager as any).sessionToGoal.set(ordinaryLead.id, ordinaryGoal.id);

			const worker = await fixture.manager.spawnRole(ordinaryGoal.id, "coder", "ordinary spawn");
			assert.equal(worker.sessionId, "worker-1");
			assert.equal(fixture.manager.getTeamState(ordinaryGoal.id)?.agents.length, 1);
		} finally {
			fixture.manager.dispose();
		}
	});

	it("fails closed on a partial identity change and refuses to release its reservation", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			Object.assign(fixture.liveSessions.get(fixture.source.id), {
				goalId: fixture.goal.id,
				teamGoalId: "different-goal",
				role: "team-lead",
			});
			fixture.sessions.update(fixture.source.id, { goalId: fixture.goal.id });

			await assert.rejects(
				() => fixture.manager.spawnRole(fixture.goal.id, "coder", "identity changed"),
				(error: any) => error?.code === "ADOPTED_LEAD_ATTACHMENT_PENDING",
			);
			assert.equal(await fixture.manager.releaseAdoptedLead(fixture.goal.id, fixture.source.id), false);
			assert.ok(fixture.manager.getTeamState(fixture.goal.id), "failed defense must retain the reservation");
			assert.equal(fixture.teams.get(fixture.goal.id)?.teamLeadSessionId, fixture.source.id);
		} finally {
			fixture.manager.dispose();
		}
	});
});

describe("TeamManager adopted-lead finalization", () => {
	const expectedKickoff = "You have been promoted to the team lead for the goal \"Adopted admission goal\".  Proceed to complete the goal, following the instructions in your system prompt carefully.";
	const committedAttachment = (fixture: Awaited<ReturnType<typeof makeAdoptedAdmissionFixture>>) => {
		const attachment = { goalId: fixture.goal.id, teamGoalId: fixture.goal.id, role: "team-lead" };
		Object.assign(fixture.liveSessions.get(fixture.source.id), attachment);
		fixture.sessions.update(fixture.source.id, attachment);
	};
	const assertPromotionKickoff = (
		fixture: Awaited<ReturnType<typeof makeAdoptedAdmissionFixture>>,
		expectedColdStart: true | undefined,
	) => {
		assert.equal(fixture.promptOccurrences.length, 1, "promotion must admit one durable kickoff occurrence");
		assert.deepEqual(fixture.promptOccurrences[0], {
			sessionId: fixture.source.id,
			text: expectedKickoff,
			intentId: fixture.promptOccurrences[0]?.intentId,
		});
		assert.ok(fixture.promptOccurrences[0]?.intentId, "promotion kickoff must have a stable durable intent id");
		for (const call of fixture.promptCalls) {
			assert.equal(call.sessionId, fixture.source.id);
			assert.equal(call.text, expectedKickoff);
			assert.equal(call.opts?.source, "system");
			assert.equal(call.opts?.suppressTitleGen, true);
			assert.equal(
				call.opts?.coldStart,
				expectedColdStart,
				expectedColdStart
					? "boot recovery must wait for the restored agent before delivering the kickoff"
					: "fresh promotion must keep the ordinary warm-session kickoff path",
			);
			assert.equal(call.opts?.intentId, fixture.promptOccurrences[0]?.intentId, "retries must reuse the kickoff occurrence id");
			assert.equal(call.goalState, "in-progress", "kickoff dispatch must follow the goal transition");
			assert.equal(call.liveRole, "team-lead", "kickoff dispatch must see the canonical promoted runtime");
			assert.equal(call.durableRole, "team-lead", "kickoff dispatch must follow durable role publication");
			assert.equal(call.teamLeadSessionId, fixture.source.id, "kickoff dispatch must follow team reservation finalization");
		}
	};

	it("dispatches the exact system kickoff only after the promoted lead and goal are finalized", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			committedAttachment(fixture);

			const finalized = await fixture.manager.finalizeAdoptedLead(fixture.goal.id);
			assert.equal(finalized.teamLeadSessionId, fixture.source.id);
			assert.equal(fixture.goals.get(fixture.goal.id)?.state, "in-progress");
			assert.equal(fixture.subscriptionCount, 1);
			assert.equal(fixture.activeSubscriptions, 1);
			assert.equal(fixture.workerCount, 0);
			assertPromotionKickoff(fixture, undefined);
		} finally {
			fixture.manager.dispose();
		}
	});

	for (const scenario of [
		{ name: "paused", patch: { paused: true }, code: "GOAL_PAUSED" },
		{ name: "complete", patch: { state: "complete" }, code: "GOAL_COMPLETE" },
		{ name: "shelved", patch: { state: "shelved" }, code: "GOAL_SHELVED" },
		{ name: "blocked", patch: { state: "blocked" }, code: "GOAL_BLOCKED" },
		{ name: "setup-not-ready", patch: { setupStatus: "preparing" }, code: "GOAL_SETUP_INCOMPLETE" },
	] as const) {
		it(`rejects ${scenario.name} goals before subscribing or admitting a kickoff`, async () => {
			const fixture = await makeAdoptedAdmissionFixture();
			try {
				committedAttachment(fixture);
				fixture.goals.update(fixture.goal.id, scenario.patch);

				await assert.rejects(
					() => fixture.manager.finalizeAdoptedLead(fixture.goal.id),
					(error: any) => error?.code === scenario.code && error?.status === 409,
				);
				assert.equal(fixture.subscriptionCount, 0);
				assert.equal(fixture.activeSubscriptions, 0);
				assert.equal(fixture.promptCalls.length, 0);
				assert.equal(fixture.promptOccurrences.length, 0);
			} finally {
				fixture.manager.dispose();
			}
		});
	}

	it("revalidates a todo goal after activation and lets a concurrent pause prevent kickoff", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			committedAttachment(fixture);
			fixture.pauseDuringNextTransition();

			await assert.rejects(
				() => fixture.manager.finalizeAdoptedLead(fixture.goal.id),
				(error: any) => error?.code === "GOAL_PAUSED" && error?.status === 409,
			);
			assert.equal(fixture.goals.get(fixture.goal.id)?.state, "in-progress");
			assert.equal(fixture.goals.get(fixture.goal.id)?.paused, true);
			assert.equal(fixture.activeSubscriptions, 0);
			assert.equal((fixture.manager as any).idleNudgeTimers.size, 0);
			assert.equal((fixture.manager as any).noWorkersNudgeTimers.size, 0);
			assert.equal(fixture.promptCalls.length, 0);
			assert.equal(fixture.promptOccurrences.length, 0);
		} finally {
			fixture.manager.dispose();
		}
	});

	it("keeps one stable kickoff occurrence across concurrent and exact finalization retries", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			committedAttachment(fixture);

			const results = await Promise.all([
				fixture.manager.finalizeAdoptedLead(fixture.goal.id),
				fixture.manager.finalizeAdoptedLead(fixture.goal.id),
				fixture.manager.finalizeAdoptedLead(fixture.goal.id),
			]);
			assert.ok(results.every(result => result.teamLeadSessionId === fixture.source.id));
			assert.equal(fixture.goals.updates.length, 1, "in-progress transition is idempotent");
			assert.equal(fixture.activeSubscriptions, 1, "retry replaces rather than duplicates the lead listener");
			assertPromotionKickoff(fixture, undefined);
		} finally {
			fixture.manager.dispose();
		}
	});

	it("does not admit a kickoff when the todo transition fails, then admits one on retry", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			committedAttachment(fixture);
			fixture.failNextTransition();

			await assert.rejects(
				() => fixture.manager.finalizeAdoptedLead(fixture.goal.id),
				/injected transition failure/,
			);
			assert.equal(fixture.goals.get(fixture.goal.id)?.state, "todo");
			assert.equal(fixture.activeSubscriptions, 0);
			assert.equal(fixture.promptCalls.length, 0, "a failed pre-kickoff transition must not enqueue work");
			assert.equal(fixture.promptOccurrences.length, 0);

			await fixture.manager.finalizeAdoptedLead(fixture.goal.id);
			assert.equal(fixture.goals.get(fixture.goal.id)?.state, "in-progress");
			assert.equal(fixture.activeSubscriptions, 1);
			assert.equal(fixture.workerCount, 0);
			assertPromotionKickoff(fixture, undefined);
		} finally {
			fixture.manager.dispose();
		}
	});

	it("restores the ordinary listener and idle timers when boot finalization fails before subscription", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		let restored: TeamManager | undefined;
		try {
			committedAttachment(fixture);
			fixture.manager.dispose();
			fixture.simulateProcessRestart();

			restored = new TeamManager(
				fixture.sessionManager as any,
				fixture.managerConfig as any,
				undefined,
				noTimerClock as any,
			);
			await restored.waitForRestore();
			(restored as any).finalizeAdoptedLead = async () => {
				throw new Error("injected pre-subscription finalization failure");
			};
			await restored.resubscribeTeamEvents();

			assert.equal(fixture.goals.get(fixture.goal.id)?.state, "in-progress", "the restored adopted goal remains runnable");
			assert.equal(fixture.subscriptionCount, 1, "ordinary boot recovery must install the missing lead listener");
			assert.equal(fixture.activeSubscriptions, 1, "the fallback must leave exactly one active listener");
			assert.equal((restored as any).noWorkersNudgeTimers.size, 1, "the idle no-workers watchdog must be restored");
			assert.equal((restored as any).idleNudgeTimers.size, 1, "the idle workers watchdog must be restored");
			assert.equal(fixture.promptCalls.length, 0, "failed finalization must not admit a promotion kickoff");
			assert.equal(fixture.promptOccurrences.length, 0);
		} finally {
			restored?.dispose();
			fixture.manager.dispose();
		}
	});

	it("cold-delivers one kickoff occurrence through manager restart recovery", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		let restored: TeamManager | undefined;
		let retry: TeamManager | undefined;
		try {
			committedAttachment(fixture);
			assert.equal(fixture.promptOccurrences.length, 0, "the process crashes after canonical commit but before kickoff admission");
			assert.equal(fixture.activeSubscriptions, 0, "the crashed process must not leave a synthetic subscription behind");
			fixture.manager.dispose();

			restored = new TeamManager(
				fixture.sessionManager as any,
				fixture.managerConfig as any,
				undefined,
				noTimerClock as any,
			);
			await restored.waitForRestore();
			assert.equal(fixture.promptCalls.length, 0, "team restore alone must not bypass session restoration and admit the kickoff");
			await restored.resubscribeTeamEvents();

			assertPromotionKickoff(fixture, true);
			assert.equal(fixture.promptCalls.length, 1, "boot recovery must send only the promotion kickoff, not a boot-resume nudge");
			assert.equal(fixture.activeSubscriptions, 1, "the recovered lead must keep exactly one active event subscription");
			assert.equal(fixture.subscriptionCount, 1);
			const durableIntentId = fixture.promptOccurrences[0]?.intentId;

			restored.dispose();
			restored = undefined;
			fixture.simulateProcessRestart();
			assert.equal(fixture.activeSubscriptions, 0, "a process restart must discard its runtime-only subscription");

			retry = new TeamManager(
				fixture.sessionManager as any,
				fixture.managerConfig as any,
				undefined,
				noTimerClock as any,
			);
			await retry.waitForRestore();
			await retry.resubscribeTeamEvents();

			assertPromotionKickoff(fixture, true);
			assert.equal(fixture.promptOccurrences.length, 1, "a durable occurrence must suppress admission and dispatch on the next boot");
			assert.equal(fixture.promptOccurrences[0]?.intentId, durableIntentId, "the retry must retain the stable occurrence identity");
			assert.equal(fixture.promptCalls.length, 2, "each boot may retry the same admission, but neither may add a boot-resume nudge");
			assert.equal(new Set(fixture.promptCalls.map(call => call.opts?.intentId)).size, 1);
			assert.equal(fixture.activeSubscriptions, 1, "the retry boot must still own only one active event subscription");
			assert.equal(fixture.subscriptionCount, 2, "each disposed boot installs one replacement subscription");
		} finally {
			restored?.dispose();
			retry?.dispose();
			fixture.manager.dispose();
		}
	});
});

describe("TeamManager adopted-goal archive admission", () => {
	for (const scenario of ["pending", "live-only", "durable-only", "partial", "identity-mismatch"] as const) {
		it(`rejects ${scenario} promotion state before running archive`, async () => {
			const fixture = await makeAdoptedAdmissionFixture();
			try {
				const exact = { goalId: fixture.goal.id, teamGoalId: fixture.goal.id, role: "team-lead" };
				if (scenario === "live-only") Object.assign(fixture.liveSessions.get(fixture.source.id), exact);
				if (scenario === "durable-only") fixture.sessions.update(fixture.source.id, exact);
				if (scenario === "partial") {
					Object.assign(fixture.liveSessions.get(fixture.source.id), { goalId: fixture.goal.id });
					fixture.sessions.update(fixture.source.id, { goalId: fixture.goal.id });
				}
				if (scenario === "identity-mismatch") {
					Object.assign(fixture.liveSessions.get(fixture.source.id), exact, { teamGoalId: "other-goal" });
					fixture.sessions.update(fixture.source.id, exact);
				}
				let archiveCalls = 0;
				await assert.rejects(
					() => fixture.manager.withAdoptedGoalArchiveAdmission(fixture.goal.id, async () => { archiveCalls += 1; }),
					(error: any) => error?.code === "PROMOTION_IN_PROGRESS" && error?.status === 409,
				);
				assert.equal(archiveCalls, 0);
				assert.equal(fixture.goals.get(fixture.goal.id)?.archived, false);
			} finally {
				fixture.manager.dispose();
			}
		});
	}

	it("admits an exact committed attachment and leaves ordinary goals unchanged", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			const exact = { goalId: fixture.goal.id, teamGoalId: fixture.goal.id, role: "team-lead" };
			Object.assign(fixture.liveSessions.get(fixture.source.id), exact);
			fixture.sessions.update(fixture.source.id, exact);
			const adoptedResult = await fixture.manager.withAdoptedGoalArchiveAdmission(
				fixture.goal.id,
				async () => "adopted-archive",
			);
			assert.equal(adoptedResult, "adopted-archive");

			const ordinaryGoal = { ...fixture.goal, id: "ordinary-goal", worktreeOwnerSessionId: undefined };
			fixture.goals.put(ordinaryGoal);
			const ordinaryResult = await fixture.manager.withAdoptedGoalArchiveAdmission(
				ordinaryGoal.id,
				async () => "ordinary-archive",
			);
			assert.equal(ordinaryResult, "ordinary-archive");
		} finally {
			fixture.manager.dispose();
		}
	});
});

describe("TeamManager adopted-goal restart reconciliation", () => {
	for (const reservation of [true, false]) {
		it(`repairs a baseline general session with ${reservation ? "an empty" : "no"} lead reservation`, async () => {
			const fixture = makeAdoptedGoalRestartFixture({ reservation, role: "general" });
			await fixture.manager.waitForRestore();

			assert.deepEqual(fixture.sessions.get(fixture.source.id), {
				...fixture.source,
				goalId: fixture.goal.id,
				teamGoalId: fixture.goal.id,
				role: "team-lead",
				accessory: "lead-crown",
			});
			assert.deepEqual(fixture.manager.getTeamState(fixture.goal.id), {
				goalId: fixture.goal.id,
				teamLeadSessionId: fixture.source.id,
				agents: [],
				maxConcurrent: 12,
			});
			assert.deepEqual(fixture.initializedGates, [fixture.goal.id]);
			assert.equal(fixture.sessions.records.size, 1);
			assert.equal(fixture.goals.get(fixture.goal.id)?.state, "in-progress");
			assert.deepEqual(fixture.deletedAttempts, []);
			assert.deepEqual(fixture.teams.mutations, reservation ? [] : [`put:${fixture.goal.id}`]);
			fixture.manager.dispose();
		});
	}

	it("leaves a non-general relation unchanged instead of attaching or compensating it", async () => {
		const fixture = makeAdoptedGoalRestartFixture({ reservation: true, role: "coder" });
		await fixture.manager.waitForRestore();

		assert.deepEqual(fixture.sessions.get(fixture.source.id), fixture.source);
		assert.deepEqual(fixture.sessions.updates, []);
		assert.deepEqual(fixture.initializedGates, []);
		assert.deepEqual(fixture.deletedAttempts, []);
		assert.equal(fixture.manager.getTeamState(fixture.goal.id)?.teamLeadSessionId, fixture.source.id);
		fixture.manager.dispose();
	});
});

describe("TeamManager awaited async recovery", () => {
	it("keeps restore pending and team indexes incomplete until deferred recovery I/O settles", async () => {
		const fixture = makeFixture({ deferFirstScan: true });
		let restoreSettled = false;
		const restore = fixture.manager.waitForRestore().then(() => { restoreSettled = true; });
		let schedulerProgress = false;
		queueMicrotask(() => { schedulerProgress = true; });

		await microtaskTurns(6);
		assert.equal(schedulerProgress, true);
		assert.equal(restoreSettled, false);
		assert.equal(fixture.manager.getTeamState(fixture.goalPass2.id), undefined, "partially restored team map must not be published");
		assert.equal((fixture.manager as any).sessionToGoal.has("lead-pass2"), false, "reverse lookup must not appear complete early");
		assert.equal(fixture.fs.pending.length, 1);

		fixture.fs.release();
		await restore;
		assert.ok(fixture.manager.getTeamState(fixture.goalPass2.id));
		assert.equal((fixture.manager as any).sessionToGoal.get("lead-pass2"), fixture.goalPass2.id);
		fixture.manager.dispose();
	});

	it("recovers the exact pass-2/pass-3/pass-5 set in deterministic order with canonical and sidecar precedence", async () => {
		const fixture = makeFixture();
		await fixture.manager.waitForRestore();

		assert.deepEqual(fixture.sessions.getAll().map((session) => session.id), [
			"existing-untracked-lead",
			"lead-pass2",
			"lead-pass3-exact",
			"worker-exact",
		]);
		assert.deepEqual(fixture.sessions.puts, ["lead-pass2", "lead-pass3-exact", "worker-exact"]);
		assert.deepEqual(
			fixture.sessions.getAll().slice(1).map((session) => ({
				id: session.id,
				title: session.title,
				role: session.role,
				teamGoalId: session.teamGoalId,
				teamLeadSessionId: session.teamLeadSessionId,
				agentSessionFile: session.agentSessionFile,
				modelProvider: session.modelProvider,
				modelId: session.modelId,
			})),
			[
				{ id: "lead-pass2", title: "Team Lead: Exact Pass Two", role: "team-lead", teamGoalId: "goal-pass2", teamLeadSessionId: undefined, agentSessionFile: fixture.pass2Canonical, modelProvider: "exact-provider", modelId: "exact-model" },
				{ id: "lead-pass3-exact", title: "Team Lead: Exact Pass Three", role: "team-lead", teamGoalId: "goal-pass3", teamLeadSessionId: undefined, agentSessionFile: fixture.pass3Canonical, modelProvider: "exact-provider", modelId: "exact-model" },
				{ id: "worker-exact", title: "Coder: Exact Worker", role: "coder", teamGoalId: "goal-pass2", teamLeadSessionId: "lead-pass2", agentSessionFile: fixture.agentTranscript, modelProvider: "exact-provider", modelId: "exact-model" },
			],
		);
		assert.equal(fixture.teams.get(fixture.goalPass2Failure.id), undefined, "unrecoverable sibling is dropped without aborting successful goals");
		assert.ok(fixture.teams.get(fixture.goalPass2.id));
		assert.equal(fixture.manager.getTeamState(fixture.goalUntracked.id), undefined, "current-master untracked-team adoption must not be introduced");
		assert.deepEqual(fixture.sidecars.reads, [fixture.pass2Canonical, fixture.pass3Canonical, fixture.agentTranscript]);
		assert.deepEqual(fixture.sidecars.writes, []);
		const pass2Slug = slugDirNameForCwd(fixture.goalPass2.worktreePath);
		assert.deepEqual(
			fixture.fs.calls
				.filter((call) => call.operation === "readdir" && call.path.endsWith(pass2Slug))
				.map((call) => call.path),
			fixture.roots.map((root) => path.join(root, pass2Slug)),
			"trusted roots must be scanned sequentially in authoritative order",
		);
		assert.equal(fixture.fs.count("readFile"), 0, "manager recovery must use bounded transcript headers and injected sidecars");
		fixture.manager.dispose();
	});

	it("checkpoints a completed forensic sweep and performs no transcript-tree I/O on the next clean boot", async () => {
		const fixture = makeFixture();
		await fixture.manager.waitForRestore();
		assert.equal(fixture.checkpoints.statuses.get(fixture.stateDir), "complete");
		assert.ok(fixture.fs.calls.some((call) => call.operation === "readdir"), "first boot must preserve historical recovery");
		fixture.manager.dispose();

		fixture.fs.calls.length = 0;
		const second = new TeamManager(
			fixture.sessionManager as any,
			fixture.managerConfig as any,
			undefined,
			noTimerClock as any,
		);
		await second.waitForRestore();

		assert.deepEqual(
			fixture.fs.calls.filter((call) => ["readdir", "stat", "open", "read"].includes(call.operation)),
			[],
			"a completed project must not revisit historical agent-session roots",
		);
		assert.deepEqual(fixture.checkpoints.calls.slice(-1), [`isComplete:${fixture.stateDir}`]);
		second.dispose();
	});

	it("retries forensic recovery after visible completion fails its durability acknowledgement", async () => {
		const fixture = makeFixture();
		fixture.checkpoints.failCompleteAfterPublication = true;
		await fixture.manager.waitForRestore();

		assert.equal(fixture.checkpoints.statuses.get(fixture.stateDir), "complete", "precondition: completion became visible before acknowledgement failed");
		assert.equal(fixture.checkpoints.completionPending.has(fixture.stateDir), true, "RECOVERY_COMPLETION_FENCE: the failed publication must retain retry authority");
		fixture.manager.dispose();

		fixture.checkpoints.failCompleteAfterPublication = false;
		fixture.fs.calls.length = 0;
		const retry = new TeamManager(fixture.sessionManager as any, fixture.managerConfig as any, undefined, noTimerClock as any);
		await retry.waitForRestore();

		assert.ok(fixture.fs.calls.some((call) => call.operation === "readdir"), "RECOVERY_COMPLETION_FENCE: the second boot must rerun forensic traversal");
		assert.equal(fixture.checkpoints.statuses.get(fixture.stateDir), "complete");
		assert.equal(fixture.checkpoints.completionPending.has(fixture.stateDir), false, "RECOVERY_COMPLETION_FENCE: successful retry must clear the fence");
		retry.dispose();
	});

	it("reruns forensic recovery after fence-clear acknowledgement fails", async () => {
		const fixture = makeFixture();
		fixture.checkpoints.failFenceClearAcknowledgement = true;
		await fixture.manager.waitForRestore();

		assert.equal(fixture.checkpoints.statuses.get(fixture.stateDir), "complete", "precondition: completion was visible after the fence was cleared");
		assert.equal(fixture.checkpoints.completionPending.has(fixture.stateDir), true, "RECOVERY_COMPLETION_FENCE: compensation must republish retry authority");
		fixture.manager.dispose();

		fixture.checkpoints.failFenceClearAcknowledgement = false;
		fixture.fs.calls.length = 0;
		const retry = new TeamManager(fixture.sessionManager as any, fixture.managerConfig as any, undefined, noTimerClock as any);
		await retry.waitForRestore();

		assert.ok(fixture.fs.calls.some((call) => call.operation === "readdir"), "RECOVERY_COMPLETION_FENCE: the next boot must rerun historical recovery after the reported failure");
		assert.equal(fixture.checkpoints.statuses.get(fixture.stateDir), "complete");
		assert.equal(fixture.checkpoints.completionPending.has(fixture.stateDir), false);
		retry.dispose();
	});

	it("invalidates a completed checkpoint and recovers when a persisted team points at a missing lead", async () => {
		const fixture = makeFixture({ completedCheckpoint: true });
		await fixture.manager.waitForRestore();

		assert.ok(fixture.sessions.get("lead-pass2"), "targeted dangling-lead recovery must remain available");
		assert.ok(fixture.fs.calls.some((call) => call.operation === "readdir"), "new concrete damage must reopen forensic recovery");
		assert.ok(fixture.checkpoints.calls.includes(`begin:${fixture.stateDir}`));
		assert.equal(fixture.checkpoints.statuses.get(fixture.stateDir), "complete");
		fixture.manager.dispose();
	});

	it("does not complete recovery until reconstructed session rows are durably published", async () => {
		const fixture = makeFixture();
		fixture.sessions.flushError = new Error("INJECTED_SESSION_PUBLICATION_FAILURE");
		await fixture.manager.waitForRestore();

		assert.equal(
			fixture.checkpoints.statuses.get(fixture.stateDir),
			"running",
			"RECOVERY_DURABILITY_BARRIER: a failed session-store publication must leave the forensic checkpoint retryable",
		);
		assert.ok(fixture.sessions.flushCalls > 0, "RECOVERY_DURABILITY_BARRIER: recovery must await a session-store persistence barrier");
		fixture.manager.dispose();

		fixture.sessions.flushError = undefined;
		fixture.fs.calls.length = 0;
		const retry = new TeamManager(fixture.sessionManager as any, fixture.managerConfig as any, undefined, noTimerClock as any);
		await retry.waitForRestore();

		assert.ok(fixture.fs.calls.some((call) => call.operation === "readdir"), "RECOVERY_DURABILITY_BARRIER: the next boot must retry forensic traversal");
		assert.equal(fixture.checkpoints.statuses.get(fixture.stateDir), "complete");
		retry.dispose();
	});

	it("does not repair under stale complete authority when checkpoint invalidation fails", async () => {
		const fixture = makeFixture({ completedCheckpoint: true });
		fixture.checkpoints.failBegin = true;
		await fixture.manager.waitForRestore();

		assert.equal(
			fixture.sessions.get("lead-pass2"),
			undefined,
			"RECOVERY_INVALIDATION_FENCE: recovery must not continue while an old complete checkpoint cannot be durably invalidated",
		);
		assert.equal(fixture.checkpoints.statuses.get(fixture.stateDir), "complete");
		fixture.manager.dispose();

		fixture.checkpoints.failBegin = false;
		fixture.fs.calls.length = 0;
		const retry = new TeamManager(fixture.sessionManager as any, fixture.managerConfig as any, undefined, noTimerClock as any);
		await retry.waitForRestore();

		assert.ok(fixture.sessions.get("lead-pass2"), "RECOVERY_INVALIDATION_FENCE: a later boot must recover after checkpoint invalidation succeeds");
		assert.ok(fixture.fs.calls.some((call) => call.operation === "readdir"), "RECOVERY_INVALIDATION_FENCE: retry must reopen forensic traversal");
		assert.equal(fixture.checkpoints.statuses.get(fixture.stateDir), "complete");
		retry.dispose();
	});

	it("retries a real sidecar backfill after publication fails", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bobbit-team-sidecar-retry-"));
		const transcript = path.join(root, "legacy.jsonl");
		const stateDir = path.join(root, "state");
		await fs.promises.writeFile(transcript, "{}\n", "utf-8");
		const checkpoints = new MemoryRecoveryCheckpoints();
		const sessions = new MemorySessionStore([{
			id: "legacy-session",
			title: "Coder: Legacy",
			cwd: root,
			createdAt: 1,
			lastActivity: 1,
			role: "coder",
			agentSessionFile: transcript,
			archived: true,
		}]);
		const goals = new MemoryStore<any>();
		const teams = new MemoryTeamStore([]);
		const context = { stateDir, goalStore: goals, teamStore: teams, sessionStore: sessions };
		const managerConfig = {
			projectContextManager: { all: () => [context], getContextForGoal: () => undefined },
			taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] },
			colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
			recoveryCheckpoints: checkpoints,
		};
		const sessionManager = { getSession: () => undefined, getSessionInfo: () => undefined };
		const targetSidecar = sidecarPathFor(transcript);
		const realRename = fs.promises.rename.bind(fs.promises);
		let injectFailure = true;
		const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => {
			if (injectFailure && path.resolve(String(to)) === path.resolve(targetSidecar)) {
				injectFailure = false;
				throw new Error("INJECTED_SIDECAR_PUBLICATION_FAILURE");
			}
			return realRename(from, to);
		});
		let manager: TeamManager | undefined;
		let retry: TeamManager | undefined;
		try {
			manager = new TeamManager(sessionManager as any, managerConfig as any, undefined, noTimerClock as any);
			await manager.waitForRestore();
			assert.equal(
				checkpoints.statuses.get(stateDir),
				"running",
				"RECOVERY_SIDECAR_RETRY: a failed sidecar publication must leave the forensic checkpoint retryable",
			);
			manager.dispose();
			manager = undefined;

			retry = new TeamManager(sessionManager as any, managerConfig as any, undefined, noTimerClock as any);
			await retry.waitForRestore();
			assert.equal(await fs.promises.readFile(targetSidecar, "utf-8").then(() => true, () => false), true, "RECOVERY_SIDECAR_RETRY: the next boot must retry the sidecar write");
			assert.equal(checkpoints.statuses.get(stateDir), "complete");
		} finally {
			manager?.dispose();
			retry?.dispose();
			renameSpy.mockRestore();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	it("supports an explicit boot boundary: team restore completes before session restore and event resubscription", async () => {
		const fixture = makeFixture({ deferFirstScan: true });
		const order: string[] = [];
		const boot = (async () => {
			await fixture.manager.waitForRestore();
			order.push("restore-teams");
			order.push("restore-sessions");
			order.push("resubscribe-team-events");
		})();

		await microtaskTurns();
		assert.deepEqual(order, []);
		fixture.fs.release();
		await boot;
		assert.deepEqual(order, ["restore-teams", "restore-sessions", "resubscribe-team-events"]);
		fixture.manager.dispose();
	});
});
