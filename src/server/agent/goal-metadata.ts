/**
 * Hierarchical goal metadata resolver — the single source of truth for
 * resolving a goal's effective metadata by walking its `parentGoalId`
 * ancestry and deep-merging ancestors into descendants (descendant wins).
 *
 * No other site performs its own ancestry walk. Core edges (providers/bridge,
 * tools, prompt order) and the `goalProvisioned` lifecycle hook all read the
 * resolved value, so a treatment can never leak across the goal/agent tree
 * (e.g. a team lead with a tool disabled but its sub-agent getting it back).
 *
 * Conventions are namespaced keys, e.g. `bobbit.disabledProviders`,
 * `bobbit.disabledTools`, `bobbit.promptSectionOrder`, `hindsight.memory.enabled`.
 *
 * Absent metadata resolves to `{}` so every consumer is a guarded no-op,
 * preserving current behaviour byte-for-byte.
 */

export type GoalMetadata = Record<string, unknown>;

/**
 * Minimal read interface the resolver needs. `GoalStore` satisfies this
 * directly (its `get` returns a `PersistedGoal`, which carries both
 * `parentGoalId` and `metadata`).
 */
export interface GoalMetadataLookup {
	get(id: string): { parentGoalId?: string; metadata?: GoalMetadata } | undefined;
}

/** A bounded descendant-to-ancestor walk shared by metadata and scope readers. */
export interface GoalMetadataLineageEntry {
	readonly id: string;
	readonly node: { parentGoalId?: string; metadata?: GoalMetadata; title?: string; archived?: boolean };
}

export interface GoalMetadataLineage {
	/** Leaf first. Consumers needing display order reverse a copied array. */
	readonly entries: readonly GoalMetadataLineageEntry[];
	/** True only when the chain ends at a live root without a cycle or cap. */
	readonly complete: boolean;
}

/** Defensive cap on parent-chain walks (mirrors NESTING_WALK_DEPTH_CAP). */
export const GOAL_METADATA_WALK_DEPTH_CAP = 64;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-clone a value that is about to be assigned wholesale into a merge
 * result, so the resolved metadata never shares mutable references (arrays or
 * nested objects inside arrays) with the persisted source. Scalars are returned
 * as-is. Without this, a consumer mutating a resolved array (e.g. sorting or
 * pushing onto `bobbit.disabledTools`) would corrupt the persisted goal record.
 */
function cloneValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cloneValue);
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = cloneValue(v);
		return out;
	}
	return value;
}

/**
 * Deep-merge `override` onto `base`, returning a fresh object. Inputs are
 * never mutated.
 *
 * Semantics:
 *  - plain object + plain object → recurse;
 *  - arrays replace wholesale;
 *  - scalars replace wholesale;
 *  - scalar/object mismatches are replaced by the descendant (override) value.
 */
export function deepMergeMetadata(base: GoalMetadata, override: GoalMetadata): GoalMetadata {
	// Deep-clone every base entry first so base-only keys (arrays / nested
	// objects the override never touches) do not leak a reference into the
	// result — otherwise a consumer mutating the resolved metadata could corrupt
	// the persisted goal's arrays.
	const out: GoalMetadata = {};
	for (const [key, value] of Object.entries(base)) {
		out[key] = cloneValue(value);
	}
	for (const [key, value] of Object.entries(override)) {
		const existing = out[key];
		if (isPlainObject(value)) {
			// Recurse into a fresh object so the result never shares references
			// with either input (existing is already a clone of the base subtree).
			out[key] = deepMergeMetadata(isPlainObject(existing) ? existing : {}, value);
		} else {
			// Arrays + scalars replace wholesale. Arrays (and any nested objects
			// they contain) are deep-cloned so the resolved metadata can never
			// mutate the persisted goal's arrays. Scalars are returned as-is.
			out[key] = cloneValue(value);
		}
	}
	return out;
}

/**
 * Resolve a goal's effective metadata by walking `goalId → parentGoalId → …
 * → root`, then deep-merging ancestors into descendants (descendant wins).
 *
 * Stops on a missing parent, a cycle, or {@link GOAL_METADATA_WALK_DEPTH_CAP}.
 * Returns a fresh object; unknown/absent goal id resolves to `{}`.
 */
export function resolveGoalMetadata(
	lookup: GoalMetadataLookup,
	goalId: string | undefined,
): GoalMetadata {
	// Merge root-first so descendants override their ancestors per key.
	let result: GoalMetadata = {};
	for (const { node } of walkGoalMetadataLineage(lookup, goalId).entries.slice().reverse()) {
		if (isPlainObject(node.metadata)) result = deepMergeMetadata(result, node.metadata);
	}
	return result;
}

/**
 * Walk a goal's parent chain once, with the established cap and cycle guard.
 * `complete` is intentionally strict: a missing leaf/parent, repeated id, or
 * cap exhaustion never masquerades as a root-to-leaf lineage.
 */
export function walkGoalMetadataLineage(
	lookup: GoalMetadataLookup,
	goalId: string | undefined,
): GoalMetadataLineage {
	if (!goalId) return { entries: [], complete: false };

	const entries: GoalMetadataLineageEntry[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined = goalId;
	while (cursor) {
		if (entries.length >= GOAL_METADATA_WALK_DEPTH_CAP || seen.has(cursor)) {
			return { entries, complete: false };
		}
		seen.add(cursor);
		const node = lookup.get(cursor);
		if (!node) return { entries, complete: false };
		entries.push({ id: cursor, node });
		if (!node.parentGoalId) return { entries, complete: true };
		cursor = node.parentGoalId;
	}
	return { entries, complete: true };
}
