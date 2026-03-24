import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileCode2 } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface EditParams {
	path: string;
	oldText: string;
	newText: string;
}

interface EditDetails {
	diff?: string;
	firstChangedLine?: number;
}

export class EditRenderer implements ToolRenderer<EditParams, EditDetails> {
	render(params: EditParams | undefined, result: ToolResultMessage<EditDetails> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.path
			? `${i18n("Editing")} ${params.path}`
			: i18n("Editing file...");

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
							${renderHeader(state, FileCode2, headerText)}
							<div class="text-sm ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${output}</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Show diff if available
			const diff = result.details?.diff;
			if (diff) {
				const contentRef = createRef<HTMLDivElement>();
				const chevronRef = createRef<HTMLSpanElement>();
				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, FileCode2, headerText, contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
								<code-block .code=${diff} language="diff"></code-block>
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			return { content: renderHeader(state, FileCode2, headerText), isCustom: false };
		}

		return { content: renderHeader(state, FileCode2, headerText), isCustom: false };
	}
}
