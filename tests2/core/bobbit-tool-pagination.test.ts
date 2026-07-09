// v2-native — bobbit gateway tool suite. Listed in tests-map.json `v2Native`.
//
// Pagination contract: list-style bobbit_read operations return bounded pages by
// default, preserve ancillary fields, and add normalized pagination metadata even
// when the gateway endpoint itself returns an unpaged array.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it, expect, beforeAll } from "vitest";
import { loadBobbitTools, stubFetch, type CapturedTool } from "./helpers/bobbit-harness.ts";

let tools: Map<string, CapturedTool>;

beforeAll(() => {
	process.env.BOBBIT_TOKEN = "tok";
	process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
	tools = loadBobbitTools();
});

function text(result: any): string {
	return result?.content?.[0]?.text ?? "";
}

function json(result: any): any {
	expect(result.isError).toBeFalsy();
	return JSON.parse(text(result));
}

describe("bobbit_read — fallback pagination", () => {
	it("pages list_tools responses after fetch while preserving diagnostics", async () => {
		const allTools = Array.from({ length: 75 }, (_, i) => ({ name: `tool-${i}` }));
		stubFetch(() => ({
			body: {
				tools: allTools,
				diagnostics: [{ level: "warning", message: "custom override ignored" }],
			},
		}));

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "list_tools",
			projectId: "proj-tools",
			limit: 10,
			offset: 20,
		});
		const data = json(result);

		expect(data.tools.map((t: any) => t.name)).toEqual(Array.from({ length: 10 }, (_, i) => `tool-${i + 20}`));
		expect(data.diagnostics).toEqual([{ level: "warning", message: "custom override ignored" }]);
		expect(data.pagination).toMatchObject({
			limit: 10,
			offset: 20,
			total: 75,
			hasMore: true,
			nextOffset: 30,
			mode: "offset",
			itemKey: "tools",
			pagedBy: "tool",
		});
	});

	it("normalizes bare-array list_mcp_servers responses to a bounded servers payload", async () => {
		const allServers = Array.from({ length: 55 }, (_, i) => ({ id: `mcp-${i}` }));
		stubFetch(() => ({ body: allServers }));

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "list_mcp_servers",
			projectId: "proj-mcp",
			limit: 5,
			offset: 50,
		});
		const data = json(result);

		expect(data).not.toBeInstanceOf(Array);
		expect(data.servers.map((s: any) => s.id)).toEqual(["mcp-50", "mcp-51", "mcp-52", "mcp-53", "mcp-54"]);
		expect(data.pagination).toMatchObject({
			limit: 5,
			offset: 50,
			total: 55,
			hasMore: false,
			mode: "offset",
			itemKey: "servers",
			pagedBy: "tool",
		});
		expect(data.pagination.nextOffset).toBeUndefined();
	});

	it("pages maintenance sessions probes without losing ancillary fields", async () => {
		const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `session-${i}` }));
		stubFetch(() => ({ body: { sessions, scannedAt: "2026-07-09T00:00:00.000Z" } }));

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "maintenance_inspect",
			probe: "orphaned_sessions",
			limit: 3,
			offset: 4,
		});
		const data = json(result);

		expect(data.sessions.map((s: any) => s.id)).toEqual(["session-4", "session-5", "session-6"]);
		expect(data.scannedAt).toBe("2026-07-09T00:00:00.000Z");
		expect(data.pagination).toMatchObject({
			limit: 3,
			offset: 4,
			total: 12,
			hasMore: true,
			nextOffset: 7,
			mode: "offset",
			itemKey: "sessions",
			pagedBy: "tool",
		});
	});

	it("pages maintenance sample probes without losing the authoritative count", async () => {
		const sample = Array.from({ length: 30 }, (_, i) => ({ rowId: `row-${i}` }));
		stubFetch(() => ({ body: { count: 30, sample } }));

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "maintenance_inspect",
			probe: "orphaned_index_rows",
			projectId: "proj-index",
			limit: 4,
			offset: 8,
		});
		const data = json(result);

		expect(data.count).toBe(30);
		expect(data.sample.map((r: any) => r.rowId)).toEqual(["row-8", "row-9", "row-10", "row-11"]);
		expect(data.pagination).toMatchObject({
			limit: 4,
			offset: 8,
			total: 30,
			hasMore: true,
			nextOffset: 12,
			mode: "offset",
			itemKey: "sample",
			pagedBy: "tool",
		});
	});
});

describe("bobbit_read — normalized REST pagination metadata", () => {
	it("returns a bounded default first page for list_sessions", async () => {
		stubFetch((url) => {
			const limit = Number(new URL(url).searchParams.get("limit") ?? "60");
			const sessions = Array.from({ length: limit }, (_, i) => ({ id: `session-${i}` }));
			return { body: { sessions, total: 60 } };
		});

		const result = await tools.get("bobbit_read")!.execute("id", { operation: "list_sessions" });
		const data = json(result);

		expect(data.sessions).toHaveLength(50);
		expect(data.pagination).toMatchObject({
			limit: 50,
			offset: 0,
			total: 60,
			hasMore: true,
			nextOffset: 50,
			mode: "offset",
			itemKey: "sessions",
			pagedBy: "rest",
		});
	});

	it("adds pagination metadata to search without re-slicing REST results", async () => {
		const results = Array.from({ length: 5 }, (_, i) => ({ id: `result-${i + 10}` }));
		stubFetch(() => ({ body: { results, total: 18 } }));

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "search",
			q: "pagination",
			type: "all",
			projectId: "proj-search",
			limit: 5,
			offset: 10,
		});
		const data = json(result);

		expect(data.results).toEqual(results);
		expect(data.total).toBe(18);
		expect(data.pagination).toMatchObject({
			limit: 5,
			offset: 10,
			total: 18,
			hasMore: true,
			nextOffset: 15,
			mode: "offset",
			itemKey: "results",
			pagedBy: "rest",
		});
	});
});
