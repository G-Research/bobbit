/**
 * Unit test enforcing the team-tools group-policy invariant.
 *
 * Design: only the team lead may call team management tools (team_spawn,
 * team_dismiss, team_prompt, team_steer, team_abort, team_complete, team_list).
 * The shipping `defaults/tool-group-policies.yaml` therefore defaults the
 * `Team` group to `never`, and `defaults/roles/team-lead.yaml` overrides it
 * back to `allow` via `toolPolicies.Team`.
 *
 * Without this invariant, every contributor agent (coder, reviewer, tester …)
 * gets the team tools' system-prompt docs even though the team extension is
 * only loaded for the team-lead session — pure context bloat plus a footgun
 * that leads workers to attempt spawns that fail at runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import YAML from "yaml";

const DEFAULTS_DIR = path.resolve(import.meta.dirname, "..", "defaults");
const ROLES_DIR = path.join(DEFAULTS_DIR, "roles");
const GROUP_POLICIES_FILE = path.join(DEFAULTS_DIR, "tool-group-policies.yaml");
const TEAM_TOOLS_DIR = path.join(DEFAULTS_DIR, "tools", "team");

function loadGroupPolicies(): Record<string, string> {
	const text = fs.readFileSync(GROUP_POLICIES_FILE, "utf-8");
	return (YAML.parse(text) ?? {}) as Record<string, string>;
}

function loadRole(name: string): { toolPolicies?: Record<string, string> } {
	const text = fs.readFileSync(path.join(ROLES_DIR, `${name}.yaml`), "utf-8");
	return YAML.parse(text) as { toolPolicies?: Record<string, string> };
}

describe("team-tools group policy invariant", () => {
	it("defaults/tool-group-policies.yaml defaults Team group to never", () => {
		const policies = loadGroupPolicies();
		assert.equal(
			policies.Team,
			"never",
			"defaults/tool-group-policies.yaml must declare `Team: never` so non-lead agents never see team tools",
		);
	});

	it("team-lead.yaml re-enables the Team group via toolPolicies.Team: allow", () => {
		const role = loadRole("team-lead");
		assert.equal(
			role.toolPolicies?.Team,
			"allow",
			"team-lead.yaml must override the group default with `Team: allow` so the lead can spawn members",
		);
	});

	it("every Team-group tool actually declares group: Team", () => {
		// Sanity-check the assumption the `Team: never` policy relies on:
		// each YAML file in defaults/tools/team/ must opt into the Team group.
		const files = fs
			.readdirSync(TEAM_TOOLS_DIR)
			.filter((f) => f.endsWith(".yaml"));
		assert.ok(files.length > 0, "expected team tool YAMLs in defaults/tools/team/");
		for (const file of files) {
			const text = fs.readFileSync(path.join(TEAM_TOOLS_DIR, file), "utf-8");
			const def = YAML.parse(text) as { group?: string };
			assert.equal(
				def.group,
				"Team",
				`${file} must declare \`group: Team\` so the group-policy default applies`,
			);
		}
	});
});
