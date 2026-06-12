/**
 * Unit test enforcing the team-tools group-policy invariant.
 *
 * Design (Orchestration Core sub-goal A, docs/design/orchestration-core.md §8.1):
 * the team-tool surface is split into two policy classes:
 *
 *   • GOAL-ONLY verbs — `team_spawn`, `team_complete`, `team_list` — stay in
 *     the `Team` group, which `defaults/tool-group-policies.yaml` defaults to
 *     `never`. Only the team-lead re-enables them via `toolPolicies.Team: allow`.
 *     They are meaningless outside a goal (own worktree on a sub-branch toward a
 *     gate), so a non-goal session must NOT see them.
 *
 *   • OWN-CHILDREN ORCHESTRATION verbs — `team_delegate`, `team_wait`,
 *     `team_prompt`, `team_steer`, `team_abort`, `team_dismiss` — live in the
 *     allow-by-default `Agent` group. A NON-goal agent legitimately uses these
 *     to orchestrate the child agents it spawned with `team_delegate` (the
 *     acceptance flow: team_delegate → team_prompt → team_wait → read_session →
 *     team_dismiss). The REAL guard that a non-goal caller cannot reach a
 *     foreign/goal session is the server `/api/sessions/:id/orchestrate/*`
 *     route's own-children scoping (`orchestrationCore.list(ownerId)`), NOT the
 *     tool-group policy. The group only controls tool EXPOSURE.
 *
 * This is a deliberate invariant change from the prior "all team_* are Team"
 * rule. Pinning it here prevents a regression that would either (a) re-hide the
 * orchestration verbs from non-goal owners (breaking the acceptance flow) or
 * (b) leak the goal-only verbs to non-goal sessions.
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
const TOOLS_DIR = path.join(DEFAULTS_DIR, "tools");

/** Goal-only team verbs — must stay `group: Team` (never for non-goal). */
const GOAL_ONLY_TEAM_TOOLS = ["team_spawn", "team_complete", "team_list"];
/** Own-children orchestration verbs — must be `group: Agent` (allow-by-default). */
const AGENT_ORCHESTRATION_TOOLS = [
	"team_delegate",
	"team_wait",
	"team_prompt",
	"team_steer",
	"team_abort",
	"team_dismiss",
];

function loadGroupPolicies(): Record<string, string> {
	const text = fs.readFileSync(GROUP_POLICIES_FILE, "utf-8");
	return (YAML.parse(text) ?? {}) as Record<string, string>;
}

function loadRole(name: string): { toolPolicies?: Record<string, GrantPolicy> } {
	const text = fs.readFileSync(path.join(ROLES_DIR, `${name}.yaml`), "utf-8");
	return YAML.parse(text) as { toolPolicies?: Record<string, GrantPolicy> };
}

function defaultGroupPolicyProvider(): GroupPolicyProvider {
	const raw = loadGroupPolicies() as Record<string, GrantPolicy>;
	return {
		getGroupPolicy: (group: string) => raw[group] ?? null,
		getAll: () => raw,
		getSubgoalsEnabled: () => true,
	};
}

/**
 * Resolve a tool's declared `group:` by scanning every `defaults/tools/**\/*.yaml`.
 * Mirrors the tool-manager scan (`group = data.group || groupDir`). Returns the
 * group string, or undefined if the tool YAML is not found.
 */
function declaredGroupOf(toolName: string): string | undefined {
	for (const groupDir of fs.readdirSync(TOOLS_DIR, { withFileTypes: true })) {
		if (!groupDir.isDirectory()) continue;
		const dirPath = path.join(TOOLS_DIR, groupDir.name);
		for (const file of fs.readdirSync(dirPath)) {
			if (!file.endsWith(".yaml")) continue;
			const def = YAML.parse(fs.readFileSync(path.join(dirPath, file), "utf-8")) as
				{ name?: string; group?: string };
			if (def?.name === toolName) return def.group || groupDir.name;
		}
	}
	return undefined;
}

