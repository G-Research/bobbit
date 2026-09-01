/**
 * Per-project asynchronous facade for the search worker. The gateway only
 * forwards structured data; FlexSearch, chunking, hashing, mirror I/O and query
 * execution live in `search-worker.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { PersistedGoal, GoalStore } from "../agent/goal-store.js";
import type { PersistedSession, SessionStore } from "../agent/session-store.js";
import type { PersistedStaff, StaffStore } from "../agent/staff-store.js";
import type { SearchResults } from "./types.js";
import { FLEX_VERSION } from "./constants.js";
import type { FlexSearchStore } from "./flex-store.js";
import { getCpuDiagnostics } from "../agent/cpu-diagnostics.js";
import { progressBus as sharedProgressBus, type ProgressBus } from "./progress-bus.js";

export type SearchServiceState = "initializing" | "ready" | "disabled" | "closed";
export interface SearchServiceOptions { stateDir: string; projectId: string; progressBus?: ProgressBus; staffStore?: StaffStore; }
type WorkerResponse = { kind: "response"; id: number; ok: boolean; value?: unknown; error?: string };
type WorkerMetric = { kind: "metric"; label: string; durationMs: number; bytes: number; phase: "serialize" | "write" };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; bytes: number };
type LiveIndexEntities = { goalIds: string[]; sessionIds: string[]; staffIds: string[] };
export type OrphanedIndexRow = { id: string; source_id: string; parent_id: string | null };

/** A query cannot safely return partial results while its durable mirror recovers. */
export class SearchUnavailableError extends Error {
	readonly code = "SEARCH_UNAVAILABLE";
	constructor(readonly reason: "closed" | "initializing" | "rebuilding" | "degraded" | "backpressure" | "worker-backoff") {
		super(`Search unavailable: ${reason}`);
		this.name = "SearchUnavailableError";
	}
}

const MAX_PENDING_MUTATIONS = 1_000;
const MAX_PENDING_MUTATION_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_RPCS = 1_024;
const MAX_PENDING_RPC_BYTES = 16 * 1024 * 1024;
const WORKER_RESTART_BASE_MS = 1_000;
const WORKER_RESTART_MAX_MS = 60_000;

export class SearchService {
	readonly stateDir: string;
	readonly projectId: string;
	readonly dataDir: string;
	staffStore?: StaffStore;
	private readonly progressBus: ProgressBus;
	private _state: SearchServiceState = "initializing";
	private _worker: Worker | null = null;
	private _workerStart: Promise<void> | null = null;
	private _nextId = 1;
	private readonly _pending = new Map<number, Pending>();
	private _pendingRpcBytes = 0;
	private _pendingMutations = 0;
	private _pendingMutationBytes = 0;
	private _workerHadMutations = false;
	private _workerFailures = 0;
	private _nextWorkerStartAt = 0;
	private _degraded = false;
	private _degradedReason: SearchUnavailableError["reason"] | null = null;
	private _dirtyGeneration = 0;
	private _openPromise: Promise<void> | null = null;
	private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
	private _rebuildInFlight: Promise<void> | null = null;
	private _context?: { goalStore?: GoalStore; sessionStore?: SessionStore; staffStore?: StaffStore };
	private readonly _sessionChains = new Map<string, Promise<void>>();
	/** All fire-and-forget mutation RPCs, awaited only during graceful shutdown. */
	private readonly _mutationTasks = new Set<Promise<void>>();

