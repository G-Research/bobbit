/**
 * Boot-time migration — `GoalManager.backfillSpawnedBySessionId`
 *
 * Sub-goals created before commit 00d6805f have no `spawnedBySessionId`
 * field, so the sidebar can't nest them under their spawning team-lead.
 * This backfill stamps the parent's `teamLeadSessionId` from the
 * persisted team entry. Cases:
 *
 *   1. Legacy live sub-goal with a parent team → field stamped.
 *   2. Sub-goal already stamped → no-op.
 *   3. Root goal (no parentGoalId) → skipped.
 *   4. Archived sub-goal → skipped (parent's team is gone).
 *   5. Parent has no team entry → skipped (no candidate session).
 *   6. Parent team has no team-lead → skipped.
 *   7. Idempotency: a second pass is a no-op.
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

function makeManager(): { gm: GoalManager; goalStore: GoalStore; teamStore: TeamStore } {
	const goalStore = new GoalStore(stateDir);
	const teamStore = new TeamStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "general", name: "General", description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0, updatedAt: 0,
	}]);
	return { gm: new GoalManager(goalStore, wf), goalStore, teamStore };
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

	it("skips archived sub-goals", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent", archived: true, archivedAt: 1 });
		putTeam(teamStore, "parent", "tl-session-A");

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, undefined);
	});

	it("skips when the parent has no team entry", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });
		// No putTeam call.

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, undefined);
	});

	it("skips when the parent's team has no team-lead", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "parent" });
		persistGoal(goalStore, { id: "child", parentGoalId: "parent" });
		putTeam(teamStore, "parent", null);

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("child")?.spawnedBySessionId, undefined);
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

	it("handles a mix of records: only legacy live sub-goals are stamped", () => {
		const { gm, goalStore, teamStore } = makeManager();
		persistGoal(goalStore, { id: "p1" });
		persistGoal(goalStore, { id: "p2" });
		persistGoal(goalStore, { id: "live-1", parentGoalId: "p1" });
		persistGoal(goalStore, { id: "live-2", parentGoalId: "p2" });
		persistGoal(goalStore, { id: "stamped", parentGoalId: "p1", spawnedBySessionId: "preexisting" });
		persistGoal(goalStore, { id: "archived-x", parentGoalId: "p1", archived: true, archivedAt: 1 });
		putTeam(teamStore, "p1", "tl-A");
		putTeam(teamStore, "p2", "tl-B");

		const out = gm.backfillSpawnedBySessionId(teamStore);
		assert.equal(out.backfilled, 2);
		assert.equal(goalStore.get("live-1")?.spawnedBySessionId, "tl-A");
		assert.equal(goalStore.get("live-2")?.spawnedBySessionId, "tl-B");
		assert.equal(goalStore.get("stamped")?.spawnedBySessionId, "preexisting");
		assert.equal(goalStore.get("archived-x")?.spawnedBySessionId, undefined);
	});
});