describe("team-tools group policy invariant", () => {
	it("defaults/tool-group-policies.yaml defaults Team group to never", () => {
		const policies = loadGroupPolicies();
		assert.equal(
			policies.Team,
			"never",
			"defaults/tool-group-policies.yaml must declare `Team: never` so non-lead agents never see goal-only team tools",
		);
	});

	it("Agent group is NOT denied (allow-by-default for orchestration verbs)", () => {
		const policies = loadGroupPolicies();
		assert.notEqual(
			policies.Agent,
			"never",
			"Agent group must remain allow-by-default so non-goal owners can orchestrate their own children",
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

	it("goal-only verbs declare group: Team", () => {
		for (const tool of GOAL_ONLY_TEAM_TOOLS) {
			assert.equal(
				declaredGroupOf(tool),
				"Team",
				`${tool} must declare \`group: Team\` (goal-only; stripped from non-goal sessions)`,
			);
		}
	});

	it("own-children orchestration verbs declare group: Agent", () => {
		for (const tool of AGENT_ORCHESTRATION_TOOLS) {
			assert.equal(
				declaredGroupOf(tool),
				"Agent",
				`${tool} must declare \`group: Agent\` (own-children orchestration; allow-by-default, server-side scoped)`,
			);
		}
	});
});

describe("non-goal session resolved team-tool policy (the deliberate invariant change)", () => {
	const groupPolicyStore = defaultGroupPolicyProvider();
	// A non-goal session with no role-level overrides — the default contributor.
	const noRole = undefined;

	for (const tool of GOAL_ONLY_TEAM_TOOLS) {
		it(`non-goal session resolves ${tool} to never (goal-only)`, () => {
			assert.equal(
				resolveGrantPolicy(tool, "Team", noRole, undefined, groupPolicyStore),
				"never",
				`${tool} must resolve to never for a non-goal session (Team group default)`,
			);
		});
	}

	for (const tool of AGENT_ORCHESTRATION_TOOLS) {
		it(`non-goal session resolves ${tool} to allow (own-children orchestration)`, () => {
			assert.equal(
				resolveGrantPolicy(tool, "Agent", noRole, undefined, groupPolicyStore),
				"allow",
				`${tool} must resolve to allow for a non-goal session; own-children scoping is enforced server-side by /orchestrate/* (orchestrationCore.list(ownerId)), not by tool-group policy`,
			);
		});
	}
});

describe("team-lead resolved policy denies the Agent-group delegation pair", () => {
	// A team lead's ONE delegation primitive is team_spawn (isolated sub-branch
	// worktree + team-manager worker-idle NOTIFICATIONS → spawn-then-go-idle).
	// team_delegate (child in the lead's OWN worktree) and team_wait (block on
	// notify-managed team workers) are NON-goal-agent verbs that broke the lead's
	// go-idle behaviour, so team-lead.yaml denies both. The goal-only Team verbs
	// stay allowed (Team: allow). read_session (also `group: Agent`) stays allowed.
	const groupPolicyStore = defaultGroupPolicyProvider();
	const leadRole = loadRole("team-lead");

	for (const tool of ["team_delegate", "team_wait"]) {
		it(`team-lead resolves ${tool} to never (stripped from the lead's tool surface)`, () => {
			assert.equal(
				leadRole.toolPolicies?.[tool],
				"never",
				`team-lead.yaml toolPolicies must set \`${tool}: never\``,
			);
			assert.equal(
				resolveGrantPolicy(tool, "Agent", leadRole, undefined, groupPolicyStore),
				"never",
				`${tool} must resolve to never for the team lead so the model can't reach for it`,
			);
		});
	}

	it("team-lead still resolves read_session to allow (Agent group, not denied)", () => {
		assert.equal(
			resolveGrantPolicy("read_session", "Agent", leadRole, undefined, groupPolicyStore),
			"allow",
			"read_session must stay available to the lead — only the delegation pair is denied",
		);
	});
});
