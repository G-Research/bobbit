// v2-native — NOT a migrated legacy test. Discovered from its `tests2/core` path.
// Failing-first reproducer for archived team-owned sessions leaking through cold restore.

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it, vi } from "vitest";

vi.mock("../../src/server/agent/orphan-cleanup.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../src/server/agent/orphan-cleanup.ts")>();
	return {
		...original,
		scanOrphanedTranscriptsAsync: async () => ({ count: 0, paths: [] }),
	};
});

const { SessionManager } = await import("../../src/server/agent/session-manager.ts");

function persisted(id: string, ownership: Record<string, unknown>): any {
	return {
		id,
		title: id,
		cwd: path.resolve("/pure/archived-team-restore"),
		projectId: "project-1",
		agentSessionFile: path.resolve("/pure/archived-team-restore", `${id}.jsonl`),
		createdAt: 1,
		lastActivity: 1,
		wasStreaming: false,
		messageQueue: [],
		...ownership,
	};
}

describe("archived team ownership cold-restore guard", () => {
	it("does not dispatch teamGoalId rows owned by an archived goal when team state is missing", async () => {
		const archivedGoal = {
			id: "goal-archived",
			projectId: "project-1",
			title: "Archived team goal",
			archived: true,
		};
		const leakedTeamWorker = persisted("leaked-team-worker", {
			goalId: archivedGoal.id,
			teamGoalId: archivedGoal.id,
			role: "coder",
		});
		const standaloneControl = persisted("standalone-goal-session", {
			// goalId alone is affiliation, not durable team ownership.
			goalId: archivedGoal.id,
		});
		const matchingDelegate = persisted("matching-team-delegate", {
			delegateOf: standaloneControl.id,
			teamGoalId: archivedGoal.id,
		});
		const matchingGrandchild = persisted("matching-team-grandchild", {
			delegateOf: matchingDelegate.id,
			parentSessionId: matchingDelegate.id,
			childKind: "review",
			teamGoalId: archivedGoal.id,
		});
		const rows = [leakedTeamWorker, standaloneControl, matchingDelegate, matchingGrandchild];
		const byId = new Map(rows.map((row) => [row.id, row]));
		const sessionStore = {
			getLive: () => rows.filter((row) => row.archived !== true),
			getAll: () => rows,
			get: (id: string) => byId.get(id),
			archive: (id: string) => {
				const row = byId.get(id);
				if (row) row.archived = true;
			},
		};
		const context = {
			project: { id: "project-1" },
			sessionStore,
			goalStore: {
				get: (id: string) => id === archivedGoal.id ? archivedGoal : undefined,
			},
			// This is the production leak shape: durable session ownership survives
			// even though optional persisted team bookkeeping is absent.
			teamStore: { getAll: () => [] },
		};
		const projectContextManager = {
			getAllLiveSessions: () => sessionStore.getLive(),
			getAllSessions: () => sessionStore.getAll(),
			all: () => [context].values(),
			getOrCreate: (projectId: string) => projectId === "project-1" ? context : undefined,
			getContextForGoal: (goalId: string) => goalId === archivedGoal.id ? context : undefined,
		};
		const manager: any = Object.create(SessionManager.prototype);
		manager.projectContextManager = projectContextManager;
		manager.sessions = new Map();
		manager.orchestrationCore = null;
		manager.clock = { now: () => Date.now() };
		manager._bootRestoreLagSampler = () => 0;
		manager.yieldBootRestore = async () => {};

		const dispatched: string[] = [];
		manager.restoreOneSession = async (row: any) => { dispatched.push(row.id); };

		assert.equal(context.goalStore.get(archivedGoal.id)?.archived, true, "fixture must resolve archived ownership");
		assert.deepEqual(context.teamStore.getAll(), [], "fixture must not rely on TeamStore ownership");

		await manager.restoreSessions();

		assert.deepEqual(
			dispatched,
			[standaloneControl.id],
			"ARCHIVED_TEAM_RESTORE_DISPATCHED: exact teamGoalId ownership must be suppressed regardless of goal-only ancestry",
		);
	});
});
