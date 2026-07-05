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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { WebSocket } from "ws";
import type { ServerMessage } from "../ws/protocol.js";
import type { SessionInfo } from "./session-manager.js";
import { emitSessionEvent, broadcastStatus } from "./session-manager.js";
import type { IRpcBridge, RpcBridgeOptions, RuntimePiExtensionInfo } from "./rpc-bridge.js";
import { createSessionBridge, assertRuntimeAllowedForSession, hydrateRuntimeOptions, modelAliasFromModelString, resolveSessionRuntime, runtimeFromModelString, type SessionBridgeOptions } from "./session-runtime.js";
import { readClaudeCodeConfig } from "./claude-code-config.js";
import { rebaseAgentTranscriptCwdMetadataFile, sanitizeAgentTranscriptFile } from "./transcript-sanitizer.js";
import { EventBuffer } from "./event-buffer.js";
import { PromptQueue } from "./prompt-queue.js";
import { applyPromptConditionals } from "./prompt-conditionals.js";
import type { SessionRuntime, SessionStore, WorktreePushPolicy } from "./session-store.js";
import type { GoalManager } from "./goal-manager.js";
import type { TaskManager } from "./task-manager.js";
import type { SearchService } from "../search/search-service.js";
import type { CostTracker } from "./cost-tracker.js";
import type { RoleManager } from "./role-manager.js";
import type { ScopedToolContext, ToolManager } from "./tool-manager.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { SandboxManager } from "./sandbox-manager.js";
import type { PromptParts, NestingContext } from "./system-prompt.js";
import type { PrStatusStore } from "./pr-status-store.js";
import type { LifecycleHub } from "./lifecycle-hub.js";
import type { ContextBlock } from "./context-blocks.js";

import type { ConfigCascade } from "./config-cascade.js";
import { getAssistantDef } from "./assistant-registry.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { computeToolActivationArgs, writeMcpProxyExtensions, writeToolGuardExtension, computeEffectiveAllowedTools, type EffectiveTool } from "./tool-activation.js";
import { hasProviderBridgeHooks, writeProviderBridgeExtension } from "./provider-bridge-extension.js";
import { prependToolResultErrorBridge } from "./tool-result-error-bridge-extension.js";
import { writeGoogleCodeAssistProviderExtension } from "./google-code-assist-provider-extension.js";
import { writeOpenAiOrphanToolResultExtension } from "./openai-orphan-tool-result-extension.js";
import { createWorktree, cleanupWorktree, isUnresolvedHeadWorktreeError } from "../skills/git.js";
import { isWorktreePathReferencedByLiveSession, type WorktreeReferenceRecord } from "./worktree-reference-guard.js";

import { TOOLS_DIR } from "./tool-manager.js";
import { profile, profileAsync, recordElapsed } from "./profiling.js";
import { truncateLargeToolContent } from "./truncate-large-content.js";
import { fallbackProviderAllowlistFromPrefs, mergeHostAgentProviderEnv } from "./host-tokens.js";
import { resolveCacheRetentionEnv } from "./cache-retention.js";
import { sanitizeModelErrorForLog, sanitizeModelErrorText } from "./model-error-sanitizer.js";

export interface PiExtensionDiagnostic {
	status: "ok" | "disabled" | "unresolved" | "discovery-failed" | "runtime-load-failed" | "remap-failed";
	code: string;
	message: string;
	updatedAt: string;
	stale?: boolean;
}

export interface PiExtensionToolInfo {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface ResolvedPiExtensionContribution {
	listName: string;
	entryPath?: string;
	entryRelativePath?: string;
	packRoot: string;
	origin: {
		scope: "server" | "global-user" | "project" | "builtin";
		packName: string;
		packId: string;
		sourceUrl?: string;
	};
	diagnostic: PiExtensionDiagnostic;
	discovery: {
		status: "ok" | "failed" | "skipped";
		tools: PiExtensionToolInfo[];
		diagnostic?: PiExtensionDiagnostic;
		cacheKey?: string;
	};
}

export type MarketplacePiExtensionResolver = (scope: { projectId?: string; cwd?: string }) => ResolvedPiExtensionContribution[];

export interface MarketplacePiExtensionActivation {
	args: string[];
	tools: PiExtensionToolInfo[];
	diagnostics: PiExtensionDiagnostic[];
	runtimeExtensions: RuntimePiExtensionInfo[];
}

const RUNTIME_OMIT_PI_EXTENSION_STATUSES = new Set<PiExtensionDiagnostic["status"]>(["disabled", "unresolved"]);

export function scopedToolContext(projectId: string | undefined, cwd: string | undefined): ScopedToolContext {
	const scopeKey = projectId ? `project:${projectId}` : cwd ? `cwd:${path.resolve(cwd)}` : "default";
	return { ...(projectId ? { projectId } : {}), ...(cwd ? { cwd } : {}), scopeKey };
}

export function resolveMarketplacePiExtensionActivation(
	resolver: MarketplacePiExtensionResolver | null | undefined,
	projectId: string | undefined,
	cwd: string | undefined,
): MarketplacePiExtensionActivation {
	if (!resolver) return { args: [], tools: [], diagnostics: [], runtimeExtensions: [] };
	const contributions = resolver({ projectId, cwd });
	const args: string[] = [];
	const tools: PiExtensionToolInfo[] = [];
	const diagnostics: PiExtensionDiagnostic[] = [];
	const runtimeExtensions: RuntimePiExtensionInfo[] = [];
	for (const contribution of contributions) {
		diagnostics.push(contribution.diagnostic);
		if (contribution.discovery?.diagnostic) diagnostics.push(contribution.discovery.diagnostic);
		const runtimeEnabled = !RUNTIME_OMIT_PI_EXTENSION_STATUSES.has(contribution.diagnostic.status);
		if (runtimeEnabled) {
			for (const tool of contribution.discovery?.tools ?? []) tools.push(tool);
		}
		if (contribution.entryPath && runtimeEnabled) {
			args.push("--extension", contribution.entryPath);
			runtimeExtensions.push({
				listName: contribution.listName,
				entryPath: contribution.entryPath,
				...(contribution.entryRelativePath ? { entryRelativePath: contribution.entryRelativePath } : {}),
				packRoot: contribution.packRoot,
				origin: contribution.origin,
			});
		}
	}
	return { args, tools, diagnostics, runtimeExtensions };
}

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
	/**
	 * The team/goal this session belongs to as a NON-lead member (team_spawn
	 * member, llm-review reviewer, team_delegate sub-agent). The effective goal
	 * for per-goal metadata resolution is `goalId ?? teamGoalId`, so every
	 * session in a goal's tree resolves the SAME inherited metadata. Stamped by
	 * SessionManager (incl. the delegate-stamping fix); absent for leads (which
	 * carry `goalId`) and for goal-less sessions.
	 */
	teamGoalId?: string;
	teamLeadSessionId?: string;
	assistantType?: string;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	readOnly?: boolean;
	runtime?: SessionRuntime;
	claudeCodeSessionId?: string;
	/** Explicit session-scoped tool allowlist that must survive process restarts. */
	sessionScopedAllowedTools?: string[];
	taskId?: string;
	worktreePath?: string;
	worktreePushPolicy?: WorktreePushPolicy;
	repoPath?: string;
	branch?: string;
	sandboxed?: boolean;
	role?: string;
	staffId?: string;
	accessory?: string;
	nonInteractive?: boolean;

	// Computed during planning
	bridgeOptions: SessionBridgeOptions;
	effectiveAllowedTools?: EffectiveTool[];
	promptPath?: string;
	dynamicContextBlocks?: ContextBlock[];

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
	/**
	 * Continue/Fork rehydration: archived/provenance cwd values that may appear in
	 * runtime-only transcript system metadata and should be rewritten to plan.cwd.
	 */
	preExistingAgentSessionOldCwds?: string[];
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
	marketplacePiExtensionResolver?: MarketplacePiExtensionResolver | null;
	goalManager: GoalManager;
	taskManager: TaskManager;
	projectConfigStore: import("./project-config-store.js").ProjectConfigStore | null;
	preferencesStore?: import("./preferences-store.js").PreferencesStore | null;
	sandboxManager: SandboxManager | null;
	sandboxTokenStore: import("../auth/sandbox-token.js").SandboxTokenStore | null;
	/** S1 — per-session capability secret store (see session-secret.ts). */
	sessionSecretStore: import("../auth/session-secret.js").SessionSecretStore;
	groupPolicyStore: ToolGroupPolicyStore | null;
	configCascade: ConfigCascade | null;
	lifecycleHub?: LifecycleHub;
	/**
	 * Resolve the EFFECTIVE (ancestry-merged) per-goal metadata for a goal id.
	 * Wired by SessionManager to `goalManager.getEffectiveGoalMetadata`. Optional
	 * so tests can construct a context without it; absent ⇒ `{}` (no overrides),
	 * keeping every edge byte-identical to today. The single source of truth for
	 * goal metadata at every session edge — no per-site ancestry walks.
	 */
	resolveGoalMetadata?: (goalId: string | undefined) => Record<string, unknown>;
	costTracker: CostTracker;
	store: SessionStore;
	searchIndex: SearchService;
	sessions: Map<string, SessionInfo>;
	listPersistedSessionsForWorktreeGuard?: () => WorktreeReferenceRecord[];
	assemblePrompt: (id: string, parts: PromptParts) => string | undefined;

