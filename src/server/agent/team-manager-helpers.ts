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
}

/**
 * Returns true if `goals` contains at least one immediate child of
 * `parentId` that is non-archived AND not in a terminal state.
 *
 * Terminal states: `complete` and `shelved`. Anything else (`todo`,
 * `in-progress`, undefined, future state) is treated as "still in flight".
 *
 * Used to suppress the team-lead idle nudge for parent-pattern goals
 * that orchestrate via `goal_spawn_child` rather than `team_spawn`. Such
 * leads legitimately have zero direct workers while a phase tree is
 * running; the dependency is the children's progress, not their own
 * queue. Nudging them produces noise that pulls the lead into pointless
 * tool calls.
 *
 * Pure: no side effects, no I/O.
 */
export function anyInFlightChild(parentId: string, goals: readonly InFlightCandidateGoal[]): boolean {
	for (const g of goals) {
		if (g.parentGoalId !== parentId) continue;
		if (g.archived) continue;
		if (g.state === "complete" || g.state === "shelved") continue;
		return true;
	}
	return false;
}
