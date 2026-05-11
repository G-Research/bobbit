/**
 * Pinning test for GoalManager workflow defaulting.
 *
 * Resolution order (after the "Robust goal workflow UX" goal):
 *   1. Explicit workflowId → look up in store, throw "Workflow not found: <id>"
 *      if absent (or NO_WORKFLOWS_MSG if the store is empty).
 *   2. No workflowId, non-empty store → first workflow in store order
 *      (insertion order — preserves config-cascade priority).
 *   3. No workflowId, empty store → throws NO_WORKFLOWS_MSG.
 *
 * No layer should ever name the literal id "general" as a default.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GoalManager } from "../src/server/agent/goal-manager.js";
import { GoalStore } from "../src/server/agent/goal-store.js";
import type { Workflow, WorkflowStore } from "../src/server/agent/workflow-store.js";

const NO_WORKFLOWS_MSG =
	"This project has no workflows configured. Run project setup or generate workflows from Settings → project tab.";

function makeWorkflow(id: string): Workflow {
	return {
		id,
		name: `${id} workflow`,
		description: `${id} description`,
		gates: [],
		createdAt: 1,
		updatedAt: 1,
	} as unknown as Workflow;
}

function makeStore(items: Workflow[]): WorkflowStore {
	const map = new Map<string, Workflow>(items.map(w => [w.id, w]));
	return {
		get: (id: string) => map.get(id),
		getAll: () => items.slice(),
	} as unknown as WorkflowStore;
}

function makeManager() {
	const dir = mkdtempSync(join(tmpdir(), "bobbit-gm-default-wf-"));
	const store = new GoalStore(dir);
	const mgr = new GoalManager(store);
	return { mgr, dir };
}

describe("GoalManager workflow defaulting", () => {
	it("falls back to the first workflow in store order when no id is supplied", async () => {
		const { mgr, dir } = makeManager();
		try {
			const wfFoo = makeWorkflow("foo");
			const wfBar = makeWorkflow("bar");
			const goal = await mgr.createGoal("test goal", dir, {
				workflowStore: makeStore([wfFoo, wfBar]),
			});
			assert.equal(goal.workflowId, "foo", "expected first workflow id");
			assert.equal(goal.workflow?.id, "foo", "expected workflow snapshot to be foo");
			// Order is preserved if we swap.
			const goal2 = await mgr.createGoal("test goal 2", dir, {
				workflowStore: makeStore([wfBar, wfFoo]),
			});
			assert.equal(goal2.workflowId, "bar");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws NO_WORKFLOWS_MSG when no id supplied and the store is empty", async () => {
		const { mgr, dir } = makeManager();
		try {
			await assert.rejects(
				() => mgr.createGoal("empty goal", dir, { workflowStore: makeStore([]) }),
				(err: Error) => err.message === NO_WORKFLOWS_MSG,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws 'Workflow not found' when an explicit unknown id is supplied to a non-empty store", async () => {
		const { mgr, dir } = makeManager();
		try {
			const wfFoo = makeWorkflow("foo");
			await assert.rejects(
				() => mgr.createGoal("missing-id goal", dir, {
					workflowId: "missing",
					workflowStore: makeStore([wfFoo]),
				}),
				(err: Error) => /Workflow not found: missing/.test(err.message),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
