import katex from "katex";
import { html, LitElement } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { Marked } from "marked";
import type { Renderer, Tokens } from "marked";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import { gatewayFetch } from "../../app/gateway-fetch.js";

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
		sessionId: { type: String },
	};

	content = "";
	isThinking = false;
	escapeHtml = true;
	/** Enables authenticated local-image resolution for session transcript Markdown. */
	sessionId = "";

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

		const renderer = createRenderer(this.escapeHtml, this.sessionId);
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

function createRenderer(shouldEscapeHtml: boolean, sessionId: string): Renderer {
	const renderer = new markdownParser.Renderer();
	const originalLink = renderer.link.bind(renderer);
	const originalImage = renderer.image.bind(renderer);
	const originalTable = renderer.table.bind(renderer);

	renderer.link = function (token: Tokens.Link) {
		const href = sanitizeLinkHref(token.href);
		if (href === null) return escapeHtml(token.text);

		const link = originalLink({ ...token, href }) as string;
		return link.replace("<a ", '<a target="_blank" rel="noopener noreferrer" ');
	};

	renderer.image = function (token: Tokens.Image) {
		const source = resolveMarkdownImageSource(token.href, sessionId);
		if (!source) return escapeHtml(token.text);
		if (source.kind === "remote") {
			return originalImage({ ...token, href: source.href }) as string;
		}
		const title = token.title ? ` title="${escapeAttribute(token.title)}"` : "";
		return `<session-markdown-image session-id="${escapeAttribute(sessionId)}" image-path="${escapeAttribute(source.path)}" alt="${escapeAttribute(token.text)}"${title}></session-markdown-image>`;
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

export type MarkdownImageSource =
	| { kind: "remote"; href: string }
	| { kind: "local"; path: string };

/** Classify an image destination without ever treating an unsafe scheme as a
 * workspace-relative path. Local paths require an owning session so non-chat
 * Markdown surfaces cannot accidentally gain filesystem access. */
export function resolveMarkdownImageSource(href: string, sessionId: string): MarkdownImageSource | null {
	const trimmed = href.trim();
	if (!trimmed) return null;
	const decoded = decodeHtmlCharacterReferences(trimmed);
	if (/[\u0000-\u001F\u007F]/.test(decoded) || decoded.startsWith("//") || decoded.startsWith("#")) return null;
	if (/^https?:/i.test(decoded)) return { kind: "remote", href: trimmed };
	if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(decoded)) {
		return { kind: "remote", href: trimmed };
	}
	const windowsAbsolute = /^[a-z]:[\\/]/i.test(decoded);
	const schemeMatch = /^([a-z][a-z\d+.-]*):/i.exec(decoded);
	if (schemeMatch && schemeMatch[1].toLowerCase() !== "file" && !windowsAbsolute) return null;
	if (!sessionId) return null;
	return { kind: "local", path: decoded };
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

class SessionMarkdownImage extends LitElement {
	static properties = {
		sessionId: { type: String, attribute: "session-id" },
		imagePath: { type: String, attribute: "image-path" },
		alt: { type: String },
		title: { type: String },
		_objectUrl: { state: true },
		_error: { state: true },
	};

	sessionId = "";
	imagePath = "";
	alt = "";
	title = "";
	private _objectUrl = "";
	private _error = false;
	private _requestGeneration = 0;
	private _abort?: AbortController;
	private _visibilityObserver?: IntersectionObserver;

	createRenderRoot() {
		return this;
	}

	connectedCallback() {
		super.connectedCallback();
		this.style.display = "block";
		// Lit does not call updated() merely because an existing element was
		// detached and reattached. Restart visibility observation on reconnect.
		if (this.hasUpdated && !this._objectUrl) this._loadWhenVisible();
	}

	protected updated(changed: Map<PropertyKey, unknown>) {
		if (changed.has("sessionId") || changed.has("imagePath")) {
			this._abort?.abort();
			this._revokeObjectUrl();
			this._error = false;
			this._loadWhenVisible();
		}
	}

	disconnectedCallback() {
		this._visibilityObserver?.disconnect();
		this._visibilityObserver = undefined;
		this._abort?.abort();
		this._revokeObjectUrl();
		super.disconnectedCallback();
	}

	private _loadWhenVisible() {
		this._visibilityObserver?.disconnect();
		this._visibilityObserver = undefined;
		if (!this.isConnected || !this.sessionId || !this.imagePath) return;
		if (typeof IntersectionObserver !== "function") {
			void this._load();
			return;
		}
		this._visibilityObserver = new IntersectionObserver((entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			this._visibilityObserver?.disconnect();
			this._visibilityObserver = undefined;
			void this._load();
		}, { rootMargin: "400px 0px" });
		this._visibilityObserver.observe(this);
	}

	private _revokeObjectUrl() {
		if (!this._objectUrl) return;
		URL.revokeObjectURL(this._objectUrl);
		this._objectUrl = "";
	}

	private async _load() {
		const generation = ++this._requestGeneration;
		this._abort?.abort();
		this._abort = new AbortController();
		this._revokeObjectUrl();
		this._error = false;
		if (!this.sessionId || !this.imagePath) return;
		try {
			const response = await gatewayFetch(
				`/api/sessions/${encodeURIComponent(this.sessionId)}/markdown-image?path=${encodeURIComponent(this.imagePath)}`,
				{ signal: this._abort.signal },
			);
			if (!response.ok) throw new Error(`Image request failed (${response.status})`);
			const contentType = response.headers.get("content-type")?.split(";", 1)[0].toLowerCase() ?? "";
			if (!/image\/(?:png|jpeg|gif|webp)/.test(contentType)) throw new Error("Unsupported image response");
			const blob = await response.blob();
			if (generation !== this._requestGeneration || this._abort.signal.aborted) return;
			this._objectUrl = URL.createObjectURL(blob);
			this.requestUpdate();
		} catch (error) {
			if (generation !== this._requestGeneration || this._abort.signal.aborted) return;
			this._error = true;
			this.requestUpdate();
		}
	}

	render() {
		if (this._objectUrl) {
			return html`<img
				src=${this._objectUrl}
				alt=${this.alt}
				title=${this.title || this.alt}
				loading="lazy"
				decoding="async"
				class="max-w-full h-auto rounded border border-border"
				data-testid="session-markdown-image"
			/>`;
		}
		if (this._error) return html`<span class="text-muted-foreground text-sm">${this.alt || "Image unavailable"}</span>`;
		return html`<span class="text-muted-foreground text-sm">Loading ${this.alt || "image"}…</span>`;
	}
}

if (!customElements.get("session-markdown-image")) {
	customElements.define("session-markdown-image", SessionMarkdownImage);
}
if (!customElements.get("markdown-block")) {
	customElements.define("markdown-block", MarkdownBlock);
}
