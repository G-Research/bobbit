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

/** Helper: open goal assistant, send GOAL_PROPOSAL, wait for proposal panel.
 *
 * Goal-assistant cold-start does sync FS work (config dirs, prompt assembly,
 * mock-agent registry) which contends with concurrent goal-assistant creations
 * across the 3 browser workers. Each step's timeout is set to absorb the
 * worst-case wait we've measured under full-suite parallel load (≈30s for
 * textarea visibility on the slowest worker). */
async function triggerGoalProposal(page: import("@playwright/test").Page) {
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await newGoalBtn.click();
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 30_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
	// Wait for the proposal panel to render with the title populated
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });
}

/** Helper: find and delete a goal by title (best-effort cleanup). */
async function deleteGoalByTitle(title: string) {
	const resp = await apiFetch("/api/goals");
	const data = await resp.json();
	const goals = data.goals || data;
	const goal = (goals as any[]).find((g: any) => g.title === title);
	if (goal) await apiFetch(`/api/goals/${goal.id}?cascade=true`, { method: "DELETE" }).catch(() => {});
}

test.describe("Proposal tool blocks @quarantine", () => {
	test("goal proposal tool card renders, persists, and reopens @smoke", async ({ page }) => {
		await triggerGoalProposal(page);

		// The message area should contain a completed tool card for propose_goal.
		// The ProposalRenderer renders with the "Goal Proposal" label and title summary.
		const proposalCard = page.getByText("Goal Proposal").first();
		await expect(proposalCard).toBeVisible({ timeout: 10_000 });
		await expect(page.getByText("E2E Test Goal").first()).toBeVisible({ timeout: 5_000 });

		// Completed proposal tool blocks expose an "Open proposal" button.
		const openBtn = page.locator('[data-testid="proposal-open-button"]').first();
		await expect(openBtn).toBeVisible({ timeout: 10_000 });
		await expect(openBtn).toHaveText(/Open proposal/);

		// Navigate away to settings.
		await navigateToHash(page, "#/settings");
		await expect(page.getByText("Settings").first()).toBeVisible({ timeout: 5_000 });

		// Navigate back using browser back; the next visibility assertion auto-retries.
		await page.goBack();

		// The tool block should persist with the "Open proposal" button and label.
		const openBtnAfter = page.locator('[data-testid="proposal-open-button"]').first();
		await expect(openBtnAfter).toBeVisible({ timeout: 15_000 });
		await expect(openBtnAfter).toHaveText(/Open proposal/);
		await expect(page.getByText("Goal Proposal").first()).toBeVisible({ timeout: 5_000 });

		// Click the "Open proposal" button to reopen the proposal panel.
		await openBtnAfter.click();
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
