import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/cwd-path-normalize.html")}`;

test.describe("CWD combobox path normalization", () => {
	test("no duplicates when same path appears in both slash formats (sessions)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const cwds: Array<{ path: string; source: string }> = await page.evaluate(
			() => (window as any).__results.cwds,
		);

		// C:\Users\foo\project and C:/Users/foo/project refer to the same dir — should appear once
		const fooPaths = cwds.filter((c) => c.path.replace(/\\/g, "/") === "C:/Users/foo/project");
		expect(fooPaths).toHaveLength(1);
	});

	test("no duplicates when same path appears in both slash formats (goals)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const cwds: Array<{ path: string; source: string }> = await page.evaluate(
			() => (window as any).__results.cwds,
		);

		// C:\Users\bar\work (goal cwd) and C:/Users/bar/work (goal repoPath) — should appear once
		const barPaths = cwds.filter((c) => c.path.replace(/\\/g, "/") === "C:/Users/bar/work");
		expect(barPaths).toHaveLength(1);
	});

	test("all returned paths use forward slashes only", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const cwds: Array<{ path: string; source: string }> = await page.evaluate(
			() => (window as any).__results.cwds,
		);

		for (const entry of cwds) {
			expect(entry.path).not.toContain("\\");
		}
	});

	test("defaultCwd placeholder is normalized to forward slashes", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const defaultCwd: string = await page.evaluate(
			() => (window as any).__results.defaultCwd,
		);

		expect(defaultCwd).not.toContain("\\");
		expect(defaultCwd).toBe("C:/Users/foo");
	});
});
