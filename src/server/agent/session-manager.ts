import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import type { ServerMessage, QueuedMessage } from "../ws/protocol.js";
import { EventBuffer } from "./event-buffer.js";
import { GoalManager } from "./goal-manager.js";
import { TaskManager } from "./task-manager.js";
import { PromptQueue } from "./prompt-queue.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";
import { SessionStore, type PersistedSession } from "./session-store.js";
import { getAssistantDef } from "./assistant-registry.js";
import { assembleSystemPrompt, cleanupSessionPrompt, type PromptParts } from "./system-prompt.js";
import { generateSessionTitle, generateGoalSummaryTitle } from "./title-generator.js";
import { CostTracker } from "./cost-tracker.js";
import type { ColorStore } from "./color-store.js";
import type { PersonalityManager } from "./personality-manager.js";
import type { RoleManager } from "./role-manager.js";
import type { ToolManager } from "./tool-manager.js";
import { computeToolActivationArgs } from "./tool-activation.js";
import { TOOLS_DIR } from "./tool-manager.js";
import { getAigwUrl, getAigwModels, modelRecencyRank } from "./aigw-manager.js";
import { createWorktree } from "../skills/git.js";


/** Goal tools extension — task + gate management for any goal session. */
const GOAL_TOOLS_EXTENSION_PATH = path.join(TOOLS_DIR, "tasks", "extension.ts");

/** Team lead extension — team management tools. */
const TEAM_LEAD_EXTENSION_PATH = path.join(TOOLS_DIR, "team", "extension.ts");

export type SessionStatus = "starting" | "preparing" | "idle" | "streaming" | "terminated";

export interface SessionInfo {
	id: string;
	title: string;
	cwd: string;
	status: SessionStatus;
	createdAt: number;
	lastActivity: number;
	clients: Set<WebSocket>;
	rpcClient: RpcBridge;
	eventBuffer: EventBuffer;
	unsubscribe: () => void;
	isCompacting: boolean;
	titleGenerated: boolean;
	goalId?: string;
	/** Assistant type: "goal" | "role" | "tool" */
	assistantType?: string;
	/** Whether this session has a live HTML preview panel */
	preview?: boolean;
	/** If this is a delegate session, the parent session ID */
	delegateOf?: string;
	/** Role in a team goal (e.g., 'coder', 'reviewer', 'tester', 'team-lead') */
	role?: string;
	/** The team goal ID this agent belongs to */
	teamGoalId?: string;
	/** Session ID of the team lead that spawned this agent */
	teamLeadSessionId?: string;
	/** Path to the git worktree for this session */
	worktreePath?: string;
	/** Task ID this session is working on */
	taskId?: string;
	/** Staff agent ID this session belongs to */
	staffId?: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory?: string;
	/** Whether this is an automated non-interactive session (e.g. verification reviewer) */
	nonInteractive?: boolean;
	/** Personality names */
	personalities?: string[];
	/** Allowed tools for this session */
	allowedTools?: string[];
	/** Server-side prompt queue */
	promptQueue: PromptQueue;
	/** True if the last agent turn ended due to a model/API error */
	lastTurnErrored?: boolean;
	/** Whether tool calls were executed during the current/last turn */
	turnHadToolCalls?: boolean;
	/** Timestamp when the current streaming turn started */
	streamingStartedAt?: number;
	/** Last user prompt text, for retry on fresh-response errors */
	lastPromptText?: string;
	/** Last user prompt images, for retry on fresh-response errors */
	lastPromptImages?: Array<{ type: "image"; data: string; mimeType: string }>;
	/** Cached PromptParts for serving prompt-sections API */
	promptParts?: PromptParts;
}

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
	const data = JSON.stringify(msg);
	for (const client of clients) {
		if (client.readyState === 1) {
			client.send(data);
		}
	}
}

export interface SessionManagerOptions {
	/** Override the path to pi-coding-agent cli.js */
	agentCliPath?: string;
	/** Path to a custom system prompt file */
	systemPromptPath?: string;
	/** Color store for session color cleanup on terminate */
	colorStore?: ColorStore;
	/** Personality manager for resolving personality names to prompt fragments */
	personalityManager?: PersonalityManager;
	/** Role manager for looking up role definitions (needed by updatePersonalities) */
	roleManager?: RoleManager;
	/** Tool manager for generating tool documentation in system prompts */
	toolManager?: ToolManager;
	/** Workflow store for injecting into GoalManager */
	workflowStore?: import("./workflow-store.js").WorkflowStore;
	/** Preferences store for aigw auto-model detection */
	preferencesStore?: import("./preferences-store.js").PreferencesStore;
}

export class SessionManager {
	private sessions = new Map<string, SessionInfo>();
	private agentCliPath?: string;
	private systemPromptPath?: string;
	private store = new SessionStore();
	private costTracker = new CostTracker();
	private colorStore?: ColorStore;
	private personalityManager?: PersonalityManager;
	private roleManager?: RoleManager;
	private toolManager?: ToolManager;
	private preferencesStore?: import("./preferences-store.js").PreferencesStore;
	goalManager: GoalManager;
	taskManager: TaskManager;
	private purgeInterval: ReturnType<typeof setInterval> | null = null;

	constructor(options?: SessionManagerOptions) {
		this.agentCliPath = options?.agentCliPath;
		this.systemPromptPath = options?.systemPromptPath;
		this.colorStore = options?.colorStore;
		this.personalityManager = options?.personalityManager;
		this.roleManager = options?.roleManager;
		this.toolManager = options?.toolManager;
		this.preferencesStore = options?.preferencesStore;
		this.goalManager = new GoalManager(options?.workflowStore);
		this.taskManager = new TaskManager();
	}

	getCostTracker(): CostTracker {
		return this.costTracker;
	}

