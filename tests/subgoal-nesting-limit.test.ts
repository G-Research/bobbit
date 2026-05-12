/**
 * Subgoal nesting-limit policy — unit tests for `subgoal-nesting-limit.ts`,
 * plus the spawn-child rejection branch.
 *
 * Exercises the helpers (`nestingDepth`, `effectiveMaxNestingDepth`,
 * `effectiveSubgoalsAllowed`, `checkCanSpawnChild`) and the
 * preferences-store round-trip for `maxNestingDepth`.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";
import { PreferencesStore } from "../src/server/agent/preferences-store.ts";
import {
	readSubgoalNestingPrefs,
	clampMaxDepth,
	nestingDepth,
	effectiveMaxNestingDepth,
	effectiveSubgoalsAllowed,
	checkCanSpawnChild,
	inheritedChildOverrides,
	SYSTEM_MAX_NESTING_DEPTH_DEFAULT,
	SYSTEM_MAX_NESTING_DEPTH_MAX,
	SYSTEM_MAX_NESTING_DEPTH_MIN,
} from "../src/server/agent/subgoal-nesting-limit.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subgoal-nesting-"));
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

describe("clampMaxDepth", () => {
	it("clamps below min to min", () => {
		assert.equal(clampMaxDepth(0), SYSTEM_MAX_NESTING_DEPTH_MIN);
		assert.equal(clampMaxDepth(-5), SYSTEM_MAX_NESTING_DEPTH_MIN);
	});
	it("clamps above max to max", () => {
		assert.equal(clampMaxDepth(99), SYSTEM_MAX_NESTING_DEPTH_MAX);
	});
	it("returns default for non-finite", () => {
		assert.equal(clampMaxDepth(NaN), SYSTEM_MAX_NESTING_DEPTH_DEFAULT);
		assert.equal(clampMaxDepth(Infinity), SYSTEM_MAX_NESTING_DEPTH_DEFAULT);
	});
	it("rounds to integer", () => {
		assert.equal(clampMaxDepth(3.7), 3);
	});
});

describe("readSubgoalNestingPrefs", () => {
	it("returns defaults when prefs are empty", () => {
		const prefs = new PreferencesStore(stateDir);
		const r = readSubgoalNestingPrefs((k) => prefs.get(k));
		assert.equal(r.subgoalsEnabled, false);
		assert.equal(r.maxNestingDepth, SYSTEM_MAX_NESTING_DEPTH_DEFAULT);
	});

	it("round-trips maxNestingDepth via preferencesStore", () => {
		const prefs = new PreferencesStore(stateDir);
		prefs.set("subgoalsEnabled", true);
		prefs.set("maxNestingDepth", 5);
		const r = readSubgoalNestingPrefs((k) => prefs.get(k));
		assert.equal(r.subgoalsEnabled, true);
		assert.equal(r.maxNestingDepth, 5);
	});

	it("clamps an out-of-range stored value", () => {
		const prefs = new PreferencesStore(stateDir);
		prefs.set("maxNestingDepth", 50); // outside [1, 10]
		const r = readSubgoalNestingPrefs((k) => prefs.get(k));
		assert.equal(r.maxNestingDepth, SYSTEM_MAX_NESTING_DEPTH_MAX);
	});

	it("falls back to default on a non-numeric stored value", () => {
		const prefs = new PreferencesStore(stateDir);
		prefs.set("maxNestingDepth", "nonsense");
		const r = readSubgoalNestingPrefs((k) => prefs.get(k));
		assert.equal(r.maxNestingDepth, SYSTEM_MAX_NESTING_DEPTH_DEFAULT);
	});
});

describe("nestingDepth", () => {
	it("depth 1 for a root goal", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "parent" });
		assert.equal(nestingDepth(root, (id) => store.get(id)), 1);
	});

	it("depth 3 for a grandchild", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "parent" });
		const child = await gm.createGoal("Child", tmpRoot, { workflowId: "parent", parentGoalId: root.id });
		const gc = await gm.createGoal("GC", tmpRoot, { workflowId: "feature", parentGoalId: child.id });
		assert.equal(nestingDepth(gc, (id) => store.get(id)), 3);
	});

	it("bounded walk does not loop on corrupt cycle", async () => {
		// Synthesize a record whose parent chain loops back to itself.
		const store = new GoalStore(stateDir);
		const a: PersistedGoal = {
			id: "A", title: "A", cwd: tmpRoot, state: "todo", spec: "",
			createdAt: 0, updatedAt: 0, parentGoalId: "B", rootGoalId: "A",
		};
		const b: PersistedGoal = {
			id: "B", title: "B", cwd: tmpRoot, state: "todo", spec: "",
			createdAt: 0, updatedAt: 0, parentGoalId: "A", rootGoalId: "A",
		};
		store.put(a);
		store.put(b);
		const d = nestingDepth(a, (id) => store.get(id));
		assert.ok(d >= 1 && d < 64, `expected bounded depth, got ${d}`);
	});
});

describe("effectiveSubgoalsAllowed / effectiveMaxNestingDepth", () => {
	const sysOnDefault = { subgoalsEnabled: true, maxNestingDepth: 3 };
	const sysOff = { subgoalsEnabled: false, maxNestingDepth: 3 };

	it("system OFF wins regardless of per-goal", () => {
		const goal = { subgoalsAllowed: true, maxNestingDepth: 10 } as Partial<PersistedGoal> as PersistedGoal;
		assert.equal(effectiveSubgoalsAllowed(goal, sysOff), false);
	});

	it("per-goal subgoalsAllowed=false tightens system ON", () => {
		const goal = { subgoalsAllowed: false } as Partial<PersistedGoal> as PersistedGoal;
		assert.equal(effectiveSubgoalsAllowed(goal, sysOnDefault), false);
	});

	it("per-goal max cannot exceed system max", () => {
		const goal = { maxNestingDepth: 10 } as Partial<PersistedGoal> as PersistedGoal;
		assert.equal(effectiveMaxNestingDepth(goal, sysOnDefault), 3);
	});

	it("per-goal max below system applies (tightening)", () => {
		const goal = { maxNestingDepth: 2 } as Partial<PersistedGoal> as PersistedGoal;
		assert.equal(effectiveMaxNestingDepth(goal, sysOnDefault), 2);
	});
});

describe("checkCanSpawnChild", () => {
	const prefsOn3 = { subgoalsEnabled: true, maxNestingDepth: 3 };
	const prefsOff = { subgoalsEnabled: false, maxNestingDepth: 3 };

	it("system OFF → SUBGOALS_DISABLED", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "parent" });
		const r = checkCanSpawnChild(root, prefsOff, (id) => store.get(id));
		assert.equal(r.ok, false);
		assert.equal((r as any).code, "SUBGOALS_DISABLED");
	});

	it("per-goal subgoalsAllowed=false blocks even when system ON", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "parent", subgoalsAllowed: false });
		const r = checkCanSpawnChild(root, prefsOn3, (id) => store.get(id));
		assert.equal(r.ok, false);
		assert.equal((r as any).code, "SUBGOALS_DISABLED");
	});

	it("accepts when child depth would equal maxDepth", async () => {
		// depth(root)=1; spawning a child puts the new goal at depth 2.
		// With max=2, this should pass (currentDepth + 1 == max).
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "parent" });
		const r = checkCanSpawnChild(root, { subgoalsEnabled: true, maxNestingDepth: 2 }, (id) => store.get(id));
		assert.equal(r.ok, true);
	});

	it("rejects with NESTING_DEPTH_EXCEEDED when child depth would exceed max", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "parent" });
		const child = await gm.createGoal("Child", tmpRoot, { workflowId: "parent", parentGoalId: root.id });
		const gc = await gm.createGoal("GC", tmpRoot, { workflowId: "parent", parentGoalId: child.id });
		// gc is depth=3; with max=3, spawning a child off gc would be depth 4 → reject.
		const r = checkCanSpawnChild(gc, prefsOn3, (id) => store.get(id));
		assert.equal(r.ok, false);
		const fail = r as Exclude<typeof r, { ok: true }>;
		assert.equal(fail.code, "NESTING_DEPTH_EXCEEDED");
		assert.equal((fail as any).currentDepth, 3);
		assert.equal((fail as any).maxDepth, 3);
	});

	it("per-goal max=1 blocks even a first child off the root", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, { workflowId: "parent", maxNestingDepth: 1 });
		const r = checkCanSpawnChild(root, prefsOn3, (id) => store.get(id));
		assert.equal(r.ok, false);
		assert.equal((r as any).code, "NESTING_DEPTH_EXCEEDED");
	});
});

describe("inheritedChildOverrides", () => {
	it("propagates parent's effective ceiling onto a new child", async () => {
		const { gm, store } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, {
			workflowId: "parent", subgoalsAllowed: true, maxNestingDepth: 2,
		});
		const overrides = inheritedChildOverrides(root, { subgoalsEnabled: true, maxNestingDepth: 5 });
		assert.equal(overrides.subgoalsAllowed, true);
		// min(5, 2) == 2.
		assert.equal(overrides.maxNestingDepth, 2);
		assert.ok(store.get(root.id));
	});

	it("system OFF squashes inherited allowed to false", async () => {
		const { gm } = makeManager();
		const root = await gm.createGoal("Root", tmpRoot, {
			workflowId: "parent", subgoalsAllowed: true, maxNestingDepth: 3,
		});
		const overrides = inheritedChildOverrides(root, { subgoalsEnabled: false, maxNestingDepth: 3 });
		assert.equal(overrides.subgoalsAllowed, false);
	});
});

describe("GoalManager.createGoal — persists per-goal overrides", () => {
	it("stores subgoalsAllowed and maxNestingDepth when supplied", async () => {
		const { gm, store } = makeManager();
		const goal = await gm.createGoal("G", tmpRoot, {
			workflowId: "parent",
			subgoalsAllowed: false,
			maxNestingDepth: 2,
		});
		const persisted = store.get(goal.id);
		assert.equal(persisted?.subgoalsAllowed, false);
		assert.equal(persisted?.maxNestingDepth, 2);
	});

	it("leaves fields undefined when not supplied (lazy-migration default)", async () => {
		const { gm, store } = makeManager();
		const goal = await gm.createGoal("G", tmpRoot, { workflowId: "parent" });
		const persisted = store.get(goal.id);
		assert.equal(persisted?.subgoalsAllowed, undefined);
		assert.equal(persisted?.maxNestingDepth, undefined);
	});
});
