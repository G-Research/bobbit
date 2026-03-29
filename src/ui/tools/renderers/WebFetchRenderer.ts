import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Globe } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import "./MarkdownWebContent.js";

interface WebFetchParams {
	url: string;
	maxLength?: number;
}

function shortenUrl(url: string, maxLen = 60): string {
	if (url.length <= maxLen) return url;
	try {
		const u = new URL(url);
		const short = u.hostname + u.pathname;
		return short.length > maxLen ? short.slice(0, maxLen) + "\u2026" : short;
	} catch {
		return url.slice(0, maxLen) + "\u2026";
	}
}

function getDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

export function isMarkdownContent(url: string, content: string): boolean {
	// URL-based: path ends with .md or .markdown (case-insensitive, ignoring query/hash)
	try {
		const pathname = new URL(url).pathname.toLowerCase();
		if (pathname.endsWith(".md") || pathname.endsWith(".markdown")) {
			return true;
		}
	} catch {
		// If URL parsing fails, try simple string check
		const pathPart = url.split("?")[0].split("#")[0].toLowerCase();
		if (pathPart.endsWith(".md") || pathPart.endsWith(".markdown")) {
			return true;
		}
	}

	// Content-based fallback: check first 500 chars for markdown patterns
	const sample = content.slice(0, 500);

	// Strong signals: starts with markdown frontmatter or heading
	if (/^---\s*\n/.test(sample)) return true;
	if (/^#{1,6}\s+\S/.test(sample)) return true;

	// Weak signals: require multiple indicators
	let indicators = 0;
	if (/^#{1,6}\s+/m.test(sample)) indicators++;
	if (/\[.+?\]\(.+?\)/.test(sample)) indicators++;
	if (/```/.test(sample)) indicators++;
	if (/^\s*[-*+]\s+/m.test(sample)) indicators++;
	if (/^\s*\d+\.\s+/m.test(sample)) indicators++;
	if (/\*\*.+?\*\*/.test(sample)) indicators++;

	return indicators >= 2;
}

function formatSize(chars: number): string {
	if (chars < 1000) return `${chars} chars`;
	const kb = (chars / 1000).toFixed(1);
	return `${kb}k chars`;
}

export class WebFetchRenderer implements ToolRenderer<WebFetchParams, any> {
	render(
		params: WebFetchParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.url
			? html`Fetch: <a href="${params.url}" target="_blank" rel="noopener" class="font-mono hover:underline">${shortenUrl(params.url)}</a>`
			: "Fetching web page...";

		if (result && params) {
			const output =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";

			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();

			// Build metadata line
			const domain = getDomain(params.url);
			const size = formatSize(output.length);
			const metaText = `${domain} · ${size}`;

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Globe, headerText, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<div class="text-xs text-muted-foreground mt-2 mb-1">${metaText}</div>
							${result.isError
								? html`<console-block .content=${output} .variant=${"error"}></console-block>`
								: isMarkdownContent(params.url, output)
									? html`<markdown-web-content .content=${output}></markdown-web-content>`
									: html`<code-block .code=${output} language="text"></code-block>`}
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		if (params) {
			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Globe, headerText, contentRef, chevronRef, true)}
						<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
							<span class="text-sm text-muted-foreground">Loading ${getDomain(params.url)}...</span>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, Globe, "Fetching web page..."), isCustom: false };
	}
}
