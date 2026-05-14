/**
 * Shared helpers for LSP tool renderers.
 *
 * The renderers consume the wire shape produced by
 * `src/server/lsp/supervisor.ts::dispatch` — paths come back relative to cwd,
 * positions are 0-indexed LSP coordinates, and errors arrive as an envelope:
 *   `{ error: "lsp_unavailable" | "lsp_capacity" | "lsp_timeout", message }`.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html, type TemplateResult } from "lit";
import {
	AlertTriangle,
	Box,
	CircleAlert,
	Cog,
	FileText,
	FileType2,
	FunctionSquare,
	Info,
	Lightbulb,
	Lock,
	Tag,
	Variable,
} from "lucide";

// ── LSP SymbolKind ───────────────────────────────────────────────────
// https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind

const SYMBOL_KINDS: Record<number, { label: string; icon: any }> = {
	1: { label: "File", icon: FileText },
	2: { label: "Module", icon: Box },
	3: { label: "Namespace", icon: Box },
	4: { label: "Package", icon: Box },
	5: { label: "Class", icon: Box },
	6: { label: "Method", icon: Cog },
	7: { label: "Property", icon: Tag },
	8: { label: "Field", icon: Tag },
	9: { label: "Constructor", icon: Cog },
	10: { label: "Enum", icon: Box },
	11: { label: "Interface", icon: FileType2 },
	12: { label: "Function", icon: FunctionSquare },
	13: { label: "Variable", icon: Variable },
	14: { label: "Constant", icon: Lock },
	15: { label: "String", icon: FileText },
	16: { label: "Number", icon: FileText },
	17: { label: "Boolean", icon: FileText },
	18: { label: "Array", icon: FileText },
	19: { label: "Object", icon: FileText },
	20: { label: "Key", icon: Tag },
	21: { label: "Null", icon: FileText },
	22: { label: "EnumMember", icon: Tag },
	23: { label: "Struct", icon: Box },
	24: { label: "Event", icon: Tag },
	25: { label: "Operator", icon: Tag },
	26: { label: "TypeParameter", icon: FileType2 },
};

export function symbolKindLabel(n: number): { label: string; icon: any } {
	return SYMBOL_KINDS[n] || { label: "Symbol", icon: FileText };
}

// ── Diagnostic severity ──────────────────────────────────────────────
// Server wire format: string severity (typescript.ts converts numeric LSP severity to string)

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

const SEVERITY: Record<DiagnosticSeverity, { label: string; color: string; icon: any }> = {
	error: { label: "Error", color: "text-destructive", icon: CircleAlert },
	warning: { label: "Warning", color: "text-amber-600 dark:text-amber-500", icon: AlertTriangle },
	info: { label: "Info", color: "text-blue-600 dark:text-blue-400", icon: Info },
	hint: { label: "Hint", color: "text-muted-foreground", icon: Lightbulb },
};

export function severityLabel(s: DiagnosticSeverity | string): { label: string; color: string; icon: any } {
	return SEVERITY[s as DiagnosticSeverity] ?? SEVERITY.info;
}

// ── Location rendering ───────────────────────────────────────────────

export interface LspLocation {
	path: string;
	range: { start: { line: number; character: number }; end?: { line: number; character: number } };
}

/** Strip the `file://` URI prefix that the rename tool sometimes leaks through. */
export function normalisePath(p: string): string {
	if (!p) return p;
	if (p.startsWith("file://")) {
		const stripped = p.slice("file://".length);
		// Windows paths come through as `file:///C:/…` — drop the extra slash.
		return stripped.replace(/^\/(?=[A-Za-z]:)/, "");
	}
	return p;
}

export function renderLocationRow(loc: LspLocation): TemplateResult {
	const path = normalisePath(loc.path);
	const line = (loc.range?.start?.line ?? 0) + 1;
	return html`<span class="font-mono text-sm">${path}:${line}</span>`;
}

// ── Error envelope ───────────────────────────────────────────────────

const LSP_ERROR_CODES = new Set(["lsp_unavailable", "lsp_capacity", "lsp_timeout"]);

const ERROR_HINTS: Record<string, string> = {
	lsp_unavailable: "LSP unavailable — try grep.",
	lsp_capacity: "LSP at capacity — retry shortly or fall back to grep.",
	lsp_timeout: "LSP timed out — try grep for this lookup.",
};

export function isLspErrorEnvelope(body: any): boolean {
	return !!body && typeof body === "object" && typeof body.error === "string" && LSP_ERROR_CODES.has(body.error);
}

