/**
 * Pure helper: collect descendants of a goal by walking `parentGoalId`.
 *
 * Thin wrapper around the canonical `walkGoalSubtree` BFS — see
 * `src/server/agent/goal-subtree.ts`. Preserved as a named export with
 * its own minimal `DescendantWalkGoal` typing for callers that don't
 * carry the full `PersistedGoal` shape (tests, generic walkers).
 *
 * BFS, depth-capped to defend against malformed cycles. The root itself
 * is NOT included in the result.
 */

import { walkGoalSubtree, SUBTREE_WALK_DEFAULT_DEPTH_CAP } from "./goal-subtree.js";
import type { PersistedGoal } from "./goal-store.js";

/** Minimal goal shape consumed by `collectDescendants`. */
export interface DescendantWalkGoal {
	id: string;
	parentGoalId?: string;
}

/** Hard cap on the BFS walk depth, defends against malformed cycles. */
export const DESCENDANT_WALK_DEPTH_CAP = SUBTREE_WALK_DEFAULT_DEPTH_CAP;

/**
 * Collect all descendants of `rootId` from `allGoals` via the
 * `parentGoalId` chain. BFS; depth capped at `DESCENDANT_WALK_DEPTH_CAP`.
 *
 * Thin wrapper around `walkGoalSubtree` — the canonical BFS used by
 * every cascade in the server. Archived descendants are INCLUDED (this
 * helper powers `GET /api/goals/:goalId/descendants`, which the Plan
 * tab consumes; archived children must remain visible in the DAG even
 * when the sidebar's "See Archived" toggle is off).
 */
export function collectDescendants<G extends DescendantWalkGoal>(
	rootId: string,
	allGoals: readonly G[],
): G[] {
	if (!rootId) return [];
	// pinned by tests/plan-archived-children.test.ts::collectDescendants includes archived descendants
	return walkGoalSubtree(rootId, allGoals as unknown as PersistedGoal[], {
		includeRoot: false,
		includeArchived: true,
	}) as unknown as G[];
}
