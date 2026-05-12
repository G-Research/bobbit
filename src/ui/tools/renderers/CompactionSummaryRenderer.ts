import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, nothing } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { AlertTriangle, Check, PackageOpen, X } from "lucide";

import { renderCollapsibleHeader, renderHeader, type ToolHeaderState } from "../renderer-registry.js";
import { formatDuration } from "./delegate-cards.js";
import "../../components/LiveTimer.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import type {
	CompactionState,
	CompactionSummaryPayload,
} from "../../../app/compaction-types.js";

/**
 * Renderer for the synthetic `__compaction_summary` tool. Theme-token only.
 *
 * Renders three lifecycle states (in-progress | complete | error) from a
 * single payload shape. Single DOM identity is provided by the reducer
 * (stable id `compact_active`); the renderer just re-paints the body.
 *
 * Visual rules:
 *   - In-progress: standard tool spinner in the header (matches every other
 *     in-progress tool renderer). No progress bar, no separate verdict.
 *   - Complete: green check + before/after/reduction badges.
 *   - Error WITH reduction: amber warning header — the compaction
 *     operation worked, the user just hit the model's limit again on the
 *     retry. Friendlier copy, no scary red.
 *   - Error WITHOUT reduction: destructive — actual compaction failure.
 *
 * Stable test hooks:
 *   data-testid="compaction-summary-card"
 *   data-state="in-progress|complete|error"
 *   data-test="tokens-before|tokens-after|reduction-pct|trigger|verdict|error"
 */

function resolveState(payload: CompactionSummaryPayload): CompactionState {
	if (payload.state) return payload.state;
	return payload.success === false ? "error" : "complete";
}

/**
 * Render the user-facing error message. Filters useless fallbacks
 * ("Unknown error"). Returns null when there's nothing actionable to show.
 * Reached only on hard compaction failures — overflow-trigger compactions
 * are always rendered as complete (the compaction operation itself ran;
 * any retry failure is surfaced via the normal assistant error path).
 */
function friendlyError(payload: CompactionSummaryPayload): string | null {
	const raw = (payload.error || "").trim();
	if (!raw || /^unknown error\.?$/i.test(raw)) return null;
	return raw;
}

export class CompactionSummaryRenderer
	implements ToolRenderer<CompactionSummaryPayload, CompactionSummaryPayload>
{
	render(
		params: CompactionSummaryPayload | undefined,
		result: ToolResultMessage<CompactionSummaryPayload> | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		const payload: CompactionSummaryPayload | undefined =
			(result?.details as CompactionSummaryPayload | undefined) ?? params;
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		if (!payload) {
			return {
				content: html`<div class="text-xs text-muted-foreground">Compacting…</div>`,
				isCustom: false,
			};
		}

		const state = resolveState(payload);
		const isInProgress = state === "in-progress";
		const isError = state === "error";
		const isComplete = state === "complete";
		// Map lifecycle state → header state. Error always means a real hard
		// compaction failure now — overflow recovery is rendered as complete
		// upstream of the renderer (see remote-agent.ts compaction_end handler).
		const headerState: ToolHeaderState = isInProgress
			? "inprogress"
			: isError
				? "error"
				: "complete";

		const headerIcon = isError ? AlertTriangle : PackageOpen;
		const headerLabel = isInProgress
			? "Compacting context…"
			: isError
				? "Compaction failed"
				: "Context compacted";

		// Verdict pill: only shown for terminal states where we want a strong
		// visual cue. In-progress relies on the header spinner. Error-with-
		// reduction (warning) omits the X — the amber header carries enough
		// weight, and an X next to a successful operation is misleading.
		const verdictPill = isComplete
			? html`<span
					class="ml-1 inline-flex items-center text-green-600 dark:text-green-500"
					data-test="verdict"
					data-verdict="ok"
				>${icon(Check, "sm")}</span>`
			: isError
				? html`<span
						class="ml-1 inline-flex items-center text-destructive"
						data-test="verdict"
						data-verdict="fail"
					>${icon(X, "sm")}</span>`
				: nothing;

		// Duration: live ticker while in-progress, static total on terminal.
		// Sits in the header's trailing slot (right-aligned, before the chevron) —
		// matches the metadata-on-the-right convention used by other tool cards.
		const durationPill = (() => {
			if (isInProgress) {
				const startMs = payload.startedAt ? Date.parse(payload.startedAt) : NaN;
				if (!Number.isFinite(startMs)) return nothing;
				return html`<span
					class="text-xs text-muted-foreground tabular-nums"
					title="Elapsed since compaction started"
				><live-timer .startTime=${startMs} .running=${true}></live-timer></span>`;
			}
			if (typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)) {
				return html`<span
					class="text-xs text-muted-foreground tabular-nums"
					title="Total compaction duration"
				>${formatDuration(payload.durationMs)}</span>`;
			}
			return nothing;
		})();

		const headerText = html`
			<span>${headerLabel}</span>
			${verdictPill}
		`;

		const errorLine = (() => {
			const msg = friendlyError(payload);
			if (!msg) return nothing;
			return html`<div class="mt-2 text-sm text-destructive" data-test="error">${msg}</div>`;
		})();

		// Payload disclosure: only useful on hard compaction failures — the
		// case where the user might need raw upstream detail to file a bug.
		const payloadDisclosure = isError
			? html`<details class="mt-2">
					<summary class="cursor-pointer text-xs text-muted-foreground">
						payload
					</summary>
					<pre class="mt-1 overflow-x-auto rounded bg-muted/40 p-2 text-xs">
${JSON.stringify(payload, null, 2)}</pre>
				</details>`
			: nothing;

		// Hard compaction failures get the collapsible card with the error
		// body and payload disclosure. Everything else — in-progress and the
		// (vast majority) success path — collapses to a single header row.
		if (isError) {
			return {
				content: html`
					<div
						data-testid="compaction-summary-card"
						data-state=${state}
						class="rounded-md border border-border bg-card p-3"
					>
						${renderCollapsibleHeader(
							headerState,
							headerIcon,
							headerText,
							contentRef,
							chevronRef,
							true,
							durationPill === nothing ? undefined : durationPill,
						)}
						<div
							${ref(contentRef)}
							class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300"
						>
							${errorLine} ${payloadDisclosure}
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return {
			content: html`
				<div
					data-testid="compaction-summary-card"
					data-state=${state}
					class="rounded-md border border-border bg-card p-3"
				>
					${renderHeader(
						headerState,
						headerIcon,
						headerText,
						durationPill === nothing ? undefined : durationPill,
					)}
				</div>
			`,
			isCustom: false,
		};
	}

}
