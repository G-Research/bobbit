/**
 * Browser E2E tests for prompt stats interactions (PI-15, PI-17, PI-18, PI-23).
 *
 * Tests model name display, context usage bar, cost display, and the
 * combined stats bar after real agent interaction via the gateway harness.
 *
 * Optimized: basic stat visibility tests are combined into a single test
 * (one session setup instead of four). Interactive tests (popovers, reload,
 * button click) remain separate but run in parallel.
 */
import { test, expect } from "../gateway-harness.js";
import { waitForHealth } from "../e2e-setup.js";
import { openApp, createSessionViaUI, sendMessage, waitForAgentResponse } from "./ui-helpers.js";

test.describe("Prompt stats E2E", () => {
	test.describe.configure({ mode: "parallel" });

	test.beforeAll(async () => {
		await waitForHealth();
	});

	test("PI-15/17/18/23: model name, context bar, and cost all visible after interaction @smoke", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Full stats test");
		await waitForAgentResponse(page);

		const statsBar = page.locator(".text-xs.text-muted-foreground.flex.justify-between");
		await expect(statsBar).toBeVisible({ timeout: 10_000 });

		// PI-15: Model name displayed
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("mock-model");
		}).toPass({ timeout: 10_000 });

		// PI-17: Context usage bar shows percentage
		await expect(async () => {
			const contextSpan = page.locator("span[title*='Context:']");
			await expect(contextSpan).toBeVisible();
			const title = await contextSpan.getAttribute("title");
			expect(title).toMatch(/Context:.*tokens/);
			const text = await contextSpan.textContent();
			expect(text).toMatch(/\d+%/);
		}).toPass({ timeout: 15_000 });

		// PI-18: Cost display appears
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("$");
		}).toPass({ timeout: 10_000 });
	});

	test("PI-17: context popover shows details on click", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);

		await sendMessage(page, "Popover test");
		await waitForAgentResponse(page);

		const contextSpan = page.locator("span[title*='Context:']");
		await expect(contextSpan).toBeVisible({ timeout: 10_000 });

		await contextSpan.click();

		const popover = page.locator(".context-popover");
		await expect(popover).toBeVisible({ timeout: 5_000 });

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

		const statsBar = page.locator(".text-xs.text-muted-foreground.flex.justify-between");
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("$");
		}).toPass({ timeout: 10_000 });

		const costSpan = statsBar.locator("span.cursor-pointer").filter({ hasText: "$" }).first();
		await costSpan.click();

		await expect(page.getByText("Cost Breakdown")).toBeVisible({ timeout: 5_000 });
	});

	test("PI-15: model name persists across page reload", async ({ page }) => {
		await openApp(page);
		await createSessionViaUI(page);
		await sendMessage(page, "Hello");
		await waitForAgentResponse(page);

		const statsBar = page.locator(".text-xs.text-muted-foreground.flex.justify-between");
		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("mock-model");
		}).toPass({ timeout: 10_000 });

		await page.reload();

		await expect(
			page.locator("button").filter({ hasText: "Settings" }).first(),
		).toBeVisible({ timeout: 20_000 });

		await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

		await expect(async () => {
			const text = await statsBar.textContent();
			expect(text).toContain("mock-model");
		}).toPass({ timeout: 15_000 });
	});


});
