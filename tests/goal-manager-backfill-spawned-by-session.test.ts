/**
 * Boot-time migration — `GoalManager.backfillSpawnedBySessionId`
 *
 * Sub-goals created before commit 00d6805f have no `spawnedBySessionId`
 * field, so the sidebar can't nest them under their spawning team-lead.
 * Lookup precedence: parent's persisted team entry first, then session
 * store as a fallback (single team-lead session matching parent goalId).
 * Archived sub-goals ARE processed — the archived sidebar block needs
 * the link to draw the chevron and nesting. Cases:
 *
 *   1. Legacy live sub-goal with a parent team → stamped.
 *   2. Sub-goal already stamped → no-op.
 *   3. Root goal (no parentGoalId) → skipped.
 *   4. Archived sub-goal with team store hit → stamped.
 *   5. Parent has no team entry, single team-lead session in session store → stamped.
 *   6. Parent has no team entry, multiple team-lead sessions → skipped (ambiguous).
 *   7. Parent has no team entry, no session store provided → skipped.
 *   8. Parent team has no team-lead → falls through to session-store fallback.
 *   9. Idempotency: a second pass is a no-op.
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
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-spawnedby-"));
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

function putTeam(teamStore: TeamStore, goalId: string, teamLeadSessionId: string | null): void {
	teamStore.put({
		goalId,
		teamLeadSessionId,
		agents: [],
		maxConcurrent: 3,
	});
}

describe("GoalManager.backfillSpawnedBySessionId", () => {
	it("stamps parent team-lead on a legacy live sub-goal", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });
		putTeam(teamStore, "parent", "tl-session-A");

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 1);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, "tl-session-A");
	});

	it("does not overwrite an already-stamped sub-goal", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent", spawnedBySessionId: "preexisting" });
		putTeam(teamStore, "parent", "tl-session-A");

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, "preexisting");
	});

	it("skips root goals (no parentGoalId)", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "root" });
		putTeam(teamStore, "root", "tl-session-A");

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("root")?.spawnedBySessionId, undefined);
	});

	it("stamps archived sub-goals via team store", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent", archived: true, archivedAt: 1 });
		putTeam(teamStore, "parent", "tl-session-A");

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 1);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, "tl-session-A");
	});

	it("session-store fallback: single team-lead session matches parent (live or archived)", () => {
		const { gm, goalStore, teamStore, sessionStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent", archived: true, archivedAt: 1 });
		// Team store has no entry — team was torn down on archive.
		// Session store retains the (archived) team-lead session.
		persistTeamLead(sessionStore, { id: "tl-archived", teamGoalId: "parent" });

		const out = gm.backfillSpawnedBySessionId(teamStore, sessionStore);
		assert.equal(out.backfilled, 1);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, "tl-archived");
	});

	it("session-store fallback: skips when multiple team-leads match parent (ambiguous)", () => {
		const { gm, goalStore, teamStore, sessionStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });
		// Two team-lead sessions for the same parent — can't infer which spawned the child.
		persistTeamLead(sessionStore, { id: "tl-A", teamGoalId: "parent" });
		persistTeamLead(sessionStore, { id: "tl-B", teamGoalId: "parent" });

		const out = gm.backfillSpawnedBySessionId(teamStore, sessionStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, undefined);
	});

	it("skips when the parent has no team entry and no session store provided", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, undefined);
	});

	it("falls through to session-store fallback when team has no team-lead", () => {
		const { gm, goalStore, teamStore, sessionStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });
		putTeam(teamStore, "parent", null);
		persistTeamLead(sessionStore, { id: "tl-X", teamGoalId: "parent" });

		const out = gm.backfillSpawnedBySessionId(teamStore, sessionStore);
		assert.equal(out.backfilled, 1);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, "tl-X");
	});

	it("idempotent — second pass is a no-op", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });
		putTeam(teamStore, "parent", "tl-session-A");

		const first = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(first.backfilled, 1);
		const second = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(second.backfilled, 0);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, "tl-session-A");
	});

	it("handles a mix of records: stamps live + archived sub-goals from both sources", () => {
		const { gm, goalStore, teamStore, sessionStore } = makeManager();
		persistGoal(goalStore, { id: "p1" });
		persistGoal(goalStore, { id: "p2" });
		persistGoal(goalStore, { id: "p3-archived", archived: true, archivedAt: 1 });
		persistGoal(goalStore, { id: "live-1", parentGoalId: "p1" });
		persistGoal(goalStore, { id: "live-2", parentGoalId: "p2" });
		persistGoal(goalStore, { id: "stamped", parentGoalId: "p1", spawnedBySessionId: "preexisting" });
		persistGoal(goalStore, { id: "archived-direct", parentGoalId: "p1", archived: true, archivedAt: 1 });
		persistGoal(goalStore, { id: "archived-via-session", parentGoalId: "p3-archived", archived: true, archivedAt: 1 });
		putTeam(teamStore, "p1", "tl-A");
		putTeam(teamStore, "p2", "tl-B");
		// p3-archived has no team entry (torn down) but session store has the archived team-lead.
		persistTeamLead(sessionStore, { id: "tl-C", teamGoalId: "p3-archived" });

		const out = gm.backfillSpawnedBySessionId(teamStore, sessionStore);
		assert.equal(out.backfilled, 4);
		assert.equal(goalStore.get("live-1")?.spawnedBySessionId, "tl-A");
		assert.equal(goalStore.get("live-2")?.spawnedBySessionId, "tl-B");
		assert.equal(goalStore.get("stamped")?.spawnedBySessionId, "preexisting");
		assert.equal(goalStore.get("archived-direct")?.spawnedBySessionId, "tl-A");
		assert.equal(goalStore.get("archived-via-session")?.spawnedBySessionId, "tl-C");
	});
});
