/**
 * Session creation pipeline — plan/execute architecture.
 *
 * Extracts duplicated session-creation logic from SessionManager into composable
 * pipeline steps.  Three creation paths (normal, worktree, delegate) share the
 * same step functions but differ in *when* the steps execute:
 *
 *   normal   — await full pipeline, return ready session
 *   worktree — return immediately with "preparing", pipeline runs async
 *   delegate — await pipeline + first prompt + streaming confirmation
 */

import path from "node:path";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import type { SessionInfo } from "./session-manager.js";
import type { RpcBridgeOptions } from "./rpc-bridge.js";
import { RpcBridge } from "./rpc-bridge.js";
import { EventBuffer } from "./event-buffer.js";
import { PromptQueue } from "./prompt-queue.js";
import type { SessionStore } from "./session-store.js";
import type { GoalManager } from "./goal-manager.js";
import type { TaskManager } from "./task-manager.js";
import type { SearchIndex } from "../search/search-index.js";
import type { CostTracker } from "./cost-tracker.js";
import type { PersonalityManager } from "./personality-manager.js";
import type { RoleManager } from "./role-manager.js";
import type { ToolManager } from "./tool-manager.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { SandboxManager } from "./sandbox-manager.js";
import type { PromptParts } from "./system-prompt.js";
import type { GrantPolicy } from "./role-store.js";
import type { ConfigCascade } from "./config-cascade.js";
import { getAssistantDef } from "./assistant-registry.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { computeToolActivationArgs, writeMcpProxyExtensions, writeToolGuardExtension, computeEffectiveAllowedTools } from "./tool-activation.js";
import { TOOLS_DIR } from "./tool-manager.js";
import { createWorktree, cleanupWorktree } from "../skills/git.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** Goal tools extension — task + gate management for any goal session. */
const GOAL_TOOLS_EXTENSION_PATH = path.join(TOOLS_DIR, "tasks", "extension.ts");

/** Proposal tools extension — propose_* tools for assistant sessions. */
const PROPOSAL_TOOLS_EXTENSION_PATH = path.join(TOOLS_DIR, "proposals", "extension.ts");

/** Delegate spawn timeout (30 seconds). */
export const DELEGATE_SPAWN_TIMEOUT_MS = 30_000;

// ── Interfaces ─────────────────────────────────────────────────────────────

export type SessionSetupMode = "normal" | "worktree" | "delegate";

export interface SessionSetupPlan {
	// Identity
	id: string;
	mode: SessionSetupMode;

	// Structural fields (known at creation, persisted immediately)
	title: string;
	cwd: string;
	goalId?: string;
	assistantType?: string;
	delegateOf?: string;
	taskId?: string;
	worktreePath?: string;
	repoPath?: string;
	branch?: string;
	sandboxed?: boolean;
	personalities?: string[];
	role?: string;
	staffId?: string;
	accessory?: string;
	nonInteractive?: boolean;

	// Computed during planning
	bridgeOptions: RpcBridgeOptions;
	effectiveAllowedTools?: string[];
	promptPath?: string;

	// Options passed through from caller
	agentArgs?: string[];
	env?: Record<string, string>;
	rolePrompt?: string;
	roleName?: string;
	personalityFragments?: Array<{ label: string; promptFragment: string }>;
	workflowContext?: string;
	reattemptGoalId?: string;

	// Project association
	projectId?: string;

	// Skip fire-and-forget model/thinking-level selection (verification sessions set their own)
	skipAutoModel?: boolean;
	skipAutoThinking?: boolean;

	// Sandbox worktree: branch to create inside the container
	sandboxBranch?: string;
	sandboxBaseBranch?: string;

	// Delegate-specific
	instructions?: string;
	context?: Record<string, string>;
}

/**
 * Dependencies from SessionManager that pipeline steps need.
 * Created via SessionManager.buildPipelineContext().
 */
