/**
 * Browser E2E for descriptive-API-error forwarding (POST /api/goals path).
 *
 * Asserts that when the gateway returns a 400 with a structured
 * `{ error, stack }` body, the connection-error modal renders:
 *   - the server's `error` string (NOT a fallback "Failed to create goal: 400")
 *   - a collapsible "Show stack trace" disclosure populated from `data.stack`.
 *
 * The test stubs the network response with Playwright's `page.route()` so it
 * runs end-to-end through the real client wrappers in `src/app/api.ts` and
 * the dialog stack in `src/app/dialogs.ts`. Goal creation is driven via the
 * goal-assistant flow (mirroring `tests/e2e/ui/goal-creation.spec.ts`) so a
 * real "Create Goal" click triggers `createGoal()` in production code.
 */
import { test, expect } from "../gateway-harness.js";
import { openApp, sendMessage } from "./ui-helpers.js";

const FAKE_STACK =
	"Error: Missing title\n" +
	"    at goalManager.create (server.ts:3137:9)\n" +
	"    at handleApiRoute (server.ts:42:5)";

test.describe("descriptive API error modal", () => {
	test("createGoal 400 shows server error + stack disclosure", async ({ page }) => {
		// Cold-start budget for goal-assistant + mock-agent + UI navigation.
		// Same rationale as openGoalAssistantProposal in goal-creation.spec.ts.
		test.setTimeout(120_000);

		// Intercept POST /api/goals only — leave session/agent endpoints
		// untouched so the goal-assistant flow can still spawn its session
		// and emit a GOAL_PROPOSAL.
		await page.route("**/api/goals", async (route) => {
			const req = route.request();
			if (req.method() !== "POST") return route.continue();
			await route.fulfill({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({
					error: "Missing title",
					stack: FAKE_STACK,
				}),
			});
		});

		await openApp(page);

		// Drive the goal-assistant flow (same path as goal-creation.spec.ts).
		const newGoalBtn = page.locator("button[title='New goal (Alt+G)']").first();
		await expect(newGoalBtn).toBeVisible({ timeout: 15_000 });
		await expect(newGoalBtn).toBeEnabled({ timeout: 15_000 });

		const sessionCreated = page.waitForResponse(
			(resp) =>
				resp.url().includes("/api/sessions") &&
				resp.request().method() === "POST" &&
				resp.ok(),
			{ timeout: 60_000 },
		);
		await newGoalBtn.click();
		await sessionCreated;
		await page.waitForURL(/#\/session\//, { timeout: 15_000 });

		const textarea = page.locator("textarea").first();
		await expect(textarea).toBeVisible({ timeout: 15_000 });
		await sendMessage(page, "Please create a GOAL_PROPOSAL for testing");

		const titleInput = page.locator("input[placeholder='Goal title']").first();
		await expect(titleInput).toBeVisible({ timeout: 15_000 });
		await expect(titleInput).toHaveValue("E2E Test Goal", { timeout: 20_000 });

		const createGoalBtn = page
			.locator("button")
			.filter({ hasText: "Create Goal" })
			.first();
		await expect(createGoalBtn).toBeVisible({ timeout: 5_000 });
		await createGoalBtn.click();

		// Modal assertions — the route stub triggers the 400 path inside
		// createGoal(), which routes through showConnectionError().
		const message = page
			.locator('[data-testid="error-details-message"]')
			.first();
		await expect(message).toHaveText("Missing title", { timeout: 15_000 });

		const stackBlock = page
			.locator('[data-testid="error-details-stack"]')
			.first();
		await expect(stackBlock).toBeVisible({ timeout: 5_000 });

		// Click the disclosure summary to reveal the <pre>.
		await stackBlock.locator("summary").click();
		const isOpen = await stackBlock.evaluate(
			(el) => (el as HTMLDetailsElement).open,
		);
		expect(isOpen).toBe(true);

		const pre = stackBlock.locator("pre");
		await expect(pre).toContainText("Error: Missing title");
		await expect(pre).toContainText("goalManager.create (server.ts:3137:9)");
		await expect(pre).toContainText("handleApiRoute (server.ts:42:5)");

		// The fallback string MUST NOT appear anywhere on the page.
		const pageText = await page.locator("body").innerText();
		expect(pageText).not.toContain("Failed to create goal: 400");
	});
});
