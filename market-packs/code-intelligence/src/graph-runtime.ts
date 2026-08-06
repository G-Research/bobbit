import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphQueryService, type GraphComponentGraph, type GraphComponentSnapshot, type GraphNode, type GraphQueryOptions, type GraphQueryResponse } from "./graph-query.js";
import { GraphStore, type GraphComponent, type GraphMeta, type GraphSnapshot } from "./graph-store.js";

/**
 * Pack-owned scheduler for graph work. It intentionally owns scheduling only:
 * filesystem, git, Graphify, and durable graph metadata stay behind the narrow
 * injected port so hooks never need graph artifacts or checkout write access.
 */
export type GraphOperation = "provision" | "base-rebuild" | "delta" | "manual-rebuild";
export type GraphStaleReason = "parent-advanced" | "worktree-dirty" | "base-rebuilt" | "validation-failed" | "version-changed" | "missing-runtime";

export interface GraphTarget {
	projectId: string;
	component: string;
	/** Server-derived worktree identity; it is never used as a filesystem path here. */
	worktreeId: string;
	goalId?: string;
	parentGoalId?: string;
	primaryRef?: string;
}

export interface GraphChangeSet {
	head?: string;
	parentHeadRev?: string;
	/** Git name-status fingerprint; a path-derived fallback is used when absent. */
	fingerprint?: string;
	changedPaths?: readonly string[];
	dirtyPaths?: readonly string[];
}

export interface GraphStatus {
	state: "fresh" | "building" | "stale" | "failed" | "base-fallback";
	component?: string;
	headRev?: string;
	staleReason?: GraphStaleReason;
}

export interface GraphJob {
	key: string;
	operation: GraphOperation;
	target: GraphTarget;
	primaryHead?: string;
	head?: string;
	parentHeadRev?: string;
	changedPaths: string[];
	dirtyPaths: string[];
	noCluster: boolean;
	enqueuedAt: number;
}

export interface GraphClock { now(): number }
export interface GraphRuntimePort<Context = unknown> {
	resolveTargets(context: Context): Promise<readonly GraphTarget[]>;
	/** Resolves a primary ref without building; return null when no ref is available. */
	observePrimary?(target: GraphTarget): Promise<string | null>;
	/** The only git/diff seam. It must return promptly and never write a checkout. */
	inspectChanges?(target: GraphTarget, context: Context): Promise<GraphChangeSet | null>;
	/** Status is a declared read; session setup must not schedule work. */
	readStatus?(target: GraphTarget): Promise<GraphStatus | null>;
	/** Runs off-hook and performs clone/delta/validation/publication. */
	execute(job: GraphJob): Promise<void>;
	markStale?(target: GraphTarget, reason: GraphStaleReason): Promise<void>;
	recordFailure?(target: GraphTarget | null, operation: GraphOperation | "hook", error: unknown): Promise<void>;
}

export interface GraphRuntimeOptions {
	clock?: GraphClock;
	debounceMs?: number;
	basePublishFloorMs?: number;
	maxConcurrency?: number;
	orientationChars?: number;
}

export interface GraphContext { projectId?: string; goalId?: string; cwd?: string; [key: string]: unknown }
export interface GraphContextBlock { id: string; title: string; authority: "generic"; priority: number; reason: string; content: string }
export interface GraphHookResult { blocks: GraphContextBlock[] }

const SYSTEM_CLOCK: GraphClock = { now: () => Date.now() };
const DEFAULT_DEBOUNCE_MS = 1_000;
const DEFAULT_BASE_FLOOR_MS = 5 * 60_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_ORIENTATION_CHARS = 800;

interface QueuedJob extends GraphJob { dueAt: number; sequence: number }

/**
 * Deterministic, in-memory queue coordinator. Durable status and publication
 * are delegated to the port; restarting it therefore cannot replace last-good
 * data. `tick()` is public both for host timers and injected-clock tests.
 */
export class GraphRuntime<Context = GraphContext> {
	private readonly clock: GraphClock;
	private readonly debounceMs: number;
	private readonly basePublishFloorMs: number;
	private readonly maxConcurrency: number;
	private readonly orientationChars: number;
	private readonly queued = new Map<string, QueuedJob>();
	private readonly running = new Set<string>();
	private readonly provisioned = new Set<string>();
	private readonly observedPrimary = new Map<string, string>();
	private readonly completedBaseAt = new Map<string, number>();
	private readonly observedParent = new Map<string, string>();
	private readonly observedChanges = new Map<string, string>();
	private sequence = 0;

