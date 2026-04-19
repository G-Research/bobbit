/**
 * `SearchService` — per-project facade over the LanceDB-backed semantic
 * search stack.
 *
 * Wraps the `LanceStore`, `Indexer`, `HybridQuery`, and four core
 * `IndexSource`s behind the same public surface the legacy
 * `SearchIndex` exposed (open/close/rebuildFromStores/indexX/removeX/
 * search) so the rest of the codebase migrates 1:1.
 *
 * State machine (design §11):
 *   "initializing"          -- open() kicked off, not ready
 *   "ready"                 -- LanceStore + Embedder OK
 *   "disabled-no-native"    -- LanceDB native binary failed to load
 *   "disabled-no-model"     -- Embedding model failed to load
 *   "closed"                -- close() called
 *
 * When state !== "ready" all index*\/remove* methods no-op (graceful
 * degradation); `search()` throws.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PersistedGoal, GoalStore } from "../agent/goal-store.js";
import type { PersistedSession, SessionStore } from "../agent/session-store.js";
import type { PersistedStaff, StaffStore } from "../agent/staff-store.js";
import type { Embedder, IndexSource, IndexSourceContext, SearchResults } from "./types.js";
import { LanceStore } from "./lance-store.js";
import { Indexer } from "./indexer.js";
import { HybridQuery } from "./hybrid-query.js";
import { NomicEmbedder, createFakeEmbedder } from "./embedder.js";
import { GoalIndexSource } from "./sources/goal-source.js";
import { SessionIndexSource } from "./sources/session-source.js";
import { MessageIndexSource } from "./sources/message-source.js";
import { StaffIndexSource } from "./sources/staff-source.js";
import { contentHashOf } from "./sources/hash.js";
import { progressBus as sharedProgressBus, type ProgressBus } from "./progress-bus.js";
import { needsRebuild as metaNeedsRebuild, buildCurrentMeta } from "./meta.js";
import { CONTENT_POLICY_VERSION, extractForIndexing } from "./content-policy.js";

// ── Types ────────────────────────────────────────────────────────────

export type SearchServiceState =
	| "initializing"
	| "ready"
	| "disabled-no-native"
	| "disabled-no-model"
	| "closed";

export interface SearchServiceOptions {
	stateDir: string;
	projectId: string;
	/** Override embedder. Defaults to `NomicEmbedder` with `<stateDir>/../models` as the cache dir. */
	embedder?: Embedder;
	/** Override progress bus (tests). Defaults to the shared singleton. */
	progressBus?: ProgressBus;
	/** Override staff store for rebuilds. Optional — can also be supplied to rebuildFromStores. */
	staffStore?: StaffStore;
}

// ── SearchService ───────────────────────────────────────────────────

export class SearchService {
	readonly stateDir: string;
	readonly projectId: string;
	readonly dataDir: string;

	private readonly embedder: Embedder;
	private readonly progressBus: ProgressBus;

	private _state: SearchServiceState = "initializing";
	private _store: LanceStore | null = null;
	private _indexer: Indexer | null = null;
	private _hybrid: HybridQuery | null = null;

	/** Optional staff store for rebuilds (matches legacy API). */
	staffStore?: StaffStore;

	/** Promise that resolves when open() finishes (for tests/callers that want to await). */
	private _openPromise: Promise<void> | null = null;

	// Sources (stateless — created once)
	private readonly _goalSource = new GoalIndexSource();
	private readonly _sessionSource = new SessionIndexSource();
	private readonly _messageSource = new MessageIndexSource();
	private readonly _staffSource = new StaffIndexSource();

	/**
	 * Shared model cache directory across all projects AND all Bobbit
	 * installs on this machine. Nomic's ~140MB ONNX files get downloaded
	 * once and reused everywhere. Respects $BOBBIT_MODEL_CACHE_DIR for
	 * tests / advanced users.
	 */
	static sharedModelCacheDir(): string {
		const override = process.env.BOBBIT_MODEL_CACHE_DIR;
		if (override && override.length > 0) return override;
		return path.join(os.homedir(), ".bobbit", "models");
	}

