import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphQueryService, type GraphComponentGraph, type GraphComponentSnapshot, type GraphNode, type GraphQueryOptions, type GraphQueryResponse } from "./graph-query.js";
import { GraphStore, type GraphComponent, type GraphMeta, type GraphSnapshot } from "./graph-store.js";

/**
 * EP-8 has not supplied a service lifecycle owner. This module deliberately
 * has no queue, timer, worker, child process, or automatic Graphify execution.
 * Lifecycle hooks are cheap adapters only; manual rebuild remains a bounded,
 * synchronous route invocation seam for the future service owner.
 */
export type GraphStaleReason = "parent-advanced" | "worktree-dirty" | "base-rebuilt" | "validation-failed" | "version-changed" | "missing-runtime";

export interface GraphTarget {
	projectId: string;
	component: string;
	/** Server-derived worktree identity; never a filesystem path. */
	worktreeId: string;
	goalId?: string;
	parentGoalId?: string;
	primaryRef?: string;
}

export interface GraphStatus {
	state: "fresh" | "building" | "stale" | "failed" | "base-fallback";
	component?: string;
	headRev?: string;
	staleReason?: GraphStaleReason;
}

export interface GraphContext { projectId?: string; goalId?: string; cwd?: string; [key: string]: unknown }
export interface GraphContextBlock { id: string; title: string; authority: "generic"; priority: number; reason: string; content: string }
export interface GraphHookResult { blocks: GraphContextBlock[] }

export interface GraphRuntimePort<Context = unknown> {
	resolveTargets(context: Context): Promise<readonly GraphTarget[]>;
	/** A declared read used only by session setup; it must not schedule work. */
	readStatus?(target: GraphTarget): Promise<GraphStatus | null>;
	/**
	 * Direct, bounded route-call seam. It is intentionally unavailable until the
	 * EP-8 lifecycle service provides a host-owned executor.
	 */
	manualRebuild?(context: Context, targets: readonly GraphTarget[]): Promise<GraphManualRebuildResult>;
}

export interface GraphRuntimeOptions { orientationChars?: number }
export interface GraphManualRebuildResult {
	accepted: boolean;
	reason?: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8";
}

const DEFAULT_ORIENTATION_CHARS = 800;
const AUTOMATION_UNAVAILABLE = "Automatic lifecycle processing is unavailable pending EP-8.";

/** Lifecycle adapter with no autonomous execution capability. */
export class GraphRuntime<Context = GraphContext> {
	private readonly orientationChars: number;

	constructor(private readonly port: GraphRuntimePort<Context>, options: GraphRuntimeOptions = {}) {
		this.orientationChars = positiveInteger(options.orientationChars, DEFAULT_ORIENTATION_CHARS, "orientationChars");
	}

	/** Intentionally observes nothing and never starts Graphify work. */
	async goalProvisioned(_context: Context): Promise<GraphHookResult> { return emptyResult(); }

	/** Reads published status only; it cannot create work. */
	async sessionSetup(context: Context): Promise<GraphHookResult> {
		if (!this.port.readStatus) return emptyResult();
		try {
			const blocks: GraphContextBlock[] = [];
			for (const target of await this.port.resolveTargets(context)) {
				const status = await this.port.readStatus(target);
				if (!status || (status.state !== "fresh" && status.state !== "base-fallback")) continue;
				const state = status.state === "fresh" ? "FRESH" : "BASE FALLBACK";
				const detail = [status.component ?? target.component, status.headRev, status.staleReason].filter(Boolean).join(" · ");
				blocks.push({
					id: `graph-status:${safeId(target.component)}`,
					title: "Code graph status",
					authority: "generic",
					priority: 10,
					reason: `${state} graph index available`,
					content: truncate(`${state}: ${detail || "graph index available"}. ${AUTOMATION_UNAVAILABLE} Results are leads; verify source before acting.`, this.orientationChars),
				});
			}
			return { blocks };
		} catch { return emptyResult(); }
	}

	/** Intentionally returns without inspecting changes or starting Graphify. */
	async afterTurn(_context: Context): Promise<GraphHookResult> { return emptyResult(); }

