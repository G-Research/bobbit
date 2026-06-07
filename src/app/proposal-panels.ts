// ============================================================================
// PROPOSAL PANELS (cold-path, lazy-loaded chunk)
// ============================================================================
//
// Extracted from `src/app/render.ts` to shrink the entry bundle. The full set
// of proposal preview panels (goal / role / tool / staff / project) and the
// shared `renderGoalForm` builder live here. Loaded on first proposal-panel
// view via `proposal-panels-lazy.ts`.
//
// IMPORTANT: this module pulls in render.ts via the three workspace helpers
// below (`unifiedPanelTabs`, `setUnifiedActiveTab`, `workspaceSessionId`).
// That's only safe because this module is itself dynamic-imported — render.ts
// never statically references this file. Don't add a static import from
// render.ts to here or you'll re-bloat the entry chunk.

import { html, nothing, type TemplateResult } from "lit";
import { ref, createRef } from "lit/directives/ref.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Check, Copy, Eye, FolderOpen, Goal as GoalIcon, Pencil, UserCheck, Users, Wrench } from "lucide";

import { state, renderApp, activeSessionId, isProposalStreaming } from "./state.js";
import {
	createGoal,
	createRole,
	gatewayFetch,
	refreshSessions,
	fetchSandboxStatus,
	fetchWorkflows,
	fetchGroupPolicies,
	type Workflow,
	type RoleData,
	fetchTools,
	type ToolInfo,
	createStaffAgent,
	fetchRoles,
} from "./api.js";
import {
	renderWorkflowList,
	renderWorkflowInspector,
	renderWorkflowEditor,
	clearWorkflowEditorController,
} from "./workflow-page.js";
import {
	renderRoleList,
	renderRoleInspector,
	renderRoleEditor,
	fetchRolesForProject,
	type RoleEditorDraft,
} from "./role-manager-page.js";
import { clearSessionModel, setHashRoute } from "./routing.js";
import { reconcileFollowTail } from "./follow-tail.js";
import { ensureMarkdownBlock } from "../ui/lazy/markdown-block.js";
import { clearProposalAnnotations } from "../ui/components/review/proposal-annotations.js";
import {
	saveGoalDraft,
	deleteGoalDraft,
	saveRoleDraft,
	deleteRoleDraft,
	saveProjectDraft,
	deleteProjectDraft,
	markProposalDismissed,
	backToSessions,
} from "./session-manager.js";
import { deleteProposalFile } from "./proposal-helpers.js";
import { isSubgoalsEnabled, getSystemMaxNestingDepth } from "./subgoals-flag.js";
import { PROPOSAL_TYPES, type ProposalType } from "./proposal-registry.js";
import { showConnectionError } from "./dialogs-lazy.js";
import { errorDetails } from "./error-helpers.js";
import { cwdCombobox } from "./cwd-combobox.js";
import { ACCESSORY_IDS, getAccessory, statusBobbit } from "./session-colors.js";
import { reloadStaffList } from "./sidebar.js";
import {
	activeSidePanelTabIdForSession,
	findPanelTab,
	isHistoricalProposalTab,
	proposalPanelTabId,
	proposalRevisionFromPanelTab,
	setActivePanelTabIdForSession,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";
import "../ui/components/CommentableMarkdown.js";
import type {
	ViewMode as ProjectViewMode,
	ProposalComponent,
	ProposalWorkflow,
} from "./project-proposal-views.js";
// Workspace helpers that still live in render.ts. Importing them back is safe
// because proposal-panels.ts is itself only dynamic-imported from render.ts —
// the static graph never resolves this edge.
import { unifiedPanelTabs, setUnifiedActiveTab, workspaceSessionId } from "./render.js";
// Triggers editor (lazy). Only the `TriggerDef` type is needed here; the
// runtime module is dynamic-imported below.
import type { TriggerDef as _TriggerDef } from "./render-triggers.js";

// ──────────────────────────────────────────────────────────────────────
// isSessionArchived — used by submit handlers to skip DELETE on
// already-archived sessions.
// ──────────────────────────────────────────────────────────────────────
function isSessionArchived(sessionId: string | null | undefined): boolean {
	if (!sessionId) return false;
	return state.archivedSessions.some((s) => s.id === sessionId);
}

// ──────────────────────────────────────────────────────────────────────
// Project-proposal views — 12 kB dynamic chunk, only mounted when a
// project proposal panel is on screen.
// ──────────────────────────────────────────────────────────────────────
let _projectProposalViewsMod: typeof import("./project-proposal-views.js") | null = null;
let _projectProposalViewsLoading = false;
function ensureProjectProposalViews(): typeof import("./project-proposal-views.js") | null {
	if (_projectProposalViewsMod) return _projectProposalViewsMod;
	if (!_projectProposalViewsLoading) {
		_projectProposalViewsLoading = true;
		void import("./project-proposal-views.js").then((m) => {
			_projectProposalViewsMod = m;
			renderApp();
		});
	}
	return null;
}

// ──────────────────────────────────────────────────────────────────────
// worktreePreviewPath — moved from render.ts (only used here).
// ──────────────────────────────────────────────────────────────────────
/** Preview the worktree path that goal-manager will create. */
function worktreePreviewPath(cwd: string, title: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
	const lastSlash = normalized.lastIndexOf("/");
	const parent = lastSlash > 0 ? normalized.slice(0, lastSlash) : normalized;
	const base = lastSlash > 0 ? normalized.slice(lastSlash + 1) : normalized;
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 10) || "untitled";
	return `${parent}/${base}-wt/goal-${slug}-xxxxxxxx/`;
}

// ============================================================================

/** Cached workflows for goal creation dropdown — keyed per-project (workflows are project-scoped). */
const _workflowCacheByProject = new Map<string, Workflow[]>();
const _workflowsLoadingByProject = new Set<string>();
let _cachedWorkflows: Workflow[] = [];
let _selectedWorkflowId = "";
let _goalSandboxed = false;
let _goalAutoStartTeam = true;
let _staffSandboxed = false;
let _assistantEnabledOptionalSteps: string[] = [];

// ---- Staff proposal panel: role picker + create-in-flight state ----
// Roles fetched lazily for the proposal panel's role <select>. Mirrors
// staff-page.ts's `roles`/`ensureRolesLoaded()` but kept panel-local so the two
// surfaces never share mutable state.
let _staffProposalRoles: RoleData[] = [];
/** Current role selection in the staff proposal panel (null ⇒ "No role"). */
let _staffProposalRoleId: string | null = null;
/** Guards one-time seeding from the proposal field so re-renders don't clobber a user choice. */
let _staffProposalRoleSeeded = false;
/** Guards the lazy roles fetch. */
let _staffProposalRolesLoaded = false;
/** In-flight flag for the "Create Staff" submit — disables the button + shows "Creating…". */
let _creatingStaff = false;

/** Set the selected workflow ID from outside the render module (e.g. from a goal proposal).
 *  Normalizes against the loaded workflow cache: a proposed id that isn't a configured
 *  workflow falls back to the first available id so the dropdown's displayed option and
 *  the underlying state always agree. The post-load `normalizeWorkflowSelections()` is the
 *  safety net for the case where the cache hadn't loaded yet when this was called. */
export function setSelectedWorkflowId(id: string): void {
	_selectedWorkflowId = (_cachedWorkflows.length > 0 && !_cachedWorkflows.some(w => w.id === id))
		? (_cachedWorkflows[0]?.id ?? "")
		: id;
}

/** Normalize the workflow form selections against the loaded workflow cache.
 *  Whenever the list is available, any empty or phantom (not-in-list) selection is
 *  reset to the first available id so the rendered <select> option and the form state
 *  always agree. A value already present in the list is never clobbered. */
function normalizeWorkflowSelections(): void {
	if (_cachedWorkflows.length === 0) return;
	const ids = new Set(_cachedWorkflows.map(w => w.id));
	const first = _cachedWorkflows[0].id;
	if (!ids.has(_selectedWorkflowId)) _selectedWorkflowId = first;
	if (!ids.has(_proposalWorkflowId)) _proposalWorkflowId = first;
}

// Test affordance (mirrors main.ts's `__bobbitState` / `__bobbitRenderApp`):
// expose the assistant-panel workflow setter so browser E2E can simulate a
// goal proposal naming a workflow the project doesn't have. Carries no secrets
// and the setter is already an exported cross-module API.
try {
	(window as unknown as Record<string, unknown>).__bobbitSetSelectedWorkflowId = setSelectedWorkflowId;
} catch { /* non-window environment */ }

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
		normalizeWorkflowSelections();
		return;
	}
	if (_workflowsLoadingByProject.has(projectId)) return;
	_workflowsLoadingByProject.add(projectId);
	fetchWorkflows(projectId).then((wfs) => {
		// Always cache the per-project result, even if the active project changed
		// while this request was in flight.
		_workflowCacheByProject.set(projectId, wfs);
		_workflowsLoadingByProject.delete(projectId);
		// Only apply to the shared _cachedWorkflows / normalize / re-render if this
		// response is still for the active preview project. A stale response for a
		// project the user has navigated away from must not clobber the current
		// dropdown state.
		if (projectId !== (state.previewProjectId || undefined)) return;
		_cachedWorkflows = wfs;
		// Seed/normalize the workflow selections to a valid id once the list arrives.
		// This fixes both empty selections AND phantom ids (a proposed workflow that
		// isn't configured) that were present before the async load completed. The
		// server requires a real id (no "general" magic default), so the dropdown must
		// show a valid option from the moment it renders.
		normalizeWorkflowSelections();
		renderApp();
	});
}

/** Derive workflow-loading state for the goal form's empty-workflows banner. */
function workflowStateFor(projectId: string | undefined): "no-project" | "loading" | "empty" | "ready" {
	if (!projectId) return "no-project";
	if (_workflowCacheByProject.has(projectId)) {
		return (_workflowCacheByProject.get(projectId) || []).length === 0 ? "empty" : "ready";
	}
	return "loading";
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

/** Lazily fetch roles for the staff proposal panel's role <select>.
 *  Idempotent; mirrors staff-page.ts::ensureRolesLoaded(). Roles are optional, so
 *  fetch errors are swallowed and leave the list empty. */
async function ensureStaffProposalRolesLoaded(): Promise<void> {
	if (_staffProposalRolesLoaded) return;
	_staffProposalRolesLoaded = true;
	try {
		_staffProposalRoles = await fetchRoles();
		renderApp();
	} catch {
		/* roles are optional; leave list empty */
	}
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
// Inline-comments wrapper refs (one per commentable proposal panel).
const goalCommentableRef = createRef<import("../ui/components/CommentableMarkdown.js").CommentableMarkdown>();
const rolePromptCommentableRef = createRef<import("../ui/components/CommentableMarkdown.js").CommentableMarkdown>();
const staffPromptCommentableRef = createRef<import("../ui/components/CommentableMarkdown.js").CommentableMarkdown>();
// Annotation count fields, mirrored from <commentable-markdown> via
// the bubbled `annotation-change` event. Used to gate the badge + Send-feedback button.
let _goalAnnCount = 0;
/** Timestamp of the most recent Spec Copy click; UI flips to "Copied" for 1.5 s. */
let _specCopiedAt = 0;
async function _copySpecText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		try { document.execCommand("copy"); } catch { /* ignore */ }
		ta.remove();
	}
	_specCopiedAt = Date.now();
	renderApp();
	setTimeout(() => {
		if (Date.now() - _specCopiedAt >= 1500) renderApp();
	}, 1600);
}
let _roleAnnCount = 0;
let _staffAnnCount = 0;
// Toast text for "Proposal updated — comments cleared" notifications.
let _proposalToastText = "";
let _proposalToastTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Module-level helper to flash a brief toast above the proposal panel.
 * Reuses the existing `.review-toast` CSS (auto-fade animation).
 */
