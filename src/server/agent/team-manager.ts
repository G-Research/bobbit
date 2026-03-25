import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionManager, SessionInfo } from "./session-manager.js";
import type { GoalManager } from "./goal-manager.js";
import { createWorktree, cleanupWorktree } from "../skills/git.js";
import type { RoleStore } from "./role-store.js";
import { TeamStore } from "./team-store.js";
import type { PersistedTeamEntry } from "./team-store.js";
import { generateTeamName } from "./team-names.js";
import { TOOLS_DIR } from "./tool-manager.js";
import type { ColorStore } from "./color-store.js";
import type { GateStore } from "./gate-store.js";
import type { PersonalityManager } from "./personality-manager.js";


export class GateDependencyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GateDependencyError";
	}
}

/**
 * Format elapsed time since a timestamp as a human-readable string.
 * Exported for testing.
 */
export function formatElapsed(sinceMs: number): string {
	const mins = Math.floor((Date.now() - sinceMs) / 60_000);
	if (mins < 60) return `${mins}m`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return `${h}h ${m}m`;
}

/** Resolve the absolute path to the team-lead extension (raw .ts, loaded by jiti). */
const TEAM_LEAD_EXTENSION_PATH = path.join(TOOLS_DIR, "team", "extension.ts");
import type { TaskManager } from "./task-manager.js";


export interface TeamAgent {
	sessionId: string;
	role: string;
	worktreePath?: string;
	branch?: string;
	task: string;
	createdAt: number;
	/** Unsubscribe from the agent_end event listener (cleanup on dismiss). */
	unsubscribeEvent?: () => void;
}

export interface TeamAgentInfo {
	sessionId: string;
	role: string;
	status: string;
	worktreePath?: string;
	branch?: string;
	task: string;
	createdAt: number;
}

export interface TeamState {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: TeamAgentInfo[];
	maxConcurrent: number;
}

/** Internal tracking for a team associated with a goal. */
interface TeamEntry {
	goalId: string;
	teamLeadSessionId: string | null;
	agents: TeamAgent[];
	maxConcurrent: number;
	/** Unsubscribe from team lead RPC events (runtime-only, not persisted). */
	unsubscribeTeamLeadEvents?: () => void;
}



/**
 * Manages team goal lifecycles — team lead sessions and role agent sessions
 * with isolated git worktrees.
 */
export interface TeamManagerConfig {
	/** Color store for assigning unique palette indices to team sessions */
	colorStore: ColorStore;
	/** Task manager for looking up tasks assigned to sessions */
	taskManager: TaskManager;
	/** Role store for looking up role definitions (prompts, accessories, tools) */
	roleStore?: RoleStore;
	/** Gate store for checking gate status on completion and building dependency context */
	gateStore?: GateStore;
	/** Personality manager for resolving personality names to prompt fragments */
	personalityManager?: PersonalityManager;
	/** Broadcast a WS event to all clients viewing a goal */
	broadcastToGoal?: (goalId: string, event: any) => void;
}

export class TeamManager {
	private sessionManager: SessionManager;
	private config: TeamManagerConfig;
	private taskManager: TaskManager;
	private teams = new Map<string, TeamEntry>();
	private store: TeamStore;
	/** Timers for the idle-nudge mechanism (goalId → timer). */
	private idleNudgeTimers = new Map<string, ReturnType<typeof setInterval>>();
	/** Delay before nudging the idle team lead (ms). */
	private static readonly IDLE_NUDGE_DELAY_MS = 600_000;

	/** Reverse lookup: sessionId → goalId for quick dismissal. */
	private sessionToGoal = new Map<string, string>();

	constructor(sessionManager: SessionManager, config: TeamManagerConfig) {
		this.sessionManager = sessionManager;
		this.config = config;
		this.taskManager = config.taskManager;
		this.store = new TeamStore();
		this.restoreTeams();
	}

	/** Set the broadcastToGoal function (called after WebSocket server is created). */
	setBroadcastToGoal(fn: (goalId: string, event: any) => void): void {
		this.config.broadcastToGoal = fn;
	}

	/** Pick a palette index (0-19) not already used by any session, with randomisation. */
	private assignUniqueColor(sessionId: string): void {
		const PALETTE_SIZE = 20;
		const used = new Set<number>();
		for (const [, idx] of Object.entries(this.config.colorStore.getAll())) {
			used.add(idx);
		}
		// Collect available indices and pick one at random
		const available: number[] = [];
		for (let i = 0; i < PALETTE_SIZE; i++) {
			if (!used.has(i)) available.push(i);
		}
		const idx = available.length > 0
			? available[Math.floor(Math.random() * available.length)]
			: Math.floor(Math.random() * PALETTE_SIZE);
		this.config.colorStore.set(sessionId, idx);
	}

