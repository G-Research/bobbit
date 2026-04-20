/**
 * Renderer for the `ask_user_choices` tool.
 *
 * Non-blocking model: the tool returns synchronously with a stub
 * `{ status: "posted", tool_use_id }` result. The user's answers (if any)
 * live in a *later* user message with an envelope prefix
 * `[ask_user_choices_response tool_use_id=<id>]` — we look those up via
 * `ctx.getAskResponseAnswers(toolUseId)` and flip the widget to read-only
 * "Answered mode" when found.
 */
import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { HelpCircle } from "lucide";
import { renderHeader, getToolState, type ToolHeaderState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderContext, ToolRenderResult } from "../types.js";
import "../../components/AskUserChoicesWidget.js"; // auto-registers <ask-user-choices-widget>
import type { AskAnswer } from "../../components/AskUserChoicesWidget.js";

/** Read the tool_result's content as a string. */
function getResultText(result: ToolResultMessage | undefined): string {
	if (!result) return "";
	return result.content
		?.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n") || "";
}

/** True when the tool_result is the `{ status: "posted" }` stub (non-blocking flow). */
function isPostedStub(result: ToolResultMessage | undefined): boolean {
	if (!result || result.isError) return false;
	const text = getResultText(result);
	if (!text) return false;
	try {
		const data = JSON.parse(text);
		return data && typeof data === "object" && data.status === "posted";
	} catch { return false; }
}

/** Legacy fallback: extract `{ answers: [...] }` from the tool_result content.
 *  Retained for sessions that predate the non-blocking flow (stub has no answers). */
function extractLegacyAnswers(result: ToolResultMessage | undefined): AskAnswer[] | null {
	if (!result || result.isError) return null;
	const text = getResultText(result);
	if (!text) return null;
	try {
		const data = JSON.parse(text);
		if (data && Array.isArray(data.answers)) {
			const valid = data.answers.every((a: any) =>
				a && typeof a === "object" &&
				typeof a.question === "string" &&
				(typeof a.selected === "string"
					|| (Array.isArray(a.selected) && a.selected.every((s: any) => typeof s === "string"))) &&
				(a.other_text === null || typeof a.other_text === "string"));
			return valid ? data.answers as AskAnswer[] : null;
		}
	} catch { /* not JSON */ }
	return null;
}

function getErrorText(result: ToolResultMessage | undefined): string {
	const text = getResultText(result);
	return text || "ask_user_choices failed.";
}

/**
 * Header variant for `ask_user_choices` awaiting a response. Shows a slowly
 * pulsing filled circle rather than a spinning loader — indicates the tool
 * posted and is waiting for user input (the agent itself is idle).
 */
function renderAskHeader(state: ToolHeaderState, text: string | TemplateResult): TemplateResult {
	if (state !== "inprogress") {
		return renderHeader(state, HelpCircle, text);
	}
	return html`
		<div class="flex items-center justify-between gap-2 text-sm text-muted-foreground">
			<div class="flex items-center gap-2">
				<span class="inline-block text-foreground">${icon(HelpCircle, "sm")}</span>
				${text}
			</div>
			<span
				class="inline-block h-2.5 w-2.5 rounded-full bg-foreground ask-heartbeat"
				aria-label="Waiting for your answer"
				title="Waiting for your answer"
			></span>
		</div>
	`;
}

export class AskUserChoicesRenderer implements ToolRenderer {
	render(
		params: any,
		result: ToolResultMessage | undefined,
		isStreaming?: boolean,
		ctx?: ToolRenderContext,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		// Streaming — params not complete yet.
		if (!params || !Array.isArray(params.questions) || params.questions.length === 0) {
			return {
				content: html`<div>${renderAskHeader(state, "Preparing questions…")}</div>`,
				isCustom: false,
			};
		}

		const errored = Boolean(result?.isError);
		const posted = isPostedStub(result);
		// Preferred path: the tool returned the `{status:"posted"}` stub and the
		// user has submitted; answers live in a later envelope user message.
		const fromTranscript = posted && ctx?.toolUseId && ctx?.getAskResponseAnswers
			? ctx.getAskResponseAnswers(ctx.toolUseId) as AskAnswer[] | null
			: null;
		// Legacy path: pre-redesign sessions where the tool_result itself carried answers.
		const legacy = posted ? null : extractLegacyAnswers(result);
		const answers: AskAnswer[] | null = fromTranscript ?? legacy;

		// Interactive mode: tool posted, no envelope yet, not errored.
		//   - If `posted` is false but the tool has produced a non-stub result,
		//     the card is effectively complete (legacy path with answers or an error).
		const showHeaderInProgress = state === "inprogress" || (posted && !answers && !errored);

		return {
			content: html`
				<div class="space-y-2">
					${showHeaderInProgress && !answers && !errored
						? renderAskHeader("inprogress" as ToolHeaderState, "Multiple-choice question")
						: renderHeader(state, HelpCircle, "Multiple-choice question")}
					<ask-user-choices-widget
						.questions=${params.questions}
						.answers=${answers}
						.sessionId=${ctx?.sessionId ?? ""}
						.toolUseId=${ctx?.toolUseId ?? ""}
						.errored=${errored}
						.errorText=${errored ? getErrorText(result) : ""}
					></ask-user-choices-widget>
				</div>`,
			isCustom: false,
		};
	}
}
