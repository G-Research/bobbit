import type { ChatPanel } from "../ui/index.js";
import type { RemoteAgent, ConnectionStatus } from "./remote-agent.js";
import { isConfigPageRoute } from "./routing.js";

// ============================================================================
// TYPES
// ============================================================================

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  color?: string;       // Deprecated, kept for compat
  palette?: string;
  colorLight: string;
  colorDark: string;
  provisional?: boolean;
}

export interface GatewaySession {
	id: string;
	title: string;
	cwd: string;
	projectId?: string;
	status: string;
	createdAt: number;
	lastActivity: number;
	clientCount: number;
	isCompacting?: boolean;
	isAborting?: boolean;
	goalId?: string;
	goalAssistant?: boolean;
	roleAssistant?: boolean;
	toolAssistant?: boolean;
	assistantType?: string;
	colorIndex?: number;
	/** If this is a delegate session, the parent session ID */
	delegateOf?: string;
	/** Role in a team goal */
	role?: string;
	/** The team goal this agent belongs to */
	teamGoalId?: string;
	/** Session ID of the team lead that spawned this agent */
	teamLeadSessionId?: string;
	/** Git worktree path */
	worktreePath?: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory?: string;
	/** Whether this session is archived (soft-deleted) */
	archived?: boolean;
	/** Epoch ms when this session was archived */
	archivedAt?: number;
	/** If this session was created by a staff agent wake */
	staffId?: string;
	/** If this is a staff assistant session */
	staffAssistant?: boolean;
	/** Whether this session has a live HTML preview panel */
	preview?: boolean;
	/** Goal ID this session is re-attempting (for goal assistant sessions) */
	reattemptGoalId?: string;
	/** Whether this session runs in a Docker sandbox */
	sandboxed?: boolean;
	/** Whether this is an automated non-interactive session (e.g. verification reviewer) */
	nonInteractive?: boolean;
	/** Personality names assigned to this session */
	personalities?: string[];
}

export type GoalState = "todo" | "in-progress" | "complete" | "shelved";

export interface Goal {
	id: string;
	title: string;
	cwd: string;
	projectId?: string;
	state: GoalState;
	spec: string;
	createdAt: number;
	updatedAt: number;
	worktreePath?: string;
	branch?: string;
	repoPath?: string;
	team?: boolean;
	teamLeadSessionId?: string;
	workflowId?: string;
	setupStatus?: "ready" | "preparing" | "error";
	setupError?: string;
	archived?: boolean;
	archivedAt?: number;
	/** If this goal is a re-attempt of another goal, the original goal's ID */
	reattemptOf?: string;
	/** Whether team agents should run in Docker sandbox */
	sandboxed?: boolean;
	workflow?: {
		id: string;
		name: string;
		description: string;
		gates: Array<{
			id: string;
			name: string;
			dependsOn: string[];
			content?: boolean;
			injectDownstream?: boolean;
			metadata?: Record<string, string>;
			verify?: Array<{
				name: string;
				type: "command" | "llm-review";
				run?: string;
				prompt?: string;
				expect?: "success" | "failure";
				timeout?: number;
			}>;
		}>;
	};
}

export type AppView = "disconnected" | "gateway-starting" | "authenticated";

// ============================================================================
// SIDEBAR WIDTH (user-resizable) — helpers declared before `state` so the
// object initializer can safely call loadSidebarWidth() under bundlers that
// convert hoisted `function` declarations into const bindings (TDZ-sensitive).
// ============================================================================

export const SIDEBAR_WIDTH_KEY = "bobbit-sidebar-width";
export const SIDEBAR_WIDTH_DEFAULT = 240;
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;

export function clampSidebarWidth(w: number): number {
	if (!Number.isFinite(w)) return SIDEBAR_WIDTH_DEFAULT;
	return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.round(w)));
}

function loadSidebarWidth(): number {
	if (typeof localStorage === "undefined") return SIDEBAR_WIDTH_DEFAULT;
	const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
	if (!raw) return SIDEBAR_WIDTH_DEFAULT;
	const n = Number.parseInt(raw, 10);
	return clampSidebarWidth(n);
}

export function applySidebarWidthVar(w: number): void {
	if (typeof document === "undefined") return;
	document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
}

