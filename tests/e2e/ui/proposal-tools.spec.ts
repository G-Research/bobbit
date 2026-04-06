/**
 * E2E tests for proposal tool call features.
 *
 * Covers:
 * - propose_goal tool call block renders in message history
 * - "Open proposal" button appears on completed tool blocks
 * - Navigate away and back — tool block persists with "Open proposal" button
 * - Click "Open proposal" button reopens the proposal panel
 * - Dismiss hides proposal panel, tool block remains visible
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, sendMessage, navigateToHash } from "./ui-helpers.js";

/** Helper: open goal assistant, send GOAL_PROPOSAL, wait for proposal panel. */
async function triggerGoalProposal(page: import("@playwright/test").Page) {
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await newGoalBtn.click();
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 15_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	// Wait for the proposal panel to render with the title populated
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 15_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

/** Helper: find and delete a goal by title (best-effort cleanup). */
async function deleteGoalByTitle(title: string) {
	const resp = await apiFetch("/api/goals");
	const data = await resp.json();
	const goals = data.goals || data;
	const goal = (goals as any[]).find((g: any) => g.title === title);
	if (goal) await apiFetch(`/api/goals/${goal.id}`, { method: "DELETE" }).catch(() => {});
}

test.describe("Proposal tool blocks", () => {
	test("propose_goal tool block renders in message history", async ({ page }) => {
		await triggerGoalProposal(page);

		// The message area should contain a tool card for propose_goal
		// The ProposalRenderer renders with "Goal Proposal" label
		const proposalCard = page.getByText("Goal Proposal").first();
		await expect(proposalCard).toBeVisible({ timeout: 10_000 });

		// The card should show the title in the tool card summary
		await expect(page.getByText("E2E Test Goal").first()).toBeVisible({ timeout: 5_000 });
	});

	test("Open proposal button appears on completed tool block", async ({ page }) => {
		await triggerGoalProposal(page);

		// Wait for the tool block to complete and show "Open proposal" button
		const openBtn = page.getByText("Open proposal").first();
		await expect(openBtn).toBeVisible({ timeout: 10_000 });
	});

	test("navigate away and back — tool block persists with Open proposal button", async ({ page }) => {
		await triggerGoalProposal(page);

		// Wait for the "Open proposal" button to appear (tool block completed)
		const openBtn = page.getByText("Open proposal").first();
		await expect(openBtn).toBeVisible({ timeout: 10_000 });

		// Navigate away to settings
		await navigateToHash(page, "#/settings");
		await expect(page.getByText("Settings").first()).toBeVisible({ timeout: 5_000 });

		// Navigate back using browser back
		await page.goBack();
		await page.waitForTimeout(1000);

		// The tool block should still be visible with the "Open proposal" button
		const openBtnAfter = page.getByText("Open proposal").first();
		await expect(openBtnAfter).toBeVisible({ timeout: 15_000 });

		// The "Goal Proposal" label should also be visible
		await expect(page.getByText("Goal Proposal").first()).toBeVisible({ timeout: 5_000 });
	});

	test("click Open proposal button reopens proposal panel", async ({ page }) => {
		await triggerGoalProposal(page);

		// Wait for tool block to complete
		const openBtn = page.getByText("Open proposal").first();
		await expect(openBtn).toBeVisible({ timeout: 10_000 });

		// Navigate away to settings to close the proposal panel
		await navigateToHash(page, "#/settings");
		await expect(page.getByText("Settings").first()).toBeVisible({ timeout: 5_000 });

		// Navigate back
		await page.goBack();
		await page.waitForTimeout(1000);

		// Click the "Open proposal" button
		const reopenBtn = page.getByText("Open proposal").first();
		await expect(reopenBtn).toBeVisible({ timeout: 15_000 });
		await reopenBtn.click();

		// The proposal panel should reopen with the title populated
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 10_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 10_000 });
	});

	test("dismiss hides proposal panel but tool block remains", async ({ page }) => {
		// Use a regular session (not assistant) to get the dismiss button
		await openApp(page);
		await page.locator("button[title^='New session']").first().click();
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		// Wait for the proposal panel
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// Find and click dismiss button
		const dismissBtn = page.locator("button").filter({ hasText: "Dismiss" }).first();
		await expect(dismissBtn).toBeVisible({ timeout: 5_000 });
		await dismissBtn.click();

		// The proposal panel should be hidden
		await expect(titleInput).not.toBeVisible({ timeout: 5_000 });

		// The "Goal Proposal" tool card in the message area should still be visible
		await expect(page.getByText("Goal Proposal").first()).toBeVisible({ timeout: 5_000 });

		// The "Open proposal" button should still be visible on the tool card
		const openBtn = page.getByText("Open proposal").first();
		await expect(openBtn).toBeVisible({ timeout: 5_000 });
	});
});
