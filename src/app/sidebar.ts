import { icon } from "@mariozechner/mini-lit";
import { html, nothing, type TemplateResult } from "lit";
import { Archive, Bot, ChevronDown, Goal as GoalIcon, GripVertical, List, MessagesSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, Store, Users, Workflow, Wrench, Zap } from "lucide";
// Register search web components (self-registering via @customElement)
// Lazy-load via the shared widgets registrar; see render.ts for
// rationale. Both modules ship in one shared chunk fetched in parallel
// with entry.
import { ensureSearchBox } from "./lazy-widgets.js";
void ensureSearchBox();
import "./components/search-status-dot.js";
import {
	state,
	renderApp,
	setProjects,
	activeSessionId,
	isDesktop,
	setSidebarWidth,
	SIDEBAR_WIDTH_DEFAULT,
	getSidebarData,
	type Goal,
	type Project,
} from "./state.js";
import { showHeaderToast } from "./header-toast.js";
import { HEADQUARTERS_PROJECT_ID, isHeadquartersProject, projectIconComponent, projectIconKind, projectIconTestId } from "./headquarters.js";
import { createAndConnectSession, connectToSession } from "./session-manager.js";
import { cwdCombobox } from "./cwd-combobox.js";
import { showGoalDialog, showProjectDialog, showConnectionError } from "./dialogs-lazy.js";
import { startNewGoalFlow, showProjectPickerPopover } from "./goal-entry.js";
import { refreshSessions, retryLoadSessions, fetchRoles, reassignStaffProject, enqueueInboxManual, fetchArchivedSessions, archivedSessionsLoaded, fetchSandboxStatus, fetchArchivedGoalsPaginated, fetchArchivedSessionsPaginated, fetchArchivedSearchGoalsPaginated, fetchArchivedSearchSessionsPaginated, gatewayFetch, clearArchivedSessionsState, clearArchivedSearchState, scheduleArchivedRemoteSearch, fetchProjects, saveProjectOrder, refreshStaffStateFromApi } from "./api.js";
import { errorFromResponse, errorDetails } from "./error-helpers.js";
import { statusBobbit, sessionAcronym } from "./session-colors.js";
import { renderGoalGroup, renderTreeSessionNode, SESSION_ROW_PY, terseRelativeTime, hasUnseenActivity, formatSessionAge, renderSessionTitle, getProjectAccentColor, filterArchivedGoalsByQuery, filterArchivedSessionsByQuery, archivedDivider, bucketActiveArchived, passesSidebarFilters, isChildSession, isStandaloneArchivedSession, effectiveArchivedTeamGoalId } from "./render-helpers.js";
import { renderFiltersButton } from "../ui/components/sidebar-filters.js";
import { shortcutHint } from "./shortcut-registry.js";
import type { GatewaySession } from "./state.js";
import { isRouteActive, setHashRoute, toggleConfigPage } from "./routing.js";
import { buildSidebarTree, type GoalContext, type SessionChildrenContext, type SessionContext, type SidebarProjectTree, type SidebarTreeModel, type SidebarTreeNode, type TeamLeadContext } from "./sidebar-tree-builder.js";
import { safeSetItem } from "./safe-storage.js";
import { getActiveNavId } from "./sidebar-nav.js";
import {
	isProjectExpanded,
	toggleProjectExpanded,
	setUngroupedExpanded,
	isStaffExpanded,
	setStaffSectionExpanded,
	setArchivedSectionExpanded,
	toggleTeamLeadExpanded,
	toggleGoalExpanded,
	setFirstClassParentExpanded,
	setArchivedParentExpanded,
	sidebarTreeExpansionInput,
} from "./sidebar-tree-state.js";
import { loadSidebarTreeLayoutPreference, sidebarTreeBaseIndentStyle, sidebarTreeCollapsedIndentStyle, sidebarTreeHalfIndentStyle, sidebarTreeNodeIndentStyle, sidebarTreeTruncationIndentStyle } from "./sidebar-tree-layout.js";

export { isProjectExpanded, toggleProjectExpanded };

// ============================================================================
// PROJECT REORDER STATE
// ============================================================================

type ProjectReorderState = {
	activeId: string;
	pointerId: number;
	startProjectIds: string[];
	visualProjectIds: string[];
	dropIndex: number;
	suppressNextClick: boolean;
	startX: number;
	startY: number;
	dragging: boolean;
	keyboard: boolean;
};

const PROJECT_REORDER_DRAG_THRESHOLD_PX = 4;
let _projectReorderState: ProjectReorderState | null = null;
let _projectReorderMessage = "";
let _suppressProjectHeaderClick = false;
let _suppressProjectHeaderClickTimer: number | null = null;

function currentProjectIds(): string[] {
	// Only include projects that participate in user-controlled visible ordering:
	// exclude hidden and system projects, matching the server's participatesInVisibleOrder().
	return state.projects.filter(p => !p.hidden && p.id !== "system").map(p => p.id);
}

function completeProjectOrderIds(projectIds: string[]): string[] {
	const currentIds = new Set(currentProjectIds());
	const seen = new Set<string>();
	const complete: string[] = [];
	for (const id of projectIds) {
		if (!currentIds.has(id) || seen.has(id)) continue;
		seen.add(id);
		complete.push(id);
	}
	for (const project of state.projects) {
		if (seen.has(project.id)) continue;
		seen.add(project.id);
		complete.push(project.id);
	}
	return complete;
}

function orderProjectsByIds(projects: Project[], projectIds: string[]): Project[] {
	const byId = new Map(projects.map((project) => [project.id, project]));
	const seen = new Set<string>();
	const ordered: Project[] = [];
	for (const id of projectIds) {
		const project = byId.get(id);
		if (!project || seen.has(id)) continue;
		seen.add(id);
		ordered.push(project);
	}
	for (const project of projects) {
		if (seen.has(project.id)) continue;
		seen.add(project.id);
		ordered.push(project);
	}
	return ordered;
}

function projectOrdersDiffer(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return true;
	return a.some((id, index) => id !== b[index]);
}

function projectNameForId(projectId: string): string {
	return state.projects.find((project) => project.id === projectId)?.name || "project";
}

function setProjectReorderMessage(message: string): void {
	_projectReorderMessage = message;
}

export function renderProjectReorderLiveRegion() {
	return html`<div class="project-reorder-live" data-testid="project-reorder-live-region" aria-live="polite" aria-atomic="true">${_projectReorderMessage}</div>`;
}

function suppressNextProjectHeaderClick(): void {
	_suppressProjectHeaderClick = true;
	if (_suppressProjectHeaderClickTimer !== null) window.clearTimeout(_suppressProjectHeaderClickTimer);
	_suppressProjectHeaderClickTimer = window.setTimeout(() => {
		_suppressProjectHeaderClick = false;
		_suppressProjectHeaderClickTimer = null;
	}, 200);
}

function consumeProjectHeaderReorderClick(): boolean {
	if (!_suppressProjectHeaderClick && !_projectReorderState?.suppressNextClick) return false;
	_suppressProjectHeaderClick = false;
	if (_suppressProjectHeaderClickTimer !== null) {
		window.clearTimeout(_suppressProjectHeaderClickTimer);
		_suppressProjectHeaderClickTimer = null;
	}
	if (_projectReorderState) _projectReorderState.suppressNextClick = false;
	return true;
}

function addProjectReorderDocumentListeners(): void {
	document.addEventListener("pointermove", handleProjectReorderMove);
	document.addEventListener("pointerup", handleProjectReorderPointerUp);
	document.addEventListener("pointercancel", handleProjectReorderPointerCancel);
}

function removeProjectReorderDocumentListeners(): void {
	document.removeEventListener("pointermove", handleProjectReorderMove);
	document.removeEventListener("pointerup", handleProjectReorderPointerUp);
	document.removeEventListener("pointercancel", handleProjectReorderPointerCancel);
}

function focusProjectReorderHandle(projectId: string): void {
	requestAnimationFrame(() => {
		const handle = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="project-reorder-handle"]'))
			.find((el) => el.dataset.projectId === projectId);
		handle?.focus();
	});
}

export function isProjectReordering(): boolean {
	return _projectReorderState?.dragging === true;
}

export function projectOrderForRender(): Project[] {
	if (!isProjectReordering() || !_projectReorderState) return state.projects;
	return orderProjectsByIds(state.projects, _projectReorderState.visualProjectIds);
}

function beginProjectReorder(): void {
	const reorder = _projectReorderState;
	if (!reorder || reorder.dragging) return;
	reorder.dragging = true;
	reorder.visualProjectIds = completeProjectOrderIds(reorder.visualProjectIds);
	reorder.dropIndex = reorder.visualProjectIds.indexOf(reorder.activeId);
	setProjectReorderMessage(`Picked up ${projectNameForId(reorder.activeId)}.`);
	renderApp();
}

export function startProjectReorder(e: PointerEvent, projectId: string): void {
	if (e.pointerType === "mouse" && e.button !== 0) return;
	e.preventDefault();
	e.stopPropagation();
	if (_projectReorderState) return;
	const projectIds = currentProjectIds();
	if (!projectIds.includes(projectId)) return;
	_projectReorderState = {
		activeId: projectId,
		pointerId: e.pointerId,
		startProjectIds: projectIds,
		visualProjectIds: projectIds,
		dropIndex: projectIds.indexOf(projectId),
		suppressNextClick: true,
		startX: e.clientX,
		startY: e.clientY,
		dragging: false,
		keyboard: false,
	};
	addProjectReorderDocumentListeners();
	try {
		(e.currentTarget as HTMLElement | null)?.setPointerCapture?.(e.pointerId);
	} catch {
		// Pointer capture can fail when the handle is removed during a re-render.
	}
}

function updateProjectReorderFromPointer(clientY: number): void {
	const reorder = _projectReorderState;
	if (!reorder) return;
	const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-project-reorder-id]"))
		.filter((row) => row.dataset.projectReorderId && row.dataset.projectReorderId !== reorder.activeId && row.getClientRects().length > 0);
	let dropIndex = rows.length;
	for (let i = 0; i < rows.length; i++) {
		const rect = rows[i].getBoundingClientRect();
		if (clientY < rect.top + rect.height / 2) {
			dropIndex = i;
			break;
		}
	}
	const withoutActive = completeProjectOrderIds(reorder.visualProjectIds).filter((id) => id !== reorder.activeId);
	dropIndex = Math.max(0, Math.min(dropIndex, withoutActive.length));
	const nextIds = [...withoutActive];
	nextIds.splice(dropIndex, 0, reorder.activeId);
	reorder.dropIndex = dropIndex;
	if (!projectOrdersDiffer(nextIds, reorder.visualProjectIds)) return;
	reorder.visualProjectIds = nextIds;
	const beforeId = nextIds[dropIndex + 1];
	setProjectReorderMessage(beforeId
		? `Moved ${projectNameForId(reorder.activeId)} before ${projectNameForId(beforeId)}.`
		: `Moved ${projectNameForId(reorder.activeId)} to the end.`);
	renderApp();
}

export function handleProjectReorderMove(e: PointerEvent): void {
	const reorder = _projectReorderState;
	if (!reorder || reorder.keyboard || reorder.pointerId !== e.pointerId) return;
	e.preventDefault();
	if (!reorder.dragging) {
		const dx = e.clientX - reorder.startX;
		const dy = e.clientY - reorder.startY;
		if (Math.hypot(dx, dy) < PROJECT_REORDER_DRAG_THRESHOLD_PX) return;
		beginProjectReorder();
	}
	updateProjectReorderFromPointer(e.clientY);
}

function handleProjectReorderPointerUp(e: PointerEvent): void {
	const reorder = _projectReorderState;
	if (!reorder || reorder.keyboard || reorder.pointerId !== e.pointerId) return;
	e.preventDefault();
	e.stopPropagation();
	// Commit the previewed order on any release while dragging, even when the
	// pointer is dropped outside the list (e.g. far above it). The preview is
	// always clamped to a valid slot, so releasing anywhere saves that slot.
	// Only a non-drag (a click that never crossed the drag threshold) is a no-op;
	// cancellation is reserved for Escape / pointercancel.
	void finishProjectReorder(!reorder.dragging);
}

function handleProjectReorderPointerCancel(e: PointerEvent): void {
	const reorder = _projectReorderState;
	if (!reorder || reorder.keyboard || reorder.pointerId !== e.pointerId) return;
	e.preventDefault();
	e.stopPropagation();
	void finishProjectReorder(true);
}

function moveKeyboardProject(projectId: string, delta: number): void {
	const reorder = _projectReorderState;
	if (!reorder || reorder.activeId !== projectId) return;
	const ids = completeProjectOrderIds(reorder.visualProjectIds);
	const from = ids.indexOf(projectId);
	if (from < 0) return;
	const to = Math.max(0, Math.min(ids.length - 1, from + delta));
	if (to === from) return;
	ids.splice(from, 1);
	ids.splice(to, 0, projectId);
	reorder.visualProjectIds = ids;
	reorder.dropIndex = to;
	setProjectReorderMessage(`Moved ${projectNameForId(projectId)} to position ${to + 1} of ${ids.length}.`);
	renderApp();
	focusProjectReorderHandle(projectId);
}

