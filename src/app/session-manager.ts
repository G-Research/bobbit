import { ChatPanel } from "../ui/ChatPanel.js";
import { removePanelWorkspaceTabs, selectPanelWorkspaceTab, selectProposalWorkspaceTab, startPreviewPolling, stopPreviewPolling } from "./preview-panel.js";
import { startInboxSubscription, stopInboxSubscription } from "./inbox-panel.js";
import type { ConnectionStatus, ProposalSource } from "./remote-agent.js";
import { RemoteAgent } from "./remote-agent.js";
import {
	state,
	renderApp,
	activeSessionId,
	isDesktop,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	GW_SESSION_KEY,
	type GatewaySession,
	type Project,
} from "./state.js";
import { gatewayFetch, saveDraftToServer, loadDraftFromServer, deleteDraftFromServer, refreshSessions, startSessionPolling, updateLocalSessionTitle, updateLocalSessionStatus, fetchGitStatus, refreshPrStatusCache, teardownTeam, readProposalSnapshot, type GitStatusData } from "./api.js";
import { reconcilePackRenderersForProject } from "./pack-renderers.js";
import { reconcilePackPanelsForProject, setSessionSwitcher } from "./pack-panels.js";
import { hydrateSidePanelWorkspace } from "./side-panel-workspace.js";
import { reconcilePackEntrypointsForProject } from "./pack-entrypoints.js";
import { runWidgetGitRefresh, abortableSleep, GIT_STATUS_BACKOFF_MS, type GitWidgetLike } from "./git-status-refresh.js";
import { computeConnectGitState, setCachedRepoState, pruneGitRepoCache } from "./git-repo-cache.js";
import { startTimeRefresh } from "./render-helpers.js";
import { getRouteFromHash, setHashRoute, canonicalizePathSessionRoute, saveSessionModel, clearSessionModel, isConfigPageRoute } from "./routing.js";
import { sessionHueRotation, ACCESSORY_IDS } from "./session-colors.js";
import { showConnectionError, confirmAction, showOAuthExpiryModal } from "./dialogs-lazy.js";
import { teardownMobileScrollTracking } from "./mobile-header.js";
import { storage } from "./storage.js";
import { markSessionVisited } from "./render-helpers.js";
import { showHeaderToast } from "./header-toast.js";
import { setSelectedWorkflowId, showProposalToast, resetProposalAnnCount, resetProjectProposalPanel } from "./proposal-panels-lazy.js";
import { clearProposalAnnotations } from "../ui/components/review/proposal-annotations.js";
import { loadReviewSources } from "./review-sources-lazy.js";
import { errorDetails } from "./error-helpers.js";
import { getExpiredAccountOAuthCredentials } from "./account-oauth-providers.js";
import { HEADQUARTERS_PROJECT_ID, defaultCwdForProjectSession, isHeadquartersProject } from "./headquarters.js";
import {
	isProposalDismissed as isProposalDismissedTyped,
	markProposalDismissed as markProposalDismissedTyped,
	hasProposalDismissalRecord,
	clearProposalDismissed as clearProposalDismissedTyped,
	metadataObjectToRows,
} from "./proposal-helpers.js";
import { initAnnotationStore } from "../ui/components/review/AnnotationStore.js";
import { shouldApplyProposalUpdate } from "./proposal-update-policy.js";
import { PROPOSAL_TYPE_REGISTRY, PROPOSAL_TYPES, isProposalType, revealProposalPanel, type GoalWorkflowValidationError, type ProposalType, type ProposalSlot } from "./proposal-registry.js";
import {
	CHAT_PANEL_TAB_ID,
	activePanelTabIdForSession,
	firstContentPanelTab,
	isHistoricalProposalTab,
	panelTabsForSession,
	proposalPanelTabId,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";

async function formatProjectAssistantAutoPromptLazy(input: any): Promise<string> {
	const m = await import("./project-assistant-autoprompt.js");
	return m.formatProjectAssistantAutoPrompt(input);
}

/**
 * Extract the markdown body field from a proposal's fields object.
 * Used by the inline-comments hook to detect when a proposal_update
 * actually rewrote the commentable body (vs. an idempotent re-emit).
 */
function extractProposalBody(
	fields: Record<string, unknown> | undefined,
	type: "goal" | "role" | "staff",
): string {
	if (!fields) return "";
	if (type === "goal") return String((fields as any).spec ?? "");
	return String((fields as any).prompt ?? "");
}

function projectIdForSession(sessionId: string): string | undefined {
	const session = state.gatewaySessions.find(s => s.id === sessionId)
		|| state.archivedSessions.find(s => s.id === sessionId);
	let projectId = session?.projectId;
	const activeId = activeSessionId();
	if (!projectId && (sessionId === activeId || sessionId === state.selectedSessionId || sessionId === state.remoteAgent?.gatewaySessionId)) {
		projectId = state.chatPanel?.agentInterface?.projectId;
	}
	return projectId || undefined;
}

function proposalCwdOrProjectRoot(proposalCwd: unknown, sessionId: string): string {
	const cwd = typeof proposalCwd === "string" ? proposalCwd : "";
	if (cwd.trim()) return cwd;
	const projectId = projectIdForSession(sessionId);
	const project = projectId ? state.projects.find(p => p.id === projectId) : undefined;
	return defaultCwdForProjectSession(project) || "";
}

function projectIdForGoal(goalId?: string): string | undefined {
	if (!goalId) return undefined;
	return state.goals.find(g => g.id === goalId)?.projectId;
}

function defaultProjectIdForNewSession(): string | undefined {
	if (state.activeProjectId && state.projects.some(p => p.id === state.activeProjectId)) return state.activeProjectId;
	const activeId = activeSessionId();
	if (activeId) {
		const fromSession = projectIdForSession(activeId);
		if (fromSession && state.projects.some(p => p.id === fromSession)) return fromSession;
	}
	if (state.projects.length > 0) return state.projects[0].id;
	return HEADQUARTERS_PROJECT_ID;
}

function projectIdForProposalSlot(sessionId: string, fields?: Record<string, unknown>): string | undefined {
	const explicit = fields?.projectId;
	if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
	return projectIdForSession(sessionId);
}

function withSessionProjectId(type: ProposalType, sessionId: string, fields: Record<string, unknown>): Record<string, unknown> {
	if (type === "project") return fields;
	const projectId = projectIdForProposalSlot(sessionId, fields);
	return projectId && fields.projectId !== projectId ? { ...fields, projectId } : fields;
}

function isProposalDismissedForSession(sessionId: string, type: ProposalType, fields: Record<string, unknown>): boolean {
	if (isProposalDismissedTyped(sessionId, type, fields)) return true;
	const scopedFields = withSessionProjectId(type, sessionId, fields);
	if (scopedFields !== fields && isProposalDismissedTyped(sessionId, type, scopedFields)) return true;
	// Some persisted proposal files predate projectId stamping while the UI slot is
	// normalized with the session projectId before rendering. Treat that client-side
	// projectId as dismissal-equivalent so hidden off-screen proposals stay hidden.
	if (type !== "project" && typeof fields.projectId === "string") {
		const unscopedFields = { ...fields };
		delete unscopedFields.projectId;
		if (isProposalDismissedTyped(sessionId, type, unscopedFields)) return true;
	}
	return false;
}

function resetStaffProposalPreview(sessionId: string): void {
	const projectId = projectIdForSession(sessionId);
	const project = projectId ? state.projects.find(p => p.id === projectId) : undefined;
	state.staffPreviewName = "";
	state.staffPreviewDescription = "";
	state.staffPreviewPrompt = "";
	state.staffPreviewTriggers = "[]";
	state.staffPreviewCwd = defaultCwdForProjectSession(project) || "";
	state.staffPreviewWorktree = true;
	state.staffPreviewNameEdited = false;
	state.staffPreviewDescriptionEdited = false;
	state.staffPreviewPromptEdited = false;
	state.staffPreviewTriggersEdited = false;
	state.staffPreviewCwdEdited = false;
	state.assistantHasProposal = false;
}

// ============================================================================
// SESSION CACHE — reuse ChatPanel + RemoteAgent on revisit
// ============================================================================

interface CachedSession {
	chatPanel: ChatPanel;
	remoteAgent: RemoteAgent;
	/** Epoch ms when this entry was cached */
	cachedAt: number;
}

/** LRU cache of recently visited sessions — avoids full reconnect on switch-back. */
const sessionCache = new Map<string, CachedSession>();
const SESSION_CACHE_MAX = 10;

function cacheSession(sessionId: string, chatPanel: ChatPanel, remoteAgent: RemoteAgent): void {
	sessionCache.set(sessionId, { chatPanel, remoteAgent, cachedAt: Date.now() });
	// Evict oldest if over limit
	if (sessionCache.size > SESSION_CACHE_MAX) {
		let oldestKey: string | null = null;
		let oldestTime = Infinity;
		for (const [key, entry] of sessionCache) {
			if (entry.cachedAt < oldestTime) {
				oldestTime = entry.cachedAt;
				oldestKey = key;
			}
		}
		if (oldestKey) {
			const evicted = sessionCache.get(oldestKey);
			evicted?.remoteAgent.disconnect();
			sessionCache.delete(oldestKey);
		}
	}
}

function getCachedSession(sessionId: string): CachedSession | undefined {
	return sessionCache.get(sessionId);
}

/**
 * Release the active panel/agent pair, caching it only when every ownership
 * marker identifies the expected outgoing session. Returns the outgoing panel
 * so callers can finish any visual transition after active ownership is cleared.
 */
function transferActiveSessionToCache(expectedSessionId: string | null, targetSessionId?: string): ChatPanel | null {
	const chatPanel = state.chatPanel;
	const remoteAgent = state.remoteAgent;
	const panelAgent: unknown = chatPanel?.agent;
	const interfaceSession: unknown = chatPanel?.agentInterface?.session;
	const remoteBinding: unknown = remoteAgent;
	const panelOwnsRemote = !!chatPanel && !!remoteAgent
		&& !!panelAgent
		&& !!interfaceSession
		&& panelAgent === remoteBinding
		&& interfaceSession === remoteBinding;
	const canCache = !!expectedSessionId
		&& expectedSessionId !== targetSessionId
		&& !!remoteAgent?.connected
		&& remoteAgent.gatewaySessionId === expectedSessionId
		&& panelOwnsRemote;

	if (canCache) {
		cacheSession(expectedSessionId, chatPanel, remoteAgent);
	} else {
		remoteAgent?.disconnect();
	}

	state.remoteAgent = null;
	state.chatPanel = null;
	state.connectionStatus = "disconnected";
	return chatPanel;
}

function clearSessionCache(): void {
	for (const cached of sessionCache.values()) cached.remoteAgent.disconnect();
	sessionCache.clear();
}

/** Remove a session from cache (e.g. on terminate/archive). */
export function uncacheSession(sessionId: string): void {
	const cached = sessionCache.get(sessionId);
	if (cached) {
		cached.remoteAgent.disconnect();
		sessionCache.delete(sessionId);
	}
}

// ============================================================================
// PER-PROJECT PALETTE SWITCHING
// ============================================================================

/** Apply the per-project palette (if any) or revert to the global default.
 *  Also updates `activeProjectId` so the page title and other project-scoped
 *  UI elements reflect the current project. */
export function applyProjectPalette(projectId?: string): void {
	const project = (state.projects || []).find((p: any) => p.id === projectId);
	if (projectId && project) {
		state.activeProjectId = projectId;
	}
	const palette = project?.palette;
	if (palette) {
		document.documentElement.dataset.palette = palette;
	} else {
		// Revert to global default
		const globalPalette = localStorage.getItem('palette');
		if (!globalPalette || globalPalette === 'forest') {
			delete document.documentElement.dataset.palette;
		} else {
			document.documentElement.dataset.palette = globalPalette;
		}
	}
}

// ============================================================================
// PROPOSAL DISMISS PERSISTENCE — see ./proposal-helpers.ts for the typed,
// per-ProposalType implementation. Below are thin shims preserving the
// goal-only call shape used by render.ts:goalProposalPanel.
// ============================================================================

export type ProjectProposalTarget =
	| { kind: "create" }
	| { kind: "existing"; projectId: string; provisional: boolean }
	| { kind: "unknown"; projectId: string };

export type ProjectProposalMode = "create" | "provisional" | "registered" | "invalid";

type ProjectTargetLookup = Pick<Project, "id" | "provisional">;

/** Resolve project-proposal intent exclusively from `fields.projectId`.
 *
 *  Omitted/blank means create, an explicit registered id means existing, and an
 *  explicit unknown id is invalid. Source-session and proposal provenance are
 *  deliberately absent from this resolver and must never be target fallbacks. */
export function resolveProjectProposalTarget(
	fields?: Record<string, unknown>,
	projects: readonly ProjectTargetLookup[] = state.projects,
): ProjectProposalTarget {
	const explicit = typeof fields?.projectId === "string" ? fields.projectId.trim() : "";
	if (!explicit) return { kind: "create" };
	const project = projects.find(candidate => candidate.id === explicit);
	if (!project) return { kind: "unknown", projectId: explicit };
	return { kind: "existing", projectId: explicit, provisional: project.provisional === true };
}

/** Project proposal render mode projected from the source-independent target.
 *  The legacy two-argument overload is temporary call-site compatibility; its
 *  session id is ignored and cannot affect classification. */
export function resolveProjectMode(
	fields?: Record<string, unknown>,
	projects?: readonly ProjectTargetLookup[],
): ProjectProposalMode;
export function resolveProjectMode(
	_legacySessionId: string,
	fields?: Record<string, unknown>,
): ProjectProposalMode;
export function resolveProjectMode(
	fieldsOrLegacySessionId?: Record<string, unknown> | string,
	projectsOrFields?: readonly ProjectTargetLookup[] | Record<string, unknown>,
): ProjectProposalMode {
	const legacyCall = typeof fieldsOrLegacySessionId === "string";
	const fields = legacyCall
		? (!Array.isArray(projectsOrFields) ? projectsOrFields as Record<string, unknown> | undefined : undefined)
		: fieldsOrLegacySessionId;
	const projects = !legacyCall && Array.isArray(projectsOrFields)
		? projectsOrFields as readonly ProjectTargetLookup[]
		: state.projects;
	const target = resolveProjectProposalTarget(fields, projects);
	if (target.kind === "create") return "create";
	if (target.kind === "unknown") return "invalid";
	return target.provisional ? "provisional" : "registered";
}

function isAssistantProposalType(type: ProposalType): boolean {
	return state.assistantType === type || (type === "project" && state.assistantType === "project-scaffolding");
}

function shouldRevealProposalForSource(source: ProposalSource | undefined): boolean {
	return source === "tool" || source === "legacy" || source === "seed" || source === "restore";
}

function revealActiveProposalPanel(type: ProposalType, sessionId: string): void {
	const isMatchingAssistant = isAssistantProposalType(type);
	revealProposalPanel(type, { sessionId }, {
		isAssistant: isMatchingAssistant,
		isMobile: !isDesktop(),
	});
	if (state.assistantType && !isMatchingAssistant) {
		state.assistantHasProposal = true;
		if (!isDesktop()) state.assistantTab = "preview";
	}
}

function openAssistantProposalWorkspaceTab(type: ProposalType, sessionId: string): void {
	const title = type === "project" ? "Project Proposal"
		: type === "staff" ? "Staff Proposal"
		: `${type.charAt(0).toUpperCase()}${type.slice(1)} Proposal`;
	selectPanelWorkspaceTab({
		id: proposalPanelTabId(type),
		kind: "proposal",
		title,
		label: title.replace(/ Proposal$/, ""),
		legacyTab: type as any,
		source: { type: "proposal", proposalType: type, sessionId },
		state: {},
	}, { sessionId, select: true, setAssistantTab: true });
}

function liveProposalSlotForSession(type: ProposalType, sessionId: string): ProposalSlot | undefined {
	const slot = state.activeProposals[type];
	if (!slot) return undefined;
	if (slot.sessionId && slot.sessionId !== sessionId) return undefined;
	return slot;
}

function sameProposalFields(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
	if (!a || !b) return false;
	try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function workflowValidationErrorFromSlot(slot: ProposalSlot | undefined): GoalWorkflowValidationError | undefined {
	return (slot as any)?.workflowValidationError;
}

function workflowValidationErrorFromDetail(value: unknown): GoalWorkflowValidationError | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.code !== "MISSING_WORKFLOW" && raw.code !== "UNKNOWN_WORKFLOW") return undefined;
	const message = typeof raw.message === "string" && raw.message.trim()
		? raw.message.trim()
		: raw.code === "MISSING_WORKFLOW"
			? "Workflow is required for this project."
			: "Unknown workflow for this project.";
	const workflowId = typeof raw.workflowId === "string" ? raw.workflowId : undefined;
	const availableWorkflows = Array.isArray(raw.availableWorkflows)
		? raw.availableWorkflows
			.map((workflow) => {
				if (typeof workflow === "string" && workflow.trim()) return { id: workflow.trim() };
				if (!workflow || typeof workflow !== "object") return null;
				const id = typeof (workflow as any).id === "string" ? (workflow as any).id.trim() : "";
				if (!id) return null;
				const name = typeof (workflow as any).name === "string" && (workflow as any).name.trim()
					? (workflow as any).name.trim()
					: undefined;
				return name ? { id, name } : { id };
			})
			.filter((workflow): workflow is { id: string; name?: string } => !!workflow)
		: undefined;
	return {
		code: raw.code,
		message,
		...(workflowId !== undefined ? { workflowId } : {}),
		...(availableWorkflows && availableWorkflows.length > 0 ? { availableWorkflows } : {}),
	};
}

function hasObjectFields(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0;
}

function isSelectableFallbackContentTab(tab: PanelWorkspaceTab, failedTabId: string, sessionId: string): boolean {
	if (!tab || tab.id === failedTabId || tab.kind === "chat") return false;
	const sourceSessionId = typeof (tab.source as any)?.sessionId === "string" ? (tab.source as any).sessionId : "";
	if (sourceSessionId && sourceSessionId !== sessionId) return false;
	if (tab.kind === "proposal" && tab.source.type === "proposal") {
		if (isHistoricalProposalTab(tab)) return hasObjectFields(tab.state?.fields);
		return !!liveProposalSlotForSession(tab.source.proposalType, sessionId) || isAssistantProposalType(tab.source.proposalType);
	}
	return true;
}

function selectChatPanelTab(sessionId: string): void {
	selectPanelWorkspaceTab({
		id: CHAT_PANEL_TAB_ID,
		kind: "chat",
		title: "Chat",
		label: "Chat",
		legacyTab: "chat",
		source: { type: "chat", sessionId },
	}, { sessionId, select: true, setAssistantTab: true, clearCollapse: false });
}

