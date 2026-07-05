import { execFile as execFileCb, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import type {
	ServerMessage,
	QueuedMessage,
	AutoRetryPendingEvent,
	AutoRetryCancelledEvent,
} from "../ws/protocol.js";
import { sandboxNetworkCreateArgs } from "./docker-args.js";
import { EventBuffer } from "./event-buffer.js";
import { GoalManager } from "./goal-manager.js";
import { TaskManager } from "./task-manager.js";
import { PromptQueue } from "./prompt-queue.js";
import { SearchService } from "../search/search-service.js";
import { RpcBridge, hostPathToContainer, synthesizeAttachmentText, ATTACHMENT_ONLY_TEXT, type IRpcBridge, type RpcBridgeOptions, type RuntimePiExtensionInfo, type RuntimePiExtensionDiagnostic } from "./rpc-bridge.js";
import { readClaudeCodeConfig } from "./claude-code-config.js";
import { assertRuntimeAllowedForSession, createSessionBridge, hydrateRuntimeOptions, resolveSessionRuntime } from "./session-runtime.js";
import { sessionFileExists, sessionFileRead, sessionFsContextForAgentFile } from "./session-fs.js";
import { writeSessionSidecar, buildSessionSidecar } from "./session-sidecar.js";
import { resolveReadablePersistedAgentSessionFile, sanitizeAgentTranscriptFile, trustPersistedAgentSessionFile } from "./transcript-sanitizer.js";
import type { SkillExpansion } from "../skills/resolve-skill-expansions.js";
import type { FileMention } from "../skills/resolve-file-mentions.js";
import { appendSkillSidecarEntry } from "../skills/skill-sidecar.js";
import {
	appendCompactionSidecarEntry,
	makeCompactionId,
	mergeCompactionSidecarIntoMessages,
	parseCompactionStartMs,
} from "./compaction-sidecar.js";
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
import { SessionLifecycleFence, type RestoreCoordinator, type SessionLifecycleFenceDeps } from "./session-lifecycle-fence.js";
export { type RestoreCoordinator, type LifecycleFenceSession, type SessionLifecycleFenceDeps } from "./session-lifecycle-fence.js";
import { BgProcessStore } from "./bg-process-store.js";
import { SessionSecretStore } from "../auth/session-secret.js";
import { redactSensitive } from "../auth/redact.js";
import { readToken } from "../auth/token.js";
import { shouldKeepDespiteOrphan, scanOrphanedTranscripts } from "./orphan-cleanup.js";
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
import { shouldSkipRemotePush, shouldSkipRemoteGitForTests, detectPrimaryBranch, isGitRepo, getRepoRoot, isUnresolvedHeadWorktreeError } from "../skills/git.js";
import { eagerDeleteRemoteSessionBranch } from "./session-eager-branch-delete.js";
import type { GrantPolicy, Role } from "./role-store.js";
import { applyModelString } from "./review-model-override.js";
import { sanitizeModelErrorForLog, sanitizeModelErrorText } from "./model-error-sanitizer.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import { decideOverflowAction } from "../ws-overflow-guard.js";

import { McpManager, type MarketplaceMcpResolver, type McpReloadResult } from "../mcp/mcp-manager.js";
import { makeMetaToolName, parseMcpToolName } from "../mcp/mcp-meta.js";
import { isTransientReviewError, isProviderBackoffError, isRetryableGenericAgentError, isNonRetryableAgentError } from "./verification-logic.js";
import { truncateLargeToolContent, truncateLargeToolContentInMessages } from "./truncate-large-content.js";
import { getAigwUrl, discoverAigwModels, deriveName } from "./aigw-manager.js";
import { defaultImageModelPref, getAvailableImageModels, parseImageModelPref } from "./image-generation.js";
import { selectAigwModelForRoleTier, resolveModelStateMeta } from "./model-registry.js";
import { isSessionSelectableModelString } from "./google-code-assist.js";
import { isKnownThinkingLevel, type ThinkingLevel } from "../../shared/thinking-levels.js";
import { clampThinkingLevelForModel } from "./thinking-level-clamp.js";
import type { Decision } from "./decision-types.js";
import { THINKING_ROUTER_POINT, THINKING_ROUTER_KIND, THINKING_ROUTER_CLASSIFIER_ID, isThinkingRouterApplyMode } from "./thinking-router-classifier.js";
import { TOOL_APPROVE_POINT, TOOL_APPROVE_KIND, isToolApproveEnforceMode, isAutoDenyDecision, type ToolApproveVerdict } from "./tool-approve-classifier.js";
import { ToolPermissionAuditLog, type ToolPermissionAuditDecision, type ToolPermissionAuditSource } from "./tool-permission-audit-log.js";
import { resolveRolePrompt, buildRestoreRolePrompt } from "./role-prompt.js";
import { applyPromptConditionals } from "./prompt-conditionals.js";
// createWorktree is used in session-setup.ts pipeline
import { ProjectContextManager } from "./project-context-manager.js";
import { GoalStore, type PersistedGoal } from "./goal-store.js";
import { PrStatusStore } from "./pr-status-store.js";
import { TaskStore } from "./task-store.js";
import type { GateStore } from "./gate-store.js";
import { bobbitStateDir, bobbitConfigDir, globalAuthPath } from "../bobbit-dir.js";
import { activeAgentSessionsDir, migratedActiveAgentSessionFileForHostPath, trustedAgentSessionsRoots } from "./agent-session-path.js";
import { shouldReapChildOnBoot, shouldSendRestartCollectionReminder, type OrchestrationCore } from "./orchestration-core.js";

import { isSandboxExemptProject, type SandboxManager } from "./sandbox-manager.js";
import type { LifecycleHub } from "./lifecycle-hub.js";
import { WorktreePool } from "./worktree-pool.js";
import { backfillStaffIds as backfillStaffIdsImpl } from "./staff-backfill.js";
import {
	type SessionSetupPlan,
	type PipelineContext,
	type SandboxWiringOptions,
	type MarketplacePiExtensionResolver,
	type MarketplacePiExtensionActivation,
	type PiExtensionDiagnostic,
	resolveMarketplacePiExtensionActivation,
	scopedToolContext,
	executePlan,
	executeWorktreeAsync,
	persistOnce,
	handleSetupFailure,
	sendDelegatePrompt,
	DELEGATE_SPAWN_TIMEOUT_MS,
	nextBackoffDelay,
	applySandboxCwdOffset,
	normalizeSandboxCwdOffset,
	relativeSandboxCwdOffset,
} from "./session-setup.js";

const execFileAsync = promisify(execFileCb);

function isSandboxContainerPath(cwd?: string): boolean {
	return !!cwd && (cwd === "/workspace" || cwd.startsWith("/workspace/") || cwd === "/workspace-wt" || cwd.startsWith("/workspace-wt/"));
}

function isWindowsAbsolutePath(filePath: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(filePath);
}

function isContainerAgentSessionPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/");
	return normalized === "/home/node/.bobbit/agent/sessions"
		|| normalized.startsWith("/home/node/.bobbit/agent/sessions/")
		|| normalized === "/bobbit-state/sessions"
		|| normalized.startsWith("/bobbit-state/sessions/");
}

function isHostAbsoluteAgentSessionPath(filePath: string | undefined): boolean {
	if (!filePath || isContainerAgentSessionPath(filePath)) return false;
	return path.isAbsolute(filePath) || isWindowsAbsolutePath(filePath);
}

function safePersistedHostAgentSessionFile(filePath: string | undefined): string | null {
	if (!filePath) return null;
	if (!isHostAbsoluteAgentSessionPath(filePath)) return filePath;
	trustPersistedAgentSessionFile(filePath);
	return resolveReadablePersistedAgentSessionFile(filePath);
}

function extractClaudeCodeSessionId(value: any): string | undefined {
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
const MAX_CONSECUTIVE_ERROR_TURNS = 3;

/**
 * Upper bound on the number of consecutive immediate (tick-0) redrains that
 * `recoverPromptDispatch` will schedule after a dispatch is rejected. The
 * tick-0 retry exists for a one-microtask race (agent_end's synchronous
 * drainQueue prompt() loses to the SDK's not-yet-run finishRun(), so the agent
 * reports "Agent is already processing"); one macrotask later the redrain
 * succeeds. When the agent is genuinely mid-turn, every redrain hits the same
 * busy guard and reschedules itself — an unbounded setTimeout(0) spin that
 * floods the logs for the whole turn. After this many failed immediate retries
 * we stop scheduling and leave the rows queued for the next agent_end drain.
 */
const MAX_RECOVER_DRAIN_RETRIES = 2;

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

function providerFromAuthFailure(message: string | undefined, fallbackProvider?: string): string | undefined {
	const safeFallback = safeProviderId(fallbackProvider);
	if (!message) return safeFallback;
	for (const pattern of PROVIDER_AUTH_FAILURE_PATTERNS) {
		const match = message.match(pattern);
		const safeMatch = safeProviderId(match?.[1]);
		if (safeMatch) return safeMatch;
	}
	return safeFallback;
}

function isProviderAuthFailure(message: string | undefined): boolean {
	return !!message && PROVIDER_AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(message));
}

function providerLabel(provider: string | undefined): string {
	if (!provider) return "provider";
	if (provider.toLowerCase() === "openrouter") return "OpenRouter";
	return provider;
}

