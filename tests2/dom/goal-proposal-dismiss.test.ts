import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/goal-proposal-dismiss.spec.ts (v2-dom tier).
// The legacy Playwright fixture mirrored the dismiss-persistence logic in plain
// JS. Here we drive the REAL dismissal helpers from src/app/proposal-helpers.ts
// (isProposalDismissed / markProposalDismissed) against happy-dom's localStorage,
// wrapped in the same onGoalProposal / handleDismiss glue the app uses. Same
// user-visible behaviour: a dismissed proposal must not resurface on reconnect,
// while a different proposal still appears.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearProposalDismissed,
	isProposalDismissed,
	markProposalDismissed,
} from "../../src/app/proposal-helpers.js";

const SESSION_ID = "test-session-123";

type Proposal = { title: string; spec: string };

function makeState() {
	return { activeGoalProposal: null as Proposal | null, assistantType: "normal" as "normal" | "goal" };
}

// Mirror src/app/session-manager.ts onGoalProposal (~line 572).
function onGoalProposal(state: ReturnType<typeof makeState>, proposal: Proposal) {
	if (state.assistantType === "goal") {
		state.activeGoalProposal = proposal;
	} else {
		if (isProposalDismissed(SESSION_ID, "goal", proposal)) return;
		state.activeGoalProposal = proposal;
	}
}

// Mirror src/app/render.ts handleDismiss (~line 1433).
function handleDismiss(state: ReturnType<typeof makeState>) {
	const dismissed = state.activeGoalProposal;
	state.activeGoalProposal = null;
	if (dismissed) markProposalDismissed(SESSION_ID, "goal", dismissed);
}

beforeEach(() => clearProposalDismissed(SESSION_ID, "goal"));
afterEach(() => clearProposalDismissed(SESSION_ID, "goal"));

describe("Goal proposal dismiss persistence", () => {
	it("dismissed proposal should not reappear after simulated reconnect", () => {
		const state = makeState();

		// Step 1: proposal is set initially.
		const proposal: Proposal = { title: "Fix login bug", spec: "The login page has a bug..." };
		onGoalProposal(state, proposal);
		expect(state.activeGoalProposal !== null).toBe(true);

		// Step 2: dismiss clears it and persists the fingerprint.
		handleDismiss(state);
		expect(state.activeGoalProposal === null).toBe(true);

		// Step 3: after simulated reconnect (onGoalProposal fired again with the
		// same proposal), it must stay null because it was dismissed.
		onGoalProposal(state, proposal);
		expect(
			state.activeGoalProposal === null,
			"proposal reappeared after dismiss — expected null but got re-set by onGoalProposal",
		).toBe(true);
	});

	it("new different proposal should appear even after dismissing old one", () => {
		const state = makeState();

		// Show and dismiss the first proposal.
		onGoalProposal(state, { title: "Fix login bug", spec: "Login page has a bug" });
		handleDismiss(state);

		// A NEW, different proposal arrives — different fingerprint, not dismissed.
		onGoalProposal(state, { title: "Add dark mode", spec: "Implement dark mode support" });

		expect(state.activeGoalProposal !== null).toBe(true);
	});
});
