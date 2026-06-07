/**
 * Pure helpers shared by TeamManager and the nested-goals scheduler.
 *
 * No I/O, no class state — these operate on plain goal records so they
 * can be unit-tested in isolation and are safe to import from anywhere.
 */

import type { PersistedGoal } from "./goal-store.js";
import { walkGoalSubtree } from "./goal-subtree.js";

/**
 * paused-children-not-in-flight rule — Paused descendants must NOT count as in-flight.
 *
 * `anyInFlightChild(parentGoalId, allGoals)` returns true iff any non-archived
 * DESCENDANT of `parentGoalId` (full subtree, not just direct children) is
 * actively making progress (or could without external action). A descendant
 * counts as in-flight when ALL of:
 *   - It is not archived.
 *   - Its `state` is `"in-progress"` (descendants in `todo`, `complete`,
 *     `blocked`, or `shelved` are not in flight).
 *   - It is NOT paused (`paused !== true`).
 *
 * The `paused` exclusion is the load-bearing rule. A paused child cannot
 * make progress on its own — only the parent (or user) can act to resume,
 * fix, or archive it. Treating paused as in-flight suppresses parent nudges
 * indefinitely, which on PR #409 manifested as a root team-lead sitting
 * idle for hours despite a v0.2 child being paused with execution=failed.
 *
 * Mixed-progress is preserved: if any descendant is non-paused and
 * `state=in-progress`, the parent IS still in-flight even when other
 * descendants are paused — at least one descendant is making forward
 * progress.
 *
 * Subtree (not direct-children) semantics are intentional: a grandchild
 * making progress under a passive intermediate parent must still nudge
 * the root. Walk goes through archived intermediates (their live
 * descendants still count).
 *
 * @param parentGoalId The goal whose subtree we're inspecting.
 * @param goals The full goal collection (typically `goalStore.getAll()`).
 */
export function anyInFlightChild(
	parentGoalId: string,
	goals: ReadonlyArray<PersistedGoal>,
): boolean {
	const subtree = walkGoalSubtree(parentGoalId, goals as PersistedGoal[], {
		includeRoot: false,
		includeArchived: false,
	});
	return subtree.some(g => g.state === "in-progress" && g.paused !== true);
}
