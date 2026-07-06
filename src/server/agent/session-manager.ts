import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import type {
	ServerMessage,
	QueuedMessage,
} from "../ws/protocol.js";
import { EventBuffer } from "./event-buffer.js";
import { GoalManager } from "./goal-manager.js";
import { TaskManager } from "./task-manager.js";
import { PromptQueue } from "./prompt-queue.js";
import { SearchService } from "../search/search-service.js";
import { RpcBridge, hostPathToContainer, type IRpcBridge, type RpcBridgeOptions, type RuntimePiExtensionInfo, type RuntimePiExtensionDiagnostic } from "./rpc-bridge.js";
import { assertRuntimeAllowedForSession, createSessionBridge, hydrateRuntimeOptions, resolveSessionRuntime } from "./session-runtime.js";
import { sessionFileExists, sessionFileRead, sessionFsContextForAgentFile } from "./session-fs.js";
import { isHostAbsoluteAgentSessionPath, safePersistedHostAgentSessionFile, sanitizeAgentTranscriptFile, trustPersistedAgentSessionFile } from "./transcript-sanitizer.js";
import type { SkillExpansion } from "../skills/resolve-skill-expansions.js";
import type { FileMention } from "../skills/resolve-file-mentions.js";
import { SessionStore, type PersistedSession, type WorktreePushPolicy, type SessionRuntime } from "./session-store.js";
import {
	ArchivedWorktreeManager,
	type ArchivedWorktreeDeps,
	type ArchivedSessionWorktreeScanResponse,
	type CleanupArchivedSessionWorktreesRequest,
	type CleanupArchivedSessionWorktreesResponse,
} from "./archived-worktree-manager.js";
export {
	CleanupArchivedSessionWorktreesRequestError,
	type ArchivedWorktreeLegacyStatus,
	type ArchivedWorktreeDisposition,
	type ArchivedWorktreeReason,
	type ArchivedWorktreeReasonCategory,
	type ArchivedWorktreeSelectionCategory,
	type ArchivedWorktreeCleanupStatus,
	type ArchivedWorktreeCleanupReason,
	type ArchivedSessionWorktreeScanResponse,
	type ArchivedSessionWorktreeGroup,
	type ArchivedSessionWorktreeSelectionPreset,
	type ArchivedSessionWorktreeSession,
	type ArchivedSessionWorktreeItem,
	type CleanupArchivedSessionWorktreesRequest,
	type CleanupArchivedSessionWorktreesResponse,
	type ArchivedSessionWorktreeCleanupResult,
} from "./archived-worktree-manager.js";
import { McpWiring, type McpWiringDeps } from "./mcp-wiring.js";
import { SessionCostPlumbing, type SessionCostPlumbingDeps } from "./session-cost-plumbing.js";
import { SessionLifecycleFence, type RestoreCoordinator, type SessionLifecycleFenceDeps } from "./session-lifecycle-fence.js";
export { type RestoreCoordinator, type LifecycleFenceSession, type SessionLifecycleFenceDeps } from "./session-lifecycle-fence.js";
import { SessionRevive, type SessionReviveDeps } from "./session-revive.js";
import { SessionSpawn } from "./session-spawn.js";
import { SessionSteering } from "./session-steering.js";
import { SessionBoot } from "./session-boot.js";
import { SessionModels, type SessionModelsDeps } from "./session-models.js";
import { SessionTranscripts, type SessionTranscriptsDeps } from "./session-transcripts.js";
import { SessionSetupPlumbing, type SessionSetupPlumbingDeps } from "./session-setup-plumbing.js";
export { resolveSandboxTokens, resolveLegacySandboxCredentials } from "./session-setup-plumbing.js";
import { BgProcessStore } from "./bg-process-store.js";
import { SessionSecretStore } from "../auth/session-secret.js";
import { redactSensitive } from "../auth/redact.js";
import { shouldKeepDespiteOrphan } from "./orphan-cleanup.js";
import { getAssistantDef } from "./assistant-registry.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { assembleSystemPrompt, cleanupSessionPrompt, persistPromptSections, type PromptParts, type PromptProfile } from "./system-prompt.js";
import { profile } from "./profiling.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics } from "./cpu-diagnostics.js";
import { generateSessionTitle, generateGoalSummaryTitle } from "./title-generator.js";
import { CostTracker, type SessionCost } from "./cost-tracker.js";
import type { ColorStore } from "./color-store.js";
import type { RoleManager } from "./role-manager.js";
import type { ToolManager } from "./tool-manager.js";
import { computeToolActivationArgs, writeMcpProxyExtensions, writeToolGuardExtension, computeEffectiveAllowedTools, tagAllowedTool, type EffectiveTool } from "./tool-activation.js";
import { hasProviderBridgeHooks, writeProviderBridgeExtension } from "./provider-bridge-extension.js";
import { prependToolResultErrorBridge } from "./tool-result-error-bridge-extension.js";
import { normalizeToolResultErrorEvent, normalizeToolResultErrorSnapshot } from "./tool-result-error-normalizer.js";
import { writeGoogleCodeAssistProviderExtension } from "./google-code-assist-provider-extension.js";
import { writeOpenAiOrphanToolResultExtension } from "./openai-orphan-tool-result-extension.js";
import { discoverSlashSkills, type SkillMarketContext } from "../skills/slash-skills.js";
import { headquartersDir } from "../bobbit-dir.js";
import { HEADQUARTERS_PROJECT_ID } from "./project-registry.js";
import { shouldSkipRemotePush, shouldSkipRemoteGitForTests, detectPrimaryBranch } from "../skills/git.js";
import { eagerDeleteRemoteSessionBranch } from "./session-eager-branch-delete.js";
import type { GrantPolicy, Role } from "./role-store.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import { decideOverflowAction } from "../ws-overflow-guard.js";

import { McpManager, type MarketplaceMcpResolver, type McpReloadResult } from "../mcp/mcp-manager.js";
import { makeMetaToolName, parseMcpToolName } from "../mcp/mcp-meta.js";
import { truncateLargeToolContent } from "./truncate-large-content.js";
import { getAigwUrl, deriveName } from "./aigw-manager.js";
import { defaultImageModelPref, getAvailableImageModels, parseImageModelPref } from "./image-generation.js";
import { isKnownThinkingLevel, type ThinkingLevel } from "../../shared/thinking-levels.js";
import { clampThinkingLevelForModel } from "./thinking-level-clamp.js";
import type { Decision } from "./decision-types.js";
import { THINKING_ROUTER_POINT, THINKING_ROUTER_KIND } from "./thinking-router-classifier.js";
import { TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, isToolApproveEnforceMode, isAutoDenyDecision, type ToolApproveVerdict } from "./tool-approve-classifier.js";
import { ToolPermissionAuditLog, type ToolPermissionAuditDecision, type ToolPermissionAuditSource } from "./tool-permission-audit-log.js";
import { resolveRolePrompt } from "./role-prompt.js";
import { applyPromptConditionals } from "./prompt-conditionals.js";
// createWorktree is used in session-setup.ts pipeline
import { ProjectContextManager } from "./project-context-manager.js";
import { GoalStore, type PersistedGoal } from "./goal-store.js";
import { PrStatusStore } from "./pr-status-store.js";
import { TaskStore } from "./task-store.js";
import type { GateStore } from "./gate-store.js";
import { bobbitStateDir, bobbitConfigDir } from "../bobbit-dir.js";
import { migratedActiveAgentSessionFileForHostPath } from "./agent-session-path.js";
import type { OrchestrationCoreView, InboxNudgerView, StaffRecordSource } from "./session-manager-consumer-types.js";

import type { SandboxManager } from "./sandbox-manager.js";
import type { LifecycleHub } from "./lifecycle-hub.js";
import { WorktreePool } from "./worktree-pool.js";
import { PiProcessPool, isWarmPoolEnabled } from "./pi-process-pool.js";
import { backfillStaffIds as backfillStaffIdsImpl } from "./staff-backfill.js";
import {
	type PipelineContext,
	type SandboxWiringOptions,
	type MarketplacePiExtensionResolver,
	type MarketplacePiExtensionActivation,
	type PiExtensionDiagnostic,
	resolveMarketplacePiExtensionActivation,
	scopedToolContext,
} from "./session-setup.js";

const execFileAsync = promisify(execFileCb);

export function extractClaudeCodeSessionId(value: any): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	for (const key of ["claudeCodeSessionId", "session_id"] as const) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return extractClaudeCodeSessionId(value.data) ?? extractClaudeCodeSessionId(value.result) ?? extractClaudeCodeSessionId(value.metadata);
}

function canResumeClaudeCodeSession(ps: Pick<PersistedSession, "runtime" | "modelProvider" | "claudeCodeSessionId"> | undefined): boolean {
	if (!ps || typeof ps.claudeCodeSessionId !== "string" || !ps.claudeCodeSessionId.trim()) return false;
	return resolveSessionRuntime({ runtime: ps.runtime, modelProvider: ps.modelProvider }) === "claude-code";
}

export function switchSessionPathForAgent(ps: PersistedSession): string {
	if (!ps.sandboxed || !isHostAbsoluteAgentSessionPath(ps.agentSessionFile)) return ps.agentSessionFile;
	const mountedHostPath = migratedActiveAgentSessionFileForHostPath(ps.agentSessionFile) ?? ps.agentSessionFile;
	return hostPathToContainer(mountedHostPath);
}


export type SessionStatus = "starting" | "preparing" | "idle" | "streaming" | "aborting" | "terminated";

export type RestartRedriveSnapshot = {
	status: SessionStatus;
	/**
	 * Set only while restoreSession() is recreating a persisted session. During
	 * that restore-startup window, `starting` is a lifecycle state, not proof of
	 * an interrupted turn; the persisted pre-restore value stays authoritative.
	 */
	restoreStartupWasStreaming?: boolean;
};

/**
 * Durable restart re-drive marker for every active/busy session state.
 * The persisted field is still named `wasStreaming` for compatibility, but
 * restart recovery must cover real non-idle/non-terminal work — not cold
 * restore-startup of a previously idle session.
 */
export function sessionNeedsRestartRedrive(snapshot: SessionStatus | RestartRedriveSnapshot): boolean {
	const status = typeof snapshot === "string" ? snapshot : snapshot.status;
	const restoreStartupWasStreaming = typeof snapshot === "string" ? undefined : snapshot.restoreStartupWasStreaming;
	if (status === "idle" || status === "terminated") return false;
	if (status === "starting" && restoreStartupWasStreaming !== undefined) return restoreStartupWasStreaming;
	return true;
}

/**
 * Max consecutive errored agent turns before an incoming prompt/steer is
 * parked instead of implicitly unsticking the session. Counter increments on
 * every `message_end` with `stopReason:"error"` and resets on any successful
 * terminal assistant message OR on an explicit `retryLastPrompt` call.
 */
type ToolGrantMode = "persistent" | "session-only" | "one-time";
type ToolGrantResolution = { granted: boolean; tools?: string[]; scope?: "tool" | "group"; group?: string; mode?: ToolGrantMode; reason?: string };

const PROVIDER_AUTH_FAILURE_PATTERNS = [
	/No API key found for\s+([A-Za-z0-9_.-]+)/i,
	/Missing API key for\s+([A-Za-z0-9_.-]+)/i,
	/([A-Za-z0-9_.-]+)\s+API key is missing/i,
];

function looksLikeSensitiveToken(value: string | undefined): boolean {
	return !!value && /^(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|ya29|xox[baprs]?)[-_]/i.test(value);
}

function safeProviderId(provider: string | undefined): string | undefined {
	if (!provider) return undefined;
	const normalized = provider.toLowerCase();
	if (looksLikeSensitiveToken(normalized)) return undefined;
	return normalized;
}

export function providerFromAuthFailure(message: string | undefined, fallbackProvider?: string): string | undefined {
	const safeFallback = safeProviderId(fallbackProvider);
	if (!message) return safeFallback;
	for (const pattern of PROVIDER_AUTH_FAILURE_PATTERNS) {
		const match = message.match(pattern);
		const safeMatch = safeProviderId(match?.[1]);
		if (safeMatch) return safeMatch;
	}
	return safeFallback;
}

export function isProviderAuthFailure(message: string | undefined): boolean {
	return !!message && PROVIDER_AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(message));
}

export function providerLabel(provider: string | undefined): string {
	if (!provider) return "provider";
	if (provider.toLowerCase() === "openrouter") return "OpenRouter";
	return provider;
}

export function redactDispatchFailureReason(reason: string, providerAuthFailure: boolean, fallbackProvider?: string): string {
	if (providerAuthFailure) {
		const provider = providerFromAuthFailure(reason, fallbackProvider);
		return `${providerLabel(provider)} provider authentication failure (missing-api-key)`;
	}
	return redactSensitive(reason)
		.replace(/\b(?:sk|pk|rk)-(?:or-)?[A-Za-z0-9_-]{4,}\b/gi, "<redacted-api-key>")
		.slice(0, 500);
}

/**
 * Returns true only for rpc events that represent genuine new user-visible
 * activity (a message, tool call, or end-of-turn). Lifecycle frames the
 * agent CLI emits automatically on resume (agent_start, agent_idle,
 * connection_state, state, session_title, etc.) return false so they don't
 * clobber the persisted `lastActivity` timestamp on restore / role-restart /
 * abort-restart paths.
 *
 * See goal `goal-fix-lastac-724b3421` for the bug this guards against.
 */
export function isUserVisibleActivity(event: any): boolean {
	if (!event || typeof event.type !== "string") return false;
	switch (event.type) {
		case "message_update":
		case "message_end":
		case "tool_execution_start":
		case "tool_execution_end":
		case "agent_end":
			return true;
		default:
			return false;
	}
}

/** Provenance of a prompt enqueued into a session. Read by TeamManager on
 *  agent_start to decide whether to reset idle-nudge backoff counters.
 *  Only "user" and "system" reset the counter; everything else preserves it. */
export type PromptSource =
	| "user"
	| "auto-nudge"
	| "task-notification"
	| "verification"
	| "system"
	| "agent"
	// Extension Host C2: a pack's `host.session.postMessage` drove this prompt
	// (gesture-gated, allowedTools-scoped, audited — see session-write.ts).
	| "extension";

export interface SessionInfo {
	id: string;
	title: string;
	cwd: string;
	status: SessionStatus;
	/** Monotonic version of `session.status`. Bumped on every status transition
	 *  (via `broadcastStatus`). Heartbeats re-broadcast WITHOUT bumping so the
	 *  client can treat them as idempotent. In-memory only — not persisted.
	 *  See docs/design/unify-session-status.md. */
	statusVersion: number;
	createdAt: number;
	lastActivity: number;
	clients: Set<WebSocket>;
	rpcClient: IRpcBridge;
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
	/** First-class parent session ID for visible child sessions (not delegate lifecycle). */
	parentSessionId?: string;
	/** Kind discriminator for first-class child sessions, e.g. "pr-walkthrough". */
	childKind?: string;
	/** Whether the session should be treated as read-only by clients/tools. */
	readOnly?: boolean;
	/** Generic persisted terminal marker for a child session (orchestration-core
	 *  Decision E). Stamped by `markChildTerminal`; drives the generic boot-reap. */
	childTerminal?: boolean;
	/** Epoch ms when `childTerminal` was stamped. */
	terminalAt?: number;
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
	/** Whether this session runs inside a Docker sandbox */
	sandboxed?: boolean;
	/** Container ID if using a pooled Docker container */
	containerId?: string;
	/** Whether this is an automated non-interactive session (e.g. verification reviewer) */
	nonInteractive?: boolean;
	/** Which project this session belongs to */
	projectId?: string;
	/**
	 * Set only when this session's `rpcClient` came from a warm-pool claim
	 * (docs/design/warm-pi-process-pool.md) — the pool-owned placeholder id
	 * baked into the child process's `BOBBIT_SESSION_ID`/`BOBBIT_SESSION_SECRET`
	 * env at spawn time. See `SessionManager.getSession()`/
	 * `piPoolIdentityAliases` for why this alias must be resolvable.
	 */
	warmPoolAliasId?: string;
	/** Allowed tools for this session */
	allowedTools?: string[];
	/** Server-side prompt queue */
	promptQueue: PromptQueue;
	/** Queue row IDs re-enqueued after prompt delivery failed before agent_start. */
	recoveredPromptDispatchQueueIds?: string[];
	/** Error message captured when restoreSession() failed; cleared on successful revive. */
	restoreError?: string;
	/**
	 * Persisted wasStreaming value captured while restoreSession() is in its
	 * startup window. Prevents rapid shutdown during cold restore from converting
	 * a previously idle interactive session into a false interrupted-turn prompt.
	 */
	restoreStartupWasStreaming?: boolean;
	/**
	 * True for a DORMANT entry (restored delegate/kinded child whose agent process
	 * is NOT running — placeholder RpcBridge). Used by `isSessionLive` so the
	 * OrchestrationCore wait path resolves such a child from persisted output
	 * instead of blocking on a dead client (H1). Cleared once `restoreSession`
	 * replaces the entry with a live one.
	 */
	dormant?: boolean;
	/** In-flight persistSessionMetadata promise (awaited before terminate) */
	pendingMetadataPersist?: Promise<void>;
	/**
	 * Model literal (`<provider>/<modelId>`) that was passed to pi-coding-agent
	 * via `--model` at spawn time. When set, post-spawn `tryAutoSelectModel`
	 * skips the redundant `setModel` RPC if it would bind the same model;
	 * read-back verification still runs.
	 */
	spawnPinnedModel?: string;
	/** Thinking level passed via `--thinking` at spawn time, if any. */
	spawnPinnedThinkingLevel?: string;
	/**
	 * CLF-W3 — true only when the user EXPLICITLY changed this session's
	 * thinking level via the `set_thinking_level` ws action (ws/handler.ts) —
	 * never set by spawn-time role/preference resolution, which also writes
	 * `spawnPinnedThinkingLevel` but is not a human decision. Consulted by
	 * `canApplyThinkingRouterDecision` so the F14 thinking-router's apply mode
	 * (`BOBBIT_CLF_THINKING_ROUTER=enforce`) can never silently override a
	 * setting the user picked on purpose. Persisted via `SessionStore` so the
	 * precedence survives restore/respawn.
	 */
	thinkingLevelUserPinned?: boolean;
	/**
	 * Baseline level to restore after CLF-W3 thinking-router apply mode
	 * transiently escalates the live runtime. In-memory only: it describes the
	 * currently running process, not durable user/session config.
	 */
	thinkingRouterAppliedBaseline?: ThinkingLevel;
	/** True if the last agent turn ended due to a model/API error */
	lastTurnErrored?: boolean;
	/** Error message from the last errored turn (e.g. streaming JSON parse failure) */
	lastTurnErrorMessage?: string;
	/** Number of consecutive auto-retries attempted for transient errors on this turn */
	transientRetryAttempts?: number;
	/** Number of consecutive immediate (tick-0) redrains scheduled by
	 * recoverPromptDispatch after a rejected dispatch. Bounded by
	 * MAX_RECOVER_DRAIN_RETRIES to stop a busy-guard spin loop. Reset to 0 on a
	 * successful dispatch and at each agent_end before the queue drains. */
	recoverDrainAttempts?: number;
	/** Count of consecutive agent turns that ended with stopReason:"error". Resets on any non-error message_end or explicit retry. */
	consecutiveErrorTurns?: number;
	/** Pending auto-retry timer, so we can cancel it if the session terminates */
	pendingAutoRetryTimer?: ReturnType<typeof setTimeout>;
	/** Per-session lifecycle generation used to fence stale SessionInfo writers after restore/respawn. */
	lifecycleGeneration?: number;
	/** True once this SessionInfo has been replaced or is being replaced by a restore/respawn. */
	lifecycleFenced?: boolean;
	/** Whether tool calls were executed during the current/last turn */
	turnHadToolCalls?: boolean;
	/** Timestamp when the current streaming turn started */
	streamingStartedAt?: number;
	/** Number of agent turns that have completed (agent_end fired). Used by
	 * tests to detect that a prompt has actually been processed end-to-end
	 * — polling for `status==idle` alone races with the pre-prompt idle
	 * state, so observability of “a turn finished” needs its own counter. */
	completedTurnCount?: number;
	/** Monotonic counter bumped only by inbound agent events that prove the
	 * agent observed/advanced a turn. Local status changes such as aborting do
	 * not affect it, so prompt-dispatch recovery can distinguish those cases. */
	agentObservedTurnVersion?: number;
	/** Last user prompt text, for retry on fresh-response errors */
	lastPromptText?: string;
	/** Last user prompt images, for retry on fresh-response errors */
	lastPromptImages?: Array<{ type: "image"; data: string; mimeType: string }>;
	/** Provenance of the last prompt enqueued to this session. Set by
	 *  enqueuePrompt / deliverLiveSteer. Defaults to "user" when callers
	 *  don't supply a source. Read by TeamManager.subscribeTeamLeadEvents. */
	lastPromptSource?: PromptSource;
	/** Pending grant request from the guard extension's long-poll */
	pendingGrantRequest?: {
		resolve: (result: ToolGrantResolution) => void;
		reject: (err: Error) => void;
		toolName: string;
		toolGroup: string;
		toolApproveDecision?: Decision<ToolApproveVerdict>;
		timer: ReturnType<typeof setTimeout>;
		/** seq/ts of the original `tool_permission_needed` broadcast — replayed
		 * verbatim to late-joining clients so we never burn a fresh global seq
		 * on a unicast frame. See tests/perm-frame-late-joiner-seq-gap.test.ts. */
		seq: number;
		ts: number;
	};
	/** Tools granted via "session-only" mode — re-applied across Refresh agent, not persisted to disk. */
	sessionOnlyGrantedTools?: string[];
	/** Tools granted via "one-time" mode — used for server-side allow checks and revoked on agent_end. */
	oneTimeGrantedTools?: string[];
	/** Whether post-start setup (model, thinking, metadata) has completed */
	setupComplete?: boolean;
	/** User text echoed during the current/just-finished turn; passed to afterTurn providers. */
	latestTurnUserText?: string;
	/** Assistant final text from the current/just-finished turn; passed to afterTurn providers. */
	latestTurnAssistantText?: string;
	/** Cached PromptParts for serving prompt-sections API */
	promptParts?: PromptParts;
	/**
	 * FIFO queue of pending skill-expansion envelopes awaiting echo-back from
	 * the agent. Each entry carries the modelText (what the agent will echo as
	 * the user message body), the originalText we want the chat UI to display,
	 * and the chip ranges. When a user-role message_end arrives whose text
	 * equals `modelText`, we splice the matching envelope onto the message:
	 * rewrite `content` to `originalText` and attach `skillExpansions`.
	 */
	pendingSkillExpansions?: Array<{
		modelText: string;
		originalText: string;
		skillExpansions: SkillExpansion[];
		/** `@path` file-mention chips re-attached alongside skill expansions. */
		fileMentions?: FileMention[];
	}>;
	/** Repo path (cached from worktree provisioning). */
	repoPath?: string;
	/** Active branch name. Mirrors the persisted store; stable for the session's lifetime. */
	branch?: string;
	/** Worktree branch publication policy; scoped sub-agent branches are local-only by default. */
	worktreePushPolicy?: "local-only" | "publish";
	/** Back-compat alias for persisted publication policy metadata. */
	remotePublicationPolicy?: "local-only" | "publish";
	/** Multi-repo: per-repo worktree paths from the pool claim. Stable for the session's lifetime. */
	repoWorktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }>;
	/**
	 * Shadow ledger of steer texts that have been accepted for live-steer
	 * dispatch but have not yet echoed back as a user-role `message_end`.
	 * Persisted with promptQueue row removal so a gateway restart in the
	 * dispatch→echo window can re-enqueue the steer exactly once.
	 *
	 * Lifecycle:
	 *   - push: in `_dispatchSteer`, before queue row removal is persisted.
	 *   - splice: on `message_end(role:user)` whose body matches the front entry,
	 *     mirroring `_processAgentEvent`'s `_steeringMessages.indexOf` removal.
	 *   - drain: in restore/abort reconciliation — re-enqueue at front so the next
	 *     turn redispatches them as a steered batch.
	 *
	 * Bounded growth: every entry has a paired SDK echo or a reconcile drain;
	 * neither path is silently dropped.
	 */
	inFlightSteerTexts?: string[];
	/**
	 * Latest in-flight `message_update` payload. Set on every `message_update`
	 * event with a non-empty `event.message`; cleared on `message_end`,
	 * `agent_end`, and `process_exit`. Used to splice the in-flight row into
	 * `getMessages` snapshot responses so a snapshot taken while an assistant
	 * message is mid-stream still represents the row — the agent flushes to
	 * `.jsonl` only on `message_end`, so without this the snapshot drops the
	 * row entirely (H3-D convergent loss across tabs). See the H3 design doc.
	 */
	latestMessageUpdate?: { id?: string; message: any };
	/**
	 * PERF-06: memoized `rpcClient.getMessages()` + hydrate + normalize — the
	 * expensive agent-round-trip part of a `get_messages` snapshot — keyed by
	 * `eventBuffer.lastSeq` at capture time. See
	 * `SessionManager.getMessagesSnapshotBase()` for the invalidation
	 * argument: every event that can change what `getMessages()` returns is
	 * pushed through `emitSessionEvent` (bumping `lastSeq`) before it can
	 * reach here, so a same-seq cache hit is guaranteed byte-identical to a
	 * fresh RPC. Deliberately does NOT cover the live-state splice/merge
	 * steps (in-flight message/steers, compaction/skill sidecars) — those
	 * are recomputed fresh on every call regardless of cache hit/miss.
	 */
	messagesSnapshotCache?: { seq: number; promise: Promise<{ success: boolean; data?: unknown; error?: string }> };
}

// `spliceInFlightMessage` lives in its own module so unit tests can import
// it without dragging in the full session-manager module graph (which
// transitively pulls flexsearch, pi-coding-agent, etc.). Re-exported here
// for backwards compat with existing call sites.
export { spliceInFlightMessage, spliceInFlightSteers } from "./splice-inflight-message.js";
import { spliceInFlightMessage, spliceInFlightSteers } from "./splice-inflight-message.js";

/** Helper: extract the text body of a user message (string or block array). */
export function extractUserMessageText(message: any): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		const block = message.content.find((c: any) => c?.type === "text");
		return block?.text ?? "";
	}
	return "";
}

/** Helper: rewrite the text body of a user message in place (returns a new object). */
function rewriteUserMessageText(message: any, newText: string): any {
	if (!message) return message;
	if (typeof message.content === "string") return { ...message, content: newText };
	if (Array.isArray(message.content)) {
		const content = message.content.map((c: any) =>
			c?.type === "text" ? { ...c, text: newText } : c,
		);
		// If no text block was present, prepend one.
		if (!content.some((c: any) => c?.type === "text")) {
			content.unshift({ type: "text", text: newText });
		}
		return { ...message, content };
	}
	return { ...message, content: newText };
}

/**
 * Threshold above which a client's outbound buffer is considered
 * pathologically backed up. The `ws` library doesn't drop frames on its
 * own — it just lets `bufferedAmount` grow until the kernel pushes back.
 * On loopback under cross-worker FS contention we've seen short bursts
 * push this past 1MB; beyond ~8MB the connection effectively stalls and
 * is then closed by the OS, manifesting as the 'Reconnecting to server…'
 * E2E flake. We log loudly when crossed and drop the client so the
 * client-side reconnect path takes over cleanly instead of waiting for a
 * TCP timeout.
 */
const WS_BUFFER_OVERFLOW_BYTES = 4 * 1024 * 1024; // 4 MiB
const WS_BUFFER_WARN_BYTES = 1 * 1024 * 1024;     // 1 MiB — log only
const _warnedClients = new WeakSet<WebSocket>();

/**
 * Tracks clients for which a deferred-terminate re-check is in flight. When
 * `bufferedAmount` first crosses the overflow threshold we don't terminate
 * immediately — we schedule a 10 ms re-check. The kernel TCP send buffer
 * often drains transient spikes within that window (we saw this consistently
 * on Windows + Playwright workers=3 chasing the ST-DEDUP-01 flake family).
 * If `bufferedAmount` is still over the threshold during the deferred check,
 * we terminate. We still attempt the current send — if the client survives,
 * the frame is delivered; if not, `ws` queues it and discards on close.
 *
 * Decision logic lives in `src/server/ws-overflow-guard.ts` for testability.
 */