	constructor(opts: SearchServiceOptions) {
		this.stateDir = opts.stateDir; this.projectId = opts.projectId;
		this.dataDir = path.join(opts.stateDir, "search.flex");
		this.progressBus = opts.progressBus ?? sharedProgressBus; this.staffStore = opts.staffStore;
	}
	getState(): SearchServiceState { return this._state; }
	/** The index lives in a worker and intentionally has no synchronous store handle. */
	getStore(): FlexSearchStore | null { return null; }
	/**
	 * Worker-RPC fixture seam for integration tests that need rows no source
	 * can create (for example, a deliberately orphaned legacy row). Raw docs
	 * are prepared and indexed exclusively in the worker.
	 */
	async injectDocumentsForTest(docs: unknown[]): Promise<void> {
		if (this._state !== "ready") throw new Error("search service unavailable");
		await this._call("injectDocuments", { docs });
	}
	/** Worker-RPC companion to injectDocumentsForTest for fixture cleanup. */
	async deleteDocumentsForTest(ids: string[]): Promise<void> {
		if (this._state !== "ready") throw new Error("search service unavailable");
		await this._call("deleteDocuments", { ids });
	}
	getEngineInfo() { return { engine: "flexsearch", engineVersion: FLEX_VERSION }; }
	open(context?: { goalStore?: GoalStore; sessionStore?: SessionStore; staffStore?: StaffStore }): void {
		if (this._openPromise) return;
		this._context = context;
		this._openPromise = this._doOpen();
	}
	async whenReady(): Promise<void> { await this._openPromise; }
	/** True while a worker-open recovery still requires a full source rebuild. */
	needsRebuild(): boolean { return this._degraded && this._degradedReason === "rebuilding"; }

	async getStats(): Promise<{ state: SearchServiceState; engine: string; engineVersion: string; lastRebuildAt: number | null; rowCountsBySource: { goals: number; sessions: number; messages: number; staff: number; files: number }; datasetBytes: number; degraded: boolean; unavailableReason: string | null }> {
		const empty = { goals: 0, sessions: 0, messages: 0, staff: 0, files: 0 };
		const base = () => ({ state: this._state, engine: "flexsearch", engineVersion: FLEX_VERSION, lastRebuildAt: null, rowCountsBySource: empty, datasetBytes: 0, degraded: this._degraded, unavailableReason: this._degradedReason });
		// Stats are an observation, not an activation. A project that has never
		// searched or indexed must not pay worker startup or mirror I/O merely for
		// rendering its maintenance page.
		if (this._state !== "ready" || this._degraded || (!this._worker && !this._workerStart)) return base();
		try {
			await this._ensureQueryableWorker();
			return { ...base(), ...(await this._post("stats")) as Omit<ReturnType<typeof base>, "state" | "engine" | "engineVersion"> };
		} catch { return base(); }
	}
	async compact(): Promise<void> { if (this._state === "ready") await this._call("compact"); }
	/** Find stale rows entirely in the search worker; callers only supply live IDs. */
	async findOrphanedRows(live: LiveIndexEntities): Promise<OrphanedIndexRow[]> {
		if (this._state !== "ready") throw new Error("search service unavailable");
		await this._ensureQueryableWorker();
		return this._post("findOrphanedRows", live);
	}
	/** Remove stale rows entirely in the search worker; returns the deleted count. */
	async cleanupOrphanedRows(live: LiveIndexEntities): Promise<number> {
		if (this._state !== "ready") throw new Error("search service unavailable");
		await this._ensureQueryableWorker();
		return this._post("cleanupOrphanedRows", live);
	}
	async close(): Promise<void> {
		if (this._state === "closed") return;
		this._state = "closed";
		if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
		this._rebuildTimer = null;
		this._sessionChains.clear();
		// Do not terminate a worker while queued fire-and-forget ingest still owns
		// mirror mutations. This is the only point those tasks become awaited.
		await Promise.allSettled([...this._mutationTasks]);
		const worker = this._worker;
		try { if (worker) await this._call("close"); } catch { /* worker is disposable cache machinery */ }
		for (const pending of this._pending.values()) pending.reject(new Error("search service closed"));
		this._pending.clear(); this._workerStart = null; this._worker = null;
		if (worker) await worker.terminate();
	}

