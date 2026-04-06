import { ChatPanel } from "../ui/index.js";
import { startPreviewPolling, stopPreviewPolling } from "./preview-panel.js";
import type { ConnectionStatus } from "./remote-agent.js";
import { RemoteAgent } from "./remote-agent.js";
import {
	state,
	renderApp,
	activeSessionId,
	isDesktop,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	GW_SESSION_KEY,
} from "./state.js";
import { gatewayFetch, saveDraftToServer, loadDraftFromServer, deleteDraftFromServer, refreshSessions, startSessionPolling, updateLocalSessionTitle, updateLocalSessionStatus, fetchGitStatus, refreshPrStatusCache, teardownTeam } from "./api.js";
import { startTimeRefresh } from "./render-helpers.js";
import { getRouteFromHash, setHashRoute, saveSessionModel, loadSessionModel, clearSessionModel, isConfigPageRoute } from "./routing.js";
import { sessionHueRotation, ACCESSORY_IDS } from "./session-colors.js";
import { showConnectionError, confirmAction, checkOAuthStatus, openOAuthDialog } from "./dialogs.js";
import { teardownMobileScrollTracking } from "./mobile-header.js";
import { storage } from "./storage.js";
import { markSessionVisited } from "./render-helpers.js";
import { setSelectedWorkflowId } from "./render.js";

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

