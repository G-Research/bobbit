import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/markdown-web-content.html")}`;

test.describe("isMarkdownContent detection", () => {
	test.describe("URL-based detection", () => {
		test(".md URL returns true", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() =>
				(window as any).isMarkdownContent("https://raw.githubusercontent.com/user/repo/main/README.md", "some content"),
			);
			expect(result).toBe(true);
		});

		test(".markdown URL returns true", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() =>
				(window as any).isMarkdownContent("https://example.com/docs/guide.markdown", "some content"),
			);
			expect(result).toBe(true);
		});

		test(".md with query params returns true", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() =>
				(window as any).isMarkdownContent("https://example.com/file.md?token=abc&ref=main", "some content"),
			);
			expect(result).toBe(true);
		});

		test(".md with hash fragment returns true", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() =>
				(window as any).isMarkdownContent("https://example.com/file.md#section", "some content"),
			);
			expect(result).toBe(true);
		});

		test(".MD uppercase returns true (case-insensitive)", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() =>
				(window as any).isMarkdownContent("https://example.com/README.MD", "some content"),
			);
			expect(result).toBe(true);
		});

		test("non-markdown URL returns false", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() =>
				(window as any).isMarkdownContent("https://example.com/page.html", "some content"),
			);
			expect(result).toBe(false);
		});

		test("URL with .md in path but not at end returns false", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate(() =>
				(window as any).isMarkdownContent("https://example.com/md/page.html", "some content"),
			);
			expect(result).toBe(false);
		});
	});

	test.describe("Content-based detection", () => {
		const nonMdUrl = "https://api.example.com/content";

		test("content with heading and link detected as markdown", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, "# My Project\n\nCheck out [the docs](https://example.com) for more info."),
				nonMdUrl,
			);
			expect(result).toBe(true);
		});

		test("frontmatter (---) detected as markdown", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, "---\ntitle: My Post\ndate: 2024-01-01\n---\n\n# Hello World"),
				nonMdUrl,
			);
			expect(result).toBe(true);
		});

		test("content with headings and code fences detected", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, "## Installation\n\n```bash\nnpm install my-package\n```\n"),
				nonMdUrl,
			);
			expect(result).toBe(true);
		});

		test("content with multiple indicators (bold + list + heading)", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, "# Features\n\n- Fast rendering\n- **Easy** to use\n- Lightweight"),
				nonMdUrl,
			);
			expect(result).toBe(true);
		});

		test("content with links and list items", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, "Check out [the docs](https://example.com)\n\n- Item one\n- Item two"),
				nonMdUrl,
			);
			expect(result).toBe(true);
		});

		test("plain text without markdown patterns returns false", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, "This is just some plain text content without any special formatting or patterns."),
				nonMdUrl,
			);
			expect(result).toBe(false);
		});

		test("single heading at start is a strong signal (detected as markdown)", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, "# Just a heading\n\nSome plain text after it."),
				nonMdUrl,
			);
			expect(result).toBe(true);
		});

		test("heading NOT at start needs 2+ indicators", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, "Some intro text\n\n## A heading\n\nMore text."),
				nonMdUrl,
			);
			expect(result).toBe(false);
		});

		test("HTML content is not detected as markdown", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, "<html><head><title>Page</title></head><body><h1>Hello</h1></body></html>"),
				nonMdUrl,
			);
			expect(result).toBe(false);
		});

		test("JSON content is not detected as markdown", async ({ page }) => {
			await page.goto(TEST_PAGE);
			const result = await page.evaluate((url) =>
				(window as any).isMarkdownContent(url, '{"name": "package", "version": "1.0.0", "description": "A package"}'),
				nonMdUrl,
			);
			expect(result).toBe(false);
		});

		test("URL-based detection takes priority over content", async ({ page }) => {
			await page.goto(TEST_PAGE);
			// .md URL with non-markdown content should still return true
			const result = await page.evaluate(() =>
				(window as any).isMarkdownContent("https://example.com/data.md", '{"json": true}'),
			);
			expect(result).toBe(true);
		});
	});
});
