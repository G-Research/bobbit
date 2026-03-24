import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Keyboard } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface BrowserTypeParams {
	selector: string;
	text: string;
	clear?: boolean;
}

function truncate(text: string, maxLen = 50): string {
	return text.length > maxLen ? text.slice(0, maxLen) + "\u2026" : text;
}

export class BrowserTypeRenderer implements ToolRenderer<BrowserTypeParams, any> {
	render(
		params: BrowserTypeParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params
			? html`Type into <span class="font-mono">${params.selector}</span>: <span class="font-mono">"${truncate(params.text)}"</span>`
			: "Typing into element...";

		if (result?.isError) {
			const output =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, Keyboard, headerText)}
						<div class="text-sm ${isSkippedToolResult(result) ? 'text-warning' : 'text-destructive'}">${output}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, Keyboard, headerText), isCustom: false };
	}
}
