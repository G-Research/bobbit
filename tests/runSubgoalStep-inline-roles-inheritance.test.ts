/**
 * Regression: children spawned by `runSubgoalStep` (the `subgoal` verify-step
 * path) must inherit the parent's `inlineRoles` snapshot — same invariant
 * that `goal_spawn_child` already honours at server.ts spawn-child.
 *
 * Pre-fix: the subgoal-step spawn path at verification-harness.ts did NOT
 * pass `inlineRoles` to `createGoal`, so a parent defining audit-wide
 * reviewer roles (e.g. `synthesis-reviewer`) inline saw its children fail
 * to resolve those role names via `resolveRole()`. This test exercises the
 * contract at the GoalManager level — when we pass `inlineRoles` through
 * createGoal, the resulting goal record carries the deep-cloned snapshot
 * and resolveRole() finds it. The verification-harness change is that it
 * now derives that `inlineRoles` argument from `parent.inlineRoles` before
 * calling createGoal.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore } from "../src/server/agent/workflow-store.ts";
import { resolveRole } from "../src/server/agent/resolve-role.ts";
import type { Role, RoleStore } from "../src/server/agent/role-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subgoal-inline-roles-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), "");
});

function stubRoleStore(roles: Record<string, Role> = {}): RoleStore {
	return {
		get: (name: string) => roles[name],
		getAll: () => Object.values(roles),
	} as unknown as RoleStore;
}

describe("runSubgoalStep: child inherits parent.inlineRoles (integration via createGoal)", () => {
	it("subgoal-spawned child can resolve a role defined only on the parent's inlineRoles", async () => {
		const cfg = new ProjectConfigStore(configDir);
		const wfStore = new InlineWorkflowStore(cfg);
		wfStore.setBuiltins([{
			id: "feature", name: "Feature", description: "",
			gates: [{ id: "g", name: "G", dependsOn: [] }],
			createdAt: 0, updatedAt: 0,
		}]);
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore, wfStore);

		const inlineRole: Role = {
			name: "synthesis-reviewer",
			label: "Synthesis Reviewer",
			promptTemplate: "Review the synthesis.",
		};
		const parent = await gm.createGoal("Parent", tmpRoot, {
			workflowId: "feature",
			workflowStore: wfStore,
			inlineRoles: { "synthesis-reviewer": inlineRole },
		});
		assert.ok(parent.inlineRoles?.["synthesis-reviewer"]);

		// Simulate what verification-harness.ts::runSubgoalStep now does:
		// deep-clone parent.inlineRoles and pass through createGoal.
		const inherited = parent.inlineRoles
			? JSON.parse(JSON.stringify(parent.inlineRoles))
			: undefined;
		const child = await gm.createGoal("Child A", tmpRoot, {
			workflowId: "feature",
			workflowStore: wfStore,
			parentGoalId: parent.id,
			inlineRoles: inherited,
		});

		// Child's snapshot contains the inherited role.
		assert.ok(child.inlineRoles?.["synthesis-reviewer"]);
		assert.equal(child.inlineRoles!["synthesis-reviewer"].promptTemplate, "Review the synthesis.");

		// resolveRole on the child finds the inline entry even though the
		// project role-store has nothing named that.
		const emptyRoleStore = stubRoleStore({});
		const resolved = resolveRole(child, "synthesis-reviewer", emptyRoleStore);
		assert.ok(resolved);
		assert.equal(resolved!.name, "synthesis-reviewer");
	});

	it("deep clone — mutating the parent after spawn doesn't poison the child", async () => {
		const cfg = new ProjectConfigStore(configDir);
		const wfStore = new InlineWorkflowStore(cfg);
		wfStore.setBuiltins([{
			id: "feature", name: "Feature", description: "",
			gates: [{ id: "g", name: "G", dependsOn: [] }],
			createdAt: 0, updatedAt: 0,
		}]);
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore, wfStore);

		const parent = await gm.createGoal("Parent", tmpRoot, {
			workflowId: "feature",
			workflowStore: wfStore,
			inlineRoles: { reviewer: { name: "reviewer", label: "R", promptTemplate: "v1" } },
		});

		const inherited = JSON.parse(JSON.stringify(parent.inlineRoles));
		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "feature",
			workflowStore: wfStore,
			parentGoalId: parent.id,
			inlineRoles: inherited,
		});

		// Mutate the parent's stored snapshot — child must be unaffected.
		const parentAfter = goalStore.get(parent.id)!;
		parentAfter.inlineRoles!["reviewer"].promptTemplate = "v2-mutated";

		const childAfter = goalStore.get(child.id)!;
		assert.equal(childAfter.inlineRoles!["reviewer"].promptTemplate, "v1");
	});

	it("parent without inlineRoles → child receives undefined, not empty {}", async () => {
		const cfg = new ProjectConfigStore(configDir);
		const wfStore = new InlineWorkflowStore(cfg);
		wfStore.setBuiltins([{
			id: "feature", name: "Feature", description: "",
			gates: [{ id: "g", name: "G", dependsOn: [] }],
			createdAt: 0, updatedAt: 0,
		}]);
		const goalStore = new GoalStore(stateDir);
		const gm = new GoalManager(goalStore, wfStore);

		const parent = await gm.createGoal("Parent", tmpRoot, {
			workflowId: "feature",
			workflowStore: wfStore,
		});
		assert.equal(parent.inlineRoles, undefined);

		const inherited = parent.inlineRoles
			? JSON.parse(JSON.stringify(parent.inlineRoles))
			: undefined;
		assert.equal(inherited, undefined);

		const child = await gm.createGoal("Child", tmpRoot, {
			workflowId: "feature",
			workflowStore: wfStore,
			parentGoalId: parent.id,
			inlineRoles: inherited,
		});
		assert.equal(child.inlineRoles, undefined);
	});
});
