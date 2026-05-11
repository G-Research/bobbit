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

// ── Boot-time recovery for orphan team-store entries ──────────────────────────
//
// Symptom this addresses: a team-lead's session record can disappear from
// sessions.json (race / partial save / DELETE-with-immediate-purge) while
// the .jsonl agent transcript and all surviving prompt files remain on disk.
// The team-store still points at the dead session id. Naively dropping the
// team-store entry on boot destroys the user's only link to the surviving
// data. Instead we attempt to RECOVER by locating the canonical .jsonl in
// the worktree slug-dir, reconstructing a fresh session record, and
// preserving the team-store entry.

/** A .jsonl file under the agent sessions root that matches a team-lead worktree. */
export interface CandidateJsonl {
	jsonlPath: string;
	/** Bytes — used as size tiebreaker when two files have equal mtime. */
	size: number;
	/** ms-since-epoch — last-write time. */
	mtime: number;
	/** Agent's internal session id (from the first line of the .jsonl). */
	agentSessionId: string;
	/** ISO timestamp from the first line of the .jsonl. */
	agentStartedAtIso: string;
}

/**
 * Pick the canonical .jsonl from a slug-dir for a recovered team-lead.
 *
 * "Canonical" = most-recently-appended-to (the file that was actively
 * receiving writes when bobbit lost the session record), with size as a
 * tiebreaker. Empirically picks the right file in both shapes observed in
 * the field:
 *   - "Audit subgoals branch" slug-dir: 12 .jsonl files, one is 3.65 MB +
 *     latest mtime → canonical.
 *   - "Extract generic fixes" slug-dir: 7 .jsonl files, one is 245 KB
 *     with the latest mtime even though a 354 KB sibling exists → canonical
 *     (mtime-first heuristic; size-first would have picked wrong).
 */
export function pickCanonicalTeamLeadJsonl(candidates: ReadonlyArray<CandidateJsonl>): CandidateJsonl | null {
	if (candidates.length === 0) return null;
	const sorted = [...candidates].sort((a, b) => (b.mtime - a.mtime) || (b.size - a.size));
	return sorted[0];
}

/** Minimal shape required to reconstruct a team-lead session record. */
export interface OrphanTeamRecoveryInput {
	teamLeadSessionId: string;
	goal: {
		id: string;
		title?: string;
		projectId?: string;
		worktreePath?: string;
		repoPath?: string;
		branch?: string;
		sandboxed?: boolean;
	};
	chosenJsonl: CandidateJsonl;
}

/** The persisted-session shape we write back. Stays loose so callers can
 *  spread it onto their `PersistedSession` type without type-coupling here. */
export interface ReconstructedTeamLeadRecord {
	id: string;
	title: string;
	cwd: string;
	projectId?: string;
	createdAt: number;
	lastActivity: number;
	role: "team-lead";
	teamGoalId: string;
	worktreePath?: string;
	repoPath?: string;
	branch?: string;
	agentSessionFile: string;
	sandboxed?: boolean;
	accessory: "crown";
	archived: false;
}

export function reconstructTeamLeadSessionRecord(input: OrphanTeamRecoveryInput): ReconstructedTeamLeadRecord | null {
	const { goal, chosenJsonl, teamLeadSessionId } = input;
	if (!goal.worktreePath) return null;
	const createdAtMs = Date.parse(chosenJsonl.agentStartedAtIso);
	return {
		id: teamLeadSessionId,
		title: `Team Lead: ${goal.title?.trim() || "(recovered)"} (recovered)`,
		cwd: goal.worktreePath,
		projectId: goal.projectId,
		createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
		lastActivity: chosenJsonl.mtime,
		role: "team-lead",
		teamGoalId: goal.id,
		worktreePath: goal.worktreePath,
		repoPath: goal.repoPath,
		branch: goal.branch,
		agentSessionFile: chosenJsonl.jsonlPath,
		sandboxed: !!goal.sandboxed,
		accessory: "crown",
		archived: false,
	};
}

/** Derive the agent slug-dir name from a cwd, mirroring pi-coding-agent's
 *  encoding. Slashes become `-`, wrapped in `--`. Exposed for testability;
 *  callers join this onto `~/.bobbit/agent/sessions/`. */
export function slugDirNameForCwd(cwd: string): string {
	return "--" + cwd.replace(/^\/+/, "").replace(/\//g, "-") + "--";
}