	indexGoal(goal: PersistedGoal, projectId?: string): void { this._mutate("indexGoal", { goal, projectId }); }
	removeGoal(goalId: string): void { this._mutate("removeGoal", { goalId }); }
	indexSession(session: PersistedSession, goalTitle?: string, projectId?: string): void { this._mutate("indexSession", { session, goalTitle, projectId }); }
	removeSession(sessionId: string): void { this._mutate("removeSession", { sessionId }, `messages:${sessionId}`); }
	removeMessagesForSession(sessionId: string): void { this._mutate("removeMessages", { sessionId }, `messages:${sessionId}`); }
	reindexMessagesForSession(session: PersistedSession, goalTitle?: string, projectId?: string): void { this._mutate("reindexMessages", { session, goalTitle, projectId }, `messages:${session.id}`); }
	indexStaff(staff: PersistedStaff, projectId?: string): void { this._mutate("indexStaff", { staff, projectId }); }
	removeStaff(staffId: string): void { this._mutate("removeStaff", { staffId }); }
	indexMessage(arg: { sessionId: string; sessionTitle: string; message: unknown; timestamp: number; projectId?: string; msgIdx?: number; goalId?: string; goalTitle?: string }): void;
	indexMessage(sessionId: string, sessionTitle: string, text: string, toolNames: string[], timestamp: number, projectId?: string): void;
	indexMessage(arg1: any, sessionTitle?: string, text?: string, _toolNames?: string[], timestamp?: number, projectId?: string): void {
		const payload = typeof arg1 === "string" ? { sessionId: arg1, sessionTitle, text, timestamp, projectId } : arg1;
		this._mutate("indexMessage", payload, `messages:${payload.sessionId}`);
	}
	search(query: string, opts: { type?: "all" | "goals" | "sessions" | "messages" | "staff"; limit?: number; offset?: number; projectId?: string; projectNames?: Map<string, string>; includeArchived?: boolean } = {}): Promise<SearchResults> {
		if (this._state !== "ready") return Promise.reject(new SearchUnavailableError(this._state === "closed" ? "closed" : "initializing"));
		if (this._degraded) {
			this._scheduleRecoveryRebuild();
			return Promise.reject(new SearchUnavailableError(this._degradedReason ?? "degraded"));
		}
		const types = !opts.type || opts.type === "all" ? undefined : [opts.type];
		const payload = { q: query, limit: opts.limit, offset: opts.offset, projectId: opts.projectId, types, includeArchived: opts.includeArchived ?? false };
		// Starting a lazy worker may discover an incomplete mirror. Re-check after
		// startup and before posting the query, otherwise this first request races
		// the recovery fence established by `_ensureWorker()`.
		return this._ensureQueryableWorker().then(() => this._post("search", payload)).then((result: SearchResults) => {
			if (opts.projectNames) for (const row of result.results) if (row.projectId) row.projectName = opts.projectNames.get(row.projectId);
			return result;
		});
	}
	async rebuildFromStores(goalStore: GoalStore, sessionStore: SessionStore, _sessionsDir?: string, staffStore?: StaffStore): Promise<void> {
		await this.rebuildFromSources(goalStore, sessionStore, staffStore ?? this.staffStore);
	}
	async rebuildFromSources(goalStore: GoalStore, sessionStore: SessionStore, staffStore?: StaffStore, _sources?: unknown[]): Promise<void> {
		if (this._state !== "ready") return;
		// A full source rebuild is the sole authority that may make a recovered
		// mirror queryable again. Starting the lazy worker can itself discover an
		// incomplete mirror, so capture the generation only after startup.
		await this._ensureWorker();
		const generation = this._dirtyGeneration;
		await this._post("rebuild", { goals: goalStore.getAll(), sessions: sessionStore.getAll(), staff: staffStore?.getAll() ?? [] });
		this._completeRecoveryGeneration(generation);
	}

