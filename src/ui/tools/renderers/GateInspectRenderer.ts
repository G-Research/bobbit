/**
 * Renderer for the gate_inspect tool.
 * Handles three section types: content, verification, signals.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { createRef, ref } from "lit/directives/ref.js";
import { ShieldCheck } from "lucide";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { getResult, gateBadge } from "./GateToolRenderers.js";
import { ansiToHtml, hasAnsi } from "../../utils/ansi.js";

// ── Helpers ──────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
	if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
	return `${(ms / 1000).toFixed(1)}s`;
}

function stepStatusIcon(status: string): TemplateResult {
	if (status === "passed") return html`<span class="text-green-600 dark:text-green-400">✓</span>`;
	if (status === "failed") return html`<span class="text-red-600 dark:text-red-400">✗</span>`;
	if (status === "skipped") return html`<span class="text-muted-foreground">⊘</span>`;
	return html`<span class="text-blue-600 dark:text-blue-400">●</span>`;
}

function deriveStepStatus(step: any): string {
	if (step.skipped) return "skipped";
	if (step.passed === true) return "passed";
	if (step.passed === false) return "failed";
	return "running";
}

// ── Renderer ─────────────────────────────────────────────────────────

export class GateInspectRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const gateId = params?.gate_id || "gate";

		// Loading state
		if (!result) {
			return {
				content: html`<div>${renderHeader(state, ShieldCheck, html`Inspecting gate <span class="font-mono">${gateId}</span>…`)}</div>`,
				isCustom: false,
			};
		}

		// Error/skipped state
		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, ShieldCheck, skipped
						? html`Aborted inspect of gate <span class="font-mono">${gateId}</span>`
						: html`Failed to inspect gate <span class="font-mono">${gateId}</span>`)}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const section = data?.section || params?.section || "content";

		switch (section) {
			case "content": return this._renderContent(state, gateId, data);
			case "verification": return this._renderVerification(state, gateId, data, result);
			case "signals": return this._renderSignals(state, gateId, data);
			default: return this._renderContent(state, gateId, data);
		}
	}

	// ── section="content" ────────────────────────────────────────────

	private _renderContent(state: any, gateId: string, data: any): ToolRenderResult {
		const signalIndex = data?.signalIndex ?? "?";
		const signalId = data?.signalId || "";
		const content = data?.text;

		return {
			content: html`<div>
				${renderHeader(state, ShieldCheck, html`Inspect gate <span class="font-mono">${gateId}</span> — content`)}
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

	private _renderVerification(state: any, gateId: string, data: any, _result: ToolResultMessage): ToolRenderResult {
		const signalIndex = data?.signalIndex ?? "?";
		const signalId = data?.signalId || "";
		const steps: any[] = data?.steps || [];

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
				${renderHeader(state, ShieldCheck, html`Inspect gate <span class="font-mono">${gateId}</span> — verification`)}
				<div class="text-xs text-muted-foreground mt-1">Signal #${signalIndex}${signalId ? html` · ${signalId}` : nothing}</div>
				<div class="mt-2 space-y-1">
					${steps.map((step: any, _i: number) => {
						const status = deriveStepStatus(step);
						const hasOutput = !!step.output;
						const isFailed = status === "failed";
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
									<span class="font-mono text-xs flex-1 min-w-0 truncate">${step.name}</span>
									<span class="px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadgeCls}">${step.type}</span>
									${step.duration_ms != null ? html`<span class="text-xs text-muted-foreground tabular-nums">${formatDuration(step.duration_ms)}</span>` : nothing}
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

	private _renderSignals(state: any, gateId: string, data: any): ToolRenderResult {
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
					${renderCollapsibleHeader(state, ShieldCheck, html`Inspect gate <span class="font-mono">${gateId}</span> — ${count} signal${count !== 1 ? "s" : ""}`, contentRef, chevronRef, false)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${rows}
					</div>
				</div>`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>
				${renderHeader(state, ShieldCheck, html`Inspect gate <span class="font-mono">${gateId}</span> — ${count} signal${count !== 1 ? "s" : ""}`)}
				${rows}
			</div>`,
			isCustom: false,
		};
	}
}
