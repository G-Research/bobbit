import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { Archive, ArrowLeft, FileText, FolderOpen, FolderPlus, MessagesSquare, ChevronDown, Drama, Goal as GoalIcon, PanelRightClose, PanelRightOpen, Pencil, Plus, QrCode, Server, Settings, Trash2, Unplug, UserCheck, Users, WandSparkles, Workflow as WorkflowIcon, Wrench, Zap } from "lucide";
import {
	state,
	renderApp,
	isDesktop,
	hasActiveSession,
	activeSessionId,
	ungroupedExpanded,
	setUngroupedExpanded,

	resetArchivedExpandState,
	getSidebarData,
	setSearchContentMode,
} from "./state.js";
import { createGoal, createRole, gatewayFetch, refreshSessions, dismissSetup, fetchSandboxStatus } from "./api.js";
import { clearSessionModel } from "./routing.js";
import { backToSessions, createAndConnectSession, terminateSession, saveGoalDraft, deleteGoalDraft, saveRoleDraft, deleteRoleDraft, markProposalDismissed } from "./session-manager.js";
import { openGatewayDialog, showQrCodeDialog, showRenameDialog, showGoalDialog, showProjectDialog } from "./dialogs.js";
import { renderSidebar, toggleRolePicker, renderRolePickerDropdown, renderStaffSidebarSection, renderSetupBanner, launchSetupWizard, isSetupWizardActive, isProjectExpanded, toggleProjectExpanded } from "./sidebar.js";
import { searchApi, fetchArchivedGoalsPaginated, fetchArchivedSessionsPaginated } from "./api.js";
// Register search web components
import "../ui/components/SearchBox.js";
import "../ui/components/SearchResults.js";

import { renderGoalGroup, renderSessionRow, renderArchivedSessionRow, renderArchivedDelegates, renderSandboxIndicator, INDENT, getProjectAccentColor } from "./render-helpers.js";

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

function skipSetup(): void {
	dismissSetup();
}

import { cwdCombobox } from "./cwd-combobox.js";

import { teardownMobileScrollTracking, ensureMobileScrollTracking } from "./mobile-header.js";
import { getRouteFromHash, setHashRoute, isRouteActive, toggleConfigPage } from "./routing.js";
import { renderGoalDashboard } from "./goal-dashboard.js";
import "./goal-dashboard.css";
import { renderRoleManagerPage } from "./role-manager-page.js";
import "./role-manager.css";
import { renderToolManagerPage } from "./tool-manager-page.js";
import "./tool-manager.css";
import { renderWorkflowPage } from "./workflow-page.js";
import "./workflow-page.css";
import { renderPersonalityManagerPage } from "./personality-manager-page.js";
import "./personality-manager.css";
import { renderStaffPage } from "./staff-page.js";
import { renderSkillsPage } from "./skills-page.js";
import { renderSettingsPage } from "./settings-page.js";
import { renderSearchPage, initSearchPage, resetSearchPage } from "./search-page.js";

// ============================================================================
// MOBILE LANDING PAGE
// ============================================================================

/** Compact session row for mobile — mirrors sidebar row with always-visible buttons */

// Mobile search handlers (shared logic with sidebar but separate scope)
async function _handleMobileSearchInput(query: string): Promise<void> {
	state.searchQuery = query;
	if (!query.trim()) {
		state.searchResults = null;
		state.searchLoading = false;
		renderApp();
		return;
	}
	// When content mode is off, just set the query for client-side title filtering
	if (!state.searchContentMode) {
		state.searchResults = null;
		state.searchLoading = false;
		renderApp();
		return;
	}
	// Content mode: use FTS API
	state.searchLoading = true;
	renderApp();
	const data = await searchApi(query);
	if (state.searchQuery !== query) return;
	state.searchResults = data.results;
	state.searchLoading = false;
	renderApp();
}

function _handleMobileSearchClear(): void {
	state.searchQuery = "";
	state.searchResults = null;
	state.searchLoading = false;
	renderApp();
}

function _handleMobileResultClick(detail: { type: string; id: string; sessionId?: string; goalId?: string }): void {
	state.searchQuery = "";
	state.searchResults = null;
	state.searchLoading = false;
	if (detail.type === "goal" && detail.id) {
		import("./routing.js").then(m => m.setHashRoute("goal-dashboard", detail.id, true));
	} else if (detail.type === "session" && detail.id) {
		import("./session-manager.js").then(m => m.connectToSession(detail.id, true));
	} else if (detail.type === "message" && detail.sessionId) {
		const sid = detail.sessionId;
		import("./session-manager.js").then(m => m.connectToSession(sid, true));
	}
	renderApp();
}

