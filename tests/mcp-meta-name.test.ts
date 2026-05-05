/**
 * Unit tests for makeMetaToolName() in mcp-meta.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { makeMetaToolName, MCP_META_PREFIX } = await import("../src/server/mcp/mcp-meta.ts");

describe("makeMetaToolName", () => {
	it("passes plain server names through with prefix", () => {
		assert.equal(makeMetaToolName("gr-jira"), "mcp_gr-jira");
		assert.equal(makeMetaToolName("playwright"), "mcp_playwright");
		assert.equal(makeMetaToolName("gr_halo"), "mcp_gr_halo");
	});

	it("sanitises invalid chars to underscore", () => {
		assert.equal(makeMetaToolName("my.server@1"), "mcp_my_server_1");
		assert.equal(makeMetaToolName("foo bar/baz"), "mcp_foo_bar_baz");
		assert.equal(makeMetaToolName("a:b:c"), "mcp_a_b_c");
	});

	it("preserves digits, underscores, and hyphens", () => {
		assert.equal(makeMetaToolName("a1-b2_c3"), "mcp_a1-b2_c3");
	});

	it("truncates to 64 chars total", () => {
		const longName = "a".repeat(100);
		const result = makeMetaToolName(longName);
		assert.equal(result.length, 64);
		assert.ok(result.startsWith(MCP_META_PREFIX));
	});

	it("does not truncate names that fit", () => {
		const name = "a".repeat(60); // 60 + "mcp_" (4) = 64 — exactly at limit
		const result = makeMetaToolName(name);
		assert.equal(result.length, 64);
		assert.equal(result, `mcp_${name}`);
	});

	it("throws on empty / whitespace input", () => {
		assert.throws(() => makeMetaToolName(""), /non-empty string/);
		assert.throws(() => makeMetaToolName("   "), /non-empty string/);
		// @ts-expect-error testing runtime guard
		assert.throws(() => makeMetaToolName(undefined), /non-empty string/);
		// @ts-expect-error testing runtime guard
		assert.throws(() => makeMetaToolName(null), /non-empty string/);
	});

	it("exports stable MCP_META_PREFIX", () => {
		assert.equal(MCP_META_PREFIX, "mcp_");
	});
});
