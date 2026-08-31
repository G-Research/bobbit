import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { resolveGrantPolicy, type GroupPolicyProvider } from "../../../src/server/agent/tool-activation.ts";
import type { GrantPolicy } from "../../../src/server/agent/role-store.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const groupPolicies = YAML.parse(
	fs.readFileSync(path.join(repoRoot, "defaults", "tool-group-policies.yaml"), "utf8"),
) as Record<string, GrantPolicy>;

const reviewerRoleFiles = [
	"defaults/roles/reviewer.yaml",
	"defaults/roles/code-reviewer.yaml",
	"defaults/roles/bug-hunter.yaml",
	"defaults/roles/verifiable-bug-hunter.yaml",
	"defaults/roles/security-reviewer.yaml",
	"defaults/roles/systems-reviewer.yaml",
	"defaults/roles/architect.yaml",
	"defaults/roles/spec-auditor.yaml",
	".bobbit/config/roles/spec-auditor.yaml",
	"market-packs/pr-walkthrough/roles/pr-reviewer.yaml",
];

const groupPolicyStore: GroupPolicyProvider = {
	getGroupPolicy: (group) => groupPolicies[group] ?? null,
	getAll: () => groupPolicies,
	getSubgoalsEnabled: () => true,
};

describe("reviewer roles cannot read other session transcripts", () => {
	for (const relativePath of reviewerRoleFiles) {
		it(`${relativePath} explicitly denies read_session`, () => {
			const role = YAML.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8")) as {
				toolPolicies?: Record<string, GrantPolicy>;
			};

			expect(role.toolPolicies?.read_session).toBe("never");
			expect(resolveGrantPolicy("read_session", "Agent", role, undefined, groupPolicyStore)).toBe("never");
		});
	}
});
