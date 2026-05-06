/**
 * Phase 4 — `POST /api/goals/:id/integrate-child/:childId` semantics.
 *
 * Tests the GoalManager.mergeChild contract that the route relies on.
 * mergeChild itself is exercised in goal-manager-merge-child.test.ts;
 * this file focuses on the route's preconditions:
 *   1. Parent mismatch (security): mergeChild throws PARENT_MISMATCH
 *      → handler returns 400.
 *   2. Successful merge → handler archives child + tears down team.
 *   3. Conflict outcome → handler returns 409 without archiving.
 *
 * We use the existing mergeChild API which throws on parent mismatch.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "integrate-child-"));
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
	wf.setBuiltins([{ id: "feature", name: "Feature", description: "", gates: [{ id: "g", name: "G", dependsOn: [] }], createdAt: 0, updatedAt: 0 }]);
	return { gm: new GoalManager(goalStore, wf), store: goalStore };
}

describe("integrate-child REST primitives", () => {
	it("parent mismatch throws PARENT_MISMATCH (handler returns 400)", async () => {
		const { gm } = makeManager();
		const parentA = await gm.createGoal("ParentA", tmpRoot, { workflowId: "feature" });
		const parentB = await gm.createGoal("ParentB", tmpRoot, { workflowId: "feature" });
		const childOfA = await gm.createGoal("Child", tmpRoot, { workflowId: "feature", parentGoalId: parentA.id });

		// mergeChild(parentB, childOfA) — child's parentGoalId mismatches.
		await assert.rejects(
			() => gm.mergeChild(parentB.id, childOfA.id),
			(err: any) => err && err.code === "PARENT_MISMATCH",
			"mergeChild must throw PARENT_MISMATCH on cross-parent attempt",
		);
	});

	it("missing branches throw a structured error (handler returns 500)", async () => {
		const { gm } = makeManager();
		const parent = await gm.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		const child = await gm.createGoal("Child", tmpRoot, { workflowId: "feature", parentGoalId: parent.id });
		// Strip branches to force the missing-branch error.
		gm.getGoalStore().update(parent.id, { branch: undefined as any });
		gm.getGoalStore().update(child.id, { branch: undefined as any });
		await assert.rejects(
			() => gm.mergeChild(parent.id, child.id),
			(err: any) => err && /missing branch/i.test(String(err.message)),
		);
	});

	it("missing parent throws", async () => {
		const { gm } = makeManager();
		await assert.rejects(
			() => gm.mergeChild("nope", "also-nope"),
			(err: any) => /parent goal not found/i.test(String(err.message)),
		);
	});

	it("missing child throws", async () => {
		const { gm } = makeManager();
		const parent = await gm.createGoal("Parent", tmpRoot, { workflowId: "feature" });
		await assert.rejects(
			() => gm.mergeChild(parent.id, "no-child"),
			(err: any) => /child goal not found/i.test(String(err.message)),
		);
	});

	// R-005: source-level invariant that the route guards on the
	// child's ready-to-merge gate before invoking mergeChild. Direct
	// HTTP coverage is in the e2e harness; here we pin the source-level
	// contract so a regression that drops the guard fails CI.
	it("R-005: route refuses merge unless ready-to-merge gate has passed (or body.force=true)", () => {
		const src = fs.readFileSync(path.resolve(__dirname, "../src/server/server.ts"), "utf8");
		assert.ok(
			src.includes("RTM_NOT_PASSED"),
			"integrate-child route must emit RTM_NOT_PASSED when the child's ready-to-merge gate has not passed (R-005)",
		);
		assert.ok(
			/getGate\(childId,\s*"ready-to-merge"\)/.test(src),
			"integrate-child route must look up gateStore.getGate(childId, 'ready-to-merge') (R-005)",
		);
		assert.ok(
			/integrateBody.*\.force === true/.test(src) || /force === true/.test(src),
			"integrate-child route must accept body.force=true as a recovery override (R-005)",
		);
	});
});