	/**
	 * Convert an in-memory TeamEntry to a PersistedTeamEntry for storage.
	 */
	private toPersistedEntry(entry: TeamEntry): PersistedTeamEntry {
		return {
			goalId: entry.goalId,
			teamLeadSessionId: entry.teamLeadSessionId,
			agents: entry.agents.map((a) => ({
				sessionId: a.sessionId,
				role: a.role,
				worktreePath: a.worktreePath,
				branch: a.branch,
				task: a.task,
				createdAt: a.createdAt,
			})),
			maxConcurrent: entry.maxConcurrent,
		};
	}

	/**
	 * Persist the current state of a team entry to disk.
	 */
	private persistEntry(goalId: string): void {
		const entry = this.teams.get(goalId);
		if (entry) {
			this.store.put(this.toPersistedEntry(entry));
		}
	}

	/**
	 * Restore teams from disk persistence.
	 * Reconstructs the in-memory Maps from the persisted store.
	 */
	/**
	 * Phase 1: Restore team data structures and reverse lookups from disk.
	 * Called from the constructor (before sessions are restored).
	 * Event subscriptions are deferred to resubscribeTeamEvents().
	 */
	private restoreTeams(): void {
		const persisted = this.store.getAll();
		for (const p of persisted) {
			const entry: TeamEntry = {
				goalId: p.goalId,
				teamLeadSessionId: p.teamLeadSessionId,
				agents: p.agents.map((a) => ({
					sessionId: a.sessionId,
					role: a.role,
					worktreePath: a.worktreePath,
					branch: a.branch,
					task: a.task,
					createdAt: a.createdAt,
				})),
				maxConcurrent: p.maxConcurrent,
			};
			this.teams.set(p.goalId, entry);

			// Rebuild reverse lookup
			if (p.teamLeadSessionId) {
				this.sessionToGoal.set(p.teamLeadSessionId, p.goalId);
			}
			for (const agent of entry.agents) {
				this.sessionToGoal.set(agent.sessionId, p.goalId);
			}

			console.log(
				`[team-manager] Restored team for goal ${p.goalId} — team lead: ${p.teamLeadSessionId}, agents: ${entry.agents.length}`,
			);
		}
	}

	/**
	 * Phase 2: Re-subscribe to team lead and worker agent events.
	 * Must be called AFTER sessions have been restored (restoreSessions()),
	 * because it needs live session objects to attach event listeners.
	 */
	resubscribeTeamEvents(): void {
		for (const [goalId, entry] of this.teams) {
			// Re-subscribe to team lead events and restart idle timer if needed
			if (entry.teamLeadSessionId) {
				const tlSession = this.sessionManager.getSession(entry.teamLeadSessionId);
				if (tlSession && tlSession.status !== "terminated") {
					this.subscribeTeamLeadEvents(goalId);
					if (tlSession.status === "idle" && entry.agents.length > 0) {
						this.startIdleNudgeTimer(goalId);
					}
				}
			}

			// Re-subscribe to worker agent events so the team lead is notified
			// when workers go idle (these subscriptions are lost on restart)
			for (const agent of entry.agents) {
				const workerSession = this.sessionManager.getSession(agent.sessionId);
				if (!workerSession || workerSession.status === "terminated") continue;
				const { role, sessionId } = agent;
				const agentId = `${role}-${sessionId.slice(0, 8)}`;
				const unsubscribe = workerSession.rpcClient.onEvent((event: any) => {
					if (event.type !== "agent_end") return;
					this.notifyTeamLead(goalId, sessionId, role, agentId).catch((err) => {
						console.error("[team-manager] Failed to notify team lead:", err);
					});
				});
				agent.unsubscribeEvent = unsubscribe;
			}
		}
		console.log(`[team-manager] Re-subscribed to events for ${this.teams.size} team(s)`);
	}

	/**
	 * Clear and remove the idle-nudge timer for a goal.
	 */
	private clearIdleNudgeTimer(goalId: string): void {
		const timer = this.idleNudgeTimers.get(goalId);
		if (timer) {
			clearInterval(timer);
			this.idleNudgeTimers.delete(goalId);
		}
	}

	/**
	 * Format elapsed time since a timestamp.
	 */
	private formatElapsed(sinceMs: number): string {
		return formatElapsed(sinceMs);
	}