	constructor(private readonly port: GraphRuntimePort<Context>, options: GraphRuntimeOptions = {}) {
		this.clock = options.clock ?? SYSTEM_CLOCK;
		this.debounceMs = positiveInteger(options.debounceMs, DEFAULT_DEBOUNCE_MS, "debounceMs");
		this.basePublishFloorMs = positiveInteger(options.basePublishFloorMs, DEFAULT_BASE_FLOOR_MS, "basePublishFloorMs");
		this.maxConcurrency = positiveInteger(options.maxConcurrency, DEFAULT_CONCURRENCY, "maxConcurrency");
		this.orientationChars = positiveInteger(options.orientationChars, DEFAULT_ORIENTATION_CHARS, "orientationChars");
	}

	/** Cheap clone-or-enqueue bookkeeping only; never waits for Graphify work. */
	async goalProvisioned(context: Context): Promise<GraphHookResult> {
		return this.nonFatal("provision", async () => {
			const targets = await this.port.resolveTargets(context);
			for (const target of targets) {
				await this.observePrimary(target);
				const key = scopeKey(target);
				if (!this.provisioned.has(key)) {
					this.provisioned.add(key);
					this.enqueue("provision", target);
				}
			}
			this.tick();
			return emptyResult();
		});
	}

	/** Reads declared status and returns a bounded orientation; it never queues. */
	async sessionSetup(context: Context): Promise<GraphHookResult> {
		return this.nonFatal("hook", async () => {
			if (!this.port.readStatus) return emptyResult();
			const targets = await this.port.resolveTargets(context);
			const blocks: GraphContextBlock[] = [];
			for (const target of targets) {
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
					content: truncate(`${state}: ${detail || "graph index available"}. Results are leads; verify source before acting.`, this.orientationChars),
				});
			}
			return { blocks };
		});
	}

	/** Debounces committed and dirty deltas. Graphify execution stays off-hook. */
	async afterTurn(context: Context): Promise<GraphHookResult> {
		return this.nonFatal("delta", async () => {
			const targets = await this.port.resolveTargets(context);
			for (const target of targets) {
				await this.observePrimary(target);
				if (!this.port.inspectChanges) continue;
				const changes = await this.port.inspectChanges(target, context);
				if (!changes) continue;
				const parentAdvanced = await this.observeParent(target, changes.parentHeadRev);
				const changedPaths = sortedUnique(changes.changedPaths);
				const dirtyPaths = sortedUnique(changes.dirtyPaths);
				const fingerprint = changes.fingerprint ?? `${changes.head ?? ""}\u0000${changedPaths.join("\u0001")}\u0000${dirtyPaths.join("\u0001")}`;
				const changeKey = scopeKey(target);
				if ((parentAdvanced || changedPaths.length || dirtyPaths.length || changes.head) && (parentAdvanced || this.observedChanges.get(changeKey) !== fingerprint)) {
					this.observedChanges.set(changeKey, fingerprint);
					this.enqueue("delta", target, { head: changes.head, parentHeadRev: changes.parentHeadRev, changedPaths, dirtyPaths }, this.clock.now() + this.debounceMs);
				}
			}
			this.tick();
			return emptyResult();
		});
	}

	/** Route-facing bounded manual rebuild uses the same queue and worker path. */
	async rebuild(context: Context): Promise<void> {
		await this.nonFatal("manual-rebuild", async () => {
			for (const target of await this.port.resolveTargets(context)) this.enqueue("manual-rebuild", target);
			this.tick();
			return emptyResult();
		});
	}

	/** Attempt due jobs; callers may invoke this after advancing an injected clock. */
	tick(): void {
		while (this.running.size < this.maxConcurrency) {
			const next = this.nextRunnable();
			if (!next) return;
			this.queued.delete(next.key);
			this.running.add(next.key);
			void this.run(next);
		}
	}

	/** Observable queue state for data-declared status and deterministic tests. */
	status(): { queued: number; running: number; jobs: Array<Pick<GraphJob, "key" | "operation" | "target">> } {
		return { queued: this.queued.size, running: this.running.size, jobs: [...this.queued.values()].sort(bySequence).map(job => ({ key: job.key, operation: job.operation, target: { ...job.target } })) };
	}

	private async observePrimary(target: GraphTarget): Promise<void> {
		if (!this.port.observePrimary) return;
		const head = await this.port.observePrimary(target);
		if (!head) return;
		const componentKey = primaryKey(target);
		const prior = this.observedPrimary.get(componentKey);
		this.observedPrimary.set(componentKey, head);
		if (prior !== head) this.enqueue("base-rebuild", target, { primaryHead: head });
	}

	private async observeParent(target: GraphTarget, parentHeadRev: string | undefined): Promise<boolean> {
		if (!parentHeadRev || !target.parentGoalId) return false;
		const key = scopeKey(target);
		const prior = this.observedParent.get(key);
		this.observedParent.set(key, parentHeadRev);
		if (!prior || prior === parentHeadRev) return false;
		try { await this.port.markStale?.(target, "parent-advanced"); }
		catch (error) { await this.recordFailure(target, "hook", error); }
		return true;
	}

	private enqueue(operation: GraphOperation, target: GraphTarget, patch: Partial<GraphJob> = {}, dueAt = this.clock.now()): void {
		const key = jobKey(operation, target);
		const previous = this.queued.get(key);
		const merged: QueuedJob = {
			key,
			operation,
			target: { ...target },
			primaryHead: patch.primaryHead ?? previous?.primaryHead,
			head: patch.head ?? previous?.head,
			parentHeadRev: patch.parentHeadRev ?? previous?.parentHeadRev,
			changedPaths: sortedUnique([...(previous?.changedPaths ?? []), ...(patch.changedPaths ?? [])]),
			dirtyPaths: sortedUnique([...(previous?.dirtyPaths ?? []), ...(patch.dirtyPaths ?? [])]),
			noCluster: operation === "delta",
			enqueuedAt: previous?.enqueuedAt ?? this.clock.now(),
			dueAt: operation === "delta" ? Math.max(previous?.dueAt ?? 0, dueAt) : dueAt,
			sequence: previous?.sequence ?? this.sequence++,
		};
		this.queued.set(key, merged);
	}

	private nextRunnable(): QueuedJob | null {
		const now = this.clock.now();
		for (const job of [...this.queued.values()].sort(bySequence)) {
			if (job.dueAt > now) continue;
			if (job.operation === "base-rebuild") {
				const last = this.completedBaseAt.get(primaryKey(job.target));
				if (last !== undefined && now - last < this.basePublishFloorMs) continue;
			}
			return job;
		}
		return null;
	}

	private async run(job: QueuedJob): Promise<void> {
		try {
			await this.port.execute(freezeJob(job));
			if (job.operation === "base-rebuild") this.completedBaseAt.set(primaryKey(job.target), this.clock.now());
		} catch (error) {
			await this.recordFailure(job.target, job.operation, error);
		} finally {
			this.running.delete(job.key);
			this.tick();
		}
	}

	private async nonFatal(operation: GraphOperation | "hook", work: () => Promise<GraphHookResult>): Promise<GraphHookResult> {
		try { return await work(); }
		catch (error) { await this.recordFailure(null, operation, error); return emptyResult(); }
	}
	private async recordFailure(target: GraphTarget | null, operation: GraphOperation | "hook", error: unknown): Promise<void> {
		try { await this.port.recordFailure?.(target, operation, error); } catch { /* optional diagnostics cannot break hooks */ }
	}
}

