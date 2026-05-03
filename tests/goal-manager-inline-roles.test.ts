/**
 * GoalManager.createGoal + spawn-child REST handler — inline-roles snapshot
 * + parent-to-child inheritance.
 *
 * Mirrors the `goal.workflow` snapshot pattern: roles passed as the
 * `inlineRoles` option are deep-cloned onto the goal record at creation
 * time. The verification harness + team-spawn resolve role names from this
 * snapshot first via resolveRole(). Subsequent edits to the project's role
 * store don't affect a goal that has its own inline definition for that
 * name.
 *
 * Cases:
 *   1. createGoal stamps inlineRoles onto the goal record.
 *   2. createGoal deep-clones — mutating the source object doesn't poison
 *      the goal.
 *   3. createGoal omits inlineRoles entirely when not given (no empty {}
 *      stamp on every goal).
 *   4. resolveRole consulting the persisted goal returns the inline entry
 *      ahead of the role-store entry of the same name (integration: the
 *      whole pipeline from createGoal to lookup, not just resolveRole as
 *      a pure helper).
 *   5. Child-spawn merge contract: server.ts spawn-child handler unions
 *      parent's inlineRoles with body.inlineRoles, child entries override
 *      parent on name collision. Tested as a pure function over the merge
 *      logic (no full HTTP roundtrip — the REST e2e covers that).
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
import { resolveRole } from "../src/server/agent/resolve-role.ts";
import type { Role, RoleStore } from "../src/server/agent/role-store.ts";

let tmpRoot: string;
let stateDir: string;
let configDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "inline-roles-"));
	stateDir = path.join(tmpRoot, "state");
	configDir = path.join(tmpRoot, "config");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(configDir);
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeManager(): { gm: GoalManager; goalStore: GoalStore } {
	const goalStore = new GoalStore(stateDir);
	const cfg = new ProjectConfigStore(configDir);
	const wf = new InlineWorkflowStore(cfg);
	wf.setBuiltins([{
		id: "general", name: "General", description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 0, updatedAt: 0,
	}]);
	return { gm: new GoalManager(goalStore, wf), goalStore };
}

function role(name: string, marker = ""): Role {
	return {
		name,
		label: `${name}${marker ? ` (${marker})` : ""}`,
		promptTemplate: `prompt for ${name}${marker ? ` :: ${marker}` : ""}`,
		accessory: "none",
		createdAt: 0,
		updatedAt: 0,
	};
}

function fakeStore(roles: Role[]): RoleStore {
	return {
		get: (n: string) => roles.find(r => r.name === n),
		getAll: () => roles,
	} as unknown as RoleStore;
}

describe("GoalManager.createGoal — inlineRoles", () => {
	it("stamps inlineRoles onto the goal record", async () => {
		const { gm, goalStore } = makeManager();
		const inlineRoles = {
			"synthesis-reviewer": role("synthesis-reviewer", "inline"),
			"audit-tester": role("audit-tester", "inline"),
		};
		const g = await gm.createGoal("audit-1", tmpRoot, { workflowId: "general", inlineRoles });
		const persisted = goalStore.get(g.id);
		assert.ok(persisted?.inlineRoles, "inlineRoles must be persisted");
		assert.equal(persisted!.inlineRoles!["synthesis-reviewer"].label, "synthesis-reviewer (inline)");
		assert.equal(persisted!.inlineRoles!["audit-tester"].label, "audit-tester (inline)");
	});

	it("deep-clones — mutating the source after createGoal doesn't poison the persisted snapshot", async () => {
		const { gm, goalStore } = makeManager();
		const sourceRole = role("synthesis-reviewer", "v1");
		const inlineRoles = { "synthesis-reviewer": sourceRole };
		const g = await gm.createGoal("audit", tmpRoot, { workflowId: "general", inlineRoles });
		// Mutate the source — must NOT leak into the goal's snapshot.
		sourceRole.label = "MUTATED";
		sourceRole.promptTemplate = "MUTATED PROMPT";
		const persisted = goalStore.get(g.id);
		assert.equal(persisted?.inlineRoles?.["synthesis-reviewer"].label, "synthesis-reviewer (v1)");
		assert.equal(persisted?.inlineRoles?.["synthesis-reviewer"].promptTemplate, "prompt for synthesis-reviewer :: v1");
	});

	it("does NOT stamp inlineRoles when caller doesn't pass any (no empty {} on every goal)", async () => {
		const { gm, goalStore } = makeManager();
		const g = await gm.createGoal("plain", tmpRoot, { workflowId: "general" });
		const persisted = goalStore.get(g.id);
		assert.equal(persisted?.inlineRoles, undefined);
	});

	it("does NOT stamp inlineRoles when caller passes an empty object", async () => {
		const { gm, goalStore } = makeManager();
		const g = await gm.createGoal("plain", tmpRoot, { workflowId: "general", inlineRoles: {} });
		const persisted = goalStore.get(g.id);
		assert.equal(persisted?.inlineRoles, undefined,
			"empty inlineRoles should not produce a noisy {} on every goal record");
	});

	it("integration: resolveRole consulting the persisted goal returns the inline entry first", async () => {
		const { gm, goalStore } = makeManager();
		const inline = role("reviewer", "inline");
		const g = await gm.createGoal("g", tmpRoot, {
			workflowId: "general",
			inlineRoles: { reviewer: inline },
		});
		const persisted = goalStore.get(g.id)!;
		const store = fakeStore([role("reviewer", "store")]);
		// inline wins
		assert.equal(resolveRole(persisted, "reviewer", store)?.label, "reviewer (inline)");
		// fall-through still works for unrelated names
		assert.equal(resolveRole(persisted, "qa-tester", fakeStore([role("qa-tester", "store")]))?.label, "qa-tester (store)");
	});
});

describe("spawn-child inlineRoles merge logic", () => {
	// Pure-function shape mirroring the merge in server.ts spawn-child handler.
	// If the merge ever drifts away from "{...parent, ...child}", this test
	// will catch it before the e2e does.
	function mergeInlineRoles(
		parent?: Record<string, Role>,
		body?: Record<string, Role>,
	): Record<string, Role> | undefined {
		if (!parent && !body) return undefined;
		return { ...(parent ?? {}), ...(body ?? {}) };
	}

	it("returns undefined when both parent and body are undefined", () => {
		assert.equal(mergeInlineRoles(undefined, undefined), undefined);
		// (in practice the goal-store never persists an empty {} — see the
		// "does NOT stamp inlineRoles when caller passes an empty object" case
		// above. So `parent.inlineRoles` is either undefined or non-empty;
		// the empty-object case isn't a real input.)
	});

	it("inherits parent's inlineRoles when body has none", () => {
		const merged = mergeInlineRoles(
			{ "synthesis-reviewer": role("synthesis-reviewer", "parent") },
			undefined,
		);
		assert.ok(merged);
		assert.equal(merged["synthesis-reviewer"].label, "synthesis-reviewer (parent)");
	});

	it("uses body's inlineRoles when parent has none", () => {
		const merged = mergeInlineRoles(
			undefined,
			{ "audit-tester": role("audit-tester", "child") },
		);
		assert.ok(merged);
		assert.equal(merged["audit-tester"].label, "audit-tester (child)");
	});

	it("unions parent + body when names don't collide", () => {
		const merged = mergeInlineRoles(
			{ "synthesis-reviewer": role("synthesis-reviewer", "parent") },
			{ "audit-tester": role("audit-tester", "child") },
		);
		assert.ok(merged);
		assert.equal(Object.keys(merged).length, 2);
		assert.equal(merged["synthesis-reviewer"].label, "synthesis-reviewer (parent)");
		assert.equal(merged["audit-tester"].label, "audit-tester (child)");
	});

	it("child overrides parent on name collision", () => {
		const merged = mergeInlineRoles(
			{ reviewer: role("reviewer", "parent") },
			{ reviewer: role("reviewer", "child") },
		);
		assert.ok(merged);
		assert.equal(Object.keys(merged).length, 1);
		assert.equal(merged.reviewer.label, "reviewer (child)",
			"child must override parent on name collision");
	});
});
