/**
 * Phase 2 — `GoalManager.archiveGoalAfterMerge`
 *
 * Order is load-bearing per stale-pointer invalidation: state=complete must be persisted
 * BEFORE the archive flag flips. The harness short-circuits on
 * `archived && state === "complete"` to mark a subgoal step success
 * terminal — without the stamp it falls through to the rescue path and
 * may re-spawn.
 *
 * Cases:
 *   1. Order: at the moment archive() is called on the underlying store,
 *      the live goal record must already have state="complete".
 *   2. Idempotent: calling twice is safe (second call early-returns and
 *      does NOT re-archive or re-stamp updatedAt).
 *   3. Missing goal: silent no-op (logs a warning).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "archive-after-merge-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeManager(): { gm: GoalManager; store: GoalStore } {
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "general", name: "General", description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0, updatedAt: 0,
	}]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

describe("GoalManager.archiveGoalAfterMerge", () => {
	it("stamps state=complete BEFORE archive flips (stale-pointer invalidation ordering)", async () => {
		const { gm, store } = makeManager();
		const child = await gm.createGoal("Child", tmpRoot, { workflowId: "general" });
		assert.equal(child.state, "todo");

		// Spy on the store: capture the goal's `state` at the exact moment
		// archive() is invoked. If the order is correct, at this point the
		// row should already read state=complete.
		const realArchive = store.archive.bind(store);
		let stateAtArchive: string | undefined;
		store.archive = (id: string) => {
			const live = store.get(id);
			stateAtArchive = live?.state;
			return realArchive(id);
		};

		await gm.archiveGoalAfterMerge(child.id);
		assert.equal(stateAtArchive, "complete",
			"state=complete must be persisted BEFORE archive() is invoked");

		// And the final state on disk: complete + archived.
		const reloaded = store.get(child.id);
		assert.equal(reloaded?.state, "complete");
		assert.equal(reloaded?.archived, true);
		assert.ok(reloaded?.archivedAt && reloaded.archivedAt > 0);
	});

	it("idempotent: second call is a no-op", async () => {
		const { gm, store } = makeManager();
		const child = await gm.createGoal("Child", tmpRoot, { workflowId: "general" });

		await gm.archiveGoalAfterMerge(child.id);
		const first = store.get(child.id);
		const firstArchivedAt = first!.archivedAt;
		const firstUpdatedAt = first!.updatedAt;

		// Second call — should NOT re-flip archive, NOT bump updatedAt.
		// (The early-return short-circuit must fire before any store.update.)
		await new Promise(r => setTimeout(r, 5));
		await gm.archiveGoalAfterMerge(child.id);
		const second = store.get(child.id);

		assert.equal(second?.state, "complete");
		assert.equal(second?.archived, true);
		assert.equal(second?.archivedAt, firstArchivedAt,
			"archivedAt must not change on idempotent call");
		assert.equal(second?.updatedAt, firstUpdatedAt,
			"updatedAt must not change on idempotent call");
	});

	it("missing goal: silent no-op", async () => {
		const { gm } = makeManager();
		// No throw, no crash.
		await gm.archiveGoalAfterMerge("does-not-exist");
		// No assertion needed — the test just verifies it returns cleanly.
	});

	it("goal already complete + archived (e.g. from an earlier code path) is a no-op", async () => {
		// workflow-less complete-child recovery / pre-fix records: if a row is already in the success
		// terminal state, leaving it alone is correct.
		const { gm, store } = makeManager();
		const child = await gm.createGoal("Child", tmpRoot, { workflowId: "general" });
		store.update(child.id, { state: "complete" });
		store.archive(child.id);
		const before = store.get(child.id);

		await gm.archiveGoalAfterMerge(child.id);
		const after = store.get(child.id);
		assert.equal(after?.state, "complete");
		assert.equal(after?.archived, true);
		assert.equal(after?.archivedAt, before?.archivedAt);
	});
});