// Apply immediately so first paint has the right width.
applySidebarWidthVar(loadSidebarWidth());

// ============================================================================
// MUTABLE STATE
// ============================================================================

export const state = {
	chatPanel: null as ChatPanel | null,
	remoteAgent: null as RemoteAgent | null,
	connectionStatus: "disconnected" as ConnectionStatus,
	appView: "disconnected" as AppView,

	gatewaySessions: [] as GatewaySession[],
	goals: [] as Goal[],
	projects: [] as Project[],
	/** @deprecated No longer used — provisional projects replace pending projects */
	pendingProjects: [] as Array<{ sessionId: string; dirPath: string; name: string }>,
	activeProjectProposal: undefined as undefined | {
		sessionId: string;
		fields: Record<string, string>;
		/** Provisional = project is still in .bobbit/state/projects.json with
		 *  provisional:true (existing assistant flow). Registered = any other
		 *  project (regular/goal/staff session pointing at a live project). */
		mode?: "provisional" | "registered";
		/** Current project snapshot + registry fields, loaded lazily after the
		 *  panel mounts. `undefined` = not fetched yet (panel shows skeleton). */
		currentConfig?: {
			name: string;
			rootPath: string;
			config: Record<string, string>;
		};
	},
	activeProjectId: null as string | null,
	/** Server generation counter for sessions — used to skip redundant refreshes */
	sessionsGeneration: -1,
	/** Server generation counter for goals — used to skip redundant refreshes */
	goalsGeneration: -1,
	/** Gate status cache: goalId → { passed, total, verifying } */
	gateStatusCache: new Map<string, { passed: number; total: number; verifying: boolean; verifyingCount: number }>(),
	/** PR status cache: goalId → { state, url, number, reviewDecision } */
	prStatusCache: new Map<string, { state: string; url?: string; number?: number; reviewDecision?: string | null; mergeable?: string }>(),
	sessionsLoading: false,
	sessionsError: "",
	creatingSession: false,
	creatingSessionForGoalId: null as string | null,
	connectingSessionId: null as string | null,
	/** The session ID the user has selected (visual highlight). Updated synchronously. */
	selectedSessionId: null as string | null,
	/** Monotonically increasing counter. Bumped on every select. Used to detect stale hydrations. */
	switchGeneration: 0,
	sessionPollTimer: null as ReturnType<typeof setInterval> | null,

	/** Persisted default working directory from server */
	defaultCwd: "",

	/** Whether the sidebar is collapsed */
	sidebarCollapsed: localStorage.getItem("bobbit-sidebar-collapsed") === "true",
	/** User-resizable sidebar width in px (expanded state). Clamped 180–480. */
	sidebarWidth: loadSidebarWidth(),

	/** Whether to show archived sessions in the sidebar */
	showArchived: localStorage.getItem("bobbit-show-archived") === "true",
	/** Whether the archived section is expanded */

	/** Archived sessions (loaded on demand) */
	archivedSessions: [] as GatewaySession[],

	// Search state
	searchQuery: "",

	// Pagination for archived items
	archivedGoalsCursor: null as number | null,
	archivedGoalsHasMore: false,
	archivedGoalsTotal: 0,
	archivedSessionsCursor: null as number | null,
	archivedSessionsHasMore: false,
	archivedSessionsTotal: 0,

	/** Active goal proposal from a goal-assistant session */
	activeGoalProposal: null as { title: string; spec: string; cwd?: string; workflow?: string; options?: string } | null,

	// Unified assistant state
	assistantType: null as string | null,
	assistantTab: "chat" as "chat" | "preview",
	assistantHasProposal: false,

	// Goal assistant split-screen state
	previewTitle: "",
	previewCwd: "",
	previewSpec: "",
	previewTitleEdited: false,
	previewCwdEdited: false,
	previewSpecEdited: false,
	hasReceivedProposal: false,
	previewProjectId: "" as string,
	previewSpecEditMode: false,
	cwdDropdownOpen: false,
	cwdHighlightIndex: -1,

	/** Active role proposal from a role-assistant session */
	activeRoleProposal: null as { name: string; label: string; prompt: string; tools: string; accessory: string } | null,

	// Role assistant split-screen state
	isRoleAssistantSession: false,
	isToolAssistantSession: false,
	toolAssistantTab: "chat" as "chat" | "preview",
	toolPreviewName: "",
	toolPreviewChecklist: {
		docs: "pending" as "pending" | "in-progress" | "done",
		renderer: "pending" as "pending" | "in-progress" | "done",
		tests: "pending" as "pending" | "in-progress" | "done",
		config: "pending" as "pending" | "in-progress" | "done",
	},
	toolPreviewDocs: "",
	toolPreviewRendererHtml: "" as string,
	hasReceivedToolProposal: false,
	roleAssistantTab: "chat" as "chat" | "preview",
	rolePreviewName: "",
	rolePreviewLabel: "",
	rolePreviewPrompt: "",
	rolePreviewTools: "",
	rolePreviewAccessory: "none",
	rolePreviewNameEdited: false,
	rolePreviewLabelEdited: false,
	rolePreviewPromptEdited: false,
	rolePreviewToolsEdited: false,
	rolePreviewAccessoryEdited: false,
	hasReceivedRoleProposal: false,
	rolePreviewPromptEditMode: false,

	// Personality assistant split-screen state
	activePersonalityProposal: null as { name: string; label: string; description: string; prompt_fragment: string } | null,
	personalityPreviewName: "",
	personalityPreviewLabel: "",
	personalityPreviewDescription: "",
	personalityPreviewPromptFragment: "",
	personalityPreviewNameEdited: false,
	personalityPreviewLabelEdited: false,
	personalityPreviewDescriptionEdited: false,
	personalityPreviewPromptFragmentEdited: false,
	personalityPreviewPromptFragmentEditMode: false,

	// HTML preview panel (for live visual iteration — same pattern as goal/role assistant)
	isPreviewSession: false,
	previewPanelTab: "chat" as "chat" | "preview" | "goal" | "review" | "project",
	previewPanelHtml: "" as string,
	previewPanelFullscreen: false,

	// Unified preview panel tab (for non-assistant sessions with preview or goal proposal)
	previewPanelActiveTab: "preview" as "preview" | "goal" | "review" | "project",

	// Review pane state (agent-initiated markdown review documents)
	reviewDocuments: new Map() as Map<string, { title: string; markdown: string }>,
	reviewActiveTab: "" as string,
	reviewPanelOpen: false,

	/** Currently viewed goal dashboard (null = not on dashboard) */
	goalDashboardId: null as string | null,

	/** Staff agents list */
	staffList: [] as Array<{ id: string; name: string; description: string; state: string; lastWakeAt?: number; currentSessionId?: string; triggers: any[]; projectId?: string }>,

	// Staff assistant split-screen state
	activeStaffProposal: null as { name: string; description: string; prompt: string; triggers: string; cwd: string } | null,
	staffPreviewName: "",
	staffPreviewDescription: "",
	staffPreviewPrompt: "",
	staffPreviewTriggers: "[]",
	staffPreviewCwd: "",
	staffPreviewNameEdited: false,
	staffPreviewDescriptionEdited: false,
	staffPreviewPromptEdited: false,
	staffPreviewTriggersEdited: false,
	staffPreviewCwdEdited: false,
	staffPreviewPromptEditMode: false,

	/** Whether the setup wizard has been completed (safe default: true — don't show banner until we know) */
	setupComplete: true,

	// Workflow assistant preview state
	workflowPreviewId: "",
	workflowPreviewName: "",
	workflowPreviewDescription: "",
	workflowPreviewGates: "",

	// Setup assistant preview state — form fields populated by setup_proposal XML
	setupPreviewAction: "",
	setupFormStack: { language: "", framework: "", testing: "" },
	setupFormCommands: {
		build_command: "",
		test_command: "",
		typecheck_command: "",
		test_unit_command: "",
		test_e2e_command: "",

	} as Record<string, string>,
	setupFormModels: { session_model: "", review_model: "", naming_model: "" },
	setupFormSystemPrompt: "",
	setupFormSystemPromptEdited: false,
	setupFormCommandsEdited: {} as Record<string, boolean>,
	setupFormModelsEdited: {} as Record<string, boolean>,
	setupFormSaving: false,
	setupFormSaved: false,

	/** Cached roles for the role picker menu */
	roles: [] as Array<{ name: string; label: string; accessory: string }>,
	/** Whether the new-session role picker dropdown is open */
	rolePickerOpen: false,

	/** Docker sandbox status (fetched on demand) */
	sandboxStatus: null as { available: boolean; error?: string; dockerVersion?: string; imageExists?: boolean; configured: boolean; dockerfileExists?: boolean; buildCommand?: string } | null,
};

