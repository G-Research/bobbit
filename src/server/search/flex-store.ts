/**
 * `FlexSearchStore` — pure-JS lexical search store that replaces both
 * `LanceStore` and `HybridQuery`. BM25-style ranking only; no
 * embeddings, no native binaries, no network.
 *
 * - Document index via FlexSearch's `Document` class.
 * - Three indexed fields: `title` (forward + LatinAdvanced),
 *   `text` (forward + LatinAdvanced), `identifier_text` (strict +
 *   Simple, derived from `text`/`title` via camel/snake/kebab/path
 *   splitting).
 * - Tag filtering on `source_id`, `project_id`, `archived`.
 * - Per-document `weight` and recency boost applied post-rank.
 * - `parent_id` collapse keeps the single highest-scoring chunk per
 *   logical entry.
 * - Persistence to `<dataDir>/index/<key>.json` with atomic tmp+rename
 *   and a 500ms trailing debounce.
 *
 * See docs/design/portable-search.md §4, §5, §6, §9.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Document as FlexDocument } from "flexsearch";
import { performance } from "node:perf_hooks";
import { recordEventLoopOperation } from "../agent/cpu-diagnostics.js";
import { isMessageAuthor, type MessageAuthorKind } from "../../shared/message-author.js";
import { profileAsync } from "../agent/profiling.js";
import { highlight } from "./snippet.js";
import {
	type MetaRow,
	readMeta as readMetaRow,
	writeMeta as writeMetaRow,
	type MetaRowPersisted,
} from "./meta.js";
import type { Indexable, SearchQuery, SearchResult, SearchResults } from "./types.js";

/**
 * Atomic rename that works on Windows.
 *
 * POSIX `rename(2)` is atomic and silently replaces the destination.
 * On Windows, `fs.rename` over an existing file raises EPERM (-4048).
 * The workaround is to unlink the destination first, then rename.
 * The window between unlink and rename is tiny; we accept the theoretical
 * non-atomicity because the alternative is a persistent error loop.
 */
async function atomicRename(src: string, dest: string): Promise<void> {
	try {
		await fs.promises.rename(src, dest);
	} catch (err) {
		const e = err as NodeJS.ErrnoException;
		if ((e.code === "EPERM" || e.code === "EEXIST") && os.platform() === "win32") {
			try { await fs.promises.unlink(dest); } catch { /* dest may not exist */ }
			await fs.promises.rename(src, dest);
		} else {
			throw err;
		}
	}
}

// Minimal typing for the subset of FlexSearch we touch. FlexSearch's
// shipped types describe both sync and Promise return shapes; we use
// only the synchronous ones, valid for the small corpora Bobbit has.
type FlexDocumentInstance = InstanceType<typeof FlexDocument>;

// ── Constants ────────────────────────────────────────────────────────

export { FLEX_VERSION } from "./constants.js";

/** Default `limit` when the caller omits one. */
const DEFAULT_LIMIT = 20;

/** Fetch multiplier before parent_id collapse — gives dedupe headroom. */
const PRE_COLLAPSE_MULTIPLIER = 3;

/** RRF-style constant. Keeps the rank-gap small so weight + recency can
 * re-order closely-ranked hits. */
const RANK_K = 100;

/** Field-level score boosts (higher = ranks first when tied on rank). */
const FIELD_BOOST = {
	identifier_text: 2.0,
	title: 1.5,
	text: 1.0,
} as const;

/** Recency boost parameters — boost tops out at +20% for fresh rows, decays
 * with a 30-day half-life back to ×1.0. */
const RECENCY_MAX_MULTIPLIER = 0.2; // +20% for t = now
const RECENCY_HALF_LIFE_DAYS = 30;

const SOURCE_ID_TO_TYPE: Record<Indexable["sourceId"], SearchResult["type"]> = {
	goals: "goal",
	sessions: "session",
	messages: "message",
	staff: "staff",
	files: "file",
};

const META_FILE = "meta.json";
const INDEX_SUBDIR = "index";
export const FLEX_EXPORT_BUNDLE_FILE = "__index__.json";
/** Legacy cache version; exports are no longer persisted. */
export const FLEX_EXPORT_BUNDLE_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 500;
const JOURNAL_FILE = "__docs__.journal";
const SNAPSHOT_FILE = "__docs__.json";
const JOURNAL_COMPACT_BYTES = 8 * 1024 * 1024;

// ── Doc shape ────────────────────────────────────────────────────────

export interface FlexDoc {
	id: string;
	source_id: Indexable["sourceId"];
	project_id: string;
	entity_type: SearchResult["type"];
	parent_id: string | null;
	archived: boolean;
	/** Stringified boolean — FlexSearch `tag` values are strings. */
	archived_tag: "true" | "false";
	timestamp: number;
	content_hash: string;
	weight: number;
	role: string | null;
	title: string | null;
	text: string;
	identifier_text: string;
	goal_id: string | null;
	session_id: string | null;
	session_title: string | null;
	/** Optional for backward compatibility with indexes written before author metadata. */
	author_kind?: MessageAuthorKind | null;
	author_id?: string | null;
	author_label?: string | null;
	file_path: string | null;
	start_line: number | null;
	end_line: number | null;
}

