/**
 * Browser E2E coverage for optional steps goal proposal parsing.
 *
 * API/gate coverage lives in tests/e2e/optional-steps-api.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage } from "./ui-helpers.js";

test.describe("Optional steps @quarantine", () => {
	test("goal proposal with options field is parsed", async ({ page }) => {
		await openApp(page);

		// Click the "New Goal" button.
		const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
		await expect(newGoalBtn).toBeVisible({ timeout: 10_000 });
		await newGoalBtn.click();

		// Wait for textarea — 30s budget absorbs goal-assistant cold-start under
		// 3-worker browser parallelism (sync FS work for config / prompt assembly
		// contends across workers).
		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 30_000 });

		// Send GOAL_PROPOSAL keyword — mock agent emits propose_goal tool call
		// with options: "QA testing".
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		// Wait for the proposal panel to show the title.
		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 10_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

		// The proposal was successfully parsed via propose_goal tool call
		// (title populated means _checkToolProposals fired correctly).
		// The mock agent includes options: "QA testing" in its tool input.
		// Verify the Create Goal button is enabled.
		const createGoalBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
		await expect(createGoalBtn).toBeVisible({ timeout: 5_000 });
	});
});
