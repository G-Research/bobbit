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

// Shared inline styles — keeps templates readable and consistent.
// All use the same line-height so mixed font-sizes still share a baseline.
const S = {
	badge: "font-family:var(--font-mono,monospace);font-size:0.75em;font-weight:500;opacity:0.5;background:color-mix(in srgb, currentColor 10%, transparent);padding:0.1em 0.4em;border-radius:3px;vertical-align:baseline",
	action: "font-weight:600",
	name: "font-weight:500",
	id: "font-family:var(--font-mono,monospace);font-size:0.85em;opacity:0.5;vertical-align:baseline",
	sep: "opacity:0.35",
	detail: "opacity:0.5",
	mono: "font-family:var(--font-mono,monospace);font-size:0.85em;opacity:0.5;vertical-align:baseline",
	codePill: "font-family:var(--font-mono,monospace);font-size:0.85em;opacity:0.65;background:color-mix(in srgb, currentColor 10%, transparent);padding:0.1em 0.4em;border-radius:3px;vertical-align:baseline",
} as const;

/** Build the rich header as a TemplateResult with structured layout. */
function buildHeader(params: BgParams, result: ToolResultMessage | undefined): TemplateResult {
	const processName = extractProcessName(result) || params.name;
	const id = params.id || "";

	// Wrap everything in an inline-flex span so mixed font-sizes align on baseline
	// within the parent flex container from renderHeader.
	const badge = html`<span style="${S.badge}">bash_bg</span>`;
	const action = html`<span style="${S.action}">${params.action}</span>`;

	// Show process name if known, otherwise show the raw ID as the label
	const nameOrId = processName
		? html` <span style="${S.name}">${processName}</span> <span style="${S.id}">(${id})</span>`
		: id
			? html` <span style="${S.id}">${id}</span>`
			: html``;

	let detail: TemplateResult | string = "";
	switch (params.action) {
		case "create":
			detail = params.command
				? html`<span style="${S.mono}">${params.command.slice(0, 60)}</span>`
				: "";
			break;
		case "logs":
			if (params.tail) detail = html`<span style="${S.detail}">tail ${params.tail}</span>`;
			break;
		case "grep":
			if (params.pattern) detail = html`<span style="${S.codePill}">/${params.pattern}/</span>`;
			break;
		case "head":
			if (params.lines) detail = html`<span style="${S.detail}">${params.lines} lines</span>`;
			break;
		case "slice":
			detail = html`<span style="${S.detail}">lines ${params.from || "?"}–${params.to || "?"}</span>`;
			break;
		case "wait":
			if (params.timeout) detail = html`<span style="${S.detail}">up to ${formatDuration(params.timeout)}</span>`;
			break;
		case "list":
			return html`<span style="display:inline-flex;align-items:baseline;gap:0.4em;flex-wrap:wrap">${badge} ${action}</span>`;
	}

	const sep = detail ? html`<span style="${S.sep}">—</span>` : html``;

	return html`<span style="display:inline-flex;align-items:baseline;gap:0.4em;flex-wrap:wrap">${badge} ${action}${nameOrId} ${sep} ${detail}</span>`;
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
