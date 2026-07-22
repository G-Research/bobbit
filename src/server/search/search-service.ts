/**
 * `SearchService` — per-project facade over the FlexSearch-backed
 * lexical search stack.
 *
 * Wraps `FlexSearchStore`, `Indexer`, and four core `IndexSource`s
 * behind the same public surface the legacy `SearchIndex` exposed
 * (open/close/rebuildFromStores/indexX/removeX/search) so the rest of
 * the codebase migrates 1:1.
 *
 * State machine (design §10.3):
 *   "initializing" -- open() kicked off, not ready
 *   "ready"        -- FlexSearchStore open
 *   "disabled"     -- store failed to open (rare — dir unwritable)
 *   "closed"       -- close() called
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PersistedGoal, GoalStore } from "../agent/goal-store.js";
import type { PersistedSession, SessionStore } from "../agent/session-store.js";
import type { PersistedStaff, StaffStore } from "../agent/staff-store.js";
import type { Indexable, IndexSource, IndexSourceContext, SearchResults } from "./types.js";
import { FlexSearchStore, FLEX_VERSION } from "./flex-store.js";
import { Indexer } from "./indexer.js";
import { GoalIndexSource } from "./sources/goal-source.js";
import { SessionIndexSource } from "./sources/session-source.js";
import { MessageIndexSource } from "./sources/message-source.js";
import { StaffIndexSource } from "./sources/staff-source.js";
import { contentHashOf } from "./sources/hash.js";
import { formatSessionSearchTitle } from "./sources/session-title.js";
import { progressBus as sharedProgressBus, type ProgressBus } from "./progress-bus.js";
import { needsRebuild as metaNeedsRebuild, buildCurrentMeta } from "./meta.js";
import { CONTENT_POLICY_VERSION, extractForIndexing } from "./content-policy.js";
import { isMessageAuthor } from "../../shared/message-author.js";

// ── Module-level rebuild queue ───────────────────────────────────────

let _rebuildQueue: Promise<unknown> = Promise.resolve();

function enqueueRebuild<T>(task: () => Promise<T>): Promise<T> {
	const next = _rebuildQueue.then(task, task);
	_rebuildQueue = next.catch(() => undefined);
	return next;
}

// ── Types ────────────────────────────────────────────────────────────

export type SearchServiceState =
	| "initializing"
	| "ready"
	| "disabled"
	| "closed";

export interface SearchServiceOptions {
	stateDir: string;
	projectId: string;
	/** Override progress bus (tests). Defaults to the shared singleton. */
	progressBus?: ProgressBus;
	/** Override staff store for rebuilds. Optional — can also be supplied to rebuildFromStores. */
	staffStore?: StaffStore;
}

// ── SearchService ────────────────────────────────────────────────────

export class SearchService {
	readonly stateDir: string;
	readonly projectId: string;
	readonly dataDir: string;

	private readonly progressBus: ProgressBus;

	private _state: SearchServiceState = "initializing";
	private _store: FlexSearchStore | null = null;
	private _indexer: Indexer | null = null;

	/** Optional staff store for rebuilds. */
	staffStore?: StaffStore;

	private _openPromise: Promise<void> | null = null;

	/**
	 * Handle for the deferred startup rebuild scheduled in `_doOpen`. Kept on
	 * the instance so `close()` can cancel it — otherwise the timer fires after
	 * the store has been closed and the rebuild calls `store.clear()` on a
	 * closed store, throwing `FlexSearchStore: already closed`.
	 */
	private _rebuildTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Startup/background rebuild currently running (or queued behind the module
	 * rebuild queue). `close()` waits for this before closing the store so a
	 * rebuild that already passed the timer guard cannot race into a closed
	 * FlexSearchStore.
	 */
	private _backgroundRebuildPromise: Promise<void> | null = null;

	/**
	 * Fire-and-forget index mutations currently using the store. `close()` marks
	 * the service closed to block new work, then waits for this set before closing
	 * the underlying store so teardown cannot race into `FlexSearchStore: already closed`.
	 */
	private readonly _mutationTasks = new Set<Promise<void>>();

	/**
	 * Compound message mutations (`deleteWhere` + reinsert) must be serialized per
	 * parent session. Otherwise rapid title/goal updates can complete out of order
	 * and let an older reindex overwrite newer message `sessionTitle` metadata.
	 */
	private readonly _sessionMessageMutationChains = new Map<string, Promise<void>>();

