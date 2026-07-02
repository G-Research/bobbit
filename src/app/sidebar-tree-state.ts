import { safeGetJSON, safeSetItem } from "./safe-storage.js";
import {
	isSidebarTreeExpandable,
	parseSidebarTreeKey,
	sidebarTreeKey,
	type SidebarTreeExpansionInput,
	type SidebarTreeNodeKey,
} from "./sidebar-tree-builder.js";

export type SidebarTreePreference = "expanded" | "collapsed";

export const SIDEBAR_TREE_STATE_STORAGE_KEY = "bobbit-sidebar-tree-state:v1";

interface SidebarTreeExpansionStateV1 {
	version: 1;
	expansion: Record<string, SidebarTreePreference>;
}

const LEGACY_EXPANDED_PROJECTS_KEY = "bobbit-expanded-projects";
const LEGACY_EXPANDED_GOALS_KEY = "bobbit-expanded-goals";
const LEGACY_COLLAPSED_UNGROUPED_KEY = "bobbit-collapsed-ungrouped";
const LEGACY_COLLAPSED_STAFF_KEY = "bobbit-collapsed-staff";
const LEGACY_COLLAPSED_ARCHIVED_KEY = "bobbit-archived-collapsed-projects";
const LEGACY_COLLAPSED_TEAM_LEADS_KEY = "bobbit-collapsed-team-leads";
const LEGACY_COLLAPSED_FIRST_CLASS_PARENTS_KEY = "bobbit-collapsed-first-class-parents";
const LEGACY_EXPANDED_DELEGATE_PARENTS_KEY = "bobbit-expanded-delegate-parents";

const expansionPreferences = new Map<string, SidebarTreePreference>();

let hasLoadedState = false;

function isPreference(value: unknown): value is SidebarTreePreference {
	return value === "expanded" || value === "collapsed";
}

function parseStoredState(value: unknown): SidebarTreeExpansionStateV1 | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as { version?: unknown; expansion?: unknown };
	if (candidate.version !== 1 || !candidate.expansion || typeof candidate.expansion !== "object" || Array.isArray(candidate.expansion)) return undefined;
	const expansion: Record<string, SidebarTreePreference> = {};
	for (const [key, preference] of Object.entries(candidate.expansion as Record<string, unknown>)) {
		if (isPreference(preference) && parseSidebarTreeKey(key)) expansion[key] = preference;
	}
	return { version: 1, expansion };
}

function readStoredState(): SidebarTreeExpansionStateV1 | undefined {
	return parseStoredState(safeGetJSON<unknown>(SIDEBAR_TREE_STATE_STORAGE_KEY, undefined));
}

