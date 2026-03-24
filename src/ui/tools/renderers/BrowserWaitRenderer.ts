import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Clock } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface BrowserWaitParams {
	selector: string;
	timeout?: number;
}

export class BrowserWaitRenderer implements ToolRenderer<BrowserWaitParams, any> {
	render(
		params: BrowserWaitParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const timeoutStr = params?.timeout ? ` (${params.timeout}ms)` : "";
		const headerText = params?.selector
			? html`Wait for: <span class="font-mono">${params.selector}</span>${timeoutStr}`
			: "Waiting for element...";

		if (result?.isError) {
			const output =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, Clock, headerText)}
						<div class="text-sm ${isSkippedToolResult(result) ? 'text-warning' : 'text-destructive'}">${output}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, Clock, headerText), isCustom: false };
	}
}