function beginKeyboardProjectReorder(projectId: string): void {
	const projectIds = currentProjectIds();
	if (!projectIds.includes(projectId)) return;
	_projectReorderState = {
		activeId: projectId,
		pointerId: -1,
		startProjectIds: projectIds,
		visualProjectIds: projectIds,
		dropIndex: projectIds.indexOf(projectId),
		suppressNextClick: true,
		startX: 0,
		startY: 0,
		dragging: true,
		keyboard: true,
	};
	setProjectReorderMessage(`Picked up ${projectNameForId(projectId)}.`);
	renderApp();
	focusProjectReorderHandle(projectId);
}

export function handleProjectReorderKeyDown(e: KeyboardEvent, projectId: string): void {
	if (![" ", "Enter", "ArrowUp", "ArrowDown", "Escape"].includes(e.key)) return;
	const reorder = _projectReorderState;
	if (!reorder) {
		if (e.key !== " " && e.key !== "Enter") return;
		e.preventDefault();
		e.stopPropagation();
		beginKeyboardProjectReorder(projectId);
		return;
	}
	if (reorder.activeId !== projectId) return;
	e.preventDefault();
	e.stopPropagation();
	if (e.key === "Escape") {
		void finishProjectReorder(true);
	} else if (e.key === "ArrowUp") {
		moveKeyboardProject(projectId, -1);
	} else if (e.key === "ArrowDown") {
		moveKeyboardProject(projectId, 1);
	} else if (e.key === " " || e.key === "Enter") {
		void finishProjectReorder(false);
	}
}

function handleProjectReorderDocumentKeyDown(e: KeyboardEvent): void {
	if (e.key !== "Escape" || !_projectReorderState) return;
	e.preventDefault();
	e.stopPropagation();
	void finishProjectReorder(true);
}

document.addEventListener("keydown", handleProjectReorderDocumentKeyDown, true);

export async function finishProjectReorder(cancel = false): Promise<void> {
	const reorder = _projectReorderState;
	if (!reorder) return;
	removeProjectReorderDocumentListeners();
	const wasDragging = reorder.dragging;
	const startIds = completeProjectOrderIds(reorder.startProjectIds);
	const finalIds = completeProjectOrderIds(reorder.visualProjectIds);
	const originalProjects = orderProjectsByIds(state.projects, startIds);
	const optimisticProjects = orderProjectsByIds(state.projects, finalIds);
	const changed = projectOrdersDiffer(startIds, finalIds);
	if (reorder.suppressNextClick) suppressNextProjectHeaderClick();
	_projectReorderState = null;

	if (cancel || !wasDragging || !changed) {
		setProjectReorderMessage(cancel && wasDragging ? "Project reorder cancelled." : "");
		renderApp();
		return;
	}

	setProjects(optimisticProjects);
	setProjectReorderMessage(`Dropped ${projectNameForId(reorder.activeId)} at position ${finalIds.indexOf(reorder.activeId) + 1} of ${finalIds.length}.`);
	renderApp();

	const savedProjects = await saveProjectOrder(finalIds);
	if (savedProjects) {
		setProjects(savedProjects);
	} else {
		const restored = await fetchProjects();
		setProjects(restored.length > 0 || originalProjects.length === 0 ? restored : originalProjects);
	}
	renderApp();
}

export function renderProjectReorderHandle(project: Project) {
	const active = _projectReorderState?.activeId === project.id && _projectReorderState.dragging;
	return html`
		<button
			type="button"
			class="project-reorder-handle ${active ? "project-reorder-handle-active" : ""}"
			data-testid="project-reorder-handle"
			data-project-id=${project.id}
			aria-label=${`Reorder ${project.name}`}
			aria-pressed=${active ? "true" : "false"}
			aria-grabbed=${active ? "true" : "false"}
			title=${`Reorder ${project.name}`}
			@pointerdown=${(e: PointerEvent) => startProjectReorder(e, project.id)}
			@click=${(e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); consumeProjectHeaderReorderClick(); }}
			@keydown=${(e: KeyboardEvent) => handleProjectReorderKeyDown(e, project.id)}
		>
			${icon(GripVertical, "xs")}
		</button>
	`;
}

// ============================================================================
// ROLE PICKER
// ============================================================================

/** Currently selected role in the picker. */
let _pickerRole = "";
/** Whether the New Session role dropdown menu is expanded. */
let _pickerRoleDropdownOpen = false;
/** Whether the role dropdown opens upward (not enough room below the trigger). */
let _pickerRoleDropdownUp = false;
/** Max height (px) for the role dropdown so it never runs off the viewport. */
let _pickerRoleDropdownMaxH = 240;

/**
 * Open/close the New Session role dropdown. When opening, measure the trigger
 * against the viewport on the next frame so the menu flips up and/or caps its
 * height instead of extending off the bottom edge.
 */
function _toggleRoleDropdown(open: boolean): void {
	_pickerRoleDropdownOpen = open;
	// Default assumption while measuring: open downward, full height.
	if (open) { _pickerRoleDropdownUp = false; _pickerRoleDropdownMaxH = 240; }
	renderApp();
	if (!open) return;
	requestAnimationFrame(() => {
		if (!_pickerRoleDropdownOpen) return;
		const btn = document.querySelector("#picker-role-container button") as HTMLElement | null;
		if (!btn) return;
		const rect = btn.getBoundingClientRect();
		const MARGIN = 8;
		const DESIRED = 240;
		const spaceBelow = window.innerHeight - rect.bottom - MARGIN;
		const spaceAbove = rect.top - MARGIN;
		if (spaceBelow >= Math.min(DESIRED, 160) || spaceBelow >= spaceAbove) {
			_pickerRoleDropdownUp = false;
			_pickerRoleDropdownMaxH = Math.max(120, Math.min(DESIRED, spaceBelow - 4));
		} else {
			_pickerRoleDropdownUp = true;
			_pickerRoleDropdownMaxH = Math.max(120, Math.min(DESIRED, spaceAbove - 4));
		}
		renderApp();
	});
}
let _pickerCwd = "";
let _pickerCwdDropdownOpen = false;
let _pickerCwdHighlightIndex = -1;
let _pickerWorktree = true;
let _pickerSandbox = false;
/** Goal ID context for the picker (if launched from a goal). */
let _pickerGoalId: string | undefined;
/** Project context for the picker (if launched from a project section). */
let _pickerProjectId: string | undefined;
let _pickerProjectName: string | undefined;
/** Anchor rect for positioning the popover near the button. */
let _pickerAnchorRect: { top: number; right: number; bottom: number } | null = null;
/** Keyboard focus index for popover navigation (-1 = none). */
let _pickerFocusIndex = -1;

/** Item types in the flat focus list. */
type PickerItemType = "role" | "cwd" | "worktree" | "create";
interface PickerItem { type: PickerItemType; id: string; }

/** Build the flat ordered list of focusable items. */
function _buildPickerItems(): PickerItem[] {
	const items: PickerItem[] = [];
	// Role is a single dropdown control (one focus stop), not one item per role.
	// No focus stop when there are no roles (the control renders as static text).
	if (state.roles.length > 0) items.push({ type: "role", id: "role" });
	if (!_pickerProjectId) items.push({ type: "cwd", id: "cwd" });
	items.push({ type: "worktree", id: "worktree" });
	items.push({ type: "create", id: "create" });
	return items;
}

/** Toggle role picker dropdown, fetching roles if needed. */
export async function toggleRolePicker(e: Event, goalId?: string, opts?: { projectId?: string; projectName?: string; projectCwd?: string }): Promise<void> {
	e.stopPropagation();
	if (state.rolePickerOpen) {
		state.rolePickerOpen = false;
		renderApp();
		return;
	}
	_pickerCwd = opts?.projectCwd || "";
	_pickerCwdDropdownOpen = false;
	_pickerCwdHighlightIndex = -1;
	_pickerWorktree = true;
	_pickerGoalId = goalId;
	_pickerProjectId = opts?.projectId;
	_pickerProjectName = opts?.projectName;
	// Capture the button position for anchoring the popover
	const btn = e.currentTarget as HTMLElement;
	if (btn) {
		const r = btn.getBoundingClientRect();
		_pickerAnchorRect = { top: r.top, right: r.right, bottom: r.bottom };
	}
	if (state.roles.length === 0) await fetchRoles();
	// New standard sessions always default to the server-resolved general role.
	_pickerRole = "general";
	_pickerRoleDropdownOpen = false;
	_pickerFocusIndex = -1;
	state.rolePickerOpen = true;
	if (!state.sandboxStatus) {
		fetchSandboxStatus().then(s => { if (s) { state.sandboxStatus = s; renderApp(); } });
	}
	renderApp();
}