	/** Explicit route-only operation. It awaits the bounded host seam; never queues. */
	async rebuild(context: Context): Promise<GraphManualRebuildResult> {
		if (!this.port.manualRebuild) return { accepted: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" };
		try { return await this.port.manualRebuild(context, await this.port.resolveTargets(context)); }
		catch { return { accepted: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" }; }
	}
}

function emptyResult(): GraphHookResult { return { blocks: [] }; }
function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	return value;
}
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "component"; }
function truncate(value: string, cap: number): string { return value.length <= cap ? value : `${value.slice(0, Math.max(0, cap - 1))}…`; }

// ── Host facade ────────────────────────────────────────────────────────────
//
// Providers, routes, and tools use only this host-side facade. The GraphStore
// is durable; no lifecycle state is held in a queue or background worker.

export interface GraphRuntimeFacadeContext extends GraphContext {
	workingDir?: string;
	worktreePath?: string;
	worktreeId?: string;
	branch?: string;
	component?: string;
	scopeContext?: { component?: { name?: string; repo?: string; relativePath?: string } };
}

export interface GraphRuntimeRequest {
	op?: string;
	components?: readonly string[];
	component?: string;
	symbol?: string;
	node?: string;
	from?: string;
	to?: string;
	query?: string;
	includeDocs?: boolean;
	maxDepth?: number;
	maxResults?: number;
	maxNodes?: number;
	maxEdges?: number;
	maxSnippets?: number;
}

export interface GraphRuntimeStatus {
	state: "fresh" | "building" | "stale" | "failed" | "base-fallback";
	components: GraphQueryResponse["components"];
	lifecycle: { automaticProcessing: "unavailable"; pending: "EP-8"; message: string };
	noCrossRepoEdges: true;
	warning: "v1 has no cross-repo edges";
	warnings: string[];
}

/** Host-side bridge. It returns capped graph data, never GraphStore paths. */
export class GraphRuntimeFacade {
	private readonly lifecycle: GraphRuntime<GraphRuntimeFacadeContext>;

	constructor(private readonly store: GraphStore) {
		this.lifecycle = new GraphRuntime<GraphRuntimeFacadeContext>({
			resolveTargets: async context => targetsFor(context, this.store.projectKey),
			readStatus: async target => this.readStatus(target),
		});
	}

	goalProvisioned(context: GraphRuntimeFacadeContext): Promise<GraphHookResult> { return this.lifecycle.goalProvisioned(context); }
	sessionSetup(context: GraphRuntimeFacadeContext): Promise<GraphHookResult> { return this.lifecycle.sessionSetup(context); }
	afterTurn(context: GraphRuntimeFacadeContext): Promise<GraphHookResult> { return this.lifecycle.afterTurn(context); }

	async query(context: GraphRuntimeFacadeContext, request: GraphRuntimeRequest): Promise<GraphQueryResponse> {
		const service = new GraphQueryService({ list: async names => this.snapshots(context, names) });
		const options = queryOptions(request);
		switch (request.op) {
			case "affected": return service.affected({ ...options, id: requiredRequestText(request.symbol ?? request.node, "symbol") });
			case "explain": return service.explain({ ...options, id: requiredRequestText(request.node ?? request.symbol, "node") });
			case "path": return service.path({ ...options, from: requiredRequestText(request.from, "from"), to: requiredRequestText(request.to, "to") });
			case "neighbors": return service.neighbors({ ...options, id: requiredRequestText(request.node ?? request.symbol, "node") });
			case "query": return service.query(requiredRequestText(request.query, "query"), { ...options, ...(request.includeDocs === true ? { includeDocs: true } : {}) });
			case "status": return service.status(options);
			default: throw new Error("GRAPH_OPERATION_INVALID");
		}
	}

	async status(context: GraphRuntimeFacadeContext, request: GraphRuntimeRequest = {}): Promise<GraphRuntimeStatus> {
		const response = await this.query(context, { ...request, op: "status" });
		return {
			state: response.components[0]?.state ?? "stale",
			components: response.components,
			lifecycle: { automaticProcessing: "unavailable", pending: "EP-8", message: AUTOMATION_UNAVAILABLE },
			noCrossRepoEdges: true,
			warning: "v1 has no cross-repo edges",
			warnings: [AUTOMATION_UNAVAILABLE, "No graph rebuild is started automatically."],
		};
	}

