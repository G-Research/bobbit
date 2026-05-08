/**
 * Unit tests for the MCP meta-tool policy hooks (track E):
 *   - `mcpPolicyPrefix` extended to also accept `mcp_<server>` (single underscore)
 *   - `resolveGrantPolicy` resolves meta-tool names through the same prefix path
 *   - `computeEffectiveAllowedTools` returns one `mcp_<server>` per server plus
 *     `mcp_describe`, with no per-op `mcp__<server>__<op>` entries.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { mcpPolicyPrefix, resolveGrantPolicy, computeEffectiveAllowedTools } = await import(
	"../src/server/agent/tool-activation.ts"
);

function mockToolManager(tools: Record<string, { grantPolicy?: string }> = {}) {
	const availableTools = Object.keys(tools).map(name => ({ name, group: "Test" }));
	return {
		getToolByName(name: string) {
			const key = Object.keys(tools).find(k => k.toLowerCase() === name.toLowerCase());
			return key ? tools[key] : undefined;
		},
		getAvailableTools() {
			return availableTools;
		},
	};
}

function mockGroupPolicyStore(policies: Record<string, string> = {}) {
	return {
		getGroupPolicy(group: string) {
			return policies[group] || null;
		},
		getAll() {
			return policies;
		},
	};
}

function mockMcpManager(infos: Array<{ name: string; serverName: string; group: string }>) {
	return {
		getToolInfos: () => infos,
	};
}

describe("mcpPolicyPrefix", () => {
	it("legacy per-op names → mcp__<server>", () => {
		assert.equal(mcpPolicyPrefix("mcp__pw__snap"), "mcp__pw");
		assert.equal(mcpPolicyPrefix("mcp__playwright__browser_snapshot"), "mcp__playwright");
		assert.equal(mcpPolicyPrefix("mcp__nano-banana__generate_image"), "mcp__nano-banana");
	});

	it("meta-tool names (single underscore) → mcp__<server>", () => {
		assert.equal(mcpPolicyPrefix("mcp_pw"), "mcp__pw");
		assert.equal(mcpPolicyPrefix("mcp_playwright"), "mcp__playwright");
		assert.equal(mcpPolicyPrefix("mcp_nano-banana"), "mcp__nano-banana");
	});

	it("non-MCP names return undefined", () => {
		assert.equal(mcpPolicyPrefix("read"), undefined);
		assert.equal(mcpPolicyPrefix("bash"), undefined);
		assert.equal(mcpPolicyPrefix("not_mcp_anything"), undefined);
	});

	it("legacy and meta resolve to the same prefix — single YAML key covers both", () => {
		assert.equal(mcpPolicyPrefix("mcp__playwright__snap"), mcpPolicyPrefix("mcp_playwright"));
	});
});

describe("resolveGrantPolicy — meta-tool names route through mcpPolicyPrefix", () => {
	it("role policy keyed at `mcp__playwright` applies to the meta-tool `mcp_playwright`", () => {
		const role = { toolPolicies: { mcp__playwright: "ask" as const } };
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp_playwright", "MCP: playwright", role, tm), "ask");
	});

	it("group-policy store keyed at `mcp__playwright` applies to the meta-tool", () => {
		const role = {};
		const tm = mockToolManager({});
		const gps = mockGroupPolicyStore({ mcp__playwright: "never" });
		assert.equal(
			resolveGrantPolicy("mcp_playwright", "MCP: playwright", role, tm, gps),
			"never",
		);
	});

	it("explicit role policy on the meta-tool name itself wins", () => {
		const role = {
			toolPolicies: {
				mcp_playwright: "allow" as any,
				mcp__playwright: "never" as const,
			},
		};
		const tm = mockToolManager({});
		assert.equal(resolveGrantPolicy("mcp_playwright", "MCP: playwright", role, tm), "allow");
	});

	it("legacy per-op resolution is unchanged", () => {
		const role = { toolPolicies: { mcp__playwright: "ask" as const } };
		const tm = mockToolManager({});
		assert.equal(
			resolveGrantPolicy("mcp__playwright__browser_snapshot", "MCP: playwright", role, tm),
			"ask",
		);
	});
});

describe("computeEffectiveAllowedTools — model surface", () => {
	const mcpInfos = [
		{
			name: "mcp__pw__snap",
			serverName: "pw",
			mcpToolName: "snap",
			group: "MCP: pw",
			description: "",
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "mcp__pw__click",
			serverName: "pw",
			mcpToolName: "click",
			group: "MCP: pw",
			description: "",
			inputSchema: { type: "object", properties: {} },
		},
		{
			name: "mcp__halo__list",
			serverName: "halo",
			mcpToolName: "list",
			group: "MCP: halo",
			description: "",
			inputSchema: { type: "object", properties: {} },
		},
	];

	it("returns one `mcp_<server>` per connected server plus `mcp_describe`, no per-op names", () => {
		const tm = mockToolManager({});
		const allowed = computeEffectiveAllowedTools(tm as any, undefined, undefined, mockMcpManager(mcpInfos) as any).map(e => e.name);

		assert.ok(allowed.includes("mcp_pw"), "mcp_pw present");
		assert.ok(allowed.includes("mcp_halo"), "mcp_halo present");
		assert.ok(allowed.includes("mcp_describe"), "mcp_describe present");

		// No per-op names leak.
		for (const info of mcpInfos) {
			assert.ok(!allowed.includes(info.name), `per-op name ${info.name} must NOT appear`);
		}

		// One mcp_<server> per server (no duplicates).
		const metaCount = allowed.filter(t => t === "mcp_pw").length;
		assert.equal(metaCount, 1);
	});

	it("producer tags entries by kind (yaml vs mcp)", () => {
		const tm = mockToolManager({
			read: { tool: { name: "read", group: "File System" } },
			bash_bg: { tool: { name: "bash_bg", group: "Shell" } },
		});
		const tagged = computeEffectiveAllowedTools(tm as any, undefined, undefined, mockMcpManager(mcpInfos) as any);
		const byName = new Map(tagged.map(e => [e.name, e.kind]));
		assert.equal(byName.get("read"), "yaml");
		assert.equal(byName.get("bash_bg"), "yaml");
		assert.equal(byName.get("mcp_pw"), "mcp");
		assert.equal(byName.get("mcp_halo"), "mcp");
		assert.equal(byName.get("mcp_describe"), "yaml", "mcp_describe is YAML-backed");
	});

	it("server with all-`never` ops is omitted from the model surface", () => {
		const tm = mockToolManager({});
		const gps = mockGroupPolicyStore({ "mcp__halo": "never" });
		const allowed = computeEffectiveAllowedTools(tm as any, undefined, gps, mockMcpManager(mcpInfos) as any).map(e => e.name);

		assert.ok(allowed.includes("mcp_pw"));
		assert.ok(!allowed.includes("mcp_halo"));
		// mcp_describe still present (other servers exist).
		assert.ok(allowed.includes("mcp_describe"));
	});

	it("role policy `mcp__playwright: ask` keeps the meta-tool listed (ask is registered, not blocked)", () => {
		const tm = mockToolManager({});
		const role = { toolPolicies: { mcp__pw: "ask" as const } };
		const allowed = computeEffectiveAllowedTools(tm as any, role, undefined, mockMcpManager(mcpInfos) as any).map(e => e.name);
		assert.ok(allowed.includes("mcp_pw"));
	});

	it("no MCP servers configured → no meta-tools and no mcp_describe", () => {
		const tm = mockToolManager({});
		const allowed = computeEffectiveAllowedTools(tm as any, undefined, undefined, mockMcpManager([]) as any).map(e => e.name);
		assert.ok(!allowed.includes("mcp_describe"));
		assert.ok(!allowed.some(t => t.startsWith("mcp_")));
	});

	it("role policy `mcp_describe: never` excludes mcp_describe even when servers exist", () => {
		const tm = mockToolManager({});
		const role = { toolPolicies: { mcp_describe: "never" as const } };
		const allowed = computeEffectiveAllowedTools(tm as any, role, undefined, mockMcpManager(mcpInfos) as any).map(e => e.name);
		assert.ok(!allowed.includes("mcp_describe"), "mcp_describe should be excluded when role policy is never");
		assert.ok(allowed.includes("mcp_pw"), "per-server meta-tools still present");
	});

	it("group policy `MCP: never` excludes mcp_describe", () => {
		const tm = mockToolManager({});
		const gps = mockGroupPolicyStore({ MCP: "never" });
		const allowed = computeEffectiveAllowedTools(tm as any, undefined, gps, mockMcpManager(mcpInfos) as any).map(e => e.name);
		assert.ok(!allowed.includes("mcp_describe"));
	});
});
