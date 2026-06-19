import katex from "katex";
import { html, LitElement } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { Marked } from "marked";
import type { Renderer, Tokens } from "marked";
import "@mariozechner/mini-lit/dist/CodeBlock.js";

const katexMode = "html";

const markdownParser = new Marked({
	extensions: [
		{
			name: "inlineMathDollar",
			level: "inline",
			start(src: string) {
				return src.indexOf("$");
			},
			tokenizer(src: string) {
				const match = /^\$([^$\n]+?)\$/s.exec(src);
				if (!match) return undefined;
				return {
					type: "inlineMathDollar",
					raw: match[0],
					text: match[1].trim(),
				};
			},
			renderer(token: { text: string }) {
				return renderMath(token.text, false, `$${token.text}$`);
			},
		},
		{
			name: "blockMathDollar",
			level: "block",
			start(src: string) {
				return src.indexOf("$$");
			},
			tokenizer(src: string) {
				const match = /^\$\$([\s\S]+?)\$\$(?=\n|$)/.exec(src);
				if (!match) return undefined;
				return {
					type: "blockMathDollar",
					raw: match[0],
					text: match[1].trim(),
				};
			},
			renderer(token: { text: string }) {
				return `<div class="my-4">${renderMath(token.text, true, `$$${token.text}$$`)}</div>`;
			},
		},
		{
			name: "inlineMathLatex",
			level: "inline",
			start(src: string) {
				return src.indexOf("\\(");
			},
			tokenizer(src: string) {
				const match = /^\\\(([\s\S]+?)\\\)/.exec(src);
				if (!match) return undefined;
				return {
					type: "inlineMathLatex",
					raw: match[0],
					text: match[1].trim(),
				};
			},
			renderer(token: { text: string }) {
				return renderMath(token.text, false, `\\(${token.text}\\)`);
			},
		},
		{
			name: "blockMathLatex",
			level: "block",
			start(src: string) {
				return src.indexOf("\\[");
			},
			tokenizer(src: string) {
				const match = /^\\\[([\s\S]+?)\\\](?=\n|$)/.exec(src);
				if (!match) return undefined;
				return {
					type: "blockMathLatex",
					raw: match[0],
					text: match[1].trim(),
				};
			},
			renderer(token: { text: string }) {
				return `<div class="my-4">${renderMath(token.text, true, `\\[${token.text}\\]`)}</div>`;
			},
		},
	] as any,
});

export class MarkdownBlock extends LitElement {
	static properties = {
		content: { type: String },
		isThinking: { type: Boolean },
		escapeHtml: { type: Boolean },
	};

	content = "";
	isThinking = false;
	escapeHtml = true;

	createRenderRoot() {
		return this;
	}

	connectedCallback() {
		super.connectedCallback();
		this.classList.add("markdown-content");
		this.style.display = "block";
	}

	render() {
		if (!this.content) return html``;

		const renderer = createRenderer(this.escapeHtml);
		const rendered = markdownParser.parse(this.content, {
			async: false,
			renderer,
		}) as string;
		const containerClasses = this.isThinking
			? "text-muted-foreground italic max-w-none break-words overflow-wrap-anywhere text-sm [&>*:last-child]:!mb-0"
			: "text-foreground max-w-none break-words overflow-wrap-anywhere [&>*:last-child]:!mb-0";

		return html`<div class="${containerClasses}">${unsafeHTML(rendered)}</div>`;
	}
}

function createRenderer(shouldEscapeHtml: boolean): Renderer {
	const renderer = new markdownParser.Renderer();
	const originalLink = renderer.link.bind(renderer);
	const originalTable = renderer.table.bind(renderer);

	renderer.link = function (token: Tokens.Link) {
		const href = sanitizeLinkHref(token.href);
		if (href === null) return escapeHtml(token.text);

		const link = originalLink({ ...token, href }) as string;
		return link.replace("<a ", '<a target="_blank" rel="noopener noreferrer" ');
	};

	renderer.table = function (token: Tokens.Table) {
		const table = originalTable(token) as string;
		return `<div class="overflow-x-auto my-2 border border-border rounded">${table}</div>`;
	};

	renderer.code = function ({ text, lang }: Tokens.Code) {
		const language = firstLanguageToken(lang) ?? "text";
		return `<div class="mt-2"><code-block language="${escapeAttribute(language)}" code="${encodeCode(text)}"></code-block></div>`;
	};

	if (shouldEscapeHtml) {
		renderer.html = function ({ text }: Tokens.HTML | Tokens.Tag) {
			return escapeHtml(text);
		};
	}

	return renderer;
}

function renderMath(math: string, displayMode: boolean, fallback: string): string {
	try {
		return katex.renderToString(math, {
			throwOnError: false,
			displayMode,
			output: katexMode,
		});
	} catch (error) {
		console.error("KaTeX error:", error);
		const classes = displayMode ? "text-red-500 font-mono" : "text-red-500 font-mono";
		return `<span class="${classes}">${escapeHtml(fallback)}</span>`;
	}
}

function firstLanguageToken(lang: string | undefined): string | undefined {
	return lang?.trim().match(/^\S+/)?.[0];
}

function encodeCode(code: string): string {
	return btoa(unescape(encodeURIComponent(code)));
}

function escapeAttribute(value: string): string {
	return escapeHtml(value).replace(/"/g, "&quot;");
}

function sanitizeLinkHref(href: string): string | null {
	const trimmed = href.trim();
	if (!trimmed) return "";

	// The browser decodes HTML character references in attributes before URL
	// resolution and ignores ASCII controls/whitespace while matching schemes.
	// Apply the same normalization before allow-listing so values such as
	// `&#106;avascript:`, `jav&#x61;script:`, and `java&#10;script:` cannot be
	// treated as relative links by the sanitizer and dangerous schemes by the
	// browser.
	const schemeCandidate = decodeHtmlCharacterReferences(trimmed)
		.replace(/[\u0000-\u001F\u007F\s]+/g, "");
	if (schemeCandidate.startsWith("#")) return trimmed;
	if (schemeCandidate.startsWith("//")) return null;

	const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(schemeCandidate);
	if (!schemeMatch) return trimmed;

	const scheme = schemeMatch[1].toLowerCase();
	return scheme === "http" || scheme === "https" || scheme === "mailto" ? trimmed : null;
}

function decodeHtmlCharacterReferences(value: string): string {
	const textarea = document.createElement("textarea");
	textarea.innerHTML = value;
	return textarea.value;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/'/g, "&#39;")
		.replace(/"/g, "&quot;");
}

if (!customElements.get("markdown-block")) {
	customElements.define("markdown-block", MarkdownBlock);
}
