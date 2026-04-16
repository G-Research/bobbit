import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/fixtures/write-renderer-truncated.html").replace(/\\/g, "/")}`;

test.describe("WriteRenderer truncated content handling", () => {
	test("normal string content is not detected as truncated", async ({ page }) => {
		await page.goto(FIXTURE);
		await expect(page.locator('[data-testid="normal-truncated"]')).toHaveText("false");
		await expect(page.locator('[data-testid="normal-display"]')).toContainText("console.log");
	});

	test("truncated object is detected and preview is extracted", async ({ page }) => {
		await page.goto(FIXTURE);
		await expect(page.locator('[data-testid="stream-truncated"]')).toHaveText("true");
		await expect(page.locator('[data-testid="stream-display"]')).toContainText("First 512 characters");
	});

	test("truncated size is formatted correctly", async ({ page }) => {
		await page.goto(FIXTURE);
		await expect(page.locator('[data-testid="stream-size"]')).toHaveText("10.0 MB");
	});

	test("streaming badge shows truncation indicator", async ({ page }) => {
		await page.goto(FIXTURE);
		const badge = page.locator('[data-testid="stream-badge"]');
		await expect(badge).toBeVisible();
		await expect(badge).toContainText("Truncated");
		await expect(badge).toContainText("10.0 MB");
	});

	test("final render shows truncation badge with size info", async ({ page }) => {
		await page.goto(FIXTURE);
		const badge = page.locator('[data-testid="final-badge"]');
		await expect(badge).toBeVisible();
		await expect(badge).toContainText("Content truncated");
		await expect(badge).toContainText("10.0 MB");
		await expect(badge).toContainText("preview only");
	});

	test("Load full content button is present in final render", async ({ page }) => {
		await page.goto(FIXTURE);
		const btn = page.locator('[data-testid="load-full-btn"]');
		await expect(btn).toBeVisible();
		await expect(btn).toHaveText("Load full content");
	});

	test("clicking Load full content dispatches CustomEvent and shows loading state", async ({ page }) => {
		await page.goto(FIXTURE);
		const btn = page.locator('[data-testid="load-full-btn"]');
		await btn.click();

		// Button text changes to "Loading..."
		await expect(btn).toHaveText("Loading...");

		// CustomEvent was fired and caught at document level
		await expect(page.locator('[data-testid="event-fired"]')).toHaveText("true");
	});

	test("edge cases: isTruncated handles various inputs correctly", async ({ page }) => {
		await page.goto(FIXTURE);
		const cases = ["null", "undefined", "empty-string", "truncated-false", "truncated-empty", "truncated-small"];
		for (const c of cases) {
			await expect(page.locator(`[data-testid="edge-${c}"]`)).toHaveText("pass");
		}
	});

	test("formatSize produces human-readable sizes", async ({ page }) => {
		await page.goto(FIXTURE);
		const sizes = [500, 1024, 32768, 1048576, 10485760, 41943040];
		for (const s of sizes) {
			const el = page.locator(`[data-testid="size-${s}"]`);
			const text = await el.textContent();
			expect(text).toMatch(/^pass:/);
		}
	});
});
