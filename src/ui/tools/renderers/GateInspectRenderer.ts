/**
 * Renderer for the gate_inspect tool.
 * Handles three section types: content, verification, signals.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { createRef, ref } from "lit/directives/ref.js";
import { ShieldCheck } from "lucide";
import { ensureMarkdownBlock } from "../../lazy/markdown-block.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderContext, ToolRenderResult } from "../types.js";
import { getResult, gateBadge } from "./GateToolRenderers.js";
import { ansiToHtml, hasAnsi } from "../../utils/ansi.js";
import "../../components/SignoffReviewLauncher.js";

// ── Helpers ──────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
	if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
	return `${(ms / 1000).toFixed(1)}s`;
}

const STATUS_LABELS: Record<string, string> = {
	passed: "passed",
	failed: "failed",
	timeout: "timed out",
	skipped: "skipped",
	running: "running",
	waiting: "waiting",
	blocked: "blocked",
};

function normalizeStatus(status: unknown): string | undefined {
	if (typeof status !== "string") return undefined;
	const key = status.toLowerCase().replace(/_/g, "-");
	if (key === "passed" || key === "success" || key === "completed") return "passed";
	if (key === "timeout") return "timeout";
	if (key === "failed" || key === "failure" || key === "error") return "failed";
	if (key === "skipped") return "skipped";
	if (key === "running" || key === "in-progress" || key === "starting") return "running";
	if (key === "waiting" || key === "pending" || key === "queued" || key === "yet-to-run") return "waiting";
	if (key === "blocked" || key === "blocked-by-earlier-failure") return "blocked";
	return undefined;
}

function stepStatusIcon(status: string): TemplateResult {
	if (status === "passed") return html`<span class="text-green-600 dark:text-green-400">✓</span>`;
	if (status === "failed") return html`<span class="text-red-600 dark:text-red-400">✗</span>`;
	if (status === "timeout") return html`<span data-timeout-icon title="Timed out" class="text-warning">⏱</span>`;
	if (status === "skipped") return html`<span class="text-muted-foreground">⊘</span>`;
	if (status === "waiting") return html`<span class="text-muted-foreground">○</span>`;
	if (status === "blocked") return html`<span class="text-muted-foreground">—</span>`;
	return html`<span class="text-blue-600 dark:text-blue-400">●</span>`;
}

function stepStatusClass(status: string): string {
	if (status === "passed") return "bg-green-500/15 text-green-700 dark:text-green-300";
	if (status === "failed") return "bg-red-500/15 text-red-700 dark:text-red-300";
	if (status === "timeout") return "bg-warning/15 text-warning";
	if (status === "running") return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
	return "bg-muted text-muted-foreground";
}

function deriveStepStatus(step: any): string {
	const explicitStatus = normalizeStatus(step?.status);
	if (explicitStatus) return explicitStatus;
	if (step.skipped) return "skipped";
	if (step.passed === true) return "passed";
	if (step.passed === false) return "failed";
	return "running";
}

function shouldShowDuration(status: string, durationMs: unknown): durationMs is number {
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) return false;
	if ((status === "waiting" || status === "blocked" || status === "skipped") && durationMs <= 0) return false;
	return status === "running" || status === "passed" || status === "failed" || status === "timeout" || durationMs > 0;
}

function timeoutInfo(value: unknown): { configuredSeconds: number; elapsedMs: number } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const marker = value as { configuredSeconds?: unknown; elapsedMs?: unknown };
	if (typeof marker.configuredSeconds !== "number" || !Number.isFinite(marker.configuredSeconds) || marker.configuredSeconds <= 0) return undefined;
	if (typeof marker.elapsedMs !== "number" || !Number.isFinite(marker.elapsedMs) || marker.elapsedMs < 0) return undefined;
	return { configuredSeconds: marker.configuredSeconds, elapsedMs: marker.elapsedMs };
}

function formatTimeoutTiming(timeout: { configuredSeconds: number; elapsedMs: number }): string {
	return `${(timeout.elapsedMs / 1000).toFixed(1)}s elapsed · ${timeout.configuredSeconds}s limit`;
}

function formatCountSummary(counts: Record<string, unknown> | undefined): string {
	if (!counts) return "";
	const order = ["passed", "failed", "timeout", "running", "waiting", "blocked", "skipped"];
	return order
		.map((status) => {
			const value = Number(counts[status] ?? 0);
			return value > 0 ? `${value} ${STATUS_LABELS[status]}` : "";
		})
		.filter(Boolean)
		.join(", ");
}

function verificationSummary(data: any, steps: any[]): string {
	const counts = data?.statusCounts || data?.counts || data?.summary?.counts;
	const explicitSummary = formatCountSummary(counts);
	if (explicitSummary) return explicitSummary;
	if (steps.length === 0 && typeof data?.summary === "string") return data.summary;
	const derivedCounts: Record<string, number> = {};
	for (const step of steps) {
		const status = deriveStepStatus(step);
		derivedCounts[status] = (derivedCounts[status] || 0) + 1;
	}
	return formatCountSummary(derivedCounts);
}

function hasArg(value: unknown): boolean {
	return value !== undefined && value !== null && String(value) !== "";
}

function primarySelection(data: any): any {
	if (data?.selection?.mode) return data.selection;
	const steps = Array.isArray(data?.steps) ? data.steps : [];
	return steps.find((step: any) => step?.selection)?.selection ?? data?.selection;
}

function formatRange(from: unknown, to: unknown): string | undefined {
	if (!hasArg(from) && !hasArg(to)) return undefined;
	return `${hasArg(from) ? from : "?"}–${hasArg(to) ? to : "?"}`;
}

function ellipsize(value: unknown, max = 40): string {
	const text = String(value);
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatInspectArgSummary(params: any, data?: any, opts?: { truncatePattern?: boolean }): string {
	const selection = primarySelection(data);
	const range = selection?.range;
	const parts: string[] = [];

	if (hasArg(params?.step)) parts.push(`step ${params.step}`);
	if (hasArg(params?.signal_index) && params?.section !== "signals") parts.push(`signal ${params.signal_index}`);

	const mode = typeof params?.mode === "string"
		? params.mode
		: typeof selection?.mode === "string"
			? selection.mode
			: undefined;

	if (mode === "grep" || (!mode && hasArg(params?.pattern))) {
		const patternValue = opts?.truncatePattern ? ellipsize(params.pattern) : String(params.pattern);
		const pattern = hasArg(params?.pattern) ? ` ${JSON.stringify(patternValue)}` : "";
		parts.push(`grep${pattern}`);
		if (hasArg(params?.context)) parts.push(`ctx ${params.context}`);
		const maxResults = params?.max_results ?? params?.maxResults;
		if (hasArg(maxResults)) parts.push(`max ${maxResults}`);
	} else if (mode === "slice") {
		parts.push(`slice ${formatRange(params?.from ?? range?.from, params?.to ?? range?.to) ?? "range"}`);
	} else if (mode === "head" || mode === "tail") {
		const selectedRange = formatRange(range?.from, range?.to);
		if (selectedRange) parts.push(`${mode} ${selectedRange}`);
		else if (hasArg(params?.lines)) parts.push(`${mode} ${params.lines} lines`);
		else parts.push(mode);
	} else if (mode === "full") {
		parts.push("full");
	} else if (hasArg(params?.lines)) {
		parts.push(`tail ${params.lines} lines`);
	}

	return parts.join(" · ");
}

function renderArgSummary(summary: string, tooltip = summary): TemplateResult | typeof nothing {
	if (!summary) return nothing;
	return html`<span
		class="block max-w-full truncate rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground sm:max-w-[45vw]"
		title=${tooltip}
	>${summary}</span>`;
}

function renderInspectHeader(
	state: any,
	text: string | TemplateResult,
	argSummary: string,
	argTooltip = argSummary,
): TemplateResult {
	return html`<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
		<div class="min-w-0 flex-1 basis-full xl:basis-auto">${renderHeader(state, ShieldCheck, text)}</div>
		${argSummary ? html`<div class="min-w-0 max-w-full shrink basis-full xl:ml-auto xl:basis-auto xl:max-w-[45vw]">${renderArgSummary(argSummary, argTooltip)}</div>` : nothing}
	</div>`;
}

// ── Renderer ─────────────────────────────────────────────────────────

export class GateInspectRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean, ctx?: ToolRenderContext): ToolRenderResult {
		ensureMarkdownBlock();
		const state = getToolState(result, isStreaming);
		const gateId = params?.gate_id || "gate";
		const initialArgSummary = formatInspectArgSummary(params, undefined, { truncatePattern: true });
		const initialArgTooltip = formatInspectArgSummary(params);

		// Loading state
		if (!result) {
			return {
				content: html`<div>${renderInspectHeader(state, html`Inspecting gate <span class="font-mono">${gateId}</span>…`, initialArgSummary, initialArgTooltip)}</div>`,
				isCustom: false,
			};
		}

		// Error/skipped state
		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			const headerText = skipped
				? html`Aborted inspect of gate <span class="font-mono">${gateId}</span>`
				: html`Failed to inspect gate <span class="font-mono">${gateId}</span>`;
			return {
				content: html`<div>
					${renderInspectHeader(state, headerText, initialArgSummary, initialArgTooltip)}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const section = data?.section || params?.section || "content";
		const argSummary = formatInspectArgSummary(params, data, { truncatePattern: true });
		const argTooltip = formatInspectArgSummary(params, data);

		switch (section) {
			case "content": return this._renderContent(state, gateId, data, argSummary, argTooltip);
			case "verification": return this._renderVerification(state, gateId, data, ctx?.goalId, argSummary, argTooltip);
			case "signals": return this._renderSignals(state, gateId, data, argSummary, argTooltip);
			default: return this._renderContent(state, gateId, data, argSummary, argTooltip);
		}
	}

	// ── section="content" ────────────────────────────────────────────

	private _renderContent(state: any, gateId: string, data: any, argSummary: string, argTooltip: string): ToolRenderResult {
		const signalIndex = data?.signalIndex ?? "?";
		const signalId = data?.signalId || "";
		const content = data?.text;

		return {
			content: html`<div>
				${renderInspectHeader(state, html`Inspect gate <span class="font-mono">${gateId}</span> — content`, argSummary, argTooltip)}
				<div class="text-xs text-muted-foreground mt-1">Signal #${signalIndex}${signalId ? html` · ${signalId}` : nothing}</div>
				${content
					? html`<div class="mt-2 text-xs bg-muted/50 rounded p-3 border border-border max-h-[400px] overflow-y-auto"><markdown-block .content=${content}></markdown-block></div>`
					: html`<div class="mt-2 text-xs text-muted-foreground italic">No content</div>`
				}
			</div>`,
			isCustom: false,
		};
	}

	// ── section="verification" ───────────────────────────────────────

	private _renderVerification(state: any, gateId: string, data: any, goalId: string | undefined, argSummary: string, argTooltip: string): ToolRenderResult {
		const signalIndex = data?.signalIndex ?? "?";
		const signalId = data?.signalId || "";
		const steps: any[] = data?.steps || [];
		const summary = verificationSummary(data, steps);
		const overallStatus = normalizeStatus(data?.status);
		const overallLabel = overallStatus === "passed" ? "Passed" : overallStatus === "failed" || overallStatus === "timeout" ? "Failed" : undefined;

		const toggleStep = (e: Event) => {
			const card = (e.currentTarget as HTMLElement).parentElement!;
			const output = card.querySelector('[data-step-output]') as HTMLElement;
			const chevron = card.querySelector('[data-step-chevron]') as HTMLElement;
			if (!output) return;
			const isHidden = output.classList.contains('hidden');
			output.classList.toggle('hidden');
			if (chevron) chevron.textContent = isHidden ? '▴' : '▾';
		};

		return {
			content: html`<div>
				${renderInspectHeader(state, html`Inspect gate <span class="font-mono">${gateId}</span> — verification`, argSummary, argTooltip)}
				<div class="text-xs text-muted-foreground mt-1">
					Signal #${signalIndex}${signalId ? html` · ${signalId}` : nothing}
					${overallLabel ? html` · <span class=${overallStatus === "passed" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}>${overallLabel}</span>` : nothing}
					${summary ? html` · ${summary}` : nothing}
				</div>
				<div class="mt-2 space-y-1">
					${steps.map((step: any, _i: number) => {
						const status = deriveStepStatus(step);
						const hasOutput = !!step.output;
						const isFailed = status === "failed" || status === "timeout";
						const marker = status === "timeout" ? timeoutInfo(step.timeout) : undefined;
						const statusLabel = status === "timeout" ? "Timed out" : (STATUS_LABELS[status] || status);
						const canChangeTimeout = !!marker && !!goalId && typeof step.name === "string" && !!step.name;
						const canStartReview = step.type === "human-signoff"
							&& step.awaitingHuman === true
							&& !!goalId
							&& !!signalId
							&& typeof step.name === "string"
							&& !!step.name;
						const reviewTarget = canStartReview ? {
							goalId,
							gateId,
							signalId,
							stepName: step.name,
							...(typeof step.humanLabel === "string" && step.humanLabel ? { stepLabel: step.humanLabel } : {}),
						} : undefined;
						const typeBadgeCls = step.type === "command"
							? "bg-muted text-muted-foreground"
							: "bg-purple-500/20 text-purple-600 dark:text-purple-400";

						return html`
							<div class="border border-border rounded text-sm">
								<div
									class="p-2 flex items-center gap-2 ${hasOutput ? "cursor-pointer hover:bg-accent/50" : ""}"
									@click=${hasOutput ? toggleStep : null}
								>
									${stepStatusIcon(status)}
									<div class="flex flex-1 min-w-0 items-center gap-2">
										<span class="font-mono text-xs min-w-0 truncate">${step.name}</span>
										${reviewTarget ? html`
											<signoff-review-launcher class="shrink-0" .target=${reviewTarget}></signoff-review-launcher>
										` : nothing}
									</div>
									<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${stepStatusClass(status)}">${statusLabel}</span>
									<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadgeCls}">${step.type}</span>
									${marker
										? html`<span data-timeout-timing class="text-xs text-muted-foreground tabular-nums">${formatTimeoutTiming(marker)}</span>`
										: shouldShowDuration(status, step.duration_ms) ? html`<span class="text-xs text-muted-foreground tabular-nums">${formatDuration(step.duration_ms)}</span>` : nothing}
									${canChangeTimeout ? html`
										<button
											type="button"
											data-testid="change-verification-timeout"
											class="shrink-0 rounded border border-warning/30 px-1.5 py-0.5 text-[10px] font-medium text-warning hover:bg-warning/10"
											@click=${async (event: Event) => {
												event.stopPropagation();
												const { ChangeVerificationTimeoutDialog } = await import("../../dialogs/ChangeVerificationTimeoutDialog.js");
												ChangeVerificationTimeoutDialog.show({ goalId, gateId, stepName: step.name, configuredSeconds: marker.configuredSeconds });
											}}
										>Change timeout</button>
									` : nothing}
									${hasOutput ? html`<span data-step-chevron class="text-muted-foreground text-[10px] shrink-0">${isFailed ? "▴" : "▾"}</span>` : nothing}
								</div>
								${hasOutput ? (
									step.type !== "command"
										? html`<div data-step-output class="${isFailed ? "" : "hidden"} text-xs text-muted-foreground max-h-[300px] overflow-y-auto bg-muted/50 rounded-b p-2 border-t border-border"><markdown-block .content=${step.output}></markdown-block></div>`
										: html`<pre data-step-output class="${isFailed ? "" : "hidden"} text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-y-auto bg-muted/50 rounded-b p-2 border-t border-border">${hasAnsi(step.output) ? unsafeHTML(ansiToHtml(step.output)) : step.output}</pre>`
								) : nothing}
							</div>
						`;
					})}
				</div>
			</div>`,
			isCustom: false,
		};
	}

	// ── section="signals" ────────────────────────────────────────────

	private _renderSignals(state: any, gateId: string, data: any, argSummary: string, argTooltip: string): ToolRenderResult {
		const signals: any[] = data?.signals || [];
		const count = signals.length;

		const formatTime = (ts: string) => {
			try { return new Date(ts).toLocaleString(); } catch { return ts; }
		};

		const rows = html`
			<div class="mt-2 space-y-0.5">
				${signals.map((s: any) => html`
					<div class="flex items-center gap-2 text-xs py-0.5">
						<span class="text-muted-foreground">#${s.index}</span>
						${gateBadge(s.verdict)}
						<span class="text-muted-foreground">${formatTime(s.timestamp)}</span>
						${s.hasContent ? html`<span title="Has content">📄</span>` : nothing}
						${s.sessionId ? html`<span class="font-mono text-muted-foreground">${s.sessionId.slice(0, 8)}</span>` : nothing}
					</div>
				`)}
			</div>
		`;

		if (count > 5) {
			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();
			return {
				content: html`<div>
					<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
						<div class="min-w-0 flex-1 basis-full xl:basis-auto">
							${renderCollapsibleHeader(state, ShieldCheck, html`Inspect gate <span class="font-mono">${gateId}</span> — ${count} signal${count !== 1 ? "s" : ""}`, contentRef, chevronRef, false)}
						</div>
						${argSummary ? html`<div class="min-w-0 max-w-full shrink basis-full xl:ml-auto xl:basis-auto xl:max-w-[45vw]">${renderArgSummary(argSummary, argTooltip)}</div>` : nothing}
					</div>
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${rows}
					</div>
				</div>`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>
				${renderInspectHeader(state, html`Inspect gate <span class="font-mono">${gateId}</span> — ${count} signal${count !== 1 ? "s" : ""}`, argSummary, argTooltip)}
				${rows}
			</div>`,
			isCustom: false,
		};
	}
}
