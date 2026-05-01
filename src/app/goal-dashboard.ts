import { html, nothing, svg, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import "../ui/components/VerificationOutputModal.js";
import "../ui/components/CostPopover.js";
import { ansiToHtml, hasAnsi } from "../ui/utils/ansi.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { state, renderApp, type Goal } from "./state.js";
import { gatewayFetch, deleteGoal, startTeam, teardownTeam, getTeamState, fetchGoalGates, fetchRoles, refreshPrStatusCache, fetchArchivedSessions, archivedSessionsLoaded, fetchGoalGitStatus, approveMutation, rejectMutation, signalManualGate, type GateState, type GateSignal } from "./api.js";
import { getChildGoals, getArchivedChildGoalsFrom } from "./render-helpers.js";
import { runGitStatusRefresh, abortableSleep } from "./git-status-refresh.js";
import { dispatchVerificationEvent } from "./verification-event-bus.js";
import { setHashRoute } from "./routing.js";
import { createAndConnectSession, connectToSession, startReattempt, terminateSession } from "./session-manager.js";
import { showGoalDialog, showNewGoalDialogForChild } from "./dialogs.js";
import { statusBobbit } from "./session-colors.js";
import { bobbitLoadingAnimation } from "../ui/components/BobbitLoadingAnimation.js";
import { coerceWorkflowGatesForRender, type SafeWorkflowGate } from "./workflow-gate-coercion.js";
import {
	shouldShowPlanTab as _shouldShowPlanTab,
	shouldShowTasksTab as _shouldShowTasksTab,
	countDescendantsFromAny as _countDescendantsFromAny,
	shouldShowChildrenTab as _shouldShowChildrenTab,
} from "./goal-dashboard-tab-visibility.js";
export { hasChildGoals } from "./goal-dashboard-tab-visibility.js";
import { planEdgePaths } from "./plan-edge-paths.js";
import { resolvePlanNodeState as resolvePlanNodeStateFn } from "./plan-node-state.js";
import { buildPlanSteps, isAdHocPlan } from "./plan-synthesis.js";

// ============================================================================
// TASK & COMMIT TYPES (mirrors server PersistedTask)
// ============================================================================

export type TaskType = "code" | "test" | "review";
export type TaskState = "todo" | "in-progress" | "blocked" | "complete" | "skipped";

export interface Task {
	id: string;
	title: string;
	type: TaskType;
	state: TaskState;
	assignedSessionId?: string;
	goalId: string;
	baseSha?: string;
	headSha?: string;
	branch?: string;
	resultSummary?: string;
	spec?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	dependsOn?: string[];
}

export interface CommitInfo {
	sha: string;
	shortSha: string;
	message: string;
	author: string;
	timestamp: string;
}

// ============================================================================
// DASHBOARD STATE
// ============================================================================

let currentGoalId: string | null = null;
let currentGoal: Goal | null = null;
let tasks: Task[] = [];
let commits: CommitInfo[] = [];
let gates: GateState[] = [];
let expandedGateIds: Set<string> = new Set();
let expandedSignalIds: Set<string> = new Set();
let gatePollTimer: ReturnType<typeof setInterval> | null = null;
let teamActive = false;
let teamStarting = false;
let teamStopping = false;
let loading = true;
let error = "";

/** Git merge status for goal branch */
interface GoalRepoEntry {
	branch?: string;
	primaryBranch?: string;
	isOnPrimary?: boolean;
	clean?: boolean;
	aheadOfPrimary?: number;
	behindPrimary?: number;
	mergedIntoPrimary?: boolean;
	status?: Array<{ file: string; status: string }>;
	statusFiles?: Array<{ file: string; status: string }>;
	summary?: string;
}
interface GoalGitStatus {
	branch: string;
	primaryBranch: string;
	isOnPrimary: boolean;
	clean: boolean;
	aheadOfPrimary: number;
	behindPrimary: number;
	mergedIntoPrimary: boolean;
	hasUpstream?: boolean;
	ahead?: number;
	behind?: number;
	unpushed?: boolean;
	status?: Array<{ file: string; status: string }>;
	summary?: string;
	/** Multi-repo per-repo envelope (Phase 4). Single-repo: { ".": <self> }. */
	repos?: Record<string, GoalRepoEntry>;
}
let gitStatus: GoalGitStatus | null = null;
/** Tri-state repo detection for the dashboard widget. Widget renders whenever !== 'no'. */
let gitRepoKnown: 'yes' | 'no' | 'unknown' = 'unknown';
/** performance.now() of last *started* refresh. Used to coalesce poll ticks. */
let gitStatusLastRefreshAt = 0;
/** In-flight refresh abort handle (one per dashboard). */
let gitStatusAbort: AbortController | null = null;

/** PR status for goal branch */
interface PrStatus {
	number: number;
	url: string;
	title: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	mergeable?: string;
	viewerIsAdmin?: boolean;
	reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	headRefName?: string;
}
let prStatus: PrStatus | null = null;

/** Aggregated cost for goal */
interface GoalCost {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
}
let goalCost: GoalCost | null = null;
let costPollTimer: ReturnType<typeof setInterval> | null = null;
let costPopoverOpen = false;
let gitStatusPollTimer: ReturnType<typeof setInterval> | null = null;
let setupPollTimer: ReturnType<typeof setInterval> | null = null;

/** Live verification tracking */
interface LiveVerification {
	gateId: string;
	signalId: string;
	steps: Array<{ name: string; type: string; status: string; phase?: number; durationMs?: number; output?: string; liveOutput?: string; startedAt: number; sessionId?: string }>;
	overallStatus: string;
	currentPhase?: number;
}
let liveVerifications: Map<string, LiveVerification> = new Map();
let liveVerifTimer: ReturnType<typeof setInterval> | null = null;
let expandedLiveStepKeys: Set<string> = new Set();
let expandedArtifactKeys: Set<string> = new Set();
let dashboardModalStep: { gateId: string; signalId: string; stepIndex: number; stepName: string; liveOutput: string; stepType: string } | null = null;

/** Dashboard event WebSocket — receives gate verification events without a session */
let dashboardWs: WebSocket | null = null;
let dashboardWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let dashboardWsIntentionalClose = false;

/** Current dashboard tab. Plan + Children added in nested-goals task 4.1 — see
 *  docs/design/nested-goals.md §10.2 / §10.3. The Plan tab is conditional on
 *  the goal's workflow exposing a `goal-plan` gate; the Children tab is
 *  conditional on the goal having any (transitive) child goals. The 4.2 / 4.3
 *  tasks fill in the actual SVG / card content. */
export type DashboardTab = "spec" | "tasks" | "agents" | "commits" | "gates" | "plan" | "children";
let dashboardTab: DashboardTab = "gates";

/** Role picker dropdown state */
let roleDropdownOpen = false;

// ============================================================================
// DASHBOARD EVENT WEBSOCKET
// ============================================================================

function connectDashboardWs(): void {
	dashboardWsIntentionalClose = false;
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const wsUrl = `${protocol}//${location.host}/ws/viewer`;
	const ws = new WebSocket(wsUrl);
	dashboardWs = ws;

	ws.addEventListener("open", () => {
		const token = localStorage.getItem("gateway.token");
		if (token) {
			ws.send(JSON.stringify({ type: "auth", token }));
		}
	});

	ws.addEventListener("message", (event) => {
		try {
			const msg = JSON.parse(event.data as string);
			dispatchVerificationEvent(msg);
		} catch {
			// ignore unparseable messages
		}
	});

	ws.addEventListener("close", () => {
		if (dashboardWsIntentionalClose || !currentGoalId) return;
		dashboardWsReconnectTimer = setTimeout(() => {
			if (currentGoalId && !dashboardWsIntentionalClose) {
				connectDashboardWs();
			}
		}, 3000);
	});

	ws.addEventListener("error", () => {
		// The close event fires after error, which handles reconnection
	});
}

function disconnectDashboardWs(): void {
	dashboardWsIntentionalClose = true;
	if (dashboardWsReconnectTimer != null) {
		clearTimeout(dashboardWsReconnectTimer);
		dashboardWsReconnectTimer = null;
	}
	if (dashboardWs && (dashboardWs.readyState === WebSocket.OPEN || dashboardWs.readyState === WebSocket.CONNECTING)) {
		dashboardWs.close();
	}
	dashboardWs = null;
}

// ============================================================================
// DATA FETCHING
// ============================================================================

export async function loadDashboardData(goalId: string): Promise<void> {
	// Snapshot whether we were navigating *from* the search page BEFORE the
	// router mutates the hash to #/goal/<id>. By the time the 404 catch block
	// runs, window.location.hash is already the goal-dashboard hash, so we
	// must capture this up front or the check can never be true. We also
	// accept a transient window flag that search-page.ts sets on click, which
	// survives an intervening history.replaceState race.
	let fromSearch = false;
	try {
		const hash = typeof window !== "undefined" ? window.location.hash : "";
		const flag = typeof window !== "undefined" && (window as any).__bobbitFromSearch === true;
		fromSearch = hash.startsWith("#/search") || flag;
		if (flag) (window as any).__bobbitFromSearch = false;
	} catch { /* ignore */ }

	disconnectDashboardWs();
	const sameGoal = currentGoalId === goalId && currentGoal != null;
	currentGoalId = goalId;
	// Only show the full-page loading skeleton on the initial load for this
	// goal. Re-entering loadDashboardData for the same goal (e.g. hashchange
	// race, navigation back to the same dashboard, or refreshDashboardGoal()
	// fallthrough) must keep the tab bar rendered — otherwise tests and users
	// see the dashboard flicker between skeleton and content under load.
	if (!sameGoal) {
		loading = true;
	}
	error = "";
	renderApp();

	connectDashboardWs();
	document.removeEventListener("gate-verification-event", handleLiveVerificationEvent);
	document.addEventListener("gate-verification-event", handleLiveVerificationEvent);
	startAgentPolling(goalId);
	startTaskPolling(goalId);

	try {
		const [goalRes, tasksRes, commitsRes, fetchedGates, gitStatusRes, costRes, prStatusRes] = await Promise.all([
			gatewayFetch(`/api/goals/${goalId}`),
			gatewayFetch(`/api/goals/${goalId}/tasks`),
			gatewayFetch(`/api/goals/${goalId}/commits?limit=20`).catch(() => null),
			fetchGoalGates(goalId),
			gatewayFetch(`/api/goals/${goalId}/git-status`).catch(() => null),
			gatewayFetch(`/api/goals/${goalId}/cost`).catch(() => null),
			gatewayFetch(`/api/goals/${goalId}/pr-status`).catch(() => null),
		]);

		if (!goalRes.ok) throw new Error(`Goal not found (${goalRes.status})`);

		currentGoal = await goalRes.json();

		// Propagate goal metadata to sidebar's goal list so it stays in sync
		// (e.g. setupStatus may have changed from "preparing" to "ready")
		const sidebarIdx = state.goals.findIndex((g) => g.id === goalId);
		if (sidebarIdx >= 0) {
			const sidebarGoal = state.goals[sidebarIdx];
			if (sidebarGoal.setupStatus !== currentGoal!.setupStatus || sidebarGoal.state !== currentGoal!.state) {
				state.goals[sidebarIdx] = { ...sidebarGoal, setupStatus: currentGoal!.setupStatus, setupError: currentGoal!.setupError, state: currentGoal!.state };
			}
		}

		if (tasksRes.ok) {
			const data = await tasksRes.json();
			tasks = data.tasks || [];
		} else {
			tasks = [];
		}

		if (commitsRes && commitsRes.ok) {
			const data = await commitsRes.json();
			commits = data.commits || [];
		} else {
			commits = [];
		}

		gates = fetchedGates;

		if (gitStatusRes && gitStatusRes.ok) {
			gitStatus = await gitStatusRes.json();
			gitRepoKnown = 'yes';
			gitStatusLastRefreshAt = performance.now();
		} else if (gitStatusRes && gitStatusRes.status === 400) {
			try {
				const body = await gitStatusRes.json();
				if (body?.error === 'Not a git repository') gitRepoKnown = 'no';
			} catch { /* ignore */ }
		}

		if (costRes && costRes.ok) {
			goalCost = await costRes.json();
		}

		if (prStatusRes && prStatusRes.ok) {
			prStatus = await prStatusRes.json();
			// Sync to sidebar cache so badge persists even if polling skips this goal
			if (prStatus && currentGoalId) state.prStatusCache.set(currentGoalId, prStatus);
		}

		const teamState = await getTeamState(goalId);
		teamActive = teamState != null;

		startGatePolling(goalId);
		startCostPolling(goalId);
		startGitStatusPolling(goalId);

		// Start setup status polling if worktree is still being prepared
		if (currentGoal && currentGoal.setupStatus === "preparing") {
			startSetupStatusPoll(goalId);
		}

		// Bootstrap live verification state from REST (catches in-progress verifications)
		fetchActiveVerifications(goalId);

		loading = false;

		// Lazy-load archived sessions for assignee lookups (fire-and-forget)
		if (!archivedSessionsLoaded()) {
			fetchArchivedSessions();
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		loading = false;
		// If we came from the search page and the goal is missing, dispatch a
		// page-local event so the search page can show a non-blocking toast
		// and mark the row stale.
		try {
			const isMissing = /not found|\b404\b/i.test(error);
			if (isMissing && fromSearch) {
				window.dispatchEvent(new CustomEvent("search-result-stale", {
					detail: { kind: "goal", id: goalId },
				}));
			}
		} catch { /* ignore */ }
	}

	renderApp();
}

async function fetchActiveVerifications(goalId: string): Promise<void> {
	try {
		const resp = await gatewayFetch(`/api/goals/${goalId}/verifications/active`);
		if (!resp.ok) return;
		const data = await resp.json();
		const verifications: Array<any> = data.verifications || [];

		for (const v of verifications) {
			const key = `${v.gateId}:${v.signalId}`;
			// Only seed if we don't already have a live entry (WS events take priority)
			if (!liveVerifications.has(key)) {
				liveVerifications.set(key, {
					gateId: v.gateId,
					signalId: v.signalId,
					steps: v.steps.map((s: any) => ({
						name: s.name,
						type: s.type,
						status: s.status,
						phase: s.phase,
						durationMs: s.durationMs,
						output: s.output,
						startedAt: s.startedAt,
					})),
					overallStatus: v.overallStatus,
					currentPhase: v.currentPhase,
				});
			}
		}

		// Start timer if we have running verifications
		if (verifications.some((v: any) => v.overallStatus === "running")) {
			startLiveVerifTimer();
		}

		renderApp();
	} catch (err) {
		// Non-fatal — WS events will still work
		console.warn("[dashboard] Failed to fetch active verifications:", err);
	}
}

export function clearDashboardState(): void {
	disconnectDashboardWs();
	currentGoalId = null;
	currentGoal = null;
	tasks = [];
	commits = [];
	gates = [];
	expandedGateIds = new Set();
	expandedSignalIds = new Set();
	teamActive = false;
	teamStarting = false;
	teamStopping = false;
	loading = true;
	error = "";
	dashboardTab = "gates";
	roleDropdownOpen = false;
	gitStatus = null;
	gitRepoKnown = 'unknown';
	if (gitStatusAbort) { gitStatusAbort.abort(); gitStatusAbort = null; }
	gitStatusLastRefreshAt = 0;
	prStatus = null;
	goalCost = null;
	costPopoverOpen = false;
	stopAgentPolling();
	stopTaskPolling();
	stopGatePolling();
	stopCostPolling();
	stopGitStatusPolling();
	stopSetupStatusPoll();
	document.removeEventListener("gate-verification-event", handleLiveVerificationEvent);
	liveVerifications = new Map();
	expandedLiveStepKeys = new Set();
	expandedArtifactKeys = new Set();
	dashboardModalStep = null;
	stopLiveVerifTimer();
}

/**
 * Refresh just the goal metadata for the currently-displayed dashboard.
 * Called when a goal_setup_complete/error event arrives so the "Setting up
 * worktree…" banner dismisses without a full page reload.
 */
export async function refreshDashboardGoal(): Promise<void> {
	if (!currentGoalId) return;
	try {
		const res = await gatewayFetch(`/api/goals/${currentGoalId}`);
		if (res.ok) {
			currentGoal = await res.json();
			// Propagate setupStatus to sidebar's goal list so it stays in sync
			const idx = state.goals.findIndex((g) => g.id === currentGoalId);
			if (idx >= 0 && currentGoal!.setupStatus !== state.goals[idx].setupStatus) {
				state.goals[idx] = { ...state.goals[idx], setupStatus: currentGoal!.setupStatus, setupError: currentGoal!.setupError };
			}
			renderApp();
		}
	} catch { /* ignore — polling will catch up */ }
}

// ============================================================================
// AGENT TYPES & POLLING
// ============================================================================

export interface TeamAgent {
	sessionId: string;
	role: string;
	status: string;
	worktreePath: string;
	branch: string;
	task: string;
	createdAt: number;
	archivedAt?: number;
	title?: string;
	accessory?: string;
	taskId?: string;
}

let agents: TeamAgent[] = [];
let agentPollTimer: ReturnType<typeof setInterval> | null = null;
let taskPollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchAgents(goalId: string): Promise<TeamAgent[]> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/agents?include=archived`);
		if (!res.ok) return [];
		const data = await res.json();
		return data.agents ?? [];
	} catch {
		return [];
	}
}

function startTaskPolling(goalId: string): void {
	stopTaskPolling();
	taskPollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		try {
			const res = await gatewayFetch(`/api/goals/${goalId}/tasks`);
			if (res.ok) {
				const data = await res.json();
				const newTasks: Task[] = data.tasks || [];
				if (JSON.stringify(newTasks) !== JSON.stringify(tasks)) {
					tasks = newTasks;
					renderApp();
				}
			}
		} catch { /* ignore */ }
	}, 10_000);
}

function stopTaskPolling(): void {
	if (taskPollTimer) { clearInterval(taskPollTimer); taskPollTimer = null; }
}

function startAgentPolling(goalId: string): void {
	stopAgentPolling();
	fetchAgents(goalId).then((a) => { agents = a; renderApp(); });
	agentPollTimer = setInterval(async () => {
		agents = await fetchAgents(goalId);
		const teamState = await getTeamState(goalId);
		teamActive = teamState != null;
		renderApp();
	}, 5000);
}

function stopAgentPolling(): void {
	if (agentPollTimer) { clearInterval(agentPollTimer); agentPollTimer = null; }
	agents = [];
}

function startGatePolling(goalId: string): void {
	stopGatePolling();
	gatePollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		try {
			const newGates = await fetchGoalGates(goalId);
			if (JSON.stringify(newGates) !== JSON.stringify(gates)) {
				gates = newGates;
				// Sync to sidebar gate status cache
				const goal = state.goals.find(g => g.id === goalId);
				if (goal?.workflow?.gates.length) {
					const passed = newGates.filter((g: any) => g.status === "passed").length;
					const total = goal.workflow.gates.length;
					const verifying = newGates.some((g: any) => g.signals?.some((s: any) => s.verification?.status === "running"));
					const verifyingCount = newGates.filter((g: any) => g.status !== "passed" && g.signals?.some((s: any) => s.verification?.status === "running")).length;
					state.gateStatusCache.set(goalId, { passed, total, verifying, verifyingCount });
				}
				renderApp();
			}
			// Also refresh active verifications alongside gate polling
			fetchActiveVerifications(goalId);
		} catch { /* ignore */ }
	}, 8_000);
}

function stopGatePolling(): void {
	if (gatePollTimer) { clearInterval(gatePollTimer); gatePollTimer = null; }
}

// ── Live verification event handling ──

function handleLiveVerificationEvent(e: Event) {
	const detail = (e as CustomEvent).detail;
	if (!detail || detail.goalId !== currentGoalId) return;

	// Plan-mutation banner events (§10.5). These arrive on the same dashboard
	// WS as the gate-verification stream. Banner state lives on `state.pendingMutation`.
	if (detail.type === "goal_mutation_pending") {
		state.pendingMutation = {
			goalId: detail.goalId,
			requestId: detail.requestId,
			classification: detail.classification,
			summary: detail.summary || "",
			addedNodes: Array.isArray(detail.addedNodes) ? detail.addedNodes : undefined,
			removedNodes: Array.isArray(detail.removedNodes) ? detail.removedNodes : undefined,
			droppedCriteria: Array.isArray(detail.droppedCriteria) ? detail.droppedCriteria : undefined,
			changedDeps: detail.changedDeps,
			receivedAt: Date.now(),
		};
		renderApp();
		return;
	}
	if (detail.type === "goal_mutation_resolved") {
		if (state.pendingMutation?.requestId === detail.requestId) {
			state.pendingMutation = undefined;
			renderApp();
		}
		return;
	}

	const key = `${detail.gateId}:${detail.signalId}`;

	switch (detail.type) {
		case "gate_verification_started": {
			const now = detail.startedAt || Date.now();
			const stepDefs: Array<{ name: string; type: string; phase?: number }> = detail.steps || [];
			const minPhase = stepDefs.length > 0 ? Math.min(...stepDefs.map((s: any) => s.phase ?? 0)) : 0;
			const steps = stepDefs.map((s: any) => ({
				name: s.name, type: s.type, phase: s.phase ?? 0,
				status: (s.phase ?? 0) === minPhase ? "running" : "waiting",
				startedAt: now,
			}));
			liveVerifications.set(key, { gateId: detail.gateId, signalId: detail.signalId, steps, overallStatus: "running", currentPhase: minPhase });
			startLiveVerifTimer();
			renderApp();
			break;
		}
		case "gate_verification_phase_started": {
			const entry = liveVerifications.get(key);
			if (entry) {
				entry.currentPhase = detail.phase;
				const stepIndices: number[] = detail.stepIndices || [];
				for (const idx of stepIndices) {
					if (idx >= 0 && idx < entry.steps.length && entry.steps[idx].status === "waiting") {
						entry.steps[idx] = { ...entry.steps[idx], status: "running", startedAt: Date.now() };
					}
				}
				renderApp();
			}
			break;
		}
		case "gate_verification_step_started": {
			const entry = liveVerifications.get(key);
			if (entry && entry.steps[detail.stepIndex]) {
				entry.steps[detail.stepIndex] = {
					...entry.steps[detail.stepIndex],
					phase: detail.phase ?? entry.steps[detail.stepIndex].phase,
					startedAt: detail.startedAt || entry.steps[detail.stepIndex].startedAt,
					sessionId: detail.sessionId,
				};
				renderApp();
			}
			break;
		}
		case "gate_verification_step_complete": {
			let entry = liveVerifications.get(key);
			if (!entry) {
				// Create entry dynamically — we missed the started event
				entry = { gateId: detail.gateId, signalId: detail.signalId, steps: [], overallStatus: "running" };
				liveVerifications.set(key, entry);
				startLiveVerifTimer();
			}
			// Expand steps array if stepIndex is beyond current length
			while (entry.steps.length <= detail.stepIndex) {
				entry.steps.push({ name: `Step ${entry.steps.length + 1}`, type: "unknown", status: "running", startedAt: Date.now() });
			}
			entry.steps[detail.stepIndex] = {
				...entry.steps[detail.stepIndex],
				name: detail.stepName || entry.steps[detail.stepIndex].name,
				status: detail.status,
				phase: detail.phase ?? entry.steps[detail.stepIndex].phase,
				durationMs: detail.durationMs,
				output: detail.output,
				sessionId: detail.sessionId ?? entry.steps[detail.stepIndex].sessionId,
			};
			renderApp();
			break;
		}
		case "gate_verification_step_output": {
			const entry = liveVerifications.get(key);
			if (entry && entry.steps[detail.stepIndex]) {
				const step = entry.steps[detail.stepIndex];
				let out = (step.liveOutput || "") + (detail.text || "");
				if (out.length > 512 * 1024) out = out.slice(-512 * 1024);
				step.liveOutput = out;
			}
			break;
		}
		case "gate_verification_complete": {
			const entry = liveVerifications.get(key);
			if (entry) {
				entry.overallStatus = detail.status;
				// Re-fetch gates to update signal history
				if (currentGoalId) {
					fetchGoalGates(currentGoalId).then(g => { gates = g; renderApp(); });
				}
			}
			stopLiveVerifTimerIfDone();
			renderApp();
			break;
		}
	}
}

function startLiveVerifTimer() {
	if (liveVerifTimer) return;
	liveVerifTimer = setInterval(() => renderApp(), 1000);
}

function stopLiveVerifTimerIfDone() {
	const hasRunning = [...liveVerifications.values()].some(v => v.overallStatus === "running");
	if (!hasRunning && liveVerifTimer) {
		clearInterval(liveVerifTimer);
		liveVerifTimer = null;
	}
}

function stopLiveVerifTimer() {
	if (liveVerifTimer) { clearInterval(liveVerifTimer); liveVerifTimer = null; }
}

function startCostPolling(goalId: string): void {
	stopCostPolling();
	costPollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		try {
			const res = await gatewayFetch(`/api/goals/${goalId}/cost`);
			if (res.ok) {
				const newCost: GoalCost = await res.json();
				if (newCost.totalCost !== goalCost?.totalCost) {
					goalCost = newCost;
					renderApp();
				}
			}
		} catch { /* ignore */ }
	}, 15_000);
}

function stopCostPolling(): void {
	if (costPollTimer) { clearInterval(costPollTimer); costPollTimer = null; }
}

/** Retry-with-backoff refresh for the dashboard git widget. Shares the same
 *  tri-state + abort contract as the session widget. */
async function refreshGoalGitStatus(
	goalId: string,
	opts?: { fetch?: boolean; untracked?: boolean },
): Promise<void> {
	if (gitStatusAbort) gitStatusAbort.abort();
	const ctl = new AbortController();
	gitStatusAbort = ctl;
	gitStatusLastRefreshAt = performance.now();

	let changed = false;
	await runGitStatusRefresh(ctl.signal, {
		fetch: (signal) => fetchGoalGitStatus(goalId, {
			fetch: opts?.fetch,
			untracked: opts?.untracked,
			signal,
		}),
		sleep: abortableSleep,
		isStale: () => currentGoalId !== goalId,
		onOk: (data) => {
			if (currentGoalId !== goalId) return;
			if (JSON.stringify(data) !== JSON.stringify(gitStatus)) {
				gitStatus = data as GoalGitStatus;
				changed = true;
			}
			gitRepoKnown = 'yes';
		},
		onNotARepo: () => {
			if (currentGoalId !== goalId) return;
			if (gitRepoKnown !== 'no' || gitStatus !== null) {
				gitRepoKnown = 'no';
				gitStatus = null;
				changed = true;
			}
		},
		onFinally: () => {
			if (gitStatusAbort === ctl) gitStatusAbort = null;
			if (changed) renderApp();
		},
	});
}

function startGitStatusPolling(goalId: string): void {
	stopGitStatusPolling();
	gitStatusPollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		if (document.visibilityState !== "visible") return;
		if (gitRepoKnown === 'no') { stopGitStatusPolling(); return; }
		// Coalesce: skip tick if any refresh started in the last 10s.
		const elapsed = performance.now() - gitStatusLastRefreshAt;
		if (elapsed < 10_000) {
			// still poll PR status — fall through to PR-only block below
		} else {
			refreshGoalGitStatus(goalId);
		}
		let needRender = false;
		try {
			const prRes = await gatewayFetch(`/api/goals/${goalId}/pr-status`).catch(() => null);
			if (prRes && prRes.ok) {
				const newPr: PrStatus = await prRes.json();
				if (JSON.stringify(newPr) !== JSON.stringify(prStatus)) {
					prStatus = newPr;
					needRender = true;
					// Sync to sidebar cache
					if (goalId) state.prStatusCache.set(goalId, newPr);
				}
			} else if (prStatus !== null) {
				prStatus = null;
				needRender = true;
			}
		} catch { /* ignore */ }
		if (needRender) renderApp();
	}, 60_000);
}

function stopGitStatusPolling(): void {
	if (gitStatusPollTimer) { clearInterval(gitStatusPollTimer); gitStatusPollTimer = null; }
}

function startSetupStatusPoll(goalId: string): void {
	stopSetupStatusPoll();
	setupPollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		await refreshDashboardGoal();
		// Stop polling once status changes away from "preparing"
		if (currentGoal && currentGoal.setupStatus !== "preparing") {
			stopSetupStatusPoll();
		}
	}, 3000);
}

function stopSetupStatusPoll(): void {
	if (setupPollTimer) { clearInterval(setupPollTimer); setupPollTimer = null; }
}

// ============================================================================
// HELPERS
// ============================================================================

function getElapsedTime(task: Task): string {
	if (task.state === "complete" || task.state === "skipped") {
		const elapsed = task.updatedAt - task.createdAt;
		const mins = Math.floor(elapsed / 60_000);
		if (mins < 1) return "<1m";
		if (mins < 60) return `${mins}m`;
		const hours = Math.floor(mins / 60);
		return `${hours}h ${mins % 60}m`;
	}
	const elapsed = Date.now() - task.createdAt;
	const mins = Math.floor(elapsed / 60_000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

function typeColor(type: TaskType): string {
	switch (type) {
		case "code": return "var(--type-code)";
		case "test": return "var(--type-test)";
		case "review": return "var(--type-review)";
	}
}

function typeLabel(type: TaskType): string {
	switch (type) {
		case "code": return "Code";
		case "test": return "Test";
		case "review": return "Review";
	}
}

function findAssigneeSession(sessionId: string | undefined) {
	if (!sessionId) return null;
	return state.gatewaySessions.find((s) => s.id === sessionId)
		|| state.archivedSessions.find((s) => s.id === sessionId)
		|| null;
}

function formatRelativeTime(timestamp: string | number): string {
	const ts = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
	const diffMs = Date.now() - ts;
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
	coder: { bg: "oklch(0.62 0.15 250 / 0.15)", text: "oklch(0.72 0.15 250)" },
	tester: { bg: "oklch(0.65 0.15 145 / 0.15)", text: "oklch(0.72 0.15 145)" },
	reviewer: { bg: "oklch(0.70 0.14 75 / 0.15)", text: "oklch(0.78 0.14 75)" },
	lead: { bg: "oklch(0.55 0.15 290 / 0.15)", text: "oklch(0.72 0.15 290)" },
	"team-lead": { bg: "oklch(0.55 0.15 290 / 0.15)", text: "oklch(0.72 0.15 290)" },
};

function getRoleColor(role: string): { bg: string; text: string } {
	return ROLE_COLORS[role] ?? ROLE_COLORS["coder"];
}

function getRoleLabel(role: string): string {
	if (role === "team-lead") return "LEAD";
	return role.toUpperCase();
}

function formatAgentName(agent: TeamAgent): string {
	const session = state.gatewaySessions.find((s) => s.id === agent.sessionId)
		|| state.archivedSessions.find((s) => s.id === agent.sessionId);
	if (session?.title) return session.title;
	if (agent.role === "team-lead") return "Team Lead";
	return agent.role.charAt(0).toUpperCase() + agent.role.slice(1);
}

// ============================================================================
// GATE PIPELINE HELPERS
// ============================================================================

/** Build a map from gate ID to GateState from the fetched gates array */
function getGateStatusMap(): Map<string, GateState> {
	const map = new Map<string, GateState>();
	for (const g of gates) {
		map.set(g.gateId, g);
	}
	return map;
}

interface GatePipelineNode {
	id: string;
	name: string;
	status: "pending" | "passed" | "failed" | "running";
	signalCount: number;
	dependsOn: string[];
}

/** Compute dependency depth for each workflow gate via BFS from roots.
 *
 *  Caller must pass `wfGates` already coerced via
 *  `coerceWorkflowGatesForRender` so `dependsOn` is guaranteed to be a
 *  string[]. The `unknown` array shape that arrives from the goal
 *  snapshot is NOT safe to walk directly — see the regression history
 *  documented in `workflow-gate-coercion.ts`. */
function computeGateDepthLevels(
	wfGates: Array<SafeWorkflowGate>,
	statusMap: Map<string, GateState>,
): GatePipelineNode[][] {
	const depthMap = new Map<string, number>();
	const gateMap = new Map(wfGates.map(g => [g.id, g]));

	const visiting = new Set<string>();
	function getDepth(id: string): number {
		if (depthMap.has(id)) return depthMap.get(id)!;
		if (visiting.has(id)) return 0;
		visiting.add(id);
		const gate = gateMap.get(id);
		if (!gate || gate.dependsOn.length === 0) {
			depthMap.set(id, 0);
			return 0;
		}
		const d = Math.max(...gate.dependsOn.map(dep => getDepth(dep))) + 1;
		depthMap.set(id, d);
		return d;
	}

	for (const g of wfGates) getDepth(g.id);

	const maxDepth = Math.max(0, ...Array.from(depthMap.values()));
	const levels: GatePipelineNode[][] = [];
	for (let d = 0; d <= maxDepth; d++) {
		const nodesAtDepth: GatePipelineNode[] = [];
		for (const g of wfGates) {
			if (depthMap.get(g.id) === d) {
				const gs = statusMap.get(g.id);
				// Determine if any signal is currently running
				const hasRunning = gs?.signals?.some(s => s.verification.status === "running");
				let status: GatePipelineNode["status"] = gs?.status ?? "pending";
				if (hasRunning && status !== "passed") status = "running";
				nodesAtDepth.push({
					id: g.id,
					name: g.name,
					status,
					signalCount: gs?.signals?.length ?? 0,
					dependsOn: g.dependsOn,
				});
			}
		}
		if (nodesAtDepth.length > 0) levels.push(nodesAtDepth);
	}
	return levels;
}

// ============================================================================
// COMMIT BADGE DERIVATION
// ============================================================================

type BadgeStatus = "pass" | "fail" | "stale" | "pending";

interface CommitBadges {
	tests?: BadgeStatus;
	review?: BadgeStatus;
}

function deriveBadges(commitList: CommitInfo[], taskList: Task[]): Map<string, CommitBadges> {
	const badges = new Map<string, CommitBadges>();
	for (const c of commitList) badges.set(c.sha, {});

	const testTasks = taskList.filter(t => t.type === "test" && t.headSha);
	const reviewTasks = taskList.filter(t => t.type === "review" && t.headSha);

	for (const task of testTasks) {
		const sha = task.headSha!;
		if (!badges.has(sha)) continue;
		const b = badges.get(sha)!;
		if (task.state === "complete") b.tests = "pass";
		else if (task.state === "skipped") b.tests = "fail";
		else if (task.state === "in-progress") b.tests = "pending";
	}

	for (const task of reviewTasks) {
		const sha = task.headSha!;
		if (!badges.has(sha)) continue;
		const b = badges.get(sha)!;
		if (task.state === "complete") b.review = "pass";
		else if (task.state === "skipped") b.review = "fail";
		else if (task.state === "in-progress") b.review = "pending";
	}

	return badges;
}

// ============================================================================
// TEAM ACTIONS
// ============================================================================

async function handleStartTeam(goalId: string): Promise<void> {
	teamStarting = true;
	renderApp();
	const sessionId = await startTeam(goalId);
	teamStarting = false;
	if (sessionId) {
		teamActive = true;
		renderApp();
		connectToSession(sessionId, false);
	} else {
		renderApp();
	}
}

async function handleEndTeam(goalId: string): Promise<void> {
	// Find the team lead session so we can route through terminateSession(),
	// which handles confirmation, active-session disconnect, and local cleanup.
	const teamLeadSession = state.gatewaySessions.find(
		(s) => (s.goalId === goalId || s.teamGoalId === goalId) && s.role === "team-lead",
	);
	if (teamLeadSession) {
		teamStopping = true;
		renderApp();
		await terminateSession(teamLeadSession.id, { goalId, isTeamLead: true });
		teamStopping = false;
		// Re-check: if the team lead session is gone, the teardown succeeded.
		// If the user cancelled the confirmation, the session still exists.
		const stillExists = state.gatewaySessions.some(
			(s) => s.id === teamLeadSession.id,
		);
		if (!stillExists) {
			teamActive = false;
			agents = [];
		}
		renderApp();
	} else {
		// Fallback: no team lead session found, tear down directly
		teamStopping = true;
		renderApp();
		const ok = await teardownTeam(goalId);
		teamStopping = false;
		if (ok) {
			teamActive = false;
			agents = [];
		}
		renderApp();
	}
}

// ============================================================================
// PR MERGE HANDLER
// ============================================================================

async function handlePrMerge(e: CustomEvent<{ method: string; admin?: boolean; branch?: string }>): Promise<void> {
	if (!currentGoalId) return;
	const widget = e.target as import('../ui/components/GitStatusWidget.js').GitStatusWidget;
	const goalId = currentGoalId;
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/pr-merge`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ method: e.detail.method, ...(e.detail.admin ? { admin: true } : {}), ...(e.detail.branch ? { branch: e.detail.branch } : {}) }),
		});
		if (res.ok) {
			widget.setMergeResult();
		} else {
			const data = await res.json().catch(() => ({ error: 'Merge failed' }));
			widget.setMergeResult(data.error || 'Merge failed');
		}
	} catch (err) {
		widget.setMergeResult(err instanceof Error ? err.message : 'Network error');
	}
	// Re-fetch both git-status and pr-status
	try {
		const [gitRes, prRes] = await Promise.all([
			gatewayFetch(`/api/goals/${goalId}/git-status`).catch(() => null),
			gatewayFetch(`/api/goals/${goalId}/pr-status`).catch(() => null),
		]);
		if (gitRes && gitRes.ok) gitStatus = await gitRes.json();
		if (prRes && prRes.ok) {
			prStatus = await prRes.json();
			// Immediately update the goal grouping cache so it reflects the merge
			if (prStatus) state.prStatusCache.set(goalId, prStatus);
		}
		else prStatus = null;
	} catch { /* ignore */ }
	refreshPrStatusCache();
	renderApp();
}

