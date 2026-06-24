/**
 * Goal proposal Roles tab wiring (browser E2E).
 *
 * Covers the + New Goal / goal-preview path: roles must load, per-goal role
 * customization must open an editable role editor, and created goals must
 * persist inlineRoles snapshots.
 */
import { test, expect } from "../gateway-harness.js";
import type { Page } from "@playwright/test";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const ROLES_TAB = "[data-testid='goal-proposal-tab-roles']";
const ROLES_PANEL = "[data-testid='goal-proposal-panel-roles']";
const ROLE_CUSTOMIZE = "[data-testid='goal-proposal-role-customize']";
const ROLE_RESET = "[data-testid='goal-proposal-role-reset']";

async function sendChatMessage(page: Page, text: string) {
	const textarea = page.locator("message-editor textarea").first();
	await expect(textarea).toBeVisible({ timeout: 10_000 });
	await textarea.fill(text);
	await textarea.press("Enter");
}

async function waitForGoalTitle(page: Page, title: string) {
	await page.waitForFunction(
		(expected) => (window as any).bobbitState?.activeProposals?.goal?.fields?.title === expected,
		title,
		{ timeout: 20_000 },
	);
	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 20_000 });
	await expect(titleInput).toHaveValue(title, { timeout: 20_000 });
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
	await sendChatMessage(page, "Please create a GOAL_PROPOSAL for testing");
	await waitForGoalTitle(page, "E2E Test Goal");
}

async function clickCreate(page: Page): Promise<string> {
	const createPromise = page.waitForResponse(
		(resp) => resp.url().includes("/api/goals") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 20_000 },
	);
	await page.locator("button").filter({ hasText: "Create Goal" }).first().click();
	const resp = await createPromise;
	const goal = await resp.json();
	expect(goal?.id, "create response must include goal id").toBeTruthy();
	return goal.id as string;
}

async function findGoalById(goalId: string): Promise<any | undefined> {
	const resp = await apiFetch("/api/goals");
	const data = await resp.json();
	const goals = data.goals || data;
	return (goals as any[]).find((g) => g.id === goalId);
}

async function deleteGoal(goalId: string) {
	await apiFetch(`/api/goals/${goalId}?cascade=true`, { method: "DELETE" }).catch(() => {});
}

test.describe("Goal proposal — Roles tab wiring", () => {
	test("+ New Goal role customization persists inlineRoles", async ({ page }) => {
		await openNewGoalAssistantProposal(page);

		await page.locator(ROLES_TAB).click();
		await expect(page.locator(ROLES_PANEL)).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(ROLE_CUSTOMIZE)).toBeVisible({ timeout: 15_000 });

		const roleEditor = page.locator(`${ROLES_PANEL} [data-testid='role-editor']`).first();
		await expect(roleEditor).toBeVisible({ timeout: 15_000 });
		const roleName = await roleEditor.getAttribute("data-role-name");
		expect(roleName, "roles tab must select a concrete role").toBeTruthy();

		await page.locator(ROLE_CUSTOMIZE).click();
		await expect(page.locator(ROLE_RESET)).toBeVisible({ timeout: 10_000 });
		const labelInput = roleEditor.locator("input").first();
		await expect(labelInput).toBeEnabled({ timeout: 10_000 });
		await labelInput.fill("Inline Role Label");
		await expect(labelInput).toHaveValue("Inline Role Label");

		const goalId = await clickCreate(page);
		const created = await findGoalById(goalId);
		expect(created).toBeTruthy();
		try {
			expect(created.inlineRoles?.[roleName!]?.label).toBe("Inline Role Label");
		} finally {
			await deleteGoal(goalId);
		}
	});

	test("Roles Customize works in a second proposal after roles are cached", async ({ page }) => {
		await openNewGoalAssistantProposal(page);

		await page.locator(ROLES_TAB).click();
		await expect(page.locator(ROLES_PANEL)).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(`${ROLES_PANEL} [data-testid='role-editor']`).first()).toBeVisible({ timeout: 15_000 });

		await sendChatMessage(page, "Please create GOAL_PROPOSAL_REV2 now");
		await waitForGoalTitle(page, "Revised Goal Title");

		await page.locator(ROLES_TAB).click();
		await expect(page.locator(ROLE_CUSTOMIZE)).toBeVisible({ timeout: 10_000 });
		await page.locator(ROLE_CUSTOMIZE).click();
		await expect(
			page.locator(ROLE_RESET),
			"Customize must not be an enabled no-op when the roles list came from cache",
		).toBeVisible({ timeout: 10_000 });
		await expect(page.locator(`${ROLES_PANEL} [data-testid='role-editor']`).first()).toBeVisible({ timeout: 10_000 });
	});
});