export function showProposalToast(text: string): void {
	_proposalToastText = text;
	if (_proposalToastTimer) clearTimeout(_proposalToastTimer);
	_proposalToastTimer = setTimeout(() => {
		_proposalToastText = "";
		_proposalToastTimer = null;
		renderApp();
	}, 2500);
	renderApp();
}

/** Reset annotation counts — called after a proposal is dismissed or its body is replaced. */
export function resetProposalAnnCount(type: "goal" | "role" | "staff"): void {
	if (type === "goal") _goalAnnCount = 0;
	else if (type === "role") _roleAnnCount = 0;
	else if (type === "staff") {
		_staffAnnCount = 0;
		// Re-seed the role selector from the next staff proposal's own field, and
		// drop any in-flight create state, when a fresh proposal arrives.
		_staffProposalRoleSeeded = false;
		_staffProposalRoleId = null;
		_creatingStaff = false;
	}
}

function recomputeAssistantHasProposal(): void {
	state.assistantHasProposal = PROPOSAL_TYPES.some((type) => state.activeProposals[type] != null);
}

function clearProposalReviewState(sessionId: string | null | undefined, type: ProposalType): void {
	if (!sessionId) return;
	if (type === "goal" || type === "role" || type === "staff") {
		clearProposalAnnotations(sessionId, type);
		resetProposalAnnCount(type);
	}
}

function clampUnifiedTabsAfterProposalRemoved(type: ProposalType): void {
	const tabs = unifiedPanelTabs();
	const removedId = proposalPanelTabId(type);
	const activeId = activeSidePanelTabIdForSession(state, workspaceSessionId());
	if (activeId === removedId || !findPanelTab(tabs, activeId)) {
		const fallback = tabs[0];
		if (fallback) setUnifiedActiveTab(fallback);
		else setActivePanelTabIdForSession(state, workspaceSessionId(), "");
	}
}

function dismissTypedProposal(type: ProposalType): void {
	const slot = state.activeProposals[type];
	const sessionId = slot?.sessionId ?? activeSessionId();
	clearProposalReviewState(sessionId, type);
	if (sessionId && slot?.fields) markProposalDismissed(sessionId, type, slot.fields);
	delete state.activeProposals[type];
	recomputeAssistantHasProposal();
	clampUnifiedTabsAfterProposalRemoved(type);
	if (sessionId) void deleteProposalFile(sessionId, type);
	renderApp();
}

/** Render the "comments cleared" toast above a proposal panel, if active. */
function proposalToast() {
	if (!_proposalToastText) return "";
	return html`<div class="review-toast" data-testid="proposal-toast">${_proposalToastText}</div>`;
}

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

	/** Workflow availability for the linked project. Drives the empty-workflows
	 *  banner and Accept-disabled state in the form header. */
	workflowState?: "no-project" | "loading" | "empty" | "ready";

	/** Invoked when the user clicks "Open Project Assistant" in the empty
	 *  workflows banner. */
	onOpenProjectAssistant?: () => void;

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
	/**
	 * When true, render <commentable-markdown> in Preview mode instead of
	 * <markdown-block> so users can leave inline comments. Set only at the
	 * proposal-panel call site — the goal-dashboard view stays read-only.
	 */
	commentable?: boolean;

	/** If set, this goal will be created as a subgoal of the given parent goal ID. */
	parentGoalId?: string;
	/** Callback to update the selected parent goal. Pass undefined to clear (top-level). */
	onParentGoalChange?: (id: string | undefined) => void;
	/** Whether subgoals are enabled at the system level. */
	subgoalsEnabled?: boolean;
	/** Maximum nesting depth from system prefs. */
	maxNestingDepth?: number;

	/** Current value of the per-goal "Allow subgoals" toggle. `null` means
	 *  the user has not touched it (inherit system pref). Only set in
	 *  proposal-modal mode; the goal-assistant flow leaves this undefined
	 *  so the row is not rendered (and would otherwise be a no-op there). */
	subgoalsAllowedValue?: boolean | null;
	/** Current value of the per-goal "Max nesting depth" input. `null` means
	 *  inherit system pref. Only set in proposal-modal mode. */
	maxNestingDepthValue?: number | null;
	/** Invoked when the user toggles "Allow subgoals". Presence (alongside
	 *  `onMaxNestingDepthChange`) gates rendering of the subgoals row. */
	onSubgoalsAllowedChange?: (value: boolean) => void;
	/** Invoked when the user changes the "Max depth" input. `null` means the
	 *  user cleared the field (inherit system pref). */
	onMaxNestingDepthChange?: (value: number | null) => void;

	// ---- Proposal-modal tabs (Goal / Workflow / Roles) ----
	/** When true, wrap the form body in a tabbed surface with Workflow + Roles
	 *  tabs alongside Goal. The footer stays outside the panels so submit/dismiss
	 *  remain visible on every tab. */
	tabbed?: boolean;
	activeTab?: ProposalTab;
	onTabChange?: (tab: ProposalTab) => void;

	/** Draft-scoped customised workflow. When non-null the submit path forwards
	 *  it as `workflow` instead of `workflowId`. */
	inlineWorkflow?: Workflow | null;
	onInlineWorkflowChange?: (wf: Workflow | null) => void;
	/** True when the right pane of the Workflow tab should render the editor
	 *  instead of the read-only inspector. */
	customizingWorkflow?: boolean;
	onCustomizeWorkflow?: () => void;
	onResetWorkflow?: () => void;

	/** Draft-scoped per-role override map keyed by role name. */
	inlineRoles?: Record<string, RoleData>;
	selectedRoleName?: string | null;
	onSelectRole?: (name: string) => void;
	customizingRole?: boolean;
	onCustomizeRole?: () => void;
	onResetRole?: () => void;
	onRoleDraftChange?: (patch: Partial<RoleEditorDraft>) => void;
	onRoleEditorTabChange?: (tab: "prompt" | "tools" | "model") => void;
	onRoleToggleToolGroup?: (group: string) => void;
	roleEditTab?: "prompt" | "tools" | "model";
	roleCollapsedGroups?: ReadonlySet<string>;
	roleList?: RoleData[];
	roleListLoading?: boolean;
	availableTools?: ToolInfo[];
	groupPolicies?: Record<string, string>;
}

/** Compute a goal's depth (1-based) by walking parentGoalId links. */
function computeGoalDepth(goalId: string, goals: ReadonlyArray<{ id: string; parentGoalId?: string }>): number {
	let depth = 1;
	let cur: { id: string; parentGoalId?: string } | undefined = goals.find(g => g.id === goalId);
	const seen = new Set<string>();
	while (cur?.parentGoalId && !seen.has(cur.id)) {
		seen.add(cur.id);
		cur = goals.find(g => g.id === cur!.parentGoalId);
		depth++;
		if (depth >= 20) break;
	}
	return depth;
}