function selectProposalSnapshotFallback(type: ProposalType, sessionId: string, failedTabId: string): void {
	const tabs = panelTabsForSession(state, sessionId);
	if (liveProposalSlotForSession(type, sessionId)) {
		selectProposalWorkspaceTab(type, { sessionId, select: true, setAssistantTab: true });
		return;
	}
	const fallback = firstContentPanelTab(tabs.filter((tab) => isSelectableFallbackContentTab(tab, failedTabId, sessionId)));
	if (fallback) {
		selectPanelWorkspaceTab(fallback, { sessionId, select: true, setAssistantTab: true });
		return;
	}
	selectChatPanelTab(sessionId);
}

function handleProposalSnapshotUnavailable(type: ProposalType, sessionId: string, rev: number, reason: unknown): void {
	const failedTabId = proposalPanelTabId(type, rev);
	const wasActive = activePanelTabIdForSession(state, sessionId) === failedTabId;
	console.warn("[proposal] snapshot read failed:", { type, rev, reason });
	removePanelWorkspaceTabs([failedTabId], { sessionId, select: false, clearCollapse: false });
	if (wasActive) selectProposalSnapshotFallback(type, sessionId, failedTabId);
	if (activeSessionId() === sessionId) showHeaderToast(`Proposal revision ${rev} is no longer available`);
	renderApp();
}

/**
 * Slice E gap-closure: dismissal helpers are now thin shims forwarding to the
 * typed (per-ProposalType) implementations in `./proposal-helpers.ts`.
 * Optional `type` defaults to `"goal"` for back-compat with existing callers
 * (render.ts goalProposalPanel:handleDismiss). New callers should pass an
 * explicit type to opt into per-type dismissal stickiness.
 */
export function isProposalDismissed(
	sessionId: string,
	proposalOrType: ProposalType | Record<string, unknown>,
	maybeFields?: Record<string, unknown>,
): boolean {
	if (typeof proposalOrType === "string" && isProposalType(proposalOrType)) {
		return isProposalDismissedTyped(sessionId, proposalOrType, maybeFields ?? {});
	}
	return isProposalDismissedTyped(sessionId, "goal", proposalOrType as Record<string, unknown>);
}

export function markProposalDismissed(
	sessionId: string,
	proposalOrType: ProposalType | Record<string, unknown>,
	maybeFields?: Record<string, unknown>,
): void {
	if (typeof proposalOrType === "string" && isProposalType(proposalOrType)) {
		markProposalDismissedTyped(sessionId, proposalOrType, maybeFields ?? {});
		return;
	}
	markProposalDismissedTyped(sessionId, "goal", proposalOrType as Record<string, unknown>);
}

export function clearProposalDismissed(sessionId: string, type?: ProposalType): void {
	if (type) {
		clearProposalDismissedTyped(sessionId, type);
		return;
	}
	clearProposalDismissedTyped(sessionId, "goal");
}

/** Clear dismissal fingerprints for ALL proposal types — used on session terminate. */
function clearDismissedProposal(sessionId: string): void {
	for (const t of PROPOSAL_TYPES) clearProposalDismissedTyped(sessionId, t);
}

// ============================================================================
// DRAFT MANAGER — generic draft persistence (replaces copy-pasted patterns)
// ============================================================================

interface DraftManager {
	save(sessionId: string): void;
	restore(sessionId: string): Promise<boolean>;
	delete(sessionId: string): void;
	teardown(): void;
}

/**
 * Generic draft persistence helper. Provides debounced save, restore, and delete
 * for any assistant draft type. Eliminates duplication across goal/role.
 */
function createDraftManager<T>(config: {
	type: string;
	serialize: (sessionId: string) => T;
	restore: (sessionId: string, draft: T) => void;
	debounceMs?: number;
}): DraftManager {
	let timer: ReturnType<typeof setTimeout> | null = null;
	const debounceMs = config.debounceMs ?? 300;

	return {
		save(sessionId: string): void {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				const draft = config.serialize(sessionId);
				saveDraftToServer(sessionId, config.type, draft);
			}, debounceMs);
		},

		async restore(sessionId: string): Promise<boolean> {
			try {
				const draft = await loadDraftFromServer(sessionId, config.type);
				if (!draft) return false;
				config.restore(sessionId, draft as T);
				// Pin the contract: after a successful restore, schedule a render
				// so the fast-path connectToSession (which fire-and-forgets this
				// promise) repaints the proposal panel with the rehydrated state.
				// The slow path already renders implicitly in connectToSession's
				// terminal finally{}; this keeps both paths symmetric. Pinned by
				// tests/proposal-rehydrate-client.test.ts.
				renderApp();
				return true;
			} catch (err) {
				console.error(`[${config.type}-draft] Failed to restore draft:`, err);
				return false;
			}
		},

		delete(sessionId: string): void {
			if (timer) { clearTimeout(timer); timer = null; }
			deleteDraftFromServer(sessionId, config.type);
		},

		teardown(): void {
			if (timer) { clearTimeout(timer); timer = null; }
		},
	};
}

// ============================================================================
// GOAL DRAFT
// ============================================================================

const goalDraft = createDraftManager({
	type: 'goal',
	serialize: (sessionId) => ({
		sessionId,
		activeGoalProposal: state.activeProposals.goal ?? undefined,
		previewTitle: state.previewTitle,
		previewSpec: state.previewSpec,
		previewCwd: state.previewCwd,
		previewProjectId: state.previewProjectId,
		previewTitleEdited: state.previewTitleEdited,
		previewSpecEdited: state.previewSpecEdited,
		previewCwdEdited: state.previewCwdEdited,
		previewMetadataEdited: state.previewMetadataEdited,
		hasReceivedProposal: state.assistantHasProposal,
		goalAssistantTab: state.assistantTab,
		previewMetadataRows: state.previewMetadataRows,
	}),
	restore: (_sessionId, draft: any) => {
		let dismissed = false;
		if (draft.activeGoalProposal) {
			const stored = draft.activeGoalProposal as any;
			const hasStoredSlot = stored.fields && typeof stored.fields === "object" && !Array.isArray(stored.fields);
			const storedFields = (hasStoredSlot ? stored.fields : stored) as Record<string, unknown>;
			const storedRev = hasStoredSlot
				? (typeof stored.rev === "number" && Number.isFinite(stored.rev) && stored.rev > 0 ? Math.trunc(stored.rev) : 0)
				: 1;
			const existing = state.activeProposals.goal?.sessionId === _sessionId ? state.activeProposals.goal : undefined;
			const existingRev = typeof existing?.rev === "number" && Number.isFinite(existing.rev) && existing.rev > 0 ? Math.trunc(existing.rev) : 0;
			const fields = existing && existingRev >= storedRev ? existing.fields : storedFields;
			const rev = existing && existingRev >= storedRev ? existingRev : storedRev;
			if (isProposalDismissedForSession(_sessionId, "goal", fields)) {
				// User previously dismissed this proposal — keep the draft on disk
				// (so future edit_proposal events can rehydrate it) but don't
				// re-open the panel or re-populate the proposal-mirror preview
				// fields on reload.
				delete state.activeProposals.goal;
				dismissed = true;
			} else {
				state.activeProposals.goal = {
					sessionId: _sessionId,
					fields,
					streaming: existing?.streaming ?? false,
					rev,
				};
			}
		} else if (hasProposalDismissalRecord(_sessionId, "goal")) {
			// Broad-suite race: a late debounced save after dismissal can overwrite the
			// server draft with no activeGoalProposal but stale previewTitle/previewSpec.
			// The dismissal fingerprint is still authoritative for this session, so keep
			// the slot empty and clear the form mirror instead of restoring stale fields.
			delete state.activeProposals.goal;
			dismissed = true;
		} else if (state.activeProposals.goal?.sessionId !== _sessionId) {
			// Finding 2 — an OFF-SCREEN proposal's client draft was never saved
			// (the unified/legacy callbacks early-return while the panel is inactive),
			// so the on-disk draft lacks activeGoalProposal. The live slot, however,
			// may have just been (re)populated for THIS session by rehydrate. Only drop
			// a slot left over from a DIFFERENT session; never delete a freshly
			// rehydrated current-session slot here (a no-op when the slot is absent).
			delete state.activeProposals.goal;
		}
		if (dismissed) {
			state.previewTitle = "";
			state.previewSpec = "";
			state.previewCwd = draft.previewCwd ?? "";
			state.previewProjectId = draft.previewProjectId ?? "";
			state.previewTitleEdited = false;
			state.previewSpecEdited = false;
			state.previewCwdEdited = draft.previewCwdEdited ?? false;
			state.previewMetadataEdited = false;
			state.assistantHasProposal = false;
			state.previewMetadataRows = sanitizeMetadataRows(draft.previewMetadataRows);
		} else {
			state.previewTitle = draft.previewTitle ?? "";
			state.previewSpec = draft.previewSpec ?? "";
			state.previewCwd = draft.previewCwd ?? "";
			state.previewProjectId = draft.previewProjectId ?? "";
			state.previewTitleEdited = draft.previewTitleEdited ?? false;
			state.previewSpecEdited = draft.previewSpecEdited ?? false;
			state.previewCwdEdited = draft.previewCwdEdited ?? false;
			state.previewMetadataEdited = draft.previewMetadataEdited ?? false;
			state.assistantHasProposal = draft.hasReceivedProposal ?? false;
			state.previewMetadataRows = sanitizeMetadataRows(draft.previewMetadataRows);
		}
		state.assistantTab = draft.goalAssistantTab ?? "chat";
	},
});

/** Save the current goal assistant preview state to the server (debounced 300ms). */
export function saveGoalDraft(sessionId: string): void { goalDraft.save(sessionId); }
/** Restore goal assistant preview state from the server. */
async function restoreGoalDraft(sessionId: string): Promise<boolean> { return goalDraft.restore(sessionId); }
/** Delete goal draft from the server. */
export function deleteGoalDraft(sessionId: string): void { goalDraft.delete(sessionId); }

/**
 * Mirror a rehydrated goal proposal slot into the legacy form-mirror state the
 * goal-assistant panel (goalPreviewPanel) renders from. Shared by the slow/boot
 * draft-restore path and the fast-path switch-back so both surface an off-screen
 * or rehydrated proposal identically — the fast path previously lacked this
 * reconciliation, so restoreGoalDraft could blank previewTitle/previewSpec from a
 * stale/empty client draft and reintroduce Failure Mode B. Respects the *Edited
 * flags so a genuine in-progress user edit always wins. Persists the draft so the
 * next fast-path restore is correct. Returns true if a slot for this session was
 * reconciled.
 */
/** Coerce a persisted/draft `previewMetadataRows` value back into well-formed
 *  `[string, string]` rows, dropping anything malformed. */
function sanitizeMetadataRows(raw: unknown): Array<[string, string]> {
	if (!Array.isArray(raw)) return [];
	const rows: Array<[string, string]> = [];
	for (const row of raw) {
		if (Array.isArray(row) && row.length === 2 && typeof row[0] === "string" && typeof row[1] === "string") {
			rows.push([row[0], row[1]]);
		}
	}
	return rows;
}

/**
 * Mirror the optional per-goal `metadata` object from a proposal/slot into the
 * form-mirror metadata rows the goal-assistant panel renders from. Shared by all
 * goal-proposal mirror paths so a propose_goal-seeded assistant proposal carries
 * its `metadata` through acceptance, not just title/spec/cwd/workflow.
 *
 * A present metadata object (including an authoritative empty `{}`) is mirrored
 * exactly, so an empty object clears any stale rows. When `metadata` is absent
 * (the field is not carried by this source), the rows are cleared only for an
 * AUTHORITATIVE source (the merged/slot proposal fields, which represent the
 * full current proposal) — that way a previous proposal's metadata can never be
 * submitted by accident. Non-authoritative raw streaming tool-use partials, which
 * may simply not have streamed the `metadata` field yet, leave the rows untouched.
 *
 * Once the user has manually edited the rows (`previewMetadataEdited`), the mirror
 * is a no-op regardless of source — their entries win, exactly like the
 * title/spec/cwd `*Edited` guards — so an authoritative reconcile with no metadata
 * can never wipe in-progress user input.
 */
function mirrorGoalSetupFields(src: { metadata?: unknown }, opts?: { authoritative?: boolean }): void {
	if (state.previewMetadataEdited) return;
	const m = src.metadata;
	if (m !== null && typeof m === "object" && !Array.isArray(m)) {
		// Present (incl. empty {}) — mirror exactly. metadataObjectToRows({}) ⇒ [].
		state.previewMetadataRows = metadataObjectToRows(m);
		return;
	}
	// Absent / non-object: clear stale rows only for an authoritative source.
	if (opts?.authoritative) state.previewMetadataRows = [];
}

function clearGoalFormMirrorForDismissal(): void {
	state.previewTitle = "";
	state.previewSpec = "";
	state.previewCwd = "";
	state.previewTitleEdited = false;
	state.previewSpecEdited = false;
	state.previewCwdEdited = false;
	state.previewMetadataEdited = false;
	state.previewMetadataRows = [];
}

function reconcileGoalSlotIntoFormMirror(sessionId: string): boolean {
	const goalSlot = state.activeProposals.goal;
	if (!goalSlot || goalSlot.sessionId !== sessionId) return false;
	if (isProposalDismissedForSession(sessionId, "goal", goalSlot.fields as Record<string, unknown>)) {
		delete state.activeProposals.goal;
		clearGoalFormMirrorForDismissal();
		state.assistantHasProposal = PROPOSAL_TYPES.some((t) => state.activeProposals[t]?.sessionId === sessionId);
		return false;
	}
	const g = goalSlot.fields as { title?: string; spec?: string; cwd?: string; workflow?: string; projectId?: string; metadata?: unknown };
	if (typeof g.projectId === "string" && g.projectId.trim()) state.previewProjectId = g.projectId.trim();
	if (!state.previewTitleEdited && typeof g.title === "string") state.previewTitle = g.title;
	if (!state.previewSpecEdited && typeof g.spec === "string") state.previewSpec = g.spec;
	if (!state.previewCwdEdited && g.cwd) state.previewCwd = g.cwd;
	if (g.workflow) setSelectedWorkflowId(g.workflow);
	// Slot fields are the authoritative current proposal — clear stale rows when
	// they carry no metadata.
	mirrorGoalSetupFields(g, { authoritative: true });
	state.assistantHasProposal = true;
	if (state.assistantTab === "chat" && !isDesktop()) state.assistantTab = "preview";
	saveGoalDraft(sessionId);
	return true;
}

// ============================================================================
// ROLE DRAFT
// ============================================================================

const roleDraft = createDraftManager({
	type: 'role',
	serialize: (sessionId) => ({
		sessionId,
		activeRoleProposal: state.activeProposals.role ?? undefined,
		previewName: state.rolePreviewName,
		previewLabel: state.rolePreviewLabel,
		previewPrompt: state.rolePreviewPrompt,
		previewTools: state.rolePreviewTools,
		previewAccessory: state.rolePreviewAccessory,
		previewNameEdited: state.rolePreviewNameEdited,
		previewLabelEdited: state.rolePreviewLabelEdited,
		previewPromptEdited: state.rolePreviewPromptEdited,
		previewToolsEdited: state.rolePreviewToolsEdited,
		previewAccessoryEdited: state.rolePreviewAccessoryEdited,
		hasReceivedRoleProposal: state.assistantHasProposal,
		roleAssistantTab: state.assistantTab,
	}),
	restore: (_sessionId, draft: any) => {
		let dismissed = false;
		if (draft.activeRoleProposal) {
			const stored = draft.activeRoleProposal as any;
			const hasStoredSlot = stored.fields && typeof stored.fields === "object" && !Array.isArray(stored.fields);
			const storedFields = (hasStoredSlot ? stored.fields : stored) as Record<string, unknown>;
			const storedRev = hasStoredSlot
				? (typeof stored.rev === "number" && Number.isFinite(stored.rev) && stored.rev > 0 ? Math.trunc(stored.rev) : 0)
				: 1;
			const existing = state.activeProposals.role?.sessionId === _sessionId ? state.activeProposals.role : undefined;
			const existingRev = typeof existing?.rev === "number" && Number.isFinite(existing.rev) && existing.rev > 0 ? Math.trunc(existing.rev) : 0;
			const fields = existing && existingRev >= storedRev ? existing.fields : storedFields;
			const rev = existing && existingRev >= storedRev ? existingRev : storedRev;
			if (isProposalDismissedTyped(_sessionId, "role", fields)) {
				delete state.activeProposals.role;
				dismissed = true;
			} else {
				state.activeProposals.role = {
					sessionId: _sessionId,
					fields,
					streaming: existing?.streaming ?? false,
					rev,
				};
			}
		} else {
			delete state.activeProposals.role;
		}
		if (dismissed) {
			state.rolePreviewName = "";
			state.rolePreviewLabel = "";
			state.rolePreviewPrompt = "";
			state.rolePreviewTools = "";
			state.rolePreviewAccessory = "none";
			state.rolePreviewNameEdited = false;
			state.rolePreviewLabelEdited = false;
			state.rolePreviewPromptEdited = false;
			state.rolePreviewToolsEdited = false;
			state.rolePreviewAccessoryEdited = false;
			state.assistantHasProposal = false;
		} else {
			state.rolePreviewName = draft.previewName ?? "";
			state.rolePreviewLabel = draft.previewLabel ?? "";
			state.rolePreviewPrompt = draft.previewPrompt ?? "";
			state.rolePreviewTools = draft.previewTools ?? "";
			state.rolePreviewAccessory = draft.previewAccessory ?? "none";
			state.rolePreviewNameEdited = draft.previewNameEdited ?? false;
			state.rolePreviewLabelEdited = draft.previewLabelEdited ?? false;
			state.rolePreviewPromptEdited = draft.previewPromptEdited ?? false;
			state.rolePreviewToolsEdited = draft.previewToolsEdited ?? false;
			state.rolePreviewAccessoryEdited = draft.previewAccessoryEdited ?? false;
			state.assistantHasProposal = draft.hasReceivedRoleProposal ?? false;
		}
		state.assistantTab = draft.roleAssistantTab ?? "chat";
	},
});

/** Save the current role assistant preview state to the server (debounced 300ms). */
export function saveRoleDraft(sessionId: string): void { roleDraft.save(sessionId); }
/** Restore role assistant preview state from the server. */
async function restoreRoleDraft(sessionId: string): Promise<boolean> { return roleDraft.restore(sessionId); }
/** Delete role draft from the server. */
export function deleteRoleDraft(sessionId: string): void { roleDraft.delete(sessionId); }

// ============================================================================
// PROJECT DRAFT
// ============================================================================

