/**
 * Per-role policy invariant for the `Children` tool group.
 *
 * Only the team-lead may call the nine `goal_*` tools that drive the
 * parent ↔ child lifecycle. EVERY other shipped role must resolve to
 * `never` for each tool, so the tools are stripped from their allowedTools.
 *
 * This test asserts the *resolved* policy (not just YAML declarations),
 * mirroring runtime `resolveGrantPolicy`. The group default in
 * `defaults/tool-group-policies.yaml` is `Children: never`, which every
 * non-team-lead role inherits; team-lead.yaml's per-tool `always-allow`
 * overrides it (resolveGrantPolicy step 1 beats step 4). Enumerating ALL
 * roles from `defaults/roles/*.yaml` guarantees a newly-added role can
 * never silently inherit `ask`/`allow` for these tools.
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

/** Every shipped role name discovered from defaults/roles/*.yaml. */
function discoverRoleNames(): string[] {
	return fs
		.readdirSync(ROLES_DIR, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".yaml"))
		.map((e) => e.name.replace(/\.yaml$/, ""))
		.sort();
}

function loadRole(name: string): { toolPolicies?: Record<string, GrantPolicy> } {
	const text = fs.readFileSync(path.join(ROLES_DIR, `${name}.yaml`), "utf-8");
	return YAML.parse(text) as { toolPolicies?: Record<string, GrantPolicy> };
}

/** Group-policy provider backed by defaults/tool-group-policies.yaml, with the
 *  Subgoals feature gate ON (so team-lead's grant is not forced to `never`). */
function defaultGroupPolicyProvider(): GroupPolicyProvider {
	const raw = YAML.parse(fs.readFileSync(GROUP_POLICIES_FILE, "utf-8")) as Record<string, GrantPolicy>;
	return {
		getGroupPolicy: (group: string) => raw[group] ?? null,
		getAll: () => raw,
		getSubgoalsEnabled: () => true,
	};
}

describe("role children-tools policy invariant (resolved)", () => {
	const groupPolicyStore = defaultGroupPolicyProvider();
	const roleNames = discoverRoleNames();

	it("the group default for Children is `never`", () => {
		assert.equal(
			groupPolicyStore.getGroupPolicy("Children"),
			"never",
			"defaults/tool-group-policies.yaml must declare `Children: never`",
		);
	});

	it("discovered at least the known roles (incl. team-lead)", () => {
		assert.ok(roleNames.includes("team-lead"), "team-lead.yaml must exist");
		assert.ok(roleNames.length >= 10, `expected many roles, found ${roleNames.length}`);
	});

	for (const tool of CHILDREN_TOOLS) {
		it(`team-lead resolves ${tool} to allow`, () => {
			const role = loadRole("team-lead");
			assert.equal(
				resolveGrantPolicy(tool, "Children", role, undefined, groupPolicyStore),
				"allow",
				`team-lead must resolve ${tool} to allow (always-allow → allow)`,
			);
		});
	}

	for (const roleName of roleNames) {
		if (roleName === "team-lead") continue;
		for (const tool of CHILDREN_TOOLS) {
			it(`${roleName} resolves ${tool} to never`, () => {
				const role = loadRole(roleName);
				assert.equal(
					resolveGrantPolicy(tool, "Children", role, undefined, groupPolicyStore),
					"never",
					`${roleName} must resolve ${tool} to never (only team-lead may use Children tools)`,
				);
			});
		}
	}
});
