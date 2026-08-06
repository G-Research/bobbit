import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";

import { GRAPH_QUERY_CAPS, GraphQueryService } from "../../market-packs/code-intelligence/src/graph-query.ts";
import { __setGraphRuntimeForTests, routes } from "../../market-packs/code-intelligence/src/routes.ts";
import extension from "../../market-packs/code-intelligence/tools/graph/extension.ts";

const context = { projectId: "route-test" };

function installRuntime(query: (request: Record<string, unknown>) => unknown | Promise<unknown>): void {
	__setGraphRuntimeForTests(() => ({
		query: async (_context: unknown, request: Record<string, unknown>) => query(request),
		status: async (_context: unknown, request: Record<string, unknown>) => query({ ...request, op: "status" }),
		config: async () => ({ ok: true }),
		rebuild: async () => ({ accepted: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8", status: {} as never }),
	} as never));
}

afterEach(() => __setGraphRuntimeForTests());

describe("graph routes — host boundary caps and errors", () => {
	it("clamps hostile values to GRAPH_QUERY_CAPS and forwards valid maxima unchanged", async () => {
		const seen: Record<string, unknown>[] = [];
		installRuntime(request => { seen.push(request); return { ok: true }; });

		const hostile = await routes.status(context, {
			body: {
				op: "affected", symbol: "service", maxResults: 999_999, maxDepth: 999_999, maxPaths: 999_999,
				components: Array.from({ length: GRAPH_QUERY_CAPS.components + 3 }, (_, index) => `component-${index}`),
			},
		});
		const valid = await routes.status(context, { body: { op: "affected", symbol: "service", maxResults: GRAPH_QUERY_CAPS.results, maxDepth: GRAPH_QUERY_CAPS.depth } });

		assert.deepEqual(hostile, { ok: true });
		assert.deepEqual(valid, { ok: true });
		assert.equal(seen.length, 2);
		assert.deepEqual(seen[0].components, Array.from({ length: GRAPH_QUERY_CAPS.components }, (_, index) => `component-${index}`));
		assert.equal(seen[0].maxResults, GRAPH_QUERY_CAPS.results);
		assert.equal(seen[0].maxDepth, GRAPH_QUERY_CAPS.depth);
		assert.equal("maxPaths" in seen[0], false);
		assert.equal(seen[1].maxResults, GRAPH_QUERY_CAPS.results);
		assert.equal(seen[1].maxDepth, GRAPH_QUERY_CAPS.depth);
	});

	it("always declares no cross-repository edges while warning only on fan-out", async () => {
		const query = new GraphQueryService({ list: () => [{
			component: { name: "api", repo: "." }, revisions: { baseRef: "main", baseRev: "a", headRev: "b" }, state: "fresh",
			graph: { nodes: [], edges: [] },
		}] });
		const response = await query.status({ components: ["api"] });
		assert.equal(response.noCrossRepoEdges, true);
		assert.equal(response.warning, undefined);
	});

	it("returns a fixed path-free public error when the host runtime throws", async () => {
		installRuntime(() => { throw new Error("/private/graph-store/candidate/meta.json"); });
		const response = await routes.status(context, { body: { op: "query", query: "graph" } });
		assert.deepEqual(response, { ok: false, error: "GRAPH_RUNTIME_UNAVAILABLE" });
		assert.doesNotMatch(JSON.stringify(response), /private|graph-store|candidate/);
	});

	it("publishes only service-supported TypeBox limits and marks JSON route failures as tool errors", async () => {
		const originalFetch = globalThis.fetch;
		const originalSession = process.env.BOBBIT_SESSION_ID;
		const originalUrl = process.env.BOBBIT_GATEWAY_URL;
		const originalToken = process.env.BOBBIT_TOKEN;
		try {
			process.env.BOBBIT_SESSION_ID = "session";
			process.env.BOBBIT_GATEWAY_URL = "http://gateway.test";
			process.env.BOBBIT_TOKEN = "token";
			globalThis.fetch = (async (url: string | URL) => new Response(JSON.stringify(String(url).endsWith("/surface-token") ? { token: "surface" } : { ok: false, error: "GRAPH_RUNTIME_UNAVAILABLE" }), { status: 200 })) as typeof fetch;
			const registered: any[] = [];
			extension({ registerTool: (tool: unknown) => registered.push(tool) } as any);

			const byName = new Map(registered.map(tool => [tool.name, tool]));
			for (const tool of registered) {
				const properties = tool.parameters.properties as Record<string, { maximum?: number }>;
				if (properties.maxResults) assert.equal(properties.maxResults.maximum, GRAPH_QUERY_CAPS.results);
				if (properties.maxDepth) assert.equal(properties.maxDepth.maximum, GRAPH_QUERY_CAPS.depth);
			}
			assert.equal("maxPaths" in byName.get("graph_path").parameters.properties, false);

			const result = await byName.get("graph_query").execute("call", { query: "graph" });
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /GRAPH_RUNTIME_UNAVAILABLE/);
		} finally {
			globalThis.fetch = originalFetch;
			if (originalSession === undefined) delete process.env.BOBBIT_SESSION_ID; else process.env.BOBBIT_SESSION_ID = originalSession;
			if (originalUrl === undefined) delete process.env.BOBBIT_GATEWAY_URL; else process.env.BOBBIT_GATEWAY_URL = originalUrl;
			if (originalToken === undefined) delete process.env.BOBBIT_TOKEN; else process.env.BOBBIT_TOKEN = originalToken;
		}
	});
});