function renderGoalForm(config: GoalFormConfig) {
	ensureMarkdownBlock();
	const linkedProject = config.linkedProjectId ? state.projects.find(p => p.id === config.linkedProjectId) : null;
	const wfState = config.workflowState ?? "ready";
	const noWorkflows = wfState === "empty";
	const workflowsLoading = wfState === "loading";
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
						// Prefer `optionalLabel` (the canonical opt-in toggle label after the
						// `label`/`optionalLabel` schema split). Fall back to `label` to remain
						// defensive against any stale in-memory state that pre-dates the server-
						// side `normalizeStep` migration, then to `name`.
						const toggleLabel = step.optionalLabel || step.label || step.name;
						optionalSteps.push({ name: step.name, label: toggleLabel, description: step.description, type: step.type });
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

	// When viewing a historical Goal (vN) tab, show that revision's number
	// in the panel header instead of the live slot's latest rev.
	const goalRev = (_proposalOverride?.type === "goal" ? _proposalOverride.rev : state.activeProposals.goal?.rev) ?? 0;
	const tabbed = !!config.tabbed;
	const activeTab: ProposalTab = config.activeTab ?? "goal";
	const goalBody = html`
		<div class="flex-1 overflow-y-auto px-5 pt-3 md:pt-4 pb-3 flex flex-col gap-2.5"
			role=${tabbed ? "tabpanel" : nothing}
			id=${tabbed ? "goal-proposal-panel-goal" : nothing}
			aria-labelledby=${tabbed ? "goal-proposal-tab-goal" : nothing}
			data-testid=${tabbed ? "goal-proposal-panel-goal" : nothing}>
			${goalRev > 0 ? html`<div class="text-xs text-muted-foreground -mb-1" data-testid="proposal-panel-rev">rev ${goalRev}</div>` : ""}
			${noWorkflows ? html`
				<div
					class="rounded-md border p-3 flex flex-col gap-2"
					style="border-color: color-mix(in oklch, var(--warning) 40%, transparent); background: color-mix(in oklch, var(--warning) 10%, transparent);"
					data-testid="goal-form-no-workflows-banner"
				>
					<div class="text-sm font-medium">This project has no workflows yet</div>
					<p class="text-xs text-muted-foreground">Goals need a workflow to define gates and verification. Run the project assistant to scaffold workflows for this project.</p>
					<button
						class="self-start text-xs px-3 py-1.5 rounded-md border border-border bg-background hover:bg-secondary text-foreground"
						@click=${config.onOpenProjectAssistant}
						data-testid="goal-form-open-project-assistant"
						?disabled=${!config.onOpenProjectAssistant}
					>Open Project Assistant</button>
				</div>
			` : ""}
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
				${workflowsLoading ? html`
					<div class="flex items-center gap-2 md:shrink-0">
						<label class="${lblCls} w-20 md:w-auto">Workflow</label>
						<div class="flex-1 md:flex-none md:w-44 h-9 rounded-md bg-muted/40 animate-pulse" data-testid="goal-form-workflow-skeleton"></div>
					</div>
				` : _cachedWorkflows.length > 0 ? html`
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
			${(config.subgoalsEnabled || config.parentGoalId) ? html`
				<div class="flex items-center gap-2" data-testid="goal-form-parent-row">
					<label class="${lblCls} w-20 md:w-16">Parent</label>
					<select
						class="flex-1 text-sm px-2 py-1.5 rounded-md border border-border bg-background text-foreground h-9"
						.value=${config.parentGoalId || ""}
						@change=${(e: Event) => {
							const v = (e.target as HTMLSelectElement).value;
							config.onParentGoalChange?.(v || undefined);
						}}
						data-testid="goal-form-parent-picker"
					>
						<option value="">— Top-level goal —</option>
						${state.goals.filter(g => !g.archived && (!config.linkedProjectId || g.projectId === config.linkedProjectId)).map(g => html`
							<option value=${g.id} ?selected=${config.parentGoalId === g.id}>${g.title}</option>
						`)}
					</select>
				</div>
			` : ""}
			${config.parentGoalId ? (() => {
				const parentGoal = state.goals.find(g => g.id === config.parentGoalId);
				const project = config.linkedProjectId ? state.projects.find(p => p.id === config.linkedProjectId) : null;
				const parentDepth = config.parentGoalId ? computeGoalDepth(config.parentGoalId, state.goals) : 0;
				const childDepth = parentDepth + 1;
				const atCap = config.maxNestingDepth !== undefined && childDepth >= config.maxNestingDepth;
				return html`
					<div class="flex flex-col gap-1 text-xs text-muted-foreground">
						<div class="truncate" data-testid="goal-form-breadcrumb">
							${project ? html`<span class="font-medium text-foreground/70">${project.name}</span><span class="mx-1 opacity-50">›</span>` : ""}
							${parentGoal ? html`<span>${parentGoal.title}</span><span class="mx-1 opacity-50">›</span>` : ""}
							<span class="font-medium text-foreground/80">${config.title || "New Goal"}</span>
						</div>
						<div class="${atCap ? "text-destructive font-medium" : ""}" data-testid="goal-form-depth-indicator">
							depth ${childDepth} of ${config.maxNestingDepth ?? 3}${atCap ? " — cap reached" : ""}
						</div>
						<div class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary self-start" data-testid="goal-form-subgoal-badge">
							Subgoal of ${parentGoal?.title ?? config.parentGoalId}
						</div>
					</div>
				`;
			})() : (config.subgoalsEnabled ? html`
				<div class="text-xs text-muted-foreground self-start px-2 py-0.5 rounded-full bg-secondary/60" data-testid="goal-form-toplevel-badge">Top-level goal</div>
			` : "")}
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
				${(config.subgoalsEnabled && config.onSubgoalsAllowedChange && config.onMaxNestingDepthChange) ? (() => {
					const systemCap = config.maxNestingDepth ?? 3;
					const allowed = config.subgoalsAllowedValue ?? config.subgoalsEnabled;
					const depthValue = config.maxNestingDepthValue ?? systemCap;
					return html`
						<label class="flex items-center gap-1.5 cursor-pointer">
							<input type="checkbox" class="toggle-switch"
								.checked=${allowed}
								data-testid="goal-form-subgoals-toggle"
								@change=${(e: Event) => {
									config.onSubgoalsAllowedChange?.((e.target as HTMLInputElement).checked);
								}} />
							<span class="text-xs text-muted-foreground font-medium">Allow subgoals</span>
							<span title="Allow this goal to spawn child subgoals. When off, the team-lead cannot use goal_spawn_child / goal_plan_propose."
								class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
						</label>
						${allowed ? html`
							<label class="flex items-center gap-1.5 text-xs text-muted-foreground -ml-2">
								<span>Max depth</span>
								<input
									type="number"
									min="1"
									max=${String(systemCap)}
									step="1"
									.value=${String(depthValue)}
									data-testid="goal-form-max-depth"
									class="w-12 text-xs px-1.5 py-0.5 rounded border border-border bg-background text-foreground"
									@change=${(e: Event) => {
										const raw = parseInt((e.target as HTMLInputElement).value, 10);
										if (Number.isFinite(raw)) {
											config.onMaxNestingDepthChange?.(Math.min(systemCap, Math.max(1, raw)));
										} else {
											config.onMaxNestingDepthChange?.(null);
										}
									}} />
								<span title=${`System cap is ${systemCap} — per-goal can tighten further, never exceed it`}
									class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
							</label>
						` : ""}
					`;
				})() : ""}
			</div>
			<div class="flex-1 flex flex-col min-h-0">
				<div class="flex items-center justify-between mb-1.5">
					<div class="flex items-center gap-1">
						<label class="text-xs text-muted-foreground font-medium">Spec</label>
						${config.commentable && !config.specEditMode && _goalAnnCount > 0 ? html`
							<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary"
								data-testid="proposal-comment-count">
								${_goalAnnCount} comment${_goalAnnCount === 1 ? "" : "s"}
							</span>
						` : ""}
					</div>
					<div class="flex items-center gap-1">
						${(() => {
							const justCopied = Date.now() - _specCopiedAt < 1500;
							return html`<button
								class="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-border ${justCopied ? "text-primary border-primary" : "text-muted-foreground hover:text-foreground hover:bg-secondary"} transition-colors"
								title="Copy spec markdown"
								@click=${() => _copySpecText(config.spec)}
							>
								${icon(justCopied ? Check : Copy, "xs")}
								<span>${justCopied ? "Copied" : "Copy"}</span>
							</button>`;
						})()}
						<button
							class="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
							title="Toggle edit/preview mode"
							@click=${config.onSpecEditToggle}
						>
							${icon(config.specEditMode ? Eye : Pencil, "xs")}
							<span>${config.specEditMode ? "Preview" : "Edit"}</span>
						</button>
					</div>
				</div>
				${config.specEditMode
					? html`<textarea
							${ref(goalSpecTextareaRef)}
							class="flex-1 min-h-[200px] p-3 text-sm font-mono rounded-md border border-border bg-background text-foreground resize-y focus:outline-none focus:ring-1 focus:ring-ring ${config.streaming ? STREAMING_BORDER : ""}"
							.value=${config.spec}
							@input=${config.onSpecChange}
						></textarea>`
					: html`<div ${ref(goalSpecPreviewRef)} class="flex-1 min-h-[200px] p-3 rounded-md border border-border bg-secondary/30 overflow-y-auto text-sm ${config.streaming ? STREAMING_BORDER : ""}">
							${config.commentable
								? html`<commentable-markdown
										${ref(goalCommentableRef)}
										.markdown=${config.spec || "_No spec content yet_"}
										.sessionId=${activeSessionId() || ""}
										.bucket=${"proposal:goal"}
										@annotation-change=${(e: CustomEvent) => { _goalAnnCount = e.detail?.count ?? 0; renderApp(); }}
									></commentable-markdown>`
								: html`<markdown-block .content=${config.spec || "_No spec content yet_"}></markdown-block>`}
						</div>`
				}
			</div>
		</div>
	`;
	const footer = html`
		<div class="shrink-0 flex flex-col gap-3 px-5 py-3 border-t border-border">
			<div class="flex items-center justify-end gap-2">
				${config.streaming ? streamingBadge() : ""}
				${config.commentable && _goalAnnCount > 0 && !config.streaming ? Button({
					variant: "secondary",
					onClick: () => {
						const el = goalCommentableRef.value;
						if (!el) return;
						const text = el.sendFeedback();
						if (text && state.remoteAgent) {
							state.remoteAgent.prompt(text);
						}
						_goalAnnCount = 0;
						renderApp();
					},
					children: html`<span data-testid="proposal-send-feedback">Send feedback (${_goalAnnCount})</span>`,
				}) : ""}
				${config.onDismiss ? Button({ variant: "ghost", onClick: config.onDismiss, children: "Dismiss" }) : ""}
				<span
					data-testid="proposal-primary-submit"
					title=${noWorkflows ? "This project has no workflows yet — run the project assistant first." : ""}
				>${Button({
					variant: "default",
					onClick: config.onCreate,
					disabled: (config.createDisabled ?? !config.title.trim()) || !!config.streaming || noWorkflows,
					children: config.saving ? "Creating…" : html`<span class="inline-flex items-center gap-1.5">${icon(GoalIcon, "sm")} Create Goal</span>`,
				})}</span>
			</div>
		</div>
	`;
	if (!tabbed) {
		return html`${goalBody}${footer}`;
	}
	const onTabChange = (t: ProposalTab) => config.onTabChange?.(t);
	const onTabKey = (e: KeyboardEvent) => {
		const order: ProposalTab[] = ["goal", "workflow", "roles"];
		const i = order.indexOf(activeTab);
		if (e.key === "ArrowRight") { e.preventDefault(); onTabChange(order[(i + 1) % order.length]); }
		else if (e.key === "ArrowLeft") { e.preventDefault(); onTabChange(order[(i - 1 + order.length) % order.length]); }
		else if (e.key === "Home") { e.preventDefault(); onTabChange(order[0]); }
		else if (e.key === "End") { e.preventDefault(); onTabChange(order[order.length - 1]); }
	};
	const tabCls = (selected: boolean) => "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors " + (selected
		? "border-primary text-foreground"
		: "border-transparent text-muted-foreground hover:text-foreground");
	// Static literal testids so the source-pin tests can detect them via text search.
	const tabBar = html`
		<div role="tablist" aria-label="Goal proposal sections"
			class="shrink-0 flex items-center gap-1 px-5 pt-2 border-b border-border">
			<button
				role="tab"
				id="goal-proposal-tab-goal"
				data-testid="goal-proposal-tab-goal"
				aria-selected=${activeTab === "goal" ? "true" : "false"}
				aria-controls="goal-proposal-panel-goal"
				tabindex=${activeTab === "goal" ? 0 : -1}
				class=${tabCls(activeTab === "goal")}
				@click=${() => onTabChange("goal")}
				@keydown=${onTabKey}
			>Goal</button>
			<button
				role="tab"
				id="goal-proposal-tab-workflow"
				data-testid="goal-proposal-tab-workflow"
				aria-selected=${activeTab === "workflow" ? "true" : "false"}
				aria-controls="goal-proposal-panel-workflow"
				tabindex=${activeTab === "workflow" ? 0 : -1}
				class=${tabCls(activeTab === "workflow")}
				@click=${() => onTabChange("workflow")}
				@keydown=${onTabKey}
			>Workflow</button>
			<button
				role="tab"
				id="goal-proposal-tab-roles"
				data-testid="goal-proposal-tab-roles"
				aria-selected=${activeTab === "roles" ? "true" : "false"}
				aria-controls="goal-proposal-panel-roles"
				tabindex=${activeTab === "roles" ? 0 : -1}
				class=${tabCls(activeTab === "roles")}
				@click=${() => onTabChange("roles")}
				@keydown=${onTabKey}
			>Roles</button>
		</div>
	`;
	const panel = activeTab === "goal"
		? goalBody
		: activeTab === "workflow"
			? renderProposalWorkflowTab(config)
			: renderProposalRolesTab(config);
	return html`${tabBar}${panel}${footer}`;
}

// ============================================================================
// PROPOSAL MODAL — WORKFLOW TAB
//
// Reuses renderWorkflowList / renderWorkflowInspector / renderWorkflowEditor
// exported from src/app/workflow-page.ts so the DOM matches the main Workflows
// page exactly. The editor runs in `goal-draft` scope: every mutation flows
// back through `config.onInlineWorkflowChange` and NEVER mutates the project
// workflow store.
// ============================================================================
function renderProposalWorkflowTab(config: GoalFormConfig): TemplateResult {
	const selectedId = config.workflowId;
	const workflows = _cachedWorkflows;
	const inline = config.inlineWorkflow ?? null;
	const customizing = !!config.customizingWorkflow && !!inline;
	const selectedLibrary = workflows.find((w) => w.id === selectedId) ?? workflows[0] ?? null;
	const displayWf = inline ?? selectedLibrary;
	const dirtyIds = new Set<string>();
	if (inline) dirtyIds.add(inline.id);
	return html`
		<div class="flex-1 overflow-hidden flex min-h-0"
			role="tabpanel"
			id="goal-proposal-panel-workflow"
			aria-labelledby="goal-proposal-tab-workflow"
			data-testid="goal-proposal-panel-workflow">
			<div class="w-64 shrink-0 border-r border-border overflow-y-auto p-3">
				${workflows.length === 0
					? html`<p class="text-xs text-muted-foreground">No workflows available for this project.</p>`
					: renderWorkflowList({
						workflows,
						selectedId,
						dirtyIds,
						onSelect: (wf) => {
							const ev = new Event("change");
							Object.defineProperty(ev, "target", { value: { value: wf.id } });
							config.onWorkflowChange(ev);
							config.onResetWorkflow?.();
						},
						scope: "goal-draft",
					})}
			</div>
			<div class="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-w-0">
				<div class="flex items-center justify-end gap-2">
					${customizing
						? Button({
								variant: "ghost",
								size: "sm",
								onClick: () => config.onResetWorkflow?.(),
								children: html`<span data-testid="goal-proposal-workflow-reset">Reset to selected</span>`,
						  })
						: Button({
								variant: "secondary",
								size: "sm",
								onClick: () => config.onCustomizeWorkflow?.(),
								disabled: !selectedLibrary,
								children: html`<span data-testid="goal-proposal-workflow-customize">Customize for this goal</span>`,
						  })}
				</div>
				${customizing && inline
					? renderWorkflowEditor({
						workflow: inline,
						onChange: (wf) => config.onInlineWorkflowChange?.(wf),
						scope: "goal-draft",
					})
					: renderWorkflowInspector({ workflow: displayWf, scope: "goal-draft" })}
			</div>
		</div>
	`;
}

// ============================================================================
// PROPOSAL MODAL — ROLES TAB
//
// Reuses renderRoleList / renderRoleInspector / renderRoleEditor exported
// from src/app/role-manager-page.ts. Customisations are kept in a
// per-role-name map (`inlineRoles`) and only the subset the user actually
// touched is forwarded to createGoal at submit time.
// ============================================================================
function renderProposalRolesTab(config: GoalFormConfig): TemplateResult {
	const roles = config.roleList ?? [];
	const selectedName = config.selectedRoleName ?? null;
	const inlineMap = config.inlineRoles ?? {};
	const customizedNames = new Set(Object.keys(inlineMap));
	const selectedLibraryRole = roles.find((r) => r.name === selectedName) ?? roles[0] ?? null;
	const inlineSelected = selectedName ? inlineMap[selectedName] : undefined;
	const displayRole = inlineSelected ?? selectedLibraryRole;
	const customizing = !!config.customizingRole && !!inlineSelected;
	const availableTools = config.availableTools ?? [];
	const groupPolicies = config.groupPolicies ?? {};
	const draft: RoleEditorDraft | null = displayRole ? {
		label: displayRole.label,
		promptTemplate: displayRole.promptTemplate,
		accessory: displayRole.accessory ?? "none",
		toolPolicies: { ...(displayRole.toolPolicies ?? {}) },
		model: displayRole.model ?? "",
		thinkingLevel: displayRole.thinkingLevel ?? "",
		activeTab: config.roleEditTab ?? "prompt",
	} : null;
	return html`
		<div class="flex-1 overflow-hidden flex min-h-0"
			role="tabpanel"
			id="goal-proposal-panel-roles"
			aria-labelledby="goal-proposal-tab-roles"
			data-testid="goal-proposal-panel-roles">
			<div class="w-64 shrink-0 border-r border-border overflow-y-auto p-3">
				${config.roleListLoading
					? html`<p class="text-xs text-muted-foreground">Loading roles…</p>`
					: roles.length === 0
						? html`<p class="text-xs text-muted-foreground">No roles available.</p>`
						: renderRoleList({
							roles,
							selectedName,
							customizedNames,
							onSelect: (r) => config.onSelectRole?.(r.name),
							scope: "goal-draft",
						})}
			</div>
			<div class="flex-1 overflow-y-auto p-3 flex flex-col gap-2 min-w-0">
				<div class="flex items-center justify-end gap-2">
					${displayRole ? (customizing
						? Button({
								variant: "ghost",
								size: "sm",
								onClick: () => config.onResetRole?.(),
								children: html`<span data-testid="goal-proposal-role-reset">Reset to default</span>`,
						  })
						: Button({
								variant: "secondary",
								size: "sm",
								onClick: () => config.onCustomizeRole?.(),
								children: html`<span data-testid="goal-proposal-role-customize">Customize for this goal</span>`,
						  })) : nothing}
				</div>
				${displayRole && draft
					? (customizing
						? renderRoleEditor({
							role: displayRole,
							draft,
							availableTools,
							groupPolicies,
							collapsedToolGroups: config.roleCollapsedGroups ?? new Set<string>(),
							callbacks: {
								onDraftChange: (patch) => config.onRoleDraftChange?.(patch),
								onTabChange: (tab) => config.onRoleEditorTabChange?.(tab),
								onToggleToolGroup: (g) => config.onRoleToggleToolGroup?.(g),
							},
							scope: "goal-draft",
						})
						: renderRoleInspector({
							role: displayRole,
							availableTools,
							groupPolicies,
							scope: "goal-draft",
						}))
					: html`<p class="text-xs text-muted-foreground">Select a role from the list to inspect or customise it.</p>`}
			</div>
		</div>
	`;
}

function goalPreviewPanel() {
	// Populate previewProjectId for re-attempt / assistant sessions where it
	// wasn't seeded by the +New Goal picker. Resolution order:
	// 1. Active session's projectId (server inherits this for re-attempts).
	// 2. Original goal's projectId via reattemptGoalId.
	// 3. Match proposal cwd against a registered project's rootPath.
	if (!state.previewProjectId) {
		const sid = activeSessionId();
		const sess = sid ? state.gatewaySessions.find(s => s.id === sid) : undefined;
		let candidate = sess?.projectId;
		if (!candidate && sess?.reattemptGoalId) {
			candidate = state.goals.find(g => g.id === sess.reattemptGoalId)?.projectId;
		}
		if (!candidate) {
			const cwd = (state.activeProposals.goal?.fields as any)?.cwd as string | undefined;
			if (cwd) {
				const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
				const target = norm(cwd);
				candidate = state.projects.find(p => norm(p.rootPath) === target)?.id;
			}
		}
		if (candidate && state.projects.some(p => p.id === candidate)) {
			state.previewProjectId = candidate;
		}
	}
	ensureWorkflowsLoaded(state.previewProjectId || undefined);
	ensureSandboxStatusLoaded();

	const handleCreateGoal = async () => {
		const trimmedTitle = state.previewTitle.trim();
		if (!trimmedTitle) return;
		if (!state.previewProjectId) {
			showConnectionError("No project selected for this goal", "Select a project from the + New Goal picker before creating a goal.");
			return;
		}
		// Guard: refuse to accept while the linked project has no workflows.
		// The form's banner handles the affordance; this is the defensive backstop.
		if (workflowStateFor(state.previewProjectId) === "empty") {
			showConnectionError(
				"This project has no workflows yet",
				"Run the project assistant from the goal panel banner (or Settings → Components) to scaffold workflows before creating a goal.",
			);
			return;
		}

		// Snapshot form state up-front so a retry after createGoal() rejection
		// reads the latest values (the user may have edited the workflow id /
		// title between attempts).
		const sessionId = activeSessionId();
		const projectId = state.previewProjectId || undefined;
		const workflowId = _selectedWorkflowId || undefined;
		const sandboxed = _goalSandboxed;
		const autoStartTeam = _goalAutoStartTeam;
		const enabledOptionalSteps = _assistantEnabledOptionalSteps.length > 0 ? _assistantEnabledOptionalSteps : undefined;
		const currentSession = state.gatewaySessions.find(s => s.id === sessionId);
		const reattemptGoalId = currentSession?.reattemptGoalId;

		// Await the server FIRST. If it rejects, leave the assistant session,
		// draft, gateway.sessionId, and form state intact so the user can edit
		// (e.g. change workflow) and try again. See goal spec §1.
		let goal;
		try {
			goal = await createGoal(trimmedTitle, state.previewCwd.trim(), {
				spec: state.previewSpec,
				workflowId,
				reattemptOf: reattemptGoalId || undefined,
				sandboxed,
				projectId,
				enabledOptionalSteps,
				autoStartTeam,
			});
		} catch (err) {
			const { message, code, stack } = errorDetails(err);
			showConnectionError("Failed to create goal", message, { code, stack });
			return;
		}
		if (!goal) {
			// createGoal() returns falsy on certain server errors (the helper
			// already surfaces a toast). Preserve the assistant either way.
			return;
		}

		// --- Success path: now tear down the assistant. ---
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
		state.assistantType = null;
		if (sessionId) clearProposalAnnotations(sessionId, "goal");
		resetProposalAnnCount("goal");
		delete state.activeProposals.goal;
		state.previewProjectId = "";
		_selectedWorkflowId = "";
		_goalSandboxed = false;
		_goalAutoStartTeam = true;
		_assistantEnabledOptionalSteps = [];
		if (sessionId) {
			deleteGoalDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");
		state.appView = "authenticated";

		// Slice E: drop the on-disk proposal file once accepted.
		if (sessionId) void deleteProposalFile(sessionId, "goal");

		// If this is a re-attempt, archive the old goal and link the new one
		if (reattemptGoalId) {
			await gatewayFetch(`/api/goals/${reattemptGoalId}`, { method: "DELETE" });
			await gatewayFetch(`/api/goals/${goal.id}`, {
				method: "PUT",
				body: JSON.stringify({ reattemptOf: reattemptGoalId }),
			});
		}

		if (sessionId && !isSessionArchived(sessionId)) {
			await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
			clearSessionModel(sessionId);
		}
		await refreshSessions();
		setHashRoute("goal-dashboard", goal.id, true);
		renderApp();
	};

	const handleOpenProjectAssistant = async () => {
		const linked = state.previewProjectId ? state.projects.find(p => p.id === state.previewProjectId) : null;
		if (!linked) return;
		const { createProjectAssistantSession } = await import("./dialogs.js");
		await createProjectAssistantSession(linked.rootPath, false, { projectId: linked.id, existingProjectName: linked.name || "" });
	};

	const isHistorical = _proposalOverride?.type === "goal";
	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0 relative" data-panel="goal-proposal" data-historical-proposal=${isHistorical ? "true" : "false"}>
			${proposalToast()}
			${renderGoalForm({
				title: state.previewTitle,
				spec: state.previewSpec,
				cwd: state.previewCwd,
				workflowId: _selectedWorkflowId,
				sandboxed: _goalSandboxed,
				specEditMode: state.previewSpecEditMode,
				enabledOptionalSteps: _assistantEnabledOptionalSteps,
				linkedProjectId: state.previewProjectId || undefined,
				workflowState: workflowStateFor(state.previewProjectId || undefined),
				onOpenProjectAssistant: handleOpenProjectAssistant,
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
				commentable: true,
			})}
		</div>
	`;
}