/** Apply the per-project palette (if any) or revert to the global default. */
export function applyProjectPalette(projectId?: string): void {
	const project = (state.projects || []).find((p: any) => p.id === projectId);
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
// GOAL PROPOSAL DISMISS PERSISTENCE
// ============================================================================

function proposalFingerprint(proposal: { title: string; spec: string }): string {
	let hash = 5381;
	const str = proposal.title + "\n" + proposal.spec;
	for (let i = 0; i < str.length; i++) {
		hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
	}
	return String(hash);
}

function dismissedProposalKey(sessionId: string): string {
	return `bobbit-goal-proposal-dismissed-${sessionId}`;
}

export function isProposalDismissed(sessionId: string, proposal: { title: string; spec: string }): boolean {
	try {
		const stored = localStorage.getItem(dismissedProposalKey(sessionId));
		return stored === proposalFingerprint(proposal);
	} catch { return false; }
}

export function markProposalDismissed(sessionId: string, proposal: { title: string; spec: string }): void {
	try {
		localStorage.setItem(dismissedProposalKey(sessionId), proposalFingerprint(proposal));
	} catch { /* ignore */ }
}

function clearDismissedProposal(sessionId: string): void {
	try {
		localStorage.removeItem(dismissedProposalKey(sessionId));
	} catch { /* ignore */ }
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
 * for any assistant draft type. Eliminates duplication across goal/role/personality.
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
		activeGoalProposal: state.activeGoalProposal ?? undefined,
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
		state.activeGoalProposal = draft.activeGoalProposal ?? null;
		state.previewTitle = draft.previewTitle ?? "";
		state.previewSpec = draft.previewSpec ?? "";
		state.previewCwd = draft.previewCwd ?? "";
		state.previewProjectId = draft.previewProjectId ?? "";
		state.previewTitleEdited = draft.previewTitleEdited ?? false;
		state.previewSpecEdited = draft.previewSpecEdited ?? false;
		state.previewCwdEdited = draft.previewCwdEdited ?? false;
		state.assistantHasProposal = draft.hasReceivedProposal ?? false;
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
		activeRoleProposal: state.activeRoleProposal ?? undefined,
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
		state.activeRoleProposal = draft.activeRoleProposal ?? null;
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
// PERSONALITY DRAFT
// ============================================================================

const personalityDraft = createDraftManager({
	type: 'personality',
	serialize: (sessionId) => ({
		sessionId,
		activePersonalityProposal: state.activePersonalityProposal ?? undefined,
		previewName: state.personalityPreviewName,
		previewLabel: state.personalityPreviewLabel,
		previewDescription: state.personalityPreviewDescription,
		previewPromptFragment: state.personalityPreviewPromptFragment,
		previewNameEdited: state.personalityPreviewNameEdited,
		previewLabelEdited: state.personalityPreviewLabelEdited,
		previewDescriptionEdited: state.personalityPreviewDescriptionEdited,
		previewPromptFragmentEdited: state.personalityPreviewPromptFragmentEdited,
		hasReceivedPersonalityProposal: state.assistantHasProposal,
		personalityAssistantTab: state.assistantTab,
	}),
	restore: (_sessionId, draft: any) => {
		state.activePersonalityProposal = draft.activePersonalityProposal ?? null;
		state.personalityPreviewName = draft.previewName ?? "";
		state.personalityPreviewLabel = draft.previewLabel ?? "";
		state.personalityPreviewDescription = draft.previewDescription ?? "";
		state.personalityPreviewPromptFragment = draft.previewPromptFragment ?? "";
		state.personalityPreviewNameEdited = draft.previewNameEdited ?? false;
		state.personalityPreviewLabelEdited = draft.previewLabelEdited ?? false;
		state.personalityPreviewDescriptionEdited = draft.previewDescriptionEdited ?? false;
		state.personalityPreviewPromptFragmentEdited = draft.previewPromptFragmentEdited ?? false;
		state.assistantHasProposal = draft.hasReceivedPersonalityProposal ?? false;
		state.assistantTab = draft.personalityAssistantTab ?? "chat";
	},
});

export function savePersonalityDraft(sessionId: string): void { personalityDraft.save(sessionId); }
async function restorePersonalityDraft(sessionId: string): Promise<boolean> { return personalityDraft.restore(sessionId); }
export function deletePersonalityDraft(sessionId: string): void { personalityDraft.delete(sessionId); }


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
// Module-level state prevents monkey-patch stacking across session switches.
// Each call to _setupPromptDraftHandlers cancels the previous session's timers
// and rebinds to the new session ID without wrapping old handlers.

let _draftSessionId: string | null = null;
let _draftTimer: ReturnType<typeof setTimeout> | null = null;
let _draftAbort: AbortController | null = null;
let _draftListenersInstalled = false;
/** Monotonic counter — incremented on every send. Saved alongside the draft
 *  so stale saves (from aborted-but-already-sent requests) can be detected
 *  and ignored on load. */
let _draftGen = 0;
/** The generation at which the last send occurred. Any draft with gen < this is stale. */
let _draftSendGen = 0;

/** Immediately persist the given draft value (or delete if empty). */
function _flushDraft(rawVal?: string): void {
	if (!_draftSessionId) return;
	if (_draftAbort) _draftAbort.abort();
	// If no value provided, read from the editor
	const val: string = rawVal !== undefined ? rawVal
		: (document.querySelector("message-editor") as any)?.value ?? "";
	if (val.trim()) {
		_draftAbort = new AbortController();
		const sid = _draftSessionId;
		const gen = ++_draftGen;
		saveDraftToServer(sid, 'prompt', { text: val, gen }, _draftAbort.signal)
			.finally(() => { if (_draftAbort) _draftAbort = null; });
	} else {
		deleteDraftFromServer(_draftSessionId, 'prompt');
	}
}

/** Flush any pending draft save immediately (e.g. before HMR reload). */
export function flushPendingDraft(): void {
	if (_draftTimer) {
		clearTimeout(_draftTimer);
		_draftTimer = null;
	}
	_flushDraft();
}

function _teardownDraftHandlers(): void {
	if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
	if (_draftAbort) { _draftAbort.abort(); _draftAbort = null; }
	_draftSessionId = null;
	_draftGen = 0;
	_draftSendGen = 0;
}

function _setupPromptDraftHandlers(sessionId: string): void {
	// Tear down any previous session's draft state
	_teardownDraftHandlers();
	_draftSessionId = sessionId;
	// Restore send gen from sessionStorage (survives HMR/reload)
	_draftSendGen = parseInt(sessionStorage.getItem(`draft-send-gen-${sessionId}`) || "0", 10);

	// Restore existing draft from server
	(async () => {
		try {
			const draft = await loadDraftFromServer(sessionId, 'prompt');
			// Only apply if we're still on the same session
			if (_draftSessionId !== sessionId) return;
			const editor = document.querySelector("message-editor") as any;
			if (!editor) return;

			// Handle both old format (plain string) and new format ({ text, gen })
			let text: string | null = null;
			if (typeof draft === 'string') {
				// Legacy format — no gen, always apply
				text = draft;
			} else if (draft && typeof draft === 'object' && 'text' in (draft as any)) {
				const d = draft as { text: string; gen?: number };
				// If this draft's gen is <= the last send gen, it's stale (from
				// a save that raced with a send). Ignore it.
				if (d.gen != null && d.gen <= _draftSendGen) {
					text = null;
				} else {
					text = d.text;
				}
			}

			if (text) {
				editor.value = text;
			}
		} catch { /* ignore */ }
	})();

	// Use document-level event listeners instead of monkey-patching.
	// Lit re-renders overwrite property-based callbacks (.onSend, .onInput)
	// on every state change, silently removing our patches. Native DOM
	// events (composed: true) bubble through shadow DOM and survive re-renders.
	if (!_draftListenersInstalled) {
		// Debounced draft save on textarea input (native 'input' event is composed)
		document.addEventListener("input", (e: Event) => {
			const target = e.target as HTMLElement;
			if (!target || target.tagName !== "TEXTAREA") return;
			// Verify it's inside a message-editor
			if (!target.closest("message-editor")) return;
			if (!_draftSessionId) return;

			const val = (target as HTMLTextAreaElement).value;
			if (_draftTimer) clearTimeout(_draftTimer);
			_draftTimer = setTimeout(() => {
				_draftTimer = null;
				_flushDraft(val);
			}, 100);
		});

		// Clear draft on send (custom composed event from MessageEditor)
		document.addEventListener("message-send", () => {
			if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
			if (_draftAbort) { _draftAbort.abort(); _draftAbort = null; }
			if (_draftSessionId) {
				// Increment gen and record the send generation. Then overwrite the
				// draft with a tombstone at the new gen. Even if a stale save (from
				// an aborted-but-already-sent request) arrives at the server after
				// this, the load will see gen <= _draftSendGen and ignore it.
				const gen = ++_draftGen;
				_draftSendGen = gen;
				sessionStorage.setItem(`draft-send-gen-${_draftSessionId}`, String(gen));
				saveDraftToServer(_draftSessionId, 'prompt', { text: "", gen });
			}
		});

		_draftListenersInstalled = true;
	}

	// Focus the textarea
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
	// during the async gap before _setupPromptDraftHandlers binds the new one.
	if (_draftTimer) { clearTimeout(_draftTimer); _draftTimer = null; }
	_flushDraft();
	_teardownDraftHandlers();

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

export async function connectToSession(sessionId: string, isExisting: boolean, options?: { isGoalAssistant?: boolean; isRoleAssistant?: boolean; isToolAssistant?: boolean; isStaffAssistant?: boolean; isPreview?: boolean; assistantType?: string; readOnly?: boolean; workflowEditContext?: { id: string; name: string } }): Promise<void> {
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

		// Reset session-scoped global state so it doesn't bleed from the previous session
		const sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
		state.assistantType = sessionData?.assistantType
			|| (sessionData?.goalAssistant ? "goal"
			: sessionData?.roleAssistant ? "role"
			: sessionData?.toolAssistant ? "tool"
			: sessionData?.staffAssistant ? "staff"
			: null);
		state.assistantTab = "chat";
		state.assistantHasProposal = false;
		state.activeGoalProposal = null;
		state.activeRoleProposal = null;
		state.activeStaffProposal = null;
		state.previewTitle = "";
		state.previewSpec = "";
		state.previewCwd = "";
		state.previewProjectId = "";
		state.previewTitleEdited = false;
		state.previewSpecEdited = false;
		state.previewCwdEdited = false;
		state.isPreviewSession = sessionData?.preview || false;
		state.previewPanelHtml = "";
		if (state.isPreviewSession) startPreviewPolling();
		else stopPreviewPolling();

		// Mark as visited so unseen indicators clear
		markSessionVisited(sessionId);

		renderApp();

		// Re-bind draft handlers AFTER render so the cached message-editor is in the DOM.
		_setupPromptDraftHandlers(sessionId);

		// Refresh git status and bg processes (lightweight, fire-and-forget)
		refreshGitStatusForSession(sessionId);
		refreshBgProcessesForSession(sessionId);

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
				const { getModel } = await import("@mariozechner/pi-ai");
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
			personality: "Start the personality creation session.",
			staff: "Start the staff agent creation session.",
			setup: "Start the project setup session.",
			workflow: "Start the workflow creation session. Help me design a new workflow with gates and verification.",
		};
		if (options?.assistantType && !isExisting) {
			let autoPrompt: string | undefined;
			if (options.assistantType === "workflow" && options.workflowEditContext) {
				const wfCtx = options.workflowEditContext;
				autoPrompt = `I want to edit the existing workflow '${wfCtx.name}' (id: ${wfCtx.id}). Read it from .bobbit/config/workflows/${wfCtx.id}.yaml and help me improve it.`;
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
			}
			// Refresh git status when agent becomes idle (turn finished)
			if (status === "idle") {
				refreshGitStatusForSession(sessionId);
				// Keep the active session marked as visited so it doesn't show unseen.
				// Only for the active session — cached sessions going idle should
				// show the unseen indicator when the user switches back.
				if (activeSessionId() === sessionId) {
					markSessionVisited(sessionId);
				}
			}
			renderApp();
		};

		remote.onConnectionStatusChange = (status: ConnectionStatus) => {
			// Only update global connection status if this is the active session
			if (activeSessionId() === sessionId) {
				state.connectionStatus = status;
			}
			// Re-fetch git status and bg processes after reconnect (e.g. server restart)
			if (status === "connected") {
				refreshGitStatusForSession(sessionId);
				refreshBgProcessesForSession(sessionId);
			}
			if (activeSessionId() === sessionId) renderApp();
		};

		remote.onCompactionChange = (isCompacting: boolean) => {
			const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
			if (idx >= 0) {
				state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], isCompacting };
			}
			if (activeSessionId() === sessionId) renderApp();
		};

		remote.onWorkflowUpdate = () => { if (activeSessionId() === sessionId) renderApp(); };

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
				// Update status in the process list
				ai.bgProcesses = ai.bgProcesses.map((p) =>
					p.id === msg.processId ? { ...p, status: "exited" as const, exitCode: msg.exitCode ?? null } : p
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

		remote.onGoalProposal = (proposal) => {
			if (activeSessionId() !== sessionId) return;
			if (state.assistantType === "goal") {
				state.activeGoalProposal = proposal;
				if (!state.previewTitleEdited) state.previewTitle = proposal.title;
				if (!state.previewCwdEdited) state.previewCwd = proposal.cwd || "";
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
				// Non-goal-assistant session: check if this proposal was previously dismissed
				if (isProposalDismissed(sessionId, proposal)) return;
				// Show inline preview panel
				state.activeGoalProposal = proposal;
				// Set projectId from current session so the goal is created in the correct project
				const currentSess = state.gatewaySessions.find(s => s.id === sessionId);
				if (currentSess?.projectId) {
					state.previewProjectId = currentSess.projectId;
				}
				state.previewPanelActiveTab = "goal";
				// Un-collapse panel on desktop
				const collapseKey = `bobbit-preview-collapsed-${sessionId}`;
				localStorage.removeItem(collapseKey);
				// On mobile, switch to the panel tab so user sees the goal form
				if (!isDesktop()) {
					state.previewPanelTab = "preview";
				}
			}
			renderApp();
		};

		remote.onRoleProposal = (proposal) => {
			if (activeSessionId() !== sessionId) return;
			state.activeRoleProposal = proposal;
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

		remote.onToolProposal = (proposal) => {
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

		remote.onPersonalityProposal = (proposal: { name: string; label: string; description: string; prompt_fragment: string }) => {
			if (activeSessionId() !== sessionId) return;
			state.activePersonalityProposal = proposal;
			if (!state.personalityPreviewNameEdited) state.personalityPreviewName = proposal.name;
			if (!state.personalityPreviewLabelEdited) state.personalityPreviewLabel = proposal.label;
			if (!state.personalityPreviewDescriptionEdited) state.personalityPreviewDescription = proposal.description;
			if (!state.personalityPreviewPromptFragmentEdited) state.personalityPreviewPromptFragment = proposal.prompt_fragment;
			state.assistantHasProposal = true;
			if (state.assistantTab === "chat" && !isDesktop()) {
				state.assistantTab = "preview";
			}
			savePersonalityDraft(sessionId);
			renderApp();
		};

		remote.onSetupProposal = (proposal) => {
			if (activeSessionId() !== sessionId) return;
			state.setupPreviewAction = proposal.action;
			state.assistantHasProposal = true;

			if (proposal.action === "stack") {
				if (proposal.language) state.setupFormStack.language = proposal.language;
				if (proposal.framework) state.setupFormStack.framework = proposal.framework;
				if (proposal.testing) state.setupFormStack.testing = proposal.testing;
			} else if (proposal.action === "commands") {
				const cmdFields = ["build_command", "test_command", "typecheck_command", "test_unit_command", "test_e2e_command"];
				for (const f of cmdFields) {
					if ((proposal as any)[f] && !state.setupFormCommandsEdited[f]) {
						state.setupFormCommands[f] = (proposal as any)[f];
					}
				}
			} else if (proposal.action === "models") {
				const modelFields = ["session_model", "review_model", "naming_model"] as const;
				for (const f of modelFields) {
					if ((proposal as any)[f] && !state.setupFormModelsEdited[f]) {
						state.setupFormModels[f] = (proposal as any)[f];
					}
				}
			} else if (proposal.action === "system-prompt") {
				if (proposal.content && !state.setupFormSystemPromptEdited) {
					state.setupFormSystemPrompt = proposal.content;
				}
			}

			if (state.assistantTab === "chat" && !isDesktop()) {
				state.assistantTab = "preview";
			}
			renderApp();
		};

		remote.onWorkflowProposal = (proposal) => {
			if (activeSessionId() !== sessionId) return;
			state.workflowPreviewId = proposal.id || "";
			state.workflowPreviewName = proposal.name || "";
			state.workflowPreviewDescription = proposal.description || "";
			state.workflowPreviewGates = proposal.gates || "";
			state.assistantHasProposal = true;
			if (state.assistantTab === "chat" && !isDesktop()) {
				state.assistantTab = "preview";
			}
			// Parse gates JSON from proposal and populate edit form directly
			if (proposal.id) {
				let gates: any[] = [];
				try { gates = JSON.parse(proposal.gates || "[]"); } catch { /* ignore parse errors */ }
				import("./workflow-page.js").then(({ populateFromProposal }) => {
					if (isStale()) return;
					populateFromProposal({
						id: proposal.id,
						name: proposal.name || "",
						description: proposal.description || "",
						gates,
					});
					renderApp();
				});
			}
			renderApp();
		};

		remote.onStaffProposal = (proposal) => {
			if (activeSessionId() !== sessionId) return;
			state.activeStaffProposal = proposal;
			if (!state.staffPreviewNameEdited) state.staffPreviewName = proposal.name;
			if (!state.staffPreviewDescriptionEdited) state.staffPreviewDescription = proposal.description;
			if (!state.staffPreviewPromptEdited) state.staffPreviewPrompt = proposal.prompt;
			if (!state.staffPreviewTriggersEdited) state.staffPreviewTriggers = proposal.triggers || "[]";
			if (!state.staffPreviewCwdEdited) state.staffPreviewCwd = proposal.cwd || "";
			state.assistantHasProposal = true;
			if (state.assistantTab === "chat" && !isDesktop()) {
				state.assistantTab = "preview";
			}
			renderApp();
		};

		remote.onProjectProposal = async (fields: Record<string, string>) => {
			if (activeSessionId() !== sessionId) return;
			const { registerProject, fetchProjects, gatewayFetch } = await import("./api.js");
			const project = await registerProject(fields.name, fields.root_path, undefined);
			if (project) {
				// Write detected config to project.yaml
				const configFields: Record<string, string> = {};
				const CONFIG_KEYS = ['build_command', 'test_command', 'typecheck_command',
					'test_unit_command', 'test_e2e_command',
					'worktree_setup_command'];
				for (const key of CONFIG_KEYS) {
					if (fields[key]) configFields[key] = fields[key];
				}
				if (Object.keys(configFields).length > 0) {
					await gatewayFetch(`/api/projects/${project.id}/config`, {
						method: 'PUT',
						body: JSON.stringify(configFields),
					});
				}
				// Refresh project list
				state.projects = await fetchProjects();
			}
			renderApp();
		};

		// Listen for "Open proposal" button clicks from ProposalRenderer tool cards.
		// Routes the event to the same callbacks already wired above.
		const proposalOpenHandler = ((e: CustomEvent) => {
			if (activeSessionId() !== sessionId) return;
			const { type, fields } = e.detail || {};
			if (!type || !fields) return;
			const callbackMap: Record<string, ((p: any) => void) | undefined> = {
				goal: remote.onGoalProposal,
				role: remote.onRoleProposal,
				tool: remote.onToolProposal,
				personality: remote.onPersonalityProposal,
				staff: remote.onStaffProposal,
				setup: remote.onSetupProposal,
				workflow: remote.onWorkflowProposal,
				project: remote.onProjectProposal,
			};
			const cb = callbackMap[type];
			if (cb) cb(fields);
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

		// Detect assistant type from cached session data (no network needed).
		const sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
		state.assistantType = options?.assistantType
			|| sessionData?.assistantType
			|| (options?.isGoalAssistant || sessionData?.goalAssistant ? "goal"
			: options?.isRoleAssistant || sessionData?.roleAssistant ? "role"
			: options?.isToolAssistant || sessionData?.toolAssistant ? "tool"
			: options?.isStaffAssistant || sessionData?.staffAssistant ? "staff"
			: null);
		state.assistantTab = "chat";
		state.assistantHasProposal = false;
		state.setupPreviewAction = "";
		state.setupFormStack = { language: "", framework: "", testing: "" };
		state.setupFormCommands = { build_command: "", test_command: "", typecheck_command: "", test_unit_command: "", test_e2e_command: "" };
		state.setupFormModels = { session_model: "", review_model: "", naming_model: "" };
		state.setupFormSystemPrompt = "";
		state.setupFormSystemPromptEdited = false;
		state.setupFormCommandsEdited = {};
		state.setupFormModelsEdited = {};
		state.setupFormSaving = false;
		state.setupFormSaved = false;
		state.isPreviewSession = options?.isPreview || sessionData?.preview || false;
		state.previewPanelHtml = ""; // Clear stale preview from previous session
		if (state.isPreviewSession) startPreviewPolling();
		else stopPreviewPolling();

		// ── Bind the agent to the early ChatPanel (created before connect
		// to show the "Connecting…" shell instantly).
		await state.chatPanel!.setAgent(remote as any, {
			onApiKeyRequired: async () => true,
		});
		if (isStale()) { cleanupRemote(remote); return; }

		// Listen for suggest-goal events from assistant messages
		state.chatPanel.addEventListener('suggest-goal', () => {
			if (state.remoteAgent) {
				state.remoteAgent.prompt("Based on our conversation, please create a goal proposal for the improvement you suggested. Format it as a <goal_proposal> block with <title>, <spec>, and optionally <cwd> tags.");
			}
		});

		// Set cwd and branch on the AgentInterface stats bar
		if (state.chatPanel.agentInterface && sessionData?.cwd) {
			state.chatPanel.agentInterface.cwd = sessionData.cwd;
			state.chatPanel.agentInterface.projectId = sessionData.projectId;
			if (sessionData.goalId) {
				const goal = state.goals.find((g) => g.id === sessionData.goalId);
				if (goal?.branch) {
					state.chatPanel.agentInterface.branch = goal.branch;
				}
			}
		}

		// Disable input for archived or explicitly read-only sessions
		if (state.chatPanel.agentInterface && (remote.state.isArchived || options?.readOnly)) {
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
				refreshGitStatusForSession(sessionId, true);
			};
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
			state.chatPanel.agentInterface.onPrMerge = async (method: string, admin?: boolean) => {
				const sd = state.gatewaySessions.find((s) => s.id === sessionId);
				const mergeUrl = sd?.goalId
					? `/api/goals/${sd.goalId}/pr-merge`
					: `/api/sessions/${sessionId}/pr-merge`;
				try {
					const res = await gatewayFetch(mergeUrl, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ method, ...(admin ? { admin: true } : {}) }),
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

		// ── Run draft restores, refreshSessions, and storage.providerKeys
		// in parallel. Draft restores must complete before we unlock proposal
		// checking, but they don't depend on refreshSessions.
		const draftRestorePromise = (async () => {
			// Clear stale proposals for non-matching assistant types
			if (state.assistantType !== "goal") state.activeGoalProposal = null;
			if (state.assistantType !== "role") state.activeRoleProposal = null;
			if (state.assistantType !== "personality") state.activePersonalityProposal = null;
			if (state.assistantType !== "staff") state.activeStaffProposal = null;

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
			} else if (state.assistantType === "personality") {
				const restored = await restorePersonalityDraft(sessionId);
				if (isStale()) return;
				if (!restored) {
					state.assistantTab = "chat";
					state.personalityPreviewName = "";
					state.personalityPreviewLabel = "";
					state.personalityPreviewDescription = "";
					state.personalityPreviewPromptFragment = "";
					state.personalityPreviewNameEdited = false;
					state.personalityPreviewLabelEdited = false;
					state.personalityPreviewDescriptionEdited = false;
					state.personalityPreviewPromptFragmentEdited = false;
					state.assistantHasProposal = false;
				}
			} else if (state.assistantType === "staff") {
				state.assistantTab = "chat";
				state.staffPreviewName = "";
				state.staffPreviewDescription = "";
				state.staffPreviewPrompt = "";
				state.staffPreviewTriggers = "[]";
				state.staffPreviewCwd = "";
				state.staffPreviewNameEdited = false;
				state.staffPreviewDescriptionEdited = false;
				state.staffPreviewPromptEdited = false;
				state.staffPreviewTriggersEdited = false;
				state.staffPreviewCwdEdited = false;
				state.assistantHasProposal = false;
			} else if (state.assistantType === "workflow") {
				state.assistantTab = "chat";
				state.workflowPreviewId = "";
				state.workflowPreviewName = "";
				state.workflowPreviewDescription = "";
				state.workflowPreviewGates = "";
				// Initialize the edit form state for the panel
				import("./workflow-page.js").then(({ initAssistantEditState }) => {
					initAssistantEditState();
				});
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

		// Restore prompt draft from server and set up auto-save
		_setupPromptDraftHandlers(sessionId);

		// Wait for background work (refreshSessions + storage) to settle
		await backgroundWork;
		if (isStale()) { cleanupRemote(remote); return; }
	} catch (err) {
		if (!isStale()) {
			// Clear the early ChatPanel so the UI doesn't show a stuck "Connecting…" spinner
			state.chatPanel = null;
			const msg = err instanceof Error ? err.message : String(err);
			showConnectionError("Connection Failed", `Could not connect to session: ${msg}`);
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

export async function createAndConnectSession(goalId?: string, roleId?: string, personalities?: string[], cwd?: string, worktree?: boolean, sandboxed?: boolean, projectId?: string): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	state.creatingSessionForGoalId = goalId || null;
	renderApp();
	try {
		const body: any = {};
		if (goalId) body.goalId = goalId;
		if (roleId) body.roleId = roleId;
		if (personalities && personalities.length > 0) body.personalities = personalities;
		if (cwd) body.cwd = cwd;
		if (worktree !== undefined) body.worktree = worktree;
		if (sandboxed) body.sandboxed = true;
		if (projectId) body.projectId = projectId;
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
		// Clear creatingSession before connecting — connectToSession handles its
		// own loading state via connectingSessionId, and we want the user to see
		// the chat panel (with textarea) immediately, not a loading spinner.
		state.creatingSession = false;
		state.creatingSessionForGoalId = null;
		await connectToSession(id, false);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Failed to create session", msg);
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
	deletePersonalityDraft(sessionId);
	clearDismissedProposal(sessionId);
	await refreshSessions();
}

// ============================================================================
// DISCONNECT
// ============================================================================

export function backToSessions(): void {
	state.remoteAgent?.disconnect();
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
	state.selectedSessionId = null;
	state.activeGoalProposal = null;
	state.activeRoleProposal = null;
	state.assistantType = null;
	state.assistantTab = "chat";
	state.assistantHasProposal = false;
	state.isPreviewSession = false;
	stopPreviewPolling();
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
	stopPreviewPolling();
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

async function refreshGitStatusForSession(sessionId: string, fetch?: boolean): Promise<void> {
	const ai = state.chatPanel?.agentInterface;
	if (!ai) return;

	ai.gitStatusLoading = true;
	try {
		const data = await fetchGitStatus(sessionId, fetch ? { fetch: true } : undefined);
		if (data && activeSessionId() === sessionId) {
			ai.gitStatus = data;
			// Also update the branch in the stats bar
			if (data.branch) ai.branch = data.branch;
		}
	} catch {
		// silently ignore — widget just won't show
	} finally {
		if (activeSessionId() === sessionId) {
			ai.gitStatusLoading = false;
		}
	}
	refreshPrStatusForSession(sessionId);
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
		}
	}
}

// ============================================================================
// RE-ATTEMPT FLOW
// ============================================================================

export async function startReattempt(goalId: string): Promise<void> {
	const res = await gatewayFetch("/api/sessions", {
		method: "POST",
		body: JSON.stringify({
			assistantType: "goal",
			reattemptGoalId: goalId,
		}),
	});
	if (!res.ok) throw new Error(`Failed: ${res.status}`);
	const { id } = await res.json();
	await connectToSession(id, false, { assistantType: "goal" });
}
