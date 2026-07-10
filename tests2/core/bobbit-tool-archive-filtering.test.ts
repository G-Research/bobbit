// v2-native — bobbit gateway tool suite. Listed in tests-map.json `v2Native`.
//
// Archive visibility contract: agent-facing bobbit_read list/search operations
// hide archived rows by default, while preserving explicit archive opt-ins.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { describe, it, expect, beforeAll } from "vitest";
import { loadBobbitTools, stubFetch, type CapturedTool } from "./helpers/bobbit-harness.ts";
import { SearchService } from "../../src/server/search/search-service.js";

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

function ids(rows: any[] | undefined): string[] {
	return Array.isArray(rows) ? rows.map((r) => r.id) : [];
}

function archivedIds(rows: any[] | undefined): string[] {
	return Array.isArray(rows) ? rows.filter((r) => r?.archived === true).map((r) => r.id) : [];
}

describe("bobbit_read — archive-hidden list defaults", () => {
	it("list_sessions defaults to live-only rows and strips archive delegate enrichment", async () => {
		stubFetch((url) => {
			expect(new URL(url).searchParams.get("include")).toBeNull();
			return {
				body: {
					sessions: [
						{ id: "live-1", archived: false },
						{ id: "archived-defensive", archived: true },
					],
					archivedDelegates: [{ id: "archived-delegate", archived: true }],
					total: 2,
				},
			};
		});

		const result = await tools.get("bobbit_read")!.execute("id", { operation: "list_sessions" });
		const data = json(result);

		expect.soft(ids(data.sessions)).toEqual(["live-1"]);
		expect.soft(archivedIds(data.sessions)).toEqual([]);
		// The whole archive-enrichment key is stripped, not merely emptied.
		expect.soft(data.archivedDelegates).toBeUndefined();
		expect.soft("archivedDelegates" in data).toBe(false);
	});

	it("list_sessions preserves archived rows and delegates when include=archived is explicit", async () => {
		stubFetch((url) => {
			expect(new URL(url).searchParams.get("include")).toBe("archived");
			return {
				body: {
					sessions: [
						{ id: "live-1", archived: false },
						{ id: "archived-explicit", archived: true },
					],
					archivedDelegates: [{ id: "archived-delegate", archived: true }],
					total: 2,
				},
			};
		});

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "list_sessions",
			include: "archived",
		});
		const data = json(result);

		expect(ids(data.sessions)).toEqual(["live-1", "archived-explicit"]);
		expect(ids(data.archivedDelegates)).toEqual(["archived-delegate"]);
	});

	it("list_goals defaults to live-only rows and strips archived session enrichment", async () => {
		stubFetch((url) => {
			expect(new URL(url).searchParams.get("archived")).toBeNull();
			return {
				body: {
					goals: [
						{ id: "live-goal", archived: false },
						{ id: "archived-goal-defensive", archived: true },
					],
					archivedSessions: [{ id: "archived-session", archived: true }],
					total: 2,
				},
			};
		});

		const result = await tools.get("bobbit_read")!.execute("id", { operation: "list_goals" });
		const data = json(result);

		expect.soft(ids(data.goals)).toEqual(["live-goal"]);
		expect.soft(archivedIds(data.goals)).toEqual([]);
		// The whole archive-enrichment key is stripped, not merely emptied.
		expect.soft(data.archivedSessions).toBeUndefined();
		expect.soft("archivedSessions" in data).toBe(false);
	});

	it("list_goals preserves archived goals and archivedSessions when archived=true is explicit", async () => {
		stubFetch((url) => {
			expect(new URL(url).searchParams.get("archived")).toBe("true");
			return {
				body: {
					goals: [{ id: "archived-goal-explicit", archived: true }],
					archivedSessions: [{ id: "archived-session", archived: true }],
					total: 1,
				},
			};
		});

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "list_goals",
			archived: true,
		});
		const data = json(result);

		expect(ids(data.goals)).toEqual(["archived-goal-explicit"]);
		expect(ids(data.archivedSessions)).toEqual(["archived-session"]);
	});
});

describe("bobbit_read — archive-hidden search default", () => {
	it("search defaults to live-only rows in the agent-facing response", async () => {
		stubFetch(() => ({
			body: {
				results: [
					{ id: "live-result", type: "goal", archived: false },
					{ id: "archived-result", type: "goal", archived: true },
				],
				total: 2,
			},
		}));

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "search",
			q: "archive visibility",
		});
		const data = json(result);

		expect.soft(ids(data.results)).toEqual(["live-result"]);
		expect.soft(archivedIds(data.results)).toEqual([]);
	});

	it("search preserves archived rows and forwards includeArchived=true when include=archived is explicit", async () => {
		stubFetch((url) => {
			expect(new URL(url).searchParams.get("includeArchived")).toBe("true");
			return {
				body: {
					results: [
						{ id: "live-result", type: "goal", archived: false },
						{ id: "archived-result", type: "goal", archived: true },
					],
					total: 2,
				},
			};
		});

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "search",
			q: "archive visibility",
			include: "archived",
		});
		const data = json(result);

		expect(ids(data.results)).toEqual(["live-result", "archived-result"]);
	});

	it("search defensive filtering does not corrupt the REST grand total across pages", async () => {
		// REST returns one page (limit 2) of a larger result set (total 50). Even if
		// an archived row slips through the server filter, the page-level removal must
		// NOT decrement the grand total — doing so corrupts hasMore/nextOffset math.
		stubFetch(() => ({
			body: {
				results: [
					{ id: "live-1", type: "goal", archived: false },
					{ id: "archived-slip", type: "goal", archived: true },
				],
				total: 50,
				hasMore: true,
				nextOffset: 2,
			},
		}));

		const result = await tools.get("bobbit_read")!.execute("id", {
			operation: "search",
			q: "archive visibility",
			limit: 2,
		});
		const data = json(result);

		expect.soft(ids(data.results)).toEqual(["live-1"]);
		expect.soft(archivedIds(data.results)).toEqual([]);
		expect.soft(data.total).toBe(50);
		expect.soft(data.pagination?.total).toBe(50);
		expect.soft(data.pagination?.hasMore).toBe(true);
		expect.soft(data.pagination?.nextOffset).toBe(2);
	});

	it("SearchService.search defaults the index query to includeArchived=false", async () => {
		const service = new SearchService({ stateDir: "unused-search-state", projectId: "proj-search" });
		const queries: any[] = [];
		(service as any)._state = "ready";
		(service as any)._store = {
			search(query: any) {
				queries.push(query);
				return Promise.resolve({ results: [], total: 0 });
			},
		};

		await service.search("archive visibility");

		expect(queries[0]).toMatchObject({ includeArchived: false });
	});
});
