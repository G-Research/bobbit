import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { ListTree } from "lucide";
import { getToolState, isSkippedToolResult, renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { type DocumentSymbol, countNested, parseLspResult, renderLspErrorEnvelope, renderSymbolTree } from "./LspShared.js";

export class LspDocumentSymbolsRenderer implements ToolRenderer {
	render(params: { path: string } | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const pathStr = params?.path ?? "?";

		if (!result) return { content: renderHeader(state, ListTree, `Symbols in ${pathStr}…`), isCustom: false };

		const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
		const data = parseLspResult(result);

		if (result.isError) {
			const cls = isSkippedToolResult(result) ? "text-amber-600 dark:text-amber-400" : "text-destructive";
			return { content: html`<div>${renderHeader(state, ListTree, `Symbols in ${pathStr}`)}<div class="text-sm ${cls}">${text}</div></div>`, isCustom: false };
		}

		const errEnv = renderLspErrorEnvelope(data);
		if (errEnv) return { content: html`<div>${renderHeader(state, ListTree, `Symbols in ${pathStr}`)}${errEnv}</div>`, isCustom: false };

		const syms: DocumentSymbol[] = Array.isArray(data) ? data : [];
		const total = countNested(syms);
		const headerText = `${total} symbol${total === 1 ? "" : "s"} in ${pathStr}`;

		if (syms.length === 0) {
			return { content: html`<div>${renderHeader(state, ListTree, headerText)}<div class="mt-1 text-sm text-muted-foreground italic">No symbols.</div></div>`, isCustom: false };
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, ListTree, headerText, contentRef, chevronRef, true)}
					<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
						${renderSymbolTree(syms, 0)}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
