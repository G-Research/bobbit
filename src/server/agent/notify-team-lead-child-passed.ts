/**
 * Pure helpers for parent-team-lead notifications when a child goal's
 * lifecycle hits a state the parent needs to know about.
 *
 * The verification harness already notifies a goal's OWN team-lead on
 * gate verification events. These helpers compute the additional
 * notification that should fan out to the parent goal's team-lead so
 * the parent doesn't sit idle while children change state.
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

function displayName(child: ChildGoalForParentNotify): string {
	const trimmed = (child.title ?? "").trim();
	return trimmed.length > 0 ? trimmed : child.id.slice(0, 8);
}

/**
 * Compute the parent-team-lead notification for a child gate event on
 * the canonical `ready-to-merge` gate.
 *
 *   - status === "passed"  → parent told the child is ready to merge
 *   - status === "failed"  → parent told the child is blocked at merge time
 *
 * Other gate events (intra-child progress like `design-doc`, `implementation`,
 * `qa`) do NOT notify the parent — they're not actionable for the parent
 * and would create notification noise.
 *
 * Returns null when:
 *   - gateId !== "ready-to-merge"
 *   - status is anything other than "passed" or "failed"
 *   - the child has no parentGoalId (root goals don't notify anyone)
 *   - child is undefined (defensive lookup miss)
 */
export function buildParentReadyNotification(
	child: ChildGoalForParentNotify | undefined,
	gateId: string,
	status: string,
): ParentNotification | null {
	if (gateId !== "ready-to-merge") return null;
	if (!child?.parentGoalId) return null;
	const display = displayName(child);
	if (status === "passed") {
		return {
			parentGoalId: child.parentGoalId,
			message: `Subgoal "${display}" passed ready-to-merge — its branch is ready. Use \`goal_merge_child\` to merge it into your branch, or \`goal_archive_child\` if you no longer need it.`,
		};
	}
	if (status === "failed") {
		return {
			parentGoalId: child.parentGoalId,
			message: `Subgoal "${display}" FAILED at ready-to-merge — its branch can't be merged as-is. Inspect the child via \`gate_inspect\` (on the child) or \`goal_plan_status\`, then re-plan, intervene, or \`goal_archive_child\` to give up on this subgoal.`,
		};
	}
	return null;
}

/**
 * Compute the parent-team-lead notification for a child auto-pause event.
 * Fires when the child's `paused` field flips to true via the mutation
 * classifier's auto-pause path (e.g. `replanCount > 5`, `RESTRUCTURE_REQUIRES_PAUSE`).
 *
 * The parent needs to know because a paused child no longer makes
 * progress on its own — only the parent (or the user) can decide what
 * to do next: resume, re-plan, or archive.
 *
 * Returns null for root goals (no parent to notify) or when child is
 * undefined.
 */
export function buildParentPausedNotification(
	child: ChildGoalForParentNotify | undefined,
	reason: "replan-overflow" | "restructure-requires-pause" | "manual" | "other",
): ParentNotification | null {
	if (!child?.parentGoalId) return null;
	const display = displayName(child);
	const reasonText: Record<typeof reason, string> = {
		"replan-overflow": "the replan count exceeded the safety threshold (5+)",
		"restructure-requires-pause": "a restructure mutation needs human review before applying",
		"manual": "it was paused manually",
		"other": "the harness flagged it for review",
	};
	return {
		parentGoalId: child.parentGoalId,
		message: `Subgoal "${display}" was paused — ${reasonText[reason]}. The child won't progress on its own. Decide: \`goal_resume\` to continue, re-plan via \`goal_plan_propose\`, or \`goal_archive_child\` to drop it.`,
	};
}
