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
import { emitSessionEvent, broadcastStatus } from "./session-manager.js";
import type { RpcBridgeOptions } from "./rpc-bridge.js";
import { RpcBridge } from "./rpc-bridge.js";
import { sanitizeAgentTranscriptFile } from "./transcript-sanitizer.js";
import { EventBuffer } from "./event-buffer.js";
import { PromptQueue } from "./prompt-queue.js";
import { applyPromptConditionals } from "./prompt-conditionals.js";
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
import type { PromptParts, NestingContext } from "./system-prompt.js";
import type { PrStatusStore } from "./pr-status-store.js";

import type { ConfigCascade } from "./config-cascade.js";
import { getAssistantDef } from "./assistant-registry.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { computeToolActivationArgs, writeMcpProxyExtensions, writeToolGuardExtension, computeEffectiveAllowedTools, type EffectiveTool } from "./tool-activation.js";
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

/**
 * Build a NestingContext from a goal for the team-lead system prompt. Walks
 * the parent chain (at most one hop for the parent, one hop for the root) to
 * resolve titles and branches.
 *
 * Returns `{ team: true, parent: undefined }` for a root team goal so Stanza A
 * renders, and `{ team: true, parent: {...} }` for a child team goal so
 * Stanza B fires its "DO NOT raise a PR / DO NOT spawn siblings" guardrail.
 * For non-team goals returns `{ team: false }` — `buildNestingContextSection`
 * short-circuits and no section renders.
 */
function buildNestingContext(
	goal: import("./goal-store.js").PersistedGoal,
	goalManager: GoalManager,
	subGoalsEnabled: boolean,
): NestingContext {
	const ctx: NestingContext = { team: !!goal.team, goalBranch: goal.branch, subGoalsEnabled };
	if (!goal.team) return ctx;
	if (goal.parentGoalId) {
		const parent = goalManager.getGoal(goal.parentGoalId);
		if (parent) {
			ctx.parent = { id: parent.id, title: parent.title, branch: parent.branch };
		}
	}
	const rootId = goal.rootGoalId;
	if (rootId && rootId !== goal.id) {
		const root = goalManager.getGoal(rootId);
		if (root) {
			ctx.root = { id: root.id, title: root.title, branch: root.branch };
		}
	}
	return ctx;
}

/** Delegate spawn timeout (30 seconds). */
export const DELEGATE_SPAWN_TIMEOUT_MS = 30_000;

export interface SandboxWiringOptions {
	projectId?: string;
	goalId?: string;
	sandboxBranch?: string;
	sandboxBaseBranch?: string;
	/** Repo/worktree-relative cwd offset to preserve after remapping into /workspace* paths. */
	sandboxCwdOffset?: string;
}

/** Normalize a host-derived cwd offset so it can be safely appended to a container path. */
export function normalizeSandboxCwdOffset(relativeOffset?: string | null): string | undefined {
	const raw = (relativeOffset ?? "").trim();
	if (!raw || raw === ".") return undefined;
	if (/^[a-zA-Z]:/.test(raw) || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) return undefined;
	const parts = raw.replace(/\\/g, "/").split("/");
	const safeParts: string[] = [];
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (part === "..") return undefined;
		safeParts.push(part);
	}
	return safeParts.length > 0 ? safeParts.join("/") : undefined;
}

/** Apply a safe repo/worktree-relative offset to a container base cwd. */
export function applySandboxCwdOffset(containerBaseCwd: string, relativeOffset?: string | null): string {
	const safeOffset = normalizeSandboxCwdOffset(relativeOffset);
	if (!safeOffset) return containerBaseCwd;
	const base = containerBaseCwd.replace(/\/+$/, "") || "/";
	return base === "/" ? `/${safeOffset}` : `${base}/${safeOffset}`;
}

