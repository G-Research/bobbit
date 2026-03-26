import { test, expect } from "@playwright/test";
import path from "node:path";

const fixture = `file://${path.resolve("tests/fixtures/slash-skills-test.html").replace(/\\/g, "/")}`;

test.describe("slash-skills argument substitution", () => {
	test("replaces $ARGUMENTS with full argument string", async ({ page }) => {
		await page.goto(fixture);
		const result = await page.evaluate(() => (window as any).testResults.fullArgs);
		expect(result).toBe("Fix issue 123");
	});

	test("replaces $ARGUMENTS[N] with indexed arguments", async ({ page }) => {
		await page.goto(fixture);
		const result = await page.evaluate(() => (window as any).testResults.indexedArgs);
		expect(result).toBe("Migrate SearchBar from React to Vue");
	});

	test("replaces $N shorthand with indexed arguments", async ({ page }) => {
		await page.goto(fixture);
		const result = await page.evaluate(() => (window as any).testResults.shorthand);
		expect(result).toBe("Migrate SearchBar from React to Vue");
	});

	test("leaves content unchanged with empty args", async ({ page }) => {
		await page.goto(fixture);
		const result = await page.evaluate(() => (window as any).testResults.noArgs);
		expect(result).toBe("Do something");
	});

	test("handles mixed $ARGUMENTS and $N", async ({ page }) => {
		await page.goto(fixture);
		const result = await page.evaluate(() => (window as any).testResults.mixedArgs);
		expect(result).toBe("hello world and also hello");
	});
});
