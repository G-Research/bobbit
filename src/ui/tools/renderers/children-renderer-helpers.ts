/**
 * Shared helpers for the nine Children tool renderers.
 * Kept minimal — re-implements local helpers (getResult, truncate, stateBadge)
 * already used by TaskToolRenderers / TeamToolRenderers (those copies are not
 * exported). Tiny duplication is preferred to a refactor of the existing
 * renderers' internals.
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";

export function getResult(result: ToolResultMessage | undefined): { text: string; data: any } {
	const text = result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
	let data: any = null;
	try { data = JSON.parse(text); } catch { /* not JSON */ }
	return { text, data };
}

export function truncate(s: string, max = 60): string {
	if (!s) return "";
	return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Coloured pill for a goal state (matches dashboard pill semantics). */
export function stateBadge(state: string): TemplateResult {
	const styles: Record<string, string> = {
		pending: "bg-muted text-muted-foreground",
		"in-progress": "bg-blue-500/20 text-blue-600 dark:text-blue-400",
		complete: "bg-green-500/20 text-green-600 dark:text-green-400",
		archived: "bg-muted text-muted-foreground line-through",
		failed: "bg-red-500/20 text-red-600 dark:text-red-400",
		shelved: "bg-muted text-muted-foreground",
		spawned: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	};
	const cls = styles[state] || "bg-muted text-muted-foreground";
	return html`<span class="px-1.5 py-0.5 rounded text-xs font-medium ${cls}" data-testid="children-state-pill" data-state="${state}">${state}</span>`;
}

/** Mono chip showing the first 8 chars of a goal id. */
export function goalIdChip(id: string | undefined): TemplateResult | string {
	if (!id) return "";
	return html`<span class="font-mono text-xs text-muted-foreground" title="${id}">${id.slice(0, 8)}</span>`;
}

export function policyDescription(p: string | undefined): string {
	switch (p) {
		case "strict": return "Every replan requires user approval";
		case "balanced": return "Fix-ups auto-applied; expansion / restructure require approval";
		case "autonomous": return "All non-criteria-drop replans auto-applied";
		default: return "";
	}
}

/** Visual block bar for a small integer (1–8). */
export function concurrencyBar(n: number): TemplateResult {
	const count = Math.max(0, Math.min(8, Math.floor(Number(n) || 0)));
	const blocks = Array.from({ length: count }, (_, i) => i);
	return html`<span class="inline-flex gap-0.5 align-middle" aria-label="${count}">
		${blocks.map(() => html`<span class="inline-block w-1.5 h-3 rounded-sm bg-primary/70"></span>`)}
	</span>`;
}

/** Classification → badge tuple. */
export function classificationBadge(classification: string | undefined): TemplateResult | string {
	if (!classification) return "";
	const styles: Record<string, string> = {
		noop: "bg-muted text-muted-foreground",
		"fix-up": "bg-blue-500/20 text-blue-600 dark:text-blue-400",
		expansion: "bg-amber-500/20 text-amber-600 dark:text-amber-400",
		restructure: "bg-purple-500/20 text-purple-600 dark:text-purple-400",
		"criteria-drop": "bg-red-500/20 text-red-600 dark:text-red-400",
	};
	const cls = styles[classification] || "bg-muted text-muted-foreground";
	return html`<span class="px-1.5 py-0.5 rounded text-xs font-medium ${cls}" data-testid="children-classification-badge" data-classification="${classification}">${classification}</span>`;
}

/** Resolve the current session's goalId from ctx (preferred) or DOM fallback. */
export function resolveGoalId(ctx: any): string | undefined {
	if (ctx?.goalId) return ctx.goalId as string;
	if (typeof document !== "undefined") {
		const attr = document.documentElement?.dataset?.currentGoalId;
		if (attr) return attr;
	}
	return undefined;
}

export function parseParams(params: any): Record<string, any> | null {
	if (!params) return null;
	if (typeof params === "object" && params !== null && !Array.isArray(params)) return params;
	if (typeof params === "string") {
		try { return JSON.parse(params); } catch { return null; }
	}
	return null;
}
