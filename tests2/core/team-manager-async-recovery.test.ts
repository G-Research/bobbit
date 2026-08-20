import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import { trustedAgentSessionsRoots } from "../../src/server/agent/agent-session-path.ts";
import { sidecarPathFor, type SessionSidecar } from "../../src/server/agent/session-sidecar.ts";
import { TeamManager, type TeamRecoverySidecars } from "../../src/server/agent/team-manager.ts";
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

function makeFixture(options: { deferFirstScan?: boolean } = {}) {
	const roots = trustedAgentSessionsRoots();
	assert.ok(roots.length > 0);
	const firstRoot = roots[0]!;
	const fs = new TeamRecoveryFsFake();
	const sidecars = new MemoryRecoverySidecars();

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
	const sessions = new MemoryStore<any>([{
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
	const manager = new TeamManager(sessionManager as any, {
		projectContextManager,
		taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] },
		colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
		recoveryFs: fs,
		recoverySidecars: sidecars,
	} as any, undefined, noTimerClock as any);

	return {
		manager,
		fs,
		sidecars,
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

async function makeAdoptedAdmissionFixture() {
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
		worktreeOwnerSessionId: ownerSessionId,
	};
	let subscriptionCount = 0;
	let unsubscribeCount = 0;
	let activeSubscriptions = 0;
	let promptCount = 0;
	let failNextTransition = false;
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
			return goals.get(goalId);
		},
	};
	const context = {
		project: { id: projectId },
		goalStore: goals,
		goalManager,
		teamStore: teams,
		sessionStore: sessions,
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
		enqueuePrompt: async () => {
			promptCount += 1;
			return { status: "dispatched" };
		},
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
	const manager = new TeamManager(sessionManager as any, {
		projectContextManager,
		roleStore: { get: (name: string) => roles.find(role => role.name === name), getAll: () => roles },
		taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] },
		colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
		recoveryFs,
		recoverySidecars: new MemoryRecoverySidecars(),
	} as any, undefined, noTimerClock as any);
	await manager.waitForRestore();

	goals.put(goal);
	sessions.put(source);
	liveSessions.set(source.id, { ...source });
	await manager.adoptExistingLead(goal.id, source.id);

	return {
		manager,
		goal,
		source,
		goals,
		sessions,
		teams,
		liveSessions,
		failNextTransition: () => { failNextTransition = true; },
		get workerCount() { return workerSequence; },
		get subscriptionCount() { return subscriptionCount; },
		get unsubscribeCount() { return unsubscribeCount; },
		get activeSubscriptions() { return activeSubscriptions; },
		get promptCount() { return promptCount; },
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
	it("activates the reserved lead without a kickoff and stays single-subscribed across retries", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			const attachment = { goalId: fixture.goal.id, teamGoalId: fixture.goal.id, role: "team-lead" };
			Object.assign(fixture.liveSessions.get(fixture.source.id), attachment);
			fixture.sessions.update(fixture.source.id, attachment);

			const first = await fixture.manager.finalizeAdoptedLead(fixture.goal.id);
			assert.equal(first.teamLeadSessionId, fixture.source.id);
			assert.equal(fixture.goals.get(fixture.goal.id)?.state, "in-progress");
			assert.equal(fixture.subscriptionCount, 1);
			assert.equal(fixture.activeSubscriptions, 1);
			assert.equal(fixture.promptCount, 0);
			assert.equal(fixture.workerCount, 0);

			const retry = await fixture.manager.finalizeAdoptedLead(fixture.goal.id);
			assert.equal(retry.teamLeadSessionId, fixture.source.id);
			assert.equal(fixture.subscriptionCount, 2);
			assert.equal(fixture.unsubscribeCount, 1);
			assert.equal(fixture.activeSubscriptions, 1, "retry replaces rather than duplicates the lead listener");
			assert.equal(fixture.goals.updates.length, 1, "in-progress transition is idempotent");
			assert.equal(fixture.promptCount, 0, "finalization never sends the normal startTeam kickoff");
		} finally {
			fixture.manager.dispose();
		}
	});

	it("retries cleanly after the todo transition fails", async () => {
		const fixture = await makeAdoptedAdmissionFixture();
		try {
			const attachment = { goalId: fixture.goal.id, teamGoalId: fixture.goal.id, role: "team-lead" };
			Object.assign(fixture.liveSessions.get(fixture.source.id), attachment);
			fixture.sessions.update(fixture.source.id, attachment);
			fixture.failNextTransition();

			await assert.rejects(
				() => fixture.manager.finalizeAdoptedLead(fixture.goal.id),
				/injected transition failure/,
			);
			assert.equal(fixture.goals.get(fixture.goal.id)?.state, "todo");
			assert.equal(fixture.activeSubscriptions, 1);

			await fixture.manager.finalizeAdoptedLead(fixture.goal.id);
			assert.equal(fixture.goals.get(fixture.goal.id)?.state, "in-progress");
			assert.equal(fixture.subscriptionCount, 2);
			assert.equal(fixture.unsubscribeCount, 1);
			assert.equal(fixture.activeSubscriptions, 1);
			assert.equal(fixture.promptCount, 0);
			assert.equal(fixture.workerCount, 0);
		} finally {
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
