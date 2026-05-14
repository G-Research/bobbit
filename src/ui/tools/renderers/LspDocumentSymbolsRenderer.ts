import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { ListTree } from "lucide";
import { getToolState, isSkippedToolResult, renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { parseLspResult, renderLspErrorEnvelope, symbolKindLabel } from "./LspShared.js";

interface DocSymParams { path: string; }

interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: { start: { line: number; character: number } };
	selectionRange?: any;
	children?: DocumentSymbol[];
}

const MAX_DEPTH = 3;

function countNested(syms: DocumentSymbol[]): number {
	let n = 0;
	for (const s of syms) {
		n += 1;
		if (s.children?.length) n += countNested(s.children);
	}
	return n;
}

function renderSymbolRow(s: DocumentSymbol): TemplateResult {
	const kind = symbolKindLabel(s.kind);
	const line = (s.range?.start?.line ?? 0) + 1;
	return html`
		<div class="flex items-center gap-1.5 text-sm py-0.5">
			<span class="inline-block text-muted-foreground shrink-0" title=${kind.label}>${icon(kind.icon, "sm")}</span>
			<span class="font-mono">${s.name}</span>
			${s.detail ? html`<span class="text-xs text-muted-foreground truncate">: ${s.detail}</span>` : ""}
			<span class="text-xs text-muted-foreground shrink-0 ml-auto">:${line}</span>
		</div>
	`;
}

function renderTree(syms: DocumentSymbol[], depth: number): TemplateResult {
	if (depth >= MAX_DEPTH) {
		const n = countNested(syms);
		return html`<div class="pl-4 text-xs text-muted-foreground italic">(${n} more nested symbol${n === 1 ? "" : "s"})</div>`;
	}
	return html`
		<ul class="space-y-0 ${depth === 0 ? "" : "pl-4 border-l border-border ml-2"}">
			${syms.map(s => {
				if (s.children?.length) {
					return html`
						<li>
							<details ?open=${depth === 0}>
								<summary class="cursor-pointer hover:bg-accent/50 rounded list-none">
									${renderSymbolRow(s)}
								</summary>
								${renderTree(s.children, depth + 1)}
							</details>
						</li>
					`;
				}
				return html`<li>${renderSymbolRow(s)}</li>`;
			})}
		</ul>
	`;
}

export class LspDocumentSymbolsRenderer implements ToolRenderer<DocSymParams, any> {
	render(params: DocSymParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const pathStr = params?.path ?? "?";

		if (!result) {
			return { content: renderHeader(state, ListTree, `Symbols in ${pathStr}…`), isCustom: false };
		}

		const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
		const data = parseLspResult(result);

		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, ListTree, `Symbols in ${pathStr}`)}
						<div class="text-sm ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const errEnv = renderLspErrorEnvelope(data);
		if (errEnv) {
			return { content: html`<div>${renderHeader(state, ListTree, `Symbols in ${pathStr}`)}${errEnv}</div>`, isCustom: false };
		}

		const syms: DocumentSymbol[] = Array.isArray(data) ? data : [];
		const total = countNested(syms);
		const headerText = `${total} symbol${total === 1 ? "" : "s"} in ${pathStr}`;

		if (syms.length === 0) {
			return {
				content: html`<div>${renderHeader(state, ListTree, headerText)}<div class="mt-1 text-sm text-muted-foreground italic">No symbols.</div></div>`,
				isCustom: false,
			};
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, ListTree, headerText, contentRef, chevronRef, true)}
					<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
						${renderTree(syms, 0)}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
