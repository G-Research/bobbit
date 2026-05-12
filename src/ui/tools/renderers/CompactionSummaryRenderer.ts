import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, nothing } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { AlertTriangle, Check, PackageOpen, X } from "lucide";
import { renderCollapsibleHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import type { CompactionSummaryPayload } from "../../../app/compaction-types.js";

/**
 * Renderer for the synthetic `__compaction_summary` tool. Theme-token only.
 *
 * Stable test hooks:
 *   data-testid="compaction-summary-card"
 *   data-test="tokens-before|tokens-after|reduction-pct|trigger|verdict"
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
		const state = getToolState(result, isStreaming);
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		if (!payload) {
			return {
				content: html`<div class="text-xs text-muted-foreground">Compacting…</div>`,
				isCustom: false,
			};
		}

		const success = payload.success !== false;
		const headerIcon = success ? PackageOpen : AlertTriangle;
		const triggerLabel = payload.trigger === "auto" ? "auto" : "manual";

		const headerText = html`
			<span>Context compacted</span>
			<span
				class="ml-2 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
				data-test="trigger"
				>${triggerLabel}</span
			>
			<span
				class="ml-1 inline-flex items-center"
				data-test="verdict"
				data-verdict=${success ? "ok" : "fail"}
			>
				${success
					? html`<span class="inline-flex items-center text-green-600 dark:text-green-500"
							>${icon(Check, "sm")}</span
						>`
					: html`<span class="inline-flex items-center text-destructive"
							>${icon(X, "sm")}</span
						>`}
			</span>
		`;

		const reductionBar = (() => {
			if (!success) return nothing;
			const pct = payload.reductionPct;
			if (pct === null || pct === undefined || !Number.isFinite(pct)) return nothing;
			const clamped = Math.max(0, Math.min(100, pct));
			return html`
				<div class="flex items-center gap-2">
					<div
						class="h-1.5 w-32 overflow-hidden rounded"
						style="background: color-mix(in oklch, var(--chart-1) 14%, transparent);"
					>
						<div
							class="h-full rounded"
							style="width: ${clamped}%; background: var(--chart-1);"
						></div>
					</div>
					<span
						class="rounded-full px-2 py-0.5 text-xs font-medium"
						style="background: color-mix(in oklch, var(--chart-1) 14%, transparent); color: var(--chart-1);"
						data-test="reduction-pct"
						>−${pct.toFixed(1)}%</span
					>
				</div>
			`;
		})();

		const body = success
			? html`
					<div class="mt-2 space-y-1.5 text-sm">
						<div class="flex items-center justify-between gap-4">
							<span class="text-xs uppercase tracking-wide text-muted-foreground">before</span>
							<span
								class="font-mono text-foreground"
								data-test="tokens-before"
								>${formatTokens(payload.tokensBefore)} tok</span
							>
						</div>
						<div class="flex items-center justify-between gap-4">
							<span class="text-xs uppercase tracking-wide text-muted-foreground">after</span>
							<span
								class="font-mono ${payload.tokensAfter === null
									? "text-muted-foreground"
									: "text-foreground"}"
								data-test="tokens-after"
								>${payload.tokensAfter === null
									? "—"
									: html`${formatTokens(payload.tokensAfter)} tok`}</span
							>
						</div>
						${reductionBar !== nothing
							? html`<div class="pt-1">${reductionBar}</div>`
							: payload.tokensAfter === null
								? html`<div class="pt-1 text-xs text-muted-foreground">
										reduction unknown
									</div>`
								: nothing}
					</div>
				`
			: html`
					<div class="mt-2 text-sm text-destructive" data-test="error">
						${payload.error || "Compaction failed."}
					</div>
				`;

		const footer = html`
			<div class="mt-2 flex items-center justify-between text-xs text-muted-foreground">
				<span>${formatTime(payload.timestamp)}</span>
			</div>
		`;

		return {
			content: html`
				<div
					data-testid="compaction-summary-card"
					class="rounded-md border border-border bg-card p-3"
				>
					${renderCollapsibleHeader(
						state,
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
						${body} ${footer}
						<details class="mt-2">
							<summary class="cursor-pointer text-xs text-muted-foreground">
								payload
							</summary>
							<pre class="mt-1 overflow-x-auto rounded bg-muted/40 p-2 text-xs">
${JSON.stringify(payload, null, 2)}</pre>
						</details>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}

}
