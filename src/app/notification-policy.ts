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
 * Two exported predicates with different read-filter semantics:
 *
 *   | Predicate                       | Read-filterable | Rules covered |
 *   |---------------------------------|-----------------|---------------|
 *   | `needsHumanAttention`           | Yes             | 1, 4          |
 *   | `needsImmediateHumanAttention`  | No (bypass)     | 2, 3          |
 *
 * Rule table (see goal "Human Sign-Off Gates", design-doc §2.3):
 *
 *   | Session kind  | Notify? |
 *   |---------------|---------|
 *   | Standalone    | Yes     |
 *   | Delegate      | Never (escalates to parent) |
 *   | Team member   | Never (escalates to lead) |
 *   | Team lead     | Disjunction of 4 rules below |
 *
 * Team-lead rules (OR semantics — any one of these is sufficient):
 *
 *   1. Goal complete + unread          → `needsHumanAttention` (read-filterable).
 *   2. Pending human sign-off          → `needsImmediateHumanAttention` (bypass).
 *   3. Errored-and-parked              → `needsImmediateHumanAttention` (bypass).
 *   4. Idle stuck (debounced)          → `needsHumanAttention` (read-filterable).
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

/**
 * Minimum time (ms) a team lead must have been idle before rule 4 (stuck)
 * fires. Closes the spawn-handoff false-positive: when one delegate dies
 * and the next has not yet streamed, there is a sub-second window where no
 * sibling is "live" — without this debounce the lead would briefly look
 * stuck every time a new agent spawns.
 */
const STUCK_IDLE_THRESHOLD_MS = 10_000;

/**
 * Mirrors `MAX_CONSECUTIVE_ERROR_TURNS` in
 * `src/server/agent/session-manager.ts`. Duplicated intentionally to keep
 * this module pure / DOM-free / server-import-free. Keep in sync; the
 * unit test pins the constant.
 */
const MAX_CONSECUTIVE_ERROR_TURNS = 3;

/** Subset of `state.gateStatusCache` value type that this policy consumes. */
interface GateStatusCacheValue {
	verifying: boolean;
	awaitingHumanSignoff: boolean;
}

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
 * Is there a live sibling working on this team lead's goal?
 * "Live" = any other (non-lead, non-delegate) session bound to the goal whose
 * status is in LIVE_STATUSES or is currently compacting.
 *
 * Note: in-flight gate verification is checked separately by rule 4's
 * suppressors — kept off this helper so the rule text reads cleanly.
 */
function hasLiveSiblings(
	leadId: string,
	goalId: string,
	allSessions: GatewaySession[],
): boolean {
	for (const other of allSessions) {
		if (other.id === leadId) continue;
		if (other.delegateOf) continue; // delegates of other agents — not "team" work
		const otherGoal = other.teamGoalId || other.goalId;
		if (otherGoal !== goalId) continue;
		if (other.isCompacting) return true;
		if (LIVE_STATUSES.has(other.status)) return true;
	}
	return false;
}

/**
 * Back-compat wrapper. Today no external callers; retained for parity with
 * the pre-rewrite shape so a future module that needs the combined check
 * (siblings + verification) can call this without re-implementing.
 *
 * @internal — prefer `hasLiveSiblings` + an explicit cache.verifying check.
 */
export function hasLiveDownstreamWork(
	leadId: string,
	goalId: string,
	allSessions: GatewaySession[],
	gateStatusCache: Map<string, { verifying: boolean }>,
): boolean {
	if (hasLiveSiblings(leadId, goalId, allSessions)) return true;
	const gate = gateStatusCache.get(goalId);
	if (gate?.verifying) return true;
	return false;
}

/**
 * Rules 2 + 3 — bypass the read-state filter.
 *
 * Rule 2: pending human sign-off on the goal. Demands attention until the
 * user explicitly approves or rejects the sign-off step.
 *
 * Rule 3: the session is in the canonical "human action required" state —
 * `lastTurnErrored` AND `consecutiveErrorTurns >= MAX_CONSECUTIVE_ERROR_TURNS`.
 * After this threshold the server parks new prompts in `promptQueue` awaiting
 * explicit Retry (see `docs/internals.md`).
 *
 * Delegates and team members never surface (escalation invariant). Only
 * team leads and standalone sessions reach these rules.
 */
export function needsImmediateHumanAttention(
	session: GatewaySession,
	gateStatusCache: Map<string, GateStatusCacheValue>,
): boolean {
	if (isDelegate(session)) return false;
	if (isTeamMember(session)) return false;

	// Rule 3 applies to any non-delegate / non-member session (standalone or
	// lead). The error-parked state is canonical regardless of team role.
	if (session.lastTurnErrored && (session.consecutiveErrorTurns ?? 0) >= MAX_CONSECUTIVE_ERROR_TURNS) {
		return true;
	}

	// Rule 2 — only meaningful for sessions bound to a goal.
	const goalId = resolveGoalId(session);
	if (goalId) {
		const cache = gateStatusCache.get(goalId);
		if (cache?.awaitingHumanSignoff) return true;
	}

	return false;
}

/**
 * Rules 1 + 4 — subject to the read-state filter (`hasUnseenActivity`).
 *
 * Rule 1: goal is `complete`. The team is done; surface so the user can
 * review / merge.
 *
 * Rule 4: idle stuck. The lead has been idle for ≥ `STUCK_IDLE_THRESHOLD_MS`
 * with no live siblings, no in-flight verification, and no pending sign-off.
 * The debounce closes the spawn-handoff race: during the sub-second window
 * between one delegate dying and the next starting to stream, no sibling
 * is live but the lead is not actually stuck.
 *
 * Call sites must already have filtered out "not actually idle yet" cases —
 * this predicate assumes the session has (or just has) reached an idle state.
 *
 * @param session The session that just went idle.
 * @param goal The team/regular goal this session belongs to, if any.
 * @param allSessions All known gateway sessions (used to detect live siblings).
 * @param gateStatusCache Goal-id → gate status (used to detect in-flight verification + signoff).
 */
export function needsHumanAttention(
	session: GatewaySession,
	goal: Goal | undefined,
	allSessions: GatewaySession[],
	gateStatusCache: Map<string, GateStatusCacheValue>,
): boolean {
	// Delegates and team members never notify the human directly — they
	// escalate to their parent / team lead.
	if (isDelegate(session)) return false;
	if (isTeamMember(session)) return false;

	if (isTeamLead(session)) {
		const goalId = resolveGoalId(session);
		const cache = goalId ? gateStatusCache.get(goalId) : undefined;

		// Rule 1 — goal complete. Team is done; surface to the user.
		if (goal?.state === "complete") return true;

		// Team lead with no resolvable goal — treat as standalone-ish; notify.
		if (!goalId) return true;

		// Rule 4 — idle stuck (debounced). Skip when the lead is itself live
		// or compacting; idleFor < threshold suppresses the spawn-handoff
		// false-positive; siblings / verification / sign-off explain idleness
		// (no need to notify the user again).
		if (LIVE_STATUSES.has(session.status)) return false;
		if (session.isCompacting) return false;
		const idleFor = Date.now() - (session.lastActivity ?? 0);
		if (idleFor < STUCK_IDLE_THRESHOLD_MS) return false;

		if (hasLiveSiblings(session.id, goalId, allSessions)) return false;
		if (cache?.verifying) return false;
		// Rule 2 already covers this case via the immediate predicate; suppress
		// here so we don't double-count when both paths are OR'd at call sites.
		if (cache?.awaitingHumanSignoff) return false;

		return true;
	}

	// Standalone session — today's behaviour: always notify on idle.
	return true;
}
