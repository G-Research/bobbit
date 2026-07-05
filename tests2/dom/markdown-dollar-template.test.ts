// Migrated from tests/markdown-dollar-template.spec.ts (v2-dom tier).
// Renders the REAL <markdown-block> lit component under happy-dom, replacing the
// esbuild file:// bundle. Pins the dollar-in-template-literal regression (fenced
// + inline code preserve `^${foo}$`), KaTeX math rendering for the supported
// delimiters, and the link-scheme sanitizer allow/deny list.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { syncCustomElements } from "./_setup/custom-elements.js";

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
const MATH_MARKDOWN = [
	"inline dollar $x$ math",
	"",
	"$$",
	"x^2",
	"$$",
	"",
	"inline latex \\(y\\) math",
	"",
	"\\[",
	"z^2",
	"\\]",
].join("\n");

type LinkSnapshot = { text: string; href: string | null; target: string | null; rel: string | null };
type MarkdownSnapshot = {
	headings: string[];
	paragraphs: string[];
	codeSource: string;
	inlineCode: string;
	links: LinkSnapshot[];
	mathCount: number;
	displayMathCount: number;
	text: string;
	codeIndex: number;
	tailIndex: number;
};

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
	const raf = () => new Promise<void>((resolve) => {
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
		else setTimeout(resolve, 16);
	});
	for (let i = 0; i < 12; i++) {
		if (markdownBlock.updateComplete) await markdownBlock.updateComplete;
		for (const codeBlock of allDeep(markdownBlock.shadowRoot ?? markdownBlock, "code-block") as any[]) {
			if (codeBlock.updateComplete) await codeBlock.updateComplete;
		}
		await raf();
		if (allDeep(markdownBlock.shadowRoot ?? markdownBlock, "h2").length > 0) break;
	}
}

function decodeCodeSource(source: unknown): string {
	if (typeof source !== "string" || source.length === 0) return "";
	try {
		return decodeURIComponent(escape(atob(source)));
	} catch {
		return source;
	}
}

async function renderMarkdown(markdown: string): Promise<MarkdownSnapshot> {
	const container = document.getElementById("container")!;
	container.replaceChildren();
	const markdownBlock = document.createElement("markdown-block") as any;
	markdownBlock.content = markdown;
	container.appendChild(markdownBlock);
	await settle(markdownBlock);

	const root = markdownBlock.shadowRoot ?? markdownBlock;
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
		mathCount: allDeep(root, ".katex").length,
		displayMathCount: allDeep(root, ".katex-display").length,
		text,
		codeIndex: Math.max(text.indexOf("const x"), text.indexOf("^${foo}$")),
		tailIndex: text.lastIndexOf("tail"),
	};
}

beforeAll(async () => {
	// See markdown-throttle.test.ts + _setup/custom-elements.ts: the shared bridge
	// records markdown-block's define and syncCustomElements() replays it into this
	// file's fresh happy-dom window and lit-html's pinned window.
	await import("../../src/ui/lazy/safe-markdown-block.js");
	syncCustomElements();
	if (!document.getElementById("container")) {
		const c = document.createElement("div");
		c.id = "container";
		document.body.appendChild(c);
	}
	await customElements.whenDefined("markdown-block");
});

afterEach(() => { document.getElementById("container")?.replaceChildren(); });

describe("markdown-block dollar template literal regression", () => {
	it("preserves dollar signs inside TypeScript template literals in fenced code", async () => {
		const rendered = await renderMarkdown(REPRO_MARKDOWN);

		expect(rendered.headings).toContain("Header");
		expect(rendered.paragraphs.some((t) => t.includes("lorem ipsum dolor sit amet."))).toBe(true);
		expect(rendered.codeSource, "markdown code block should preserve literal ^${foo}$").toContain("^${foo}$");
		expect(rendered.tailIndex, "markdown trailing tail should remain visible").toBeGreaterThanOrEqual(0);
		expect(rendered.codeIndex, "markdown code block should be visible before trailing tail").toBeGreaterThanOrEqual(0);
		expect(rendered.tailIndex, "markdown trailing tail should render after the code block").toBeGreaterThan(rendered.codeIndex);
	});

	it("preserves dollar signs inside inline code", async () => {
		const rendered = await renderMarkdown(INLINE_CODE_MARKDOWN);
		expect(rendered.inlineCode, "markdown inline code should preserve literal ^${foo}$").toContain("^${foo}$");
	});

	it("renders math outside code for supported delimiters", async () => {
		const rendered = await renderMarkdown(MATH_MARKDOWN);
		expect(rendered.mathCount, "inline and display math should render through KaTeX").toBeGreaterThanOrEqual(4);
		expect(rendered.displayMathCount, "$$...$$ and \\[...\\] should render as display math").toBeGreaterThanOrEqual(2);
		expect(rendered.inlineCode).toBe("");
	});

	it("sanitizes unsafe link schemes", async () => {
		const rendered = await renderMarkdown([
			"[https](https://example.com/path)",
			"[mailto](mailto:test@example.com)",
			"[relative](docs/page.md)",
			"[anchor](#section)",
			"[js](javascript:alert(1))",
			"[data](data:text/html,<b>x</b>)",
			"[vbscript](vbscript:msgbox(1))",
			"[custom](file:///etc/passwd)",
			"[entity-decimal](&#106;avascript:alert(1))",
			"[entity-hex](jav&#x61;script:alert(1))",
			"[entity-control](java&#10;script:alert(1))",
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
		expect(rendered.text).toContain("entity-decimal");
		expect(rendered.text).toContain("entity-hex");
		expect(rendered.text).toContain("entity-control");
	});
});
