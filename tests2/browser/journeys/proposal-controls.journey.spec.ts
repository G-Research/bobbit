/**
 * Journey: Proposal controls: API errors and goal-role customization.
 */
import { test, expect, openApp } from "../_helpers/journey-fixture.js";
import { sendMessage, defaultProjectId } from "../_helpers/journey-fixture.js";
import { createGoalAssistantViaUI } from "../fixtures/ui-helpers.js";

// Ported from api-error-modal.spec.ts (audit: misc GAP): a createGoal 400 must
// surface the server error text + stack disclosure in the error modal.
test.describe("Journey: API Error Modal", () => {
	test("createGoal 400 surfaces server error message + stack in the modal", async ({ page }) => {
		test.setTimeout(120_000);
		const FAKE_STACK = "Error: Missing title\n    at goalManager.create (server.ts:3137:9)\n    at handleApiRoute (server.ts:42:5)";
		await page.route("**/api/goals", async (route) => {
			const req = route.request();
			if (req.method() !== "POST") return route.continue();
			await route.fulfill({
				status: 400, contentType: "application/json",
				body: JSON.stringify({ error: "Missing title", stack: FAKE_STACK }),
			});
		});
		const targetProjectId = await defaultProjectId();
		try {
			await openApp(page);
			await createGoalAssistantViaUI(page, { timeout: 60_000 });
			const textarea = page.locator("textarea").first();
			await expect(textarea).toBeVisible({ timeout: 30_000 });
			await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

			const titleInput = page.locator("input[placeholder='Goal title']").first();
			await expect(titleInput).toBeVisible({ timeout: 20_000 });
			await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 20_000 });

			const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
			await expect(createGoalBtn).toBeVisible({ timeout: 5_000 });
			await createGoalBtn.click();

			// The 400 routes through the error modal (ErrorDetails).
			const message = page.locator('[data-testid="error-details-message"]').first();
			await expect(message).toHaveText("Missing title", { timeout: 15_000 });
			await expect(page.locator('[data-testid="error-details-stack"]').first()).toBeVisible({ timeout: 5_000 });
			// The generic fallback must NOT be shown when a server message exists.
			expect(await page.locator("body").innerText()).not.toContain("Failed to create goal: 400");
		} finally {
			// Best-effort: no goal is created (POST is stubbed 400).
			void targetProjectId;
		}
	});
});
// Ported from goal-role-tabs-wiring.spec.ts (audit: misc GAP / BR48): the
// goal-proposal Roles tab must load a role editor, and clicking Customize must
// reveal the reset-to-default control (proving per-goal role customization is
// wired, not an enabled no-op).
test.describe("Journey: Goal Proposal Roles Tab", () => {
	test("Roles tab Customize reveals the reset-to-default control", async ({ page }) => {
		test.setTimeout(90_000);
		await openApp(page);
		await createGoalAssistantViaUI(page, { timeout: 60_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 20_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 20_000 });
		await page.locator("[data-testid='goal-proposal-tab-roles']").click();
		await expect(page.locator("[data-testid='goal-proposal-panel-roles']")).toBeVisible({ timeout: 10_000 });
		const customize = page.locator("[data-testid='goal-proposal-role-customize']");
		await expect(customize).toBeVisible({ timeout: 15_000 });
		await customize.click();
		await expect(page.locator("[data-testid='goal-proposal-role-reset']")).toBeVisible({ timeout: 10_000 });
	});
});
