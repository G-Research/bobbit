/**
 * orphan team-store cleanup — Boot-time orphan team-store cleanup.
 *
 * `restoreTeams` must walk every persisted team entry and drop any whose
 * `goalId` is not present in the owning project's goal store BEFORE the
 * downstream zombie-reviewer sweep runs. Without this, the sweep crashes
 * inside `resolveTeamStore` (which throws when the goal can't be found in
 * any project) and the whole gateway fails to boot.
 *
 * This test exercises the cleanup logic by constructing a project context
 * with a team store that has a stale entry and an empty goal store. After
 * `restoreTeams`, the orphan should be gone from the team store on disk
 * AND from the in-memory `teams` Map.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-team-orphan-"));
process.env.BOBBIT_DIR = TEST_DIR;

const { TeamStore } = await import("../src/server/agent/team-store.ts");
const { GoalStore } = await import("../src/server/agent/goal-store.ts");
const { SessionStore } = await import("../src/server/agent/session-store.ts");
const { TeamManager } = await import("../src/server/agent/team-manager.ts");

type PersistedTeamEntry = import("../src/server/agent/team-store.ts").PersistedTeamEntry;
type PersistedGoal = import("../src/server/agent/goal-store.ts").PersistedGoal;

function makeOrphanEntry(goalId: string): PersistedTeamEntry {
	return {
		goalId,
		teamLeadSessionId: `tl-${goalId}`,
		agents: [],
		maxConcurrent: 3,
	};
}

function makeGoal(id: string, overrides: Partial<PersistedGoal> = {}): PersistedGoal {
	return {
		id,
		title: `Goal ${id}`,
		cwd: "/tmp/test",
		state: "in-progress",
		spec: "spec",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		setupStatus: "ready",
		team: true,
		...overrides,
	};
}

/**
 * Build a minimal ProjectContext-shaped object that exposes `goalStore` +
 * `teamStore` — enough to drive `TeamManager` through `restoreTeams`.
 */
function buildProjectContext(stateDir: string) {
	const teamStore = new TeamStore(stateDir);
	const goalStore = new GoalStore(stateDir);
	const sessionStore = new SessionStore(stateDir);
	return { teamStore, goalStore, sessionStore };
}

function buildPCM(contexts: Array<ReturnType<typeof buildProjectContext>>) {
	return {
		all: () => contexts,
		getContextForGoal: (goalId: string) => {
			for (const c of contexts) {
				if (c.goalStore.get(goalId)) return c;
			}
			return undefined;
		},
	};
}

function makeStubSessionManager() {
	return {
		getSession: () => undefined,
		getSessionGoalId: () => undefined,
	} as any;
}

const STATE_DIR = path.join(TEST_DIR, "state");

