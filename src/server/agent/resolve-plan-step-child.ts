/**
 * Pure helper: resolve a planStep's child goal by `spawnedFromPlanId`,
 * preferring live (non-archived) over archived and most-recent over
 * older among ties.
 *
 * Live test (PR #409 team-lead-317cdb83): after the Phase 2 trio
 * merged + auto-archived, `goal_plan_status` started returning
 * planSteps with NO `child` field for the completed work \u2014 because
 * the previous fallback walker filtered out archived children.
 *
 * "Archived" in this context means "merged + auto-archived" (one of
 * the four auto-archive paths fired: c95f8f60 / e39a5b53 / 658f2da7 /
 * 6aaee3aa). Filtering them out drops the linkage between planStep
 * and its merged child, which:
 *   - blinds the harness to dependency satisfaction (Phase N+1
 *     wouldn't auto-spawn)
 *   - hides "this work is done" from the Plan tab UI
 *   - makes runSubgoalStep think there's no child and either
 *     re-spawn a duplicate or stall on dep-sat
 *
 * Re-spawn handling (defensive): if multiple children share a
 * planId (e.g. an old shelved-and-archived attempt + a fresh
 * re-spawn), prefer the live one. Among ties of same archive status,
 * prefer the most-recent createdAt.
 */

export interface PlanStepChildLike {
	id: string;
	parentGoalId?: string;
	archived?: boolean;
	spawnedFromPlanId?: string;
	createdAt?: number;
}

/**
 * Pick the best child match for the given (parent, planId) pair.
 * Returns undefined if no child carries that linkage.
 *
 * Preference order:
 *   1. Children of the right parent with the right spawnedFromPlanId
 *   2. Live (non-archived) over archived
 *   3. Most-recent createdAt among ties of same archive status
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
		const bestArchived = !!best.archived;
		const cArchived = !!c.archived;
		// Prefer non-archived over archived.
		if (!cArchived && bestArchived) {
			best = c;
			continue;
		}
		if (cArchived && !bestArchived) continue;
		// Same archive status \u2014 prefer most-recent createdAt.
		if ((c.createdAt ?? 0) > (best.createdAt ?? 0)) {
			best = c;
		}
	}
	return best;
}
