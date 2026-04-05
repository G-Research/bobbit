/**
 * Tests for MessageEditor arrow key behavior with visual row detection.
 * Uses a narrow (100px) textarea to force line wrapping for stories 16-20.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/message-editor-arrows.html").replace(/\\/g, "/")}`;

// Generate a long string that will visually wrap in 100px textarea
const LONG_TEXT = "abcdefghij".repeat(20); // 200 chars, wraps multiple rows in 100px

test.describe("Arrow keys with visual row detection", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
		await page.evaluate(() => {
			(window as any).setHistory(["history-entry-1", "history-entry-2"]);
		});
	});

	test("story 16: wrapped text, cursor mid-text — ArrowUp does NOT trigger history", async ({ page }) => {
		const textarea = page.locator("#textarea");
		// Set a long text that wraps visually (no newlines) and position cursor mid-text
		await page.evaluate((text) => {
			const ta = document.getElementById("textarea") as HTMLTextAreaElement;
			ta.value = text;
			const midPos = Math.floor(text.length / 2);
			ta.setSelectionRange(midPos, midPos);
		}, LONG_TEXT);

		// Verify cursor is NOT on visual top row
		const isTop = await page.evaluate(() => (window as any).checkCursorOnVisualTopRow());
		expect(isTop).toBe(false);

		// Press ArrowUp — should NOT trigger history (value stays same)
		await textarea.press("ArrowUp");
		const val = await textarea.inputValue();
		expect(val).toBe(LONG_TEXT); // unchanged — history did not activate
	});

	test("story 17: wrapped text, cursor at position 0 — ArrowUp triggers history", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await page.evaluate((text) => {
			const ta = document.getElementById("textarea") as HTMLTextAreaElement;
			ta.value = text;
			ta.setSelectionRange(0, 0);
		}, LONG_TEXT);

		const isTop = await page.evaluate(() => (window as any).checkCursorOnVisualTopRow());
		expect(isTop).toBe(true);

		await textarea.press("ArrowUp");
		const val = await textarea.inputValue();
		expect(val).toBe("history-entry-2"); // newest history entry
	});

	test("story 18: multi-line text, cursor on line 2 — ArrowUp does NOT trigger history", async ({ page }) => {
		const textarea = page.locator("#textarea");
		const multiLine = "line1\nline2\nline3";
		await page.evaluate((text) => {
			const ta = document.getElementById("textarea") as HTMLTextAreaElement;
			ta.value = text;
			ta.setSelectionRange(8, 8); // mid "line2"
		}, multiLine);

		const isTop = await page.evaluate(() => (window as any).checkCursorOnVisualTopRow());
		expect(isTop).toBe(false);

		await textarea.press("ArrowUp");
		const val = await textarea.inputValue();
		expect(val).toBe(multiLine); // unchanged — history not triggered
	});

	test("story 19: multi-line text, cursor at position 0 — ArrowUp triggers history, ArrowDown restores", async ({ page }) => {
		const textarea = page.locator("#textarea");
		const multiLine = "line1\nline2";
		await page.evaluate((text) => {
			const ta = document.getElementById("textarea") as HTMLTextAreaElement;
			ta.value = text;
			ta.setSelectionRange(0, 0);
			ta.focus();
		}, multiLine);

		// ArrowUp should trigger history
		await textarea.press("ArrowUp");
		expect(await textarea.inputValue()).toBe("history-entry-2");

		// ArrowDown past newest should restore original multiline draft
		await textarea.press("ArrowDown");
		expect(await textarea.inputValue()).toBe(multiLine);

		const state = await page.evaluate(() => (window as any).getHistoryState());
		expect(state.historyIndex).toBe(-1);
	});

	test("story 20: ArrowDown only activates history when already in history mode", async ({ page }) => {
		const textarea = page.locator("#textarea");
		const multiLine = "line1\nline2";
		await page.evaluate((text) => {
			const ta = document.getElementById("textarea") as HTMLTextAreaElement;
			ta.value = text;
			// Position cursor on line1 (not in history mode)
			ta.setSelectionRange(2, 2); // middle of "line1"
			ta.focus();
		}, multiLine);

		// ArrowDown should just move cursor within text, NOT trigger history
		await textarea.press("ArrowDown");
		// Value unchanged (no history replacement)
		expect(await textarea.inputValue()).toBe(multiLine);
		const state1 = await page.evaluate(() => (window as any).getHistoryState());
		expect(state1.historyIndex).toBe(-1); // not in history mode

		// Now enter history mode via ArrowUp from top
		await page.evaluate(() => {
			const ta = document.getElementById("textarea") as HTMLTextAreaElement;
			ta.setSelectionRange(0, 0);
		});
		await textarea.press("ArrowUp");
		expect(await textarea.inputValue()).toBe("history-entry-2");

		const state2 = await page.evaluate(() => (window as any).getHistoryState());
		expect(state2.historyIndex).not.toBe(-1); // in history mode

		// Now ArrowDown should cycle history
		await textarea.press("ArrowDown");
		expect(await textarea.inputValue()).toBe(multiLine); // restored draft
	});
});
