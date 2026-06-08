import { icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { html, nothing, type TemplateResult } from "lit";
import type { Ref } from "lit/directives/ref.js";
import { ref } from "lit/directives/ref.js";
import { AlertTriangle, ChevronsUpDown, ChevronUp, FileQuestion, Loader } from "lucide";
import type { ToolRenderer, ToolRenderResult } from "./types.js";
import { renderApp } from "../../app/state.js";

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
// Per-name load-generation token. Bumped whenever a tool name's renderer
// registration changes (re-register / uninstall). `startLoad` captures the
// generation BEFORE awaiting the loader and re-checks it on resolve/reject; a
// load started under a stale generation becomes a no-op (it must NOT write the
// renderer back into `toolRenderers` nor dispatch a resurrecting repaint). This
// closes the TOCTOU race where a pack renderer's lazy import is in-flight when
// the pack is uninstalled / a different renderer is registered for the same
// name — the old promise would otherwise resurrect the stale renderer and
// defeat the uninstall reconciliation (extension-host §4a).
const loadGeneration = new Map<string, number>();

/**
 * Invalidate any in-flight lazy load for `toolName`: bump its generation token
 * (so a superseded load becomes a no-op on resolve) and drop the shared
 * `inFlight` promise so a fresh registration can start a NEW load under the
 * bumped generation. Called on every registration change for a name.
 */
function bumpLoadGeneration(toolName: string): void {
	loadGeneration.set(toolName, (loadGeneration.get(toolName) ?? 0) + 1);
	inFlight.delete(toolName);
}
// Pack-owned renderer names (registered via { override: true }). The pack lazy
// loader is the EFFECTIVE renderer for these names; a later eager
// `registerToolRenderer` for a pack-owned name is ignored so the pack always
// wins (extension-host §4a renderer precedence). See registerLazyToolRenderer.
const packOwned = new Set<string>();
// Eager built-in renderers DISPLACED by a pack `{ override: true }`. Stashed at
// override time so `unregisterPackRenderer` (uninstall / precedence change) can
// RESTORE the built-in instead of leaving the tool with default rendering
// (extension-host §4a — uninstall must reconcile the running UI without a
// reload). Keyed by tool name.
const displacedBuiltins = new Map<string, ToolRenderer>();

/**
 * Register a custom tool renderer
 */
export function registerToolRenderer(toolName: string, renderer: ToolRenderer): void {
	// A pack claimed this name via override — its lazy loader is the effective
	// renderer. Ignore the eager (built-in) registration so the pack wins
	// regardless of registration order.
	if (packOwned.has(toolName)) return;
	toolRenderers.set(toolName, renderer);
	pendingLazy.delete(toolName);
}

/** Options for {@link registerLazyToolRenderer}. */
export interface RegisterLazyOptions {
	/** When true, this lazy loader is the EFFECTIVE renderer for `toolName`:
	 *  any eager `toolRenderers` entry is deleted and the name is recorded as
	 *  pack-owned so a later eager `registerToolRenderer` for it is ignored
	 *  (extension-host §4a — a pack that shadows a built-in tool wins its
	 *  renderer too). */
	override?: boolean;
}

/**
 * Register a tool renderer that is loaded on first use. The first call to
 * `getToolRenderer(name)` returns a tiny placeholder renderer (spinner +
 * tool name) and kicks off `loader()`. When the real renderer resolves it
 * replaces the registration and `renderApp()` is called to re-render.
 *
 * With `{ override: true }` the registration shadows any eager built-in
 * renderer of the same name (pack precedence — see {@link RegisterLazyOptions}).
 */
export function registerLazyToolRenderer(
	toolName: string,
	loader: LazyRendererLoader,
	opts?: RegisterLazyOptions,
): void {
	if (opts?.override) {
		// Pack is the resolved winning provider for this tool name — its renderer
		// must win too. Delete any eager entry and mark the name pack-owned so a
		// later eager registration cannot reclaim it. Stash a displaced eager
		// BUILT-IN (only on the first override, before the name is pack-owned) so
		// unregisterPackRenderer can restore it on uninstall.
		if (!packOwned.has(toolName)) {
			const existing = toolRenderers.get(toolName);
			if (existing) displacedBuiltins.set(toolName, existing);
		}
		toolRenderers.delete(toolName);
		packOwned.add(toolName);
	}
	// Registering a (possibly different) loader for this name supersedes any
	// in-flight load started under the prior registration — invalidate it so a
	// late resolve cannot write the previous renderer back (TOCTOU guard).
	bumpLoadGeneration(toolName);
	pendingLazy.set(toolName, loader);
}

/**
 * Remove a pack renderer registered via `{ override: true }` and reconcile the
 * running UI (extension-host §4a). Drops the name from every registry map
 * (`toolRenderers`, `pendingLazy`, `inFlight`, `packOwned`) and RESTORES the
 * built-in renderer stashed when the pack first displaced it — so after a pack
 * uninstall (or a precedence change that drops the pack winner) a shadowed
 * built-in renders again, and a pack tool with no built-in falls back to default
 * rendering. No-op for a name that is not pack-owned. Dispatches the standard
 * renderer-loaded event so mounted `<tool-message>`/`<tool-group>` blocks for
 * the tool repaint immediately, without a page reload.
 */
export function unregisterPackRenderer(toolName: string): void {
	if (!packOwned.has(toolName)) return;
	toolRenderers.delete(toolName);
	pendingLazy.delete(toolName);
	// Invalidate any in-flight pack load (bumps the generation + drops inFlight)
	// so a late resolve of the uninstalled pack's loader becomes a no-op and
	// cannot resurrect the stale renderer (TOCTOU guard).
	bumpLoadGeneration(toolName);
	packOwned.delete(toolName);
	const stashed = displacedBuiltins.get(toolName);
	if (stashed) {
		toolRenderers.set(toolName, stashed);
		displacedBuiltins.delete(toolName);
	}
	// Repaint mounted tool blocks for this tool (same mechanism the lazy-load
	// resolve uses); belt-and-braces top-down re-render too.
	dispatchRendererLoaded(toolName);
	try { renderApp(); } catch { /* state module may not exist in unit-test fixtures */ }
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

/** Custom DOM event dispatched on `document` when a pack renderer calls
 *  `host.requestRender()` after an action resolves (design §4a). The memoized
 *  `<tool-message>`/`<tool-group>` LitElements have unchanged reactive props,
 *  so a top-down `renderApp()` alone never re-runs their renderer. Mounted tool
 *  components listen for this event and pull their own `requestUpdate()` — the
 *  SAME mechanism `TOOL_RENDERER_LOADED_EVENT` uses for the lazy-load repaint —
 *  so the renderer re-runs and paints its updated renderer-local state. */
export const TOOL_RENDER_REQUESTED_EVENT = "bobbit-tool-render-requested";

/** Force mounted tool components to re-run their renderer (host.requestRender,
 *  design §4a). Dispatched in addition to the app's top-down `renderApp()`. */
export function requestToolRender(): void {
	try {
		document.dispatchEvent(new CustomEvent(TOOL_RENDER_REQUESTED_EVENT));
	} catch {
		/* document may not exist in some test fixtures */
	}
}

function startLoad(toolName: string, loader: LazyRendererLoader): void {
	if (inFlight.has(toolName)) return;
	// Capture the generation BEFORE awaiting the loader. If it changes while the
	// load is in flight (uninstall / re-register), this load is superseded and
	// must not mutate the registry or dispatch a repaint (TOCTOU guard).
	const gen = loadGeneration.get(toolName) ?? 0;
	const isSuperseded = () => (loadGeneration.get(toolName) ?? 0) !== gen;
	const p: Promise<ToolRenderer> = loader()
		.then(mod => {
			const renderer = ((mod as any)?.default ?? mod) as ToolRenderer;
			if (isSuperseded()) {
				// A newer registration/uninstall replaced this name while the load
				// was in flight. Drop only OUR own inFlight entry (a fresh load may
				// have installed a newer promise) and bail — no write, no repaint.
				if (inFlight.get(toolName) === p) inFlight.delete(toolName);
				return renderer;
			}
			toolRenderers.set(toolName, renderer);
			pendingLazy.delete(toolName);
			inFlight.delete(toolName);
			// Notify mounted tool-message / tool-group instances FIRST so each
			// can pull its own update even if renderApp() short-circuits.
			dispatchRendererLoaded(toolName);
			// Belt-and-braces top-down re-render.
			try { renderApp(); } catch { /* state module may not exist in unit-test fixtures */ }
			return renderer;
		})
		.catch((err) => {
			const fallback = makeLoadFailureRenderer(toolName);
			if (isSuperseded()) {
				// Superseded load failed — swallow silently (the name is no longer
				// this loader's) and do NOT install a fallback or repaint.
				if (inFlight.get(toolName) === p) inFlight.delete(toolName);
				return fallback;
			}
			// eslint-disable-next-line no-console
			console.error(`[tool-registry] failed to lazy-load renderer for "${toolName}":`, err);
			toolRenderers.set(toolName, fallback);
			pendingLazy.delete(toolName);
			inFlight.delete(toolName);
			dispatchRendererLoaded(toolName);
			try { renderApp(); } catch { /* state module may not exist in unit-test fixtures */ }
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
	// Tolerate a null/undefined icon (a pack renderer that ships no lucide icon —
	// design §4a): skip the icon span rather than letting createElement(null) throw.
	const statusIcon = (iconComponent: any, color: string) =>
		iconComponent ? html`<span class="inline-block ${color}">${icon(iconComponent, "sm")}</span>` : nothing;

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
	// Tolerate a null/undefined icon (see renderHeader) — skip the span instead
	// of throwing in lucide createElement(null).
	const statusIcon = (iconComponent: any, color: string) =>
		iconComponent ? html`<span class="inline-block ${color}">${icon(iconComponent, "sm")}</span>` : nothing;

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