	private readonly _goalSource = new GoalIndexSource();
	private readonly _sessionSource = new SessionIndexSource();
	private readonly _messageSource = new MessageIndexSource();
	private readonly _staffSource = new StaffIndexSource();

	constructor(opts: SearchServiceOptions) {
		this.stateDir = opts.stateDir;
		this.projectId = opts.projectId;
		this.dataDir = path.join(opts.stateDir, "search.flex");
		this.progressBus = opts.progressBus ?? sharedProgressBus;
		this.staffStore = opts.staffStore;
	}

	getState(): SearchServiceState {
		return this._state;
	}

	/** Internal access for admin/maintenance REST endpoints. */
	getStore(): FlexSearchStore | null {
		return this._store;
	}

	/** Engine identity for stats endpoint. */
	getEngineInfo(): { engine: string; engineVersion: string } {
		return { engine: "flexsearch", engineVersion: FLEX_VERSION };
	}

	async getStats(): Promise<{
		state: SearchServiceState;
		engine: string;
		engineVersion: string;
		lastRebuildAt: number | null;
		rowCountsBySource: { goals: number; sessions: number; messages: number; staff: number; files: number };
		datasetBytes: number;
	}> {
		const info = this.getEngineInfo();
		const empty = { goals: 0, sessions: 0, messages: 0, staff: 0, files: 0 };
		const base = {
			state: this._state,
			engine: info.engine,
			engineVersion: info.engineVersion,
			lastRebuildAt: null as number | null,
			rowCountsBySource: empty,
			datasetBytes: dirSizeBytes(this.dataDir),
		};
		if (!this._store) return base;
		try {
			const meta = await this._store.readMeta();
			const rowCountsBySource = {
				goals: this._store.count({ source_id: "goals" }),
				sessions: this._store.count({ source_id: "sessions" }),
				messages: this._store.count({ source_id: "messages" }),
				staff: this._store.count({ source_id: "staff" }),
				files: this._store.count({ source_id: "files" }),
			};
			return { ...base, lastRebuildAt: meta?.createdAt ?? null, rowCountsBySource };
		} catch {
			return base;
		}
	}

	/** No-op compaction (kept for facade compatibility). */
	async compact(): Promise<void> {
		if (!this._store) return;
		await this._store.compact();
	}

	open(
		context?: { goalStore?: GoalStore; sessionStore?: SessionStore; staffStore?: StaffStore },
	): void {
		if (this._openPromise) return;
		this._openPromise = this._doOpen(context);
	}

	async whenReady(): Promise<void> {
		if (this._openPromise) await this._openPromise;
	}

	needsRebuild(): boolean {
		return false;
	}

	async close(): Promise<void> {
		// Coordinate with an in-flight open(): if _doOpen() is still awaiting
		// disk I/O, wait for it to settle before tearing down. Otherwise
		// _doOpen() could resume *after* close() returns and re-establish the
		// store, indexer, and rebuild timer — leaking live search resources and
		// a timer past shutdown. _doOpen() also re-checks `_state` after its
		// awaits, so between the two guards the open/close race is fully closed.
		if (this._openPromise) {
			try { await this._openPromise; } catch { /* open failed — still tear down */ }
		}
		this._state = "closed";
		if (this._rebuildTimer) {
			clearTimeout(this._rebuildTimer);
			this._rebuildTimer = null;
		}
		// If the startup/background rebuild already fired, let it settle before
		// closing the store it is using. This fixes the close-during-rebuild race
		// that otherwise surfaces as `FlexSearchStore: already closed` from
		// Indexer.rebuildFromSources().
		if (this._backgroundRebuildPromise) {
			try { await this._backgroundRebuildPromise; } catch { /* handled by owner */ }
		}
		await this._waitForMutationTasks();
		// Re-read _store after the await — _doOpen() may have just assigned it.
		if (this._store) {
			try { await this._store.close(); }
			catch (err) { console.error("[search] FlexSearchStore.close failed:", err); }
			this._store = null;
		}
		this._indexer = null;
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
		this._scheduleMutation("indexGoal", indexer, () => indexer.upsertEntries([
			{
				id: `goal:${goal.id}`,
				sourceId: "goals",
				text,
				metadata: { goalId: goal.id, state: goal.state ?? "" },
				contentHash: contentHashOf(text, weight, role, timestamp),
				timestamp,
				projectId: pid,
				archived: goal.archived === true,
				weight,
				role,
				display: { title, snippet: spec.slice(0, 300) },
			},
		]));
	}

