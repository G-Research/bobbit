import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { AppWindow } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface HtmlWriteParams {
	path: string;
	content: string;
}

/**
 * Renders HTML files written via the `write` tool inline in the chat.
 *
 * Completed tool calls use Lit's declarative `.srcdoc` property binding on
 * the iframe — Lit only updates it if the value actually changes, preventing
 * spurious iframe reloads on parent re-renders.
 *
 * Streaming tool calls use imperative `document.open/write/close` via a ref
 * callback, with debounced updates (every 1.5s) to avoid flicker.
 */
export class HtmlRenderer implements ToolRenderer<HtmlWriteParams, any> {
	// ── streaming-only state ──
	private _iframe: HTMLIFrameElement | null = null;
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _pendingContent: string | null = null;
	private _lastAppliedContent: string | null = null;
	private _iframeReady = false;

	private _autoResize(iframe: HTMLIFrameElement) {
		requestAnimationFrame(() => {
			try {
				const doc = iframe.contentDocument;
				const height = Math.min(
					doc?.body?.scrollHeight ? doc.body.scrollHeight + 16 : 300,
					600,
				);
				iframe.style.height = `${height}px`;
			} catch { /* cross-origin fallback */ }
		});
	}

	private _writeToIframe(content: string) {
		const iframe = this._iframe;
		if (!iframe) return;
		try {
			const doc = iframe.contentDocument;
			if (doc) {
				doc.open();
				doc.write(content);
				doc.close();
				this._lastAppliedContent = content;
				this._autoResize(iframe);
			}
		} catch {
			iframe.srcdoc = content;
			this._lastAppliedContent = content;
		}
	}

	private _scheduleUpdate(content: string) {
		this._pendingContent = content;
		if (this._debounceTimer) return;
		this._debounceTimer = setTimeout(() => {
			this._debounceTimer = null;
			if (this._pendingContent && this._pendingContent !== this._lastAppliedContent) {
				this._writeToIframe(this._pendingContent);
				this._pendingContent = null;
			}
		}, 1500);
	}

	/** Reset streaming state so the next tool call starts fresh. */
	private _resetStreamingState() {
		this._iframe = null;
		this._lastAppliedContent = null;
		this._pendingContent = null;
		this._iframeReady = false;
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
	}

	render(
		params: HtmlWriteParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const headerText = params?.path ? `HTML ${params.path}` : "HTML";

		if (result?.isError) {
			const output = result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, AppWindow, headerText)}
						<div class="text-sm ${isSkippedToolResult(result) ? 'text-amber-600 dark:text-amber-400' : 'text-destructive'}">${output}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const htmlContent = params?.content || "";
		const hasHtml = htmlContent.includes("<") && (
			htmlContent.includes("<html") ||
			htmlContent.includes("<body") ||
			htmlContent.includes("<div") ||
			htmlContent.includes("<!DOCTYPE") ||
			htmlContent.includes("<svg")
		);

		if (!hasHtml) {
			return { content: renderHeader(state, AppWindow, headerText), isCustom: false };
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const isComplete = !!result && !result.isError;

		// ── COMPLETED: declarative srcdoc binding ──
		// Lit only updates the .srcdoc property when the value changes,
		// so parent re-renders won't cause iframe reloads.
		if (isComplete) {
			this._resetStreamingState();

			const onLoad = (e: Event) => {
				const iframe = e.target as HTMLIFrameElement;
				this._autoResize(iframe);
			};

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, AppWindow, headerText, contentRef, chevronRef, false)}
						<div class="mt-3 rounded-lg border border-border overflow-hidden" style="position: relative;">
							<iframe
								.srcdoc=${htmlContent}
								sandbox="allow-scripts allow-same-origin"
								@load=${onLoad}
								style="width: 100%; height: 300px; border: none; background: #0c0c1a;"
								title=${params?.path || "HTML preview"}
							></iframe>
						</div>
						<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							<code-block .code=${htmlContent} language="html"></code-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// ── STREAMING: imperative document.write with debouncing ──
		const streamingIframeSetup = (el: Element | undefined) => {
			if (!el) return;
			const iframe = el as HTMLIFrameElement;

			// Same element — skip unless content changed
			if (iframe === this._iframe) {
				if (this._iframeReady && htmlContent !== this._lastAppliedContent) {
					this._scheduleUpdate(htmlContent);
				}
				return;
			}

			// New iframe element — wait for about:blank load then write
			this._iframe = iframe;
			this._iframeReady = false;
			this._lastAppliedContent = null;

			const handler = () => {
				iframe.removeEventListener("load", handler);
				if (this._iframe !== iframe) return; // stale
				this._iframeReady = true;
				this._writeToIframe(htmlContent);
			};
			iframe.addEventListener("load", handler);
		};

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, AppWindow, headerText, contentRef, chevronRef, false)}
					<div class="mt-3 rounded-lg border border-border overflow-hidden" style="position: relative;">
						<iframe
							${ref(streamingIframeSetup)}
							sandbox="allow-scripts allow-same-origin"
							style="width: 100%; height: 300px; border: none; background: #0c0c1a;"
							title=${params?.path || "HTML preview"}
						></iframe>
						<div style="
							position: absolute; inset: 0; z-index: 10;
							background: rgba(10, 10, 20, 0.2);
							display: flex; align-items: center; justify-content: center;
							pointer-events: none;
						">
							<style>
								@keyframes html-renderer-spin {
									to { transform: rotate(360deg); }
								}
							</style>
							<div style="
								width: 20px; height: 20px;
								border: 2px solid rgba(255,255,255,0.15);
								border-top-color: rgba(255,255,255,0.6);
								border-radius: 50%;
								animation: html-renderer-spin 0.8s linear infinite;
							"></div>
						</div>
					</div>
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<code-block .code=${htmlContent} language="html"></code-block>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
