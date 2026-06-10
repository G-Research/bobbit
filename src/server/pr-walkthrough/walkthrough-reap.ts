/**
 * Pure decision for whether a persisted `pr-walkthrough` child session should be
 * reaped (archived, not respawned) on gateway boot.
 *
 * PR-walkthrough children are first-class persisted sessions that
 * `SessionManager.restoreSessions()` would otherwise respawn as live processes on
 * every restart. Two classes of child must never be resurrected:
 *
 *  - terminal: the walkthrough job already finished (submitted/`ready`, or
 *    `error`) or its job record is gone — there is no work left to do.
 *  - orphan: the parent session no longer exists or has been archived — the child
 *    can never be reached or completed.
 *
 * Genuinely in-flight walkthroughs (starting/waiting_for_yaml/validation_failed
 * with a live, non-archived parent) are NOT reaped so they keep restoring with
 * their rotated submit proof.
 *
 * Kept pure (no fs/store access): the caller reads the job status + parent
 * existence flags and passes them in.
 */
export type WalkthroughReapInput = {
	walkthroughJobId?: string;
	parentSessionId?: string;
	/** Status of the linked walkthrough job, or undefined if the job record is missing. */
	jobStatus?: string;
	parentExists: boolean;
	parentArchived: boolean;
};

export type WalkthroughReapDecision = { reap: boolean; reason?: string };

export function shouldReapWalkthroughChildOnBoot(input: WalkthroughReapInput): WalkthroughReapDecision {
	// Missing job record (or no job id at all) — nothing to restore for.
	if (!input.walkthroughJobId || !input.jobStatus) {
		return { reap: true, reason: "walkthrough job record is missing" };
	}
	// Terminal job: published or errored.
	if (input.jobStatus === "ready" || input.jobStatus === "error") {
		return { reap: true, reason: `walkthrough job is terminal (${input.jobStatus})` };
	}
	// Orphan: parent gone or archived.
	if (!input.parentSessionId || !input.parentExists) {
		return { reap: true, reason: "parent session no longer exists" };
	}
	if (input.parentArchived) {
		return { reap: true, reason: "parent session is archived" };
	}
	return { reap: false };
}
