import { createHash } from "node:crypto";

/**
 * Immutable identifier for the first published Systems Interaction Review
 * contract. Published identifiers are append-only: changing this contract
 * requires a new version and a new identifier.
 */
export const SYSTEMS_INTERACTION_REVIEW_PROMPT_ID = "bobbit:systems-interaction-review/v1" as const;

/**
 * The sole authored source for the v1 Systems Interaction Review contract.
 * Workflow definitions reference the identifier above and never copy this
 * body. Goal snapshots resolve and persist this exact text and its digest.
 */
export const SYSTEMS_INTERACTION_REVIEW_PROMPT = `Perform a deliberate, read-only Systems Interaction Review of the complete immutable branch diff. Your job is to connect behavior across modules and layers, not merely validate changed lines in isolation.

Evidence and coverage:
- Use read_branch_diff to inspect every repository, manifest item, semantic patch, and relevant unchanged context in the bound snapshot. Treat generated or minified text as semantic. Do not use outside knowledge, Git refs, peer reports, or unbound files as evidence.
- Account for every coverage item. Map production-executable and unknown changes to a receipt-backed behavior; do not dismiss or downgrade them as nonbehavioral. Map tests, documentation, config/schema, and passive assets only when the supplied evidence supports that classification.
- Follow every changed producer to every affected consumer and every changed user action to its final side effect. Cross-reference related changes even when they occur in different repositories or evidence chunks.
- Cite receipt-backed file and line evidence. Changed locations require patch receipts that cover the cited lines; unchanged context requires bound-file receipts.
- Process all assigned chunks in order. Submit receipt-bound checkpoints when required, carry unresolved cross-chunk links forward, and close every link before final synthesis. A checkpoint can never pass the review. Submit final only after coverage is gap-free.

For every behavior spanning multiple modules or layers, build and verify these traces:

1. State trace: producer → aggregation/normalization → API/transport → persistence/cache → UI consumer. Verify field meanings, defaults, precedence, error propagation, caching, and rendering agree at each boundary. If a layer is absent, prove why from bound evidence rather than silently omitting it.
2. Action trace: visible control → event payload → route/handler → resolved target → final side effect. Verify identity and scope survive every default, normalization, serialization, queue, retry, callback, process, and client boundary. The target at route resolution is not sufficient: trace to the last production-owned adapter immediately before the actual mutation or remote effect.
3. Mixed-state matrix: evaluate empty, complete, partial, failed, stale, and mixed-success inputs. Verify both the transported representation and the user-visible result or action availability for every applicable state.
4. Conservative aggregate policy: positive summary booleans such as merged, clean, complete, healthy, or authorized may be true only when the required data is complete and all relevant members agree. Missing, failed, stale, partial, or disagreeing members must not be synthesized or rendered as an authoritative positive state.
5. Test trace: each material state or action invariant must have a test at the layer where it can fail. For a destructive or remote-mutating aggregate action, require a successful registered integration or browser test that asserts the exact target and scope captured at the final mutator. Route-only or unit-only assertions, expected values derived from actual values, missing captures, lost queue/cross-process correlation, and unmatched retry attempts do not prove the target.

Findings and escalation:
- Do not stop after the first finding. Report every reproducible medium-or-higher cross-layer correctness defect.
- Each finding must include severity, closed category, file:line evidence, trigger, consequence, violated invariant, affected behavior and trace, and receipt references.
- Use category wrong-target when an action can reach the wrong target or scope; hidden-or-misstated-work when user work can be silently hidden or misstated; incomplete-authoritative when incomplete or mixed data is presented as authoritative; untested-destructive-aggregate-target when a newly introduced or modified destructive/remote-mutating aggregate action lacks qualifying exact final-mutator target coverage; otherwise use other.
- A critical or high actionable bug blocks. A medium-or-higher wrong-target, hidden-or-misstated-work, or incomplete-authoritative bug blocks. Missing qualifying exact-target coverage for a newly introduced or modified destructive or remote-mutating aggregate action blocks.
- Do not fail for style preferences, speculative architecture concerns, or a test gap without a concrete behavior or invariant at risk. A medium other finding may be nonblocking, but it still must be reported.
- Never weaken severity or category because a defect crosses unchanged code, repositories, chunks, or ownership boundaries.

Use systems_review_result for structured checkpoint and final submissions. The server determines the verdict and renders the only final verification report. Do not provide a generic prose verdict, and do not declare completion until every changed item, trace, mixed state, invariant, test obligation, and unresolved link is accounted for.` as const;

export const SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256 = createHash("sha256")
	.update(SYSTEMS_INTERACTION_REVIEW_PROMPT, "utf8")
	.digest("hex");

export interface SystemsInteractionReviewContract {
	readonly prompt: string;
	readonly sha256: string;
}

/** Append new versioned entries without changing any published entry. */
export const SYSTEMS_INTERACTION_REVIEW_CONTRACTS = Object.freeze({
	[SYSTEMS_INTERACTION_REVIEW_PROMPT_ID]: Object.freeze({
		prompt: SYSTEMS_INTERACTION_REVIEW_PROMPT,
		sha256: SYSTEMS_INTERACTION_REVIEW_PROMPT_SHA256,
	}),
});

/** Resolve a published contract, failing closed for unknown references. */
export function resolveSystemsInteractionReviewContract(
	id: string,
): Readonly<SystemsInteractionReviewContract> {
	const contracts: Readonly<Record<string, Readonly<SystemsInteractionReviewContract>>> =
		SYSTEMS_INTERACTION_REVIEW_CONTRACTS;
	const contract = contracts[id];
	if (!contract) {
		throw new Error(`Unknown Systems Interaction Review prompt contract: ${id}`);
	}
	return contract;
}
