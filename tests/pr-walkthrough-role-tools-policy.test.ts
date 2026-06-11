/**
 * Role↔tool-group boundary for the PR-walkthrough host.agents reviewer migration
 * (design Decision C). The three reviewer tools share `group: PR Walkthrough`:
 *   readonly_bash, read_pr_walkthrough_bundle, submit_pr_walkthrough_yaml
 *
 * For "only the reviewer submits" to hold WITHOUT a secret, the group must be
 * DEFAULT-DENY for everyone else, and the pack-shipped `pr-reviewer` role must
 * re-grant it. This test asserts the *resolved* policy (mirroring runtime
 * `resolveGrantPolicy`), not just YAML declarations:
 *   - the group default in `defaults/tool-group-policies.yaml` is `never`;
 *   - a `general` role AND an unrestricted (role-less) session resolve all three
 *     tools to `never` (group default-deny, resolveGrantPolicy step 4);
 *   - the pack `pr-reviewer` role resolves all three to `allow` (its group-level
 *     `toolPolicies: { "PR Walkthrough": allow }` beats the group default,
 *     resolveGrantPolicy step 2 > step 4).
 *
 * The tool YAMLs declare no `grantPolicy`, so passing `toolManager=undefined`
 * (skipping step 3) faithfully reproduces the runtime cascade for these tools.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const { resolveGrantPolicy } = await import("../src/server/agent/tool-activation.ts");
import type { GrantPolicy, GroupPolicyProvider } from "../src/server/agent/tool-activation.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULTS_DIR = path.join(ROOT, "defaults");
const GROUP_POLICIES_FILE = path.join(DEFAULTS_DIR, "tool-group-policies.yaml");
const GENERAL_ROLE_FILE = path.join(DEFAULTS_DIR, "roles", "general.yaml");
const PR_REVIEWER_ROLE_FILE = path.join(ROOT, "market-packs", "pr-walkthrough", "roles", "pr-reviewer.yaml");

const PR_WALKTHROUGH_GROUP = "PR Walkthrough";
const PR_WALKTHROUGH_TOOLS = [
	"readonly_bash",
	"read_pr_walkthrough_bundle",
	"submit_pr_walkthrough_yaml",
];

function loadRole(file: string): { toolPolicies?: Record<string, GrantPolicy> } {
	return YAML.parse(fs.readFileSync(file, "utf-8")) as { toolPolicies?: Record<string, GrantPolicy> };
}

/** Group-policy provider backed by defaults/tool-group-policies.yaml. */
function defaultGroupPolicyProvider(): GroupPolicyProvider {
	const raw = YAML.parse(fs.readFileSync(GROUP_POLICIES_FILE, "utf-8")) as Record<string, GrantPolicy>;
	return {
		getGroupPolicy: (group: string) => raw[group] ?? null,
		getAll: () => raw,
		getSubgoalsEnabled: () => true,
	};
}

describe("PR Walkthrough role↔tool-group boundary (resolved)", () => {
	const groupPolicyStore = defaultGroupPolicyProvider();

	it("the group default for `PR Walkthrough` is `never`", () => {
		assert.equal(
			groupPolicyStore.getGroupPolicy(PR_WALKTHROUGH_GROUP),
			"never",
			"defaults/tool-group-policies.yaml must declare `PR Walkthrough: never`",
		);
	});

	const general = loadRole(GENERAL_ROLE_FILE);
	for (const tool of PR_WALKTHROUGH_TOOLS) {
		it(`general role resolves ${tool} to never`, () => {
			assert.equal(
				resolveGrantPolicy(tool, PR_WALKTHROUGH_GROUP, general, undefined, groupPolicyStore),
				"never",
				`a normal session must not be granted ${tool}`,
			);
		});

		it(`an unrestricted (role-less) session resolves ${tool} to never`, () => {
			assert.equal(
				resolveGrantPolicy(tool, PR_WALKTHROUGH_GROUP, undefined, undefined, groupPolicyStore),
				"never",
				`an unrestricted session must not be granted ${tool} (group default-deny)`,
			);
		});
	}

	it("the pack pr-reviewer role grants the `PR Walkthrough` group", () => {
		const reviewer = loadRole(PR_REVIEWER_ROLE_FILE);
		assert.equal(
			reviewer.toolPolicies?.[PR_WALKTHROUGH_GROUP],
			"allow",
			"pr-reviewer.yaml must grant `PR Walkthrough: allow`",
		);
	});

	for (const tool of PR_WALKTHROUGH_TOOLS) {
		it(`pr-reviewer role resolves ${tool} to allow`, () => {
			const reviewer = loadRole(PR_REVIEWER_ROLE_FILE);
			assert.equal(
				resolveGrantPolicy(tool, PR_WALKTHROUGH_GROUP, reviewer, undefined, groupPolicyStore),
				"allow",
				`pr-reviewer must resolve ${tool} to allow (role group grant beats group default-deny)`,
			);
		});
	}
});
