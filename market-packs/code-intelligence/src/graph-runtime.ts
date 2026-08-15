import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphQueryService, type GraphComponentGraph, type GraphComponentSnapshot, type GraphNode, type GraphQueryOptions, type GraphQueryResponse } from "./graph-query.js";
import { GraphStore, type GraphComponent, type GraphMeta, type GraphSlot, type GraphSnapshot } from "./graph-store.js";

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
	/** The only branch slot this target may read. */
	slot?: GraphSlot;
	/** A verified direct-parent base, never a component-wide fallback. */
	parentSlot?: GraphSlot;
	componentLabel?: GraphComponent;
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
	/**
	 * This is populated only by the server's scope resolver. Request arguments,
	 * legacy `component`, and arbitrary context fields are deliberately ignored.
	 */
	scopeContext?: {
		project?: { id?: string };
		goal?: { id?: string; ancestry?: readonly { id?: string }[] };
		component?: GraphComponent;
		/** Reserved for server-declared configured-component fan-out. */
		components?: readonly GraphComponent[];
	};
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

	/** `projectId` is supplied by the server facade cache; an unbound test seam reads nothing. */
	constructor(private readonly store: GraphStore, private readonly projectId?: string) {
		this.lifecycle = new GraphRuntime<GraphRuntimeFacadeContext>({
			resolveTargets: async context => this.targets(context),
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

	private targets(context: GraphRuntimeFacadeContext): GraphTarget[] {
		if (!this.projectId || verifiedProjectId(context) !== this.projectId) return [];
		return targetsFor(context);
	}

	private async readStatus(target: GraphTarget): Promise<GraphStatus | null> {
		const snapshot = await this.authorizedSnapshot(target);
		if (!snapshot) return { state: "stale", component: target.component, staleReason: "missing-runtime" };
		return { state: snapshot.meta.state, component: target.component, headRev: snapshot.meta.revisions.headRev, staleReason: snapshot.meta.staleReason };
	}

	/**
	 * A facade query may read precisely one branch slot, followed only by its
	 * server-derived direct-parent slot. It must never enumerate `current/`: that
	 * reveals sibling goal/worktree revisions even when their component matches.
	 */
	private async authorizedSnapshot(target: GraphTarget): Promise<GraphSnapshot | null> {
		if (!target.slot) return null;
		const component = componentForTarget(target);
		const current = await this.store.readCurrent(component, target.slot);
		if (current) return current;
		return target.parentSlot ? this.store.readCurrent(component, target.parentSlot) : null;
	}

	private async snapshots(context: GraphRuntimeFacadeContext, names?: readonly string[]): Promise<readonly GraphComponentSnapshot[]> {
		const targets = this.targets(context).filter(target => !names || names.includes(target.component));
		return (await Promise.all(targets.map(async target => {
			const snapshot = await this.authorizedSnapshot(target);
			return snapshot ? this.snapshot(snapshot) : null;
		}))).flatMap(snapshot => snapshot ? [snapshot] : []);
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

/** Resolves a facade from a server-verified project identity only. */
export function getGraphRuntime(context: GraphRuntimeFacadeContext): GraphRuntimeFacade {
	const projectId = verifiedProjectId(context);
	if (!projectId) throw new Error("GRAPH_CONTEXT_PROJECT_REQUIRED");
	const hostRoot = graphHostRoot();
	const key = `${hostRoot}\u0000${projectId}`;
	let runtime = facadeCache.get(key);
	if (!runtime) {
		runtime = new GraphRuntimeFacade(new GraphStore(hostRoot, projectId), projectId);
		facadeCache.set(key, runtime);
	}
	return runtime;
}

function graphHostRoot(): string {
	const configured = process.env.BOBBIT_DIR?.trim();
	return path.resolve(configured || path.join(os.homedir(), ".bobbit"));
}

/** Builds targets exclusively from the server's verified scope snapshot. */
function targetsFor(context: GraphRuntimeFacadeContext): GraphTarget[] {
	const projectId = verifiedProjectId(context);
	const scope = context.scopeContext;
	const goalId = verifiedGoalId(scope);
	const worktreeId = verifiedWorktreeId(context);
	if (!projectId || !scope || !goalId || !worktreeId) return [];
	const components = verifiedComponents(scope);
	if (!components.length) return [];
	const parentGoalId = verifiedDirectParent(scope, goalId);
	const branch = nonEmpty(context.branch);
	const slot: GraphSlot = {
		kind: "branch", goalId, worktreeId,
		...(branch ? { branch: branch.trim() } : {}),
	};
	const parentSlot = parentGoalId ? { kind: "derived-base" as const, goalId: parentGoalId } : undefined;
	return components.map(component => ({
		projectId, component: component.name, componentLabel: component, worktreeId, goalId,
		...(parentGoalId ? { parentGoalId } : {}), ...(branch ? { primaryRef: branch.trim() } : {}),
		slot, ...(parentSlot ? { parentSlot } : {}),
	}));
}
function verifiedProjectId(context: GraphRuntimeFacadeContext): string | undefined {
	const projectId = nonEmpty(context?.projectId);
	const scoped = nonEmpty(context?.scopeContext?.project?.id);
	return projectId && scoped === projectId ? projectId : undefined;
}
function verifiedGoalId(scope: GraphRuntimeFacadeContext["scopeContext"]): string | undefined {
	const goalId = nonEmpty(scope?.goal?.id);
	return goalId;
}
function verifiedWorktreeId(context: GraphRuntimeFacadeContext): string | undefined {
	return nonEmpty(context.worktreeId) ?? nonEmpty(context.worktreePath) ?? nonEmpty(context.workingDir);
}
function verifiedComponents(scope: NonNullable<GraphRuntimeFacadeContext["scopeContext"]>): GraphComponent[] {
	const values = scope.components?.length ? scope.components : scope.component ? [scope.component] : [];
	const unique = new Map<string, GraphComponent>();
	for (const component of values) {
		if (!component || !nonEmpty(component.name) || !nonEmpty(component.repo)) continue;
		const relativePath = nonEmpty(component.relativePath);
		const label: GraphComponent = { name: component.name.trim(), repo: component.repo.trim(), ...(relativePath ? { relativePath: relativePath.trim() } : {}) };
		unique.set(`${label.name}\u0000${label.repo}\u0000${label.relativePath ?? ""}`, label);
	}
	return [...unique.values()];
}
function verifiedDirectParent(scope: GraphRuntimeFacadeContext["scopeContext"], goalId: string): string | undefined {
	const ancestry = scope?.goal?.ancestry;
	if (!ancestry || ancestry.length < 2 || ancestry.at(-1)?.id !== goalId) return undefined;
	return nonEmpty(ancestry.at(-2)?.id);
}
function componentForTarget(target: GraphTarget): GraphComponent {
	return target.componentLabel ?? { name: target.component, repo: "." };
}
function nonEmpty(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function requiredRequestText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`graph ${label} is required`);
	return value.trim().slice(0, 2_000);
}
function queryOptions(request: GraphRuntimeRequest): GraphQueryOptions {
	// Component selection is authorization, not a query option. The request body
	// cannot widen the server-declared component scope; snapshots applies a
	// requested name only as an intersection with that scope.
	const out: GraphQueryOptions = {};
	const components = request.components?.length ? [...new Set(request.components)].slice(0, 8) : request.component ? [request.component] : undefined;
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