	applySandboxWiring: (opts: RpcBridgeOptions, id: string, sandboxOpts?: SandboxWiringOptions) => Promise<boolean>;
	handleAgentLifecycle: (session: SessionInfo, event: any) => void;
	trackCostFromEvent: (session: SessionInfo, event: any) => void;
	recordPiExtensionDiagnostic?: (session: SessionInfo, diagnostic: import("./rpc-bridge.js").RuntimePiExtensionDiagnostic, extension: RuntimePiExtensionInfo) => void;
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
	/**
	 * Warm pi-process pool (wave 1, docs/design/warm-pi-process-pool.md).
	 * `undefined` when the feature is disabled (`BOBBIT_WARM_POOL` unset —
	 * default) or the caller (tests) doesn't wire one — `spawnAgent()` must
	 * treat that identically to "pool present but missed," i.e. fall through
	 * to the cold `createSessionBridge` path with zero behavior change.
	 */
	piProcessPool?: import("./pi-process-pool.js").PiProcessPool;
	/** See `SessionManager.registerWarmPoolIdentityAlias` doc comment. */
	registerWarmPoolIdentityAlias?: (poolOwnedId: string, realSessionId: string) => void;
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
	opts: { retries: number; delays: number[]; label: string; sessionId: string; nonRetryable?: (err: Error) => boolean },
): Promise<T> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= opts.retries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err as Error;
			if (opts.nonRetryable?.(lastError)) throw lastError;
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

export type PreExistingTranscriptSetupMode = "none" | "switch-session" | "claude-code-resume";

export function resolvePreExistingTranscriptSetupMode(
	plan: Pick<SessionSetupPlan, "preExistingAgentSessionFile" | "runtime" | "claudeCodeSessionId" | "bridgeOptions">,
): PreExistingTranscriptSetupMode {
	if (!plan.preExistingAgentSessionFile) return "none";
	const runtime = plan.runtime ?? plan.bridgeOptions.runtime ?? runtimeFromModelString(plan.bridgeOptions.initialModel) ?? "pi";
	if (runtime !== "claude-code") return "switch-session";
	if (plan.bridgeOptions.claudeCodeSessionId || plan.claudeCodeSessionId) return "claude-code-resume";
	throw new Error(
		"Continue/fork from a Bobbit transcript is not supported for Claude Code runtime in the MVP unless a Claude Code session id is available; " +
		"Pi switch_session cannot be used with Claude Code.",
	);
}

// ── Goal-metadata helpers ───────────────────────────────────────────────────

/** Effective goal id for a session: own goal (lead) else team/parent goal (member). */
function effectiveGoalId(plan: SessionSetupPlan): string | undefined {
	return plan.goalId ?? plan.teamGoalId;
}

/**
 * Apply the project-subdirectory offset to a freshly provisioned branch
 * container, yielding the agent's ACTUAL working directory. When the project
 * root is a subdirectory of the repo, the agent runs in `<worktree>/<offset>`,
 * not at the container root. Mirrors the offset computation in
 * `executeWorktreeAsync` so callers (e.g. the goalProvisioned hook) see the
 * same cwd the session will boot with.
 */
export function offsetWorktreeCwd(plan: Pick<SessionSetupPlan, "repoPath" | "cwd">, worktreeCwd: string): string {
	const relativeOffset = plan.repoPath ? path.relative(plan.repoPath, plan.cwd) : "";
	return relativeOffset && relativeOffset !== "." ? path.join(worktreeCwd, relativeOffset) : worktreeCwd;
}

/**
 * Resolve the effective (ancestry-merged) per-goal metadata for this session.
 * Returns `{}` when no resolver is wired or no goal — so all downstream edges
 * are guarded no-ops and behaviour is byte-identical to today.
 */
function resolveEffectiveGoalMetadata(plan: SessionSetupPlan, ctx: PipelineContext): Record<string, unknown> {
	if (!ctx.resolveGoalMetadata) return {};
	try {
		return ctx.resolveGoalMetadata(effectiveGoalId(plan)) ?? {};
	} catch (err) {
		console.warn(`[session-setup] resolveGoalMetadata failed for ${plan.id} (non-fatal):`, err);
		return {};
	}
}

/** Lower-cased set of tool names disabled by `bobbit.disabledTools`; undefined when none. */
function disabledToolsFromMetadata(meta: Record<string, unknown>): ReadonlySet<string> | undefined {
	const raw = meta["bobbit.disabledTools"];
	if (!Array.isArray(raw)) return undefined;
	const names = raw.filter((v): v is string => typeof v === "string" && v.length > 0).map(s => s.toLowerCase());
	return names.length > 0 ? new Set(names) : undefined;
}

/**
 * Drop `bobbit.disabledTools` entries from a resolved allowlist IN PLACE on the
 * plan. CRITICAL: this preserves the `undefined` (unrestricted) vs `[]`
 * (explicit no-tools) distinction — `undefined` stays `undefined` (never widened
 * to a concrete list), and a list filtered down to nothing stays `[]` (never
 * widened back to all tools). No-op when nothing is disabled. Idempotent, so it
 * is safe to call before prompt assembly AND again during tool activation.
 */
function applyDisabledToolsFilter(plan: SessionSetupPlan, disabledTools: ReadonlySet<string> | undefined): void {
	if (disabledTools && plan.effectiveAllowedTools) {
		plan.effectiveAllowedTools = plan.effectiveAllowedTools.filter(t => !disabledTools.has(t.name.toLowerCase()));
	}
}

/** Prompt section order from `bobbit.promptSectionOrder`; undefined when none. */
function promptSectionOrderFromMetadata(meta: Record<string, unknown>): string[] | undefined {
	const raw = meta["bobbit.promptSectionOrder"];
	if (!Array.isArray(raw)) return undefined;
	const order = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
	return order.length > 0 ? order : undefined;
}

/**
 * Fire the `goalProvisioned` lifecycle hook for a freshly provisioned worktree
 * in this goal's subtree. Dispatched at EVERY provisioning path (cold create,
 * pool claim) so metadata-driven filesystem treatments land on every agent /
 * sub-agent / sub-goal worktree, not just the goal worktree. Non-fatal.
 */
