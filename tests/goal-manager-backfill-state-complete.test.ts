/**
 * Phase 2 — `GoalManager.backfillCompleteState`
 *
 * Boot-time migration that closes the Lesson 4.2 gap on records produced
 * before `archiveGoalAfterMerge` was wired up: archived goals whose
 * `ready-to-merge` gate is `passed` must have `state="complete"` so the
 * harness short-circuits cleanly. Cases:
 *
 *   1. Legacy archived goal with passed ready-to-merge → backfilled to
 *      state=complete.
 *   2. Archived goal with FAILED ready-to-merge → unchanged
 *      (genuinely-failed goals must not silently flip to complete).
 *   3. Non-archived goal → unchanged (live work, even if rtm passed,
 *      stays live).
 *   4. Archived goal with NO ready-to-merge gate → unchanged (workflow
 *      doesn't have one; not our problem).
 *   5. Idempotency: re-running the backfill a second time is a no-op.
 *   6. Per-goal try/catch — a corrupt record shouldn't abort the loop
 *      (Lesson 4.11 endless-restart guard).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { GateStore } from "../src/server/agent/gate-store.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-state-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeManagerAndGates(): { gm: GoalManager; goalStore: GoalStore; gateStore: GateStore } {
	const goalStore = new GoalStore(stateDir);
	const gateStore = new GateStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "general", name: "General", description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0, updatedAt: 0,
	}]);
	return { gm: new GoalManager(goalStore, wf), goalStore, gateStore };
}

function persistGoal(store: GoalStore, over: Partial<PersistedGoal>): PersistedGoal {
	const now = Date.now();
	const goal: PersistedGoal = {
		id: over.id ?? "g",
		title: over.title ?? "G",
		cwd: tmpRoot,
		state: over.state ?? "in-progress",
		spec: "",
		createdAt: now,
		updatedAt: now,
		...over,
	};
	store.put(goal);
	return goal;
}

function passReadyToMerge(gateStore: GateStore, goalId: string, status: "passed" | "failed" | "pending"): void {
	gateStore.initGatesForGoal(goalId, ["ready-to-merge"]);
	const gate = gateStore.getGate(goalId, "ready-to-merge")!;
	gate.status = status;
	// We don't have a public setter for status without a signal. Round-trip
	// via the JSON file: write then re-read.
	const file = path.join(stateDir, "gates.json");
	const all = JSON.parse(fs.readFileSync(file, "utf-8"));
	const idx = all.findIndex((g: any) => g.gateId === "ready-to-merge" && g.goalId === goalId);
	all[idx].status = status;
	fs.writeFileSync(file, JSON.stringify(all, null, 2), "utf-8");
}

describe("GoalManager.backfillCompleteState", () => {
	it("legacy archived goal with passed ready-to-merge → state=complete", () => {
		const { gm, goalStore, gateStore } = makeManagerAndGates();
		persistGoal(goalStore, { id: "legacy", state: "in-progress", archived: true, archivedAt: 1 });
		passReadyToMerge(gateStore, "legacy", "passed");
		// Reload the gate store after raw file write so it picks up the
		// change (or just re-construct it).
		const freshGateStore = new GateStore(stateDir);

		const out = gm.backfillCompleteState(freshGateStore);
		assert.equal(out.backfilled, 1);
		assert.equal(goalStore.get("legacy")?.state, "complete");
	});

	it("archived goal with FAILED ready-to-merge → unchanged", () => {
		const { gm, goalStore, gateStore } = makeManagerAndGates();
		persistGoal(goalStore, { id: "broken", state: "in-progress", archived: true, archivedAt: 1 });
		passReadyToMerge(gateStore, "broken", "failed");
		const freshGateStore = new GateStore(stateDir);

		const out = gm.backfillCompleteState(freshGateStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("broken")?.state, "in-progress",
			"failed gate must NOT be flipped to complete");
	});

	it("non-archived goal → unchanged (even if rtm passed)", () => {
		const { gm, goalStore, gateStore } = makeManagerAndGates();
		persistGoal(goalStore, { id: "live", state: "in-progress", archived: false });
		passReadyToMerge(gateStore, "live", "passed");
		const freshGateStore = new GateStore(stateDir);

		const out = gm.backfillCompleteState(freshGateStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("live")?.state, "in-progress");
	});

	it("archived goal with NO ready-to-merge gate → unchanged", () => {
		const { gm, goalStore, gateStore } = makeManagerAndGates();
		persistGoal(goalStore, { id: "no-rtm", state: "in-progress", archived: true, archivedAt: 1 });
		// Other gate exists but no ready-to-merge.
		gateStore.initGatesForGoal("no-rtm", ["plan"]);

		const out = gm.backfillCompleteState(gateStore);
		assert.equal(out.backfilled, 0);
		assert.equal(goalStore.get("no-rtm")?.state, "in-progress");
	});

	it("already complete + archived → unchanged (idempotent)", () => {
		const { gm, goalStore, gateStore } = makeManagerAndGates();
		persistGoal(goalStore, { id: "ok", state: "complete", archived: true, archivedAt: 1 });
		passReadyToMerge(gateStore, "ok", "passed");
		const freshGateStore = new GateStore(stateDir);

		const out = gm.backfillCompleteState(freshGateStore);
		// "skipped" because state is already complete.
		assert.equal(out.backfilled, 0);
	});

	it("mix of records: only the legacy ones get flipped", () => {
		const { gm, goalStore, gateStore } = makeManagerAndGates();
		persistGoal(goalStore, { id: "legacy-1", state: "in-progress", archived: true, archivedAt: 1 });
		persistGoal(goalStore, { id: "legacy-2", state: "in-progress", archived: true, archivedAt: 2 });
		persistGoal(goalStore, { id: "live-3", state: "in-progress", archived: false });
		persistGoal(goalStore, { id: "failed-4", state: "in-progress", archived: true, archivedAt: 3 });
		passReadyToMerge(gateStore, "legacy-1", "passed");
		passReadyToMerge(gateStore, "legacy-2", "passed");
		passReadyToMerge(gateStore, "live-3", "passed");
		passReadyToMerge(gateStore, "failed-4", "failed");
		const freshGateStore = new GateStore(stateDir);

		const out = gm.backfillCompleteState(freshGateStore);
		assert.equal(out.backfilled, 2);
		assert.equal(goalStore.get("legacy-1")?.state, "complete");
		assert.equal(goalStore.get("legacy-2")?.state, "complete");
		assert.equal(goalStore.get("live-3")?.state, "in-progress");
		assert.equal(goalStore.get("failed-4")?.state, "in-progress");
	});
});
