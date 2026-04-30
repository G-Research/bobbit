/**
 * Unit tests for `resolveRoleForGoal`.
 *
 * Exercises the three-tier resolution order (own inline → ancestor inline
 * walk → cascade) and edge cases.
 *
 * See `docs/design/nested-goals.md` §7.2.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GoalStore, type PersistedGoal } from "../src/server/agent/goal-store.ts";
import type { Role } from "../src/server/agent/role-store.ts";
import type { ConfigCascade, ResolvedItem } from "../src/server/agent/config-cascade.ts";
import { resolveRoleForGoal } from "../src/server/agent/role-resolution.ts";

let stateDir: string;
beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "role-resolution-"));
});

function role(name: string, label = name): Role {
	return {
		name,
		label,
		promptTemplate: "p",
		accessory: "none",
		createdAt: 0,
		updatedAt: 0,
	};
}

function mkGoal(over: Partial<PersistedGoal> & { id: string }): PersistedGoal {
	return {
		title: `t-${over.id}`,
		cwd: "/tmp",
		state: "todo",
		spec: "",
		createdAt: 0,
		updatedAt: 0,
		...over,
	} as PersistedGoal;
}

/** Minimal ConfigCascade stub — only `resolveRoles` is consulted. */
function fakeCascade(roles: Role[], by: "builtin" | "server" | "project" = "project"): ConfigCascade {
	const items: ResolvedItem<Role>[] = roles.map(r => ({ item: r, origin: by }));
	return {
		resolveRoles: (_projectId?: string) => items,
	} as unknown as ConfigCascade;
}

describe("resolveRoleForGoal", () => {
	it("returns undefined when the goal does not exist", () => {
		const store = new GoalStore(stateDir);
		const cascade = fakeCascade([role("coder")]);
		assert.equal(resolveRoleForGoal(store, cascade, "missing", "coder"), undefined);
	});

	it("returns the goal's own inline role when present", () => {
		const store = new GoalStore(stateDir);
		const inline = role("coder", "inline-coder");
		store.put(mkGoal({ id: "g1", inlineRoles: { coder: inline } }));
		const cascade = fakeCascade([role("coder", "cascade-coder")]);
		const out = resolveRoleForGoal(store, cascade, "g1", "coder");
		assert.strictEqual(out, inline);
	});

	it("walks the ancestor chain closest-first for an inline role", () => {
		const store = new GoalStore(stateDir);
		const rootInline = role("coder", "root-coder");
		const parentInline = role("coder", "parent-coder");
		store.put(mkGoal({ id: "root", rootGoalId: "root", inlineRoles: { coder: rootInline } }));
		store.put(mkGoal({ id: "parent", parentGoalId: "root", rootGoalId: "root", inlineRoles: { coder: parentInline } }));
		store.put(mkGoal({ id: "leaf", parentGoalId: "parent", rootGoalId: "root" }));

		const cascade = fakeCascade([role("coder", "cascade-coder")]);
		const out = resolveRoleForGoal(store, cascade, "leaf", "coder");
		assert.strictEqual(out, parentInline, "closest ancestor must shadow further ancestors + cascade");
	});

	it("walks past ancestors that don't define the requested role", () => {
		// parent has inlineRoles for "qa" only; root has it for "coder".
		// Resolving "coder" from the leaf should hit the root.
		const store = new GoalStore(stateDir);
		const rootInline = role("coder", "root-coder");
		const parentQa = role("qa", "parent-qa");
		store.put(mkGoal({ id: "root", rootGoalId: "root", inlineRoles: { coder: rootInline } }));
		store.put(mkGoal({ id: "parent", parentGoalId: "root", rootGoalId: "root", inlineRoles: { qa: parentQa } }));
		store.put(mkGoal({ id: "leaf", parentGoalId: "parent", rootGoalId: "root" }));

		const cascade = fakeCascade([]);
		const out = resolveRoleForGoal(store, cascade, "leaf", "coder");
		assert.strictEqual(out, rootInline);
	});

	it("falls through to cascade when no inline role matches anywhere on the chain", () => {
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "root", rootGoalId: "root" }));
		store.put(mkGoal({ id: "child", parentGoalId: "root", rootGoalId: "root" }));
		const cascadeCoder = role("coder", "cascade-coder");
		const cascade = fakeCascade([cascadeCoder]);
		const out = resolveRoleForGoal(store, cascade, "child", "coder");
		assert.strictEqual(out, cascadeCoder);
	});

	it("returns undefined when no layer defines the requested role", () => {
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "g1" }));
		const cascade = fakeCascade([role("other")]);
		assert.equal(resolveRoleForGoal(store, cascade, "g1", "coder"), undefined);
	});

	it("resolves a builtin-layer role via the cascade when no inline override", () => {
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "g1" }));
		const builtinRole = role("coder", "builtin-coder");
		const cascade = fakeCascade([builtinRole], "builtin");
		const out = resolveRoleForGoal(store, cascade, "g1", "coder");
		assert.strictEqual(out, builtinRole);
	});

	it("resolves a server-layer role via the cascade when no inline override", () => {
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "g1" }));
		const serverRole = role("coder", "server-coder");
		const cascade = fakeCascade([serverRole], "server");
		const out = resolveRoleForGoal(store, cascade, "g1", "coder");
		assert.strictEqual(out, serverRole);
	});

	it("resolves a project-layer role via the cascade when no inline override", () => {
		const store = new GoalStore(stateDir);
		store.put(mkGoal({ id: "g1", projectId: "p1" }));
		const projectRole = role("coder", "project-coder");
		const cascade = fakeCascade([projectRole], "project");
		const out = resolveRoleForGoal(store, cascade, "g1", "coder");
		assert.strictEqual(out, projectRole);
	});

	it("inline override on a leaf shadows a project-cascade role of the same name", () => {
		const store = new GoalStore(stateDir);
		const inline = role("coder", "leaf-inline");
		store.put(mkGoal({ id: "root", rootGoalId: "root" }));
		store.put(mkGoal({ id: "child", parentGoalId: "root", rootGoalId: "root", inlineRoles: { coder: inline } }));
		const cascade = fakeCascade([role("coder", "cascade-coder")], "project");
		const out = resolveRoleForGoal(store, cascade, "child", "coder");
		assert.strictEqual(out, inline);
	});
});
