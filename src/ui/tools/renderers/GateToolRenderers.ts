/**
 * Renderers for gate_list, gate_signal, gate_status tools.
 * Compact gate cards with status badges and dependency info.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { ShieldCheck } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────

function getResult(result: ToolResultMessage | undefined): { text: string; data: any } {
	const text = result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	let data: any = null;
	try { data = JSON.parse(text); } catch { /* not JSON */ }
	return { text, data };
}

function gateBadge(status: string): TemplateResult {
	const styles: Record<string, string> = {
		pending: "bg-muted text-muted-foreground",
		passed: "bg-green-500/20 text-green-600 dark:text-green-400",
		failed: "bg-red-500/20 text-red-600 dark:text-red-400",
		running: "bg-blue-500/20 text-blue-600 dark:text-blue-400",
	};
	const cls = styles[status] || "bg-muted text-muted-foreground";
	return html`<span class="px-1.5 py-0.5 rounded text-xs font-medium ${cls}">${status}</span>`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m ${s}s`;
}

// ── gate_list ────────────────────────────────────────────────────────

export class GateListRenderer implements ToolRenderer {
	render(_params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		if (!result) {
			return { content: html`<div>${renderHeader(state, ShieldCheck, "Listing gates…")}</div>`, isCustom: false };
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, ShieldCheck, skipped ? "Aborted gate list" : "Gate list failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const gates: any[] = data?.gates || (Array.isArray(data) ? data : []);
		if (gates.length === 0) {
			return { content: html`<div>${renderHeader(state, ShieldCheck, "No gates")}</div>`, isCustom: false };
		}

		// Build status summary (only non-zero counts)
		const byStatus = new Map<string, number>();
		for (const g of gates) byStatus.set(g.status || "pending", (byStatus.get(g.status || "pending") || 0) + 1);
		const summary = Array.from(byStatus.entries()).map(([s, n]) => `${n} ${s}`).join(", ");

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`<div>
				${renderCollapsibleHeader(state, ShieldCheck, html`${gates.length} gates <span class="text-xs text-muted-foreground ml-1">(${summary})</span>`, contentRef, chevronRef, false)}
				<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
					<div class="mt-2 space-y-1">${gates.map((g: any) => html`
						<div class="flex items-center gap-2 text-xs py-0.5">
							${gateBadge(g.status || "pending")}
							<span class="font-medium truncate">${g.name || g.gateId}</span>
							${g.dependsOn?.length ? html`<span class="text-muted-foreground">← ${g.dependsOn.join(", ")}</span>` : ""}
						</div>
					`)}</div>
				</div>
			</div>`,
			isCustom: false,
		};
	}
}

// ── gate_signal ──────────────────────────────────────────────────────

export class GateSignalRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const gateId = params?.gate_id || "gate";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, ShieldCheck, html`Signaling <span class="font-mono text-xs">${gateId}</span>…`)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			const is409 = text.includes("409") || text.toLowerCase().includes("upstream") || text.toLowerCase().includes("has not passed");
			const textCls = skipped ? "text-amber-600 dark:text-amber-400" : is409 ? "text-amber-600 dark:text-amber-400" : "text-destructive";
			return {
				content: html`<div>
					${renderHeader(state, ShieldCheck, skipped
						? html`Aborted signal for <span class="font-mono text-xs">${gateId}</span>`
						: html`Failed to signal <span class="font-mono text-xs">${gateId}</span>`)}
					<div class="mt-1 text-xs ${textCls}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>${renderHeader(state, ShieldCheck, html`Signaled <span class="font-mono text-xs">${gateId}</span> — verification running`)}</div>`,
			isCustom: false,
		};
	}
}

// ── gate_status ──────────────────────────────────────────────────────

export class GateStatusRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const gateId = params?.gate_id || "gate";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, ShieldCheck, html`Checking gate <span class="font-mono text-xs">${gateId}</span>…`)}</div>`,
				isCustom: false,
			};
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, ShieldCheck, skipped
						? html`Aborted check of gate <span class="font-mono text-xs">${gateId}</span>`
						: html`Failed to check gate <span class="font-mono text-xs">${gateId}</span>`)}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		if (!data) {
			return { content: html`<div>${renderHeader(state, ShieldCheck, html`Gate <span class="font-mono text-xs">${gateId}</span>`)}</div>`, isCustom: false };
		}

		const gateName = data.name || data.gateId || gateId;
		const gateStatus = data.status || "pending";
		const deps: string[] = data.dependsOn || [];
		const signals: any[] = data.signals || [];
		const contentVersion = data.currentContentVersion;

		// Latest signal verification
		const latestSignal = signals.length > 0 ? signals[signals.length - 1] : null;
		const verification = latestSignal?.verification;

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`<div>
				${renderCollapsibleHeader(state, ShieldCheck, html`${gateBadge(gateStatus)} <span class="font-medium text-xs ml-1">${gateName}</span>`, contentRef, chevronRef, false)}
				<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
					<div class="mt-2 space-y-1 text-xs text-muted-foreground">
						${deps.length ? html`<div>Depends on: ${deps.join(", ")}</div>` : ""}
						<div>${signals.length} signal${signals.length !== 1 ? "s" : ""}</div>
						${contentVersion ? html`<div>content v${contentVersion}</div>` : ""}
						${verification ? this._renderVerification(verification) : ""}
					</div>
				</div>
			</div>`,
			isCustom: false,
		};
	}

	private _renderVerification(verification: any): TemplateResult {
		const steps: any[] = verification.steps || [];
		const vStatus = verification.status || "running";
		const passedCount = steps.filter((s: any) => s.passed).length;
		const summaryText = `${passedCount}/${steps.length} steps`;

		return html`
			<div class="mt-2 border-t border-border pt-2">
				<div class="flex items-center gap-2 mb-1">
					<span class="font-medium">Verification:</span>
					${gateBadge(vStatus)}
					<span>(${summaryText})</span>
				</div>
				${steps.map((step: any) => {
					const passed = step.passed;
					const running = passed == null;
					const icon = running ? "…" : passed ? "✓" : "✗";
					const iconCls = running
						? "text-blue-600 dark:text-blue-400"
						: passed
							? "text-green-600 dark:text-green-400"
							: "text-red-600 dark:text-red-400";
					const dur = step.duration_ms != null ? formatDuration(step.duration_ms) : "";
					return html`
						<details class="group">
							<summary class="flex items-center gap-2 py-0.5 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:text-foreground transition-colors">
								<span class="${iconCls} font-bold">${icon}</span>
								<span class="truncate flex-1">${step.name || "step"}</span>
								${dur ? html`<span class="text-muted-foreground ml-auto shrink-0">${dur}</span>` : ""}
								<span class="text-muted-foreground shrink-0 transition-transform group-open:rotate-90">▸</span>
							</summary>
							${step.output ? html`<pre class="text-xs text-muted-foreground whitespace-pre-wrap max-h-[300px] overflow-y-auto bg-muted/50 rounded p-2 mt-1">${step.output}</pre>` : ""}
						</details>
					`;
				})}
			</div>
		`;
	}
}
