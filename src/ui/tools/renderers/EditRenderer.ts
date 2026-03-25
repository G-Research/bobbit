import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileCode2 } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { HtmlRenderer } from "./HtmlRenderer.js";

interface EditParams {
	path: string;
	oldText: string;
	newText: string;
}

interface EditDetails {
	diff?: string;
	firstChangedLine?: number;
}

const htmlRenderer = new HtmlRenderer();

/** Check if a path is an HTML file. */
function isHtmlFile(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith(".html") || lower.endsWith(".htm");
}

/** Extract active session ID from the URL hash (#/session/{id}). */
function getSessionIdFromHash(): string | undefined {
	const m = window.location.hash.match(/^#\/session\/([a-f0-9-]+)$/i);
	return m?.[1];
}

/** Fetch file content from the gateway for inline HTML preview.
 *  When snapshotId is provided, the server saves a copy so it survives page refresh. */
async function fetchFileContent(sessionId: string, filePath: string, snapshotId?: string): Promise<string | null> {
	try {
		const gwUrl = localStorage.getItem("gateway.url") || window.location.origin;
		const token = localStorage.getItem("gateway.token") || "";
		let url = `${gwUrl}/api/sessions/${sessionId}/file-content?path=${encodeURIComponent(filePath)}`;
		if (snapshotId) url += `&snapshotId=${encodeURIComponent(snapshotId)}`;
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) return null;
		const data = await res.json();
		return data.content ?? null;
	} catch {
		return null;
	}
}

export class EditRenderer implements ToolRenderer<EditParams, EditDetails> {
	/**
	 * Cache of fetched HTML content keyed by file path + tool_call_id.
	 * We key on toolCallId (from result) to avoid stale cache across multiple edits
	 * to the same file.
	 */
	private _htmlContentCache = new Map<string, string>();
	private _fetchInFlight = new Set<string>();

	private _cacheKey(params: EditParams, result: ToolResultMessage<EditDetails>): string {
		return `${params.path}::${result.toolCallId}`;
	}

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

			// For successful HTML file edits, show inline preview
			if (params?.path && isHtmlFile(params.path)) {
				const key = this._cacheKey(params, result);
				const cached = this._htmlContentCache.get(key);
				if (cached) {
					// Delegate to HtmlRenderer for inline iframe preview
					return htmlRenderer.render(
						{ path: params.path, content: cached },
						result,
						false,
					);
				}

				// Kick off async fetch if not already in flight
				if (!this._fetchInFlight.has(key)) {
					const sessionId = getSessionIdFromHash();
					if (sessionId) {
						this._fetchInFlight.add(key);
						fetchFileContent(sessionId, params.path, result.toolCallId).then((content) => {
							this._fetchInFlight.delete(key);
							if (content) {
								this._htmlContentCache.set(key, content);
								// Trigger Lit re-render — requestUpdate on the nearest host element
								document.dispatchEvent(new CustomEvent("bobbit-tool-preview-ready"));
							}
						});
					}
				}
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