	removeGoal(goalId: string): void {
		if (!this._indexer) return;
		const indexer = this._indexer;
		this._scheduleMutation("removeGoal", indexer, () => indexer.removeEntries([`goal:${goalId}`]));
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
		const displayTitle = formatSessionSearchTitle(title, goalTitle);
		const metadata: Record<string, string | number | boolean> = { sessionId: session.id };
		if (session.goalId) metadata.goalId = session.goalId;
		if (goalTitle) metadata.goalTitle = goalTitle;
		if (session.role) metadata.agentRole = session.role;
		this._scheduleMutation("indexSession", indexer, () => indexer.upsertEntries([
			{
				id: `session:${session.id}`,
				sourceId: "sessions",
				text: title,
				metadata,
				contentHash: contentHashOf(`${title}\n${displayTitle}`, weight, role, timestamp),
				timestamp,
				projectId: pid,
				archived: session.archived === true,
				weight,
				role,
				display: { title: displayTitle, snippet: displayTitle },
			},
		]));
	}

	removeSession(sessionId: string): void {
		if (!this._indexer) return;
		const indexer = this._indexer;
		this._scheduleMutation("removeSession", indexer, () => indexer.removeEntries([`session:${sessionId}`]));
		this.removeMessagesForSession(sessionId);
	}

	removeMessagesForSession(sessionId: string): void {
		if (!this._indexer) return;
		const indexer = this._indexer;
		this._scheduleMutation("removeMessagesForSession", indexer, () =>
			indexer.removeByFilter({ session_id: sessionId, source_id: "messages" }),
			this._messageMutationKey(sessionId),
		);
	}

	reindexMessagesForSession(session: PersistedSession, goalTitle?: string, projectId?: string): void {
		if (!this._indexer) return;
		const indexer = this._indexer;
		const sessionSnapshot = { ...session };
		const pid = projectId ?? sessionSnapshot.projectId ?? this.projectId;
		const goalTitleSnapshot = goalTitle;
		this._scheduleMutation("reindexMessagesForSession", indexer, async () => {
			if ((this._state as SearchServiceState) === "closed" || this._indexer !== indexer) return;
			await indexer.removeByFilter({ session_id: sessionSnapshot.id, source_id: "messages" });
			if ((this._state as SearchServiceState) === "closed" || this._indexer !== indexer) return;
			const goalStore = {
				getAll: () => sessionSnapshot.goalId ? [{ id: sessionSnapshot.goalId, title: goalTitleSnapshot ?? "" }] : [],
			} as unknown as GoalStore;
			const sessionStore = { getAll: () => [sessionSnapshot] } as unknown as SessionStore;
			const ctx: IndexSourceContext = {
				projectId: pid,
				goalStore,
				sessionStore,
				staffStore: emptyStaffStore(),
			};
			const entries: Indexable[] = [];
			for await (const entry of this._messageSource.iterate(ctx)) entries.push(entry);
			if ((this._state as SearchServiceState) === "closed" || this._indexer !== indexer) return;
			await indexer.upsertEntries(entries);
		}, this._messageMutationKey(sessionSnapshot.id));
	}