	/** Interval handle for the daily dataset-compaction timer. */
	private _compactTimer: ReturnType<typeof setInterval> | null = null;

	constructor(opts: SearchServiceOptions) {
		this.stateDir = opts.stateDir;
		this.projectId = opts.projectId;
		this.dataDir = path.join(opts.stateDir, "search.lance");
		this.embedder = opts.embedder
			?? (process.env.BOBBIT_FAKE_EMBEDDER === "1"
				? createFakeEmbedder()
				: new NomicEmbedder({
						modelCacheDir: SearchService.sharedModelCacheDir(),
					}));
		this.progressBus = opts.progressBus ?? sharedProgressBus;
		this.staffStore = opts.staffStore;
	}

	getState(): SearchServiceState {
		return this._state;
	}

	/** Internal access for admin/maintenance REST endpoints. */
	getLanceStore(): LanceStore | null {
		return this._store;
	}

	/** Embedder identity for stats endpoint. */
	getEmbedderInfo(): { id: string; dim: number } {
		return { id: this.embedder.id, dim: this.embedder.dim };
	}

	/**
	 * Per-source row counts + last rebuild timestamp for the stats endpoint.
	 * Returns `null` for fields that are unavailable in the current state.
	 */
	async getStats(): Promise<{
		state: SearchServiceState;
		embedderId: string;
		embedderDim: number;
		lastRebuildAt: number | null;
		rowCountsBySource: { goals: number; sessions: number; messages: number; staff: number };
		datasetBytes: number;
	}> {
		const info = this.getEmbedderInfo();
		const empty = { goals: 0, sessions: 0, messages: 0, staff: 0 };
		const base = {
			state: this._state,
			embedderId: info.id,
			embedderDim: info.dim,
			lastRebuildAt: null as number | null,
			rowCountsBySource: empty,
			datasetBytes: dirSizeBytes(this.dataDir),
		};
		if (!this._store) return base;
		try {
			const meta = await this._store.readMeta();
			const rowCountsBySource = {
				goals: await this._store.count("source_id = 'goals'"),
				sessions: await this._store.count("source_id = 'sessions'"),
				messages: await this._store.count("source_id = 'messages'"),
				staff: await this._store.count("source_id = 'staff'"),
			};
			return {
				...base,
				lastRebuildAt: meta?.createdAt ?? null,
				rowCountsBySource,
			};
		} catch {
			return base;
		}
	}

	/** Compact the Lance dataset (passthrough). No-op when not ready. */
	async compact(): Promise<void> {
		if (!this._store) return;
		await this._store.compact();
	}

	/** Interval in ms between scheduled dataset compactions. 24 hours. */
	private static readonly COMPACT_INTERVAL_MS = 24 * 60 * 60 * 1000;

	/**
	 * Kick off a background `setInterval` that compacts the dataset every
	 * 24 hours. `.unref()`'d so the timer never keeps the event loop alive.
	 * Exposed for tests via `getCompactIntervalMs()`.
	 */
	private _startScheduledCompaction(): void {
		if (this._compactTimer) return;
		this._compactTimer = setInterval(() => {
			void this.compact().catch((err) => {
				console.error("[search] Scheduled compact failed:", err);
			});
		}, SearchService.COMPACT_INTERVAL_MS);
		if (typeof this._compactTimer.unref === "function") {
			this._compactTimer.unref();
		}
	}

	/**
	 * Kick off async initialization. Returns synchronously — callers that
	 * want to wait can `await service.whenReady()`.
	 *
	 * Behavior (design §10, §11):
	 *   1. Try to open LanceStore. On failure → "disabled-no-native".
	 *   2. Try `embedder.ready()`. On failure → "disabled-no-model".
	 *   3. Read meta; if mismatched/missing, kick off background rebuild.
	 *   4. State becomes "ready".
	 */
	open(
		context?: { goalStore?: GoalStore; sessionStore?: SessionStore; staffStore?: StaffStore },
	): void {
		if (this._openPromise) return;
		this._openPromise = this._doOpen(context);
	}

