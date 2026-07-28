import { SYSTEMS_INTERACTION_REVIEW_PROMPT_ID } from "../../src/server/agent/systems-interaction-review-contract.js";

/** Canonical mandatory Systems review step for valid test-authored workflows. */
export function testSystemsInteractionReviewStep(phase = 1) {
	return {
		name: "Systems interaction review",
		type: "llm-review" as const,
		role: "systems-reviewer",
		reviewGroup: "specialist",
		phase,
		promptRef: SYSTEMS_INTERACTION_REVIEW_PROMPT_ID,
	};
}
