/**
 * Pure-logic predicates for goal-dashboard tab visibility.
 *
 * Extracted from `goal-dashboard.ts` to keep them importable from Node-style
 * unit tests (the dashboard module itself transitively pulls in DOM /
 * lit / WebSocket plumbing that doesn't load under `node --test`).
 *
 * See:
 *   - docs/design/nested-goals.md §10.2 (Plan tab visibility)
 *   - docs/design/nested-goals.md §10.3 (Children tab visibility)
 */

/** Minimal shape we need for these predicates — narrower than `Goal` so the
 *  module stays free of the heavy state import chain. */
export interface GoalLike {
	id: string;
	parentGoalId?: string | null;
	archived?: boolean;
	workflow?: { gates?: { id: string }[] } | null;
}

/** Pure predicate: should the Plan tab be visible for this goal?
 *
 *  Two ways to qualify:
 *    (a) the workflow includes a `goal-plan` gate (formal plan path)
 *    (b) the goal has any non-archived children (living-plan path)
 *
 *  Rationale (post-PR #409 user feedback): the Plan tab is a powerful
 *  visualisation regardless of which workflow created the goal. Even
 *  goals on `general` / `feature` / `bug-fix` that spawned children
 *  ad-hoc via `goal_spawn_child` have an implicit plan — the children
 *  themselves. Surfacing it makes the nesting feature consistently
 *  useful. The plan content for the (b) path is synthesised from the
 *  live children by `plan-synthesis.ts::buildPlanSteps`. */
export function shouldShowPlanTab(goal: GoalLike | null | undefined, goals?: GoalLike[]): boolean {
	const gates = goal?.workflow?.gates;
	if (gates && gates.some(g => g.id === "goal-plan")) return true;
	// Living-plan fallback: any non-archived child qualifies.
	if (goal && goals) {
		return hasChildGoals(goal.id, goals);
	}
	return false;
}

/** Pure predicate: does this goal have at least one immediate, non-archived
 *  child in `goals`? Mirrors the data shape `getChildGoalsFrom` returns —
 *  immediate children only, no transitive walk.
 *
 *  Exported so callers (dashboard, tests) can use it without re-deriving the
 *  filter; also documents the exact rule the Children tab keys off. */
export function hasChildGoals(goalId: string, goals: GoalLike[]): boolean {
	for (const g of goals) {
		if (g.archived) continue;
		if (g.parentGoalId === goalId) return true;
	}
	return false;
}

/** Pure predicate: should the Children tab be visible for this goal?
 *
 *  True iff the goal has any (transitive) non-archived descendants. The
 *  `goals` array is supplied so the predicate stays pure / testable.
 *
 *  Independent of the `goal-plan` gate — Plan tab and Children tab are
 *  orthogonal: Plan = "did we approve a DAG?" and Children = "what children
 *  exist?". A non-`parent` workflow (general / feature / bug-fix) that
 *  spawned children via `goal_spawn_child` still needs the Children tab,
 *  even though no Plan tab. */
export function shouldShowChildrenTab(goal: GoalLike | null | undefined, goals: GoalLike[]): boolean {
	if (!goal) return false;
	return countDescendantsFrom(goal.id, goals) > 0;
}

/** Count all (transitive) non-archived descendants of `goalId`, excluding the
 *  goal itself. Pure over the supplied goals array. Cycle-safe via visited set.
 *
 *  Mirrors `countDescendantsFrom` in `render-helpers.ts`; duplicated here so
 *  this module has no dependency on the heavy state-bound helper module. */
export function countDescendantsFrom(goalId: string, goals: GoalLike[]): number {
	const byParent = new Map<string, GoalLike[]>();
	for (const g of goals) {
		if (g.archived) continue;
		if (!g.parentGoalId) continue;
		let arr = byParent.get(g.parentGoalId);
		if (!arr) { arr = []; byParent.set(g.parentGoalId, arr); }
		arr.push(g);
	}
	const seen = new Set<string>();
	let count = 0;
	const stack = [goalId];
	while (stack.length > 0) {
		const id = stack.pop()!;
		const kids = byParent.get(id);
		if (!kids) continue;
		for (const k of kids) {
			if (seen.has(k.id)) continue;
			seen.add(k.id);
			count++;
			stack.push(k.id);
		}
	}
	return count;
}
