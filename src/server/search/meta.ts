/**
 * `search_meta` row — pure logic only.
 *
 * Serialization lives here; FlexSearch on-disk persistence is in
 * `flex-store.ts`. Keeping this module free of storage imports lets us
 * unit-test rebuild decisions without any I/O.
 *
 * See docs/design/portable-search.md §8 for how mismatch detection
 * drives the auto-rebuild path.
 */

import { SCHEMA_VERSION } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface MetaRow {
	/** Search engine identifier (e.g. "flexsearch"). */
	engine: string;
	/** Engine version string — any change triggers a rebuild. */
	engineVersion: string;
	schemaVersion: number;
	contentPolicyVersion: number;
	/** Milliseconds since epoch. */
	createdAt: number;
}

/** Wire-format used for on-disk persistence (snake_case). */
export interface MetaRowPersisted {
	engine: string;
	engine_version: string;
	schema_version: number;
	content_policy_version: number;
	created_at: number;
}

// ── Pure logic ───────────────────────────────────────────────────────

/**
 * Returns true iff the stored meta is missing, malformed, or disagrees
 * with the current runtime on any invariant that requires a full
 * rebuild: engine, engine version, schema version, content-policy
 * version.
 */
export function needsRebuild(stored: MetaRow | null | undefined, current: MetaRow): boolean {
	if (!stored) return true;
	if (stored.engine !== current.engine) return true;
	if (stored.engineVersion !== current.engineVersion) return true;
	if (stored.schemaVersion !== current.schemaVersion) return true;
	if (stored.contentPolicyVersion !== current.contentPolicyVersion) return true;
	return false;
}

/**
 * Build the current runtime meta row from the active engine + policy
 * constants. Centralised so callers never hand-roll a partial MetaRow.
 */
export function buildCurrentMeta(params: {
	engine: string;
	engineVersion: string;
	contentPolicyVersion: number;
	createdAt?: number;
}): MetaRow {
	return {
		engine: params.engine,
		engineVersion: params.engineVersion,
		schemaVersion: SCHEMA_VERSION,
		contentPolicyVersion: params.contentPolicyVersion,
		createdAt: params.createdAt ?? Date.now(),
	};
}

// ── Serializers (pure) ───────────────────────────────────────────────

export function readMeta(row: MetaRowPersisted | null | undefined): MetaRow | null {
	if (!row) return null;
	if (
		typeof row.engine !== "string" ||
		typeof row.engine_version !== "string" ||
		typeof row.schema_version !== "number" ||
		typeof row.content_policy_version !== "number" ||
		typeof row.created_at !== "number"
	) {
		return null;
	}
	return {
		engine: row.engine,
		engineVersion: row.engine_version,
		schemaVersion: row.schema_version,
		contentPolicyVersion: row.content_policy_version,
		createdAt: row.created_at,
	};
}

export function writeMeta(meta: MetaRow): MetaRowPersisted {
	return {
		engine: meta.engine,
		engine_version: meta.engineVersion,
		schema_version: meta.schemaVersion,
		content_policy_version: meta.contentPolicyVersion,
		created_at: meta.createdAt,
	};
}
