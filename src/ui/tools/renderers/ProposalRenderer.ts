/**
 * Renderer for all propose_* tools.
 * Shows a compact proposal summary card with an "Open proposal" button.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { FileText } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import "../../../ui/components/ExpandableSection.js";
import { parseRevFromResult } from "./proposal-rev-marker.js";
export { parseRevFromResult } from "./proposal-rev-marker.js";

/** Map tool name → display label and proposal type key */
const PROPOSAL_LABELS: Record<string, { label: string; type: string; titleField: string; previewField: string }> = {
	propose_goal: { label: "Goal Proposal", type: "goal", titleField: "title", previewField: "spec" },
	propose_role: { label: "Role Proposal", type: "role", titleField: "name", previewField: "prompt" },
	propose_tool: { label: "Tool Proposal", type: "tool", titleField: "tool", previewField: "content" },
	propose_staff: { label: "Staff Proposal", type: "staff", titleField: "name", previewField: "prompt" },
	propose_project: { label: "Project Proposal", type: "project", titleField: "name", previewField: "root_path" },
};

function truncate(s: string, max = 150): string {
	if (!s) return "";
	return s.length > max ? s.slice(0, max) + "…" : s;
}

function parseParams(params: any): Record<string, any> | null {
	if (!params) return null;
	if (typeof params === "object" && params !== null && !Array.isArray(params)) return params;
	if (typeof params === "string") {
		try { return JSON.parse(params); } catch { return null; }
	}
	return null;
}



export class ProposalRenderer implements ToolRenderer {
	private _toolName: string;

	constructor(toolName?: string) {
		this._toolName = toolName || "propose_goal";
	}

	/** Create a renderer bound to a specific tool name */
	withToolName(name: string): ProposalRenderer {
		return new ProposalRenderer(name);
	}

	render(params: any | undefined, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const meta = PROPOSAL_LABELS[this._toolName] || PROPOSAL_LABELS.propose_goal;
		const fields = parseParams(params);

		// Streaming with no complete fields yet
		if (!fields && isStreaming) {
			return {
				content: html`
					<div>
						${renderHeader(state, FileText, `Generating ${meta.label.toLowerCase()}…`)}
					</div>
				`,
				isCustom: false,
			};
		}

		const title = fields?.[meta.titleField] || "";
		const preview = fields?.[meta.previewField] || "";
		const rev = parseRevFromResult(result);

		// Handler for the "Open proposal" button
		const openProposal = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			const detail: Record<string, unknown> = { type: meta.type };
			if (typeof rev === "number" && rev > 0) {
				detail.rev = rev;
			} else {
				detail.fields = fields || {};
			}
			document.dispatchEvent(new CustomEvent("proposal-open", { detail }));
		};

		return {
			content: html`
				<div class="space-y-2">
					${renderHeader(state, FileText, meta.label)}
					${title ? html`<div class="text-sm font-medium">${title}</div>` : ""}
					${typeof rev === "number" && rev > 0 ? html`<div class="text-xs text-muted-foreground" data-testid="proposal-rev">rev ${rev}</div>` : ""}
					${preview ? html`<expandable-section .summary=${truncate(preview, 80)}><markdown-block .content=${preview}></markdown-block></expandable-section>` : ""}
					${result ? html`
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
