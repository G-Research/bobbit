/**
 * Pure apply-or-drop decision for the unified `remote.onProposal` callback.
 *
 * Server-stamped revisions (`proposal_update {rev}` from seed/edit/rehydrate)
 * are the source of truth for proposal CONTENT, not just the displayed rev
 * number. This helper centralises the rule that keeps the panel strictly
 * monotonic with respect to the server rev, so a stale out-of-order server
 * event (e.g. an older rehydrate/seed racing in after a newer stamped edit)
 * can never regress the slot to superseded content while the rev stays high.
 *
 * Extracted as a pure function (no DOM, no state) so the live code in
 * `session-manager.ts` and the unit test in `tests/proposal-update-policy.test.ts`
 * share one source of truth. A browser E2E can't deterministically reproduce
 * an out-of-order server-rev race, so the logic is pinned by the unit test.
 *
 * The unified rule across all event sources:
 *   - hasServerRev === true: apply only if `serverRev >= prevRev`. A server
 *     event with `serverRev < prevRev` is a stale out-of-order broadcast →
 *     drop it (keep the existing slot + form-mirror untouched).
 *   - hasServerRev === false (in-memory tool-use/transcript rescan): apply
 *     only if it's a live streaming partial (`streaming === true`) OR there
 *     is no server-stamped rev yet (`prevRev === 0`, incl. first-emit).
 *     Otherwise drop — by message_end the server seed/edit has already
 *     applied identical-or-newer content, so a deferred rescan carrying the
 *     ORIGINAL propose_* fields must not overwrite the slot.
 */
export interface ProposalUpdateDecisionArgs {
	/** `true` when the event carried a positive server-stamped rev. */
	hasServerRev: boolean;
	/** The raw server rev when present; ignored when `hasServerRev` is false. */
	serverRev: number | undefined;
	/** Current rev held in the slot (`0` = no server-stamped rev yet). */
	prevRev: number;
	/** `true` for a live streaming partial tool-use scan. */
	streaming: boolean;
	/** `true` when no slot exists yet for this type (first emit). */
	isFirstEmit: boolean;
}

export function shouldApplyProposalUpdate(args: ProposalUpdateDecisionArgs): boolean {
	const { hasServerRev, serverRev, prevRev, streaming, isFirstEmit } = args;
	if (hasServerRev) {
		// Server-stamped: monotonic in rev. Idempotent re-emit (===) applies;
		// a strictly-older rev is a stale out-of-order broadcast → drop.
		return typeof serverRev === "number" && serverRev >= prevRev;
	}
	// No server rev: in-memory preview path. First-emit and the pre-server
	// state (prevRev === 0) always apply; live streaming partials always
	// apply so revision previews update in place. A non-streaming rescan
	// once a server rev exists (prevRev > 0) is stale → drop.
	if (isFirstEmit) return true;
	if (streaming) return true;
	return prevRev === 0;
}
