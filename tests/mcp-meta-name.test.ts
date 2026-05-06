/**
 * Unit tests for makeMetaToolName() in mcp-meta.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { makeMetaToolName, MCP_META_PREFIX, parseMcpToolName } = await import("../src/server/mcp/mcp-meta.ts");

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

describe("makeMetaToolName(server, sub)", () => {
	it("emits `mcp_<server>__<sub>` when sub is provided", () => {
		assert.equal(makeMetaToolName("gr", "ai-adoption"), "mcp_gr__ai-adoption");
		assert.equal(makeMetaToolName("gr", "jira"), "mcp_gr__jira");
	});

	it("flat form matches single-arg behaviour", () => {
		assert.equal(makeMetaToolName("playwright"), "mcp_playwright");
		assert.equal(makeMetaToolName("playwright", undefined), "mcp_playwright");
	});

	it("sanitises invalid chars in both server and sub segments", () => {
		assert.equal(makeMetaToolName("gr/x", "ai/adopt"), "mcp_gr_x__ai_adopt");
	});

	it("truncates the sub segment first when the combined name exceeds 64 chars", () => {
		const server = "a".repeat(50); // "mcp_" + 50 + "__" = 56, leaves 8 for sub
		const sub = "b".repeat(30);
		const result = makeMetaToolName(server, sub);
		assert.ok(result.length <= 64, `length ${result.length} ≤ 64`);
		assert.ok(result.startsWith(`mcp_${server}__`), "server segment preserved");
		// Sub gets truncated to fill remaining budget.
		const tail = result.slice(`mcp_${server}__`.length);
		assert.equal(tail.length, 64 - `mcp_${server}__`.length);
		assert.match(tail, /^b+$/);
	});

	it("falls back to flat-server truncation when server alone saturates the budget", () => {
		const server = "a".repeat(70); // 4 + 70 = 74 > 64
		const result = makeMetaToolName(server, "sub");
		assert.equal(result.length, 64);
		assert.ok(result.startsWith("mcp_a"));
	});

	it("throws if sub is provided but empty", () => {
		assert.throws(() => makeMetaToolName("gr", ""), /non-empty string/);
		assert.throws(() => makeMetaToolName("gr", "   "), /non-empty string/);
	});
});

describe("parseMcpToolName", () => {
	it("parses sub-namespaced names — first __ separates sub from op", () => {
		assert.deepEqual(parseMcpToolName("mcp__gr__ai-adoption__list-articles"), {
			server: "gr",
			sub: "ai-adoption",
			op: "list-articles",
		});
	});

	it("parses second sub-namespaced op under the same server", () => {
		assert.deepEqual(parseMcpToolName("mcp__gr__ai-adoption__create-article"), {
			server: "gr",
			sub: "ai-adoption",
			op: "create-article",
		});
	});

	it("parses a different sub-namespace under the same server", () => {
		assert.deepEqual(parseMcpToolName("mcp__gr__jira__get-queue"), {
			server: "gr",
			sub: "jira",
			op: "get-queue",
		});
	});

	it("parses flat (no sub) names", () => {
		assert.deepEqual(parseMcpToolName("mcp__playwright__click"), {
			server: "playwright",
			op: "click",
		});
	});

	it("parses op containing literal `__` after the first split", () => {
		assert.deepEqual(parseMcpToolName("mcp__foo__a__b__c"), {
			server: "foo",
			sub: "a",
			op: "b__c",
		});
	});

	it("returns null for non-MCP names", () => {
		assert.equal(parseMcpToolName("read"), null);
		assert.equal(parseMcpToolName(""), null);
		assert.equal(parseMcpToolName("mcp__"), null);
		assert.equal(parseMcpToolName("mcp__server"), null);
		assert.equal(parseMcpToolName("prefix-mcp__server__op"), null);
	});
});
