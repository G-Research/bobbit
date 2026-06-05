/**
 * Renderer for `goal_plan_status` — current plan summary + steps grid.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { ListTree } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult, ToolRenderContext } from "../types.js";
import { DefaultRenderer } from "./DefaultRenderer.js";
import { isSubgoalsEnabled } from "../../../app/subgoals-flag.js";
import { getResult, truncate, goalIdChip, resolveGoalId } from "./children-renderer-helpers.js";
import "../../../ui/components/ExpandableSection.js";

const fallback = new DefaultRenderer("goal_plan_status");

let _lazyImported = false;
function ensureLazyPill(): void {
	if (_lazyImported) return;
	_lazyImported = true;
	import("../../lazy/children-goal-state-pill.js").catch(() => { _lazyImported = false; });
}

export class GoalPlanStatusRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, ctx?: ToolRenderContext): ToolRenderResult {
		if (!isSubgoalsEnabled()) return fallback.render(params, result, isStreaming);
		ensureLazyPill();

		const state = getToolState(result, isStreaming);

		if (!result) {
			return { content: html`<div>${renderHeader(state, ListTree, "Reading plan…")}</div>`, isCustom: false };
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, ListTree, skipped ? "Aborted plan status" : "Plan status failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const steps: any[] = Array.isArray(data?.steps) ? data.steps : (Array.isArray(data?.plan?.steps) ? data.plan.steps : []);
		const frozen: boolean = !!(data?.frozen ?? data?.plan?.frozen);
		const replanCount: number = Number(data?.replanCount ?? data?.plan?.replanCount ?? 0);
		const goalId = resolveGoalId(ctx);

		const openPlanTab = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			document.dispatchEvent(new CustomEvent("goal-open-tab", { detail: { goalId, tab: "plan" }, bubbles: true }));
		};

		return {
			content: html`
				<div class="space-y-2">
					<div class="flex items-center justify-between gap-2">
						<div class="flex-1 min-w-0">
							${renderHeader(state, ListTree, html`Plan — ${steps.length} steps · <span class="text-xs">${frozen ? "frozen" : "unfrozen"}</span> · <span class="text-xs">replanCount=${replanCount}</span>`)}
						</div>
						${goalId ? html`<button
							class="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer"
							data-testid="children-plan-open-tab"
							@click=${openPlanTab}
						>View plan tab →</button>` : ""}
					</div>
					${steps.length > 0
						? html`<div class="max-h-60 overflow-auto rounded border border-border/40">
							<div class="grid text-xs" style="grid-template-columns: auto 1fr auto auto; gap: 4px 8px; padding: 4px 8px;">
								${steps.map((s: any) => html`
									<div class="contents" data-testid="children-plan-step-row">
										<div class="text-muted-foreground font-mono">${s.phase ?? ""}</div>
										<div class="font-medium truncate">${truncate(s.title || "", 40)}${s.spec ? html`
											<div class="text-muted-foreground">
												<expandable-section .summary=${truncate(s.spec, 60)}><markdown-block .content=${s.spec}></markdown-block></expandable-section>
											</div>` : ""}
										</div>
										<div class="font-mono">${s.planId || ""}</div>
										<div class="flex items-center gap-1">
											${goalIdChip(s.childGoalId)}
											${s.childGoalId ? html`<children-goal-state-pill goal-id=${s.childGoalId} initial-state=${s.childState || "pending"}></children-goal-state-pill>` : ""}
										</div>
									</div>
								`)}
							</div>
						</div>` : html`<div class="text-xs text-muted-foreground italic">No plan steps.</div>`}
				</div>
			`,
			isCustom: false,
		};
	}
}
