import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { Code } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderInlineImages } from "./image-utils.js";
import { renderPayloadSection } from "./payload-section.js";

const ERROR_PREVIEW_MAX_LENGTH = 500;
const TITLE_BADGE_MAX_COUNT = 4;
const TITLE_BADGE_MAX_VALUE_LENGTH = 36;
const TITLE_BADGE_MAX_TOTAL_LENGTH = 90;
const TITLE_FIELD_PRIORITY = [
	"action", "operation", "type", "state",
	"name", "title", "server", "provider", "selector", "outputPath",
	"scope", "view", "probe", "level", "size", "imageSize", "aspectRatio", "format", "limit", "width", "height",
];
const TITLE_FIELD_SKIP = new Set(["body", "config", "prompt", "values", "questions", "content", "metadata"]);
const SENSITIVE_FIELD_RE = /(api[-_]?key|key|token|secret|password|authorization|credential|cookie)/i;
const SECRET_VALUE_RE = /\b(?:Bearer\s+[A-Za-z0-9._~+\/-]{10,}|sk-[A-Za-z0-9_-]{10,}|gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9._-]{10,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/i;

function containsSensitiveText(text: string): boolean {
	return SENSITIVE_FIELD_RE.test(text) || SECRET_VALUE_RE.test(text);
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
		out[key] = SENSITIVE_FIELD_RE.test(key) ? "[redacted]" : redactSensitive(nested);
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

function parseParams(params: unknown): unknown {
	if (typeof params === "string") {
		try { return JSON.parse(params); } catch { return params; }
	}
	return params;
}

function paramsObject(params: unknown): Record<string, unknown> | undefined {
	const parsed = parseParams(params);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	return parsed as Record<string, unknown>;
}

function compactTitleValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed || containsSensitiveText(trimmed) || trimmed.length > TITLE_BADGE_MAX_VALUE_LENGTH) return undefined;
		return trimmed;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function titleBadgesFromParams(params: unknown): Array<{ field: string; value: string } | { more: number }> {
	const obj = paramsObject(params);
	if (!obj) return [];
	const fields = Object.keys(obj);
	const shown = new Set<string>();
	const badges: Array<{ field: string; value: string }> = [];
	let totalLength = 0;
	const candidates = [
		...TITLE_FIELD_PRIORITY.filter((field) => fields.includes(field)),
		...fields.filter((field) => !TITLE_FIELD_PRIORITY.includes(field)),
	];
	for (const field of candidates) {
		if (badges.length >= TITLE_BADGE_MAX_COUNT) break;
		if (shown.has(field) || TITLE_FIELD_SKIP.has(field) || SENSITIVE_FIELD_RE.test(field)) continue;
		const value = compactTitleValue(obj[field]);
		if (!value) continue;
		const length = field.length + value.length + 1;
		if (totalLength + length > TITLE_BADGE_MAX_TOTAL_LENGTH) break;
		badges.push({ field, value });
		shown.add(field);
		totalLength += length;
	}
	const more = fields.filter((field) => !shown.has(field)).length;
	return more > 0 ? [...badges, { more }] : badges;
}

export class DefaultRenderer implements ToolRenderer {
	private toolName?: string;

	constructor(toolName?: string) {
		this.toolName = toolName;
	}

	/** Create a renderer with a specific tool name for display */
	withToolName(name: string): DefaultRenderer {
		return new DefaultRenderer(name);
	}

	private get label(): string {
		if (!this.toolName) return "Tool Call";
		// Format tool name: snake_case/camelCase → Title Case
		return this.toolName
			.replace(/[_-]/g, " ")
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/\b\w/g, (c) => c.toUpperCase());
	}

	private title(params: unknown) {
		const badges = titleBadgesFromParams(params);
		if (badges.length === 0) return this.label;
		return html`
			<span class="min-w-0">
				<span>${this.label}</span>
				${badges.map((badge) => "more" in badge ? html`
					<span class="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">+${badge.more} more</span>
				` : html`
					<span class="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
						${badge.field}=<span class="font-mono text-foreground">${badge.value}</span>
					</span>
				`)}
			</span>
		`;
	}

	render(params: any | undefined, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		// Format params as JSON
		let paramsJson = "";
		if (params) {
			try {
				paramsJson = JSON.stringify(redactSensitive(JSON.parse(params)), null, 2);
			} catch {
				try {
					paramsJson = JSON.stringify(redactSensitive(params), null, 2);
				} catch {
					paramsJson = redactSensitiveText(String(params));
				}
			}
		}

		// With result: show header + params + result
		if (result) {
			const rawOutputText =
				result.content
					?.filter((c) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || i18n("(no output)");
			let outputJson = rawOutputText;
			let outputLanguage = "text";

			// Try to parse and pretty-print if it's valid JSON
			try {
				const parsed = JSON.parse(outputJson);
				outputJson = JSON.stringify(redactSensitive(parsed), null, 2);
				outputLanguage = "json";
			} catch {
				// Not valid JSON, leave as text after lightweight secret redaction.
				outputJson = redactSensitiveText(outputJson);
			}

			const errorPreview = state === "error" ? truncateErrorPreview(rawOutputText) : "";
			const images = renderInlineImages(result.content);
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, Code, this.title(params))}
						${errorPreview ? html`<div class="text-sm text-destructive whitespace-pre-wrap break-words" role="alert">${errorPreview}</div>` : ""}
						${paramsJson ? renderPayloadSection(i18n("Input"), paramsJson, "json") : ""}
						${renderPayloadSection(i18n("Output"), outputJson, outputLanguage)}
						${images}
					</div>
				`,
				isCustom: false,
			};
		}

		// Just params (streaming or waiting for result)
		if (params) {
			if (isStreaming && (!paramsJson || paramsJson === "{}" || paramsJson === "null")) {
				return {
					content: html`
						<div>
							${renderHeader(state, Code, `${i18n("Preparing")} ${this.label.toLowerCase()}...`)}
						</div>
					`,
					isCustom: false,
				};
			}

			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, Code, this.title(params))}
						${renderPayloadSection(i18n("Input"), paramsJson, "json")}
					</div>
				`,
				isCustom: false,
			};
		}

		// No params or result yet
		return {
			content: html`
				<div>
					${renderHeader(state, Code, `${i18n("Preparing")} ${this.label.toLowerCase()}...`)}
				</div>
			`,
			isCustom: false,
		};
	}
}
