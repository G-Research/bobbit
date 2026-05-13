/**
 * Renderer for `goal_spawn_child` — spawned-child mini-card with a live
 * goal-state pill.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { GitBranchPlus } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult, ToolRenderContext } from "../types.js";
import { DefaultRenderer } from "./DefaultRenderer.js";
import { isSubgoalsEnabled } from "../../../app/subgoals-flag.js";
import { getResult, truncate, goalIdChip, parseParams } from "./children-renderer-helpers.js";
import "../../../ui/components/ExpandableSection.js";

const fallback = new DefaultRenderer("goal_spawn_child");

let _lazyImported = false;
function ensureLazyPill(): void {
	if (_lazyImported) return;
	_lazyImported = true;
	import("../../lazy/children-goal-state-pill.js").catch(() => { _lazyImported = false; });
}

export class GoalSpawnChildRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, _ctx?: ToolRenderContext): ToolRenderResult {
		if (!isSubgoalsEnabled()) return fallback.render(params, result, isStreaming);
		ensureLazyPill();

		const state = getToolState(result, isStreaming);
		const fields = parseParams(params) || {};
		const title: string = fields.title || "";
		const planId: string = fields.planId || "";
		const workflowId: string = fields.workflowId || "";
		const spec: string = fields.spec || "";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, GitBranchPlus, "Spawning child…")}</div>`,
				isCustom: false,
			};
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, GitBranchPlus, skipped ? "Aborted child spawn" : "Failed to spawn child")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const childGoalId: string | undefined = data?.id || data?.goalId;
		const alreadyExists: boolean = !!data?.alreadyExists;

		const openGoal = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			if (!childGoalId) return;
			document.dispatchEvent(new CustomEvent("goal-open", { detail: { goalId: childGoalId }, bubbles: true }));
			// Defensive fallback: also set the route hash (mirrors goal-dashboard's
			// setHashRoute pattern) in case no listener wires the custom event.
			try {
				if (typeof window !== "undefined") window.location.hash = `#goal-dashboard/${childGoalId}`;
			} catch { /* ignore */ }
		};

		return {
			content: html`
				<div class="space-y-2">
					${renderHeader(state, GitBranchPlus, "Spawned child")}
					${title ? html`<div class="text-sm font-medium" data-testid="children-spawn-title">${title}</div>` : ""}
					<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<span class="px-1.5 py-0.5 rounded bg-muted">${workflowId || "default workflow"}</span>
						${planId ? html`<span class="font-mono" data-testid="children-spawn-planid">${planId}</span>` : ""}
						${goalIdChip(childGoalId)}
						${childGoalId
							? html`<children-goal-state-pill goal-id=${childGoalId} initial-state="pending"></children-goal-state-pill>`
							: ""}
						${childGoalId ? html`<button
							class="ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer"
							data-testid="children-spawn-open-goal"
							@click=${openGoal}
						>Open goal →</button>` : ""}
					</div>
					${alreadyExists ? html`<div class="text-xs text-muted-foreground italic">(idempotent — child already existed)</div>` : ""}
					${spec ? html`<expandable-section .summary=${truncate(spec, 200)}><markdown-block .content=${spec}></markdown-block></expandable-section>` : ""}
				</div>
			`,
			isCustom: false,
		};
	}
}
