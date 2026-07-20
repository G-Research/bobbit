/**
 * S1 — server-side authorization for the MUTATING Children REST endpoints
 * (`spawn-child`, `integrate-child`, `pause`, `resume`, mutation `decision`,
 * `policy`, plan `PATCH`, parent-scoped `archive-child`).
 *
 * Two authorization CLASSES — blast-radius reduction
 * ---------------------------------------------------
 * The original single policy keyed the human-operator signal off the
 * server-verified `bobbit_session` cookie. The gateway now issues that signed
 * cookie only after successful admin Bearer or localhost-trusted auth on an
 * eligible browser-signaled API request; normal session-bound agent traffic
 * never receives it. That closed the absent-header bypass, but the cookie is
 * still only a WEAK human signal: agents read the SHARED gateway admin Bearer
 * token off disk, and any holder can deliberately send otherwise eligible
 * browser metadata and obtain a `bobbit_session` cookie from the gateway.
 * Browser headers are not a security boundary. A compromised/rogue agent could
 * therefore obtain the cookie and drive ANY Children mutation on ANY goal.
 *
 * To shrink the blast radius we split the mutations into two classes:
 *
 *   ORCHESTRATION — `spawn-child`, plan `PATCH`, `integrate-child`, and
 *     `policy` carrying `divergencePolicy` / `maxConcurrentChildren`.
 *     These are the autonomous team-lead orchestration verbs: they spawn child
 *     teams, rewrite the execution plan, merge child branches, and resize the
 *     concurrency policy. They are NEVER issued by the human/UI gateway path
 *     (the web UI only ever calls the OPERATOR verbs — see `src/app/dialogs.ts`
 *     pause/resume and `children-mutation-approval`'s decision POST). We
 *     therefore require the AUTHENTIC caller session (see below) to match the
 *     goal's team-lead, and IGNORE the cookie entirely: the cookie does NOT
 *     bypass an orchestration check. A shared-token holder's obtained cookie
 *     can no longer spawn children, mutate plans, integrate branches, or change
 *     policy.
 *     Orchestration is refused on a missing/unknown secret, a teamless goal, or
 *     a non-team-lead caller.
 *
 *   OPERATOR — `pause`, `resume`, mutation `decision`, `archive-child`, and
 *     `policy` carrying EXCLUSIVELY the per-goal sub-goal opt-in fields
 *     (`subgoalsAllowed` / `maxNestingDepth` — the goal-dashboard Sub-goal
 *     settings control). A body that mixes in ANY orchestration field is
 *     classified as orchestration (the stricter class wins). These are the
 *     human-in-the-loop verbs the web UI actually drives. A
 *     verified `bobbit_session` cookie is accepted (human/UI gateway call);
 *     otherwise we fall back to the same AUTHENTIC team-lead match the
 *     orchestration class uses (so a team-lead agent can also
 *     pause/resume/decide/archive within its own goal).
 *
 * The AUTHENTIC caller — per-session capability secret (S1, replaces the
 * forgeable public header)
 * ---------------------------------------------------------------------------
 * The fatal flaw in the original design was trusting `X-Bobbit-Spawning-Session`
 * — a PUBLIC session id any token holder could read and replay. This authz no
 * longer trusts that header for AUTHORIZATION at all. Instead the caller's
 * identity is derived SERVER-SIDE from a per-session secret: every session's
 * process gets a crypto-random `BOBBIT_SESSION_SECRET` in its env (and ONLY that
 * process gets its own — see `session-secret.ts` and `docker-args.ts`); the
 * `children` extension sends it as `X-Bobbit-Session-Secret`; the route resolves
 * it via `SessionSecretStore.resolveSessionIdBySecret()` to the AUTHENTIC
 * session id and passes that here as `authenticCallerSessionId`. A caller that
 * forges the public header but lacks the secret resolves to `undefined` → DENY.
 * The public `X-Bobbit-Spawning-Session` header survives ONLY for non-auth
 * bookkeeping (stamping `spawnedBySessionId`).
 *
 * RESIDUAL RISK (documented, accepted, future work)
 * --------------------------------------------------
 * The OPERATOR endpoints still indirectly trust the shared admin Bearer token:
 * any holder can make an otherwise eligible browser-shaped request, obtain a
 * gateway-signed `bobbit_session` cookie, and then drive the operator verbs.
 * Fetch Metadata and Origin only classify issuance traffic; they do not prove a
 * human caller. This is an INHERENT property of Bobbit's current single
 * shared-credential model — agents and the human operate the gateway with the
 * same token, so there is no cryptographic way to tell a human operator apart
 * from a token-holding agent on the cookie path. FULL separation requires a
 * dedicated OPERATOR credential (a distinct human-only secret, e.g. a separate
 * login session or a per-operator token) that agents never possess. That is
 * out of scope here and tracked as future work — see
 * `docs/design/production-subgoals-port.md`. The orchestration/operator split
 * plus the per-session secret shrink the blast radius (orchestration is now
 * bound to the AUTHENTIC team-lead and is both cookie-proof and header-forge-
 * proof) without claiming to fully isolate the operator surface.
 *
 * Authentic-caller handling
 * --------------------------
 * `authenticCallerSessionId` is NEVER trusted as a bare authorization claim — it
 * is only ever compared for equality against the `TeamManager`'s authoritative
 * team-lead session id for the goal being mutated, AND it is itself derived from
 * an unforgeable secret. A teamless goal has no legitimate agent caller, so a
 * non-cookie caller is denied (orchestration always; the operator class still
 * allows the human cookie).
 *
 * Decision tables
 * ---------------
 *   ORCHESTRATION (cookie does NOT bypass):
 *   | authentic caller | team-lead known | result                          |
 *   |------------------|-----------------|---------------------------------|
 *   | none (no secret) | —               | DENY  (403, no-authentic-caller) |
 *   | resolved         | none            | DENY  (403, no-team-lead)       |
 *   | resolved         | matches caller  | ALLOW (team-lead-match)         |
 *   | resolved         | mismatches      | DENY  (403, team-lead-mismatch) |
 *
 *   OPERATOR (human cookie OR authentic team-lead match):
 *   | human cookie | authentic caller | team-lead known | result                   |
 *   |--------------|------------------|-----------------|--------------------------|
 *   | yes          | —                | —               | ALLOW (human-cookie)     |
 *   | no           | none (no secret) | —               | DENY  (no-authentic-caller) |
 *   | no           | resolved         | none            | DENY  (no-team-lead)     |
 *   | no           | resolved         | matches caller  | ALLOW (team-lead-match)  |
 *   | no           | resolved         | mismatches      | DENY  (team-lead-mismatch) |
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
	 * True when the request carries a server-verified signed `bobbit_session`
	 * cookie (computed via `cookieTryAuth(req, cookieStore)` at the call site).
	 * This is the weak human-operator/UI signal — normal agent traffic never
	 * receives the cookie, but a shared-admin-token holder can deliberately make
	 * an eligible browser-shaped request and obtain one. It is honoured ONLY for
	 * the `operator` class; the `orchestration` class ignores it (see the module
	 * header).
	 */
	isHumanOperator: boolean;
	/**
	 * The AUTHENTIC caller session id, derived SERVER-SIDE by resolving the
	 * per-session `X-Bobbit-Session-Secret` via
	 * `SessionSecretStore.resolveSessionIdBySecret()`. This is NEVER the public
	 * `X-Bobbit-Spawning-Session` header (which is forgeable and used only for
	 * `spawnedBySessionId` bookkeeping). `undefined` when no secret was
	 * presented or the secret is unknown — which MUST be treated as "deny".
	 */
	authenticCallerSessionId: string | undefined;
	/**
	 * Authoritative team-lead session id for the goal being mutated, resolved
	 * from `TeamManager.getTeamState(goalId)?.teamLeadSessionId`. `null` /
	 * `undefined` when the goal has no established team.
	 */
	teamLeadSessionId: string | null | undefined;
}

