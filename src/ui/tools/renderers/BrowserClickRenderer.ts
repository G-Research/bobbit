import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { MousePointerClick } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface BrowserClickParams {
	selector: string;
}

export class BrowserClickRenderer implements ToolRenderer<BrowserClickParams, any> {
	render(
		params: BrowserClickParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.selector
			? html`Click: <span class="font-mono">${params.selector}</span>`
			: "Clicking element...";

		if (result?.isError) {
			const output =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, MousePointerClick, headerText)}
						<div class="text-sm ${isSkippedToolResult(result) ? 'text-warning' : 'text-destructive'}">${output}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, MousePointerClick, headerText), isCustom: false };
	}
}
