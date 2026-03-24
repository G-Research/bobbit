import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/draft-persistence.html")}`;

test.describe("Draft persistence on send", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		// Clear any leftover localStorage state
		await page.evaluate(() => localStorage.clear());
	});

	test("bug: draft persists after send without clearDraft", async ({ page }) => {
		const editor = page.locator("#editor");
		await editor.fill("hello world");
		await editor.dispatchEvent("input");

		// Wait for debounced saveDraft to fire
		await page.waitForTimeout(150);

		// Send without clearing draft (the bug)
		await page.evaluate(() => (window as any).sendBuggy());

		// Draft is still in localStorage — this is the bug
		const draft = await page.evaluate(() =>
			(window as any).loadDraft((window as any).SESSION_ID)
		);
		expect(draft).toBe("hello world");
	});

	test("fix: draft cleared after send with clearDraft", async ({ page }) => {
		const editor = page.locator("#editor");
		await editor.fill("hello world");
		await editor.dispatchEvent("input");

		// Wait for debounced saveDraft to fire
		await page.waitForTimeout(150);

		// Send with the fix (calls clearDraft)
		await page.evaluate(() => (window as any).sendFixed());

		const draft = await page.evaluate(() =>
			(window as any).loadDraft((window as any).SESSION_ID)
		);
		expect(draft).toBe("");
	});

	test("fix: debounce race handled — clearDraft cancels pending timer", async ({ page }) => {
		const editor = page.locator("#editor");
		await editor.fill("race condition text");
		await editor.dispatchEvent("input");

		// Send immediately — within the 100ms debounce window
		await page.evaluate(() => (window as any).sendFixed());

		// Wait longer than the debounce period
		await page.waitForTimeout(150);

		// Draft must still be empty — clearDraft cancelled the pending timer
		const draft = await page.evaluate(() =>
			(window as any).loadDraft((window as any).SESSION_ID)
		);
		expect(draft).toBe("");
	});

	test("unsent draft preserved on navigate away", async ({ page }) => {
		const editor = page.locator("#editor");
		await editor.fill("unsent draft");
		await editor.dispatchEvent("input");

		// Wait for debounced saveDraft to fire
		await page.waitForTimeout(150);

		// Don't send — just check that draft is preserved
		const draft = await page.evaluate(() =>
			(window as any).loadDraft((window as any).SESSION_ID)
		);
		expect(draft).toBe("unsent draft");
	});
});
