/**
 * Shared By Project / By Status sidebar Filters control.
 *
 * Existing keyboard shortcuts continue to call the exported toggle functions;
 * the preference adapter routes Show archived, Show busy, and Show read to the
 * active view's independent values.
 */
import { html, nothing, type TemplateResult } from "lit";
import { icon } from "@mariozechner/mini-lit";
import { Archive, Eye, Filter, Users, Zap } from "lucide";
import { renderApp, state } from "../../app/state.js";
import { shortcutHint } from "../../app/shortcut-registry.js";
import {
	archivedGoalsLoaded,
	archivedSessionsLoaded,
	clearArchivedSessionsState,
	fetchArchivedGoalsPaginated,
	fetchArchivedSessions,
} from "../../app/api.js";
import {
	getSidebarViewFilters,
	isSidebarViewFilterActive,
	setActiveSidebarViewFilter,
	setSidebarViewFilter,
	sidebarNeedsArchivedSessions,
	type SidebarViewFilterKey,
} from "../../app/sidebar-view-preferences.js";

function activeFilters() {
	return getSidebarViewFilters(state, state.sidebarSessionView);
}

function updateFilter(key: SidebarViewFilterKey, value: boolean): void {
	setSidebarViewFilter(state, state.sidebarSessionView, key, value);
}

/** Toggle Show Archived for the active view and reuse production archive ownership. */
export function toggleShowArchived(): void {
	const next = !activeFilters().showArchived;
	updateFilter("showArchived", next);
	if (next) {
		// Both views consume the same normal archive pages. Only a cold resource
		// should use its reset-capable first-page loader here.
		if (!archivedSessionsLoaded()) void fetchArchivedSessions();
		if (!archivedGoalsLoaded()) void fetchArchivedGoalsPaginated();
	} else if (!sidebarNeedsArchivedSessions(state, state.archivedSearchDemand)) {
		clearArchivedSessionsState();
	}
	renderApp();
}

/** Toggle Show Busy for the active view. */
export function toggleShowBusy(): void {
	setActiveSidebarViewFilter(state, "showBusy", !activeFilters().showBusy);
	renderApp();
}

/** Toggle Show Read for the active view. */
export function toggleShowRead(): void {
	setActiveSidebarViewFilter(state, "showRead", !activeFilters().showRead);
	renderApp();
}

function toggleShowTeams(): void {
	updateFilter("showTeams", !activeFilters().showTeams);
	renderApp();
}

let filtersAnchor: HTMLElement | null = null;
let filtersAnchorRect: { top: number; right: number; bottom: number; left: number } | null = null;

export function closeSidebarFiltersPopover(restoreFocus = false): void {
	if (!state.filtersPopoverOpen) return;
	state.filtersPopoverOpen = false;
	const anchor = filtersAnchor;
	renderApp();
	if (restoreFocus && anchor?.isConnected) requestAnimationFrame(() => anchor.focus());
}

function toggleFiltersPopover(event: Event): void {
	event.stopPropagation();
	if (state.filtersPopoverOpen) {
		closeSidebarFiltersPopover();
		return;
	}
	filtersAnchor = event.currentTarget as HTMLElement;
	const rect = filtersAnchor.getBoundingClientRect();
	filtersAnchorRect = { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
	state.filtersPopoverOpen = true;
	renderApp();
}

if (typeof document !== "undefined") {
	document.addEventListener("click", () => closeSidebarFiltersPopover());
	document.addEventListener("keydown", (event: KeyboardEvent) => {
		if (event.key !== "Escape" || !state.filtersPopoverOpen) return;
		event.preventDefault();
		event.stopPropagation();
		closeSidebarFiltersPopover(true);
	}, true);
}

function renderToggleRow(options: {
	id: string;
	icon: typeof Archive;
	label: string;
	shortcut?: string;
	checked: boolean;
	onToggle: () => void;
}): TemplateResult {
	return html`
		<label class="sidebar-filter-row" data-testid="sidebar-filter-${options.id}">
			<input
				type="checkbox"
				class="w-4 h-4 rounded border-input accent-primary cursor-pointer"
				.checked=${options.checked}
				@change=${(event: Event) => { event.stopPropagation(); options.onToggle(); }}
				@click=${(event: Event) => event.stopPropagation()}
			/>
			<span class="sidebar-filter-row-icon">${icon(options.icon, "sm")}</span>
			<span class="sidebar-filter-row-label">${options.label}</span>
			${options.shortcut ? html`<span class="sidebar-filter-shortcut">${options.shortcut}</span>` : nothing}
		</label>
	`;
}

function renderPopover(): TemplateResult | typeof nothing {
	if (!state.filtersPopoverOpen) return nothing;
	const margin = 8;
	const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
	const width = Math.min(236, viewportWidth - margin * 2);
	const anchor = filtersAnchorRect ?? { top: 40, right: 260, bottom: 56, left: 0 };
	const left = Math.max(margin, Math.min(anchor.right - width, viewportWidth - width - margin));
	const filters = activeFilters();
	const title = state.sidebarSessionView === "project" ? "By Project filters" : "By Status filters";
	return html`
		<div
			class="sidebar-filters-popover"
			style="width:${width}px;left:${left}px;top:${anchor.bottom + 4}px;"
			role="dialog"
			aria-label=${title}
			data-testid="sidebar-filters-popover"
			@click=${(event: Event) => event.stopPropagation()}
		>
			<div class="sidebar-filter-title">${title}</div>
			${renderToggleRow({
				id: "archived",
				icon: Archive,
				label: "Show archived",
				shortcut: shortcutHint("ui.toggle-show-archived", { prefix: "", suffix: "" }) || "Alt+Shift+A",
				checked: filters.showArchived,
				onToggle: toggleShowArchived,
			})}
			${renderToggleRow({
				id: "busy",
				icon: Zap,
				label: "Show busy",
				shortcut: shortcutHint("ui.toggle-show-busy", { prefix: "", suffix: "" }) || "Alt+Shift+B",
				checked: filters.showBusy,
				onToggle: toggleShowBusy,
			})}
			${renderToggleRow({
				id: "read",
				icon: Eye,
				label: "Show read",
				shortcut: shortcutHint("ui.toggle-show-read", { prefix: "", suffix: "" }) || "Alt+Shift+R",
				checked: filters.showRead,
				onToggle: toggleShowRead,
			})}
			${state.sidebarSessionView === "status" ? renderToggleRow({
				id: "teams",
				icon: Users,
				label: "Show teams",
				checked: filters.showTeams === true,
				onToggle: toggleShowTeams,
			}) : nothing}
		</div>
	`;
}

/** Render the compact Filters trigger used beside the view selector. */
export function renderFiltersButton(variant: "desktop" | "mobile"): TemplateResult {
	const active = isSidebarViewFilterActive(activeFilters(), state.sidebarSessionView);
	return html`
		<button
			type="button"
			class="sidebar-mode-filter ${variant === "mobile" ? "sidebar-mode-filter--mobile" : ""}"
			data-active=${active || state.filtersPopoverOpen ? "true" : "false"}
			@click=${toggleFiltersPopover}
			title=${active ? "Filters (active)" : "Filters"}
			data-testid="sidebar-filters-button"
			aria-haspopup="dialog"
			aria-expanded=${state.filtersPopoverOpen ? "true" : "false"}
		>
			<span class="sidebar-view-control-icon">${icon(Filter, "xs")}</span>
			<span>Filters</span>
		</button>
		${renderPopover()}
	`;
}
