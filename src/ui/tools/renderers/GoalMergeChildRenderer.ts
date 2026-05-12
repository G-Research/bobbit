/**
 * Renderer for `goal_merge_child` — outcome pill + optional conflict block.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { GitMerge } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { DefaultRenderer } from "./DefaultRenderer.js";
import { isSubgoalsEnabled } from "../../../app/subgoals-flag.js";
import { getResult, parseParams } from "./children-renderer-helpers.js";
import "../../../ui/components/ExpandableSection.js";

const fallback = new DefaultRenderer("goal_merge_child");

export class GoalMergeChildRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		if (!isSubgoalsEnabled()) return fallback.render(params, result, isStreaming);

		const state = getToolState(result, isStreaming);
		const fields = parseParams(params) || {};
		const childGoalId: string = fields.childGoalId || fields.goalId || "";
		const childId8 = childGoalId ? childGoalId.slice(0, 8) : "";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, GitMerge, html`Merging child ${childId8 ? html`<span class="font-mono text-xs">${childId8}</span>` : ""}…`)}</div>`,
				isCustom: false,
			};
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, GitMerge, skipped ? "Aborted merge" : "Merge failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const conflict: boolean = !!data?.conflict;
		const alreadyMerged: boolean = !!data?.alreadyMerged;
		const rtmFailed: boolean = !!(data?.rtmFailed || data?.rtmNotPassed);
		const childBranch: string | undefined = data?.childBranch || data?.fromBranch;
		const parentBranch: string | undefined = data?.parentBranch || data?.toBranch;
		const output: string | undefined = data?.output || data?.conflictOutput;

		let pill;
		if (rtmFailed) pill = html`<span class="px-1.5 py-0.5 rounded text-xs font-medium bg-red-500/20 text-red-600 dark:text-red-400" data-testid="children-merge-pill">RTM not passed ✗</span>`;
		else if (conflict) pill = html`<span class="px-1.5 py-0.5 rounded text-xs font-medium bg-amber-500/20 text-amber-600 dark:text-amber-400" data-testid="children-merge-pill">conflict ⚠</span>`;
		else if (alreadyMerged) pill = html`<span class="px-1.5 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground" data-testid="children-merge-pill">already merged</span>`;
		else pill = html`<span class="px-1.5 py-0.5 rounded text-xs font-medium bg-green-500/20 text-green-600 dark:text-green-400" data-testid="children-merge-pill">merged ✓</span>`;

		return {
			content: html`
				<div class="space-y-2">
					<div class="flex items-center gap-2">
						<div class="flex-1 min-w-0">${renderHeader(state, GitMerge, html`Merge child ${childId8 ? html`<span class="font-mono text-xs">${childId8}</span>` : ""}`)}</div>
						${pill}
					</div>
					${childBranch && parentBranch
						? html`<div class="font-mono text-xs text-muted-foreground">${childBranch} → ${parentBranch}</div>`
						: ""}
					${conflict && output
						? html`<expandable-section .summary=${"Conflict output"}><code-block .code=${output} language="text"></code-block></expandable-section>`
						: ""}
				</div>
			`,
			isCustom: false,
		};
	}
}
