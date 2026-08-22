import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, nothing } from "lit";
import { History } from "lucide";
import { getToolState, renderHeader } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderContext, ToolRenderResult } from "../types.js";
import { renderPayloadSection } from "./payload-section.js";

/**
 * Capability-free renderer for retained transcript segments.
 *
 * History never resolves or invokes the live renderer registry. Keeping this
 * renderer generic is deliberate: a newly installed built-in or pack renderer
 * cannot accidentally regain network, timer, navigation, dialog, event, or
 * mutation authority merely because it forgot to implement a history branch.
 * The raw input and complete recorded result remain inspectable and copyable.
 */
export class HistoryRenderer implements ToolRenderer {
	private readonly toolName: string;

	constructor(toolName: string) {
		this.toolName = toolName;
	}

	withToolName(toolName: string): HistoryRenderer {
		return new HistoryRenderer(toolName);
	}

	private get label(): string {
		return this.toolName
			.replace(/[_-]/g, " ")
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/\b\w/g, (character) => character.toUpperCase());
	}

	render(
		params: unknown,
		result: ToolResultMessage | undefined,
		isStreaming?: boolean,
		ctx?: ToolRenderContext,
	): ToolRenderResult {
		const input = params !== undefined ? params : ctx?.toolCallInput;
		const inputPayload = input === undefined ? "" : serialize(input);
		const output = textOutput(result);
		const recordedResult = result === undefined ? "" : serialize(result);
		const state = getToolState(result, isStreaming);

		return {
			content: html`
				<div class="space-y-3" data-history-tool-static data-history-tool-name=${this.toolName}>
					${renderHeader(state, History, this.label)}
					<div class="text-xs text-muted-foreground">Recorded result — read-only history</div>
					${inputPayload ? renderPayloadSection("Input", inputPayload, "json") : nothing}
					${result ? renderPayloadSection("Output", output, outputLanguage(output)) : nothing}
					${recordedResult ? renderPayloadSection("Complete result", recordedResult, "json") : nothing}
				</div>
			`,
			isCustom: false,
		};
	}
}

function textOutput(result: ToolResultMessage | undefined): string {
	if (!result) return "(no recorded result)";
	const text = result.content
		?.filter((content: any) => content.type === "text")
		.map((content: any) => content.text)
		.join("\n");
	if (!text) return "(no text output; inspect Complete result)";
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

function outputLanguage(output: string): string {
	try {
		JSON.parse(output);
		return "json";
	} catch {
		return "text";
	}
}

function serialize(value: unknown): string {
	try {
		const json = JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? String(nested) : nested, 2);
		return json ?? String(value);
	} catch {
		return String(value);
	}
}
