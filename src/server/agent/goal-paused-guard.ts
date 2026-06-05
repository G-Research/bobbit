/**
 * Guard primitives for refusing spawn-paths when a goal is paused.
 *
 * Used by:
 *   - REST handlers (`/team/spawn`, `/spawn-child`, `/gates/:id/signal`) —
 *     catch `GoalPausedError` and return `{ error, code, goalId }` with
 *     HTTP status 409.
 *   - In-process spawn paths (`TeamManager._startTeamImpl`, `spawnRole`,
 *     `VerificationHarness.runLlmReviewViaSession`) — let the error
 *     propagate to the caller.
 *
 * The throw-shape mirrors `GateDependencyError` (server.ts:5404) and the
 * existing `{ code, goalId, error }` REST convention.
 *
 * See `docs/design/pause-cascade.md` for the cascade design.
 */

export class GoalPausedError extends Error {
	readonly code = "GOAL_PAUSED" as const;
	readonly status = 409 as const;
	constructor(public readonly goalId: string) {
		super(`Goal ${goalId} is paused — spawn rejected`);
		this.name = "GoalPausedError";
	}
}

/**
 * Throw `GoalPausedError(goalId)` if the looked-up goal record has
 * `paused: true`. A missing goal (lookup returns undefined) is treated
 * as not-paused — the caller's own goal-existence check should run
 * before this guard.
 */
export function requireGoalNotPaused(
	goalId: string,
	lookup: (id: string) => { paused?: boolean } | undefined,
): void {
	const g = lookup(goalId);
	if (g?.paused) throw new GoalPausedError(goalId);
}
