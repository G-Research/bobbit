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
 * Agents and the web UI share the SAME gateway Bearer token, so "the absence
 * of an agent header marks a trusted human" is NOT a sound signal — an agent
 * can simply omit the header to impersonate the human/UI path. We therefore
 * key the human-operator signal off the server-verified `bobbit_session`
 * cookie (minted only on a successful Bearer auth, never sent by agents),
 * NOT off the absence of the spawning-session header.
 *
 * Two legitimate callers exist:
 *
 *   1. Human OPERATORS via the web UI — browser requests carry the
 *      server-issued `bobbit_session` cookie (see `src/server/auth/cookie.ts`).
 *      A request with a verified cookie is `isHumanOperator` and is always
 *      allowed (gateway auth is verified upstream).
 *
 *   2. Team-lead AGENTS — the `children` tool extension always sends
 *      `X-Bobbit-Spawning-Session: <its own sessionId>` (see
 *      `defaults/tools/children/extension.ts`). Agents do NOT carry the
 *      cookie, so for any non-human caller we REQUIRE a spawning-session
 *      header and match it against the AUTHORITATIVE team-lead session id for
 *      the goal being mutated, resolved from the `TeamManager` — never
 *      trusting the header as a bare claim beyond an equality check.
 *
 * Decision table:
 *
 *   | human cookie | caller header | team-lead known | result                  |
 *   |--------------|---------------|-----------------|-------------------------|
 *   | yes          | —             | —               | ALLOW (human-cookie)    |
 *   | no           | absent        | —               | DENY  (403)             |
 *   | no           | present       | none            | ALLOW (no team-lead to match against — the goal has no team-lead agent that could abuse the tools; preserves the spawnedBy E2E) |
 *   | no           | present       | matches caller  | ALLOW                   |
 *   | no           | present       | mismatches      | DENY  (403)             |
 *
 * The header is NEVER trusted as a bare authorization claim — it is only ever
 * compared for equality against the TeamManager's team-lead session id.
 */

export interface ChildrenMutationAuthzInput {
	/**
	 * True when the request carries a server-verified `bobbit_session` cookie
	 * (computed via `cookieTryAuth(req, cookieStore)` at the call site). This
	 * is the authoritative human-operator/UI signal — agents never carry the
	 * cookie. When true the call is always allowed.
	 */
	isHumanOperator: boolean;
	/**
	 * Caller session id read from `X-Bobbit-Spawning-Session` (preferred) or
	 * `X-Bobbit-Session-Id` (defence in depth). `undefined` when neither
	 * header is present.
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
	| "human-cookie"
	| "no-caller-header"
	| "no-team-lead"
	| "team-lead-match"
	| "team-lead-mismatch";

export type ChildrenMutationAuthzResult =
	| { ok: true; reason: "human-cookie" | "no-team-lead" | "team-lead-match" }
	| { ok: false; reason: "no-caller-header" | "team-lead-mismatch" };

export function authorizeChildrenMutation(
	input: ChildrenMutationAuthzInput,
): ChildrenMutationAuthzResult {
	// 1. A verified human/UI cookie is always allowed — gateway auth is
	//    checked upstream and agents never carry this cookie.
	if (input.isHumanOperator) return { ok: true, reason: "human-cookie" };
	// 2. Non-human callers MUST present a spawning-session header. An agent
	//    that simply omits the header can no longer impersonate the human/UI
	//    path (the absent-header bypass).
	const caller = typeof input.callerSessionId === "string" ? input.callerSessionId.trim() : "";
	if (!caller) return { ok: false, reason: "no-caller-header" };
	// 3. No established team-lead → nothing to match against; allow (preserves
	//    the spawnedBy E2E where a goal has no team-lead agent yet).
	const lead = typeof input.teamLeadSessionId === "string" ? input.teamLeadSessionId.trim() : "";
	if (!lead) return { ok: true, reason: "no-team-lead" };
	// 4. The header is only ever compared for equality, never trusted as a
	//    bare claim.
	if (lead === caller) return { ok: true, reason: "team-lead-match" };
	return { ok: false, reason: "team-lead-mismatch" };
}