// ============================================================================
// EXPANDED GOALS PERSISTENCE
// ============================================================================

const EXPANDED_GOALS_KEY = "bobbit-expanded-goals";

export let expandedGoals: Set<string> = new Set(
	JSON.parse(localStorage.getItem(EXPANDED_GOALS_KEY) || "[]"),
);

// ── Per-project collapse state (Bug 4 fix) ─────────────────────────
// Stores collapsed project IDs. Default is expanded (not in set = expanded).
const COLLAPSED_UNGROUPED_KEY = "bobbit-collapsed-ungrouped";
const COLLAPSED_STAFF_KEY = "bobbit-collapsed-staff";

export let collapsedUngroupedProjects: Set<string> = new Set(
	JSON.parse(localStorage.getItem(COLLAPSED_UNGROUPED_KEY) || "[]"),
);
export let collapsedStaffProjects: Set<string> = new Set(
	JSON.parse(localStorage.getItem(COLLAPSED_STAFF_KEY) || "[]"),
);

export function isUngroupedExpanded(projectId: string): boolean {
	return !collapsedUngroupedProjects.has(projectId);
}

export function setUngroupedExpanded(projectId: string, value: boolean): void {
	if (value) collapsedUngroupedProjects.delete(projectId);
	else collapsedUngroupedProjects.add(projectId);
	localStorage.setItem(COLLAPSED_UNGROUPED_KEY, JSON.stringify([...collapsedUngroupedProjects]));
}

