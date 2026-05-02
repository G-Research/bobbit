/**
 * Phase 4 — per-role policy invariant for the new `Children` tool group.
 *
 * Mirrors `role-gate-signal-policy.test.ts`: only the team-lead may call
 * the nine `goal_*` tools that drive the parent ↔ child lifecycle. Every
 * shipped contributor role must declare `never` for each tool. The
 * tool-guard extension hard-blocks the call at runtime; the role YAML is
 * the source of truth that drives the extension.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const ROLES_DIR = path.resolve(import.meta.dirname, "..", "defaults", "roles");

const CHILDREN_TOOLS = [
	"goal_spawn_child",
	"goal_plan_propose",
	"goal_plan_status",
	"goal_merge_child",
	"goal_pause",
	"goal_resume",
	"goal_archive_child",
	"goal_decide_mutation",
	"goal_set_policy",
];

const CONTRIBUTOR_ROLES = [
	"coder",
	"test-engineer",
	"reviewer",
	"code-reviewer",
	"security-reviewer",
	"architect",
	"spec-auditor",
	"qa-tester",
	"docs-writer",
];

function loadRole(name: string): { toolPolicies?: Record<string, string> } {
	const file = path.join(ROLES_DIR, `${name}.yaml`);
	const text = fs.readFileSync(file, "utf-8");
	return YAML.parse(text) as { toolPolicies?: Record<string, string> };
}

describe("role children-tools policy invariant", () => {
	for (const tool of CHILDREN_TOOLS) {
		it(`team-lead has ${tool}: always-allow`, () => {
			const role = loadRole("team-lead");
			assert.equal(
				role.toolPolicies?.[tool],
				"always-allow",
				`team-lead.yaml must declare toolPolicies.${tool}: always-allow`,
			);
		});
	}

	for (const roleName of CONTRIBUTOR_ROLES) {
		for (const tool of CHILDREN_TOOLS) {
			it(`${roleName} has ${tool}: never`, () => {
				const role = loadRole(roleName);
				assert.equal(
					role.toolPolicies?.[tool],
					"never",
					`${roleName}.yaml must declare toolPolicies.${tool}: never (only team-lead may use Children tools)`,
				);
			});
		}
	}
});
