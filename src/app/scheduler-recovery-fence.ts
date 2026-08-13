import type { Goal } from "./state.js";

/**
 * Orders goals snapshots against a locally consumed scheduler-recovery retry.
 * A snapshot that began before the retry succeeded cannot restore its consumed
 * recovery record; requests begun afterwards remain server-authoritative.
 */
let generation = 0;
const consumedAt = new Map<string, number>();

/** Capture the fence before starting a goals snapshot request. */
export function beginSchedulerRecoverySnapshot(): number {
	return generation;
}

/** Record a server-confirmed scheduler-recovery consume. */
export function consumeSchedulerRecovery(goalId: string): void {
	consumedAt.set(goalId, ++generation);
}

/** Remove only recovery records consumed after this snapshot began. */
export interface SchedulerRecoveryFenceResult<T> {
	goals: T[];
	stripped: boolean;
}

export function fenceStaleSchedulerRecovery<T extends Pick<Goal, "id" | "schedulerRecovery">>(
	goals: readonly T[],
	snapshotGeneration: number,
): SchedulerRecoveryFenceResult<T> {
	const staleGoalIds = new Set(
		[...consumedAt]
			.filter(([, consumedGeneration]) => consumedGeneration > snapshotGeneration)
			.map(([goalId]) => goalId),
	);
	if (staleGoalIds.size === 0) return { goals: goals as T[], stripped: false };

	let stripped = false;
	const fencedGoals = goals.map(goal => {
		if (!staleGoalIds.has(goal.id) || goal.schedulerRecovery === undefined) return goal;
		stripped = true;
		const { schedulerRecovery: _schedulerRecovery, ...withoutRecovery } = goal;
		return withoutRecovery as T;
	});
	return { goals: fencedGoals, stripped };
}
