/**
 * Unit tests for `generateMcpMetaExtension` (track E of the MCP meta-tool
 * aggregation design). Validates the generator emits valid TS that registers
 * a single `mcp_<server>` meta-tool with the expected TypeBox schema, plus a
 * stub branch when no usable ops are available.
 *
 * We assert content-stable substrings rather than exact-equal to keep the
 * test resilient to whitespace tweaks in the template.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { generateMcpMetaExtension, writeMcpProxyExtensions } = await import("../src/server/agent/tool-activation.ts");
const os = await import("node:os");
const pathMod = await import("node:path");
const fsMod = await import("node:fs");

describe("generateMcpMetaExtension — happy path", () => {
	const ops = [
		{
			name: "list-employees",
			description: "List all employees",
			inputSchema: { type: "object", properties: { limit: { type: "number" } } },
		},
		{
			name: "get-direct-reports",
			description: "Get direct reports for a person",
			inputSchema: {
				type: "object",
				required: ["userId"],
				properties: { userId: { type: "string" } },
			},
		},
	];

	const code = generateMcpMetaExtension("gr-halo", ops);

	it("emits a default-export pi extension function", () => {
		assert.match(code, /export default function\(pi\)/);
	});

	it("registers the meta-tool name `mcp_<server>`", () => {
		// JSON.stringify quotes the name; allow either bare or quoted forms.
		assert.match(code, /name:\s*"mcp_gr-halo"/);
		// Must not register per-op tools as separate registerTool() calls.
		const registerCount = (code.match(/pi\.registerTool\(/g) || []).length;
		assert.equal(registerCount, 1, "exactly one registerTool() call");
	});

	it("constrains operation to a Type.Union of Type.Literal(...) over op names", () => {
		assert.match(code, /Type\.Object\(/);
		assert.match(code, /"operation":\s*Type\.Union\(\[/);
		assert.match(code, /Type\.Literal\("list-employees"\)/);
		assert.match(code, /Type\.Literal\("get-direct-reports"\)/);
	});

	it("includes args as an opaque object in the schema", () => {
		assert.match(code, /"args":/);
	});

	it("execute body POSTs to /api/internal/mcp-call with the canonical per-op tool name", () => {
		assert.match(code, /\/api\/internal\/mcp-call/);
		// The tool name string assembled inside execute must use the
		// canonical `mcp__<server>__<operation>` form.
		assert.match(code, /"mcp__"\s*\+\s*"gr-halo"\s*\+\s*"__"\s*\+\s*operation/);
	});

	it("reuses the gwUrl/token bootstrap from generateMcpProxyExtension", () => {
		assert.match(code, /BOBBIT_GATEWAY_URL/);
		assert.match(code, /BOBBIT_TOKEN/);
		assert.match(code, /process\.env\.BOBBIT_SESSION_ID/);
	});

	it("validates operation against a local enum (defensive)", () => {
		assert.match(code, /validOps/);
		assert.match(code, /invalid_operation/);
	});

	it("description points at the per-server tool-docs file", () => {
		assert.match(code, /mcp-tool-docs\/gr-halo\.md/);
	});
});

describe("generateMcpMetaExtension — stub branch", () => {
	it("emits a stub when ops is empty", () => {
		const code = generateMcpMetaExtension("dead-server", []);
		assert.match(code, /name:\s*"mcp_dead-server"/);
		assert.match(code, /unavailable/);
		// Stub must not POST anywhere — it short-circuits in execute.
		assert.doesNotMatch(code, /\/api\/internal\/mcp-call/);
	});

	it("emits a stub when unavailableReason is provided, even with ops", () => {
		const code = generateMcpMetaExtension(
			"flaky",
			[{ name: "ping", inputSchema: { type: "object" } }],
			"timeout listing tools",
		);
		assert.match(code, /unavailable/);
		assert.match(code, /timeout listing tools/);
		assert.doesNotMatch(code, /\/api\/internal\/mcp-call/);
	});

	it("stub schema constrains operation to the __unavailable__ literal", () => {
		const code = generateMcpMetaExtension("down", [], "disconnected");
		assert.match(code, /Type\.Literal\("__unavailable__"\)/);
	});

	it("stub execute returns the unavailable text in a content block", () => {
		const code = generateMcpMetaExtension("down", [], "disconnected");
		assert.match(code, /MCP server down is unavailable: disconnected/);
		assert.match(code, /content:\s*\[\s*\{\s*type:\s*"text"/);
	});

	it("stub still uses single registerTool() call", () => {
		const code = generateMcpMetaExtension("down", [], "disconnected");
		const registerCount = (code.match(/pi\.registerTool\(/g) || []).length;
		assert.equal(registerCount, 1);
	});
});

describe("generateMcpMetaExtension — name sanitisation", () => {
	it("sanitises server names containing `/` etc. into the meta-tool name", () => {
		const code = generateMcpMetaExtension("scope/server", [
			{ name: "op1", inputSchema: { type: "object" } },
		]);
		// Forward slash must become underscore via makeMetaToolName.
		assert.match(code, /name:\s*"mcp_scope_server"/);
	});
});

describe("generateMcpMetaExtension — sub-namespace (gateway) shape", () => {
	const ops = [
		{ name: "list-articles", inputSchema: { type: "object", properties: {} } },
		{ name: "create-article", inputSchema: { type: "object", properties: {} } },
	];

	const code = generateMcpMetaExtension("gr", ops, undefined, "ai-adoption");

	it("emits meta-tool name `mcp_<server>__<sub>`", () => {
		assert.match(code, /name:\s*"mcp_gr__ai-adoption"/);
	});

	it("docs path includes both server and sub", () => {
		assert.match(code, /mcp-tool-docs\/gr__ai-adoption\.md/);
	});

	it("execute body dispatches the original `mcp__<server>__<sub>__<op>` name", () => {
		assert.match(
			code,
			/"mcp__"\s*\+\s*"gr"\s*\+\s*"__"\s*\+\s*"ai-adoption"\s*\+\s*"__"\s*\+\s*operation/,
		);
	});

	it("op enum lists ONLY the ops belonging to this sub-namespace", () => {
		assert.match(code, /Type\.Literal\("list-articles"\)/);
		assert.match(code, /Type\.Literal\("create-article"\)/);
	});
});

describe("writeMcpProxyExtensions — (server, sub) granularity", () => {
	const path = pathMod;
	const fs = fsMod;

	function tmpBobbitDir() {
		return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-meta-ext-"));
	}

	function setIsolatedBobbit(t: any): void {
		const dir = tmpBobbitDir();
		const orig = process.env.BOBBIT_DIR;
		process.env.BOBBIT_DIR = dir;
		t.after(() => {
			if (orig === undefined) delete process.env.BOBBIT_DIR;
			else process.env.BOBBIT_DIR = orig;
		});
	}

	it("gateway server with two sub-namespaces emits TWO extension files", (t) => {
		setIsolatedBobbit(t);

		const infos = [
			{
				name: "mcp__gr__ai-adoption__list-articles",
				serverName: "gr",
				mcpToolName: "ai-adoption__list-articles",
				group: "MCP: gr",
				description: "",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "mcp__gr__ai-adoption__create-article",
				serverName: "gr",
				mcpToolName: "ai-adoption__create-article",
				group: "MCP: gr",
				description: "",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "mcp__gr__jira__get-queue",
				serverName: "gr",
				mcpToolName: "jira__get-queue",
				group: "MCP: gr",
				description: "",
				inputSchema: { type: "object", properties: {} },
			},
		];
		const mgr = {
			getToolInfos: () => infos,
			getServerStatuses: () => [],
		} as any;

		const paths = writeMcpProxyExtensions(mgr);
		assert.equal(paths.length, 2, "two extension files for two sub-namespaces");
		const basenames = paths.map(p => path.basename(p)).sort();
		assert.deepEqual(basenames, ["gr__ai-adoption.ts", "gr__jira.ts"]);

		const aiAdopt = fs.readFileSync(paths.find(p => p.endsWith("gr__ai-adoption.ts"))!, "utf-8");
		assert.match(aiAdopt, /name:\s*"mcp_gr__ai-adoption"/);
		assert.match(aiAdopt, /Type\.Literal\("list-articles"\)/);
		assert.match(aiAdopt, /Type\.Literal\("create-article"\)/);
		// `jira` ops must NOT appear in the ai-adoption extension.
		assert.doesNotMatch(aiAdopt, /Type\.Literal\("get-queue"\)/);

		const jira = fs.readFileSync(paths.find(p => p.endsWith("gr__jira.ts"))!, "utf-8");
		assert.match(jira, /name:\s*"mcp_gr__jira"/);
		assert.match(jira, /Type\.Literal\("get-queue"\)/);
		assert.doesNotMatch(jira, /Type\.Literal\("list-articles"\)/);
	});

	it("flat server emits ONE extension file at <server>.ts", (t) => {
		setIsolatedBobbit(t);

		const infos = [
			{
				name: "mcp__playwright__click",
				serverName: "playwright",
				mcpToolName: "click",
				group: "MCP: playwright",
				description: "",
				inputSchema: { type: "object", properties: {} },
			},
			{
				name: "mcp__playwright__snap",
				serverName: "playwright",
				mcpToolName: "snap",
				group: "MCP: playwright",
				description: "",
				inputSchema: { type: "object", properties: {} },
			},
		];
		const mgr = {
			getToolInfos: () => infos,
			getServerStatuses: () => [],
		} as any;

		const paths = writeMcpProxyExtensions(mgr);
		assert.equal(paths.length, 1);
		assert.equal(path.basename(paths[0]), "playwright.ts");
		const code = fs.readFileSync(paths[0], "utf-8");
		assert.match(code, /name:\s*"mcp_playwright"/);
		assert.match(code, /Type\.Literal\("click"\)/);
		assert.match(code, /Type\.Literal\("snap"\)/);
	});

	it("error-state stub still lands at <server>.ts (no sub knowledge)", (t) => {
		setIsolatedBobbit(t);

		const mgr = {
			getToolInfos: () => [],
			getServerStatuses: () => [
				{ name: "broken", status: "error", toolCount: 0, error: "timeout" },
			],
		} as any;
		const paths = writeMcpProxyExtensions(mgr);
		assert.equal(paths.length, 1);
		assert.equal(path.basename(paths[0]), "broken.ts");
		const code = fs.readFileSync(paths[0], "utf-8");
		assert.match(code, /name:\s*"mcp_broken"/);
		assert.match(code, /unavailable/);
	});
});