const projectDraft = createDraftManager({
	type: 'project',
	serialize: (sessionId) => {
		const proposal = state.activeProposals.project;
		return {
			sessionId,
			activeProjectProposal: proposal ? {
				sessionId: proposal.sessionId,
				fields: proposal.fields,
				streaming: proposal.streaming,
				mode: proposal.mode,
				...(proposal.sourceProjectId ? { sourceProjectId: proposal.sourceProjectId } : {}),
				...(proposal.createdProjectId ? { createdProjectId: proposal.createdProjectId } : {}),
				rev: proposal.rev,
			} : undefined,
			hasReceivedProposal: state.assistantHasProposal,
			assistantTab: state.assistantTab,
			accepted: state.projectProposalAcceptedBySessionId[sessionId] ?? false,
		};
	},
	restore: (_sessionId, draft: any) => {
		let dismissed = false;
		if (draft.activeProjectProposal) {
			const p = draft.activeProjectProposal as any;
			const fields = (p.fields ?? {}) as Record<string, unknown>;
			if (isProposalDismissedTyped(_sessionId, "project", fields)) {
				delete state.activeProposals.project;
				dismissed = true;
			} else {
				// `projectId` was the legacy name for source provenance. It is read
				// only during restoration and is never serialized again.
				const legacyCompatibleSourceProjectId = p.sourceProjectId ?? p.projectId;
				state.activeProposals.project = {
					sessionId: typeof p.sessionId === "string" && p.sessionId ? p.sessionId : _sessionId,
					fields,
					mode: resolveProjectMode(fields),
					...(typeof legacyCompatibleSourceProjectId === "string" && legacyCompatibleSourceProjectId.trim()
						? { sourceProjectId: legacyCompatibleSourceProjectId.trim() }
						: {}),
					...(typeof p.createdProjectId === "string" && p.createdProjectId.trim()
						? { createdProjectId: p.createdProjectId.trim() }
						: {}),
					streaming: typeof p.streaming === "boolean" ? p.streaming : false,
					rev: typeof p.rev === "number" ? p.rev : 1,
				};
			}
		} else {
			delete state.activeProposals.project;
		}
		state.assistantHasProposal = dismissed ? false : (draft.hasReceivedProposal ?? false);
		state.assistantTab = draft.assistantTab ?? "chat";
		if (draft.accepted === true) {
			state.projectProposalAcceptedBySessionId[_sessionId] = true;
		} else {
			delete state.projectProposalAcceptedBySessionId[_sessionId];
		}
	},
});

export function saveProjectDraft(sessionId: string): void { projectDraft.save(sessionId); }
async function restoreProjectDraft(sessionId: string): Promise<boolean> { return projectDraft.restore(sessionId); }
export function deleteProjectDraft(sessionId: string): void { projectDraft.delete(sessionId); }

// ============================================================================
// AUTHENTICATE GATEWAY
// ============================================================================

export async function authenticateGateway(url: string, token: string): Promise<void> {
	localStorage.setItem(GW_URL_KEY, url);
	localStorage.setItem(GW_TOKEN_KEY, token);

	const healthRes = await fetch(`${url}/api/health`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!healthRes.ok) {
		if (healthRes.status === 401) throw new Error("Invalid auth token");
		throw new Error(`Gateway error: ${healthRes.status}`);
	}

	// Skip OAuth when running on localhost or when an AI Gateway is configured.
	// Localhost: only local processes can connect, no cloud auth needed.
	// AI Gateway: the gateway handles LLM auth; Anthropic OAuth endpoints
	// are likely unreachable on air-gapped networks anyway.
	const healthData = await healthRes.json();
	// Extract setup status from health response (avoids extra fetch)
	if (typeof healthData.setupComplete === "boolean") {
		state.setupComplete = healthData.setupComplete;
	}
	if (typeof healthData.orphanedTranscripts === "number") {
		state.orphanedTranscriptsCount = healthData.orphanedTranscripts;
	}
	const shouldCheckOAuthExpiry = !healthData.localhost && !healthData.aigw;

	state.appView = "authenticated";
	const route = getRouteFromHash();
	if (route.view !== "session" && route.view !== "goal-dashboard" && !isConfigPageRoute()) {
		setHashRoute("landing");
	}
	renderApp();
	if (shouldCheckOAuthExpiry) {
		void (async () => {
			try {
				const expiredCredentials = await getExpiredAccountOAuthCredentials();
				if (expiredCredentials.length > 0) void showOAuthExpiryModal(expiredCredentials);
			} catch {
				// OAuth status failures are indeterminate; never block gateway auth.
			}
		})();
	}
	await refreshSessions();
	try {
		const cwdRes = await gatewayFetch("/api/config/cwd");
		if (cwdRes.ok) {
			const cwdData = await cwdRes.json();
			state.defaultCwd = cwdData.cwd || "";
		}
	} catch {}
	startSessionPolling();
	startTimeRefresh();
}

// ============================================================================
// PROMPT DRAFT PERSISTENCE
// ============================================================================
// Module-level state prevents listener stacking across session switches.
// Bind the active session before the editor can become interactive; restore is
// deliberately separate so late server reads never overwrite fresh local input.

let _draftSessionId: string | null = null;
let _draftTimer: ReturnType<typeof setTimeout> | null = null;
let _draftAbort: AbortController | null = null;
let _draftListenersInstalled = false;
let _draftTouchedSinceBind = false;
/** Tracks the in-flight save promise so session switches can await it. */
let _pendingSave: Promise<void> | null = null;

/** Monotonic counter — incremented on every send. Saved alongside the draft
 *  so stale saves (from aborted-but-already-sent requests) can be detected
 *  and ignored on load. */
let _draftGen = 0;
/** The generation at which the last send occurred. Any draft with gen < this is stale. */
let _draftSendGen = 0;

/** Per-session persisted mirror of the highest generation ever written for a
 *  session's prompt draft. Survives session round-trips AND reload within the
 *  tab, so `_bindPromptDraftSession` can reseed `_draftGen` SYNCHRONOUSLY on
 *  bind. Without this the client resets `_draftGen` to 0 on every bind while the
 *  server's stored gen keeps climbing, so post-round-trip saves carry a lower
 *  gen and are silently discarded by the server staleness guard (Bug 2). */
function _loadStoredDraftGen(sid: string): number {
	return parseInt(sessionStorage.getItem(`bobbit_draft_gen_${sid}`) || "0", 10) || 0;
}
/** Increment `_draftGen` and persist it to the per-session mirror. All draft
 *  writes (flush, send tombstone, beforeunload beacon) MUST allocate their gen
 *  through here so the mirror always tracks the highest gen written. */
function _nextDraftGen(sid: string): number {
	const gen = ++_draftGen;
	try { sessionStorage.setItem(`bobbit_draft_gen_${sid}`, String(gen)); } catch { /* ignore */ }
	return gen;
}

function _trackPendingDraftSave(promise: Promise<void>): Promise<void> {
	const tracked = promise.finally(() => {
		if (_pendingSave === tracked) _pendingSave = null;
	});
	_pendingSave = tracked;
	return tracked;
}

/** Immediately persist the given draft value (or delete if empty).
 *  Returns the save promise so callers can await it. */
function _flushDraft(rawVal?: string): Promise<void> | void {
	if (!_draftSessionId) return;
	if (_draftAbort) _draftAbort.abort();
	// If no value provided, read from the editor
	const val: string = rawVal !== undefined ? rawVal
		: (document.querySelector("message-editor") as any)?.value ?? "";
	const sid = _draftSessionId;
	// Clears are persisted as gen-stamped empty tombstones ({ text: "", gen })
	// rather than an unversioned DELETE. The server's setDraft staleness guard
	// only protects writes that carry a `gen`; a bare DELETE bypasses it, so an
	// older in-flight clear could land AFTER a newer typed PUT and wipe it (PR
	// #830 follow-up). Routing the clear through the same gen-stamped save path
	// means a stale clear carries a lower gen and is silently discarded by the
	// guard, while the newer draft survives. The empty tombstone is treated as
	// "no draft" on restore (_restorePromptDraft maps `text: ""` → null), and
	// the send-on-tombstone anti-resurrection behaviour is unchanged (it already
	// writes the same { text: "", gen } shape).
	const controller = new AbortController();
	_draftAbort = controller;
	const gen = _nextDraftGen(sid);
	const data = val.trim() ? { text: val, gen } : { text: "", gen };
	return _trackPendingDraftSave(
		saveDraftToServer(sid, 'prompt', data, controller.signal)
			.finally(() => {
				if (_draftAbort === controller) _draftAbort = null;
			}),
	);
}

/** Flush any pending draft save immediately (e.g. before HMR reload). */
export function flushPendingDraft(): void {
	if (_draftTimer) {
		clearTimeout(_draftTimer);
		_draftTimer = null;
	}
	_flushDraft();
}

/** Flush any pending draft save and tear down handlers.
 *  Call when navigating away from a session to a non-session view
 *  (settings, roles, tools, etc.) so the draft is persisted before
 *  the editor is removed from the DOM. */
export function flushAndTeardownDraft(): void {
	flushPendingDraft();
	_teardownDraftHandlers();
}

function _teardownDraftHandlers(): void {
	if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
	// Don't abort in-flight flush saves — let them complete.
	// _flushDraft() already cancels any previous in-flight save at the top
	// via `if (_draftAbort) _draftAbort.abort()` before starting a new one.
	_draftAbort = null;
	// Note: we don't remove the sessionStorage draft entry here because
	// MessageEditor.connectedCallback needs it to survive element recreation.
	// It's cleaned up on send (message-send event) and overwritten on next save.
	_draftSessionId = null;
	_draftTouchedSinceBind = false;
	_draftGen = 0;
	_draftSendGen = 0;
}

function _ensurePromptDraftListeners(): void {
	// Use document-level event listeners instead of monkey-patching.
	// Lit re-renders overwrite property-based callbacks (.onSend, .onInput)
	// on every state change, silently removing our patches. Native DOM
	// events (composed: true) bubble through shadow DOM and survive re-renders.
	if (_draftListenersInstalled) return;

	// Debounced draft save on textarea input (native 'input' event is composed)
	document.addEventListener("input", (e: Event) => {
		const target = e.target as HTMLElement;
		if (!target || target.tagName !== "TEXTAREA") return;
		// Verify it's inside a message-editor
		if (!target.closest("message-editor")) return;
		const sid = _draftSessionId;
		if (!sid) return;

		_draftTouchedSinceBind = true;
		const val = (target as HTMLTextAreaElement).value;
		// Keep sessionStorage in sync immediately (synchronous, no debounce).
		// This ensures MessageEditor.connectedCallback picks up the latest
		// text if the element is recreated during a Lit re-render.
		if (val.trim()) {
			sessionStorage.setItem(`bobbit_draft_${sid}`, val);
		} else {
			sessionStorage.removeItem(`bobbit_draft_${sid}`);
		}
		if (_draftTimer) clearTimeout(_draftTimer);
		_draftTimer = setTimeout(() => {
			_draftTimer = null;
			if (_draftSessionId !== sid) return;
			_flushDraft(val);
		}, 100);
	});

	// Clear draft on send (custom composed event from MessageEditor)
	document.addEventListener("message-send", () => {
		if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
		if (_draftAbort) { _draftAbort.abort(); _draftAbort = null; }
		const sid = _draftSessionId;
		if (sid) {
			_draftTouchedSinceBind = true;
			// Increment gen and record the send generation. Then overwrite the
			// draft with a tombstone at the new gen. Even if a stale save (from
			// an aborted-but-already-sent request) arrives at the server after
			// this, the load will see gen <= _draftSendGen and ignore it.
			const gen = _nextDraftGen(sid);
			_draftSendGen = gen;
			sessionStorage.setItem(`draft-send-gen-${sid}`, String(gen));
			sessionStorage.removeItem(`bobbit_draft_${sid}`);
			_trackPendingDraftSave(saveDraftToServer(sid, 'prompt', { text: "", gen }));
		}
	});

	// Flush draft on page unload (hard refresh, tab close) via sendBeacon.
	// Regular fetch is killed by the browser during unload, so we use
	// sendBeacon which is guaranteed to be sent. This fixes PI-04b draft
	// loss on Ctrl+R / F5 when the debounce hasn't fired yet.
	window.addEventListener("beforeunload", () => {
		if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
		if (!_draftSessionId) return;
		const editor = document.querySelector("message-editor") as any;
		const val: string = editor?.value ?? "";
		if (!val.trim()) return;
		const gen = _nextDraftGen(_draftSessionId);
		const url = localStorage.getItem("gateway.url") || window.location.origin;
		const token = localStorage.getItem("gateway.token") || "";
		const body = JSON.stringify({ type: "prompt", data: { text: val, gen } });
		const blob = new Blob([body], { type: "application/json" });
		// sendBeacon doesn't support custom headers, so pass token as query param.
		// The server already accepts ?token= for auth (used by WebSocket connections).
		navigator.sendBeacon(`${url}/api/sessions/${_draftSessionId}/draft?token=${encodeURIComponent(token)}`, blob);
	});

	_draftListenersInstalled = true;
}

function _bindPromptDraftSession(sessionId: string): void {
	// Tear down any previous session's draft state.
	_teardownDraftHandlers();
	_draftSessionId = sessionId;
	_draftTouchedSinceBind = false;
	// Restore send gen from sessionStorage (survives HMR/reload)
	_draftSendGen = parseInt(sessionStorage.getItem(`draft-send-gen-${sessionId}`) || "0", 10);
	// Seed _draftGen from BOTH the send-gen tombstone AND the persisted
	// highest-gen mirror. _teardownDraftHandlers resets _draftGen to 0, but both
	// mirrors persist in sessionStorage — so on any bind (incl. after a session
	// round-trip) the client starts at or above the server's stored gen and new
	// saves are never silently rejected as stale by the server's monotonic-gen
	// guard (Bug 2 / PI-04b). _restorePromptDraft reseeds again from the loaded
	// server gen as a cross-reload/cross-tab backstop.
	_draftGen = Math.max(_draftSendGen, _loadStoredDraftGen(sessionId));
	_ensurePromptDraftListeners();
}

function _restorePromptDraft(sessionId: string): void {
	void (async () => {
		try {
			// Wait for any in-flight save from the previous session to land
			// before loading, so we don't get stale data on rapid switch-back.
			const pending = _pendingSave;
			if (pending) await pending;
			const draft = await loadDraftFromServer(sessionId, 'prompt');
			// Bail if we've navigated away — but DO seed the generation counter
			// below even when the user has typed since binding, so subsequent
			// saves outrank the server's stored gen.
			if (_draftSessionId !== sessionId) return;

			// Handle both old format (plain string) and new format ({ text, gen })
			let text: string | null = null;
			let loadedGen = 0;
			if (typeof draft === 'string') {
				// Legacy format — no gen, always apply
				text = draft;
			} else if (draft && typeof draft === 'object' && 'text' in (draft as any)) {
				const d = draft as { text: string; gen?: number };
				// If the draft text is non-empty, restore it. The tombstone
				// mechanism (empty text saved on send) is sufficient to prevent
				// stale resurrection — a send always overwrites the draft with
				// empty text. Any non-empty text on the server is a real draft
				// the user typed after their last send.
				text = d.text || null;
				if (typeof d.gen === 'number' && Number.isFinite(d.gen)) loadedGen = d.gen;
			}

			// Seed the client generation from the loaded server gen (Bug 2). Done
			// unconditionally — even when we skip applying the text below — so the
			// next save always carries a gen >= the server's and is never rejected
			// as stale. Backstops the synchronous bind-time seed for the cross-
			// reload / cross-tab case where the sessionStorage mirror is absent.
			_draftGen = Math.max(_draftGen, loadedGen, _draftSendGen);

			// User typed since binding — never clobber fresh local input with the
			// server draft (closes the first-paint hydration window). BUT the
			// local edit's 100ms debounced save may have raced ahead of this
			// delayed server GET and been rejected by the server staleness guard
			// for carrying a lower gen than the server's already-stored draft
			// (fresh tab: no sessionStorage gen mirror, so _draftGen started at 0).
			// We just reseeded _draftGen above to outrank the server, but the
			// rejected local text was never retried — so a subsequent navigate/
			// reload would lose it. Re-flush the local mirror now, at the corrected
			// gen, so the typed text reliably converges to the server (PR #830).
			// Tombstone-on-send is preserved: send removes the local mirror, so
			// after a send localMirror is null/empty and we skip the re-flush.
			if (_draftTouchedSinceBind) {
				const touchedMirror = sessionStorage.getItem(`bobbit_draft_${sessionId}`);
				if (touchedMirror && touchedMirror.trim()) _flushDraft(touchedMirror);
				return;
			}

			// Freshness guard (Bug 2 step 4): the synchronous sessionStorage mirror
			// is always at least as fresh as the debounced server draft within this
			// tab. If it holds DIFFERENT non-empty content, the server draft is
			// stale — keep the local content, persist it so the server converges,
			// and never overwrite the editor/sessionStorage with the stale value.
			const localMirror = sessionStorage.getItem(`bobbit_draft_${sessionId}`);
			if (localMirror && localMirror !== text) {
				_flushDraft(localMirror);
				return;
			}

			if (!text) return;
			// Store in sessionStorage so MessageEditor can read it synchronously
			// in connectedCallback — this survives element recreation by Lit.
			sessionStorage.setItem(`bobbit_draft_${sessionId}`, text);

			let frames = 0;
			const apply = () => {
				if (_draftSessionId !== sessionId || _draftTouchedSinceBind) return;
				const editor = document.querySelector("message-editor") as any;
				if (editor) editor.value = text;
				if (frames++ < 5) requestAnimationFrame(apply);
			};
			apply();
		} catch { /* ignore */ }
	})();
}

function _focusPromptEditor(): void {
	requestAnimationFrame(() => {
		const editor = document.querySelector("message-editor") as any;
		const textarea = editor?.querySelector("textarea");
		if (textarea) textarea.focus();
	});
}

// ============================================================================
// SYNCHRONOUS SESSION SELECTION
// ============================================================================

/**
 * Synchronous "select" phase — updates visual state immediately on keypress.
 * No async work. Bumps generation counter to invalidate in-flight hydrations.
 */
