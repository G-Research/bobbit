import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { Edit3 } from "lucide";
import { getToolState, isSkippedToolResult, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { normalisePath, parseLspResult, renderLspErrorEnvelope } from "./LspShared.js";

interface RenameParams {
	path: string;
	line: number;
	character: number;
	newName: string;
}

export class LspRenameRenderer implements ToolRenderer<RenameParams, any> {
	render(params: RenameParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const newName = params?.newName ?? "";
		const headerText = html`Rename → <span class="font-mono">${newName}</span>`;

		if (!result) {
			return { content: renderHeader(state, Edit3, headerText), isCustom: false };
		}

		const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
		const data = parseLspResult(result);

		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, Edit3, headerText)}
						<div class="text-sm ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const errEnv = renderLspErrorEnvelope(data);
		if (errEnv) {
			return { content: html`<div>${renderHeader(state, Edit3, headerText)}${errEnv}</div>`, isCustom: false };
		}

		const changes: Record<string, any[]> = (data && typeof data === "object" && data.changes) || {};
		const entries = Object.entries(changes).map(([k, edits]) => ({
			path: normalisePath(k),
			count: Array.isArray(edits) ? edits.length : 0,
		}));
		const totalEdits = entries.reduce((n, e) => n + e.count, 0);

		if (entries.length === 0) {
			return {
				content: html`
					<div>
						${renderHeader(state, Edit3, headerText)}
						<div class="mt-1 text-sm text-muted-foreground italic">No edits proposed.</div>
					</div>
				`,
				isCustom: false,
			};
		}

		return {
			content: html`
				<div>
					${renderHeader(state, Edit3, headerText)}
					<div class="mt-1 text-sm text-muted-foreground">in ${entries.length} file${entries.length === 1 ? "" : "s"} (${totalEdits} total edit${totalEdits === 1 ? "" : "s"})</div>
					<div class="mt-2 space-y-0.5">
						${entries.map(e => html`
							<div class="flex items-center gap-2 text-sm">
								<span class="font-mono">${e.path}</span>
								<span class="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-xs">${e.count}</span>
							</div>
						`)}
					</div>
					<div class="mt-2"><span class="text-xs text-muted-foreground">Preview only — agent applies via <span class="font-mono">edit</span>.</span></div>
				</div>
			`,
			isCustom: false,
		};
	}
}
