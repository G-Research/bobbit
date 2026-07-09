// v2-native — bobbit gateway tool suite. Listed in tests-map.json `v2Native`.
//
// Tier separation: each YAML declares its own `group` + `grantPolicy` defaults,
// and the on-wire `operation` union of each tool matches both the dispatched
// operation catalogue (drift guard vs code) and the design §5 catalogue.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	loadBobbitTools,
	operationUnion,
	BOBBIT_OPERATIONS,
	type CapturedTool,
} from "./helpers/bobbit-harness.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const YAML_DIR = path.join(ROOT, "defaults", "tools", "bobbit");

// Design §5 catalogue — pinned so YAML/code changes that add or drop an
// operation must consciously update this test.
const EXPECTED_OPS = {
	bobbit_read: [
		"health", "connection_info", "list_goals", "get_goal", "goal_cost",
		"goal_git_status", "goal_commits", "goal_pr_status", "list_sessions",
		"get_session", "session_cost", "search", "list_projects", "get_project",
		"list_workflows", "get_workflow", "list_roles", "list_tools", "list_gates",
		"list_tasks", "get_task", "list_staff", "list_mcp_servers", "maintenance_inspect",
	],
	bobbit_orchestrate: [
		"create_goal", "update_goal", "archive_goal", "create_session",
		"terminate_session", "restart_session", "create_task", "update_task",
		"transition_task", "assign_task", "signal_gate", "reset_gate",
		"cancel_verification", "create_staff", "team_start", "team_teardown",
	],
	bobbit_admin: [
		"update_project_config", "set_provider_key", "delete_provider_key",
		"custom_providers", "aigw_configure", "marketplace_install",
		"marketplace_update", "marketplace_uninstall", "tool_override",
		"role_override", "workflow_override", "maintenance_cleanup",
		"sandbox_image_build", "system_prompt_customise", "harness_restart", "shutdown",
	],
} as const;

const EXPECTED_TIERS: Record<string, { group: string; grantPolicy: string; file: string }> = {
	bobbit_read: { group: "Bobbit", grantPolicy: "allow", file: "bobbit_read.yaml" },
	bobbit_orchestrate: { group: "Bobbit", grantPolicy: "never", file: "bobbit_orchestrate.yaml" },
	bobbit_admin: { group: "Bobbit", grantPolicy: "never", file: "bobbit_admin.yaml" },
};

function yamlField(raw: string, key: string): string | undefined {
	const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
	return m ? m[1].trim() : undefined;
}

let tools: Map<string, CapturedTool>;

beforeAll(() => {
	process.env.BOBBIT_TOKEN = "tok";
	process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
	tools = loadBobbitTools();
});

describe("bobbit tiers — YAML group & grantPolicy", () => {
	for (const [name, expected] of Object.entries(EXPECTED_TIERS)) {
		it(`${name}: group=${expected.group}, grantPolicy=${expected.grantPolicy}`, () => {
			const raw = readFileSync(path.join(YAML_DIR, expected.file), "utf8");
			expect(yamlField(raw, "name")).toBe(name);
			expect(yamlField(raw, "group")).toBe(expected.group);
			expect(yamlField(raw, "grantPolicy")).toBe(expected.grantPolicy);
			// tool.description budget parity: the YAML description matches the code.
			const desc = tools.get(name)!.description ?? "";
			expect(desc.length).toBeLessThanOrEqual(150);
		});
	}
});

describe("bobbit tiers — operation catalogue drift guard", () => {
	for (const name of Object.keys(EXPECTED_TIERS)) {
		it(`${name}: dispatched ops match the design §5 catalogue`, () => {
			const expected = [...EXPECTED_OPS[name as keyof typeof EXPECTED_OPS]].sort();
			// Dispatch table keys exported from the extension.
			expect([...BOBBIT_OPERATIONS[name as keyof typeof BOBBIT_OPERATIONS]].sort()).toEqual(expected);
			// On-wire operation union in the registered tool schema.
			expect(operationUnion(tools.get(name)!).sort()).toEqual(expected);
		});
	}
});
