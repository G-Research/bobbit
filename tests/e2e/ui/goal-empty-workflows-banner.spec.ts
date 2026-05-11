/**
 * E2E: when the linked project has no workflows, the goal-assistant panel
 * shows the empty-workflows banner, the Accept button is disabled, and
 * clicking "Open Project Assistant" creates a project-assistant session.
 * Pin for the "Robust goal workflow UX" goal §3.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage } from "./ui-helpers.js";

test.describe.configure({ timeout: 90_000 });

test("empty-workflows banner gates goal creation and opens project assistant", async ({ page }) => {
	// Force every GET /api/workflows response to be an empty list so the
	// goal-form sees the linked project as having zero workflows. This is
	// route-level only — the underlying project still has the harness-seeded
	// workflows, so other API behaviour (POST /api/goals would still resolve
	// from the real store) is unaffected. We only care about the form UI.
	await page.route(/\/api\/workflows(?:\?.*)?$/, async (route, req) => {
		if (req.method() === "GET") {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify([]),
			});
			return;
		}
		await route.continue();
	});

	await openApp(page);

	// Start the goal assistant via the sidebar +New Goal button.
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

	// Drive a proposal so the goal preview form renders.
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 15_000 });
	await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

	const titleInput = page.locator("input[placeholder='Goal title']").first();
	await expect(titleInput).toBeVisible({ timeout: 15_000 });

	// Banner visible.
	const banner = page.locator('[data-testid="goal-form-no-workflows-banner"]').first();
	await expect(banner).toBeVisible({ timeout: 10_000 });
	await expect(banner).toContainText("no workflows yet");

	// Create Goal button must be disabled (it sits inside the
	// proposal-primary-submit wrapper).
	const createBtn = page.locator("button").filter({ hasText: "Create Goal" }).first();
	await expect(createBtn).toBeVisible({ timeout: 5_000 });
	await expect(createBtn).toBeDisabled();

	// Snapshot the current session id so we can confirm a NEW session
	// (the project assistant) is created.
	const sessionIdBefore = await page.evaluate(() => localStorage.getItem("gateway.sessionId"));
	expect(sessionIdBefore).toBeTruthy();

	// Click "Open Project Assistant" — must POST /api/sessions with
	// assistantType "project" or "project-scaffolding".
	const projectAssistantPost = page.waitForResponse(
		(resp) => resp.url().includes("/api/sessions") && resp.request().method() === "POST" && resp.ok(),
		{ timeout: 30_000 },
	);
	await page.locator('[data-testid="goal-form-open-project-assistant"]').first().click();
	const resp = await projectAssistantPost;
	const reqBody = resp.request().postDataJSON?.() ?? JSON.parse(resp.request().postData() || "{}");
	expect(["project", "project-scaffolding"]).toContain(reqBody.assistantType);

	// And the URL hash should swap to the new session.
	await expect.poll(
		async () => await page.evaluate(() => localStorage.getItem("gateway.sessionId")),
		{ timeout: 10_000 },
	).not.toBe(sessionIdBefore);
});
