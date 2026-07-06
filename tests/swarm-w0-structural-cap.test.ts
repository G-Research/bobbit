/**
 * SWARM-W0 — structural depth/recursion cap (design/swarm-orchestration.md §9
 * "Structural recursion cap"; docs/design/swarm-orchestration-w0.md).
 *
 * A goal created with `swarmGroup` set is a LOWERED swarm-worker node:
 * `GoalManager.createGoal` unconditionally forces BOTH `subgoalsAllowed=false`
 * AND `maxNestingDepth=0` on it (belt-and-braces — one missed field is the
 * blast radius), regardless of any caller-passed override. The actual spawn
 * REJECTION enforcement point is `checkCanSpawnChild`
 * (subgoal-nesting-limit.ts) — the REST `POST /api/goals/:id/spawn-child`
 * handler and `runSubgoalStep` both gate on it before spawning a child off a
 * parent goal. There is no separate goal-level `assertCanSpawn` function
 * (that name belongs to a DIFFERENT mechanism, `OrchestrationCore.assertCanSpawn`
 * in orchestration-core.ts, which guards session-level delegate/team-child
 * recursion — unrelated to goal subgoal spawning); `checkCanSpawnChild` is the
 * real goal-spawn enforcement point pinned below.
 *
 * Nothing creates a swarmGroup-tagged goal in production yet — this is a
 * seam exercised only by tests, consumed by SWARM-W1+.
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
import { checkCanSpawnChild } from "../src/server/agent/subgoal-nesting-limit.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-w0-cap-"));
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
			gates: [
				{ id: "implementation", name: "Implementation", dependsOn: [] },
				{ id: "ready-to-merge", name: "Ready", dependsOn: ["implementation"] },
			],
			createdAt: 0, updatedAt: 0,
		},
	]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

const prefsOn3 = { subgoalsEnabled: true, maxNestingDepth: 3 };

describe("SWARM-W0 — createGoal forces the cap on swarmGroup-tagged goals", () => {
	it("stamps swarmGroup and FORCES subgoalsAllowed=false + maxNestingDepth=0, even overriding an explicit opposite caller value", async () => {
		const { gm } = makeManager();
		const worker = await gm.createGoal("Worker", tmpRoot, {
			workflowId: "feature",
			swarmGroup: "grp-1",
			// A caller that forgot the swarm invariant and asked for the OPPOSITE —
			// belt-and-braces means swarmGroup wins regardless.
			subgoalsAllowed: true,
			maxNestingDepth: 5,
		});
		assert.equal(worker.swarmGroup, "grp-1");
		assert.equal(worker.subgoalsAllowed, false);
		assert.equal(worker.maxNestingDepth, 0);
	});

	it("stamps the cap even with no explicit subgoalsAllowed/maxNestingDepth passed", async () => {
		const { gm } = makeManager();
		const worker = await gm.createGoal("Worker", tmpRoot, { workflowId: "feature", swarmGroup: "grp-2" });
		assert.equal(worker.subgoalsAllowed, false);
		assert.equal(worker.maxNestingDepth, 0);
	});

	it("merge-all regression: a swarmGroup-tagged worker still gets the same unconditional structural cap", async () => {
		const { gm } = makeManager();
		const worker = await gm.createGoal("Merge-all worker", tmpRoot, { workflowId: "feature", swarmGroup: "grp-merge-all" });
		assert.equal(worker.swarmGroup, "grp-merge-all");
		assert.equal(worker.subgoalsAllowed, false);
		assert.equal(worker.maxNestingDepth, 0);
	});

	it("zero-behavior-change: a NON-swarm goal's subgoalsAllowed/maxNestingDepth are byte-identical to today", async () => {
		const { gm } = makeManager();
		const goal = await gm.createGoal("Regular", tmpRoot, {
			workflowId: "feature",
			subgoalsAllowed: true,
			maxNestingDepth: 5,
		});
		assert.equal(goal.swarmGroup, undefined);
		assert.equal(goal.subgoalsAllowed, true);
		assert.equal(goal.maxNestingDepth, 5);
	});

	it("zero-behavior-change: omitting swarmGroup entirely leaves subgoalsAllowed/maxNestingDepth undefined (today's default)", async () => {
		const { gm } = makeManager();
		const goal = await gm.createGoal("Regular2", tmpRoot, { workflowId: "feature" });
		assert.equal(goal.swarmGroup, undefined);
		assert.equal(goal.subgoalsAllowed, undefined);
		assert.equal(goal.maxNestingDepth, undefined);
	});
});

describe("SWARM-W0 — checkCanSpawnChild rejects spawn attempts from a lowered swarm worker", () => {
	it("subgoalsAllowed=false ALONE blocks — PARENT_SUBGOALS_DISABLED (belt: field 1)", async () => {
		const { gm, store } = makeManager();
		// Simulates a worker where only ONE of the two belt-and-braces fields
		// landed (the other tightening, maxNestingDepth, left at the system
		// default) — proves subgoalsAllowed=false is independently sufficient
		// to block, per "one missed field is the blast radius".
		const worker = await gm.createGoal("Worker", tmpRoot, {
			workflowId: "feature",
			subgoalsAllowed: false,
		});
		const r = checkCanSpawnChild(worker, prefsOn3, (id) => store.get(id));
		assert.equal(r.ok, false);
		assert.equal((r as any).code, "PARENT_SUBGOALS_DISABLED");
	});

	it("maxNestingDepth=0 ALONE blocks — NESTING_DEPTH_EXCEEDED (belt: field 2, braces)", async () => {
		const { gm, store } = makeManager();
		// Inverse of the above: subgoalsAllowed left unset (system default
		// applies), only maxNestingDepth=0 forced. Depth is clamped to the
		// system MIN (1) by `clampMaxDepth`, but since a goal's own
		// `nestingDepth` is always >= 1, `currentDepth + 1 > 1` always holds —
		// so the effective-0 request still blocks every spawn attempt.
		const worker = await gm.createGoal("Worker", tmpRoot, {
			workflowId: "feature",
			maxNestingDepth: 0,
		});
		const r = checkCanSpawnChild(worker, prefsOn3, (id) => store.get(id));
		assert.equal(r.ok, false);
		assert.equal((r as any).code, "NESTING_DEPTH_EXCEEDED");
	});

	it("a real swarm-tagged worker (both fields forced by createGoal) rejects a spawn attempt", async () => {
		const { gm, store } = makeManager();
		const worker = await gm.createGoal("Worker", tmpRoot, { workflowId: "feature", swarmGroup: "grp-3" });
		const r = checkCanSpawnChild(worker, prefsOn3, (id) => store.get(id));
		assert.equal(r.ok, false);
		// PARENT_SUBGOALS_DISABLED wins because it is checked first in
		// checkCanSpawnChild — either field alone would already have blocked
		// (see the two tests above).
		assert.equal((r as any).code, "PARENT_SUBGOALS_DISABLED");
	});

	it("zero-behavior-change: a non-swarm child goal can still spawn its own children normally", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "feature" });
		const r = checkCanSpawnChild(root, prefsOn3, (id) => store.get(id));
		assert.equal(r.ok, true);
	});
});
