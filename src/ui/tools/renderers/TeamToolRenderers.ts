/**
 * Renderers for team_spawn, team_list, team_dismiss, team_complete tools.
 * Compact, human-readable output for team coordination at a glance.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Users, UserPlus, UserMinus, Trophy, Zap, MessageSquare, AlertTriangle } from "lucide";
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

function roleBadge(role: string): TemplateResult {
	const colors: Record<string, string> = {
		"team-lead": "bg-amber-500/20 text-amber-600 dark:text-amber-400",
		coder: "bg-blue-500/20 text-blue-600 dark:text-blue-400",
		reviewer: "bg-purple-500/20 text-purple-600 dark:text-purple-400",
		tester: "bg-green-500/20 text-green-600 dark:text-green-400",
	};
	const cls = colors[role] || "bg-muted text-muted-foreground";
	return html`<span class="px-1.5 py-0.5 rounded text-xs font-medium ${cls}">${role}</span>`;
}

function statusDot(status: string): TemplateResult {
	const s = status?.toLowerCase() || "unknown";
	if (s === "idle" || s === "completed") return html`<span class="inline-block w-1.5 h-1.5 rounded-full bg-green-500" title="${status}"></span>`;
	if (s === "streaming" || s === "running" || s === "working") return html`<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" title="${status}"></span>`;
	return html`<span class="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground" title="${status}"></span>`;
}

function truncate(s: string, max = 60): string {
	if (!s) return "";
	return s.length > max ? s.slice(0, max) + "…" : s;
}

// ── team_spawn ───────────────────────────────────────────────────────

export class TeamSpawnRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const role = params?.role || "agent";
		const task = params?.task ? truncate(params.task, 80) : "";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, UserPlus, html`Spawning ${roleBadge(role)} ${task ? html`— <span class="text-xs text-muted-foreground">${task}</span>` : ""}`)}</div>`,
				isCustom: false,
			};
		}

		const { data } = getResult(result);
		const sessionId = data?.sessionId || data?.session_id;
		const headerContent = html`Spawned ${roleBadge(role)} ${sessionId ? renderSessionLink(sessionId) : ""} ${task ? html`— <span class="text-xs text-muted-foreground">${task}</span>` : ""}`;

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, UserPlus, skipped ? html`Aborted spawn of ${roleBadge(role)} — skipped due to queued message` : html`Failed to spawn ${roleBadge(role)}`)}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>${renderHeader(state, UserPlus, headerContent)}</div>`,
			isCustom: false,
		};
	}
}

// ── team_list ────────────────────────────────────────────────────────

export class TeamListRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		if (!result) {
			return { content: html`<div>${renderHeader(state, Users, "Listing team agents…")}</div>`, isCustom: false };
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, Users, skipped ? "Aborted team list — skipped due to queued message" : "Team list failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const agents: any[] = data?.agents || (Array.isArray(data) ? data : []);
		if (agents.length === 0) {
			return { content: html`<div>${renderHeader(state, Users, "Team — no agents")}</div>`, isCustom: false };
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const byRole = new Map<string, number>();
		for (const a of agents) byRole.set(a.role, (byRole.get(a.role) || 0) + 1);
		const summary = Array.from(byRole.entries()).map(([r, n]) => `${n} ${r}${n > 1 ? "s" : ""}`).join(", ");

		return {
			content: html`<div>
				${renderCollapsibleHeader(state, Users, html`Team — ${agents.length} agents <span class="text-xs text-muted-foreground ml-1">(${summary})</span>`, contentRef, chevronRef, false)}
				<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
					<div class="mt-2 space-y-1">
						${agents.map((a: any) => html`
							<div class="flex items-center gap-2 text-xs py-0.5">
								${statusDot(a.status || "")}
								${roleBadge(a.role)}
								${a.sessionId ? renderSessionLink(a.sessionId) : ""}
								<span class="text-muted-foreground truncate">${truncate(a.task || a.title || "", 50)}</span>
							</div>
						`)}
					</div>
				</div>
			</div>`,
			isCustom: false,
		};
	}
}

// ── team_dismiss ─────────────────────────────────────────────────────

export class TeamDismissRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const sid = params?.session_id;

		if (!result) {
			return { content: html`<div>${renderHeader(state, UserMinus, html`Dismissing agent ${sid ? renderSessionLink(sid) : ""}`)}</div>`, isCustom: false };
		}

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, UserMinus, skipped ? html`Aborted dismiss — skipped due to queued message` : html`Failed to dismiss agent`)}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>${renderHeader(state, UserMinus, html`Dismissed agent ${sid ? renderSessionLink(sid) : ""}`)}</div>`,
			isCustom: false,
		};
	}
}

// ── team_complete ────────────────────────────────────────────────────

export class TeamCompleteRenderer implements ToolRenderer {
	render(_params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		if (!result) {
			return { content: html`<div>${renderHeader(state, Trophy, "Completing team…")}</div>`, isCustom: false };
		}

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, Trophy, skipped ? "Aborted team completion — skipped due to queued message" : "Team completion failed")}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>${renderHeader(state, Trophy, html`Team completed — all agents dismissed`)}</div>`,
			isCustom: false,
		};
	}
}

// ── team_steer ───────────────────────────────────────────────────────

export class TeamSteerRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const sid = params?.session_id;
		const msg = params?.message ? truncate(params.message, 80) : "";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, Zap, html`Steering ${sid ? renderSessionLink(sid) : "agent"} ${msg ? html`— <span class="text-xs text-muted-foreground">${msg}</span>` : ""}`)}</div>`,
				isCustom: false,
			};
		}

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, Zap, skipped ? html`Aborted steer ${sid ? renderSessionLink(sid) : ""} — skipped due to queued message` : html`Steer failed ${sid ? renderSessionLink(sid) : ""}`)}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>${renderHeader(state, Zap, html`Steered ${sid ? renderSessionLink(sid) : "agent"} ${msg ? html`— <span class="text-xs text-muted-foreground">${msg}</span>` : ""}`)}</div>`,
			isCustom: false,
		};
	}
}

// ── team_prompt ──────────────────────────────────────────────────────

export class TeamPromptRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const sid = params?.session_id;
		const msg = params?.message ? truncate(params.message, 80) : "";

		if (!result) {
			return {
				content: html`<div>${renderHeader(state, MessageSquare, html`Prompting ${sid ? renderSessionLink(sid) : "agent"} ${msg ? html`— <span class="text-xs text-muted-foreground">${msg}</span>` : ""}`)}</div>`,
				isCustom: false,
			};
		}

		const { data, text } = getResult(result);
		if (result.isError) {
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, MessageSquare, skipped ? html`Aborted prompt ${sid ? renderSessionLink(sid) : ""} — skipped due to queued message` : html`Prompt failed ${sid ? renderSessionLink(sid) : ""}`)}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const status = data?.status || "sent";
		const statusLabel = status === "queued" ? "queued" : "dispatched";
		return {
			content: html`<div>${renderHeader(state, MessageSquare, html`Prompted ${sid ? renderSessionLink(sid) : "agent"} <span class="text-xs text-muted-foreground">(${statusLabel})</span> ${msg ? html`— <span class="text-xs text-muted-foreground">${msg}</span>` : ""}`)}</div>`,
			isCustom: false,
		};
	}
}

// ── team_abort ───────────────────────────────────────────────────────

export class TeamAbortRenderer implements ToolRenderer {
	render(params: any, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const sid = params?.session_id;

		if (!result) {
			return { content: html`<div>${renderHeader(state, AlertTriangle, html`Aborting ${sid ? renderSessionLink(sid) : "agent"}`)}</div>`, isCustom: false };
		}

		if (result.isError) {
			const { text } = getResult(result);
			const skipped = isSkippedToolResult(result);
			return {
				content: html`<div>
					${renderHeader(state, AlertTriangle, skipped ? html`Aborted abort ${sid ? renderSessionLink(sid) : ""} — skipped due to queued message` : html`Abort failed ${sid ? renderSessionLink(sid) : ""}`)}
					<div class="mt-1 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${text}</div>
				</div>`,
				isCustom: false,
			};
		}

		const { data } = getResult(result);
		const status = data?.status || "aborted";
		return {
			content: html`<div>${renderHeader(state, AlertTriangle, html`Aborted ${sid ? renderSessionLink(sid) : "agent"} — <span class="text-xs text-muted-foreground">${status}</span>`)}</div>`,
			isCustom: false,
		};
	}
}
