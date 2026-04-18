/**
 * `Indexer` — orchestrates the flow from `Indexable`s to LanceDB rows.
 *
 * Responsibilities (design §3, §8, §10):
 *   - Incremental upsert: batch-embed (32) + batch-upsert (128) a list of
 *     Indexables, respecting `contentHash` dedup.
 *   - Chunking: long text (> maxTokens) is split via `chunkText`; each
 *     chunk becomes its own row with `parent_id` pointing back to the
 *     original Indexable id. On display, consumers collapse by
 *     `parent_id`.
 *   - Backlog counter + debounced `index:progress` emission.
 *   - Full rebuild from a set of `IndexSource`s: drop the content table,
 *     drain each source, embed in batches, upsert, lazily create indexes
 *     past the 10K threshold, write meta.
 *
 * This module is store-agnostic in spirit — it talks to `LanceStore`
 * through the narrow surface defined by T2, and to `Embedder` through
 * T1. Source iteration lives entirely in T6.
 *
 * Design reference: docs/design/semantic-search.md §3, §6, §8, §10, §11.
 */

import type {
	Embedder,
	Indexable,
	IndexSource,
	IndexSourceContext,
} from "./types.js";
import type { LanceStore, ContentRow } from "./lance-store.js";
import type { ProgressBus } from "./progress-bus.js";
import { chunkText } from "./chunker.js";
import { CONTENT_POLICY_VERSION } from "./content-policy.js";
import { buildCurrentMeta } from "./meta.js";

// ── Tunables (design §13) ────────────────────────────────────────────

const EMBED_BATCH_SIZE = 32;
const UPSERT_BATCH_SIZE = 128;
const ROWS_BEFORE_INDEX = 10_000;
/** Opportunistic rebuild trigger: rows since last index > rowCount * this ratio. */
const OPPORTUNISTIC_INDEX_RATIO = 0.1;
/** Minimum time between opportunistic index rebuilds. */
const OPPORTUNISTIC_INDEX_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_TOKENS = 2000;
const CHUNK_OVERLAP = 200;
const PROGRESS_DEBOUNCE_MS = 500;
const DOCUMENT_PREFIX = "search_document: ";

// ── Options ──────────────────────────────────────────────────────────

export interface IndexerOptions {
	lance: LanceStore;
	embedder: Embedder;
	progressBus: ProgressBus;
	projectId: string;
	/** Override debounce window for tests. Defaults to 500ms. */
	progressDebounceMs?: number;
	/** Override max tokens per chunk. Defaults to 2000. */
	maxTokens?: number;
	/** Override chunk overlap tokens. Defaults to 200. */
	chunkOverlap?: number;
}

// ── Indexer ─────────────────────────────────────────────────────────

/**
 * Stateful per-project indexer. Thread-safe within the cooperative
 * async single-threaded Node model — callers should not interleave
 * `upsertEntries` and `rebuildFromSources`; the SearchService serializes
 * them.
 */
export class Indexer {
	readonly projectId: string;
	private readonly lance: LanceStore;
	private readonly embedder: Embedder;
	private readonly progressBus: ProgressBus;
	private readonly progressDebounceMs: number;
	private readonly maxTokens: number;
	private readonly chunkOverlap: number;

	private _backlog = 0;
	/** Opportunistic-ANN-rebuild bookkeeping (design §13). */
	private _rowsSinceLastIndex = 0;
	private _lastIndexBuildAt = 0;
	private _indexRebuildPending = false;
	private _lastProgressEmit = 0;
	private _progressTimer: NodeJS.Timeout | null = null;
	private _pendingPhase: "rebuild" | "incremental" = "incremental";
	private _pendingTotal = 0;
	private _pendingCompleted = 0;

	constructor(opts: IndexerOptions) {
		this.lance = opts.lance;
		this.embedder = opts.embedder;
		this.progressBus = opts.progressBus;
		this.projectId = opts.projectId;
		this.progressDebounceMs = opts.progressDebounceMs ?? PROGRESS_DEBOUNCE_MS;
		this.maxTokens = opts.maxTokens ?? MAX_TOKENS;
		this.chunkOverlap = opts.chunkOverlap ?? CHUNK_OVERLAP;
	}

	get backlog(): number {
		return this._backlog;
	}

	// ── Public API ───────────────────────────────────────────────────

