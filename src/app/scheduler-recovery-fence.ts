import type { Goal } from "./state.js";

/**
 * Orders goals snapshots against a locally consumed scheduler-recovery retry.
 * A snapshot that began before the retry succeeded cannot restore its consumed
 * recovery record; requests begun afterwards remain server-authoritative.
 */
let generation = 0;

type SchedulerRecovery = NonNullable<Goal["schedulerRecovery"]>;
interface ConsumedRecovery {
	generation: number;
	recovery: SchedulerRecovery;
}
const consumedAt = new Map<string, ConsumedRecovery>();

/** Capture the fence before starting a goals snapshot request. */
export function beginSchedulerRecoverySnapshot(): number {
	return generation;
}

/** Record the exact server-confirmed scheduler-recovery record that was consumed. */
export function consumeSchedulerRecovery(goalId: string, recovery: SchedulerRecovery): void {
	consumedAt.set(goalId, { generation: ++generation, recovery });
}

/** Remove only recoveries consumed after this snapshot began, never a newer replacement. */
export interface SchedulerRecoveryFenceResult<T> {
	goals: T[];
	stripped: boolean;
}

export function fenceStaleSchedulerRecovery<T extends Pick<Goal, "id" | "schedulerRecovery">>(
	goals: readonly T[],
	snapshotGeneration: number,
): SchedulerRecoveryFenceResult<T> {
	const staleRecoveries = new Map(
		[...consumedAt].filter(([, consumed]) => consumed.generation > snapshotGeneration),
	);
	if (staleRecoveries.size === 0) return { goals: goals as T[], stripped: false };

	let stripped = false;
	const fencedGoals = goals.map(goal => {
		const consumed = staleRecoveries.get(goal.id);
		// A response that started before the consume can nevertheless contain a
		// post-consume recovery for the same goal. The persisted updatedAt is the
		// record identity available to this snapshot, so preserve a later record.
		if (!consumed || goal.schedulerRecovery === undefined || goal.schedulerRecovery.updatedAt > consumed.recovery.updatedAt) return goal;
		stripped = true;
		const { schedulerRecovery: _schedulerRecovery, ...withoutRecovery } = goal;
		return withoutRecovery as T;
	});
	return { goals: fencedGoals, stripped };
}
