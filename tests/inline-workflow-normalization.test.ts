/**
 * Regression: inline workflows passed via `resolvedWorkflow` on `createGoal`
 * must be normalized from YAML shape (snake_case `depends_on`,
 * `inject_downstream`) to runtime shape (camelCase) before being snapshotted
 * onto the goal.
 *
 * Before the fix, `body.workflow` on POST /api/goals and `goal_spawn_child`
 * bypassed normalization; gates with `depends_on` were stored as-is and then
 * `gateDef.dependsOn` returned undefined at signal time, breaking
 * `gate_signal` with "dependsOn is not iterable" and freezing the team lead
 * mid-signal.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore, normalizeWorkflow } from "../src/server/agent/workflow-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { GoalStore } from "../src/server/agent/goal-store.ts";

let tmpRoot: string;
let configDir: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inline-wf-normalize-"));
	configDir = path.join(tmpRoot, "config");
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(configDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "project.yaml"), "");
});

describe("normalizeWorkflow — snake_case to camelCase", () => {
	it("maps depends_on → dependsOn on every gate", () => {
		const raw = {
			id: "x",
			name: "X",
			gates: [
				{ id: "a", name: "A" },
				{ id: "b", name: "B", depends_on: ["a"] },
				{ id: "c", name: "C", depends_on: ["b"], inject_downstream: true },
			],
		};
		const wf = normalizeWorkflow(raw, "x");
		assert.ok(wf);
		assert.deepEqual(wf!.gates[0].dependsOn, []);
		assert.deepEqual(wf!.gates[1].dependsOn, ["a"]);
		assert.deepEqual(wf!.gates[2].dependsOn, ["b"]);
		assert.equal(wf!.gates[2].injectDownstream, true);
	});

	it("preserves already-normalized dependsOn", () => {
		const raw = {
			id: "x",
			name: "X",
			gates: [{ id: "b", name: "B", dependsOn: ["a"] }],
		};
		const wf = normalizeWorkflow(raw, "x");
		assert.deepEqual(wf!.gates[0].dependsOn, ["a"]);
	});
});

describe("GoalManager.createGoal — inline workflow is normalized", () => {
	it("snake_case gates get dependsOn populated on the goal snapshot", async () => {
		const cfg = new ProjectConfigStore(configDir);
		const store = new InlineWorkflowStore(cfg);
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore, store);

		const inlineWorkflow = {
			id: "inline-test",
			name: "Inline Test",
			description: "",
			gates: [
				{ id: "execution", name: "Execution" },
				{ id: "synthesis", name: "Synthesis", depends_on: ["execution"] },
				{ id: "ready-to-merge", name: "Ready", depends_on: ["synthesis"] },
			],
		};

		const goal = await gm.createGoal("t", tmpRoot, {
			workflowId: "inline-test",
			resolvedWorkflow: inlineWorkflow as any,
			workflowStore: store,
		});

		assert.ok(goal.workflow);
		for (const g of goal.workflow!.gates) {
			assert.ok(Array.isArray(g.dependsOn), `gate ${g.id} must have Array dependsOn`);
		}
		assert.deepEqual(goal.workflow!.gates[0].dependsOn, []);
		assert.deepEqual(goal.workflow!.gates[1].dependsOn, ["execution"]);
		assert.deepEqual(goal.workflow!.gates[2].dependsOn, ["synthesis"]);
	});
});

describe("GoalStore — lazy migration of stored YAML-shape workflows", () => {
	it("load() normalizes goals that were persisted with depends_on", () => {
		// Write a goals.json whose workflow snapshot is in YAML shape — the
		// exact state produced by the pre-fix inline-workflow path.
		const goalsJson = [{
			id: "g1",
			title: "t",
			cwd: tmpRoot,
			state: "todo",
			spec: "",
			createdAt: 1,
			updatedAt: 1,
			workflowId: "inline",
			workflow: {
				id: "inline",
				name: "Inline",
				description: "",
				createdAt: 1,
				updatedAt: 1,
				gates: [
					{ id: "execution", name: "Execution" },
					{ id: "synthesis", name: "Synthesis", depends_on: ["execution"] },
				],
			},
		}];
		fs.writeFileSync(path.join(stateDir, "goals.json"), JSON.stringify(goalsJson));

		const store = new GoalStore(stateDir);
		const loaded = store.get("g1");
		assert.ok(loaded);
		assert.ok(loaded!.workflow);
		for (const g of loaded!.workflow!.gates) {
			assert.ok(Array.isArray(g.dependsOn), `gate ${g.id} must have Array dependsOn post-load`);
		}
		assert.deepEqual(loaded!.workflow!.gates[1].dependsOn, ["execution"]);
	});
});
