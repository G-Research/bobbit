/**
 * `search_meta` row — pure logic only.
 *
 * Serialization lives here; actual LanceDB persistence is T2's
 * `lance-store.ts`. Keeping this module free of LanceDB imports lets us
 * unit-test rebuild decisions without touching native binaries.
 *
 * See docs/design/semantic-search.md §10 (Migration) for how mismatch
 * detection drives the auto-rebuild path.
 */

import { SCHEMA_VERSION } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface MetaRow {
	embedderId: string;
	/** Embedding dimension (e.g. 768). */
	dim: number;
	schemaVersion: number;
	contentPolicyVersion: number;
	/** Milliseconds since epoch. */
	createdAt: number;
}

/** Wire-format used by LanceDB (snake_case). */
export interface MetaRowPersisted {
	embedder_id: string;
	dim: number;
	schema_version: number;
	content_policy_version: number;
	created_at: number;
}

// ── Pure logic ───────────────────────────────────────────────────────

/**
 * Returns true iff the stored meta is missing, malformed, or disagrees
 * with the current runtime on any of the invariants that require a full
 * rebuild: embedder id, embedding dim, schema version, content-policy
 * version.
 */
export function needsRebuild(stored: MetaRow | null | undefined, current: MetaRow): boolean {
	if (!stored) return true;
	if (stored.embedderId !== current.embedderId) return true;
	if (stored.dim !== current.dim) return true;
	if (stored.schemaVersion !== current.schemaVersion) return true;
	if (stored.contentPolicyVersion !== current.contentPolicyVersion) return true;
	return false;
}

/**
 * Build the current runtime meta row from the active embedder + policy
 * constants. Centralised so callers never hand-roll a partial MetaRow.
 */
export function buildCurrentMeta(params: {
	embedderId: string;
	dim: number;
	contentPolicyVersion: number;
	createdAt?: number;
}): MetaRow {
	return {
		embedderId: params.embedderId,
		dim: params.dim,
		schemaVersion: SCHEMA_VERSION,
		contentPolicyVersion: params.contentPolicyVersion,
		createdAt: params.createdAt ?? Date.now(),
	};
}

// ── Serializers (pure) ───────────────────────────────────────────────

export function readMeta(row: MetaRowPersisted | null | undefined): MetaRow | null {
	if (!row) return null;
	if (
		typeof row.embedder_id !== "string" ||
		typeof row.dim !== "number" ||
		typeof row.schema_version !== "number" ||
		typeof row.content_policy_version !== "number" ||
		typeof row.created_at !== "number"
	) {
		return null;
	}
	return {
		embedderId: row.embedder_id,
		dim: row.dim,
		schemaVersion: row.schema_version,
		contentPolicyVersion: row.content_policy_version,
		createdAt: row.created_at,
	};
}

export function writeMeta(meta: MetaRow): MetaRowPersisted {
	return {
		embedder_id: meta.embedderId,
		dim: meta.dim,
		schema_version: meta.schemaVersion,
		content_policy_version: meta.contentPolicyVersion,
		created_at: meta.createdAt,
	};
}
