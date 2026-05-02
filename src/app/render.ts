import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { ref, createRef } from "lit/directives/ref.js";
import { reconcileFollowTail } from "./follow-tail.js";
import { Archive, ArrowLeft, FileText, FolderOpen, FolderPlus, Maximize2, MessagesSquare, Minimize2, ChevronDown, Goal as GoalIcon, PanelRightClose, PanelRightOpen, Pencil, Plus, QrCode, Server, Settings, Trash2, Unplug, UserCheck, Users, Workflow as WorkflowIcon, Wrench, Zap } from "lucide";
import {
	state,
	renderApp,
	isDesktop,
	hasActiveSession,
	activeSessionId,
	isUngroupedExpanded,
	setUngroupedExpanded,

	resetArchivedExpandState,
	getSidebarData,
	isProposalStreaming,
} from "./state.js";
import { createGoal, createRole, gatewayFetch, refreshSessions, fetchSandboxStatus } from "./api.js";
import { clearSessionModel } from "./routing.js";
import { clearAllAnnotations, clearAnnotations, markReviewSubmitted, flushPendingWrites } from "../ui/components/review/AnnotationStore.js";
import { backToSessions, createAndConnectSession, terminateSession, saveGoalDraft, deleteGoalDraft, saveRoleDraft, deleteRoleDraft, saveProjectDraft, deleteProjectDraft, markProposalDismissed } from "./session-manager.js";
import { deleteProposalFile } from "./proposal-helpers.js";
import { openGatewayDialog, showQrCodeDialog, showRenameDialog, showGoalDialog, showProjectDialog, showConnectionError } from "./dialogs.js";
import { coerceWorkflowId } from "./dialog-helpers.js";
import { startNewGoalFlow } from "./goal-entry.js";
import { renderSidebar, toggleRolePicker, renderRolePickerDropdown, renderStaffSidebarSection, isProjectExpanded, toggleProjectExpanded } from "./sidebar.js";
import { fetchArchivedGoalsPaginated, fetchArchivedSessionsPaginated } from "./api.js";
// Register search web components
import "../ui/components/SearchBox.js";
import "../ui/components/SearchResults.js";
// Register review pane web components
import "../ui/components/review/ReviewPane.js";
import "../ui/components/review/ReviewDocument.js";
import "../ui/components/review/AnnotationPopover.js";

import { renderGoalGroup, renderSessionRow, renderSandboxIndicator, INDENT, getProjectAccentColor, filterArchivedGoalsByQuery, filterArchivedSessionsByQuery, bucketArchivedByProject, renderProjectArchivedSection } from "./render-helpers.js";
import { viewTabs as projectViewTabs, componentsView as projectComponentsView, workflowsView as projectWorkflowsView, type ViewMode as ProjectViewMode, type ProposalComponent, type ProposalWorkflow } from "./project-proposal-views.js";

const bobbitIcon = html`<img src="/favicon.svg" alt="" style="width:20px;height:18px;image-rendering:pixelated;" />`;

/** Preview the worktree path that goal-manager will create. */
function worktreePreviewPath(cwd: string, title: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const lastSlash = normalized.lastIndexOf("/");
	const parent = lastSlash > 0 ? normalized.slice(0, lastSlash) : normalized;
	const base = lastSlash > 0 ? normalized.slice(lastSlash + 1) : normalized;
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 10) || "untitled";
	return `${parent}/${base}-wt/goal-${slug}-xxxxxxxx/`;
}

import { cwdCombobox } from "./cwd-combobox.js";

import { teardownMobileScrollTracking, ensureMobileScrollTracking } from "./mobile-header.js";
import { getRouteFromHash, setHashRoute, isRouteActive, toggleConfigPage } from "./routing.js";
import { renderGoalDashboard } from "./goal-dashboard.js";
import "./goal-dashboard.css";
import "../ui/styles/plan-tab.css";
import { bobbitLoadingAnimation } from "../ui/components/BobbitLoadingAnimation.js";
import { renderRoleManagerPage } from "./role-manager-page.js";
import "./role-manager.css";
import { renderToolManagerPage } from "./tool-manager-page.js";
import "./tool-manager.css";
import { renderWorkflowPage } from "./workflow-page.js";
import "./workflow-page.css";
import "./config-scope.css";
import { renderStaffPage } from "./staff-page.js";
import { renderSkillsPage } from "./skills-page.js";
import { renderSettingsPage } from "./settings-page.js";
import { renderSearchPage, initSearchPage, resetSearchPage } from "./search-page.js";

// ============================================================================
// MOBILE LANDING PAGE
// ============================================================================

/** Compact session row for mobile — mirrors sidebar row with always-visible buttons */

// Mobile search handlers (shared logic with sidebar but separate scope)
function _handleMobileSearchInput(query: string): void {
	state.searchQuery = query;
	renderApp();
}

function _handleMobileSearchClear(): void {
	state.searchQuery = "";
	renderApp();
}

function renderMobileLanding() {
	const sidebarData = getSidebarData();
	let { ungroupedSessions, liveGoals } = sidebarData;
	let { archivedGoals } = sidebarData;

	// Client-side title filtering for mobile
	if (state.searchQuery) {
		const q = state.searchQuery.toLowerCase();
		liveGoals = liveGoals.filter(goal => {
			const goalMatches = goal.title.toLowerCase().includes(q);
			const goalSessions = state.gatewaySessions.filter(s => (s.goalId === goal.id || s.teamGoalId === goal.id) && !s.delegateOf);
			const hasMatchingSession = goalSessions.some(s => s.title?.toLowerCase().includes(q) || s.role?.toLowerCase().includes(q));
			return goalMatches || hasMatchingSession;
		});
		ungroupedSessions = ungroupedSessions.filter(s => s.title?.toLowerCase().includes(q) || s.role?.toLowerCase().includes(q));
		archivedGoals = filterArchivedGoalsByQuery(archivedGoals, state.gatewaySessions, state.archivedSessions, state.searchQuery);
	}

	return html`
		<div class="flex-1 flex flex-col overflow-y-auto">
			<div class="w-full max-w-xl mx-auto px-2 py-4 pb-16 flex flex-col gap-1">
				<div class="flex flex-col gap-1 px-1 pb-2 mb-1 border-b border-border/30">
					${(() => {
						const isRolesActive = isRouteActive("roles", "role-edit");
						const isToolsActive = isRouteActive("tools", "tool-edit");
						const route = getRouteFromHash();
						const isWorkflowsActive = isRouteActive("workflows", "workflow-edit")
							|| (route.view === "settings" && (route as any).settingsTab === "workflows");
						const isSkillsActive = isRouteActive("skills");
						return html`
					<div class="flex items-center gap-1">
						<button class="flex-1 text-sm px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isRolesActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}"
							title="Manage roles"
							@click=${() => toggleConfigPage(["roles", "role-edit"], () => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); setHashRoute("roles"); })}>
							${icon(Users, "xs")} Roles
						</button>
						<button class="flex-1 text-sm px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isToolsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}"
							title="Manage tools"
							@click=${() => toggleConfigPage(["tools", "tool-edit"], () => { import("./tool-manager-page.js").then((m) => m.loadToolPageData()); setHashRoute("tools"); })}>
							${icon(Wrench, "xs")} Tools
						</button>
					</div>
					<div class="flex items-center gap-1">
						<button class="flex-1 text-sm px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isWorkflowsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}"
							title="Manage workflows"
							@click=${() => {
								const projectId = state.activeProjectId || (state.projects[0]?.id ?? null);
								if (!projectId) { showProjectDialog(); return; }
								import("./workflow-page.js").then((m) => m.loadWorkflowPageData());
								setHashRoute("settings", `${projectId}/workflows`, true);
							}}>
							${icon(WorkflowIcon, "xs")} Workflows
						</button>
						<button class="flex-1 text-sm px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isSkillsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}"
							title="View skills"
							@click=${() => toggleConfigPage(["skills"], () => { import("./skills-page.js").then((m) => m.loadSkillsPageData()); setHashRoute("skills"); })}>
							${icon(Zap, "xs")} Skills
						</button>
						<button
							data-new-goal-trigger
							class="flex-1 text-sm px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${state.projects.length === 0 ? 'text-muted-foreground/50 cursor-not-allowed' : 'text-muted-foreground active:bg-secondary/50'}"
							?disabled=${state.projects.length === 0}
							@click=${(e: Event) => {
								if (state.projects.length === 0) { showProjectDialog(); return; }
								startNewGoalFlow(e.currentTarget as HTMLElement);
							}}
							title=${state.projects.length === 0 ? "Add a project first" : "New goal (Alt+G)"}>
							${icon(GoalIcon, "xs")} New Goal
						</button>
					</div>
					`;
					})()}
				</div>
				<search-box
					.query=${state.searchQuery}
					.showControls=${!!state.searchQuery}
					@search-input=${(e: CustomEvent) => { _handleMobileSearchInput(e.detail.query); }}
					@search-clear=${() => { _handleMobileSearchClear(); }}
					@full-search-click=${(e: CustomEvent) => { setHashRoute("search", e.detail.query); }}
				></search-box>
				${state.sessionsLoading
					? html`<div class="text-center py-12 text-muted-foreground text-xs">Loading…</div>`
					: state.sessionsError
						? html`<div class="text-center py-12">
								<p class="text-xs text-red-500 mb-3">${state.sessionsError}</p>
								<button class="text-xs text-muted-foreground underline" title="Retry" @click=${refreshSessions}>Retry</button>
							</div>`
						: state.goals.length === 0 && state.gatewaySessions.length === 0
							? html`<div class="text-center py-12">
									<div class="text-muted-foreground mb-3 empty-state-icon">${icon(Server, "lg")}</div>
									<p class="text-base text-muted-foreground mb-4">No goals or sessions yet</p>
									<div class="flex items-center justify-center gap-2">
										${Button({
											variant: "default",
											onClick: (e?: Event) => startNewGoalFlow((e?.currentTarget as HTMLElement | null) ?? null),
											children: html`<span class="inline-flex items-center gap-1.5">${icon(GoalIcon, "sm")} Create a Goal</span>`,
										})}
										${Button({
											variant: "ghost",
											disabled: state.creatingSession,
											onClick: () => createAndConnectSession(),
											children: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} Quick Session</span>`,
										})}
									</div>
								</div>`
							: html`
								${(() => {
									// Group goals, sessions, and staff by project
									let staffList = (state.staffList || []).filter(s => s.state !== "retired");
									if (state.searchQuery) {
										const q = state.searchQuery.toLowerCase();
										staffList = staffList.filter(s => s.name?.toLowerCase().includes(q));
									}
									const projectMap = new Map<string, { goals: typeof liveGoals; sessions: typeof ungroupedSessions; staff: typeof staffList }>();
										for (const p of state.projects) projectMap.set(p.id, { goals: [], sessions: [], staff: [] });
										for (const g of liveGoals) {
											if (!g.projectId) { console.warn("[mobile] orphaned goal with no projectId — skipping", g.id); continue; }
											// Only top-level goals at the project root — child goals
											// nest under their parent via `renderGoalGroup` recursion.
											// See sidebar.ts for the desktop equivalent.
											if (g.parentGoalId) continue;
											const bucket = projectMap.get(g.projectId);
											if (!bucket) { console.warn("[mobile] goal has no matching project bucket — skipping", g.id, g.projectId); continue; }
											bucket.goals.push(g);
										}
										for (const s of ungroupedSessions) {
											if (!s.projectId) { console.warn("[mobile] orphaned session with no projectId — skipping", s.id); continue; }
											const bucket = projectMap.get(s.projectId);
											if (!bucket) { console.warn("[mobile] session has no matching project bucket — skipping", s.id, s.projectId); continue; }
											bucket.sessions.push(s);
										}
										for (const s of staffList) {
											if (!s.projectId) { console.warn("[mobile] orphaned staff with no projectId — skipping", s.id); continue; }
											const bucket = projectMap.get(s.projectId);
											if (!bucket) { console.warn("[mobile] staff has no matching project bucket — skipping", s.id, s.projectId); continue; }
											bucket.staff.push(s);
										}
										// Bucket archived goals + standalone archived sessions per project.
										const allStandaloneArchivedAll = state.showArchived ? state.archivedSessions.filter(s => !s.teamGoalId && !s.delegateOf) : [];
										const filteredStandaloneArchivedAll = filterArchivedSessionsByQuery(allStandaloneArchivedAll, state.searchQuery);
										const archivedByProject = bucketArchivedByProject(archivedGoals, filteredStandaloneArchivedAll, state.projects);
										return html`${state.projects.map((project, i) => {
											const data = projectMap.get(project.id) || { goals: [], sessions: [], staff: [] };
											const expanded = isProjectExpanded(project.id);
											const color = getProjectAccentColor(project);
											return html`
												${i > 0 ? html`<div class="border-t border-border/30 my-1 mx-2"></div>` : ""}
												<div class="flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
													@click=${() => { toggleProjectExpanded(project.id); renderApp(); }}>
													<span class="text-sm text-muted-foreground shrink-0 select-none" style="width:14px;text-align:center;">${expanded ? "▾" : "▸"}</span>
													<span class="shrink-0" style="color:${color};">${icon(FolderOpen, "sm")}</span>
													<span class="flex-1 text-sm text-muted-foreground uppercase tracking-wider font-medium" style="color:${color};">${project.name}</span>
													<div class="flex items-center gap-2 shrink-0">
														<button
															class="p-0.5 rounded-md active:bg-secondary/50 text-muted-foreground transition-colors flex items-center justify-center"
															@click=${(e: Event) => { e.stopPropagation(); setHashRoute("settings", `${project.id}/general`); }}
															title="Project settings"
														>${icon(Settings, "sm")}</button>
														<button
															class="p-0.5 rounded-md active:bg-secondary/50 text-muted-foreground transition-colors relative flex items-center justify-center"
															@click=${(e: Event) => { e.stopPropagation(); showGoalDialog(undefined, project.id); }}
															title="New goal in ${project.name}"
														>
															<span class="relative inline-flex items-center justify-center" style="width:16px;height:16px;">
																${icon(GoalIcon, "sm")}
																<svg viewBox="0 0 10 10" style="position:absolute;bottom:0px;right:-1px;width:9px;height:9px;filter:drop-shadow(0 0 1.5px var(--background));">
																	<path d="M5 1V9M1 5H9" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
																</svg>
															</span>
														</button>
													</div>
												</div>
												${expanded ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
													${data.goals.map((goal, gi) => html`
														${gi > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
														${renderGoalGroup(goal)}
													`)}
													${data.goals.length > 0 ? html`<div class="border-t border-border/30 mx-2"></div>` : ""}
													<div class="flex flex-col gap-0.5">
														${(() => { const _mobileUngroupedExp = isUngroupedExpanded(project.id); return html`<div class="flex items-center gap-1.5 pl-0 pr-2 py-1.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
															@click=${() => { setUngroupedExpanded(project.id, !_mobileUngroupedExp); renderApp(); }}>
															<span class="text-sm text-muted-foreground shrink-0 select-none" style="width:14px;text-align:center;">${_mobileUngroupedExp ? "▾" : "▸"}</span>
															<span class="shrink-0 text-muted-foreground">${icon(MessagesSquare, "sm")}</span>
															<span class="flex-1 text-sm text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
															<div class="flex items-center relative">
																<button
																	class="p-2 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
																	@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(undefined, undefined, project.rootPath, undefined, undefined, project.id); }}
																	title="New session in ${project.name}"
																>${icon(Plus, "sm")}</button>
																<button
																	class="p-1.5 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
																	@click=${(e: Event) => { e.stopPropagation(); toggleRolePicker(e, undefined, { projectId: project.id, projectName: project.name, projectCwd: project.rootPath }); }}
																	title="New session with role"
																>${icon(ChevronDown, "sm")}</button>
																${renderRolePickerDropdown()}
															</div>
														</div>
														${_mobileUngroupedExp && data.sessions.length > 0 ? html`
															<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
																${data.sessions.map(renderSessionRow)}
															</div>
														` : ""}
													</div>`; })()}
													${renderStaffSidebarSection(data.staff, project.id)}
													${(() => {
														const ab = archivedByProject.get(project.id);
														if (!ab) return "";
														return renderProjectArchivedSection(project, ab.archivedGoals, ab.standaloneArchivedSessions, "mobile");
													})()}
												</div>` : ""}
											`;
										})}
										${state.showArchived && !state.searchQuery && (state.archivedGoalsHasMore || state.archivedSessionsHasMore) ? html`
											<div class="border-t border-border/30 my-1 mx-2"></div>
											<div class="flex flex-col gap-0.5 px-2">
												${state.archivedGoalsHasMore ? html`<button class="text-xs text-primary hover:underline text-left py-1" @click=${() => { fetchArchivedGoalsPaginated(50, state.archivedGoalsCursor ?? undefined); }}>Load more archived goals…</button>` : ""}
												${state.archivedSessionsHasMore ? html`<button class="text-xs text-primary hover:underline text-left py-1" @click=${() => { fetchArchivedSessionsPaginated(50, state.archivedSessionsCursor ?? undefined); }}>Load more archived sessions…</button>` : ""}
											</div>
										` : ""}`;
								})()}
							`}
			</div>
		</div>
		<div class="fixed bottom-0 left-0 right-0 flex items-center justify-between px-4 py-2 border-t border-border bg-background z-10">
			${(() => { const isSettings = isRouteActive("settings"); return html`<button class="flex items-center gap-1.5 px-2 py-2.5 text-xs rounded transition-colors ${isSettings ? "text-primary bg-primary/10 font-medium" : "text-muted-foreground active:bg-secondary/50"}"
				@click=${() => { import("./settings-page.js").then((m) => m.toggleSettings()); }}
				title="Settings">
				${icon(Settings, "sm")}
				<span>Settings</span>
			</button>`; })()}
			${state.projects.length >= 1 ? html`<button class="flex items-center gap-1.5 px-2 py-2.5 text-xs text-muted-foreground active:bg-secondary/50 rounded transition-colors"
				@click=${() => showProjectDialog()}
				title="Add project">
				${icon(FolderPlus, "sm")}
				<span>Add Project</span>
			</button>` : ""}
			<button class="flex items-center gap-1.5 px-2 py-2.5 text-xs ${state.showArchived ? "text-primary bg-primary/10 font-medium" : "text-muted-foreground"} active:bg-secondary/50 rounded transition-colors"
				@click=${() => {
					state.showArchived = !state.showArchived;
					localStorage.setItem("bobbit-show-archived", String(state.showArchived));
					if (state.showArchived) {
						import("./api.js").then(m => { m.fetchArchivedSessions(); m.fetchArchivedGoalsPaginated(); });
					} else {
						resetArchivedExpandState();
						import("./api.js").then(m => m.clearArchivedSessionsState());
					}
					renderApp();
				}}
				title="${state.showArchived ? "Hide archived sessions" : "Show archived sessions"}">
				${icon(Archive, "sm")}
				<span>See Archived</span>
			</button>
		</div>
	`;
}

