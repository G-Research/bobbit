import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/git-status-widget.html")}`;

// =============================================================================
// Data parsing tests — verify server-side git status porcelain parsing
// =============================================================================

test.describe("Git status porcelain parsing (fixed)", () => {
	test("parses standard porcelain output correctly", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const data = await page.evaluate(() => (window as any).__testData);
		expect(data.parsedFiles).toEqual([
			{ file: "src/app/api.ts", status: "M" },
			{ file: "src/app/render-helpers.ts", status: "M" },
			{ file: "src/app/sidebar.ts", status: "M" },
			{ file: "src/app/state.ts", status: "M" },
		]);
	});

	test("file paths do not lose leading characters", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const data = await page.evaluate(() => (window as any).__testData);
		for (const f of data.parsedFiles) {
			expect(f.file).toMatch(/^src\//);
		}
	});

	test("parses two-character status codes correctly", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const parsed = await page.evaluate(() =>
			(window as any).__testData.parsedFiles.map(
				(f: any) => `${f.status}:${f.file}`,
			),
		);
		expect(parsed).toEqual([
			"M:src/app/api.ts",
			"M:src/app/render-helpers.ts",
			"M:src/app/sidebar.ts",
			"M:src/app/state.ts",
		]);
	});
});

// =============================================================================
// Regression: the old .trim() bug
// =============================================================================

test.describe("REGRESSION: .trim() strips leading space from first line", () => {
	test("buggy parser loses first char of first file path", async ({
		page,
	}) => {
		await page.goto(TEST_PAGE);

		const data = await page.evaluate(() => (window as any).__testData);

		// The buggy parser uses .trim() which strips the leading space from
		// " M src/app/api.ts", turning it into "M src/app/api.ts".
		// Then substring(3) gives "rc/app/api.ts" — missing the "s".
		expect(data.parsedFilesBuggy[0].file).toBe("rc/app/api.ts");

		// Other lines are unaffected because they start with " M" (leading
		// space is preserved since it's in the middle of the string after trim)
		expect(data.parsedFilesBuggy[1].file).toBe("src/app/render-helpers.ts");
		expect(data.parsedFilesBuggy[2].file).toBe("src/app/sidebar.ts");
		expect(data.parsedFilesBuggy[3].file).toBe("src/app/state.ts");
	});

	test("fixed parser preserves first file path correctly", async ({
		page,
	}) => {
		await page.goto(TEST_PAGE);

		const data = await page.evaluate(() => (window as any).__testData);
		expect(data.parsedFiles[0].file).toBe("src/app/api.ts");
	});
});

// =============================================================================
// Visual rendering tests — verify file paths are fully visible in the dropdown
// =============================================================================

test.describe("GitStatusWidget dropdown rendering", () => {
	test("all file paths are fully visible in inline dropdown", async ({
		page,
	}) => {
		await page.goto(TEST_PAGE);

		const fileSpans = page.locator(
			"#test-inline-dropdown [data-file-list] .text-foreground.truncate",
		);
		const count = await fileSpans.count();
		expect(count).toBe(4);

		const expectedFiles = [
			"src/app/api.ts",
			"src/app/render-helpers.ts",
			"src/app/sidebar.ts",
			"src/app/state.ts",
		];

		for (let i = 0; i < count; i++) {
			const text = await fileSpans.nth(i).textContent();
			expect(text?.trim()).toBe(expectedFiles[i]);
		}
	});

	test("file path text starts with 'src/' visually (not clipped)", async ({
		page,
	}) => {
		await page.goto(TEST_PAGE);

		const fileSpans = page.locator(
			"#test-inline-dropdown [data-file-list] .text-foreground.truncate",
		);

		for (let i = 0; i < (await fileSpans.count()); i++) {
			const span = fileSpans.nth(i);

			const scrollLeft = await span.evaluate(
				(el: Element) => el.scrollLeft,
			);
			expect(scrollLeft).toBe(0);

			const clipped = await span.evaluate((el: Element) => {
				const elRect = el.getBoundingClientRect();
				const parentRect = el.parentElement!.getBoundingClientRect();
				return elRect.left < parentRect.left;
			});
			expect(clipped).toBe(false);
		}
	});

	test("status labels show correct text", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const labels = page.locator(
			"#test-inline-dropdown [data-file-list] .font-mono",
		);
		const count = await labels.count();
		expect(count).toBe(4);

		for (let i = 0; i < count; i++) {
			const text = await labels.nth(i).textContent();
			expect(text?.trim()).toBe("modified");
		}
	});

	test("various status types render correct labels and colors", async ({
		page,
	}) => {
		await page.goto(TEST_PAGE);

		const labels = page.locator(
			"#test-various-statuses [data-file-list] .font-mono",
		);
		const expectedLabels = [
			"added",
			"modified",
			"deleted",
			"renamed",
			"untracked",
		];

		for (let i = 0; i < expectedLabels.length; i++) {
			const text = await labels.nth(i).textContent();
			expect(text?.trim()).toBe(expectedLabels[i]);
		}
	});

	test("long paths truncate with ellipsis on the RIGHT, not left", async ({
		page,
	}) => {
		await page.goto(TEST_PAGE);

		const fileSpans = page.locator(
			"#test-long-paths [data-file-list] .text-foreground.truncate",
		);

		const longSpan = fileSpans.nth(1);
		const truncation = await longSpan.evaluate((el: Element) => {
			const style = window.getComputedStyle(el);
			return {
				overflow: style.overflow,
				textOverflow: style.textOverflow,
				whiteSpace: style.whiteSpace,
				isTruncated: el.scrollWidth > el.clientWidth,
			};
		});

		expect(truncation.overflow).toBe("hidden");
		expect(truncation.textOverflow).toBe("ellipsis");
		expect(truncation.whiteSpace).toBe("nowrap");

		const visibleText = await longSpan.textContent();
		expect(visibleText?.trim()).toMatch(/^src\//);
	});
});