export function renderRolePickerDropdown() {
	if (!state.rolePickerOpen) return "";

	const selectRole = (roleName: string) => {
		_pickerRole = roleName;
		_pickerRoleDropdownOpen = false;
		renderApp();
	};
	const doCreate = () => {
		state.rolePickerOpen = false;
		_pickerRoleDropdownOpen = false;
		const cwd = _pickerCwd || undefined;
		const worktree = _pickerWorktree;
		const sandboxed = _pickerSandbox || undefined;
		const projectId = _pickerProjectId;
		_pickerCwd = "";
		_pickerCwdDropdownOpen = false;
		_pickerSandbox = false;
		_pickerProjectId = undefined;
		_pickerProjectName = undefined;
		createAndConnectSession(_pickerGoalId, _pickerRole || undefined, cwd, worktree, sandboxed, projectId);
	};

	// All roles including general (the server default)
	const allRoles = state.roles;
	const pickerItems = _buildPickerItems();
	const focusedItem = _pickerFocusIndex >= 0 && _pickerFocusIndex < pickerItems.length ? pickerItems[_pickerFocusIndex] : null;
	const isFocused = (type: PickerItemType, id: string) => focusedItem?.type === type && focusedItem?.id === id;

	// Compute fixed position: anchor below button, clamp to viewport edges
	const MARGIN = 8;
	const popoverWidth = Math.min(420, window.innerWidth - MARGIN * 2);
	const anchor = _pickerAnchorRect ?? { top: 40, right: 260, bottom: 56 };
	const spaceBelow = window.innerHeight - anchor.bottom - 4 - MARGIN;
	// If enough room below the button, anchor there; otherwise anchor to bottom edge
	const usesBottom = spaceBelow < 300;
	const topStyle = usesBottom ? `bottom: ${MARGIN}px` : `top: ${anchor.bottom + 4}px`;
	const maxHStyle = usesBottom
		? `max-height: ${window.innerHeight - MARGIN * 2}px`
		: `max-height: ${spaceBelow}px`;
	// Clamp right so the left edge stays >= MARGIN from the viewport left
	const maxRight = window.innerWidth - popoverWidth - MARGIN;
	const right = Math.min(maxRight, Math.max(MARGIN, window.innerWidth - anchor.right));

	return html`
		<div class="fixed z-50 rounded-md shadow-lg py-1"
			style="background: var(--popover); border: 1px solid var(--border); width: ${popoverWidth}px; ${topStyle}; right: ${right}px; ${maxHStyle}; display: flex; flex-direction: column;"
			@click=${(e: Event) => { e.stopPropagation(); if (_pickerRoleDropdownOpen) { _pickerRoleDropdownOpen = false; renderApp(); } }}>
			<div class="flex items-center px-3 pt-2 pb-1.5 shrink-0">
				<span class="flex-1 font-semibold text-foreground">Create New Session${_pickerProjectName ? html` <span class="text-muted-foreground font-normal">in ${_pickerProjectName}</span>` : ""}</span>
				<button class="p-0.5 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors" title="Close" @click=${() => { state.rolePickerOpen = false; renderApp(); }}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
				</button>
			</div>
			<!-- Role (dropdown menu — mirrors the Modify Session dialog) -->
			<div class="px-3 pt-1 pb-2 shrink-0" style="overflow: visible;">
				<div class="text-xs text-muted-foreground mb-1.5">Role</div>
				${allRoles.length === 0
					? html`<div class="py-1 text-muted-foreground">No roles defined</div>`
					: (() => {
						const selectedRoleObj = allRoles.find(r => r.name === _pickerRole);
						const selectedLabel = selectedRoleObj?.label || "General";
						const selectedAccessory = selectedRoleObj?.accessory ?? "none";
						const focused = isFocused("role", "role");
						return html`
						<div class="relative" id="picker-role-container">
							<button
								class="w-full text-left px-3 py-2 text-sm rounded-md border border-border bg-background hover:bg-secondary/50 transition-colors flex items-center gap-2.5 ${focused ? "ring-2 ring-ring" : ""}"
								@click=${(e: Event) => { e.stopPropagation(); _toggleRoleDropdown(!_pickerRoleDropdownOpen); }}
								title="Select role">
								<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, selectedAccessory, true)}</span>
								<span class="flex-1 truncate ${_pickerRole ? "text-foreground" : "text-muted-foreground"}">${selectedLabel}</span>
								<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="shrink-0 text-muted-foreground transition-transform ${_pickerRoleDropdownOpen ? "rotate-180" : ""}"><path d="m6 9 6 6 6-6"/></svg>
							</button>
							${_pickerRoleDropdownOpen ? html`
								<div class="absolute z-50 w-full rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 overflow-y-auto ${_pickerRoleDropdownUp ? "bottom-full mb-1" : "top-full mt-1"}" style="max-height: ${_pickerRoleDropdownMaxH}px;">
									${allRoles.map(role => html`
										<button
											class="w-full text-left px-3 py-2 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors flex items-center gap-2.5 ${_pickerRole === role.name ? "bg-accent/50" : ""}"
											@click=${(e: Event) => { e.stopPropagation(); selectRole(role.name); }}
											title="Select ${role.label} role">
											<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
											<span>${role.label}</span>
										</button>
									`)}
								</div>
							` : ""}
						</div>`;
					})()}
			</div>
			<!-- Working Directory (pinned at bottom, hidden when project is set) -->
			${!_pickerProjectId ? html`
			<div class="border-t border-border/50 px-3 py-2 shrink-0" style="overflow: visible;">
				<div class="text-muted-foreground uppercase tracking-wider font-medium mb-1.5" style="font-size: 0.75em;">Working Directory</div>
				${cwdCombobox({
					value: _pickerCwd,
					onInput: (v: string) => { _pickerCwd = v; renderApp(); },
					onSelect: (v: string) => { _pickerCwd = v; _pickerCwdDropdownOpen = false; renderApp(); },
					dropdownOpen: _pickerCwdDropdownOpen,
					onToggle: (open: boolean) => { _pickerCwdDropdownOpen = open; renderApp(); },
					highlightedIndex: _pickerCwdHighlightIndex,
					onHighlight: (i: number) => { _pickerCwdHighlightIndex = i; },
				})}
			</div>
			` : ""}
			<!-- Worktree checkbox -->
			<div class="border-t border-border/50 px-3 py-1.5 shrink-0">
				<label class="flex items-center gap-2 cursor-pointer ${isFocused("worktree", "worktree") ? "ring-2 ring-ring rounded" : ""}">
					<input type="checkbox" class="toggle-switch toggle-switch--sm" .checked=${_pickerWorktree}
						@change=${(e: Event) => { _pickerWorktree = (e.target as HTMLInputElement).checked; renderApp(); }} />
					<span class="text-foreground/70" style="font-size: 0.9167em;">Create worktree</span>
					<span title="Creates an isolated git branch and worktree for this session"
						class="text-muted-foreground cursor-help" style="font-size: 0.75em;">ⓘ</span>
				</label>
			</div>
			<!-- Sandbox checkbox -->
			<div class="border-t border-border/50 px-3 py-1.5 shrink-0">
				<label class="flex items-center gap-2 cursor-pointer">
					${(() => {
						const sandboxDisabled = !state.sandboxStatus?.available || (state.sandboxStatus?.available === true && state.sandboxStatus?.imageExists === false);
						const tooltip = !state.sandboxStatus?.available
							? `Docker unavailable: ${state.sandboxStatus?.error || "not detected"}`
							: state.sandboxStatus?.imageExists === false
								? `Sandbox image not found. Run: ${state.sandboxStatus?.buildCommand || "docker build -t bobbit-agent docker/"}`
								: "Run agent in an isolated Docker container";
						return html`
					<input type="checkbox" class="toggle-switch toggle-switch--sm" .checked=${_pickerSandbox}
						@change=${(e: Event) => { _pickerSandbox = (e.target as HTMLInputElement).checked; renderApp(); }}
						?disabled=${sandboxDisabled} />
					<span class="text-foreground/70 ${sandboxDisabled ? 'opacity-50' : ''}" style="font-size: 0.9167em;">Sandbox (Docker)</span>
					<span title=${tooltip}
						class="text-muted-foreground cursor-help" style="font-size: 0.75em;">ⓘ</span>
						`;
					})()}
				</label>
			</div>
			<!-- Create button (pinned at bottom) -->
			<div class="border-t border-border/50 px-3 py-2 shrink-0">
				<button
					class="w-full text-center px-3 py-1.5 rounded-md font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 ${isFocused("create", "create") ? "ring-2 ring-ring ring-offset-1 ring-offset-background" : ""}" style="font-size: 1.1667em;"
					@click=${doCreate}
					title="Create session with selected role"
				>Create Session</button>
			</div>
		</div>
	`;
}

// Close role picker on outside click
document.addEventListener("click", () => {
	if (state.rolePickerOpen) {
		state.rolePickerOpen = false;
		renderApp();
	}
});

// Global keyboard handler for role picker popover
document.addEventListener("keydown", (e: KeyboardEvent) => {
	if (!state.rolePickerOpen) return;
	const items = _buildPickerItems();
	const total = items.length;
	if (total === 0) return;

	const focusedItem = _pickerFocusIndex >= 0 && _pickerFocusIndex < total ? items[_pickerFocusIndex] : null;

	// If the cwd input has DOM focus, let it handle its own keys (typing, combobox nav)
	// Only intercept Escape and Tab out of cwd
	if (focusedItem?.type === "cwd") {
		const cwdInput = document.querySelector(".cwd-combobox input") as HTMLElement | null;
		const hasCwdFocus = cwdInput && document.activeElement === cwdInput;
		if (hasCwdFocus) {
			if (e.key === "Escape") {
				if (_pickerCwdDropdownOpen) {
					// Close cwd dropdown first
					_pickerCwdDropdownOpen = false;
					renderApp();
				} else {
					state.rolePickerOpen = false;
					renderApp();
				}
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			// Let cwd combobox handle ArrowUp/Down when its dropdown is open
			if (_pickerCwdDropdownOpen) return;
			// Tab / ArrowDown moves out of cwd to create button
			if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
				e.preventDefault();
				e.stopPropagation();
				_pickerFocusIndex = total - 1; // create button
				cwdInput.blur();
				renderApp();
				return;
			}
			// ArrowUp moves back to roles
			if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
				e.preventDefault();
				e.stopPropagation();
				_pickerFocusIndex = Math.max(0, _pickerFocusIndex - 1);
				cwdInput.blur();
				renderApp();
				return;
			}
			// Let all other keys pass through to the input
			return;
		}
	}

	if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		state.rolePickerOpen = false;
		renderApp();
		return;
	}

	if (e.key === "Enter") {
		e.preventDefault();
		e.stopPropagation();
		// If focused on a specific item, activate it; otherwise create session
		if (focusedItem?.type === "role") {
			_toggleRoleDropdown(!_pickerRoleDropdownOpen);
		} else if (focusedItem?.type === "worktree") {
			_pickerWorktree = !_pickerWorktree;
			renderApp();
		} else {
			// create button or no focus — create session
			state.rolePickerOpen = false;
			const cwd = _pickerCwd || undefined;
			const worktree = _pickerWorktree;
			_pickerCwd = "";
			_pickerCwdDropdownOpen = false;
			createAndConnectSession(_pickerGoalId, _pickerRole || undefined, cwd, worktree);
		}
		return;
	}

	if (e.key === " " && focusedItem) {
		e.preventDefault();
		e.stopPropagation();
		if (focusedItem.type === "role") {
			_toggleRoleDropdown(!_pickerRoleDropdownOpen);
		} else if (focusedItem.type === "worktree") {
			_pickerWorktree = !_pickerWorktree;
			renderApp();
		} else if (focusedItem.type === "create") {
			state.rolePickerOpen = false;
			const cwd = _pickerCwd || undefined;
			const worktree = _pickerWorktree;
			_pickerCwd = "";
			_pickerCwdDropdownOpen = false;
			createAndConnectSession(_pickerGoalId, _pickerRole || undefined, cwd, worktree);
		}
		return;
	}

	// Arrow navigation
	if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
		e.preventDefault();
		e.stopPropagation();
		if (_pickerFocusIndex < 0) {
			_pickerFocusIndex = 0;
		} else {
			_pickerFocusIndex = Math.min(total - 1, _pickerFocusIndex + 1);
		}
		_focusCwdIfNeeded(items);
		renderApp();
		return;
	}

	if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
		e.preventDefault();
		e.stopPropagation();
		if (_pickerFocusIndex < 0) {
			_pickerFocusIndex = total - 1;
		} else {
			_pickerFocusIndex = Math.max(0, _pickerFocusIndex - 1);
		}
		_focusCwdIfNeeded(items);
		renderApp();
		return;
	}

	if (e.key === "ArrowRight") {
		e.preventDefault();
		e.stopPropagation();
		if (_pickerFocusIndex < 0) { _pickerFocusIndex = 0; }
		else { _pickerFocusIndex = Math.min(total - 1, _pickerFocusIndex + 1); }
		_focusCwdIfNeeded(items);
		renderApp();
		return;
	}

	if (e.key === "ArrowLeft") {
		e.preventDefault();
		e.stopPropagation();
		if (_pickerFocusIndex < 0) { _pickerFocusIndex = 0; }
		else { _pickerFocusIndex = Math.max(0, _pickerFocusIndex - 1); }
		_focusCwdIfNeeded(items);
		renderApp();
		return;
	}
}, true); // capture phase so it fires before other handlers

/** When focus lands on the cwd item, move DOM focus to its input. */
function _focusCwdIfNeeded(items: PickerItem[]): void {
	const item = _pickerFocusIndex >= 0 ? items[_pickerFocusIndex] : null;
	if (item?.type === "cwd") {
		requestAnimationFrame(() => {
			const input = document.querySelector(".cwd-combobox input") as HTMLElement | null;
			input?.focus();
		});
	}
}

// ============================================================================
// SIDEBAR TOGGLE
// ============================================================================

// ============================================================================
// SIDEBAR RESIZE HANDLE
// ============================================================================

function onSidebarResizePointerDown(e: PointerEvent): void {
	e.preventDefault();
	const handle = e.currentTarget as HTMLElement;
	const sidebar = handle.parentElement as HTMLElement | null;
	if (!sidebar) return;
	const startX = e.clientX;
	const startW = sidebar.getBoundingClientRect().width;
	try { handle.setPointerCapture(e.pointerId); } catch {}
	document.body.style.cursor = "col-resize";
	document.body.style.userSelect = "none";

	const onMove = (ev: PointerEvent) => {
		const next = startW + (ev.clientX - startX);
		setSidebarWidth(next);
	};
	const onUp = (ev: PointerEvent) => {
		handle.removeEventListener("pointermove", onMove);
		handle.removeEventListener("pointerup", onUp);
		handle.removeEventListener("pointercancel", onUp);
		try { handle.releasePointerCapture(ev.pointerId); } catch {}
		document.body.style.cursor = "";
		document.body.style.userSelect = "";
	};
	handle.addEventListener("pointermove", onMove);
	handle.addEventListener("pointerup", onUp);
	handle.addEventListener("pointercancel", onUp);
}

function onSidebarResizeDoubleClick(e: MouseEvent): void {
	e.preventDefault();
	setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
}

export function toggleSidebar(): void {
	state.sidebarCollapsed = !state.sidebarCollapsed;
	safeSetItem("bobbit-sidebar-collapsed", String(state.sidebarCollapsed));
	renderApp();
}

// ============================================================================
// SIDEBAR GOAL — uses unified renderGoalGroup from render-helpers.ts
// ============================================================================

// ============================================================================
// STAFF SIDEBAR
// ============================================================================

/** Ensure staff list is loaded (called once). */
let _staffLoaded = false;
function ensureStaffLoaded(): void {
	if (_staffLoaded) return;
	_staffLoaded = true;
	if (!archivedSessionsLoaded()) {
		fetchArchivedSessions();
	}
	void reloadStaffList();
}

/** Reload staff list (e.g. after creating one). Also pulls the orphan list. */
export function reloadStaffList(): Promise<void> {
	return refreshStaffStateFromApi();
}

/**
 * Open a new staff-creation assistant session, anchored to the given project.
 *
 * Always supplies `projectId` + `cwd` so the server's POST /api/sessions can
 * resolve a real project context (see surface-staff-in-sessions design §5).
 * For callers outside a project bucket use {@link startNewStaffFlow}.
 */
export async function createStaffAssistantSession(
	e: Event,
	opts: { projectId: string; cwd: string },
): Promise<void> {
	e.stopPropagation();
	if (state.creatingSession) return;
	state.creatingSession = true;
	renderApp();
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ assistantType: "staff", projectId: opts.projectId, cwd: opts.cwd }),
		});
		if (!res.ok) {
			throw await errorFromResponse(res, `Session creation failed: ${res.status}`);
		}
		const { id } = await res.json();
		await connectToSession(id, false, { isStaffAssistant: true, assistantType: "staff" });
	} catch (err) {
		const { message, code, stack } = errorDetails(err);
		showConnectionError("Failed to create staff assistant", message, { code, stack });
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}

/**
 * Open the staff-creation assistant for the right project.
 *  - 1 project (and a projectId hint): use it directly.
 *  - 0 projects: bounce to the Add Project dialog.
 *  - ≥1 projects, no hint: open the project picker popover.
 */