// ============================================================================
// ROLE PREVIEW PANEL (role assistant split-screen)
// ============================================================================


/** Cached available tools list (loaded once). */
let _availableTools: ToolInfo[] = [];
let _toolsLoaded = false;

function ensureToolsLoaded(): void {
	if (_toolsLoaded) return;
	_toolsLoaded = true;
	fetchTools().then((tools) => { _availableTools = tools; renderApp(); });
}

function rolePreviewPanel() {
	ensureMarkdownBlock();
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
		const proposalSessionId = state.activeProposals.role?.sessionId ?? activeSessionId();
		const isRoleAssistant = state.assistantType === "role";

		// Parse tools: comma-separated string -> array
		const toolsList = state.rolePreviewTools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		// Convert tools list to toolPolicies (all explicitly listed tools get "allow")
		const toolPolicies: Record<string, string> = {};
		for (const t of toolsList) toolPolicies[t] = "allow";

		const created = await createRole({
			name: trimmedName,
			label: trimmedLabel,
			promptTemplate: state.rolePreviewPrompt,
			toolPolicies: Object.keys(toolPolicies).length > 0 ? toolPolicies : undefined,
			accessory: state.rolePreviewAccessory,
		});
		if (!created) return;

		clearProposalReviewState(proposalSessionId, "role");
		delete state.activeProposals.role;
		recomputeAssistantHasProposal();
		clampUnifiedTabsAfterProposalRemoved("role");
		if (proposalSessionId) {
			deleteRoleDraft(proposalSessionId);
			void deleteProposalFile(proposalSessionId, "role");
		}

		if (isRoleAssistant) {
			if (state.remoteAgent) {
				state.remoteAgent.disconnect();
				state.remoteAgent = null;
				state.connectionStatus = "disconnected";
			}
			state.assistantType = null;
			localStorage.removeItem("gateway.sessionId");
			if (proposalSessionId && !isSessionArchived(proposalSessionId)) {
				await gatewayFetch(`/api/sessions/${proposalSessionId}`, { method: "DELETE" });
				clearSessionModel(proposalSessionId);
			}
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
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0 relative" data-panel="role-proposal">
			${proposalToast()}
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
						<div class="flex items-center gap-1">
							<label class="text-xs text-muted-foreground font-medium">System Prompt</label>
							${!state.rolePreviewPromptEditMode && _roleAnnCount > 0 ? html`
								<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary"
									data-testid="proposal-comment-count">
									${_roleAnnCount} comment${_roleAnnCount === 1 ? "" : "s"}
								</span>
							` : ""}
						</div>
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
								<commentable-markdown
									${ref(rolePromptCommentableRef)}
									.markdown=${state.rolePreviewPrompt || "_No prompt content yet_"}
									.sessionId=${activeSessionId() || ""}
									.bucket=${"proposal:role"}
									@annotation-change=${(e: CustomEvent) => { _roleAnnCount = e.detail?.count ?? 0; renderApp(); }}
								></commentable-markdown>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${streaming ? streamingBadge() : ""}
				${_roleAnnCount > 0 && !streaming ? Button({
					variant: "secondary",
					onClick: () => {
						const el = rolePromptCommentableRef.value;
						if (!el) return;
						const text = el.sendFeedback();
						if (text && state.remoteAgent) {
							state.remoteAgent.prompt(text);
						}
						_roleAnnCount = 0;
						renderApp();
					},
					children: html`<span data-testid="proposal-send-feedback">Send feedback (${_roleAnnCount})</span>`,
				}) : ""}
				${!state.assistantType ? Button({ variant: "ghost", onClick: () => dismissTypedProposal("role"), children: "Dismiss" }) : ""}
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
	ensureMarkdownBlock();
	const streaming = isProposalStreaming("tool_proposal");
	queueMicrotask(() => {
		reconcileFollowTail(toolDocsPreviewRef.value);
		reconcileFollowTail(toolRendererPreviewRef.value);
		reconcileFollowTail(toolOuterScrollRef.value);
	});
	const handleDone = () => {
		if (state.assistantType === "tool") {
			backToSessions();
			return;
		}
		dismissTypedProposal("tool");
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
				${Button({ variant: "ghost", onClick: handleDone, children: state.assistantType === "tool" ? "Close" : "Dismiss" })}
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


// ── Trigger editor (lazy module) ─────────────────────────────────────
//
// The trigger editor (~10 kB of templates) lives in `./render-triggers.js`
// and only loads when the staff-assistant proposal panel is on screen.
// Until the chunk lands the proxies below return a JSON-only fallback
// for `parseTriggers` + a placeholder for the editor; the panel re-renders
// once the module resolves.
let _triggersMod: typeof import("./render-triggers.js") | null = null;
let _triggersModLoading = false;
function ensureTriggersMod(): typeof import("./render-triggers.js") | null {
	if (_triggersMod) return _triggersMod;
	if (!_triggersModLoading) {
		_triggersModLoading = true;
		void import("./render-triggers.js").then((m) => {
			_triggersMod = m;
			renderApp();
		});
	}
	return null;
}

function parseTriggers(json: string): _TriggerDef[] {
	const mod = ensureTriggersMod();
	if (mod) return mod.parseTriggers(json);
	// Pure JSON parse — safe to inline as the synchronous fallback so the
	// "+ Add trigger" button works even before the editor chunk lands.
	try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch { return []; }
}

function renderTriggersEditor() {
	const mod = ensureTriggersMod();
	if (!mod) {
		return html`<div class="text-xs text-muted-foreground italic p-3 border border-dashed border-border rounded-md">Loading triggers editor…</div>`;
	}
	return mod.renderTriggersEditor();
}

function hasInvalidGoalTriggersForPreview(): boolean {
	const mod = ensureTriggersMod();
	// Until the editor chunk lands no trigger UI has been mounted, so
	// nothing could be in an invalid-prompt state — return false.
	return mod ? mod.hasInvalidGoalTriggersForPreview() : false;
}

function staffPreviewSessionId(): string | undefined {
	return state.activeProposals.staff?.sessionId || activeSessionId();
}

function staffPreviewProjectId(sessionId = staffPreviewSessionId()): string | undefined {
	if (!sessionId) return undefined;
	const session = state.gatewaySessions.find(s => s.id === sessionId)
		|| state.archivedSessions.find(s => s.id === sessionId);
	if (session?.projectId) return session.projectId;
	const activeId = activeSessionId();
	if (sessionId === activeId || sessionId === state.selectedSessionId || sessionId === state.remoteAgent?.gatewaySessionId) {
		return state.chatPanel?.agentInterface?.projectId || undefined;
	}
	return undefined;
}

function activeProjectForStaffPreview() {
	const projectId = staffPreviewProjectId();
	return projectId
		? state.projects.find(p => p.id === projectId)
		: undefined;
}

function effectiveStaffPreviewCwd(project = activeProjectForStaffPreview()): string | undefined {
	const explicitCwd = state.staffPreviewCwd.trim();
	if (explicitCwd) return explicitCwd;
	return project?.rootPath || undefined;
}

function seedStaffPreviewCwdFromProject(project = activeProjectForStaffPreview()): void {
	if (state.staffPreviewCwdEdited || state.staffPreviewCwd.trim()) return;
	if (project?.rootPath) state.staffPreviewCwd = project.rootPath;
}

function staffPreviewPanel() {
	ensureMarkdownBlock();
	ensureSandboxStatusLoaded();
	void ensureStaffProposalRolesLoaded();
	// Seed the role selector once from the proposal's own `role` field. Guarded so
	// re-renders never clobber a user choice; reset on a fresh proposal (see
	// resetProposalAnnCount).
	if (!_staffProposalRoleSeeded) {
		const seededRole = state.activeProposals.staff?.fields?.role;
		_staffProposalRoleId = typeof seededRole === "string" && seededRole.trim()
			? seededRole.trim()
			: null;
		_staffProposalRoleSeeded = true;
	}
	const staffProject = activeProjectForStaffPreview();
	seedStaffPreviewCwdFromProject(staffProject);
	const streaming = isProposalStreaming("staff_proposal");
	const effectiveCwd = effectiveStaffPreviewCwd(staffProject);
	queueMicrotask(() => {
		reconcileFollowTail(staffPromptPreviewRef.value);
		reconcileFollowTail(staffPromptTextareaRef.value);
	});
	const handleCreateStaff = async () => {
		// Re-entrancy guard — belt-and-braces alongside the disabled button.
		if (_creatingStaff) return;
		const trimmedName = state.staffPreviewName.trim();
		if (!trimmedName) return;
		// Block create if any goal-* trigger lacks a prompt. The submit button is
		// also disabled in this state; this is a belt-and-braces guard.
		if (hasInvalidGoalTriggersForPreview()) return;
		const proposalSessionId = staffPreviewSessionId();
		const isStaffAssistant = state.assistantType === "staff";

		let triggers: any[] = [];
		try {
			triggers = JSON.parse(state.staffPreviewTriggers);
		} catch { /* keep empty */ }

		const sandboxed = _staffSandboxed;
		const submitProjectId = staffPreviewProjectId();
		const submitProject = submitProjectId
			? state.projects.find(p => p.id === submitProjectId)
			: undefined;
		const cwd = effectiveStaffPreviewCwd(submitProject);
		// Optional role from the panel's role <select> (null/empty ⇒ no role).
		// Unknown roles are rejected server-side (404) — no extra client validation.
		const roleId = _staffProposalRoleId && _staffProposalRoleId.trim()
			? _staffProposalRoleId.trim()
			: undefined;

		// In-flight: disable the submit/dismiss buttons + show "Creating…". Cleared
		// in `finally` so the button re-enables for retry on error (the early
		// `if (!result) return` keeps the panel + assistant session open).
		_creatingStaff = true;
		renderApp();
		try {
			const result = await createStaffAgent({
				name: trimmedName,
				description: state.staffPreviewDescription,
				systemPrompt: state.staffPreviewPrompt,
				cwd,
				worktree: state.staffPreviewWorktree,
				triggers,
				projectId: submitProjectId,
				sandboxed,
				roleId,
			});
			if (!result) return;

			_staffSandboxed = false;
			state.staffPreviewWorktree = true;
			clearProposalReviewState(proposalSessionId, "staff");
			delete state.activeProposals.staff;
			recomputeAssistantHasProposal();
			clampUnifiedTabsAfterProposalRemoved("staff");
			if (proposalSessionId) void deleteProposalFile(proposalSessionId, "staff");

			if (isStaffAssistant) {
				if (state.remoteAgent) {
					state.remoteAgent.disconnect();
					state.remoteAgent = null;
					state.connectionStatus = "disconnected";
				}
				state.assistantType = null;
				localStorage.removeItem("gateway.sessionId");
				setHashRoute("landing");
				state.appView = "authenticated";
				if (proposalSessionId && !isSessionArchived(proposalSessionId)) {
					await gatewayFetch(`/api/sessions/${proposalSessionId}`, { method: "DELETE" });
					clearSessionModel(proposalSessionId);
				}
			}

			reloadStaffList();
			await refreshSessions();
			if (result?.currentSessionId) {
				const { connectToSession } = await import("./session-manager.js");
				await connectToSession(result.currentSessionId, false);
			}
		} finally {
			_creatingStaff = false;
			renderApp();
		}
	};

	return html`
		<div class="goal-preview-panel flex-1 flex flex-col border-l border-border min-h-0 relative" data-panel="staff-proposal">
			${proposalToast()}
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
				<div data-testid="staff-proposal-cwd-field">
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Working Directory</label>
					<input
						type="text"
						data-testid="staff-proposal-cwd-input"
						class="flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm md:text-sm text-foreground shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] dark:bg-input/30"
						.value=${state.staffPreviewCwd}
						placeholder=${staffProject?.rootPath || "Project working directory"}
						@input=${(e: Event) => {
							state.staffPreviewCwd = (e.target as HTMLInputElement).value;
							state.staffPreviewCwdEdited = true;
						}}
					/>
					<p class="mt-1 text-[11px] text-muted-foreground" data-testid="staff-proposal-cwd-hint">
						${staffProject
							? html`Selected project: <span class="font-medium text-foreground/80">${staffProject.name}</span> · <code class="text-[10px]">${staffProject.rootPath}</code>`
							: effectiveCwd
								? html`Using <code class="text-[10px]">${effectiveCwd}</code>`
								: "No project cwd is available; the server will validate the request."}
					</p>
				</div>
				<div data-testid="staff-proposal-worktree-control">
					<label class="flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							data-testid="staff-proposal-worktree-checkbox"
							.checked=${state.staffPreviewWorktree}
							@change=${(e: Event) => {
								state.staffPreviewWorktree = (e.target as HTMLInputElement).checked;
								renderApp();
							}}
						/>
						<span class="text-xs text-muted-foreground font-medium">Create worktree when supported</span>
						<span title="Uses an isolated project worktree for git-backed projects. Turn off to run directly in the project directory."
							class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
					</label>
					<p class="mt-1 text-[11px] text-muted-foreground" data-testid="staff-proposal-worktree-mode">
						${state.staffPreviewWorktree
							? "Auto: Bobbit will use a project worktree when supported."
							: "Opt-out: this staff agent will run in the project directory."}
					</p>
				</div>
				<div>
					<label class="flex items-center gap-1.5 cursor-pointer ${!(state.sandboxStatus?.available && state.sandboxStatus?.imageExists) ? "opacity-40 pointer-events-none" : ""}">
						<input type="checkbox" class="toggle-switch" .checked=${_staffSandboxed}
							?disabled=${!(state.sandboxStatus?.available && state.sandboxStatus?.imageExists)}
							@change=${(e: Event) => { _staffSandboxed = (e.target as HTMLInputElement).checked; renderApp(); }} />
						<span class="text-xs text-muted-foreground font-medium">Sandbox (Docker)</span>
						<span title=${!(state.sandboxStatus?.available && state.sandboxStatus?.imageExists)
							? "Docker sandbox is configured but unavailable — check Docker status and image in Settings"
							: "Runs this staff agent in an isolated Docker container with restricted filesystem and network access"}
							class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
					</label>
				</div>
				<div data-testid="staff-proposal-role-picker">
					<label class="text-xs text-muted-foreground mb-1.5 block font-medium">Role</label>
					<p class="text-[10px] text-muted-foreground mb-1">Optional. Prepends the role's prompt context and pre-fills the accessory.</p>
					<select
						data-testid="staff-proposal-role-select"
						class="w-full h-9 px-2 text-sm rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
						.value=${_staffProposalRoleId ?? ""}
						@change=${(e: Event) => { _staffProposalRoleId = (e.target as HTMLSelectElement).value || null; renderApp(); }}
					>
						<option value="" ?selected=${!_staffProposalRoleId}>No role</option>
						${_staffProposalRoles.map((r) => html`<option value=${r.name} ?selected=${_staffProposalRoleId === r.name}>${r.label || r.name}</option>`)}
					</select>
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
						<div class="flex items-center gap-1">
							<label class="text-xs text-muted-foreground font-medium">System Prompt</label>
							${!state.staffPreviewPromptEditMode && _staffAnnCount > 0 ? html`
								<span class="ml-2 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary"
									data-testid="proposal-comment-count">
									${_staffAnnCount} comment${_staffAnnCount === 1 ? "" : "s"}
								</span>
							` : ""}
						</div>
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
								<commentable-markdown
									${ref(staffPromptCommentableRef)}
									.markdown=${state.staffPreviewPrompt || "_No prompt content yet_"}
									.sessionId=${activeSessionId() || ""}
									.bucket=${"proposal:staff"}
									@annotation-change=${(e: CustomEvent) => { _staffAnnCount = e.detail?.count ?? 0; renderApp(); }}
								></commentable-markdown>
							</div>`
					}
				</div>
			</div>
			<div class="shrink-0 flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
				${streaming ? streamingBadge() : ""}
				${_staffAnnCount > 0 && !streaming ? Button({
					variant: "secondary",
					onClick: () => {
						const el = staffPromptCommentableRef.value;
						if (!el) return;
						const text = el.sendFeedback();
						if (text && state.remoteAgent) {
							state.remoteAgent.prompt(text);
						}
						_staffAnnCount = 0;
						renderApp();
					},
					children: html`<span data-testid="proposal-send-feedback">Send feedback (${_staffAnnCount})</span>`,
				}) : ""}
				${!state.assistantType ? Button({ variant: "ghost", onClick: () => dismissTypedProposal("staff"), disabled: _creatingStaff, children: "Dismiss" }) : ""}
				<span data-testid="proposal-primary-submit">${Button({
					variant: "default",
					onClick: handleCreateStaff,
					disabled: _creatingStaff || !state.staffPreviewName.trim() || streaming || hasInvalidGoalTriggersForPreview(),
					children: _creatingStaff
						? html`<span class="inline-flex items-center gap-1.5" data-testid="staff-creating-label">Creating…</span>`
						: html`<span class="inline-flex items-center gap-1.5">${icon(UserCheck, "sm")} Create Staff</span>`,
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
	const proposal = _proposalOverride?.type === "project"
		? {
			sessionId: state.activeProposals.project?.sessionId ?? "",
			fields: _proposalOverride.fields,
			streaming: false,
			rev: _proposalOverride.rev,
			mode: state.activeProposals.project?.mode,
		} as typeof state.activeProposals.project
		: state.activeProposals.project;
	const streaming = isProposalStreaming("project_proposal");
	queueMicrotask(() => {
		reconcileFollowTail(projectOuterScrollRef.value);
	});

	if (!proposal) {
		const sessId = activeSessionId();
		const accepted = sessId ? state.projectProposalAcceptedBySessionId[sessId] : false;
		if (accepted && sessId) {
			const handleTerminate = async () => {
				const { confirmAction } = await import("./dialogs.js");
				const ok = await confirmAction(
					"Terminate Project Assistant",
					"End this assistant session and return to the dashboard?",
					"Terminate",
					true,
				);
				if (!ok) return;
				const { terminateProjectAssistantSession } = await import("./session-manager.js");
				await terminateProjectAssistantSession(sessId);
			};
			return html`
				<div class="flex-1 flex flex-col min-h-0 w-full" data-panel="project-proposal" data-state="accepted">
					<div class="flex-1 flex items-center justify-center p-5">
						<div class="flex flex-col items-center gap-3 text-center max-w-sm">
							<div class="text-base font-medium" data-testid="project-changes-saved-heading">Changes Saved</div>
							<p class="text-sm text-muted-foreground">Your project configuration has been updated.</p>
							${Button({
								variant: "default",
								onClick: handleTerminate,
								children: "Terminate Project Assistant",
							})}
						</div>
					</div>
				</div>
			`;
		}
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
		dismissTypedProposal("project");
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

	const projectViews = ensureProjectProposalViews();

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

	const isHistoricalProject = _proposalOverride?.type === "project";
	return html`
		<div class="flex-1 flex flex-col min-h-0 min-w-0 w-full overflow-hidden" data-panel="project-proposal" data-mode=${mode} data-historical-proposal=${isHistoricalProject ? "true" : "false"}>
			<div class="shrink-0 px-5 pt-4 pb-3 flex items-baseline gap-3 min-w-0">
				<div class="text-sm font-medium shrink-0">${fields.name || "(unnamed project)"}</div>
				${proposal.rev > 0 ? html`<span class="text-xs text-muted-foreground shrink-0" data-testid="proposal-panel-rev">rev ${proposal.rev}</span>` : ""}
				<div class="text-[11px] text-muted-foreground font-mono truncate min-w-0" title=${fields.root_path || ""}>${fields.root_path || ""}</div>
			</div>
			${projectViews
				? projectViews.viewTabs(activeView, onView, {
					components: structuredComponents.length,
					workflows: Object.keys(structuredWorkflows).length,
				})
				: html`<div class="px-5 py-2 text-xs text-muted-foreground">Loading project views…</div>`}
			<div ${ref(projectOuterScrollRef)} class="flex-1 min-w-0 overflow-y-auto overflow-x-hidden p-5 ${streaming ? STREAMING_BORDER : ""}">
				${!projectViews || activeView === "settings"
					? settingsView
					: activeView === "components"
					? projectViews.componentsView(structuredComponents)
					: activeView === "workflows"
					? projectViews.workflowsView(structuredWorkflows, structuredComponents)
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

function proposalPanelForType(type: ProposalType) {
	switch (type) {
		case "goal": return goalProposalPanel();
		case "project": return projectProposalPanel();
		case "role": return rolePreviewPanel();
		case "tool": return toolPreviewPanel();
		case "staff": return staffPreviewPanel();
		default: return "";
	}
}

// Dispatcher used by both the live current-proposal path and the
// historical-override path. Goal proposals from the assistant flow render
// via `goalPreviewPanel()`; everything else (including project, role, tool,
// staff, and non-assistant goal proposals) goes through `proposalPanelForType`.
function proposalPanelForWorkspaceType(type: ProposalType, currentAssistantProposalType: () => ProposalType | null) {
	if (type === "goal" && currentAssistantProposalType() === "goal") return goalPreviewPanel();
	return proposalPanelForType(type);
}

// Loading shim shown while a historical proposal tab's fields are still being
// fetched. Once fields land, `proposalPanelContent` seeds `_proposalOverride`
// and renders the standard editable panel.
function historicalProposalLoadingPanel(tab: PanelWorkspaceTab) {
	if (tab.kind !== "proposal" || tab.source.type !== "proposal") return "";
	const type = tab.source.proposalType;
	const rev = proposalRevisionFromPanelTab(tab);
	return html`
		<div class="goal-preview-panel flex-1 flex flex-col min-h-0 w-full" data-panel=${`${type}-proposal`} data-historical-proposal="true">
			<div class="flex-1 flex items-center justify-center text-muted-foreground text-sm p-5">
				Loading proposal revision${rev ? ` ${rev}` : ""}…
			</div>
		</div>
	`;
}

// ============================================================================
// GOAL PROPOSAL PANEL (non-assistant inline panel)
// ============================================================================

/** Module-level form state for the goal proposal panel. */
let _proposalTitle = "";
let _proposalCwd = "";
let _proposalSpec = "";
let _proposalWorkflowId = "";
let _proposalSpecEditMode = false;
let _proposalCwdDropdownOpen = false;
let _proposalCwdHighlightIndex = -1;
let _proposalSaving = false;
let _proposalSandboxed = false;
let _proposalAutoStartTeam = true;
let _proposalEnabledOptionalSteps: string[] = [];
let _proposalInitializedFrom: string | null = null;
// Per-goal subgoal controls. null means "inherit system preference" — only
// forwarded to createGoal when the user actually touched the control.
let _proposalParentGoalId: string = "";
let _proposalSubgoalsAllowed: boolean | null = null;
let _proposalMaxNestingDepth: number | null = null;

// ----------------------------------------------------------------------------
// Proposal-modal tabs state (Goal / Workflow / Roles).
//
// `_proposalInlineWorkflow` is the draft-scoped customised workflow — when
// non-null, the submit path forwards it as `workflow` instead of
// `workflowId`. `_proposalInlineRoles` is the draft-scoped per-role override
// map keyed by role name; the submit path forwards it as `inlineRoles` when
// non-empty. Neither mutates the project workflow/role store.
//
// Regression context: a master→PR merge silently dropped the inline-workflow
// + inline-roles editor surface. This is its replacement — a tabbed UI reusing
// the main Workflows/Roles page renderers. Pinned by
// tests/source-pin-merge-invariants.test.ts.
// ----------------------------------------------------------------------------
type ProposalTab = "goal" | "workflow" | "roles";
let _proposalActiveTab: ProposalTab = "goal";
let _proposalInlineWorkflow: Workflow | null = null;
let _proposalInlineRoles: Record<string, RoleData> = {};
let _proposalSelectedRoleName: string | null = null;
let _proposalCustomizingWorkflow = false;
let _proposalCustomizingRole = false;
let _proposalRoleEditTab: "prompt" | "tools" | "model" = "prompt";
let _proposalRoleCollapsedGroups = new Set<string>();
let _proposalTabsInitializedFrom: string | null = null;
// Role data caches for the modal, project-scoped: roles can be customised per
// project, so we key the cache by `projectId` ("" for system scope) and
// re-fetch when the selected project changes.
const _proposalRolesCacheByProject = new Map<string, RoleData[]>();
const _proposalRolesLoadingByProject = new Set<string>();
let _proposalGroupPoliciesCache: Record<string, string> | null = null;
let _proposalGroupPoliciesLoading = false;

function proposalRolesProjectKey(): string {
	return state.previewProjectId || "";
}

/** Read-only accessor: roles list for the modal's currently-selected project. */
function proposalRolesList(): RoleData[] {
	return _proposalRolesCacheByProject.get(proposalRolesProjectKey()) ?? [];
}

function proposalRolesLoading(): boolean {
	return _proposalRolesLoadingByProject.has(proposalRolesProjectKey());
}

function ensureProposalRolesLoaded(): void {
	const key = proposalRolesProjectKey();
	if (_proposalRolesCacheByProject.has(key) || _proposalRolesLoadingByProject.has(key)) return;
	_proposalRolesLoadingByProject.add(key);
	fetchRolesForProject(key || undefined)
		.then((list) => {
			_proposalRolesCacheByProject.set(key, list);
			_proposalRolesLoadingByProject.delete(key);
			if (proposalRolesProjectKey() === key && !_proposalSelectedRoleName && list.length > 0) {
				_proposalSelectedRoleName = list[0].name;
			}
			renderApp();
		})
		.catch(() => {
			_proposalRolesCacheByProject.set(key, []);
			_proposalRolesLoadingByProject.delete(key);
			renderApp();
		});
}

function ensureProposalGroupPoliciesLoaded(): void {
	if (_proposalGroupPoliciesCache !== null || _proposalGroupPoliciesLoading) return;
	_proposalGroupPoliciesLoading = true;
	fetchGroupPolicies().then((gp) => {
		_proposalGroupPoliciesCache = gp;
		_proposalGroupPoliciesLoading = false;
		renderApp();
	}).catch(() => {
		_proposalGroupPoliciesCache = {};
		_proposalGroupPoliciesLoading = false;
		renderApp();
	});
}

/** Deep-clone a Workflow so editor mutations never touch the cached library copy. */
function cloneWorkflow(wf: Workflow): Workflow {
	return {
		...wf,
		gates: (wf.gates || []).map((g) => ({
			...g,
			dependsOn: [...(g.dependsOn || [])],
			verify: g.verify ? g.verify.map((v) => ({ ...v })) : undefined,
			metadata: g.metadata ? { ...g.metadata } : undefined,
		})),
	};
}

/** Deep-clone a RoleData so editor mutations never touch the cached library copy. */
function cloneRole(r: RoleData): RoleData {
	return {
		...r,
		toolPolicies: { ...(r.toolPolicies ?? {}) },
	};
}

/** Reset all proposal-tab module state. Called when the proposal is dismissed
 *  or successfully accepted, and when syncing from a new proposal payload. */
function resetProposalTabsState(): void {
	_proposalActiveTab = "goal";
	_proposalInlineWorkflow = null;
	_proposalInlineRoles = {};
	_proposalSelectedRoleName = null;
	_proposalCustomizingWorkflow = false;
	_proposalCustomizingRole = false;
	_proposalRoleEditTab = "prompt";
	_proposalRoleCollapsedGroups = new Set<string>();
	_proposalTabsInitializedFrom = null;
	clearWorkflowEditorController();
}

// When a historical proposal tab is the active panel tab, the dispatcher
// sets this to an override that supplies the form state for that revision.
// The override is read by `syncProposalFormState`, `renderGoalForm`,
// `goalPreviewPanel`, and `projectProposalPanel` instead of
// `state.activeProposals[type]`, so the live current-proposal slot is never
// clobbered when the user views an older snapshot.
let _proposalOverride: { type: ProposalType; fields: Record<string, unknown>; rev: number } | null = null;
// Tracks the raw source `fields` reference that the current `_proposalOverride`
// was derived from, so the identity short-circuit in `proposalPanelContent`
// still works when we project legacy top-level commands into a synthetic
// `components` array for historical project-proposal snapshots.
let _proposalOverrideSource: Record<string, unknown> | null = null;

/**
 * Project legacy top-level command keys (`build_command`, `test_command`, …) on
 * a historical project-proposal snapshot into a synthetic `components[0]` so the
 * editable project panel can surface them. Mirrors the server-side
 * `LEGACY_KEY_MAP` fold in `src/server/server.ts` that runs for live proposals.
 *
 * Returns the input unchanged when `components` is already present and
 * non-empty, or when no legacy keys are set. Never mutates `fields`.
 */
function projectLegacyToComponents(fields: Record<string, unknown>): Record<string, unknown> {
	const existingComponents = fields.components;
	if (Array.isArray(existingComponents) && existingComponents.length > 0) return fields;

	const LEGACY_KEY_MAP: Record<string, string> = {
		build_command: "build",
		test_command: "test",
		typecheck_command: "check",
		test_unit_command: "unit",
		test_e2e_command: "e2e",
	};
	const cmds: Record<string, string> = {};
	for (const [legacyKey, newKey] of Object.entries(LEGACY_KEY_MAP)) {
		const v = fields[legacyKey];
		if (typeof v === "string" && v.trim().length > 0) cmds[newKey] = v.trim();
	}
	const setupHook = fields.worktree_setup_command;
	const hasAnyLegacy = Object.keys(cmds).length > 0
		|| (typeof setupHook === "string" && setupHook.trim().length > 0);
	if (!hasAnyLegacy) return fields;

	const name = (typeof fields.name === "string" && fields.name.trim()) || "default";
	const component: Record<string, unknown> = {
		name,
		repo: ".",
		commands: cmds,
	};
	if (typeof setupHook === "string" && setupHook.trim()) {
		component.worktree_setup_command = setupHook.trim();
	}
	return { ...fields, components: [component] };
}

/** Sync module-level form state from the active goal proposal when it changes. */
function syncProposalFormState(): void {
	const raw = _proposalOverride?.type === "goal"
		? _proposalOverride.fields
		: state.activeProposals.goal?.fields;
	const proposal = raw as undefined | {
		title: string; spec: string; cwd?: string; workflow?: string; options?: string;
		parentGoalId?: string; inlineWorkflow?: Workflow; inlineRoles?: Record<string, RoleData>;
	};
	if (!proposal) return;

	// --- Tab + inline-customisation reset identity ---------------------------
	// Keyed by the *initial* inline payload, NOT mutable title/spec/cwd, so the
	// user's active tab + draft workflow/role edits survive every streamed token.
	const inlineKey = proposal.inlineWorkflow ? JSON.stringify(proposal.inlineWorkflow) : "";
	const rolesKey = proposal.inlineRoles ? JSON.stringify(proposal.inlineRoles) : "";
	const tabsKey = `${inlineKey}|${rolesKey}`;
	if (_proposalTabsInitializedFrom !== tabsKey) {
		// NOTE: resetProposalTabsState() clears _proposalTabsInitializedFrom, so
		// set it AFTER the reset, not before.
		resetProposalTabsState();
		_proposalTabsInitializedFrom = tabsKey;
		if (proposal.inlineWorkflow && typeof proposal.inlineWorkflow === "object" && (proposal.inlineWorkflow as Workflow).id) {
			_proposalInlineWorkflow = cloneWorkflow(proposal.inlineWorkflow as Workflow);
			_proposalCustomizingWorkflow = true;
		}
		if (proposal.inlineRoles && typeof proposal.inlineRoles === "object") {
			for (const [name, role] of Object.entries(proposal.inlineRoles)) {
				if (role && typeof role === "object") {
					_proposalInlineRoles[name] = cloneRole(role as RoleData);
				}
			}
			const firstCustomized = Object.keys(_proposalInlineRoles)[0];
			if (firstCustomized) _proposalSelectedRoleName = firstCustomized;
		}
	}

	// Use a simple identity check to avoid re-initializing on every render
	const key = `${proposal.title}|${proposal.spec}|${proposal.cwd || ""}|${proposal.workflow || ""}|${proposal.options || ""}|${proposal.parentGoalId || ""}`;
	if (_proposalInitializedFrom === key) return;
	_proposalInitializedFrom = key;
	_proposalTitle = proposal.title;
	_proposalSpec = proposal.spec;
	_proposalParentGoalId = proposal.parentGoalId || "";
	// Preserve project rootPath when proposal doesn't specify cwd
	const proposalProject = state.previewProjectId ? state.projects.find(p => p.id === state.previewProjectId) : undefined;
	_proposalCwd = proposal.cwd || proposalProject?.rootPath || "";
	_proposalWorkflowId = proposal.workflow || "";
	if (!_proposalWorkflowId && _proposalInlineWorkflow) {
		_proposalWorkflowId = _proposalInlineWorkflow.id;
	}
	// Correct a phantom/empty proposed workflow immediately when the cache is already
	// loaded, so the rendered option and form state agree on the same render.
	normalizeWorkflowSelections();
	_proposalSpecEditMode = false;
	_proposalEnabledOptionalSteps = proposal.options
		? proposal.options.split(",").map(s => s.trim()).filter(Boolean)
		: [];
	_proposalSaving = false;
	_proposalSubgoalsAllowed = null;
	_proposalMaxNestingDepth = null;
}

function goalProposalPanel() {
	// Populate previewProjectId for re-attempt / assistant sessions where it
	// wasn't seeded by the +New Goal picker. Resolution order:
	// 1. Active session's projectId (server inherits this for re-attempts).
	// 2. Original goal's projectId via reattemptGoalId.
	// 3. Match proposal cwd against a registered project's rootPath.
	if (!state.previewProjectId) {
		const sid = activeSessionId();
		const sess = sid ? state.gatewaySessions.find(s => s.id === sid) : undefined;
		let candidate = sess?.projectId;
		if (!candidate && sess?.reattemptGoalId) {
			candidate = state.goals.find(g => g.id === sess.reattemptGoalId)?.projectId;
		}
		if (!candidate) {
			const cwd = (state.activeProposals.goal?.fields as any)?.cwd as string | undefined;
			if (cwd) {
				const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
				const target = norm(cwd);
				candidate = state.projects.find(p => norm(p.rootPath) === target)?.id;
			}
		}
		if (candidate && state.projects.some(p => p.id === candidate)) {
			state.previewProjectId = candidate;
		}
	}
	syncProposalFormState();
	ensureWorkflowsLoaded(state.previewProjectId || undefined);
	ensureSandboxStatusLoaded();
	ensureProposalRolesLoaded();
	ensureProposalGroupPoliciesLoaded();
	ensureToolsLoaded();
	const subgoalsEnabled = isSubgoalsEnabled();
	const maxNestingDepth = getSystemMaxNestingDepth();

	const handleCreateGoal = async () => {
		const trimmedTitle = _proposalTitle.trim();
		if (!trimmedTitle || _proposalSaving) return;
		if (!state.previewProjectId) {
			showConnectionError("No project selected for this goal", "The assistant session is not linked to a project. Dismiss this proposal and start a new goal from the + New Goal button.");
			return;
		}
		if (workflowStateFor(state.previewProjectId) === "empty") {
			showConnectionError(
				"This project has no workflows yet",
				"Run the project assistant from the goal panel banner (or Settings → Components) to scaffold workflows before creating a goal.",
			);
			return;
		}

		// Snapshot form state so a retry after a server reject re-reads the
		// latest values (workflow id, sandboxed, etc).
		const sandboxed = _proposalSandboxed;
		const autoStartTeam = _proposalAutoStartTeam;
		const workflowId = _proposalWorkflowId || undefined;
		const enabledOptionalSteps = _proposalEnabledOptionalSteps.length > 0 ? _proposalEnabledOptionalSteps : undefined;
		const projectId = state.previewProjectId || undefined;

		_proposalSaving = true;
		renderApp();

		let goal;
		try {
			try {
				const subgoalsAllowedField = subgoalsEnabled && _proposalSubgoalsAllowed !== null
					? _proposalSubgoalsAllowed
					: undefined;
				const maxNestingDepthField = subgoalsEnabled && _proposalMaxNestingDepth !== null
					? _proposalMaxNestingDepth
					: undefined;
				// Customised inline workflow takes precedence over the library
				// workflowId. inlineRoles is only forwarded when non-empty.
				const inlineWorkflowField = _proposalInlineWorkflow ?? undefined;
				const inlineRolesField = Object.keys(_proposalInlineRoles).length > 0
					? _proposalInlineRoles as Record<string, unknown>
					: undefined;
				goal = await createGoal(trimmedTitle, _proposalCwd.trim(), {
					spec: _proposalSpec,
					workflowId: inlineWorkflowField ? undefined : workflowId,
					workflow: inlineWorkflowField,
					inlineRoles: inlineRolesField,
					sandboxed,
					projectId,
					enabledOptionalSteps,
					autoStartTeam,
					parentGoalId: _proposalParentGoalId || undefined,
					subgoalsAllowed: subgoalsAllowedField,
					maxNestingDepth: maxNestingDepthField,
				});
			} catch (err) {
				const { message, code, stack } = errorDetails(err);
				showConnectionError("Failed to create goal", message, { code, stack });
				return;
			}
			if (!goal) return;

			// --- Success: clear the proposal and navigate. ---
			delete state.activeProposals.goal;
			_proposalEnabledOptionalSteps = [];
			_proposalInitializedFrom = null;
			_proposalSandboxed = false;
			_proposalAutoStartTeam = true;
			_proposalParentGoalId = "";
			_proposalSubgoalsAllowed = null;
			_proposalMaxNestingDepth = null;
			resetProposalTabsState();
			setHashRoute("goal-dashboard", goal.id, true);
		} finally {
			_proposalSaving = false;
			renderApp();
		}
	};

	const handleOpenProjectAssistant = async () => {
		const linked = state.previewProjectId ? state.projects.find(p => p.id === state.previewProjectId) : null;
		if (!linked) return;
		const { createProjectAssistantSession } = await import("./dialogs.js");
		await createProjectAssistantSession(linked.rootPath, false, { projectId: linked.id, existingProjectName: linked.name || "" });
	};

	const handleDismiss = () => {
		const dismissed = state.activeProposals.goal?.fields as undefined | { title: string; spec: string; cwd?: string; workflow?: string; options?: string };
		const sidEarly = activeSessionId();
		if (sidEarly) clearProposalAnnotations(sidEarly, "goal");
		resetProposalAnnCount("goal");
		delete state.activeProposals.goal;
		_proposalInitializedFrom = null;
		_proposalEnabledOptionalSteps = [];
		_proposalAutoStartTeam = true;
		_proposalParentGoalId = "";
		_proposalSubgoalsAllowed = null;
		_proposalMaxNestingDepth = null;
		resetProposalTabsState();
		// Persist dismiss so it survives reconnect
		const sid = activeSessionId();
		if (sid && dismissed) {
			markProposalDismissed(sid, dismissed);
			void deleteProposalFile(sid, "goal");
		}
		recomputeAssistantHasProposal();
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
		workflowState: workflowStateFor(state.previewProjectId || undefined),
		onOpenProjectAssistant: handleOpenProjectAssistant,
		onTitleChange: (e: Event) => { _proposalTitle = (e.target as HTMLInputElement).value; },
		onSpecChange: (e: Event) => { _proposalSpec = (e.target as HTMLTextAreaElement).value; },
		onCwdChange: (v) => { _proposalCwd = v; renderApp(); },
		onCwdSelect: (v) => { _proposalCwd = v; renderApp(); },
		onWorkflowChange: (e: Event) => {
			_proposalWorkflowId = (e.target as HTMLSelectElement).value;
			// Changing the picker selects a different library workflow; any prior
			// goal-draft inline workflow customisation is for the old selection and
			// must be cleared so submit doesn't ship stale inline content alongside
			// the newly-selected workflowId.
			_proposalInlineWorkflow = null;
			_proposalCustomizingWorkflow = false;
			clearWorkflowEditorController();
			renderApp();
		},
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
		createDisabled: (() => {
			if (!_proposalTitle.trim() || _proposalSaving) return true;
			// Disable Create when a parent is selected but the child would exceed cap.
			if (_proposalParentGoalId && maxNestingDepth !== undefined) {
				const pDepth = computeGoalDepth(_proposalParentGoalId, state.goals);
				if (pDepth + 1 > maxNestingDepth) return true;
			}
			return false;
		})(),
		streaming: isProposalStreaming("goal_proposal"),
		commentable: true,
		parentGoalId: _proposalParentGoalId || undefined,
		onParentGoalChange: (id) => { _proposalParentGoalId = id || ""; renderApp(); },
		subgoalsEnabled,
		maxNestingDepth,
		subgoalsAllowedValue: _proposalSubgoalsAllowed,
		maxNestingDepthValue: _proposalMaxNestingDepth,
		onSubgoalsAllowedChange: (value: boolean) => { _proposalSubgoalsAllowed = value; renderApp(); },
		onMaxNestingDepthChange: (value: number | null) => { _proposalMaxNestingDepth = value; renderApp(); },

		// ---- Proposal-modal tabs wiring ----
		tabbed: true,
		activeTab: _proposalActiveTab,
		onTabChange: (tab) => { _proposalActiveTab = tab; renderApp(); },

		inlineWorkflow: _proposalInlineWorkflow,
		customizingWorkflow: _proposalCustomizingWorkflow,
		onInlineWorkflowChange: (wf) => { _proposalInlineWorkflow = wf; renderApp(); },
		onCustomizeWorkflow: () => {
			const src = _cachedWorkflows.find((w) => w.id === _proposalWorkflowId) ?? _cachedWorkflows[0];
			if (!src) return;
			_proposalInlineWorkflow = cloneWorkflow(src);
			_proposalCustomizingWorkflow = true;
			clearWorkflowEditorController();
			renderApp();
		},
		onResetWorkflow: () => {
			_proposalInlineWorkflow = null;
			_proposalCustomizingWorkflow = false;
			// Normalize a stale inline-only id back to a real library workflow so
			// submit doesn't forward a discarded inline workflow's id as `workflowId`.
			if (!_cachedWorkflows.some((w) => w.id === _proposalWorkflowId)) {
				_proposalWorkflowId = _cachedWorkflows[0]?.id ?? "";
			}
			clearWorkflowEditorController();
			renderApp();
		},

		inlineRoles: _proposalInlineRoles,
		selectedRoleName: _proposalSelectedRoleName,
		onSelectRole: (name) => {
			_proposalSelectedRoleName = name;
			_proposalCustomizingRole = !!_proposalInlineRoles[name];
			renderApp();
		},
		customizingRole: _proposalCustomizingRole && !!_proposalSelectedRoleName && !!_proposalInlineRoles[_proposalSelectedRoleName],
		onCustomizeRole: () => {
			const name = _proposalSelectedRoleName;
			if (!name) return;
			const src = proposalRolesList().find((r) => r.name === name);
			if (!src) return;
			if (!_proposalInlineRoles[name]) _proposalInlineRoles[name] = cloneRole(src);
			_proposalCustomizingRole = true;
			_proposalRoleEditTab = "prompt";
			renderApp();
		},
		onResetRole: () => {
			const name = _proposalSelectedRoleName;
			if (!name) return;
			delete _proposalInlineRoles[name];
			_proposalCustomizingRole = false;
			renderApp();
		},
		onRoleDraftChange: (patch) => {
			const name = _proposalSelectedRoleName;
			if (!name) return;
			const current = _proposalInlineRoles[name];
			if (!current) return;
			const next: RoleData = { ...current };
			if (patch.label !== undefined) next.label = patch.label;
			if (patch.promptTemplate !== undefined) next.promptTemplate = patch.promptTemplate;
			if (patch.accessory !== undefined) next.accessory = patch.accessory;
			if (patch.toolPolicies !== undefined) next.toolPolicies = patch.toolPolicies;
			if (patch.model !== undefined) next.model = patch.model;
			if (patch.thinkingLevel !== undefined) next.thinkingLevel = patch.thinkingLevel;
			_proposalInlineRoles[name] = next;
			renderApp();
		},
		onRoleEditorTabChange: (tab) => { _proposalRoleEditTab = tab; renderApp(); },
		onRoleToggleToolGroup: (group) => {
			if (_proposalRoleCollapsedGroups.has(group)) _proposalRoleCollapsedGroups.delete(group);
			else _proposalRoleCollapsedGroups.add(group);
			renderApp();
		},
		roleEditTab: _proposalRoleEditTab,
		roleCollapsedGroups: _proposalRoleCollapsedGroups,
		roleList: proposalRolesList(),
		roleListLoading: proposalRolesLoading(),
		availableTools: _availableTools,
		groupPolicies: _proposalGroupPoliciesCache ?? {},
	});
}


// ============================================================================
// LAZY ENTRY POINT
// ============================================================================

/**
 * Entry point used by `render.ts` (via the `proposal-panels-lazy.ts` shim).
 * Returns the panel template for an open proposal tab — historical,
 * assistant-typed, or a standalone goal / project / role / tool / staff
 * proposal panel.
 *
 * The caller is expected to have already gated on
 * `state.activeProposals[type] != null` (or matching assistant type) for
 * non-historical tabs; this function repeats the assistant-goal check
 * because that path dispatches to `goalPreviewPanel()` instead of the
 * inline `goalProposalPanel()`.
 */
export function proposalPanelContent(
	tab: PanelWorkspaceTab,
	currentAssistantProposalType: () => ProposalType | null,
) {
	if (tab.kind !== "proposal" || tab.source.type !== "proposal") return "";
	const type = tab.source.proposalType;
	if (isHistoricalProposalTab(tab)) {
		const fields = tab.state?.fields && typeof tab.state.fields === "object" && !Array.isArray(tab.state.fields)
			? tab.state.fields as Record<string, unknown>
			: undefined;
		if (!fields) return historicalProposalLoadingPanel(tab);
		// Seed an override (NOT activeProposals) so the historical snapshot
		// flows through the editable panel without clobbering the live
		// current-proposal slot. Switching back to the current tab clears
		// the override and the live slot's content is restored verbatim.
		const rev = proposalRevisionFromPanelTab(tab) || 1;
		if (!_proposalOverride || _proposalOverride.type !== type || _proposalOverrideSource !== fields || _proposalOverride.rev !== rev) {
			const projected = type === "project" ? projectLegacyToComponents(fields) : fields;
			_proposalOverride = { type, fields: projected, rev };
			_proposalOverrideSource = fields;
			_proposalInitializedFrom = null;
		}
		return proposalPanelForWorkspaceType(type, currentAssistantProposalType);
	}
	if (_proposalOverride && _proposalOverride.type === type) {
		// Returning to the current tab: drop the override and force a
		// re-hydration of the form from the live activeProposals slot.
		_proposalOverride = null;
		_proposalOverrideSource = null;
		_proposalInitializedFrom = null;
	}
	return proposalPanelForWorkspaceType(type, currentAssistantProposalType);
}

// Mark some imports referenced only for re-export / future use as used to
// satisfy noUnusedLocals when applicable.
export { dismissTypedProposal };
