/**
 * Pure predicates for the goal dashboard tab strip (Phase 5a).
 *
 * Encodes Lesson 4.20: the Plan tab is visible if the goal has a formal
 * `goal-plan` gate OR if it has at least one (non-archived) child goal — in
 * which case the Plan tab synthesises a living plan from the live children
 * (see `plan-synthesis.ts`).
 *
 * Pure: no DOM, no Lit. Phase 5b consumers (e.g. `goal-dashboard.ts`) call
 * these to decide which tab buttons to render.
 */

export interface TabVisibilityGoal {
	id: string;
	parentGoalId?: string;
	workflow?: { gates: Array<{ id: string }> };
}

/**
 * Visible if a formal `goal-plan` gate exists on the goal's snapshotted
 * workflow OR if at least one (non-archived) child synthesises a living plan
 * (Lesson 4.20).
 *
 * The caller is expected to filter `allGoals` to non-archived goals when it
 * wants the "living plan" mode. We accept the full list and only check
 * `parentGoalId === goal.id` here — archived filtering is the caller's
 * concern so this helper stays composable.
 */
export function shouldShowPlanTab(
	goal: TabVisibilityGoal,
	allGoals?: TabVisibilityGoal[],
): boolean {
	if (goal.workflow?.gates.some(g => g.id === "goal-plan")) return true;
	if (allGoals && allGoals.some(g => g.parentGoalId === goal.id)) return true;
	return false;
}

/**
 * Visible if at least one task exists. Mirrors the existing convention
 * (the Tasks tab is suppressed when a goal has zero tasks).
 */
export function shouldShowTasksTab(_goal: TabVisibilityGoal, taskCount: number): boolean {
	return taskCount > 0;
}

/**
 * Visible if at least one (non-archived) child goal exists. The caller
 * computes `hasAnyChildGoals` — usually `goals.some(g => !g.archived &&
 * g.parentGoalId === goal.id)` — and passes it through. Keeping the boolean
 * out of this helper avoids having to thread the full goals list when the
 * caller already knows the answer.
 */
export function shouldShowChildrenTab(
	_goal: TabVisibilityGoal,
	hasAnyChildGoals: boolean,
): boolean {
	return hasAnyChildGoals;
}
