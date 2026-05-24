import { ChatPanel } from "../ui/index.js";
import { removePanelWorkspaceTabs, selectPanelWorkspaceTab, selectProposalWorkspaceTab, startPreviewPolling, stopPreviewPolling } from "./preview-panel.js";
import { startInboxSubscription, stopInboxSubscription } from "./inbox-panel.js";
import type { ConnectionStatus } from "./remote-agent.js";
import { RemoteAgent } from "./remote-agent.js";
import {
	state,
	renderApp,
	setProjects,
	activeSessionId,
	isDesktop,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	GW_SESSION_KEY,
} from "./state.js";
import { gatewayFetch, saveDraftToServer, loadDraftFromServer, deleteDraftFromServer, refreshSessions, startSessionPolling, updateLocalSessionTitle, updateLocalSessionStatus, fetchGitStatus, refreshPrStatusCache, teardownTeam } from "./api.js";
import { errorDetails } from "./error-helpers.js";
import { runGitStatusRefresh, abortableSleep } from "./git-status-refresh.js";
import { startTimeRefresh } from "./render-helpers.js";
import { getRouteFromHash, setHashRoute, saveSessionModel, loadSessionModel, clearSessionModel, isConfigPageRoute } from "./routing.js";
import { sessionHueRotation, ACCESSORY_IDS } from "./session-colors.js";
import { showConnectionError, confirmAction, checkOAuthStatus, openOAuthDialog } from "./dialogs-lazy.js";
import { teardownMobileScrollTracking } from "./mobile-header.js";
import { storage } from "./storage.js";
import { markSessionVisited } from "./render-helpers.js";
import { showHeaderToast } from "./render.js";
import { setSelectedWorkflowId, showProposalToast, resetProposalAnnCount } from "./proposal-panels-lazy.js";
import { clearProposalAnnotations } from "../ui/components/review/proposal-annotations.js";
import { buildProjectConfigDiff } from "./project-proposal-diff.js";
// settings-page is dynamic-imported lazily below to keep it out of the main chunk.
// See docs/design/ui-bundle-size-reduction.md (Task A).
async function invalidateProjectScopeConfig(projectId: string): Promise<void> {
	const m = await import("./settings-page.js");
	m.invalidateProjectScopeConfig(projectId);
}
import {
	isProposalDismissed as isProposalDismissedTyped,
	markProposalDismissed as markProposalDismissedTyped,
	clearProposalDismissed as clearProposalDismissedTyped,
} from "./proposal-helpers.js";
import { PROPOSAL_TYPE_REGISTRY, PROPOSAL_TYPES, isProposalType, revealProposalPanel, type ProposalType, type ProposalSlot } from "./proposal-registry.js";
import {
	CHAT_PANEL_TAB_ID,
	activePanelTabIdForSession,
	firstContentPanelTab,
	isHistoricalProposalTab,
	panelTabsForSession,
	proposalPanelTabId,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";

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

function projectRootForSession(sessionId: string): string {
	const session = state.gatewaySessions.find(s => s.id === sessionId)
		|| state.archivedSessions.find(s => s.id === sessionId);
	let projectId = session?.projectId;
	const activeId = activeSessionId();
	if (!projectId && (sessionId === activeId || sessionId === state.selectedSessionId || sessionId === state.remoteAgent?.gatewaySessionId)) {
		projectId = state.chatPanel?.agentInterface?.projectId;
	}
	if (!projectId) return "";
	return state.projects.find(p => p.id === projectId)?.rootPath || "";
}

function proposalCwdOrProjectRoot(proposalCwd: unknown, sessionId: string): string {
	const cwd = typeof proposalCwd === "string" ? proposalCwd : "";
	return cwd.trim() ? cwd : projectRootForSession(sessionId);
}

function resetStaffProposalPreview(sessionId: string): void {
	state.staffPreviewName = "";
	state.staffPreviewDescription = "";
	state.staffPreviewPrompt = "";
	state.staffPreviewTriggers = "[]";
	state.staffPreviewCwd = projectRootForSession(sessionId);
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

/** Resolve provisional/registered mode for a project proposal slot from the
 *  current session→project mapping. Extracted for the unified onProposal
 *  callback (Slice E gap-closure). Returns "provisional" if no project is
 *  registered yet (fresh project assistant flow). */
function resolveProjectMode(sessionId: string): "provisional" | "registered" {
	const session = state.gatewaySessions.find(s => s.id === sessionId);
	const project = state.projects.find(p => p.id === session?.projectId);
	return project?.provisional ? "provisional" : "registered";
}

function isAssistantProposalType(type: ProposalType): boolean {
	return state.assistantType === type || (type === "project" && state.assistantType === "project-scaffolding");
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

function liveProposalSlotForSession(type: ProposalType, sessionId: string): ProposalSlot | undefined {
	const slot = state.activeProposals[type];
	if (!slot) return undefined;
	if (slot.sessionId && slot.sessionId !== sessionId) return undefined;
	return slot;
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
		hasReceivedProposal: state.assistantHasProposal,
		goalAssistantTab: state.assistantTab,
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
			if (isProposalDismissedTyped(_sessionId, "goal", fields)) {
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
		} else {
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
			state.assistantHasProposal = false;
		} else {
			state.previewTitle = draft.previewTitle ?? "";
			state.previewSpec = draft.previewSpec ?? "";
			state.previewCwd = draft.previewCwd ?? "";
			state.previewProjectId = draft.previewProjectId ?? "";
			state.previewTitleEdited = draft.previewTitleEdited ?? false;
			state.previewSpecEdited = draft.previewSpecEdited ?? false;
			state.previewCwdEdited = draft.previewCwdEdited ?? false;
			state.assistantHasProposal = draft.hasReceivedProposal ?? false;
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
	serialize: (sessionId) => ({
		sessionId,
		activeProjectProposal: state.activeProposals.project ?? undefined,
		hasReceivedProposal: state.assistantHasProposal,
		assistantTab: state.assistantTab,
		accepted: state.projectProposalAcceptedBySessionId[sessionId] ?? false,
	}),
	restore: (_sessionId, draft: any) => {
		let dismissed = false;
		if (draft.activeProjectProposal) {
			const p = draft.activeProjectProposal as any;
			const fields = (p.fields ?? {}) as Record<string, unknown>;
			if (isProposalDismissedTyped(_sessionId, "project", fields)) {
				delete state.activeProposals.project;
				dismissed = true;
			} else {
				state.activeProposals.project = {
					sessionId: p.sessionId,
					fields,
					mode: p.mode,
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
	if (!healthData.localhost && !healthData.aigw) {
		const hasAuth = await checkOAuthStatus();
		if (!hasAuth) {
			const success = await openOAuthDialog();
			if (!success) throw new Error("OAuth login required");
		}
	}

	state.appView = "authenticated";
	const route = getRouteFromHash();
	if (route.view !== "session" && route.view !== "goal-dashboard" && !isConfigPageRoute()) {
		setHashRoute("landing");
	}
	renderApp();
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
	if (val.trim()) {
		const controller = new AbortController();
		_draftAbort = controller;
		const gen = ++_draftGen;
		return _trackPendingDraftSave(
			saveDraftToServer(sid, 'prompt', { text: val, gen }, controller.signal)
				.finally(() => {
					if (_draftAbort === controller) _draftAbort = null;
				}),
		);
	}
	return _trackPendingDraftSave(deleteDraftFromServer(sid, 'prompt'));
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
			const gen = ++_draftGen;
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
		const gen = ++_draftGen;
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
	// Start _draftGen above _draftSendGen so new saves are never rejected as
	// stale. _teardownDraftHandlers resets _draftGen to 0, but _draftSendGen
	// persists in sessionStorage — without this, new drafts after a session
	// switch get gen=1 which is <= sendGen, causing them to be silently
	// discarded on load (PI-04b).
	_draftGen = _draftSendGen;
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
			// Only apply if we're still on the same session and the user has not
			// typed since binding. This closes the first-paint window where the
			// editor can be visible before slower REST hydration completes.
			if (_draftSessionId !== sessionId || _draftTouchedSinceBind) return;

			// Handle both old format (plain string) and new format ({ text, gen })
			let text: string | null = null;
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

	// Cache the outgoing session's panel + agent for fast switch-back
	const outgoingId = state.selectedSessionId;
	if (outgoingId && outgoingId !== sessionId && state.chatPanel && state.remoteAgent?.connected) {
		cacheSession(outgoingId, state.chatPanel, state.remoteAgent);
		// Don't disconnect — the cached agent stays connected
		state.remoteAgent = null;
		state.connectionStatus = "disconnected";
	} else {
		// No cache — disconnect normally
		if (state.remoteAgent) {
			state.remoteAgent.disconnect();
			state.remoteAgent = null;
			state.connectionStatus = "disconnected";
		}
	}

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

	// Fade out the current chat panel instantly
	if (state.chatPanel) {
		state.chatPanel.classList.add("session-fade-out");
	}

	// Clear the old chat panel so the render never shows stale messages
	// from the previous session while connecting to the new one.
	state.chatPanel = null;
	state.cwdDropdownOpen = false;

	// Update hash route synchronously
	setHashRoute("session", sessionId, replaceHistory);

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

export async function connectToSession(sessionId: string, isExisting: boolean, options?: { isGoalAssistant?: boolean; isRoleAssistant?: boolean; isToolAssistant?: boolean; isStaffAssistant?: boolean; isPreview?: boolean; assistantType?: string; readOnly?: boolean; projectDirPath?: string; projectEditContext?: { name: string; rootPath: string }; onMissing?: "toast" | "modal" }): Promise<void> {
	// Capture the current route BEFORE selectSession changes the hash.
	const startingRoute = getRouteFromHash();
	const replaceHistory = startingRoute.view === "goal-dashboard";

	// Phase 1: synchronous select
	selectSession(sessionId, replaceHistory);

	// Fast path: reuse cached session (instant switch-back)
	const cached = getCachedSession(sessionId);
	if (cached && isExisting) {
		sessionCache.delete(sessionId); // Take ownership
		state.chatPanel = cached.chatPanel;
		state.remoteAgent = cached.remoteAgent;
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
		// Restore previewProjectId from the session record on fast-path switch-back.
		// The draft-restore on the slow path has a matching fallback at ~line 1488;
		// without this, clicking "Create Goal" in the proposal form after switching
		// away and back to a goal-assistant session fails with "Select a project…".
		state.previewProjectId = sessionData?.projectId || "";
		state.previewTitleEdited = false;
		state.previewSpecEdited = false;
		state.previewCwdEdited = false;
		state.isPreviewSession = sessionData?.preview || false;
		state.previewPanelMtime = 0;
		state.previewPanelEntry = "";
		state.previewPanelContentHash = "";
		state.reviewDocuments = new Map();
		state.reviewActiveTab = "";
		state.reviewPanelOpen = false;
		state.inboxEntries = [];
		if (state.isPreviewSession) startPreviewPolling();
		else stopPreviewPolling();
		if (sessionData?.staffId) startInboxSubscription(sessionId, sessionData.staffId);
		else stopInboxSubscription();

		// Mark as visited so unseen indicators clear
		markSessionVisited(sessionId);

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

		// Reset tri-state on cached switch-back (last-known data still rendered).
		if (state.chatPanel?.agentInterface) {
			(state.chatPanel.agentInterface as any).gitRepoKnown = "unknown";
		}
		// Refresh git status and bg processes (lightweight, fire-and-forget)
		refreshGitStatusForSession(sessionId);
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
		rehydrateProposalsForSession(sessionId).catch((err) => {
			console.warn("[session-manager] proposal rehydrate failed:", err);
		});

		// Restore goal/role/project assistant draft state. The slow path
		// runs these inside its draft-restore promise; the fast path skipped
		// them which left state.previewSpec / state.rolePreviewPrompt empty
		// after switch-away/back, breaking the assistant preview panel
		// (and inline-comment annotation anchoring against an empty body).
		if (state.assistantType === "goal") {
			restoreGoalDraft(sessionId).catch((err) => {
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

		// Start model restore in parallel with WebSocket connect
		const modelRestorePromise = (async () => {
			const savedModel = loadSessionModel(sessionId);
			if (!savedModel) return null;
			try {
				const { getModel } = await import("@earendil-works/pi-ai");
				return getModel(savedModel.provider as any, savedModel.modelId);
			} catch {
				return null; // Model no longer available
			}
		})();

		await remote.connect(url, token, sessionId);
		if (isStale()) { remote.disconnect(); return; }

		// Auto-prompt for new assistant sessions — fire IMMEDIATELY after connect
		// before any draft-restore awaits that could yield and race
		const AUTO_PROMPTS: Record<string, string> = {
			goal: "Start the goal creation session.",
			role: "Start the role creation session.",
			tool: "Start the tool assistant session. Help me document, improve, or create tools.",
			staff: "Start the staff agent creation session.",
			setup: "Start the project setup session.",
		};
		if (options?.assistantType && !isExisting) {
			let autoPrompt: string | undefined;
			if (options.assistantType === "project" && options.projectEditContext) {
				const pec = options.projectEditContext;
				autoPrompt = `Edit the existing project '${pec.name}' at ${pec.rootPath}. Read its current \`.bobbit/config/project.yaml\` and propose it back as-is via \`propose_project\`, then ask the user what they want to change or add.`;
			} else if (options.assistantType === "project" && options.projectDirPath) {
				autoPrompt = `Start the project registration session. The project directory is: ${options.projectDirPath}`;
			} else if (options.assistantType === "project-scaffolding" && options.projectDirPath) {
				autoPrompt = `Start the new project setup session. The target directory is: ${options.projectDirPath}`;
			} else {
				autoPrompt = AUTO_PROMPTS[options.assistantType];
			}
			if (autoPrompt) remote.prompt(autoPrompt);
		}

		// Apply restored model (already resolved or resolving in parallel)
		const restoredModel = await modelRestorePromise;
		if (isStale()) { remote.disconnect(); return; }
		if (restoredModel) {
			remote.setModel(restoredModel);
		}

		// Intercept setModel to persist
		const originalSetModel = remote.setModel.bind(remote);
		remote.setModel = (model: any) => {
			originalSetModel(model);
			if (model?.provider && model?.id) {
				saveSessionModel(sessionId, model.provider, model.id);
			}
			renderApp();
		};

		// Callbacks
		remote.onTitleChange = (newTitle: string) => {
			updateLocalSessionTitle(sessionId, newTitle);
		};

		remote.onStatusChange = (status: string) => {
			updateLocalSessionStatus(sessionId, status);
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
			try { refreshGitStatusForSession(sessionId); } catch { /* ignore */ }
			try { refreshBgProcessesForSession(sessionId); } catch { /* ignore */ }
			try {
				const { initAnnotationStore } = await import("../ui/components/review/AnnotationStore.js");
				initAnnotationStore(sessionId).catch(() => { /* best-effort */ });
			} catch { /* AnnotationStore module load failed — keep going */ }
		};

		// Server broadcasts session_removed when ANY session is terminated/archived/
		// purged. Update local lists instantly instead of waiting for the 5s
		// refreshSessions tick. If the removed session is the one we're viewing,
		// route to landing.
		remote.onSessionRemoved = (removedId: string, _reason: string) => {
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
				ai.bgProcesses = ai.bgProcesses.map((p) =>
					p.id === msg.processId
						? { ...p, status: "exited" as const, exitCode: msg.exitCode ?? null, endTime: typeof msg.endTime === "number" ? msg.endTime : p.endTime ?? null }
						: p
				);
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
					const res = await gatewayFetch(`/api/goals/${goalId}/pr-status`);
					if (res.ok) {
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
					isProposalDismissedTyped(sessionId, "goal", proposal as unknown as Record<string, unknown>)
				) {
					return;
				}
				if (!state.previewTitleEdited) state.previewTitle = proposal.title;
				if (!state.previewCwdEdited && proposal.cwd) state.previewCwd = proposal.cwd;
				if (!state.previewSpecEdited) state.previewSpec = proposal.spec;
				if (proposal.workflow) setSelectedWorkflowId(proposal.workflow);
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
		//   • `proposal_update` from edit_proposal broadcasts hits the UI.
		//   • `proposal_update {source: "rehydrate"}` on WS attach restores the panel
		//     across server restarts.
		//   • `proposal_cleared` after DELETE clears the in-memory slot.
		// The legacy callbacks still own the bespoke side-effects (project mode
		// resolution, goal title summarisation, workflow JSON parse → populateFromProposal,
		// per-type form-mirror state). The plugin.mergeFields shallow-merge guarantees
		// the second invocation per propose_* tool-use is idempotent.
		remote.onProposal = (type, fields, _streaming, serverRev?: number) => {
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
			const merged = plugin.mergeFields(prev?.fields ?? {}, fields);
			const isFirstEmit = prev == null;
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
			// First-emit dismissal short-circuit — generalised from the goal-only
			// check at session-manager.ts:1062. Skip this only when (a) it's the
			// very first emit for this slot AND (b) the user previously dismissed
			// an identical-fingerprint proposal of this type.
			if (isFirstEmit && isProposalDismissedTyped(sessionId, type, merged)) {
				return;
			}
			// Server-stamped rev (from proposal_update events) is the source of truth.
			// Streaming/final tool-use scans are only an in-memory preview path; they
			// must never synthesize revision numbers or a streamed proposal can race
			// ahead of the immutable snapshot counter and make the current tool card
			// look stale. Legacy no-rev paths keep the existing rev (or 0 = unknown).
			const nextRev = (typeof serverRev === "number" && serverRev > 0)
				? Math.trunc(serverRev)
				: (prev?.rev ?? 0);
			const slot: ProposalSlot = {
				sessionId,
				fields: merged,
				streaming: false,
				mode: type === "project"
					? (prev?.mode ?? resolveProjectMode(sessionId))
					: undefined,
				rev: nextRev,
			};
			state.activeProposals[type] = slot;
			state.assistantHasProposal = true;
			if (type === "project") {
				delete state.projectProposalAcceptedBySessionId[sessionId];
			}
			const isMatchingAssistant = isAssistantProposalType(type);
			if (isFirstEmit) {
				plugin.onFirstEmit(slot, {
					isAssistant: isMatchingAssistant,
					isMobile: !isDesktop(),
				});
				if (state.assistantType && !isMatchingAssistant && !isDesktop()) {
					state.assistantTab = "preview";
				}
			} else {
				// Side-panel tab contract: "Agent-driven events may create/update a
				// tab and make it active." When a proposal is updated (not just
				// created), re-focus its existing side-pane tab in place. The id
				// upsert merges into the existing tab row without reordering, so
				// preview/review tabs keep their visible positions.
				revealProposalPanel(type, { sessionId }, {
					isAssistant: isMatchingAssistant,
					isMobile: !isDesktop(),
				});
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
					remote.onProposal(type, liveFields, false, liveRev);
				}
			};

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
					const { readProposalSnapshot } = await import("./api.js");
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
				refreshGitStatusForSession(sessionId, { untracked: true, source: "user" });
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

		// ── Fire requestMessages() early so the network roundtrip overlaps
		// with draft restores and refreshSessions below. Proposal checking
		// is deferred so incoming messages won't fill form state before
		// draft restores have a chance to run.
		if (isExisting) {
			remote.deferProposalCheck();
			remote.requestMessages();
		}

		// Initial git status and bg process fetch (fire-and-forget)
		refreshGitStatusForSession(sessionId);
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
				if (!restored) {
					state.assistantTab = "chat";
					state.previewTitle = "";
					state.previewCwd = "";
					state.previewSpec = "";
					state.previewTitleEdited = false;
					state.previewCwdEdited = false;
					state.previewSpecEdited = false;
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
		const body: any = {};
		if (goalId) body.goalId = goalId;
		if (roleId) body.roleId = roleId;
		if (cwd) body.cwd = cwd;
		if (worktree !== undefined) body.worktree = worktree;
		if (sandboxed) body.sandboxed = true;
		if (projectId) body.projectId = projectId;
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
	const confirmed = await confirmAction(
		isTeamLead && goalId ? "End Team" : "Terminate Session",
		isTeamLead && goalId
			? `Are you sure you want to end the team for "${sessionTitle}"? This will dismiss all agents and terminate the team lead.`
			: `Are you sure you want to terminate "${sessionTitle}"? This will end the agent process and cannot be undone.`,
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
// PROJECT PROPOSAL ACCEPTANCE
// ============================================================================

export async function acceptProjectProposal(): Promise<void> {
	const proposal = state.activeProposals.project;
	if (!proposal) return;
	if (proposal.mode === "registered") {
		return acceptRegisteredProjectProposal();
	}
	return acceptProvisionalProjectProposal();
}

async function acceptProvisionalProjectProposal(): Promise<void> {
	const proposal = state.activeProposals.project;
	if (!proposal) return;
	const { fields, sessionId: propSessionId } = proposal;

	// Find the provisional project for this session
	const session = state.gatewaySessions.find(s => s.id === propSessionId);
	const projectId = session?.projectId;
	if (!projectId) return;

	const { promoteProject, fetchProjects, gatewayFetch } = await import("./api.js");

	// Promote the provisional project
	const promoted = await promoteProject(projectId, typeof fields.name === "string" ? fields.name : "");
	if (!promoted) return;

	// Write config fields. Forward every proposed field — including structured
	// `components` / `workflows` — to the config endpoint via the shared
	// `buildProjectConfigDiff` helper. Mirrors the registered-mode accept path
	// so the provisional accept doesn't silently drop the assistant's proposed
	// workflows and components. Per-component QA config (`config.qa_start_command`
	// etc.) rides through inside `components[].config`.
	const diff = buildProjectConfigDiff(fields as Record<string, unknown>);
	if (Object.keys(diff).length > 0) {
		try {
			const res = await gatewayFetch(`/api/projects/${projectId}/config`, {
				method: 'PUT',
				body: JSON.stringify(diff),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const details = Array.isArray(data?.details) && data.details.length > 0
					? data.details.map((d: any) => d?.message ?? String(d)).join("\n")
					: "";
				const { showConnectionError } = await import("./dialogs.js");
				showConnectionError(
					data?.error || `Config write failed (${res.status})`,
					details || (data?.error ?? ""),
					{ code: data?.code, stack: data?.stack },
				);
				return;
			}
		} catch (err) {
			console.error('[project-proposal] Config write error:', err);
		}
	}

	// Refresh
	setProjects(await fetchProjects());
	// Settings page caches /api/projects/:id/config{,/resolved} per-project; the
	// PUT above bypassed it, so invalidate explicitly to keep the Settings tab
	// coherent without forcing the user to hard-reload.
	invalidateProjectScopeConfig(projectId);
	delete state.activeProposals.project;
	state.assistantHasProposal = false;
	if (proposal.sessionId) {
		deleteProjectDraft(proposal.sessionId);
		// Slice E: drop the on-disk proposal file once accepted.
		const { deleteProposalFile } = await import("./proposal-helpers.js");
		void deleteProposalFile(proposal.sessionId, "project");
	}

	// Terminate the project assistant session silently (no confirmation dialog)
	await terminateProjectAssistantSession(propSessionId);
}

/**
 * Tear down a project-assistant session: disconnect, DELETE on the server,
 * remove from local state, clean drafts, navigate to landing. Used by the
 * provisional accept path (silently) and by the registered-mode "Terminate
 * Project Assistant" button after Apply Changes.
 */
export async function terminateProjectAssistantSession(sessionId: string): Promise<void> {
	const { gatewayFetch } = await import("./api.js");
	try {
		uncacheSession(sessionId);
		if (activeSessionId() === sessionId) {
			state.remoteAgent?.disconnect();
			state.remoteAgent = null;
		}
		// DELETE /api/sessions/:id terminates (live) or purges (archived).
		const res = await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
		if (!res.ok && res.status !== 404) {
			console.warn(`[project-proposal] Terminate returned ${res.status}`);
		}
		// Optimistically remove the assistant session from local state.
		state.gatewaySessions = state.gatewaySessions.filter(s => s.id !== sessionId);
		renderApp();
		deleteGoalDraft(sessionId);
		deleteRoleDraft(sessionId);
		deleteProjectDraft(sessionId);
		delete state.projectProposalAcceptedBySessionId[sessionId];
		await refreshSessions();
		setHashRoute("landing");
	} catch (err) {
		console.error('[project-proposal] Failed to terminate assistant session:', err);
	}
	renderApp();
}



/** Registered-mode accept: apply the proposal's full config payload to the
 *  live project without terminating or navigating away. The server diffs
 *  against persisted state — we just send everything the proposal carries. */
async function acceptRegisteredProjectProposal(): Promise<void> {
	const proposal = state.activeProposals.project;
	if (!proposal) return;
	const { fields, sessionId: propSessionId } = proposal;
	const session = state.gatewaySessions.find(s => s.id === propSessionId);
	const projectId = session?.projectId;
	if (!projectId) return;

	const { gatewayFetch, fetchProjects } = await import("./api.js");
	const fieldNameStr = typeof fields.name === "string" ? fields.name : "";

	// 1. Rename via PUT /api/projects/:id if a name is supplied.
	if (fieldNameStr) {
		try {
			await gatewayFetch(`/api/projects/${projectId}`, {
				method: "PUT",
				body: JSON.stringify({ name: fieldNameStr }),
			});
		} catch (err) {
			console.error('[project-proposal] Rename failed:', err);
		}
	}

	// 2. Send all proposal fields to the config endpoint. Server diffs against
	//    persisted state; empty/null values are skipped client-side. Native-YAML
	//    migrated fields ride through as structured payloads (server rejects
	//    JSON-encoded strings) — parse if the agent supplied them as a string.
	const diff = buildProjectConfigDiff(fields as Record<string, unknown>);
	if (Object.keys(diff).length > 0) {
		try {
			const res = await gatewayFetch(`/api/projects/${projectId}/config`, {
				method: 'PUT',
				body: JSON.stringify(diff),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				const details = Array.isArray(data?.details) && data.details.length > 0
					? data.details.map((d: any) => d?.message ?? String(d)).join("\n")
					: "";
				const { showConnectionError } = await import("./dialogs.js");
				showConnectionError(
					data?.error || `Config write failed (${res.status})`,
					details || (data?.error ?? ""),
					{ code: data?.code, stack: data?.stack },
				);
				return;
			}
		} catch (err) {
			console.error('[project-proposal] Config write error:', err);
		}
	}

	// 3. Refresh projects list; clear proposal; stay connected.
	try { setProjects(await fetchProjects()); } catch { /* ignore */ }
	// Invalidate the Settings page's per-project config cache so its tab picks
	// up the just-applied changes the next time it renders (no hard reload).
	invalidateProjectScopeConfig(projectId);
	state.projectProposalAcceptedBySessionId[propSessionId] = true;
	delete state.activeProposals.project;
	state.assistantHasProposal = false;
	// Persist the accepted flag in the on-disk draft so it survives reload.
	saveProjectDraft(propSessionId);
	// Slice E: drop the on-disk proposal file once accepted.
	const { deleteProposalFile } = await import("./proposal-helpers.js");
	void deleteProposalFile(propSessionId, "project");
	renderApp();
}

// ============================================================================
// DISCONNECT
// ============================================================================

export function backToSessions(): void {
	state.remoteAgent?.disconnect();
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
	state.selectedSessionId = null;
	delete state.activeProposals.goal;
	delete state.activeProposals.role;
	if (state.activeProposals.project) {
		delete state.projectProposalAcceptedBySessionId[state.activeProposals.project.sessionId];
	}
	delete state.activeProposals.project;
	void (async () => {
		try {
			const { resetProjectProposalPanel } = await import("./proposal-panels-lazy.js");
			resetProjectProposalPanel();
		} catch { /* ignore */ }
	})();
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
				onProposal(p.proposalType, p.fields, false, p.rev);
			}
		}
	} catch { /* best-effort */ }
}

async function killBgProcess(sessionId: string, processId: string): Promise<void> {
	try {
		await gatewayFetch(`/api/sessions/${sessionId}/bg-processes/${processId}`, { method: "DELETE" });
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
		await gatewayFetch(`/api/sessions/${sessionId}/bg-processes/${processId}`, { method: "DELETE" });
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
		if ((ai as any).gitRepoKnown === "no") { stopGitStatusPoll(); return; }
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
		if (!ai || (ai as any).gitRepoKnown === "no") return;
		refreshGitStatusForSession(sid, { source: "event" });
	});
}

async function refreshGitStatusForSession(
	sessionId: string,
	opts?: { fetch?: boolean; untracked?: boolean; source?: "event" | "poll" | "user" },
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

	ai.gitStatusLoading = true;
	gitStatusLastRefreshAt = performance.now();

	await runGitStatusRefresh(ctl.signal, {
		fetch: (signal) => fetchGitStatus(sessionId, {
			fetch: opts?.fetch,
			untracked: opts?.untracked,
			signal,
		}),
		sleep: abortableSleep,
		isStale: () => activeSessionId() !== sessionId,
		onOk: (data) => {
			if (activeSessionId() !== sessionId) return;
			ai.gitStatus = data as any;
			ai.partial = !!(data as any).partial;
			(ai as any).gitRepoKnown = "yes";
			if ((data as any).branch) ai.branch = (data as any).branch;
		},
		onNotARepo: () => {
			if (activeSessionId() !== sessionId) return;
			(ai as any).gitRepoKnown = "no";
			ai.gitStatus = undefined;
		},
		onFinally: () => {
			if (_gitStatusAborts.get(sessionId) === ctl) _gitStatusAborts.delete(sessionId);
			if (activeSessionId() !== sessionId) return;
			ai.gitStatusLoading = false;
			// Final give-up (4 errors in a row) — leave gitRepoKnown unchanged,
			// leave last-known data in place, log once.
			if ((ai as any).gitRepoKnown === "unknown" && !ai.gitStatus) {
				// Only warn on a full miss; successful attempts short-circuit earlier.
				// Note: we only reach here if all attempts errored or were aborted.
				if (!ctl.signal.aborted) {
					console.warn("[git-status] refresh failed after retries", { sessionId });
				}
			}
		},
	});

	refreshPrStatusForSession(sessionId);
}

/** Export for UI event wiring — callable from outside this module (dropdown open). */
export function requestGitStatusUntrackedRefetch(sessionId: string): void {
	refreshGitStatusForSession(sessionId, { untracked: true, source: "user" });
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
		? `/api/goals/${goalId}/pr-status`
		: `/api/sessions/${sessionId}/pr-status`;

	const ai = state.chatPanel?.agentInterface;
	if (!ai) return;

	try {
		const res = await gatewayFetch(prStatusUrl).catch(() => null);
		if (!res || !res.ok) {
			if (activeSessionId() === sessionId) {
				ai.prState = undefined;
				ai.prUrl = undefined;
				ai.prNumber = undefined;
				ai.prTitle = undefined;
				ai.prMergeable = undefined;
				ai.viewerIsAdmin = undefined;
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
			ai.reviewDecision = data.reviewDecision ?? undefined;
			ai.headRefName = data.headRefName ?? undefined;
		}
		// Update goal grouping cache so sidebar reflects the new PR state immediately
		if (goalId && data.state) {
			state.prStatusCache.set(goalId, { state: data.state, url: data.url, number: data.number, reviewDecision: data.reviewDecision ?? null, mergeable: data.mergeable });
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
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify({
				assistantType: "goal",
				reattemptGoalId: goalId,
			}),
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