async function dispatchGoalProvisionedHook(plan: SessionSetupPlan, ctx: PipelineContext, worktreePath: string): Promise<void> {
	if (!ctx.lifecycleHub) return;
	const goalId = effectiveGoalId(plan);
	if (!goalId) return;
	const metadata = resolveEffectiveGoalMetadata(plan, ctx);
	// `worktreePath` is the branch-container root; `cwd` is the agent's actual
	// working directory after the project-subdirectory offset. Passing the
	// offset cwd keeps filesystem treatments symmetric with where the agent
	// runs (e.g. a monorepo package subdir), rather than the container root.
	const cwd = offsetWorktreeCwd(plan, worktreePath);
	try {
		await ctx.lifecycleHub.dispatchGoalProvisioned({
			goalId,
			projectId: plan.projectId,
			worktreePath,
			cwd,
			branch: plan.branch,
			metadata,
		});
	} catch (err) {
		console.warn(`[session-setup] goalProvisioned dispatch failed for ${plan.id} (non-fatal):`, err);
	}
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
		readOnly: plan.readOnly,
		claudeCodeSessionId: plan.claudeCodeSessionId,
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
		//
		// resolveCacheRetentionEnv() is spread FIRST (lowest precedence within
		// this map): it resolves the prompt-cache retention env
		// (BOBBIT_CACHE_RETENTION > operator-set PI_CACHE_RETENTION in the
		// gateway env > default "long"; see cache-retention.ts), and a
		// caller-supplied toolEnv can still override the resolved value
		// per-session (e.g. for an A/B run) without touching identity keys.
		env: {
			...resolveCacheRetentionEnv(),
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
	if (!plan.sandboxed) {
		plan.bridgeOptions.env = mergeHostAgentProviderEnv(plan.bridgeOptions.env, ctx.preferencesStore, {
			model: plan.bridgeOptions.initialModel,
			providers: fallbackProviderAllowlistFromPrefs(ctx.preferencesStore),
		});
	}
	if (plan.initialThinkingLevel) {
		plan.bridgeOptions.initialThinkingLevel = plan.initialThinkingLevel;
	} else if (!plan.skipAutoThinking) {
		const pinnedT = ctx.resolveInitialThinkingLevel(plan.role ?? plan.roleName, plan.projectId);
		if (pinnedT) plan.bridgeOptions.initialThinkingLevel = pinnedT;
	}

	const runtime = resolveSessionRuntime({ runtime: plan.runtime, initialModel: plan.bridgeOptions.initialModel });
	assertRuntimeAllowedForSession(runtime, plan.sandboxed);
	plan.runtime = runtime;
	const claudeCodeConfig = runtime === "claude-code" && ctx.preferencesStore
		? readClaudeCodeConfig(ctx.preferencesStore, ctx.projectConfigStore)
		: undefined;
	plan.bridgeOptions = hydrateRuntimeOptions({ ...plan.bridgeOptions, runtime }, claudeCodeConfig);
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

	// Fall back to the role's allowed tools ONLY when no allowlist was supplied
	// (`undefined`). An EXPLICIT empty allowlist (`[]` = NO tools, e.g. a
	// recursion-stripped delegate or a session emptied by bobbit.disabledTools)
	// must be preserved so lower activation sees zero tools — never widened back
	// to the general/role default on first spawn.
	if (effectiveAllowedTools === undefined && ctx.roleManager) {
		// Use cascade-resolved role first, including server-scope market-pack roles
		// when no projectId is present.
		const roleName = plan.roleName || "general";
		const role = lookupRole(roleName, plan, ctx);
		if (role && ctx.toolManager) {
			effectiveAllowedTools = computeEffectiveAllowedTools(
				ctx.toolManager, role, ctx.groupPolicyStore ?? undefined, ctx.mcpManager ?? undefined, scopedToolContext(plan.projectId, plan.cwd),
			);
		}
	}

	plan.effectiveAllowedTools = effectiveAllowedTools;

	// Eligibility-signal: thread the RESOLVED tool allowlist onto bridgeOptions
	// purely as classification metadata for `isInProcessBridgeEligible`
	// (`in-process-bridge-eligibility.ts` ORs `isReadOnlyToolPolicy(allowedTools)`
	// into its `readOnly` check — see that file's header). `resolveBridgeOptions`
	// (Step 1) always runs before this step, so `plan.bridgeOptions` already
	// exists here. Purely additive: nothing else reads `bridgeOptions.allowedTools`.
	plan.bridgeOptions.allowedTools = effectiveAllowedTools?.map(t => t.name);

	// Generic role-accessory application. When a session is created with a
	// role (roleName/role) that resolves to a Role carrying an `accessory`, and
	// the caller did NOT explicitly pass one, surface the role's accessory so it
	// renders in the sidebar. This is how a role-carrying spawn that only threads
	// `roleName` (e.g. the host.agents `pr-reviewer` reviewer child) gets its
	// `magnifier` accessory without the spawn caller plumbing it. Generic — not
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
	if (ctx.configCascade) {
		const resolved = ctx.configCascade.resolveRoles(plan.projectId);
		const match = resolved.find(r => r.item.name === name);
		if (match) return match.item;
	}
	return ctx.roleManager?.getRole(name);
}

export async function resolveDynamicContext(plan: SessionSetupPlan, ctx: PipelineContext): Promise<void> {
	if (!ctx.lifecycleHub) return;
	try {
		const { blocks } = await ctx.lifecycleHub.dispatch("sessionSetup", {
			sessionId: plan.id,
			projectId: plan.projectId,
			scope: plan.projectId ? "project" : "global",
			cwd: plan.cwd,
			// Effective goal so metadata-disabled providers are filtered for the
			// whole subtree (members/sub-agents resolve the inherited metadata).
			goalId: effectiveGoalId(plan),
			roleName: plan.roleName,
			prompt: plan.instructions,
		});
		plan.dynamicContextBlocks = blocks;
	} catch (err) {
		console.error(`[session-setup] sessionSetup dynamic context failed for ${plan.id}:`, err);
	}
}

/** Step 4: Assemble system prompt (handles assistant, normal, delegate variants). */
export function resolvePrompt(plan: SessionSetupPlan, ctx: PipelineContext): void {
	return profile("resolvePrompt", () => _resolvePrompt(plan, ctx));
}

function _resolvePrompt(plan: SessionSetupPlan, ctx: PipelineContext): void {
	const assistantDef = plan.assistantType ? getAssistantDef(plan.assistantType) : undefined;

	const goalMeta = resolveEffectiveGoalMetadata(plan, ctx);
	// Per-goal prompt section ordering (bobbit.promptSectionOrder). Undefined ⇒
	// today's fixed order, byte-identical. Applies to every prompt variant.
	const sectionOrder = promptSectionOrderFromMetadata(goalMeta);
	// Per-goal disabled tools (bobbit.disabledTools). Filter the resolved
	// allowlist HERE — BEFORE the prompt / tool-docs / skills catalog are
	// assembled and cached — so a disabled tool can never be advertised in the
	// initial system prompt or the prompt-sections snapshot even though
	// resolveToolActivation removes it from the live surface later. Undefined ⇒
	// no-op; `[]` vs `undefined` is preserved (see applyDisabledToolsFilter).
	const disabledTools = disabledToolsFromMetadata(goalMeta);
	// Non-assistant branches use the allowlist resolveTools already produced.
	applyDisabledToolsFilter(plan, disabledTools);

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
				ctx.toolManager, assistantRole, ctx.groupPolicyStore ?? undefined, ctx.mcpManager ?? undefined, scopedToolContext(plan.projectId, plan.cwd),
			);
			// Re-filter: the assistant recompute above replaced the allowlist, so
			// strip disabled tools again before the prompt/tool-docs are assembled.
			applyDisabledToolsFilter(plan, disabledTools);
		}

		const promptPath = ctx.assemblePrompt(plan.id, {
			dynamicContext: plan.dynamicContextBlocks,
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
			sectionOrder,
		});
		if (promptPath) plan.bridgeOptions.systemPromptPath = promptPath;
	} else if (plan.mode === "delegate") {
		// Delegate sessions: AGENTS.md + durable task spec. Render through the Task
		// section (not Goal) so fresh spawn, restore, cached PromptParts, and
		// prompt-section refresh all expose one task-oriented delegate section.
		let taskSpec = plan.instructions || "";
		if (plan.context && Object.keys(plan.context).length > 0) {
			taskSpec += "\n\n## Context";
			for (const [key, value] of Object.entries(plan.context)) {
				taskSpec += `\n- **${key}**: ${value}`;
			}
		}

		const promptPath = ctx.assemblePrompt(plan.id, {
			dynamicContext: plan.dynamicContextBlocks,
			baseSystemPromptPath: ctx.systemPromptPath,
			cwd: plan.cwd,
			projectRoot: plan.repoPath,
			taskTitle: "Delegate Task",
			taskSpec,
			allowedTools: plan.effectiveAllowedTools?.map(e => e.name),
			projectConfigStore: ctx.projectConfigStore ?? undefined,
			sectionOrder,
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
			dynamicContext: plan.dynamicContextBlocks,
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
			sectionOrder,
			// F2: read-only verification reviewer/agent-qa sessions are spawned
			// with nonInteractive:true (see verification-reviewer-meta.ts) and
			// never accept user input or make commits — drop the Git-conventions
			// and mutate-same-target stanzas from the base system prompt. Any
			// other nonInteractive session shape would get the same treatment,
			// but today the only callers stamping nonInteractive are the
			// verification harness's llm-review/agent-qa spawns.
			promptProfile: plan.nonInteractive ? "reviewer" : undefined,
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

	// Goal-metadata disabled tools (bobbit.disabledTools). resolvePrompt already
	// filtered the allowlist before assembling the prompt/tool-docs; the disabled
	// set is still needed here for the activation/proxy/guard builders so the live
	// surface and persisted/inspector `effectiveAllowedTools` all agree.
	const disabledTools = disabledToolsFromMetadata(resolveEffectiveGoalMetadata(plan, ctx));
	// Idempotent with the filtering already applied in resolvePrompt; this guard
	// keeps activation correct even if invoked without a preceding resolvePrompt.
	applyDisabledToolsFilter(plan, disabledTools);

	const flatNames = plan.effectiveAllowedTools?.map(e => e.name);
	const toolScope = scopedToolContext(plan.projectId, plan.cwd);
	const mcpExtPaths = ctx.mcpManager
		? writeMcpProxyExtensions(ctx.mcpManager, flatNames, effectiveRole ?? undefined, ctx.toolManager ?? undefined, ctx.groupPolicyStore ?? undefined, disabledTools, toolScope)
		: undefined;

	const activation = computeToolActivationArgs(plan.effectiveAllowedTools, ctx.toolManager ?? undefined, plan.cwd, mcpExtPaths, disabledTools, toolScope);
	const piExtensionActivation = resolveMarketplacePiExtensionActivation(ctx.marketplacePiExtensionResolver, plan.projectId, plan.cwd);

	plan.bridgeOptions.args = prependToolResultErrorBridge([...activation.args, ...piExtensionActivation.args, ...(plan.bridgeOptions.args || [])]);
	plan.bridgeOptions.piExtensions = [...(plan.bridgeOptions.piExtensions ?? []), ...piExtensionActivation.runtimeExtensions];
	plan.bridgeOptions.env = { ...(plan.bridgeOptions.env || {}), ...activation.env };

	// Generate and add the tool_call guard extension if any tools have 'ask' or 'never' policy.
	const guardPath = ctx.toolManager ? writeToolGuardExtension(
		plan.id,
		ctx.toolManager,
		ctx.mcpManager ?? undefined,
		effectiveRole ?? undefined,
		ctx.groupPolicyStore ?? undefined,
		[],
		disabledTools,
		toolScope,
	) : undefined;
	if (guardPath) {
		plan.bridgeOptions.args.push("--extension", guardPath);
	}

	// Generate and add the provider-bridge extension (per-turn beforePrompt /
	// beforeCompact hooks) ONLY when at least one enabled provider for this
	// session's project declares those hooks. When no provider is interested the
	// bridge is never written or passed to pi — preserving zero overhead and
	// keeping spawn args byte-identical to the no-provider baseline.
	if (ctx.lifecycleHub && hasProviderBridgeHooks(ctx.lifecycleHub, plan.projectId, effectiveGoalId(plan))) {
		const bridgePath = writeProviderBridgeExtension(plan.id);
		if (bridgePath) {
			plan.bridgeOptions.args.push("--extension", bridgePath);
		}
	}

	// OpenAI Responses preflight guard: remove orphan function_call_output items
	// that would otherwise wedge Codex/OpenAI sessions. Provider-safe no-op for
	// non-Responses payloads.
	const openAiOrphanGuardPath = writeOpenAiOrphanToolResultExtension();
	if (openAiOrphanGuardPath) {
		plan.bridgeOptions.args.push("--extension", openAiOrphanGuardPath);
	}

	// Register the Google account (Code Assist) provider INSIDE the agent process
	// so `google-gemini-cli/*` models can run as session models. Written
	// UNCONDITIONALLY (not credential-gated): a session spawned BEFORE Google
	// sign-in must still be able to bind such a model after the user authenticates,
	// since the agent's pi-ai otherwise has no `google-code-assist` api and binding
	// would throw "No API provider registered for api: google-code-assist". The
	// runtime Bearer token is fetched per request from the gateway, so registering
	// without a credential is safe and selecting the model post-auth just works.
	const codeAssistPath = writeGoogleCodeAssistProviderExtension(plan.id);
	if (codeAssistPath) {
		plan.bridgeOptions.args.push("--extension", codeAssistPath);
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

function modelProviderFromModelString(model?: string): string | undefined {
	if (!model) return undefined;
	const slash = model.indexOf("/");
	if (slash <= 0) return undefined;
	return model.slice(0, slash);
}

/** Single store.put() with ALL structural fields. Called exactly once per session. */
export function persistOnce(session: SessionInfo, plan: SessionSetupPlan, store: SessionStore): void {
	const existing = store.get(session.id);
	const runtime = plan.runtime ?? runtimeFromModelString(plan.initialModel) ?? "pi";
	const claudeCodeModelAlias = runtime === "claude-code"
		? (plan.bridgeOptions.claudeCodeModelAlias || modelAliasFromModelString(plan.bridgeOptions.initialModel) || modelAliasFromModelString(plan.initialModel) || "default")
		: undefined;
	const persistedModelProvider = runtime === "claude-code"
		? "claude-code"
		: modelProviderFromModelString(plan.bridgeOptions.initialModel || plan.initialModel);
	const persistedModelId = runtime === "claude-code"
		? claudeCodeModelAlias
		: modelAliasFromModelString(plan.bridgeOptions.initialModel || plan.initialModel);
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
		teamGoalId: plan.teamGoalId,
		teamLeadSessionId: plan.teamLeadSessionId,
		assistantType: plan.assistantType,
		role: plan.role ?? plan.roleName,
		worktreePath: plan.worktreePath,
		worktreePushPolicy: plan.worktreePushPolicy,
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
		modelProvider: persistedModelProvider,
		modelId: persistedModelId,
		runtime,
		claudeCodeSessionId: runtime === "claude-code" ? (plan.bridgeOptions.claudeCodeSessionId || plan.claudeCodeSessionId || existing?.claudeCodeSessionId) : undefined,
		claudeCodeExecutable: runtime === "claude-code" ? (plan.bridgeOptions.claudeCodeExecutable || "claude") : undefined,
		claudeCodePermissionMode: runtime === "claude-code" ? (plan.bridgeOptions.claudeCodePermissionMode || "acceptEdits") : undefined,
		claudeCodeModelAlias,
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
	await resolveDynamicContext(plan, ctx);
	resolvePrompt(plan, ctx);
	resolveToolActivation(plan, ctx);
	resolvePreExistingTranscriptSetupMode(plan);
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
				// Effective goal (own goal else team/parent goal) so sandbox token
				// scoping and the container-worktree goalProvisioned dispatch resolve
				// the SAME inherited metadata for members/delegates as for the lead.
				goalId: effectiveGoalId(plan),
				sandboxBranch: plan.sandboxBranch,
				sandboxBaseBranch: plan.sandboxBaseBranch,
				sandboxCwdOffset: plan.sandboxCwdOffset,
			}),
			{ retries: 1, delays: [1000], label: "wireSandbox", sessionId: plan.id, nonRetryable: isUnresolvedHeadWorktreeError },
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

	// Step 8: spawn agent. Label includes the session class (sizing work for
	// docs/design/in-process-bridge-spike.md "Instrument first" — splits the
	// BOBBIT_E2E_PROFILE spawn-timing table by class so it answers "does the
	// ~400-700ms split by class" without a separate pass). Zero behavior
	// change: profileAsync/recordElapsed are no-ops unless BOBBIT_E2E_PROFILE=1
	// (see profiling.ts), and the class check is a cheap boolean read.
	const spawnClass = spawnSessionClass(plan);
	const session = await profileAsync(`executePlan.spawnAgent.${spawnClass}`, () => spawnAgent(plan, ctx));

	// Step 9: update persistence with full session data (agentSessionFile, etc.)
	persistOnce(session, plan, ctx.store);

	// Step 10: post-spawn setup (model, thinking level). Model binding is
	// awaited before the session is returned/live so explicit failures cannot
	// continue on provider/runtime defaults.
	try {
		await profileAsync(`executePlan.postSpawn.${spawnClass}`, () => postSpawn(session, plan, ctx));
	} catch (err) {
		const setupError = err instanceof Error ? err : new Error(String(err));
		handleSetupFailure(session, plan, setupError, ctx);
		throw setupError;
	}

	// Normal/delegate sessions are not broadcast until createSession returns, but
	// the returned object must be ready only after model enforcement succeeds.
	if (session.status !== "terminated") session.status = "idle";

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
		// Pool/prebuilt worktrees skip component setup, so dispatch the
		// goalProvisioned hook HERE too — a metadata-driven filesystem treatment
		// must land on pooled worktrees, not only cold-created ones.
		await dispatchGoalProvisionedHook(plan, ctx, worktreeCwd);
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
		type WorktreeCreationOptions = {
			worktreeRoot?: string;
			configuredBaseRef?: string;
			pushPolicy?: WorktreePushPolicy;
		};
		if (isMulti) {
			const { createWorktreeSet } = await import("../skills/git.js");
			const worktreeRoot = ctx.projectConfigStore?.get("worktree_root") || undefined;
			const worktreeOptions: WorktreeCreationOptions = { worktreeRoot, configuredBaseRef, pushPolicy: plan.worktreePushPolicy };
			const result = await withRetry(
				async () => createWorktreeSet(plan.repoPath!, components, plan.branch!, undefined, worktreeOptions),
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
			try {
				worktreeCwd = await withRetry(
					async () => {
						const worktreeOptions: WorktreeCreationOptions = { configuredBaseRef, pushPolicy: plan.worktreePushPolicy };
						const result = await createWorktree(plan.repoPath!, plan.branch!, worktreeOptions);
						return result.worktreePath;
					},
					{ retries: 2, delays: [1000, 2000], label: "createWorktree", sessionId: plan.id, nonRetryable: isUnresolvedHeadWorktreeError },
				);
			} catch (err) {
				if (!isUnresolvedHeadWorktreeError(err)) throw err;
				noWorktreeFallback = true;
				console.warn(`[session-setup] ${err.message}; running without a worktree in ${plan.cwd}`);
			}
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

		// Cold-path worktree provisioned — dispatch the goalProvisioned hook so
		// metadata-driven filesystem treatments land on this worktree (matches the
		// pool/prebuilt path above). Skipped when no worktree was created.
		if (!noWorktreeFallback) {
			await dispatchGoalProvisionedHook(plan, ctx, worktreeCwd);
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
		// Same offset the goalProvisioned hook was dispatched with above.
		const offsetCwd = offsetWorktreeCwd(plan, worktreeCwd);

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
	ctx.store.update(session.id, {
		runtime: plan.runtime ?? "pi",
		claudeCodeExecutable: plan.runtime === "claude-code" ? (plan.bridgeOptions.claudeCodeExecutable || "claude") : undefined,
		claudeCodePermissionMode: plan.runtime === "claude-code" ? (plan.bridgeOptions.claudeCodePermissionMode || "acceptEdits") : undefined,
		claudeCodeModelAlias: plan.runtime === "claude-code" ? (plan.bridgeOptions.claudeCodeModelAlias || modelAliasFromModelString(plan.bridgeOptions.initialModel) || "default") : undefined,
	});
	resolveGoalExtensions(plan, ctx);
	resolveTools(plan, ctx);
	await resolveDynamicContext(plan, ctx);
	resolvePrompt(plan, ctx);
	resolveToolActivation(plan, ctx);
	resolvePreExistingTranscriptSetupMode(plan);

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
				// Effective goal (own goal else team/parent goal) so sandbox token
				// scoping and the container-worktree goalProvisioned dispatch resolve
				// the SAME inherited metadata for members/delegates as for the lead.
				goalId: effectiveGoalId(plan),
				sandboxBranch: plan.sandboxBranch,
				sandboxBaseBranch: plan.sandboxBaseBranch,
				sandboxCwdOffset: plan.sandboxCwdOffset,
			}),
			{ retries: 1, delays: [1000], label: "wireSandbox", sessionId: plan.id, nonRetryable: isUnresolvedHeadWorktreeError },
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

	// Create real bridge (replacing placeholder). __worktreeSpawnAgentT0 spans
	// bridge creation through the pre-postSpawn persist below, mirroring
	// executePlan()'s `executePlan.spawnAgent.<class>` window for this sibling
	// path — see docs/design/in-process-bridge-spike.md "Instrument first".
	const __worktreeSpawnAgentT0 = performance.now();
	const rpcClient = createSessionBridge(plan.bridgeOptions);
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

	plan.bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => ctx.recordPiExtensionDiagnostic?.(session, diagnostic, extension);

	// Subscribe to events
	session.unsubscribe = subscribeToEvents(session, ctx);

	// Start agent with retry. Labeled by session class (same sizing
	// instrumentation as the executePlan() spawnAgent() path above — this is
	// the worktree-pool sibling of that path, used by default (non-bypass)
	// session creation) — see docs/design/in-process-bridge-spike.md
	// "Instrument first".
	const __worktreeSpawnClass = spawnSessionClass(plan);
	const __worktreeSpawnT0 = performance.now();
	await withRetry(
		() => rpcClient.start(),
		{ retries: 2, delays: [500, 1000], label: "rpcClient.start", sessionId: plan.id },
	);
	recordElapsed(`spawnAgent.rpcStart.${__worktreeSpawnClass}`, performance.now() - __worktreeSpawnT0);

	// Continue-Archived: rehydrate from the cloned JSONL before persisting.
	const preExistingMode = resolvePreExistingTranscriptSetupMode(plan);
	if (preExistingMode === "switch-session") {
		let preExistingSessionFile = plan.preExistingAgentSessionFile;
		if (!preExistingSessionFile) throw new Error("switch_session requested without a pre-existing transcript path");
		// The continue handler pre-computes the cloned-.jsonl path against the
		// project-root cwd. For worktree-backed sessions, the agent CLI boots
		// with cwd=offsetCwd (the worktree path), and `formatAgentSessionFilePath`
		// embeds a slug derived from cwd in the path. So the clone is currently
		// stranded under the project-root slug-dir. Rebase it onto the agent's
		// actual cwd-slug before issuing switch_session.
		const { formatAgentSessionFilePath } = await import("./agent-session-path.js");
		const correctPath = formatAgentSessionFilePath(plan.cwd, Date.now(), session.id);
		if (correctPath !== preExistingSessionFile) {
			const { sessionFileCopy, sessionFileDelete } = await import("./session-fs.js");
			const fsCtx = { sandboxed: !!plan.sandboxed, projectId: plan.projectId };
			if (plan.sandboxed) {
				// Container-side: copy via docker exec then delete the old file.
				await sessionFileCopy(fsCtx, preExistingSessionFile, fsCtx, correctPath, ctx.sandboxManager);
				await sessionFileDelete(fsCtx, preExistingSessionFile, ctx.sandboxManager).catch(() => {});
			} else {
				// Host-side: prefer rename, fall back to copy+unlink for cross-device.
				const fsp = await import("node:fs/promises");
				await fsp.mkdir(path.dirname(correctPath), { recursive: true });
				try {
					await fsp.rename(preExistingSessionFile, correctPath);
				} catch (err) {
					await fsp.copyFile(preExistingSessionFile, correctPath);
					await fsp.unlink(preExistingSessionFile).catch(() => {});
				}
			}
			preExistingSessionFile = correctPath;
			plan.preExistingAgentSessionFile = correctPath;
			ctx.store.update(session.id, { agentSessionFile: correctPath });
		}

		const transcriptFsCtx = { sandboxed: !!plan.sandboxed, projectId: plan.projectId };
		if (plan.preExistingAgentSessionOldCwds?.length) {
			await rebaseAgentTranscriptCwdMetadataFile(
				transcriptFsCtx,
				preExistingSessionFile,
				ctx.sandboxManager,
				{ oldCwds: plan.preExistingAgentSessionOldCwds, newCwd: plan.cwd },
			);
		}

		// Un-poison any blank-text user messages in the cloned transcript before
		// the agent rehydrates from it (best-effort, non-fatal).
		await sanitizeAgentTranscriptFile(
			transcriptFsCtx,
			preExistingSessionFile,
			ctx.sandboxManager,
		);
		const switchTimeout = plan.sandboxed ? 60_000 : 15_000;
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: preExistingSessionFile },
			switchTimeout,
		);
		if (!switchResp.success) {
			await rpcClient.stop().catch(() => {});
			throw new Error(`switch_session failed: ${switchResp.error}`);
		}
	} else if (preExistingMode === "claude-code-resume") {
		// Claude Code resumes from its own session id via bridge options/startup args;
		// Pi's transcript-path switch_session command is unsupported for this runtime.
		console.log(`[session-setup] Using Claude Code session-id resume for ${session.id}; skipping switch_session transcript rehydrate.`);
	}

	// Persist agentSessionFile to disk BEFORE flipping status to idle. Otherwise
	// a kill (crash, taskkill, OS shutdown) in the gap between idle and the
	// post-spawn fire-and-forget persist archives the session on next boot,
	// because restoreOneSession() refuses to restore a session whose persisted
	// agentSessionFile is empty. Pre-existing cloned transcripts are already
	// recorded above; avoid get_state rewriting their runtime metadata. See
	// tests/manual-integration/restart-minimal.spec.ts.
	if (ctx.persistSessionMetadata && !plan.preExistingAgentSessionFile) {
		// Sizing note (docs/design/in-process-bridge-spike.md "Instrument
		// first"): this is the first real `getState()` RPC round trip after
		// spawn (full tool/extension graph loaded, unlike the spike's isolated
		// `--no-builtin-tools` bench) — measure it separately from
		// `spawnAgent.rpcStart` since it dominates real spawn-to-idle latency.
		const __t = performance.now();
		try { await ctx.persistSessionMetadata(session); }
		catch (err) { console.warn(`[session-setup] persistSessionMetadata pre-idle failed for ${session.id}:`, err); }
		recordElapsed(`persistSessionMetadata.${__worktreeSpawnClass}`, performance.now() - __t);
	}

	recordElapsed(`executeWorktreeAsync.spawnAgent.${__worktreeSpawnClass}`, performance.now() - __worktreeSpawnAgentT0);

	// Enforce explicit model selection before marking the session idle/live. This
	// prevents a failed selected model from silently continuing on provider or
	// runtime defaults. Thinking-level application remains non-fatal below.
	await profileAsync(`executeWorktreeAsync.postSpawn.${__worktreeSpawnClass}`, () => postSpawn(session, plan, ctx));

	// Notify connected clients that the session is ready (single writer + version bump).
	broadcastStatus(session, "idle");
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Classify a session for spawn-timing sizing (BOBBIT_E2E_PROFILE label
 * suffix only — never affects routing/eligibility). Mirrors, but does not
 * reuse, `isInProcessBridgeEligible`'s three-way distinction so this stays
 * import-free of the bridge-eligibility module: "sandboxed" (Docker
 * containment; always out-of-process), "readOnly" (no bash/edit/write —
 * the in-process-bridge-eligible class when un-sandboxed), "exec"
 * (code-executing, un-sandboxed — e.g. host-level agents). See
 * docs/design/in-process-bridge-spike.md "Instrument first".
 */
function spawnSessionClass(plan: SessionSetupPlan): "sandboxed" | "readOnly" | "exec" {
	if (plan.sandboxed || plan.bridgeOptions?.containerId) return "sandboxed";
	if (plan.readOnly) return "readOnly";
	return "exec";
}

/**
 * Warm-pool eligibility gate (wave 1, docs/design/warm-pi-process-pool.md).
 *
 * Narrower than the doc's own literal "pool the exec class only" (§8 step
 * 3), for reasons discovered during implementation that the doc did not
 * anticipate: several pieces of `RpcBridgeOptions.env` are baked into the
 * child process at spawn time — same as cwd/extensions/system-prompt — with
 * no RPC to change them post-spawn, and are session-IDENTITY-bearing, not
 * just session-content:
 *
 *   - `BOBBIT_GOAL_ID` (set whenever `plan.goalId` is present) is read
 *     directly by the goal-tools extension; a warm entry pre-spawned before
 *     any specific goal is known can never carry the right value.
 *   - Genuinely caller-supplied `plan.env` (custom toolEnv) and raw
 *     `plan.agentArgs` are, by construction, whatever an arbitrary caller
 *     wants — nothing generic can be pre-spawned to match them. NOTE:
 *     `plan.env` is NOT the same thing as "no env at all" — `SessionManager.
 *     createSession()` unconditionally merges its own `directGatewayEnv`
 *     (`BOBBIT_GATEWAY_URL`/`BOBBIT_TOKEN`) into `opts.env` for EVERY
 *     non-sandboxed session before the plan is even built (session-
 *     manager.ts's `scopedGatewayEnvForDirectAgent`), so `plan.env` is
 *     non-empty for virtually the entire target population, not just
 *     sessions with real custom env. Both keys are safe to bake generically
 *     into a pool entry: `BOBBIT_GATEWAY_URL` is a gateway-wide constant, and
 *     `BOBBIT_TOKEN` here is `SandboxTokenStore.register(projectId)` — an
 *     idempotent PROJECT-scoped token, not a per-session secret (confirmed
 *     in sandbox-token.ts: same string returned for every session in a
 *     project) — so it's already identical for any two sessions keyed to the
 *     same project, which the pool key already requires. Only OTHER keys
 *     (a genuinely custom toolEnv) disqualify a plan.
 *   - `assistantType`/`delegateOf`/`parentSessionId`/`childKind` sessions
 *     (orchestration children, goal/role assistants) carry additional
 *     context/recursion-guard plumbing not audited here for the same class
 *     of spawn-time-baked-identity issue.
 *   - `preExistingAgentSessionFile` sessions need a `switch_session` resume
 *     onto a SPECIFIC transcript; wave 1 keeps pool entries brand-new only
 *     (no resume path), matching the doc §3.1's "no switch_session issued
 *     yet" description of what a pool entry is.
 *   - Non-`pi` runtimes (Claude Code) aren't in scope.
 *
 * `BOBBIT_SESSION_ID`/`BOBBIT_SESSION_SECRET` are ALSO spawn-baked
 * per-identity env, but these are handled (not excluded) — see
 * `buildWarmPoolEntryOptions` and the claim-time aliasing in `spawnAgent()`.
 *
 * None of this is a hard architectural limit — it is wave 1 deliberately
 * shipping a smaller, easier-to-reason-about-safely slice than the doc's
 * text alone implies, disclosed here and in the PR body rather than
 * silently narrowing the doc's claimed prize.
 */
/**
 * `plan.env` keys `SessionManager` itself always injects for a non-sandboxed
 * session (never a caller's genuine custom toolEnv) — see this function's
 * doc comment for why both are safe to bake generically into a pool entry.
 */
const SESSION_MANAGER_INJECTED_ENV_KEYS = new Set(["BOBBIT_GATEWAY_URL", "BOBBIT_TOKEN"]);

export function isWarmPoolEligible(plan: SessionSetupPlan): boolean {
	if (plan.sandboxed || plan.bridgeOptions.containerId) return false;
	if (plan.readOnly) return false;
	if (plan.goalId || plan.teamGoalId) return false;
	if (plan.assistantType || plan.delegateOf || plan.parentSessionId || plan.childKind) return false;
	if (plan.preExistingAgentSessionFile) return false;
	if (plan.claudeCodeSessionId) return false;
	const runtime = plan.bridgeOptions.runtime;
	if (runtime && runtime !== "pi") return false;
	if (plan.env && Object.keys(plan.env).some(k => !SESSION_MANAGER_INJECTED_ENV_KEYS.has(k))) return false;
	if (plan.agentArgs && plan.agentArgs.length > 0) return false;
	if (!plan.projectId) return false;
	return true;
}

/**
 * Pool key: `(projectId, cwd, fingerprint-of-resolved-args)`. Doc §2.3.
 *
 * Computed from the FULLY resolved `plan.bridgeOptions` (after
 * `resolveToolActivation` etc. have run — i.e., inside `spawnAgent`, not
 * earlier), so a config/role/tool-policy change that alters the resolved
 * `--extension` list produces a different key automatically (doc §4 point
 * 2: "a config change... produces a different pool key going forward — old-
 * keyed entries simply age out via TTL", no explicit invalidation needed).
 * `systemPromptPath` is included defensively per the doc's §2.4 open
 * question (whether any role delivers its prompt via first-message instead
 * of `--system-prompt`).
 *
 * CONTENT, not path, is what's hashed for each `--extension`/system-prompt
 * file — discovered live (via an E2E trace) to be load-bearing, not just an
 * optimization: several generated extensions
 * (`tool-guard-extension.ts:78`'s `guard.ts`, `provider-bridge-
 * extension.ts:199`'s `bridge.ts`, `google-code-assist-provider-
 * extension.ts:102`'s `provider.ts`) embed the session's OWN id as a
 * `JSON.stringify(sessionId)` literal so their generated code knows which
 * `/api/sessions/<id>/...` URL to call back on — and are written under a
 * `sha256(code)`-named directory, so the PATH differs for every session even
 * when the role/tool-policy is byte-for-byte identical. Comparing those
 * paths literally means the key can NEVER repeat across two different
 * sessions (or a session and any pool placeholder, which has its own
 * distinct id too) — not "reduced hit rate" as originally assumed here, but
 * a silent, permanent 0% hit rate for any session using a guarded tool
 * policy or these providers (i.e., most real traffic). Hashing each
 * referenced file's CONTENT instead collapses two sessions with equivalent
 * policy/role/project down to the same key, exactly as intended, while a
 * genuine content difference (a real config/role change) still produces a
 * different key. Static on-disk paths (e.g. `dist/server/defaults/tools/
 * shell/extension.ts`, shared byte-for-byte by every session) hash
 * identically to themselves, so this is strictly more correct than
 * path-comparison, never less. `initialModel`/`initialThinkingLevel` remain
 * excluded — both are covered by `set_model`/`set_thinking_level` post-claim
 * (doc §2.2), so including them would only fragment the key for no
 * correctness reason.
 */
export function computeWarmPoolKey(plan: SessionSetupPlan): string {
	const args = plan.bridgeOptions.args ?? [];
	const normalizedArgs: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--extension" && typeof args[i + 1] === "string") {
			normalizedArgs.push(arg, fileContentFingerprint(args[i + 1], plan.id));
			i++;
		} else {
			normalizedArgs.push(arg);
		}
	}
	const systemPromptFingerprint = plan.bridgeOptions.systemPromptPath
		? fileContentFingerprint(plan.bridgeOptions.systemPromptPath, plan.id)
		: null;
	const fingerprint = createHash("sha256").update(JSON.stringify({
		args: normalizedArgs,
		systemPromptFingerprint,
	})).digest("hex").slice(0, 16);
	return `${plan.projectId}::${plan.bridgeOptions.cwd}::${fingerprint}`;
}