const _pendingOverflowCheck = new WeakSet<WebSocket>();

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
	if (!cpuDiagnosticsEnabled()) {
		const data = JSON.stringify(msg);
		for (const client of clients) {
			if (client.readyState !== 1) continue;
			const buffered = (client as any).bufferedAmount ?? 0;
			const action = decideOverflowAction(buffered, /* isDeferredRecheck */ false, {
				overflowBytes: WS_BUFFER_OVERFLOW_BYTES,
				warnBytes: WS_BUFFER_WARN_BYTES,
			});
			if (action.kind === "send-and-defer-check" && !_pendingOverflowCheck.has(client)) {
				_pendingOverflowCheck.add(client);
				console.warn(
					`[ws] bufferedAmount=${buffered}B > ${WS_BUFFER_OVERFLOW_BYTES}B threshold; deferring terminate decision 10ms.`,
				);
				setTimeout(() => {
					_pendingOverflowCheck.delete(client);
					if (client.readyState !== 1) return;
					const bufferedNow = (client as any).bufferedAmount ?? 0;
					const recheck = decideOverflowAction(bufferedNow, /* isDeferredRecheck */ true, {
						overflowBytes: WS_BUFFER_OVERFLOW_BYTES,
						warnBytes: WS_BUFFER_WARN_BYTES,
					});
					if (recheck.kind === "terminate") {
						console.warn(
							`[ws] confirmed overflow after 10ms drain attempt: ${bufferedNow}B; terminating client. ` +
							`Last msg type=${(msg as any).type}.`,
						);
						try { client.terminate(); } catch { /* ignore */ }
					}
				}, 10);
			}
			if (buffered > WS_BUFFER_WARN_BYTES && !_warnedClients.has(client)) {
				_warnedClients.add(client);
				console.warn(`[ws] client bufferedAmount=${buffered}B (warn threshold ${WS_BUFFER_WARN_BYTES}B); type=${(msg as any).type}`);
			}
			client.send(data);
		}
		return;
	}

	const stringifyStart = performance.now();
	const data = JSON.stringify(msg);
	const stringifyMs = performance.now() - stringifyStart;
	const sendStart = performance.now();
	let scanned = 0;
	let recipients = 0;
	let skipped = 0;
	for (const client of clients) {
		scanned++;
		if (client.readyState !== 1) { skipped++; continue; }
		const buffered = (client as any).bufferedAmount ?? 0;
		const action = decideOverflowAction(buffered, /* isDeferredRecheck */ false, {
			overflowBytes: WS_BUFFER_OVERFLOW_BYTES,
			warnBytes: WS_BUFFER_WARN_BYTES,
		});
		if (action.kind === "send-and-defer-check" && !_pendingOverflowCheck.has(client)) {
			_pendingOverflowCheck.add(client);
			console.warn(
				`[ws] bufferedAmount=${buffered}B > ${WS_BUFFER_OVERFLOW_BYTES}B threshold; deferring terminate decision 10ms.`,
			);
			setTimeout(() => {
				_pendingOverflowCheck.delete(client);
				if (client.readyState !== 1) return;
				const bufferedNow = (client as any).bufferedAmount ?? 0;
				const recheck = decideOverflowAction(bufferedNow, /* isDeferredRecheck */ true, {
					overflowBytes: WS_BUFFER_OVERFLOW_BYTES,
					warnBytes: WS_BUFFER_WARN_BYTES,
				});
				if (recheck.kind === "terminate") {
					console.warn(
						`[ws] confirmed overflow after 10ms drain attempt: ${bufferedNow}B; terminating client. ` +
						`Last msg type=${(msg as any).type}.`,
					);
					try { client.terminate(); } catch { /* ignore */ }
				}
			}, 10);
		}
		if (buffered > WS_BUFFER_WARN_BYTES && !_warnedClients.has(client)) {
			_warnedClients.add(client);
			console.warn(`[ws] client bufferedAmount=${buffered}B (warn threshold ${WS_BUFFER_WARN_BYTES}B); type=${(msg as any).type}`);
		}
		client.send(data);
		recipients++;
	}
	getCpuDiagnostics().recordWsBroadcast("session-manager:broadcast", (msg as { type?: string }).type || "unknown", {
		frames: 1,
		scanned,
		recipients,
		skipped,
		bytes: Buffer.byteLength(data) * recipients,
		stringifyMs,
		sendMs: performance.now() - sendStart,
	});
}

// `broadcastStatus()` lives in `./session-status.ts` so unit tests can import
// the pure helper without dragging in the full SessionManager dependency
// graph. Re-exported here for backward compat with existing call sites.
export { broadcastStatus } from "./session-status.js";
import { broadcastStatus } from "./session-status.js";

function sanitizeProviderAuthEventForEmit(event: unknown): unknown {
	if (!event || typeof event !== "object") return event;
	const ev = event as any;
	let next = ev;
	const clone = () => {
		if (next === ev) next = { ...ev };
		return next;
	};
	const sanitizeErrorText = (value: unknown): string | undefined => {
		if (typeof value !== "string" || value.length === 0) return undefined;
		return redactDispatchFailureReason(value, isProviderAuthFailure(value));
	};

	if (ev.type === "message_end" && ev.message && typeof ev.message === "object") {
		const safeMessageError = sanitizeErrorText(ev.message.errorMessage);
		if (safeMessageError && safeMessageError !== ev.message.errorMessage) {
			clone().message = { ...ev.message, errorMessage: safeMessageError };
		}
	}

	const safeTopLevelErrorMessage = sanitizeErrorText(ev.errorMessage);
	if (safeTopLevelErrorMessage && safeTopLevelErrorMessage !== ev.errorMessage) {
		clone().errorMessage = safeTopLevelErrorMessage;
	}

	const safeTopLevelError = sanitizeErrorText(ev.error);
	if (safeTopLevelError && safeTopLevelError !== ev.error) {
		clone().error = safeTopLevelError;
	}

	return next;
}

/** Push a raw event into the session's EventBuffer (assigning seq/ts) and
 *  broadcast the `{type:"event"}` frame to all clients with seq/ts attached.
 *  This is the single emit path for live agent events — every call site that
 *  used to do `eventBuffer.push(ev); broadcast(clients, {type:"event", data:ev})`
 *  must route through here so envelope fields stay consistent.
 *  See docs/design/streaming-dedup-reorder.md §4.2. */
export function emitSessionEvent(session: { clients: Set<WebSocket>; eventBuffer: EventBuffer; pendingSkillExpansions?: Array<{ modelText: string; originalText: string; skillExpansions: SkillExpansion[]; fileMentions?: FileMention[] }> }, truncated: unknown): void {
	const normalized = normalizeToolResultErrorEvent(truncated);
	const sanitized = sanitizeProviderAuthEventForEmit(normalized);
	const spliced = spliceSkillExpansionsIntoEvent(session, sanitized);
	const entry = session.eventBuffer.push(spliced);
	const frame = { type: "event" as const, data: spliced, seq: entry.seq, ts: entry.ts };
	if (cpuDiagnosticsEnabled()) {
		const eventType = spliced && typeof spliced === "object" && typeof (spliced as { type?: unknown }).type === "string"
			? (spliced as { type: string }).type
			: "unknown";
		getCpuDiagnostics().recordWsBroadcast("session-manager:emitSessionEvent", eventType, {
			frames: 1,
			recipients: session.clients.size,
			bytes: Buffer.byteLength(JSON.stringify(frame)) * session.clients.size,
			bufferSize: session.eventBuffer.size,
		});
	}
	broadcast(session.clients, frame);
}

/**
 * If `event` is a `message_end` for a user role and the session has a
 * pending skill-expansion envelope whose `modelText` matches the message
 * body, return a cloned event with:
 *   - the user message body rewritten to `originalText`
 *   - `skillExpansions` attached as a top-level field on the message
 * The pending envelope is consumed (FIFO). The original event object is
 * never mutated; the agent's internal transcript continues to reference
 * the un-spliced (modelText) message — that is what the model has seen.
 */
function spliceSkillExpansionsIntoEvent(
	session: { pendingSkillExpansions?: Array<{ modelText: string; originalText: string; skillExpansions: SkillExpansion[]; fileMentions?: FileMention[] }> },
	event: unknown,
): unknown {
	const ev = event as any;
	if (!ev || typeof ev !== "object") return event;
	if (ev.type !== "message_end") return event;
	const msg = ev.message;
	if (!msg || (msg.role !== "user" && msg.role !== "user-with-attachments")) return event;
	const pending = session.pendingSkillExpansions;
	if (!pending || pending.length === 0) return event;
	const body = extractUserMessageText(msg);
	const idx = pending.findIndex((p) => p.modelText === body);
	if (idx === -1) return event;
	const envelope = pending.splice(idx, 1)[0];
	const rewrittenMsg = rewriteUserMessageText(msg, envelope.originalText);
	rewrittenMsg.skillExpansions = envelope.skillExpansions;
	if (envelope.fileMentions && envelope.fileMentions.length > 0) {
		rewrittenMsg.fileMentions = envelope.fileMentions;
	}
	return { ...ev, message: rewrittenMsg };
}

/** Snapshot of the active pending tool-permission grant, returned to clients
 * that attach mid-perm so they can replay the SAME seq/ts as the original
 * broadcast — never allocating a fresh sequence number. Pinned by
 * tests/perm-frame-late-joiner-seq-gap.test.ts. */
export interface PendingToolPermissionSnapshot {
	toolName: string;
	group: string;
	roleName: string;
	roleLabel: string;
	lastPromptText?: string;
	seq: number;
	ts: number;
}

export interface ExtensionChannelLifecycle {
	closeSession?(sessionId: string, reason?: string): void | Promise<void>;
	dispose?(reason?: string): void | Promise<void>;
}

export interface ExtensionChannelServices {
	registry?: ExtensionChannelLifecycle;
	openPermits?: unknown;
}

export interface SessionManagerOptions {
	/** Override the path to pi-coding-agent cli.js */
	agentCliPath?: string;
	/** Path to a custom system prompt file */
	systemPromptPath?: string;
	/** Color store for session color cleanup on terminate */
	colorStore?: ColorStore;
	/** Role manager for looking up role definitions */
	roleManager?: RoleManager;
	/** Tool manager for generating tool documentation in system prompts */
	toolManager?: ToolManager;
	/** Group policy store for resolving group-level default tool grant policies */
	groupPolicyStore?: ToolGroupPolicyStore;
	/** Preferences store for aigw auto-model detection */
	preferencesStore?: import("./preferences-store.js").PreferencesStore;
	/** Project config store for reading project defaults */
	projectConfigStore?: import("./project-config-store.js").ProjectConfigStore;
	/** Project context manager for per-project store resolution */
	projectContextManager?: ProjectContextManager;
	/** Config cascade for three-layer resolution (builtin → server → project) */
	configCascade?: import("./config-cascade.js").ConfigCascade;
	/** PR status store — single source of truth for goal PR URLs. */
	prStatusStore?: PrStatusStore;
	/** Process-lifetime Extension Host channel services, wired by server.ts when available. */
	extensionChannels?: ExtensionChannelServices;
	/** Durable tool-permission ask audit log. Override is primarily for tests. */
	toolPermissionAuditLog?: ToolPermissionAuditLog;
}

/**
 * F22 (RECONCILIATION-2026-07-05.md NEXT QUEUE item 5) — tool names that are
 * safe within a "narrow worker" delegate's scope: pure file/shell primitives
 * with no team/goal/gate/review/task orchestration surface. Used by
 * `isNarrowDelegateAllowedTools` to decide whether a delegate's spawn-time
 * `allowedTools` PROVES the spawn is bounded to a single coding task, as
 * opposed to one that still needs team/goal awareness.
 *
 * NOT the same axis as `read-only-tool-policy.ts`'s `isReadOnlyToolPolicy`
 * (eligibility-signal lane), even though both derive a session-class signal
 * from the resolved `allowedTools` instead of an opt-in flag/name. This is an
 * ALLOW-list that deliberately INCLUDES `write`/`edit`/`bash`/`bash_bg` — a
 * narrow delegate is still allowed to mutate files, it's just proven to be
 * scoped to one bounded coding task. `isReadOnlyToolPolicy` is the opposite:
 * a DENY-list that excludes any of those same tools. Forcing them onto one
 * shared constant would contort whichever one lost — kept deliberately
 * separate, cross-referenced here so they don't silently diverge in intent.
 */
const NARROW_WORKER_TOOLS: ReadonlySet<string> = new Set([
	"read", "write", "edit", "grep", "find", "ls", "bash", "bash_bg", "read_session", "activate_skill",
]);

/**
 * F22 narrowness criterion: a delegate is PROVABLY narrow iff it was spawned
 * with a non-empty, explicit `allowedTools` allow-list drawn entirely from
 * `NARROW_WORKER_TOOLS`. `undefined`/empty `allowedTools` (unrestricted, or
 * inheriting the parent's full surface) is conservatively NOT narrow — the
 * spawn metadata can't prove the child is scoped to a bounded coding task, so
 * it keeps the full prompt (see `buildDelegatePromptParts`).
 */
export function isNarrowDelegateAllowedTools(allowedTools?: string[]): boolean {
	if (!allowedTools || allowedTools.length === 0) return false;
	return allowedTools.every(t => NARROW_WORKER_TOOLS.has(t.toLowerCase()));
}

type IdleWaiter = {
	resolve: () => void;
	reject: (error: Error) => void;
	cleanup: () => void;
};

export class SessionManager {
	private sessions = new Map<string, SessionInfo>();
	/** Sessions with at least one attached WS client. Keeps heartbeat work proportional to active viewers. */
	private sessionsWithConnectedClients = new Set<SessionInfo>();
	/**
	 * Cache for `resolveTaskIdForSession`'s cross-project fallback scan
	 * (PERF-05). Only populated for sessions that have NO `taskId` recorded
	 * on the session itself (the common fast path returns before touching
	 * this) — those sessions would otherwise pay a `new TaskManager()` +
	 * full `getTasksForSession` scan across every project on EVERY
	 * `trackCostFromEvent` call (once per assistant message). Keyed by
	 * sessionId; invalidated by comparing against
	 * `ProjectContextManager.getTaskGeneration()` at read time — any task
	 * put/remove in any project (including (re)assignment) bumps that sum,
	 * so a stale entry is never served, only recomputed. Entries are pruned
	 * alongside `this.sessions.delete(...)` so it stays bounded to live
	 * sessions.
	 */
	private taskIdCache = new Map<string, { taskId: string | undefined; gen: number }>();
	private agentCliPath?: string;
	private systemPromptPath?: string;
	/** @internal Test-only session store (used when no PCM is available). */
	private _testStore: SessionStore | null = null;
	private _testBgProcessStore: BgProcessStore | null = null;
	/** @internal Test-only cost tracker (used when no PCM is available). */
	private _testCostTracker: CostTracker | null = null;
	/** @internal Test-only search index (used when no PCM is available). */
	private _testSearchIndex: SearchService | null = null;
	private toolPermissionAuditLog!: ToolPermissionAuditLog;
	private colorStore?: ColorStore;
	private roleManager?: RoleManager;
	/**
	 * Minimal staff-record lookup wired late from `server.ts` via
	 * `setStaffManager`. Used by the restore path to rebuild a staff session's
	 * full system prompt (role context + systemPrompt + pinned memory) since
	 * `rolePrompt` isn't persisted. Typed structurally to avoid a circular
	 * import on `StaffManager`.
	 */
	staffRecordSource?: StaffRecordSource;
	private toolManager?: ToolManager;
	private groupPolicyStore?: ToolGroupPolicyStore;
	private preferencesStore?: import("./preferences-store.js").PreferencesStore;
	private projectConfigStore?: import("./project-config-store.js").ProjectConfigStore;
	private projectContextManager: ProjectContextManager | null = null;
	private prStatusStore: PrStatusStore | null = null;
	/**
	 * MCP client wiring (SessionManager decomposition cohort 2,
	 * docs/design/session-manager-decomposition.md). Constructed once at the
	 * end of this constructor and held for the manager's lifetime — same
	 * discipline as `archivedWorktrees` above (§4.2: not rebuilt per-call).
	 */
	private mcpWiring!: McpWiring;
	/**
	 * `mcpManager`/`scopedMcpManagers` are now owned by `McpWiring`; these
	 * accessors keep them readable/writable exactly like plain fields
	 * (`this.mcpManager`, `this.mcpManager = x`, `this.scopedMcpManagers.set(...)`)
	 * for every existing internal call site AND for unit tests that poke
	 * these members directly on a `new SessionManager()` instance (see
	 * mcp-wiring.ts's TEST-SEAM HAZARD doc comment) — zero call-site changes
	 * required anywhere else in this file or in tests.
	 */
	private get mcpManager(): McpManager | null { return this.mcpWiring.mcpManager; }
	private set mcpManager(value: McpManager | null) { this.mcpWiring.mcpManager = value; }
	// No `private` modifier: no production code in this file reads this
	// accessor anymore (every cluster-D caller moved into mcp-wiring.ts and
	// reads its own `scopedMcpManagers` field directly) — TS's unused-private-member
	// check would otherwise flag it. Kept as an accessor (not removed) purely
	// for unit tests that poke `sessionManager.scopedMcpManagers.set(...)` /
	// `.clear()` / `.size` directly on a `new SessionManager()` instance; see
	// mcp-wiring.ts's TEST-SEAM HAZARD comment. Same "effectively public"
	// treatment this file already gives `sandboxManager`/`configCascade`.
	get scopedMcpManagers(): Map<string, McpManager> { return this.mcpWiring.scopedMcpManagers; }
	private marketplacePiExtensionResolver: MarketplacePiExtensionResolver | null = null;
	private piExtensionRuntimeDiagnostics = new Map<string, PiExtensionDiagnostic>();
	private worktreePools: Map<string, WorktreePool> = new Map();
	/**
	 * Warm pool of pre-spawned non-sandboxed exec-class pi processes — see
	 * docs/design/warm-pi-process-pool.md (wave 1). Always constructed (cheap,
	 * holds nothing until first use); gated behind `isWarmPoolEnabled()`
	 * (`BOBBIT_WARM_POOL=1`, default OFF) at the `PipelineContext` wiring
	 * boundary in `buildPipelineContext()`, mirroring how `sandboxManager`
	 * etc. are optional-by-null there. `startSweeping()` is a no-op if the
	 * flag is off (no timer, no fills ever attempted) — see `initPiProcessPool()`.
	 */
	private readonly piProcessPool: PiProcessPool = new PiProcessPool();
	/**
	 * Alias map for warm-pool claims: a claimed pool entry's child process is
	 * already running with `BOBBIT_SESSION_ID` baked to the POOL's own
	 * placeholder id (unchangeable post-spawn — see rpc-bridge.ts/the design
	 * doc §2.1). `getSession()` consults this so any code path that resolves
	 * a session by the id a running process's OWN env/callbacks present
	 * (e.g. the `/api/internal/mcp-call` route's `X-Bobbit-Session-Id`
	 * header) still finds the correct live session. Entries are NOT
	 * proactively pruned on session teardown (the four `this.sessions.delete`
	 * call sites are not touched by this change) — a stale alias simply
	 * resolves through to a `sessions.get()` miss once the real session is
	 * gone, same as looking up any other dead id. This bounds the map to
	 * "one small entry per warm-pool hit for the life of the gateway
	 * process" — negligible relative to session volume; flagged here as a
	 * known, accepted low-priority follow-up rather than left undocumented.
	 */
	private readonly piPoolIdentityAliases = new Map<string, string>();
	sandboxManager: SandboxManager | null = null;
	sandboxTokenStore: import("../auth/sandbox-token.js").SandboxTokenStore | null = null;
	lifecycleHub?: LifecycleHub;
	/**
	 * S1 — per-session capability secret store. Injected into the owning
	 * session's env as `BOBBIT_SESSION_SECRET` and used by the orchestration
	 * Children authz to derive the AUTHENTIC caller (replaces the forgeable
	 * public session-id header). In-memory only, never persisted — see
	 * `src/server/auth/session-secret.ts`. Always present (constructed inline so
	 * every spawn/restore/respawn path can inject without a null-check).
	 */
	readonly sessionSecretStore: SessionSecretStore = new SessionSecretStore();
	configCascade: import("./config-cascade.js").ConfigCascade | null = null;
	/**
	 * Optional inbox nudger. Wired late from `server.ts` boot via
	 * `setInboxNudger` so the nudger's `onAgentStart` hook can clear its
	 * per-staff `nudgePending` flag when a staff session begins streaming
	 * a turn. Stays null on test paths that don't construct a nudger.
	 */
	private _inboxNudger: InboxNudgerView | null = null;
	private _onPrCreationDetected?: (session: SessionInfo) => void;
	private _verificationHarness?: import("./verification-harness.js").VerificationHarness;
	private _terminationListeners: Array<(sessionId: string, info: { projectId?: string; reason: "terminated" | "archived" | "purged"; cwd?: string; worktreePath?: string; repoWorktrees?: Array<{ worktreePath: string }> }) => void> = [];
	private _creationListeners: Array<(session: SessionInfo) => void> = [];
	/**
	 * Cost lookup, hydration, and live message_end accounting
	 * (SessionManager decomposition cohort 7). Constructed once with late-bound
	 * getters for test-only stores and verification harness because those are
	 * mutable across setup paths.
	 */
	private sessionCostPlumbing!: SessionCostPlumbing;
	/**
	 * Archived-worktree bookkeeping (SessionManager decomposition cohort 1,
	 * docs/design/session-manager-decomposition.md). Constructed once at the
	 * end of this constructor (after colorStore/projectContextManager/
	 * _testStore/_testSearchIndex are all assigned) and held for the manager's
	 * lifetime — NOT rebuilt per-call, unlike route-registry.md's per-request
	 * CoreRouteCtx (see design doc §4.2 for why).
	 */
	private archivedWorktrees!: ArchivedWorktreeManager;
	private _extensionChannels?: ExtensionChannelServices;
	/**
	 * Count of agent-CLI `*.jsonl` transcripts on disk that don't match any
	 * persisted `agentSessionFile` (and are newer than the most recent
	 * `lastActivity` in the store). Populated by `restoreSessions()` via
	 * `scanOrphanedTranscripts()`. Surfaced via `GET /api/health` so the
	 * splash UI can show a one-line banner. Zero means "clean".
	 */
	orphanedTranscriptsCount = 0;
	/** @internal Non-PCM test path only. */
	private _testGoalManager: GoalManager | null = null;
	/** @internal Non-PCM test path only. */
	private _testTaskManager: TaskManager | null = null;
	private purgeInterval: ReturnType<typeof setInterval> | null = null;
	/** Heartbeat timer: re-broadcasts the current `session_status` for every
	 *  active session every STATUS_HEARTBEAT_INTERVAL_MS, WITHOUT bumping
	 *  `statusVersion`. Self-heals any client that missed a transition frame.
	 *  See docs/design/unify-session-status.md §3.4. */
	private _statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private static readonly STATUS_HEARTBEAT_INTERVAL_MS = 15_000;
	/**
	 * Lifecycle restore/respawn fencing (SessionManager decomposition cohort 3,
	 * docs/design/session-manager-decomposition.md). Same accessor-wrapper
	 * discipline as `mcpWiring`: tests poke `_sessionRespawnGenerations`
	 * directly, so the same-named SessionManager surface must remain backed by
	 * the extracted module's real map.
	 */
	private lifecycleFence!: SessionLifecycleFence<SessionInfo>;
	private get _restoreCoordinators(): Map<string, RestoreCoordinator<SessionInfo>> { return this.lifecycleFence.restoreCoordinators; }
	get _sessionRespawnGenerations(): Map<string, number> { return this.lifecycleFence.sessionRespawnGenerations; }
	private sessionRevive!: SessionRevive;
	private sessionSpawn!: SessionSpawn;
	private sessionSteering!: SessionSteering;
	private sessionBoot!: SessionBoot;
	private sessionModels!: SessionModels;
	private sessionTranscripts!: SessionTranscripts;
	private sessionSetupPlumbing!: SessionSetupPlumbing;
	private _idleWaiters = new Map<string, Set<IdleWaiter>>();

	/** Sessions that restoreSession's mid-turn branch has just re-prompted on
	 *  boot. The team-manager boot-resume nudge consults `wasBootReprompted` to
	 *  skip these leads so two prompts don't race the same cold agent. Entries
	 *  are cleared on agent_start (the session has begun its turn). */
	private _bootRepromptedSessions = new Set<string>();

	/** True if restoreSession's mid-turn branch re-prompted this session on boot
	 *  and it hasn't yet started its turn. Used by the team-manager boot-resume
	 *  nudge to avoid double-prompting a cold agent. */
	wasBootReprompted(sessionId: string): boolean {
		return this._bootRepromptedSessions.has(sessionId);
	}

	_currentRespawnGeneration(...args: Parameters<SessionLifecycleFence<SessionInfo>["currentRespawnGeneration"]>): ReturnType<SessionLifecycleFence<SessionInfo>["currentRespawnGeneration"]> {
		return this.lifecycleFence.currentRespawnGeneration(...args);
	}

	_nextRespawnGeneration(...args: Parameters<SessionLifecycleFence<SessionInfo>["nextRespawnGeneration"]>): ReturnType<SessionLifecycleFence<SessionInfo>["nextRespawnGeneration"]> {
		return this.lifecycleFence.nextRespawnGeneration(...args);
	}

	private _sessionWriterIsCurrent(...args: Parameters<SessionLifecycleFence<SessionInfo>["sessionWriterIsCurrent"]>): ReturnType<SessionLifecycleFence<SessionInfo>["sessionWriterIsCurrent"]> {
		return this.lifecycleFence.sessionWriterIsCurrent(...args);
	}

	_fenceReplacedSession(...args: Parameters<SessionLifecycleFence<SessionInfo>["fenceReplacedSession"]>): ReturnType<SessionLifecycleFence<SessionInfo>["fenceReplacedSession"]> {
		return this.lifecycleFence.fenceReplacedSession(...args);
	}

	private _coalesceRestore(...args: Parameters<SessionLifecycleFence<SessionInfo>["coalesceRestore"]>): ReturnType<SessionLifecycleFence<SessionInfo>["coalesceRestore"]> {
		return this.lifecycleFence.coalesceRestore(...args);
	}

	private _restoreSessionCoalesced(ps: PersistedSession): Promise<SessionInfo | undefined> {
		return this._coalesceRestore(ps.id, async (generation) => {
			await this.restoreSession(ps);
			const restored = this.sessions.get(ps.id);
			if (restored) {
				restored.lifecycleGeneration = generation;
				// CS-R2 follow-up (narrow CS-R7): restoreSession() re-seeds the prompt
				// queue from `ps.messageQueue` and broadcasts idle WITHOUT draining, so
				// a prompt persisted in the queue — or enqueued during the revive window
				// — would sit undispatched (doc-04 F7 shape). Drain once here against the
				// canonical revived object. `drainQueue` itself no-ops unless this is the
				// current writer (`_sessionWriterIsCurrent`); we additionally gate on idle
				// + not-compacting + no pending boot-reprompt so we never race the
				// mid-turn boot-resume nudge. This is intentionally a single drain, not a
				// broad drain-on-every-idle-transition hook.
				if (
					restored.status === "idle" &&
					!restored.isCompacting &&
					!this._bootRepromptedSessions.has(ps.id) &&
					!restored.promptQueue.isEmpty
				) {
					this.drainQueue(restored);
				}
			}
			return restored;
		});
	}

	setOnPrCreationDetected(cb: (session: SessionInfo) => void): void {
		this._onPrCreationDetected = cb;
	}

	setVerificationHarness(harness: import("./verification-harness.js").VerificationHarness): void {
		this._verificationHarness = harness;
	}

	/** Subscribe to session termination events. Listeners are invoked synchronously. */
	addTerminationListener(fn: (sessionId: string, info: { projectId?: string; reason: "terminated" | "archived" | "purged"; cwd?: string; worktreePath?: string; repoWorktrees?: Array<{ worktreePath: string }> }) => void): void {
		this._terminationListeners.push(fn);
	}

	/** Subscribe to newly created visible sessions. Listeners are invoked after initial persistence. */
	addCreationListener(fn: (session: SessionInfo) => void): void {
		this._creationListeners.push(fn);
	}

	private notifySessionCreated(session: SessionInfo): void {
		for (const fn of this._creationListeners) {
			try { fn(session); } catch (err) {
				console.error(`[session-manager] session creation listener failed for ${session.id}:`, err);
			}
		}
	}

	setSandboxManager(manager: SandboxManager | null): void {
		this.sandboxManager = manager;
	}

	/**
	 * OrchestrationCore wiring (docs/design/orchestration-core.md). Injected by
	 * server.ts after construction (the core is built near teamManager and needs
	 * a ref back to this manager's narrow view). Used by `restoreSessions` to
	 * rebuild the in-memory child index + remind owners of live children on boot.
	 */
	private orchestrationCore: OrchestrationCoreView | null = null;
	setOrchestrationCore(core: OrchestrationCoreView | null): void {
		this.orchestrationCore = core;
	}

	setInboxNudger(nudger: InboxNudgerView | null): void {
		this._inboxNudger = nudger;
	}

	setStaffManager(sm: StaffRecordSource): void {
		this.staffRecordSource = sm;
	}

	/**
	 * Subscribe to sandbox container recovery events.
	 * Call after both SessionManager and SandboxManager are initialized.
	 */
	subscribeSandboxRecovery(): void {
		if (!this.sandboxManager) return;
		this.sandboxManager.onContainerRecovered((projectId: string, newContainerId: string) => {
			this.recoverSandboxSessions(projectId, newContainerId).catch(err => {
				console.error(`[session-manager] Sandbox recovery failed for project ${projectId}:`, err);
			});
		});
	}

