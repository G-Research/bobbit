import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html } from "lit";
import { Code } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderInlineImages } from "./image-utils.js";

const ERROR_PREVIEW_MAX_LENGTH = 500;
let payloadSectionId = 0;

function truncateErrorPreview(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= ERROR_PREVIEW_MAX_LENGTH) return trimmed;
	return `${trimmed.slice(0, ERROR_PREVIEW_MAX_LENGTH)}…`;
}

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

	private renderPayloadSection(label: string, code: string, language: string) {
		const payloadType = language === "json" ? "JSON" : "text";
		const payloadId = `default-payload-${++payloadSectionId}`;
		const onToggle = (event: Event) => {
			const button = event.currentTarget as HTMLButtonElement;
			const section = button.closest("[data-default-payload-section]");
			const expanded = button.getAttribute("aria-expanded") === "true";
			const nextExpanded = !expanded;
			button.setAttribute("aria-expanded", String(nextExpanded));
			section?.querySelector<HTMLElement>(`[data-payload-region="${payloadId}"]`)?.toggleAttribute("hidden", !nextExpanded);
			section?.querySelector('[data-state="collapsed"]')?.toggleAttribute("hidden", nextExpanded);
			section?.querySelector('[data-state="expanded"]')?.toggleAttribute("hidden", !nextExpanded);
		};

		return html`
			<div class="rounded-md border border-border bg-muted/20 p-2" data-default-payload-section>
				<button
					type="button"
					class="cursor-pointer select-none rounded-sm text-left text-xs font-medium text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
					aria-expanded="false"
					aria-controls=${payloadId}
					@click=${onToggle}
				>
					${label} ${payloadType} payload
					<span class="font-normal opacity-80" data-state="collapsed">(collapsed; expand to inspect)</span>
					<span class="font-normal opacity-80" data-state="expanded" hidden>(expanded)</span>
				</button>
				<div id=${payloadId} data-payload-region=${payloadId} class="mt-2" hidden>
					<code-block .code=${code} language=${language}></code-block>
				</div>
			</div>
		`;
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
			const rawOutputText =
				result.content
					?.filter((c) => c.type === "text")
					.map((c: any) => c.text)
					.join("\n") || i18n("(no output)");
			let outputJson = rawOutputText;
			let outputLanguage = "text";

			// Try to parse and pretty-print if it's valid JSON
			try {
				const parsed = JSON.parse(outputJson);
				outputJson = JSON.stringify(parsed, null, 2);
				outputLanguage = "json";
			} catch {
				// Not valid JSON, leave as-is and use text highlighting
			}

			const errorPreview = state === "error" ? truncateErrorPreview(rawOutputText) : "";
			const images = renderInlineImages(result.content);
			return {
				content: html`
					<div class="space-y-3">
						${renderHeader(state, Code, this.label)}
						${errorPreview ? html`<div class="text-sm text-destructive whitespace-pre-wrap break-words" role="alert">${errorPreview}</div>` : ""}
						${paramsJson ? this.renderPayloadSection(i18n("Input"), paramsJson, "json") : ""}
						${this.renderPayloadSection(i18n("Output"), outputJson, outputLanguage)}
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
						${this.renderPayloadSection(i18n("Input"), paramsJson, "json")}
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