/**
 * Hash a referenced file's content for the pool key, with every occurrence
 * of THIS session's own id redacted first.
 *
 * The redaction is load-bearing, not defensive: several generated
 * extensions (`tool-guard-extension.ts:78`, `provider-bridge-
 * extension.ts:199`, `google-code-assist-provider-extension.ts:102`) embed
 * `JSON.stringify(sessionId)` as a literal in the generated CODE (needed so
 * the extension knows which `/api/sessions/<id>/...` URL to call back on) —
 * so their content genuinely differs, byte for byte, between any two
 * sessions even with identical role/tool-policy. Hashing raw content
 * without redaction would reproduce the exact same permanent-0%-hit-rate
 * bug this function replaced path-comparison to fix (see this function's
 * caller's doc comment) — it would just move the never-matches problem from
 * the path string into the content bytes. Redacting `sessionId` first
 * collapses two sessions with equivalent policy down to the same
 * fingerprint while still catching a REAL content difference (e.g. a
 * changed tool policy) — the pool-owned placeholder id baked into a
 * candidate warm entry never appears in the CLAIMING plan's own generated
 * files, so it's simply absent from `content` and the `.split/.join` is a
 * no-op for those, which is exactly the desired behavior.
 *
 * Falls back to the raw path on any read failure (nonexistent file,
 * permission error) — a degenerate but safe fallback: it behaves exactly
 * like a pre-fix path-literal comparison for that one entry, which only
 * risks under- not over-matching (never a wrong-context claim).
 */
