/**
 * Pure helper: resolve a planStep's child goal by `spawnedFromPlanId`,
 * with a tier-based preference order to handle multiple children
 * sharing the same planId (e.g. an old shelved-and-archived attempt
 * + a fresh re-spawn, or a sibling test/exploratory child the team-
 * lead spawned with the same planId).
 *
 * Live test (PR #409 team-lead-317cdb83): after the Phase 2 trio
 * merged + auto-archived, `goal_plan_status` started returning
 * planSteps with NO `child` field for the completed work \u2014 because
 * the previous fallback walker filtered out archived children.
 *
 * Live test (PR #409 v0.1-foundation, second iteration): the storage
 * planStep started rendering as FAILED because a sibling "Storage
 * live test" child shared its planId, was archived in-progress, and
 * had a newer createdAt than the real merged child. The earlier
 * "live > archived, then most-recent" preference still shadowed the
 * success when BOTH were archived (one complete, one in-progress).
 *
 * Tier-based preference (mirrors client-side resolvePlanNodeState):
 *   1. live in-progress       (work is happening now)
 *   2. archived + complete    (success terminal -- the merged child)
 *   3. live but other state   (todo / shelved)
 *   4. archived non-complete  (zombie / aborted)
 *
 * Within each tier, prefer most-recent createdAt.
 *
 * "Archived" in this codebase means "merged + cleaned up" (one of the
 * four auto-archive paths fired: c95f8f60 / e39a5b53 / 658f2da7 /
 * 6aaee3aa). Filtering archived would drop the linkage exactly when
 * the merge succeeded \u2014 preventing dependency satisfaction and
 * blanking the Plan tab cards.
 */

export interface PlanStepChildLike {
	id: string;
	parentGoalId?: string;
	archived?: boolean;
	spawnedFromPlanId?: string;
	createdAt?: number;
	state?: string;
}

/** Tier rank \u2014 lower number = higher priority. Pure / no I/O. */
function rank(g: { archived?: boolean; state?: string }): number {
	if (!g.archived && g.state === "in-progress") return 0;
	if (g.archived && g.state === "complete") return 1;
	if (!g.archived) return 2;
	return 3;
}

/**
 * Pick the best child match for the given (parent, planId) pair.
 * Returns undefined if no child carries that linkage.
 */
export function resolvePlanStepChild(
	parentGoalId: string,
	planId: string,
	allGoals: PlanStepChildLike[],
): PlanStepChildLike | undefined {
	let best: PlanStepChildLike | undefined;
	for (const c of allGoals) {
		if (c.parentGoalId !== parentGoalId) continue;
		if (c.spawnedFromPlanId !== planId) continue;
		if (!best) {
			best = c;
			continue;
		}
		const rb = rank(best);
		const rc = rank(c);
		if (rc < rb) {
			best = c;
			continue;
		}
		if (rc > rb) continue;
		// Same tier -- prefer most-recent createdAt.
		if ((c.createdAt ?? 0) > (best.createdAt ?? 0)) {
			best = c;
		}
	}
	return best;
}
