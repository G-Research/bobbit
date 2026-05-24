/**
 * Browser E2E coverage for opening every proposal type from a normal chat session.
 *
 * The proposal transport is type-generic; ordinary sessions must surface a
 * tab/pane for every active proposal slot, not just goal/project.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import type { Locator, Page } from "@playwright/test";
import { openApp, createSessionViaUI, sendMessage } from "./ui-helpers.js";

type ProposalType = "goal" | "project" | "role" | "tool" | "staff";
type ProposalLabel = "Goal" | "Project" | "Role" | "Tool" | "Staff";

interface ProposalCase {
	type: ProposalType;
	label: ProposalLabel;
	trigger: string;
	toolCardLabel: string;
	panel?: string;
	fieldKey: string;
	fieldValue: string;
}

const CASES: ProposalCase[] = [
	{
		type: "goal",
		label: "Goal",
		trigger: "GOAL_PROPOSAL_PARITY",
		toolCardLabel: "Goal Proposal",
		fieldKey: "title",
		fieldValue: "Parity Goal A",
	},
	{
		type: "project",
		label: "Project",
		trigger: "PROJECT_PROPOSAL_PARITY",
		toolCardLabel: "Project Proposal",
		panel: "project-proposal",
		fieldKey: "name",
		fieldValue: "Parity Project",
	},
	{
		type: "role",
		label: "Role",
		trigger: "ROLE_PROPOSAL_PARITY",
		toolCardLabel: "Role Proposal",
		panel: "role-proposal",
		fieldKey: "name",
		fieldValue: "parity-role",
	},
	{
		type: "tool",
		label: "Tool",
		trigger: "TOOL_PROPOSAL_PARITY",
		toolCardLabel: "Tool Proposal",
		panel: "tool-proposal",
		fieldKey: "tool",
		fieldValue: "parity-tool",
	},
	{
		type: "staff",
		label: "Staff",
		trigger: "STAFF_PROPOSAL_PARITY",
		toolCardLabel: "Staff Proposal",
		panel: "staff-proposal",
		fieldKey: "name",
		fieldValue: "parity-staff",
	},
];

const STAFF_ACCEPT_NAME = "parity-staff";

// Browser E2E keeps one generic non-goal/project proposal flow as a real
// gateway + mock-agent smoke. The full per-type rendering/dismissal matrix is
// covered by tests/ui-fixtures/proposal-review-fixture.spec.ts.
const BROWSER_CASES = CASES.filter((c) => c.type === "role");

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

async function waitForProposalSlotAbsent(page: Page, type: ProposalType): Promise<void> {
	await page.waitForFunction(
		(t) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return !!state && !state.activeProposals?.[t];
		},
		type,
		{ timeout: 10_000 },
	);
}

async function selectedSessionId(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state?.selectedSessionId ?? null;
	});
}

async function activeSessionId(page: Page): Promise<string> {
	const sid = await selectedSessionId(page);
	expect(sid, "active session id must be set").toBeTruthy();
	return sid as string;
}

async function expectNormalChatSession(page: Page): Promise<void> {
	const assistantType = await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state?.assistantType ?? null;
	});
	expect(assistantType, "test must use a normal chat session, not an assistant session").toBeFalsy();
}

async function expectSlotField(page: Page, proposal: ProposalCase): Promise<void> {
	await expect
		.poll(
			async () => page.evaluate(
				({ type, fieldKey }) => {
					const state = (window as any).bobbitState ?? (window as any).__bobbitState;
					return state?.activeProposals?.[type]?.fields?.[fieldKey] ?? null;
				},
				{ type: proposal.type, fieldKey: proposal.fieldKey },
			),
			{ timeout: 10_000 },
		)
		.toBe(proposal.fieldValue);
}

async function otherProposalSlots(page: Page, type: ProposalType): Promise<Record<string, unknown>> {
	return page.evaluate((t) => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const out: Record<string, unknown> = {};
		for (const [key, slot] of Object.entries(state?.activeProposals ?? {})) {
			if (key === t) continue;
			out[key] = JSON.parse(JSON.stringify((slot as any)?.fields ?? slot));
		}
		return out;
	}, type);
}

function proposalTab(page: Page, proposal: ProposalCase): Locator {
	return page.locator(`button.goal-tab-pill[title="${proposal.label}"]`).first();
}

function proposalPane(page: Page, proposal: ProposalCase): Locator {
	if (proposal.type === "goal") {
		return page
			.locator(".goal-preview-panel")
			.filter({ has: page.locator('input[placeholder="Goal title"]') })
			.first();
	}
	return page.locator(`[data-panel="${proposal.panel}"]`).first();
}

async function expectProposalTabAndPane(page: Page, proposal: ProposalCase): Promise<void> {
	const tab = proposalTab(page, proposal);
	await expect(
		tab,
		`${proposal.label} proposal tab should be visible in normal sessions`,
	).toBeVisible({ timeout: 5_000 });
	await expect(
		tab.locator(".goal-tab-dot"),
		`${proposal.label} proposal tab should show the proposal dot`,
	).toBeVisible({ timeout: 5_000 });
	await tab.click();
	await expect(
		proposalPane(page, proposal),
		`${proposal.label} proposal pane should be visible in normal sessions`,
	).toBeVisible({ timeout: 5_000 });
	await expectSlotField(page, proposal);
}

async function expectProposalToolCard(page: Page, proposal: ProposalCase): Promise<Locator> {
	await expect(page.getByText(proposal.toolCardLabel).first()).toBeVisible({ timeout: 15_000 });
	const openButton = page.locator('[data-testid="proposal-open-button"]').last();
	await expect(openButton).toBeVisible({ timeout: 15_000 });
	await expect(openButton).toHaveText(/Open proposal/);
	return openButton;
}

async function switchToMobileChatAndBack(page: Page, proposal: ProposalCase): Promise<void> {
	await page.setViewportSize({ width: 390, height: 800 });
	await expectProposalTabAndPane(page, proposal);

	await expect(page.locator('button.goal-tab-pill[title="Chat"]')).toHaveCount(0, { timeout: 5_000 });
	await proposalTab(page, proposal).click();
	await expect(proposalTab(page, proposal)).toHaveClass(/goal-tab-pill--active/);
	await expect(proposalPane(page, proposal)).toBeVisible({ timeout: 5_000 });
	await expectSlotField(page, proposal);
}

async function reloadAndOpenProposal(page: Page, proposal: ProposalCase, sessionId: string): Promise<void> {
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.reload();
	await page.waitForFunction(
		(sid) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.selectedSessionId === sid && state?.connectionStatus === "connected";
		},
		sessionId,
		{ timeout: 20_000 },
	);
	await waitForProposalSlot(page, proposal.type);

	await expect(page.locator('button.goal-tab-pill[title="Chat"]')).toHaveCount(0, { timeout: 5_000 });
	const openButton = await expectProposalToolCard(page, proposal);
	await openButton.scrollIntoViewIfNeeded();
	await openButton.click();
	await expectProposalTabAndPane(page, proposal);
}

async function dismissProposal(page: Page, proposal: ProposalCase, sessionId: string): Promise<void> {
	const beforeOtherSlots = await otherProposalSlots(page, proposal.type);
	const panel = proposalPane(page, proposal);
	await expect(panel).toBeVisible({ timeout: 5_000 });
	const dismiss = panel.getByRole("button", { name: /^Dismiss$/ }).first();
	await expect(
		dismiss,
		`${proposal.label} proposal pane should expose a Dismiss action in normal sessions`,
	).toBeVisible({ timeout: 5_000 });
	await dismiss.click();

	await waitForProposalSlotAbsent(page, proposal.type);
	await expect(proposalTab(page, proposal)).toHaveCount(0, { timeout: 5_000 });
	await expect.poll(() => selectedSessionId(page), { timeout: 5_000 }).toBe(sessionId);
	await expect(page.locator("textarea").first()).toBeVisible({ timeout: 5_000 });
	expect(await otherProposalSlots(page, proposal.type)).toEqual(beforeOtherSlots);
}

async function staffByName(name: string): Promise<any[]> {
	const res = await apiFetch("/api/staff");
	expect(res.ok, "GET /api/staff should succeed").toBe(true);
	const body = await res.json();
	const staff = Array.isArray(body) ? body : (body.staff ?? []);
	return staff.filter((entry: any) => entry?.name === name);
}

async function deleteStaffByName(name: string): Promise<void> {
	for (const staff of await staffByName(name)) {
		await apiFetch(`/api/staff/${staff.id}`, { method: "DELETE" }).catch(() => {});
	}
}

test.describe("Proposal tabs open all proposal types in normal sessions", () => {
	test.describe.configure({ timeout: 90_000 });

	for (const proposal of BROWSER_CASES) {
		const title = proposal.type === "staff"
			? "Staff proposal card opens a Staff tab, rehydrates, and dismisses from a normal session"
			: `${proposal.label} proposal is openable, rehydrates, and dismisses from a normal session`;
		test(title, async ({ page }) => {
			await openApp(page);
			await createSessionViaUI(page);
			await expectNormalChatSession(page);
			const sessionId = await activeSessionId(page);

			await sendMessage(page, proposal.trigger);
			const openButton = await expectProposalToolCard(page, proposal);
			await waitForProposalSlot(page, proposal.type);
			await expectSlotField(page, proposal);

			await openButton.click();
			await expectProposalTabAndPane(page, proposal);
			await switchToMobileChatAndBack(page, proposal);
			await reloadAndOpenProposal(page, proposal, sessionId);
			await dismissProposal(page, proposal, sessionId);
		});
	}

	test("Staff proposal accept creates a staff agent from a normal session", async ({ page }) => {
		await deleteStaffByName(STAFF_ACCEPT_NAME);
		try {
			const proposal = CASES.find((c) => c.type === "staff")!;
			await openApp(page);
			await createSessionViaUI(page);
			await expectNormalChatSession(page);

			await sendMessage(page, proposal.trigger);
			const openButton = await expectProposalToolCard(page, proposal);
			await waitForProposalSlot(page, "staff");
			await openButton.click();
			await expectProposalTabAndPane(page, proposal);

			const panel = proposalPane(page, proposal);
			const worktreeToggle = panel.locator('[data-testid="staff-proposal-worktree-checkbox"]');
			await expect(worktreeToggle).toBeChecked({ timeout: 5_000 });
			await worktreeToggle.uncheck();
			await expect(panel.locator('[data-testid="staff-proposal-worktree-mode"]')).toContainText("project directory", { timeout: 5_000 });
			const createButton = panel.getByRole("button", { name: /Create Staff/ }).first();
			await expect(createButton).toBeEnabled({ timeout: 5_000 });
			await createButton.click();

			await expect
				.poll(async () => (await staffByName(STAFF_ACCEPT_NAME)).length, { timeout: 20_000 })
				.toBeGreaterThan(0);
		} finally {
			await deleteStaffByName(STAFF_ACCEPT_NAME);
		}
	});
});
