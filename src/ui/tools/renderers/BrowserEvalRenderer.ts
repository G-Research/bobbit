import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Code } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface BrowserEvalParams {
	expression: string;
}

function truncate(text: string, maxLen = 80): string {
	return text.length > maxLen ? text.slice(0, maxLen) + "\u2026" : text;
}

export class BrowserEvalRenderer implements ToolRenderer<BrowserEvalParams, any> {
	render(
		params: BrowserEvalParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.expression
			? html`Eval: <span class="font-mono">${truncate(params.expression)}</span>`
			: "Evaluating JavaScript...";

		if (result && params) {
			const output =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";

			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Code, headerText, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							${result.isError
								? html`<console-block .content=${output} .variant=${"error"}></console-block>`
								: html`<code-block .code=${output} language="text"></code-block>`}
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, Code, headerText), isCustom: false };
	}
}