	private async _doOpen(): Promise<void> {
		// Do not initialise the worker at project startup. It owns legacy cache
		// cleanup when first started, keeping all search persistence off this loop.
		if (this._state !== "closed") this._state = "ready";
	}
	private _workerUrl(): URL {
		// Tier-1 Vitest runs TypeScript through its prebundled ESM artifacts, not
		// a Node TypeScript loader. The manifest gives the worker its matching
		// prebundled entry, including every relative `.js` → `.ts` resolution.
		// Production has no such environment variable and always uses the compiled
		// sibling, so Docker and sandbox layouts remain path-independent.
		const testWorker = testPrebundledWorkerUrl(process.env.BOBBIT_V2_SERVER_PREBUNDLE);
		if (testWorker) return testWorker;
		const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
		return new URL(`./search-worker${ext}`, import.meta.url);
	}
	private async _ensureWorker(): Promise<void> {
		if (this._workerStart) return this._workerStart;
		if (this._state === "closed") throw new SearchUnavailableError("closed");
		if (Date.now() < this._nextWorkerStartAt) throw new SearchUnavailableError("worker-backoff");
		const start = new Promise<void>((resolve, reject) => {
			let worker: Worker;
			try {
				worker = new Worker(this._workerUrl(), { execArgv: workerExecArgv(process.execArgv) });
			} catch (err) {
				this._recordWorkerFailure(err);
				reject(new SearchUnavailableError("worker-backoff"));
				return;
			}
			this._worker = worker;
			worker.on("message", (msg: WorkerResponse | WorkerMetric | { kind: "event"; event: any; payload: any }) => {
				if (msg.kind === "event") { this.progressBus.emit(msg.event, msg.payload); return; }
				if (msg.kind === "metric") {
					getCpuDiagnostics().recordPersistence(`search:${msg.label}:${msg.phase}`, msg.durationMs, msg.bytes);
					return;
				}
				const pending = this._pending.get(msg.id);
				if (!pending) return;
				this._pending.delete(msg.id);
				this._pendingRpcBytes -= pending.bytes;
				msg.ok ? pending.resolve(msg.value) : pending.reject(this._workerError(msg.error));
			});
			// This listener deliberately remains installed for the worker's entire
			// lifetime. An unhandled Worker "error" otherwise terminates the gateway.
			const failStart = (err: unknown): void => {
				this._handleWorkerFailure(worker, err);
				reject(new SearchUnavailableError("worker-backoff"));
			};
			worker.on("error", (err) => {
				console.warn("[search] worker error:", err);
				failStart(err);
			});
			worker.on("exit", (code) => {
				if (this._worker === worker) this._handleWorkerFailure(worker, new Error(`search worker exited (${code})`));
			});
			this._post("open", { dataDir: this.dataDir, projectId: this.projectId }).then((state: any) => {
				this._workerFailures = 0;
				this._nextWorkerStartAt = 0;
				this._workerHadMutations = false;
				// `FlexSearchStore.open()` can recover a missing, corrupt, or
				// version-mismatched mirror. Its rows are not authoritative until a
				// complete rebuild from the stores succeeds. Set this boundary before
				// resolving worker startup: otherwise the first search can race the
				// delayed rebuild and return stale/partial HTTP 200 results.
				if (state.needsRebuild) this._markDegraded("rebuilding", true);
				resolve();
			}, failStart);
		});
		this._workerStart = start;
		// A failed spawn/open must not poison lazy recovery forever. Retain the
		// failure timestamp for backoff, then allow one later attempt.
		void start.catch(() => { if (this._workerStart === start) this._workerStart = null; });
		return start;
	}
	private _call(command: string, payload?: unknown): Promise<any> { return this._ensureWorker().then(() => this._post(command, payload)); }
	private async _ensureQueryableWorker(): Promise<void> {
		await this._ensureWorker();
		if (this._degraded) {
			this._scheduleRecoveryRebuild();
			throw new SearchUnavailableError(this._degradedReason ?? "degraded");
		}
	}
	private _post(command: string, payload?: unknown): Promise<any> {
		const worker = this._worker;
		if (!worker) return Promise.reject(new SearchUnavailableError("worker-backoff"));
		const bytes = estimateRpcBytes(command, payload);
		if (this._pending.size >= MAX_PENDING_RPCS || bytes > MAX_PENDING_RPC_BYTES || this._pendingRpcBytes + bytes > MAX_PENDING_RPC_BYTES) {
			return Promise.reject(new SearchUnavailableError("backpressure"));
		}
		const id = this._nextId++;
		return new Promise((resolve, reject) => {
			this._pending.set(id, { resolve, reject, bytes });
			this._pendingRpcBytes += bytes;
			try { worker.postMessage({ id, command, payload }); }
			catch {
				this._pending.delete(id);
				this._pendingRpcBytes -= bytes;
				reject(new SearchUnavailableError("backpressure"));
			}
		});
	}
	private _mutate(command: string, payload: unknown, key?: string): void {
		if (this._state === "closed") return;
		const bytes = estimateRpcBytes(command, payload);
		if (this._pendingMutations >= MAX_PENDING_MUTATIONS || bytes > MAX_PENDING_MUTATION_BYTES || this._pendingMutationBytes + bytes > MAX_PENDING_MUTATION_BYTES) {
			console.warn("[search] worker ingest backlog saturated; scheduling authoritative recovery");
			this._markDegraded("backpressure");
			return;
		}
		this._pendingMutations++;
		this._pendingMutationBytes += bytes;
		const previous = key ? this._sessionChains.get(key) ?? Promise.resolve() : Promise.resolve();
		const task = previous.catch(() => undefined).then(() => {
			this._workerHadMutations = true;
			return this._call(command, payload);
		}).catch((err) => {
			this._markDegraded(err instanceof SearchUnavailableError ? err.reason : "degraded");
			console.warn(`[search] ${command} failed:`, err);
		}).finally(() => {
			this._pendingMutations--;
			this._pendingMutationBytes -= bytes;
			this._mutationTasks.delete(task);
			if (key && this._sessionChains.get(key) === task) this._sessionChains.delete(key);
		});
		this._mutationTasks.add(task);
		if (key) this._sessionChains.set(key, task);
	}
	private _workerError(message: string | undefined): Error {
		if (message?.startsWith("SEARCH_UNAVAILABLE:")) return new SearchUnavailableError("backpressure");
		return new Error(message ?? "search worker failed");
	}
	private _handleWorkerFailure(worker: Worker, err: unknown): void {
		if (this._worker !== worker) return;
		const hadMutations = this._workerHadMutations || this._pendingMutations > 0;
		this._worker = null;
		this._workerStart = null;
		this._recordWorkerFailure(err);
		for (const pending of this._pending.values()) pending.reject(new SearchUnavailableError("degraded"));
		this._pending.clear();
		this._pendingRpcBytes = 0;
		if (hadMutations) this._markDegraded("degraded");
		void worker.terminate().catch(() => undefined);
	}
	private _recordWorkerFailure(_err: unknown): void {
		this._workerFailures++;
		const delay = Math.min(WORKER_RESTART_MAX_MS, WORKER_RESTART_BASE_MS * 2 ** Math.min(this._workerFailures - 1, 6));
		this._nextWorkerStartAt = Date.now() + delay;
	}
	private _markDegraded(reason: SearchUnavailableError["reason"], startup = false): void {
		if (this._state !== "ready") return;
		this._degraded = true;
		this._degradedReason = reason;
		this._dirtyGeneration++;
		if (startup) this._scheduleStartupRebuild();
		else this._scheduleRecoveryRebuild();
	}
	private _completeRecoveryGeneration(generation: number): void {
		if (this._degraded && this._dirtyGeneration === generation) {
			this._degraded = false;
			this._degradedReason = null;
			// An explicit rebuild can finish before the low-priority startup timer.
			// It already rebuilt this generation authoritatively, so do not repeat it.
			if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
			this._rebuildTimer = null;
		}
	}
	private _scheduleStartupRebuild(): void {
		// Keep startup work low-priority, but the service has already entered the
		// explicit `rebuilding` unavailable generation before this timer runs.
		this._scheduleRebuild(Number(process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS ?? 5000), true);
	}
	private _scheduleRecoveryRebuild(): void {
		const backoff = Math.max(0, this._nextWorkerStartAt - Date.now());
		this._scheduleRebuild(Math.max(250, backoff), true);
	}
	private _scheduleRebuild(delay: number, recovery: boolean): void {
		const c = this._context, staff = c?.staffStore ?? this.staffStore;
		if (this._state !== "ready" || !c?.goalStore || !c.sessionStore || !staff || this._rebuildTimer || this._rebuildInFlight) return;
		const timer = setTimeout(() => {
			this._rebuildTimer = null;
			if (this._state !== "ready") return;
			const generation = this._dirtyGeneration;
			const task = this.rebuildFromStores(c.goalStore!, c.sessionStore!, undefined, staff);
			this._rebuildInFlight = task;
			void task.then(() => {
				if (!recovery) return;
				if (this._dirtyGeneration !== generation) this._scheduleRecoveryRebuild();
			}, (err) => {
				console.warn("[search] background rebuild failed:", err);
				if (recovery) this._scheduleRecoveryRebuild();
			}).finally(() => {
				if (this._rebuildInFlight === task) this._rebuildInFlight = null;
				if (recovery && this._degraded && !this._rebuildTimer) this._scheduleRecoveryRebuild();
			});
		}, delay);
		timer.unref?.();
		this._rebuildTimer = timer;
	}
}
/** Locate the separately bundled worker entry emitted by the Vitest server prebundle. */
function testPrebundledWorkerUrl(runtimeBundle: string | undefined): URL | null {
	if (!runtimeBundle) return null;
	try {
		// `runtimeBundle` is `<cache>/entries/tests/support/harnesses/shared/<runtime>.mjs`.
		const cacheDir = path.resolve(path.dirname(runtimeBundle), "../../../../..");
		const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "manifest.json"), "utf-8")) as {
			entries?: Record<string, string>;
		};
		const output = manifest.entries?.["src/server/search/search-worker.ts"];
		return typeof output === "string"
			? pathToFileURL(path.join(cacheDir, ...output.split("/")))
			: null;
	} catch {
		// A non-Vitest runtime must never depend on test artifacts. Its normal
		// compiled worker URL remains the only production path.
		return null;
	}
}

