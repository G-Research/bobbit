import assert from "node:assert/strict";
import { afterAll, beforeEach, describe, it } from "vitest";
import {
	SIDEBAR_PROJECT_FILTER_STORAGE_KEYS,
	SIDEBAR_SESSION_VIEW_STORAGE_KEY,
	SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY,
	SIDEBAR_STATUS_FILTER_STORAGE_KEYS,
	getSidebarViewFilters,
	isSidebarViewFilterActive,
	loadSidebarSessionView,
	loadSidebarStatusCollapsedSections,
	loadSidebarStatusFilter,
	parseSidebarSessionView,
	resetSidebarViewFilters,
	setActiveSidebarViewFilter,
	setSidebarStatusSectionExpanded,
	setSidebarView,
	setSidebarViewFilter,
	sidebarNeedsArchivedSessions,
	type SidebarViewPreferenceState,
} from "../../src/app/sidebar-view-preferences.ts";

class MemoryStorage implements Storage {
	private values = new Map<string, string>();
	get length(): number { return this.values.size; }
	clear(): void { this.values.clear(); }
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
	removeItem(key: string): void { this.values.delete(key); }
	setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const storage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

afterAll(() => {
	if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
	else delete (globalThis as { localStorage?: Storage }).localStorage;
});

beforeEach(() => storage.clear());

function preferenceState(): SidebarViewPreferenceState {
	return {
		sidebarSessionView: "project",
		showArchived: false,
		showBusy: true,
		showRead: true,
		statusShowArchived: false,
		statusShowBusy: true,
		statusShowRead: true,
		statusShowTeams: false,
		statusCollapsedSections: new Set(),
		filtersPopoverOpen: false,
	};
}

describe("sidebar view preference validation", () => {
	it("defaults missing and corrupt view values to By Project", () => {
		assert.equal(loadSidebarSessionView(), "project");
		storage.setItem(SIDEBAR_SESSION_VIEW_STORAGE_KEY, "corrupt");
		assert.equal(loadSidebarSessionView(), "project");
		assert.equal(parseSidebarSessionView(null), "project");
		assert.equal(parseSidebarSessionView("status"), "status");
	});

	it("loads the exact Status defaults and accepts only explicit boolean strings", () => {
		assert.equal(loadSidebarStatusFilter("showArchived"), false);
		assert.equal(loadSidebarStatusFilter("showBusy"), true);
		assert.equal(loadSidebarStatusFilter("showRead"), true);
		assert.equal(loadSidebarStatusFilter("showTeams"), false);
		storage.setItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showArchived, "true");
		storage.setItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showBusy, "false");
		storage.setItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showRead, "garbage");
		storage.setItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showTeams, "garbage");
		assert.equal(loadSidebarStatusFilter("showArchived"), true);
		assert.equal(loadSidebarStatusFilter("showBusy"), false);
		assert.equal(loadSidebarStatusFilter("showRead"), true);
		assert.equal(loadSidebarStatusFilter("showTeams"), false);
	});

	it("persists only valid collapsed Status sections", () => {
		const state = preferenceState();
		setSidebarStatusSectionExpanded(state, "unread", false);
		setSidebarStatusSectionExpanded(state, "pinned", false);
		assert.deepEqual([...state.statusCollapsedSections!].sort(), ["pinned", "unread"]);
		assert.equal(storage.getItem(SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY), '["pinned","unread"]');
		assert.deepEqual([...loadSidebarStatusCollapsedSections()].sort(), ["pinned", "unread"]);

		storage.setItem(SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY, '["read","invalid",3]');
		assert.deepEqual([...loadSidebarStatusCollapsedSections()], ["read"]);
		storage.setItem(SIDEBAR_STATUS_COLLAPSED_SECTIONS_STORAGE_KEY, "corrupt");
		assert.deepEqual([...loadSidebarStatusCollapsedSections()], []);
	});
});

