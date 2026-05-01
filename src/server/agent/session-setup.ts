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
import { emitSessionEvent } from "./session-manager.js";
import type { RpcBridgeOptions } from "./rpc-bridge.js";
import { RpcBridge } from "./rpc-bridge.js";
import { EventBuffer } from "./event-buffer.js";
import { PromptQueue } from "./prompt-queue.js";
import type { SessionStore } from "./session-store.js";
import type { GoalManager } from "./goal-manager.js";
import type { TaskManager } from "./task-manager.js";
import type { SearchService } from "../search/search-service.js";
import type { CostTracker } from "./cost-tracker.js";
import type { RoleManager } from "./role-manager.js";
import type { ToolManager } from "./tool-manager.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { SandboxManager } from "./sandbox-manager.js";
import type { PromptParts } from "./system-prompt.js";

import type { ConfigCascade } from "./config-cascade.js";
import { getAssistantDef } from "./assistant-registry.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { computeToolActivationArgs, writeMcpProxyExtensions, writeToolGuardExtension, computeEffectiveAllowedTools } from "./tool-activation.js";
import { createWorktree, cleanupWorktree } from "../skills/git.js";

import { TOOLS_DIR } from "./tool-manager.js";
import { profile, profileAsync, recordElapsed } from "./profiling.js";
import { truncateLargeToolContent } from "./truncate-large-content.js";

// ── Extension path helpers ─────────────────────────────────────────────────

/** Resolve goal tools extension path via the cascade (lazy, not module-level). */
function resolveGoalToolsExtPath(ctx: PipelineContext): string {
	if (ctx.toolManager) return ctx.toolManager.getExtensionPath("tasks", "extension.ts");
	// Fallback: use deprecated TOOLS_DIR for backward compat
	return path.join(TOOLS_DIR, "tasks", "extension.ts");
}

/** Resolve proposal tools extension path via the cascade (lazy, not module-level). */
function resolveProposalToolsExtPath(ctx: PipelineContext): string {
	if (ctx.toolManager) return ctx.toolManager.getExtensionPath("proposals", "extension.ts");
	return path.join(TOOLS_DIR, "proposals", "extension.ts");
}

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

	/**
	 * Continue-Archived: a `.jsonl` path that has already been cloned from the
	 * source archived session. When set, `spawnAgent` issues a `switch_session`
	 * RPC against this path immediately after `rpcClient.start()` so the agent
	 * CLI rehydrates from it (same mechanism `restoreSession` uses).
	 */
	preExistingAgentSessionFile?: string;
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
	projectConfigStore: import("./project-config-store.js").ProjectConfigStore | null;
	sandboxManager: SandboxManager | null;
	sandboxTokenStore: import("../auth/sandbox-token.js").SandboxTokenStore | null;
	groupPolicyStore: ToolGroupPolicyStore | null;
	configCascade: ConfigCascade | null;
	costTracker: CostTracker;
	store: SessionStore;
	searchIndex: SearchService;
	sessions: Map<string, SessionInfo>;
	assemblePrompt: (id: string, parts: PromptParts) => string | undefined;

	applySandboxWiring: (opts: RpcBridgeOptions, id: string, sandboxOpts?: { projectId?: string; goalId?: string; sandboxBranch?: string; sandboxBaseBranch?: string }) => Promise<boolean>;
	handleAgentLifecycle: (session: SessionInfo, event: any) => void;
	trackCostFromEvent: (session: SessionInfo, event: any) => void;
	broadcast: (clients: Set<WebSocket>, msg: ServerMessage) => void;
	tryAutoSelectModel: (session: SessionInfo) => Promise<void>;
	tryApplyDefaultThinkingLevel: (session: SessionInfo) => Promise<void>;
	buildWorkflowList: (projectId?: string) => string;
	/**
	 * Persist agentSessionFile + other live-state-derived fields. Optional —
	 * tests may construct a context without this; in that case a hard restart
	 * during the gap will lose the session, which is fine for unit tests.
	 */
	persistSessionMetadata?: (session: SessionInfo) => Promise<void>;
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
	return profile("resolveBridgeOptions", () => _resolveBridgeOptions(plan, ctx));
}
function _resolveBridgeOptions(plan: SessionSetupPlan, ctx: PipelineContext): void {
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

	// Wire tool manager for extension path resolution in RpcBridge
	if (ctx.toolManager) {
		plan.bridgeOptions.toolManager = ctx.toolManager;
	}
}

