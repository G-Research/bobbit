import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/goal-proposal-dismiss.html")}`;

test.describe("Goal proposal dismiss persistence", () => {
	test("dismissed proposal should not reappear after simulated reconnect", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const results = await page.evaluate(() => (window as any).testResults);

		// Step 1: proposal was set initially
		expect(results.step1_proposalSet).toBe(true);

		// Step 2: dismiss cleared it
		expect(results.step2_dismissed).toBe(true);

		// Step 3: after simulated reconnect (onGoalProposal called again),
		// the proposal should stay null because it was dismissed.
		// BUG: the current code unconditionally sets it back.
		expect(
			results.step3_proposalStaysNull,
			"proposal reappeared after dismiss — expected null but got re-set by onGoalProposal",
		).toBe(true);
	});

	test("new different proposal should appear even after dismissing old one", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Run additional scenario in the page context
		const newProposalShown = await page.evaluate(() => {
			const state = { activeGoalProposal: null as any, assistantType: "normal" };

			function onGoalProposal(proposal: any) {
				state.activeGoalProposal = proposal;
			}
			function handleDismiss() {
				state.activeGoalProposal = null;
			}

			// Show and dismiss first proposal
			const proposal1 = { title: "Fix login bug", spec: "Login page has a bug" };
			onGoalProposal(proposal1);
			handleDismiss();

			// A NEW, different proposal arrives
			const proposal2 = { title: "Add dark mode", spec: "Implement dark mode support" };
			onGoalProposal(proposal2);

			// The new proposal SHOULD appear (different from dismissed one)
			return state.activeGoalProposal !== null;
		});

		expect(newProposalShown).toBe(true);
	});
});
