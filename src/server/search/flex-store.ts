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
import { Document as FlexDocument } from "flexsearch";
import { highlight } from "./snippet.js";
import {
	type MetaRow,
	readMeta as readMetaRow,
	writeMeta as writeMetaRow,
	type MetaRowPersisted,
} from "./meta.js";
import type { Indexable, SearchQuery, SearchResult, SearchResults } from "./types.js";

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
	private readonly _idx: FlexDocumentInstance;
	private readonly _docs: Map<string, FlexDoc> = new Map();
	private _saveTimer: NodeJS.Timeout | null = null;
	private _flushInFlight: Promise<void> | null = null;
	private _flushAgain = false;
	private _closed = false;

	private constructor(dataDir: string) {
		this.dataDir = dataDir;
		this._idx = new FlexDocument({
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
		// FlexSearch's `Document.clear` exists but is inconsistently async.
		// Remove individually for safety.
		for (const id of this._docs.keys()) this._idx.remove(id);
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
				const doc = hit.doc ?? this._docs.get(String(hit.id));
				if (!doc) { rank++; continue; }
				// Apply tag filters defensively — FlexSearch honours them,
				// but we guard against unknown encodings.
				if (!this._matchesTagFilter(doc, q)) { rank++; continue; }
				const contribution = boost / (rank + 1);
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
		await fs.promises.mkdir(this.dataDir, { recursive: true });
		await fs.promises.writeFile(tmp, JSON.stringify(writeMetaRow(meta)), "utf-8");
		await fs.promises.rename(tmp, final);
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
		if (this._saveTimer) return;
		this._saveTimer = setTimeout(() => {
			this._saveTimer = null;
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
			if (!this._flushAgain) return;
		}
		this._flushAgain = false;
		const task = this._doFlush().catch((err) => {
			console.error("[search] flex flush error:", err);
		});
		this._flushInFlight = task;
		try { await task; } finally { this._flushInFlight = null; }
		if (this._flushAgain) {
			this._flushAgain = false;
			await this._flushNow();
		}
	}

	private async _doFlush(): Promise<void> {
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
		await fs.promises.writeFile(docsTmp, serialisedDocs, "utf-8");
		await fs.promises.rename(docsTmp, docsFinal);
		written.push(`${docsKey}.json`);

		await this._idx.export(async (key: string, data: unknown) => {
			if (data === undefined || data === null) return;
			const safeKey = sanitiseKey(key);
			const final = path.join(dir, `${safeKey}.json`);
			const tmp = `${final}.tmp`;
			const payload = typeof data === "string" ? data : JSON.stringify(data);
			await fs.promises.writeFile(tmp, payload, "utf-8");
			await fs.promises.rename(tmp, final);
			written.push(`${safeKey}.json`);
		});

		// Sweep stale export-key files.
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

		// First, reload our mirror docs map (source of truth for
		// `count()`, `list()`, `deleteWhere`).
		const docsFile = path.join(dir, "__docs__.json");
		try {
			const raw = await fs.promises.readFile(docsFile, "utf-8");
			const parsed = JSON.parse(raw) as FlexDoc[];
			for (const d of parsed) {
				if (d && typeof d.id === "string") this._docs.set(d.id, d);
			}
		} catch {
			// Missing / corrupt — caller detects via needsRebuild when meta
			// has content but count() is 0.
		}

		// Then replay FlexSearch's own per-key exports.
		for (const file of entries) {
			if (!file.endsWith(".json")) continue;
			if (file.endsWith(".tmp")) continue;
			if (file === "__docs__.json") continue;
			const key = unsanitiseKey(file.slice(0, -".json".length));
			try {
				const raw = await fs.promises.readFile(path.join(dir, file), "utf-8");
				const data = safeParse(raw);
				this._idx.import(key, data as never);
			} catch (err) {
				console.warn(`[search] Skipping corrupt index file ${file}:`, err);
			}
		}

		// If FlexSearch's replayed index is empty but we have docs in the
		// mirror, rebuild the in-memory index from the mirror. This also
		// handles the "export format drifted across minor versions" case.
		if (this._docs.size > 0) {
			// Cheaper check — try a search for one known id. If the index
			// has been replayed, the doc is there. If not, re-add.
			// We simply re-add unconditionally: FlexSearch `update` is
			// cheap for already-present docs.
			for (const d of this._docs.values()) {
				try { (this._idx.update as unknown as (id: string, d: unknown) => void)(d.id, d); } catch { /* non-fatal */ }
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
		return { ...d, archived_tag, identifier_text };
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
	const result: SearchResult = {
		type,
		id: doc.id,
		title,
		snippet,
		timestamp: doc.timestamp,
		archived: doc.archived === true,
		score: finalScore,
	};
	if (doc.parent_id) result.parentId = doc.parent_id;
	if (doc.goal_id) result.goalId = doc.goal_id;
	if (doc.session_id) result.sessionId = doc.session_id;
	if (doc.session_title) result.sessionTitle = doc.session_title;
	if (doc.project_id) result.projectId = doc.project_id;
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

// FlexSearch export keys may include characters awkward for filenames
// (slashes, colons). Round-trip via URL-encoding.
function sanitiseKey(key: string): string {
	return encodeURIComponent(key);
}
function unsanitiseKey(key: string): string {
	try { return decodeURIComponent(key); } catch { return key; }
}
