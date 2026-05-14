import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { MapPin } from "lucide";
import { getToolState, isSkippedToolResult, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { parseLspResult, renderLocationRow, renderLspErrorEnvelope, type LspLocation } from "./LspShared.js";

interface DefParams {
	path: string;
	line: number;
	character: number;
}

export class LspDefinitionRenderer implements ToolRenderer<DefParams, any> {
	render(params: DefParams | undefined, result: ToolResultMessage<any> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const headerText = `Definition: ${params?.path ?? "?"}`;

		if (!result) {
			return { content: renderHeader(state, MapPin, headerText), isCustom: false };
		}

		const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
		const data = parseLspResult(result);

		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`
					<div class="space-y-2">
						${renderHeader(state, MapPin, headerText)}
						<div class="text-sm ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const errEnv = renderLspErrorEnvelope(data);
		if (errEnv) {
			return {
				content: html`<div>${renderHeader(state, MapPin, headerText)}${errEnv}</div>`,
				isCustom: false,
			};
		}

		if (data == null) {
			return {
				content: html`
					<div>
						${renderHeader(state, MapPin, headerText)}
						<div class="mt-1 text-sm text-muted-foreground italic">No definition found.</div>
					</div>
				`,
				isCustom: false,
			};
		}

		const locs: LspLocation[] = Array.isArray(data) ? data : [data];
		if (locs.length === 0) {
			return {
				content: html`<div>${renderHeader(state, MapPin, headerText)}<div class="mt-1 text-sm text-muted-foreground italic">No definition found.</div></div>`,
				isCustom: false,
			};
		}
		return {
			content: html`
				<div>
					${renderHeader(state, MapPin, headerText)}
					<div class="mt-1 space-y-0.5">
						${locs.map(l => html`<div>${renderLocationRow(l)}</div>`)}
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
