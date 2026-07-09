// v2-native — bobbit gateway tier role-policy invariant.
//
// Requirement (see defaults/tools/bobbit/*.yaml + docs/bobbit-gateway-tool.md):
//   • bobbit_orchestrate + bobbit_admin default to grantPolicy: never (hidden
//     from every session's toolset).
//   • ONLY the `general` and `team-lead` roles re-grant bobbit_orchestrate
//     (resolveGrantPolicy step 1 per-tool > step 5 YAML default).
//   • ONLY `general` gets bobbit_admin, and only behind an `ask` policy.
// This test pins that surface so a role edit can't silently widen it.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import fs from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import YAML from "yaml";

const { resolveGrantPolicy } = await import("../../src/server/agent/tool-activation.ts");
import type { GroupPolicyProvider } from "../../src/server/agent/tool-activation.ts";
import type { GrantPolicy } from "../../src/server/agent/role-store.ts";

const DEFAULTS_DIR = path.resolve(import.meta.dirname, "..", "..", "defaults");
const ROLES_DIR = path.join(DEFAULTS_DIR, "roles");
const GROUP_POLICIES_FILE = path.join(DEFAULTS_DIR, "tool-group-policies.yaml");
const BOBBIT_TOOLS_DIR = path.join(DEFAULTS_DIR, "tools", "bobbit");

const BOBBIT_GROUP = "Bobbit";

function loadGroupPolicies(): Record<string, GrantPolicy> {
	const text = fs.readFileSync(GROUP_POLICIES_FILE, "utf-8");
	return (YAML.parse(text) ?? {}) as Record<string, GrantPolicy>;
}

function loadRole(name: string): { toolPolicies?: Record<string, GrantPolicy> } {
	const text = fs.readFileSync(path.join(ROLES_DIR, `${name}.yaml`), "utf-8");
	return YAML.parse(text) as { toolPolicies?: Record<string, GrantPolicy> };
}

/** Top-level role names discovered under defaults/roles. */
function allRoleNames(): string[] {
	return fs
		.readdirSync(ROLES_DIR, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".yaml"))
		.map((e) => e.name.replace(/\.yaml$/, ""));
}

/** Read a bobbit tool YAML's declared group + grantPolicy default. */
function bobbitToolDef(toolName: string): { group?: string; grantPolicy?: GrantPolicy } {
	const def = YAML.parse(fs.readFileSync(path.join(BOBBIT_TOOLS_DIR, `${toolName}.yaml`), "utf-8")) as {
		group?: string;
		grantPolicy?: GrantPolicy;
	};
	return def;
}

function defaultGroupPolicyProvider(): GroupPolicyProvider {
	const raw = loadGroupPolicies();
	return {
		getGroupPolicy: (group: string) => raw[group] ?? null,
		getAll: () => raw,
		getSubgoalsEnabled: () => true,
	};
}

// Minimal ToolManager stub: resolveGrantPolicy step 5 reads the tool YAML's
// grantPolicy default, so the `never` default is only observable with a manager.
function bobbitToolManager(): { getToolByName: (name: string) => { grantPolicy?: GrantPolicy; group?: string } | undefined } {
	return {
		getToolByName: (name: string) => {
			if (!name.startsWith("bobbit_")) return undefined;
			const def = bobbitToolDef(name);
			return { grantPolicy: def.grantPolicy, group: def.group };
		},
	};
}

describe("bobbit tier YAML defaults", () => {
	it("bobbit_orchestrate + bobbit_admin default to grantPolicy: never, group Bobbit", () => {
		for (const tool of ["bobbit_orchestrate", "bobbit_admin"]) {
			const def = bobbitToolDef(tool);
			assert.equal(def.grantPolicy, "never", `${tool}.yaml must declare \`grantPolicy: never\``);
			assert.equal(def.group, BOBBIT_GROUP, `${tool}.yaml must declare \`group: ${BOBBIT_GROUP}\``);
		}
	});

	it("bobbit_read stays grantPolicy: allow in group Bobbit", () => {
		const def = bobbitToolDef("bobbit_read");
		assert.equal(def.grantPolicy, "allow");
		assert.equal(def.group, BOBBIT_GROUP);
	});
});

describe("bobbit tier resolved role policy", () => {
	const groupPolicyStore = defaultGroupPolicyProvider();
	const toolManager = bobbitToolManager();

	const resolve = (tool: string, role: { toolPolicies?: Record<string, GrantPolicy> } | undefined) =>
		resolveGrantPolicy(tool, BOBBIT_GROUP, role, toolManager as never, groupPolicyStore);

	it("a role with no bobbit grant resolves both tiers to never", () => {
		const coder = loadRole("coder");
		assert.equal(resolve("bobbit_orchestrate", coder), "never");
		assert.equal(resolve("bobbit_admin", coder), "never");
	});

	it("general resolves bobbit_orchestrate=allow and bobbit_admin=ask", () => {
		const general = loadRole("general");
		assert.equal(resolve("bobbit_orchestrate", general), "allow");
		assert.equal(resolve("bobbit_admin", general), "ask");
	});

	it("team-lead resolves bobbit_orchestrate=allow and bobbit_admin=never (not granted)", () => {
		const lead = loadRole("team-lead");
		assert.equal(resolve("bobbit_orchestrate", lead), "allow");
		assert.equal(resolve("bobbit_admin", lead), "never");
	});
});

describe("bobbit tier grant surface is exactly {general, team-lead} / {general}", () => {
	const groupPolicyStore = defaultGroupPolicyProvider();
	const toolManager = bobbitToolManager();

	it("ONLY general + team-lead resolve bobbit_orchestrate to non-never", () => {
		const granted = allRoleNames().filter(
			(name) =>
				resolveGrantPolicy("bobbit_orchestrate", BOBBIT_GROUP, loadRole(name), toolManager as never, groupPolicyStore) !==
				"never",
		);
		assert.deepEqual(granted.sort(), ["general", "team-lead"]);
	});

	it("ONLY general resolves bobbit_admin to non-never (and it is `ask`)", () => {
		const granted = allRoleNames().filter(
			(name) =>
				resolveGrantPolicy("bobbit_admin", BOBBIT_GROUP, loadRole(name), toolManager as never, groupPolicyStore) !==
				"never",
		);
		assert.deepEqual(granted.sort(), ["general"]);
		assert.equal(
			resolveGrantPolicy("bobbit_admin", BOBBIT_GROUP, loadRole("general"), toolManager as never, groupPolicyStore),
			"ask",
		);
	});
});
