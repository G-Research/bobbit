import {
	state,
	renderApp,
	expandedGoals,
	saveExpandedGoals,
	GW_URL_KEY,
	GW_TOKEN_KEY,
	type GatewaySession,
	type Goal,
} from "./state.js";
import { setHashRoute } from "./routing.js";
import { sessionHueRotation, sessionColorMap } from "./session-colors.js";
import { RemoteAgent } from "./remote-agent.js";
import { showFaviconBadge } from "./favicon-badge.js";

/** Track previous session statuses to detect streaming→idle transitions. */
const _prevSessionStatus = new Map<string, string>();

/** Throttle PR status polling — don't hit GitHub API on every session poll. */
let _lastPrRefresh = 0;
const PR_POLL_INTERVAL_MS = 60_000;

// dialogs.ts imports from api.ts, so we use dynamic import to break the cycle
async function showConnectionError(title: string, message: string): Promise<void> {
	const { showConnectionError: show } = await import("./dialogs.js");
	show(title, message);
}

// ============================================================================
// GATEWAY FETCH
// ============================================================================

export function gatewayFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const url = localStorage.getItem(GW_URL_KEY) || window.location.origin;
	const token = localStorage.getItem(GW_TOKEN_KEY) || "";
	return fetch(`${url}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
}

// ============================================================================
// SESSION HELPERS
// ============================================================================

export function updateLocalSessionTitle(sessionId: string, title: string): void {
	const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
	if (idx >= 0) {
		state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], title };
		renderApp();
	}
}

export function updateLocalSessionStatus(sessionId: string, status: string): void {
	const idx = state.gatewaySessions.findIndex((s) => s.id === sessionId);
	if (idx >= 0) {
		state.gatewaySessions[idx] = { ...state.gatewaySessions[idx], status, lastActivity: Date.now() };
		renderApp();
	}
}

export function startSessionPolling(): void {
	stopSessionPolling();
	state.sessionPollTimer = setInterval(() => {
		if (state.appView === "authenticated" && document.visibilityState === "visible") {
			refreshSessions();
		}
	}, 5_000);
}

export function stopSessionPolling(): void {
	if (state.sessionPollTimer) {
		clearInterval(state.sessionPollTimer);
		state.sessionPollTimer = null;
	}
}

export async function refreshSessions(): Promise<void> {
	const isInitial = state.gatewaySessions.length === 0 && !state.sessionsError;
	if (isInitial) {
		state.sessionsLoading = true;
		state.sessionsError = "";
		renderApp();
	}

	try {
		const [sessionsRes, goalsRes] = await Promise.all([
			gatewayFetch("/api/sessions"),
			gatewayFetch("/api/goals"),
		]);
		if (!sessionsRes.ok) throw new Error(`Failed to fetch sessions: ${sessionsRes.status}`);
		const sessionsData = await sessionsRes.json();
		const newSessions: GatewaySession[] = sessionsData.sessions || [];

		// Beep when a non-active background session finishes streaming
		const activeId = state.remoteAgent?.gatewaySessionId;
		for (const s of newSessions) {
			const prev = _prevSessionStatus.get(s.id);
			const isSubAgent = !!s.delegateOf || (!!s.role && s.role !== "lead");
			if (prev === "streaming" && s.status === "idle" && s.id !== activeId && !isSubAgent) {
				RemoteAgent.playNotificationBeep();
				showFaviconBadge();
			}
		}
		for (const s of newSessions) {
			_prevSessionStatus.set(s.id, s.status);
		}

		state.gatewaySessions = newSessions;

		for (const s of state.gatewaySessions) {
			if (s.colorIndex !== undefined && !sessionColorMap.has(s.id)) {
				sessionColorMap.set(s.id, s.colorIndex);
			}
			sessionHueRotation(s.id);
		}

		if (goalsRes.ok) {
			const goalsData = await goalsRes.json();
			const prevGoalIds = new Set(state.goals.map((g) => g.id));
			state.goals = goalsData.goals || [];
			// Auto-expand only newly discovered goals that have sessions — never
			// re-expand a goal the user has already seen (and may have collapsed).
			for (const g of state.goals) {
				if (!prevGoalIds.has(g.id) && state.gatewaySessions.some((s) => s.goalId === g.id)) {
					expandedGoals.add(g.id);
					saveExpandedGoals();
				}
			}
		}

		state.sessionsError = "";
	} catch (err) {
		if (isInitial) {
			state.sessionsError = err instanceof Error ? err.message : String(err);
			state.gatewaySessions = [];
		}
	} finally {
		state.sessionsLoading = false;
		renderApp();
	}

	// Fetch gate + PR status for sidebar badges (fire-and-forget, updates on completion).
	// These call renderApp() only if data actually changed, avoiding redundant re-renders.
	refreshGateStatusCache();
	const now = Date.now();
	if (now - _lastPrRefresh >= PR_POLL_INTERVAL_MS && document.visibilityState === "visible") {
		_lastPrRefresh = now;
		refreshPrStatusCache();
	}

	// One-time hydration of PR status from disk cache (instant badge rendering)
	if (isInitial) {
		gatewayFetch("/api/pr-status-cache")
			.then(r => r.ok ? r.json() : null)
			.then(data => {
				if (data && typeof data === "object") {
					let changed = false;
					for (const [goalId, entry] of Object.entries(data)) {
						if (!state.prStatusCache.has(goalId)) {
							state.prStatusCache.set(goalId, entry as any);
							changed = true;
						}
					}
					if (changed) renderApp();
				}
			})
			.catch(() => {});
	}

	// Lazy-load archived sessions on initial load only if user had "Show archived" persisted
	if (isInitial && state.showArchived && !_archivedSessionsLoaded) {
		fetchArchivedSessions();
	}
}

/** Whether archived sessions have been fetched at least once. */
let _archivedSessionsLoaded = false;

/** Check whether archived sessions have been loaded. */
export function archivedSessionsLoaded(): boolean {
	return _archivedSessionsLoaded;
}

/** Reset the archived sessions state (flag + data). Called on toggle-off. */
export function clearArchivedSessionsState(): void {
	_archivedSessionsLoaded = false;
	state.archivedSessions = [];
}

/** Fetch archived sessions from the API. */
export async function fetchArchivedSessions(): Promise<void> {
	_archivedSessionsLoaded = true;
	try {
		const res = await gatewayFetch("/api/sessions?include=archived");
		if (!res.ok) return;
		const data = await res.json();
		const sessions: GatewaySession[] = data.sessions || [];
		// Filter to only archived ones
		state.archivedSessions = sessions.filter((s: any) => s.archived === true);
		renderApp();
	} catch {
		// Silently fail
	}
}

/** Fetch gate statuses for all goals with workflows and update the cache. */
async function refreshGateStatusCache() {
	const goalsWithWorkflow = state.goals.filter(g => g.workflow && g.workflow.gates.length > 0);
	if (goalsWithWorkflow.length === 0) return;

	const results = await Promise.all(
		goalsWithWorkflow.map(async (g) => {
			const gates = await fetchGoalGates(g.id);
			const passed = gates.filter(gs => gs.status === "passed").length;
			const total = g.workflow!.gates.length;
			const verifying = gates.some(gs => gs.signals?.some(s => s.verification?.status === "running"));
			return { goalId: g.id, passed, total, verifying };
		})
	);

	let changed = false;
	for (const { goalId, passed, total, verifying } of results) {
		const prev = state.gateStatusCache.get(goalId);
		if (!prev || prev.passed !== passed || prev.total !== total || prev.verifying !== verifying) {
			state.gateStatusCache.set(goalId, { passed, total, verifying });
			changed = true;
		}
	}
	if (changed) renderApp();
}

/** Fetch PR status for all goals with branches and update the cache. */
let _prRefreshInFlight = false;
export async function refreshPrStatusCache() {
	if (_prRefreshInFlight) return;
	_prRefreshInFlight = true;
	try {
	// Only poll active goals — completed/archived goals keep their cached PR status
	// Only poll active goals — completed/archived goals keep their cached PR status
	const goalsWithBranch = state.goals.filter(g => g.branch && g.state !== 'complete' && !g.archived && state.prStatusCache.get(g.id)?.state !== 'MERGED');
	if (goalsWithBranch.length === 0) return;

	const results = await Promise.all(
		goalsWithBranch.map(async (g) => {
			try {
				const res = await gatewayFetch(`/api/goals/${g.id}/pr-status`);
				if (res.status === 404) return { goalId: g.id, pr: null, noPr: true };
				if (!res.ok) return { goalId: g.id, pr: null, noPr: false };
				const data = await res.json();
				return { goalId: g.id, pr: data as { state: string; url?: string; number?: number; reviewDecision?: string; mergeable?: string }, noPr: false };
			} catch {
				return { goalId: g.id, pr: null, noPr: false };
			}
		})
	);

	let changed = false;
	for (const { goalId, pr, noPr } of results) {
		const prev = state.prStatusCache.get(goalId);
		if (pr) {
			if (!prev || prev.state !== pr.state || prev.reviewDecision !== pr.reviewDecision || prev.mergeable !== pr.mergeable) {
				state.prStatusCache.set(goalId, pr);
				changed = true;
			}
		} else if (noPr && prev) {
			// Only clear cache on explicit 404 (no PR exists), not on transient errors
			state.prStatusCache.delete(goalId);
			changed = true;
		}
	}
	if (changed) renderApp();
	} finally {
		_prRefreshInFlight = false;
	}
}

// ============================================================================
// GIT STATUS
// ============================================================================

export interface GitStatusData {
	branch: string;
	primaryBranch: string;
	isOnPrimary: boolean;
	summary: string;
	clean: boolean;
	hasUpstream: boolean;
	ahead: number;
	behind: number;
	aheadOfPrimary: number;
	behindPrimary: number;
	mergedIntoPrimary: boolean;
	unpushed: boolean;
	status: Array<{ file: string; status: string }>;
}

export async function fetchGitStatus(sessionId: string, opts?: { fetch?: boolean }): Promise<GitStatusData | null> {
	try {
		const qs = opts?.fetch ? '?fetch=true' : '';
		const res = await gatewayFetch(`/api/sessions/${sessionId}/git-status${qs}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

// ============================================================================
// GOAL API
// ============================================================================

export async function createGoal(title: string, cwd: string, opts?: { spec?: string; workflowId?: string; reattemptOf?: string }): Promise<Goal | null> {
	const { spec = "", workflowId, reattemptOf } = opts ?? {};
	try {
		const body: Record<string, any> = { title, cwd, spec, team: true, worktree: true };
		if (workflowId) body.workflowId = workflowId;
		if (reattemptOf) body.reattemptOf = reattemptOf;
		const res = await gatewayFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`Failed to create goal: ${res.status}`);
		const goal = await res.json();
		await refreshSessions();
		expandedGoals.add(goal.id);
		saveExpandedGoals();
		return goal;
	} catch (err) {
		showConnectionError("Failed to create goal", err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function updateGoal(id: string, updates: Partial<Pick<Goal, "title" | "cwd" | "state" | "spec" | "team">>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${id}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) throw new Error(`Failed to update goal: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		showConnectionError("Failed to update goal", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function deleteGoal(id: string): Promise<void> {
	const { confirmAction } = await import("./dialogs.js");
	const goal = state.goals.find((g) => g.id === id);
	const goalTitle = goal?.title || "this goal";
	const sessionsUnderGoal = state.gatewaySessions.filter((s) => s.goalId === id);

	let message = `Are you sure you want to delete "${goalTitle}"?`;
	if (sessionsUnderGoal.length > 0) {
		message += ` Its ${sessionsUnderGoal.length} session(s) will become ungrouped.`;
	}

	const confirmed = await confirmAction("Archive Goal", `Archive "${goalTitle}"? It will move to the archived section.`, "Archive", false);
	if (!confirmed) return;

	try {
		await gatewayFetch(`/api/goals/${id}`, { method: "DELETE" });
		setHashRoute("landing");
		await refreshSessions();
	} catch (err) {
		showConnectionError("Failed to archive goal", err instanceof Error ? err.message : String(err));
	}
}

/** Persist a session property update to the server via PATCH */
export function patchSession(sessionId: string, updates: Record<string, unknown>): void {
	gatewayFetch(`/api/sessions/${sessionId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(updates),
	}).catch(() => { /* best-effort */ });
}

// ============================================================================
// TEAM API
// ============================================================================

export async function startTeam(goalId: string): Promise<string | null> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/start`, {
			method: "POST",
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		const data = await res.json();
		await refreshSessions();
		return data.sessionId;
	} catch (err) {
		showConnectionError("Failed to start team", err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function getTeamState(goalId: string): Promise<any | null> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function completeTeam(goalId: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/complete`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		showConnectionError("Failed to complete team", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function teardownTeam(goalId: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/team/teardown`, {
			method: "POST",
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		await refreshSessions();
		return true;
	} catch (err) {
		showConnectionError("Failed to tear down team", err instanceof Error ? err.message : String(err));
		return false;
	}
}

// ============================================================================
// GOAL ARTIFACT API
// ============================================================================



// ============================================================================
// WORKFLOW API
// ============================================================================

export interface VerifyStep {
	name: string;
	type: "command" | "llm-review";
	run?: string;
	prompt?: string;
	expect?: "success" | "failure";
	timeout?: number;
}

export interface WorkflowGate {
	id: string;
	name: string;
	dependsOn: string[];
	content?: boolean;
	injectDownstream?: boolean;
	metadata?: Record<string, string>;
	verify?: VerifyStep[];
}

/** @deprecated Use WorkflowGate instead */
export type WorkflowArtifact = WorkflowGate;

export interface Workflow {
	id: string;
	name: string;
	description: string;
	gates: WorkflowGate[];
	createdAt: number;
	updatedAt: number;
}

export async function fetchWorkflows(): Promise<Workflow[]> {
	try {
		const res = await gatewayFetch("/api/workflows");
		if (!res.ok) return [];
		const data = await res.json();
		return data.workflows || [];
	} catch {
		return [];
	}
}

export async function fetchWorkflow(id: string): Promise<Workflow | null> {
	try {
		const res = await gatewayFetch(`/api/workflows/${encodeURIComponent(id)}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function createWorkflow(workflow: { id: string; name: string; description: string; gates: WorkflowGate[] }): Promise<Workflow | null> {
	try {
		const res = await gatewayFetch("/api/workflows", {
			method: "POST",
			body: JSON.stringify(workflow),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return await res.json();
	} catch (err) {
		showConnectionError("Failed to create workflow", err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function updateWorkflow(id: string, updates: Partial<Workflow>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/workflows/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return true;
	} catch (err) {
		showConnectionError("Failed to update workflow", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function deleteWorkflow(id: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/workflows/${encodeURIComponent(id)}`, {
			method: "DELETE",
		});
		return res.ok || res.status === 204;
	} catch (err) {
		showConnectionError("Failed to delete workflow", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function cloneWorkflow(id: string): Promise<Workflow | null> {
	try {
		const res = await gatewayFetch(`/api/workflows/${encodeURIComponent(id)}/clone`, {
			method: "POST",
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return await res.json();
	} catch (err) {
		showConnectionError("Failed to clone workflow", err instanceof Error ? err.message : String(err));
		return null;
	}
}



// ── Gate API ─────────────────────────────────────────────────────

export interface GateState {
	gateId: string;
	goalId: string;
	status: "pending" | "passed" | "failed";
	currentContent?: string;
	currentContentVersion?: number;
	currentMetadata?: Record<string, string>;
	signals: GateSignal[];
	updatedAt: number;
	// Enriched from workflow definition
	name?: string;
	dependsOn?: string[];
	signalCount?: number;
}

export interface GateSignal {
	id: string;
	gateId: string;
	goalId: string;
	sessionId: string;
	timestamp: number;
	commitSha: string;
	metadata?: Record<string, string>;
	content?: string;
	contentVersion?: number;
	verification: {
		status: "running" | "passed" | "failed";
		steps: Array<{
			name: string;
			type: string;
			passed: boolean;
			output: string;
			duration_ms: number;
			expect?: string;
		}>;
	};
}

export async function fetchGoalGates(goalId: string): Promise<GateState[]> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/gates`);
		if (!res.ok) return [];
		const data = await res.json();
		return data.gates || [];
	} catch {
		return [];
	}
}

export async function fetchGateDetail(goalId: string, gateId: string): Promise<GateState | null> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/gates/${gateId}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function fetchGateSignals(goalId: string, gateId: string): Promise<GateSignal[]> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/gates/${gateId}/signals`);
		if (!res.ok) return [];
		const data = await res.json();
		return data.signals || [];
	} catch {
		return [];
	}
}

export async function fetchGateContent(goalId: string, gateId: string): Promise<{ content?: string; version?: number }> {
	try {
		const res = await gatewayFetch(`/api/goals/${goalId}/gates/${gateId}/content`);
		if (!res.ok) return {};
		return await res.json();
	} catch {
		return {};
	}
}

// ============================================================================
// STAFF API
// ============================================================================

export interface StaffAgent {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	cwd: string;
	state: "active" | "paused" | "retired";
	triggers: any[];
	memory: string;
	roleId?: string;
	createdAt: number;
	updatedAt: number;
	lastWakeAt?: number;
	currentSessionId?: string;
}

export async function fetchStaff(): Promise<StaffAgent[]> {
	try {
		const res = await gatewayFetch("/api/staff");
		if (!res.ok) return [];
		const data = await res.json();
		return data.staff || data || [];
	} catch {
		return [];
	}
}

export async function fetchStaffAgent(id: string): Promise<StaffAgent | null> {
	try {
		const res = await gatewayFetch(`/api/staff/${id}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function createStaffAgent(data: { name: string; description: string; systemPrompt: string; cwd: string; triggers?: any[] }): Promise<StaffAgent | null> {
	try {
		const res = await gatewayFetch("/api/staff", {
			method: "POST",
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			const d = await res.json().catch(() => ({}));
			throw new Error(d.error || `Failed: ${res.status}`);
		}
		return await res.json();
	} catch (err) {
		showConnectionError("Failed to create staff agent", err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function updateStaffAgent(id: string, updates: Partial<Pick<StaffAgent, "name" | "description" | "systemPrompt" | "cwd" | "state" | "triggers" | "memory">>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/staff/${id}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		return true;
	} catch (err) {
		showConnectionError("Failed to update staff agent", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function deleteStaffAgent(id: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/staff/${id}`, { method: "DELETE" });
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		return true;
	} catch (err) {
		showConnectionError("Failed to delete staff agent", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function wakeStaffAgent(id: string, prompt?: string): Promise<{ sessionId: string } | null> {
	try {
		const res = await gatewayFetch(`/api/staff/${id}/wake`, {
			method: "POST",
			body: JSON.stringify({ prompt }),
		});
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		return await res.json();
	} catch (err) {
		showConnectionError("Failed to wake staff agent", err instanceof Error ? err.message : String(err));
		return null;
	}
}



// ============================================================================
// PERSONALITY API
// ============================================================================

export interface PersonalityData {
	name: string;
	label: string;
	description: string;
	promptFragment: string;
	createdAt: number;
	updatedAt: number;
}

export async function fetchPersonalities(): Promise<PersonalityData[]> {
	try {
		const res = await gatewayFetch("/api/personalities");
		if (!res.ok) throw new Error(`Failed to fetch personalities: ${res.status}`);
		const data = await res.json();
		return data.personalities || [];
	} catch (err) {
		console.error("[personality-api] fetchPersonalities failed:", err);
		return [];
	}
}

export async function createPersonality(data: { name: string; label: string; description?: string; promptFragment: string }): Promise<PersonalityData | null> {
	try {
		const res = await gatewayFetch("/api/personalities", {
			method: "POST",
			body: JSON.stringify(data),
		});
		if (!res.ok) {
			const resp = await res.json().catch(() => ({}));
			throw new Error(resp.error || `Failed: ${res.status}`);
		}
		return await res.json();
	} catch (err) {
		showConnectionError("Failed to create personality", err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function updatePersonality(name: string, updates: Partial<Pick<PersonalityData, "label" | "description" | "promptFragment">>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/personalities/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) {
			const resp = await res.json().catch(() => ({}));
			throw new Error(resp.error || `Failed: ${res.status}`);
		}
		return true;
	} catch (err) {
		showConnectionError("Failed to update personality", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function deletePersonality(name: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/personalities/${encodeURIComponent(name)}`, {
			method: "DELETE",
		});
		if (!res.ok) {
			const resp = await res.json().catch(() => ({}));
			throw new Error(resp.error || `Failed: ${res.status}`);
		}
		return true;
	} catch (err) {
		showConnectionError("Failed to delete personality", err instanceof Error ? err.message : String(err));
		return false;
	}
}

// ============================================================================
// ROLE API
// ============================================================================

export interface RoleData {
	name: string;
	label: string;
	promptTemplate: string;
	allowedTools: string[];
	accessory: string;
	createdAt: number;
	updatedAt: number;
}

// ============================================================================
// ASSISTANT PROMPT API
// ============================================================================

export interface AssistantPromptInfo {
	type: string;
	title: string;
	prompt: string;
}

export async function updateAssistantPrompt(type: string, prompt: string): Promise<boolean> {
	const res = await gatewayFetch(`/api/roles/assistant/prompts/${encodeURIComponent(type)}`, {
		method: 'PUT',
		body: JSON.stringify({ prompt }),
	});
	return res.ok;
}

export async function fetchAssistantPrompts(): Promise<AssistantPromptInfo[]> {
	try {
		const res = await gatewayFetch("/api/roles/assistant/prompts");
		if (!res.ok) return [];
		const data = await res.json();
		return data.prompts || [];
	} catch {
		return [];
	}
}

export async function fetchRoles(): Promise<RoleData[]> {
	try {
		const res = await gatewayFetch("/api/roles");
		if (!res.ok) throw new Error(`Failed to fetch roles: ${res.status}`);
		const data = await res.json();
		const roles: RoleData[] = data.roles || data || [];
		// Also cache into state for the role picker sidebar
		state.roles = roles.map((r) => ({
			name: r.name,
			label: r.label,
			accessory: r.accessory,
		}));
		return roles;
	} catch (err) {
		console.error("[role-api] fetchRoles failed:", err);
		return [];
	}
}

export interface ToolInfo {
	name: string;
	description: string;
	group: string;
	docs?: string;
	detail_docs?: string;
	hasRenderer?: boolean;
	rendererFile?: string;
}

export async function fetchTools(): Promise<ToolInfo[]> {
	try {
		const res = await gatewayFetch("/api/tools");
		if (!res.ok) throw new Error(`Failed to fetch tools: ${res.status}`);
		const data = await res.json();
		const tools = data.tools || data || [];
		// Handle legacy string[] format
		if (tools.length > 0 && typeof tools[0] === "string") {
			return tools.map((name: string) => ({ name, description: "", group: "Other" }));
		}
		return tools;
	} catch (err) {
		console.error("[role-api] fetchTools failed:", err);
		return [];
	}
}

export async function fetchToolDetail(name: string): Promise<ToolInfo | null> {
	try {
		const res = await gatewayFetch(`/api/tools/${encodeURIComponent(name)}`);
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function updateTool(name: string, updates: { description?: string; group?: string; docs?: string; detail_docs?: string }): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/tools/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return true;
	} catch (err) {
		showConnectionError("Failed to update tool", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function createRole(role: {
	name: string;
	label: string;
	promptTemplate: string;
	allowedTools: string[];
	accessory: string;
}): Promise<RoleData | null> {
	try {
		const res = await gatewayFetch("/api/roles", {
			method: "POST",
			body: JSON.stringify(role),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return await res.json();
	} catch (err) {
		showConnectionError("Failed to create role", err instanceof Error ? err.message : String(err));
		return null;
	}
}

export async function updateRole(name: string, updates: Partial<Pick<RoleData, "label" | "promptTemplate" | "allowedTools" | "accessory">>): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/roles/${encodeURIComponent(name)}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return true;
	} catch (err) {
		showConnectionError("Failed to update role", err instanceof Error ? err.message : String(err));
		return false;
	}
}

export async function deleteRole(name: string): Promise<boolean> {
	try {
		const res = await gatewayFetch(`/api/roles/${encodeURIComponent(name)}`, {
			method: "DELETE",
		});
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || `Failed: ${res.status}`);
		}
		return true;
	} catch (err) {
		showConnectionError("Failed to delete role", err instanceof Error ? err.message : String(err));
		return false;
	}
}

// ============================================================================
// SETUP STATUS API
// ============================================================================

export async function fetchSetupStatus(): Promise<boolean> {
	try {
		const res = await gatewayFetch("/api/setup-status");
		if (!res.ok) return true; // assume complete on error
		const data = await res.json();
		return data.complete;
	} catch {
		return true;
	}
}

export async function dismissSetup(): Promise<void> {
	try {
		await gatewayFetch("/api/setup-status/dismiss", { method: "POST" });
	} catch { /* ignore */ }
	state.setupComplete = true;
	renderApp();
}

// ============================================================================
// DRAFT API
// ============================================================================

/** Save a draft to the server. Fire-and-forget — errors are logged, not thrown. */
export async function saveDraftToServer(sessionId: string, type: string, data: unknown, signal?: AbortSignal): Promise<void> {
	try {
		await gatewayFetch(`/api/sessions/${sessionId}/draft`, {
			method: "PUT",
			body: JSON.stringify({ type, data }),
			signal,
		});
	} catch (err) {
		// Ignore aborted requests � they're intentionally cancelled on send
		if (err instanceof DOMException && err.name === "AbortError") return;
		console.error("[draft-api] Failed to save draft:", err);
	}
}

/** Load a draft from the server. Returns null if not found or on error. */
export async function loadDraftFromServer(sessionId: string, type: string): Promise<unknown | null> {
	try {
		const res = await gatewayFetch(`/api/sessions/${sessionId}/draft?type=${encodeURIComponent(type)}`);
		if (!res.ok) return null;
		const body = await res.json();
		return body.data ?? null;
	} catch (err) {
		console.error("[draft-api] Failed to load draft:", err);
		return null;
	}
}

/** Delete a draft from the server. Fire-and-forget — errors are logged, not thrown. */
export async function deleteDraftFromServer(sessionId: string, type: string): Promise<void> {
	try {
		await gatewayFetch(`/api/sessions/${sessionId}/draft?type=${encodeURIComponent(type)}`, {
			method: "DELETE",
		});
	} catch (err) {
		console.error("[draft-api] Failed to delete draft:", err);
	}
}
