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

const { generateMcpMetaExtension } = await import("../src/server/agent/tool-activation.ts");

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
