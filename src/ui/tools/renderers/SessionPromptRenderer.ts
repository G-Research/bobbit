import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { MessageSquare, Zap } from "lucide";
import { getToolState, isSkippedToolResult, renderCollapsibleHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderSessionLink, truncate } from "./delegate-cards.js";

type SessionPromptMode = "prompt" | "steer";

interface SessionPromptParams {
	session_id?: string;
	message?: string;
	mode?: SessionPromptMode;
}

interface SessionPromptTarget {
	sessionId?: string;
	session_id?: string;
	title?: string;
	name?: string;
}

interface SessionPromptResultData {
	ok?: boolean;
	mode?: SessionPromptMode;
	status?: "queued" | "dispatched" | string;
	dispatched?: boolean;
	target?: SessionPromptTarget;
	error?: string;
	message?: string;
}

function getText(result: ToolResultMessage | undefined): string {
	return result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
}

function parseJsonData(text: string): SessionPromptResultData | undefined {
	if (!text.trim()) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed && typeof parsed === "object" ? parsed as SessionPromptResultData : undefined;
	} catch {
		return undefined;
	}
}

function shortSessionId(sessionId: string | undefined): string {
	if (!sessionId) return "session";
	return sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId;
}

function normalizeMode(mode: string | undefined): SessionPromptMode {
	return mode === "steer" ? "steer" : "prompt";
}

function targetId(params: SessionPromptParams | undefined, parsed: SessionPromptResultData | undefined, details: SessionPromptResultData | undefined): string | undefined {
	return params?.session_id
		?? parsed?.target?.sessionId
		?? parsed?.target?.session_id
		?? details?.target?.sessionId
		?? details?.target?.session_id;
}

function targetTitle(sessionId: string | undefined, parsed: SessionPromptResultData | undefined, details: SessionPromptResultData | undefined): string {
	return parsed?.target?.title
		?? parsed?.target?.name
		?? details?.target?.title
		?? details?.target?.name
		?? shortSessionId(sessionId);
}

function renderTarget(title: string, sessionId: string | undefined): TemplateResult {
	const displayTitle = truncate(title, 64);
	return html`
		<span class="font-medium text-foreground truncate" title=${title}>${displayTitle}</span>
		${sessionId ? renderSessionLink(sessionId) : ""}
	`;
}

function outcomeLabel(mode: SessionPromptMode, parsed: SessionPromptResultData | undefined, details: SessionPromptResultData | undefined): string {
	const status = parsed?.status ?? details?.status;
	const dispatched = parsed?.dispatched ?? details?.dispatched;
	if (mode === "steer" && dispatched) return "live steer dispatched";
	if (status === "queued") return "queued";
	if (status === "dispatched" || dispatched) return "dispatched";
	return "dispatched";
}

function errorText(text: string, parsed: SessionPromptResultData | undefined, details: SessionPromptResultData | undefined): string {
	return parsed?.error ?? parsed?.message ?? details?.error ?? details?.message ?? text;
}

export class SessionPromptRenderer implements ToolRenderer<SessionPromptParams, SessionPromptResultData> {
	render(
		params: SessionPromptParams | undefined,
		result: ToolResultMessage<SessionPromptResultData> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const text = getText(result);
		const parsed = parseJsonData(text);
		const details = result?.details;
		const mode = normalizeMode(params?.mode ?? parsed?.mode ?? details?.mode);
		const Icon = mode === "steer" ? Zap : MessageSquare;
		const sessionId = targetId(params, parsed, details);
		const title = targetTitle(sessionId, parsed, details);
		const target = renderTarget(title, sessionId);
		const message = params?.message ?? "";
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const skipped = isSkippedToolResult(result);

		let header: TemplateResult;
		if (!result) {
			header = html`${mode === "steer" ? "Steering" : "Prompting"} ${target}`;
		} else if (result.isError) {
			const failed = mode === "steer" ? "Steer failed" : "Prompt failed";
			const aborted = mode === "steer" ? "Aborted steer" : "Aborted prompt";
			header = html`${skipped ? aborted : failed} ${target}`;
		} else if (mode === "steer") {
			header = html`Steered ${target} <span class="text-xs text-muted-foreground">(${outcomeLabel(mode, parsed, details)})</span>`;
		} else {
			header = html`Prompted ${target} <span class="text-xs text-muted-foreground">(${outcomeLabel(mode, parsed, details)})</span>`;
		}

		return {
			content: html`<div>
				${renderCollapsibleHeader(state, Icon, header, contentRef, chevronRef, true)}
				<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
					<div class="flex items-center gap-2 text-xs text-muted-foreground">
						<span class="uppercase tracking-wide">mode</span>
						<span class="rounded border border-border px-1.5 py-0.5 font-mono">${mode}</span>
					</div>
					<div class="mt-2 rounded border border-border bg-muted/30 p-2 text-sm whitespace-pre-wrap break-words">${message}</div>
					${result?.isError ? html`
						<div class="mt-2 text-xs ${skipped ? "text-amber-600 dark:text-amber-400" : "text-destructive"}">${errorText(text, parsed, details)}</div>
					` : ""}
				</div>
			</div>`,
			isCustom: false,
		};
	}
}