/** Step 2: Add goal/team extension paths to bridge args. */
export function resolveGoalExtensions(plan: SessionSetupPlan, ctx: PipelineContext): void {
	return profile("resolveGoalExtensions", () => _resolveGoalExtensions(plan, ctx));
}
function _resolveGoalExtensions(plan: SessionSetupPlan, ctx: PipelineContext): void {
	if (plan.goalId && !plan.assistantType) {
		plan.bridgeOptions.args = plan.bridgeOptions.args || [];
		// Add goal tools extension (task + gate management) if not already present.
		const goalExtPath = resolveGoalToolsExtPath(ctx);
		if (!plan.bridgeOptions.args.includes(goalExtPath)) {
			plan.bridgeOptions.args.push("--extension", goalExtPath);
		}
		plan.bridgeOptions.env = { ...plan.bridgeOptions.env, BOBBIT_GOAL_ID: plan.goalId };
	}

	// Add proposal tools extension for assistant sessions (goal assistant, role assistant, etc.)
	if (plan.assistantType) {
		plan.bridgeOptions.args = plan.bridgeOptions.args || [];
		const proposalExtPath = resolveProposalToolsExtPath(ctx);
		if (!plan.bridgeOptions.args.includes(proposalExtPath)) {
			plan.bridgeOptions.args.push("--extension", proposalExtPath);
		}
	}
}

/** Step 3: Compute effectiveAllowedTools, filter host-only tools for sandbox. */
export function resolveTools(plan: SessionSetupPlan, ctx: PipelineContext): void {
	return profile("resolveTools", () => _resolveTools(plan, ctx));
}
function _resolveTools(plan: SessionSetupPlan, ctx: PipelineContext): void {
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
	return profile("resolvePrompt", () => _resolvePrompt(plan, ctx));
}

function _resolvePrompt(plan: SessionSetupPlan, ctx: PipelineContext): void {
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
			assistantGoalSpec = assistantGoalSpec.replace("{{AVAILABLE_WORKFLOWS}}", ctx.buildWorkflowList(plan.projectId));
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

		// Nested-goal awareness: only emitted for team-lead sessions (design §14.1).
		// Other roles (coder/reviewer/...) never spawn children and don't need the
		// stanzas. The mid-goal stanza fires for every team-lead; the top-level OR
		// child stanza fires based on `parentGoalId`.
		const isTeamLead = plan.roleName === "team-lead";
		let parentGoalCtx: { id: string; title: string; branch: string; specExcerpt: string; rootTitle: string } | undefined;
		let isTopLevelTeamLead = false;
		let divergencePolicy: "strict" | "balanced" | "autonomous" | undefined;
		let maxConcurrentChildren: number | undefined;
		let goalWorkflowId: string | undefined;
		if (isTeamLead && goal) {
			goalWorkflowId = goal.workflowId;
			divergencePolicy = ctx.goalManager.resolveDivergencePolicy(goal.id);
			const rootId = goal.rootGoalId ?? goal.id;
			maxConcurrentChildren = ctx.goalManager.resolveRootMaxConcurrentChildren(rootId);

			if (goal.parentGoalId) {
				const parent = ctx.goalManager.getGoal(goal.parentGoalId);
				const rootGoal = ctx.goalManager.getGoal(rootId);
				if (parent) {
					const rawSpec = parent.spec || "";
					parentGoalCtx = {
						id: parent.id,
						title: parent.title,
						branch: parent.branch || "unknown",
						specExcerpt: rawSpec.slice(0, 800),
						rootTitle: rootGoal?.title ?? parent.title,
					};
				}
			} else {
				isTopLevelTeamLead = true;
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
			taskTitle,
			taskType,
			taskSpec,
			taskDependsOn,
			allowedTools: plan.effectiveAllowedTools,
			workflowContext: plan.workflowContext,
			projectConfigStore: ctx.projectConfigStore ?? undefined,
			isTeamLead,
			isTopLevelTeamLead,
			parentGoal: parentGoalCtx,
			divergencePolicy,
			maxConcurrentChildren,
			goalWorkflowId,
		});
		if (promptPath) plan.bridgeOptions.systemPromptPath = promptPath;
	}
}

/**
 * Step 5: computeToolActivationArgs + writeMcpProxyExtensions + writeToolGuardExtension.
 *
 * Tool surface is selected by three intersecting paths, all funneled through
 * `effectiveRole` and the policy cascade in `tool-activation.ts`:
 *
 *   1. **Role-with-policy**: `plan.roleName` resolves to a registered role;
 *      its `toolPolicies` (allow/ask/never per group) override builtin
 *      defaults. MCP proxy + guard extensions are emitted as needed.
 *   2. **Team-lead / role-less**: `plan.roleName` is unset (regular sessions,
 *      goal team-lead, goal/project/tool assistants). `effectiveRole` is
 *      `undefined` and the cascade falls back to `groupPolicyStore` defaults
 *      (which themselves fall back to builtin defaults). The full tool
 *      surface allowed for the user is exposed.
 *   3. **MCP-only**: when `mcpManager` is present, MCP-proxy extensions are
 *      written regardless of role so MCP servers stay reachable; per-server
 *      policies still apply.
 *
 * The guard extension is emitted whenever any tool resolves to `ask` or
 * `never` so the agent can't bypass the policy by calling the tool directly.
 */
