/**
 * Unit tests for resolveGrantPolicy() in tool-activation.ts.
 * Covers 5-layer priority resolution:
 *   role tool-specific > role group > tool YAML default > group default > system fallback ('allow').
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { computeEffectiveAllowedTools, computeToolActivationArgs, resolveGrantPolicy, writeMcpProxyExtensions } = await import("../dist/server/agent/tool-activation.js");

// Minimal mock ToolManager — only needs getToolByName()
function mockToolManager(tools: Record<string, { grantPolicy?: string }>) {
	return {
		getToolByName(name: string) {
			const key = Object.keys(tools).find(k => k.toLowerCase() === name.toLowerCase());
			return key ? tools[key] : undefined;
		},
	};
}

// Minimal mock GroupPolicyStore
function mockGroupPolicyStore(policies: Record<string, string>) {
	return {
		getGroupPolicy(group: string) {
			return policies[group] || null;
		},
		getAll() {
			return policies;
		},
	};
}

// ── Priority resolution ─────────────────────────────────────────────

describe("resolveGrantPolicy", () => {
	it("role tool-specific override wins over tool YAML default", () => {
		const role = { toolPolicies: { "mcp__pw__snap": "ask" as const } };
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "ask");
	});

	it("role group-level override when no tool-specific", () => {
		const role = { toolPolicies: { "mcp__playwright": "ask" as const } };
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp__playwright__snap", "mcp__playwright", role, tm), "ask");
	});

	it("tool YAML default when no role toolPolicies", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "ask");
	});

	it("returns allow (system fallback) when no configuration exists", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "allow");
	});

	it("falls through to tool YAML when role is undefined", () => {
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, tm), "ask");
	});

	it("returns allow with undefined role and no tool grantPolicy", () => {
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, tm), "allow");
	});

	it("returns allow with undefined toolManager and no role policy", () => {
		const role = {};
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, undefined), "allow");
	});

	it("falls through to tool YAML with empty toolPolicies", () => {
		const role = { toolPolicies: {} };
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "ask");
	});

	it("returns allow with empty toolPolicies and no tool grantPolicy", () => {
		const role = { toolPolicies: {} };
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "allow");
	});

	it("priority: role tool > role group > YAML — all three set", () => {
		const role = {
			toolPolicies: {
				"mcp__pw__snap": "never" as const,
				"mcp__pw": "ask" as const,
			},
		};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "never");
	});

	it("explicit never via role toolPolicies", () => {
		const role = { toolPolicies: { "mcp__pw__snap": "never" as const } };
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, undefined), "never");
	});

	it("returns allow when both role and toolManager are undefined", () => {
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", undefined, undefined), "allow");
	});

	it("MCP prefix policies still apply when toolGroup is undefined", () => {
		const role = { toolPolicies: { "mcp__pw": "ask" as const } };
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp__pw__snap", undefined, role, tm), "ask");
	});

	it("group override wins over tool YAML default", () => {
		const role = {
			toolPolicies: { "mcp__pw": "ask" as const },
		};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask" } });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm), "ask");
	});

	it("tool not found in toolManager returns allow (no role policy)", () => {
		const role = {};
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp__unknown__tool", "mcp__unknown", role, tm), "allow");
	});

	// ── Layer 4: Group default policy ─────────────────────────────────

	it("group default policy wins over system fallback", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": {} });
		const gps = mockGroupPolicyStore({ "mcp__pw": "ask" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "ask");
	});

	it("tool YAML default wins over group default", () => {
		const role = {};
		const tm = mockToolManager({ "mcp__pw__snap": { grantPolicy: "ask" } });
		const gps = mockGroupPolicyStore({ "mcp__pw": "ask" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "ask");
	});

	it("role group override wins over group default", () => {
		const role = { toolPolicies: { "mcp__pw": "never" as const } };
		const tm = mockToolManager({});
		const gps = mockGroupPolicyStore({ "mcp__pw": "ask" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", "mcp__pw", role, tm, gps), "never");
	});

	it("MCP group default still applies when toolGroup is undefined", () => {
		const role = {};
		const tm = mockToolManager({});
		const gps = mockGroupPolicyStore({ "mcp__pw": "ask" });
		assert.equal(resolveGrantPolicy("mcp__pw__snap", undefined, role, tm, gps), "ask");
	});

	it("MCP group policy prefix matches full MCP tool names", () => {
		const role = {};
		const tm = mockToolManager({});
		const gps = mockGroupPolicyStore({ "mcp__nano-banana": "never" });
		assert.equal(
			resolveGrantPolicy("mcp__nano-banana__generate_image", "MCP: nano-banana", role, tm, gps),
			"never",
		);
	});

	// ── Legacy value normalization ────────────────────────────────────

	it("normalizes legacy always-allow to allow", () => {
		const role = { toolPolicies: { "my_tool": "always-allow" as any } };
		assert.equal(resolveGrantPolicy("my_tool", "Group", role, undefined), "allow");
	});

	it("normalizes legacy ask-once to ask", () => {
		const role = { toolPolicies: { "my_tool": "ask-once" as any } };
		assert.equal(resolveGrantPolicy("my_tool", "Group", role, undefined), "ask");
	});

	it("normalizes legacy always-ask to ask", () => {
		const role = { toolPolicies: { "my_tool": "always-ask" as any } };
		assert.equal(resolveGrantPolicy("my_tool", "Group", role, undefined), "ask");
	});

	it("normalizes legacy never-ask to never", () => {
		const role = { toolPolicies: { "my_tool": "never-ask" as any } };
		assert.equal(resolveGrantPolicy("my_tool", "Group", role, undefined), "never");
	});
});

describe("computeToolActivationArgs", () => {
	it("loads Bobbit extensions when allowedTools is unset", () => {
		const toolsBase = "/mock/tools";
		const providers = new Map([
			["read", { type: "builtin", tool: "read", groupDir: "filesystem", baseDir: toolsBase }],
			["generate_image", { type: "bobbit-extension", extension: "extension.ts", groupDir: "images", baseDir: toolsBase }],
		]);
		const toolManager = {
			getToolProviders: () => providers,
			getExtensionPath: (groupDir: string, filename: string) => `${toolsBase}/${groupDir}/${filename}`,
		};

		const activation = computeToolActivationArgs(undefined, toolManager, process.cwd());

		assert.ok(activation.args.includes("--no-extensions"));
		const extensionPaths = activation.args.filter((_arg: string, i: number, args: string[]) => i > 0 && args[i - 1] === "--extension");
		assert.ok(extensionPaths.some((p: string) => p.endsWith("/images/extension.ts")));
	});

	it("restore-style roleless sessions load generate_image and exclude blocked Nano Banana MCP", () => {
		const toolsBase = "/mock/tools";
		const toolProviders = new Map([
			["read", { type: "builtin", tool: "read", groupDir: "filesystem", baseDir: toolsBase }],
			["edit", { type: "builtin", tool: "edit", groupDir: "filesystem", baseDir: toolsBase }],
			["write", { type: "builtin", tool: "write", groupDir: "filesystem", baseDir: toolsBase }],
			["generate_image", { type: "bobbit-extension", extension: "extension.ts", groupDir: "images", baseDir: toolsBase }],
			["ask_user_choices", { type: "bobbit-extension", extension: "extension.ts", groupDir: "ask", baseDir: toolsBase }],
		]);
		const availableTools = [
			{ name: "read", group: "File System" },
			{ name: "edit", group: "File System" },
			{ name: "write", group: "File System" },
			{ name: "generate_image", group: "Images" },
			{ name: "ask_user_choices", group: "Ask" },
		];
		const toolManager = {
			getToolProviders: () => toolProviders,
			getAvailableTools: () => availableTools,
			getToolByName: (name: string) => availableTools.find((tool) => tool.name === name),
			getExtensionPath: (groupDir: string, filename: string) => `${toolsBase}/${groupDir}/${filename}`,
		};
		const mcpManager = {
			getToolInfos: () => [
				{
					name: "mcp__nano-banana__generate_image",
					serverName: "nano-banana",
					mcpToolName: "generate_image",
					group: "MCP: nano-banana",
					description: "Generate a NEW image from text prompt.",
					inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
				},
				{
					name: "mcp__playwright__browser_snapshot",
					serverName: "playwright",
					mcpToolName: "browser_snapshot",
					group: "MCP: playwright",
					description: "Snapshot",
					inputSchema: { type: "object", properties: {} },
				},
			],
		};
		const groupPolicyStore = mockGroupPolicyStore({
			Ask: "allow",
			"mcp__nano-banana": "never",
			"mcp__playwright": "never",
		});
		const role = { toolPolicies: { Gates: "ask", Tasks: "ask" } };

		const allowed = computeEffectiveAllowedTools(toolManager, role, groupPolicyStore, mcpManager);
		assert.ok(allowed.includes("generate_image"));
		assert.ok(allowed.includes("ask_user_choices"));
		assert.ok(!allowed.includes("mcp__nano-banana__generate_image"));

		const mcpExtensions = writeMcpProxyExtensions(mcpManager, allowed, role, toolManager, groupPolicyStore);
		assert.equal(mcpExtensions.length, 0);

		const activation = computeToolActivationArgs(allowed, toolManager, process.cwd(), mcpExtensions);
		const extensionPaths = activation.args.filter((_arg: string, i: number, args: string[]) => i > 0 && args[i - 1] === "--extension");
		assert.ok(extensionPaths.some((p: string) => p.endsWith("/images/extension.ts")));
		assert.ok(extensionPaths.some((p: string) => p.endsWith("/ask/extension.ts")));
		assert.ok(!activation.args.some((arg: string) => arg.includes("mcp-extensions/nano-banana")));
		assert.ok(activation.args.includes("--tools"));
		assert.match(activation.args[activation.args.indexOf("--tools") + 1], /\bread\b/);
	});
});
