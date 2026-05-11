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