export function resolveToolActivation(plan: SessionSetupPlan, ctx: PipelineContext): void {
	return profile("resolveToolActivation", () => _resolveToolActivation(plan, ctx));
}
function _resolveToolActivation(plan: SessionSetupPlan, ctx: PipelineContext): void {
	const effectiveRole = (plan.roleName && ctx.roleManager) ? ctx.roleManager.getRole(plan.roleName) : undefined;
	const mcpExtPaths = ctx.mcpManager
		? writeMcpProxyExtensions(ctx.mcpManager, plan.effectiveAllowedTools, effectiveRole ?? undefined, ctx.toolManager ?? undefined, ctx.groupPolicyStore ?? undefined)
		: undefined;

	const activation = computeToolActivationArgs(plan.effectiveAllowedTools, ctx.toolManager ?? undefined, plan.cwd, mcpExtPaths);

	plan.bridgeOptions.args = [...activation.args, ...(plan.bridgeOptions.args || [])];

	// Generate and add the tool_call guard extension if any tools have 'ask' or 'never' policy.
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
}

// ── Event subscription ─────────────────────────────────────────────────────

/** Shared event subscription, returns unsubscribe fn. */
export function subscribeToEvents(session: SessionInfo, ctx: PipelineContext): () => void {
	return session.rpcClient.onEvent((event: any) => {
		session.lastActivity = Date.now();
		ctx.store.update(session.id, { lastActivity: session.lastActivity });
		ctx.handleAgentLifecycle(session, event);
		const truncated = truncateLargeToolContent(event);
		emitSessionEvent(session, truncated);
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
		// Continue-Archived: when the cloned JSONL path is known up front, persist
		// it so a hard kill before spawn doesn't lose the cloned transcript.
		// Otherwise the agent CLI populates this field via persistSessionMetadata.
		agentSessionFile: plan.preExistingAgentSessionFile || "",
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
	const __t0 = performance.now();
	// Step 1-5: resolve all configuration
	resolveBridgeOptions(plan, ctx);
	resolveGoalExtensions(plan, ctx);
	resolveTools(plan, ctx);
	resolvePrompt(plan, ctx);
	resolveToolActivation(plan, ctx);
	recordElapsed("executePlan.resolveConfig", performance.now() - __t0);

	// Step 6: sandbox wiring (needs final CWD)
	if (plan.sandboxed) {
		// Lazy per-project sandbox init (idempotent; deduped by SandboxManager).
		if (ctx.sandboxManager && plan.projectId) {
			await ctx.sandboxManager.ensureForProject(plan.projectId);
		}
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
	const session = await profileAsync("executePlan.spawnAgent", () => spawnAgent(plan, ctx));

	// Step 9: update persistence with full session data (agentSessionFile, etc.)
	persistOnce(session, plan, ctx.store);

	// Step 10: post-spawn setup (model, thinking level)
	await profileAsync("executePlan.postSpawn", () => postSpawn(session, plan, ctx));

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
		// Multi-repo session creation goes through the worktree pool / sandbox
		// path; this fallback handles the single-repo non-sandboxed path.
		worktreeCwd = await withRetry(
			async () => {
				const result = await createWorktree(plan.repoPath!, plan.branch!);
				return result.worktreePath;
			},
			{ retries: 2, delays: [1000, 2000], label: "createWorktree", sessionId: plan.id },
		);

		// Per-component setup — non-fatal on failure. Routes through the canonical
		// resolver so component.relativePath is honored.
		const components = ctx.projectConfigStore?.getComponents() ?? [];
		if (components.length > 0) {
			try {
				const { runComponentSetups } = await import("../skills/worktree-setup.js");
				const { execFile } = await import("node:child_process");
				const { promisify } = await import("node:util");
				const pExecFile = promisify(execFile);
				await runComponentSetups({
					components,
					branchContainer: worktreeCwd,
					primaryWorktreeRoot: plan.repoPath!,
					exec: async (cmd, cwd, env) => {
						await pExecFile("sh", ["-c", cmd], { cwd, env, timeout: 120_000 });
					},
				});
			} catch (err) {
				console.warn(`[session-setup] runComponentSetups failed for session ${session.id} (non-fatal):`, err);
			}
		}
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
		// Lazy per-project sandbox init (idempotent; deduped by SandboxManager).
		if (ctx.sandboxManager && plan.projectId) {
			await ctx.sandboxManager.ensureForProject(plan.projectId);
		}
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
	// (host auto-generates session/<uuid8>, team manager sets goal-<slug>-<role>-<id>).
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

	// Continue-Archived: rehydrate from the cloned JSONL before persisting.
	if (plan.preExistingAgentSessionFile) {
		// The continue handler pre-computes the cloned-.jsonl path against the
		// project-root cwd. For worktree-backed sessions, the agent CLI boots
		// with cwd=offsetCwd (the worktree path), and `formatAgentSessionFilePath`
		// embeds a slug derived from cwd in the path. So the clone is currently
		// stranded under the project-root slug-dir. Rebase it onto the agent's
		// actual cwd-slug before issuing switch_session.
		const { formatAgentSessionFilePath } = await import("./agent-session-path.js");
		const correctPath = formatAgentSessionFilePath(plan.cwd, Date.now(), session.id);
		if (correctPath !== plan.preExistingAgentSessionFile) {
			const { sessionFileCopy, sessionFileDelete } = await import("./session-fs.js");
			const fsCtx = { sandboxed: !!plan.sandboxed, projectId: plan.projectId };
			if (plan.sandboxed) {
				// Container-side: copy via docker exec then delete the old file.
				await sessionFileCopy(fsCtx, plan.preExistingAgentSessionFile, fsCtx, correctPath, ctx.sandboxManager);
				await sessionFileDelete(fsCtx, plan.preExistingAgentSessionFile, ctx.sandboxManager).catch(() => {});
			} else {
				// Host-side: prefer rename, fall back to copy+unlink for cross-device.
				const fsp = await import("node:fs/promises");
				await fsp.mkdir(path.dirname(correctPath), { recursive: true });
				try {
					await fsp.rename(plan.preExistingAgentSessionFile, correctPath);
				} catch (err) {
					await fsp.copyFile(plan.preExistingAgentSessionFile, correctPath);
					await fsp.unlink(plan.preExistingAgentSessionFile).catch(() => {});
				}
			}
			plan.preExistingAgentSessionFile = correctPath;
			ctx.store.update(session.id, { agentSessionFile: correctPath });
		}

		const switchTimeout = plan.sandboxed ? 60_000 : 15_000;
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: plan.preExistingAgentSessionFile },
			switchTimeout,
		);
		if (!switchResp.success) {
			await rpcClient.stop().catch(() => {});
			throw new Error(`switch_session failed: ${switchResp.error}`);
		}
	}

	// Persist agentSessionFile to disk BEFORE flipping status to idle. Otherwise
	// a kill (crash, taskkill, OS shutdown) in the gap between idle and the
	// post-spawn fire-and-forget persist archives the session on next boot,
	// because restoreOneSession() refuses to restore a session whose persisted
	// agentSessionFile is empty. See tests/manual-integration/restart-minimal.spec.ts.
	if (ctx.persistSessionMetadata) {
		try { await ctx.persistSessionMetadata(session); }
		catch (err) { console.warn(`[session-setup] persistSessionMetadata pre-idle failed for ${session.id}:`, err); }
	}

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
	const __t = performance.now();
	await withRetry(
		() => rpcClient.start(),
		{ retries: 2, delays: [500, 1000], label: "rpcClient.start", sessionId: plan.id },
	);
	recordElapsed("spawnAgent.rpcStart", performance.now() - __t);

	// Continue-Archived: tell the agent CLI to rehydrate from the cloned JSONL
	// before we persist or flip to idle. Same RPC the restart-resume path uses.
	if (plan.preExistingAgentSessionFile) {
		const switchTimeout = plan.sandboxed ? 60_000 : 15_000;
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: plan.preExistingAgentSessionFile },
			switchTimeout,
		);
		if (!switchResp.success) {
			await rpcClient.stop().catch(() => {});
			throw new Error(`switch_session failed: ${switchResp.error}`);
		}
	}

	// Add to live-sessions map so persistSessionMetadata can resolve via getState.
	ctx.sessions.set(session.id, session);

	// Persist agentSessionFile BEFORE flipping status to idle so the session
	// survives a hard kill in the post-spawn window. See worktree path for
	// the full rationale.
	if (ctx.persistSessionMetadata) {
		try { await ctx.persistSessionMetadata(session); }
		catch (err) { console.warn(`[session-setup] persistSessionMetadata pre-idle failed for ${session.id}:`, err); }
	}

	session.status = "idle";

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