export function selectSession(sessionId: string, replaceHistory?: boolean): void {
	state.switchGeneration++;

	// Flush and teardown draft handlers for the outgoing session immediately.
	// This prevents stale _draftSessionId from saving to the wrong session
	// during the async gap before the next session binds autosave.
	if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
	_flushDraft();
	_teardownDraftHandlers();

	// Abort any in-flight git-status refresh for the outgoing session, and stop the poll.
	stopGitStatusPoll();
	if (state.selectedSessionId) abortGitStatusForSession(state.selectedSessionId);

	const outgoingPanel = transferActiveSessionToCache(state.selectedSessionId, sessionId);
	state.selectedSessionId = sessionId;

	// Proposals are scoped to the session that emitted them. Clear stale slots
	// the moment the user navigates away so they never bleed into other sessions.
	// connectToSession() rehydrates from persisted proposal files when returning.
	for (const type of PROPOSAL_TYPES) {
		const slot = state.activeProposals[type];
		if (slot && slot.sessionId !== sessionId) {
			if (type === "project") delete state.projectProposalAcceptedBySessionId[slot.sessionId];
			delete state.activeProposals[type];
		}
	}
	state.assistantHasProposal = PROPOSAL_TYPES.some((type) => state.activeProposals[type]?.sessionId === sessionId);

	// Fade out the outgoing chat panel instantly. Active ownership was already
	// released above so it cannot overlap with a cached owner.
	outgoingPanel?.classList.add("session-fade-out");
	state.cwdDropdownOpen = false;

	// Update hash route synchronously. Preserve an existing standalone
	// side-panel route for this same session while the connection hydrates it.
	const currentRoute = getRouteFromHash();
	if (!(currentRoute.view === "session" && currentRoute.sessionId === sessionId && currentRoute.panelTabId)) {
		setHashRoute("session", sessionId, replaceHistory);
	}

	// Update hue rotation synchronously
	document.documentElement.style.setProperty("--bobbit-hue-rotate", `${sessionHueRotation(sessionId)}deg`);

	// Update accessory class synchronously
	const sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
	const accClasses = ACCESSORY_IDS.map(id => id === "crown" ? "bobbit-crowned" : `bobbit-${id}`);
	accClasses.forEach((c) => document.documentElement.classList.remove(c));
	const accId = sessionData?.accessory
		?? (sessionData?.role === "team-lead" ? "crown" : sessionData?.role === "coder" ? "bandana" : undefined);
	if (accId && accId !== "none") {
		const cls = accId === "crown" ? "bobbit-crowned" : `bobbit-${accId}`;
		document.documentElement.classList.add(cls);
	}

	// Store in localStorage for restore
	localStorage.setItem(GW_SESSION_KEY, sessionId);

	// Synchronous render — sidebar highlight + header update instantly
	renderApp();
}

// ============================================================================
// CONNECT TO SESSION (select + hydrate)
// ============================================================================

// Wire the canonical full session switch into pack-panels so a pack panel opened
// with `PanelTarget.sessionId` (e.g. the PR-walkthrough reviewer-child pane) lands
// beside that session's chat as a first-class SELECTED session. Injected here —
// rather than statically imported by pack-panels — because pack-panels is imported
// ABOVE for `reconcilePackPanelsForProject`, so the reverse static import would be
// a cycle. `connectToSession` is a hoisted function declaration, so this top-level
// registration is safe. The arrow fixes `isExisting=false` (the same args the
// sidebar passes for a fresh switch + hydrate).
setSessionSwitcher((sessionId: string) => { void connectToSession(sessionId, false); });

export function installConfirmedSessionModelPersistence(remote: RemoteAgent, sessionId: string): () => void {
	return remote.subscribe((event: any) => {
		const model = event?.type === "state_update" ? event.data?.model : null;
		if (model?.provider && model?.id) saveSessionModel(sessionId, model.provider, model.id);
	});
}