/** Compute a safe relative cwd offset, returning undefined when cwd is outside root. */
export function relativeSandboxCwdOffset(rootPath?: string, cwd?: string): string | undefined {
	if (!rootPath || !cwd) return undefined;
	return normalizeSandboxCwdOffset(path.relative(rootPath, cwd));
}

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
	parentSessionId?: string;
	childKind?: string;
	readOnly?: boolean;
	/** Explicit session-scoped tool allowlist that must survive process restarts. */
	sessionScopedAllowedTools?: string[];
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
	effectiveAllowedTools?: EffectiveTool[];
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

	// Pin model/thinking-level at spawn time (verification sub-sessions use this).
	// Bypasses the role/preference resolver in resolveBridgeOptions.
	initialModel?: string;
	initialThinkingLevel?: string;

	// Sandbox worktree: branch to create inside the container
	sandboxBranch?: string;
	sandboxBaseBranch?: string;
	sandboxCwdOffset?: string;

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
	/** S1 — per-session capability secret store (see session-secret.ts). */
	sessionSecretStore: import("../auth/session-secret.js").SessionSecretStore;
	groupPolicyStore: ToolGroupPolicyStore | null;
	configCascade: ConfigCascade | null;
	costTracker: CostTracker;
	store: SessionStore;
	searchIndex: SearchService;
	sessions: Map<string, SessionInfo>;
	assemblePrompt: (id: string, parts: PromptParts) => string | undefined;

	applySandboxWiring: (opts: RpcBridgeOptions, id: string, sandboxOpts?: SandboxWiringOptions) => Promise<boolean>;
	handleAgentLifecycle: (session: SessionInfo, event: any) => void;
	trackCostFromEvent: (session: SessionInfo, event: any) => void;
	broadcast: (clients: Set<WebSocket>, msg: ServerMessage) => void;
	tryAutoSelectModel: (session: SessionInfo) => Promise<void>;
	tryApplyDefaultThinkingLevel: (session: SessionInfo) => Promise<void>;
	buildWorkflowList: (projectId?: string) => string;
	resolveInitialModel: (role: string | undefined, projectId: string | undefined) => string | undefined;
	resolveInitialThinkingLevel: (role: string | undefined, projectId: string | undefined) => string | undefined;
	/**
	 * Persist agentSessionFile + other live-state-derived fields. Optional —
	 * tests may construct a context without this; in that case a hard restart
	 * during the gap will lose the session, which is fine for unit tests.
	 */
	persistSessionMetadata?: (session: SessionInfo) => Promise<void>;
	/** PR status store — source of truth for goal PR URLs (re-attempt context). */
	prStatusStore: PrStatusStore;
}

// ── Retry helper ───────────────────────────────────────────────────────────

/**
 * Pure exponential-backoff delay calculator.
 *
 * - `attempt` is 1-based. Raw delay = `baseMs * 2 ** (attempt - 1)`.
 * - Raw delay is capped at `maxMs` BEFORE jitter is applied.
 * - When `jitterRatio > 0`, a symmetric multiplier in
 *   `[1 - jitterRatio, 1 + jitterRatio]` is applied (using `random()`,
 *   default `Math.random`).
 * - Final delay is clamped to `[0, maxMs]` so jitter can never exceed the
 *   configured cap.
 *
 * Used by `SessionManager.maybeAutoRetryTransient()` for provider
 * overload/rate-limit backoff. Pure — no I/O, no timers — to keep the
 * scheduling logic in session-manager and the math here testable in
 * isolation.
 */