// ============================================================================
// GOAL PREVIEW PANEL (goal assistant split-screen)
// ============================================================================

/** Cached workflows for goal creation dropdown — keyed per-project (workflows are project-scoped). */
import { fetchWorkflows, type Workflow } from "./api.js";
const _workflowCacheByProject = new Map<string, Workflow[]>();
const _workflowsLoadingByProject = new Set<string>();
let _cachedWorkflows: Workflow[] = [];
let _selectedWorkflowId = "general";
let _goalSandboxed = false;
let _goalAutoStartTeam = true;
let _staffSandboxed = false;
let _assistantEnabledOptionalSteps: string[] = [];

/** Set the selected workflow ID from outside the render module (e.g. from a goal proposal). */
export function setSelectedWorkflowId(id: string): void {
	_selectedWorkflowId = id;
}

function ensureWorkflowsLoaded(projectId?: string): void {
	// Workflows are project-scoped (no system layer). Without a project we can't
	// resolve any — leave the cache empty so the goal form falls back gracefully.
	if (!projectId) {
		_cachedWorkflows = [];
		return;
	}
	const cached = _workflowCacheByProject.get(projectId);
	if (cached) {
		_cachedWorkflows = cached;
		return;
	}
	if (_workflowsLoadingByProject.has(projectId)) return;
	_workflowsLoadingByProject.add(projectId);
	fetchWorkflows(projectId).then((wfs) => {
		_workflowCacheByProject.set(projectId, wfs);
		_workflowsLoadingByProject.delete(projectId);
		_cachedWorkflows = wfs;
		renderApp();
	});
}

let _sandboxStatusFetching = false;

/** Cached `repoCount` per project for the goal-creation multi-repo indicator.
 *  Phase 4b. Counts distinct `repo` values across configured components. */
const _projectComponentsCache = new Map<string, { repoCount: number; componentCount: number; multiRepo: boolean }>();
const _projectComponentsFetching = new Set<string>();
function ensureProjectComponentsLoaded(projectId: string): void {
	if (_projectComponentsCache.has(projectId) || _projectComponentsFetching.has(projectId)) return;
	_projectComponentsFetching.add(projectId);
	gatewayFetch(`/api/projects/${projectId}/structured`)
		.then(r => r.json())
		.then(data => {
			const components: Array<{ repo?: string }> = Array.isArray(data?.components) ? data.components : [];
			const repos = new Set<string>();
			for (const c of components) repos.add(c.repo || ".");
			const summary = {
				repoCount: repos.size,
				componentCount: components.length,
				multiRepo: components.some(c => (c.repo || ".") !== "."),
			};
			_projectComponentsCache.set(projectId, summary);
			_projectComponentsFetching.delete(projectId);
			renderApp();
		})
		.catch(() => {
			_projectComponentsCache.set(projectId, { repoCount: 1, componentCount: 0, multiRepo: false });
			_projectComponentsFetching.delete(projectId);
			renderApp();
		});
}

const _qaConfigCache = new Map<string, boolean>();
let _qaConfigFetching = false;
function ensureQaConfigLoaded(projectId: string): void {
	if (_qaConfigCache.has(projectId) || _qaConfigFetching) return;
	_qaConfigFetching = true;
	gatewayFetch(`/api/projects/${projectId}/qa-testing-config`)
		.then(r => r.json())
		.then(data => {
			_qaConfigCache.set(projectId, !!data.configured);
			_qaConfigFetching = false;
			renderApp();
		})
		.catch(() => {
			_qaConfigCache.set(projectId, false);
			_qaConfigFetching = false;
			renderApp();
		});
}
function ensureSandboxStatusLoaded(): void {
	if (state.sandboxStatus || _sandboxStatusFetching) return;
	_sandboxStatusFetching = true;
	fetchSandboxStatus().then(s => { _sandboxStatusFetching = false; if (s) { state.sandboxStatus = s; renderApp(); } });
}

// ============================================================================
// PROPOSAL STREAMING UX (shared helpers)
// ============================================================================

/** Pulsing dot + "Streaming…" label rendered to the left of submit buttons. */
function streamingBadge() {
	return html`
		<span class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
			  data-testid="proposal-streaming-badge"
			  aria-live="polite">
			<span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
			Streaming…
		</span>
	`;
}

/** Tailwind class fragment applied to scrollable preview/textarea regions
 *  while streaming. Pulsing left border. */
const STREAMING_BORDER = "border-l-2 border-l-primary/70 animate-pulse";

// Module-scoped refs (one per scroll-target). Refs are singletons because at
// most one of each panel is mounted at a time (the assistant preview pane is
// not virtualised).
const goalSpecPreviewRef = createRef<HTMLDivElement>();
const goalSpecTextareaRef = createRef<HTMLTextAreaElement>();
const rolePromptPreviewRef = createRef<HTMLDivElement>();
const rolePromptTextareaRef = createRef<HTMLTextAreaElement>();
const toolDocsPreviewRef = createRef<HTMLDivElement>();
const toolRendererPreviewRef = createRef<HTMLDivElement>();
const toolOuterScrollRef = createRef<HTMLDivElement>();
const staffPromptPreviewRef = createRef<HTMLDivElement>();
const staffPromptTextareaRef = createRef<HTMLTextAreaElement>();
const projectOuterScrollRef = createRef<HTMLDivElement>();

// ============================================================================
// SHARED GOAL FORM
// ============================================================================

interface GoalFormConfig {
	// Field values
	title: string;
	spec: string;
	cwd: string;
	workflowId: string;
	sandboxed: boolean;
	specEditMode: boolean;
	enabledOptionalSteps: string[];
	linkedProjectId?: string;

	// Field change callbacks
	onTitleChange: (e: Event) => void;
	onSpecChange: (e: Event) => void;
	onCwdChange: (value: string) => void;
	onCwdSelect: (value: string) => void;
	onWorkflowChange: (e: Event) => void;
	onSandboxChange: (e: Event) => void;
	onSpecEditToggle: () => void;
	onOptionalStepsChange: (steps: string[]) => void;
	autoStartTeam: boolean;
	onAutoStartTeamChange: (e: Event) => void;

	// CWD combobox state
	cwdDropdownOpen: boolean;
	cwdHighlightIndex: number;
	onCwdToggle: (open: boolean) => void;
	onCwdHighlight: (index: number) => void;

	// Action callbacks
	onCreate: () => void;
	onDismiss?: () => void;

	// UI state
	saving?: boolean;
	createDisabled?: boolean;
	streaming?: boolean;
}

