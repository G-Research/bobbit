/**
 * Renderers for `goal_pause` and `goal_resume` — single-line cards.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { Pause, Play } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { DefaultRenderer } from "./DefaultRenderer.js";
import { isSubgoalsEnabled } from "../../../app/subgoals-flag.js";
import { getResult, parseParams } from "./children-renderer-helpers.js";

function renderPauseResume(
	toolName: string,
	verbStreaming: string,
	verbDone: string,
	iconCmp: any,
	params: any,
	result: ToolResultMessage | undefined,
	isStreaming: boolean | undefined,
): ToolRenderResult {
	const fallback = new DefaultRenderer(toolName);
	if (!isSubgoalsEnabled()) return fallback.render(params, result, isStreaming);

	const state = getToolState(result, isStreaming);
	const fields = parseParams(params) || {};
	const cascade: boolean = !!fields.cascade;
	const cascadeChip = cascade
		? html`<span class="px-1.5 py-0.5 rounded text-xs font-medium bg-muted text-muted-foreground">cascade</span>`
		: "";

	if (!result) {
		return { content: html`<div>${renderHeader(state, iconCmp, html`${verbStreaming}… ${cascadeChip}`)}</div>`, isCustom: false };
	}
	const { data, text } = getResult(result);
	if (result.isError) {
		const skipped = isSkippedToolResult(result);
		return {
			content: html`<div>
				${renderHeader(state, iconCmp, skipped ? `Aborted ${verbStreaming.toLowerCase()}` : `${verbDone} failed`)}
				<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
			</div>`,
			isCustom: false,
		};
	}

	const count: number = Number(
		data?.paused       // POST /pause returns { paused: N }
		?? data?.resumed   // POST /resume returns { resumed: N }
		?? data?.count
		?? data?.pausedCount
		?? data?.resumedCount
		?? data?.affectedCount
		?? (Array.isArray(data?.goalIds) ? data.goalIds.length : 0)
		?? (Array.isArray(data?.ids) ? data.ids.length : 0),
	) || 0;

	return {
		content: html`<div>${renderHeader(state, iconCmp, html`${verbDone} ${count} goal${count === 1 ? "" : "s"} ${cascadeChip}`)}</div>`,
		isCustom: false,
	};
}

export class GoalPauseRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		return renderPauseResume("goal_pause", "Pausing", "Paused", Pause, params, result, isStreaming);
	}
}

export class GoalResumeRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		return renderPauseResume("goal_resume", "Resuming", "Resumed", Play, params, result, isStreaming);
	}
}
