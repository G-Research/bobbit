/**
 * Unit fixture tests for model selector button (PI-15) and thinking level selector (PI-16).
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/model-thinking-selectors.html").replace(/\\/g, "/")}`;

test.describe("PI-15: Model selector button", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("displays current model ID text", async ({ page }) => {
		const label = await page.textContent("#model-label");
		expect(label).toBe("claude-sonnet-4-20250514");
	});

	test("click fires onModelSelect callback", async ({ page }) => {
		await page.click("#model-btn");
		const count = await page.evaluate(() => (window as any).getModelClickCount());
		expect(count).toBe(1);
	});

	test("multiple clicks increment callback count", async ({ page }) => {
		await page.click("#model-btn");
		await page.click("#model-btn");
		await page.click("#model-btn");
		const count = await page.evaluate(() => (window as any).getModelClickCount());
		expect(count).toBe(3);
	});

	test("button has Sparkles icon SVG", async ({ page }) => {
		const svg = await page.locator("#model-btn svg.sparkles");
		await expect(svg).toBeVisible();
	});

	test("button hidden when showModelSelector=false", async ({ page }) => {
		await page.evaluate(() => (window as any).setShowModelSelector(false));
		await expect(page.locator("#model-btn")).toBeHidden();
	});

	test("button reappears when showModelSelector toggled back to true", async ({ page }) => {
		await page.evaluate(() => (window as any).setShowModelSelector(false));
		await expect(page.locator("#model-btn")).toBeHidden();
		await page.evaluate(() => (window as any).setShowModelSelector(true));
		await expect(page.locator("#model-btn")).toBeVisible();
	});

	test("button hidden when model is null", async ({ page }) => {
		await page.evaluate(() => (window as any).setModel(null));
		await expect(page.locator("#model-btn")).toBeHidden();
	});

	test("updates label when model changes", async ({ page }) => {
		await page.evaluate(() => (window as any).setModel({ id: "claude-opus-5", reasoning: true, contextWindow: 200000 }));
		const label = await page.textContent("#model-label");
		expect(label).toBe("claude-opus-5");
	});
});

test.describe("PI-16: Thinking level selector", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("shows current thinking level (default off)", async ({ page }) => {
		const value = await page.inputValue("#thinking-select");
		expect(value).toBe("off");
	});

	test("has all five options: off, minimal, low, medium, high", async ({ page }) => {
		const options = await page.$$eval("#thinking-select option", (opts: HTMLOptionElement[]) =>
			opts.map((o) => ({ value: o.value, label: o.textContent!.trim() })),
		);
		expect(options).toEqual([
			{ value: "off", label: "Off" },
			{ value: "minimal", label: "Minimal" },
			{ value: "low", label: "Low" },
			{ value: "medium", label: "Medium" },
			{ value: "high", label: "High" },
		]);
	});

	test("change fires onThinkingChange with new value", async ({ page }) => {
		await page.selectOption("#thinking-select", "medium");
		const changes = await page.evaluate(() => (window as any).getThinkingChanges());
		expect(changes).toEqual(["medium"]);
	});

	test("multiple changes tracked in order", async ({ page }) => {
		await page.selectOption("#thinking-select", "low");
		await page.selectOption("#thinking-select", "high");
		await page.selectOption("#thinking-select", "off");
		const changes = await page.evaluate(() => (window as any).getThinkingChanges());
		expect(changes).toEqual(["low", "high", "off"]);
	});

	test("hidden when showThinkingSelector=false", async ({ page }) => {
		await page.evaluate(() => (window as any).setShowThinkingSelector(false));
		await expect(page.locator("#thinking-select")).toBeHidden();
	});

	test("reappears when showThinkingSelector toggled back to true", async ({ page }) => {
		await page.evaluate(() => (window as any).setShowThinkingSelector(false));
		await expect(page.locator("#thinking-select")).toBeHidden();
		await page.evaluate(() => (window as any).setShowThinkingSelector(true));
		await expect(page.locator("#thinking-select")).toBeVisible();
	});

	test("hidden when model does not support thinking (reasoning=false)", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelReasoning(false));
		await expect(page.locator("#thinking-select")).toBeHidden();
	});

	test("reappears when model reasoning toggled back to true", async ({ page }) => {
		await page.evaluate(() => (window as any).setModelReasoning(false));
		await expect(page.locator("#thinking-select")).toBeHidden();
		await page.evaluate(() => (window as any).setModelReasoning(true));
		await expect(page.locator("#thinking-select")).toBeVisible();
	});

	test("hidden when model is null (no model loaded)", async ({ page }) => {
		await page.evaluate(() => (window as any).setModel(null));
		await expect(page.locator("#thinking-select")).toBeHidden();
	});

	test("respects pre-set thinking level", async ({ page }) => {
		await page.evaluate(() => (window as any).setThinkingLevel("high"));
		const value = await page.inputValue("#thinking-select");
		expect(value).toBe("high");
	});
});
