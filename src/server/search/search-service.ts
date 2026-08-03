/**
 * Per-project asynchronous facade for the search worker. The gateway only
 * forwards structured data; FlexSearch, chunking, hashing, mirror I/O and query
 * execution live in `search-worker.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import type { PersistedGoal, GoalStore } from "../agent/goal-store.js";
import type { PersistedSession, SessionStore } from "../agent/session-store.js";
import type { PersistedStaff, StaffStore } from "../agent/staff-store.js";
import type { SearchResults } from "./types.js";
import { FLEX_VERSION } from "./constants.js";
import type { FlexSearchStore } from "./flex-store.js";
import { progressBus as sharedProgressBus, type ProgressBus } from "./progress-bus.js";

export type SearchServiceState = "initializing" | "ready" | "disabled" | "closed";
export interface SearchServiceOptions { stateDir: string; projectId: string; progressBus?: ProgressBus; staffStore?: StaffStore; }
type WorkerResponse = { kind: "response"; id: number; ok: boolean; value?: unknown; error?: string };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
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
	async close(): Promise<void> {
		if (this._state === "closed") return;
		this._state = "closed";
		if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
		this._rebuildTimer = null;
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
		// These obsolete native stores are removed asynchronously before the worker
		// is ever needed. Do not initialise a search worker at project startup.
		await Promise.all(["search.lance", "search.db", "search.db-wal", "search.db-shm"].map((name) => fs.promises.rm(path.join(this.stateDir, name), { recursive: name === "search.lance", force: true }).catch(() => undefined)));
		if (this._state !== "closed") this._state = "ready";
	}
	private _workerUrl(): URL { const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js"; return new URL(`./search-worker${ext}`, import.meta.url); }
	private async _ensureWorker(): Promise<void> {
		if (this._workerStart) return this._workerStart;
		this._workerStart = new Promise<void>((resolve, reject) => {
			const worker = new Worker(this._workerUrl(), { execArgv: workerExecArgv(process.execArgv) }); this._worker = worker;
			worker.on("message", (msg: WorkerResponse | { kind: "event"; event: any; payload: any }) => {
				if (msg.kind === "event") { this.progressBus.emit(msg.event, msg.payload); return; }
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
		const task = previous.catch(() => undefined).then(() => this._call(command, payload)).catch((err) => console.warn(`[search] ${command} failed:`, err)).finally(() => { this._pendingMutations--; if (key && this._sessionChains.get(key) === task) this._sessionChains.delete(key); });
		if (key) this._sessionChains.set(key, task);
	}
	private _scheduleStartupRebuild(): void {
		const c = this._context, staff = c?.staffStore ?? this.staffStore; if (!c?.goalStore || !c.sessionStore || !staff || this._rebuildTimer) return;
		const timer = setTimeout(() => { this._rebuildTimer = null; void this.rebuildFromStores(c.goalStore!, c.sessionStore!, undefined, staff).catch((err) => console.warn("[search] background rebuild failed:", err)); }, Number(process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS ?? 5000));
		timer.unref?.(); this._rebuildTimer = timer;
	}
}
function workerExecArgv(argv: readonly string[]): string[] { const safe = new Set(["--require", "-r", "--import", "--loader", "--experimental-loader", "--conditions", "-C"]); const out: string[] = []; for (let i = 0; i < argv.length; i++) { const flag = argv[i], name = flag.split("=", 1)[0]; if (!safe.has(name)) continue; out.push(flag); if (!flag.includes("=") && argv[i + 1] && !argv[i + 1].startsWith("-")) out.push(argv[++i]); } return out; }
