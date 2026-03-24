import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Camera } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderHeader, getToolState, isSkippedToolResult } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderInlineImages } from "./image-utils.js";

interface ScreenshotParams {
	selector?: string;
	fullPage?: boolean;
	savePath?: string;
}

export class ScreenshotRenderer implements ToolRenderer<ScreenshotParams, any> {
	render(
		params: ScreenshotParams | undefined,
		result: ToolResultMessage<any> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.selector
			? `${i18n("Screenshot")} ${params.selector}`
			: params?.fullPage
				? i18n("Full page screenshot")
				: i18n("Screenshot");

		// Completed with result
		if (result) {
			if (result.isError) {
				const output =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n") || "";
				return {
					content: html`
						<div class="space-y-3">
							${renderHeader(state, Camera, headerText)}
							<div class="text-sm ${isSkippedToolResult(result) ? 'text-warning' : 'text-destructive'}">${output}</div>
						</div>
					`,
					isCustom: false,
				};
			}

			// Success — just show thumbnail, no input/output JSON
			const images = renderInlineImages(result.content);
			return {
				content: html`
					<div>
						${renderHeader(state, Camera, headerText)}
						<div class="mt-2">${images}</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// In progress or waiting
		return { content: renderHeader(state, Camera, headerText), isCustom: false };
	}
}