	async config(_context: GraphRuntimeFacadeContext): Promise<Record<string, unknown>> {
		return {
			readOnly: true,
			storage: "host-only",
			defaultTiers: ["code"],
			docsOptIn: "graph_query.includeDocs",
			lifecycle: { automaticProcessing: "unavailable", pending: "EP-8", message: AUTOMATION_UNAVAILABLE },
			manualRebuild: { routeOnly: true, available: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8" },
			noCrossRepoEdges: true,
			warning: "v1 has no cross-repo edges",
		};
	}

	/** The route awaits this result. It cannot queue or detach Graphify work. */
	async rebuild(context: GraphRuntimeFacadeContext, _request: { source?: "manual"; components?: readonly string[] } = {}): Promise<{ accepted: false; reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8"; status: GraphRuntimeStatus }> {
		await this.lifecycle.rebuild(context);
		return { accepted: false, reason: "GRAPH_REBUILD_UNAVAILABLE_PENDING_EP8", status: await this.status(context) };
	}

	private async readStatus(target: GraphTarget): Promise<GraphStatus | null> {
		const component = componentForTarget(target);
		const snapshots = (await this.store.status(component)).snapshots;
		const snapshot = snapshots.find(candidate => candidate.meta.component.name === target.component);
		if (!snapshot) return { state: "stale", component: target.component, staleReason: "missing-runtime" };
		return { state: snapshot.meta.state, component: target.component, headRev: snapshot.meta.revisions.headRev, staleReason: snapshot.meta.staleReason };
	}

	private async snapshots(context: GraphRuntimeFacadeContext, names?: readonly string[]): Promise<readonly GraphComponentSnapshot[]> {
		const selected = await Promise.all(targetsFor(context, this.store.projectKey)
			.filter(target => !names || names.includes(target.component))
			.map(async target => {
				const component = componentForTarget(target);
				const status = await this.store.status(component);
				return Promise.all(status.snapshots.map(snapshot => this.snapshot(snapshot)));
			}));
		return selected.flat();
	}

	private async snapshot(snapshot: GraphSnapshot): Promise<GraphComponentSnapshot> {
		const meta = snapshot.meta;
		return {
			component: { ...meta.component }, revisions: { ...meta.revisions }, state: meta.state,
			...(meta.staleReason ? { staleReason: meta.staleReason } : {}), graph: await this.readGraph(snapshot, meta),
		};
	}

	private async readGraph(snapshot: GraphSnapshot, meta: GraphMeta): Promise<GraphComponentGraph> {
		for (const relative of ["graph.json", "data/graph.json"]) {
			try { return graphFromUnknown(JSON.parse(await fs.readFile(await this.store.artifactPath(snapshot, relative), "utf8")), meta); }
			catch { /* Try the next known host-only artifact name. */ }
		}
		return { nodes: [], edges: [] };
	}
}

const facadeCache = new Map<string, GraphRuntimeFacade>();

/** Resolves a facade from server-derived identity only. */
export function getGraphRuntime(context: GraphRuntimeFacadeContext): GraphRuntimeFacade {
	const projectId = typeof context?.projectId === "string" && context.projectId ? context.projectId : "unassigned-project";
	const hostRoot = graphHostRoot();
	const key = `${hostRoot}\u0000${projectId}`;
	let runtime = facadeCache.get(key);
	if (!runtime) {
		runtime = new GraphRuntimeFacade(new GraphStore(hostRoot, projectId));
		facadeCache.set(key, runtime);
	}
	return runtime;
}

function graphHostRoot(): string {
	const configured = process.env.BOBBIT_DIR?.trim();
	return path.resolve(configured || path.join(os.homedir(), ".bobbit"));
}
function targetsFor(context: GraphRuntimeFacadeContext, fallbackWorktree: string): GraphTarget[] {
	const scoped = context.scopeContext?.component;
	const component = scoped?.name || context.component || "default";
	return [{
		projectId: typeof context.projectId === "string" && context.projectId ? context.projectId : "unassigned-project",
		component, worktreeId: context.worktreeId || context.goalId || fallbackWorktree,
		...(context.goalId ? { goalId: context.goalId } : {}), ...(context.branch ? { primaryRef: context.branch } : {}),
	}];
}
function componentForTarget(target: GraphTarget): GraphComponent { return { name: target.component, repo: "." }; }
function requiredRequestText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`graph ${label} is required`);
	return value.trim().slice(0, 2_000);
}
function queryOptions(request: GraphRuntimeRequest): GraphQueryOptions {
	const components = request.components?.length ? [...new Set(request.components)].slice(0, 8) : request.component ? [request.component] : undefined;
	const out: GraphQueryOptions = {};
	if (components) out.components = components;
	for (const key of ["maxDepth", "maxResults", "maxNodes", "maxEdges", "maxSnippets"] as const) if (request[key] !== undefined) out[key] = request[key];
	return out;
}
function graphFromUnknown(value: unknown, meta: GraphMeta): GraphComponentGraph {
	const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
	const rawNodes = Array.isArray(record.nodes) ? record.nodes : [];
	const nodes: GraphNode[] = rawNodes.flatMap((raw, index) => {
		if (!raw || typeof raw !== "object") return [];
		const node = raw as Record<string, unknown>;
		const id = typeof node.id === "string" ? node.id : typeof node.name === "string" ? node.name : `node-${index}`;
		const sourcePath = safeRelative(node.sourcePath ?? node.path ?? node.file);
		const tier = sourcePath && meta.corpus.roots.some(root => root.tier === "docs" && (sourcePath === root.path || sourcePath.startsWith(`${root.path}/`))) ? "docs" : "code";
		return [{ id, label: typeof node.label === "string" ? node.label : id, tier, sourceRoot: tier === "docs" ? "docs" : "code", ...(sourcePath ? { sourcePath } : {}), ...(typeof node.summary === "string" ? { summary: node.summary.slice(0, 2_000) } : {}) }];
	});
	const ids = new Set(nodes.map(node => node.id));
	const edges = (Array.isArray(record.edges) ? record.edges : []).flatMap(raw => {
		if (!raw || typeof raw !== "object") return [];
		const edge = raw as Record<string, unknown>;
		return typeof edge.from === "string" && typeof edge.to === "string" && ids.has(edge.from) && ids.has(edge.to) ? [{ from: edge.from, to: edge.to, ...(typeof edge.type === "string" ? { type: edge.type } : {}) }] : [];
	});
	return { nodes, edges };
}
function safeRelative(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\0")) return undefined;
	const normal = value.replace(/\\/g, "/").replace(/^\.\//, "");
	return normal.split("/").some(part => !part || part === "." || part === "..") ? undefined : normal;
}
