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

/** Defensive cap on parent-chain walks (mirrors NESTING_WALK_DEPTH_CAP). */
export const GOAL_METADATA_WALK_DEPTH_CAP = 64;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
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
	const out: GoalMetadata = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = out[key];
		if (isPlainObject(value)) {
			// Recurse into a fresh object so the result never shares references
			// with either input (recursion clones nested plain-object subtrees).
			out[key] = deepMergeMetadata(isPlainObject(existing) ? existing : {}, value);
		} else {
			// Arrays + scalars replace wholesale.
			out[key] = value;
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
	if (!goalId) return {};

	// Walk descendant-first, collecting each node's own metadata.
	const chainDescendantFirst: GoalMetadata[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined = goalId;
	let depth = 0;
	while (cursor && depth < GOAL_METADATA_WALK_DEPTH_CAP) {
		if (seen.has(cursor)) break; // cycle guard
		seen.add(cursor);
		const node = lookup.get(cursor);
		if (!node) break; // missing parent / unknown goal id
		if (isPlainObject(node.metadata)) {
			chainDescendantFirst.push(node.metadata);
		}
		cursor = node.parentGoalId;
		depth++;
	}

	// Merge root-first so descendants override their ancestors per key.
	let result: GoalMetadata = {};
	for (let i = chainDescendantFirst.length - 1; i >= 0; i--) {
		result = deepMergeMetadata(result, chainDescendantFirst[i]);
	}
	return result;
}