// ── Options ──────────────────────────────────────────────────────────

export interface FlexStorePersistenceMetric {
	label: string;
	durationMs: number;
	bytes: number;
	phase: "serialize" | "write";
}

export interface FlexSearchStoreOpenOptions {
	/** Directory holding the index (e.g. `.bobbit/state/search.flex`). */
	dataDir: string;
	/** Runs in the owning worker after each serialization/write boundary. */
	onPersistenceMetric?: (metric: FlexStorePersistenceMetric) => void;
}

export interface FlexSearchStats {
	rowCountsBySource: { goals: number; sessions: number; messages: number; staff: number; files: number };
	totalRows: number;
	datasetBytes: number;
	lastRebuildAt: number | null;
}

// ── Helpers (exported for tests) ─────────────────────────────────────

/**
 * Extract identifier-like tokens from text: camelCase, snake_case,
 * kebab-case, dotted paths, and file paths split on `/`, `\`, `.`.
 * The raw token and its decomposed parts both appear so that exact
 * matches on either form succeed under strict tokenization.
 */
export function extractIdentifierTokens(text: string): string {
	if (!text) return "";
	const out: string[] = [];
	const raw = text.match(/[A-Za-z_][A-Za-z0-9_./\\-]{1,63}/g) ?? [];
	for (const tok of raw) {
		out.push(tok);
		const camelParts = tok.split(/(?=[A-Z])/).filter((s) => s.length > 0);
		if (camelParts.length > 1) out.push(...camelParts);
		const parts = tok.split(/[_./\\-]+/).filter((s) => s.length > 0);
		if (parts.length > 1) out.push(...parts);
	}
	return out.join(" ");
}

/** Build the tag filter object consumed by FlexSearch `.search(..., {tag})`. */
export function buildTagFilter(q: SearchQuery): Array<{ field: string; tag: string | string[] }> {
	const tags: Array<{ field: string; tag: string | string[] }> = [];
	if (q.projectId) tags.push({ field: "project_id", tag: q.projectId });
	if (!q.includeArchived) tags.push({ field: "archived_tag", tag: "false" });
	if (q.types && q.types.length > 0) tags.push({ field: "source_id", tag: q.types });
	return tags;
}

// Row with added score fields used internally.
interface ScoredDoc extends FlexDoc {
	_score: number;
}

type MirrorOperation =
	| { op: "upsert"; doc: FlexDoc }
	| { op: "delete"; ids: string[] }
	| { op: "clear" };

/**
 * The mirror is an append-only operation log plus an occasional snapshot.
 * Sequences make a completed snapshot authoritative over any pre-compaction
 * journal tail left behind if the process dies between the two atomic renames.
 */
const MIRROR_FORMAT_VERSION = 1;

type VersionedJournalRecord = {
	version: typeof MIRROR_FORMAT_VERSION;
	sequence: number;
	operation: MirrorOperation;
};