	/**
	 * Incrementally embed + upsert a list of Indexables.
	 *
	 * - Filters out entries whose `contentHash` is already stored.
	 * - Long text is chunked; each chunk becomes its own row with
	 *   `parent_id` = the original Indexable id.
	 * - Embedding happens in batches of 32; upsert in batches of 128.
	 * - Emits `index:progress` (debounced) as the backlog drains; emits
	 *   `index:error` and rethrows on failure.
	 */
	async upsertEntries(entries: Indexable[]): Promise<void> {
		if (entries.length === 0) return;

		this._backlog += entries.length;
		this._pendingPhase = "incremental";
		this._pendingTotal = entries.length;
		this._pendingCompleted = 0;
		this._scheduleProgress();

		try {
			// Dedup by contentHash — skip unchanged entries entirely.
			const fresh = await this._filterUnchanged(entries);
			const skipped = entries.length - fresh.length;
			if (skipped > 0) {
				this._backlog = Math.max(0, this._backlog - skipped);
				this._pendingCompleted += skipped;
				this._scheduleProgress();
			}

			// Expand long entries into chunks.
			const expanded = this._expandWithChunks(fresh);

			// Embed + upsert in streaming batches.
			let processedOriginal = 0;
			for (let i = 0; i < expanded.length; i += EMBED_BATCH_SIZE) {
				const batch = expanded.slice(i, i + EMBED_BATCH_SIZE);
				const vecs = await this.embedder.embed(
					batch.map((b) => DOCUMENT_PREFIX + b.row.text),
					"document",
				);
				const rows: ContentRow[] = batch.map((b, j) => ({
					...b.row,
					embedding: vecs[j],
				}));
				// Upsert in sub-batches of UPSERT_BATCH_SIZE.
				for (let k = 0; k < rows.length; k += UPSERT_BATCH_SIZE) {
					await this.lance.upsert(rows.slice(k, k + UPSERT_BATCH_SIZE));
				}

				// Progress: count original entries completed (chunks share parents).
				const originalsInBatch = new Set(batch.map((b) => b.originalIndex)).size;
				processedOriginal += originalsInBatch;
				this._backlog = Math.max(0, this._backlog - originalsInBatch);
				this._pendingCompleted = Math.min(fresh.length, processedOriginal);
				this._scheduleProgress();
			}

			// Final flush for any pending debounced progress event.
			this._flushProgress();

			// Opportunistic ANN-index rebuild (design §13). If the dataset
			// has grown by more than 10% since the last build and we're past
			// the 10K-row threshold, schedule a rebuild — rate-limited to once
			// per hour. Runs in the background; failures are logged only.
			if (expanded.length > 0) {
				this._rowsSinceLastIndex += expanded.length;
				void this._maybeRebuildIndexes().catch((err) => {
					console.error("[search] Opportunistic index rebuild failed:", err);
				});
			}
		} catch (err) {
			// Reset backlog for these entries — they're not queued any more.
			this._backlog = Math.max(0, this._backlog - entries.length);
			this._flushProgress();
			const message = err instanceof Error ? err.message : String(err);
			this.progressBus.emit("index:error", {
				projectId: this.projectId,
				message,
				recoverable: true,
			});
			throw err;
		}
	}

	/**
	 * Delete rows by id. For each id, also deletes any chunk rows whose
	 * id starts with `<id>:chunk:`.
	 */
	async removeEntries(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		// Direct id deletion (and parent_id-keyed chunk sweep).
		await this.lance.deleteByIds(ids);
		// Delete any orphan chunks keyed by parent_id.
		const list = ids.map((id) => `'${escapeSql(id)}'`).join(",");
		await this.lance.deleteByFilter(`parent_id IN (${list})`);
	}

	/** Delete rows matching a raw SQL filter (passthrough to LanceStore). */
	async removeByFilter(sql: string): Promise<void> {
		await this.lance.deleteByFilter(sql);
	}

