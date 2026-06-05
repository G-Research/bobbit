/**
 * Pure helper that builds the `updateSessionMeta()` payload for verification
 * reviewer/QA sessions spawned by the harness.
 *
 * Why this exists: the harness must stamp `teamLeadSessionId` on every reviewer
 * and QA-tester session at creation time so the sidebar can nest the session
 * under its triggering team-lead. Without the link, archived legacy reviewers
 * showed up as "unmapped" and either vanished under a live team-lead or
 * attached to the last archived team-lead by accident-of-iteration. Two near-
 * identical inline blocks in `verification-harness.ts` (one for llm-review,
 * one for agent-qa) used to construct this payload by hand — they're now both
 * thin callers of `buildVerificationReviewerMeta` so the contract is testable
 * without spinning up the harness.
 *
 * Contract:
 *   - `teamLeadSessionId` MUST be present iff a non-empty string was provided.
 *     Spreading `{ teamLeadSessionId: undefined }` would otherwise overwrite
 *     a previously-stamped link with `undefined` (which the SessionStore
 *     `if (... !== undefined)` guards still treat as a no-op, but better not
 *     to depend on that downstream invariant).
 *   - `accessory` defaults differ by kind: "magnifying-glass" for llm-review,
 *     "stamp" for agent-qa. The role-yaml `accessory` field, when set, wins.
 *   - `nonInteractive: true` is hard-coded — these sessions never accept user
 *     input, only verification_result tool calls.
 */
export type VerificationKind = "llm-review" | "agent-qa";

export interface ReviewerMetaInput {
	kind: VerificationKind;
	roleName: string;
	goalId: string;
	/** Per-role accessory override from the resolved role YAML, if any. */
	roleAccessory?: string;
	/** From `teamManager.getTeamState(goalId)?.teamLeadSessionId`. May be null on
	 *  team entries persisted before the field was stamped. Treated as "absent". */
	teamLeadSessionId?: string | null;
}

export interface ReviewerMetaPayload {
	role: string;
	teamGoalId: string;
	accessory: string;
	nonInteractive: true;
	teamLeadSessionId?: string;
}

const DEFAULT_ACCESSORY_BY_KIND: Record<VerificationKind, string> = {
	"llm-review": "magnifying-glass",
	"agent-qa": "stamp",
};

export function buildVerificationReviewerMeta(input: ReviewerMetaInput): ReviewerMetaPayload {
	const accessory = input.roleAccessory || DEFAULT_ACCESSORY_BY_KIND[input.kind];
	const base: ReviewerMetaPayload = {
		role: input.roleName,
		teamGoalId: input.goalId,
		accessory,
		nonInteractive: true,
	};
	if (input.teamLeadSessionId && input.teamLeadSessionId.length > 0) {
		return { ...base, teamLeadSessionId: input.teamLeadSessionId };
	}
	return base;
}