export async function startNewStaffFlow(e: Event, projectIdHint?: string): Promise<void> {
	e.stopPropagation();
	const anchor = (e.currentTarget as HTMLElement) ?? null;
	if (projectIdHint) {
		const proj = state.projects.find(p => p.id === projectIdHint);
		if (proj) {
			return createStaffAssistantSession(e, { projectId: proj.id, cwd: proj.rootPath });
		}
		console.warn("[sidebar] startNewStaffFlow: project hint not found:", projectIdHint);
	}
	const projects = state.projects;
	if (projects.length === 0) { showProjectDialog(); return; }
	if (projects.length === 1) {
		const only = projects[0];
		return createStaffAssistantSession(e, { projectId: only.id, cwd: only.rootPath });
	}
	showProjectPickerPopover(anchor, (pickedId: string) => {
		const picked = state.projects.find(p => p.id === pickedId);
		if (!picked) return;
		void createStaffAssistantSession(e, { projectId: picked.id, cwd: picked.rootPath });
	});
}

async function handleStaffClick(agent: typeof state.staffList[0]): Promise<void> {
	// Staff agents always have a permanent session — just connect to it
	if (agent.currentSessionId) {
		const sessionExists = state.gatewaySessions.some((s) => s.id === agent.currentSessionId);
		if (sessionExists) {
			await connectToSession(agent.currentSessionId, true);
			return;
		}
		// Session was deleted — fall through to wake (creates a new one)
	}
	// Fallback for legacy staff without a session: enqueue an inbox entry; the
	// InboxNudger will create/recover the session and wake the agent next tick.
	await enqueueInboxManual(agent.id, {
		title: "Manual wake",
		prompt: "Manual wake from sidebar",
		source: { type: "manual_ui" },
	});
	await reloadStaffList();
	await refreshSessions();
	// If a session was recovered, focus it.
	const refreshed = state.staffList.find((s) => s.id === agent.id);
	if (refreshed?.currentSessionId) {
		await connectToSession(refreshed.currentSessionId, false);
	}
}

export function renderStaffSidebarSection(filteredList?: typeof state.staffList, projectId?: string, dataTreeKey?: string, expandedOverride?: boolean) {
	ensureStaffLoaded();
	const list = filteredList ?? state.staffList.filter((s) => s.state !== "retired");
	const mobile = !isDesktop();
	const staffExpanded = expandedOverride ?? isStaffExpanded(projectId || "");
	const staffProject = projectId ? state.projects.find((p) => p.id === projectId) : undefined;
	const staffAccentColor = staffProject ? getProjectAccentColor(staffProject) : "var(--primary)";
	// Always show the Staff section so users can create their first staff agent

	const staffNavId = `staff-header:${projectId || ""}`;
	const staffNavActive = getActiveNavId() === staffNavId;
	return html`
		<div class="border-t border-border/30 ${mobile ? "my-0.5" : "my-1"} mx-2"></div>
		<div class="flex flex-col gap-0.5">
			<div class="relative flex items-center ${mobile ? "gap-1 pl-0 pr-2 py-0.5" : "gap-1 pr-1 py-0.5"} rounded-md cursor-pointer ${staffNavActive ? "bg-secondary text-foreground sidebar-session-active" : (mobile ? "active:bg-secondary/50" : "hover:bg-secondary/30")} transition-colors"
				data-testid="sidebar-staff-header"
				data-tree-key=${dataTreeKey ?? ""}
				data-nav-id=${staffNavId}
				data-nav-active=${staffNavActive ? "true" : "false"}
				style="${mobile ? "" : "padding-left:var(--sidebar-header-chevron-w);"}"
				@click=${() => { setStaffSectionExpanded(projectId || "", !staffExpanded); renderApp(); }}>
				<span class="sidebar-chevron-slot ${mobile ? "sidebar-chevron-slot--header" : "sidebar-chevron-slot--header sidebar-chevron-slot--absolute"} text-muted-foreground shrink-0 select-none"><span class="sidebar-chevron-glyph">${staffExpanded ? "▾" : "▸"}</span></span>
				<span class="shrink-0 text-muted-foreground" style="${mobile ? "margin-left:-3px;margin-right:2px;" : "margin-left:-3px;"}">${icon(Bot, mobile ? "sm" : "xs")}</span>
				<span class="flex-1 min-w-0 truncate text-muted-foreground uppercase tracking-wider font-medium" style="font-size: ${mobile ? "1.1667em" : "0.75em"};">Staff</span>
				<div class="flex items-center" @click=${(e: Event) => e.stopPropagation()}>
					<button
						class="${mobile ? "p-1 rounded" : "p-0.5 rounded-md"} text-muted-foreground active:bg-secondary/50 hover:bg-secondary/50 transition-colors"
						@click=${() => { import("./staff-page.js").then((m) => m.loadStaffPageData()); setHashRoute("staff"); }}
						title="Manage staff agents"
					>${icon(List, mobile ? "sm" : "xs")}</button>
					<button
						class="${mobile ? "p-1 rounded active:bg-secondary/50" : "p-0.5 rounded-md hover:bg-secondary"} text-muted-foreground hover:text-foreground transition-colors relative shrink-0"
						style="line-height:0;"
						@click=${(e: Event) => startNewStaffFlow(e, projectId)}
						title="New staff agent"
					>
						<span class="sidebar-compound-icon ${mobile ? "sidebar-compound-icon--lg" : ""}" data-testid="sidebar-add-staff-icon">
							${icon(Bot, mobile ? "sm" : "xs", "sidebar-compound-base")}
							<svg data-testid="sidebar-add-staff-plus" class="sidebar-compound-plus" viewBox="0 0 10 10">
								<path d="M5 1V9M1 5H9" stroke="${staffAccentColor}" stroke-width="2.5" stroke-linecap="round"/>
							</svg>
						</span>
					</button>
				</div>
			</div>
			${staffExpanded ? html`<div class="flex flex-col gap-0.5" style="${sidebarTreeBaseIndentStyle()}">${list.filter((agent) => {
				// Hide staff agents whose current session is archived and belongs to a goal
				// — those show under their goal's archived section instead
				if (agent.currentSessionId) {
					const archivedSession = state.archivedSessions.find(s => s.id === agent.currentSessionId);
					if (archivedSession?.teamGoalId) return false;
				}
				return true;
			}).map((agent) => {
				const mobile = !isDesktop();
				const session = agent.currentSessionId
					? state.gatewaySessions.find((s) => s.id === agent.currentSessionId)
					: undefined;
				const active = activeSessionId() === agent.currentSessionId;
				const sessionStatus = session?.status || "terminated";
				const isCompacting = session?.isCompacting || false;
				const isAborting = session?.isAborting || false;
				const accessory = session?.accessory;
				const rowPy = SESSION_ROW_PY;
				const btnPad = mobile ? "p-1" : "p-0.5";
				const editBtn = html`<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
					@click=${(e: Event) => { e.stopPropagation(); window.location.hash = `#/staff/${agent.id}`; }}
					title="Edit">${icon(Pencil, "xs")}</button>`;
				const staffSessionNavId = agent.currentSessionId ? `session:${agent.currentSessionId}` : "";
				return html`
				<div class="${mobile ? "" : "group relative"} flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors
					${active ? "bg-secondary text-foreground sidebar-session-active" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
					data-nav-id=${staffSessionNavId}
					data-nav-active=${active ? "true" : "false"}
					style="padding-left:var(--sidebar-chevron-w);"
					@click=${() => handleStaffClick(agent)}>
					<span class="shrink-0 inline-flex items-center justify-center ${!active && session && hasUnseenActivity(session) ? "bobbit-unread-pulse" : ""}">${statusBobbit(sessionStatus, isCompacting, agent.currentSessionId, active, isAborting, false, false, accessory, false, !active && !!session && hasUnseenActivity(session), true)}</span>
					<div class="flex-1 min-w-0 ${mobile ? "flex items-center gap-1" : "truncate"} font-normal"><span class="block min-w-0 max-w-full truncate" style="${mobile ? "font-size: 1.3333em;" : ""}">${renderSessionTitle(agent.name, sessionStatus === "streaming" || sessionStatus === "busy" || isCompacting, state.searchQuery)}</span>${mobile && session ? (() => {
							const isActiveSession = sessionStatus === "streaming" || sessionStatus === "busy" || isCompacting;
							if (isActiveSession) { const _d = (agent.id.charCodeAt(0) % 5) * 1.8; return html`<span class="shrink-0 text-muted-foreground/40" style="font-size: 0.9167em;">·</span><span class="sidebar-active-dot" style="--dot-delay:${_d}s"></span>`; }
							const time = terseRelativeTime(session.lastActivity);
							if (!time) return "";
							const unseen = hasUnseenActivity(session);
							return html`<span class="shrink-0 text-muted-foreground/40" style="font-size: 0.9167em;">·</span><span class="shrink-0 inline-flex items-center gap-0.5 tabular-nums ${unseen ? "text-foreground/70 font-medium" : "text-muted-foreground/50"}" style="vertical-align:middle;font-size: 0.9167em;" title="${formatSessionAge(session.lastActivity)}">${time}${unseen ? html`<span class="unseen-dot" aria-label="unread"></span>` : ""}</span>`;
						})() : ""}</div>
					${mobile
						? editBtn
						: html`<div class="absolute right-0 top-0 bottom-0 flex items-center pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
							<span class="group-hover:hidden flex items-center">${session ? (() => {
								const time = terseRelativeTime(session.lastActivity);
								if (!time) return "";
								const unseen = hasUnseenActivity(session);
								return html`<span class="shrink-0 flex items-center gap-0.5 tabular-nums ${unseen ? "text-foreground/70 font-medium" : "text-muted-foreground/50"}" style="font-size: 0.75em;" title="${formatSessionAge(session.lastActivity)}">${time}${unseen ? html`<span class="unseen-dot" aria-label="unread"></span>` : ""}</span>`;
							})() : ""}</span>
							<div class="sidebar-actions sidebar-action-cluster hidden group-hover:flex items-center">
								${editBtn}
							</div>
						</div>`}
				</div>
			`; })}</div>` : ""}
	`;
}

// renderArchivedSessionRow is now in render-helpers.ts

// ============================================================================
// RENDER SIDEBAR
// ============================================================================

// ============================================================================
// SEARCH HANDLERS
// ============================================================================

/** Tracks whether archived section was auto-opened by search (vs manual toggle).
 *  Exported so that a manual toggle from the Filters popover (or its keyboard shortcut)
 *  can take precedence and prevent search-clear from undoing the user's choice. */
export function clearArchivedBySearch(): void { _archivedBySearch = false; }
let _archivedBySearch = false;

/** Ensure archived is visible for search without loading unfiltered archived pages. */
function _ensureArchivedForSearch(query: string): void {
	if (!state.showArchived) {
		state.showArchived = true;
		_archivedBySearch = true;
	}
	scheduleArchivedRemoteSearch(query);
}

/** If archived was auto-opened by search, close it. */
function _revertArchivedIfSearchOpened(): void {
	if (_archivedBySearch) {
		state.showArchived = false;
		_archivedBySearch = false;
		// Search auto-open is ephemeral. Clearing it may unload fetched archived
		// records, but it must never delete the user's persisted archived tree
		// expansion choices.
		clearArchivedSessionsState();
	}
}

export function handleSidebarSearchInput(query: string): void {
	state.searchQuery = query;
	if (!query.trim()) {
		clearArchivedSearchState();
		_revertArchivedIfSearchOpened();
		renderApp();
		return;
	}
	_ensureArchivedForSearch(query);
	renderApp();
}

export function handleSidebarSearchClear(): void {
	state.searchQuery = "";
	clearArchivedSearchState();
	_revertArchivedIfSearchOpened();
	renderApp();
}

export function renderArchivedSearchControls(): TemplateResult | string {
	const queryActive = !!state.searchQuery.trim();
	if (!state.showArchived || !queryActive) return "";
	const loading = state.archivedSearchGoalsLoading || state.archivedSearchSessionsLoading;
	const hasMore = state.archivedSearchGoalsHasMore || state.archivedSearchSessionsHasMore;
	if (!loading && !hasMore) return "";
	const dividerMy = isDesktop() ? "my-1" : "my-0.5";
	return html`
		<div class="border-t border-border/30 ${dividerMy} mx-2"></div>
		<div class="flex flex-col gap-0.5 px-2">
			${loading ? html`<div class="text-muted-foreground py-1" style="font-size: 0.75em;">Searching archived…</div>` : ""}
			${state.archivedSearchGoalsHasMore ? html`
				<button class="text-primary hover:underline text-left py-1 disabled:opacity-60 disabled:no-underline" ?disabled=${state.archivedSearchGoalsLoading} @click=${() => { fetchArchivedSearchGoalsPaginated(50, state.archivedSearchGoalsCursor ?? undefined); }}>Load more matching archived goals…</button>
			` : ""}
			${state.archivedSearchSessionsHasMore ? html`
				<button class="text-primary hover:underline text-left py-1 disabled:opacity-60 disabled:no-underline" ?disabled=${state.archivedSearchSessionsLoading} @click=${() => { fetchArchivedSearchSessionsPaginated(50, state.archivedSearchSessionsCursor ?? undefined); }}>Load more matching archived sessions…</button>
			` : ""}
		</div>
	`;
}

function _handleFullSearchClick(query: string): void {
	// Navigate to #/search?q=query — uses hash directly since route may not be registered yet
	window.location.hash = query ? `#/search?q=${encodeURIComponent(query)}` : "#/search";
}

/**
 * Filter a list of staff agents by a lowercased search query, matching against
 * `staff.name` OR the underlying live session's `title` / `role`. Shared
 * between desktop (`renderSidebar`) and mobile (`render.ts::renderSidebarShellMobile`).
 */
export function filterStaffByQuery<T extends typeof state.staffList[0]>(staffList: T[], lowerQuery: string): T[] {
	return staffList.filter(s => {
		if (s.name?.toLowerCase().includes(lowerQuery)) return true;
		if (s.currentSessionId) {
			const sess = state.gatewaySessions.find(g => g.id === s.currentSessionId);
			if (sess?.title?.toLowerCase().includes(lowerQuery)) return true;
			if (sess?.role?.toLowerCase().includes(lowerQuery)) return true;
		}
		return false;
	});
}

/**
 * Synthesise a session row for a staff agent.
 *
 * Returns the existing live GatewaySession with title/staffId overrides so
 * `renderSessionRow` picks up active/unread/last-activity treatment for free.
 * Returns `null` if the staff has no current live session, or if the staff's
 * session is owned by a goal (the goal-team list already renders it).
 */
export function synthStaffSessionRow(agent: typeof state.staffList[0]): GatewaySession | null {
	if (!agent.currentSessionId) return null;
	const archived = state.archivedSessions.find(s => s.id === agent.currentSessionId);
	if (archived?.teamGoalId) return null;
	const live = state.gatewaySessions.find(s => s.id === agent.currentSessionId);
	if (!live) return null;
	return { ...live, title: agent.name, staffId: agent.id };
}

function headquartersHiddenWithNoVisibleProjects(): boolean {
	return state.projects.length === 0 && state.showHeadquartersInProjectLists === false;
}

async function showHeadquartersInProjectListsFromSidebar(): Promise<void> {
	state.showHeadquartersInProjectLists = true;
	renderApp();
	try {
		await gatewayFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ showHeadquartersInProjectLists: true }),
		});
		setProjects(await fetchProjects());
		showHeaderToast("Headquarters shown in project lists.");
	} catch {
		state.showHeadquartersInProjectLists = false;
		showHeaderToast("Failed to show Headquarters.");
	} finally {
		renderApp();
	}
}

