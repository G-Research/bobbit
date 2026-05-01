/**
 * Pure helper for the sidebar nesting invariant. Lives in its own module
 * (no DOM, no Lit, no state imports) so it can be unit-tested via Node's
 * test runner without the full UI stack.
 *
 * See `src/app/render-helpers.ts::renderGoalGroup` for the consumer:
 * `renderGoalGroup` recurses into children via `getChildGoals`, so the
 * top-level `goals.map(renderGoalGroup)` must see only goals with
 * `parentGoalId === undefined`. Filtering before the map is the single
 * source of truth for the nesting rule used by every sidebar entry point
 * (desktop expanded / desktop collapsed / mobile / archived bucketing).
 */

/**
 * Minimal goal shape this filter inspects. Keeping it structural rather
 * than importing the full `Goal` type avoids dragging the whole
 * `state.ts` (and its DOM-heavy transitive deps) into modules that only
 * need to know whether a goal is top-level.
 */
export interface NestableGoal {
	parentGoalId?: string;
}

/**
 * Returns the subset of `goals` that are top-level (no `parentGoalId` or
 * `parentGoalId === ""`). Pure: no side effects, returns a new array,
 * preserves the input sort order.
 *
 * Empty `parentGoalId` is treated as falsy so a misbehaving server that
 * emits `""` instead of `undefined` doesn't drop legitimately-top-level
 * goals from the sidebar.
 */
export function filterTopLevelGoals<T extends NestableGoal>(goals: ReadonlyArray<T>): T[] {
	const out: T[] = [];
	for (const g of goals) {
		if (!g.parentGoalId) out.push(g);
	}
	return out;
}
