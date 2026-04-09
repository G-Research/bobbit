import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { SquareTerminal } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface BgParams {
	action: string;
	command?: string;
	name?: string;
	id?: string;
	tail?: number;
	pattern?: string;
	lines?: number;
	from?: number;
	to?: number;
}

/** Extract the process name from result text like "Logs for bg-12 (branch cleanup):" */
function extractProcessName(result: ToolResultMessage | undefined): string | undefined {
	if (!result) return undefined;
	const text = typeof result.content === "string"
		? result.content
		: result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	// Match "bg-NN (process name)" in the first line
	const match = text.match(/bg-\d+\s+\(([^)]+)\)/);
	return match?.[1] ?? undefined;
}

function summarize(params: BgParams, result: ToolResultMessage | undefined): string {
	const processName = extractProcessName(result) || params.name;
	const idLabel = params.id || "";
	const label = processName ? ` [${processName}]` : idLabel ? ` [${idLabel}]` : "";

	switch (params.action) {
		case "create":
			return `start${label || ""}: ${(params.command || "").slice(0, 60)}`;
		case "logs":
			return `logs${label}${params.tail ? ` (tail ${params.tail})` : ""}`;
		case "grep":
			return `grep${label}: ${params.pattern ? `/${params.pattern}/` : ""}`;
		case "head":
			return `head${label}${params.lines ? ` (${params.lines} lines)` : ""}`;
		case "slice":
			return `slice${label}: lines ${params.from || "?"}–${params.to || "?"}`;
		case "kill":
			return `kill${label}`;
		case "wait":
			return `wait${label}`;
		case "list":
			return "list processes";
		default:
			return `${params.action}${label}`;
	}
}

export class BgProcessRenderer implements ToolRenderer<BgParams> {
	render(
		params: BgParams | undefined,
		result: ToolResultMessage | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		const summary = params ? summarize(params, result) : "background process";
		const state = getToolState(result, !result);

		const output = typeof result?.content === "string"
			? result.content
			: result?.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";

		if (!result) {
			return {
				content: renderHeader(state, SquareTerminal, summary),
				isCustom: false,
			};
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, SquareTerminal, summary, contentRef, chevronRef, false)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<console-block .content=${output || "(no output)"}></console-block>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
