import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import type { Ref } from "lit/directives/ref.js";
import { ref } from "lit/directives/ref.js";
import { ChevronsUpDown, ChevronUp, Loader } from "lucide";
import type { ToolRenderer } from "./types.js";

/** Possible states for a tool call header icon/styling. */
export type ToolHeaderState = "inprogress" | "complete" | "error" | "warning";

/**
 * Detect whether a tool result is a benign "skipped due to queued user message"
 * rather than a real error.
 */
export function isSkippedToolResult(result: ToolResultMessage | undefined): boolean {
	if (!result?.isError) return false;
	const text = result.content?.filter(c => c.type === 'text').map((c: any) => c.text).join('') || '';
	return text.includes('Skipped due to queued user message');
}

/**
 * Resolve the display state for a tool call result.
 * Returns "warning" for skipped-due-to-queued-message results instead of "error".
 */
export function getToolState(result: ToolResultMessage | undefined, isStreaming?: boolean): ToolHeaderState {
	if (!result) return isStreaming ? "inprogress" : "complete";
	if (isSkippedToolResult(result)) return "warning";
	return result.isError ? "error" : "complete";
}

// Registry of tool renderers
export const toolRenderers = new Map<string, ToolRenderer>();

/**
 * Register a custom tool renderer
 */
export function registerToolRenderer(toolName: string, renderer: ToolRenderer): void {
	toolRenderers.set(toolName, renderer);
}

/**
 * Get a tool renderer by name
 */
export function getToolRenderer(toolName: string): ToolRenderer | undefined {
	return toolRenderers.get(toolName);
}

/**
 * Helper to render a header for tool renderers
 * Shows icon on left when complete/error, spinner on right when in progress
 */
export function renderHeader(
	state: ToolHeaderState,
	toolIcon: any,
	text: string | TemplateResult,
): TemplateResult {
	const statusIcon = (iconComponent: any, color: string) =>
		html`<span class="inline-block ${color}">${icon(iconComponent, "sm")}</span>`;

	switch (state) {
		case "inprogress":
			return html`
				<div class="flex items-center justify-between gap-2 text-sm text-muted-foreground">
					<div class="flex items-center gap-2">
						${statusIcon(toolIcon, "text-foreground")}
						${text}
					</div>
					${statusIcon(Loader, "text-foreground animate-spin")}
				</div>
			`;
		case "complete":
			return html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					${statusIcon(toolIcon, "text-green-600 dark:text-green-500")}
					${text}
				</div>
			`;
		case "error":
			return html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					${statusIcon(toolIcon, "text-destructive")}
					${text}
				</div>
			`;
		case "warning":
			return html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					${statusIcon(toolIcon, "text-amber-600 dark:text-amber-500")}
					${text}
				</div>
			`;
	}
}

/**
 * Helper to render a collapsible header for tool renderers
 * Same as renderHeader but with a chevron button that toggles visibility of content
 */
export function renderCollapsibleHeader(
	state: ToolHeaderState,
	toolIcon: any,
	text: string | TemplateResult,
	contentRef: Ref<HTMLElement>,
	chevronRef: Ref<HTMLElement>,
	defaultExpanded = false,
): TemplateResult {
	const statusIcon = (iconComponent: any, color: string) =>
		html`<span class="inline-block ${color}">${icon(iconComponent, "sm")}</span>`;

	const toggleContent = (e: Event) => {
		e.preventDefault();
		const content = contentRef.value;
		const chevron = chevronRef.value;
		if (content && chevron) {
			const isCollapsed = content.classList.contains("max-h-0");
			if (isCollapsed) {
				content.classList.remove("max-h-0");
				content.classList.add("max-h-[2000px]", "mt-3");
				// Show ChevronUp, hide ChevronsUpDown
				const upIcon = chevron.querySelector(".chevron-up");
				const downIcon = chevron.querySelector(".chevrons-up-down");
				if (upIcon && downIcon) {
					upIcon.classList.remove("hidden");
					downIcon.classList.add("hidden");
				}
			} else {
				content.classList.remove("max-h-[2000px]", "mt-3");
				content.classList.add("max-h-0");
				// Show ChevronsUpDown, hide ChevronUp
				const upIcon = chevron.querySelector(".chevron-up");
				const downIcon = chevron.querySelector(".chevrons-up-down");
				if (upIcon && downIcon) {
					upIcon.classList.add("hidden");
					downIcon.classList.remove("hidden");
				}
			}
		}
	};

	const toolIconColor =
		state === "complete"
			? "text-green-600 dark:text-green-500"
			: state === "error"
				? "text-destructive"
				: state === "warning"
					? "text-amber-600 dark:text-amber-500"
					: "text-foreground";

	return html`
		<button @click=${toggleContent} class="flex items-center justify-between gap-2 text-sm text-muted-foreground w-full text-left hover:text-foreground transition-colors cursor-pointer">
			<div class="flex items-center gap-2">
				${state === "inprogress" ? statusIcon(Loader, "text-foreground animate-spin") : ""}
				${statusIcon(toolIcon, toolIconColor)}
				${text}
			</div>
			<span class="inline-block text-muted-foreground" ${ref(chevronRef)}>
				<span class="chevron-up ${defaultExpanded ? "" : "hidden"}">${icon(ChevronUp, "sm")}</span>
				<span class="chevrons-up-down ${defaultExpanded ? "hidden" : ""}">${icon(ChevronsUpDown, "sm")}</span>
			</span>
		</button>
	`;
}