function renderHiddenHeadquartersSidebarFallback(): TemplateResult | string {
	if (!headquartersHiddenWithNoVisibleProjects()) return "";
	return html`
		<div class="mx-2 my-3 p-3 rounded-md text-center border border-border bg-secondary/20" data-testid="headquarters-hidden-sidebar-fallback">
			<p class="text-foreground font-medium mb-1" style="font-size: 0.9167em;">Headquarters is hidden in the sidebar.</p>
			<p class="text-muted-foreground mb-3" style="font-size: 0.75em;">The built-in server workspace is still available.</p>
			<div class="flex flex-col gap-1.5">
				<button class="px-2 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors" style="font-size: 0.8333em;" ?disabled=${state.creatingSession} @click=${() => createAndConnectSession(undefined, undefined, undefined, undefined, undefined, HEADQUARTERS_PROJECT_ID)}>Quick Session in Headquarters</button>
				<button class="px-2 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors" style="font-size: 0.8333em;" @click=${() => { void showHeadquartersInProjectListsFromSidebar(); }}>Show Headquarters</button>
				<button class="px-2 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors" style="font-size: 0.8333em;" @click=${() => showProjectDialog()}>Add Project</button>
			</div>
		</div>
	`;
}

/** Banner above the project list listing orphaned staff (missing/system projectId). */
function renderOrphanedStaffBanner() {
	const orphans = state.orphanedStaff || [];
	if (orphans.length === 0) return "";
	return html`
		<div class="mx-2 my-2 p-2 rounded-md" style="background: var(--secondary); border: 1px solid var(--border);">
			<div class="flex items-center gap-1.5 mb-1.5 text-foreground/80" style="font-size: 0.8333em;">
				<span class="shrink-0">${icon(Bot, "xs")}</span>
				<span class="font-medium">Orphaned staff (${orphans.length})</span>
			</div>
			<div class="flex flex-col gap-1">
				${orphans.map((agent) => html`
					<div class="flex items-center gap-1 text-muted-foreground" style="font-size: 0.8333em;">
						<span class="flex-1 truncate" title=${agent.description || agent.name}>${agent.name}</span>
						<button class="px-1.5 py-0.5 rounded hover:bg-secondary/80 text-primary" style="font-size: 1em;"
							@click=${(e: Event) => {
								e.stopPropagation();
								const anchor = e.currentTarget as HTMLElement;
								showProjectPickerPopover(anchor, async (projectId: string) => {
									const ok = await reassignStaffProject(agent.id, projectId);
									if (ok) await reloadStaffList();
								});
							}}
							title="Assign to project…"
						>Assign…</button>
					</div>
				`)}
			</div>
		</div>
	`;
}

/** Render a collapsible project section header. */
function renderProjectHeader(project: Project, expanded: boolean) {
	const color = getProjectAccentColor(project);
	const isProvisional = !!project.provisional;
	const isHeadquarters = isHeadquartersProject(project);
	const projectSettingsTarget = isHeadquarters ? "system/general" : `${project.id}/general`;
	const navId = `project:${project.id}`;
	const navActive = getActiveNavId() === navId;
	const reordering = isProjectReordering();
	const reorderActive = _projectReorderState?.activeId === project.id && _projectReorderState.dragging;
	return html`
		<div class="group project-header relative flex items-center gap-1 pr-1 py-0.5 rounded-md ${reordering ? "cursor-default" : "cursor-pointer"} ${reorderActive ? "project-reorder-active" : ""} ${navActive ? "bg-secondary text-foreground sidebar-session-active" : "hover:bg-secondary/30"} transition-colors"
			data-testid="project-header"
			data-project-id=${project.id}
			data-project-reorder-id=${project.id}
			data-project-reordering=${reordering ? "true" : "false"}
			data-project-reorder-active=${reorderActive ? "true" : "false"}
			data-nav-id=${navId}
			data-nav-active=${navActive ? "true" : "false"}
			style="padding-left:var(--sidebar-header-chevron-w);"
			@click=${(e: Event) => {
				if (consumeProjectHeaderReorderClick() || isProjectReordering()) {
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				toggleProjectExpanded(project.id);
				renderApp();
			}}>
			<span class="sidebar-chevron-slot sidebar-chevron-slot--header sidebar-chevron-slot--absolute text-muted-foreground select-none"><span class="sidebar-chevron-glyph">${expanded ? "▾" : "▸"}</span></span>
			<span class="project-reorder-slot">${renderProjectReorderHandle(project)}</span>
			<span class="shrink-0 inline-flex items-center" data-testid=${projectIconTestId(project)} data-project-icon=${projectIconKind(project)} style="color:${color};">${icon(projectIconComponent(project), "xs")}</span>
			<span class="flex-1 min-w-0 truncate text-muted-foreground uppercase tracking-wider font-medium" style="color:${color};font-size: 0.75em;">${project.name}</span>
			${isProvisional ? html`<span class="text-muted-foreground italic shrink-0" style="font-size: 0.75em;">(setting up)</span>` : html`
			<button
				type="button"
				class="rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${isDesktop() ? "opacity-0 group-hover:opacity-100" : ""}"
				style="padding:0;line-height:0;"
				@click=${(e: Event) => { e.stopPropagation(); setHashRoute("settings", projectSettingsTarget); }}
				title=${isHeadquarters ? "Headquarters settings" : "Project settings"}
			>${icon(Settings, "xs")}</button>
			<button
				type="button"
				class="rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors relative shrink-0"
				style="padding:0 2px;line-height:0;"
				@click=${(e: Event) => { e.stopPropagation(); showGoalDialog(undefined, project.id); }}
				title="New goal in ${project.name}"
			>
				<span class="sidebar-compound-icon" data-testid="sidebar-add-goal-icon">
					${icon(GoalIcon, "xs", "sidebar-compound-base")}
					<svg data-testid="sidebar-add-goal-plus" class="sidebar-compound-plus" viewBox="0 0 10 10">
						<path d="M5 1V9M1 5H9" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
					</svg>
				</span>
			</button>
			`}
		</div>
	`;
}

type GoalTreeNode = SidebarTreeNode<GoalContext>;
type SessionTreeNode = SidebarTreeNode<SessionContext>;
type TeamLeadTreeNode = SidebarTreeNode<TeamLeadContext>;
type SessionChildrenTreeNode = SidebarTreeNode<SessionChildrenContext>;

type SearchPrunedNode<T = unknown> = { node: SidebarTreeNode<T>; containsVisibleGoal: boolean; containsRuntimeSearchResult: boolean };

function textMatchesActiveSidebarSearch(...parts: Array<string | undefined>): boolean {
	const q = state.searchQuery.trim().toLowerCase();
	return !!q && parts.some(part => !!part && part.toLowerCase().includes(q));
}

function runtimeNodeMatchesActiveSidebarSearch(node: SidebarTreeNode): boolean {
	if (node.kind === "session") {
		const context = node.context as Partial<SessionContext>;
		return context.matchesSearch === true || textMatchesActiveSidebarSearch(context.session?.title, context.session?.role);
	}
	if (node.kind === "team-lead") {
		const context = node.context as Partial<TeamLeadContext>;
		return textMatchesActiveSidebarSearch(context.session?.title, context.session?.role);
	}
	return false;
}

function pruneRuntimeNodeForSearch(node: SidebarTreeNode, visibleGoalIds: ReadonlySet<string>, keepRuntimeRows: boolean): SearchPrunedNode | null {
	const children: SidebarTreeNode[] = [];
	let containsVisibleGoal = false;
	let containsRuntimeSearchResult = runtimeNodeMatchesActiveSidebarSearch(node);
	for (const child of node.children) {
		const pruned = child.kind === "goal"
			? pruneGoalNodeForSearch(child as GoalTreeNode, visibleGoalIds)
			: pruneRuntimeNodeForSearch(child, visibleGoalIds, keepRuntimeRows);
		if (!pruned) continue;
		children.push(pruned.node);
		containsVisibleGoal ||= pruned.containsVisibleGoal;
		containsRuntimeSearchResult ||= pruned.containsRuntimeSearchResult;
	}
	if (!keepRuntimeRows && !containsVisibleGoal && !containsRuntimeSearchResult) return null;
	return { node: { ...node, children, expanded: containsVisibleGoal || containsRuntimeSearchResult || node.expanded }, containsVisibleGoal, containsRuntimeSearchResult };
}

function pruneGoalNodeForSearch(node: GoalTreeNode, visibleGoalIds: ReadonlySet<string>): SearchPrunedNode<GoalContext> | null {
	const ownMatch = visibleGoalIds.has(node.entityId);
	const children: SidebarTreeNode[] = [];
	let containsVisibleGoal = ownMatch;
	let containsVisibleDescendantGoal = false;
	let containsRuntimeSearchResult = false;
	for (const child of node.children) {
		const pruned = child.kind === "goal"
			? pruneGoalNodeForSearch(child as GoalTreeNode, visibleGoalIds)
			: pruneRuntimeNodeForSearch(child, visibleGoalIds, ownMatch);
		if (!pruned) continue;
		children.push(pruned.node);
		containsVisibleDescendantGoal ||= pruned.containsVisibleGoal;
		containsVisibleGoal ||= pruned.containsVisibleGoal;
		containsRuntimeSearchResult ||= pruned.containsRuntimeSearchResult;
	}
	if (!containsVisibleGoal && !containsRuntimeSearchResult) return null;
	// Search filtering is an ephemeral view: expand retained ancestor goals in the
	// pruned model so matching descendants or matching runtime rows are actually
	// rendered, without writing any persisted expansion preference.
	return { node: { ...node, children, expanded: containsVisibleDescendantGoal || containsRuntimeSearchResult || node.expanded }, containsVisibleGoal, containsRuntimeSearchResult };
}

function filterGoalForestForSearch(nodes: readonly GoalTreeNode[], visibleGoalIds: ReadonlySet<string>): GoalTreeNode[] {
	return nodes
		.map(node => pruneGoalNodeForSearch(node, visibleGoalIds)?.node)
		.filter((node): node is GoalTreeNode => Boolean(node));
}

export function filterSidebarTreeModelGoalsForSearch(model: SidebarTreeModel, visibleGoalIds: ReadonlySet<string>): SidebarTreeModel {
	return {
		...model,
		projects: model.projects.map(projectTree => ({
			...projectTree,
			goalForest: filterGoalForestForSearch(projectTree.goalForest, visibleGoalIds),
			archivedGoalForest: filterGoalForestForSearch(projectTree.archivedGoalForest, visibleGoalIds),
		})),
	};
}

