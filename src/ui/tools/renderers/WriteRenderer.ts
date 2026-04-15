import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, nothing } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileCode2 } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { HtmlRenderer } from "./HtmlRenderer.js";
import { SvgRenderer } from "./SvgRenderer.js";

/** Truncation metadata shape injected by the server for large content. */
interface TruncatedContent {
	_truncated: true;
	_originalLength: number;
	preview: string;
}

interface WriteParams {
	path: string;
	content: string | TruncatedContent;
}

function isTruncated(content: unknown): content is TruncatedContent {
	return (
		typeof content === "object" &&
		content !== null &&
		(content as any)._truncated === true
	);
}

/** Format byte size as human-readable string. */
function formatSize(bytes: number): string {
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} bytes`;
}

const svgRenderer = new SvgRenderer();
const htmlRenderer = new HtmlRenderer();

export class WriteRenderer implements ToolRenderer<WriteParams, any> {
	/** Throttled snapshot of code content for the code-block during streaming.
	 *  Updated at most ~4x/sec so hljs.highlight() doesn't run every frame. */
	private _throttledCode = "";
	private _codeThrottleTimer: ReturnType<typeof setTimeout> | null = null;

	private _getThrottledCode(content: string): string {
		if (!this._codeThrottleTimer) {
			this._throttledCode = content;
			this._codeThrottleTimer = setTimeout(() => {
				this._codeThrottleTimer = null;
			}, 250);
		}
		return this._throttledCode;
	}

	render(params: WriteParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		// Delegate .svg files to the SVG renderer for inline preview
		if (params?.path?.toLowerCase().endsWith(".svg")) {
			return svgRenderer.render(params as any, result, isStreaming);
		}

		// Delegate .html/.htm files to the HTML renderer for inline preview
		const lowerPath = params?.path?.toLowerCase() || "";
		if (lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")) {
			return htmlRenderer.render(params as any, result, isStreaming);
		}

		const state = getToolState(result, isStreaming);

		const headerText = params?.path
			? `${i18n("Writing")} ${params.path}`
			: i18n("Writing file...");

		// Detect truncated content
		const truncated = isTruncated(params?.content);
		const displayContent: string | undefined = truncated
			? (params!.content as TruncatedContent).preview
			: (params?.content as string | undefined);
		const originalLength = truncated
			? (params!.content as TruncatedContent)._originalLength
			: undefined;

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
			if (displayContent) {
				const ext = params?.path?.split(".").pop() || "";
				const language = extToLanguage(ext);

				const contentRef = createRef<HTMLDivElement>();
				const chevronRef = createRef<HTMLSpanElement>();

				const truncationBadge = truncated
					? html`
						<div class="flex items-center gap-2 mt-2 mb-1">
							<span class="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
								Content truncated (${formatSize(originalLength!)}) — preview only
							</span>
							<button
								class="text-xs text-primary hover:underline cursor-pointer bg-transparent border-none p-0"
								@click=${(e: Event) => {
									const btn = e.currentTarget as HTMLElement;
									btn.textContent = "Loading...";
									btn.setAttribute("disabled", "");
									btn.dispatchEvent(new CustomEvent("load-full-content", {
										bubbles: true,
										composed: true,
									}));
								}}
							>Load full content</button>
						</div>
					`
					: nothing;

				return {
					content: html`
						<div>
							${renderCollapsibleHeader(state, FileCode2, headerText, contentRef, chevronRef, false)}
							${truncationBadge}
							<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
								<code-block .code=${displayContent} language="${language}"></code-block>
							</div>
						</div>
					`,
					isCustom: false,
				};
			}

			return { content: renderHeader(state, FileCode2, headerText), isCustom: false };
		}

		// Streaming — throttled code preview (~4x/sec) to avoid running
		// hljs.highlight() on every animation frame.
		if (displayContent) {
			const ext = params?.path?.split(".").pop() || "";
			const language = extToLanguage(ext);

			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();

			const truncationBadge = truncated
				? html`<span class="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded ml-2">
					Truncated (${formatSize(originalLength!)})
				</span>`
				: nothing;

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, FileCode2, headerText, contentRef, chevronRef, false)}
						${truncationBadge}
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<code-block .code=${this._getThrottledCode(displayContent)} language="${language}"></code-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return { content: renderHeader(state, FileCode2, headerText), isCustom: false };
	}
}

const langMap: Record<string, string> = {
	ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
	py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
	css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
	md: "markdown", sh: "bash", bash: "bash", sql: "sql", xml: "xml",
};

function extToLanguage(ext: string): string {
	return langMap[ext] || "text";
}
