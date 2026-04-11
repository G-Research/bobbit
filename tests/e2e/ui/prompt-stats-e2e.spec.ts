/**
 * Browser E2E tests for prompt stats interactions (PI-15, PI-17, PI-18, PI-23).
 *
 * Tests model name display, context usage bar, cost display, and the
 * combined stats bar after real agent interaction via the gateway harness.
 */
import { test, expect } from "../gateway-harness.js";
import { waitForHealth, waitForSessionStatus, createSession } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Prompt stats E2E", () => {
	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("PI-15: model name displayed in stats bar after session load", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		// Send a message so the agent responds and get_state is called (returns model info)
		await sendMessage(page, "Hello stats test");
		await waitForAgentResponse(page);

		// The stats bar below the editor should show the model name.
		// The mock agent reports model id "mock-model" via get_state.
		// The model button contains a Sparkles SVG icon + model text.
		const statsBar = page.locator(".text-xs.text-muted-foreground.flex.justify-between");
		await expect(statsBar).toBeVisible({ timeout: 10_000 });

		// Look for the model name in the stats bar area
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("mock-model");
		}).toPass({ timeout: 10_000 });
	});

	test("PI-17: context usage bar shows percentage after message exchange", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Context bar test");
		await waitForAgentResponse(page);

		// The context bar has a title attribute with "Context:" and token counts.
		// The mock agent sends usage data (175 tokens / 128000 context window).
		// Wait for context span to appear with a title containing "Context:"
		// Use toPass for resilience under load — the context bar updates after
		// the assistant message is processed and usage data propagated.
		await expect(async () => {
			const contextSpan = page.locator("span[title*='Context:']");
			await expect(contextSpan).toBeVisible();
			const title = await contextSpan.getAttribute("title");
			expect(title).toMatch(/Context:.*tokens/);
			const text = await contextSpan.textContent();
			expect(text).toMatch(/\d+%/);
		}).toPass({ timeout: 15_000 });
	});

	test("PI-18: cost display appears after message exchange", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Cost display test");
		await waitForAgentResponse(page);

		// The cost is displayed as a dollar amount in the stats bar.
		// The mock agent sends usage with cost.total = 0.00075.
		// The server tracks this via cost_update and the UI displays it.
		// Wait for a cost element containing "$" to appear.
		await expect(async () => {
			const statsBar = page.locator(".text-xs.text-muted-foreground.flex.justify-between");
			const text = await statsBar.textContent();
			expect(text).toContain("$");
		}).toPass({ timeout: 10_000 });
	});

	test("PI-23: all stats visible together after interaction", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Full stats test");
		await waitForAgentResponse(page);

		const statsBar = page.locator(".text-xs.text-muted-foreground.flex.justify-between");
		await expect(statsBar).toBeVisible({ timeout: 10_000 });

		// Verify all three stats components are present simultaneously:
		// 1. Model name
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("mock-model");
		}).toPass({ timeout: 10_000 });

		// 2. Context bar (span with title containing "Context:")
		const contextSpan = page.locator("span[title*='Context:']");
		await expect(contextSpan).toBeVisible({ timeout: 5_000 });

		// 3. Cost display (text containing "$")
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("$");
		}).toPass({ timeout: 5_000 });
	});

	test("PI-17: context popover shows details on click", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Popover test");
		await waitForAgentResponse(page);

		// Wait for context bar to appear
		const contextSpan = page.locator("span[title*='Context:']");
		await expect(contextSpan).toBeVisible({ timeout: 10_000 });

		// Click the context bar to open the popover
		await contextSpan.click();

		// The popover should show detailed context info including model name,
		// context window size, token counts, and session stats.
		const popover = page.locator(".context-popover");
		await expect(popover).toBeVisible({ timeout: 5_000 });

		// Verify popover contains model info and usage details
		const popoverText = await popover.textContent();
		expect(popoverText).toContain("mock-model");
		expect(popoverText).toContain("Context Usage");
		expect(popoverText).toContain("Messages");
		expect(popoverText).toContain("Turns");
	});

	test("PI-18: cost popover shows session cost on click", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Cost popover test");
		await waitForAgentResponse(page);

		// Wait for cost text to appear
		const statsBar = page.locator(".text-xs.text-muted-foreground.flex.justify-between");
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("$");
		}).toPass({ timeout: 10_000 });

		// Find and click the cost text (span containing "$")
		// The cost text is a clickable span inside the stats bar
		const costSpan = statsBar.locator("span.cursor-pointer").filter({ hasText: "$" }).first();
		await costSpan.click();

		// The cost-popover renders a "Cost Breakdown" heading when open.
		// Wait for that text to appear (the component renders `nothing` when closed).
		await expect(page.getByText("Cost Breakdown")).toBeVisible({ timeout: 5_000 });
	});

	test("PI-15: model name persists across page reload", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Hello");
		await waitForAgentResponse(page);

		// Verify model name appears
		const statsBar = page.locator(".text-xs.text-muted-foreground.flex.justify-between");
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("mock-model");
		}).toPass({ timeout: 10_000 });

		// Reload page
		await page.reload();

		// Wait for app to load again
		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		// The session should auto-load (last active session) — wait for textarea
		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		// Verify model name still shown after reload
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("mock-model");
		}).toPass({ timeout: 15_000 });
	});

	test("PI-15: model name button is clickable", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Model button test");
		await waitForAgentResponse(page);

		// Find the model button in the stats bar (button containing "mock-model")
		const modelButton = page.locator("button").filter({ hasText: "mock-model" }).first();
		await expect(modelButton).toBeVisible({ timeout: 10_000 });

		// Click it — should open the ModelSelector dialog
		await modelButton.click();

		// The ModelSelector dialog should appear (it's a dialog/modal element)
		// Look for a dialog or overlay that appeared
		const dialog = page.locator("dialog, [role='dialog'], .fixed.inset-0");
		await expect(dialog.first()).toBeVisible({ timeout: 5_000 });
	});
});
