/**
 * Renderer for `goal_plan_propose` — mirrors ProposalRenderer.ts structurally.
 *
 *   - Streams: header pulse + already-complete step rows.
 *   - Result: steps table + classification badge.
 *   - When `requiresApproval` is set: renders <children-mutation-approval>.
 *   - Criteria-drop: red banner.
 *   - Fallback `spawn-children-direct`: spawned list.
 *   - Otherwise applied: green pill.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { ClipboardList } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult, ToolRenderContext } from "../types.js";
import { DefaultRenderer } from "./DefaultRenderer.js";
import { isSubgoalsEnabled } from "../../../app/subgoals-flag.js";
import { getResult, truncate, parseParams, classificationBadge, resolveGoalId } from "./children-renderer-helpers.js";
import { parseRevFromResult } from "./proposal-rev-marker.js";
import "../../../ui/components/ExpandableSection.js";

const fallback = new DefaultRenderer("goal_plan_propose");

let _lazyImported = false;
function ensureLazyApproval(): void {
	if (_lazyImported) return;
	_lazyImported = true;
	import("../../lazy/children-mutation-approval.js").catch(() => { _lazyImported = false; });
}

function renderSteps(steps: any[], streamingTrailer = false) {
	return html`
		<div class="max-h-60 overflow-auto rounded border border-border/40">
			<div class="grid text-xs" style="grid-template-columns: auto 1fr 2fr; gap: 4px 8px; padding: 4px 8px;">
				${steps.map((s: any, i: number) => {
					const phase = s?.phase ?? s?.kind ?? "";
					const title = s?.title || "";
					const spec = s?.spec || s?.description || "";
					return html`
						<div class="contents" data-testid="children-plan-step-row" data-row-index="${i}">
							<div class="text-muted-foreground font-mono">${phase}</div>
							<div class="font-medium truncate">${truncate(title, 60)}</div>
							<div>
								${spec
									? html`<expandable-section .summary=${truncate(spec, 80)}><markdown-block .content=${spec}></markdown-block></expandable-section>`
									: html`<span class="text-muted-foreground italic">(no spec)</span>`}
							</div>
						</div>
					`;
				})}
				${streamingTrailer ? html`
					<div class="contents">
						<div class="text-muted-foreground font-mono">…</div>
						<div class="text-muted-foreground italic">Generating…</div>
						<div></div>
					</div>` : ""}
			</div>
		</div>
	`;
}

export class GoalPlanProposeRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, ctx?: ToolRenderContext): ToolRenderResult {
		if (!isSubgoalsEnabled()) return fallback.render(params, result, isStreaming);

		const state = getToolState(result, isStreaming);
		const fields = parseParams(params) || {};
		const steps: any[] = Array.isArray(fields.steps) ? fields.steps : [];
		const rev = parseRevFromResult(result);

		// Streaming, no result yet — but render any already-streamed steps.
		if (!result) {
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, ClipboardList, "Generating plan proposal…")}
						${steps.length > 0 ? renderSteps(steps, true) : ""}
					</div>
				`,
				isCustom: false,
			};
		}

		const { data, text } = getResult(result);

		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, ClipboardList, skipped ? "Aborted plan proposal" : "Plan proposal failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const classification: string | undefined = data?.classification;
		const requiresApproval = !!data?.requiresApproval;
		const requestId: string | undefined = data?.requestId;
		const applied = !!data?.applied;
		const fallbackKind: string | undefined = data?.fallback;
		const spawned: Array<any> | undefined = data?.spawned;

		const isFallback = fallbackKind === "spawn-children-direct";
		const headerText = isFallback ? "Plan Proposal — fell back to spawn-children-direct" : "Plan Proposal";

		if (requiresApproval && requestId) ensureLazyApproval();
		const goalIdForApproval = resolveGoalId(ctx);

		return {
			content: html`
				<div class="space-y-2">
					<div class="flex items-center justify-between gap-2">
						<div class="flex-1 min-w-0">${renderHeader(state, ClipboardList, headerText)}</div>
						${classificationBadge(classification)}
					</div>
					${steps.length > 0
						? html`<div class="text-xs text-muted-foreground">
							${steps.length} step${steps.length === 1 ? "" : "s"}${typeof rev === "number" && rev > 0 ? html` · rev ${rev}` : ""}
						</div>` : ""}
					${steps.length > 0 ? renderSteps(steps) : ""}
					${classification === "criteria-drop"
						? html`<div class="px-2 py-1.5 rounded text-xs bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/40" data-testid="children-criteria-drop-banner">This plan would drop acceptance criteria — automatically rejected.</div>`
						: ""}
					${requiresApproval && requestId && !applied
						? html`<div data-testid="children-mutation-approval-wrap">
							<children-mutation-approval
								request-id=${requestId}
								goal-id=${goalIdForApproval || ""}
							></children-mutation-approval>
						</div>`
						: ""}
					${applied && !requiresApproval
						? html`<span class="inline-block px-2 py-0.5 rounded bg-green-500/15 text-green-600 dark:text-green-400 text-xs font-medium" data-testid="children-applied-pill">Applied ✓</span>`
						: ""}
					${isFallback && Array.isArray(spawned) && spawned.length > 0
						? html`<div class="text-xs space-y-1" data-testid="children-fallback-list">
							${spawned.map((s: any) => html`
								<div class="flex items-center gap-2">
									<span class="font-mono">${s.planId || "(no planId)"}</span>
									${s.childGoalId ? html`<span class="font-mono text-muted-foreground">${s.childGoalId.slice(0, 8)}</span>` : ""}
									${s.alreadyExists ? html`<span class="text-muted-foreground italic">(existed)</span>` : ""}
									${s.error ? html`<span class="text-destructive">${s.error}</span>` : ""}
								</div>
							`)}
						</div>` : ""}
				</div>
			`,
			isCustom: false,
		};
	}
}
