import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileText } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface GrepParams {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
}

export class GrepRenderer implements ToolRenderer<GrepParams, any> {
	render(params: GrepParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		let headerText: string;
		if (params?.pattern) {
			const parts = [`${i18n("Searching for")} "${params.pattern}"`];
			if (params.path) parts.push(`${i18n("in")} ${params.path}`);
			if (params.glob) parts.push(`(${params.glob})`);
			headerText = parts.join(" ");
		} else {
			headerText = i18n("Searching...");
		}

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
							${renderHeader(state, FileText, headerText)}
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
						${renderCollapsibleHeader(state, FileText, headerText, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<console-block .content=${output}></console-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, FileText, headerText), isCustom: false };
	}
}