export function isStaffExpanded(projectId: string): boolean {
	return !collapsedStaffProjects.has(projectId);
}

export function setStaffSectionExpanded(projectId: string, value: boolean): void {
	if (value) collapsedStaffProjects.delete(projectId);
	else collapsedStaffProjects.add(projectId);
	localStorage.setItem(COLLAPSED_STAFF_KEY, JSON.stringify([...collapsedStaffProjects]));
}

// Per-project archived section expand state. Default = expanded (so toggling
// See Archived on immediately reveals archived items without an extra click).
// The set stores COLLAPSED project IDs; absence = expanded. This mirrors
// collapsedUngroupedProjects / collapsedStaffProjects.
const COLLAPSED_ARCHIVED_KEY = "bobbit-archived-collapsed-projects";
export let collapsedArchivedProjects: Set<string> = new Set(
	JSON.parse(localStorage.getItem(COLLAPSED_ARCHIVED_KEY) || "[]"),
);

export function isArchivedSectionExpanded(projectId: string): boolean {
	return !collapsedArchivedProjects.has(projectId);
}

export function setArchivedSectionExpanded(projectId: string, value: boolean): void {
	if (value) collapsedArchivedProjects.delete(projectId);
	else collapsedArchivedProjects.add(projectId);
	localStorage.setItem(COLLAPSED_ARCHIVED_KEY, JSON.stringify([...collapsedArchivedProjects]));
}

const COLLAPSED_TEAM_LEADS_KEY = "bobbit-collapsed-team-leads";
export let collapsedTeamLeadSessions: Set<string> = new Set(
	JSON.parse(localStorage.getItem(COLLAPSED_TEAM_LEADS_KEY) || "[]"),
);

export function saveExpandedGoals(): void {
	localStorage.setItem(EXPANDED_GOALS_KEY, JSON.stringify([...expandedGoals]));
}


export function toggleTeamLeadExpanded(sessionId: string): void {
	if (collapsedTeamLeadSessions.has(sessionId)) {
		collapsedTeamLeadSessions.delete(sessionId);
	} else {
		collapsedTeamLeadSessions.add(sessionId);
	}
	localStorage.setItem(COLLAPSED_TEAM_LEADS_KEY, JSON.stringify([...collapsedTeamLeadSessions]));
}

