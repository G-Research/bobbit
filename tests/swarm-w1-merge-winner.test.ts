/**
 * SWARM-W1 — `GoalManager.mergeChild`'s one escape hatch:
 * `opts.forceIntegrateSwarmWinner`. design/swarm-orchestration.md §5.1's
 * SWARM-W0 suppression (`skippedSwarmGroup`) must hold BY DEFAULT for every
 * existing caller (zero behavior change — see `swarm-w0-merge-suppression
 * .test.ts`, still passing unmodified); this pins the ONE new path: the
 * confirm route (`swarm-routes.ts`, after a human has consumed a one-shot
 * operator-confirmation token) can force the REAL merge path to run for a
 * swarm-tagged child.
 *
 * Mirrors `swarm-w0-merge-suppression.test.ts`'s no-git-repo fixture: since
 * neither goal has a branch/worktree, a REAL merge attempt throws
 * `GOAL_GIT_UNAVAILABLE` — proving the git path was reached (the skip was
 * bypassed) without needing a full two-repo git fixture (that end-to-end
 * real-merge proof lives in `tests/e2e/api-swarm-best-of-n.spec.ts`, which
 * uses a real git repo).
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
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w1-merge-winner-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeManager(): GoalManager {
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([
		{ id: "feature", name: "Feature", description: "", gates: [{ id: "ready-to-merge", name: "Ready", dependsOn: [] }], createdAt: 0, updatedAt: 0 },
	]);
	return new GoalManager(goalStore, wf);
}

describe("GoalManager.mergeChild — forceIntegrateSwarmWinner escape hatch", () => {
	it("default (opts omitted): a swarm child is STILL skipped — zero behavior change vs SWARM-W0", async () => {
		const gm = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Worker", tmpRoot, { workflowId: "feature", parentGoalId: root.id, swarmGroup: "grp-1" });
		const outcome = await gm.mergeChild(root.id, child.id);
		assert.equal(outcome.skippedSwarmGroup, true);
	});

	it("forceIntegrateSwarmWinner:false explicitly: still skipped (only `true` bypasses)", async () => {
		const gm = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Worker", tmpRoot, { workflowId: "feature", parentGoalId: root.id, swarmGroup: "grp-1" });
		const outcome = await gm.mergeChild(root.id, child.id, { forceIntegrateSwarmWinner: false });
		assert.equal(outcome.skippedSwarmGroup, true);
	});

	it("forceIntegrateSwarmWinner:true bypasses the swarm skip and reaches the REAL merge path (proven by GOAL_GIT_UNAVAILABLE in a no-git fixture, same as a non-swarm child)", async () => {
		const gm = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Worker", tmpRoot, { workflowId: "feature", parentGoalId: root.id, swarmGroup: "grp-1" });
		await assert.rejects(
			() => gm.mergeChild(root.id, child.id, { forceIntegrateSwarmWinner: true }),
			(err: any) => err.code === "GOAL_GIT_UNAVAILABLE",
			"forcing must reach the SAME git path a non-swarm child hits — no longer short-circuited",
		);
	});

	it("a non-swarm child is unaffected by the opts param either way (it never carries swarmGroup, so the branch is never taken)", async () => {
		const gm = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Child", tmpRoot, { workflowId: "feature", parentGoalId: root.id });
		await assert.rejects(
			() => gm.mergeChild(root.id, child.id, { forceIntegrateSwarmWinner: true }),
			(err: any) => err.code === "GOAL_GIT_UNAVAILABLE",
		);
	});
});
