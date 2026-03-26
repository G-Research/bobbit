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
import { gatewayFetch, saveDraftToServer, loadDraftFromServer, deleteDraftFromServer, refreshSessions, startSessionPolling, updateLocalSessionTitle, updateLocalSessionStatus, fetchGitStatus, refreshPrStatusCache } from "./api.js";
import { startTimeRefresh } from "./render-helpers.js";
import { getRouteFromHash, setHashRoute, saveSessionModel, loadSessionModel, clearSessionModel } from "./routing.js";
import { sessionHueRotation } from "./session-colors.js";
import { showConnectionError, confirmAction, checkOAuthStatus, openOAuthDialog } from "./dialogs.js";
import { teardownMobileScrollTracking } from "./mobile-header.js";
import { storage } from "./storage.js";
import { markSessionVisited } from "./render-helpers.js";
import { setSelectedWorkflowId } from "./render.js";

// ============================================================================
// GOAL DRAFT PERSISTENCE HELPERS
// ============================================================================

/** Debounce timer for draft saves. */
let _draftSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Save the current goal assistant preview state to the server (debounced 300ms). */
export function saveGoalDraft(sessionId: string): void {
	if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
	_draftSaveTimer = setTimeout(() => {
		_draftSaveTimer = null;
		const draft = {
			sessionId,
			activeGoalProposal: state.activeGoalProposal ?? undefined,
			previewTitle: state.previewTitle,
			previewSpec: state.previewSpec,
			previewCwd: state.previewCwd,
			previewTitleEdited: state.previewTitleEdited,
			previewSpecEdited: state.previewSpecEdited,
			previewCwdEdited: state.previewCwdEdited,
			hasReceivedProposal: state.assistantHasProposal,
			goalAssistantTab: state.assistantTab,

		};
		saveDraftToServer(sessionId, 'goal', draft);
	}, 300);
}

/** Restore goal assistant preview state from the server. Returns true if a draft was found. */
async function restoreGoalDraft(sessionId: string): Promise<boolean> {
	try {
		const draft = await loadDraftFromServer(sessionId, 'goal') as any;
		if (!draft) return false;

		state.activeGoalProposal = draft.activeGoalProposal ?? null;
		state.previewTitle = draft.previewTitle ?? "";
		state.previewSpec = draft.previewSpec ?? "";
		state.previewCwd = draft.previewCwd ?? "";
		state.previewTitleEdited = draft.previewTitleEdited ?? false;
		state.previewSpecEdited = draft.previewSpecEdited ?? false;
		state.previewCwdEdited = draft.previewCwdEdited ?? false;
		state.assistantHasProposal = draft.hasReceivedProposal ?? false;
		state.assistantTab = draft.goalAssistantTab ?? "chat";

		return true;
	} catch (err) {
		console.error("[goal-draft] Failed to restore draft:", err);
		return false;
	}
}

/** Delete goal draft from the server. */
export function deleteGoalDraft(sessionId: string): void {
	deleteDraftFromServer(sessionId, 'goal');
}

// ============================================================================
// ROLE DRAFT PERSISTENCE HELPERS
// ============================================================================

/** Debounce timer for role draft saves. */
let _roleDraftSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Save the current role assistant preview state to the server (debounced 300ms). */
export function saveRoleDraft(sessionId: string): void {
	if (_roleDraftSaveTimer) clearTimeout(_roleDraftSaveTimer);
	_roleDraftSaveTimer = setTimeout(() => {
		_roleDraftSaveTimer = null;
		const draft = {
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
		};
		saveDraftToServer(sessionId, 'role', draft);
	}, 300);
}

/** Restore role assistant preview state from the server. Returns true if a draft was found. */
async function restoreRoleDraft(sessionId: string): Promise<boolean> {
	try {
		const draft = await loadDraftFromServer(sessionId, 'role') as any;
		if (!draft) return false;

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
		return true;
	} catch (err) {
		console.error("[role-draft] Failed to restore draft:", err);
		return false;
	}
}

