/**
 * Pinned regression: archiveGoalAfterMerge stamps state="complete"
 * before flipping archived=true, so merge-driven archives leave the
 * goal record in a structurally-coherent terminal state.
 *
 * Live test (PR #409 v0.1-foundation): goal 317cdb83 was archived
 * via the eager-merge IIFE after its branch merged into the parent's
 * branch. The legacy archiveGoal flipped archived=true but left
 * state="in-progress". The Plan tab's resolvePlanNodeState walker
 * then mapped archived+in-progress to "failed" (red) for the
 * following Plan-tab cards \u2014 shadowing the actual success.
 *
 * Fix: new `archiveGoalAfterMerge(id)` helper sets state="complete"
 * THEN archives. The four merge-driven sites (runSubgoalStep,
 * eager-merge IIFE, integrate-child REST, manual-merge reconciliation)
 * use this helper. The legacy `archiveGoal` stays for non-merge
 * archives (cancellation, zombie cleanup, user delete) where state
 * shouldn't be silently flipped.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.js";
import { GoalManager } from "../src/server/agent/goal-manager.js";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.js";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.js";

let tmpDir: string;
let stateDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-after-merge-test-"));
	stateDir = path.join(tmpDir, "state");
	fs.mkdirSync(stateDir, { recursive: true });
});

after(() => {
	if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeManager(): { gm: GoalManager; store: GoalStore } {
	const cfg = new ProjectConfigStore(path.join(tmpDir, "project.yaml"));
	const wf = new InlineWorkflowStore(cfg);
	const store = new GoalStore(stateDir + "-" + Math.random().toString(36).slice(2, 8));
	const gm = new GoalManager(store, wf);
	return { gm, store };
}

function putGoalDirect(store: GoalStore, overrides: Partial<PersistedGoal> & { id: string }): PersistedGoal {
	const g: PersistedGoal = {
		title: overrides.title ?? `Goal ${overrides.id}`,
		cwd: tmpDir,
		state: "in-progress",
		spec: "",
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as PersistedGoal;
	store.put(g);
	return g;
}

describe("GoalManager.archiveGoalAfterMerge", () => {
	it("THE bug: stamps state='complete' before archiving an in-progress goal", () => {
		// Live-test pattern: child branch merged via eager-merge IIFE,
		// goal record had `state: in-progress`. After fix: archived +
		// state=complete (success terminal).
		const { gm, store } = makeManager();
		putGoalDirect(store, { id: "g1", state: "in-progress" });
		gm.archiveGoalAfterMerge("g1");
		const after = store.get("g1");
		assert.equal(after?.state, "complete");
		assert.equal(after?.archived, true);
	});

	it("preserves state='complete' if already set (idempotent on success terminal)", () => {
		const { gm, store } = makeManager();
		putGoalDirect(store, { id: "g1", state: "complete" });
		gm.archiveGoalAfterMerge("g1");
		const after = store.get("g1");
		assert.equal(after?.state, "complete");
		assert.equal(after?.archived, true);
	});

	it("flips state from todo \u2192 complete on merge-driven archive", () => {
		// Defensive: if a goal somehow wasn't in 'in-progress' but was
		// merged anyway (manual flow), still mark it complete.
		const { gm, store } = makeManager();
		putGoalDirect(store, { id: "g1", state: "todo" });
		gm.archiveGoalAfterMerge("g1");
		const after = store.get("g1");
		assert.equal(after?.state, "complete");
	});

	it("flips state from shelved \u2192 complete on merge-driven archive (defensive)", () => {
		// If the goal was somehow shelved but a merge ALSO landed,
		// the merge wins \u2014 we trust the caller (merge succeeded).
		const { gm, store } = makeManager();
		putGoalDirect(store, { id: "g1", state: "shelved" });
		gm.archiveGoalAfterMerge("g1");
		const after = store.get("g1");
		assert.equal(after?.state, "complete");
	});

	it("returns false (no-op) on a missing goal id (defensive)", async () => {
		const { gm } = makeManager();
		const result = await gm.archiveGoalAfterMerge("does-not-exist");
		assert.equal(result, false);
	});

	it("the legacy archiveGoal does NOT flip state (non-merge archives preserve user intent)", () => {
		// User cancelling an in-progress goal: don't lie about it
		// being \"complete\" \u2014 archived+in-progress is the right shape.
		const { gm, store } = makeManager();
		putGoalDirect(store, { id: "g1", state: "in-progress" });
		gm.archiveGoal("g1");
		const after = store.get("g1");
		assert.equal(after?.state, "in-progress");
		assert.equal(after?.archived, true);
	});
});
