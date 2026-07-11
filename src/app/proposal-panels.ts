// ============================================================================
// PROPOSAL PANELS (cold-path, lazy-loaded chunk)
// ============================================================================
//
// Extracted from `src/app/render.ts` to shrink the entry bundle. The full set
// of proposal preview panels (goal / role / tool / staff / project) and the
// shared `renderGoalForm` builder live here. Loaded on first proposal-panel
// view via `proposal-panels-lazy.ts`.
//
import { html, nothing, type TemplateResult } from "lit";
import { ref, createRef } from "lit/directives/ref.js";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Check, Copy, Eye, FolderOpen, Goal as GoalIcon, Minus, Pencil, Plus, UserCheck, Users, Wrench } from "lucide";

import { state, renderApp, setProjects, activeSessionId, isProposalStreaming } from "./state.js";
import {
	createGoal,
	createRole,
	gatewayFetch,
	refreshSessions,
	fetchProjects,
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
	uncacheSession,
} from "./session-manager.js";
import { deleteProposalFile, metadataObjectToRows, metadataRowsToObject } from "./proposal-helpers.js";
import { isSubgoalsEnabled, getSystemMaxNestingDepth } from "./subgoals-flag.js";
import {
	parentHostEligibility,
	effectiveMaxNestingDepthOf,
	nestingDepthOf,
	resolveDepthControl,
} from "./subgoal-eligibility.js";
import { PROPOSAL_TYPES, type GoalWorkflowValidationError, type ProposalType } from "./proposal-registry.js";
import { showConnectionError } from "./dialogs-lazy.js";
import { errorDetails } from "./error-helpers.js";
import { cwdCombobox } from "./cwd-combobox.js";
import { ACCESSORY_IDS, getAccessory, statusBobbit } from "./session-colors.js";
import { defaultCwdForProjectSession, isHeadquartersProject, projectDisplayName } from "./headquarters.js";
import { getProjectAccentColor } from "./render-helpers.js";
import { buildProjectConfigDiff } from "./project-proposal-diff.js";
import { reloadStaffList } from "./sidebar.js";
import {
	isHistoricalProposalTab,
	proposalPanelTabId,
	proposalRevisionFromPanelTab,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";
import { closeSidePanelTab } from "./side-panel-workspace.js";
import "../ui/components/CommentableMarkdown.js";
import type {
	ViewMode as ProjectViewMode,
	ProposalComponent,
	ProposalWorkflow,
} from "./project-proposal-views.js";
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

function proposalProjectId(type: ProposalType, sessionId: string | null | undefined): string | undefined {
	const slot = type ? state.activeProposals[type] : undefined;
	const explicit = !slot || !sessionId || slot.sessionId === sessionId ? slot?.fields?.projectId : undefined;
	if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
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

function resolveGoalProposalProjectId(sessionId: string | null | undefined, fields: Record<string, unknown> | undefined): string | undefined {
	const explicit = fields?.projectId;
	if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
	const fromSession = proposalProjectId("goal", sessionId);
	if (fromSession) return fromSession;
	const session = sessionId ? state.gatewaySessions.find(s => s.id === sessionId) : undefined;
	if (session?.reattemptGoalId) return state.goals.find(g => g.id === session.reattemptGoalId)?.projectId;
	return undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Cross-project proposal banner (design §7)
//
// A proposal made from one project may target a DIFFERENT project via its
// optional `projectId`. When the resolved target differs from the proposer's
// session project we surface a prominent "Proposing into <Target>" banner at
// the top of the panel. Same-project / unknown / undeterminable → no chrome.
// ──────────────────────────────────────────────────────────────────────

/** Normalise the hidden `system` scope to the user-facing `headquarters` id. */
function normalizeProposalProjectId(id: string | null | undefined): string | undefined {
	if (typeof id !== "string") return undefined;
	const t = id.trim();
	if (!t) return undefined;
	return t === "system" ? "headquarters" : t;
}

/** The (normalised) project of the session that authored the proposal. */
function proposerSessionProjectId(sessionId: string | null | undefined): string | undefined {
	if (!sessionId) return undefined;
	const session = state.gatewaySessions.find(s => s.id === sessionId)
		|| state.archivedSessions.find(s => s.id === sessionId);
	return normalizeProposalProjectId(session?.projectId);
}

/**
 * Resolve the cross-project banner target for a proposal, or undefined when no
 * banner should render. Returns the target project record ONLY when it is
 * registered AND differs from the proposer's session project.
 */
function crossProjectTarget(
	type: ProposalType,
	sessionId: string | null | undefined,
): (typeof state.projects)[number] | undefined {
	let rawTarget: string | undefined;
	if (type === "goal") {
		rawTarget = resolveGoalProposalProjectId(sessionId, state.activeProposals.goal?.fields as Record<string, unknown> | undefined);
	} else if (type === "project") {
		// Project proposals only banner an EXPLICIT, registered target — a
		// brand-new / unknown project shows no banner (matches §3 tri-state).
		const explicit = state.activeProposals.project?.fields?.projectId;
		rawTarget = typeof explicit === "string" && explicit.trim() ? explicit.trim() : undefined;
	} else {
		rawTarget = proposalProjectId(type, sessionId);
	}
	const target = normalizeProposalProjectId(rawTarget);
	if (!target) return undefined;
	const record = state.projects.find(p => p.id === target);
	if (!record) return undefined; // unknown target → no banner
	const proposer = proposerSessionProjectId(sessionId);
	// Only banner when we can confirm the target differs from the proposer.
	if (!proposer || proposer === target) return undefined;
	return record;
}

/** "Proposing into <Target Project>" banner, tinted with the target's accent. */
function crossProjectBanner(type: ProposalType, sessionId: string | null | undefined): TemplateResult | typeof nothing {
	const target = crossProjectTarget(type, sessionId);
	if (!target) return nothing;
	const accent = getProjectAccentColor(target);
	const name = projectDisplayName(target);
	return html`
		<div
			class="shrink-0 flex items-center gap-2 px-5 py-2 text-xs font-medium border-b"
			data-testid="cross-project-banner"
			data-target-project-id=${target.id}
			style=${`border-color: color-mix(in oklch, ${accent} 45%, transparent); background: color-mix(in oklch, ${accent} 12%, transparent); color: var(--foreground);`}
		>
			<span class="inline-block w-2 h-2 rounded-full shrink-0" style=${`background: ${accent};`}></span>
			<span>Proposing into <span class="font-semibold" data-testid="cross-project-target-name">${name}</span></span>
		</div>
	`;
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
/** In-flight flag for assistant goal-preview submission. Mirrors _proposalSaving for the regular proposal panel. */
let _goalPreviewSaving = false;
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
 *  Normalizes ordinary goal forms against the loaded workflow cache, but preserves
 *  missing/unknown selections for failed workflow-validation proposals so the UI
 *  doesn't hide the server rejection by silently selecting the first workflow. */
export function setSelectedWorkflowId(id: string): void {
	const inlineWorkflow = selectedInlineWorkflowDraft();
	if (inlineWorkflow) {
		_selectedWorkflowId = inlineWorkflow.id;
		return;
	}
	_selectedWorkflowId = (_cachedWorkflows.length > 0 && !isKnownWorkflowId(id) && !shouldPreserveFailedWorkflowSelection())
		? (_cachedWorkflows[0]?.id ?? "")
		: id;
}

/** Normalize the workflow form selections against the loaded workflow cache.
 *  Ordinary empty/phantom selections fall back to the first available id. Failed
 *  workflow-validation proposals keep the exact missing/unknown value so the
 *  selector remains visibly invalid until corrected. */
function normalizeWorkflowSelections(): void {
	const inlineWorkflow = selectedInlineWorkflowDraft();
	if (inlineWorkflow) {
		_selectedWorkflowId = inlineWorkflow.id;
		_proposalWorkflowId = inlineWorkflow.id;
		return;
	}
	if (_cachedWorkflows.length === 0) return;
	const ids = new Set(_cachedWorkflows.map(w => w.id));
	const first = _cachedWorkflows[0].id;
	const preserveInvalid = shouldPreserveFailedWorkflowSelection();
	if (!ids.has(_selectedWorkflowId) && !preserveInvalid) _selectedWorkflowId = first;
	if (!ids.has(_proposalWorkflowId) && !preserveInvalid) {
		_proposalWorkflowId = first;
	}
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

function activeGoalWorkflowValidationError(): GoalWorkflowValidationError | undefined {
	return (state.activeProposals.goal as any)?.workflowValidationError;
}

function shouldPreserveFailedWorkflowSelection(): boolean {
	return !!activeGoalWorkflowValidationError();
}

function isKnownWorkflowId(id: string): boolean {
	return _cachedWorkflows.some(w => w.id === id);
}

function isWorkflowSelectionInvalid(id: string, inlineWorkflow?: Workflow | null): boolean {
	return _cachedWorkflows.length > 0 && !hasValidInlineWorkflowDraft(inlineWorkflow) && !isKnownWorkflowId(id);
}

function hasValidInlineWorkflowDraft(inlineWorkflow?: Workflow | null): inlineWorkflow is Workflow {
	return !!inlineWorkflow
		&& typeof inlineWorkflow.id === "string"
		&& inlineWorkflow.id.length > 0
		&& Array.isArray(inlineWorkflow.gates);
}

function selectedInlineWorkflowDraft(): Workflow | null {
	return hasValidInlineWorkflowDraft(_proposalInlineWorkflow) ? _proposalInlineWorkflow : null;
}

type WorkflowSelectOption = {
	id: string;
	label: string;
	kind: "project" | "bespoke";
};

function projectWorkflowOptionLabel(workflow: Workflow): string {
	return `${workflow.name} (${workflow.gates.length} gates)`;
}

function bespokeWorkflowOptionLabel(workflow: Workflow): string {
	return `Bespoke (${workflow.gates.length} Gates)`;
}

function goalWorkflowSelectOptions(inlineWorkflow?: Workflow | null): WorkflowSelectOption[] {
	const options: WorkflowSelectOption[] = [];
	const selectedInline = hasValidInlineWorkflowDraft(inlineWorkflow) ? inlineWorkflow : null;
	if (selectedInline) {
		options.push({ id: selectedInline.id, label: bespokeWorkflowOptionLabel(selectedInline), kind: "bespoke" });
	}
	for (const workflow of _cachedWorkflows) {
		if (workflow.id === selectedInline?.id) continue;
		options.push({ id: workflow.id, label: projectWorkflowOptionLabel(workflow), kind: "project" });
	}
	return options;
}

function workflowErrorMessageWithAvailable(error: GoalWorkflowValidationError | undefined): string {
	if (!error) return "";
	const ids = error.availableWorkflows?.map(w => w.id).filter(Boolean) ?? [];
	if (ids.length === 0 || ids.some(id => error.message.includes(id))) return error.message;
	return `${error.message} Available workflows: ${ids.join(", ")}.`;
}

function failedGoalWorkflowId(error: GoalWorkflowValidationError | undefined): string | null {
	if (!error) return null;
	const fields = state.activeProposals.goal?.fields as { workflow?: unknown } | undefined;
	if (typeof fields?.workflow === "string") return fields.workflow;
	return error.workflowId ?? "";
}

function clearActiveGoalWorkflowValidationError(): void {
	const slot = state.activeProposals.goal as any;
	if (!slot?.workflowValidationError) return;
	delete slot.workflowValidationError;
	// Clearing a failed workflow-validation error should mark the current form
	// snapshot as already initialized. Otherwise syncProposalFormState sees the
	// identity key change, re-seeds from the original failed fields, and can
	// overwrite the user's corrected workflow with the first cached workflow.
	const key = activeGoalProposalFormIdentityKey();
	if (_proposalInitializedFrom && key) _proposalInitializedFrom = key;
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
		_staffProposalRoles = await fetchRoles(staffPreviewProjectId());
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
const goalCreateButtonContainerRef = createRef<HTMLSpanElement>();
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

async function closeCurrentProposalPanel(type: ProposalType, sessionId: string | null | undefined): Promise<void> {
	if (!sessionId) return;
	try {
		await closeSidePanelTab(proposalPanelTabId(type), { sessionId });
	} catch (err) {
		console.warn("[proposal] failed to close workspace tab", { type, sessionId, err });
	}
}

function dismissTypedProposal(type: ProposalType): void {
	const slot = state.activeProposals[type];
	const sessionId = slot?.sessionId ?? activeSessionId();
	// If the proposal is still streaming, suppress the rest of the in-flight
	// tool block so later (content-grown) deltas can't re-populate the panel —
	// the content-fingerprint dismissal below only matches the body captured now.
	if (isProposalStreaming(`${type}_proposal`)) {
		state.remoteAgent?.dismissStreamingProposal(`${type}_proposal`);
	}
	clearProposalReviewState(sessionId, type);
	if (sessionId && slot?.fields) markProposalDismissed(sessionId, type, slot.fields);
	delete state.activeProposals[type];
	recomputeAssistantHasProposal();
	void closeCurrentProposalPanel(type, sessionId);
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

	/** Cross-project "Proposing into <Target>" banner (design §7). Rendered at the
	 *  very top of the form when the goal targets a project other than the
	 *  proposer's session project; `nothing`/undefined leaves the panel unchanged. */
	crossProjectBanner?: TemplateResult | typeof nothing;

	/** Workflow availability for the linked project. Drives the empty-workflows
	 *  banner and Accept-disabled state in the form header. */
	workflowState?: "no-project" | "loading" | "empty" | "ready";

	/** Invoked when the user clicks "Open Project Assistant" in the empty
	 *  workflows banner. */
	onOpenProjectAssistant?: () => void;

	/** Draft-scoped workflow validation failure returned by propose_goal seed. */
	workflowErrorMessage?: string;
	workflowValidationFailed?: boolean;

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

	// ---- Per-goal metadata ----
	/** Ordered [key, value] string rows for the per-goal metadata editor. Values
	 *  are JSON-parsed at submit when possible, otherwise kept as strings. */
	metadataRows: Array<[string, string]>;
	/** Apply an update to the row set. The updater receives the LIVE current rows
	 *  (not the render-time snapshot) so rapid successive edits — key then value
	 *  of the same row, or an Add immediately after a fill — compose correctly
	 *  even though renderApp() is rAF-throttled. A plain replacement array is also
	 *  accepted for convenience. */
	onMetadataRowsChange: (
		update: Array<[string, string]> | ((prev: Array<[string, string]>) => Array<[string, string]>),
	) => void;

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

	// ---- Root-only orchestration policy (tree-wide; owned by the root) ----
	/** Current per-goal divergence (plan-mutation) policy. `null` = inherit
	 *  default ("balanced"). Only meaningful for a top-level/root goal. */
	divergencePolicyValue?: "strict" | "balanced" | "autonomous" | null;
	/** Invoked when the user picks a divergence policy. Presence (with
	 *  `onMaxConcurrentChildrenChange`) gates rendering of the orchestration row. */
	onDivergencePolicyChange?: (value: "strict" | "balanced" | "autonomous") => void;
	/** Current per-goal max-concurrent-children cap. `null` = inherit default (3).
	 *  Only meaningful for a top-level/root goal; clamped to [1, 8]. */
	maxConcurrentChildrenValue?: number | null;
	/** Invoked when the user changes the concurrency cap. */
	onMaxConcurrentChildrenChange?: (value: number) => void;

	// ---- Goal proposal tabs (Goal / Workflow / Roles / Metadata) ----
	/** Active tab for the always-tabbed goal proposal form. The footer stays
	 *  outside the panels so submit/dismiss remain visible on every tab. */
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

/**
 * Render the simple per-goal metadata key/value editor. Rows are arbitrary
 * namespaced key/value pairs attached to the goal; values are JSON-parsed at
 * submit when possible (numbers, booleans, arrays, objects), else kept as
 * strings. An empty editor sends no `metadata` so the goal is unchanged.
 */
function renderGoalMetadataEditor(config: GoalFormConfig): TemplateResult {
	const rows = config.metadataRows;
	const inputCls = "flex-1 min-w-0 text-xs px-2 py-1 rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring";
	return html`
		<div class="flex flex-col gap-1.5" data-testid="goal-form-metadata">
			<div class="flex items-center gap-1.5">
				<label class="text-xs text-muted-foreground font-medium">Metadata</label>
				<span title="Arbitrary namespaced key/value pairs attached to this goal and inherited by all its sessions and sub-goals (e.g. bobbit.disabledTools, hindsight.memory.enabled). Values are JSON-parsed when possible (numbers, booleans, arrays, objects), otherwise stored as strings. Empty = no override."
					class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
			</div>
			<div class="flex flex-col gap-1.5" data-testid="goal-metadata-list">
				${rows.length === 0
					? html`<div class="text-[10px] text-muted-foreground opacity-70">No metadata entries.</div>`
					: rows.map(([k, v], i) => html`
						<div class="flex items-center gap-1.5" data-testid="goal-metadata-row">
							<input class=${inputCls} data-testid="goal-metadata-key" placeholder="key" .value=${k}
								@input=${(e: Event) => {
									const val = (e.target as HTMLInputElement).value;
									config.onMetadataRowsChange((prev) => prev.map((p, j): [string, string] => j === i ? [val, p[1]] : p));
								}} />
							<input class="${inputCls} font-mono" data-testid="goal-metadata-value" placeholder="value (JSON or text)" .value=${v}
								@input=${(e: Event) => {
									const val = (e.target as HTMLInputElement).value;
									config.onMetadataRowsChange((prev) => prev.map((p, j): [string, string] => j === i ? [p[0], val] : p));
								}} />
							<button class="text-muted-foreground hover:text-foreground text-sm px-1.5 shrink-0" title="Remove metadata entry"
								data-testid="goal-metadata-remove"
								@click=${() => config.onMetadataRowsChange((prev) => prev.filter((_, j) => j !== i))}>✕</button>
						</div>
					`)}
			</div>
			<button class="self-start text-[11px] text-primary hover:underline" data-testid="goal-metadata-add"
				@click=${() => config.onMetadataRowsChange((prev) => [...prev, ["", ""]])}>+ Add metadata</button>
		</div>
	`;
}

/**
 * Resolve the per-goal sub-goal submission fields (allow + max-depth) from the
 * proposal form state, mirroring EXACTLY what `renderSubgoalsToggle` displays
 * via the shared `resolveDepthControl`. This is the chokepoint that fixes the
 * stale-payload bug: the stepper clamps the displayed value into the parent's
 * valid band, so the payload must carry that same clamped value — never the raw
 * `_proposalMaxNestingDepth` the user last typed before switching parents.
 *
 * - `maxNestingDepth` is forwarded only when the user touched the control
 *   (configuredValue !== null) and the goal can actually host children; an
 *   untouched control stays unset so the server default stands.
 * - When the goal sits at the inherited cap (no room below), sub-goals are
 *   forced off — matching the disabled toggle in the UI.
 */
function proposalSubgoalSubmission(opts: {
	subgoalsEnabled: boolean;
	parentGoalId: string | undefined;
	systemCap: number;
	allowedValue: boolean | null;
	configuredValue: number | null;
}): { subgoalsAllowed: boolean | undefined; maxNestingDepth: number | undefined; allowsChildren: boolean } {
	if (!opts.subgoalsEnabled) {
		return { subgoalsAllowed: undefined, maxNestingDepth: undefined, allowsChildren: false };
	}
	const parent = opts.parentGoalId ? state.goals.find(g => g.id === opts.parentGoalId) : undefined;
	const proposedDepth = parent ? nestingDepthOf(parent.id, state.goals) + 1 : 1;
	const inheritedCap = parent
		? effectiveMaxNestingDepthOf(parent as any, state.goals as any)
		: opts.systemCap;
	const ctl = resolveDepthControl(proposedDepth, inheritedCap, opts.configuredValue);
	const subgoalsAllowed = ctl.atGlobalCap ? false : (opts.allowedValue ?? false);
	const maxNestingDepth = !ctl.atGlobalCap && opts.configuredValue !== null
		? ctl.depthValue
		: undefined;
	return { subgoalsAllowed, maxNestingDepth, allowsChildren: subgoalsAllowed === true };
}

// ── Shared sub-goal UI fragments ────────────────────────────────────────────
// Collated into the dedicated "Sub-goals" tab when the Subgoals setting is on.

/** Parent-goal picker row. */
function renderParentPickerRow(config: GoalFormConfig, lblCls: string): TemplateResult {
	const candidates = state.goals.filter(g => !g.archived && (!config.linkedProjectId || g.projectId === config.linkedProjectId));
	// Pre-compute host-eligibility so an ineligible parent is marked BEFORE
	// submit (the dead-end used to only surface as a server reject).
	const selected = config.parentGoalId ? state.goals.find(g => g.id === config.parentGoalId) : undefined;
	const selectedElig = selected ? parentHostEligibility(selected, state.goals) : undefined;
	return html`
		<div class="flex flex-col gap-1.5" data-testid="goal-form-parent-row">
			<div class="flex items-center gap-2">
				<label class="${lblCls} w-20 md:w-16">Parent Goal</label>
				<select
					class="flex-1 text-sm px-2 py-1.5 rounded-md border border-border bg-background text-foreground h-9"
					.value=${config.parentGoalId || ""}
					@change=${(e: Event) => {
						const v = (e.target as HTMLSelectElement).value;
						config.onParentGoalChange?.(v || undefined);
					}}
					data-testid="goal-form-parent-picker"
				>
					<option value="">None (Default)</option>
					${candidates.map(g => {
						const elig = parentHostEligibility(g, state.goals);
						const label = elig.eligible ? g.title : `${g.title} ${elig.suffix}`;
						return html`
							<option value=${g.id} ?selected=${config.parentGoalId === g.id}>${label}</option>
						`;
					})}
				</select>
			</div>
			${selectedElig && !selectedElig.eligible ? html`
				<div class="rounded-md border px-3 py-2 text-[11px] leading-snug"
					style="border-color: color-mix(in oklch, var(--warning) 40%, transparent); background: color-mix(in oklch, var(--warning) 10%, transparent); color: var(--foreground);"
					data-testid="goal-form-parent-ineligible-warning">
					${selectedElig.hint}
				</div>
			` : ""}
		</div>
	`;
}

/** Breadcrumb + depth indicator + subgoal/top-level badge. */
function renderSubgoalBreadcrumb(config: GoalFormConfig): TemplateResult | string {
	if (config.parentGoalId) {
		// Walk parentGoalId links from the immediate parent up to the top-level
		// ancestor, then reverse so the breadcrumb reads top-level → … → parent.
		const ancestors: { id: string; title: string }[] = [];
		const seen = new Set<string>();
		let cur = state.goals.find(g => g.id === config.parentGoalId);
		while (cur && !seen.has(cur.id)) {
			seen.add(cur.id);
			ancestors.push({ id: cur.id, title: cur.title });
			cur = cur.parentGoalId ? state.goals.find(g => g.id === cur!.parentGoalId) : undefined;
		}
		ancestors.reverse();
		return html`
			<div class="flex flex-col gap-1 text-xs text-muted-foreground">
				<div class="truncate" data-testid="goal-form-breadcrumb">
					${ancestors.map(a => html`<span>${a.title}</span><span class="mx-1 opacity-50">›</span>`)}
					<span class="font-medium text-foreground/80">${config.title || "New Goal"}</span>
				</div>
			</div>
		`;
	}
	return "";
}

/** Allow-subgoals toggle + max-depth control. */
function renderSubgoalsToggle(config: GoalFormConfig): TemplateResult | string {
	if (!(config.subgoalsEnabled && config.onSubgoalsAllowedChange && config.onMaxNestingDepthChange)) return "";
	// Depth of the goal being proposed (top-level = 1; a child of a depth-N
	// goal is depth N+1). "Max depth" is the ABSOLUTE deepest nesting level
	// allowed in this tree (matching the server's `maxNestingDepth`).
	//
	// The inherited absolute cap: a child goal can never widen past its parent's
	// EFFECTIVE cap (system ∩ parent.own ∩ … up the tree) — only a top-level
	// goal gets the full system cap. Mirrors the server clamp in
	// nested-goal-routes.ts. `resolveDepthControl` is the SINGLE source of truth
	// for this math, shared with `proposalMaxNestingDepthSubmission` so the value
	// shown and the value submitted can never diverge (the stale-payload bug).
	const proposedDepth = config.parentGoalId ? nestingDepthOf(config.parentGoalId, state.goals) + 1 : 1;
	const selectedParent = config.parentGoalId ? state.goals.find(g => g.id === config.parentGoalId) : undefined;
	const inheritedCap = selectedParent
		? effectiveMaxNestingDepthOf(selectedParent as any, state.goals as any)
		: (config.maxNestingDepth ?? 3);
	const { minDepth, maxDepth, atGlobalCap, depthFixed, depthValue, levelsBelow } =
		resolveDepthControl(proposedDepth, inheritedCap, config.maxNestingDepthValue);
	const allowed = !atGlobalCap && (config.subgoalsAllowedValue ?? false);
	const infoPanel = (text: string, testid: string) => html`
		<div class="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground" data-testid=${testid}>${text}</div>
	`;
	return html`
		<div class="flex flex-col gap-2">
		<label class="flex items-center gap-1.5 ${atGlobalCap ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}">
			<input type="checkbox" class="toggle-switch"
				.checked=${allowed}
				?disabled=${atGlobalCap}
				data-testid="goal-form-subgoals-toggle"
				@change=${(e: Event) => {
					config.onSubgoalsAllowedChange?.((e.target as HTMLInputElement).checked);
				}} />
			<span class="text-xs text-muted-foreground font-medium">Allow sub-goals on this goal</span>
			<span title="Whether THIS goal (the one being created) may host child sub-goals — it does not change the selected parent. When off, the team-lead cannot use goal_spawn_child / goal_plan_propose."
				class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
		</label>
		<p class="text-[10px] text-muted-foreground/80 leading-snug" data-testid="goal-form-subgoals-toggle-help">
			Controls the goal you're creating — not the selected parent. To let an existing parent host children, open its dashboard → Children tab.
		</p>
		${atGlobalCap
			? infoPanel(`This goal sits at depth ${proposedDepth}, at the inherited nesting cap of ${maxDepth}. It cannot host sub-goals — pick a shallower parent to allow nesting.`, "goal-form-subgoals-at-cap")
			: allowed ? html`
			<label class="flex items-center gap-1.5 text-xs ${depthFixed ? "opacity-60" : "text-muted-foreground"}">
				<span>Max nesting depth</span>
				<span class="inline-flex items-center rounded-md border border-border bg-background overflow-hidden">
					<button
						type="button"
						class="flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
						title="Decrease"
						?disabled=${depthFixed || depthValue <= minDepth}
						@click=${() => config.onMaxNestingDepthChange?.(Math.max(minDepth, depthValue - 1))}
					>${icon(Minus, "xs")}</button>
					<input
						type="number"
						min=${String(minDepth)}
						max=${String(maxDepth)}
						step="1"
						.value=${String(depthValue)}
						?disabled=${depthFixed}
						data-testid="goal-form-max-depth"
						class="w-8 text-xs text-center px-0 py-0.5 border-0 border-x border-border bg-background text-foreground focus:outline-none focus:ring-0 disabled:opacity-60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
						@change=${(e: Event) => {
							const raw = parseInt((e.target as HTMLInputElement).value, 10);
							if (Number.isFinite(raw)) {
								config.onMaxNestingDepthChange?.(Math.min(maxDepth, Math.max(minDepth, raw)));
							} else {
								config.onMaxNestingDepthChange?.(null);
							}
						}} />
					<button
						type="button"
						class="flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
						title="Increase"
						?disabled=${depthFixed || depthValue >= maxDepth}
						@click=${() => config.onMaxNestingDepthChange?.(Math.min(maxDepth, depthValue + 1))}
					>${icon(Plus, "xs")}</button>
				</span>
				<span title=${`The deepest nesting level allowed in this tree. The inherited cap is ${maxDepth}; this goal sits at depth ${proposedDepth}, so it allows ${levelsBelow} level${levelsBelow === 1 ? "" : "s"} of sub-goals below it.`}
					class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
			</label>
			${depthFixed
				? infoPanel(`The inherited cap is ${maxDepth} and this goal sits at depth ${proposedDepth}, so only one nesting level fits below it — max depth is fixed at ${maxDepth}.`, "goal-form-max-depth-fixed")
				: infoPanel(`Deepest nesting level allowed in this tree (inherited cap ${maxDepth}). This goal is at depth ${proposedDepth}, so it allows ${levelsBelow} level${levelsBelow === 1 ? "" : "s"} of sub-goals below it.`, "goal-form-max-depth-help")}
		` : ""}
		</div>
	`;
}

/** Whether the dedicated Sub-goals tab should be shown: it tracks only the system Subgoals (Experimental) preference. */
function showSubgoalsTab(config: GoalFormConfig): boolean {
	return !!config.subgoalsEnabled;
}

/** Walk parentGoalId links up to the top-level (root) goal of the tree. */
function findRootGoal(parentGoalId: string): { title: string; divergencePolicy?: string; maxConcurrentChildren?: number } | undefined {
	const seen = new Set<string>();
	let cur = state.goals.find(g => g.id === parentGoalId) as (typeof state.goals)[number] | undefined;
	while (cur && (cur as { parentGoalId?: string }).parentGoalId && !seen.has(cur.id)) {
		seen.add(cur.id);
		cur = state.goals.find(g => g.id === (cur as { parentGoalId?: string }).parentGoalId);
	}
	return cur as unknown as { title: string; divergencePolicy?: string; maxConcurrentChildren?: number } | undefined;
}

const DIVERGENCE_OPTS: { id: "strict" | "balanced" | "autonomous"; label: string; desc: string }[] = [
	{ id: "strict", label: "Strict", desc: "Approve every plan change, including minor fix-ups." },
	{ id: "balanced", label: "Balanced", desc: "Auto-apply minor fix-ups; expansions still need your approval." },
	{ id: "autonomous", label: "Autonomous", desc: "Most self-directed. Dropping acceptance criteria or unpaused restructures are still blocked." },
];

/**
 * Root-only tree orchestration: max concurrent children + plan-change autonomy
 * (divergence policy). These are owned by the top-level goal and resolved at
 * the root for the whole tree, so for a child goal we render an inherited,
 * read-only summary instead of editable controls.
 */
function renderSubgoalOrchestration(config: GoalFormConfig): TemplateResult | string {
	if (!(config.onDivergencePolicyChange && config.onMaxConcurrentChildrenChange)) return "";
	// Only relevant when this goal can actually spawn children.
	const allowed = config.subgoalsAllowedValue ?? false;
	if (!allowed) return "";

	// Child goal: concurrency + autonomy are inherited from the root.
	if (config.parentGoalId) {
		const root = findRootGoal(config.parentGoalId);
		const pol = (root?.divergencePolicy as string) || "balanced";
		const cc = root?.maxConcurrentChildren ?? 5;
		return html`
			<div class="rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] leading-snug text-muted-foreground" data-testid="goal-form-orchestration-inherited">
				Concurrency and plan-change autonomy are owned by the top-level goal${root ? html` <span class="text-foreground/70 font-medium">${root.title}</span>` : ""} and inherited across the tree: <span class="text-foreground/80 font-medium">${cc} parallel</span> · <span class="text-foreground/80 font-medium">${pol}</span>.
			</div>
		`;
	}

	// Root goal: editable controls. Display the server's default (5) when the
	// user hasn't overridden it; submission keeps the field unset in that case
	// so the server stays the single source of truth for the default.
	const concurrency = Math.max(1, Math.min(8, config.maxConcurrentChildrenValue ?? 5));
	const policy = config.divergencePolicyValue ?? "balanced";
	const activeDesc = DIVERGENCE_OPTS.find(o => o.id === policy)?.desc ?? "";
	return html`
		<div class="flex flex-col gap-3 pt-1" data-testid="goal-form-orchestration">
			<div class="flex items-center gap-1.5 text-xs text-muted-foreground">
				<span>Max concurrent children</span>
				<span class="inline-flex items-center rounded-md border border-border bg-background overflow-hidden">
					<button type="button"
						class="flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
						title="Decrease" ?disabled=${concurrency <= 1}
						@click=${() => config.onMaxConcurrentChildrenChange?.(Math.max(1, concurrency - 1))}
					>${icon(Minus, "xs")}</button>
					<input type="number" min="1" max="8" step="1" .value=${String(concurrency)}
						data-testid="goal-form-max-concurrent-children"
						class="w-8 text-xs text-center px-0 py-0.5 border-0 border-x border-border bg-background text-foreground focus:outline-none focus:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
						@change=${(e: Event) => {
							const raw = parseInt((e.target as HTMLInputElement).value, 10);
							if (Number.isFinite(raw)) config.onMaxConcurrentChildrenChange?.(Math.max(1, Math.min(8, raw)));
						}} />
					<button type="button"
						class="flex items-center justify-center w-6 h-6 text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-30 disabled:pointer-events-none transition-colors"
						title="Increase" ?disabled=${concurrency >= 8}
						@click=${() => config.onMaxConcurrentChildrenChange?.(Math.min(8, concurrency + 1))}
					>${icon(Plus, "xs")}</button>
				</span>
				<span title="How many child teams may run in parallel across the whole tree (1–8). Higher = faster but more token/compute load."
					class="text-[9px] text-muted-foreground cursor-help">ⓘ</span>
			</div>
			<div class="flex flex-col gap-1">
				<span class="text-xs text-muted-foreground">Plan-change autonomy</span>
				<div class="inline-flex rounded-md border border-border overflow-hidden self-start" role="group" data-testid="goal-form-divergence-policy">
					${DIVERGENCE_OPTS.map((o, i) => html`<button type="button"
						data-testid="goal-form-divergence-${o.id}"
						aria-pressed=${policy === o.id ? "true" : "false"}
						class="text-xs px-3 py-1 transition-colors ${i > 0 ? "border-l border-border" : ""} ${policy === o.id ? "bg-primary text-primary-foreground font-medium" : "bg-background text-muted-foreground hover:text-foreground hover:bg-secondary"}"
						@click=${() => config.onDivergencePolicyChange?.(o.id)}
					>${o.label}</button>`)}
				</div>
				<span class="text-[11px] text-muted-foreground leading-snug">${activeDesc}</span>
			</div>
		</div>
	`;
}

function renderGoalForm(config: GoalFormConfig) {
	ensureMarkdownBlock();
	const linkedProject = config.linkedProjectId ? state.projects.find(p => p.id === config.linkedProjectId) : null;
	const wfState = config.workflowState ?? "ready";
	const inlineWorkflow = hasValidInlineWorkflowDraft(config.inlineWorkflow) ? config.inlineWorkflow : null;
	const selectedWorkflowId = inlineWorkflow?.id ?? config.workflowId;
	const workflowOptions = goalWorkflowSelectOptions(inlineWorkflow);
	const noWorkflows = wfState === "empty" && workflowOptions.length === 0;
	const workflowsLoading = wfState === "loading" && workflowOptions.length === 0;
	const worktreePath = linkedProject
		? worktreePreviewPath(linkedProject.rootPath, config.title)
		: worktreePreviewPath(config.cwd, config.title);
	const selectedLibraryWorkflow = _cachedWorkflows.find(w => w.id === selectedWorkflowId) ?? null;
	const wf = inlineWorkflow ?? selectedLibraryWorkflow;
	const workflowInvalid = isWorkflowSelectionInvalid(selectedWorkflowId, inlineWorkflow);
	const workflowProblem = workflowInvalid || !!config.workflowValidationFailed;
	const workflowErrorMessage = config.workflowErrorMessage && workflowProblem ? config.workflowErrorMessage : "";
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

	const createBusy = !!config.saving;
	const createDisabled = (config.createDisabled ?? !config.title.trim()) || createBusy || !!config.streaming || noWorkflows || workflowProblem;

	queueMicrotask(() => {
		reconcileFollowTail(goalSpecPreviewRef.value);
		reconcileFollowTail(goalSpecTextareaRef.value);
		// mini-lit's Button helper does not expose aria-busy; stamp it onto the
		// generated button so the shared goal form stays accessible while saving.
		const createButton = goalCreateButtonContainerRef.value?.querySelector("button");
		if (createButton) createButton.setAttribute("aria-busy", createBusy ? "true" : "false");
	});

	// When viewing a historical Goal (vN) tab, show that revision's number
	// in the panel header instead of the live slot's latest rev.
	const goalRev = (_proposalOverride?.type === "goal" ? _proposalOverride.rev : state.activeProposals.goal?.rev) ?? 0;
	const subgoalsTab = showSubgoalsTab(config);
	const requestedActiveTab: ProposalTab = config.activeTab ?? "goal";
	const activeTab: ProposalTab = requestedActiveTab === "subgoals" && !subgoalsTab ? "goal" : requestedActiveTab;
	const goalBody = html`
		<div class="flex-1 overflow-y-auto px-5 pt-3 md:pt-4 pb-3 flex flex-col gap-2.5"
			role="tabpanel"
			id="goal-proposal-panel-goal"
			aria-labelledby="goal-proposal-tab-goal"
			data-testid="goal-proposal-panel-goal">
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
				` : workflowOptions.length > 0 ? html`
					<div class="flex items-center gap-2 md:shrink-0">
						<label class="${lblCls} w-20 md:w-auto">Workflow</label>
						<select
							class="flex-1 md:flex-none md:w-44 text-sm px-2 py-1.5 rounded-md border bg-background text-foreground h-9 ${workflowProblem ? "border-[color:var(--negative)]" : "border-border"}"
							.value=${selectedWorkflowId}
							aria-invalid=${workflowProblem ? "true" : "false"}
							@change=${config.onWorkflowChange}
						>
							${workflowProblem ? html`
								<option value=${selectedWorkflowId} ?selected=${true} disabled>
									${selectedWorkflowId ? `Unknown workflow: ${selectedWorkflowId}` : "Select workflow"}
								</option>
							` : ""}
							${workflowOptions.map((option) => html`
								<option value=${option.id} ?selected=${selectedWorkflowId === option.id}>${option.label}</option>
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
			<div class="flex items-center justify-between gap-3">
				<div class="min-w-0 flex-1">
					${workflowErrorMessage ? html`
						<div
							class="text-xs leading-snug truncate"
							style="color: var(--negative);"
							data-testid="goal-proposal-workflow-error"
							title=${workflowErrorMessage}
						>${workflowErrorMessage}</div>
					` : ""}
				</div>
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
					${ref(goalCreateButtonContainerRef)}
					data-testid="proposal-primary-submit"
					aria-busy=${createBusy ? "true" : "false"}
					title=${noWorkflows ? "This project has no workflows yet — run the project assistant first." : workflowErrorMessage ? workflowErrorMessage : ""}
				>${Button({
					variant: "default",
					onClick: config.onCreate,
					disabled: createDisabled,
					children: createBusy ? "Creating…" : html`<span class="inline-flex items-center gap-1.5">${icon(GoalIcon, "sm")} Create Goal</span>`,
				})}</span>
				</div>
			</div>
		</div>
	`;
	const onTabChange = (t: ProposalTab) => config.onTabChange?.(t);
	const onTabKey = (e: KeyboardEvent) => {
		const order: ProposalTab[] = subgoalsTab ? ["goal", "workflow", "roles", "metadata", "subgoals"] : ["goal", "workflow", "roles", "metadata"];
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
			<button
				role="tab"
				id="goal-proposal-tab-metadata"
				data-testid="goal-proposal-tab-metadata"
				aria-selected=${activeTab === "metadata" ? "true" : "false"}
				aria-controls="goal-proposal-panel-metadata"
				tabindex=${activeTab === "metadata" ? 0 : -1}
				class=${tabCls(activeTab === "metadata")}
				@click=${() => onTabChange("metadata")}
				@keydown=${onTabKey}
			>Metadata</button>
			${subgoalsTab ? html`<button
				role="tab"
				id="goal-proposal-tab-subgoals"
				data-testid="goal-proposal-tab-subgoals"
				aria-selected=${activeTab === "subgoals" ? "true" : "false"}
				aria-controls="goal-proposal-panel-subgoals"
				tabindex=${activeTab === "subgoals" ? 0 : -1}
				class=${tabCls(activeTab === "subgoals")}
				@click=${() => onTabChange("subgoals")}
				@keydown=${onTabKey}
			>Sub-goals</button>` : ""}
			${goalRev > 0 ? html`<span class="ml-auto mb-1.5 text-xs px-2 py-0.5 rounded-full border border-border text-muted-foreground" data-testid="proposal-panel-rev">rev ${goalRev}</span>` : ""}
		</div>
	`;
	const panel = activeTab === "goal"
		? goalBody
		: activeTab === "workflow"
			? renderProposalWorkflowTab(config)
			: activeTab === "roles"
				? renderProposalRolesTab(config)
				: activeTab === "metadata"
					? renderProposalMetadataTab(config)
					: renderProposalSubgoalsTab(config);
	return html`${config.crossProjectBanner ?? nothing}${tabBar}${panel}${footer}`;
}

// ============================================================================
// GOAL PROPOSAL — WORKFLOW TAB
//
// A workflow <select> (synced to the Goal tab's picker via the shared
// config.workflowId / config.onWorkflowChange) with a Customise/Revert toggle
// to its right; the chosen workflow renders beneath in read-only inspector
// form, or as the editor while customising. Reuses renderWorkflowInspector /
// renderWorkflowEditor from src/app/workflow-page.ts. The editor runs in
// `goal-draft` scope: every mutation flows back through
// `config.onInlineWorkflowChange` and NEVER mutates the project workflow store.
// ============================================================================
function renderProposalWorkflowTab(config: GoalFormConfig): TemplateResult {
	const workflows = _cachedWorkflows;
	const inline = hasValidInlineWorkflowDraft(config.inlineWorkflow) ? config.inlineWorkflow : null;
	const selectedId = inline?.id ?? config.workflowId;
	const workflowOptions = goalWorkflowSelectOptions(inline);
	const customizing = !!config.customizingWorkflow && !!inline;
	const selectedLibrary = workflows.find((w) => w.id === selectedId) ?? null;
	const displayWf = inline ?? selectedLibrary;
	const workflowInvalid = isWorkflowSelectionInvalid(selectedId, inline);
	const workflowProblem = workflowInvalid || !!config.workflowValidationFailed;
	const workflowErrorMessage = config.workflowErrorMessage && workflowProblem ? config.workflowErrorMessage : "";
	return html`
		<div class="flex-1 overflow-hidden flex flex-col min-h-0 min-w-0"
			role="tabpanel"
			id="goal-proposal-panel-workflow"
			aria-labelledby="goal-proposal-tab-workflow"
			data-testid="goal-proposal-panel-workflow">
			${workflowOptions.length === 0
				? html`<p class="text-xs text-muted-foreground px-5 pt-3">No workflows available for this project.</p>`
				: html`
					<div class="shrink-0 flex items-center gap-2 px-5 pt-3 md:pt-4 pb-3">
						<label class="text-xs text-muted-foreground font-medium shrink-0">Workflow</label>
						<select
							class="flex-1 min-w-0 text-sm px-2 py-1.5 rounded-md border bg-background text-foreground h-9 ${workflowProblem ? "border-[color:var(--negative)]" : "border-border"}"
							data-testid="goal-proposal-workflow-select"
							.value=${selectedId}
							aria-invalid=${workflowProblem ? "true" : "false"}
							@change=${config.onWorkflowChange}>
							${workflowProblem ? html`
								<option value=${selectedId} ?selected=${true} disabled>
									${selectedId ? `Unknown workflow: ${selectedId}` : "Select workflow"}
								</option>
							` : ""}
							${workflowOptions.map((option) => html`
								<option value=${option.id} ?selected=${selectedId === option.id}>${option.label}</option>
							`)}
						</select>
						${customizing
							? Button({
									variant: "ghost",
									size: "sm",
									onClick: () => config.onResetWorkflow?.(),
									children: html`<span data-testid="goal-proposal-workflow-reset">Revert to project definition</span>`,
							  })
							: Button({
									variant: "secondary",
									size: "sm",
									onClick: () => config.onCustomizeWorkflow?.(),
									disabled: !selectedLibrary || !config.onCustomizeWorkflow,
									children: html`<span data-testid="goal-proposal-workflow-customize">Customise for this goal</span>`,
							  })}
					</div>
					<hr class="shrink-0 border-t border-border" />
					<div class="flex-1 min-h-0 min-w-0 overflow-auto px-5 py-3">
						${workflowProblem ? html`
							<div class="rounded-md border p-3 text-sm" style="border-color: color-mix(in oklch, var(--negative) 45%, transparent); background: color-mix(in oklch, var(--negative) 8%, transparent); color: var(--negative);">
								${workflowErrorMessage || (selectedId ? `Unknown workflow: ${selectedId}` : "Select a workflow before creating this goal.")}
							</div>
						` : customizing && inline
							? renderWorkflowEditor({
								workflow: inline,
								onChange: (wf) => config.onInlineWorkflowChange?.(wf),
								scope: "goal-draft",
							})
							: renderWorkflowInspector({ workflow: displayWf, scope: "goal-draft" })}
					</div>
				`}
		</div>
	`;
}

// ============================================================================
// GOAL PROPOSAL — ROLES TAB
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
								disabled: !config.onCustomizeRole,
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

// ============================================================================
// GOAL PROPOSAL — METADATA TAB
//
// Reuses the goal metadata editor so every goal proposal surface shares the
// same draft rows and submit semantics.
// ============================================================================
function renderProposalMetadataTab(config: GoalFormConfig): TemplateResult {
	return html`
		<div class="flex-1 overflow-y-auto px-5 pt-3 md:pt-4 pb-3 flex flex-col gap-2.5"
			role="tabpanel"
			id="goal-proposal-panel-metadata"
			aria-labelledby="goal-proposal-tab-metadata"
			data-testid="goal-proposal-panel-metadata">
			${renderGoalMetadataEditor(config)}
		</div>
	`;
}

// ============================================================================
// GOAL PROPOSAL — SUB-GOALS TAB
//
// Collates the per-goal nesting controls: parent picker, breadcrumb, and the
// allow-subgoals toggle + max-depth control.
// ============================================================================
function renderProposalSubgoalsTab(config: GoalFormConfig): TemplateResult {
	const lblCls = "text-xs text-muted-foreground font-medium shrink-0";
	const sectionHeading = (title: string, desc: string, testid: string) => html`
		<div class="flex flex-col gap-0.5" data-testid=${testid}>
			<h3 class="text-xs font-semibold text-foreground">${title}</h3>
			<p class="text-[11px] text-muted-foreground leading-snug">${desc}</p>
		</div>
	`;
	const hostControls = config.subgoalsEnabled && config.onSubgoalsAllowedChange && config.onMaxNestingDepthChange;
	return html`
		<div class="flex-1 overflow-y-auto px-5 pt-3 md:pt-4 pb-3 flex flex-col gap-5"
			role="tabpanel"
			id="goal-proposal-panel-subgoals"
			aria-labelledby="goal-proposal-tab-subgoals"
			data-testid="goal-proposal-panel-subgoals">

			<!-- Section 1: where this NEW goal lives — attach it under an existing goal. -->
			<section class="flex flex-col gap-2.5" data-testid="goal-form-attach-section">
				${sectionHeading(
					"Attach to an existing goal",
					"Choose where this new goal lives. Pick an existing goal to nest this one beneath it, or leave None to create it at the top level.",
					"goal-form-attach-heading",
				)}
				${renderParentPickerRow(config, lblCls)}
				${renderSubgoalBreadcrumb(config)}
			</section>

			<!-- Section 2: whether the NEW goal may host its OWN future children. -->
			${hostControls ? html`
				<section class="flex flex-col gap-2.5 border-t border-border/60 pt-4" data-testid="goal-form-host-section">
					${sectionHeading(
						"Allow this new goal to host sub-goals",
						"Whether the goal you're creating may spawn its own child sub-goals later. This is about the new goal — it does not change the parent selected above.",
						"goal-form-host-heading",
					)}
					<div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
						${renderSubgoalsToggle(config)}
					</div>
					${renderSubgoalOrchestration(config)}
				</section>
			` : ""}
		</div>
	`;
}

function goalPreviewPanel() {
	// Populate previewProjectId for re-attempt / assistant sessions where it
	// wasn't seeded by the +New Goal picker. Resolution order:
	// 1. Proposal/project assistant field.
	// 2. Active session's projectId (server inherits this for re-attempts).
	// 3. Original goal's projectId via reattemptGoalId. Never infer from cwd.
	{
		const sid = state.activeProposals.goal?.sessionId || activeSessionId();
		const candidate = resolveGoalProposalProjectId(sid, state.activeProposals.goal?.fields);
		if (candidate && state.projects.some(p => p.id === candidate)) {
			if (state.previewProjectId !== candidate) state.previewProjectId = candidate;
		} else if (state.previewProjectId) {
			state.previewProjectId = "";
		}
	}
	useGoalProposalTabsContext(goalProposalTabsContextKey("preview"));
	// The assistant preview renders from state.preview* mirrors, but Workflow /
	// Roles tab drafts live in the shared proposal-tab state. Hydrate proposal-
	// supplied inline workflow/role snapshots here too so assistant, +New Goal,
	// re-attempt, and project-scoped goal creation stay behaviorally equivalent
	// to the non-assistant proposal panel.
	syncProposalFormState();
	ensureWorkflowsLoaded(state.previewProjectId || undefined);
	ensureSandboxStatusLoaded();
	ensureProposalRolesLoaded();
	ensureProposalGroupPoliciesLoaded();
	ensureToolsLoaded();
	const subgoalsEnabled = isSubgoalsEnabled();
	const maxNestingDepth = getSystemMaxNestingDepth();
	const inlineWorkflowDraft = selectedInlineWorkflowDraft();
	const workflowValidationError = inlineWorkflowDraft ? undefined : activeGoalWorkflowValidationError();
	const workflowErrorMessage = workflowErrorMessageWithAvailable(workflowValidationError);
	const failedWorkflowId = failedGoalWorkflowId(workflowValidationError);
	const assistantWorkflowId = inlineWorkflowDraft?.id ?? failedWorkflowId ?? _selectedWorkflowId;
	const assistantWorkflowBlocked = !!workflowValidationError || isWorkflowSelectionInvalid(assistantWorkflowId, inlineWorkflowDraft);
	const setAssistantWorkflowId = (id: string) => {
		_selectedWorkflowId = id;
		if (isKnownWorkflowId(_selectedWorkflowId)) clearActiveGoalWorkflowValidationError();
	};

	const handleCreateGoal = async () => {
		const trimmedTitle = state.previewTitle.trim();
		if (!trimmedTitle || _goalPreviewSaving) return;
		if (!state.previewProjectId) {
			showConnectionError("No project selected for this goal", "Select a project from the + New Goal picker before creating a goal.");
			return;
		}
		const inlineWorkflowField = _proposalInlineWorkflow ?? undefined;
		const hasInlineWorkflowForSubmission = hasValidInlineWorkflowDraft(inlineWorkflowField);
		// Guard: refuse to accept while the linked project has no workflows unless
		// the proposal carries its own inline workflow body.
		// The form's banner handles the affordance; this is the defensive backstop.
		if (workflowStateFor(state.previewProjectId) === "empty" && !hasInlineWorkflowForSubmission) {
			showConnectionError(
				"This project has no workflows yet",
				"Run the project assistant from the goal panel banner (or Settings → Components) to scaffold workflows before creating a goal.",
			);
			return;
		}

		if (assistantWorkflowBlocked) {
			showConnectionError("Select a valid workflow", workflowErrorMessage || "Choose one of the available workflows before creating this goal.");
			return;
		}

		// Snapshot form state up-front so a retry after createGoal() rejection
		// reads the latest values (the user may have edited the workflow id /
		// title between attempts).
		const sessionId = activeSessionId();
		const projectId = state.previewProjectId || undefined;
		const inlineRolesField = Object.keys(_proposalInlineRoles).length > 0
			? _proposalInlineRoles as Record<string, unknown>
			: undefined;
		const workflowId = inlineWorkflowField ? undefined : (assistantWorkflowId || undefined);
		const sandboxed = _goalSandboxed;
		const autoStartTeam = _goalAutoStartTeam;
		const enabledOptionalSteps = _assistantEnabledOptionalSteps.length > 0 ? _assistantEnabledOptionalSteps : undefined;
		const currentSession = state.gatewaySessions.find(s => s.id === sessionId);
		const reattemptGoalId = currentSession?.reattemptGoalId;
		const parentGoalIdField = subgoalsEnabled ? (_proposalParentGoalId || undefined) : undefined;
		const subgoalSubmission = proposalSubgoalSubmission({
			subgoalsEnabled,
			parentGoalId: parentGoalIdField,
			systemCap: maxNestingDepth,
			allowedValue: _proposalSubgoalsAllowed,
			configuredValue: _proposalMaxNestingDepth,
		});
		const isRootProposal = !parentGoalIdField;
		const allowsChildren = subgoalSubmission.allowsChildren;
		const divergencePolicyField = isRootProposal && allowsChildren && _proposalDivergencePolicy !== null
			? _proposalDivergencePolicy
			: undefined;
		const maxConcurrentChildrenField = isRootProposal && allowsChildren && _proposalMaxConcurrentChildren !== null
			? _proposalMaxConcurrentChildren
			: undefined;

		_goalPreviewSaving = true;
		renderApp();

		// Await the server FIRST. If it rejects, leave the assistant session,
		// draft, gateway.sessionId, and form state intact so the user can edit
		// (e.g. change workflow) and try again. See goal spec §1.
		let goal;
		try {
			const submitCwd = isHeadquartersProject(projectId) && !state.previewCwdEdited ? "" : state.previewCwd.trim();
			goal = await createGoal(trimmedTitle, submitCwd, {
				spec: state.previewSpec,
				workflowId,
				workflow: inlineWorkflowField,
				inlineRoles: inlineRolesField,
				reattemptOf: reattemptGoalId || undefined,
				sandboxed,
				projectId,
				enabledOptionalSteps,
				autoStartTeam,
				parentGoalId: parentGoalIdField,
				subgoalsAllowed: subgoalSubmission.subgoalsAllowed,
				maxNestingDepth: subgoalSubmission.maxNestingDepth,
				divergencePolicy: divergencePolicyField,
				maxConcurrentChildren: maxConcurrentChildrenField,
				metadata: metadataRowsToObject(state.previewMetadataRows),
			});
		} catch (err) {
			const { message, code, stack } = errorDetails(err);
			showConnectionError("Failed to create goal", message, { code, stack });
			_goalPreviewSaving = false;
			renderApp();
			return;
		}
		if (!goal) {
			// createGoal() returns falsy on certain server errors (the helper
			// already surfaces a toast). Preserve the assistant either way.
			_goalPreviewSaving = false;
			renderApp();
			return;
		}
		_goalPreviewSaving = false;

		const closeProposalTab = closeCurrentProposalPanel("goal", sessionId);

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
		recomputeAssistantHasProposal();
		state.previewProjectId = "";
		_selectedWorkflowId = "";
		_goalSandboxed = false;
		_goalAutoStartTeam = true;
		_goalPreviewSaving = false;
		_assistantEnabledOptionalSteps = [];
		_proposalParentGoalId = "";
		_proposalSubgoalsAllowed = null;
		_proposalMaxNestingDepth = null;
		_proposalDivergencePolicy = null;
		_proposalMaxConcurrentChildren = null;
		state.previewMetadataRows = [];
		state.previewMetadataEdited = false;
		resetProposalTabsState();
		if (sessionId) {
			deleteGoalDraft(sessionId);
		}
		localStorage.removeItem("gateway.sessionId");
		state.appView = "authenticated";

		// Slice E: close the workspace tab before deleting/navigating the source
		// assistant session, then drop the on-disk proposal file once accepted.
		await closeProposalTab;
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
				workflowId: assistantWorkflowId,
				sandboxed: _goalSandboxed,
				specEditMode: state.previewSpecEditMode,
				enabledOptionalSteps: _assistantEnabledOptionalSteps,
				crossProjectBanner: crossProjectBanner("goal", state.activeProposals.goal?.sessionId ?? activeSessionId()),
				linkedProjectId: state.previewProjectId || undefined,
				workflowState: workflowStateFor(state.previewProjectId || undefined),
				workflowErrorMessage,
				workflowValidationFailed: !!workflowValidationError,
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
				onWorkflowChange: (e: Event) => {
					setAssistantWorkflowId((e.target as HTMLSelectElement).value);
					_proposalInlineWorkflow = null;
					_proposalCustomizingWorkflow = false;
					clearWorkflowEditorController();
					commitGoalProposalTabsState();
					renderApp();
				},
				onSandboxChange: (e: Event) => { _goalSandboxed = (e.target as HTMLInputElement).checked; renderApp(); },
				onSpecEditToggle: () => { state.previewSpecEditMode = !state.previewSpecEditMode; renderApp(); },
				onOptionalStepsChange: (steps) => { _assistantEnabledOptionalSteps = steps; renderApp(); },
				autoStartTeam: _goalAutoStartTeam,
				onAutoStartTeamChange: (e: Event) => { _goalAutoStartTeam = (e.target as HTMLInputElement).checked; renderApp(); },
				metadataRows: state.previewMetadataRows,
				onMetadataRowsChange: (update) => {
					// Resolve against the LIVE rows so rapid edits compose across the
					// rAF-throttled render (see the updater contract on GoalFormConfig).
					state.previewMetadataRows = typeof update === "function" ? update(state.previewMetadataRows) : update;
					// Mark as user-edited so an authoritative proposal reconcile can't
					// clobber these rows (mirrors the title/spec/cwd *Edited guards).
					state.previewMetadataEdited = true;
					const sid = activeSessionId();
					if (sid) saveGoalDraft(sid);
					renderApp();
				},
				cwdDropdownOpen: state.cwdDropdownOpen,
				cwdHighlightIndex: state.cwdHighlightIndex,
				onCwdToggle: (open) => { state.cwdDropdownOpen = open; renderApp(); },
				onCwdHighlight: (i) => { state.cwdHighlightIndex = i; },
				onCreate: handleCreateGoal,
				saving: _goalPreviewSaving,
				streaming: isProposalStreaming("goal_proposal"),
				commentable: true,
				createDisabled: (() => {
					if (_goalPreviewSaving || assistantWorkflowBlocked) return true;
					if (subgoalsEnabled && _proposalParentGoalId && maxNestingDepth !== undefined) {
						const pDepth = nestingDepthOf(_proposalParentGoalId, state.goals);
						if (pDepth + 1 > maxNestingDepth) return true;
					}
					return false;
				})(),
				parentGoalId: _proposalParentGoalId || undefined,
				onParentGoalChange: (id) => {
					_proposalParentGoalId = id || "";
					const sid = activeSessionId();
					if (sid) saveGoalDraft(sid);
					renderApp();
				},
				subgoalsEnabled,
				maxNestingDepth,
				subgoalsAllowedValue: _proposalSubgoalsAllowed,
				maxNestingDepthValue: _proposalMaxNestingDepth,
				onSubgoalsAllowedChange: (value: boolean) => { _proposalSubgoalsAllowed = value; renderApp(); },
				onMaxNestingDepthChange: (value: number | null) => { _proposalMaxNestingDepth = value; renderApp(); },
				divergencePolicyValue: _proposalDivergencePolicy,
				maxConcurrentChildrenValue: _proposalMaxConcurrentChildren,
				onDivergencePolicyChange: (value) => { _proposalDivergencePolicy = value; renderApp(); },
				onMaxConcurrentChildrenChange: (value) => { _proposalMaxConcurrentChildren = value; renderApp(); },
				...goalProposalTabsConfig(assistantWorkflowId, setAssistantWorkflowId),
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
	fetchTools(state.previewProjectId || undefined).then((tools) => { _availableTools = tools; renderApp(); });
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
		const projectId = proposalProjectId("role", proposalSessionId);
		if (!projectId) {
			showConnectionError("No project selected for this role", "Dismiss this proposal and create the role from a project or Headquarters settings.");
			return;
		}

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
			projectId,
		});
		if (!created) return;

		clearProposalReviewState(proposalSessionId, "role");
		delete state.activeProposals.role;
		recomputeAssistantHasProposal();
		void closeCurrentProposalPanel("role", proposalSessionId);
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
			${crossProjectBanner("role", state.activeProposals.role?.sessionId ?? activeSessionId())}
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
			${crossProjectBanner("tool", state.activeProposals.tool?.sessionId ?? activeSessionId())}
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
	const explicit = state.activeProposals.staff?.fields?.projectId;
	if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
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
	return defaultCwdForProjectSession(project);
}

function seedStaffPreviewCwdFromProject(project = activeProjectForStaffPreview()): void {
	if (state.staffPreviewCwdEdited || state.staffPreviewCwd.trim()) return;
	const cwd = defaultCwdForProjectSession(project);
	if (cwd) state.staffPreviewCwd = cwd;
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
		if (!submitProjectId || !submitProject) {
			showConnectionError("No project selected for this staff agent", "Dismiss this proposal and start staff creation from a project or Headquarters.");
			return;
		}
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
				worktree: isHeadquartersProject(submitProject) ? false : state.staffPreviewWorktree,
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
			void closeCurrentProposalPanel("staff", proposalSessionId);
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
			${crossProjectBanner("staff", staffPreviewSessionId())}
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
let _projectProposalAcceptPending = false;
let _projectProposalAcceptError: { title: string; message: string } | null = null;

/** Reset module-level proposal panel state. Called on session disconnect. */
export function resetProjectProposalPanel(): void {
	_projectProposalView = "components";
	_projectProposalAcceptPending = false;
	_projectProposalAcceptError = null;
}

const PROJECT_ACCEPT_FAILED = "Project proposal accept failed";
const NO_PROJECT_PROPOSAL = "There is no active project proposal to accept. Re-open the proposal and try again.";
const UNLINKED_PROJECT_PROPOSAL = "This proposal is not linked to a project session. Re-open the project assistant or create the project again.";

function setProjectProposalAcceptError(title: string, message: string): void {
	_projectProposalAcceptError = { title, message };
	renderApp();
}

function clearProjectProposalAcceptError(): void {
	if (!_projectProposalAcceptError) return;
	_projectProposalAcceptError = null;
	renderApp();
}

function showProjectProposalCaughtError(title: string, err: unknown): void {
	const { message, code, stack } = errorDetails(err);
	setProjectProposalAcceptError(title, message);
	showConnectionError(title, message, { code, stack });
}

async function showProjectProposalResponseError(res: Response, title: string, fallback: string): Promise<void> {
	let data: any = {};
	try { data = await res.json(); } catch { data = {}; }
	const details = Array.isArray(data?.details) && data.details.length > 0
		? data.details.map((d: any) => d?.message ?? String(d)).join("\n")
		: "";
	const message = details || data?.error || `${fallback}: ${res.status}`;
	setProjectProposalAcceptError(title, message);
	showConnectionError(title, message, { code: data?.code, stack: data?.stack });
}

function activeProjectProposalOrFail(): NonNullable<typeof state.activeProposals.project> | null {
	const proposal = state.activeProposals.project;
	if (!proposal) showConnectionError(PROJECT_ACCEPT_FAILED, NO_PROJECT_PROPOSAL);
	return proposal ?? null;
}

/**
 * Resolve the project a project-proposal accept should target (design §5,
 * tri-state — mirrors the server mutation-boundary invariant in §3):
 *   explicit + registered → that project id (EDIT)
 *   explicit + unknown    → UNKNOWN_PROJECT error, null (REJECT, no create)
 *   absent                → session's project (unchanged new-project/provisional flow)
 * The UI only preflights; the server remains authoritative.
 */
function projectIdForProjectProposal(sessionId: string, fields?: Record<string, unknown>): string | null {
	const explicitRaw = fields?.projectId;
	const explicit = typeof explicitRaw === "string" && explicitRaw.trim() ? explicitRaw.trim() : undefined;
	if (explicit) {
		if (state.projects.some(p => p.id === explicit)) return explicit; // EDIT registered target
		showConnectionError(PROJECT_ACCEPT_FAILED, `Unknown project "${explicit}". Cross-project proposals must target an already-registered project.`);
		return null; // explicit + unknown → never fall through to the new-project flow
	}
	const projectId = state.gatewaySessions.find(s => s.id === sessionId)?.projectId;
	if (!projectId) showConnectionError(PROJECT_ACCEPT_FAILED, UNLINKED_PROJECT_PROPOSAL);
	return projectId || null;
}

async function invalidateProjectProposalConfig(projectId: string): Promise<void> {
	const m = await import("./settings-page.js");
	m.invalidateProjectScopeConfig(projectId);
}

async function promoteProjectProposal(projectId: string, name: string): Promise<boolean> {
	try {
		const body: Record<string, unknown> = {};
		if (name) body.name = name;
		const res = await gatewayFetch(`/api/projects/${projectId}/promote`, {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			await showProjectProposalResponseError(res, "Failed to promote project", "Project promotion failed");
			return false;
		}
		return true;
	} catch (err) {
		showProjectProposalCaughtError("Failed to promote project", err);
		return false;
	}
}

async function writeProjectProposalConfig(projectId: string, fields: Record<string, unknown>): Promise<boolean> {
	const diff = buildProjectConfigDiff(fields);
	if (Object.keys(diff).length === 0) return true;
	try {
		const res = await gatewayFetch(`/api/projects/${projectId}/config`, {
			method: "PUT",
			body: JSON.stringify(diff),
		});
		if (!res.ok) {
			await showProjectProposalResponseError(res, "Failed to save project config", "Config write failed");
			return false;
		}
		return true;
	} catch (err) {
		showProjectProposalCaughtError("Failed to save project config", err);
		return false;
	}
}

function notifyProjectProposalAccepted(sessionId: string, summary: string): void {
	const message = `[SYSTEM: The user accepted your project proposal${summary ? ` "${summary}"` : ""}. The change is now live in the project — continue with your task.]`;
	void gatewayFetch(`/api/sessions/${sessionId}/notify`, {
		method: "POST",
		body: JSON.stringify({ message }),
	}).catch((err) => console.warn("[proposal-notify] Failed to notify proposing session:", err));
}

export async function acceptProjectProposalFromPanel(): Promise<boolean> {
	const proposal = activeProjectProposalOrFail();
	if (!proposal) return false;
	return proposal.mode === "registered"
		? acceptRegisteredProjectProposalFromPanel(proposal)
		: acceptProvisionalProjectProposalFromPanel(proposal);
}

async function terminateProjectAssistantSessionFromPanel(sessionId: string): Promise<void> {
	try {
		uncacheSession(sessionId);
		if (activeSessionId() === sessionId) {
			state.remoteAgent?.disconnect();
			state.remoteAgent = null;
		}
		const res = await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		if (!res.ok && res.status !== 404) console.warn(`[project-proposal] Terminate returned ${res.status}`);
		state.gatewaySessions = state.gatewaySessions.filter(s => s.id !== sessionId);
		renderApp();
		deleteGoalDraft(sessionId);
		deleteRoleDraft(sessionId);
		deleteProjectDraft(sessionId);
		delete state.projectProposalAcceptedBySessionId[sessionId];
		await refreshSessions();
		setHashRoute("landing");
	} catch (err) {
		console.error("[project-proposal] Failed to terminate assistant session:", err);
	}
	renderApp();
}

async function acceptProvisionalProjectProposalFromPanel(proposal: NonNullable<typeof state.activeProposals.project>): Promise<boolean> {
	const { fields, sessionId: propSessionId } = proposal;
	const projectId = projectIdForProjectProposal(propSessionId, fields as Record<string, unknown>);
	if (!projectId) return false;
	if (!await promoteProjectProposal(projectId, typeof fields.name === "string" ? fields.name : "")) return false;
	if (!await writeProjectProposalConfig(projectId, fields as Record<string, unknown>)) return false;

	setProjects(await fetchProjects());
	void invalidateProjectProposalConfig(projectId);
	delete state.activeProposals.project;
	state.assistantHasProposal = false;
	void closeSidePanelTab(proposalPanelTabId("project"), { sessionId: propSessionId });
	deleteProjectDraft(propSessionId);
	void deleteProposalFile(propSessionId, "project");
	await terminateProjectAssistantSessionFromPanel(propSessionId);
	return true;
}

async function acceptRegisteredProjectProposalFromPanel(proposal: NonNullable<typeof state.activeProposals.project>): Promise<boolean> {
	const { fields, sessionId: propSessionId } = proposal;
	const projectId = projectIdForProjectProposal(propSessionId, fields as Record<string, unknown>);
	if (!projectId) return false;
	const fieldNameStr = typeof fields.name === "string" ? fields.name : "";
	if (fieldNameStr) {
		try {
			const res = await gatewayFetch(`/api/projects/${projectId}`, {
				method: "PUT",
				body: JSON.stringify({ name: fieldNameStr }),
			});
			if (!res.ok) {
				await showProjectProposalResponseError(res, "Failed to rename project", "Project rename failed");
				return false;
			}
		} catch (err) {
			showProjectProposalCaughtError("Failed to rename project", err);
			return false;
		}
	}
	if (!await writeProjectProposalConfig(projectId, fields as Record<string, unknown>)) return false;

	setProjects(await fetchProjects());
	void invalidateProjectProposalConfig(projectId);
	state.projectProposalAcceptedBySessionId[propSessionId] = true;
	delete state.activeProposals.project;
	state.assistantHasProposal = false;
	void closeSidePanelTab(proposalPanelTabId("project"), { sessionId: propSessionId });
	saveProjectDraft(propSessionId);
	void deleteProposalFile(propSessionId, "project");
	notifyProjectProposalAccepted(propSessionId, fieldNameStr || "(unnamed)");
	renderApp();
	return true;
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
				await terminateProjectAssistantSessionFromPanel(sessId);
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
		if (_projectProposalAcceptPending) return;
		_projectProposalAcceptPending = true;
		_projectProposalAcceptError = null;
		renderApp();
		// Let the pending render commit before the mutation starts. This gives users
		// immediate feedback and closes the duplicate-click window under load.
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		try {
			await acceptProjectProposalFromPanel();
		} finally {
			_projectProposalAcceptPending = false;
			renderApp();
		}
	};

	const handleDismiss = () => {
		clearProjectProposalAcceptError();
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

	const acceptLabel = _projectProposalAcceptPending
		? isRegistered ? "Applying…" : "Accepting…"
		: isRegistered ? "Apply Changes" : "Accept Project";
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
			${crossProjectBanner("project", proposal.sessionId)}
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
				${_projectProposalAcceptError ? html`
					<div class="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm" data-testid="project-proposal-accept-error" role="alert">
						<div class="font-medium text-destructive">${_projectProposalAcceptError.title}</div>
						<div class="mt-1 text-foreground/80 whitespace-pre-wrap">${_projectProposalAcceptError.message}</div>
					</div>
				` : nothing}
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
					disabled: acceptDisabled || streaming || _projectProposalAcceptPending,
					children: html`<span class="inline-flex items-center gap-1.5" data-testid="accept-label">${_projectProposalAcceptPending ? html`<span class="inline-block w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden="true"></span>` : icon(FolderOpen, "sm")} ${acceptLabel}</span>`,
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
// historical-override path. Historical goal revisions must render through the
// override-backed proposal panel; live goal proposals from the assistant flow
// render via `goalPreviewPanel()`.
function proposalPanelForWorkspaceType(type: ProposalType, currentAssistantProposalType: () => ProposalType | null) {
	if (type === "goal" && _proposalOverride?.type === "goal") return proposalPanelForType(type);
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
// Per-goal worktree setup hook. Initialized from proposal frontmatter in
// syncProposalFormState; stored as raw strings for input round-tripping.
let _proposalMetadataRows: Array<[string, string]> = [];
let _proposalInitializedFrom: string | null = null;
// Per-goal subgoal controls. null means "inherit system preference" — only
// forwarded to createGoal when the user actually touched the control.
let _proposalParentGoalId: string = "";
let _proposalSubgoalsAllowed: boolean | null = null;
let _proposalMaxNestingDepth: number | null = null;
// Root-only tree orchestration. null = inherit default (balanced / 3).
let _proposalDivergencePolicy: "strict" | "balanced" | "autonomous" | null = null;
let _proposalMaxConcurrentChildren: number | null = null;

// ----------------------------------------------------------------------------
// Goal proposal tab state (Goal / Workflow / Roles / Metadata / Sub-goals).
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
type ProposalTab = "goal" | "workflow" | "roles" | "metadata" | "subgoals";

interface GoalProposalTabsState {
	activeTab: ProposalTab;
	inlineWorkflow: Workflow | null;
	inlineRoles: Record<string, RoleData>;
	selectedRoleName: string | null;
	customizingWorkflow: boolean;
	customizingRole: boolean;
	roleEditTab: "prompt" | "tools" | "model";
	roleCollapsedGroups: Set<string>;
	tabsInitializedFrom: string | null;
}

function freshGoalProposalTabsState(): GoalProposalTabsState {
	return {
		activeTab: "goal",
		inlineWorkflow: null,
		inlineRoles: {},
		selectedRoleName: null,
		customizingWorkflow: false,
		customizingRole: false,
		roleEditTab: "prompt",
		roleCollapsedGroups: new Set<string>(),
		tabsInitializedFrom: null,
	};
}

const _proposalTabsStateByContext = new Map<string, GoalProposalTabsState>();
let _proposalTabsContextKey = "goal:default";
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

function activeGoalProposalTabsState(): GoalProposalTabsState {
	let st = _proposalTabsStateByContext.get(_proposalTabsContextKey);
	if (!st) {
		st = freshGoalProposalTabsState();
		_proposalTabsStateByContext.set(_proposalTabsContextKey, st);
	}
	return st;
}

function syncGlobalsFromGoalProposalTabsState(st: GoalProposalTabsState): void {
	_proposalActiveTab = st.activeTab;
	_proposalInlineWorkflow = st.inlineWorkflow;
	_proposalInlineRoles = st.inlineRoles;
	_proposalSelectedRoleName = st.selectedRoleName;
	_proposalCustomizingWorkflow = st.customizingWorkflow;
	_proposalCustomizingRole = st.customizingRole;
	_proposalRoleEditTab = st.roleEditTab;
	_proposalRoleCollapsedGroups = st.roleCollapsedGroups;
	_proposalTabsInitializedFrom = st.tabsInitializedFrom;
}

function commitGoalProposalTabsState(): void {
	const st = activeGoalProposalTabsState();
	st.activeTab = _proposalActiveTab;
	st.inlineWorkflow = _proposalInlineWorkflow;
	st.inlineRoles = _proposalInlineRoles;
	st.selectedRoleName = _proposalSelectedRoleName;
	st.customizingWorkflow = _proposalCustomizingWorkflow;
	st.customizingRole = _proposalCustomizingRole;
	st.roleEditTab = _proposalRoleEditTab;
	st.roleCollapsedGroups = _proposalRoleCollapsedGroups;
	st.tabsInitializedFrom = _proposalTabsInitializedFrom;
}

function useGoalProposalTabsContext(key: string): GoalProposalTabsState {
	_proposalTabsContextKey = key;
	const st = activeGoalProposalTabsState();
	syncGlobalsFromGoalProposalTabsState(st);
	return st;
}

function goalProposalTabsContextKey(surface: "preview" | "proposal"): string {
	if (_proposalOverride?.type === "goal") {
		const sessionPart = _proposalOverrideSessionId || "no-session";
		return `goal:historical:${sessionPart}:${_proposalOverride.rev}`;
	}
	const slot = state.activeProposals.goal;
	const sid = slot?.sessionId ?? activeSessionId() ?? "no-session";
	const sess = state.gatewaySessions.find(s => s.id === sid);
	const projectId = state.previewProjectId || sess?.projectId || "no-project";
	const reattempt = sess?.reattemptGoalId || "";
	const rev = slot?.rev ?? "no-rev";
	return `goal:${surface}:${sid}:${projectId}:${reattempt}:${rev}`;
}

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
	const cached = _proposalRolesCacheByProject.get(key);
	if (cached) {
		if (!_proposalSelectedRoleName && cached.length > 0) {
			_proposalSelectedRoleName = cached[0].name;
			commitGoalProposalTabsState();
		}
		return;
	}
	if (_proposalRolesLoadingByProject.has(key)) return;
	_proposalRolesLoadingByProject.add(key);
	fetchRolesForProject(key || undefined)
		.then((list) => {
			_proposalRolesCacheByProject.set(key, list);
			_proposalRolesLoadingByProject.delete(key);
			if (proposalRolesProjectKey() === key && !_proposalSelectedRoleName && list.length > 0) {
				_proposalSelectedRoleName = list[0].name;
				commitGoalProposalTabsState();
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
	fetchGroupPolicies(state.previewProjectId || undefined).then((gp) => {
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

function goalProposalTabsConfig(
	workflowId: string,
	setWorkflowId: (id: string) => void,
): Pick<GoalFormConfig,
	"activeTab" | "onTabChange" |
	"inlineWorkflow" | "customizingWorkflow" | "onInlineWorkflowChange" | "onCustomizeWorkflow" | "onResetWorkflow" |
	"inlineRoles" | "selectedRoleName" | "onSelectRole" | "customizingRole" | "onCustomizeRole" | "onResetRole" |
	"onRoleDraftChange" | "onRoleEditorTabChange" | "onRoleToggleToolGroup" | "roleEditTab" | "roleCollapsedGroups" |
	"roleList" | "roleListLoading" | "availableTools" | "groupPolicies"
> {
	return {
		activeTab: _proposalActiveTab,
		onTabChange: (tab) => { _proposalActiveTab = tab; commitGoalProposalTabsState(); renderApp(); },

		inlineWorkflow: _proposalInlineWorkflow,
		customizingWorkflow: _proposalCustomizingWorkflow,
		onInlineWorkflowChange: (wf) => { _proposalInlineWorkflow = wf; commitGoalProposalTabsState(); renderApp(); },
		onCustomizeWorkflow: () => {
			const src = _cachedWorkflows.find((w) => w.id === workflowId) ?? _cachedWorkflows[0];
			if (!src) return;
			_proposalInlineWorkflow = cloneWorkflow(src);
			_proposalCustomizingWorkflow = true;
			clearWorkflowEditorController();
			commitGoalProposalTabsState();
			renderApp();
		},
		onResetWorkflow: () => {
			_proposalInlineWorkflow = null;
			_proposalCustomizingWorkflow = false;
			if (!_cachedWorkflows.some((w) => w.id === workflowId)) {
				setWorkflowId(_cachedWorkflows[0]?.id ?? "");
			}
			clearWorkflowEditorController();
			commitGoalProposalTabsState();
			renderApp();
		},

		inlineRoles: _proposalInlineRoles,
		selectedRoleName: _proposalSelectedRoleName || proposalRolesList()[0]?.name || null,
		onSelectRole: (name) => {
			_proposalSelectedRoleName = name;
			_proposalCustomizingRole = !!_proposalInlineRoles[name];
			commitGoalProposalTabsState();
			renderApp();
		},
		customizingRole: _proposalCustomizingRole && !!_proposalSelectedRoleName && !!_proposalInlineRoles[_proposalSelectedRoleName],
		onCustomizeRole: () => {
			const name = _proposalSelectedRoleName || proposalRolesList()[0]?.name || null;
			if (!name) return;
			if (!_proposalSelectedRoleName) _proposalSelectedRoleName = name;
			const src = proposalRolesList().find((r) => r.name === name);
			if (!src) return;
			if (!_proposalInlineRoles[name]) _proposalInlineRoles[name] = cloneRole(src);
			_proposalCustomizingRole = true;
			_proposalRoleEditTab = "prompt";
			commitGoalProposalTabsState();
			renderApp();
		},
		onResetRole: () => {
			const name = _proposalSelectedRoleName;
			if (!name) return;
			delete _proposalInlineRoles[name];
			_proposalCustomizingRole = false;
			commitGoalProposalTabsState();
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
			commitGoalProposalTabsState();
			renderApp();
		},
		onRoleEditorTabChange: (tab) => { _proposalRoleEditTab = tab; commitGoalProposalTabsState(); renderApp(); },
		onRoleToggleToolGroup: (group) => {
			if (_proposalRoleCollapsedGroups.has(group)) _proposalRoleCollapsedGroups.delete(group);
			else _proposalRoleCollapsedGroups.add(group);
			commitGoalProposalTabsState();
			renderApp();
		},
		roleEditTab: _proposalRoleEditTab,
		roleCollapsedGroups: _proposalRoleCollapsedGroups,
		roleList: proposalRolesList(),
		roleListLoading: proposalRolesLoading(),
		availableTools: _availableTools,
		groupPolicies: _proposalGroupPoliciesCache ?? {},
	};
}

/** Reset all proposal-tab module state. Called when the proposal is dismissed
 *  or successfully accepted, and when syncing from a new proposal payload. */
function resetProposalTabsState(): void {
	const st = freshGoalProposalTabsState();
	_proposalTabsStateByContext.set(_proposalTabsContextKey, st);
	syncGlobalsFromGoalProposalTabsState(st);
	clearWorkflowEditorController();
}

// When a historical proposal tab is the active panel tab, the dispatcher
// sets this to an override that supplies the form state for that revision.
// The override is read by `syncProposalFormState`, `renderGoalForm`,
// `goalPreviewPanel`, and `projectProposalPanel` instead of
// `state.activeProposals[type]`, so the live current-proposal slot is never
// clobbered when the user views an older snapshot.
let _proposalOverride: { type: ProposalType; fields: Record<string, unknown>; rev: number } | null = null;
let _proposalOverrideSessionId: string | null = null;
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

type GoalProposalFormSnapshot = {
	title: string; spec: string; cwd?: string; workflow?: string; options?: string;
	parentGoalId?: string; inlineWorkflow?: Workflow; inlineRoles?: Record<string, RoleData>;
	subgoalsAllowed?: boolean; maxNestingDepth?: number;
	divergencePolicy?: "strict" | "balanced" | "autonomous"; maxConcurrentChildren?: number;
	metadata?: Record<string, unknown>;
};

function activeGoalProposalFormSnapshot(): GoalProposalFormSnapshot | undefined {
	const raw = _proposalOverride?.type === "goal"
		? _proposalOverride.fields
		: state.activeProposals.goal?.fields;
	return raw as GoalProposalFormSnapshot | undefined;
}

function goalProposalFormIdentityKey(proposal: GoalProposalFormSnapshot, workflowValidationKey: string): string {
	return `${proposal.title}|${proposal.spec}|${proposal.cwd || ""}|${proposal.workflow || ""}|${proposal.options || ""}|${proposal.parentGoalId || ""}|${proposal.subgoalsAllowed ?? ""}|${proposal.maxNestingDepth ?? ""}|${proposal.divergencePolicy ?? ""}|${proposal.maxConcurrentChildren ?? ""}|${proposal.metadata ? JSON.stringify(proposal.metadata) : ""}|${workflowValidationKey}`;
}

function activeGoalProposalFormIdentityKey(): string | null {
	const proposal = activeGoalProposalFormSnapshot();
	if (!proposal) return null;
	return goalProposalFormIdentityKey(proposal, workflowErrorMessageWithAvailable(activeGoalWorkflowValidationError()));
}

/** Sync module-level form state from the active goal proposal when it changes. */
function syncProposalFormState(): void {
	const proposal = activeGoalProposalFormSnapshot();
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
		commitGoalProposalTabsState();
	}

	const inlineWorkflowDraft = selectedInlineWorkflowDraft();
	if (inlineWorkflowDraft) {
		_proposalWorkflowId = inlineWorkflowDraft.id;
		_selectedWorkflowId = inlineWorkflowDraft.id;
	}

	// Use a simple identity check to avoid re-initializing on every render
	const workflowValidationKey = workflowErrorMessageWithAvailable(activeGoalWorkflowValidationError());
	const key = goalProposalFormIdentityKey(proposal, workflowValidationKey);
	if (_proposalInitializedFrom === key) return;
	_proposalInitializedFrom = key;
	_proposalTitle = proposal.title;
	_proposalSpec = proposal.spec;
	_proposalParentGoalId = proposal.parentGoalId || "";
	// Preserve normal project rootPath when proposal doesn't specify cwd; Headquarters defaults server-side.
	const proposalProject = state.previewProjectId ? state.projects.find(p => p.id === state.previewProjectId) : undefined;
	_proposalCwd = proposal.cwd || defaultCwdForProjectSession(proposalProject) || "";
	const selectedInlineWorkflow = selectedInlineWorkflowDraft();
	_proposalWorkflowId = selectedInlineWorkflow?.id || proposal.workflow || "";
	if (selectedInlineWorkflow) _selectedWorkflowId = selectedInlineWorkflow.id;
	// Correct a phantom/empty proposed workflow immediately when the cache is already
	// loaded, so the rendered option and form state agree on the same render.
	normalizeWorkflowSelections();
	_proposalSpecEditMode = false;
	_proposalEnabledOptionalSteps = proposal.options
		? proposal.options.split(",").map(s => s.trim()).filter(Boolean)
		: [];
	_proposalSaving = false;
	// Seed the per-goal nesting + orchestration controls from the proposal so an
	// agent can pre-set everything a human sets on the Sub-goals tab. Absent
	// fields fall back to null = "inherit default" (submission still defaults
	// subgoalsAllowed to off and maxConcurrentChildren to its max).
	_proposalSubgoalsAllowed = typeof proposal.subgoalsAllowed === "boolean" ? proposal.subgoalsAllowed : null;
	_proposalMaxNestingDepth = typeof proposal.maxNestingDepth === "number" ? proposal.maxNestingDepth : null;
	_proposalDivergencePolicy = (proposal.divergencePolicy === "strict" || proposal.divergencePolicy === "balanced" || proposal.divergencePolicy === "autonomous")
		? proposal.divergencePolicy
		: null;
	_proposalMaxConcurrentChildren = typeof proposal.maxConcurrentChildren === "number" ? proposal.maxConcurrentChildren : null;
	// Per-goal metadata: seed the editor rows from frontmatter so a propose_goal-
	// seeded proposal pre-fills the key/value pairs. Absent => empty.
	_proposalMetadataRows = metadataObjectToRows(proposal.metadata);
}

function goalProposalPanel() {
	// Populate previewProjectId for re-attempt / assistant sessions where it
	// wasn't seeded by the +New Goal picker. Resolution order:
	// 1. Proposal/project assistant field.
	// 2. Source session's projectId (server inherits this for re-attempts).
	// 3. Original goal's projectId via reattemptGoalId. Never infer from cwd.
	//
	// Always replace a stale previewProjectId when the current proposal resolves
	// to a concrete project. Historical and project-scoped goal proposals may be
	// opened after another project left state.previewProjectId populated; keeping
	// that stale id would load and submit Workflow/Roles customisations against
	// the wrong project.
	{
		const sid = _proposalOverride?.type === "goal"
			? (_proposalOverrideSessionId || activeSessionId() || state.activeProposals.goal?.sessionId || null)
			: (state.activeProposals.goal?.sessionId || activeSessionId());
		const fields = (_proposalOverride?.type === "goal" ? _proposalOverride.fields : state.activeProposals.goal?.fields) as Record<string, unknown> | undefined;
		const candidate = resolveGoalProposalProjectId(sid, fields);
		if (candidate && state.projects.some(p => p.id === candidate)) {
			if (state.previewProjectId !== candidate) state.previewProjectId = candidate;
		} else if (state.previewProjectId) {
			state.previewProjectId = "";
		}
	}
	useGoalProposalTabsContext(goalProposalTabsContextKey("proposal"));
	syncProposalFormState();
	ensureWorkflowsLoaded(state.previewProjectId || undefined);
	ensureSandboxStatusLoaded();
	ensureProposalRolesLoaded();
	ensureProposalGroupPoliciesLoaded();
	ensureToolsLoaded();
	const subgoalsEnabled = isSubgoalsEnabled();
	const maxNestingDepth = getSystemMaxNestingDepth();
	const inlineWorkflowDraft = selectedInlineWorkflowDraft();
	const workflowValidationError = inlineWorkflowDraft ? undefined : activeGoalWorkflowValidationError();
	const workflowErrorMessage = workflowErrorMessageWithAvailable(workflowValidationError);
	const workflowInvalid = isWorkflowSelectionInvalid(_proposalWorkflowId, inlineWorkflowDraft);

	const handleCreateGoal = async () => {
		const trimmedTitle = _proposalTitle.trim();
		if (!trimmedTitle || _proposalSaving) return;
		if (!state.previewProjectId) {
			showConnectionError("No project selected for this goal", "The assistant session is not linked to a project. Dismiss this proposal and start a new goal from the + New Goal button.");
			return;
		}
		const inlineWorkflowField = _proposalInlineWorkflow ?? undefined;
		const hasInlineWorkflowForSubmission = hasValidInlineWorkflowDraft(inlineWorkflowField);
		if (workflowStateFor(state.previewProjectId) === "empty" && !hasInlineWorkflowForSubmission) {
			showConnectionError(
				"This project has no workflows yet",
				"Run the project assistant from the goal panel banner (or Settings → Components) to scaffold workflows before creating a goal.",
			);
			return;
		}
		if (workflowInvalid || !!workflowValidationError) {
			showConnectionError("Select a valid workflow", workflowErrorMessage || "Choose one of the available workflows before creating this goal.");
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
				// Parent goal is meaningful only while the system Subgoals feature is
				// enabled. A stale/auto-filled parentGoalId from a team-lead proposal
				// must not be submitted while the Sub-goals tab is hidden/off; accepting
				// that proposal should create a top-level goal.
				const parentGoalIdField = subgoalsEnabled ? (_proposalParentGoalId || undefined) : undefined;
				// Per-goal sub-goals default to OFF. The submitted allow + max-depth
				// MUST mirror the displayed stepper exactly (shared resolveDepthControl),
				// so a value clamped up by the selected parent's cap is the value sent —
				// never the raw `_proposalMaxNestingDepth` the user typed before
				// switching parents (the stale-payload bug).
				const subgoalSubmission = proposalSubgoalSubmission({
					subgoalsEnabled,
					parentGoalId: parentGoalIdField,
					systemCap: maxNestingDepth,
					allowedValue: _proposalSubgoalsAllowed,
					configuredValue: _proposalMaxNestingDepth,
				});
				const subgoalsAllowedField = subgoalSubmission.subgoalsAllowed;
				const maxNestingDepthField = subgoalSubmission.maxNestingDepth;
				// Root-only orchestration. Only forwarded for a top-level goal
				// (no parent) that allows subgoals, and only when the user
				// actually picked a value (null = inherit server default).
				const isRootProposal = !parentGoalIdField;
				const allowsChildren = subgoalSubmission.allowsChildren;
				const divergencePolicyField = isRootProposal && allowsChildren && _proposalDivergencePolicy !== null
					? _proposalDivergencePolicy
					: undefined;
				// Only forward an explicit value when the user actually changed the
				// stepper; an untouched control stays unset so the goal resolves to
				// the server default (resolveRootMaxConcurrentChildren). This avoids
				// baking a literal default into stored data and keeps the default a
				// single source of truth on the server.
				const maxConcurrentChildrenField = isRootProposal && allowsChildren && _proposalMaxConcurrentChildren !== null
					? _proposalMaxConcurrentChildren
					: undefined;
				// Customised inline workflow takes precedence over the library
				// workflowId. inlineRoles is only forwarded when non-empty.
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
					parentGoalId: parentGoalIdField,
					subgoalsAllowed: subgoalsAllowedField,
					maxNestingDepth: maxNestingDepthField,
					divergencePolicy: divergencePolicyField,
					maxConcurrentChildren: maxConcurrentChildrenField,
					metadata: metadataRowsToObject(_proposalMetadataRows),
				});
			} catch (err) {
				const { message, code, stack } = errorDetails(err);
				showConnectionError("Failed to create goal", message, { code, stack });
				return;
			}
			if (!goal) return;

			const proposalSessionId = state.activeProposals.goal?.sessionId ?? activeSessionId();

			// --- Success: clear the proposal and navigate. ---
			if (proposalSessionId) clearProposalAnnotations(proposalSessionId, "goal");
			resetProposalAnnCount("goal");
			delete state.activeProposals.goal;
			recomputeAssistantHasProposal();
			_proposalEnabledOptionalSteps = [];
			_proposalInitializedFrom = null;
			_proposalSandboxed = false;
			_proposalAutoStartTeam = true;
			_proposalParentGoalId = "";
			_proposalSubgoalsAllowed = null;
			_proposalMaxNestingDepth = null;
			_proposalDivergencePolicy = null;
			_proposalMaxConcurrentChildren = null;
			_proposalMetadataRows = [];
			resetProposalTabsState();
			await closeCurrentProposalPanel("goal", proposalSessionId);
			if (proposalSessionId) void deleteProposalFile(proposalSessionId, "goal");
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
		const proposalSessionId = state.activeProposals.goal?.sessionId ?? activeSessionId();
		const dismissed = state.activeProposals.goal?.fields as undefined | { title: string; spec: string; cwd?: string; workflow?: string; options?: string };
		// Suppress the in-flight streaming block so later deltas don't re-open
		// the just-dismissed goal proposal (see dismissStreamingProposal).
		if (isProposalStreaming("goal_proposal")) {
			state.remoteAgent?.dismissStreamingProposal("goal_proposal");
		}
		const sidEarly = proposalSessionId;
		if (sidEarly) clearProposalAnnotations(sidEarly, "goal");
		resetProposalAnnCount("goal");
		delete state.activeProposals.goal;
		_proposalInitializedFrom = null;
		_proposalEnabledOptionalSteps = [];
		_proposalAutoStartTeam = true;
		_proposalParentGoalId = "";
		_proposalSubgoalsAllowed = null;
		_proposalMaxNestingDepth = null;
		_proposalDivergencePolicy = null;
		_proposalMaxConcurrentChildren = null;
		_proposalMetadataRows = [];
		resetProposalTabsState();
		// Persist dismiss so it survives reconnect
		const sid = proposalSessionId;
		if (sid && dismissed) {
			markProposalDismissed(sid, dismissed);
			void deleteProposalFile(sid, "goal");
		}
		recomputeAssistantHasProposal();
		void closeCurrentProposalPanel("goal", sid);
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
		<div class="goal-preview-panel flex-1 flex flex-col min-h-0 w-full" data-panel="goal-proposal">
			${renderGoalForm({
		title: _proposalTitle,
		spec: _proposalSpec,
		cwd: _proposalCwd,
		workflowId: _proposalWorkflowId,
		sandboxed: _proposalSandboxed,
		specEditMode: _proposalSpecEditMode,
		enabledOptionalSteps: _proposalEnabledOptionalSteps,
		crossProjectBanner: crossProjectBanner("goal", state.activeProposals.goal?.sessionId ?? activeSessionId()),
		linkedProjectId: state.previewProjectId || undefined,
		workflowState: workflowStateFor(state.previewProjectId || undefined),
		workflowErrorMessage,
		workflowValidationFailed: !!workflowValidationError,
		onOpenProjectAssistant: handleOpenProjectAssistant,
		onTitleChange: (e: Event) => { _proposalTitle = (e.target as HTMLInputElement).value; },
		onSpecChange: (e: Event) => { _proposalSpec = (e.target as HTMLTextAreaElement).value; },
		onCwdChange: (v) => { _proposalCwd = v; renderApp(); },
		onCwdSelect: (v) => { _proposalCwd = v; renderApp(); },
		onWorkflowChange: (e: Event) => {
			_proposalWorkflowId = (e.target as HTMLSelectElement).value;
			if (isKnownWorkflowId(_proposalWorkflowId)) clearActiveGoalWorkflowValidationError();
			// Changing the picker selects a different library workflow; any prior
			// goal-draft inline workflow customisation is for the old selection and
			// must be cleared so submit doesn't ship stale inline content alongside
			// the newly-selected workflowId.
			_proposalInlineWorkflow = null;
			_proposalCustomizingWorkflow = false;
			clearWorkflowEditorController();
			commitGoalProposalTabsState();
			renderApp();
		},
		onSandboxChange: (e: Event) => { _proposalSandboxed = (e.target as HTMLInputElement).checked; renderApp(); },
		onSpecEditToggle: () => { _proposalSpecEditMode = !_proposalSpecEditMode; renderApp(); },
		onOptionalStepsChange: (steps) => { _proposalEnabledOptionalSteps = steps; renderApp(); },
		autoStartTeam: _proposalAutoStartTeam,
		onAutoStartTeamChange: (e: Event) => { _proposalAutoStartTeam = (e.target as HTMLInputElement).checked; renderApp(); },
		metadataRows: _proposalMetadataRows,
		onMetadataRowsChange: (update) => {
			_proposalMetadataRows = typeof update === "function" ? update(_proposalMetadataRows) : update;
			renderApp();
		},
		cwdDropdownOpen: _proposalCwdDropdownOpen,
		cwdHighlightIndex: _proposalCwdHighlightIndex,
		onCwdToggle: (open) => { _proposalCwdDropdownOpen = open; renderApp(); },
		onCwdHighlight: (i) => { _proposalCwdHighlightIndex = i; },
		onCreate: handleCreateGoal,
		onDismiss: handleDismiss,
		saving: _proposalSaving,
		createDisabled: (() => {
			if (!_proposalTitle.trim() || _proposalSaving || workflowInvalid || !!workflowValidationError) return true;
			// Disable Create when a parent is selected but the child would exceed cap.
			if (subgoalsEnabled && _proposalParentGoalId && maxNestingDepth !== undefined) {
				const pDepth = nestingDepthOf(_proposalParentGoalId, state.goals);
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
		divergencePolicyValue: _proposalDivergencePolicy,
		maxConcurrentChildrenValue: _proposalMaxConcurrentChildren,
		onDivergencePolicyChange: (value) => { _proposalDivergencePolicy = value; renderApp(); },
		onMaxConcurrentChildrenChange: (value) => { _proposalMaxConcurrentChildren = value; renderApp(); },

		// ---- Goal proposal tabs wiring ----
		...goalProposalTabsConfig(_proposalWorkflowId, (id) => { _proposalWorkflowId = id; }),
	})}
		</div>
	`;
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
			_proposalOverrideSessionId = typeof tab.source.sessionId === "string" ? tab.source.sessionId : null;
			_proposalOverrideSource = fields;
			_proposalInitializedFrom = null;
		}
		return proposalPanelForWorkspaceType(type, currentAssistantProposalType);
	}
	if (_proposalOverride && _proposalOverride.type === type) {
		// Returning to the current tab: drop the override and force a
		// re-hydration of the form from the live activeProposals slot.
		_proposalOverride = null;
		_proposalOverrideSessionId = null;
		_proposalOverrideSource = null;
		_proposalInitializedFrom = null;
	}
	return proposalPanelForWorkspaceType(type, currentAssistantProposalType);
}

// Mark some imports referenced only for re-export / future use as used to
// satisfy noUnusedLocals when applicable.
export { dismissTypedProposal };