	/**
	 * Drop the content table and rebuild from the supplied sources.
	 * Emits `index:progress { phase: "rebuild" }` as work streams in,
	 * `index:complete` on success, `index:error` and rethrows on failure.
	 *
	 * Sources are iterated serially (order matters for progress totals,
	 * which are cumulative — we don't know the final count up front).
	 */
	async rebuildFromSources(
		sources: IndexSource[],
		ctx: IndexSourceContext,
	): Promise<void> {
		const startedAt = Date.now();
		this._pendingPhase = "rebuild";
		this._pendingTotal = 0;
		this._pendingCompleted = 0;

		try {
			await this.embedder.ready();

			// Clear the content table (filter that always matches).
			await this.lance.deleteByFilter("true");

			let rowsWritten = 0;
			let buffer: Indexable[] = [];
			const FLUSH_AT = EMBED_BATCH_SIZE;

			const flush = async () => {
				if (buffer.length === 0) return;
				const expanded = this._expandWithChunks(buffer);
				for (let i = 0; i < expanded.length; i += EMBED_BATCH_SIZE) {
					const batch = expanded.slice(i, i + EMBED_BATCH_SIZE);
					const vecs = await this.embedder.embed(
						batch.map((b) => DOCUMENT_PREFIX + b.row.text),
						"document",
					);
					const rows: ContentRow[] = batch.map((b, j) => ({
						...b.row,
						embedding: vecs[j],
					}));
					for (let k = 0; k < rows.length; k += UPSERT_BATCH_SIZE) {
						await this.lance.upsert(rows.slice(k, k + UPSERT_BATCH_SIZE));
					}
					rowsWritten += rows.length;
				}
				this._pendingCompleted += buffer.length;
				this._scheduleProgress();
				buffer = [];
			};

			for (const src of sources) {
				for await (const entry of src.iterate(ctx)) {
					buffer.push(entry);
					this._pendingTotal++;
					if (buffer.length >= FLUSH_AT) {
						await flush();
					}
				}
			}
			await flush();
			this._flushProgress();

			// Lazy index creation past the threshold.
			const finalCount = await this.lance.count();
			if (finalCount > ROWS_BEFORE_INDEX) {
				await this.lance.createIndexes();
				this._lastIndexBuildAt = Date.now();
				this._rowsSinceLastIndex = 0;
			}

			// Stamp the meta row with the active runtime fingerprint.
			await this.lance.writeMeta(
				buildCurrentMeta({
					embedderId: this.embedder.id,
					dim: this.embedder.dim,
					contentPolicyVersion: CONTENT_POLICY_VERSION,
				}),
			);

			this.progressBus.emit("index:complete", {
				projectId: this.projectId,
				phase: "rebuild",
				durationMs: Date.now() - startedAt,
				rowsWritten,
			});
		} catch (err) {
			this._flushProgress();
			const message = err instanceof Error ? err.message : String(err);
			this.progressBus.emit("index:error", {
				projectId: this.projectId,
				message,
				recoverable: true,
			});
			throw err;
		}
	}

	// ── Internals ────────────────────────────────────────────────────

	/**
	 * Opportunistic ANN-index rebuild. Gated by:
	 *   1. Current row count > 10K.
	 *   2. Rows added since last build > 10% of total.
	 *   3. At least 60 minutes since the last build.
	 * Safe to call concurrently — a pending rebuild short-circuits.
	 * Exposed for tests.
	 */
	async _maybeRebuildIndexes(nowMs: number = Date.now()): Promise<boolean> {
		if (this._indexRebuildPending) return false;
		if (this._lastIndexBuildAt > 0 && nowMs - this._lastIndexBuildAt < OPPORTUNISTIC_INDEX_COOLDOWN_MS) {
			return false;
		}
		let rowCount: number;
		try {
			rowCount = await this.lance.count();
		} catch {
			return false;
		}
		if (rowCount <= ROWS_BEFORE_INDEX) return false;
		if (this._rowsSinceLastIndex <= rowCount * OPPORTUNISTIC_INDEX_RATIO) return false;

		this._indexRebuildPending = true;
		try {
			await this.lance.createIndexes();
			this._lastIndexBuildAt = nowMs;
			this._rowsSinceLastIndex = 0;
			return true;
		} finally {
			this._indexRebuildPending = false;
		}
	}

	private async _filterUnchanged(entries: Indexable[]): Promise<Indexable[]> {
		if (entries.length === 0) return entries;
		const ids = entries.map((e) => e.id);
		const list = ids.map((id) => `'${escapeSql(id)}'`).join(",");
		// Long entries get chunked — only chunk rows with `parent_id = <id>`
		// exist in the store, so we must match either direct ids OR parent_id
		// to avoid re-embedding unchanged long entries on every upsert.
		let existing: Array<{ id: string; parent_id: string | null; content_hash: string }> = [];
		try {
			existing = (await this.lance
				.query()
				.where(`id IN (${list}) OR parent_id IN (${list})`)
				.select(["id", "parent_id", "content_hash"])
				// Allow up to `ids.length * (reasonable chunks per entry)` rows;
				// we just need any one chunk per parent to confirm the hash.
				.limit(Math.max(ids.length * 64, ids.length))
				.toArray()) as Array<{ id: string; parent_id: string | null; content_hash: string }>;
		} catch {
			existing = [];
		}
		// Collapse by the logical entry key: parent_id if set (chunk rows),
		// else the row's own id. All chunks of a given parent share the
		// parent's contentHash, so any one row suffices.
		const hashByEntryId = new Map<string, string>();
		for (const r of existing) {
			const key = r.parent_id ?? r.id;
			if (!hashByEntryId.has(key)) hashByEntryId.set(key, r.content_hash);
		}
		return entries.filter((e) => hashByEntryId.get(e.id) !== e.contentHash);
	}

