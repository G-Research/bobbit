/**
 * Unit fixture tests for <search-results> component behavior.
 *
 * Tests: grouping by type, result-click event, empty state, loading state,
 * no-query state, snippet sanitization.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/fixtures/search-box-fixture.html").replace(/\\/g, "/")}`;

const SAMPLE_RESULTS = [
	{ type: "goal", id: "g1", title: "My Goal", snippet: "goal <b>match</b>", timestamp: Date.now(), archived: false },
	{ type: "goal", id: "g2", title: "Another Goal", snippet: "second <b>goal</b>", timestamp: Date.now(), archived: true },
	{ type: "session", id: "s1", title: "Chat Session", snippet: "session <b>result</b>", timestamp: Date.now(), archived: false, goalId: "g1" },
	{ type: "message", id: "m1", title: "Message Hit", snippet: "message <b>text</b>", timestamp: Date.now(), archived: false, sessionId: "s1", goalId: "g1" },
];

test.describe("SearchResults: grouping", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("groups results by type with correct headers", async ({ page }) => {
		await page.evaluate((results) => {
			(window as any).setResultsState({ results, loading: false, query: "match" });
		}, SAMPLE_RESULTS);

		// Check group headers
		const headers = await page.$$eval(".group-header", (els: Element[]) =>
			els.map(el => el.textContent)
		);
		expect(headers).toContain("Goals");
		expect(headers).toContain("Sessions");
		expect(headers).toContain("Messages");
	});

	test("goals group contains correct number of items", async ({ page }) => {
		await page.evaluate((results) => {
			(window as any).setResultsState({ results, loading: false, query: "match" });
		}, SAMPLE_RESULTS);

		const goalItems = await page.$$eval(
			'[data-group="Goals"] .result-item',
			(els: Element[]) => els.length
		);
		expect(goalItems).toBe(2);
	});

	test("sessions group contains correct number of items", async ({ page }) => {
		await page.evaluate((results) => {
			(window as any).setResultsState({ results, loading: false, query: "match" });
		}, SAMPLE_RESULTS);

		const sessionItems = await page.$$eval(
			'[data-group="Sessions"] .result-item',
			(els: Element[]) => els.length
		);
		expect(sessionItems).toBe(1);
	});

	test("messages group contains correct number of items", async ({ page }) => {
		await page.evaluate((results) => {
			(window as any).setResultsState({ results, loading: false, query: "match" });
		}, SAMPLE_RESULTS);

		const msgItems = await page.$$eval(
			'[data-group="Messages"] .result-item',
			(els: Element[]) => els.length
		);
		expect(msgItems).toBe(1);
	});
});

test.describe("SearchResults: result-click event", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("clicking a result fires result-click with correct detail", async ({ page }) => {
		await page.evaluate((results) => {
			(window as any).setResultsState({ results, loading: false, query: "match" });
			(window as any).clearEvents();
		}, SAMPLE_RESULTS);

		// Click the first goal result
		await page.click('[data-type="goal"][data-id="g1"]');

		const events = await page.evaluate(() =>
			(window as any).getEvents().filter((e: any) => e.type === "result-click")
		);
		expect(events).toHaveLength(1);
		expect(events[0].detail).toEqual(
			expect.objectContaining({ type: "goal", id: "g1" })
		);
	});

	test("clicking a message result includes sessionId and goalId", async ({ page }) => {
		await page.evaluate((results) => {
			(window as any).setResultsState({ results, loading: false, query: "match" });
			(window as any).clearEvents();
		}, SAMPLE_RESULTS);

		await page.click('[data-type="message"][data-id="m1"]');

		const events = await page.evaluate(() =>
			(window as any).getEvents().filter((e: any) => e.type === "result-click")
		);
		expect(events).toHaveLength(1);
		expect(events[0].detail).toEqual(
			expect.objectContaining({
				type: "message",
				id: "m1",
				sessionId: "s1",
				goalId: "g1",
			})
		);
	});

	test("clicking a session result includes goalId", async ({ page }) => {
		await page.evaluate((results) => {
			(window as any).setResultsState({ results, loading: false, query: "match" });
			(window as any).clearEvents();
		}, SAMPLE_RESULTS);

		await page.click('[data-type="session"][data-id="s1"]');

		const events = await page.evaluate(() =>
			(window as any).getEvents().filter((e: any) => e.type === "result-click")
		);
		expect(events).toHaveLength(1);
		expect(events[0].detail).toEqual(
			expect.objectContaining({
				type: "session",
				id: "s1",
				goalId: "g1",
			})
		);
	});
});

test.describe("SearchResults: empty state", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("shows 'No matches for ...' when query set but no results", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setResultsState({ results: [], loading: false, query: "nonexistent" });
		});

		const emptyEl = page.locator('[data-testid="empty"]');
		await expect(emptyEl).toBeVisible();
		await expect(emptyEl).toContainText('No matches for "nonexistent"');
	});

	test("no group headers present in empty state", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setResultsState({ results: [], loading: false, query: "nothing" });
		});

		const headers = await page.$$(".group-header");
		expect(headers).toHaveLength(0);
	});
});

test.describe("SearchResults: loading state", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("shows 'Searching...' when loading with no results", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setResultsState({ results: [], loading: true, query: "test" });
		});

		const loadingEl = page.locator('[data-testid="loading"]');
		await expect(loadingEl).toBeVisible();
		await expect(loadingEl).toContainText("Searching");
	});

	test("shows 'Updating...' when loading with existing results", async ({ page }) => {
		await page.evaluate((results) => {
			(window as any).setResultsState({ results, loading: true, query: "match" });
		}, SAMPLE_RESULTS);

		const updatingEl = page.locator('[data-testid="updating"]');
		await expect(updatingEl).toBeVisible();
		await expect(updatingEl).toContainText("Updating");

		// Results should still be visible alongside the updating indicator
		const headers = await page.$$(".group-header");
		expect(headers.length).toBeGreaterThan(0);
	});
});

test.describe("SearchResults: no query state", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("renders nothing when query is empty", async ({ page }) => {
		await page.evaluate(() => {
			(window as any).setResultsState({ results: [], loading: false, query: "" });
		});

		const html = await page.evaluate(() => (window as any).getResultsHTML());
		expect(html).toBe("");
	});
});

test.describe("SearchResults: snippet sanitization", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("allows <b> tags for highlighting but escapes other HTML", async ({ page }) => {
		const maliciousResults = [
			{
				type: "goal",
				id: "xss1",
				title: "XSS Test",
				snippet: '<b>safe</b> <script>alert("xss")</script> <img onerror=alert(1)>',
				timestamp: Date.now(),
				archived: false,
			},
		];

		await page.evaluate((results) => {
			(window as any).setResultsState({ results, loading: false, query: "test" });
		}, maliciousResults);

		// Get the snippet HTML
		const snippetHTML = await page.$eval(".result-snippet", (el: Element) => el.innerHTML);

		// <b> tags should be preserved
		expect(snippetHTML).toContain("<b>safe</b>");

		// <script> and <img> should be escaped
		expect(snippetHTML).not.toContain("<script>");
		expect(snippetHTML).not.toContain("<img");
		expect(snippetHTML).toContain("&lt;script&gt;");
	});
});
