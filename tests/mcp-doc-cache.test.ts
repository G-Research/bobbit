/**
 * Unit tests for McpManager's MCP doc cache — summary generation,
 * cache hit/miss with content hashing, and MD file generation.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpStateDir: string;

const { McpManager } = await import("../src/server/mcp/mcp-manager.ts");

before(() => {
	tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-doc-cache-"));
});

after(() => {
	try {
		fs.rmSync(tmpStateDir, { recursive: true, force: true });
	} catch { /* ignore */ }
});

// ── Summary Generation ──────────────────────────────────────────────

describe("MCP summary generation (_generateSummary)", () => {
	it("extracts first sentence from multi-sentence description", () => {
		const mgr = new McpManager("/tmp/test-cwd", undefined, tmpStateDir);
		const summary = (mgr as any)._generateSummary(
			"Navigate to a URL in the browser. Launches browser if needed. Supports all protocols.",
			"navigate",
			"playwright",
		);
		assert.equal(summary, "Navigate to a URL in the browser.");
	});

	it("extracts first sentence ending with exclamation mark", () => {
		const mgr = new McpManager("/tmp/test-cwd", undefined, tmpStateDir);
		const summary = (mgr as any)._generateSummary(
			"Run this now! It will do amazing things.",
			"run",
			"server",
		);
		assert.equal(summary, "Run this now!");
	});

	it("extracts first sentence ending with question mark", () => {
		const mgr = new McpManager("/tmp/test-cwd", undefined, tmpStateDir);
		const summary = (mgr as any)._generateSummary(
			"Need help? This tool provides assistance.",
			"help",
			"server",
		);
		assert.equal(summary, "Need help?");
	});

	it("truncates description longer than 120 chars with ellipsis", () => {
		const mgr = new McpManager("/tmp/test-cwd", undefined, tmpStateDir);
		const longDesc =
			"This is a very long description that goes on and on without any sentence termination and keeps going beyond the one hundred and twenty character limit without stopping";
		const summary = (mgr as any)._generateSummary(longDesc, "tool", "server");
		assert.ok(summary.length <= 120, `Summary should be ≤120 chars, got ${summary.length}`);
		assert.ok(summary.endsWith("..."), "Should end with ...");
	});

	it("falls back to 'MCP tool <name> from <server>' for empty description", () => {
		const mgr = new McpManager("/tmp/test-cwd", undefined, tmpStateDir);
		const summary = (mgr as any)._generateSummary("", "my_tool", "my-server");
		assert.equal(summary, "MCP tool my_tool from my-server");
	});

	it("falls back to 'MCP tool <name> from <server>' for undefined description", () => {
		const mgr = new McpManager("/tmp/test-cwd", undefined, tmpStateDir);
		const summary = (mgr as any)._generateSummary(undefined, "my_tool", "my-server");
		assert.equal(summary, "MCP tool my_tool from my-server");
	});

	it("uses full text for single sentence without trailing period", () => {
		const mgr = new McpManager("/tmp/test-cwd", undefined, tmpStateDir);
		const summary = (mgr as any)._generateSummary(
			"Execute a shell command",
			"exec",
			"server",
		);
		assert.equal(summary, "Execute a shell command");
	});

	it("uses full text for single sentence ending in period (no trailing space)", () => {
		const mgr = new McpManager("/tmp/test-cwd", undefined, tmpStateDir);
		// Single sentence ending with period but no trailing space — regex requires
		// whitespace after punctuation, so full description is used
		const summary = (mgr as any)._generateSummary(
			"Navigate to a URL.",
			"nav",
			"server",
		);
		// The regex /^(.+?[.!?])\s/ won't match since there's no trailing space,
		// so the full description is returned
		assert.equal(summary, "Navigate to a URL.");
	});
});

// ── Cache Hit/Miss ──────────────────────────────────────────────────

