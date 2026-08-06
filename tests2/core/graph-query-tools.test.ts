import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
	GraphQueryService,
	clusterNodesByTier,
	type GraphComponentSnapshot,
} from "../../market-packs/code-intelligence/src/graph-query.ts";
import {
	executeGraphTool,
	formatGraphToolResponse,
	GRAPH_TOOL_DEFINITIONS,
} from "../../market-packs/code-intelligence/src/graph-tools.ts";

const snapshots: GraphComponentSnapshot[] = [
	{
		component: { name: "api", repo: "." }, revisions: { baseRef: "main", baseRev: "a", headRev: "b" }, state: "fresh",
		graph: {
			nodes: [
				{ id: "controller", label: "Controller", tier: "code", sourceRoot: "src", sourcePath: "src/controller.ts", community: "http" },
				{ id: "service", label: "Service", tier: "code", sourceRoot: "src", sourcePath: "src/service.ts", community: "http" },
				{ id: "guide", label: "Service guide", tier: "docs", sourceRoot: "docs", sourcePath: "docs/service.md", community: "http" },
			],
			edges: [{ from: "controller", to: "service", type: "calls" }, { from: "guide", to: "service", type: "documents" }],
		},
	},
	{
		component: { name: "web", repo: "packages/web" }, revisions: { baseRef: "main", baseRev: "c", headRev: "d" }, state: "base-fallback", staleReason: "base-rebuilt",
		graph: { nodes: [{ id: "client", label: "Client service", tier: "code", sourceRoot: "src", sourcePath: "src/client.ts", community: "ui" }], edges: [] },
	},
];

function service(recorded: Array<{ scope: string; component: string }> = []) {
	return new GraphQueryService({ list: names => snapshots.filter(snapshot => !names || names.includes(snapshot.component.name)) }, {
		record: metric => { recorded.push(metric); },
	});
}

describe("GraphQueryService — one tagged corpus with tier-safe fan-out", () => {
	it("searches code by default, permits docs only on graph_query, and records independent latency buckets", async () => {
		const recorded: Array<{ scope: string; component: string }> = [];
		const query = service(recorded);
		const code = await query.query("guide");
		assert.deepEqual(code.scope, { tiers: ["code"], includeDocs: false });
		assert.equal(code.components[0].results.length, 0);
		const docs = await query.query("guide", { includeDocs: true, components: ["api"] });
		assert.deepEqual(docs.scope, { tiers: ["code", "docs"], includeDocs: true });
		assert.deepEqual(docs.components[0].results.map(node => node.id), ["guide"]);
		assert.deepEqual(recorded.map(metric => metric.scope), ["code", "code", "codeDocs"]);
		await assert.rejects(() => query.explain({ id: "guide", includeDocs: true } as never), /only by graph_query/);
	});

	it("keeps components independent, labels fan-out results, and never claims cross-repo edges", async () => {
		const response = await service().query("service");
		assert.equal(response.noCrossRepoEdges, true);
		assert.equal(response.warning, "v1 has no cross-repo edges");
		assert.deepEqual(response.components.map(component => component.component.name), ["api", "web"]);
		assert.equal(response.components[1].banner, "BASE FALLBACK");
		const formatted = formatGraphToolResponse(response);
		assert.match(formatted, /FRESH: api/);
		assert.match(formatted, /BASE FALLBACK: web/);
		assert.match(formatted, /v1 has no cross-repo edges/);
		assert.match(formatted, /leads requiring source verification/);
	});

	it("clusters separately by tier even where communities share an identifier", () => {
		assert.deepEqual(clusterNodesByTier([snapshots[0].graph.nodes[0], snapshots[0].graph.nodes[1], snapshots[0].graph.nodes[2]]), [
			{ tier: "code", community: "http", nodeIds: ["controller", "service"] },
			{ tier: "docs", community: "http", nodeIds: ["guide"] },
		]);
	});

	it("caps results and emits an explicit omitted count before tool formatting", async () => {
		const response = await service().query("service", { components: ["api"], includeDocs: true, maxResults: 1 });
		assert.equal(response.components[0].results.length, 1);
		assert.equal(response.components[0].omitted, 1);
		assert.equal(response.truncated, true);
		assert.match(formatGraphToolResponse(response), /truncated: 1 result omitted/);
		await assert.rejects(() => service().query("service", { maxResults: 51 }), /between 1 and 50/);
	});
});

describe("graph tools — six read-only operations share query policy", () => {
	it("declares six read-only schemas and executes each operation through the host-side service", async () => {
		assert.deepEqual(GRAPH_TOOL_DEFINITIONS.map(definition => definition.name), ["graph_affected", "graph_explain", "graph_path", "graph_neighbors", "graph_query", "graph_status"]);
		assert.ok(GRAPH_TOOL_DEFINITIONS.every(definition => definition.readOnly));
		assert.equal("includeDocs" in (GRAPH_TOOL_DEFINITIONS[4].input.properties as object), true);
		assert.equal("includeDocs" in (GRAPH_TOOL_DEFINITIONS[0].input.properties as object), false);
		const query = service();
		const calls = await Promise.all([
			executeGraphTool(query, "graph_affected", { id: "service", components: ["api"] }),
			executeGraphTool(query, "graph_explain", { id: "service", components: ["api"] }),
			executeGraphTool(query, "graph_path", { from: "controller", to: "service", components: ["api"] }),
			executeGraphTool(query, "graph_neighbors", { id: "service", components: ["api"] }),
			executeGraphTool(query, "graph_query", { query: "guide", components: ["api"], includeDocs: true }),
			executeGraphTool(query, "graph_status", { components: ["api"] }),
		]);
		assert.deepEqual(calls.map(response => response.operation), ["affected", "explain", "path", "neighbors", "query", "status"]);
		assert.equal(calls[2].components[0].edges.length, 1);
		assert.equal(calls[4].components[0].results[0].tier, "docs");
		await assert.rejects(() => executeGraphTool(query, "graph_explain", { id: "service", includeDocs: true }), /does not accept includeDocs/);
	});
});