/**
 * Conservative, allocation-free payload accounting for worker backpressure.
 * `postMessage` clones the value itself; never JSON.stringify arbitrary message
 * content on the gateway merely to measure the queue.
 */
function estimateRpcBytes(command: string, payload: unknown): number {
	const seen = new Set<object>();
	const measure = (value: unknown, depth: number): number => {
		if (depth > 12 || value == null) return 8;
		if (typeof value === "string") return 8 + value.length * 2;
		if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return 16;
		if (typeof value !== "object") return 16;
		if (value instanceof ArrayBuffer) return value.byteLength;
		if (ArrayBuffer.isView(value)) return value.byteLength;
		if (seen.has(value)) return 8;
		seen.add(value);
		if (Array.isArray(value)) return 16 + value.reduce((total, item) => total + measure(item, depth + 1), 0);
		let total = 24;
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) total += key.length * 2 + measure(item, depth + 1);
		return total;
	};
	return command.length * 2 + measure(payload, 0);
}

function workerExecArgv(argv: readonly string[]): string[] { const safe = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader", "--conditions", "-C"]); const out: string[] = []; for (let i = 0; i < argv.length; i++) { const flag = argv[i], name = flag.split("=", 1)[0]; if (!safe.has(name)) continue; out.push(flag); if (!flag.includes("=") && argv[i + 1] && !argv[i + 1].startsWith("-")) out.push(argv[++i]); } return out; }