	/**
	 * Convert a list of `Indexable`s into concrete ContentRow stubs
	 * (without `embedding`) plus an originalIndex back-pointer so we can
	 * tally progress per-parent. Long text is chunked — each chunk
	 * becomes its own row with `parent_id` = the original id.
	 */
	private _expandWithChunks(entries: Indexable[]): Array<{
		originalIndex: number;
		row: Omit<ContentRow, "embedding">;
	}> {
		const out: Array<{
			originalIndex: number;
			row: Omit<ContentRow, "embedding">;
		}> = [];
		for (let i = 0; i < entries.length; i++) {
			const e = entries[i];
			if (!e.text || e.text.trim().length === 0) continue;

			const tokenCount = this.embedder.countTokens(e.text);
			if (tokenCount <= this.maxTokens) {
				out.push({ originalIndex: i, row: indexableToRow(e, e.text, null) });
				continue;
			}

			const chunks = chunkText(e.text, e.id, {
				maxTokens: this.maxTokens,
				overlap: this.chunkOverlap,
				countTokens: (t) => this.embedder.countTokens(t),
			});
			for (const c of chunks) {
				const chunkRow = indexableToRow(e, c.text, e.id);
				chunkRow.id = c.id;
				out.push({ originalIndex: i, row: chunkRow });
			}
		}
		return out;
	}

	private _scheduleProgress(): void {
		const now = Date.now();
		const elapsed = now - this._lastProgressEmit;
		if (elapsed >= this.progressDebounceMs) {
			this._flushProgress();
			return;
		}
		if (this._progressTimer) return;
		const delay = this.progressDebounceMs - elapsed;
		this._progressTimer = setTimeout(() => {
			this._progressTimer = null;
			this._flushProgress();
		}, delay);
		// Don't keep the event loop alive for progress debouncing.
		if (typeof this._progressTimer.unref === "function") {
			this._progressTimer.unref();
		}
	}

	private _flushProgress(): void {
		if (this._progressTimer) {
			clearTimeout(this._progressTimer);
			this._progressTimer = null;
		}
		this._lastProgressEmit = Date.now();
		this.progressBus.emit("index:progress", {
			projectId: this.projectId,
			phase: this._pendingPhase,
			total: this._pendingTotal,
			completed: this._pendingCompleted,
			backlog: this._backlog,
		});
	}
}

// ── Pure helpers ────────────────────────────────────────────────────

/**
 * Map `Indexable` → `ContentRow` (minus `embedding`). Scoped to this
 * module so the SearchService and tests share the same row derivation.
 *
 * - `entity_type` is derived from `sourceId` (goals → goal, sessions →
 *   session, messages → message, staff → staff, files → file).
 * - Metadata flat-unpacks `goal_id` / `session_id` / `session_title`
 *   when present.
 * - V2-only file fields (`file_path`, `start_line`, `end_line`) are
 *   populated from `display` when set.
 */
export function indexableToRow(
	e: Indexable,
	text: string,
	parentId: string | null,
): Omit<ContentRow, "embedding"> {
	const md = e.metadata ?? {};
	const goalId = pickString(md.goal_id ?? md.goalId);
	const sessionId = pickString(md.session_id ?? md.sessionId);
	const sessionTitle = pickString(md.session_title ?? md.sessionTitle);

	const title = e.display?.title ?? null;
	const filePath = e.display?.filePath ?? null;
	const startLine = typeof e.display?.startLine === "number" ? e.display.startLine : null;
	const endLine = typeof e.display?.endLine === "number" ? e.display.endLine : null;

	return {
		id: e.id,
		source_id: e.sourceId,
		project_id: e.projectId,
		entity_type: entityTypeFor(e.sourceId),
		parent_id: parentId,
		archived: e.archived === true,
		timestamp: e.timestamp,
		content_hash: e.contentHash,
		weight: e.weight,
		role: e.role ?? null,
		title,
		text,
		goal_id: goalId,
		session_id: sessionId,
		session_title: sessionTitle,
		file_path: filePath,
		start_line: startLine,
		end_line: endLine,
	};
}

function entityTypeFor(sourceId: Indexable["sourceId"]): string {
	switch (sourceId) {
		case "goals":
			return "goal";
		case "sessions":
			return "session";
		case "messages":
			return "message";
		case "staff":
			return "staff";
		case "files":
			return "file";
	}
}

function pickString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function escapeSql(s: string): string {
	return s.replace(/'/g, "''");
}
