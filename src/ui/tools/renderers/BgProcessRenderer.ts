import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
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

/** Build the rich header as a TemplateResult with structured layout. */
function buildHeader(params: BgParams, result: ToolResultMessage | undefined): TemplateResult {
	const processName = extractProcessName(result) || params.name;
	const id = params.id || "";

	const badge = html`<span style="font-family:var(--font-mono,monospace);font-size:0.7rem;font-weight:500;opacity:0.55;background:var(--badge-bg, rgba(128,128,128,0.15));padding:1px 5px;border-radius:3px">bash_bg</span>`;
	const action = html`<span style="font-weight:600">${params.action}</span>`;
	const name = processName ? html`<span style="font-weight:500">${processName}</span>` : html``;
	const idSpan = id ? html`<span style="font-family:var(--font-mono,monospace);font-size:0.7rem;opacity:0.55">(${id})</span>` : html``;

	let detail: TemplateResult | string = "";
	switch (params.action) {
		case "create":
			detail = params.command
				? html`<span style="font-family:var(--font-mono,monospace);font-size:0.7rem;opacity:0.55">${params.command.slice(0, 60)}</span>`
				: "";
			break;
		case "logs":
			if (params.tail) detail = html`<span style="opacity:0.55">tail ${params.tail}</span>`;
			break;
		case "grep":
			if (params.pattern) detail = html`<code style="font-family:var(--font-mono,monospace);font-size:0.7rem;opacity:0.7;background:var(--badge-bg, rgba(128,128,128,0.15));padding:1px 5px;border-radius:3px">/${params.pattern}/</code>`;
			break;
		case "head":
			if (params.lines) detail = html`<span style="opacity:0.55">${params.lines} lines</span>`;
			break;
		case "slice":
			detail = html`<span style="opacity:0.55">lines ${params.from || "?"}–${params.to || "?"}</span>`;
			break;
		case "wait":
			if (params.timeout) detail = html`<span style="opacity:0.55">up to ${formatDuration(params.timeout)}</span>`;
			break;
		case "list":
			return html`${badge} ${action}`;
	}

	const sep = detail ? html`<span style="opacity:0.4">—</span>` : html``;

	return html`${badge} ${action} ${name} ${idSpan} ${sep} ${detail}`;
}

export class BgProcessRenderer implements ToolRenderer<BgParams> {
	render(
		params: BgParams | undefined,
		result: ToolResultMessage | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		const headerContent = params ? buildHeader(params, result) : html`<span>background process</span>`;
		const state = getToolState(result, !result);

		const output = typeof result?.content === "string"
			? result.content
			: result?.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";

		if (!result) {
			return {
				content: renderHeader(state, SquareTerminal, headerContent),
				isCustom: false,
			};
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, SquareTerminal, headerContent, contentRef, chevronRef, false)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<console-block .content=${output || "(no output)"}></console-block>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