async function handleGitFetch(): Promise<void> {
	if (!currentGoalId) return;
	await refreshGoalGitStatus(currentGoalId, { fetch: true });
}

// ============================================================================
// SVG ICON HELPERS
// ============================================================================

const svgArrowLeft = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`;
const svgPencil = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const svgTrash = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
const svgCrown = html`<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 12h12v1.5H2V12zm0-1L1 4l4 3 3-5 3 5 4-3-1 7H2z"/></svg>`;
const svgStop = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;
const svgPlus = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;
const svgChevronDown = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const svgDollar = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;
const svgFolder = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
const svgTasks = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/></svg>`;
const svgAgents = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
const svgCommit = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/></svg>`;
const svgGate = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22V2"/><path d="M5 12H2"/><path d="M22 12h-3"/><circle cx="12" cy="12" r="4"/><path d="m15 9 2-2"/><path d="m7 15 2-2"/></svg>`;
const svgClock = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;
const svgPhaseArrow = html`<svg viewBox="0 0 20 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M0 6h16M13 2l4 4-4 4"/></svg>`;
const svgArchive = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`;
const svgDoc = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;

// ============================================================================
// RENDER: PARENT BREADCRUMB (nested-goals §10 — task 1.6)
// ============================================================================

/** Maximum number of ancestor links shown inline in the breadcrumb. Anything
 *  deeper is collapsed to a single leading `…` ellipsis. Matches the spec in
 *  docs/design/nested-goals.md §10 (task 1.6 — full breadcrumb up to depth 5,
 *  truncate above with `…`). */
export const BREADCRUMB_MAX_DEPTH = 5;

/** Walk the ancestor chain of `goal` using `goals` as the snapshot. Returns
 *  ancestors ordered root → … → immediate-parent (immediate parent is last).
 *  Excludes `goal` itself. Cycle-safe via a visited set; caps the walk at
 *  100 hops as a defensive guard against malformed snapshots. Stops early if
 *  the parent reference dangles (parent goal not present in the array). */
export function buildAncestorChainFrom(goal: { id: string; parentGoalId?: string }, goals: Goal[]): Goal[] {
	const byId = new Map<string, Goal>();
	for (const g of goals) byId.set(g.id, g);
	const chain: Goal[] = [];
	const seen = new Set<string>([goal.id]);
	let cur: Goal | undefined = goal.parentGoalId ? byId.get(goal.parentGoalId) : undefined;
	let hops = 0;
	while (cur && !seen.has(cur.id) && hops < 100) {
		chain.unshift(cur);
		seen.add(cur.id);
		cur = cur.parentGoalId ? byId.get(cur.parentGoalId) : undefined;
		hops++;
	}
	return chain;
}

/** Compute the slice of the ancestor chain that should render inline. If the
 *  chain is longer than `max`, the leading entries are dropped and the caller
 *  is told to render a leading `…` ellipsis instead. Pure / no DOM. */
export function computeBreadcrumbVisible(
	chain: Goal[],
	max: number = BREADCRUMB_MAX_DEPTH,
): { truncated: boolean; visible: Goal[] } {
	if (chain.length <= max) return { truncated: false, visible: chain.slice() };
	return { truncated: true, visible: chain.slice(chain.length - max) };
}

function renderParentBreadcrumb(goal: Goal): TemplateResult | typeof nothing {
	if (!goal.parentGoalId) return nothing;
	const chain = buildAncestorChainFrom(goal, state.goals);
	if (chain.length === 0) return nothing;
	const { truncated, visible } = computeBreadcrumbVisible(chain);
	return html`
		<div class="goal-breadcrumb" data-testid="goal-breadcrumb" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 16px 0;font-size:12px;color:var(--text-tertiary);">
			${truncated ? html`<span class="goal-breadcrumb-ellipsis" title="Earlier ancestors hidden">…</span>` : nothing}
			${visible.map((a) => html`
				<span class="goal-breadcrumb-arrow" aria-hidden="true">←</span>
				<a
					class="goal-breadcrumb-link"
					href="#/goal/${a.id}"
					title="Go to parent goal: ${a.title}"
					style="color:var(--text-secondary);text-decoration:none;"
					@mouseover=${(e: Event) => { (e.currentTarget as HTMLElement).style.textDecoration = "underline"; }}
					@mouseout=${(e: Event) => { (e.currentTarget as HTMLElement).style.textDecoration = "none"; }}
				>${a.title}</a>
			`)}
		</div>
	`;
}

// ============================================================================
// RENDER: NAV BAR
// ============================================================================

async function handleRetrySetup(goalId: string): Promise<void> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/retry-setup`, { method: "POST" });
		if (res.ok) {
			// Optimistically update local state
			if (currentGoal) {
				(currentGoal as any).setupStatus = "preparing";
				(currentGoal as any).setupError = undefined;
			}
			renderApp();
		}
	} catch (err) {
		console.error("[goal-dashboard] Retry setup failed:", err);
	}
}