/** Delete role draft from the server. */
export function deleteRoleDraft(sessionId: string): void {
	deleteDraftFromServer(sessionId, 'role');
}


// ============================================================================
// PERSONALITY DRAFT PERSISTENCE HELPERS
// ============================================================================

let _personalityDraftSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function savePersonalityDraft(sessionId: string): void {
	if (_personalityDraftSaveTimer) clearTimeout(_personalityDraftSaveTimer);
	_personalityDraftSaveTimer = setTimeout(() => {
		_personalityDraftSaveTimer = null;
		const draft = {
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
		};
		saveDraftToServer(sessionId, 'personality', draft);
	}, 300);
}

async function restorePersonalityDraft(sessionId: string): Promise<boolean> {
	try {
		const draft = await loadDraftFromServer(sessionId, 'personality') as any;
		if (!draft) return false;

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
		return true;
	} catch (err) {
		console.error("[personality-draft] Failed to restore draft:", err);
		return false;
	}
}

export function deletePersonalityDraft(sessionId: string): void {
	deleteDraftFromServer(sessionId, 'personality');
}


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
	if (!healthData.localhost && !healthData.aigw) {
		const hasAuth = await checkOAuthStatus();
		if (!hasAuth) {
			const success = await openOAuthDialog();
			if (!success) throw new Error("OAuth login required");
		}
	}

	state.appView = "authenticated";
	const route = getRouteFromHash();
	if (route.view !== "session" && route.view !== "goal-dashboard" && route.view !== "roles" && route.view !== "role-edit" && route.view !== "staff" && route.view !== "staff-edit") {
		setHashRoute("landing");
	}
	renderApp();
	await refreshSessions();
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
		saveDraftToServer(sid, 'prompt', val, _draftAbort.signal)
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
}