	/**
	 * Start a repeating idle-nudge timer that checks in on team progress.
	 * Fires every IDLE_NUDGE_DELAY_MS while the team lead is idle and workers are active.
	 */
	private startIdleNudgeTimer(goalId: string): void {
		// Prevent duplicate timers
		this.clearIdleNudgeTimer(goalId);

		const timer = setInterval(() => {
			const entry = this.teams.get(goalId);
			if (!entry?.teamLeadSessionId) return;

			const teamLeadSession = this.sessionManager.getSession(entry.teamLeadSessionId);
			if (!teamLeadSession || teamLeadSession.status !== "idle") {
				return; // Skip this tick — team lead busy or gone
			}

			// Collect active workers
			const activeWorkers = entry.agents.filter((a) => {
				const s = this.sessionManager.getSession(a.sessionId);
				return s && s.status !== "terminated";
			});

			if (activeWorkers.length === 0) {
				this.clearIdleNudgeTimer(goalId);
				return;
			}

			// Build status lines
			const lines = activeWorkers.map((agent) => {
				const s = this.sessionManager.getSession(agent.sessionId);
				const status = s?.status ?? "unknown";
				const tasks = this.taskManager.getTasksForSession(agent.sessionId);
				const taskInfo = tasks.length > 0
					? `task "${tasks[0].title}" (${tasks[0].state})`
					: "no assigned task";
				const elapsed = this.formatElapsed(agent.createdAt);
				const shortId = agent.sessionId.slice(0, 4);
				return `- Agent ${agent.role}-${shortId} (${agent.role}): ${status}, ${taskInfo}, running ${elapsed}`;
			});

			const message =
				`[AUTO-NUDGE] Team check-in — your agents' current status:\n${lines.join("\n")}\n\n` +
				`Review their progress. If an agent appears stuck or going in the wrong direction, steer them back on track. ` +
				`If an agent is idle and their work looks complete, mark their task as done and dismiss them. ` +
				`If idle agents have more to do, prompt them to continue.`;

			this.sessionManager.enqueuePrompt(entry.teamLeadSessionId, message, { isSteered: true });
			console.log(`[team-manager] Sent idle nudge to team lead for goal ${goalId}`);
		}, TeamManager.IDLE_NUDGE_DELAY_MS);

		this.idleNudgeTimers.set(goalId, timer);
	}

	/**
	 * Subscribe to the team lead session's RPC events to manage the idle-nudge timer.
	 * On agent_end (idle): start the timer. On agent_start (streaming): clear it.
	 */
	private subscribeTeamLeadEvents(goalId: string): void {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return;

		const session = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!session) return;

		// Clean up any previous subscription
		entry.unsubscribeTeamLeadEvents?.();

		const unsubscribe = session.rpcClient.onEvent((event: any) => {
			if (event.type === "agent_end") {
				this.startIdleNudgeTimer(goalId);
			} else if (event.type === "agent_start") {
				this.clearIdleNudgeTimer(goalId);
			}
		});

