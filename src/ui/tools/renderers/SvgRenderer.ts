import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Image } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface SvgWriteParams {
	path: string;
	content: string;
}

/**
 * Sanitize SVG content for safe inline rendering.
 * Strips <script> tags and on* event attributes to prevent XSS,
 * but preserves all visual SVG elements and styles.
 */
function sanitizeSvg(raw: string): string {
	// Remove <script> tags and their content
	let svg = raw.replace(/<script[\s\S]*?<\/script>/gi, "");
	// Remove on* event handler attributes
	svg = svg.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
	return svg;
}

/**
 * Renders SVG files written via the `write` tool inline in the chat.
 * Shows the rendered SVG preview with the source code collapsible underneath.
 */
export class SvgRenderer implements ToolRenderer<SvgWriteParams, any> {
	render(
		params: SvgWriteParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.path ? `SVG ${params.path}` : "SVG";

		// Error state
		if (result?.isError) {
			const output =
				result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || "";
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, Image, headerText)}
						<div class="text-sm ${isSkippedToolResult(result) ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'}">${output}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const svgContent = params?.content || "";
		const hasSvg = svgContent.includes("<svg");

		// No content yet (streaming hasn't delivered the content param)
		if (!hasSvg) {
			return { content: renderHeader(state, Image, headerText), isCustom: false };
		}

		const sanitized = sanitizeSvg(svgContent);

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, Image, headerText, contentRef, chevronRef, false)}
					<div class="mt-3 rounded-lg border border-border bg-white dark:bg-gray-950 p-4 flex items-center justify-center overflow-hidden svg-preview">
						<div class="max-w-full max-h-[400px] [&>svg]:max-w-full [&>svg]:max-h-[400px] [&>svg]:w-auto [&>svg]:h-auto" .innerHTML=${sanitized}></div>
					</div>
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<code-block .code=${svgContent} language="xml"></code-block>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
