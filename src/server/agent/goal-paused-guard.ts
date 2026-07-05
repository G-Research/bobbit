/**
 * Guard primitives for refusing spawn-paths when a goal is paused.
 *
 * Used by:
 *   - REST handlers (`POST /api/goals` with `parentGoalId`, `/spawn-child`,
 *     `/gates/:id/signal`) — catch `GoalPausedError` and return
 *     `{ error, code, goalId }` with HTTP status 409.
 *   - In-process spawn paths (`TeamManager._startTeamImpl`, `spawnRole`,
 *     `VerificationHarness.runLlmReviewViaSession`) — let the error
 *     propagate to the caller.
 *
 * The throw-shape mirrors `GateDependencyError` (server.ts:5404) and the
 * existing `{ code, goalId, error }` REST convention.
 *
 * There is no dedicated pause-cascade design doc; see the "Pause/resume
 * cascade" bullets in `docs/design/production-subgoals-port.md`.
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
 * Walk `goalId` and its `parentGoalId` ancestor chain; throw
 * `GoalPausedError(<first paused id>)` if any goal in the chain (the goal
 * itself or any ancestor) is paused. A bounded, cycle-guarded walk (cap 64,
 * mirroring `nestingDepth`) so a corrupt parent chain can never loop.
 *
 * Used by the child-creation spawn paths (`POST /api/goals` with
 * `parentGoalId`) AND `TeamManager`'s in-process spawn paths
 * (`_startTeamImpl`, `spawnRole`) so the pause guarantee covers the whole
 * ancestor chain everywhere, not just the direct goal — a paused grandparent
 * (or a parent left paused after a targeted `cascade:false` resume of a
 * child) must block a new descendant/spawn even when the immediate goal is
 * not itself flagged paused. A missing goal terminates the walk (the
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
