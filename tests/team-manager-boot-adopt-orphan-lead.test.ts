/**
 * CON-06 regression test: team-lead session record is persisted before its
 * team-store entry — a crash in that window leaves an orphaned/untracked
 * team-lead, and the next startTeam() call spawns a duplicate on the SAME
 * goal worktree/branch.
 *
 * Crash-window state we reconstruct here: sessions.json holds a live session
 * with role="team-lead" + teamGoalId=<goal> (this write always lands first —
 * see team-manager.ts::_startTeamImpl, createSession/updateSessionMeta run
 * synchronously before the later persistEntry() call), but team-state.json
 * has NO entry for the goal (the crash happened before persistEntry ran).
 *
 * Before the fix: TeamManager.restoreTeams() only populates `this.teams` from
 * persisted team-store entries, so this goal restores with nothing. The next
 * `startTeam(goalId)` sees `this.teams.has(goalId) === false` and spawns a
 * second team-lead alongside the orphaned first one.
 *
 * After the fix: a boot-time adoption sweep ("[CON-06] Pass 2.5" in
 * restoreTeams) finds the untracked role=team-lead session, writes a
 * team-store entry pointing at it, and restoreTeams' normal
 * persisted-entries loop then picks it up into `this.teams` — so the next
 * startTeam(goalId) correctly throws "Team already active" instead of
 * spawning a duplicate.
 */
