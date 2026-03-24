import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Globe } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderInlineImages } from "./image-utils.js";

interface BrowserNavigateParams {
	url: string;
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

export class BrowserNavigateRenderer implements ToolRenderer<BrowserNavigateParams, any> {
	render(
		params: BrowserNavigateParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.url
			? html`Navigate: <a href="${params.url}" target="_blank" rel="noopener" class="font-mono hover:underline">${shortenUrl(params.url)}</a>`
			: "Navigating browser...";

		if (result) {
			if (result.isError) {
				const output =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n") || "";
				return {
					content: html`
						<div class="space-y-2">
							${renderHeader(state, Globe, headerText)}
							<div class="text-sm ${isSkippedToolResult(result) ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'}">${output}</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Show page title if present in the result text
			const output =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";

			const images = renderInlineImages(result.content);
			const hasImages = result.content?.some((c: any) => c.type === "image");

			// Extract page title from output if available
			const titleMatch = output.match(/title[:\s]*["']?([^"'\n]+)/i);
			const pageTitle = titleMatch?.[1]?.trim();

			return {
				content: html`
					<div>
						${renderHeader(state, Globe, headerText)}
						${pageTitle ? html`<div class="text-xs text-muted-foreground mt-1 ml-7">${pageTitle}</div>` : ""}
						${hasImages ? html`<div class="mt-2">${images}</div>` : ""}
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, Globe, headerText), isCustom: false };
	}
}
