import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Bot, ChevronDown, FolderOpen, Goal as GoalIcon, GripVertical, List, MessagesSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, Users, Workflow, Wrench, Zap } from "lucide";
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
	expandedGoals,
	isUngroupedExpanded,
	setUngroupedExpanded,
	isStaffExpanded,
	setStaffSectionExpanded,
	saveExpandedGoals,
	toggleTeamLeadExpanded,
	isTeamLeadExpanded,
	getSidebarData,
	type Goal,
	type Project,
} from "./state.js";
import { createAndConnectSession, connectToSession } from "./session-manager.js";
import { cwdCombobox } from "./cwd-combobox.js";
import { showGoalDialog, showProjectDialog } from "./dialogs-lazy.js";
import { startNewGoalFlow } from "./goal-entry.js";
import { refreshSessions, fetchRoles, fetchStaff, fetchOrphanedStaff, reassignStaffProject, enqueueInboxManual, fetchArchivedSessions, archivedSessionsLoaded, archivedGoalsLoaded, fetchSandboxStatus, fetchArchivedGoalsPaginated, fetchArchivedSessionsPaginated, fetchProjects, saveProjectOrder } from "./api.js";
import { statusBobbit, sessionAcronym } from "./session-colors.js";
import { renderGoalGroup, renderSessionRow, SESSION_ROW_PY, INDENT, CHEVRON_W, HEADER_CHEVRON_W, terseRelativeTime, hasUnseenActivity, formatSessionAge, renderSessionTitle, getProjectAccentColor, filterArchivedGoalsByQuery, filterArchivedSessionsByQuery, renderProjectArchivedSection as renderSharedProjectArchivedSection, passesSidebarFilters, isChildSession } from "./render-helpers.js";
import { renderFiltersButton } from "../ui/components/sidebar-filters.js";
import { shortcutHint } from "./shortcut-registry.js";
import type { GatewaySession } from "./state.js";
import { resetArchivedExpandState } from "./state.js";
import { isRouteActive, setHashRoute, toggleConfigPage } from "./routing.js";
import { getActiveNavId } from "./sidebar-nav.js";

// ============================================================================
// PROJECT EXPANSION STATE
// ============================================================================

const EXPANDED_PROJECTS_KEY = "bobbit-expanded-projects";
const _expandedProjects: Set<string> = new Set(
	JSON.parse(localStorage.getItem(EXPANDED_PROJECTS_KEY) || "[]"),
);

export function isProjectExpanded(projectId: string): boolean {
	// Default to expanded if never toggled
	return !_expandedProjects.has(`collapsed:${projectId}`);
}

