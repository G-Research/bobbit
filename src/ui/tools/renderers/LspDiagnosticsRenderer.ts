import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { CheckCircle2, ShieldAlert } from "lucide";
import { getToolState, isSkippedToolResult, renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { normalisePath, parseLspResult, renderLspErrorEnvelope, severityLabel } from "./LspShared.js";

interface DiagParams { path?: string; }

interface Diagnostic {
	path: string;
	range: { start: { line: number; character: number } };
	severity: 1 | 2 | 3 | 4;
	message: string;
	source?: string;
}

function summarise(diags: Diagnostic[]): string {
	const counts: Record<number, number> = {};
	for (const d of diags) counts[d.severity] = (counts[d.severity] || 0) + 1;
	const parts: string[] = [];
	const labels: Record<number, [string, string]> = {
		1: ["error", "errors"],
		2: ["warning", "warnings"],
		3: ["info", "info"],
		4: ["hint", "hints"],
	};
	for (const sev of [1, 2, 3, 4] as const) {
		const c = counts[sev];
		if (c) parts.push(`${c} ${c === 1 ? labels[sev][0] : labels[sev][1]}`);
	}
	return parts.join(", ") || "0 diagnostics";
}

export class LspDiagnosticsRenderer implements ToolRenderer<DiagParams, any> {
	render(params: DiagParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const scope = params?.path ? `Diagnostics: ${params.path}` : "Diagnostics (workspace)";

		if (!result) {
			return { content: renderHeader(state, ShieldAlert, scope), isCustom: false };
		}

		const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
		const data = parseLspResult(result);

		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, ShieldAlert, scope)}
						<div class="text-sm ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const errEnv = renderLspErrorEnvelope(data);
		if (errEnv) {
			return { content: html`<div>${renderHeader(state, ShieldAlert, scope)}${errEnv}</div>`, isCustom: false };
		}

		const diags: Diagnostic[] = Array.isArray(data) ? data : [];

		if (diags.length === 0) {
			return {
				content: html`
					<div>
						${renderHeader(state, ShieldAlert, scope)}
						<div class="mt-1 text-sm text-green-600 dark:text-green-500 flex items-center gap-1.5">
							<span class="inline-block">${icon(CheckCircle2, "sm")}</span>
							<span>No diagnostics — file is clean.</span>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// Group by path, then sort within group by severity (error → hint).
		const groups = new Map<string, Diagnostic[]>();
		for (const d of diags) {
			const k = normalisePath(d.path);
			const arr = groups.get(k) || [];
			arr.push(d);
			groups.set(k, arr);
		}
		for (const arr of groups.values()) arr.sort((a, b) => a.severity - b.severity);

		const summary = summarise(diags);
		const headerText = `${scope} — ${summary}`;
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, ShieldAlert, headerText, contentRef, chevronRef, true)}
					<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
						<div class="space-y-3">
							${[...groups.entries()].map(([path, items]) => html`
								<div>
									<div class="font-mono text-xs mb-1">${path}</div>
									<div class="space-y-0.5">
										${items.map(d => {
											const sev = severityLabel(d.severity);
											const line = d.range?.start?.line ?? 0;
											const col = d.range?.start?.character ?? 0;
											return html`
												<div class="flex items-start gap-2 text-sm">
													<span class="${sev.color} shrink-0 mt-0.5">${icon(sev.icon, "sm")}</span>
													<span class="font-mono text-xs text-muted-foreground shrink-0">:${line + 1}:${col + 1}</span>
													<span class="flex-1 min-w-0">${d.message}</span>
													${d.source ? html`<span class="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">${d.source}</span>` : ""}
												</div>
											`;
										})}
									</div>
								</div>
							`)}
						</div>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