export interface PipelineContext {
	agentCliPath?: string;
	systemPromptPath?: string;
	roleManager: RoleManager | null;
	toolManager: ToolManager | null;
	mcpManager: McpManager | null;
	goalManager: GoalManager;
	taskManager: TaskManager;
	personalityManager: PersonalityManager | null;
	projectConfigStore: import("./project-config-store.js").ProjectConfigStore | null;
	sandboxManager: SandboxManager | null;
	sandboxTokenStore: import("../auth/sandbox-token.js").SandboxTokenStore | null;
	groupPolicyStore: ToolGroupPolicyStore | null;
	configCascade: ConfigCascade | null;
	costTracker: CostTracker;
	store: SessionStore;
	searchIndex: SearchIndex;
	sessions: Map<string, SessionInfo>;
	assemblePrompt: (id: string, parts: PromptParts) => string | undefined;
	buildToolRestrictionsText: (tools: string[], role?: { toolPolicies?: Record<string, GrantPolicy> }) => string;
	applySandboxWiring: (opts: RpcBridgeOptions, id: string, sandboxOpts?: { projectId?: string; goalId?: string; sandboxBranch?: string; sandboxBaseBranch?: string }) => Promise<boolean>;
	handleAgentLifecycle: (session: SessionInfo, event: any) => void;
	trackCostFromEvent: (session: SessionInfo, event: any) => void;
	broadcast: (clients: Set<WebSocket>, msg: ServerMessage) => void;
	tryAutoSelectModel: (session: SessionInfo) => Promise<void>;
	tryApplyDefaultThinkingLevel: (session: SessionInfo) => Promise<void>;
	buildWorkflowList: () => string;
}

// ── Retry helper ───────────────────────────────────────────────────────────

export async function withRetry<T>(
	fn: () => Promise<T>,
	opts: { retries: number; delays: number[]; label: string; sessionId: string },
): Promise<T> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= opts.retries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err as Error;
			if (attempt < opts.retries) {
				const delay = opts.delays[attempt] ?? opts.delays[opts.delays.length - 1];
				console.warn(
					`[session-setup] ${opts.label} failed for ${opts.sessionId} (attempt ${attempt + 1}/${opts.retries + 1}), ` +
					`retrying in ${delay}ms: ${lastError.message}`,
				);
				await new Promise(resolve => setTimeout(resolve, delay));
			}
		}
	}
	throw lastError!;
}

// ── Pipeline steps ─────────────────────────────────────────────────────────

/** Step 1: Construct RpcBridgeOptions base (cliPath, env, args). */
export function resolveBridgeOptions(plan: SessionSetupPlan, ctx: PipelineContext): void {
	plan.bridgeOptions = {
		cwd: plan.cwd,
		args: plan.agentArgs ? [...plan.agentArgs] : [],
		env: { BOBBIT_SESSION_ID: plan.id, ...plan.env },
	};
	if (ctx.agentCliPath) {
		plan.bridgeOptions.cliPath = ctx.agentCliPath;
	}

	// Delegate-specific env
	if (plan.delegateOf) {
		plan.bridgeOptions.env = {
			...plan.bridgeOptions.env,
			BOBBIT_DELEGATE_OF: plan.delegateOf,
		};
	}
}

/** Step 2: Add goal/team extension paths to bridge args. */
export function resolveGoalExtensions(plan: SessionSetupPlan, _ctx: PipelineContext): void {
	if (plan.goalId && !plan.assistantType) {
		plan.bridgeOptions.args = plan.bridgeOptions.args || [];
		// Add goal tools extension (task + gate management) if not already present.
		// Check for the specific path — not just any "--extension" flag — because
		// team lead sessions already have --extension for the team tools extension.
		if (!plan.bridgeOptions.args.includes(GOAL_TOOLS_EXTENSION_PATH)) {
			plan.bridgeOptions.args.push("--extension", GOAL_TOOLS_EXTENSION_PATH);
		}
		plan.bridgeOptions.env = { ...plan.bridgeOptions.env, BOBBIT_GOAL_ID: plan.goalId };
	}

	// Add proposal tools extension for assistant sessions (goal assistant, role assistant, etc.)
	if (plan.assistantType) {
		plan.bridgeOptions.args = plan.bridgeOptions.args || [];
		if (!plan.bridgeOptions.args.includes(PROPOSAL_TOOLS_EXTENSION_PATH)) {
			plan.bridgeOptions.args.push("--extension", PROPOSAL_TOOLS_EXTENSION_PATH);
		}
	}
}