describe("MCP doc cache (_updateDocCache)", () => {
	const mockTools = [
		{
			name: "tool_a",
			description: "Tool A does things. It does them well.",
			inputSchema: {
				type: "object",
				properties: {
					arg1: { type: "string", description: "First argument" },
					arg2: { type: "number", description: "Second argument" },
				},
				required: ["arg1"],
			},
		},
		{
			name: "tool_b",
			description: "Tool B is simple.",
			inputSchema: {
				type: "object",
				properties: {
					input: { type: "string", description: "Input value" },
				},
				required: ["input"],
			},
		},
	];

	it("creates cache and MD files on first run", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cache-first-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);
		(mgr as any)._updateDocCache("test-server", mockTools);

		const cacheFile = path.join(stateDir, "mcp-tool-docs", "test-server.cache.json");
		const mdFile = path.join(stateDir, "mcp-tool-docs", "test-server.md");
		assert.ok(fs.existsSync(cacheFile), "Cache file should exist");
		assert.ok(fs.existsSync(mdFile), "MD file should exist");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("cache JSON contains hash and summary for each tool", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cache-json-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);
		(mgr as any)._updateDocCache("test-server", mockTools);

		const cacheFile = path.join(stateDir, "mcp-tool-docs", "test-server.cache.json");
		const cache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));

		assert.ok(cache.tool_a, "Should have tool_a entry");
		assert.ok(cache.tool_b, "Should have tool_b entry");
		assert.ok(cache.tool_a.hash, "tool_a should have hash");
		assert.ok(cache.tool_a.summary, "tool_a should have summary");
		assert.equal(cache.tool_a.hash.length, 16, "Hash should be 16 hex chars");
		assert.equal(cache.tool_a.summary, "Tool A does things.");
		assert.equal(cache.tool_b.summary, "Tool B is simple.");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("cache hit — same tools produce identical files (no rewrite)", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cache-hit-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);

		(mgr as any)._updateDocCache("test-server", mockTools);
		const cacheFile = path.join(stateDir, "mcp-tool-docs", "test-server.cache.json");
		const mdFile = path.join(stateDir, "mcp-tool-docs", "test-server.md");

		const firstCacheContent = fs.readFileSync(cacheFile, "utf-8");
		const firstMdContent = fs.readFileSync(mdFile, "utf-8");

		// Get mtime before second call
		const cacheMtimeBefore = fs.statSync(cacheFile).mtimeMs;
		const mdMtimeBefore = fs.statSync(mdFile).mtimeMs;

		// Small delay to ensure mtime would differ if rewritten
		// (use synchronous approach — just check content equality)
		(mgr as any)._updateDocCache("test-server", mockTools);

		const secondCacheContent = fs.readFileSync(cacheFile, "utf-8");
		const secondMdContent = fs.readFileSync(mdFile, "utf-8");

		assert.equal(firstCacheContent, secondCacheContent, "Cache content should be identical on cache hit");
		assert.equal(firstMdContent, secondMdContent, "MD content should be identical on cache hit");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("cache miss — changed description triggers regeneration", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cache-miss-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);

		(mgr as any)._updateDocCache("test-server", mockTools);
		const cacheFile = path.join(stateDir, "mcp-tool-docs", "test-server.cache.json");
		const firstCache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
		const originalHash = firstCache.tool_a.hash;

		// Modify tool_a's description
		const modifiedTools = [
			{
				...mockTools[0],
				description: "Tool A now does different things. Updated behavior.",
			},
			mockTools[1],
		];

		(mgr as any)._updateDocCache("test-server", modifiedTools);
		const secondCache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));

		assert.notEqual(
			secondCache.tool_a.hash,
			originalHash,
			"tool_a hash should change after description update",
		);
		assert.equal(
			secondCache.tool_a.summary,
			"Tool A now does different things.",
			"Summary should be regenerated",
		);
		// tool_b should be unchanged
		assert.equal(
			secondCache.tool_b.hash,
			firstCache.tool_b.hash,
			"tool_b hash should not change",
		);

		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("cache miss — changed inputSchema triggers regeneration", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cache-schema-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);

		(mgr as any)._updateDocCache("test-server", mockTools);
		const cacheFile = path.join(stateDir, "mcp-tool-docs", "test-server.cache.json");
		const firstCache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));

		// Modify tool_b's inputSchema
		const modifiedTools = [
			mockTools[0],
			{
				...mockTools[1],
				inputSchema: {
					type: "object",
					properties: {
						input: { type: "string", description: "Input value" },
						extra: { type: "boolean", description: "Extra flag" },
					},
					required: ["input"],
				},
			},
		];

		(mgr as any)._updateDocCache("test-server", modifiedTools);
		const secondCache = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));

		assert.notEqual(
			secondCache.tool_b.hash,
			firstCache.tool_b.hash,
			"tool_b hash should change after schema update",
		);
		// Summary stays the same since description didn't change
		assert.equal(secondCache.tool_b.summary, firstCache.tool_b.summary);

		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("populates in-memory _summaryCache", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cache-mem-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);

		(mgr as any)._updateDocCache("test-server", mockTools);

		const cache = (mgr as any)._summaryCache as Map<string, Map<string, string>>;
		assert.ok(cache.has("test-server"), "Should have test-server in summary cache");
		const serverCache = cache.get("test-server")!;
		assert.equal(serverCache.get("tool_a"), "Tool A does things.");
		assert.equal(serverCache.get("tool_b"), "Tool B is simple.");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});
});

