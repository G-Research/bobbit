/**
 * Notification policy — decides whether a session going idle should
 * trigger user-facing notifications (beep, favicon badge, unread dot).
 *
 * **Single source of truth.** Three call sites consult this predicate:
 *   1. `src/app/api.ts` — polling `streaming → idle` for background sessions.
 *   2. `src/app/remote-agent.ts` — `agent_end` for the active session.
 *   3. `src/app/render-helpers.ts::hasUnseenActivity` — sidebar unread dot.
 *
 * If you change the rules, edit them here — do NOT re-implement at a call site.
 *
 * Rule table (see goal "Scope notifications to human attention"):
 *
 *   | Session kind  | Notify? |
 *   |---------------|---------|
 *   | Standalone    | Yes     |
 *   | Team member   | Never   |
 *   | Team lead     | Only when goal is complete OR no live downstream work (stuck) |
 *
 * Pure function — no DOM, no fetches. Unit-testable via file:// fixture.
 */

import type { GatewaySession, Goal } from "./state.js";

/** Statuses indicating a session is actively doing work (not idle/terminated). */
const LIVE_STATUSES = new Set([
	"streaming",
	"busy",
	"preparing",
	"aborting",
	"starting",
]);

/** A delegate session — spawned by another agent, never directly user-facing. */
function isDelegate(s: GatewaySession): boolean {
	return !!s.delegateOf;
}

/** A team-member session — has a team lead, or a non-lead role inside a team goal. */
function isTeamMember(s: GatewaySession): boolean {
	if (!!s.teamLeadSessionId) return true;
	if (s.role && s.role !== "team-lead") {
		// Role exists and is not the lead role. If the session has a team goal
		// link, it's definitely a team member.
		if (s.teamGoalId || s.goalId) return true;
	}
	return false;
}

/** A team-lead session — by role. */
function isTeamLead(s: GatewaySession): boolean {
	return s.role === "team-lead";
}

/** Resolve the goal id this session belongs to (team goal or regular goal). */
function resolveGoalId(s: GatewaySession): string | undefined {
	return s.teamGoalId || s.goalId;
}

/**
 * Is there live downstream work for this team lead's goal?
 * "Live" = any other (non-lead, non-delegate) session bound to the goal whose
 * status is in LIVE_STATUSES or is currently compacting, OR verification is
 * running for the goal.
 */
function hasLiveDownstreamWork(
	leadId: string,
	goalId: string,
	allSessions: GatewaySession[],
	gateStatusCache: Map<string, { verifying: boolean }>,
): boolean {
	for (const other of allSessions) {
		if (other.id === leadId) continue;
		if (other.delegateOf) continue; // delegates of other agents — not "team" work
		const otherGoal = other.teamGoalId || other.goalId;
		if (otherGoal !== goalId) continue;
		if (other.isCompacting) return true;
		if (LIVE_STATUSES.has(other.status)) return true;
	}
	const gate = gateStatusCache.get(goalId);
	if (gate?.verifying) return true;
	return false;
}

/**
 * Should an idle/terminated session trigger user-facing notifications?
 *
 * Call sites must already have filtered out "not actually idle yet" cases —
 * this predicate assumes the session has (or just has) reached an idle state.
 *
 * @param session The session that just went idle.
 * @param goal The team/regular goal this session belongs to, if any.
 * @param allSessions All known gateway sessions (used to detect live siblings).
 * @param gateStatusCache Goal-id → gate status (used to detect in-flight verification).
 */
export function needsHumanAttention(
	session: GatewaySession,
	goal: Goal | undefined,
	allSessions: GatewaySession[],
	gateStatusCache: Map<string, { verifying: boolean }>,
): boolean {
	// Delegates and team members never notify the human directly — they
	// escalate to their parent / team lead.
	if (isDelegate(session)) return false;
	if (isTeamMember(session)) return false;

	if (isTeamLead(session)) {
		// Goal complete (or no goal context) — the team is done. Notify.
		if (goal && goal.state === "complete") return true;

		// Mid-goal: only notify if the lead is stuck (no live downstream work).
		const goalId = resolveGoalId(session);
		if (!goalId) {
			// Team lead with no resolvable goal — treat as standalone-ish; notify.
			return true;
		}
		return !hasLiveDownstreamWork(session.id, goalId, allSessions, gateStatusCache);
	}

	// Standalone session — today's behaviour: always notify on idle.
	return true;
}
