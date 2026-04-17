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
}

export interface ToolRenderer<TParams = any, TDetails = any> {
	render(
		params: TParams | undefined,
		result: ToolResultMessage<TDetails> | undefined,
		isStreaming?: boolean,
		ctx?: ToolRenderContext,
	): ToolRenderResult;
}
