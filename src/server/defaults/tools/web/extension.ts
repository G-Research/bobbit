/**
 * Web Research Extension
 *
 * Adds two tools for web research, powered by curl — no API keys needed:
 *   - web_search: Search via DuckDuckGo HTML (no API key, no CAPTCHA)
 *   - web_fetch:  Fetch a URL and extract readable text content
 *
 * Prioritises speed: uses child_process exec with curl rather than
 * a headless browser. Falls back gracefully on errors.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Run curl and return stdout. Throws on non-zero exit or timeout. */
async function curlGet(url: string, signal?: AbortSignal, timeoutSecs = 15): Promise<string> {
	const ac = new AbortController();
	if (signal) signal.addEventListener("abort", () => ac.abort());

	const { stdout } = await execAsync(
		`curl -sL --max-time ${timeoutSecs} -H "User-Agent: ${USER_AGENT}" ${JSON.stringify(url)}`,
		{ maxBuffer: 2 * 1024 * 1024, signal: ac.signal },
	);
	return stdout;
}

// ============================================================================
// HTML helpers
// ============================================================================

function stripHtml(html: string): string {
	let text = html.replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
	text = text.replace(/<!--[\s\S]*?-->/g, " ");
	text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr|blockquote|pre|article|section)\b[^>]*>/gi, "\n");
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<[^>]+>/g, " ");
	text = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\n[ \t]+/g, "\n");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}

/** Parse DuckDuckGo HTML search results page. */
function parseDdgResults(html: string): Array<{ title: string; url: string; snippet: string }> {
	const results: Array<{ title: string; url: string; snippet: string }> = [];

	// Match result blocks — DDG HTML uses class="result__a" for title links
	// and class="result__snippet" for descriptions
	const resultBlocks = html.split(/class="result\s/g).slice(1); // skip preamble

	for (const block of resultBlocks) {
		// Title + URL
		const titleMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
		if (!titleMatch) continue;

		let rawUrl = titleMatch[1];
		const title = stripHtml(titleMatch[2]).trim();

		// DDG wraps URLs in a redirect: //duckduckgo.com/l/?uddg=<encoded>&rut=...
		const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
		if (uddgMatch) {
			rawUrl = decodeURIComponent(uddgMatch[1]);
		}

		// Snippet
		const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
		const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : "";

		if (title && rawUrl.startsWith("http")) {
			results.push({ title, url: rawUrl, snippet });
		}
	}

	return results;
}

// ============================================================================
// Extension
// ============================================================================

const extension: ExtensionFactory = (pi) => {
	// ========================================================================
	// web_search
	// ========================================================================
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using DuckDuckGo. Returns titles, URLs, and snippets. " +
			"No API key needed. Use this when you need current information, documentation, or answers.",
		promptSnippet:
			"web_search: Search the web (DuckDuckGo). Fast, no API key. Returns titles, URLs, snippets.",
		promptGuidelines: [
			"Use web_search when the user asks about something you're unsure of or that requires up-to-date information.",
			"Prefer specific, targeted queries over broad ones.",
			"After searching, use web_fetch to read full page content of the most promising result.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			maxResults: Type.Optional(
				Type.Number({
					description: "Max results to return (default 10)",
					minimum: 1,
					maximum: 20,
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const max = params.maxResults ?? 10;

			const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`;

			let html: string;
			try {
				html = await curlGet(url, signal);
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Search failed: ${e.message}` }],
					details: { query: params.query, resultCount: 0 },
					isError: true,
				} as any;
			}

			const results = parseDdgResults(html).slice(0, max);

			if (results.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No results found." }],
					details: { query: params.query, resultCount: 0 },
				};
			}

			const formatted = results
				.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
				.join("\n\n");

			return {
				content: [{ type: "text" as const, text: formatted }],
				details: { query: params.query, resultCount: results.length },
			};
		},
	});

	// ========================================================================
	// web_fetch
	// ========================================================================
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page via curl and extract readable text. " +
			"Use after web_search to read full content of a specific page.",
		promptSnippet: "web_fetch: Fetch a URL and extract readable text (via curl, fast).",
		promptGuidelines: [
			"Use web_fetch to read full page content after finding relevant URLs via web_search.",
			"For very long pages the output is truncated. Focus on the most relevant URL.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			maxLength: Type.Optional(
				Type.Number({
					description: "Max characters of extracted text to return (default 20000)",
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const maxLen = params.maxLength ?? 20000;

			let parsedUrl: URL;
			try {
				parsedUrl = new URL(params.url);
			} catch {
				return {
					content: [{ type: "text" as const, text: `Invalid URL: ${params.url}` }],
					details: { url: params.url, length: 0 },
					isError: true,
				} as any;
			}

			let raw: string;
			try {
				raw = await curlGet(parsedUrl.href, signal, 20);
			} catch (e: any) {
				return {
					content: [{ type: "text" as const, text: `Fetch failed: ${e.message}` }],
					details: { url: parsedUrl.href, length: 0 },
					isError: true,
				} as any;
			}

			// Detect if it looks like HTML
			let text: string;
			if (/<html[\s>]/i.test(raw) || /<head[\s>]/i.test(raw) || /<body[\s>]/i.test(raw)) {
				text = stripHtml(raw);
			} else {
				text = raw;
			}

			if (text.length > maxLen) {
				text =
					text.slice(0, maxLen) +
					`\n\n[Truncated - ${text.length} chars total, showing first ${maxLen}]`;
			}

			if (!text.trim()) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Page returned no extractable text (may require JavaScript rendering).",
						},
					],
					details: { url: parsedUrl.href, length: 0 },
				};
			}

			return {
				content: [{ type: "text" as const, text }],
				details: { url: parsedUrl.href, length: text.length },
			};
		},
	});
};

export default extension;
