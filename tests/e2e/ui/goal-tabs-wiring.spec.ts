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
const PANEL_TAB_SELECTOR = ".goal-tab-pill";
const GOAL_PROPOSAL_TAB_TITLE_RE = /^Goal Proposal$/i;

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
	options: { expectTitleVisible?: boolean; createSession?: boolean } = {},
) {
	if (options.createSession !== false) await createSessionViaUI(page);
	await sendChatMessage(page, trigger);
	await waitForGoalProposal(page, expectedTitle, options);
}

async function visiblePanelTabs(page: Page): Promise<Array<{ index: number; title: string; kind: string; active: boolean }>> {
	return page.locator(PANEL_TAB_SELECTOR).evaluateAll((buttons) => buttons
		.map((button, index) => {
			const el = button as HTMLElement;
			const style = window.getComputedStyle(el);
			const rect = el.getBoundingClientRect();
			if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return null;
			return {
				index,
				title: (button.getAttribute("data-panel-tab-title") || "").replace(/\s+/g, " ").trim(),
				kind: button.getAttribute("data-panel-tab-kind") || "",
				active: button.classList.contains("goal-tab-pill--active"),
			};
		})
		.filter(Boolean) as Array<{ index: number; title: string; kind: string; active: boolean }>);
}

async function clickPanelTabByIndex(page: Page, index: number, errorPrefix: string): Promise<void> {
	const tab = page.locator(PANEL_TAB_SELECTOR).nth(index);
	await tab.evaluate((el) => (el as HTMLElement).scrollIntoView({ block: "nearest", inline: "center" }));
	await expect(tab, `${errorPrefix}: tab at index ${index} should be visible before click`).toBeVisible({ timeout: 5_000 });
	await tab.click();
}

async function selectPanelTabByTitle(page: Page, title: RegExp, errorPrefix: string): Promise<void> {
	const tabs = await visiblePanelTabs(page);
	const match = tabs.find((tab) => tab.kind === "proposal" && title.test(tab.title));
	if (!match) throw new Error(`${errorPrefix}: expected proposal tab title ${title}; visible=${JSON.stringify(tabs)}`);
	await clickPanelTabByIndex(page, match.index, errorPrefix);
}

async function clickProposalOpenButtonForRev(page: Page, rev: number, errorPrefix: string): Promise<void> {
	const card = page.locator("tool-message", {
		has: page.locator('[data-testid="proposal-rev"]', { hasText: new RegExp(`^\\s*rev\\s+${rev}\\s*$`) }),
	}).first();
	await expect(card, `${errorPrefix}: rev ${rev} proposal tool card should be present`).toBeVisible({ timeout: 15_000 });
	const button = card.locator('[data-testid="proposal-open-button"]').first();
	await button.scrollIntoViewIfNeeded();
	await expect(button, `${errorPrefix}: rev ${rev} Open proposal button should be enabled`).toBeEnabled({ timeout: 5_000 });
	await button.click();
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

		await page.locator(WORKFLOW_TAB).click();
		await page.locator(WORKFLOW_CUSTOMIZE).click();
		await expect(page.locator(`${WORKFLOW_PANEL} [data-testid='workflow-editor']`)).toBeVisible({ timeout: 10_000 });

		await openRegularSessionProposal(page, "Please create GOAL_PROPOSAL_REV2 now", "Revised Goal Title", {
			expectTitleVisible: false,
			createSession: false,
		});

		await expect(
			page.locator(GOAL_TAB),
			"a newly opened goal proposal context must default to the Goal tab, not inherit the previous context's active tab",
		).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
		await expect(page.locator(GOAL_PANEL)).toBeVisible({ timeout: 10_000 });

		await page.locator(WORKFLOW_TAB).click();
		await expect(
			page.locator(`${WORKFLOW_PANEL} [data-testid='workflow-inspector']`),
			"a replacement proposal must not inherit the previous proposal's inline workflow draft",
		).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(`${WORKFLOW_PANEL} [data-testid='workflow-editor']`)).toHaveCount(0);
	});

	test("historical goal revisions in a goal assistant render historical fields and keep live tab state isolated", async ({ page }) => {
		test.setTimeout(90_000);
		await openNewGoalAssistantProposal(page);
		await sendChatMessage(page, "Please create GOAL_PROPOSAL_REV2 now");
		await waitForGoalProposal(page, "Revised Goal Title");

		await page.locator(WORKFLOW_TAB).click();
		await expect(page.locator(WORKFLOW_TAB)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

		await clickProposalOpenButtonForRev(page, 1, "GOAL_HISTORICAL_TAB_WIRING");
		await expect(
			page.locator('[data-testid="proposal-panel-rev"]').first(),
			"rev 1 should render in the active historical goal proposal panel",
		).toHaveText("rev 1", { timeout: 10_000 });
		await expect(page.locator("input[placeholder='Goal title']").first()).toHaveValue("E2E Test Goal", { timeout: 10_000 });

		await page.locator(METADATA_TAB).click();
		await expect(page.locator(METADATA_TAB)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

		await selectPanelTabByTitle(page, GOAL_PROPOSAL_TAB_TITLE_RE, "GOAL_HISTORICAL_TAB_WIRING");
		await expect(
			page.locator(WORKFLOW_TAB),
			"navigating inside a historical proposal must not mutate the live proposal's active tab",
		).toHaveAttribute("aria-selected", "true", { timeout: 10_000 });
		await page.locator(GOAL_TAB).click();
		await expect(page.locator("input[placeholder='Goal title']").first()).toHaveValue("Revised Goal Title", { timeout: 10_000 });
	});
});