	/** Generate tool docs and inject into prompt parts before assembly. */
	private assemblePrompt(sessionId: string, parts: PromptParts): string | undefined {
		if (this.toolManager && !parts.toolDocs) {
			parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools);
		}
		// Cache parts for prompt-sections API
		const session = this.sessions.get(sessionId);
		if (session) session.promptParts = parts;
		return assembleSystemPrompt(sessionId, parts);
	}

	/** Get cached PromptParts for serving prompt-sections API.
	 *  If not cached (e.g. dormant session), rebuild from session metadata. */
	getPromptParts(sessionId: string): PromptParts | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) return undefined;
		if (session.promptParts) return session.promptParts;

		// Rebuild on demand for dormant / restored sessions missing cached parts
		const assistantDef = session.assistantType ? getAssistantDef(session.assistantType) : undefined;
		let parts: PromptParts;

		if (assistantDef) {
			const assistantRole = this.roleManager?.getRole("assistant");
			let assistantGoalSpec = "";
			if (assistantRole?.promptTemplate) {
				assistantGoalSpec = assistantRole.promptTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(session.goalId || session.id).slice(0, 8)}`);
				assistantGoalSpec += "\n\n---\n\n";
			}
			assistantGoalSpec += assistantDef.prompt;
			parts = {
				baseSystemPromptPath: undefined,
				cwd: session.cwd,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: session.allowedTools,
			};
		} else {
			const goal = session.goalId ? this.goalManager.getGoal(session.goalId) : undefined;
			const resolvedPersonalities = (session.personalities && session.personalities.length > 0 && this.personalityManager)
				? this.personalityManager.resolvePersonalities(session.personalities)
				: undefined;

			let rolePrompt: string | undefined;
			let roleName: string | undefined;
			let toolRestrictionsText: string | undefined;
			if (session.role && this.roleManager) {
				const role = this.roleManager.getRole(session.role);
				if (role?.promptTemplate) {
					rolePrompt = role.promptTemplate;
					if (goal?.branch) rolePrompt = rolePrompt.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch);
					rolePrompt = rolePrompt.replace(/\{\{AGENT_ID\}\}/g, `${session.role}-${(session.goalId || session.id).slice(0, 8)}`);
					roleName = session.role;
				}
				if (role && role.allowedTools.length > 0) {
					const toolList = role.allowedTools.join(", ");
					toolRestrictionsText = `## Tool Restrictions\n\nYou are ONLY allowed to use the following tools: ${toolList}\n\nDo NOT use any other tools. If a task requires a tool you don't have access to, explain what you need and ask for help instead of attempting to use the restricted tool.`;
				}
			}

			parts = {
				baseSystemPromptPath: this.systemPromptPath,
				cwd: session.cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec: goal?.spec,
				rolePrompt,
				roleName,
				toolRestrictions: toolRestrictionsText,
				personalities: resolvedPersonalities,
				allowedTools: session.allowedTools,
			};
		}

		// Cache for future calls
		session.promptParts = parts;
		return parts;
	}

	// ── Prompt queue helpers ──────────────────────────────────────────

	/** Broadcast queue state to all clients and persist. */
	broadcastQueueUpdate(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) this.broadcastQueue(session);
	}

	private broadcastQueue(session: SessionInfo): void {
		broadcast(session.clients, {
			type: "queue_update",
			sessionId: session.id,
			queue: session.promptQueue.toArray(),
		});
		this.store.update(session.id, { messageQueue: session.promptQueue.toArray() });
	}

	/**
	 * Enqueue a prompt (or follow_up). If the agent is idle and queue was empty,
	 * dispatch immediately. Otherwise add to queue and broadcast.
	 * If the agent is idle but queue has items, enqueue and drain.
	 */
	async enqueuePrompt(sessionId: string, text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isFollowUp?: boolean;
		isSteered?: boolean;
	}): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		// If agent is idle and queue is empty, dispatch directly
		if (session.status === "idle" && session.promptQueue.isEmpty) {
			this.tryGenerateTitleFromPrompt(sessionId, text);
			session.lastPromptText = text;
			session.lastPromptImages = opts?.images;
			if (opts?.isFollowUp) {
				await session.rpcClient.followUp(text);
			} else {
				await session.rpcClient.prompt(text, opts?.images);
			}
			return;
		}

		// Agent is busy or queue has items — enqueue
		session.promptQueue.enqueue(text, {
			images: opts?.images,
			attachments: opts?.attachments,
			isSteered: opts?.isSteered,
		});
		this.broadcastQueue(session);

		// If agent is idle, start draining the queue (bug fix: idle + non-empty queue)
		if (session.status === "idle") {
			this.drainQueue(session);
		}
	}

	/**
	 * Promote a queued message to steered and reorder.
	 * If the agent is streaming, immediately dequeue and dispatch the steered
	 * message via `steer` RPC so it interrupts between tool calls.
	 */
	steerQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.steer(messageId);
		if (!ok) return false;

		// If agent is streaming, dispatch the steered message immediately
		// so it gets picked up between tool calls via getSteeringMessages().
		// Keep the message in the queue (marked dispatched) so the UI shows
		// "Sent" until the turn ends and the message appears in chat.
		if (session.status === "streaming") {
			const front = session.promptQueue.peek();
			if (front?.isSteered && !front.dispatched) {
				session.promptQueue.markDispatched(front.id);
				session.rpcClient.steer(front.text).catch((err: any) => {
					console.error(`[session-manager] Failed to dispatch steered message for ${session.id}:`, err);
				});
			}
		}

		this.broadcastQueue(session);
		return true;
	}

	/** Remove a queued message. */
	removeQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.remove(messageId);
		if (ok) this.broadcastQueue(session);
		return ok;
	}

	/**
	 * Called when the agent becomes idle (agent_end) or when a new message is
	 * enqueued while idle. Dequeue and dispatch the next message if any exist.
	 *
	 * Always dispatches via `prompt` RPC (not `steer`) because the agent is
	 * idle at this point — `steer` is only meaningful mid-turn.
	 *
	 * Sets status to "streaming" optimistically to prevent a race where another
	 * enqueuePrompt call sees idle+empty and dispatches a second concurrent prompt.
	 */
	private drainQueue(session: SessionInfo): void {
		if (session.promptQueue.isEmpty) return;

		// Skip already-dispatched messages (steered mid-turn), then pop the next
		const next = session.promptQueue.dequeueUndispatched();
		this.broadcastQueue(session);
		if (!next) return;

		// Title generation for the first real prompt
		this.tryGenerateTitleFromPrompt(session.id, next.text);

		// Track for retry
		session.lastPromptText = next.text;
		session.lastPromptImages = next.images;

		// Optimistic status update to prevent double-dispatch race
		session.status = "streaming";
		session.streamingStartedAt = session.streamingStartedAt ?? Date.now();
		this.store.update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
		broadcast(session.clients, { type: "session_status", status: "streaming", streamingStartedAt: session.streamingStartedAt });

		// Always dispatch as prompt — agent is idle, steer is only for mid-turn
		session.rpcClient.prompt(next.text, next.images).catch((err: any) => {
			console.error(`[session-manager] Failed to dispatch queued prompt for ${session.id}:`, err);
			// Revert optimistic status on failure
			session.status = "idle";
			broadcast(session.clients, { type: "session_status", status: "idle" });
		});
	}

	/**
	 * Handle agent events that track error state and control queue draining.
	 * Called from every event listener before broadcasting.
	 * - Tracks message_end with stopReason "error" so we can suppress queue draining.
	 * - On agent_end, skips drainQueue if the turn ended with an error.
	 */
	private handleAgentLifecycle(session: SessionInfo, event: any): void {
		// Track tool execution during this turn
		if (event.type === "tool_execution_start") {
			session.turnHadToolCalls = true;

			// Enforce allowedTools — warn when a disallowed tool is used (case-insensitive)
			if (session.allowedTools && session.allowedTools.length > 0 && event.toolName) {
				const toolLower = event.toolName.toLowerCase();
				if (!session.allowedTools.some((t: string) => t.toLowerCase() === toolLower)) {
					console.warn(
						`[session-manager] Session ${session.id} used disallowed tool "${event.toolName}". ` +
						`Allowed: [${session.allowedTools.join(", ")}]`
					);
				}
			}
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			session.lastTurnErrored = event.message.stopReason === "error";
		}

		// When a steered user message appears in chat, remove the dispatched pill
		if (event.type === "message_end" && event.message?.role === "user") {
			if (session.promptQueue.removeDispatched()) {
				this.broadcastQueue(session);
			}
		}

		if (event.type === "agent_start") {
			session.status = "streaming";
			session.lastTurnErrored = false;
			session.turnHadToolCalls = false;
			session.streamingStartedAt = Date.now();
			this.store.update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
			broadcast(session.clients, { type: "session_status", status: "streaming", streamingStartedAt: session.streamingStartedAt });
		} else if (event.type === "agent_end") {
			session.status = "idle";
			session.streamingStartedAt = undefined;
			this.store.update(session.id, { wasStreaming: false, streamingStartedAt: undefined });
			broadcast(session.clients, { type: "session_status", status: "idle" });
			// Don't drain the queue if the turn ended with a model error —
			// queued/steered messages should wait for a retry.
			if (!session.lastTurnErrored) {
				this.drainQueue(session);
			}
		} else if (event.type === "auto_compaction_start") {
			session.isCompacting = true;
		} else if (event.type === "auto_compaction_end") {
			session.isCompacting = false;
			if (!event.aborted) this.refreshAfterCompaction(session);
		}
	}

	/**
	 * Retry after a model/API error. Behaviour depends on context:
	 * - Fresh response error (no tool calls): re-sends the original user prompt
	 * - Mid-work error (tool calls already executed): sends a system continuation
	 */
	async retryLastPrompt(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		const hadToolCalls = session.turnHadToolCalls;
		session.lastTurnErrored = false;
		session.turnHadToolCalls = false;

		if (hadToolCalls) {
			// Agent was mid-work — send a system continuation prompt
			await session.rpcClient.prompt(
				"[SYSTEM: The model API returned an error while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			);
		} else if (session.lastPromptText) {
			// Fresh response error — re-send the original prompt
			await session.rpcClient.prompt(session.lastPromptText, session.lastPromptImages);
		} else {
			// Fallback (e.g. session predates error tracking) — use prompt, not followUp,
			// because followUp may not be accepted when the agent is idle.
			await session.rpcClient.prompt(
				"[SYSTEM: The model API returned an error on your last response. " +
				"Please review your conversation history and retry what you were doing.]"
			);
		}
	}

	/**
	 * Check an event for usage data and record it via the cost tracker.
	 * Broadcasts a cost_update to connected clients if cost data is found.
	 */
	private trackCostFromEvent(session: SessionInfo, event: any): void {
		// Only track cost on message_end (fires once per completed message).
		// message_update fires on every streaming chunk with the same usage
		// object, which would multiply costs by ~30-40x.
		if (event.type !== "message_end") return;
		if (event.message?.role !== "assistant") return;
		const usage = event.message?.usage ?? event.usage;
		if (!usage) return;

		// Usage cost can be either a number (usage.cost) or an object (usage.cost.total)
		const costValue = typeof usage.cost === "number" ? usage.cost
			: typeof usage.cost?.total === "number" ? usage.cost.total
			: undefined;
		if (costValue === undefined) return;

		const cumulativeCost = this.costTracker.recordUsage(session.id, {
			inputTokens: usage.inputTokens ?? usage.input,
			outputTokens: usage.outputTokens ?? usage.output,
			cacheReadTokens: usage.cacheReadTokens ?? usage.cacheRead,
			cacheWriteTokens: usage.cacheWriteTokens ?? usage.cacheWrite,
			cost: costValue,
		});

		// Look up taskId from assigned tasks for this session
		const assignedTasks = this.taskManager.getTasksForSession(session.id);
		const taskId = assignedTasks.length > 0 ? assignedTasks[0].id : undefined;

		broadcast(session.clients, {
			type: "cost_update",
			sessionId: session.id,
			goalId: session.goalId,
			taskId,
			cost: cumulativeCost,
		});
	}

	/**
	 * Restore sessions from disk on startup.
	 * Re-spawns agent processes and uses switch_session to resume each one.
	 */
	async restoreSessions(): Promise<void> {
		const persisted = this.store.getLive();
		if (persisted.length === 0) return;

		// Separate regular sessions from delegate sessions
		const regular = persisted.filter(ps => !ps.delegateOf);
		const delegates = persisted.filter(ps => !!ps.delegateOf);

		console.log(`[session-manager] Restoring ${regular.length} session(s), deferring ${delegates.length} delegate(s)...`);

		// Restore regular sessions in parallel (batched concurrency)
		const CONCURRENCY = 5;
		for (let i = 0; i < regular.length; i += CONCURRENCY) {
			const batch = regular.slice(i, i + CONCURRENCY);
			await Promise.all(batch.map(ps => this.restoreOneSession(ps)));
		}

		// Delegate sessions: dormant entries only — restored on-demand via addClient()
		for (const ps of delegates) {
			if (!fs.existsSync(ps.agentSessionFile)) {
				this.store.remove(ps.id);
				continue;
			}
			this.addDormantSession(ps);
		}

		// Stuck worktree recovery: warn about sessions with worktreePath set but directory missing
		for (const ps of persisted) {
			if (ps.worktreePath && !fs.existsSync(ps.worktreePath)) {
				console.warn(`[session-manager] Session "${ps.title}" (${ps.id}) has worktreePath "${ps.worktreePath}" but directory does not exist`);
			}
		}
	}

	private async restoreOneSession(ps: PersistedSession): Promise<void> {
		if (!fs.existsSync(ps.agentSessionFile)) {
			console.log(`[session-manager] Removing ${ps.id} — agent session file missing: ${ps.agentSessionFile}`);
			this.store.remove(ps.id);
			return;
		}
		try {
			await this.restoreSession(ps);
			console.log(`[session-manager] Restored: "${ps.title}" (${ps.id})`);
		} catch (err) {
			console.error(`[session-manager] Failed to restore "${ps.title}" (${ps.id}), will retry next restart:`, err);
			this.addDormantSession(ps);
		}
	}

	private addDormantSession(ps: PersistedSession): void {
		this.sessions.set(ps.id, {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "terminated",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			clients: new Set(),
			rpcClient: new RpcBridge({ cwd: ps.cwd }), // placeholder, not started
			eventBuffer: new EventBuffer(),
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			goalId: ps.goalId,
			delegateOf: ps.delegateOf,
			promptQueue: new PromptQueue(ps.messageQueue),
		});
	}

	private async restoreSession(ps: PersistedSession): Promise<void> {
		const bridgeOptions: RpcBridgeOptions = { cwd: ps.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;

		// Restore env vars needed by extensions
		bridgeOptions.env = { BOBBIT_SESSION_ID: ps.id };
		if (ps.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = ps.goalId;
		}
		if (ps.staffId) {
			bridgeOptions.env.BOBBIT_STAFF_ID = ps.staffId;
		}

		// Restore extension args for goal/team sessions
		if (ps.goalId && !ps.assistantType) {
			const isTeamLead = ps.role === "team-lead";
			const extensionPath = isTeamLead
				? TEAM_LEAD_EXTENSION_PATH
				: GOAL_TOOLS_EXTENSION_PATH;
			bridgeOptions.args = ["--extension", extensionPath];
		}

		// Restore tool activation from role's allowedTools
		if (ps.role && this.roleManager) {
			const role = this.roleManager.getRole(ps.role);
			if (role && role.allowedTools.length > 0) {
				const activation = computeToolActivationArgs(role.allowedTools, this.toolManager, ps.cwd);
				bridgeOptions.args = [...activation.args, ...(bridgeOptions.args || [])];
			}
		}

		// Derive allowedTools from role so restored prompts filter tool docs correctly
		let restoredAllowedTools: string[] | undefined;
		if (ps.role && this.roleManager) {
			const role = this.roleManager.getRole(ps.role);
			if (role && role.allowedTools.length > 0) {
				restoredAllowedTools = role.allowedTools;
			}
		}

		// Re-assemble system prompt (global + AGENTS.md + goal spec)
		const assistantDef = ps.assistantType ? getAssistantDef(ps.assistantType) : undefined;
		if (assistantDef) {
			// Combine assistant role's shared prompt with per-type specialized prompt
			const assistantRole = this.roleManager?.getRole("assistant");
			let assistantGoalSpec = "";
			if (assistantRole?.promptTemplate) {
				assistantGoalSpec = assistantRole.promptTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(ps.goalId || ps.id).slice(0, 8)}`);
				assistantGoalSpec += "\n\n---\n\n";
			}
			assistantGoalSpec += assistantDef.prompt;

			const promptPath = this.assemblePrompt(ps.id, {
				baseSystemPromptPath: undefined,
				cwd: ps.cwd,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: restoredAllowedTools,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else {
			const goal = ps.goalId ? this.goalManager.getGoal(ps.goalId) : undefined;
			// Resolve persisted personality names to prompt fragments
			const resolvedPersonalities = (ps.personalities && ps.personalities.length > 0 && this.personalityManager)
				? this.personalityManager.resolvePersonalities(ps.personalities)
				: undefined;

			// Re-attach role prompt for team agents (lost on restart since rolePrompt isn't persisted)
			const goalSpec = goal?.spec;
			let rolePrompt: string | undefined;
			let roleName: string | undefined;
			let toolRestrictionsText: string | undefined;
			if (ps.role && this.roleManager) {
				const role = this.roleManager.getRole(ps.role);
				if (role?.promptTemplate) {
					rolePrompt = role.promptTemplate;
					if (goal?.branch) rolePrompt = rolePrompt.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch);
					rolePrompt = rolePrompt.replace(/\{\{AGENT_ID\}\}/g, `${ps.role}-${(ps.goalId || ps.id).slice(0, 8)}`);
					roleName = ps.role;
				}
				if (role && role.allowedTools.length > 0) {
					const toolList = role.allowedTools.join(", ");
					toolRestrictionsText = `## Tool Restrictions\n\nYou are ONLY allowed to use the following tools: ${toolList}\n\nDo NOT use any other tools. If a task requires a tool you don't have access to, explain what you need and ask for help instead of attempting to use the restricted tool.`;
				}
			}

			const promptPath = this.assemblePrompt(ps.id, {
				baseSystemPromptPath: this.systemPromptPath,
				cwd: ps.cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec,
				rolePrompt,
				roleName,
				toolRestrictions: toolRestrictionsText,
				personalities: resolvedPersonalities,
				allowedTools: restoredAllowedTools,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();

		const session: SessionInfo = {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "starting",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: ps.title !== "New session",
			goalId: ps.goalId,
			assistantType: ps.assistantType,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			teamLeadSessionId: ps.teamLeadSessionId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			staffId: ps.staffId,
			accessory: ps.accessory,
			preview: ps.preview,
			personalities: ps.personalities,
			allowedTools: restoredAllowedTools,
			promptQueue: new PromptQueue(ps.messageQueue),
			streamingStartedAt: ps.streamingStartedAt,
		};

		// Skip cost tracking during session restore (switch_session replays
		// all historical message_update events which would double-count costs)
		let restoring = true;

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(ps.id, { lastActivity: session.lastActivity });

			this.handleAgentLifecycle(session, event);

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			if (!restoring) this.trackCostFromEvent(session, event);
		});

		session.unsubscribe = unsub;

		await rpcClient.start();

		// Resume the agent's previous session file
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: ps.agentSessionFile },
			15_000,
		);
		restoring = false;
		if (!switchResp.success) {
			await rpcClient.stop();
			throw new Error(`switch_session failed: ${switchResp.error}`);
		}

		session.status = "idle";
		this.sessions.set(ps.id, session);

		// If the agent was mid-turn when the server died, re-prompt it to continue
		if (ps.wasStreaming) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn — re-prompting to continue`);
			this.store.update(ps.id, { wasStreaming: false });
			rpcClient.prompt(
				"[SYSTEM: The infrastructure server restarted while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			).catch((err: any) => {
				console.error(`[session-manager] Failed to re-prompt interrupted session ${ps.id}:`, err);
			});
		}
	}

	async createSession(cwd: string, agentArgs?: string[], goalId?: string, assistantType?: string, opts?: { rolePrompt?: string; roleName?: string; env?: Record<string, string>; taskId?: string; allowedTools?: string[]; personalities?: Array<{ label: string; promptFragment: string }>; personalityNames?: string[]; workflowContext?: string; worktreeOpts?: { repoPath: string } }): Promise<SessionInfo> {
		const id = randomUUID();

		// ── Worktree: return a "preparing" session immediately, launch agent async ──
		if (opts?.worktreeOpts) {
			const repoPath = opts.worktreeOpts.repoPath;
			const slug = "new-session";
			const uuid8 = id.slice(0, 8);
			const branch = `session/${slug}-${uuid8}`;
			const wtRoot = path.resolve(repoPath, "..", `${path.basename(repoPath)}-wt`);
			const safeName = branch.replace(/\//g, "-");
			const worktreePath = path.join(wtRoot, safeName);

			const now = Date.now();
			const session: SessionInfo = {
				id,
				title: "New session",
				cwd, // temporary — will be updated when worktree is ready
				status: "preparing",
				createdAt: now,
				lastActivity: now,
				clients: new Set(),
				rpcClient: new RpcBridge({ cwd }), // placeholder, not started
				eventBuffer: new EventBuffer(),
				unsubscribe: () => {},
				isCompacting: false,
				titleGenerated: false,
				goalId,
				assistantType: undefined,
				taskId: opts?.taskId,
				personalities: opts?.personalityNames,
				allowedTools: opts?.allowedTools,
				worktreePath,
				promptQueue: new PromptQueue(),
			};

			this.sessions.set(id, session);
			this.store.update(id, { repoPath, branch, worktreePath });
			this.persistSessionMetadata(session).catch(() => {});

			// Fire-and-forget: create worktree then launch agent
			this._setupWorktreeAndLaunchAgent(session, repoPath, branch, cwd, agentArgs, goalId, opts).catch((err) => {
				console.error(`[session-manager] Worktree session setup failed for ${id}:`, err);
				session.status = "terminated";
				broadcast(session.clients, { type: "session_status", status: "terminated" });
			});

			return session;
		}

		const bridgeOptions: RpcBridgeOptions = {
			cwd,
			args: agentArgs ? [...agentArgs] : [],
			env: { BOBBIT_SESSION_ID: id, ...opts?.env },
		};
		if (this.agentCliPath) {
			bridgeOptions.cliPath = this.agentCliPath;
		}

		// Auto-load goal tools extension for any goal-associated session
		// (unless it's a goal/role assistant, or already has an extension —
		// tool-activation handles loading both tasks + team extensions via YAML providers)
		if (goalId && !assistantType) {
			const alreadyHasExtension = bridgeOptions.args?.includes("--extension");
			if (!alreadyHasExtension) {
				bridgeOptions.args = bridgeOptions.args || [];
				bridgeOptions.args.push("--extension", GOAL_TOOLS_EXTENSION_PATH);
			}
			// Ensure BOBBIT_GOAL_ID is set for the extension to read
			bridgeOptions.env = { ...bridgeOptions.env, BOBBIT_GOAL_ID: goalId };
		}

		// Determine tool restrictions: explicit role tools > General role > no restriction
		let effectiveAllowedTools = opts?.allowedTools;
		if (!effectiveAllowedTools && this.roleManager) {
			const generalRole = this.roleManager.getRole("general");
			if (generalRole && generalRole.allowedTools.length > 0) {
				effectiveAllowedTools = generalRole.allowedTools;
			}
		}

		const assistantDef = assistantType ? getAssistantDef(assistantType) : undefined;
		if (assistantDef) {
			// Combine assistant role's shared prompt with per-type specialized prompt
			const assistantRole = this.roleManager?.getRole("assistant");
			let assistantGoalSpec = "";
			if (assistantRole?.promptTemplate) {
				assistantGoalSpec = assistantRole.promptTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(goalId || id).slice(0, 8)}`);
				assistantGoalSpec += "\n\n---\n\n";
			}
			assistantGoalSpec += assistantDef.prompt;

			// Use assistant role's tool restrictions (before assemblePrompt so tool docs are filtered correctly)
			if (assistantRole && assistantRole.allowedTools.length > 0) {
				effectiveAllowedTools = assistantRole.allowedTools;
			}

			const promptPath = this.assemblePrompt(id, {
				baseSystemPromptPath: undefined,
				cwd,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: effectiveAllowedTools,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else {
			// Normal sessions: global base + AGENTS.md from cwd + goal spec
			const goal = goalId ? this.goalManager.getGoal(goalId) : undefined;
			const goalSpec = goal?.spec;

			// Build tool restrictions text if allowedTools is specified and non-empty
			let toolRestrictionsText: string | undefined;
			if (effectiveAllowedTools && effectiveAllowedTools.length > 0) {
				const toolList = effectiveAllowedTools.join(", ");
				toolRestrictionsText = `## Tool Restrictions\n\nYou are ONLY allowed to use the following tools: ${toolList}\n\nDo NOT use any other tools. If a task requires a tool you don't have access to, explain what you need and ask for help instead of attempting to use the restricted tool.`;
			}

			// Build task context if taskId is provided
			let taskTitle: string | undefined;
			let taskType: string | undefined;
			let taskSpec: string | undefined;
			let taskDependsOn: string[] | undefined;
			if (opts?.taskId) {
				const task = this.taskManager.getTask(opts.taskId);
				if (task) {
					taskTitle = task.title;
					taskType = task.type;
					taskSpec = task.spec;
					if (task.dependsOn && task.dependsOn.length > 0) {
						taskDependsOn = task.dependsOn.map(depId => {
							const dep = this.taskManager.getTask(depId);
							return dep?.title || depId;
						});
					}
				}
			}

			const promptPath = this.assemblePrompt(id, {
				baseSystemPromptPath: this.systemPromptPath,
				cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec,
				rolePrompt: opts?.rolePrompt,
				roleName: opts?.roleName,
				toolRestrictions: toolRestrictionsText,
				taskTitle,
				taskType,
				taskSpec,
				taskDependsOn,
				personalities: opts?.personalities,
				allowedTools: effectiveAllowedTools,
				workflowContext: opts?.workflowContext,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		}

		// Apply tool activation args based on allowedTools (controls --tools and --extension flags)
		if (effectiveAllowedTools && effectiveAllowedTools.length > 0) {
			const activation = computeToolActivationArgs(effectiveAllowedTools, this.toolManager, cwd);
			bridgeOptions.args = [...activation.args, ...(bridgeOptions.args || [])];
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();

		const now = Date.now();
		const session: SessionInfo = {
			id,
			title: assistantDef?.title ?? "New session",
			cwd,
			status: "starting",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: !!assistantDef,
			goalId,
			assistantType,
			taskId: opts?.taskId,
			personalities: opts?.personalityNames,
			allowedTools: effectiveAllowedTools ?? opts?.allowedTools,
			promptQueue: new PromptQueue(),
		};

		// Auto-assign task to this session
		if (opts?.taskId) {
			try {
				this.taskManager.assignTask(opts.taskId, id);
			} catch (err) {
				console.error(`[session-manager] Failed to assign task ${opts.taskId} to session ${id}:`, err);
			}
		}

		// Subscribe to agent events — broadcast to all connected clients
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });

			this.handleAgentLifecycle(session, event);

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			this.trackCostFromEvent(session, event);
		});

		session.unsubscribe = unsub;

		await rpcClient.start();
		session.status = "idle";

		this.sessions.set(id, session);

		// Auto-select aigw model when gateway is configured
		await this.tryAutoSelectModel(session);

		// Capture the agent's session file path and persist
		this.persistSessionMetadata(session).catch((err) => {
			console.error(`[session-manager] Failed to persist session ${id}:`, err);
		});

		return session;
	}

	/**
	 * Async worktree setup + agent launch for sessions created with worktreeOpts.
	 * Creates the worktree, then launches the agent in it.
	 */
	private async _setupWorktreeAndLaunchAgent(
		session: SessionInfo,
		repoPath: string,
		branch: string,
		originalCwd: string,
		agentArgs?: string[],
		goalId?: string,
		opts?: { rolePrompt?: string; roleName?: string; env?: Record<string, string>; taskId?: string; allowedTools?: string[]; personalities?: Array<{ label: string; promptFragment: string }>; personalityNames?: string[]; workflowContext?: string; worktreeOpts?: { repoPath: string } },
	): Promise<void> {
		// Create worktree with one retry
		let worktreeCwd: string;
		try {
			const result = await createWorktree(repoPath, branch);
			worktreeCwd = result.worktreePath;
		} catch (err) {
			await new Promise(resolve => setTimeout(resolve, 1000));
			const result = await createWorktree(repoPath, branch);
			worktreeCwd = result.worktreePath;
		}

		// Update session metadata
		session.cwd = worktreeCwd;
		session.worktreePath = worktreeCwd;
		this.store.update(session.id, { cwd: worktreeCwd, worktreePath: worktreeCwd });
		console.log(`[session-manager] Worktree ready for session ${session.id}: ${worktreeCwd} (branch: ${branch})`);

		// Now launch the agent (mirrors the non-worktree path in createSession)
		const cwd = worktreeCwd;
		const id = session.id;

		const bridgeOptions: RpcBridgeOptions = {
			cwd,
			args: agentArgs ? [...agentArgs] : [],
			env: { BOBBIT_SESSION_ID: id, ...opts?.env },
		};
		if (this.agentCliPath) {
			bridgeOptions.cliPath = this.agentCliPath;
		}

		if (goalId) {
			const alreadyHasExtension = bridgeOptions.args?.includes("--extension");
			if (!alreadyHasExtension) {
				bridgeOptions.args = bridgeOptions.args || [];
				bridgeOptions.args.push("--extension", GOAL_TOOLS_EXTENSION_PATH);
			}
			bridgeOptions.env = { ...bridgeOptions.env, BOBBIT_GOAL_ID: goalId };
		}

		let effectiveAllowedTools = opts?.allowedTools;
		if (!effectiveAllowedTools && this.roleManager) {
			const generalRole = this.roleManager.getRole("general");
			if (generalRole && generalRole.allowedTools.length > 0) {
				effectiveAllowedTools = generalRole.allowedTools;
			}
		}

		// Build system prompt
		const goal = goalId ? this.goalManager.getGoal(goalId) : undefined;
		let toolRestrictionsText: string | undefined;
		if (effectiveAllowedTools && effectiveAllowedTools.length > 0) {
			const toolList = effectiveAllowedTools.join(", ");
			toolRestrictionsText = `## Tool Restrictions\n\nYou are ONLY allowed to use the following tools: ${toolList}\n\nDo NOT use any other tools. If a task requires a tool you don't have access to, explain what you need and ask for help instead of attempting to use the restricted tool.`;
		}

		let taskTitle: string | undefined;
		let taskType: string | undefined;
		let taskSpec: string | undefined;
		let taskDependsOn: string[] | undefined;
		if (opts?.taskId) {
			const task = this.taskManager.getTask(opts.taskId);
			if (task) {
				taskTitle = task.title;
				taskType = task.type;
				taskSpec = task.spec;
				if (task.dependsOn && task.dependsOn.length > 0) {
					taskDependsOn = task.dependsOn.map(depId => {
						const dep = this.taskManager.getTask(depId);
						return dep?.title || depId;
					});
				}
			}
		}

		const promptPath = this.assemblePrompt(id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec: goal?.spec,
			rolePrompt: opts?.rolePrompt,
			roleName: opts?.roleName,
			toolRestrictions: toolRestrictionsText,
			taskTitle,
			taskType,
			taskSpec,
			taskDependsOn,
			personalities: opts?.personalities,
			allowedTools: effectiveAllowedTools,
			workflowContext: opts?.workflowContext,
		});
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;

		if (effectiveAllowedTools && effectiveAllowedTools.length > 0) {
			const activation = computeToolActivationArgs(effectiveAllowedTools, this.toolManager, cwd);
			bridgeOptions.args = [...activation.args, ...(bridgeOptions.args || [])];
		}

		// Replace the placeholder rpcClient with a real one
		const rpcClient = new RpcBridge(bridgeOptions);
		session.rpcClient = rpcClient;
		session.allowedTools = effectiveAllowedTools ?? opts?.allowedTools;

		if (opts?.taskId) {
			try {
				this.taskManager.assignTask(opts.taskId, id);
			} catch (err) {
				console.error(`[session-manager] Failed to assign task ${opts.taskId} to session ${id}:`, err);
			}
		}

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });
			this.handleAgentLifecycle(session, event);
			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			this.trackCostFromEvent(session, event);
		});
		session.unsubscribe = unsub;

		const eventBuffer = session.eventBuffer;

		await rpcClient.start();
		session.status = "idle";

		await this.tryAutoSelectModel(session);
		this.persistSessionMetadata(session).catch(() => {});

		// Notify connected clients that the session is ready
		broadcast(session.clients, { type: "session_status", status: "idle" });
	}

	/**
	 * Create a delegate session — a real session that runs a task on behalf of a parent session.
	 * The delegate gets a system prompt built from AGENTS.md + instructions.
	 * After creation, the instructions are automatically sent as the first prompt.
	 * Returns the session info immediately (the prompt runs asynchronously).
	 */
	async createDelegateSession(parentSessionId: string, opts: {
		instructions: string;
		cwd: string;
		title?: string;
		context?: Record<string, string>;
	}): Promise<SessionInfo> {
		const id = randomUUID();

		// Build the task spec: instructions + optional context
		let taskSpec = opts.instructions;
		if (opts.context && Object.keys(opts.context).length > 0) {
			taskSpec += "\n\n## Context";
			for (const [key, value] of Object.entries(opts.context)) {
				taskSpec += `\n- **${key}**: ${value}`;
			}
		}

		// assembleSystemPrompt handles AGENTS.md from cwd automatically
		const promptPath = this.assemblePrompt(id, {
			baseSystemPromptPath: undefined, // No global prompt — delegate gets AGENTS.md only
			cwd: opts.cwd,
			goalSpec: taskSpec,
			goalTitle: "Delegate Task",
			goalState: "active",
		});

		const bridgeOptions: RpcBridgeOptions = { cwd: opts.cwd, env: { BOBBIT_SESSION_ID: id, BOBBIT_DELEGATE_OF: parentSessionId } };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;

		const rpcClient = new RpcBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();
		const now = Date.now();

		const titleSummary = opts.title || opts.instructions.split("\n")[0].slice(0, 60) || "Delegate";
		const session: SessionInfo = {
			id,
			title: `⚡ ${titleSummary}`,
			cwd: opts.cwd,
			status: "starting",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			delegateOf: parentSessionId,
			promptQueue: new PromptQueue(),
		};

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });

			this.handleAgentLifecycle(session, event);

			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			this.trackCostFromEvent(session, event);
		});

		session.unsubscribe = unsub;
		await rpcClient.start();
		session.status = "idle";
		this.sessions.set(id, session);

		// Auto-select aigw model when gateway is configured and internet is unavailable
		await this.tryAutoSelectModel(session);

		// Persist session metadata
		this.persistSessionMetadata(session).then(() => {
			this.store.update(id, { delegateOf: parentSessionId });
		}).catch((err) => {
			console.error(`[session-manager] Failed to persist delegate session ${id}:`, err);
		});

		// Send the task prompt and wait for the agent to start streaming
		// so that waitForIdle() doesn't return immediately.
		await rpcClient.prompt(
			"Execute the task described in your system prompt. Follow the instructions carefully."
		);

		// Wait for agent_start event (so session.status becomes "streaming")
		await new Promise<void>((resolve) => {
			if (session.status === "streaming") { resolve(); return; }
			const timeout = setTimeout(() => { unsub2(); resolve(); }, 10_000);
			const unsub2 = rpcClient.onEvent((event: any) => {
				if (event.type === "agent_start") {
					clearTimeout(timeout);
					unsub2();
					resolve();
				}
			});
		});

		console.log(`[session-manager] Created delegate session ${id} (parent: ${parentSessionId}, status: ${session.status})`);
		return session;
	}

	/**
	 * Wait for a session to become idle (not streaming).
	 * Returns immediately if already idle.
	 * Rejects on timeout.
	 */
	waitForIdle(sessionId: string, timeoutMs = 600_000): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.reject(new Error("Session not found"));
		if (session.status === "idle") return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error(`Timeout waiting for session ${sessionId} to become idle`));
			}, timeoutMs);

			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsub();
					resolve();
				}
			});
		});
	}

	/**
	 * Get the final assistant output from a session's messages.
	 */
	async getSessionOutput(sessionId: string): Promise<string> {
		const session = this.sessions.get(sessionId);
		if (!session) return "";

		const msgsResp = await session.rpcClient.getMessages();
		if (!msgsResp.success) return "";

		const messages = msgsResp.data?.messages || msgsResp.data;
		if (!Array.isArray(messages)) return "";

		// Collect text from all assistant messages
		const texts: string[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant") {
				const content = msg.content;
				if (typeof content === "string") {
					texts.push(content);
				} else if (Array.isArray(content)) {
					for (const block of content) {
						if (block.type === "text" && block.text) texts.push(block.text);
					}
				}
			}
		}
		return texts.join("\n\n");
	}

	/** Query the agent for its session file and save metadata to disk */
	/** After compaction, refresh messages and state for all connected clients. */
	async refreshAfterCompaction(session: SessionInfo): Promise<void> {
		try {
			const msgs = await session.rpcClient.getMessages();
			if (msgs.success) {
				broadcast(session.clients, { type: "messages", data: msgs.data });
			}
			const st = await session.rpcClient.getState();
			if (st.success) {
				broadcast(session.clients, { type: "state", data: st.data });
			}
		} catch (err) {
			console.error(`[session-manager] Failed to refresh after compaction for ${session.id}:`, err);
		}
	}

	/**
	 * If an AI Gateway is configured, automatically set the session model
	 * to the first aigw model. Called on every new session — no internet
	 * check here; the gateway's presence was validated at startup or by
	 * the user via Settings.
	 */
	/**
	 * Auto-select a model for a new session. Uses `default.sessionModel`
	 * preference (format: "provider/modelId") if set. Falls back to aigw
	 * best-ranked model when gateway is configured, otherwise does nothing
	 * (pi-coding-agent uses its own built-in default).
	 */
	private async tryAutoSelectModel(session: SessionInfo): Promise<void> {
		if (!this.preferencesStore) return;

		// Check explicit preference first (works for both aigw and public providers)
		const sessionModelPref = this.preferencesStore.get("default.sessionModel") as string | undefined;
		if (sessionModelPref) {
			const slash = sessionModelPref.indexOf("/");
			if (slash > 0 && slash < sessionModelPref.length - 1) {
				const provider = sessionModelPref.slice(0, slash);
				const modelId = sessionModelPref.slice(slash + 1);
				try {
					await session.rpcClient.setModel(provider, modelId);
					console.log(`[session-manager] Set preferred model "${sessionModelPref}" for session ${session.id}`);
					broadcast(session.clients, {
						type: "state",
						data: { model: { provider, id: modelId } },
					});
					return;
				} catch (err) {
					console.warn(`[session-manager] Preferred model "${sessionModelPref}" failed, falling back:`, err);
				}
			} else {
				console.warn(`[session-manager] Malformed default.sessionModel preference: "${sessionModelPref}", ignoring`);
			}
		}

		// Fall back to aigw best-ranked model when gateway is configured
		const aigwUrl = getAigwUrl(this.preferencesStore);
		const aigwModels = getAigwModels(this.preferencesStore);
		if (!aigwUrl || !aigwModels || aigwModels.length === 0) return;

		try {
			const modelToUse = [...aigwModels].sort((a, b) => modelRecencyRank(b.id) - modelRecencyRank(a.id))[0];

			await session.rpcClient.setModel("aigw", modelToUse.id);
			console.log(`[session-manager] Auto-selected aigw model "${modelToUse.id}" for session ${session.id}`);

			broadcast(session.clients, {
				type: "state",
				data: { model: { provider: "aigw", id: modelToUse.id } },
			});
		} catch (err) {
			console.warn(`[session-manager] Failed to auto-select model for ${session.id}:`, err);
		}
	}

	async persistSessionMetadata(session: SessionInfo): Promise<void> {
		const stateResp = await session.rpcClient.getState();
		if (!stateResp.success || !stateResp.data?.sessionFile) {
			console.warn(`[session-manager] Could not get agent session file for ${session.id}`);
			return;
		}

		// Preserve fields that may have been set via store.update() before this async call
		const existing = this.store.get(session.id);

		this.store.put({
			id: session.id,
			title: session.title,
			cwd: session.cwd,
			agentSessionFile: stateResp.data.sessionFile,
			createdAt: session.createdAt,
			lastActivity: session.lastActivity,
			goalId: session.goalId,
			assistantType: session.assistantType,
			role: session.role,
			teamGoalId: session.teamGoalId,
			worktreePath: session.worktreePath,
			repoPath: existing?.repoPath,
			branch: existing?.branch,
			taskId: session.taskId,
			staffId: session.staffId,
			accessory: session.accessory,
			nonInteractive: session.nonInteractive,
			preview: session.preview,
			personalities: session.personalities,
		});
	}

	getSession(id: string): SessionInfo | undefined {
		return this.sessions.get(id);
	}

	/**
	 * Register an externally-created RPC bridge as a viewable session.
	 * Used for LLM review sub-agents in verification harness so users can watch them live.
	 * Returns an unsubscribe function to call when the session ends.
	 */
	registerExternalSession(id: string, rpcClient: RpcBridge, opts: {
		title: string;
		cwd: string;
		role?: string;
		goalId?: string;
		teamGoalId?: string;
	}): () => void {
		const eventBuffer = new EventBuffer();
		const now = Date.now();

		const session: SessionInfo = {
			id,
			title: opts.title,
			cwd: opts.cwd,
			status: "idle",
			createdAt: now,
			lastActivity: now,
			clients: new Set(),
			rpcClient,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			titleGenerated: true,
			goalId: opts.goalId,
			role: opts.role,
			teamGoalId: opts.teamGoalId,
			promptQueue: new PromptQueue(),
		};

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.handleAgentLifecycle(session, event);
			eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			this.trackCostFromEvent(session, event);
		});
		session.unsubscribe = unsub;

		this.sessions.set(id, session);

		this.persistSessionMetadata(session).catch((err) => {
			console.error(`[session-manager] Failed to persist external session ${id}:`, err);
		});

		console.log(`[session-manager] Registered external session ${id}: ${opts.title}`);

		return () => {
			unsub();
			session.status = "terminated";
			for (const client of session.clients) {
				client.close(1000, "Session terminated");
			}
			session.clients.clear();
			this.sessions.delete(id);
			this.store.remove(id);
			cleanupSessionPrompt(id);
			console.log(`[session-manager] Unregistered external session ${id}`);
		};
	}

	listSessions(): Array<{
		id: string;
		title: string;
		cwd: string;
		status: string;
		createdAt: number;
		lastActivity: number;
		clientCount: number;
		isCompacting: boolean;
		goalId?: string;
		assistantType?: string;
		goalAssistant?: boolean;
		roleAssistant?: boolean;
		toolAssistant?: boolean;
		delegateOf?: string;
		role?: string;
		teamGoalId?: string;
		teamLeadSessionId?: string;
		worktreePath?: string;
		taskId?: string;
		staffId?: string;
		accessory?: string;
		nonInteractive?: boolean;
		preview?: boolean;
		personalities?: string[];
	}> {
		return Array.from(this.sessions.values()).map((s) => ({
			id: s.id,
			title: s.title,
			cwd: s.cwd,
			status: s.status,
			createdAt: s.createdAt,
			lastActivity: s.lastActivity,
			clientCount: s.clients.size,
			isCompacting: s.isCompacting,
			goalId: s.goalId,
			assistantType: s.assistantType,
			// Legacy boolean fields for backward compat
			goalAssistant: s.assistantType === "goal",
			roleAssistant: s.assistantType === "role",
			toolAssistant: s.assistantType === "tool",
			delegateOf: s.delegateOf,
			role: s.role,
			teamGoalId: s.teamGoalId,
			teamLeadSessionId: s.teamLeadSessionId,
			worktreePath: s.worktreePath,
			taskId: s.taskId,
			staffId: s.staffId,
			accessory: s.accessory,
			nonInteractive: s.nonInteractive,
			preview: s.preview,
			personalities: s.personalities,
		}));
	}

	/**
	 * Get all session IDs for a goal, including terminated sessions from the store.
	 * Useful for cost aggregation where terminated sessions still have cost data.
	 */
	getAllSessionIdsForGoal(goalId: string): string[] {
		const ids = new Set(
			Array.from(this.sessions.values())
				.filter((s) => s.goalId === goalId)
				.map((s) => s.id),
		);
		for (const ps of this.store.getAll()) {
			if (ps.goalId === goalId) ids.add(ps.id);
		}
		return [...ids];
	}

	setTitle(id: string, title: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		session.title = title;
		this.store.update(id, { title });
		broadcast(session.clients, { type: "session_title", sessionId: id, title });
		return true;
	}

	/**
	 * Generate an AI-summarized goal title and rename the session.
	 * Fire-and-forget — does NOT check titleGenerated (independent of first-message auto-title).
	 */
	generateGoalTitle(sessionId: string, goalTitle: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this._generateGoalTitleAsync(session, goalTitle).catch(err => {
			console.error(`[session ${session.id}] Goal title generation failed:`, err);
		});
	}

	private async _generateGoalTitleAsync(session: SessionInfo, goalTitle: string): Promise<void> {
		const title = await generateGoalSummaryTitle(goalTitle, this.getTitleGenOptions());
		if (title) {
			const finalTitle = `New goal: ${title}`;
			session.title = finalTitle;
			this.store.update(session.id, { title: finalTitle });
			broadcast(session.clients, { type: "session_title", sessionId: session.id, title: finalTitle });
		}
	}

	/** Update session metadata fields (role, teamGoalId, worktreePath, accessory, teamLeadSessionId) and persist. */
	updateSessionMeta(id: string, updates: { role?: string; teamGoalId?: string; worktreePath?: string; accessory?: string; nonInteractive?: boolean; teamLeadSessionId?: string }): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (updates.role !== undefined) session.role = updates.role;
		if (updates.teamGoalId !== undefined) session.teamGoalId = updates.teamGoalId;
		if (updates.worktreePath !== undefined) session.worktreePath = updates.worktreePath;
		if (updates.accessory !== undefined) session.accessory = updates.accessory;
		if (updates.nonInteractive !== undefined) session.nonInteractive = updates.nonInteractive;
		if (updates.teamLeadSessionId !== undefined) session.teamLeadSessionId = updates.teamLeadSessionId;
		this.store.update(id, updates);
		return true;
	}

	// ── Draft storage ──────────────────────────────────────────────

	/**
	 * Ensure the session has an entry in the persistent store.
	 * When a session is first created, store.put() is called asynchronously
	 * (fire-and-forget) so it may not have completed yet. This ensures
	 * draft operations work even before persistence is complete.
	 */
	private ensureStoreEntry(id: string): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (!this.store.get(id)) {
			this.store.put({
				id: session.id,
				title: session.title,
				cwd: session.cwd,
				agentSessionFile: "",
				createdAt: session.createdAt,
				lastActivity: session.lastActivity,
				goalId: session.goalId,
			});
		}
		return true;
	}

	/** Get a draft for a session by type. */
	getDraft(id: string, type: string): unknown | undefined {
		if (!this.ensureStoreEntry(id)) return undefined;
		return this.store.getDraft(id, type);
	}

	/** Set a draft for a session by type. Returns false if session not found. */
	setDraft(id: string, type: string, data: unknown): boolean {
		if (!this.ensureStoreEntry(id)) return false;
		return this.store.setDraft(id, type, data);
	}

	/** Delete a draft for a session by type. */
	deleteDraft(id: string, type: string): boolean {
		if (!this.ensureStoreEntry(id)) return false;
		return this.store.deleteDraft(id, type);
	}

	/**
	 * Assign a role to an existing session by killing the agent, reassembling
	 * the system prompt with the role instructions, and respawning with
	 * `switch_session` to preserve conversation history.
	 */
	async assignRole(id: string, role: { name: string; promptTemplate: string; allowedTools: string[]; accessory: string }, opts?: { personalities?: string[] }): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (session.status === "streaming") throw new Error("Cannot assign role while agent is streaming");

		// Get the agent session file so we can restore conversation
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) agentSessionFile = stateResp.data?.sessionFile;
		} catch {
			const persisted = this.store.get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the current process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Reassemble system prompt with role instructions as separate fields
		const goal = session.goalId ? this.goalManager.getGoal(session.goalId) : undefined;
		const goalSpec = goal?.spec;
		let toolRestrictionsText: string | undefined;
		if (role.allowedTools.length > 0) {
			const toolList = role.allowedTools.join(", ");
			toolRestrictionsText = `## Tool Restrictions\n\nYou are ONLY allowed to use the following tools: ${toolList}\n\nDo NOT use any other tools. If a task requires a tool you don't have access to, explain what you need and ask for help instead of attempting to use the restricted tool.`;
		}

		// Resolve personalities for system prompt
		const personalityNames = opts?.personalities ?? session.personalities;
		const resolvedPersonalities = (personalityNames && personalityNames.length > 0 && this.personalityManager)
			? this.personalityManager.resolvePersonalities(personalityNames)
			: undefined;

		const promptPath = this.assemblePrompt(id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: session.cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec,
			rolePrompt: role.promptTemplate,
			roleName: role.name,
			toolRestrictions: toolRestrictionsText,
			personalities: resolvedPersonalities,
			allowedTools: role.allowedTools.length > 0 ? role.allowedTools : undefined,
		});

		// Respawn with new system prompt
		const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		bridgeOptions.env = { BOBBIT_SESSION_ID: id };
		if (session.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
			// Re-attach goal tools extension (unless this is a team lead, which gets it from team-manager)
			if (!bridgeOptions.args?.includes("--extension")) {
				bridgeOptions.args = ["--extension", GOAL_TOOLS_EXTENSION_PATH];
			}
		}

		// Apply tool activation args based on role's allowedTools
		if (role.allowedTools.length > 0) {
			const activation = computeToolActivationArgs(role.allowedTools, this.toolManager, session.cwd);
			bridgeOptions.args = [...activation.args, ...(bridgeOptions.args || [])];
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		let switchingSession = true;
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });
			this.handleAgentLifecycle(session, event);
			session.eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			if (!switchingSession) this.trackCostFromEvent(session, event);
		});

		await rpcClient.start();

		// Restore conversation from session file
		if (agentSessionFile && fs.existsSync(agentSessionFile)) {
			const switchResp = await rpcClient.sendCommand(
				{ type: "switch_session", sessionPath: agentSessionFile },
				15_000,
			);
			if (!switchResp.success) {
				console.error(`[session-manager] switch_session failed after role assignment: ${switchResp.error}`);
			}
		}
		switchingSession = false;

		// Swap in the new bridge and update metadata
		session.rpcClient = rpcClient;
		session.unsubscribe = unsub;
		session.status = "idle";
		session.role = role.name;
		session.accessory = role.accessory;
		session.allowedTools = role.allowedTools;
		if (opts?.personalities) session.personalities = opts.personalities;

		this.store.update(id, { role: role.name, accessory: role.accessory, personalities: opts?.personalities });

		broadcast(session.clients, { type: "session_status", status: "idle" } as any);

		// Refresh messages and state for connected clients
		try {
			const msgs = await rpcClient.getMessages();
			if (msgs.success) broadcast(session.clients, { type: "messages", data: msgs.data });
			const st = await rpcClient.getState();
			if (st.success) broadcast(session.clients, { type: "state", data: st.data });
		} catch { /* best-effort */ }

		console.log(`[session-manager] Assigned role "${role.name}" to session ${id}`);
		return true;
	}

	/**
	 * Update personalities for an existing session by killing the agent,
	 * reassembling the system prompt with the new personalities, and respawning
	 * with `switch_session` to preserve conversation history.
	 */
	async updatePersonalities(id: string, personalityNames: string[]): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (session.status === "streaming") throw new Error("Cannot update personalities while agent is streaming");

		// Get the agent session file so we can restore conversation
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) agentSessionFile = stateResp.data?.sessionFile;
		} catch {
			const persisted = this.store.get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the current process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Reassemble system prompt with new personalities (preserving role prompt if assigned)
		const goal = session.goalId ? this.goalManager.getGoal(session.goalId) : undefined;
		const goalSpec = goal?.spec;

		// If the session has a role, include its prompt template as separate fields
		let rolePrompt: string | undefined;
		let roleName: string | undefined;
		let toolRestrictionsText: string | undefined;
		let roleAllowedTools: string[] | undefined;
		if (session.role && this.roleManager) {
			const role = this.roleManager.getRole(session.role);
			if (role) {
				rolePrompt = role.promptTemplate;
				roleName = role.name;
				if (role.allowedTools.length > 0) {
					roleAllowedTools = role.allowedTools;
					const toolList = role.allowedTools.join(", ");
					toolRestrictionsText = `## Tool Restrictions\n\nYou are ONLY allowed to use the following tools: ${toolList}\n\nDo NOT use any other tools. If a task requires a tool you don't have access to, explain what you need and ask for help instead of attempting to use the restricted tool.`;
				}
			}
		}

		const resolvedPersonalities = (personalityNames.length > 0 && this.personalityManager)
			? this.personalityManager.resolvePersonalities(personalityNames)
			: undefined;

		const promptPath = this.assemblePrompt(id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: session.cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec,
			rolePrompt,
			roleName,
			toolRestrictions: toolRestrictionsText,
			personalities: resolvedPersonalities,
			allowedTools: roleAllowedTools,
		});

		// Respawn with new system prompt
		const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		bridgeOptions.env = { BOBBIT_SESSION_ID: id };
		if (session.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
			if (!bridgeOptions.args?.includes("--extension")) {
				bridgeOptions.args = ["--extension", GOAL_TOOLS_EXTENSION_PATH];
			}
		}

		// Restore tool activation from role's allowedTools
		if (session.role && this.roleManager) {
			const role = this.roleManager.getRole(session.role);
			if (role && role.allowedTools.length > 0) {
				const activation = computeToolActivationArgs(role.allowedTools, this.toolManager, session.cwd);
				bridgeOptions.args = [...activation.args, ...(bridgeOptions.args || [])];
			}
		}

		const rpcClient = new RpcBridge(bridgeOptions);
		let switchingSession = true;
		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.store.update(id, { lastActivity: session.lastActivity });
			this.handleAgentLifecycle(session, event);
			session.eventBuffer.push(event);
			broadcast(session.clients, { type: "event", data: event });
			if (!switchingSession) this.trackCostFromEvent(session, event);
		});

		await rpcClient.start();

		if (agentSessionFile && fs.existsSync(agentSessionFile)) {
			const switchResp = await rpcClient.sendCommand(
				{ type: "switch_session", sessionPath: agentSessionFile },
				15_000,
			);
			if (!switchResp.success) {
				console.error(`[session-manager] switch_session failed after personality update: ${switchResp.error}`);
			}
		}
		switchingSession = false;

		// Swap in the new bridge and update metadata
		session.rpcClient = rpcClient;
		session.unsubscribe = unsub;
		session.status = "idle";
		session.personalities = personalityNames;

		this.store.update(id, { personalities: personalityNames });

		broadcast(session.clients, { type: "session_status", status: "idle" } as any);

		// Refresh messages and state for connected clients
		try {
			const msgs = await rpcClient.getMessages();
			if (msgs.success) broadcast(session.clients, { type: "messages", data: msgs.data });
			const st = await rpcClient.getState();
			if (st.success) broadcast(session.clients, { type: "state", data: st.data });
		} catch { /* best-effort */ }

		console.log(`[session-manager] Updated personalities for session ${id}: [${personalityNames.join(", ")}]`);
		return true;
	}

	/**
	 * Generate a title for a session on the first user prompt.
	 * Called immediately when the user sends a message, not after the agent replies.
	 */
	tryGenerateTitleFromPrompt(sessionId: string, userText: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.titleGenerated) return;
		session.titleGenerated = true;

		// Fire-and-forget
		this.autoGenerateTitleFromText(session, userText).catch((err) => {
			console.error(`[session ${session.id}] Title generation failed:`, err);
		});
	}

	private getTitleGenOptions(): import("./title-generator.js").TitleGenOptions {
		const namingModel = this.preferencesStore?.get("default.namingModel") as string | undefined;
		const aigwUrl = this.preferencesStore ? getAigwUrl(this.preferencesStore) : undefined;
		return { namingModel: namingModel || undefined, aigwUrl };
	}

	private async autoGenerateTitleFromText(session: SessionInfo, userText: string): Promise<void> {
		const messages = [{ role: "user", content: userText }];
		const title = await generateSessionTitle(messages, this.getTitleGenOptions());
		if (title) {
			session.title = title;
			this.store.update(session.id, { title });
			broadcast(session.clients, { type: "session_title", sessionId: session.id, title });
		}
	}

	async autoGenerateTitle(session: SessionInfo): Promise<void> {
		try {
			const msgsResp = await session.rpcClient.getMessages();
			if (!msgsResp.success) return;

			const messages = msgsResp.data?.messages || msgsResp.data;
			if (!Array.isArray(messages) || messages.length === 0) return;

			const title = await generateSessionTitle(messages, this.getTitleGenOptions());
			if (title) {
				session.title = title;
				this.store.update(session.id, { title });
				broadcast(session.clients, { type: "session_title", sessionId: session.id, title });
			}
		} catch (err) {
			console.error(`[session ${session.id}] Title generation failed:`, err);
		}
	}

	/**
	 * Ensure a session's subprocess is alive. If the session is terminated or
	 * dormant, attempt to restore it from persisted data.
	 * Throws if the session cannot be restored.
	 */
	async ensureSessionAlive(sessionId: string): Promise<void> {
		const existing = this.sessions.get(sessionId);
		if (existing && existing.status !== "terminated") return; // already alive

		// Try to restore from persisted data
		const persisted = this.store.get(sessionId);
		if (!persisted) {
			throw new Error(`Cannot restore session ${sessionId}: no persisted data found`);
		}
		await this.restoreSession(persisted);
		console.log(`[session-manager] Restored session ${sessionId} via ensureSessionAlive`);
	}

	async terminateSession(id: string): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;

		// Cascade: terminate all delegate (child) sessions first
		const children = [...this.sessions.values()].filter(s => s.delegateOf === id);
		for (const child of children) {
			console.log(`[session ${id}] Cascading terminate to delegate ${child.id}`);
			await this.terminateSession(child.id);
		}
		// Also archive persisted-but-not-in-memory delegate sessions
		for (const ps of this.store.getLive()) {
			if (ps.delegateOf === id && !this.sessions.has(ps.id)) {
				this.store.archive(ps.id);
			}
		}

		session.unsubscribe();
		await session.rpcClient.stop();
		session.status = "terminated";

		// Clean up background processes
		if ((this as any).bgProcessManager) {
			(this as any).bgProcessManager.cleanup(id);
		}

		// Broadcast session_archived event before closing clients
		const archivedAt = Date.now();
		broadcast(session.clients, { type: "session_archived", sessionId: id, archivedAt });

		for (const client of session.clients) {
			client.close(1000, "Session terminated");
		}
		session.clients.clear();

		this.sessions.delete(id);
		// Archive instead of delete — keep metadata for 7 days
		this.store.archive(id);
		// Don't remove color or session prompt — they're needed for archived view
		return true;
	}

	/** Get an archived session's metadata. */
	getArchivedSession(id: string): PersistedSession | undefined {
		const ps = this.store.get(id);
		return ps?.archived ? ps : undefined;
	}

	/** Update metadata on an archived session (stored in the session store). */
	updateArchivedMeta(id: string, updates: { teamLeadSessionId?: string }): boolean {
		const ps = this.store.get(id);
		if (!ps?.archived) return false;
		this.store.update(id, updates);
		return true;
	}

	/** Parse the .jsonl file for an archived session and return messages. */
	getArchivedMessages(id: string): unknown[] {
		const ps = this.store.get(id);
		if (!ps?.archived || !ps.agentSessionFile) return [];
		try {
			if (!fs.existsSync(ps.agentSessionFile)) return [];
			const content = fs.readFileSync(ps.agentSessionFile, "utf-8");
			const lines = content.trim().split("\n");
			const messages: unknown[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line);
					// Extract chat messages (user and assistant messages)
					if (entry.type === "message" && entry.message) {
						messages.push(entry.message);
					}
				} catch {
					// Skip malformed lines
				}
			}
			return messages;
		} catch {
			return [];
		}
	}

	/** List archived sessions in the same format as listSessions(). */
	listArchivedSessions(): Array<{
		id: string;
		title: string;
		cwd: string;
		status: string;
		createdAt: number;
		lastActivity: number;
		clientCount: number;
		isCompacting: boolean;
		goalId?: string;
		assistantType?: string;
		delegateOf?: string;
		role?: string;
		teamGoalId?: string;
		teamLeadSessionId?: string;
		worktreePath?: string;
		taskId?: string;
		staffId?: string;
		accessory?: string;
		preview?: boolean;
		personalities?: string[];
		archived: boolean;
		archivedAt?: number;
	}> {
		return this.store.getArchived().map((ps) => ({
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "archived",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			clientCount: 0,
			isCompacting: false,
			goalId: ps.goalId,
			assistantType: ps.assistantType,
			delegateOf: ps.delegateOf,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			teamLeadSessionId: ps.teamLeadSessionId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			staffId: ps.staffId,
			accessory: ps.accessory,
			preview: ps.preview,
			personalities: ps.personalities,
			archived: true,
			archivedAt: ps.archivedAt,
		}));
	}

	/** Permanently purge a single archived session immediately. */
	async purgeArchivedSession(id: string): Promise<boolean> {
		const ps = this.store.get(id);
		if (!ps?.archived) return false;
		await this.purgeOneSession(ps);
		return true;
	}

	/** Purge all archived sessions older than 7 days. */
	async purgeExpiredArchives(): Promise<void> {
		const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
		const cutoff = Date.now() - SEVEN_DAYS_MS;
		const archived = this.store.getArchived();
		for (const ps of archived) {
			if (ps.archivedAt && ps.archivedAt < cutoff) {
				try {
					await this.purgeOneSession(ps);
					console.log(`[session-manager] Purged expired archive: "${ps.title}" (${ps.id})`);
				} catch (err) {
					console.error(`[session-manager] Failed to purge archive ${ps.id}:`, err);
				}
			}
		}
	}

	/** Internal: purge a single archived session — delete files, worktree, store entry. */
	private async purgeOneSession(ps: PersistedSession): Promise<void> {
		// Delete .jsonl file
		try {
			if (ps.agentSessionFile && fs.existsSync(ps.agentSessionFile)) {
				fs.unlinkSync(ps.agentSessionFile);
			}
		} catch (err) {
			console.error(`[session-manager] Failed to delete .jsonl for ${ps.id}:`, err);
		}

		// Delete session prompt file
		try {
			cleanupSessionPrompt(ps.id);
		} catch (err) {
			console.error(`[session-manager] Failed to cleanup prompt for ${ps.id}:`, err);
		}

		// Clean up worktree
		if (ps.worktreePath && ps.repoPath) {
			try {
				const { cleanupWorktree } = await import("../skills/git.js");
				await cleanupWorktree(ps.repoPath, ps.worktreePath, ps.branch, true);
			} catch (err) {
				console.error(`[session-manager] Failed to cleanup worktree for ${ps.id}:`, err);
			}
		}

		// Remove color
		try {
			this.colorStore?.remove(ps.id);
		} catch (err) {
			console.error(`[session-manager] Failed to remove color for ${ps.id}:`, err);
		}

		// Remove from store
		this.store.purge(ps.id);
	}

	/** Start the archive purge schedule — call after restoreSessions(). */
	startPurgeSchedule(): void {
		// Purge on startup
		this.purgeExpiredArchives().catch(err => {
			console.error("[session-manager] Startup purge failed:", err);
		});
		// Purge every 24 hours
		this.purgeInterval = setInterval(() => {
			this.purgeExpiredArchives().catch(err => {
				console.error("[session-manager] Scheduled purge failed:", err);
			});
		}, 24 * 60 * 60 * 1000);
	}

	addClient(sessionId: string, ws: WebSocket): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;

		// If session is dormant (failed restore), try to revive it
		if (session.status === "terminated") {
			const ps = this.store.get(sessionId);
			if (ps && fs.existsSync(ps.agentSessionFile)) {
				console.log(`[session-manager] Client connected to dormant session "${session.title}" — attempting restore`);
				this.restoreSession(ps)
					.then(() => {
						console.log(`[session-manager] Revived dormant session: "${session.title}" (${sessionId})`);
						// restoreSession replaces the map entry — add client to the new one
						const revived = this.sessions.get(sessionId);
						if (revived) revived.clients.add(ws);
					})
					.catch((err) => {
						console.error(`[session-manager] Failed to revive session ${sessionId}:`, err);
					});
				return true; // optimistically accept the client
			}
		}

		session.clients.add(ws);

		// Note: tool_execution_update events from the heartbeat will flow to
		// this client naturally via the broadcast in the event listener.
		// The message-list renders partial results from toolPartialResults,
		// so no event replay is needed — the next heartbeat (every 3s) will
		// populate the state.

		return true;
	}

	removeClient(sessionId: string, ws: WebSocket): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.clients.delete(ws);
		}
	}

	/**
	 * Abort the agent. If the graceful abort doesn't resolve within a timeout,
	 * force-kill the agent process and restart it so the session remains usable.
	 */
	async forceAbort(id: string, gracePeriodMs = 3000): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;

		// If not streaming, nothing to abort
		if (session.status !== "streaming") return;

		// Try graceful abort first
		try {
			await session.rpcClient.abort();
		} catch {
			// Abort RPC itself may fail/timeout — proceed to force kill
		}

		// Wait for the agent to become idle
		const settled = await new Promise<boolean>((resolve) => {
			if (session.status !== "streaming") {
				resolve(true);
				return;
			}
			const timer = setTimeout(() => {
				unsub();
				resolve(false);
			}, gracePeriodMs);
			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsub();
					resolve(true);
				}
			});
		});

		if (settled) return;

		// Graceful abort didn't work — force kill and restart the agent
		console.log(`[session-manager] Force-aborting session ${id} — killing agent process`);

		// Get the agent session file before killing so we can restore
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) {
				agentSessionFile = stateResp.data?.sessionFile;
			}
		} catch {
			// Process may be unresponsive — try the persisted store
			const persisted = this.store.get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Emit agent_end so clients know streaming stopped
		session.status = "idle";
		broadcast(session.clients, { type: "event", data: { type: "agent_end", messages: [] } });
		broadcast(session.clients, { type: "session_status", status: "idle" });

		// Restart the agent process
		try {
			const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
			if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
			if (this.systemPromptPath) bridgeOptions.systemPromptPath = this.systemPromptPath;
			bridgeOptions.env = { BOBBIT_SESSION_ID: id };

			// Restore goal extension
			if (session.goalId) {
				bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
				const isTeamLead = session.role === "team-lead";
				const extensionPath = isTeamLead
					? TEAM_LEAD_EXTENSION_PATH
					: GOAL_TOOLS_EXTENSION_PATH;
				bridgeOptions.args = ["--extension", extensionPath];
			}

			// Restore tool activation from role's allowedTools
			if (session.role && this.roleManager) {
				const role = this.roleManager.getRole(session.role);
				if (role && role.allowedTools.length > 0) {
					const activation = computeToolActivationArgs(role.allowedTools, this.toolManager, session.cwd);
					bridgeOptions.args = [...activation.args, ...(bridgeOptions.args || [])];
				}
			}

			const rpcClient = new RpcBridge(bridgeOptions);
			let switchingSession = true;
			const unsub = rpcClient.onEvent((event: any) => {
				session.lastActivity = Date.now();
				this.store.update(id, { lastActivity: session.lastActivity });

				this.handleAgentLifecycle(session, event);

				session.eventBuffer.push(event);
				broadcast(session.clients, { type: "event", data: event });
				if (!switchingSession) this.trackCostFromEvent(session, event);
			});

			await rpcClient.start();

			// Resume session if we have the session file
			if (agentSessionFile && fs.existsSync(agentSessionFile)) {
				const switchResp = await rpcClient.sendCommand(
					{ type: "switch_session", sessionPath: agentSessionFile },
					15_000,
				);
				if (!switchResp.success) {
					console.error(`[session-manager] switch_session failed after force abort: ${switchResp.error}`);
				}
			}
			switchingSession = false;

			// Swap in the new bridge
			session.rpcClient = rpcClient;
			session.unsubscribe = unsub;
			session.status = "idle";
			console.log(`[session-manager] Session ${id} agent restarted after force abort`);
		} catch (err) {
			console.error(`[session-manager] Failed to restart agent after force abort:`, err);
			session.status = "terminated";
			broadcast(session.clients, { type: "session_status", status: "terminated" });
		}
	}

	async shutdown(): Promise<void> {
		if (this.purgeInterval) {
			clearInterval(this.purgeInterval);
			this.purgeInterval = null;
		}

		// Don't remove from store on shutdown — sessions should survive restart.
		// Persist the streaming state for each session so interrupted agents
		// can be re-prompted on the next startup.
		const ids = Array.from(this.sessions.keys());
		for (const id of ids) {
			const session = this.sessions.get(id);
			if (!session) continue;

			// Snapshot the current streaming state before we kill the process.
			// This is authoritative — the in-memory status is always correct,
			// and we write it here to handle the case where shutdown() races
			// with a pending agent_end that hasn't flushed to disk yet.
			this.store.update(id, { wasStreaming: session.status === "streaming", streamingStartedAt: session.streamingStartedAt });

			session.unsubscribe();
			await session.rpcClient.stop();
			session.status = "terminated";

			for (const client of session.clients) {
				client.close(1000, "Server shutting down");
			}
			session.clients.clear();
			this.sessions.delete(id);
		}

		// Flush any debounced store writes before exit
		this.store.flush();
	}
}
