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
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
type LiveIndexEntities = { goalIds: string[]; sessionIds: string[]; staffIds: string[] };
export type OrphanedIndexRow = { id: string; source_id: string; parent_id: string | null };
const MAX_PENDING_MUTATIONS = 1_000;

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
	private _pendingMutations = 0;
	private _openPromise: Promise<void> | null = null;
	private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;
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
	getEngineInfo() { return { engine: "flexsearch", engineVersion: FLEX_VERSION }; }
	open(context?: { goalStore?: GoalStore; sessionStore?: SessionStore; staffStore?: StaffStore }): void {
		if (this._openPromise) return;
		this._context = context;
		this._openPromise = this._doOpen();
	}
	async whenReady(): Promise<void> { await this._openPromise; }
	needsRebuild(): boolean { return false; }

	async getStats(): Promise<{ state: SearchServiceState; engine: string; engineVersion: string; lastRebuildAt: number | null; rowCountsBySource: { goals: number; sessions: number; messages: number; staff: number; files: number }; datasetBytes: number }> {
		const empty = { goals: 0, sessions: 0, messages: 0, staff: 0, files: 0 };
		const base = { state: this._state, engine: "flexsearch", engineVersion: FLEX_VERSION, lastRebuildAt: null, rowCountsBySource: empty, datasetBytes: 0 };
		if (this._state !== "ready") return base;
		try { return { ...base, ...(await this._call("stats")) as Omit<typeof base, "state" | "engine" | "engineVersion"> }; } catch { return base; }
	}
	async compact(): Promise<void> { if (this._state === "ready") await this._call("compact"); }
	/** Find stale rows entirely in the search worker; callers only supply live IDs. */
	async findOrphanedRows(live: LiveIndexEntities): Promise<OrphanedIndexRow[]> {
		if (this._state !== "ready") throw new Error("search service unavailable");
		return this._call("findOrphanedRows", live);
	}
	/** Remove stale rows entirely in the search worker; returns the deleted count. */
	async cleanupOrphanedRows(live: LiveIndexEntities): Promise<number> {
		if (this._state !== "ready") throw new Error("search service unavailable");
		return this._call("cleanupOrphanedRows", live);
	}
	async close(): Promise<void> {
		if (this._state === "closed") return;
		this._state = "closed";
		if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
		this._rebuildTimer = null;
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
		if (this._state !== "ready") return Promise.resolve({ results: [], total: 0 });
		const types = !opts.type || opts.type === "all" ? undefined : [opts.type];
		return this._call("search", { q: query, limit: opts.limit, offset: opts.offset, projectId: opts.projectId, types, includeArchived: opts.includeArchived ?? false }).then((result: SearchResults) => {
			if (opts.projectNames) for (const row of result.results) if (row.projectId) row.projectName = opts.projectNames.get(row.projectId);
			return result;
		});
	}
	async rebuildFromStores(goalStore: GoalStore, sessionStore: SessionStore, _sessionsDir?: string, staffStore?: StaffStore): Promise<void> {
		await this.rebuildFromSources(goalStore, sessionStore, staffStore ?? this.staffStore);
	}
	async rebuildFromSources(goalStore: GoalStore, sessionStore: SessionStore, staffStore?: StaffStore, _sources?: unknown[]): Promise<void> {
		if (this._state !== "ready") return;
		await this._call("rebuild", { goals: goalStore.getAll(), sessions: sessionStore.getAll(), staff: staffStore?.getAll() ?? [] });
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
		this._workerStart = new Promise<void>((resolve, reject) => {
			const worker = new Worker(this._workerUrl(), { execArgv: workerExecArgv(process.execArgv) }); this._worker = worker;
			worker.on("message", (msg: WorkerResponse | WorkerMetric | { kind: "event"; event: any; payload: any }) => {
				if (msg.kind === "event") { this.progressBus.emit(msg.event, msg.payload); return; }
				if (msg.kind === "metric") {
					// The expensive work happened in the worker. Recording its completed
					// duration here is constant-time and keeps the gateway diagnostics unified.
					getCpuDiagnostics().recordPersistence(`search:${msg.label}:${msg.phase}`, msg.durationMs, msg.bytes);
					return;
				}
				const pending = this._pending.get(msg.id); if (!pending) return; this._pending.delete(msg.id); msg.ok ? pending.resolve(msg.value) : pending.reject(new Error(msg.error ?? "search worker failed"));
			});
			worker.once("error", reject);
			worker.on("exit", (code) => { if (this._worker === worker) { this._worker = null; this._workerStart = null; for (const p of this._pending.values()) p.reject(new Error(`search worker exited (${code})`)); this._pending.clear(); } });
			this._post("open", { dataDir: this.dataDir, projectId: this.projectId }).then((state: any) => { worker.off("error", reject); if (state.needsRebuild) this._scheduleStartupRebuild(); resolve(); }, reject);
		});
		return this._workerStart;
	}
	private _call(command: string, payload?: unknown): Promise<any> { return this._ensureWorker().then(() => this._post(command, payload)); }
	private _post(command: string, payload?: unknown): Promise<any> {
		const worker = this._worker; if (!worker) return Promise.reject(new Error("search worker unavailable")); const id = this._nextId++;
		return new Promise((resolve, reject) => { this._pending.set(id, { resolve, reject }); worker.postMessage({ id, command, payload }); });
	}
	private _mutate(command: string, payload: unknown, key?: string): void {
		if (this._state === "closed" || this._pendingMutations >= MAX_PENDING_MUTATIONS) { if (this._pendingMutations >= MAX_PENDING_MUTATIONS) console.warn("[search] worker ingest backlog saturated; dropping derived update"); return; }
		this._pendingMutations++;
		const previous = key ? this._sessionChains.get(key) ?? Promise.resolve() : Promise.resolve();
		const task = previous.catch(() => undefined).then(() => this._call(command, payload)).catch((err) => console.warn(`[search] ${command} failed:`, err)).finally(() => { this._pendingMutations--; this._mutationTasks.delete(task); if (key && this._sessionChains.get(key) === task) this._sessionChains.delete(key); });
		this._mutationTasks.add(task);
		if (key) this._sessionChains.set(key, task);
	}
	private _scheduleStartupRebuild(): void {
		const c = this._context, staff = c?.staffStore ?? this.staffStore; if (!c?.goalStore || !c.sessionStore || !staff || this._rebuildTimer) return;
		const timer = setTimeout(() => { this._rebuildTimer = null; void this.rebuildFromStores(c.goalStore!, c.sessionStore!, undefined, staff).catch((err) => console.warn("[search] background rebuild failed:", err)); }, Number(process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS ?? 5000));
		timer.unref?.(); this._rebuildTimer = timer;
	}
}
/** Locate the separately bundled worker entry emitted by the Vitest server prebundle. */
function testPrebundledWorkerUrl(runtimeBundle: string | undefined): URL | null {
	if (!runtimeBundle) return null;
	try {
		// `runtimeBundle` is `<cache>/entries/tests2/harness/<runtime>.mjs`.
		const cacheDir = path.resolve(path.dirname(runtimeBundle), "../../..");
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

function workerExecArgv(argv: readonly string[]): string[] { const safe = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader", "--conditions", "-C"]); const out: string[] = []; for (let i = 0; i < argv.length; i++) { const flag = argv[i], name = flag.split("=", 1)[0]; if (!safe.has(name)) continue; out.push(flag); if (!flag.includes("=") && argv[i + 1] && !argv[i + 1].startsWith("-")) out.push(argv[++i]); } return out; }