function renderGoalForm(config: GoalFormConfig) {
	const linkedProject = config.linkedProjectId ? state.projects.find(p => p.id === config.linkedProjectId) : null;
	const worktreePath = linkedProject
		? worktreePreviewPath(linkedProject.rootPath, config.title)
		: worktreePreviewPath(config.cwd, config.title);
	const wf = _cachedWorkflows.find(w => w.id === config.workflowId);
	if (wf && config.linkedProjectId) ensureQaConfigLoaded(config.linkedProjectId);
	if (config.linkedProjectId) ensureProjectComponentsLoaded(config.linkedProjectId);
	const componentSummary = config.linkedProjectId ? _projectComponentsCache.get(config.linkedProjectId) : undefined;
	const optionalSteps: Array<{name: string; label: string; description?: string; type?: string}> = [];
	if (wf) {
		for (const gate of wf.gates) {
			if (gate.verify) {
				for (const step of gate.verify) {
					if (step.optional) {
						optionalSteps.push({ name: step.name, label: step.label || step.name, description: step.description, type: step.type });
					}
				}
			}
		}
	}
	const sandboxConfigured = !!state.sandboxStatus?.configured;
	const sandboxAvailable = !!(state.sandboxStatus?.available && state.sandboxStatus?.imageExists);
	const lblCls = "text-xs text-muted-foreground font-medium shrink-0";

	queueMicrotask(() => {
		reconcileFollowTail(goalSpecPreviewRef.value);
		reconcileFollowTail(goalSpecTextareaRef.value);
	});

	const goalRev = state.activeProposals.goal?.rev ?? 0;
	return html`
		<div class="flex-1 overflow-y-auto px-5 pt-3 md:pt-4 pb-3 flex flex-col gap-2.5">
			${goalRev > 0 ? html`<div class="text-xs text-muted-foreground -mb-1" data-testid="proposal-panel-rev">rev ${goalRev}</div>` : ""}
			<div class="flex flex-col md:flex-row gap-2.5 md:items-center">
				<div class="flex items-center gap-2 flex-1 min-w-0">
					<label class="${lblCls} w-20 md:w-16">Title</label>
					<div class="flex-1 min-w-0">
						${Input({
							type: "text",
							value: config.title,
							placeholder: "Goal title",
							onInput: config.onTitleChange,
						})}
					</div>
				</div>
				${_cachedWorkflows.length > 0 ? html`
					<div class="flex items-center gap-2 md:shrink-0">
						<label class="${lblCls} w-20 md:w-auto">Workflow</label>
						<select
							class="flex-1 md:flex-none md:w-44 text-sm px-2 py-1.5 rounded-md border border-border bg-background text-foreground h-9"
							.value=${config.workflowId}
							@change=${config.onWorkflowChange}
						>
							${_cachedWorkflows.map((w) => html`
								<option value=${w.id} ?selected=${config.workflowId === w.id}>${w.name} (${w.gates.length} gates)</option>
							`)}
						</select>
					</div>
				` : ""}
			</div>
			${linkedProject ? html`
				<div class="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0">
					<span class="${lblCls} w-20 md:w-16">Worktree</span>
					<span class="truncate flex-1 min-w-0" title=${linkedProject.rootPath + ' → ' + worktreePath}>
						<span class="font-medium text-foreground/80">${linkedProject.name}</span>
						<code class="text-[10px] font-mono opacity-80 ml-1">${worktreePath}</code>
					</span>
				</div>
				${componentSummary?.multiRepo ? html`
					<div class="flex items-center gap-2 text-[11px] text-muted-foreground min-w-0" data-testid="multi-repo-indicator">
						<span class="${lblCls} w-20 md:w-16"></span>
						<span class="truncate flex-1 min-w-0 text-amber-600 dark:text-amber-400">
							Will create ${componentSummary.componentCount} worktree${componentSummary.componentCount === 1 ? "" : "s"}
							across ${componentSummary.repoCount} repo${componentSummary.repoCount === 1 ? "" : "s"}.
						</span>
					</div>
				` : ""}
			` : html`
				<div class="flex items-start gap-2">
					<label class="${lblCls} w-20 md:w-16 mt-2">Directory</label>
					<div class="flex-1 min-w-0">
						${cwdCombobox({
							value: config.cwd,
							onInput: config.onCwdChange,
							onSelect: config.onCwdSelect,
							dropdownOpen: config.cwdDropdownOpen,
							onToggle: config.onCwdToggle,
							highlightedIndex: config.cwdHighlightIndex,
							onHighlight: config.onCwdHighlight,
						})}
						<p class="text-[11px] text-muted-foreground mt-0.5 opacity-70 truncate" title=${worktreePath}>Worktree: <code class="text-[10px]">${worktreePath}</code></p>
					</div>
				</div>
			`}
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
				${sandboxConfigured ? html`
					<label class="flex items-center gap-1.5 cursor-pointer ${!sandboxAvailable ? "opacity-40 pointer-events-none" : ""}">
						<input type="checkbox" class="toggle-switch" .checked=${config.sandboxed}
							?disabled=${!sandboxAvailable}
							@change=${config.onSandboxChange} />
						<span class="text-xs text-muted-foreground font-medium">Sandbox</span>
						<span title=${!sandboxAvailable
							? "Docker sandbox is configured but unavailable — check Docker status and image in Settings"
							: "Runs each team agent in an isolated Docker container with restricted filesystem and network access"}
							class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
					</label>
				` : ""}
				<label class="flex items-center gap-1.5 cursor-pointer">
					<input type="checkbox" class="toggle-switch" .checked=${config.autoStartTeam}
						@change=${config.onAutoStartTeamChange} />
					<span class="text-xs text-muted-foreground font-medium">Auto-start team</span>
					<span title="Automatically start the team lead when the worktree is ready"
						class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
				</label>
				${optionalSteps.map(os => {
					const qaDisabled = os.type === 'agent-qa' && !!config.linkedProjectId && _qaConfigCache.has(config.linkedProjectId) && !_qaConfigCache.get(config.linkedProjectId);
					return html`
					<label class="flex items-center gap-1.5 cursor-pointer ${qaDisabled ? 'opacity-40 pointer-events-none' : ''}">
						<input type="checkbox" class="toggle-switch"
							.checked=${config.enabledOptionalSteps.includes(os.name)}
							?disabled=${qaDisabled}
							@change=${(e: Event) => {
								const checked = (e.target as HTMLInputElement).checked;
								const updated = checked
									? (config.enabledOptionalSteps.includes(os.name) ? config.enabledOptionalSteps : [...config.enabledOptionalSteps, os.name])
									: config.enabledOptionalSteps.filter(n => n !== os.name);
								config.onOptionalStepsChange(updated);
							}}
						/>
						<span class="text-xs text-muted-foreground font-medium">${os.label}</span>
						${os.description ? html`
							<span title=${qaDisabled
								? 'Set qa_start_command on a component\'s config map to enable QA testing'
								: os.description}
								class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
						` : ''}
					</label>
				`;})}
			</div>
			<div class="flex-1 flex flex-col min-h-0">
				<div class="flex items-center justify-between mb-1.5">
					<label class="text-xs text-muted-foreground font-medium">Spec</label>
					<button
						class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
						title="Toggle edit/preview mode"
						@click=${config.onSpecEditToggle}
					>
						${config.specEditMode ? "Preview" : "Edit"}
					</button>
				</div>
				${config.specEditMode
					? html`<textarea
							${ref(goalSpecTextareaRef)}
							class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring ${config.streaming ? STREAMING_BORDER : ""}"
							.value=${config.spec}
							@input=${config.onSpecChange}
						></textarea>`
					: html`<div ${ref(goalSpecPreviewRef)} class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm ${config.streaming ? STREAMING_BORDER : ""}">
							<markdown-block .content=${config.spec || "_No spec content yet_"}></markdown-block>
						</div>`
				}
			</div>
		</div>
		<div class="shrink-0 flex flex-col gap-3 px-5 py-3 border-t border-border">
			<div class="flex items-center justify-end gap-2">
				${config.streaming ? streamingBadge() : ""}
				${config.onDismiss ? Button({ variant: "ghost", onClick: config.onDismiss, children: "Dismiss" }) : ""}
				<span data-testid="proposal-primary-submit">${Button({
					variant: "default",
					onClick: config.onCreate,
					disabled: (config.createDisabled ?? !config.title.trim()) || !!config.streaming,
					children: config.saving ? "Creating…" : html`<span class="inline-flex items-center gap-1.5">${icon(GoalIcon, "sm")} Create Goal</span>`,
				})}</span>
			</div>
		</div>
	`;
}

function goalPreviewPanel() {
	ensureWorkflowsLoaded(state.previewProjectId || undefined);
	ensureSandboxStatusLoaded();

	const handleCreateGoal = async () => {
		const trimmedTitle = state.previewTitle.trim();
		if (!trimmedTitle) return;
		if (!state.previewProjectId) {
			showConnectionError("No project selected for this goal", "Select a project from the + New Goal picker before creating a goal.");
			return;
		}
		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		delete state.activeProposals.goal;
		const projectId = state.previewProjectId || undefined;
		state.previewProjectId = "";
		const workflowId = _selectedWorkflowId || "general";
		_selectedWorkflowId = "general";
		const sandboxed = _goalSandboxed;
		_goalSandboxed = false;
		const autoStartTeam = _goalAutoStartTeam;
		_goalAutoStartTeam = true;
		const enabledOptionalSteps = _assistantEnabledOptionalSteps.length > 0 ? _assistantEnabledOptionalSteps : undefined;
		_assistantEnabledOptionalSteps = [];
		// Clean up persisted draft
		if (sessionId) {
			deleteGoalDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");
		state.appView = "authenticated";

		// Detect re-attempt context from the current session
		const currentSession = state.gatewaySessions.find(s => s.id === sessionId);
		const reattemptGoalId = currentSession?.reattemptGoalId;

		const goal = await createGoal(trimmedTitle, state.previewCwd.trim(), {
			spec: state.previewSpec,
			workflowId,
			reattemptOf: reattemptGoalId || undefined,
			sandboxed,
			projectId,
			enabledOptionalSteps,
			autoStartTeam,
		});

		// Slice E: drop the on-disk proposal file once accepted.
		if (sessionId && goal) void deleteProposalFile(sessionId, "goal");

		// If this is a re-attempt, archive the old goal and link the new one
		if (reattemptGoalId && goal) {
			await gatewayFetch(`/api/goals/${reattemptGoalId}`, { method: "DELETE" });
			await gatewayFetch(`/api/goals/${goal.id}`, {
				method: "PUT",
				body: JSON.stringify({ reattemptOf: reattemptGoalId }),
			});
		}

		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}
		await refreshSessions();
		if (goal) {
			setHashRoute("goal-dashboard", goal.id, true);
		} else {
			setHashRoute("landing");
		}
		renderApp();
	};

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0" data-panel="goal-proposal">
			${renderGoalForm({
				title: state.previewTitle,
				spec: state.previewSpec,
				cwd: state.previewCwd,
				workflowId: _selectedWorkflowId,
				sandboxed: _goalSandboxed,
				specEditMode: state.previewSpecEditMode,
				enabledOptionalSteps: _assistantEnabledOptionalSteps,
				linkedProjectId: state.previewProjectId || undefined,
				onTitleChange: (e: Event) => {
					state.previewTitle = (e.target as HTMLInputElement).value;
					state.previewTitleEdited = true;
					const sid = activeSessionId();
					if (sid) saveGoalDraft(sid);
					// Debounced goal title summarization (1s)
					if ((state as any)._goalTitleDebounceTimer) {
						clearTimeout((state as any)._goalTitleDebounceTimer);
					}
					const trimmedTitle = (e.target as HTMLInputElement).value.trim();
					if (trimmedTitle.length >= 3 && trimmedTitle !== (state as any)._lastSummarizedGoalTitle && state.remoteAgent) {
						(state as any)._goalTitleDebounceTimer = setTimeout(() => {
							(state as any)._lastSummarizedGoalTitle = trimmedTitle;
							state.remoteAgent?.summarizeGoalTitle(trimmedTitle);
							(state as any)._goalTitleDebounceTimer = null;
						}, 1000);
					}
				},
				onSpecChange: (e: Event) => {
					state.previewSpec = (e.target as HTMLTextAreaElement).value;
					state.previewSpecEdited = true;
					const sid = activeSessionId();
					if (sid) saveGoalDraft(sid);
				},
				onCwdChange: (v) => {
					state.previewCwd = v;
					state.previewCwdEdited = true;
					const sid = activeSessionId();
					if (sid) saveGoalDraft(sid);
					renderApp();
				},
				onCwdSelect: (v) => {
					state.previewCwd = v;
					state.previewCwdEdited = true;
					const sid = activeSessionId();
					if (sid) saveGoalDraft(sid);
					renderApp();
				},
				onWorkflowChange: (e: Event) => { _selectedWorkflowId = (e.target as HTMLSelectElement).value; renderApp(); },
				onSandboxChange: (e: Event) => { _goalSandboxed = (e.target as HTMLInputElement).checked; renderApp(); },
				onSpecEditToggle: () => { state.previewSpecEditMode = !state.previewSpecEditMode; renderApp(); },
				onOptionalStepsChange: (steps) => { _assistantEnabledOptionalSteps = steps; renderApp(); },
				autoStartTeam: _goalAutoStartTeam,
				onAutoStartTeamChange: (e: Event) => { _goalAutoStartTeam = (e.target as HTMLInputElement).checked; renderApp(); },
				cwdDropdownOpen: state.cwdDropdownOpen,
				cwdHighlightIndex: state.cwdHighlightIndex,
				onCwdToggle: (open) => { state.cwdDropdownOpen = open; renderApp(); },
				onCwdHighlight: (i) => { state.cwdHighlightIndex = i; },
				onCreate: handleCreateGoal,
				streaming: isProposalStreaming("goal_proposal"),
			})}
		</div>
	`;
}

// ============================================================================
// ROLE PREVIEW PANEL (role assistant split-screen)
// ============================================================================

import { ACCESSORY_IDS, getAccessory, statusBobbit } from "./session-colors.js";
import { fetchTools, type ToolInfo } from "./api.js";

/** Cached available tools list (loaded once). */
let _availableTools: ToolInfo[] = [];
let _toolsLoaded = false;

function ensureToolsLoaded(): void {
	if (_toolsLoaded) return;
	_toolsLoaded = true;
	fetchTools().then((tools) => { _availableTools = tools; renderApp(); });
}

function rolePreviewPanel() {
	ensureToolsLoaded();
	const streaming = isProposalStreaming("role_proposal");
	queueMicrotask(() => {
		reconcileFollowTail(rolePromptPreviewRef.value);
		reconcileFollowTail(rolePromptTextareaRef.value);
	});

	const handleCreateRole = async () => {
		const trimmedName = state.rolePreviewName.trim();
		const trimmedLabel = state.rolePreviewLabel.trim();
		if (!trimmedName || !trimmedLabel) return;
		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		delete state.activeProposals.role;
		// Clean up persisted draft
		if (sessionId) {
			deleteRoleDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");

		// Parse tools: comma-separated string -> array
		const toolsList = state.rolePreviewTools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		// Convert tools list to toolPolicies (all explicitly listed tools get "allow")
		const toolPolicies: Record<string, string> = {};
		for (const t of toolsList) toolPolicies[t] = "allow";

		await createRole({
			name: trimmedName,
			label: trimmedLabel,
			promptTemplate: state.rolePreviewPrompt,
			toolPolicies: Object.keys(toolPolicies).length > 0 ? toolPolicies : undefined,
			accessory: state.rolePreviewAccessory,
		});

		// Slice E: drop the on-disk proposal file once accepted.
		if (sessionId) void deleteProposalFile(sessionId, "role");

		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}

		// Navigate to the roles page
		const { loadRolePageData } = await import("./role-manager-page.js");
		await loadRolePageData();
		setHashRoute("roles");
		renderApp();
	};

	// Parse current tools string into array for display
	const currentTools = state.rolePreviewTools
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0" data-panel="role-proposal">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Name</label>
					${Input({
						type: "text",
						value: state.rolePreviewName,
						placeholder: "role-name (lowercase, hyphens)",
						onInput: (e: Event) => {
							state.rolePreviewName = (e.target as HTMLInputElement).value;
							state.rolePreviewNameEdited = true;
							const sid = activeSessionId();
							if (sid) saveRoleDraft(sid);
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Label</label>
					${Input({
						type: "text",
						value: state.rolePreviewLabel,
						placeholder: "Display Label",
						onInput: (e: Event) => {
							state.rolePreviewLabel = (e.target as HTMLInputElement).value;
							state.rolePreviewLabelEdited = true;
							const sid = activeSessionId();
							if (sid) saveRoleDraft(sid);
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Accessory</label>
					<div class="flex flex-wrap gap-2">
						${ACCESSORY_IDS.map((accId) => {
							const acc = getAccessory(accId);
							const isSelected = state.rolePreviewAccessory === accId;
							return html`
								<button
									class="flex flex-col items-center gap-1 px-2 py-1.5 rounded border transition-colors ${isSelected ? "border-primary bg-primary/10" : "border-border hover:border-muted-foreground/50"}"
									@click=${() => {
										state.rolePreviewAccessory = accId;
										state.rolePreviewAccessoryEdited = true;
										const sid = activeSessionId();
										if (sid) saveRoleDraft(sid);
										renderApp();
									}}
									title=${acc.label}
								>
									${statusBobbit("idle", false, undefined, isSelected, false, accId === "crown", accId === "bandana", accId)}
									<span class="text-[10px] text-muted-foreground">${acc.label}</span>
								</button>
							`;
						})}
					</div>
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Tools</label>
					<div class="flex flex-wrap gap-1 mb-2">
						${currentTools.map((tool) => html`
							<span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-secondary text-secondary-foreground">
								${tool}
								<button class="hover:text-destructive" title="Remove tool" @click=${() => {
									const remaining = currentTools.filter((t) => t !== tool);
									state.rolePreviewTools = remaining.join(", ");
									state.rolePreviewToolsEdited = true;
									const sid = activeSessionId();
									if (sid) saveRoleDraft(sid);
									renderApp();
								}}>&times;</button>
							</span>
						`)}
						${currentTools.length === 0 ? html`<span class="text-xs text-muted-foreground italic">All tools allowed</span>` : ""}
					</div>
					${_availableTools.length > 0 ? html`
						<div class="flex flex-wrap gap-1">
							${_availableTools.filter((t) => !currentTools.includes(t.name)).map((tool) => html`
								<button
									class="text-[10px] px-1.5 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
									title="${tool.description}"
									@click=${() => {
										const newTools = [...currentTools, tool.name];
										state.rolePreviewTools = newTools.join(", ");
										state.rolePreviewToolsEdited = true;
										const sid = activeSessionId();
										if (sid) saveRoleDraft(sid);
										renderApp();
									}}
								>+ ${tool.name}</button>
							`)}
						</div>
					` : ""}
				</div>
				<div class="flex-1 flex flex-col min-h-0">
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">System Prompt</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							title="Toggle edit/preview mode"
							@click=${() => { state.rolePreviewPromptEditMode = !state.rolePreviewPromptEditMode; renderApp(); }}
						>
							${state.rolePreviewPromptEditMode ? "Preview" : "Edit"}
						</button>
					</div>
					${state.rolePreviewPromptEditMode
						? html`<textarea
								${ref(rolePromptTextareaRef)}
								class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring ${streaming ? STREAMING_BORDER : ""}"
								.value=${state.rolePreviewPrompt}
								@input=${(e: Event) => {
									state.rolePreviewPrompt = (e.target as HTMLTextAreaElement).value;
									state.rolePreviewPromptEdited = true;
									const sid = activeSessionId();
									if (sid) saveRoleDraft(sid);
								}}
							></textarea>`
						: html`<div ${ref(rolePromptPreviewRef)} class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm ${streaming ? STREAMING_BORDER : ""}">
								<markdown-block .content=${state.rolePreviewPrompt || "_No prompt content yet_"}></markdown-block>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${streaming ? streamingBadge() : ""}
				<span data-testid="proposal-primary-submit">${Button({
					variant: "default",
					onClick: handleCreateRole,
					disabled: !state.rolePreviewName.trim() || !state.rolePreviewLabel.trim() || streaming,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Users, "sm")} Create Role</span>`,
				})}</span>
			</div>
		</div>
	`;
}

// ============================================================================
// TOOL PREVIEW PANEL (tool assistant split-screen)
// ============================================================================

function toolPreviewPanel() {
	const streaming = isProposalStreaming("tool_proposal");
	queueMicrotask(() => {
		reconcileFollowTail(toolDocsPreviewRef.value);
		reconcileFollowTail(toolRendererPreviewRef.value);
		reconcileFollowTail(toolOuterScrollRef.value);
	});
	const handleDone = () => {
		backToSessions();
	};

	const handleViewTool = async () => {
		const toolName = state.toolPreviewName.trim();
		if (!toolName) return;
		const { loadToolPageData } = await import("./tool-manager-page.js");
		await loadToolPageData();
		setHashRoute("tool-edit", toolName);
		renderApp();
	};

	const checklist = state.toolPreviewChecklist;
	const checklistItems = [
		{ key: "docs" as const, label: "Documentation", desc: "Usage examples, parameter descriptions" },
		{ key: "renderer" as const, label: "Renderer", desc: "Custom tool call display component" },
		{ key: "tests" as const, label: "Tests", desc: "Unit and E2E test coverage" },
		{ key: "config" as const, label: "Configuration", desc: "Tool metadata, groups, role access" },
	];

	const statusIcon = (s: "pending" | "in-progress" | "done") =>
		s === "done" ? html`<span class="text-green-500">&#10003;</span>`
		: s === "in-progress" ? html`<span class="text-yellow-500 animate-pulse">&#9679;</span>`
		: html`<span class="text-muted-foreground">&#9675;</span>`;

	const doneCount = Object.values(checklist).filter((s) => s === "done").length;
	const total = checklistItems.length;

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0" data-panel="tool-proposal">
			<div ${ref(toolOuterScrollRef)} class="flex-1 overflow-y-auto p-5 flex flex-col gap-4 ${streaming ? STREAMING_BORDER : ""}">
				<!-- Tool name header -->
				<div>
					<div class="text-xs text-muted-foreground mb-1">Tool</div>
					<div class="text-lg font-semibold">${state.toolPreviewName || html`<span class="text-muted-foreground italic">Waiting for assistant...</span>`}</div>
				</div>

				<!-- Progress bar -->
				<div>
					<div class="flex items-center justify-between mb-1.5">
						<span class="text-xs text-muted-foreground font-medium">Progress</span>
						<span class="text-xs text-muted-foreground">${doneCount}/${total}</span>
					</div>
					<div class="h-1.5 rounded-full bg-secondary overflow-hidden">
						<div class="h-full rounded-full bg-primary transition-all duration-500" style="width: ${(doneCount / total) * 100}%"></div>
					</div>
				</div>

				<!-- Checklist -->
				<div class="flex flex-col gap-2">
					${checklistItems.map((item) => html`
						<div class="flex items-start gap-2.5 p-2.5 rounded-md border border-border ${checklist[item.key] === "done" ? "bg-green-500/5" : ""}">
							<div class="mt-0.5 text-sm">${statusIcon(checklist[item.key])}</div>
							<div class="flex-1 min-w-0">
								<div class="text-sm font-medium">${item.label}</div>
								<div class="text-xs text-muted-foreground">${item.desc}</div>
							</div>
						</div>
					`)}
				</div>

				<!-- Documentation preview -->
				${state.toolPreviewDocs ? html`
					<div>
						<div class="text-xs text-muted-foreground mb-1.5 font-medium">Documentation Preview</div>
						<div ${ref(toolDocsPreviewRef)} class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm max-h-[200px] ${streaming ? STREAMING_BORDER : ""}">
							<markdown-block .content=${state.toolPreviewDocs}></markdown-block>
						</div>
					</div>
				` : ""}

				<!-- Renderer preview -->
				${state.toolPreviewRendererHtml ? html`
					<div>
						<div class="text-xs text-muted-foreground mb-1.5 font-medium">Renderer Preview</div>
						<div ${ref(toolRendererPreviewRef)} class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm max-h-[300px] ${streaming ? STREAMING_BORDER : ""}">
							<markdown-block .content=${state.toolPreviewRendererHtml}></markdown-block>
						</div>
					</div>
				` : ""}
			</div>

			<!-- Footer -->
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${streaming ? streamingBadge() : ""}
				${Button({ variant: "ghost", onClick: handleDone, children: "Close" })}
				${state.toolPreviewName ? html`<span data-testid="proposal-primary-submit">${Button({
					variant: "default",
					onClick: handleViewTool,
					disabled: streaming,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Wrench, "sm")} View Tool</span>`,
				})}</span>` : ""}
			</div>
		</div>
	`;
}

