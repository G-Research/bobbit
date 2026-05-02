/**
 * Phase 1 — Lesson 4.3: GoalManager constructed without a WorkflowStore must
 * fail loudly when workflowId is given but neither resolvedWorkflow nor a
 * workflowStore is available.
 *
 * On PR #409, a child goal `context-fencing` was created with
 * `workflow: undefined`. Its lone coder did the work, was dismissed cleanly,
 * but the goal had no gates. `ready-to-merge` could never pass; the harness
 * wait loop polled forever.
 *
 * Root cause: `project-context.ts` constructed `new GoalManager(this.goalStore)`
 * — only one arg, no workflowStore. When `runSubgoalStep` called
 * `createGoal({workflowId: "feature"})`, GoalManager hit the workflow
 * resolution branch where workflowStore was undefined, so the branch was
 * skipped and the code fell through to "no workflow set" — silently.
 *
 * The fix:
 * 1. Project-context wires workflowStore into the manager (covered by
 *    project-context construction, integration tests).
 * 2. createGoal throws clearly if workflowId is given but neither
 *    resolvedWorkflow nor workflowStore was provided — this test.
 *
 * The legacy "no workflowId, no workflowStore → workflow undefined" path is
 * preserved for assistant sessions and test fixtures.
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
import { InlineWorkflowStore, type Workflow } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let configDir: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goal-manager-ws-required-"));
	configDir = path.join(tmpRoot, "config");
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(configDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeFeatureWorkflow(): Workflow {
	return {
		id: "feature",
		name: "Feature",
		description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("GoalManager — Lesson 4.3 fail-loud branch", () => {
	it("throws when workflowId is given but no workflowStore was constructed AND no resolvedWorkflow was passed", async () => {
		// Construct manager with NO workflowStore (the buggy PR #409 setup).
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore);
		await assert.rejects(
			() => gm.createGoal("test", tmpRoot, { workflowId: "feature" }),
			/Lesson 4.3/,
		);
	});

	it("throws with the same message even if workflowStore is passed via opts but is empty (returns undefined)", async () => {
		// Subtle: workflowStore is provided via opts but get(id) returns
		// undefined for the requested id AND getAll() returns empty — this
		// hits the canonical "no workflows configured" message, NOT the
		// Lesson 4.3 path. Verifies the two error paths don't overlap.
		const goalStore = new GoalStore(stateDir);
		const cfg = new ProjectConfigStore(configDir);
		const wf = new InlineWorkflowStore(cfg);
		const gm = new GoalManager(goalStore, wf);
		await assert.rejects(
			() => gm.createGoal("test", tmpRoot, { workflowId: "missing", workflowStore: wf }),
			/no workflows configured/i,
		);
	});

	it("throws 'Workflow not found' when workflowStore has other workflows but not the requested id", async () => {
		const goalStore = new GoalStore(stateDir);
		const cfg = new ProjectConfigStore(configDir);
		const wf = new InlineWorkflowStore(cfg);
		wf.setBuiltins([makeFeatureWorkflow()]);
		const gm = new GoalManager(goalStore, wf);
		await assert.rejects(
			() => gm.createGoal("test", tmpRoot, { workflowId: "missing", workflowStore: wf }),
			/Workflow not found: missing/,
		);
	});

	it("succeeds when GoalManager was constructed WITH a workflowStore that has the requested workflow", async () => {
		const goalStore = new GoalStore(stateDir);
		const cfg = new ProjectConfigStore(configDir);
		const wf = new InlineWorkflowStore(cfg);
		wf.setBuiltins([makeFeatureWorkflow()]);
		const gm = new GoalManager(goalStore, wf);
		const goal = await gm.createGoal("test", tmpRoot, { workflowId: "feature" });
		assert.equal(goal.workflowId, "feature");
		assert.ok(goal.workflow, "goal.workflow must be a snapshot");
		assert.equal(goal.workflow.id, "feature");
	});

	it("legacy path: no workflowId, no workflowStore → succeeds with workflow undefined", async () => {
		// This is the PRESERVED legacy path for assistant sessions and test
		// fixtures. Don't break it.
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore);
		const goal = await gm.createGoal("test", tmpRoot, {});
		assert.equal(goal.workflowId, undefined);
		assert.equal(goal.workflow, undefined);
	});

	it("legacy path: resolvedWorkflow passed in directly succeeds even without workflowStore", async () => {
		// Caller pre-resolves the workflow via the config cascade and hands
		// the snapshot to createGoal. No workflowStore required.
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore);
		const goal = await gm.createGoal("test", tmpRoot, {
			workflowId: "feature",
			resolvedWorkflow: makeFeatureWorkflow(),
		});
		assert.equal(goal.workflowId, "feature");
		assert.ok(goal.workflow);
		assert.equal(goal.workflow.id, "feature");
	});

	it("error message references docs/_phase-1-notes.md so future debuggers can find the lesson", async () => {
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore);
		await assert.rejects(
			() => gm.createGoal("test", tmpRoot, { workflowId: "feature" }),
			/docs\/_phase-1-notes\.md/,
		);
	});
});
