/**
 * Pure helpers shared by TeamManager and the nested-goals scheduler.
 *
 * No I/O, no class state — these operate on plain goal records so they
 * can be unit-tested in isolation and are safe to import from anywhere.
 */

import type { PersistedGoal } from "./goal-store.js";

/**
 * paused-children-not-in-flight rule — Paused children must NOT count as in-flight.
 *
 * `anyInFlightChild(parentGoalId, allGoals)` returns true iff any non-archived
 * child goal of `parentGoalId` is actively making progress (or could without
 * external action). A child counts as in-flight when ALL of:
 *   - It is not archived.
 *   - Its `state` is `"in-progress"` (children in `todo`, `complete`, or
 *     `shelved` are not in flight).
 *   - It is NOT paused (`paused !== true`).
 *
 * The `paused` exclusion is the load-bearing rule. A paused child cannot
 * make progress on its own — only the parent (or user) can act to resume,
 * fix, or archive it. Treating paused as in-flight suppresses parent nudges
 * indefinitely, which on PR #409 manifested as a root team-lead sitting
 * idle for hours despite a v0.2 child being paused with execution=failed.
 *
 * Mixed-progress is preserved: if any sibling is non-paused and
 * `state=in-progress`, the parent IS still in-flight even when other
 * siblings are paused — at least one sibling is making forward progress.
 *
 * @param parentGoalId The goal whose children we're inspecting.
 * @param goals The full goal collection (typically `goalStore.getAll()`).
 *              `parentGoalId` membership is determined by the
 *              `parentGoalId` field on each child (added in Phase 1).
 */
export function anyInFlightChild(
	parentGoalId: string,
	goals: ReadonlyArray<PersistedGoal>,
): boolean {
	for (const child of goals) {
		// Guard against the parent itself appearing in the list.
		if (child.id === parentGoalId) continue;
		// `parentGoalId` is a Phase 1 field — narrow type-cast to avoid
		// coupling this helper to Phase 1's exact PersistedGoal shape.
		const childParentId = (child as { parentGoalId?: string }).parentGoalId;
		if (childParentId !== parentGoalId) continue;

		if (child.archived) continue;
		if (child.state !== "in-progress") continue;
		if (child.paused === true) continue;

		// At least one in-flight non-paused child — parent is in-flight.
		return true;
	}
	return false;
}
