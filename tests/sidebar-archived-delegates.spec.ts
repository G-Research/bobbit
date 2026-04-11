import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/sidebar-archived-delegates.html")}`;

test.describe("SB-00b: Archived delegates inline in session response", () => {
	test.describe("client merge logic", () => {
		test("merges archived delegates into empty list", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).mergeArchivedDelegates(
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

		test("deduplicates against existing archived sessions", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).mergeArchivedDelegates(
					[{ id: "d1", delegateOf: "parent-1" }],
					[
						{ id: "d1", delegateOf: "parent-1" },
						{ id: "d2", delegateOf: "parent-1" },
					],
				);
			});
			expect(result).toHaveLength(2);
			expect(result.map((s: any) => s.id)).toEqual(["d1", "d2"]);
		});

		test("handles empty archivedDelegates from server", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).mergeArchivedDelegates(
					[{ id: "existing-1" }],
					[],
				);
			});
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("existing-1");
		});

		test("deduplicates across repeated merges", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				const merge = (window as any).mergeArchivedDelegates;
				const after1 = merge([], [
					{ id: "d1", delegateOf: "p1" },
					{ id: "d2", delegateOf: "p1" },
				]);
				const after2 = merge(after1, [
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

	test.describe("chevron (hasChildren) logic", () => {
		test("shows chevron when archived delegates exist and showArchived is on", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).computeHasChildren(
					"parent-1",
					[{ id: "parent-1", status: "idle" }],
					[{ id: "d1", delegateOf: "parent-1" }],
					true,
				);
			});
			expect(result).toBe(true);
		});

		test("hides chevron when archived delegates exist but showArchived is off", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).computeHasChildren(
					"parent-1",
					[{ id: "parent-1", status: "idle" }],
					[{ id: "d1", delegateOf: "parent-1" }],
					false,
				);
			});
			expect(result).toBe(false);
		});

		test("shows chevron when live delegates exist regardless of showArchived", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).computeHasChildren(
					"parent-1",
					[
						{ id: "parent-1", status: "idle" },
						{ id: "d1", delegateOf: "parent-1", status: "streaming" },
					],
					[],
					false,
				);
			});
			expect(result).toBe(true);
		});

		test("no chevron when no delegates at all", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).computeHasChildren(
					"parent-1",
					[{ id: "parent-1", status: "idle" }],
					[],
					true,
				);
			});
			expect(result).toBe(false);
		});
	});

	test.describe("server BFS logic", () => {
		test("finds direct archived delegates of live sessions", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).serverBFS(
					[{ id: "live-1" }],
					[
						{ id: "d1", delegateOf: "live-1" },
						{ id: "d2", delegateOf: "other" },
					],
				);
			});
			expect(result).toHaveLength(1);
			expect(result[0].id).toBe("d1");
		});

		test("finds nested archived delegates (delegate of delegate)", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).serverBFS(
					[{ id: "live-1" }],
					[
						{ id: "d1", delegateOf: "live-1" },
						{ id: "d2", delegateOf: "d1" },
						{ id: "d3", delegateOf: "d2" },
					],
				);
			});
			expect(result).toHaveLength(3);
			expect(result.map((s: any) => s.id)).toEqual(["d1", "d2", "d3"]);
		});

		test("returns empty when no archived sessions are delegates of live", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).serverBFS(
					[{ id: "live-1" }],
					[
						{ id: "d1", delegateOf: "unrelated" },
					],
				);
			});
			expect(result).toHaveLength(0);
		});

		test("handles multiple live parents", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() => {
				return (window as any).serverBFS(
					[{ id: "live-1" }, { id: "live-2" }],
					[
						{ id: "d1", delegateOf: "live-1" },
						{ id: "d2", delegateOf: "live-2" },
						{ id: "d3", delegateOf: "other" },
					],
				);
			});
			expect(result).toHaveLength(2);
			expect(result.map((s: any) => s.id).sort()).toEqual(["d1", "d2"]);
		});
	});
});
