import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Search } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface WebSearchParams {
	query: string;
	maxResults?: number;
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/**
 * Parse the numbered search result format:
 * 1. Title
 *    https://example.com
 *    Snippet text...
 */
function parseSearchResults(text: string): SearchResult[] {
	const results: SearchResult[] = [];
	// Split on numbered entries: "1. ", "2. ", etc.
	const entries = text.split(/(?:^|\n)(?=\d+\.\s)/);

	for (const entry of entries) {
		const trimmed = entry.trim();
		if (!trimmed) continue;

		const lines = trimmed.split("\n").map((l) => l.trim());
		// First line: "N. Title"
		const titleMatch = lines[0]?.match(/^\d+\.\s+(.+)/);
		if (!titleMatch) continue;

		const title = titleMatch[1];
		// Second line: URL
		const url = lines[1] || "";
		// Remaining lines: snippet
		const snippet = lines.slice(2).join(" ").trim();

		if (title && url.startsWith("http")) {
			results.push({ title, url, snippet });
		}
	}
	return results;
}

function renderResultsList(results: SearchResult[]): TemplateResult {
	return html`
		<div class="space-y-2 mt-2">
			${results.map(
				(r) => html`
					<div class="text-sm">
						<a href="${r.url}" target="_blank" rel="noopener" class="text-blue-600 dark:text-blue-400 hover:underline font-medium">${r.title}</a>
						<div class="text-xs text-muted-foreground truncate">${new URL(r.url).hostname}</div>
						${r.snippet ? html`<div class="text-xs text-muted-foreground mt-0.5 line-clamp-2">${r.snippet}</div>` : ""}
					</div>
				`,
			)}
		</div>
	`;
}

export class WebSearchRenderer implements ToolRenderer<WebSearchParams, any> {
	render(
		params: WebSearchParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.query
			? html`Search: <span class="font-mono">${params.query}</span>`
			: "Searching the web...";

		if (result && params) {
			const output =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";

			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();

			// Try to parse into structured results
			const parsed = parseSearchResults(output);

			const resultCount = parsed.length > 0 ? ` (${parsed.length} results)` : "";
			const headerWithCount = html`Search: <span class="font-mono">${params.query}</span><span class="text-muted-foreground">${resultCount}</span>`;

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Search, headerWithCount, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							${result.isError
								? html`<console-block .content=${output} .variant=${"error"}></console-block>`
								: parsed.length > 0
									? renderResultsList(parsed)
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
						${renderCollapsibleHeader(state, Search, headerText, contentRef, chevronRef, true)}
						<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
							<span class="text-sm text-muted-foreground">Querying DuckDuckGo...</span>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, Search, "Searching the web..."), isCustom: false };
	}
}
