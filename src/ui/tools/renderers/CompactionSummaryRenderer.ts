import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, nothing } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { AlertTriangle, Check, Loader2, PackageOpen, X } from "lucide";
import { renderCollapsibleHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import type {
	CompactionState,
	CompactionSummaryPayload,
	CompactionTrigger,
} from "../../../app/compaction-types.js";

/**
 * Renderer for the synthetic `__compaction_summary` tool. Theme-token only.
 *
 * Renders three lifecycle states (in-progress | complete | error) from a
 * single payload shape. Single DOM identity is provided by the reducer
 * (stable id `compact_active`); the renderer just re-paints the body. See
 * `docs/design/compaction-widget-polish.md` §2.3.
 *
 * Stable test hooks:
 *   data-testid="compaction-summary-card"
 *   data-state="in-progress|complete|error"  (on card root)
 *   data-test="tokens-before|tokens-after|reduction-pct|trigger|verdict|error"
 */

function formatTokens(n: number | null): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "—";
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatTime(iso: string): string {
	try {
		const d = new Date(iso);
		if (!Number.isFinite(d.getTime())) return "";
		return d.toLocaleTimeString();
	} catch {
		return "";
	}
}

function resolveState(payload: CompactionSummaryPayload): CompactionState {
	if (payload.state) return payload.state;
	// Back-compat for payloads persisted before the `state` field existed.
	return payload.success === false ? "error" : "complete";
}

function triggerLabel(trigger: CompactionTrigger): string {
	if (trigger === "overflow") return "context limit";
	if (trigger === "auto") return "auto";
	return "manual";
}

function triggerStyle(trigger: CompactionTrigger): string {
	if (trigger === "overflow") {
		return "background: color-mix(in oklch, var(--warning) 14%, transparent); color: var(--warning);";
	}
	return "background: var(--muted); color: var(--muted-foreground);";
}

export class CompactionSummaryRenderer
	implements ToolRenderer<CompactionSummaryPayload, CompactionSummaryPayload>
{
	render(
		params: CompactionSummaryPayload | undefined,
		result: ToolResultMessage<CompactionSummaryPayload> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const payload: CompactionSummaryPayload | undefined =
			(result?.details as CompactionSummaryPayload | undefined) ?? params;
		const toolState = getToolState(result, isStreaming);
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		if (!payload) {
			return {
				content: html`<div class="text-xs text-muted-foreground">Compacting…</div>`,
				isCustom: false,
			};
		}

		const state = resolveState(payload);
		const trigger = payload.trigger;
		const isInProgress = state === "in-progress";
		const isError = state === "error";
		const isComplete = state === "complete";

		const headerIcon = isInProgress
			? Loader2
			: isError
				? AlertTriangle
				: PackageOpen;
		const headerLabel = isInProgress ? "Compacting context…" : "Context compacted";

		const triggerPill = html`
			<span
				class="ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs"
				style=${triggerStyle(trigger)}
				data-test="trigger"
				>${triggerLabel(trigger)}</span
			>
		`;

		const verdictPill = isInProgress
			? html`<span
					class="ml-1 inline-flex items-center text-muted-foreground"
					data-test="verdict"
					data-verdict="pending"
				>
					${icon(Loader2, "sm", "animate-spin")}
				</span>`
			: isError
				? html`<span
						class="ml-1 inline-flex items-center text-destructive"
						data-test="verdict"
						data-verdict="fail"
					>${icon(X, "sm")}</span>`
				: html`<span
						class="ml-1 inline-flex items-center text-green-600 dark:text-green-500"
						data-test="verdict"
						data-verdict="ok"
					>${icon(Check, "sm")}</span>`;

		const headerText = html`
			<span>${headerLabel}</span>
			${triggerPill}${verdictPill}
		`;

		const tokensBeforeBadge = (label: string) => html`
			<span class="inline-flex items-baseline gap-1.5">
				<span class="text-xs uppercase tracking-wide text-muted-foreground">${label}</span>
				<span class="font-mono ${payload.tokensBefore === null ? "text-muted-foreground" : "text-foreground"}" data-test="tokens-before">
					${payload.tokensBefore === null ? "—" : html`${formatTokens(payload.tokensBefore)} tok`}
				</span>
			</span>
		`;

		const reductionInline = (() => {
			if (!isComplete) return nothing;
			const pct = payload.reductionPct;
			if (pct === null || pct === undefined || !Number.isFinite(pct)) return nothing;
			const clamped = Math.max(0, Math.min(100, pct));
			return html`
				<span class="inline-flex items-center gap-2">
					<span
						class="h-1.5 w-24 overflow-hidden rounded"
						style="background: color-mix(in oklch, var(--chart-1) 14%, transparent);"
					>
						<span
							class="block h-full rounded"
							style="width: ${clamped}%; background: var(--chart-1);"
						></span>
					</span>
					<span
						class="rounded-full px-2 py-0.5 text-xs font-medium"
						style="background: color-mix(in oklch, var(--chart-1) 14%, transparent); color: var(--chart-1);"
						data-test="reduction-pct"
						>−${pct.toFixed(1)}%</span
					>
				</span>
			`;
		})();

		// In-progress body: indeterminate progress bar + (optional) before badge.
		// No payload details disclosure during the active window.
		const inProgressBody = html`
			<div class="mt-3 space-y-3">
				<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
					${payload.tokensBefore !== null ? tokensBeforeBadge("before") : nothing}
				</div>
				<div
					class="h-1.5 w-full overflow-hidden rounded"
					style="background: color-mix(in oklch, var(--chart-1) 14%, transparent);"
					data-test="progress-bar"
				>
					<div
						class="h-full rounded compaction-indeterminate-bar"
						style="background: var(--chart-1);"
					></div>
				</div>
			</div>
		`;

		// Complete body: adjacent label/value pairs in a wrapping inline group.
		const completeBody = html`
			<div class="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
				${tokensBeforeBadge("before")}
				<span class="inline-flex items-baseline gap-1.5">
					<span class="text-xs uppercase tracking-wide text-muted-foreground">after</span>
					<span
						class="font-mono ${payload.tokensAfter === null ? "text-muted-foreground" : "text-foreground"}"
						data-test="tokens-after"
						>${payload.tokensAfter === null ? "—" : html`${formatTokens(payload.tokensAfter)} tok`}</span
					>
				</span>
				${reductionInline !== nothing
					? reductionInline
					: payload.tokensAfter === null
						? html`<span class="text-xs text-muted-foreground">reduction unknown</span>`
						: nothing}
			</div>
		`;

		const errorBody = html`
			<div class="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
				${payload.tokensBefore !== null ? tokensBeforeBadge("before") : nothing}
			</div>
			<div class="mt-2 text-sm text-destructive" data-test="error">
				${payload.error || "Compaction failed."}
			</div>
		`;

		const body = isInProgress
			? inProgressBody
			: isError
				? errorBody
				: completeBody;

		const footer = html`
			<div class="mt-2 flex items-center justify-between text-xs text-muted-foreground">
				<span>${formatTime(payload.timestamp)}</span>
			</div>
		`;

		const payloadDisclosure = isInProgress
			? nothing
			: html`<details class="mt-2">
					<summary class="cursor-pointer text-xs text-muted-foreground">
						payload
					</summary>
					<pre class="mt-1 overflow-x-auto rounded bg-muted/40 p-2 text-xs">
${JSON.stringify(payload, null, 2)}</pre>
				</details>`;

		// One-time scoped style for the indeterminate bar (CSS-only animation).
		// Inlined per-card; the engine de-dups identical <style> blocks.
		const indeterminateStyle = isInProgress
			? html`<style>
					.compaction-indeterminate-bar {
						width: 40%;
						animation: compaction-indeterminate 1.4s ease-in-out infinite;
					}
					@keyframes compaction-indeterminate {
						0%   { margin-left: -40%; }
						50%  { margin-left: 50%; }
						100% { margin-left: 100%; }
					}
				</style>`
			: nothing;

		return {
			content: html`
				<div
					data-testid="compaction-summary-card"
					data-state=${state}
					class="rounded-md border border-border bg-card p-3"
				>
					${indeterminateStyle}
					${renderCollapsibleHeader(
						toolState,
						headerIcon,
						headerText,
						contentRef,
						chevronRef,
						true,
					)}
					<div
						${ref(contentRef)}
						class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300"
					>
						${body} ${footer} ${payloadDisclosure}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}

}
