import type { StaffManager } from "./staff-manager.js";
import type { InboxManager } from "./inbox-manager.js";
import type { PersistedGoal } from "./goal-store.js";

type GoalTriggerType = "goal_created" | "goal_archived";

/**
 * Push-based dispatcher for goal lifecycle staff triggers.
 *
 * Unlike `TriggerEngine` which polls every 60 s for `schedule` / `git`
 * triggers, this dispatcher is invoked synchronously from `GoalStore.put`
 * (new-id detection) and `GoalStore.archive` (false \u2192 true transition).
 *
 * Per-event semantics:
 *  - Iterates every staff record across every project via
 *    `staffManager.listStaff()` (fire-all; project/workflow filtering is a
 *    deferred follow-up).
 *  - Skips staff whose `state !== "active"` (paused / retired).
 *  - For each enabled trigger whose `type` matches the event, enqueues a
 *    single inbox entry and bumps `lastFired`.
 *  - **No break-after-first** \u2014 multiple matching triggers on one staff
 *    all fire (each is a distinct user-defined prompt).
 *  - Enqueue failures are caught per-trigger so one bad staff doesn't
 *    poison the dispatch for the rest.
 *
 * `trigger.prompt` is required at the API/store boundary for goal-* triggers
 * (see `StaffManager.validateTriggers`), so by the time the dispatcher runs
 * `trigger.prompt!` is guaranteed non-empty.
 */
export class GoalTriggerDispatcher {
	constructor(
		private staffManager: StaffManager,
		private inboxManager: InboxManager,
	) {}

	onGoalCreated(goal: PersistedGoal): void {
		this.dispatch("goal_created", goal);
	}

	onGoalArchived(goal: PersistedGoal): void {
		this.dispatch("goal_archived", goal);
	}

	private dispatch(type: GoalTriggerType, goal: PersistedGoal): void {
		let allStaff;
		try {
			allStaff = this.staffManager.listStaff();
		} catch (err) {
			console.error(`[goal-trigger-dispatcher] listStaff failed for ${type}:`, err);
			return;
		}

		for (const staff of allStaff) {
			if (staff.state !== "active") continue;
			for (const trigger of staff.triggers) {
				if (trigger.type !== type) continue;
				if (!trigger.enabled) continue;
				try {
					this.inboxManager.enqueue(staff.id, {
						title: `${type}: ${goal.title}`,
						prompt: trigger.prompt!,
						context: `Goal id: ${goal.id}\nTitle: ${goal.title}`,
						source: { type: "trigger", triggerId: trigger.id },
					});
					this.staffManager.updateTriggerState(staff.id, trigger.id, { lastFired: Date.now() });
				} catch (err) {
					// Per-trigger failure isolation: one bad staff must not stop
					// the dispatch for the rest.
					console.error(`[goal-trigger-dispatcher] Failed to enqueue ${type} for staff "${staff.name}" (${staff.id}) trigger ${trigger.id}:`, err);
				}
			}
		}
	}
}
