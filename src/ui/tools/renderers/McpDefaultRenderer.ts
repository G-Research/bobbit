import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, nothing } from "lit";
import { Plug } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { getToolState, renderHeader } from "../renderer-registry.js";
import type { ToolRenderContext, ToolRenderer, ToolRenderResult } from "../types.js";
import { renderInlineImages } from "./image-utils.js";
import { renderPayloadSection } from "./payload-section.js";

const ERROR_PREVIEW_MAX_LENGTH = 500;
const LARGE_ARG_PREVIEW_MAX = 120;
const MAX_VISIBLE_ARGS = 6;
const SENSITIVE_ARG_RE = /(api[-_]?key|key|token|secret|password|authorization|credential|cookie)/i;
const SECRET_VALUE_RE = /\b(?:Bearer\s+[A-Za-z0-9._~+\/-]{10,}|sk-[A-Za-z0-9_-]{10,}|gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9._-]{10,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/i;

export function isMcpToolName(toolName: string): boolean {
	if (toolName === "mcp_describe") return false;
	return toolName.startsWith("mcp__") || (toolName.startsWith("mcp_") && !toolName.startsWith("mcp__") && toolName.length > "mcp_".length);
}

function containsSensitiveText(text: string): boolean {
	return SENSITIVE_ARG_RE.test(text) || SECRET_VALUE_RE.test(text);
}

function redactSensitiveText(text: string): string {
	return text
		.replace(/\b(authorization)(["'\s:=]+)(bearer\s+)?[^,\r\n}"']+/gi, "$1$2[redacted]")
		.replace(/\b(api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|key|token|secret|password|credential|cookie)(["'\s:=]+)[^,\s&}"']+/gi, "$1$2[redacted]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{10,}/gi, "Bearer [redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "sk-[redacted]")
		.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "gh_[redacted]")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[redacted]")
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "xox-[redacted]")
		.replace(/\bya29\.[A-Za-z0-9._-]{10,}\b/g, "ya29.[redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "jwt-[redacted]");
}

function redactSensitive(value: unknown): unknown {
	if (typeof value === "string") return redactSensitiveText(value);
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(redactSensitive);
	const out: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		out[key] = SENSITIVE_ARG_RE.test(key) ? "[redacted]" : redactSensitive(nested);
	}
	return out;
}

function truncateErrorPreview(text: string): string {
	const trimmed = text.trim();
	let redacted = redactSensitiveText(trimmed);
	try {
		redacted = JSON.stringify(redactSensitive(JSON.parse(trimmed)), null, 2);
	} catch {
		// Non-JSON errors are still lightly redacted above.
	}
	if (redacted.length <= ERROR_PREVIEW_MAX_LENGTH) return redacted;
	return `${redacted.slice(0, ERROR_PREVIEW_MAX_LENGTH)}…`;
}

function parsePayload(value: unknown): unknown {
	if (typeof value === "string") {
		try { return JSON.parse(value); } catch { return value; }
	}
	return value;
}

function payloadJson(value: unknown): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(redactSensitive(parsePayload(value)), null, 2);
	} catch {
		try { return JSON.stringify(redactSensitive(value), null, 2); } catch { return redactSensitiveText(String(value)); }
	}
}

function outputPayload(result: ToolResultMessage | undefined): { raw: string; code: string; language: string } {
	const raw = result?.content
		?.filter((c) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n") || i18n("(no output)");
	try {
		return { raw, code: JSON.stringify(redactSensitive(JSON.parse(raw)), null, 2), language: "json" };
	} catch {
		return { raw, code: redactSensitiveText(raw), language: "text" };
	}
}

function parsePerOpName(toolName: string): { server: string; sub?: string; op: string } | null {
	if (!toolName.startsWith("mcp__")) return null;
	const remainder = toolName.slice(5);
	const idx = remainder.indexOf("__");
	if (idx <= 0) return null;
	const server = remainder.slice(0, idx);
	const after = remainder.slice(idx + 2);
	if (!after) return null;
	const subIdx = after.indexOf("__");
	if (subIdx === -1) return { server, op: after };
	const sub = after.slice(0, subIdx);
	const op = after.slice(subIdx + 2);
	return sub && op ? { server, sub, op } : { server, op: after };
}

function parseMetaName(toolName: string): { server: string; sub?: string } | null {
	if (!toolName.startsWith("mcp_") || toolName.startsWith("mcp__")) return null;
	const rest = toolName.slice(4);
	if (!rest) return null;
	const subIdx = rest.indexOf("__");
	if (subIdx === -1) return { server: rest };
	const server = rest.slice(0, subIdx);
	const sub = rest.slice(subIdx + 2);
	return server && sub ? { server, sub } : { server: rest };
}

function inputObject(value: unknown): Record<string, unknown> | undefined {
	const parsed = parsePayload(value);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

function containsSensitiveData(value: unknown): boolean {
	if (typeof value === "string") return containsSensitiveText(value);
	if (!value || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(containsSensitiveData);
	return Object.entries(value as Record<string, unknown>).some(([key, nested]) => SENSITIVE_ARG_RE.test(key) || containsSensitiveData(nested));
}

function summarizeValue(value: unknown): string | null {
	let preview: string;
	if (typeof value === "string") preview = JSON.stringify(value);
	else if (value === null || typeof value === "number" || typeof value === "boolean") preview = String(value);
	else {
		try { preview = JSON.stringify(value); } catch { return null; }
	}
	if (preview.length > LARGE_ARG_PREVIEW_MAX) return null;
	return preview;
}

function mcpInvocation(toolName: string, input: Record<string, unknown> | undefined) {
	const perOp = parsePerOpName(toolName);
	if (perOp) {
		return { server: perOp.server, sub: perOp.sub, op: perOp.op, args: input ?? {} };
	}
	const meta = parseMetaName(toolName);
	const operation = typeof input?.operation === "string" ? input.operation : undefined;
	const args = inputObject(input?.args) ?? {};
	return {
		server: meta?.server ?? toolName,
		sub: meta?.sub,
		op: operation,
		args,
	};
}

function renderArgSummary(args: Record<string, unknown>) {
	const entries = Object.entries(args);
	if (entries.length === 0) return nothing;
	let omittedLarge = 0;
	let omittedExtra = 0;
	const visible: Array<[string, string]> = [];
	for (const [key, value] of entries) {
		if (SENSITIVE_ARG_RE.test(key) || containsSensitiveData(value)) {
			omittedLarge++;
			continue;
		}
		const summary = summarizeValue(value);
		if (summary === null) {
			omittedLarge++;
			continue;
		}
		if (visible.length >= MAX_VISIBLE_ARGS) {
			omittedExtra++;
			continue;
		}
		visible.push([key, summary]);
	}
	return html`
		<div class="space-y-1" data-mcp-arg-summary>
			<div class="text-xs font-medium text-muted-foreground">Arguments</div>
			${visible.length > 0 ? html`
				<div class="flex flex-wrap gap-1.5">
					${visible.map(([key, value]) => html`
						<span class="rounded border border-border bg-muted/20 px-1.5 py-0.5 text-xs">
							<span class="font-mono text-muted-foreground">${key}</span>
							<span class="text-muted-foreground">:</span>
							<span class="font-mono text-foreground break-all">${value}</span>
						</span>
					`)}
				</div>
			` : nothing}
			${omittedLarge || omittedExtra ? html`
				<div class="text-[11px] text-muted-foreground">
					${omittedLarge ? `${omittedLarge} large argument${omittedLarge === 1 ? "" : "s"} kept in Input JSON` : ""}
					${omittedLarge && omittedExtra ? "; " : ""}
					${omittedExtra ? `${omittedExtra} more argument${omittedExtra === 1 ? "" : "s"} kept in Input JSON` : ""}
				</div>
			` : nothing}
		</div>
	`;
}

export class McpDefaultRenderer implements ToolRenderer {
	private toolName: string;

	constructor(toolName: string) {
		this.toolName = toolName;
	}

	withToolName(name: string): McpDefaultRenderer {
		return new McpDefaultRenderer(name);
	}

	private renderInvocation(input: Record<string, unknown> | undefined) {
		const invocation = mcpInvocation(this.toolName, input);
		const target = invocation.sub ? `${invocation.server}/${invocation.sub}` : invocation.server;
		const op = invocation.op ?? "operation pending";
		return {
			header: html`
				<span class="min-w-0">
					<span>MCP: <span class="font-mono text-foreground">${target}</span> → <span class="font-mono text-foreground">${op}</span></span>
					<span class="ml-2 font-mono text-[11px] text-muted-foreground/80">${this.toolName}</span>
				</span>
			`,
			args: invocation.args,
		};
	}

	render(params: unknown | undefined, result: ToolResultMessage | undefined, isStreaming?: boolean, ctx?: ToolRenderContext): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const rawInput = params !== undefined ? params : ctx?.toolCallInput;
		const input = inputObject(rawInput);
		const inputJson = payloadJson(rawInput);
		const invocation = this.renderInvocation(input);

		if (result) {
			const output = outputPayload(result);
			const errorPreview = state === "error" ? truncateErrorPreview(output.raw) : "";
			const images = renderInlineImages(result.content);
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, Plug, invocation.header)}
						${renderArgSummary(invocation.args)}
						${errorPreview ? html`<div class="text-sm text-destructive whitespace-pre-wrap break-words" role="alert">${errorPreview}</div>` : ""}
						${inputJson ? renderPayloadSection(i18n("Input"), inputJson, "json") : ""}
						${renderPayloadSection(i18n("Output"), output.code, output.language)}
						${images}
					</div>
				`,
				isCustom: false,
			};
		}

		if (rawInput !== undefined) {
			if (isStreaming && (!inputJson || inputJson === "{}" || inputJson === "null")) {
				return {
					content: html`<div>${renderHeader(state, Plug, "Preparing MCP tool...")}</div>`,
					isCustom: false,
				};
			}
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, Plug, invocation.header)}
						${renderArgSummary(invocation.args)}
						${inputJson ? renderPayloadSection(i18n("Input"), inputJson, "json") : ""}
					</div>
				`,
				isCustom: false,
			};
		}

		return {
			content: html`<div>${renderHeader(state, Plug, "Preparing MCP tool...")}</div>`,
			isCustom: false,
		};
	}
}
