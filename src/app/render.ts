import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html, render } from "lit";
import { ArrowLeft, MessagesSquare, ChevronDown, ChevronRight, Drama, Goal as GoalIcon, PanelRightClose, PanelRightOpen, Pencil, Plus, QrCode, Server, Settings, Trash2, Unplug, UserCheck, Users, Workflow as WorkflowIcon, Wrench } from "lucide";
import {
	state,
	renderApp,
	isDesktop,
	hasActiveSession,
	activeSessionId,
	ungroupedExpanded,
	setUngroupedExpanded,
	type GoalState,
} from "./state.js";
import { createGoal, createRole, gatewayFetch, refreshSessions } from "./api.js";
import { clearSessionModel } from "./routing.js";
import { backToSessions, createAndConnectSession, connectToSession, terminateSession, saveGoalDraft, deleteGoalDraft, saveRoleDraft, deleteRoleDraft } from "./session-manager.js";
import { openGatewayDialog, showQrCodeDialog, showRenameDialog, showGoalDialog } from "./dialogs.js";
import { renderSidebar, toggleRolePicker, renderRolePickerDropdown, renderStaffSidebarSection } from "./sidebar.js";

import { renderGoalGroup, renderSessionRow } from "./render-helpers.js";

const bobbitIcon = html`<img src="/favicon.svg" alt="" style="width:20px;height:18px;image-rendering:pixelated;" />`;

import { cwdCombobox } from "./cwd-combobox.js";

import { teardownMobileScrollTracking, ensureMobileScrollTracking } from "./mobile-header.js";
import { getRouteFromHash, setHashRoute } from "./routing.js";
import { renderGoalDashboard } from "./goal-dashboard.js";
import "./goal-dashboard.css";
import { renderRoleManagerPage, loadRolePageData } from "./role-manager-page.js";
import "./role-manager.css";
import { renderToolManagerPage } from "./tool-manager-page.js";
import "./tool-manager.css";
import { renderWorkflowPage } from "./workflow-page.js";
import "./workflow-page.css";
import { renderPersonalityManagerPage } from "./personality-manager-page.js";
import "./personality-manager.css";
import { renderStaffPage } from "./staff-page.js";
import { renderSettingsPage } from "./settings-page.js";

// ============================================================================
// MOBILE LANDING PAGE
// ============================================================================

/** Compact session row for mobile — mirrors sidebar row with always-visible buttons */

