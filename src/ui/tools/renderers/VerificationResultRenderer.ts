/**
 * Renderer for the verification_result tool.
 * Shows verdict badge, markdown summary, and optional HTML report.
 */
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { ClipboardCheck } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function getResult(result: ToolResultMessage | undefined): { text: string; data: any } {
	const text = result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	let data: any = null;
	try { data = JSON.parse(text); } catch { /* not JSON */ }
	return { text, data };
}

function verdictBadge(verdict: string): TemplateResult {
	const isPass = verdict?.toLowerCase() === "pass";
	const cls = isPass
		? "bg-green-500/20 text-green-600 dark:text-green-400"
		: "bg-red-500/20 text-red-600 dark:text-red-400";
	const label = isPass ? "✓ PASS" : "✗ FAIL";
	return html`<span class="px-1.5 py-0.5 rounded text-xs font-medium ${cls}">${label}</span>`;
}

// ── verification_result ──────────────────────────────────────────────

export class VerificationResultRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		// ── Streaming (no result yet) ──
		if (!result) {
			return {
				content: html`<div>
					${renderHeader(state, ClipboardCheck, "Submitting verification…")}
					${params ? html`<div class="mt-2 space-y-2">
						${params.verdict ? html`<div>${verdictBadge(params.verdict)}</div>` : ""}
						${params.summary ? html`<div class="text-sm"><markdown-block .content=${params.summary}></markdown-block></div>` : ""}
						${params.report_html ? html`<div class="text-xs text-muted-foreground italic">HTML report attached</div>` : ""}
					</div>` : ""}
				</div>`,
				isCustom: false,
			};
		}

		// ── Error ──
		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, ClipboardCheck, skipped ? "Aborted verification" : "Verification failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		// ── Complete (success) ──
		const { data, text } = getResult(result);
		const verdict = data?.verdict || params?.verdict || "";
		const summary = data?.summary || params?.summary || text || "";
		const reportHtml = data?.report_html || params?.report_html || "";

		const collapsed = summary.length > 300;
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`<div>
				${renderCollapsibleHeader(
					state,
					ClipboardCheck,
					html`Verification: ${verdictBadge(verdict)}`,
					contentRef,
					chevronRef,
					!collapsed,
				)}
				<div ${ref(contentRef)} class="${collapsed ? "max-h-0" : "max-h-[2000px] mt-3"} overflow-hidden transition-all duration-300">
					<div class="text-sm">
						<markdown-block .content=${summary}></markdown-block>
					</div>
					${reportHtml ? html`
						<details class="mt-3">
							<summary class="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors">View HTML report</summary>
							<iframe
								class="w-full h-[400px] mt-2 rounded border border-border"
								sandbox="allow-scripts"
								.srcdoc=${reportHtml}
							></iframe>
						</details>
					` : ""}
				</div>
			</div>`,
			isCustom: false,
		};
	}
}
