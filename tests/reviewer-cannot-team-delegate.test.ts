/**
 * Per-role policy invariant: reviewer-family roles cannot `team_delegate`.
 *
 * The `delegate` → `team_delegate` hard rename (Orchestration Core sub-goal A)
 * had to migrate the FOUR explicit deny sites as well as the allow sites —
 * otherwise `delegate: never` would become a dead key and the reviewer roles
 * would silently inherit `team_delegate` from the (allow-by-default) `Agent`
 * group.
 *
 * This test asserts the *resolved* policy (mirroring runtime
 * `resolveGrantPolicy`): each reviewer-family role must resolve `team_delegate`
 * to `never`, so the spawn verb is stripped from their allowedTools.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const { resolveGrantPolicy } = await import("../src/server/agent/tool-activation.ts");
import type { GrantPolicy, GroupPolicyProvider } from "../src/server/agent/tool-activation.ts";

const DEFAULTS_DIR = path.resolve(import.meta.dirname, "..", "defaults");
const ROLES_DIR = path.join(DEFAULTS_DIR, "roles");
const GROUP_POLICIES_FILE = path.join(DEFAULTS_DIR, "tool-group-policies.yaml");

/** Reviewer-family roles that must NOT be able to spawn child agents. */
const REVIEWER_ROLES = ["reviewer", "spec-auditor", "security-reviewer", "code-reviewer"];

function loadRole(name: string): { toolPolicies?: Record<string, GrantPolicy> } {
	const text = fs.readFileSync(path.join(ROLES_DIR, `${name}.yaml`), "utf-8");
	return YAML.parse(text) as { toolPolicies?: Record<string, GrantPolicy> };
}

function defaultGroupPolicyProvider(): GroupPolicyProvider {
	const raw = YAML.parse(fs.readFileSync(GROUP_POLICIES_FILE, "utf-8")) as Record<string, GrantPolicy>;
	return {
		getGroupPolicy: (group: string) => raw[group] ?? null,
		getAll: () => raw,
		getSubgoalsEnabled: () => true,
	};
}

describe("reviewer roles cannot team_delegate (resolved)", () => {
	const groupPolicyStore = defaultGroupPolicyProvider();

	for (const roleName of REVIEWER_ROLES) {
		it(`${roleName} resolves team_delegate to never`, () => {
			const role = loadRole(roleName);
			assert.equal(
				resolveGrantPolicy("team_delegate", "Agent", role, undefined, groupPolicyStore),
				"never",
				`${roleName}.yaml must declare \`team_delegate: never\` (the migrated deny site)`,
			);
		});

		it(`${roleName} declares the deny in YAML (no dead \`delegate\` key)`, () => {
			const role = loadRole(roleName);
			const policies = role.toolPolicies ?? {};
			assert.equal(
				policies.team_delegate,
				"never",
				`${roleName}.yaml toolPolicies must set \`team_delegate: never\``,
			);
			assert.ok(
				!("delegate" in policies),
				`${roleName}.yaml must not retain the dead \`delegate\` key after the rename`,
			);
		});
	}
});
