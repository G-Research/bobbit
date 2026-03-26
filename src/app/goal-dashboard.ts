import { html, nothing, type TemplateResult } from "lit";
import "../ui/components/VerificationOutputModal.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { state, renderApp, type Goal } from "./state.js";
import { gatewayFetch, deleteGoal, startTeam, teardownTeam, getTeamState, fetchGoalGates, fetchRoles, refreshPrStatusCache, type GateState, type GateSignal } from "./api.js";
import { setHashRoute } from "./routing.js";
import { createAndConnectSession, connectToSession } from "./session-manager.js";
import { showGoalDialog } from "./dialogs.js";
import { statusBobbit } from "./session-colors.js";

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
	commitSha?: string;
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
interface GoalGitStatus {
	branch: string;
	primaryBranch: string;
	isOnPrimary: boolean;
	clean: boolean;
	aheadOfPrimary: number;
	behindPrimary: number;
	mergedIntoPrimary: boolean;
}
let gitStatus: GoalGitStatus | null = null;

/** PR status for goal branch */
interface PrStatus {
	number: number;
	url: string;
	title: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	mergeable: boolean;
	viewerIsAdmin?: boolean;
	reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
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
let gitStatusPollTimer: ReturnType<typeof setInterval> | null = null;
let setupPollTimer: ReturnType<typeof setInterval> | null = null;

/** Live verification tracking */
interface LiveVerification {
	gateId: string;
	signalId: string;
	steps: Array<{ name: string; type: string; status: string; durationMs?: number; output?: string; liveOutput?: string; startedAt: number; sessionId?: string }>;
	overallStatus: string;
}
let liveVerifications: Map<string, LiveVerification> = new Map();
let liveVerifTimer: ReturnType<typeof setInterval> | null = null;
let expandedLiveStepKeys: Set<string> = new Set();
let dashboardModalStep: { gateId: string; signalId: string; stepIndex: number; stepName: string; liveOutput: string } | null = null;

/** Current dashboard tab */
let dashboardTab: "spec" | "tasks" | "agents" | "commits" | "gates" = "gates";

/** Role picker dropdown state */
let roleDropdownOpen = false;

// ============================================================================
// DATA FETCHING
// ============================================================================

export async function loadDashboardData(goalId: string): Promise<void> {
	currentGoalId = goalId;
	loading = true;
	error = "";
	renderApp();

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
		}

		if (costRes && costRes.ok) {
			goalCost = await costRes.json();
		}

