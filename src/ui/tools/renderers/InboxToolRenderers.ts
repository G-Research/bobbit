/**
 * Renderers for the staff-inbox tools — inbox_list, inbox_complete, inbox_dismiss.
 *
 * Design — Option A "compact list":
 *   - inbox_list mirrors TaskListRenderer: collapsible header with counts,
 *     one-line rows (state badge · source icon · title · age · id chip).
 *   - inbox_complete / inbox_dismiss render a single-line status with the
 *     entry id chip, terminal-state badge, and the summary / reason text.
 *
 * The renderers tolerate missing fields — the server's response shape is
 * `{ entries: InboxEntry[] }` for list and a single `InboxEntry` for the
 * transition tools, but we never assume any field is present.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Cloud, Inbox, MailCheck, MailX, User, Zap } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { icon } from "@mariozechner/mini-lit";

// ── Helpers ──────────────────────────────────────────────────────────

function getResult(result: ToolResultMessage | undefined): { text: string; data: any } {
	const text = result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	let data: any = null;
	try { data = JSON.parse(text); } catch { /* not JSON */ }
	return { text, data };
}

function truncate(s: string, max = 60): string {
	if (!s) return "";
	return s.length > max ? s.slice(0, max) + "…" : s;
}

function shortId(id: string | undefined): string {
	if (!id || typeof id !== "string") return "";
	return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Short relative-age label ("now", "2m", "3h", "5d", "1mo"). Mirrors
 * `_relativeTime` in SearchResults.ts so display is consistent.
 */
function relativeAge(ts: number | undefined): string {
	if (!ts || typeof ts !== "number") return "";
	const diff = Math.max(0, Date.now() - ts);
	const seconds = Math.floor(diff / 1000);
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	const months = Math.floor(days / 30);
	return `${months}mo`;
}

/** State badge — matches the visual language used by TaskToolRenderers. */
function stateBadge(state: string): TemplateResult {
	const styles: Record<string, string> = {
		pending: "bg-blue-500/20 text-blue-600 dark:text-blue-400",
		completed: "bg-green-500/20 text-green-600 dark:text-green-400",
		failed: "bg-red-500/20 text-red-600 dark:text-red-400",
		cancelled: "bg-muted text-muted-foreground line-through",
	};
	const cls = styles[state] || "bg-muted text-muted-foreground";
	return html`<span class="px-1.5 py-0.5 rounded text-xs font-medium ${cls}">${state}</span>`;
}

/**
 * Source-type pill: trigger / api / ui with matching icon. The icon
 * disambiguates at a glance without taking a row's width.
 */
function sourcePill(source: any): TemplateResult {
	const type: string = source?.type || "";
	let label = "";
	let iconCmp: any = null;
	switch (type) {
		case "trigger":      label = "trigger"; iconCmp = Zap; break;
		case "manual_api":   label = "api";     iconCmp = Cloud; break;
		case "manual_ui":    label = "ui";      iconCmp = User; break;
		default: return html``;
	}
	return html`
		<span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
			<span class="inline-block">${icon(iconCmp, "sm")}</span>
			${label}
		</span>
	`;
}

/** Monospace 8-char entry-id chip. */
function idChip(id: string | undefined): TemplateResult {
	const s = shortId(id);
	if (!s) return html``;
	return html`<span class="font-mono text-xs text-muted-foreground">${s}</span>`;
}

function renderEntryRow(e: any): TemplateResult {
	return html`
		<div class="flex items-center gap-2 text-xs py-0.5 min-w-0">
			${stateBadge(e.state || "pending")}
			${sourcePill(e.source)}
			<span class="font-medium truncate flex-1 min-w-0">${truncate(e.title || "Untitled", 60)}</span>
			${e.createdAt ? html`<span class="text-xs text-muted-foreground shrink-0">${relativeAge(e.createdAt)}</span>` : ""}
			${idChip(e.id)}
		</div>
	`;
}

// ── inbox_list ───────────────────────────────────────────────────────

export class InboxListRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const filterLabel: string = params?.state || "pending";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, Inbox, html`Listing inbox <span class="text-xs text-muted-foreground">(${filterLabel})</span>…`)}</div>`,
				isCustom: false,
			};
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, Inbox, skipped ? "Aborted inbox list" : "Inbox list failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const entries: any[] = data?.entries || (Array.isArray(data) ? data : []);
		if (entries.length === 0) {
			return {
				content: html`<div>${renderHeader(state, Inbox, html`No ${filterLabel} entries`)}</div>`,
				isCustom: false,
			};
		}

		// Build a state breakdown for the collapsed header.
		const byState = new Map<string, number>();
		for (const e of entries) byState.set(e.state || "pending", (byState.get(e.state || "pending") || 0) + 1);
		const summary = Array.from(byState.entries()).map(([s, n]) => `${n} ${s}`).join(", ");

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const headerLabel = `${entries.length} inbox ${entries.length === 1 ? "entry" : "entries"}`;

		return {
			content: html`<div>
				${renderCollapsibleHeader(
					state,
					Inbox,
					html`${headerLabel} <span class="text-xs text-muted-foreground ml-1">(${summary})</span>`,
					contentRef,
					chevronRef,
					false,
				)}
				<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
					<div class="mt-2 space-y-1">${entries.map(renderEntryRow)}</div>
				</div>
			</div>`,
			isCustom: false,
		};
	}
}

// ── inbox_complete ───────────────────────────────────────────────────

export class InboxCompleteRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const id = shortId(params?.entry_id);

		if (!result) {
			return {
				content: html`<div>${renderHeader(
					state,
					MailCheck,
					html`Completing <span class="font-mono text-xs">${id}</span>…`,
				)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			const headerText = skipped
				? html`Aborted completing <span class="font-mono text-xs">${id}</span>`
				: html`Failed to complete <span class="font-mono text-xs">${id}</span>`;
			const textCls = skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive";
			return {
				content: html`<div>
					${renderHeader(state, MailCheck, headerText)}
					<div class="mt-1 text-xs ${textCls}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		// Success: header line + (optional) summary line. Pull title from the
		// returned entry when available so the row is recognisable.
		const { data } = getResult(result);
		const title = data?.title ? truncate(data.title, 50) : "";
		const summary: string | undefined = params?.summary || data?.result;

		return {
			content: html`<div>
				${renderHeader(
					state,
					MailCheck,
					html`Completed <span class="font-mono text-xs">${id}</span>
						${title ? html`<span class="font-medium text-xs">${title}</span>` : ""}
						${stateBadge("completed")}`,
				)}
				${summary ? html`<div class="mt-1 text-xs text-muted-foreground">${truncate(summary, 240)}</div>` : ""}
			</div>`,
			isCustom: false,
		};
	}
}

// ── inbox_dismiss ────────────────────────────────────────────────────

export class InboxDismissRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const id = shortId(params?.entry_id);
		const outcome: string = params?.outcome || "";

		if (!result) {
			return {
				content: html`<div>${renderHeader(
					state,
					MailX,
					html`Dismissing <span class="font-mono text-xs">${id}</span>${outcome ? html` <span class="text-xs text-muted-foreground">(${outcome})</span>` : ""}…`,
				)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			const headerText = skipped
				? html`Aborted dismissing <span class="font-mono text-xs">${id}</span>`
				: html`Failed to dismiss <span class="font-mono text-xs">${id}</span>`;
			const textCls = skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive";
			return {
				content: html`<div>
					${renderHeader(state, MailX, headerText)}
					<div class="mt-1 text-xs ${textCls}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const { data } = getResult(result);
		const title = data?.title ? truncate(data.title, 50) : "";
		const finalOutcome = data?.state || outcome || "failed";
		const reason: string | undefined = params?.reason || data?.error;

		return {
			content: html`<div>
				${renderHeader(
					state,
					MailX,
					html`Dismissed <span class="font-mono text-xs">${id}</span>
						${title ? html`<span class="font-medium text-xs">${title}</span>` : ""}
						${stateBadge(finalOutcome)}`,
				)}
				${reason ? html`<div class="mt-1 text-xs text-muted-foreground">${truncate(reason, 240)}</div>` : ""}
			</div>`,
			isCustom: false,
		};
	}
}
