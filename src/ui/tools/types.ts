import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { TemplateResult } from "lit";
import type { HostApi } from "../../shared/extension-host/host-api.js";

export interface ToolRenderResult {
	content: TemplateResult;
	isCustom: boolean; // true = no card wrapper, false = wrap in card
}

/** Extra context available to renderers that need to call back to the server. */
export interface ToolRenderContext {
	/** The tool_use ID from the assistant message block. */
	toolUseId?: string;
	/** Raw `input` payload from tool_use/toolCall blocks, when present. */
	toolCallInput?: unknown;
	/** The gateway session ID that issued the tool call. */
	sessionId?: string;
	/** The current session's goal ID, when bound to a goal. Used by Children
	 *  tool renderers (e.g. goal_plan_propose's approval flow). */
	goalId?: string;
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
	/**
	 * Phase-1 Extension Host API (design extension-host.md §3/§4c), bound to this
	 * render's `sessionId` + `toolUseId`. Pack renderers reach the server via
	 * `host.invokeAction` (tool-authorized) — there is no `host.gateway.fetch` or
	 * other raw passthrough in the durable v1 contract. Built-in renderers ignore
	 * it. Optional so existing renderers and test fixtures need no change.
	 */
	host?: HostApi;
}

export interface ToolRenderer<TParams = any, TDetails = any> {
	render(
		params: TParams | undefined,
		result: ToolResultMessage<TDetails> | undefined,
		isStreaming?: boolean,
		ctx?: ToolRenderContext,
	): ToolRenderResult;
}
