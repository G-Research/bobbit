import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { SquareTerminal } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import "../../components/LiveTimer.js";

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

/**
 * Client-side cache of bg process id → display name.
 * Populated from `create` params (name is required for create)
 * and from result text (which includes "bg-NN (name)").
 * Looked up by all subsequent actions so the name is always available.
 */
const processNameCache = new Map<string, string>();

/**
 * Per-tool-call start-timestamp cache. Keyed by toolCallId when available,
 * otherwise by the params object identity (while the call is still
 * streaming and we don't have a result yet). The first render records
 * the wall-clock time; subsequent renders reuse it so <live-timer>
 * counts up from when the call started, not from the latest re-render.
 */
const callStartById = new Map<string, number>();
const callStartByParams = new WeakMap<object, number>();

function getCallStart(params: BgParams, result: ToolResultMessage | undefined): number {
	const id = result?.toolCallId;
	if (id) {
		let t = callStartById.get(id);
		if (t === undefined) {
			// Promote any per-params entry so we don't double-count.
			t = callStartByParams.get(params) ?? Date.now();
			callStartById.set(id, t);
		}
		return t;
	}
	let t = callStartByParams.get(params);
	if (t === undefined) {
		t = Date.now();
		callStartByParams.set(params, t);
	}
	return t;
}

/** Extract the process name from result text like "Logs for bg-12 (branch cleanup):" */
function extractAndCacheProcessName(id: string | undefined, result: ToolResultMessage | undefined): void {
	if (!result || !id) return;
	const text = typeof result.content === "string"
		? result.content
		: result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	const match = text.match(/bg-\d+\s+\(([^)]+)\)/);
	if (match?.[1]) processNameCache.set(id, match[1]);
}

/** Resolve the display name for a process — cache first, then params.name fallback. */
function resolveProcessName(params: BgParams, result: ToolResultMessage | undefined): string | undefined {
	const id = params.id;

	// On create, cache the name immediately from params (name is required for create)
	if (params.action === "create" && params.name) {
		// The id isn't known from params on create — it comes from the result.
		// Extract "ID: bg-NN" from result text to populate cache.
		if (result) {
			const text = typeof result.content === "string"
				? result.content
				: result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
			const idMatch = text.match(/ID:\s*(bg-\d+)/);
			if (idMatch?.[1]) processNameCache.set(idMatch[1], params.name);
		}
		// Also populate a default start-time for this create action so the
		// renderer shows a timer even before the session-manager refresh fires.
		// Fallback uses result.timestamp if available; otherwise do nothing —
		// we'd rather show no timer than a misleading one on historical replay.
		return params.name;
	}

	// For other actions, try cache first
	if (id && processNameCache.has(id)) return processNameCache.get(id);

	// Try extracting from result and caching
	extractAndCacheProcessName(id, result);
	if (id && processNameCache.has(id)) return processNameCache.get(id);

	// Last resort: params.name (agent might pass it)
	return params.name;
}

/** Format seconds into a human-readable duration like "2m 30s" or "5m" */
function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// Shared inline styles — all use em-based sizing for proper scaling
// and baseline alignment within the inline-flex container.
const S = {
	badge: "font-family:var(--font-mono,monospace);font-size:0.75em;font-weight:500;opacity:0.5;background:color-mix(in srgb, currentColor 10%, transparent);padding:0.1em 0.4em;border-radius:3px;vertical-align:baseline",
	action: "font-weight:600",
	name: "font-weight:500",
	id: "font-family:var(--font-mono,monospace);font-size:0.85em;opacity:0.5;vertical-align:baseline",
	sep: "opacity:0.35",
	detail: "opacity:0.5",
	mono: "font-family:var(--font-mono,monospace);font-size:0.85em;opacity:0.5;vertical-align:baseline",
	codePill: "font-family:var(--font-mono,monospace);font-size:0.85em;opacity:0.65;background:color-mix(in srgb, currentColor 10%, transparent);padding:0.1em 0.4em;border-radius:3px;vertical-align:baseline",
	wrap: "display:inline-flex;align-items:baseline;gap:0.4em;flex-wrap:wrap",
} as const;

/** Build the rich header as a TemplateResult with structured layout. */
function buildHeader(params: BgParams, result: ToolResultMessage | undefined, timerNode: TemplateResult): TemplateResult {
	const processName = resolveProcessName(params, result);
	const id = params.id || "";

	const badge = html`<span style="${S.badge}">bash_bg</span>`;
	const action = html`<span style="${S.action}">${params.action}</span>`;

	// Show process name with ID in parens, or just ID, or nothing
	const nameAndId = processName && id
		? html` <span style="${S.name}">${processName}</span> <span style="${S.id}">(${id})</span>`
		: processName
			? html` <span style="${S.name}">${processName}</span>`
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
			return html`<span style="${S.wrap}">${badge} ${action}${timerNode}</span>`;
	}

	const sep = detail ? html`<span style="${S.sep}">—</span>` : html``;

	return html`<span style="${S.wrap}">${badge} ${action}${nameAndId} ${sep} ${detail}${timerNode}</span>`;
}

/** Render the live elapsed timer span. `running` stops the counter when false. */
function renderCallTimer(params: BgParams, result: ToolResultMessage | undefined, running: boolean): TemplateResult {
	const startedAt = getCallStart(params, result);
	return html` <span style="${S.detail}" title="Elapsed since the tool call started">· <live-timer .startTime=${startedAt} .running=${running}></live-timer></span>`;
}

export class BgProcessRenderer implements ToolRenderer<BgParams> {
	render(
		params: BgParams | undefined,
		result: ToolResultMessage | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		// Only `wait` benefits from a live elapsed timer — other actions
		// (create, logs, grep, …) return effectively immediately.
		const timerRunning = !result || !!isStreaming;
		const timerNode = params?.action === "wait"
			? renderCallTimer(params, result, timerRunning)
			: html``;
		const headerContent = params ? buildHeader(params, result, timerNode) : html`<span>background process</span>`;
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
