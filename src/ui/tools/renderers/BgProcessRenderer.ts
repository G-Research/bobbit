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
	timeout?: number;
}

/** Extract the process name from result text like "Logs for bg-12 (branch cleanup):" */
function extractProcessName(result: ToolResultMessage | undefined): string | undefined {
	if (!result) return undefined;
	const text = typeof result.content === "string"
		? result.content
		: result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	const match = text.match(/bg-\d+\s+\(([^)]+)\)/);
	return match?.[1] ?? undefined;
}

/** Format seconds into a human-readable duration like "2m 30s" or "5m" */
function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/**
 * Build the process label: "process name (bg-12)" or just "bg-12"
 * Shows name prominently with the ID as a secondary reference.
 */
function processLabel(params: BgParams, result: ToolResultMessage | undefined): string {
	const name = extractProcessName(result) || params.name;
	const id = params.id || "";
	if (name && id) return `${name} (${id})`;
	if (name) return name;
	return id;
}

function summarize(params: BgParams, result: ToolResultMessage | undefined): string {
	const label = processLabel(params, result);

	switch (params.action) {
		case "create": {
			const cmd = (params.command || "").slice(0, 60);
			return label ? `start ${label} — ${cmd}` : `start: ${cmd}`;
		}
		case "logs": {
			const tail = params.tail ? ` — tail ${params.tail}` : "";
			return label ? `logs ${label}${tail}` : `logs${tail}`;
		}
		case "grep": {
			const pat = params.pattern ? ` — /${params.pattern}/` : "";
			return label ? `grep ${label}${pat}` : `grep${pat}`;
		}
		case "head": {
			const n = params.lines ? ` — ${params.lines} lines` : "";
			return label ? `head ${label}${n}` : `head${n}`;
		}
		case "slice": {
			const range = ` — lines ${params.from || "?"}–${params.to || "?"}`;
			return label ? `slice ${label}${range}` : `slice${range}`;
		}
		case "kill":
			return label ? `kill ${label}` : "kill";
		case "wait": {
			const dur = params.timeout ? ` — up to ${formatDuration(params.timeout)}` : "";
			return label ? `wait ${label}${dur}` : `wait${dur}`;
		}
		case "list":
			return "list processes";
		default:
			return label ? `${params.action} ${label}` : params.action;
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
