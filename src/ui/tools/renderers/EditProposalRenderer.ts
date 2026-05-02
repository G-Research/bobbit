/**
 * Renderer for the `edit_proposal` tool.
 *
 * Shows a compact `old_text \u2192 new_text` diff plus the resulting `rev`.
 * On success, an "Open proposal" button restores the panel to that snapshot.
 * On failure, surfaces the structured error code without a restore button.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { FileText } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { parseRevFromResult, parseErrorCodeFromResult } from "./proposal-rev-marker.js";

function parseParams(params: any): Record<string, any> | null {
	if (!params) return null;
	if (typeof params === "object" && params !== null && !Array.isArray(params)) return params;
	if (typeof params === "string") {
		try { return JSON.parse(params); } catch { return null; }
	}
	return null;
}

function truncate(s: string, max = 120): string {
	if (!s) return "";
	return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

export class EditProposalRenderer implements ToolRenderer {
	render(params: any | undefined, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const fields = parseParams(params) || {};
		const type = typeof fields.type === "string" ? fields.type : "";
		const oldText = typeof fields.old_text === "string" ? fields.old_text : "";
		const newText = typeof fields.new_text === "string" ? fields.new_text : "";
		const rev = parseRevFromResult(result);
		const errorCode = parseErrorCodeFromResult(result);
		const isFailure = !!(result as any)?.isError || (result !== undefined && rev === undefined);

		const openProposal = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			if (typeof rev !== "number" || rev <= 0 || !type) return;
			document.dispatchEvent(new CustomEvent("proposal-open", {
				detail: { type, rev },
			}));
		};

		return {
			content: html`
				<div class="space-y-2">
					${renderHeader(state, FileText, type ? `Edit ${type} draft` : "Edit draft")}
					<div class="text-xs space-y-1 font-mono whitespace-pre-wrap break-words">
						<div><span class="text-red-500">\u2212</span> ${truncate(oldText, 120)}</div>
						<div><span class="text-green-500">+</span> ${truncate(newText, 120)}</div>
					</div>
					${typeof rev === "number" && rev > 0 ? html`
						<div class="text-xs text-muted-foreground" data-testid="proposal-rev">rev ${rev}</div>
					` : ""}
					${isFailure && errorCode ? html`
						<div class="text-xs text-red-500" data-testid="edit-proposal-error-code">${errorCode}</div>
					` : ""}
					${result && typeof rev === "number" && rev > 0 ? html`
						<div class="flex justify-end">
							<button
								@click=${openProposal}
								class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer"
								data-testid="proposal-open-button"
							>
								Open proposal
							</button>
						</div>
					` : ""}
				</div>
			`,
			isCustom: false,
		};
	}
}
