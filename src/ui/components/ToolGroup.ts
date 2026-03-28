import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	Bot,
	FileText,
	FileCode2,
	SquareTerminal,
	ChevronRight,
	ChevronsUpDown,
	ChevronUp,
} from "lucide";
import { renderTool } from "../tools/index.js";
import { isSkippedToolResult } from "../tools/renderer-registry.js";

/** Icon lookup by tool name — mirrors individual renderers */
const TOOL_ICONS: Record<string, any> = {
	read: FileText,
	edit: FileCode2,
	write: FileCode2,
	bash: SquareTerminal,
	ls: ChevronRight,
	find: FileText,
	grep: FileText,
	delegate: Bot,
};

/** Human-readable past-tense verb + noun per tool */
const TOOL_LABELS: Record<string, { verb: string; noun: string; nounPlural: string }> = {
	read: { verb: "Read", noun: "file", nounPlural: "files" },
	edit: { verb: "Edited", noun: "file", nounPlural: "files" },
	write: { verb: "Wrote", noun: "file", nounPlural: "files" },
	bash: { verb: "Ran", noun: "command", nounPlural: "commands" },
	ls: { verb: "Listed", noun: "directory", nounPlural: "directories" },
	find: { verb: "Searched", noun: "pattern", nounPlural: "patterns" },
	grep: { verb: "Searched", noun: "pattern", nounPlural: "patterns" },
	delegate: { verb: "Delegated", noun: "task", nounPlural: "tasks" },
};

/** Extract the most useful short label from a tool call's params */
function summarizeCall(toolName: string, args: Record<string, any>): string {
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "ls":
			return args?.path || "unknown";
		case "bash":
			return args?.command ? truncate(args.command.split("\n")[0], 60) : "command";
		case "grep":
			return args?.pattern ? `"${args.pattern}"` : "pattern";
		case "find":
			return args?.pattern || args?.path || "files";
		case "delegate": {
			const instr = args?.instructions || "";
			return truncate(instr.split("\n")[0], 80);
		}
		default:
			return args?.path || toolName;
	}
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * Groups consecutive completed tool calls of the same type into a single
 * collapsible card showing a summary header.
 */
@customElement("tool-group")
export class ToolGroup extends LitElement {
	@property({ type: String }) toolName = "";
	@property({ type: Array }) toolCalls: ToolCall[] = [];
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Object }) toolResultsById?: Map<string, ToolResultMessage>;

	@state() private _expanded = false;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	private _toggle() {
		this._expanded = !this._expanded;
	}

	override render() {
		const count = this.toolCalls.length;
		const toolIcon = TOOL_ICONS[this.toolName] || FileText;
		const label = TOOL_LABELS[this.toolName] || { verb: this.toolName, noun: "item", nounPlural: "items" };
		const hasErrors = this.toolCalls.some((tc) => {
			const r = this.toolResultsById?.get(tc.id);
			return r?.isError && !isSkippedToolResult(r);
		});
		const hasWarnings = this.toolCalls.some((tc) => isSkippedToolResult(this.toolResultsById?.get(tc.id)));

		// Build the file/item list for the summary
		const labels = this.toolCalls.map((tc) => summarizeCall(this.toolName, tc.arguments));
		const maxShown = 5;
		const shownLabels = labels.slice(0, maxShown);
		const remaining = labels.length - maxShown;

		const statusIcon = (iconComponent: any, color: string) =>
			html`<span class="inline-block ${color}">${icon(iconComponent, "sm")}</span>`;

		const iconColor = hasErrors
			? "text-destructive"
			: hasWarnings
				? "text-amber-600 dark:text-amber-500"
				: "text-green-600 dark:text-green-500";

		return html`
			<div class="p-2.5 border border-border rounded-md bg-card text-card-foreground shadow-xs">
				<button
					@click=${this._toggle}
					class="flex items-center justify-between gap-2 text-sm text-muted-foreground w-full text-left hover:text-foreground transition-colors cursor-pointer"
				>
					<div class="flex items-start gap-2 min-w-0">
						<span class="mt-0.5">${statusIcon(toolIcon, iconColor)}</span>
						<div class="flex flex-col gap-0">
							<span>${label.verb} ${count} ${count === 1 ? label.noun : label.nounPlural}</span>
							${!this._expanded ? html`
								${shownLabels.map(
									(l) => html`<span class="font-mono text-[0.75rem] leading-snug text-foreground/60">${l}</span>`,
								)}
								${remaining > 0 ? html`<span class="text-[0.75rem] text-muted-foreground/50">+${remaining} more</span>` : ""}
							` : ""}
						</div>
					</div>
					<span class="inline-block text-muted-foreground shrink-0">
						${this._expanded
							? html`${icon(ChevronUp, "sm")}`
							: html`${icon(ChevronsUpDown, "sm")}`}
					</span>
				</button>
				${this._expanded
					? html`
						<div class="mt-3 flex flex-col gap-3">
							${this.toolCalls.map((tc) => {
								const result = this.toolResultsById?.get(tc.id);
								const renderResult = renderTool(tc.name, tc.arguments, result, false);
								if (renderResult.isCustom) {
									return renderResult.content;
								}
								return html`
									<div class="p-2.5 border border-border rounded-md bg-card text-card-foreground shadow-xs">
										${renderResult.content}
									</div>
								`;
							})}
						</div>
					`
					: ""}
			</div>
		`;
	}
}