export type ChildrenMutationAuthzReason =
	| "human-cookie"
	| "no-authentic-caller"
	| "no-team-lead"
	| "team-lead-match"
	| "team-lead-mismatch";

export type ChildrenMutationAuthzResult =
	| { ok: true; reason: "human-cookie" | "team-lead-match" }
	| { ok: false; reason: "no-authentic-caller" | "no-team-lead" | "team-lead-mismatch" };

export function authorizeChildrenMutation(
	input: ChildrenMutationAuthzInput,
): ChildrenMutationAuthzResult {
	// 1. OPERATOR class only: a verified human/UI cookie is allowed. Gateway
	//    auth is checked upstream and normal agent traffic never receives this
	//    cookie. The ORCHESTRATION class deliberately skips this branch — a
	//    shared-admin-token holder can obtain a signed cookie by deliberately
	//    making an eligible browser-shaped request, so it must not bypass an
	//    orchestration (team-lead-only) mutation.
	if (input.mutationClass === "operator" && input.isHumanOperator) {
		return { ok: true, reason: "human-cookie" };
	}
	// 2. Every other caller MUST resolve to an AUTHENTIC session via the
	//    per-session secret. A forged public header without the secret resolves
	//    to `undefined` here and is denied — it can no longer impersonate the
	//    human/UI path nor a team-lead.
	const caller = typeof input.authenticCallerSessionId === "string" ? input.authenticCallerSessionId.trim() : "";
	if (!caller) return { ok: false, reason: "no-authentic-caller" };
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
