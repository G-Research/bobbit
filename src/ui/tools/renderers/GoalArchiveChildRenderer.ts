/**
 * Renderer for `goal_archive_child` — single-line.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { Archive } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { DefaultRenderer } from "./DefaultRenderer.js";
import { isSubgoalsEnabled } from "../../../app/subgoals-flag.js";
import { getResult, parseParams, goalIdChip } from "./children-renderer-helpers.js";

const fallback = new DefaultRenderer("goal_archive_child");

export class GoalArchiveChildRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		if (!isSubgoalsEnabled()) return fallback.render(params, result, isStreaming);

		const state = getToolState(result, isStreaming);
		const fields = parseParams(params) || {};
		const cascade = !!fields.cascade;
		const mergedManually = !!fields.mergedManually;
		const childGoalId: string = fields.childGoalId || fields.goalId || "";
		const cascadeChip = cascade ? html`<span class="px-1.5 py-0.5 rounded text-xs bg-muted text-muted-foreground">cascade</span>` : "";
		const mergedChip = mergedManually ? html`<span class="px-1.5 py-0.5 rounded text-xs bg-green-500/15 text-green-600 dark:text-green-400">merged manually ✓</span>` : "";

		if (!result) {
			return { content: html`<div>${renderHeader(state, Archive, html`Archiving child ${goalIdChip(childGoalId)} ${cascadeChip} ${mergedChip}…`)}</div>`, isCustom: false };
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, Archive, skipped ? "Aborted archive" : "Archive failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const count: number = Number(
			data?.count
			?? data?.archivedCount
			?? data?.affectedCount
			?? (Array.isArray(data?.goalIds) ? data.goalIds.length : 0)
			?? (Array.isArray(data?.ids) ? data.ids.length : 0),
		) || (childGoalId ? 1 : 0);

		return {
			content: html`<div>${renderHeader(state, Archive, html`Archived ${count} goal${count === 1 ? "" : "s"} ${goalIdChip(childGoalId)} ${cascadeChip} ${mergedChip}`)}</div>`,
			isCustom: false,
		};
	}
}