export async function connectToSession(sessionId: string, isExisting: boolean, options?: { isGoalAssistant?: boolean; isRoleAssistant?: boolean; isToolAssistant?: boolean; isStaffAssistant?: boolean; isPreview?: boolean; assistantType?: string; readOnly?: boolean; projectDirPath?: string; projectEditContext?: { name: string; rootPath: string }; projectInitialScanContext?: import("./project-assistant-autoprompt.js").ProjectAssistantScanContext; onMissing?: "toast" | "modal"; refetchMessagesOnReady?: boolean }): Promise<void> {
	// Capture the current route BEFORE selectSession changes the hash.
	const startingRoute = getRouteFromHash();
	const replaceHistory = startingRoute.view === "goal-dashboard";

	// Phase 1: synchronous select
	selectSession(sessionId, replaceHistory);

	// Fast path: reuse cached session (instant switch-back). If the cached agent's
	// WebSocket is no longer open, drop it and fall through to a fresh connect so
	// pack-bound Host API surfaces can re-register their trusted WS minter.
	const cached = getCachedSession(sessionId);
	if (cached && isExisting && !cached.remoteAgent.connected) {
		sessionCache.delete(sessionId);
		cached.remoteAgent.disconnect();
	}
	if (cached && isExisting && cached.remoteAgent.connected) {
		sessionCache.delete(sessionId); // Take ownership
		state.chatPanel = cached.chatPanel;
		state.remoteAgent = cached.remoteAgent;
		state.remoteAgent.registerHostApiTransports();
		state.connectionStatus = "connected";
		state.connectingSessionId = null;

		// Fade in the restored panel
		state.chatPanel.classList.remove("session-fade-out");
		state.chatPanel.classList.add("session-fade-in");
		state.chatPanel.addEventListener("animationend", () => {
			state.chatPanel?.classList.remove("session-fade-in");
		}, { once: true });

		// Apply palette + accessory for the restored session (check archived too)
		const sessionForPalette = state.gatewaySessions.find(s => s.id === sessionId)
			|| state.archivedSessions.find(s => s.id === sessionId);
		applyProjectPalette(sessionForPalette?.projectId);
		// Re-drive pack-renderer registration for THIS session's project so a
		// reload / deep-link into a session whose project differs from the boot
		// active/default resolves the right project-scope renderers (design §4a/§4c).
		// Fire-and-forget — never block the session switch.
		void reconcilePackRenderersForProject(sessionForPalette?.projectId).catch(() => {});
		void reconcilePackPanelsForProject(sessionForPalette?.projectId).catch(() => {});
		void reconcilePackEntrypointsForProject(sessionForPalette?.projectId).catch(() => {});

		// Reset session-scoped global state so it doesn't bleed from the previous session.
		// If the session was just created server-side (e.g. via a back-channel API
		// call) the WS-driven `state.gatewaySessions` cache may not include it yet.
		// Refresh once so downstream lookups (staffId for inbox bootstrap, preview
		// flag, projectId for palette) see the live record instead of falling back
		// to defaults that would silently disable Inbox/preview features.
		let sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
		if (!sessionData) {
			await refreshSessions().catch(() => { /* fall back to cached list */ });
			sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
		}
		state.assistantType = sessionData?.assistantType
			|| (sessionData?.goalAssistant ? "goal"
			: sessionData?.roleAssistant ? "role"
			: sessionData?.toolAssistant ? "tool"
			: sessionData?.staffAssistant ? "staff"
			: null);
		state.assistantTab = "chat";
		// Drop proposal slots that belong to OTHER sessions only. The previous
		// behaviour was an unconditional `delete`, but the fast-path reuses the
		// existing WebSocket — so no fresh `proposal_update {source:"rehydrate"}`
		// frame ever arrives to repopulate the slot. The result was a visible
		// goal-proposal panel with empty content (and any in-memory inline
		// annotations re-anchoring as orphans because their referenced text
		// disappeared). Mirrors the slow-path guard at the bottom of
		// connectToSession (~line 1675).
		for (const t of PROPOSAL_TYPES) {
			const slot = state.activeProposals[t];
			if (slot && slot.sessionId !== sessionId) {
				delete state.activeProposals[t];
			}
		}
		// Recompute hasProposal from what's left.
		state.assistantHasProposal = PROPOSAL_TYPES.some((t) => state.activeProposals[t]?.sessionId === sessionId);
		state.previewTitle = "";
		state.previewSpec = "";
		state.previewCwd = "";
		state.previewMetadataRows = [];
		// Restore previewProjectId from the session record on fast-path switch-back.
		// The draft-restore on the slow path has a matching fallback at ~line 1488;
		// without this, clicking "Create Goal" in the proposal form after switching
		// away and back to a goal-assistant session fails with "Select a project…".
		state.previewProjectId = sessionData?.projectId || "";
		state.previewTitleEdited = false;
		state.previewSpecEdited = false;
		state.previewCwdEdited = false;
		state.previewMetadataEdited = false;
		state.isPreviewSession = sessionData?.preview || false;
		state.previewPanelMtime = 0;
		state.previewPanelEntry = "";
		state.previewPanelContentHash = "";
		state.reviewDocuments = new Map();
		state.reviewActiveTab = "";
		state.reviewPanelOpen = false;
		(await loadReviewSources()).restorePersistedReviewDocuments(sessionId, { select: true });
		state.inboxEntries = [];
		if (state.isPreviewSession) startPreviewPolling();
		else stopPreviewPolling();
		if (sessionData?.staffId) startInboxSubscription(sessionId, sessionData.staffId);
		else stopInboxSubscription();

		// Mark as visited so unseen indicators clear
		markSessionVisited(sessionId);
		canonicalizePathSessionRoute(sessionId);

		// Refresh scope-gate fields + archived readOnly on the restored
		// AgentInterface. Between disconnect and reconnect the session may
		// have been terminated elsewhere; without this the cached panel keeps
		// showing the live chrome and hides the "Continue in new session"
		// footer. Fire-and-forget — render runs immediately below.
		if (state.chatPanel?.agentInterface) {
			const ai = state.chatPanel.agentInterface;
			const applyFrom = (s: any) => {
				if (!s) return;
				ai.projectId = s.projectId;
				ai.goalId = s.goalId;
				ai.delegateOf = s.delegateOf;
				ai.teamGoalId = s.teamGoalId;
				ai.assistantType = s.assistantType;
				if (s.archived || s.status === "terminated" || s.status === "archived") {
					ai.readOnly = true;
				}
			};
			applyFrom(sessionData);
			const archivedMatch: any = state.archivedSessions?.find((s: any) => s.id === sessionId);
			applyFrom(archivedMatch);
			if (!sessionData && !archivedMatch) {
				gatewayFetch(`/api/sessions/${sessionId}`)
					.then(async (r) => { if (r.ok) applyFrom(await r.json()); renderApp(); })
					.catch(() => { /* best-effort */ });
			}
		}

		// Bind draft autosave before rendering the cached editor interactive.
		_bindPromptDraftSession(sessionId);
		renderApp();
		_restorePromptDraft(sessionId);
		_focusPromptEditor();

		// Init tri-state from the client-side repo-cache on cached switch-back
		// (last-known data still rendered). Cached 'no'/'hidden' start hidden with
		// a quiet background recheck — no skeleton flash. See git-repo-cache.ts.
		const fastGit = computeConnectGitState(sessionId);
		if (state.chatPanel?.agentInterface) {
			state.chatPanel.agentInterface.gitRepoKnown = fastGit.gitRepoKnown;
		}
		pruneGitRepoCache(state.gatewaySessions.map((s) => s.id));
		// Refresh git status and bg processes (lightweight, fire-and-forget)
		refreshGitStatusForSession(sessionId, { quiet: fastGit.quietRecheck });
		refreshBgProcessesForSession(sessionId);
		startGitStatusPoll(sessionId);

		// Re-fetch proposal drafts for this session. The slow path (fresh
		// connect) gets these via the WS-auth `proposal_update {source:"rehydrate"}`
		// broadcast, but the fast path reuses the existing WebSocket so that
		// broadcast never fires — leaving the proposal slot empty after a
		// switch-away/back round-trip even though the on-disk draft still
		// has the user's spec. Fire-and-forget; the unified onProposal
		// callback consumes the resulting events identically to the
		// auth-time path.
		const fastPathRehydrate = rehydrateProposalsForSession(sessionId).catch((err) => {
			console.warn("[session-manager] proposal rehydrate failed:", err);
		});

		// Restore goal/role/project assistant draft state. The slow path
		// runs these inside its draft-restore promise; the fast path skipped
		// them which left state.previewSpec / state.rolePreviewPrompt empty
		// after switch-away/back, breaking the assistant preview panel
		// (and inline-comment annotation anchoring against an empty body).
		if (state.assistantType === "goal") {
			// Finding 2 — fast-path switch-back stale-draft race. rehydrate (slot)
			// and restoreGoalDraft (form-mirror) ran fire-and-forget with no ordering;
			// for an OFF-SCREEN proposal the client draft is stale/empty, so restore
			// could blank previewTitle/previewSpec after rehydrate populated the slot.
			// Wait for BOTH, then run the same slot→form reconciliation the slow path
			// has (reconcileGoalSlotIntoFormMirror) so the rehydrated proposal always
			// wins over a stale draft, regardless of which promise settled first.
			Promise.allSettled([fastPathRehydrate, restoreGoalDraft(sessionId)]).then(() => {
				if (activeSessionId() !== sessionId) return;
				reconcileGoalSlotIntoFormMirror(sessionId);
				renderApp();
			}).catch((err) => {
				console.warn("[session-manager] fast-path goal draft restore failed:", err);
			});
		} else if (state.assistantType === "role") {
			restoreRoleDraft(sessionId).catch((err) => {
				console.warn("[session-manager] fast-path role draft restore failed:", err);
			});
		}

		return;
	}

	// Apply per-project palette (check archived sessions too — e.g. verification reviewers)
	const sessionForPalette = state.gatewaySessions.find(s => s.id === sessionId)
		|| state.archivedSessions.find(s => s.id === sessionId);
	applyProjectPalette(sessionForPalette?.projectId);
	// Re-drive pack renderers for this session's project (see fast-path above).
	void reconcilePackRenderersForProject(sessionForPalette?.projectId).catch(() => {});
	void reconcilePackPanelsForProject(sessionForPalette?.projectId).catch(() => {});
	void reconcilePackEntrypointsForProject(sessionForPalette?.projectId).catch(() => {});

	// Phase 2: async hydrate
	const gen = state.switchGeneration;
	const isStale = () => state.switchGeneration !== gen;
	// Only null out state.remoteAgent if it's still OUR remote instance.
	// A concurrent connectToSession() for a different session may have already
	// replaced it — blindly nulling would wipe the newer session's agent.
	const cleanupRemote = (remote: RemoteAgent) => {
		remote.disconnect();
		if (state.remoteAgent === remote) state.remoteAgent = null;
	};

	state.connectingSessionId = sessionId;

	// Show the chat UI shell immediately with a "Connecting..." state
	state.chatPanel = new ChatPanel();
	renderApp();

	try {
		const url = localStorage.getItem(GW_URL_KEY)!;
		const token = localStorage.getItem(GW_TOKEN_KEY)!;

		const remote = new RemoteAgent();

		await remote.connect(url, token, sessionId);
		if (isStale()) { remote.disconnect(); return; }
		installConfirmedSessionModelPersistence(remote, sessionId);
		await hydrateSidePanelWorkspace(sessionId);
		if (isStale()) { remote.disconnect(); return; }

		// ── Fire the transcript snapshot request the INSTANT the WS is
		// authenticated — before the refreshSessions()/setAgent() awaits below.
		// Profiling (boot-timing) showed those awaits stall the snapshot request
		// by ~700ms on a cold reload, even though the server builds the snapshot
		// in ~200ms. The reducer applies the snapshot to remote.state
		// independently of the ChatPanel binding, so the request can fly in
		// parallel with all the connect setup; the panel renders the messages
		// when setAgent() binds. Proposal checking is deferred here and released
		// by runDeferredProposalCheck() after draft restores complete — so an
		// early snapshot can't fill form state before drafts restore.
		// (Previously this lived ~250 lines below, AFTER those awaits, which
		// defeated the "fire early" intent.)
		if (isExisting) {
			remote.deferProposalCheck();
			remote.requestMessages();
		}

		// Auto-prompt for new assistant sessions — fire IMMEDIATELY after connect
		// before any draft-restore awaits that could yield and race
		const AUTO_PROMPTS: Record<string, string> = {
			goal: "Start the goal creation session.",
			role: "Start the role creation session.",
			tool: "Start the tool assistant session. Help me document, improve, or create tools.",
			staff: "Start the staff agent creation session.",
			setup: "Start the project setup session.",
			support: "Start the support session.",
		};
		if (options?.assistantType && !isExisting) {
			let autoPrompt: string | undefined;
			if (options.assistantType === "project" && options.projectEditContext) {
				autoPrompt = await formatProjectAssistantAutoPromptLazy({
					dirPath: options.projectDirPath ?? options.projectEditContext.rootPath,
					editContext: options.projectEditContext,
				});
			} else if (options.assistantType === "project" && options.projectDirPath) {
				autoPrompt = await formatProjectAssistantAutoPromptLazy({
					dirPath: options.projectDirPath,
					initialScanContext: options.projectInitialScanContext,
				});
			} else if (options.assistantType === "project-scaffolding" && options.projectDirPath) {
				autoPrompt = await formatProjectAssistantAutoPromptLazy({
					dirPath: options.projectDirPath,
					scaffolding: true,
				});
			} else {
				autoPrompt = AUTO_PROMPTS[options.assistantType];
			}
			// The kickoff is the assistant's FIRST message. Flag it non-title-generating
			// so auto-naming keys off the first GENUINE user message, not the kickoff.
			if (autoPrompt) remote.prompt(autoPrompt, undefined, { suppressTitleGen: true });
		}

		// Keep selection UX optimistic, but only persist server-confirmed model state.
		const originalSetModel = remote.setModel.bind(remote);
		remote.setModel = (model: any) => {
			originalSetModel(model);
			renderApp();
		};

		// Callbacks
		remote.onTitleChange = (newTitle: string) => {
			updateLocalSessionTitle(sessionId, newTitle);
		};

		// A freshly forked session may still be "preparing" (worktree + agent
		// spin-up) when we connect, so the initial get_messages can race ahead of
		// the cloned transcript being serveable. Re-request messages once the
		// agent first reaches a ready (idle) state so the prior conversation
		// reliably loads — mirrors how restored/continued sessions hydrate.
		let refetchOnReady = options?.refetchMessagesOnReady === true;

		remote.onStatusChange = (status: string) => {
			updateLocalSessionStatus(sessionId, status);
			if (refetchOnReady && status === "idle" && activeSessionId() === sessionId) {
				// Keep re-requesting until the cloned transcript actually lands —
				// the first get_messages can race the agent's switch_session adoption.
				if (remote.state.messages.length === 0) {
					remote.requestMessages();
				} else {
					refetchOnReady = false;
				}
			}
			const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
			if (idx >= 0) {
				state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], isAborting: remote.isAborting };
			}
			// Only update active session's UI state — cached sessions must not corrupt current panel
			if (activeSessionId() === sessionId) {
				// Set readOnly when archived status arrives (may come after initial connect)
				if (status === "archived" && state.chatPanel?.agentInterface) {
					state.chatPanel.agentInterface.readOnly = true;
				}
				// Trigger Lit re-render for aborting indicator — isAborting is read
				// from the session object (same reference), so Lit won't detect the change.
				if (
					(status === "aborting" ||
						status === "idle" ||
						status === "preparing" ||
						status === "starting") &&
					state.chatPanel?.agentInterface
				) {
					state.chatPanel.agentInterface.requestUpdate();
				}
			}
			// Refresh git status when agent becomes idle (turn finished).
			// Only for the ACTIVE session — cached/background agents firing
			// this for every turn would flood the server with git-status calls
			// (especially painful on mobile after tab wake when N cached agents
			// all reconnect and broadcast idle state).
			if (status === "idle" && activeSessionId() === sessionId) {
				refreshGitStatusForSession(sessionId);
				markSessionVisited(sessionId);
			}
			renderApp();
		};

		remote.onConnectionStatusChange = (status: ConnectionStatus) => {
			const isActive = activeSessionId() === sessionId;
			// Only update global connection status if this is the active session
			if (isActive) {
				state.connectionStatus = status;
			}
			// Re-fetch git status and bg processes after reconnect (e.g. server
			// restart). Skip for cached/background agents — they’ll be refreshed
			// lazily when the user switches back to them.
			if (status === "connected" && isActive) {
				refreshGitStatusForSession(sessionId);
				refreshBgProcessesForSession(sessionId);
				startGitStatusPoll(sessionId);
			} else if (status === "disconnected" && isActive) {
				stopGitStatusPoll();
				abortGitStatusForSession(sessionId);
			}
			if (isActive) renderApp();
		};

		remote.onCompactionChange = (isCompacting: boolean) => {
			const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
			if (idx >= 0) {
				state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], isCompacting };
			}
			if (activeSessionId() === sessionId) renderApp();
		};

		remote.onWorkflowUpdate = () => { if (activeSessionId() === sessionId) renderApp(); };

		// On WS reconnect, re-fire session-scoped REST hydration that ran on
		// initial connect. Without this, caches like git status, bg processes,
		// and review annotations go stale across a transient WS drop — the
		// dominant 'badge stuck after Reconnecting' E2E flake cluster (RP-18,
		// CT-01-d, S-02). Cheap, idempotent, runs only on non-initial connects.
		remote.onReconnect = async () => {
			if (activeSessionId() !== sessionId) return;
			try { refreshGitStatusForSession(sessionId); } catch { /* ignore */ }
			try { refreshBgProcessesForSession(sessionId); } catch { /* ignore */ }
			try {
				initAnnotationStore(sessionId).catch(() => { /* best-effort */ });
			} catch { /* AnnotationStore init failed — keep going */ }
		};

		// Server broadcasts session_removed when ANY session is terminated/archived/
		// purged. Update local lists instantly instead of waiting for the 5s
		// refreshSessions tick. If the removed session is the one we're viewing,
		// route to landing.
		remote.onSessionRemoved = (removedId: string, _reason: string) => {
			uncacheSession(removedId);
			const beforeLen = state.gatewaySessions.length;
			state.gatewaySessions = state.gatewaySessions.filter(s => s.id !== removedId);
			const changed = state.gatewaySessions.length !== beforeLen;
			if (activeSessionId() === removedId) {
				setHashRoute("landing");
				state.appView = "authenticated";
				state.selectedSessionId = null;
				if (state.remoteAgent) {
					state.remoteAgent.disconnect();
					state.remoteAgent = null;
				}
				renderApp();
			} else if (changed) {
				renderApp();
			}
		};

		remote.onGoalSetupEvent = async () => {
			// Refresh sessions and goals to pick up setupStatus changes
			refreshSessions();
			// Also refresh the goal dashboard's local state so the banner dismisses
			const { refreshDashboardGoal } = await import("./goal-dashboard.js");
			refreshDashboardGoal();
		};

		remote.onBgProcessEvent = (msg) => {
			const ai = state.chatPanel?.agentInterface;
			if (!ai || activeSessionId() !== sessionId) return;

			if (msg.type === "bg_process_created" && msg.process) {
				// Add the new process to the list
				ai.bgProcesses = [...ai.bgProcesses, msg.process];
			} else if (msg.type === "bg_process_output" && msg.processId && msg.text) {
				// Stream output to the pill
				const pill = ai.querySelector(`bg-process-pill[data-id="${msg.processId}"]`) as any;
				if (pill?.appendOutput) pill.appendOutput(msg.text, msg.ts);
			} else if (msg.type === "bg_process_exited" && msg.processId) {
				// Update status in the process list. Older servers may omit endTime;
				// preserve a non-growing null fallback instead of implying Date.now().
				// terminalReason "unrecoverable" maps to the widened "unrecoverable" status
				// (live outcome lost across a restart); everything else is a normal terminal "exited".
				const terminalReason = msg.terminalReason ?? null;
				const status = terminalReason === "unrecoverable" ? "unrecoverable" as const : "exited" as const;
				ai.bgProcesses = ai.bgProcesses.map((p) =>
					p.id === msg.processId
						? { ...p, status, exitCode: msg.exitCode ?? null, terminalReason, endTime: typeof msg.endTime === "number" ? msg.endTime : p.endTime ?? null }
						: p
				);
			} else if (msg.type === "bg_process_dismissed" && msg.processId) {
				// The process record + its persisted files were purged server-side; drop the pill.
				ai.bgProcesses = ai.bgProcesses.filter((p) => p.id !== msg.processId);
			}
		};

		remote.onPreviewChanged = (sid, preview) => {
			if (sid === sessionId && activeSessionId() === sessionId) {
				state.isPreviewSession = preview;
				if (preview) startPreviewPolling();
				else stopPreviewPolling();
				renderApp();
			}
		};

		remote.onPrStatusChanged = (goalId) => {
			// Targeted PR status refresh — bypasses the 60s poll throttle
			(async () => {
				try {
					const res = await gatewayFetch(`/api/goals/${goalId}/pr-status?optional=1`);
					if (res.status === 204) {
						state.prStatusCache.delete(goalId);
					} else if (res.ok) {
						const data = await res.json();
						state.prStatusCache.set(goalId, data);
					} else if (res.status === 404) {
						state.prStatusCache.delete(goalId);
					}
					renderApp();
				} catch { /* silently ignore network errors */ }
			})();
		};

		remote.onGoalProposal = (proposal, _streaming = false) => {
			if (activeSessionId() !== sessionId) return;
			if (state.assistantType === "goal") {
				// Slice E: state.activeProposals.goal is owned by the unified
				// onProposal callback (which runs before us with mergeFields).
				// Legacy callback only handles form-mirror state + summarisation.
				// First-emit dismissal short-circuit — if the unified callback
				// just bailed because the user previously dismissed an identical
				// proposal, don't re-populate the form-mirror preview fields.
				if (
					!state.activeProposals.goal &&
					isProposalDismissedForSession(sessionId, "goal", proposal as unknown as Record<string, unknown>)
				) {
					return;
				}
				// Finding 1 — the unified onProposal mirror owns the form-mirror once
				// the slot carries a server-stamped rev (>0). A non-streaming transcript
				// replay (_streaming === false) fired by _checkToolProposals carries the
				// ORIGINAL tool-use fields, which are stale after an edit_proposal / later
				// propose_goal stamped a newer rev. Skip the stale form-mirror rewrite in
				// that case; live streaming partials and first-emit (no server rev yet)
				// still write. assistantHasProposal / tab / summarisation / saveGoalDraft
				// below stay unconditional so first-emit + summarisation are unaffected.
				const goalSlot = state.activeProposals.goal;
				const serverAuthoritative = !_streaming && goalSlot?.sessionId === sessionId && (goalSlot.rev ?? 0) > 0;
				if (!serverAuthoritative) {
					if (typeof (proposal as any).projectId === "string" && (proposal as any).projectId.trim()) state.previewProjectId = (proposal as any).projectId.trim();
					if (!state.previewTitleEdited) state.previewTitle = proposal.title;
					if (!state.previewCwdEdited && proposal.cwd) state.previewCwd = proposal.cwd;
					if (!state.previewSpecEdited) state.previewSpec = proposal.spec;
					if (proposal.workflow) setSelectedWorkflowId(proposal.workflow);
					mirrorGoalSetupFields(proposal);
				}
				state.assistantHasProposal = true;
				if (state.assistantTab === "chat" && !isDesktop()) {
					state.assistantTab = "preview";
				}
				// Summarize goal title for sidebar display (deduplicate — streaming fires this many times)
				const trimmedProposalTitle = proposal.title.trim();
				if (trimmedProposalTitle.length >= 3 && trimmedProposalTitle !== (state as any)._lastSummarizedGoalTitle) {
					(state as any)._lastSummarizedGoalTitle = trimmedProposalTitle;
					// Cancel any pending debounced title summarization from hand-edits
					if ((state as any)._goalTitleDebounceTimer) {
						clearTimeout((state as any)._goalTitleDebounceTimer);
						(state as any)._goalTitleDebounceTimer = null;
					}
					remote.summarizeGoalTitle(trimmedProposalTitle);
				}
				// Persist draft to IndexedDB
				saveGoalDraft(sessionId);
			} else {
				// Non-goal-assistant session: dismissal short-circuit + project-id
				// inference. The unified onProposal callback (already fired above)
				// owns the slot + auto-tab-select side-effect; we still need to
				// roll back the slot if the user previously dismissed this proposal.
				if (isProposalDismissed(sessionId, proposal)) {
					delete state.activeProposals.goal;
					return;
				}
				// Set projectId from current session so the goal is created in the correct project
				const currentSess = state.gatewaySessions.find(s => s.id === sessionId);
				if (currentSess?.projectId) {
					state.previewProjectId = currentSess.projectId;
				}
			}
			renderApp();
		};

		remote.onRoleProposal = (proposal, _streaming = false) => {
			if (activeSessionId() !== sessionId) return;
			// Slice E: state.activeProposals.role owned by unified onProposal.
			// First-emit dismissal short-circuit — mirror goal handling so a
			// rehydrate of a dismissed role proposal doesn't repopulate form
			// fields.
			if (
				!state.activeProposals.role &&
				isProposalDismissedTyped(sessionId, "role", proposal as unknown as Record<string, unknown>)
			) {
				return;
			}
			if (!state.rolePreviewNameEdited) state.rolePreviewName = proposal.name;
			if (!state.rolePreviewLabelEdited) state.rolePreviewLabel = proposal.label;
			if (!state.rolePreviewPromptEdited) state.rolePreviewPrompt = proposal.prompt;
			if (!state.rolePreviewToolsEdited) state.rolePreviewTools = proposal.tools;
			if (!state.rolePreviewAccessoryEdited) state.rolePreviewAccessory = proposal.accessory;
			state.assistantHasProposal = true;
			if (state.assistantTab === "chat" && !isDesktop()) {
				state.assistantTab = "preview";
			}
			// Persist draft to IndexedDB
			saveRoleDraft(sessionId);
			renderApp();
		};

		remote.onToolProposal = (proposal, _streaming = false) => {
			if (activeSessionId() !== sessionId) return;
			state.toolPreviewName = proposal.tool;
			// Map action to checklist item
			const actionToItem: Record<string, keyof typeof state.toolPreviewChecklist> = {
				"docs": "docs",
				"renderer": "renderer",
				"tests": "tests",
				"config": "config",
				"access": "config",
				"new-tool": "config",
			};
			const item = actionToItem[proposal.action];
			if (item) {
				state.toolPreviewChecklist[item] = "done";
			}
			// Update docs content if docs action
			if (proposal.action === "docs") {
				state.toolPreviewDocs = proposal.content;
			}
			// Update renderer preview HTML if renderer action
			if (proposal.action === "renderer") {
				state.toolPreviewRendererHtml = proposal.content;
			}
			state.assistantHasProposal = true;
			if (state.assistantTab === "chat" && !isDesktop()) {
				state.assistantTab = "preview";
			}
			renderApp();
		};

		remote.onStaffProposal = (proposal, _streaming = false) => {
			if (activeSessionId() !== sessionId) return;
			// Slice E: state.activeProposals.staff owned by unified onProposal.
			if (!state.staffPreviewNameEdited) state.staffPreviewName = proposal.name;
			if (!state.staffPreviewDescriptionEdited) state.staffPreviewDescription = proposal.description;
			if (!state.staffPreviewPromptEdited) state.staffPreviewPrompt = proposal.prompt;
			if (!state.staffPreviewTriggersEdited) state.staffPreviewTriggers = proposal.triggers || "[]";
			if (!state.staffPreviewCwdEdited) state.staffPreviewCwd = proposalCwdOrProjectRoot(proposal.cwd, sessionId);
			state.assistantHasProposal = true;
			if (state.assistantTab === "chat" && !isDesktop()) {
				state.assistantTab = "preview";
			}
			renderApp();
		};

		remote.onProjectProposal = async (_fields: Record<string, unknown>, _streaming = false) => {
			if (activeSessionId() !== sessionId) return;
			// Slice E: state.activeProposals.project + mode + tab side-effects are
			// owned by the unified onProposal callback (with plugin.mergeFields
			// preserving structured side-tables, including per-component shallow
			// merge of commands/config). The legacy callback now only triggers the
			// project-assistant draft save.
			if (state.assistantType === "project" || state.assistantType === "project-scaffolding") {
				saveProjectDraft(sessionId);
			}
			renderApp();
		};

		// Slice E gap-closure: unified onProposal callback. Runs IN ADDITION to
		// the legacy onXProposal callbacks above so:
		//   • `proposal_update` from edit_proposal broadcasts hits the UI content.
		//   • `proposal_update {source: "rehydrate"}` on WS attach restores cached
		//     proposal content without recreating closed workspace tabs.
		//   • `proposal_cleared` after DELETE clears the in-memory slot.
		// The legacy callbacks still own the bespoke side-effects (project mode
		// resolution, goal title summarisation, workflow JSON parse → populateFromProposal,
		// per-type form-mirror state). The plugin.mergeFields shallow-merge guarantees
		// the second invocation per propose_* tool-use is idempotent.
		remote.onProposal = (type, fields, streaming, serverRev?: number, source?: ProposalSource) => {
			if (activeSessionId() !== sessionId) return;
			if (fields === null) {
				// proposal_cleared event from DELETE / accept
				if (type === "goal" || type === "role" || type === "staff") {
					clearProposalAnnotations(sessionId, type);
					resetProposalAnnCount(type);
				}
				delete state.activeProposals[type];
				// Recompute assistantHasProposal across remaining slots.
				state.assistantHasProposal = PROPOSAL_TYPES.some((t) => state.activeProposals[t] != null);
				renderApp();
				return;
			}
			const plugin = PROPOSAL_TYPE_REGISTRY[type];
			const prev = state.activeProposals[type];
			const hasServerRev = typeof serverRev === "number" && serverRev > 0;
			const isFirstEmit = prev == null;
			const prevRev = prev?.rev ?? 0;
			// Finding 1 — server-stamped revisions are the source of truth for
			// CONTENT, not just the rev number. The decision is delegated to the
			// pure `shouldApplyProposalUpdate` policy (pinned by
			// tests/proposal-update-policy.test.ts) so the slot + form-mirror stay
			// strictly monotonic w.r.t. the server rev. Two stale cases are dropped:
			//   • A no-serverRev tool-use/transcript rescan (streaming === false)
			//     carries the ORIGINAL propose_* fields, stale once a later seed/edit
			//     has stamped a newer rev into the slot (prevRev > 0). By message_end
			//     the server seed/edit has already applied identical-or-newer content,
			//     so skipping the non-streaming final/replay fire is harmless.
			//   • A server event whose serverRev < prevRev is an out-of-order older
			//     rehydrate/seed racing in AFTER a newer stamped edit; applying it
			//     would regress the content while the rev clamp keeps the rev high.
			// Live streaming partials and first-emit / pre-server (prevRev === 0)
			// still flow through so revision previews update in place.
			if (!shouldApplyProposalUpdate({ hasServerRev, serverRev, prevRev, streaming: streaming === true, isFirstEmit })) {
				return;
			}
			const scopedFields = withSessionProjectId(type, sessionId, fields);
			const merged = plugin.mergeFields(prev?.fields ?? {}, scopedFields);
			// Inline-comments: a new proposal body invalidates any pending
			// annotations because character offsets won't survive a rewrite.
			// Only fires for goal/role/staff and only on a true content change
			// (not the idempotent shallow-merge re-emit).
			if ((type === "goal" || type === "role" || type === "staff") && !isFirstEmit) {
				const oldBody = extractProposalBody(prev?.fields, type);
				const newBody = extractProposalBody(merged, type);
				if (oldBody !== newBody) {
					clearProposalAnnotations(sessionId, type);
					resetProposalAnnCount(type);
					showProposalToast("Proposal updated — comments cleared");
				}
			}
			// Dismissal short-circuit — a dismissed proposal must stay hidden even
			// when a fast-path draft restore or replay populated the slot before the
			// rehydrate event arrives. The comparison tolerates session projectId
			// normalization, while revised proposal content still surfaces normally.
			if (isProposalDismissedForSession(sessionId, type, merged)) {
				if (type === "goal" || type === "role" || type === "staff") {
					clearProposalAnnotations(sessionId, type);
					resetProposalAnnCount(type);
				}
				delete state.activeProposals[type];
				if (type === "goal" && state.assistantType === "goal") {
					clearGoalFormMirrorForDismissal();
				}
				state.assistantHasProposal = PROPOSAL_TYPES.some((t) => state.activeProposals[t]?.sessionId === sessionId);
				renderApp();
				return;
			}
			// Server-stamped rev (from proposal_update events) is the source of truth.
			// Streaming/final tool-use scans are only an in-memory preview path; they
			// must never synthesize revision numbers or a streamed proposal can race
			// ahead of the immutable snapshot counter and make the current tool card
			// look stale. Legacy no-rev paths keep the existing rev (or 0 = unknown).
			const nextRev = hasServerRev
				? Math.max(Math.trunc(serverRev as number), prevRev)
				: prevRev;
			const preservedWorkflowValidation = type === "goal" && !hasServerRev && sameProposalFields(prev?.fields, merged)
				? workflowValidationErrorFromSlot(prev)
				: undefined;
			const slot: ProposalSlot = {
				sessionId,
				fields: merged,
				streaming: false,
				// Always recompute from CURRENT fields. The source session and slot
				// provenance are intentionally excluded from create/edit classification.
				mode: type === "project"
					? resolveProjectMode(merged)
					: undefined,
				// Preserve source provenance independently from the semantic target.
				// A partial direct-create checkpoint likewise remains metadata only.
				...(type === "project"
					? {
						sourceProjectId: (prev?.sessionId === sessionId ? prev.sourceProjectId : undefined) ?? projectIdForSession(sessionId),
						...(prev?.sessionId === sessionId && prev.createdProjectId
							? { createdProjectId: prev.createdProjectId }
							: {}),
					}
					: {}),
				rev: nextRev,
				...(preservedWorkflowValidation ? { workflowValidationError: preservedWorkflowValidation } : {}),
			};
			state.activeProposals[type] = slot;
			state.assistantHasProposal = true;
			if (type === "project") {
				delete state.projectProposalAcceptedBySessionId[sessionId];
			}
			const isMatchingAssistant = isAssistantProposalType(type);
			const shouldRevealProposal = shouldRevealProposalForSource(source);
			if (isFirstEmit) {
				if (shouldRevealProposal) {
					plugin.onFirstEmit(slot, {
						isAssistant: isMatchingAssistant,
						isMobile: !isDesktop(),
					});
					if (state.assistantType && !isMatchingAssistant && !isDesktop()) {
						state.assistantTab = "preview";
					}
				}
			} else if (shouldRevealProposal) {
				// Only fresh explicit proposal outputs may create/focus workspace tabs.
				// Content-only sources (`rehydrate`, ordinary `edit`) still update the
				// active proposal slot above, so already-open panels refresh naturally
				// without resurrecting tabs the user closed.
				revealProposalPanel(type, { sessionId }, {
					isAssistant: isMatchingAssistant,
					isMobile: !isDesktop(),
				});
			}
			// Form-mirror gap closure: the goal-ASSISTANT panel (goalPreviewPanel)
			// renders from the legacy form-mirror state (previewTitle/previewSpec/
			// previewCwd), which the legacy onGoalProposal callback only writes on
			// the propose_* tool-use scan. edit_proposal frames, off-screen/rehydrated
			// proposals, and dedup-skipped replays reach the slot only through this
			// unified path. Mirror the merged goal fields here so those paths update
			// the panel too. Respects the *Edited flags exactly like the legacy
			// callback so in-progress user edits are never clobbered. Runs on every
			// non-dismissed goal proposal (first-emit, revision, edit, rehydrate).
			if (type === "goal" && state.assistantType === "goal") {
				const g = merged as { title?: string; spec?: string; cwd?: string; workflow?: string; projectId?: string; metadata?: unknown };
				if (typeof g.projectId === "string" && g.projectId.trim()) state.previewProjectId = g.projectId.trim();
				if (!state.previewTitleEdited && typeof g.title === "string") state.previewTitle = g.title;
				if (!state.previewSpecEdited && typeof g.spec === "string") state.previewSpec = g.spec;
				if (!state.previewCwdEdited && g.cwd) state.previewCwd = g.cwd;
				if (g.workflow) setSelectedWorkflowId(g.workflow);
				// `merged` is the authoritative post-merge proposal — clear stale rows
				// when it carries no metadata.
				mirrorGoalSetupFields(g, { authoritative: true });
				saveGoalDraft(sessionId);
			}
			// Form-mirror gap closure for the role/tool/staff panels. Same rationale
			// as the goal bridge above, but deliberately NOT gated on assistantType:
			// these panels can be opened from ANY session (e.g. the staff-creation
			// assistant proposing a role before proposing the staff member, or a
			// staff/team session emitting propose_role). Without this bridge the
			// panels render blank/disabled whenever the proposal reaches them only
			// through the unified path (seed/rehydrate/edit/restore/switch-back)
			// from a non-matching session, because the legacy onXProposal callbacks
			// only fire on the live tool-use scan of a matching-assistant session.
			// Mirrors the legacy onRoleProposal/onToolProposal/onStaffProposal field
			// mapping and *Edited guards exactly, reading the MERGED fields.
			if (type === "role") {
				const r = merged as { name?: string; label?: string; prompt?: string; tools?: string; accessory?: string };
				if (!state.rolePreviewNameEdited && typeof r.name === "string") state.rolePreviewName = r.name;
				if (!state.rolePreviewLabelEdited && typeof r.label === "string") state.rolePreviewLabel = r.label;
				if (!state.rolePreviewPromptEdited && typeof r.prompt === "string") state.rolePreviewPrompt = r.prompt;
				if (!state.rolePreviewToolsEdited && typeof r.tools === "string") state.rolePreviewTools = r.tools;
				if (!state.rolePreviewAccessoryEdited && typeof r.accessory === "string") state.rolePreviewAccessory = r.accessory;
				saveRoleDraft(sessionId);
			} else if (type === "tool") {
				const t = merged as { tool?: string; action?: string; content?: string };
				if (typeof t.tool === "string") state.toolPreviewName = t.tool;
				const actionToItem: Record<string, keyof typeof state.toolPreviewChecklist> = {
					"docs": "docs",
					"renderer": "renderer",
					"tests": "tests",
					"config": "config",
					"access": "config",
					"new-tool": "config",
				};
				if (typeof t.action === "string") {
					const item = actionToItem[t.action];
					if (item) state.toolPreviewChecklist[item] = "done";
					if (t.action === "docs" && typeof t.content === "string") state.toolPreviewDocs = t.content;
					if (t.action === "renderer" && typeof t.content === "string") state.toolPreviewRendererHtml = t.content;
				}
			} else if (type === "staff") {
				const s = merged as { name?: string; description?: string; prompt?: string; triggers?: string; cwd?: string };
				if (!state.staffPreviewNameEdited && typeof s.name === "string") state.staffPreviewName = s.name;
				if (!state.staffPreviewDescriptionEdited && typeof s.description === "string") state.staffPreviewDescription = s.description;
				if (!state.staffPreviewPromptEdited && typeof s.prompt === "string") state.staffPreviewPrompt = s.prompt;
				if (!state.staffPreviewTriggersEdited) state.staffPreviewTriggers = (typeof s.triggers === "string" ? s.triggers : "") || "[]";
				if (!state.staffPreviewCwdEdited) state.staffPreviewCwd = proposalCwdOrProjectRoot(s.cwd, sessionId);
			}
			renderApp();
		};

		// Listen for "Open proposal" button clicks from ProposalRenderer tool cards.
		// Routes the event to the same callbacks already wired above.
		const proposalOpenHandler = (async (e: Event) => {
			const ce = e as CustomEvent;
			if (activeSessionId() !== sessionId) return;
			const { type, fields, rev } = ce.detail || {};
			if (!type || !isProposalType(type)) return;
			const workflowValidationError = type === "goal"
				? workflowValidationErrorFromDetail((ce.detail as any)?.workflowValidationError)
				: undefined;
			// Slice E: clear per-type dismissal for ALL types so "Open proposal"
			// always re-opens the panel (the user explicitly clicked it).
			clearProposalDismissedTyped(sessionId, type);
			const numericRev = typeof rev === "number" && Number.isFinite(rev) && rev > 0 ? Math.trunc(rev) : undefined;
			const proposalFields = fields && typeof fields === "object" && !Array.isArray(fields)
				? fields as Record<string, unknown>
				: undefined;
			const callbackMap: Record<string, ((p: any, streaming: boolean) => void) | undefined> = {
				goal: remote.onGoalProposal,
				role: remote.onRoleProposal,
				tool: remote.onToolProposal,
				staff: remote.onStaffProposal,
				project: remote.onProjectProposal,
			};
			const openLiveProposal = (liveFields?: Record<string, unknown>, liveRev?: number) => {
				revealActiveProposalPanel(type, sessionId);
				if (!liveFields) {
					renderApp();
					return;
				}
				const cb = callbackMap[type];
				if (cb) cb(liveFields, /* streaming */ false);
				if (remote.onProposal) {
					remote.onProposal(type, liveFields, false, liveRev, "tool");
				}
			};
			const openFailedGoalSnapshot = (failedFields: Record<string, unknown>, error: GoalWorkflowValidationError) => {
				const failedSlot = (): ProposalSlot => ({
					sessionId,
					fields: { ...failedFields },
					streaming: false,
					rev: 0,
					workflowValidationError: error,
				});
				state.activeProposals.goal = failedSlot();
				state.assistantHasProposal = true;
				revealActiveProposalPanel("goal", sessionId);
				const cb = callbackMap.goal;
				if (cb) cb(failedFields, /* streaming */ false);
				state.activeProposals.goal = failedSlot();
				state.assistantHasProposal = true;
				renderApp();
			};

			if (!numericRev && type === "goal" && proposalFields && workflowValidationError) {
				openFailedGoalSnapshot(proposalFields, workflowValidationError);
				return;
			}

			if (numericRev) {
				const activeSlot = state.activeProposals[type];
				const activeRev = activeSlot?.sessionId === sessionId && typeof activeSlot.rev === "number" && Number.isFinite(activeSlot.rev) && activeSlot.rev > 0
					? Math.trunc(activeSlot.rev)
					: undefined;
				if (activeRev === numericRev) {
					openLiveProposal(proposalFields ?? activeSlot?.fields, activeRev);
					return;
				}
				if ((activeRev == null || numericRev > activeRev) && proposalFields) {
					openLiveProposal(proposalFields, numericRev);
					return;
				}

				selectProposalWorkspaceTab(type, { sessionId, select: true, setAssistantTab: true, rev: numericRev, fields: proposalFields });
				renderApp();
				if (proposalFields) return;
				try {
					const res = await readProposalSnapshot(sessionId, type, numericRev);
					if (res && (res as any).ok && hasObjectFields((res as any).fields)) {
						const snapshotFields = (res as any).fields as Record<string, unknown>;
						const latestSlot = state.activeProposals[type];
						const latestRev = latestSlot?.sessionId === sessionId && typeof latestSlot.rev === "number" && Number.isFinite(latestSlot.rev) && latestSlot.rev > 0
							? Math.trunc(latestSlot.rev)
							: undefined;
						if (latestRev == null || numericRev >= latestRev) {
							openLiveProposal(snapshotFields, numericRev);
						} else {
							selectProposalWorkspaceTab(type, {
								sessionId,
								select: true,
								setAssistantTab: true,
								rev: numericRev,
								fields: snapshotFields,
							});
							renderApp();
						}
					} else {
						handleProposalSnapshotUnavailable(type, sessionId, numericRev, res);
					}
				} catch (err) {
					handleProposalSnapshotUnavailable(type, sessionId, numericRev, err);
				}
				return;
			}

			// Legacy fields path (archived sessions with no rev marker).
			openLiveProposal(proposalFields);
		}) as EventListener;
		document.addEventListener("proposal-open", proposalOpenHandler);

		// Clean up the listener when the remote agent disconnects
		const origDisconnect = remote.disconnect.bind(remote);
		remote.disconnect = () => {
			document.removeEventListener("proposal-open", proposalOpenHandler);
			origDisconnect();
		};

		if (isStale()) { remote.disconnect(); return; }

		state.connectionStatus = "connected";
		state.remoteAgent = remote;
		state.appView = "authenticated";
		markSessionVisited(sessionId);
		canonicalizePathSessionRoute(sessionId);

		// Detect assistant type from cached session data. The cache may lag the
		// gateway when a session was just created via a back-channel API call;
		// refresh on miss so the staffId-driven inbox bootstrap fires correctly.
		let sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
		if (!sessionData) {
			await refreshSessions().catch(() => { /* fall back to cached list */ });
			sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
		}
		state.assistantType = options?.assistantType
			|| sessionData?.assistantType
			|| (options?.isGoalAssistant || sessionData?.goalAssistant ? "goal"
			: options?.isRoleAssistant || sessionData?.roleAssistant ? "role"
			: options?.isToolAssistant || sessionData?.toolAssistant ? "tool"
			: options?.isStaffAssistant || sessionData?.staffAssistant ? "staff"
			: null);
		state.assistantTab = "chat";
		state.assistantHasProposal = false;
		state.isPreviewSession = options?.isPreview || sessionData?.preview || false;
		state.previewPanelMtime = 0;
		state.previewPanelEntry = "";
		state.previewPanelContentHash = "";
		state.reviewDocuments = new Map();
		state.reviewActiveTab = "";
		state.reviewPanelOpen = false;
		(await loadReviewSources()).restorePersistedReviewDocuments(sessionId, { select: true });
		state.inboxEntries = [];
		if (state.isPreviewSession) startPreviewPolling();
		else stopPreviewPolling();
		if (sessionData?.staffId) startInboxSubscription(sessionId, sessionData.staffId);
		else stopInboxSubscription();

		// Bind draft autosave before setAgent can render an interactive editor;
		// setAgent awaits lazy imports after assigning agentInterface, so Lit can
		// paint the textarea before setAgent returns under load.
		_bindPromptDraftSession(sessionId);

		// ── Bind the agent to the early ChatPanel (created before connect
		// to show the "Connecting…" shell instantly).
		await state.chatPanel!.setAgent(remote as any, {
			onApiKeyRequired: async () => true,
		});
		if (isStale()) { cleanupRemote(remote); return; }

		// Listen for suggest-goal events from assistant messages
		state.chatPanel.addEventListener('suggest-goal', () => {
			if (state.remoteAgent) {
				state.remoteAgent.prompt("Based on our conversation, please create a goal proposal for the improvement you suggested. Use the propose_goal tool with a title and spec.");
			}
		});

		// Set cwd and branch on the AgentInterface stats bar. For archived
		// sessions re-opened later, sessionData lives in archivedSessions, not
		// gatewaySessions — look there as a fallback so the scope-gate fields
		// (goalId / delegateOf / teamGoalId / assistantType) that gate the
		// "Continue in new session" footer are threaded through.
	let sessionDataAny: any = sessionData
			|| state.archivedSessions?.find((s: any) => s.id === sessionId);
		// Archived sessions re-opened directly (no prior sidebar load) aren't in
		// either cache — fetch the record so the scope-gate fields threaded to
		// AgentInterface (goalId / delegateOf / teamGoalId / assistantType) are
		// available for the "Continue in new session" footer.
		if (!sessionDataAny) {
			try {
				const resp = await gatewayFetch(`/api/sessions/${sessionId}`);
				if (resp.ok) sessionDataAny = await resp.json();
			} catch { /* best-effort */ }
			if (isStale()) { cleanupRemote(remote); return; }
		}
		if (state.chatPanel.agentInterface && sessionDataAny) {
			if (sessionDataAny.cwd) state.chatPanel.agentInterface.cwd = sessionDataAny.cwd;
			state.chatPanel.agentInterface.projectId = sessionDataAny.projectId;
			state.chatPanel.agentInterface.goalId = sessionDataAny.goalId;
			state.chatPanel.agentInterface.delegateOf = sessionDataAny.delegateOf;
			state.chatPanel.agentInterface.teamGoalId = sessionDataAny.teamGoalId;
			state.chatPanel.agentInterface.assistantType = sessionDataAny.assistantType;
			if (sessionDataAny.goalId) {
				const goal = state.goals.find((g) => g.id === sessionDataAny.goalId);
				if (goal?.branch) {
					state.chatPanel.agentInterface.branch = goal.branch;
				}
			}
		}

		// Disable input for archived or explicitly read-only sessions.
		// Also honour the REST session record — when re-opening a terminated
		// session directly, remote.state.isArchived hasn't settled yet but the
		// PersistedSession's `archived` / `status=="terminated"` flags are
		// authoritative.
		const recordArchived = !!sessionDataAny && (sessionDataAny.archived || sessionDataAny.status === "terminated");
		if (state.chatPanel.agentInterface && (remote.state.isArchived || recordArchived || options?.readOnly)) {
			state.chatPanel.agentInterface.readOnly = true;
		}

		// Non-interactive sessions (e.g. verification reviewers) — show editor only while streaming (steer-only)
		if (state.chatPanel.agentInterface && sessionData?.nonInteractive) {
			state.chatPanel.agentInterface.readOnly = true;
			state.chatPanel.agentInterface.nonInteractive = true;
		}

		// Set up bg process kill/dismiss handlers
		if (state.chatPanel.agentInterface) {
			state.chatPanel.agentInterface.onBgProcessKill = (processId: string) => {
				killBgProcess(sessionId, processId);
			};
			state.chatPanel.agentInterface.onBgProcessDismiss = (processId: string) => {
				dismissBgProcess(sessionId, processId);
			};
			state.chatPanel.agentInterface.onGitFetch = () => {
				refreshGitStatusForSession(sessionId, { fetch: true, source: "user" });
			};
			// Dropdown-open → refetch with untracked=1 for full file list. This
			// handler is re-bound on session switches so it closes over the current
			// sessionId, but remove the previous one first to avoid listener stacking.
			const gitStatusAgentInterface = state.chatPanel.agentInterface as typeof state.chatPanel.agentInterface & {
				__gitStatusDropdownOpenHandler?: EventListener;
			};
			if (gitStatusAgentInterface.__gitStatusDropdownOpenHandler) {
				gitStatusAgentInterface.removeEventListener("git-status-dropdown-open", gitStatusAgentInterface.__gitStatusDropdownOpenHandler);
			}
			gitStatusAgentInterface.__gitStatusDropdownOpenHandler = () => {
				// Pill open combines remote fetch and full untracked loading in one request
				// so the paired dropdown event cannot abort the fetch-only refresh.
				refreshGitStatusForSession(sessionId, { fetch: true, untracked: true, source: "user" });
			};
			gitStatusAgentInterface.addEventListener("git-status-dropdown-open", gitStatusAgentInterface.__gitStatusDropdownOpenHandler);
			state.chatPanel.agentInterface.onGitPush = async () => {
				try {
					const res = await gatewayFetch(`/api/sessions/${sessionId}/git-push`, {
						method: 'POST',
					});
					if (res.ok) {
						refreshGitStatusForSession(sessionId);
						return undefined;
					}
					const data = await res.json().catch(() => ({ error: 'Push failed' }));
					return data.error || 'Push failed';
				} catch (err) {
					return err instanceof Error ? err.message : 'Network error';
				}
			};
			state.chatPanel.agentInterface.onGitPull = async () => {
				try {
					const res = await gatewayFetch(`/api/sessions/${sessionId}/git-pull`, {
						method: 'POST',
					});
					if (res.ok) {
						refreshGitStatusForSession(sessionId);
						return undefined;
					}
					const data = await res.json().catch(() => ({ error: 'Pull failed' }));
					return data.error || 'Pull failed';
				} catch (err) {
					return err instanceof Error ? err.message : 'Network error';
				}
			};
			state.chatPanel.agentInterface.onGitSquashPush = async () => {
				try {
					const res = await gatewayFetch(`/api/sessions/${sessionId}/git-squash-push`, {
						method: 'POST',
					});
					if (res.ok) {
						refreshGitStatusForSession(sessionId);
						return undefined;
					}
					const data = await res.json().catch(() => ({ error: 'Squash push failed' }));
					return data.error || 'Squash push failed';
				} catch (err) {
					return err instanceof Error ? err.message : 'Network error';
				}
			};
			state.chatPanel.agentInterface.onGitMergePrimary = async () => {
				try {
					const res = await gatewayFetch(`/api/sessions/${sessionId}/git-merge-primary`, {
						method: 'POST',
					});
					if (res.ok) {
						refreshGitStatusForSession(sessionId);
						return undefined;
					}
					const data = await res.json().catch(() => ({ error: 'Merge failed' }));
					return data.error || 'Merge failed';
				} catch (err) {
					return err instanceof Error ? err.message : 'Network error';
				}
			};
			state.chatPanel.agentInterface.onAskAgentCommit = () => {
				if (state.remoteAgent) {
					state.remoteAgent.prompt('Please commit your current changes with an appropriate commit message.');
				}
			};
			state.chatPanel.agentInterface.onAskAgentPr = () => {
				if (state.remoteAgent) {
					state.remoteAgent.prompt('Please raise a pull request for the current branch with an appropriate title and description.');
				}
			};
			state.chatPanel.agentInterface.onPrMerge = async (method: string, admin?: boolean, branch?: string) => {
				const sd = state.gatewaySessions.find((s) => s.id === sessionId);
				const mergeUrl = sd?.goalId
					? `/api/goals/${sd.goalId}/pr-merge`
					: `/api/sessions/${sessionId}/pr-merge`;
				try {
					const res = await gatewayFetch(mergeUrl, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ method, ...(admin ? { admin: true } : {}), ...(branch ? { branch } : {}) }),
					});
					if (res.ok) {
						refreshPrStatusForSession(sessionId);
						refreshPrStatusCache();
						return undefined;
					}
					const data = await res.json().catch(() => ({ error: 'Merge failed' }));
					return data.error || 'Merge failed';
				} catch (err) {
					return err instanceof Error ? err.message : 'Network error';
				}
			};
		}

		// ── First render: connected state with new (empty) ChatPanel.
		// The mobile header and session chrome appear immediately.
		// Trigger fade-in animation on the new panel.
		if (state.chatPanel) {
			state.chatPanel.classList.add("session-fade-in");
			state.chatPanel.addEventListener("animationend", () => {
				state.chatPanel?.classList.remove("session-fade-in");
			}, { once: true });
		}
		renderApp();

		// Replace history if the hash changed to a goal-dashboard during the async gap
		const currentRoute = getRouteFromHash();
		if (currentRoute.view === "goal-dashboard") {
			setHashRoute("session", sessionId, true);
		}

		// (Snapshot request + proposal-check deferral were hoisted to fire
		// immediately after connect() resolves — see the block right after
		// `await remote.connect(...)` above. Firing here, after the
		// refreshSessions()/setAgent() awaits, added ~700ms to every reload.)

		// Initial git status and bg process fetch (fire-and-forget). Seed the
		// tri-state from the client-side repo-cache so known git-less/empty sessions
		// start hidden with a quiet recheck (no "Checking git…" skeleton flash).
		const slowGit = computeConnectGitState(sessionId);
		if (state.chatPanel?.agentInterface) {
			state.chatPanel.agentInterface.gitRepoKnown = slowGit.gitRepoKnown;
		}
		pruneGitRepoCache(state.gatewaySessions.map((s) => s.id));
		refreshGitStatusForSession(sessionId, { quiet: slowGit.quietRecheck });
		refreshBgProcessesForSession(sessionId);
		startGitStatusPoll(sessionId);

		// ── Run draft restores, refreshSessions, and storage.providerKeys
		// in parallel. Draft restores must complete before we unlock proposal
		// checking, but they don't depend on refreshSessions.
		const draftRestorePromise = (async () => {
			// Clear stale proposals for non-matching assistant types or sessions.
			// IMPORTANT: only clear when the slot does NOT belong to the current
			// session. The unified `onProposal` handler buffers `proposal_update`
			// events received between WS-connect and callback-wiring (see
			// remote-agent.ts), so by the time this draft-restore runs, the
			// rehydrate-on-attach broadcast for the CURRENT session may have
			// already populated the slot. Blindly deleting it here drops the
			// rehydrated state for non-assistant sessions — the exact regression
			// covered by the proposal-types parity restart-survival E2E tests.
			// Mirror the project-slot pattern below: keep the slot when it's
			// scoped to this session, drop it only when it's left over from a
			// different session.
			for (const type of PROPOSAL_TYPES) {
				const slot = state.activeProposals[type];
				if (slot && slot.sessionId !== sessionId) {
					if (type === "project") delete state.projectProposalAcceptedBySessionId[slot.sessionId];
					delete state.activeProposals[type];
				}
			}
			state.assistantHasProposal = PROPOSAL_TYPES.some((type) => state.activeProposals[type]?.sessionId === sessionId);

			if (state.assistantType === "goal") {
				const restored = await restoreGoalDraft(sessionId);
				if (isStale()) return;
				// The unified onProposal slot is the source of truth for the proposal
				// CONTENT (populated by the WS-auth `proposal_update {rehydrate}`
				// broadcast on every fresh/boot connect). restoreGoalDraft may have just
				// clobbered the form-mirror the goal-assistant panel reads from with a
				// stale/empty persisted draft — e.g. an OFF-SCREEN proposal whose client
				// draft was saved (empty) while the panel was inactive. Mirror the slot
				// into the form-mirror (shared with the fast path), respecting the
				// *Edited flags so a genuine in-progress user edit always wins.
				const reconciled = reconcileGoalSlotIntoFormMirror(sessionId);
				if (!reconciled && !restored) {
					state.assistantTab = "chat";
					state.previewTitle = "";
					state.previewCwd = "";
					state.previewSpec = "";
					state.previewMetadataRows = [];
					state.previewTitleEdited = false;
					state.previewCwdEdited = false;
					state.previewSpecEdited = false;
					state.previewMetadataEdited = false;
					state.assistantHasProposal = false;
					// Keep previewProjectId if set by showGoalDialog (pre-filled from project button)
					// Only clear if not already set
					if (!state.previewProjectId) {
						const currentSession = state.gatewaySessions.find(s => s.id === sessionId);
						state.previewProjectId = currentSession?.projectId || "";
					}
				}
				state.previewSpecEditMode = false;
			} else if (state.assistantType === "role") {
				const restored = await restoreRoleDraft(sessionId);
				if (isStale()) return;
				if (!restored) {
					state.assistantTab = "chat";
					state.rolePreviewName = "";
					state.rolePreviewLabel = "";
					state.rolePreviewPrompt = "";
					state.rolePreviewTools = "";
					state.rolePreviewAccessory = "none";
					state.rolePreviewNameEdited = false;
					state.rolePreviewLabelEdited = false;
					state.rolePreviewPromptEdited = false;
					state.rolePreviewToolsEdited = false;
					state.rolePreviewAccessoryEdited = false;
					state.assistantHasProposal = false;
				}
				state.rolePreviewPromptEditMode = false;
			} else if (state.assistantType === "tool") {
				state.assistantTab = "chat";
				state.toolPreviewName = "";
				state.toolPreviewChecklist = { docs: "pending", renderer: "pending", tests: "pending", config: "pending" };
				state.toolPreviewDocs = "";
				state.toolPreviewRendererHtml = "";
			} else if (state.assistantType === "staff") {
				state.assistantTab = "chat";
				resetStaffProposalPreview(sessionId);
				if (options?.isStaffAssistant && !isExisting) openAssistantProposalWorkspaceTab("staff", sessionId);
			} else if (state.assistantType === "project" || state.assistantType === "project-scaffolding") {
				const restored = await restoreProjectDraft(sessionId);
				if (isStale()) return;
				if (!restored) {
					state.assistantTab = "chat";
					delete state.activeProposals.project;
					state.assistantHasProposal = false;
				}
			}
		})();

		const backgroundWork = Promise.all([
			refreshSessions().then(() => {
				if (isStale()) return;
				// Re-apply accessory class after refreshSessions (may have new data)
				const sessionForRole = state.gatewaySessions.find((s) => s.id === sessionId)
					|| state.archivedSessions.find((s) => s.id === sessionId);
				const accClasses2 = ACCESSORY_IDS.map(id => id === "crown" ? "bobbit-crowned" : `bobbit-${id}`);
				accClasses2.forEach((c) => document.documentElement.classList.remove(c));
				const accId = sessionForRole?.accessory
					?? (sessionForRole?.role === "team-lead" ? "crown" : sessionForRole?.role === "coder" ? "bandana" : undefined);
				if (accId && accId !== "none") {
					const cls = accId === "crown" ? "bobbit-crowned" : `bobbit-${accId}`;
					document.documentElement.classList.add(cls);
				}
				// Re-apply project palette after refreshSessions (session may now have projectId)
				applyProjectPalette(sessionForRole?.projectId);
				// The session's project may have only just become known here — re-drive
				// pack renderers for it (deduped if unchanged; design §4a/§4c).
				void reconcilePackRenderersForProject(sessionForRole?.projectId).catch(() => {});
				void reconcilePackPanelsForProject(sessionForRole?.projectId).catch(() => {});
				void reconcilePackEntrypointsForProject(sessionForRole?.projectId).catch(() => {});
				// Apply cwd/branch if not set earlier (sessionData wasn't in gatewaySessions yet)
				if (state.chatPanel?.agentInterface && !state.chatPanel.agentInterface.cwd && sessionForRole?.cwd) {
					state.chatPanel.agentInterface.cwd = sessionForRole.cwd;
					state.chatPanel.agentInterface.projectId = sessionForRole.projectId;
					state.chatPanel.agentInterface.goalId = sessionForRole.goalId;
					state.chatPanel.agentInterface.delegateOf = (sessionForRole as any).delegateOf;
					state.chatPanel.agentInterface.teamGoalId = (sessionForRole as any).teamGoalId;
					state.chatPanel.agentInterface.assistantType = (sessionForRole as any).assistantType;
					if (sessionForRole.goalId) {
						const goal = state.goals.find((g) => g.id === sessionForRole.goalId);
						if (goal?.branch) {
							state.chatPanel.agentInterface.branch = goal.branch;
						}
					}
				}
			}),
			storage.providerKeys.set(remote.state.model?.provider || "anthropic", "gateway-managed"),
		]);

		// Wait for draft restores to finish, then unlock proposal checking
		// so any buffered messages can now safely run _checkProposals.
		await draftRestorePromise;
		if (isStale()) { cleanupRemote(remote); return; }
		if (isExisting) {
			remote.runDeferredProposalCheck();
		}

		// Wait for background work (refreshSessions + storage) to settle
		// BEFORE restoring the draft. Background work triggers re-renders
		// that can clobber the textarea value if the draft is set too early.
		await backgroundWork;
		if (isStale()) { cleanupRemote(remote); return; }

		// Restore prompt draft from server after background renders settle.
		// Autosave was already bound before setAgent exposed the editor.
		_restorePromptDraft(sessionId);
		_focusPromptEditor();
	} catch (err) {
		if (!isStale()) {
			// Clear the early ChatPanel so the UI doesn't show a stuck "Connecting…" spinner
			state.chatPanel = null;
			const msg = err instanceof Error ? err.message : String(err);
			// If the caller opted into toast-on-missing (typically search-page
			// navigation), suppress the blocking modal when the session is gone
			// and dispatch a page-local event instead.
			const missing = /session not found|SESSION_NOT_FOUND|code\s*4005/i.test(msg);
			if (options?.onMissing === "toast" && missing) {
				window.dispatchEvent(new CustomEvent("search-result-stale", {
					detail: { kind: "session", id: sessionId },
				}));
			} else {
				const { code, stack } = errorDetails(err);
				showConnectionError(
					"Connection Failed",
					`Could not connect to session: ${msg}`,
					{ code, stack },
				);
			}
		}
	} finally {
		// Always clear connectingSessionId for our session — even if stale.
		// When stale, the newer connectToSession already overwrote it, so
		// clearing is a no-op for our id. But if we DON'T clear, and the
		// newer call hasn't reached the assignment yet, we'd leave a stuck
		// connecting indicator.
		if (state.connectingSessionId === sessionId) {
			state.connectingSessionId = null;
		}
		renderApp();
	}
}

