/**
 * SWARM-W0 — suppress auto git-merge for swarm siblings ONLY
 * (design/swarm-orchestration.md §5.1; docs/design/swarm-orchestration-w0.md).
 *
 * `GoalManager.mergeChild` is the SINGLE choke point for every auto-merge
 * caller (REST `integrate-child`, both `runSubgoalStep` merge paths) — see
 * goal-manager.ts. Pinned here directly at that choke point:
 *   - a swarmGroup-tagged child's merge is skipped ENTIRELY (no git op
 *     attempted at all — proven by NOT throwing GOAL_GIT_UNAVAILABLE even
 *     though this fixture goal has no branch/worktree).
 *   - a non-swarm child is COMPLETELY unaffected (byte-identical: still
 *     throws GOAL_GIT_UNAVAILABLE in the same no-branch fixture).
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
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w0-merge-"));
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
	wf.setBuiltins([
		{
			id: "feature", name: "Feature", description: "",
			gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }],
			createdAt: 0, updatedAt: 0,
		},
	]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

describe("SWARM-W0 — GoalManager.mergeChild suppresses the auto-merge for swarm siblings", () => {
	it("a swarmGroup child returns skippedSwarmGroup=true WITHOUT attempting any git operation", async () => {
		const { gm } = makeManager();
		// tmpRoot is not a git repo, so createGoal leaves worktreePath/branch
		// undefined for both goals — a REAL merge attempt would throw
		// GOAL_GIT_UNAVAILABLE (see the non-swarm pin below). The swarm branch
		// must return cleanly instead, proving the git path was never reached.
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Worker", tmpRoot, {
			workflowId: "feature",
			parentGoalId: root.id,
			swarmGroup: "grp-1",
		});

		const outcome = await gm.mergeChild(root.id, child.id);
		assert.equal(outcome.skippedSwarmGroup, true);
		assert.equal(outcome.merged, false);
		assert.equal(outcome.alreadyMerged, false);
		assert.equal(outcome.conflict, false);
		assert.equal(outcome.pushed, false);
		assert.match(outcome.output, /swarm sibling/i);
	});

	it("zero-behavior-change: a NON-swarm child is completely unaffected — still throws GOAL_GIT_UNAVAILABLE in the exact same fixture", async () => {
		const { gm } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "feature",
			parentGoalId: root.id,
			// no swarmGroup
		});

		await assert.rejects(
			() => gm.mergeChild(root.id, child.id),
			(err: any) => err.code === "GOAL_GIT_UNAVAILABLE",
		);
	});
});
