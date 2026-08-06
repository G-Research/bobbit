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
