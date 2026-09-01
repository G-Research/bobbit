/**
 * Goal proposal tab wiring regressions (browser E2E repro).
 *
 * Covers the split goal-preview / + New Goal path specifically. The tabs are
 * visible there, but Workflow/Roles customization must be wired the same way as
 * the full assistant proposal panel, and tab state must not leak across proposal
 * contexts.
 */
import { test, expect } from "../../support/harnesses/browser/gateway-harness.js";
import type { Page } from "@playwright/test";
import { MockAgentCore } from "../../../tests/e2e/mock-agent-core.mjs";
import { openApp, createSessionViaUI, createGoalAssistantViaUI } from "../../support/helpers/browser/fixtures/ui-helpers.js";

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

function installAuthenticatedMockProposalCalls(): void {
	// The in-process mock's canned proposal path bypasses the real extension,
	// whose gateway client already sends BOBBIT_SESSION_SECRET. Keep these browser
	// fixtures on the same owner-auth contract without weakening the tool-card and
	// revision assertions.
	const prototype = MockAgentCore.prototype as any;
	const original = prototype._gatewayPost;
	if (original.__proposalOwnerAuthInstalled) return;
	const authenticatedPost = function(this: any, pathname: string, body: unknown, extraHeaders: Record<string, string> = {}) {
		return original.call(this, pathname, body, {
			"X-Bobbit-Session-Secret": this.env.BOBBIT_SESSION_SECRET || "",
			...extraHeaders,
		});
	};
	authenticatedPost.__proposalOwnerAuthInstalled = true;
	prototype._gatewayPost = authenticatedPost;
}
installAuthenticatedMockProposalCalls();

