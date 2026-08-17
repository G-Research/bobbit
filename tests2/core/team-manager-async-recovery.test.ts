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
