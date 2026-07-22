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
import { createHash } from "node:crypto";
import { Document as FlexDocument } from "flexsearch";
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

export const FLEX_VERSION = "0.8.158";

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
export const FLEX_EXPORT_BUNDLE_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 500;

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

export interface FlexSearchStoreOpenOptions {
	/** Directory holding the index (e.g. `.bobbit/state/search.flex`). */
	dataDir: string;
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

// ── Store ────────────────────────────────────────────────────────────

export class FlexSearchStore {
	readonly dataDir: string;
	private _idx: FlexDocumentInstance;
	private readonly _docs: Map<string, FlexDoc> = new Map();
	private _saveTimer: NodeJS.Timeout | null = null;
	private _flushInFlight: Promise<void> | null = null;
	private _flushAgain = false;
	private _dirty = false;
	private _closed = false;
	private _atomicRename = atomicRename;

	private constructor(dataDir: string) {
		this.dataDir = dataDir;
		this._idx = FlexSearchStore._newIndex();
	}

	private static _newIndex(): FlexDocumentInstance {
		return new FlexDocument({
			document: {
				id: "id",
				index: [
					{ field: "title", tokenize: "forward", encoder: "LatinAdvanced", resolution: 9 },
					{ field: "text", tokenize: "forward", encoder: "LatinAdvanced", resolution: 9 },
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
				store: true,
			},
			cache: 100,
		});
	}

	static async open(opts: FlexSearchStoreOpenOptions): Promise<FlexSearchStore> {
		await fs.promises.mkdir(path.join(opts.dataDir, INDEX_SUBDIR), { recursive: true });
		const store = new FlexSearchStore(opts.dataDir);
		await store._loadFromDisk();
		return store;
	}

	// ── Mutations ────────────────────────────────────────────────────

	async upsert(docs: FlexDoc[]): Promise<void> {
		if (this._closed) throw new Error("FlexSearchStore: already closed");
		for (const d of docs) {
			const prepared = this._prepare(d);
			this._docs.set(prepared.id, prepared);
			// Document.update is upsert-safe (falls back to add if missing).
			(this._idx.update as unknown as (id: string, d: unknown) => void)(prepared.id, prepared);
		}
		this._scheduleSave();
	}

	async deleteByIds(ids: string[]): Promise<void> {
		if (this._closed) throw new Error("FlexSearchStore: already closed");
		if (ids.length === 0) return;
		const idSet = new Set(ids);
		// Remove direct rows.
		for (const id of ids) {
			if (this._docs.delete(id)) this._idx.remove(id);
		}
		// Cascade delete of any chunk rows whose parent_id matches.
		const chunkVictims: string[] = [];
		for (const [id, doc] of this._docs) {
			if (doc.parent_id && idSet.has(doc.parent_id)) chunkVictims.push(id);
		}
		for (const id of chunkVictims) {
			this._docs.delete(id);
			this._idx.remove(id);
		}
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
		for (const id of victims) {
			this._docs.delete(id);
			this._idx.remove(id);
		}
		if (victims.length > 0) this._scheduleSave();
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
		this._docs.clear();
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
		if (direct) return direct.content_hash;
		for (const d of this._docs.values()) {
			if (d.parent_id === entryId) return d.content_hash;
		}
		return null;
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
			result: Array<{ id: string; doc?: FlexDoc }>;
		}>;

		// Blend field scores → Σ fieldBoost[field] / (rank + 1).
		const scored = new Map<string, ScoredDoc>();
		const now = Date.now();
		for (const group of perField ?? []) {
			const boost =
				(FIELD_BOOST as Record<string, number>)[group.field] ?? 1.0;
			let rank = 0;
			for (const hit of group.result ?? []) {
				// Always use our mirror map for the authoritative doc —
				// FlexSearch's `enrich` doc can return values re-encoded
				// through field encoders (numeric weight coerced etc.).
				const doc = this._docs.get(String(hit.id));
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

	/** Passthrough no-op. Kept for SearchService.compact() compatibility. */
	async compact(): Promise<void> {
		// FlexSearch has no compaction concept; force a flush instead.
		await this._flushNow();
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
			// Re-check `_closed`: the timer was scheduled while open, but
			// `close()` may have run (and torn the dir down) before it fired.
			// The unref()'d timer can still fire during teardown.
			if (this._closed) return;
			void this._flushNow().catch((err) =>
				console.error("[search] flex persistence failed:", err),
			);
		}, FLUSH_DEBOUNCE_MS);
		if (typeof this._saveTimer.unref === "function") this._saveTimer.unref();
	}

	private async _flushNow(): Promise<void> {
		if (this._flushInFlight) {
			this._flushAgain = true;
			await this._flushInFlight;
			if (!this._dirty) {
				this._flushAgain = false;
				return;
			}
		}
		if (!this._dirty) {
			this._flushAgain = false;
			return;
		}
		this._flushAgain = false;
		this._dirty = false;
		let failed = false;
		const task = this._doFlush().catch((err) => {
			// Preserve the write obligation for a later debounce/explicit flush,
			// but never recurse immediately on a persistent write failure.
			failed = true;
			this._dirty = true;
			console.error("[search] flex flush error:", err);
		});
		this._flushInFlight = task;
		try { await task; } finally { this._flushInFlight = null; }
		if (failed) {
			this._flushAgain = false;
			return;
		}
		if (this._flushAgain || this._dirty) {
			this._flushAgain = false;
			await this._flushNow();
		}
	}

	private async _doFlush(): Promise<void> {
		return profileAsync("flexStore._doFlush", () => this.__doFlush());
	}

	private async __doFlush(): Promise<void> {
		try {
			await this.__doFlushUnsafe();
		} catch (err) {
			// If we're already closed and the failure is the temp dir being
			// removed underneath us (teardown race), swallow silently — the
			// data we were flushing is about to be deleted anyway.
			if (this._isBenignTeardownError(err)) return;
			throw err;
		}
	}

	private async __doFlushUnsafe(): Promise<void> {
		const dir = path.join(this.dataDir, INDEX_SUBDIR);
		await fs.promises.mkdir(dir, { recursive: true });
		const written: string[] = [];

		// Also persist our docs Map in its own file (so we can reconstruct
		// on open even if FlexSearch's export format drifts across
		// versions — a fallback that keeps `count()`, `list()`, and
		// `deleteWhere` working).
		const docsKey = "__docs__";
		const docsFinal = path.join(dir, `${docsKey}.json`);
		const docsTmp = `${docsFinal}.tmp`;
		const serialisedDocs = JSON.stringify(Array.from(this._docs.values()));
		const docsHash = createHash("sha256").update(serialisedDocs).digest("hex");
		await fs.promises.writeFile(docsTmp, serialisedDocs, "utf-8");
		await this._atomicRename(docsTmp, docsFinal);
		written.push(`${docsKey}.json`);

		const exportEntries: Array<[string, unknown]> = [];
		await (this._idx.export as unknown as (
			callback: (key: string, data: unknown) => Promise<void>,
		) => Promise<void>)(async (key: string, data: unknown) => {
			if (data === undefined || data === null) return;
			let payloadData: unknown = typeof data === "string" ? safeParse(data) : data;
			// FlexSearch exports the tag context as `[field, valueMapOrNull]`
			// pairs; an empty/partially-empty index yields `null` values that
			// crash `Document.import` on reload (`null.length`). Strip the
			// null-valued entries before persisting; skip the file entirely
			// when nothing meaningful remains.
			if (isTagKey(key)) {
				const parsed = typeof data === "string" ? safeParse(data) : data;
				const sanitised = sanitiseTagImport(parsed);
				if (sanitised === null) return;
				payloadData = sanitised;
			}
			exportEntries.push([key, payloadData]);
		});

		const bundleFinal = path.join(dir, FLEX_EXPORT_BUNDLE_FILE);
		const bundleTmp = `${bundleFinal}.tmp`;
		const bundle = JSON.stringify({ version: FLEX_EXPORT_BUNDLE_VERSION, docsHash, exports: exportEntries });
		await fs.promises.writeFile(bundleTmp, bundle, "utf-8");
		await this._atomicRename(bundleTmp, bundleFinal);
		written.push(FLEX_EXPORT_BUNDLE_FILE);

		// Sweep stale legacy export-key files after both bundle files are durable.
		const present = new Set(written);
		let entries: string[] = [];
		try { entries = await fs.promises.readdir(dir); } catch { /* empty */ }
		for (const f of entries) {
			if (!f.endsWith(".json")) continue;
			if (f.endsWith(".tmp")) continue;
			if (present.has(f)) continue;
			try { await fs.promises.unlink(path.join(dir, f)); } catch { /* best-effort */ }
		}
	}

	private async _loadFromDisk(): Promise<void> {
		const dir = path.join(this.dataDir, INDEX_SUBDIR);
		let entries: string[] = [];
		try { entries = await fs.promises.readdir(dir); } catch { return; }

		const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

		// First, reload our mirror docs map (source of truth for
		// `count()`, `list()`, `deleteWhere`).
		const docsFile = path.join(dir, "__docs__.json");
		let loadedDocsHash: string | undefined;
		try {
			const raw = await fs.promises.readFile(docsFile, "utf-8");
			loadedDocsHash = createHash("sha256").update(raw).digest("hex");
			const parsed = JSON.parse(raw) as FlexDoc[];
			for (const d of parsed) {
				if (d && typeof d.id === "string") {
					const prepared = this._prepare(d);
					this._docs.set(prepared.id, prepared);
				}
			}
		} catch {
			// Missing / corrupt — caller detects via needsRebuild when meta
			// has content but count() is 0.
		}
		await yieldToLoop();

		// Replay either the versioned single-file export bundle or the legacy
		// per-key files. The mirror remains a separate atomic recovery source.
		let importFailures = 0;
		let importSuccesses = 0;
		const importEntry = async (key: string, data: unknown, source: string): Promise<void> => {
			try {
				if (isTagKey(key)) {
					const tag = classifyTagImport(data);
					if (tag.kind === "invalid") throw new Error("unrecognized tag payload");
					if (tag.kind === "import") this._idx.import(key, tag.entries as never);
				} else {
					this._idx.import(key, data as never);
				}
				importSuccesses++;
			} catch (err) {
				importFailures++;
				console.warn(`[search] Skipping corrupt index export ${source}:`, err);
			}
			await yieldToLoop();
		};

		if (entries.includes(FLEX_EXPORT_BUNDLE_FILE)) {
			try {
				const raw = await fs.promises.readFile(path.join(dir, FLEX_EXPORT_BUNDLE_FILE), "utf-8");
				const bundle = JSON.parse(raw) as { version?: unknown; docsHash?: unknown; exports?: unknown };
				if (bundle.version !== FLEX_EXPORT_BUNDLE_VERSION
					|| typeof bundle.docsHash !== "string"
					|| bundle.docsHash !== loadedDocsHash
					|| !Array.isArray(bundle.exports)) {
					throw new Error("unsupported, partial, or mirror-mismatched FlexSearch export bundle");
				}
				for (const entry of bundle.exports) {
					if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
						importFailures++;
						console.warn("[search] Skipping malformed entry in FlexSearch export bundle");
						continue;
					}
					await importEntry(entry[0], entry[1], `${FLEX_EXPORT_BUNDLE_FILE}:${entry[0]}`);
				}
			} catch (err) {
				importFailures++;
				console.warn(`[search] Skipping corrupt index export ${FLEX_EXPORT_BUNDLE_FILE}:`, err);
			}
		} else {
			// Backward-compatible legacy reader. The next dirty flush migrates these
			// files into the versioned bundle and sweeps the old per-key exports.
			const legacyFiles = entries
				.filter((file) => file.endsWith(".json") && !file.endsWith(".tmp") && file !== "__docs__.json")
				.sort((a, b) => legacyImportOrder(a) - legacyImportOrder(b) || a.localeCompare(b));
			for (const file of legacyFiles) {
				const key = unsanitiseKey(file.slice(0, -".json".length));
				try {
					const raw = await fs.promises.readFile(path.join(dir, file), "utf-8");
					await importEntry(key, safeParse(raw), file);
				} catch (err) {
					importFailures++;
					console.warn(`[search] Skipping corrupt index export ${file}:`, err);
				}
			}
		}

		// If the replay files were all present and parsed cleanly, trust
		// the in-memory index. Re-adding every mirror doc on the happy path
		// used to freeze the event loop for many seconds on large indexes.
		//
		// Any import failure forces a full rebuild from the mirror. A
		// partial replay leaves the in-memory index incoherent (e.g. doc
		// store loaded but tag index missing entries), and the next
		// debounced flush would silently overwrite the on-disk export
		// with that incomplete state — search filters would degrade
		// without any further warning. Drop the partial index entirely
		// and rebuild from `__docs__.json`, which is our source of truth.
		if ((importFailures > 0 || importSuccesses === 0) && this._docs.size > 0) {
			this._dirty = true;
			console.warn(
				`[search] Rebuilding in-memory index from mirror (${this._docs.size} docs) — ${importFailures} export entry(s) failed to import (${importSuccesses} succeeded); partial state discarded`,
			);
			this._idx = FlexSearchStore._newIndex();
			let n = 0;
			for (const d of this._docs.values()) {
				try { (this._idx.add as unknown as (id: string, d: unknown) => void)(d.id, d); } catch { /* non-fatal */ }
				// Yield every 500 docs so the event loop isn't monopolized
				// during a worst-case rebuild.
				if (++n % 500 === 0) await yieldToLoop();
			}
		}
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

function safeParse(raw: string): unknown {
	try { return JSON.parse(raw); }
	catch { return raw; }
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

// Legacy FlexSearch per-key files must replay maps before registries/tags/docs.
function legacyImportOrder(file: string): number {
	const key = unsanitiseKey(file.slice(0, -".json".length));
	if (key.endsWith(".map")) return 0;
	if (key.endsWith(".reg")) return 1;
	if (key.endsWith(".tag")) return 2;
	if (key.endsWith(".doc")) return 3;
	return 4;
}
function unsanitiseKey(key: string): string {
	try { return decodeURIComponent(key); } catch { return key; }
}
