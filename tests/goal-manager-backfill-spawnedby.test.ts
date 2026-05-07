/**
 * Pinning tests for `GoalManager.backfillSpawnedBySessionId`, the
 * boot-time migration that stamps `spawnedBySessionId` on legacy
 * sub-goals that pre-date the spawn-child handler's stamping logic.
 *
 * The wider behavioural matrix (eight scenarios) is exercised by
 * `tests/goal-manager-backfill-spawned-by-session.test.ts`. This file
 * focuses narrowly on the THREE behaviours the new spawn-child cascade
 * is committed to preserving:
 *
 *   1. Stamp from the parent's live team-lead.
 *   2. Idempotent — a second pass writes nothing new.
 *   3. Multi-team-lead parent is SKIPPED (NOT misattributed) — the
 *      parent's session-store fallback only fires when there is exactly
 *      one team-lead candidate. We re-pin this here because the design
 *      doc explicitly calls it out as the protection against legacy
 *      records being silently mis-stamped.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { TeamStore } from "../src/server/agent/team-store.ts";
import { SessionStore, type PersistedSession } from "../src/server/agent/session-store.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-spawnedby-pin-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeManager(): {
	gm: GoalManager;
	goalStore: GoalStore;
	teamStore: TeamStore;
	sessionStore: SessionStore;
} {
	const goalStore = new GoalStore(stateDir);
	const teamStore = new TeamStore(stateDir);
	const sessionStore = new SessionStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "general", name: "General", description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0, updatedAt: 0,
	}]);
	return { gm: new GoalManager(goalStore, wf), goalStore, teamStore, sessionStore };
}

function persistGoal(store: GoalStore, over: Partial<PersistedGoal> & { id: string }): PersistedGoal {
	const now = Date.now();
	const goal: PersistedGoal = {
		title: over.title ?? over.id,
		cwd: tmpRoot,
		state: "in-progress",
		spec: "",
		createdAt: now,
		updatedAt: now,
		...over,
	};
	store.put(goal);
	return goal;
}

function persistTeamLead(sessionStore: SessionStore, over: Partial<PersistedSession> & { id: string; teamGoalId: string }): void {
	const now = Date.now();
	sessionStore.put({
		id: over.id,
		title: over.title ?? "Team Lead",
		role: "team-lead",
		teamGoalId: over.teamGoalId,
		createdAt: now,
		updatedAt: now,
		...over,
	} as PersistedSession);
}

function putTeam(teamStore: TeamStore, goalId: string, teamLeadSessionId: string | null): void {
	teamStore.put({
		goalId,
		teamLeadSessionId,
		agents: [],
		maxConcurrent: 3,
	});
}

describe("backfillSpawnedBySessionId — pinning the cascade contract", () => {
	it("stamps from the parent's live team-lead", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });
		putTeam(teamStore, "parent", "tl-A");

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 1);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, "tl-A");
	});

	it("idempotent — a second pass is a no-op (no overwrite, no churn)", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });
		putTeam(teamStore, "parent", "tl-A");

		const first = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(first.backfilled, 1);
		const second = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(second.backfilled, 0);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, "tl-A");
	});

	it("multi-team-lead parent is SKIPPED, not misattributed", () => {
		const { gm, goalStore, teamStore, sessionStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });
		// No team-store entry — exercises the session-store fallback.
		// Two team-lead sessions for the same parent: the design doc
		// explicitly mandates SKIPPING this case rather than picking one
		// arbitrarily (would silently misattribute).
		persistTeamLead(sessionStore, { id: "tl-A", teamGoalId: "parent" });
		persistTeamLead(sessionStore, { id: "tl-B", teamGoalId: "parent" });

		const out = gm.backfillSpawnedBySessionId(teamStore, sessionStore);
		assert.equal(out.backfilled, 0);
		// Critical: the field stays undefined so the sidebar's
		// strict-parent attribution can place it under the parent without
		// committing to a wrong team-lead.
		assert.equal(goalStore.get("child")?.spawnedBySessionId, undefined);
	});
});