function fileContentFingerprint(filePath: string, sessionId: string): string {
	try {
		const content = readFileSync(filePath, "utf-8");
		const redacted = sessionId ? content.split(sessionId).join("<SESSION_ID>") : content;
		return createHash("sha256").update(redacted).digest("hex").slice(0, 16);
	} catch {
		return filePath;
	}
}

/**
 * Build the `RpcBridgeOptions` for a warm-pool entry by RE-RUNNING the exact
 * same plan-resolution pipeline `executePlan()` uses (steps 1-6), against a
 * clone of the triggering plan whose `id` is the pool's own freshly-minted
 * placeholder — not a byte-for-byte clone of the triggering plan's own
 * already-resolved `bridgeOptions`.
 *
 * This is NOT simpler-than-necessary caution: a naive clone (this function's
 * first cut, fixed after a live E2E trace caught it) only overrides the two
 * env vars (`BOBBIT_SESSION_ID`/`BOBBIT_SESSION_SECRET`) and reuses
 * `plan.bridgeOptions.args` verbatim — but session identity is baked in
 * MORE than one place. `resolveToolActivation` (step 6) calls
 * `generateToolGuardExtension`/`writeProviderBridgeExtension`/
 * `writeGoogleCodeAssistProviderExtension` with `plan.id`, and EACH ONE
 * interpolates that id as a string literal directly into the GENERATED
 * EXTENSION FILE's source (e.g. tool-guard-extension.ts:
 * `const sessionId = ${JSON.stringify(sessionId)}`, later POSTing tool-grant
 * requests to `/api/sessions/<that id>/tool-grant-request`). A naive clone
 * would leave a pool entry's tool-guard/provider-bridge/google-code-assist
 * extensions permanently embedding the FIRST triggering session's id —
 * every later claimant would misroute those callbacks to a stranger session
 * (or a session that has since ended), not even to the pool's own
 * placeholder id the env-var fix handles correctly. Re-running the real
 * resolution steps with `poolOwnedId` as `plan.id` regenerates every one of
 * these files fresh, scoped correctly, with no per-mechanism allowlist to
 * keep in sync as new identity-embedding extensions are added later.
 *
 * `resolveGoalExtensions` is INCLUDED for parity with `executePlan()`'s step
 * order even though it's a no-op here — `isWarmPoolEligible` already
 * excludes `goalId`/`assistantType`, its only trigger conditions.
 * Sandbox wiring (`executePlan()` step 6-equivalent, "if (plan.sandboxed)")
 * is skipped — `isWarmPoolEligible` excludes sandboxed plans entirely.
 */
