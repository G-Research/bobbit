/**
 * `HybridQuery` — translates a `SearchQuery` into LanceDB's built-in
 * hybrid (vector ∪ FTS) search, then applies the post-rank weight
 * multiplier, the parent_id collapse, and the `<b>`-wrapping snippet
 * highlighter.
 *
 * Design reference: docs/design/semantic-search.md §3 (query surface),
 * §7 (query assembly, RRF, weight multiplier, collapse), §12
 * (test coverage).
 *
 * Contract for callers (search-service):
 *   const hq = new HybridQuery({ lance, embedder });
 *   const results = await hq.search({ q: "story", limit: 20 });
 *
 * This module owns no state beyond its construction args. Errors from
 * the native binary / embedder propagate — the service layer maps them
 * to graceful-degradation responses per §11.
 */

import * as lancedb from "@lancedb/lancedb";
import { highlight } from "./snippet.js";
import type { Embedder, Indexable, SearchQuery, SearchResult, SearchResults } from "./types.js";
import type { LanceStore } from "./lance-store.js";

// ── Constants ────────────────────────────────────────────────────────

/** RRF `k` — per design §7. */
const RRF_K = 60;

/** Limit multiplier before collapse: fetch 3× so dedupe has headroom. */
const PRE_COLLAPSE_MULTIPLIER = 3;

/** Default `limit` when the caller omits one. */
const DEFAULT_LIMIT = 20;

/** `search_query: ` prefix — nomic convention. */
const QUERY_PREFIX = "search_query: ";

/** Map LanceDB `source_id` (plural) to UI-facing `SearchResult.type` (singular). */
const SOURCE_ID_TO_TYPE: Record<Indexable["sourceId"], SearchResult["type"]> = {
	goals: "goal",
	sessions: "session",
	messages: "message",
	staff: "staff",
	files: "file",
};

// ── Row shape (LanceDB result row) ───────────────────────────────────

/**
 * Shape of a single row returned from the hybrid `.toArray()`. Mirrors
 * the `content` table Arrow schema (§3) plus Lance-injected scoring
 * columns (`_score`, `_relevance_score`).
 *
 * We deliberately accept `unknown`-flavoured fields for robustness: the
 * native binary can surface `bigint` timestamps, nullable scalars, and
 * embedding arrays as proxies. Normalisation happens in `toSearchResult`.
 */
interface RawHybridRow {
	id: string;
	source_id: Indexable["sourceId"];
	project_id: string;
	entity_type?: string | null;
	parent_id?: string | null;
	archived?: boolean | null;
	timestamp?: number | bigint | null;
	weight: number;
	role?: string | null;
	title?: string | null;
	text: string;
	goal_id?: string | null;
	session_id?: string | null;
	session_title?: string | null;
	file_path?: string | null;
	start_line?: number | null;
	end_line?: number | null;
	/** Lance hybrid rank-fusion score (post-RRF). */
	_relevance_score?: number;
	/** Lance raw FTS score (BM25-like). Kept for completeness. */
	_score?: number;
	// Embedding is present on the row but we never need it client-side.
	// Keep an index signature so stray native columns don't break typing.
	[key: string]: unknown;
}

/** Row after we multiply in the content-policy weight. */
interface ScoredRow extends RawHybridRow {
	finalScore: number;
}

// ── Public API ───────────────────────────────────────────────────────

export interface HybridQueryOptions {
	lance: LanceStore;
	embedder: Embedder;
}

/**
 * Build an SQL-ish filter string for the Lance query's `.where(...)`.
 *
 * Exported as a pure function so tests can lock in each combination
 * without touching the native binary. All inputs are controlled
 * internals (project ids and a fixed `sourceId` enum), so a simple
 * single-quote escape is sufficient — but we apply it consistently so
 * stray apostrophes in future ids do not break the SQL.
 *
 * Contract:
 *   - No `projectId` + archived-excluded (default) + no `types` → `"archived = false"`
 *   - `includeArchived: true` and no other filters → `"TRUE"`
 *   - Combined filters are joined with ` AND `.
 */
export function buildFilter(q: SearchQuery): string {
	const parts: string[] = [];
	if (q.projectId) parts.push(`project_id = '${escapeSql(q.projectId)}'`);
	if (!q.includeArchived) parts.push(`archived = false`);
	if (q.types && q.types.length > 0) {
		const list = q.types.map((t) => `'${escapeSql(t)}'`).join(",");
		parts.push(`source_id IN (${list})`);
	}
	return parts.length > 0 ? parts.join(" AND ") : "TRUE";
}

/**
 * Render a single LanceDB hybrid-result row into the `SearchResult`
 * shape consumed by the UI. `query` is forwarded to
 * `snippet.highlight` to produce the `<b>`-wrapped snippet.
 *
 * Exported for tests and for future reuse by a hypothetical
 * per-source result mapper.
 */
