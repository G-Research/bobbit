import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/command-history.html")}`;

async function getState(page: any) {
	return page.evaluate(() => (window as any).getState());
}

test.describe("Command history", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.evaluate(() =>
			(window as any).setHistory(["first", "second", "third"])
		);
	});

	test("up arrow cycles through history newest-first", async ({ page }) => {
		await page.click("#editor");

		await page.keyboard.press("ArrowUp");
		let state = await getState(page);
		expect(state.textareaValue).toBe("third");
		expect(state.historyIndex).toBe(2);

		await page.keyboard.press("ArrowUp");
		state = await getState(page);
		expect(state.textareaValue).toBe("second");
		expect(state.historyIndex).toBe(1);

		await page.keyboard.press("ArrowUp");
		state = await getState(page);
		expect(state.textareaValue).toBe("first");
		expect(state.historyIndex).toBe(0);
	});

	test("up arrow at oldest entry stays put", async ({ page }) => {
		await page.click("#editor");

		// Go to oldest
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");

		let state = await getState(page);
		expect(state.textareaValue).toBe("first");
		expect(state.historyIndex).toBe(0);

		// Press up again — should stay at first
		await page.keyboard.press("ArrowUp");
		state = await getState(page);
		expect(state.textareaValue).toBe("first");
		expect(state.historyIndex).toBe(0);
	});

	test("down arrow navigates forward through history then restores draft", async ({ page }) => {
		await page.click("#editor");

		// Go to oldest
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");

		// Now go back down
		await page.keyboard.press("ArrowDown");
		let state = await getState(page);
		expect(state.textareaValue).toBe("second");

		await page.keyboard.press("ArrowDown");
		state = await getState(page);
		expect(state.textareaValue).toBe("third");

		// One more down — back to index -1, empty draft
		await page.keyboard.press("ArrowDown");
		state = await getState(page);
		expect(state.textareaValue).toBe("");
		expect(state.historyIndex).toBe(-1);
	});

	test("draft text is saved on first up and restored on down back", async ({ page }) => {
		await page.click("#editor");
		await page.keyboard.type("my draft");

		// Press up — draft should be saved, history entry shown
		await page.keyboard.press("ArrowUp");
		let state = await getState(page);
		expect(state.textareaValue).toBe("third");
		expect(state.savedDraft).toBe("my draft");

		// Press down — back past end, draft restored
		await page.keyboard.press("ArrowDown");
		state = await getState(page);
		expect(state.textareaValue).toBe("my draft");
		expect(state.historyIndex).toBe(-1);
	});

	test("down past end of history returns to index -1", async ({ page }) => {
		await page.click("#editor");

		// Go up once (to "third"), then down past it
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowDown");

		const state = await getState(page);
		expect(state.historyIndex).toBe(-1);
		expect(state.textareaValue).toBe("");
	});
});

test.describe("CommandHistoryStore dedup", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
	});

	test("consecutive duplicate entries are deduped (story 29)", async ({ page }) => {
		const history = await page.evaluate(async () => {
			const store = (window as any).historyStore;
			await store.addEntry("test-session", "dup");
			await store.addEntry("test-session", "dup");
			await store.addEntry("test-session", "dup");
			return store.getHistory("test-session");
		});
		expect(history).toEqual(["dup"]);
		expect(history).toHaveLength(1);
	});

	test("non-consecutive duplicates are kept", async ({ page }) => {
		const history = await page.evaluate(async () => {
			const store = (window as any).historyStore;
			await store.addEntry("test-session", "alpha");
			await store.addEntry("test-session", "beta");
			await store.addEntry("test-session", "alpha");
			return store.getHistory("test-session");
		});
		expect(history).toEqual(["alpha", "beta", "alpha"]);
	});

	test("empty/whitespace entries are ignored", async ({ page }) => {
		const history = await page.evaluate(async () => {
			const store = (window as any).historyStore;
			await store.addEntry("test-session", "real");
			await store.addEntry("test-session", "");
			await store.addEntry("test-session", "   ");
			return store.getHistory("test-session");
		});
		expect(history).toEqual(["real"]);
	});
});