	/** Await the in-flight open() (or previous completion). */
	async whenReady(): Promise<void> {
		if (this._openPromise) await this._openPromise;
	}

	/**
	 * Legacy-compat check — always returns false. The new stack handles
	 * rebuild decisions internally via meta mismatch; callers do not need
	 * to call `rebuildFromStores` explicitly after open().
	 */
	needsRebuild(): boolean {
		return false;
	}

	/** Close — idempotent, safe to call from shutdown paths. */
	async close(): Promise<void> {
		this._state = "closed";
		if (this._compactTimer) {
			clearInterval(this._compactTimer);
			this._compactTimer = null;
		}
		if (this._store) {
			try {
				await this._store.close();
			} catch (err) {
				console.error("[search] LanceStore.close failed:", err);
			}
			this._store = null;
		}
		this._indexer = null;
		this._hybrid = null;
	}

	// ── Public API — index mutations ─────────────────────────────────

	indexGoal(goal: PersistedGoal, projectId?: string): void {
		if (!this._indexer) return;
		const indexer = this._indexer;
		const pid = projectId ?? goal.projectId ?? this.projectId;
		const title = (goal.title ?? "").trim();
		const spec = (goal.spec ?? "").trim();
		if (!title && !spec) return;
		const text = title && spec ? `${title}\n\n${spec}` : title || spec;
		const weight = 2.5;
		const role = "spec" as const;
		const timestamp = goal.updatedAt ?? goal.createdAt ?? 0;
		indexer
			.upsertEntries([
				{
					id: `goal:${goal.id}`,
					sourceId: "goals",
					text,
					metadata: {
						goalId: goal.id,
						state: goal.state ?? "",
					},
					contentHash: contentHashOf(text, weight, role, timestamp),
					timestamp,
					projectId: pid,
					archived: goal.archived === true,
					weight,
					role,
					display: { title, snippet: spec.slice(0, 300) },
				},
			])
			.catch((err) => console.error("[search] indexGoal failed:", err));
	}

	removeGoal(goalId: string): void {
		if (!this._indexer) return;
		this._indexer
			.removeEntries([`goal:${goalId}`])
			.catch((err) => console.error("[search] removeGoal failed:", err));
	}

	indexSession(session: PersistedSession, goalTitle?: string, projectId?: string): void {
		if (!this._indexer) return;
		const indexer = this._indexer;
		const pid = projectId ?? session.projectId ?? this.projectId;
		const title = (session.title ?? "").trim();
		if (!title) return;
		const weight = 3.0;
		const role = "title" as const;
		const timestamp = session.createdAt ?? session.lastActivity ?? 0;
		const metadata: Record<string, string | number | boolean> = { sessionId: session.id };
		if (session.goalId) metadata.goalId = session.goalId;
		if (goalTitle) metadata.goalTitle = goalTitle;
		if (session.role) metadata.agentRole = session.role;
		indexer
			.upsertEntries([
				{
					id: `session:${session.id}`,
					sourceId: "sessions",
					text: title,
					metadata,
					contentHash: contentHashOf(title, weight, role, timestamp),
					timestamp,
					projectId: pid,
					archived: session.archived === true,
					weight,
					role,
					display: { title, snippet: title },
				},
			])
			.catch((err) => console.error("[search] indexSession failed:", err));
	}

	removeSession(sessionId: string): void {
		if (!this._indexer) return;
		const indexer = this._indexer;
		// Remove session row + all its messages.
		indexer.removeEntries([`session:${sessionId}`]).catch((err) =>
			console.error("[search] removeSession failed:", err),
		);
		this.removeMessagesForSession(sessionId);
	}

