export type GraphTier = "code" | "docs";
export type GraphState = "fresh" | "building" | "stale" | "failed" | "base-fallback";
export type GraphOperation = "affected" | "explain" | "path" | "neighbors" | "query" | "status";

export interface GraphComponentLabel {
	name: string;
	repo: string;
	relativePath?: string;
}
export interface GraphRevision {
	baseRef: string;
	baseRev: string;
	headRev: string;
}
export interface GraphNode {
	id: string;
	label: string;
	tier: GraphTier;
	sourceRoot: string;
	sourcePath?: string;
	summary?: string;
	/** Communities are intentionally per-tier: an equal id in another tier is distinct. */
	community?: string;
}
export interface GraphEdge {
	from: string;
	to: string;
	type?: string;
}
export interface GraphComponentGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}
export interface GraphComponentSnapshot {
	component: GraphComponentLabel;
	revisions: GraphRevision;
	state: GraphState;
	staleReason?: string;
	graph: GraphComponentGraph;
}

/** The store is host-owned; this narrow interface never exposes its artifact paths. */
export interface GraphSnapshotReader {
	list(componentNames?: readonly string[]): Promise<readonly GraphComponentSnapshot[]> | readonly GraphComponentSnapshot[];
}
export interface GraphLatencyRecorder {
	record(input: { component: string; scope: "code" | "codeDocs"; operation: GraphOperation; elapsedMs: number }): void | Promise<void>;
}

export const GRAPH_QUERY_CAPS = {
	components: 8,
	depth: 4,
	results: 50,
	nodes: 100,
	edges: 150,
	snippets: 20,
	serializedBytes: 128 * 1024,
} as const;
export interface GraphQueryCaps {
	components: number;
	depth: number;
	results: number;
	nodes: number;
	edges: number;
	snippets: number;
	serializedBytes: number;
}
export interface GraphQueryOptions {
	components?: readonly string[];
	maxDepth?: number;
	maxResults?: number;
	maxNodes?: number;
	maxEdges?: number;
	maxSnippets?: number;
}
export interface GraphTextQueryOptions extends GraphQueryOptions { includeDocs?: boolean }
export interface GraphPathOptions extends GraphQueryOptions { from: string; to: string }
export interface GraphNeedleOptions extends GraphQueryOptions { id: string }
export interface GraphAffectedOptions extends GraphQueryOptions { id: string }

export interface TierCluster { tier: GraphTier; community: string; nodeIds: string[] }
export interface GraphComponentResult {
	component: GraphComponentLabel;
	revision: string;
	state: GraphState;
	banner: "FRESH" | "STALE" | "BASE FALLBACK";
	staleReason?: string;
	results: GraphNode[];
	edges: GraphEdge[];
	clusters: TierCluster[];
	omitted: number;
}
export interface GraphQueryResponse {
	operation: GraphOperation;
	scope: { tiers: GraphTier[]; includeDocs: boolean };
	components: GraphComponentResult[];
	/** v1 graph snapshots never contain cross-repository edges. */
	noCrossRepoEdges: true;
	warning?: "v1 has no cross-repo edges";
	leadNotice: "Results are leads requiring source verification.";
	truncated: boolean;
}

export class GraphQueryService {
	private readonly caps: GraphQueryCaps;
	constructor(private readonly reader: GraphSnapshotReader, private readonly metrics?: GraphLatencyRecorder, caps: Partial<GraphQueryCaps> = {}) {
		this.caps = normaliseCaps(caps);
	}

