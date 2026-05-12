import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { html, nothing, type TemplateResult } from "lit";
import type { Ref } from "lit/directives/ref.js";
import { ref } from "lit/directives/ref.js";
import { AlertTriangle, ChevronsUpDown, ChevronUp, FileQuestion, Loader } from "lucide";
import type { ToolRenderer, ToolRenderResult } from "./types.js";

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

/** Loader returns either the renderer instance or a module whose `default` is the renderer. */
export type LazyRendererLoader = () => Promise<ToolRenderer | { default: ToolRenderer }>;

// Pending lazy registrations: name → loader (consumed on first getToolRenderer call)
const pendingLazy = new Map<string, LazyRendererLoader>();
// In-flight loads: name → promise (so concurrent renders share one fetch)
const inFlight = new Map<string, Promise<ToolRenderer>>();

/**
 * Register a custom tool renderer
 */
export function registerToolRenderer(toolName: string, renderer: ToolRenderer): void {
	toolRenderers.set(toolName, renderer);
	pendingLazy.delete(toolName);
}

/**
 * Register a tool renderer that is loaded on first use. The first call to
 * `getToolRenderer(name)` returns a tiny placeholder renderer (spinner +
 * tool name) and kicks off `loader()`. When the real renderer resolves it
 * replaces the registration and `renderApp()` is called to re-render.
 */
export function registerLazyToolRenderer(toolName: string, loader: LazyRendererLoader): void {
	pendingLazy.set(toolName, loader);
}

/** Custom DOM event dispatched on `document` after a lazy renderer resolves
 *  (success or failure). Mounted `<tool-message>` / `<tool-group>` elements
 *  listen for this and pull their own `requestUpdate()`. The `detail.toolName`
 *  matches the registry key. See AGENTS.md → "Add a heavy tool renderer". */
export const TOOL_RENDERER_LOADED_EVENT = "bobbit-tool-renderer-loaded";

function dispatchRendererLoaded(toolName: string): void {
	try {
		document.dispatchEvent(new CustomEvent(TOOL_RENDERER_LOADED_EVENT, { detail: { toolName } }));
	} catch {
		/* document may not exist in some test fixtures */
	}
}

function startLoad(toolName: string, loader: LazyRendererLoader): void {
	if (inFlight.has(toolName)) return;
	const p = loader()
		.then(mod => {
			const renderer = (mod as any)?.default ?? mod;
			toolRenderers.set(toolName, renderer as ToolRenderer);
			pendingLazy.delete(toolName);
			inFlight.delete(toolName);
			// Notify mounted tool-message / tool-group instances FIRST so each
			// can pull its own update even if renderApp() short-circuits.
			dispatchRendererLoaded(toolName);
			// Belt-and-braces top-down re-render.
			import("../../app/state.js")
				.then(({ renderApp }) => renderApp())
				.catch(() => { /* state module may not exist in unit-test fixtures */ });
			return renderer as ToolRenderer;
		})
		.catch((err) => {
			// eslint-disable-next-line no-console
			console.error(`[tool-registry] failed to lazy-load renderer for "${toolName}":`, err);
			const fallback = makeLoadFailureRenderer(toolName);
			toolRenderers.set(toolName, fallback);
			pendingLazy.delete(toolName);
			inFlight.delete(toolName);
			dispatchRendererLoaded(toolName);
			import("../../app/state.js")
				.then(({ renderApp }) => renderApp())
				.catch(() => { /* state module may not exist in unit-test fixtures */ });
			// Resolve to the fallback so the inFlight promise does not surface
			// as an unhandled rejection — callers ignore the value anyway.
			return fallback;
		});
	inFlight.set(toolName, p);
}

/**
 * Placeholder shown while a lazy renderer's chunk is loading. Uses the
 * standard card wrapper (isCustom=false) and the same `renderHeader()`
 * shape every other tool renderer emits, plus a generic disabled
 * "Loading…" button row to reserve vertical space. This keeps the layout
 * stable across the lazy boundary — the real renderer's content slots in
 * with no card-vs-no-card jump and no button materialising from nothing.
 */
