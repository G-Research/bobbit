/**
 * Pure helper: collect descendants of a goal by walking `parentGoalId`.
 *
 * Used by `GET /api/goals/:goalId/descendants` to power the Plan tab's
 * data source — the dashboard merges this list with the live `state.goals`
 * so archived children are visible in the plan DAG even when the sidebar's
 * "See Archived" toggle is off.
 *
 * BFS, depth-capped to defend against malformed cycles. The root itself
 * is NOT included in the result.
 */

/** Minimal goal shape consumed by `collectDescendants`. */
export interface DescendantWalkGoal {
	id: string;
	parentGoalId?: string;
}

/** Hard cap on the BFS walk depth, defends against malformed cycles. */
export const DESCENDANT_WALK_DEPTH_CAP = 32;

/**
 * Collect all descendants of `rootId` from `allGoals` via the
 * `parentGoalId` chain. BFS; depth capped at `DESCENDANT_WALK_DEPTH_CAP`.
 *
 * Returns full goal records (typed by caller — generic `<G>`); the helper
 * itself only reads `id` and `parentGoalId`. Order is BFS-by-depth, but
 * callers should not rely on any particular ordering within a depth band.
 *
 * The root is NOT included in the result. Cycle protection: a node is
 * never visited twice via the `seen` set.
 */
export function collectDescendants<G extends DescendantWalkGoal>(
	rootId: string,
	allGoals: readonly G[],
): G[] {
	if (!rootId) return [];
	// Build child-lookup once.
	const byParent = new Map<string, G[]>();
	for (const g of allGoals) {
		const pid = g.parentGoalId;
		if (!pid) continue;
		const list = byParent.get(pid);
		if (list) list.push(g); else byParent.set(pid, [g]);
	}
	const out: G[] = [];
	const seen = new Set<string>([rootId]);
	let frontier: string[] = [rootId];
	for (let depth = 0; depth < DESCENDANT_WALK_DEPTH_CAP && frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const parentId of frontier) {
			const kids = byParent.get(parentId);
			if (!kids) continue;
			for (const kid of kids) {
				if (seen.has(kid.id)) continue;
				seen.add(kid.id);
				out.push(kid);
				next.push(kid.id);
			}
		}
		frontier = next;
	}
	return out;
}
