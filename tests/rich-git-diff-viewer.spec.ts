import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/rich-git-diff-viewer.html");
const BUNDLE = path.resolve("tests/fixtures/rich-git-diff-viewer-bundle.js");
const ENTRY = path.resolve("tests/fixtures/rich-git-diff-viewer-entry.ts");
const VIEWER_SRC = path.resolve("src/ui/components/RichGitDiffViewer.ts");
const PARSER_SRC = path.resolve("src/shared/git-diff/unified.ts");
const HAS_IMPLEMENTATION = fs.existsSync(VIEWER_SRC) && fs.existsSync(PARSER_SRC);

test.skip(
	!HAS_IMPLEMENTATION,
	"RichGitDiffViewer production implementation is supplied by sibling implementation tasks.",
);

test.beforeAll(() => {
	if (!HAS_IMPLEMENTATION) return;
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [ENTRY, VIEWER_SRC, PARSER_SRC],
	});
});

const PAGE = `file://${FIXTURE}`;

const MULTI_FILE_DIFF = String.raw`diff --git a/src/alpha.ts b/src/alpha.ts
index 1111111..2222222 100644
--- a/src/alpha.ts
+++ b/src/alpha.ts
@@ -1,5 +1,6 @@
 export function alpha() {
-	return "old alpha";
+	const label = "new alpha";
+	return label;
 }
 export const keep = true;
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 72%
rename from src/old-name.ts
rename to src/new-name.ts
index 3333333..4444444 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,4 +1,5 @@
 export const renamed = true;
-export const label = "before";
+export const label = "after";
+export const extra = "added";
 export const done = true;
`;

const LONG_CONTEXT_DIFF = String.raw`diff --git a/src/context.ts b/src/context.ts
index 5555555..6666666 100644
--- a/src/context.ts
+++ b/src/context.ts
@@ -1,16 +1,16 @@
 context line 1
 context line 2
 context line 3
 context line 4
 context line 5
 context line 6
 context line 7
 context line 8
-context line 9 before
+context line 9 after
 context line 10
 context line 11
 context line 12
 context line 13
 context line 14
 context line 15
 context line 16
`;

const TRUNCATED_DIFF = `${MULTI_FILE_DIFF}\n--- Diff truncated (exceeded 500KB) ---\n`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, {
		timeout: 10_000,
	});
	await page.waitForFunction(
		() => !!customElements.get("rich-git-diff-viewer"),
		null,
		{ timeout: 10_000 },
	);
}

async function mount(
	page: any,
	options: {
		content: string;
		title?: string;
		filePath?: string;
		defaultMode?: "auto" | "split" | "inline";
		showCopy?: boolean;
	},
): Promise<void> {
	await page.evaluate(async (opts: typeof options) => {
		await (window as any).__mountRichGitDiffViewer(opts);
	}, options);
}

function viewer(page: any) {
	return page.locator('[data-testid="rich-git-diff-viewer"]');
}

async function expectMode(page: any, mode: "split" | "inline") {
	const checked = page.locator(`[data-testid="rich-git-diff-mode-${mode}"]`);
	const unchecked = page.locator(
		`[data-testid="rich-git-diff-mode-${mode === "split" ? "inline" : "split"}"]`,
	);
	await expect(checked).toHaveAttribute("role", "radio");
	await expect(checked).toHaveAttribute("aria-checked", "true");
	await expect(unchecked).toHaveAttribute("role", "radio");
	await expect(unchecked).toHaveAttribute("aria-checked", "false");
}

