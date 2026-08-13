import { safeGetItem, safeSetItem } from "./safe-storage.js";

export type SidebarSessionView = "project" | "status";
export type SidebarStatusSectionKey = "pinned" | "unread" | "read";
export type SidebarViewFilterKey = "showArchived" | "showBusy" | "showRead" | "showTeams";

export interface SidebarViewFilters {
	showArchived: boolean;
	showBusy: boolean;
	showRead: boolean;
	showTeams?: boolean;
}

/** The small state surface owned by the view-preference adapter. */
export interface SidebarViewPreferenceState {
	sidebarSessionView: SidebarSessionView;
	showArchived: boolean;
	showBusy: boolean;
	showRead: boolean;
	statusShowArchived: boolean;
	statusShowBusy: boolean;
	statusShowRead: boolean;
	statusShowTeams: boolean;
	/** Transient exact-session inclusion owned by the explicit reveal action. */
	sidebarRevealSessionId?: string | null;
	statusCollapsedSections?: Set<SidebarStatusSectionKey>;
	filtersPopoverOpen?: boolean;
}

export const SIDEBAR_SESSION_VIEW_STORAGE_KEY = "bobbit-sidebar-session-view";
export const SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY = "bobbit-status-collapsed-sections";
export const SIDEBAR_PROJECT_FILTER_STORAGE_KEYS = {
	showArchived: "bobbit-show-archived",
	showBusy: "bobbit-show-busy",
	showRead: "bobbit-show-read",
} as const;
export const SIDEBAR_STATUS_FILTER_STORAGE_KEYS = {
	showArchived: "bobbit-status-show-archived",
	showBusy: "bobbit-status-show-busy",
	showRead: "bobbit-status-show-read",
	showTeams: "bobbit-status-show-teams",
} as const;

export const SIDEBAR_PROJECT_FILTER_DEFAULTS: Readonly<SidebarViewFilters> = Object.freeze({
	showArchived: false,
	showBusy: true,
	showRead: true,
});
export const SIDEBAR_STATUS_FILTER_DEFAULTS: Readonly<Required<SidebarViewFilters>> = Object.freeze({
	showArchived: false,
	showBusy: true,
	showRead: true,
	showTeams: false,
});

export function parseSidebarSessionView(value: unknown): SidebarSessionView {
	return value === "status" ? "status" : "project";
}

export function loadSidebarSessionView(): SidebarSessionView {
	return parseSidebarSessionView(safeGetItem(SIDEBAR_SESSION_VIEW_STORAGE_KEY));
}

export function loadSidebarStatusFilter(key: keyof typeof SIDEBAR_STATUS_FILTER_STORAGE_KEYS): boolean {
	const value = safeGetItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS[key]);
	return SIDEBAR_STATUS_FILTER_DEFAULTS[key] ? value !== "false" : value === "true";
}

export function loadSidebarStatusCollapsedSections(): Set<SidebarStatusSectionKey> {
	const value = safeGetItem(SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY);
	if (!value) return new Set();
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((key): key is SidebarStatusSectionKey => key === "pinned" || key === "unread" || key === "read"));
	} catch {
		return new Set();
	}
}

export function setSidebarStatusSectionExpanded(
	preferenceState: SidebarViewPreferenceState,
	key: SidebarStatusSectionKey,
	expanded: boolean,
): void {
	const collapsed = preferenceState.statusCollapsedSections ?? new Set<SidebarStatusSectionKey>();
	if (expanded) collapsed.delete(key);
	else collapsed.add(key);
	preferenceState.statusCollapsedSections = collapsed;
	safeSetItem(SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY, JSON.stringify([...collapsed].sort()));
}

export function getSidebarViewFilters(
	preferenceState: Readonly<SidebarViewPreferenceState>,
	view: SidebarSessionView,
): SidebarViewFilters {
	if (view === "status") {
		return {
			showArchived: preferenceState.statusShowArchived,
			showBusy: preferenceState.statusShowBusy,
			showRead: preferenceState.statusShowRead,
			showTeams: preferenceState.statusShowTeams,
		};
	}
	return {
		showArchived: preferenceState.showArchived,
		showBusy: preferenceState.showBusy,
		showRead: preferenceState.showRead,
	};
}

