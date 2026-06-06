/**
 * Sidebar Filters popover — replaces the legacy "See Archived" button.
 *
 * Contains three toggle switches (Show Archived, Show Busy, Show Read), each
 * persisted to localStorage and wired to keyboard shortcuts.
 *
 *   - bobbit-show-archived (default OFF)
 *   - bobbit-show-busy     (default ON)
 *   - bobbit-show-read     (default ON)
 *
 * Exports the popover renderer (called from both desktop and mobile sidebars)
 * and three pure toggle functions used by the keyboard shortcut handlers.
 */
import { html, type TemplateResult } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { Archive, Eye, Filter, Zap } from "lucide";
import { renderApp, resetArchivedExpandState, state } from "../../app/state.js";
import { shortcutHint } from "../../app/shortcut-registry.js";
import { safeSetItem } from "../../app/safe-storage.js";

// ---------------------------------------------------------------------------
// Shared toggle handlers (used by both popover clicks and keyboard shortcuts)
// ---------------------------------------------------------------------------

/** Toggle Show Archived. Persists, lazy-loads/clears archived data, re-renders. */
export function toggleShowArchived(): void {
	state.showArchived = !state.showArchived;
	safeSetItem("bobbit-show-archived", String(state.showArchived));
	// Manual toggle takes precedence over search-driven auto-open.
	import("../../app/sidebar.js").then(m => m.clearArchivedBySearch()).catch(() => {});
	if (state.showArchived) {
		import("../../app/api.js").then(m => {
			m.fetchArchivedSessions();
			m.fetchArchivedGoalsPaginated();
		});
	} else {
		resetArchivedExpandState();
		import("../../app/api.js").then(m => m.clearArchivedSessionsState());
	}
	renderApp();
}

/** Toggle Show Busy. Persists, re-renders. */
export function toggleShowBusy(): void {
	state.showBusy = !state.showBusy;
	safeSetItem("bobbit-show-busy", String(state.showBusy));
	renderApp();
}

/** Toggle Show Read. Persists, re-renders. */
export function toggleShowRead(): void {
	state.showRead = !state.showRead;
	safeSetItem("bobbit-show-read", String(state.showRead));
	renderApp();
}

// ---------------------------------------------------------------------------
// Popover anchor + outside-click handling
// ---------------------------------------------------------------------------

let _filtersAnchorRect: { top: number; right: number; bottom: number; left: number } | null = null;

function _openFiltersPopover(e: Event): void {
	e.stopPropagation();
	if (state.filtersPopoverOpen) {
		state.filtersPopoverOpen = false;
		renderApp();
		return;
	}
	const btn = e.currentTarget as HTMLElement | null;
	if (btn) {
		const r = btn.getBoundingClientRect();
		_filtersAnchorRect = { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
	} else {
		_filtersAnchorRect = null;
	}
	state.filtersPopoverOpen = true;
	renderApp();
}

// Close on any outside click. The popover root stops propagation, so clicks
// inside it won't trigger this.
if (typeof document !== "undefined") {
	document.addEventListener("click", () => {
		if (state.filtersPopoverOpen) {
			state.filtersPopoverOpen = false;
			renderApp();
		}
	});
	document.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key === "Escape" && state.filtersPopoverOpen) {
			state.filtersPopoverOpen = false;
			renderApp();
		}
	});
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Returns true when any filter differs from its default (used for active styling). */
function _anyFilterActive(): boolean {
	return state.showArchived || !state.showBusy || !state.showRead;
}

/** Render a single toggle row inside the popover. */
function _renderToggleRow(opts: {
	id: string;
	icon: typeof Archive;
	label: string;
	shortcut: string;
	checked: boolean;
	onToggle: () => void;
}): TemplateResult {
	return html`
		<label
			class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-secondary/50 transition-colors"
			data-testid="sidebar-filter-${opts.id}"
		>
			<input
				type="checkbox"
				class="w-4 h-4 rounded border-input accent-primary cursor-pointer"
				.checked=${opts.checked}
				@change=${(e: Event) => { e.stopPropagation(); opts.onToggle(); }}
				@click=${(e: Event) => e.stopPropagation()}
			/>
			<span class="shrink-0 text-muted-foreground">${icon(opts.icon, "sm")}</span>
			<span class="flex-1 text-sm font-medium text-foreground">${opts.label}</span>
			<span class="text-xs text-muted-foreground/70 font-mono">${opts.shortcut}</span>
		</label>
	`;
}