function renderSetupBanner(goal: Goal): TemplateResult {
	if (goal.setupStatus === "preparing") {
		return html`
			<div class="setup-banner setup-banner--preparing">
				<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
				<span>Setting up worktree…</span>
			</div>
		`;
	}
	if (goal.setupStatus === "error") {
		return html`
			<div class="setup-banner setup-banner--error">
				<span style="color:var(--destructive)">⚠ Worktree setup failed${goal.setupError ? `: ${goal.setupError}` : ""}</span>
				<button class="btn-retry" title="Retry worktree setup" @click=${() => handleRetrySetup(goal.id)}>Retry Setup</button>
			</div>
		`;
	}
	return nothing as any;
}

function renderNavBar(goal: Goal): TemplateResult {
	const isTeamGoal = !!goal.team;

	return html`
		<div class="nav">
			<div class="nav-left">
				<button class="back-btn" @click=${() => setHashRoute("landing")} title="Back to sessions">
					${svgArrowLeft}
				</button>
				<span class="nav-title">${goal.title}</span>
				${goal.workflow ? html`<span class="nav-workflow-badge" title="Uses workflow: ${goal.workflow.name}">${goal.workflow.name}</span>` : nothing}
				${goal.reattemptOf ? (() => {
					const orig = state.goals.find(g => g.id === goal.reattemptOf);
					return html`<span class="text-xs text-muted-foreground" style="margin-left:8px;">Re-attempt of: <a href="#/goal-dashboard/${goal.reattemptOf}" class="underline">${orig?.title ?? goal.reattemptOf.slice(0, 8)}</a></span>`;
				})() : nothing}
			</div>
			<div class="nav-right">
				${goal.archived ? nothing : html`
					<button class="btn-icon" @click=${() => showGoalDialog(goal)} title="Edit goal">${svgPencil}<span>Edit</span></button>
					${prStatus?.state === "MERGED" && !teamActive
						? html`<button class="btn-icon primary" @click=${() => deleteGoal(goal.id)} title="Archive goal">${svgArchive}<span>Archive</span></button>`
						: html`<button class="btn-icon danger" @click=${() => deleteGoal(goal.id)} title="${teamActive ? "Stop the team before archiving" : "Archive goal"}" ?disabled=${teamActive}>${svgTrash}<span>Archive</span></button>`}
				`}
				${(prStatus?.state === "MERGED" || goal.archived) && !teamActive ? html`
					<button class="btn-icon" @click=${() => startReattempt(goal.id)} title="Re-attempt this goal">
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
						</svg>
						<span>Re-attempt</span>
					</button>
				` : nothing}
				${isTeamGoal ? renderTeamButton(goal) : renderSessionButton(goal)}
			</div>
		</div>
	`;
}