/** Persist only the selected view. Filter values and other sidebar state are untouched. */
export function setSidebarView(
	preferenceState: SidebarViewPreferenceState,
	view: SidebarSessionView,
): void {
	preferenceState.sidebarSessionView = parseSidebarSessionView(view);
	preferenceState.sidebarRevealSessionId = null;
	preferenceState.filtersPopoverOpen = false;
	safeSetItem(SIDEBAR_SESSION_VIEW_STORAGE_KEY, preferenceState.sidebarSessionView);
}

/**
 * Set one filter for one view. Project deliberately rejects Show teams because
 * that filter exists only in By Status.
 */
export function setSidebarViewFilter(
	preferenceState: SidebarViewPreferenceState,
	view: SidebarSessionView,
	key: SidebarViewFilterKey,
	value: boolean,
): boolean {
	if (typeof value !== "boolean") return false;
	// A manual filter choice supersedes the prior one-shot reveal inclusion.
	// resetSidebarViewFilters intentionally clears it too; the reveal transaction
	// installs its exact target only after that reset completes.
	preferenceState.sidebarRevealSessionId = null;
	if (view === "project") {
		if (key === "showTeams") return false;
		preferenceState[key] = value;
		safeSetItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS[key], String(value));
		return true;
	}
	const stateKey = ({
		showArchived: "statusShowArchived",
		showBusy: "statusShowBusy",
		showRead: "statusShowRead",
		showTeams: "statusShowTeams",
	} as const)[key];
	preferenceState[stateKey] = value;
	safeSetItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS[key], String(value));
	return true;
}

/** Restore one view's canonical defaults without disturbing the inactive view. */
export function resetSidebarViewFilters(
	preferenceState: SidebarViewPreferenceState,
	view: SidebarSessionView,
): void {
	const defaults = view === "status" ? SIDEBAR_STATUS_FILTER_DEFAULTS : SIDEBAR_PROJECT_FILTER_DEFAULTS;
	setSidebarViewFilter(preferenceState, view, "showArchived", defaults.showArchived);
	setSidebarViewFilter(preferenceState, view, "showBusy", defaults.showBusy);
	setSidebarViewFilter(preferenceState, view, "showRead", defaults.showRead);
	if (view === "status") setSidebarViewFilter(preferenceState, view, "showTeams", SIDEBAR_STATUS_FILTER_DEFAULTS.showTeams);
	preferenceState.filtersPopoverOpen = false;
}

/** Route existing Archived/Busy/Read shortcuts through whichever view is active. */
export function setActiveSidebarViewFilter(
	preferenceState: SidebarViewPreferenceState,
	key: Exclude<SidebarViewFilterKey, "showTeams">,
	value: boolean,
): void {
	setSidebarViewFilter(preferenceState, preferenceState.sidebarSessionView, key, value);
}

export function isSidebarViewFilterActive(
	filters: Readonly<SidebarViewFilters>,
	view: SidebarSessionView,
): boolean {
	const defaults = view === "status" ? SIDEBAR_STATUS_FILTER_DEFAULTS : SIDEBAR_PROJECT_FILTER_DEFAULTS;
	return filters.showArchived !== defaults.showArchived
		|| filters.showBusy !== defaults.showBusy
		|| filters.showRead !== defaults.showRead
		|| (view === "status" && Boolean(filters.showTeams) !== defaults.showTeams);
}

/** Shared archive cache demand: either persisted toggle or ephemeral search demand keeps it alive. */
export function sidebarNeedsArchivedSessions(
	preferenceState: Readonly<SidebarViewPreferenceState>,
	archivedSearchDemand = false,
): boolean {
	return preferenceState.showArchived || preferenceState.statusShowArchived || archivedSearchDemand;
}