		if (prStatusRes && prStatusRes.ok) {
			prStatus = await prStatusRes.json();
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
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		loading = false;
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
						durationMs: s.durationMs,
						output: s.output,
						startedAt: s.startedAt,
					})),
					overallStatus: v.overallStatus,
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
	prStatus = null;
	goalCost = null;
	stopAgentPolling();
	stopTaskPolling();
	stopGatePolling();
	stopCostPolling();
	stopGitStatusPolling();
	stopSetupStatusPoll();
	document.removeEventListener("gate-verification-event", handleLiveVerificationEvent);
	liveVerifications = new Map();
	expandedLiveStepKeys = new Set();
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

	const key = `${detail.gateId}:${detail.signalId}`;

	switch (detail.type) {
		case "gate_verification_started": {
			const now = detail.startedAt || Date.now();
			const steps = (detail.steps || []).map((s: any) => ({
				name: s.name, type: s.type, status: "running", startedAt: now,
			}));
			liveVerifications.set(key, { gateId: detail.gateId, signalId: detail.signalId, steps, overallStatus: "running" });
			startLiveVerifTimer();
			renderApp();
			break;
		}
		case "gate_verification_step_started": {
			const entry = liveVerifications.get(key);
			if (entry && entry.steps[detail.stepIndex]) {
				entry.steps[detail.stepIndex] = {
					...entry.steps[detail.stepIndex],
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

function startGitStatusPolling(goalId: string): void {
	stopGitStatusPolling();
	gitStatusPollTimer = setInterval(async () => {
		if (!currentGoalId || currentGoalId !== goalId) return;
		let needRender = false;
		try {
			const res = await gatewayFetch(`/api/goals/${goalId}/git-status`);
			if (res.ok) {
				const newStatus: GoalGitStatus = await res.json();
				if (JSON.stringify(newStatus) !== JSON.stringify(gitStatus)) {
					gitStatus = newStatus;
					needRender = true;
				}
			}
		} catch { /* ignore */ }
		try {
			const prRes = await gatewayFetch(`/api/goals/${goalId}/pr-status`).catch(() => null);
			if (prRes && prRes.ok) {
				const newPr: PrStatus = await prRes.json();
				if (JSON.stringify(newPr) !== JSON.stringify(prStatus)) {
					prStatus = newPr;
					needRender = true;
				}
			} else if (prStatus !== null) {
				prStatus = null;
				needRender = true;
			}
		} catch { /* ignore */ }
		if (needRender) renderApp();
	}, 30_000);
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

/** Compute dependency depth for each workflow gate via BFS from roots. */
function computeGateDepthLevels(
	wfGates: Array<{ id: string; name: string; dependsOn: string[] }>,
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

	const testTasks = taskList.filter(t => t.type === "test" && t.commitSha);
	const reviewTasks = taskList.filter(t => t.type === "review" && t.commitSha);

	for (const task of testTasks) {
		const sha = task.commitSha!;
		if (!badges.has(sha)) continue;
		const b = badges.get(sha)!;
		if (task.state === "complete") b.tests = "pass";
		else if (task.state === "skipped") b.tests = "fail";
		else if (task.state === "in-progress") b.tests = "pending";
	}

	for (const task of reviewTasks) {
		const sha = task.commitSha!;
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

// ============================================================================
// PR MERGE HANDLER
// ============================================================================

async function handlePrMerge(e: CustomEvent<{ method: string; admin?: boolean }>): Promise<void> {
	if (!currentGoalId) return;
	const widget = e.target as import('../ui/components/GitStatusWidget.js').GitStatusWidget;
	const goalId = currentGoalId;
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/pr-merge`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ method: e.detail.method, ...(e.detail.admin ? { admin: true } : {}) }),
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
		if (prRes && prRes.ok) prStatus = await prRes.json();
		else prStatus = null;
	} catch { /* ignore */ }
	refreshPrStatusCache();
	renderApp();
}

async function handleGitFetch(): Promise<void> {
	if (!currentGoalId) return;
	const goalId = currentGoalId;
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/git-status?fetch=true`).catch(() => null);
		if (res && res.ok) {
			gitStatus = await res.json();
			renderApp();
		}
	} catch { /* ignore */ }
}

// ============================================================================
// SVG ICON HELPERS
// ============================================================================

const svgArrowLeft = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`;
const svgPencil = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
const svgTrash = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`;
const svgPlay = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
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
const svgDoc = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;

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
			</div>
			<div class="nav-right">
				${goal.archived ? nothing : html`
					<button class="btn-icon" @click=${() => showGoalDialog(goal)} title="Edit goal">${svgPencil}<span>Edit</span></button>
					<button class="btn-icon danger" @click=${() => deleteGoal(goal.id)} title="Archive goal">${svgTrash}<span>Archive</span></button>
					${isTeamGoal ? renderTeamButton(goal) : renderSessionButton(goal)}
				`}
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
	return html`
		<div class="btn-split">
			<button class="btn-split-main" title="Start the goal team" @click=${() => handleStartTeam(goal.id)} ?disabled=${teamStarting || goal.setupStatus !== "ready"}>
				${svgPlay}
				<span>${teamStarting ? "Starting\u2026" : "Start Team"}</span>
			</button>
		</div>
	`;
}

function renderSessionButton(goal: Goal): TemplateResult {
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
	const isTeamGoal = !!goal.team;
	const branch = goal.branch || "";
	const gs = gitStatus;

	return html`
		<div class="meta-rows">
			${goalCost && goalCost.totalCost > 0 ? html`
			<div class="meta-row">
				<div class="meta-item" title="Input: ${formatTokens(goalCost.inputTokens)} | Output: ${formatTokens(goalCost.outputTokens)} | Cache read: ${formatTokens(goalCost.cacheReadTokens)} | Cache write: ${formatTokens(goalCost.cacheWriteTokens)}">
					${svgDollar}
					<span class="meta-tag cost-tag">${formatCost(goalCost.totalCost)}</span>
					<span class="meta-label">${formatTokens(goalCost.inputTokens + goalCost.outputTokens)} tokens</span>
				</div>
			</div>
			` : nothing}
			${branch || gs ? html`
				<div class="meta-row dashboard-git-row">
					<git-status-widget
						.branch=${gs?.branch ?? branch}
						.primaryBranch=${gs?.primaryBranch ?? "master"}
						.isOnPrimary=${gs?.isOnPrimary ?? false}
						.clean=${gs?.clean ?? true}
						.hasUpstream=${true}
						.ahead=${0}
						.behind=${0}
						.aheadOfPrimary=${gs?.aheadOfPrimary ?? 0}
						.behindPrimary=${gs?.behindPrimary ?? 0}
						.mergedIntoPrimary=${gs?.mergedIntoPrimary ?? false}
						.unpushed=${false}
						.statusFiles=${[]}
						.loading=${!gs && !!branch}
						.prState=${prStatus?.state}
						.prUrl=${prStatus?.url}
						.prNumber=${prStatus?.number}
						.prTitle=${prStatus?.title}
						.prMergeable=${prStatus?.mergeable ?? false}
						.viewerIsAdmin=${prStatus?.viewerIsAdmin ?? false}
						.reviewDecision=${prStatus?.reviewDecision}
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
// RENDER: SUMMARY ROW
// ============================================================================

function renderSummaryRow(taskList: Task[], agentList: TeamAgent[]): TemplateResult {
	const total = taskList.length;
	const done = taskList.filter((t) => t.state === "complete").length;
	const inProgress = taskList.filter((t) => t.state === "in-progress").length;
	const failed = taskList.filter((t) => t.state === "skipped").length;
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;
	const circumference = 2 * Math.PI * 14; // radius 14
	const offset = circumference - (pct / 100) * circumference;

	const workingAgents = agentList.filter(a => a.status === "streaming").length;
	const idleAgents = agentList.length - workingAgents;

	return html`
		<div class="summary-row">
			<div class="summary-ring">
				<div class="ring-container">
					<svg class="ring-bg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14"/></svg>
					<svg class="ring-fg" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/></svg>
					<div class="ring-label">${pct}%</div>
				</div>
				<div>
					<div class="ring-text">${done}/${total} tasks</div>
					<div class="ring-sub">complete</div>
				</div>
			</div>
			<div class="summary-stats">
				<div class="mini-stat">
					<span class="mini-stat-value" style="color:oklch(0.72 0.15 250)">${inProgress}</span>
					<span class="mini-stat-label">Active</span>
				</div>
				<div class="mini-stat">
					<span class="mini-stat-value" style="color:var(--destructive)">${failed}</span>
					<span class="mini-stat-label">Failed</span>
				</div>
				<div class="mini-stat">
					<span class="mini-stat-value" style="color:oklch(0.72 0.15 145)">${agentList.length}</span>
					<span class="mini-stat-label">Agents</span>
				</div>
			</div>
			${agentList.length > 0 ? html`
				<div class="summary-agents">
					<div class="bobbit-row">
						${agentList.map(agent => {
							const session = state.gatewaySessions.find(s => s.id === agent.sessionId)
								|| state.archivedSessions.find(s => s.id === agent.sessionId);
							return statusBobbit(
								session?.status ?? agent.status,
								session?.isCompacting ?? false,
								agent.sessionId,
								false,
								session?.isAborting ?? false,
								agent.role === "team-lead",
								agent.role === "coder",
								session?.accessory,
							);
						})}
					</div>
					<span class="bobbit-mini-label">${workingAgents} working, ${idleAgents} idle</span>
				</div>
			` : nothing}
		</div>
	`;
}

// ============================================================================
// RENDER: GATE PIPELINE (horizontal visualization)
// ============================================================================

function renderGatePipeline(): TemplateResult {
	const wfGates = currentGoal?.workflow?.gates;
	if (!wfGates || wfGates.length === 0) return html``;

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
	const isExpanded = expandedGateIds.has(node.id);
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

function setTab(tab: typeof dashboardTab): void {
	dashboardTab = tab;
	renderApp();
}

function renderTabBar(): TemplateResult {
	const wfTotal = currentGoal?.workflow?.gates.length ?? 0;
	const passedCount = gates.filter(g => g.status === "passed").length;
	const gateCountStr = wfTotal > 0 ? `${passedCount}/${wfTotal}` : String(gates.length);

	const tabs: Array<{ id: typeof dashboardTab; label: string; icon: TemplateResult; countStr: string }> = [
		{ id: "spec", label: "Spec", icon: svgDoc, countStr: "" },
		{ id: "gates", label: "Gates", icon: svgGate, countStr: gateCountStr },
		{ id: "tasks", label: "Tasks", icon: svgTasks, countStr: String(tasks.length) },
		{ id: "agents", label: "Agents", icon: svgAgents, countStr: String(agents.length + (currentGoal?.team && (state.gatewaySessions.some(s => (s.goalId === currentGoal!.id || s.teamGoalId === currentGoal!.id) && s.role === "team-lead") || state.archivedSessions.some(s => (s.goalId === currentGoal!.id || s.teamGoalId === currentGoal!.id) && s.role === "team-lead")) ? 1 : 0)) },
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
	const hasWorkflow = currentGoal?.workflow && currentGoal.workflow.gates.length > 0;

	if (!hasWorkflow) {
		return html`<div class="tab-empty">${svgGate}<span>No workflow gates defined</span></div>`;
	}

	return html`
		<div class="tab-panel-inner">
			${renderGateChecklist()}
		</div>
	`;
}

function renderGateChecklist(): TemplateResult {
	if (!currentGoal?.workflow) return nothing as any;

	const wfGates = currentGoal.workflow.gates;
	const statusMap = getGateStatusMap();

	// Topological sort for display order
	const visited = new Set<string>();
	const sorted: typeof wfGates = [];
	const gateMap = new Map(wfGates.map(g => [g.id, g]));
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
	wfGate: NonNullable<Goal["workflow"]>["gates"][number],
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
						${signal.verification.steps.map(step => html`
							<div class="verify-step verify-step--${step.passed ? "pass" : "fail"}">
								<div class="verify-step__header">
									<span class="verify-step__icon">${step.passed ? "\u2713" : "\u2717"}</span>
									<span class="verify-step__name">${step.name}</span>
									<span class="verify-step__type">${step.type}</span>
									${step.expect ? html`<span class="verify-step__expect">expect: ${step.expect}</span>` : nothing}
									<span class="verify-step__duration">${step.duration_ms}ms</span>
								</div>
								${step.output ? html`
									<div class="verify-step__output">${step.output}</div>
								` : nothing}
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
	const totalCount = entry.steps.length;
	const isDone = entry.overallStatus !== "running";

	return html`
		<div class="verify-cards">
			<div class="verify-cards__header">
				${isDone
					? entry.overallStatus === "passed"
						? html`<span class="verify-cards__header-status verify-cards__header-status--pass">\u2713 Verified \u2014 passed</span>`
						: html`<span class="verify-cards__header-status verify-cards__header-status--fail">\u2717 Verified \u2014 failed</span>`
					: html`<span class="verify-cards__header-status verify-cards__header-status--running">Verifying \u2014 ${passedCount}/${totalCount} checks passed${failedCount > 0 ? html`, <span style="color:var(--destructive)">${failedCount} failed</span>` : nothing}</span>`
				}
			</div>
			${entry.steps.map((step, i) => {
				const stepKey = `${entry.gateId}:${entry.signalId}:${i}`;
				const isRunning = step.status === "running";
				const isPassed = step.status === "passed";
				const isFailed = step.status === "failed";
				const hasOutput = !!step.output;
				const isExpanded = expandedLiveStepKeys.has(stepKey);
				const isLlm = step.type === "llm-review";
				const isRunningCmd = isRunning && step.type === "command";
				const clickable = hasOutput || isRunningCmd;

				return html`
					<div class="verify-card verify-card--${isRunning ? "running" : isPassed ? "pass" : "fail"}">
						<div class="verify-card__header ${clickable ? "verify-card__header--clickable" : ""}"
							@click=${clickable ? () => {
								if (isRunningCmd) {
									dashboardModalStep = { gateId: entry.gateId, signalId: entry.signalId, stepIndex: i, stepName: step.name, liveOutput: step.liveOutput || "" };
									renderApp();
								} else if (hasOutput) {
									toggleLiveStepExpand(stepKey);
								}
							} : null}>
							<span class="verify-card__icon verify-card__icon--${isRunning ? "running" : isPassed ? "pass" : "fail"}">
								${isRunning ? "\u25CF" : isPassed ? "\u2713" : "\u2717"}
							</span>
							<span class="verify-card__name">${step.name}</span>
							<span class="verify-card__type-badge ${isLlm ? "verify-card__type-badge--llm" : ""}">${step.type}</span>
							<span class="verify-card__duration">
								${isRunning ? formatStepElapsed(step.startedAt) : step.durationMs != null ? formatStepDuration(step.durationMs) : ""}
							</span>
							${step.sessionId ? html`
								<a href="/?token=${encodeURIComponent(localStorage.getItem("gateway.token") || "")}#/session/${step.sessionId}"
								   target="_blank" rel="noopener"
								   class="verify-card__session-link" title="View live logs"
								   @click=${(e: Event) => e.stopPropagation()}>view</a>
							` : nothing}
							${isRunningCmd ? html`<span class="verify-card__expand" title="View live output">▸</span>` : nothing}
							${hasOutput ? html`<span class="verify-card__expand">${isExpanded ? "\u25B4" : "\u25BE"}</span>` : nothing}
						</div>
						${isExpanded && step.output ? html`
							<pre class="verify-card__output">${step.output}</pre>
						` : nothing}
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
		return html`
			<div class="dashboard-container">
				<div class="dashboard-loading">
					<svg class="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
					</svg>
					<span>Loading dashboard\u2026</span>
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
			${renderNavBar(currentGoal)}
			${isArchived ? html`
				<div style="margin:0 16px 8px;padding:10px 14px;border-radius:8px;border:1px solid var(--border);background:var(--muted);color:var(--muted-foreground);font-size:13px;">
					This goal was archived on ${new Date(currentGoal.archivedAt!).toLocaleDateString()}. Dashboard is read-only.
				</div>
			` : nothing}
			${renderSetupBanner(currentGoal)}
			${renderMetaRows(currentGoal)}
			${renderSummaryRow(tasks, agents)}
			${renderGatePipeline()}
			${renderTabBar()}
			<div class="tab-content">
				<div class="tab-panel ${activeTab === "spec" ? "active" : ""}">${activeTab === "spec" ? renderSpecTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "gates" ? "active" : ""}">${activeTab === "gates" ? renderGatesTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "tasks" ? "active" : ""}">${activeTab === "tasks" ? renderTasksTab() : nothing}</div>
				<div class="tab-panel ${activeTab === "agents" ? "active" : ""}">${activeTab === "agents" ? renderAgentsTab() : nothing}</div>
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

export function renderAgentPanel(agentList: TeamAgent[]): TemplateResult {
	return renderAgentsTab();
}
