/**
 * REPRODUCING TEST — sub-goal creation UX bug (issue analysis gate).
 *
 * SSOT (`subgoal-nesting-limit.ts`) layer.
 *
 * BUG: when the SYSTEM pref `subgoalsEnabled` is ON but the selected PARENT
 * goal carries `subgoalsAllowed: false`, `checkCanSpawnChild` collapses the
 * outcome onto the SAME `SUBGOALS_DISABLED` code used for the system-off case.
 * That collision is why creating a child under such a parent surfaces the
 * confusing "Subgoals are disabled" message even though the system toggle is
 * ON, and is indistinguishable from the genuine system-off block.
 *
 * Expected behaviour (post-fix): the parent-disallows case must return a
 * DISTINCT code — `PARENT_SUBGOALS_DISABLED` — while the genuine system-off
 * case keeps returning `SUBGOALS_DISABLED`. This file pins both.
 *
 * The parent-disabled assertions FAIL on the current tree (they get
 * `SUBGOALS_DISABLED`); the system-off assertions already pass and guard
 * against a regression of the system-level gate.
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
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subgoal-parent-disabled-"));
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
			id: "parent", name: "Parent", description: "",
			gates: [
				{ id: "execution", name: "Execution", dependsOn: [] },
				{ id: "ready-to-merge", name: "Ready", dependsOn: ["execution"] },
			],
			createdAt: 0, updatedAt: 0,
		},
	]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

const SYSTEM_ON = { subgoalsEnabled: true, maxNestingDepth: 3 };
const SYSTEM_OFF = { subgoalsEnabled: false, maxNestingDepth: 3 };

describe("checkCanSpawnChild — distinct parent-disabled vs system-off (RED repro)", () => {
	it("system ON + parent.subgoalsAllowed=false → PARENT_SUBGOALS_DISABLED (distinct from system-off)", async () => {
		const { gm, store } = makeManager();
		const parent = await gm.createGoal("Per-goal worktree setup hook", tmpRoot, {
			workflowId: "parent",
			subgoalsAllowed: false,
		});
		const r = checkCanSpawnChild(parent, SYSTEM_ON, (id) => store.get(id));
		assert.equal(r.ok, false, "must block — parent disallows sub-goals");
		// The crux of the bug: this is a PARENT-level block while the SYSTEM
		// toggle is ON, so it MUST NOT reuse the system-off code/string.
		assert.equal(
			(r as any).code,
			"PARENT_SUBGOALS_DISABLED",
			"parent-disallows must be distinct from the system-off SUBGOALS_DISABLED",
		);
		assert.notEqual(
			(r as any).code,
			"SUBGOALS_DISABLED",
			"must NOT collapse onto the system-off code when the system pref is ON",
		);
	});

	it("system OFF → SUBGOALS_DISABLED preserved (system gate non-regression)", async () => {
		const { gm, store } = makeManager();
		const parent = await gm.createGoal("Top", tmpRoot, { workflowId: "parent" });
		const r = checkCanSpawnChild(parent, SYSTEM_OFF, (id) => store.get(id));
		assert.equal(r.ok, false);
		assert.equal(
			(r as any).code,
			"SUBGOALS_DISABLED",
			"system-off must keep the system-level code",
		);
	});

	it("system OFF + parent.subgoalsAllowed=false → SUBGOALS_DISABLED (system gate wins)", async () => {
		const { gm, store } = makeManager();
		const parent = await gm.createGoal("Top", tmpRoot, {
			workflowId: "parent",
			subgoalsAllowed: false,
		});
		const r = checkCanSpawnChild(parent, SYSTEM_OFF, (id) => store.get(id));
		assert.equal(r.ok, false);
		assert.equal(
			(r as any).code,
			"SUBGOALS_DISABLED",
			"when the system pref is OFF, the system-level code is the master gate",
		);
	});

	it("system ON + parent allows sub-goals → ok (no false block)", async () => {
		const { gm, store } = makeManager();
		const parent = await gm.createGoal("Top", tmpRoot, {
			workflowId: "parent",
			subgoalsAllowed: true,
		});
		const r = checkCanSpawnChild(parent, SYSTEM_ON, (id) => store.get(id));
		assert.equal(r.ok, true);
	});
});
