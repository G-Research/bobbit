/**
 * Pinned regression: when a role runs as an LLM verify step on a
 * `parent`-workflow plan-review gate (architect for "DAG correctness",
 * spec-auditor for "Spec completeness"), they need to fetch the current
 * plan via `goal_plan_status` to evaluate the proposed subgoal DAG.
 *
 * Before this fix, the architect saw an interactive permission prompt
 * (\"Role 'Architect' doesn't have access to goal_plan_status\") because
 * the `Children` tool-group default is `ask` and the architect role
 * didn't override it. That blocked the gate's verify step until a human
 * clicked through the prompt.
 *
 * Fix: per-tool override `goal_plan_status: allow` on architect AND
 * spec-auditor roles. Only the read-only `goal_plan_status` is opened up;
 * the mutating tools (`goal_spawn_child`, `goal_plan_propose`,
 * `goal_merge_child`, `goal_pause`, `goal_resume`, `goal_decide_mutation`,
 * `goal_set_policy`) stay team-lead-only.
 *
 * Pinned cases:
 *   - architect.toolPolicies.goal_plan_status === "allow"
 *   - spec-auditor.toolPolicies.goal_plan_status === "allow"
 *   - resolveGrantPolicy("goal_plan_status", "Children", architectRole, ...) === "allow"
 *     (priority #1 \u2014 role tool-specific override beats group default of `ask`)
 *   - same for spec-auditor
 *   - mutating Children tools still resolve to `ask` for these roles
 *     (the override is read-only)
 *   - other reviewer roles (code-reviewer, security-reviewer) which don't
 *     run on plan-review gates do NOT silently get the same override
 *     (we want least-privilege \u2014 only roles that need it)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "yaml";

import { resolveGrantPolicy } from "../src/server/agent/tool-activation.ts";

const ROLES_DIR = path.resolve("defaults/roles");

function loadRoleYaml(name: string): {
	name: string;
	toolPolicies?: Record<string, string>;
} {
	const raw = fs.readFileSync(path.join(ROLES_DIR, `${name}.yaml`), "utf-8");
	const parsed = yaml.parse(raw);
	return parsed as any;
}

function mockGroupPolicyStore(policies: Record<string, string>) {
	return {
		getGroupPolicy(group: string) { return policies[group] || null; },
		getAll() { return policies; },
	};
}

function mockToolManager(tools: Record<string, { grantPolicy?: string }> = {}) {
	return {
		getToolByName(name: string) { return tools[name]; },
	};
}

describe("architect role \u2014 read-only Children overrides", () => {
	it("YAML declares the three read-only Children tools as allow", () => {
		const role = loadRoleYaml("architect");
		assert.ok(role.toolPolicies, "architect must define toolPolicies");
		for (const tool of ["goal_plan_status", "goal_list_children", "goal_inspect_child"]) {
			assert.equal(role.toolPolicies![tool], "allow",
				`architect.toolPolicies.${tool} must be 'allow' so plan-review and cross-goal inspection can run without prompting`);
		}
	});

	it("resolveGrantPolicy prioritises the role override over the Children group default", () => {
		const role = loadRoleYaml("architect");
		const tm = mockToolManager();
		const gps = mockGroupPolicyStore({ Children: "ask" });
		const policy = resolveGrantPolicy(
			"goal_plan_status",
			"Children",
			role as any,
			tm as any,
			gps as any,
		);
		assert.equal(policy, "allow",
			"goal_plan_status must resolve to 'allow' for architect even when the Children group default is 'ask'");
	});

	it("MUTATING Children tools still resolve to 'ask' for architect (least privilege)", () => {
		const role = loadRoleYaml("architect");
		const tm = mockToolManager();
		const gps = mockGroupPolicyStore({ Children: "ask" });
		// The override is per-tool, so other Children tools still inherit `ask`.
		for (const tool of [
			"goal_spawn_child",
			"goal_plan_propose",
			"goal_merge_child",
			"goal_pause",
			"goal_resume",
			"goal_decide_mutation",
			"goal_set_policy",
		]) {
			const policy = resolveGrantPolicy(tool, "Children", role as any, tm as any, gps as any);
			assert.equal(policy, "ask",
				`${tool} must remain 'ask' for architect \u2014 only goal_plan_status is opened up, mutations stay gated`);
		}
	});
});

describe("spec-auditor role \u2014 read-only Children overrides", () => {
	it("YAML declares the three read-only Children tools as allow", () => {
		const role = loadRoleYaml("spec-auditor");
		assert.ok(role.toolPolicies, "spec-auditor must define toolPolicies");
		for (const tool of ["goal_plan_status", "goal_list_children", "goal_inspect_child"]) {
			assert.equal(role.toolPolicies![tool], "allow",
				`spec-auditor.toolPolicies.${tool} must be 'allow' for plan-review verify steps and cross-goal coverage checks`);
		}
	});

	it("resolveGrantPolicy prioritises the role override over the Children group default", () => {
		const role = loadRoleYaml("spec-auditor");
		const tm = mockToolManager();
		const gps = mockGroupPolicyStore({ Children: "ask" });
		const policy = resolveGrantPolicy(
			"goal_plan_status",
			"Children",
			role as any,
			tm as any,
			gps as any,
		);
		assert.equal(policy, "allow");
	});

	it("MUTATING Children tools still resolve to 'ask' for spec-auditor", () => {
		const role = loadRoleYaml("spec-auditor");
		const tm = mockToolManager();
		const gps = mockGroupPolicyStore({ Children: "ask" });
		for (const tool of [
			"goal_spawn_child",
			"goal_plan_propose",
			"goal_merge_child",
			"goal_pause",
			"goal_resume",
			"goal_decide_mutation",
			"goal_set_policy",
		]) {
			const policy = resolveGrantPolicy(tool, "Children", role as any, tm as any, gps as any);
			assert.equal(policy, "ask",
				`${tool} must remain 'ask' for spec-auditor \u2014 only goal_plan_status is opened up`);
		}
	});
});

describe("other reviewer roles (least-privilege)", () => {
	// We deliberately did NOT add the override to roles that don't run on
	// plan-review verify steps. If a future change extends the override
	// silently, these tests fail \u2014 a deliberate \"is this really needed?\"
	// circuit-breaker.
	for (const roleName of ["code-reviewer", "security-reviewer", "qa-tester"]) {
		it(`${roleName} does NOT silently get the read-only Children overrides`, () => {
			const role = loadRoleYaml(roleName);
			for (const tool of ["goal_plan_status", "goal_list_children", "goal_inspect_child"]) {
				const override = role.toolPolicies?.[tool];
				assert.equal(override, undefined,
					`${roleName} should not have ${tool} override unless it runs on a plan gate. ` +
					`If you need to add one, document why in the role YAML and update this test.`);
			}
		});
	}
});

describe("team-lead role (sanity \u2014 still has Children: allow)", () => {
	it("team-lead.toolPolicies.Children remains 'allow' (group-level override, not per-tool)", () => {
		const role = loadRoleYaml("team-lead");
		assert.ok(role.toolPolicies);
		assert.equal(role.toolPolicies!.Children, "allow",
			"team-lead's Children group-level override must be intact \u2014 they own all the mutating tools");
	});
});