function emptyResult(): GraphHookResult { return { blocks: [] }; }
function sortedUnique(values: readonly string[] | undefined): string[] { return [...new Set((values ?? []).filter(path => typeof path === "string" && path.length > 0))].sort(); }
function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
	return value;
}
function scopeKey(target: GraphTarget): string { return `${target.projectId}\u0000${target.component}\u0000${target.goalId ?? ""}\u0000${target.worktreeId}`; }
function primaryKey(target: GraphTarget): string { return `${target.projectId}\u0000${target.component}`; }
function jobKey(operation: GraphOperation, target: GraphTarget): string { return operation === "base-rebuild" ? `${primaryKey(target)}\u0000${operation}` : `${scopeKey(target)}\u0000${operation}`; }
function bySequence(a: QueuedJob, b: QueuedJob): number { return a.sequence - b.sequence; }
function safeId(value: string): string { return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "component"; }
function truncate(value: string, cap: number): string { return value.length <= cap ? value : `${value.slice(0, Math.max(0, cap - 1))}…`; }
function freezeJob(job: QueuedJob): GraphJob {
	return { ...job, target: { ...job.target }, changedPaths: [...job.changedPaths], dirtyPaths: [...job.dirtyPaths] };
}

// ── Host facade ────────────────────────────────────────────────────────────
//
// ModuleHost invokes providers/routes in fresh confined workers. This facade is
// deliberately composed only from pack-owned host storage and the scheduler's
// narrow port: neither lifecycle contexts nor tool calls can nominate a graph
// path, host root, or pack identity. The durable GraphStore remains the source
// of truth when a worker is replaced between calls.

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
	queue: ReturnType<GraphRuntime<GraphRuntimeFacadeContext>["status"]>;
	noCrossRepoEdges: true;
	warning: "v1 has no cross-repo edges";
	warnings: string[];
}