function _setupPromptDraftHandlers(sessionId: string): void {
	// Tear down any previous session's draft state
	_teardownDraftHandlers();
	_draftSessionId = sessionId;

	// Restore existing draft from server
	(async () => {
		try {
			const draft = await loadDraftFromServer(sessionId, 'prompt');
			// Only apply if we're still on the same session
			if (_draftSessionId !== sessionId) return;
			const editor = document.querySelector("message-editor") as any;
			if (editor && draft && typeof draft === 'string') {
				editor.value = draft;
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
			if (_draftSessionId) deleteDraftFromServer(_draftSessionId, 'prompt');
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
// CONNECT TO SESSION
// ============================================================================

export async function connectToSession(sessionId: string, isExisting: boolean, options?: { isGoalAssistant?: boolean; isRoleAssistant?: boolean; isToolAssistant?: boolean; isStaffAssistant?: boolean; isPreview?: boolean; assistantType?: string; readOnly?: boolean }): Promise<void> {
	if (state.connectingSessionId) return;
	state.connectingSessionId = sessionId;

	// Capture the current route BEFORE any async work. If we're on a goal dashboard,
	// we'll replace the history entry instead of pushing, so browser-back skips it.
	// Must be captured here because event bubbling during the async gap can change the hash.
	const startingRoute = getRouteFromHash();

	if (state.remoteAgent) {
		state.remoteAgent.disconnect();
		state.remoteAgent = null;
		state.connectionStatus = "disconnected";
	}
	state.cwdDropdownOpen = false;

	renderApp();

	try {
		const url = localStorage.getItem(GW_URL_KEY)!;
		const token = localStorage.getItem(GW_TOKEN_KEY)!;

		const remote = new RemoteAgent();
		await remote.connect(url, token, sessionId);

		// Restore saved model
		const savedModel = loadSessionModel(sessionId);
		if (savedModel) {
			const { getModel } = await import("@mariozechner/pi-ai");
			try {
				const model = getModel(savedModel.provider as any, savedModel.modelId);
				remote.setModel(model);
			} catch {
				// Model no longer available
			}
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
			renderApp();
			refreshSessions();
		};

		remote.onStatusChange = (status: string) => {
			updateLocalSessionStatus(sessionId, status);
			const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
			if (idx >= 0) {
				state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], isAborting: remote.isAborting };
			}
			// Set readOnly when archived status arrives (may come after initial connect)
			if (status === "archived" && state.chatPanel?.agentInterface) {
				state.chatPanel.agentInterface.readOnly = true;
			}
			// Refresh git status when agent becomes idle (turn finished)
			if (status === "idle") {
				refreshGitStatusForSession(sessionId);
				// Keep the active session marked as visited so it doesn't show unseen
				markSessionVisited(sessionId);
			}
			renderApp();
		};

		remote.onConnectionStatusChange = (status: ConnectionStatus) => {
			state.connectionStatus = status;
			renderApp();
		};

		remote.onWorkflowUpdate = () => renderApp();

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
			if (sid === sessionId) {
				state.isPreviewSession = preview;
				if (preview) startPreviewPolling();
				else stopPreviewPolling();
				renderApp();
			}
		};

		remote.onGoalProposal = (proposal) => {
			state.activeGoalProposal = proposal;
			if (state.assistantType === "goal") {
				if (!state.previewTitleEdited) state.previewTitle = proposal.title;
				if (!state.previewCwdEdited) state.previewCwd = proposal.cwd || "";
				if (!state.previewSpecEdited) state.previewSpec = proposal.spec;
				if (proposal.workflow) setSelectedWorkflowId(proposal.workflow);
				state.assistantHasProposal = true;
				if (state.assistantTab === "chat" && !isDesktop()) {
					state.assistantTab = "preview";
				}
				// Summarize goal title for sidebar display
				if (proposal.title.trim().length >= 3) {
					// Cancel any pending debounced title summarization from hand-edits
					if ((state as any)._goalTitleDebounceTimer) {
						clearTimeout((state as any)._goalTitleDebounceTimer);
						(state as any)._goalTitleDebounceTimer = null;
					}
					remote.summarizeGoalTitle(proposal.title);
				}
				// Persist draft to IndexedDB
				saveGoalDraft(sessionId);
			} else {
				// Non-goal-assistant session: show inline preview panel
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

		remote.onStaffProposal = (proposal) => {
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

		state.connectionStatus = "connected";
		state.remoteAgent = remote;
		state.appView = "authenticated";
		localStorage.setItem(GW_SESSION_KEY, sessionId);
		markSessionVisited(sessionId);

		document.documentElement.style.setProperty("--bobbit-hue-rotate", `${sessionHueRotation(sessionId)}deg`);
		// Refresh sessions so newly created sessions have role/accessory data
		await refreshSessions();
		const sessionForRole = state.gatewaySessions.find((s) => s.id === sessionId);
		// Remove all accessory classes, then add the active one
		const accClasses = ["bobbit-crowned", "bobbit-bandana", "bobbit-magnifier", "bobbit-palette", "bobbit-pencil", "bobbit-shield", "bobbit-set-square", "bobbit-flask", "bobbit-wizard-hat"];
		accClasses.forEach((c) => document.documentElement.classList.remove(c));
		const accId = sessionForRole?.accessory
			?? (sessionForRole?.role === "team-lead" ? "crown" : sessionForRole?.role === "coder" ? "bandana" : undefined);
		if (accId && accId !== "none") {
			// Crown uses "bobbit-crowned" for backward compat; others use "bobbit-{id}"
			const cls = accId === "crown" ? "bobbit-crowned" : `bobbit-${accId}`;
			document.documentElement.classList.add(cls);
		}

		// Detect goal assistant state early — before async work and before
		// the first renderApp() — so the mobile header (which depends on
		// isGoalAssistantSession) renders correctly on the first pass.
		const sessionData = state.gatewaySessions.find((s) => s.id === sessionId);
		// Unified assistant type detection — prefer assistantType from server, fall back to legacy booleans
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
		state.previewPanelHtml = ""; // Clear stale preview from previous session
		if (state.isPreviewSession) startPreviewPolling();
		else stopPreviewPolling();

		// Render immediately so the mobile header appears without waiting
		// for ChatPanel setup or other async work below.  This fixes a race
		// where the first render after connect still saw `hasActiveSession()
		// === false` because renderApp() hadn't been called since
		// `state.remoteAgent` was set.
		renderApp();

		// Replace history entry when navigating from goal dashboard so browser-back
		// goes to the landing page instead of back to the goal dashboard.
		// Also replace if the hash changed during the async connect (e.g. event bubbling
		// caused a goal-dashboard navigation while we were connecting).
		const currentRoute = getRouteFromHash();
		const replaceHistory = startingRoute.view === "goal-dashboard" || currentRoute.view === "goal-dashboard";
		setHashRoute("session", sessionId, replaceHistory);

		const modelProvider = remote.state.model?.provider || "anthropic";
		await storage.providerKeys.set(modelProvider, "gateway-managed");

		state.chatPanel = new ChatPanel();
		await state.chatPanel.setAgent(remote as any, {
			onApiKeyRequired: async () => true,
		});

		// Listen for suggest-goal events from assistant messages
		state.chatPanel.addEventListener('suggest-goal', () => {
			if (state.remoteAgent) {
				state.remoteAgent.prompt("Based on our conversation, please create a goal proposal for the improvement you suggested. Format it as a <goal_proposal> block with <title>, <spec>, and optionally <cwd> tags.");
			}
		});

		// Set cwd and branch on the AgentInterface stats bar
		if (state.chatPanel.agentInterface && sessionData?.cwd) {
			state.chatPanel.agentInterface.cwd = sessionData.cwd;
			// Look up branch from the goal if this session belongs to one
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

		// Disable input for non-interactive sessions (e.g. verification reviewers)
		if (state.chatPanel.agentInterface && sessionData?.nonInteractive) {
			state.chatPanel.agentInterface.readOnly = true;
		}

		// Set up bg process kill/dismiss handlers
		if (state.chatPanel.agentInterface) {
			state.chatPanel.agentInterface.onBgProcessKill = (processId: string) => {
				killBgProcess(sessionId, processId);
			};
			state.chatPanel.agentInterface.onBgProcessDismiss = (processId: string) => {
				dismissBgProcess(sessionId, processId);
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

		// Initial git status and bg process fetch
		refreshGitStatusForSession(sessionId);
		refreshBgProcessesForSession(sessionId);

		if (isExisting) {
			remote.requestMessages();
		}

		// Clear goal proposal when connecting to a non-goal-assistant session
		// to prevent stale proposals from showing in unrelated sessions
		if (state.assistantType !== "goal") {
			state.activeGoalProposal = null;
		}

		if (state.assistantType === "goal") {
			// Try to restore persisted draft state; fall back to fresh defaults
			const restored = await restoreGoalDraft(sessionId);
			if (!restored) {
				state.assistantTab = "chat";
				state.previewTitle = "";
				state.previewCwd = "";
				state.previewSpec = "";
				state.previewTitleEdited = false;
				state.previewCwdEdited = false;
				state.previewSpecEdited = false;
				state.assistantHasProposal = false;
			}
			state.previewSpecEditMode = false;
		}

		// Clear role proposal when connecting to a non-role-assistant session
		if (state.assistantType !== "role") {
			state.activeRoleProposal = null;
		}

		if (state.assistantType === "role") {
			const restored = await restoreRoleDraft(sessionId);
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
		}

		if (state.assistantType === "tool") {
			state.assistantTab = "chat";
			state.toolPreviewName = "";
			state.toolPreviewChecklist = { docs: "pending", renderer: "pending", tests: "pending", config: "pending" };
			state.toolPreviewDocs = "";
			state.toolPreviewRendererHtml = "";
		}

		// Clear personality proposal when connecting to a non-personality-assistant session
		if (state.assistantType !== "personality") {
			state.activePersonalityProposal = null;
		}

		if (state.assistantType === "personality") {
			const restored = await restorePersonalityDraft(sessionId);
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
		}

		// Clear staff proposal when connecting to a non-staff-assistant session
		if (state.assistantType !== "staff") {
			state.activeStaffProposal = null;
		}

		if (state.assistantType === "staff") {
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
		}

		// Auto-prompt for new assistant sessions
		const AUTO_PROMPTS: Record<string, string> = {
			goal: "Start the goal creation session.",
			role: "Start the role creation session.",
			tool: "Start the tool assistant session. Help me document, improve, or create tools.",
			personality: "Start the personality creation session.",
			staff: "Start the staff agent creation session.",
		};
		if (state.assistantType && !isExisting) {
			const autoPrompt = AUTO_PROMPTS[state.assistantType];
			if (autoPrompt) remote.prompt(autoPrompt);
		}

		// Restore prompt draft from server and set up auto-save
		_setupPromptDraftHandlers(sessionId);

		refreshSessions();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showConnectionError("Connection Failed", `Could not connect to session: ${msg}`);
	} finally {
		state.connectingSessionId = null;
		renderApp();
	}
}

// ============================================================================
// CREATE & CONNECT
// ============================================================================

export async function createAndConnectSession(goalId?: string, roleId?: string, personalities?: string[]): Promise<void> {
	if (state.creatingSession) return;
	state.creatingSession = true;
	state.creatingSessionForGoalId = goalId || null;
	renderApp();
	try {
		const body: any = {};
		if (goalId) body.goalId = goalId;
		if (roleId) body.roleId = roleId;
		if (personalities && personalities.length > 0) body.personalities = personalities;
		const res = await gatewayFetch("/api/sessions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
		const { id } = await res.json();
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

export async function terminateSession(sessionId: string): Promise<void> {
	const session = state.gatewaySessions.find((s) => s.id === sessionId);
	const sessionTitle = session?.title || "this session";
	const confirmed = await confirmAction(
		"Terminate Session",
		`Are you sure you want to terminate "${sessionTitle}"? This will end the agent process and cannot be undone.`,
		"Terminate",
		true,
	);
	if (!confirmed) return;

	if (activeSessionId() === sessionId) {
		state.remoteAgent?.disconnect();
		state.remoteAgent = null;
		state.connectionStatus = "disconnected";
		localStorage.removeItem(GW_SESSION_KEY);
		setHashRoute("landing");
		renderApp();
	}

	const res = await gatewayFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
	if (!res.ok && res.status !== 404) {
		throw new Error(`Failed to terminate session: ${res.status}`);
	}
	clearSessionModel(sessionId);
	deleteGoalDraft(sessionId);
	deleteRoleDraft(sessionId);
	deletePersonalityDraft(sessionId);
	await refreshSessions();
}

// ============================================================================
// DISCONNECT
// ============================================================================

export function backToSessions(): void {
	state.remoteAgent?.disconnect();
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
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
	setHashRoute("landing");
	renderApp();
	refreshSessions();
}

export function disconnectGateway(): void {
	state.remoteAgent?.disconnect();
	state.remoteAgent = null;
	state.connectionStatus = "disconnected";
	state.assistantType = null;
	state.assistantTab = "chat";
	state.assistantHasProposal = false;
	state.isPreviewSession = false;
	stopPreviewPolling();
	state.appView = "disconnected";
	localStorage.removeItem(GW_SESSION_KEY);
	teardownMobileScrollTracking();
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

async function refreshGitStatusForSession(sessionId: string): Promise<void> {
	const ai = state.chatPanel?.agentInterface;
	if (!ai) return;

	ai.gitStatusLoading = true;
	try {
		const data = await fetchGitStatus(sessionId);
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