export function renderLspErrorEnvelope(body: any): TemplateResult | null {
	if (!isLspErrorEnvelope(body)) return null;
	const hint = ERROR_HINTS[body.error as string] || "LSP unavailable.";
	return html`
		<div class="mt-2 text-sm rounded border border-amber-500/40 bg-amber-500/10 p-2 flex items-start gap-2">
			<span class="inline-block text-amber-600 dark:text-amber-500 shrink-0">${icon(AlertTriangle, "sm")}</span>
			<div class="min-w-0">
				<div class="text-amber-700 dark:text-amber-400 font-medium">${hint}</div>
				${body.message ? html`<div class="text-xs text-muted-foreground mt-0.5">${body.message}</div>` : ""}
			</div>
		</div>
	`;
}

// ── Result parsing ───────────────────────────────────────────────────

export function parseLspResult(result: ToolResultMessage | undefined): any | null {
	if (!result) return null;
	const text = result.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || "";
	if (!text.trim()) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Compact path:line:col cell. Used by diagnostics rendering. */
export function renderPathLineCol(path: string, line: number, character: number): TemplateResult {
	const p = normalisePath(path);
	return html`<span class="font-mono text-xs text-muted-foreground">${p}:${line + 1}:${character + 1}</span>`;
}

// ── Diagnostics helpers ──────────────────────────────────────────────

export interface Diagnostic {
	path: string;
	range: { start: { line: number; character: number } };
	severity: DiagnosticSeverity | string;
	message: string;
	source?: string;
}

const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2, hint: 3 };
export function sevOrder(s: string): number { return SEV_ORDER[s] ?? 2; }

export function summariseDiagnostics(diags: Diagnostic[]): string {
	const counts: Record<string, number> = {};
	for (const d of diags) counts[d.severity] = (counts[d.severity] || 0) + 1;
	const parts: string[] = [];
	const plural: Record<string, [string, string]> = {
		error: ["error", "errors"], warning: ["warning", "warnings"], info: ["info", "info"], hint: ["hint", "hints"],
	};
	for (const sev of ["error", "warning", "info", "hint"] as const) {
		const c = counts[sev];
		if (c) parts.push(`${c} ${c === 1 ? plural[sev][0] : plural[sev][1]}`);
	}
	return parts.join(", ") || "0 diagnostics";
}

// ── Document symbol tree rendering ───────────────────────────────────

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: { start: { line: number; character: number } };
	selectionRange?: any;
	children?: DocumentSymbol[];
}

export const DOC_SYM_MAX_DEPTH = 3;

export function countNested(syms: DocumentSymbol[]): number {
	let n = 0;
	for (const s of syms) { n += 1; if (s.children?.length) n += countNested(s.children); }
	return n;
}

export function renderSymbolRow(s: DocumentSymbol): TemplateResult {
	const kind = symbolKindLabel(s.kind);
	const line = (s.range?.start?.line ?? 0) + 1;
	return html`
		<div class="flex items-center gap-1.5 text-sm py-0.5">
			<span class="inline-block text-muted-foreground shrink-0" title=${kind.label}>${icon(kind.icon, "sm")}</span>
			<span class="font-mono">${s.name}</span>
			${s.detail ? html`<span class="text-xs text-muted-foreground truncate">: ${s.detail}</span>` : ""}
			<span class="text-xs text-muted-foreground shrink-0 ml-auto">:${line}</span>
		</div>
	`;
}

export function renderSymbolTree(syms: DocumentSymbol[], depth: number): TemplateResult {
	if (depth >= DOC_SYM_MAX_DEPTH) {
		const n = countNested(syms);
		// Collapsed JSON fallback so power users can still access truncated data.
		return html`
			<details class="pl-4">
				<summary class="text-xs text-muted-foreground italic cursor-pointer list-none">(${n} more nested symbol${n === 1 ? "" : "s"})</summary>
				<pre class="text-xs font-mono overflow-auto max-h-[200px] bg-muted/50 rounded p-2 mt-1">${JSON.stringify(syms, null, 2)}</pre>
			</details>
		`;
	}
	return html`
		<ul class="space-y-0 ${depth === 0 ? "" : "pl-4 border-l border-border ml-2"}">
			${syms.map(s => s.children?.length
				? html`<li><details ?open=${depth === 0}><summary class="cursor-pointer hover:bg-accent/50 rounded list-none">${renderSymbolRow(s)}</summary>${renderSymbolTree(s.children, depth + 1)}</details></li>`
				: html`<li>${renderSymbolRow(s)}</li>`)}
		</ul>
	`;
}
