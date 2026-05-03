/**
 * Pure unit tests for src/server/agent/resolve-role.ts.
 *
 * Precedence rule: goal.inlineRoles[name] wins over roleStore.get(name).
 * Falls through to the store when the goal lacks an inline definition.
 * Returns undefined when neither has it. listAvailableRoles unions both
 * sources, inline first, deduping by name.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveRole, listAvailableRoles } from "../src/server/agent/resolve-role.ts";
import type { PersistedGoal } from "../src/server/agent/goal-store.ts";
import type { Role, RoleStore } from "../src/server/agent/role-store.ts";

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

function fakeGoal(inlineRoles?: Record<string, Role>): PersistedGoal {
	return {
		id: "g",
		title: "g",
		cwd: "/",
		state: "in-progress",
		spec: "",
		createdAt: 0,
		updatedAt: 0,
		inlineRoles,
	} as PersistedGoal;
}

describe("resolveRole", () => {
	it("returns the inline definition when present (wins over store)", () => {
		const stored = role("reviewer", "store");
		const inline = role("reviewer", "inline");
		const goal = fakeGoal({ reviewer: inline });
		const store = fakeStore([stored]);
		const got = resolveRole(goal, "reviewer", store);
		assert.equal(got?.label, "reviewer (inline)");
	});

	it("falls through to the role store when goal has no inline definition", () => {
		const stored = role("reviewer", "store");
		const goal = fakeGoal({});
		const store = fakeStore([stored]);
		const got = resolveRole(goal, "reviewer", store);
		assert.equal(got?.label, "reviewer (store)");
	});

	it("falls through to the role store when goal has inlineRoles but not THIS name", () => {
		const stored = role("reviewer", "store");
		const inline = role("auditor", "inline");
		const goal = fakeGoal({ auditor: inline });
		const store = fakeStore([stored]);
		const got = resolveRole(goal, "reviewer", store);
		assert.equal(got?.label, "reviewer (store)");
	});

	it("returns undefined when neither inline nor store has the role", () => {
		const goal = fakeGoal({});
		const store = fakeStore([]);
		assert.equal(resolveRole(goal, "missing", store), undefined);
	});

	it("returns undefined when the goal is undefined and the store doesn't have it", () => {
		const store = fakeStore([role("reviewer")]);
		assert.equal(resolveRole(undefined, "missing", store), undefined);
	});

	it("returns the store entry when the goal is undefined but the store has it", () => {
		const store = fakeStore([role("reviewer", "store")]);
		const got = resolveRole(undefined, "reviewer", store);
		assert.equal(got?.label, "reviewer (store)");
	});

	it("returns the inline entry when the role store is undefined", () => {
		const goal = fakeGoal({ reviewer: role("reviewer", "inline") });
		const got = resolveRole(goal, "reviewer", undefined);
		assert.equal(got?.label, "reviewer (inline)");
	});

	it("returns undefined when both sources are undefined", () => {
		assert.equal(resolveRole(undefined, "anything", undefined), undefined);
	});
});

describe("listAvailableRoles", () => {
	it("lists inline first, then store, deduping by name", () => {
		const goal = fakeGoal({ "synthesis-reviewer": role("synthesis-reviewer"), reviewer: role("reviewer") });
		const store = fakeStore([role("reviewer"), role("coder"), role("qa-tester")]);
		const got = listAvailableRoles(goal, store);
		assert.deepEqual(got, ["synthesis-reviewer", "reviewer", "coder", "qa-tester"]);
	});

	it("returns just the store names when goal has no inlineRoles", () => {
		const store = fakeStore([role("reviewer"), role("coder")]);
		assert.deepEqual(listAvailableRoles(fakeGoal({}), store), ["reviewer", "coder"]);
	});

	it("returns just the inline names when store is empty/undefined", () => {
		const goal = fakeGoal({ "x-role": role("x-role") });
		assert.deepEqual(listAvailableRoles(goal, undefined), ["x-role"]);
	});

	it("returns [] when both sources empty", () => {
		assert.deepEqual(listAvailableRoles(fakeGoal({}), fakeStore([])), []);
	});
});
