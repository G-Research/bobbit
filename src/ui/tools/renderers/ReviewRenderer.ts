import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { FileText } from "lucide";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface ReviewOpenParams {
	title?: string;
	markdown?: string;
	file?: string;
	replace?: boolean;
}

export class ReviewOpenRenderer implements ToolRenderer<ReviewOpenParams, any> {
	render(
		params: ReviewOpenParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const title = params?.title || "Review";
		const label = params?.file
			? html`Review: <span class="font-mono">${params.file}</span>`
			: html`Review: ${title}`;
		return { content: renderHeader(state, FileText, label), isCustom: false };
	}
}

interface ReviewCloseParams {
	title?: string;
}

export class ReviewCloseRenderer implements ToolRenderer<ReviewCloseParams, any> {
	render(
		params: ReviewCloseParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);
		const label = params?.title
			? html`Closed review: ${params.title}`
			: "Closed all review tabs";
		return { content: renderHeader(state, FileText, label), isCustom: false };
	}
}