// ============================================================================
// CREATE & CONNECT
// ============================================================================

export async function createAndConnectSession(goalId?: string, roleId?: string, cwd?: string, worktree?: boolean, sandboxed?: boolean, projectId?: string): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	state.creatingSessionForGoalId = goalId || null;
	renderApp();
	try {
		const resolvedProjectId = projectId || projectIdForGoal(goalId) || (!goalId ? defaultProjectIdForNewSession() : undefined);
		if (!resolvedProjectId && !goalId) {
			showConnectionError("No project selected", "Choose a project before starting a session.");
			return;
		}
		const body: any = {};
		if (goalId) body.goalId = goalId;
		if (roleId) body.roleId = roleId;
		const headquartersScope = isHeadquartersProject(resolvedProjectId);
		if (cwd) body.cwd = cwd;
		if (headquartersScope) body.worktree = false;
		else if (worktree !== undefined) body.worktree = worktree;
		if (sandboxed) body.sandboxed = true;
		if (resolvedProjectId) body.projectId = resolvedProjectId;
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({} as any));
			const err = new Error((data && data.error) || `Session creation failed: ${res.status}`);
			(err as any).code = data?.code;
			(err as any).stack = data?.stack || (err as any).stack;
			throw err;
		}
		const { id } = await res.json();
		// Clear creatingSession before connecting — connectToSession handles its
		// own loading state via connectingSessionId, and we want the user to see
		// the chat panel (with textarea) immediately, not a loading spinner.
		state.creatingSession = false;
		state.creatingSessionForGoalId = null;
		await connectToSession(id, false);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const code = err && typeof err === "object" ? (err as any).code : undefined;
		const stack = err instanceof Error ? err.stack : undefined;
		showConnectionError("Failed to create session", msg, { code, stack });
	} finally {
		state.creatingSession = false;
		state.creatingSessionForGoalId = null;
		renderApp();
	}
}