export function toSearchResult(row: RawHybridRow, query: string, finalScore: number): SearchResult {
	const type = SOURCE_ID_TO_TYPE[row.source_id] ?? "message";
	const timestamp = coerceTimestamp(row.timestamp);
	const title = (row.title && row.title.length > 0) ? row.title : titleFromRow(row);
	const snippet = highlight(row.text ?? "", query);

	const result: SearchResult = {
		type,
		id: row.id,
		title,
		snippet,
		timestamp,
		archived: row.archived === true,
		score: finalScore,
	};
	if (row.parent_id) result.parentId = row.parent_id;
	if (row.goal_id) result.goalId = row.goal_id;
	if (row.session_id) result.sessionId = row.session_id;
	if (row.session_title) result.sessionTitle = row.session_title;
	if (row.project_id) result.projectId = row.project_id;
	if (row.file_path) result.filePath = row.file_path;
	if (row.start_line != null) result.startLine = Number(row.start_line);
	if (row.end_line != null) result.endLine = Number(row.end_line);
	return result;
}

/**
 * Stateless-ish hybrid query executor. Instances are cheap to hold onto
 * — one per `SearchService`.
 */
export class HybridQuery {
	private readonly _lance: LanceStore;
	private readonly _embedder: Embedder;
	private _reranker: lancedb.rerankers.RRFReranker | null = null;

	constructor(opts: HybridQueryOptions) {
		this._lance = opts.lance;
		this._embedder = opts.embedder;
	}

	/**
	 * Execute a hybrid (vector ∪ FTS + RRF) search.
	 *
	 * Steps (§7):
	 *   1. Empty query → empty results (short-circuit before embedding).
	 *   2. Embed query with `search_query: ` prefix.
	 *   3. Build SQL filter via `buildFilter`.
	 *   4. Chain `.fullTextSearch(...).nearestTo(vec).where(filter)
	 *       .rerank(rrf).limit(... * 3).toArray()`.
	 *   5. Multiply `_relevance_score` by row.weight → final score.
	 *   6. Sort desc by final score.
	 *   7. Collapse by `parent_id ?? id` (keep best chunk).
	 *   8. Slice with offset/limit window.
	 *   9. Map each survivor to `SearchResult` (with highlighted snippet).
	 */
	async search(q: SearchQuery): Promise<SearchResults> {
		const queryText = (q.q ?? "").trim();
		if (queryText.length === 0) {
			return { results: [], total: 0 };
		}

		const limit = q.limit ?? DEFAULT_LIMIT;
		const offset = q.offset ?? 0;

		// Step 2: embed with nomic query prefix.
		const vectors = await this._embedder.embed([QUERY_PREFIX + queryText], "query");
		const queryVec = vectors[0];

		// Step 3: SQL filter.
		const filter = buildFilter(q);

		// Step 4: assemble the hybrid query. Note the chain order —
		// `.nearestTo(...)` converts the builder to a VectorQuery; only
		// VectorQuery exposes `.rerank(...)`. `.fullTextSearch(...)` on
		// its own returns `this` (Query), so it must come before
		// `.nearestTo(...)`.
		const reranker = await this._getReranker();
		const fetchLimit = Math.max(limit * PRE_COLLAPSE_MULTIPLIER, limit);
		const raw = (await this._lance
			.query()
			.fullTextSearch(queryText, { columns: ["title", "text"] })
			.nearestTo(queryVec)
			.where(filter)
			.rerank(reranker)
			.limit(fetchLimit)
			.toArray()) as RawHybridRow[];

		// Step 5 + 6: weight * relevance, sort desc.
		const scored: ScoredRow[] = raw.map((r) => {
			const relevance = typeof r._relevance_score === "number"
				? r._relevance_score
				: (typeof r._score === "number" ? r._score : 0);
			const weight = typeof r.weight === "number" ? r.weight : 1.0;
			return { ...r, finalScore: relevance * weight };
		});
		scored.sort((a, b) => b.finalScore - a.finalScore);

		// Step 7: collapse by parent_id ?? id (keep highest-scoring chunk).
		const byParent = new Map<string, ScoredRow>();
		for (const r of scored) {
			const key = r.parent_id && r.parent_id.length > 0 ? r.parent_id : r.id;
			if (!byParent.has(key)) byParent.set(key, r);
		}
		const collapsed = Array.from(byParent.values());

		// Step 8: offset/limit window.
		const windowed = collapsed.slice(offset, offset + limit);

		// Step 9: render.
		const results = windowed.map((row) => toSearchResult(row, queryText, row.finalScore));
		return { results, total: collapsed.length };
	}

	private async _getReranker(): Promise<lancedb.rerankers.RRFReranker> {
		if (this._reranker) return this._reranker;
		this._reranker = await lancedb.rerankers.RRFReranker.create(RRF_K);
		return this._reranker;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeSql(s: string): string {
	// Inputs here (project id, sourceId enum) are controlled internals;
	// this escape handles the single legitimate metacharacter that can
	// appear in a user project id without pulling in a full SQL parser.
	return s.replace(/'/g, "''");
}

function coerceTimestamp(v: number | bigint | null | undefined): number {
	if (typeof v === "number") return v;
	if (typeof v === "bigint") return Number(v);
	return 0;
}

/**
 * Fallback title when `row.title` is null — use the text head. Matches
 * the historical FTS5-era behaviour where messages had no title column.
 */
function titleFromRow(row: RawHybridRow): string {
	const text = row.text ?? "";
	if (text.length <= 80) return text;
	return text.slice(0, 80) + "…";
}
