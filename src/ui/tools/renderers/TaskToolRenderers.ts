/**
 * Renderers for task_list, task_create, task_update tools.
 * Compact task cards with state badges and assignment info.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { ListTodo, SquarePlus, SquarePen } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderSessionLink } from "./delegate-cards.js";

// ── Helpers ──────────────────────────────────────────────────────────

function getResult(result: ToolResultMessage | undefined): { text: string; data: any } {
	const text = result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	let data: any = null;
	try { data = JSON.parse(text); } catch { /* not JSON */ }
	return { text, data };
}

function stateBadge(state: string): TemplateResult {
	const styles: Record<string, string> = {
		todo: "bg-muted text-muted-foreground",
		"in-progress": "bg-blue-500/20 text-blue-600 dark:text-blue-400",
		blocked: "bg-red-500/20 text-red-600 dark:text-red-400",
		complete: "bg-green-500/20 text-green-600 dark:text-green-400",
		skipped: "bg-muted text-muted-foreground line-through",
	};
	const cls = styles[state] || "bg-muted text-muted-foreground";
	return html`<span class="px-1.5 py-0.5 rounded text-xs font-medium ${cls}">${state}</span>`;
}

function typeBadge(type: string): TemplateResult {
	const styles: Record<string, string> = {
		implementation: "text-blue-600 dark:text-blue-400",
		"code-review": "text-purple-600 dark:text-purple-400",
		testing: "text-green-600 dark:text-green-400",
		"bug-fix": "text-red-600 dark:text-red-400",
		refactor: "text-amber-600 dark:text-amber-400",
		custom: "text-muted-foreground",
	};
	const cls = styles[type] || "text-muted-foreground";
	return html`<span class="text-xs ${cls}">${type}</span>`;
}

function truncate(s: string, max = 60): string {
	if (!s) return "";
	return s.length > max ? s.slice(0, max) + "…" : s;
}

function renderTaskRow(t: any): TemplateResult {
	return html`
		<div class="flex items-center gap-2 text-xs py-0.5">
			${stateBadge(t.state || "todo")}
			${typeBadge(t.type || "custom")}
			<span class="font-medium truncate">${truncate(t.title || t.name || "Untitled", 50)}</span>
			${t.assignedTo ? html`<span class="text-muted-foreground">→</span> ${renderSessionLink(t.assignedTo)}` : ""}
		</div>
	`;
}

// ── task_list ────────────────────────────────────────────────────────

export class TaskListRenderer implements ToolRenderer {
	render(_params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		if (!result) {
			return { content: html`<div>${renderHeader(state, ListTodo, "Listing tasks…")}</div>`, isCustom: false };
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, ListTodo, skipped ? "Aborted task list — skipped due to queued message" : "Task list failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const tasks: any[] = data?.tasks || (Array.isArray(data) ? data : []);
		if (tasks.length === 0) {
			return { content: html`<div>${renderHeader(state, ListTodo, "No tasks")}</div>`, isCustom: false };
		}

		const byState = new Map<string, number>();
		for (const t of tasks) byState.set(t.state || "todo", (byState.get(t.state || "todo") || 0) + 1);
		const summary = Array.from(byState.entries()).map(([s, n]) => `${n} ${s}`).join(", ");

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`<div>
				${renderCollapsibleHeader(state, ListTodo, html`${tasks.length} tasks <span class="text-xs text-muted-foreground ml-1">(${summary})</span>`, contentRef, chevronRef, false)}
				<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
					<div class="mt-2 space-y-1">${tasks.map(renderTaskRow)}</div>
				</div>
			</div>`,
			isCustom: false,
		};
	}
}

// ── task_create ──────────────────────────────────────────────────────

export class TaskCreateRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const title = params?.title || "task";
		const type = params?.type;

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, SquarePlus, html`Creating task — ${type ? typeBadge(type) : ""} <span class="font-medium text-xs">${truncate(title)}</span>`)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			// Highlight 409 gate requirement errors
			const is409 = text.includes("409") || text.toLowerCase().includes("gate");
			const headerText = skipped
				? html`Aborted creation of task — <span class="font-medium text-xs">${truncate(title)}</span> — skipped due to queued message`
				: html`Failed to create task — <span class="font-medium text-xs">${truncate(title)}</span>`;
			const textCls = skipped ? "text-amber-600 dark:text-amber-400" : is409 ? "text-amber-600 dark:text-amber-400" : "text-destructive";
			return {
				content: html`<div>
					${renderHeader(state, SquarePlus, headerText)}
					<div class="mt-1 text-xs ${textCls}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const { data } = getResult(result);
		const taskId = data?.id ? data.id.slice(0, 8) : "";
		return {
			content: html`<div>${renderHeader(state, SquarePlus, html`Created ${type ? typeBadge(type) : ""} <span class="font-medium text-xs">${truncate(title)}</span> ${taskId ? html`<span class="text-xs text-muted-foreground font-mono">${taskId}</span>` : ""}`)}</div>`,
			isCustom: false,
		};
	}
}

// ── task_update ──────────────────────────────────────────────────────

export class TaskUpdateRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const taskId = params?.task_id ? params.task_id.slice(0, 8) : "task";

		// Build a summary of what's changing
		const changes: string[] = [];
		if (params?.state) changes.push(`→ ${params.state}`);
		if (params?.assigned_to) changes.push("assign");
		if (params?.title) changes.push("title");
		if (params?.spec) changes.push("spec");
		if (params?.result_summary) changes.push("result");
		const changeSummary = changes.join(", ");

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, SquarePen, html`Updating <span class="font-mono text-xs">${taskId}</span> ${changeSummary ? html`<span class="text-xs text-muted-foreground">(${changeSummary})</span>` : ""}`)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, SquarePen, skipped ? html`Aborted update of <span class="font-mono text-xs">${taskId}</span> — skipped due to queued message` : html`Failed to update <span class="font-mono text-xs">${taskId}</span>`)}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const { data } = getResult(result);
		const taskTitle = data?.title ? truncate(data.title, 40) : "";
		const newState = data?.state;

		return {
			content: html`<div>${renderHeader(state, SquarePen, html`Updated <span class="font-mono text-xs">${taskId}</span> ${taskTitle ? html`<span class="font-medium text-xs">${taskTitle}</span>` : ""} ${newState ? stateBadge(newState) : ""} ${params?.assigned_to ? html`<span class="text-xs text-muted-foreground">→</span> ${renderSessionLink(params.assigned_to)}` : ""}`)}</div>`,
			isCustom: false,
		};
	}
}
