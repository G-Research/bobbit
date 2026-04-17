/**
 * Renderer for the `ask_user_choices` tool.
 * Renders <ask-user-choices-widget> with the question params and — once the
 * tool has returned — the finalized answers (read-only).
 */
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { HelpCircle } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderContext, ToolRenderResult } from "../types.js";
import "../../components/AskUserChoicesWidget.js"; // auto-registers <ask-user-choices-widget>
import type { AskAnswer } from "../../components/AskUserChoicesWidget.js";

/** Extract { answers: [...] } from the tool result's content text. */
function extractAnswers(result: ToolResultMessage | undefined): AskAnswer[] | null {
	if (!result || result.isError) return null;
	const text = result.content
		?.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n") || "";
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
	if (!result) return "";
	const text = result.content
		?.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n") || "";
	return text || "ask_user_choices failed.";
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
				content: html`<div>${renderHeader(state, HelpCircle, "Preparing questions…")}</div>`,
				isCustom: false,
			};
		}

		const answers = extractAnswers(result);
		const errored = Boolean(result?.isError);

		return {
			content: html`
				<div class="space-y-2">
					${renderHeader(state, HelpCircle, "Multiple-choice question")}
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
