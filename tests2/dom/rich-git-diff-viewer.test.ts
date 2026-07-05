import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/rich-git-diff-viewer.spec.ts (v2-dom tier).
// Renders the REAL <rich-git-diff-viewer> lit component under happy-dom
// (replacing the esbuild file:// bundle). Responsive auto-mode is driven by
// `window.innerWidth` + a `resize` listener in the component, which happy-dom
// supports — we simulate viewport changes by setting innerWidth and dispatching
// a resize event (the faithful equivalent of Playwright's setViewportSize).
import { afterEach, describe, expect, it } from "vitest";
import "../../src/ui/components/RichGitDiffViewer.js";

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

const ORIGINAL_INNER_WIDTH = window.innerWidth;

afterEach(() => {
	document.body.innerHTML = "";
	setViewport(ORIGINAL_INNER_WIDTH);
});

function setViewport(width: number): void {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
	window.dispatchEvent(new Event("resize"));
}

async function mount(options: {
	content: string;
	title?: string;
	filePath?: string;
	defaultMode?: "auto" | "split" | "inline";
	showCopy?: boolean;
}) {
	const el = document.createElement("rich-git-diff-viewer") as any;
	el.content = options.content;
	if (options.title !== undefined) el.title = options.title;
	if (options.filePath !== undefined) el.filePath = options.filePath;
	if (options.defaultMode !== undefined) el.defaultMode = options.defaultMode;
	if (options.showCopy !== undefined) el.showCopy = options.showCopy;
	document.body.appendChild(el);
	await el.updateComplete;
	return el as HTMLElement;
}

const files = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="rich-git-diff-file"]'));
const lineTexts = (root: ParentNode) => Array.from(root.querySelectorAll(".rich-git-diff-line-text")).map(e => e.textContent);

function expectMode(el: HTMLElement, mode: "split" | "inline") {
	const other = mode === "split" ? "inline" : "split";
	const checked = el.querySelector(`[data-testid="rich-git-diff-mode-${mode}"]`)!;
	const unchecked = el.querySelector(`[data-testid="rich-git-diff-mode-${other}"]`)!;
	expect(checked.getAttribute("role")).toBe("radio");
	expect(checked.getAttribute("aria-checked")).toBe("true");
	expect(unchecked.getAttribute("role")).toBe("radio");
	expect(unchecked.getAttribute("aria-checked")).toBe("false");
}

async function clickMode(el: HTMLElement, mode: "split" | "inline") {
	(el.querySelector(`[data-testid="rich-git-diff-mode-${mode}"]`) as HTMLButtonElement).click();
	await (el as any).updateComplete;
}

describe("RichGitDiffViewer browser fixture", () => {
	it("renders raw multi-file diffs as collapsible file sections with counts and rename paths", async () => {
		const el = await mount({ content: MULTI_FILE_DIFF, defaultMode: "inline" });

		expect(el.querySelector('[data-testid="rich-git-diff-viewer"]')).toBeTruthy();
		const f = files(el);
		expect(f).toHaveLength(2);

		expect(f[0].textContent).toContain("src/alpha.ts");
		const counts0 = f[0].querySelector('[data-testid="rich-git-diff-counts"]')!.textContent || "";
		expect(counts0).toContain("+2");
		expect(counts0).toContain("-1");

		expect(f[1].textContent).toContain("src/old-name.ts");
		expect(f[1].textContent).toContain("src/new-name.ts");
		const counts1 = f[1].querySelector('[data-testid="rich-git-diff-counts"]')!.textContent || "";
		expect(counts1).toContain("+2");
		expect(counts1).toContain("-1");
	});

	it("file collapse toggles update aria-expanded and hide file body lines", async () => {
		const el = await mount({ content: MULTI_FILE_DIFF, defaultMode: "inline" });

		const firstFile = files(el)[0];
		const toggle = firstFile.querySelector('[data-testid="rich-git-diff-file-toggle"]') as HTMLButtonElement;
		const body = firstFile.querySelector(".rich-git-diff-file-body") as HTMLElement;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(body.hasAttribute("hidden")).toBe(false);
		expect(lineTexts(firstFile).some(t => (t || "").includes("new alpha"))).toBe(true);

		toggle.click();
		await (el as any).updateComplete;
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(body.hasAttribute("hidden")).toBe(true);

		toggle.click();
		await (el as any).updateComplete;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(body.hasAttribute("hidden")).toBe(false);
	});

	it("split and inline mode controls expose radio ARIA state and change rendering", async () => {
		setViewport(1000);
		const el = await mount({ content: MULTI_FILE_DIFF, defaultMode: "split" });

		expectMode(el, "split");
		const splitMarkup = files(el)[0].outerHTML;
		expect(lineTexts(el).some(t => (t || "").includes("old alpha"))).toBe(true);

		await clickMode(el, "inline");
		expectMode(el, "inline");
		expect(lineTexts(el).some(t => (t || "").includes("old alpha"))).toBe(true);
		const inlineMarkup = files(el)[0].outerHTML;
		expect(inlineMarkup).not.toBe(splitMarkup);
	});

	it("context expansion reveals folded hunk lines", async () => {
		const el = await mount({ content: LONG_CONTEXT_DIFF, defaultMode: "inline" });

		const initialLineCount = el.querySelectorAll('[data-testid="rich-git-diff-line"]').length;
		// The first context line is folded out of the DOM initially.
		expect(lineTexts(el).some(t => t === "context line 1")).toBe(false);

		const contextToggle = el.querySelector('[data-testid="rich-git-diff-context-toggle"]') as HTMLButtonElement;
		expect(contextToggle).toBeTruthy();
		contextToggle.click();
		await (el as any).updateComplete;

		expect(el.querySelectorAll('[data-testid="rich-git-diff-line"]').length).toBeGreaterThan(initialLineCount);
		expect(lineTexts(el).some(t => t === "context line 1")).toBe(true);
	});

	it("auto mode defaults split on wide screens and inline on narrow screens", async () => {
		setViewport(1024);
		const el = await mount({ content: MULTI_FILE_DIFF, defaultMode: "auto" });
		expectMode(el, "split");

		setViewport(500);
		await (el as any).updateComplete;
		expectMode(el, "inline");
	});

	it("user-selected mode overrides responsive auto mode across resize", async () => {
		setViewport(1024);
		const el = await mount({ content: MULTI_FILE_DIFF, defaultMode: "auto" });
		expectMode(el, "split");

		await clickMode(el, "inline");
		expectMode(el, "inline");

		setViewport(1100);
		await (el as any).updateComplete;
		expectMode(el, "inline");

		setViewport(500);
		await (el as any).updateComplete;
		expectMode(el, "inline");
	});

	it("falls back to a raw diff block when unified diff parsing finds no files", async () => {
		const el = await mount({ content: "not a unified diff\njust text", defaultMode: "auto" });

		const raw = el.querySelector('[data-testid="rich-git-diff-raw"]');
		expect(raw).toBeTruthy();
		expect(raw!.textContent).toContain("not a unified diff");
		expect(files(el)).toHaveLength(0);
	});

	it("shows an accessible truncation warning when the server truncation marker is present", async () => {
		const el = await mount({ content: TRUNCATED_DIFF, defaultMode: "inline" });

		const warning = el.querySelector('[data-testid="rich-git-diff-truncated"]');
		expect(warning).toBeTruthy();
		expect(warning!.getAttribute("role")).toBe("status");
		expect(warning!.textContent || "").toMatch(/truncated/i);
	});
});
