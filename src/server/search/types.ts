/**
 * Core type definitions for the semantic search subsystem.
 *
 * These are the stable interfaces other modules (flex-store, indexer,
 * sources, search-service) build on top of. Keeping them in one place
 * makes the v2 path (file indexing) a drop-in: add a new `IndexSource`
 * with `sourceId: "files"` and `file_path`/`start_line`/`end_line` on
 * `display`, and nothing else in the system changes.
 *
 * See docs/design/portable-search.md for the authoritative blueprint.
 */

import type { MessageAuthorKind } from "../../shared/message-author.js";

// ── Versioning ───────────────────────────────────────────────────────

/**
 * Bump when the FlexSearch document schema or on-disk layout changes
 * in a way that existing rows cannot be read under. A version mismatch
 * in `search_meta` triggers a full rebuild on next open.
 */
export const SCHEMA_VERSION = 2;

// ── Roles ────────────────────────────────────────────────────────────

export type Role =
	| "user"
	| "assistant"
	| "tool_call"
	| "tool_result"
	| "title"
	| "spec"
	| "profile";

// ── Indexable ────────────────────────────────────────────────────────

export interface Indexable {
	/** Stable key, e.g. "message:<sid>:<msgIdx>:chunk:<n>". */
	id: string;
	sourceId: "goals" | "sessions" | "messages" | "staff" | "files";
	/** Text to index. */
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
	/** Accountable author metadata for message hits, when known. */
	authorKind?: MessageAuthorKind;
	authorId?: string;
	authorLabel?: string;
	filePath?: string;
	startLine?: number;
	endLine?: number;
	/**
	 * Where the query matched. "text" = snippet contains <b>; "metadata" =
	 * match came from title/identifier/metadata and the snippet is only a
	 * head-of-text preview with no highlights. UI renders "metadata" rows
	 * with a muted "matched on title" note.
	 */
	matchedOn?: "text" | "metadata";
}

export interface SearchResults {
	results: SearchResult[];
	total: number;
}
