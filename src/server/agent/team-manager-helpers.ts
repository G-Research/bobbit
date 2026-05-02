/**
 * Pure helpers for `team-manager.ts`. Extracted into a standalone module
 * with no side effects so they can be unit-tested with the Node test
 * runner (no mocked SessionManager / ProjectContextManager / etc).
 *
 * See `team-manager.ts::hasInFlightChildren` for the consumer.
 */

/**
 * Minimal subset of `PersistedGoal` we need to evaluate "is this child
 * still in flight?". Kept structural so callers can pass any goal-like
 * record without coupling to the full goal-store types.
 */
export interface InFlightCandidateGoal {
	parentGoalId?: string;
	archived?: boolean;
	state?: string;
	paused?: boolean;
}

/**
 * Returns true if `goals` contains at least one immediate child of
 * `parentId` that is ACTIVELY in flight — non-archived, non-terminal,
 * AND not paused.
 *
 * Terminal states: `complete` and `shelved`. Anything else (`todo`,
 * `in-progress`, undefined, future state) is treated as "in flight"
 * for the live-progress check. EXCEPT paused children: a paused goal
 * can't make progress on its own — only the parent (or user) can act
 * to resume / fix / archive it. Treating paused as in-flight would
 * suppress the parent's nudge indefinitely, leaving the tree silent
 * even when the parent's own attention is what's needed.
 *
 * Used to suppress the team-lead idle nudge for parent-pattern goals
 * that orchestrate via `goal_spawn_child` rather than `team_spawn`. Such
 * leads legitimately have zero direct workers while a phase tree is
 * running; the dependency is the children's progress, not their own
 * queue. Nudging them produces noise that pulls the lead into pointless
 * tool calls.
 *
 * Live test (PR #409 v0.2-embeddings): Brisket's child v0.2 was paused
 * (state: in-progress, paused: true) with execution=failed but all 4
 * Phase 1 leaf branches actually merged into v0.2's branch. The parent
 * needed to know v0.2 is stuck-on-pause so they could investigate —
 * but `anyInFlightChild` returned true (v0.2 was non-archived,
 * non-terminal) and Brisket got eternally skipped on the idle nudge.
 *
 * Pure: no side effects, no I/O.
 */
export function anyInFlightChild(parentId: string, goals: readonly InFlightCandidateGoal[]): boolean {
	for (const g of goals) {
		if (g.parentGoalId !== parentId) continue;
		if (g.archived) continue;
		if (g.state === "complete" || g.state === "shelved") continue;
		if (g.paused === true) continue; // paused = parent's responsibility
		return true;
	}
	return false;
}