/** Step 3: Compute effectiveAllowedTools, filter host-only tools for sandbox. */
export function resolveTools(plan: SessionSetupPlan, ctx: PipelineContext): void {
	let effectiveAllowedTools = plan.effectiveAllowedTools;

	// Fall back to general role's allowed tools
	if ((!effectiveAllowedTools || effectiveAllowedTools.length === 0) && ctx.roleManager) {
		// Use cascade-resolved role when a projectId is available
		const roleName = plan.roleName || "general";
		let role = ctx.roleManager.getRole(roleName);
		if (plan.projectId && ctx.configCascade) {
			const resolved = ctx.configCascade.resolveRoles(plan.projectId);
			const match = resolved.find(r => r.item.name === roleName);
			if (match) role = match.item;
		}
		if (role && ctx.toolManager) {
			effectiveAllowedTools = computeEffectiveAllowedTools(
				ctx.toolManager, role, ctx.groupPolicyStore ?? undefined, ctx.mcpManager ?? undefined,
			);
		}
	}

	plan.effectiveAllowedTools = effectiveAllowedTools;
}

/** Look up a role by name, preferring the cascade-resolved version when available. */
function lookupRole(name: string, plan: SessionSetupPlan, ctx: PipelineContext): import("./role-store.js").Role | undefined {
	if (plan.projectId && ctx.configCascade) {
		const resolved = ctx.configCascade.resolveRoles(plan.projectId);
		const match = resolved.find(r => r.item.name === name);
		if (match) return match.item;
	}
	return ctx.roleManager?.getRole(name);
}