function renderMobileLanding() {
	const sidebarData = getSidebarData();
	let { ungroupedSessions, liveGoals } = sidebarData;
	const { archivedGoals } = sidebarData;

	// Client-side title filtering for mobile (title-only mode)
	if (state.searchQuery && !state.searchContentMode) {
		const q = state.searchQuery.toLowerCase();
		liveGoals = liveGoals.filter(goal => {
			const goalMatches = goal.title.toLowerCase().includes(q);
			const goalSessions = state.gatewaySessions.filter(s => (s.goalId === goal.id || s.teamGoalId === goal.id) && !s.delegateOf);
			const hasMatchingSession = goalSessions.some(s => s.title?.toLowerCase().includes(q));
			return goalMatches || hasMatchingSession;
		});
		ungroupedSessions = ungroupedSessions.filter(s => s.title?.toLowerCase().includes(q));
	}

	const isUngroupedExpanded = ungroupedExpanded;

	return html`
		<div class="flex-1 flex flex-col overflow-y-auto">
			<div class="w-full max-w-xl mx-auto px-2 py-4 pb-16 flex flex-col gap-1">
				<div class="flex flex-col gap-1 px-1 pb-2 mb-1 border-b border-border/30">
					${(() => {
						const isRolesActive = isRouteActive("roles", "role-edit");
						const isPersonalitiesActive = isRouteActive("personalities", "personality-edit");
						const isToolsActive = isRouteActive("tools", "tool-edit");
						const isWorkflowsActive = isRouteActive("workflows", "workflow-edit");
						const isSkillsActive = isRouteActive("skills");
						return html`
					<div class="flex items-center gap-1">
						<button class="flex-1 text-sm px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isRolesActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}"
							title="Manage roles"
							@click=${() => toggleConfigPage(["roles", "role-edit"], () => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); setHashRoute("roles"); })}>
							${icon(Users, "xs")} Roles
						</button>
						<button class="flex-1 text-sm px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isPersonalitiesActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}"
							title="Manage personalities"
							@click=${() => toggleConfigPage(["personalities", "personality-edit"], () => { import("./personality-manager-page.js").then((m) => m.loadPersonalityPageData()); setHashRoute("personalities"); })}>
							${icon(Drama, "xs")} Personalities
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
							@click=${() => toggleConfigPage(["workflows", "workflow-edit"], () => { import("./workflow-page.js").then((m) => m.loadWorkflowPageData()); setHashRoute("workflows"); })}>
							${icon(WorkflowIcon, "xs")} Workflows
						</button>
						<button class="flex-1 text-sm px-1.5 py-1 rounded transition-colors flex items-center justify-center gap-1 ${isSkillsActive ? 'text-primary bg-primary/10 font-medium' : 'text-muted-foreground active:bg-secondary/50'}"
							title="View skills"
							@click=${() => toggleConfigPage(["skills"], () => { import("./skills-page.js").then((m) => m.loadSkillsPageData()); setHashRoute("skills"); })}>
							${icon(Zap, "xs")} Skills
						</button>
						<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
							@click=${() => showGoalDialog()}
							title="New goal (Alt+G)">
							${icon(GoalIcon, "xs")} New Goal
						</button>
					</div>
					`;
					})()}
				</div>
				${renderSetupBanner(true)}
				<search-box
					.query=${state.searchQuery}
					.loading=${state.searchLoading}
					.contentMode=${state.searchContentMode}
					.showControls=${!!state.searchQuery}
					@search-input=${(e: CustomEvent) => { _handleMobileSearchInput(e.detail.query); }}
					@search-clear=${() => { _handleMobileSearchClear(); }}
					@search-mode-change=${(e: CustomEvent) => {
						setSearchContentMode(e.detail.contentSearch);
						// Re-trigger search with new mode
						if (state.searchQuery) _handleMobileSearchInput(state.searchQuery);
					}}
					@full-search-click=${(e: CustomEvent) => { setHashRoute("search", e.detail.query); }}
				></search-box>
				${state.searchQuery && state.searchContentMode ? html`
					<search-results
						.results=${state.searchResults || []}
						.loading=${state.searchLoading}
						.query=${state.searchQuery}
						@result-click=${(e: CustomEvent) => { _handleMobileResultClick(e.detail); }}
					></search-results>
				` : state.sessionsLoading
					? html`<div class="text-center py-12 text-muted-foreground text-xs">Loading…</div>`
					: state.sessionsError
						? html`<div class="text-center py-12">
								<p class="text-xs text-red-500 mb-3">${state.sessionsError}</p>
								<button class="text-xs text-muted-foreground underline" title="Retry" @click=${refreshSessions}>Retry</button>
							</div>`
						: state.goals.length === 0 && state.gatewaySessions.length === 0
							? (!state.setupComplete && !isSetupWizardActive())
								? html`<div class="text-center py-12">
										<div class="text-muted-foreground mb-3 empty-state-icon">${icon(WandSparkles, "lg")}</div>
										<p class="text-lg font-medium text-foreground mb-1">Welcome to Bobbit</p>
										<p class="text-sm text-muted-foreground mb-4">Set up your project to get the best results from AI agents</p>
										${Button({
											variant: "default",
											onClick: () => launchSetupWizard(),
											children: html`<span class="inline-flex items-center gap-1.5">${icon(WandSparkles, "sm")} Start Setup</span>`,
										})}
										<button class="block mx-auto mt-3 text-xs text-muted-foreground hover:underline cursor-pointer bg-transparent border-none" @click=${skipSetup}>Skip setup</button>
									</div>`
								: html`<div class="text-center py-12">
									<div class="text-muted-foreground mb-3 empty-state-icon">${icon(Server, "lg")}</div>
									<p class="text-base text-muted-foreground mb-4">No goals or sessions yet</p>
									<div class="flex items-center justify-center gap-2">
										${Button({
											variant: "default",
											onClick: () => showGoalDialog(),
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
									const multiProject = state.projects.length > 1;
									if (multiProject) {
										// Group goals and sessions by project
										const projectMap = new Map<string, { goals: typeof liveGoals; sessions: typeof ungroupedSessions }>();
										for (const p of state.projects) projectMap.set(p.id, { goals: [], sessions: [] });
										const defaultId = state.projects[0]?.id || "";
										for (const g of liveGoals) {
											const pid = g.projectId || defaultId;
											const bucket = projectMap.get(pid) || projectMap.get(defaultId)!;
											bucket.goals.push(g);
										}
										for (const s of ungroupedSessions) {
											const pid = s.projectId || defaultId;
											const bucket = projectMap.get(pid) || projectMap.get(defaultId)!;
											bucket.sessions.push(s);
										}
										return html`${state.projects.map((project, i) => {
											const data = projectMap.get(project.id) || { goals: [], sessions: [] };
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
															@click=${(e: Event) => { e.stopPropagation(); setHashRoute("settings", `${project.id}/project`); }}
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
																	<path d="M5 1V9M1 5H9" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round"/>
																</svg>
															</span>
														</button>
													</div>
												</div>
												${expanded ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
													${data.goals.map((goal, gi) => html`
														${gi > 0 ? html`<div class="border-t border-border/30 my-0.5 mx-2"></div>` : ""}
														${renderGoalGroup(goal)}
													`)}
													${data.goals.length > 0 ? html`<div class="border-t border-border/30 my-0.5 mx-2"></div>` : ""}
													<div class="flex flex-col gap-0.5">
														<div class="flex items-center gap-1.5 pl-0 pr-2 py-1.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
															@click=${() => { setUngroupedExpanded(!ungroupedExpanded); renderApp(); }}>
															<span class="text-sm text-muted-foreground shrink-0 select-none" style="width:14px;text-align:center;">${isUngroupedExpanded ? "▾" : "▸"}</span>
															<span class="shrink-0 text-muted-foreground">${icon(MessagesSquare, "sm")}</span>
															<span class="flex-1 text-sm text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
															<div class="flex items-center relative">
																<button
																	class="p-2 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
																	@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(undefined, undefined, undefined, project.rootPath, undefined, undefined, project.id); }}
																	title="New session in ${project.name}"
																>${icon(Plus, "sm")}</button>
																<button
																	class="p-1.5 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
																	@click=${(e: Event) => { e.stopPropagation(); toggleRolePicker(e); }}
																	title="New session with role"
																>${icon(ChevronDown, "sm")}</button>
																${renderRolePickerDropdown()}
															</div>
														</div>
														${isUngroupedExpanded && data.sessions.length > 0 ? html`
															<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
																${data.sessions.map(renderSessionRow)}
															</div>
														` : ""}
													</div>
												</div>` : ""}
											`;
										})}`;
									}
									// Single project — flat layout
									return html`
										${liveGoals.map((goal, i) => html`
											${i > 0 ? html`<div class="border-t border-border/30 my-1 mx-2"></div>` : ""}
											${renderGoalGroup(goal)}
										`)}
										${liveGoals.length > 0 ? html`
											<div class="border-t border-border/30 my-1 mx-2"></div>
											<div class="flex flex-col gap-0.5">
												<div class="flex items-center gap-1.5 pl-0 pr-2 py-1.5 rounded-md cursor-pointer active:bg-secondary/50 transition-colors"
													@click=${() => { setUngroupedExpanded(!ungroupedExpanded); renderApp(); }}>
													<span class="text-sm text-muted-foreground shrink-0 select-none" style="width:14px;text-align:center;">${isUngroupedExpanded ? "▾" : "▸"}</span>
													<span class="shrink-0 text-muted-foreground">${icon(MessagesSquare, "sm")}</span>
												<span class="flex-1 text-sm text-muted-foreground uppercase tracking-wider font-medium">Sessions</span>
													<div class="flex items-center relative">
														<button
															class="p-2 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
															@click=${(e: Event) => { e.stopPropagation(); createAndConnectSession(); }}
															title="New session"
														>${state.creatingSession && !state.creatingSessionForGoalId
															? html`<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
															: icon(Plus, "sm")}</button>
														<button
															class="p-1.5 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
															@click=${toggleRolePicker}
															title="New session with role"
														>${icon(ChevronDown, "sm")}</button>
														${renderRolePickerDropdown()}
													</div>
												</div>
												${isUngroupedExpanded ? html`<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">${ungroupedSessions.map(renderSessionRow)}</div>` : ""}
											</div>
										` : ungroupedSessions.length > 0 ? html`
											<div class="flex flex-col gap-0.5">
												<div class="flex items-center gap-1.5 pl-0 pr-2 py-1.5">
													<span class="flex-1 text-sm text-muted-foreground uppercase tracking-wider font-medium flex items-center gap-1.5" style="padding-left:${INDENT}px;"><span class="shrink-0">${icon(MessagesSquare, "sm")}</span> Sessions</span>
													<div class="flex items-center relative">
														<button
															class="p-2 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
															@click=${() => createAndConnectSession()}
															title="New session"
														>${state.creatingSession && !state.creatingSessionForGoalId
															? html`<svg class="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
															: icon(Plus, "sm")}</button>
														<button
															class="p-1.5 rounded text-muted-foreground active:bg-secondary/50 transition-colors"
															@click=${toggleRolePicker}
															title="New session with role"
														>${icon(ChevronDown, "sm")}</button>
														${renderRolePickerDropdown()}
													</div>
												</div>
												<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">${ungroupedSessions.map(renderSessionRow)}</div>
											</div>
										` : ""}
									`;
								})()}
								${renderStaffSidebarSection()}
								${(() => {
									const standaloneArchived = state.showArchived ? state.archivedSessions.filter(s => !s.teamGoalId && !s.delegateOf) : [];
									return state.showArchived ? html`
										<div class="border-t border-border/30 my-1 mx-2"></div>
										<div class="flex flex-col gap-0.5">
											<div class="flex items-center gap-1.5 pl-1 pr-2 py-1.5">
												<span class="shrink-0 text-muted-foreground opacity-60">${icon(Archive, "sm")}</span>
												<span class="flex-1 text-sm text-muted-foreground uppercase tracking-wider font-medium opacity-60">Archived${(state.archivedGoalsTotal + state.archivedSessionsTotal) > 0 ? ` (${state.archivedGoalsTotal + state.archivedSessionsTotal})` : ""}</span>
											</div>
											${archivedGoals.length > 0 ? html`<div class="flex items-center gap-2 my-1 mx-2"><div class="flex-1 border-t border-border/30"></div><span class="text-[9px] text-muted-foreground uppercase tracking-wider opacity-50">Goals</span><div class="flex-1 border-t border-border/30"></div></div>` : ""}
											<div class="flex flex-col gap-0.5" style="padding-left:${INDENT / 2}px;">
												${archivedGoals.map(goal => html`
													<div class="opacity-60">${renderGoalGroup(goal)}</div>
												`)}
											</div>
											${state.archivedGoalsHasMore ? html`
												<button class="text-xs text-primary hover:underline px-2 py-1" @click=${() => { fetchArchivedGoalsPaginated(50, state.archivedGoalsCursor ?? undefined); }}>Load more goals…</button>
											` : ""}
											${archivedGoals.length > 0 && standaloneArchived.length > 0 ? html`<div class="flex items-center gap-2 my-1 mx-2"><div class="flex-1 border-t border-border/30"></div><span class="text-[9px] text-muted-foreground uppercase tracking-wider opacity-50">Sessions</span><div class="flex-1 border-t border-border/30"></div></div>` : ""}
											<div class="flex flex-col gap-0.5" style="padding-left:${INDENT}px;">
												${standaloneArchived.map(s => html`
													${renderArchivedSessionRow(s)}
													${renderArchivedDelegates(s.id)}
												`)}
											</div>
											${state.archivedSessionsHasMore ? html`
												<button class="text-xs text-primary hover:underline px-2 py-1" @click=${() => { fetchArchivedSessionsPaginated(50, state.archivedSessionsCursor ?? undefined); }}>Load more sessions…</button>
											` : ""}
										</div>
									` : "";
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

/** Cached workflows for goal creation dropdown. */
import { fetchWorkflows, type Workflow } from "./api.js";
let _cachedWorkflows: Workflow[] = [];
let _workflowsLoaded = false;
let _selectedWorkflowId = "general";
let _goalSandboxed = false;
let _assistantEnabledOptionalSteps: string[] = [];

/** Set the selected workflow ID from outside the render module (e.g. from a goal proposal). */
export function setSelectedWorkflowId(id: string): void {
	_selectedWorkflowId = id;
}

function ensureWorkflowsLoaded(): void {
	if (_workflowsLoaded) return;
	_workflowsLoaded = true;
	fetchWorkflows().then((wfs) => { _cachedWorkflows = wfs; renderApp(); });
}

let _sandboxStatusFetching = false;

const _qaConfigCache = new Map<string, boolean>();
let _qaConfigFetching = false;
function ensureQaConfigLoaded(projectId: string): void {
	if (_qaConfigCache.has(projectId) || _qaConfigFetching) return;
	_qaConfigFetching = true;
	gatewayFetch(`/api/projects/${projectId}/qa-testing-config`)
		.then(r => r.json())
		.then(data => {
			_qaConfigCache.set(projectId, !!data.config);
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
}

function renderGoalForm(config: GoalFormConfig) {
	return html`
		<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
			<div>
				<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Title</label>
				${Input({
					type: "text",
					value: config.title,
					placeholder: "Goal title",
					onInput: config.onTitleChange,
				})}
			</div>
			${(() => {
				const linkedProject = config.linkedProjectId ? state.projects.find(p => p.id === config.linkedProjectId) : null;
				if (linkedProject) {
					return html`
				<div class="flex gap-4">
					<div class="min-w-0" style="width:30%;">
						<label class="text-xs text-muted-foreground mb-1 block font-medium">Project</label>
						<div class="text-sm text-foreground/80 truncate">${linkedProject.name}</div>
					</div>
					<div class="min-w-0" style="width:70%;">
						<label class="text-xs text-muted-foreground mb-1 block font-medium">Working Directory</label>
						<div class="text-sm text-foreground/80 truncate font-mono" title=${linkedProject.rootPath}>${linkedProject.rootPath}</div>
					</div>
				</div>
				<p class="text-[11px] text-muted-foreground opacity-70 -mt-2">Agents will work in a git worktree at <code class="text-[10px]">${worktreePreviewPath(linkedProject.rootPath, config.title)}</code></p>`;
				}
				return html`
			<div>
				<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Working Directory</label>
				${cwdCombobox({
					value: config.cwd,
					onInput: config.onCwdChange,
					onSelect: config.onCwdSelect,
					dropdownOpen: config.cwdDropdownOpen,
					onToggle: config.onCwdToggle,
					highlightedIndex: config.cwdHighlightIndex,
					onHighlight: config.onCwdHighlight,
				})}
				<p class="text-[11px] text-muted-foreground mt-1 opacity-70">Agents will work in a git worktree at <code class="text-[10px]">${worktreePreviewPath(config.cwd, config.title)}</code></p>
			</div>`;
			})()}
			${state.sandboxStatus?.configured ? html`
			<div>
				<label class="flex items-center gap-1.5 cursor-pointer ${!(state.sandboxStatus.available && state.sandboxStatus.imageExists) ? "opacity-40 pointer-events-none" : ""}">
					<input type="checkbox" class="toggle-switch" .checked=${config.sandboxed}
						?disabled=${!(state.sandboxStatus.available && state.sandboxStatus.imageExists)}
						@change=${config.onSandboxChange} />
					<span class="text-xs text-muted-foreground font-medium">Sandbox (Docker)</span>
					<span title=${!(state.sandboxStatus.available && state.sandboxStatus.imageExists)
						? "Docker sandbox is configured but unavailable — check Docker status and image in Settings"
						: "Runs each team agent in an isolated Docker container with restricted filesystem and network access"}
						class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
				</label>
			</div>
			` : ""}
			${_cachedWorkflows.length > 0 ? html`
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Workflow</label>
					<select
						class="w-full text-sm px-2 py-1.5 rounded-md border border-border bg-background text-foreground"
						.value=${config.workflowId}
						@change=${config.onWorkflowChange}
					>
						${_cachedWorkflows.map((wf) => html`
							<option value=${wf.id} ?selected=${config.workflowId === wf.id}>${wf.name} (${wf.gates.length} gates)</option>
						`)}
					</select>
				</div>
			` : ""}
			${(() => {
				const wf = _cachedWorkflows.find(w => w.id === config.workflowId);
				if (!wf) return "";
				if (config.linkedProjectId) {
					ensureQaConfigLoaded(config.linkedProjectId);
				}
				const optionalSteps: Array<{name: string; label: string; description?: string; type?: string}> = [];
				for (const gate of wf.gates) {
					if (gate.verify) {
						for (const step of gate.verify) {
							if (step.optional) {
								optionalSteps.push({ name: step.name, label: step.label || step.name, description: step.description, type: step.type });
							}
						}
					}
				}
				if (optionalSteps.length === 0) return "";
				return html`
					<div class="flex flex-col gap-2">
						<label class="text-xs text-muted-foreground font-medium">Optional Steps</label>
						${optionalSteps.map(os => {
							const qaDisabled = os.type === 'agent-qa' && !!config.linkedProjectId && _qaConfigCache.has(config.linkedProjectId) && !_qaConfigCache.get(config.linkedProjectId);
							return html`
							<label class="flex items-center gap-2 text-sm cursor-pointer ${qaDisabled ? 'opacity-40 pointer-events-none' : ''}">
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
								<span>${os.label}</span>
								${os.description ? html`
									<span title=${qaDisabled
										? 'Configure qa_start_command in project settings to enable QA testing'
										: os.description}
										class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
								` : ''}
							</label>
						`;})}
					</div>
				`;
			})()}
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
							class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
							.value=${config.spec}
							@input=${config.onSpecChange}
						></textarea>`
					: html`<div class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm">
							<markdown-block .content=${config.spec || "_No spec content yet_"}></markdown-block>
						</div>`
				}
			</div>
		</div>
		<div class="shrink-0 flex flex-col gap-3 px-5 py-3 border-t border-border">
			<div class="flex items-center justify-end gap-2">
				${config.onDismiss ? Button({ variant: "ghost", onClick: config.onDismiss, children: "Dismiss" }) : ""}
				${Button({
					variant: "default",
					onClick: config.onCreate,
					disabled: config.createDisabled ?? !config.title.trim(),
					children: config.saving ? "Creating…" : html`<span class="inline-flex items-center gap-1.5">${icon(GoalIcon, "sm")} Create Goal</span>`,
				})}
			</div>
		</div>
	`;
}

function goalPreviewPanel() {
	ensureWorkflowsLoaded();
	ensureSandboxStatusLoaded();

	const handleCreateGoal = async () => {
		const trimmedTitle = state.previewTitle.trim();
		if (!trimmedTitle) return;
		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		state.activeGoalProposal = null;
		const projectId = state.previewProjectId || undefined;
		state.previewProjectId = "";
		const workflowId = _selectedWorkflowId || "general";
		_selectedWorkflowId = "general";
		const sandboxed = _goalSandboxed;
		_goalSandboxed = false;
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
		});

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
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
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
				cwdDropdownOpen: state.cwdDropdownOpen,
				cwdHighlightIndex: state.cwdHighlightIndex,
				onCwdToggle: (open) => { state.cwdDropdownOpen = open; renderApp(); },
				onCwdHighlight: (i) => { state.cwdHighlightIndex = i; },
				onCreate: handleCreateGoal,
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
		state.activeRoleProposal = null;
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
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
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
								class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
								.value=${state.rolePreviewPrompt}
								@input=${(e: Event) => {
									state.rolePreviewPrompt = (e.target as HTMLTextAreaElement).value;
									state.rolePreviewPromptEdited = true;
									const sid = activeSessionId();
									if (sid) saveRoleDraft(sid);
								}}
							></textarea>`
						: html`<div class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm">
								<markdown-block .content=${state.rolePreviewPrompt || "_No prompt content yet_"}></markdown-block>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${Button({
					variant: "default",
					onClick: handleCreateRole,
					disabled: !state.rolePreviewName.trim() || !state.rolePreviewLabel.trim(),
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Users, "sm")} Create Role</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// TOOL PREVIEW PANEL (tool assistant split-screen)
// ============================================================================

function toolPreviewPanel() {
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
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
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
						<div class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm max-h-[200px]">
							<markdown-block .content=${state.toolPreviewDocs}></markdown-block>
						</div>
					</div>
				` : ""}

				<!-- Renderer preview -->
				${state.toolPreviewRendererHtml ? html`
					<div>
						<div class="text-xs text-muted-foreground mb-1.5 font-medium">Renderer Preview</div>
						<div class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm max-h-[300px]">
							<markdown-block .content=${state.toolPreviewRendererHtml}></markdown-block>
						</div>
					</div>
				` : ""}
			</div>

			<!-- Footer -->
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${Button({ variant: "ghost", onClick: handleDone, children: "Close" })}
				${state.toolPreviewName ? Button({
					variant: "default",
					onClick: handleViewTool,
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Wrench, "sm")} View Tool</span>`,
				}) : ""}
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
		state.activeStaffProposal = null;
		localStorage.removeItem("gateway.sessionId");
		setHashRoute("landing");
		state.appView = "authenticated";

		let triggers: any[] = [];
		try {
			triggers = JSON.parse(state.staffPreviewTriggers);
		} catch { /* keep empty */ }

		const result = await createStaffAgent({
			name: trimmedName,
			description: state.staffPreviewDescription,
			systemPrompt: state.staffPreviewPrompt,
			cwd: state.staffPreviewCwd,
			triggers,
			projectId: state.activeProjectId || undefined,
		});
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
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
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
								class="p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
								style="min-height:150px; max-height:400px; width:100%"
								.value=${state.staffPreviewPrompt}
								@input=${(e: Event) => {
									state.staffPreviewPrompt = (e.target as HTMLTextAreaElement).value;
									state.staffPreviewPromptEdited = true;
								}}
							></textarea>`
						: html`<div class="p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm" style="min-height:150px; max-height:400px">
								<markdown-block .content=${state.staffPreviewPrompt || "_No prompt content yet_"}></markdown-block>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${Button({
					variant: "default",
					onClick: handleCreateStaff,
					disabled: !state.staffPreviewName.trim(),
					children: html`<span class="inline-flex items-center gap-1.5">${icon(UserCheck, "sm")} Create Staff</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// ASSISTANT PREVIEW DISPATCH
// ============================================================================

function personalityPreviewPanel() {
	const handleCreatePersonality = async () => {
		const trimmedName = state.personalityPreviewName.trim();
		const trimmedLabel = state.personalityPreviewLabel.trim();
		if (!trimmedName || !trimmedLabel) return;
		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		state.activePersonalityProposal = null;
		if (sessionId) {
			const { deletePersonalityDraft } = await import("./session-manager.js");
			deletePersonalityDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");

		const { createPersonality } = await import("./api.js");
		await createPersonality({
			name: trimmedName,
			label: trimmedLabel,
			description: state.personalityPreviewDescription,
			promptFragment: state.personalityPreviewPromptFragment,
		});

		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}

		const { loadPersonalityPageData } = await import("./personality-manager-page.js");
		await loadPersonalityPageData();
		setHashRoute("personalities");
		renderApp();
	};

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Name</label>
					${Input({
						type: "text",
						value: state.personalityPreviewName,
						placeholder: "personality-name (lowercase, hyphens)",
						onInput: (e: Event) => {
							state.personalityPreviewName = (e.target as HTMLInputElement).value;
							state.personalityPreviewNameEdited = true;
							const sid = activeSessionId();
							if (sid) { import("./session-manager.js").then((m) => m.savePersonalityDraft(sid)); }
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Label</label>
					${Input({
						type: "text",
						value: state.personalityPreviewLabel,
						placeholder: "Display Label",
						onInput: (e: Event) => {
							state.personalityPreviewLabel = (e.target as HTMLInputElement).value;
							state.personalityPreviewLabelEdited = true;
							const sid = activeSessionId();
							if (sid) { import("./session-manager.js").then((m) => m.savePersonalityDraft(sid)); }
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Description</label>
					${Input({
						type: "text",
						value: state.personalityPreviewDescription,
						placeholder: "One-line tooltip description",
						onInput: (e: Event) => {
							state.personalityPreviewDescription = (e.target as HTMLInputElement).value;
							state.personalityPreviewDescriptionEdited = true;
							const sid = activeSessionId();
							if (sid) { import("./session-manager.js").then((m) => m.savePersonalityDraft(sid)); }
						},
					})}
				</div>
				<div class="flex-1 flex flex-col min-h-0">
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">Prompt Fragment</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							title="Toggle edit/preview mode"
							@click=${() => { state.personalityPreviewPromptFragmentEditMode = !state.personalityPreviewPromptFragmentEditMode; renderApp(); }}
						>
							${state.personalityPreviewPromptFragmentEditMode ? "Preview" : "Edit"}
						</button>
					</div>
					${state.personalityPreviewPromptFragmentEditMode
						? html`<textarea
								class="flex-1 min-h-[120px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
								.value=${state.personalityPreviewPromptFragment}
								@input=${(e: Event) => {
									state.personalityPreviewPromptFragment = (e.target as HTMLTextAreaElement).value;
									state.personalityPreviewPromptFragmentEdited = true;
									const sid = activeSessionId();
									if (sid) { import("./session-manager.js").then((m) => m.savePersonalityDraft(sid)); }
								}}
							></textarea>`
						: html`<div class="flex-1 min-h-[120px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm">
								<markdown-block .content=${state.personalityPreviewPromptFragment || "_No prompt fragment yet_"}></markdown-block>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${Button({
					variant: "default",
					onClick: handleCreatePersonality,
					disabled: !state.personalityPreviewName.trim() || !state.personalityPreviewLabel.trim(),
					children: html`<span class="inline-flex items-center gap-1.5">${icon(Drama, "sm")} Create Personality</span>`,
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// SETUP PREVIEW PANEL (setup wizard split-screen)
// ============================================================================

const SETUP_CMD_LABELS: Record<string, string> = {
	build_command: "Build",
	test_command: "Test",
	typecheck_command: "Type Check",
	test_unit_command: "Test (Unit)",
	test_e2e_command: "Test (E2E)",
};

async function saveSetupForm(): Promise<void> {
	state.setupFormSaving = true;
	renderApp();
	try {
		// 1. Save project config (commands)
		const configBody: Record<string, string | null> = {};
		for (const [key, value] of Object.entries(state.setupFormCommands)) {
			configBody[key] = value || null;
		}
		await gatewayFetch("/api/project-config", { method: "PUT", body: JSON.stringify(configBody) });

		// 2. Save system prompt context
		if (state.setupFormSystemPrompt.trim()) {
			await gatewayFetch("/api/system-prompt-context", {
				method: "PUT",
				body: JSON.stringify({ context: state.setupFormSystemPrompt }),
			});
		}

		// 3. Save model preferences
		const prefBody: Record<string, string | null> = {};
		if (state.setupFormModels.session_model) prefBody["default.sessionModel"] = state.setupFormModels.session_model;
		if (state.setupFormModels.review_model) prefBody["default.reviewModel"] = state.setupFormModels.review_model;
		if (state.setupFormModels.naming_model) prefBody["default.namingModel"] = state.setupFormModels.naming_model;
		if (Object.keys(prefBody).length > 0) {
			await gatewayFetch("/api/preferences", { method: "PUT", body: JSON.stringify(prefBody) });
		}

		// 4. Mark setup complete
		await gatewayFetch("/api/setup-status/dismiss", { method: "POST" });
		state.setupComplete = true;
		state.setupFormSaved = true;
	} catch (err) {
		console.error("[setup] Save failed:", err);
	}
	state.setupFormSaving = false;
	renderApp();
}

function setupPreviewPanel() {
	const handleDone = () => { backToSessions(); };

	const stack = state.setupFormStack;
	const cmds = state.setupFormCommands;
	const models = state.setupFormModels;
	const hasStack = !!(stack.language || stack.framework || stack.testing);
	const hasCmds = Object.values(cmds).some(v => !!v);
	const hasPrompt = !!state.setupFormSystemPrompt.trim();
	const canSave = hasCmds || hasPrompt;

	const sectionLabel = (text: string) => html`<div class="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">${text}</div>`;
	const cmdInput = (key: string) => html`
		<div class="flex items-center gap-3">
			<span class="text-sm font-medium text-foreground w-28 sm:w-36 shrink-0">${SETUP_CMD_LABELS[key] || key}</span>
			<input
				type="text"
				class="flex-1 min-w-0 px-3 py-1.5 rounded-md border border-input bg-background text-sm font-mono
					focus:outline-none focus:ring-2 focus:ring-ring ${cmds[key] ? "text-foreground" : "text-muted-foreground"}"
				placeholder="detecting..."
				.value=${cmds[key] || ""}
				@input=${(e: Event) => {
					state.setupFormCommands[key] = (e.target as HTMLInputElement).value;
					state.setupFormCommandsEdited[key] = true;
					state.setupFormSaved = false;
					renderApp();
				}}
			/>
		</div>
	`;
	const modelInput = (key: string, label: string) => html`
		<div class="flex items-center gap-3">
			<span class="text-sm font-medium text-foreground w-28 sm:w-36 shrink-0">${label}</span>
			<input
				type="text"
				class="flex-1 min-w-0 px-3 py-1.5 rounded-md border border-input bg-background text-sm font-mono
					focus:outline-none focus:ring-2 focus:ring-ring ${(models as any)[key] ? "text-foreground" : "text-muted-foreground"}"
				placeholder="(use default)"
				.value=${(models as any)[key] || ""}
				@input=${(e: Event) => {
					(state.setupFormModels as any)[key] = (e.target as HTMLInputElement).value;
					(state.setupFormModelsEdited as any)[key] = true;
					state.setupFormSaved = false;
					renderApp();
				}}
			/>
		</div>
	`;

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<!-- Header -->
				<div>
					<div class="text-lg font-semibold flex items-center gap-2">
						${icon(WandSparkles, "sm")}
						Project Setup
					</div>
					${state.setupFormSaved ? html`
						<div class="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/15 text-green-700 dark:text-green-400">
							<span class="text-green-500">&#10003;</span> Saved
						</div>
					` : ""}
				</div>

				<!-- Detected stack badges -->
				${hasStack ? html`
					<div class="flex flex-col gap-2">
						${sectionLabel("Detected Stack")}
						<div class="flex flex-wrap gap-2">
							${stack.language ? html`<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">${stack.language}</span>` : ""}
							${stack.framework ? html`<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">${stack.framework}</span>` : ""}
							${stack.testing ? html`<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary">${stack.testing}</span>` : ""}
						</div>
					</div>
				` : ""}

				<!-- Commands -->
				<div class="flex flex-col gap-2">
					${sectionLabel("Commands")}
					${Object.keys(SETUP_CMD_LABELS).map(key => cmdInput(key))}
				</div>

				<hr class="border-border" />

				<!-- Models -->
				<div class="flex flex-col gap-2">
					${sectionLabel("Default Models")}
					${modelInput("session_model", "Session")}
					${modelInput("review_model", "Review")}
					${modelInput("naming_model", "Naming")}
				</div>

				<hr class="border-border" />

				<!-- System prompt context -->
				<div class="flex flex-col gap-2">
					${sectionLabel("System Prompt \u2014 Project Context")}
					<textarea
						class="w-full min-h-[120px] px-3 py-2 rounded-md border border-input bg-background text-sm
							font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
						placeholder="The assistant will draft project-specific directives here..."
						.value=${state.setupFormSystemPrompt}
						@input=${(e: Event) => {
							state.setupFormSystemPrompt = (e.target as HTMLTextAreaElement).value;
							state.setupFormSystemPromptEdited = true;
							state.setupFormSaved = false;
							renderApp();
						}}
					></textarea>
				</div>
			</div>

			<!-- Footer -->
			<div class="shrink-0 flex items-center justify-between px-5 py-3 border-t border-border">
				<div class="text-xs text-muted-foreground">
					${state.setupFormSaved ? html`<span class="text-green-600 dark:text-green-400">&#10003; Saved to config files</span>` : ""}
				</div>
				<div class="flex items-center gap-2">
					${Button({ variant: "ghost", onClick: handleDone, children: "Done" })}
					${Button({
						variant: "default",
						onClick: saveSetupForm,
						disabled: !canSave || state.setupFormSaving,
						children: state.setupFormSaving ? "Saving\u2026" : "Save Setup",
					})}
				</div>
			</div>
		</div>
	`;
}

let _workflowPageModule: typeof import("./workflow-page.js") | null = null;
function ensureWorkflowPageLoaded() {
	if (!_workflowPageModule) {
		import("./workflow-page.js").then(mod => { _workflowPageModule = mod; renderApp(); });
	}
}

function workflowPreviewPanel() {
	ensureWorkflowPageLoaded();

	const handleCreateWorkflow = async () => {
		if (_workflowPageModule) {
			const ok = await _workflowPageModule.saveWorkflowFromPanel();
			if (!ok) return;
		}
		const sessionId = activeSessionId();
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		localStorage.removeItem("gateway.sessionId");
		state.appView = "authenticated";
		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}
		await refreshSessions();
		setHashRoute("workflows");
		renderApp();
	};

	if (!_workflowPageModule) {
		return html`
			<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
				<div class="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading editor...</div>
			</div>
		`;
	}

	const { renderWorkflowEditPanel, isWorkflowSaving, canSaveWorkflow } = _workflowPageModule;

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-4">
				${renderWorkflowEditPanel()}
			</div>
			<div class="flex items-center justify-between p-3 border-t border-border">
				<div></div>
				<div class="flex items-center gap-2">
					${Button({
						variant: "default",
						size: "sm",
						onClick: handleCreateWorkflow,
						disabled: !canSaveWorkflow(),
						children: isWorkflowSaving() ? "Creating\u2026" : "Create Workflow",
					})}
				</div>
			</div>
		</div>
	`;
}

function getAssistantPreviewPanel(type: string) {
	switch (type) {
		case "goal": return goalPreviewPanel();
		case "role": return rolePreviewPanel();
		case "tool": return toolPreviewPanel();
		case "personality": return personalityPreviewPanel();
		case "staff": return staffPreviewPanel();
		case "setup": return setupPreviewPanel();
		case "workflow": return workflowPreviewPanel();
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
let _proposalEnabledOptionalSteps: string[] = [];
let _proposalInitializedFrom: string | null = null;

/** Sync module-level form state from the active goal proposal when it changes. */
function syncProposalFormState(): void {
	const proposal = state.activeGoalProposal;
	if (!proposal) return;
	// Use a simple identity check to avoid re-initializing on every render
	const key = `${proposal.title}|${proposal.spec}|${proposal.cwd || ""}|${proposal.workflow || ""}|${proposal.options || ""}`;
	if (_proposalInitializedFrom === key) return;
	_proposalInitializedFrom = key;
	_proposalTitle = proposal.title;
	_proposalSpec = proposal.spec;
	_proposalCwd = proposal.cwd || "";
	_proposalWorkflowId = proposal.workflow || "general";
	_proposalSpecEditMode = false;
	_proposalEnabledOptionalSteps = proposal.options
		? proposal.options.split(",").map(s => s.trim()).filter(Boolean)
		: [];
	_proposalSaving = false;
}

function goalProposalPanel() {
	syncProposalFormState();
	ensureWorkflowsLoaded();
	ensureSandboxStatusLoaded();

	const handleCreateGoal = async () => {
		const trimmedTitle = _proposalTitle.trim();
		if (!trimmedTitle || _proposalSaving) return;
		_proposalSaving = true;
		renderApp();

		try {
			const sandboxed = _proposalSandboxed;
			_proposalSandboxed = false;
			const goal = await createGoal(trimmedTitle, _proposalCwd.trim(), {
				spec: _proposalSpec,
				workflowId: _proposalWorkflowId || undefined,
				sandboxed,
				projectId: state.previewProjectId || undefined,
				enabledOptionalSteps: _proposalEnabledOptionalSteps.length > 0 ? _proposalEnabledOptionalSteps : undefined,
			});
			state.activeGoalProposal = null;
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
		const dismissed = state.activeGoalProposal;
		state.activeGoalProposal = null;
		_proposalInitializedFrom = null;
		_proposalEnabledOptionalSteps = [];
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
		cwdDropdownOpen: _proposalCwdDropdownOpen,
		cwdHighlightIndex: _proposalCwdHighlightIndex,
		onCwdToggle: (open) => { _proposalCwdDropdownOpen = open; renderApp(); },
		onCwdHighlight: (i) => { _proposalCwdHighlightIndex = i; },
		onCreate: handleCreateGoal,
		onDismiss: handleDismiss,
		saving: _proposalSaving,
		createDisabled: !_proposalTitle.trim() || _proposalSaving,
	});
}

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
	return !state.assistantType && (state.isPreviewSession || state.activeGoalProposal != null);
}

/** Ordered list of available unified panel tabs for the current session. */
function unifiedPanelTabs(): Array<"chat" | "preview" | "goal"> {
	const tabs: Array<"chat" | "preview" | "goal"> = ["chat"];
	if (state.isPreviewSession) tabs.push("preview");
	if (state.activeGoalProposal != null) tabs.push("goal");
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
// ASSISTANT SWIPE (mobile) — goal / role / tool / personality assistants
// ============================================================================

/** Touch-swipe between the assistant chat pane and its preview pane.
 *  Left swipe on chat → show preview.  Right swipe on preview → show chat. */
function setupAssistantSwipe(): void {
	if ((window as any).__assistantSwipeListening) return;
	(window as any).__assistantSwipeListening = true;

	let startX = 0, startY = 0, captured = false, decided = false;
	const el = document.getElementById("app")!;

	el.addEventListener("touchstart", (e: TouchEvent) => {
		if (!state.assistantType) return;
		startX = e.touches[0].clientX;
		startY = e.touches[0].clientY;
		captured = false;
		decided = false;
	}, { passive: true });

	el.addEventListener("touchmove", (e: TouchEvent) => {
		if (!state.assistantType) return;
		if (decided && !captured) return;
		const dx = e.touches[0].clientX - startX;
		const dy = e.touches[0].clientY - startY;
		if (!decided && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
			decided = true;
			// On chat tab: capture leftward swipes.  On preview tab: capture rightward swipes.
			if (state.assistantTab === "chat") {
				captured = dx < 0 && Math.abs(dx) > Math.abs(dy);
			} else {
				captured = dx > 0 && Math.abs(dx) > Math.abs(dy);
			}
			if (captured) {
				const track = document.querySelector(".assistant-slider__track") as HTMLElement | null;
				if (track) track.style.transition = "none";
			}
		}
		if (captured) {
			const track = document.querySelector(".assistant-slider__track") as HTMLElement | null;
			if (track) {
				const base = state.assistantTab === "chat" ? 0 : -50;
				const dragPercent = (dx / track.parentElement!.clientWidth) * 50;
				track.style.transform = `translateX(${Math.max(-50, Math.min(0, base + dragPercent))}%)`;
			}
		}
	}, { passive: true });

	el.addEventListener("touchend", (e: TouchEvent) => {
		if (!captured) return;
		const track = document.querySelector(".assistant-slider__track") as HTMLElement | null;
		if (track) {
			track.style.transition = "transform 0.3s ease-out";
			const dx = e.changedTouches[0].clientX - startX;
			const threshold = track.parentElement!.clientWidth * 0.2;
			if (state.assistantTab === "chat" && dx < -threshold) {
				state.assistantTab = "preview";
			} else if (state.assistantTab === "preview" && dx > threshold) {
				state.assistantTab = "chat";
			}
			track.style.transform = `translateX(${state.assistantTab === "chat" ? 0 : -50}%)`;
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

	document.documentElement.style.setProperty("--bobbit-shimmer-delay", `${-(Date.now() % 8000)}ms`);

	// Disconnected state
	if (state.appView === "disconnected") {
		render(html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
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
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0">
					<div class="flex items-center gap-2 px-4 py-1">
						${bobbitIcon}
						<span class="text-base font-semibold text-foreground">Bobbit</span>
					</div>
					<div class="flex items-center gap-1 px-2">
						<theme-toggle></theme-toggle>
					</div>
				</div>
				<div class="flex-1 flex flex-col items-center justify-center gap-6 p-8">
					<div class="flex flex-col items-center gap-4 text-center">
						<svg class="animate-spin text-muted-foreground" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
						</svg>
						<h2 class="text-lg font-medium text-foreground">Starting server</h2>
						<p class="text-sm text-muted-foreground max-w-sm">
							Waiting for the gateway to become ready…
						</p>
					</div>
				</div>
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
				children: html`<span class="inline-flex items-center gap-1.5">${icon(ArrowLeft, "sm")} <span class="text-xs">All Sessions</span></span>`,
				onClick: backToSessions,
				title: "Back to session list",
				className: "h-10 pl-3 pr-3",
			}) : "";

			if (!desktop) {
				const activeSession = activeSid ? state.gatewaySessions.find(s => s.id === activeSid) : undefined;
				const goalId = activeSession?.goalId || activeSession?.teamGoalId;
				const goalTitle = goalId ? state.goals.find(g => g.id === goalId)?.title : undefined;
				return html`
					<div class="flex items-center w-full pr-0.5 relative" style="min-height:40px;">
						<div class="shrink-0">${backBtn}</div>
						<div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
							<span class="text-sm font-medium text-foreground truncate px-14 inline-flex items-center gap-1" title=${sessionTitle}>${sessionTitle}${activeSession?.sandboxed ? renderSandboxIndicator(activeSession.status) : ""}</span>
							${goalTitle ? html`<span class="text-[10px] text-muted-foreground/60 truncate px-14 uppercase tracking-wider">${goalTitle}</span>` : ""}
						</div>
						<div class="ml-auto shrink-0">${editDeleteBtns}</div>
					</div>
				`;
			}
			const deskSession = activeSid ? state.gatewaySessions.find(s => s.id === activeSid) : undefined;
			const deskGoalId = deskSession?.goalId || deskSession?.teamGoalId;
			const deskGoalTitle = deskGoalId ? state.goals.find(g => g.id === deskGoalId)?.title : undefined;
			return html`
				<div class="flex items-center gap-2 px-3">
					<div class="flex flex-col min-w-0 py-1">
						<span class="text-sm font-medium text-foreground truncate max-w-[320px] inline-flex items-center gap-1" title=${sessionTitle}>${sessionTitle}${deskSession?.sandboxed ? renderSandboxIndicator(deskSession.status) : ""}</span>
						${deskGoalTitle ? html`<span class="text-[10px] text-muted-foreground/60 truncate max-w-[320px] uppercase tracking-wider">${deskGoalTitle}</span>` : ""}
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
					title="${state.assistantType === "workflow" ? "Editor" : "Preview"}"
					@click=${() => { state.assistantTab = "preview"; renderApp(); }}
				>
					${state.assistantType === "workflow" ? "Editor" : "Preview"}${state.assistantHasProposal ? html` <span class="goal-tab-dot"></span>` : ""}
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
				${state.activeGoalProposal != null ? html`
					<button
						class="goal-tab-pill ${state.previewPanelTab === "goal" ? "goal-tab-pill--active" : ""}"
						title="Goal"
						@click=${() => { state.previewPanelTab = "goal"; renderApp(); }}
					>Goal <span class="goal-tab-dot"></span></button>
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
					.srcdoc=${state.previewPanelHtml + PREVIEW_SWIPE_SCRIPT}
				></iframe>
			</div>
		`;
	};

	/** Unified preview panel with tab header + content dispatch.
	 *  Used on desktop for non-assistant sessions that have preview or goal proposal. */
	const unifiedPreviewPanel = () => {
		// Auto-correct tab if the active tab's content is no longer available
		if (state.previewPanelActiveTab === "preview" && !state.isPreviewSession && state.activeGoalProposal != null) {
			state.previewPanelActiveTab = "goal";
		} else if (state.previewPanelActiveTab === "goal" && state.activeGoalProposal == null && state.isPreviewSession) {
			state.previewPanelActiveTab = "preview";
		}

		const showPreviewTab = state.isPreviewSession;
		const showGoalTab = state.activeGoalProposal != null;

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
						${showGoalTab ? html`
							<button
								class="goal-tab-pill ${state.previewPanelActiveTab === "goal" ? "goal-tab-pill--active" : ""}"
								title="Goal"
								@click=${() => { state.previewPanelActiveTab = "goal"; renderApp(); }}
							>Goal <span class="goal-tab-dot"></span></button>
						` : ""}
					</div>
					<button @click=${togglePreviewCollapse} class="text-muted-foreground hover:text-foreground" style="background:none;border:none;cursor:pointer;padding:2px;flex-shrink:0;" title="Collapse preview (Ctrl+])">
						${icon(PanelRightClose, "sm")}
					</button>
				</div>
				<!-- Tab content -->
				${state.previewPanelActiveTab === "preview" && showPreviewTab
					? htmlPreviewContent()
					: state.previewPanelActiveTab === "goal" && showGoalTab
						? goalProposalPanel()
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
	const mobilePaneContent = (tab: "chat" | "preview" | "goal") => {
		if (tab === "chat") return state.chatPanel;
		if (tab === "preview" && state.isPreviewSession) {
			return html`<div class="goal-preview-panel flex-1 flex flex-col min-h-0">${htmlPreviewContent()}</div>`;
		}
		if (tab === "goal" && state.activeGoalProposal != null) {
			return html`<div class="goal-preview-panel flex-1 flex flex-col min-h-0">${goalProposalPanel()}</div>`;
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
		if (route.view === "personalities" || route.view === "personality-edit") {
			return renderPersonalityManagerPage();
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

		if (desktop) {
			if (!state.setupComplete && !isSetupWizardActive()) {
				return html`
					<div class="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
						<div class="text-muted-foreground empty-state-icon">${icon(WandSparkles, "lg")}</div>
						<p class="text-lg font-medium text-foreground">Welcome to Bobbit</p>
						<p class="text-sm text-muted-foreground">Set up your project to get the best results from AI agents</p>
						${Button({
							variant: "default",
							onClick: () => launchSetupWizard(),
							children: html`<span class="inline-flex items-center gap-1.5">${icon(WandSparkles, "sm")} Start Setup</span>`,
						})}
						<button class="text-xs text-muted-foreground hover:underline cursor-pointer bg-transparent border-none" @click=${skipSetup}>Skip setup</button>
					</div>
				`;
			}
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
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center border-b border-border shrink-0">
					${state.sidebarCollapsed ? html`
					<div class="w-14 shrink-0 flex items-center justify-center self-stretch" style="background: var(--sidebar);">
						${bobbitIcon}
					</div>
					` : html`
					<div class="w-[240px] shrink-0 flex items-center justify-between px-3 self-stretch" style="background: var(--sidebar);">
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
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden relative"
				data-mobile-header>
				<div id="app-header"
					class="fixed top-0 left-0 right-0 z-50 bg-background/95 backdrop-blur-sm border-b border-border flex flex-col">
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
		setupAssistantSwipe();
		requestAnimationFrame(() => {
			const headerEl = document.getElementById("app-header");
			if (headerEl) {
				const h = headerEl.offsetHeight;
				document.documentElement.style.setProperty("--mobile-header-height", `${h + 16}px`);
			}
		});
	} else {
		render(html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center justify-between border-b border-border shrink-0">
					${headerLeft()}
					${headerRight()}
				</div>
				<div id="app-main" class="flex-1 min-h-0 flex flex-col">${mainArea()}</div>
			</div>
		`, app);
	}
}