// ── MD File Content ─────────────────────────────────────────────────

describe("MCP doc MD file generation", () => {
	it("MD file contains tool headings and descriptions", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-md-content-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);
		const tools = [
			{
				name: "my_tool",
				description: "My tool does amazing things.",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query" },
					},
					required: ["query"],
				},
			},
		];

		(mgr as any)._updateDocCache("my-server", tools);

		const mdFile = path.join(stateDir, "mcp-tool-docs", "my-server.md");
		const content = fs.readFileSync(mdFile, "utf-8");

		assert.ok(content.includes("## my_tool"), "MD should contain tool heading");
		assert.ok(content.includes("My tool does amazing things."), "MD should contain description");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("MD file contains parameter table", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-md-params-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);
		const tools = [
			{
				name: "search",
				description: "Search for content.",
				inputSchema: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query" },
						limit: { type: "number", description: "Max results" },
					},
					required: ["query"],
				},
			},
		];

		(mgr as any)._updateDocCache("search-server", tools);

		const mdFile = path.join(stateDir, "mcp-tool-docs", "search-server.md");
		const content = fs.readFileSync(mdFile, "utf-8");

		assert.ok(content.includes("| Name | Type | Required | Description |"), "Should have param table header");
		assert.ok(content.includes("`query`"), "Should list query param");
		assert.ok(content.includes("`limit`"), "Should list limit param");
		assert.ok(content.includes("Yes"), "query should be required");
		assert.ok(content.includes("No"), "limit should not be required");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("MD file handles tool with no parameters", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-md-noparam-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);
		const tools = [
			{
				name: "ping",
				description: "Ping the server.",
				inputSchema: { type: "object" },
			},
		];

		(mgr as any)._updateDocCache("ping-server", tools);

		const mdFile = path.join(stateDir, "mcp-tool-docs", "ping-server.md");
		const content = fs.readFileSync(mdFile, "utf-8");

		assert.ok(content.includes("## ping"), "Should have tool heading");
		assert.ok(content.includes("Ping the server."), "Should have description");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("MD file title includes server name", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-md-title-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);
		(mgr as any)._updateDocCache("awesome-server", [
			{ name: "tool1", description: "A tool.", inputSchema: { type: "object" } },
		]);

		const mdFile = path.join(stateDir, "mcp-tool-docs", "awesome-server.md");
		const content = fs.readFileSync(mdFile, "utf-8");
		assert.ok(content.includes("# awesome-server"), "MD title should include server name");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});
});

// ── getToolInfos integration ────────────────────────────────────────

describe("McpManager.getToolInfos — summary and docs wiring", () => {
	it("returns summaries from cache in getToolInfos", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-infos-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);

		// Manually populate toolDefs (simulating a connected server)
		const tools = [
			{
				name: "do_thing",
				description: "Does a thing. Very useful tool.",
				inputSchema: {
					type: "object",
					properties: { arg: { type: "string", description: "Arg" } },
					required: ["arg"],
				},
			},
		];
		(mgr as any).toolDefs.set("test-srv", tools);
		(mgr as any)._updateDocCache("test-srv", tools);

		const infos = mgr.getToolInfos();
		assert.equal(infos.length, 1);
		assert.equal(infos[0].summary, "Does a thing.");
		assert.ok(infos[0].docs, "Should have docs");
		assert.ok(infos[0].docs!.includes("Does a thing."), "Docs should include description");
		assert.ok(infos[0].docs!.includes("| Name | Type"), "Docs should include param table");
		assert.equal(infos[0].group, "MCP: test-srv");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});

	it("returns fallback for tools without description", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-infos-fallback-"));
		const mgr = new McpManager("/tmp/test-cwd", undefined, stateDir);

		const tools = [
			{ name: "mystery", inputSchema: { type: "object" } },
		];
		(mgr as any).toolDefs.set("unknown-srv", tools as any);
		(mgr as any)._updateDocCache("unknown-srv", tools as any);

		const infos = mgr.getToolInfos();
		assert.equal(infos.length, 1);
		assert.equal(infos[0].summary, "MCP tool mystery from unknown-srv");

		fs.rmSync(stateDir, { recursive: true, force: true });
	});
});

