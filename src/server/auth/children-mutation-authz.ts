/**
 * S1 — server-side authorization for the MUTATING Children REST endpoints
 * (`spawn-child`, `integrate-child`, `pause`, `resume`, mutation `decision`,
 * `policy`, plan `PATCH`, parent-scoped `archive-child`).
 *
 * Two authorization CLASSES — blast-radius reduction
 * ---------------------------------------------------
 * The original single policy keyed the human-operator signal off the
 * server-verified `bobbit_session` cookie (minted only on a successful Bearer
 * auth, never sent by agents). That closed the absent-header bypass, but the
 * cookie is still only a WEAK human signal: agents read the SHARED gateway
 * admin Bearer token off disk, and any holder of that token can mint a
 * `bobbit_session` cookie. A compromised/rogue agent could therefore forge the
 * cookie and drive ANY Children mutation on ANY goal.
 *
 * To shrink the blast radius we split the mutations into two classes:
 *
 *   ORCHESTRATION — `spawn-child`, plan `PATCH`, `integrate-child`, `policy`.
 *     These are the autonomous team-lead orchestration verbs: they spawn child
 *     teams, rewrite the execution plan, merge child branches, and resize the
 *     concurrency policy. They are NEVER issued by the human/UI gateway path
 *     (the web UI only ever calls the OPERATOR verbs — see `src/app/dialogs.ts`
 *     pause/resume and `children-mutation-approval`'s decision POST). We
 *     therefore require a team-lead-matching `X-Bobbit-Spawning-Session`
 *     header and IGNORE the cookie entirely: the cookie does NOT bypass an
 *     orchestration check. A forged cookie can no longer spawn children,
 *     mutate plans, integrate branches, or change policy. Orchestration is
 *     refused on an absent header, a teamless goal, or a header mismatch.
 *
 *   OPERATOR — `pause`, `resume`, mutation `decision`, `archive-child`.
 *     These are the human-in-the-loop verbs the web UI actually drives. A
 *     verified `bobbit_session` cookie is accepted (human/UI gateway call);
 *     otherwise we fall back to the same team-lead-match the orchestration
 *     class uses (so a team-lead agent can also pause/resume/decide/archive
 *     within its own goal).
 *
 * RESIDUAL RISK (documented, accepted, future work)
 * --------------------------------------------------
 * The OPERATOR endpoints still trust the shared admin Bearer token: any holder
 * of that token can mint the `bobbit_session` cookie and therefore drive the
 * operator verbs. This is an INHERENT property of Bobbit's current single
 * shared-credential model — agents and the human operate the gateway with the
 * same token, so there is no cryptographic way to tell a human operator apart
 * from a token-holding agent on the cookie path. FULL separation requires a
 * dedicated OPERATOR credential (a distinct human-only secret, e.g. a separate
 * login session or a per-operator token) that agents never possess. That is
 * out of scope here and tracked as future work — see
 * `docs/design/production-subgoals-port.md`. The orchestration/operator split
 * shrinks the blast radius (orchestration is now agent-team-lead-only and
 * cookie-proof) without claiming to fully isolate the operator surface.
 *
 * Header handling
 * ---------------
 * The header is NEVER trusted as a bare authorization claim — it is only ever
 * compared for equality against the `TeamManager`'s authoritative team-lead
 * session id for the goal being mutated. A teamless goal has no legitimate
 * agent caller, so a non-cookie caller is denied (orchestration always; the
 * operator class still allows the human cookie).
 *
 * Decision tables
 * ---------------
 *   ORCHESTRATION (cookie does NOT bypass):
 *   | caller header | team-lead known | result                        |
 *   |---------------|-----------------|-------------------------------|
 *   | absent        | —               | DENY  (403, no-caller-header) |
 *   | present       | none            | DENY  (403, no-team-lead)     |
 *   | present       | matches caller  | ALLOW (team-lead-match)       |
 *   | present       | mismatches      | DENY  (403, team-lead-mismatch) |
 *
 *   OPERATOR (human cookie OR team-lead match):
 *   | human cookie | caller header | team-lead known | result                  |
 *   |--------------|---------------|-----------------|-------------------------|
 *   | yes          | —             | —               | ALLOW (human-cookie)    |
 *   | no           | absent        | —               | DENY  (no-caller-header) |
 *   | no           | present       | none            | DENY  (no-team-lead)    |
 *   | no           | present       | matches caller  | ALLOW (team-lead-match) |
 *   | no           | present       | mismatches      | DENY  (team-lead-mismatch) |
 */

/**
 * Authorization class for a Children mutation. See the module header.
 *
 *   - `orchestration` — team-lead-only; the cookie does NOT bypass.
 *   - `operator`      — human cookie OR team-lead match.
 */
export type ChildrenMutationClass = "orchestration" | "operator";

export interface ChildrenMutationAuthzInput {
	/**
	 * Which authorization class this endpoint belongs to. `orchestration`
	 * ignores `isHumanOperator` (cookie does not bypass); `operator` accepts a
	 * verified cookie as the human/UI signal.
	 */
	mutationClass: ChildrenMutationClass;
	/**
	 * True when the request carries a server-verified `bobbit_session` cookie
	 * (computed via `cookieTryAuth(req, cookieStore)` at the call site). This
	 * is the human-operator/UI signal — agents never carry the cookie. It is
	 * honoured ONLY for the `operator` class; the `orchestration` class ignores
	 * it because the cookie is mintable by any holder of the shared admin
	 * Bearer token (a weak human signal — see the module header).
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
	| { ok: true; reason: "human-cookie" | "team-lead-match" }
	| { ok: false; reason: "no-caller-header" | "no-team-lead" | "team-lead-mismatch" };

export function authorizeChildrenMutation(
	input: ChildrenMutationAuthzInput,
): ChildrenMutationAuthzResult {
	// 1. OPERATOR class only: a verified human/UI cookie is allowed. Gateway
	//    auth is checked upstream and agents never carry this cookie. The
	//    ORCHESTRATION class deliberately skips this branch — the cookie is
	//    mintable by any holder of the shared admin token, so it must not
	//    bypass an orchestration (team-lead-only) mutation.
	if (input.mutationClass === "operator" && input.isHumanOperator) {
		return { ok: true, reason: "human-cookie" };
	}
	// 2. Every other caller MUST present a spawning-session header. An agent
	//    that simply omits the header can no longer impersonate the human/UI
	//    path (the absent-header bypass), and an orchestration caller without a
	//    header is always denied.
	const caller = typeof input.callerSessionId === "string" ? input.callerSessionId.trim() : "";
	if (!caller) return { ok: false, reason: "no-caller-header" };
	// 3. No established team-lead → a teamless goal has no legitimate agent
	//    caller. DENY every non-cookie caller so a forged header can't drive
	//    Children mutations on an unrelated teamless goal.
	const lead = typeof input.teamLeadSessionId === "string" ? input.teamLeadSessionId.trim() : "";
	if (!lead) return { ok: false, reason: "no-team-lead" };
	// 4. The header is only ever compared for equality, never trusted as a
	//    bare claim.
	if (lead === caller) return { ok: true, reason: "team-lead-match" };
	return { ok: false, reason: "team-lead-mismatch" };
}