describe("independent sidebar view filters", () => {
	it("routes reads and writes without changing the other view", () => {
		const state = preferenceState();
		assert.equal(setSidebarViewFilter(state, "project", "showArchived", true), true);
		assert.equal(setSidebarViewFilter(state, "project", "showRead", false), true);
		assert.equal(setSidebarViewFilter(state, "status", "showTeams", true), true);
		assert.deepEqual(getSidebarViewFilters(state, "project"), {
			showArchived: true,
			showBusy: true,
			showRead: false,
		});
		assert.deepEqual(getSidebarViewFilters(state, "status"), {
			showArchived: false,
			showBusy: true,
			showRead: true,
			showTeams: true,
		});
		assert.equal(storage.getItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS.showArchived), "true");
		assert.equal(storage.getItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS.showRead), "false");
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showTeams), "true");
	});

	it("rejects Show teams for By Project", () => {
		const state = preferenceState();
		assert.equal(setSidebarViewFilter(state, "project", "showTeams", true), false);
		assert.equal(state.statusShowTeams, false);
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showTeams), null);
	});

	it("routes existing shortcuts to the active view", () => {
		const state = preferenceState();
		setActiveSidebarViewFilter(state, "showBusy", false);
		assert.equal(state.showBusy, false);
		assert.equal(state.statusShowBusy, true);
		setSidebarView(state, "status");
		setActiveSidebarViewFilter(state, "showBusy", false);
		assert.equal(state.showBusy, false);
		assert.equal(state.statusShowBusy, false);
	});

	it("switches only the view, closes Filters, and preserves both filter sets", () => {
		const state = preferenceState();
		state.showArchived = true;
		state.statusShowTeams = true;
		state.filtersPopoverOpen = true;
		const before = { project: getSidebarViewFilters(state, "project"), status: getSidebarViewFilters(state, "status") };
		setSidebarView(state, "status");
		assert.equal(state.sidebarSessionView, "status");
		assert.equal(state.filtersPopoverOpen, false);
		assert.deepEqual(getSidebarViewFilters(state, "project"), before.project);
		assert.deepEqual(getSidebarViewFilters(state, "status"), before.status);
		assert.equal(storage.getItem(SIDEBAR_SESSION_VIEW_STORAGE_KEY), "status");
	});

	it("computes active styling against only the active view defaults", () => {
		const state = preferenceState();
		assert.equal(isSidebarViewFilterActive(getSidebarViewFilters(state, "project"), "project"), false);
		assert.equal(isSidebarViewFilterActive(getSidebarViewFilters(state, "status"), "status"), false);
		state.statusShowTeams = true;
		assert.equal(isSidebarViewFilterActive(getSidebarViewFilters(state, "project"), "project"), false);
		assert.equal(isSidebarViewFilterActive(getSidebarViewFilters(state, "status"), "status"), true);
	});

	it("resets only the active Project filters to their exact persisted defaults and closes Filters", () => {
		const state = preferenceState();
		state.showArchived = true;
		state.showBusy = false;
		state.showRead = false;
		state.statusShowArchived = true;
		state.statusShowBusy = false;
		state.statusShowRead = false;
		state.statusShowTeams = true;
		state.filtersPopoverOpen = true;
		const inactiveBefore = getSidebarViewFilters(state, "status");

		resetSidebarViewFilters(state, "project");

		assert.deepEqual(getSidebarViewFilters(state, "project"), {
			showArchived: false,
			showBusy: true,
			showRead: true,
		});
		assert.deepEqual(getSidebarViewFilters(state, "status"), inactiveBefore);
		assert.equal(state.filtersPopoverOpen, false);
		assert.equal(storage.getItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS.showArchived), "false");
		assert.equal(storage.getItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS.showBusy), "true");
		assert.equal(storage.getItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS.showRead), "true");
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showArchived), null);
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showBusy), null);
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showRead), null);
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showTeams), null);
	});

	it("resets only the active Status filters, including teams, to exact persisted defaults", () => {
		const state = preferenceState();
		state.sidebarSessionView = "status";
		state.showArchived = true;
		state.showBusy = false;
		state.showRead = false;
		state.statusShowArchived = true;
		state.statusShowBusy = false;
		state.statusShowRead = false;
		state.statusShowTeams = true;
		state.filtersPopoverOpen = true;
		const inactiveBefore = getSidebarViewFilters(state, "project");

		resetSidebarViewFilters(state, "status");

		assert.deepEqual(getSidebarViewFilters(state, "status"), {
			showArchived: false,
			showBusy: true,
			showRead: true,
			showTeams: false,
		});
		assert.deepEqual(getSidebarViewFilters(state, "project"), inactiveBefore);
		assert.equal(state.filtersPopoverOpen, false);
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showArchived), "false");
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showBusy), "true");
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showRead), "true");
		assert.equal(storage.getItem(SIDEBAR_STATUS_FILTER_STORAGE_KEYS.showTeams), "false");
		assert.equal(storage.getItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS.showArchived), null);
		assert.equal(storage.getItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS.showBusy), null);
		assert.equal(storage.getItem(SIDEBAR_PROJECT_FILTER_STORAGE_KEYS.showRead), null);
	});

	it("keeps archives while either view or ephemeral search demands them", () => {
		const state = preferenceState();
		assert.equal(sidebarNeedsArchivedSessions(state), false);
		state.showArchived = true;
		assert.equal(sidebarNeedsArchivedSessions(state), true);
		state.showArchived = false;
		state.statusShowArchived = true;
		assert.equal(sidebarNeedsArchivedSessions(state), true);
		state.statusShowArchived = false;
		assert.equal(sidebarNeedsArchivedSessions(state, true), true);
	});
});