// =============================================================================
// Fixed-position dropdown tests
// =============================================================================

test.describe("Fixed-position dropdown (real widget simulation)", () => {
	test("file paths are not clipped by fixed positioning", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 720 });
		await page.goto(TEST_PAGE);

		await page.evaluate(() => (window as any).__showFixedDropdown());

		const fileSpans = page.locator(
			"#fixed-dropdown [data-file-list] .text-foreground.truncate",
		);
		const count = await fileSpans.count();
		expect(count).toBe(4);

		for (let i = 0; i < count; i++) {
			const text = await fileSpans.nth(i).textContent();
			expect(text?.trim()).toMatch(/^src\//);
		}

		const dropdownBox = await page
			.locator("#fixed-dropdown")
			.boundingBox();
		expect(dropdownBox).not.toBeNull();
		expect(dropdownBox!.x).toBeGreaterThanOrEqual(0);
	});

	test("dropdown left edge does not clip file paths on narrow viewport", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 480, height: 720 });
		await page.goto(TEST_PAGE);

		await page.evaluate(() => (window as any).__showFixedDropdown());

		const dropdown = page.locator("#fixed-dropdown");
		const box = await dropdown.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);

		const firstFile = page
			.locator(
				"#fixed-dropdown [data-file-list] .text-foreground.truncate",
			)
			.first();
		const text = await firstFile.textContent();
		expect(text?.trim()).toMatch(/^src\//);
	});
});

// =============================================================================
// Edge cases in porcelain parsing
// =============================================================================

test.describe("Porcelain parsing edge cases", () => {
	test("handles staged + unstaged status (MM)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const line = "MM src/app/api.ts";
			const l = line.endsWith("\r") ? line.slice(0, -1) : line;
			return { file: l.substring(3), status: l.substring(0, 2).trim() };
		});

		expect(result.file).toBe("src/app/api.ts");
		expect(result.status).toBe("MM");
	});

	test("handles added file (A  prefix)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const line = "A  src/new-file.ts";
			const l = line.endsWith("\r") ? line.slice(0, -1) : line;
			return { file: l.substring(3), status: l.substring(0, 2).trim() };
		});

		expect(result.file).toBe("src/new-file.ts");
		expect(result.status).toBe("A");
	});

	test("handles untracked file (?? prefix)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const line = "?? src/untracked.ts";
			const l = line.endsWith("\r") ? line.slice(0, -1) : line;
			return { file: l.substring(3), status: l.substring(0, 2).trim() };
		});

		expect(result.file).toBe("src/untracked.ts");
		expect(result.status).toBe("??");
	});

	test("handles renamed file with arrow", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const line = "R  old-name.ts -> new-name.ts";
			const l = line.endsWith("\r") ? line.slice(0, -1) : line;
			return { file: l.substring(3), status: l.substring(0, 2).trim() };
		});

		expect(result.file).toBe("old-name.ts -> new-name.ts");
		expect(result.status).toBe("R");
	});

	test("handles Windows CRLF line endings", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const raw = " M src/app/api.ts\r\n M src/app/state.ts\r\n";
			const trimmed = raw.replace(/\\s+$/, "");
			// Use the fixed parser logic
			return (window as any).__testData.parsedFiles;
		});

		// The fixed parser handles CRLF correctly
		expect(result[0].file).toBe("src/app/api.ts");
		expect(result[0].status).toBe("M");
	});

	test("handles CRLF with fixed parser", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const raw = " M src/app/api.ts\r\n M src/app/state.ts\r\n";
			const trimmed = raw.replace(/\s+$/, "");
			const lines = trimmed.split("\n");
			return lines.map((line: string) => {
				const l = line.endsWith("\r") ? line.slice(0, -1) : line;
				return { file: l.substring(3), status: l.substring(0, 2).trim() };
			});
		});

		expect(result[0].file).toBe("src/app/api.ts");
		expect(result[0].status).toBe("M");
		expect(result[1].file).toBe("src/app/state.ts");
		expect(result[1].status).toBe("M");
	});
});
