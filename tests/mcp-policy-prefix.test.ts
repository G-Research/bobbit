/**
 * Unit test for the `mcpPolicyPrefix()` helper exported from
 * src/server/agent/tool-activation.ts. Locks the regex behaviour so future
 * changes can't silently break MCP group-policy lookup.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { mcpPolicyPrefix } = await import("../src/server/agent/tool-activation.ts");

describe("mcpPolicyPrefix", () => {
	it("extracts mcp__<server> for canonical mcp__<server>__<tool> names", () => {
		assert.equal(mcpPolicyPrefix("mcp__nano-banana__generate_image"), "mcp__nano-banana");
		assert.equal(mcpPolicyPrefix("mcp__playwright__browser_snapshot"), "mcp__playwright");
	});

	it("server names containing underscores are preserved (non-greedy match)", () => {
		// Tool name `mcp__server_name__tool` → prefix is `mcp__server_name`.
		// (Server-name segment may itself contain underscores; the regex is
		// non-greedy so it stops at the first `__` followed by a tool segment.)
		assert.equal(
			mcpPolicyPrefix("mcp__server_name__some_tool"),
			"mcp__server_name",
		);
	});

	it("server names with hyphens", () => {
		assert.equal(mcpPolicyPrefix("mcp__nano-banana__generate_image"), "mcp__nano-banana");
	});

	it("returns undefined for non-mcp tool names", () => {
		assert.equal(mcpPolicyPrefix("generate_image"), undefined);
		assert.equal(mcpPolicyPrefix("read"), undefined);
		assert.equal(mcpPolicyPrefix(""), undefined);
	});

	it("returns undefined when there is no tool segment after the server name", () => {
		// `mcp__server` (no second `__`) is not a valid tool name.
		assert.equal(mcpPolicyPrefix("mcp__server"), undefined);
		assert.equal(mcpPolicyPrefix("mcp__"), undefined);
	});

	it("strings that merely contain `mcp__` mid-string are rejected", () => {
		// Regex is anchored at start.
		assert.equal(mcpPolicyPrefix("prefix-mcp__server__tool"), undefined);
	});
});