function renderTeamButton(goal: Goal): TemplateResult {
	if (teamActive) {
		return html`
			<div class="btn-split">
				<button class="btn-split-main danger" title="Stop the goal team" @click=${() => handleEndTeam(goal.id)} ?disabled=${teamStopping}>
					${svgStop}
					<span>${teamStopping ? "Stopping\u2026" : "Stop Team"}</span>
				</button>
			</div>
		`;
	}
	if (goal.archived) {
		return html`
			<div class="btn-split">
				<button class="btn-split-main" ?disabled=${true} style="opacity:0.5;cursor:default">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg><span>Archived</span>
				</button>
			</div>
		`;
	}
	// When PR is merged, demote Start Team to secondary (Archive is in the nav bar)
	if (prStatus?.state === "MERGED") {
		return html`
			<button class="btn-icon" title="Start the goal team" @click=${() => handleStartTeam(goal.id)} ?disabled=${teamStarting || goal.setupStatus !== "ready"}>
				${svgCrown}<span>${teamStarting ? "Starting\u2026" : "Start Team"}</span>
			</button>
		`;
	}
	return html`
		<div class="btn-split">
			<button class="btn-split-main" title="${goal.setupStatus === "preparing" ? "Setting up worktree\u2026" : "Start the goal team"}" @click=${() => handleStartTeam(goal.id)} ?disabled=${teamStarting || goal.setupStatus !== "ready"}>
				${goal.setupStatus === "preparing"
					? html`<svg class="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`
					: svgCrown}
				<span>${teamStarting ? "Starting\u2026" : goal.setupStatus === "preparing" ? "Setting up\u2026" : "Start Team"}</span>
			</button>
		</div>
	`;
}

function renderSessionButton(goal: Goal): TemplateResult {
	if (goal.archived) {
		return html`
			<div class="btn-split">
				<button class="btn-split-main" ?disabled=${true} style="opacity:0.5;cursor:default">
					<span>Archived</span>
				</button>
			</div>
		`;
	}
	return html`
		<div class="btn-split">
			<button class="btn-split-main" title="New session for this goal" @click=${() => createAndConnectSession(goal.id)} ?disabled=${goal.setupStatus !== undefined && goal.setupStatus !== "ready"}>
				${svgPlus}
				New Session
			</button>
			<button class="btn-split-chevron" @click=${(e: Event) => { e.stopPropagation(); toggleRoleDropdown(); }} title="Choose role">
				${svgChevronDown}
			</button>
			${roleDropdownOpen ? html`
				<div class="role-dropdown open" @click=${(e: Event) => e.stopPropagation()}>
					${state.roles.length === 0
						? html`<div class="role-dropdown-item" style="color:var(--text-tertiary)">No roles defined</div>`
						: state.roles.map(role => html`
							<button class="role-dropdown-item" title="New session as ${role.label}" @click=${() => { roleDropdownOpen = false; createAndConnectSession(goal.id, role.name); }}>
								<span style="flex-shrink:0">${statusBobbit("idle", false, undefined, false, false, false, false, role.accessory, true)}</span>
								<span class="role-label">${role.label}</span>
							</button>
						`)}
				</div>
			` : nothing}
		</div>
	`;
}

async function toggleRoleDropdown(): Promise<void> {
	if (roleDropdownOpen) {
		roleDropdownOpen = false;
		renderApp();
		return;
	}
	if (state.roles.length === 0) await fetchRoles();
	roleDropdownOpen = true;
	renderApp();
}

// Close role dropdown on outside click
document.addEventListener("click", () => {
	if (roleDropdownOpen) {
		roleDropdownOpen = false;
		renderApp();
	}
});

// ============================================================================
// RENDER: METADATA ROWS
// ============================================================================

function formatCost(cost: number): string {
	if (cost < 0.01) return "<$0.01";
	if (cost < 1) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
	return String(n);
}

function renderMetaRows(goal: Goal): TemplateResult {
	const branch = goal.branch || "";
	const gs = gitStatus;

	return html`
		<div class="meta-rows">
			${goalCost && goalCost.totalCost > 0 ? html`
			<div class="meta-row">
				<div class="meta-item" style="position:relative;cursor:pointer;" @click=${(e: Event) => {
						e.stopPropagation();
						if (!costPopoverOpen) {
							costPopoverOpen = true;
							renderApp();
						}
					}}
					title="Click for cost breakdown">
					${svgDollar}
					<span class="meta-tag cost-tag">${formatCost(goalCost.totalCost)}</span>
					<span class="meta-label">${formatTokens(goalCost.inputTokens + goalCost.outputTokens)} tokens</span>
					<cost-popover
						.open=${costPopoverOpen}
						.goalId=${currentGoal?.id || ""}
						anchor="left"
						@close=${(e: Event) => { e.stopPropagation(); costPopoverOpen = false; renderApp(); }}
					></cost-popover>
				</div>
			</div>
			` : nothing}
			${gitRepoKnown !== 'no' && (branch || gs || gitRepoKnown === 'unknown') ? html`
				<div class="meta-row dashboard-git-row">
					<git-status-widget
						.goalId=${goal.id}
						.token=${localStorage.getItem("gateway.token") || ""}
						.branch=${gs?.branch ?? branch}
						.primaryBranch=${gs?.primaryBranch ?? "master"}
						.isOnPrimary=${gs?.isOnPrimary ?? false}
						.summary=${gs?.summary ?? ''}
						.clean=${gs?.clean ?? true}
						.hasUpstream=${gs?.hasUpstream ?? true}
						.ahead=${gs?.ahead ?? 0}
						.behind=${gs?.behind ?? 0}
						.aheadOfPrimary=${gs?.aheadOfPrimary ?? 0}
						.behindPrimary=${gs?.behindPrimary ?? 0}
						.mergedIntoPrimary=${gs?.mergedIntoPrimary ?? false}
						.unpushed=${gs?.unpushed ?? false}
						.statusFiles=${gs?.status ?? []}
						.repos=${gs?.repos as any}
						.loading=${!gs && !!branch}
						.prState=${prStatus?.state}
						.prUrl=${prStatus?.url}
						.prNumber=${prStatus?.number}
						.prTitle=${prStatus?.title}
						.prMergeable=${prStatus?.mergeable}
						.viewerIsAdmin=${prStatus?.viewerIsAdmin ?? false}
						.reviewDecision=${prStatus?.reviewDecision}
						.headRefName=${prStatus?.headRefName}
						@pr-merge=${handlePrMerge}
						@git-fetch=${handleGitFetch}
					></git-status-widget>
					${goal.worktreePath ? html`
						<span class="meta-sep">\u00B7</span>
						<div class="meta-item">
							${svgFolder}
							<span class="meta-value mono">${goal.worktreePath}</span>
						</div>
					` : nothing}
				</div>
			` : nothing}
		</div>
	`;
}

// ============================================================================
// RENDER: GATE PIPELINE (horizontal visualization)
// ============================================================================

function renderGatePipeline(): TemplateResult {
	// Defensive coercion — see `workflow-gate-coercion.ts`. A snapshot with a
	// missing or non-array `dependsOn` would otherwise throw inside the
	// pipeline / checklist render and silently blank the entire Gates tab.
	const wfGates = coerceWorkflowGatesForRender(currentGoal?.workflow?.gates);
	if (wfGates.length === 0) return html``;

	const statusMap = getGateStatusMap();
	const levels = computeGateDepthLevels(wfGates, statusMap);

	return html`
		<div class="phase-pipeline">
			${levels.map((group, gi) => {
				const prevAllPassed = gi > 0 && levels[gi - 1].every(n => n.status === "passed");
				const anyRunning = group.some(n => n.status === "running");
				const arrowClass = prevAllPassed ? "done" : anyRunning ? "active" : "";

				return html`
					${gi > 0 ? html`<div class="phase-arrow ${arrowClass}">${svgPhaseArrow}</div>` : nothing}
					${group.length === 1 ? renderGateNode(group[0]) : html`
						<div class="phase-group">
							${group.map(node => renderGateNode(node))}
						</div>
					`}
				`;
			})}
		</div>
	`;
}

function renderGateNode(node: GatePipelineNode): TemplateResult {
	const statusClass = gateNodeStatusClass(node.status);
	return html`
		<div class="phase-node ${statusClass}" @click=${() => toggleGateExpand(node.id)} title="${node.name} (${node.status})${node.signalCount > 0 ? ` \u2014 ${node.signalCount} signal${node.signalCount !== 1 ? "s" : ""}` : ""}">
			${node.status === "passed" ? html`<span class="phase-check">\u2713</span>` : nothing}
			${node.status === "failed" ? html`<span class="phase-check" style="color:var(--destructive)">\u2717</span>` : nothing}
			${node.status === "running" ? html`<span class="phase-running-dot"></span>` : nothing}
			${node.name}
			${node.signalCount > 0 ? html`<span class="gate-signal-count">${node.signalCount}</span>` : nothing}
		</div>
	`;
}

function gateNodeStatusClass(status: GatePipelineNode["status"]): string {
	switch (status) {
		case "passed": return "done";
		case "running": return "active";
		case "failed": return "rejected";
		default: return "";
	}
}

function toggleGateExpand(gateId: string): void {
	if (expandedGateIds.has(gateId)) {
		expandedGateIds.delete(gateId);
	} else {
		expandedGateIds.add(gateId);
	}
	renderApp();
}

async function cancelVerification(gateId: string): Promise<void> {
	if (!currentGoalId) return;
	try {
		const resp = await gatewayFetch(`/api/goals/${currentGoalId}/gates/${gateId}/cancel-verification`, {
			method: "POST",
		});
		if (resp.ok) {
			await refreshDashboardGoal();
			gates = await fetchGoalGates(currentGoalId);
			renderApp();
		}
	} catch (err) {
		console.error("Failed to cancel verification:", err);
	}
}

function toggleSignalExpand(signalId: string): void {
	if (expandedSignalIds.has(signalId)) {
		expandedSignalIds.delete(signalId);
	} else {
		expandedSignalIds.add(signalId);
	}
	renderApp();
}

// ============================================================================
// RENDER: TAB BAR
// ============================================================================

function setTab(tab: DashboardTab): void {
	dashboardTab = tab;
	renderApp();
}

/** Re-exports of pure predicates from `goal-dashboard-tab-visibility.ts`.
 *  The helpers live there so they're importable from Node-style unit tests
 *  without pulling in the dashboard's DOM/lit/state plumbing. See
 *  docs/design/nested-goals.md §10.2 + §10.3. */
export function shouldShowPlanTab(goal: Goal | null | undefined, goals?: Goal[]): boolean {
	return _shouldShowPlanTab(goal as any, goals as any);
}
export function shouldShowChildrenTab(goal: Goal | null | undefined, goals: Goal[]): boolean {
	return _shouldShowChildrenTab(goal as any, goals as any);
}

/** Pending plan-mutation banner (§10.5).
 *
 *  Renders directly above the tab bar when `state.pendingMutation` is set
 *  for the active goal. Approve/Reject post to
 *  `POST /api/goals/:id/mutation/:requestId/decision`; the server fans out
 *  `goal_mutation_resolved` which clears the banner via
 *  `handleLiveVerificationEvent`. We also clear locally on a 404 (stale
 *  request) so a duplicate click on a stale buffer can't strand the UI.
 */
async function decideMutation(decision: "approve" | "reject"): Promise<void> {
	const pending = state.pendingMutation;
	if (!pending) return;
	if (!currentGoalId || pending.goalId !== currentGoalId) return;
	const result = decision === "approve"
		? await approveMutation(pending.goalId, pending.requestId)
		: await rejectMutation(pending.goalId, pending.requestId);
	if (!result.ok && result.status === 404) {
		// Stale buffer — clear locally; another viewer already decided.
		if (state.pendingMutation?.requestId === pending.requestId) {
			state.pendingMutation = undefined;
			renderApp();
		}
	}
	// On 200 the WS broadcast clears the banner via the existing handler.
	// On any other failure we leave the banner up so the user can retry.
}

function renderMutationBanner(): TemplateResult | typeof nothing {
	const pending = state.pendingMutation;
	if (!pending || !currentGoalId || pending.goalId !== currentGoalId) return nothing;
	const classification = pending.classification;
	const added = pending.addedNodes ?? [];
	const removed = pending.removedNodes ?? [];
	const dropped = pending.droppedCriteria ?? [];
	return html`
		<div
			class="mutation-banner mutation-banner-${classification}"
			data-testid="mutation-banner"
			data-request-id="${pending.requestId}"
			role="alert"
			style="margin: 0 16px 8px; padding: 10px 14px; border-radius: 8px;
				border: 1px solid var(--border); background: var(--muted);
				color: var(--foreground); font-size: 13px;
				display: flex; flex-direction: column; gap: 8px;"
		>
			<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
				<strong>Plan mutation pending:</strong>
				<span data-testid="mutation-banner-summary">${pending.summary || "(no summary provided)"}</span>
				<span
					class="mutation-banner-tag"
					data-testid="mutation-banner-classification"
					style="margin-left:auto;padding:2px 8px;border-radius:999px;
						border:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:0.04em;"
				>${classification}</span>
			</div>
			<div style="display:flex;gap:8px;align-items:center;">
				<button
					data-testid="mutation-banner-approve"
					@click=${() => decideMutation("approve")}
					style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);
						background:var(--primary, #2563eb);color:var(--primary-foreground, #fff);
						font-size:13px;cursor:pointer;"
				>Approve</button>
				<button
					data-testid="mutation-banner-reject"
					@click=${() => decideMutation("reject")}
					style="padding:6px 14px;border-radius:6px;border:1px solid var(--border);
						background:transparent;color:var(--foreground);
						font-size:13px;cursor:pointer;"
				>Reject</button>
			</div>
			<details>
				<summary style="cursor:pointer;font-size:12px;color:var(--muted-foreground);">Details</summary>
				<ul style="margin:6px 0 0 18px;padding:0;font-size:12px;color:var(--muted-foreground);">
					<li>Classification: <code>${classification}</code></li>
					<li>Added: ${added.length > 0 ? added.join(", ") : html`<em>none</em>`}</li>
					<li>Removed: ${removed.length > 0 ? removed.join(", ") : html`<em>none</em>`}</li>
					<li>Dropped criteria: ${dropped.length > 0 ? dropped.join(", ") : html`<em>none</em>`}</li>
					${pending.changedDeps ? html`<li>Dependencies changed</li>` : nothing}
				</ul>
			</details>
		</div>
	`;
}

function renderTabBar(): TemplateResult {
	const wfTotal = currentGoal?.workflow?.gates.length ?? 0;
	const passedCount = gates.filter(g => g.status === "passed").length;
	const gateCountStr = wfTotal > 0 ? `${passedCount}/${wfTotal}` : String(gates.length);

	const showPlan = shouldShowPlanTab(currentGoal, state.goals);
	const showChildren = shouldShowChildrenTab(currentGoal, state.goals);
	const showTasks = _shouldShowTasksTab(currentGoal as any, state.goals as any, tasks.length);
	// Total count includes archived so the badge tracks the Children
	// tab’s actual rendered list (live + archived, mirroring the Agents
	// tab’s live + dismissed pattern).
	const childCountStr = showChildren ? String(_countDescendantsFromAny(currentGoal!.id, state.goals as any)) : "";

	const tabs: Array<{ id: DashboardTab; label: string; icon: TemplateResult; countStr: string }> = [
		{ id: "spec", label: "Spec", icon: svgDoc, countStr: "" },
		{ id: "gates", label: "Gates", icon: svgGate, countStr: gateCountStr },
		...(showPlan ? [{ id: "plan" as DashboardTab, label: "Plan", icon: svgGate, countStr: "" }] : []),
		...(showTasks ? [{ id: "tasks" as DashboardTab, label: "Tasks", icon: svgTasks, countStr: String(tasks.length) }] : []),
		{ id: "agents", label: "Agents", icon: svgAgents, countStr: String(agents.length + (currentGoal?.team && (state.gatewaySessions.some(s => (s.goalId === currentGoal!.id || s.teamGoalId === currentGoal!.id) && s.role === "team-lead") || state.archivedSessions.some(s => (s.goalId === currentGoal!.id || s.teamGoalId === currentGoal!.id) && s.role === "team-lead")) ? 1 : 0)) },
		...(showChildren ? [{ id: "children" as DashboardTab, label: "Children", icon: svgAgents, countStr: childCountStr }] : []),
		{ id: "commits", label: "Commits", icon: svgCommit, countStr: String(commits.length) },
	];

	return html`
		<div class="tab-bar">
			${tabs.map(t => html`
				<div class="tab ${dashboardTab === t.id ? "active" : ""}" @click=${() => setTab(t.id)} title="${t.label}">
					${t.icon}
					<span class="tab-label">${t.label}</span>
					${t.countStr ? html`<span class="tab-count">${t.countStr}</span>` : nothing}
				</div>
			`)}
		</div>
	`;
}

// ============================================================================
// RENDER: TASKS TAB
// ============================================================================

function statusChipClass(s: TaskState): string {
	switch (s) {
		case "todo": return "chip-todo";
		case "in-progress": return "chip-progress";
		case "complete": return "chip-done";
		case "blocked": return "chip-blocked";
		case "skipped": return "chip-failed";
	}
}

function statusLabel(s: TaskState): string {
	switch (s) {
		case "todo": return "Backlog";
		case "in-progress": return "In Progress";
		case "complete": return "Done";
		case "blocked": return "Blocked";
		case "skipped": return "Failed";
	}
}

function renderTasksTab(): TemplateResult {
	if (tasks.length === 0) {
		return html`<div class="tab-empty">${svgTasks}<span>No tasks yet</span></div>`;
	}

	return html`
		<div class="tab-panel-inner" style="padding-top:0;">
			<table class="task-table">
				<thead><tr>
					<th style="width:35%">Task</th>
					<th style="width:10%">Type</th>
					<th style="width:14%">Status</th>
					<th style="width:20%">Assignee</th>
					<th style="width:8%">Time</th>
				</tr></thead>
				<tbody>
					${tasks.map(task => {
						const isDone = task.state === "complete";
						const isFailed = task.state === "skipped";
						const assignee = findAssigneeSession(task.assignedSessionId);
						const color = typeColor(task.type);

						return html`
							<tr style="${isDone ? "opacity:0.55" : ""}">
								<td class="task-title-cell">
									${task.title}
									${isFailed && task.resultSummary ? html`
										<div style="font-size:11px;color:var(--destructive);margin-top:3px;">${task.resultSummary}</div>
									` : nothing}
								</td>
								<td><span class="type-tag" style="background:${color}20;color:${color}">${typeLabel(task.type)}</span></td>
								<td><span class="status-chip ${statusChipClass(task.state)}"><span class="dot"></span>${statusLabel(task.state)}</span></td>
								<td>
									${assignee
										? html`<div class="assignee-cell assignee-cell-link" @click=${(e: Event) => { e.stopPropagation(); connectToSession(assignee.id, true); }}>
											${statusBobbit(assignee.status, assignee.isCompacting, assignee.id, false, assignee.isAborting, assignee.role === "team-lead", assignee.role === "coder", assignee.accessory)}
											${assignee.title || assignee.id.slice(0, 8)}
										</div>`
										: html`<span style="font-size:12px;color:var(--text-tertiary)">Unassigned</span>`
									}
								</td>
								<td class="elapsed-cell">${getElapsedTime(task)}</td>
							</tr>
						`;
					})}
				</tbody>
			</table>
		</div>
	`;
}

// ============================================================================
// RENDER: AGENTS TAB
// ============================================================================

function renderAgentsTab(): TemplateResult {
	// Build combined list: team lead (if any) + spawned agents
	const allAgents: TeamAgent[] = [];
	const teamLeadSession = currentGoal?.team
		? (state.gatewaySessions.find(s => (s.goalId === currentGoal!.id || s.teamGoalId === currentGoal!.id) && s.role === "team-lead")
			|| state.archivedSessions.find(s => (s.goalId === currentGoal!.id || s.teamGoalId === currentGoal!.id) && s.role === "team-lead"))
		: null;
	if (teamLeadSession) {
		allAgents.push({
			sessionId: teamLeadSession.id,
			role: "team-lead",
			status: teamLeadSession.status,
			worktreePath: "",
			branch: "",
			task: "",
			createdAt: 0,
		});
	}
	allAgents.push(...agents);

	if (allAgents.length === 0) {
		return html`<div class="tab-empty">${svgAgents}<span>No active agents</span></div>`;
	}

	// Separate live and archived agents
	const liveAgents = allAgents.filter(a => a.status !== "archived");
	const archivedAgents = allAgents.filter(a => a.status === "archived");

	const renderAgentCard = (agent: TeamAgent, isArchived: boolean) => {
		const session = state.gatewaySessions.find(s => s.id === agent.sessionId)
			|| state.archivedSessions.find(s => s.id === agent.sessionId);
		const isWorking = agent.status === "streaming";
		const roleColor = getRoleColor(agent.role);
		const tasksDone = tasks.filter(t => t.assignedSessionId === agent.sessionId && t.state === "complete").length;
		const agentCommits = commits.filter(c => {
			const s = state.gatewaySessions.find(gs => gs.id === agent.sessionId)
				|| state.archivedSessions.find(gs => gs.id === agent.sessionId);
			return s && c.author === (s.title || s.id.slice(0, 8));
		}).length;
		const elapsed = (isArchived && agent.archivedAt ? agent.archivedAt : Date.now()) - agent.createdAt;
		const mins = Math.floor(elapsed / 60_000);
		const timeStr = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
		const displayName = isArchived ? (agent.title || formatAgentName(agent)) : formatAgentName(agent);

		return html`
			<div class="agent-card ${isArchived ? "opacity-70" : ""}" @click=${() => connectToSession(agent.sessionId, true)} title="${isArchived ? "View archived session" : "Connect to"} ${displayName}">
				<div class="agent-card-bobbit">
					${statusBobbit(
						isArchived ? "terminated" : (session?.status ?? agent.status),
						session?.isCompacting ?? false,
						agent.sessionId,
						false,
						session?.isAborting ?? false,
						agent.role === "team-lead",
						agent.role === "coder",
						isArchived ? agent.accessory : session?.accessory,
					)}
				</div>
				<div class="agent-card-info">
					<div class="agent-card-name-row">
						<span class="agent-card-name">${displayName}</span>
						<span class="role-tag" style="background:${roleColor.bg};color:${roleColor.text}">${getRoleLabel(agent.role)}</span>
						${isArchived
							? html`<span class="role-tag" style="background:var(--muted);color:var(--muted-foreground)">Dismissed</span>`
							: html`<span class="status-indicator ${isWorking ? "working" : "idle"}"></span>`}
					</div>
					<div class="agent-card-task">${agent.task || (isArchived ? "Session archived" : "No active task")}</div>
					<div class="agent-card-meta">
						<div class="agent-card-meta-item">${svgTasks} ${tasksDone} completed</div>
						${agentCommits > 0 ? html`<div class="agent-card-meta-item">${svgCommit} ${agentCommits} commits</div>` : nothing}
						<div class="agent-card-meta-item">${svgClock} ${timeStr}</div>
					</div>
				</div>
			</div>
		`;
	};

	return html`
		<div class="tab-panel-inner">
			<div class="agent-grid">
				${liveAgents.map(agent => renderAgentCard(agent, false))}
				${archivedAgents.map(agent => renderAgentCard(agent, true))}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: COMMITS TAB
// ============================================================================

function renderCommitsTab(): TemplateResult {
	if (commits.length === 0) {
		return html`<div class="tab-empty">${svgCommit}<span>No commits found on this branch</span></div>`;
	}

	const badges = deriveBadges(commits, tasks);

	return html`
		<div class="tab-panel-inner" style="padding-top:0;">
			<div class="commit-list">
				${commits.map((commit, index) => {
					const isHead = index === 0;
					const b = badges.get(commit.sha) || {};
					return html`
						<div class="commit-row">
							<div class="commit-dot-col"><div class="cdot ${isHead ? "head" : ""}"></div></div>
							<code class="commit-sha2">${commit.shortSha}</code>
							<div class="commit-msg2">${commit.message}</div>
							<div class="commit-badges2">
								${b.tests === "pass" ? html`<span class="cbadge cbadge-pass">\u2713 Tests</span>` : nothing}
								${b.tests === "fail" ? html`<span class="cbadge cbadge-fail">\u2717 Tests</span>` : nothing}
								${b.tests === "pending" ? html`<span class="cbadge cbadge-pending">\u23F3 Tests</span>` : nothing}
								${b.review === "pass" ? html`<span class="cbadge cbadge-pass">\u2713 Review</span>` : nothing}
								${b.review === "fail" ? html`<span class="cbadge cbadge-fail">\u2717 Review</span>` : nothing}
								${b.review === "pending" ? html`<span class="cbadge cbadge-pending">\u23F3 Review</span>` : nothing}
							</div>
							<div class="commit-author2">${commit.author}</div>
							<div class="commit-time2">${formatRelativeTime(commit.timestamp)}</div>
						</div>
					`;
				})}
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: PLAN TAB (task 4.2 — docs/design/nested-goals.md §10.2)
// ============================================================================

/** Subgoal verify-step shape we read from `goal.workflow.gates[execution].verify[]`.
 *  Mirrors `SubgoalStepParams` from src/server/agent/workflow-store.ts; we keep
 *  this loose to stay decoupled from the server type at the UI boundary. */
export interface PlanStep {
	name: string;
	type: "command" | "llm-review" | "agent-qa" | "subgoal";
	phase?: number;
	subgoal?: {
		title: string;
		spec: string;
		workflowId?: string;
		suggestedRole?: string;
		planId: string;
		phase?: number;
		childGoalId?: string;
	};
}

/** Pure helper: extract subgoal verify steps from a goal snapshot.
 *  Returns [] when the workflow / execution gate / verify array is missing
 *  or contains only non-subgoal steps. */
/** Extract the FORMAL plan steps from a goal's snapshotted workflow.
 *  Used internally by `extractPlanSteps`; exported for unit tests. */
export function extractFormalPlanSteps(goal: Goal | null | undefined): PlanStep[] {
	const exec = goal?.workflow?.gates.find(g => g.id === "execution");
	const verify = (exec?.verify ?? []) as PlanStep[];
	return verify.filter(s => s && s.type === "subgoal" && s.subgoal && typeof s.subgoal.planId === "string");
}

/** The complete Plan-tab step list: formal steps from the snapshotted
 *  workflow, augmented (or replaced when no formal plan exists) by
 *  synthesis from live children. The plan stays a living document —
 *  recomputed from the current goals tree every render. See
 *  `plan-synthesis.ts::buildPlanSteps` and the (post-PR #409) user
 *  feedback: "the whole plan idea and view is really useful... make
 *  sure it remains a living document/thing as the plan changes over
 *  time and evolves." */
export function extractPlanSteps(goal: Goal | null | undefined): PlanStep[] {
	if (!goal) return [];
	const formal = extractFormalPlanSteps(goal);
	const combined = buildPlanSteps(goal.id, formal as any, state.goals as any) as PlanStep[];
	return combined;
}

/** Pure helper: group plan steps into topological columns by `phase`. Within
 *  a column, nodes are sorted by `subgoal.title` (case-insensitive) for a
 *  stable rendering. Phase numbers may be sparse — we render columns for
 *  every distinct phase value, sorted ascending. */
export function computePlanColumns(steps: PlanStep[]): Array<{ phase: number; nodes: PlanStep[] }> {
	const byPhase = new Map<number, PlanStep[]>();
	for (const s of steps) {
		const p = (s.phase ?? s.subgoal?.phase ?? 0) | 0;
		let arr = byPhase.get(p);
		if (!arr) { arr = []; byPhase.set(p, arr); }
		arr.push(s);
	}
	const columns: Array<{ phase: number; nodes: PlanStep[] }> = [];
	for (const phase of [...byPhase.keys()].sort((a, b) => a - b)) {
		const nodes = byPhase.get(phase)!.slice().sort((a, b) => {
			const at = (a.subgoal?.title || a.name || "").toLowerCase();
			const bt = (b.subgoal?.title || b.name || "").toLowerCase();
			return at < bt ? -1 : at > bt ? 1 : 0;
		});
		columns.push({ phase, nodes });
	}
	return columns;
}

/** Pure helper: is the plan currently editable for this goal?
 *
 *  Editable iff the goal-plan gate has NOT been signalled (i.e. its `status`
 *  is anything other than `"passed"`), OR the goal is paused. See
 *  docs/design/nested-goals.md §10.2. */
export function isPlanEditable(
	goal: { paused?: boolean } | null | undefined,
	gateStates: Array<{ gateId: string; status: "pending" | "passed" | "failed" }> = [],
): boolean {
	if (!goal) return false;
	if (goal.paused === true) return true;
	const gp = gateStates.find(g => g.gateId === "goal-plan");
	return (gp?.status ?? "pending") !== "passed";
}

/** Pure helper: should the Plan tab show the "Approve plan" button?
 *
 *  Visible iff:
 *    - plan is editable (goal-plan gate not yet passed), AND
 *    - there is at least one plan step to approve, AND
 *    - the goal is not paused (paused goals require resume before freeze).
 *
 *  See nested-goals task F3 + docs/design/nested-goals.md §10.2. The
 *  freeze itself happens server-side when the `goal-plan` gate is
 *  signalled — see `seed-default-workflows.ts::parent.yaml`. */
export function shouldShowApprovePlanButton(
	editable: boolean,
	stepCount: number,
	paused: boolean,
): boolean {
	return editable && stepCount > 0 && !paused;
}

/** Click handler for the Plan tab's "Approve plan" button. POSTs an
 *  empty signal to `goal-plan`; on success the WS `goal_plan_frozen`
 *  broadcast re-renders the Plan tab as frozen. On failure surfaces a
 *  basic alert so the user knows the click didn't take. */
async function approvePlanClick(goalId: string): Promise<void> {
	const result = await signalManualGate(goalId, "goal-plan");
	if (!result.ok) {
		const msg = result.error || `Failed to approve plan (HTTP ${result.status})`;
		// eslint-disable-next-line no-alert
		alert(msg);
	}
}

/** Resolve a plan node's display state by joining `subgoal.childGoalId`
 *  against the goal snapshot. Falls back to "pending" when the child has
 *  not been spawned yet. */
function resolvePlanNodeState(step: PlanStep, goals: Goal[]): "pending" | "running" | "passed" | "failed" | "needs-input" {
	return resolvePlanNodeStateFn(step, goals as any);
}

function planNodeStateLabel(s: "pending" | "running" | "passed" | "failed" | "needs-input"): string {
	switch (s) {
		case "pending": return "Pending";
		case "running": return "Running";
		case "passed": return "Passed";
		case "failed": return "Failed";
		case "needs-input": return "Needs Input";
	}
}

/** Currently expanded plan node (by planId). Module-local so tab navigation
 *  preserves the selection — the tab content is destroyed/recreated on tab
 *  switch but the component-level state survives. */
let selectedPlanNodeId: string | null = null;
let planEditMode = false;

function togglePlanNode(planId: string): void {
	selectedPlanNodeId = selectedPlanNodeId === planId ? null : planId;
	renderApp();
}

function togglePlanEditMode(): void {
	planEditMode = !planEditMode;
	renderApp();
}

// ── SVG layout constants ──────────────────────────────────────────────
const PLAN_COL_W = 240;
const PLAN_ROW_H = 96;
const PLAN_NODE_W = 200;
const PLAN_NODE_H = 72;
const PLAN_PAD = 24;
const PLAN_HEADER_H = 28;

/** Render a single plan node as an SVG group at the given column/row. */
function renderPlanNode(
	step: PlanStep,
	colIdx: number,
	rowIdx: number,
	stateLabel: "pending" | "running" | "passed" | "failed" | "needs-input",
	isSelected: boolean,
) {
	const x = PLAN_PAD + colIdx * PLAN_COL_W + (PLAN_COL_W - PLAN_NODE_W) / 2;
	const y = PLAN_PAD + PLAN_HEADER_H + rowIdx * PLAN_ROW_H;
	const sg = step.subgoal!;
	const title = sg.title || step.name || "(untitled)";
	const truncatedTitle = title.length > 28 ? title.slice(0, 27) + "\u2026" : title;
	const metaParts: string[] = [];
	if (sg.workflowId) metaParts.push(sg.workflowId);
	if (sg.suggestedRole) metaParts.push(sg.suggestedRole);
	const meta = metaParts.join(" \u00B7 ");
	const badgeText = planNodeStateLabel(stateLabel);

	return svg`
		<g class="plan-node"
			data-testid="plan-node"
			data-plan-id="${sg.planId}"
			data-state="${stateLabel}"
			data-phase="${(step.phase ?? sg.phase ?? 0) | 0}"
			data-selected="${isSelected ? "true" : "false"}"
			transform="translate(${x}, ${y})"
			@click=${() => togglePlanNode(sg.planId)}>
			<rect class="plan-node-rect" width="${PLAN_NODE_W}" height="${PLAN_NODE_H}" rx="6" ry="6"></rect>
			<text class="plan-node-title" x="12" y="22">${truncatedTitle}</text>
			${meta ? svg`<text class="plan-node-meta" x="12" y="40">${meta}</text>` : nothing}
			<text class="plan-node-state-badge" x="12" y="${PLAN_NODE_H - 12}">${badgeText}</text>
		</g>
	`;
}

/** Render arrow connectors for a phase-to-phase transition. The DAG
 *  semantics: phase N+1 starts strictly after every phase N node
 *  finishes, so EVERY destination node depends on EVERY source node.
 *  We draw one orthogonal path per source→destination pair, sharing
 *  a vertical mid-line in the gap between columns so the edges
 *  visibly fan out from each source to each destination.
 *
 *  Live test (PR #409): the previous implementation drew straight
 *  horizontal lines pinned to the destination row's y-coordinate from
 *  the source column's right edge, so when the source column had
 *  fewer nodes than the destination column, edges for destination
 *  rows past the source's last row appeared to float in empty space
 *  with no visible origin.
 *
 *  Pure path computation extracted to `plan-edge-paths.ts` for unit
 *  testability. */
function renderEdgeColumn(fromColIdx: number, fromRows: number, toRows: number) {
	const layout = {
		planPad: PLAN_PAD,
		planColW: PLAN_COL_W,
		planNodeW: PLAN_NODE_W,
		planNodeH: PLAN_NODE_H,
		planHeaderH: PLAN_HEADER_H,
		planRowH: PLAN_ROW_H,
	};
	const paths = planEdgePaths(layout, fromColIdx, fromRows, toRows);
	return paths.map(d => svg`<path class="plan-edge" d="${d}" fill="none"></path>`);
}

function renderPlanNodeCard(step: PlanStep, stateLabel: string): TemplateResult {
	const sg = step.subgoal!;
	const phase = (step.phase ?? sg.phase ?? 0) | 0;
	const editable = planEditMode;
	const spec = sg.spec || "(no spec)";
	return html`
		<div class="plan-node-card" data-testid="plan-node-card" data-plan-id="${sg.planId}">
			<div class="plan-node-card-header">
				<span class="plan-node-card-title">${sg.title}</span>
				<button class="plan-node-card-close" title="Close" @click=${() => togglePlanNode(sg.planId)}>✕</button>
			</div>
			<dl class="plan-node-card-meta">
				<dt>State</dt><dd>${stateLabel}${sg.childGoalId ? html` · <a href="#/goal/${sg.childGoalId}">view child</a>` : nothing}</dd>
				<dt>Phase</dt><dd>${phase}</dd>
				<dt>Workflow</dt><dd>${sg.workflowId || html`<em>default</em>`}</dd>
				${sg.suggestedRole ? html`<dt>Role</dt><dd>${sg.suggestedRole}</dd>` : nothing}
				<dt>Plan id</dt><dd><code>${sg.planId}</code></dd>
			</dl>
			<div class="plan-node-card-spec" data-testid="plan-node-card-spec">${spec}</div>
			${editable ? html`
				<div style="font-size:11px;color:var(--text-tertiary);">
					Inline editing of plan-node fields will land in a follow-up task. Use the
					<code>goal_plan_propose</code> tool or <code>PATCH /api/goals/:id/plan</code>
					for now.
				</div>
			` : nothing}
		</div>
	`;
}

/** Plan tab body. Hand-rolled SVG layout with topological columns by phase.
 *  See docs/design/nested-goals.md §10.2. */
function renderPlanTab(): TemplateResult {
	const goal = currentGoal;
	if (!goal) return html`<div class="tab-empty">No goal loaded.</div>`;

	const formalSteps = extractFormalPlanSteps(goal);
	const steps = extractPlanSteps(goal);
	const adHoc = isAdHocPlan(formalSteps as any, steps.length);
	const hasFormal = formalSteps.length > 0;
	const hasOrphans = hasFormal && steps.length > formalSteps.length;
	const editable = isPlanEditable(goal, gates);

	if (steps.length === 0) {
		return html`
			<div class="plan-tab" data-testid="plan-tab">
				<div class="plan-tab-header">
					<span class="plan-tab-title">Plan</span>
					<span class="plan-tab-status ${editable ? "editable" : "frozen"}">${editable ? "Editable" : "Frozen"}</span>
				</div>
				<div class="tab-empty" data-testid="plan-tab-empty">
					No plan yet — the team-lead will propose one once the charter passes, or spawn ad-hoc children via <code>goal_spawn_child</code>.
				</div>
			</div>
		`;
	}

	const columns = computePlanColumns(steps);
	const maxRows = Math.max(...columns.map(c => c.nodes.length));
	const W = PLAN_PAD * 2 + columns.length * PLAN_COL_W;
	const H = PLAN_PAD * 2 + PLAN_HEADER_H + maxRows * PLAN_ROW_H;

	const selected = selectedPlanNodeId
		? steps.find(s => s.subgoal?.planId === selectedPlanNodeId) || null
		: null;
	const selectedState = selected ? resolvePlanNodeState(selected, state.goals) : null;

	// Status label: distinguish formal-frozen / formal-editable / living-
	// (ad-hoc) plans. Living plans are inherently dynamic — they refresh
	// from live children every render — so the label is always "Living".
	const statusKind: "editable" | "frozen" | "living" = adHoc ? "living" : (editable ? "editable" : "frozen");
	const statusLabel =
		statusKind === "living" ? "Living plan — reflects current children" :
		statusKind === "editable" ? (goal.paused ? "Paused — editable" : "Editable — plan not yet approved") :
		"Frozen — plan approved";

	return html`
		<div class="plan-tab" data-testid="plan-tab" data-plan-kind="${statusKind}">
			<div class="plan-tab-header">
				<span class="plan-tab-title">Plan — ${steps.length} subgoal${steps.length === 1 ? "" : "s"} across ${columns.length} phase${columns.length === 1 ? "" : "s"}${hasOrphans ? html` <span style="color:var(--text-tertiary);font-weight:400;font-size:11px;margin-left:6px;">(includes ${steps.length - formalSteps.length} ad-hoc child${(steps.length - formalSteps.length) === 1 ? "" : "ren"})</span>` : nothing}</span>
				<div style="display:flex;gap:8px;align-items:center;">
					<span class="plan-tab-status ${statusKind}" data-testid="plan-tab-status">
						${statusLabel}
					</span>
					${editable ? html`
						<button class="plan-edit-btn"
							data-testid="plan-edit-btn"
							aria-pressed="${planEditMode ? "true" : "false"}"
							@click=${togglePlanEditMode}>
							${planEditMode ? "Done editing" : "Edit"}
						</button>
					` : nothing}
					${shouldShowApprovePlanButton(editable, steps.length, goal.paused === true) ? html`
						<button class="plan-approve-btn primary"
							data-testid="approve-plan-btn"
							title="Signal the goal-plan gate to freeze the execution plan"
							@click=${() => approvePlanClick(goal.id)}>
							Approve plan
						</button>
					` : nothing}
				</div>
			</div>
			<div class="plan-svg-wrap">
				<svg class="plan-svg" data-testid="plan-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
					${columns.map((col, ci) => svg`
						<g class="plan-column" data-testid="plan-column" data-phase="${col.phase}" data-col-index="${ci}">
							<text class="phase-label"
								x="${PLAN_PAD + ci * PLAN_COL_W + PLAN_COL_W / 2}"
								y="${PLAN_PAD + 14}"
								text-anchor="middle">Phase ${col.phase}</text>
							${col.nodes.map((step, ri) => renderPlanNode(
								step,
								ci,
								ri,
								resolvePlanNodeState(step, state.goals),
								step.subgoal?.planId === selectedPlanNodeId,
							))}
						</g>
					`)}
					${columns.slice(0, -1).map((col, ci) => {
						const fromRows = col.nodes.length;
						const nextRows = columns[ci + 1].nodes.length;
						return renderEdgeColumn(ci, fromRows, nextRows);
					})}
				</svg>
			</div>
			${selected && selectedState ? renderPlanNodeCard(selected, planNodeStateLabel(selectedState)) : nothing}
		</div>
	`;
}

// ============================================================================
// RENDER: CHILDREN TAB — see docs/design/nested-goals.md §10.3
// ============================================================================

/** Resolve the human-facing "current gate" label for a child goal. The
 *  rule (§10.3): show the latest non-passed gate's name, or
 *  "ready-to-merge passed" if every gate has passed. Falls back to a
 *  workflow-name string when no gate states are loaded yet. */
export function childCurrentGateLabel(child: Goal): string {
	const wfGates = child.workflow?.gates ?? [];
	if (wfGates.length === 0) return "—";
	// Walk the workflow gates in declaration order; the first non-passed
	// is the current frontier. We don't have child-goal GateState in
	// state.goals here — fall back to the goal's own state field.
	// When the goal is `complete`, surface "ready-to-merge passed"; when
	// in-progress, surface the workflow's last gate name as a hint;
	// otherwise the goal state.
	if (child.state === "complete") return "ready-to-merge passed";
	if (child.state === "shelved") return "shelved";
	if (child.state === "in-progress") {
		const last = wfGates[wfGates.length - 1];
		return last?.name || "in progress";
	}
	return "pending";
}

/** Resolve the last verification verdict for a child goal. Looks at the
 *  most-recent gate signal across the child's workflow gates; "—" when
 *  unknown. The child's gate state isn't usually loaded into the parent's
 *  state, so this is best-effort — returns the running/passed/failed
 *  badge derived from the goal record alone. */
export function childLastVerdictLabel(child: Goal): "passed" | "failed" | "running" | "—" {
	if (child.state === "complete") return "passed";
	if (child.state === "shelved") return "failed";
	if (child.state === "in-progress") return "running";
	return "—";
}

/** Count team agents (non-archived sessions) attached to the child goal. */
export function childAgentCount(childId: string): number {
	let n = 0;
	for (const s of state.gatewaySessions) {
		if (s.goalId === childId || s.teamGoalId === childId) n++;
	}
	return n;
}

/** Format the child's last activity as a relative timestamp.
 *  Local helper — the existing `formatRelativeTime` higher in the file
 *  takes a string-or-number commit timestamp and is wired into git
 *  status; this variant accepts `number | undefined` and avoids
 *  collisions. */
function formatChildLastActivity(ts: number | undefined): string {
	if (!ts) return "—";
	const diff = Date.now() - ts;
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Children tab body — a list of clickable cards per docs/design/nested-goals.md §10.3. */
function renderChildCard(c: Goal, isArchived: boolean): TemplateResult {
	const gateLabel = childCurrentGateLabel(c);
	const verdict = childLastVerdictLabel(c);
	const agentCount = childAgentCount(c.id);
	const lastActivity = formatChildLastActivity(c.updatedAt ?? c.createdAt);
	// Archived terminal-state badge — distinguishes "merged + cleaned up"
	// (passed) from "shelved / aborted / zombie cleanup" (failed). Mirrors
	// the colour-coded plan-node states from `plan-node-state.ts`.
	const archivedBadge = isArchived
		? c.state === "complete"
			? html`<span class="role-tag" style="background:oklch(0.65 0.15 145 / 0.18);color:oklch(0.55 0.15 145);" data-testid="child-card-archived-badge">Merged</span>`
			: html`<span class="role-tag" style="background:var(--muted);color:var(--muted-foreground);" data-testid="child-card-archived-badge">Archived</span>`
		: nothing;
	return html`
		<div
			class="child-card ${isArchived ? "opacity-70" : ""}"
			data-testid="child-card"
			data-archived="${isArchived ? "true" : "false"}"
			role="button"
			tabindex="0"
			style="cursor:pointer;border:1px solid var(--border);border-radius:6px;padding:10px 12px;background:var(--background);display:flex;flex-direction:column;gap:6px;${isArchived ? "opacity:0.7;" : ""}"
			@click=${() => setHashRoute("goal-dashboard", c.id)}
			@keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setHashRoute("goal-dashboard", c.id); } }}>
			<div style="display:flex;align-items:center;gap:8px;">
				<div class="child-title" data-testid="child-card-title" style="font-weight:500;color:var(--foreground);flex:1;">${c.title}</div>
				${archivedBadge}
			</div>
			<div class="child-meta" style="display:flex;flex-wrap:wrap;gap:8px;font-size:12px;color:var(--muted-foreground);">
				<span data-testid="child-card-gate">Gate: ${gateLabel}</span>
				<span>·</span>
				<span data-testid="child-card-verdict">Last verdict: ${verdict}</span>
				<span>·</span>
				<span data-testid="child-card-agents">${agentCount} agent${agentCount === 1 ? "" : "s"}</span>
				<span>·</span>
				<span data-testid="child-card-activity">${lastActivity}</span>
			</div>
		</div>
	`;
}

function renderChildrenTab(): TemplateResult {
	const goal = currentGoal;
	if (!goal) return html`<div class="tab-empty">No goal loaded.</div>`;
	// Show ALL children, not just live — mirrors the Agents tab pattern
	// (live + dismissed agents in the same view). Archived children are
	// rendered with opacity-70 + an "Archived" / "Merged" badge to
	// distinguish terminal-state from in-flight. Live test (PR #409
	// v0.1-foundation): the Children tab showed (1) but the four merged
	// + auto-archived Phase 1+2 children were invisible — confusing.
	const liveChildren = getChildGoals(goal.id);
	const archivedChildren = getArchivedChildGoalsFrom(goal.id, state.goals);
	const total = liveChildren.length + archivedChildren.length;

	const onAddChild = () => {
		showNewGoalDialogForChild({
			parentGoalId: goal.id,
			projectId: goal.projectId,
		});
	};

	return html`
		<div class="tab-panel-inner" data-testid="children-tab">
			<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;">
				<div style="font-size:13px;color:var(--muted-foreground);">
					${total === 0
						? html`<span data-testid="children-tab-empty">No children yet.</span>`
						: html`${total} child goal${total === 1 ? "" : "s"}${archivedChildren.length > 0 ? html` <span style="color:var(--text-tertiary);">(${liveChildren.length} active, ${archivedChildren.length} archived)</span>` : nothing}`}
				</div>
				<button
					class="btn-secondary"
					data-testid="add-child-goal-btn"
					@click=${onAddChild}>
					+ Add child goal
				</button>
			</div>
			${total === 0 ? nothing : html`
				<div class="children-tab" data-testid="children-tab-list" style="display:flex;flex-direction:column;gap:8px;">
					${liveChildren.map(c => renderChildCard(c, false))}
					${archivedChildren.map(c => renderChildCard(c, true))}
				</div>
			`}
		</div>
	`;
}

// ============================================================================
// RENDER: SPEC TAB
// ============================================================================

function renderSpecTab(): TemplateResult {
	const spec = currentGoal?.spec;
	if (!spec) {
		return html`<div class="tab-empty">${svgDoc}<span>No spec defined</span></div>`;
	}
	return html`
		<div class="tab-panel-inner">
			<div class="spec-content">
				<markdown-block .content=${spec}></markdown-block>
			</div>
		</div>
	`;
}

// ============================================================================
// RENDER: GATES TAB
// ============================================================================

function renderGatesTab(): TemplateResult {
	// Coerce up-front so the empty-state check works against the same
	// renderer-safe view the checklist below sees. A workflow whose `gates`
	// array is malformed (every entry filtered) renders the empty state
	// instead of throwing.
	const safeGates = coerceWorkflowGatesForRender(currentGoal?.workflow?.gates);

	if (safeGates.length === 0) {
		return html`<div class="tab-empty">${svgGate}<span>No workflow gates defined</span></div>`;
	}

	return html`
		<div class="tab-panel-inner">
			${renderGateChecklist(safeGates)}
		</div>
	`;
}

function renderGateChecklist(wfGates: SafeWorkflowGate[]): TemplateResult {
	if (!currentGoal?.workflow) return nothing as any;

	const statusMap = getGateStatusMap();

	// Topological sort for display order
	const visited = new Set<string>();
	const sorted: SafeWorkflowGate[] = [];
	const gateMap = new Map(wfGates.map(g => [g.id, g] as const));
	function visit(id: string) {
		if (visited.has(id)) return;
		visited.add(id);
		const gate = gateMap.get(id);
		if (!gate) return;
		for (const dep of gate.dependsOn) visit(dep);
		sorted.push(gate);
	}
	for (const g of wfGates) visit(g.id);

	const passedCount = gates.filter(g => g.status === "passed").length;
	const totalCount = sorted.length;
	const pct = totalCount > 0 ? Math.round((passedCount / totalCount) * 100) : 0;

	return html`
		<div class="wf-checklist">
			<div class="wf-checklist-header">
				<span class="wf-checklist-title">Workflow: ${currentGoal.workflow.name}</span>
				<span class="wf-checklist-count">${passedCount}/${totalCount} passed</span>
			</div>
			<div class="wf-progress">
				<div class="wf-progress-bar"><div class="wf-progress-fill" style="width:${pct}%"></div></div>
				<span class="wf-progress-label">${passedCount}/${totalCount} gates passed</span>
			</div>
			${sorted.map(wfGate => {
				const gs = statusMap.get(wfGate.id);
				const status = gs?.status ?? "pending";
				const isExpanded = expandedGateIds.has(wfGate.id);
				const signalCount = gs?.signals?.length ?? 0;

				// Check if any signal is running
				const hasRunning = gs?.signals?.some(s => s.verification.status === "running");
				const effectiveStatus = hasRunning && status !== "passed" ? "running" : status;

				let dotClass: string;
				let dotContent: string;
				if (effectiveStatus === "passed") {
					dotClass = "gate-dot gate-dot--passed";
					dotContent = "\u2713";
				} else if (effectiveStatus === "failed") {
					dotClass = "gate-dot gate-dot--failed";
					dotContent = "\u2717";
				} else if (effectiveStatus === "running") {
					dotClass = "gate-dot gate-dot--running";
					dotContent = "";
				} else {
					dotClass = "gate-dot gate-dot--pending";
					dotContent = "";
				}

				return html`
					<div class="wf-checklist-item" @click=${() => toggleGateExpand(wfGate.id)}>
						<span class="${dotClass}">${dotContent}</span>
						<div class="wf-checklist-info">
							<span class="wf-checklist-name">${wfGate.name}</span>
							<div class="wf-checklist-meta">
								${wfGate.dependsOn.length > 0 ? html`
									<span class="wf-checklist-deps">depends on: ${wfGate.dependsOn.join(", ")}</span>
								` : nothing}
								${wfGate.content ? html`<span class="wf-checklist-deps">\u00B7 content gate</span>` : nothing}
								${wfGate.metadata && Object.keys(wfGate.metadata).length > 0 ? html`<span class="wf-checklist-deps">\u00B7 metadata: ${Object.keys(wfGate.metadata).join(", ")}</span>` : nothing}
							</div>
						</div>
						<span class="wf-checklist-status-label gate-status-label--${effectiveStatus === "running" ? "pending" : status}">${hasRunning ? "verifying" : status}</span>
						${signalCount > 0 ? html`<span class="gate-signal-badge">${signalCount} signal${signalCount !== 1 ? "s" : ""}</span>` : nothing}
						<span class="wf-checklist-view">${isExpanded ? "Hide" : "View"}</span>
					</div>
					${isExpanded ? renderGateDetail(wfGate, gs) : nothing}
				`;
			})}
		</div>
	`;
}

function renderGateDetail(
	_wfGate: SafeWorkflowGate,
	gs: GateState | undefined,
): TemplateResult {
	const signals = gs?.signals ?? [];

	return html`
		<div class="gate-detail-panel">
			${/* Metadata section */ ""}
			${gs?.currentMetadata && Object.keys(gs.currentMetadata).length > 0 ? html`
				<div class="gate-detail-section">
					<div class="gate-detail-section-title">Metadata</div>
					<div class="gate-metadata-grid">
						${Object.entries(gs.currentMetadata).map(([key, value]) => html`
							<div class="gate-metadata-item">
								<span class="gate-metadata-key">${key}</span>
								<code class="gate-metadata-value">${value}</code>
							</div>
						`)}
					</div>
				</div>
			` : nothing}

			${/* Content section */ ""}
			${gs?.currentContent ? html`
				<div class="gate-detail-section">
					<div class="gate-detail-section-title">Content <span class="gate-content-version">v${gs.currentContentVersion ?? 1}</span></div>
					<pre class="gate-content-body">${gs.currentContent}</pre>
				</div>
			` : nothing}

			${/* Signal timeline */ ""}
			<div class="gate-detail-section">
				<div class="gate-detail-section-title">Signal History</div>
				${signals.length === 0
					? html`<div class="gate-no-signals">No signals yet</div>`
					: html`
						<div class="signal-timeline">
							${[...signals].reverse().map(signal => renderSignalEntry(signal))}
						</div>
					`
				}
			</div>
		</div>
	`;
}

function renderSignalEntry(signal: GateSignal): TemplateResult {
	const vStatus = signal.verification.status;
	const isExpanded = expandedSignalIds.has(signal.id);
	const shortSha = signal.commitSha ? signal.commitSha.slice(0, 7) : "???????";

	// Check for live verification data
	const liveKey = `${signal.gateId}:${signal.id}`;
	const liveEntry = liveVerifications.get(liveKey);
	const isLive = liveEntry && vStatus === "running";

	// Live header info
	const livePassedCount = isLive ? liveEntry!.steps.filter(s => s.status === "passed").length : 0;
	const liveTotalCount = isLive ? liveEntry!.steps.length : 0;

	return html`
		<div class="signal-entry signal-entry--${vStatus}">
			<div class="signal-entry__header" @click=${() => toggleSignalExpand(signal.id)}>
				<span class="signal-status-badge signal-status-badge--${vStatus}">
					${vStatus === "passed" ? "\u2713" : vStatus === "failed" ? "\u2717" : "\u23F3"}
					${vStatus}
				</span>
				<code class="signal-entry__commit">${shortSha}</code>
				<span class="signal-entry__time">${formatRelativeTime(signal.timestamp)}</span>
				${isLive && liveTotalCount > 0 ? html`
					<span class="signal-steps-summary">${livePassedCount}/${liveTotalCount} checks</span>
				` : signal.verification.steps.length > 0 ? html`
					<span class="signal-steps-summary">
						${signal.verification.steps.filter(s => s.passed).length}/${signal.verification.steps.length} checks
					</span>
				` : nothing}
				${vStatus === "running" ? html`
					<button class="cancel-verification-btn" title="Cancel stuck verification"
						@click=${(e: Event) => { e.stopPropagation(); cancelVerification(signal.gateId); }}>
						Cancel
					</button>
				` : nothing}
				<span class="signal-expand-icon">${isExpanded ? "\u25B4" : "\u25BE"}</span>
			</div>
			${isExpanded ? html`
				<div class="signal-entry__body">
					${isLive ? renderLiveVerificationSteps(liveEntry!) : vStatus === "running" && signal.verification.steps.length === 0
						? html`<div class="verify-card verify-card--running" style="padding:8px 10px;">
							<span class="verify-card__icon verify-card__icon--running">\u25CF</span>
							<span>Verification in progress\u2026</span>
						</div>`
						: signal.verification.steps.length === 0 && vStatus === "passed"
							? html`<div class="verify-card verify-card--pass" style="padding:8px 10px;">
								<span class="verify-card__icon verify-card__icon--pass">\u2713</span>
								<span>Passed (no verification)</span>
							</div>`
						: html`
						${signal.verification.steps.map((step, si) => html`
							<div class="verify-step verify-step--${step.passed ? "pass" : "fail"}">
								<div class="verify-step__header">
									<span class="verify-step__icon">${step.passed ? "\u2713" : "\u2717"}</span>
									<span class="verify-step__name">${step.name}</span>
									<span class="verify-step__type">${step.type}</span>
									${step.expect ? html`<span class="verify-step__expect">expect: ${step.expect}</span>` : nothing}
									<span class="verify-step__duration">${step.duration_ms}ms</span>
								</div>
								${step.output ? (
								step.type !== "command"
									? html`<div class="verify-step__output"><markdown-block .content=${step.output}></markdown-block></div>`
									: html`<div class="verify-step__output">${hasAnsi(step.output) ? unsafeHTML(ansiToHtml(step.output)) : step.output}</div>`
								) : nothing}
								${step.artifact ? renderStepArtifact(step.artifact, `${signal.id}:${si}`) : nothing}
							</div>
						`)}
					`}
					${signal.metadata && Object.keys(signal.metadata).length > 0 ? html`
						<div class="signal-metadata">
							<span class="signal-metadata-label">Metadata:</span>
							${Object.entries(signal.metadata).map(([k, v]) => html`
								<span class="signal-metadata-item"><strong>${k}:</strong> ${v}</span>
							`)}
						</div>
					` : nothing}
				</div>
			` : nothing}
		</div>
	`;
}

function toggleLiveStepExpand(key: string): void {
	if (expandedLiveStepKeys.has(key)) {
		expandedLiveStepKeys.delete(key);
	} else {
		expandedLiveStepKeys.add(key);
	}
	renderApp();
}

function formatStepElapsed(startedAt: number): string {
	const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function formatStepDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.round((ms % 60000) / 1000);
	return `${m}m ${s}s`;
}

function toggleArtifactExpand(key: string): void {
	if (expandedArtifactKeys.has(key)) {
		expandedArtifactKeys.delete(key);
	} else {
		expandedArtifactKeys.add(key);
	}
	renderApp();
}

function renderStepArtifact(artifact: { content: string; contentType: string; metadata?: Record<string, string> }, key: string): TemplateResult {
	const isExpanded = expandedArtifactKeys.has(key);

	const contentBlock = artifact.contentType === "text/html"
		? html`
			<button class="artifact-report-btn" @click=${(e: Event) => {
				e.stopPropagation();
				const blob = new Blob([artifact.content], { type: "text/html" });
				window.open(URL.createObjectURL(blob), "_blank");
			}}>View Report</button>
		`
		: isExpanded
			? html`<div class="artifact-content"><markdown-block .content=${artifact.content}></markdown-block></div>`
			: nothing;

	const metadataBlock = artifact.metadata && Object.keys(artifact.metadata).length > 0
		? html`
			<div class="artifact-metadata">
				${Object.entries(artifact.metadata).map(([k, v]) => html`
					<span class="artifact-metadata-item"><strong>${k}:</strong> ${v}</span>
				`)}
			</div>
		`
		: nothing;

	return html`
		<div class="artifact-section">
			${artifact.contentType === "text/html" ? contentBlock : html`
				<div class="artifact-toggle" @click=${(e: Event) => { e.stopPropagation(); toggleArtifactExpand(key); }}>
					<span class="artifact-toggle-icon">${isExpanded ? "\u25B4" : "\u25BE"}</span>
					Full Review
				</div>
				${contentBlock}
			`}
			${metadataBlock}
		</div>
	`;
}

function renderLiveVerificationSteps(entry: LiveVerification): TemplateResult {
	// Auto-pass: complete with no steps
	if (entry.steps.length === 0 && entry.overallStatus !== "running") {
		const isPassed = entry.overallStatus === "passed";
		return html`<div class="verify-card verify-card--${isPassed ? "pass" : "fail"}" style="padding:8px 10px;">
			<span class="verify-card__icon verify-card__icon--${isPassed ? "pass" : "fail"}">${isPassed ? "\u2713" : "\u2717"}</span>
			<span>${isPassed ? "Passed (no verification)" : "Failed"}</span>
		</div>`;
	}

	// Still waiting for step definitions
	if (entry.steps.length === 0) {
		return html`<div class="verify-card verify-card--running" style="padding:8px 10px;">
			<span class="verify-card__icon verify-card__icon--running">\u25CF</span>
			<span>Verification in progress\u2026</span>
		</div>`;
	}

	const passedCount = entry.steps.filter(s => s.status === "passed").length;
	const failedCount = entry.steps.filter(s => s.status === "failed").length;
	const skippedCount = entry.steps.filter(s => s.status === "skipped").length;
	const totalCount = entry.steps.length;
	const isDone = entry.overallStatus !== "running";

	// Determine if steps span multiple phases for phase dividers
	const phases = new Set(entry.steps.map(s => s.phase ?? 0));
	const hasMultiplePhases = phases.size > 1;

	return html`
		<div class="verify-cards">
			<div class="verify-cards__header">
				${isDone
					? entry.overallStatus === "passed"
						? html`<span class="verify-cards__header-status verify-cards__header-status--pass">\u2713 Verified \u2014 passed</span>`
						: html`<span class="verify-cards__header-status verify-cards__header-status--fail">\u2717 Verified \u2014 failed${skippedCount > 0 ? ` (${skippedCount} skipped)` : ""}</span>`
					: html`<span class="verify-cards__header-status verify-cards__header-status--running">Verifying \u2014 ${passedCount}/${totalCount} checks passed${failedCount > 0 ? html`, <span style="color:var(--destructive)">${failedCount} failed</span>` : nothing}</span>`
				}
			</div>
			${entry.steps.map((step, i) => {
				// Phase divider: show before first step of a new phase (when multiple phases exist)
				const prevPhase = i > 0 ? (entry.steps[i - 1].phase ?? 0) : -1;
				const curPhase = step.phase ?? 0;
				const showPhaseDivider = hasMultiplePhases && (i === 0 || curPhase !== prevPhase);
				const stepKey = `${entry.gateId}:${entry.signalId}:${i}`;
				const isRunning = step.status === "running";
				const isPassed = step.status === "passed";
				const isSkipped = step.status === "skipped";
				const isWaiting = step.status === "waiting";
				const hasOutput = !!step.output;
				const isExpanded = expandedLiveStepKeys.has(stepKey);
				const isLlm = step.type === "llm-review";
				const isRunningCmd = isRunning && step.type === "command";
				const clickable = hasOutput || isRunningCmd;

				const cardClass = isWaiting ? "waiting" : isSkipped ? "skipped" : isRunning ? "running" : isPassed ? "pass" : "fail";
				const iconClass = isWaiting ? "waiting" : isSkipped ? "skipped" : isRunning ? "running" : isPassed ? "pass" : "fail";
				const icon = isWaiting ? "\u25CB" : isSkipped ? "\u2014" : isRunning ? "\u25CF" : isPassed ? "\u2713" : "\u2717";

				return html`
					${showPhaseDivider ? html`<div class="phase-divider">Phase ${curPhase}</div>` : nothing}
					<div class="verify-card verify-card--${cardClass}">
						<div class="verify-card__header ${clickable ? "verify-card__header--clickable" : ""}"
							@click=${clickable ? () => {
								if (isRunningCmd) {
									dashboardModalStep = { gateId: entry.gateId, signalId: entry.signalId, stepIndex: i, stepName: step.name, liveOutput: step.liveOutput || step.output || "", stepType: step.type || "" };
									renderApp();
								} else if (hasOutput) {
									toggleLiveStepExpand(stepKey);
								}
							} : null}>
							<span class="verify-card__icon verify-card__icon--${iconClass}">
								${icon}
							</span>
							<span class="verify-card__name">${step.name}</span>
							<span class="verify-card__type-badge ${isLlm ? "verify-card__type-badge--llm" : ""}">${step.type}</span>
							<span class="verify-card__duration">
								${isWaiting ? "" : isRunning ? formatStepElapsed(step.startedAt) : step.durationMs != null ? formatStepDuration(step.durationMs) : ""}
							</span>
							${step.sessionId ? html`
								<a href="#/session/${step.sessionId}"
								   class="verify-card__session-link" title="View live logs"
								   @click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); location.hash = '#/session/' + step.sessionId; }}>view</a>
							` : nothing}
							${isRunningCmd ? html`<span class="verify-card__expand" title="View live output">▸</span>` : nothing}
							${hasOutput ? html`<span class="verify-card__expand">${isExpanded ? "\u25B4" : "\u25BE"}</span>` : nothing}
						</div>
						${isExpanded && step.output ? (
							step.type !== "command"
								? html`<div class="verify-card__output verify-card__output--markdown"><markdown-block .content=${step.output}></markdown-block></div>`
								: html`<pre class="verify-card__output">${hasAnsi(step.output) ? unsafeHTML(ansiToHtml(step.output)) : step.output}</pre>`
						) : nothing}
					</div>
				`;
			})}
		</div>
	`;
}

// ============================================================================
// RENDER: MAIN DASHBOARD
// ============================================================================

export function renderGoalDashboard(): TemplateResult {
	if (loading) {
		// Render a skeleton dashboard with an empty tab bar so tests and
		// ancestor layout can anchor on `.dashboard-container` + `.tab` even
		// before the first fetch resolves. Under heavy parallel load the
		// initial Promise.all can take >30s; without this skeleton the main
		// area appears empty the whole time and any assertion on `.tab`
		// times out.
		const skeletonTabs = ["Spec", "Gates", "Tasks", "Agents", "Commits"];
		return html`
			<div class="dashboard-container" style="flex:1;min-height:0;">
				<div class="tab-bar" data-dashboard-loading="true">
					${skeletonTabs.map((label, i) => html`
						<div class="tab ${i === 1 ? "active" : ""}" title="${label}">
							<span class="tab-label">${label}</span>
						</div>
					`)}
				</div>
				<div class="tab-content" style="flex:1;min-height:0;">
					${bobbitLoadingAnimation()}
				</div>
			</div>
		`;
	}

	if (error || !currentGoal) {
		return html`
			<div class="dashboard-container">
				<div class="dashboard-error">
					<p>${error || "Goal not found"}</p>
					${Button({
						variant: "ghost",
						size: "sm",
						onClick: () => setHashRoute("landing"),
						children: "Back to sessions",
					})}
				</div>
			</div>
		`;
	}

	const activeTab = dashboardTab;

	const isArchived = currentGoal.archived === true;

	return html`
		<div class="dashboard-container">
			${renderParentBreadcrumb(currentGoal)}
			${renderNavBar(currentGoal)}
			${isArchived ? html`
				<div style="margin:0 16px 8px;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:var(--muted);color:var(--muted-foreground);font-size:13px;">
					This goal was archived on ${new Date(currentGoal.archivedAt!).toLocaleDateString()}. Dashboard is read-only.
				</div>
			` : nothing}
			${renderSetupBanner(currentGoal)}
			${renderMetaRows(currentGoal)}
			${renderGatePipeline()}
			${renderMutationBanner()}
			${renderTabBar()}
			<div class="tab-content">
				<div class="tab-panel ${activeTab === "spec" ? "active" : ""}">${activeTab === "spec" ? renderSpecTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "gates" ? "active" : ""}">${activeTab === "gates" ? renderGatesTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "plan" ? "active" : ""}">${activeTab === "plan" ? renderPlanTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "tasks" ? "active" : ""}">${activeTab === "tasks" ? renderTasksTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "agents" ? "active" : ""}">${activeTab === "agents" ? renderAgentsTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "children" ? "active" : ""}">${activeTab === "children" ? renderChildrenTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "commits" ? "active" : ""}">${activeTab === "commits" ? renderCommitsTab() : nothing}</div>
			</div>
		</div>
		${dashboardModalStep ? html`
			<verification-output-modal
				.goalId=${currentGoalId || ""}
				.gateId=${dashboardModalStep.gateId}
				.signalId=${dashboardModalStep.signalId}
				.stepIndex=${dashboardModalStep.stepIndex}
				.stepName=${dashboardModalStep.stepName}
				.stepType=${dashboardModalStep.stepType}
				.open=${true}
				.initialOutput=${dashboardModalStep.liveOutput}
				@close=${() => { dashboardModalStep = null; renderApp(); }}
			></verification-output-modal>
		` : nothing}
	`;
}

// ============================================================================
// BACKWARD COMPAT: renderAgentPanel (exported but only used internally before)
// ============================================================================

export function renderAgentPanel(_agentList: TeamAgent[]): TemplateResult {
	return renderAgentsTab();
}
