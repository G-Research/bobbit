/**
 * Unit tests for the shared role-prompt helpers (src/server/agent/role-prompt.ts):
 *   - resolveRolePrompt: behaviour-preserving extraction of the regular-session
 *     placeholder-substitution block ({{GOAL_BRANCH}} only when branch present,
 *     {{AGENT_ID}} / {{AVAILABLE_ROLES}} substituted, missing template → undefined).
 *   - buildStaffSystemPrompt: role context prepended with a `---` rule, role +
 *     memory ordering, role absent / unknown roleId → graceful fallback.
 *
 * No live server — the module is imported directly under the node:test runner.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { resolveRolePrompt, buildStaffSystemPrompt } = await import("../src/server/agent/role-prompt.ts");

// A RoleManager-like stub. buildAvailableRolesList prefers getAll() then
// listRoles(); we expose listRoles so {{AVAILABLE_ROLES}} resolves to a list.
function fakeRoleManager(roles: Record<string, { promptTemplate?: string; accessory?: string }>) {
	const all = Object.entries(roles).map(([name, r]) => ({ name, label: name, ...r }));
	return {
		getRole: (name: string) => roles[name],
		listRoles: () => all,
	} as any;
}

describe("resolveRolePrompt", () => {
	it("returns undefined when role is missing", () => {
		assert.equal(resolveRolePrompt(undefined, { agentId: "coder-1234abcd" }), undefined);
	});

	it("returns undefined when promptTemplate is empty/missing", () => {
		assert.equal(resolveRolePrompt({ promptTemplate: "" }, { agentId: "coder-1234abcd" }), undefined);
		assert.equal(resolveRolePrompt({}, { agentId: "coder-1234abcd" }), undefined);
	});

	it("replaces {{GOAL_BRANCH}} only when branch is present", () => {
		const tmpl = "Branch is {{GOAL_BRANCH}}.";
		assert.equal(
			resolveRolePrompt({ promptTemplate: tmpl }, { branch: "goal/foo", agentId: "coder-1234abcd" }),
			"Branch is goal/foo.",
		);
		// No branch → placeholder left intact (exact prior behaviour).
		assert.equal(
			resolveRolePrompt({ promptTemplate: tmpl }, { agentId: "coder-1234abcd" }),
			"Branch is {{GOAL_BRANCH}}.",
		);
		// Empty-string branch is falsy → left intact.
		assert.equal(
			resolveRolePrompt({ promptTemplate: tmpl }, { branch: "", agentId: "coder-1234abcd" }),
			"Branch is {{GOAL_BRANCH}}.",
		);
	});

	it("substitutes {{AGENT_ID}} with the supplied agentId (all occurrences)", () => {
		assert.equal(
			resolveRolePrompt(
				{ promptTemplate: "id={{AGENT_ID}} again={{AGENT_ID}}" },
				{ agentId: "coder-1234abcd" },
			),
			"id=coder-1234abcd again=coder-1234abcd",
		);
	});

	it("substitutes {{AVAILABLE_ROLES}} via buildAvailableRolesList", () => {
		const rm = fakeRoleManager({ coder: { promptTemplate: "x" }, reviewer: { promptTemplate: "y" } });
		const out = resolveRolePrompt(
			{ promptTemplate: "Roles:\n{{AVAILABLE_ROLES}}" },
			{ agentId: "coder-1234abcd", roleManager: rm },
		);
		assert.match(out!, /\*\*coder\*\*/);
		assert.match(out!, /\*\*reviewer\*\*/);
	});

	it("falls back to the default roles list when no roleManager is supplied", () => {
		const out = resolveRolePrompt(
			{ promptTemplate: "{{AVAILABLE_ROLES}}" },
			{ agentId: "coder-1234abcd" },
		);
		assert.equal(out, "coder, reviewer, test-engineer");
	});
});

describe("buildStaffSystemPrompt", () => {
	const baseStaff = {
		id: "abcd1234ef",
		name: "warden",
		description: "",
		systemPrompt: "You are a warden.",
		cwd: "/tmp",
		state: "active" as const,
		triggers: [],
		memory: "",
		accessory: "none",
		createdAt: 0,
		updatedAt: 0,
	};

	it("returns systemPrompt unchanged when no role is set", () => {
		assert.equal(buildStaffSystemPrompt(baseStaff as any), "You are a warden.");
	});

	it("returns systemPrompt + Pinned Context when memory is set (no role)", () => {
		const staff = { ...baseStaff, memory: "remember this" };
		assert.equal(
			buildStaffSystemPrompt(staff as any),
			"You are a warden.\n\n---\n\n## Pinned Context\n\nremember this",
		);
	});

	it("prepends the resolved role context with a `---` separator", () => {
		const rm = fakeRoleManager({ coder: { promptTemplate: "ROLE CTX" } });
		const staff = { ...baseStaff, roleId: "coder" };
		assert.equal(
			buildStaffSystemPrompt(staff as any, rm),
			"ROLE CTX\n\n---\n\nYou are a warden.",
		);
	});

	it("orders role context, systemPrompt, then Pinned Context", () => {
		const rm = fakeRoleManager({ coder: { promptTemplate: "ROLE CTX" } });
		const staff = { ...baseStaff, roleId: "coder", memory: "remember this" };
		assert.equal(
			buildStaffSystemPrompt(staff as any, rm),
			"ROLE CTX\n\n---\n\nYou are a warden.\n\n---\n\n## Pinned Context\n\nremember this",
		);
	});

	it("substitutes placeholders inside the role template using staff context", () => {
		const rm = fakeRoleManager({ coder: { promptTemplate: "branch={{GOAL_BRANCH}} id={{AGENT_ID}}" } });
		const staff = { ...baseStaff, roleId: "coder", branch: "staff-branch" };
		assert.equal(
			buildStaffSystemPrompt(staff as any, rm),
			"branch=staff-branch id=staff-abcd1234\n\n---\n\nYou are a warden.",
		);
	});

	it("falls back to systemPrompt for an unknown roleId", () => {
		const rm = fakeRoleManager({ coder: { promptTemplate: "ROLE CTX" } });
		const staff = { ...baseStaff, roleId: "does-not-exist", memory: "m" };
		assert.equal(
			buildStaffSystemPrompt(staff as any, rm),
			"You are a warden.\n\n---\n\n## Pinned Context\n\nm",
		);
	});

	it("falls back to systemPrompt when roleId is set but no roleManager given", () => {
		const staff = { ...baseStaff, roleId: "coder" };
		assert.equal(buildStaffSystemPrompt(staff as any), "You are a warden.");
	});
});
