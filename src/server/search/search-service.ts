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
import type { IndexSource, IndexSourceContext, SearchResults } from "./types.js";
import { FlexSearchStore, FLEX_VERSION } from "./flex-store.js";
import { Indexer } from "./indexer.js";
import { GoalIndexSource } from "./sources/goal-source.js";
import { SessionIndexSource } from "./sources/session-source.js";
import { MessageIndexSource } from "./sources/message-source.js";
import { StaffIndexSource } from "./sources/staff-source.js";
import { contentHashOf } from "./sources/hash.js";
import { progressBus as sharedProgressBus, type ProgressBus } from "./progress-bus.js";
import { needsRebuild as metaNeedsRebuild, buildCurrentMeta } from "./meta.js";
import { CONTENT_POLICY_VERSION, extractForIndexing } from "./content-policy.js";

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
		this._state = "closed";
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
		indexer
			.upsertEntries([
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
		indexer.removeEntries([`session:${sessionId}`]).catch((err) =>
			console.error("[search] removeSession failed:", err),
		);
		this.removeMessagesForSession(sessionId);
	}

	removeMessagesForSession(sessionId: string): void {
		if (!this._indexer) return;
		this._indexer
			.removeByFilter({ session_id: sessionId, source_id: "messages" })
			.catch((err) => console.error("[search] removeMessagesForSession failed:", err));
	}

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
			includeArchived: opts.includeArchived ?? true,
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
		if (!this._indexer) return;
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
		await enqueueRebuild(() => indexer.rebuildFromSources(srcs, ctx));
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
					context?.goalStore &&
					context?.sessionStore &&
					(context?.staffStore || this.staffStore)
				) {
					const staff = (context.staffStore ?? this.staffStore) as StaffStore;
					const delayMs = Number(process.env.BOBBIT_SEARCH_STARTUP_DELAY_MS ?? 5000);
					const timer = setTimeout(() => {
						this.rebuildFromSources(
							context.goalStore!,
							context.sessionStore!,
							staff,
						).catch((err) => console.error("[search] Background rebuild failed:", err));
					}, delayMs);
					if (typeof timer.unref === "function") timer.unref();
				}
			}
		} catch (err) {
			console.error("[search] Meta read failed (non-fatal):", err);
		}

		this._state = "ready";
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