async function buildWarmPoolEntryOptions(plan: SessionSetupPlan, ctx: PipelineContext, poolOwnedId: string): Promise<RpcBridgeOptions> {
	const poolPlan: SessionSetupPlan = {
		...plan,
		id: poolOwnedId,
		bridgeOptions: {} as SessionBridgeOptions,
		effectiveAllowedTools: undefined,
		dynamicContextBlocks: undefined,
		promptPath: undefined,
	};
	resolveBridgeOptions(poolPlan, ctx);
	resolveGoalExtensions(poolPlan, ctx);
	resolveTools(poolPlan, ctx);
	await resolveDynamicContext(poolPlan, ctx);
	resolvePrompt(poolPlan, ctx);
	resolveToolActivation(poolPlan, ctx);
	poolPlan.bridgeOptions.onPiExtensionDiagnostic = undefined;
	return poolPlan.bridgeOptions;
}

/**
 * Create RpcBridge, subscribe events, start the agent process.
 * Returns the fully wired SessionInfo.
 */
async function spawnAgent(plan: SessionSetupPlan, ctx: PipelineContext): Promise<SessionInfo> {
	let warmClaim: { id: string; rpcClient: IRpcBridge } | null = null;
	if (ctx.piProcessPool && isWarmPoolEligible(plan)) {
		const key = computeWarmPoolKey(plan);
		try {
			warmClaim = await ctx.piProcessPool.claim(key, (poolOwnedId) => buildWarmPoolEntryOptions(plan, ctx, poolOwnedId));
		} catch (err) {
			console.warn(`[session-setup] warm-pool claim failed for ${plan.id} (falling back to cold spawn):`, err instanceof Error ? err.message : err);
			warmClaim = null;
		}
	}
	const rpcClient = warmClaim ? warmClaim.rpcClient : createSessionBridge(plan.bridgeOptions);
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
		// An explicit spawn-supplied title (e.g. the host.agents `pr-reviewer` reviewer's
		// "PR Walkthrough") must NOT be clobbered by first-prompt auto-title generation
		// (tryGenerateTitleFromPrompt skips when titleGenerated is true). createSession
		// defaults plan.title to "New session", so any other value is a deliberate title.
		titleGenerated: !!assistantDef || plan.mode === "delegate" || (!!plan.title && plan.title !== "New session"),
		goalId: plan.goalId,
		teamGoalId: plan.teamGoalId,
		teamLeadSessionId: plan.teamLeadSessionId,
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
		nonInteractive: plan.nonInteractive,
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

	// NOTE: for a warm-pool claim, this callback wiring is a no-op — the
	// claimed `rpcClient` was constructed (by the pool, at fill time) from
	// its OWN options object with `onPiExtensionDiagnostic: undefined` (see
	// `buildWarmPoolEntryOptions`), not from `plan.bridgeOptions`, so
	// mutating `plan.bridgeOptions` here doesn't reach it. Accepted wave-1
	// gap: pi-extension load-failure diagnostics are not recorded for a
	// warm-claimed session. Observability-only, not correctness-affecting.
	plan.bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => ctx.recordPiExtensionDiagnostic?.(session, diagnostic, extension);

	// Subscribe to events
	session.unsubscribe = subscribeToEvents(session, ctx);

	if (warmClaim) {
		console.log(`[session-setup] warm-pool claim wired for session ${session.id} (pool id ${warmClaim.id})`);
	} else {
		// Start agent with retry
		const __t = performance.now();
		await withRetry(
			() => rpcClient.start(),
			{ retries: 2, delays: [500, 1000], label: "rpcClient.start", sessionId: plan.id },
		);
		recordElapsed(`spawnAgent.rpcStart.${spawnSessionClass(plan)}`, performance.now() - __t);
	}

	// Continue-Archived: tell the agent CLI to rehydrate from the cloned JSONL
	// before we persist or flip to idle. Same RPC the restart-resume path uses.
	const preExistingMode = resolvePreExistingTranscriptSetupMode(plan);
	if (preExistingMode === "switch-session") {
		const preExistingSessionFile = plan.preExistingAgentSessionFile;
		if (!preExistingSessionFile) throw new Error("switch_session requested without a pre-existing transcript path");
		const transcriptFsCtx = { sandboxed: !!plan.sandboxed, projectId: plan.projectId };
		if (plan.preExistingAgentSessionOldCwds?.length) {
			await rebaseAgentTranscriptCwdMetadataFile(
				transcriptFsCtx,
				preExistingSessionFile,
				ctx.sandboxManager,
				{ oldCwds: plan.preExistingAgentSessionOldCwds, newCwd: plan.cwd },
			);
		}
		await sanitizeAgentTranscriptFile(
			transcriptFsCtx,
			preExistingSessionFile,
			ctx.sandboxManager,
		);
		const switchTimeout = plan.sandboxed ? 60_000 : 15_000;
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: preExistingSessionFile },
			switchTimeout,
		);
		if (!switchResp.success) {
			await rpcClient.stop().catch(() => {});
			throw new Error(`switch_session failed: ${switchResp.error}`);
		}
	} else if (preExistingMode === "claude-code-resume") {
		// Claude Code resumes from its own session id via bridge options/startup args;
		// Pi's transcript-path switch_session command is unsupported for this runtime.
		console.log(`[session-setup] Using Claude Code session-id resume for ${session.id}; skipping switch_session transcript rehydrate.`);
	}

	// Add to live-sessions map so persistSessionMetadata can resolve via getState.
	ctx.sessions.set(session.id, session);

	if (warmClaim) {
		// Identity rebind for a claimed warm-pool entry. The child process is
		// ALREADY RUNNING with `BOBBIT_SESSION_ID`/`BOBBIT_SESSION_SECRET` baked
		// to the pool's own placeholder id (`warmClaim.id`) — spawn-time env,
		// no RPC to change it. Rather than trying to change the running
		// process's identity, every place that resolves identity FROM that
		// baked env is taught the alias instead:
		//   - `SessionManager.getSession()` — the mcp-call/mcp-describe routes
		//     resolve the session from the client-supplied X-Bobbit-Session-Id
		//     header (itself just `process.env.BOBBIT_SESSION_ID` from inside
		//     the agent), so they must find THIS session via `warmClaim.id`.
		//   - `sessionSecretStore` — orchestration/children authz resolves the
		//     AUTHENTIC caller session id from the `X-Bobbit-Session-Secret`
		//     header; `rebind` makes that resolve to the real `session.id`.
		// `BOBBIT_TOKEN`/`BOBBIT_GATEWAY_URL` need no rebind: they're
		// project-scoped (`SandboxTokenStore.register()` is idempotent per
		// project, not per session — confirmed in sandbox-token.ts), so the
		// pool entry's already-baked token is already valid for this session;
		// `addSession`/`removeSession` below are bookkeeping only (no auth
		// check reads `sessionIds`), kept for accurate per-project tracking.
		session.warmPoolAliasId = warmClaim.id;
		ctx.registerWarmPoolIdentityAlias?.(warmClaim.id, session.id);
		ctx.sessionSecretStore.rebind(ctx.sessionSecretStore.getOrCreateSecret(warmClaim.id), session.id);
		if (plan.projectId) {
			ctx.sandboxTokenStore?.addSession(plan.projectId, session.id);
			ctx.sandboxTokenStore?.removeSession(plan.projectId, warmClaim.id);
		}

		// Correct the model/thinking level to THIS session's own pin. The pool
		// entry may have booted with a different (or no) `--model`/`--thinking`
		// CLI flag than what THIS plan resolved. This is NOT redundant with
		// `postSpawn()`'s `tryAutoSelectModel`: that path explicitly SKIPS
		// re-issuing `setModel` whenever `session.spawnPinnedModel` is set,
		// assuming (correctly for a cold spawn, WRONGLY for a warm claim) that
		// the CLI `--model` flag already achieved it at spawn time. Doc §2.2/
		// §3.1 step 2 call this out explicitly: "set_model/set_thinking_level
		// if the claiming session's model differs from whatever the pool entry
		// was spawned with." Best-effort here — postSpawn's own read-back
		// verification still runs afterward and is fatal on a real mismatch,
		// so a failure here surfaces loudly rather than silently.
		const initialModel = plan.bridgeOptions.initialModel;
		if (initialModel) {
			const slash = initialModel.indexOf("/");
			if (slash > 0 && slash < initialModel.length - 1) {
				try {
					await rpcClient.setModel(initialModel.slice(0, slash), initialModel.slice(slash + 1));
				} catch (err) {
					console.warn(`[session-setup] warm-pool claim: setModel failed for ${session.id} (postSpawn's read-back verification will catch a real mismatch):`, err instanceof Error ? err.message : err);
				}
			}
		}
		const initialThinkingLevel = plan.bridgeOptions.initialThinkingLevel;
		if (initialThinkingLevel) {
			try {
				await rpcClient.setThinkingLevel(initialThinkingLevel);
			} catch (err) {
				console.warn(`[session-setup] warm-pool claim: setThinkingLevel failed for ${session.id}:`, err instanceof Error ? err.message : err);
			}
		}
	}

	// Persist agentSessionFile BEFORE post-spawn model enforcement so the session
	// survives a hard kill in the setup window. Pre-existing cloned transcripts
	// are already recorded; avoid get_state rewriting their runtime metadata. See
	// worktree path for the full rationale.
	if (ctx.persistSessionMetadata && !plan.preExistingAgentSessionFile) {
		// Sizing note (docs/design/in-process-bridge-spike.md "Instrument
		// first") — see the matching comment in executeWorktreeAsync().
		const __t = performance.now();
		try { await ctx.persistSessionMetadata(session); }
		catch (err) { console.warn(`[session-setup] persistSessionMetadata pre-idle failed for ${session.id}:`, err); }
		const __elapsed = performance.now() - __t;
		recordElapsed(`persistSessionMetadata.${spawnSessionClass(plan)}`, __elapsed);
		// Warm-pool sizing (docs/design/warm-pi-process-pool.md): this
		// specific getState() round trip is the ~0.6-1.5s "post-spawn tool/
		// extension-graph load" cost PR #157 measured and this pool exists to
		// amortize — a warm-claimed session's child already paid it during
		// background fill, well before this request, so a HIT here should
		// read back near-instantly. Only recorded for pool-eligible plans so
		// the label's population is directly comparable (same session shape)
		// across hit/miss/pool-disabled.
		if (ctx.piProcessPool && isWarmPoolEligible(plan)) {
			recordElapsed(`persistSessionMetadata.pool.${warmClaim ? "hit" : "miss"}`, __elapsed);
		}
	}

	return session;
}

