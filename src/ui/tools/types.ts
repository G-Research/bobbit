import type { ToolResultMessage } from "@mariozechner/pi-ai";
import type { TemplateResult } from "lit";

export interface ToolRenderResult {
	content: TemplateResult;
	isCustom: boolean; // true = no card wrapper, false = wrap in card
}

/** Extra context available to renderers that need to call back to the server. */
export interface ToolRenderContext {
	/** The tool_use ID from the assistant message block. */
	toolUseId?: string;
	/** The gateway session ID that issued the tool call. */
	sessionId?: string;
	/**
	 * Look up answers for a posted `ask_user_choices` tool_use by scanning the
	 * current session's transcript for a matching response envelope.
	 * Returns the parsed answers array, or null if the user hasn't submitted.
	 */
	getAskResponseAnswers?: (toolUseId: string) => Array<{
		question: string;
		selected: string | string[];
		other_text: string | null;
	}> | null;
}

export interface ToolRenderer<TParams = any, TDetails = any> {
	render(
		params: TParams | undefined,
		result: ToolResultMessage<TDetails> | undefined,
		isStreaming?: boolean,
		ctx?: ToolRenderContext,
	): ToolRenderResult;
}
