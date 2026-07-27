// v2-native — strict read-only Systems reviewer role/tool-policy coverage.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import type { ToolManager } from "../../src/server/agent/tool-manager.ts";
import {
	resolveGrantPolicy,
	type GroupPolicyProvider,
} from "../../src/server/agent/tool-activation.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ROLE_FILE = path.join(ROOT, "defaults", "roles", "systems-reviewer.yaml");
const TOOL_ROOT = path.join(ROOT, "defaults", "tools");
const ALLOWED = new Set(["read_branch_diff", "systems_review_result"]);
type GrantPolicy = "allow" | "ask" | "never";

type RoleDocument = {
	name?: string;
	promptTemplate?: string;
	toolPolicies?: Record<string, GrantPolicy>;
};

type ToolDocument = {
	name?: string;
	group?: string;
	grantPolicy?: GrantPolicy;
};

function yamlFiles(root: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) out.push(...yamlFiles(full));
		else if (/\.ya?ml$/.test(entry.name)) out.push(full);
	}
	return out;
}

function loadRole(): RoleDocument {
	return YAML.parse(fs.readFileSync(ROLE_FILE, "utf8")) as RoleDocument;
}

function bundledTools(): Array<Required<Pick<ToolDocument, "name" | "group">> & ToolDocument> {
	return yamlFiles(TOOL_ROOT).flatMap((file) => {
		const doc = YAML.parse(fs.readFileSync(file, "utf8")) as ToolDocument;
		return typeof doc.name === "string" && typeof doc.group === "string" ? [doc as never] : [];
	});
}

function toolManager(tools: ToolDocument[]): ToolManager {
	return {
		getToolByName(name: string) {
			return tools.find((tool) => tool.name?.toLowerCase() === name.toLowerCase());
		},
	} as unknown as ToolManager;
}

function groupPolicies(): GroupPolicyProvider {
	const policies = YAML.parse(
		fs.readFileSync(path.join(ROOT, "defaults", "tool-group-policies.yaml"), "utf8"),
	) as Record<string, GrantPolicy>;
	return {
		getGroupPolicy: (group: string) => policies[group] ?? null,
		getAll: () => policies,
		getSubgoalsEnabled: () => true,
	};
}

describe("systems-reviewer strict read-only policy", () => {
	it("declares exactly the two dedicated tools as allowed and never uses ask", () => {
		const role = loadRole();
		expect(role.name).toBe("systems-reviewer");
		const policies = role.toolPolicies ?? {};
		expect(Object.entries(policies).filter(([, policy]) => policy === "allow").map(([name]) => name).sort())
			.toEqual([...ALLOWED].sort());
		expect(Object.entries(policies).filter(([, policy]) => policy === "ask"), "a verifier cannot wait for grants")
			.toEqual([]);
		for (const tool of ALLOWED) expect(policies[tool]).toBe("allow");
	});

	it("resolves every other bundled tool to never, including nominally read-only generic tools", () => {
		const role = loadRole();
		const tools = bundledTools();
		expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([...ALLOWED]));
		const manager = toolManager(tools);
		const groups = groupPolicies();
		const unexpectedlyAvailable = tools
			.filter((tool) => !ALLOWED.has(tool.name))
			.filter((tool) => resolveGrantPolicy(tool.name, tool.group, role as never, manager, groups) !== "never")
			.map((tool) => `${tool.group}/${tool.name}`)
			.sort();
		expect(unexpectedlyAvailable, "systems-reviewer must expose no generic filesystem, shell, network, orchestration, or posting surface")
			.toEqual([]);
		for (const tool of tools.filter((candidate) => ALLOWED.has(candidate.name)))
			expect(resolveGrantPolicy(tool.name, tool.group, role as never, manager, groups)).toBe("allow");
	});

	it.each([
		["read", "File System"],
		["grep", "File System"],
		["find", "File System"],
		["write", "File System"],
		["edit", "File System"],
		["bash", "Shell"],
		["bash_bg", "Shell"],
		["team_delegate", "Agent"],
		["gate_signal", "Gates"],
		["task_update", "Tasks"],
		["propose_goal", "Proposals"],
		["bobbit_orchestrate", "Bobbit"],
		["browser_navigate", "Browser"],
		["mcp_playwright", "MCP: playwright"],
		["web_fetch", "Web"],
	])("denies forbidden capability %s", (tool, group) => {
		const role = loadRole();
		expect(resolveGrantPolicy(tool, group, role as never, undefined, groupPolicies())).toBe("never");
	});

	it("tells the verifier it cannot mutate, delegate, switch branches, or post externally", () => {
		const prompt = loadRole().promptTemplate ?? "";
		expect(prompt).toMatch(/only capabilities are `read_branch_diff` and `systems_review_result`/i);
		for (const prohibition of [
			/edit files/i,
			/execute commands/i,
			/start processes/i,
			/delegate/i,
			/signal gates/i,
			/mutate goals or tasks/i,
			/switch branches/i,
			/network or GitHub/i,
			/post externally/i,
		]) expect(prompt).toMatch(prohibition);
	});
});