test.describe("RichGitDiffViewer browser fixture", () => {
	test("renders raw multi-file diffs as collapsible file sections with counts and rename paths", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { content: MULTI_FILE_DIFF, defaultMode: "inline" });

		await expect(viewer(page)).toBeVisible();
		const files = page.locator('[data-testid="rich-git-diff-file"]');
		await expect(files).toHaveCount(2);

		await expect(files.nth(0)).toContainText("src/alpha.ts");
		await expect(files.nth(0).locator('[data-testid="rich-git-diff-counts"]')).toContainText("+2");
		await expect(files.nth(0).locator('[data-testid="rich-git-diff-counts"]')).toContainText("-1");

		await expect(files.nth(1)).toContainText("src/old-name.ts");
		await expect(files.nth(1)).toContainText("src/new-name.ts");
		await expect(files.nth(1).locator('[data-testid="rich-git-diff-counts"]')).toContainText("+2");
		await expect(files.nth(1).locator('[data-testid="rich-git-diff-counts"]')).toContainText("-1");
	});

	test("file collapse toggles update aria-expanded and hide file body lines", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { content: MULTI_FILE_DIFF, defaultMode: "inline" });

		const firstFile = page.locator('[data-testid="rich-git-diff-file"]').first();
		const toggle = firstFile.locator('[data-testid="rich-git-diff-file-toggle"]');
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(firstFile.locator('[data-testid="rich-git-diff-line"]', { hasText: "new alpha" })).toBeVisible();

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await expect(firstFile.locator('[data-testid="rich-git-diff-line"]', { hasText: "new alpha" })).toBeHidden();

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await expect(firstFile.locator('[data-testid="rich-git-diff-line"]', { hasText: "new alpha" })).toBeVisible();
	});

	test("split and inline mode controls expose radio ARIA state and change rendering", async ({ page }) => {
		await page.setViewportSize({ width: 1000, height: 720 });
		await gotoAndWait(page);
		await mount(page, { content: MULTI_FILE_DIFF, defaultMode: "split" });

		await expectMode(page, "split");
		const splitMarkup = await page.locator('[data-testid="rich-git-diff-file"]').first().evaluate((el) => el.outerHTML);
		await expect(page.locator('[data-testid="rich-git-diff-line"]', { hasText: "old alpha" }).first()).toBeVisible();

		await page.locator('[data-testid="rich-git-diff-mode-inline"]').click();
		await expectMode(page, "inline");
		await expect(page.locator('[data-testid="rich-git-diff-line"]', { hasText: "old alpha" }).first()).toBeVisible();
		const inlineMarkup = await page.locator('[data-testid="rich-git-diff-file"]').first().evaluate((el) => el.outerHTML);
		expect(inlineMarkup).not.toBe(splitMarkup);
	});

	test("context expansion reveals folded hunk lines", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { content: LONG_CONTEXT_DIFF, defaultMode: "inline" });

		const lines = page.locator('[data-testid="rich-git-diff-line"]');
		const foldedFirstContextLine = page.locator(".rich-git-diff-line-text", { hasText: /^context line 1$/ });
		const initialLineCount = await lines.count();
		await expect(foldedFirstContextLine).toBeHidden();

		const contextToggle = page.locator('[data-testid="rich-git-diff-context-toggle"]').first();
		await expect(contextToggle).toBeVisible();
		await contextToggle.click();

		await expect.poll(async () => await lines.count()).toBeGreaterThan(initialLineCount);
		await expect(foldedFirstContextLine).toBeVisible();
	});

	test("auto mode defaults split on wide screens and inline on narrow screens", async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 720 });
		await gotoAndWait(page);
		await mount(page, { content: MULTI_FILE_DIFF, defaultMode: "auto" });
		await expectMode(page, "split");

		await page.setViewportSize({ width: 500, height: 720 });
		await mount(page, { content: MULTI_FILE_DIFF, defaultMode: "auto" });
		await expectMode(page, "inline");
	});

	test("user-selected mode overrides responsive auto mode across resize", async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 720 });
		await gotoAndWait(page);
		await mount(page, { content: MULTI_FILE_DIFF, defaultMode: "auto" });
		await expectMode(page, "split");

		await page.locator('[data-testid="rich-git-diff-mode-inline"]').click();
		await expectMode(page, "inline");
		await page.setViewportSize({ width: 1100, height: 720 });
		await expectMode(page, "inline");
		await page.setViewportSize({ width: 500, height: 720 });
		await expectMode(page, "inline");
	});

	test("falls back to a raw diff block when unified diff parsing finds no files", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { content: "not a unified diff\njust text", defaultMode: "auto" });

		const raw = page.locator('[data-testid="rich-git-diff-raw"]');
		await expect(raw).toBeVisible();
		await expect(raw).toContainText("not a unified diff");
		await expect(page.locator('[data-testid="rich-git-diff-file"]')).toHaveCount(0);
	});

	test("shows an accessible truncation warning when the server truncation marker is present", async ({ page }) => {
		await gotoAndWait(page);
		await mount(page, { content: TRUNCATED_DIFF, defaultMode: "inline" });

		const warning = page.locator('[data-testid="rich-git-diff-truncated"]');
		await expect(warning).toBeVisible();
		await expect(warning).toHaveAttribute("role", "status");
		await expect(warning).toContainText(/truncated/i);
	});
});
