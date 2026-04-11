import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-delegates-fetch.html")}`;

test.describe("SB-00b: Delegate fetch dedup logic", () => {
	test("merges new delegates into empty archived list", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			return (window as any).mergeDelegates(
				[],
				[{ id: "live-1" }],
				[
					{ id: "d1", delegateOf: "parent-1" },
					{ id: "d2", delegateOf: "parent-1" },
				],
			);
		});
		expect(result).toHaveLength(2);
		expect(result.map((s: any) => s.id)).toEqual(["d1", "d2"]);
	});

	test("deduplicates against existing archived sessions", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			return (window as any).mergeDelegates(
				[{ id: "d1", delegateOf: "parent-1" }],
				[],
				[
					{ id: "d1", delegateOf: "parent-1" },
					{ id: "d2", delegateOf: "parent-1" },
				],
			);
		});
		expect(result).toHaveLength(2);
		expect(result.map((s: any) => s.id)).toEqual(["d1", "d2"]);
	});

	test("deduplicates against live sessions", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			return (window as any).mergeDelegates(
				[],
				[{ id: "d1" }],
				[
					{ id: "d1", delegateOf: "parent-1" },
					{ id: "d2", delegateOf: "parent-1" },
				],
			);
		});
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("d2");
	});

	test("handles empty incoming delegates", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			return (window as any).mergeDelegates(
				[{ id: "existing-1" }],
				[{ id: "live-1" }],
				[],
			);
		});
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("existing-1");
	});

	test("simulateFetchAndRender returns correct visible delegates", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			return (window as any).simulateFetchAndRender(
				"parent-1",
				[{ id: "other", delegateOf: "parent-2" }],
				[],
				[
					{ id: "d1", delegateOf: "parent-1" },
					{ id: "d2", delegateOf: "parent-1" },
					{ id: "d3", delegateOf: "parent-2" },
				],
			);
		});
		expect(result.merged).toHaveLength(4);
		expect(result.visibleDelegates).toHaveLength(2);
		expect(result.visibleDelegates.map((s: any) => s.id)).toEqual(["d1", "d2"]);
	});

	test("deduplicates across multiple fetches", async ({ page }) => {
		await page.goto(TEST_PAGE);
		const result = await page.evaluate(() => {
			const merge = (window as any).mergeDelegates;
			// First fetch
			const after1 = merge([], [], [
				{ id: "d1", delegateOf: "p1" },
				{ id: "d2", delegateOf: "p1" },
			]);
			// Second fetch (same delegates)
			const after2 = merge(after1, [], [
				{ id: "d1", delegateOf: "p1" },
				{ id: "d2", delegateOf: "p1" },
				{ id: "d3", delegateOf: "p1" },
			]);
			return after2;
		});
		expect(result).toHaveLength(3);
		expect(result.map((s: any) => s.id)).toEqual(["d1", "d2", "d3"]);
	});
});
