/**
 * Pure helpers for team-store consistency sweeps.
 *
 * Symptom this guards against: `team-state.json` references a
 * `teamLeadSessionId` that no longer exists in `sessions.json`. The team-lead
 * session was archived (e.g. boot-time auto-archive when the agent's `.jsonl`
 * was missing) and then permanently purged 7 days later by
 * `SessionManager.purgeExpiredArchives`, but the team-store entry was left
 * dangling — `SessionManager.purgeOneSession` removes the session record but
 * doesn't clean up the team-store.
 *
 * Effect on the gateway: `TeamManager.restoreTeams` loads the dangling entry
 * into `this.teams`, so `startTeam(goalId)` throws "Team already active"
 * (line 863) when the user tries to start a fresh team-lead. The goal is
 * stuck — even though the UI shows "Start Team" the button is non-functional.
 *
 * This module exposes two pure helpers; the live writes happen in
 * `team-manager.ts::restoreTeams` (boot sweep) and `session-manager.ts::
 * purgeOneSession` (source-fix on every purge).
 */

export interface TeamEntryRef {
	goalId: string;
	teamLeadSessionId?: string | null;
}

/**
 * Identify team entries whose `teamLeadSessionId` is set but the corresponding
 * session record is missing. Caller is responsible for the live writes (we
 * stay pure for testability).
 *
 * @param entries  Team store entries to check.
 * @param hasSession Predicate that returns true when the given session id
 *   exists in the owning project's SessionStore (archived OR live — only
 *   "fully purged from disk" counts as missing).
 * @returns Goal ids whose team entry must be dropped.
 */
export function findOrphanTeamEntries(
	entries: ReadonlyArray<TeamEntryRef>,
	hasSession: (sessionId: string) => boolean,
): string[] {
	const orphans: string[] = [];
	for (const entry of entries) {
		if (!entry.teamLeadSessionId) continue;
		if (!hasSession(entry.teamLeadSessionId)) {
			orphans.push(entry.goalId);
		}
	}
	return orphans;
}

/**
 * Decide whether `purgeOneSession` is allowed to destroy a team-lead session.
 *
 * Why this guard exists: if the team-store still references this session as
 * the team-lead AND the owning goal is NOT archived, destroying the session
 * leaves the team-store dangling (the boot-sweep then drops it on next start,
 * but the user-visible damage is the same — the `.jsonl` is gone, the
 * session record is gone, the chat history is irrecoverable). Symptom: the
 * user's "Audit subgoals branch" and "Extract generic fixes" team-leads
 * disappeared this way. Callers that want to clean up should run
 * `teardownTeam(goalId)` first (which removes the team-store entry and
 * terminates the session), then call purge against the now-archived session
 * with no team-store reference.
 *
 * When the goal IS archived, purge is allowed: at that point teardownTeam
 * should already have run, and even if it didn't (race / partial failure)
 * the team is no longer being used, so cleaning up isn't destroying
 * user-visible work.
 *
 * For non-team-lead sessions and sessions without `teamGoalId`, returns
 * `{ allow: true }` — they have no team-store invariant to protect.
 */
export interface TeamLeadPurgeContext {
	role?: string;
	id: string;
	teamGoalId?: string;
}

export function canPurgeTeamLeadSession(
	ps: TeamLeadPurgeContext,
	getTeamLeadSessionIdForGoal: (goalId: string) => string | undefined | null,
	isGoalArchived: (goalId: string) => boolean,
): { allow: true } | { allow: false; reason: string } {
	if (ps.role !== "team-lead") return { allow: true };
	if (!ps.teamGoalId) return { allow: true };
	const referencedSessionId = getTeamLeadSessionIdForGoal(ps.teamGoalId);
	if (referencedSessionId !== ps.id) return { allow: true };
	if (isGoalArchived(ps.teamGoalId)) return { allow: true };
	return {
		allow: false,
		reason:
			`team-store still references this session as the team-lead of live goal ${ps.teamGoalId}. ` +
			`Call teardownTeam(${ps.teamGoalId}) first to break the reference before purging.`,
	};
}
