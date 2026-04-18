/**
 * Core type definitions for the semantic search subsystem.
 *
 * These are the stable interfaces other modules (embedder, lance-store,
 * indexer, hybrid-query, sources, search-service) build on top of. Keeping
 * them in one place makes the v2 path (file indexing) a drop-in: add a new
 * `IndexSource` with `sourceId: "files"` and `file_path`/`start_line`/
 * `end_line` on `display`, and nothing else in the system changes.
 *
 * See docs/design/semantic-search.md §3 for the authoritative blueprint.
 */

// ── Versioning ───────────────────────────────────────────────────────

/**
 * Bump when the LanceDB content-table Arrow schema changes in a way that
 * existing rows cannot be read under. A version mismatch in `search_meta`
 * triggers a full rebuild on next open.
 */
export const SCHEMA_VERSION = 1;

// TODO: move CONTENT_POLICY_VERSION to content-policy.ts in T3. For now the
// meta-row expects a value here; lance-store / search-service will import
// it from content-policy.ts once that module lands.

// ── Roles ────────────────────────────────────────────────────────────

export type Role =
	| "user"
	| "assistant"
	| "tool_call"
	| "tool_result"
	| "title"
	| "spec"
	| "profile";

// ── Embedder ─────────────────────────────────────────────────────────

export interface Embedder {
	/** Stable id, e.g. "nomic-embed-text-v1.5". Persisted in search_meta. */
	readonly id: string;
	/** Output dimension, e.g. 768. */
	readonly dim: number;
	/**
	 * Embed a batch of texts. `kind` controls the nomic prefix convention
	 * (`search_document: ` vs `search_query: `) — implementations are free
	 * to ignore for models that don't use task prefixes.
	 */
	embed(texts: string[], kind: "document" | "query"): Promise<Float32Array[]>;
	/** Token count using the embedder's own tokenizer. Cheap; reused by chunker. */
	countTokens(text: string): number;
	/** Resolves once the model is loaded and ready to embed. */
	ready(): Promise<void>;
}

// ── Indexable ────────────────────────────────────────────────────────

export interface Indexable {
	/** Stable key, e.g. "message:<sid>:<msgIdx>:chunk:<n>". */
	id: string;
	sourceId: "goals" | "sessions" | "messages" | "staff" | "files";
	/** Text to embed and FTS-index. */
	text: string;
	metadata: Record<string, string | number | boolean>;
	/**
	 * Hash used for incremental skip. Recommended input:
	 * `sha256(text + weight + role + timestamp)`.
	 */
	contentHash: string;
	timestamp: number;
	projectId: string;
	archived?: boolean;
	/** Post-rank multiplier; sensible range 0.5 – 3.0. */
	weight: number;
	role?: Role;
	display?: {
		title?: string;
		snippet?: string;
		filePath?: string; // v2
		startLine?: number; // v2
		endLine?: number; // v2
	};
}

// ── Index events (source → indexer) ──────────────────────────────────

export type IndexEvent =
	| { type: "upsert"; ids: string[] }
	| { type: "delete"; ids: string[] }
	| { type: "delete-by-filter"; filter: Record<string, unknown> };

export interface IndexSourceContext {
	projectId: string;
	goalStore: import("../agent/goal-store.js").GoalStore;
	sessionStore: import("../agent/session-store.js").SessionStore;
	staffStore: import("../agent/staff-store.js").StaffStore;
}

export interface IndexSource {
	readonly sourceId: Indexable["sourceId"];
	iterate(ctx: IndexSourceContext): AsyncIterable<Indexable>;
	watch?(ctx: IndexSourceContext): AsyncIterable<IndexEvent>;
}

// ── Query surface ────────────────────────────────────────────────────

export interface SearchQuery {
	q: string;
	projectId?: string;
	types?: Array<Indexable["sourceId"]>;
	includeArchived?: boolean;
	limit?: number;
	offset?: number;
}

export interface SearchResult {
	type: "goal" | "session" | "message" | "staff" | "file";
	id: string;
	parentId?: string;
	title: string;
	/** Snippet with `<b>…</b>` wrapping around matched query terms. */
	snippet: string;
	timestamp: number;
	archived: boolean;
	score: number;
	goalId?: string;
	sessionId?: string;
	sessionTitle?: string;
	projectId?: string;
	projectName?: string;
	filePath?: string;
	startLine?: number;
	endLine?: number;
}

export interface SearchResults {
	results: SearchResult[];
	total: number;
}