export function isTeamLeadExpanded(sessionId: string): boolean {
	return !collapsedTeamLeadSessions.has(sessionId);
}

const EXPANDED_DELEGATE_PARENTS_KEY = "bobbit-expanded-delegate-parents";
const expandedDelegateParents: Set<string> = new Set(
	JSON.parse(localStorage.getItem(EXPANDED_DELEGATE_PARENTS_KEY) || "[]"),
);

export function toggleArchivedParentExpanded(sessionId: string): void {
	if (expandedDelegateParents.has(sessionId)) {
		expandedDelegateParents.delete(sessionId);
	} else {
		expandedDelegateParents.add(sessionId);
	}
	localStorage.setItem(EXPANDED_DELEGATE_PARENTS_KEY, JSON.stringify([...expandedDelegateParents]));
}

export function isArchivedParentExpanded(sessionId: string): boolean {
	return expandedDelegateParents.has(sessionId);
}

export function resetArchivedExpandState(): void {
	// Remove archived goal IDs from expandedGoals
	const archivedGoalIds = new Set(state.goals.filter(g => g.archived).map(g => g.id));
	for (const id of archivedGoalIds) expandedGoals.delete(id);
	saveExpandedGoals();

	// Remove archived session IDs from expandedDelegateParents
	const archivedSessionIds = new Set(state.archivedSessions.map(s => s.id));
	for (const id of archivedSessionIds) expandedDelegateParents.delete(id);
	localStorage.setItem(EXPANDED_DELEGATE_PARENTS_KEY, JSON.stringify([...expandedDelegateParents]));

	// Reset archived team lead sessions from collapsedTeamLeadSessions
	// (archived team leads that were explicitly collapsed — remove them so they return to default)
	for (const id of archivedSessionIds) collapsedTeamLeadSessions.delete(id);
	localStorage.setItem(COLLAPSED_TEAM_LEADS_KEY, JSON.stringify([...collapsedTeamLeadSessions]));

	// Free memory — archived sessions will be re-fetched on next toggle-on
	state.archivedSessions = [];
}

// ============================================================================
// RENDER CALLBACK (set during init to break circular deps)
// ============================================================================

let _renderApp: () => void = () => {};
let _renderScheduled = false;

export function setRenderApp(fn: () => void): void {
	_renderApp = fn;
}

export function renderApp(): void {
	if (_renderScheduled) return;
	_renderScheduled = true;
	requestAnimationFrame(() => {
		_renderScheduled = false;
		_renderApp();
	});
}

/** Synchronous render — bypasses rAF debounce for cases needing immediate DOM update before layout measurement. */
export function renderAppSync(): void {
	_renderScheduled = false;
	_renderApp();
}

// ============================================================================
// PROJECT HELPERS
// ============================================================================

/** @deprecated No-op — provisional projects replace pending project placeholders. */
export function addPendingProject(_entry: { sessionId: string; dirPath: string; name: string }): void {
	// No-op: provisional projects are now real projects with a `provisional` flag.
	// Kept as export for backward compat with callers that haven't been updated yet.
}

/** @deprecated No-op — provisional projects are cleaned up via DELETE /api/projects/:id. */
export function removePendingProject(_sessionId: string): void {
	// No-op: see addPendingProject.
}

/** Update the project list and ensure activeProjectId stays in sync.
 *  Defaults to the first project when no explicit selection exists. */
export function setProjects(projects: Project[]): void {
	state.projects = projects;
	if (!state.activeProjectId || !projects.some(p => p.id === state.activeProjectId)) {
		state.activeProjectId = projects[0]?.id ?? null;
	}
}

// ============================================================================
// HELPERS
// ============================================================================

export function setSidebarWidth(w: number, persist = true): void {
	const clamped = clampSidebarWidth(w);
	state.sidebarWidth = clamped;
	applySidebarWidthVar(clamped);
	if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
}

export const SIDEBAR_BREAKPOINT = 768;
let windowWidth = window.innerWidth;

