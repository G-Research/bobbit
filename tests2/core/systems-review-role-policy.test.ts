// v2-native — strict read-only Systems reviewer role/tool-policy coverage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
	ToolManager,
	__resetToolScanCache,
	type PiExtensionExternalTool,
	type ScopedToolContext,
} from "../../src/server/agent/tool-manager.ts";
import {
	computeEffectiveAllowedTools,
	computeToolActivationArgs,
	computeToolPolicies,
	resolveGrantPolicy,
	SYSTEMS_REVIEWER_HARD_ALLOWED_TOOLS,
	writeMcpProxyExtensions,
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

function writeExtensionTool(root: string, groupDir: string, name: string, group: string): void {
	const dir = path.join(root, groupDir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${name}.yaml`), [
		`name: ${name}`,
		`description: ${name} test contribution`,
		`group: ${group}`,
		"grantPolicy: allow",
		"provider:",
		"  type: bobbit-extension",
		"  extension: extension.ts",
		"",
	].join("\n"));
	fs.writeFileSync(path.join(dir, "extension.ts"), "export default function extension() {}\n");
}

function extensionPaths(args: string[]): string[] {
	return args.filter((_arg, index) => index > 0 && args[index - 1] === "--extension");
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

	it("hard-limits activation and prompt docs despite unknown YAML, scoped, MCP, and marketplace allow overrides", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "systems-reviewer-hard-tools-"));
		const configDir = path.join(root, "config");
		const configTools = path.join(configDir, "tools");
		const marketTools = path.join(root, "market-packs", "future-pack", "tools");
		const context: ScopedToolContext = { scopeKey: "project:systems-policy", projectId: "systems-policy" };
		try {
			writeExtensionTool(configTools, "future-posting", "unknown_yaml_post", "Future Posting");
			writeExtensionTool(marketTools, "market-posting", "marketplace_post", "Marketplace Posting");
			__resetToolScanCache();
			const manager = new ToolManager(configDir, TOOL_ROOT);
			manager.setMarketToolRootsProvider(() => [{ dir: marketTools }]);
			manager.setScopedPiExtensionTools(context, [{
				name: "scoped_pi_post",
				description: "project-scoped posting extension",
				packName: "Scoped Pack",
				packId: "scoped-pack",
				listName: "poster",
				scope: "project",
			} satisfies PiExtensionExternalTool]);

			const role = {
				...loadRole(),
				toolPolicies: {
					...loadRole().toolPolicies,
					read_branch_diff: "never",
					systems_review_result: "ask",
					"Future Posting": "allow",
					"Marketplace Posting": "allow",
					"Pi Extensions": "allow",
					unknown_yaml_post: "allow",
					marketplace_post: "allow",
					scoped_pi_post: "allow",
					mcp__: "allow",
					mcp_remote: "allow",
					mcp_broken: "allow",
				},
			} satisfies RoleDocument;
			const ordinaryRole = { ...role, name: "ordinary-reviewer" };
			const allAllowGroups: GroupPolicyProvider = {
				getGroupPolicy: () => "allow",
				getAll: () => ({
					"Future Posting": "allow",
					"Marketplace Posting": "allow",
					"Pi Extensions": "allow",
					"MCP: remote": "allow",
				}),
				getSubgoalsEnabled: () => true,
			};
			const mcpInfos = [{
				name: "mcp__remote__post",
				serverName: "remote",
				mcpToolName: "post",
				group: "MCP: remote",
				description: "post remotely",
				inputSchema: { type: "object", properties: {} },
			}];
			const mcpManager = {
				getToolInfos: () => mcpInfos,
				getServerStatuses: () => [{ name: "broken", status: "error", toolCount: 0, error: "offline" }],
				getScopeKey: () => context.scopeKey,
			};

			const effective = computeEffectiveAllowedTools(manager, role, allAllowGroups, mcpManager, context);
			const names = effective.map((tool) => tool.name).sort();
			expect(names).toEqual([...SYSTEMS_REVIEWER_HARD_ALLOWED_TOOLS].sort());
			const systemsPolicies = computeToolPolicies(manager, mcpManager as never, role, allAllowGroups, context);
			expect(systemsPolicies).toMatchObject({
				read_branch_diff: { policy: "allow" },
				systems_review_result: { policy: "allow" },
				unknown_yaml_post: { policy: "never" },
				marketplace_post: { policy: "never" },
				scoped_pi_post: { policy: "never" },
				mcp__remote__post: { policy: "never" },
			});

			// The only differing policy input is the role id. This pins role-aware
			// cache keys and proves the hard boundary does not narrow ordinary roles.
			const ordinaryNames = computeEffectiveAllowedTools(manager, ordinaryRole, allAllowGroups, mcpManager, context)
				.map((tool) => tool.name);
			expect(ordinaryNames).toEqual(expect.arrayContaining([
				"unknown_yaml_post",
				"marketplace_post",
				"scoped_pi_post",
				"mcp_remote",
			]));
			expect(computeToolPolicies(manager, mcpManager as never, ordinaryRole, allAllowGroups, context)).toMatchObject({
				unknown_yaml_post: { policy: "allow" },
				marketplace_post: { policy: "allow" },
				scoped_pi_post: { policy: "allow" },
				mcp__remote__post: { policy: "allow" },
			});

			const docs = manager.getToolDocsForPrompt(names, undefined, context);
			expect(docs).toContain("read_branch_diff");
			expect(docs).toContain("systems_review_result");
			for (const denied of ["unknown_yaml_post", "marketplace_post", "scoped_pi_post", "mcp_remote"]) {
				expect(docs).not.toContain(denied);
			}

			const mcpExtensions = writeMcpProxyExtensions(
				mcpManager as never,
				[...names, "mcp_broken"],
				role,
				manager,
				allAllowGroups,
				undefined,
				context,
			);
			expect(mcpExtensions, "even a widened allowlist cannot activate an MCP error stub").toEqual([]);
			const ordinaryMcpExtensions = writeMcpProxyExtensions(
				mcpManager as never,
				[...names, "mcp_broken"],
				ordinaryRole,
				manager,
				allAllowGroups,
				undefined,
				context,
			);
			expect(ordinaryMcpExtensions).toHaveLength(1);
			expect(path.basename(ordinaryMcpExtensions[0])).toBe("broken.ts");
			const activation = computeToolActivationArgs(effective, manager, root, mcpExtensions, undefined, context);
			const activePaths = extensionPaths(activation.args).map((entry) => path.resolve(entry));
			expect(activePaths.some((entry) => entry.startsWith(path.resolve(configTools) + path.sep))).toBe(false);
			expect(activePaths.some((entry) => entry.startsWith(path.resolve(marketTools) + path.sep))).toBe(false);
			expect(activation.env.BOBBIT_BUILTIN_TOOLS).toBe("");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			__resetToolScanCache();
		}
	});

	it("leaves ordinary roles on the configurable policy cascade", () => {
		const role = { name: "ordinary-reviewer", toolPolicies: { future_post: "allow" as const } };
		expect(resolveGrantPolicy("future_post", "Future Posting", role, undefined, {
			getGroupPolicy: () => "never",
		})).toBe("allow");
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