export interface SidebarSearchSessionRetention {
	visibleGoalIds: Set<string>;
	retainedSessionIds: Set<string>;
}

function sessionOwningGoalId(session: GatewaySession): string | undefined {
	return session.goalId || session.teamGoalId || effectiveArchivedTeamGoalId(session);
}

export function collectSidebarSearchSessionRetention(input: {
	visibleGoalIds: Iterable<string>;
	goals: readonly Goal[];
	liveSessions: readonly GatewaySession[];
	archivedSessions: readonly GatewaySession[];
	sessionMatchesQuery: (session: GatewaySession) => boolean;
}): SidebarSearchSessionRetention {
	const visibleGoalIds = new Set(input.visibleGoalIds);
	const retainedSessionIds = new Set<string>();
	const goalsById = new Map(input.goals.map(goal => [goal.id, goal]));
	const sessionsById = new Map<string, GatewaySession>();
	for (const session of [...input.liveSessions, ...input.archivedSessions]) {
		if (!sessionsById.has(session.id)) sessionsById.set(session.id, session);
	}
	const addGoalAndAncestors = (goalId: string | undefined) => {
		let current = goalId;
		const seen = new Set<string>();
		while (current && !seen.has(current)) {
			seen.add(current);
			visibleGoalIds.add(current);
			current = goalsById.get(current)?.parentGoalId;
		}
	};
	const addSessionAndParents = (session: GatewaySession) => {
		let current: GatewaySession | undefined = session;
		const seen = new Set<string>();
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			retainedSessionIds.add(current.id);
			addGoalAndAncestors(sessionOwningGoalId(current));
			const parentId: string | undefined = current.parentSessionId || current.delegateOf;
			current = parentId ? sessionsById.get(parentId) : undefined;
		}
	};
	for (const session of sessionsById.values()) {
		if (isChildSession(session) && input.sessionMatchesQuery(session)) addSessionAndParents(session);
	}
	return { visibleGoalIds, retainedSessionIds };
}

function renderGoalGroupFromTree(node: GoalTreeNode): TemplateResult {
	const goal = node.context.goal as Goal;
	return renderGoalGroup(goal, {
		descendantCount: node.context.descendantCount,
		displayTitleSuffix: node.context.displayTitleSuffix,
		treeNode: node,
	} as any);
}

function nestedGoalChildren(node: GoalTreeNode, archived: boolean): GoalTreeNode[] {
	const keys = archived ? node.context.archivedChildKeys : node.context.activeChildKeys;
	return keys
		.map(key => node.children.find((child): child is GoalTreeNode => child.kind === "goal" && child.key === key))
		.filter((child): child is GoalTreeNode => Boolean(child));
}

/** Render the collapsible per-project Archived subsection (desktop variant). */
function renderProjectArchivedSection(projectTree: SidebarProjectTree) {
	if (!state.showArchived || !projectTree.archivedSectionNode) return "";
	const project = projectTree.project as Project;
	const expanded = projectTree.archivedSectionNode.expanded;
	const archHeaderNavId = `archived-header:${project.id}`;
	const archHeaderActive = getActiveNavId() === archHeaderNavId;
	const archivedGoals = projectTree.archivedGoalForest;
	const archivedSessions = projectTree.archivedSessionNodes;
	if (archivedGoals.length === 0 && archivedSessions.length === 0) return "";
	return html`
		<div class="border-t border-border/30 my-1 mx-2"></div>
		<div class="flex flex-col gap-0.5">
			<button
				data-tree-key=${projectTree.archivedSectionNode.key}
				data-nav-id=${archHeaderNavId}
				data-nav-active=${archHeaderActive ? "true" : "false"}
				class="relative flex items-center gap-1 pr-1 py-0.5 w-full text-left ${archHeaderActive ? "bg-secondary text-foreground sidebar-session-active" : "hover:bg-secondary/30"} rounded-md transition-colors"
				style="padding-left:var(--sidebar-header-chevron-w);"
				@click=${() => { setArchivedSectionExpanded(project.id, !expanded); renderApp(); }}
			>
				<span class="sidebar-chevron-slot sidebar-chevron-slot--header sidebar-chevron-slot--absolute text-muted-foreground select-none opacity-60"><span class="sidebar-chevron-glyph">${expanded ? "▾" : "▸"}</span></span>
				<span class="shrink-0 text-muted-foreground opacity-60">${icon(Archive, "xs")}</span>
				<span class="flex-1 text-muted-foreground uppercase tracking-wider font-medium opacity-60" style="font-size: 0.75em;">Archived</span>
			</button>
			${expanded ? html`
				${archivedGoals.length > 0 ? html`<div class="flex items-center gap-2 my-1 mx-2"><div class="flex-1 border-t border-border/30"></div><span class="text-muted-foreground uppercase tracking-wider opacity-50" style="font-size: 0.75em;">Goals</span><div class="flex-1 border-t border-border/30"></div></div>` : ""}
				${archivedGoals.length > 0 ? html`<div class="flex flex-col gap-0.5" style="${sidebarTreeHalfIndentStyle()}">
					${archivedGoals.map(node => renderNestedNode(project.id, node, "sidebar-archived-row"))}
				</div>` : ""}
				${archivedGoals.length > 0 && archivedSessions.length > 0 ? html`<div class="flex items-center gap-2 my-1 mx-2"><div class="flex-1 border-t border-border/30"></div><span class="text-muted-foreground uppercase tracking-wider opacity-50" style="font-size: 0.75em;">Sessions</span><div class="flex-1 border-t border-border/30"></div></div>` : ""}
				${archivedSessions.length > 0 ? html`<div class="flex flex-col gap-0.5" style="${sidebarTreeBaseIndentStyle()}">
					${archivedSessions.map(node => renderTreeSessionNode(node))}
				</div>` : ""}
			` : ""}
		</div>
	`;
}

/**
 * Per-project key for the "Show N more child goals" expansion state.
 * When the user clicks the truncation row, we bump the depth cap by 5 to
 * surface the next layer of nesting. Persists in module memory for the
 * lifetime of the SPA — losing this on reload is fine, the cap default of
 * 5 is the documented limit anyway.
 */
const _expandedNestedDepthByProject: Map<string, number> = new Map();
const DEFAULT_NESTED_DEPTH_CAP = 5;
const NESTED_DEPTH_INCREMENT = 5;

function _getNestedDepthCap(projectId: string): number {
	return _expandedNestedDepthByProject.get(projectId) ?? DEFAULT_NESTED_DEPTH_CAP;
}

function _expandNestedDepth(projectId: string): void {
	const cur = _getNestedDepthCap(projectId);
	_expandedNestedDepthByProject.set(projectId, cur + NESTED_DEPTH_INCREMENT);
	renderApp();
}

/** Render the "Show N more child goals…" affordance when the depth cap clipped. */
function renderTruncationRow(projectId: string, count: number, depth: number) {
	return html`
		<div
			class="flex items-center gap-1 pr-1 py-0.5 rounded-md cursor-pointer hover:bg-secondary/30 transition-colors text-[10px] text-muted-foreground italic"
			data-testid="sidebar-show-more-children"
			style="${sidebarTreeTruncationIndentStyle(depth)}"
			@click=${(e: Event) => { e.stopPropagation(); _expandNestedDepth(projectId); }}
			title="Reveal deeper nested goals">
			Show ${count} more child goal${count === 1 ? "" : "s"}…
		</div>
	`;
}

/**
 * Recursively render a builder goal node and its nested goal children with
 * per-depth indent. Team/session/spawned-goal children stay owned by
 * renderGoalGroup through the supplied tree node.
 */
function renderNestedNode(
	projectId: string,
	node: GoalTreeNode,
	rowTestId = "sidebar-nested-row",
): TemplateResult | typeof nothing {
	const goal = node.context.goal as Goal;
	const isExpanded = node.expanded;
	const activeChildren = nestedGoalChildren(node, false);
	const archivedChildren = nestedGoalChildren(node, true);
	const needsDivider = activeChildren.length > 0 && archivedChildren.length > 0;
	return html`
		<div data-testid=${rowTestId} data-tree-key=${node.key} data-depth=${node.indentDepth} data-goal-id=${goal.id} style="${sidebarTreeNodeIndentStyle(node)}">
			<div data-testid="sidebar-goal-row">
				${renderGoalGroupFromTree(node)}
			</div>
		</div>
		${isExpanded ? html`
			${activeChildren.map(c => renderNestedNode(projectId, c, rowTestId))}
			${needsDivider ? archivedDivider() : ""}
			${archivedChildren.map(c => renderNestedNode(projectId, c, rowTestId))}
			${node.context.truncatedChildrenCount && node.context.truncatedChildrenCount > 0
				? renderTruncationRow(projectId, node.context.truncatedChildrenCount, node.indentDepth + 1)
				: nothing}
		` : nothing}
	`;
}

/**
 * Build the FULL, pre-search-filter sidebar tree model.
 *
 * Returns the `model` exactly as produced by `buildSidebarTree` — i.e. before
 * `filterSidebarTreeModelGoalsForSearch` prunes non-matching goal nodes while a
 * search query is active. Reveal-on-nav (`sidebar-reveal.ts`) walks this
 * unfiltered model's `flatByKey`/`parentKey` chain so ancestor resolution keeps
 * working even when the sidebar search box is non-empty. `buildDesktopSidebarTree`
 * applies the goal-search filter on top so rendering behaviour is unchanged.
 */
export function buildSidebarTreeModel(sidebarData = getSidebarData()): SidebarTreeModel {
	return buildSidebarTreeModelWithSearch(sidebarData).model;
}

function buildSidebarTreeModelWithSearch(sidebarData = getSidebarData()): { model: SidebarTreeModel; visibleSearchGoalIds: Set<string> | null } {
	const query = state.searchQuery.trim();
	const q = query.toLowerCase();
	const bypassFilters = Boolean(query);
	const staffList = state.staffList || [];
	const filteredStaff = query
		? filterStaffByQuery(staffList.filter(s => s.state !== "retired"), q)
		: staffList.filter(s => s.state !== "retired");
	const liveSessionsNoStaff = state.gatewaySessions.filter(s => !sidebarData.staffSessionIds.has(s.id));
	const goalsForTree: Goal[] = state.goals;
	let sessionsForTree: GatewaySession[] = liveSessionsNoStaff;
	let archivedSessionsForTree: GatewaySession[] = state.archivedSessions;
	let visibleSearchGoalIds: Set<string> | null = null;

	let retainedSearchSessionIds: Set<string> | null = null;
	if (query) {
		const sessionMatchesQuery = (session: GatewaySession) => (session.title?.toLowerCase().includes(q) || session.role?.toLowerCase().includes(q)) ?? false;
		const filteredLiveGoals = sidebarData.liveGoals.filter(goal => {
			const goalMatches = goal.title.toLowerCase().includes(q);
			const goalSessions = liveSessionsNoStaff.filter(s => (s.goalId === goal.id || effectiveArchivedTeamGoalId(s) === goal.id) && !isChildSession(s));
			const hasMatchingSession = goalSessions.some(sessionMatchesQuery);
			return goalMatches || hasMatchingSession;
		});
		const filteredArchivedGoals = filterArchivedGoalsByQuery(sidebarData.archivedGoals, state.gatewaySessions, state.archivedSessions, state.searchQuery);
		const retention = collectSidebarSearchSessionRetention({
			visibleGoalIds: [...filteredLiveGoals, ...filteredArchivedGoals].map(g => g.id),
			goals: goalsForTree,
			liveSessions: liveSessionsNoStaff,
			archivedSessions: state.archivedSessions,
			sessionMatchesQuery,
		});
		visibleSearchGoalIds = retention.visibleGoalIds;
		retainedSearchSessionIds = retention.retainedSessionIds;
		const filteredUngrouped = sidebarData.ungroupedSessions
			.filter(s => passesSidebarFilters(s, s.id === activeSessionId(), true))
			.filter(sessionMatchesQuery);
		const filteredUngroupedIds = new Set(filteredUngrouped.map(s => s.id));
		sessionsForTree = liveSessionsNoStaff.filter(s => {
			if (retainedSearchSessionIds!.has(s.id)) return true;
			if (isChildSession(s)) return false;
			const owningGoalId = s.goalId || effectiveArchivedTeamGoalId(s);
			if (owningGoalId) return visibleSearchGoalIds!.has(owningGoalId);
			return filteredUngroupedIds.has(s.id);
		});
		const filteredStandaloneArchived = filterArchivedSessionsByQuery(state.archivedSessions.filter(isStandaloneArchivedSession), state.searchQuery);
		const filteredStandaloneArchivedIds = new Set(filteredStandaloneArchived.map(s => s.id));
		archivedSessionsForTree = state.archivedSessions.filter(s => {
			if (retainedSearchSessionIds!.has(s.id)) return true;
			if (isChildSession(s)) return false;
			const owningGoalId = s.goalId || s.teamGoalId || effectiveArchivedTeamGoalId(s);
			if (owningGoalId) return visibleSearchGoalIds!.has(owningGoalId);
			if (isStandaloneArchivedSession(s)) return filteredStandaloneArchivedIds.has(s.id);
			return false;
		});
	}

	const projects = projectOrderForRender();
	const model = buildSidebarTree({
		projects,
		goals: goalsForTree,
		sessions: sessionsForTree,
		archivedSessions: archivedSessionsForTree,
		staff: filteredStaff,
		showArchived: state.showArchived,
		projectOrder: projects.map(p => p.id),
		nestedDepthByProject: new Map(projects.map(p => [p.id, _getNestedDepthCap(p.id)])),
		defaultNestedDepth: DEFAULT_NESTED_DEPTH_CAP,
		viewport: state.sidebarCollapsed ? "collapsed" : "desktop",
		layout: loadSidebarTreeLayoutPreference(),
		filters: {
			searchQuery: state.searchQuery,
			activeSessionId: activeSessionId(),
			passesSessionFilters: (session, active, bypass) => retainedSearchSessionIds?.has((session as GatewaySession).id) || passesSidebarFilters(session as GatewaySession, active, bypass),
			bypassBusyReadFilters: bypassFilters,
			includeArchived: state.showArchived,
		},
		expansion: sidebarTreeExpansionInput(),
	});
	return { model, visibleSearchGoalIds };
}

