/**
 * Reproducing coverage for proposal-tab routing in normal chat sessions.
 *
 * Role/tool/staff proposals already reach state.activeProposals and render an
 * Open proposal action in the transcript. Normal sessions must also surface a
 * visible proposal tab and pane for each type.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

type ProposalType = "role" | "tool" | "staff";

interface ProposalCase {
	type: ProposalType;
	label: "Role" | "Tool" | "Staff";
	trigger: string;
	toolCardLabel: string;
	panel: string;
}

const CASES: ProposalCase[] = [
	{
		type: "role",
		label: "Role",
		trigger: "ROLE_PROPOSAL_PARITY",
		toolCardLabel: "Role Proposal",
		panel: "role-proposal",
	},
	{
		type: "tool",
		label: "Tool",
		trigger: "TOOL_PROPOSAL_PARITY",
		toolCardLabel: "Tool Proposal",
		panel: "tool-proposal",
	},
	{
		type: "staff",
		label: "Staff",
		trigger: "STAFF_PROPOSAL_PARITY",
		toolCardLabel: "Staff Proposal",
		panel: "staff-proposal",
	},
];

async function waitForProposalSlot(page: Page, type: ProposalType): Promise<void> {
	await page.waitForFunction(
		(t) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			const fields = state?.activeProposals?.[t]?.fields;
			return fields && typeof fields === "object" && Object.keys(fields).length > 0;
		},
		type,
		{ timeout: 15_000 },
	);
}

async function expectNormalChatSession(page: Page): Promise<void> {
	const assistantType = await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state?.assistantType ?? null;
	});
	expect(assistantType, "test must use a normal chat session, not an assistant session").toBeFalsy();
}

test.describe("Proposal tabs open all proposal types in normal sessions", () => {
	test.describe.configure({ timeout: 75_000 });

	for (const proposal of CASES) {
		test(`${proposal.label} proposal card opens a ${proposal.label} tab`, async ({ page }) => {
			await openApp(page);
			await createSessionViaUI(page);
			await expectNormalChatSession(page);

			await sendMessage(page, proposal.trigger);
			await expect(page.getByText(proposal.toolCardLabel).first()).toBeVisible({ timeout: 15_000 });
			await waitForProposalSlot(page, proposal.type);

			const openButton = page.locator('[data-testid="proposal-open-button"]').first();
			await expect(openButton).toBeVisible({ timeout: 15_000 });
			await openButton.click();

			const tab = page
				.locator("button.goal-tab-pill")
				.filter({ hasText: new RegExp(`^${proposal.label}\\b`) })
				.first();
			await expect(
				tab,
				`${proposal.label} proposal tab should be visible in normal sessions`,
			).toBeVisible({ timeout: 5_000 });

			await tab.click();
			await expect(
				page.locator(`[data-panel="${proposal.panel}"]`).first(),
				`${proposal.label} proposal pane should be visible in normal sessions`,
			).toBeVisible({ timeout: 5_000 });
		});
	}
});
