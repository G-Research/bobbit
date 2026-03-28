import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { SquareTerminal } from "lucide";
import { i18n } from "../../utils/i18n.js";
import { isGitDiff } from "../../components/DiffBlock.js";
import { renderCollapsibleHeader, renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";
import { renderInlineImages } from "./image-utils.js";

interface BashParams {
	command: string;
}

/**
 * Extract a short, human-readable label from a bash command string.
 * Strips leading env vars, sudo, etc. and returns the base command name.
 */
function summarizeCommand(command: string): string {
	const trimmed = command.trim();
	if (!trimmed) return "command";

	// Take the first line for multi-line commands
	const firstLine = trimmed.split("\n")[0].trim();

	// Strip leading env assignments (FOO=bar ...) and common prefixes
	let rest = firstLine;
	// Remove env vars like KEY=value at the start
	rest = rest.replace(/^(\w+=\S+\s+)+/, "");
	// Remove sudo/nohup/time/nice etc.
	rest = rest.replace(/^(sudo|nohup|time|nice|env|command)\s+/g, "");

	// Get the base command (first token), strip path
	// Build a short summary: command name + a few key args
	const maxLen = 80;
	if (firstLine.length <= maxLen) return firstLine;
	return firstLine.slice(0, maxLen) + "…";
}

// Bash tool has undefined details (only uses output)
export class BashRenderer implements ToolRenderer<BashParams, undefined> {
	render(params: BashParams | undefined, result: ToolResultMessage<undefined> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = getToolState(result, isStreaming);

		const headerText = params?.command
			? html`<span class="font-mono">${summarizeCommand(params.command)}</span>`
			: i18n("Running command...");

		// With result: collapsible command + output
		if (result && params?.command) {
			const output = typeof result.content === "string"
				? result.content
				: Array.isArray(result.content)
					? result.content.filter((c) => c.type === "text").map((c: any) => c.text).join("\n")
					: "";
			const combined = output ? `> ${params.command}\n\n${output}` : `> ${params.command}`;
			const images = Array.isArray(result.content) ? renderInlineImages(result.content) : "";
			const hasImages = Array.isArray(result.content) && result.content.some((c: any) => c.type === "image");
			const isDiff = !result.isError && isGitDiff(output);

			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, SquareTerminal, headerText, contentRef, chevronRef, hasImages || false)}
						<div ${ref(contentRef)} class="${hasImages ? "max-h-[2000px] mt-3" : "max-h-0"} overflow-hidden transition-all duration-300">
							${isDiff
								? html`<diff-block .content=${output}></diff-block>`
								: html`<console-block .content=${combined} .variant=${result.isError ? "error" : "default"}></console-block>`
							}
							${images}
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// Streaming / in-progress with params — show command collapsible, expanded
		if (params?.command) {
			const contentRef = createRef<HTMLDivElement>();
			const chevronRef = createRef<HTMLSpanElement>();
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, SquareTerminal, headerText, contentRef, chevronRef, true)}
						<div ${ref(contentRef)} class="max-h-[2000px] mt-3 overflow-hidden transition-all duration-300">
							<console-block .content=${`> ${params.command}`}></console-block>
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// No params yet
		return { content: renderHeader(state, SquareTerminal, i18n("Running command...")), isCustom: false };
	}
}