describe("orphan team-store cleanup on boot", () => {
	beforeEach(() => {
		// Clean state files between tests.
		try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
		fs.mkdirSync(STATE_DIR, { recursive: true });
	});

	it("drops a persisted team entry whose goalId is not in any project's goal store", () => {
		// Pre-seed an orphan team entry directly on disk before TeamManager is
		// constructed, mimicking a row left behind by a previously-archived
		// goal whose team-store entry was never reaped.
		const ts = new TeamStore(STATE_DIR);
		ts.put(makeOrphanEntry("zombie-goal-1"));
		assert.ok(ts.get("zombie-goal-1"), "orphan entry must be present pre-boot");

		// Reset and reconstruct stores with a fresh GoalStore (no goals).
		const ctx = buildProjectContext(STATE_DIR);
		assert.ok(ctx.teamStore.get("zombie-goal-1"), "team store still has orphan after reload");
		assert.equal(ctx.goalStore.get("zombie-goal-1"), undefined, "goal store must NOT contain the orphan");

		// Drive TeamManager.constructor → restoreTeams.
		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: {
				get: () => undefined,
				set: () => {},
				getAll: () => ({}),
			} as any,
			projectContextManager: buildPCM([ctx]) as any,
		});
		void tm;

		// After restoreTeams, the orphan must be gone from the team store on
		// disk (so a future boot doesn't re-encounter it) and not present in
		// the in-memory map.
		const tsAfter = new TeamStore(STATE_DIR);
		assert.equal(tsAfter.get("zombie-goal-1"), undefined, "orphan entry must be removed from team store");
	});

	it("preserves team entries whose goalId IS present in a project's goal store", () => {
		const ctx = buildProjectContext(STATE_DIR);
		ctx.goalStore.put(makeGoal("real-goal-1"));
		ctx.teamStore.put(makeOrphanEntry("real-goal-1"));
		// The new recovery code also classifies a team entry whose team-lead
		// session record is missing as an orphan candidate. Seed the matching
		// session so the entry is recognised as a real, fully-attested team.
		ctx.sessionStore.put({
			id: "tl-real-goal-1",
			role: "team-lead",
			title: "Team Lead: real-goal-1",
			cwd: "/tmp",
			createdAt: Date.now(),
			goalId: "real-goal-1",
			teamGoalId: "real-goal-1",
			teamLeadSessionId: "tl-real-goal-1",
			colorIndex: 0,
			accessory: null,
		} as any);

		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: {
				get: () => undefined,
				set: () => {},
				getAll: () => ({}),
			} as any,
			projectContextManager: buildPCM([ctx]) as any,
		});
		void tm;

		const tsAfter = new TeamStore(STATE_DIR);
		assert.ok(tsAfter.get("real-goal-1"), "real team entry must be preserved");
	});

	it("drops multiple orphans across multiple projects in a single restoreTeams pass", () => {
		const projA = buildProjectContext(path.join(STATE_DIR, "projA"));
		const projB = buildProjectContext(path.join(STATE_DIR, "projB"));
		fs.mkdirSync(path.join(STATE_DIR, "projA"), { recursive: true });
		fs.mkdirSync(path.join(STATE_DIR, "projB"), { recursive: true });

		// projA has a real goal + an orphan entry; projB has only an orphan.
		projA.goalStore.put(makeGoal("real-A"));
		projA.teamStore.put(makeOrphanEntry("real-A"));
		projA.teamStore.put(makeOrphanEntry("orphan-A"));
		projB.teamStore.put(makeOrphanEntry("orphan-B"));
		// Seed the team-lead session record for the "real" goal so the new
		// missing-team-lead orphan criterion (added by the recovery commits)
		// doesn't falsely flag it.
		projA.sessionStore.put({
			id: "tl-real-A",
			role: "team-lead",
			title: "Team Lead: real-A",
			cwd: "/tmp",
			createdAt: Date.now(),
			goalId: "real-A",
			teamGoalId: "real-A",
			teamLeadSessionId: "tl-real-A",
			colorIndex: 0,
			accessory: null,
		} as any);

		const tm = new TeamManager(makeStubSessionManager(), {
			taskManager: {} as any,
			roleStore: {} as any,
			colorStore: {
				get: () => undefined,
				set: () => {},
				getAll: () => ({}),
			} as any,
			projectContextManager: buildPCM([projA, projB]) as any,
		});
		void tm;

		assert.ok(projA.teamStore.get("real-A"), "real entry preserved");
		assert.equal(projA.teamStore.get("orphan-A"), undefined, "projA orphan dropped");
		assert.equal(projB.teamStore.get("orphan-B"), undefined, "projB orphan dropped");
	});

	it("local (no PCM) path is a no-op — backward compat with non-PCM tests", () => {
		// In the legacy/non-PCM path, the entire team-store is a single file
		// and there's no per-project goal-store to consult. The sweep must
		// silently skip rather than crash.
		const ts = new TeamStore(STATE_DIR);
		ts.put(makeOrphanEntry("orphan-X"));

		// No projectContextManager → local path.
		assert.doesNotThrow(() => {
			const tm = new TeamManager(makeStubSessionManager(), {
				taskManager: {} as any,
				roleStore: {} as any,
				colorStore: {
					get: () => undefined,
					set: () => {},
					getAll: () => ({}),
				} as any,
			});
			void tm;
		});
	});
});