function readLegacyStringArray(key: string): string[] {
	const value = safeGetJSON<unknown>(key, []);
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function putIfMissing(key: SidebarTreeNodeKey, preference: SidebarTreePreference): boolean {
	const canonicalKey = sidebarTreeKey(key);
	if (expansionPreferences.has(canonicalKey)) return false;
	expansionPreferences.set(canonicalKey, preference);
	return true;
}

function migrateLegacyState(): boolean {
	let changed = false;

	for (const entry of readLegacyStringArray(LEGACY_EXPANDED_PROJECTS_KEY)) {
		if (entry.startsWith("collapsed:")) {
			const projectId = entry.slice("collapsed:".length);
			if (projectId) changed = putIfMissing({ kind: "project", projectId }, "collapsed") || changed;
		} else {
			changed = putIfMissing({ kind: "project", projectId: entry }, "expanded") || changed;
		}
	}

	for (const goalId of readLegacyStringArray(LEGACY_EXPANDED_GOALS_KEY)) {
		changed = putIfMissing({ kind: "goal", goalId }, "expanded") || changed;
	}
	for (const projectId of readLegacyStringArray(LEGACY_COLLAPSED_UNGROUPED_KEY)) {
		changed = putIfMissing({ kind: "project-sessions", projectId }, "collapsed") || changed;
	}
	for (const projectId of readLegacyStringArray(LEGACY_COLLAPSED_STAFF_KEY)) {
		changed = putIfMissing({ kind: "project-staff", projectId }, "collapsed") || changed;
	}
	for (const projectId of readLegacyStringArray(LEGACY_COLLAPSED_ARCHIVED_KEY)) {
		changed = putIfMissing({ kind: "project-archived", projectId }, "collapsed") || changed;
	}
	for (const sessionId of readLegacyStringArray(LEGACY_COLLAPSED_TEAM_LEADS_KEY)) {
		changed = putIfMissing({ kind: "team-lead", sessionId }, "collapsed") || changed;
	}
	for (const sessionId of readLegacyStringArray(LEGACY_COLLAPSED_FIRST_CLASS_PARENTS_KEY)) {
		changed = putIfMissing({ kind: "session-children", sessionId, childClass: "first-class" }, "collapsed") || changed;
	}
	for (const sessionId of readLegacyStringArray(LEGACY_EXPANDED_DELEGATE_PARENTS_KEY)) {
		changed = putIfMissing({ kind: "session-children", sessionId, childClass: "archived-delegate" }, "expanded") || changed;
	}

	return changed;
}

function persistSidebarTreeState(): void {
	const expansion = Object.fromEntries([...expansionPreferences.entries()].sort(([a], [b]) => a.localeCompare(b)));
	safeSetItem(SIDEBAR_TREE_STATE_STORAGE_KEY, JSON.stringify({ version: 1, expansion } satisfies SidebarTreeExpansionStateV1));
}

function loadSidebarTreeState(): void {
	if (hasLoadedState) return;
	hasLoadedState = true;

	const stored = readStoredState();
	if (stored) {
		for (const [key, preference] of Object.entries(stored.expansion)) {
			expansionPreferences.set(key, preference);
		}
	}

	if (migrateLegacyState()) persistSidebarTreeState();
}

loadSidebarTreeState();

function preferenceKey(key: SidebarTreeNodeKey): string {
	return sidebarTreeKey(key);
}

export function sidebarTreeDefaultExpanded(key: SidebarTreeNodeKey): boolean {
	switch (key.kind) {
		case "project":
		case "project-sessions":
		case "project-staff":
		case "project-archived":
		case "team-lead": return true;
		case "session-children": return key.childClass === "first-class";
		case "goal":
		case "session": return false;
	}
}

export function getSidebarTreePreference(key: SidebarTreeNodeKey): SidebarTreePreference | undefined {
	return expansionPreferences.get(preferenceKey(key));
}

export function isSidebarTreeExpanded(key: SidebarTreeNodeKey, defaultExpanded?: boolean): boolean {
	const preference = getSidebarTreePreference(key);
	if (preference) return preference === "expanded";
	return defaultExpanded ?? sidebarTreeDefaultExpanded(key);
}

export function setSidebarTreeExpanded(key: SidebarTreeNodeKey, expanded: boolean): void {
	if (!isSidebarTreeExpandable(key)) return;
	expansionPreferences.set(preferenceKey(key), expanded ? "expanded" : "collapsed");
	persistSidebarTreeState();
}

export function toggleSidebarTreeExpanded(key: SidebarTreeNodeKey): boolean {
	if (!isSidebarTreeExpandable(key)) return isSidebarTreeExpanded(key);
	const expanded = !isSidebarTreeExpanded(key);
	setSidebarTreeExpanded(key, expanded);
	return expanded;
}

export function expandSidebarTreeNode(key: SidebarTreeNodeKey, opts?: { explicit?: boolean }): void {
	if (!isSidebarTreeExpandable(key)) return;
	const explicit = opts?.explicit !== false;
	if (!explicit && getSidebarTreePreference(key)) return;
	if (!explicit && sidebarTreeDefaultExpanded(key)) return;
	setSidebarTreeExpanded(key, true);
}

export function collapseSidebarTreeNode(key: SidebarTreeNodeKey): void {
	setSidebarTreeExpanded(key, false);
}

export function clearSidebarTreePreference(key: SidebarTreeNodeKey): void {
	if (!expansionPreferences.delete(preferenceKey(key))) return;
	persistSidebarTreeState();
}

export function sidebarTreeExpansionInput(): SidebarTreeExpansionInput {
	return {
		defaultExpanded: (key, fallback) => key.kind === "session" ? fallback : sidebarTreeDefaultExpanded(key),
		isExpanded: (key, defaultExpanded) => isSidebarTreeExpanded(key, defaultExpanded),
	};
}

export function resetArchivedSidebarTreeExpansion(opts: { archivedGoalIds: Iterable<string>; archivedSessionIds: Iterable<string> }): void {
	let changed = false;
	for (const goalId of opts.archivedGoalIds) {
		changed = expansionPreferences.delete(sidebarTreeKey({ kind: "goal", goalId })) || changed;
	}
	for (const sessionId of opts.archivedSessionIds) {
		changed = expansionPreferences.delete(sidebarTreeKey({ kind: "team-lead", sessionId })) || changed;
		changed = expansionPreferences.delete(sidebarTreeKey({ kind: "session-children", sessionId, childClass: "first-class" })) || changed;
		changed = expansionPreferences.delete(sidebarTreeKey({ kind: "session-children", sessionId, childClass: "archived-delegate" })) || changed;
	}
	if (changed) persistSidebarTreeState();
}

export function isProjectExpanded(projectId: string): boolean {
	return isSidebarTreeExpanded({ kind: "project", projectId });
}

export function toggleProjectExpanded(projectId: string): void {
	toggleSidebarTreeExpanded({ kind: "project", projectId });
}

export function isUngroupedExpanded(projectId: string): boolean {
	return isSidebarTreeExpanded({ kind: "project-sessions", projectId });
}

export function setUngroupedExpanded(projectId: string, expanded: boolean): void {
	setSidebarTreeExpanded({ kind: "project-sessions", projectId }, expanded);
}

export function isStaffExpanded(projectId: string): boolean {
	return isSidebarTreeExpanded({ kind: "project-staff", projectId });
}

export function setStaffSectionExpanded(projectId: string, expanded: boolean): void {
	setSidebarTreeExpanded({ kind: "project-staff", projectId }, expanded);
}

export function isArchivedSectionExpanded(projectId: string): boolean {
	return isSidebarTreeExpanded({ kind: "project-archived", projectId });
}

export function setArchivedSectionExpanded(projectId: string, expanded: boolean): void {
	setSidebarTreeExpanded({ kind: "project-archived", projectId }, expanded);
}

export function isTeamLeadExpanded(sessionId: string): boolean {
	return isSidebarTreeExpanded({ kind: "team-lead", sessionId });
}

export function setTeamLeadExpanded(sessionId: string, expanded: boolean): void {
	setSidebarTreeExpanded({ kind: "team-lead", sessionId }, expanded);
}

export function toggleTeamLeadExpanded(sessionId: string): void {
	toggleSidebarTreeExpanded({ kind: "team-lead", sessionId });
}

export function isFirstClassParentExpanded(sessionId: string): boolean {
	return isSidebarTreeExpanded({ kind: "session-children", sessionId, childClass: "first-class" });
}

export function setFirstClassParentExpanded(sessionId: string, expanded: boolean): void {
	setSidebarTreeExpanded({ kind: "session-children", sessionId, childClass: "first-class" }, expanded);
}

export function toggleFirstClassParentExpanded(sessionId: string): void {
	toggleSidebarTreeExpanded({ kind: "session-children", sessionId, childClass: "first-class" });
}

export function isArchivedParentExpanded(sessionId: string): boolean {
	return isSidebarTreeExpanded({ kind: "session-children", sessionId, childClass: "archived-delegate" });
}

export function setArchivedParentExpanded(sessionId: string, expanded: boolean): void {
	setSidebarTreeExpanded({ kind: "session-children", sessionId, childClass: "archived-delegate" }, expanded);
}

export function toggleArchivedParentExpanded(sessionId: string): void {
	toggleSidebarTreeExpanded({ kind: "session-children", sessionId, childClass: "archived-delegate" });
}

export function isGoalExpanded(goalId: string): boolean {
	return isSidebarTreeExpanded({ kind: "goal", goalId });
}

export function setGoalExpanded(goalId: string, expanded: boolean): void {
	setSidebarTreeExpanded({ kind: "goal", goalId }, expanded);
}

export function toggleGoalExpanded(goalId: string): boolean {
	return toggleSidebarTreeExpanded({ kind: "goal", goalId });
}