export function nextBackoffDelay(
	attempt: number,
	opts?: {
		baseMs?: number;
		maxMs?: number;
		jitterRatio?: number;
		random?: () => number;
	},
): number {
	const baseMs = opts?.baseMs ?? 1000;
	const maxMs = opts?.maxMs ?? Number.POSITIVE_INFINITY;
	const jitterRatio = Math.max(0, opts?.jitterRatio ?? 0);
	const random = opts?.random ?? Math.random;

	const safeAttempt = Math.max(1, Math.floor(attempt));
	// Cap the exponent so 2^n stays finite for very large attempt counts.
	const exponent = Math.min(safeAttempt - 1, 60);
	const raw = baseMs * Math.pow(2, exponent);
	const capped = Math.min(raw, maxMs);

	let delay = capped;
	if (jitterRatio > 0) {
		const multiplier = 1 + (random() * 2 - 1) * jitterRatio;
		delay = capped * multiplier;
	}
	if (delay < 0) delay = 0;
	if (delay > maxMs) delay = maxMs;
	return delay;
}

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
		// S1: inject the per-session capability secret alongside the session id.
		// Only this session's process receives its own secret — see
		// `src/server/auth/session-secret.ts`.
		//
		// Gateway-owned identity keys (BOBBIT_SESSION_ID / BOBBIT_SESSION_SECRET)
		// are spread AFTER caller `plan.env` (toolEnv) so the gateway-issued values
		// always WIN: a caller-supplied toolEnv key can never clobber the session
		// identity or capability secret (which would let a child impersonate another
		// session for the binding-routed PR-walkthrough tool routes). Pinned by a
		// unit test in tests/session-setup-env.test.ts.
		env: {
			...plan.env,
			BOBBIT_SESSION_ID: plan.id,
			BOBBIT_SESSION_SECRET: ctx.sessionSecretStore.getOrCreateSecret(plan.id),
		},
	};
	if (ctx.agentCliPath) {
		plan.bridgeOptions.cliPath = ctx.agentCliPath;
	}

	// NOTE: the legacy `BOBBIT_DELEGATE_OF` env var (the old delegate-recursion
	// early-return guard in the agent extension) is intentionally NOT set here
	// anymore. Recursion is now blocked by OrchestrationCore.assertCanSpawn +
	// allowedTools subtraction (every spawn verb stripped from the child) — see
	// docs/design/orchestration-core.md §7. The persisted `delegateOf` link
	// (plan.delegateOf) is unchanged; only the env-var guard is removed.

	// Wire tool manager for extension path resolution in RpcBridge
	if (ctx.toolManager) {
		plan.bridgeOptions.toolManager = ctx.toolManager;
	}

	// Pin model + thinking level at spawn time so pi-coding-agent doesn't emit
	// a redundant initial `model_change` event with its hardcoded default.
	// Explicit caller-supplied values (verification harness) win; otherwise
	// resolve from role/preferences when auto-select is enabled.
	//
	// `plan.role` and `plan.roleName` are two parallel fields naming the same
	// role (see SessionSetupPlan). Several callers (team-manager.spawnRole,
	// startTeam for the team lead, staff-manager) pass only `roleName`. Fall
	// back to `roleName` so role-keyed model/thinking-level overrides aren't
	// silently dropped. Collapsing the duality is a separate refactor.
	if (plan.initialModel && /^[^/]+\/.+$/.test(plan.initialModel)) {
		plan.bridgeOptions.initialModel = plan.initialModel;
	} else if (!plan.skipAutoModel) {
		const pinned = ctx.resolveInitialModel(plan.role ?? plan.roleName, plan.projectId);
		if (pinned) plan.bridgeOptions.initialModel = pinned;
	}
	if (plan.initialThinkingLevel) {
		plan.bridgeOptions.initialThinkingLevel = plan.initialThinkingLevel;
	} else if (!plan.skipAutoThinking) {
		const pinnedT = ctx.resolveInitialThinkingLevel(plan.role ?? plan.roleName, plan.projectId);
		if (pinnedT) plan.bridgeOptions.initialThinkingLevel = pinnedT;
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
	let effectiveAllowedTools: EffectiveTool[] | undefined = plan.effectiveAllowedTools;

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

	// Generic role-accessory application. When a session is created with a
	// role (roleName/role) that resolves to a Role carrying an `accessory`, and
	// the caller did NOT explicitly pass one, surface the role's accessory so it
	// renders in the sidebar. This is how a role-carrying spawn that only threads
	// `roleName` (e.g. the host.agents `pr-reviewer` reviewer child) gets its
	// `review` accessory without the spawn caller plumbing it. Generic — not
	// pr-walkthrough-specific; "none" is treated as "no accessory".
	if (!plan.accessory || plan.accessory === "none") {
		const roleName = plan.roleName ?? plan.role;
		if (roleName) {
			const resolvedRole = lookupRole(roleName, plan, ctx);
			if (resolvedRole?.accessory && resolvedRole.accessory !== "none") {
				plan.accessory = resolvedRole.accessory;
			}
		}
	}
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
					assistantGoalSpec += "\n\n" + buildReattemptContext(origGoal, ctx.prStatusStore);
				}
			}
		}
		// Resolve {if:subGoalsEnabled} blocks (e.g. the goal assistant's sub-goal
		// guidance) against the system feature flag, mirroring the team-lead path.
		assistantGoalSpec = applyPromptConditionals(assistantGoalSpec, {
			subGoalsEnabled: ctx.groupPolicyStore?.getSubgoalsEnabled?.() ?? false,
		});

		// Use assistant role's tool restrictions
		if (assistantRole && ctx.toolManager) {
			plan.effectiveAllowedTools = computeEffectiveAllowedTools(
				ctx.toolManager, assistantRole, ctx.groupPolicyStore ?? undefined, ctx.mcpManager ?? undefined,
			);
		}

		const promptPath = ctx.assemblePrompt(plan.id, {
			// Include the base system prompt so assistant sessions
			// (goal/project/tool assistants) get it by default.
			baseSystemPromptPath: ctx.systemPromptPath,
			cwd: plan.cwd,
			projectRoot: plan.repoPath,
			goalSpec: assistantGoalSpec,
			goalTitle: assistantDef.promptTitle,
			goalState: "active",
			allowedTools: plan.effectiveAllowedTools?.map(e => e.name),
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
			// Delegates still get the global base system prompt. The task spec is
			// layered on top as goalSpec; AGENTS.md from the worktree is also included.
			baseSystemPromptPath: ctx.systemPromptPath,
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

		// Nesting awareness — only the team-lead session of a goal needs the
		// root/child stanzas + the subgoal/team_spawn/task_create decision
		// rule. Contributors and QA/reviewer sub-sessions get nothing here
		// (they inherit their scope from their task spec). Stamping the
		// stanza at the right role is what actually surfaces Stanza B's
		// "DO NOT raise a PR / DO NOT spawn siblings" guardrail to child
		// team-leads — before this was populated, the child agent had no
		// structural awareness that its spec might be parent-flavoured.
		const nestingContext = plan.roleName === "team-lead" && goal
			? buildNestingContext(goal, ctx.goalManager, ctx.groupPolicyStore?.getSubgoalsEnabled?.() ?? false)
			: undefined;

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
			allowedTools: plan.effectiveAllowedTools?.map(e => e.name),
			workflowContext: plan.workflowContext,
			projectConfigStore: ctx.projectConfigStore ?? undefined,
			nestingContext,
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
	// Resolve the role cascade-first (pack-shipped roles like `pr-reviewer` live in
	// the config cascade, NOT the in-memory RoleManager). Resolving via roleManager
	// alone returns `undefined` for a pack role, which makes the guard fall through
	// to group defaults (e.g. `PR Walkthrough: never`) and reject every reviewer
	// tool call. `lookupRole` mirrors the cascade-first pattern used elsewhere.
	const effectiveRole = plan.roleName ? lookupRole(plan.roleName, plan, ctx) : undefined;
	const flatNames = plan.effectiveAllowedTools?.map(e => e.name);
	const mcpExtPaths = ctx.mcpManager
		? writeMcpProxyExtensions(ctx.mcpManager, flatNames, effectiveRole ?? undefined, ctx.toolManager ?? undefined, ctx.groupPolicyStore ?? undefined)
		: undefined;

	const activation = computeToolActivationArgs(plan.effectiveAllowedTools, ctx.toolManager ?? undefined, plan.cwd, mcpExtPaths);

	plan.bridgeOptions.args = [...activation.args, ...(plan.bridgeOptions.args || [])];
	plan.bridgeOptions.env = { ...(plan.bridgeOptions.env || {}), ...activation.env };

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
		role: plan.role ?? plan.roleName,
		worktreePath: plan.worktreePath,
		repoPath: plan.repoPath,
		branch: plan.branch,
		taskId: plan.taskId,
		staffId: plan.staffId,
		accessory: plan.accessory,
		nonInteractive: plan.nonInteractive,
		sandboxed: plan.sandboxed,
		delegateOf: plan.delegateOf,
		// Durable delegate task — restored into the system prompt on reboot so the
		// delegate comes back live with its task intact (mirrors a worker's goal spec).
		instructions: plan.instructions,
		context: plan.context,
		parentSessionId: plan.parentSessionId,
		childKind: plan.childKind,
		readOnly: plan.readOnly,
		allowedTools: plan.sessionScopedAllowedTools,
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
			() => ctx.applySandboxWiring(plan.bridgeOptions, plan.id, {
				projectId: plan.projectId,
				goalId: plan.goalId,
				sandboxBranch: plan.sandboxBranch,
				sandboxBaseBranch: plan.sandboxBaseBranch,
				sandboxCwdOffset: plan.sandboxCwdOffset,
			}),
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
	// Test-only knob: deterministically extend the "preparing" window so the
	// preparing-UX banner is observable to the client. Status is already set to
	// "preparing" by SessionManager.createSession before this fn is invoked, so
	// sleeping here keeps the session visibly preparing without changing
	// production behaviour (gated on the env var being set).
	if (process.env.BOBBIT_TEST_PREPARING_DELAY_MS) {
		const delayMs = Number(process.env.BOBBIT_TEST_PREPARING_DELAY_MS);
		if (Number.isFinite(delayMs) && delayMs > 0) {
			await new Promise(resolve => setTimeout(resolve, delayMs));
		}
	}

	// Use pre-built worktree from pool, or create one from scratch
	let worktreeCwd: string = plan.cwd;
	// Defense-in-depth: set when no worktree-able repo remained (multi-repo
	// declaration whose sub-repos aren't git repos). resolveWorktreeSupport
	// normally prevents reaching here, but if it does we run the session in the
	// original cwd with no worktree rather than pointing at a missing container.
	let noWorktreeFallback = false;
	if (preBuiltWorktreePath) {
		worktreeCwd = preBuiltWorktreePath;
		console.log(`[session-setup] Using pre-built worktree for session ${session.id}: ${worktreeCwd}`);
	} else {
		// Cold-path worktree creation. Multi-repo (poly-repo) projects need
		// `createWorktreeSet` so each component repo gets its own sibling
		// worktree under the branch container. Single-repo collapses to the
		// existing `createWorktree` call.
		const components = ctx.projectConfigStore?.getComponents() ?? [];
		const isMulti = components.some(c => c.repo !== ".");
		// Read the project's configured `base_ref` once so both the multi-repo and
		// single-repo paths thread it into worktree creation. Empty/undefined
		// falls back to today's `resolveRemotePrimary`. See docs/design/base-ref.md.
		const configuredBaseRef = ctx.projectConfigStore?.get("base_ref") || undefined;
		if (isMulti) {
			const { createWorktreeSet } = await import("../skills/git.js");
			const worktreeRoot = ctx.projectConfigStore?.get("worktree_root") || undefined;
			const result = await withRetry(
				async () => createWorktreeSet(plan.repoPath!, components, plan.branch!, undefined, { worktreeRoot, configuredBaseRef }),
				{ retries: 2, delays: [1000, 2000], label: "createWorktreeSet", sessionId: plan.id },
			);
			if (result.worktrees.length === 0) {
				// No worktree-able git sub-repo remained — fall back to no-worktree.
				noWorktreeFallback = true;
				console.warn(`[session-setup] No worktree-able repo for session ${session.id}; running without a worktree in ${plan.cwd}`);
			} else {
				worktreeCwd = result.container;
				// Mirror the pool-claim path: record per-repo worktrees for archive cleanup.
				session.repoWorktrees = result.worktrees.map(w => ({
					repo: w.repo,
					repoPath: w.repoPath,
					worktreePath: w.worktreePath,
				}));
			}
		} else {
			worktreeCwd = await withRetry(
				async () => {
					const result = await createWorktree(plan.repoPath!, plan.branch!, { configuredBaseRef });
					return result.worktreePath;
				},
				{ retries: 2, delays: [1000, 2000], label: "createWorktree", sessionId: plan.id },
			);
		}

		// Per-component setup — non-fatal on failure. Routes through the canonical
		// resolver so component.relativePath is honored. Skipped entirely in the
		// no-worktree fallback (there is no branch container to set up).
		if (!noWorktreeFallback && components.length > 0) {
			try {
				const { runComponentSetups } = await import("../skills/worktree-setup.js");
				const { execShellCommand } = await import("./shell-util.js");
				await runComponentSetups({
					components,
					branchContainer: worktreeCwd,
					primaryWorktreeRoot: plan.repoPath!,
					exec: async (cmd, cwd, env) => {
						await execShellCommand(cmd, { cwd, env, timeout: 120_000 });
					},
				});
			} catch (err) {
				console.warn(`[session-setup] runComponentSetups failed for session ${session.id} (non-fatal):`, err);
			}
		}
	}

	if (noWorktreeFallback) {
		// No worktree was created — run the session in its original cwd exactly
		// like a no-worktree session. Do NOT set worktreePath/repoWorktrees and
		// skip the sandbox-branch wiring that assumes a real branch container.
		// plan.cwd / session.cwd are left unchanged (the original project cwd).
		console.log(`[session-setup] Session ${session.id} running without a worktree in ${plan.cwd}`);
	} else {
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
		const sandboxCwdOffset = normalizeSandboxCwdOffset(relativeOffset);
		if (sandboxCwdOffset) plan.sandboxCwdOffset = sandboxCwdOffset;
		const offsetCwd = relativeOffset && relativeOffset !== "."
			? path.join(worktreeCwd, relativeOffset)
			: worktreeCwd;

		// Update session and plan with worktree CWD (offset applied)
		session.cwd = offsetCwd;
		session.worktreePath = worktreeCwd;
		plan.cwd = offsetCwd;
		const persistFields: Record<string, unknown> = { cwd: offsetCwd, worktreePath: worktreeCwd };
		if (session.repoWorktrees && session.repoWorktrees.length > 0) {
			persistFields.repoWorktrees = Object.fromEntries(
				session.repoWorktrees.map(w => [w.repo, w.worktreePath]),
			);
		}
		ctx.store.update(session.id, persistFields);
		console.log(`[session-setup] Worktree ready for session ${session.id}: ${worktreeCwd} (branch: ${plan.branch})`);
	}

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
			() => ctx.applySandboxWiring(plan.bridgeOptions, plan.id, {
				projectId: plan.projectId,
				goalId: plan.goalId,
				sandboxBranch: plan.sandboxBranch,
				sandboxBaseBranch: plan.sandboxBaseBranch,
				sandboxCwdOffset: plan.sandboxCwdOffset,
			}),
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
	session.allowedTools = plan.effectiveAllowedTools?.map(e => e.name);
	// resolveTools may have applied the role's accessory (generic role-accessory
	// application); mirror it onto the live worktree session so the sidebar
	// renders it (the early placeholder persist predates accessory resolution).
	if (plan.accessory && session.accessory !== plan.accessory) {
		session.accessory = plan.accessory;
		ctx.store.update(session.id, { accessory: plan.accessory });
	}
	if (plan.bridgeOptions.initialModel) session.spawnPinnedModel = plan.bridgeOptions.initialModel;
	if (plan.bridgeOptions.initialThinkingLevel) session.spawnPinnedThinkingLevel = plan.bridgeOptions.initialThinkingLevel;

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

		// Un-poison any blank-text user messages in the cloned transcript before
		// the agent rehydrates from it (best-effort, non-fatal).
		await sanitizeAgentTranscriptFile(
			{ sandboxed: !!plan.sandboxed, projectId: plan.projectId },
			plan.preExistingAgentSessionFile,
			ctx.sandboxManager,
		);
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

	// Notify connected clients that the session is ready (single writer + version bump).
	broadcastStatus(session, "idle");

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
	const spawnPinnedModel = plan.bridgeOptions.initialModel;
	const spawnPinnedThinkingLevel = plan.bridgeOptions.initialThinkingLevel;
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
		statusVersion: 0,
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
		parentSessionId: plan.parentSessionId,
		childKind: plan.childKind,
		readOnly: plan.readOnly,
		allowedTools: plan.effectiveAllowedTools?.map(e => e.name),
		// Mirror the spawn-time resolver fallback: when callers pass only
		// `roleName`, surface it as `session.role` so the post-spawn
		// `tryAutoSelectModel` safety net keys off the right role id.
		role: plan.role ?? plan.roleName,
		accessory: plan.accessory,
		promptQueue: new PromptQueue(),
		spawnPinnedModel,
		spawnPinnedThinkingLevel,
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
		await sanitizeAgentTranscriptFile(
			{ sandboxed: !!plan.sandboxed, projectId: plan.projectId },
			plan.preExistingAgentSessionFile,
			ctx.sandboxManager,
		);
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

	// 3. Notify connected clients (single writer + version bump).
	broadcastStatus(session, "terminated");

	// 4. Background worktree cleanup (slow, non-blocking)
	if (plan.worktreePath && plan.repoPath && plan.branch) {
		cleanupWorktree(plan.repoPath, plan.worktreePath, plan.branch, true).catch(() => {});
	}

	// 5. Clean up sandbox token for this session
	if (ctx.sandboxTokenStore && plan.projectId) {
		ctx.sandboxTokenStore.removeSession(plan.projectId, session.id);
	}

	// 6. S1: drop the per-session capability secret.
	ctx.sessionSecretStore.remove(session.id);
}
