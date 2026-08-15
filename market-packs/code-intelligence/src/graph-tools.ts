import {
	GRAPH_QUERY_CAPS,
	GraphQueryService,
	type GraphAffectedOptions,
	type GraphNeedleOptions,
	type GraphPathOptions,
	type GraphQueryOptions,
	type GraphQueryResponse,
	type GraphTextQueryOptions,
} from "./graph-query.ts";

/** Host-side tool adapters. They are read-only and return only capped query data. */
export const GRAPH_TOOL_NAMES = ["graph_affected", "graph_explain", "graph_path", "graph_neighbors", "graph_query", "graph_status"] as const;
export type GraphToolName = (typeof GRAPH_TOOL_NAMES)[number];
export interface GraphToolSchema {
	type: "object";
	additionalProperties: false;
	required?: readonly string[];
	properties: Record<string, unknown>;
}
export interface GraphToolDefinition {
	name: GraphToolName;
	description: string;
	readOnly: true;
	input: GraphToolSchema;
}

const sharedOptions = {
	components: { type: "array", items: { type: "string" }, maxItems: GRAPH_QUERY_CAPS.components },
	maxDepth: { type: "integer", minimum: 1, maximum: GRAPH_QUERY_CAPS.depth },
	maxResults: { type: "integer", minimum: 1, maximum: GRAPH_QUERY_CAPS.results },
	maxNodes: { type: "integer", minimum: 1, maximum: GRAPH_QUERY_CAPS.nodes },
	maxEdges: { type: "integer", minimum: 1, maximum: GRAPH_QUERY_CAPS.edges },
	maxSnippets: { type: "integer", minimum: 1, maximum: GRAPH_QUERY_CAPS.snippets },
} as const;

/** Declared schemas keep every operation on the same cap policy. Only graph_query declares includeDocs. */
export const GRAPH_TOOL_DEFINITIONS: readonly GraphToolDefinition[] = [
	{ name: "graph_affected", description: "Find bounded callers and impact leads for one code node.", readOnly: true, input: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, ...sharedOptions } } },
	{ name: "graph_explain", description: "Explain one code node with its direct graph evidence.", readOnly: true, input: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, ...sharedOptions } } },
	{ name: "graph_path", description: "Find a bounded directed path between two code nodes.", readOnly: true, input: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: { type: "string" }, to: { type: "string" }, ...sharedOptions } } },
	{ name: "graph_neighbors", description: "Find bounded code neighbours for one node.", readOnly: true, input: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, ...sharedOptions } } },
	{ name: "graph_query", description: "Search code by default; set includeDocs to include the docs tier for this request only.", readOnly: true, input: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" }, includeDocs: { type: "boolean" }, ...sharedOptions } } },
	{ name: "graph_status", description: "Show graph freshness and revision status.", readOnly: true, input: { type: "object", additionalProperties: false, properties: { components: sharedOptions.components } } },
];

export type GraphToolArguments =
	| ({ id: string } & GraphAffectedOptions)
	| ({ id: string } & GraphNeedleOptions)
	| GraphPathOptions
	| ({ query: string } & GraphTextQueryOptions)
	| GraphQueryOptions;

export async function executeGraphTool(service: GraphQueryService, name: GraphToolName, raw: unknown): Promise<GraphQueryResponse> {
	const args = asRecord(raw);
	switch (name) {
		case "graph_affected":
			assertAllowedArguments(args, ["id", ...Object.keys(sharedOptions)]);
			return service.affected({ ...common(args), id: stringArg(args, "id") });
		case "graph_explain":
			assertAllowedArguments(args, ["id", ...Object.keys(sharedOptions)]);
			return service.explain({ ...common(args), id: stringArg(args, "id") });
		case "graph_path":
			assertAllowedArguments(args, ["from", "to", ...Object.keys(sharedOptions)]);
			return service.path({ ...common(args), from: stringArg(args, "from"), to: stringArg(args, "to") });
		case "graph_neighbors":
			assertAllowedArguments(args, ["id", ...Object.keys(sharedOptions)]);
			return service.neighbors({ ...common(args), id: stringArg(args, "id") });
		case "graph_query": {
			assertAllowedArguments(args, ["query", "includeDocs", ...Object.keys(sharedOptions)]);
			const includeDocs = optionalBoolean(args, "includeDocs");
			return service.query(stringArg(args, "query"), { ...common(args), ...(includeDocs === undefined ? {} : { includeDocs }) });
		}
		case "graph_status":
			assertAllowedArguments(args, ["components"]);
			return service.status(common(args));
	}
}

/** Text rendering shared by all six tools; it deliberately leads with freshness before evidence. */
export function formatGraphToolResponse(response: GraphQueryResponse): string {
	const lines = [
		`${response.operation.toUpperCase()} — ${response.scope.includeDocs ? "CODE + DOCS" : "CODE"}`,
		response.warning ?? "",
	];
	for (const result of response.components) {
		lines.push(`${result.banner}: ${result.component.name} (${result.component.repo}) rev ${result.revision} [${result.state}]${result.staleReason ? ` — ${result.staleReason}` : ""}`);
		for (const node of result.results) lines.push(`  node ${node.id}: ${node.label}${node.sourcePath ? ` (${node.sourcePath})` : ""}`);
		for (const edge of result.edges) lines.push(`  edge ${edge.from} → ${edge.to}${edge.type ? ` (${edge.type})` : ""}`);
		if (result.clusters.length) lines.push(`  tier clusters: ${result.clusters.map(cluster => `${cluster.tier}/${cluster.community}=${cluster.nodeIds.length}`).join(", ")}`);
		if (result.omitted) lines.push(`  truncated: ${result.omitted} result${result.omitted === 1 ? "" : "s"} omitted`);
	}
	if (response.components.length === 0) lines.push("No eligible component graph is available.");
	if (response.truncated && !response.components.some(component => component.omitted)) lines.push("truncated: response byte cap reached");
	lines.push(response.leadNotice);
	return lines.filter(Boolean).join("\n");
}

function asRecord(raw: unknown): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("graph tool arguments must be an object");
	return raw as Record<string, unknown>;
}
function stringArg(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== "string" || !value.trim()) throw new Error(`graph tool ${name} must be a non-empty string`);
	return value;
}
function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
	const value = args[name];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`graph tool ${name} must be a boolean`);
	return value;
}
function assertAllowedArguments(args: Record<string, unknown>, allowed: readonly string[]): void {
	for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`graph tool does not accept ${key}`);
}
function common(args: Record<string, unknown>): GraphQueryOptions {
	const options: GraphQueryOptions = {};
	if (args.components !== undefined) {
		if (!Array.isArray(args.components) || args.components.some(value => typeof value !== "string")) throw new Error("graph tool components must be a string array");
		options.components = args.components;
	}
	for (const [argument, key] of [["maxDepth", "maxDepth"], ["maxResults", "maxResults"], ["maxNodes", "maxNodes"], ["maxEdges", "maxEdges"], ["maxSnippets", "maxSnippets"]] as const) {
		const value = args[argument];
		if (value !== undefined) {
			if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`graph tool ${argument} must be an integer`);
			options[key] = value;
		}
	}
	return options;
}
