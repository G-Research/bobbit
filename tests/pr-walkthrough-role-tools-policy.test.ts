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

const { resolveGrantPolicy, computeEffectiveAllowedTools, computeToolPolicies } = await import("../src/server/agent/tool-activation.ts");
const { generateToolGuardExtension } = await import("../src/server/agent/tool-guard-extension.ts");
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

function loadRole(file: string): { name?: string; label?: string; accessory?: string; toolPolicies?: Record<string, GrantPolicy> } {
	return YAML.parse(fs.readFileSync(file, "utf-8")) as { name?: string; label?: string; accessory?: string; toolPolicies?: Record<string, GrantPolicy> };
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

	// T-9 (unit) — launch-UX naming/visuals (design pr-walkthrough-launch-ux.md §5.3).
	// The reviewer child's session + sidebar title is "PR Walkthrough" and its sprite
	// is the magnifying-glass. The role drives the role display label + the generic
	// accessory application in session-setup; the prior `review` accessory was not even
	// a real sprite id (src/ui/bobbit-sprite-data.ts → `magnifier`). Pin both so a
	// regression to "PR Walkthrough Reviewer"/`review` is caught at the role source.
	it("the pr-reviewer role uses label `PR Walkthrough` and the `magnifier` accessory", () => {
		const reviewer = loadRole(PR_REVIEWER_ROLE_FILE);
		assert.equal(reviewer.label, "PR Walkthrough", "pr-reviewer.yaml label must be exactly `PR Walkthrough`");
		assert.equal(reviewer.accessory, "magnifier", "pr-reviewer.yaml accessory must be `magnifier` (the real sprite id)");
		assert.notEqual(reviewer.label, "PR Walkthrough Reviewer", "the stale `PR Walkthrough Reviewer` label must not return");
		assert.notEqual(reviewer.accessory, "review", "the bogus `review` accessory (not a sprite) must not return");
	});

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
				`pr-reviewer must resolve ${tool} to allow (role group allow beats group default-deny)`,
			);
		});
	}

	// GAP 2: the reviewer must resolve to EXACTLY the three walkthrough tools — no
	// state-mutating / orchestration tools leak through. Enumerate every FIXED tool
	// shipped under defaults/tools and assert the pr-reviewer role resolves only the
	// PR Walkthrough trio to a non-`never` policy; every other tool resolves to
	// `never`. (Dynamic per-server MCP tool groups use runtime keys not expressible
	// in a static role file and are out of scope for this fixed-surface assertion.)
	const TOOLS_DIR = path.join(DEFAULTS_DIR, "tools");
	function enumerateFixedTools(): Array<{ name: string; group: string }> {
		const out: Array<{ name: string; group: string }> = [];
		for (const groupDir of fs.readdirSync(TOOLS_DIR)) {
			const abs = path.join(TOOLS_DIR, groupDir);
			if (!fs.statSync(abs).isDirectory()) continue;
			for (const file of fs.readdirSync(abs)) {
				if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
				const doc = YAML.parse(fs.readFileSync(path.join(abs, file), "utf-8")) as { name?: string; group?: string } | null;
				if (doc && typeof doc.name === "string" && typeof doc.group === "string") {
					out.push({ name: doc.name, group: doc.group });
				}
			}
		}
		return out;
	}

	it("pr-reviewer resolves to EXACTLY the three walkthrough tools across the fixed tool surface", () => {
		const reviewer = loadRole(PR_REVIEWER_ROLE_FILE);
		const fixedTools = enumerateFixedTools();
		assert.ok(fixedTools.length >= 20, "expected to enumerate the full fixed tool surface");

		const allowed: string[] = [];
		for (const { name, group } of fixedTools) {
			const policy = resolveGrantPolicy(name, group, reviewer, undefined, groupPolicyStore);
			if (policy !== "never") allowed.push(name);
		}
		assert.deepEqual(
			allowed.sort(),
			[...PR_WALKTHROUGH_TOOLS].sort(),
			"pr-reviewer must resolve ONLY the three PR Walkthrough tools to a non-never policy",
		);
	});

	// FINDING 1 (fail CLOSED against DYNAMIC MCP tools): with ANY MCP server
	// configured, `computeEffectiveAllowedTools` adds the server's meta-tool plus
	// `mcp_describe` (both default-allow), and a static role file cannot enumerate
	// the runtime `mcp__<server>` key. The pr-reviewer role's WILDCARD `mcp__: never`
	// must deny every MCP server at once, so the resolved set stays EXACTLY the three
	// walkthrough tools even with a fake MCP server present.
	// A1 (guard-GENERATION path — the path that was actually bugged). The existing
	// assertions above prove the *role policy* (`resolveGrantPolicy`). This block
	// proves the downstream artefact the bug corrupted: the generated tool GUARD.
	//
	// Root cause recap: `session-setup._resolveToolActivation` resolved the role via
	// `roleManager.getRole` only → `undefined` for the pack-shipped `pr-reviewer`
	// → `computeToolPolicies` fell through to the `PR Walkthrough: never` group
	// default → the three tools were stamped into the guard's `neverPolicies` map
	// → every reviewer tool call was hard-blocked ("not permitted for this role").
	//
	// GIVEN the cascade-resolved `pr-reviewer` role (what the fixed `lookupRole`
	// returns), `computeToolPolicies` / `generateToolGuardExtension` must produce a
	// guard with NO `never` entry for the three tools. The contrast case (role
	// undefined — the bug) is asserted too, so this test pins the exact regression.
	describe("A1 — generated tool GUARD does not block the reviewer tools", () => {
		// Minimal ToolManager exposing the three walkthrough tools (+ a representative
		// mutating tool). The tool YAMLs declare no grantPolicy, so getToolByName
		// returns undefined — faithfully reproducing the runtime cascade.
		const guardToolManager = {
			getAvailableTools: () => [
				...PR_WALKTHROUGH_TOOLS.map(name => ({ name, group: PR_WALKTHROUGH_GROUP })),
				{ name: "write", group: "File System" },
			],
			getToolByName: () => undefined,
		} as unknown as Parameters<typeof computeToolPolicies>[0];

		/** Names the generated guard would hard-block (its `neverPolicies` keys). */
		function guardNeverNames(role: { toolPolicies?: Record<string, GrantPolicy> } | undefined): string[] {
			const policies = computeToolPolicies(guardToolManager, undefined, role, groupPolicyStore);
			const code = generateToolGuardExtension("prw-guard-test", policies, []);
			// Extract the embedded `const neverPolicies = {…};` object literal and read its keys.
			const m = code.match(/const neverPolicies = (\{.*?\});/s);
			assert.ok(m, "generated guard must embed a neverPolicies map");
			return Object.keys(JSON.parse(m![1]));
		}

		it("the resolved pr-reviewer role stamps NO `never` guard entry for any of the three tools", () => {
			const reviewer = loadRole(PR_REVIEWER_ROLE_FILE);
			const policies = computeToolPolicies(guardToolManager, undefined, reviewer, groupPolicyStore);
			for (const tool of PR_WALKTHROUGH_TOOLS) {
				assert.notEqual(
					policies[tool]?.policy,
					"never",
					`guard policy for ${tool} must not be \`never\` for the resolved pr-reviewer role`,
				);
			}
			const neverNames = guardNeverNames(reviewer);
			for (const tool of PR_WALKTHROUGH_TOOLS) {
				assert.ok(
					!neverNames.includes(tool),
					`generated guard must NOT hard-block ${tool} (found it in neverPolicies)`,
				);
			}
		});

		it("REGRESSION GUARD: an UNRESOLVED role (the bug) DOES stamp `never` for all three", () => {
			// This is exactly what `_resolveToolActivation` produced before the fix
			// (effectiveRole === undefined). If the guard generation ever stopped
			// honouring the group default-deny, the fix above would be a no-op and this
			// assertion catches it.
			const neverNames = guardNeverNames(undefined);
			for (const tool of PR_WALKTHROUGH_TOOLS) {
				assert.ok(
					neverNames.includes(tool),
					`without a resolved role the group default-deny must hard-block ${tool}`,
				);
			}
		});
	});

	it("pr-reviewer resolves to EXACTLY the three walkthrough tools even with an MCP server configured", () => {
		const reviewer = loadRole(PR_REVIEWER_ROLE_FILE);
		const fixedTools = enumerateFixedTools();

		// Minimal ToolManager exposing the full fixed tool surface. The tool YAMLs
		// declare no grantPolicy, so getToolByName returns undefined (the runtime cascade).
		const toolManager = {
			getAvailableTools: () => fixedTools.map(t => ({ name: t.name, group: t.group })),
			getToolByName: () => undefined,
		} as unknown as Parameters<typeof computeEffectiveAllowedTools>[0];

		// A fake MCP server exposing one per-op tool `mcp__fake__do`. Without the
		// wildcard deny this surfaces the `mcp_fake` meta-tool + `mcp_describe`.
		const fakeMcpManager = {
			getToolInfos: () => [{ name: "mcp__fake__do", serverName: "fake", group: "MCP: fake" }],
		};

		const effective = computeEffectiveAllowedTools(toolManager, reviewer, groupPolicyStore, fakeMcpManager)
			.map(t => t.name)
			.sort();
		assert.deepEqual(
			effective,
			[...PR_WALKTHROUGH_TOOLS].sort(),
			"pr-reviewer must resolve ONLY the three PR Walkthrough tools (no mcp__/mcp_ tools) with an MCP server configured",
		);
	});
});