function renderMobileLanding() {
	const staffSessionIds = new Set(state.staffList.map((s) => s.currentSessionId).filter(Boolean));
	const ungroupedSessions = state.gatewaySessions.filter((s) => !s.goalId && !s.teamGoalId && !s.delegateOf && !staffSessionIds.has(s.id)).sort((a, b) => a.createdAt - b.createdAt);
	const stateOrder: Record<GoalState, number> = { "in-progress": 0, "todo": 1, "complete": 2, "shelved": 3 };
	const sortedGoals = [...state.goals].sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9));
	const isUngroupedExpanded = ungroupedExpanded;

	return html`
		<div class="flex-1 flex flex-col overflow-y-auto">
			<div class="w-full max-w-xl mx-auto px-2 py-4 flex flex-col gap-1">
				<div class="flex flex-col gap-1 px-1 pb-2 mb-1 border-b border-border/30">
					<div class="flex items-center gap-1">
						<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
							title="Manage roles"
							@click=${() => { import("./role-manager-page.js").then((m) => m.loadRolePageData()); setHashRoute("roles"); }}>
							${icon(Users, "xs")} Roles
						</button>
						<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
							title="Manage personalities"
							@click=${() => { import("./personality-manager-page.js").then((m) => m.loadPersonalityPageData()); setHashRoute("personalities"); }}>
							${icon(Drama, "xs")} Personalities
						</button>
						<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
							title="Manage tools"
							@click=${() => { import("./tool-manager-page.js").then((m) => m.loadToolPageData()); setHashRoute("tools"); }}>
							${icon(Wrench, "xs")} Tools
						</button>
					</div>
					<div class="flex items-center gap-1">
						<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
							title="Manage workflows"
							@click=${() => { import("./workflow-page.js").then((m) => m.loadWorkflowPageData()); setHashRoute("workflows"); }}>
							${icon(WorkflowIcon, "xs")} Workflows
						</button>
						<button class="flex-1 text-sm text-muted-foreground px-1.5 py-1 rounded active:bg-secondary/50 transition-colors flex items-center justify-center gap-1"
							@click=${() => showGoalDialog()}
							title="New goal (Alt+G)">
							${icon(GoalIcon, "xs")} New Goal
						</button>
					</div>
				</div>
				${state.sessionsLoading
					? html`<div class="text-center py-12 text-muted-foreground text-xs">Loading…</div>`
					: state.sessionsError
						? html`<div class="text-center py-12">
								<p class="text-xs text-red-500 mb-3">${state.sessionsError}</p>
								<button class="text-xs text-muted-foreground underline" @click=${refreshSessions}>Retry</button>
							</div>`
						: state.goals.length === 0 && state.gatewaySessions.length === 0
							? html`<div class="text-center py-12">
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
								${sortedGoals.map((goal, i) => html`
									${i > 0 ? html`<div class="border-t border-border/30 my-1 mx-2"></div>` : ""}
									${renderGoalGroup(goal)}
								`)}
								${sortedGoals.length > 0 ? html`
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
										${isUngroupedExpanded ? ungroupedSessions.map(renderSessionRow) : ""}
									</div>
								` : ungroupedSessions.length > 0 ? html`
									<div class="flex flex-col gap-0.5">
										<div class="flex items-center gap-1.5 pl-0 pr-2 py-1.5">
											<span class="flex-1 text-sm text-muted-foreground uppercase tracking-wider font-medium flex items-center gap-1.5" style="padding-left:15px;"><span class="shrink-0">${icon(MessagesSquare, "sm")}</span> Sessions</span>
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
										${ungroupedSessions.map(renderSessionRow)}
									</div>
								` : ""}
								${renderStaffSidebarSection()}

							`}
			</div>
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

/** Set the selected workflow ID from outside the render module (e.g. from a goal proposal). */
export function setSelectedWorkflowId(id: string): void {
	_selectedWorkflowId = id;
}

function ensureWorkflowsLoaded(): void {
	if (_workflowsLoaded) return;
	_workflowsLoaded = true;
	fetchWorkflows().then((wfs) => { _cachedWorkflows = wfs; renderApp(); });
}

function goalPreviewPanel() {
	ensureWorkflowsLoaded();

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
		const workflowId = _selectedWorkflowId || "general";
		_selectedWorkflowId = "general";
		// Clean up persisted draft
		if (sessionId) {
			deleteGoalDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");
		state.appView = "authenticated";

		const goal = await createGoal(trimmedTitle, state.previewCwd.trim(), { spec: state.previewSpec, workflowId });
		if (sessionId) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}
		await refreshSessions();
		if (goal) {
			setHashRoute("goal-dashboard", goal.id);
		} else {
			setHashRoute("landing");
		}
		renderApp();
	};

	const handleCancel = () => {
		backToSessions();
	};

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0">
			<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Title</label>
					${Input({
						type: "text",
						value: state.previewTitle,
						placeholder: "Goal title",
						onInput: (e: Event) => {
							state.previewTitle = (e.target as HTMLInputElement).value;
							state.previewTitleEdited = true;
							const sid = activeSessionId();
							if (sid) saveGoalDraft(sid);
						},
					})}
				</div>
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Working Directory</label>
					${cwdCombobox({
						value: state.previewCwd,
						placeholder: "(server default)",
						onInput: (v) => {
							state.previewCwd = v;
							state.previewCwdEdited = true;
							const sid = activeSessionId();
							if (sid) saveGoalDraft(sid);
							renderApp();
						},
						onSelect: (v) => {
							state.previewCwd = v;
							state.previewCwdEdited = true;
							const sid = activeSessionId();
							if (sid) saveGoalDraft(sid);
							renderApp();
						},
						dropdownOpen: state.cwdDropdownOpen,
						onToggle: (open) => { state.cwdDropdownOpen = open; renderApp(); },
						highlightedIndex: state.cwdHighlightIndex,
						onHighlight: (i) => { state.cwdHighlightIndex = i; renderApp(); },
					})}
					</div>
				${_cachedWorkflows.length > 0 ? html`
					<div>
						<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Workflow</label>
						<select
							class="w-full text-sm px-2 py-1.5 rounded-md border border-border bg-background text-foreground"
							.value=${_selectedWorkflowId}
							@change=${(e: Event) => { _selectedWorkflowId = (e.target as HTMLSelectElement).value; renderApp(); }}
						>
							${_cachedWorkflows.map((wf) => html`
								<option value=${wf.id} ?selected=${_selectedWorkflowId === wf.id}>${wf.name} (${wf.gates.length} gates)</option>
							`)}
						</select>
					</div>
				` : ""}
				<div class="flex-1 flex flex-col min-h-0">
					<div class="flex items-center justify-between mb-1.5">
						<label class="text-xs text-muted-foreground font-medium">Spec</label>
						<button
							class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							title="Toggle edit/preview mode"
							@click=${() => { state.previewSpecEditMode = !state.previewSpecEditMode; renderApp(); }}
						>
							${state.previewSpecEditMode ? "Preview" : "Edit"}
						</button>
					</div>
					${state.previewSpecEditMode
						? html`<textarea
								class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
								.value=${state.previewSpec}
								@input=${(e: Event) => {
									state.previewSpec = (e.target as HTMLTextAreaElement).value;
									state.previewSpecEdited = true;
									const sid = activeSessionId();
									if (sid) saveGoalDraft(sid);
								}}
							></textarea>`
						: html`<div class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm">
								<markdown-block .content=${state.previewSpec || "_No spec content yet_"}></markdown-block>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex flex-col gap-3 px-5 py-3 border-t border-border">
				<div class="flex items-center justify-end gap-2">
					${Button({ variant: "ghost", onClick: handleCancel, children: "Cancel" })}
					${Button({
						variant: "default",
						onClick: handleCreateGoal,
						disabled: !state.previewTitle.trim(),
						children: html`<span class="inline-flex items-center gap-1.5">${icon(GoalIcon, "sm")} Create Goal</span>`,
					})}
				</div>
			</div>
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

		await createRole({
			name: trimmedName,
			label: trimmedLabel,
			promptTemplate: state.rolePreviewPrompt,
			allowedTools: toolsList,
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

	const handleCancel = () => {
		backToSessions();
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
				${Button({ variant: "ghost", onClick: handleCancel, children: "Cancel" })}
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
	const monNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

	const handleCancel = () => {
		backToSessions();
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
						placeholder: "(server default)",
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
				${Button({ variant: "ghost", onClick: handleCancel, children: "Cancel" })}
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

	const handleCancel = () => {
		backToSessions();
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
				${Button({ variant: "ghost", onClick: handleCancel, children: "Cancel" })}
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

function getAssistantPreviewPanel(type: string) {
	switch (type) {
		case "goal": return goalPreviewPanel();
		case "role": return rolePreviewPanel();
		case "tool": return toolPreviewPanel();
		case "personality": return personalityPreviewPanel();
		case "staff": return staffPreviewPanel();
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
let _proposalInitializedFrom: string | null = null;

/** Sync module-level form state from the active goal proposal when it changes. */
function syncProposalFormState(): void {
	const proposal = state.activeGoalProposal;
	if (!proposal) return;
	// Use a simple identity check to avoid re-initializing on every render
	const key = `${proposal.title}|${proposal.spec}|${proposal.cwd || ""}|${proposal.workflow || ""}`;
	if (_proposalInitializedFrom === key) return;
	_proposalInitializedFrom = key;
	_proposalTitle = proposal.title;
	_proposalSpec = proposal.spec;
	_proposalCwd = proposal.cwd || "";
	_proposalWorkflowId = proposal.workflow || "general";
	_proposalSpecEditMode = false;
	_proposalSaving = false;
}

function goalProposalPanel() {
	syncProposalFormState();
	ensureWorkflowsLoaded();

	const handleCreateGoal = async () => {
		const trimmedTitle = _proposalTitle.trim();
		if (!trimmedTitle || _proposalSaving) return;
		_proposalSaving = true;
		renderApp();

		try {
			const goal = await createGoal(trimmedTitle, _proposalCwd.trim(), {
				spec: _proposalSpec,
				workflowId: _proposalWorkflowId || undefined,
			});
			state.activeGoalProposal = null;
			_proposalInitializedFrom = null;
			if (goal) {
				setHashRoute("goal-dashboard", goal.id);
			}
		} finally {
			_proposalSaving = false;
			renderApp();
		}
	};

	const handleDismiss = () => {
		state.activeGoalProposal = null;
		_proposalInitializedFrom = null;
		// If preview tab still available, switch to it; otherwise back to chat
		if (state.isPreviewSession) {
			state.previewPanelActiveTab = "preview";
			if (state.previewPanelTab === "goal") state.previewPanelTab = "preview";
		} else {
			if (state.previewPanelTab === "goal") state.previewPanelTab = "chat";
		}
		renderApp();
	};

	return html`
		<div class="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
			<div>
				<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Title</label>
				${Input({
					type: "text",
					value: _proposalTitle,
					placeholder: "Goal title",
					onInput: (e: Event) => { _proposalTitle = (e.target as HTMLInputElement).value; },
				})}
			</div>
			<div>
				<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Working Directory</label>
				${cwdCombobox({
					value: _proposalCwd,
					placeholder: "(server default)",
					onInput: (v) => { _proposalCwd = v; renderApp(); },
					onSelect: (v) => { _proposalCwd = v; renderApp(); },
					dropdownOpen: _proposalCwdDropdownOpen,
					onToggle: (open) => { _proposalCwdDropdownOpen = open; renderApp(); },
					highlightedIndex: _proposalCwdHighlightIndex,
					onHighlight: (i) => { _proposalCwdHighlightIndex = i; renderApp(); },
				})}
				</div>
			${_cachedWorkflows.length > 0 ? html`
				<div>
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Workflow</label>
					<select
						class="w-full text-sm px-2 py-1.5 rounded-md border border-border bg-background text-foreground"
						.value=${_proposalWorkflowId}
						@change=${(e: Event) => { _proposalWorkflowId = (e.target as HTMLSelectElement).value; renderApp(); }}
					>
						${_cachedWorkflows.map((wf) => html`
							<option value=${wf.id} ?selected=${_proposalWorkflowId === wf.id}>${wf.name} (${wf.gates.length} gates)</option>
						`)}
					</select>
				</div>
			` : ""}
			<div class="flex-1 flex flex-col min-h-0">
				<div class="flex items-center justify-between mb-1.5">
					<label class="text-xs text-muted-foreground font-medium">Spec</label>
					<button
						class="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
						title="Toggle edit/preview mode"
						@click=${() => { _proposalSpecEditMode = !_proposalSpecEditMode; renderApp(); }}
					>
						${_proposalSpecEditMode ? "Preview" : "Edit"}
					</button>
				</div>
				${_proposalSpecEditMode
					? html`<textarea
							class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring"
							.value=${_proposalSpec}
							@input=${(e: Event) => { _proposalSpec = (e.target as HTMLTextAreaElement).value; }}
						></textarea>`
					: html`<div class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm">
							<markdown-block .content=${_proposalSpec || "_No spec content yet_"}></markdown-block>
						</div>`
				}
			</div>
		</div>
		<div class="shrink-0 flex flex-col gap-3 px-5 py-3 border-t border-border">
			<div class="flex items-center justify-end gap-2">
				${Button({ variant: "ghost", onClick: handleDismiss, children: "Dismiss" })}
				${Button({
					variant: "default",
					onClick: handleCreateGoal,
					disabled: !_proposalTitle.trim() || _proposalSaving,
					children: _proposalSaving ? "Creating…" : html`<span class="inline-flex items-center gap-1.5">${icon(GoalIcon, "sm")} Create Goal</span>`,
				})}
			</div>
		</div>
	`;
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

	// Authenticated state
	const desktop = isDesktop();
	const connected = hasActiveSession();

	// Session action buttons (shared between headerLeft mobile and headerRight desktop)
	const sessionTitle = connected && state.remoteAgent ? (state.remoteAgent.title || "New session") : "";
	const activeSid = activeSessionId();
	const activeStaffAgent = activeSid ? state.staffList.find(s => s.currentSessionId === activeSid) : undefined;
	const editLabel = activeStaffAgent ? "Edit" : "Modify";
	const editDeleteBtns = (connected && state.remoteAgent && activeSid) ? html`
		<div class="flex items-center gap-1 shrink-0">
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
				children: html`<span class="inline-flex items-center gap-1">${icon(Trash2, "xs")}<span class="text-xs hidden sm:inline">Terminate</span></span>`,
				className: "h-7 px-2 text-muted-foreground hover:text-destructive",
				title: "Terminate session (Ctrl+Shift+D)",
			})}
		</div>
	` : "";

	const headerLeft = () => {
		if (connected && state.remoteAgent) {
			const model = state.remoteAgent.state.model;

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
							<span class="text-sm font-medium text-foreground truncate px-14" title=${sessionTitle}>${sessionTitle}</span>
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
						<span class="text-sm font-medium text-foreground truncate max-w-[320px]" title=${sessionTitle}>${sessionTitle}</span>
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
		return html`
			<div class="goal-tab-bar shrink-0 flex items-center gap-1 px-3 py-2 border-b border-border bg-background">
				<button
					class="goal-tab-pill ${state.assistantTab === "chat" ? "goal-tab-pill--active" : ""}"
					@click=${() => { state.assistantTab = "chat"; renderApp(); }}
				>Chat</button>
				<button
					class="goal-tab-pill ${state.assistantTab === "preview" ? "goal-tab-pill--active" : ""}"
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
					@click=${() => { state.previewPanelTab = "chat"; renderApp(); }}
				>Chat</button>
				${state.isPreviewSession ? html`
					<button
						class="goal-tab-pill ${state.previewPanelTab === "preview" ? "goal-tab-pill--active" : ""}"
						@click=${() => { state.previewPanelTab = "preview"; renderApp(); }}
					>Preview</button>
				` : ""}
				${state.activeGoalProposal != null ? html`
					<button
						class="goal-tab-pill ${state.previewPanelTab === "goal" ? "goal-tab-pill--active" : ""}"
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
								@click=${() => { state.previewPanelActiveTab = "preview"; renderApp(); }}
							>Preview</button>
						` : ""}
						${showGoalTab ? html`
							<button
								class="goal-tab-pill ${state.previewPanelActiveTab === "goal" ? "goal-tab-pill--active" : ""}"
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
		if (route.view === "settings") {
			return renderSettingsPage();
		}

		if (connected && state.assistantType) {
			const previewPanel = getAssistantPreviewPanel(state.assistantType);
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
		if (connected) return html`${reconnectBanner()}${state.chatPanel}`;

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
