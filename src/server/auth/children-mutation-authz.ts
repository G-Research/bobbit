/**
 * S1 — server-side authorization for the MUTATING Children REST endpoints
 * (`spawn-child`, `integrate-child`, `pause`, `resume`, mutation `decision`,
 * `policy`, plan `PATCH`).
 *
 * Threat model
 * ------------
 * The `Children` tool group is team-lead-only by tool policy, but that policy
 * is enforced only in the agent's MCP layer. The REST routes are reachable by
 * anything holding gateway credentials, so an agent that is the team-lead of
 * goal X could otherwise drive a mutating endpoint on an UNRELATED goal Y
 * (spawn children there, integrate, pause, change policy, decide mutations).
 *
 * Two legitimate callers exist:
 *
 *   1. Team-lead AGENTS — the `children` tool extension always sends
 *      `X-Bobbit-Spawning-Session: <its own sessionId>` (see
 *      `defaults/tools/children/extension.ts`). We authorize by matching that
 *      header against the AUTHORITATIVE team-lead session id for the goal
 *      being mutated, resolved from the `TeamManager` — never trusting the
 *      header as a bare claim beyond an equality check.
 *
 *   2. Human OPERATORS via the web UI — `gatewayFetch` carries gateway auth
 *      but does NOT send the spawning-session header (the UI calls `/pause`,
 *      `/resume`, and `/mutation/:id/decision` directly — see
 *      `src/app/dialogs.ts`, `src/app/custom-messages.ts`,
 *      `src/ui/lazy/children-mutation-approval.ts`). The absence of the header
 *      marks a trusted human gateway call, which is allowed because gateway
 *      auth is verified upstream.
 *
 * Decision table:
 *
 *   | caller header | team-lead known | result                       |
 *   |---------------|-----------------|------------------------------|
 *   | absent        | —               | ALLOW  (trusted human / UI)  |
 *   | present       | none            | ALLOW  (no team-lead to match against — the goal has no team-lead agent that could abuse the tools) |
 *   | present       | matches caller  | ALLOW                        |
 *   | present       | mismatches      | DENY (403 NOT_TEAM_LEAD)     |
 *
 * The header is NEVER trusted as a bare authorization claim — it is only ever
 * compared for equality against the TeamManager's team-lead session id.
 */

export interface ChildrenMutationAuthzInput {
	/**
	 * Caller session id read from `X-Bobbit-Spawning-Session` (preferred) or
	 * `X-Bobbit-Session-Id` (defence in depth). `undefined` when neither
	 * header is present — the trusted-human/UI path.
	 */
	callerSessionId: string | undefined;
	/**
	 * Authoritative team-lead session id for the goal being mutated, resolved
	 * from `TeamManager.getTeamState(goalId)?.teamLeadSessionId`. `null` /
	 * `undefined` when the goal has no established team.
	 */
	teamLeadSessionId: string | null | undefined;
}

export type ChildrenMutationAuthzReason =
	| "no-caller-header"
	| "no-team-lead"
	| "team-lead-match"
	| "team-lead-mismatch";

export type ChildrenMutationAuthzResult =
	| { ok: true; reason: Exclude<ChildrenMutationAuthzReason, "team-lead-mismatch"> }
	| { ok: false; reason: "team-lead-mismatch" };

export function authorizeChildrenMutation(
	input: ChildrenMutationAuthzInput,
): ChildrenMutationAuthzResult {
	const caller = typeof input.callerSessionId === "string" ? input.callerSessionId.trim() : "";
	if (!caller) return { ok: true, reason: "no-caller-header" };
	const lead = typeof input.teamLeadSessionId === "string" ? input.teamLeadSessionId.trim() : "";
	if (!lead) return { ok: true, reason: "no-team-lead" };
	if (lead === caller) return { ok: true, reason: "team-lead-match" };
	return { ok: false, reason: "team-lead-mismatch" };
}
