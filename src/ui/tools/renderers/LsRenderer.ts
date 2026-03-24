import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { ChevronRight } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface LsParams {
	path?: string;
	limit?: number;
}

export class LsRenderer implements ToolRenderer<LsParams, any> {
	render(params: LsParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.path
			? `${i18n("Listing")} ${params.path}`
			: i18n("Listing directory...");

		if (result) {
			const output = result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";

			if (result.isError) {
				const skipped = isSkippedToolResult(result);
				return {
					content: html`
						<div class="space-y-3">
							${renderHeader(state, ChevronRight, headerText)}
							<div class="text-sm ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${output}</div>
						</div>
					`,
					isCustom: false,
				};
			}

			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, ChevronRight, headerText, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<console-block .content=${output}></console-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, ChevronRight, headerText), isCustom: false };
	}
}
