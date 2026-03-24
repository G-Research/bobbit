import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { SquareTerminal } from "lucide";
import { renderCollapsibleHeader, renderHeader, getToolState } from "../renderer-registry.js";
import type { ToolRenderer, ToolRenderResult } from "../types.js";

interface BgParams {
	action: string;
	command?: string;
	id?: string;
	tail?: number;
}

function summarize(params: BgParams): string {
	switch (params.action) {
		case "create": return `bg start: ${(params.command || "").slice(0, 40)}`;
		case "logs": return `bg logs: ${params.id || ""}`;
		case "kill": return `bg kill: ${params.id || ""}`;
		case "list": return "bg list";
		default: return `bg ${params.action}`;
	}
}

export class BgProcessRenderer implements ToolRenderer<BgParams> {
	render(
		params: BgParams | undefined,
		result: ToolResultMessage | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const summary = params ? summarize(params) : "background process";
		const state = getToolState(result);

		const output = typeof result?.content === "string"
			? result.content
			: result?.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n") || "";

		if (!result) {
			return {
				content: renderHeader(state, SquareTerminal, summary),
				isCustom: false,
			};
		}

		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();

		return {
			content: html`
				<div>
					${renderCollapsibleHeader(state, SquareTerminal, summary, contentRef, chevronRef, false)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<pre class="text-xs whitespace-pre-wrap break-all px-3 py-1.5 font-mono overflow-x-auto text-muted-foreground">${output || "(no output)"}</pre>
					</div>
				</div>
			`,
			isCustom: false,
		};
	}
}