	async affected(options: GraphAffectedOptions): Promise<GraphQueryResponse> {
		return this.run("affected", options, ["code"], snapshot => affected(snapshot, options.id, this.number(options.maxDepth, "depth")));
	}
	async explain(options: GraphNeedleOptions): Promise<GraphQueryResponse> {
		return this.run("explain", options, ["code"], snapshot => explain(snapshot, options.id));
	}
	async path(options: GraphPathOptions): Promise<GraphQueryResponse> {
		return this.run("path", options, ["code"], snapshot => findPath(snapshot, options.from, options.to, this.number(options.maxDepth, "depth")));
	}
	async neighbors(options: GraphNeedleOptions): Promise<GraphQueryResponse> {
		return this.run("neighbors", options, ["code"], snapshot => neighbors(snapshot, options.id, this.number(options.maxDepth, "depth")));
	}
	async query(text: string, options: GraphTextQueryOptions = {}): Promise<GraphQueryResponse> {
		if (typeof text !== "string" || !text.trim()) throw new Error("graph query text is required");
		const tiers: GraphTier[] = options.includeDocs === true ? ["code", "docs"] : ["code"];
		return this.run("query", options, tiers, snapshot => search(snapshot, text));
	}
	async status(options: GraphQueryOptions = {}): Promise<GraphQueryResponse> {
		return this.run("status", options, ["code"], _snapshot => ({ nodes: [], edges: [] }));
	}

	private async run(operation: GraphOperation, options: GraphQueryOptions, tiers: GraphTier[], select: (snapshot: GraphComponentSnapshot) => GraphComponentGraph): Promise<GraphQueryResponse> {
		assertCodeOnlyOptions(operation, options);
		const componentNames = normaliseComponents(options.components, this.caps.components);
		const snapshots = await this.reader.list(componentNames);
		if (snapshots.length > this.caps.components) throw new Error(`graph query component count exceeds cap ${this.caps.components}`);
		const resultLimit = this.number(options.maxResults, "results");
		const nodeLimit = this.number(options.maxNodes, "nodes");
		const edgeLimit = this.number(options.maxEdges, "edges");
		const snippetLimit = this.number(options.maxSnippets, "snippets");
		// A reader that returns more than the requested component is still fan-out;
		// never let a host adapter accidentally hide the v1 boundary warning.
		const fanout = !componentNames || componentNames.length !== 1 || snapshots.length !== 1;
		const scope = { tiers, includeDocs: tiers.includes("docs") };
		const components: GraphComponentResult[] = [];
		for (const snapshot of snapshots) {
			const started = performance.now();
			const selected = filterGraph(select(snapshot), tiers);
			const bounded = boundGraph(selected, resultLimit, nodeLimit, edgeLimit, snippetLimit);
			components.push({
				component: cloneLabel(snapshot.component), revision: snapshot.revisions.headRev, state: snapshot.state,
				banner: stateBanner(snapshot.state), ...(snapshot.staleReason ? { staleReason: snapshot.staleReason } : {}),
				results: bounded.nodes, edges: bounded.edges, clusters: clusterNodesByTier(bounded.nodes), omitted: bounded.omitted,
			});
			await this.metrics?.record({ component: snapshot.component.name, scope: scope.includeDocs ? "codeDocs" : "code", operation, elapsedMs: performance.now() - started });
		}
		const response: GraphQueryResponse = {
			operation, scope, components, noCrossRepoEdges: true,
			...(fanout ? { warning: "v1 has no cross-repo edges" as const } : {}),
			leadNotice: "Results are leads requiring source verification.", truncated: components.some(component => component.omitted > 0),
		};
		return capSerializedResponse(response, this.caps.serializedBytes);
	}

	private number(value: number | undefined, key: keyof Pick<GraphQueryCaps, "depth" | "results" | "nodes" | "edges" | "snippets">): number {
		if (value === undefined) return this.caps[key];
		if (!Number.isSafeInteger(value) || value < 1 || value > this.caps[key]) throw new Error(`graph query ${key} must be between 1 and ${this.caps[key]}`);
		return value;
	}
}