type MirrorSnapshot = {
	version: typeof MIRROR_FORMAT_VERSION;
	throughSequence: number;
	docs: FlexDoc[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFlexDoc(value: unknown): value is FlexDoc {
	return isRecord(value) && typeof value.id === "string";
}

function isMirrorOperation(value: unknown): value is MirrorOperation {
	if (!isRecord(value) || typeof value.op !== "string") return false;
	if (value.op === "clear") return true;
	if (value.op === "delete") return Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string");
	return value.op === "upsert" && isFlexDoc(value.doc);
}

function parseVersionedJournalRecord(value: unknown): VersionedJournalRecord | null {
	if (!isRecord(value) || value.version !== MIRROR_FORMAT_VERSION || !isSequence(value.sequence) || !isMirrorOperation(value.operation)) return null;
	return { version: MIRROR_FORMAT_VERSION, sequence: value.sequence, operation: value.operation };
}

function parseMirrorSnapshot(value: unknown): MirrorSnapshot | null {
	if (!isRecord(value) || value.version !== MIRROR_FORMAT_VERSION || !isSequence(value.throughSequence)) return null;
	const docs = value.docs;
	if (!Array.isArray(docs) || !docs.every(isFlexDoc)) return null;
	return { version: MIRROR_FORMAT_VERSION, throughSequence: value.throughSequence, docs };
}

// ── Store ────────────────────────────────────────────────────────────

export class FlexSearchStore {
	readonly dataDir: string;
	private _idx: FlexDocumentInstance;
	private readonly _docs: Map<string, FlexDoc> = new Map();
	/** Entry id → content hash for chunk parents, avoiding an O(n) scan. */
	private readonly _parentHashes = new Map<string, string>();
	/** Parent id → its currently materialized chunk ids, for correct O(1) cleanup. */
	private readonly _parentDocIds = new Map<string, Set<string>>();
	private _indexBuilt = false;
	private _saveTimer: NodeJS.Timeout | null = null;
	private _journal: string[] = [];
	private _journalBytes = 0;
	/** Highest operation sequence observed or assigned in this process. */
	private _journalSequence = 0;
	private _flushInFlight: Promise<void> | null = null;
	private _flushAgain = false;
	private _dirty = false;
	/** Compaction requests and completed snapshots share the flush serialisation lane. */
	private _snapshotRequest = 0;
	private _snapshotWritten = 0;
	private _closed = false;
	private _atomicRename = atomicRename;
	private readonly _onPersistenceMetric?: (metric: FlexStorePersistenceMetric) => void;

	private constructor(dataDir: string, onPersistenceMetric?: (metric: FlexStorePersistenceMetric) => void) {
		this.dataDir = dataDir;
		this._onPersistenceMetric = onPersistenceMetric;
		this._idx = FlexSearchStore._newIndex();
	}

	private static _newIndex(): FlexDocumentInstance {
		return new FlexDocument({
			document: {
				id: "id",
				index: [
							// `text` is deliberately exact-token only. The mirror remains the
					// source of truth; lowering resolution and disabling Flex's duplicate
					// document store reduces derived-index memory substantially.
					{ field: "title", tokenize: "forward", encoder: "LatinAdvanced", resolution: 3 },
					{ field: "text", tokenize: "strict", encoder: "LatinAdvanced", resolution: 3 },
					// Identifier field: strict tokenization preserves whole tokens; a
					// minimal encoder with disabled stemming/normalisation keeps
					// exact symbol lookups intact.
					{ field: "identifier_text", tokenize: "strict", encoder: { normalize: true, dedupe: false }, resolution: 9 },
				],
				tag: [
					{ field: "source_id" },
					{ field: "project_id" },
					{ field: "archived_tag" },
				],
				// Search always resolves hits against `_docs`, so Flex's stored copy
				// only amplified the derived index.
				store: false,
			},
			cache: 100,
		});
	}

	static async open(opts: FlexSearchStoreOpenOptions): Promise<FlexSearchStore> {
		await fs.promises.mkdir(path.join(opts.dataDir, INDEX_SUBDIR), { recursive: true });
		const store = new FlexSearchStore(opts.dataDir, opts.onPersistenceMetric);
		await store._loadFromDisk();
		return store;
	}

	// ── Mutations ────────────────────────────────────────────────────

	async upsert(docs: FlexDoc[]): Promise<void> {
		if (this._closed) throw new Error("FlexSearchStore: already closed");
		for (const d of docs) {
			const prepared = this._prepare(d);
			this._setDoc(prepared);
			// Do not build derived state until a query needs it. Live updates are
			// applied when it already exists, keeping query results current.
			if (this._indexBuilt) (this._idx.update as unknown as (id: string, d: unknown) => void)(prepared.id, prepared);
			this._appendJournal({ op: "upsert", doc: prepared });
		}
		this._scheduleSave();
	}

	async deleteByIds(ids: string[]): Promise<void> {
		if (this._closed) throw new Error("FlexSearchStore: already closed");
		if (ids.length === 0) return;
		const idSet = new Set(ids);
		// Remove direct rows.
		for (const id of ids) this._deleteDoc(id);
		// Cascade delete of any chunk rows whose parent_id matches.
		const chunkVictims: string[] = [];
		for (const [id, doc] of this._docs) {
			if (doc.parent_id && idSet.has(doc.parent_id)) chunkVictims.push(id);
		}
		for (const id of chunkVictims) this._deleteDoc(id);
		this._appendJournal({ op: "delete", ids: [...ids, ...chunkVictims] });
		this._scheduleSave();
	}

	/**
	 * Structured filter-style delete. Unlike LanceStore's raw-SQL filter
	 * this accepts only known keys — no injection surface.
	 */
	async deleteWhere(filter: {
		source_id?: Indexable["sourceId"];
		session_id?: string;
		project_id?: string;
		parent_id?: string | string[] | null;
	}): Promise<void> {
		if (this._closed) throw new Error("FlexSearchStore: already closed");
		const parentSet =
			filter.parent_id == null
				? null
				: Array.isArray(filter.parent_id)
					? new Set(filter.parent_id)
					: new Set([filter.parent_id]);
		const victims: string[] = [];
		for (const [id, d] of this._docs) {
			if (filter.source_id && d.source_id !== filter.source_id) continue;
			if (filter.session_id && d.session_id !== filter.session_id) continue;
			if (filter.project_id && d.project_id !== filter.project_id) continue;
			if (parentSet && (!d.parent_id || !parentSet.has(d.parent_id))) continue;
			victims.push(id);
		}
		for (const id of victims) this._deleteDoc(id);
		if (victims.length > 0) {
			this._appendJournal({ op: "delete", ids: victims });
			this._scheduleSave();
		}
	}

	async clear(): Promise<void> {
		if (this._closed) throw new Error("FlexSearchStore: already closed");
		// Discard the whole index in O(1) by recreating it. Removing documents
		// one-by-one via FlexSearch's `Document.remove` is O(n) PER call (it
		// scrubs the id from every posting list), so clearing N docs is O(n²) —
		// a synchronous tight loop that freezes the event loop on a large index
		// and wedges boot during the content-policy version-bump rebuild
		// (rebuildFromSources calls clear() first). `_docs` is the authoritative
		// mirror; a fresh index + cleared mirror is equivalent to removing every
		// entry. (`Document.clear` exists but is inconsistently async, hence the
		// recreate rather than calling it.)
		this._idx = FlexSearchStore._newIndex();
		this._indexBuilt = true;
		this._docs.clear();
		this._parentHashes.clear();
		this._parentDocIds.clear();
		this._appendJournal({ op: "clear" });
		this._scheduleSave();
	}

	/**
	 * Lookup by id — used for contentHash deduplication in the Indexer.
	 * Synchronous; the backing Map is always in memory.
	 */
	getById(id: string): FlexDoc | null {
		return this._docs.get(id) ?? null;
	}

	/** Return the contentHash of any doc whose `id === id` OR `parent_id === id`. */
	getHashForEntry(entryId: string): string | null {
		const direct = this._docs.get(entryId);
		return direct?.content_hash ?? this._parentHashes.get(entryId) ?? null;
	}

	count(filter?: { source_id?: Indexable["sourceId"]; project_id?: string }): number {
		if (!filter || (!filter.source_id && !filter.project_id)) return this._docs.size;
		let n = 0;
		for (const d of this._docs.values()) {
			if (filter.source_id && d.source_id !== filter.source_id) continue;
			if (filter.project_id && d.project_id !== filter.project_id) continue;
			n++;
		}
		return n;
	}

	list(opts: {
		source_id?: Indexable["sourceId"];
		project_id?: string;
		limit: number;
	}): FlexDoc[] {
		const out: FlexDoc[] = [];
		for (const d of this._docs.values()) {
			if (opts.source_id && d.source_id !== opts.source_id) continue;
			if (opts.project_id && d.project_id !== opts.project_id) continue;
			out.push(d);
			if (out.length >= opts.limit) break;
		}
		return out;
	}

	// ── Query ────────────────────────────────────────────────────────

	async search(q: SearchQuery): Promise<SearchResults> {
		const queryText = (q.q ?? "").trim();
		if (queryText.length === 0) return { results: [], total: 0 };
		await this._ensureIndex();

		const limit = q.limit ?? DEFAULT_LIMIT;
		const offset = q.offset ?? 0;
		const fetchLimit = Math.max(limit * PRE_COLLAPSE_MULTIPLIER, limit);

		const tagFilter = buildTagFilter(q);
		const searchOpts: Record<string, unknown> = {
			limit: fetchLimit,
			suggest: true,
			enrich: true,
			index: ["identifier_text", "title", "text"],
		};
		if (tagFilter.length > 0) searchOpts.tag = tagFilter;

		let rawResults: unknown;
		try {
			rawResults = this._idx.search(queryText, searchOpts);
		} catch (err) {
			// Malformed query characters can throw inside FlexSearch. Treat
			// as empty rather than propagating — search must never crash
			// the request path.
			console.warn("[search] FlexSearch query failed:", err);
			return { results: [], total: 0 };
		}

		// Awaited form for any future async swap.
		const perField = (await rawResults) as Array<{
			field: string;
			result: Array<{ id: string; doc?: FlexDoc } | string | number>;
		}>;

		// Blend field scores → Σ fieldBoost[field] / (rank + 1).
		const scored = new Map<string, ScoredDoc>();
		const now = Date.now();
		for (const group of perField ?? []) {
			const boost =
				(FIELD_BOOST as Record<string, number>)[group.field] ?? 1.0;
			let rank = 0;
			for (const hit of group.result ?? []) {
				// `store:false` returns ids even with `enrich`; the mirror is
				// authoritative in either shape.
				const hitId = typeof hit === "string" || typeof hit === "number"
					? String(hit)
					: String(hit.id);
				const doc = this._docs.get(hitId);
				if (!doc) { rank++; continue; }
				// Apply tag filters defensively — FlexSearch honours them,
				// but we guard against unknown encodings.
				if (!this._matchesTagFilter(doc, q)) { rank++; continue; }
				// RRF-style `1/(rank + k)` with `k=10` so the boost between
				// rank 0 and rank 1 is ~10%, letting per-doc weight and
				// recency dominate ordering ties.
				const contribution = boost / (rank + RANK_K);
				const existing = scored.get(doc.id);
				if (existing) {
					existing._score += contribution;
				} else {
					scored.set(doc.id, { ...doc, _score: contribution });
				}
				rank++;
			}
		}

		// Apply weight + recency.
		for (const doc of scored.values()) {
			const weight = typeof doc.weight === "number" && doc.weight > 0 ? doc.weight : 1.0;
			doc._score *= weight;
			doc._score *= recencyMultiplier(doc.timestamp, now);
		}

		// Sort desc by score; ties → newer timestamp; ties → id asc.
		const sorted = Array.from(scored.values()).sort((a, b) => {
			if (b._score !== a._score) return b._score - a._score;
			if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});

		// Collapse by parent_id ?? id.
		const seenParent = new Set<string>();
		const collapsed: ScoredDoc[] = [];
		for (const doc of sorted) {
			const key = doc.parent_id && doc.parent_id.length > 0 ? doc.parent_id : doc.id;
			if (seenParent.has(key)) continue;
			seenParent.add(key);
			collapsed.push(doc);
		}

		const windowed = collapsed.slice(offset, offset + limit);
		const results = windowed.map((d) => toSearchResult(d, queryText, d._score));
		return { results, total: collapsed.length };
	}

	private _matchesTagFilter(doc: FlexDoc, q: SearchQuery): boolean {
		if (q.projectId && doc.project_id !== q.projectId) return false;
		if (!q.includeArchived && doc.archived) return false;
		if (q.types && q.types.length > 0 && !q.types.includes(doc.source_id)) return false;
		return true;
	}

	// ── Meta ─────────────────────────────────────────────────────────

	async readMeta(): Promise<MetaRow | null> {
		try {
			const buf = await fs.promises.readFile(path.join(this.dataDir, META_FILE), "utf-8");
			const parsed = JSON.parse(buf) as MetaRowPersisted;
			return readMetaRow(parsed);
		} catch {
			return null;
		}
	}

	async writeMeta(meta: MetaRow): Promise<void> {
		const final = path.join(this.dataDir, META_FILE);
		const tmp = `${final}.tmp`;
		try {
			await fs.promises.mkdir(this.dataDir, { recursive: true });
			await fs.promises.writeFile(tmp, JSON.stringify(writeMetaRow(meta)), "utf-8");
			await atomicRename(tmp, final);
		} catch (err) {
			if (this._isBenignTeardownError(err)) return;
			throw err;
		}
	}

	/**
	 * True when a filesystem write failed because the target dir was removed
	 * concurrently AND this store is already closed — i.e. a flush lost the
	 * race against teardown removing the temp `.bobbit` state dir. ENOENT is
	 * the POSIX symptom; Windows can surface EPERM/EBUSY against a vanishing
	 * directory. Only benign once `_closed === true`; genuine open-store
	 * write failures must still surface.
	 */
	private _isBenignTeardownError(err: unknown): boolean {
		if (!this._closed) return false;
		const code = (err as NodeJS.ErrnoException)?.code;
		return code === "ENOENT" || code === "EPERM" || code === "EBUSY";
	}

	/** Compact the append-only mirror into one atomic snapshot. */
	async compact(): Promise<void> {
		// Never write `${SNAPSHOT_FILE}.tmp` outside the flush lane: a debounce
		// flush and an admin compaction otherwise race over the same temp path.
		const request = ++this._snapshotRequest;
		do {
			this._dirty = true;
			await this._flushNow();
		} while (this._snapshotWritten < request);
	}

	/** Flush pending writes. Used by SearchService.close(). */
	async close(): Promise<void> {
		if (this._closed) return;
		this._closed = true;
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this._saveTimer = null;
		}
		if (this._flushInFlight) {
			try { await this._flushInFlight; } catch { /* non-fatal */ }
		}
		try { await this._flushNow(); } catch (err) {
			console.error("[search] final flush failed:", err);
		}
	}

	// ── Persistence internals ────────────────────────────────────────

	private _scheduleSave(): void {
		if (this._closed) return;
		this._dirty = true;
		if (this._saveTimer) return;
		this._saveTimer = setTimeout(() => {
			this._saveTimer = null;
			if (!this._closed) void this._flushNow().catch((err) => console.error("[search] mirror persistence failed:", err));
		}, FLUSH_DEBOUNCE_MS);
		this._saveTimer.unref?.();
	}

	private async _flushNow(): Promise<void> {
		if (this._flushInFlight) { this._flushAgain = true; await this._flushInFlight; }
		if (!this._dirty) return;
		this._dirty = false;
		const task = this._doFlush().catch((err) => { this._dirty = true; throw err; });
		this._flushInFlight = task;
		try { await task; } finally { this._flushInFlight = null; }
		if (this._flushAgain || this._dirty) { this._flushAgain = false; await this._flushNow(); }
	}

	private async _doFlush(): Promise<void> {
		return profileAsync("flexStore.mirrorFlush", async () => {
			try {
				const dir = path.join(this.dataDir, INDEX_SUBDIR);
				await fs.promises.mkdir(dir, { recursive: true });
				const journal = this._journal.splice(0);
				const journalBytes = this._journalBytes;
				this._journalBytes = 0;
				if (journal.length > 0) {
					const serializeStartedAt = performance.now();
					const serialized = journal.join("");
					this._recordPersistenceMetric("mirror-journal", "serialize", performance.now() - serializeStartedAt, Buffer.byteLength(serialized));
					const writeStartedAt = performance.now();
					try {
						await fs.promises.appendFile(path.join(dir, JOURNAL_FILE), serialized, "utf-8");
					} catch (err) {
						// The operations are not durable until append succeeds. Put them
						// back so _flushNow's retry cannot silently lose a mutation.
						this._journal.unshift(...journal);
						this._journalBytes += journalBytes;
						throw err;
					}
					this._recordPersistenceMetric("mirror-journal", "write", performance.now() - writeStartedAt, Buffer.byteLength(serialized));
				}
				let size = 0;
				try { size = (await fs.promises.stat(path.join(dir, JOURNAL_FILE))).size; } catch { /* no journal */ }
				// A bounded journal prevents unbounded recovery time. Compaction is
				// deliberately worker-only and never serialises FlexSearch exports.
				const snapshotRequest = this._snapshotRequest;
				if (this._snapshotWritten < snapshotRequest || size >= JOURNAL_COMPACT_BYTES || (this._closed && journalBytes > 0)) {
					await this._writeSnapshot(dir);
					// A compact request carries no mutation of its own. The worker serializes
					// requests, so every compact request that arrived while this snapshot
					// was in flight observes this same mirror state. Mark them all fulfilled
					// instead of launching a redundant second full serialization (which also
					// made concurrent compact callers wait for an unnecessary snapshot).
					this._snapshotWritten = Math.max(this._snapshotWritten, this._snapshotRequest, snapshotRequest);
				}
			} catch (err) {
				if (this._isBenignTeardownError(err)) return;
				throw err;
			}
		});
	}

	private async _writeSnapshot(dir: string): Promise<void> {
		const final = path.join(dir, SNAPSHOT_FILE);
		const tmp = `${final}.tmp`;
		// Capture docs and their high-water mark without an await between them.
		// A mutation that arrives during the following I/O gets a higher sequence
		// and remains journaled; a mutation included here is covered by the
		// snapshot even if its queued journal append has not run yet.
		const snapshot: MirrorSnapshot = {
			version: MIRROR_FORMAT_VERSION,
			throughSequence: this._journalSequence,
			docs: [...this._docs.values()],
		};
		const serializeStartedAt = performance.now();
		const serialized = JSON.stringify(snapshot);
		const bytes = Buffer.byteLength(serialized);
		this._recordPersistenceMetric("mirror-snapshot", "serialize", performance.now() - serializeStartedAt, bytes);
		const writeStartedAt = performance.now();
		await fs.promises.writeFile(tmp, serialized, "utf-8");
		await this._atomicRename(tmp, final);
		this._recordPersistenceMetric("mirror-snapshot", "write", performance.now() - writeStartedAt, bytes);
		// Never blindly truncate: after the snapshot rename, retain exactly the
		// records newer than its high-water mark. This makes either side of a
		// crash between the snapshot and journal renames recover equivalently.
		await this._rewriteJournalAfterSnapshot(dir, snapshot.throughSequence);
	}

	private async _rewriteJournalAfterSnapshot(dir: string, throughSequence: number): Promise<void> {
		const journal = path.join(dir, JOURNAL_FILE);
		const retained: string[] = [];
		try {
			const raw = await fs.promises.readFile(journal, "utf-8");
			for (const line of raw.split("\n")) {
				if (!line) continue;
				try {
					const record = parseVersionedJournalRecord(JSON.parse(line));
					if (record && record.sequence > throughSequence) retained.push(`${line}\n`);
				} catch { /* corrupt records are already ignored during recovery */ }
			}
		} catch { /* no journal yet */ }

		// Entries appended while snapshot I/O was in flight have not necessarily
		// reached disk. Drop only queued entries already covered by the snapshot;
		// the later entries stay queued and will be appended by the next flush.
		this._journal = this._journal.filter((line) => {
			try {
				const record = parseVersionedJournalRecord(JSON.parse(line));
				return record !== null && record.sequence > throughSequence;
			} catch {
				return false;
			}
		});
		this._journalBytes = this._journal.reduce((total, line) => total + Buffer.byteLength(line), 0);

		const serialized = retained.join("");
		const journalTmp = `${journal}.tmp`;
		await fs.promises.writeFile(journalTmp, serialized, "utf-8");
		await this._atomicRename(journalTmp, journal);
	}

	private async _loadFromDisk(): Promise<void> {
		const dir = path.join(this.dataDir, INDEX_SUBDIR);
		let snapshotThroughSequence = 0;
		try {
			const raw = await fs.promises.readFile(path.join(dir, SNAPSHOT_FILE), "utf-8");
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				// Pre-sequence snapshots were a bare document array. They have no
				// high-water mark, so retain the old replay-all-journal behaviour.
				for (const d of parsed) if (isFlexDoc(d)) this._setDoc(this._prepare(d));
			} else {
				const snapshot = parseMirrorSnapshot(parsed);
				if (!snapshot) throw new Error("unsupported mirror snapshot");
				snapshotThroughSequence = snapshot.throughSequence;
				this._journalSequence = snapshotThroughSequence;
				for (const d of snapshot.docs) if (isFlexDoc(d)) this._setDoc(this._prepare(d));
			}
		} catch { /* fresh or corrupt mirror; normal rebuild path handles it */ }
		try {
			const raw = await fs.promises.readFile(path.join(dir, JOURNAL_FILE), "utf-8");
			let lastReplayedSequence = snapshotThroughSequence;
			for (const line of raw.split("\n")) {
				if (!line) continue;
				try {
					const parsed: unknown = JSON.parse(line);
					const record = parseVersionedJournalRecord(parsed);
					if (record) {
						this._journalSequence = Math.max(this._journalSequence, record.sequence);
						// Records at or before the snapshot high-water mark are already
						// represented in it. Reject duplicate/out-of-order newer records
						// as well; normal writes are strictly monotonic.
						if (record.sequence <= snapshotThroughSequence || record.sequence <= lastReplayedSequence) continue;
						this._applyJournal(record.operation);
						lastReplayedSequence = record.sequence;
					} else if (isMirrorOperation(parsed)) {
						// Legacy journals had bare operations and therefore no sequence.
						this._applyJournal(parsed);
					} else {
						throw new Error("invalid mirror journal record");
					}
				} catch { console.warn("[search] Ignoring corrupt mirror journal record"); }
			}
		} catch { /* no journal */ }
		// Legacy exports are derived cache data. Remove them (and interrupted
		// temp files) without attempting an expensive import/re-export cycle.
		try {
			for (const name of await fs.promises.readdir(dir)) {
				if (name === SNAPSHOT_FILE || name === JOURNAL_FILE) continue;
				if (name === FLEX_EXPORT_BUNDLE_FILE || name.endsWith(".tmp") || /\.(map|reg|tag|doc)\.json$/.test(name)) {
					await fs.promises.rm(path.join(dir, name), { force: true });
				}
			}
		} catch { /* best effort migration cleanup */ }
	}

	private async _ensureIndex(): Promise<void> {
		if (this._indexBuilt) return;
		this._idx = FlexSearchStore._newIndex();
		let n = 0;
		for (const doc of this._docs.values()) {
			(this._idx.add as unknown as (id: string, d: unknown) => void)(doc.id, doc);
			if (++n % 500 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
		}
		this._indexBuilt = true;
	}

	private _setDoc(doc: FlexDoc): void {
		const previous = this._docs.get(doc.id);
		if (previous?.parent_id) this._untrackParentDoc(previous.parent_id, previous.id);
		this._docs.set(doc.id, doc);
		if (doc.parent_id) this._trackParentDoc(doc);
	}

	private _deleteDoc(id: string): boolean {
		const doc = this._docs.get(id);
		if (!doc) return false;
		this._docs.delete(id);
		if (doc.parent_id) this._untrackParentDoc(doc.parent_id, id);
		if (this._indexBuilt) this._idx.remove(id);
		return true;
	}

	private _trackParentDoc(doc: FlexDoc): void {
		const parentId = doc.parent_id!;
		let ids = this._parentDocIds.get(parentId);
		if (!ids) this._parentDocIds.set(parentId, ids = new Set());
		ids.add(doc.id);
		this._parentHashes.set(parentId, doc.content_hash);
	}

	private _untrackParentDoc(parentId: string, docId: string): void {
		const ids = this._parentDocIds.get(parentId);
		if (!ids) return;
		ids.delete(docId);
		if (ids.size === 0) {
			this._parentDocIds.delete(parentId);
			this._parentHashes.delete(parentId);
			return;
		}
		const replacementId = ids.values().next().value as string;
		const replacement = this._docs.get(replacementId);
		if (replacement) this._parentHashes.set(parentId, replacement.content_hash);
	}


	private _appendJournal(op: MirrorOperation): void {
		const serializeStartedAt = performance.now();
		const record: VersionedJournalRecord = {
			version: MIRROR_FORMAT_VERSION,
			sequence: ++this._journalSequence,
			operation: op,
		};
		const line = JSON.stringify(record) + "\n";
		this._recordPersistenceMetric("mirror-record", "serialize", performance.now() - serializeStartedAt, Buffer.byteLength(line));
		this._journal.push(line);
		this._journalBytes += Buffer.byteLength(line);
	}

	private _recordPersistenceMetric(label: string, phase: FlexStorePersistenceMetric["phase"], durationMs: number, bytes: number): void {
		// This store is only owned by the search worker. Attribute synchronous
		// serialization to that worker's event loop, never the gateway's.
		if (phase === "serialize") recordEventLoopOperation(`search:${label}:serialize`, durationMs, { bytes });
		this._onPersistenceMetric?.({ label, phase, durationMs, bytes });
	}

	private _applyJournal(op: MirrorOperation): void {
		if (op.op === "clear") { this._docs.clear(); this._parentHashes.clear(); this._parentDocIds.clear(); return; }
		if (op.op === "delete") { for (const id of op.ids) this._deleteDoc(id); return; }
		this._setDoc(this._prepare(op.doc));
	}

	// ── Prepare ──────────────────────────────────────────────────────

	private _prepare(d: FlexDoc): FlexDoc {
		// Ensure archived_tag mirrors archived, and identifier_text is
		// derived if the caller didn't supply it.
		const archived_tag: "true" | "false" = d.archived ? "true" : "false";
		const identifier_text =
			d.identifier_text && d.identifier_text.length > 0
				? d.identifier_text
				: extractIdentifierTokens(
					[d.title ?? "", d.text ?? ""].filter((s) => s.length > 0).join(" "),
				);
		const authorCandidate = {
			kind: d.author_kind,
			id: d.author_id,
			label: d.author_label,
		};
		const author = isMessageAuthor(authorCandidate) ? authorCandidate : null;
		return {
			...d,
			archived_tag,
			identifier_text,
			author_kind: author?.kind ?? null,
			author_id: author?.id ?? null,
			author_label: author?.label ?? null,
		};
	}
}

// ── Pure helpers (exported for tests) ────────────────────────────────

export function recencyMultiplier(timestamp: number, nowMs: number = Date.now()): number {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return 1;
	const ageDays = Math.max(0, (nowMs - timestamp) / 86_400_000);
	return 1 + RECENCY_MAX_MULTIPLIER * Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function toSearchResult(doc: FlexDoc, query: string, finalScore: number): SearchResult {
	const type = SOURCE_ID_TO_TYPE[doc.source_id] ?? "message";
	const title = doc.title && doc.title.length > 0 ? doc.title : titleFromText(doc.text ?? "");
	const snippet = highlight(doc.text ?? "", query);
	const hasHighlight = /<b>/i.test(snippet);
	// FlexDoc row ids carry a source prefix ("goal:<uuid>", "session:<uuid>",
	// "staff:<uuid>") so the index can disambiguate a goal and session that
	// happen to share a uuid. Client-side routes expect bare ids, so strip
	// the prefix here for goal/session/staff. Message ids are chunk-scoped
	// and are not navigated to directly — leave them alone.
	const bareId =
		type === "goal" || type === "session" || type === "staff"
			? doc.id.replace(/^(goal|session|staff):/, "")
			: doc.id;
	const result: SearchResult = {
		type,
		id: bareId,
		title,
		snippet,
		timestamp: doc.timestamp,
		archived: doc.archived === true,
		score: finalScore,
		matchedOn: hasHighlight ? "text" : "metadata",
	};
	if (doc.parent_id) result.parentId = doc.parent_id;
	if (doc.goal_id) result.goalId = doc.goal_id;
	if (doc.session_id) result.sessionId = doc.session_id;
	if (doc.session_title) result.sessionTitle = doc.session_title;
	if (doc.project_id) result.projectId = doc.project_id;
	const authorCandidate = {
		kind: doc.author_kind,
		id: doc.author_id,
		label: doc.author_label,
	};
	if (isMessageAuthor(authorCandidate)) {
		result.authorKind = authorCandidate.kind;
		result.authorId = authorCandidate.id;
		result.authorLabel = authorCandidate.label;
	}
	if (doc.file_path) result.filePath = doc.file_path;
	if (doc.start_line != null) result.startLine = doc.start_line;
	if (doc.end_line != null) result.endLine = doc.end_line;
	return result;
}

function titleFromText(text: string): string {
	if (text.length <= 80) return text;
	return text.slice(0, 80) + "…";
}

/**
 * True for FlexSearch export keys that hold the document tag context
 * (e.g. `1.tag`, `<field>.1.tag`). The reference segment is the last
 * dot-delimited component.
 */
export function isTagKey(key: string): boolean {
	return key.endsWith(".tag");
}

/**
 * Sanitise a FlexSearch tag-context export payload.
 *
 * The tag context serialises as an array of `[field, valueMapOrNull]`
 * pairs. Fields with no indexed values export as `[field, null]`; on
 * reload `Document.import`'s `json_to_ctx`/`json_to_map` then crash on
 * `null.length`, logged as a noisy `Skipping corrupt index file …` and
 * (for non-empty indexes) forcing a full rebuild-from-mirror every boot.
 *
 * Returns the array with the null/empty-valued entries removed so the
 * import sees only populated tag fields, or `null` when nothing
 * meaningful remains (an empty tag context — skip the import entirely;
 * this is not a corruption). Non-array / unrecognised payloads return
 * `null` so callers treat them as "nothing to import".
 */
export function sanitiseTagImport(data: unknown): unknown[] | null {
	if (!Array.isArray(data)) return null;
	const kept = data.filter(
		(entry) =>
			Array.isArray(entry) &&
			entry.length >= 2 &&
			entry[1] != null,
	);
	return kept.length > 0 ? kept : null;
}

export type TagImportClassification =
	| { kind: "import"; entries: unknown[] }
	| { kind: "empty" }
	| { kind: "invalid" };

/**
 * Classify a FlexSearch tag-context export payload read back from disk so the
 * loader can tell a benign empty-tag context apart from genuine corruption.
 *
 * The tag context serialises as an array of `[field, valueMapOrNull]` pairs.
 * Three outcomes:
 *
 *  - `import`  — a well-formed tag array with ≥1 populated field. The caller
 *    imports only the populated entries.
 *  - `empty`   — a well-formed tag array whose fields are ALL `null` (the known
 *    FlexSearch empty-tag shape) or an empty array. A clean no-op, NOT a
 *    corruption — do not force a rebuild.
 *  - `invalid` — anything else: a non-array, an unparseable string (from
 *    `safeParse` on bad JSON), or an array containing malformed entries. The
 *    caller MUST treat this as an import failure so rebuild-from-`__docs__.json`
 *    still fires; otherwise a corrupt tag file is silently skipped and the
 *    in-memory index degrades without warning.
 */
export function classifyTagImport(data: unknown): TagImportClassification {
	if (!Array.isArray(data)) return { kind: "invalid" };
	for (const entry of data) {
		if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== "string") {
			return { kind: "invalid" };
		}
	}
	const populated = data.filter((entry) => (entry as unknown[])[1] != null);
	return populated.length > 0 ? { kind: "import", entries: populated } : { kind: "empty" };
}