export type ForkSessionResponse = {
	id: string;
	cwd: string;
	status: string;
	projectId?: string;
	goalId?: string;
	title?: string;
};

/**
 * Fork a live session: the server clones its conversation history into a new
 * session and either spins up a fresh worktree (`newWorktree: true`, default)
 * or reuses the source session's existing worktree (`newWorktree: false`).
 */
export async function forkSession(source: GatewaySession, opts: { newWorktree: boolean }): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	state.creatingSessionForGoalId = source.goalId || null;
	renderApp();
	try {
		const res = await gatewayFetch(`/api/sessions/${encodeURIComponent(source.id)}/fork`, {
			method: "POST",
			body: JSON.stringify({ newWorktree: opts.newWorktree }),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({} as any));
			const err = new Error((data && data.error) || `Session fork failed: ${res.status}`);
			(err as any).code = data?.code;
			(err as any).stack = data?.stack || (err as any).stack;
			throw err;
		}
		const fork = await res.json() as ForkSessionResponse;
		if (!fork?.id) throw new Error("Session fork response did not include an id");
		state.creatingSession = false;
		state.creatingSessionForGoalId = null;
		await refreshSessions();
		// Connect as an existing session so the cloned conversation history is
		// requested (get_messages) and rendered — same path restored/continued
		// sessions use. The fork spins up a fresh worktree/agent, so it may be
		// "preparing" at navigate time; refetchMessagesOnReady re-requests the
		// transcript once the agent first reaches idle so history reliably shows.
		await connectToSession(fork.id, true, { refetchMessagesOnReady: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const code = err && typeof err === "object" ? (err as any).code : undefined;
		const stack = err instanceof Error ? err.stack : undefined;
		showConnectionError("Failed to fork session", msg, { code, stack });
	} finally {
		state.creatingSession = false;
		state.creatingSessionForGoalId = null;
		renderApp();
	}
}

// ============================================================================
// TERMINATE
// ============================================================================

export async function terminateSession(sessionId: string, opts?: { goalId?: string; isTeamLead?: boolean }): Promise<void> {
	// Resolve session info eagerly — callers can pass pre-resolved values to
	// avoid stale lookups (e.g. the sidebar already knows the goalId at render time).
	const session = state.gatewaySessions.find((s) => s.id === sessionId);
	const sessionTitle = session?.title || "this session";
	const isTeamLead = opts?.isTeamLead ?? session?.role === "team-lead";
	const goalId = opts?.goalId ?? session?.goalId ?? session?.teamGoalId;
	// Non-goal archive cascade (OrchestrationCore §6.1): a plain session that has
	// spawned child agents (team_delegate / host.agents children) will have those
	// children cascade-archived server-side. Enumerate them from the already-
	// loaded live sessions so the user sees what else gets archived before
	// confirming. The goal-archival path (app/api.ts) enumerates affected
	// sessions separately and is intentionally left untouched.
	// Spec acceptance (M1, locked): the modal LISTS the child agents by name —
	// not just a count. Include dormant/persisted children (the server route
	// enumerates them).
	let childList: Array<{ id: string; title?: string }> = [];
	if (!(isTeamLead && goalId)) {
		// Prefer the server route (authoritative — includes on-demand / dormant
		// child sessions not yet loaded into state.gatewaySessions); fall back to
		// the already-loaded live sessions if it is unavailable.
		const fromState = () => state.gatewaySessions
			.filter((s) => s.id !== sessionId && (s.delegateOf === sessionId || s.parentSessionId === sessionId))
			.map((s) => ({ id: s.id, title: s.title }));
		try {
			const res = await gatewayFetch(`/api/sessions/${encodeURIComponent(sessionId)}/children-count`);
			if (res.ok) {
				const data = await res.json().catch(() => null) as { count?: number; children?: Array<{ id: string; title?: string }> } | null;
				if (data && Array.isArray(data.children)) childList = data.children;
				else childList = fromState();
			} else {
				childList = fromState();
			}
		} catch {
			childList = fromState();
		}
	}
	const childCount = childList.length;
	let childCascadeNote = "";
	if (childCount > 0) {
		const MAX_NAMED = 5;
		const names = childList.slice(0, MAX_NAMED).map((c) => `"${c.title || "Untitled"}"`);
		const remaining = childCount - names.length;
		const namesText = remaining > 0
			? `${names.join(", ")}, and ${remaining} more`
			: names.length > 1
				? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
				: names[0];
		childCascadeNote = ` This will also archive its ${childCount} child agent${childCount === 1 ? "" : "s"}: ${namesText}.`;
	}
	const confirmed = await confirmAction(
		isTeamLead && goalId ? "End Team" : "Terminate Session",
		isTeamLead && goalId
			? `Are you sure you want to end the team for "${sessionTitle}"? This will dismiss all agents and terminate the team lead.`
			: `Are you sure you want to terminate "${sessionTitle}"? This will end the agent process and cannot be undone.${childCascadeNote}`,
		isTeamLead && goalId ? "End Team" : "Terminate",
		true,
	);
	if (!confirmed) return;

	// Remove from cache if present
	uncacheSession(sessionId);

	if (activeSessionId() === sessionId) {
		state.remoteAgent?.disconnect();
		state.remoteAgent = null;
		state.connectionStatus = "disconnected";
		localStorage.removeItem(GW_SESSION_KEY);
		setHashRoute("landing");
		renderApp();
	}

	if (isTeamLead && goalId) {
		await teardownTeam(goalId);
	} else {
		const res = await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		if (!res.ok && res.status !== 404) {
			throw new Error(`Failed to terminate session: ${res.status}`);
		}
	}
	clearSessionModel(sessionId);
	deleteGoalDraft(sessionId);
	deleteRoleDraft(sessionId);
	deleteProjectDraft(sessionId);
	clearDismissedProposal(sessionId);

	// Clean up provisional project if this was a project assistant session
	if (session?.assistantType === "project" || session?.assistantType === "project-scaffolding") {
		const projectId = session?.projectId;
		if (projectId) {
			const provisionalProject = state.projects.find(p => p.id === projectId && p.provisional);
			if (provisionalProject) {
				try {
					await gatewayFetch(`/api/projects/${projectId}`, { method: "DELETE" });
				} catch (err) {
					console.error("[project-cleanup] Failed to delete provisional project:", err);
				}
			}
		}
	}

	// Clear proposal slots if they belonged to this session.
	for (const type of PROPOSAL_TYPES) {
		if (state.activeProposals[type]?.sessionId === sessionId) delete state.activeProposals[type];
	}
	delete state.projectProposalAcceptedBySessionId[sessionId];

	await refreshSessions();
}


// ============================================================================
// DISCONNECT
// ============================================================================

export function backToSessions(): void {
	flushAndTeardownDraft();
	stopGitStatusPoll();
	const outgoingId = state.selectedSessionId;
	if (outgoingId) abortGitStatusForSession(outgoingId);
	transferActiveSessionToCache(outgoingId);
	state.selectedSessionId = null;
	delete state.activeProposals.goal;
	delete state.activeProposals.role;
	if (state.activeProposals.project) {
		delete state.projectProposalAcceptedBySessionId[state.activeProposals.project.sessionId];
	}
	delete state.activeProposals.project;
	try {
		resetProjectProposalPanel();
	} catch { /* ignore */ }
	state.assistantType = null;
	state.assistantTab = "chat";
	state.assistantHasProposal = false;
	state.isPreviewSession = false;
	state.previewPanelFullscreen = false;
	state.reviewDocuments = new Map();
	state.reviewActiveTab = "";
	state.reviewPanelOpen = false;
	stopPreviewPolling();
	stopInboxSubscription();
	state.cwdDropdownOpen = false;
	localStorage.removeItem(GW_SESSION_KEY);
	state.appView = "authenticated";
	teardownMobileScrollTracking();
	applyProjectPalette(); // Revert to global palette
	setHashRoute("landing");
	renderApp();
	refreshSessions();
}

export function disconnectGateway(): void {
	state.remoteAgent?.disconnect();
	state.remoteAgent = null;
	clearSessionCache();
	state.connectionStatus = "disconnected";
	state.selectedSessionId = null;
	state.assistantType = null;
	state.assistantTab = "chat";
	state.assistantHasProposal = false;
	state.isPreviewSession = false;
	state.previewPanelFullscreen = false;
	state.reviewDocuments = new Map();
	state.reviewActiveTab = "";
	state.reviewPanelOpen = false;
	stopPreviewPolling();
	stopInboxSubscription();
	state.appView = "disconnected";
	localStorage.removeItem(GW_SESSION_KEY);
	teardownMobileScrollTracking();
	applyProjectPalette(); // Revert to global palette
	setHashRoute("landing");
	renderApp();
}

// ============================================================================
// GIT STATUS
// ============================================================================

async function refreshBgProcessesForSession(sessionId: string): Promise<void> {
	const ai = state.chatPanel?.agentInterface;
	if (!ai) return;
	try {
		const res = await gatewayFetch(`/api/sessions/${sessionId}/bg-processes`);
		if (res.ok && activeSessionId() === sessionId) {
			const data = await res.json();
			ai.bgProcesses = data.processes || [];
		}
	} catch { /* ignore */ }
}

/**
 * One-shot REST equivalent of the WS `proposal_update {source:"rehydrate"}`
 * broadcast that fires on auth. Used by the connectToSession fast-path
 * (cached chatPanel reuse) which doesn't trigger a fresh WS auth and
 * therefore never receives the broadcast.
 *
 * Fetches all proposal drafts the server has on disk for the session
 * and dispatches them through the active remoteAgent's `onProposal`
 * handler — same code path as the auth-time rehydrate, so the unified
 * `onProposal` callback in setupSessionSubscription consumes them
 * identically.
 */
/**
 * One-shot REST equivalent of the WS `proposal_update {source:"rehydrate"}`
 * broadcast that fires on auth. Used by the connectToSession fast-path
 * (cached chatPanel reuse) which doesn't trigger a fresh WS auth and
 * therefore never receives the broadcast.
 *
 * Fetches all proposal drafts the server has on disk for the session
 * and dispatches them through the active remoteAgent's `onProposal`
 * handler — same code path as the auth-time rehydrate, so the unified
 * `onProposal` callback in connectToSession consumes them identically.
 */
async function rehydrateProposalsForSession(sessionId: string): Promise<void> {
	if (activeSessionId() !== sessionId) return;
	const remote = state.remoteAgent;
	if (!remote) return;
	try {
		const res = await gatewayFetch(`/api/sessions/${sessionId}/proposals`);
		if (!res.ok) return;
		const body = await res.json() as {
			proposals: Array<{ proposalType: string; fields: Record<string, unknown>; rev: number }>;
		};
		if (activeSessionId() !== sessionId) return;
		const onProposal = remote.onProposal;
		if (!onProposal) return;
		for (const p of body.proposals) {
			if (p.proposalType === "goal" || p.proposalType === "role" || p.proposalType === "staff"
				|| p.proposalType === "project" || p.proposalType === "tool") {
				onProposal(p.proposalType, p.fields, false, p.rev, "rehydrate");
			}
		}
	} catch { /* best-effort */ }
}

async function killBgProcess(sessionId: string, processId: string): Promise<void> {
	try {
		// action=kill terminates the running process but KEEPS the (now terminal) record
		// until the user explicitly dismisses it.
		await gatewayFetch(`/api/sessions/${sessionId}/bg-processes/${processId}?action=kill`, { method: "DELETE" });
		// Refresh the list after kill
		refreshBgProcessesForSession(sessionId);
	} catch { /* ignore */ }
}

async function dismissBgProcess(sessionId: string, processId: string): Promise<void> {
	// Optimistically remove from UI
	const ai = state.chatPanel?.agentInterface;
	if (ai) {
		ai.bgProcesses = ai.bgProcesses.filter((p) => p.id !== processId);
	}
	try {
		// action=dismiss removes the record AND deletes its persisted log/status files,
		// so it never reappears after a subsequent restart.
		await gatewayFetch(`/api/sessions/${sessionId}/bg-processes/${processId}?action=dismiss`, { method: "DELETE" });
	} catch { /* ignore */ }
}

// ── git-status refresh state ─────────────────────────────────────────
/** One in-flight refresh per session. Used for de-dupe + cross-session abort. */
const _gitStatusAborts = new Map<string, AbortController>();
/** Last time (performance.now()) we *started* a refresh for the active session.
 *  Event-driven refreshes bump this so the poll can coalesce and skip ticks. */
let gitStatusLastRefreshAt = 0;
let gitStatusPollTimer: ReturnType<typeof setInterval> | null = null;

function stopGitStatusPoll(): void {
	if (gitStatusPollTimer) {
		clearInterval(gitStatusPollTimer);
		gitStatusPollTimer = null;
	}
}

function startGitStatusPoll(sessionId: string): void {
	stopGitStatusPoll();
	gitStatusPollTimer = setInterval(() => {
		if (activeSessionId() !== sessionId) { stopGitStatusPoll(); return; }
		if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
		const ai = state.chatPanel?.agentInterface;
		if (!ai) return;
		if (isGitWidgetHiddenState(ai.gitRepoKnown)) { stopGitStatusPoll(); return; }
		const elapsed = performance.now() - gitStatusLastRefreshAt;
		if (elapsed < 10_000) return;
		refreshGitStatusForSession(sessionId, { source: "poll" });
	}, 30_000);
}

// Visibility listener — fire an immediate refresh when tab becomes visible,
// covering the case where the tab slept past several poll intervals.
if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		const sid = activeSessionId();
		if (!sid) return;
		const ai = state.chatPanel?.agentInterface;
		if (!ai || isGitWidgetHiddenState(ai.gitRepoKnown)) return;
		refreshGitStatusForSession(sid, { source: "event" });
	});
}

