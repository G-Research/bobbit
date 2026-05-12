/**
 * Renderer for `goal_set_policy` — policy + concurrency rows.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Settings2 } from "lucide";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { DefaultRenderer } from "./DefaultRenderer.js";
import { isSubgoalsEnabled } from "../../../app/subgoals-flag.js";
import { getResult, parseParams, policyDescription, concurrencyBar } from "./children-renderer-helpers.js";

const fallback = new DefaultRenderer("goal_set_policy");

export class GoalSetPolicyRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		if (!isSubgoalsEnabled()) return fallback.render(params, result, isStreaming);

		const state = getToolState(result, isStreaming);
		const fields = parseParams(params) || {};
		const divergencePolicy: string | undefined = fields.divergencePolicy;
		const maxConcurrent: number | undefined = typeof fields.maxConcurrentChildren === "number" ? fields.maxConcurrentChildren : undefined;

		if (!result) {
			return { content: html`<div>${renderHeader(state, Settings2, "Updating policy…")}</div>`, isCustom: false };
		}

		const { text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, Settings2, skipped ? "Aborted policy update" : "Policy update failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		return {
			content: html`
				<div class="space-y-1">
					${renderHeader(state, Settings2, "Policy updated")}
					${divergencePolicy
						? html`<div class="flex items-baseline gap-2 text-xs" data-testid="children-policy-row">
							<span class="text-muted-foreground">divergencePolicy:</span>
							<span class="font-medium">${divergencePolicy}</span>
							<span class="text-muted-foreground italic">— ${policyDescription(divergencePolicy)}</span>
						</div>` : ""}
					${typeof maxConcurrent === "number"
						? html`<div class="flex items-center gap-2 text-xs" data-testid="children-concurrency-row">
							<span class="text-muted-foreground">maxConcurrentChildren:</span>
							<span class="font-medium tabular-nums">${maxConcurrent}</span>
							${concurrencyBar(maxConcurrent)}
						</div>` : ""}
				</div>
			`,
			isCustom: false,
		};
	}
}
