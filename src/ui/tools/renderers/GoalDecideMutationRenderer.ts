/**
 * Renderer for `goal_decide_mutation` — Approved / Rejected pill.
 *
 * Server response shape is `{ applied: boolean }` only today. The "steps diff"
 * mentioned in the goal spec is rendered conditionally only when a future
 * response carries one; currently we surface a muted applied/no-op summary.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { Gavel } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { DefaultRenderer } from "./DefaultRenderer.js";
import { isSubgoalsEnabled } from "../../../app/subgoals-flag.js";
import { getResult, parseParams } from "./children-renderer-helpers.js";

const fallback = new DefaultRenderer("goal_decide_mutation");

export class GoalDecideMutationRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		if (!isSubgoalsEnabled()) return fallback.render(params, result, isStreaming);

		const state = getToolState(result, isStreaming);
		const fields = parseParams(params) || {};
		const decision: string = (fields.decision || "").toLowerCase();
		const requestId: string = fields.requestId || "";
		const reqId8 = requestId ? requestId.slice(0, 8) : "";

		const decisionPill = decision === "approve" || decision === "approved"
			? html`<span class="px-1.5 py-0.5 rounded text-xs font-medium bg-green-500/20 text-green-600 dark:text-green-400">Approved</span>`
			: decision === "reject" || decision === "rejected"
				? html`<span class="px-1.5 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-600 dark:text-red-400">Rejected</span>`
				: html`<span class="px-1.5 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">${decision || "decided"}</span>`;

		if (!result) {
			return { content: html`<div>${renderHeader(state, Gavel, html`Deciding mutation ${reqId8 ? html`<span class="font-mono text-xs">${reqId8}</span>` : ""}…`)}</div>`, isCustom: false };
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, Gavel, skipped ? "Aborted decision" : "Decision failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const applied = !!data?.applied;
		const stepsReplaced: number | undefined = typeof data?.stepsReplaced === "number" ? data.stepsReplaced : undefined;

		return {
			content: html`
				<div class="space-y-1">
					<div class="flex items-center gap-2">
						<div class="flex-1 min-w-0">${renderHeader(state, Gavel, "Mutation decision")}</div>
						${decisionPill}
					</div>
					${reqId8 ? html`<div class="font-mono text-xs text-muted-foreground" title=${requestId}>${reqId8}</div>` : ""}
					<div class="text-xs text-muted-foreground italic">
						${applied
							? (typeof stepsReplaced === "number" ? `Applied — ${stepsReplaced} steps replaced` : "Applied")
							: "No-op"}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
