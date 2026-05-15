import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Crosshair } from "lucide";
import { getToolState, isSkippedToolResult, renderCollapsibleHeader, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import {
	isAmbiguousShorthand,
	normalisePath,
	parseLspResult,
	renderAmbiguousShorthand,
	renderLspErrorEnvelope,
	renderResolvedFromBanner,
	unwrapShorthand,
	type LspLocation,
} from "./LspShared.js";

interface RefParams {
	path: string;
	line: number;
	character: number;
	includeDeclaration?: boolean;
}

function groupByPath(locs: LspLocation[]): Map<string, LspLocation[]> {
	const groups = new Map<string, LspLocation[]>();
	for (const l of locs) {
		const key = normalisePath(l.path);
		const arr = groups.get(key) || [];
		arr.push(l);
		groups.set(key, arr);
	}
	return groups;
}

export class LspReferencesRenderer implements ToolRenderer<RefParams, any> {
	render(_params: RefParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		if (!result) {
			return { content: renderHeader(state, Crosshair, "Finding references…"), isCustom: false };
		}

		const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
		const data = parseLspResult(result);

		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, Crosshair, "References")}
						<div class="text-sm ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const errEnv = renderLspErrorEnvelope(data);
		if (errEnv) {
			return { content: html`<div>${renderHeader(state, Crosshair, "References")}${errEnv}</div>`, isCustom: false };
		}

		if (isAmbiguousShorthand(data)) {
			return { content: html`<div>${renderHeader(state, Crosshair, "References")}${renderAmbiguousShorthand(data)}</div>`, isCustom: false };
		}

		const { resolvedFrom, body } = unwrapShorthand(data);
		const locs: LspLocation[] = Array.isArray(body) ? body : [];
		const groups = groupByPath(locs);
		const headerText = `${locs.length} reference${locs.length === 1 ? "" : "s"} in ${groups.size} file${groups.size === 1 ? "" : "s"}`;

		if (locs.length === 0) {
			return {
				content: html`<div>${renderHeader(state, Crosshair, headerText)}${renderResolvedFromBanner(resolvedFrom)}<div class="mt-1 text-sm text-muted-foreground italic">No references found.</div></div>`,
				isCustom: false,
			};
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, Crosshair, headerText, contentRef, chevronRef, false)}
					${renderResolvedFromBanner(resolvedFrom)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<div class="space-y-2">
							${[...groups.entries()].map(([path, items]) => html`
								<div>
									<div class="flex items-center gap-2 text-xs">
										<span class="font-mono">${path}</span>
										<span class="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">${items.length}</span>
									</div>
									<div class="pl-4 mt-0.5 space-y-0.5">
										${items.map(l => html`<div class="font-mono text-xs text-muted-foreground">:${(l.range?.start?.line ?? 0) + 1}:${(l.range?.start?.character ?? 0) + 1}</div>`)}
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
