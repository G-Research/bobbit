/**
 * Goal proposal tab wiring regressions (browser E2E repro).
 *
 * Covers the split goal-preview / + New Goal path specifically. The tabs are
 * visible there, but Workflow/Roles customization must be wired the same way as
 * the full assistant proposal panel, and tab state must not leak across proposal
 * contexts.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, createSessionViaUI } from "./ui-helpers.js";

const GOAL_TAB = "[data-testid='goal-proposal-tab-goal']";
const GOAL_PANEL = "[data-testid='goal-proposal-panel-goal']";
const WORKFLOW_TAB = "[data-testid='goal-proposal-tab-workflow']";
const WORKFLOW_PANEL = "[data-testid='goal-proposal-panel-workflow']";
const WORKFLOW_CUSTOMIZE = "[data-testid='goal-proposal-workflow-customize']";
const METADATA_TAB = "[data-testid='goal-proposal-tab-metadata']";
const METADATA_PANEL = "[data-testid='goal-proposal-panel-metadata']";
const ROLES_TAB = "[data-testid='goal-proposal-tab-roles']";
const ROLES_PANEL = "[data-testid='goal-proposal-panel-roles']";

async function sendChatMessage(page: Page, text: string) {
	const textarea = page.locator("message-editor textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await textarea.fill(text);
	await textarea.press("Enter");
}

async function waitForGoalProposal(page: Page, expectedTitle: string, options: { expectTitleVisible?: boolean } = {}) {
	await page.waitForFunction(
		(title) => (window as any).bobbitState?.activeProposals?.goal?.fields?.title === title,
		expectedTitle,
		{ timeout: 20_000 },
	);
	if (options.expectTitleVisible === false) return;
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue(expectedTitle, { timeout: 20_000 });
}

async function openNewGoalAssistantProposal(page: Page) {
	test.setTimeout(90_000);
	await openApp(page);
	const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
	await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
	await expect(newGoalBtn).toBeEnabled({ timeout: 10_000 });
	const sessionCreated = page.waitForResponse(
		(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 60_000 },
	);
	await newGoalBtn.click();
	await sessionCreated;
	await page.waitForURL(/#\/session\//, { timeout: 10_000 });
	await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 10_000 });
	await sendChatMessage(page, "Please create a GOAL_PROPOSAL for testing");
	await waitForGoalProposal(page, "E2E Test Goal");
}

async function openRegularSessionProposal(
	page: Page,
	trigger: string,
	expectedTitle: string,
	options: { expectTitleVisible?: boolean } = {},
) {
	await createSessionViaUI(page);
	await sendChatMessage(page, trigger);
	await waitForGoalProposal(page, expectedTitle, options);
}

test.describe("Goal proposal — tab wiring repro", () => {
	test("+ New Goal Workflow customization opens the editable workflow editor @repro", async ({ page }) => {
		await openNewGoalAssistantProposal(page);

		await page.locator(WORKFLOW_TAB).click();
		await expect(page.locator(WORKFLOW_PANEL)).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[data-testid='workflow-inspector']")).toBeVisible({ timeout: 10_000 });

		await page.locator(WORKFLOW_CUSTOMIZE).click();

		await expect(
			page.locator(`${WORKFLOW_PANEL} [data-testid='workflow-editor']`),
			"+ New Goal Workflow > Customise for this goal must swap the inspector for the editable workflow editor",
		).toBeVisible({ timeout: 10_000 });
	});

	test("new proposal contexts start on the Goal tab after another context visits other tabs @repro", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);

		await openRegularSessionProposal(page, "Please create a GOAL_PROPOSAL for testing", "E2E Test Goal");
		await expect(page.locator(GOAL_TAB)).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
		await expect(page.locator(GOAL_PANEL)).toBeVisible({ timeout: 10_000 });

		await page.locator(WORKFLOW_TAB).click();
		await expect(page.locator(WORKFLOW_PANEL)).toBeVisible({ timeout: 10_000 });
		await page.locator(ROLES_TAB).click();
		await expect(page.locator(ROLES_PANEL)).toBeVisible({ timeout: 10_000 });
		await page.locator(METADATA_TAB).click();
		await expect(page.locator(METADATA_PANEL)).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(METADATA_TAB)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

		await openRegularSessionProposal(page, "Please create GOAL_PROPOSAL_REV2 now", "Revised Goal Title", {
			expectTitleVisible: false,
		});

		await expect(
			page.locator(GOAL_TAB),
			"a newly opened goal proposal context must default to the Goal tab, not inherit the previous context's active tab",
		).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
		await expect(page.locator(GOAL_PANEL)).toBeVisible({ timeout: 10_000 });
	});
});
