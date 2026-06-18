import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/markdown-dollar-template.html");
const BUNDLE = path.resolve("tests/fixtures/markdown-dollar-template-bundle.js");
const ENTRY = path.resolve("tests/fixtures/markdown-dollar-template-entry.ts");
const MARKDOWN_SRC = path.resolve("src/ui/lazy/markdown-block.ts");
const SAFE_MARKDOWN_SRC = path.resolve("src/ui/lazy/safe-markdown-block.ts");

const TEST_PAGE = `file://${FIXTURE}`;

const REPRO_MARKDOWN = [
	"## Header",
	"",
	"lorem ipsum dolor sit amet.",
	"",
	"```ts",
	"const x = `^${foo}$`;",
	"```",
	"",
	"tail",
].join("\n");

const INLINE_CODE_MARKDOWN = "inline code: `^${foo}$`";

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, MARKDOWN_SRC, SAFE_MARKDOWN_SRC] });
});

type LinkSnapshot = {
	text: string;
	href: string | null;
	target: string | null;
	rel: string | null;
};

type MarkdownSnapshot = {
	headings: string[];
	paragraphs: string[];
	codeSource: string;
	inlineCode: string;
	links: LinkSnapshot[];
	text: string;
	codeIndex: number;
	tailIndex: number;
};

async function renderMarkdown(page: Page, markdown: string): Promise<MarkdownSnapshot> {
	await page.goto(TEST_PAGE);
	await page.waitForFunction(() => (window as any).__markdownBlockReady === true, null, { timeout: 10_000 });

	return page.evaluate(async (content) => {
		function deepText(node: Node): string {
			if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
			if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return "";

			const el = node as Element;
			if (el.localName === "script" || el.localName === "style") return "";

			const parts: string[] = [];
			if (el instanceof HTMLElement && el.shadowRoot) parts.push(deepText(el.shadowRoot));
			for (const child of Array.from(node.childNodes)) parts.push(deepText(child));
			return parts.join(" ");
		}

		function allDeep(root: ParentNode | Node, selector: string): Element[] {
			const matches: Element[] = [];
			const visit = (node: Node) => {
				if (node.nodeType === Node.ELEMENT_NODE) {
					const el = node as Element;
					if (el.matches(selector)) matches.push(el);
					if (el instanceof HTMLElement && el.shadowRoot) visit(el.shadowRoot);
				}
				for (const child of Array.from(node.childNodes)) visit(child);
			};
			visit(root as Node);
			return matches;
		}

		async function settle(markdownBlock: any): Promise<void> {
			for (let i = 0; i < 8; i++) {
				if (markdownBlock.updateComplete) await markdownBlock.updateComplete;
				for (const codeBlock of allDeep(markdownBlock.shadowRoot ?? markdownBlock, "code-block") as any[]) {
					if (codeBlock.updateComplete) await codeBlock.updateComplete;
				}
				await new Promise((resolve) => requestAnimationFrame(resolve));
				if (allDeep(markdownBlock.shadowRoot ?? markdownBlock, "h2").length > 0) break;
			}
		}

		const container = document.getElementById("container")!;
		container.replaceChildren();
		const markdownBlock = document.createElement("markdown-block") as any;
		markdownBlock.content = content;
		container.appendChild(markdownBlock);
		await settle(markdownBlock);

		const root = markdownBlock.shadowRoot ?? markdownBlock;
		function decodeCodeSource(source: unknown): string {
			if (typeof source !== "string" || source.length === 0) return "";
			try {
				return decodeURIComponent(escape(atob(source)));
			} catch {
				return source;
			}
		}

		const codeBlocks = allDeep(root, "code-block") as any[];
		const preCodes = allDeep(root, "pre code, pre");
		const codeSource = [...codeBlocks, ...preCodes]
			.map((el: any) => [decodeCodeSource(el.code), decodeCodeSource(el.getAttribute?.("code")), deepText(el)].filter(Boolean).join("\n"))
			.join("\n");
		const text = deepText(root).replace(/\s+/g, " ").trim();

		return {
			headings: allDeep(root, "h2").map((el) => deepText(el).replace(/\s+/g, " ").trim()),
			paragraphs: allDeep(root, "p").map((el) => deepText(el).replace(/\s+/g, " ").trim()),
			codeSource,
			inlineCode: allDeep(root, "p code").map((el) => deepText(el).replace(/\s+/g, " ").trim()).join("\n"),
			links: allDeep(root, "a").map((el) => ({
				text: deepText(el).replace(/\s+/g, " ").trim(),
				href: el.getAttribute("href"),
				target: el.getAttribute("target"),
				rel: el.getAttribute("rel"),
			})),
			text,
			codeIndex: Math.max(text.indexOf("const x"), text.indexOf("^${foo}$")),
			tailIndex: text.lastIndexOf("tail"),
		};
	}, markdown);
}

test.describe("markdown-block dollar template literal regression", () => {
	test("preserves dollar signs inside TypeScript template literals in fenced code", async ({ page }) => {
		const rendered = await renderMarkdown(page, REPRO_MARKDOWN);

		expect(rendered.headings).toContain("Header");
		expect(rendered.paragraphs.some((text) => text.includes("lorem ipsum dolor sit amet."))).toBe(true);
		expect(rendered.codeSource, "markdown code block should preserve literal ^${foo}$").toContain("^${foo}$");
		expect(rendered.tailIndex, "markdown trailing tail should remain visible").toBeGreaterThanOrEqual(0);
		expect(rendered.codeIndex, "markdown code block should be visible before trailing tail").toBeGreaterThanOrEqual(0);
		expect(rendered.tailIndex, "markdown trailing tail should render after the code block").toBeGreaterThan(rendered.codeIndex);
	});

	test("preserves dollar signs inside inline code", async ({ page }) => {
		const rendered = await renderMarkdown(page, INLINE_CODE_MARKDOWN);

		expect(rendered.inlineCode, "markdown inline code should preserve literal ^${foo}$").toContain("^${foo}$");
	});

	test("sanitizes unsafe link schemes", async ({ page }) => {
		const rendered = await renderMarkdown(page, [
			"[https](https://example.com/path)",
			"[mailto](mailto:test@example.com)",
			"[relative](docs/page.md)",
			"[anchor](#section)",
			"[js](javascript:alert(1))",
			"[data](data:text/html,<b>x</b>)",
			"[vbscript](vbscript:msgbox(1))",
			"[custom](file:///etc/passwd)",
		].join("\n\n"));

		expect(rendered.links.map((link) => link.text)).toEqual(["https", "mailto", "relative", "anchor"]);
		for (const link of rendered.links) {
			expect(link.target).toBe("_blank");
			expect(link.rel).toBe("noopener noreferrer");
		}
		expect(rendered.links.map((link) => link.href)).toEqual(["https://example.com/path", "mailto:test@example.com", "docs/page.md", "#section"]);
		expect(rendered.text).toContain("js");
		expect(rendered.text).toContain("data");
		expect(rendered.text).toContain("vbscript");
		expect(rendered.text).toContain("custom");
	});
});