function isGitWidgetHiddenState(value: unknown): boolean {
	return value === "no" || value === "hidden";
}

type GitStatusFile = { file: string; status: string };
type GitStatusRepoEntry = {
	status?: GitStatusFile[];
	statusFiles?: GitStatusFile[];
	clean?: boolean;
	untrackedIncluded?: boolean;
	[key: string]: unknown;
};
type ClientGitStatus = GitStatusData & {
	partial?: boolean;
	untrackedIncluded?: boolean;
	repos?: Record<string, GitStatusRepoEntry>;
};

function isUntrackedStatusFile(file: GitStatusFile): boolean {
	return file.status.includes("?");
}

function mergeStatusFilesPreservingUntracked(summaryFiles: GitStatusFile[] | undefined, fullFiles: GitStatusFile[] | undefined): GitStatusFile[] | undefined {
	if (!fullFiles?.length) return summaryFiles;
	const merged = [...(summaryFiles ?? [])];
	const seen = new Set(merged.map((file) => file.file));
	for (const file of fullFiles) {
		if (!isUntrackedStatusFile(file) || seen.has(file.file)) continue;
		merged.push(file);
		seen.add(file.file);
	}
	return merged.length > 0 ? merged : summaryFiles;
}

function repoFiles(repo: GitStatusRepoEntry | undefined): GitStatusFile[] | undefined {
	return repo?.statusFiles ?? repo?.status;
}

function withUntrackedStatusPreserved(current: ClientGitStatus | undefined, incoming: ClientGitStatus, requestedUntracked: boolean): ClientGitStatus {
	const incomingIncludesUntracked = requestedUntracked || incoming.untrackedIncluded === true;
	if (incomingIncludesUntracked) {
		return { ...incoming, untrackedIncluded: true };
	}
	if (current?.untrackedIncluded !== true) return incoming;

	const mergedStatus = mergeStatusFilesPreservingUntracked(incoming.status, current.status) ?? incoming.status;
	const merged: ClientGitStatus = {
		...incoming,
		status: mergedStatus,
		clean: incoming.clean && mergedStatus.length === 0,
		untrackedIncluded: true,
	};

	if (incoming.repos || current.repos) {
		const repos: Record<string, GitStatusRepoEntry> = { ...(incoming.repos ?? {}) };
		for (const [repoName, currentRepo] of Object.entries(current.repos ?? {})) {
			const incomingRepo = repos[repoName];
			if (!incomingRepo) {
				repos[repoName] = currentRepo;
				continue;
			}
			const mergedRepoFiles = mergeStatusFilesPreservingUntracked(repoFiles(incomingRepo), repoFiles(currentRepo));
			const files = mergedRepoFiles ?? repoFiles(incomingRepo) ?? [];
			repos[repoName] = {
				...incomingRepo,
				...(mergedRepoFiles ? { status: mergedRepoFiles, statusFiles: mergedRepoFiles } : {}),
				clean: incomingRepo.clean === true ? files.length === 0 : incomingRepo.clean,
				untrackedIncluded: true,
			};
		}
		merged.repos = repos;
		merged.clean = merged.clean && !Object.values(repos).some((repo) => (repoFiles(repo)?.length ?? 0) > 0);
	}

	return merged;
}

async function refreshGitStatusForSession(
	sessionId: string,
	opts?: { fetch?: boolean; untracked?: boolean; quiet?: boolean; source?: "event" | "poll" | "user" },
): Promise<void> {
	const ai = state.chatPanel?.agentInterface;
	if (!ai) return;

	// De-dupe: if a refresh is already in flight for this session, skip.
	// (Dropdown "untracked" refetch is allowed to proceed — it's a different shape.)
	if (_gitStatusAborts.has(sessionId) && !opts?.untracked) return;

	// Abort any prior controller for this session before starting fresh.
	const prev = _gitStatusAborts.get(sessionId);
	if (prev) prev.abort();
	const ctl = new AbortController();
	_gitStatusAborts.set(sessionId, ctl);

	// Quiet recheck: for a session cached as git-less/empty (gitRepoKnown ===
	// 'no' or 'hidden'), run the refresh silently in the background — do NOT flip
	// gitStatusLoading (which would render the "Checking git…" skeleton) and do
	// NOT reveal the widget while it stays hidden. Only showable content reveals it.
	// The loading/visibility/persistence rules live in the DI-friendly
	// `runWidgetGitRefresh` (git-status-refresh.ts) so they can be unit-tested.
	gitStatusLastRefreshAt = performance.now();
	let errorAttempts = 0;

	await runWidgetGitRefresh(ai as unknown as GitWidgetLike, {
		signal: ctl.signal,
		quiet: opts?.quiet === true,
		fetch: async (signal) => {
			const result = await fetchGitStatus(sessionId, {
				fetch: opts?.fetch,
				untracked: opts?.untracked,
				signal,
			});
			if (result.kind === "error") errorAttempts++;
			return result;
		},
		sleep: abortableSleep,
		isStale: () => activeSessionId() !== sessionId,
		applyOk: (widget, data) => {
			const next = withUntrackedStatusPreserved(widget.gitStatus as ClientGitStatus | undefined, data as ClientGitStatus, !!opts?.untracked);
			widget.gitStatus = next;
			widget.partial = !!next.partial;
			if (next.branch) widget.branch = next.branch;
		},
		onCache: (repoState) => setCachedRepoState(sessionId, repoState),
		onFinally: () => {
			if (_gitStatusAborts.get(sessionId) === ctl) _gitStatusAborts.delete(sessionId);
		},
	});

	// Final give-up with no showable data is cached as hidden by runWidgetGitRefresh.
	// Keep the old retry-exhausted diagnostic without warning for clean empty OKs
	// or one-shot quiet hidden rechecks.
	if (activeSessionId() === sessionId && errorAttempts >= GIT_STATUS_BACKOFF_MS.length && ai.gitRepoKnown === "hidden" && !ai.gitStatus && !ctl.signal.aborted) {
		console.warn("[git-status] refresh failed after retries", { sessionId });
	}

	refreshPrStatusForSession(sessionId);
}

/** Export for UI event wiring — callable from outside this module (dropdown open). */
export function requestGitStatusUntrackedRefetch(sessionId: string): void {
	// Match pill open: fetch remotes and full untracked details together to avoid
	// the paired event abort race.
	refreshGitStatusForSession(sessionId, { fetch: true, untracked: true, source: "user" });
}

/** Abort and drop any in-flight refresh for `sessionId`. Called on session switch / disconnect. */
function abortGitStatusForSession(sessionId: string): void {
	const ctl = _gitStatusAborts.get(sessionId);
	if (ctl) {
		ctl.abort();
		_gitStatusAborts.delete(sessionId);
	}
}

async function refreshPrStatusForSession(sessionId: string): Promise<void> {
	const sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
	const goalId = sessionData?.goalId;

	// Build the URL: goal-scoped if available, otherwise session-scoped
	const prStatusUrl = goalId
		? `/api/goals/${goalId}/pr-status?optional=1`
		: `/api/sessions/${sessionId}/pr-status?optional=1`;

	const ai = state.chatPanel?.agentInterface;
	if (!ai) return;

	try {
		const res = await gatewayFetch(prStatusUrl).catch(() => null);
		if (!res || res.status === 204 || !res.ok) {
			if (activeSessionId() === sessionId) {
				ai.prState = undefined;
				ai.prUrl = undefined;
				ai.prNumber = undefined;
				ai.prTitle = undefined;
				ai.prMergeable = undefined;
				ai.viewerIsAdmin = undefined;
				ai.viewerCanMergeAsAdmin = undefined;
				ai.reviewDecision = undefined;
				ai.headRefName = undefined;
			}
			return;
		}
		const data = await res.json();
		if (activeSessionId() === sessionId) {
			ai.prState = data.state;
			ai.prUrl = data.url;
			ai.prNumber = data.number;
			ai.prTitle = data.title;
			ai.prMergeable = data.mergeable;
			ai.viewerIsAdmin = data.viewerIsAdmin ?? false;
			ai.viewerCanMergeAsAdmin = data.viewerCanMergeAsAdmin ?? false;
			ai.reviewDecision = data.reviewDecision ?? undefined;
			ai.headRefName = data.headRefName ?? undefined;
		}
		// Update goal grouping cache so sidebar reflects the new PR state immediately
		if (goalId && data.state) {
			state.prStatusCache.set(goalId, { state: data.state, url: data.url, number: data.number, reviewDecision: data.reviewDecision ?? null, mergeable: data.mergeable, viewerCanMergeAsAdmin: data.viewerCanMergeAsAdmin ?? false });
			renderApp();
		}
	} catch {
		if (activeSessionId() === sessionId) {
			ai.prState = undefined;
			ai.prUrl = undefined;
			ai.prNumber = undefined;
			ai.prTitle = undefined;
			ai.prMergeable = undefined;
			ai.viewerIsAdmin = undefined;
			ai.viewerCanMergeAsAdmin = undefined;
			ai.reviewDecision = undefined;
			ai.headRefName = undefined;
		}
	}
}

// ============================================================================
// RE-ATTEMPT FLOW
// ============================================================================

export async function startReattempt(goalId: string): Promise<void> {
	if (state.creatingSession) return;
	// Pre-fill preview project/cwd from the original goal so the proposal panel
	// binds to the correct project immediately and avoids a brief
	// "No project selected for this goal" flash on connect.
	const goal = state.goals.find(g => g.id === goalId);
	const project = goal ? state.projects.find(p => p.id === goal.projectId) : undefined;
	state.creatingSession = true;
	if (goal && goal.projectId) state.previewProjectId = goal.projectId;
	if (project && !state.previewCwdEdited) state.previewCwd = project.rootPath;
	renderApp();
	try {
		const body: Record<string, unknown> = {
			assistantType: "goal",
			reattemptGoalId: goalId,
		};
		if (goal?.projectId) body.projectId = goal.projectId;
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({} as any));
			const err = new Error((data && data.error) || `Session creation failed: ${res.status}`);
			(err as any).code = data?.code;
			(err as any).stack = data?.stack || (err as any).stack;
			throw err;
		}
		const { id } = await res.json();
		// Clear creatingSession before connecting — connectToSession handles its
		// own loading state via connectingSessionId, and we want the user to see
		// the chat panel (with textarea) immediately, not a loading spinner.
		state.creatingSession = false;
		await connectToSession(id, false, { assistantType: "goal" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const code = err && typeof err === "object" ? (err as any).code : undefined;
		const stack = err instanceof Error ? err.stack : undefined;
		showConnectionError("Failed to re-attempt goal", msg, { code, stack });
	} finally {
		state.creatingSession = false;
		renderApp();
	}
}