function buildDesktopSidebarTree(sidebarData = getSidebarData()): SidebarTreeModel {
	const { model, visibleSearchGoalIds } = buildSidebarTreeModelWithSearch(sidebarData);
	return visibleSearchGoalIds ? filterSidebarTreeModelGoalsForSearch(model, visibleSearchGoalIds) : model;
}

/** Render goals and sessions for a single project (used in multi-project mode). */
function renderProjectContent(projectTree: SidebarProjectTree) {
	const project = projectTree.project as Project;
	const isProvisional = !!project.provisional;
	const ungroupedExp = projectTree.sessionsSectionNode.expanded;
	const { active: activeNodes, archived: archivedNodes, needsDivider: needsBoundaryDivider } =
		bucketActiveArchived(projectTree.goalForest, n => n.context.archived);
	return html`
		${activeNodes.map((node, i) => html`
			${i > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
			${renderNestedNode(project.id, node)}
		`)}
		${needsBoundaryDivider ? archivedDivider() : ""}
		${archivedNodes.map((node, i) => html`
			${i > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
			${renderNestedNode(project.id, node)}
		`)}
		${projectTree.goalForest.length > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
		<div class="flex flex-col gap-0.5">
			${(() => { const ungNavId = `ungrouped-header:${project.id}`; const ungActive = getActiveNavId() === ungNavId; return html`
			<div class="relative flex items-center gap-1 pr-1 py-0.5 rounded-md cursor-pointer ${ungActive ? "bg-secondary text-foreground sidebar-session-active" : "hover:bg-secondary/30"} transition-colors"
				data-testid="sidebar-sessions-header"
				data-tree-key=${projectTree.sessionsSectionNode.key}
				data-nav-id=${ungNavId}
				data-nav-active=${ungActive ? "true" : "false"}
				style="padding-left:var(--sidebar-header-chevron-w);"
				@click=${() => { setUngroupedExpanded(project.id, !ungroupedExp); renderApp(); }}>
				<span class="sidebar-chevron-slot sidebar-chevron-slot--header sidebar-chevron-slot--absolute text-muted-foreground select-none"><span class="sidebar-chevron-glyph">${ungroupedExp ? "▾" : "▸"}</span></span>
				<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;">${icon(MessagesSquare, "xs")}</span>
				<span class="flex-1 min-w-0 truncate text-muted-foreground uppercase tracking-wider font-medium" style="font-size: 0.75em;">Sessions</span>
				${!isProvisional ? html`
				<div class="flex items-center relative">
					<button
						class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors relative shrink-0 ${state.creatingSession ? "opacity-50 pointer-events-none" : ""}"
						style="line-height:0;"
						@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(undefined, undefined, project.rootPath, undefined, undefined, project.id); }}
						title="New session in ${project.name}"
						?disabled=${state.creatingSession}
					>
						<span class="sidebar-compound-icon" data-testid="sidebar-add-session-icon">
							${icon(MessagesSquare, "xs", "sidebar-compound-base")}
							<svg data-testid="sidebar-add-session-plus" class="sidebar-compound-plus" viewBox="0 0 10 10">
								<path d="M5 1V9M1 5H9" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round"/>
							</svg>
						</span>
					</button>
					<button
						class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
						style="line-height:0;"
						@click=${(e: Event) => { e.stopPropagation(); toggleRolePicker(e, undefined, { projectId: project.id, projectName: project.name, projectCwd: project.rootPath }); }}
						title="New session with role"
					><span class="sidebar-scale-icon">${icon(ChevronDown, "xs")}</span></button>
					${renderRolePickerDropdown()}
				</div>
				` : ""}
			</div>
			${ungroupedExp && projectTree.ungroupedSessionNodes.length > 0 ? html`
				<div class="flex flex-col gap-0.5" style="${sidebarTreeBaseIndentStyle()}">
					${projectTree.ungroupedSessionNodes.map(node => renderTreeSessionNode(node))}
				</div>
			` : ""}
			`; })()}
		</div>
		${!isProvisional ? renderStaffSidebarSection(projectTree.staffRows as typeof state.staffList, project.id, projectTree.staffSectionNode?.key, projectTree.staffSectionNode?.expanded) : ""}
		${!isProvisional ? renderProjectArchivedSection(projectTree) : ""}
	`;
}

export function renderSidebar() {
	const sidebarData = getSidebarData();
	const sidebarTree = buildDesktopSidebarTree(sidebarData);

	if (state.sidebarCollapsed) {
		return renderCollapsedSidebar(sidebarTree);
	}

	const isRolesActive = isRouteActive("roles", "role-edit");
	const isToolsActive = isRouteActive("tools", "tool-edit");
	const isWorkflowsActive = isRouteActive("workflows", "workflow-edit");
	const isSkillsActive = isRouteActive("skills");
	const isMarketActive = isRouteActive("market");

	return html`
		<div class="shrink-0 h-full flex flex-col sidebar-edge sidebar-root relative" data-testid="sidebar-expanded" data-project-reordering=${isProjectReordering() ? "true" : "false"} style="background: var(--sidebar); width: var(--sidebar-w, 240px);">
			${renderProjectReorderLiveRegion()}
			<div class="sidebar-resize-handle" @pointerdown=${onSidebarResizePointerDown} @dblclick=${onSidebarResizeDoubleClick} title="Drag to resize (double-click to reset)"></div>
			<div class="flex flex-col border-b border-border/50 px-0.5 py-1 gap-0.5">
				<div class="sidebar-top-action-row">
					<button
						class="sidebar-top-action-btn flex items-center justify-center px-1 py-1 ${isRolesActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						@click=${() => toggleConfigPage(["roles", "role-edit"], () => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); setHashRoute("roles"); })}
						title="Manage roles"
					>
						<span class="sidebar-scale-icon">${icon(Users, "xs")}</span>
						<span class="sidebar-top-action-label">Roles</span>
					</button>
					<button
						class="sidebar-top-action-btn flex items-center justify-center px-1 py-1 ${isToolsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						@click=${() => toggleConfigPage(["tools", "tool-edit"], () => { import("./tool-manager-page.js").then((m) => m.loadToolPageData()); setHashRoute("tools"); })}
						title="Manage tools"
					>
						<span class="sidebar-scale-icon">${icon(Wrench, "xs")}</span>
						<span class="sidebar-top-action-label">Tools</span>
					</button>
					<button
						class="sidebar-top-action-btn flex items-center justify-center px-1 py-1 ${isSkillsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						@click=${() => toggleConfigPage(["skills"], () => { import("./skills-page.js").then((m) => m.loadSkillsPageData()); setHashRoute("skills"); })}
						title="View skills"
					>
						<span class="sidebar-scale-icon">${icon(Zap, "xs")}</span>
						<span class="sidebar-top-action-label">Skills</span>
					</button>
				</div>
				<div class="sidebar-top-action-row">
					<button
						class="sidebar-top-action-btn flex items-center justify-center px-1 py-1 ${isWorkflowsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						@click=${() => toggleConfigPage(["workflows", "workflow-edit"], () => { import("./workflow-page.js").then((m) => m.loadWorkflowPageData()); setHashRoute("workflows"); })}
						title="Manage workflows"
					>
						<span class="sidebar-scale-icon">${icon(Workflow, "xs")}</span>
						<span class="sidebar-top-action-label">Workflows</span>
					</button>
					<button
						data-testid="market-nav-button"
						class="sidebar-top-action-btn flex items-center justify-center px-1 py-1 ${isMarketActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						@click=${() => toggleConfigPage(["market"], () => { import("./marketplace-page.js").then((m) => m.loadMarketplaceData()); setHashRoute("market"); })}
						title="Marketplace"
					>
						<span class="sidebar-scale-icon">${icon(Store, "xs")}</span>
						<span class="sidebar-top-action-label">Market</span>
					</button>
					<button
						data-new-goal-trigger
						class="sidebar-top-action-btn flex items-center justify-center px-1 py-1 ${state.projects.length === 0 ? 'text-muted-foreground/50 cursor-not-allowed' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						?disabled=${state.projects.length === 0}
						@click=${(e: Event) => {
							if (state.projects.length === 0) { showProjectDialog(); return; }
							startNewGoalFlow(e.currentTarget as HTMLElement);
						}}
						title=${state.projects.length === 0 ? "Add a project first" : `New goal${shortcutHint("new-goal")}`}
					>
						<span class="sidebar-scale-icon" data-testid="sidebar-new-goal-icon">${icon(GoalIcon, "xs")}</span>
						<span class="sidebar-top-action-label">New Goal</span>
					</button>
				</div>
			</div>
			<div class="flex flex-col gap-0">
				<search-box
					.query=${state.searchQuery}
					.showControls=${!!state.searchQuery}
					@search-input=${(e: CustomEvent) => { handleSidebarSearchInput(e.detail.query); }}
					@search-clear=${() => { handleSidebarSearchClear(); }}
					@full-search-click=${(e: CustomEvent) => { _handleFullSearchClick(e.detail.query); }}
				></search-box>
				<search-status-dot></search-status-dot>
			</div>
			<div class="flex-1 overflow-y-auto flex flex-col gap-0.5 pt-0 pb-2 px-0.5" data-project-reorder-list>
				${renderOrphanedStaffBanner()}
				${state.sessionsLoading
					? html`<div class="text-center py-6 text-muted-foreground">Loading…</div>`
					: state.sessionsError
						? html`<div class="text-center py-6">
								<p class="text-red-500 mb-2">${state.sessionsError}</p>
								<button class="text-muted-foreground hover:text-foreground underline" title="Retry loading sessions" @click=${retryLoadSessions}>Retry</button>
							</div>`
						: html`
							${sidebarTree.projects.map((projectTree, i) => {
								const project = projectTree.project as Project;
								const expanded = projectTree.projectNode.expanded;
								const effectiveExpanded = isProjectReordering() ? false : expanded;
								return html`
									${i > 0 ? html`<div class="project-reorder-separator border-t border-border/30 my-1 mx-2"></div>` : ""}
									<div class="project-reorder-section" data-project-id=${project.id} data-tree-key=${projectTree.projectNode.key}>
										${renderProjectHeader(project, effectiveExpanded)}
										${effectiveExpanded ? html`<div class="flex flex-col gap-0.5" style="${sidebarTreeBaseIndentStyle()}">
											${renderProjectContent(projectTree)}
										</div>` : ""}
									</div>
								`;
							})}

							${renderArchivedSearchControls()}
							${state.showArchived && !state.searchQuery && (state.archivedGoalsHasMore || state.archivedSessionsHasMore) ? html`
								<div class="border-t border-border/30 my-1 mx-2"></div>
								<div class="flex flex-col gap-0.5 px-2">
									${state.archivedGoalsHasMore ? html`
										<button class="text-primary hover:underline text-left py-1" @click=${() => { fetchArchivedGoalsPaginated(50, state.archivedGoalsCursor ?? undefined); }}>Load more archived goals…</button>
									` : ""}
									${state.archivedSessionsHasMore ? html`
										<button class="text-primary hover:underline text-left py-1" @click=${() => { fetchArchivedSessionsPaginated(50, state.archivedSessionsCursor ?? undefined); }}>Load more archived sessions…</button>
									` : ""}
								</div>
							` : ""}
						`}
				${state.projects.length === 0 ? html`
					${headquartersHiddenWithNoVisibleProjects() ? renderHiddenHeadquartersSidebarFallback() : html`
						<div style="padding: 1.5rem 1rem; text-align: center;">
							<p class="text-muted-foreground" style="margin: 0 0 0.75rem; font-size: 1.0833em;">No projects available</p>
							<button
								class="flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-primary-foreground bg-primary hover:bg-primary/90 transition-colors mx-auto"
								@click=${() => showProjectDialog()}
							>
								${icon(Plus, "xs")}
								<span>Add Project</span>
							</button>
						</div>
					`}
				` : html`
					<div class="border-t border-border/30 my-1 mx-2"></div>
					<button
						class="flex items-center gap-1 px-1 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors w-full" style="font-size: 0.8333em; padding-left:var(--sidebar-header-chevron-w);"
						@click=${() => showProjectDialog()}
						title="Register another project"
					>
						${icon(Plus, "xs")}
						<span>Add Project</span>
					</button>
				`}
			</div>
			<div class="sidebar-bottom-actions flex items-center border-t border-border/50">
				${(() => { const isSettings = isRouteActive("settings"); return html`<button
					class="flex items-center px-3 py-2 transition-colors ${isSettings ? "text-primary bg-primary/10 font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
					@click=${() => { import("./settings-page.js").then((m) => m.toggleSettings()); }}
					title=${`Settings${shortcutHint("show-settings")}`}
				>
					${icon(Settings, "sm")}
					<span class="sidebar-bottom-action-text">Settings</span>
				</button>`; })()}
				${renderFiltersButton("desktop")}
				<span class="flex-1"></span>
				<button
					class="flex items-center gap-1.5 px-2 py-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
					@click=${toggleSidebar}
					title=${`Collapse sidebar${shortcutHint("toggle-sidebar")}`}
				>
					${icon(PanelLeftClose, "sm")}
				</button>
			</div>
		</div>
	`;
}

// ============================================================================
// COLLAPSED SIDEBAR
// ============================================================================

function renderCollapsedSidebar(sidebarTree: SidebarTreeModel) {
	// Trigger the staff fetch (no-op after first call) so the collapsed STAFF
	// bucket appears even when the user first loads the app with the sidebar
	// already collapsed.
	ensureStaffLoaded();

	const renderCollapsedSession = (s: GatewaySession, treeKey?: string) => {
		const active = activeSessionId() === s.id;
		const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : s.title;
		return html`
			<button
				data-tree-key=${treeKey ?? ""}
				class="flex items-center gap-1 ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${active ? "bg-secondary sidebar-session-active" : "hover:bg-secondary/50"}"
				title=${displayTitle}
				@click=${() => { if (!active) connectToSession(s.id, true); }}
			>
				<span class="shrink-0 inline-flex items-center justify-center ${!active && hasUnseenActivity(s) ? "bobbit-unread-pulse" : ""}">${statusBobbit(s.status, s.isCompacting, s.id, active, s.isAborting, s.role === "team-lead", s.role === "coder", s.accessory, false, !active && hasUnseenActivity(s), true)}</span>
				<span class="font-bold tracking-wide ${active ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.6667em;">${sessionAcronym(displayTitle)}</span>
			</button>
		`;
	};

	const renderCollapsedSessionChildrenGroup = (node: SessionChildrenTreeNode, archived = false): TemplateResult | string => {
		if (node.children.length === 0) return "";
		if (node.context.childClass === "archived-delegate" && !node.expanded) {
			return html`
				<button
					data-tree-key=${node.key}
					class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors sidebar-action-cluster"
					title="Archived delegates"
					@click=${(e: Event) => { e.stopPropagation(); setArchivedParentExpanded(node.context.sessionId, true); renderApp(); }}
				>
					<span class="sidebar-chevron-slot sidebar-chevron-slot--collapsed text-muted-foreground shrink-0 select-none"><span class="sidebar-chevron-glyph">▸</span></span>
					<span class="font-extrabold tracking-wider text-muted-foreground sidebar-collapsed-label" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.75em;">ARC</span>
				</button>
			`;
		}
		return node.expanded ? html`${node.children.map(child => html`<div style="${sidebarTreeCollapsedIndentStyle()}">${renderCollapsedRuntimeNode(child, archived || node.context.childClass === "archived-delegate")}</div>`)}` : "";
	};

	const renderCollapsedSessionNode = (node: SessionTreeNode) => {
		const session = node.context.session as GatewaySession;
		const children = node.children.filter((child): child is SessionChildrenTreeNode => child.kind === "session-children" && child.children.length > 0);
		if (children.length === 0) return renderCollapsedSession(session, node.key);
		const active = activeSessionId() === session.id;
		const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : session.title;
		const expanded = children.some(child => child.expanded);
		return html`
			<button
				data-tree-key=${node.key}
				class="flex items-center sidebar-action-cluster ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${active ? "bg-secondary sidebar-session-active" : "hover:bg-secondary/50"}"
				title=${displayTitle}
				@click=${() => { if (!active) connectToSession(session.id, true); }}
			>
				<span class="sidebar-chevron-slot sidebar-chevron-slot--collapsed text-muted-foreground shrink-0 select-none" style="cursor:pointer;"
					@click=${(e: Event) => {
						e.stopPropagation();
						const next = !expanded;
						if (children.some(child => child.context.childClass === "first-class")) setFirstClassParentExpanded(session.id, next);
						if (children.some(child => child.context.childClass === "delegate" || child.context.childClass === "archived-delegate")) setArchivedParentExpanded(session.id, next);
						renderApp();
					}}
				><span class="sidebar-chevron-glyph">${expanded ? "▾" : "▸"}</span></span>
				<span class="shrink-0 inline-flex items-center justify-center ${!active && hasUnseenActivity(session) ? "bobbit-unread-pulse" : ""}">${statusBobbit(session.status, session.isCompacting, session.id, active, session.isAborting, session.role === "team-lead", session.role === "coder", session.accessory, false, !active && hasUnseenActivity(session), true)}</span>
				<span class="font-bold tracking-wide ${active ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.6667em;">${sessionAcronym(displayTitle)}</span>
			</button>
			${expanded ? children.map(child => html`<div style="${sidebarTreeCollapsedIndentStyle()}">${renderCollapsedSessionChildrenGroup(child)}</div>`) : ""}
		`;
	};

	const renderCollapsedTeamLeadNode = (node: TeamLeadTreeNode) => {
		const teamLead = node.context.session as GatewaySession;
		const children = node.children;
		const tlExpanded = node.expanded;
		const tlActive = activeSessionId() === teamLead.id;
		const tlTitle = tlActive && state.remoteAgent ? state.remoteAgent.title : teamLead.title;
		return html`
			<button
				data-tree-key=${node.key}
				class="flex items-center sidebar-action-cluster ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${tlActive ? "bg-secondary sidebar-session-active" : "hover:bg-secondary/50"}"
				@click=${() => { if (!tlActive) connectToSession(teamLead.id, true); }}
			>
				<span class="sidebar-chevron-slot sidebar-chevron-slot--collapsed text-muted-foreground shrink-0 select-none" style="cursor:pointer;"
					@click=${(e: Event) => { e.stopPropagation(); toggleTeamLeadExpanded(teamLead.id); renderApp(); }}
				><span class="sidebar-chevron-glyph">${children.length > 0 ? (tlExpanded ? "▾" : "▸") : ""}</span></span>
				<span class="shrink-0 inline-flex items-center justify-center ${!tlActive && hasUnseenActivity(teamLead) ? "bobbit-unread-pulse" : ""}">${statusBobbit(teamLead.status, teamLead.isCompacting, teamLead.id, tlActive, teamLead.isAborting, true, false, teamLead.accessory, false, !tlActive && hasUnseenActivity(teamLead), true)}</span>
				<span class="font-bold tracking-wide ${tlActive ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.6667em;">${sessionAcronym(tlTitle)}</span>
			</button>
			${tlExpanded ? children.map(child => html`<div style="${sidebarTreeCollapsedIndentStyle()}">${renderCollapsedRuntimeNode(child)}</div>`) : ""}
		`;
	};

	const renderCollapsedGoalNode = (node: GoalTreeNode, archived = false): TemplateResult => {
		const goal = node.context.goal as Goal;
		const expanded = node.expanded;
		return html`
			<div class=${archived ? "opacity-60" : ""}>
				<button
					data-tree-key=${node.key}
					class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors sidebar-action-cluster"
					title=${goal.title}
					@click=${(e: Event) => { e.stopPropagation(); toggleGoalExpanded(goal.id); renderApp(); }}
				>
					<span class="sidebar-chevron-slot sidebar-chevron-slot--collapsed text-muted-foreground shrink-0 select-none"><span class="sidebar-chevron-glyph">${expanded ? "▾" : "▸"}</span></span>
					<span class="font-extrabold tracking-wider text-muted-foreground sidebar-collapsed-label" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.75em;">${sessionAcronym(goal.title)}</span>
				</button>
				${expanded ? node.children.map(child => html`<div style="${sidebarTreeCollapsedIndentStyle()}">${renderCollapsedRuntimeNode(child, archived)}</div>`) : ""}
			</div>
		`;
	};

	function renderCollapsedRuntimeNode(node: SidebarTreeNode, archived = false): TemplateResult | string {
		if (node.kind === "session") return renderCollapsedSessionNode(node as SessionTreeNode);
		if (node.kind === "team-lead") return renderCollapsedTeamLeadNode(node as TeamLeadTreeNode);
		if (node.kind === "goal") return renderCollapsedGoalNode(node as GoalTreeNode, archived || (node as GoalTreeNode).context.archived);
		if (node.kind === "session-children") return renderCollapsedSessionChildrenGroup(node as SessionChildrenTreeNode, archived);
		return "";
	}

	return html`
		<div class="w-14 shrink-0 h-full flex flex-col items-center sidebar-edge sidebar-root" data-testid="sidebar-collapsed" style="background: var(--sidebar);">
			<div class="flex-1 overflow-y-auto flex flex-col items-center gap-0.5 py-2 px-0.5">
				${sidebarTree.projects.map((projectTree, pi) => {
					const project = projectTree.project as Project;
					const staffRows = projectTree.staffRows
						.map(agent => synthStaffSessionRow(agent as typeof state.staffList[0]))
						.filter((row): row is GatewaySession => Boolean(row))
						.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
					const hasContent = projectTree.goalForest.length > 0 || projectTree.ungroupedSessionNodes.length > 0 || staffRows.length > 0;
					if (!hasContent) return "";
					const _collapsedUngroupedExp = projectTree.sessionsSectionNode.expanded;
					const _collapsedStaffExp = projectTree.staffSectionNode?.expanded ?? isStaffExpanded(project.id);
					return html`
						${pi > 0 ? html`<div class="w-7 border-t border-border/50 my-1.5"></div>` : ""}
						${projectTree.goalForest.map((node, i) => html`
							${i > 0 ? html`<div class="w-7 border-t border-border/50 my-1.5"></div>` : ""}
							${renderCollapsedGoalNode(node)}
						`)}
						${projectTree.goalForest.length > 0 && projectTree.ungroupedSessionNodes.length > 0 ? html`<div class="w-7 border-t border-border/50 my-1.5"></div>` : ""}
						${projectTree.goalForest.length > 0 && projectTree.ungroupedSessionNodes.length > 0 ? html`<button
							data-tree-key=${projectTree.sessionsSectionNode.key}
							class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors sidebar-action-cluster"
							title="Ungrouped sessions in ${project.name}"
							@click=${() => { setUngroupedExpanded(project.id, !_collapsedUngroupedExp); renderApp(); }}
						>
							<span class="sidebar-chevron-slot sidebar-chevron-slot--collapsed text-muted-foreground shrink-0 select-none"><span class="sidebar-chevron-glyph">${_collapsedUngroupedExp ? "▾" : "▸"}</span></span>
							<span class="font-extrabold tracking-wider text-muted-foreground sidebar-collapsed-label" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.75em;">SES</span>
						</button>
						${_collapsedUngroupedExp ? projectTree.ungroupedSessionNodes.map(renderCollapsedSessionNode) : ""}` : projectTree.ungroupedSessionNodes.map(renderCollapsedSessionNode)}
						${staffRows.length > 0 ? html`
							<div class="w-7 border-t border-border/50 my-1.5"></div>
							<button
								data-tree-key=${projectTree.staffSectionNode?.key ?? ""}
								class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors sidebar-action-cluster"
								title="Staff in ${project.name}"
								@click=${() => { setStaffSectionExpanded(project.id, !_collapsedStaffExp); renderApp(); }}
							>
								<span class="sidebar-chevron-slot sidebar-chevron-slot--collapsed text-muted-foreground shrink-0 select-none"><span class="sidebar-chevron-glyph">${_collapsedStaffExp ? "▾" : "▸"}</span></span>
								<span class="font-extrabold tracking-wider text-muted-foreground sidebar-collapsed-label" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.75em;">STAFF</span>
							</button>
							${_collapsedStaffExp ? staffRows.map(s => renderCollapsedSession(s)) : ""}
						` : ""}
					`;
				})}
				${state.showArchived && sidebarTree.projects.some(project => project.archivedGoalForest.length > 0) ? html`
					<div class="w-7 border-t border-border/50 my-1.5"></div>
					${sidebarTree.projects.flatMap(project => project.archivedGoalForest).map(node => renderCollapsedGoalNode(node, true))}
				` : ""}
			</div>
			<button
				class="p-2 mb-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
				@click=${toggleSidebar}
				title=${`Expand sidebar${shortcutHint("toggle-sidebar")}`}
			>
				${icon(PanelLeftOpen, "sm")}
			</button>
		</div>
	`;
}