function makePlaceholderRenderer(toolName: string): ToolRenderer {
	return {
		render(_params, _result, _isStreaming): ToolRenderResult {
			return {
				content: html`
					<div class="flex items-center justify-between gap-2">
						<div class="flex-1 min-w-0">
							${renderHeader("inprogress", FileQuestion, html`<span class="font-mono">${toolName}</span>`)}
						</div>
						<button
							disabled
							class="text-xs px-2 py-0.5 rounded border border-border bg-transparent text-muted-foreground opacity-50 cursor-not-allowed"
							title="Loading renderer…"
							data-lazy-renderer-placeholder-btn
						>Loading…</button>
					</div>
				`,
				isCustom: false,
			};
		},
	};
}

/**
 * Fallback renderer registered when a lazy loader rejects. Renders the
 * standard card with an error header so the user sees a real failure state
 * instead of an indefinite spinner. Re-mounted `<tool-message>` instances
 * pick this up via the same `bobbit-tool-renderer-loaded` event.
 */
function makeLoadFailureRenderer(toolName: string): ToolRenderer {
	return {
		render(_params, _result, _isStreaming): ToolRenderResult {
			return {
				content: renderHeader(
					"error",
					AlertTriangle,
					html`<span class="font-mono">${toolName}</span> — Renderer failed to load — refresh to retry`,
				),
				isCustom: false,
			};
		},
	};
}

/**
 * Get a tool renderer by name. If the renderer is registered lazily and
 * hasn't loaded yet, kicks off the loader and returns a placeholder.
 */
export function getToolRenderer(toolName: string): ToolRenderer | undefined {
	const eager = toolRenderers.get(toolName);
	if (eager) return eager;
	const loader = pendingLazy.get(toolName);
	if (loader) {
		startLoad(toolName, loader);
		return makePlaceholderRenderer(toolName);
	}
	return undefined;
}

/**
 * Helper to render a header for tool renderers
 * Shows icon on left when complete/error, spinner on right when in progress
 */
export function renderHeader(
	state: ToolHeaderState,
	toolIcon: any,
	text: string | TemplateResult,
	trailing?: TemplateResult | typeof nothing,
): TemplateResult {
	const statusIcon = (iconComponent: any, color: string) =>
		html`<span class="inline-block ${color}">${icon(iconComponent, "sm")}</span>`;

	switch (state) {
		case "inprogress":
			return html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					<div class="flex items-center gap-2 min-w-0">
						${statusIcon(toolIcon, "text-foreground")}
						${text}
					</div>
					${trailing ? html`<span class="ml-auto flex items-center">${trailing}</span>` : html`<span class="ml-auto"></span>`}
					${statusIcon(Loader, "text-foreground animate-spin")}
				</div>
			`;
		case "complete":
			return html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					<div class="flex items-center gap-2 min-w-0">
						${statusIcon(toolIcon, "text-green-600 dark:text-green-500")}
						${text}
					</div>
					${trailing ? html`<span class="ml-auto flex items-center">${trailing}</span>` : nothing}
				</div>
			`;
		case "error":
			return html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					<div class="flex items-center gap-2 min-w-0">
						${statusIcon(toolIcon, "text-destructive")}
						${text}
					</div>
					${trailing ? html`<span class="ml-auto flex items-center">${trailing}</span>` : nothing}
				</div>
			`;
		case "warning":
			return html`
				<div class="flex items-center gap-2 text-sm text-muted-foreground">
					<div class="flex items-center gap-2 min-w-0">
						${statusIcon(toolIcon, "text-amber-600 dark:text-amber-500")}
						${text}
					</div>
					${trailing ? html`<span class="ml-auto flex items-center">${trailing}</span>` : nothing}
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
	trailing?: TemplateResult | typeof nothing,
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
		<button @click=${toggleContent} class="flex items-center gap-2 text-sm text-muted-foreground w-full text-left hover:text-foreground transition-colors cursor-pointer">
			<div class="flex items-center gap-2 min-w-0">
				${state === "inprogress" ? statusIcon(Loader, "text-foreground animate-spin") : ""}
				${statusIcon(toolIcon, toolIconColor)}
				${text}
			</div>
			${trailing ? html`<span class="ml-auto flex items-center">${trailing}</span>` : html`<span class="ml-auto"></span>`}
			<span class="inline-block text-muted-foreground shrink-0" ${ref(chevronRef)}>
				<span class="chevron-up ${defaultExpanded ? "" : "hidden"}">${icon(ChevronUp, "sm")}</span>
				<span class="chevrons-up-down ${defaultExpanded ? "hidden" : ""}">${icon(ChevronsUpDown, "sm")}</span>
			</span>
		</button>
	`;
}