	indexMessage(arg: {
		sessionId: string;
		sessionTitle: string;
		message: unknown;
		timestamp: number;
		projectId?: string;
		msgIdx?: number;
		goalId?: string;
		goalTitle?: string;
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
					goalTitle?: string;
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
			const sessionId = arg1;
			const title = (sessionTitle ?? "").trim();
			const ts = timestamp ?? 0;
			const pid = projectId ?? this.projectId;
			const body = (text ?? "").trim();
			if (!body) return;
			const weight = 1.0;
			const role = "assistant" as const;
			this._scheduleMutation("indexMessage", indexer, () => indexer.upsertEntries([
				{
					id: `message:${sessionId}:legacy:${ts}`,
					sourceId: "messages",
					text: body,
					metadata: {
						sessionId,
						blockKey: "legacy:0",
						...(title ? { sessionTitle: title } : {}),
					},
					contentHash: contentHashOf(`${body}\n${title}`, weight, role, ts),
					timestamp: ts,
					projectId: pid,
					archived: false,
					weight,
					role,
					display: { title },
				},
			]));
			return;
		}

		const { sessionId, sessionTitle: st, message, timestamp: ts, projectId: pid, msgIdx, goalId, goalTitle } = arg1;
		const displayTitle = formatSessionSearchTitle(st, goalTitle);
		const hit = extractForIndexing(message);
		if (hit.entries.length === 0) return;
		const candidateAuthor = message && typeof message === "object"
			? (message as Record<string, unknown>).author
			: undefined;
		const author = isMessageAuthor(candidateAuthor) ? candidateAuthor : undefined;
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
				...(goalTitle ? { goalTitle } : {}),
				...(displayTitle ? { sessionTitle: displayTitle } : {}),
				...(author ? {
					authorKind: author.kind,
					authorId: author.id,
					authorLabel: author.label,
				} : {}),
			},
			contentHash: contentHashOf(`${entry.text}\n${displayTitle}`, entry.weight, entry.role, ts),
			timestamp: ts,
			projectId: resolvedProjectId,
			archived: false,
			weight: entry.weight,
			role: entry.role,
			display: { title: displayTitle },
		}));
		this._scheduleMutation("indexMessage", indexer, () => indexer.upsertEntries(indexables));
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
		this._scheduleMutation("indexStaff", indexer, () => indexer.upsertEntries([
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
		]));
	}

	removeStaff(staffId: string): void {
		if (!this._indexer) return;
		const indexer = this._indexer;
		this._scheduleMutation("removeStaff", indexer, () => indexer.removeEntries([`staff:${staffId}`]));
	}

	// ── Public API — search ──────────────────────────────────────────

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
		if (this._state !== "ready" || !this._store) {
			return { results: [], total: 0 };
		}

		const type = opts.type ?? "all";
		const types =
			type === "all"
				? undefined
				: ([type] as Array<"goals" | "sessions" | "messages" | "staff">);

		const promise = this._store.search({
			q: query,
			limit: opts.limit,
			offset: opts.offset,
			projectId: opts.projectId,
			types,
			includeArchived: opts.includeArchived ?? false,
		});

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

	async rebuildFromStores(
		goalStore: GoalStore,
		sessionStore: SessionStore,
		_sessionsDir?: string,
		staffStore?: StaffStore,
	): Promise<void> {
		const effectiveStaff = staffStore ?? this.staffStore;
		if (!effectiveStaff) {
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
		if (this._state === "closed" || !this._indexer) return;
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
		const indexer = this._indexer;
		await enqueueRebuild(() => {
			if (this._state === "closed" || this._indexer !== indexer) return Promise.resolve();
			return indexer.rebuildFromSources(srcs, ctx);
		});
	}

	private _scheduleMutation(
		label: string,
		indexer: Indexer,
		task: () => Promise<void>,
		serializeKey?: string,
	): void {
		if (this._state === "closed" || this._indexer !== indexer) return;
		const previous = serializeKey
			? this._sessionMessageMutationChains.get(serializeKey) ?? Promise.resolve()
			: Promise.resolve();
		const run = async () => {
			await previous.catch(() => undefined);
			if (this._state === "closed" || this._indexer !== indexer) return;
			await task();
		};
		let tracked: Promise<void>;
		tracked = run()
			.catch((err) => {
				if (this._state === "closed" && isStoreAlreadyClosedError(err)) return;
				console.error(`[search] ${label} failed:`, err);
			})
			.finally(() => {
				this._mutationTasks.delete(tracked);
				if (serializeKey && this._sessionMessageMutationChains.get(serializeKey) === tracked) {
					this._sessionMessageMutationChains.delete(serializeKey);
				}
			});
		if (serializeKey) this._sessionMessageMutationChains.set(serializeKey, tracked);
		this._mutationTasks.add(tracked);
	}

	private _messageMutationKey(sessionId: string): string {
		return `messages:${sessionId}`;
	}

	private async _waitForMutationTasks(): Promise<void> {
		while (this._mutationTasks.size > 0) {
			await Promise.allSettled([...this._mutationTasks]);
		}
	}

	// ── Internals ────────────────────────────────────────────────────

	private async _doOpen(
		context?: { goalStore?: GoalStore; sessionStore?: SessionStore; staffStore?: StaffStore },
	): Promise<void> {
		// One-shot legacy cleanup: drop any pre-existing LanceDB dataset.
		const lanceDir = path.join(this.stateDir, "search.lance");
		if (fs.existsSync(lanceDir)) {
			try {
				await fs.promises.rm(lanceDir, { recursive: true, force: true });
				console.log(`[search] Removed legacy ${lanceDir}`);
			} catch (err) {
				console.warn(`[search] Could not remove legacy search.lance:`, err);
			}
		}
		// Legacy FTS5 cleanup: search.db* siblings.
		try {
			for (const suffix of ["", "-wal", "-shm"]) {
				const legacy = path.join(this.stateDir, `search.db${suffix}`);
				if (fs.existsSync(legacy)) {
					try {
						fs.unlinkSync(legacy);
					} catch (err) {
						const code = (err as NodeJS.ErrnoException)?.code;
						if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOENT") {
							console.warn(`[search] Could not remove legacy ${legacy}:`, err);
						}
					}
				}
			}
		} catch { /* non-fatal */ }

		// Open FlexSearchStore.
		let store: FlexSearchStore;
		try {
			store = await FlexSearchStore.open({ dataDir: this.dataDir });
		} catch (err) {
			console.error(
				`[search] FlexSearchStore failed to open at ${this.dataDir} — search disabled:`,
				err,
			);
			this._state = "disabled";
			this.progressBus.emit("index:error", {
				projectId: this.projectId,
				message: `FlexSearch store unavailable: ${(err as Error).message}`,
				recoverable: false,
			});
			return;
		}

		// close() may have run while FlexSearchStore.open() awaited disk I/O. If
		// so, bail without assigning _store/_indexer, scheduling a rebuild timer,
		// or flipping to "ready" — just release the freshly opened store so it
		// doesn't outlive shutdown. (close() also awaits _openPromise; this guard
		// covers the case where _state flips to "closed" mid-open.)
		if ((this._state as SearchServiceState) === "closed") {
			try { await store.close(); } catch { /* best-effort */ }
			return;
		}
		this._store = store;

		this._indexer = new Indexer({
			store,
			progressBus: this.progressBus,
			projectId: this.projectId,
		});

		// Meta check. Mismatch → background rebuild.
		try {
			const stored = await store.readMeta();
			const current = buildCurrentMeta({
				engine: "flexsearch",
				engineVersion: FLEX_VERSION,
				contentPolicyVersion: CONTENT_POLICY_VERSION,
			});
			// Also consider a stored-but-empty index corrupt.
			const corrupt = stored !== null && store.count() === 0;
			if (metaNeedsRebuild(stored, current) || corrupt) {
				if (
					(this._state as SearchServiceState) !== "closed" &&
					context?.goalStore &&
					context?.sessionStore &&
					(context?.staffStore || this.staffStore)
				) {
					const staff = (context.staffStore ?? this.staffStore) as StaffStore;
					const delayMs = Number(process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS ?? 5000);
					const timer = setTimeout(() => {
						this._rebuildTimer = null;
						// `close()` may have run between scheduling and firing; the
						// store is then closed and clear()/upsert() would throw
						// "FlexSearchStore: already closed". No-op in that case.
						if (this._state === "closed" || !this._indexer) return;
						const rebuildPromise = this.rebuildFromSources(
							context.goalStore!,
							context.sessionStore!,
							staff,
						);
						const trackedPromise = rebuildPromise
							.catch((err) => {
								if (this._state !== "closed" || !isStoreAlreadyClosedError(err)) {
									console.error("[search] Background rebuild failed:", err);
								}
							})
							.finally(() => {
								if (this._backgroundRebuildPromise === trackedPromise) {
									this._backgroundRebuildPromise = null;
								}
							});
						this._backgroundRebuildPromise = trackedPromise;
					}, delayMs);
					if (typeof timer.unref === "function") timer.unref();
					this._rebuildTimer = timer;
				}
			}
		} catch (err) {
			console.error("[search] Meta read failed (non-fatal):", err);
		}

		// A concurrent close() may have run during the awaits above; don't
		// resurrect the service to "ready" if it has already been closed.
		if ((this._state as SearchServiceState) !== "closed") this._state = "ready";
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
			try { stat = fs.lstatSync(p); } catch { continue; }
			if (stat.isDirectory()) {
				let entries: string[] = [];
				try { entries = fs.readdirSync(p); } catch { continue; }
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
	return {
		getAll: () => [],
	} as unknown as StaffStore;
}

function isStoreAlreadyClosedError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("FlexSearchStore: already closed");
}