/** Step 4: Assemble system prompt (handles assistant, normal, delegate variants). */
export function resolvePrompt(plan: SessionSetupPlan, ctx: PipelineContext): void {
	const assistantDef = plan.assistantType ? getAssistantDef(plan.assistantType) : undefined;

	if (assistantDef) {
		// Assistant sessions (goal/role/tool assistants)
		const assistantRole = lookupRole("assistant", plan, ctx);
		let assistantGoalSpec = "";
		if (assistantRole?.promptTemplate) {
			assistantGoalSpec = assistantRole.promptTemplate.replace(
				/\{\{AGENT_ID\}\}/g,
				`assistant-${(plan.goalId || plan.id).slice(0, 8)}`,
			);
			assistantGoalSpec += "\n\n---\n\n";
		}
		assistantGoalSpec += assistantDef.prompt;
		if (plan.assistantType === "goal") {
			assistantGoalSpec = assistantGoalSpec.replace("{{AVAILABLE_WORKFLOWS}}", ctx.buildWorkflowList());
			if (plan.reattemptGoalId) {
				const origGoal = ctx.goalManager.getGoal(plan.reattemptGoalId);
				if (origGoal) {
					assistantGoalSpec += "\n\n" + buildReattemptContext(origGoal);
				}
			}
		}

		// Use assistant role's tool restrictions
		if (assistantRole && ctx.toolManager) {
			plan.effectiveAllowedTools = computeEffectiveAllowedTools(
				ctx.toolManager, assistantRole, ctx.groupPolicyStore ?? undefined, ctx.mcpManager ?? undefined,
			);
		}

		const promptPath = ctx.assemblePrompt(plan.id, {
			baseSystemPromptPath: undefined,
			cwd: plan.cwd,
			projectRoot: plan.repoPath,
			goalSpec: assistantGoalSpec,
			goalTitle: assistantDef.promptTitle,
			goalState: "active",
			allowedTools: plan.effectiveAllowedTools,
			projectConfigStore: ctx.projectConfigStore ?? undefined,
		});
		if (promptPath) plan.bridgeOptions.systemPromptPath = promptPath;
	} else if (plan.mode === "delegate") {
		// Delegate sessions: AGENTS.md only + task spec
		let taskSpec = plan.instructions || "";
		if (plan.context && Object.keys(plan.context).length > 0) {
			taskSpec += "\n\n## Context";
			for (const [key, value] of Object.entries(plan.context)) {
				taskSpec += `\n- **${key}**: ${value}`;
			}
		}

		const promptPath = ctx.assemblePrompt(plan.id, {
			baseSystemPromptPath: undefined,
			cwd: plan.cwd,
			projectRoot: plan.repoPath,
			goalSpec: taskSpec,
			goalTitle: "Delegate Task",
			goalState: "active",
			projectConfigStore: ctx.projectConfigStore ?? undefined,
		});
		if (promptPath) plan.bridgeOptions.systemPromptPath = promptPath;
	} else {
		// Normal / worktree sessions: global base + AGENTS.md + goal spec
		const goal = plan.goalId ? ctx.goalManager.getGoal(plan.goalId) : undefined;

		// Build tool restrictions text
		let toolRestrictionsText: string | undefined;
		if (plan.effectiveAllowedTools && plan.effectiveAllowedTools.length > 0) {
			const effectiveRole = plan.roleName ? lookupRole(plan.roleName, plan, ctx) : undefined;
			toolRestrictionsText = ctx.buildToolRestrictionsText(plan.effectiveAllowedTools, effectiveRole ?? undefined);
		}

		// Build task context
		let taskTitle: string | undefined;
		let taskType: string | undefined;
		let taskSpec: string | undefined;
		let taskDependsOn: string[] | undefined;
		if (plan.taskId) {
			const task = ctx.taskManager.getTask(plan.taskId);
			if (task) {
				taskTitle = task.title;
				taskType = task.type;
				taskSpec = task.spec;
				if (task.dependsOn && task.dependsOn.length > 0) {
					taskDependsOn = task.dependsOn.map(depId => {
						const dep = ctx.taskManager.getTask(depId);
						return dep?.title || depId;
					});
				}
			}
		}

		const promptPath = ctx.assemblePrompt(plan.id, {
			baseSystemPromptPath: ctx.systemPromptPath,
			cwd: plan.cwd,
			projectRoot: plan.repoPath,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec: goal?.spec,
			rolePrompt: plan.rolePrompt,
			roleName: plan.roleName,
			toolRestrictions: toolRestrictionsText,
			taskTitle,
			taskType,
			taskSpec,
			taskDependsOn,
			personalities: plan.personalityFragments,
			allowedTools: plan.effectiveAllowedTools,
			workflowContext: plan.workflowContext,
			projectConfigStore: ctx.projectConfigStore ?? undefined,
		});
		if (promptPath) plan.bridgeOptions.systemPromptPath = promptPath;
	}
}

/** Step 5: computeToolActivationArgs + writeMcpProxyExtensions + writeToolGuardExtension. */
export function resolveToolActivation(plan: SessionSetupPlan, ctx: PipelineContext): void {
	if (plan.effectiveAllowedTools && plan.effectiveAllowedTools.length > 0) {
		const effectiveRole = (plan.roleName && ctx.roleManager) ? ctx.roleManager.getRole(plan.roleName) : undefined;
		const mcpExtPaths = ctx.mcpManager
			? writeMcpProxyExtensions(ctx.mcpManager, plan.effectiveAllowedTools, effectiveRole ?? undefined, ctx.toolManager ?? undefined, ctx.groupPolicyStore ?? undefined)
			: undefined;

		const activation = computeToolActivationArgs(plan.effectiveAllowedTools, ctx.toolManager ?? undefined, plan.cwd, mcpExtPaths);

		plan.bridgeOptions.args = [...activation.args, ...(plan.bridgeOptions.args || [])];

		// Generate and add the tool_call guard extension if any tools have 'ask' policy
		const guardPath = ctx.toolManager ? writeToolGuardExtension(
			plan.id,
			ctx.toolManager,
			ctx.mcpManager ?? undefined,
			effectiveRole ?? undefined,
			ctx.groupPolicyStore ?? undefined,
			[],
		) : undefined;
		if (guardPath) {
			plan.bridgeOptions.args.push("--extension", guardPath);
		}
	} else if (ctx.mcpManager) {
		const mcpExtPaths = writeMcpProxyExtensions(ctx.mcpManager);
		for (const extPath of mcpExtPaths) {
			plan.bridgeOptions.args = [...(plan.bridgeOptions.args || []), "--extension", extPath];
		}
	}
}

