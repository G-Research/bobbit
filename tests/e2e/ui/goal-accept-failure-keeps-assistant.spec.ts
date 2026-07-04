/**
 * E2E: when `POST /api/goals` rejects, the goal assistant session, draft,
 * `gateway.sessionId`, and form state must remain intact so the user can
 * edit and retry. Pin for the "Robust goal workflow UX" goal §1.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage, createGoalAssistantViaUI } from "./ui-helpers.js";

test.describe.configure({ timeout: 90_000 });

test("goal assistant is preserved when POST /api/goals returns 400", async ({ page }) => {
	// Intercept goal-create attempts and force a 400. Place the route
	// handler BEFORE opening the app so the early goal-list fetch doesn't
	// race with our 400 (we only fail POSTs).
	let postAttempts = 0;
	await page.route(/\/api\/goals(?:\?.*)?$/, async (route, req) => {
		if (req.method() === "POST") {
			postAttempts++;
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({ error: "Forced create-goal failure for testing" }),
			});
			return;
		}
		await route.continue();
	});

	await openApp(page);

	// Drive the goal-assistant flow far enough to render the proposal panel.
	await createGoalAssistantViaUI(page);

	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 15_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 15_000 });
	await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 15_000 });

	// Snapshot gateway.sessionId BEFORE clicking Accept so we can assert
	// it survives the failed create.
	const sessionIdBefore = await page.evaluate(() => localStorage.getItem("gateway.sessionId"));
	expect(sessionIdBefore).toBeTruthy();

	// Click Create Goal. The route handler returns 400.
	const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
	await expect(createBtn).toBeVisible({ timeout: 5_000 });
	await createBtn.click();

	// Error dialog must surface. (error-details-message is the data-testid
	// inside showConnectionError's dialog body.)
	const errorMsg = page.locator('[data-testid="error-details-message"]').first();
	await expect(errorMsg).toBeVisible({ timeout: 10_000 });
	await expect(errorMsg).toContainText("Forced create-goal failure for testing", { timeout: 5_000 });

	// Wait for the POST to have actually happened.
	await expect.poll(() => postAttempts, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

	// Assistant panel must still be mounted: title input still visible
	// with the same value, textarea still rendered, URL still on the
	// assistant session (no goal-dashboard navigation).
	await expect(titleInput).toBeVisible();
	await expect(titleInput).toHaveValue("E2E Test Goal");
	await expect(page).toHaveURL(/#\/session\//);
	await expect(page.locator("textarea").first()).toBeVisible();

	// gateway.sessionId must NOT have been cleared.
	const sessionIdAfter = await page.evaluate(() => localStorage.getItem("gateway.sessionId"));
	expect(sessionIdAfter).toBe(sessionIdBefore);

	// Dismiss the dialog and click Create Goal again — must issue a 2nd POST.
	await page.locator("button").filter({ hasText: "OK" }).first().click();
	await expect(errorMsg).not.toBeVisible({ timeout: 5_000 });

	await createBtn.click();
	await expect(errorMsg).toBeVisible({ timeout: 10_000 });
	await expect.poll(() => postAttempts, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
});