// ============================================================================
// STAFF PREVIEW PANEL (staff assistant split-screen)
// ============================================================================

import { createStaffAgent } from "./api.js";
import { reloadStaffList } from "./sidebar.js";

interface TriggerDef {
	type: string;
	config: Record<string, any>;
	enabled: boolean;
	prompt?: string;
}

function parseTriggers(json: string): TriggerDef[] {
	try {
		const arr = JSON.parse(json);
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
}

function updateTrigger(index: number, updater: (t: TriggerDef) => void) {
	const triggers = parseTriggers(state.staffPreviewTriggers);
	if (triggers[index]) {
		updater(triggers[index]);
		state.staffPreviewTriggers = JSON.stringify(triggers);
		state.staffPreviewTriggersEdited = true;
		renderApp();
	}
}

function removeTrigger(index: number) {
	const triggers = parseTriggers(state.staffPreviewTriggers);
	triggers.splice(index, 1);
	state.staffPreviewTriggers = JSON.stringify(triggers);
	state.staffPreviewTriggersEdited = true;
	renderApp();
}

function renderTriggersEditor() {
	const triggers = parseTriggers(state.staffPreviewTriggers);
	if (triggers.length === 0) {
		return html`<div class="text-xs text-muted-foreground italic p-3 border border-dashed border-border rounded-md">No triggers configured. Add one above.</div>`;
	}
	return html`<div class="flex flex-col gap-2">${triggers.map((t, i) => renderTriggerCard(t, i))}</div>`;
}

function renderTriggerCard(trigger: TriggerDef, index: number) {
	const typeLabel: Record<string, string> = { schedule: "⏰ Schedule", git: "🔀 Git", manual: "👆 Manual" };
	const typeOptions = ["schedule", "git", "manual"];
	const inputClass = "w-full h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring";

	const onTypeChange = (e: Event) => {
		const newType = (e.target as HTMLSelectElement).value;
		updateTrigger(index, (t) => {
			t.type = newType;
			if (newType === "schedule") t.config = { cron: "0 9 * * *" };
			else if (newType === "git") t.config = { event: "push", branch: "master" };
			else t.config = {};
		});
	};

	return html`
		<div class="rounded-md border border-border bg-secondary/20 p-3">
			<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px">
				<select
					class="text-xs px-2 py-1 rounded border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
					.value=${trigger.type}
					@change=${onTypeChange}
				>
					${typeOptions.map((opt) => html`<option value=${opt} ?selected=${trigger.type === opt}>${typeLabel[opt] || opt}</option>`)}
				</select>
				<label style="display:flex; align-items:center; gap:4px; margin-left:auto; font-size:11px" class="text-muted-foreground cursor-pointer select-none">
					<input
						type="checkbox"
						class="accent-primary"
						.checked=${trigger.enabled !== false}
						@change=${(e: Event) => updateTrigger(index, (t) => { t.enabled = (e.target as HTMLInputElement).checked; })}
					/> Enabled
				</label>
				<button
					class="text-[10px] px-1.5 py-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
					title="Remove trigger"
					@click=${() => removeTrigger(index)}
				>✕</button>
			</div>

			${trigger.type === "schedule" ? html`
				<div style="margin-bottom:4px">
					<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Cron expression (UTC)</label>
					<input
						type="text"
						class=${inputClass}
						placeholder="0 9 * * *"
						.value=${trigger.config?.cron || ""}
						@input=${(e: Event) => updateTrigger(index, (t) => { t.config.cron = (e.target as HTMLInputElement).value; })}
					/>
				</div>
				<div class="text-[10px] text-muted-foreground" style="margin-bottom:8px">${describeCron(trigger.config?.cron || "")}</div>
			` : ""}

			${trigger.type === "git" ? html`
				<div style="display:grid; grid-template-columns:100px 1fr; gap:8px; margin-bottom:8px">
					<div>
						<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Event</label>
						<select
							class=${inputClass}
							.value=${trigger.config?.event || "push"}
							@change=${(e: Event) => updateTrigger(index, (t) => { t.config.event = (e.target as HTMLSelectElement).value; })}
						>
							<option value="push" ?selected=${trigger.config?.event === "push"}>push</option>
						</select>
					</div>
					<div>
						<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Branch</label>
						<input
							type="text"
							class=${inputClass}
							placeholder="master"
							.value=${trigger.config?.branch || ""}
							@input=${(e: Event) => updateTrigger(index, (t) => { t.config.branch = (e.target as HTMLInputElement).value; })}
						/>
					</div>
				</div>
			` : ""}

			<div style="margin-top:${trigger.type === "manual" ? "0" : "0"}">
				<label class="text-[10px] text-muted-foreground" style="display:block; margin-bottom:2px">Wake prompt (optional)</label>
				<textarea
					class="w-full p-2 text-xs rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
					rows="2"
					placeholder="Message sent to the agent when this trigger fires"
					.value=${trigger.prompt || ""}
					@input=${(e: Event) => updateTrigger(index, (t) => { t.prompt = (e.target as HTMLTextAreaElement).value; })}
				></textarea>
			</div>
		</div>
	`;
}

/** Produce a human-readable description of a cron expression. */
function describeCron(cron: string): string {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) return cron ? `Custom: ${cron}` : "";
	const [min, hour, dom, mon, dow] = parts;

	const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

	let timeStr = "";
	if (min !== "*" && hour !== "*") {
		const h = parseInt(hour, 10);
		const m = parseInt(min, 10);
		if (!isNaN(h) && !isNaN(m)) {
			const ampm = h >= 12 ? "PM" : "AM";
			const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
			timeStr = `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
		}
	}

	// Every N hours
	if (hour.startsWith("*/")) {
		const n = hour.slice(2);
		const base = min === "0" ? "on the hour" : `at :${min.padStart(2, "0")}`;
		return `Every ${n} hour${n === "1" ? "" : "s"}, ${base}`;
	}

	// Every N minutes
	if (min.startsWith("*/")) {
		const n = min.slice(2);
		return `Every ${n} minute${n === "1" ? "" : "s"}`;
	}

	// Daily
	if (dom === "*" && mon === "*" && dow === "*" && timeStr) {
		return `Daily at ${timeStr}`;
	}

	// Weekdays only
	if (dom === "*" && mon === "*" && dow === "1-5" && timeStr) {
		return `Weekdays at ${timeStr}`;
	}

	// Specific day of week
	if (dom === "*" && mon === "*" && dow !== "*" && timeStr) {
		const dowNum = parseInt(dow, 10);
		const dayName = !isNaN(dowNum) && dowNum >= 0 && dowNum <= 6 ? dayNames[dowNum] : dow;
		return `Every ${dayName} at ${timeStr}`;
	}

	// Specific day of month
	if (dom !== "*" && mon === "*" && dow === "*" && timeStr) {
		const suffix = dom === "1" ? "st" : dom === "2" ? "nd" : dom === "3" ? "rd" : "th";
		return `${dom}${suffix} of each month at ${timeStr}`;
	}

	return cron ? `Custom: ${cron}` : "";
}

function staffPreviewPanel() {
	ensureSandboxStatusLoaded();
	const streaming = isProposalStreaming("staff_proposal");
	queueMicrotask(() => {
		reconcileFollowTail(staffPromptPreviewRef.value);
		reconcileFollowTail(staffPromptTextareaRef.value);
	});
	const handleCreateStaff = async () => {
		const trimmedName = state.staffPreviewName.trim();
		if (!trimmedName) return;
		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		delete state.activeProposals.staff;
		localStorage.removeItem("gateway.sessionId");
		setHashRoute("landing");
		state.appView = "authenticated";

		let triggers: any[] = [];
		try {
			triggers = JSON.parse(state.staffPreviewTriggers);
		} catch { /* keep empty */ }

		const sandboxed = _staffSandboxed;
		_staffSandboxed = false;
		const result = await createStaffAgent({
			name: trimmedName,
			description: state.staffPreviewDescription,
			systemPrompt: state.staffPreviewPrompt,
			cwd: state.staffPreviewCwd,
			triggers,
			projectId: state.activeProjectId || undefined,
			sandboxed,
		});
		// Slice E: drop the on-disk proposal file once accepted.
		if (sessionId) void deleteProposalFile(sessionId, "staff");
		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}
		reloadStaffList();
		await refreshSessions();
		if (result?.currentSessionId) {
			const { connectToSession } = await import("./session-manager.js");
			await connectToSession(result.currentSessionId, false);
		}
		renderApp();
	};

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0" data-panel="staff-proposal">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Name</label>
					${Input({
						type: "text",
						value: state.staffPreviewName,
						placeholder: "Staff agent name",
						onInput: (e: Event) => {
							state.staffPreviewName = (e.target as HTMLInputElement).value;
							state.staffPreviewNameEdited = true;
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Description</label>
					<textarea
						class="w-full p-2 text-sm rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
						rows="2"
						placeholder="What does this staff agent do?"
						.value=${state.staffPreviewDescription}
						@input=${(e: Event) => {
							state.staffPreviewDescription = (e.target as HTMLTextAreaElement).value;
							state.staffPreviewDescriptionEdited = true;
						}}
					></textarea>
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Working Directory</label>
					${Input({
						type: "text",
						value: state.staffPreviewCwd,
						placeholder: (state as any).defaultCwd || "(server default)",
						onInput: (e: Event) => {
							state.staffPreviewCwd = (e.target as HTMLInputElement).value;
							state.staffPreviewCwdEdited = true;
						},
					})}
				</div>
				${state.sandboxStatus?.configured ? html`
				<div>
					<label class="flex items-center gap-1.5 cursor-pointer ${!(state.sandboxStatus.available && state.sandboxStatus.imageExists) ? "opacity-40 pointer-events-none" : ""}">
						<input type="checkbox" class="toggle-switch" .checked=${_staffSandboxed}
							?disabled=${!(state.sandboxStatus.available && state.sandboxStatus.imageExists)}
							@change=${(e: Event) => { _staffSandboxed = (e.target as HTMLInputElement).checked; renderApp(); }} />
						<span class="text-xs text-muted-foreground font-medium">Sandbox (Docker)</span>
						<span title=${!(state.sandboxStatus.available && state.sandboxStatus.imageExists)
							? "Docker sandbox is configured but unavailable — check Docker status and image in Settings"
							: "Runs this staff agent in an isolated Docker container with restricted filesystem and network access"}
							class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
					</label>
				</div>
				` : ""}
				<div>
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">Triggers</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							title="Add trigger"
							@click=${() => {
								const triggers = parseTriggers(state.staffPreviewTriggers);
								triggers.push({ type: "manual", config: {}, enabled: true, prompt: "" });
								state.staffPreviewTriggers = JSON.stringify(triggers);
								state.staffPreviewTriggersEdited = true;
								renderApp();
							}}
						>+ Add trigger</button>
					</div>
					${renderTriggersEditor()}
				</div>
				<div>
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">System Prompt</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							title="Toggle edit/preview mode"
							@click=${() => { state.staffPreviewPromptEditMode = !state.staffPreviewPromptEditMode; renderApp(); }}
						>
							${state.staffPreviewPromptEditMode ? "Preview" : "Edit"}
						</button>
					</div>
					${state.staffPreviewPromptEditMode
						? html`<textarea
								${ref(staffPromptTextareaRef)}
								class="p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring ${streaming ? STREAMING_BORDER : ""}"
								style="min-height:150px; max-height:400px; width:100%"
								.value=${state.staffPreviewPrompt}
								@input=${(e: Event) => {
									state.staffPreviewPrompt = (e.target as HTMLTextAreaElement).value;
									state.staffPreviewPromptEdited = true;
								}}
							></textarea>`
						: html`<div ${ref(staffPromptPreviewRef)} class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm ${streaming ? STREAMING_BORDER : ""}" style="min-height:150px; max-height:400px">
								<markdown-block .content=${state.staffPreviewPrompt || "_No prompt content yet_"}></markdown-block>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${streaming ? streamingBadge() : ""}
				<span data-testid="proposal-primary-submit">${Button({
					variant: "default",
					onClick: handleCreateStaff,
					disabled: !state.staffPreviewName.trim() || streaming,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(UserCheck, "sm")} Create Staff</span>`,
				})}</span>
			</div>
		</div>
	`;
}

// ============================================================================
// ASSISTANT PREVIEW DISPATCH
// ============================================================================

/** Editable scalars shown in the proposal panel's Settings tab.
 *  Components are the canonical home for build/test/typecheck/setup commands —
 *  those legacy keys are still accepted on the wire (back-compat) but hidden
 *  from this panel to avoid duplication. They render via the Components tab. */
const PROJECT_LEGACY_COMMAND_KEYS = new Set([
	"build_command",
	"test_command",
	"typecheck_command",
	"test_unit_command",
	"test_e2e_command",
	"worktree_setup_command",
]);
/** Native-YAML structured fields. Stored as objects/arrays/numbers, not
 *  strings — the panel has no inline editor for them, so we hide them rather
 *  than render `[object Object]`. They round-trip via the wire format on
 *  accept (PUT /api/projects/:id/config) without panel involvement. */
const PROJECT_STRUCTURED_FIELD_KEYS = new Set([
	"config_directories",
	"sandbox_tokens",
	"components",
	"workflows",
]);
/** Legacy top-level QA keys — moved to components[].config[] in the
 *  component-config-map migration. Hidden from this panel; the migration
 *  rejects them on the wire (see PUT /api/projects/:id/config). */
const PROJECT_LEGACY_QA_KEYS = new Set([
	"qa_start_command",
	"qa_build_command",
	"qa_health_check",
	"qa_browser_entry",
	"qa_env",
	"qa_max_duration_minutes",
	"qa_max_scenarios",
]);
/** Fields managed exclusively in Settings → Project (not editable in the
 *  proposal panel). Hidden from the panel even if the agent or current config
 *  carries them. */
const PROJECT_PANEL_HIDDEN_KEYS = new Set([
	"sandbox",
	"sandbox_image",
	"sandbox_mounts",
	"sandbox_credentials",
	"sandbox_github_token",
	"sandbox_host_token_overrides",
]);
const PROJECT_EDITABLE_FIELDS: Array<{ key: string; label: string }> = [
	{ key: "name", label: "Project Name" },
	{ key: "worktree_root", label: "Worktree Root" },
	{ key: "worktree_pool_size", label: "Worktree Pool Size" },
];

// Module-level state for the project proposal panel's tab UI.
let _projectProposalView: ProjectViewMode = "components";

/** Reset module-level proposal panel state. Called on session disconnect. */
export function resetProjectProposalPanel(): void {
	_projectProposalView = "components";
}

function projectProposalPanel() {
	const proposal = state.activeProposals.project;
	const streaming = isProposalStreaming("project_proposal");
	queueMicrotask(() => {
		reconcileFollowTail(projectOuterScrollRef.value);
	});

	if (!proposal) {
		return html`
			<div class="flex-1 flex flex-col min-h-0 w-full" data-panel="project-proposal">
				<div class="flex-1 flex items-center justify-center text-muted-foreground text-sm p-5">
					Waiting for project analysis…
				</div>
			</div>
		`;
	}

	// `fields` carries structured `components` / `workflows` blocks alongside
	// flat string fields. The legacy collapsed-fields loop below operates on
	// strings only — `components` / `workflows` are partitioned OUT and handed
	// to dedicated views. Other non-string values are JSON-stringified for the
	// flat Input rows; the original structured value is preserved on
	// `proposal.fields`.
	const rawFields = proposal.fields as Record<string, unknown>;
	const structuredComponents = (rawFields.components as ProposalComponent[] | undefined) ?? [];
	const structuredWorkflows = (rawFields.workflows as Record<string, ProposalWorkflow> | undefined) ?? {};
	const fields: Record<string, string> = {};
	for (const [k, v] of Object.entries(rawFields)) {
		if (k === "components" || k === "workflows") continue;
		if (typeof v === "string") fields[k] = v;
		else if (v == null) fields[k] = "";
		else {
			try { fields[k] = JSON.stringify(v); } catch { fields[k] = String(v); }
		}
	}
	const mode = proposal.mode ?? "provisional";
	const isRegistered = mode === "registered";

	/** Build union of keys to render: known editable + proposal fields. */
	const knownKeys = new Set(PROJECT_EDITABLE_FIELDS.map(f => f.key));
	const extraKeys: string[] = [];
	for (const k of Object.keys(fields)) {
		if (k === "root_path") continue;
		if (PROJECT_LEGACY_COMMAND_KEYS.has(k)) continue;
		if (PROJECT_STRUCTURED_FIELD_KEYS.has(k)) continue;
		if (PROJECT_LEGACY_QA_KEYS.has(k)) continue;
		if (PROJECT_PANEL_HIDDEN_KEYS.has(k)) continue;
		if (!knownKeys.has(k)) extraKeys.push(k);
	}

	const handleAccept = async () => {
		const { acceptProjectProposal } = await import("./session-manager.js");
		await acceptProjectProposal();
	};

	const handleDismiss = () => {
		if (proposal?.sessionId) deleteProjectDraft(proposal.sessionId);
		delete state.activeProposals.project;
		state.assistantHasProposal = false;
		renderApp();
	};

	const onFieldInput = (key: string, value: string) => {
		const slot = state.activeProposals.project;
		if (!slot) return;
		// Bug B guard: `components` and `workflows` are structured side-tables
		// owned by dedicated views — never let an Input row clobber them with a
		// string keystroke value.
		if (key === "components" || key === "workflows") return;
		(slot.fields as Record<string, unknown>)[key] = value;
		// Only persist edits for project-assistant sessions; non-assistant
		// sessions follow the goal-proposal model (transient, not restored).
		if (state.assistantType === "project" || state.assistantType === "project-scaffolding") {
			saveProjectDraft(slot.sessionId);
		}
		renderApp();
	};

	/** Per-field placeholders — concrete examples, not just the key name repeated. */
	const PLACEHOLDERS: Record<string, string> = {
		name: "my-project",
		worktree_root: "C:\\Users\\me\\my-project-wt   (default: <root>-wt)",
		worktree_pool_size: "2",
	};

	const renderRow = (key: string, label: string) => {
		const proposed = fields[key] ?? "";
		const placeholder = PLACEHOLDERS[key] ?? "";
		const inputType = key === "worktree_pool_size" ? "number" : "text";
		return html`
			<div data-field=${key}>
				<label class="text-xs text-muted-foreground mb-1.5 block font-medium">${label}</label>
				${Input({
					type: inputType,
					value: proposed,
					placeholder,
					onInput: (e: Event) => onFieldInput(key, (e.target as HTMLInputElement).value),
				})}
			</div>
		`;
	};

	const curatedKeys: string[] = PROJECT_EDITABLE_FIELDS.map(f => f.key);
	const labelFor = (key: string): string => {
		const known = PROJECT_EDITABLE_FIELDS.find(f => f.key === key);
		return known?.label ?? key;
	};

	const acceptLabel = isRegistered ? "Apply Changes" : "Accept Project";
	const acceptDisabled = !fields.name?.trim();

	const activeView = _projectProposalView;
	const onView = (m: ProjectViewMode) => { _projectProposalView = m; renderApp(); };

	const settingsView = html`
		<div data-testid="settings-view" class="flex flex-col gap-4">
			${renderRow("name", "Project Name")}
			<div data-field="root_path" data-readonly="true">
				<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Root Path</label>
				<div class="px-3 py-1.5 text-sm font-mono rounded-md border border-border bg-secondary/30 text-foreground/80 truncate" title=${fields.root_path || ""}>
					${fields.root_path || "—"}
				</div>
			</div>
			${curatedKeys.filter(k => k !== "name").map(k => renderRow(k, labelFor(k)))}
			${extraKeys.length > 0 ? html`
				<details data-testid="other-settings-group" class="border-t border-border pt-3">
					<summary class="text-xs text-muted-foreground cursor-pointer select-none font-medium">
						Other settings (${extraKeys.length})
					</summary>
					<p class="text-[11px] text-muted-foreground mt-2 mb-3">
						Non-standard project.yaml fields. The agent or a previous user added these; edit them here or remove the entry by clearing the value.
					</p>
					<div class="flex flex-col gap-4">
						${extraKeys.map(k => renderRow(k, k))}
					</div>
				</details>
			` : ""}
		</div>
	`;

	return html`
		<div class="flex-1 flex flex-col min-h-0 min-w-0 w-full overflow-hidden" data-panel="project-proposal" data-mode=${mode}>
			<div class="shrink-0 px-5 pt-4 pb-3 flex items-baseline gap-3 min-w-0">
				<div class="text-sm font-medium shrink-0">${fields.name || "(unnamed project)"}</div>
				${proposal.rev > 0 ? html`<span class="text-xs text-muted-foreground shrink-0" data-testid="proposal-panel-rev">rev ${proposal.rev}</span>` : ""}
				<div class="text-[11px] text-muted-foreground font-mono truncate min-w-0" title=${fields.root_path || ""}>${fields.root_path || ""}</div>
			</div>
			${projectViewTabs(activeView, onView, {
				components: structuredComponents.length,
				workflows: Object.keys(structuredWorkflows).length,
			})}
			<div ${ref(projectOuterScrollRef)} class="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-5 ${streaming ? STREAMING_BORDER : ""}">
				${activeView === "components"
					? projectComponentsView(structuredComponents)
					: activeView === "workflows"
					? projectWorkflowsView(structuredWorkflows, structuredComponents)
					: settingsView}
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${streaming ? streamingBadge() : ""}
				${Button({ variant: "ghost", onClick: handleDismiss, children: "Dismiss" })}
				<span data-testid="proposal-primary-submit">${Button({
					variant: "default",
					onClick: handleAccept,
					disabled: acceptDisabled || streaming,
					children: html`<span class="inline-flex items-center gap-1.5" data-testid="accept-label">${icon(FolderOpen, "sm")} ${acceptLabel}</span>`,
				})}</span>
			</div>
		</div>
	`;
}

function getAssistantPreviewPanel(type: string) {
	switch (type) {
		case "goal": return goalPreviewPanel();
		case "role": return rolePreviewPanel();
		case "tool": return toolPreviewPanel();
		case "staff": return staffPreviewPanel();
		case "project":
		case "project-scaffolding":
			return projectProposalPanel();
		default: return "";
	}
}

// ============================================================================
// GOAL PROPOSAL PANEL (non-assistant inline panel)
// ============================================================================

/** Module-level form state for the goal proposal panel. */
let _proposalTitle = "";
let _proposalCwd = "";
let _proposalSpec = "";
let _proposalWorkflowId = "general";
let _proposalSpecEditMode = false;
let _proposalCwdDropdownOpen = false;
let _proposalCwdHighlightIndex = -1;
let _proposalSaving = false;
let _proposalSandboxed = false;
let _proposalAutoStartTeam = true;
let _proposalEnabledOptionalSteps: string[] = [];
let _proposalInitializedFrom: string | null = null;

/** Sync module-level form state from the active goal proposal when it changes. */
function syncProposalFormState(): void {
	const proposal = state.activeProposals.goal?.fields as undefined | { title: string; spec: string; cwd?: string; workflow?: string; options?: string };
	if (!proposal) return;
	// Use a simple identity check to avoid re-initializing on every render
	const key = `${proposal.title}|${proposal.spec}|${proposal.cwd || ""}|${proposal.workflow || ""}|${proposal.options || ""}`;
	if (_proposalInitializedFrom === key) return;
	_proposalInitializedFrom = key;
	_proposalTitle = proposal.title;
	_proposalSpec = proposal.spec;
	// Preserve project rootPath when proposal doesn't specify cwd
	const proposalProject = state.previewProjectId ? state.projects.find(p => p.id === state.previewProjectId) : undefined;
	_proposalCwd = proposal.cwd || proposalProject?.rootPath || "";
	_proposalWorkflowId = proposal.workflow || "general";
	_proposalSpecEditMode = false;
	_proposalEnabledOptionalSteps = proposal.options
		? proposal.options.split(",").map(s => s.trim()).filter(Boolean)
		: [];
	_proposalSaving = false;
}

function goalProposalPanel() {
	syncProposalFormState();
	ensureWorkflowsLoaded(state.previewProjectId || undefined);
	ensureSandboxStatusLoaded();

	// Coerce the proposal's workflowId to one that actually exists in this
	// project. Brand-new projects (post #413 "No default workflow scaffold")
	// can have any subset of workflows — the proposal panel may have been
	// constructed with `workflow: "general"` from the assistant before the
	// project's workflows finished loading. Without this coercion the user
	// gets a 400 "Workflow not found: general" on Create. See
	// `coerceWorkflowId` in dialog-helpers.ts for the resolution rule.
	_proposalWorkflowId = coerceWorkflowId(_proposalWorkflowId, _cachedWorkflows);

	const handleCreateGoal = async () => {
		const trimmedTitle = _proposalTitle.trim();
		if (!trimmedTitle || _proposalSaving) return;
		if (!state.previewProjectId) {
			showConnectionError("No project selected for this goal", "The assistant session is not linked to a project. Dismiss this proposal and start a new goal from the + New Goal button.");
			return;
		}
		if (_cachedWorkflows.length === 0) {
			showConnectionError(
				"This project has no workflows configured",
				"Create at least one workflow under Settings → project tab → Workflows before accepting this goal proposal.",
			);
			return;
		}
		_proposalSaving = true;
		renderApp();

		try {
			const sandboxed = _proposalSandboxed;
			_proposalSandboxed = false;
			const autoStartTeam = _proposalAutoStartTeam;
			_proposalAutoStartTeam = true;
			const goal = await createGoal(trimmedTitle, _proposalCwd.trim(), {
				spec: _proposalSpec,
				workflowId: _proposalWorkflowId || undefined,
				sandboxed,
				projectId: state.previewProjectId || undefined,
				enabledOptionalSteps: _proposalEnabledOptionalSteps.length > 0 ? _proposalEnabledOptionalSteps : undefined,
				autoStartTeam,
			});
			delete state.activeProposals.goal;
			_proposalEnabledOptionalSteps = [];
			_proposalInitializedFrom = null;
			if (goal) {
				setHashRoute("goal-dashboard", goal.id, true);
			}
		} finally {
			_proposalSaving = false;
			renderApp();
		}
	};

	const handleDismiss = () => {
		const dismissed = state.activeProposals.goal?.fields as undefined | { title: string; spec: string; cwd?: string; workflow?: string; options?: string };
		delete state.activeProposals.goal;
		_proposalInitializedFrom = null;
		_proposalEnabledOptionalSteps = [];
		_proposalAutoStartTeam = true;
		// Persist dismiss so it survives reconnect
		const sid = activeSessionId();
		if (sid && dismissed) markProposalDismissed(sid, dismissed);
		// If preview tab still available, switch to it; otherwise back to chat
		if (state.isPreviewSession) {
			state.previewPanelActiveTab = "preview";
			if (state.previewPanelTab === "goal") state.previewPanelTab = "preview";
		} else {
			if (state.previewPanelTab === "goal") state.previewPanelTab = "chat";
		}
		renderApp();
	};

	return renderGoalForm({
		title: _proposalTitle,
		spec: _proposalSpec,
		cwd: _proposalCwd,
		workflowId: _proposalWorkflowId,
		sandboxed: _proposalSandboxed,
		specEditMode: _proposalSpecEditMode,
		enabledOptionalSteps: _proposalEnabledOptionalSteps,
		linkedProjectId: state.previewProjectId || undefined,
		onTitleChange: (e: Event) => { _proposalTitle = (e.target as HTMLInputElement).value; },
		onSpecChange: (e: Event) => { _proposalSpec = (e.target as HTMLTextAreaElement).value; },
		onCwdChange: (v) => { _proposalCwd = v; renderApp(); },
		onCwdSelect: (v) => { _proposalCwd = v; renderApp(); },
		onWorkflowChange: (e: Event) => { _proposalWorkflowId = (e.target as HTMLSelectElement).value; renderApp(); },
		onSandboxChange: (e: Event) => { _proposalSandboxed = (e.target as HTMLInputElement).checked; renderApp(); },
		onSpecEditToggle: () => { _proposalSpecEditMode = !_proposalSpecEditMode; renderApp(); },
		onOptionalStepsChange: (steps) => { _proposalEnabledOptionalSteps = steps; renderApp(); },
		autoStartTeam: _proposalAutoStartTeam,
		onAutoStartTeamChange: (e: Event) => { _proposalAutoStartTeam = (e.target as HTMLInputElement).checked; renderApp(); },
		cwdDropdownOpen: _proposalCwdDropdownOpen,
		cwdHighlightIndex: _proposalCwdHighlightIndex,
		onCwdToggle: (open) => { _proposalCwdDropdownOpen = open; renderApp(); },
		onCwdHighlight: (i) => { _proposalCwdHighlightIndex = i; },
		onCreate: handleCreateGoal,
		onDismiss: handleDismiss,
		saving: _proposalSaving,
		createDisabled: !_proposalTitle.trim() || _proposalSaving,
		streaming: isProposalStreaming("goal_proposal"),
	});
}

// ============================================================================
// PREVIEW THEME BRIDGE
// ============================================================================

/** Script injected into preview iframes to sync the app's theme, palette, and
 *  CSS custom properties into the iframe document. Observes changes so toggling
 *  dark/light mode or switching palettes updates the preview in real time. */
const PREVIEW_THEME_BRIDGE = `<script>
(function() {
	try {
		var root = document.documentElement;
		var parentRoot = parent.document.documentElement;
		var parentStyles = parent.getComputedStyle(parentRoot);

		function sync() {
			/* Mirror dark class */
			root.classList.toggle('dark', parentRoot.classList.contains('dark'));

			/* Mirror data-palette attribute */
			var palette = parentRoot.getAttribute('data-palette');
			if (palette) root.setAttribute('data-palette', palette);
			else root.removeAttribute('data-palette');

			/* Copy all CSS custom properties from the app stylesheet */
			var vars = [];
			try {
				for (var s = 0; s < parent.document.styleSheets.length; s++) {
					var sheet = parent.document.styleSheets[s];
					try {
						var rules = sheet.cssRules || sheet.rules;
						for (var r = 0; r < rules.length; r++) {
							var rule = rules[r];
							if (rule.style) {
								for (var i = 0; i < rule.style.length; i++) {
									var name = rule.style[i];
									if (name.startsWith('--')) vars.push(name);
								}
							}
						}
					} catch(e) { /* cross-origin sheet, skip */ }
				}
			} catch(e) {}

			/* Deduplicate and copy computed values */
			var seen = {};
			for (var v = 0; v < vars.length; v++) {
				if (seen[vars[v]]) continue;
				seen[vars[v]] = true;
				var val = parentStyles.getPropertyValue(vars[v]);
				if (val) root.style.setProperty(vars[v], val);
			}
		}

		/* Copy the app font stack */
		root.style.fontFamily = parentStyles.fontFamily;

		/* Initial sync */
		sync();

		/* Watch for class/attribute changes on the parent root element */
		var observer = new MutationObserver(sync);
		observer.observe(parentRoot, { attributes: true, attributeFilter: ['class', 'data-palette', 'style'] });
	} catch(e) { /* cross-origin or other error — degrade gracefully */ }
})();
<\/script>`;

// ============================================================================
// PREVIEW SWIPE (mobile)
// ============================================================================

/** Script injected into the preview iframe srcdoc to detect horizontal swipes
 *  and send position updates to the parent via postMessage.
 *  Only horizontal swipes are captured; all other gestures pass through normally. */
const PREVIEW_SWIPE_SCRIPT = `<script>
(function() {
	var startX = 0, startY = 0, captured = false, decided = false;
	document.addEventListener('touchstart', function(e) {
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
		captured = false;
		decided = false;
	}, {passive: true});
	document.addEventListener('touchmove', function(e) {
		if (decided && !captured) return;
		var dx = e.touches[0].clientX - startX;
		var dy = e.touches[0].clientY - startY;
		if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
			decided = true;
			captured = Math.abs(dx) > Math.abs(dy);
			if (captured) parent.postMessage({type:'preview-swipe-start'}, '*');
		}
		if (captured) {
			e.preventDefault();
			parent.postMessage({type:'preview-swipe-move', dx: dx}, '*');
		}
	}, {passive: false});
	document.addEventListener('touchend', function(e) {
		if (!captured) return;
		var dx = e.changedTouches[0].clientX - startX;
		parent.postMessage({type:'preview-swipe-end', dx: dx}, '*');
		captured = false;
		decided = false;
	}, {passive: true});
})();
<\/script>`;

/** Whether the unified panel is active for the current non-assistant session. */
function hasUnifiedPanel(): boolean {
	return !state.assistantType && (
		state.isPreviewSession ||
		state.activeProposals.goal != null ||
		state.activeProposals.project != null ||
		state.reviewPanelOpen
	);
}

/** Ordered list of available unified panel tabs for the current session. */
function unifiedPanelTabs(): Array<"chat" | "preview" | "goal" | "review" | "project"> {
	const tabs: Array<"chat" | "preview" | "goal" | "review" | "project"> = ["chat"];
	if (state.isPreviewSession) tabs.push("preview");
	if (state.reviewPanelOpen) tabs.push("review");
	if (state.activeProposals.goal != null) tabs.push("goal");
	if (state.activeProposals.project != null) tabs.push("project");
	return tabs;
}

/** Index of the current previewPanelTab within unifiedPanelTabs(). Clamps to valid range. */
function unifiedTabIndex(): number {
	const tabs = unifiedPanelTabs();
	const idx = tabs.indexOf(state.previewPanelTab);
	if (idx >= 0) return idx;
	state.previewPanelTab = tabs[tabs.length - 1];
	return tabs.length - 1;
}

/** Compute slider translateX% for the given tab index and pane count. */
function unifiedSlideX(index: number, count: number): number {
	if (count <= 1) return 0;
	return -(index * 100) / count;
}

/** Listen for postMessage from the preview iframe and drive the slider track.
 *  Also handles touch swipes on the chat / preview / goal panes. */
function setupPreviewSwipe(): void {
	if ((window as any).__previewSwipeListening) return;
	(window as any).__previewSwipeListening = true;

	const getTrack = () => document.querySelector(".preview-slider__track") as HTMLElement | null;

	// === iframe -> parent: swipe on preview pane ===
	window.addEventListener("message", (e: MessageEvent) => {
		if (!hasUnifiedPanel()) return;
		const tabs = unifiedPanelTabs();
		const curIdx = unifiedTabIndex();
		if (state.previewPanelTab !== "preview") return;
		const track = getTrack();
		if (!track) return;

		const paneW = track.parentElement!.clientWidth;
		const count = tabs.length;
		const baseX = unifiedSlideX(curIdx, count);

		if (e.data?.type === "preview-swipe-start") {
			track.style.transition = "none";
		} else if (e.data?.type === "preview-swipe-move") {
			const dx: number = e.data.dx;
			const dragPercent = (dx / paneW) * (100 / count);
			const target = Math.max(unifiedSlideX(count - 1, count), Math.min(0, baseX + dragPercent));
			track.style.transform = `translateX(${target}%)`;
		} else if (e.data?.type === "preview-swipe-end") {
			track.style.transition = "transform 0.3s ease-out";
			const dx: number = e.data.dx;
			const threshold = paneW * 0.2;
			let newIdx = curIdx;
			if (dx > threshold && curIdx > 0) newIdx = curIdx - 1;
			else if (dx < -threshold && curIdx < count - 1) newIdx = curIdx + 1;
			state.previewPanelTab = tabs[newIdx];
			track.style.transform = `translateX(${unifiedSlideX(newIdx, count)}%)`;
			renderApp();
		}
	});

	// === touch swipe on non-iframe panes (chat, goal) ===
	let startX = 0, startY = 0, captured = false, decided = false;
	const el = document.getElementById("app")!;

	el.addEventListener("touchstart", (e: TouchEvent) => {
		if (!hasUnifiedPanel() || state.assistantType) return;
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
		captured = false;
		decided = false;
	}, { passive: true });

	el.addEventListener("touchmove", (e: TouchEvent) => {
		if (!hasUnifiedPanel() || state.assistantType) return;
		if (decided && !captured) return;
		const dx = e.touches[0].clientX - startX;
		const dy = e.touches[0].clientY - startY;
		if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
			decided = true;
			const tabs = unifiedPanelTabs();
			const curIdx = unifiedTabIndex();
			if (dx < 0 && Math.abs(dx) > Math.abs(dy) && curIdx < tabs.length - 1) {
				captured = true;
			} else if (dx > 0 && Math.abs(dx) > Math.abs(dy) && curIdx > 0) {
				captured = true;
			}
			if (captured) {
				const track = getTrack();
				if (track) track.style.transition = "none";
			}
		}
		if (captured) {
			const track = getTrack();
			if (track) {
				const tabs = unifiedPanelTabs();
				const count = tabs.length;
				const curIdx = unifiedTabIndex();
				const baseX = unifiedSlideX(curIdx, count);
				const dragPercent = (dx / track.parentElement!.clientWidth) * (100 / count);
				const target = Math.max(unifiedSlideX(count - 1, count), Math.min(0, baseX + dragPercent));
				track.style.transform = `translateX(${target}%)`;
			}
		}
	}, { passive: true });

	el.addEventListener("touchend", (e: TouchEvent) => {
		if (!captured) return;
		const track = getTrack();
		if (track) {
			track.style.transition = "transform 0.3s ease-out";
			const dx = e.changedTouches[0].clientX - startX;
			const tabs = unifiedPanelTabs();
			const count = tabs.length;
			const curIdx = unifiedTabIndex();
			const threshold = track.parentElement!.clientWidth * 0.2;
			let newIdx = curIdx;
			if (dx < -threshold && curIdx < count - 1) newIdx = curIdx + 1;
			else if (dx > threshold && curIdx > 0) newIdx = curIdx - 1;
			state.previewPanelTab = tabs[newIdx];
			track.style.transform = `translateX(${unifiedSlideX(newIdx, count)}%)`;
		}
		captured = false;
		decided = false;
		renderApp();
	}, { passive: true });
}

// ============================================================================
// RENDER APP
// ============================================================================

function renderArchivedBanner() {
	const agent = state.remoteAgent;
	if (!agent?.state?.isArchived) return "";
	const archivedAt = agent.state.archivedAt;
	const dateStr = archivedAt ? new Date(archivedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "unknown date";
	return html`
		<div class="flex items-center justify-center gap-2 px-4 py-2 text-sm text-muted-foreground" style="background: var(--muted); border-bottom: 1px solid var(--border);">
			${icon(Archive, "sm")}
			<span>This session was archived on ${dateStr}</span>
		</div>
	`;
}

export function doRenderApp(): void {
	const app = document.getElementById("app");
	if (!app) return;

	// Dynamic page title
	const activeProject = state.projects.find(p => p.id === state.activeProjectId);
	document.title = activeProject ? `${activeProject.name} · Bobbit` : "Bobbit";

	document.documentElement.style.setProperty("--bobbit-shimmer-delay", `${-(Date.now() % 8000)}ms`);

	// Disconnected state
	if (state.appView === "disconnected") {
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0">
					<div class="flex items-center gap-2 px-4 py-1">
						${bobbitIcon}
						<span class="text-base font-semibold text-foreground">Bobbit</span>
					</div>
					<div class="flex items-center gap-1 px-2">
						${Button({
							variant: "ghost",
							size: "sm",
							children: html`<span class="inline-flex items-center gap-1">${icon(Server, "sm")} <span class="text-xs">Connect</span></span>`,
							onClick: openGatewayDialog,
							title: "Connect to gateway",
						})}
						<theme-toggle></theme-toggle>
					</div>
				</div>
				<div class="flex-1 flex flex-col items-center justify-center gap-6 p-8">
					<div class="flex flex-col items-center gap-3 text-center">
						<div class="text-muted-foreground empty-state-icon">${icon(Unplug, "lg")}</div>
						<h2 class="text-lg font-medium text-foreground">Not connected</h2>
						<p class="text-sm text-muted-foreground max-w-sm">
							Connect to a Bobbit gateway to start working with the coding agent.
						</p>
					</div>
					${Button({
						variant: "default",
						onClick: openGatewayDialog,
						children: html`<span class="inline-flex items-center gap-2">${icon(Server, "sm")} Connect to Gateway</span>`,
					})}
				</div>
			</div>
		`, app);
		return;
	}

	// Gateway starting — server not yet responsive, polling until ready
	if (state.appView === "gateway-starting") {
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0">
					<div class="flex items-center gap-2 px-4 py-1">
						${bobbitIcon}
						<span class="text-base font-semibold text-foreground">Bobbit</span>
					</div>
					<div class="flex items-center gap-1 px-2">
						<theme-toggle></theme-toggle>
					</div>
				</div>
				<div class="flex-1 min-h-0">${bobbitLoadingAnimation()}</div>
			</div>
		`, app);
		return;
	}

	// Authenticated state
	const desktop = isDesktop();
	const connected = hasActiveSession();

	// Session action buttons (shared between headerLeft mobile and headerRight desktop)
	const sessionTitle = connected && state.remoteAgent ? (state.remoteAgent.title || "New session") : "";
	const activeSid = activeSessionId();
	const activeStaffAgent = activeSid ? state.staffList.find(s => s.currentSessionId === activeSid) : undefined;
	const headerTitle = activeStaffAgent?.name ?? sessionTitle;
	const editLabel = activeStaffAgent ? "Edit" : "Modify";
	const activeSession = activeSid ? state.gatewaySessions.find(s => s.id === activeSid) : undefined;
	const isTeamLead = activeSession?.role === "team-lead";
	const editDeleteBtns = (connected && state.remoteAgent && activeSid) ? html`
		<div class="flex items-center gap-1 shrink-0">
			${Button({
				variant: "ghost",
				size: "sm",
				onClick: () => {
					import("../ui/dialogs/SystemPromptDialog.js").then(m => m.SystemPromptDialog.show(activeSid!));
				},
				children: html`<span class="inline-flex items-center gap-1">${icon(FileText, "xs")}<span class="text-xs hidden sm:inline">Prompt</span></span>`,
				className: "h-7 px-2 text-muted-foreground",
				title: "View System Prompt",
			})}
			${Button({
				variant: "ghost",
				size: "sm",
				onClick: () => {
					if (activeStaffAgent) {
						window.location.hash = `#/staff/${activeStaffAgent.id}`;
					} else {
						showRenameDialog(activeSid, sessionTitle);
					}
				},
				children: html`<span class="inline-flex items-center gap-1">${icon(Pencil, "xs")}<span class="text-xs hidden sm:inline">${editLabel}</span></span>`,
				className: "h-7 px-2 text-muted-foreground",
				title: activeStaffAgent ? "Edit staff agent" : "Modify session",
			})}
			${Button({
				variant: "ghost",
				size: "sm",
				onClick: () => terminateSession(activeSid),
				children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "xs")}<span class="text-xs hidden sm:inline">${isTeamLead ? "End Team" : "Terminate"}</span></span>`,
				className: "h-7 px-2 text-muted-foreground hover:text-destructive",
				title: isTeamLead ? "End team (Ctrl+Shift+D)" : "Terminate session (Ctrl+Shift+D)",
			})}
		</div>
	` : "";

	const headerLeft = () => {
		if (connected && state.remoteAgent) {
			const backBtn = !desktop ? Button({
				variant: "ghost",
				size: "sm",
				// Arrow-only back button (native mobile convention) — frees up
				// horizontal space for the session title between the back button
				// and the edit/delete action buttons on the right.
				children: html`${icon(ArrowLeft, "sm")}`,
				onClick: backToSessions,
				title: "Back to session list",
				className: "h-10 w-10 p-0",
			}) : "";

			if (!desktop) {
				const activeSession = activeSid ? state.gatewaySessions.find(s => s.id === activeSid) : undefined;
				const goalId = activeSession?.goalId || activeSession?.teamGoalId;
				const goalTitle = goalId ? state.goals.find(g => g.id === goalId)?.title : undefined;
				// Left-aligned title layout (flex row, not absolute-centered) so
				// the title claims every pixel between the back button and the
				// right-hand action buttons. On very narrow screens we drop one
				// step down in font size as a last-resort fallback.
				return html`
					<div class="flex items-center w-full pr-0.5 gap-1" style="min-height:40px;">
						<div class="shrink-0">${backBtn}</div>
						<div class="flex-1 min-w-0 flex flex-col justify-center">
							<span class="mobile-header-title font-medium text-foreground inline-flex items-center gap-1 min-w-0" title=${headerTitle}><span class="truncate">${headerTitle}</span>${activeSession?.sandboxed ? renderSandboxIndicator(activeSession.status) : ""}</span>
							${goalTitle ? html`<span class="text-[10px] text-muted-foreground/60 truncate uppercase tracking-wider">${goalTitle}</span>` : ""}
						</div>
						<div class="shrink-0">${editDeleteBtns}</div>
					</div>
				`;
			}
			const deskSession = activeSid ? state.gatewaySessions.find(s => s.id === activeSid) : undefined;
			const deskGoalId = deskSession?.goalId || deskSession?.teamGoalId;
			const deskGoalTitle = deskGoalId ? state.goals.find(g => g.id === deskGoalId)?.title : undefined;
			return html`
				<div class="flex items-center gap-2 px-3 min-w-0 flex-1">
					<div class="flex flex-col min-w-0 py-1">
						<span class="text-sm font-medium text-foreground inline-flex items-center gap-1 min-w-0" title=${headerTitle}><span class="truncate">${headerTitle}</span>${deskSession?.sandboxed ? renderSandboxIndicator(deskSession.status) : ""}</span>
						${deskGoalTitle ? html`<span class="text-[10px] text-muted-foreground/60 truncate uppercase tracking-wider">${deskGoalTitle}</span>` : ""}
					</div>
				</div>
			`;
		}

		if (!desktop) {
			return html`<div class="flex items-center gap-2 px-4 py-1">
				${bobbitIcon}
				<span class="text-base font-semibold text-foreground">Bobbit</span>
			</div>`;
		}
		return html`<div></div>`;
	};

	const headerRight = () => {
		if (desktop) {
			return editDeleteBtns ? html`<div class="flex items-center gap-1 px-2">${editDeleteBtns}</div>` : html``;
		}
		const settingsBtn = Button({
			variant: "ghost",
			size: "sm",
			children: html`${icon(Settings, "sm")}`,
			onClick: () => { import("./settings-page.js").then((m) => m.toggleSettings()); },
			title: "Settings",
		});
		if (connected && state.remoteAgent) {
			return html``;
		}
		return html`
			<div class="flex items-center gap-1 px-2">
				${settingsBtn}
				${Button({
					variant: "ghost",
					size: "sm",
					children: html`${icon(QrCode, "sm")}`,
					onClick: showQrCodeDialog,
					title: "Show QR code",
				})}
				<theme-toggle></theme-toggle>
			</div>
		`;
	};

	const reconnectBanner = () => {
		if (!connected || state.connectionStatus === "connected") return "";
		return html`
			<div class="reconnect-banner shrink-0 flex items-center justify-center gap-2 px-4 py-2 text-xs font-medium
				${state.connectionStatus === "reconnecting"
					? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
					: "bg-red-500/15 text-red-700 dark:text-red-400"}">
				${state.connectionStatus === "reconnecting"
					? html`
						<svg class="animate-spin shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
						</svg>
						<span>Reconnecting to server…</span>`
					: html`<span>Disconnected from server</span>`}
			</div>
		`;
	};

	const assistantTabBar = () => {
		if (!state.assistantType) return "";
		if (!getAssistantPreviewPanel(state.assistantType)) return "";
		return html`
			<div class="goal-tab-bar shrink-0 flex items-center gap-1 px-3 py-2 border-b border-border bg-background">
				<button
					class="goal-tab-pill ${state.assistantTab === "chat" ? "goal-tab-pill--active" : ""}"
					title="Chat"
					@click=${() => { state.assistantTab = "chat"; renderApp(); }}
				>Chat</button>
				<button
					class="goal-tab-pill ${state.assistantTab === "preview" ? "goal-tab-pill--active" : ""}"
					title="Preview"
					@click=${() => { state.assistantTab = "preview"; renderApp(); }}
				>
					Preview${state.assistantHasProposal ? html` <span class="goal-tab-dot"></span>` : ""}
				</button>
			</div>
		`;
	};

	const unifiedTabBar = () => {
		if (!hasUnifiedPanel()) return "";
		return html`
			<div class="goal-tab-bar shrink-0 flex items-center gap-1 px-3 py-2 border-b border-border bg-background">
				<button
					class="goal-tab-pill ${state.previewPanelTab === "chat" ? "goal-tab-pill--active" : ""}"
					title="Chat"
					@click=${() => { state.previewPanelTab = "chat"; renderApp(); }}
				>Chat</button>
				${state.isPreviewSession ? html`
					<button
						class="goal-tab-pill ${state.previewPanelTab === "preview" ? "goal-tab-pill--active" : ""}"
						title="Preview"
						@click=${() => { state.previewPanelTab = "preview"; renderApp(); }}
					>Preview</button>
				` : ""}
				${state.reviewPanelOpen ? html`
					<button
						class="goal-tab-pill ${state.previewPanelTab === "review" ? "goal-tab-pill--active" : ""}"
						title="Review"
						@click=${() => { state.previewPanelTab = "review"; renderApp(); }}
					>Review</button>
				` : ""}
				${state.activeProposals.goal != null ? html`
					<button
						class="goal-tab-pill ${state.previewPanelTab === "goal" ? "goal-tab-pill--active" : ""}"
						title="Goal"
						@click=${() => { state.previewPanelTab = "goal"; renderApp(); }}
					>Goal <span class="goal-tab-dot"></span></button>
				` : ""}
				${state.activeProposals.project != null ? html`
					<button
						class="goal-tab-pill ${state.previewPanelTab === "project" ? "goal-tab-pill--active" : ""}"
						title="Project"
						@click=${() => { state.previewPanelTab = "project"; renderApp(); }}
					>Project <span class="goal-tab-dot"></span></button>
				` : ""}
			</div>
		`;
	};

	const previewCollapseKey = () => `bobbit-preview-collapsed-${activeSessionId()}`;
	const isPreviewCollapsed = () => localStorage.getItem(previewCollapseKey()) === "true";
	const togglePreviewCollapse = () => {
		const next = !isPreviewCollapsed();
		localStorage.setItem(previewCollapseKey(), String(next));
		renderApp();
	};

	/** Render the HTML preview iframe content (no header — unified panel provides it). */
	const htmlPreviewContent = () => {
		return html`
			<div style="position:relative;flex:1;min-height:0;">
				<iframe
					class="w-full border-0"
					style="position:absolute;inset:0;height:100%;"
					sandbox="allow-scripts allow-same-origin"
					.srcdoc=${state.previewPanelHtml + PREVIEW_THEME_BRIDGE + PREVIEW_SWIPE_SCRIPT}
				></iframe>
			</div>
		`;
	};

	/** Unified preview panel with tab header + content dispatch.
	 *  Used on desktop for non-assistant sessions that have preview or goal proposal. */
	const reviewPaneContent = () => html`
		<div class="flex-1 min-h-0 overflow-auto">
			<review-pane
				.documents=${state.reviewDocuments}
				.activeTab=${state.reviewActiveTab}
				.sessionId=${activeSessionId() || ""}
				@review-tab-change=${(e: CustomEvent) => { state.reviewActiveTab = e.detail.title; renderApp(); }}
				@review-submit=${async (e: CustomEvent) => {
					const agent = state.remoteAgent;
					if (agent) {
						agent.prompt(e.detail.feedback);
						const sid = activeSessionId() || "";
						clearAllAnnotations(sid);
						markReviewSubmitted(sid);
						await flushPendingWrites();
						state.reviewDocuments = new Map();
						state.reviewPanelOpen = false;
						state.reviewActiveTab = "";
						renderApp();
					}
				}}
			@review-close-tab=${(e: CustomEvent) => {
					const sid = activeSessionId() || "";
					const title = e.detail.title as string;
					clearAnnotations(sid, title);
					state.reviewDocuments = new Map(state.reviewDocuments);
					state.reviewDocuments.delete(title);
					if (state.reviewActiveTab === title) {
						const keys = [...state.reviewDocuments.keys()];
						state.reviewActiveTab = keys[0] || "";
					}
					state.reviewPanelOpen = state.reviewDocuments.size > 0;
					renderApp();
				}}
				@review-dismiss=${() => {
					const sid = activeSessionId() || "";
					clearAllAnnotations(sid);
					markReviewSubmitted(sid);
					state.reviewDocuments = new Map();
					state.reviewPanelOpen = false;
					state.reviewActiveTab = "";
					renderApp();
				}}
			></review-pane>
		</div>
	`;

	const unifiedPreviewPanel = () => {
		// Auto-correct tab if the active tab's content is no longer available
		if (state.previewPanelActiveTab === "review" && !state.reviewPanelOpen) {
			state.previewPanelActiveTab = state.isPreviewSession ? "preview" : (state.activeProposals.goal != null ? "goal" : (state.activeProposals.project != null ? "project" : "preview"));
		} else if (state.previewPanelActiveTab === "preview" && !state.isPreviewSession && state.activeProposals.goal != null) {
			state.previewPanelActiveTab = "goal";
		} else if (state.previewPanelActiveTab === "goal" && state.activeProposals.goal == null && state.isPreviewSession) {
			state.previewPanelActiveTab = "preview";
		} else if (state.previewPanelActiveTab === "project" && state.activeProposals.project == null) {
			state.previewPanelActiveTab = state.isPreviewSession ? "preview"
				: (state.activeProposals.goal != null ? "goal"
				: (state.reviewPanelOpen ? "review" : "preview"));
		}

		const showPreviewTab = state.isPreviewSession;
		const showGoalTab = state.activeProposals.goal != null;
		const showReviewTab = state.reviewPanelOpen;
		const showProjectTab = state.activeProposals.project != null;

		return html`
			<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
				<!-- Tab header -->
				<div class="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
					<div class="flex items-center gap-1">
						${showPreviewTab ? html`
							<button
								class="goal-tab-pill ${state.previewPanelActiveTab === "preview" ? "goal-tab-pill--active" : ""}"
								title="Preview"
								@click=${() => { state.previewPanelActiveTab = "preview"; renderApp(); }}
							>Preview</button>
						` : ""}
						${showReviewTab ? html`
							<button
								class="goal-tab-pill ${state.previewPanelActiveTab === "review" ? "goal-tab-pill--active" : ""}"
								title="Review"
								@click=${() => { state.previewPanelActiveTab = "review"; renderApp(); }}
							>Review</button>
						` : ""}
						${showGoalTab ? html`
							<button
								class="goal-tab-pill ${state.previewPanelActiveTab === "goal" ? "goal-tab-pill--active" : ""}"
								title="Goal"
								@click=${() => { state.previewPanelActiveTab = "goal"; renderApp(); }}
							>Goal <span class="goal-tab-dot"></span></button>
						` : ""}
						${showProjectTab ? html`
							<button
								class="goal-tab-pill ${state.previewPanelActiveTab === "project" ? "goal-tab-pill--active" : ""}"
								title="Project"
								@click=${() => { state.previewPanelActiveTab = "project"; renderApp(); }}
							>Project <span class="goal-tab-dot"></span></button>
						` : ""}
					</div>
					<div class="flex items-center gap-0.5">
						${showPreviewTab ? html`
						<button @click=${() => { state.previewPanelFullscreen = true; renderApp(); }} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;" title="Fullscreen preview">
							${icon(Maximize2, "sm")}
						</button>` : ""}
						<button @click=${togglePreviewCollapse} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;" title="Collapse preview (Ctrl+])">
							${icon(PanelRightClose, "sm")}
						</button>
					</div>
				</div>
				<!-- Tab content -->
				${state.previewPanelActiveTab === "review" && showReviewTab
					? reviewPaneContent()
					: state.previewPanelActiveTab === "preview" && showPreviewTab
						? htmlPreviewContent()
						: state.previewPanelActiveTab === "goal" && showGoalTab
							? goalProposalPanel()
							: state.previewPanelActiveTab === "project" && showProjectTab
								? projectProposalPanel()
								: ""}
			</div>
		`;
	};

	const previewExpandButton = () => html`
		<button @click=${togglePreviewCollapse} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:6px 4px;border-left:1px solid var(--border);align-self:stretch;display:flex;align-items:center;" title="Expand preview (Ctrl+])">
			${icon(PanelRightOpen, "sm")}
		</button>
	`;
	/** Render individual pane content for mobile slider. */
	const mobilePaneContent = (tab: "chat" | "preview" | "goal" | "review" | "project") => {
		if (tab === "chat") return state.chatPanel;
		if (tab === "preview" && state.isPreviewSession) {
			return html`<div class="goal-preview-panel flex-1 flex flex-col min-h-0">${htmlPreviewContent()}</div>`;
		}
		if (tab === "review" && state.reviewPanelOpen) {
			return html`<div class="goal-preview-panel flex-1 flex flex-col min-h-0">${reviewPaneContent()}</div>`;
		}
		if (tab === "goal" && state.activeProposals.goal != null) {
			return html`<div class="goal-preview-panel flex-1 flex flex-col min-h-0">${goalProposalPanel()}</div>`;
		}
		if (tab === "project" && state.activeProposals.project != null) {
			return html`<div class="goal-preview-panel flex-1 flex flex-col min-h-0">${projectProposalPanel()}</div>`;
		}
		return html``;
	};

	const mainArea = () => {
		// Goal dashboard route
		const route = getRouteFromHash();
		if (route.view === "goal-dashboard" && route.goalId) {
			return renderGoalDashboard();
		}
		if (route.view === "roles" || route.view === "role-edit") {
			return renderRoleManagerPage();
		}
		if (route.view === "tools" || route.view === "tool-edit") {
			return renderToolManagerPage();
		}
		if (route.view === "workflows" || route.view === "workflow-edit") {
			return renderWorkflowPage();
		}
		if (route.view === "staff" || route.view === "staff-edit") {
			return renderStaffPage();
		}
		if (route.view === "skills") {
			return renderSkillsPage();
		}
		if (route.view === "settings") {
			return renderSettingsPage();
		}
		if (route.view === "search") {
			initSearchPage();
			return renderSearchPage();
		} else {
			resetSearchPage();
		}

		if (connected && state.assistantType) {
			const previewPanel = getAssistantPreviewPanel(state.assistantType);
			if (!previewPanel) {
				// No preview panel — use full-width chat
				return html`
					${reconnectBanner()}
					<div class="flex-1 flex flex-col min-h-0">${state.chatPanel}</div>
				`;
			}
			if (desktop) {
				return html`
					${reconnectBanner()}
					<div class="flex-1 flex min-h-0 overflow-hidden">
						<div class="goal-chat-panel flex-1 min-w-0 flex flex-col">${state.chatPanel}</div>
						${previewPanel}
					</div>
				`;
			}
			const aSlideX = state.assistantTab === "chat" ? 0 : -50;
			return html`
				${reconnectBanner()}
				<div class="assistant-slider flex-1 min-h-0" style="overflow:hidden;position:relative;">
					<div class="assistant-slider__track" style="display:flex;width:200%;height:100%;transform:translateX(${aSlideX}%);transition:transform 0.3s ease-out;will-change:transform;">
						<div style="width:50%;height:100%;min-width:0;display:flex;flex-direction:column;">${state.chatPanel}</div>
						<div style="width:50%;height:100%;min-width:0;display:flex;flex-direction:column;">${previewPanel}</div>
					</div>
				</div>
			`;
		}
		if (connected && hasUnifiedPanel()) {
			if (desktop && state.previewPanelFullscreen && state.isPreviewSession) {
				return html`
					${reconnectBanner()}
					<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
						<!-- Fullscreen preview header -->
						<div class="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0" style="background:var(--color-background, hsl(var(--background)));">
							<span class="text-xs font-medium text-muted-foreground">Preview</span>
							<button @click=${() => { state.previewPanelFullscreen = false; renderApp(); }} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:2px;" title="Exit fullscreen (Esc)">
								${icon(Minimize2, "sm")}
							</button>
						</div>
						<!-- Preview iframe fills available space -->
						<div style="position:relative;flex:1;min-height:0;">
							<iframe
								class="w-full border-0"
								style="position:absolute;inset:0;height:100%;"
								sandbox="allow-scripts allow-same-origin"
								.srcdoc=${state.previewPanelHtml + PREVIEW_THEME_BRIDGE + PREVIEW_SWIPE_SCRIPT}
							></iframe>
						</div>
						<!-- Compact prompt bar at bottom -->
						<div class="preview-fullscreen-prompt shrink-0 border-t border-border">
							${state.chatPanel}
						</div>
					</div>
				`;
			}
			if (desktop) {
				const collapsed = isPreviewCollapsed();
				return html`
					${reconnectBanner()}
					<div class="flex-1 flex min-h-0 overflow-hidden">
						<div class="${collapsed ? 'flex-1' : 'goal-chat-panel flex-1'} min-w-0 flex flex-col">${state.chatPanel}</div>
						${collapsed ? previewExpandButton() : unifiedPreviewPanel()}
					</div>
				`;
			}
			const tabs = unifiedPanelTabs();
			const count = tabs.length;
			const curIdx = unifiedTabIndex();
			const slideX = unifiedSlideX(curIdx, count);
			const trackW = count * 100;
			const paneW = 100 / count;
			return html`
				${reconnectBanner()}
				<div class="preview-slider flex-1 min-h-0" style="overflow:hidden;position:relative;">
					<div class="preview-slider__track" style="display:flex;width:${trackW}%;height:100%;transform:translateX(${slideX}%);transition:transform 0.3s ease-out;will-change:transform;">
						${tabs.map(tab => html`<div style="width:${paneW}%;height:100%;min-width:0;display:flex;flex-direction:column;">${mobilePaneContent(tab)}</div>`)}
					</div>
				</div>
			`;
		}
		if (connected) return html`${reconnectBanner()}${renderArchivedBanner()}${state.chatPanel}`;

		// Show bouncing bobbit while connecting or creating a session
		if (state.connectingSessionId || state.creatingSession) {
			return html`<div class="flex-1 min-h-0">${bobbitLoadingAnimation()}</div>`;
		}

		if (desktop) {
			return html`
				<div class="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
					<div class="text-muted-foreground empty-state-icon">${icon(Server, "lg")}</div>
					<p class="text-sm text-muted-foreground">Select a session from the sidebar or create a new one</p>
					${Button({
						variant: "default",
						size: "sm",
						disabled: state.creatingSession,
						onClick: () => createAndConnectSession(),
						children: state.creatingSession
							? html`<span class="inline-flex items-center gap-1.5"><svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg> Creating…</span>`
							: html`<span class="inline-flex items-center gap-1.5">${icon(Plus, "sm")} New Session</span>`,
					})}
				</div>
			`;
		}
		return renderMobileLanding();
	};

	if (desktop) {
		teardownMobileScrollTracking();
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center border-b border-border shrink-0 header-shadow">
					${state.sidebarCollapsed ? html`
					<div class="w-14 shrink-0 flex items-center justify-center self-stretch" style="background: var(--sidebar);">
						${bobbitIcon}
					</div>
					` : html`
					<div class="shrink-0 flex items-center justify-between px-3 self-stretch" style="background: var(--sidebar); width: var(--sidebar-w, 240px);">
						<div class="flex items-center gap-2">
							${bobbitIcon}
							<span class="text-base font-semibold text-foreground">Bobbit</span>
						</div>
						<div class="flex items-center" style="gap:1px;margin-right:-4px">
							${Button({
								variant: "ghost",
								size: "sm",
								children: html`${icon(QrCode, "xs")}`,
								onClick: showQrCodeDialog,
								title: "Show QR code",
								className: "h-6 w-6 text-muted-foreground",
							})}
							<theme-toggle></theme-toggle>
						</div>
					</div>
					`}
					<div class="flex-1 flex items-center justify-between min-w-0">
						${headerLeft()}
						${headerRight()}
					</div>
				</div>
				<div class="flex-1 flex min-h-0">
					${renderSidebar()}
					<div id="app-main" class="flex-1 min-w-0 min-h-0 flex flex-col">
						${mainArea()}
					</div>
				</div>
			</div>
		`, app);
	} else if (connected) {
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden relative"
				data-mobile-header>
				<div id="app-header"
					class="fixed top-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-sm border-b border-border flex flex-col header-shadow">
					<div class="flex items-center justify-between">
						${headerLeft()}
						${headerRight()}
					</div>
					${state.assistantType ? assistantTabBar() : ""}
					${hasUnifiedPanel() ? unifiedTabBar() : ""}
				</div>
				<div id="app-main" class="flex-1 min-w-0 min-h-0 flex flex-col">${mainArea()}</div>
			</div>
		`, app);
		ensureMobileScrollTracking();
		setupPreviewSwipe();
		requestAnimationFrame(() => {
			const headerEl = document.getElementById("app-header");
			if (headerEl) {
				const h = headerEl.offsetHeight;
				document.documentElement.style.setProperty("--mobile-header-height", `${h + 8}px`);
			}
		});
	} else {
		render(html`
			<div class="w-full app-shell flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0 header-shadow">
					${headerLeft()}
					${headerRight()}
				</div>
				<div id="app-main" class="flex-1 min-h-0 flex flex-col">${mainArea()}</div>
			</div>
		`, app);
	}
}