/**
 * Post-spawn setup for synchronous paths (normal, worktree, delegate).
 *
 * Model selection is awaited and fatal for every session type so explicit
 * selected-model failures cannot be hidden after spawn. Thinking-level setup is
 * a best-effort preference and remains a visible non-fatal warning.
 */
async function postSpawn(session: SessionInfo, plan: SessionSetupPlan, ctx: PipelineContext): Promise<void> {
	if (!plan.skipAutoModel) {
		await ctx.tryAutoSelectModel(session);
	}
	if (!plan.skipAutoThinking) {
		const thinkingPromise = ctx.tryApplyDefaultThinkingLevel(session).catch((err) => {
			console.warn(`[session-setup] Early thinking level failed for ${session.id}:`, err);
		});
		// Delegates send their first prompt immediately after setup; preserve the
		// previous ordering by applying a valid thinking-level preference first,
		// while still treating failures as non-fatal warnings.
		if (plan.mode === "delegate") await thinkingPromise;
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
	const safeErrorMessage = sanitizeModelErrorText(error);
	console.error(
		`[session-setup] Session ${session.id} setup failed ` +
		`(mode: ${plan.mode}, step: ${safeErrorMessage}): ${sanitizeModelErrorForLog(error)}`,
	);

	// 1. Surface a visible setup error in the live transcript before the session
	// is terminated/archived. This is especially important for post-spawn model
	// selection failures: they must not be downgraded to server-only warnings.
	if ((session as any).eventBuffer && session.clients) {
		emitSessionEvent(session, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: `Session setup failed: ${safeErrorMessage}` }],
				stopReason: "error",
				errorMessage: safeErrorMessage,
			},
		});
	}

	// 2. Stop the spawned agent if setup failed after rpcClient.start(). Fire and
	// forget: setup failure handling must not hang on a wedged provider process.
	try { session.unsubscribe?.(); } catch { /* best-effort */ }
	if ((session as any).rpcClient?.stop) {
		session.rpcClient.stop().catch((stopErr: unknown) => {
			console.warn(`[session-setup] Failed to stop setup-failed session ${session.id}:`, stopErr);
		});
	}

	// 3. Remove from in-memory map
	ctx.sessions.delete(session.id);

	// 4. Archive in store (preserves evidence)
	ctx.store.archive(session.id);

	// 5. Notify connected clients (single writer + version bump).
	broadcastStatus(session, "terminated");

	// 6. Background worktree cleanup (slow, non-blocking)
	if (plan.worktreePath && plan.repoPath && plan.branch) {
		const persistedSessions = ctx.listPersistedSessionsForWorktreeGuard?.() ?? ctx.store.getAll();
		if (!isWorktreePathReferencedByLiveSession(plan.worktreePath, persistedSessions, { ignoreSessionId: session.id })) {
			cleanupWorktree(plan.repoPath, plan.worktreePath, plan.branch, true).catch(() => {});
		} else {
			console.log(`[session-setup] Skipping setup-failure cleanup for shared worktree ${plan.worktreePath} (session ${session.id})`);
		}
	}

	// 7. Clean up sandbox token for this session
	if (ctx.sandboxTokenStore && plan.projectId) {
		ctx.sandboxTokenStore.removeSession(plan.projectId, session.id);
	}

	// 8. S1: drop the per-session capability secret.
	ctx.sessionSecretStore.remove(session.id);
}