export function toggleProjectExpanded(projectId: string): void {
	const key = `collapsed:${projectId}`;
	if (_expandedProjects.has(key)) _expandedProjects.delete(key);
	else _expandedProjects.add(key);
	localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([..._expandedProjects]));
}

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
	return state.projects.map((project) => project.id);
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
	const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
	const droppedInsideList = !!target?.closest("[data-project-reorder-list]");
	void finishProjectReorder(!reorder.dragging || !droppedInsideList);
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
	for (const r of state.roles) items.push({ type: "role", id: r.name });
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
	// Pre-select the "general" role (server default) if it exists
	const generalRole = state.roles.find(r => r.name === "general");
	_pickerRole = generalRole ? "general" : "";
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
		_pickerRole = _pickerRole === roleName ? "" : roleName;
		renderApp();
	};
	const doCreate = () => {
		state.rolePickerOpen = false;
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
			@click=${(e: Event) => e.stopPropagation()}>
			<div class="flex items-center px-3 pt-2 pb-1.5 shrink-0">
				<span class="flex-1 font-semibold text-foreground">Create New Session${_pickerProjectName ? html` <span class="text-muted-foreground font-normal">in ${_pickerProjectName}</span>` : ""}</span>
				<button class="p-0.5 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors" title="Close" @click=${() => { state.rolePickerOpen = false; renderApp(); }}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
				</button>
			</div>
			<div class="overflow-y-auto flex-1" style="min-height: 0;">
			<!-- Roles (2-column grid) -->
			<div>
				<div class="px-3 pt-1 pb-1.5 text-muted-foreground uppercase tracking-wider font-medium" style="font-size: 0.75em;">Role</div>
				${allRoles.length === 0
					? html`<div class="px-3 py-1 text-muted-foreground">No roles defined</div>`
					: html`<div class="px-2 pb-1 grid gap-0.5" style="grid-template-columns: 1fr 1fr;">
						${allRoles.map(role => {
							const focused = isFocused("role", role.name);
							return html`
							<button class="text-left px-2 py-1 rounded hover:bg-secondary/50 active:bg-secondary text-foreground flex items-center gap-1.5 ${_pickerRole === role.name ? "bg-primary/10 ring-1 ring-primary/30" : ""} ${focused ? "ring-2 ring-ring" : ""}"
								@click=${() => selectRole(role.name)}
								title="Select ${role.label} role">
								<span class="shrink-0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
								<span class="flex-1 truncate ${_pickerRole === role.name ? "text-primary font-medium" : ""}">${role.label}</span>
							</button>
						`; })}
					</div>`}
			</div>
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
			<!-- Sandbox checkbox (only when docker sandbox is configured) -->
			${state.sandboxStatus?.configured ? html`
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
			` : ""}
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
			_pickerRole = _pickerRole === focusedItem.id ? "" : focusedItem.id;
			renderApp();
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
			_pickerRole = _pickerRole === focusedItem.id ? "" : focusedItem.id;
			renderApp();
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
			// In the 2-column role grid, ArrowDown skips a row (2 items)
			const item = items[_pickerFocusIndex];
			const step = item?.type === "role" ? 2 : 1;
			_pickerFocusIndex = Math.min(total - 1, _pickerFocusIndex + step);
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
			const item = items[_pickerFocusIndex];
			const step = item?.type === "role" ? 2 : 1;
			_pickerFocusIndex = Math.max(0, _pickerFocusIndex - step);
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
	localStorage.setItem("bobbit-sidebar-collapsed", String(state.sidebarCollapsed));
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
	const staffP = fetchStaff().then((list) => {
		state.staffList = list.map((s) => ({
			id: s.id, name: s.name, description: s.description, state: s.state,
			lastWakeAt: s.lastWakeAt, currentSessionId: s.currentSessionId, triggers: s.triggers,
			projectId: s.projectId,
		}));
	});
	const orphanP = fetchOrphanedStaff().then((list) => {
		state.orphanedStaff = list.map((s) => ({
			id: s.id, name: s.name, description: s.description, state: s.state, projectId: s.projectId,
		}));
	}).catch(() => { /* endpoint may not exist on older server */ });
	return Promise.all([staffP, orphanP]).then(() => { renderApp(); });
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
	const { gatewayFetch } = await import("./api.js");
	try {
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ assistantType: "staff", projectId: opts.projectId, cwd: opts.cwd }),
		});
		if (!res.ok) {
			const { errorFromResponse } = await import("./error-helpers.js");
			throw await errorFromResponse(res, `Session creation failed: ${res.status}`);
		}
		const { id } = await res.json();
		await connectToSession(id, false, { isStaffAssistant: true, assistantType: "staff" });
	} catch (err) {
		const { showConnectionError } = await import("./dialogs.js");
		const { errorDetails } = await import("./error-helpers.js");
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
	const { showProjectPickerPopover } = await import("./goal-entry.js");
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

export function renderStaffSidebarSection(filteredList?: typeof state.staffList, projectId?: string) {
	ensureStaffLoaded();
	const list = filteredList ?? state.staffList.filter((s) => s.state !== "retired");
	const mobile = !isDesktop();
	const staffExpanded = isStaffExpanded(projectId || "");
	const staffProject = projectId ? state.projects.find((p) => p.id === projectId) : undefined;
	const staffAccentColor = staffProject ? getProjectAccentColor(staffProject) : "var(--primary)";
	// Always show the Staff section so users can create their first staff agent

	const staffNavId = `staff-header:${projectId || ""}`;
	const staffNavActive = getActiveNavId() === staffNavId;
	return html`
		<div class="border-t border-border/30 my-1 mx-2"></div>
		<div class="flex flex-col gap-0.5">
			<div class="relative flex items-center ${mobile ? "gap-1.5 pl-0 pr-2 py-1.5" : "gap-1 pr-1 py-0.5"} rounded-md cursor-pointer ${staffNavActive ? "bg-secondary text-foreground sidebar-session-active" : (mobile ? "active:bg-secondary/50" : "hover:bg-secondary/30")} transition-colors"
				data-nav-id=${staffNavId}
				data-nav-active=${staffNavActive ? "true" : "false"}
				style="${mobile ? "" : `padding-left:${HEADER_CHEVRON_W}px;`}"
				@click=${() => { setStaffSectionExpanded(projectId || "", !staffExpanded); renderApp(); }}>
				<span class="${mobile ? "" : "absolute left-0 top-0 bottom-0 flex items-center justify-center"} text-muted-foreground shrink-0 select-none" style="${mobile ? "width:14px;text-align:center;" : `width:${HEADER_CHEVRON_W}px;`}font-size: 1.1667em;">${staffExpanded ? "▾" : "▸"}</span>
				<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;">${icon(Bot, mobile ? "sm" : "xs")}</span>
				<span class="flex-1 text-muted-foreground uppercase tracking-wider font-medium" style="font-size: ${mobile ? "1.1667em" : "0.75em"};">Staff</span>
				<div class="flex items-center" @click=${(e: Event) => e.stopPropagation()}>
					<button
						class="${mobile ? "p-2 rounded" : "p-0.5 rounded-md"} text-muted-foreground active:bg-secondary/50 hover:bg-secondary/50 transition-colors"
						@click=${() => { import("./staff-page.js").then((m) => m.loadStaffPageData()); import("./routing.js").then((m) => m.setHashRoute("staff")); }}
						title="Manage staff agents"
					>${icon(List, mobile ? "sm" : "xs")}</button>
					<button
						class="${mobile ? "p-1.5 rounded active:bg-secondary/50" : "p-0.5 rounded-md hover:bg-secondary"} text-muted-foreground hover:text-foreground transition-colors relative shrink-0"
						style="line-height:0;"
						@click=${(e: Event) => startNewStaffFlow(e, projectId)}
						title="New staff agent"
					>
						<span class="relative inline-flex items-center justify-center" style="width:${mobile ? "16px" : "12px"};height:${mobile ? "16px" : "12px"};">
							${icon(Bot, mobile ? "sm" : "xs")}
							<svg viewBox="0 0 10 10" style="position:absolute;bottom:0px;right:-1px;width:${mobile ? "9px" : "7px"};height:${mobile ? "9px" : "7px"};filter:drop-shadow(0 0 1.5px var(--background));">
								<path d="M5 1V9M1 5H9" stroke="${staffAccentColor}" stroke-width="2.5" stroke-linecap="round"/>
							</svg>
						</span>
					</button>
				</div>
			</div>
			${staffExpanded ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">${list.filter((agent) => {
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
				const rowPy = mobile ? "py-1" : SESSION_ROW_PY;
				const btnPad = mobile ? "p-1.5" : "p-0.5";
				const editBtn = html`<button class="${btnPad} rounded ${mobile ? "text-muted-foreground active:bg-secondary/80" : "hover:bg-secondary/80 text-muted-foreground hover:text-foreground"}"
					@click=${(e: Event) => { e.stopPropagation(); window.location.hash = `#/staff/${agent.id}`; }}
					title="Edit">${icon(Pencil, "xs")}</button>`;
				const staffSessionNavId = agent.currentSessionId ? `session:${agent.currentSessionId}` : "";
				return html`
				<div class="${mobile ? "" : "group relative"} flex items-center gap-1 pr-1 ${rowPy} rounded-md cursor-pointer transition-colors
					${active ? "bg-secondary text-foreground sidebar-session-active" : mobile ? "text-muted-foreground active:bg-secondary/50" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}"
					data-nav-id=${staffSessionNavId}
					data-nav-active=${active ? "true" : "false"}
					style="padding-left:${CHEVRON_W}px;"
					@click=${() => handleStaffClick(agent)}>
					<span class="shrink-0 inline-flex items-center justify-center ${!active && session && hasUnseenActivity(session) ? "bobbit-unread-pulse" : ""}">${statusBobbit(sessionStatus, isCompacting, agent.currentSessionId, active, isAborting, false, false, accessory, false, !active && !!session && hasUnseenActivity(session))}</span>
					<div class="flex-1 min-w-0 ${mobile ? "flex items-center gap-1" : ""} font-normal"><span class="truncate" style="${mobile ? "font-size: 1.3333em;" : ""}">${renderSessionTitle(agent.name, sessionStatus === "streaming" || sessionStatus === "busy" || isCompacting, state.searchQuery)}</span>${mobile && session ? (() => {
							const isActiveSession = sessionStatus === "streaming" || sessionStatus === "busy" || isCompacting;
							if (isActiveSession) { const _d = (agent.id.charCodeAt(0) % 5) * 1.8; return html`<span class="shrink-0 text-muted-foreground/40" style="font-size: 0.9167em;">·</span><span class="sidebar-active-dot" style="--dot-delay:${_d}s"></span>`; }
							const time = terseRelativeTime(session.lastActivity);
							if (!time) return "";
							const unseen = hasUnseenActivity(session);
							return html`<span class="shrink-0 text-muted-foreground/40" style="font-size: 0.9167em;">·</span><span class="shrink-0 inline-flex items-center gap-0.5 tabular-nums ${unseen ? "text-foreground/70 font-medium" : "text-muted-foreground/50"}" style="vertical-align:middle;font-size: 0.9167em;" title="${formatSessionAge(session.lastActivity)}">${time}${unseen ? html`<span class="unseen-dot" aria-label="unread"></span>` : ""}</span>`;
						})() : ""}</div>
					${mobile
						? editBtn
						: html`<div class="absolute right-0 top-0 bottom-0 flex items-center gap-0 pr-1 pl-8 rounded-r-md" style="background:linear-gradient(to right, transparent 0%, var(--sidebar) 50%);">
							<span class="group-hover:hidden flex items-center">${session ? (() => {
								const time = terseRelativeTime(session.lastActivity);
								if (!time) return "";
								const unseen = hasUnseenActivity(session);
								return html`<span class="shrink-0 flex items-center gap-0.5 tabular-nums ${unseen ? "text-foreground/70 font-medium" : "text-muted-foreground/50"}" style="font-size: 0.75em;" title="${formatSessionAge(session.lastActivity)}">${time}${unseen ? html`<span class="unseen-dot" aria-label="unread"></span>` : ""}</span>`;
							})() : ""}</span>
							<div class="sidebar-actions hidden group-hover:flex items-center gap-0">
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

/** Ensure archived data is loaded and the section is visible for search filtering.
 *
 *  Sessions and goals are gated independently: archived sessions can land in
 *  `state.archivedSessions` via `refreshSessions`' `archivedDelegates` field
 *  without the dedicated archived endpoints having been hit. Gating the goals
 *  fetch on `archivedSessions.length === 0` therefore caused a real bug — if
 *  any archived delegate session preceded the search, the goals fetch would be
 *  skipped and search inside an Archived subsection would surface nothing. */
function _ensureArchivedForSearch(): void {
	if (!state.showArchived) {
		state.showArchived = true;
		_archivedBySearch = true;
	}
	if (!archivedSessionsLoaded()) {
		import("./api.js").then(m => m.fetchArchivedSessions());
	}
	if (!archivedGoalsLoaded()) {
		import("./api.js").then(m => m.fetchArchivedGoalsPaginated());
	}
}

/** If archived was auto-opened by search, close it. */
function _revertArchivedIfSearchOpened(): void {
	if (_archivedBySearch) {
		state.showArchived = false;
		_archivedBySearch = false;
		resetArchivedExpandState();
		import("./api.js").then(m => m.clearArchivedSessionsState());
	}
}

function _handleSearchInput(query: string): void {
	state.searchQuery = query;
	if (!query.trim()) {
		_revertArchivedIfSearchOpened();
		renderApp();
		return;
	}
	_ensureArchivedForSearch();
	renderApp();
}

function _handleSearchClear(): void {
	state.searchQuery = "";
	_revertArchivedIfSearchOpened();
	renderApp();
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
								void import("./goal-entry.js").then(({ showProjectPickerPopover }) => {
									showProjectPickerPopover(anchor, async (projectId: string) => {
										const ok = await reassignStaffProject(agent.id, projectId);
										if (ok) await reloadStaffList();
									});
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
	const navId = `project:${project.id}`;
	const navActive = getActiveNavId() === navId;
	const reordering = isProjectReordering();
	const reorderActive = _projectReorderState?.activeId === project.id && _projectReorderState.dragging;
	return html`
		<div class="group project-header flex items-center gap-1 pr-1 py-0.5 pl-0.5 rounded-md ${reordering ? "cursor-default" : "cursor-pointer"} ${reorderActive ? "project-reorder-active" : ""} ${navActive ? "bg-secondary text-foreground sidebar-session-active" : "hover:bg-secondary/30"} transition-colors"
			data-testid="project-header"
			data-project-id=${project.id}
			data-project-reorder-id=${project.id}
			data-project-reordering=${reordering ? "true" : "false"}
			data-project-reorder-active=${reorderActive ? "true" : "false"}
			data-nav-id=${navId}
			data-nav-active=${navActive ? "true" : "false"}
			@click=${(e: Event) => {
				if (consumeProjectHeaderReorderClick() || isProjectReordering()) {
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				toggleProjectExpanded(project.id);
				renderApp();
			}}>
			<span class="text-muted-foreground shrink-0 select-none" style="width:12px;text-align:center;font-size: 1.1667em;">${expanded ? "▾" : "▸"}</span>
			<span class="project-reorder-slot">${renderProjectReorderHandle(project)}</span>
			<span class="shrink-0" style="color:${color};">${icon(FolderOpen, "xs")}</span>
			<span class="flex-1 text-muted-foreground uppercase tracking-wider font-medium" style="color:${color};font-size: 0.75em;">${project.name}</span>
			${isProvisional ? html`<span class="text-muted-foreground italic shrink-0" style="font-size: 0.75em;">(setting up)</span>` : html`
			<button
				type="button"
				class="rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors ${isDesktop() ? "opacity-0 group-hover:opacity-100" : ""}"
				style="padding:0;line-height:0;"
				@click=${(e: Event) => { e.stopPropagation(); setHashRoute("settings", `${project.id}/general`); }}
				title="Project settings"
			>${icon(Settings, "xs")}</button>
			<button
				type="button"
				class="rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors relative shrink-0"
				style="padding:0 2px;line-height:0;"
				@click=${(e: Event) => { e.stopPropagation(); showGoalDialog(undefined, project.id); }}
				title="New goal in ${project.name}"
			>
				<span class="relative inline-flex" style="width:12px;height:12px;">
					${icon(GoalIcon, "xs")}
					<svg viewBox="0 0 10 10" style="position:absolute;bottom:0px;right:-1px;width:7px;height:7px;filter:drop-shadow(0 0 1.5px var(--background));">
						<path d="M5 1V9M1 5H9" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
					</svg>
				</span>
			</button>
			`}
		</div>
	`;
}

/** Render the collapsible per-project Archived subsection (desktop variant). */
function renderProjectArchivedSection(
	project: Project,
	archivedGoals: Goal[],
	standaloneArchivedSessions: GatewaySession[],
) {
	return renderSharedProjectArchivedSection(project, archivedGoals, standaloneArchivedSessions, "desktop");
}

/** Render goals and sessions for a single project (used in multi-project mode). */
function renderProjectContent(
	project: Project,
	goals: Goal[],
	sessions: GatewaySession[],
	staff: typeof state.staffList = [],
	archivedGoals: Goal[] = [],
	standaloneArchivedSessions: GatewaySession[] = [],
) {
	const isProvisional = !!project.provisional;
	const ungroupedExp = isUngroupedExpanded(project.id);
	return html`
		${goals.map((goal, i) => html`
			${i > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
			${renderGoalGroup(goal)}
		`)}
		${goals.length > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
		<div class="flex flex-col gap-0.5">
			${(() => { const ungNavId = `ungrouped-header:${project.id}`; const ungActive = getActiveNavId() === ungNavId; return html`
			<div class="relative flex items-center gap-1 pr-1 py-0.5 rounded-md cursor-pointer ${ungActive ? "bg-secondary text-foreground sidebar-session-active" : "hover:bg-secondary/30"} transition-colors"
				data-nav-id=${ungNavId}
				data-nav-active=${ungActive ? "true" : "false"}
				style="padding-left:${HEADER_CHEVRON_W}px;"
				@click=${() => { setUngroupedExpanded(project.id, !ungroupedExp); renderApp(); }}>
				<span class="absolute left-0 top-0 bottom-0 flex items-center justify-center text-muted-foreground select-none" style="width:${HEADER_CHEVRON_W}px;font-size: 1.1667em;">${ungroupedExp ? "▾" : "▸"}</span>
				<span class="shrink-0 text-muted-foreground" style="margin-left:-3px;">${icon(MessagesSquare, "xs")}</span>
				<span class="flex-1 text-muted-foreground uppercase tracking-wider font-medium" style="font-size: 0.75em;">Sessions</span>
				${!isProvisional ? html`
				<div class="flex items-center relative">
					<button
						class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors relative shrink-0 ${state.creatingSession ? "opacity-50 pointer-events-none" : ""}"
						style="line-height:0;"
						@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(undefined, undefined, project.rootPath, undefined, undefined, project.id); }}
						title="New session in ${project.name}"
						?disabled=${state.creatingSession}
					>
						<span class="relative inline-flex items-center justify-center" style="width:12px;height:12px;">
							${icon(MessagesSquare, "xs")}
							<svg viewBox="0 0 10 10" style="position:absolute;bottom:0px;right:-1px;width:7px;height:7px;filter:drop-shadow(0 0 1.5px var(--background));">
								<path d="M5 1V9M1 5H9" stroke="${getProjectAccentColor(project)}" stroke-width="2.5" stroke-linecap="round"/>
							</svg>
						</span>
					</button>
					<button
						class="p-0.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
						@click=${(e: Event) => { e.stopPropagation(); toggleRolePicker(e, undefined, { projectId: project.id, projectName: project.name, projectCwd: project.rootPath }); }}
						title="New session with role"
					>${icon(ChevronDown, "xs")}</button>
					${renderRolePickerDropdown()}
				</div>
				` : ""}
			</div>
			${ungroupedExp && sessions.length > 0 ? html`
				<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
					${sessions.map(renderSessionRow)}
				</div>
			` : ""}
			`; })()}
		</div>
		${!isProvisional ? renderStaffSidebarSection(staff, project.id) : ""}
		${!isProvisional ? renderProjectArchivedSection(project, archivedGoals, standaloneArchivedSessions) : ""}
	`;
}

export function renderSidebar() {
	const sidebarData = getSidebarData();
	const { liveGoals, archivedGoals } = sidebarData;
	const bypassFilters = !!state.searchQuery.trim();
	// Apply Show Busy / Show Read filters to standalone live sessions.
	const ungroupedSessions = sidebarData.ungroupedSessions.filter(s =>
		passesSidebarFilters(s, s.id === activeSessionId(), bypassFilters));

	if (state.sidebarCollapsed) {
		return renderCollapsedSidebar(liveGoals, ungroupedSessions, archivedGoals);
	}

	const isRolesActive = isRouteActive("roles", "role-edit");
	const isToolsActive = isRouteActive("tools", "tool-edit");
	const isWorkflowsActive = isRouteActive("workflows", "workflow-edit");
	const isSkillsActive = isRouteActive("skills");

	return html`
		<div class="shrink-0 h-full flex flex-col sidebar-edge sidebar-root relative" data-testid="sidebar-expanded" data-project-reordering=${isProjectReordering() ? "true" : "false"} style="background: var(--sidebar); width: var(--sidebar-w, 240px);">
			${renderProjectReorderLiveRegion()}
			<div class="sidebar-resize-handle" @pointerdown=${onSidebarResizePointerDown} @dblclick=${onSidebarResizeDoubleClick} title="Drag to resize (double-click to reset)"></div>
			<div class="flex flex-col border-b border-border/50 px-0.5 py-1 gap-0.5">
				<div class="flex items-center">
					<button
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 ${isRolesActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						@click=${() => toggleConfigPage(["roles", "role-edit"], () => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); import("./routing.js").then((m) => m.setHashRoute("roles")); })}
						title="Manage roles"
					>
						${icon(Users, "xs", "!w-3.5 !h-3.5")}
						<span>Roles</span>
					</button>
					<button
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 ${isToolsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						@click=${() => toggleConfigPage(["tools", "tool-edit"], () => { import("./tool-manager-page.js").then((m) => m.loadToolPageData()); import("./routing.js").then((m) => m.setHashRoute("tools")); })}
						title="Manage tools"
					>
						${icon(Wrench, "xs", "!w-3.5 !h-3.5")}
						<span>Tools</span>
					</button>
					<button
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 whitespace-nowrap ${isSkillsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						@click=${() => toggleConfigPage(["skills"], () => { import("./skills-page.js").then((m) => m.loadSkillsPageData()); import("./routing.js").then((m) => m.setHashRoute("skills")); })}
						title="View skills"
					>
						${icon(Zap, "xs", "!w-3.5 !h-3.5")}
						<span>Skills</span>
					</button>
				</div>
				<div class="flex items-center">
					<button
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 whitespace-nowrap ${isWorkflowsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						@click=${() => toggleConfigPage(["workflows", "workflow-edit"], () => { import("./workflow-page.js").then((m) => m.loadWorkflowPageData()); import("./routing.js").then((m) => m.setHashRoute("workflows")); })}
						title="Manage workflows"
					>
						${icon(Workflow, "xs", "!w-3.5 !h-3.5")}
						<span>Workflows</span>
					</button>
					<button
						data-new-goal-trigger
						class="flex-1 flex items-center justify-center gap-1 px-1 py-1 whitespace-nowrap ${state.projects.length === 0 ? 'text-muted-foreground/50 cursor-not-allowed' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'} rounded-md transition-colors"
						?disabled=${state.projects.length === 0}
						@click=${(e: Event) => {
							if (state.projects.length === 0) { showProjectDialog(); return; }
							startNewGoalFlow(e.currentTarget as HTMLElement);
						}}
						title=${state.projects.length === 0 ? "Add a project first" : `New goal${shortcutHint("new-goal")}`}
					>
						${icon(GoalIcon, "xs", "!w-3.5 !h-3.5")}
						<span>New Goal</span>
					</button>
				</div>
			</div>
			<div class="flex flex-col gap-0">
				<search-box
					.query=${state.searchQuery}
					.showControls=${!!state.searchQuery}
					@search-input=${(e: CustomEvent) => { _handleSearchInput(e.detail.query); }}
					@search-clear=${() => { _handleSearchClear(); }}
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
								<button class="text-muted-foreground hover:text-foreground underline" title="Retry loading sessions" @click=${refreshSessions}>Retry</button>
							</div>`
						: (() => {
							// Apply search filtering. Staff render as rows inside each project's
							// Sessions bucket (see surface-staff-in-sessions design §2) — so we
							// synthesise GatewaySession rows from each project's staff list and
							// merge them in below.
							// Staff render in a dedicated per-project Staff sub-section (see
							// renderStaffSidebarSection / renderProjectContent). We bucket
							// them per project below but do NOT merge synthesised rows into
							// the Sessions list.
							const staffList = state.staffList || [];
							let filteredGoals = liveGoals;
							let filteredUngrouped = ungroupedSessions;
							let filteredStaff = staffList.filter(s => s.state !== "retired");

							if (state.searchQuery) {
								const q = state.searchQuery.toLowerCase();
								// Client-side title filter
								filteredGoals = liveGoals.map(goal => {
									const goalMatches = goal.title.toLowerCase().includes(q);
									const goalSessions = state.gatewaySessions.filter(s => (s.goalId === goal.id || s.teamGoalId === goal.id) && !isChildSession(s));
									const hasMatchingSession = goalSessions.some(s => s.title?.toLowerCase().includes(q) || s.role?.toLowerCase().includes(q));
									if (!goalMatches && !hasMatchingSession) return null as unknown as Goal;
									return goal;
								}).filter(Boolean);
								filteredUngrouped = ungroupedSessions.filter(s => s.title?.toLowerCase().includes(q) || s.role?.toLowerCase().includes(q));
								filteredStaff = filterStaffByQuery(filteredStaff, q);
							}
							// No longer need to filter out pending project sessions — they have real projectIds now

							// Group goals, sessions, staff, and archived items by project
							interface ProjectBucket {
								goals: Goal[];
								sessions: GatewaySession[];
								staff: typeof filteredStaff;
								archivedGoals: Goal[];
								standaloneArchivedSessions: GatewaySession[];
							}
							const projectMap = new Map<string, ProjectBucket>();
							for (const p of state.projects) projectMap.set(p.id, { goals: [], sessions: [], staff: [], archivedGoals: [], standaloneArchivedSessions: [] });
							for (const g of filteredGoals) {
								if (!g.projectId) { console.warn("[sidebar] orphaned goal with no projectId — skipping", g.id); continue; }
								const bucket = projectMap.get(g.projectId);
								if (!bucket) { console.warn("[sidebar] goal has no matching project bucket — skipping", g.id, g.projectId); continue; }
								bucket.goals.push(g);
							}
							for (const s of filteredUngrouped) {
								if (!s.projectId) { console.warn("[sidebar] orphaned session with no projectId — skipping", s.id); continue; }
								const bucket = projectMap.get(s.projectId);
								if (!bucket) { console.warn("[sidebar] session has no matching project bucket — skipping", s.id, s.projectId); continue; }
								bucket.sessions.push(s);
							}
							// Bucket staff per project for the Staff sub-section (no merging
							// into Sessions). Orphans (no projectId / no matching bucket)
							// are surfaced by renderOrphanedStaffBanner above.
							for (const s of filteredStaff) {
								if (!s.projectId) continue;
								const bucket = projectMap.get(s.projectId);
								if (!bucket) continue;
								bucket.staff.push(s);
							}

							// Filter + bucket archived goals / standalone archived sessions by project.
							const allStandaloneArchived = state.archivedSessions.filter(s => !s.teamGoalId && !isChildSession(s));
							const filteredArchivedGoals = filterArchivedGoalsByQuery(archivedGoals, state.gatewaySessions, state.archivedSessions, state.searchQuery);
							const filteredStandaloneArchived = filterArchivedSessionsByQuery(allStandaloneArchived, state.searchQuery);
							for (const g of filteredArchivedGoals) {
								if (!g.projectId) { console.warn("[sidebar] archived goal with no projectId — skipping", g.id); continue; }
								const bucket = projectMap.get(g.projectId);
								if (!bucket) { console.warn("[sidebar] archived goal has no matching project bucket — skipping", g.id, g.projectId); continue; }
								bucket.archivedGoals.push(g);
							}
							for (const s of filteredStandaloneArchived) {
								if (!s.projectId) { console.warn("[sidebar] archived session with no projectId — skipping", s.id); continue; }
								const bucket = projectMap.get(s.projectId);
								if (!bucket) { console.warn("[sidebar] archived session has no matching project bucket — skipping", s.id, s.projectId); continue; }
								bucket.standaloneArchivedSessions.push(s);
							}

							return html`
							${projectOrderForRender().map((project, i) => {
								const data = projectMap.get(project.id) || { goals: [], sessions: [], staff: [], archivedGoals: [], standaloneArchivedSessions: [] };
								const expanded = isProjectExpanded(project.id);
								const effectiveExpanded = isProjectReordering() ? false : expanded;
								return html`
									${i > 0 ? html`<div class="project-reorder-separator border-t border-border/30 my-1 mx-2"></div>` : ""}
									<div class="project-reorder-section" data-project-id=${project.id}>
										${renderProjectHeader(project, effectiveExpanded)}
										${effectiveExpanded ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
											${renderProjectContent(project, data.goals, data.sessions, data.staff, data.archivedGoals, data.standaloneArchivedSessions)}
										</div>` : ""}
									</div>
								`;
							})}

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
						`; })()}
				${state.projects.length === 0 ? html`
					<div style="padding: 1.5rem 1rem; text-align: center;">
						<p class="text-muted-foreground" style="margin: 0 0 0.75rem; font-size: 1.0833em;">No projects configured</p>
						<button
							class="flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-primary-foreground bg-primary hover:bg-primary/90 transition-colors mx-auto"
							@click=${() => showProjectDialog()}
						>
							${icon(Plus, "xs")}
							<span>Add Project</span>
						</button>
					</div>
				` : html`
					<div class="border-t border-border/30 my-1 mx-2"></div>
					<button
						class="flex items-center gap-1 px-1 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors w-full" style="font-size: 0.8333em; padding-left:${HEADER_CHEVRON_W}px;"
						@click=${() => showProjectDialog()}
						title="Register another project"
					>
						${icon(Plus, "xs")}
						<span>Add Project</span>
					</button>
				`}
			</div>
			<div class="flex items-center border-t border-border/50">
				${(() => { const isSettings = isRouteActive("settings"); return html`<button
					class="flex items-center gap-1.5 px-3 py-2 transition-colors ${isSettings ? "text-primary bg-primary/10 font-medium" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"}"
					@click=${() => { import("./settings-page.js").then((m) => m.toggleSettings()); }}
					title=${`Settings${shortcutHint("show-settings")}`}
				>
					${icon(Settings, "sm")}
					<span>Settings</span>
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

function renderCollapsedSidebar(sortedGoals: Goal[], _ungroupedSessions: GatewaySession[], archivedGoals: Goal[] = []) {
	// Trigger the staff fetch (no-op after first call) so the collapsed STAFF
	// bucket appears even when the user first loads the app with the sidebar
	// already collapsed. Without this, only the expanded sidebar (which calls
	// ensureStaffLoaded via renderStaffSidebarSection) would populate the list.
	ensureStaffLoaded();
	const allSessions = state.gatewaySessions;
	const { ungroupedSessions: ungroupedBare } = getSidebarData();
	// Bucket goals + ungrouped sessions + staff by project so the collapsed
	// sidebar mirrors the expanded structure. Staff live in their own bucket
	// (rendered as a separate STAFF tray under SES), NOT merged into sessions.
	interface CollapsedBucket { goals: Goal[]; sessions: GatewaySession[]; staff: GatewaySession[] }
	const byProject = new Map<string, CollapsedBucket>();
	for (const p of state.projects) byProject.set(p.id, { goals: [], sessions: [], staff: [] });
	for (const g of sortedGoals) {
		if (!g.projectId) continue;
		const bucket = byProject.get(g.projectId);
		if (bucket) bucket.goals.push(g);
	}
	for (const s of ungroupedBare) {
		if (!s.projectId) continue;
		const bucket = byProject.get(s.projectId);
		if (bucket) bucket.sessions.push(s);
	}
	// Surface staff as synthesised rows in each project's own staff bucket so
	// users can still reach them while collapsed, without polluting Sessions.
	for (const agent of state.staffList) {
		if (agent.state === "retired") continue;
		if (!agent.projectId) continue;
		const bucket = byProject.get(agent.projectId);
		if (!bucket) continue;
		const row = synthStaffSessionRow(agent);
		if (!row) continue;
		bucket.staff.push(row);
	}
	for (const bucket of byProject.values()) {
		bucket.staff.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
	}

	const renderCollapsedSession = (s: GatewaySession) => {
		const active = activeSessionId() === s.id;
		const displayTitle = active && state.remoteAgent ? state.remoteAgent.title : s.title;
		return html`
			<button
				class="flex items-center gap-1 ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${active ? "bg-secondary sidebar-session-active" : "hover:bg-secondary/50"}"
				title=${displayTitle}
				@click=${() => { if (!active) connectToSession(s.id, true); }}
			>
				<span class="shrink-0 inline-flex items-center justify-center ${!active && hasUnseenActivity(s) ? "bobbit-unread-pulse" : ""}">${statusBobbit(s.status, s.isCompacting, s.id, active, s.isAborting, s.role === "team-lead", s.role === "coder", s.accessory, false, !active && hasUnseenActivity(s))}</span>
				<span class="font-bold tracking-wide ${active ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.6667em;">${sessionAcronym(displayTitle)}</span>
			</button>
		`;
	};

	const renderCollapsedGoalSessions = (goalSessions: GatewaySession[], goal: Goal) => {
		const isTeam = !!(goal as any).team;
		const teamLead = isTeam ? goalSessions.find(s => s.role === "team-lead") : null;
		if (!teamLead) return goalSessions.map(s => renderCollapsedSession(s));

		const children = goalSessions.filter(s => s.id !== teamLead.id);
		const tlExpanded = isTeamLeadExpanded(teamLead.id);
		const tlActive = activeSessionId() === teamLead.id;
		const tlTitle = tlActive && state.remoteAgent ? state.remoteAgent.title : teamLead.title;

		return html`
			<button
				class="flex items-center gap-0.5 ${SESSION_ROW_PY} px-1 rounded-md transition-colors w-full ${tlActive ? "bg-secondary sidebar-session-active" : "hover:bg-secondary/50"}"
				@click=${() => { if (!tlActive) connectToSession(teamLead.id, true); }}
			>
				<span class="text-muted-foreground shrink-0 select-none" style="width:8px;text-align:center;cursor:pointer;font-size: 0.75em;"
					@click=${(e: Event) => { e.stopPropagation(); toggleTeamLeadExpanded(teamLead.id); renderApp(); }}
				>${children.length > 0 ? (tlExpanded ? "▾" : "▸") : ""}</span>
				<span class="shrink-0 inline-flex items-center justify-center ${!tlActive && hasUnseenActivity(teamLead) ? "bobbit-unread-pulse" : ""}">${statusBobbit(teamLead.status, teamLead.isCompacting, teamLead.id, tlActive, teamLead.isAborting, true, false, teamLead.accessory, false, !tlActive && hasUnseenActivity(teamLead))}</span>
				<span class="font-bold tracking-wide ${tlActive ? "text-foreground" : "text-muted-foreground"}" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.6667em;">${sessionAcronym(tlTitle)}</span>
			</button>
			${tlExpanded ? children.map(s => html`<div style="padding-left:6px;">${renderCollapsedSession(s)}</div>`) : ""}
		`;
	};

	return html`
		<div class="w-14 shrink-0 h-full flex flex-col items-center sidebar-edge sidebar-root" data-testid="sidebar-collapsed" style="background: var(--sidebar);">
			<div class="flex-1 overflow-y-auto flex flex-col items-center gap-0.5 py-2 px-0.5">
				${state.projects.map((project, pi) => {
					const bucket = byProject.get(project.id) || { goals: [], sessions: [], staff: [] };
					if (bucket.goals.length === 0 && bucket.sessions.length === 0 && bucket.staff.length === 0) return "";
					const _collapsedUngroupedExp = isUngroupedExpanded(project.id);
					const _collapsedStaffExp = isStaffExpanded(project.id);
					return html`
						${pi > 0 ? html`<div class="w-7 border-t border-border/50 my-1.5"></div>` : ""}
						${bucket.goals.map((goal, i) => {
							const goalSessions = allSessions.filter((s) => (s.goalId === goal.id || s.teamGoalId === goal.id) && !isChildSession(s)).sort((a, b) => a.createdAt - b.createdAt);
							const expanded = expandedGoals.has(goal.id);
							return html`
								${i > 0 ? html`<div class="w-7 border-t border-border/50 my-1.5"></div>` : ""}
								<button
									class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors" style="gap:0.225rem;"
									title=${goal.title}
									@click=${(e: Event) => { e.stopPropagation(); if (expandedGoals.has(goal.id)) expandedGoals.delete(goal.id); else expandedGoals.add(goal.id); saveExpandedGoals(); renderApp(); }}
								>
									<span class="text-muted-foreground shrink-0 select-none" style="width:${CHEVRON_W}px;text-align:center;font-size: 0.9167em;">${expanded ? "▾" : "▸"}</span>
									<span class="font-extrabold tracking-wider text-muted-foreground" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.75em;">${sessionAcronym(goal.title)}</span>
								</button>
								${expanded ? renderCollapsedGoalSessions(goalSessions, goal) : ""}
							`;
						})}
						${bucket.goals.length > 0 && bucket.sessions.length > 0 ? html`<div class="w-7 border-t border-border/50 my-1.5"></div>` : ""}
						${bucket.goals.length > 0 && bucket.sessions.length > 0 ? html`<button
							class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors" style="gap:0.225rem;"
							title="Ungrouped sessions in ${project.name}"
							@click=${() => { setUngroupedExpanded(project.id, !_collapsedUngroupedExp); renderApp(); }}
						>
							<span class="text-muted-foreground shrink-0 select-none" style="width:${CHEVRON_W}px;text-align:center;font-size: 0.9167em;">${_collapsedUngroupedExp ? "▾" : "▸"}</span>
							<span class="font-extrabold tracking-wider text-muted-foreground" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.75em;">SES</span>
						</button>
						${_collapsedUngroupedExp ? bucket.sessions.map(renderCollapsedSession) : ""}` : bucket.sessions.map(renderCollapsedSession)}
						${bucket.staff.length > 0 ? html`
							<div class="w-7 border-t border-border/50 my-1.5"></div>
							<button
								class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors" style="gap:0.225rem;"
								title="Staff in ${project.name}"
								@click=${() => { setStaffSectionExpanded(project.id, !_collapsedStaffExp); renderApp(); }}
							>
								<span class="text-muted-foreground shrink-0 select-none" style="width:${CHEVRON_W}px;text-align:center;font-size: 0.9167em;">${_collapsedStaffExp ? "▾" : "▸"}</span>
								<span class="font-extrabold tracking-wider text-muted-foreground" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.75em;">STAFF</span>
							</button>
							${_collapsedStaffExp ? bucket.staff.map(renderCollapsedSession) : ""}
						` : ""}
					`;
				})}
				${state.showArchived && archivedGoals.length > 0 ? html`
					<div class="w-7 border-t border-border/50 my-1.5"></div>
					${archivedGoals.map((goal) => {
						const goalSessions = allSessions.filter((s) => (s.goalId === goal.id || s.teamGoalId === goal.id) && !isChildSession(s)).sort((a, b) => a.createdAt - b.createdAt);
						const expanded = expandedGoals.has(goal.id);
						return html`
							<div class="opacity-60">
								<button
									class="flex items-center py-0.5 w-full rounded-md hover:bg-secondary/50 transition-colors" style="gap:0.225rem;"
									title=${goal.title}
									@click=${(e: Event) => { e.stopPropagation(); if (expandedGoals.has(goal.id)) expandedGoals.delete(goal.id); else expandedGoals.add(goal.id); saveExpandedGoals(); renderApp(); }}
								>
									<span class="text-muted-foreground shrink-0 select-none" style="width:${CHEVRON_W}px;text-align:center;font-size: 0.9167em;">${expanded ? "▾" : "▸"}</span>
									<span class="font-extrabold tracking-wider text-muted-foreground" style="font-family: ui-monospace, monospace; line-height: 1; font-size: 0.75em;">${sessionAcronym(goal.title)}</span>
								</button>
								${expanded ? renderCollapsedGoalSessions(goalSessions, goal) : ""}
							</div>
						`;
					})}
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
