/**
 * Pure helper for the parent-notification path that fires when a child
 * goal's `ready-to-merge` gate passes.
 *
 * Without this notification the parent goal's team-lead sits idle
 * indefinitely after spawning children — there's no signal to wake it up
 * and merge / archive completed subgoals. The verification harness
 * already notifies the CHILD's own team-lead on a passed gate; this
 * helper computes the additional notification that should fan out to
 * the parent.
 *
 * Pure — no side effects, no I/O. The caller decides how to deliver
 * the message (typically via the `notifyTeamLeadFn` injected into the
 * harness from server.ts).
 */

export interface ChildGoalForParentNotify {
	id: string;
	title?: string;
	parentGoalId?: string;
}

export interface ParentNotification {
	parentGoalId: string;
	message: string;
}

/**
 * Compute the parent-team-lead notification for a child gate-pass event.
 * Returns null when no notification should fire — caller does nothing.
 *
 * Triggers ONLY when:
 *   - status === "passed"
 *   - gateId === "ready-to-merge" (the canonical "this child is done"
 *     signal — other gate passes are intra-child progress only)
 *   - the child has a parentGoalId (root goals don't notify anyone)
 */
export function buildParentReadyNotification(
	child: ChildGoalForParentNotify | undefined,
	gateId: string,
	status: string,
): ParentNotification | null {
	if (status !== "passed") return null;
	if (gateId !== "ready-to-merge") return null;
	if (!child?.parentGoalId) return null;
	const trimmedTitle = (child.title ?? "").trim();
	const display = trimmedTitle.length > 0 ? trimmedTitle : child.id.slice(0, 8);
	return {
		parentGoalId: child.parentGoalId,
		message: `Subgoal "${display}" passed ready-to-merge — its branch is ready. Use \`goal_merge_child\` to merge it into your branch, or \`goal_archive_child\` if you no longer need it.`,
	};
}