async function sendChatMessage(page: Page, text: string) {
	const textarea = page.locator("message-editor textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await textarea.fill(text);
	await textarea.press("Enter");
}

async function waitForGoalProposal(
	page: Page,
	expectedTitle: string,
	expectedRev: number,
	options: { expectTitleVisible?: boolean } = {},
) {
	await page.waitForFunction(
		({ title, rev }) => {
			const proposal = (window as any).bobbitState?.activeProposals?.goal;
			return proposal?.rev === rev && proposal?.fields?.title === title;
		},
		{ title: expectedTitle, rev: expectedRev },
		{ timeout: 20_000 },
	);
	if (options.expectTitleVisible === false) return;
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue(expectedTitle, { timeout: 20_000 });
}

async function sendGoalProposal(
	page: Page,
	gateway: any,
	trigger: string,
	expectedTitle: string,
	options: { expectTitleVisible?: boolean } = {},
): Promise<number> {
	const sessionId = await page.evaluate(() => (window as any).bobbitState?.selectedSessionId as string | undefined);
	expect(sessionId, "proposal fixture requires an active session").toBeTruthy();
	const core = gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent;
	if (!core || typeof core.armBarrier !== "function" || typeof core.waitForBarrier !== "function") {
		throw new Error("goal proposal fixture requires the in-process mock agent barrier seam");
	}

	const previousPrompts = Array.isArray(core.commandJournal)
		? core.commandJournal.filter((entry: any) => entry?.kind === "prompt")
		: [];
	const occurrence = (previousPrompts.at(-1)?.occurrence ?? 0) + 1;
	const receiptBoundary = `prompt:${occurrence}:received`;
	const completionBoundary = "turn:before-agent-end";
	core.releaseBarrier(completionBoundary);
	core.armBarrier(receiptBoundary);
	core.armBarrier(completionBoundary);
	const receipt = Promise.resolve(core.waitForBarrier(receiptBoundary));
	const completed = Promise.resolve(core.waitForBarrier(completionBoundary));

	let persistedRev: number | undefined;
	try {
		await sendChatMessage(page, trigger);
		const details: any = await receipt;
		if (details?.kind !== "prompt" || details?.occurrence !== occurrence || details?.text !== trigger) {
			throw new Error(`goal proposal fixture received an uncorrelated prompt: ${JSON.stringify(details)}`);
		}
		core.releaseBarrier(receiptBoundary);
		await completed;

		const persisted = await page.evaluate(async ({ sid, title }) => {
			const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/proposals`, { credentials: "include" });
			const text = await response.text();
			const proposals = response.ok
				? (JSON.parse(text) as { proposals?: Array<{ proposalType: string; fields: Record<string, unknown>; rev: number }> }).proposals
				: undefined;
			const proposal = proposals?.find((candidate) => candidate.proposalType === "goal" && candidate.fields?.title === title);
			return { status: response.status, text, proposal };
		}, { sid: sessionId!, title: expectedTitle });
		expect(persisted.status, `read persisted goal proposal failed: ${persisted.text}`).toBe(200);
		expect(persisted.proposal, `expected persisted goal proposal titled ${expectedTitle}: ${persisted.text}`).toBeDefined();
		expect(persisted.proposal?.rev, "persisted goal proposal should carry its server revision").toBeGreaterThan(0);
		persistedRev = persisted.proposal!.rev;
	} finally {
		core.releaseBarrier(receiptBoundary);
		core.releaseBarrier(completionBoundary);
	}

	await waitForGoalProposal(page, expectedTitle, persistedRev!, options);
	return persistedRev!;
}

async function openNewGoalAssistantProposal(page: Page, gateway: any) {
	test.setTimeout(90_000);
	await openApp(page);
	await createGoalAssistantViaUI(page, { timeout: 60_000 });
	await expect(page.locator("message-editor textarea").first()).toBeVisible({ timeout: 10_000 });
	await sendGoalProposal(page, gateway, "Please create a GOAL_PROPOSAL for testing", "E2E Test Goal");
}

async function openRegularSessionProposal(
	page: Page,
	gateway: any,
	trigger: string,
	expectedTitle: string,
	options: { expectTitleVisible?: boolean; createSession?: boolean } = {},
) {
	if (options.createSession !== false) await createSessionViaUI(page);
	await sendGoalProposal(page, gateway, trigger, expectedTitle, options);
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
	test("+ New Goal Workflow customization opens the editable workflow editor @repro", async ({ page, gateway }) => {
		await openNewGoalAssistantProposal(page, gateway);

		await page.locator(WORKFLOW_TAB).click();
		await expect(page.locator(WORKFLOW_PANEL)).toBeVisible({ timeout: 10_000 });
		await expect(page.locator("[data-testid='workflow-inspector']")).toBeVisible({ timeout: 10_000 });

		await page.locator(WORKFLOW_CUSTOMIZE).click();

		await expect(
			page.locator(`${WORKFLOW_PANEL} [data-testid='workflow-editor']`),
			"+ New Goal Workflow > Customise for this goal must swap the inspector for the editable workflow editor",
		).toBeVisible({ timeout: 10_000 });
	});

	test("new proposal contexts start on the Goal tab after another context visits other tabs @repro", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await openApp(page);

		await openRegularSessionProposal(page, gateway, "Please create a GOAL_PROPOSAL for testing", "E2E Test Goal");
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

		await openRegularSessionProposal(page, gateway, "Please create GOAL_PROPOSAL_REV2 now", "Revised Goal Title", {
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

	test("historical goal revisions in a goal assistant render historical fields and keep live tab state isolated", async ({ page, gateway }) => {
		test.setTimeout(90_000);
		await openNewGoalAssistantProposal(page, gateway);
		await sendGoalProposal(page, gateway, "Please create GOAL_PROPOSAL_REV2 now", "Revised Goal Title");

		await page.locator(WORKFLOW_TAB).click();
		await expect(page.locator(WORKFLOW_TAB)).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

		const expectedProjectId = await page.evaluate(() => {
			const st = (window as any).bobbitState;
			const sid = st?.selectedSessionId;
			return st?.gatewaySessions?.find((s: any) => s.id === sid)?.projectId || st?.projects?.[0]?.id || "";
		});
		expect(expectedProjectId, "test fixture should have a concrete source project").toBeTruthy();
		await page.evaluate(() => {
			(window as any).bobbitState.previewProjectId = "stale-project-id";
			(window as any).__bobbitRenderApp?.();
		});

		await clickProposalOpenButtonForRev(page, 1, "GOAL_HISTORICAL_TAB_WIRING");
		await expect.poll(
			() => page.evaluate(() => (window as any).bobbitState?.previewProjectId || ""),
			{ timeout: 10_000, message: "historical goal revision must replace stale previewProjectId with its source project" },
		).toBe(expectedProjectId);
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
