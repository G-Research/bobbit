import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileCode2 } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { HtmlRenderer } from "./HtmlRenderer.js";
import { SvgRenderer } from "./SvgRenderer.js";

interface WriteParams {
	path: string;
	content: string;
}

const svgRenderer = new SvgRenderer();
const htmlRenderer = new HtmlRenderer();

export class WriteRenderer implements ToolRenderer<WriteParams, any> {
	render(params: WriteParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		// Delegate .svg files to the SVG renderer for inline preview
		if (params?.path?.toLowerCase().endsWith(".svg")) {
			return svgRenderer.render(params, result, isStreaming);
		}

		// Delegate .html/.htm files to the HTML renderer for inline preview
		const lowerPath = params?.path?.toLowerCase() || "";
		if (lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")) {
			return htmlRenderer.render(params, result, isStreaming);
		}

		const state = getToolState(result, isStreaming);

		const headerText = params?.path
			? `${i18n("Writing")} ${params.path}`
			: i18n("Writing file...");

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

			// Successful write — collapsible content preview
			if (params?.content) {
				const ext = params.path?.split(".").pop() || "";
				const langMap: Record<string, string> = {
					ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
					py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
					css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
					md: "markdown", sh: "bash", bash: "bash", sql: "sql", xml: "xml",
				};
				const language = langMap[ext] || "text";

				const contentRef = createRef<HTMLDivElement>();
				const chevronRef = createRef<HTMLSpanElement>();
				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, FileCode2, headerText, contentRef, chevronRef, false)}
							<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
								<code-block .code=${params.content} language="${language}"></code-block>
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			return { content: renderHeader(state, FileCode2, headerText), isCustom: false };
		}

		// Streaming — show content being written
		if (params?.content) {
			const ext = params.path?.split(".").pop() || "";
			const langMap: Record<string, string> = {
				ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
				py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
				css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
				md: "markdown", sh: "bash", bash: "bash", sql: "sql", xml: "xml",
			};
			const language = langMap[ext] || "text";

			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, FileCode2, headerText, contentRef, chevronRef, false)}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<code-block .code=${params.content} language="${language}"></code-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, FileCode2, headerText), isCustom: false };
	}
}
