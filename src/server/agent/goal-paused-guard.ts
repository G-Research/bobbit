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

/**
 * Walk `goalId` and its `parentGoalId` ancestor chain; throw
 * `GoalPausedError(<first paused id>)` if any goal in the chain (the goal
 * itself or any ancestor) is paused. A bounded, cycle-guarded walk (cap 64,
 * mirroring `nestingDepth`) so a corrupt parent chain can never loop.
 *
 * Used by the child-creation spawn paths (`POST /api/goals` with
 * `parentGoalId`) so the pause guarantee covers the whole ancestor chain — a
 * paused grandparent must block a new descendant even when the direct parent
 * is not itself flagged paused. A missing goal terminates the walk (the
 * caller's own existence check runs first).
 */
export function requireAncestorsNotPaused(
	goalId: string,
	lookup: (id: string) => { paused?: boolean; parentGoalId?: string } | undefined,
): void {
	const seen = new Set<string>();
	let curId: string | undefined = goalId;
	let hops = 0;
	while (curId && !seen.has(curId) && hops < 64) {
		seen.add(curId);
		const g = lookup(curId);
		if (!g) break;
		if (g.paused) throw new GoalPausedError(curId);
		curId = g.parentGoalId;
		hops++;
	}
}
