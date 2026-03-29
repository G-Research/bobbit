import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { PanelRight, PanelRightClose } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface PreviewOpenParams {
	html?: string;
	file?: string;
}

export class PreviewOpenRenderer implements ToolRenderer<PreviewOpenParams, any> {
	render(
		params: PreviewOpenParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const label = params?.file
			? html`Preview: <span class="font-mono">${params.file}</span>`
			: "Preview: inline HTML";
		return { content: renderHeader(state, PanelRight, label), isCustom: false };
	}
}

export class PreviewCloseRenderer implements ToolRenderer<Record<string, never>, any> {
	render(
		_params: Record<string, never> | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		return { content: renderHeader(state, PanelRightClose, "Close preview panel"), isCustom: false };
	}
}
