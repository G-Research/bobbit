import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { Info } from "lucide";
import { ensureMarkdownBlock } from "../../lazy/markdown-block.js";
import { getToolState, isSkippedToolResult, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { parseLspResult, renderLspErrorEnvelope } from "./LspShared.js";

interface HoverParams {
	path: string;
	line: number;
	character: number;
}

export class LspHoverRenderer implements ToolRenderer<HoverParams, any> {
	render(params: HoverParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		ensureMarkdownBlock();
		const state = getToolState(result, isStreaming);
		const pos = params ? `${params.path}:${(params.line ?? 0) + 1}` : "?";
		const headerText = `Hover: ${pos}`;

		if (!result) {
			return { content: renderHeader(state, Info, headerText), isCustom: false };
		}

		const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
		const data = parseLspResult(result);

		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, Info, headerText)}
						<div class="text-sm ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const errEnv = renderLspErrorEnvelope(data);
		if (errEnv) {
			return { content: html`<div>${renderHeader(state, Info, headerText)}${errEnv}</div>`, isCustom: false };
		}

		if (data == null || !data.contents) {
			return {
				content: html`
					<div>
						${renderHeader(state, Info, headerText)}
						<div class="mt-1 text-sm text-muted-foreground italic">No hover info.</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return {
			content: html`
				<div>
					${renderHeader(state, Info, headerText)}
					<div class="mt-2 text-xs bg-muted/50 rounded p-3 border border-border max-h-[400px] overflow-y-auto">
						<markdown-block .content=${data.contents}></markdown-block>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
