import type { ChatPanel } from "../ui/index.js";
import type { RemoteAgent, ConnectionStatus } from "./remote-agent.js";

// ============================================================================
// TYPES
// ============================================================================

export interface GatewaySession {
	id: string;
	title: string;
	cwd: string;
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

export type AppView = "disconnected" | "authenticated";

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
	/** Gate status cache: goalId → { passed, total, verifying } */
	gateStatusCache: new Map<string, { passed: number; total: number; verifying: boolean }>(),
	/** PR status cache: goalId → { state, url, number, reviewDecision } */
	prStatusCache: new Map<string, { state: string; url?: string; number?: number; reviewDecision?: string }>(),
	sessionsLoading: false,
	sessionsError: "",
	creatingSession: false,
	creatingSessionForGoalId: null as string | null,
	connectingSessionId: null as string | null,
	sessionPollTimer: null as ReturnType<typeof setInterval> | null,

	/** Whether the sidebar is collapsed */
	sidebarCollapsed: localStorage.getItem("bobbit-sidebar-collapsed") === "true",
	/** Whether to show archived sessions in the sidebar */
	showArchived: localStorage.getItem("bobbit-show-archived") === "true",
	/** Whether the archived section is expanded */

	/** Archived sessions (loaded on demand) */
	archivedSessions: [] as GatewaySession[],

	/** Active goal proposal from a goal-assistant session */
	activeGoalProposal: null as { title: string; spec: string; cwd?: string; workflow?: string } | null,

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
	previewPanelTab: "chat" as "chat" | "preview" | "goal",
	previewPanelHtml: "" as string,

	// Unified preview panel tab (for non-assistant sessions with preview or goal proposal)
	previewPanelActiveTab: "preview" as "preview" | "goal",

	/** Currently viewed goal dashboard (null = not on dashboard) */
	goalDashboardId: null as string | null,

	/** Staff agents list */
	staffList: [] as Array<{ id: string; name: string; description: string; state: string; lastWakeAt?: number; currentSessionId?: string; triggers: any[] }>,

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

	/** Cached roles for the role picker menu */
	roles: [] as Array<{ name: string; label: string; accessory: string }>,
	/** Whether the new-session role picker dropdown is open */
	rolePickerOpen: false,
};

// ============================================================================
// EXPANDED GOALS PERSISTENCE
// ============================================================================

const EXPANDED_GOALS_KEY = "bobbit-expanded-goals";
const UNGROUPED_EXPANDED_KEY = "bobbit-ungrouped-expanded";

export let expandedGoals: Set<string> = new Set(
	JSON.parse(localStorage.getItem(EXPANDED_GOALS_KEY) || "[]"),
);
export let ungroupedExpanded =
	localStorage.getItem(UNGROUPED_EXPANDED_KEY) !== "false";

const STAFF_EXPANDED_KEY = "bobbit-staff-expanded";
export let staffSectionExpanded =
	localStorage.getItem(STAFF_EXPANDED_KEY) !== "false";

export function setStaffSectionExpanded(value: boolean): void {
	staffSectionExpanded = value;
	localStorage.setItem(STAFF_EXPANDED_KEY, String(value));
}

const COLLAPSED_TEAM_LEADS_KEY = "bobbit-collapsed-team-leads";
export let collapsedTeamLeadSessions: Set<string> = new Set(
	JSON.parse(localStorage.getItem(COLLAPSED_TEAM_LEADS_KEY) || "[]"),
);

export function saveExpandedGoals(): void {
	localStorage.setItem(EXPANDED_GOALS_KEY, JSON.stringify([...expandedGoals]));
}

export function setUngroupedExpanded(value: boolean): void {
	ungroupedExpanded = value;
	localStorage.setItem(UNGROUPED_EXPANDED_KEY, String(value));
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
}

// ============================================================================
// RENDER CALLBACK (set during init to break circular deps)
// ============================================================================

let _renderApp: () => void = () => {};

export function setRenderApp(fn: () => void): void {
	_renderApp = fn;
}

export function renderApp(): void {
	_renderApp();
}

// ============================================================================
// HELPERS
// ============================================================================

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
	return state.remoteAgent !== null && state.remoteAgent.connected;
}

export function activeSessionId(): string | undefined {
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