import { after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_BOBBIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-adopt-orphan-lead-test-"));
process.env.BOBBIT_DIR = TEST_BOBBIT_DIR;

const { TeamManager } = await import("../src/server/agent/team-manager.ts");

const createdManagers: any[] = [];

after(() => {
	for (const tm of createdManagers) {
		tm.dispose?.();
		for (const [, timer] of (tm as any).idleNudgeTimers ?? []) clearTimeout(timer);
		(tm as any).idleNudgeTimers?.clear?.();
		for (const [, timer] of (tm as any).noWorkersNudgeTimers ?? []) clearTimeout(timer);
		(tm as any).noWorkersNudgeTimers?.clear?.();
		for (const [, timer] of (tm as any).pendingIdleNotify ?? []) clearTimeout(timer);
		(tm as any).pendingIdleNotify?.clear?.();
	}
	try { fs.rmSync(TEST_BOBBIT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeCrashWindowGoal() {
	return {
		id: "goal-crash-window",
		title: "Crash Window Team Goal",
		cwd: "/tmp/con-06-test-project",
		state: "in-progress",
		setupStatus: "ready",
		spec: "# Test\nTeam-lead session persisted, team-store entry never written.",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		team: true,
		archived: false,
		paused: false,
		branch: "goal/crash-window",
		repoPath: "/tmp/con-06-test-repo",
		// Nonexistent path is fine — the boot passes' fs scans catch ENOENT
		// and treat it as "nothing found" rather than throwing.
		worktreePath: "/tmp/con-06-test-project/goal-crash-window-worktree-does-not-exist",
	};
}

/** The team-lead session that made it to disk before the crash. */
function makeOrphanedTeamLeadSession(goalId: string) {
	return {
		id: "sess-team-lead-orphan",
		title: "Team Lead: Calcifer",
		role: "team-lead",
		teamGoalId: goalId,
		archived: false,
		worktreePath: "/tmp/con-06-test-project/goal-crash-window-worktree-does-not-exist",
	};
}

function makeProjectContext(goal: any, session: any) {
	// Stateful team-store stub: put()/get()/getAll() share one map so the
	// boot-time adoption sweep's write is visible to the rest of restoreTeams
	// (specifically the persisted-entries loop that populates `this.teams`).
	const teamEntries = new Map<string, any>();
	const sessions = [session];
	return {
		goalStore: {
			get: (id: string) => (id === goal.id ? goal : undefined),
			getAll: () => [goal],
		},
		teamStore: {
			get: (id: string) => teamEntries.get(id),
			getAll: () => Array.from(teamEntries.values()),
			remove: mock.fn((id: string) => teamEntries.delete(id)),
			put: mock.fn((entry: any) => { teamEntries.set(entry.goalId, entry); }),
		},
		sessionStore: {
			get: (id: string) => sessions.find(s => s.id === id),
			getAll: () => sessions,
			put: mock.fn(),
			update: mock.fn(),
		},
		gateStore: { getGatesForGoal: () => [] },
		taskStore: { getByGoalId: () => [] },
		goalManager: { updateGoal: mock.fn(async () => true) },
	};
}

describe("TeamManager boot-time untracked team-lead adoption (CON-06)", () => {
	it("adopts an untracked team-lead session into the team-store on boot instead of leaving it orphaned", () => {
		const goal = makeCrashWindowGoal();
		const session = makeOrphanedTeamLeadSession(goal.id);
		const ctx = makeProjectContext(goal, session);
		const projectContextManager = {
			all: () => [ctx],
			getContextForGoal: (goalId: string) => (goalId === goal.id ? ctx : undefined),
		};
		const sessionManager = {
			getSession: () => undefined,
			goalManager: ctx.goalManager,
			createSession: mock.fn(async () => { throw new Error("createSession must not be called — a team-lead already exists for this goal"); }),
		};
		const tm = new TeamManager(sessionManager as any, {
			projectContextManager,
			taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] },
			colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
		} as any);
		createdManagers.push(tm);

		// The adoption sweep must have written a team-store entry pointing at
		// the surviving orphaned session — not dropped it, not left it alone.
		assert.equal(
			ctx.teamStore.put.mock.callCount() >= 1,
			true,
			"CON_06_NOT_ADOPTED: boot restore never wrote a team-store entry for the untracked team-lead session",
		);
		const putCalls = ctx.teamStore.put.mock.calls.map((c: any) => c.arguments[0]);
		const adoptedEntry = putCalls.find((e: any) => e.goalId === goal.id);
		assert.ok(adoptedEntry, "CON_06_NOT_ADOPTED: no team-store entry was written for the crash-window goal");
		assert.equal(adoptedEntry.teamLeadSessionId, session.id);

		// The live in-memory team map (what startTeam consults) must reflect
		// the adoption — this is what actually prevents the duplicate spawn.
		const liveEntry = (tm as any).teams.get(goal.id);
		assert.ok(liveEntry, "CON_06_NOT_ADOPTED: this.teams has no entry for the goal after boot restore");
		assert.equal(liveEntry.teamLeadSessionId, session.id);

		// The reverse lookup must also be rebuilt so dismiss/teardown paths work.
		assert.equal((tm as any).sessionToGoal.get(session.id), goal.id);
	});

	it("prevents a duplicate team-lead spawn: startTeam() on the adopted goal throws instead of creating a second session", async () => {
		const goal = makeCrashWindowGoal();
		goal.id = "goal-crash-window-2";
		const session = makeOrphanedTeamLeadSession(goal.id);
		session.id = "sess-team-lead-orphan-2";
		const ctx = makeProjectContext(goal, session);
		const projectContextManager = {
			all: () => [ctx],
			getContextForGoal: (goalId: string) => (goalId === goal.id ? ctx : undefined),
		};
		const createSession = mock.fn(async () => {
			throw new Error("createSession must not be called — a team-lead already exists for this goal");
		});
		const sessionManager = {
			getSession: () => undefined,
			goalManager: ctx.goalManager,
			createSession,
		};
		const tm = new TeamManager(sessionManager as any, {
			projectContextManager,
			taskManager: { getTasksByGoal: () => [], getTasksForSession: () => [] },
			colorStore: { get: () => undefined, set: () => {}, remove: () => {}, getAll: () => ({}) },
		} as any);
		createdManagers.push(tm);

		await assert.rejects(
			() => tm.startTeam(goal.id),
			/Team already active for goal/,
			"CON_06_DUPLICATE_SPAWN: startTeam() spawned a second team-lead instead of recognizing the adopted one",
		);
		assert.equal(
			createSession.mock.callCount(),
			0,
			"CON_06_DUPLICATE_SPAWN: sessionManager.createSession was called — a duplicate team-lead was spawned",
		);
	});
});
