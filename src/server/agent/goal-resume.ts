import type { GoalManager } from "./goal-manager.js";
import type { PersistedGoal } from "./goal-store.js";

/**
 * Resume one operator-paused goal through the durable goal lifecycle.
 *
 * Scheduler-managed `state: "blocked"` is intentionally untouched. Callers
 * own eligibility checks; this primitive only clears the operator pause and
 * a stale merge-conflict marker, then publishes the durable state change.
 */
export async function resumeOperatorPausedGoal(
	goal: PersistedGoal,
	goalManager: Pick<GoalManager, "updateGoal">,
	broadcastGoalStateChanged: (goalId: string) => void,
): Promise<boolean> {
	if (!goal.paused) return false;
	await goalManager.updateGoal(goal.id, {
		paused: false,
		...(goal.mergeConflict ? { mergeConflict: false } : {}),
	});
	broadcastGoalStateChanged(goal.id);
	return true;
}
