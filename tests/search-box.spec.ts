/**
 * Unit fixture tests for <search-box> component behavior.
 *
 * Tests: Ctrl+K focus, debounced search-input event, Escape clear+blur,
 * clear button, Full Search link, controls row visibility, no Content toggle.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/fixtures/search-box-fixture.html").replace(/\\/g, "/")}`;

test.describe("SearchBox: keyboard shortcut", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("Ctrl+K focuses the search input", async ({ page }) => {
		// Ensure input is not focused initially
		const before = await page.evaluate(() => (window as any).getActiveElement());
		expect(before).not.toBe("search-input");

		await page.keyboard.press("Control+k");

		const after = await page.evaluate(() => (window as any).getActiveElement());
		expect(after).toBe("search-input");
	});
});

test.describe("SearchBox: debounced input", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("typing fires search-input event after ~200ms debounce", async ({ page }) => {
		await page.click("#search-input");
		await page.evaluate(() => (window as any).clearEvents());

		await page.type("#search-input", "hello");

		// Immediately after typing, no event yet
		const eventsImmediate = await page.evaluate(() =>
			(window as any).getEvents().filter((e: any) => e.type === "search-input")
		);
		expect(eventsImmediate).toHaveLength(0);

		// Wait for debounce (200ms + buffer)
		await page.waitForTimeout(350);

		const events = await page.evaluate(() =>
			(window as any).getEvents().filter((e: any) => e.type === "search-input")
		);
		expect(events).toHaveLength(1);
		expect(events[0].detail.query).toBe("hello");
	});

	test("rapid typing only fires one debounced event", async ({ page }) => {
		await page.click("#search-input");
		await page.evaluate(() => (window as any).clearEvents());

		// Type characters with small delays (within debounce window)
		await page.type("#search-input", "a", { delay: 30 });
		await page.type("#search-input", "b", { delay: 30 });
		await page.type("#search-input", "c", { delay: 30 });

		await page.waitForTimeout(350);

		const events = await page.evaluate(() =>
			(window as any).getEvents().filter((e: any) => e.type === "search-input")
		);
		expect(events).toHaveLength(1);
		expect(events[0].detail.query).toBe("abc");
	});
});

test.describe("SearchBox: Escape key", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("Escape clears query and blurs input", async ({ page }) => {
		// Type something first
		await page.click("#search-input");
		await page.type("#search-input", "test query");
		await page.waitForTimeout(50);

		expect(await page.evaluate(() => (window as any).getQuery())).toBe("test query");

		await page.evaluate(() => (window as any).clearEvents());
		await page.keyboard.press("Escape");

		// Query should be cleared
		expect(await page.evaluate(() => (window as any).getQuery())).toBe("");

		// Input value should be empty
		const val = await page.inputValue("#search-input");
		expect(val).toBe("");

		// Input should be blurred
		const active = await page.evaluate(() => (window as any).getActiveElement());
		expect(active).not.toBe("search-input");

		// search-clear event should have fired
		const events = await page.evaluate(() =>
			(window as any).getEvents().filter((e: any) => e.type === "search-clear")
		);
		expect(events).toHaveLength(1);
	});
});

test.describe("SearchBox: clear button", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("clear button hidden when query is empty", async ({ page }) => {
		const hidden = await page.locator("#clear-btn").evaluate(
			(el) => el.classList.contains("hidden")
		);
		expect(hidden).toBe(true);
	});

	test("clear button visible when query is non-empty", async ({ page }) => {
		await page.click("#search-input");
		await page.type("#search-input", "foo");

		const hidden = await page.locator("#clear-btn").evaluate(
			(el) => el.classList.contains("hidden")
		);
		expect(hidden).toBe(false);
	});

	test("clicking clear button fires search-clear and resets query", async ({ page }) => {
		await page.click("#search-input");
		await page.type("#search-input", "something");
		await page.evaluate(() => (window as any).clearEvents());

		await page.click("#clear-btn");

		expect(await page.evaluate(() => (window as any).getQuery())).toBe("");
		expect(await page.inputValue("#search-input")).toBe("");

		const events = await page.evaluate(() =>
			(window as any).getEvents().filter((e: any) => e.type === "search-clear")
		);
		expect(events).toHaveLength(1);
	});
});

test.describe("SearchBox: Full Search link", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("Full Search click fires full-search-click event with query", async ({ page }) => {
		await page.evaluate(() => (window as any).setQuery("my search"));
		await page.evaluate(() => (window as any).clearEvents());

		await page.click("#full-search-btn");

		const events = await page.evaluate(() =>
			(window as any).getEvents().filter((e: any) => e.type === "full-search-click")
		);
		expect(events).toHaveLength(1);
		expect(events[0].detail.query).toBe("my search");
	});
});

test.describe("SearchBox: controls row visibility", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("controls row hidden when query is empty", async ({ page }) => {
		const visible = await page.evaluate(() => (window as any).isControlsRowVisible());
		expect(visible).toBe(false);
	});

	test("controls row visible when query is non-empty", async ({ page }) => {
		await page.click("#search-input");
		await page.type("#search-input", "hello");

		const visible = await page.evaluate(() => (window as any).isControlsRowVisible());
		expect(visible).toBe(true);
	});

	test("controls row hides again when query is cleared", async ({ page }) => {
		await page.click("#search-input");
		await page.type("#search-input", "test");
		expect(await page.evaluate(() => (window as any).isControlsRowVisible())).toBe(true);

		await page.click("#clear-btn");
		expect(await page.evaluate(() => (window as any).isControlsRowVisible())).toBe(false);
	});
});

test.describe("SearchBox: Content toggle removed", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("no Content toggle exists in the component", async ({ page }) => {
		// There should be no element with text "Content" acting as a toggle
		const contentToggle = await page.locator('[data-testid="content-toggle"]').count();
		expect(contentToggle).toBe(0);

		// No toggle switch or checkbox labeled "Content"
		const toggleButtons = await page.evaluate(() => {
			const buttons = Array.from(document.querySelectorAll("button, input[type=checkbox]"));
			return buttons.filter(b => b.textContent?.includes("Content")).length;
		});
		expect(toggleButtons).toBe(0);
	});
});