/** Render the popover panel (anchored to the trigger button). */
function _renderPopover(): TemplateResult | "" {
	if (!state.filtersPopoverOpen) return "";

	const MARGIN = 8;
	const POPOVER_WIDTH = 280;
	const anchor = _filtersAnchorRect ?? { top: 40, right: 260, bottom: 56, left: 0 };

	// Prefer anchoring above the trigger (the trigger lives in the sidebar footer).
	const spaceAbove = anchor.top - MARGIN;
	const spaceBelow = (typeof window !== "undefined" ? window.innerHeight : 800) - anchor.bottom - MARGIN;
	const useAbove = spaceAbove > 200 || spaceAbove > spaceBelow;

	const vpW = typeof window !== "undefined" ? window.innerWidth : 1024;
	const width = Math.min(POPOVER_WIDTH, vpW - MARGIN * 2);
	// Anchor the popover's left edge to the trigger's left edge, clamped to viewport.
	const left = Math.max(MARGIN, Math.min(anchor.left, vpW - width - MARGIN));
	const verticalStyle = useAbove
		? `bottom: ${(typeof window !== "undefined" ? window.innerHeight : 800) - anchor.top + 4}px`
		: `top: ${anchor.bottom + 4}px`;

	return html`
		<div
			class="fixed z-50 rounded-md shadow-lg py-1"
			style="background: var(--popover); border: 1px solid var(--border); width: ${width}px; left: ${left}px; ${verticalStyle};"
			role="dialog"
			aria-label="Sidebar filters"
			data-testid="sidebar-filters-popover"
			@click=${(e: Event) => e.stopPropagation()}
		>
			<div class="px-3 pt-2 pb-1 text-muted-foreground uppercase tracking-wider font-medium" style="font-size: 0.75em;">
				Sidebar filters
			</div>
			${_renderToggleRow({
				id: "archived",
				icon: Archive,
				label: "Show Archived",
				shortcut: shortcutHint("ui.toggle-show-archived", { prefix: "", suffix: "" }) || "Alt+Shift+A",
				checked: state.showArchived,
				onToggle: toggleShowArchived,
			})}
			${_renderToggleRow({
				id: "busy",
				icon: Zap,
				label: "Show Busy",
				shortcut: shortcutHint("ui.toggle-show-busy", { prefix: "", suffix: "" }) || "Alt+Shift+B",
				checked: state.showBusy,
				onToggle: toggleShowBusy,
			})}
			${_renderToggleRow({
				id: "read",
				icon: Eye,
				label: "Show Read",
				shortcut: shortcutHint("ui.toggle-show-read", { prefix: "", suffix: "" }) || "Alt+Shift+R",
				checked: state.showRead,
				onToggle: toggleShowRead,
			})}
		</div>
	`;
}

/**
 * Render the Filters trigger button + its popover. Variant controls the
 * tailwind class string so it visually matches the previous "See Archived"
 * button in each surface.
 */
export function renderFiltersButton(variant: "desktop" | "mobile"): TemplateResult {
	const active = _anyFilterActive();
	const baseClasses = variant === "mobile"
		? "flex items-center gap-1.5 px-2 py-2.5 text-xs rounded transition-colors"
		: "flex items-center gap-1.5 px-2 py-2 rounded transition-colors";
	const stateClasses = active
		? "text-primary bg-primary/10 font-medium"
		: variant === "mobile"
			? "text-muted-foreground active:bg-secondary/50"
			: "text-muted-foreground hover:text-foreground hover:bg-secondary/50";
	const title = active
		? "Sidebar filters (active)"
		: "Sidebar filters";
	return html`
		<button
			class="${baseClasses} ${stateClasses}"
			@click=${_openFiltersPopover}
			title="${title}"
			data-testid="sidebar-filters-button"
			aria-haspopup="dialog"
			aria-expanded=${state.filtersPopoverOpen ? "true" : "false"}
		>
			${icon(Filter, "sm")}
			<span>Filters</span>
		</button>
		${_renderPopover()}
	`;
}
