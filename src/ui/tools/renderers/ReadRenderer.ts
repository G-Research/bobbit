import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileText } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderInlineImages } from "./image-utils.js";

interface ReadParams {
	path: string;
	offset?: number;
	limit?: number;
}

export class ReadRenderer implements ToolRenderer<ReadParams, any> {
	render(params: ReadParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.path
			? `${i18n("Reading")} ${params.path}${params.offset ? ` (from line ${params.offset})` : ""}`
			: i18n("Reading file...");

		if (result) {
			const output = result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";
			const images = renderInlineImages(result.content);
			const hasImages = result.content?.some((c: any) => c.type === "image");

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

			// Image read — show header + inline image(s), default expanded
			if (hasImages) {
				const contentRef = createRef<HTMLDivElement>();
				const chevronRef = createRef<HTMLSpanElement>();
				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, FileText, headerText, contentRef, chevronRef, true)}
							<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
								${images}
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Successful text read — collapsible output
			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, FileText, headerText, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<code-block .code=${output} language="text"></code-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, FileText, headerText), isCustom: false };
	}
}