// ── Event subscription ─────────────────────────────────────────────────────

/** Shared event subscription, returns unsubscribe fn. */
export function subscribeToEvents(session: SessionInfo, ctx: PipelineContext): () => void {
	return session.rpcClient.onEvent((event: any) => {
		session.lastActivity = Date.now();
		ctx.store.update(session.id, { lastActivity: session.lastActivity });
		ctx.handleAgentLifecycle(session, event);
		session.eventBuffer.push(event);
		ctx.broadcast(session.clients, { type: "event", data: event });
		ctx.trackCostFromEvent(session, event);
	});
}

// ── Persistence ────────────────────────────────────────────────────────────

/** Single store.put() with ALL structural fields. Called exactly once per session. */
export function persistOnce(session: SessionInfo, plan: SessionSetupPlan, store: SessionStore): void {
	store.put({
		id: session.id,
		title: session.title,
		cwd: session.cwd,
		agentSessionFile: "",
		createdAt: session.createdAt,
		lastActivity: session.lastActivity,
		goalId: plan.goalId,
		assistantType: plan.assistantType,
		role: plan.role,
		worktreePath: plan.worktreePath,
		repoPath: plan.repoPath,
		branch: plan.branch,
		taskId: plan.taskId,
		staffId: plan.staffId,
		accessory: plan.accessory,
		nonInteractive: plan.nonInteractive,
		personalities: plan.personalities,
		sandboxed: plan.sandboxed,
		delegateOf: plan.delegateOf,
		reattemptGoalId: plan.reattemptGoalId,
		projectId: plan.projectId,
	});
}

// ── Executors ──────────────────────────────────────────────────────────────

/**
 * Run the full pipeline synchronously: resolve steps → spawn agent → persist → post-spawn.
 * Used by normal and delegate session creation.
 */
export async function executePlan(plan: SessionSetupPlan, ctx: PipelineContext): Promise<SessionInfo> {
	// Step 1-5: resolve all configuration
	resolveBridgeOptions(plan, ctx);
	resolveGoalExtensions(plan, ctx);
	resolveTools(plan, ctx);
	resolvePrompt(plan, ctx);
	resolveToolActivation(plan, ctx);

	// Step 6: sandbox wiring (needs final CWD)
	if (plan.sandboxed) {
		const preSandboxCwd = plan.bridgeOptions.cwd;
		await withRetry(
			() => ctx.applySandboxWiring(plan.bridgeOptions, plan.id, { projectId: plan.projectId, goalId: plan.goalId, sandboxBranch: plan.sandboxBranch, sandboxBaseBranch: plan.sandboxBaseBranch }),
			{ retries: 1, delays: [1000], label: "wireSandbox", sessionId: plan.id },
		).then(applied => {
			if (!applied) throw new Error("Sandbox is not configured as docker");
		});

		// Sandbox wiring may remap CWD to a container-internal path (e.g. /workspace-wt/<branch>).
		// Re-assemble the prompt so the Working Directory section matches the actual --cwd.
		if (plan.bridgeOptions.cwd && plan.bridgeOptions.cwd !== preSandboxCwd) {
			plan.cwd = plan.bridgeOptions.cwd;
			resolvePrompt(plan, ctx);
		}
	}

	// Step 7: persist BEFORE spawning — if the spawn fails (e.g. Docker ENOENT),
	// the session metadata is still saved so the user doesn't lose the session.
	// The agentSessionFile is empty until spawnAgent populates it.
	const preSpawnSession = {
		id: plan.id, title: plan.title || "New session",
		cwd: plan.bridgeOptions.cwd || plan.cwd, createdAt: Date.now(),
		sandboxed: plan.sandboxed, projectId: plan.projectId,
	} as any;
	persistOnce(preSpawnSession, plan, ctx.store);

	// Step 8: spawn agent
	const session = await spawnAgent(plan, ctx);

	// Step 9: update persistence with full session data (agentSessionFile, etc.)
	persistOnce(session, plan, ctx.store);

	// Step 10: post-spawn setup (model, thinking level)
	await postSpawn(session, plan, ctx);

	return session;
}