		entry.unsubscribeTeamLeadEvents = unsubscribe;
	}

	private get goalManager(): GoalManager {
		return this.sessionManager.goalManager;
	}

	/**
	 * Start a team for the given goal.
	 * Creates a Team Lead session and returns it.
	 */
	async startTeam(goalId: string): Promise<SessionInfo> {
		const goal = this.goalManager.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}
		if (!goal.team) {
			throw new Error(`Goal "${goal.title}" does not have team mode enabled`);
		}
		if (this.teams.has(goalId)) {
			throw new Error(`Team already active for goal: ${goalId}`);
		}

		// Use the goal's worktree/cwd for the team lead
		const cwd = goal.worktreePath || goal.cwd;

		// Build the Team Lead role prompt with structural placeholders only
		// Secrets (gateway URL, auth token, goal ID) are passed as env vars, NOT embedded in prompt text
		const roleStore = this.config.roleStore;
		const storedRole = roleStore?.get("team-lead");
		if (!storedRole) {
			throw new Error('Role "team-lead" not found. Ensure roles/team-lead.yaml exists.');
		}
		const teamLeadPromptTemplate = storedRole.promptTemplate;
		const teamLeadPrompt = teamLeadPromptTemplate
			.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch || "main")
			.replace(/\{\{AGENT_ID\}\}/g, `team-lead-${goalId.slice(0, 8)}`);

		// Create the team lead session with the team tools extension.
		// The extension registers first-class tools (team_spawn, task_create, etc.) in the agent.
		const session = await this.sessionManager.createSession(
			cwd,
			["--extension", TEAM_LEAD_EXTENSION_PATH],
			goalId,
			undefined,
			{
				rolePrompt: teamLeadPrompt,
				env: { BOBBIT_GOAL_ID: goalId },
			},
		);

		// Assign a unique color and title
		this.assignUniqueColor(session.id);
		const teamLeadName = await generateTeamName("team-lead");
		this.sessionManager.setTitle(session.id, `Team Lead: ${teamLeadName}`);
		session.titleGenerated = true;
		const teamLeadAccessory = storedRole?.accessory ?? "crown";
		this.sessionManager.updateSessionMeta(session.id, {
			role: "team-lead",
			teamGoalId: goalId,
			worktreePath: goal.worktreePath,
			accessory: teamLeadAccessory,
		});

		// Initialize team tracking
		const entry: TeamEntry = {
			goalId,
			teamLeadSessionId: session.id,
			agents: [],
			maxConcurrent: 12,
		};
		this.teams.set(goalId, entry);
		this.sessionToGoal.set(session.id, goalId);
		this.persistEntry(goalId);

		// Subscribe to team lead lifecycle events for idle-nudge timer
		this.subscribeTeamLeadEvents(goalId);

		// Transition goal to in-progress if needed
		if (goal.state === "todo") {
			await this.goalManager.updateGoal(goalId, { state: "in-progress" });
		}

		// Kick off the team lead with an initial prompt (same pattern as delegate sessions)
		session.rpcClient.prompt("Execute the task described in your system prompt. Follow the instructions carefully.").catch((err: any) => {
			console.error("[team-manager] Failed to send team lead kickoff prompt:", err);
		});

		console.log(`[team-manager] Started team for goal "${goal.title}" — team lead: ${session.id}`);
		return session;
	}

	/**
	 * Spawn a role agent for a team goal.
	 * Creates an isolated git worktree and a session with the role's system prompt.
	 * Sends the task as the first prompt.
	 */
	/**
	 * Build context from passed upstream dependency gates.
	 *
	 * If `explicitInputIds` is provided, those workflow gate IDs are used directly.
	 * Otherwise, auto-resolves from the DAG's `dependsOn` for `workflowGateId`.
	 */
	buildDependencyContext(goalId: string, workflowGateId?: string, explicitInputIds?: string[]): string {
		const goal = this.goalManager.getGoal(goalId);
		if (!goal?.workflow || !this.config.gateStore) return "";

		// Determine which gate IDs to inject content from
		let inputIds: string[];
		if (explicitInputIds && explicitInputIds.length > 0) {
			inputIds = explicitInputIds;
		} else if (workflowGateId) {
			const wfGate = goal.workflow.gates.find(g => g.id === workflowGateId);
			if (!wfGate || !wfGate.dependsOn?.length) return "";
			inputIds = wfGate.dependsOn;
		} else {
			return "";
		}

		const gateStates = this.config.gateStore.getGatesForGoal(goalId);
		const parts: string[] = [];

		for (const depId of inputIds) {
			const gateDef = goal.workflow.gates.find(g => g.id === depId);
			const gateState = gateStates.find(g => g.gateId === depId);
			if (gateDef && gateState && gateState.status === "passed" && gateDef.injectDownstream && gateState.currentContent) {
				parts.push(`## Gate: ${gateDef.name} (passed)\n\n${gateState.currentContent}`);
			}
		}

		if (parts.length === 0 && inputIds.length > 0) {
			const injectableCount = inputIds.filter(depId => {
				const gateDef = goal.workflow!.gates.find(g => g.id === depId);
				return gateDef?.injectDownstream;
			}).length;
			if (injectableCount > 0) {
				console.warn(
					`[team-manager] buildDependencyContext: workflowGateId="${workflowGateId}" has ${injectableCount} ` +
					`injectable upstream gate(s) but none produced content. Gates checked: ${inputIds.join(", ")}`
				);
			}
		}

		if (parts.length === 0) return "";
		return "\n\n# Upstream Gates\n\nContent from passed upstream gates:\n\n" + parts.join("\n\n---\n\n");
	}

	/**
	 * Try to extract a workflowGateId from the task description.
	 * Looks for a pattern like `[gate:some-id]` in the task text.
	 */
	private extractWorkflowGateId(task: string, goalId: string): string | undefined {
		// Check for explicit tag
		const tagMatch = task.match(/\[gate:([^\]]+)\]/);
		if (tagMatch) return tagMatch[1];

		// Try to match against workflow gate names/IDs in the goal
		const goal = this.goalManager.getGoal(goalId);
		if (!goal?.workflow) return undefined;

		const taskLower = task.toLowerCase();
		for (const gate of goal.workflow.gates) {
			if (taskLower.includes(gate.name.toLowerCase()) || task.includes(gate.id)) {
				return gate.id;
			}
		}
		return undefined;
	}

	async spawnRole(
		goalId: string,
		role: string,
		task: string,
		opts?: { personalities?: string[]; workflowGateId?: string; inputGateIds?: string[] },
	): Promise<{ sessionId: string; worktreePath?: string }> {
		const roleStore = this.config.roleStore;
		const storedRoleDef = roleStore?.get(role);
		if (!storedRoleDef) {
			const available = roleStore?.getAll().map(r => r.name).join(", ") ?? "none";
			throw new Error(`Role "${role}" not found. Available roles: ${available}`);
		}

		if (role === 'team-lead') {
			throw new Error('Cannot spawn team-lead role via spawnRole — use startTeam() instead');
		}

		const entry = this.teams.get(goalId);
		if (!entry) {
			throw new Error(`No active team for goal: ${goalId}`);
		}

		// Check concurrency limit
		if (entry.agents.length >= entry.maxConcurrent) {
			throw new Error(
				`Team for goal ${goalId} already has ${entry.agents.length} agents (max: ${entry.maxConcurrent})`,
			);
		}

		const goal = this.goalManager.getGoal(goalId);
		if (!goal) {
			throw new Error(`Goal not found: ${goalId}`);
		}

		// repoPath is only set when the goal's cwd is inside a git repo.
		// If absent, skip worktree creation and use the goal's cwd directly.
		const useWorktree = !!goal.repoPath;

		// Enforce gate dependency check: upstream gates must be passed before spawning for a gate
		const resolvedWorkflowGateId = opts?.workflowGateId ?? this.extractWorkflowGateId(task, goalId);
		if (resolvedWorkflowGateId && this.config.gateStore && goal.workflow) {
			const wfGate = goal.workflow.gates.find(g => g.id === resolvedWorkflowGateId);
			if (wfGate?.dependsOn?.length) {
				const gateStates = this.config.gateStore.getGatesForGoal(goalId);
				const passedIds = new Set(gateStates.filter(g => g.status === "passed").map(g => g.gateId));
				const notPassed = wfGate.dependsOn.filter(depId => !passedIds.has(depId));
				if (notPassed.length > 0) {
					const names = notPassed.map(id => {
						const def = goal.workflow!.gates.find(g => g.id === id);
						return def ? `${def.name} (${id})` : id;
					});
					throw new GateDependencyError(
						`Upstream gate(s) not passed: ${names.join(", ")}. Cannot spawn agent for gate "${resolvedWorkflowGateId}" until dependencies are met.`
					);
				}
			}
		}

		// Create a worktree for this role agent (only when the goal is in a git repo)
		const shortId = randomUUID().slice(0, 8);
		let worktreeResult: { worktreePath: string; branchName: string } | undefined;
		let branchName: string | undefined;
		let agentCwd: string;

		if (useWorktree) {
			const goalSlug = (goal.branch || goalId.slice(0, 8)).replace(/\//g, '-');
			branchName = `goal-${goalSlug}-${role}-${shortId}`;
			worktreeResult = await createWorktree(goal.repoPath!, branchName);
			agentCwd = worktreeResult.worktreePath;
		} else {
			agentCwd = goal.cwd;
		}

		try {
			const agentId = `${role}-${shortId}`;
			const rolePromptTemplate = storedRoleDef.promptTemplate;
			const rolePrompt = rolePromptTemplate
				.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch || "main")
				.replace(/\{\{AGENT_ID\}\}/g, agentId);

			// Read allowed tools from role definition
			const allowedTools = storedRoleDef.allowedTools;

			// Resolve personalities: explicit > role defaults
			const personalityNames = opts?.personalities ?? storedRoleDef.defaultPersonalities;
			let resolvedPersonalities: Array<{ label: string; promptFragment: string }> | undefined;
			if (personalityNames && personalityNames.length > 0 && this.config.personalityManager) {
				resolvedPersonalities = this.config.personalityManager.resolvePersonalities(personalityNames);
			}

			// Build workflow dependency context for the system prompt
			let workflowContext: string | undefined;
			const wfGateId = opts?.workflowGateId ?? this.extractWorkflowGateId(task, goalId);
			const explicitInputs = opts?.inputGateIds;
			if (explicitInputs?.length || wfGateId) {
				const ctx = this.buildDependencyContext(goalId, wfGateId, explicitInputs);
				if (ctx) workflowContext = ctx;
			}

			// Create the session with the role agent's cwd
			const session = await this.sessionManager.createSession(
				agentCwd,
				undefined,
				goalId,
				undefined,
				{ rolePrompt, allowedTools, personalities: resolvedPersonalities, personalityNames, workflowContext },
			);

			// Assign a unique color and title
			this.assignUniqueColor(session.id);
			const roleName = await generateTeamName(role);
			const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
			this.sessionManager.setTitle(session.id, `${roleLabel}: ${roleName}`);
			session.titleGenerated = true;
			const roleAccessory = storedRoleDef.accessory;
			this.sessionManager.updateSessionMeta(session.id, {
				role,
				teamGoalId: goalId,
				worktreePath: worktreeResult?.worktreePath,
				accessory: roleAccessory,
			});

			// Track the agent
			const agent: TeamAgent = {
				sessionId: session.id,
				role,
				worktreePath: worktreeResult?.worktreePath,
				branch: branchName,
				task,
				createdAt: Date.now(),
			};
			entry.agents.push(agent);
			this.sessionToGoal.set(session.id, goalId);
			this.persistEntry(goalId);

			// Enrich task prompt with upstream dependency context if available
			const enrichedTask = workflowContext ? task + workflowContext : task;

			// Send the task as the first prompt
			session.rpcClient.prompt(enrichedTask).catch((err: any) => {
				console.error('[team-manager] Failed to send task prompt:', err);
			});

			// Subscribe to worker events to steer the team lead when the worker goes idle
			const unsubscribe = session.rpcClient.onEvent((event: any) => {
				if (event.type !== "agent_end") return;
				// Broadcast team agent finished event
				this.config.broadcastToGoal?.(goalId, {
					type: "team_agent_finished", goalId, sessionId: session.id, role, name: roleName,
				});
				this.notifyTeamLead(goalId, session.id, role, agentId).catch((err) => {
					console.error("[team-manager] Failed to notify team lead:", err);
				});
			});
			agent.unsubscribeEvent = unsubscribe;

			console.log(
				`[team-manager] Spawned ${role} agent (${session.id}) for goal "${goal.title}" — cwd: ${agentCwd}`,
			);

			// Broadcast team agent spawned event
			this.config.broadcastToGoal?.(goalId, {
				type: "team_agent_spawned", goalId, sessionId: session.id, role, name: roleName,
			});

			return { sessionId: session.id, worktreePath: worktreeResult?.worktreePath };
		} catch (err) {
			// Clean up the orphaned worktree on failure (only if one was created)
			if (worktreeResult && goal.repoPath) {
				try {
					await cleanupWorktree(goal.repoPath, worktreeResult.worktreePath, branchName, true);
					console.log(`[team-manager] Cleaned up orphaned worktree after spawnRole failure: ${worktreeResult.worktreePath}`);
				} catch (cleanupErr) {
					console.error(`[team-manager] Failed to clean up orphaned worktree ${worktreeResult.worktreePath}:`, cleanupErr);
				}
			}
			throw err;
		}
	}

	/**
	 * Notify the team lead that a worker agent has gone idle.
	 * Sends a steer message with task context so the team lead can decide next steps.
	 */
	private async notifyTeamLead(goalId: string, workerSessionId: string, role: string, agentId: string): Promise<void> {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return;

		const teamLeadSession = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;

		// Look up tasks assigned to the worker
		const tasks = this.taskManager.getTasksForSession(workerSessionId);

		let message: string;
		if (tasks.length > 0) {
			const taskSummaries = tasks.map(t => {
				let s = `"${t.title}" (state: ${t.state})`;
				if (t.resultSummary) s += ` — ${t.resultSummary}`;
				return s;
			}).join("; ");
			message = `Agent ${agentId} (${role}) has finished. Tasks: ${taskSummaries}. Check task details and gate content (gate_status) for full results.`;
		} else {
			message = `Agent ${agentId} (${role}) has finished with no assigned tasks. Check tasks and decide next steps.`;
		}

		try {
			if (teamLeadSession.status === "streaming") {
				// Mid-turn: inject directly as a real-time steer interrupt
				await teamLeadSession.rpcClient.steer(message);
			} else {
				// Idle: enqueue as a steered prompt so it drains immediately
				this.sessionManager.enqueuePrompt(entry.teamLeadSessionId, message, { isSteered: true });
			}
			console.log(`[team-manager] Notified team lead for goal ${goalId} (status=${teamLeadSession.status}): ${message}`);
		} catch (err) {
			console.error(`[team-manager] Failed to notify team lead for goal ${goalId}:`, err);
		}
	}

	/**
	 * Notify the team lead when a task transitions to a terminal state.
	 * Called from the task transition REST endpoint so the team lead wakes up
	 * even if the worker continues with another task without going idle.
	 */
	notifyTeamLeadOfTaskCompletion(goalId: string, taskTitle: string, taskState: string): void {
		const entry = this.teams.get(goalId);
		if (!entry?.teamLeadSessionId) return;

		const teamLeadSession = this.sessionManager.getSession(entry.teamLeadSessionId);
		if (!teamLeadSession || teamLeadSession.status === "terminated") return;

		const message = `Task "${taskTitle}" transitioned to ${taskState}. Use task_list for result summaries and gate_status to read any gate content the agent produced.`;

		if (teamLeadSession.status === "streaming") {
			teamLeadSession.rpcClient.steer(message).catch((err: any) => {
				console.error(`[team-manager] Failed to steer team lead on task completion for goal ${goalId}:`, err);
			});
		} else {
			this.sessionManager.enqueuePrompt(entry.teamLeadSessionId, message, { isSteered: true });
		}
		console.log(`[team-manager] Notified team lead of task completion for goal ${goalId}: ${taskTitle} → ${taskState}`);
	}

	/**
	 * Dismiss (terminate) a role agent session and clean up its worktree.
	 */
	async dismissRole(sessionId: string): Promise<boolean> {
		const goalId = this.sessionToGoal.get(sessionId);
		if (!goalId) {
			return false;
		}

		const entry = this.teams.get(goalId);
		if (!entry) {
			return false;
		}

		// Don't allow dismissing the team lead via this method
		if (entry.teamLeadSessionId === sessionId) {
			throw new Error("Cannot dismiss the team lead — use completeTeam() instead");
		}

		const agentIndex = entry.agents.findIndex((a) => a.sessionId === sessionId);
		if (agentIndex === -1) {
			return false;
		}

		const agent = entry.agents[agentIndex];

		// Unsubscribe from agent_end events before terminating
		if (agent.unsubscribeEvent) {
			agent.unsubscribeEvent();
		}

		// Persist repoPath and branch before archiving so worktree can be cleaned up later
		const goal = this.goalManager.getGoal(goalId);
		if (goal?.repoPath && agent.worktreePath) {
			this.sessionManager.updateSessionMeta(sessionId, {
				worktreePath: agent.worktreePath,
			});
			// Store repoPath and branch in the session store for later purge cleanup
			const store = (this.sessionManager as any).store;
			if (store) {
				store.update(sessionId, { repoPath: goal.repoPath, branch: agent.branch });
			}
		}

		// Terminate the session
		await this.sessionManager.terminateSession(sessionId);

		// Worktree is preserved for archived session review — cleanup happens at purge time

		// Remove from tracking
		entry.agents.splice(agentIndex, 1);
		this.sessionToGoal.delete(sessionId);
		this.persistEntry(goalId);

		// If no workers remain, clear the idle-nudge timer
		if (entry.agents.length === 0) {
			this.clearIdleNudgeTimer(goalId);
		}

		console.log(`[team-manager] Dismissed ${agent.role} agent (${sessionId}) for goal ${goalId}`);

		// Broadcast team agent dismissed event
		const sessionMeta = this.sessionManager.getSession(sessionId);
		const dismissedName = sessionMeta?.title || `${agent.role}-${sessionId.slice(0, 8)}`;
		this.config.broadcastToGoal?.(goalId, {
			type: "team_agent_dismissed", goalId, sessionId, role: agent.role, name: dismissedName,
		});

		return true;
	}

	/**
	 * Register a verification reviewer session as a team agent without creating a worktree.
	 * The verification harness manages the session lifecycle — no agent_end subscription is needed.
	 * Silently returns if no team exists for the goal (handles manual gate signals).
	 */
	registerReviewerSession(goalId: string, sessionId: string, stepName: string): void {
		const entry = this.teams.get(goalId);
		if (!entry) return; // No active team — skip registration silently

		const agent: TeamAgent = {
			sessionId,
			role: 'reviewer',
			worktreePath: undefined,
			branch: undefined,
			task: `Verification review: ${stepName}`,
			createdAt: Date.now(),
		};
		entry.agents.push(agent);
		this.sessionToGoal.set(sessionId, goalId);
		this.assignUniqueColor(sessionId);
		this.persistEntry(goalId);
	}

	/**
	 * Unregister a verification reviewer session from the team.
	 * Called after the session is terminated so archiving happens first.
	 */
	unregisterReviewerSession(goalId: string, sessionId: string): void {
		const entry = this.teams.get(goalId);
		if (!entry) return;

		const idx = entry.agents.findIndex(a => a.sessionId === sessionId);
		if (idx !== -1) {
			const agent = entry.agents[idx];
			if (agent.unsubscribeEvent) agent.unsubscribeEvent();
			entry.agents.splice(idx, 1);
		}
		this.sessionToGoal.delete(sessionId);
		this.persistEntry(goalId);
	}

	/**
	 * List all active agents for a goal.
	 */
	listAgents(goalId: string): TeamAgentInfo[] {
		const entry = this.teams.get(goalId);
		if (!entry) {
			return [];
		}

		return entry.agents.map((agent) => {
			const session = this.sessionManager.getSession(agent.sessionId);
			return {
				sessionId: agent.sessionId,
				role: agent.role,
				status: session?.status ?? "terminated",
				worktreePath: agent.worktreePath,
				branch: agent.branch,
				task: agent.task,
				createdAt: agent.createdAt,
			};
		});
	}

	/**
	 * Complete a team: dismiss all role agents but keep the team lead alive.
	 * The team lead remains active to present a report and await further instructions.
	 */
	async completeTeam(goalId: string): Promise<void> {
		const entry = this.teams.get(goalId);
		if (!entry) {
			throw new Error(`No active team for goal: ${goalId}`);
		}

		// Enforce gate requirements before allowing completion
		if (this.config.gateStore) {
			const goal = this.goalManager.getGoal(goalId);
			const skipReqs = goal?.skipGateRequirements;

			if (goal?.workflow && (!skipReqs || !skipReqs.includes("workflow"))) {
				const gateStates = this.config.gateStore.getGatesForGoal(goalId);
				const passedIds = new Set(gateStates.filter(g => g.status === "passed").map(g => g.gateId));
				const failedGates = goal.workflow.gates.filter(g => !passedIds.has(g.id));
				if (failedGates.length > 0) {
					throw new Error(`Cannot complete: gates not passed: ${failedGates.map(g => g.name).join(", ")}`);
				}
			}
		}

		// Cancel idle-nudge timer and unsubscribe from team lead events
		this.clearIdleNudgeTimer(goalId);
		entry.unsubscribeTeamLeadEvents?.();

		// Dismiss all role agents
		const agentSessionIds = entry.agents.map((a) => a.sessionId);
		for (const sessionId of agentSessionIds) {
			try {
				await this.dismissRole(sessionId);
			} catch (err) {
				console.error(`[team-manager] Error dismissing agent ${sessionId} during team completion:`, err);
			}
		}

		// Keep the team lead session alive — do NOT terminate it.
		// The team lead will present a report and await further instructions.

		// Update goal state
		await this.goalManager.updateGoal(goalId, { state: "complete" });

		// Keep team tracking alive so the team lead can still be found
		// but persist the updated state (agents cleared)
		this.persistEntry(goalId);

		console.log(`[team-manager] Completed team for goal ${goalId} — team lead remains active: ${entry.teamLeadSessionId}`);
	}

	/**
	 * Fully tear down a team: dismiss all agents AND terminate the team lead.
	 * Use this when explicitly shutting down everything.
	 */
	async teardownTeam(goalId: string): Promise<void> {
		const entry = this.teams.get(goalId);
		if (!entry) {
			throw new Error(`No active team for goal: ${goalId}`);
		}

		// Cancel idle-nudge timer and unsubscribe from team lead events
		this.clearIdleNudgeTimer(goalId);
		entry.unsubscribeTeamLeadEvents?.();

		// Dismiss all role agents
		const agentSessionIds = entry.agents.map((a) => a.sessionId);
		for (const sessionId of agentSessionIds) {
			try {
				await this.dismissRole(sessionId);
			} catch (err) {
				console.error(`[team-manager] Error dismissing agent ${sessionId} during team teardown:`, err);
			}
		}

		// Terminate the team lead session — persist worktree info first so purge can clean up
		if (entry.teamLeadSessionId) {
			const goal = this.goalManager.getGoal(goalId);
			if (goal?.repoPath) {
				const store = (this.sessionManager as any).store;
				if (store) {
					store.update(entry.teamLeadSessionId, {
						repoPath: goal.repoPath,
						branch: goal.branch,
						worktreePath: goal.worktreePath,
					});
				}
			}
			try {
				await this.sessionManager.terminateSession(entry.teamLeadSessionId);
			} catch (err) {
				console.error(`[team-manager] Error terminating team lead ${entry.teamLeadSessionId}:`, err);
			}
			this.sessionToGoal.delete(entry.teamLeadSessionId);
		}

		// Remove team tracking entirely
		this.teams.delete(goalId);
		this.store.remove(goalId);

		console.log(`[team-manager] Tore down team for goal ${goalId}`);
	}

	/**
	 * Get the full team state for a goal.
	 */
	getTeamState(goalId: string): TeamState | undefined {
		const entry = this.teams.get(goalId);
		if (!entry) {
			return undefined;
		}

		return {
			goalId: entry.goalId,
			teamLeadSessionId: entry.teamLeadSessionId,
			agents: this.listAgents(goalId),
			maxConcurrent: entry.maxConcurrent,
		};
	}
}