export function clusterNodesByTier(nodes: readonly GraphNode[]): TierCluster[] {
	const groups = new Map<string, TierCluster>();
	for (const node of nodes) {
		const community = node.community ?? node.id;
		const key = `${node.tier}\u0000${community}`;
		const group = groups.get(key) ?? { tier: node.tier, community, nodeIds: [] };
		group.nodeIds.push(node.id);
		groups.set(key, group);
	}
	return [...groups.values()].map(group => ({ ...group, nodeIds: [...group.nodeIds].sort() }))
		.sort((a, b) => a.tier.localeCompare(b.tier) || a.community.localeCompare(b.community));
}

function affected(snapshot: GraphComponentSnapshot, id: string, depth: number): GraphComponentGraph {
	const node = findNode(snapshot.graph.nodes, id);
	if (!node) return { nodes: [], edges: [] };
	const reverse = indexEdges(snapshot.graph.edges, "to");
	return traverse(snapshot.graph, [node.id], reverse, depth);
}
function neighbors(snapshot: GraphComponentSnapshot, id: string, depth: number): GraphComponentGraph {
	const node = findNode(snapshot.graph.nodes, id);
	if (!node) return { nodes: [], edges: [] };
	const outgoing = indexEdges(snapshot.graph.edges, "from");
	const incoming = indexEdges(snapshot.graph.edges, "to");
	const edges = new Map<string, GraphEdge>();
	for (const edge of [...(outgoing.get(node.id) ?? []), ...(incoming.get(node.id) ?? [])]) edges.set(edgeKey(edge), edge);
	const local: GraphComponentGraph = { nodes: snapshot.graph.nodes, edges: [...edges.values()] };
	const adjacency = indexEdges(local.edges, "from", true);
	return traverse(local, [node.id], adjacency, depth);
}
function explain(snapshot: GraphComponentSnapshot, id: string): GraphComponentGraph {
	const node = findNode(snapshot.graph.nodes, id);
	if (!node) return { nodes: [], edges: [] };
	const edges = snapshot.graph.edges.filter(edge => edge.from === node.id || edge.to === node.id);
	const ids = new Set([node.id, ...edges.flatMap(edge => [edge.from, edge.to])]);
	return { nodes: snapshot.graph.nodes.filter(candidate => ids.has(candidate.id)), edges };
}
function findPath(snapshot: GraphComponentSnapshot, from: string, to: string, depth: number): GraphComponentGraph {
	const first = findNode(snapshot.graph.nodes, from);
	const last = findNode(snapshot.graph.nodes, to);
	if (!first || !last) return { nodes: [], edges: [] };
	const adjacency = indexEdges(snapshot.graph.edges, "from");
	const queue: Array<{ id: string; path: GraphEdge[] }> = [{ id: first.id, path: [] }];
	const visited = new Set([first.id]);
	while (queue.length) {
		const current = queue.shift()!;
		if (current.id === last.id) {
			const ids = new Set([first.id, ...current.path.flatMap(edge => [edge.from, edge.to])]);
			return { nodes: snapshot.graph.nodes.filter(node => ids.has(node.id)), edges: current.path };
		}
		if (current.path.length >= depth) continue;
		for (const edge of adjacency.get(current.id) ?? []) if (!visited.has(edge.to)) {
			visited.add(edge.to); queue.push({ id: edge.to, path: [...current.path, edge] });
		}
	}
	return { nodes: [], edges: [] };
}
function search(snapshot: GraphComponentSnapshot, text: string): GraphComponentGraph {
	const needle = text.trim().toLocaleLowerCase();
	return { nodes: snapshot.graph.nodes.filter(node => [node.id, node.label, node.sourcePath, node.summary].some(value => value?.toLocaleLowerCase().includes(needle))), edges: [] };
}
function traverse(graph: GraphComponentGraph, starts: readonly string[], adjacency: Map<string, GraphEdge[]>, depth: number): GraphComponentGraph {
	const visited = new Set(starts);
	const selectedEdges = new Map<string, GraphEdge>();
	let frontier = [...starts];
	for (let level = 0; level < depth && frontier.length; level += 1) {
		const next: string[] = [];
		for (const id of frontier) for (const edge of adjacency.get(id) ?? []) {
			selectedEdges.set(edgeKey(edge), edge);
			const nextId = edge.from === id ? edge.to : edge.from;
			if (!visited.has(nextId)) { visited.add(nextId); next.push(nextId); }
		}
		frontier = next;
	}
	return { nodes: graph.nodes.filter(node => visited.has(node.id)), edges: [...selectedEdges.values()] };
}
function indexEdges(edges: readonly GraphEdge[], key: "from" | "to", undirected = false): Map<string, GraphEdge[]> {
	const indexed = new Map<string, GraphEdge[]>();
	for (const edge of edges) {
		const keys = undirected ? [edge.from, edge.to] : [edge[key]];
		for (const id of keys) indexed.set(id, [...(indexed.get(id) ?? []), edge]);
	}
	return indexed;
}
function filterGraph(graph: GraphComponentGraph, tiers: readonly GraphTier[]): GraphComponentGraph {
	const ids = new Set(graph.nodes.filter(node => tiers.includes(node.tier)).map(node => node.id));
	return { nodes: graph.nodes.filter(node => ids.has(node.id)), edges: graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
}
function boundGraph(graph: GraphComponentGraph, resultLimit: number, nodeLimit: number, edgeLimit: number, snippetLimit: number): GraphComponentGraph & { omitted: number } {
	const nodes = graph.nodes.slice(0, Math.min(resultLimit, nodeLimit)).map((node, index) => ({ ...node, ...(index < snippetLimit ? {} : { summary: undefined }) }));
	const ids = new Set(nodes.map(node => node.id));
	const edges = graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).slice(0, edgeLimit).map(edge => ({ ...edge }));
	return { nodes, edges, omitted: Math.max(0, graph.nodes.length - nodes.length) + Math.max(0, graph.edges.length - edges.length) };
}
function capSerializedResponse(response: GraphQueryResponse, cap: number): GraphQueryResponse {
	const copy: GraphQueryResponse = structuredClone(response);
	while (new TextEncoder().encode(JSON.stringify(copy)).byteLength > cap) {
		const component = [...copy.components].reverse().find(candidate => candidate.edges.length || candidate.results.length);
		if (!component) throw new Error(`graph query response cannot fit serialized cap ${cap}`);
		if (component.edges.length) component.edges.pop();
		else component.results.pop();
		component.omitted += 1;
		copy.truncated = true;
	}
	return copy;
}
function normaliseCaps(overrides: Partial<GraphQueryCaps>): GraphQueryCaps {
	const caps = { ...GRAPH_QUERY_CAPS, ...overrides };
	for (const [name, value] of Object.entries(caps)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid graph query cap: ${name}`);
	return caps;
}
function normaliseComponents(components: readonly string[] | undefined, cap: number): string[] | undefined {
	if (components === undefined) return undefined;
	const values = [...new Set(components)];
	if (values.length === 0 || values.length > cap || values.some(name => typeof name !== "string" || !name.trim())) throw new Error(`graph query component count must be between 1 and ${cap}`);
	return values.sort();
}
function assertCodeOnlyOptions(operation: GraphOperation, options: GraphQueryOptions): void {
	if (operation !== "query" && "includeDocs" in options) throw new Error("includeDocs is supported only by graph_query");
}
function findNode(nodes: readonly GraphNode[], id: string): GraphNode | undefined { return nodes.find(node => node.id === id || node.label === id); }
function edgeKey(edge: GraphEdge): string { return `${edge.from}\u0000${edge.to}\u0000${edge.type ?? ""}`; }
function stateBanner(state: GraphState): "FRESH" | "STALE" | "BASE FALLBACK" { return state === "fresh" ? "FRESH" : state === "base-fallback" ? "BASE FALLBACK" : "STALE"; }
function cloneLabel(component: GraphComponentLabel): GraphComponentLabel { return { ...component }; }