/**
 * For worktree sessions: create worktree, then run remaining pipeline
 * on the existing "preparing" session. Updates session in place.
 */
export async function executeWorktreeAsync(
	plan: SessionSetupPlan,
	session: SessionInfo,
	ctx: PipelineContext,
	preBuiltWorktreePath?: string,
): Promise<void> {
	// Use pre-built worktree from pool, or create one from scratch
	let worktreeCwd: string;
	if (preBuiltWorktreePath) {
		worktreeCwd = preBuiltWorktreePath;
		console.log(`[session-setup] Using pre-built worktree for session ${session.id}: ${worktreeCwd}`);
	} else {
		worktreeCwd = await withRetry(
			async () => {
				const result = await createWorktree(plan.repoPath!, plan.branch!);
				return result.worktreePath;
			},
			{ retries: 2, delays: [1000, 2000], label: "createWorktree", sessionId: plan.id },
		);
	}

	// For sandboxed sessions, set sandboxBranch so applySandboxWiring() creates
	// the worktree inside the container (via ProjectSandbox.createWorktree).
	// The host worktree is still kept for server-side bookkeeping (worktreePath).
	if (plan.sandboxed && !plan.sandboxBranch && plan.branch) {
		plan.sandboxBranch = plan.branch;
		// No baseBranch for regular sessions — they branch from HEAD
	}

	// Apply subdirectory offset: if the session's original CWD (project rootPath) is a
	// subdirectory of the repo, offset the working directory within the worktree.
	const originalCwd = plan.cwd;
	const relativeOffset = plan.repoPath ? path.relative(plan.repoPath, originalCwd) : "";
	const offsetCwd = relativeOffset && relativeOffset !== "."
		? path.join(worktreeCwd, relativeOffset)
		: worktreeCwd;

	// Update session and plan with worktree CWD (offset applied)
	session.cwd = offsetCwd;
	session.worktreePath = worktreeCwd;
	plan.cwd = offsetCwd;
	ctx.store.update(session.id, { cwd: offsetCwd, worktreePath: worktreeCwd });
	console.log(`[session-setup] Worktree ready for session ${session.id}: ${worktreeCwd} (branch: ${plan.branch})`);

	// Run remaining pipeline steps on the worktree CWD
	resolveBridgeOptions(plan, ctx);
	resolveGoalExtensions(plan, ctx);
	resolveTools(plan, ctx);
	resolvePrompt(plan, ctx);
	resolveToolActivation(plan, ctx);

	// Sandbox wiring (now with final CWD from worktree)
	if (plan.sandboxed) {
		const preSandboxCwd = plan.bridgeOptions.cwd;
		await withRetry(
			() => ctx.applySandboxWiring(plan.bridgeOptions, plan.id, { projectId: plan.projectId, goalId: plan.goalId, sandboxBranch: plan.sandboxBranch, sandboxBaseBranch: plan.sandboxBaseBranch }),
			{ retries: 1, delays: [1000], label: "wireSandbox", sessionId: plan.id },
		).then(applied => {
			if (!applied) throw new Error("Sandbox is not configured as docker");
		});

		// Sandbox wiring may remap CWD to a container-internal path.
		// Update session.cwd so git-status and other host-side operations use the
		// container-internal path (via docker exec -w <cwd>), and re-assemble the
		// prompt so the Working Directory section matches the actual --cwd.
		if (plan.bridgeOptions.cwd && plan.bridgeOptions.cwd !== preSandboxCwd) {
			plan.cwd = plan.bridgeOptions.cwd;
			session.cwd = plan.bridgeOptions.cwd;
			ctx.store.update(session.id, { cwd: session.cwd });
			resolvePrompt(plan, ctx);
		}
	}

	// After sandbox wiring — reconcile persisted branch with actual container branch.
	// For team-spawned sandboxed sessions, plan.sandboxBranch differs from plan.branch
	// (host auto-generates session/new-session-<uuid8>, team manager sets goal-<slug>-<role>-<id>).
	if (plan.sandboxed && plan.sandboxBranch && plan.sandboxBranch !== plan.branch) {
		plan.branch = plan.sandboxBranch;
		ctx.store.update(session.id, { branch: plan.branch });
		console.log(`[session-setup] Reconciled branch for sandbox session ${session.id}: ${plan.branch}`);
	}

	// Create real RpcBridge (replacing placeholder)
	const rpcClient = new RpcBridge(plan.bridgeOptions);
	session.rpcClient = rpcClient;
	session.allowedTools = plan.effectiveAllowedTools;

	// Store container ID from project sandbox
	if (plan.bridgeOptions.containerId) {
		session.containerId = plan.bridgeOptions.containerId;
	}

	// Mark session as sandboxed
	if (plan.sandboxed) {
		session.sandboxed = true;
	}

	// If sandbox pool overrode CWD, update session
	if (plan.bridgeOptions.cwd && plan.bridgeOptions.cwd !== plan.cwd) {
		session.cwd = plan.bridgeOptions.cwd;
		ctx.store.update(session.id, { cwd: session.cwd });
	}

	// Task assignment
	if (plan.taskId) {
		try {
			ctx.taskManager.assignTask(plan.taskId, plan.id);
		} catch (err) {
			console.error(`[session-setup] Failed to assign task ${plan.taskId} to session ${plan.id}:`, err);
		}
	}

	// Subscribe to events
	session.unsubscribe = subscribeToEvents(session, ctx);

	// Start agent with retry
	await withRetry(
		() => rpcClient.start(),
		{ retries: 2, delays: [500, 1000], label: "rpcClient.start", sessionId: plan.id },
	);
	session.status = "idle";

	// Notify connected clients that the session is ready
	ctx.broadcast(session.clients, { type: "session_status", status: "idle" });

	// Fire model + thinking level immediately (non-blocking)
	postSpawnFireAndForget(session, plan, ctx);
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Create RpcBridge, subscribe events, start the agent process.
 * Returns the fully wired SessionInfo.
 */
async function spawnAgent(plan: SessionSetupPlan, ctx: PipelineContext): Promise<SessionInfo> {
	const rpcClient = new RpcBridge(plan.bridgeOptions);
	const eventBuffer = new EventBuffer();
	const now = Date.now();

	// If sandbox pool overrode CWD, use that
	const effectiveCwd = plan.bridgeOptions.cwd || plan.cwd;

	const assistantDef = plan.assistantType ? getAssistantDef(plan.assistantType) : undefined;

	const session: SessionInfo = {
		id: plan.id,
		title: assistantDef?.title ?? (plan.mode === "delegate"
			? `⚡${plan.title}`
			: plan.title),
		cwd: effectiveCwd,
		status: "starting",
		createdAt: now,
		lastActivity: now,
		clients: new Set(),
		rpcClient,
		eventBuffer,
		unsubscribe: () => {},
		isCompacting: false,
		titleGenerated: !!assistantDef || plan.mode === "delegate",
		goalId: plan.goalId,
		assistantType: plan.assistantType,
		taskId: plan.taskId,
		delegateOf: plan.delegateOf,
		personalities: plan.personalities,
		allowedTools: plan.effectiveAllowedTools,
		role: plan.role,
		accessory: plan.accessory,
		promptQueue: new PromptQueue(),
	};

	// Mark session as sandboxed (typed field)
	if (plan.sandboxed) {
		session.sandboxed = true;
	}

	// Store container ID from project sandbox
	if (plan.bridgeOptions.containerId) {
		session.containerId = plan.bridgeOptions.containerId;
	}

	// Task assignment
	if (plan.taskId) {
		try {
			ctx.taskManager.assignTask(plan.taskId, plan.id);
		} catch (err) {
			console.error(`[session-setup] Failed to assign task ${plan.taskId} to session ${plan.id}:`, err);
		}
	}

	// Subscribe to events
	session.unsubscribe = subscribeToEvents(session, ctx);

	// Start agent with retry
	await withRetry(
		() => rpcClient.start(),
		{ retries: 2, delays: [500, 1000], label: "rpcClient.start", sessionId: plan.id },
	);
	session.status = "idle";

	ctx.sessions.set(session.id, session);

	return session;
}

/**
 * Post-spawn setup for synchronous paths (normal, delegate):
 * fire-and-forget metadata persist + model/thinking level.
 */
async function postSpawn(session: SessionInfo, plan: SessionSetupPlan, ctx: PipelineContext): Promise<void> {
	// For delegates, model + thinking level are awaited (delegate needs model before prompt)
	if (plan.mode === "delegate") {
		const tasks: Promise<void>[] = [];
		if (!plan.skipAutoModel) tasks.push(ctx.tryAutoSelectModel(session));
		if (!plan.skipAutoThinking) tasks.push(ctx.tryApplyDefaultThinkingLevel(session));
		await Promise.all(tasks);
	} else {
		// Normal sessions: fire-and-forget
		postSpawnFireAndForget(session, plan, ctx);
	}
}

/** Fire model + thinking level setup as non-blocking (fire-and-forget). */
function postSpawnFireAndForget(session: SessionInfo, plan: SessionSetupPlan, ctx: PipelineContext): void {
	if (!plan.skipAutoModel) {
		ctx.tryAutoSelectModel(session).catch((err) => {
			console.warn(`[session-setup] Early model selection failed for ${session.id}:`, err);
		});
	}
	if (!plan.skipAutoThinking) {
		ctx.tryApplyDefaultThinkingLevel(session).catch((err) => {
			console.warn(`[session-setup] Early thinking level failed for ${session.id}:`, err);
		});
	}
}

// ── Delegate prompt ────────────────────────────────────────────────────────

/**
 * Send the task prompt to a delegate session and wait for streaming to begin.
 * Enforces a timeout — rejects if the agent doesn't start streaming in time.
 */
export async function sendDelegatePrompt(
	session: SessionInfo,
	_instructions: string,
	timeoutMs: number,
): Promise<void> {
	await session.rpcClient.prompt(
		"Execute the task described in your system prompt. Follow the instructions carefully.",
	);

	// Wait for agent_start event (session.status becomes "streaming")
	await new Promise<void>((resolve, reject) => {
		if (session.status === "streaming") { resolve(); return; }
		const timeout = setTimeout(() => {
			unsub();
			reject(new Error(
				`Delegate session ${session.id} did not start streaming within ${timeoutMs}ms. ` +
				`The delegate may have failed to initialize.`,
			));
		}, timeoutMs);
		const unsub = session.rpcClient.onEvent((event: any) => {
			if (event.type === "agent_start") {
				clearTimeout(timeout);
				unsub();
				resolve();
			}
		});
	});
}

// ── Failure handling ───────────────────────────────────────────────────────

/**
 * Clean up after a failed session setup. Order:
 * 1. Remove from in-memory map (fast — UI updates immediately)
 * 2. Archive in store (preserves evidence for debugging)
 * 3. Notify connected clients
 * 4. Background worktree cleanup (slow, non-blocking)
 * 5. Release sandbox pool slot if claimed
 * 6. Clean up sandbox token
 */
export function handleSetupFailure(
	session: SessionInfo,
	plan: SessionSetupPlan,
	error: Error,
	ctx: PipelineContext,
): void {
	console.error(
		`[session-setup] Session ${session.id} setup failed ` +
		`(mode: ${plan.mode}, step: ${error.message}):`,
		error,
	);

	// 1. Remove from in-memory map
	ctx.sessions.delete(session.id);

	// 2. Archive in store (preserves evidence)
	ctx.store.archive(session.id);

	// 3. Notify connected clients
	ctx.broadcast(session.clients, { type: "session_status", status: "terminated" });

	// 4. Background worktree cleanup (slow, non-blocking)
	if (plan.worktreePath && plan.repoPath && plan.branch) {
		cleanupWorktree(plan.repoPath, plan.worktreePath, plan.branch, true).catch(() => {});
	}

	// 5. Clean up sandbox token for this session
	if (ctx.sandboxTokenStore && plan.projectId) {
		ctx.sandboxTokenStore.removeSession(plan.projectId, session.id);
	}
}
