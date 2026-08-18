import type { GoalManager } from "./goal-manager.js";
import {
	type AwaitingExtensionConsentPauseReason,
	type GoalStore,
	type PersistedGoal,
} from "./goal-store.js";

/**
 * Resume one operator-paused goal through the durable goal lifecycle.
 *
 * Scheduler-managed `state: "blocked"` is intentionally untouched. Callers
 * own eligibility checks; this primitive only clears the operator pause and
 * a stale merge-conflict marker, then publishes the durable state change.
 */
export async function resumeOperatorPausedGoal(
	goal: PersistedGoal,
	goalManager: Pick<GoalManager, "updateGoal" | "getGoalStore">,
	broadcastGoalStateChanged: (goalId: string) => void,
): Promise<boolean> {
	if (!goal.paused) return false;
	await goalManager.updateGoal(goal.id, {
		paused: false,
		...(goal.mergeConflict ? { mergeConflict: false } : {}),
	});
	// An operator resume supersedes any old consent reason. Keep the historic
	// manager update path above, then clear the optional provenance field.
	if (goal.pauseReason) goalManager.getGoalStore().update(goal.id, { pauseReason: undefined });
	broadcastGoalStateChanged(goal.id);
	return true;
}

export type ConsentResumeOutcome = "resumed" | "already-resumed" | "not-matching";

/**
 * Resume only the precise consent pause that created `expectedReason`.
 *
 * It re-reads the durable record immediately before updating it. A manual,
 * replan, or different consent pause therefore remains paused even if a late
 * answer carries a valid request id.
 */
export async function resumeOnlyAwaitingConsentGoal(
	goalStore: Pick<GoalStore, "get" | "updateStrict">,
	goalId: string,
	expectedReason: AwaitingExtensionConsentPauseReason,
	broadcastGoalStateChanged: (goalId: string) => void,
): Promise<ConsentResumeOutcome> {
	const goal = goalStore.get(goalId);
	if (!goal) return "not-matching";
	const reason = goal.pauseReason;
	if (!reason
		|| reason.kind !== expectedReason.kind
		|| reason.requestId !== expectedReason.requestId
		|| reason.createdAt !== expectedReason.createdAt) {
		return "not-matching";
	}
	// Keep the exact provenance while the decision's durable claim is being
	// completed. It is the only restart-safe proof that an unpaused goal was
	// released by this request rather than an operator/manual transition.
	if (!goal.paused) return "already-resumed";
	await goalStore.updateStrict(goalId, {
		paused: false,
		...(goal.mergeConflict ? { mergeConflict: false } : {}),
	});
	broadcastGoalStateChanged(goalId);
	return "resumed";
}
