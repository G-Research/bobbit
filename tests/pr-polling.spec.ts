import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/pr-polling.html")}`;

test.describe("PR polling deduplication and rate limiting", () => {

	test("refreshPrStatusCache should not allow duplicate concurrent batches", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Fire two concurrent calls to refreshPrStatusCache — the current code
		// has no in-flight guard, so both will fan out separate fetch batches.
		const concurrentBatches = await page.evaluate(async () => {
			const log = (window as any).__fetchLog;
			log.length = 0; // reset

			const refresh = (window as any).__refreshPrStatusCache;

			// Fire two concurrent refreshes without awaiting
			const p1 = refresh();
			const p2 = refresh();
			await Promise.all([p1, p2]);

			// Count how many PR status fetches were made.
			// There are 2 goals with branches, so a single batch = 2 fetches.
			// If dedup works, we'd see exactly 2 fetches (one batch).
			// Without dedup, we see 4 fetches (two batches).
			const prFetches = log.filter((e: any) => e.path.includes("/pr-status"));
			return {
				totalFetches: prFetches.length,
				// Group by approximate time to count batches
				batchCount: prFetches.length / 2,
			};
		});

		// ASSERTION: With proper deduplication, only 1 batch (2 fetches) should fire.
		// The current code fires 2 batches (4 fetches) — this test should FAIL.
		expect(
			concurrentBatches.batchCount,
			`Expected no duplicate PR requests but got ${concurrentBatches.batchCount} concurrent batches (${concurrentBatches.totalFetches} total fetches for 2 goals)`
		).toBe(1);
	});

	test("refreshPrStatusCache should not fire when tab is hidden", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const fetchedWhileHidden = await page.evaluate(async () => {
			const log = (window as any).__fetchLog;
			log.length = 0;

			// Simulate hidden tab via Object.defineProperty
			Object.defineProperty(document, "visibilityState", {
				value: "hidden",
				writable: true,
				configurable: true,
			});

			// Call refreshPrStatusCache — the current code has NO visibility check,
			// so it will fire fetches even when tab is hidden.
			await (window as any).__refreshPrStatusCache();

			const prFetches = log.filter((e: any) => e.path.includes("/pr-status"));
			return prFetches.length;
		});

		// ASSERTION: When tab is hidden, no PR fetches should fire.
		// Current code ignores visibility — this test should FAIL.
		expect(
			fetchedWhileHidden,
			"Expected 0 PR fetches when tab is hidden but refreshPrStatusCache does not check document.visibilityState"
		).toBe(0);
	});

	test("PR_POLL_INTERVAL_MS should be at least 60 seconds", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const interval = await page.evaluate(() => (window as any).__PR_POLL_INTERVAL_MS);

		// ASSERTION: Interval should be >= 60_000ms (60s).
		// Current value is 15_000ms (15s) — this test should FAIL.
		expect(
			interval,
			`Expected PR poll interval >= 60000ms but got ${interval}ms — polling is too aggressive`
		).toBeGreaterThanOrEqual(60_000);
	});

	test("Goal dashboard polling interval should be at least 60 seconds", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const interval = await page.evaluate(() => (window as any).__GOAL_DASHBOARD_POLL_INTERVAL_MS);

		// ASSERTION: Goal dashboard git+PR polling should be >= 60_000ms.
		// Current value is 30_000ms — this test should FAIL.
		expect(
			interval,
			`Expected goal dashboard poll interval >= 60000ms but got ${interval}ms`
		).toBeGreaterThanOrEqual(60_000);
	});
});