function redactDispatchFailureReason(reason: string, providerAuthFailure: boolean, fallbackProvider?: string): string {
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

/**
 * Build a user-visible system-prefix explaining that the previous turn
 * errored. Injected in front of the user's new text when SessionManager
 * implicitly unsticks a wedged session — orients the model to recover and
 * continue without redoing completed work.
 */
function buildErrorRecoveryPrefix(errMsg: string, userText: string): string {
	const snippet = (errMsg || "unknown error").slice(0, 200);
	return `[SYSTEM: previous turn failed with: ${snippet}. Your previous turn was interrupted. Pick up where you left off — re-check state first and avoid redoing completed work.]\n\n${userText}`;
}

/**
 * Detect the model-API "blank ContentBlock text" validation error — the
 * signature of an image/attachment-only prompt whose blank text was committed
 * to the agent's history before the synthesizeAttachmentText fix. Such a turn
 * poisons the in-memory transcript: every later prompt re-sends the blank
 * block, so re-prompting the SAME live process re-fails. The only cure for a
 * live-poisoned session is to respawn the agent so it rehydrates from the
 * now-sanitized `.jsonl` (see transcript-sanitizer.ts).
 */
function isBlankContentBlockError(errMsg: string | undefined): boolean {
	if (!errMsg) return false;
	return /text field in the ContentBlock/i.test(errMsg) && /is blank/i.test(errMsg);
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
function extractUserMessageText(message: any): string {
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

/**
 * Build the `state.model` payload for a live model-state broadcast. Routes
 * through `resolveModelStateMeta` (registry cache → pi-ai catalog → inferMeta)
 * so the frame carries the SAME contextWindow / maxTokens / reasoning /
 * thinkingLevelMap the ModelSelector dropdown shows. The client full-replaces
 * `state.model`, so every field must be present. `thinkingLevelMap` is omitted
 * when upstream metadata doesn't provide it.
 */
function buildModelStateData(provider: string, id: string): { model: Record<string, unknown> } {
	const meta = resolveModelStateMeta(provider, id);
	return {
		model: {
			provider,
			id,
			contextWindow: meta.contextWindow,
			maxTokens: meta.maxTokens,
			reasoning: meta.reasoning,
			...(meta.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
		},
	};
}

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

function withPersistedClaudeCodeMessageTimestamp(message: any, envelopeTs: unknown): any {
	if (!message || typeof message !== "object" || message.timestamp !== undefined) return message;
	let timestamp: number | undefined;
	if (typeof envelopeTs === "number" && Number.isFinite(envelopeTs)) timestamp = envelopeTs < 10_000_000_000 ? envelopeTs * 1000 : envelopeTs;
	else if (typeof envelopeTs === "string") {
		const parsed = Date.parse(envelopeTs);
		if (Number.isFinite(parsed)) timestamp = parsed;
	}
	return timestamp === undefined ? message : { ...message, timestamp };
}

function normalizePersistedClaudeCodeAskMessages(messages: unknown[]): unknown[] {
	const askToolIds = new Set<string>();
	for (const message of messages as any[]) {
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			const id = typeof block?.toolCallId === "string" ? block.toolCallId : (typeof block?.id === "string" ? block.id : undefined);
			if (block?.type === "toolCall" && block.name === "ask_user_choices" && id) askToolIds.add(id);
		}
	}
	return messages.map((message: any) => {
		if (message?.role !== "toolResult") return message;
		if (message.toolName !== "ask_user_choices" || !askToolIds.has(message.toolCallId)) return message;
		const text = stringifyPersistedToolResultContent(message.content).trim();
		if (text !== "Answer questions?") return message;
		const rest = { ...message };
		delete rest.error;
		return {
			...rest,
			isError: false,
			content: [{ type: "text", text: JSON.stringify({ status: "posted", tool_use_id: message.toolCallId }) }],
		};
	});
}

function stringifyPersistedToolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((item: any) => {
			if (typeof item === "string") return item;
			if (item?.type === "text" && typeof item.text === "string") return item.text;
			try { return JSON.stringify(item); } catch { return String(item); }
		}).join("\n");
	}
	if (content == null) return "";
	try { return JSON.stringify(content); } catch { return String(content); }
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
	private staffRecordSource?: { getStaff(id: string): import("./staff-store.js").PersistedStaff | undefined };
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
	private _inboxNudger: import("./inbox-nudger.js").InboxNudger | null = null;
	private _onPrCreationDetected?: (session: SessionInfo) => void;
	private _verificationHarness?: import("./verification-harness.js").VerificationHarness;
	private _terminationListeners: Array<(sessionId: string, info: { projectId?: string; reason: "terminated" | "archived" | "purged"; cwd?: string; worktreePath?: string; repoWorktrees?: Array<{ worktreePath: string }> }) => void> = [];
	private _creationListeners: Array<(session: SessionInfo) => void> = [];
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
	/** Cached aigw model discovery result (url → { models, timestamp }) */
	private _aigwModelCache: { url: string; models: Awaited<ReturnType<typeof discoverAigwModels>>; ts: number } | null = null;
	private static AIGW_CACHE_TTL_MS = 60_000; // 1 minute
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

	private _currentRespawnGeneration(...args: Parameters<SessionLifecycleFence<SessionInfo>["currentRespawnGeneration"]>): ReturnType<SessionLifecycleFence<SessionInfo>["currentRespawnGeneration"]> {
		return this.lifecycleFence.currentRespawnGeneration(...args);
	}

	_nextRespawnGeneration(...args: Parameters<SessionLifecycleFence<SessionInfo>["nextRespawnGeneration"]>): ReturnType<SessionLifecycleFence<SessionInfo>["nextRespawnGeneration"]> {
		return this.lifecycleFence.nextRespawnGeneration(...args);
	}

	private _sessionWriterIsCurrent(...args: Parameters<SessionLifecycleFence<SessionInfo>["sessionWriterIsCurrent"]>): ReturnType<SessionLifecycleFence<SessionInfo>["sessionWriterIsCurrent"]> {
		return this.lifecycleFence.sessionWriterIsCurrent(...args);
	}

	private _fenceReplacedSession(...args: Parameters<SessionLifecycleFence<SessionInfo>["fenceReplacedSession"]>): ReturnType<SessionLifecycleFence<SessionInfo>["fenceReplacedSession"]> {
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
	private orchestrationCore: OrchestrationCore | null = null;
	setOrchestrationCore(core: OrchestrationCore | null): void {
		this.orchestrationCore = core;
	}

	setInboxNudger(nudger: import("./inbox-nudger.js").InboxNudger | null): void {
		this._inboxNudger = nudger;
	}

	setStaffManager(sm: { getStaff(id: string): import("./staff-store.js").PersistedStaff | undefined }): void {
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
		if (session.projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(session.projectId);
			if (ctx) return ctx.costTracker;
		}
		if (this._testCostTracker) return this._testCostTracker;
		throw new Error("Cannot resolve cost tracker: session has no projectId");
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

	private readClaudeCodeConfigForProject(projectId?: string) {
		if (!this.preferencesStore) return undefined;
		const projectConfigStore = projectId && this.projectContextManager
			? (this.projectContextManager.getOrCreate(projectId)?.projectConfigStore ?? this.projectConfigStore ?? null)
			: (this.projectConfigStore ?? null);
		return readClaudeCodeConfig(this.preferencesStore, projectConfigStore);
	}

	/** Build a PipelineContext from this manager's fields. Requires projectId when PCM is active. */
	buildPipelineContext(projectId?: string, cwd?: string): PipelineContext {
		const resolvedStore = this.getSessionStore(projectId);
		const resolvedSearchIndex = this.getSearchIndexForProject(projectId);
		let resolvedGoalManager: GoalManager;
		let resolvedTaskManager: TaskManager;
		let resolvedProjectConfigStore = this.projectConfigStore ?? null;
		let resolvedCostTracker: CostTracker;
		if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (ctx) {
				resolvedGoalManager = ctx.goalManager;
				resolvedTaskManager = new TaskManager(ctx.taskStore);
				resolvedProjectConfigStore = ctx.projectConfigStore;
				resolvedCostTracker = ctx.costTracker;
			} else {
				throw new Error(`Cannot build pipeline context: project "${projectId}" not found`);
			}
		} else if (this._testCostTracker && this._testGoalManager && this._testTaskManager) {
			resolvedCostTracker = this._testCostTracker;
			resolvedGoalManager = this._testGoalManager;
			resolvedTaskManager = this._testTaskManager;
		} else {
			throw new Error("Cannot build pipeline context: no project context manager or test stores");
		}
		resolvedGoalManager.setLiveSessionResolver(() => this.getAllPersistedSessionsForWorktreeGuard());
		return {
			agentCliPath: this.agentCliPath,
			systemPromptPath: this.systemPromptPath,
			roleManager: this.roleManager ?? null,
			toolManager: this.toolManager ?? null,
			mcpManager: this.getMcpManagerForContext(projectId, cwd),
			marketplacePiExtensionResolver: this.marketplacePiExtensionResolver,
			goalManager: resolvedGoalManager,
			taskManager: resolvedTaskManager,
			projectConfigStore: resolvedProjectConfigStore,
			preferencesStore: this.preferencesStore ?? null,
			sandboxManager: this.sandboxManager,
			sandboxTokenStore: this.sandboxTokenStore,
			sessionSecretStore: this.sessionSecretStore,
			groupPolicyStore: this.groupPolicyStore ?? null,
			configCascade: this.configCascade,
			lifecycleHub: this.lifecycleHub,
			costTracker: resolvedCostTracker,
			store: resolvedStore,
			searchIndex: resolvedSearchIndex,
			sessions: this.sessions,
			listPersistedSessionsForWorktreeGuard: () => this.getAllPersistedSessionsForWorktreeGuard(),
			assemblePrompt: (id, parts) => this.assemblePrompt(id, parts),

			applySandboxWiring: (opts, id, sandboxOpts) => this.applySandboxWiring(opts, id, sandboxOpts),
			handleAgentLifecycle: (session, event) => this.handleAgentLifecycle(session, event),
			trackCostFromEvent: (session, event) => this.trackCostFromEvent(session, event),
			recordPiExtensionDiagnostic: (session, diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension),
			broadcast: (clients, msg) => broadcast(clients, msg),
			tryAutoSelectModel: (session) => this.tryAutoSelectModel(session),
			tryApplyDefaultThinkingLevel: (session) => this.tryApplyDefaultThinkingLevel(session),
			buildWorkflowList: (projectId?: string) => this._buildWorkflowList(projectId),
			resolveInitialModel: (role, projectId) => this.resolveInitialModel(role, projectId),
			resolveInitialThinkingLevel: (role, projectId) => this.resolveInitialThinkingLevel(role, projectId),
			persistSessionMetadata: (session) => this.persistSessionMetadata(session),
			prStatusStore: this.prStatusStore!,
			// Hierarchical goal-metadata resolver, bound to THIS project's GoalManager.
			// The pipeline (tool activation, prompt order, bridge-install) resolves the
			// effective (inherited) metadata for a session's goal through this single
			// closure — no other site walks the goal ancestry. Absent metadata ⇒ {}.
			resolveGoalMetadata: (goalId: string | undefined) => resolvedGoalManager.getEffectiveGoalMetadata(goalId),
		};
	}

	/** Network name for sandbox containers. */
	private static readonly SANDBOX_NETWORK = "bobbit-sandbox-net";

	/**
	 * Ensure the Docker bridge network for sandboxed containers exists.
	 * Idempotent — checks with `docker network inspect` first.
	 */
	async ensureSandboxNetwork(): Promise<string> {
		const name = SessionManager.SANDBOX_NETWORK;
		try {
			await execFileAsync("docker", sandboxNetworkCreateArgs(name), { timeout: 15_000 });
			console.log(`[session-manager] Created Docker network "${name}"`);
		} catch (err: any) {
			const msg = err.stderr || err.message || "";
			if (!msg.includes("already exists")) {
				console.error(`[session-manager] Failed to create Docker network "${name}":`, err);
				throw err;
			}
			// Network was created concurrently — that's fine
		}
		return name;
	}

	/**
	 * Remove the sandbox Docker network. Non-fatal if it doesn't exist
	 * or has connected containers.
	 */
	async cleanupSandboxNetwork(): Promise<void> {
		try {
			await execFileAsync("docker", ["network", "rm", SessionManager.SANDBOX_NETWORK], { timeout: 10_000 });
			console.log(`[session-manager] Removed Docker network "${SessionManager.SANDBOX_NETWORK}"`);
		} catch {
			// Non-fatal — network may not exist or may have connected containers
		}
	}

	private async resolveSandboxCwdOffset(
		cwd: string,
		projectId?: string,
		goalId?: string,
		explicitOffset?: string,
	): Promise<string | undefined> {
		const explicit = normalizeSandboxCwdOffset(explicitOffset);
		if (explicit) return explicit;
		if (!cwd || isSandboxContainerPath(cwd)) return undefined;

		// Goal/team sessions often pass a host worktree cwd without worktreeOpts.
		// Prefer the goal's stable repo/worktree metadata when available.
		if (goalId) {
			const goal = this.resolveGoal(goalId);
			const goalCwd = goal?.cwd || cwd;
			const goalWorktreeOffset = relativeSandboxCwdOffset(goal?.worktreePath, goalCwd);
			if (goalWorktreeOffset) return goalWorktreeOffset;
			const goalRepoOffset = relativeSandboxCwdOffset(goal?.repoPath, goalCwd);
			if (goalRepoOffset) return goalRepoOffset;
		}

		try {
			if (await isGitRepo(cwd)) {
				const repoRoot = await getRepoRoot(cwd);
				const repoOffset = relativeSandboxCwdOffset(repoRoot, cwd);
				if (repoOffset) return repoOffset;
			}
		} catch {
			// Fall back to project-root containment below.
		}

		if (projectId && this.projectContextManager) {
			const project = this.projectContextManager.getOrCreate(projectId)?.project;
			const projectRoot = project?.rootPath;
			if (projectRoot) {
				try {
					if (await isGitRepo(projectRoot)) {
						const repoRoot = await getRepoRoot(projectRoot);
						const repoOffset = relativeSandboxCwdOffset(repoRoot, cwd);
						if (repoOffset) return repoOffset;
					}
				} catch {
					// Project may be non-git; project-relative offset still works for /workspace.
				}
				const projectOffset = relativeSandboxCwdOffset(projectRoot, cwd);
				if (projectOffset) return projectOffset;
			}
		}

		return undefined;
	}

	private readGatewayUrlForAgent(): string | undefined {
		try {
			return fs.readFileSync(path.join(bobbitStateDir(), "gateway-url"), "utf-8").trim() || undefined;
		} catch {
			return undefined;
		}
	}

	private mintScopedGatewayToken(projectId: string | undefined, sessionId: string, goalId?: string): string | undefined {
		if (!projectId || !this.sandboxTokenStore) return undefined;
		const scopedToken = this.sandboxTokenStore.register(projectId);
		this.sandboxTokenStore.addSession(projectId, sessionId);
		if (goalId) this.sandboxTokenStore.addGoal(projectId, goalId);
		return scopedToken;
	}

	private applyScopedGatewayCredentials(
		bridgeOptions: RpcBridgeOptions,
		sessionId: string,
		projectId: string | undefined,
		goalId?: string,
	): void {
		const gwUrl = this.readGatewayUrlForAgent();
		if (gwUrl) bridgeOptions.gatewayUrl = gwUrl;
		const scopedToken = this.mintScopedGatewayToken(projectId, sessionId, goalId ?? bridgeOptions.env?.BOBBIT_GOAL_ID);
		if (scopedToken) bridgeOptions.gatewayToken = scopedToken;
	}

	private scopedGatewayEnvForDirectAgent(sessionId: string, projectId: string | undefined, goalId?: string): Record<string, string> | undefined {
		const env: Record<string, string> = {};
		const gwUrl = this.readGatewayUrlForAgent();
		if (gwUrl) env.BOBBIT_GATEWAY_URL = gwUrl;
		const scopedToken = this.mintScopedGatewayToken(projectId, sessionId, goalId);
		if (scopedToken) env.BOBBIT_TOKEN = scopedToken;
		return Object.keys(env).length > 0 ? env : undefined;
	}

	/**
	 * Apply Docker sandbox wiring to bridge options.
	 * Shared by createSession(), restoreSession(), and createDelegateSession().
	 * Returns true if sandbox was applied, false if sandbox is not configured.
	 *
	 * With the new per-project sandbox architecture, this:
	 * - Gets the ProjectSandbox for the project
	 * - Gets the container ID
	 * - Sets up credentials and token (one per project, not per session)
	 * - Sets bridgeOptions.containerId
	 * - The CWD is the container-internal worktree path (set by caller or /workspace)
	 */
	private async applySandboxWiring(
		bridgeOptions: RpcBridgeOptions,
		sessionId: string,
		opts?: SandboxWiringOptions,
	): Promise<boolean> {
		// Resolve project ID before reading sandbox config. The selected project's
		// config is authoritative; the server/HQ store is only a legacy fallback for
		// genuinely unscoped callers.
		const projectId = opts?.projectId;
		if (!projectId) {
			throw new Error("Sandbox mode requires a projectId");
		}
		if (isSandboxExemptProject(projectId)) {
			bridgeOptions.sandboxed = false;
			delete bridgeOptions.containerId;
			return false;
		}

		const projectContext = this.projectContextManager?.getOrCreate(projectId) ?? null;
		const projectConfigStore = projectContext?.projectConfigStore ?? this.projectConfigStore;
		if (!projectConfigStore) return false;
		const sandboxConfig = projectConfigStore.get("sandbox") || "none";
		if (sandboxConfig !== "docker") return false;

		// Get the ProjectSandbox for this project
		if (!this.sandboxManager) {
			throw new Error("Sandbox mode requires SandboxManager — not initialized");
		}
		// Lazy per-project init — idempotent. Handles restore paths and any call site
		// that reached wiring without going through the explicit session-setup /
		// goals / staff entry points.
		await this.sandboxManager.ensureForProject(projectId);
		const sandbox = this.sandboxManager.get(projectId);
		if (!sandbox) {
			throw new Error(`No sandbox initialized for project ${projectId}`);
		}

		const containerId = await sandbox.getContainerId();

		// Read gateway URL and generate scoped token for the container.
		const gwUrl = this.readGatewayUrlForAgent();
		if (!gwUrl) throw new Error("Cannot read gateway credentials for sandbox: gateway-url not found");
		bridgeOptions.gatewayUrl = gwUrl;
		const scopedToken = this.mintScopedGatewayToken(projectId, sessionId, opts?.goalId ?? bridgeOptions.env?.BOBBIT_GOAL_ID);
		if (scopedToken) {
			bridgeOptions.gatewayToken = scopedToken;
		} else {
			// Legacy/test harnesses may omit SandboxTokenStore; keep sandbox behavior
			// unchanged there. Direct agents never use this admin fallback.
			const adminToken = readToken();
			if (adminToken === null) {
				throw new Error("Cannot read gateway credentials for sandbox");
			}
			bridgeOptions.gatewayToken = adminToken;
		}

		bridgeOptions.sandboxed = true;
		bridgeOptions.containerId = containerId;
		const projectRootPath = projectContext?.project.rootPath;
		if (projectRootPath) {
			bridgeOptions.projectMarketPacksRoot = path.join(projectRootPath, ".bobbit", "config", "market-packs");
		}

		// Create a worktree inside the container when a branch is specified.
		// This is the primary code path for goal agents (team lead + members).
		// Headquarters is always no-worktree, so ignore any legacy sandboxBranch.
		if (opts?.sandboxBranch && projectId !== HEADQUARTERS_PROJECT_ID) {
			// Capture the HOST-side working directory BEFORE it is remapped into the
			// container worktree below. The `goalProvisioned` provider runs HOST-side
			// (LifecycleHub.dispatchGoalProvisioned executes the provider module on
			// the host with `workingDir: ctx.cwd`), so it must be handed a host
			// filesystem path it can actually write to. The container worktree
			// (`/workspace-wt/<branch>`) lives in a Docker volume and is NOT reachable
			// from the host — passing it made the marker write silently no-op (the
			// hook is non-fatal), so metadata-driven filesystem treatments never
			// landed on sandboxed worktrees. For session-setup-provisioned sandbox
			// sessions this is the session's host worktree cwd; for team members /
			// delegates it is the goal's host worktree cwd they were created with.
			const hostWorktreeCwd = bridgeOptions.cwd;
			try {
				const worktreePath = await sandbox.createWorktree(
					opts.sandboxBranch,
					opts.sandboxBranch,
					opts.sandboxBaseBranch,
				);
				// Agent runtime cwd → the container worktree (offset applied). The
				// agent boots here; only the host-side provider dispatch below uses
				// host coordinates.
				bridgeOptions.cwd = applySandboxCwdOffset(worktreePath, opts.sandboxCwdOffset);
				// Fire the `goalProvisioned` lifecycle hook for the freshly provisioned
				// sandbox worktree. team-manager skips its own dispatch for sandboxed
				// members (no host worktreeResult), and the session-setup provisioning
				// dispatch never runs for these container worktrees — so without this,
				// metadata-driven filesystem treatments would be missing on every
				// sandboxed team lead / member worktree. We dispatch with HOST
				// coordinates (`hostWorktreeCwd`), NOT the container path, so the
				// host-side provider can write its marker files. Skipped when there is
				// no usable host path — restore / respawn paths arrive with
				// `bridgeOptions.cwd` already pointing at a container-internal path
				// (`/workspace-wt/...`); the worktree was provisioned on first creation
				// and providers are idempotent, so a re-dispatch is unnecessary (and
				// would just no-op host-side).
				if (hostWorktreeCwd && !isSandboxContainerPath(hostWorktreeCwd)) {
					await this.dispatchGoalProvisionedForWorktree({
						goalId: opts.goalId,
						projectId,
						worktreePath: hostWorktreeCwd,
						cwd: hostWorktreeCwd,
						branch: opts.sandboxBranch,
					});
				}
			} catch (err) {
				if (!isUnresolvedHeadWorktreeError(err) || opts.sandboxBaseBranch || opts.goalId) throw err;
				console.warn(`[session-manager] ${err.message}; running sandbox session ${sessionId} without a worktree in /workspace`);
				bridgeOptions.cwd = applySandboxCwdOffset("/workspace", opts.sandboxCwdOffset);
			}
		} else if (!isSandboxContainerPath(bridgeOptions.cwd)) {
			// Regular no-worktree sessions run from the project clone in /workspace.
			bridgeOptions.cwd = applySandboxCwdOffset("/workspace", opts?.sandboxCwdOffset);
		}

		// Resolve sandbox tokens from unified config (with legacy fallback)
		// Get project-scoped config/secrets when available.
		const secretsStore = projectContext?.secretsStore ?? null;
		bridgeOptions.sandboxCredentials = resolveSandboxTokens(this.preferencesStore, projectConfigStore, secretsStore);
		const sandboxTokenEntries = projectConfigStore?.getSandboxTokens() ?? [];
		const sandboxAuthPolicy = resolveSandboxAgentAuthPolicy(sandboxTokenEntries);
		ensureSandboxAgentAuthFile({
			prefs: this.preferencesStore,
			includeCodexAuth: sandboxAuthPolicy.includeCodexAuth,
			includeGoogleAuth: sandboxAuthPolicy.includeGoogleAuth,
			scope: opts?.projectId,
		});

		return true;
	}

	/** Get a CostTracker for a specific project. Requires explicit projectId when PCM is active. */
	getCostTracker(projectId?: string): CostTracker {
		if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (ctx) return ctx.costTracker;
		}
		if (this._testCostTracker) return this._testCostTracker;
		if (this.projectContextManager) {
			throw new Error("Cannot resolve cost tracker: projectId is required");
		}
		throw new Error("No cost tracker available");
	}

	/** Return persisted cumulative cost for a session, without creating a zero-cost record. */
	getSessionCost(sessionId: string): SessionCost | undefined {
		const live = this.sessions.get(sessionId);
		if (live) {
			try {
				const cost = this.resolveCostTracker(live).getSessionCost(sessionId);
				if (cost) return cost;
			} catch {
				// Fall through to persisted/store scans below.
			}
		}

		const persisted = this.getPersistedSession(sessionId);
		if (persisted?.projectId || !this.projectContextManager) {
			try {
				const cost = this.getCostTracker(persisted?.projectId).getSessionCost(sessionId);
				if (cost) return cost;
			} catch {
				// Fall through to cross-project scan.
			}
		}

		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				const cost = ctx.costTracker.getSessionCost(sessionId);
				if (cost) return cost;
			}
		}
		return undefined;
	}

	/** Merge authoritative persisted cost into a state snapshot when cost exists. */
	withSessionCostInState(sessionId: string, data: unknown): unknown {
		const cost = this.getSessionCost(sessionId);
		if (!cost) return data;
		if (data && typeof data === "object" && !Array.isArray(data)) {
			return { ...(data as Record<string, unknown>), serverCost: cost };
		}
		return { serverCost: cost };
	}

	/** Build the cumulative cost_update payload used for attach/reconnect hydration. */
	getSessionCostUpdate(sessionId: string): Extract<ServerMessage, { type: "cost_update" }> | null {
		const cost = this.getSessionCost(sessionId);
		if (!cost) return null;
		const live = this.sessions.get(sessionId);
		const persisted = live ? undefined : this.getPersistedSession(sessionId);
		return {
			type: "cost_update",
			sessionId,
			goalId: live?.goalId ?? persisted?.goalId,
			taskId: this.resolveTaskIdForSession(sessionId),
			cost,
		};
	}

	/** Broadcast cumulative persisted cost to connected clients, if this session has cost data. */
	broadcastSessionCost(session: SessionInfo): void {
		const update = this.getSessionCostUpdate(session.id);
		if (update) broadcast(session.clients, update);
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
		const live = this.sessions.get(sessionId);
		if (live?.taskId) return live.taskId;
		const persisted = this.getPersistedSession(sessionId);
		if (persisted?.taskId) return persisted.taskId;
		if (this.projectContextManager) {
			const gen = this.projectContextManager.getTaskGeneration();
			const cached = this.taskIdCache.get(sessionId);
			if (cached && cached.gen === gen) return cached.taskId;

			let taskId: string | undefined;
			for (const ctx of this.projectContextManager.all()) {
				const tm = new TaskManager(ctx.taskStore);
				const tasks = tm.getTasksForSession(sessionId);
				if (tasks.length > 0) { taskId = tasks[0].id; break; }
			}
			this.taskIdCache.set(sessionId, { taskId, gen });
			return taskId;
		}
		const tasks = this._testTaskManager?.getTasksForSession(sessionId) ?? [];
		return tasks.length > 0 ? tasks[0].id : undefined;
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
		if (this.toolManager && !parts.toolDocs) {
			parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir());
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
			parts.dynamicContext = session.promptParts?.dynamicContext;
			if (this.toolManager && !parts.toolDocs) {
				parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir());
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
				projectConfigStore: this.projectConfigStore,
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
				projectConfigStore: this.projectConfigStore,
				sectionOrder,
				promptProfile: (session.nonInteractive ?? persisted?.nonInteractive) ? "reviewer" : undefined,
			};
		}

		if (this.toolManager && !parts.toolDocs) {
			parts.toolDocs = this.toolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir());
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
		/** Original text was already expanded into this when sent to the model. */
		modelText?: string;
		/** Resolved slash-skill expansions, in original-text order. UI-only metadata. */
		skillExpansions?: SkillExpansion[];
		/** Resolved `@path` file mentions (all kinds), in original-text order. UI-only metadata. */
		fileMentions?: FileMention[];
		/** Provenance of this prompt. Defaults to "user". Read by TeamManager
		 *  on agent_start to decide whether to reset idle-nudge backoff counters. */
		source?: PromptSource;
		/** Dispatch against a possibly-cold (freshly-restored) agent: the direct
		 *  dispatch waits for readiness and uses a generous prompt timeout via
		 *  RpcBridge.promptWhenReady, so the boot-resume nudge actually lands
		 *  instead of timing out on the default 30s. */
		coldStart?: boolean;
	}): Promise<{ status: "dispatched" | "queued" }> {
		let session = this.sessions.get(sessionId);
		if (!session) return { status: "queued" };

		// REVIVE-WINDOW JOIN (CS-R2 follow-up). A prompt that arrives while the
		// session is dormant/terminated/fenced — or while an `addClient` dormant
		// revive (or any other restore) is already in flight — must NOT be queued on
		// the stale `SessionInfo`. The coalesced restore replaces that object with a
		// fresh one (new PromptQueue(ps.messageQueue), new EventBuffer), so a row
		// queued here would be dropped and never dispatched (doc-04 F2e split-brain /
		// F7 stranded-prompt shape). Instead, JOIN the coalesced restore (it starts
		// one or joins the in-flight one), then re-read the canonical revived session
		// and dispatch against it via the normal path below.
		const restoreInFlight = this._restoreCoordinators.has(sessionId);
		const inReviveWindow = restoreInFlight
			|| session.status === "terminated"
			|| session.dormant === true
			|| session.lifecycleFenced === true;
		if (inReviveWindow) {
			const ps = this.resolveStoreForId(sessionId)?.get(sessionId);
			if (ps && ps.agentSessionFile) {
				// Coalesces: joins an in-flight restore or starts the single restore.
				await this._restoreSessionCoalesced(ps);
				const revived = this.sessions.get(sessionId);
				if (!revived) return { status: "queued" };
				session = revived;
			} else if (restoreInFlight) {
				// No restorable record of our own, but a restore is already running for
				// this session — join it rather than acting on the stale object.
				await this._restoreCoordinators.get(sessionId)?.promise;
				const revived = this.sessions.get(sessionId);
				if (!revived) return { status: "queued" };
				session = revived;
			}
			// Otherwise (terminated/dormant with no restorable transcript): fall
			// through to the existing non-idle path, which queues on the current
			// object — unchanged behavior for genuinely unrevivable sessions.
		}

		session.lastPromptSource = opts?.source ?? "user";

		// CLF-W1b/W3 — F14 thinking-level router. Consulted once per
		// `enqueuePrompt` call (the single pre-dispatch funnel design doc §3
		// names — direct/queued/extension/steer paths all converge here), on the
		// user's verbatim `text` (never `dispatchText`, since the keyword rules
		// describe user intent, not model-facing/expanded content). The returned
		// Decision is ALWAYS recorded into the transparency trace by
		// `dispatchDecision` itself (`ContextTraceStore.appendDecision`).
		// Fail-open/non-fatal: absence of a hub, an unregistered (point,kind)
		// pair (e.g. a bare test `LifecycleHub` that never wired the router), or
		// any classifier error must never block a prompt from dispatching — see
		// design doc §6.1 (advisory kinds default fail-open).
		// Guarded HERE (not inside the helper): when there is no hub at all —
		// true for the overwhelming majority of today's tests and any deployment
		// that never wires one — this must introduce ZERO extra microtask ticks
		// before the pre-existing synchronous fast path (idle+empty direct
		// dispatch) reaches `rpcClient.prompt()`. `await`ing a promise always
		// yields at least once even if the awaited async function resolves
		// synchronously, so the guard has to live outside the `await`, not just
		// inside it.
		let thinkingRouterDecision: Decision<ThinkingLevel> | undefined;
		if (this.lifecycleHub) {
			// CLF-W3 apply mode: whether we WILL apply a `select` is decided here,
			// from the mode flag + precedence (role/user-pinned) ONLY — never from
			// the classifier's actual choice, which doesn't exist yet. Passed into
			// the consult so the recorded outcome's `applied` field matches what
			// we're about to do below. Observe mode (absent/"observe") always
			// resolves `canApplyThinking` to `false`, keeping this byte-identical
			// to CLF-W1b when the flag isn't set.
			const canApplyThinking = isThinkingRouterApplyMode() && this.canApplyThinkingRouterDecision(session);
			thinkingRouterDecision = await this.consultThinkingRouterHub(session, text, canApplyThinking);
			if (canApplyThinking && thinkingRouterDecision?.kind === "select") {
				try {
					// Clamp against the session's CURRENT bound model before applying —
					// same defense-in-depth every other live setThinkingLevel call site
					// uses (ws/handler.ts's set_thinking_level, tryApplyDefaultThinkingLevel)
					// so a classifier "xhigh" select degrades gracefully on a model that
					// doesn't support it instead of sending an unsupported level to the
					// runtime. Falls back to the raw choice when no model is known yet.
					const baseline = session.thinkingRouterAppliedBaseline ?? this.resolveCurrentThinkingRouterBaseline(session);
					const levelToApply = this.clampThinkingLevelForSession(session, thinkingRouterDecision.choice);
					await session.rpcClient.setThinkingLevel(levelToApply);
					session.thinkingRouterAppliedBaseline = baseline;
					console.log(`[session-manager] CLF-W3 thinking-router APPLIED "${levelToApply}" for session ${session.id} (turn-scoped, not persisted)`);
				} catch (err) {
					console.warn(`[session-manager] CLF-W3 thinking-router apply failed for ${session.id} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
				}
			} else if (session.thinkingRouterAppliedBaseline && isThinkingRouterApplyMode()) {
				if (canApplyThinking) {
					await this.restoreThinkingRouterAppliedBaseline(session);
				} else {
					this.clearThinkingRouterAppliedBaseline(session);
				}
			}
		}
		// Stamped onto the QueuedMessage row at BOTH enqueue call sites below
		// (the queued-path fix) — data-only, read by no code yet.
		const thinkingDecisionStamp: QueuedMessage["thinkingDecision"] = thinkingRouterDecision
			? { decision: thinkingRouterDecision, classifierId: THINKING_ROUTER_CLASSIFIER_ID, ts: Date.now() }
			: undefined;

		// modelText is what the model sees; text is the user's verbatim input.
		// When no expansions, both are equal and dispatch is byte-equal to today.
		// Synthesize a non-blank body for attachment-only prompts (image-only OR
		// non-image-attachment-only) so the model never receives a blank
		// ContentBlock. Applied here at the single dispatch boundary so EVERY
		// downstream path inherits valid text: direct dispatch, the persisted
		// queue row (drainQueue), the error-recovery prefix, and retry (via
		// dispatchDirectPrompt → session.lastPromptText). Non-blank text and
		// no-attachment prompts pass through unchanged. See
		// synthesizeAttachmentText for the exact rule.
		const dispatchText = synthesizeAttachmentText(opts?.modelText ?? text, opts?.images, opts?.attachments);
		const hasSkillExpansions = !!(opts?.skillExpansions && opts.skillExpansions.length > 0);
		const hasFileMentions = !!(opts?.fileMentions && opts.fileMentions.length > 0);
		if (hasSkillExpansions || hasFileMentions) {
			appendSkillSidecarEntry(session.id, {
				ts: Date.now(),
				modelText: dispatchText,
				originalText: text,
				skillExpansions: opts?.skillExpansions ?? [],
				...(hasFileMentions ? { fileMentions: opts!.fileMentions! } : {}),
			});
			// Stash the envelope so when the agent echoes the user message
			// back via `message_end`, we can splice the original text +
			// chip metadata onto the broadcast event before clients see it.
			if (!session.pendingSkillExpansions) session.pendingSkillExpansions = [];
			session.pendingSkillExpansions.push({
				modelText: dispatchText,
				originalText: text,
				skillExpansions: opts?.skillExpansions ?? [],
				...(hasFileMentions ? { fileMentions: opts!.fileMentions! } : {}),
			});
		}

		// ERROR STATE GATING: if last turn errored, either implicitly unstick
		// (up to MAX_CONSECUTIVE_ERROR_TURNS) or park the message in the queue.
		if (session.lastTurnErrored) {
			const consec = session.consecutiveErrorTurns ?? 0;

			// Always cancel any pending auto-retry timer when a new user prompt
			// arrives — regardless of whether we're about to park (cap reached)
			// or implicitly unstick. A parked prompt at the cap must not leave a
			// retry banner/timer running, since the user has signalled fresh intent
			// and the next action will be an explicit Retry click or fix upstream.
			this.cancelPendingAutoRetry(session, "new-prompt");

			if (consec >= MAX_CONSECUTIVE_ERROR_TURNS) {
				// Cap reached — park. Human must click Retry (or fix upstream) to drain.
				console.log(
					`[session-manager] Session ${session.id} has ${consec} consecutive errored turns; parking incoming prompt. Human action required (click Retry or fix upstream issue).`
				);
				session.promptQueue.enqueue(dispatchText, {
					images: opts?.images,
					attachments: opts?.attachments,
					isSteered: opts?.isSteered,
					thinkingDecision: thinkingDecisionStamp,
				});
				this.broadcastQueue(session);
				return { status: "queued" };
			}

			// Implicit unstick — new intent supersedes the failed turn.
			const errSnippet = (session.lastTurnErrorMessage || "").slice(0, 200);
			// Capture BEFORE clearing — decides whether the prior turn poisoned
			// the live history with a blank ContentBlock (image/attachment-only).
			const poisonedByBlankText = isBlankContentBlockError(session.lastTurnErrorMessage);
			console.log(
				`[session-manager] Session ${session.id} implicit unstick from enqueuePrompt (consecutiveErrorTurns=${consec}). Error: ${errSnippet}`
			);

			// A fresh prompt supersedes any recovered dispatch-time copy of the
			// failed prompt. Drop it before dispatching the new intent so a later
			// agent_end drain cannot replay stale work after the follow-up succeeds.
			this.consumeRecoveredPromptDispatchRows(session);

			// Clear error state. Do NOT reset consecutiveErrorTurns — that only
			// resets on a SUCCESSFUL message_end or an explicit retryLastPrompt.
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.turnHadToolCalls = false;
			session.transientRetryAttempts = 0;

			// Title generation uses the user-visible original text (better UX).
			this.tryGenerateTitleFromPrompt(sessionId, text);

			// Blank-text poison: the live process's in-memory history still holds
			// the committed blank ContentBlock, so dispatching this follow-up to
			// the SAME process would replay it and re-fail. Respawn so the agent
			// rehydrates from the sanitized transcript, then dispatch the
			// follow-up against clean history (no recovery prefix needed — the
			// poisoned turn is gone). Falls through to the normal prefixed path
			// when there's no persisted transcript to rehydrate from.
			if (poisonedByBlankText) {
				const recovered = await this._recoverBlankTextPoison(session);
				if (recovered) {
					// We know the prior turn carried attachment/image content (it
					// poisoned on a blank ContentBlock). If this follow-up's own
					// dispatch text is blank (e.g. a legacy attachment-only retry
					// where attachments aren't tracked on SessionInfo), fall back to
					// the synthetic phrase so we never re-send blank/invalid content.
					const recoverText = dispatchText.trim() === "" ? ATTACHMENT_ONLY_TEXT : dispatchText;
					await this.dispatchDirectPrompt(recovered, recoverText, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart);
					return { status: "dispatched" };
				}
			}

			// Dispatch the prefixed new message immediately, ahead of any parked
			// items. After agent_end the normal drainQueue path picks up parked
			// items in FIFO order, unprefixed (since lastTurnErrorMessage is now
			// cleared).
			// Inject the recovery prefix into the model-facing dispatch text.
			const prefixedDispatch = buildErrorRecoveryPrefix(errSnippet, dispatchText);
			await this.dispatchDirectPrompt(session, prefixedDispatch, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart);
			return { status: "dispatched" };
		}

		// If agent is idle and queue is empty, dispatch directly. Mark streaming
		// before awaiting rpcClient.prompt(): Pi 0.77 OpenAI/Codex preflight can be
		// slow, and clients/API polling must see the turn as in-flight immediately.
		if (session.status === "idle" && session.promptQueue.isEmpty) {
			this.tryGenerateTitleFromPrompt(sessionId, text);
			await this.dispatchDirectPrompt(session, dispatchText, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart);
			return { status: "dispatched" };
		}

		// Agent is busy or queue has items — enqueue. Persisted queue holds
		// the dispatch (model-facing) text so drainQueue passes the same
		// expanded text to the agent later. The chip metadata is already
		// in the sidecar/broadcast; the queued row is purely for delivery.
		session.promptQueue.enqueue(dispatchText, {
			images: opts?.images,
			attachments: opts?.attachments,
			isSteered: opts?.isSteered,
			thinkingDecision: thinkingDecisionStamp,
		});
		this.broadcastQueue(session);

		// If agent is idle, start draining the queue (bug fix: idle + non-empty queue)
		if (session.status === "idle") {
			this.drainQueue(session);
		}
		return { status: "queued" };
	}

	/**
	 * Deliver a live steer to a streaming session.
	 *
	 * Before calling rpcClient.steer(), aborts any in-flight `bash_bg wait`
	 * HTTP handlers for this session so the agent is not stuck inside a
	 * tool call while the steer is queued on the SDK side. The bg processes
	 * themselves are left running untouched.
	 *
	 * Returns the underlying rpcClient.steer() promise so callers can await
	 * or attach their own error handler.
	 */
	deliverLiveSteer(sessionId: string, message: string, opts?: { source?: PromptSource }): Promise<unknown> {
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.reject(new Error(`Session ${sessionId} not found`));
		session.lastPromptSource = opts?.source ?? "user";

		// ERROR STATE GATING: same cap as enqueuePrompt. Idle-but-errored means
		// there is no live turn to inject into, so we either dispatch a regular
		// prefixed prompt (unstick) or park the steer in the queue (cap).
		if (session.lastTurnErrored) {
			const consec = session.consecutiveErrorTurns ?? 0;
			if (consec >= MAX_CONSECUTIVE_ERROR_TURNS) {
				console.log(
					`[session-manager] Session ${sessionId} has ${consec} consecutive errored turns; parking live-steer. Human action required.`
				);
				// Persist to promptQueue so it survives Stop/Retry. drainQueue will
				// pick it up after user Retry.
				const queued = session.promptQueue.enqueue(message, { isSteered: true });
				this.broadcastQueue(session);
				return Promise.resolve({ queued: true, parked: true, id: queued.id });
			}

			const errSnippet = (session.lastTurnErrorMessage || "").slice(0, 200);
			console.log(
				`[session-manager] Session ${sessionId} implicit unstick from deliverLiveSteer (consecutiveErrorTurns=${consec}). Error: ${errSnippet}`
			);
			// enqueuePrompt handles its own state-clear + pending-timer cancel +
			// prefix application; we just route through it with the raw message.
			return this.enqueuePrompt(sessionId, message, { isSteered: true, source: opts?.source });
		}

		// Happy path: enqueue then dispatch via the single _dispatchSteer site.
		// _dispatchSteer removes the row from promptQueue *before* awaiting the
		// RPC and persists an in-flight ledger for restart durability until echo.
		const queued = session.promptQueue.enqueue(message, { isSteered: true });
		this.broadcastQueue(session);
		return this._dispatchSteer(session, [queued]);
	}

	/**
	 * Promote a queued message to steered priority.
	 * If the agent is streaming, dispatch the current steered front group through
	 * the same live-steer path as a fresh steer so user intent is observed on the
	 * current turn instead of waiting for a later tool boundary or agent_end.
	 */
	steerQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.steer(messageId);
		if (!ok) return false;

		if (session.status === "streaming") {
			const steered = session.promptQueue.dequeueAllSteered();
			void this._dispatchSteer(session, steered).catch(() => {});
			return true;
		}

		this.broadcastQueue(session);
		if (session.status === "idle") this.drainQueue(session);
		return true;
	}

	/**
	 * Single dispatch site for steered prompts. Removes rows from promptQueue
	 * *before* awaiting rpcClient.steer() and persists an in-flight ledger so
	 * restart can recover the dispatch→echo window. On RPC failure, rows are
	 * re-enqueued at the front in original order (steered group still sorts
	 * first via PromptQueue.reorder()).
	 *
	 * Tool-boundary callers may pre-pop rows with dequeueAllSteered() — in
	 * that case remove() is a no-op (returns false), broadcastQueue stays
	 * idempotent.
	 */
	private async _dispatchSteer(session: SessionInfo, rows: QueuedMessage[]): Promise<void> {
		if (rows.length === 0) return;
		const bg = (this as any).bgProcessManager;
		if (bg) bg.abortAllWaits(session.id);
		const batchText = rows.map(r => r.text).join("\n");

		// Record on the shadow ledger BEFORE persisting queue removal. The store
		// update below writes both the now-empty promptQueue slice and this ledger
		// entry together, so a restart after dispatch but before the transcript
		// echo can restore/re-enqueue the steer exactly once.
		//
		// On RPC failure we splice this exact entry back out and re-enqueue
		// the rows at front of promptQueue, so the next drain redispatches.
		if (!session.inFlightSteerTexts) session.inFlightSteerTexts = [];
		session.inFlightSteerTexts.push(batchText);
		for (const r of rows) session.promptQueue.remove(r.id);
		this.broadcastQueue(session, { includeInFlightSteers: true });
		try {
			const steerResp = await session.rpcClient.steer(batchText);
			if ((steerResp as any)?.success === false) {
				throw new Error((steerResp as any)?.error || "steer rejected");
			}
		} catch (err) {
			// Splice this entry from the ledger only if this catch path still owns
			// it. Abort/restart reconciliation can drain the same ledger while the
			// steer RPC is pending; in that case the row has already been recovered
			// exactly once and must not be enqueued again here.
			const lidx = session.inFlightSteerTexts.lastIndexOf(batchText);
			if (lidx !== -1) {
				session.inFlightSteerTexts.splice(lidx, 1);
				for (const r of [...rows].reverse()) {
					session.promptQueue.enqueueAtFront(r.text, { isSteered: true });
				}
				this.broadcastQueue(session, { includeInFlightSteers: true });
				// A steer rejection can race with abort settlement: agent_end may have
				// already broadcast idle and run its one drain before this catch puts the
				// row back. Redrain immediately in that settled-idle case so the recovered
				// steer is not parked until the next user prompt.
				if (session.status === "idle" && !session.lastTurnErrored) this.drainQueue(session);
			} else {
				this.persistInFlightSteerLedger(session);
				console.warn(`[session-manager] _dispatchSteer failed for ${session.id} after in-flight ledger was already reconciled; not re-enqueueing duplicate steer`);
			}
			console.error(`[session-manager] _dispatchSteer failed for ${session.id}:`, err);
			throw err;
		}
	}

	/**
	 * Splice an entry from the shadow ledger when its echo arrives.
	 * Matches the SDK's text-match removal at agent-session.js:265-280:
	 * find the first index whose text equals the user-message body, splice it.
	 * Silent no-op for non-matching messages (regular prompts, follow-ups,
	 * skill-expansion echoes whose body has been rewritten).
	 */
	private _consumeSteerEcho(session: SessionInfo, event: any): void {
		const ledger = session.inFlightSteerTexts;
		if (!ledger || ledger.length === 0) return;
		if (event.type !== "message_end") return;
		if (event.message?.role !== "user") return;
		const text = extractUserMessageText(event.message);
		if (!text) return;
		const idx = ledger.indexOf(text);
		if (idx !== -1) {
			ledger.splice(idx, 1);
			this.persistInFlightSteerLedger(session);
		}
	}

	/**
	 * Drain the shadow ledger and re-enqueue any unresolved steers at the
	 * front of promptQueue as steered rows. Called after restore and from
	 * abort-reconciliation paths where a steer the SDK accepted may never echo
	 * because the turn was torn down. The next drainQueue picks the rows up as
	 * a steered batch via `_dispatchSteer`, redispatching exactly once.
	 */
	private _reconcileInFlightSteers(session: SessionInfo): void {
		const ledger = session.inFlightSteerTexts;
		if (!ledger || ledger.length === 0) return;
		for (const text of [...ledger].reverse()) {
			session.promptQueue.enqueueAtFront(text, { isSteered: true });
		}
		ledger.length = 0;
		this.broadcastQueue(session, { includeInFlightSteers: true });
	}

	private _reconcileAfterAbort(session: SessionInfo): void {
		this._reconcileInFlightSteers(session);
	}

	/** Reorder queued messages to match the given ID list. */
	reorderQueue(sessionId: string, messageIds: string[]): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.promptQueue.reorderByIds(messageIds);
		this.broadcastQueue(session);
	}

	/** Remove a queued message. */
	removeQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.remove(messageId);
		if (ok) this.broadcastQueue(session);
		return ok;
	}

	private markPromptDispatchStreaming(session: SessionInfo): void {
		session.streamingStartedAt = session.streamingStartedAt ?? Date.now();
		this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
		broadcastStatus(session, "streaming", { streamingStartedAt: session.streamingStartedAt });
	}

	private applyDirectProviderEnv(bridgeOptions: RpcBridgeOptions, sandboxed: boolean | undefined, provider?: string): void {
		if (sandboxed) return;
		bridgeOptions.env = mergeHostAgentProviderEnv(bridgeOptions.env, this.preferencesStore, {
			provider,
			model: bridgeOptions.initialModel,
			providers: fallbackProviderAllowlistFromPrefs(this.preferencesStore),
		});
	}

	private safeDispatchError(session: SessionInfo, reason: string): Error {
		const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
		return new Error(redactDispatchFailureReason(reason, isProviderAuthFailure(reason), persistedProvider));
	}

	private surfaceProviderAuthFailure(session: SessionInfo, reason: string, source: string): void {
		const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
		const provider = providerFromAuthFailure(reason, persistedProvider);
		const label = providerLabel(provider);
		session.streamingStartedAt = undefined;
		session.recoverDrainAttempts = 0;
		this.resolveStoreForSession(session.id).update(session.id, {
			wasStreaming: false,
			streamingStartedAt: undefined,
		});
		broadcastStatus(session, "idle");
		this.resolveIdleWaiters(session.id);
		emitSessionEvent(session, {
			type: "provider_auth_required",
			provider,
			source,
			reason: "missing-api-key",
			diagnostic: `${label} credentials are missing or invalid.`,
			message: `${label} API key is missing. Add or fix the API key in Settings, switch provider, then retry or abort/respawn the agent.`,
			actions: [
				{ type: "open_settings", label: "Fix API key in Settings" },
				{ type: "retry", label: "Retry after fixing credentials" },
				{ type: "switch_provider", label: "Switch provider" },
				{ type: "abort_respawn", label: "Abort/respawn agent" },
			],
		});
	}

	private maybeAutoRetryPromptDeliveryFailure(session: SessionInfo, reason: string, source: string): boolean {
		if (!reason || isNonRetryableAgentError(reason)) return false;
		const isRetryable = isProviderBackoffError(reason) || isTransientReviewError(reason) || isRetryableGenericAgentError(reason);
		if (!isRetryable) return false;

		// The agent rejected the prompt before it could emit an assistant
		// message_end, so synthesize the same error state that message_end would
		// have established. The failed prompt never reached agent_start, so no
		// tools ran in that turn; clear any stale flag from a previous turn so
		// retryLastPrompt(auto:true) re-sends the recovered prompt instead of a
		// mid-work continuation. The recovered queue row remains the single
		// durable copy of the prompt; retryLastPrompt(auto:true) consumes it
		// before dispatching so a later agent_end cannot replay it a second time.
		session.lastTurnErrored = true;
		session.lastTurnErrorMessage = reason;
		session.turnHadToolCalls = false;
		session.consecutiveErrorTurns = (session.consecutiveErrorTurns ?? 0) + 1;
		const scheduled = this.maybeAutoRetryTransient(session);
		if (scheduled) {
			console.log(`[session-manager] ${source} dispatch for ${session.id} failed with retryable delivery error; auto-retry scheduled. Error: ${reason.slice(0, 200)}`);
		} else {
			console.warn(`[session-manager] ${source} dispatch for ${session.id} exhausted retryable delivery auto-retries; leaving recovered row queued for manual Retry. Error: ${reason.slice(0, 200)}`);
		}
		return true;
	}

	private recoverPromptDispatch(session: SessionInfo, rows: Array<{
		text: string;
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
	}>, reason: string, source: string): void {
		if (!this._sessionWriterIsCurrent(session)) return;
		const providerAuthFailure = isProviderAuthFailure(reason);
		const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
		const safeReason = redactDispatchFailureReason(reason, providerAuthFailure, persistedProvider);
		const processExited = /(?:agent process exited|process_exit)/i.test(reason);
		if (session.status === "terminated" || (session.status === "aborting" && processExited)) {
			console.warn(`[session-manager] ${source} dispatch failed for ${session.id} (${safeReason}); not recovering ${rows.length} row(s) because session is ${session.status}`);
			return;
		}

		console.warn(`[session-manager] ${source} dispatch failed for ${session.id} (${safeReason}); re-enqueueing ${rows.length} row(s) at front`);
		// Re-enqueue at front in original order so the next drain re-dispatches
		// the same batch. Reverse iteration because enqueueAtFront unshifts.
		const recoveredIds: string[] = [];
		for (const r of [...rows].reverse()) {
			const recovered = session.promptQueue.enqueueAtFront(r.text, {
				images: r.images,
				attachments: r.attachments,
				isSteered: r.isSteered,
			});
			recoveredIds.push(recovered.id);
		}
		if (recoveredIds.length > 0) {
			session.recoveredPromptDispatchQueueIds = [
				...(session.recoveredPromptDispatchQueueIds ?? []),
				...recoveredIds,
			];
		}
		if (providerAuthFailure) {
			this.surfaceProviderAuthFailure(session, reason, source);
			this.broadcastQueue(session);
			return;
		}
		broadcastStatus(session, "idle");
		this.broadcastQueue(session);
		if (this.maybeAutoRetryPromptDeliveryFailure(session, safeReason, source)) {
			return;
		}
		// Schedule a follow-up drain on the next tick so the rows we just
		// re-enqueued get another chance once the bridge has finished its
		// abort/finishRun bookkeeping. setTimeout(0) lets pending microtasks
		// (including the SDK's finally{finishRun()}) run first.
		//
		// Bound the immediate retries: when the agent is genuinely mid-turn the
		// redrain keeps losing to the "Agent is already processing" busy guard
		// and would reschedule itself forever (a tick-0 spin that floods the
		// logs). After MAX_RECOVER_DRAIN_RETRIES we stop — the rows stay queued
		// and the next agent_end's drainQueue (with a freshly reset counter)
		// delivers them once the turn actually ends.
		const attempts = (session.recoverDrainAttempts ?? 0) + 1;
		if (attempts > MAX_RECOVER_DRAIN_RETRIES) {
			session.recoverDrainAttempts = 0;
			console.warn(`[session-manager] ${source} dispatch for ${session.id} still failing after ${MAX_RECOVER_DRAIN_RETRIES} immediate retries (${safeReason}); deferring ${rows.length} row(s) to the next agent_end drain`);
			return;
		}
		session.recoverDrainAttempts = attempts;
		const generation = session.lifecycleGeneration ?? 0;
		setTimeout(() => {
			if ((session.lifecycleGeneration ?? 0) !== generation) return;
			this.drainQueue(session);
		}, 0);
	}

	private async dispatchDirectPrompt(
		session: SessionInfo,
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
		attachments?: unknown[],
		isSteered?: boolean,
		coldStart?: boolean,
	): Promise<void> {
		session.lastPromptText = text;
		session.lastPromptImages = images;
		this.markPromptDispatchStreaming(session);

		const dispatchedRowsForRecovery = [{ text, images, attachments, isSteered }];
		let recovered = false;
		try {
			// Cold (freshly-restored) agent: wait for readiness, then prompt with a
			// generous timeout so a boot-resume nudge lands instead of timing out
			// on the default 30s. Everything else (recovery, rethrow) is identical.
			const resp = coldStart
				? await session.rpcClient.promptWhenReady(text, images)
				: await session.rpcClient.prompt(text, images);
			if (resp && (resp as any).success === false) {
				const reason = (resp as any).error || "unknown";
				this.recoverPromptDispatch(session, dispatchedRowsForRecovery, reason, "direct prompt");
				recovered = true;
				throw this.safeDispatchError(session, reason);
			}
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (!recovered) {
				this.recoverPromptDispatch(session, dispatchedRowsForRecovery, reason, "direct prompt");
			}
			if (isProviderAuthFailure(reason)) {
				throw this.safeDispatchError(session, reason);
			}
			throw err;
		}
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
		if (!this._sessionWriterIsCurrent(session)) return;
		if (session.promptQueue.isEmpty) return;

		// Batch all steered messages at the front into a single prompt
		const steered = session.promptQueue.dequeueAllSteered();
		let next: QueuedMessage | undefined;

		if (steered.length > 0) {
			const batchText = steered.map(m => m.text).join('\n');
			next = { ...steered[0], text: batchText };
		} else {
			// Skip already-dispatched messages (steered mid-turn), then pop the next
			next = session.promptQueue.dequeue();
		}

		this.broadcastQueue(session);
		if (!next) return;

		// Title generation for the first real prompt
		this.tryGenerateTitleFromPrompt(session.id, next.text);

		// Track for retry
		session.lastPromptText = next.text;
		session.lastPromptImages = next.images;

		// Optimistic status update to prevent double-dispatch race
		this.markPromptDispatchStreaming(session);
		const dispatchObservedTurnVersion = session.agentObservedTurnVersion ?? 0;

		// Snapshot the rows we're about to dispatch so we can re-enqueue them
		// if the agent rejects the prompt (e.g. "Agent is already processing."
		// when drainQueue races the SDK's finishRun() during a graceful abort).
		const dispatchedRowsForRecovery = steered.length > 0
			? steered.map(r => ({ text: r.text, images: r.images, attachments: r.attachments, isSteered: true }))
			: [{ text: next.text, images: next.images, attachments: next.attachments, isSteered: !!next.isSteered }];

		const recoverDispatchedRows = (reason: string) => {
			// Suppress recovery only after an inbound agent event proves the dequeued
			// turn was accepted/observed. Local status changes such as Stop →
			// "aborting" can happen before prompt() is accepted; those rows must be
			// recovered or the queued prompt is lost.
			const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
			const safeReason = redactDispatchFailureReason(reason, isProviderAuthFailure(reason), persistedProvider);
			const observedTurnVersion = session.agentObservedTurnVersion ?? 0;
			if (observedTurnVersion !== dispatchObservedTurnVersion) {
				console.warn(`[session-manager] drainQueue dispatch for ${session.id} reported ${safeReason} after agent observed the turn (observedTurnVersion ${dispatchObservedTurnVersion} → ${observedTurnVersion}); not recovering ${dispatchedRowsForRecovery.length} row(s)`);
				return;
			}
			this.recoverPromptDispatch(session, dispatchedRowsForRecovery, reason, "drainQueue");
		};

		const dispatchPromise = session.rpcClient.prompt(next.text, next.images);
		dispatchPromise
			.then((resp: any) => {
				// The bridge resolves with `{success:false, error}` when the agent
				// rejects the command (the most common case is the abort/drainQueue
				// race below). Treat that the same as a thrown rejection — recover
				// the dequeued rows so a future drain can redispatch them.
				if (resp && resp.success === false) {
					recoverDispatchedRows(resp.error || "unknown");
				} else {
					// Dispatch landed — clear the busy-guard retry budget so a
					// future recovery starts fresh.
					session.recoverDrainAttempts = 0;
				}
			})
			.catch((err: any) => {
				const reason = err?.message || String(err);
				const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
				const safeReason = redactDispatchFailureReason(reason, isProviderAuthFailure(reason), persistedProvider);
				console.error(`[session-manager] Failed to dispatch queued prompt for ${session.id}: ${safeReason}`);
				recoverDispatchedRows(reason);
			});
	}

	private persistClaudeCodeMessageToTranscript(session: SessionInfo, event: any): void {
		if (event?.type !== "message_end" || !event.message) return;
		const store = this.resolveStoreForSession(session.id);
		const ps = store.get(session.id);
		if (resolveSessionRuntime({ runtime: ps?.runtime, modelProvider: ps?.modelProvider }) !== "claude-code") return;
		let agentSessionFile = ps?.agentSessionFile;
		if (!agentSessionFile) {
			agentSessionFile = path.join(bobbitStateDir(), "claude-code-transcripts", `${session.id}.jsonl`);
			store.update(session.id, { agentSessionFile });
		}
		try {
			fs.mkdirSync(path.dirname(agentSessionFile), { recursive: true });
			fs.appendFileSync(agentSessionFile, JSON.stringify({
				type: "message",
				id: event.message.id,
				ts: new Date().toISOString(),
				message: event.message,
			}) + "\n");
		} catch (err) {
			console.warn(`[session-manager] Failed to persist Claude Code transcript for ${session.id}:`, err);
		}
	}

	/**
	 * Handle agent events that track error state and control queue draining.
	 * Called from every event listener before broadcasting.
	 * - Tracks message_end with stopReason "error" so we can suppress queue draining.
	 * - On agent_end, skips drainQueue if the turn ended with an error.
	 */
	private handleAgentLifecycle(session: SessionInfo, event: any): void {
		const claudeCodeSessionId = extractClaudeCodeSessionId(event);
		if (claudeCodeSessionId) {
			this.resolveStoreForSession(session.id).update(session.id, { runtime: "claude-code", claudeCodeSessionId });
		}
		this.persistClaudeCodeMessageToTranscript(session, event);

		// H3 fix: track the latest in-flight `message_update` so snapshot reads
		// (`getMessages`) can splice it into the response. Cleared on terminal
		// lifecycle events below. The agent flushes to `.jsonl` only on
		// `message_end`, so without this a snapshot taken mid-stream drops the
		// row entirely — the H3-D convergent-loss case.
		if (event.type === "message_update" && event.message) {
			session.latestMessageUpdate = { id: event.message.id, message: event.message };
		} else if (
			event.type === "message_end" ||
			event.type === "agent_end" ||
			event.type === "process_exit"
		) {
			session.latestMessageUpdate = undefined;
		}

		// Track tool execution during this turn
		if (event.type === "tool_execution_start") {
			session.turnHadToolCalls = true;

			// Enforce allowedTools — log when a disallowed tool slips past the guard
			// extension. This is a last-resort observability signal; actual blocking
			// happens in the tool_call guard (see tool-guard-extension.ts). If we see
			// this log line the guard is misconfigured or missing for this session.
			if (session.allowedTools && session.allowedTools.length > 0 && event.toolName) {
				const toolLower = event.toolName.toLowerCase();
				if (!session.allowedTools.some((t: string) => t.toLowerCase() === toolLower)) {
					console.error(
						`[session-manager] Session ${session.id} executed disallowed tool "${event.toolName}" — guard extension did not block it.`
					);
				}
			}
		}

		// Inbound agent events that carry turn progress prove a just-dispatched
		// prompt was accepted. Keep this separate from statusVersion: local Stop /
		// abort status broadcasts must not suppress recovery for a prompt that was
		// dequeued but rejected before acceptance.
		if (
			event.type === "agent_start" ||
			event.type === "tool_execution_start" ||
			(event.type === "message_end" && (
				event.message?.role === "user" ||
				event.message?.role === "user-with-attachments" ||
				event.message?.role === "assistant"
			))
		) {
			session.agentObservedTurnVersion = (session.agentObservedTurnVersion ?? 0) + 1;
		}

		// Splice this echoed user message off the shadow ledger if it was a
		// dispatched steer. Mirrors the SDK's _steeringMessages text-match
		// removal (agent-session.js:265–280); harmless no-op for non-steer
		// user messages (regular prompts, follow-ups, ask responses).
		this._consumeSteerEcho(session, event);

		// Tool boundary: defensively flush any steered rows that remain queued
		// (for example, recovered/pre-existing rows). Fresh live steers and
		// steer_queued promotions dispatch immediately through _dispatchSteer.
		if (event.type === "tool_execution_end") {
			// If we're already aborting, do NOT dispatch steers via rpcClient.steer.
			// The agent loop is being torn down — the SDK would queue the steer
			// onto _steeringMessages but never consume it, AND the post-abort
			// drainQueue path would re-enqueue and redispatch via rpcClient.prompt,
			// causing the steer to fire twice. Leave the steered rows in the queue
			// so the post-abort drainQueue is the single dispatch site.
			if (session.status === "aborting") return;
			const steered = session.promptQueue.dequeueAllSteered();
			if (steered.length > 0) void this._dispatchSteer(session, steered).catch(() => {});
		}

		if (event.type === "message_end" && (event.message?.role === "user" || event.message?.role === "user-with-attachments")) {
			session.latestTurnUserText = extractUserMessageText(event.message);
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			session.latestTurnAssistantText = extractUserMessageText(event.message);
			const errored = event.message.stopReason === "error";
			const rawErrorMessage = errored ? (event.message.errorMessage || "") : undefined;
			const providerAuthFailure = isProviderAuthFailure(rawErrorMessage);
			const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
			session.lastTurnErrored = errored;
			session.lastTurnErrorMessage = errored
				? redactDispatchFailureReason(rawErrorMessage || "", providerAuthFailure, persistedProvider)
				: undefined;
			if (providerAuthFailure && rawErrorMessage) {
				event.message = { ...event.message, errorMessage: session.lastTurnErrorMessage };
			}
			if (errored) {
				session.consecutiveErrorTurns = (session.consecutiveErrorTurns ?? 0) + 1;
				if (providerAuthFailure) {
					this.surfaceProviderAuthFailure(session, rawErrorMessage || "Provider API key is missing", "agent turn");
				}
			} else {
				// Any non-error terminal assistant message resets the cap budget.
				// Only stopReason:"error" advances the counter.
				session.consecutiveErrorTurns = 0;
			}
		}

		if (event.type === "agent_start") {
			// The session has begun its turn — clear the boot re-prompt marker so
			// the set doesn't leak across the process lifetime (restoreSession is
			// also re-invoked on in-place respawn).
			this._bootRepromptedSessions.delete(session.id);
			session.latestTurnUserText = undefined;
			session.latestTurnAssistantText = undefined;
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.turnHadToolCalls = false;
			session.streamingStartedAt = Date.now();
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
			broadcastStatus(session, "streaming", { streamingStartedAt: session.streamingStartedAt });
			// Clear the inbox nudger's per-staff guard so a fresh batch can be
			// delivered next time the staff goes idle with pending entries.
			// Hook fires for every session that starts a turn; the nudger
			// itself filters down to staff sessions via its own staff lookup.
			if (this._inboxNudger && session.staffId) {
				try {
					this._inboxNudger.onAgentStart(session.id);
				} catch (err) {
					console.warn(`[session-manager] inboxNudger.onAgentStart failed for ${session.id}:`, err);
				}
			}
		} else if (event.type === "agent_end") {
			// Revoke one-time granted tools after the turn completes
			if (session.oneTimeGrantedTools && session.oneTimeGrantedTools.length > 0) {
				const toRevoke = new Set(session.oneTimeGrantedTools.map(t => t.toLowerCase()));
				session.allowedTools = (session.allowedTools || []).filter(
					t => !toRevoke.has(t.toLowerCase())
				);
				session.oneTimeGrantedTools = [];
			}

			// Safety net: if steers arrived after the last tool call or during a
			// non-tool turn (no tool_execution_end fired), dispatch them now.
			if (session.status !== "aborting") {
				const steered = session.promptQueue.dequeueAllSteered();
				if (steered.length > 0) void this._dispatchSteer(session, steered).catch(() => {});
			}

			const wasAborting = session.status === "aborting";
			if (wasAborting) {
				// Reconcile in-flight steers that the SDK accepted but never
				// echoed because the turn was aborted. Re-enqueueing at front
				// as steered means drainQueue → _dispatchSteer redispatches
				// the batch on the next turn. Plus a defensive rebroadcast in
				// case the queue was mutated mid-abort.
				this._reconcileAfterAbort(session);
				this.broadcastQueue(session);

				// User-initiated abort: clear lastTurnErrored so the queue
				// drains. The error stopReason on the aborted assistant
				// message_end is a side-effect of the user pressing Stop, NOT
				// a model malfunction. Queued steered messages represent fresh
				// user intent that should dispatch immediately — leaving the
				// flag set would park them until the next enqueuePrompt's
				// implicit unstick, which is exactly the bug repro'd by
				// tests/e2e/ui/steer-during-bash-tool.spec.ts (MOCK_ABORT_AS_ERROR).
				// Reset the consecutive-error counter too — a Stop click is a
				// successful user-controlled exit, not a streak of failures.
				session.lastTurnErrored = false;
				session.lastTurnErrorMessage = undefined;
				session.consecutiveErrorTurns = 0;
			}

			session.streamingStartedAt = undefined;
			session.completedTurnCount = (session.completedTurnCount ?? 0) + 1;
			// Extension Platform G1.4: notify lifecycle providers a turn completed.
			// Fire-and-forget — NEVER await into the agent_end event path, and
			// swallow/log all errors so a slow or throwing provider can't stall
			// the lifecycle. Per-provider timeouts are enforced inside the hub.
			if (this.lifecycleHub) {
				const turnIndex = session.completedTurnCount;
				void this.lifecycleHub.dispatch("afterTurn", {
					sessionId: session.id,
					projectId: session.projectId,
					scope: session.projectId ? "project" : "global",
					cwd: session.cwd,
					// Effective goal: members/delegates/reviewers carry teamGoalId, not
					// goalId — resolve both so disabled-provider filtering applies.
					goalId: session.goalId ?? session.teamGoalId,
					roleName: session.role,
					prompt: session.latestTurnUserText,
					userText: session.latestTurnUserText,
					assistantText: session.latestTurnAssistantText,
					turn: { index: turnIndex },
				}).catch((err) => {
					console.warn(`[session-manager] afterTurn dispatch failed for ${session.id}:`, err);
				});
			}
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: false, streamingStartedAt: undefined });
			broadcastStatus(session, "idle");
			this.resolveIdleWaiters(session.id);
			// Don't drain the queue if the turn ended with a model error —
			// queued/steered messages should wait for a retry.
			if (!session.lastTurnErrored) {
				session.transientRetryAttempts = 0;
				// Fresh budget for the one-microtask drainQueue→finishRun race on
				// this turn boundary (see MAX_RECOVER_DRAIN_RETRIES).
				session.recoverDrainAttempts = 0;
				this.drainQueue(session);
			} else {
				// Auto-retry transient model/streaming glitches (e.g. malformed
				// tool-call JSON from the model's streamed input_json_delta).
				// Matches the set of patterns the verification harness already
				// treats as transient. Bounded by maxAttempts so a reliably
				// broken model surfaces the error instead of looping.
				this.maybeAutoRetryTransient(session);
			}

			// Trigger deferred setup after the first agent turn completes.
			// This runs model selection, thinking level, and metadata persistence
			// without blocking the user's first prompt.
			if (!session.setupComplete) {
				session.setupComplete = true;
				this._finishSessionSetup(session).catch((err) => {
					console.error(`[session-manager] Deferred setup error for session ${session.id}:`, err);
				});
			}
		} else if (event.type === "auto_compaction_start" || event.type === "compaction_start") {
			session.isCompacting = true;
			// Stash start state for the sidecar append on _end. The bobbit
			// manual path owns its own append in ws/handler.ts and signals via
			// `_sidecarOwnedByHandler` so we don't double-write here. Pi-coding-
			// agent itself ALSO emits a compaction_start for the manual path —
			// match the handler's stash, don't replace it.
			const reason = (event as any).reason;
			if (reason !== "manual" && !(session as any)._pendingCompactionStart) {
				// Generate the compactionId ONCE at start so the sidecar entry id,
				// the broadcast end-event, and the client's live `compact_active`
				// card all share the same id. The live card uses it to mount the
				// pre-compaction-history affordance in-session (no reload needed).
				const startedAtMs = Date.now();
				(session as any)._pendingCompactionStart = {
					startedAtMs,
					trigger: reason === "overflow" ? "overflow" as const : "auto" as const,
					compactionId: makeCompactionId(startedAtMs),
				};
			}
		} else if (event.type === "auto_compaction_end" || event.type === "compaction_end") {
			session.isCompacting = false;
			const pending = (session as any)._pendingCompactionStart as
				| { startedAtMs: number; trigger: "auto" | "overflow"; compactionId: string }
				| undefined;
			const reason = (event as any).reason;
			// Manual path is handled in ws/handler.ts. Auto/overflow path writes
			// the sidecar here from the upstream CompactionResult.
			if (reason !== "manual" && pending) {
				const endedAtMs = Date.now();
				const result = (event as any).result as
					| { tokensBefore?: number; firstKeptEntryId?: string }
					| undefined;
				const aborted = !!(event as any).aborted;
				const errorMessage = (event as any).errorMessage as string | undefined;
				const success = !!result && !aborted && !errorMessage;
				try {
					// Append the sidecar SYNCHRONOUSLY before refreshAfterCompaction
					// so the post-compaction snapshot (and the live card's affordance
					// fetch) see the orphan boundary immediately. Reuse the start-time
					// compactionId so it matches the id we broadcast on the end event.
					appendCompactionSidecarEntry(session.id, {
						schemaVersion: 1,
						id: pending.compactionId,
						trigger: pending.trigger,
						tokensBefore: result?.tokensBefore ?? null,
						tokensAfter: null,
						durationMs: endedAtMs - pending.startedAtMs,
						startedAt: new Date(pending.startedAtMs).toISOString(),
						endedAt: new Date(endedAtMs).toISOString(),
						success,
						error: success ? undefined : (errorMessage || (aborted ? "aborted" : "compaction failed")),
						firstKeptEntryId: result?.firstKeptEntryId ?? null,
					});
				} catch (err) {
					console.warn(`[session-manager] Failed to append compaction sidecar for ${session.id}:`, err);
				}
				// Stamp the broadcast end-event with the shared compactionId so the
				// client stamps its live `compact_active` card with it (the card the
				// user is looking at then mounts the affordance immediately). The
				// event object is forwarded to clients verbatim by emitSessionEvent
				// after this handler returns. Only when the compaction succeeded —
				// a failed compaction has no orphan boundary to recover.
				if (success) (event as any).compactionId = pending.compactionId;
			}
			// Manual path: ws/handler.ts stashes the shared compactionId on the
			// session synchronously before the RPC. The agent emits this manual
			// `compaction_end` BEFORE the RPC promise resolves in ws/handler.ts,
			// and we call refreshAfterCompaction() below. If we waited for the
			// ws-handler's post-RPC append, that snapshot would lack the persisted
			// sidecar anchor and the live card would stay positive-ordered (sorts
			// after the preserved tail). So write the SUCCESS sidecar row HERE,
			// synchronously, before refreshAfterCompaction — using the stashed
			// compactionId and this event's result payload. ws/handler.ts still
			// owns the FAILURE append (when the RPC rejects without ever emitting a
			// successful compaction_end), and skips its own success append via the
			// `_manualSidecarWritten` marker so we don't double-write.
			if (reason === "manual") {
				const manualId = (session as any)._manualCompactionId as string | undefined;
				const manualAborted = !!(event as any).aborted;
				const manualError = (event as any).errorMessage as string | undefined;
				const manualResult = (event as any).result as
					| { tokensBefore?: number; firstKeptEntryId?: string }
					| undefined;
				const manualSuccess = !!manualId && !manualAborted && !manualError && !!manualResult;
				if (manualId && !manualAborted) (event as any).compactionId = manualId;
				if (manualId && manualSuccess) {
					const endedAtMs = Date.now();
					const startedAtMs = parseCompactionStartMs(manualId) ?? endedAtMs;
					try {
						const wrote = appendCompactionSidecarEntry(session.id, {
							schemaVersion: 1,
							id: manualId,
							trigger: "manual",
							tokensBefore: manualResult?.tokensBefore ?? null,
							tokensAfter: null,
							durationMs: Math.max(0, endedAtMs - startedAtMs),
							startedAt: new Date(startedAtMs).toISOString(),
							endedAt: new Date(endedAtMs).toISOString(),
							success: true,
							firstKeptEntryId: manualResult?.firstKeptEntryId ?? null,
						});
						// Tell ws/handler.ts not to append a duplicate success row — but
						// ONLY if our append actually succeeded. On failure leave the
						// marker unset so the ws/handler.ts fallback can append the row
						// when the RPC resolves (otherwise the sidecar boundary is lost).
						if (wrote) (session as any)._manualSidecarWritten = manualId;
					} catch (err) {
						console.warn(`[session-manager] Failed to append manual compaction sidecar for ${session.id}:`, err);
					}
				}
				(session as any)._manualCompactionId = undefined;
			}
			(session as any)._pendingCompactionStart = undefined;
			if (!(event as any).aborted) this.refreshAfterCompaction(session);
		} else if (event.type === "process_exit") {
			session.streamingStartedAt = undefined;
			this.resolveStoreForSession(session.id).update(session.id, {
				wasStreaming: false,
				streamingStartedAt: undefined,
			});
			const reason = event.signal ? `signal ${event.signal}` : `code ${event.code}`;
			this.rejectIdleWaiters(session.id, new Error(`Agent process exited unexpectedly (${reason}) for session ${session.id}`));
			void this.closeExtensionChannelsForSession(session.id, "session-process-exit");
			broadcastStatus(session, "terminated");
		}

		// Index completed messages for search (user + assistant). The
		// content policy inside SearchService runs extractForIndexing and
		// emits one row per text / tool_use / tool_result block.
		if (event.type === "message_end" && event.message) {
			try {
				const goalTitle = session.goalId ? this.resolveGoal(session.goalId)?.title : undefined;
				this.resolveSearchIndex(session).indexMessage({
					sessionId: session.id,
					sessionTitle: session.title,
					message: event.message,
					timestamp: Date.now(),
					projectId: session.projectId || undefined,
					goalId: session.goalId,
					goalTitle,
				});
			} catch {
				// Non-critical — don't break message flow
			}
		}

		// Detect PR creation in bash tool results
		if (event.type === "message_end" && event.message && this._onPrCreationDetected) {
			const content = event.message.content;
			if (Array.isArray(content)) {
				let prDetected = false;
				const PR_CMD_RE = /gh\s+pr\s+(create|ready)/;
				const PR_URL_RE = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
				for (const block of content) {
					if (block.type === "tool_use" && /^[Bb]ash$/.test(block.name) && block.input?.command) {
						if (PR_CMD_RE.test(block.input.command)) { prDetected = true; break; }
					}
					if (block.type === "tool_result") {
						const text = typeof block.content === "string" ? block.content
							: Array.isArray(block.content) ? block.content.map((c: any) => typeof c === "string" ? c : c.text || "").join("") : "";
						if (PR_URL_RE.test(text)) { prDetected = true; break; }
					}
					if (block.type === "text" && typeof block.text === "string" && PR_URL_RE.test(block.text)) {
						prDetected = true; break;
					}
				}
				if (prDetected) {
					this._onPrCreationDetected(session);
				}
			}
		}
	}

	/**
	 * Auto-retry a turn that ended with a transient model/streaming error.
	 *
	 * Two policies, selected by error class:
	 *
	 * - Provider overload / rate-limit (`isProviderBackoffError`, e.g.
	 *   Anthropic `overloaded_error`, `rate_limit_error`, HTTP 429/529):
	 *   effectively unbounded retries with exponential backoff capped at
	 *   5 minutes and ±20% jitter. Overload events can legitimately last
	 *   10+ minutes; surfacing the error to the user is worse than waiting.
	 *
	 * - Other transient glitches (malformed tool-call JSON, ECONNRESET, etc.):
	 *   bounded 3 attempts at 1s/2s/4s, after which the error surfaces and
	 *   the user can manually retry.
	 *
	 * - Retryable generic agent/runtime errors (sanitized unexpected/internal
	 *   system errors): bounded 3 attempts at 1s/5s/60s, then manual retry.
	 */
	private maybeAutoRetryTransient(session: SessionInfo): boolean {
		const BOUNDED_MAX_ATTEMPTS = 3;
		const PROVIDER_BACKOFF_MAX_MS = 300_000; // 5 minutes
		const GENERIC_RETRY_DELAYS_MS = [1000, 5000, 60_000] as const;
		const errMsg = session.lastTurnErrorMessage || "";
		if (!errMsg) return false;
		if (isNonRetryableAgentError(errMsg)) return false;

		const isBackoff = isProviderBackoffError(errMsg);
		const isTransient = isTransientReviewError(errMsg);
		const isGenericRetryable = !isTransient && isRetryableGenericAgentError(errMsg);
		if (!isBackoff && !isTransient && !isGenericRetryable) return false;

		const attempt = (session.transientRetryAttempts ?? 0) + 1;

		if (!isBackoff && attempt > BOUNDED_MAX_ATTEMPTS) {
			const label = isGenericRetryable ? "generic" : "transient";
			console.warn(
				`[session-manager] Session ${session.id} exhausted ${BOUNDED_MAX_ATTEMPTS} ${label} auto-retries; surfacing error to user. Last error: ${errMsg.slice(0, 200)}`
			);
			session.transientRetryAttempts = 0;
			// Dispatch-time failures can exhaust before an agent_start arrives to
			// clear the last visible countdown. Emit the standard cancellation
			// frame even though the timer already fired so the UI does not keep a
			// stale "retrying" banner while manual Retry is required.
			this.cancelPendingAutoRetry(session, "new-prompt", { emitWithoutTimer: true });
			return false;
		}
		session.transientRetryAttempts = attempt;

		const delayMs = isBackoff
			? nextBackoffDelay(attempt, { baseMs: 1000, maxMs: PROVIDER_BACKOFF_MAX_MS, jitterRatio: 0.2 })
			: isGenericRetryable
				? GENERIC_RETRY_DELAYS_MS[attempt - 1]!
				: 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s (preserve exact legacy schedule)

		if (isBackoff) {
			console.log(
				`[session-manager] Session ${session.id} hit provider overload/rate-limit (attempt ${attempt}); auto-retrying in ${Math.round(delayMs / 1000)}s. Error: ${errMsg.slice(0, 200)}`
			);
		} else if (isGenericRetryable) {
			console.log(
				`[session-manager] Session ${session.id} turn failed with a retryable generic error (attempt ${attempt}/${BOUNDED_MAX_ATTEMPTS}), auto-retrying in ${delayMs / 1000}s. Error: ${errMsg.slice(0, 200)}`
			);
		} else {
			console.log(
				`[session-manager] Session ${session.id} turn failed transiently (attempt ${attempt}/${BOUNDED_MAX_ATTEMPTS}), auto-retrying in ${delayMs / 1000}s. Error: ${errMsg.slice(0, 200)}`
			);
		}

		// Visible UI notification while the retry timer is pending. The session
		// status remains "idle" (set by the agent_end handler) but we broadcast
		// a synthetic event so the UI can show "Retrying in Xs due to provider
		// overload…" instead of looking frozen.
		const pendingEvent: AutoRetryPendingEvent = {
			type: "auto_retry_pending",
			reason: isBackoff ? "provider-overload" : "transient-error",
			retryDelayMs: Math.round(delayMs),
			attempt,
			scheduledAt: Date.now(),
			error: errMsg.slice(0, 200),
		};
		// WP4/RC3: route through emitSessionEvent so the frame gets a seq, enters
		// the EventBuffer, and replays on resume — a reconnect during backoff no
		// longer orphans a stale "Retrying…" banner (S5/S21).
		emitSessionEvent(session, pendingEvent);

		if (session.pendingAutoRetryTimer) clearTimeout(session.pendingAutoRetryTimer);
		const generation = session.lifecycleGeneration ?? 0;
		session.pendingAutoRetryTimer = setTimeout(() => {
			session.pendingAutoRetryTimer = undefined;
			// Session may have been terminated or replaced in the meantime.
			if ((session.lifecycleGeneration ?? 0) !== generation) return;
			if (!this._sessionWriterIsCurrent(session)) return;
			if (session.status !== "idle") return; // user sent something, or already retrying
			// Auto path: preserve `transientRetryAttempts` so successive overload
			// failures continue growing the backoff toward the 5-minute cap.
			this.retryLastPrompt(session.id, { auto: true }).catch((err) => {
				console.error(`[session-manager] Auto-retry failed for session ${session.id}:`, err);
			});
		}, delayMs);
		return true;
	}

	/**
	 * Cancel any pending auto-retry timer for this session and broadcast a
	 * synthetic `auto_retry_cancelled` event so UI banners can clear. Safe to
	 * call when no timer is pending — no-op in that case.
	 */
	private cancelPendingAutoRetry(
		session: SessionInfo,
		reason: "explicit-retry" | "new-prompt" | "terminated" | "shutdown",
		opts?: { emitWithoutTimer?: boolean },
	): void {
		const hadTimer = !!session.pendingAutoRetryTimer;
		if (session.pendingAutoRetryTimer) clearTimeout(session.pendingAutoRetryTimer);
		session.pendingAutoRetryTimer = undefined;
		if (!hadTimer && !opts?.emitWithoutTimer) return;
		if (reason !== "shutdown") {
			const cancelledEvent: AutoRetryCancelledEvent = {
				type: "auto_retry_cancelled",
				reason,
				cancelledAt: Date.now(),
			};
			// WP4/RC3: seq + buffer + replay (see auto_retry_pending above).
			emitSessionEvent(session, cancelledEvent);
		}
	}

	/**
	 * Recover a session whose previous turn errored on the blank-ContentBlock
	 * validation error (image/attachment-only prompt poison). The live process's
	 * in-memory history still holds the committed blank block, so re-prompting it
	 * would re-fail; respawn it in place so it rehydrates from the sanitized
	 * `.jsonl` (the switch_session boundary runs sanitizeAgentTranscriptFile).
	 *
	 * Returns the restored session when a respawn happened, or `undefined` when
	 * no respawn was performed — there is no persisted transcript file to
	 * rehydrate from (e.g. the unit harness), so the caller should fall back to
	 * its normal (synthesized-text) dispatch against the existing process.
	 *
	 * Shared by both recovery entry points: explicit `retryLastPrompt` and the
	 * implicit-unstick follow-up prompt path in `enqueuePrompt`.
	 */
	private async _recoverBlankTextPoison(session: SessionInfo): Promise<SessionInfo | undefined> {
		let ps: PersistedSession | undefined;
		try { ps = this.resolveStoreForSession(session.id).get(session.id); }
		catch { ps = undefined; }
		if (!ps?.agentSessionFile) return undefined;
		const restored = await this._respawnAgentInPlace(session, ps);
		return restored ?? this.sessions.get(session.id);
	}

	private consumeRecoveredPromptDispatchRows(session: SessionInfo): boolean {
		const ids = session.recoveredPromptDispatchQueueIds;
		if (!ids?.length) return false;
		let removedAny = false;
		for (const id of ids) {
			removedAny = session.promptQueue.remove(id) || removedAny;
		}
		session.recoveredPromptDispatchQueueIds = undefined;
		if (removedAny) this.broadcastQueue(session);
		return removedAny;
	}

	private consumeQueuedRetryRow(session: SessionInfo, candidateTexts: Array<string | undefined>, images?: Array<{ type: "image"; data: string; mimeType: string }>): boolean {
		const textSet = new Set(candidateTexts.filter((text): text is string => typeof text === "string"));
		if (textSet.size === 0) return false;
		const imageSignature = JSON.stringify(images ?? []);
		const row = session.promptQueue.toArray().find((queued) => {
			if (!textSet.has(queued.text)) return false;
			return JSON.stringify(queued.images ?? []) === imageSignature;
		});
		if (!row) return false;
		const removed = session.promptQueue.remove(row.id);
		if (removed) this.broadcastQueue(session);
		return removed;
	}

	/**
	 * Retry after a model/API error. Behaviour depends on context:
	 * - Fresh response error (no tool calls): re-sends the original user prompt
	 * - Mid-work error (tool calls already executed): sends a system continuation
	 */
	async retryLastPrompt(sessionId: string, opts?: { auto?: boolean }): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		const isAuto = opts?.auto === true;
		const hadToolCalls = session.turnHadToolCalls;
		// Capture before clearing — used to route a live blank-text-poisoned
		// session through respawn so it rehydrates from the sanitized transcript.
		const poisonedByBlankText = isBlankContentBlockError(session.lastTurnErrorMessage);
		const savedPromptText = session.lastPromptText;
		const savedPromptImages = session.lastPromptImages;
		session.lastTurnErrored = false;
		session.turnHadToolCalls = false;
		// Explicit retry resets the cap — human intervention gets a fresh budget.
		// Auto retry must NOT reset, or the backoff would never grow toward the cap.
		if (!isAuto) {
			session.consecutiveErrorTurns = 0;
			// Explicit user retry also resets the transient-retry budget so the
			// next failure starts again at the 1s base. The auto-retry timer
			// path preserves this counter so the delay grows toward the cap.
			session.transientRetryAttempts = 0;
		}
		// In the auto path the timer has already cleared itself; this is a no-op.
		// In the explicit path it tears down any in-flight pending banner.
		this.cancelPendingAutoRetry(session, "explicit-retry");

		// Live blank-text-poisoned recovery: re-prompting the same process would
		// replay the committed blank ContentBlock and re-fail. Respawn the agent
		// so it rehydrates from the sanitized `.jsonl` (un-poisoned at the
		// switch_session boundary), then re-dispatch the synthesized prompt with
		// its image preserved. Returns undefined (no respawn) when there's no
		// persisted transcript file (e.g. unit harness) — the normal branch below
		// already synthesizes text.
		if (poisonedByBlankText) {
			const target = await this._recoverBlankTextPoison(session);
			if (target) {
				// We know this turn was a blank-content poison, so attachment/image
				// content was present. For a legacy non-image attachment-only
				// failure savedPromptText==="" and savedPromptImages===undefined, so
				// synthesizeAttachmentText returns "" — fall back to the synthetic
				// phrase unconditionally rather than re-send blank/invalid content.
				let retryText = synthesizeAttachmentText(savedPromptText ?? "", savedPromptImages);
				if (retryText.trim() === "") retryText = ATTACHMENT_ONLY_TEXT;
				target.lastPromptText = retryText;
				target.lastPromptImages = savedPromptImages;
				await this.dispatchDirectPrompt(target, retryText, savedPromptImages);
				return;
			}
		}

		if (hadToolCalls) {
			// Agent was mid-work — send a system continuation prompt
			await this.dispatchDirectPrompt(session,
				"[SYSTEM: The model API returned an error while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			);
		} else if (session.lastPromptText || session.lastPromptImages?.length) {
			// Fresh response error — re-send the original prompt. Run the text
			// through synthesizeAttachmentText so an already-stuck session whose
			// last prompt was image/attachment-only (lastPromptText blank or
			// whitespace) re-dispatches with a valid non-blank body AND preserves
			// the image, instead of replaying blank text or falling through to the
			// generic fallback branch (which drops the image).
			const retryText = synthesizeAttachmentText(session.lastPromptText ?? "", session.lastPromptImages);
			// Dispatch failures before agent_start re-enqueue the failed row for
			// recovery. Explicit/auto retry is the recovery dispatch, so consume
			// that row first; otherwise the next successful agent_end drain would
			// send it a second time. Prefer tracked recovery row IDs; fall back to
			// text matching for sessions created before the ID ledger existed.
			if (!this.consumeRecoveredPromptDispatchRows(session)) {
				this.consumeQueuedRetryRow(session, [retryText, session.lastPromptText], session.lastPromptImages);
			}
			await this.dispatchDirectPrompt(session, retryText, session.lastPromptImages);
		} else {
			// Fallback (e.g. session predates error tracking)
			this.consumeRecoveredPromptDispatchRows(session);
			await this.dispatchDirectPrompt(session,
				"[SYSTEM: The model API returned an error on your last response. " +
				"Please review your conversation history and retry what you were doing.]"
			);
		}
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
		const session = this.sessions.get(sessionId);
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

	/**
	 * Restart a session's agent process so it picks up updated role/tools.
	 * Stops the current agent, then restores from the persisted session file
	 * which re-applies tool activation with the updated role.
	 */
	private async _restartSessionWithUpdatedRole(session: SessionInfo): Promise<void> {
		const ps = this.resolveStoreForSession(session.id).get(session.id);
		if (!ps) return;

		// Save in-memory grant state that restoreSession doesn't persist.
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
		}
	}

	/**
	 * Snapshot the per-session monotonic counters that the client keeps in
	 * lockstep with the server: the streaming-event `seq` (EventBuffer.lastSeq)
	 * and the canonical `statusVersion`. Used by `restartAgent` /
	 * `_restartSessionWithUpdatedRole` to seed the freshly-built EventBuffer
	 * and SessionInfo so the client's `_highestSeq` and `_lastStatusVersion`
	 * trackers — which never get reset because the WS stays open across the
	 * respawn — keep applying live frames instead of silently dropping them as
	 * "duplicates".
	 *
	 * The numbers we hand back are the high-water marks. The post-restart code
	 * primes the new buffer with `seedNextSeq(lastSeq + 1)` and the new
	 * SessionInfo with `statusVersion: lastVersion`; the very next live frame
	 * therefore lands at seq = lastSeq + 1 / version = lastVersion + 1, which
	 * advances both client trackers naturally.
	 */
	private _snapshotStreamingFrameOfReference(session: SessionInfo): { lastSeq: number; lastStatusVersion: number } {
		return {
			lastSeq: session.eventBuffer.lastSeq,
			lastStatusVersion: session.statusVersion ?? 0,
		};
	}

	/**
	 * Respawn a session's agent process in-place while WS clients stay attached.
	 *
	 * Owns the snapshot/unsubscribe/stop/restore/re-attach/broadcast dance shared
	 * by `restartAgent`, `_restartSessionWithUpdatedRole`, `recoverSandboxSessions`,
	 * and the in-memory branch of `ensureSessionAlive`.
	 *
	 * The streaming frame-of-reference is snapshotted AFTER `unsubscribe()` so a
	 * final in-flight `agent_end`-style event cannot race past `lastSeq`. The
	 * carry-over fields (`_restartFrameOfReference`, `_overrideAllowedTools`)
	 * are stashed on the persisted-session record for `restoreSession()` to
	 * consume, then unconditionally cleared in `finally`.
	 */
	private async _respawnAgentInPlace(
		session: SessionInfo,
		ps: PersistedSession,
		opts?: { mutatePs?: (ps: PersistedSession) => void; finalStatus?: SessionStatus },
	): Promise<SessionInfo | undefined> {
		return this._coalesceRestore(session.id, async (generation) => {
			const savedClients = new Set(session.clients);
			// Snapshot AFTER unsubscribe so no in-flight event races past lastSeq.
			session.unsubscribe();
			const frameOfRef = this._snapshotStreamingFrameOfReference(session);
			this._fenceReplacedSession(session, generation);
			try { await session.rpcClient.stop(); } catch { /* already dead */ }

			this.sessions.delete(session.id);
			// PERF-05: session is about to be re-registered by restoreSession()
			// below; drop any stale taskId-resolution cache entry so it's
			// recomputed fresh rather than briefly missing from the map with a
			// now-orphaned cache entry.
			this.taskIdCache.delete(session.id);
			(ps as any)._restartFrameOfReference = frameOfRef;
			opts?.mutatePs?.(ps);
			try {
				await this.restoreSession(ps);
			} finally {
				delete (ps as any)._restartFrameOfReference;
				delete (ps as any)._overrideAllowedTools;
				delete (ps as any)._overrideGrantedTools;
			}
			const restored = this.sessions.get(session.id);
			if (restored) {
				restored.lifecycleGeneration = generation;
				for (const ws of savedClients) {
					if ((ws as any).readyState === 1) restored.clients.add(ws);
				}
				broadcastStatus(restored, opts?.finalStatus ?? "idle");
				this._trackConnectedSession(restored);
			}
			return restored;
		});
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

		const sessionCostTracker = this.resolveCostTracker(session);
		const stampGoalId = session.goalId ?? session.teamGoalId;
		const trigger = this.costTriggerFromEvent(session, event);
		const cumulativeCost = sessionCostTracker.recordUsage(session.id, {
			inputTokens: usage.inputTokens ?? usage.input,
			outputTokens: usage.outputTokens ?? usage.output,
			cacheReadTokens: usage.cacheReadTokens ?? usage.cacheRead,
			cacheWriteTokens: usage.cacheWriteTokens ?? usage.cacheWrite,
			// pi-ai's Anthropic provider sets `cacheWrite1h` from
			// `cache_creation.ephemeral_1h_input_tokens` (verified in
			// node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js:352).
			// No `cacheWrite5m`-equivalent field exists on the wire — see
			// cost-tracker.ts's `cacheWrite1hTokens` doc.
			cacheWrite1hTokens: usage.cacheWrite1hTokens ?? usage.cacheWrite1h,
			cost: costValue,
		}, stampGoalId, trigger);

		// SWARM-W1 — hard per-node token-budget governor (design/swarm-orchestration.md
		// §6, must-fix #1): this `message_end` hook is the ONE place cumulative
		// turn usage becomes known, so it's the enforcement point for a HARD
		// per-node ceiling — not just a spawn-boundary "pause and ask". Zero
		// overhead for every non-swarm session: `checkTokenBudget` is a Map
		// lookup that returns `{kind:"ok"}` unless `stampGoalId` was
		// explicitly `registerNode`-d by `swarm-best-of-n.ts`.
		if (stampGoalId) {
			const totalTokens = (cumulativeCost.inputTokens ?? 0) + (cumulativeCost.outputTokens ?? 0);
			const action = this._verificationHarness?.swarmGovernor.checkTokenBudget(stampGoalId, totalTokens);
			if (action?.kind === "abort-turn") {
				console.warn(`[swarm-governor] aborting in-flight turn for goal ${stampGoalId}: ${action.reason}`);
				try {
					session.rpcClient.abort();
				} catch (err) {
					console.warn(`[swarm-governor] abort() failed for session ${session.id} (non-fatal):`, err);
				}
			} else if (action?.kind === "hard-kill") {
				this._verificationHarness?.hardKillSwarmNode(stampGoalId, action.reason, { killReason: "governor-budget" })
					.catch((err) => console.warn(`[swarm-governor] hardKillSwarmNode failed for goal ${stampGoalId} (non-fatal):`, err));
			}
		}

		// PERF-05: was a per-message, per-project TaskManager alloc + full
		// scan inlined here. Now reuses the shared, cached resolver (also
		// used by getSessionCostUpdate/broadcastSessionCost for reconnect
		// hydration), so live and reconnect cost_update frames agree on
		// taskId and the hot streaming path stops paying the scan whenever
		// the session already carries its taskId or a cached resolution.
		const taskId = this.resolveTaskIdForSession(session.id);

		broadcast(session.clients, {
			type: "cost_update",
			sessionId: session.id,
			goalId: session.goalId,
			taskId,
			cost: cumulativeCost,
		});
	}

	private costTriggerFromEvent(session: SessionInfo, event: any): string | undefined {
		if (event.type !== "message_end") return undefined;
		if (!session.isCompacting) return undefined;
		const pending = (session as any)._pendingCompactionStart as
			| { trigger?: "auto" | "overflow" }
			| undefined;
		const trigger = pending?.trigger ?? ((session as any)._manualCompactionId ? "manual" : undefined);
		return trigger ? `compaction:${trigger}` : undefined;
	}

	/**
	 * Restore sessions from disk on startup.
	 * Re-spawns agent processes and uses switch_session to resume each one.
	 */
	async restoreSessions(): Promise<void> {
		// Initialize search service (skip when ProjectContextManager is active —
		// ProjectContext.open() already opens the service and wires callbacks)
		if (!this.projectContextManager && this._testSearchIndex && this._testStore && this._testGoalManager) {
			try {
				const goalStore = this._testGoalManager.getGoalStore();
				const testSearchIndex = this._testSearchIndex;
				testSearchIndex.open({ goalStore, sessionStore: this._testStore });
				// Wire index update callbacks
				goalStore.onIndexUpdate = (goal) => {
					try {
						testSearchIndex.indexGoal(goal, goal.projectId || "");
						for (const session of this._testStore?.getAll() ?? []) {
							if (session.goalId !== goal.id) continue;
							testSearchIndex.indexSession(session, goal.title, session.projectId || "");
							testSearchIndex.reindexMessagesForSession(session, goal.title, session.projectId || "");
						}
					} catch (err) { console.error("[search] Failed to index goal:", err); }
				};
				this._testStore.onIndexUpdate = (session) => {
					try {
						const goalTitle = session.goalId ? this.resolveGoal(session.goalId)?.title : undefined;
						testSearchIndex.indexSession(session, goalTitle, session.projectId || "");
						testSearchIndex.reindexMessagesForSession(session, goalTitle, session.projectId || "");
					} catch (err) { console.error("[search] Failed to index session:", err); }
				};
			} catch (err) {
				console.error("[search] Failed to initialize search index:", err);
			}
		}

		const persisted = this.projectContextManager
			? [...this.projectContextManager.getAllLiveSessions()]
			: (this._testStore?.getLive() ?? []);
		if (persisted.length === 0) return;

		// Separate regular sessions from delegate sessions
		const regular = persisted.filter(ps => !ps.delegateOf);
		const delegates = persisted.filter(ps => !!ps.delegateOf);

		// Delegate boot-reap (orchestration-core §5): archive an orphaned delegate
		// child (owner gone/archived) BEFORE dispatch. This reap MUST stay in
		// restoreSessions() — the orphan-reap wiring test stubs restoreOneSession to
		// a no-op and still expects the orphan archived, so it cannot move into the
		// per-session path. Survivors are NOT deferred as dormant husks anymore:
		// they ride the SAME live-restore path workers use (restoreOneSession →
		// restoreSession), so a delegate comes back as a live process with its task
		// rebuilt from the durable instructions/context fields, and the parent's
		// team_wait re-attaches to a live child and collects a real result. A delegate
		// that was mid-turn is re-driven by the shared wasStreaming boot-resume nudge
		// in restoreSession() — no delegate-specific registry.
		const delegateSurvivors: PersistedSession[] = [];
		for (const ps of delegates) {
			if (!ps.agentSessionFile && !canResumeClaudeCodeSession(ps)) {
				try { this.getSessionStore(ps.projectId).archive(ps.id); } catch { /* project gone */ }
				continue;
			}
			// Reap an orphaned delegate child whose owner session is gone or archived.
			// A child whose owner is restoring (exists, not archived) survives and is
			// restored live below.
			const owner = ps.delegateOf ? this.getPersistedSession(ps.delegateOf) : undefined;
			const reap = shouldReapChildOnBoot({
				childKind: ps.childKind ?? "delegate",
				ownerSessionId: ps.delegateOf,
				ownerExists: !!owner,
				ownerArchived: owner?.archived === true,
			});
			if (reap.reap) {
				console.log(`[session-manager] Reaping orphaned delegate child ${ps.id} on boot — ${reap.reason}`);
				try { this.getSessionStore(ps.projectId).archive(ps.id); } catch { /* project gone */ }
				continue;
			}
			delegateSurvivors.push(ps);
		}

		const liveRestore = [...regular, ...delegateSurvivors];
		console.log(`[session-manager] Restoring ${regular.length} session(s) + ${delegateSurvivors.length} delegate(s) live...`);

		// Restore regular + surviving delegate sessions in parallel (batched concurrency)
		const CONCURRENCY = 5;
		for (let i = 0; i < liveRestore.length; i += CONCURRENCY) {
			const batch = liveRestore.slice(i, i + CONCURRENCY);
			await Promise.all(batch.map(ps => this.restoreOneSession(ps)));
		}

		// OrchestrationCore (§3/§4): rebuild the in-memory child index from the
		// already-persisted link fields (delegateOf / parentSessionId+childKind)
		// — no new persisted registry — then remind any owner with live restored
		// children to re-collect them via team_wait (restart survival, no
		// transparent tool-call resumption). Non-collectable child kinds (for
		// example team-managed and PR Walkthrough children) are skipped here.
		if (this.orchestrationCore) {
			try {
				this.orchestrationCore.rebuildIndexFromPersisted(persisted);
				await this.orchestrationCore.remindOwnersWithLiveChildren(shouldSendRestartCollectionReminder);
			} catch (err) {
				console.warn("[session-manager] OrchestrationCore boot index/reminder failed:", err);
			}
		}

		// Recover worktrees whose directories are missing OR whose .git metadata is broken.
		// This covers two failure modes:
		//   1. Directory deleted (cleanup, crash, manual removal)
		//   2. Directory exists but .git file is gone (partial git worktree remove on Windows,
		//      or worktree entry pruned by another git operation while files remain on disk)
		// Skip sandboxed sessions — their worktreePath is a container-internal path.
		for (const ps of persisted) {
			if (!ps.worktreePath || !ps.branch || !ps.repoPath || ps.sandboxed || ps.archived) continue;
			const dirExists = fs.existsSync(ps.worktreePath);
			const gitFileExists = dirExists && fs.existsSync(path.join(ps.worktreePath, ".git"));

			if (!dirExists || !gitFileExists) {
				const reason = !dirExists ? "directory missing" : ".git metadata missing";
				console.log(`[session-manager] Recovering worktree for "${ps.title}" (${ps.id}): ${reason}, branch: ${ps.branch}`);
				try {
					const { recoverWorktree } = await import("../skills/git.js");
					const recovered = await recoverWorktree(ps.repoPath, ps.branch, ps.worktreePath);
					if (recovered) {
						console.log(`[session-manager] Worktree recovered: ${recovered}`);
					} else {
						console.warn(`[session-manager] Could not recover worktree for "${ps.title}" (${ps.id}) — branch may be gone`);
					}
				} catch (err) {
					console.warn(`[session-manager] Worktree recovery failed for "${ps.title}" (${ps.id}):`, err);
				}
			}
		}

		// NOTE: Orphaned non-interactive session cleanup is no longer automatic
		// on startup. Use the Settings → Maintenance UI or
		// GET/POST /api/maintenance/orphaned-sessions to preview and clean up manually.

		// Scan for orphaned agent-CLI transcripts — surface a banner if the
		// session-metadata index has diverged from the on-disk JSONLs.
		try {
			const agentSessionsRoot = activeAgentSessionsDir();
			const tracked = new Set<string>();
			let mostRecent = 0;
			const allPersisted = this.projectContextManager
				? [...this.projectContextManager.getAllSessions()]
				: (this._testStore?.getAll() ?? []);
			for (const ps of allPersisted) {
				if (ps.agentSessionFile) tracked.add(ps.agentSessionFile);
				if (ps.lastActivity && ps.lastActivity > mostRecent) mostRecent = ps.lastActivity;
			}
			// If the store is empty (fresh install), use a 24h floor so we don't
			// flag every transcript from a previous install.
			const floor = mostRecent > 0 ? mostRecent : (Date.now() - 24 * 60 * 60 * 1000);
			const result = scanOrphanedTranscripts(agentSessionsRoot, tracked, floor);
			this.orphanedTranscriptsCount = result.count;
			if (result.count > 0) {
				console.warn(`[session-store] WARN: ${result.count} agent transcript(s) on disk are not tracked in sessions.json`);
			}
		} catch (err) {
			console.warn("[session-manager] orphan-transcript scan failed:", err);
		}
	}

	// NOTE: cleanupOrphanedNonInteractiveSessions() was removed — replaced by
	// listOrphanedNonInteractiveSessions() + terminateOrphanedSessions() which
	// are called via the /api/maintenance/* REST endpoints.

	private async restoreOneSession(ps: PersistedSession): Promise<void> {
		// Backfill missing projectId from goal association (pre-fix sessions)
		if (!ps.projectId && ps.goalId && this.projectContextManager) {
			const ctx = this.projectContextManager.getContextForGoal(ps.goalId);
			if (ctx) {
				ps = { ...ps, projectId: ctx.project.id };
				try {
					this.getSessionStore(ctx.project.id).update(ps.id, { projectId: ctx.project.id });
					console.log(`[session-manager] Backfilled projectId for session ${ps.id} from goal ${ps.goalId}`);
				} catch { /* best-effort */ }
			}
		}
		// No projectId and no goalId: session predates multi-project and cannot be
		// safely assigned to any project at runtime. Skip restore rather than
		// silently dumping it into an arbitrary "default" project.
		if (!ps.projectId && !ps.goalId && !canResumeClaudeCodeSession(ps)) {
			console.warn(`[session-manager] Session ${ps.id} has no projectId and predates multi-project — skipping restore`);
			return;
		}
		let sessionStore: SessionStore;
		try {
			sessionStore = this.getSessionStore(ps.projectId);
		} catch {
			if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Skipping session ${ps.id} — project "${ps.projectId}" no longer registered`);
			return;
		}
		// Generalized boot-reap for ANY child linked by parentSessionId+childKind
		// (orchestration-core §5). Such children (pr-walkthrough, host-agents with
		// lifecycle:"full", and future kinds) are persisted sessions NOT linked by
		// `delegateOf` — so without this they would be resurrected as live node
		// processes on every restart (the session-leak bug), and a child whose
		// parent was archived while the server was down would come back as a LIVE
		// ORPHAN. (delegateOf-linked children are reaped in restoreSessions()'s
		// dormant-defer loop using the same helper.) pr-walkthrough additionally
		// supplies the generic `childTerminal` terminal signal (set server-side by
		// completing code) so a terminal reviewer is reaped with ZERO pack knowledge here.
		if (ps.childKind && ps.parentSessionId && !ps.delegateOf) {
			let kindTerminal = false;
			let kindTerminalReason: string | undefined;
			// GENERIC persisted terminal marker (orchestration-core Decision E /
			// Findings 3–4): any child stamped `childTerminal:true` by completing
			// server-side code is reapable on boot, with ZERO pack/kind knowledge here.
			// host-agents reviewers (e.g. pr-walkthrough's host.agents reviewer) rely on this.
			if (ps.childTerminal === true) {
				kindTerminal = true;
				kindTerminalReason = "child session marked terminal";
			}
			const parent = this.getPersistedSession(ps.parentSessionId);
			const decision = shouldReapChildOnBoot({
				childKind: ps.childKind,
				ownerSessionId: ps.parentSessionId,
				ownerExists: !!parent,
				ownerArchived: parent?.archived === true,
				kindTerminal,
				kindTerminalReason,
			});
			if (decision.reap) {
				console.log(`[session-manager] Reaping ${ps.childKind} child ${ps.id} on boot — ${decision.reason}`);
				sessionStore.archive(ps.id);
				return;
			}
		}
		if (!ps.agentSessionFile && !canResumeClaudeCodeSession(ps)) {
			// No session file path — persistSessionMetadata never completed.
			// Try to recover by scanning the sessions dir for a matching .jsonl.
			const recovered = this.recoverSessionFile(ps);
			if (recovered) {
				console.log(`[session-manager] Recovered session file for ${ps.id}: ${recovered}`);
				sessionStore.update(ps.id, { agentSessionFile: recovered });
				ps = { ...ps, agentSessionFile: recovered };
				// Fall through to normal restore below
			} else {
				if (shouldKeepDespiteOrphan(ps)) {
					console.warn(`[orphan-cleanup] WARN: would-archive ${ps.id} but worktree+recent-transcript present — leaving live`);
					this.addDormantSession(ps);
					return;
				}
				if (ps.worktreePath && ps.branch) {
					console.warn(
						`[session-manager] Session ${ps.id} has no agentSessionFile but has worktree ` +
						`(branch: ${ps.branch}, path: ${ps.worktreePath}). ` +
						`Code may be recoverable. Archiving session — branch "${ps.branch}" preserved in git.`,
					);
				} else {
					console.log(`[session-manager] Archiving ${ps.id} — no agent session file (metadata preserved)`);
				}
				sessionStore.archive(ps.id);
				return;
			}
		}
		trustPersistedAgentSessionFile(ps.agentSessionFile);
		const fileCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
		const fileFound = await sessionFileExists(fileCtx, ps.agentSessionFile, this.sandboxManager);
		if (!fileFound) {
			// `agentSessionFile` is set (persistSessionMetadata only records it after a
			// live getState) but no transcript exists on disk. Pi (>=0.77) creates the
			// session JSONL lazily on the first assistant flush with an exclusive
			// `openSync(file, "wx")`, and Bobbit must not pre-create it — so a crash or
			// server restart in that pre-flush window legitimately leaves the path
			// recorded with no file. That is NOT an orphan to archive.
			//
			// For non-sandboxed sessions this is fully recoverable without any sentinel
			// file: restoreSession() issues switch_session, which routes through
			// SessionManager.open -> setSessionFile. Pi handles a missing path by
			// starting a fresh session on the agent's cwd and creating the file on its
			// first write (the `wx` open then succeeds). Queued prompts replay normally.
			// If the worktree/cwd is actually gone, restoreSession() throws below and we
			// fall back to a dormant (never archived) session. Pinned by
			// tests/session-manager-no-precreate.test.ts.
			if (!ps.sandboxed) {
				console.log(`[session-manager] Session ${ps.id} recorded ${ps.agentSessionFile} but has no transcript yet (pre-flush restart) — restoring live; agent will create the file on first write`);
				// fall through to restoreSession()
			} else if (shouldKeepDespiteOrphan(ps)) {
				console.warn(`[orphan-cleanup] WARN: would-archive ${ps.id} but worktree+recent-transcript present — leaving live`);
				this.addDormantSession(ps);
				return;
			} else {
				console.log(`[session-manager] Archiving ${ps.id} — agent session file not found: ${ps.agentSessionFile} (metadata preserved)`);
				sessionStore.archive(ps.id);
				return;
			}
		}
		try {
			await this._restoreSessionCoalesced(ps);
			// Per-session restore detail is debug-only — the `Restoring N session(s)`
			// summary above covers the routine boot case; failures still log loudly.
			if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Restored: "${ps.title}" (${ps.id})`);
		} catch (err) {
			const msg = err instanceof Error ? (err.stack || err.message) : String(err);
			console.error(`[session-manager] Failed to restore "${ps.title}" (${ps.id}), will retry next restart:`, err);
			this.addDormantSession(ps, msg);
		}
	}

	private addDormantSession(ps: PersistedSession, restoreError?: string): void {
		this.sessions.set(ps.id, {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "terminated",
			statusVersion: 0,
			restoreError,
			dormant: true,
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
			parentSessionId: ps.parentSessionId,
			childKind: ps.childKind,
			readOnly: ps.readOnly,
			allowedTools: ps.allowedTools,
			projectId: ps.projectId,
			promptQueue: new PromptQueue(ps.messageQueue),
			inFlightSteerTexts: Array.isArray(ps.inFlightSteerTexts) ? [...ps.inFlightSteerTexts] : undefined,
		});
	}

	private async restoreSession(ps: PersistedSession): Promise<void> {
		const bridgeOptions: RpcBridgeOptions = { cwd: ps.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (this.toolManager) bridgeOptions.toolManager = this.toolManager;

		// Restore env vars needed by extensions. The per-session capability
		// secret (S1) is regenerated here on restore and handed to the
		// re-spawned agent process — see `session-secret.ts` (restart-safe).
		bridgeOptions.env = {
			BOBBIT_SESSION_ID: ps.id,
			BOBBIT_SESSION_SECRET: this.sessionSecretStore.getOrCreateSecret(ps.id),
		};
		if (ps.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = ps.goalId;
		}
		if (ps.staffId) {
			bridgeOptions.env.BOBBIT_STAFF_ID = ps.staffId;
		}

		// ── Restore Docker sandbox wiring ──
		let restoredSandboxed = ps.sandboxed === true && !(ps.projectId && isSandboxExemptProject(ps.projectId));
		if (ps.sandboxed === true) {
			// Keep applySandboxWiring as the single restore decision point. It uses
			// the selected project's config internally, returns false for non-docker
			// projects, and preserves Headquarters/system no-sandbox exemptions.
			// On restore, the worktree already exists inside the container —
			// pass the container-internal cwd directly (no branch = no worktree creation).
			if (ps.cwd?.startsWith("/workspace")) {
				bridgeOptions.cwd = ps.cwd;
			}
			restoredSandboxed = await this.applySandboxWiring(bridgeOptions, ps.id, {
				projectId: ps.projectId,
				goalId: ps.goalId ?? ps.teamGoalId,
			});
			if (!restoredSandboxed) {
				ps.sandboxed = false;
				this.resolveStoreForSession(ps.id).update(ps.id, { sandboxed: false });
				this.applyScopedGatewayCredentials(bridgeOptions, ps.id, ps.projectId, ps.goalId ?? ps.teamGoalId);
			}
		} else {
			if (ps.sandboxed) {
				ps.sandboxed = false;
				this.resolveStoreForSession(ps.id).update(ps.id, { sandboxed: false });
			}
			this.applyScopedGatewayCredentials(bridgeOptions, ps.id, ps.projectId, ps.goalId ?? ps.teamGoalId);
		}
		if (restoredSandboxed) {
			// Verify the sandbox worktree still exists inside the container. Headquarters
			// sessions are no-worktree, so never repair/recreate /workspace-wt paths.
			if (ps.projectId !== HEADQUARTERS_PROJECT_ID && ps.cwd?.startsWith("/workspace-wt/") && bridgeOptions.containerId) {
				try {
					await execFileAsync("docker", [
						"exec", bridgeOptions.containerId, "test", "-d", ps.cwd,
					], { timeout: 5_000 });
					console.log(`[session-manager] Sandbox worktree verified for ${ps.id}: ${ps.cwd}`);
				} catch {
					console.warn(`[session-manager] Sandbox worktree MISSING for ${ps.id}: ${ps.cwd} — attempting recovery`);
					let recovered = false;

					// Try git worktree repair first — handles broken .git link files after hard container kill
					try {
						await execFileAsync("docker", [
							"exec", "-w", "/workspace", bridgeOptions.containerId!,
							"git", "worktree", "repair",
						], { timeout: 10_000 });
						// Re-check if worktree now exists after repair
						await execFileAsync("docker", [
							"exec", bridgeOptions.containerId!, "test", "-d", ps.cwd!,
						], { timeout: 5_000 });
						console.log(`[session-manager] Sandbox worktree repaired for ${ps.id}: ${ps.cwd}`);
						recovered = true;
					} catch {
						// Repair didn't help — fall through to createWorktree
					}

					if (!recovered && ps.branch && ps.projectId && this.sandboxManager) {
						const sandbox = this.sandboxManager.get(ps.projectId);
						if (sandbox) {
							try {
								// Derive the container worktree root, not a cwd subdirectory offset.
								// e.g. /workspace-wt/session/s-9241bb92/packages/app → session/s-9241bb92
								const branchWorktreeRoot = `/workspace-wt/${ps.branch}`;
								const worktreeName = (ps.cwd === branchWorktreeRoot || ps.cwd!.startsWith(`${branchWorktreeRoot}/`))
									? ps.branch
									: ps.cwd!.replace(/^\/workspace-wt\//, "");
								await sandbox.createWorktree(worktreeName, ps.branch);
								console.log(`[session-manager] Sandbox worktree recovered for ${ps.id}: ${ps.cwd}`);
								recovered = true;
							} catch (err) {
								console.warn(`[session-manager] Sandbox worktree recovery failed for ${ps.id}:`, err);
							}
						}
					}
					if (!recovered) {
						if (shouldKeepDespiteOrphan(ps)) {
							console.warn(`[orphan-cleanup] WARN: would-archive ${ps.id} but worktree+recent-transcript present — leaving live`);
							this.addDormantSession(ps);
							return;
						}
						console.warn(`[session-manager] Archiving session ${ps.id} — sandbox worktree unrecoverable`);
						try { this.getSessionStore(ps.projectId).archive(ps.id); } catch { /* best-effort */ }
						return; // Skip restoring this session
					}
				}
			}
		}

		// Restore extension args for goal/team sessions
		if (ps.goalId && !ps.assistantType) {
			const isTeamLead = ps.role === "team-lead";
			if (isTeamLead) {
				// Team leads need both: team tools + goal tools (tasks/gates)
				bridgeOptions.args = ["--extension", this.getTeamLeadExtensionPath(), "--extension", this.getGoalToolsExtensionPath()];
			} else {
				bridgeOptions.args = ["--extension", this.getGoalToolsExtensionPath()];
			}
		}

		// Restore proposal tools extension for assistant sessions
		if (ps.assistantType) {
			bridgeOptions.args = bridgeOptions.args || [];
			const proposalExtPath = this.getProposalToolsExtensionPath();
			if (!bridgeOptions.args.includes(proposalExtPath)) {
				bridgeOptions.args.push("--extension", proposalExtPath);
			}
		}

		// Restore tool activation. Roleless normal sessions still use the general
		// role so Bobbit extension tools and group policies are restored.
		const overrideAllowedTools: string[] | undefined = (ps as any)._overrideAllowedTools;
		const overrideGrantedTools: string[] | undefined = (ps as any)._overrideGrantedTools;
		// Preserve a persisted EXPLICIT empty allowlist (`[]` = NO tools) as distinct
		// from absent (`undefined` = fall back to role defaults). Only a missing /
		// non-array value falls back; `[]` must survive restore so a restricted
		// session (e.g. allowlist emptied by bobbit.disabledTools) does not silently
		// re-acquire role-default tools on restart.
		const persistedAllowedTools = Array.isArray(ps.allowedTools) ? ps.allowedTools : undefined;
		const hasExplicitAllowlist = overrideAllowedTools !== undefined || persistedAllowedTools !== undefined;
		const restoredRole = this.resolveSessionRole(ps.role, ps.assistantType, ps.projectId);
		const effectiveAllowed: EffectiveTool[] = overrideAllowedTools
			? overrideAllowedTools.map(n => tagAllowedTool(n, this.toolManager))
			: persistedAllowedTools
				? persistedAllowedTools.map(n => tagAllowedTool(n, this.toolManager))
				: this.resolveEffectiveAllowedTools(restoredRole);
		// Filter goal-metadata disabled tools (bobbit.disabledTools) from the
		// restored allowlist so the prompt tool-docs + persisted allowedTools stay
		// consistent with what buildToolActivationArgs actually activates.
		const restoreEffectiveGoalId = ps.goalId ?? ps.teamGoalId;
		const restoreDisabled = this.disabledToolsForGoal(restoreEffectiveGoalId, ps.projectId);
		// Per-goal prompt section ordering (bobbit.promptSectionOrder) for the
		// session's EFFECTIVE goal — mirrors session-setup's initial-setup path so
		// a restored session keeps its goal's custom order instead of reverting to
		// the default after a gateway restart. Undefined ⇒ byte-identical default.
		const restoreSectionOrder = this.promptSectionOrderForGoal(restoreEffectiveGoalId, ps.projectId);
		const restoredFiltered = restoreDisabled
			? effectiveAllowed.filter(e => !restoreDisabled.has(e.name.toLowerCase()))
			: effectiveAllowed;
		// Preserve the unrestricted (`undefined`) vs explicit-empty (`[]`)
		// distinction. A genuinely unrestricted session (role-less / no
		// toolManager, NO persisted/override allowlist) resolves `effectiveAllowed`
		// to `[]` and must map to `undefined` (all tools). But when there WAS an
		// explicit allowlist source — a persisted/override `[]`, or an allowlist
		// `bobbit.disabledTools` removed entirely — `restoredFiltered` is `[]` and
		// must stay `[]` (NO tools); never collapse it to `undefined`, which would
		// re-grant every tool on restart.
		const restoredAllowedTools: EffectiveTool[] | undefined =
			(hasExplicitAllowlist || effectiveAllowed.length > 0) ? restoredFiltered : undefined;
		const restoredAllowedNames = restoredAllowedTools?.map(e => e.name);
		await this.ensureMcpManagerForContext(ps.projectId, ps.cwd);
		const restoredActivation = this.buildToolActivationArgs(ps.id, restoredAllowedTools, restoredRole, ps.cwd, ps.projectId, ps.goalId ?? ps.teamGoalId, overrideGrantedTools);
		bridgeOptions.args = [...restoredActivation.args, ...(bridgeOptions.args || [])];
		bridgeOptions.piExtensions = [...(bridgeOptions.piExtensions ?? []), ...restoredActivation.runtimeExtensions];
		bridgeOptions.env = { ...(bridgeOptions.env || {}), ...restoredActivation.env };

		// Re-assemble system prompt (global + AGENTS.md + goal spec)
		const assistantDef = ps.assistantType ? getAssistantDef(ps.assistantType) : undefined;
		if (assistantDef) {
			// Combine assistant role's shared prompt with per-type specialized prompt
			const assistantTemplate = this.resolveRolePromptTemplate("assistant", ps.projectId);
			let assistantGoalSpec = "";
			if (assistantTemplate) {
				assistantGoalSpec = assistantTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(ps.goalId || ps.id).slice(0, 8)}`);
				assistantGoalSpec += "\n\n---\n\n";
			}
			assistantGoalSpec += assistantDef.prompt;
			if (ps.assistantType === "goal") {
				assistantGoalSpec = assistantGoalSpec.replace('{{AVAILABLE_WORKFLOWS}}', this._buildWorkflowList(ps.projectId));
				// Inject re-attempt context if this is a re-attempt session
				if (ps.reattemptGoalId) {
					const origGoal = this.resolveGoal(ps.reattemptGoalId);
					if (origGoal) {
						assistantGoalSpec += "\n\n" + buildReattemptContext(origGoal, this.prStatusStore!);
					}
				}
			}
			assistantGoalSpec = applyPromptConditionals(assistantGoalSpec, { subGoalsEnabled: this.isSubgoalsEnabled });

			const promptPath = this.assemblePrompt(ps.id, {
				// Restore/respawn path: keep the global base prompt so it reaches
				// restored assistant sessions.
				baseSystemPromptPath: this.systemPromptPath,
				cwd: ps.cwd,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: restoredAllowedNames,
				projectConfigStore: this.projectConfigStore,
				sectionOrder: restoreSectionOrder,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else if (ps.delegateOf && !ps.goalId) {
			// Delegate restore: rebuild the system prompt from durable instructions +
			// context — the delegate's equivalent of a worker task spec. Use the Task
			// fields so restored delegates and prompt-section reconstruction agree.
			const promptPath = this.assemblePrompt(ps.id, this.buildDelegatePromptParts({
				cwd: ps.cwd,
				// Keep AGENTS.md / project config dirs readable for sandbox or multi-repo
				// delegates whose cwd is container-internal.
				projectRoot: ps.repoPath,
				instructions: ps.instructions || "",
				context: ps.context,
				allowedTools: restoredAllowedNames,
				sectionOrder: restoreSectionOrder,
			}));
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else {
			const goal = ps.goalId ? this.resolveGoal(ps.goalId) : undefined;

			// Re-attach role/staff prompt (lost on restart since rolePrompt isn't
			// persisted). Staff sessions rebuild the full role context + systemPrompt
			// + pinned memory via buildStaffSystemPrompt; team agents resolve the role
			// template. See buildRestoreRolePrompt.
			const goalSpec = goal?.spec;
			const { rolePrompt, roleName } = buildRestoreRolePrompt(ps, {
				goalBranch: goal?.branch,
				roleManager: this.roleManager,
				getStaff: this.staffRecordSource ? (id) => this.staffRecordSource!.getStaff(id) : undefined,
				resolveTemplate: (rn, pid) => this.resolveRolePromptTemplate(rn, pid),
				subGoalsEnabled: this.isSubgoalsEnabled,
			});

			const promptPath = this.assemblePrompt(ps.id, {
				baseSystemPromptPath: this.systemPromptPath,
				cwd: ps.cwd,
				goalTitle: goal?.title,
				goalState: goal?.state,
				goalSpec,
				rolePrompt,
				roleName,
				allowedTools: restoredAllowedNames,
				projectConfigStore: this.projectConfigStore,
				sectionOrder: restoreSectionOrder,
				promptProfile: ps.nonInteractive ? "reviewer" : undefined,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		}

		// Pin model + thinking level at spawn so pi-coding-agent doesn't emit a
		// redundant initial `model_change` event with its hardcoded default.
		// Prefer the persisted model if known (avoids surprising changes after
		// restart); fall back to role/preference resolution.
		if (ps.modelProvider && ps.modelId) {
			bridgeOptions.initialModel = `${ps.modelProvider}/${ps.modelId}`;
		} else {
			const initModel = this.resolveInitialModel(ps.role, ps.projectId);
			if (initModel) bridgeOptions.initialModel = initModel;
		}
		const initThinking = this.resolveInitialThinkingLevel(ps.role, ps.projectId);
		if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;
		this.applyDirectProviderEnv(bridgeOptions, !!ps.sandboxed, ps.modelProvider);

		const runtime = resolveSessionRuntime({ runtime: ps.runtime, initialModel: bridgeOptions.initialModel, modelProvider: ps.modelProvider });
		assertRuntimeAllowedForSession(runtime, ps.sandboxed);
		Object.assign(bridgeOptions, hydrateRuntimeOptions({
			...bridgeOptions,
			runtime,
			claudeCodeSessionId: ps.claudeCodeSessionId,
			claudeCodeExecutable: ps.claudeCodeExecutable,
			claudeCodePermissionMode: ps.claudeCodePermissionMode,
			claudeCodeModelAlias: ps.claudeCodeModelAlias,
			readOnly: ps.readOnly,
		}, this.readClaudeCodeConfigForProject(ps.projectId)));

		const rpcClient = createSessionBridge(bridgeOptions);
		const eventBuffer = new EventBuffer();
		// In-place restart paths (`restartAgent`, `_restartSessionWithUpdatedRole`)
		// stash the previous session's streaming frame-of-reference on `ps` so the
		// new EventBuffer/SessionInfo continue the monotonic seq + statusVersion
		// sequence space. Clients keep their WS open across the respawn, so a
		// fresh seq-1 / version-1 frame would be silently dropped by their dedup
		// gates. See _snapshotStreamingFrameOfReference().
		const frameOfRef = (ps as any)._restartFrameOfReference as
			| { lastSeq: number; lastStatusVersion: number }
			| undefined;
		if (frameOfRef && Number.isFinite(frameOfRef.lastSeq) && frameOfRef.lastSeq > 0) {
			eventBuffer.seedNextSeq(frameOfRef.lastSeq + 1);
		}
		const initialStatusVersion = frameOfRef && Number.isFinite(frameOfRef.lastStatusVersion)
			? frameOfRef.lastStatusVersion
			: 0;

		const session: SessionInfo = {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "starting",
			statusVersion: initialStatusVersion,
			lifecycleGeneration: this._currentRespawnGeneration(ps.id),
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
			delegateOf: ps.delegateOf,
			parentSessionId: ps.parentSessionId,
			childKind: ps.childKind,
			readOnly: ps.readOnly,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			teamLeadSessionId: ps.teamLeadSessionId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			staffId: ps.staffId,
			accessory: ps.accessory,
			preview: ps.preview,
			allowedTools: restoredAllowedNames,
			promptQueue: new PromptQueue(ps.messageQueue),
			streamingStartedAt: ps.streamingStartedAt,
			restoreStartupWasStreaming: ps.wasStreaming === true,
			projectId: ps.projectId,
			inFlightSteerTexts: Array.isArray(ps.inFlightSteerTexts) ? [...ps.inFlightSteerTexts] : undefined,
			spawnPinnedModel: bridgeOptions.initialModel,
			spawnPinnedThinkingLevel: bridgeOptions.initialThinkingLevel,
			thinkingLevelUserPinned: ps.thinkingLevelUserPinned,
			repoPath: ps.repoPath,
			branch: ps.branch,
			worktreePushPolicy: ps.worktreePushPolicy,
			remotePublicationPolicy: ps.remotePublicationPolicy,
			repoWorktrees: ps.repoWorktrees && ps.repoPath
				? Object.entries(ps.repoWorktrees).map(([repo, worktreePath]) => ({
					repo,
					repoPath: repo === "." ? ps.repoPath! : path.join(ps.repoPath!, repo),
					worktreePath,
				}))
				: undefined,
			sandboxed: ps.sandboxed,
		};

		// Skip cost tracking during session restore (switch_session replays
		// all historical message_update events which would double-count costs)
		let restoring = true;

		const restoreStore = this.getSessionStore(ps.projectId);
		const unsub = rpcClient.onEvent((event: any) => {
			// During restore, switch_session replays every persisted message as an
			// rpc event. Bumping lastActivity here would clobber the pre-restart
			// timestamp with Date.now(). Gate on the restoring flag AND on
			// isUserVisibleActivity so post-resume lifecycle frames (agent_start,
			// agent_idle, connection_state, state, session_title) don't clobber it.
			if (!restoring) {
				if (isUserVisibleActivity(event)) {
					session.lastActivity = Date.now();
					restoreStore.update(ps.id, { lastActivity: session.lastActivity });
				}
			}

			this.handleAgentLifecycle(session, event);

			const truncated = truncateLargeToolContent(event);
			emitSessionEvent(session, truncated);
			if (!restoring) this.trackCostFromEvent(session, event);
		});

		bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension);
		session.unsubscribe = unsub;

		await rpcClient.start();

		// Resume the agent's previous session file. Persisted host paths are still
		// readable by Bobbit; sandboxed agents receive the active mount's container
		// path when the host path maps to the active sessions mount.
		trustPersistedAgentSessionFile(ps.agentSessionFile);
		const transcriptFileCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
		const switchSessionPath = switchSessionPathForAgent(ps);
		// Un-poison any blank-text user messages persisted before the
		// attachment-only fix, so the agent doesn't re-send an invalid blank
		// ContentBlock on resume (best-effort, non-fatal).
		await sanitizeAgentTranscriptFile(
			transcriptFileCtx,
			ps.agentSessionFile,
			this.sandboxManager,
		);
		const switchTimeout = ps.sandboxed ? 60_000 : 15_000;
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: switchSessionPath },
			switchTimeout,
		);
		restoring = false;
		if (!switchResp.success) {
			await rpcClient.stop();
			throw new Error(`switch_session failed: ${switchResp.error}`);
		}

		try {
			await this.tryAutoSelectModel(session);
		} catch (err) {
			await rpcClient.stop();
			throw err;
		}

		broadcastStatus(session, "idle");

		// For sandbox sessions, resolve the container ID so git-status and other
		// host-side operations can run commands inside the container via docker exec.
		// The containerId is not persisted — it's resolved from SandboxManager which
		// reconnects to the existing container by label on startup.
		if (ps.sandboxed && this.sandboxManager && ps.projectId) {
			try {
				const sandbox = this.sandboxManager.get(ps.projectId);
				if (sandbox) {
					session.containerId = await sandbox.getContainerId();
				}
			} catch (err) {
				console.warn(`[session-manager] Could not resolve container for sandbox session ${ps.id}: ${err}`);
			}
		}

		this.sessions.set(ps.id, session);

		// `switch_session` replays durable user message echoes and `_consumeSteerEcho`
		// clears matching ledger entries. Anything left here was accepted for
		// dispatch but not echoed before the gateway died, so re-enqueue it once.
		this._reconcileInFlightSteers(session);

		// Restore + re-attach this session's persisted background processes. The
		// session now exists and (for sandboxed sessions) containerId has been
		// re-resolved, so liveness/re-attach can target the live process.
		const bgMgr = (this as any).bgProcessManager;
		if (bgMgr?.restoreSession) {
			try { await bgMgr.restoreSession(ps.id); }
			catch (err) { console.warn(`[session-manager] bg-process restore failed for ${ps.id}:`, err); }
		}

		// If the agent was mid-turn when the server died, re-prompt it to continue.
		// EXCEPTION: verification reviewer / agent-qa sessions are nonInteractive
		// and are re-driven EXCLUSIVELY by the verification harness
		// (`resumeInterruptedVerifications()` -> `_tryResumeFromSession`, which
		// waits for readiness and sends its own reminder prompt). Firing the boot
		// nudge here too would race two prompts on the same cold reviewer agent.
		// We still clear `wasStreaming` so the flag doesn't leak across restarts.
		if (ps.wasStreaming && ps.nonInteractive) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn but is nonInteractive — leaving re-drive to the verification harness`);
			restoreStore.update(ps.id, { wasStreaming: false });
		} else if (ps.wasStreaming) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn — re-prompting to continue`);
			restoreStore.update(ps.id, { wasStreaming: false });
			// Record a boot-coordination marker so the team-manager boot-resume
			// nudge skips this lead and we don't race two prompts at the same
			// cold agent. Cleared in handleAgentLifecycle on agent_start.
			this._bootRepromptedSessions.add(ps.id);
			// Cold agent: wait for readiness, then prompt with a generous timeout
			// (the default 30s reliably times out on boot). Keep the .catch() so a
			// failure is logged and never throws.
			rpcClient.promptWhenReady(
				"[SYSTEM: The infrastructure server restarted while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			).catch((err: any) => {
				console.error(`[session-manager] Failed to re-prompt interrupted session ${ps.id}:`, err);
			});
		}
	}

	async createSession(cwd: string, agentArgs?: string[], goalId?: string, assistantType?: string, opts?: { rolePrompt?: string; roleName?: string; role?: string; teamGoalId?: string; teamLeadSessionId?: string; accessory?: string; nonInteractive?: boolean; promptProfile?: PromptProfile; env?: Record<string, string>; taskId?: string; staffId?: string; allowedTools?: string[]; workflowContext?: string; worktreeOpts?: { repoPath: string }; worktreePushPolicy?: WorktreePushPolicy; reattemptGoalId?: string; sandboxed?: boolean; projectId?: string; sessionId?: string; sandboxBranch?: string; sandboxBaseBranch?: string; sandboxCwdOffset?: string; skipAutoModel?: boolean; skipAutoThinking?: boolean; initialModel?: string; runtime?: SessionRuntime; initialThinkingLevel?: string; preExistingAgentSessionFile?: string; preExistingAgentSessionOldCwds?: string[]; parentSessionId?: string; childKind?: string; readOnly?: boolean; title?: string; awaitWorktreeSetup?: boolean; bypassWorktreePool?: boolean }): Promise<SessionInfo> {
		const id = opts?.sessionId || randomUUID();
		const optsAllowedTagged: EffectiveTool[] | undefined = opts?.allowedTools
			? opts.allowedTools.map(n => tagAllowedTool(n, this.toolManager))
			: undefined;
		const sessionScopedAllowedTools = opts?.allowedTools && opts.allowedTools.length > 0
			? [...opts.allowedTools]
			: undefined;
		// Resolve projectId from opts or from the goal's project.
		// Headquarters is a server/data workspace: ignore every worktree request at
		// the lifecycle boundary so downstream setup never claims a pool, creates a
		// git worktree, or asks sandbox wiring for a branch worktree.
		const projectId = opts?.projectId ?? (goalId ? this.resolveGoal(goalId)?.projectId : undefined);
		const sandboxExemptScope = projectId ? isSandboxExemptProject(projectId) : false;
		const headquartersScope = projectId === HEADQUARTERS_PROJECT_ID;
		const effectiveSandboxed = opts?.sandboxed && !sandboxExemptScope ? true : undefined;
		const worktreeOpts = headquartersScope ? undefined : opts?.worktreeOpts;
		const worktreePushPolicy = headquartersScope ? undefined : opts?.worktreePushPolicy;
		const sandboxBranch = effectiveSandboxed ? opts?.sandboxBranch : undefined;
		const sandboxBaseBranch = effectiveSandboxed ? opts?.sandboxBaseBranch : undefined;
		await this.ensureMcpManagerForContext(projectId, cwd);
		const ctx = this.buildPipelineContext(projectId, cwd);

		// Spawn-path rolePrompt resolution. The orchestration spawn path
		// (`host.agents.spawn` → OrchestrationCore.spawn → createSession) threads only
		// `roleName` (no `rolePrompt`), so a pack-shipped role's promptTemplate — e.g.
		// the pr-reviewer YAML schema — would otherwise NEVER reach the child's system
		// prompt (assembleSystemPrompt only consumes `parts.rolePrompt`, never a
		// roleName→template lookup). Resolve it cascade-first here (mirrors the restore
		// path's buildRestoreRolePrompt) so a project-scoped reviewer child carries its
		// role prompt. A caller that passes an explicit `rolePrompt` (team/staff) is
		// untouched.
		let resolvedRolePrompt = opts?.rolePrompt;
		if (!resolvedRolePrompt && opts?.roleName) {
			const template = this.resolveRolePromptTemplate(opts.roleName, projectId);
			if (template) {
				resolvedRolePrompt = resolveRolePrompt({ promptTemplate: template }, {
					branch: goalId ? this.resolveGoal(goalId)?.branch : undefined,
					agentId: `${opts.roleName}-${(goalId || id).slice(0, 8)}`,
					roleManager: this.roleManager ?? undefined,
					subGoalsEnabled: this.isSubgoalsEnabled,
				});
			}
		}
		const sandboxCwdOffset = effectiveSandboxed
			? await this.resolveSandboxCwdOffset(cwd, projectId, goalId, opts?.sandboxCwdOffset)
			: undefined;
		const directGatewayEnv = !effectiveSandboxed
			? this.scopedGatewayEnvForDirectAgent(id, projectId, goalId ?? opts?.teamGoalId ?? opts?.env?.BOBBIT_GOAL_ID)
			: undefined;

		// ── Worktree: return a "preparing" session immediately, launch agent async ──
		if (worktreeOpts) {
			const repoPath = worktreeOpts.repoPath;
			const uuid8 = id.slice(0, 8);
			const wtRoot = path.resolve(repoPath, "..", `${path.basename(repoPath)}-wt`);

			// Compute the final branch name up front. Both warm-pool and cold-pool
			// paths produce `session/<id8>` — unified namespace, no first-prompt
			// rename. See docs/design/remove-session-worktree-rename.md.
			//
			// Sandboxed sessions skip the host-side pool: they create their worktree
			// inside the container via ProjectSandbox.createWorktree, and the
			// host-side worktree pool isn't reachable from the container.
			const targetBranch = `session/${uuid8}`;
			const poolForCreate = (!effectiveSandboxed && !opts?.bypassWorktreePool && projectId) ? this.worktreePools.get(projectId) : undefined;
			const claimed = poolForCreate ? await poolForCreate.claim(targetBranch).catch((err) => {
				console.warn(`[session-manager] pool.claim failed for ${id}, falling back to createWorktree: ${err instanceof Error ? err.message : err}`);
				return null;
			}) : null;

			const safeName = targetBranch.replace(/\//g, "-");
			const branch = targetBranch;
			const worktreePath = claimed ? claimed.worktreePath : path.join(wtRoot, safeName);

			const now = Date.now();
			const session: SessionInfo = {
				id,
				title: "New session",
				cwd, // temporary — will be updated when worktree is ready
				status: "preparing",
				statusVersion: 0,
				createdAt: now,
				lastActivity: now,
				clients: new Set(),
				rpcClient: new RpcBridge({ cwd }), // placeholder, not started
				eventBuffer: new EventBuffer(),
				unsubscribe: () => {},
				isCompacting: false,
				titleGenerated: false,
				goalId,
				teamGoalId: opts?.teamGoalId,
				teamLeadSessionId: opts?.teamLeadSessionId,
				assistantType,
				taskId: opts?.taskId,
				parentSessionId: opts?.parentSessionId,
				childKind: opts?.childKind,
				readOnly: opts?.readOnly,
				allowedTools: opts?.allowedTools,
				// Mirror session-setup's effectiveRoleId fallback: when callers
				// (team-manager, staff-manager) pass only `roleName`, use that as
				// `session.role` so the post-spawn auto-model safety net still
				// keys off the right role id during the worktree-prep window.
				role: opts?.role ?? opts?.roleName,
				accessory: opts?.accessory,
				nonInteractive: opts?.nonInteractive,
				worktreePath,
				worktreePushPolicy,
				projectId,
				promptQueue: new PromptQueue(),
			};

			if (claimed && claimed.worktrees && claimed.worktrees.length > 0) {
				// Re-derive per-repo `repoPath` from the project's components: the pool
				// claim only carries `repo` + `worktreePath`. For session-manager we need
				// each repo's *primary* path so cleanup-on-archive can run git ops there.
				session.repoWorktrees = claimed.worktrees.map(w => ({
					repo: w.repo,
					repoPath: w.repo === "." ? repoPath : path.join(repoPath, w.repo),
					worktreePath: w.worktreePath,
				}));
			}
			session.repoPath = repoPath;
			session.branch = branch;

			this.sessions.set(id, session);

			// Build the plan for the worktree pipeline
			const plan: SessionSetupPlan = {
				id,
				mode: "worktree",
				title: opts?.title || "New session",
				cwd,
				goalId,
				teamGoalId: opts?.teamGoalId,
				teamLeadSessionId: opts?.teamLeadSessionId,
				assistantType,
				taskId: opts?.taskId,
				// Load-bearing wire: threads staffId from opts → plan → persistOnce so it
				// lands in PersistedSession on disk. Pinned by `tests/staff-session-staffid-persistence.test.ts`;
				// without it `BOBBIT_STAFF_ID` is lost on respawn and the inbox tools refuse to register.
				staffId: opts?.staffId,
				parentSessionId: opts?.parentSessionId,
				childKind: opts?.childKind,
				readOnly: opts?.readOnly,
				runtime: opts?.runtime,
				sessionScopedAllowedTools,
				worktreePath,
				worktreePushPolicy,
				repoPath,
				branch,
				sandboxed: effectiveSandboxed,
				role: opts?.role,
				accessory: opts?.accessory,
				nonInteractive: opts?.nonInteractive,
				promptProfile: opts?.promptProfile,
				agentArgs,
				env: { ...(opts?.env ?? {}), ...(directGatewayEnv ?? {}) },
				rolePrompt: resolvedRolePrompt,
				roleName: opts?.roleName,
				workflowContext: opts?.workflowContext,
				effectiveAllowedTools: optsAllowedTagged,
				projectId,
				sandboxBranch,
				sandboxBaseBranch,
				sandboxCwdOffset,
				skipAutoModel: opts?.skipAutoModel,
				skipAutoThinking: opts?.skipAutoThinking,
				initialModel: opts?.initialModel,
				initialThinkingLevel: opts?.initialThinkingLevel,
				preExistingAgentSessionFile: opts?.preExistingAgentSessionFile,
				preExistingAgentSessionOldCwds: opts?.preExistingAgentSessionOldCwds,
				bridgeOptions: { cwd },
			};

			// Persist immediately with all known structural fields
			persistOnce(session, plan, ctx.store);
			if (session.repoWorktrees && session.repoWorktrees.length > 0) {
				ctx.store.update(session.id, {
					repoWorktrees: Object.fromEntries(session.repoWorktrees.map(w => [w.repo, w.worktreePath])),
				});
			}
			this.notifySessionCreated(session);

			// Finish the pipeline. Most callers keep the historical preparing-session UX
			// and let setup complete in the background. Continue-Archived opts in to
			// awaiting setup so fresh worktree/base-ref failures are returned by the POST
			// instead of surfacing later as an asynchronously archived session.
			const setupPromise = executeWorktreeAsync(plan, session, ctx, claimed?.worktreePath).then(() => {
				// agentSessionFile is now persisted synchronously by spawnAgent before
				// status flips to idle (see session-setup.ts). The post-resolve persist
				// here is redundant but kept as a safety net for re-attempts where the
				// agent may rotate its session file mid-run. Continue/Fork rehydration
				// already adopted a cloned transcript and may have sanitized runtime-only
				// metadata in that file; avoid a redundant get_state that can drop it.
				if (plan.preExistingAgentSessionFile) return;
				session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err) => {
					console.warn(`[session-manager] Early persist failed for worktree session ${session.id}:`, err);
				}).finally(() => { session.pendingMetadataPersist = undefined; });
			});

			if (opts?.awaitWorktreeSetup) {
				try {
					await setupPromise;
				} catch (err) {
					const setupError = err instanceof Error ? err : new Error(String(err));
					handleSetupFailure(session, plan, setupError, ctx);
					throw setupError;
				}
			} else {
				setupPromise.catch((err) => {
					const setupError = err instanceof Error ? err : new Error(String(err));
					handleSetupFailure(session, plan, setupError, ctx);
				});
			}

			return session;
		}

		// ── Normal session: build plan and execute full pipeline ──
		const plan: SessionSetupPlan = {
			id,
			mode: "normal",
			title: opts?.title || "New session",
			cwd,
			goalId,
			teamGoalId: opts?.teamGoalId,
			teamLeadSessionId: opts?.teamLeadSessionId,
			assistantType,
			taskId: opts?.taskId,
			parentSessionId: opts?.parentSessionId,
			childKind: opts?.childKind,
			readOnly: opts?.readOnly,
			runtime: opts?.runtime,
			worktreePushPolicy,
			sessionScopedAllowedTools,
			// Load-bearing wire: same contract as the worktree branch above.
			// Pinned by `tests/staff-session-staffid-persistence.test.ts`.
			staffId: opts?.staffId,
			sandboxed: effectiveSandboxed,
			role: opts?.role,
			accessory: opts?.accessory,
			nonInteractive: opts?.nonInteractive,
			promptProfile: opts?.promptProfile,
			agentArgs,
			env: { ...(opts?.env ?? {}), ...(directGatewayEnv ?? {}) },
			rolePrompt: resolvedRolePrompt,
			roleName: opts?.roleName,
			workflowContext: opts?.workflowContext,
			reattemptGoalId: opts?.reattemptGoalId,
			effectiveAllowedTools: optsAllowedTagged,
			projectId,
			sandboxBranch,
			sandboxBaseBranch,
			sandboxCwdOffset,
			skipAutoModel: opts?.skipAutoModel,
			skipAutoThinking: opts?.skipAutoThinking,
			initialModel: opts?.initialModel,
			initialThinkingLevel: opts?.initialThinkingLevel,
			preExistingAgentSessionFile: opts?.preExistingAgentSessionFile,
			preExistingAgentSessionOldCwds: opts?.preExistingAgentSessionOldCwds,
			bridgeOptions: { cwd },
		};

		const session = await executePlan(plan, ctx);
		if (projectId) session.projectId = projectId;
		this.notifySessionCreated(session);

		// Persist session metadata (fire-and-forget, but tracked for terminate).
		// Rehydrated sessions already have a cloned/adopted transcript path recorded;
		// avoid a redundant get_state that can rewrite runtime-only metadata.
		if (!plan.preExistingAgentSessionFile) {
			session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err) => {
				console.warn(`[session-manager] Early persist failed for ${session.id}:`, err);
			}).finally(() => { session.pendingMetadataPersist = undefined; });
		}

		return session;
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
		/**
		 * Explicit allowedTools override (OrchestrationCore recursion guard, §7):
		 * the core passes the owner's allowedTools MINUS every spawn verb. When
		 * omitted, the child inherits the parent's full allowedTools (legacy).
		 */
		allowedTools?: string[];
		/**
		 * Model / thinking-level inheritance (fixes the delegate model-default
		 * drop, §2.2). The core resolves the owner's CURRENT model and forwards
		 * it here. When omitted, the agent CLI falls back to its own default.
		 */
		initialModel?: string;
		initialThinkingLevel?: string;
		/**
		 * Source discriminator persisted alongside `delegateOf` so it survives a
		 * restart (orchestration-core §3). Without it, a `host-agents` (or other)
		 * delegate-style child is rebuilt as `childKind:"delegate"` and the
		 * source-filtered `host.agents.*` verbs stop seeing it. Default "delegate".
		 */
		childKind?: string;
		/**
		 * Persisted read-only marker (orchestration-core §2.2). The actual tool
		 * gating is performed by the caller via the `allowedTools` allow-list
		 * (mutating tools stripped, mirroring pr-walkthrough); this flag persists
		 * the intent for restart-rebuild, UI, and cascade parity.
		 */
		readOnly?: boolean;
		/**
		 * NON-SECRET tool-scoping env vars merged into the child process env
		 * (additive, alongside the gateway-set BOBBIT_SESSION_ID/SECRET). Used by
		 * tool policies that read process env (e.g. the pr-walkthrough reviewer's
		 * launched-PR `gh` scoping via `BOBBIT_WALKTHROUGH_TARGET_*`). Plain metadata
		 * ONLY — it never widens the child's sandbox or project (credential) scope.
		 */
		env?: Record<string, string>;
	}): Promise<SessionInfo> {
		const id = randomUUID();
		// Resolve projectId from parent session
		const parentStore = this.resolveStoreForId(parentSessionId);
		const parentProjectId = this.sessions.get(parentSessionId)?.projectId
			?? parentStore?.get(parentSessionId)?.projectId;

		// ── Sandbox propagation from parent ──
		const parentMeta = parentStore?.get(parentSessionId);
		let delegateSandboxed = false;
		if (parentMeta?.sandboxed && !(parentProjectId && isSandboxExemptProject(parentProjectId))) {
			// Always use the parent's validated host-side cwd — never trust the
			// cwd from the container.  The agent sends process.cwd() which is a
			// container-internal path (typically /workspace or a subdir).  Using
			// it directly would either fail (path doesn't exist on host) or, worse,
			// allow a malicious agent to mount an arbitrary host path into the
			// delegate container.
			opts.cwd = parentMeta.cwd;
			delegateSandboxed = true;
		}

		await this.ensureMcpManagerForContext(parentProjectId, opts.cwd);
		const ctx = this.buildPipelineContext(parentProjectId, opts.cwd);

		const titleSummary = opts.title || opts.instructions.split("\n")[0].slice(0, 60) || "Delegate";

		// Inherit tool access from parent session, unless the caller passes an
		// explicit allowedTools override (OrchestrationCore strips spawn verbs).
		const parentSession = this.sessions.get(parentSessionId);

		// ── Goal-metadata inheritance (anti-asymmetry invariant) ──
		// A `team_delegate` sub-agent natively carries only `delegateOf`; it has no
		// `goalId`/`teamGoalId`, so every per-session goal-metadata edge (disabled
		// tools, disabled providers, prompt order) would resolve to {} and the child
		// could re-acquire a tool/provider the goal disabled — a treatment leak.
		// Stamp the PARENT's effective goal as the delegate's `teamGoalId` (NOT
		// `goalId`, so it is treated as a member, not a lead) so the resolver walks
		// the same ancestry and the delegate inherits the same metadata. Prefer the
		// live parent session, then its persisted record (restart/respawn).
		const parentEffectiveGoalId =
			parentSession?.goalId ?? parentSession?.teamGoalId
			?? parentMeta?.goalId ?? parentMeta?.teamGoalId;
		const sourceAllowedTools = opts.allowedTools ?? parentSession?.allowedTools;
		const parentAllowedTools: EffectiveTool[] | undefined = sourceAllowedTools
			? sourceAllowedTools.map(n => tagAllowedTool(n, this.toolManager))
			: undefined;
		// H2 — PERSIST the (already-stripped) allow-list so restart/revive preserves
		// the recursion guard (spawn verbs removed) AND read-only restrictions
		// (mutating tools removed). persistOnce persists `allowedTools` ONLY from
		// `plan.sessionScopedAllowedTools`; without this the child's persisted
		// allowedTools is undefined and a restored child falls back to role defaults
		// — silently re-enabling team_delegate/team_spawn (grandchildren) and the
		// mutating tools a read-only child must never carry.
		const sessionScopedAllowedTools = sourceAllowedTools && sourceAllowedTools.length > 0
			? [...sourceAllowedTools]
			: undefined;
		const directGatewayEnv = !delegateSandboxed
			? this.scopedGatewayEnvForDirectAgent(id, parentProjectId, parentEffectiveGoalId)
			: undefined;

		const plan: SessionSetupPlan = {
			id,
			mode: "delegate",
			title: titleSummary,
			cwd: opts.cwd,
			delegateOf: parentSessionId,
			// Effective-goal stamp (see above): makes the inherited goal metadata
			// available DURING the delegate's own setup pipeline (tool activation /
			// bridge-install / prompt order), not just after the fact.
			teamGoalId: parentEffectiveGoalId,
			// Persist the source discriminator + read-only marker (orchestration-core
			// §3/§2.2) so a delegate-style child (e.g. host-agents) is rebuilt with
			// the correct kind on restart and is enumerable by source-filtered verbs.
			childKind: opts.childKind,
			readOnly: opts.readOnly,
			sandboxed: delegateSandboxed || undefined,
			instructions: opts.instructions,
			context: opts.context,
			effectiveAllowedTools: parentAllowedTools,
			// Persist the stripped allow-list (H2) so restart preserves the
			// recursion + read-only restrictions instead of reverting to role defaults.
			sessionScopedAllowedTools,
			projectId: parentProjectId,
			// Model inheritance (§2.2): forward the resolved owner model/thinking
			// level so a delegate no longer silently drops to the system default.
			initialModel: opts.initialModel,
			initialThinkingLevel: opts.initialThinkingLevel,
			// Caller toolEnv is non-secret metadata. directGatewayEnv is minted by the
			// gateway and spread last so user-supplied env cannot widen the inherited
			// project/session scope.
			env: { ...(opts.env ?? {}), ...(directGatewayEnv ?? {}) },
			bridgeOptions: { cwd: opts.cwd },
		};

		const session = await executePlan(plan, ctx);
		if (parentProjectId) session.projectId = parentProjectId;
		// Persist the effective-goal stamp on BOTH the live session and the store
		// record so it survives restart/respawn (the initial structural put happens
		// inside executePlan; this guarantees the field regardless of plan
		// propagation details). Belt-and-suspenders alongside plan.teamGoalId.
		if (parentEffectiveGoalId) {
			session.teamGoalId = parentEffectiveGoalId;
			this.resolveStoreForSession(session.id).update(session.id, { teamGoalId: parentEffectiveGoalId });
		}

		// Persist with all structural fields (delegateOf is in the initial put, tracked for terminate)
		session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err) => {
			console.error(`[session-manager] Failed to persist delegate session ${id}:`, err);
		}).finally(() => { session.pendingMetadataPersist = undefined; });

		// Send delegate prompt with 30s timeout
		await sendDelegatePrompt(session, opts.instructions, DELEGATE_SPAWN_TIMEOUT_MS);

		console.log(`[session-manager] Created delegate session ${id} (parent: ${parentSessionId}, status: ${session.status})`);
		return session;
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

	/**
	 * Extract concatenated assistant text from a parsed message list (shared by
	 * the live and persisted-transcript output paths).
	 */
	private extractAssistantText(messages: unknown[]): string {
		const texts: string[] = [];
		for (const msg of messages as Array<{ role?: string; content?: unknown }>) {
			if (msg?.role !== "assistant") continue;
			const content = msg.content;
			if (typeof content === "string") {
				texts.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block?.type === "text" && block.text) texts.push(block.text);
				}
			}
		}
		return texts.join("\n\n");
	}

	private async getPersistedSessionMessages(sessionId: string, opts?: { claudeCodeOnly?: boolean; archivedOnly?: boolean }): Promise<unknown[]> {
		const ps = this.resolveStoreForId(sessionId)?.get(sessionId);
		if (!ps?.agentSessionFile) return [];
		if (opts?.archivedOnly && !ps.archived) return [];
		const isClaudeCode = resolveSessionRuntime({ runtime: ps.runtime, modelProvider: ps.modelProvider }) === "claude-code";
		if (opts?.claudeCodeOnly && !isClaudeCode) return [];
		try {
			const safeFile = safePersistedHostAgentSessionFile(ps.agentSessionFile);
			if (!safeFile) return [];
			trustPersistedAgentSessionFile(safeFile);
			const ctx = sessionFsContextForAgentFile(ps, safeFile);
			const content = await sessionFileRead(ctx, safeFile, this.sandboxManager);
			if (!content) return [];
			const messages: unknown[] = [];
			for (const line of content.split(/\r?\n/)) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message" && entry.message) messages.push(isClaudeCode ? withPersistedClaudeCodeMessageTimestamp(entry.message, entry.ts) : entry.message);
				} catch { /* skip malformed line */ }
			}
			return isClaudeCode ? normalizePersistedClaudeCodeAskMessages(messages) : messages;
		} catch {
			return [];
		}
	}

	/**
	 * Claude Code resumes from Claude's session id instead of replaying Bobbit's
	 * JSONL into the bridge, so immediately after gateway restart the live bridge
	 * can have an empty/new-only in-memory snapshot. Prefer the persisted Claude
	 * transcript fallback when it contains more complete history.
	 */
	async hydrateClaudeCodeSnapshotMessages(sessionId: string, liveData: unknown): Promise<unknown> {
		const persisted = await this.getPersistedSessionMessages(sessionId, { claudeCodeOnly: true });
		if (persisted.length === 0) return liveData;
		const liveMessages = Array.isArray(liveData)
			? liveData
			: (liveData && typeof liveData === "object" && Array.isArray((liveData as any).messages) ? (liveData as any).messages : []);
		if (persisted.length <= liveMessages.length) return liveData;
		const messages = truncateLargeToolContentInMessages(persisted) as unknown[];
		if (Array.isArray(liveData)) return messages;
		if (liveData && typeof liveData === "object") return { ...(liveData as Record<string, unknown>), messages };
		return { messages };
	}

	/**
	 * PERF-06: memoized base snapshot for `get_messages` (on-attach, live
	 * `get_messages`, and post-`restart_agent`). Wraps the expensive part of
	 * the pipeline — `rpcClient.getMessages()` (agent-process RPC round-trip
	 * + full-transcript JSON parse) followed by `hydrateClaudeCodeSnapshotMessages`
	 * and `normalizeToolResultErrorSnapshot` — and caches the result on the
	 * session, keyed by `session.eventBuffer.lastSeq`.
	 *
	 * Soundness of the cache key: `emitSessionEvent` is the single emit path
	 * for every live agent event (see its doc comment) and always calls
	 * `session.eventBuffer.push(...)`, bumping `lastSeq`. Every call site
	 * invokes `handleAgentLifecycle(session, event)` — which synchronously
	 * persists new Claude Code transcript rows via
	 * `persistClaudeCodeMessageToTranscript` (a synchronous `fs.appendFileSync`)
	 * — strictly before `emitSessionEvent`. So by the time `lastSeq` advances,
	 * both the agent's own live transcript (what `rpcClient.getMessages()`
	 * returns) AND the persisted-file fallback that
	 * `hydrateClaudeCodeSnapshotMessages` reads have already reflected the
	 * change. A cache hit at an unchanged `lastSeq` is therefore guaranteed
	 * byte-identical to a fresh fetch. Restarts always replace `SessionInfo`
	 * with a brand-new object (fresh `messagesSnapshotCache: undefined`), so
	 * there is no cross-restart collision even though the reseeded
	 * `EventBuffer` can briefly reuse the pre-restart `lastSeq` value.
	 *
	 * Deliberately NOT covered by this cache — callers must still apply these
	 * fresh on every call, cache hit or miss, because they read session-mutable
	 * state that can change independently of `lastSeq` (e.g. a steer dispatched
	 * before the agent has emitted any event yet, or a compaction-sidecar
	 * fallback write on RPC rejection with no preceding event):
	 *   - `spliceInFlightMessage` / `spliceInFlightSteers`
	 *   - `mergeCompactionSidecarIntoMessages` / `mergeSkillSidecarIntoMessages`
	 *   - `truncateLargeToolContentInMessages` / `stampSnapshotOrder`
	 *
	 * Concurrent callers at the same `lastSeq` share one in-flight promise, so
	 * N tabs opening/reconnecting at once trigger exactly one RPC round-trip.
	 */
	async getMessagesSnapshotBase(session: SessionInfo): Promise<{ success: boolean; data?: unknown; error?: string }> {
		const seq = session.eventBuffer.lastSeq;
		const cached = session.messagesSnapshotCache;
		if (cached && cached.seq === seq) return cached.promise;
		const promise = (async (): Promise<{ success: boolean; data?: unknown; error?: string }> => {
			const msgsResp = await session.rpcClient.getMessages();
			if (!msgsResp?.success) return msgsResp;
			const hydrated = await this.hydrateClaudeCodeSnapshotMessages(session.id, msgsResp.data);
			const raw = normalizeToolResultErrorSnapshot(hydrated as any);
			return { ...msgsResp, data: raw };
		})();
		session.messagesSnapshotCache = { seq, promise };
		// Never let a failed fetch poison the cache for the next attempt at the
		// same seq (e.g. a transient RPC timeout) — only successful bases are
		// worth reusing.
		promise.then(
			(r) => { if (!r?.success && session.messagesSnapshotCache?.promise === promise) session.messagesSnapshotCache = undefined; },
			() => { if (session.messagesSnapshotCache?.promise === promise) session.messagesSnapshotCache = undefined; },
		);
		return promise;
	}

	/**
	 * Read a (dormant/non-live) session's final assistant output from its PERSISTED
	 * transcript file. Used as the H1 fallback so a child that completed before a
	 * restart can still be collected via team_wait without a live process.
	 */
	private async getPersistedSessionOutput(sessionId: string): Promise<string> {
		const messages = await this.getPersistedSessionMessages(sessionId);
		return this.extractAssistantText(messages);
	}

	/**
	 * Get the final assistant output from a session's messages. For a dormant /
	 * non-live session (no running agent process) this reads the PERSISTED
	 * transcript instead of querying the placeholder RpcBridge (H1).
	 */
	async getSessionOutput(sessionId: string): Promise<string> {
		const session = this.sessions.get(sessionId);
		if (!session || session.dormant === true) {
			return this.getPersistedSessionOutput(sessionId);
		}

		const msgsResp = await session.rpcClient.getMessages();
		if (!msgsResp.success) return this.getPersistedSessionOutput(sessionId);

		const messages = msgsResp.data?.messages || msgsResp.data;
		if (!Array.isArray(messages)) return "";

		return this.extractAssistantText(messages);
	}

	/** Query the agent for its session file and save metadata to disk */
	/** After compaction, refresh messages and state for all connected clients. */
	async refreshAfterCompaction(session: SessionInfo): Promise<void> {
		try {
			// Send the authoritative cumulative cost before the compacted messages
			// snapshot so clients never fall back to the reduced visible transcript.
			this.broadcastSessionCost(session);

			const msgs = await session.rpcClient.getMessages();
			if (msgs.success) {
				const raw: any = normalizeToolResultErrorSnapshot(msgs.data);
				let data: any = raw;
				if (Array.isArray(raw)) {
					const spliced = spliceInFlightSteers(
						spliceInFlightMessage(raw, session.latestMessageUpdate),
						session.inFlightSteerTexts,
					);
					const withCompaction = mergeCompactionSidecarIntoMessages(session.id, spliced);
					data = truncateLargeToolContentInMessages(withCompaction);
				} else if (raw && Array.isArray(raw.messages)) {
					const spliced = spliceInFlightSteers(
						spliceInFlightMessage(raw.messages, session.latestMessageUpdate),
						session.inFlightSteerTexts,
					);
					const withCompaction = mergeCompactionSidecarIntoMessages(session.id, spliced);
					const truncated = truncateLargeToolContentInMessages(withCompaction);
					data = spliced === raw.messages && truncated === raw.messages && withCompaction === raw.messages
						? raw
						: { ...raw, messages: truncated };
				}
				broadcast(session.clients, { type: "messages", data });
			}
			const st = await session.rpcClient.getState();
			if (st.success) {
				broadcast(session.clients, { type: "state", data: this.withSessionCostInState(session.id, st.data) });
			}
		} catch (err) {
			console.error(`[session-manager] Failed to refresh after compaction for ${session.id}:`, err);
		}
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

	/**
	 * best-ranked model when gateway is configured, otherwise does nothing
	 * (pi-coding-agent uses its own built-in default).
	 */
	private readRoleStringField(role: Role | undefined, field: "model" | "thinkingLevel"): string | undefined {
		const value = role?.[field];
		if (typeof value !== "string") return undefined;
		return value.trim().length > 0 ? value : undefined;
	}

	private resolveRoleModelValue(roleName: string | undefined, projectId: string | undefined): string | undefined {
		if (!roleName) return undefined;
		const cascadeValue = this.readRoleStringField(this.resolveSessionRole(roleName, undefined, projectId), "model");
		if (cascadeValue) return cascadeValue;
		if (!this.configCascade) return undefined;
		try {
			return this.configCascade.resolveRoleModel(roleName, projectId);
		} catch {
			return undefined;
		}
	}

	private resolveRoleThinkingLevelValue(roleName: string | undefined, projectId: string | undefined): string | undefined {
		if (!roleName) return undefined;
		const cascadeValue = this.readRoleStringField(this.resolveSessionRole(roleName, undefined, projectId), "thinkingLevel");
		if (cascadeValue) return cascadeValue;
		if (!this.configCascade) return undefined;
		try {
			return this.configCascade.resolveRoleThinkingLevel(roleName, projectId);
		} catch {
			return undefined;
		}
	}

	/** Resolve a role-level model override for the session, if any. */
	private resolveRoleModel(session: SessionInfo): string | undefined {
		return this.resolveRoleModelValue(session.role, session.projectId);
	}

	/**
	 * Resolve the role's `promptTemplate` for assembly. Prefer the
	 * field-level project→ancestor→server→builtin cascade when a projectId
	 * is in scope so a project-only override of `model` doesn't erase the
	 * inherited promptTemplate (and vice versa). Falls back to the role
	 * manager view for system-scope sessions (no projectId).
	 */
	private resolveRolePromptTemplate(roleName: string, projectId: string | undefined): string | undefined {
		if (projectId && this.configCascade) {
			try {
				const t = this.configCascade.resolveRolePromptTemplate(roleName, projectId);
				if (t) return t;
			} catch { /* fall through */ }
		}
		// The field-level cascade (resolveRolePromptTemplate → resolveRoleField) walks
		// only project/server/builtin role STORES — it does NOT include pack-shipped
		// roles (e.g. `pr-reviewer`, which lives in the marketplace pack resolver and
		// is only surfaced by `resolveRoles`). Fall back to the full cascade-resolved
		// role so a pack role's promptTemplate (carrying its required YAML schema)
		// reaches the system prompt on BOTH spawn and restore. Without this a reviewer
		// child has no schema and "learns it from validation feedback".
		const packTemplate = this.resolveSessionRole(roleName, undefined, projectId)?.promptTemplate;
		if (packTemplate) return packTemplate;
		return this.roleManager?.getRole(roleName)?.promptTemplate;
	}

	/** Resolve a role-level thinkingLevel override for the session, if any. */
	private resolveRoleThinkingLevel(session: SessionInfo): string | undefined {
		return this.resolveRoleThinkingLevelValue(session.role, session.projectId);
	}

	/**
	 * Resolve the model to pin at spawn time for a session, given its role &
	 * project. Mirrors `tryAutoSelectModel`'s precedence: role override →
	 * `default.sessionModel` pref. Returns `undefined` for the aigw-fallback
	 * case so post-spawn discovery + setModel still runs.
	 *
	 * Public so verification-harness and respawn paths can use the same
	 * resolution logic.
	 */
	resolveInitialModel(role: string | undefined, projectId: string | undefined): string | undefined {
		// Role override
		if (role) {
			const m = this.resolveRoleModelValue(role, projectId);
			// Skip models that can't run in an agent session (e.g. google-gemini-cli
			// Code Assist) so a role override doesn't pin an unrunnable provider.
			if (m && /^[^/]+\/.+$/.test(m) && isSessionSelectableModelString(m)) return m;
		}
		// default.sessionModel preference
		const pref = this.preferencesStore?.get("default.sessionModel") as string | undefined;
		if (pref && /^[^/]+\/.+$/.test(pref) && isSessionSelectableModelString(pref)) return pref;
		return undefined;
	}

	/**
	 * Resolve the thinking level to pin at spawn time for a session.
	 * Mirrors `tryApplyDefaultThinkingLevel`: role override →
	 * `default.sessionThinkingLevel` pref → "medium". Returns `undefined`
	 * for invalid values so the agent's built-in default applies.
	 */
	resolveInitialThinkingLevel(role: string | undefined, projectId: string | undefined): string | undefined {
		let candidate: string | undefined;
		if (role) {
			const t = this.resolveRoleThinkingLevelValue(role, projectId);
			const known = isKnownThinkingLevel(t);
			if (known) candidate = known;
		}
		if (!candidate) {
			const pref = this.preferencesStore?.get("default.sessionThinkingLevel") as string | undefined;
			const known = isKnownThinkingLevel(pref);
			if (known) candidate = known;
		}
		if (!candidate) candidate = "medium";
		// Defensive clamp against the resolved spawn model (if known). For
		// non-reasoning models this collapses to "off"; for older Opus models
		// "xhigh" falls back to "high". When no model is resolvable, leave the
		// candidate as-is — the per-session clamp at apply time handles it.
		const initialModelStr = this.resolveInitialModel(role, projectId);
		if (initialModelStr) {
			const slash = initialModelStr.indexOf("/");
			if (slash > 0) {
				const provider = initialModelStr.slice(0, slash);
				const modelId = initialModelStr.slice(slash + 1);
				return clampThinkingLevelForModel(candidate, provider, modelId);
			}
		}
		return candidate;
	}

	/**
	 * Resolve the review/QA model to pin at spawn time. Mirrors the
	 * verification-harness precedence: role override → `default.reviewModel`.
	 */
	resolveInitialReviewModel(role: string | undefined, projectId: string | undefined): string | undefined {
		if (role) {
			const m = this.resolveRoleModelValue(role, projectId);
			if (m && /^[^/]+\/.+$/.test(m) && isSessionSelectableModelString(m)) return m;
		}
		const pref = this.preferencesStore?.get("default.reviewModel") as string | undefined;
		if (pref && /^[^/]+\/.+$/.test(pref) && isSessionSelectableModelString(pref)) return pref;
		return undefined;
	}

	private async tryAutoSelectModel(session: SessionInfo): Promise<void> {
		// If the agent was spawned with `--model <provider>/<modelId>` already,
		// skip the redundant `setModel` RPC — read-back verification still runs
		// and hard-fails on mismatch.
		const spawnPinned = !!session.spawnPinnedModel;
		const persisted = this.resolveStoreForSession(session.id).get(session.id);
		if (resolveSessionRuntime({ runtime: persisted?.runtime, modelProvider: persisted?.modelProvider }) === "claude-code") {
			return;
		}
		const allowSessionModelFallback = this.preferencesStore?.get("allowSessionModelFallback") === true;
		const fallbackSessionModel = this.preferencesStore?.get("default.sessionModel") as string | undefined;

		// Spawn-pinned models are explicit selections too (restore/respawn persisted
		// model, role/default pin from initial setup, or caller-supplied initialModel).
		// Verify the actual bound model before the session becomes idle/live. If the
		// pinned model is stale or unavailable, never fall through to role/default
		// resolution, AIGW discovery, or SDK/provider defaults; with the opt-in policy
		// try only default.sessionModel.
		const pinnedModel = session.spawnPinnedModel;
		if (pinnedModel) {
			const safePinnedModel = sanitizeModelErrorText(pinnedModel);
			let pinnedModelError;
			if (!isSessionSelectableModelString(pinnedModel)) {
				pinnedModelError = new Error(`spawn-pinned model "${safePinnedModel}" is not session-selectable`);
			} else {
				try {
					await applyModelString(session.rpcClient, pinnedModel, {
						sessionManager: this,
						sessionId: session.id,
						contextLabel: "spawn-pinned model",
						skipSetModel: true,
					});
					this._writeModelNameFile(session.id, pinnedModel);
					const slash = pinnedModel.indexOf("/");
					const provider = pinnedModel.slice(0, slash);
					const modelId = pinnedModel.slice(slash + 1);
					this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
					broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
					if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Verified spawn-pinned model "${pinnedModel}" for session ${session.id}`);
					return;
				} catch (err) {
					pinnedModelError = err;
				}
			}

			if (allowSessionModelFallback) {
				let controlledFallbackError;
				if (!fallbackSessionModel) {
					controlledFallbackError = new Error("controlled model fallback is enabled but default.sessionModel is unset");
				} else if (!isSessionSelectableModelString(fallbackSessionModel)) {
					controlledFallbackError = new Error(`controlled model fallback target default.sessionModel="${fallbackSessionModel}" is not session-selectable`);
				} else if (fallbackSessionModel === pinnedModel) {
					controlledFallbackError = new Error(`controlled model fallback target default.sessionModel is the same as failed spawn-pinned model "${safePinnedModel}"`);
				}
				if (!controlledFallbackError && fallbackSessionModel) {
					try {
						const pinnedMsg = sanitizeModelErrorText(pinnedModelError);
						const safeFallbackSessionModel = sanitizeModelErrorText(fallbackSessionModel);
						console.warn(`[session-manager] Spawn-pinned model "${safePinnedModel}" failed for ${session.id}; controlled fallback enabled, trying default.sessionModel="${safeFallbackSessionModel}": ${pinnedMsg}`);
						await applyModelString(session.rpcClient, fallbackSessionModel, {
							sessionManager: this,
							sessionId: session.id,
							contextLabel: "default.sessionModel fallback",
						});
						this._writeModelNameFile(session.id, fallbackSessionModel);
						const slash = fallbackSessionModel.indexOf("/");
						const provider = fallbackSessionModel.slice(0, slash);
						const modelId = fallbackSessionModel.slice(slash + 1);
						this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
						broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
						console.log(`[session-manager] Controlled fallback selected default.sessionModel "${fallbackSessionModel}" for session ${session.id} after spawn-pinned model "${pinnedModel}" failed`);
						return;
					} catch (fallbackErr) {
						controlledFallbackError = fallbackErr;
					}
				}
				const originalMsg = sanitizeModelErrorText(pinnedModelError);
				const fallbackMsg = sanitizeModelErrorText(controlledFallbackError);
				throw new Error(`spawn-pinned model "${safePinnedModel}" failed and controlled fallback did not bind; original error: ${originalMsg}; fallback error: ${fallbackMsg}`);
			}

			console.error(`[session-manager] Spawn-pinned model "${safePinnedModel}" failed for ${session.id}: ${sanitizeModelErrorForLog(pinnedModelError)}`);
			throw (pinnedModelError instanceof Error && pinnedModelError.message === sanitizeModelErrorText(pinnedModelError)) ? pinnedModelError : new Error(sanitizeModelErrorText(pinnedModelError));
		}

		// 0. Role override (highest explicit precedence). If it fails, never fall
		// through to discovery/provider defaults. With the opt-in policy, try only
		// default.sessionModel as the controlled fallback target.
		const roleModel = this.resolveRoleModel(session);
		if (roleModel) {
			const safeRoleModel = sanitizeModelErrorText(roleModel);
			let roleModelError;
			if (!isSessionSelectableModelString(roleModel)) {
				roleModelError = new Error(`role.${session.role}.model "${safeRoleModel}" is not session-selectable`);
			} else {
				try {
					await applyModelString(session.rpcClient, roleModel, {
						sessionManager: this,
						sessionId: session.id,
						contextLabel: `role.${session.role}.model`,
						skipSetModel: spawnPinned && session.spawnPinnedModel === roleModel,
					});
					this._writeModelNameFile(session.id, roleModel);
					const slash = roleModel.indexOf("/");
					const provider = roleModel.slice(0, slash);
					const modelId = roleModel.slice(slash + 1);
					this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
					broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
					console.log(`[session-manager] Set role-override model "${roleModel}" for session ${session.id} (role=${session.role})`);
					return;
				} catch (err) {
					roleModelError = err;
				}
			}

			if (allowSessionModelFallback) {
				let controlledFallbackError;
				if (!fallbackSessionModel) {
					controlledFallbackError = new Error("controlled model fallback is enabled but default.sessionModel is unset");
				} else if (!isSessionSelectableModelString(fallbackSessionModel)) {
					controlledFallbackError = new Error(`controlled model fallback target default.sessionModel="${fallbackSessionModel}" is not session-selectable`);
				} else if (fallbackSessionModel === roleModel) {
					controlledFallbackError = new Error(`controlled model fallback target default.sessionModel is the same as failed role model "${safeRoleModel}"`);
				}
				if (!controlledFallbackError && fallbackSessionModel) {
					try {
						const roleMsg = sanitizeModelErrorText(roleModelError);
						const safeFallbackSessionModel = sanitizeModelErrorText(fallbackSessionModel);
						console.warn(`[session-manager] Role model "${safeRoleModel}" failed for ${session.id}; controlled fallback enabled, trying default.sessionModel="${safeFallbackSessionModel}": ${roleMsg}`);
						await applyModelString(session.rpcClient, fallbackSessionModel, {
							sessionManager: this,
							sessionId: session.id,
							contextLabel: "default.sessionModel fallback",
							skipSetModel: spawnPinned && session.spawnPinnedModel === fallbackSessionModel,
						});
						this._writeModelNameFile(session.id, fallbackSessionModel);
						const slash = fallbackSessionModel.indexOf("/");
						const provider = fallbackSessionModel.slice(0, slash);
						const modelId = fallbackSessionModel.slice(slash + 1);
						this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
						broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
						console.log(`[session-manager] Controlled fallback selected default.sessionModel "${fallbackSessionModel}" for session ${session.id} after role model "${roleModel}" failed`);
						return;
					} catch (fallbackErr) {
						controlledFallbackError = fallbackErr;
					}
				}
				const originalMsg = sanitizeModelErrorText(roleModelError);
				const fallbackMsg = sanitizeModelErrorText(controlledFallbackError);
				throw new Error(`role model "${safeRoleModel}" failed and controlled fallback did not bind; original error: ${originalMsg}; fallback error: ${fallbackMsg}`);
			}

			console.error(`[session-manager] Role model "${safeRoleModel}" failed for ${session.id}: ${sanitizeModelErrorForLog(roleModelError)}`);
			throw (roleModelError instanceof Error && roleModelError.message === sanitizeModelErrorText(roleModelError)) ? roleModelError : new Error(sanitizeModelErrorText(roleModelError));
		}

		if (!this.preferencesStore) return;

		// Check explicit preference first (works for both aigw and public providers).
		// default.sessionModel itself is not fallback-eligible: any malformed,
		// non-session-selectable, unavailable, or read-back-mismatched value fails
		// loudly and never falls through to AIGW or provider defaults.
		const sessionModelPref = this.preferencesStore.get("default.sessionModel") as string | undefined;
		if (sessionModelPref) {
			const safeSessionModelPref = sanitizeModelErrorText(sessionModelPref);
			if (!isSessionSelectableModelString(sessionModelPref)) {
				throw new Error(`default.sessionModel "${safeSessionModelPref}" is not session-selectable`);
			}
			const slash = sessionModelPref.indexOf("/");
			const provider = sessionModelPref.slice(0, slash);
			const modelId = sessionModelPref.slice(slash + 1);
			const preSpawnPinned = spawnPinned && session.spawnPinnedModel === sessionModelPref;
			try {
				// Route through applyModelString to preserve the hard-fail-on-mismatch
				// contract (read-back via getState()) regardless of whether we skipped
				// the redundant setModel RPC because the spawn already pinned the same model.
				await applyModelString(session.rpcClient, sessionModelPref, {
					sessionManager: this,
					sessionId: session.id,
					contextLabel: "default.sessionModel",
					skipSetModel: preSpawnPinned,
				});
				this._writeModelNameFile(session.id, sessionModelPref);
				this.resolveStoreForSession(session.id).update(session.id, { modelProvider: provider, modelId });
				if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Set preferred model "${sessionModelPref}" for session ${session.id}${preSpawnPinned ? " (spawn-pinned)" : ""}`);
				broadcast(session.clients, { type: "state", data: buildModelStateData(provider, modelId) });
				return;
			} catch (err) {
				console.error(`[session-manager] default.sessionModel "${safeSessionModelPref}" failed for ${session.id}; controlled fallback is not eligible for the default session model: ${sanitizeModelErrorForLog(err)}`);
				throw (err instanceof Error && err.message === sanitizeModelErrorText(err)) ? err : new Error(sanitizeModelErrorText(err));
			}
		}

		// Fall back to aigw best-ranked model only when no explicit role/default
		// session model was selected.
		const aigwUrl = getAigwUrl(this.preferencesStore);
		if (!aigwUrl) return;

		let aigwModels;
		try {
			// Use cached model list if fresh (avoids HTTP round-trip per session)
			if (this._aigwModelCache && this._aigwModelCache.url === aigwUrl &&
				Date.now() - this._aigwModelCache.ts < SessionManager.AIGW_CACHE_TTL_MS) {
				aigwModels = this._aigwModelCache.models;
			} else {
				aigwModels = await discoverAigwModels(aigwUrl);
				this._aigwModelCache = { url: aigwUrl, models: aigwModels, ts: Date.now() };
			}
		} catch (err) {
			console.warn(`[session-manager] Failed to discover aigw models for auto-selection:`, err);
			return;
		}
		if (aigwModels.length === 0) return;

		try {
			// F5-model-aigw: role-tier-aware pick — "low" tier roles (docs-writer)
			// get the cheapest discovered model instead of the newest/priciest one
			// every session got before. See selectAigwModelForRoleTier() for why
			// this is availability-safe (always picks among already-discovered
			// models, never a hardcoded literal).
			const roleTierForAigw = this.resolveRoleThinkingLevel(session);
			const modelToUse = selectAigwModelForRoleTier(aigwModels, roleTierForAigw);

			await session.rpcClient.setModel("aigw", modelToUse.id);
			this._writeModelNameFile(session.id, modelToUse.id);
			this.resolveStoreForSession(session.id).update(session.id, { modelProvider: "aigw", modelId: modelToUse.id });
			console.log(`[session-manager] Auto-selected aigw model "${modelToUse.id}" for session ${session.id}${roleTierForAigw === "low" ? " (low-tier role: cheapest discovered model)" : ""}`);

			broadcast(session.clients, { type: "state", data: buildModelStateData("aigw", modelToUse.id) });
		} catch (err) {
			console.warn(`[session-manager] Failed to auto-select model for ${session.id}:`, err);
		}
	}

	/** Apply default thinking level from preferences (per-model). */
	private async tryApplyDefaultThinkingLevel(session: SessionInfo): Promise<void> {
		// 0. Role override (highest non-explicit precedence). Failure is non-fatal
		// — matches the existing thinking-level fallback behaviour.
		const spawnPinnedThinking = session.spawnPinnedThinkingLevel;
		const roleThinking = this.resolveRoleThinkingLevel(session);
		if (roleThinking) {
			if (spawnPinnedThinking === roleThinking) {
				if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Role thinking level "${roleThinking}" already pinned at spawn for ${session.id}`);
				return;
			}
			try {
				await session.rpcClient.setThinkingLevel(roleThinking);
				console.log(`[session-manager] Applied role thinking level "${roleThinking}" for session ${session.id} (role=${session.role})`);
				return;
			} catch (err) {
				console.warn(`[session-manager] Role thinking level "${roleThinking}" failed for ${session.id}:`, err);
				// Fall through to global default — thinking-level mismatch is non-fatal
			}
		}

		// Use the per-model thinking preference (system-scope), default to "medium".
		let level: string | undefined;
		if (this.preferencesStore) {
			level = this.preferencesStore.get("default.sessionThinkingLevel") as string | undefined;
		}
		// Default to "medium" when not configured — matches the Settings page
		// display default and ensures team/delegate agents get an explicit level
		// instead of relying on the agent's built-in default.
		if (!level) level = "medium";
		const knownLevel = isKnownThinkingLevel(level);
		if (!knownLevel) return;
		level = knownLevel;
		// Clamp against the session's current model when known so xhigh on a
		// non-supporting model degrades to high (etc.) at apply time.
		try {
			const persisted = this.resolveStoreForSession(session.id).get(session.id);
			if (persisted?.modelId) {
				const clamped = clampThinkingLevelForModel(level, persisted.modelProvider, persisted.modelId);
				if (clamped) level = clamped;
			}
		} catch { /* best-effort */ }
		if (spawnPinnedThinking === level) {
			if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Default thinking level "${level}" already pinned at spawn for ${session.id}`);
			return;
		}
		try {
			await session.rpcClient.setThinkingLevel(level);
			console.log(`[session-manager] Applied default thinking level "${level}" for session ${session.id}`);
		} catch (err) {
			console.warn(`[session-manager] Failed to apply default thinking level for ${session.id}:`, err);
		}
	}

	async persistSessionMetadata(session: SessionInfo): Promise<void> {
		const maxRetries = 3;
		const delays = [500, 1000, 2000];

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				const stateResp = await session.rpcClient.getState();
				if (!stateResp.success || !stateResp.data?.sessionFile) {
					if (attempt < maxRetries) {
						console.warn(`[session-manager] getState() returned no sessionFile for ${session.id}, retrying...`);
						await new Promise(resolve => setTimeout(resolve, delays[attempt]));
						continue;
					}
					console.error(
						`[session-manager] CRITICAL: Could not get agent session file for ${session.id} after ${maxRetries + 1} attempts. ` +
						`This session will NOT survive a server restart.`,
					);
					return;
				}

				// Store the path as returned by the agent — always in the agent's
				// coordinate system (container path for sandbox, host path for local).
				// The session-fs module handles routing reads/checks to the right place.
				const agentSessionFile = stateResp.data.sessionFile;

				// NEVER pre-create this file. Pi (>=0.77) creates the session JSONL
				// lazily on the first assistant flush with an exclusive `openSync(file, "wx")`.
				// If Bobbit touches the path first, that open throws
				// `EEXIST: file already exists` and the agent loses every transcript
				// write for the session. We only record the path; restoreOneSession()
				// tolerates the file not yet existing (a session that crashed before its
				// first assistant message has no transcript to restore anyway).
				// Pinned by tests/session-manager-no-precreate.test.ts.
				this.resolveStoreForSession(session.id).update(session.id, { agentSessionFile });

				// Write the bobbit sidecar alongside the .jsonl so a future
				// recovery (when sessions.json loses this entry) can restore the
				// ORIGINAL bobbit session id, title, role, team links, and model
				// prefs instead of inventing fresh ones. Fire-and-forget;
				// atomic write makes repeat invocations safe.
				try {
					const ps = this.resolveStoreForSession(session.id).get(session.id);
					if (ps) {
						// pi-coding-agent names .jsonl files after the agent session id
						// (path/<agent-id>.jsonl). Use the basename as a stable id when
						// the rpc response doesn't expose it directly.
						const agentSessionId = (stateResp.data?.sessionId as string | undefined)
							|| path.basename(agentSessionFile).replace(/\.jsonl$/, "");
						const sidecar = buildSessionSidecar(
							ps,
							agentSessionId,
							undefined,
						);
						writeSessionSidecar(agentSessionFile, sidecar);
					}
				} catch (err) {
					console.warn(`[session-manager] Failed to write session sidecar for ${session.id}: ${err}`);
				}
				return; // success
			} catch (err) {
				if (attempt < maxRetries) {
					console.warn(`[session-manager] persistSessionMetadata failed for ${session.id} (attempt ${attempt + 1}), retrying: ${err}`);
					await new Promise(resolve => setTimeout(resolve, delays[attempt]));
				} else {
					console.error(
						`[session-manager] CRITICAL: persistSessionMetadata failed for ${session.id} after ${maxRetries + 1} attempts: ${err}\n` +
						`  This session will NOT survive a server restart.`,
					);
				}
			}
		}
	}

	getSession(id: string): SessionInfo | undefined {
		return this.sessions.get(id);
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
			projectConfigStore: this.projectConfigStore,
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
		const messages = await this.getPersistedSessionMessages(id, { archivedOnly: true });
		return normalizeToolResultErrorSnapshot(truncateLargeToolContentInMessages(messages)) as unknown[];
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
		try {
			if (ps.agentSessionFile && isHostAbsoluteAgentSessionPath(ps.agentSessionFile) && fs.existsSync(ps.agentSessionFile)) {
				const safePath = safePersistedHostAgentSessionFile(ps.agentSessionFile);
				if (safePath) {
					trustPersistedAgentSessionFile(safePath);
					return safePath.replace(/\\/g, "/");
				}
			}

			// The agent CLI slugifies the CWD: replace non-alphanumeric chars with '-', wrap in '--'
			// For sandboxed sessions, the CWD stored in ps.cwd is the host path (set during setup).
			const cwdSlug = "--" + ps.cwd.replace(/[^a-zA-Z0-9]/g, "-") + "--";
			const TOLERANCE_MS = 60_000;

			const sessionRoots = trustedAgentSessionsRoots();

			// Prefer an exact filename/session-id match across all known roots before
			// falling back to timestamp proximity. This preserves historical-root
			// recovery when another root has a different session with the same createdAt.
			for (const sessionsDir of sessionRoots) {
				const cwdDir = path.join(sessionsDir, cwdSlug);
				if (!fs.existsSync(cwdDir)) continue;
				const exactFile = fs.readdirSync(cwdDir).find(f => f.endsWith(`_${ps.id}.jsonl`));
				if (exactFile) {
					const recovered = path.join(cwdDir, exactFile).replace(/\\/g, "/");
					trustPersistedAgentSessionFile(recovered);
					return recovered;
				}
			}

			for (const sessionsDir of sessionRoots) {
				const cwdDir = path.join(sessionsDir, cwdSlug);
				if (!fs.existsSync(cwdDir)) continue;

				const files = fs.readdirSync(cwdDir).filter(f => f.endsWith(".jsonl"));
				if (files.length === 0) continue;

				// Parse timestamp from filename: 2026-04-03T15-15-12-009Z_<uuid>.jsonl
				// Find the file whose timestamp is closest to (and within 60s of) ps.createdAt.
				let bestFile: string | null = null;
				let bestDelta = Infinity;

				for (const file of files) {
					const tsMatch = file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
					if (!tsMatch) continue;
					// Convert filename timestamp back to ISO: replace hyphens in time part with colons.
					const isoStr = tsMatch[1]
						.replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1-$2-$3T$4:$5:$6.$7Z");
					const fileTime = new Date(isoStr).getTime();
					if (isNaN(fileTime)) continue;

					const delta = Math.abs(fileTime - ps.createdAt);
					if (delta < TOLERANCE_MS && delta < bestDelta) {
						bestDelta = delta;
						bestFile = file;
					}
				}

				if (bestFile) {
					const recovered = path.join(cwdDir, bestFile).replace(/\\/g, "/");
					trustPersistedAgentSessionFile(recovered);
					return recovered;
				}
			}
		} catch {
			// Recovery is best-effort — don't break restore flow
		}
		return null;
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

// ── Sandbox credential auto-resolution ─────────────────────────────

import { ensureSandboxAgentAuthFile, fallbackProviderAllowlistFromPrefs, mergeHostAgentProviderEnv, resolveHostTokenValue, resolveSandboxAgentAuthPolicy } from "./host-tokens.js";

/**
 * Map of auth.json provider keys → env vars that pi-coding-agent checks.
 * OAuth providers use their OAuth token env var; API-key providers use the standard key var.
 * Kept for legacy fallback when sandbox_tokens is not set.
 */
const PROVIDER_ENV_MAP: Record<string, { envVar: string; extractKey: (cred: any) => string | undefined }> = {
	anthropic: {
		envVar: "ANTHROPIC_OAUTH_TOKEN",
		extractKey: (cred) => cred?.type === "oauth" ? cred.access : cred?.type === "api_key" ? cred.key : undefined,
	},
	openai: {
		envVar: "OPENAI_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	google: {
		envVar: "GEMINI_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	xai: {
		envVar: "XAI_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	groq: {
		envVar: "GROQ_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	mistral: {
		envVar: "MISTRAL_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
	openrouter: {
		envVar: "OPENROUTER_API_KEY",
		extractKey: (cred) => cred?.type === "api_key" ? cred.key : undefined,
	},
};

/**
 * Resolve sandbox tokens from the unified sandbox_tokens config key.
 * Falls back to legacy behavior (sandbox_credentials + sandbox_host_token_overrides + sandbox_github_token)
 * when sandbox_tokens is not set.
 */
export function resolveSandboxTokens(prefs?: import("./preferences-store.js").PreferencesStore | null, projectConfig?: import("./project-config-store.js").ProjectConfigStore | null, secretsStore?: import("./secrets-store.js").SecretsStore | null): Record<string, string> {
	const entries = projectConfig?.getSandboxTokens() ?? [];

	// ── New unified path: sandbox_tokens is set ──
	if (entries.length > 0) {
		const result: Record<string, string> = {};
		const secrets = secretsStore?.getAll() || {};
		for (const entry of entries) {
			if (!entry.enabled || !entry.key) continue;
			// Check secrets store first, then fall back to inline value (pre-migration).
			const explicitValue = secrets[entry.key] || entry.value;
			if (explicitValue) {
				result[entry.key] = explicitValue;
			} else {
				// Empty value = resolve from host.
				const resolved = resolveHostTokenValue(entry.key, prefs);
				if (resolved) {
					result[entry.key] = resolved;
				}
			}
		}
		return result;
	}

	// ── Legacy fallback: sandbox_tokens not set ──
	return resolveLegacySandboxCredentials(prefs, projectConfig);
}

/**
 * Legacy credential resolution from sandbox_credentials + sandbox_host_token_overrides + sandbox_github_token.
 * Used as fallback when sandbox_tokens is not configured.
 */
export function resolveLegacySandboxCredentials(prefs?: import("./preferences-store.js").PreferencesStore | null, projectConfig?: import("./project-config-store.js").ProjectConfigStore | null): Record<string, string> {
	const result: Record<string, string> = {};

	// 1. Read auth.json
	let authData: Record<string, any> | null = null;
	try {
		const authPath = globalAuthPath();
		if (fs.existsSync(authPath)) {
			authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		}
	} catch {
		// Ignore read errors
	}

	for (const [provider, { envVar, extractKey }] of Object.entries(PROVIDER_ENV_MAP)) {
		const hostEnvVal = process.env[envVar];
		if (hostEnvVal) {
			result[envVar] = hostEnvVal;
			continue;
		}

		if (prefs) {
			const storedKey = prefs.get(`providerKey.${provider}`) as string | undefined;
			if (storedKey) {
				result[envVar] = storedKey;
				continue;
			}
		}

		if (authData && authData[provider]) {
			const key = extractKey(authData[provider]);
			if (key) {
				result[envVar] = key;
			}
		}
	}

	// Auto-detect GITHUB_TOKEN for gh CLI
	const overridesRaw = projectConfig?.get("sandbox_host_token_overrides") || "";
	let tokenOverrides: Record<string, string> = {};
	try { tokenOverrides = overridesRaw ? JSON.parse(overridesRaw) : {}; } catch { /* ignore */ }

	const ghTokenEnabled = tokenOverrides["GITHUB_TOKEN"] !== undefined
		? tokenOverrides["GITHUB_TOKEN"] !== "false"
		: (projectConfig?.get("sandbox_github_token") ?? "true") !== "false";

	if (ghTokenEnabled && !result["GITHUB_TOKEN"]) {
		const hostGhToken = process.env["GITHUB_TOKEN"] || process.env["GH_TOKEN"];
		if (hostGhToken) {
			result["GITHUB_TOKEN"] = hostGhToken;
		} else {
			try {
				const token = execFileSync("gh", ["auth", "token"], { timeout: 5_000, encoding: "utf-8" }).trim();
				if (token) {
					result["GITHUB_TOKEN"] = token;
				}
			} catch {
				// gh not installed or not authenticated — skip
			}
		}
	}

	// Auto-detect NPM_TOKEN if enabled
	const npmTokenEnabled = tokenOverrides["NPM_TOKEN"] !== "false";
	if (npmTokenEnabled && !result["NPM_TOKEN"] && process.env["NPM_TOKEN"]) {
		result["NPM_TOKEN"] = process.env["NPM_TOKEN"];
	}

	// Remove any tokens that are explicitly disabled in overrides
	for (const [envVar, override] of Object.entries(tokenOverrides)) {
		if (override === "false" && result[envVar]) {
			delete result[envVar];
		}
	}

	// Merge manual sandbox_credentials on top
	const credentialsRaw = projectConfig?.get("sandbox_credentials") || "";
	try {
		const credentials: Record<string, string> = credentialsRaw ? JSON.parse(credentialsRaw) : {};
		Object.assign(result, credentials);
	} catch { /* ignore */ }

	return result;
}
