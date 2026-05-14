import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { SearchCode } from "lucide";
import { getToolState, isSkippedToolResult, renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { normalisePath, parseLspResult, renderLspErrorEnvelope, symbolKindLabel } from "./LspShared.js";

interface WsSymParams { query: string; }

interface WsSymbol {
	name: string;
	kind: number;
	path: string;
	range: { start: { line: number; character: number } };
}

export class LspWorkspaceSymbolRenderer implements ToolRenderer<WsSymParams, any> {
	render(params: WsSymParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const query = params?.query ?? "";

		if (!result) {
			return { content: renderHeader(state, SearchCode, html`Workspace search: <span class="font-mono">${query}</span>`), isCustom: false };
		}

		const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
		const data = parseLspResult(result);

		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, SearchCode, html`Workspace search: <span class="font-mono">${query}</span>`)}
						<div class="text-sm ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const errEnv = renderLspErrorEnvelope(data);
		if (errEnv) {
			return {
				content: html`<div>${renderHeader(state, SearchCode, html`Workspace search: <span class="font-mono">${query}</span>`)}${errEnv}</div>`,
				isCustom: false,
			};
		}

		const syms: WsSymbol[] = Array.isArray(data) ? data : [];
		const headerText = html`${syms.length} symbol${syms.length === 1 ? "" : "s"} matching <span class="font-mono">"${query}"</span>`;

		if (syms.length === 0) {
			return {
				content: html`<div>${renderHeader(state, SearchCode, headerText)}<div class="mt-1 text-sm text-muted-foreground italic">No symbols.</div></div>`,
				isCustom: false,
			};
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, SearchCode, headerText, contentRef, chevronRef, false)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<div class="space-y-0.5">
							${syms.map(s => {
								const kind = symbolKindLabel(s.kind);
								const line = (s.range?.start?.line ?? 0) + 1;
								return html`
									<div class="flex items-center gap-1.5 text-sm">
										<span class="inline-block text-muted-foreground shrink-0" title=${kind.label}>${icon(kind.icon, "sm")}</span>
										<span class="font-mono">${s.name}</span>
										<span class="font-mono text-xs text-muted-foreground ml-auto truncate">${normalisePath(s.path)}:${line}</span>
									</div>
								`;
							})}
						</div>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
