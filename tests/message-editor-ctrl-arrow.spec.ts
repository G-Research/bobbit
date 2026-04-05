/**
 * Tests that Ctrl+Arrow keys (session switching shortcuts) do NOT trigger
 * command history navigation in the MessageEditor.
 *
 * Bug: The shortcut system calls preventDefault but not stopPropagation,
 * so the MessageEditor's keydown handler also fires. Without modifier
 * key filtering, Ctrl+ArrowUp activates history mode — populating the
 * textarea with old messages on every session switch.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/message-editor-ctrl-arrow.html").replace(/\\/g, "/")}`;

test.describe("Ctrl+Arrow does not trigger history", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
		await page.evaluate(() => {
			(window as any).setHistory(["old command 1", "old command 2", "old command 3"]);
		});
	});

	test("Ctrl+ArrowUp does not enter history mode", async ({ page }) => {
		await page.click("#textarea");
		// Simulate Ctrl+ArrowUp (session switch shortcut)
		await page.keyboard.press("Control+ArrowUp");

		const state = await page.evaluate(() => (window as any).getState());
		expect(state.value).toBe("");
		expect(state.historyIndex).toBe(-1);
	});

	test("Ctrl+ArrowDown does not cycle history", async ({ page }) => {
		await page.click("#textarea");
		// First enter history mode with plain ArrowUp
		await page.keyboard.press("ArrowUp");
		const afterUp = await page.evaluate(() => (window as any).getState());
		expect(afterUp.historyIndex).not.toBe(-1);
		expect(afterUp.value).toBe("old command 3");

		// Now Ctrl+ArrowDown should NOT cycle history
		await page.keyboard.press("Control+ArrowDown");
		const afterCtrlDown = await page.evaluate(() => (window as any).getState());
		// History index should be unchanged — Ctrl+Down was ignored
		expect(afterCtrlDown.historyIndex).toBe(afterUp.historyIndex);
		expect(afterCtrlDown.value).toBe("old command 3");
	});

	test("Meta+ArrowUp does not enter history mode", async ({ page }) => {
		await page.click("#textarea");
		await page.keyboard.press("Meta+ArrowUp");

		const state = await page.evaluate(() => (window as any).getState());
		expect(state.value).toBe("");
		expect(state.historyIndex).toBe(-1);
	});

	test("Alt+ArrowUp does not enter history mode", async ({ page }) => {
		await page.click("#textarea");
		await page.keyboard.press("Alt+ArrowUp");

		const state = await page.evaluate(() => (window as any).getState());
		expect(state.value).toBe("");
		expect(state.historyIndex).toBe(-1);
	});

	test("plain ArrowUp still works for history", async ({ page }) => {
		await page.click("#textarea");
		await page.keyboard.press("ArrowUp");

		const state = await page.evaluate(() => (window as any).getState());
		expect(state.value).toBe("old command 3");
		expect(state.historyIndex).toBe(2);
	});

	test("rapid Ctrl+Arrow switching never triggers history", async ({ page }) => {
		await page.click("#textarea");
		// Simulate rapid session switching (10 times)
		for (let i = 0; i < 10; i++) {
			await page.keyboard.press("Control+ArrowUp");
			await page.keyboard.press("Control+ArrowDown");
		}

		const state = await page.evaluate(() => (window as any).getState());
		expect(state.value).toBe("");
		expect(state.historyIndex).toBe(-1);
	});
});