/** The real host-side bridge used by generic providers, routes, and tools.
 * It intentionally returns graph data, never GraphStore paths. */
export class GraphRuntimeFacade {
	private readonly scheduler: GraphRuntime<GraphRuntimeFacadeContext>;
	private readonly failures: string[] = [];

	constructor(private readonly store: GraphStore) {
		this.scheduler = new GraphRuntime<GraphRuntimeFacadeContext>({
			resolveTargets: async context => targetsFor(context, this.store.projectKey),
			readStatus: async target => this.readStatus(target),
			// The executable Graphify adapter is injected by the runtime owner when it
			// is available. A missing host adapter is an explicit declared condition,
			// never an in-checkout fallback build.
			execute: async () => { throw new Error("Graphify runtime is not configured on this host"); },
			recordFailure: async (_target, operation, error) => {
				const detail = error instanceof Error ? error.message : String(error);
				this.failures.push(`${operation}: ${detail}`.slice(0, 500));
				if (this.failures.length > 20) this.failures.shift();
			},
		});
	}

	goalProvisioned(context: GraphRuntimeFacadeContext): Promise<GraphHookResult> { return this.scheduler.goalProvisioned(context); }
	sessionSetup(context: GraphRuntimeFacadeContext): Promise<GraphHookResult> { return this.scheduler.sessionSetup(context); }
	afterTurn(context: GraphRuntimeFacadeContext): Promise<GraphHookResult> { return this.scheduler.afterTurn(context); }

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
			queue: this.scheduler.status(),
			noCrossRepoEdges: true,
			warning: "v1 has no cross-repo edges",
			warnings: this.failures.length ? [...this.failures] : ["Graphify runtime is unavailable; no graph is published."],
		};
	}

	async config(_context: GraphRuntimeFacadeContext): Promise<Record<string, unknown>> {
		return {
			readOnly: true,
			storage: "host-only",
			defaultTiers: ["code"],
			docsOptIn: "graph_query.includeDocs",
			noCrossRepoEdges: true,
			warning: "v1 has no cross-repo edges",
		};
	}

	async rebuild(context: GraphRuntimeFacadeContext, _request: { source?: "manual"; components?: readonly string[] } = {}): Promise<{ queued: true; status: GraphRuntimeStatus }> {
		await this.scheduler.rebuild(context);
		return { queued: true, status: await this.status(context) };
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
			component: { ...meta.component },
			revisions: { ...meta.revisions },
			state: meta.state,
			...(meta.staleReason ? { staleReason: meta.staleReason } : {}),
			graph: await this.readGraph(snapshot, meta),
		};
	}

	private async readGraph(snapshot: GraphSnapshot, meta: GraphMeta): Promise<GraphComponentGraph> {
		// Graphify result layouts vary by exact supported release. Only two
		// pack-owned, candidate-relative names are considered; malformed data is
		// treated as unavailable rather than exposing an artifact location/error.
		for (const relative of ["graph.json", "data/graph.json"]) {
			try {
				const file = await this.store.artifactPath(snapshot, relative);
				return graphFromUnknown(JSON.parse(await fs.readFile(file, "utf8")), meta);
			} catch { /* try the next known, host-only artifact name */ }
		}
		return { nodes: [], edges: [] };
	}
}

const facadeCache = new Map<string, GraphRuntimeFacade>();

/** Resolve a runtime only from server-derived context. It is safe for routes and
 * providers to call on every confined invocation: state lives in GraphStore. */
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
		component,
		worktreeId: context.worktreeId || context.goalId || fallbackWorktree,
		...(context.goalId ? { goalId: context.goalId } : {}),
		...(context.branch ? { primaryRef: context.branch } : {}),
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
	for (const key of ["maxDepth", "maxResults", "maxNodes", "maxEdges", "maxSnippets"] as const) {
		if (request[key] !== undefined) out[key] = request[key];
	}
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
		return typeof edge.from === "string" && typeof edge.to === "string" && ids.has(edge.from) && ids.has(edge.to)
			? [{ from: edge.from, to: edge.to, ...(typeof edge.type === "string" ? { type: edge.type } : {}) }]
			: [];
	});
	return { nodes, edges };
}
function safeRelative(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\0")) return undefined;
	const normal = value.replace(/\\/g, "/").replace(/^\.\//, "");
	return normal.split("/").some(part => !part || part === "." || part === "..") ? undefined : normal;
}