	/**
	 * Recover all sandbox sessions after a container has been recreated.
	 * Verifies/repairs/recreates worktrees, then re-restores each session.
	 */
	private async recoverSandboxSessions(projectId: string, newContainerId: string): Promise<void> {
		console.log(`[session-manager] Recovering sandbox sessions for project ${projectId} (new container: ${newContainerId.substring(0, 12)})`);

		const sessionsToRecover: SessionInfo[] = [];
		for (const session of this.sessions.values()) {
			if (session.sandboxed && session.projectId === projectId) {
				sessionsToRecover.push(session);
			}
		}

		if (sessionsToRecover.length === 0) {
			console.log(`[session-manager] No sandbox sessions to recover for project ${projectId}`);
			return;
		}

		console.log(`[session-manager] Found ${sessionsToRecover.length} sandbox session(s) to recover`);

		for (const session of sessionsToRecover) {
			try {
				// Verify/repair/recreate worktree if needed. Headquarters never owns
				// sandbox worktrees, even for legacy sessions with /workspace-wt cwd.
				if (projectId !== HEADQUARTERS_PROJECT_ID && session.cwd?.startsWith("/workspace-wt/")) {
					let worktreeOk = false;

					// Check if worktree still exists (volumes may survive rm -f)
					try {
						await execFileAsync("docker", [
							"exec", newContainerId, "test", "-d", session.cwd,
						], { timeout: 5_000 });
						worktreeOk = true;
					} catch {
						// Try git worktree repair first
						try {
							await execFileAsync("docker", [
								"exec", "-w", "/workspace", newContainerId,
								"git", "worktree", "repair",
							], { timeout: 10_000 });
							// Re-check after repair
							await execFileAsync("docker", [
								"exec", newContainerId, "test", "-d", session.cwd,
							], { timeout: 5_000 });
							worktreeOk = true;
							console.log(`[session-manager] Worktree repaired for session ${session.id}`);
						} catch {
							// Repair didn't help — try recreate from persisted branch
							const store = this.getSessionStore(session.projectId);
							const ps = store.get(session.id);
							if (ps?.branch && this.sandboxManager) {
								const sandbox = this.sandboxManager.get(projectId);
								if (sandbox) {
									try {
										const worktreeName = session.cwd.replace(/^\/workspace-wt\//, "");
										await sandbox.createWorktree(worktreeName, ps.branch);
										worktreeOk = true;
										console.log(`[session-manager] Worktree recreated for session ${session.id}`);
									} catch (err) {
										console.warn(`[session-manager] Worktree recreation failed for ${session.id}:`, err);
									}
								}
							}
						}
					}

					if (!worktreeOk) {
						const psForGate = this.getSessionStore(session.projectId).get(session.id);
						if (psForGate && shouldKeepDespiteOrphan(psForGate)) {
							console.warn(`[orphan-cleanup] WARN: would-archive ${session.id} but worktree+recent-transcript present — leaving live`);
						} else {
							console.warn(`[session-manager] Archiving session ${session.id} — worktree unrecoverable after container recreation`);
							try { await this.archiveWithCascade(session.id, this.getSessionStore(session.projectId)); } catch { /* best-effort */ }
							broadcastStatus(session, "terminated");
						}
						continue;
					}
				}

				// Get persisted session data for restore
				const store = this.getSessionStore(session.projectId);
				const ps = store.get(session.id);
				if (!ps) {
					console.warn(`[session-manager] No persisted data for session ${session.id}, skipping recovery`);
					continue;
				}

				// Save connected WebSocket clients in case respawn fails and we need
				// to re-attach them to the original (now terminated) session.
				const savedClients = new Set(session.clients);
				try {
					await this._respawnAgentInPlace(session, ps);
					console.log(`[session-manager] Session ${session.id} recovered successfully`);
				} catch (err) {
					console.warn(`[session-manager] Failed to restore session ${session.id} after container recreation:`, err);
					// Put it back as terminated so user can still see it
					this.sessions.set(session.id, session);
					for (const ws of savedClients) {
						if ((ws as any).readyState === 1) session.clients.add(ws);
					}
					broadcastStatus(session, "terminated");
				}
			} catch (err) {
				console.error(`[session-manager] Error recovering session ${session.id}:`, err);
			}
		}
	}

	private _trackConnectedSession(session: SessionInfo): void {
		if (this.sessions.get(session.id) === session && session.status !== "terminated" && session.clients.size > 0) {
			this.sessionsWithConnectedClients.add(session);
		} else {
			this.sessionsWithConnectedClients.delete(session);
		}
	}

	private _untrackConnectedSession(session: SessionInfo): void {
		this.sessionsWithConnectedClients.delete(session);
	}

	/**
	 * Re-broadcast the current `session_status` for every session that has
	 * connected clients, WITHOUT bumping `statusVersion`. Heartbeat. Idempotent
	 * on the client (they ignore frames whose version <= lastStatusVersion).
	 */
	private _emitStatusHeartbeat(): void {
		const diagEnabled = cpuDiagnosticsEnabled();
		const diagStart = diagEnabled ? performance.now() : 0;
		let sessionsScanned = 0;
		let sessionsWithClients = 0;
		let frames = 0;
		let recipients = 0;
		for (const session of this.sessionsWithConnectedClients) {
			sessionsScanned++;
			if (this.sessions.get(session.id) !== session || session.clients.size === 0 || session.status === "terminated") {
				this.sessionsWithConnectedClients.delete(session);
				continue;
			}
			sessionsWithClients++;
			frames++;
			recipients += session.clients.size;
			broadcast(session.clients, {
				type: "session_status",
				status: session.status,
				statusVersion: session.statusVersion ?? 0,
				...(session.streamingStartedAt ? { streamingStartedAt: session.streamingStartedAt } : {}),
			});
		}
		if (diagEnabled) {
			const durationMs = performance.now() - diagStart;
			getCpuDiagnostics().recordTimer("session-manager:statusHeartbeat", durationMs, {
				sessionsScanned,
				sessionsWithClients,
				frames,
				recipients,
			});
			getCpuDiagnostics().recordWsBroadcast("session-manager:statusHeartbeat", "session_status", {
				frames,
				scanned: sessionsScanned,
				recipients,
				sendMs: durationMs,
			});
		}
	}

	constructor(options?: SessionManagerOptions) {
		this.agentCliPath = options?.agentCliPath;
		this.systemPromptPath = options?.systemPromptPath;
		this.colorStore = options?.colorStore;
		this.roleManager = options?.roleManager;
		this.toolManager = options?.toolManager;
		this.groupPolicyStore = options?.groupPolicyStore;
		this.preferencesStore = options?.preferencesStore;
		this.projectConfigStore = options?.projectConfigStore;
		this.projectContextManager = options?.projectContextManager ?? null;
		this.prStatusStore = options?.prStatusStore ?? null;
		this._extensionChannels = options?.extensionChannels;
		this.toolPermissionAuditLog = options?.toolPermissionAuditLog ?? new ToolPermissionAuditLog(bobbitStateDir());
		// Warm pi-process pool (wave 1, docs/design/warm-pi-process-pool.md).
		// Dark by default — BOBBIT_WARM_POOL=1 opts in. When off, no sweep timer
		// is started and `buildPipelineContext()` never hands `ctx.piProcessPool`
		// to session-setup.ts, so `claim()`/fills are never attempted at all.
		if (isWarmPoolEnabled()) this.piProcessPool.startSweeping();
		if (this.projectContextManager) {
			// All store resolution goes through PCM — no default fields needed.
		} else {
			// Non-PCM path: used by test harnesses that don't set up a full
			// ProjectContextManager. Stores are created from the explicit stateDir.
			const stateDir = bobbitStateDir();
			this._testStore = new SessionStore(stateDir);
			this._testBgProcessStore = new BgProcessStore(stateDir);
			this._testCostTracker = new CostTracker(stateDir);
			this._testSearchIndex = new SearchService({ stateDir, projectId: "__test__" });
			this._testGoalManager = new GoalManager(new GoalStore(stateDir));
			this._testTaskManager = new TaskManager(new TaskStore(stateDir));
			// Empty-but-real PR status store for in-process E2E harnesses that
			// construct SessionManager without a full ProjectContextManager but
			// may still hit re-attempt code paths.
			if (!this.prStatusStore) this.prStatusStore = new PrStatusStore(stateDir);
		}

		this.lifecycleFence = new SessionLifecycleFence({
			getCanonicalSession: (sessionId) => this.sessions.get(sessionId),
			cancelPendingAutoRetry: (session, reason) => this.cancelPendingAutoRetry(session, reason),
			untrackConnectedSession: (session) => this._untrackConnectedSession(session),
		} satisfies SessionLifecycleFenceDeps<SessionInfo>);

		this.sessionRevive = new SessionRevive({
			host: this,
		} satisfies SessionReviveDeps);

		this.sessionSetupPlumbing = new SessionSetupPlumbing({
			getAgentCliPath: () => this.agentCliPath,
			getSystemPromptPath: () => this.systemPromptPath,
			getRoleManager: () => this.roleManager,
			getToolManager: () => this.toolManager,
			getGroupPolicyStore: () => this.groupPolicyStore,
			getConfigCascade: () => this.configCascade,
			getPreferencesStore: () => this.preferencesStore,
			getProjectConfigStore: () => this.projectConfigStore,
			getProjectContextManager: () => this.projectContextManager,
			getSandboxManager: () => this.sandboxManager,
			getSandboxTokenStore: () => this.sandboxTokenStore,
			getSessionSecretStore: () => this.sessionSecretStore,
			getPiProcessPool: () => this.piProcessPool,
			getLifecycleHub: () => this.lifecycleHub,
			getPrStatusStore: () => this.prStatusStore,
			getTestCostTracker: () => this._testCostTracker,
			getTestGoalManager: () => this._testGoalManager,
			getTestTaskManager: () => this._testTaskManager,
			getSessionStore: (projectId) => this.getSessionStore(projectId),
			getSearchIndexForProject: (projectId) => this.getSearchIndexForProject(projectId),
			getSessions: () => this.sessions,
			getAllPersistedSessionsForWorktreeGuard: () => this.getAllPersistedSessionsForWorktreeGuard(),
			getMcpManagerForContext: (projectId, cwd) => this.getMcpManagerForContext(projectId, cwd),
			getMarketplacePiExtensionResolver: () => this.marketplacePiExtensionResolver,
			registerWarmPoolIdentityAlias: (poolOwnedId, realSessionId) => this.registerWarmPoolIdentityAlias(poolOwnedId, realSessionId),
			assemblePrompt: (id, parts) => this.assemblePrompt(id, parts),
			applySandboxWiring: (opts, id, sandboxOpts) => this.applySandboxWiring(opts, id, sandboxOpts),
			handleAgentLifecycle: (session, event) => this.handleAgentLifecycle(session, event),
			trackCostFromEvent: (session, event) => this.trackCostFromEvent(session, event),
			recordPiExtensionDiagnostic: (session, diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension),
			broadcast: (clients, msg) => broadcast(clients, msg),
			tryAutoSelectModel: (session) => this.tryAutoSelectModel(session),
			tryApplyDefaultThinkingLevel: (session) => this.tryApplyDefaultThinkingLevel(session),
			buildWorkflowList: (projectId) => this._buildWorkflowList(projectId),
			resolveInitialModel: (role, projectId) => this.resolveInitialModel(role, projectId),
			resolveInitialThinkingLevel: (role, projectId) => this.resolveInitialThinkingLevel(role, projectId),
			persistSessionMetadata: (session) => this.persistSessionMetadata(session),
			resolveGoal: (goalId) => this.resolveGoal(goalId),
			dispatchGoalProvisionedForWorktree: (opts) => this.dispatchGoalProvisionedForWorktree(opts),
		} satisfies SessionSetupPlumbingDeps);
		this.retainSessionSetupPlumbingHostSurface();

		this.sessionSpawn = new SessionSpawn();
		this.retainSessionSpawnHostSurface();
		this.sessionSteering = new SessionSteering();
		this.retainSessionSteeringHostSurface();
		this.sessionBoot = new SessionBoot({ host: this });
		this.retainSessionBootHostSurface();
		this.sessionModels = new SessionModels({
			getPreferencesStore: () => this.preferencesStore,
			getConfigCascade: () => this.configCascade,
			getRoleManager: () => this.roleManager,
			resolveSessionRole: (roleName, assistantType, projectId) => this.resolveSessionRole(roleName, assistantType, projectId),
			resolveStoreForSession: (id) => this.resolveStoreForSession(id),
			writeModelNameFile: (sessionId, modelId) => this._writeModelNameFile(sessionId, modelId),
			persistSessionModel: (sessionId, provider, modelId) => this.persistSessionModel(sessionId, provider, modelId),
			broadcast: (clients, msg) => broadcast(clients, msg),
		} satisfies SessionModelsDeps);
		this.retainSessionModelsHostSurface();

		this.sessionCostPlumbing = new SessionCostPlumbing({
			projectContextManager: this.projectContextManager,
			getTestCostTracker: () => this._testCostTracker,
			getTestTaskManager: () => this._testTaskManager,
			getSession: (sessionId) => this.sessions.get(sessionId),
			getPersistedSession: (sessionId) => this.getPersistedSession(sessionId),
			taskIdCache: this.taskIdCache,
			getTurnBudgetGovernor: () => this._verificationHarness?.turnBudgetGovernor,
			broadcast: (clients, msg) => broadcast(clients, msg),
		} satisfies SessionCostPlumbingDeps);
		this.retainSessionCostHostSurface();

		this.sessionTranscripts = new SessionTranscripts({
			resolveStoreForId: (id) => this.resolveStoreForId(id),
			resolveStoreForSession: (id) => this.resolveStoreForSession(id),
			getSession: (id) => this.sessions.get(id),
			getSandboxManager: () => this.sandboxManager,
			broadcastSessionCost: (session) => this.broadcastSessionCost(session),
			withSessionCostInState: (sessionId, data) => this.withSessionCostInState(sessionId, data),
			broadcast: (clients, msg) => broadcast(clients, msg),
		} satisfies SessionTranscriptsDeps);
		this.retainSessionTranscriptsHostSurface();

		// Constructed here (not lazily) so every field it captures by value
		// (projectContextManager, testStore, testSearchIndex, colorStore) is
		// already final — all four are assigned above, never reassigned again.
		// Anything SessionManager can still reassign AFTER this point
		// (sandboxManager via setSandboxManager, _verificationHarness via
		// setVerificationHarness) is threaded as a getter closure instead of a
		// captured value — see docs/design/session-manager-decomposition.md §4.2.
		this.archivedWorktrees = new ArchivedWorktreeManager({
			projectContextManager: this.projectContextManager,
			testStore: this._testStore,
			testSearchIndex: this._testSearchIndex,
			colorStore: this.colorStore,
			getSandboxManager: () => this.sandboxManager,
			getVerificationHarness: () => this._verificationHarness,
			listLiveSessionWorktreeRefs: () => Array.from(this.sessions.values()).map(s => ({
				id: s.id,
				worktreePath: s.worktreePath,
				cwd: s.cwd,
				repoPath: s.repoPath,
				branch: s.branch,
				repoWorktrees: s.repoWorktrees,
			})),
			resolveStoreForId: (id) => this.resolveStoreForId(id),
			getSessionStore: (projectId) => this.getSessionStore(projectId),
			getAllPersistedSessionsForWorktreeGuard: () => this.getAllPersistedSessionsForWorktreeGuard(),
			cascadeReapOwner: (id) => this.cascadeReapOwner(id),
			cleanupScopedMcpManagersForSessionScope: (scope) => this.cleanupScopedMcpManagersForSessionScope(scope),
			terminateSession: (id) => this.terminateSession(id),
			archiveWithCascade: (id, store) => this.archiveWithCascade(id, store),
			notifyTermination: (sessionId, info) => {
				for (const listener of this._terminationListeners) {
					try { listener(sessionId, info); } catch (err) {
						console.error(`[session ${sessionId}] purge listener failed:`, err);
					}
				}
			},
		} satisfies ArchivedWorktreeDeps);

		// MCP client wiring (SessionManager decomposition cohort 2,
		// docs/design/session-manager-decomposition.md). toolManager/
		// projectConfigStore/projectContextManager are constructor-time-only
		// (never reassigned after this point, confirmed live) so they are
		// captured by value. `resolveSessionScope`/`isCwdInUseByLiveSession`
		// are narrow snapshot callbacks over `sessions` (which mutates
		// continuously), never a live Map reference — same rule as
		// `archivedWorktrees`'s `listLiveSessionWorktreeRefs` above. The four
		// `createMcpManager`/`ensureMcpManager`/`ensureMcpManagerForContext`/
		// `refreshExternalMcpToolRegistrations` callbacks round-trip through
		// THIS class's own delegating wrapper methods (defined further down,
		// at their original cluster-D locations) rather than calling
		// `this.mcpWiring.<name>` directly — see mcp-wiring.ts's TEST-SEAM
		// HAZARD doc comment for why: several unit tests monkey-patch these
		// exact method names directly on a `new SessionManager()` instance.
		this.mcpWiring = new McpWiring({
			toolManager: this.toolManager,
			projectConfigStore: this.projectConfigStore,
			projectContextManager: this.projectContextManager,
			resolveSessionScope: (sessionId) => {
				const live = this.sessions.get(sessionId);
				const persisted = live ? null : this.getPersistedSession(sessionId);
				return { projectId: live?.projectId ?? persisted?.projectId, cwd: live?.cwd ?? persisted?.cwd };
			},
			isCwdInUseByLiveSession: (cwd) => [...this.sessions.values()].some((s) => !!s.cwd && path.resolve(s.cwd) === cwd),
			createMcpManager: (cwd, opts) => this.createMcpManager(cwd, opts),
			ensureMcpManager: (scope) => this.ensureMcpManager(scope),
			ensureMcpManagerForContext: (projectId, cwd) => this.ensureMcpManagerForContext(projectId, cwd),
			refreshExternalMcpToolRegistrations: () => this.refreshExternalMcpToolRegistrations(),
		} satisfies McpWiringDeps);

		// Start the status heartbeat. Runs for the lifetime of this manager;
		// `unref()` so unit tests don't hang on process exit.
		this._statusHeartbeatTimer = setInterval(
			() => this._emitStatusHeartbeat(),
			SessionManager.STATUS_HEARTBEAT_INTERVAL_MS,
		);
		(this._statusHeartbeatTimer as any).unref?.();
	}

	private retainSessionSetupPlumbingHostSurface(): void {
		// SessionSetupPlumbing owns setup/sandbox behavior after cohort 11,
		// while SessionManager keeps same-named wrappers for callers and pins.
		void this.readClaudeCodeConfigForProject;
		void this.buildPipelineContext;
		void this.ensureSandboxNetwork;
		void this.cleanupSandboxNetwork;
		void this.resolveSandboxCwdOffset;
		void this.readGatewayUrlForAgent;
		void this.mintScopedGatewayToken;
		void this.applyScopedGatewayCredentials;
		void this.scopedGatewayEnvForDirectAgent;
		void this.applySandboxWiring;
	}

	private retainSessionSpawnHostSurface(): void {
		// SessionSpawn invokes these legacy private seams with SessionManager as
		// `this`, matching the c5 steering extraction pattern.
		void this.notifySessionCreated;
		void this.resolveSandboxCwdOffset;
		void this.scopedGatewayEnvForDirectAgent;
	}

	private retainSessionSteeringHostSurface(): void {
		// SessionSteering invokes these legacy private seams with
		// `SessionManager` as `this`. Keep static references here so noUnusedLocals
		// still protects the rest of the class after the mechanical extraction.
		void this._inboxNudger;
		void this._onPrCreationDetected;
		void this._restoreCoordinators;
		void this._sessionWriterIsCurrent;
		void this.resolveSearchIndex;
		void this.persistInFlightSteerLedger;
		void this.consultThinkingRouterHub;
		void this.canApplyThinkingRouterDecision;
		void this.resolveCurrentThinkingRouterBaseline;
		void this.restoreThinkingRouterAppliedBaseline;
		void this.clearThinkingRouterAppliedBaseline;
		void this._dispatchSteer;
		void this._consumeSteerEcho;
		void this._reconcileInFlightSteers;
		void this.markPromptDispatchStreaming;
		void this.safeDispatchError;
		void this.surfaceProviderAuthFailure;
		void this.maybeAutoRetryPromptDeliveryFailure;
		void this.recoverPromptDispatch;
		void this.dispatchDirectPrompt;
		void this.persistClaudeCodeMessageToTranscript;
		void this.maybeAutoRetryTransient;
		void this._recoverBlankTextPoison;
		void this.consumeRecoveredPromptDispatchRows;
		void this.consumeQueuedRetryRow;
		void this.resolveIdleWaiters;
		void this.rejectIdleWaiters;
		void this._finishSessionSetup;
	}

	private retainSessionCostHostSurface(): void {
		// Keep these legacy private seam names present on SessionManager after
		// cohort 7; tests and extracted modules still reach them through the
		// manager object even though the implementation now lives elsewhere.
		void this.resolveCostTracker;
		void this.resolveTaskIdForSession;
		void this.costTriggerFromEvent;
	}

	private retainSessionTranscriptsHostSurface(): void {
		// SessionTranscripts owns transcript/sidecar behavior after cohort 10,
		// while SessionManager keeps same-named wrappers for callers and pins.
		void this.getMessagesSnapshotBase;
		void this.hydrateClaudeCodeSnapshotMessages;
		void this.getSessionOutput;
		void this.refreshAfterCompaction;
		void this.persistSessionMetadata;
		void this.getArchivedMessages;
		void this.recoverSessionFile;
	}

	private retainSessionBootHostSurface(): void {
		// SessionBoot invokes these legacy private seams with SessionManager as
		// host, and tests patch restoreOneSession/addDormantSession directly.
		void this.orchestrationCore;
		void this.orphanedTranscriptsCount;
		void this.restoreOneSession;
		void this.addDormantSession;
		void this.recoverSessionFile;
	}

	private retainSessionModelsHostSurface(): void {
		// SessionModels owns the model/thinking implementation after cohort 9,
		// but these same-named private seams intentionally remain on
		// SessionManager for source-pinned call sites and extracted modules.
		void this.resolveRoleModelValue;
		void this.resolveRoleThinkingLevelValue;
		void this.resolveRoleModel;
	}

	setExtensionChannelServices(services: ExtensionChannelServices | undefined): void {
		this._extensionChannels = services;
	}

	get extensionChannels(): ExtensionChannelServices | undefined {
		return this._extensionChannels;
	}

	private async closeExtensionChannelsForSession(sessionId: string, reason: string): Promise<void> {
		const registry = this._extensionChannels?.registry;
		if (!registry?.closeSession) return;
		try {
			await registry.closeSession(sessionId, reason);
		} catch (err) {
			console.warn(`[session-manager] Failed to close extension channels for ${sessionId}:`, err);
		}
	}

	/** Resolve goal tools extension path via toolManager cascade (with fallback). */
	private getGoalToolsExtensionPath(): string {
		if (this.toolManager) return this.toolManager.getExtensionPath("tasks", "extension.ts");
		return path.join(bobbitConfigDir(), "tools", "tasks", "extension.ts");
	}

	/** Resolve team lead extension path via toolManager cascade (with fallback). */
	private getTeamLeadExtensionPath(): string {
		if (this.toolManager) return this.toolManager.getExtensionPath("team", "extension.ts");
		return path.join(bobbitConfigDir(), "tools", "team", "extension.ts");
	}

	/** Resolve proposal tools extension path via toolManager cascade (with fallback). */
	private getProposalToolsExtensionPath(): string {
		if (this.toolManager) return this.toolManager.getExtensionPath("proposals", "extension.ts");
		return path.join(bobbitConfigDir(), "tools", "proposals", "extension.ts");
	}

	getProjectContextManager(): ProjectContextManager | null {
		return this.projectContextManager;
	}

	/** Resolve the SessionStore for a given project. Requires projectId when PCM is active. */
	getSessionStore(projectId?: string): SessionStore {
		if (this.projectContextManager) {
			if (!projectId) throw new Error("Cannot resolve session store: projectId is required");
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (!ctx) throw new Error(`Cannot resolve session store: project "${projectId}" not found`);
			return ctx.sessionStore;
		}
		if (this._testStore) return this._testStore;
		throw new Error("No project context manager or test store available");
	}

	/**
	 * CON-05: aggregate stale-snapshot-guard status across every project's
	 * `SessionStore` (or the single test store on non-PCM paths). Surfaced via
	 * `GET /api/health` (`sessionStoreStaleRecovery`) so a merge-recovery event
	 * — which self-heals the store but previously vanished the instant it
	 * happened — stays visible to an operator instead of only appearing once
	 * in the server log.
	 */
	getStaleSessionStoreStatus(): { tripped: boolean; recoveries: number; lastRecoveredAt: number | null } {
		if (this.projectContextManager) {
			return this.projectContextManager.getStaleSessionStoreStatus();
		}
		if (this._testStore) {
			return this._testStore.getStaleGuardStatus();
		}
		return { tripped: false, recoveries: 0, lastRecoveredAt: null };
	}

	/** Resolve the BgProcessStore for a given project. Requires projectId when PCM is active. */
	getBgProcessStore(projectId?: string): BgProcessStore {
		if (this.projectContextManager) {
			if (!projectId) throw new Error("Cannot resolve bg-process store: projectId is required");
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (!ctx) throw new Error(`Cannot resolve bg-process store: project "${projectId}" not found`);
			return ctx.bgProcessStore;
		}
		if (this._testBgProcessStore) return this._testBgProcessStore;
		throw new Error("No project context manager or test bg-process store available");
	}

	/** Resolve the GoalStore for a given project. Requires projectId when PCM is active. */
	getGoalStoreForProject(projectId?: string): GoalStore {
		if (this.projectContextManager) {
			if (!projectId) throw new Error("Cannot resolve goal store: projectId is required");
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (!ctx) throw new Error(`Cannot resolve goal store: project "${projectId}" not found`);
			return ctx.goalStore;
		}
		if (this._testGoalManager) return this._testGoalManager.getGoalStore();
		throw new Error("No project context manager or test goal manager available");
	}

	/** Resolve the GateStore for a goal. */
	getGateStoreForGoal(goalId: string): GateStore | null {
		if (this.projectContextManager) {
			const ctx = this.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.gateStore;
		}
		return null;
	}

	/** Resolve SearchService for a project. Requires projectId when PCM is active. */
	getSearchIndexForProject(projectId?: string): SearchService {
		if (this.projectContextManager) {
			if (!projectId) throw new Error("Cannot resolve search index: projectId is required");
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (!ctx) throw new Error(`Cannot resolve search index: project "${projectId}" not found`);
			return ctx.searchIndex;
		}
		if (this._testSearchIndex) return this._testSearchIndex;
		throw new Error("No project context manager or test search index available");
	}

	/** Resolve the correct SessionStore for an in-memory session by ID. */
	private resolveStoreForSession(id: string): SessionStore {
		const session = this.sessions.get(id);
		if (session?.projectId) {
			return this.getSessionStore(session.projectId);
		}
		// No projectId on session — scan all project contexts
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				if (ctx.sessionStore.get(id)) return ctx.sessionStore;
			}
			throw new Error(`Cannot resolve store for session ${id}: not found in any project`);
		}
		if (this._testStore) return this._testStore;
		throw new Error(`Cannot resolve store for session ${id}: no projectId and no test store`);
	}

	/** Resolve the correct SessionStore for any session by ID (in-memory or persisted). Returns null if not found. */
	private resolveStoreForId(id: string): SessionStore | null {
		// Try in-memory first (fast path)
		const session = this.sessions.get(id);
		if (session?.projectId) {
			return this.getSessionStore(session.projectId);
		}
		// Search all project stores for persisted/archived sessions
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				if (ctx.sessionStore.get(id)) return ctx.sessionStore;
			}
			return null;
		}
		if (this._testStore) return this._testStore;
		return null;
	}

	private getAllPersistedSessionsForWorktreeGuard(): PersistedSession[] {
		return this.projectContextManager
			? this.projectContextManager.getAllSessions()
			: (this._testStore?.getAll() ?? []);
	}

	/** Resolve the correct CostTracker for a session based on its project. */
	private resolveCostTracker(session: { projectId?: string }): CostTracker {
		return this.sessionCostPlumbing.resolveCostTracker(session);
	}

	/** Resolve the correct SearchService for a session based on its project. */
	private resolveSearchIndex(session: { projectId?: string }): SearchService {
		if (session.projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(session.projectId);
			if (ctx) return ctx.searchIndex;
		}
		if (this._testSearchIndex) return this._testSearchIndex;
		if (this.projectContextManager) {
			throw new Error("Cannot resolve search index: session has no projectId");
		}
		throw new Error("No search index available");
	}

	/** Resolve a goal across all project contexts. */
	private resolveGoal(goalId: string): PersistedGoal | undefined {
		if (this.projectContextManager) {
			const ctx = this.projectContextManager.getContextForGoal(goalId);
			if (ctx) return ctx.goalStore.get(goalId);
			return undefined;
		}
		// Non-PCM fallback (test harness)
		return this._testGoalManager?.getGoalStore().get(goalId);
	}

	/** Whether Docker sandbox mode is enabled in project config. */
	get isSandboxEnabled(): boolean {
		return (this.projectConfigStore?.get("sandbox") || "none") === "docker";
	}

	/**
	 * System-scope Subgoals feature flag (experimental; default OFF). Drives
	 * `{if:subGoalsEnabled}` conditional blocks in role/assistant prompt
	 * templates so the team-lead/goal-assistant are not told about sub-goal
	 * tooling that resolves to `never` when the feature is disabled.
	 */
	get isSubgoalsEnabled(): boolean {
		return this.preferencesStore?.get("subgoalsEnabled") === true;
	}

	/** Get the role manager (used by the staff path to resolve role prompts). */
	getRoleManager(): RoleManager | undefined {
		return this.roleManager;
	}

	/** Get the sandbox manager (used by team-manager and verification-harness). */
	getSandboxManager(): SandboxManager | null {
		return this.sandboxManager;
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	private readClaudeCodeConfigForProject(projectId?: string) {
		return this.sessionSetupPlumbing.readClaudeCodeConfigForProject(projectId);
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	buildPipelineContext(projectId?: string, cwd?: string): PipelineContext {
		return this.sessionSetupPlumbing.buildPipelineContext(projectId, cwd);
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	async ensureSandboxNetwork(): Promise<string> {
		return this.sessionSetupPlumbing.ensureSandboxNetwork();
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	async cleanupSandboxNetwork(): Promise<void> {
		return this.sessionSetupPlumbing.cleanupSandboxNetwork();
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	private async resolveSandboxCwdOffset(
		cwd: string,
		projectId?: string,
		goalId?: string,
		explicitOffset?: string,
	): Promise<string | undefined> {
		return this.sessionSetupPlumbing.resolveSandboxCwdOffset(cwd, projectId, goalId, explicitOffset);
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	private readGatewayUrlForAgent(): string | undefined {
		return this.sessionSetupPlumbing.readGatewayUrlForAgent();
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	private mintScopedGatewayToken(projectId: string | undefined, sessionId: string, goalId?: string): string | undefined {
		return this.sessionSetupPlumbing.mintScopedGatewayToken(projectId, sessionId, goalId);
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	private applyScopedGatewayCredentials(
		bridgeOptions: RpcBridgeOptions,
		sessionId: string,
		projectId: string | undefined,
		goalId?: string,
	): void {
		return this.sessionSetupPlumbing.applyScopedGatewayCredentials(bridgeOptions, sessionId, projectId, goalId);
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	private scopedGatewayEnvForDirectAgent(sessionId: string, projectId: string | undefined, goalId?: string): Record<string, string> | undefined {
		return this.sessionSetupPlumbing.scopedGatewayEnvForDirectAgent(sessionId, projectId, goalId);
	}

	/** Delegates to SessionSetupPlumbing (SessionManager decomposition cohort 11). */
	private async applySandboxWiring(
		bridgeOptions: RpcBridgeOptions,
		sessionId: string,
		opts?: SandboxWiringOptions,
	): Promise<boolean> {
		return this.sessionSetupPlumbing.applySandboxWiring(bridgeOptions, sessionId, opts);
	}

	/** Get a CostTracker for a specific project. Requires explicit projectId when PCM is active. */
	getCostTracker(projectId?: string): CostTracker {
		return this.sessionCostPlumbing.getCostTracker(projectId);
	}

	/** Return persisted cumulative cost for a session, without creating a zero-cost record. */
	getSessionCost(sessionId: string): SessionCost | undefined {
		return this.sessionCostPlumbing.getSessionCost(sessionId);
	}

	/** Merge authoritative persisted cost into a state snapshot when cost exists. */
	withSessionCostInState(sessionId: string, data: unknown): unknown {
		return this.sessionCostPlumbing.withSessionCostInState(sessionId, data);
	}

	/** Build the cumulative cost_update payload used for attach/reconnect hydration. */
	getSessionCostUpdate(sessionId: string): Extract<ServerMessage, { type: "cost_update" }> | null {
		return this.sessionCostPlumbing.getSessionCostUpdate(sessionId);
	}

	/** Broadcast cumulative persisted cost to connected clients, if this session has cost data. */
	broadcastSessionCost(session: SessionInfo): void {
		return this.sessionCostPlumbing.broadcastSessionCost(session);
	}

	/**
	 * Resolve the taskId (if any) assigned to a session.
	 *
	 * Fast path: `session.taskId` / `persisted.taskId` are stamped once at
	 * session creation (`createSession` opts.taskId) for the normal
	 * task-driven spawn flow — cheap, no scan needed.
	 *
	 * Slow path (PERF-05): sessions with neither (ad hoc / legacy / not
	 * spawned for a task) fall back to scanning every project's TaskStore
	 * for a task whose `assignedSessionId` matches. That fallback is cached
	 * per session, keyed by `ProjectContextManager.getTaskGeneration()` — a
	 * cheap integer sum bumped by every task mutation across every project
	 * (see TaskStore.getGeneration). A generation mismatch (any task
	 * assigned/reassigned/removed anywhere) invalidates the entry and forces
	 * a fresh scan; otherwise the cached result (including a cached "no
	 * task" `undefined`) is reused. This is what keeps sessions with no task
	 * from re-scanning on every single `message_end` (the PERF-05
	 * reproduction case), while still observing a later (re)binding.
	 */
	private resolveTaskIdForSession(sessionId: string): string | undefined {
		return this.sessionCostPlumbing.resolveTaskIdForSession(sessionId);
	}

	/** Delegates to McpWiring (SessionManager decomposition cohort 2, docs/design/session-manager-decomposition.md). */
	getMcpManager(scope?: { projectId?: string; cwd?: string; scopeKey?: string }): McpManager | null {
		return this.mcpWiring.getMcpManager(scope);
	}

	/** Delegates to McpWiring. */
	getActiveMcpManagers(): McpManager[] {
		return this.mcpWiring.getActiveMcpManagers();
	}

	/**
	 * Delegates to McpWiring. Kept as a real prototype method (not inlined)
	 * because tests/mcp-manager-marketplace-discovery.test.ts monkey-patches
	 * this exact method on a `new SessionManager()` instance and expects
	 * McpWiring's OWN internal callers (removeScopedMcpManagerByKey,
	 * reloadMcpAfterMarketplaceMutation's pending-reload callback, initMcp)
	 * to observe the patch — see mcp-wiring.ts's TEST-SEAM HAZARD comment and
	 * this constructor's McpWiring wiring above.
	 */
	refreshExternalMcpToolRegistrations(): void {
		this.mcpWiring.refreshExternalMcpToolRegistrations();
	}

	/** Delegates to McpWiring. */
	async cleanupScopedMcpManagersForProject(projectId: string, rootPath?: string): Promise<void> {
		return this.mcpWiring.cleanupScopedMcpManagersForProject(projectId, rootPath);
	}

	/** Delegates to McpWiring. Cluster G (ArchivedWorktreeManager) and cluster I (terminateSession) call this by name — see this constructor's ArchivedWorktreeDeps wiring above. */
	private async cleanupScopedMcpManagersForSessionScope(scope: { projectId?: string; cwd?: string }): Promise<void> {
		return this.mcpWiring.cleanupScopedMcpManagersForSessionScope(scope);
	}

	/**
	 * Delegates to McpWiring. Kept as a real prototype method — monkey-patched
	 * directly by tests/mcp-manager-marketplace-discovery.test.ts and
	 * tests/session-manager-ambient-mcp-isolation.test.ts to stub out real
	 * `McpManager` construction; McpWiring's own `ensureMcpManager`/`initMcp`
	 * round-trip through `deps.createMcpManager` (i.e. back through this
	 * method) so the patch is honored — see mcp-wiring.ts's TEST-SEAM HAZARD
	 * comment.
	 */
	private createMcpManager(cwd: string, opts?: { projectId?: string; scopeKey?: string; includeAdditionalProjects?: boolean }): McpManager {
		return this.mcpWiring.createMcpManager(cwd, opts);
	}

	/**
	 * Delegates to McpWiring. Kept as a real prototype method — monkey-patched
	 * directly by tests/mcp-manager-marketplace-discovery.test.ts and
	 * tests/headquarters-server-scope-guards.test.ts; McpWiring's own
	 * `ensureMcpManagerForContext`/`reloadMcpAfterMarketplaceMutation`/
	 * `resolveMcpManagerForSession` round-trip through `deps.ensureMcpManager`
	 * (i.e. back through this method) so the patch is honored — see
	 * mcp-wiring.ts's TEST-SEAM HAZARD comment.
	 */
	async ensureMcpManager(scope?: { projectId?: string; cwd?: string; scopeKey?: string }): Promise<McpManager | null> {
		return this.mcpWiring.ensureMcpManager(scope);
	}

	/** Delegates to McpWiring. Cluster A (buildPipelineContext) and cluster F (buildToolActivationArgs) call this by name. */
	private getMcpManagerForContext(projectId?: string, cwd?: string): McpManager | null {
		return this.mcpWiring.getMcpManagerForContext(projectId, cwd);
	}

	/**
	 * Delegates to McpWiring. Kept as a real prototype method — this is the
	 * PR #105 test-seam (tests/helpers/mcp-stub.ts's `stubMcp()`) that
	 * clusters A/B/I (restoreSession, createSession, createDelegateSession,
	 * grantToolPermission, forceAbort) call by name to avoid reaching real
	 * ambient MCP config in unit tests (design doc §2.3/hazard 3). McpWiring's
	 * own `ensureMcpManagerForSession` round-trips through
	 * `deps.ensureMcpManagerForContext` (i.e. back through this method) so
	 * the stub is honored from every internal path too.
	 */
	private async ensureMcpManagerForContext(projectId?: string, cwd?: string): Promise<McpManager | null> {
		return this.mcpWiring.ensureMcpManagerForContext(projectId, cwd);
	}

	/** Delegates to McpWiring. */
	getMcpManagerForSession(sessionId: string): McpManager | null {
		return this.mcpWiring.getMcpManagerForSession(sessionId);
	}

	/** Delegates to McpWiring. */
	async ensureMcpManagerForSession(sessionId: string): Promise<McpManager | null> {
		return this.mcpWiring.ensureMcpManagerForSession(sessionId);
	}

	/** Delegates to McpWiring. */
	async resolveMcpManagerForSession(sessionId: string, scopeKey?: string): Promise<McpManager | null> {
		return this.mcpWiring.resolveMcpManagerForSession(sessionId, scopeKey);
	}

	/** Delegates to McpWiring. */
	async reloadMcpAfterMarketplaceMutation(scope?: "server" | "global-user" | "project", projectId?: string): Promise<McpReloadResult | undefined> {
		return this.mcpWiring.reloadMcpAfterMarketplaceMutation(scope, projectId);
	}

	/** Delegates to McpWiring. */
	setMarketplaceMcpResolver(resolver: MarketplaceMcpResolver | null | undefined): void {
		this.mcpWiring.setMarketplaceMcpResolver(resolver);
	}

	setMarketplacePiExtensionResolver(resolver: MarketplacePiExtensionResolver | null | undefined): void {
		this.marketplacePiExtensionResolver = resolver ?? null;
	}

	resolveMarketplacePiExtensionContributions(projectId?: string, cwd?: string): ReturnType<MarketplacePiExtensionResolver> {
		return this.overlayPiExtensionRuntimeDiagnostics(this.marketplacePiExtensionResolver?.({ projectId, cwd }) ?? []);
	}

	private resolveMarketplacePiExtensionArgs(projectId?: string, cwd?: string): MarketplacePiExtensionActivation {
		const activation = resolveMarketplacePiExtensionActivation((scope) => this.resolveMarketplacePiExtensionContributions(scope.projectId, scope.cwd), projectId, cwd);
		return activation;
	}

	private piExtensionDiagnosticKeys(extension: Pick<RuntimePiExtensionInfo, "entryPath" | "listName" | "origin">): string[] {
		const keys = [
			`path:${path.resolve(extension.entryPath)}`,
			`origin:${extension.origin.scope}:${extension.origin.packId}:${extension.listName}`,
			`pack:${extension.origin.scope}:${extension.origin.packName}:${extension.listName}`,
		];
		return keys;
	}

	private overlayPiExtensionRuntimeDiagnostics(rows: ReturnType<MarketplacePiExtensionResolver>): ReturnType<MarketplacePiExtensionResolver> {
		return rows.map((row) => {
			if (!row.entryPath || row.diagnostic.status === "disabled" || row.diagnostic.status === "unresolved" || row.diagnostic.status === "remap-failed") return row;
			const diagnostic = this.piExtensionDiagnosticKeys({ entryPath: row.entryPath, listName: row.listName, origin: row.origin })
				.map((key) => this.piExtensionRuntimeDiagnostics.get(key))
				.find(Boolean);
			return diagnostic ? { ...row, diagnostic } : row;
		});
	}

	private recordPiExtensionDiagnostic(session: SessionInfo, diagnostic: RuntimePiExtensionDiagnostic, extension: RuntimePiExtensionInfo): void {
		const piDiagnostic: PiExtensionDiagnostic = { ...diagnostic };
		for (const key of this.piExtensionDiagnosticKeys(extension)) this.piExtensionRuntimeDiagnostics.set(key, piDiagnostic);
		console.warn(`[pi-extension] ${diagnostic.status} ${extension.origin.packName}/${extension.listName}: ${diagnostic.message}`);
		emitSessionEvent(session, {
			type: "pi_extension_diagnostic",
			diagnostic: piDiagnostic,
			extension: {
				listName: extension.listName,
				entryPath: extension.entryPath,
				entryRelativePath: extension.entryRelativePath,
				packRoot: extension.packRoot,
				origin: extension.origin,
			},
		});
	}

	/**
	 * Initialize the worktree pool for a repo. Pre-creates worktrees in the
	 * background so new sessions can claim one instantly (~0ms) instead of
	 * waiting for `git worktree add` + `npm ci` + `git push` (~10-30s).
	 */
	initWorktreePoolForProject(projectId: string, repoPath: string, componentsResolver?: () => import("./project-config-store.js").Component[], targetSize = 2, worktreeRoot?: string, baseRefResolver?: () => string | undefined, setupTimeoutResolver?: () => number | string | undefined, projectRoot?: string): void {
		if (projectId === HEADQUARTERS_PROJECT_ID) {
			this.worktreePools.delete(projectId);
			return;
		}
		if (this.worktreePools.has(projectId)) return;
		// `baseRefResolver` reads the live project `base_ref` setting; the resolver
		// pattern (mirrors `componentsResolver`) lets pool entries auto-adopt the
		// current configured integration target without a server restart. When
		// callers don't supply one, the pool falls back to today's
		// `resolveRemotePrimary` behaviour (see `docs/design/base-ref.md` §7).
		// `setupTimeoutResolver` reads `worktree_setup_timeout_ms` so the project
		// default applies to per-component setup during pool prebuild.
		const pool = new WorktreePool({ repoPath, targetSize, componentsResolver, worktreeRoot, baseRefResolver, setupTimeoutResolver, projectRoot });
		this.worktreePools.set(projectId, pool);

		// Collect worktree paths owned by active sessions so the pool doesn't
		// reclaim them as orphaned pool entries on restart.
		const activeWorktreePaths = new Set<string>();
		for (const s of this.sessions.values()) {
			if (s.worktreePath) activeWorktreePaths.add(s.worktreePath);
		}

		pool.startFilling(activeWorktreePaths);
	}

	/** @deprecated Use initWorktreePoolForProject instead. */
	initWorktreePool(repoPath: string, _setupCommand?: string, targetSize = 2): void {
		// Legacy shim — uses empty string as key for backward compat. setupCommand
		// is ignored; canonical path is `components[*].worktreeSetupCommand`.
		this.initWorktreePoolForProject("", repoPath, undefined, targetSize);
	}

	/** Get the worktree pool for a specific project. */
	getWorktreePool(projectId?: string): WorktreePool | null {
		if (projectId === HEADQUARTERS_PROJECT_ID) return null;
		if (projectId === undefined) {
			// Legacy: return the first pool (backward compat for callers that don't pass projectId)
			const first = this.worktreePools.values().next();
			return first.done ? null : first.value;
		}
		return this.worktreePools.get(projectId) ?? null;
	}

	/** Get all worktree pools (for shutdown / API). */
	/** The warm pi-process pool (wave 1) — for `drain()` at gateway shutdown. */
	getPiProcessPool(): PiProcessPool {
		return this.piProcessPool;
	}

	getAllWorktreePools(): Map<string, WorktreePool> {
		return this.worktreePools;
	}

	/** Drain and remove a project's worktree pool (for project deletion). */
	async removeWorktreePool(projectId: string): Promise<void> {
		if (projectId === HEADQUARTERS_PROJECT_ID) {
			this.worktreePools.delete(projectId);
			return;
		}
		const pool = this.worktreePools.get(projectId);
		if (pool) {
			await pool.drain();
			this.worktreePools.delete(projectId);
		}
	}

	/** Delegates to McpWiring. */
	async initMcp(cwd: string): Promise<void> {
		return this.mcpWiring.initMcp(cwd);
	}

	/** Build a markdown list of available workflows for the goal assistant prompt. */
	private _buildWorkflowList(projectId?: string): string {
		let workflows: import("./workflow-store.js").Workflow[] = [];
		if (projectId && this.configCascade) {
			workflows = this.configCascade.resolveWorkflows(projectId).map(r => r.item);
		} else if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (ctx) workflows = ctx.workflowStore.getAll();
		}
		if (!workflows || workflows.length === 0) {
			return '⚠️ This project has no workflows configured. You CANNOT propose a goal yet — the user must run the project assistant first to scaffold workflows. Do not call propose_goal. Instead tell the user "this project has no workflows yet; open the project assistant from Settings → Components (or click the banner in the goal panel) to set them up", and stop.';
		}
		return workflows.map(w => {
			const gateNames = w.gates.map(g => g.name).join(', ');
			return `- **${w.id}** (${w.name}) — ${w.description}. Gates: ${gateNames}.`;
		}).join('\n');
	}

	/**
	 * Build the full set of CLI args for tool activation, including guard extensions,
	 * MCP proxies, and builtin/extension activation.
	 *
	 * Returns the args array to prepend to bridgeOptions.args.
	 */
	/**
	 * Resolve the effective allowed tools for a role.
	 * If the role has explicit allowedTools, use those.
	 * Otherwise, compute from the full policy cascade (honouring the allow default).
	 */
	private resolveEffectiveAllowedTools(role: import("./role-store.js").Role | undefined): EffectiveTool[] {
		if (!role) return [];
		if (this.toolManager) {
			return computeEffectiveAllowedTools(this.toolManager, role, this.groupPolicyStore, this.mcpManager ?? undefined);
		}
		return [];
	}

	private mergeToolNames(existing: string[] | undefined, additions: string[] | undefined): string[] | undefined {
		const merged: string[] = [];
		const seen = new Set<string>();
		for (const name of [...(existing ?? []), ...(additions ?? [])]) {
			const key = name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(name);
		}
		return merged.length > 0 ? merged : undefined;
	}

	/**
	 * Resolve a session's effective (ancestry-merged) goal metadata for the
	 * restore / respawn / force-abort tool-activation paths. Routes by goal id
	 * (mirrors the lifecycle-hub's getContextForGoal routing), falling back to
	 * the project's GoalManager, then the in-process test GoalManager. Returns
	 * `{}` (a guarded no-op) when there is no goal or no manager. Never throws —
	 * metadata is best-effort and must not break a respawn.
	 */
	private resolveEffectiveGoalMetadataForSession(goalId: string | undefined, projectId?: string): Record<string, unknown> {
		if (!goalId) return {};
		try {
			if (this.projectContextManager) {
				const ctx = this.projectContextManager.getContextForGoal(goalId)
					?? (projectId ? this.projectContextManager.getOrCreate(projectId) : undefined);
				if (ctx) return ctx.goalManager.getEffectiveGoalMetadata(goalId) ?? {};
			}
			if (this._testGoalManager) return this._testGoalManager.getEffectiveGoalMetadata(goalId) ?? {};
		} catch (err) {
			console.warn(`[session-manager] resolveEffectiveGoalMetadata failed for goal ${goalId} (non-fatal):`, err);
		}
		return {};
	}

	/**
	 * Dispatch the `goalProvisioned` lifecycle hook for a worktree provisioned
	 * OUTSIDE the GoalManager / session-setup provisioning paths — specifically
	 * the team-manager member worktrees, which `createWorktree()`s directly and
	 * hands a pre-built cwd to `createSession` (so session-setup's provisioning
	 * dispatch never fires for them). Resolves the member's EFFECTIVE goal
	 * metadata through the single resolver (no ad-hoc ancestry walk) so
	 * metadata-driven filesystem treatments land on every normal member worktree,
	 * symmetric with the goal/cold-create/pool paths. Non-fatal — never blocks
	 * a spawn. No-op when no lifecycle hub, no goal, or no worktree.
	 */
	async dispatchGoalProvisionedForWorktree(opts: {
		goalId: string | undefined;
		projectId?: string;
		worktreePath: string;
		cwd: string;
		branch?: string;
	}): Promise<void> {
		if (!this.lifecycleHub) return;
		if (!opts.goalId || !opts.worktreePath) return;
		try {
			const metadata = this.resolveEffectiveGoalMetadataForSession(opts.goalId, opts.projectId);
			await this.lifecycleHub.dispatchGoalProvisioned({
				goalId: opts.goalId,
				projectId: opts.projectId,
				worktreePath: opts.worktreePath,
				cwd: opts.cwd,
				branch: opts.branch,
				metadata,
			});
		} catch (err) {
			console.warn(`[session-manager] goalProvisioned dispatch for member worktree ${opts.worktreePath} (goal ${opts.goalId}) failed (non-fatal):`, err);
		}
	}

	/**
	 * Lower-cased set of tool names disabled via the `bobbit.disabledTools`
	 * metadata convention for a session's effective goal; undefined when none.
	 * Mirrors session-setup.ts::disabledToolsFromMetadata so the restore /
	 * respawn / force-abort paths apply the same disablement as initial setup.
	 */
	private disabledToolsForGoal(goalId: string | undefined, projectId?: string): ReadonlySet<string> | undefined {
		const raw = this.resolveEffectiveGoalMetadataForSession(goalId, projectId)["bobbit.disabledTools"];
		if (!Array.isArray(raw)) return undefined;
		const names = raw.filter((v): v is string => typeof v === "string" && v.length > 0).map(s => s.toLowerCase());
		return names.length > 0 ? new Set(names) : undefined;
	}

	/**
	 * Prompt section order from the `bobbit.promptSectionOrder` metadata
	 * convention for a session's effective goal; undefined when none. Mirrors
	 * session-setup.ts::promptSectionOrderFromMetadata so the restore / respawn
	 * paths reorder prompt sections the same way initial setup does — without
	 * this a restored session under a goal with a custom order silently reverts
	 * to the default prompt order after a gateway restart.
	 */
	private promptSectionOrderForGoal(goalId: string | undefined, projectId?: string): string[] | undefined {
		const raw = this.resolveEffectiveGoalMetadataForSession(goalId, projectId)["bobbit.promptSectionOrder"];
		if (!Array.isArray(raw)) return undefined;
		const order = raw.filter((v): v is string => typeof v === "string" && v.length > 0);
		return order.length > 0 ? order : undefined;
	}

	private buildToolActivationArgs(
		sessionId: string,
		allowedTools: EffectiveTool[] | undefined,
		role: { toolPolicies?: Record<string, GrantPolicy> } | undefined,
		cwd: string,
		projectId?: string,
		effectiveGoalId?: string,
		grantedTools?: string[],
	): { args: string[]; env: Record<string, string>; runtimeExtensions: RuntimePiExtensionInfo[] } {
		// Goal-metadata disabled tools (bobbit.disabledTools). Resolved from the
		// session's EFFECTIVE goal (goalId ?? teamGoalId, threaded by the caller)
		// so restart/respawn/force-abort keep the same disablement initial setup
		// applied — without this a restored session re-acquires disabled tools.
		const disabledTools = this.disabledToolsForGoal(effectiveGoalId, projectId);
		const filteredAllowed = disabledTools && allowedTools
			? allowedTools.filter(e => !disabledTools.has(e.name.toLowerCase()))
			: allowedTools;
		const flatNames = filteredAllowed?.map(e => e.name);
		const toolScope = scopedToolContext(projectId, cwd);

		const mcpManager = this.getMcpManagerForContext(projectId, cwd);

		// MCP proxy extensions
		const mcpExtPaths = mcpManager
			? writeMcpProxyExtensions(mcpManager, flatNames, role, this.toolManager, this.groupPolicyStore, disabledTools, toolScope)
			: undefined;

		// Builtin + bobbit-extension activation
		const activation = computeToolActivationArgs(filteredAllowed, this.toolManager, cwd, mcpExtPaths, disabledTools, toolScope);
		const piExtensionActivation = this.resolveMarketplacePiExtensionArgs(projectId, cwd);

		const args = prependToolResultErrorBridge([...activation.args, ...piExtensionActivation.args]);

		// Compute session-specific grants (tools in allowedTools but not in the role's base allowedTools)
		// and layer explicit grant records on top. Ask-gated tools are part of the
		// effective role surface so the derived diff alone cannot identify that a
		// session-only approval should pre-populate the guard after restart. One-time
		// approvals are intentionally not threaded into grantedTools; the guard lets
		// only the blocked invocation continue based on the grant response mode.
		const roleBaseTools = role && this.toolManager
			? computeEffectiveAllowedTools(this.toolManager, role as import("./role-store.js").Role, this.groupPolicyStore, mcpManager ?? undefined, toolScope)
			: [];
		const roleAllowed = new Set(roleBaseTools.map(t => t.name.toLowerCase()));
		const derivedSessionGrants = (flatNames ?? []).filter(t => !roleAllowed.has(t.toLowerCase()));
		const sessionGrants = this.mergeToolNames(derivedSessionGrants, grantedTools) ?? [];

		// Tool guard extension for 'ask' policy tools
		const guardPath = this.toolManager
			? writeToolGuardExtension(sessionId, this.toolManager, mcpManager ?? undefined, role, this.groupPolicyStore, sessionGrants, disabledTools, toolScope)
			: undefined;
		if (guardPath) {
			args.push("--extension", guardPath);
		}

		// Provider-bridge extension (per-turn beforePrompt / beforeCompact hooks).
		// Mirrors session-setup.ts::resolveToolActivation so respawn/restore paths
		// (restore, role reassignment, force-abort respawn) keep the bridge that
		// initial setup added. Without this, provider-enabled sessions lose the
		// bridge after a gateway restart/respawn and per-turn hooks stop firing.
		// The effective goal id filters disabled providers (bobbit.disabledProviders)
		// so a goal that disabled a provider stays bridge-free after respawn too.
		// Zero overhead when no enabled provider declares those hooks — the bridge
		// is neither written nor pushed onto the spawn args.
		if (this.lifecycleHub && hasProviderBridgeHooks(this.lifecycleHub, projectId, effectiveGoalId)) {
			const bridgePath = writeProviderBridgeExtension(sessionId);
			if (bridgePath) {
				args.push("--extension", bridgePath);
			}
		}

		// OpenAI Responses preflight guard. Mirrors session setup so restore,
		// role-reassignment, and force-abort respawn paths keep dropping orphan
		// function_call_output items before provider requests are sent.
		const openAiOrphanGuardPath = writeOpenAiOrphanToolResultExtension();
		if (openAiOrphanGuardPath) {
			args.push("--extension", openAiOrphanGuardPath);
		}

		// Google account (Code Assist) provider extension. Mirrors
		// session-setup.ts::resolveToolActivation so respawn/restore paths keep the
		// provider registered and `google-gemini-cli/*` models stay runnable after a
		// gateway restart. Written unconditionally (not credential-gated) so a
		// session spawned before Google sign-in can bind such a model after auth.
		const codeAssistPath = writeGoogleCodeAssistProviderExtension(sessionId);
		if (codeAssistPath) {
			args.push("--extension", codeAssistPath);
		}

		return { args, env: activation.env, runtimeExtensions: piExtensionActivation.runtimeExtensions };
	}

	private resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): import("./role-store.js").Role | undefined {
		const name = roleName || (assistantType ? "assistant" : "general");
		// Cascade-first: pack-shipped roles (e.g. `pr-reviewer`) live in the config
		// cascade, not the in-memory RoleManager. Resolving via roleManager alone
		// returns `undefined` for a pack role, which on the restore / force-respawn
		// paths drops its tools (guard falls through to group defaults). Always ask
		// the cascade, even without projectId, so server-scope/builtin market-pack
		// roles work for system-scope sessions too.
		if (this.configCascade) {
			try {
				const match = this.configCascade.resolveRoles(projectId).find(r => r.item.name === name);
				if (match) return match.item;
			} catch { /* fall through to roleManager */ }
		}
		return this.roleManager?.getRole(name);
	}

	/** Generate tool docs and inject into prompt parts before assembly. */
	private assemblePrompt(sessionId: string, parts: PromptParts): string | undefined {
		return profile("sessionManager.assemblePrompt", () => this._assemblePrompt(sessionId, parts));
	}

	private _assemblePrompt(sessionId: string, parts: PromptParts): string | undefined {
		if (!parts.serverConfigStore) parts.serverConfigStore = this.projectConfigStore;
		if (this.toolManager && !parts.toolDocs) {
			parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir(), undefined, undefined, parts);
		}
		// Skills catalog — progressive disclosure (level 1) for autonomous activation.
		// Skipped when the session lacks `activate_skill` (catalog is useless without
		// the activator) or when explicitly already populated.
		if (!parts.skillsCatalog) {
			const catalogProjectId = this.sessions.get(sessionId)?.projectId;
			parts.skillsCatalog = this.computeSkillsCatalog(parts.allowedTools, parts.projectRoot || parts.cwd, parts.projectConfigStore, catalogProjectId);
		}
		// Stamp the user-configured skills-catalog byte budget onto the parts so it flows
		// into both the assembled prompt and the persisted prompt-sections snapshot.
		if (parts.skillsCatalogBudget === undefined && this.preferencesStore) {
			const pref = this.preferencesStore.get("skillsCatalogBudget");
			if (typeof pref === "number" && Number.isFinite(pref)) {
				parts.skillsCatalogBudget = pref;
			}
		}
		// Cache parts for prompt-sections API
		const session = this.sessions.get(sessionId);
		if (session) session.promptParts = parts;
		// Persist prompt sections snapshot for the inspector
		persistPromptSections(sessionId, parts);
		return assembleSystemPrompt(sessionId, parts);
	}

	private projectConfigStoreForPrompt(projectId?: string): import("./project-config-store.js").ProjectConfigStore | undefined {
		if (projectId && this.projectContextManager) {
			return this.projectContextManager.getOrCreate(projectId)?.projectConfigStore ?? this.projectConfigStore;
		}
		return this.projectConfigStore;
	}

	/**
	 * Build the skills-catalog list for autonomous activation.
	 * Returns undefined when activate_skill is not allowed for the session
	 * (signalling "no Available Skills section" to assembleSystemPrompt).
	 */
	private computeSkillsCatalog(
		allowedTools: string[] | undefined,
		discoveryRoot: string,
		projectConfigStore?: { get(key: string): string | undefined },
		projectId?: string,
	): import("../skills/slash-skills.js").SlashSkill[] | undefined {
		// allowedTools=undefined => unrestricted; include the catalog.
		// allowedTools=[] (EXPLICIT no tools, e.g. a recursion-stripped delegate or
		// a session emptied by bobbit.disabledTools) => no activate_skill, so emit
		// NO Available Skills affordance. A non-empty allowlist must contain
		// activate_skill for the catalog to appear. `[].some(...)` is false, so an
		// empty allowlist correctly returns undefined here.
		if (allowedTools) {
			const hasActivate = allowedTools.some(t => t.toLowerCase() === "activate_skill");
			if (!hasActivate) return undefined;
		}
		try {
			// Best-available market-scope wiring (finding #3): thread the server
			// base + server config store so server/global-user market skill packs
			// resolve for the active project even when its root != server cwd.
			const headquartersScope = projectId === HEADQUARTERS_PROJECT_ID;
			const marketContext: SkillMarketContext = {
				serverBase: headquartersDir(),
				globalUserBase: os.homedir(),
				projectBase: headquartersScope ? "" : discoveryRoot,
				serverConfigStore: this.projectConfigStore,
				projectConfigStore: headquartersScope ? undefined : projectConfigStore as SkillMarketContext["projectConfigStore"],
				// pack-schema-v1 §7: filter disabled market-pack skills out of the runtime
				// activation catalog too, using the SAME pack_activation store (server/
				// global-user → server config store; project → the project's config store).
				packActivation: (scope, packName) => {
					const store = scope === "project"
						? (!headquartersScope && projectId && this.projectContextManager
							? this.projectContextManager.getOrCreate(projectId)?.projectConfigStore
							: undefined)
						: this.projectConfigStore;
					return store?.getPackActivation(scope, packName) ?? {};
				},
			};
			const all = discoverSlashSkills(discoveryRoot, projectConfigStore, marketContext);
			// Filter: omit disable-model-invocation and skills with empty descriptions.
			// userInvocable=false skills are already filtered by discoverSlashSkills.
			return all.filter(s => s.disableModelInvocation !== true && (s.description?.trim() || "").length > 0);
		} catch (err) {
			console.warn(`[session-manager] Failed to discover skills for catalog (root=${discoveryRoot}):`, err);
			return undefined;
		}
	}

	private buildDelegateTaskSpec(instructions: string, context?: Record<string, string>): string {
		let taskSpec = instructions;
		if (context && Object.keys(context).length > 0) {
			taskSpec += "\n\n## Context";
			for (const [key, value] of Object.entries(context)) {
				taskSpec += `\n- **${key}**: ${value}`;
			}
		}
		return taskSpec;
	}

	private buildDelegatePromptParts(opts: {
		cwd: string;
		projectRoot?: string;
		instructions: string;
		context?: Record<string, string>;
		allowedTools?: string[];
		sectionOrder?: string[];
	}): PromptParts {
		// F22: a PROVABLY narrow delegate (allowedTools restricted entirely to
		// file/shell primitives — see isNarrowDelegateAllowedTools) gets the
		// "narrow-worker" profile: the nearest AGENTS.md only (no ancestor
		// config-dir cascade — achieved by omitting projectConfigStore below,
		// which falls back to readAgentsMd()'s single-nearest-file behavior)
		// and no branch-discipline rationale in the Working Directory section
		// (handled inside assembleSystemPrompt via promptProfile). Unrestricted
		// allowedTools (undefined/empty) cannot prove narrowness, so it keeps
		// the full cascade + full prompt — conservative by construction.
		const narrow = isNarrowDelegateAllowedTools(opts.allowedTools);
		return {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: opts.cwd,
			projectRoot: opts.projectRoot,
			// Delegates carry a durable task, not a goal. Older spawn code mapped this
			// through goalSpec before the live SessionInfo existed; reconstruction uses
			// the existing Task renderer so the inspector shows one task-oriented section
			// and never duplicates the instructions across Goal + Task.
			taskTitle: "Delegate Task",
			taskSpec: this.buildDelegateTaskSpec(opts.instructions, opts.context),
			allowedTools: opts.allowedTools,
			projectConfigStore: narrow ? undefined : this.projectConfigStore,
			serverConfigStore: this.projectConfigStore,
			sectionOrder: opts.sectionOrder,
			promptProfile: narrow ? "narrow-worker" : undefined,
		};
	}

	/** Get cached PromptParts for serving prompt-sections API.
	 *  If not cached (e.g. dormant session), rebuild from session metadata. */
	getPromptParts(sessionId: string): PromptParts | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) return undefined;

		let persisted: PersistedSession | undefined;
		try { persisted = this.resolveStoreForId(session.id)?.get(session.id); }
		catch { persisted = undefined; }
		const effectiveGoalId = session.goalId ?? session.teamGoalId ?? persisted?.goalId ?? persisted?.teamGoalId;
		const sectionOrder = this.promptSectionOrderForGoal(effectiveGoalId, session.projectId ?? persisted?.projectId);
		const ownerProjectId = session.projectId ?? persisted?.projectId;
		const ownerProjectConfigStore = this.projectConfigStoreForPrompt(ownerProjectId);

		// Delegate task instructions are durable store data, not ordinary cached prompt
		// state. A provider hook can run after an early incomplete cache was created;
		// for delegates, always rebuild from persisted instructions/context so the
		// refresh path cannot overwrite the inspector snapshot with a task-less prompt.
		const isDelegate = !!(session.delegateOf || persisted?.delegateOf);
		if (isDelegate && persisted?.instructions?.trim()) {
			const parts = this.buildDelegatePromptParts({
				cwd: session.cwd,
				projectRoot: persisted.repoPath,
				instructions: persisted.instructions,
				context: persisted.context,
				allowedTools: session.allowedTools ?? persisted.allowedTools,
				sectionOrder,
			});
			parts.projectConfigStore = isNarrowDelegateAllowedTools(parts.allowedTools) ? undefined : ownerProjectConfigStore;
			parts.serverConfigStore = this.projectConfigStore;
			parts.dynamicContext = session.promptParts?.dynamicContext;
			if (this.toolManager && !parts.toolDocs) {
				parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir(), undefined, undefined, parts);
			}
			if (!parts.skillsCatalog) {
				parts.skillsCatalog = this.computeSkillsCatalog(
					parts.allowedTools,
					parts.projectRoot || parts.cwd,
					parts.projectConfigStore,
					session.projectId ?? persisted.projectId,
				);
			}
			if (parts.skillsCatalogBudget === undefined && this.preferencesStore) {
				const pref = this.preferencesStore.get("skillsCatalogBudget");
				if (typeof pref === "number" && Number.isFinite(pref)) parts.skillsCatalogBudget = pref;
			}
			session.promptParts = parts;
			return parts;
		}

		if (session.promptParts) return session.promptParts;

		// Rebuild on demand for dormant / restored sessions missing cached parts
		const assistantDef = session.assistantType ? getAssistantDef(session.assistantType) : undefined;
		let parts: PromptParts;

		if (assistantDef) {
			const assistantTemplate = this.resolveRolePromptTemplate("assistant", session.projectId);
			let assistantGoalSpec = "";
			if (assistantTemplate) {
				assistantGoalSpec = assistantTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(session.goalId || session.id).slice(0, 8)}`);
				assistantGoalSpec += "\n\n---\n\n";
			}
			assistantGoalSpec += assistantDef.prompt;
			if (session.assistantType === "goal") {
				assistantGoalSpec = assistantGoalSpec.replace('{{AVAILABLE_WORKFLOWS}}', this._buildWorkflowList(session.projectId));
				// Inject re-attempt context if this is a re-attempt session
				const reattemptId = (this.resolveStoreForSession(session.id).get(session.id) as any)?.reattemptGoalId;
				if (reattemptId) {
					const origGoal = this.resolveGoal(reattemptId);
					if (origGoal) {
						assistantGoalSpec += "\n\n" + buildReattemptContext(origGoal, this.prStatusStore!);
					}
				}
			}
			assistantGoalSpec = applyPromptConditionals(assistantGoalSpec, { subGoalsEnabled: this.isSubgoalsEnabled });
			parts = {
				// Assistant prompt reconstruction must include the base system prompt
				// so it survives respawn / rebuild paths (not just initial session-setup).
				baseSystemPromptPath: this.systemPromptPath,
				cwd: session.cwd,
				projectRoot: persisted?.repoPath,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: session.allowedTools,
				projectConfigStore: ownerProjectConfigStore,
				serverConfigStore: this.projectConfigStore,
				sectionOrder,
			};
		} else {
			const goal = session.goalId ? this.resolveGoal(session.goalId) : undefined;

			// Source the template via the field-level cascade (PR feature), then run
			// master's centralized placeholder substitution so create/restore can't drift.
			const tmpl = session.role && this.roleManager
				? this.resolveRolePromptTemplate(session.role, session.projectId)
				: undefined;
			const rolePrompt = resolveRolePrompt(tmpl ? { promptTemplate: tmpl } : undefined, {
				branch: goal?.branch,
				agentId: `${session.role}-${(session.goalId || session.id).slice(0, 8)}`,
				roleManager: this.roleManager,
				subGoalsEnabled: this.isSubgoalsEnabled,
			});
			const roleName = rolePrompt ? session.role : undefined;

			parts = {
				baseSystemPromptPath: this.systemPromptPath,
				cwd: session.cwd,
				projectRoot: persisted?.repoPath,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec: goal?.spec,
				rolePrompt,
				roleName,
				allowedTools: session.allowedTools,
				projectConfigStore: ownerProjectConfigStore,
				serverConfigStore: this.projectConfigStore,
				sectionOrder,
				promptProfile: (session.nonInteractive ?? persisted?.nonInteractive) ? "reviewer" : undefined,
			};
		}

		if (this.toolManager && !parts.toolDocs) {
			parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir(), undefined, undefined, parts);
		}
		if (!parts.skillsCatalog) {
			parts.skillsCatalog = this.computeSkillsCatalog(
				parts.allowedTools,
				parts.projectRoot || parts.cwd,
				parts.projectConfigStore,
				session.projectId ?? persisted?.projectId,
			);
		}
		if (parts.skillsCatalogBudget === undefined && this.preferencesStore) {
			const pref = this.preferencesStore.get("skillsCatalogBudget");
			if (typeof pref === "number" && Number.isFinite(pref)) parts.skillsCatalogBudget = pref;
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

	private persistedInFlightSteerTexts(session: SessionInfo): string[] | undefined {
		const ledger = session.inFlightSteerTexts?.filter(text => typeof text === "string" && text.length > 0) ?? [];
		return ledger.length > 0 ? [...ledger] : undefined;
	}

	private persistInFlightSteerLedger(session: SessionInfo): void {
		this.resolveStoreForSession(session.id).update(session.id, {
			inFlightSteerTexts: this.persistedInFlightSteerTexts(session),
		});
	}

	private broadcastQueue(session: SessionInfo, opts?: { includeInFlightSteers?: boolean }): void {
		const queue = session.promptQueue.toArray();
		broadcast(session.clients, {
			type: "queue_update",
			sessionId: session.id,
			queue,
		});
		const updates: { messageQueue: QueuedMessage[]; inFlightSteerTexts?: string[] } = { messageQueue: queue };
		if (opts?.includeInFlightSteers) updates.inFlightSteerTexts = this.persistedInFlightSteerTexts(session);
		this.resolveStoreForSession(session.id).update(session.id, updates);
	}

	/**
	 * dead-bridge auto-revive — Auto-revive a dead RPC bridge before dispatching a brand-new
	 * prompt. Used ONLY at the two new-prompt sites in `enqueuePrompt` (the
	 * error-recovery branch and the idle+empty branch) — NOT in steady-state
	 * retry/drain paths, which should fail loudly so a real bridge death
	 * surfaces in logs.
	 *
	 * Symptom this protects against: post-restart, a session's persisted record
	 * is restored but its in-process RPC bridge is dead. The WS layer ack's the
	 * prompt but the agent never sees it because `rpcClient.prompt()` throws
	 * "Agent process not running" — and the user gets a phantom-stuck session
	 * with no recovery affordance.
	 *
	 * Invariant: callers MUST refetch the session entry from `this.sessions`
	 * after this returns, because `restartAgent` deletes and re-creates it.
	 * That's why this helper returns the (possibly fresh) `SessionInfo` rather
	 * than letting the caller hold onto a stale reference.
	 */
	/**
	 * CLF-W1b/W3 — consult the built-in F14 thinking-level router (registered
	 * at construction, see `registerThinkingRouterClassifier` in `server.ts`)
	 * for this submitted prompt. The outcome is ALWAYS traced (`dispatchDecision`
	 * → `ContextTraceStore.appendDecision`) and, when the message goes on to be
	 * queued rather than dispatched directly, stamped onto the `QueuedMessage`
	 * row. `applyIfSelected` (CLF-W3) is passed straight through to
	 * `dispatchDecision`'s own `opts.applyIfSelected` so the recorded outcome's
	 * `applied` field matches what the caller is ABOUT to do with a `select` —
	 * this method itself never calls `setThinkingLevel`; see `enqueuePrompt`.
	 *
	 * Returns `undefined` (rather than throwing) when the (point,kind) pair
	 * isn't registered on the hub (e.g. a bare test `LifecycleHub` built
	 * without `registerThinkingRouterClassifier`) or the classifier itself
	 * errors — this consult must never block a prompt from dispatching.
	 *
	 * Callers MUST guard `if (this.lifecycleHub)` themselves rather than
	 * calling this unconditionally: `await`ing a promise always yields at
	 * least one microtask tick, even one that resolves synchronously inside
	 * this method, and the no-hub case (the overwhelming majority of today's
	 * unit tests, which construct a bare `SessionManager`) must stay
	 * byte-identical down to the same tick — no new await point at all — not
	 * merely "resolves quickly". See the direct-dispatch tests in
	 * tests/session-manager-direct-prompt-lifecycle.test.ts that assert
	 * `rpcClient.prompt` was already called synchronously before the caller
	 * awaits `enqueuePrompt`'s own returned promise.
	 */
	private async consultThinkingRouterHub(session: SessionInfo, text: string, applyIfSelected: boolean): Promise<Decision<ThinkingLevel> | undefined> {
		try {
			return await this.lifecycleHub!.dispatchDecision<ThinkingLevel>(
				THINKING_ROUTER_POINT,
				THINKING_ROUTER_KIND,
				{ sessionId: session.id, projectId: session.projectId, goalId: session.goalId, cwd: session.cwd },
				{ text },
				{ applyIfSelected },
			);
		} catch (err) {
			console.warn(`[session-manager] thinking-router dispatchDecision failed for session ${session.id} (non-fatal, observe-mode only): ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	/**
	 * CLF-W3 — precedence gate for the F14 thinking-router's apply mode
	 * (`BOBBIT_CLF_THINKING_ROUTER=enforce`). The classifier's per-prompt
	 * `select` must LOSE to any thinking-level config a human (or a role
	 * author) already committed to:
	 *   - a role-level `thinkingLevel` override (`resolveRoleThinkingLevel`) —
	 *     the role author made an explicit, considered choice for this role;
	 *   - `session.thinkingLevelUserPinned` — the user explicitly changed this
	 *     session's thinking level via the composer's slider (`set_thinking_level`
	 *     ws action), a deliberate in-session decision.
	 * Neither is "the spawn-time default resolved to something" (role/pref
	 * cascade with no explicit override) — that case has no human decision to
	 * protect, so apply mode is free to route per-prompt as usual.
	 */
	private canApplyThinkingRouterDecision(session: SessionInfo): boolean {
		if (session.thinkingLevelUserPinned) return false;
		if (this.resolveRoleThinkingLevel(session)) return false;
		return true;
	}

	private clampThinkingLevelForSession(session: SessionInfo, level: ThinkingLevel): ThinkingLevel {
		try {
			const persisted = this.resolveStoreForSession(session.id).get(session.id);
			if (persisted?.modelId) {
				const clamped = clampThinkingLevelForModel(level, persisted.modelProvider, persisted.modelId);
				if (clamped) return clamped;
			}
		} catch { /* best-effort; keep fail-open thinking-level discipline */ }
		return level;
	}

	private resolveCurrentThinkingRouterBaseline(session: SessionInfo): ThinkingLevel {
		const candidate = session.spawnPinnedThinkingLevel ?? this.resolveInitialThinkingLevel(session.role, session.projectId) ?? "medium";
		return this.clampThinkingLevelForSession(session, (isKnownThinkingLevel(candidate) ?? "medium") as ThinkingLevel);
	}

	private async restoreThinkingRouterAppliedBaseline(session: SessionInfo): Promise<void> {
		const baseline = session.thinkingRouterAppliedBaseline;
		if (!baseline) return;
		session.thinkingRouterAppliedBaseline = undefined;
		try {
			const levelToRestore = this.clampThinkingLevelForSession(session, baseline);
			await session.rpcClient.setThinkingLevel(levelToRestore);
			console.log(`[session-manager] CLF-W3 thinking-router RESTORED "${levelToRestore}" for session ${session.id}`);
		} catch (err) {
			console.warn(`[session-manager] CLF-W3 thinking-router restore failed for ${session.id} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private clearThinkingRouterAppliedBaseline(session: SessionInfo): void {
		session.thinkingRouterAppliedBaseline = undefined;
	}

	/**
	 * Enqueue a prompt. If the agent is idle and queue was empty,
	 * dispatch immediately. Otherwise add to queue and broadcast.
	 * If the agent is idle but queue has items, enqueue and drain.
	 *
	 * Returns whether this exact prompt was dispatched immediately or merely
	 * queued behind existing/busy work. Callers must not infer that from the
	 * post-call session status: direct dispatch intentionally marks the session
	 * streaming before the RPC resolves.
	 */
	async enqueuePrompt(sessionId: string, text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
		modelText?: string;
		skillExpansions?: SkillExpansion[];
		fileMentions?: FileMention[];
		source?: PromptSource;
		coldStart?: boolean;
	}): Promise<{ status: "dispatched" | "queued" }> {
		return this.sessionSteering.enqueuePrompt.call(this, sessionId, text, opts);
	}

	deliverLiveSteer(sessionId: string, message: string, opts?: { source?: PromptSource }): Promise<unknown> {
		return this.sessionSteering.deliverLiveSteer.call(this, sessionId, message, opts);
	}

	steerQueued(sessionId: string, messageId: string): boolean {
		return this.sessionSteering.steerQueued.call(this, sessionId, messageId);
	}

	private _dispatchSteer(session: SessionInfo, rows: QueuedMessage[]): Promise<void> {
		return this.sessionSteering._dispatchSteer.call(this, session, rows);
	}

	private _consumeSteerEcho(session: SessionInfo, event: any): void {
		return this.sessionSteering._consumeSteerEcho.call(this, session, event);
	}

	private _reconcileInFlightSteers(session: SessionInfo): void {
		return this.sessionSteering._reconcileInFlightSteers.call(this, session);
	}

	private _reconcileAfterAbort(session: SessionInfo): void {
		return this.sessionSteering._reconcileAfterAbort.call(this, session);
	}

	reorderQueue(sessionId: string, messageIds: string[]): void {
		return this.sessionSteering.reorderQueue.call(this, sessionId, messageIds);
	}

	removeQueued(sessionId: string, messageId: string): boolean {
		return this.sessionSteering.removeQueued.call(this, sessionId, messageId);
	}

	private markPromptDispatchStreaming(session: SessionInfo): void {
		return this.sessionSteering.markPromptDispatchStreaming.call(this, session);
	}

	private applyDirectProviderEnv(bridgeOptions: RpcBridgeOptions, sandboxed: boolean | undefined, provider?: string): void {
		return this.sessionSteering.applyDirectProviderEnv.call(this, bridgeOptions, sandboxed, provider);
	}

	private safeDispatchError(session: SessionInfo, reason: string): Error {
		return this.sessionSteering.safeDispatchError.call(this, session, reason);
	}

	private surfaceProviderAuthFailure(session: SessionInfo, reason: string, source: string): void {
		return this.sessionSteering.surfaceProviderAuthFailure.call(this, session, reason, source);
	}

	private maybeAutoRetryPromptDeliveryFailure(session: SessionInfo, reason: string, source: string): boolean {
		return this.sessionSteering.maybeAutoRetryPromptDeliveryFailure.call(this, session, reason, source);
	}

	private recoverPromptDispatch(session: SessionInfo, rows: Array<{
		text: string;
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
	}>, reason: string, source: string): void {
		return this.sessionSteering.recoverPromptDispatch.call(this, session, rows, reason, source);
	}

	private dispatchDirectPrompt(
		session: SessionInfo,
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
		attachments?: unknown[],
		isSteered?: boolean,
		coldStart?: boolean,
	): Promise<void> {
		return this.sessionSteering.dispatchDirectPrompt.call(this, session, text, images, attachments, isSteered, coldStart);
	}

	private drainQueue(session: SessionInfo): void {
		return this.sessionSteering.drainQueue.call(this, session);
	}

	private persistClaudeCodeMessageToTranscript(session: SessionInfo, event: any): void {
		return this.sessionSteering.persistClaudeCodeMessageToTranscript.call(this, session, event);
	}

	private handleAgentLifecycle(session: SessionInfo, event: any): void {
		return this.sessionSteering.handleAgentLifecycle.call(this, session, event);
	}

	private maybeAutoRetryTransient(session: SessionInfo): boolean {
		return this.sessionSteering.maybeAutoRetryTransient.call(this, session);
	}

	private cancelPendingAutoRetry(
		session: SessionInfo,
		reason: "explicit-retry" | "new-prompt" | "terminated" | "shutdown",
		opts?: { emitWithoutTimer?: boolean },
	): void {
		return this.sessionSteering.cancelPendingAutoRetry.call(this, session, reason, opts);
	}

	private _recoverBlankTextPoison(session: SessionInfo): Promise<SessionInfo | undefined> {
		return this.sessionSteering._recoverBlankTextPoison.call(this, session);
	}

	private consumeRecoveredPromptDispatchRows(session: SessionInfo): boolean {
		return this.sessionSteering.consumeRecoveredPromptDispatchRows.call(this, session);
	}

	private consumeQueuedRetryRow(session: SessionInfo, candidateTexts: Array<string | undefined>, images?: Array<{ type: "image"; data: string; mimeType: string }>): boolean {
		return this.sessionSteering.consumeQueuedRetryRow.call(this, session, candidateTexts, images);
	}

	async retryLastPrompt(sessionId: string, opts?: { auto?: boolean }): Promise<void> {
		return this.sessionSteering.retryLastPrompt.call(this, sessionId, opts);
	}

	/**
	 * Grant a tool or tool group to a session's role and restart the session
	 * so it picks up the new tools. Returns the updated list of allowed tools.
	 *
	 * @param mode - Grant persistence mode:
	 *   - "persistent" (default): updates role YAML permanently
	 *   - "session-only": adds to session.allowedTools in memory only (survives Refresh agent, not gateway restart)
	 *   - "one-time": adds to session.allowedTools + tracks for revocation on agent_end
	 */
	async grantToolPermission(sessionId: string, toolName: string, scope: "tool" | "group", group?: string, mode?: ToolGrantMode): Promise<string[]> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");
		if (!this.roleManager) throw new Error("No role manager available");

		// Use explicit role, or fall back to "general" role (implicit default for all sessions).
		// Resolve cascade-first so pack-contributed roles keep their policies here too.
		const roleName = session.role || "general";
		const role = this.resolveSessionRole(roleName, undefined, session.projectId);
		if (!role) throw new Error(`Role "${roleName}" not found`);

		const grantScopeTools: string[] = [];
		if (scope === "group" && group) {
			// Approving a group covers tools in that group only. Do not use the full
			// effective role surface here: ask-gated tools are registered there so the
			// model can attempt them, but they are not approved grants yet.
			if (this.mcpManager) {
				for (const info of this.mcpManager.getToolInfos()) {
					if (info.group !== group) continue;
					grantScopeTools.push(info.name);

					// The guard/model-facing MCP surface is the collapsed meta-tool
					// (`mcp_<server>` / `mcp_<server>__<sub>`), while the MCP manager
					// stores canonical per-operation names. Group grants must include
					// both forms: per-op names keep Layer B/internal filtering working,
					// and the meta name lets the active guard correlate and cache only
					// the MCP group it is currently unblocking.
					const parsed = parseMcpToolName(info.name);
					if (parsed) grantScopeTools.push(makeMetaToolName(parsed.server, parsed.sub));
				}
			}
			if (this.toolManager) {
				for (const tool of this.toolManager.getAvailableTools()) {
					if (tool.group === group) grantScopeTools.push(tool.name);
				}
			}
		} else {
			grantScopeTools.push(toolName);
		}
		const approvedGrantTools = this.mergeToolNames(undefined, grantScopeTools.length > 0 ? grantScopeTools : [toolName]) ?? [toolName];

		if (session.pendingGrantRequest) {
			const pending = session.pendingGrantRequest;
			const requestedToolMatches = pending.toolName.toLowerCase() === toolName.toLowerCase();
			const requestedGroupMatches = !!group && pending.toolGroup.toLowerCase() === group.toLowerCase();
			const approvedToolsCoverPending = approvedGrantTools.some(t => t.toLowerCase() === pending.toolName.toLowerCase());
			const grantCoversPending = scope === "group"
				? requestedGroupMatches && approvedToolsCoverPending
				: requestedToolMatches && approvedToolsCoverPending;
			if (!grantCoversPending) {
				clearTimeout(pending.timer);
				session.pendingGrantRequest = undefined;
				pending.resolve({
					granted: false,
					reason: `Ignored stale permission grant for ${toolName}; active request is for ${pending.toolName}.`,
				});
				this.appendToolPermissionAudit(session, pending, "denied", "auto");
				return session.allowedTools ?? [];
			}
		}

		let resultTools: string[];

		if (mode === "one-time") {
			// Temporary grant: add to session.allowedTools, track for revocation on agent_end
			session.allowedTools = this.mergeToolNames(session.allowedTools, approvedGrantTools) ?? [];
			session.oneTimeGrantedTools = this.mergeToolNames(session.oneTimeGrantedTools, approvedGrantTools);
			resultTools = session.allowedTools;

		} else if (mode === "session-only") {
			// Session-scoped grant: add to session.allowedTools only, don't write role YAML
			session.allowedTools = this.mergeToolNames(session.allowedTools, approvedGrantTools) ?? [];
			session.sessionOnlyGrantedTools = this.mergeToolNames(session.sessionOnlyGrantedTools, approvedGrantTools);
			resultTools = session.allowedTools;

		} else {
			// Persistent grant (default): update toolPolicies on role YAML when the
			// role is locally writable. Pack roles are read-only through RoleManager,
			// so keep the grant effective for this session without writing to the pack.
			const updatedPolicies = { ...role.toolPolicies };
			for (const t of approvedGrantTools) {
				updatedPolicies[t] = 'allow' as GrantPolicy;
			}
			const writableRole = this.roleManager.getRole(role.name);
			let effectiveRole: Role = { ...role, toolPolicies: updatedPolicies };
			if (writableRole) {
				this.roleManager.updateRole(role.name, { toolPolicies: updatedPolicies });
				effectiveRole = this.resolveSessionRole(role.name, undefined, session.projectId) ?? effectiveRole;
			} else {
				session.sessionOnlyGrantedTools = this.mergeToolNames(session.sessionOnlyGrantedTools, approvedGrantTools);
			}
			const updatedEffective = this.resolveEffectiveAllowedTools(effectiveRole).map(e => e.name);
			session.allowedTools = this.mergeToolNames(updatedEffective, writableRole ? undefined : approvedGrantTools) ?? updatedEffective;
			resultTools = session.allowedTools;
		}

		if (session.pendingGrantRequest) {
			// Single-owner grant resumption: the active guard long-poll receives only
			// the approved grant scope/delta and lets the original tool call continue.
			// Returning the full effective surface here would let unrelated ask-gated
			// tools bypass future prompts in the active process.
			clearTimeout(session.pendingGrantRequest.timer);
			const pending = session.pendingGrantRequest;
			session.pendingGrantRequest = undefined;
			pending.resolve({ granted: true, tools: approvedGrantTools, scope, group, mode: mode ?? "persistent" });
			this.appendToolPermissionAudit(session, pending, "granted", "user");
			return resultTools;
		}

		await this._restartSessionWithUpdatedRole(session);
		return resultTools;
	}

	/**
	 * CLF-W2 — consult the tool-approve decision seam (harness only, see
	 * `tool-approve-classifier.ts`) for this tool-permission ask. Returns
	 * `undefined` (rather than throwing) whenever the consult can't produce a
	 * usable Decision — no hub, an unregistered (point,kind) pair, or the
	 * classifier itself erroring — this consult must never block a tool ask
	 * from reaching the human-approval flow. Mirrors
	 * `consultThinkingRouterHub`'s fail-open discipline exactly.
	 */
	private async consultToolApproveHub(session: SessionInfo, toolName: string, toolGroup: string): Promise<Decision<ToolApproveVerdict> | undefined> {
		try {
			return await this.lifecycleHub!.dispatchDecision<ToolApproveVerdict>(
				TOOL_APPROVE_POINT,
				TOOL_APPROVE_KIND,
				{ sessionId: session.id, projectId: session.projectId, goalId: session.goalId, cwd: session.cwd },
				{ toolName, toolGroup, roleName: session.role },
			);
		} catch (err) {
			console.warn(`[session-manager] tool-approve dispatchDecision failed for session ${session.id} (non-fatal, observe-mode only): ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	private appendToolPermissionAudit(
		session: SessionInfo,
		ask: { toolName: string; toolGroup?: string; toolApproveDecision?: Decision<ToolApproveVerdict> },
		decision: ToolPermissionAuditDecision,
		source: ToolPermissionAuditSource,
	): void {
		try {
			this.toolPermissionAuditLog.append(session.id, {
				ts: Date.now(),
				sessionId: session.id,
				...(session.projectId ? { projectId: session.projectId } : {}),
				toolName: ask.toolName,
				...(ask.toolGroup ? { toolGroup: ask.toolGroup } : {}),
				decision,
				source,
				...(ask.toolApproveDecision ? { toolApproveDecision: ask.toolApproveDecision } : {}),
			});
		} catch (err) {
			console.warn(`[session-manager] tool-permission audit append failed for session ${session.id} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Called by the guard extension's long-poll endpoint. Creates a pending
	 * grant request, broadcasts to UI clients, and returns a promise that
	 * resolves when the user grants/denies or after a 5-minute timeout.
	 */
	async requestToolGrant(sessionId: string, toolName: string, toolGroup: string): Promise<ToolGrantResolution> {
		// `getSession()` (not a raw `this.sessions.get()`) — the guard extension
		// (tool-guard-extension.ts) embeds ITS OWN session id as a string literal
		// at generation time (`const sessionId = ${JSON.stringify(sessionId)}`).
		// For a warm-pool-claimed session (docs/design/warm-pi-process-pool.md)
		// that embedded id is the pool's placeholder id, not the live session's
		// real id — `getSession()` resolves the alias so tool-approval still
		// reaches the correct session instead of 404ing.
		const session = this.getSession(sessionId);
		if (!session) throw new Error("Session not found");

		// If a previous grant request is still pending, resolve it as denied
		if (session.pendingGrantRequest) {
			clearTimeout(session.pendingGrantRequest.timer);
			const pending = session.pendingGrantRequest;
			pending.resolve({ granted: false });
			this.appendToolPermissionAudit(session, pending, "denied", "auto");
			session.pendingGrantRequest = undefined;
		}

		// CLF-W2 — tool-approve decision seam consult (see
		// tool-approve-classifier.ts's header for the full design/scope).
		// Guarded OUTSIDE the await (matches `consultThinkingRouterHub`'s own
		// call site in `enqueuePrompt`): when there is no hub at all — true for
		// the overwhelming majority of today's tests and any deployment that
		// never wires one — this introduces ZERO extra microtask ticks before
		// the pre-existing synchronous frame-allocation below.
		//
		// OBSERVE MODE (default): the Decision (if any) is recorded via
		// `dispatchDecision`'s own trace/transparency-panel wiring; nothing
		// below changes — the human-ask flow always runs.
		// ENFORCE MODE (`BOBBIT_CLF_TOOL_APPROVE=enforce`): only the safe
		// direction ever short-circuits — a `select` with `choice: "deny"`
		// resolves this call immediately, BEFORE the frame-allocation /
		// broadcast below, so no `tool_permission_needed` ever reaches the UI
		// and no pending-grant timer is started (design doc §6.4: deny is the
		// only always-safe tool verdict). A `select` with `choice: "allow"` is
		// deliberately NOT auto-applied this wave — it needs the CQ-03
		// operator-confirmation permit for widening, which is out of scope
		// here — so it falls through to the human-ask flow exactly like an
		// abstain. Ships dark today: `server.ts` only allow-lists this
		// (point,kind) pair, it registers no classifier, so this consult
		// always abstains in production and the enforce branch is provably
		// unreachable regardless of the flag — see
		// tests/session-manager-tool-approve.test.ts for the exercised
		// mechanics via a directly-registered test classifier.
		const toolApproveDecision = this.lifecycleHub ? await this.consultToolApproveHub(session, toolName, toolGroup) : undefined;
		if (isToolApproveEnforceMode() && isAutoDenyDecision(toolApproveDecision)) {
			this.appendToolPermissionAudit(session, { toolName, toolGroup, toolApproveDecision }, "denied", "auto");
			return { granted: false, reason: toolApproveDecision.rationale ?? "Auto-denied by the tool-approve decision seam (CLF-W2, enforce mode)" };
		}

		// Stamp seq+ts so client reducer can order this frame relative to live
		// `event` frames. See docs/design/unified-message-ordering-reducer.md §3.1.
		// IMPORTANT: this is the ONLY frame-allocation callsite in src/server/.
		// Late-joiners that attach while this perm is pending must REPLAY the
		// same seq/ts (via getPendingToolPermission) — never allocate a fresh
		// seq — or already-attached clients will gap-buffer the next live
		// event. Pinned by tests/perm-frame-late-joiner-seq-gap.test.ts.
		const { seq, ts } = session.eventBuffer.pushFrame();

		// Create promise that will be resolved by grantToolPermission
		const promise = new Promise<ToolGrantResolution>((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = session.pendingGrantRequest;
				session.pendingGrantRequest = undefined;
				resolve({ granted: false });
				if (pending) this.appendToolPermissionAudit(session, pending, "denied", "timeout");
			}, 5 * 60 * 1000); // 5 minute timeout

			session.pendingGrantRequest = { resolve, reject, toolName, toolGroup, toolApproveDecision, timer, seq, ts };
		});

		// Broadcast to UI clients
		const roleName = session.role || "general";
		const role = this.roleManager?.getRole(roleName);
		broadcast(session.clients, {
			type: "tool_permission_needed",
			toolName,
			group: toolGroup,
			roleName: role?.name ?? roleName,
			roleLabel: role?.label ?? roleName,
			lastPromptText: session.lastPromptText,
			seq,
			ts,
		});

		return promise;
	}

	/**
	 * Called when the user clicks "Deny" in the UI grant dialog.
	 * Resolves the pending grant request with `{ granted: false }` so the
	 * guard extension's long-poll returns immediately instead of waiting 5 min.
	 */
	denyToolPermission(sessionId: string, _toolName: string): void {
		const session = this.sessions.get(sessionId);
		if (!session?.pendingGrantRequest) return;
		clearTimeout(session.pendingGrantRequest.timer);
		const pending = session.pendingGrantRequest;
		session.pendingGrantRequest = undefined;
		pending.resolve({ granted: false });
		this.appendToolPermissionAudit(session, pending, "denied", "user");
	}

	private recomputeAllowedToolsForRestart(session: SessionInfo, ps: PersistedSession): string[] | undefined {
		// Preserve a persisted EXPLICIT empty allowlist (`[]` = NO tools) as distinct
		// from absent (`undefined` = fall back to role/cascade). Only a missing /
		// non-array value falls back; an emptied allowlist (recursion-stripped
		// delegate, bobbit.disabledTools) must NOT silently re-acquire role defaults
		// on respawn/restart.
		const persistedAllowedTools = Array.isArray(ps.allowedTools) ? ps.allowedTools : undefined;
		const sessionGrants = this.mergeToolNames(session.sessionOnlyGrantedTools, session.oneTimeGrantedTools);

		// Persisted allow-lists are true session-scoped constraints (delegate/read-only
		// children, explicit createSession overrides, incl. an explicit empty `[]`).
		// Preserve them exactly, with any live grants layered on top.
		if (persistedAllowedTools) {
			return this.mergeToolNames(persistedAllowedTools, sessionGrants);
		}

		// Normal sessions derive their tool surface from the current role/group/MCP
		// policy cascade. Only one-time/session-only grants are carried across the
		// respawn; the old live session.allowedTools is just a stale cache.
		if (!sessionGrants) return undefined;
		const restoredRole = this.resolveSessionRole(ps.role, ps.assistantType, ps.projectId);
		const recomputedAllowed = this.resolveEffectiveAllowedTools(restoredRole).map(t => t.name);
		return this.mergeToolNames(recomputedAllowed, sessionGrants);
	}

	/** Delegates to SessionRevive (cohort 4 revive/respawn extraction). */
	private async _restartSessionWithUpdatedRole(...args: Parameters<SessionRevive["restartSessionWithUpdatedRole"]>): ReturnType<SessionRevive["restartSessionWithUpdatedRole"]> {
		return this.sessionRevive.restartSessionWithUpdatedRole(...args);
	}

	/** Delegates to SessionRevive (cohort 4 revive/respawn extraction). */
	_snapshotStreamingFrameOfReference(...args: Parameters<SessionRevive["snapshotStreamingFrameOfReference"]>): ReturnType<SessionRevive["snapshotStreamingFrameOfReference"]> {
		return this.sessionRevive.snapshotStreamingFrameOfReference(...args);
	}

	/** Delegates to SessionRevive (cohort 4 revive/respawn extraction). */
	private async _respawnAgentInPlace(...args: Parameters<SessionRevive["respawnAgentInPlace"]>): ReturnType<SessionRevive["respawnAgentInPlace"]> {
		return this.sessionRevive.respawnAgentInPlace(...args);
	}

	/**
	 * Restart the agent process for a session whose process has died.
	 * Stops any remnant process, then restores from persisted state.
	 * Re-attaches existing WS clients so the user can keep working.
	 */
	async restartAgent(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		const ps = this.resolveStoreForSession(session.id).get(session.id);
		if (!ps) throw new Error("No persisted session data");

		// Zombie-archive guard: a record with neither an agent session file nor a role
		// can't be bootstrapped by `_respawnAgentInPlace`. Archive it surface-side
		// instead of throwing opaquely on every Restart click.
		if (!ps.agentSessionFile && !ps.role && !canResumeClaudeCodeSession(ps)) {
			console.warn(
				`[session-manager] Session ${sessionId} is an unrecoverable zombie ` +
				`(no agentSessionFile, no role) — archiving instead of restarting.`,
			);
			try {
				this.resolveStoreForSession(sessionId).update(sessionId, { archived: true, archivedAt: Date.now() });
			} catch (err) {
				console.error(`[session-manager] Failed to archive zombie session ${sessionId}:`, err);
			}
			const zombieErr: Error & { code?: string } = new Error(
				`Session ${sessionId} could not be restarted — neither an agent session file nor ` +
				`a role was persisted. The session has been archived; create a fresh session to continue.`,
			);
			zombieErr.code = "SESSION_UNRECOVERABLE_ARCHIVED";
			throw zombieErr;
		}

		const savedSessionOnlyGrantedTools = session.sessionOnlyGrantedTools ? [...session.sessionOnlyGrantedTools] : undefined;
		const savedOneTimeGrantedTools = session.oneTimeGrantedTools ? [...session.oneTimeGrantedTools] : undefined;
		const overrideAllowedTools = this.recomputeAllowedToolsForRestart(session, ps);
		// One-time grants authorize only the currently blocked invocation; do not
		// pre-populate the guard's process-local cache across respawn/refresh.
		const overrideGrantedTools = savedSessionOnlyGrantedTools;

		const restored = await this._respawnAgentInPlace(session, ps, {
			mutatePs: p => {
				if (overrideAllowedTools) (p as any)._overrideAllowedTools = overrideAllowedTools;
				if (overrideGrantedTools) (p as any)._overrideGrantedTools = overrideGrantedTools;
			},
		});

		if (restored) {
			if (savedSessionOnlyGrantedTools) restored.sessionOnlyGrantedTools = savedSessionOnlyGrantedTools;
			if (savedOneTimeGrantedTools) restored.oneTimeGrantedTools = savedOneTimeGrantedTools;
		} else {
			throw new Error("Failed to restore session after restart");
		}
	}

	/**
	 * Check an event for usage data and record it via the cost tracker.
	 * Broadcasts a cost_update to connected clients if cost data is found.
	 */
	private trackCostFromEvent(session: SessionInfo, event: any): void {
		return this.sessionCostPlumbing.trackCostFromEvent(session, event);
	}

	private costTriggerFromEvent(session: SessionInfo, event: any): string | undefined {
		return this.sessionCostPlumbing.costTriggerFromEvent(session, event);
	}

	/**
	 * Restore sessions from disk on startup.
	 * Re-spawns agent processes and uses switch_session to resume each one.
	 */
	async restoreSessions(): Promise<void> {
		return this.sessionBoot.restoreSessions();
	}

	// NOTE: cleanupOrphanedNonInteractiveSessions() was removed — replaced by
	// listOrphanedNonInteractiveSessions() + terminateOrphanedSessions() which
	// are called via the /api/maintenance/* REST endpoints.

	private async restoreOneSession(ps: PersistedSession): Promise<void> {
		return this.sessionBoot.restoreOneSession(ps);
	}

	private addDormantSession(ps: PersistedSession, restoreError?: string): void {
		return this.sessionBoot.addDormantSession(ps, restoreError);
	}

	/** Delegates to SessionRevive (cohort 4 revive/respawn extraction). */
	private async restoreSession(...args: Parameters<SessionRevive["restoreSession"]>): ReturnType<SessionRevive["restoreSession"]> {
		return this.sessionRevive.restoreSession(...args);
	}

	async createSession(cwd: string, agentArgs?: string[], goalId?: string, assistantType?: string, opts?: { rolePrompt?: string; roleName?: string; role?: string; teamGoalId?: string; teamLeadSessionId?: string; accessory?: string; nonInteractive?: boolean; promptProfile?: PromptProfile; env?: Record<string, string>; taskId?: string; staffId?: string; allowedTools?: string[]; workflowContext?: string; worktreeOpts?: { repoPath: string }; worktreePushPolicy?: WorktreePushPolicy; reattemptGoalId?: string; sandboxed?: boolean; projectId?: string; sessionId?: string; sandboxBranch?: string; sandboxBaseBranch?: string; sandboxCwdOffset?: string; skipAutoModel?: boolean; skipAutoThinking?: boolean; initialModel?: string; runtime?: SessionRuntime; initialThinkingLevel?: string; preExistingAgentSessionFile?: string; preExistingAgentSessionOldCwds?: string[]; parentSessionId?: string; childKind?: string; readOnly?: boolean; title?: string; awaitWorktreeSetup?: boolean; bypassWorktreePool?: boolean }): Promise<SessionInfo> {
		return this.sessionSpawn.createSession.call(this, cwd, agentArgs, goalId, assistantType, opts);
	}

	async createDelegateSession(parentSessionId: string, opts: {
		instructions: string;
		cwd: string;
		title?: string;
		context?: Record<string, string>;
		allowedTools?: string[];
		initialModel?: string;
		initialThinkingLevel?: string;
		childKind?: string;
		readOnly?: boolean;
		env?: Record<string, string>;
	}): Promise<SessionInfo> {
		return this.sessionSpawn.createDelegateSession.call(this, parentSessionId, opts);
	}

	private resolveIdleWaiters(sessionId: string): void {
		const waiters = this._idleWaiters.get(sessionId);
		if (!waiters) return;
		for (const waiter of [...waiters]) {
			waiter.cleanup();
			waiter.resolve();
		}
	}

	private rejectIdleWaiters(sessionId: string, error: Error): void {
		const waiters = this._idleWaiters.get(sessionId);
		if (!waiters) return;
		for (const waiter of [...waiters]) {
			waiter.cleanup();
			waiter.reject(error);
		}
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
			let timer: ReturnType<typeof setTimeout>;
			let unsub = () => {};
			const waiters = this._idleWaiters.get(sessionId) ?? new Set<IdleWaiter>();
			this._idleWaiters.set(sessionId, waiters);
			const waiter: IdleWaiter = {
				resolve,
				reject,
				cleanup: () => {
					clearTimeout(timer);
					unsub();
					waiters.delete(waiter);
					if (waiters.size === 0) this._idleWaiters.delete(sessionId);
				},
			};
			timer = setTimeout(() => {
				waiter.cleanup();
				reject(new Error(`Timeout waiting for session ${sessionId} to become idle`));
			}, timeoutMs);

			unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end") {
					waiter.cleanup();
					resolve();
				}
				if (event.type === "process_exit") {
					const reason = event.signal ? `signal ${event.signal}` : `code ${event.code}`;
					const error = new Error(`Agent process exited unexpectedly (${reason}) for session ${sessionId}`);
					waiter.cleanup();
					reject(error);
				}
			});
			waiters.add(waiter);
			if (session.status === "idle") {
				waiter.cleanup();
				resolve();
			}
		});
	}

	/**
	 * Wait for a session to enter the streaming state.
	 * Returns immediately if already streaming.
	 * Rejects on timeout (callers typically `.catch(() => {})` to fall through).
	 *
	 * Symmetric to `waitForIdle` — used after dispatching a prompt to a resumed
	 * session that is currently idle, so the caller can confirm the new turn
	 * has actually started before racing against `waitForIdle` again.
	 */
	waitForStreaming(sessionId: string, timeoutMs = 10_000): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.reject(new Error("Session not found"));
		if (session.status === "streaming") return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsub();
				reject(new Error(`Timeout waiting for session ${sessionId} to start streaming`));
			}, timeoutMs);

			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_start") {
					clearTimeout(timer);
					unsub();
					resolve();
				}
				if (event.type === "process_exit") {
					clearTimeout(timer);
					unsub();
					const reason = event.signal ? `signal ${event.signal}` : `code ${event.code}`;
					reject(new Error(`Agent process exited unexpectedly (${reason}) for session ${sessionId}`));
				}
			});
		});
	}

	/**
	 * Whether the session has a LIVE (running) agent process. False for a dormant
	 * restored child (placeholder RpcBridge) or a session no longer tracked. Used
	 * by OrchestrationCore.wait (H1) to avoid blocking `waitForIdle` on a dead
	 * client and instead resolve from persisted output.
	 */
	isSessionLive(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		return !!session && session.dormant !== true;
	}

	/** Pending prompt-queue length — drives OrchestrationCore's `queued` mapping (M3). */
	getQueuedPromptCount(sessionId: string): number {
		return this.sessions.get(sessionId)?.promptQueue.length ?? 0;
	}

	/** Delegates to SessionTranscripts (SessionManager decomposition cohort 10). */
	async hydrateClaudeCodeSnapshotMessages(sessionId: string, liveData: unknown): Promise<unknown> {
		return this.sessionTranscripts.hydrateClaudeCodeSnapshotMessages(sessionId, liveData);
	}

	/** Delegates to SessionTranscripts (SessionManager decomposition cohort 10). */
	async getMessagesSnapshotBase(session: SessionInfo): Promise<{ success: boolean; data?: unknown; error?: string }> {
		return this.sessionTranscripts.getMessagesSnapshotBase(session);
	}

	/** Delegates to SessionTranscripts (SessionManager decomposition cohort 10). */
	async getSessionOutput(sessionId: string): Promise<string> {
		return this.sessionTranscripts.getSessionOutput(sessionId);
	}

	/** Delegates to SessionTranscripts (SessionManager decomposition cohort 10). */
	async refreshAfterCompaction(session: SessionInfo): Promise<void> {
		return this.sessionTranscripts.refreshAfterCompaction(session);
	}

	/**
	 * Runs metadata persistence (and retries model/thinking if early setup missed).
	 * Called after the first agent turn completes.
	 */
	private async _finishSessionSetup(session: SessionInfo): Promise<void> {
		try {
			await this.persistSessionMetadata(session);
		} catch (err) {
			console.error(`[session-manager] Setup error for session ${session.id}:`, err);
		}

		// Broadcast the agent's current state (model + thinking level) to
		// connected clients. The initial WS connect path skips getState for
		// fresh sessions (eventBuffer empty), so this is the first chance
		// clients get to learn the real model — especially important when
		// no explicit default.sessionModel or aigw auto-selection ran.
		try {
			const st = await session.rpcClient.getState();
			if (st.success) {
				broadcast(session.clients, { type: "state", data: st.data });
			}
		} catch (err) {
			console.warn(`[session-manager] Post-setup state broadcast failed for ${session.id}:`, err);
		}
	}

	/** Model/thinking resolution delegates to SessionModels (cohort 9). */
	private resolveRoleModelValue(roleName: string | undefined, projectId: string | undefined): string | undefined {
		return this.sessionModels.resolveRoleModelValue(roleName, projectId);
	}

	private resolveRoleThinkingLevelValue(roleName: string | undefined, projectId: string | undefined): string | undefined {
		return this.sessionModels.resolveRoleThinkingLevelValue(roleName, projectId);
	}

	/** Resolve a role-level model override for the session, if any. */
	private resolveRoleModel(session: SessionInfo): string | undefined {
		return this.sessionModels.resolveRoleModel(session);
	}

	/** Delegates to SessionModels (SessionManager decomposition cohort 9, docs/design/session-manager-decomposition.md). */
	private resolveRolePromptTemplate(roleName: string, projectId: string | undefined): string | undefined {
		return this.sessionModels.resolveRolePromptTemplate(roleName, projectId);
	}

	/** Resolve a role-level thinkingLevel override for the session, if any. */
	private resolveRoleThinkingLevel(session: SessionInfo): string | undefined {
		return this.sessionModels.resolveRoleThinkingLevel(session);
	}

	/** Delegates to SessionModels (SessionManager decomposition cohort 9, docs/design/session-manager-decomposition.md). */
	resolveInitialModel(role: string | undefined, projectId: string | undefined): string | undefined {
		return this.sessionModels.resolveInitialModel(role, projectId);
	}

	/** Delegates to SessionModels (SessionManager decomposition cohort 9, docs/design/session-manager-decomposition.md). */
	resolveInitialThinkingLevel(role: string | undefined, projectId: string | undefined): string | undefined {
		return this.sessionModels.resolveInitialThinkingLevel(role, projectId);
	}

	/** Delegates to SessionModels (SessionManager decomposition cohort 9, docs/design/session-manager-decomposition.md). */
	resolveInitialReviewModel(role: string | undefined, projectId: string | undefined): string | undefined {
		return this.sessionModels.resolveInitialReviewModel(role, projectId);
	}

	private async tryAutoSelectModel(session: SessionInfo): Promise<void> {
		return this.sessionModels.tryAutoSelectModel(session);
	}

	private async tryApplyDefaultThinkingLevel(session: SessionInfo): Promise<void> {
		return this.sessionModels.tryApplyDefaultThinkingLevel(session);
	}

	async persistSessionMetadata(session: SessionInfo): Promise<void> {
		return this.sessionTranscripts.persistSessionMetadata(session);
	}

	getSession(id: string): SessionInfo | undefined {
		const direct = this.sessions.get(id);
		if (direct) return direct;
		// Warm-pool alias fallback — see `piPoolIdentityAliases` field doc comment.
		const realId = this.piPoolIdentityAliases.get(id);
		return realId ? this.sessions.get(realId) : undefined;
	}

	/** Record that `poolOwnedId` (a claimed warm-pool entry's baked env identity)
	 *  should resolve to the live session `realSessionId` for `getSession()`
	 *  callers. See the `piPoolIdentityAliases` field doc comment. */
	registerWarmPoolIdentityAlias(poolOwnedId: string, realSessionId: string): void {
		this.piPoolIdentityAliases.set(poolOwnedId, realSessionId);
	}

	/**
	 * Get the pending tool permission request for a session, if any.
	 * Used to send the permission card to newly connecting clients.
	 */
	getPendingToolPermission(id: string): /* includes replayed seq: number; ts: number */ PendingToolPermissionSnapshot | undefined {
		const session = this.sessions.get(id);
		if (!session?.pendingGrantRequest) return undefined;
		const roleName = session.role || "general";
		const role = this.roleManager?.getRole(roleName);
		return {
			toolName: session.pendingGrantRequest.toolName,
			group: session.pendingGrantRequest.toolGroup,
			roleName: role?.name ?? roleName,
			roleLabel: role?.label ?? roleName,
			lastPromptText: session.lastPromptText,
			seq: session.pendingGrantRequest.seq,
			ts: session.pendingGrantRequest.ts,
		};
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
		projectId?: string;
		/** Eligibility-signal census (in-process-bridge-eligibility.ts step 2):
		 *  the derived read-only-ness of the RPC bridge already constructed by
		 *  the caller (`isReadOnlyToolPolicy` over `allowedTools`, computed
		 *  before this bridge existed — see verification-harness.ts's legacy
		 *  `runLlmReviewDirect`). Recorded as session metadata for display/
		 *  persistence parity with SessionManager-spawned reviewer sessions;
		 *  this bridge was already constructed by the caller, so it cannot
		 *  retroactively change which bridge class backs it. */
		readOnly?: boolean;
		/** The resolved tool allowlist behind `readOnly` above, for the same
		 *  metadata-parity reason. */
		allowedTools?: string[];
	}): () => void {
		const eventBuffer = new EventBuffer();
		const now = Date.now();

		const session: SessionInfo = {
			id,
			title: opts.title,
			cwd: opts.cwd,
			status: "idle",
			statusVersion: 0,
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
			readOnly: opts.readOnly,
			allowedTools: opts.allowedTools,
			promptQueue: new PromptQueue(),
		};

		const unsub = rpcClient.onEvent((event: any) => {
			session.lastActivity = Date.now();
			this.handleAgentLifecycle(session, event);
			const truncated = truncateLargeToolContent(event);
			emitSessionEvent(session, truncated);
			this.trackCostFromEvent(session, event);
		});
		session.unsubscribe = unsub;

		this.sessions.set(id, session);

		// Resolve project from goal (if provided) or from opts.projectId — which the
		// REST handler must have resolved via resolveProjectForRequest. No fallback.
		let extProjectId = opts.goalId
			? this.projectContextManager?.getContextForGoal(opts.goalId)?.project.id
			: undefined;
		if (!extProjectId) extProjectId = opts.projectId;
		if (!extProjectId) {
			throw new Error("createSession requires projectId or a goalId that resolves to a project");
		}
		session.projectId = extProjectId;
		const extStore = this.resolveStoreForSession(session.id);

		// Initial persist — structural fields (store.put must precede persistSessionMetadata
		// since persistSessionMetadata now only does store.update)
		extStore.put({
			id,
			title: opts.title,
			cwd: opts.cwd,
			agentSessionFile: "",
			createdAt: now,
			lastActivity: now,
			goalId: opts.goalId,
			role: opts.role,
			teamGoalId: opts.teamGoalId,
			nonInteractive: true,
			readOnly: opts.readOnly,
			allowedTools: opts.allowedTools,
			projectId: extProjectId,
		});

		// Then update with agentSessionFile (tracked for terminate)
		session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err) => {
			console.error(`[session-manager] Failed to persist external session ${id}:`, err);
		}).finally(() => { session.pendingMetadataPersist = undefined; });

		console.log(`[session-manager] Registered external session ${id}: ${opts.title}`);

		return () => {
			unsub();
			broadcastStatus(session, "terminated");
			for (const client of session.clients) {
				client.close(1000, "Session terminated");
			}
			session.clients.clear();
			this._untrackConnectedSession(session);
			this.sessions.delete(id);
			this.taskIdCache.delete(id); // PERF-05: prune with the session, not indefinitely
			extStore.remove(id);
			cleanupSessionPrompt(id);
			console.log(`[session-manager] Unregistered external session ${id}`);
		};
	}

	/**
	 * @internal — full in-memory `SessionInfo[]` for callers inside
	 * `src/server/agent/` that need to drive `forceAbort`/lifecycle ops
	 * over every session (e.g. the pause-cascade sweep in
	 * `nested-goal-routes.ts`). Do NOT expose over REST or WS — leaks
	 * `rpcClient`, `eventBuffer`, etc.
	 */
	getAllSessionsRaw(): SessionInfo[] {
		return Array.from(this.sessions.values());
	}

	listSessions(): Array<{
		id: string;
		title: string;
		cwd: string;
		status: string;
		createdAt: number;
		lastActivity: number;
		lastReadAt?: number;
		clientCount: number;
		isCompacting: boolean;
		goalId?: string;
		assistantType?: string;
		goalAssistant?: boolean;
		roleAssistant?: boolean;
		toolAssistant?: boolean;
		delegateOf?: string;
		parentSessionId?: string;
		childKind?: string;
		readOnly?: boolean;
		role?: string;
		teamGoalId?: string;
		teamLeadSessionId?: string;
		worktreePath?: string;
		taskId?: string;
		staffId?: string;
		accessory?: string;
		nonInteractive?: boolean;
		preview?: boolean;
		reattemptGoalId?: string;
		sandboxed?: boolean;
		projectId?: string;
		spawnPinnedModel?: string;
		spawnPinnedThinkingLevel?: string;
		repoPath?: string;
		branch?: string;
		repoWorktrees?: Record<string, string>;
		runtime?: SessionRuntime;
		claudeCodeSessionId?: string;
		claudeCodeExecutable?: string;
		claudeCodePermissionMode?: string;
		claudeCodeModelAlias?: string;
		modelProvider?: string;
		modelId?: string;
		thinkingLevelUserPinned?: boolean;
	}> {
		return Array.from(this.sessions.values()).map((s) => {
			let ps: PersistedSession | undefined;
			try {
				ps = this.resolveStoreForSession(s.id).get(s.id);
			} catch {
				// Session can't be resolved (no projectId, not in any store) — use in-memory data only
			}
			return {
				id: s.id,
				title: s.title,
				cwd: s.cwd,
				status: s.status,
				createdAt: s.createdAt,
				lastActivity: s.lastActivity,
				lastReadAt: ps?.lastReadAt,
				clientCount: s.clients.size,
				isCompacting: s.isCompacting,
				goalId: s.goalId,
				assistantType: s.assistantType,
				// Legacy boolean fields for backward compat
				goalAssistant: s.assistantType === "goal",
				roleAssistant: s.assistantType === "role",
				toolAssistant: s.assistantType === "tool",
				delegateOf: s.delegateOf,
				parentSessionId: ps?.parentSessionId ?? s.parentSessionId,
				childKind: ps?.childKind ?? s.childKind,
				readOnly: ps?.readOnly ?? s.readOnly,
				role: s.role,
				teamGoalId: s.teamGoalId,
				teamLeadSessionId: s.teamLeadSessionId,
				worktreePath: s.worktreePath,
				taskId: s.taskId,
				staffId: s.staffId,
				accessory: s.accessory,
				nonInteractive: s.nonInteractive,
				preview: s.preview,
				reattemptGoalId: ps?.reattemptGoalId,
				sandboxed: ps?.sandboxed || s.sandboxed,
				projectId: ps?.projectId || s.projectId,
				runtime: ps?.runtime ?? "pi",
				claudeCodeSessionId: ps?.claudeCodeSessionId,
				claudeCodeExecutable: ps?.claudeCodeExecutable,
				claudeCodePermissionMode: ps?.claudeCodePermissionMode,
				claudeCodeModelAlias: ps?.claudeCodeModelAlias,
				modelProvider: ps?.modelProvider,
				modelId: ps?.modelId,
				thinkingLevelUserPinned: s.thinkingLevelUserPinned,
				spawnPinnedModel: s.spawnPinnedModel,
				spawnPinnedThinkingLevel: s.spawnPinnedThinkingLevel,
				repoPath: ps?.repoPath || s.repoPath,
				branch: ps?.branch || s.branch,
				repoWorktrees: ps?.repoWorktrees || (s.repoWorktrees ? Object.fromEntries(s.repoWorktrees.map(w => [w.repo, w.worktreePath])) : undefined),
			};
		});
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
		const allPersisted = this.projectContextManager
			? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getAll())
			: (this._testStore?.getAll() ?? []);
		for (const ps of allPersisted) {
			if (ps.goalId === goalId) ids.add(ps.id);
		}
		return [...ids];
	}

	/** Record that the user viewed this session. Updates lastReadAt only — never lastActivity. */
	markSessionRead(id: string): boolean {
		const store = this.resolveStoreForId(id);
		if (!store?.get(id)) return false;
		store.update(id, { lastReadAt: Date.now() });
		return true;
	}

	setTitle(id: string, title: string, opts?: { markGenerated?: boolean }): boolean {
		const session = this.sessions.get(id);
		if (!session) return false;
		session.title = title;
		if (opts?.markGenerated) session.titleGenerated = true;
		this.resolveStoreForSession(id).update(id, { title });
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
			this.resolveStoreForSession(session.id).update(session.id, { title: finalTitle });
			broadcast(session.clients, { type: "session_title", sessionId: session.id, title: finalTitle });
		}
	}

	/** Update session metadata fields and persist. */
	updateSessionMeta(id: string, updates: { role?: string; teamGoalId?: string; worktreePath?: string; repoPath?: string; branch?: string; repoWorktrees?: Record<string, string>; accessory?: string; nonInteractive?: boolean; teamLeadSessionId?: string; delegateOf?: string; parentSessionId?: string; childKind?: string; readOnly?: boolean; childTerminal?: boolean; terminalAt?: number }): boolean {
		const session = this.sessions.get(id);
		if (!session) {
			// Store-only session (dormant/delegate) — update store directly
			const store = this.resolveStoreForId(id);
			if (store) store.update(id, updates);
			return !!store;
		}
		if (updates.role !== undefined) session.role = updates.role;
		if (updates.teamGoalId !== undefined) session.teamGoalId = updates.teamGoalId;
		if (updates.worktreePath !== undefined) session.worktreePath = updates.worktreePath;
		if (updates.repoPath !== undefined) session.repoPath = updates.repoPath;
		if (updates.branch !== undefined) session.branch = updates.branch;
		if (updates.repoWorktrees !== undefined) {
			const repoPath = updates.repoPath ?? session.repoPath;
			session.repoWorktrees = repoPath
				? Object.entries(updates.repoWorktrees).map(([repo, worktreePath]) => ({
					repo,
					repoPath: repo === "." ? repoPath : path.join(repoPath, repo),
					worktreePath,
				}))
				: undefined;
		}
		if (updates.accessory !== undefined) session.accessory = updates.accessory;
		if (updates.nonInteractive !== undefined) session.nonInteractive = updates.nonInteractive;
		if (updates.teamLeadSessionId !== undefined) session.teamLeadSessionId = updates.teamLeadSessionId;
		if (updates.delegateOf !== undefined) session.delegateOf = updates.delegateOf;
		if (updates.parentSessionId !== undefined) session.parentSessionId = updates.parentSessionId;
		if (updates.childKind !== undefined) session.childKind = updates.childKind;
		if (updates.readOnly !== undefined) session.readOnly = updates.readOnly;
		if (updates.childTerminal !== undefined) session.childTerminal = updates.childTerminal;
		if (updates.terminalAt !== undefined) session.terminalAt = updates.terminalAt;
		this.resolveStoreForSession(id).update(id, updates);
		return true;
	}

	/**
	 * Stamp the GENERIC persisted terminal marker on a child session
	 * (`childTerminal:true` + `terminalAt`), so the generic boot-reap
	 * (`shouldReapChildOnBoot` reading `PersistedSessionLike.childTerminal`)
	 * removes it after a restart even if a dismiss never ran (orchestration-core
	 * Decision E / Findings 3–4). Idempotent; carries NO pack/kind knowledge.
	 * Implements `OrchestrationSessionView.markChildTerminal` and is also called
	 * by the pr-walkthrough submit-yaml route before its terminal-synchronous
	 * dismiss. Routes through `updateSessionMeta` for a live/dormant session and
	 * `updateArchivedMeta` for an archived one.
	 */
	markChildTerminal(childSessionId: string): void {
		const updates = { childTerminal: true, terminalAt: Date.now() };
		if (this.sessions.has(childSessionId)) {
			this.updateSessionMeta(childSessionId, updates);
			return;
		}
		// Not live: try the archived path; if it is not archived (dormant store-only),
		// fall back to updateSessionMeta's store-only branch.
		if (!this.archivedWorktrees.updateArchivedMeta(childSessionId, updates)) {
			this.updateSessionMeta(childSessionId, updates);
		}
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
		const store = this.resolveStoreForSession(id);
		if (!store.get(id)) {
			store.put({
				id: session.id,
				title: session.title,
				cwd: session.cwd,
				agentSessionFile: "",
				createdAt: session.createdAt,
				lastActivity: session.lastActivity,
				goalId: session.goalId,
				delegateOf: session.delegateOf,
				parentSessionId: session.parentSessionId,
				childKind: session.childKind,
				readOnly: session.readOnly,
				sandboxed: session.sandboxed,
				projectId: session.projectId,
			});
		}
		return true;
	}

	/** Get a draft for a session by type. */
	getDraft(id: string, type: string): unknown | undefined {
		if (!this.ensureStoreEntry(id)) return undefined;
		return this.resolveStoreForSession(id).getDraft(id, type);
	}

	/** Set a draft for a session by type. Returns false if session not found. */
	setDraft(id: string, type: string, data: unknown): boolean {
		if (!this.ensureStoreEntry(id)) return false;
		return this.resolveStoreForSession(id).setDraft(id, type, data);
	}

	/** Delete a draft for a session by type. */
	deleteDraft(id: string, type: string): boolean {
		if (!this.ensureStoreEntry(id)) return false;
		return this.resolveStoreForSession(id).deleteDraft(id, type);
	}

	/**
	 * Assign a role to an existing session by killing the agent, reassembling
	 * the system prompt with the role instructions, and respawning with
	 * `switch_session` to preserve conversation history.
	 */
	async assignRole(id: string, role: { name: string; promptTemplate: string; accessory: string }): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (session.status === "streaming") throw new Error("Cannot assign role while agent is streaming");

		// Get the agent session file so we can restore conversation
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) agentSessionFile = stateResp.data?.sessionFile;
		} catch {
			const persisted = this.resolveStoreForSession(id).get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the current process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Reassemble system prompt with role instructions as separate fields
		const goal = session.goalId ? this.resolveGoal(session.goalId) : undefined;
		const goalSpec = goal?.spec;
		// Look up the full role (with toolPolicies) cascade-first so pack-contributed
		// roles keep their policies during role reassignment.
		const fullRole = this.resolveSessionRole(role.name, undefined, session.projectId) ?? (role as Role);
		// Filter goal-metadata disabled tools (bobbit.disabledTools) for the
		// session's effective goal so the reassembled prompt, the activation args,
		// and the persisted allowedTools all agree after a role reassignment.
		const respawnEffectiveGoalId = session.goalId ?? session.teamGoalId;
		const respawnDisabled = this.disabledToolsForGoal(respawnEffectiveGoalId, session.projectId);
		const effectiveAllowedRaw = this.resolveEffectiveAllowedTools(fullRole);
		const effectiveAllowed = respawnDisabled
			? effectiveAllowedRaw.filter(e => !respawnDisabled.has(e.name.toLowerCase()))
			: effectiveAllowedRaw;
		// Preserve the unrestricted (`undefined`) vs explicit-empty (`[]`)
		// distinction. `effectiveAllowedRaw` is `[]` ONLY for a role-less /
		// no-toolManager session (genuinely unrestricted ⇒ `undefined`). When a
		// role HAD an allowlist that `bobbit.disabledTools` removed entirely,
		// `effectiveAllowed` is `[]` and must stay `[]` (NO tools) — never
		// collapse it to `undefined`, which would re-grant every tool on respawn.
		const respawnAllowed: EffectiveTool[] | undefined =
			effectiveAllowedRaw.length > 0 ? effectiveAllowed : undefined;
		const effectiveAllowedNames = effectiveAllowed.map(e => e.name);

		// Resolve the role prompt through the shared helper so placeholder
		// substitution ({{GOAL_BRANCH}}/{{AGENT_ID}}/{{AVAILABLE_ROLES}}) matches
		// the other regular-session sites (previously passed raw — latent bug).
		const rolePrompt = resolveRolePrompt(fullRole ?? role, {
			branch: goal?.branch,
			agentId: `${role.name}-${(session.goalId || session.id).slice(0, 8)}`,
			roleManager: this.roleManager,
		});

		const promptPath = this.assemblePrompt(id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: session.cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec,
			rolePrompt,
			roleName: role.name,
			allowedTools: effectiveAllowedNames.length > 0 ? effectiveAllowedNames : undefined,
			projectConfigStore: this.projectConfigStoreForPrompt(session.projectId),
			serverConfigStore: this.projectConfigStore,
		});

		// Respawn with new system prompt
		const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		if (this.toolManager) bridgeOptions.toolManager = this.toolManager;
		bridgeOptions.env = {
			BOBBIT_SESSION_ID: id,
			BOBBIT_SESSION_SECRET: this.sessionSecretStore.getOrCreateSecret(id),
		};
		if (session.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
			// Re-attach extensions: team leads need both team + goal tools, others just goal tools
			const isTeamLead = session.role === "team-lead";
			if (isTeamLead) {
				bridgeOptions.args = ["--extension", this.getTeamLeadExtensionPath(), "--extension", this.getGoalToolsExtensionPath()];
			} else if (!bridgeOptions.args?.includes("--extension")) {
				bridgeOptions.args = ["--extension", this.getGoalToolsExtensionPath()];
			}
		}

		// Re-attach proposal tools extension for assistant sessions
		if (session.assistantType) {
			bridgeOptions.args = bridgeOptions.args || [];
			const proposalExtPath = this.getProposalToolsExtensionPath();
			if (!bridgeOptions.args.includes(proposalExtPath)) {
				bridgeOptions.args.push("--extension", proposalExtPath);
			}
		}

		// Apply tool activation args, including Bobbit extension tools and MCP policy filtering.
		// `respawnAllowed` is `[]` (NO tools) when a role allowlist was fully removed by
		// `bobbit.disabledTools`, and `undefined` only for a genuinely unrestricted session.
		await this.ensureMcpManagerForContext(session.projectId, session.cwd);
		const respawnActivation = this.buildToolActivationArgs(id, respawnAllowed, fullRole, session.cwd, session.projectId, respawnEffectiveGoalId, session.sessionOnlyGrantedTools);
		bridgeOptions.args = [...respawnActivation.args, ...(bridgeOptions.args || [])];
		bridgeOptions.piExtensions = [...(bridgeOptions.piExtensions ?? []), ...respawnActivation.runtimeExtensions];
		bridgeOptions.env = { ...(bridgeOptions.env || {}), ...respawnActivation.env };

		// Pin model/thinking-level at spawn for the respawn (after role assignment).
		const respawnPersisted = this.resolveStoreForSession(id).get(id);
		if (respawnPersisted?.modelProvider && respawnPersisted?.modelId) {
			bridgeOptions.initialModel = `${respawnPersisted.modelProvider}/${respawnPersisted.modelId}`;
		} else {
			const initModel = this.resolveInitialModel(role.name, session.projectId);
			if (initModel) bridgeOptions.initialModel = initModel;
		}
		// Always re-resolve fresh against the NEWLY assigned role (mirrors the
		// model resolution above and `_respawnAgentInPlace`'s equivalent step).
		// A stale `session.spawnPinnedThinkingLevel` from BEFORE this role
		// assignment must never short-circuit here — there is no persisted
		// "explicitly pinned" marker for thinking level (unlike modelProvider/
		// modelId above), so falling back to the in-memory value from the
		// session's PRIOR role/spawn would silently skip the clamp this function
		// exists to apply (e.g. a non-reasoning model's role pins "low" but the
		// stale pin from a roleless prior spawn was the unclamped "medium").
		const initThinking = this.resolveInitialThinkingLevel(role.name, session.projectId);
		if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;
		if (!session.sandboxed) this.applyScopedGatewayCredentials(bridgeOptions, id, session.projectId, session.goalId ?? session.teamGoalId);
		this.applyDirectProviderEnv(bridgeOptions, !!session.sandboxed, respawnPersisted?.modelProvider);
		const runtime = resolveSessionRuntime({ runtime: respawnPersisted?.runtime, initialModel: bridgeOptions.initialModel, modelProvider: respawnPersisted?.modelProvider });
		assertRuntimeAllowedForSession(runtime, session.sandboxed);
		Object.assign(bridgeOptions, hydrateRuntimeOptions({
			...bridgeOptions,
			runtime,
			claudeCodeSessionId: respawnPersisted?.claudeCodeSessionId,
			claudeCodeExecutable: respawnPersisted?.claudeCodeExecutable,
			claudeCodePermissionMode: respawnPersisted?.claudeCodePermissionMode,
			claudeCodeModelAlias: respawnPersisted?.claudeCodeModelAlias,
			readOnly: respawnPersisted?.readOnly ?? session.readOnly,
		}, this.readClaudeCodeConfigForProject(session.projectId)));

			const rpcClient = createSessionBridge(bridgeOptions);
			session.spawnPinnedModel = bridgeOptions.initialModel;
			session.spawnPinnedThinkingLevel = bridgeOptions.initialThinkingLevel;
			session.thinkingRouterAppliedBaseline = undefined;
			let switchingSession = true;
		const roleStore = this.resolveStoreForSession(id);
		const unsub = rpcClient.onEvent((event: any) => {
			if (isUserVisibleActivity(event)) {
				session.lastActivity = Date.now();
				roleStore.update(id, { lastActivity: session.lastActivity });
			}
			this.handleAgentLifecycle(session, event);
			const truncated = truncateLargeToolContent(event);
			emitSessionEvent(session, truncated);
			if (!switchingSession) this.trackCostFromEvent(session, event);
		});

		bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension);
		await rpcClient.start();

		// Restore conversation from session file.
		const rolePs = { ...respawnPersisted, ...session, agentSessionFile } as PersistedSession;
		const roleFileCtx = sessionFsContextForAgentFile(rolePs, agentSessionFile);
		if (agentSessionFile) trustPersistedAgentSessionFile(agentSessionFile);
		if (agentSessionFile && await sessionFileExists(roleFileCtx, agentSessionFile, this.sandboxManager)) {
			await sanitizeAgentTranscriptFile(roleFileCtx, agentSessionFile, this.sandboxManager);
			const switchResp = await rpcClient.sendCommand(
				{ type: "switch_session", sessionPath: switchSessionPathForAgent(rolePs) },
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
		session.role = role.name;
		session.accessory = role.accessory;
		session.allowedTools = effectiveAllowedNames;

		roleStore.update(id, { role: role.name, accessory: role.accessory });

		try {
			await this.tryAutoSelectModel(session);
		} catch (err) {
			await rpcClient.stop();
			throw err;
		}

		broadcastStatus(session, "idle");

		// Refresh messages and state for connected clients
		try {
			const msgs = await rpcClient.getMessages();
			if (msgs.success) {
				const raw: any = normalizeToolResultErrorSnapshot(msgs.data);
				let data: any = raw;
				if (Array.isArray(raw)) {
					data = spliceInFlightSteers(
						spliceInFlightMessage(raw, session.latestMessageUpdate),
						session.inFlightSteerTexts,
					);
				} else if (raw && Array.isArray(raw.messages)) {
					const spliced = spliceInFlightSteers(
						spliceInFlightMessage(raw.messages, session.latestMessageUpdate),
						session.inFlightSteerTexts,
					);
					data = spliced === raw.messages ? raw : { ...raw, messages: spliced };
				}
				broadcast(session.clients, { type: "messages", data });
			}
			const st = await rpcClient.getState();
			if (st.success) broadcast(session.clients, { type: "state", data: st.data });
		} catch { /* best-effort */ }

		console.log(`[session-manager] Assigned role "${role.name}" to session ${id}`);
		return true;
	}

	/**
	 * Generate a title for a session on the first user prompt.
	 * Called immediately when the user sends a message, not after the agent replies.
	 */
	tryGenerateTitleFromPrompt(sessionId: string, userText: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.titleGenerated) return;
		if (session.staffId) return; // Staff sessions use the staff name as title
		session.titleGenerated = true;

		// Fire-and-forget
		this.autoGenerateTitleFromText(session, userText).catch((err) => {
			console.error(`[session ${session.id}] Title generation failed:`, err);
		});
	}

	private getTitleGenOptions(): import("./title-generator.js").TitleGenOptions {
		const namingModel = this.preferencesStore?.get("default.namingModel") as string | undefined;
		const sessionModel = this.preferencesStore?.get("default.sessionModel") as string | undefined;
		const aigwUrl = this.preferencesStore ? getAigwUrl(this.preferencesStore) : undefined;
		return { namingModel: namingModel || undefined, fallbackModel: sessionModel || undefined, aigwUrl, thinkingLevel: "off", preferencesStore: this.preferencesStore };
	}

	private async autoGenerateTitleFromText(session: SessionInfo, userText: string): Promise<void> {
		const messages = [{ role: "user", content: userText }];
		const title = await generateSessionTitle(messages, this.getTitleGenOptions());
		if (title) {
			session.title = title;
			this.resolveStoreForSession(session.id).update(session.id, { title });
			broadcast(session.clients, { type: "session_title", sessionId: session.id, title });
		}
	}

	/**
	 * Generate a title for any session by id — live or archived. Returns the
	 * generated title, or null if no messages were available. Persists the
	 * title and broadcasts to any connected clients (live sessions only).
	 * Used by `POST /api/sessions/:id/generate-title` for the rename dialog
	 * when the user is editing a non-focused session.
	 */
	async generateTitleForAnySession(id: string): Promise<string | null> {
		const live = this.sessions.get(id);
		if (live && live.status !== "terminated") {
			const msgsResp = await live.rpcClient.getMessages();
			if (!msgsResp.success) return null;
			const rawMessages = msgsResp.data?.messages || msgsResp.data;
			if (!Array.isArray(rawMessages) || rawMessages.length === 0) return null;
			const messages = spliceInFlightMessage(rawMessages, live.latestMessageUpdate);
			const title = await generateSessionTitle(messages, this.getTitleGenOptions());
			if (!title) return null;
			live.title = title;
			this.resolveStoreForSession(live.id).update(live.id, { title });
			broadcast(live.clients, { type: "session_title", sessionId: live.id, title });
			return title;
		}

		// Archived or dormant — read messages from .jsonl without restoring the agent.
		const store = this.resolveStoreForId(id);
		const ps = store?.get(id);
		if (!ps || !ps.agentSessionFile) return null;
		let messages: unknown[] = [];
		try {
			const safeFile = safePersistedHostAgentSessionFile(ps.agentSessionFile);
			if (!safeFile) return null;
			trustPersistedAgentSessionFile(safeFile);
			const ctx = sessionFsContextForAgentFile(ps, safeFile);
			const content = await sessionFileRead(ctx, safeFile, this.sandboxManager);
			if (content) {
				for (const line of content.trim().split("\n")) {
					if (!line.trim()) continue;
					try {
						const entry = JSON.parse(line);
						if (entry.type === "message" && entry.message) messages.push(entry.message);
					} catch { /* skip malformed */ }
				}
			}
		} catch {
			messages = [];
		}
		if (messages.length === 0) return null;
		const title = await generateSessionTitle(messages as any[], this.getTitleGenOptions());
		if (!title) return null;
		store?.update(id, { title });
		return title;
	}

	async autoGenerateTitle(session: SessionInfo): Promise<void> {
		try {
			const msgsResp = await session.rpcClient.getMessages();
			if (!msgsResp.success) return;

			const rawMessages = msgsResp.data?.messages || msgsResp.data;
			if (!Array.isArray(rawMessages) || rawMessages.length === 0) return;
			const messages = spliceInFlightMessage(rawMessages, session.latestMessageUpdate);

			const title = await generateSessionTitle(messages, this.getTitleGenOptions());
			if (title) {
				session.title = title;
				this.resolveStoreForSession(session.id).update(session.id, { title });
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
		const persisted = this.resolveStoreForId(sessionId)?.get(sessionId);
		if (!persisted) {
			throw new Error(`Cannot restore session ${sessionId}: no persisted data found`);
		}
		if (existing) {
			// In-memory SessionInfo present (terminated, possibly with attached WS
			// clients). Route through the in-place respawn helper so the streaming
			// frame-of-reference carries over and post-restore frames aren't dropped
			// by the client's dedup gates.
			await this._respawnAgentInPlace(existing, persisted);
		} else {
			// Cold restore — no in-memory session, no live clients, fresh
			// `_highestSeq=0` baseline on whoever connects next.
			await this._restoreSessionCoalesced(persisted);
		}
		console.log(`[session-manager] Restored session ${sessionId} via ensureSessionAlive`);
	}

	/** Write the human-readable model name to a file so shell extensions can read it at commit time. */
	private _writeModelNameFile(sessionId: string, modelId: string): void {
		try {
			const filePath = path.join(bobbitStateDir(), "model-name-" + sessionId + ".txt");
			fs.writeFileSync(filePath, deriveName(modelId), "utf-8");
		} catch (err) {
			console.warn(`[session-manager] Failed to write model name file for ${sessionId}:`, err);
		}
	}

	/** Update the model name file for a session (called from WS handler on setModel). */
	updateModelNameFile(sessionId: string, modelId: string): void {
		this._writeModelNameFile(sessionId, modelId);
	}

	/** Persist model provider/id so archived sessions can display model info. */
	persistSessionModel(sessionId: string, provider: string, modelId: string): void {
		this.resolveStoreForSession(sessionId).update(sessionId, {
			modelProvider: provider,
			modelId,
			// Claude Code's "model" IS the CLI alias — keep the persisted alias in
			// lockstep with modelId so a `set_model` switch is reflected in both
			// the generic (provider, modelId) fields AND the claudeCodeModelAlias
			// field the Claude Code runtime API and spawn/respawn paths read.
			...(provider === "claude-code" ? { claudeCodeModelAlias: modelId } : {}),
		});
	}

	/** Persist per-session image generation model override. Validates against the
	 * registered image-model registry first; mirrors the WS handler's defence-in-depth
	 * check so any code path that lands here can't poison session state with an
	 * unknown (provider, modelId). */
	persistSessionImageModel(sessionId: string, provider: string, modelId: string): void {
		if (!this.isKnownImageModel(provider, modelId)) {
			throw new Error("unknown image model");
		}
		this.resolveStoreForSession(sessionId).update(sessionId, { imageModelProvider: provider, imageModelId: modelId });
	}

	persistSessionThinkingUserPinned(sessionId: string, pinned: boolean): void {
		this.resolveStoreForSession(sessionId).update(sessionId, { thinkingLevelUserPinned: pinned });
	}

	/** True when (provider, modelId) is registered as an available image model. */
	isKnownImageModel(provider: string, modelId: string): boolean {
		if (!this.preferencesStore) return false;
		const available = getAvailableImageModels(this.preferencesStore);
		return available.some((m) => m.provider === provider && m.id === modelId);
	}

	/** Resolve the image generation model for a session, falling back to the system default. */
	getImageModelForSession(sessionId: string): { provider: string; id: string } | undefined {
		const persisted = this.resolveStoreForId(sessionId)?.get(sessionId);
		if (persisted?.imageModelProvider && persisted?.imageModelId) {
			return { provider: persisted.imageModelProvider, id: persisted.imageModelId };
		}
		// Coalesce to the system default first, then parse exactly once.
		// `defaultImageModelPref()` always returns the parseable
		// "openai/gpt-image-2", so the result is always defined — the previous
		// `|| parseImageModelPref(defaultImageModelPref())` fallback chain was
		// dead code (the first parse always succeeded once we coalesce upstream).
		const pref = (this.preferencesStore?.get("default.imageModel") as string | undefined) || defaultImageModelPref();
		return parseImageModelPref(pref);
	}

	/**
	 * Cascade-reap an owner's child agents (OrchestrationCore §6).
	 *
	 * Generalized over EVERY child kind (not just pr-walkthrough): a child is any
	 * session with `delegateOf === id`, OR (`childKind` set AND
	 * `parentSessionId === id`). Live children are terminate+archived; dormant
	 * (persisted-but-not-in-memory) children are archived directly. This is the
	 * single hook that guarantees a live child never outlives its parent's
	 * archival — it runs from `terminateSession` AND from the runtime archive
	 * seam `archiveWithCascade`, so the cascade fires even when the parent is
	 * dormant/not-live or was archived while the server was down. The boot-reap
	 * (`shouldReapChildOnBoot`) remains as defense-in-depth.
	 */
	private async cascadeReapOwner(id: string): Promise<void> {
		// Cascade: terminate all live child sessions first. Children are linked via
		// `delegateOf` (delegate kind) OR `parentSessionId`+`childKind` (team /
		// pr-walkthrough / host-agents / any future kind) — otherwise a child
		// process leaks when its parent is terminated or archived.
		const children = [...this.sessions.values()].filter(s => s.delegateOf === id || (!!s.childKind && s.parentSessionId === id));
		for (const child of children) {
			console.log(`[session ${id}] Cascading terminate to child ${child.id}`);
			await this.terminateSession(child.id);
		}
		// Also archive persisted-but-not-in-memory children of any kind.
		const allLiveForTerminate = this.projectContextManager
			? [...this.projectContextManager.getAllLiveSessions()]
			: (this._testStore?.getLive() ?? []);
		for (const ps of allLiveForTerminate) {
			const isChild = ps.delegateOf === id || (!!ps.childKind && ps.parentSessionId === id);
			if (isChild && !this.sessions.has(ps.id)) {
				try { this.getSessionStore(ps.projectId).archive(ps.id); } catch { /* project gone */ }
			}
		}
		// Keep the OrchestrationCore in-memory index consistent.
		try { this.orchestrationCore?.forgetOwner(id); } catch { /* best-effort */ }
	}

	/**
	 * The single runtime archive seam (OrchestrationCore §6). EVERY runtime
	 * archive entry point that can archive a PARENT session routes through here
	 * so a live child never outlives its parent's archival — even when the parent
	 * is dormant/not-live, or was archived while the server was down. It cascade-
	 * reaps the owner's children FIRST (generalized to all child kinds via
	 * `cascadeReapOwner`), then archives the owner in its store. Reaped children
	 * archive IDENTICALLY to today's team-shutdown child archival (same status,
	 * same "show archived" surface, no new badge). `terminateSession` already
	 * cascades at its top, so its own internal archive does NOT route through
	 * here (avoids a redundant second cascade). The boot-restore reap
	 * (`shouldReapChildOnBoot`) stays as defense-in-depth for the server-was-down
	 * case.
	 */
	private async archiveWithCascade(id: string, store?: SessionStore): Promise<boolean> {
		await this.cascadeReapOwner(id);
		// Extension Platform G1.4: notify lifecycle providers the session is
		// shutting down. Best-effort and bounded by the hub's per-provider
		// timeouts; wrapped in try/catch so archival always completes even if a
		// provider hangs or throws. Resolve context from the live session when
		// present, else the persisted record (dormant sessions still archive).
		if (this.lifecycleHub) {
			const live = this.sessions.get(id);
			const persisted = live ? undefined : this.getPersistedSession(id);
			const src = live ?? persisted;
			if (src) {
				try {
					await this.lifecycleHub.dispatch("sessionShutdown", {
						sessionId: id,
						projectId: src.projectId,
						scope: src.projectId ? "project" : "global",
						cwd: src.cwd,
						// Effective goal (goalId ?? teamGoalId) so disabled-provider
						// filtering applies to members/delegates/reviewers too.
						goalId: src.goalId ?? src.teamGoalId,
						roleName: src.role,
					});
				} catch (err) {
					console.warn(`[session-manager] sessionShutdown dispatch failed for ${id}:`, err);
				}
			}
		}
		const target = store ?? this.resolveStoreForId(id);
		if (!target) return false;
		try { return target.archive(id); } catch { return false; }
	}

	async terminateSession(id: string): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;

		// Cascade-reap this owner's child agents (extracted seam — §6).
		await this.cascadeReapOwner(id);

		await this.closeExtensionChannelsForSession(id, "session-terminated");

		// Resolve any pending grant request so the guard's long-poll returns immediately
		if (session.pendingGrantRequest) {
			clearTimeout(session.pendingGrantRequest.timer);
			const pending = session.pendingGrantRequest;
			pending.resolve({ granted: false });
			this.appendToolPermissionAudit(session, pending, "denied", "auto");
			session.pendingGrantRequest = undefined;
		}

		// Cancel any pending transient auto-retry so it doesn't fire after terminate
		this.cancelPendingAutoRetry(session, "terminated");

		// Wait for in-flight metadata persist so the agentSessionFile path is
		// saved before we archive.  Without this, a quick terminate can race
		// the fire-and-forget persist, leaving agentSessionFile as "" and the
		// session's .jsonl history unreachable.
		if (session.pendingMetadataPersist) {
			try { await session.pendingMetadataPersist; } catch { /* already logged */ }
		}

		// Final get_state to flush conversation history to the .jsonl file.
		// persistSessionMetadata runs at creation time (fire-and-forget) when
		// the conversation may still be empty. This ensures the latest messages
		// are written before we archive.
		try {
			await session.rpcClient.getState();
		} catch {
			// Agent may already be stopped — best-effort flush
		}

		session.unsubscribe();
		await session.rpcClient.stop();
		broadcastStatus(session, "terminated");

		// Clean up background processes (abort any in-flight waits first so
		// hanging HTTP handlers resolve cleanly, then kill the bg processes).
		if ((this as any).bgProcessManager) {
			(this as any).bgProcessManager.abortAllWaits(id);
			(this as any).bgProcessManager.cleanup(id);
		}

		// Clean up sandbox token — remove session from project scope (not the whole project token)
		if (this.sandboxTokenStore && session.projectId) {
			this.sandboxTokenStore.removeSession(session.projectId, id);
		}

		// S1: drop the per-session capability secret so a terminated session's
		// secret can no longer resolve to an authentic caller.
		this.sessionSecretStore.remove(id);

		// Clean up sandbox worktree inside the container.
		// Skip for sessions that SHARE the parent's worktree and must never remove it:
		// delegate children (`delegateOf`) AND read-only child principals
		// (`readOnly` + `parentSessionId`, e.g. the host-agents PR-walkthrough reviewer).
		// A read-only child cannot write, so it never owns its own worktree — it shares
		// the launching session's still-active /workspace-wt/<name>. Only the owning
		// session should clean up. (Team children own a SEPARATE worktree and are not
		// read-only, so they are not skipped here.)
		if (session.sandboxed && !session.delegateOf && !(session.readOnly && session.parentSessionId) && session.cwd?.startsWith("/workspace-wt/") && this.sandboxManager && session.projectId) {
			try {
				const sandbox = this.sandboxManager.get(session.projectId);
				if (sandbox) {
					// Extract worktree name from container path: /workspace-wt/<name>
					const worktreeName = session.cwd.replace("/workspace-wt/", "");
					await sandbox.removeWorktree(worktreeName);
				}
			} catch (err) {
				console.warn(`[session-manager] Failed to remove sandbox worktree for ${id}:`, err);
			}
		}

		// Clean up model name file
		try {
			const modelNameFile = path.join(bobbitStateDir(), "model-name-" + id + ".txt");
			if (fs.existsSync(modelNameFile)) fs.unlinkSync(modelNameFile);
		} catch { /* ignore */ }

		// NOTE: proposal-drafts cleanup is deferred to purgeOneSession (the
		// 7-day purge mark). Both Path A (in-place resubmit) and Path B
		// (continue assistant) of the reopen-archived-proposals design read
		// these drafts off disk for archived sessions, so they must survive
		// archive. See docs/design/editable-proposals.md §4 + the design doc
		// `reopen-archived-proposals.md`.

		// Broadcast session_archived event before closing clients
		const archivedAt = Date.now();
		broadcast(session.clients, { type: "session_archived", sessionId: id, archivedAt });

		for (const client of session.clients) {
			client.close(1000, "Session terminated");
		}
		session.clients.clear();
		this._untrackConnectedSession(session);

		// Resolve the store BEFORE removing from in-memory map, so
		// resolveStoreForSession can look up the session's projectId.
		const terminateStore = this.resolveStoreForSession(id);
		const terminatedScope = { projectId: session.projectId, cwd: session.cwd };
		this.sessions.delete(id);
		this.taskIdCache.delete(id); // PERF-05: prune with the session, not indefinitely
		await this.cleanupScopedMcpManagersForSessionScope(terminatedScope);
		// Extension Platform G1.4: notify lifecycle providers the session is
		// shutting down on the live DELETE/stop path too. terminateSession
		// archives directly (bypassing archiveWithCascade), so the dispatch
		// must also fire here. Best-effort and bounded by the hub's per-provider
		// timeouts; wrapped in try/catch so termination always completes. Uses
		// the live `session` context captured at the top of this method.
		if (this.lifecycleHub) {
			try {
				await this.lifecycleHub.dispatch("sessionShutdown", {
					sessionId: id,
					projectId: session.projectId,
					scope: session.projectId ? "project" : "global",
					cwd: session.cwd,
					// Effective goal (goalId ?? teamGoalId) so disabled-provider
					// filtering applies to members/delegates/reviewers too.
					goalId: session.goalId ?? session.teamGoalId,
					roleName: session.role,
				});
			} catch (err) {
				console.warn(`[session-manager] sessionShutdown dispatch failed for ${id}:`, err);
			}
		}
		// Always archive — even without an agentSessionFile the metadata
		// (title, goal association, timestamps) is valuable and the search
		// index may reference this session.  Purge will clean it up later.
		terminateStore.archive(id);

		// Bug 2 (docs/design/orphan-remote-branch-cleanup.md): eagerly push-delete
		// the remote branch for non-delegate `session/*` sessions whose branch is
		// fully merged into origin/<primary>. Local worktree cleanup stays in
		// purgeOneSession at the 7-day mark. Fire-and-forget — never blocks.
		// branch/repoPath live on PersistedSession (not SessionInfo), so we read
		// the persisted record we just archived.
		const persistedForBranchDelete = terminateStore.get(id);
		const sessionBranch = persistedForBranchDelete?.branch;
		const repoPathForBranchDelete = persistedForBranchDelete?.repoPath;
		const skipRemoteBranchDelete = shouldSkipRemotePush() || !repoPathForBranchDelete || await shouldSkipRemoteGitForTests(repoPathForBranchDelete);
		eagerDeleteRemoteSessionBranch({
			branch: sessionBranch,
			repoPath: repoPathForBranchDelete,
			delegateOf: session.delegateOf,
			skipPush: skipRemoteBranchDelete,
			detectPrimary: detectPrimaryBranch,
			runGit: async (args, cwd) => {
				await execFileAsync("git", args, { cwd, timeout: 15_000 });
			},
		}).then(result => {
			if (result.deleted) {
				console.log(`[session-manager] Deleted merged remote session branch: ${sessionBranch}`);
			}
		}).catch(err => {
			console.warn(`[session-manager] Eager remote-delete failed for ${id}:`, err);
		});

	// Notify termination listeners (e.g. user-question harness cleanup, sidebar broadcast).
		// Pass cwd/worktreePath/repoWorktrees in the info so listeners
		// can't be defeated by the `sessions.delete(id)` above —
		// `getSession(id)` would return undefined here and refcounts would leak.
		const projectIdForListeners = session.projectId;
		const sessionCwd = session.cwd;
		const sessionWorktreePath = session.worktreePath;
		const sessionRepoWorktrees = session.repoWorktrees;
		for (const listener of this._terminationListeners) {
			try { listener(id, { projectId: projectIdForListeners, reason: "archived", cwd: sessionCwd, worktreePath: sessionWorktreePath, repoWorktrees: sessionRepoWorktrees }); } catch (err) {
				console.error(`[session ${id}] termination listener failed:`, err);
			}
		}

		// Don't remove color or session prompt — they're needed for archived view
		return true;
	}

	/** Get persisted session metadata by ID (live or dormant). */
	getPersistedSession(id: string): PersistedSession | undefined {
		return this.resolveStoreForId(id)?.get(id);
	}

	/** Get an archived session's metadata. */
	getArchivedSession(id: string): PersistedSession | undefined {
		const ps = this.resolveStoreForId(id)?.get(id);
		return ps?.archived ? ps : undefined;
	}

	/**
	 * Archive a session directly in the store (for dormant/store-only sessions).
	 * Routes through the runtime archive seam (§6) so a dormant parent's live
	 * children are cascade-reaped before it is archived.
	 */
	async storeArchive(id: string): Promise<boolean> {
		return this.archiveWithCascade(id);
	}

	/** Update metadata on an archived session (stored in the session store). Delegates to ArchivedWorktreeManager (SessionManager decomposition cohort 1, docs/design/session-manager-decomposition.md). */
	updateArchivedMeta(id: string, updates: { teamLeadSessionId?: string; parentSessionId?: string; childKind?: string; readOnly?: boolean; childTerminal?: boolean; terminalAt?: number }): boolean {
		return this.archivedWorktrees.updateArchivedMeta(id, updates);
	}

	/** Parse the .jsonl file for an archived session and return messages. */
	async getArchivedMessages(id: string): Promise<unknown[]> {
		return this.sessionTranscripts.getArchivedMessages(id);
	}

	/** List archived sessions in the same format as listSessions(). Delegates to ArchivedWorktreeManager. */
	listArchivedSessions(): ReturnType<ArchivedWorktreeManager["listArchivedSessions"]> {
		return this.archivedWorktrees.listArchivedSessions();
	}

	/** Permanently purge a single archived session immediately. Delegates to ArchivedWorktreeManager. */
	async purgeArchivedSession(id: string): Promise<boolean> {
		return this.archivedWorktrees.purgeArchivedSession(id);
	}

	/** Purge all archived sessions older than 7 days. Delegates to ArchivedWorktreeManager. */
	async purgeExpiredArchives(): Promise<void> {
		return this.archivedWorktrees.purgeExpiredArchives();
	}

	/** Scan archived sessions for cleanable worktrees. Delegates to ArchivedWorktreeManager. */
	async listArchivedSessionWorktrees(includeAlreadyCleaned = false): Promise<ArchivedSessionWorktreeScanResponse> {
		return this.archivedWorktrees.listArchivedSessionWorktrees(includeAlreadyCleaned);
	}

	/** Clean up selected archived-session worktrees. Delegates to ArchivedWorktreeManager. */
	async cleanupArchivedSessionWorktrees(request: CleanupArchivedSessionWorktreesRequest): Promise<CleanupArchivedSessionWorktreesResponse> {
		return this.archivedWorktrees.cleanupArchivedSessionWorktrees(request);
	}


	/**
	 * Try to recover a session's .jsonl file when agentSessionFile is empty.
	 * The agent CLI stores files as: <sessionsDir>/<cwd-slug>/<timestamp>_<uuid>.jsonl
	 * We scan the CWD-derived directory for a .jsonl created close to the session's createdAt.
	 *
	 * Public so the continue-archived REST handler can resolve the source
	 * `.jsonl` path for legacy persisted sessions whose `agentSessionFile`
	 * field was never populated.
	 */
	recoverSessionFile(ps: PersistedSession): string | null {
		return this.sessionTranscripts.recoverSessionFile(ps);
	}

	/**
	 * Clean up orphaned session worktrees that have no matching active session.
	 * Best-effort — logs warnings but never throws. Delegates to
	 * ArchivedWorktreeManager (SessionManager decomposition cohort 1,
	 * docs/design/session-manager-decomposition.md).
	 */
	async cleanupOrphanedSessionWorktrees(repoPath: string): Promise<void> {
		return this.archivedWorktrees.cleanupOrphanedSessionWorktrees(repoPath);
	}

	/**
	 * List orphaned session worktrees without deleting them.
	 * Same detection logic as cleanupOrphanedSessionWorktrees but read-only.
	 */
	async listOrphanedSessionWorktrees(repoPath: string): Promise<Array<{ path: string; branch: string }>> {
		return this.archivedWorktrees.listOrphanedSessionWorktrees(repoPath);
	}

	/**
	 * List orphaned non-interactive sessions (e.g. verification reviewers)
	 * that have no tracking in the verification harness. Read-only.
	 */
	async listOrphanedNonInteractiveSessions(): Promise<Array<{ id: string; title: string; createdAt: number }>> {
		return this.archivedWorktrees.listOrphanedNonInteractiveSessions();
	}

	/**
	 * Terminate a list of orphaned non-interactive sessions.
	 * Returns the number actually terminated.
	 */
	async terminateOrphanedSessions(sessionIds: string[]): Promise<number> {
		return this.archivedWorktrees.terminateOrphanedSessions(sessionIds);
	}

	/**
	 * Get statistics about expired archives (past 7-day retention).
	 */
	async getExpiredArchiveStats(): Promise<{ count: number; totalSizeBytes: number }> {
		return this.archivedWorktrees.getExpiredArchiveStats();
	}

	/** Start the archive purge schedule — call after restoreSessions(). */
	startPurgeSchedule(): void {
		// No longer purge on startup — use Settings → Maintenance to purge manually.
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
			const ps = this.resolveStoreForId(sessionId)?.get(sessionId);
			if (ps && (ps.agentSessionFile || canResumeClaudeCodeSession(ps))) {
				console.log(`[session-manager] Client connected to dormant session "${session.title}" — attempting restore`);
				this._restoreSessionCoalesced(ps)
					.then(() => {
						console.log(`[session-manager] Revived dormant session: "${session.title}" (${sessionId})`);
						// restoreSession replaces the map entry — add client to the canonical one.
						const revived = this.sessions.get(sessionId);
						if (revived && (ws as any).readyState === 1) {
							revived.clients.add(ws);
							this._trackConnectedSession(revived);
						}
					})
					.catch((err) => {
						console.error(`[session-manager] Failed to revive session ${sessionId}:`, err);
					});
				return true; // optimistically accept the client
			}
		}

		session.clients.add(ws);
		this._trackConnectedSession(session);

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
			this._trackConnectedSession(session);
		}
	}

	/**
	 * Abort the agent. If the graceful abort doesn't resolve within a timeout,
	 * force-kill the agent process and restart it so the session remains usable.
	 */
	/**
	 * Soft-abort: interrupt the current streaming turn without killing the
	 * agent process. Used by pause-cascade — the session stays registered so
	 * `goal_resume` can resume it later. No kill/restart fallback.
	 */
	async abortSessionTurn(id: string): Promise<void> {
		const session = this.sessions.get(id);
		if (!session || session.status !== "streaming") return;
		broadcastStatus(session, "aborting");
		try { await session.rpcClient.abort(); } catch { /* best-effort */ }
	}

	async forceAbort(id: string, gracePeriodMs = 3000): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;

		// S40: cancel any pending auto-retry timer regardless of streaming state.
		// An abort during the post-error backoff window (status "idle") would
		// otherwise leave the timer to fire a spurious retry on a session someone
		// just stopped (reachable via the team-abort route). No-op when none pending.
		this.cancelPendingAutoRetry(session, "terminated");

		// If not streaming, nothing more to abort
		if (session.status !== "streaming") return;

		// Broadcast aborting status so UI shows feedback during grace period
		broadcastStatus(session, "aborting");

		// CRITICAL: register the agent_end listener BEFORE calling abort().
		// The pi-agent-core SDK can emit agent_end synchronously inside the
		// await of rpcClient.abort() (handleRunFailure emits before finishRun()
		// clears activeRun). If we register after the await, we miss the event,
		// the grace period times out, and we fall into the force-kill branch —
		// which then kills the bridge process *after* drainQueue (running off
		// agent_end) has already dispatched a queued prompt to that bridge.
		// Result: the steered user-message echo renders but the agent process
		// is killed before it can produce an assistant response.
		let resolveSettled!: (v: boolean) => void;
		const settledPromise = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
		const settleTimer = setTimeout(() => {
			unsubSettle();
			resolveSettled(false);
		}, gracePeriodMs);
		const unsubSettle = session.rpcClient.onEvent((event: any) => {
			if (event.type === "agent_end") {
				clearTimeout(settleTimer);
				unsubSettle();
				resolveSettled(true);
			}
		});

		// Try graceful abort, but do NOT serialize it ahead of the grace race
		// (S8): rpcClient.abort() can block up to the 30s sendCommand timeout on a
		// wedged bridge, which would delay the force-kill to ~30s instead of the
		// intended gracePeriodMs (3s). Fire it un-awaited — wrapped in an async IIFE
		// so a SYNCHRONOUS throw ("Agent process not running" when there is no
		// stdin) becomes a caught rejection rather than escaping — and race it
		// against the grace timer below. A fast agent_end still resolves settled=true
		// and returns gracefully without force-kill.
		void (async () => { await session.rpcClient.abort(); })().catch(() => {});

		const settled = await settledPromise;

		if (settled) return;

		// Graceful abort didn't work — force kill and restart the agent
		console.log(`[session-manager] Force-aborting session ${id} — killing agent process`);

		// Get the agent session file before killing so we can restore.
		// Path is in the agent's coordinate system — no translation needed.
		let agentSessionFile: string | undefined;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success) agentSessionFile = stateResp.data?.sessionFile;
		} catch {
			const persisted = this.resolveStoreForSession(id).get(id);
			agentSessionFile = persisted?.agentSessionFile;
		}

		// Kill the process
		session.unsubscribe();
		await session.rpcClient.stop();

		// Reconcile any in-flight steers that died with the bridge: anything
		// left in the shadow ledger was recorded for dispatch but never echoed
		// (the process is dead before its message_end could arrive). Re-enqueue
		// at front so the post-respawn drainQueue redispatches them once.
		this._reconcileAfterAbort(session);

		// Emit agent_end so clients know streaming stopped.
		// WP4/RC3: route through emitSessionEvent so a client that resumes after a
		// force-abort replays the agent_end (and clears its stale streaming partial)
		// instead of relying on a later snapshot tick.
		emitSessionEvent(session, { type: "agent_end", messages: [] });
		broadcastStatus(session, "idle");

		// Restart the agent process
		try {
			await this._coalesceRestore(id, async (generation) => {
				session.lifecycleGeneration = generation;
				const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
			if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
			if (this.systemPromptPath) bridgeOptions.systemPromptPath = this.systemPromptPath;
			if (this.toolManager) bridgeOptions.toolManager = this.toolManager;
			bridgeOptions.env = {
				BOBBIT_SESSION_ID: id,
				BOBBIT_SESSION_SECRET: this.sessionSecretStore.getOrCreateSecret(id),
			};

			// Apply sandbox wiring for sandboxed sessions (container spawn, token, etc.)
			if (session.sandboxed) {
				const sandboxApplied = await this.applySandboxWiring(bridgeOptions, id, {
					projectId: session.projectId,
					goalId: session.goalId,
				});
				if (!sandboxApplied) {
					session.sandboxed = false;
					this.resolveStoreForSession(id).update(id, { sandboxed: false });
					this.applyScopedGatewayCredentials(bridgeOptions, id, session.projectId, session.goalId ?? session.teamGoalId);
				}
			} else {
				this.applyScopedGatewayCredentials(bridgeOptions, id, session.projectId, session.goalId ?? session.teamGoalId);
			}

			// Restore goal extension
			if (session.goalId) {
				bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
				const isTeamLead = session.role === "team-lead";
				if (isTeamLead) {
					bridgeOptions.args = ["--extension", this.getTeamLeadExtensionPath(), "--extension", this.getGoalToolsExtensionPath()];
				} else {
					bridgeOptions.args = ["--extension", this.getGoalToolsExtensionPath()];
				}
			}

			// Restore proposal tools extension for assistant sessions
			if (session.assistantType) {
				bridgeOptions.args = bridgeOptions.args || [];
				const proposalExtPath = this.getProposalToolsExtensionPath();
				if (!bridgeOptions.args.includes(proposalExtPath)) {
					bridgeOptions.args.push("--extension", proposalExtPath);
				}
			}

			// Restore tool activation, including Bobbit extension tools and MCP policy filtering.
			const role = this.resolveSessionRole(session.role, session.assistantType, session.projectId);
			// Derive the effective allowlist from the session/persisted allowlist when
			// present — NOT from the role alone. A restricted child/delegate (or any
			// session whose allowlist was narrowed/removed by bobbit.disabledTools)
			// persists a constrained allowedTools; recomputing from
			// `resolveEffectiveAllowedTools(role)` would widen it back to the role
			// default (minus disabled names) on force-abort respawn. Mirrors the
			// restore path's persisted-allowlist handling.
			const forceAbortPersisted = this.resolveStoreForSession(id).get(id);
			const forceAbortAllowedNames = forceAbortPersisted?.allowedTools ?? session.allowedTools;
			const effective: EffectiveTool[] = Array.isArray(forceAbortAllowedNames)
				? forceAbortAllowedNames.map(n => tagAllowedTool(n, this.toolManager))
				: this.resolveEffectiveAllowedTools(role);
			// Preserve the unrestricted (`undefined`) vs explicit-empty (`[]`)
			// distinction. A persisted `[]` means NO tools and MUST stay `[]` — never
			// collapse it to `undefined`, which would re-grant every tool. Only a
			// genuinely unrestricted resolution (role-less ⇒ resolves to `[]`)
			// collapses to `undefined` (all tools), preserving today's behaviour.
			const forceAbortAllowed: EffectiveTool[] | undefined = Array.isArray(forceAbortAllowedNames)
				? effective
				: (effective.length > 0 ? effective : undefined);
			await this.ensureMcpManagerForContext(session.projectId, session.cwd);
			const forceActivation = this.buildToolActivationArgs(id, forceAbortAllowed, role, session.cwd, session.projectId, session.goalId ?? session.teamGoalId, session.sessionOnlyGrantedTools);
			bridgeOptions.args = [...forceActivation.args, ...(bridgeOptions.args || [])];
			bridgeOptions.piExtensions = [...(bridgeOptions.piExtensions ?? []), ...forceActivation.runtimeExtensions];
			bridgeOptions.env = { ...(bridgeOptions.env || {}), ...forceActivation.env };

			// Pin model/thinking-level at spawn for the force-abort respawn.
			const forceRespawnPersisted = this.resolveStoreForSession(id).get(id);
			if (forceRespawnPersisted?.modelProvider && forceRespawnPersisted?.modelId) {
				bridgeOptions.initialModel = `${forceRespawnPersisted.modelProvider}/${forceRespawnPersisted.modelId}`;
			} else {
				const initModel = this.resolveInitialModel(session.role, session.projectId);
				if (initModel) bridgeOptions.initialModel = initModel;
			}
			const initThinking = session.spawnPinnedThinkingLevel ?? this.resolveInitialThinkingLevel(session.role, session.projectId);
			if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;
			this.applyDirectProviderEnv(bridgeOptions, !!session.sandboxed, forceRespawnPersisted?.modelProvider);
			const runtime = resolveSessionRuntime({ runtime: forceRespawnPersisted?.runtime, initialModel: bridgeOptions.initialModel, modelProvider: forceRespawnPersisted?.modelProvider });
			assertRuntimeAllowedForSession(runtime, session.sandboxed);
			Object.assign(bridgeOptions, hydrateRuntimeOptions({
				...bridgeOptions,
				runtime,
				claudeCodeSessionId: forceRespawnPersisted?.claudeCodeSessionId,
				claudeCodeExecutable: forceRespawnPersisted?.claudeCodeExecutable,
				claudeCodePermissionMode: forceRespawnPersisted?.claudeCodePermissionMode,
				claudeCodeModelAlias: forceRespawnPersisted?.claudeCodeModelAlias,
				readOnly: forceRespawnPersisted?.readOnly ?? session.readOnly,
			}, this.readClaudeCodeConfigForProject(session.projectId)));

		const rpcClient = createSessionBridge(bridgeOptions);
		session.spawnPinnedModel = bridgeOptions.initialModel;
		session.spawnPinnedThinkingLevel = bridgeOptions.initialThinkingLevel;
		session.thinkingRouterAppliedBaseline = undefined;
		let switchingSession = true;
			const abortStore = this.resolveStoreForSession(id);
			const unsub = rpcClient.onEvent((event: any) => {
				if (isUserVisibleActivity(event)) {
					session.lastActivity = Date.now();
					abortStore.update(id, { lastActivity: session.lastActivity });
				}

				this.handleAgentLifecycle(session, event);

				const truncated = truncateLargeToolContent(event);
				emitSessionEvent(session, truncated);
				if (!switchingSession) this.trackCostFromEvent(session, event);
			});

			bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension);
			await rpcClient.start();

			// Resume session if we have the session file.
			const abortPs = { ...forceRespawnPersisted, ...session, agentSessionFile } as PersistedSession;
			const abortFileCtx = sessionFsContextForAgentFile(abortPs, agentSessionFile);
			if (agentSessionFile) trustPersistedAgentSessionFile(agentSessionFile);
			if (agentSessionFile && await sessionFileExists(abortFileCtx, agentSessionFile, this.sandboxManager)) {
				// Un-poison blank-text user messages before rehydrating — this is
				// the route a live already-stuck session takes (forceAbort →
				// respawn), so the re-spawned agent reads a sanitized transcript.
				await sanitizeAgentTranscriptFile(abortFileCtx, agentSessionFile, this.sandboxManager);
				const switchResp = await rpcClient.sendCommand(
					{ type: "switch_session", sessionPath: switchSessionPathForAgent(abortPs) },
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

			try {
				await this.tryAutoSelectModel(session);
			} catch (err) {
				await rpcClient.stop();
				throw err;
			}

			broadcastStatus(session, "idle");
			console.log(`[session-manager] Session ${id} agent restarted after force abort`);

				// Drain any queued messages (steered first, then normal). Fresh
				// retry budget — the old process (and its busy guard) is gone.
				session.recoverDrainAttempts = 0;
				this.drainQueue(session);
				return session;
			});
		} catch (err) {
			console.error(`[session-manager] Failed to restart agent after force abort:`, err);
			broadcastStatus(session, "terminated");
		}
	}

	/**
	 * One-shot migration: heal sessions that lost their `staffId` association
	 * before the staffId-persistence fix landed. Delegates to the standalone
	 * `backfillStaffIds` helper in `staff-backfill.ts` so the algorithm can
	 * be unit-tested without dragging in `SessionManager`'s dependency graph.
	 *
	 * See `staff-backfill.ts` for the full behavioural contract.
	 */
	backfillStaffIds(staffManager: import("./staff-backfill.js").BackfillStaffManager): number {
		if (!this.projectContextManager) return 0;
		return backfillStaffIdsImpl(this.projectContextManager, staffManager);
	}

	async shutdown(): Promise<void> {
		if (this.purgeInterval) {
			clearInterval(this.purgeInterval);
			this.purgeInterval = null;
		}
		if (this._statusHeartbeatTimer) {
			clearInterval(this._statusHeartbeatTimer);
			this._statusHeartbeatTimer = null;
		}

		// CON-04: flush any already-debounced store writes BEFORE the per-session
		// teardown loop below, which awaits closeExtensionChannelsForSession() and
		// rpcClient.stop() (up to 3s each, SIGTERM->SIGKILL) sequentially per
		// session. On a slow/unresponsive teardown the harness's own SIGKILL
		// deadline (harness.ts) can preempt this function before it reaches the
		// post-loop flush a few lines below. Flushing here first means whatever
		// was pending before shutdown() started is durable even if the loop
		// itself never finishes. The post-loop flush remains the final word for
		// anything written during the loop (recovery-critical fields below are
		// now synchronous regardless — see RECOVERY_CRITICAL_FIELDS).
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) ctx.sessionStore.flush();
		} else if (this._testStore) {
			this._testStore.flush();
		}
		try { (this as any).bgProcessManager?.flush(); } catch { /* best-effort */ }

		// Don't remove from store on shutdown — sessions should survive restart.
		// Persist the active/busy state for each session so interrupted agents
		// can be re-driven on the next startup. The durable field is still named
		// `wasStreaming` for store compatibility, but it means "restart re-drive
		// needed" for every non-idle, non-terminal session status.
		const ids = Array.from(this.sessions.keys());
		for (const id of ids) {
			const session = this.sessions.get(id);
			if (!session) continue;

			await this.closeExtensionChannelsForSession(id, "gateway-shutdown");

			// MEM-1: graceful shutdown (SIGINT/SIGTERM) previously never dispatched
			// `sessionShutdown` for still-live sessions — only archiveWithCascade and
			// terminateSession did — so a lifecycle provider's flush-on-shutdown hook
			// (e.g. the hindsight memory pack's pending-buffer flush + retry-queue
			// drain) never ran on a plain gateway restart/stop, stranding whatever was
			// buffered. Mirrors the archiveWithCascade/terminateSession dispatch sites
			// above: best-effort and bounded by the hub's own per-provider timeouts
			// (ModuleHost's invoke-level terminate-on-timeout — see
			// LifecycleHub.dispatch), wrapped in try/catch so a hung/throwing provider
			// can never block graceful shutdown.
			if (this.lifecycleHub) {
				try {
					await this.lifecycleHub.dispatch("sessionShutdown", {
						sessionId: id,
						projectId: session.projectId,
						scope: session.projectId ? "project" : "global",
						cwd: session.cwd,
						// Effective goal (goalId ?? teamGoalId) so disabled-provider
						// filtering applies to members/delegates/reviewers too.
						goalId: session.goalId ?? session.teamGoalId,
						roleName: session.role,
					});
				} catch (err) {
					console.warn(`[session-manager] sessionShutdown dispatch failed for ${id}:`, err);
				}
			}

			// Snapshot the current active state before we kill the process.
			// This is authoritative — the in-memory status is always correct,
			// and we write it here to handle the case where shutdown() races
			// with a pending lifecycle event that hasn't flushed to disk yet.
			const needsRestartRedrive = sessionNeedsRestartRedrive(session);
			this.resolveStoreForSession(id).update(id, {
				wasStreaming: needsRestartRedrive,
				streamingStartedAt: needsRestartRedrive ? (session.streamingStartedAt ?? Date.now()) : undefined,
			});

			// Cancel any pending transient/provider-backoff auto-retry so the
			// timer doesn't fire after the agent has been stopped. Clients are
			// closing in shutdown so suppress the cancellation broadcast.
			this.cancelPendingAutoRetry(session, "shutdown");

			session.unsubscribe();
			await session.rpcClient.stop();
			// shutdown(): clients are being closed; broadcast is harmless but unnecessary.
			// Status mutation here is the documented exception to the broadcastStatus rule.
			session.status = "terminated";

			for (const client of session.clients) {
				client.close(1000, "Server shutting down");
			}
			session.clients.clear();
			this._untrackConnectedSession(session);
			this.sessions.delete(id);
		}

		// Flush any debounced store writes before exit
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				ctx.sessionStore.flush();
				// PERF-01: flush the debounced cost-tracker save so the last
				// window of per-message cost/token counters isn't lost.
				ctx.costTracker.flush();
			}
		} else if (this._testStore) {
			this._testStore.flush();
			this._testCostTracker?.flush();
		}
		// Flush pending bg-process projection writes + store epoch before exit so
		// re-attach exit codes and dismiss removals survive a restart (the bg
		// store mirrors sessionStore's stale-snapshot guard).
		try { (this as any).bgProcessManager?.flush(); } catch { /* best-effort */ }

		// Close search index
		try {
			if (this.projectContextManager) {
				// ProjectContextManager.closeAll() handles search index closing
			} else if (this._testSearchIndex) {
				await this._testSearchIndex.close();
			}
		} catch (err) {
			console.error("[search] Failed to close search index:", err);
		}

		// Disconnect any MCP servers this manager connected (default + scoped —
		// forceAbort respawn and restore paths lazily create scoped managers per
		// project/cwd via ensureMcpManagerForContext). Left connected, their real
		// stdio child processes / HTTP sockets outlive the gateway process on a
		// graceful shutdown. Delegates to McpWiring (SessionManager decomposition
		// cohort 2, docs/design/session-manager-decomposition.md) — see
		// mcp-wiring.ts's shutdownDisconnectAll for the best-effort/typeof-guard
		// details preserved verbatim from this file's pre-extraction logic.
		await this.mcpWiring.shutdownDisconnectAll();
	}
}
