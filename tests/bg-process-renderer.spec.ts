import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/bg-process-renderer.html")}`;

test.describe("BgProcessRenderer ANSI color support", () => {
	test("renders output via console-block element, not raw <pre>", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// The renderer output should contain <console-block> elements
		const consoleBlocks = await page.locator("#renderer-output console-block").count();
		expect(consoleBlocks).toBeGreaterThanOrEqual(1);

		// There should be no direct <pre> child of the bg-process-result container
		// (the <pre> should be inside <console-block>, not a sibling)
		const directPres = await page.locator("#renderer-output > .bg-process-result > pre").count();
		expect(directPres).toBe(0);
	});

	test("ANSI escape codes are converted to styled HTML spans", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// The first console-block has ANSI content — check it rendered colored spans
		const firstBlock = page.locator("#renderer-output console-block").first();
		await expect(firstBlock).toBeVisible();

		// Should contain a <span> with green color (ANSI code 32 = #0a0)
		const greenSpan = firstBlock.locator('span[style*="color:#0a0"]');
		await expect(greenSpan).toHaveCount(1);
		await expect(greenSpan).toHaveText("green text");

		// Should contain a <span> with red color (ANSI code 31 = #c00)
		const redSpan = firstBlock.locator('span[style*="color:#c00"]');
		await expect(redSpan).toHaveCount(1);
		await expect(redSpan).toHaveText("red text");

		// The raw ANSI escape sequence should NOT appear in the visible text
		const visibleText = await firstBlock.textContent();
		expect(visibleText).not.toContain("\x1b[");
		expect(visibleText).toContain("green text");
		expect(visibleText).toContain("red text");
		expect(visibleText).toContain("normal");
	});

	test("plain text output renders without ANSI processing", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const plainBlock = page.locator("#plain-output console-block");
		await expect(plainBlock).toBeVisible();

		// Should have a plain <pre> (no styled spans needed)
		const pre = plainBlock.locator("pre.console-plain");
		await expect(pre).toHaveCount(1);
		await expect(pre).toHaveText("just plain text");
	});

	test("empty output shows fallback text", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const emptyBlock = page.locator("#empty-output console-block");
		await expect(emptyBlock).toBeVisible();

		const text = await emptyBlock.textContent();
		expect(text).toContain("(no output)");
	});
});