	removeMessagesForSession(sessionId: string): void {
		if (!this._indexer) return;
		const escaped = sessionId.replace(/'/g, "''");
		this._indexer
			.removeByFilter(
				`session_id = '${escaped}' AND source_id = 'messages'`,
			)
			.catch((err) => console.error("[search] removeMessagesForSession failed:", err));
	}

	/**
	 * Index a single agent message. Legacy signature kept for 1:1
	 * migration — the service runs `content-policy.extractForIndexing`
	 * internally and upserts one row per emitted block.
	 *
	 * Overloaded to preserve the old (sessionId, sessionTitle, text,
	 * toolNames, timestamp, projectId) signature: if called that way,
	 * treat the raw text as a single assistant-text block.
	 */
	indexMessage(arg: {
		sessionId: string;
		sessionTitle: string;
		message: unknown;
		timestamp: number;
		projectId?: string;
		msgIdx?: number;
		goalId?: string;
	}): void;
	indexMessage(
		sessionId: string,
		sessionTitle: string,
		text: string,
		toolNames: string[],
		timestamp: number,
		projectId?: string,
	): void;
	indexMessage(
		arg1:
			| string
			| {
					sessionId: string;
					sessionTitle: string;
					message: unknown;
					timestamp: number;
					projectId?: string;
					msgIdx?: number;
					goalId?: string;
			  },
		sessionTitle?: string,
		text?: string,
		_toolNames?: string[],
		timestamp?: number,
		projectId?: string,
	): void {
		if (!this._indexer) return;
		const indexer = this._indexer;

		if (typeof arg1 === "string") {
			// Legacy signature: synthesise an assistant message from the
			// flat text and hand off to the content policy (which will
			// tag it "assistant", 1.0).
			const sessionId = arg1;
			const title = sessionTitle ?? "";
			const ts = timestamp ?? 0;
			const pid = projectId ?? this.projectId;
			const body = (text ?? "").trim();
			if (!body) return;
			const weight = 1.0;
			const role = "assistant" as const;
			indexer
				.upsertEntries([
					{
						id: `message:${sessionId}:legacy:${ts}`,
						sourceId: "messages",
						text: body,
						metadata: { sessionId, blockKey: "legacy:0" },
						contentHash: contentHashOf(body, weight, role, ts),
						timestamp: ts,
						projectId: pid,
						archived: false,
						weight,
						role,
						display: { title },
					},
				])
				.catch((err) => console.error("[search] indexMessage failed:", err));
			return;
		}

		// Preferred signature.
		const { sessionId, sessionTitle: st, message, timestamp: ts, projectId: pid, msgIdx, goalId } = arg1;
		const hit = extractForIndexing(message);
		if (hit.entries.length === 0) return;
		const resolvedProjectId = pid ?? this.projectId;
		const idx = typeof msgIdx === "number" ? msgIdx : ts;
		const indexables = hit.entries.map((entry) => ({
			id: `message:${sessionId}:${idx}:${entry.blockKey}`,
			sourceId: "messages" as const,
			text: entry.text,
			metadata: {
				sessionId,
				msgIdx: idx,
				blockKey: entry.blockKey,
				...(goalId ? { goalId } : {}),
			},
			contentHash: contentHashOf(entry.text, entry.weight, entry.role, ts),
			timestamp: ts,
			projectId: resolvedProjectId,
			archived: false,
			weight: entry.weight,
			role: entry.role,
			display: { title: st },
		}));
		indexer
			.upsertEntries(indexables)
			.catch((err) => console.error("[search] indexMessage failed:", err));
	}

	indexStaff(staff: PersistedStaff, projectId?: string): void {
		if (!this._indexer) return;
		const indexer = this._indexer;
		const pid = projectId ?? staff.projectId ?? this.projectId;
		const name = (staff.name ?? "").trim();
		const description = (staff.description ?? "").trim();
		if (!name && !description) return;
		const text = name && description ? `${name}\n\n${description}` : name || description;
		const weight = 1.5;
		const role = "profile" as const;
		const timestamp = staff.updatedAt ?? staff.createdAt ?? 0;
		const metadata: Record<string, string | number | boolean> = {
			staffId: staff.id,
			state: staff.state ?? "",
		};
		if (staff.roleId) metadata.roleId = staff.roleId;
		indexer
			.upsertEntries([
				{
					id: `staff:${staff.id}`,
					sourceId: "staff",
					text,
					metadata,
					contentHash: contentHashOf(text, weight, role, timestamp),
					timestamp,
					projectId: pid,
					archived: false,
					weight,
					role,
					display: { title: name, snippet: description.slice(0, 300) },
				},
			])
			.catch((err) => console.error("[search] indexStaff failed:", err));
	}

	removeStaff(staffId: string): void {
		if (!this._indexer) return;
		this._indexer
			.removeEntries([`staff:${staffId}`])
			.catch((err) => console.error("[search] removeStaff failed:", err));
	}

	// ── Public API — search ──────────────────────────────────────────

	/**
	 * Legacy-compat search. Translates the old options shape (type filter
	 * as singular string) into a `SearchQuery` and runs the hybrid query.
	 *
	 * `includeArchived` is implied by the old API only when `type` is
	 * not specified — matches pre-existing behaviour where archived rows
	 * were included iff `archived` was not filtered out server-side.
	 */
	search(
		query: string,
		opts: {
			type?: "all" | "goals" | "sessions" | "messages" | "staff";
			limit?: number;
			offset?: number;
			projectId?: string;
			projectNames?: Map<string, string>;
			includeArchived?: boolean;
		} = {},
	): SearchResults | Promise<SearchResults> {
		if (this._state !== "ready" || !this._hybrid) {
			// Return empty results rather than throwing, to match the
			// pre-existing "search never crashes the request" contract.
			return { results: [], total: 0 };
		}

		const type = opts.type ?? "all";
		const types =
			type === "all"
				? undefined
				: ([type] as Array<"goals" | "sessions" | "messages" | "staff">);

		const promise = this._hybrid.search({
			q: query,
			limit: opts.limit,
			offset: opts.offset,
			projectId: opts.projectId,
			types,
			// Legacy FTS behaviour: archived surface only when no project filter
			// is applied or explicitly requested.
			includeArchived: opts.includeArchived ?? true,
		});

		// Attach project names if requested.
		if (opts.projectNames) {
			const names = opts.projectNames;
			return promise.then((r) => {
				for (const row of r.results) {
					if (row.projectId) row.projectName = names.get(row.projectId);
				}
				return r;
			});
		}
		return promise;
	}

	// ── Rebuilds ─────────────────────────────────────────────────────

	/**
	 * Full rebuild from the legacy store triple. Maps onto the new
	 * `rebuildFromSources` under the hood.
	 */
	async rebuildFromStores(
		goalStore: GoalStore,
		sessionStore: SessionStore,
		_sessionsDir?: string,
		staffStore?: StaffStore,
	): Promise<void> {
		const effectiveStaff = staffStore ?? this.staffStore;
		if (!effectiveStaff) {
			// Historical contract accepted missing staff store (returned
			// empty staff set). Build a minimal shim.
			return this.rebuildFromSources(goalStore, sessionStore, emptyStaffStore());
		}
		return this.rebuildFromSources(goalStore, sessionStore, effectiveStaff);
	}

	async rebuildFromSources(
		goalStore: GoalStore,
		sessionStore: SessionStore,
		staffStore: StaffStore,
		sources?: IndexSource[],
	): Promise<void> {
		if (!this._indexer) {
			// Service not ready — best-effort no-op so callers don't crash.
			return;
		}
		const ctx: IndexSourceContext = {
			projectId: this.projectId,
			goalStore,
			sessionStore,
			staffStore,
		};
		const srcs = sources ?? [
			this._goalSource,
			this._sessionSource,
			this._messageSource,
			this._staffSource,
		];
		await this._indexer.rebuildFromSources(srcs, ctx);
	}

	// ── Internals ────────────────────────────────────────────────────

	private async _doOpen(
		context?: { goalStore?: GoalStore; sessionStore?: SessionStore; staffStore?: StaffStore },
	): Promise<void> {
		// 1. Open LanceStore.
		let store: LanceStore;
		try {
			store = await LanceStore.open({
				dataDir: this.dataDir,
				embedDim: this.embedder.dim,
			});
		} catch (err) {
			console.error(
				`[search] LanceStore failed to open at ${this.dataDir} — search disabled (no-native):`,
				err,
			);
			this._state = "disabled-no-native";
			this.progressBus.emit("index:error", {
				projectId: this.projectId,
				message: `LanceDB native binary unavailable: ${(err as Error).message}`,
				recoverable: false,
			});
			return;
		}
		this._store = store;

		// Legacy FTS5 cleanup: now that LanceDB is open, remove any stale
		// search.db files in this project's state dir. One-shot migration per
		// the design doc §10. Wrapped in try/catch — never fatal.
		try {
			for (const suffix of ["", "-wal", "-shm"]) {
				const legacy = path.join(this.stateDir, `search.db${suffix}`);
				if (fs.existsSync(legacy)) {
					try {
						fs.unlinkSync(legacy);
						console.log(`[search] Removed legacy ${path.basename(legacy)}`);
					} catch (err) {
						console.warn(`[search] Could not remove legacy ${legacy}:`, err);
					}
				}
			}
		} catch {
			/* non-fatal */
		}

		// 2. Warm up embedder. Failure → disabled-no-model but LanceStore
		// stays open so future retries (e.g. after model download) can
		// succeed without re-opening the dataset.
		try {
			await this.embedder.ready();
		} catch (err) {
			console.error(
				`[search] Embedder failed to load — search disabled (no-model):`,
				err,
			);
			this._state = "disabled-no-model";
			this.progressBus.emit("index:error", {
				projectId: this.projectId,
				message: `Embedding model failed to load: ${(err as Error).message}`,
				recoverable: true,
			});
			return;
		}

		// 3. Instantiate indexer + hybrid.
		this._indexer = new Indexer({
			lance: store,
			embedder: this.embedder,
			progressBus: this.progressBus,
			projectId: this.projectId,
		});
		this._hybrid = new HybridQuery({ lance: store, embedder: this.embedder });

		// 4. Meta check. Mismatch → background rebuild (do NOT block).
		try {
			const stored = await store.readMeta();
			const current = buildCurrentMeta({
				embedderId: this.embedder.id,
				dim: this.embedder.dim,
				contentPolicyVersion: CONTENT_POLICY_VERSION,
			});
			if (metaNeedsRebuild(stored, current)) {
				if (
					context?.goalStore &&
					context?.sessionStore &&
					(context?.staffStore || this.staffStore)
				) {
					const staff = (context.staffStore ?? this.staffStore) as StaffStore;
					this.rebuildFromSources(
						context.goalStore,
						context.sessionStore,
						staff,
					)
						.then(() => {
							// No-op — progress events already emitted.
						})
						.catch((err) => {
							console.error("[search] Background rebuild failed:", err);
						});
				}
				// If no stores provided, caller is responsible for invoking
				// rebuildFromStores explicitly once wiring is up.
			}
		} catch (err) {
			console.error("[search] Meta read failed (non-fatal):", err);
		}

		this._state = "ready";
		// Schedule daily compaction once the service is up. Timer is
		// .unref()'d so it never keeps the process alive on shutdown.
		this._startScheduledCompaction();
	}
}

// ── Helpers ─────────────────────────────────────────────────────────

function dirSizeBytes(dir: string): number {
	try {
		if (!fs.existsSync(dir)) return 0;
		let total = 0;
		const stack: string[] = [dir];
		while (stack.length) {
			const p = stack.pop()!;
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(p);
			} catch {
				continue;
			}
			if (stat.isDirectory()) {
				let entries: string[] = [];
				try {
					entries = fs.readdirSync(p);
				} catch {
					continue;
				}
				for (const e of entries) stack.push(path.join(p, e));
			} else if (stat.isFile()) {
				total += stat.size;
			}
		}
		return total;
	} catch {
		return 0;
	}
}

function emptyStaffStore(): StaffStore {
	// Minimal shim for the staff-less rebuild path. Only `getAll()` is
	// exercised by `StaffIndexSource`.
	return {
		getAll: () => [],
	} as unknown as StaffStore;
}