window.addEventListener("resize", () => {
	const prev = windowWidth;
	windowWidth = window.innerWidth;
	if ((prev < SIDEBAR_BREAKPOINT) !== (windowWidth < SIDEBAR_BREAKPOINT)) {
		renderApp();
	}
});

export function isDesktop(): boolean {
	return windowWidth >= SIDEBAR_BREAKPOINT;
}

export function hasActiveSession(): boolean {
	// As long as we have a remote agent we're "on" a session — the WebSocket
	// may momentarily be closed (e.g. mobile OS suspended the tab for >10s)
	// but the agent is only nulled on an explicit disconnect / session switch.
	// Keying the view off `.connected` (ws.readyState === OPEN) caused the
	// chat panel to unmount back to the sidebar/landing for a flash while the
	// socket reconnected. The reconnect banner already communicates status.
	return state.remoteAgent !== null;
}

export function activeSessionId(): string | undefined {
	// Don't highlight any session when a config page is open
	if (isConfigPageRoute()) return undefined;
	if (state.selectedSessionId) {
		// Only return selectedSessionId if we're connected/connecting to that session
		if (state.remoteAgent || state.connectingSessionId) return state.selectedSessionId;
		return undefined;
	}
	return state.remoteAgent?.gatewaySessionId;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const GW_URL_KEY = "gateway.url";
export const GW_TOKEN_KEY = "gateway.token";
export const GW_SESSION_KEY = "gateway.sessionId";

export const GOAL_STATE_LABELS: Record<GoalState, string> = {
	"todo": "To Do",
	"in-progress": "In Progress",
	"complete": "Complete",
	"shelved": "Shelved",
};

export const GOAL_STATE_COLORS: Record<GoalState, string> = {
	"todo": "text-muted-foreground",
	"in-progress": "text-yellow-600 dark:text-yellow-400",
	"complete": "text-green-600 dark:text-green-400",
	"shelved": "text-muted-foreground opacity-60",
};

// ============================================================================
// MEMOIZED SIDEBAR DATA
// ============================================================================

export interface SidebarData {
	staffSessionIds: Set<string>;
	ungroupedSessions: GatewaySession[];
	liveGoals: Goal[];
	archivedGoals: Goal[];
	projects: Project[];
}

let _sidebarDataCache: SidebarData | null = null;
let _sidebarCacheKey: string = "";

/** Memoized sidebar data — recomputes only when sessions, goals, or staff change. */
export function getSidebarData(): SidebarData {
	const key = `${state.gatewaySessions.length}:${state.archivedSessions.length}:${state.goals.length}:${state.staffList.length}:${state.projects.length}:${state.activeProjectId}:${state.goals.map(g => g.id + g.archived + (g.setupStatus || "") + (g.state || "") + (g.title || "") + (g.projectId || "")).join(",")}:${state.gatewaySessions.map(s => s.id + s.status + s.goalId + s.teamGoalId + s.delegateOf + (s.isCompacting ? "C" : "") + (s.title || "") + (s.projectId || "") + (s.archived ? "A" : "")).join(",")}:${state.archivedSessions.map(s => s.id + (s.projectId || "") + (s.teamGoalId || "") + (s.delegateOf || "") + (s.archived ? "A" : "")).join(",")}:${state.staffList.map(s => s.currentSessionId).join(",")}:${state.projects.map(p => p.id + (p.provisional ? "P" : "")).join(",")}`;
	if (_sidebarDataCache && _sidebarCacheKey === key) return _sidebarDataCache;

	const staffSessionIds = new Set<string>(state.staffList.map((s) => s.currentSessionId).filter((id): id is string => Boolean(id)));
	const ungroupedSessions = state.gatewaySessions.filter((s) => !s.goalId && !s.teamGoalId && !s.delegateOf && !staffSessionIds.has(s.id)).sort((a, b) => a.createdAt - b.createdAt);
	const sortedGoals = [...state.goals].sort((a, b) => a.createdAt - b.createdAt);
	const liveGoals = sortedGoals.filter(g => !g.archived);
	const archivedGoals = sortedGoals.filter(g => g.archived);

	_sidebarDataCache = { staffSessionIds, ungroupedSessions, liveGoals, archivedGoals, projects: state.projects };
	_sidebarCacheKey = key;
	return _sidebarDataCache;
}
