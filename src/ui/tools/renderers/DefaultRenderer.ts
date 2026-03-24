import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { Code } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderInlineImages } from "./image-utils.js";

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

	render(params: any | undefined, result: ToolResultMessage | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		// Format params as JSON
		let paramsJson = "";
		if (params) {
			try {
				paramsJson = JSON.stringify(JSON.parse(params), null, 2);
			} catch {
				try {
					paramsJson = JSON.stringify(params, null, 2);
				} catch {
					paramsJson = String(params);
				}
			}
		}

		// With result: show header + params + result
		if (result) {
			let outputJson =
				result.content
					?.filter((c) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || i18n("(no output)");
			let outputLanguage = "text";

			// Try to parse and pretty-print if it's valid JSON
			try {
				const parsed = JSON.parse(outputJson);
				outputJson = JSON.stringify(parsed, null, 2);
				outputLanguage = "json";
			} catch {
				// Not valid JSON, leave as-is and use text highlighting
			}

			const images = renderInlineImages(result.content);
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, Code, this.label)}
						${
							paramsJson
								? html`<div>
							<div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Input")}</div>
							<code-block .code=${paramsJson} language="json"></code-block>
						</div>`
								: ""
						}
						<div>
							<div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Output")}</div>
							<code-block .code=${outputJson} language="${outputLanguage}"></code-block>
						</div>
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
						${renderHeader(state, Code, this.label)}
						<div>
							<div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Input")}</div>
							<code-block .code=${paramsJson} language="json"></code-block>
						</div>
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
