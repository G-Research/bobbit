import type { Clock, CommandRunner } from "../gateway-deps.js";
import { realClock, realCommandRunner } from "../gateway-deps.js";
import type { MessageAuthor } from "../../shared/message-author.js";
import {
	LOCAL_USER_AUTHOR,
	isMessageAuthor,
	isPiTranscriptEntryId,
} from "../../shared/message-author.js";
import type { PromptSource } from "../../shared/prompt-source.js";
import { parseAskResponseEnvelope } from "../../shared/ask-envelope.js";
import type {
	HostInterceptorName,
	HostInterceptorRequest,
	HostNotificationName,
	HostNotificationPayload,
	SessionNotificationName,
} from "../../shared/extension-host/host-hooks.js";
export type { PromptSource } from "../../shared/prompt-source.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { WebSocket } from "ws";
import type {
	ServerMessage,
	QueuedMessage,
	AutoRetryPendingEvent,
	AutoRetryCancelledEvent,
} from "../ws/protocol.js";
import { EventBuffer } from "./event-buffer.js";
import { GoalManager } from "./goal-manager.js";
import { TaskManager } from "./task-manager.js";
import { PromptQueue } from "./prompt-queue.js";
import { SearchService } from "../search/search-service.js";
import { RpcBridge, containerPathToHost, hostPathToContainer, resolveEffectivePiSelection, synthesizeAttachmentText, ATTACHMENT_ONLY_TEXT, type PromptStreamingBehavior, type RpcBridgeOptions, type RuntimePiExtensionInfo, type RuntimePiExtensionDiagnostic } from "./rpc-bridge.js";
import {
	canonicalContainerAgentSessionPath,
	sessionFileDelete,
	sessionFileExists,
	sessionFileRead,
	sessionFsContextForAgentFile,
	sessionSidecarDelete,
} from "./session-fs.js";
import { canPurgeTeamLeadSession } from "./team-store-consistency.js";
import { writeSessionSidecar, buildSessionSidecar } from "./session-sidecar.js";
import {
	appendPromptAuthorDismissalTombstone,
	appendPromptAuthorDispatch,
	appendPromptAuthorSettlement,
	digestPromptModelText,
	extractPromptModelText,
	mergeAuthorSidecarIntoMessages,
	projectCorrelatedPromptMessage,
	promptAuthorBindingMatchesText,
	readAuthorSidecar,
	selectLatestPromptAuthorBinding,
	type PromptAuthorBinding,
} from "./author-sidecar.js";
import {
	buildVisibleMessageSnapshot as buildVisibleMessageSnapshotData,
	correlateTranscriptPromptEntryIds,
	type TranscriptCursorSnapshot,
} from "./visible-message-snapshot.js";
import {
	BATCH_SYSTEM_AUTHOR,
	BOBBIT_SYSTEM_AUTHOR,
	agentAuthorForSession,
	modelPrefixForPromptAuthor,
	normalizeVisibleAgentEvent,
	resolvePromptAuthor,
	type AgentAuthorDependencies,
	type AgentSessionIdentity,
} from "./message-author.js";
import { isWithinAgentSessionsDir, resolveReadablePersistedAgentSessionFile, resolveSafeSessionsPath, restoreAgentTranscriptSnapshot, sanitizeAgentTranscriptFile, trustPersistedAgentSessionFile } from "./transcript-sanitizer.js";
import { isOrphanToolResultOrderingError } from "./poisoned-history.js";
import type { SkillExpansion } from "../skills/resolve-skill-expansions.js";
import type { FileMention } from "../skills/resolve-file-mentions.js";
import {
	appendIdentifiedSkillSidecarEntry,
	appendSkillSidecarTranscriptBinding,
} from "../skills/skill-sidecar.js";
import {
	appendCompactionSidecarEntry,
	makeCompactionId,
	parseCompactionStartMs,
	readCompactionSidecarEntriesStrict,
	resolveCompactionTranscriptEntryId,
	type CompactionSidecarEntry,
	type TranscriptEntriesSnapshot,
} from "./compaction-sidecar.js";
import {
	createContextClearBoundary,
	currentGenerationCompactionIds,
	latestContextClearBoundary,
	normalizeContextClearBoundaries,
	type ContextClearBoundary,
} from "./context-clear-boundary.js";
import {
	SessionStore,
	normalizePersistedInFlightSteers,
	type ContextClearPersistenceShape,
	type InFlightSteerRecord,
	type PersistedSession,
} from "./session-store.js";
import {
	backfillUnansweredAskState,
	hasUnansweredAskUserChoices,
	normalizeDismissedAskToolUseIds,
	successfulPostedAskToolUseId,
} from "./ask-user-choices-dismissal.js";
import { activeTranscriptBranch, parseTranscript } from "./transcript-tree.js";
import { isWorktreePathReferencedByLiveSession, normalizeWorktreeHostPath, type WorktreeReferenceRecord } from "./worktree-reference-guard.js";
import { BgProcessStore } from "./bg-process-store.js";
import { SessionSecretStore } from "../auth/session-secret.js";
import { redactSensitive } from "../auth/redact.js";
import { readToken } from "../auth/token.js";
import { shouldKeepDespiteOrphan, scanOrphanedTranscriptsAsync } from "./orphan-cleanup.js";
import { getAssistantDef, assistantRoleForType, composeAssistantTitle } from "./assistant-registry.js";
import { resolveBundledDocsDir, resolveBundledSrcDir } from "./bundled-paths.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { assembleSystemPrompt, cleanupSessionPrompt, cleanupSessionPromptAsync, persistPromptSections, purgePromptSectionsJsonAsync, type PromptParts } from "./system-prompt.js";
import { profile } from "./profiling.js";
import { cpuDiagnosticsEnabled, getCpuDiagnostics, recordEventLoopOperation } from "./cpu-diagnostics.js";
import { generateSessionTitle, generateGoalSummaryTitle } from "./title-generator.js";
import { CostTracker, type SessionCost } from "./cost-tracker.js";
import type { ColorStore } from "./color-store.js";
import type { RoleManager } from "./role-manager.js";
import type { ScopedToolContext, ToolManager } from "./tool-manager.js";
import { computeToolActivationArgs, writeMcpProxyExtensions, writeToolGuardExtension, computeEffectiveAllowedTools, tagAllowedTools, type EffectiveTool, type GroupPolicyProvider } from "./tool-activation.js";
import { hasProviderBridgeHooks, writeProviderBridgeExtension } from "./provider-bridge-extension.js";
import { prependToolResultErrorBridge } from "./tool-result-error-bridge-extension.js";
import { normalizeToolResultErrorEvent, normalizeToolResultErrorSnapshot } from "./tool-result-error-normalizer.js";
import { writeGoogleCodeAssistProviderExtension } from "./google-code-assist-provider-extension.js";
import { discoverSlashSkills, type SkillMarketContext } from "../skills/slash-skills.js";
import { headquartersDir } from "../bobbit-dir.js";
import { HEADQUARTERS_PROJECT_ID } from "./project-registry.js";
import { normalizeConfigProjectId } from "./config-cascade.js";
import { shouldSkipRemotePush, shouldSkipRemoteGitForTests, shouldSkipRemotePushForTests, detectPrimaryBranch, isGitRepo, getRepoRoot, isUnresolvedHeadWorktreeError, type RemoteGitPolicy } from "../skills/git.js";
import { eagerDeleteRemoteSessionBranch } from "./session-eager-branch-delete.js";
import type { GrantPolicy, Role } from "./role-store.js";
import { applyModelString } from "./review-model-override.js";
import { sanitizeModelErrorForLog, sanitizeModelErrorText } from "./model-error-sanitizer.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import { compactAssistantStreamDelta, reconstructAssistantStreamMessage } from "../../shared/assistant-stream-delta.js";
import { DEFAULT_OVERFLOW_GUARD, describeWsPayload, guardWebSocketOverflow } from "../ws-overflow-guard.js";

let sessionManagerModuleClock: Clock = realClock;

import { McpManager, type MarketplaceMcpResolver, type McpReloadResult } from "../mcp/mcp-manager.js";
import { makeMetaToolName, parseMcpToolName } from "../mcp/mcp-meta.js";
import { isReviewerBusyError, isTransientReviewError, isProviderBackoffError, isRetryableGenericAgentError, isNonRetryableAgentError } from "./verification-logic.js";
import { truncateLargeToolContent } from "./truncate-large-content.js";
import { getAigwUrl, discoverAigwModels, deriveName, normalizeAigwModelString, writeAigwDnsGuardExtension } from "./aigw-manager.js";
import { defaultImageModelPref, getAvailableImageModels, parseImageModelPref } from "./image-generation.js";
import { findSessionSelectableModel, getAvailableModels, modelRecencyRank, resolveModelStateMeta } from "./model-registry.js";
import { isSessionSelectableModelString, isSpawnPinnableModelString } from "./google-code-assist.js";
import { clampThinkingLevel, isKnownThinkingLevel, type ThinkingLevel } from "../../shared/thinking-levels.js";
import { clampThinkingLevelForModel } from "./thinking-level-clamp.js";
import { normalizeTags, removeTag, replaceTag } from "../../shared/session-tags.js";
import { projectSessionListTags, type SessionListTagProjectionContext, type SessionListTagSource } from "./session-list-tags.js";
import { resolveRolePrompt, buildRestoreRolePrompt } from "./role-prompt.js";
import { applyPromptConditionals } from "./prompt-conditionals.js";
import {
	beginSessionPromptActivity,
	cancelPendingSessionPromptActivity,
	cancelSessionPromptActivity,
	commitSessionPromptActivity,
	installSessionActivityAttribution,
	recordSessionEventActivity,
	suppressSessionActivityUntilPrompt,
	type SessionPromptActivityBoundary,
} from "./session-activity.js";
export { isUserVisibleActivity } from "./session-activity.js";
// createWorktree is used in session-setup.ts pipeline
import { ProjectContextManager } from "./project-context-manager.js";
import type { ProjectContext } from "./project-context.js";
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
import { BACKGROUND_IO_CONCURRENCY, mapWithConcurrency, removeTree } from "./bounded-async-work.js";
import { backfillStaffIds as backfillStaffIdsImpl } from "./staff-backfill.js";
import {
	freezeStaffNotificationTurnContext,
	MAX_STAFF_NOTIFICATION_TURN_DEPTH,
	runWithStaffNotificationTurnContext,
	type StaffNotificationTurnContext,
} from "./staff-notification-causation.js";
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
import {
	resolvePackLocalDataEnvironment,
	type PackLocalDataBindingsResolver,
} from "./pack-local-data-runtime.js";


interface PreparedScopedToolRuntime {
	toolManager: ToolManager | undefined;
	groupPolicyStore: GroupPolicyProvider | undefined;
	toolScope: ScopedToolContext;
	piExtensionActivation: MarketplacePiExtensionActivation;
}

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

export function switchSessionPathForAgent(ps: PersistedSession): string {
	if (!ps.sandboxed || !isHostAbsoluteAgentSessionPath(ps.agentSessionFile)) return ps.agentSessionFile;
	const mountedHostPath = migratedActiveAgentSessionFileForHostPath(ps.agentSessionFile) ?? ps.agentSessionFile;
	return hostPathToContainer(mountedHostPath);
}

export type ArchivedWorktreeLegacyStatus = "removable" | "skipped" | "already-cleaned";
export type ArchivedWorktreeDisposition = "ready-to-clean" | "already-cleaned" | "ineligible" | "needs-attention" | "failed";
export type ArchivedWorktreeReason =
	| "safe-archived-session-worktree"
	| "already-cleaned"
	| "no-worktree-path"
	| "missing-repo-path"
	| "sandbox-container-path"
	| "delegate-shared-worktree"
	| "stale-worktree-directory"
	| "referenced-by-live-session"
	| "referenced-by-live-goal"
	| "referenced-by-live-team"
	| "referenced-by-staff"
	| "scan-error";
export type ArchivedWorktreeReasonCategory = "safe" | "already-cleaned" | "missing-metadata" | "container-path" | "shared-delegate" | "stale-path" | "referenced-record" | "error";
export type ArchivedWorktreeSelectionCategory = "archived-session" | "goal-session" | "team-session" | "delegate-session" | "child-session" | "single-repo" | "multi-repo";
export type ArchivedWorktreeCleanupStatus = "cleaned" | "skipped" | "already-cleaned" | "failed";
export type ArchivedWorktreeCleanupReason = "worktree-and-branch-cleaned" | "worktree-cleaned" | "already-cleaned" | "invalid-selection" | ArchivedWorktreeReason;

export class CleanupArchivedSessionWorktreesRequestError extends Error {
	statusCode = 400;
	constructor(message: string) {
		super(message);
		this.name = "CleanupArchivedSessionWorktreesRequestError";
	}
}

export class SessionPinNotFoundError extends Error {
	readonly statusCode = 404;
	constructor(sessionId: string) {
		super(`Session ${sessionId} not found`);
		this.name = "SessionPinNotFoundError";
	}
}

export interface ArchivedSessionWorktreeScanResponse {
	sessions: ArchivedSessionWorktreeSession[];
	items: ArchivedSessionWorktreeItem[];
	counts: {
		archivedSessions: number;
		sessionsWithWorktrees: number;
		removableWorktrees: number;
		skippedWorktrees: number;
		alreadyCleanedWorktrees: number;
		totalItems: number;
		readyToClean: number;
		defaultSelected: number;
		alreadyCleaned: number;
		ineligible: number;
		needsAttention: number;
		failed: number;
		byDisposition: Partial<Record<ArchivedWorktreeDisposition, number>>;
		byReason: Partial<Record<ArchivedWorktreeReason, number>>;
		bySelectionCategory: Partial<Record<ArchivedWorktreeSelectionCategory, number>>;
	};
	groups: ArchivedSessionWorktreeGroup[];
	selectionPresets: ArchivedSessionWorktreeSelectionPreset[];
	generatedAt: number;
}

export interface ArchivedSessionWorktreeGroup {
	key: string;
	label: string;
	description: string;
	disposition: ArchivedWorktreeDisposition;
	reason?: ArchivedWorktreeReason;
	reasonCategory?: ArchivedWorktreeReasonCategory;
	count: number;
	sampleKeys: string[];
	sampleItems: ArchivedSessionWorktreeItem[];
	hasMore: boolean;
	actionable: boolean;
}

export interface ArchivedSessionWorktreeSelectionPreset {
	id: string;
	label: string;
	description: string;
	enabled: boolean;
	count: number;
	worktreeKeys: string[];
	cleanupRequest: CleanupArchivedSessionWorktreesRequest;
}

export interface ArchivedSessionWorktreeSession {
	id: string;
	title: string;
	archivedAt?: number;
	projectId?: string;
	projectName?: string;
	goalId?: string;
	teamGoalId?: string;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	sandboxed?: boolean;
	branch?: string;
	repoPath?: string;
	worktreePath?: string;
	worktrees: ArchivedSessionWorktreeItem[];
}

export interface ArchivedSessionWorktreeItem {
	key: string;
	sessionId: string;
	title: string;
	archivedAt?: number;
	projectId?: string;
	projectName?: string;
	goalId?: string;
	teamGoalId?: string;
	delegateOf?: string;
	parentSessionId?: string;
	childKind?: string;
	sandboxed?: boolean;
	repo: string;
	repoPath: string;
	repoDisplayName: string;
	path: string;
	branch?: string;
	source: "repoWorktrees" | "sessionWorktree";
	pathExists: boolean;
	gitWorktreeMetadataExists: boolean;
	localBranchExists: boolean;
	status: ArchivedWorktreeLegacyStatus;
	reason: ArchivedWorktreeReason;
	detail: string;
	willDeleteBranch: boolean;
	branchDeleteBlockedReason?: "branch-referenced-by-live-record" | "branch-referenced-by-archived-record";
	disposition: ArchivedWorktreeDisposition;
	reasonCategory: ArchivedWorktreeReasonCategory;
	actionable: boolean;
	selectable: boolean;
	defaultSelected: boolean;
	selectionCategories: ArchivedWorktreeSelectionCategory[];
}

export type CleanupArchivedSessionWorktreesRequest =
	| { mode: "all" }
	| { mode: "selected"; sessionIds?: string[]; worktrees?: Array<{ sessionId: string; repo?: string; path?: string; key?: string }> }
	| { mode: "category"; categories: ArchivedWorktreeSelectionCategory[]; projectId?: string; repoPath?: string }
	| { mode: "preset"; presetId: string };

export interface CleanupArchivedSessionWorktreesResponse {
	counts: {
		requested: number;
		cleaned: number;
		branchDeleted: number;
		skipped: number;
		alreadyCleaned: number;
		failed: number;
		worktreeRemoved: number;
		invalidSelection: number;
		notActionable: number;
		byStatus: Partial<Record<ArchivedWorktreeCleanupStatus, number>>;
		byReason: Partial<Record<ArchivedWorktreeCleanupReason, number>>;
	};
	results: ArchivedSessionWorktreeCleanupResult[];
	generatedAt: number;
}

export interface ArchivedSessionWorktreeCleanupResult {
	key: string;
	sessionId: string;
	title?: string;
	repo?: string;
	repoPath?: string;
	path?: string;
	branch?: string;
	status: ArchivedWorktreeCleanupStatus;
	reason?: ArchivedWorktreeCleanupReason;
	detail?: string;
	error?: string;
	worktreeRemoved: boolean;
	branchDeleted: boolean;
}

interface GitWorktreeRef {
	path: string;
	branch?: string;
}

interface GitWorktreeRefs {
	entries: GitWorktreeRef[];
}

interface ArchivedWorktreeGuardRef {
	id?: string;
	repoPath?: string;
	worktreePath?: string;
	cwd?: string;
	branch?: string;
	repoWorktrees?: Record<string, string>;
	archived?: boolean;
	worktreeOwnerSessionId?: string;
}

/** Structural precondition shared by ordinary borrowed leads and adopted workspace owners. */
function isNonSandboxedPolyrepoTeamLead(ps: Pick<PersistedSession, "role" | "goalId" | "teamGoalId" | "sandboxed" | "repoWorktrees">): boolean {
	return ps.role === "team-lead"
		&& !!(ps.teamGoalId ?? ps.goalId)
		&& !ps.sandboxed
		&& !!ps.repoWorktrees
		&& Object.keys(ps.repoWorktrees).length > 0;
}

/**
 * Classify the current live closure owned by one team goal.
 *
 * Every exact non-empty `teamGoalId` match is a durable ownership root,
 * regardless of ancestry. Current TeamStore references supplement those roots;
 * `goalId` alone never does. Descendants use the canonical OR relation.
 */
export function collectTeamOwnedSessionClosure(
	goalId: string,
	live: readonly PersistedSession[],
	referencedIds: ReadonlySet<string> = new Set(),
	errors?: string[],
): Set<string> {
	const byId = new Map(live.map((session) => [session.id, session]));
	const selected = new Set<string>();
	const reportConflict = (session: PersistedSession) => {
		const message = `ownership conflict: ${session.id} belongs to ${session.teamGoalId}`;
		if (errors && !errors.includes(message)) errors.push(message);
	};
	for (const session of live) {
		if (session.teamGoalId === goalId) selected.add(session.id);
	}
	for (const id of referencedIds) {
		const session = byId.get(id);
		if (!session) continue;
		if (session.teamGoalId && session.teamGoalId !== goalId) {
			reportConflict(session);
			continue;
		}
		selected.add(id);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const session of live) {
			if (selected.has(session.id)) continue;
			const childOfSelected = (!!session.delegateOf && selected.has(session.delegateOf))
				|| (!!session.childKind && !!session.parentSessionId && selected.has(session.parentSessionId));
			if (!childOfSelected) continue;
			if (session.teamGoalId && session.teamGoalId !== goalId) {
				reportConflict(session);
				continue;
			}
			selected.add(session.id);
			changed = true;
		}
	}
	return selected;
}

type StrictSandboxWiringOptions = SandboxWiringOptions & { expectedExistingContainerId?: string };

interface ArchivedWorktreeScanContext {
	candidateContexts: ProjectContext[];
	sessionPathRecords: WorktreeReferenceRecord[];
	goalRefs: ArchivedWorktreeGuardRef[];
	teamRefs: ArchivedWorktreeGuardRef[];
	staffRefs: ArchivedWorktreeGuardRef[];
	branchGuardsByRepo: Map<string, Set<string>>;
	archivedBranchGuardsByRepo: Map<string, Map<string, Set<string>>>;
	gitRefsCache: Map<string, Promise<GitWorktreeRefs>>;
	branchExistsCache: Map<string, Promise<boolean>>;
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
	// A cold-restore continuation remains durable until the final canonical bridge
	// accepts it. The provisional restore can already look idle (or be rolled back
	// to a dormant/terminated capsule), so status alone must not clear this marker.
	if (restoreStartupWasStreaming === true) return true;
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
const BOUNDED_TRANSIENT_AUTO_RETRY_MAX_ATTEMPTS = 3;

/** Pi/runtime cancellation has a small, stable terminal vocabulary. Keep this
 * whole-message matcher separate from provider retry classification: a provider
 * diagnostic that merely mentions "aborted" must remain an errored turn. */
function isAbortShapedAssistantTerminal(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const terminal = message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
	if (terminal.role !== "assistant") return false;
	if (terminal.stopReason === "aborted") return true;
	if (terminal.stopReason !== "error" || typeof terminal.errorMessage !== "string") return false;
	const normalized = terminal.errorMessage.trim().replace(/\s+/g, " ").toLowerCase();
	return /^(?:aborted|request (?:was )?aborted|(?:(?:the|this) )?operation (?:was )?aborted|aborterror(?:\s*:\s*(?:(?:the|this) )?operation (?:was )?aborted)?)\.?$/.test(normalized);
}

/** Stable fallback for protocol mocks that omit the normal assistant message ID. */
function assistantTerminalIdentity(message: unknown): string | undefined {
	if (!message || typeof message !== "object") return undefined;
	const terminal = message as { role?: unknown; id?: unknown; stopReason?: unknown; errorMessage?: unknown; content?: unknown };
	if (terminal.role !== "assistant") return undefined;
	if (typeof terminal.id === "string" && terminal.id.length > 0) return `id:${terminal.id}`;
	return JSON.stringify([terminal.stopReason ?? null, terminal.errorMessage ?? null, terminal.content ?? null]);
}

export type ErroredPromptRecoveryDecision =
	| {
		recoverable: true;
		reason: "provider-backoff" | "transient" | "generic" | "poisoned-history";
		attempts: number;
		maxAttempts?: number;
	}
	| {
		recoverable: false;
		reason: "not-errored" | "missing-error" | "non-retryable" | "not-retryable" | "retry-budget-exhausted";
		message: string;
		attempts?: number;
		maxAttempts?: number;
	};

export function classifyErroredPromptRecovery(input: {
	lastTurnErrored?: boolean;
	lastTurnErrorMessage?: string;
	transientRetryAttempts?: number;
}): ErroredPromptRecoveryDecision {
	if (!input.lastTurnErrored) {
		return { recoverable: false, reason: "not-errored", message: "Session is not in an errored turn state." };
	}
	const errMsg = input.lastTurnErrorMessage || "";
	if (!errMsg) {
		return { recoverable: false, reason: "missing-error", message: "Session has no recorded retryable error message." };
	}
	// This Anthropic 400 is not transient, but a user-driven prompt can repair
	// the persisted transcript and respawn the same Bobbit session in place.
	if (isOrphanToolResultOrderingError(errMsg)) {
		return { recoverable: true, reason: "poisoned-history", attempts: 0, maxAttempts: 1 };
	}
	if (isNonRetryableAgentError(errMsg)) {
		return { recoverable: false, reason: "non-retryable", message: "Last session error is non-retryable and requires human/upstream action." };
	}
	if (isProviderBackoffError(errMsg)) {
		return { recoverable: true, reason: "provider-backoff", attempts: input.transientRetryAttempts ?? 0 };
	}
	const isTransient = isTransientReviewError(errMsg);
	const isGeneric = !isTransient && isRetryableGenericAgentError(errMsg);
	if (!isTransient && !isGeneric) {
		return { recoverable: false, reason: "not-retryable", message: "Last session error is not classified as retryable/transient." };
	}
	const attempts = input.transientRetryAttempts ?? 0;
	if (attempts >= BOUNDED_TRANSIENT_AUTO_RETRY_MAX_ATTEMPTS) {
		return {
			recoverable: false,
			reason: "retry-budget-exhausted",
			message: "Retryable session error has exhausted its automatic retry budget and requires human/upstream action.",
			attempts,
			maxAttempts: BOUNDED_TRANSIENT_AUTO_RETRY_MAX_ATTEMPTS,
		};
	}
	return {
		recoverable: true,
		reason: isGeneric ? "generic" : "transient",
		attempts,
		maxAttempts: BOUNDED_TRANSIENT_AUTO_RETRY_MAX_ATTEMPTS,
	};
}

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

const GITHUB_PR_URL_CANDIDATE_RE = /(?:^|[\s([<{>"'`])(https:\/\/[^\s<>"'`]+)/gimu;
const TRAILING_URL_PUNCTUATION_RE = /[)\]}>.,;:!?]+$/u;
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GITHUB_REPOSITORY_RE = /^[A-Za-z0-9._-]+$/u;
const GITHUB_PR_NUMBER_RE = /^[1-9]\d*$/u;

/** Detect a canonical GitHub pull-request URL without trusting substring matches. */
export function containsExactGithubPullRequestUrl(text: string): boolean {
	GITHUB_PR_URL_CANDIDATE_RE.lastIndex = 0;
	for (const match of text.matchAll(GITHUB_PR_URL_CANDIDATE_RE)) {
		const candidate = match[1]?.replace(TRAILING_URL_PUNCTUATION_RE, "");
		if (!candidate) continue;
		let parsed: URL;
		try {
			parsed = new URL(candidate);
		} catch {
			continue;
		}
		const rawAuthority = candidate.slice("https://".length).split(/[/?#]/u, 1)[0]?.toLowerCase();
		if (
			parsed.protocol !== "https:"
			|| rawAuthority !== "github.com"
			|| parsed.host !== "github.com"
			|| parsed.username !== ""
			|| parsed.password !== ""
			|| parsed.search !== ""
			|| parsed.hash !== ""
		) continue;

		const segments = parsed.pathname.split("/");
		if (segments.at(-1) === "") segments.pop();
		if (
			segments.length === 5
			&& segments[0] === ""
			&& GITHUB_OWNER_RE.test(segments[1] ?? "")
			&& GITHUB_REPOSITORY_RE.test(segments[2] ?? "")
			&& segments[3] === "pull"
			&& GITHUB_PR_NUMBER_RE.test(segments[4] ?? "")
		) return true;
	}
	return false;
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

export type { InFlightSteerRecord } from "./session-store.js";

export interface PendingPromptAuthorRecord {
	/** Durable sidecar/queue correlation id; retries may reuse it. */
	promptId: string;
	/** Stable accepted occurrence identity. Absent only on legacy dispatches. */
	intentId?: string;
	/** Explicit identity for this one Pi delivery attempt. */
	attemptId?: string;
	/** Persisted dispatch evidence used to distinguish modern attempts from legacy rows. */
	dispatchEpoch?: number;
	dispatchedAt: number;
	/** Exact Pi text exists only for current-process dispatches. Restored v2 rows use the digest. */
	modelText?: string;
	modelTextDigest?: string;
	/** Exact author prefix injected into `modelText`; absent for unprefixed/degraded dispatches. */
	modelPrefix?: string;
	source: PromptSource;
	author: MessageAuthor;
}

interface LivePromptAuthorMessageBinding {
	promptId: string;
	intentId?: string;
	/** Current-process attempt identity; restored modern bindings retain the persisted attempt id. */
	attemptId?: string;
	dispatchEpoch?: number;
	author: MessageAuthor;
	settled: boolean;
	/** This digest-only binding survives the transient restore cursor because its keyless occurrence may replay late. */
	ambiguityFence?: true;
	/** Exact Pi text is retained only in memory for live occurrence matching. */
	modelText?: string;
	modelTextDigest?: string;
	modelPrefix?: string;
}

type ReplayPromptAuthorBinding = LivePromptAuthorMessageBinding;

export interface PromptAuthorTombstoneBudget {
	maxCount: number;
	maxBytes: number;
}

export interface PromptAuthorAmbiguityFences {
	bindings: ReplayPromptAuthorBinding[];
	residentBytes: number;
	/** Once correlation history is dropped, raw/keyless pre-ack echoes fail closed. */
	overflowed: boolean;
}

export const DEFAULT_PROMPT_AUTHOR_TOMBSTONE_BUDGET: Readonly<PromptAuthorTombstoneBudget> = {
	maxCount: 256,
	maxBytes: 64 * 1024,
};

export type ModelSelectionRequiredCondition = Readonly<{
	code: "MODEL_SELECTION_REQUIRED";
	provider: string;
	modelId: string;
}>;

export class ModelSelectionRequiredError extends Error {
	readonly code = "MODEL_SELECTION_REQUIRED";
	readonly provider: string;
	readonly modelId: string;

	constructor(condition: ModelSelectionRequiredCondition) {
		super(
			`Model ${condition.provider}/${condition.modelId} is no longer available. ` +
			"Choose a replacement model before sending a prompt.",
		);
		this.name = "ModelSelectionRequiredError";
		this.provider = condition.provider;
		this.modelId = condition.modelId;
	}
}

export class ModelSelectionRecoveryError extends Error {
	readonly code = "MODEL_RECOVERY_FAILED";
	readonly retryable: boolean;

	constructor(provider: string, modelId: string, reason: unknown, options?: { retryable?: boolean }) {
		const retryable = options?.retryable !== false;
		super(retryable
			? `Could not activate replacement model ${sanitizeModelErrorText(`${provider}/${modelId}`)}. ` +
				`Choose another available model or retry. ${sanitizeModelErrorText(reason)}`
			: `Could not safely activate replacement model ${sanitizeModelErrorText(`${provider}/${modelId}`)}. ` +
				"The original conversation transcript could not be restored. Do not retry model selection; " +
				"ask an administrator to inspect the server logs and restore the transcript before continuing.",
		);
		this.name = "ModelSelectionRecoveryError";
		this.retryable = retryable;
	}
}

/** Owner termination is rejected before any lifecycle mutation while another live session borrows its worktree. */
export class SharedWorktreeInUseError extends Error {
	readonly code: string = "SHARED_WORKTREE_IN_USE";

	constructor(ownerSessionId: string) {
		super(`Session ${ownerSessionId} cannot be terminated while another live session is using its worktree`);
		this.name = "SharedWorktreeInUseError";
	}
}

/** Backward-compatible sandbox-specific conflict identity and response code. */
export class SharedSandboxWorktreeInUseError extends SharedWorktreeInUseError {
	override readonly code: string = "SHARED_SANDBOX_WORKTREE_IN_USE";

	constructor(ownerSessionId: string) {
		super(ownerSessionId);
		this.message = `Session ${ownerSessionId} cannot be terminated while another live session is using its sandbox worktree`;
		this.name = "SharedSandboxWorktreeInUseError";
	}
}

type SandboxWorktreeOwnerCoordinates = { root: string; name: string };

type SandboxWorktreeOwnerRecord = Pick<
	PersistedSession,
	"branch" | "cwd" | "worktreePath"
>;

/** Derive removal authority from the owner's branch, never from a nested cwd suffix. */
function sandboxWorktreeOwnerCoordinates(
	session: SandboxWorktreeOwnerRecord,
): SandboxWorktreeOwnerCoordinates | undefined {
	const cwd = normalizeWorktreeHostPath(session.cwd);
	if (session.branch) {
		const root = `/workspace-wt/${session.branch}`;
		const normalizedRoot = normalizeWorktreeHostPath(root);
		if (cwd && normalizedRoot && (cwd === normalizedRoot || cwd.startsWith(`${normalizedRoot}/`))) {
			return { root, name: session.branch };
		}
		return undefined;
	}
	if (!session.worktreePath?.startsWith("/workspace-wt/")) return undefined;
	const root = session.worktreePath.replace(/\/$/, "");
	const normalizedRoot = normalizeWorktreeHostPath(root);
	if (!normalizedRoot || !cwd || (cwd !== normalizedRoot && !cwd.startsWith(`${normalizedRoot}/`))) {
		return undefined;
	}
	const name = root.slice("/workspace-wt/".length);
	return name ? { root, name } : undefined;
}

export type HostSessionNotificationName = SessionNotificationName | Extract<HostNotificationName, "sessionStatusChanged">;

export interface HostSessionNotificationPublication<N extends HostSessionNotificationName> {
	projectId: string;
	sessionId: string;
	aggregateId: string;
	aggregateRevision?: string | number;
	payload: Readonly<HostNotificationPayload<N>>;
}

/** Narrow post-authority port; the Extension Host dispatcher owns validation and fanout. */
export interface HostSessionNotificationPublisher {
	publish<N extends HostSessionNotificationName>(name: N, publication: HostSessionNotificationPublication<N>): unknown;
}

export interface SessionHostInterceptorPort {
	dispatch(name: string, input: Record<string, unknown>, context: Record<string, unknown>): Promise<any>;
	hasAny?(names: readonly string[], projectId?: string, goalId?: string): boolean;
	requiresFailClosed?(name: string, projectId?: string, goalId?: string): boolean;
}

type ToolCallLifecyclePhase =
	| "observed"
	| "before-running"
	| "admitted"
	| "after-running"
	| "after-applied"
	| "ended";

interface ToolCallLifecycleEntry {
	toolCallId: string;
	toolName: string;
	generation: number;
	turnIndex: number;
	startedAt: number;
	startCursor?: number;
	phase: ToolCallLifecyclePhase;
	lease: number;
	controller: AbortController;
	status?: "succeeded" | "errored";
	errorStatus?: "handler_error";
}

interface ToolCallBeforeWaiter {
	toolCallId: string;
	toolName: string;
	generation: number;
	timer: ReturnType<typeof setTimeout>;
	resolve: (claim: ToolCallInterceptorClaim | undefined) => void;
}

declare const toolCallInterceptorClaimBrand: unique symbol;
/** Opaque, process-local authority for one exact host-observed Pi tool boundary. */
export type ToolCallInterceptorClaim = {
	readonly [toolCallInterceptorClaimBrand]: true;
};

interface OwnedToolCallInterceptorClaim {
	kind: "before" | "after";
	session: SessionInfo;
	entry: ToolCallLifecycleEntry;
	generation: number;
	lease: number;
	settled: boolean;
}

const MAX_TRACKED_HOST_TOOL_CALLS = 128;
const TOOL_CALL_START_ARRIVAL_GRACE_MS = 100;
const MAX_HOST_TOOL_IDENTITY_LENGTH = 512;

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
	rpcClient: RpcBridge;
	/** Pi extension/schema snapshot owned by the currently installed runtime. */
	runtimePiExtensions?: RuntimePiExtensionInfo[];
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
	/** This writable session uses another session's worktree but never owns its teardown. */
	borrowsWorktree?: boolean;
	/** Flattened session id of the sandbox worktree lifecycle owner. Provenance only. */
	borrowedWorktreeOwnerSessionId?: string;
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
	/**
	 * Subset of recovered IDs owned by a user-initiated poisoned-history repair.
	 * Unlike ordinary failed-dispatch copies, these accepted rows are not
	 * superseded by a later generic error unstick before Pi accepts them.
	 */
	poisonRecoveryPromptDispatchQueueIds?: string[];
	/** Exact durable row owned by an explicit Retry until canonical dispatch accepts it. */
	explicitRetryQueueRowId?: string;
	/** Error message captured when restoreSession() failed; cleared on successful revive. */
	restoreError?: string;
	/** Orthogonal recovery condition for a durable model tuple omitted from the current catalog. */
	condition?: ModelSelectionRequiredCondition;
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
	/** Staged candidates verify without advancing shared durable/client authority. */
	_deferVerifiedTupleCommit?: boolean;
	/** Exact recovery candidates must never use the opt-in controlled fallback. */
	_disableControlledModelFallback?: boolean;
	/** True if the last agent turn ended due to a model/API error */
	lastTurnErrored?: boolean;
	/** Error message from the last errored turn (e.g. streaming JSON parse failure) */
	lastTurnErrorMessage?: string;
	/** The current turn's assistant terminal was a narrow Pi/runtime cancellation. */
	abortShapedTerminal?: boolean;
	/** Every terminal assistant identity seen in this turn, retained through its final boundary. */
	assistantTerminalIdentities?: Set<string>;
	/** Latest distinct terminal assistant identity for diagnostics. */
	lastAssistantTerminalIdentity?: string;
	/** Deduplicates repeated/late final agent_end frames within one turn. */
	turnTerminalHandled?: boolean;
	/** Host-only causal binding for one exact notification-triggered staff turn. */
	staffNotificationTurnContext?: StaffNotificationTurnContext;
	/** Last turn index whose canonical agent_start notification was published. */
	hostTurnStartedIndex?: number;
	/** Bounded, metadata-only tool provenance created only by accepted Pi lifecycle events. */
	hostToolCallLifecycle?: Map<string, ToolCallLifecycleEntry>;
	/** Bounded pre-arrival reservations for HTTP callbacks that race Pi stdout. */
	hostToolCallBeforeWaiters?: Map<string, ToolCallBeforeWaiter>;
	/** Post-authority status observer installed by SessionManager. */
	onStatusChanged?: import("./session-status.js").BroadcastableSession["onStatusChanged"];
	/** Called only after a live event entered EventBuffer and its legacy frame was queued. */
	onEventAccepted?: (event: unknown, cursor: number) => void;
	/** A non-retryable terminal failure left durable work parked for manual Retry. */
	manualRetryRequired?: boolean;
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
	/** Monotonic diagnostic count of inbound events that advance a canonical Pi
	 * turn. Dispatch acceptance uses exact prompt activity boundaries instead. */
	agentObservedTurnVersion?: number;
	/** Last user prompt text, for retry on fresh-response errors */
	lastPromptText?: string;
	/** Last user prompt images, for retry on fresh-response errors */
	lastPromptImages?: Array<{ type: "image"; data: string; mimeType: string }>;
	/** Provenance of the last prompt enqueued to this session. Set by
	 *  enqueuePrompt / deliverLiveSteer. Defaults to "user" when callers
	 *  don't supply a source. Read by TeamManager.subscribeTeamLeadEvents. */
	lastPromptSource?: PromptSource;
	/** Author binding for prompts dispatched but not yet echoed by Pi. */
	pendingPromptAuthors?: PendingPromptAuthorRecord[];
	/** Stable Pi-message-id bindings. Retained after settlement so duplicate
	 * update/end replay cannot consume a later identical-text prompt record. */
	promptAuthorMessageBindings?: Map<string, LivePromptAuthorMessageBinding>;
	/** Restore-only FIFO cursor of non-cancelled prompt occurrences. A completed
	 * replay occurrence is removed only at its terminal frame; its last-terminal
	 * guard still makes duplicate keyless ends idempotent until the next start. */
	promptAuthorReplayBindings?: ReplayPromptAuthorBinding[];
	/** Bounded digest-only history of cancelled and settled-keyless occurrences used to fence late replay. */
	promptAuthorAmbiguityFences?: PromptAuthorAmbiguityFences;
	/** Test-only per-session admission budget; production uses the exported default. */
	promptAuthorTombstoneBudget?: PromptAuthorTombstoneBudget;
	/** Last keyless terminal occurrence within one live lifecycle boundary. */
	lastKeylessPromptAuthorEnd?: ReplayPromptAuthorBinding;
	/** Pending grant request from the guard extension's long-poll */
	pendingGrantRequest?: {
		resolve: (result: ToolGrantResolution) => void;
		reject: (err: Error) => void;
		id: string;
		toolName: string;
		toolGroup: string;
		timer: ReturnType<typeof setTimeout>;
		/** Same-tool parallel guard calls waiting on the same user decision. */
		requests?: Array<{
			resolve: (result: ToolGrantResolution) => void;
			reject: (err: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			seq: number;
			ts: number;
		}>;
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
	pendingSkillExpansions?: PendingSkillSidecarEnvelope[];
	/** Settled raw Pi occurrences awaiting an authoritative snapshot/cursor pair. */
	pendingSkillTranscriptBindings?: PendingSkillTranscriptBinding[];
	/** Repo path (cached from worktree provisioning). */
	repoPath?: string;
	/** Active branch name. Mirrors the persisted store; stable for the session's lifetime. */
	branch?: string;
	/** @deprecated Legacy inert metadata exposed only while restoring older records. */
	worktreePushPolicy?: "local-only" | "publish";
	/** @deprecated Legacy inert alias exposed only while restoring older records. */
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
	inFlightSteerTexts?: InFlightSteerRecord[];
	/** Serializes live steer RPCs so equal-text occurrences retain FIFO identity. */
	_reliableSteerDispatchTail?: Promise<void>;
	/** The one active compaction release token and its bounded duplicate fence. */
	_reliableCompactionId?: string;
	_reliableCompactionReason?: "manual" | "threshold" | "overflow" | string;
	_reliableFinishedCompactionIds?: Set<string>;
	/** A compaction end observed while Stop owns the turn; released by replacement. */
	_reliableCompactionReleaseDeferred?: boolean;
	/**
	 * Pi keeps its run active after the final agent_end while post-run work such
	 * as threshold compaction completes. Only agent_settled proves that a fresh
	 * prompt RPC can start. Undefined preserves compatibility with old/replayed
	 * lifecycles that never emitted agent_start/agent_settled.
	 */
	_piAgentRunSettled?: boolean;
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
	/** Previous reconstructed assistant stream message used to build compact live deltas. */
	previousAssistantStreamMessage?: any;
	/** Bobbit occurrence id for the assistant stream currently entering the live transcript. */
	activeAssistantStreamId?: string;
	/** Provisional length-limited tail awaiting Pi's overflow retry decision. */
	pendingRecoverableLengthStreamId?: string;
	/**
	 * Memoized agent snapshot base (RPC response plus error normalization), keyed
	 * by the event buffer's monotonic sequence. Mutable overlays and sidecars are
	 * deliberately applied by callers on every response.
	 */
	messagesSnapshotCache?: {
		seq: number;
		promise: Promise<MessageSnapshotBaseResponse>;
	};
	/** Monotonic fence preventing an older cursor refresh from broadcasting after a newer one. */
	promptCursorRefreshGeneration?: number;
	/** Cursor ids aligned to one exact immutable get_messages base object. */
	messagesSnapshotCursorProjection?: {
		seq: number;
		data: unknown;
		entryIds: readonly (string | undefined)[];
	};
}

interface MessageSnapshotBaseResponse {
	success: boolean;
	data?: unknown;
	error?: string;
	cursorEntryIds?: readonly (string | undefined)[];
}

interface PendingSkillSidecarEnvelope {
	modelText: string;
	originalText: string;
	skillExpansions: SkillExpansion[];
	fileMentions?: FileMention[];
	recordId?: string;
	promptId?: string;
}

interface PendingSkillTranscriptBinding {
	recordId: string;
	promptId: string;
	modelText: string;
	messageIdentity: { id: string } | { timestamp: number };
}

/** Exact canonical bridge identity required by ownership-sensitive respawns. */
export type SessionBridgeOwner = {
	session: Pick<SessionInfo, "id" | "rpcClient">;
	rpcClient: SessionInfo["rpcClient"];
};

type LifecycleScopeSource = Pick<SessionInfo | PersistedSession,
	"projectId" | "goalId" | "teamGoalId" | "role" | "cwd" | "worktreePath" | "repoPath" | "repoWorktrees">;

/**
 * Convert the live session's per-repo worktree rows to the persisted mapping
 * expected by the event-local scope resolver. This is coordinate plumbing only:
 * the hub remains the sole scope-context construction boundary.
 */
function lifecycleScopeInput(source: LifecycleScopeSource): {
	projectId?: string;
	goalId?: string;
	roleName?: string;
	cwd: string;
	worktreePath?: string;
	repoPath?: string;
	repoWorktrees?: Readonly<Record<string, string>>;
} {
	const repoWorktrees = Array.isArray(source.repoWorktrees)
		? Object.fromEntries(source.repoWorktrees.map(({ repo, worktreePath }) => [repo, worktreePath]))
		: source.repoWorktrees;
	return {
		projectId: source.projectId,
		goalId: source.goalId ?? source.teamGoalId,
		roleName: source.role,
		cwd: source.cwd,
		worktreePath: source.worktreePath,
		repoPath: source.repoPath,
		repoWorktrees,
	};
}

export type VerifiedSessionModelTuple = {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
};

type SetupInitialThinkingAuthority = Readonly<{
	initialThinkingLevel: ThinkingLevel;
}>;

// `spliceInFlightMessage` lives in its own module so unit tests can import
// it without dragging in the full session-manager module graph (which
// transitively pulls flexsearch, pi-coding-agent, etc.). Re-exported here
// for backwards compat with existing call sites.
export { spliceInFlightMessage, spliceInFlightSteers } from "./splice-inflight-message.js";
import { spliceInFlightMessage } from "./splice-inflight-message.js";

function resolveAcceptedPromptAuthor(source: PromptSource, explicit?: MessageAuthor): MessageAuthor {
	if (source === "agent") {
		return resolvePromptAuthor(source, {
			agentAuthor: isMessageAuthor(explicit) && explicit.kind === "agent" ? explicit : undefined,
		});
	}
	return resolvePromptAuthor(source, {
		systemAuthor: isMessageAuthor(explicit) && explicit.kind === "system" ? explicit : undefined,
	});
}

export interface PreparedPromptAuthorDispatch {
	/** Stable accepted occurrence identity. Absent on legacy dispatch paths. */
	intentId?: string;
	/** Unique identity for this one Pi RPC; never a durable queue-row id. */
	attemptId: string;
	/** Durable sidecar/queue correlation id, intentionally separate from attemptId. */
	promptId: string;
	/** Monotonic evidence persisted with this exact attempt. */
	dispatchEpoch?: number;
	/** Exact text for this one Pi RPC. Durable queues and recovery state keep the base text. */
	piText: string;
	modelPrefix?: string;
	pending: PendingPromptAuthorRecord;
	sidecarPersisted: boolean;
}

/**
 * Persist the exact accountable Pi text before exposing an author prefix to Pi.
 * If persistence is unavailable, dispatch this occurrence with its unprefixed
 * base text and retain only a best-effort in-memory author binding.
 */
export function preparePromptAuthorDispatch(
	session: SessionInfo,
	promptId: string,
	baseModelText: string,
	source: PromptSource,
	author: MessageAuthor,
	now: number,
	evidence?: { intentId: string; attemptId?: string; dispatchEpoch?: number },
): PreparedPromptAuthorDispatch {
	const desiredPrefix = modelPrefixForPromptAuthor(author);
	const desiredPiText = desiredPrefix ? `${desiredPrefix}${baseModelText}` : baseModelText;
	// A proven-no-start redrive keeps its logical reliable attempt. Re-appending
	// that exact identity supersedes its cancellation marker without multiplying
	// sidecar bindings for one verifier receipt.
	const attemptId = evidence?.attemptId ?? promptAttemptId("attempt");
	const dispatchEpoch = evidence ? evidence.dispatchEpoch ?? now : undefined;
	const sidecarPersisted = appendPromptAuthorDispatch(session.id, {
		schemaVersion: 2,
		type: "prompt-author",
		promptId,
		...(evidence ? { intentId: evidence.intentId, attemptId, dispatchEpoch } : {}),
		dispatchedAt: now,
		modelText: desiredPiText,
		source,
		author,
		...(desiredPrefix === undefined ? {} : { modelPrefix: desiredPrefix }),
	});
	const piText = sidecarPersisted ? desiredPiText : baseModelText;
	const modelPrefix = sidecarPersisted ? desiredPrefix : undefined;
	const modelTextDigest = digestPromptModelText(piText);
	const pending: PendingPromptAuthorRecord = {
		promptId,
		...(evidence ? { intentId: evidence.intentId, attemptId, dispatchEpoch } : { attemptId }),
		dispatchedAt: now,
		modelText: piText,
		...(modelTextDigest === undefined ? {} : { modelTextDigest }),
		...(modelPrefix === undefined ? {} : { modelPrefix }),
		source,
		author,
	};
	if (!session.pendingPromptAuthors) session.pendingPromptAuthors = [];
	session.pendingPromptAuthors.push(pending);
	const skillEnvelope = session.pendingSkillExpansions?.find((entry) =>
		entry.promptId === undefined && entry.modelText === baseModelText,
	);
	if (skillEnvelope) skillEnvelope.promptId = promptId;
	// A newly accepted same-text occurrence supersedes only the live keyless
	// terminal guard. Restore replay guards remain authoritative until replay ends.
	session.lastKeylessPromptAuthorEnd = undefined;
	return {
		...(evidence ? { intentId: evidence.intentId, dispatchEpoch } : {}),
		attemptId,
		promptId,
		piText,
		...(modelPrefix === undefined ? {} : { modelPrefix }),
		pending,
		sidecarPersisted,
	};
}

function promptAuthorAmbiguityFenceOwner(session: SessionInfo): PromptAuthorAmbiguityFences {
	return session.promptAuthorAmbiguityFences ??= {
		bindings: [],
		residentBytes: 0,
		overflowed: false,
	};
}

function promptAuthorAmbiguityFenceBytes(binding: ReplayPromptAuthorBinding): number {
	return Buffer.byteLength(JSON.stringify(binding), "utf8");
}

/** Single bounded admission boundary shared by live rejection and sidecar hydration. */
function retainPromptAuthorAmbiguityFence(
	session: SessionInfo,
	pending: Pick<PendingPromptAuthorRecord, "promptId" | "intentId" | "attemptId" | "dispatchEpoch" | "modelText" | "modelTextDigest" | "modelPrefix" | "author">,
): void {
	const owner = promptAuthorAmbiguityFenceOwner(session);
	const attemptId = pending.attemptId ?? pending.promptId;
	if (owner.bindings.some((binding) => (binding.attemptId ?? binding.promptId) === attemptId)) return;
	const modelTextDigest = pending.modelTextDigest
		?? (pending.modelText === undefined ? undefined : digestPromptModelText(pending.modelText));
	// Raw prompt bodies are never retained. Without the keyed digest, membership
	// is unknowable, so future ambiguous pre-ack echoes fail closed.
	if (!modelTextDigest) {
		owner.overflowed = true;
		return;
	}
	const binding: ReplayPromptAuthorBinding = {
		promptId: pending.promptId,
		...(pending.intentId === undefined ? {} : { intentId: pending.intentId }),
		attemptId,
		...(pending.dispatchEpoch === undefined ? {} : { dispatchEpoch: pending.dispatchEpoch }),
		author: pending.author,
		settled: true,
		ambiguityFence: true,
		modelTextDigest,
		...(pending.modelPrefix === undefined ? {} : { modelPrefix: pending.modelPrefix }),
	};
	const bytes = promptAuthorAmbiguityFenceBytes(binding);
	const budget = session.promptAuthorTombstoneBudget ?? DEFAULT_PROMPT_AUTHOR_TOMBSTONE_BUDGET;
	if (owner.bindings.length >= budget.maxCount || bytes > budget.maxBytes - owner.residentBytes) {
		owner.overflowed = true;
		return;
	}
	owner.bindings.push(binding);
	owner.residentBytes += bytes;
}

function findPromptAuthorAmbiguityFence(
	session: SessionInfo,
	modelText: string,
): ReplayPromptAuthorBinding | undefined {
	const digest = digestPromptModelText(modelText);
	if (!digest) return undefined;
	return session.promptAuthorAmbiguityFences?.bindings.find(
		(binding) => binding.modelTextDigest === digest,
	);
}

function removePromptAuthorAmbiguityFence(
	session: SessionInfo,
	binding: ReplayPromptAuthorBinding,
): void {
	const owner = session.promptAuthorAmbiguityFences;
	if (!owner) return;
	const index = owner.bindings.findIndex((candidate) =>
		(candidate.attemptId ?? candidate.promptId) === (binding.attemptId ?? binding.promptId));
	if (index === -1) return;
	const [removed] = owner.bindings.splice(index, 1);
	owner.residentBytes = Math.max(0, owner.residentBytes - promptAuthorAmbiguityFenceBytes(removed));
}

/** Cancel one exact prepared attempt, or a restored attempt by durable occurrence evidence. */
function cancelPromptAuthorBinding(
	session: SessionInfo,
	target: PreparedPromptAuthorDispatch | string | Pick<PendingPromptAuthorRecord, "promptId" | "intentId" | "attemptId">,
	now: number,
): boolean {
	const pendingAuthors = session.pendingPromptAuthors;
	const idx = typeof target === "string"
		? (() => {
			for (let candidate = (pendingAuthors?.length ?? 0) - 1; candidate >= 0; candidate--) {
				if (pendingAuthors![candidate].promptId === target) return candidate;
			}
			return -1;
		})()
		: "pending" in target
			? (pendingAuthors?.findIndex((candidate) => candidate === target.pending) ?? -1)
			: (pendingAuthors?.findIndex((candidate) =>
				candidate.promptId === target.promptId
				&& (target.intentId === undefined || candidate.intentId === target.intentId)
				&& (target.attemptId === undefined || candidate.attemptId === target.attemptId)) ?? -1);
	if (idx === -1) return false;

	const [pending] = pendingAuthors!.splice(idx, 1);
	const pendingAttemptId = pending.attemptId ?? pending.promptId;
	for (const [messageKey, binding] of session.promptAuthorMessageBindings ?? []) {
		if (!binding.settled && (binding.attemptId ?? binding.promptId) === pendingAttemptId) {
			session.promptAuthorMessageBindings!.delete(messageKey);
		}
	}
	for (const envelope of session.pendingSkillExpansions ?? []) {
		if (envelope.promptId === pending.promptId) envelope.promptId = undefined;
	}
	retainPromptAuthorAmbiguityFence(session, pending);
	cancelSessionPromptActivity(
		session,
		(pending as ActivityBoundPromptAuthorRecord)[PROMPT_ACTIVITY_BOUNDARY],
	);
	void appendPromptAuthorSettlement(session.id, {
		schemaVersion: 2,
		type: "prompt-author-settlement",
		promptId: pending.promptId,
		...(pending.intentId === undefined ? {} : {
			intentId: pending.intentId,
			...(pending.attemptId === undefined ? {} : { attemptId: pending.attemptId }),
		}),
		settledAt: now,
		outcome: "cancelled",
	});
	return true;
}

export type SystemPromptSource = Exclude<PromptSource, "user" | "agent">;

const ARCHIVED_SNAPSHOT_CORRELATIONS = Symbol("archived-snapshot-correlations");
const ARCHIVED_ROW_CORRELATION = Symbol("archived-row-correlation");

type ArchivedSnapshotCorrelation = {
	id?: string;
	timestamp?: string | number;
};

type ArchivedRowOriginals = {
	hadId: boolean;
	id: unknown;
	hadTimestamp: boolean;
	timestamp: unknown;
};

/** Retain outer JSONL correlation metadata out-of-band until snapshot authoring. */
export function prepareArchivedMessageSnapshot(entries: readonly unknown[]): unknown[] {
	const messages: unknown[] = [];
	const correlations: ArchivedSnapshotCorrelation[] = [];
	for (const value of entries) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		if (entry.type !== "message" || !entry.message) continue;
		messages.push(entry.message);
		const outerTimestamp = entry.timestamp ?? entry.ts;
		const validOuterTimestamp = typeof outerTimestamp === "string"
			|| (typeof outerTimestamp === "number" && Number.isFinite(outerTimestamp));
		correlations.push({
			...(typeof entry.id === "string" && entry.id ? { id: entry.id } : {}),
			...(validOuterTimestamp ? { timestamp: outerTimestamp as string | number } : {}),
		});
	}
	const normalized = normalizeToolResultErrorSnapshot(messages) as unknown[];
	Object.defineProperty(normalized, ARCHIVED_SNAPSHOT_CORRELATIONS, {
		value: correlations,
		configurable: true,
	});
	return normalized;
}

function applyArchivedSnapshotCorrelations<T>(snapshot: T): T {
	if (!Array.isArray(snapshot)) return snapshot;
	const correlations = (snapshot as any)[ARCHIVED_SNAPSHOT_CORRELATIONS] as ArchivedSnapshotCorrelation[] | undefined;
	if (!correlations) return snapshot;
	return snapshot.map((message, index) => {
		const correlation = correlations[index];
		if (!correlation || !message || typeof message !== "object" || Array.isArray(message)) return message;
		const row = message as Record<string | symbol, unknown>;
		const originals: ArchivedRowOriginals = {
			hadId: Object.prototype.hasOwnProperty.call(row, "id"),
			id: row.id,
			hadTimestamp: Object.prototype.hasOwnProperty.call(row, "timestamp"),
			timestamp: row.timestamp,
		};
		return {
			...row,
			...(correlation.id === undefined ? {} : { id: correlation.id }),
			...(correlation.timestamp === undefined ? {} : { timestamp: correlation.timestamp }),
			[ARCHIVED_ROW_CORRELATION]: originals,
		};
	}) as T;
}

function stripArchivedSnapshotCorrelations<T>(snapshot: T): T {
	const stripRows = (rows: unknown[]): unknown[] => rows.map((message) => {
		if (!message || typeof message !== "object" || Array.isArray(message)) return message;
		const marker = (message as any)[ARCHIVED_ROW_CORRELATION] as ArchivedRowOriginals | undefined;
		if (!marker) return message;
		const { [ARCHIVED_ROW_CORRELATION]: _marker, ...visible } = message as Record<string | symbol, unknown>;
		if (marker.hadId) visible.id = marker.id;
		else delete visible.id;
		if (marker.hadTimestamp) visible.timestamp = marker.timestamp;
		else delete visible.timestamp;
		return visible;
	});
	if (Array.isArray(snapshot)) return stripRows(snapshot) as T;
	if (snapshot && typeof snapshot === "object" && Array.isArray((snapshot as any).messages)) {
		return { ...(snapshot as any), messages: stripRows((snapshot as any).messages) } as T;
	}
	return snapshot;
}

/** Restore base model text before full-history title generation sees Pi rows. */
export function projectPromptAuthorMessagesForTitle<T extends object>(
	sessionId: string,
	messages: T[],
	identity: AgentSessionIdentity = { id: sessionId },
	agentDeps: AgentAuthorDependencies = {},
): T[] {
	return mergeAuthorSidecarIntoMessages(readAuthorSidecar(sessionId), messages, {
		session: identity,
		agentDeps,
	}) as T[];
}

/**
 * Dispatch a Bobbit-generated prompt through the write-before-prefix boundary.
 * Durable/retry text remains untouched, and a late negative acknowledgement
 * cannot cancel a turn Pi already observed.
 */
export async function dispatchTrackedPrompt(
	session: SessionInfo,
	text: string,
	opts: {
		source?: PromptSource;
		author?: MessageAuthor;
		whenReady?: boolean;
		streamingBehavior?: PromptStreamingBehavior;
		/** Caller-owned durable occurrence identity for automatic retries. */
		intentId?: string;
		now?: () => number;
	} = {},
): Promise<unknown> {
	const source = opts.source ?? "system";
	const now = opts.now ?? Date.now;
	// Direct server prompts bypass PromptQueue, but still need the exact same
	// occurrence reservation as queued work before their RPC is issued. A caller
	// that may retry supplies its occurrence identity; an ambiguous prior attempt
	// then remains its owner and must never be sent to Pi a second time.
	const intentId = opts.intentId || `prompt:${randomUUID()}`;
	const existing = (session.inFlightSteerTexts as ReliableInFlightRecord[] | undefined)
		?.find((record) => record.intentId === intentId);
	if (existing) {
		return { success: false, duplicate: true, uncertain: true, intentId, attemptId: existing.attemptId };
	}
	const promptId = intentId;
	const author = resolveAcceptedPromptAuthor(source, opts.author);
	session.lastPromptSource = source;
	const prepared = preparePromptAuthorDispatch(session, promptId, text, source, author, now(), { intentId });
	const ledgerRecord: ReliableInFlightRecord = {
		text,
		promptId,
		intentId,
		attemptId: prepared.attemptId,
		dispatchEpoch: prepared.dispatchEpoch,
		state: "dispatching",
		targetTurn: "next-turn",
		kind: "prompt",
		createdAt: prepared.dispatchEpoch,
		retryable: false,
		source,
		author,
	};
	(session.inFlightSteerTexts ??= []).push(ledgerRecord);
	const activityBoundary = beginPreparedPromptActivity(session, prepared);

	let definiteRejection = false;
	try {
		const response = opts.whenReady
			? opts.streamingBehavior
				? await session.rpcClient.promptWhenReady(prepared.piText, undefined, { streamingBehavior: opts.streamingBehavior })
				: await session.rpcClient.promptWhenReady(prepared.piText, undefined)
			: opts.streamingBehavior
				? await session.rpcClient.prompt(prepared.piText, undefined, undefined, opts.streamingBehavior)
				: await session.rpcClient.prompt(prepared.piText);
		if ((response as any)?.success === false) {
			definiteRejection = true;
			throw new Error((response as any).error || "prompt dispatch rejected");
		}
		if (!acceptPreparedPromptDispatch(session, prepared, activityBoundary)) {
			throw new Error("prompt dispatch was superseded before acknowledgement");
		}
		// A buffered correlated end may have settled while the RPC acknowledgement
		// was in flight. Its exact sidecar tuple, never body text, permits pruning.
		const terminal = readAuthorSidecar(session.id).some((binding) =>
			binding.intentId === intentId
			&& binding.attemptId === prepared.attemptId
			&& binding.settlement?.outcome === "echoed");
		if (terminal) {
			session.inFlightSteerTexts = session.inFlightSteerTexts?.filter((record) =>
				record.intentId !== intentId || record.attemptId !== prepared.attemptId);
		}
		return response;
	} catch (error) {
		if (activityBoundary?.state === "committed") {
			console.warn(`[session-manager] tracked prompt for ${session.id} reported a failure after its correlated user echo; treating the dispatch as accepted`);
			return { success: true };
		}
		if (definiteRejection) {
			// Pi explicitly rejected before opening a turn, so this exact attempt may
			// be retired. Transport errors are different: RpcBridge can write before
			// its acknowledgement is lost, and cancellation would permit a duplicate.
			cancelSessionPromptActivity(session, activityBoundary);
			cancelPromptAuthorBinding(session, prepared, now());
			session.inFlightSteerTexts = session.inFlightSteerTexts?.filter((record) =>
				record.intentId !== intentId || record.attemptId !== prepared.attemptId);
		} else {
			ledgerRecord.state = "uncertain";
			ledgerRecord.retryable = false;
		}
		throw error;
	}
}

/** Bobbit-generated prompt wrapper that cannot be attributed to a user or agent. */
export function dispatchTrackedSystemPrompt(
	session: SessionInfo,
	text: string,
	opts: {
		source?: SystemPromptSource;
		whenReady?: boolean;
		streamingBehavior?: PromptStreamingBehavior;
		intentId?: string;
		now?: () => number;
	} = {},
): Promise<unknown> {
	return dispatchTrackedPrompt(session, text, {
		...opts,
		author: BOBBIT_SYSTEM_AUTHOR,
	});
}

function sameAuthor(left: MessageAuthor, right: MessageAuthor): boolean {
	return left.kind === right.kind && left.id === right.id && left.label === right.label;
}

function authorForSteerRows(rows: QueuedMessage[]): MessageAuthor {
	const authors = rows.map((row) => {
		const source = row.source ?? "user";
		if (source === "user" && isMessageAuthor(row.author) && row.author.kind === "user") {
			return row.author;
		}
		return resolveAcceptedPromptAuthor(source, row.author);
	});
	// Human identity prefixing is deliberately inactive. Even synthetic legacy
	// rows with different user ids remain an all-human, unprefixed batch.
	if (authors.every((author) => author.kind === "user")) return authors[0];
	return authors.every((author) => sameAuthor(author, authors[0])) ? authors[0] : BATCH_SYSTEM_AUTHOR;
}

type DeliveryTargetTurn = "continuation" | "next-turn";
type DeliveryState = "queued" | "dispatching" | "received" | "uncertain" | "failed" | "cancelled";
type ReliableQueuedMessage = QueuedMessage & {
	kind?: "prompt" | "steer";
	targetTurn?: DeliveryTargetTurn;
	sequence?: number;
	deliveryState?: DeliveryState;
	deliveryReason?: string;
	deliveryError?: string;
	retryable?: boolean;
	attemptId?: string;
	dispatchEpoch?: number;
};
type ReliableInFlightRecord = InFlightSteerRecord & {
	intentId?: string;
	attemptId?: string;
	dispatchEpoch?: number;
	targetTurn?: DeliveryTargetTurn;
	sequence?: number;
	kind?: "prompt" | "steer";
	createdAt?: number;
	retryable?: boolean;
	deliveryReason?: string;
};

export interface PersistedIntentRestoreState {
	messageQueue?: QueuedMessage[];
	inFlightSteerTexts?: InFlightSteerRecord[];
	changed: boolean;
}

/**
 * Fold durable terminal sidecar evidence before a restored queue becomes live.
 * Only modern exact occurrence/attempt identities are removed; legacy rows with
 * no verifiable intent tuple retain their compatibility recovery behavior.
 */
export function reconcilePersistedIntentRestore(
	messageQueue: readonly QueuedMessage[] | undefined,
	inFlightSteerTexts: readonly InFlightSteerRecord[] | undefined,
	bindings: readonly PromptAuthorBinding[],
): PersistedIntentRestoreState {
	// This function is also called by restore tests and older integrations that
	// bypass SessionStore's load migration. Normalize again at the trusted restore
	// boundary so no pre-intent row can fall through to text-based recovery.
	const normalizedLedger = normalizePersistedInFlightSteers(inFlightSteerTexts) ?? [];
	const latestByIntent = new Map<string, PromptAuthorBinding>();
	const terminalAttempts = new Set<string>();
	const modernIntentIds = new Set(bindings.flatMap((binding) => binding.intentId ? [binding.intentId] : []));
	for (const intentId of modernIntentIds) {
		const latest = selectLatestPromptAuthorBinding(bindings, (binding) => binding.intentId === intentId);
		if (latest) latestByIntent.set(intentId, latest);
	}
	for (const binding of bindings) {
		if (binding.intentId && binding.attemptId && binding.settlement) {
			terminalAttempts.add(`${binding.intentId}\0${binding.attemptId}`);
		}
	}

	// A crash can persist both a stale queued copy and the exact unresolved
	// sidecar tuple. The tuple is the only evidence Pi may have seen work, so it
	// becomes the one fail-closed uncertain owner; the queue copy must never drain.
	const unsettledIntentIds = new Set<string>();
	let collapsedUnsettledOwner = false;
	for (const row of messageQueue ?? []) {
		const latest = latestByIntent.get(row.id);
		if (!latest || latest.settlement !== undefined || !latest.intentId || !latest.attemptId
			|| latest.dispatchEpoch === undefined) continue;
		const matching = normalizedLedger.find((record) =>
			record.intentId === latest.intentId && record.attemptId === latest.attemptId);
		if (matching) {
			matching.state = "uncertain";
			matching.retryable = false;
		} else {
			const recovered = row as ReliableQueuedMessage;
			normalizedLedger.push({
				text: row.text,
				promptId: latest.promptId,
				intentId: latest.intentId,
				attemptId: latest.attemptId,
				dispatchEpoch: latest.dispatchEpoch,
				state: "uncertain",
				targetTurn: recovered.targetTurn ?? "next-turn",
				sequence: recovered.sequence,
				kind: recovered.kind ?? (recovered.isSteered ? "steer" : "prompt"),
				createdAt: recovered.createdAt ?? latest.dispatchEpoch,
				retryable: false,
				source: latest.source,
				author: latest.author,
				images: recovered.images,
				attachments: recovered.attachments,
				suppressTitleGen: recovered.suppressTitleGen,
				goalDispatchGuardId: recovered.goalDispatchGuardId,
			});
		}
		unsettledIntentIds.add(latest.intentId);
		collapsedUnsettledOwner = true;
	}
	const queue = messageQueue?.filter((row) => {
		if (unsettledIntentIds.has(row.id)) return false;
		const latest = latestByIntent.get(row.id);
		if (latest?.settlement === undefined) return true;
		// A proven-no-start recovery explicitly carries the retired attempt on its
		// queued row. A stale pre-dispatch queue copy has no such evidence and must
		// yield to the terminal sidecar disposition.
		const recovered = row as ReliableQueuedMessage;
		return latest.settlement.outcome === "cancelled"
			&& (recovered.deliveryState === "queued"
				|| recovered.deliveryState === "failed"
				|| (recovered.deliveryState === "cancelled" && recovered.deliveryReason === "abort-recovery-failed"))
			&& recovered.attemptId !== undefined
			&& recovered.attemptId === latest.attemptId;
	});
	const terminalLegacyPromptIds = new Set(bindings
		.filter((binding) => binding.intentId === undefined && binding.settlement !== undefined)
		.map((binding) => binding.promptId));
	const ledger = normalizedLedger.filter((record) => {
		if (record.intentId && record.attemptId
			&& terminalAttempts.has(`${record.intentId}\0${record.attemptId}`)) return false;
		// A pre-intent structured row can be retired only by its own sidecar
		// prompt id. Bare string rows have generated IDs and therefore fail closed.
		return !terminalLegacyPromptIds.has(record.promptId);
	});
	const queueChanged = (queue?.length ?? 0) !== (messageQueue?.length ?? 0);
	const ledgerChanged = collapsedUnsettledOwner
		|| (ledger?.length ?? 0) !== (inFlightSteerTexts?.length ?? 0)
		|| normalizedLedger.some((record, index) => {
			const original = inFlightSteerTexts?.[index];
			return typeof original !== "object" || original === null || original.intentId !== record.intentId
				|| original.attemptId !== record.attemptId || original.dispatchEpoch !== record.dispatchEpoch
				|| original.state !== record.state || original.retryable !== record.retryable;
		});
	return {
		messageQueue: queue && queue.length > 0 ? [...queue] : undefined,
		inFlightSteerTexts: ledger && ledger.length > 0 ? [...ledger] : undefined,
		changed: queueChanged || ledgerChanged,
	};
}

/**
 * Merge the persisted queue and dispatch ledger into one occurrence projection.
 * Queue rows win duplicate IDs. Each durable owner's order is authoritative:
 * explicit queue reorder and in-flight dispatch order must survive projection.
 * Accepted time is used only to merge the two already-ordered streams.
 */
function projectReliableDeliveryOutbox(
	queued: ReliableQueuedMessage[],
	ledger: ReliableInFlightRecord[],
): ReliableQueuedMessage[] {
	const ids = new Set(queued.map((row) => row.id));
	const inFlight = ledger
		.filter((record) => record.intentId && !ids.has(record.intentId))
		.map((record): ReliableQueuedMessage => ({
			id: record.intentId!,
			text: record.text,
			isSteered: (record.kind ?? "steer") === "steer",
			createdAt: record.createdAt ?? record.dispatchEpoch ?? 0,
			kind: record.kind ?? "steer",
			targetTurn: record.targetTurn ?? "continuation",
			sequence: record.sequence,
			deliveryState: record.state === "uncertain"
				? "uncertain"
				: record.state === "received"
					? "received"
					: "dispatching",
			deliveryReason: record.deliveryReason,
			retryable: record.retryable ?? false,
			attemptId: record.attemptId,
			dispatchEpoch: record.dispatchEpoch,
			source: record.source,
			author: record.author,
			images: record.images,
			attachments: record.attachments,
			suppressTitleGen: record.suppressTitleGen,
			goalDispatchGuardId: record.goalDispatchGuardId,
		}));

	const projection: ReliableQueuedMessage[] = [];
	let queuedIndex = 0;
	let inFlightIndex = 0;
	while (queuedIndex < queued.length && inFlightIndex < inFlight.length) {
		const queuedRow = queued[queuedIndex];
		const inFlightRow = inFlight[inFlightIndex];
		if ((queuedRow.createdAt ?? 0) <= (inFlightRow.createdAt ?? 0)) {
			projection.push(queuedRow);
			queuedIndex += 1;
		} else {
			projection.push(inFlightRow);
			inFlightIndex += 1;
		}
	}
	projection.push(...queued.slice(queuedIndex), ...inFlight.slice(inFlightIndex));
	return projection;
}

function batchPromptId(prefix: string, rows: QueuedMessage[]): string {
	const digest = createHash("sha256").update(rows.map((row) => row.id).join("\0")).digest("hex");
	return `${prefix}:${digest}`;
}

function promptAttemptId(prefix: string): string {
	return `${prefix}:${randomUUID()}`;
}

const PI_COMPACTION_ACTIVE_REJECTION =
	"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

/** Match only Pi's canonical pre-admission manual-compaction rejection. */
function isPiCompactionActiveRejection(value: unknown): boolean {
	const message = value instanceof Error
		? value.message
		: typeof value === "string"
			? value
			: value && typeof value === "object" && typeof (value as { error?: unknown }).error === "string"
				? (value as { error: string }).error
				: undefined;
	return message === PI_COMPACTION_ACTIVE_REJECTION;
}

/** Helper: extract the exact model text used by author-sidecar correlation. */
function extractUserMessageText(message: any): string {
	if (!message || typeof message !== "object") return "";
	return extractPromptModelText(message as Record<string, unknown>) ?? "";
}

const PROMPT_AUTHOR_MESSAGE_ID_FIELDS = ["id", "entryId", "_entryId", "_bobbitEntryId"] as const;

/** Extract the stable Pi/session entry id used by both live and sidecar correlation. */
function promptAuthorMessageId(
	message: Record<string, unknown>,
	event?: Record<string, unknown>,
): string | undefined {
	for (const owner of [message, event]) {
		if (!owner) continue;
		for (const field of PROMPT_AUTHOR_MESSAGE_ID_FIELDS) {
			const value = owner[field];
			if (typeof value === "string" && value) return value;
		}
	}
	return undefined;
}

function promptAuthorMessageKey(
	message: Record<string, unknown>,
	event?: Record<string, unknown>,
): string | undefined {
	const messageId = promptAuthorMessageId(message, event);
	if (messageId) return `id:${messageId}`;
	const timestamp = message.timestamp ?? message.ts;
	if ((typeof timestamp === "string" && timestamp) || (typeof timestamp === "number" && Number.isFinite(timestamp))) {
		return `timestamp:${String(timestamp)}`;
	}
	return undefined;
}

/** Agent events cannot prove Pi transcript ids; strip any claimed provenance. */
function stripVisiblePromptEntryIdProvenance<T>(event: T): T {
	if (!event || typeof event !== "object" || Array.isArray(event)) return event;
	const raw = event as Record<string, unknown>;
	if (!raw.message || typeof raw.message !== "object" || Array.isArray(raw.message)) return event;
	const message = raw.message as Record<string, unknown>;
	const { _entryIdSource: _untrustedEntryIdSource, ...withoutEntryIdSource } = message;
	if (_untrustedEntryIdSource === undefined) return event;
	return { ...raw, message: withoutEntryIdSource } as T;
}

const PROMPT_AUTHOR_EVENT_BINDING = Symbol("prompt-author-event-binding");
const PROMPT_ACTIVITY_BOUNDARY = Symbol("prompt-activity-boundary");
const PROMPT_AMBIGUOUS_ECHO = Symbol("prompt-ambiguous-echo");
type PromptAuthorEventBinding = { promptId: string; attemptId?: string; alreadySettled: boolean };
type BufferedPromptEcho = {
	messageKey?: string;
	messageId?: string;
	messageTimestamp?: number;
	modelText: string;
};
type ActivityBoundPromptAuthorRecord = PendingPromptAuthorRecord & {
	[PROMPT_ACTIVITY_BOUNDARY]?: SessionPromptActivityBoundary;
	[PROMPT_AMBIGUOUS_ECHO]?: BufferedPromptEcho;
};

function beginPreparedPromptActivity(
	session: SessionInfo,
	prepared: PreparedPromptAuthorDispatch,
): SessionPromptActivityBoundary | undefined {
	const boundary = beginSessionPromptActivity(session, prepared.attemptId);
	(prepared.pending as ActivityBoundPromptAuthorRecord)[PROMPT_ACTIVITY_BOUNDARY] = boundary;
	return boundary;
}

function acceptPreparedPromptDispatch(
	session: SessionInfo,
	prepared: PreparedPromptAuthorDispatch,
	boundary: SessionPromptActivityBoundary | undefined,
): boolean {
	if (!commitSessionPromptActivity(session, boundary)) return false;
	const pending = prepared.pending as ActivityBoundPromptAuthorRecord;
	const buffered = pending[PROMPT_AMBIGUOUS_ECHO];
	if (!buffered) return true;
	delete pending[PROMPT_AMBIGUOUS_ECHO];
	const pendingIndex = session.pendingPromptAuthors?.findIndex((record) => record === pending) ?? -1;
	if (pendingIndex === -1) return true;
	session.pendingPromptAuthors!.splice(pendingIndex, 1);
	const settledBinding: LivePromptAuthorMessageBinding = {
		promptId: pending.promptId,
		...(pending.intentId === undefined ? {} : { intentId: pending.intentId }),
		attemptId: pending.attemptId,
		...(pending.dispatchEpoch === undefined ? {} : { dispatchEpoch: pending.dispatchEpoch }),
		author: pending.author,
		settled: true,
		modelText: buffered.modelText,
		...(pending.modelTextDigest === undefined ? {} : { modelTextDigest: pending.modelTextDigest }),
		...(pending.modelPrefix === undefined ? {} : { modelPrefix: pending.modelPrefix }),
	};
	if (buffered.messageKey) {
		if (!session.promptAuthorMessageBindings) session.promptAuthorMessageBindings = new Map();
		session.promptAuthorMessageBindings.set(buffered.messageKey, settledBinding);
	} else {
		session.lastKeylessPromptAuthorEnd = settledBinding;
	}
	void appendPromptAuthorSettlement(session.id, {
		schemaVersion: 2,
		type: "prompt-author-settlement",
		promptId: pending.promptId,
		...(pending.intentId === undefined ? {} : {
			intentId: pending.intentId,
			...(pending.attemptId === undefined ? {} : { attemptId: pending.attemptId }),
		}),
		settledAt: sessionManagerModuleClock.now(),
		outcome: "echoed",
		...(buffered.messageId ? { messageId: buffered.messageId } : {}),
		...(buffered.messageTimestamp === undefined ? {} : { messageTimestamp: buffered.messageTimestamp }),
	});
	return true;
}

function commitCorrelatedPromptActivity(
	session: SessionInfo,
	pending: PendingPromptAuthorRecord | undefined,
): boolean {
	return commitSessionPromptActivity(
		session,
		(pending as ActivityBoundPromptAuthorRecord | undefined)?.[PROMPT_ACTIVITY_BOUNDARY],
	);
}

/** Rebuild live correlation state before switch_session replays transcript events. */
export function restorePromptAuthorBindings(session: SessionInfo, entries: PromptAuthorBinding[]): number {
	session.pendingPromptAuthors = entries
		.filter((entry) => entry.settlement === undefined)
		.map(({ promptId, intentId, attemptId, dispatchEpoch, dispatchedAt, modelText, modelTextDigest, modelPrefix, source, author }) => ({
			promptId,
			...(intentId === undefined ? {} : { intentId }),
			attemptId: attemptId ?? promptId,
			...(dispatchEpoch === undefined ? {} : { dispatchEpoch }),
			dispatchedAt,
			...(modelText === undefined ? {} : { modelText }),
			...(modelTextDigest === undefined ? {} : { modelTextDigest }),
			...(modelPrefix === undefined ? {} : { modelPrefix }),
			source,
			author,
		}));
	// Direct tracked prompts have their durable tuple in the author sidecar even
	// if the process died before its queue/ledger transaction. Rebuild an
	// uncertain carrier from that exact evidence; never infer one from text.
	let restoredDirectAttempts = 0;
	for (const entry of entries) {
		if (entry.settlement !== undefined || !entry.intentId || !entry.attemptId
			|| entry.dispatchEpoch === undefined || typeof entry.modelText !== "string") continue;
		const existing = (session.inFlightSteerTexts ?? []).some((record) =>
			record.intentId === entry.intentId && record.attemptId === entry.attemptId);
		if (existing) continue;
		const text = entry.modelPrefix && entry.modelText.startsWith(entry.modelPrefix)
			? entry.modelText.slice(entry.modelPrefix.length)
			: entry.modelText;
		(session.inFlightSteerTexts ??= []).push({
			text,
			promptId: entry.promptId,
			intentId: entry.intentId,
			attemptId: entry.attemptId,
			dispatchEpoch: entry.dispatchEpoch,
			state: "uncertain",
			targetTurn: "next-turn",
			kind: "prompt",
			createdAt: entry.dispatchEpoch,
			retryable: false,
			source: entry.source,
			author: entry.author,
		});
		restoredDirectAttempts += 1;
	}
	const messageBindings = new Map<string, LivePromptAuthorMessageBinding>();
	for (const entry of entries) {
		if (entry.settlement?.outcome !== "echoed") continue;
		const binding: LivePromptAuthorMessageBinding = {
			promptId: entry.promptId,
			...(entry.intentId === undefined ? {} : { intentId: entry.intentId }),
			attemptId: entry.attemptId ?? entry.promptId,
			...(entry.dispatchEpoch === undefined ? {} : { dispatchEpoch: entry.dispatchEpoch }),
			author: entry.author,
			settled: true,
			...(entry.modelText === undefined ? {} : { modelText: entry.modelText }),
			...(entry.modelTextDigest === undefined ? {} : { modelTextDigest: entry.modelTextDigest }),
			...(entry.modelPrefix === undefined ? {} : { modelPrefix: entry.modelPrefix }),
		};
		if (entry.settlement.messageId) {
			messageBindings.set(`id:${entry.settlement.messageId}`, binding);
		}
		if (entry.settlement.messageTimestamp !== undefined) {
			messageBindings.set(`timestamp:${String(entry.settlement.messageTimestamp)}`, binding);
		}
	}
	session.promptAuthorMessageBindings = messageBindings;
	session.promptAuthorReplayBindings = entries
		.filter((entry) => entry.settlement?.outcome !== "cancelled")
		.map((entry) => ({
			promptId: entry.promptId,
			...(entry.intentId === undefined ? {} : { intentId: entry.intentId }),
			attemptId: entry.attemptId ?? entry.promptId,
			...(entry.dispatchEpoch === undefined ? {} : { dispatchEpoch: entry.dispatchEpoch }),
			...(entry.modelText === undefined ? {} : { modelText: entry.modelText }),
			...(entry.modelTextDigest === undefined ? {} : { modelTextDigest: entry.modelTextDigest }),
			...(entry.modelPrefix === undefined ? {} : { modelPrefix: entry.modelPrefix }),
			author: entry.author,
			settled: entry.settlement?.outcome === "echoed",
		}));
	const previousFences = session.promptAuthorAmbiguityFences;
	session.promptAuthorAmbiguityFences = {
		bindings: [],
		residentBytes: 0,
		// Missing, wholly corrupt, future-version, legacy, and genuinely empty
		// sidecars all arrive through the compatibility reader as zero rows. A
		// restored generation with no bindings must therefore be treated like dropped
		// ambiguity history: raw-text equality is not proof that a late replay belongs
		// to a current dispatch. Positive RPC acknowledgement remains authoritative.
		// The reader exposes no completeness metadata when at least one row survives a
		// partial file, so that existing non-empty compatibility path is unchanged.
		// This sticky bounded owner carries the zero-row trust decision across in-place
		// role/abort replacements without retaining raw text.
		overflowed: entries.length === 0 || previousFences?.overflowed === true,
	};
	// Preserve bounded live-process fences across bridge replacement. Dropping
	// them here would reopen ABA when a late old-bridge echo follows hydration.
	for (const binding of previousFences?.bindings ?? []) {
		retainPromptAuthorAmbiguityFence(session, {
			promptId: binding.promptId,
			attemptId: binding.attemptId,
			modelText: binding.modelText,
			modelTextDigest: binding.modelTextDigest,
			modelPrefix: binding.modelPrefix,
			author: binding.author,
		});
	}
	for (const entry of entries) {
		const cancelled = entry.settlement?.outcome === "cancelled";
		const settledKeyless = entry.settlement?.outcome === "echoed"
			&& !entry.settlement.messageId
			&& entry.settlement.messageTimestamp === undefined;
		if (!cancelled && !settledKeyless) continue;
		// The transient replay cursor is cleared as soon as switch_session responds,
		// but Pi may emit a historical keyless occurrence later. Keep only its digest
		// in the same bounded, sticky-fail-closed owner as cancelled attempts.
		retainPromptAuthorAmbiguityFence(session, {
			promptId: entry.promptId,
			attemptId: entry.attemptId ?? entry.promptId,
			modelText: entry.modelText,
			modelTextDigest: entry.modelTextDigest,
			modelPrefix: entry.modelPrefix,
			author: entry.author,
		});
	}
	session.lastKeylessPromptAuthorEnd = undefined;

	// Settlement may have reached the durable sidecar just before a gateway
	// crash, while the queue/ledger transaction did not. Exact modern attempt
	// evidence wins for either terminal outcome. Legacy prompt-id rows retain the
	// established echoed pruning, but an unverifiable cancellation never drops one.
	const terminalAttempts = new Set(entries
		.filter((entry) => entry.intentId && entry.attemptId && entry.settlement)
		.map((entry) => `${entry.intentId}\0${entry.attemptId}`));
	const echoedLegacyPromptIds = new Set(entries
		.filter((entry) => entry.intentId === undefined && entry.settlement?.outcome === "echoed")
		.map((entry) => entry.promptId));
	const before = session.inFlightSteerTexts?.length ?? 0;
	if (before > 0) {
		session.inFlightSteerTexts = session.inFlightSteerTexts!.filter((record) => {
			if (record.intentId && record.attemptId) {
				return !terminalAttempts.has(`${record.intentId}\0${record.attemptId}`);
			}
			return !echoedLegacyPromptIds.has(record.promptId);
		});
	}
	return before - (session.inFlightSteerTexts?.length ?? 0) + restoredDirectAttempts;
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
 * Stamp Bobbit-owned author metadata before lifecycle tracking and emission.
 * The raw Pi event is never mutated and the message content/role is unchanged.
 */
export function prepareVisibleAgentEvent(
	session: SessionInfo,
	event: unknown,
	agentDeps: AgentAuthorDependencies = {},
): unknown {
	if (!event || typeof event !== "object") return event;
	let raw = event as any;
	if (raw.type === "message_start"
		&& (raw.message?.role === "user" || raw.message?.role === "user-with-attachments")) {
		const messageKey = promptAuthorMessageKey(raw.message, raw);
		let binding = messageKey ? session.promptAuthorMessageBindings?.get(messageKey) : undefined;
		// During restore, transcript order is authoritative. Consume the sidecar
		// occurrence cursor rather than letting a historical same-text row bind to
		// a newer live attempt.
		binding ??= session.promptAuthorReplayBindings?.[0];
		const ledger = (session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[];
		if (!binding) {
			const pending = session.pendingPromptAuthors
				?.filter((candidate) => candidate.intentId !== undefined
					&& candidate.attemptId !== undefined
					&& candidate.dispatchEpoch !== undefined)
				.sort((left, right) => left.dispatchEpoch! - right.dispatchEpoch!)
				.find((candidate) => ledger.some((record) =>
					record.intentId === candidate.intentId
						&& record.attemptId === candidate.attemptId
						&& record.dispatchEpoch === candidate.dispatchEpoch
						&& record.state !== "received"));
			if (pending) {
				// The correlated Pi user start is stronger delivery evidence than the
				// RPC response and makes a later stale rejection inert.
				commitCorrelatedPromptActivity(session, pending);
				binding = {
					promptId: pending.promptId,
					intentId: pending.intentId,
					attemptId: pending.attemptId,
					dispatchEpoch: pending.dispatchEpoch,
					author: pending.author,
					settled: false,
					...(pending.modelText === undefined ? {} : { modelText: pending.modelText }),
					...(pending.modelTextDigest === undefined ? {} : { modelTextDigest: pending.modelTextDigest }),
					...(pending.modelPrefix === undefined ? {} : { modelPrefix: pending.modelPrefix }),
				};
			}
		}
		if (!binding) {
			// Compatibility only: pre-identity rows have no occurrence/attempt tuple,
			// so their historical text correlation remains isolated to proven legacy
			// pending and ledger records.
			const modelText = extractUserMessageText(raw.message);
			const pending = session.pendingPromptAuthors?.find((candidate) =>
				candidate.intentId === undefined
					&& candidate.dispatchEpoch === undefined
					&& promptAuthorBindingMatchesText(candidate, modelText)
					&& (candidate as ActivityBoundPromptAuthorRecord)[PROMPT_ACTIVITY_BOUNDARY]?.state === "committed");
			const legacyRecord = pending
				? ledger.find((candidate) => !candidate.intentId && candidate.promptId === pending.promptId)
				: ledger.find((candidate) => !candidate.intentId && candidate.text === modelText);
			if (pending && legacyRecord) {
				binding = {
					promptId: pending.promptId,
					attemptId: pending.attemptId,
					author: pending.author,
					settled: false,
				};
			}
		}
		if (binding) {
			if (messageKey && !session.promptAuthorMessageBindings?.has(messageKey)) {
				if (!session.promptAuthorMessageBindings) session.promptAuthorMessageBindings = new Map();
				session.promptAuthorMessageBindings.set(messageKey, binding);
			}
			const deliveryIntentId = binding.intentId;
			raw = {
				...raw,
				...(deliveryIntentId === undefined ? {} : { deliveryIntentId }),
				...(binding.attemptId === undefined ? {} : { deliveryAttemptId: binding.attemptId }),
				message: {
					...raw.message,
					...(deliveryIntentId === undefined ? {} : { deliveryIntentId }),
					...(binding.attemptId === undefined ? {} : { deliveryAttemptId: binding.attemptId }),
				},
			};
			raw[PROMPT_AUTHOR_EVENT_BINDING] = {
				promptId: binding.promptId,
				attemptId: binding.attemptId,
				alreadySettled: binding.settled,
			} satisfies PromptAuthorEventBinding;
		}
	}
	if ((raw.type !== "message_update" && raw.type !== "message_end") || !raw.message || typeof raw.message !== "object") {
		if (raw.type === "agent_start" || raw.type === "agent_end") {
			session.lastKeylessPromptAuthorEnd = undefined;
		} else if (raw.type === "message_start"
			&& (raw.message?.role === "user" || raw.message?.role === "user-with-attachments")) {
			// Pi's start frame is the only occurrence boundary available when a
			// legacy transcript row has neither an id nor a timestamp. Advance may
			// now use the next replay binding; duplicate terminal frames (which have
			// no intervening start) continue to reuse the completed occurrence.
			session.lastKeylessPromptAuthorEnd = undefined;
		}
		return stripVisiblePromptEntryIdProvenance(raw);
	}

	const message = raw.message as Record<string, unknown>;
	let author: MessageAuthor;
	const userRole = message.role === "user" || message.role === "user-with-attachments";
	const modelText = userRole ? extractUserMessageText(message) : "";
	const messageKey = userRole ? promptAuthorMessageKey(message, raw) : undefined;
	const liveKeylessTerminalGuard = session.lastKeylessPromptAuthorEnd;
	// Assistant streaming is part of the turn guarded by the preceding keyless
	// user terminal. It must not erase that guard: Pi can replay the terminal
	// after assistant updates, while a concurrent same-text steer is pending.
	if (userRole && (messageKey || raw.type === "message_update"
		|| (liveKeylessTerminalGuard
			&& !promptAuthorBindingMatchesText(liveKeylessTerminalGuard, modelText)))) {
		session.lastKeylessPromptAuthorEnd = undefined;
	}
	let stableBinding = messageKey ? session.promptAuthorMessageBindings?.get(messageKey) : undefined;
	if (!stableBinding && userRole && !messageKey && raw.type === "message_end") {
		stableBinding = session.lastKeylessPromptAuthorEnd;
	}
	if (!stableBinding && userRole && !messageKey && modelText) {
		// The restore-only array is an occurrence cursor in transcript order. A
		// terminal frame removes the occurrence below, while lastKeylessPromptAuthorEnd
		// retains its binding until the next message_start so an immediate duplicate
		// end cannot advance into a newer identical-text prompt.
		stableBinding = session.promptAuthorReplayBindings?.find((binding) =>
			promptAuthorBindingMatchesText(binding, modelText),
		);
	}
	const reservedAttemptIds = new Set(
		[...(session.promptAuthorMessageBindings?.values() ?? [])]
			.filter((binding) => !binding.settled)
			.map((binding) => binding.attemptId ?? binding.promptId),
	);
	let pendingIndex = !stableBinding && userRole && modelText
		? (session.pendingPromptAuthors?.findIndex((record) =>
			promptAuthorBindingMatchesText(record, modelText)
				&& !reservedAttemptIds.has(record.attemptId ?? record.promptId)
				&& (record as ActivityBoundPromptAuthorRecord)[PROMPT_ACTIVITY_BOUNDARY]?.state === "committed"
		) ?? -1)
		: -1;
	if (pendingIndex !== -1 && messageKey) {
		const pending = session.pendingPromptAuthors![pendingIndex];
		stableBinding = {
			promptId: pending.promptId,
			...(pending.intentId === undefined ? {} : { intentId: pending.intentId }),
			attemptId: pending.attemptId,
			...(pending.dispatchEpoch === undefined ? {} : { dispatchEpoch: pending.dispatchEpoch }),
			author: pending.author,
			settled: false,
			...(pending.modelText === undefined ? {} : { modelText: pending.modelText }),
			...(pending.modelTextDigest === undefined ? {} : { modelTextDigest: pending.modelTextDigest }),
			...(pending.modelPrefix === undefined ? {} : { modelPrefix: pending.modelPrefix }),
		};
	}
	let bufferedPending: ActivityBoundPromptAuthorRecord | undefined;
	if (!stableBinding && pendingIndex === -1 && userRole && modelText) {
		// A cancelled/restored predecessor may still arrive after switch_session's
		// response. Pi does not echo a Bobbit nonce, so equal raw text is ambiguous
		// until the current RPC is positively acknowledged. Before that boundary,
		// bind the historical occurrence first rather than settling a newer attempt.
		stableBinding = findPromptAuthorAmbiguityFence(session, modelText);
		if (raw.type === "message_end" && (stableBinding
			|| session.promptAuthorAmbiguityFences?.overflowed)) {
			// Overflow means a matching predecessor may have been dropped. Preserve
			// the current projection for a positive ack, but never let this raw-text
			// echo commit activity or consume recovery intent before that ack.
			bufferedPending = session.pendingPromptAuthors?.find((record) =>
				promptAuthorBindingMatchesText(record, modelText)
					&& !reservedAttemptIds.has(record.attemptId ?? record.promptId),
			) as ActivityBoundPromptAuthorRecord | undefined;
		}
	}
	if (stableBinding && messageKey && !session.promptAuthorMessageBindings?.has(messageKey)) {
		if (!session.promptAuthorMessageBindings) session.promptAuthorMessageBindings = new Map();
		session.promptAuthorMessageBindings.set(messageKey, stableBinding);
	}
	if (stableBinding && !stableBinding.settled) {
		pendingIndex = session.pendingPromptAuthors?.findIndex((record) =>
			(record.attemptId ?? record.promptId) === (stableBinding!.attemptId ?? stableBinding!.promptId)
		) ?? -1;
	}
	// Once tombstone history has overflowed, an uncorrelated raw-text frame may
	// belong to a dropped predecessor. Positive RPC acknowledgement remains the
	// only safe pre-ack boundary for both streaming updates and terminal echoes.
	if (!stableBinding && !bufferedPending && pendingIndex === -1 && userRole && modelText
		&& !session.promptAuthorAmbiguityFences?.overflowed
		&& session.pendingPromptAuthors?.length) {
		pendingIndex = session.pendingPromptAuthors.findIndex((record) =>
			promptAuthorBindingMatchesText(record, modelText)
				&& !reservedAttemptIds.has(record.attemptId ?? record.promptId),
		);
		if (pendingIndex !== -1 && messageKey) {
			const pending = session.pendingPromptAuthors[pendingIndex];
			stableBinding = {
				promptId: pending.promptId,
				...(pending.intentId === undefined ? {} : { intentId: pending.intentId }),
				attemptId: pending.attemptId,
				...(pending.dispatchEpoch === undefined ? {} : { dispatchEpoch: pending.dispatchEpoch }),
				author: pending.author,
				settled: false,
				...(pending.modelText === undefined ? {} : { modelText: pending.modelText }),
				...(pending.modelTextDigest === undefined ? {} : { modelTextDigest: pending.modelTextDigest }),
				...(pending.modelPrefix === undefined ? {} : { modelPrefix: pending.modelPrefix }),
			};
			if (!session.promptAuthorMessageBindings) session.promptAuthorMessageBindings = new Map();
			session.promptAuthorMessageBindings.set(messageKey, stableBinding);
		}
	}
	if (!bufferedPending && raw.type === "message_end" && stableBinding?.ambiguityFence) {
		// A preceding keyed message_update may already have promoted the historical
		// digest fence to an exact message binding. Its terminal frame is still an
		// ambiguous projection for a same-text current attempt until the RPC ack.
		bufferedPending = session.pendingPromptAuthors?.find((record) =>
			promptAuthorBindingMatchesText(record, modelText)
				&& (record as ActivityBoundPromptAuthorRecord)[PROMPT_ACTIVITY_BOUNDARY]?.state === "pending",
		) as ActivityBoundPromptAuthorRecord | undefined;
	}

	const selectedPending = pendingIndex === -1 ? undefined : session.pendingPromptAuthors![pendingIndex];
	// A tombstone remains authoritative for acceptance until the RPC responds,
	// while the exact current retry supplies the projection that a positive
	// acknowledgement will finalize. This keeps rejected activity quarantined
	// without leaking a predecessor's author into an accepted redriven echo.
	const selectedPromptBinding = bufferedPending ?? stableBinding ?? selectedPending;
	// Streaming user updates establish correlation and projection only. The exact
	// terminal occurrence (or a positive RPC acknowledgement) is the acceptance
	// boundary; an update followed by a rejected RPC must remain cancellable.
	if (userRole && raw.type === "message_end" && selectedPending) {
		commitCorrelatedPromptActivity(session, selectedPending);
	}
	const sessionAuthor = agentAuthorForSession(session, agentDeps);
	if (selectedPromptBinding) {
		author = selectedPromptBinding.author;
	} else if (message.role === "assistant") {
		author = sessionAuthor;
	} else {
		author = normalizeVisibleAgentEvent(session, raw, {
			agentAuthor: sessionAuthor,
			systemAuthor: BOBBIT_SYSTEM_AUTHOR,
		}).message.author;
	}

	// Correlation chooses the accountable occurrence. The sidecar projection
	// independently proves exact raw Pi text before removing one stored prefix.
	const projectedRaw = userRole && selectedPromptBinding
		? { ...raw, message: projectCorrelatedPromptMessage(message, selectedPromptBinding) }
		: raw;
	const normalized = normalizeVisibleAgentEvent(session, projectedRaw, {
		agentAuthor: sessionAuthor,
		systemAuthor: BOBBIT_SYSTEM_AUTHOR,
		promptAuthor: author,
	});
	const prepared = stripVisiblePromptEntryIdProvenance(normalized);
	if (bufferedPending) {
		const messageId = promptAuthorMessageId(message, raw);
		bufferedPending[PROMPT_AMBIGUOUS_ECHO] = {
			...(messageKey ? { messageKey } : {}),
			...(messageId ? { messageId } : {}),
			...(typeof message.timestamp === "number" ? { messageTimestamp: message.timestamp } : {}),
			modelText,
		};
		// Prevent steer-ledger raw-text fallback from consuming current intent. A
		// positive RPC acknowledgement finalizes this buffered occurrence instead.
		if (!stableBinding && raw.type === "message_end") {
			(prepared as any)[PROMPT_AUTHOR_EVENT_BINDING] = {
				promptId: bufferedPending.promptId,
				attemptId: bufferedPending.attemptId,
				alreadySettled: true,
			} satisfies PromptAuthorEventBinding;
		}
	}
	if (raw.type === "message_end" && stableBinding) {
		const replayIndex = session.promptAuthorReplayBindings?.findIndex(
			(binding) => (binding.attemptId ?? binding.promptId)
				=== (stableBinding!.attemptId ?? stableBinding!.promptId),
		) ?? -1;
		if (replayIndex !== -1) session.promptAuthorReplayBindings!.splice(replayIndex, 1);
		removePromptAuthorAmbiguityFence(session, stableBinding);
	}
	if (raw.type === "message_end" && stableBinding?.settled) {
		(prepared as any)[PROMPT_AUTHOR_EVENT_BINDING] = {
			promptId: stableBinding.promptId,
			attemptId: stableBinding.attemptId,
			alreadySettled: true,
		} satisfies PromptAuthorEventBinding;
		if (!messageKey) {
			const hasConcurrentSameTextPrompt = session.pendingPromptAuthors?.some((record) =>
				(record.attemptId ?? record.promptId) !== (stableBinding!.attemptId ?? stableBinding!.promptId)
				&& promptAuthorBindingMatchesText(record, modelText),
			) ?? false;
			// A live guard protects one otherwise-indistinguishable duplicate. Once
			// it does, release a concurrent newer occurrence so its real echo can
			// bind next. Restore replay guards remain authoritative for the complete
			// replay window and are never consumed this way.
			session.lastKeylessPromptAuthorEnd = stableBinding === liveKeylessTerminalGuard
				&& hasConcurrentSameTextPrompt
				&& !session.promptAuthorReplayBindings
				? undefined
				: { ...stableBinding, modelText };
		}
	} else if (raw.type === "message_end" && pendingIndex !== -1) {
		const [pending] = session.pendingPromptAuthors!.splice(pendingIndex, 1);
		if (stableBinding) stableBinding.settled = true;
		(prepared as any)[PROMPT_AUTHOR_EVENT_BINDING] = {
			promptId: pending.promptId,
			attemptId: pending.attemptId,
			alreadySettled: false,
		} satisfies PromptAuthorEventBinding;
		if (!messageKey) {
			session.lastKeylessPromptAuthorEnd = {
				promptId: pending.promptId,
				...(pending.intentId === undefined ? {} : { intentId: pending.intentId }),
				attemptId: pending.attemptId,
				...(pending.dispatchEpoch === undefined ? {} : { dispatchEpoch: pending.dispatchEpoch }),
				// A restored v2 pending row contains only a digest. The raw echo itself
				// safely supplies memory-only exact text for duplicate terminal guards.
				modelText,
				...(pending.modelTextDigest === undefined ? {} : { modelTextDigest: pending.modelTextDigest }),
				...(pending.modelPrefix === undefined ? {} : { modelPrefix: pending.modelPrefix }),
				author: pending.author,
				settled: true,
			};
		}
		const messageId = promptAuthorMessageId(message, raw);
		void appendPromptAuthorSettlement(session.id, {
			schemaVersion: 2,
			type: "prompt-author-settlement",
			promptId: pending.promptId,
			...(pending.intentId === undefined ? {} : {
				intentId: pending.intentId,
				...(pending.attemptId === undefined ? {} : { attemptId: pending.attemptId }),
			}),
			settledAt: sessionManagerModuleClock.now(),
			outcome: "echoed",
			...(messageId ? { messageId } : {}),
			...(typeof message.timestamp === "number" ? { messageTimestamp: message.timestamp } : {}),
		});
	}
	const eventBinding = (prepared as any)[PROMPT_AUTHOR_EVENT_BINDING] as PromptAuthorEventBinding | undefined;
	if (raw.type === "message_end" && eventBinding && !eventBinding.alreadySettled) {
		const envelope = session.pendingSkillExpansions?.find((entry) =>
			entry.promptId === eventBinding.promptId
			&& entry.recordId !== undefined
			&& entry.modelText === modelText,
		);
		const rawMessageId = typeof message.id === "string" && message.id.length > 0
			? message.id
			: undefined;
		const messageIdentity = rawMessageId
			? { id: rawMessageId }
			: typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
				? { timestamp: message.timestamp }
				: undefined;
		if (envelope?.recordId && messageIdentity) {
			if (!session.pendingSkillTranscriptBindings) session.pendingSkillTranscriptBindings = [];
			if (!session.pendingSkillTranscriptBindings.some((binding) => binding.recordId === envelope.recordId)) {
				session.pendingSkillTranscriptBindings.push({
					recordId: envelope.recordId,
					promptId: eventBinding.promptId,
					modelText,
					messageIdentity,
				});
			}
		}
	}
	return prepared;
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
const WS_BUFFER_OVERFLOW_BYTES = DEFAULT_OVERFLOW_GUARD.overflowBytes;
const WS_BUFFER_WARN_BYTES = DEFAULT_OVERFLOW_GUARD.warnBytes;
const WS_REPLACEABLE_MESSAGE_SOFT_CUTOVER_BYTES = 1024 * 1024;
const _warnedClients = new WeakSet<WebSocket>();
const _slowReplaceableClients = new WeakSet<WebSocket>();

type AssistantStreamSocket = WebSocket & {
	assistantStreamDeltaCapable?: boolean;
	assistantStreamDeltaNeedsBaseline?: boolean;
	streamBackpressureCutover?: boolean;
	bufferedAmount?: number;
	terminate?: () => void;
	close?: () => void;
};

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

function isSlowReplaceableClient(client: WebSocket): boolean {
	return _slowReplaceableClients.has(client);
}

function cutOverSlowReplaceableClient(client: AssistantStreamSocket): void {
	if (isSlowReplaceableClient(client)) return;
	_slowReplaceableClients.add(client);
	client.streamBackpressureCutover = true;
	try {
		if (typeof client.terminate === "function") client.terminate();
		else if (typeof client.close === "function") client.close();
	} catch {
		// Best-effort only. The weak-set fence still suppresses later sends.
	}
}

function markAssistantStreamSnapshotSent(client: AssistantStreamSocket, msg: ServerMessage): void {
	if (msg.type === "messages" && client.assistantStreamDeltaCapable === true) {
		client.assistantStreamDeltaNeedsBaseline = true;
	}
}

function isAssistantStreamMessageUpdate(event: unknown): event is {
	type: "message_update";
	message: Record<string, unknown>;
	assistantMessageEvent: Record<string, unknown>;
} {
	return !!event
		&& typeof event === "object"
		&& (event as { type?: unknown }).type === "message_update"
		&& !!(event as { message?: unknown }).message
		&& typeof (event as { message?: unknown }).message === "object"
		&& !Array.isArray((event as { message?: unknown }).message)
		&& ((event as { message?: { role?: unknown } }).message?.role === "assistant")
		&& !!(event as { assistantMessageEvent?: unknown }).assistantMessageEvent
		&& typeof (event as { assistantMessageEvent?: unknown }).assistantMessageEvent === "object";
}

function isAssistantStreamTerminalBoundary(event: unknown): boolean {
	return !!event
		&& typeof event === "object"
		&& (((event as { type?: unknown }).type === "message_end")
			|| ((event as { type?: unknown }).type === "agent_end")
			|| ((event as { type?: unknown }).type === "process_exit"));
}

/**
 * Build the `state.model` payload for a live model-state broadcast. Capability
 * fields come only from an exact registry/direct-Pi row. When exact composed
 * metadata is temporarily unavailable, retain the verified identity and omit
 * unknown fields rather than fabricating family defaults.
 */
export function buildModelStateData(provider: string, id: string): { model: Record<string, unknown> } {
	const meta = resolveModelStateMeta(provider, id);
	const modelCapacity = (meta as { modelCapacity?: unknown } | undefined)?.modelCapacity;
	const input = Array.isArray(meta?.input)
		&& meta.input.length > 0
		&& meta.input.every((entry) => entry === "text" || entry === "image")
		? meta.input
		: undefined;
	return {
		model: {
			provider,
			id,
			...(meta?.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
			...(typeof modelCapacity === "number" && Number.isFinite(modelCapacity) && modelCapacity > 0 ? { modelCapacity } : {}),
			...(meta?.maxTokens !== undefined ? { maxTokens: meta.maxTokens } : {}),
			...(meta?.reasoning !== undefined ? { reasoning: meta.reasoning } : {}),
			...(meta?.thinkingLevelMap ? { thinkingLevelMap: meta.thinkingLevelMap } : {}),
			...(input ? { input } : {}),
		},
	};
}

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
	if (!cpuDiagnosticsEnabled()) {
		const data = JSON.stringify(msg);
		const baseMeta = describeWsPayload(msg, data);
		for (const client of clients) {
			if (isSlowReplaceableClient(client) || client.readyState !== 1) continue;
			guardWebSocketOverflow(client, { ...baseMeta, recipientKind: "session" }, {
				pendingOverflowCheck: _pendingOverflowCheck,
				warnedClients: _warnedClients,
			}, {
				setTimeout: (cb, ms) => sessionManagerModuleClock.setTimeout(cb, ms),
				warn: (message) => console.warn(message),
			}, {
				overflowBytes: WS_BUFFER_OVERFLOW_BYTES,
				warnBytes: WS_BUFFER_WARN_BYTES,
			});
			client.send(data);
			markAssistantStreamSnapshotSent(client as AssistantStreamSocket, msg);
		}
		return;
	}

	const stringifyStart = performance.now();
	const data = JSON.stringify(msg);
	const stringifyMs = performance.now() - stringifyStart;
	const sendStart = performance.now();
	const baseMeta = describeWsPayload(msg, data);
	let scanned = 0;
	let recipients = 0;
	let skipped = 0;
	for (const client of clients) {
		scanned++;
		if (isSlowReplaceableClient(client) || client.readyState !== 1) { skipped++; continue; }
		guardWebSocketOverflow(client, { ...baseMeta, recipientKind: "session" }, {
			pendingOverflowCheck: _pendingOverflowCheck,
			warnedClients: _warnedClients,
		}, {
			setTimeout: (cb, ms) => sessionManagerModuleClock.setTimeout(cb, ms),
			warn: (message) => console.warn(message),
		}, {
			overflowBytes: WS_BUFFER_OVERFLOW_BYTES,
			warnBytes: WS_BUFFER_WARN_BYTES,
		});
		client.send(data);
		markAssistantStreamSnapshotSent(client as AssistantStreamSocket, msg);
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

/** True for a Pi retryable `agent_end` (`{ type:"agent_end", willRetry:true }`).
 *  Pi 0.80+ emits agent_end for every retryable failed attempt BEFORE its
 *  internal auto-retry loop settles; only the final `willRetry:false` agent_end
 *  is a real turn boundary. Clients treat every agent_end as terminal
 *  (`src/app/remote-agent.ts` clears the streaming message/tool calls and
 *  notifies; `src/ui/components/AgentInterface.ts` clears the streaming
 *  container), so a retryable agent_end must never reach clients via
 *  `emitSessionEvent` or settle a wait/abort listener as final. Shared by every
 *  `rpcClient.onEvent` emit path so the suppression contract stays consistent.
 *  Pinned by tests2/core/pi-rpc-agent-end-retry.test.ts. */
export function isRetryableAgentEnd(event: unknown): boolean {
	return !!event
		&& typeof event === "object"
		&& (event as { type?: unknown }).type === "agent_end"
		&& (event as { willRetry?: unknown }).willRetry === true;
}

/** Push a raw event into the session's EventBuffer (assigning seq/ts) and
 *  broadcast the `{type:"event"}` frame to all clients with seq/ts attached.
 *  This is the single emit path for live agent events — every call site that
 *  used to do `eventBuffer.push(ev); broadcast(clients, {type:"event", data:ev})`
 *  must route through here so envelope fields stay consistent.
 *  Retryable agent_end events (`isRetryableAgentEnd`) are suppressed by callers
 *  before reaching here so clients never see a non-terminal turn-end.
 *  See docs/design/streaming-dedup-reorder.md §4.2. */
export function emitSessionEvent(session: { clients: Set<WebSocket>; eventBuffer: EventBuffer; pendingSkillExpansions?: PendingSkillSidecarEnvelope[]; previousAssistantStreamMessage?: any; onEventAccepted?: (event: unknown, cursor: number) => void }, truncated: unknown): import("./event-buffer.js").BufferedEvent {
	const normalizeStartedAt = performance.now();
	const normalized = normalizeToolResultErrorEvent(truncated);
	const sanitized = sanitizeProviderAuthEventForEmit(normalized);
	const spliced = spliceSkillExpansionsIntoEvent(session, sanitized);
	const normalizeMs = performance.now() - normalizeStartedAt;
	const eventType = spliced && typeof spliced === "object" && typeof (spliced as { type?: unknown }).type === "string"
		? (spliced as { type: string }).type
		: "unknown";
	const retainStartedAt = performance.now();
	const entry = session.eventBuffer.push(spliced);
	const retainMs = performance.now() - retainStartedAt;
	// EventBuffer acceptance is the authoritative live-message fence. Fanout is
	// isolated here so a later socket failure cannot suppress the committed fact.
	if (session.onEventAccepted) {
		try { session.onEventAccepted(spliced, entry.seq); } catch { /* observational fanout is isolated */ }
	}
	const baseFrame = { type: "event" as const, data: spliced, seq: entry.seq, ts: entry.ts };
	const assistantStreamUpdate = isAssistantStreamMessageUpdate(spliced);
	let scanned = 0;
	let recipients = 0;
	let skipped = 0;
	let bytes = 0;
	let cutovers = 0;
	let compactMs = 0;
	let stringifyMs = 0;
	let sendMs = 0;
	let steadyCompactFrame: typeof baseFrame | undefined;
	let baselineCompactFrame: typeof baseFrame | undefined;
	let steadyCompactComputed = false;
	let baselineCompactComputed = false;
	const serializedFrames = new Map<object, string>();

	for (const rawClient of session.clients) {
		scanned++;
		const client = rawClient as AssistantStreamSocket;
		if (isSlowReplaceableClient(client) || client.readyState !== 1) {
			skipped++;
			continue;
		}
		if (assistantStreamUpdate && (client.bufferedAmount ?? 0) >= WS_REPLACEABLE_MESSAGE_SOFT_CUTOVER_BYTES) {
			cutOverSlowReplaceableClient(client);
			cutovers++;
			skipped++;
			continue;
		}

		let frame = baseFrame;
		const needsBaseline = assistantStreamUpdate
			&& client.assistantStreamDeltaCapable === true
			&& client.assistantStreamDeltaNeedsBaseline === true;
		if (assistantStreamUpdate && client.assistantStreamDeltaCapable === true) {
			if (needsBaseline ? !baselineCompactComputed : !steadyCompactComputed) {
				const compactStartedAt = performance.now();
				const compact = needsBaseline
					? compactAssistantStreamDelta(spliced, session.previousAssistantStreamMessage, { selfContained: true })
					: compactAssistantStreamDelta(spliced, session.previousAssistantStreamMessage);
				compactMs += performance.now() - compactStartedAt;
				const compactFrame = compact === spliced ? baseFrame : { ...baseFrame, data: compact };
				if (needsBaseline) {
					baselineCompactFrame = compactFrame;
					baselineCompactComputed = true;
				} else {
					steadyCompactFrame = compactFrame;
					steadyCompactComputed = true;
				}
			}
			frame = (needsBaseline ? baselineCompactFrame : steadyCompactFrame) ?? baseFrame;
		}
		const satisfiesBaseline = needsBaseline
			&& frame !== baseFrame
			&& (frame.data as any)?.assistantStreamDelta === 1
			&& !!(frame.data as any)?.assistantMessageBaseline;

		let data = serializedFrames.get(frame);
		if (data === undefined) {
			const stringifyStartedAt = performance.now();
			data = JSON.stringify(frame);
			stringifyMs += performance.now() - stringifyStartedAt;
			serializedFrames.set(frame, data);
		}
		guardWebSocketOverflow(client, { ...describeWsPayload(frame, data), recipientKind: "session" }, {
			pendingOverflowCheck: _pendingOverflowCheck,
			warnedClients: _warnedClients,
		}, {
			setTimeout: (cb, ms) => sessionManagerModuleClock.setTimeout(cb, ms),
			warn: (message) => console.warn(message),
		}, {
			overflowBytes: WS_BUFFER_OVERFLOW_BYTES,
			warnBytes: WS_BUFFER_WARN_BYTES,
		});
		const sendStartedAt = performance.now();
		client.send(data);
		if (satisfiesBaseline) client.assistantStreamDeltaNeedsBaseline = false;
		sendMs += performance.now() - sendStartedAt;
		recipients++;
		bytes += Buffer.byteLength(data);
	}

	if (assistantStreamUpdate) {
		const assistantEventType = (spliced as any).assistantMessageEvent?.type;
		if (assistantEventType === "toolcall_delta") {
			// Pi's cumulative tool-call message omits the transport-only partialJson
			// needed to apply the next fragment. Keep the reconstructed chain only in
			// session memory; the retained event and durable transcript stay raw.
			const chainDelta = steadyCompactComputed
				? steadyCompactFrame?.data
				: compactAssistantStreamDelta(spliced, session.previousAssistantStreamMessage);
			session.previousAssistantStreamMessage = reconstructAssistantStreamMessage(
				chainDelta,
				session.previousAssistantStreamMessage,
			) ?? (spliced as any).message;
		} else {
			session.previousAssistantStreamMessage = (spliced as any).message;
		}
	} else if (isAssistantStreamTerminalBoundary(spliced)) {
		session.previousAssistantStreamMessage = undefined;
	}

	recordEventLoopOperation(`session-event:${eventType}:normalize`, normalizeMs);
	recordEventLoopOperation(`session-event:${eventType}:retain`, retainMs, {
		bufferSize: session.eventBuffer.size,
		retainedBytes: session.eventBuffer.retainedBytes,
	});
	recordEventLoopOperation(`session-event:${eventType}:broadcast`, compactMs + stringifyMs + sendMs, {
		recipients,
		bytes,
		cutovers,
	});
	if (cpuDiagnosticsEnabled()) {
		getCpuDiagnostics().recordWsBroadcast("session-manager:emitSessionEvent", eventType, {
			frames: 1,
			scanned,
			recipients,
			skipped,
			bytes,
			bufferSize: session.eventBuffer.size,
			retainedBytes: session.eventBuffer.retainedBytes,
			cutovers,
			normalizeMs,
			retainMs,
			compactMs,
			stringifyMs,
			sendMs,
		});
	}
	return entry;
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
	session: { pendingSkillExpansions?: PendingSkillSidecarEnvelope[] },
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
	id?: string;
	toolName: string;
	group: string;
	roleName: string;
	roleLabel: string;
	lastPromptText?: string;
	requestCount?: number;
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

export interface SessionTerminationInfo {
	projectId?: string;
	reason: "terminated" | "archived" | "purged";
	cwd?: string;
	worktreePath?: string;
	repoWorktrees?: Array<{ worktreePath: string }>;
}

export type SessionTerminationListener = (sessionId: string, info: SessionTerminationInfo) => void | Promise<void>;

/** Purge-only entry into the gateway's per-session preview operation queue. */
export type SessionPreviewPurgeOperation = <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;

export type PromotedSessionLifecycleAction = "archive" | "purge";
export type PromotedSessionLifecycleGuard = (
	sessionId: string,
	action: PromotedSessionLifecycleAction,
) => string | undefined;

export class PromotedSessionLifecycleConflictError extends Error {
	readonly statusCode = 409;
	readonly code = "PROMOTED_SESSION_LIFECYCLE_CONFLICT";

	constructor(sessionId: string, reason: string) {
		super(`Session ${sessionId} cannot be archived or purged directly: ${reason}`);
		this.name = "PromotedSessionLifecycleConflictError";
	}
}

/** Retryable admission failure while a regular session is being promoted in place. */
export class SessionGoalPromotionInProgressError extends Error {
	readonly statusCode = 409;
	readonly code = "SESSION_GOAL_PROMOTION_IN_PROGRESS";
	readonly retryable = true;

	constructor(sessionId: string) {
		super(`Session ${sessionId} is reserved for current-session goal promotion; retry after promotion finishes`);
		this.name = "SessionGoalPromotionInProgressError";
	}
}

/**
 * Opaque process-local authority for one current-session promotion attempt.
 * SessionManager validates object identity; callers cannot manufacture authority
 * by copying the visible fields.
 */
export interface SessionGoalPromotionReservation {
	readonly sessionId: string;
	readonly attemptId: string;
}

interface OwnedSessionGoalPromotionReservation extends SessionGoalPromotionReservation {
	goalId?: string;
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
	/** Timer/clock implementation. Defaults to real timers. */
	clock?: Clock;
	/** Command runner implementation. Defaults to real child_process execution. */
	commandRunner?: CommandRunner;
	/** Runtime boundary flag for legacy BOBBIT_SKIP_TITLE_GEN behavior. */
	skipTitleGeneration?: boolean;
	remoteGitPolicy?: RemoteGitPolicy;
	testPreparingDelayMs?: string;
	worktreeSetupRuntime?: { skipNpmCi?: boolean; recordSetupPath?: string };
	/**
	 * Gateway state directory used to resolve the per-gateway `session-prompts`
	 * scratch dir. Threaded so prompt persistence is isolated per gateway rather
	 * than sharing a process-global (multi-gateway v2 test harness safety).
	 * Defaults to bobbitStateDir() when omitted.
	 */
	stateDir?: string;
	/** Test seam for boot restore lag, in milliseconds. The production default
	 * samples a `monitorEventLoopDelay()` histogram. */
	bootRestoreLagSampler?: () => number;
	/** Promise-only seam for bounded expired-archive transcript stats. */
	archiveStat?: (filePath: string) => Promise<{ size: number }>;
	/**
	 * Purge-only entry into the server-owned preview queue. Production marks the
	 * session terminal before awaiting this operation so later preview requests
	 * cannot recreate a mount after deletion.
	 */
	previewPurgeOperation?: SessionPreviewPurgeOperation;
	/** Late-bound graph guard supplied by goal/team ownership. A reason blocks direct destruction. */
	promotedSessionLifecycleGuard?: PromotedSessionLifecycleGuard;
	/** Narrow canonical notification publication seam. */
	hostNotificationPublisher?: HostSessionNotificationPublisher;
}

type SessionReplacementToken = {
	coordinator: SessionReplacementCoordinator;
	generation: number;
	kind: string;
};

export class ContextClearError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "ContextClearError";
		this.code = code;
	}
}

type ClearCapturedTuple = {
	provider: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
};

type UnmaterializedClearRecovery = {
	boundary: ContextClearBoundary;
	newAgentSessionFile: string;
	boundaries: ContextClearBoundary[];
	persistenceShape: ContextClearPersistenceShape;
};

type SessionRoleReplacementProjection = {
	goalId: string;
	teamGoalId: string;
	role: "team-lead";
	accessory: string;
	/** Promotion retains the source session's verified tuple instead of adopting role defaults. */
	preserveModelTuple: true;
	/** Exact existing sandbox realm captured from the source before staging. */
	expectedSandboxContainerId?: string;
};

type PromotionAttachmentField = "goalId" | "teamGoalId" | "role" | "accessory" | "containerId";
type PromotionAttachmentSnapshot = Record<PromotionAttachmentField, { present: boolean; value: unknown }>;

type SessionReplacementCoordinator = {
	tail: Promise<void>;
	pending: number;
	active?: SessionReplacementToken;
	/** Closes runtime model/thinking admission synchronously for the sole in-place transcript replacement. */
	contextClearPending: boolean;
	promptOwner?: SessionInfo;
	coalesced: Map<string, Promise<unknown>>;
	drainOnRelease: boolean;
	/** A Stop/terminate accepted while a bridge is absent cancels every non-terminal install. */
	terminalRequest?: "stop" | "terminate";
	/** Interrupted-turn continuation waits until the final canonical bridge wins. */
	bootContinuationPending: boolean;
};

type IdleWaiter = {
	resolve: () => void;
	reject: (error: Error) => void;
	cleanup: () => void;
};

type WorktreeOwnerLifecycleQueue = {
	tail: Promise<void>;
	pending: number;
};

/**
 * Build the markdown workflow list injected into the goal-assistant prompt's
 * `{{AVAILABLE_WORKFLOWS}}` placeholder. Pure function over the resolved
 * workflow set — the single source for both the empty-project branch and the
 * per-workflow bullet formatting. Extracted from `SessionManager._buildWorkflowList`
 * so it can be unit-tested without a full SessionManager.
 */
export function buildWorkflowListText(workflows: import("./workflow-store.js").Workflow[]): string {
	if (!workflows || workflows.length === 0) {
		return '⚠️ This project has no registered workflows configured. The preferred path is to scaffold a registered workflow first — tell the user they can open the project assistant from Settings → Components (or click the banner in the goal panel) to set them up. However, you MAY still propose a goal for a workflowless project provided you supply a valid `inlineWorkflow` in the propose_goal call — that inline workflow becomes the authoritative workflow for the goal. Prefer inline workflow only as a planning-stage escape hatch when the user wants to proceed without scaffolding registered workflows.';
	}
	return workflows.map(w => {
		const gateNames = w.gates.map(g => g.name).join(', ');
		return `- **${w.id}** (${w.name}) — ${w.description}. Gates: ${gateNames}.`;
	}).join('\n');
}

export interface VerifierPromptReceipt {
	/** Durable queue identity for this one verifier-owned intent. */
	rowId: string;
	/** Resolves only when this exact row's RPC delivery is accepted. */
	dispatched: Promise<void>;
	/** Actual delivery path, updated when a direct attempt is busy-recovered. */
	readonly mode: "direct" | "queued" | "busy-recovered";
	/** Removes an undispatched row and fences a late dispatch acknowledgement. */
	cancel(): boolean;
}

type PendingVerifierPromptReceipt = {
	resolve: () => void;
	reject: (error: Error) => void;
	cancelled: boolean;
	mode: "direct" | "queued" | "busy-recovered";
};

export class SessionManager {
	private sessions = new Map<string, SessionInfo>();
	/** Opaque claims keep lifecycle authority out of route-visible values. */
	private readonly _toolCallInterceptorClaims = new WeakMap<object, OwnedToolCallInterceptorClaim>();
	/** Exact verifier rows waiting for provider acceptance, keyed by session/row. */
	private _verifierPromptReceipts?: Map<string, Map<string, PendingVerifierPromptReceipt>>;
	/** Sessions with at least one attached WS client. Keeps heartbeat work proportional to active viewers. */
	private sessionsWithConnectedClients = new Set<SessionInfo>();
	private agentCliPath?: string;
	private systemPromptPath?: string;
	private readonly clock: Clock;
	private readonly commandRunner: CommandRunner;
	private readonly skipTitleGeneration: boolean;
	private readonly remoteGitPolicy: RemoteGitPolicy;
	private readonly testPreparingDelayMs?: string;
	private readonly worktreeSetupRuntime: { skipNpmCi?: boolean; recordSetupPath?: string };
	/**
	 * Gateway state dir for resolving the per-gateway session-prompts scratch dir.
	 * Single source of truth for prompt persistence/cleanup, threaded into the
	 * system-prompt functions so multiple in-process gateways don't collide.
	 */
	public readonly stateDir: string;
	/** @internal Test-only session store (used when no PCM is available). */
	private _testStore: SessionStore | null = null;
	private _testBgProcessStore: BgProcessStore | null = null;
	/** @internal Test-only cost tracker (used when no PCM is available). */
	private _testCostTracker: CostTracker | null = null;
	/** @internal Test-only search index (used when no PCM is available). */
	private _testSearchIndex: SearchService | null = null;
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
	private mcpManager: McpManager | null = null;
	private scopedMcpManagers: Map<string, McpManager> = new Map();
	private marketplaceMcpResolver: MarketplaceMcpResolver | null = null;
	private marketplacePiExtensionResolver: MarketplacePiExtensionResolver | null = null;
	private packLocalDataBindingsResolver: PackLocalDataBindingsResolver | null = null;
	private piExtensionRuntimeDiagnostics = new Map<string, PiExtensionDiagnostic>();
	private worktreePools: Map<string, WorktreePool> = new Map();
	private worktreePoolInitializations = new Map<string, Promise<void>>();
	sandboxManager: SandboxManager | null = null;
	sandboxTokenStore: import("../auth/sandbox-token.js").SandboxTokenStore | null = null;
	lifecycleHub?: LifecycleHub;
	private hostInterceptors?: SessionHostInterceptorPort;
	private hostNotificationPublisher?: HostSessionNotificationPublisher;
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
	private _onSessionQuestionStateChanged?: (sessionId: string, hasUnansweredQuestion: boolean) => void;
	private _verificationHarness?: import("./verification-harness.js").VerificationHarness;
	private _terminationListeners: SessionTerminationListener[] = [];
	private _creationListeners: Array<(session: SessionInfo) => void> = [];
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
	/** Stores owned by the non-PCM test fallback and closed by shutdown(). */
	private _testGoalStore: GoalStore | null = null;
	private _testTaskStore: TaskStore | null = null;
	/** @internal Non-PCM test path only. */
	private _testTaskManager: TaskManager | null = null;
	private purgeInterval: ReturnType<typeof setInterval> | null = null;
	private archivePurgeInFlight: Promise<void> | null = null;
	/** Per-session destructive purge owner shared by immediate and expiry paths. */
	private sessionPurgesInFlight = new Map<string, Promise<void>>();
	private readonly archiveStat: (filePath: string) => Promise<{ size: number }>;
	private readonly previewPurgeOperation: SessionPreviewPurgeOperation;
	private promotedSessionLifecycleGuard?: PromotedSessionLifecycleGuard;
	/** Heartbeat timer: re-broadcasts the current `session_status` for every
	 *  active session every STATUS_HEARTBEAT_INTERVAL_MS, WITHOUT bumping
	 *  `statusVersion`. Self-heals any client that missed a transition frame.
	 *  See docs/design/unify-session-status.md §3.4. */
	private _statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private static readonly STATUS_HEARTBEAT_INTERVAL_MS = 15_000;
	/**
	 * Single per-session replacement owner. Restore/respawn, role assignment,
	 * force-abort recovery, and termination all serialize here. Its presence is
	 * also the prompt-dispatch fence: accepted intent is durably queued on
	 * `promptOwner` until the final replacement commits or rolls back.
	 */
	private _sessionReplacementCoordinators = new Map<string, SessionReplacementCoordinator>();
	/** Last admitted clear token generation; unlike lifecycleGeneration, generic bridge replacements never advance it. */
	private _contextClearGenerations = new Map<string, number>();
	/**
	 * Short-lived owner reservation spanning goal/gate/team mutation and the
	 * coordinated runtime replacement. This is deliberately distinct from the
	 * replacement coordinator: it closes admission before any graph mutation.
	 */
	private _sessionGoalPromotionReservations = new Map<string, OwnedSessionGoalPromotionReservation>();
	/** Per-owner FIFO shared by worktree-reuse publication and destructive lifecycle operations in every realm. */
	private _worktreeOwnerLifecycleQueues = new Map<string, WorktreeOwnerLifecycleQueue>();
	/** @deprecated Compatibility alias for diagnostics; use the realm-neutral lifecycle methods. */
	readonly _sandboxBorrowerLifecycleQueues = this._worktreeOwnerLifecycleQueues;
	/**
	 * Raw explicit/inherited thinking requests retained only while initial setup is
	 * verifying its spawn tuple. The provisional spawn pin may already have been
	 * clamped for a model that controlled fallback later replaces.
	 */
	private _setupInitialThinkingAuthorities = new Map<string, SetupInitialThinkingAuthority>();
	/** User-driven orphan-history recoveries include their redrive so duplicate Retry clicks join instead of dispatching twice. */
	private _poisonedHistoryRecoveries = new Map<string, Promise<void>>();
	/** Latest lifecycle generation for each session; stale SessionInfo writers must no-op when behind this value. */
	private _sessionRespawnGenerations = new Map<string, number>();
	/** Session-to-task lookup memo, invalidated by ProjectContextManager's
	 * topology-aware task generation. Cached absence is intentional. */
	private _taskIdCache = new Map<string, { gen: number; taskId: string | undefined }>();
	/** Per-session durable tag mutation queue. Preserves request admission order. */
	private _pinMutationQueues = new Map<string, Promise<string[]>>();
	/** Per-session ask terminal-mutation queue. Keeps dismissal persistence and unanswered-state projection linearized. */
	private _askTerminalMutationQueues = new Map<string, Promise<void>>();
	/** Injected boot lag sampler. When absent, restoreSessions owns a temporary
	 * real event-loop delay histogram for the duration of eager restoration. */
	private readonly _bootRestoreLagSampler?: () => number;
	/** Cached aigw model discovery result (url → { models, timestamp }) */
	private _aigwModelCache: { url: string; models: Awaited<ReturnType<typeof discoverAigwModels>>; ts: number } | null = null;
	private static AIGW_CACHE_TTL_MS = 60_000; // 1 minute

	/** Clear auto-selection discovery state after configure, refresh, or removal. */
	invalidateAigwModelCache(): void {
		this._aigwModelCache = null;
	}

	private retainSetupInitialThinkingAuthority(sessionId: string, rawInitialThinkingLevel: string | undefined): () => void {
		const initialThinkingLevel = isKnownThinkingLevel(rawInitialThinkingLevel);
		if (!initialThinkingLevel) return () => {};
		const authority: SetupInitialThinkingAuthority = { initialThinkingLevel };
		this._setupInitialThinkingAuthorities.set(sessionId, authority);
		return () => {
			if (this._setupInitialThinkingAuthorities.get(sessionId) === authority) {
				this._setupInitialThinkingAuthorities.delete(sessionId);
			}
		};
	}

	private _idleWaiters = new Map<string, Set<IdleWaiter>>();

	/** The replacement coordinator owns the only queue that may accept prompts. */
	private _promptQueueOwner(sessionId: string): SessionInfo | undefined {
		return this._sessionReplacementCoordinators.get(sessionId)?.promptOwner ?? this.sessions.get(sessionId);
	}

	/**
	 * Lightweight unit seams may instantiate the prototype without field
	 * initializers. Receipt bookkeeping is auxiliary to regular prompt delivery,
	 * so lazily restore it instead of letting settlement throw from a queue drain.
	 */
	private _getVerifierPromptReceipts(): Map<string, Map<string, PendingVerifierPromptReceipt>> | undefined {
		return this._verifierPromptReceipts;
	}

	private _ensureVerifierPromptReceipts(): Map<string, Map<string, PendingVerifierPromptReceipt>> {
		return this._verifierPromptReceipts ??= new Map<string, Map<string, PendingVerifierPromptReceipt>>();
	}

	private createVerifierPromptReceipt(
		sessionId: string,
		rowId: string,
		mode: PendingVerifierPromptReceipt["mode"],
	): VerifierPromptReceipt {
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const dispatched = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
		const pending: PendingVerifierPromptReceipt = { resolve, reject, cancelled: false, mode };
		const receiptStore = this._ensureVerifierPromptReceipts();
		const receipts = receiptStore.get(sessionId) ?? new Map<string, PendingVerifierPromptReceipt>();
		receipts.set(rowId, pending);
		receiptStore.set(sessionId, receipts);
		return {
			rowId,
			dispatched,
			get mode() { return pending.mode; },
			cancel: () => this.cancelVerifierPrompt(sessionId, rowId),
		};
	}

	private markVerifierPromptBusyRecovered(sessionId: string, rowId: string): void {
		const pending = this._getVerifierPromptReceipts()?.get(sessionId)?.get(rowId);
		if (pending) pending.mode = "busy-recovered";
	}

	/** Remove only a verifier-owned row from the coordinator's canonical queue. */
	private removeVerifierPromptRow(sessionId: string, rowId: string): boolean {
		const owner = this._promptQueueOwner(sessionId);
		const row = owner?.promptQueue.toArray().find(candidate => candidate.id === rowId);
		if (!owner || row?.verifierOwned !== true) return false;
		const removed = owner.promptQueue.remove(rowId);
		if (removed) this.broadcastQueue(owner);
		return removed;
	}

	private abandonVerifierPrompt(sessionId: string, rowId: string, error: Error): void {
		this.removeVerifierPromptRow(sessionId, rowId);
		this.settleVerifierPromptReceipt(sessionId, rowId, error);
	}

	/**
	 * Settle only the verifier receipts belonging to an exact rejected dispatch.
	 * Ordinary durable rows remain available for the interactive manual-retry
	 * lifecycle, but verification must never wait for a row this path no longer
	 * owns (notably after auth, terminal retry, or process-exit failures).
	 */
	private abandonVerifierPromptDispatchRows(session: SessionInfo, rows: Array<{
		id?: string;
		verifierOwned?: boolean;
	}>, durableQueueRowIds: Array<string | undefined> | undefined, error: Error): boolean {
		let abandoned = false;
		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			if (row.verifierOwned !== true) continue;
			const rowId = durableQueueRowIds?.[index] ?? row.id;
			if (!rowId) continue;
			this.abandonVerifierPrompt(session.id, rowId, error);
			abandoned = true;
		}
		return abandoned;
	}

	/** Purge verifier rows from the same canonical queue used for enqueue/cancel. */
	private purgeVerifierPromptRows(sessionId: string, reason: string): void {
		// Teardown can observe a replacement owner after only part of SessionInfo
		// has been assembled. Receipt fencing is still mandatory, but a missing or
		// malformed queue must never prevent termination/restart from proceeding.
		try {
			const owner = this._promptQueueOwner(sessionId);
			const rows = owner?.promptQueue?.toArray?.() ?? [];
			for (const row of rows) {
				if (row.verifierOwned === true) this.removeVerifierPromptRow(sessionId, row.id);
			}
		} catch {
			console.warn(`[session-manager] Best-effort verifier queue purge failed for ${sessionId}`);
		} finally {
			this.cancelAllVerifierPromptReceipts(sessionId, reason);
		}
	}

	private settleVerifierPromptReceipt(sessionId: string, rowId: string, error?: Error): void {
		const receiptStore = this._getVerifierPromptReceipts();
		if (!receiptStore) return;
		const receipts = receiptStore.get(sessionId);
		const pending = receipts?.get(rowId);
		if (!pending || !receipts) return;
		receipts.delete(rowId);
		if (receipts.size === 0) receiptStore.delete(sessionId);
		if (pending.cancelled) {
			pending.reject(new Error(`Verifier prompt ${rowId} was cancelled before dispatch`));
		} else if (error) {
			pending.reject(error);
		} else {
			pending.resolve();
		}
	}

	private cancelAllVerifierPromptReceipts(sessionId: string, reason: string): void {
		const receiptStore = this._getVerifierPromptReceipts();
		if (!receiptStore) return;
		const receipts = receiptStore.get(sessionId);
		if (!receipts) return;
		receiptStore.delete(sessionId);
		for (const pending of receipts.values()) {
			pending.cancelled = true;
			pending.reject(new Error(reason));
		}
	}

	/** A process terminal rejects receipts without asserting anything about its attempted prompt. */
	private rejectAllVerifierPromptReceipts(sessionId: string, reason: string): void {
		const receiptStore = this._getVerifierPromptReceipts();
		if (!receiptStore) return;
		const receipts = receiptStore.get(sessionId);
		if (!receipts) return;
		receiptStore.delete(sessionId);
		for (const pending of receipts.values()) pending.reject(new Error(reason));
	}

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

	private _currentRespawnGeneration(sessionId: string): number {
		return this._sessionRespawnGenerations.get(sessionId) ?? 0;
	}

	private _nextRespawnGeneration(sessionId: string): number {
		const next = this._currentRespawnGeneration(sessionId) + 1;
		this._sessionRespawnGenerations.set(sessionId, next);
		return next;
	}

	private _sessionWriterIsCurrent(session: SessionInfo): boolean {
		if (session.lifecycleFenced) return false;
		const canonical = this.sessions.get(session.id);
		if (canonical && canonical !== session) return false;
		return (session.lifecycleGeneration ?? 0) === this._currentRespawnGeneration(session.id);
	}

	private clearToolCallProvenance(session: SessionInfo): void {
		for (const entry of session.hostToolCallLifecycle?.values() ?? []) entry.controller.abort("tool-lifecycle-cleared");
		session.hostToolCallLifecycle?.clear();
		for (const waiter of session.hostToolCallBeforeWaiters?.values() ?? []) {
			this.clock.clearTimeout(waiter.timer);
			waiter.resolve(undefined);
		}
		session.hostToolCallBeforeWaiters?.clear();
	}

	/**
	 * Narrow read-only ownership view for runtime controls that must not cross an
	 * in-place context clear. Role replacement, rehydrate, recovery, and terminal
	 * coordinators retain their established runtime-selection ownership semantics.
	 */
	getSessionReplacementAdmission(sessionId: string): { active: boolean; generation: number } {
		const coordinator = this._sessionReplacementCoordinators?.get(sessionId);
		let generation = this._contextClearGenerations?.get(sessionId);
		if (generation === undefined) {
			generation = this._currentRespawnGeneration(sessionId);
			this._contextClearGenerations?.set(sessionId, generation);
		}
		return {
			active: coordinator?.contextClearPending === true,
			generation,
		};
	}

	/** Read-only admission view over the existing replacement coordinator. */
	getModelSelectionRecoveryAdmission(sessionId: string): {
		condition?: ModelSelectionRequiredCondition;
		activationInProgress: boolean;
	} {
		const coordinator = this._sessionReplacementCoordinators?.get(sessionId);
		const ownerCondition = coordinator?.promptOwner?.condition;
		const canonicalCondition = this.sessions?.get(sessionId)?.condition;
		return {
			condition: ownerCondition?.code === "MODEL_SELECTION_REQUIRED"
				? ownerCondition
				: canonicalCondition?.code === "MODEL_SELECTION_REQUIRED"
					? canonicalCondition
					: undefined,
			activationInProgress: coordinator?.active?.kind === "model-recovery",
		};
	}

	private _assertModelSelectionReady(sessionId: string): void {
		const condition = this.getModelSelectionRecoveryAdmission(sessionId).condition;
		if (condition) throw new ModelSelectionRequiredError(condition);
	}

	private _fenceReplacedSession(session: SessionInfo, replacingGeneration: number): void {
		// Fence pending activity before any old-bridge stop can release a stale RPC
		// acknowledgement. Object replacement alone cannot invalidate its WeakMap state.
		cancelPendingSessionPromptActivity(session);
		this._taskIdCache.delete(session.id);
		session.lifecycleFenced = true;
		session.lifecycleGeneration = replacingGeneration - 1;
		session.staffNotificationTurnContext = undefined;
		this.clearToolCallProvenance(session);
		session.dormant = true;
		session.status = "terminated";
		session.clients.clear();
		this.cancelPendingAutoRetry(session, "terminated");
		this._untrackConnectedSession(session);
	}

	private _replacementTokenIsCurrent(sessionId: string, token: SessionReplacementToken): boolean {
		const coordinator = this._sessionReplacementCoordinators.get(sessionId);
		return coordinator === token.coordinator
			&& coordinator.active === token
			&& this._currentRespawnGeneration(sessionId) === token.generation;
	}

	private _mergeReplacementPromptOwner(coordinator: SessionReplacementCoordinator, canonical: SessionInfo | undefined): void {
		const owner = coordinator.promptOwner;
		if (!owner || !canonical || owner === canonical) {
			if (canonical) coordinator.promptOwner = canonical;
			return;
		}
		const canonicalRows = canonical.promptQueue.toArray();
		const knownIds = new Set(canonicalRows.map(row => row.id));
		const missing = owner.promptQueue.toArray().filter(row => !knownIds.has(row.id));
		if (missing.length > 0) {
			canonical.promptQueue = new PromptQueue([...canonicalRows, ...missing]);
			this.broadcastQueue(canonical);
		}
		if (owner.pendingSkillExpansions?.length) {
			const existing = canonical.pendingSkillExpansions ?? [];
			const signatures = new Set(existing.map(entry => JSON.stringify(entry)));
			canonical.pendingSkillExpansions = [
				...existing,
				...owner.pendingSkillExpansions.filter(entry => !signatures.has(JSON.stringify(entry))),
			];
		}
		if (owner.recoveredPromptDispatchQueueIds?.length) {
			canonical.recoveredPromptDispatchQueueIds = [
				...new Set([
					...(canonical.recoveredPromptDispatchQueueIds ?? []),
					...owner.recoveredPromptDispatchQueueIds,
				]),
			];
		}
		if (owner.poisonRecoveryPromptDispatchQueueIds?.length) {
			canonical.poisonRecoveryPromptDispatchQueueIds = [
				...new Set([
					...(canonical.poisonRecoveryPromptDispatchQueueIds ?? []),
					...owner.poisonRecoveryPromptDispatchQueueIds,
				]),
			];
		}
		if (owner.explicitRetryQueueRowId && canonical.promptQueue.toArray().some(row => row.id === owner.explicitRetryQueueRowId)) {
			canonical.explicitRetryQueueRowId = owner.explicitRetryQueueRowId;
		}
		canonical.lastPromptSource = owner.lastPromptSource ?? canonical.lastPromptSource;
		coordinator.promptOwner = canonical;
	}

	private _coordinateSessionReplacement<T>(
		sessionId: string,
		kind: string,
		operation: (token: SessionReplacementToken) => Promise<T>,
		opts?: {
			coalesceKey?: string;
			drainOnRelease?: boolean;
			/** Non-terminal operations return this without staging when Stop/terminate already won. */
			cancelOnTerminal?: () => T | Promise<T>;
		},
	): Promise<T> {
		let coordinator = this._sessionReplacementCoordinators.get(sessionId);
		if (!coordinator) {
			coordinator = {
				tail: Promise.resolve(),
				pending: 0,
				contextClearPending: false,
				promptOwner: this.sessions.get(sessionId),
				coalesced: new Map(),
				drainOnRelease: false,
				bootContinuationPending: false,
			};
			this._sessionReplacementCoordinators.set(sessionId, coordinator);
		}
		if (opts?.coalesceKey) {
			const existing = coordinator.coalesced.get(opts.coalesceKey);
			if (existing) return existing as Promise<T>;
		}

		coordinator.pending += 1;
		coordinator.drainOnRelease ||= opts?.drainOnRelease === true;
		if (kind === "clear-context") coordinator.contextClearPending = true;
		const owned = coordinator;
		const operationPromise = owned.tail.then(async () => {
			// Terminal intent is sticky for the coordinator lifetime. A replacement
			// queued before Stop/terminate but not yet started must never create a
			// hidden process after cancellation wins.
			if (owned.terminalRequest && opts?.cancelOnTerminal) {
				return opts.cancelOnTerminal();
			}
			const token: SessionReplacementToken = {
				coordinator: owned,
				generation: this._nextRespawnGeneration(sessionId),
				kind,
			};
			// Advancing the canonical generation invalidates every outstanding tool
			// callback claim, including in-place bridge replacements that retain the
			// same SessionInfo object and session secret.
			const priorWriter = this.sessions.get(sessionId);
			if (priorWriter) this.clearToolCallProvenance(priorWriter);
			owned.active = token;
			if (kind === "clear-context") this._contextClearGenerations.set(sessionId, token.generation);
			try {
				const result = await operation(token);
				if (!this._replacementTokenIsCurrent(sessionId, token)) {
					throw new Error(`Session ${sessionId} ${kind} replacement was superseded`);
				}
				return result;
			} finally {
				// Token generation is finalized in exactly one place. Operations may
				// legitimately no-op (for example Stop queued behind a role swap), or
				// throw after reinstalling a rollback capsule; either way the surviving
				// canonical writer must match the generation the coordinator advanced.
				if (this._replacementTokenIsCurrent(sessionId, token)) {
					const canonical = this.sessions.get(sessionId);
					if (canonical) canonical.lifecycleGeneration = token.generation;
				}
			}
		});
		let resultPromise!: Promise<T>;
		resultPromise = operationPromise.finally(async () => {
			if (opts?.coalesceKey && owned.coalesced.get(opts.coalesceKey) === resultPromise) {
				owned.coalesced.delete(opts.coalesceKey);
			}
			if (kind === "clear-context") owned.contextClearPending = false;
			owned.pending -= 1;
			this._mergeReplacementPromptOwner(owned, this.sessions.get(sessionId));
			if (owned.pending !== 0 || this._sessionReplacementCoordinators.get(sessionId) !== owned) return;

			let canonical = this.sessions.get(sessionId);
			// Stop/terminate accepted through a transient map gap wins over startup:
			// never make the rollback capsule idle, boot-continue, or drain intent.
			if (canonical && !owned.terminalRequest) {
				if (canonical.status === "starting") broadcastStatus(canonical, "idle");
				if (owned.bootContinuationPending) {
					// Keep the coordinator installed across the cold prompt RPC. Prompts
					// accepted while readiness/ack is pending stay on the coordinator's
					// durable ledger instead of racing a second prompt on this bridge.
					owned.bootContinuationPending = false;
					const accepted = await this._dispatchBootContinuation(canonical);
					// An unobserved rejection did not consume the durable interrupted-turn
					// marker. If another replacement joined while the RPC was pending, carry
					// that intent through its queued lifecycle and retry only on the final
					// canonical bridge. With no join, the persisted wasStreaming marker stays
					// authoritative for the next gateway restore as before.
					if (!accepted && canonical.restoreStartupWasStreaming === true) {
						owned.bootContinuationPending = true;
					}
					this._mergeReplacementPromptOwner(owned, this.sessions.get(sessionId));
					if (owned.pending !== 0 || this._sessionReplacementCoordinators.get(sessionId) !== owned) return;
					canonical = this.sessions.get(sessionId);
				}
			}

			this._sessionReplacementCoordinators.delete(sessionId);
			owned.active = undefined;
			// Termination destroys the session. Stop destroys only the current turn:
			// queued continuation rows are retargeted for this sole post-abort drain
			// boundary, while ambiguous dispatched attempts remain in their ledger.
			if (!canonical || owned.terminalRequest === "terminate") return;
			if (process.env.BOBBIT_DEBUG && canonical) {
				console.log(`[reliable-turn] replacement-release session=${sessionId} terminal=${owned.terminalRequest ?? "none"} status=${canonical.status} queued=${canonical.promptQueue.length} drain=${owned.drainOnRelease}`);
			}
			if (
				owned.drainOnRelease
				&& canonical.status === "idle"
				// Sticky drain intent from an earlier successful replacement must not
				// override a later canonical turn error or manual-recovery rejection.
				// The durable rows remain queued until explicit Retry/fresh user intent.
				&& !canonical.lastTurnErrored
				&& !canonical.manualRetryRequired
				&& !canonical.isCompacting
				&& !this._bootRepromptedSessions.has(sessionId)
				&& !canonical.promptQueue.isEmpty
			) this.drainQueue(canonical);
		});
		owned.tail = resultPromise.then(() => undefined, () => undefined);
		if (opts?.coalesceKey) owned.coalesced.set(opts.coalesceKey, resultPromise);
		return resultPromise;
	}

	private _captureContextClearPersistenceShape(store: SessionStore, id: string): ContextClearPersistenceShape | undefined {
		if (typeof store.captureContextClearPersistenceShape === "function") {
			return store.captureContextClearPersistenceShape(id);
		}
		// Lightweight lifecycle fixtures may provide only the SessionStore's public
		// get/update surface. Production always uses the exact-shape store method.
		const current = store.get(id);
		if (!current) return undefined;
		const raw = current as unknown as Record<string, unknown>;
		const capture = (field: string) => ({
			present: Object.prototype.hasOwnProperty.call(raw, field),
			value: raw[field] === undefined ? undefined : structuredClone(raw[field]),
		});
		return {
			agentSessionFile: current.agentSessionFile,
			contextClearBoundaries: capture("contextClearBoundaries"),
			wasStreaming: capture("wasStreaming"),
			streamingStartedAt: capture("streamingStartedAt"),
		};
	}

	private _restoreContextClearPersistenceShape(
		store: SessionStore,
		id: string,
		shape: ContextClearPersistenceShape,
	): void {
		if (typeof store.restoreContextClearPersistenceShape === "function") {
			store.restoreContextClearPersistenceShape(id, shape);
			return;
		}
		const current = store.get(id) as unknown as Record<string, unknown> | undefined;
		if (!current) return;
		current.agentSessionFile = shape.agentSessionFile;
		for (const [field, fieldShape] of Object.entries({
			contextClearBoundaries: shape.contextClearBoundaries,
			wasStreaming: shape.wasStreaming,
			streamingStartedAt: shape.streamingStartedAt,
		})) {
			if (fieldShape.present) current[field] = fieldShape.value;
			else delete current[field];
		}
	}

	private _validatedAgentSessionPathIdentity(ps: PersistedSession, filePath: string): string {
		if (!filePath || filePath.includes("\0")) throw new Error("Agent session path is empty or invalid");
		const containerPath = canonicalContainerAgentSessionPath(filePath);
		if (containerPath) return `container:${containerPath}`;
		trustPersistedAgentSessionFile(filePath);
		if (ps.sandboxed) {
			const translated = switchSessionPathForAgent({ ...ps, agentSessionFile: filePath });
			const canonical = canonicalContainerAgentSessionPath(translated);
			if (canonical) return `container:${canonical}`;
		}
		const readable = resolveReadablePersistedAgentSessionFile(filePath);
		if (!readable && !isWithinAgentSessionsDir(filePath)) {
			throw new Error("Agent session path is outside readable roots");
		}
		const resolved = path.resolve(readable ?? filePath);
		return `host:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
	}

	private _sameAgentSessionPath(ps: PersistedSession, left: string, right: string): boolean {
		return this._validatedAgentSessionPathIdentity(ps, left)
			=== this._validatedAgentSessionPathIdentity(ps, right);
	}

	private _messageRowsFromRpc(response: any, operation: string): any[] {
		if (!response?.success) throw new Error(`${operation} failed: ${response?.error ?? "unknown error"}`);
		const data = response.data;
		const messages = Array.isArray(data)
			? data
			: data && typeof data === "object" && Array.isArray(data.messages)
				? data.messages
				: undefined;
		if (!messages) throw new Error(`${operation} returned an invalid message list`);
		return messages;
	}

	private _activeTranscriptEntriesFromRpc(response: any, operation: string): Record<string, any>[] {
		if (!response?.success) throw new Error(`${operation} failed: ${response?.error ?? "unknown error"}`);
		const snapshot = response.data;
		if (!snapshot || !Array.isArray(snapshot.entries)) {
			throw new Error(`${operation} returned an invalid transcript tree`);
		}
		const entries = snapshot.entries as Record<string, any>[];
		const byId = new Map<string, Record<string, any>>();
		for (const entry of entries) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error(`${operation} returned a malformed transcript entry`);
			}
			if (typeof entry.id === "string" && entry.id.length > 0) {
				if (byId.has(entry.id)) throw new Error(`${operation} returned duplicate transcript ids`);
				byId.set(entry.id, entry);
			}
		}
		if (entries.length === 0 && (snapshot.leafId === null || snapshot.leafId === undefined)) return [];
		if (typeof snapshot.leafId !== "string" || !byId.has(snapshot.leafId)) {
			throw new Error(`${operation} returned an invalid transcript leaf`);
		}
		const reverse: Record<string, any>[] = [];
		const seen = new Set<string>();
		let cursor: string | null = snapshot.leafId;
		while (cursor !== null) {
			if (seen.has(cursor)) throw new Error(`${operation} returned a cyclic transcript tree`);
			seen.add(cursor);
			const entry = byId.get(cursor);
			if (!entry) throw new Error(`${operation} returned a missing transcript parent`);
			reverse.push(entry);
			if (entry.parentId !== null && typeof entry.parentId !== "string") {
				throw new Error(`${operation} returned an invalid transcript parent`);
			}
			cursor = entry.parentId;
		}
		return reverse.reverse();
	}

	private _stateData(response: any, operation: string): any {
		if (!response?.success || !response.data || typeof response.data !== "object") {
			throw new Error(`${operation} failed: ${response?.error ?? "invalid state"}`);
		}
		return response.data;
	}

	private _captureClearTuple(state: any): ClearCapturedTuple {
		const provider = state?.model?.provider;
		const modelId = state?.model?.id;
		const thinkingLevel = isKnownThinkingLevel(state?.thinkingLevel);
		if (typeof provider !== "string" || !provider || typeof modelId !== "string" || !modelId || !thinkingLevel) {
			throw new Error("The active model and thinking level could not be captured");
		}
		return { provider, modelId, thinkingLevel };
	}

	private async _applyAndVerifyClearTuple(
		rpcClient: RpcBridge,
		tuple: ClearCapturedTuple,
		expectedPath: string,
		ps: PersistedSession,
	): Promise<any> {
		const model = await rpcClient.setModel(tuple.provider, tuple.modelId);
		if (model?.success === false) throw new Error(`set_model failed: ${model.error ?? "rejected"}`);
		const thinking = await rpcClient.setThinkingLevel(tuple.thinkingLevel);
		if (thinking?.success === false) throw new Error(`set_thinking_level failed: ${thinking.error ?? "rejected"}`);
		const state = this._stateData(await rpcClient.getState(), "get_state after context replacement");
		if (!this._sameAgentSessionPath(ps, state.sessionFile, expectedPath)
			|| state.model?.provider !== tuple.provider
			|| state.model?.id !== tuple.modelId
			|| isKnownThinkingLevel(state.thinkingLevel) !== tuple.thinkingLevel) {
			throw new Error("Fresh context configuration read-back did not match the active session");
		}
		if (state.messageCount !== 0 || state.pendingMessageCount !== 0) {
			throw new Error("Fresh context state was not empty");
		}
		if (this._messageRowsFromRpc(await rpcClient.getMessages(), "get_messages after context configuration").length !== 0) {
			throw new Error("Fresh context gained messages while configuration was restored");
		}
		return state;
	}

	private async _applyAndVerifyRollbackTuple(
		rpcClient: RpcBridge,
		tuple: ClearCapturedTuple,
		expectedPath: string,
		ps: PersistedSession,
	): Promise<void> {
		const model = await rpcClient.setModel(tuple.provider, tuple.modelId);
		if (model?.success === false) throw new Error(`rollback set_model failed: ${model.error ?? "rejected"}`);
		const thinking = await rpcClient.setThinkingLevel(tuple.thinkingLevel);
		if (thinking?.success === false) throw new Error(`rollback set_thinking_level failed: ${thinking.error ?? "rejected"}`);
		const state = this._stateData(await rpcClient.getState(), "get_state after context rollback");
		if (!this._sameAgentSessionPath(ps, state.sessionFile, expectedPath)
			|| state.model?.provider !== tuple.provider
			|| state.model?.id !== tuple.modelId
			|| isKnownThinkingLevel(state.thinkingLevel) !== tuple.thinkingLevel) {
			throw new Error("Rolled-back context configuration could not be verified");
		}
	}

	private _hostTrackedTranscriptPath(_ps: PersistedSession, filePath: string): string | undefined {
		try {
			const container = canonicalContainerAgentSessionPath(filePath);
			if (container) {
				const host = containerPathToHost(container);
				return host === container ? undefined : path.normalize(host);
			}
			trustPersistedAgentSessionFile(filePath);
			const readable = resolveReadablePersistedAgentSessionFile(filePath);
			return readable
				? path.normalize(readable)
				: isWithinAgentSessionsDir(filePath)
					? path.normalize(path.resolve(filePath))
					: undefined;
		} catch {
			return undefined;
		}
	}

	private _restoreSessionCoalesced(ps: PersistedSession): Promise<SessionInfo | undefined> {
		return this._coordinateSessionReplacement(ps.id, "restore", async () => {
			await this.restoreSession(ps);
			return this.sessions.get(ps.id);
		}, { coalesceKey: "rehydrate", drainOnRelease: true, cancelOnTerminal: () => undefined });
	}

	/**
	 * Replace only Pi's model-facing transcript generation. The existing
	 * replacement coordinator is the sole admission fence and queue release owner.
	 */
	clearContext(id: string): Promise<void> {
		this.assertSessionGoalPromotionMutationAllowed(id);
		this._assertModelSelectionReady(id);
		if (this._sessionReplacementCoordinators.has(id)) {
			throw new ContextClearError("CLEAR_ACTIVE", "A session replacement is already active");
		}
		const session = this.sessions.get(id);
		if (!session || session.dormant || session.lifecycleFenced || session.status === "terminated") {
			throw new ContextClearError("SESSION_UNAVAILABLE", `Session ${id} is not available`);
		}
		if (session.readOnly || session.nonInteractive) {
			throw new ContextClearError("SESSION_READ_ONLY", `Session ${id} does not allow context replacement`);
		}
		if (typeof session.rpcClient.newSession !== "function") {
			throw new ContextClearError(
				"CLEAR_UNSUPPORTED",
				"The active agent runtime does not support context clearing. Restart or update the agent runtime and try again.",
			);
		}
		if (session.isCompacting || session.status === "aborting" || session.status === "preparing" || session.status === "starting") {
			throw new ContextClearError("CLEAR_ACTIVE", "The session is busy with another lifecycle operation");
		}
		return this._coordinateSessionReplacement(id, "clear-context", (token) =>
			this._clearContextOwned(id, token), {
				drainOnRelease: true,
				cancelOnTerminal: () => {
					throw new ContextClearError("CLEAR_CANCELLED", "Context clear was cancelled by session termination");
			},
		});
	}

	private async _clearContextOwned(id: string, token: SessionReplacementToken): Promise<void> {
		const session = this.sessions.get(id);
		if (!session || !this._replacementTokenIsCurrent(id, token)) {
			throw new ContextClearError("CLEAR_CANCELLED", "The session changed before context clear started");
		}
		const store = this.resolveStoreForSession(id);
		const persistedRecord = store.get(id);
		const persistenceShape = this._captureContextClearPersistenceShape(store, id);
		if (!persistedRecord?.agentSessionFile || !persistenceShape) {
			throw new Error("The active transcript metadata is unavailable");
		}
		// SessionStore.update mutates its canonical object in place. Rollback and
		// path validation must retain an immutable view of the old generation.
		const persisted = structuredClone(persistedRecord);
		const oldPath = persisted.agentSessionFile;
		const oldStatus = session.status;
		const oldStreamingStartedAt = session.streamingStartedAt;
		const oldSetupComplete = session.setupComplete;
		const priorBoundaries = normalizeContextClearBoundaries(persisted.contextClearBoundaries);
		let terminalListener: (() => void) | undefined;
		const deferredTerminalEvents: any[] = [];
		let replacementAttempted = false;
		let replacementConfirmedComplete = false;
		let replacementCancelled = false;
		let terminalReplayed = false;
		let durableCommitted = false;
		let capturedTuple: ClearCapturedTuple | undefined;

		const replayTerminalEvidence = (reconcileReplacement = true) => {
			if (terminalReplayed) return;
			terminalReplayed = true;
			const setupComplete = session.setupComplete;
			// A clear publishes the pointer itself. Prevent deferred first-turn setup
			// from racing a stale metadata write across that transaction.
			session.setupComplete = true;
			for (const event of deferredTerminalEvents) {
				this.handleAgentLifecycle(session, event, {
					replacementOwnedTerminal: true,
					deferQueueDrain: true,
				});
				this.trackCostFromEvent(session, event, true);
			}
			if (reconcileReplacement) {
				this._reconcileAfterAbort(session, {
					outcome: "proven-no-start",
					retargetQueuedContinuation: true,
				});
			}
			session.setupComplete = setupComplete;
		};

		const restoreOldWriter = () => {
			session.lifecycleFenced = false;
			session.dormant = false;
			session.lifecycleGeneration = token.generation;
			const naturallySettled = deferredTerminalEvents.some((event) =>
				event.type === "agent_settled" || (event.type === "agent_end" && event.willRetry !== true));
			session.streamingStartedAt = naturallySettled ? undefined : oldStreamingStartedAt;
			session.setupComplete = oldSetupComplete;
			const desiredStatus: SessionStatus = naturallySettled ? "idle" : oldStatus;
			if (session.status !== desiredStatus) broadcastStatus(session, desiredStatus, {
				streamingStartedAt: naturallySettled ? undefined : oldStreamingStartedAt,
			});
		};

		// The coordinator has already advanced the writer generation. Capture
		// terminal evidence before the first fallible RPC so a naturally finishing
		// active turn cannot disappear in the preflight window.
		session.lifecycleFenced = true;
		session.messagesSnapshotCache = undefined;
		session.messagesSnapshotCursorProjection = undefined;
		session.promptCursorRefreshGeneration = (session.promptCursorRefreshGeneration ?? 0) + 1;
		terminalListener = session.rpcClient.onEvent((event: any) => {
			if (event.type === "message_end"
				|| event.type === "compaction_end"
				|| event.type === "auto_compaction_end"
				|| event.type === "agent_settled"
				|| (event.type === "agent_end" && event.willRetry !== true)) {
				deferredTerminalEvents.push(event);
			}
		});

		try {
			if (session.pendingMetadataPersist) await session.pendingMetadataPersist;
			const [oldStateResponse, oldMessagesResponse, oldEntriesResponse] = await Promise.all([
				session.rpcClient.getState(),
				session.rpcClient.getMessages(),
				session.rpcClient.getTranscriptEntries?.()
					?? session.rpcClient.sendCommand({ type: "get_entries" }),
			]);
			const oldState = this._stateData(oldStateResponse, "get_state before context clear");
			if (typeof oldState.sessionFile !== "string"
				|| !this._sameAgentSessionPath(persisted, oldState.sessionFile, oldPath)) {
				throw new Error("The live transcript path does not match durable session metadata");
			}
			const tuple = this._captureClearTuple(oldState);
			capturedTuple = tuple;
			const oldMessages = this._messageRowsFromRpc(oldMessagesResponse, "get_messages before context clear");
			const baselineBranch = this._activeTranscriptEntriesFromRpc(oldEntriesResponse, "get_entries before context clear");
			const baselineMessageIds = new Set(baselineBranch
				.filter((entry) => entry.type === "message" && typeof entry.id === "string")
				.map((entry) => entry.id as string));
			const previousHasMessages = oldMessages.length > 0 || baselineMessageIds.size > 0;

			if (this._markModernInFlightAttemptsUncertain(session)) this.broadcastQueue(session);
			if (oldStatus === "streaming") broadcastStatus(session, "aborting");

			const newSession = session.rpcClient.newSession?.bind(session.rpcClient);
			if (!newSession) {
				throw new ContextClearError(
					"CLEAR_UNSUPPORTED",
					"The active agent runtime does not support context clearing. Restart or update the agent runtime and try again.",
				);
			}
			// Preflight capture crosses several RPC/persistence awaits. Manual compaction
			// may only win before this clear's first context-mutating RPC; recheck at the
			// exact new_session boundary so the operations can never overlap even when a
			// non-WS caller bypasses transport serialization.
			if (session.isCompacting) {
				throw new ContextClearError("CLEAR_ACTIVE", "The session began compacting before context replacement");
			}
			if (!this._replacementTokenIsCurrent(id, token)) {
				throw new ContextClearError("CLEAR_CANCELLED", "The session changed before context replacement");
			}
			replacementAttempted = true;
			const replacement = await newSession(120_000);
			if (replacement?.type !== "response"
				|| replacement.command !== "new_session"
				|| replacement.success !== true
				|| typeof replacement.data?.cancelled !== "boolean") {
				throw new Error(`new_session failed: ${replacement?.error ?? "invalid response"}`);
			}
			// Only the exact conclusive response proves that Pi's concurrent new_session
			// handler has settled. RpcBridge correlates by id, so a malformed or
			// wrong-command response is as ambiguous as a timeout: the handler may still
			// replace the runtime later.
			replacementConfirmedComplete = true;
			if (replacement.data.cancelled === true) {
				replacementCancelled = true;
				throw new ContextClearError("CLEAR_CANCELLED", "Pi cancelled context replacement");
			}
			if (token.coordinator.terminalRequest) {
				throw new ContextClearError("CLEAR_CANCELLED", `Context clear was superseded by ${token.coordinator.terminalRequest}`);
			}

			const [newStateResponse, newMessagesResponse, newEntriesResponse] = await Promise.all([
				session.rpcClient.getState(),
				session.rpcClient.getMessages(),
				session.rpcClient.getTranscriptEntries?.()
					?? session.rpcClient.sendCommand({ type: "get_entries" }),
			]);
			const newState = this._stateData(newStateResponse, "get_state after context clear");
			const newPath = newState.sessionFile;
			if (typeof newPath !== "string" || !newPath
				|| this._sameAgentSessionPath(persisted, newPath, oldPath)) {
				throw new Error("Pi did not activate a distinct fresh transcript path");
			}
			this._validatedAgentSessionPathIdentity(persisted, newPath);
			if (newState.messageCount !== 0 || newState.pendingMessageCount !== 0) {
				throw new Error("Pi's fresh context state was not empty");
			}
			if (this._messageRowsFromRpc(newMessagesResponse, "get_messages after context clear").length !== 0) {
				throw new Error("Pi's fresh context contained prior messages");
			}
			const newBranch = this._activeTranscriptEntriesFromRpc(newEntriesResponse, "get_entries after context clear");
			if (newBranch.some((entry) => entry.type === "message"
				|| entry.type === "compaction"
				|| entry.type === "branch_summary"
				|| entry.type === "custom_message")) {
				throw new Error("Pi's fresh transcript tree contained non-empty model-facing entries");
			}
			await this._applyAndVerifyClearTuple(session.rpcClient, tuple, newPath, persisted);

			let previousTranscriptMaterialized = false;
			if (previousHasMessages) {
				const oldContent = await sessionFileRead(
					sessionFsContextForAgentFile(persisted, oldPath),
					oldPath,
					this.sandboxManager,
				);
				if (oldContent === null) throw new Error("The previous transcript could not be captured");
				const captured = parseTranscript(oldContent);
				const capturedBranch = activeTranscriptBranch(captured);
				const capturedBranchIds = new Set(capturedBranch
					.map((record) => record.id)
					.filter((entryId): entryId is string => typeof entryId === "string"));
				if (oldMessages.length > 0
					&& !capturedBranch.some((record) => record.entry.type === "message")) {
					throw new Error("The previous transcript did not contain the active message segment");
				}
				for (const entryId of baselineMessageIds) {
					if (!capturedBranchIds.has(entryId)) {
						throw new Error("The previous transcript changed before it could be captured");
					}
				}
				previousTranscriptMaterialized = true;
			} else {
				// A lazy JSONL containing only metadata is still an empty model-facing
				// segment. The history endpoint returns the stable empty envelope.
				previousTranscriptMaterialized = false;
			}

			terminalListener();
			terminalListener = undefined;
			replayTerminalEvidence();
			const compactionIds = currentGenerationCompactionIds(
				readCompactionSidecarEntriesStrict(id).map((entry) => entry.id),
				priorBoundaries,
			);
			const clearedAt = new Date(this.clock.now()).toISOString();
			const boundary = createContextClearBoundary({
				clearedAt,
				previousAgentSessionFile: oldPath,
				activatedAgentSessionFile: newPath,
				activatedTranscriptMaterialized: false,
				previousTranscriptMaterialized,
				compactionIds,
			});
			const contextClearBoundaries = [...priorBoundaries, boundary];
			if (token.coordinator.terminalRequest) {
				throw new ContextClearError("CLEAR_CANCELLED", `Context clear was superseded by ${token.coordinator.terminalRequest}`);
			}
			store.update(id, {
				agentSessionFile: newPath,
				contextClearBoundaries,
				wasStreaming: false,
				streamingStartedAt: undefined,
				messageQueue: session.promptQueue.toArray(),
				inFlightSteerTexts: this.persistedInFlightSteerTexts(session),
			});
			try {
				await store.flushAsync();
			} catch (error) {
				this._restoreContextClearPersistenceShape(store, id, persistenceShape);
				await store.flushAsync().catch(() => {});
				throw error;
			}
			durableCommitted = true;

			this.cancelPendingAutoRetry(session, "terminated");
			session.latestMessageUpdate = undefined;
			session.previousAssistantStreamMessage = undefined;
			session.activeAssistantStreamId = undefined;
			session.pendingRecoverableLengthStreamId = undefined;
			session.latestTurnUserText = undefined;
			session.latestTurnAssistantText = undefined;
			session.lastPromptText = undefined;
			session.lastPromptImages = undefined;
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.manualRetryRequired = false;
			session.transientRetryAttempts = 0;
			session.consecutiveErrorTurns = 0;
			session.streamingStartedAt = undefined;
			session._piAgentRunSettled = true;
			session.isCompacting = false;
			session._reliableCompactionId = undefined;
			session._reliableCompactionReason = undefined;
			this.clearToolCallProvenance(session);
			if (session.pendingGrantRequest) {
				const pending = session.pendingGrantRequest;
				const requests = pending.requests?.length
					? pending.requests
					: [{ resolve: pending.resolve, reject: pending.reject, timer: pending.timer, seq: pending.seq, ts: pending.ts }];
				for (const request of requests) {
					this.clock.clearTimeout(request.timer);
					request.resolve({ granted: false, reason: "Context was cleared." });
				}
				session.pendingGrantRequest = undefined;
			}
			session.messagesSnapshotCache = undefined;
			session.messagesSnapshotCursorProjection = undefined;
			session.promptCursorRefreshGeneration = (session.promptCursorRefreshGeneration ?? 0) + 1;
			session.lifecycleGeneration = token.generation;
			session.lifecycleFenced = false;
			session.dormant = false;
			const visible = this.buildVisibleMessageSnapshot(id, [] as any[]);
			try {
				emitSessionEvent(session, {
					type: "context_cleared",
					clearId: boundary.id,
					clearedAt: boundary.clearedAt,
					messages: visible,
				});
				broadcast(session.clients, {
					type: "state",
					data: this.withSessionCostInState(id, await session.rpcClient.getState().then((response) => response.data)),
				});
			} catch (error) {
				// Persistence is already canonical. Reconnect/reload reconstructs the
				// same boundary, so transport failure must never roll context back.
				console.warn(`[session-manager] Context clear committed but client publication failed for ${id}:`, error);
			} finally {
				broadcastStatus(session, "idle");
			}
		} catch (error) {
			terminalListener?.();
			terminalListener = undefined;
			if (durableCommitted) return;
			if (replacementCancelled || !replacementAttempted) {
				try { replayTerminalEvidence(false); }
				catch (replayError) { console.warn(`[session-manager] Pre-clear terminal replay failed for ${id}:`, replayError); }
				restoreOldWriter();
				throw error;
			}
			try {
				if (!capturedTuple) throw new Error("The original model tuple was not captured");
				await this._rollbackContextClear(
					id,
					session,
					persisted,
					capturedTuple,
					token,
					replayTerminalEvidence,
					replacementConfirmedComplete,
				);
			} catch (rollbackError) {
				console.error(`[session-manager] Context clear rollback failed for ${id}:`, rollbackError);
				throw new ContextClearError(
					"CLEAR_RECOVERY_REQUIRED",
					"Context clear failed and the prior runtime could not be verified. Refresh the agent or restart the gateway.",
				);
			}
			throw error;
		}
	}

	private async _rollbackContextClear(
		id: string,
		session: SessionInfo,
		persisted: PersistedSession,
		tuple: ClearCapturedTuple,
		token: SessionReplacementToken,
		replayTerminalEvidence: () => void,
		replacementConfirmedComplete: boolean,
	): Promise<void> {
		const oldPath = persisted.agentSessionFile;
		if (replacementConfirmedComplete) {
			try {
				const switched = await session.rpcClient.sendCommand({
					type: "switch_session",
					sessionPath: switchSessionPathForAgent(persisted),
				}, persisted.sandboxed ? 60_000 : 15_000);
				if (!switched?.success || switched.data?.cancelled === true) {
					throw new Error(`switch_session rollback failed: ${switched?.error ?? "cancelled"}`);
				}
				await this._applyAndVerifyRollbackTuple(session.rpcClient, tuple, oldPath, persisted);
				try { replayTerminalEvidence(); }
				catch (error) { console.warn(`[session-manager] Terminal replay persistence failed during rollback for ${id}:`, error); }
				session.lifecycleGeneration = token.generation;
				session.lifecycleFenced = false;
				session.dormant = false;
				session.messagesSnapshotCache = undefined;
				session.messagesSnapshotCursorProjection = undefined;
				session.promptCursorRefreshGeneration = (session.promptCursorRefreshGeneration ?? 0) + 1;
				try {
					this.resolveStoreForSession(id).update(id, { wasStreaming: false, streamingStartedAt: undefined });
				} catch { /* runtime rollback remains usable even if auxiliary persistence is unavailable */ }
				broadcastStatus(session, "idle");
				return;
			} catch (switchError) {
				console.warn(`[session-manager] In-process context rollback failed for ${id}; respawning old generation:`, switchError);
			}
		} else {
			console.warn(`[session-manager] Context replacement outcome is ambiguous for ${id}; stopping the stale bridge before rollback`);
		}
		try { replayTerminalEvidence(); }
		catch (error) { console.warn(`[session-manager] Terminal replay persistence failed before respawn rollback for ${id}:`, error); }
		const restored = await this._respawnAgentInPlaceOwned(id, session, persisted, {
			preserveSandboxRealm: persisted.sandboxed === true,
			deferQueueDrain: true,
			useRequestedPersistedSnapshot: true,
		}, token);
		if (!restored) throw new Error("Old context respawn did not install a runtime");
		await this._applyAndVerifyRollbackTuple(restored.rpcClient, tuple, oldPath, persisted);
		restored.lifecycleGeneration = token.generation;
		restored.lifecycleFenced = false;
		restored.dormant = false;
		try {
			this.resolveStoreForSession(id).update(id, { wasStreaming: false, streamingStartedAt: undefined });
		} catch { /* retain the verified rollback runtime */ }
		broadcastStatus(restored, "idle");
	}

	setOnPrCreationDetected(cb: (session: SessionInfo) => void): void {
		this._onPrCreationDetected = cb;
	}

	setOnSessionQuestionStateChanged(cb: (sessionId: string, hasUnansweredQuestion: boolean) => void): void {
		this._onSessionQuestionStateChanged = cb;
	}

	setVerificationHarness(harness: import("./verification-harness.js").VerificationHarness): void {
		this._verificationHarness = harness;
	}

	/** Subscribe to session termination events. Listeners settle in registration order. */
	addTerminationListener(fn: SessionTerminationListener): void {
		this._terminationListeners.push(fn);
	}

	/** Subscribe to newly created visible sessions. Listeners are invoked after initial persistence. */
	addCreationListener(fn: (session: SessionInfo) => void): void {
		this._creationListeners.push(fn);
	}

	/** Late-bind the interceptor router while preserving LifecycleHub as fallback. */
	setHostInterceptorPort(port: SessionHostInterceptorPort | undefined): void {
		this.hostInterceptors = port;
	}

	/** Server route seam for prompt/compact/tool boundaries owned inside Pi. */
	dispatchHostInterceptor<N extends HostInterceptorName>(
		sessionId: string,
		name: N,
		input: HostInterceptorRequest<N>,
	): Promise<any> | undefined {
		const session = this.sessions.get(sessionId);
		if (!session || !this.hostInterceptors) return undefined;
		const controller = new AbortController();
		return this.hostInterceptors.dispatch(name, input as Record<string, unknown>, {
			projectId: session.projectId,
			sessionId,
			goalId: session.goalId ?? session.teamGoalId,
			cwd: session.cwd,
			signal: controller.signal,
		});
	}

	/** Late-bind the canonical Extension Host dispatcher without giving sessions fanout ownership. */
	setHostNotificationPublisher(publisher: HostSessionNotificationPublisher | undefined): void {
		this.hostNotificationPublisher = publisher;
		for (const session of this.sessions.values()) this.attachHostLifecycleObservers(session);
	}

	private publishSessionNotification<N extends HostSessionNotificationName>(
		session: SessionInfo,
		name: N,
		aggregateId: string,
		aggregateRevision: string | number | undefined,
		payload: Readonly<HostNotificationPayload<N>>,
	): void {
		if (!this.hostNotificationPublisher || !session.projectId) return;
		try {
			const publish = () => this.hostNotificationPublisher!.publish(name, {
				projectId: session.projectId!,
				sessionId: session.id,
				aggregateId,
				aggregateRevision,
				payload,
			});
			const causalTurn = this.getStaffNotificationTurnContext(session.id);
			if (causalTurn) runWithStaffNotificationTurnContext(causalTurn, publish);
			else publish();
		} catch {
			console.warn(`[session-manager] host notification publication failed code=publisher_error name=${name} session=${session.id}`);
		}
	}

	private attachHostLifecycleObservers(session: SessionInfo): void {
		session.onStatusChanged = (change) => {
			if (change.status === "terminated") {
				session.staffNotificationTurnContext = undefined;
				this.clearToolCallProvenance(session);
			}
			this.publishSessionNotification(session, "statusChanged", session.id, change.statusVersion, {
				previousStatus: change.previousStatus,
				status: change.status,
				statusVersion: change.statusVersion,
			});
			this.publishSessionNotification(session, "sessionStatusChanged", session.id, change.statusVersion, {
				sessionId: session.id,
				previousStatus: change.previousStatus,
				status: change.status,
				statusVersion: change.statusVersion,
			});
		};
		session.onEventAccepted = (event, cursor) => this.publishAcceptedSessionEvent(session, event, cursor);
	}

	private isBoundedToolIdentity(value: unknown): value is string {
		return typeof value === "string" && value.length > 0 && value.length <= MAX_HOST_TOOL_IDENTITY_LENGTH;
	}

	private deleteToolCallEntry(session: SessionInfo, entry: ToolCallLifecycleEntry, reason: string): void {
		if (session.hostToolCallLifecycle?.get(entry.toolCallId) === entry) {
			session.hostToolCallLifecycle.delete(entry.toolCallId);
		}
		entry.controller.abort(reason);
	}

	private createToolCallClaim(
		session: SessionInfo,
		entry: ToolCallLifecycleEntry,
		kind: "before" | "after",
	): ToolCallInterceptorClaim | undefined {
		const expectedPhase = kind === "before" ? "observed" : "admitted";
		if (!this._sessionWriterIsCurrent(session)
			|| entry.generation !== (session.lifecycleGeneration ?? 0)
			|| session.hostToolCallLifecycle?.get(entry.toolCallId) !== entry
			|| entry.phase !== expectedPhase
			|| (kind === "before" && entry.startCursor === undefined)) return undefined;
		entry.phase = kind === "before" ? "before-running" : "after-running";
		entry.lease += 1;
		const claim = Object.freeze({}) as ToolCallInterceptorClaim;
		this._toolCallInterceptorClaims.set(claim, {
			kind,
			session,
			entry,
			generation: entry.generation,
			lease: entry.lease,
			settled: false,
		});
		return claim;
	}

	private toolCallClaimIsCurrent(owned: OwnedToolCallInterceptorClaim): boolean {
		return !owned.settled
			&& this._sessionWriterIsCurrent(owned.session)
			&& owned.generation === (owned.session.lifecycleGeneration ?? 0)
			&& owned.session.hostToolCallLifecycle?.get(owned.entry.toolCallId) === owned.entry
			&& owned.entry.lease === owned.lease
			&& owned.entry.phase === (owned.kind === "before" ? "before-running" : "after-running")
			&& !owned.entry.controller.signal.aborted;
	}

	private resolveToolCallBeforeWaiter(session: SessionInfo, toolCallId: string, claim: ToolCallInterceptorClaim | undefined): void {
		const waiter = session.hostToolCallBeforeWaiters?.get(toolCallId);
		if (!waiter) return;
		session.hostToolCallBeforeWaiters!.delete(toolCallId);
		this.clock.clearTimeout(waiter.timer);
		waiter.resolve(claim);
	}

	private observeToolCallStart(session: SessionInfo, event: any): void {
		if (!this._sessionWriterIsCurrent(session)) return;
		const toolCallId = event?.toolCallId;
		const toolName = event?.toolName;
		if (!this.isBoundedToolIdentity(toolCallId) || !this.isBoundedToolIdentity(toolName)) return;
		const generation = session.lifecycleGeneration ?? 0;
		const tracker = session.hostToolCallLifecycle ??= new Map<string, ToolCallLifecycleEntry>();
		const existing = tracker.get(toolCallId);
		if (existing) {
			if (existing.generation === generation && existing.toolName === toolName) return;
			this.deleteToolCallEntry(session, existing, "tool-start-conflict");
			this.resolveToolCallBeforeWaiter(session, toolCallId, undefined);
			return;
		}
		if (tracker.size >= MAX_TRACKED_HOST_TOOL_CALLS) {
			const evictable = Array.from(tracker.values()).find(entry => entry.phase === "observed");
			if (!evictable) {
				this.resolveToolCallBeforeWaiter(session, toolCallId, undefined);
				return;
			}
			this.deleteToolCallEntry(session, evictable, "tool-provenance-capacity");
			this.resolveToolCallBeforeWaiter(session, evictable.toolCallId, undefined);
		}
		tracker.set(toolCallId, {
			toolCallId,
			toolName,
			generation,
			turnIndex: (session.completedTurnCount ?? 0) + 1,
			startedAt: this.clock.now(),
			phase: "observed",
			lease: 0,
			controller: new AbortController(),
		});
	}

	private acceptToolCallStartCursor(session: SessionInfo, event: any, cursor: number): void {
		if (!this._sessionWriterIsCurrent(session)) return;
		const toolCallId = event?.toolCallId;
		const toolName = event?.toolName;
		if (!this.isBoundedToolIdentity(toolCallId) || !this.isBoundedToolIdentity(toolName)) return;
		const entry = session.hostToolCallLifecycle?.get(toolCallId);
		if (!entry || entry.phase !== "observed" || entry.toolName !== toolName
			|| entry.generation !== (session.lifecycleGeneration ?? 0)) return;
		entry.startCursor = cursor;
		const waiter = session.hostToolCallBeforeWaiters?.get(toolCallId);
		if (!waiter) return;
		if (waiter.toolName !== toolName || waiter.generation !== entry.generation) {
			this.resolveToolCallBeforeWaiter(session, toolCallId, undefined);
			return;
		}
		this.resolveToolCallBeforeWaiter(session, toolCallId, this.createToolCallClaim(session, entry, "before"));
	}

	/** Claim one exact accepted Pi start. Waiting covers only stdout/HTTP transport reordering. */
	claimToolCallBefore(sessionId: string, toolCallId: string, toolName: string): Promise<ToolCallInterceptorClaim | undefined> {
		const session = this.sessions.get(sessionId);
		if (!session || !this._sessionWriterIsCurrent(session)
			|| !this.isBoundedToolIdentity(toolCallId) || !this.isBoundedToolIdentity(toolName)) {
			return Promise.resolve(undefined);
		}
		const entry = session.hostToolCallLifecycle?.get(toolCallId);
		if (entry) {
			if (entry.toolName !== toolName || entry.generation !== (session.lifecycleGeneration ?? 0) || entry.phase !== "observed") {
				return Promise.resolve(undefined);
			}
			if (entry.startCursor !== undefined) return Promise.resolve(this.createToolCallClaim(session, entry, "before"));
		}
		const waiters = session.hostToolCallBeforeWaiters ??= new Map<string, ToolCallBeforeWaiter>();
		if (waiters.has(toolCallId) || waiters.size >= MAX_TRACKED_HOST_TOOL_CALLS) return Promise.resolve(undefined);
		return new Promise(resolve => {
			const generation = session.lifecycleGeneration ?? 0;
			const waiter: ToolCallBeforeWaiter = {
				toolCallId,
				toolName,
				generation,
				resolve,
				timer: this.clock.setTimeout(() => {
					if (session.hostToolCallBeforeWaiters?.get(toolCallId) !== waiter) return;
					session.hostToolCallBeforeWaiters.delete(toolCallId);
					resolve(undefined);
				}, TOOL_CALL_START_ARRIVAL_GRACE_MS),
			};
			waiters.set(toolCallId, waiter);
		});
	}

	/** Claim the single post-handler callback for an admitted current-generation call. */
	claimToolCallAfter(sessionId: string, toolCallId: string, toolName: string): ToolCallInterceptorClaim | undefined {
		const session = this.sessions.get(sessionId);
		if (!session || !this._sessionWriterIsCurrent(session)
			|| !this.isBoundedToolIdentity(toolCallId) || !this.isBoundedToolIdentity(toolName)) return undefined;
		const entry = session.hostToolCallLifecycle?.get(toolCallId);
		if (!entry || entry.toolName !== toolName || entry.generation !== (session.lifecycleGeneration ?? 0)) return undefined;
		return this.createToolCallClaim(session, entry, "after");
	}

	/** Dispatch through a claim-derived context; routes never receive lifecycle state or generation. */
	dispatchClaimedToolInterceptor(
		claim: ToolCallInterceptorClaim,
		input: { args?: Record<string, unknown>; result?: unknown },
	): Promise<any> | undefined {
		const owned = this._toolCallInterceptorClaims.get(claim);
		if (!owned || !this.toolCallClaimIsCurrent(owned) || !this.hostInterceptors) return undefined;
		const request = owned.kind === "before"
			? { toolCallId: owned.entry.toolCallId, toolName: owned.entry.toolName, args: input.args ?? {} }
			: { toolCallId: owned.entry.toolCallId, toolName: owned.entry.toolName, result: input.result };
		return this.hostInterceptors.dispatch(owned.kind === "before" ? "beforeToolCall" : "afterToolResult", request, {
			projectId: owned.session.projectId,
			sessionId: owned.session.id,
			goalId: owned.session.goalId ?? owned.session.teamGoalId,
			cwd: owned.session.cwd,
			signal: owned.entry.controller.signal,
		});
	}

	/** Apply one before decision. A block consumes provenance without publishing a start fact. */
	settleToolCallBefore(claim: ToolCallInterceptorClaim, admitted: boolean): boolean {
		const owned = this._toolCallInterceptorClaims.get(claim);
		if (!owned || owned.kind !== "before" || !this.toolCallClaimIsCurrent(owned)) return false;
		owned.settled = true;
		if (!admitted) {
			this.deleteToolCallEntry(owned.session, owned.entry, "tool-call-blocked");
			return true;
		}
		owned.entry.phase = "admitted";
		this.publishSessionNotification(owned.session, "toolCallStarted", owned.entry.toolCallId, owned.entry.startCursor, {
			toolCallId: owned.entry.toolCallId,
			toolName: owned.entry.toolName,
			turnIndex: owned.entry.turnIndex,
		});
		return true;
	}

	/** Apply one approved/synthetic post-policy result before Pi can persist it. */
	settleToolCallAfter(claim: ToolCallInterceptorClaim): boolean {
		const owned = this._toolCallInterceptorClaims.get(claim);
		if (!owned || owned.kind !== "after" || !this.toolCallClaimIsCurrent(owned)) return false;
		owned.settled = true;
		owned.entry.phase = "after-applied";
		return true;
	}

	cancelToolCallInterceptorClaim(claim: ToolCallInterceptorClaim): void {
		const owned = this._toolCallInterceptorClaims.get(claim);
		if (!owned || owned.settled) return;
		owned.settled = true;
		this.deleteToolCallEntry(owned.session, owned.entry, "tool-callback-cancelled");
	}

	private recordToolCallTerminal(session: SessionInfo, event: any): void {
		if (!this._sessionWriterIsCurrent(session)) return;
		const toolCallId = event?.toolCallId;
		const toolName = event?.toolName;
		if (!this.isBoundedToolIdentity(toolCallId) || !this.isBoundedToolIdentity(toolName)) return;
		const tracked = session.hostToolCallLifecycle?.get(toolCallId);
		if (!tracked) return;
		if (tracked.toolName !== toolName || tracked.generation !== (session.lifecycleGeneration ?? 0)) {
			this.deleteToolCallEntry(session, tracked, "tool-end-mismatch");
			return;
		}
		if (tracked.phase === "ended") return;
		if (tracked.phase !== "admitted" && tracked.phase !== "after-applied") {
			this.deleteToolCallEntry(session, tracked, "tool-end-before-policy-settlement");
			return;
		}
		tracked.phase = "ended";
		tracked.status = event.isError === true ? "errored" : "succeeded";
		tracked.errorStatus = event.isError === true ? "handler_error" : undefined;
		tracked.controller.abort("tool-execution-ended");
	}

	private publishAcceptedSessionEvent(session: SessionInfo, accepted: unknown, cursor: number): void {
		if (!this._sessionWriterIsCurrent(session) || !accepted || typeof accepted !== "object") return;
		const event = accepted as { type?: unknown; toolCallId?: unknown; toolName?: unknown; message?: any };
		if (event.type === "tool_execution_start") {
			this.acceptToolCallStartCursor(session, event, cursor);
			return;
		}
		if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return;
		const message = event.message;
		const rawRole = typeof message.role === "string" ? message.role : "";
		const role: "user" | "assistant" | "system" = rawRole === "user"
			? "user"
			: rawRole === "assistant" ? "assistant" : "system";
		const content = Array.isArray(message.content) ? message.content : [];
		const blockKinds = Array.from(new Set<"text" | "tool_use" | "tool_result">(
			content.flatMap((block: unknown): Array<"text" | "tool_use" | "tool_result"> => {
				const kind = block && typeof block === "object" ? (block as { type?: unknown }).type : undefined;
				if (kind === "text") return ["text"];
				if (kind === "toolCall" || kind === "tool_use") return ["tool_use"];
				if (kind === "toolResult" || kind === "tool_result") return ["tool_result"];
				return [];
			}),
		)).slice(0, 8);
		const explicitMessageId = typeof message.id === "string" && message.id.length > 0 ? message.id : undefined;
		const messageId = explicitMessageId ?? `${session.id}:${cursor}`;
		this.publishSessionNotification(session, "messageAppended", messageId, cursor, {
			messageId,
			cursor,
			role,
			blockKinds,
		});

		if (rawRole !== "toolResult" && rawRole !== "tool_result" && rawRole !== "tool") return;
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		if (!toolCallId) return;
		const tracked = session.hostToolCallLifecycle?.get(toolCallId);
		if (!tracked || tracked.phase !== "ended" || tracked.generation !== (session.lifecycleGeneration ?? 0)) return;
		if (typeof message.toolName === "string" && message.toolName !== tracked.toolName) {
			this.deleteToolCallEntry(session, tracked, "tool-result-mismatch");
			return;
		}
		session.hostToolCallLifecycle!.delete(toolCallId);
		const failed = tracked.status === "errored" || message.isError === true;
		this.publishSessionNotification(session, "toolCallCompleted", toolCallId, cursor, {
			toolCallId,
			toolName: tracked.toolName,
			status: failed ? "errored" : "succeeded",
			durationMs: Math.max(0, Math.round(this.clock.now() - tracked.startedAt)),
			...(failed ? { errorStatus: tracked.errorStatus ?? "handler_error" } : {}),
		});
	}

	/**
	 * Publish the legacy/canonical creation seam only after the structural row is
	 * atomically durable. The store barrier is intentionally owned here so every
	 * creation listener shares the same authority boundary.
	 */
	private async notifySessionCreated(session: SessionInfo, store: SessionStore): Promise<void> {
		if (store instanceof SessionStore) {
			// Production stores must cross the atomic publication fence. Do not make
			// this optional: a failed initial write must suppress the committed fact.
			await store.flushAsync();
		} else {
			// Historical in-process harnesses inject small synchronous recording
			// stores through the SessionStore seam. Their put/update calls are the
			// committed boundary; richer doubles may still expose an async barrier.
			await (store as unknown as { flushAsync?: () => void | Promise<void> }).flushAsync?.();
		}
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
	private teamGoalAdmissionFence?: <T>(goalId: string, operation: () => Promise<T>) => Promise<T>;
	setOrchestrationCore(core: OrchestrationCore | null): void {
		this.orchestrationCore = core;
	}

	/** Late-bound bridge onto TeamManager's authoritative per-goal admission queue. */
	setTeamGoalAdmissionFence(fence: (<T>(goalId: string, operation: () => Promise<T>) => Promise<T>) | undefined): void {
		this.teamGoalAdmissionFence = fence;
	}

	/**
	 * Resolve durable team ownership from the same bounded live closure used by
	 * archive reconciliation. An exact `teamGoalId` stamp is authoritative;
	 * current TeamStore references and their descendants supplement it.
	 */
	getTrustedTeamGoalIdForSession(sessionId: string): string | undefined {
		const persisted = this.getPersistedSession(sessionId);
		if (!persisted) return undefined;
		if (persisted.teamGoalId) return persisted.teamGoalId;

		let live: PersistedSession[];
		let teamEntries: Array<{ goalId: string; teamLeadSessionId: string | null; agents: Array<{ sessionId: string }> }> = [];
		if (this.projectContextManager) {
			const context = (persisted.projectId
				? this.projectContextManager.getOrCreate(persisted.projectId)
				: this.projectContextManager.getContextForSession(sessionId));
			if (!context) return undefined;
			live = context.sessionStore.getLive();
			teamEntries = context.teamStore.getAll();
		} else {
			live = this._testStore?.getLive() ?? [];
		}
		// Admission can race just after reconciliation archived the requested
		// referenced owner. Include only that exact row so TeamStore-derived
		// ownership remains fenced without traversing archived history.
		if (!live.some((session) => session.id === sessionId)) live = [...live, persisted];

		const candidateGoalIds = new Set<string>();
		// Exact stamps returned above are the primary authority. The remaining scan
		// resolves their current live descendants plus TeamStore references and the
		// references' descendants, without consulting goalId or archived history.
		for (const session of live) {
			if (session.teamGoalId) candidateGoalIds.add(session.teamGoalId);
		}
		for (const entry of teamEntries) candidateGoalIds.add(entry.goalId);
		for (const goalId of candidateGoalIds) {
			const entry = teamEntries.find((candidate) => candidate.goalId === goalId);
			const references = new Set<string>();
			if (entry?.teamLeadSessionId) references.add(entry.teamLeadSessionId);
			for (const agent of entry?.agents ?? []) references.add(agent.sessionId);
			if (collectTeamOwnedSessionClosure(goalId, live, references).has(sessionId)) return goalId;
		}
		return undefined;
	}

	/** Run publication of a team-owned orchestration child under terminal admission. */
	runWithTeamGoalAdmission<T>(goalId: string, operation: () => Promise<T>): Promise<T> {
		return this.teamGoalAdmissionFence ? this.teamGoalAdmissionFence(goalId, operation) : operation();
	}

	setInboxNudger(nudger: import("./inbox-nudger.js").InboxNudger | null): void {
		this._inboxNudger = nudger;
	}

	/** Return causal controls only while every exact staff/session/lifecycle fence
	 * remains authoritative. Invalid bindings are erased on observation. */
	getStaffNotificationTurnContext(sessionId: string): StaffNotificationTurnContext | undefined {
		const session = this.sessions.get(sessionId);
		const context = session?.staffNotificationTurnContext;
		if (!session || !context) return undefined;
		const staff = this.staffRecordSource?.getStaff(context.staffId);
		if (session.lifecycleFenced === true
			|| !this._sessionWriterIsCurrent(session)
			|| session.id !== context.sessionId
			|| session.projectId !== context.projectId
			|| session.staffId !== context.staffId
			|| (session.lifecycleGeneration ?? 0) !== context.lifecycleGeneration
			|| !staff
			|| staff.state !== "active"
			|| staff.currentSessionId !== session.id
			|| staff.projectId !== context.projectId) {
			session.staffNotificationTurnContext = undefined;
			return undefined;
		}
		return context;
	}

	clearStaffNotificationTurnContext(sessionId: string, notificationId?: string): void {
		const session = this.sessions.get(sessionId);
		if (!session?.staffNotificationTurnContext) return;
		if (notificationId && session.staffNotificationTurnContext.notificationId !== notificationId) return;
		session.staffNotificationTurnContext = undefined;
	}

	/** Atomically reserve an otherwise-empty idle staff turn for one notification
	 * root, then dispatch the host-owned wake prompt. Batching roots is forbidden. */
	async enqueueStaffNotificationPrompt(
		sessionId: string,
		text: string,
		input: Omit<StaffNotificationTurnContext, "sessionId" | "lifecycleGeneration">,
	): Promise<{ status: "dispatched" | "queued" }> {
		const session = this.sessions.get(sessionId);
		const staff = this.staffRecordSource?.getStaff(input.staffId);
		const validString = (value: string) => value.length > 0 && value.length <= 256;
		if (!session
			|| session.status !== "idle"
			|| !session.promptQueue.isEmpty
			|| session.lifecycleFenced === true
			|| !this._sessionWriterIsCurrent(session)
			|| session.projectId !== input.projectId
			|| session.staffId !== input.staffId
			|| !staff
			|| staff.state !== "active"
			|| staff.currentSessionId !== sessionId
			|| staff.projectId !== input.projectId
			|| !validString(input.staffId)
			|| !validString(input.triggerId)
			|| !validString(input.notificationId)
			|| !validString(input.rootCorrelationId)
			|| !Number.isSafeInteger(input.causationDepth)
			|| input.causationDepth < 0
			|| input.causationDepth > MAX_STAFF_NOTIFICATION_TURN_DEPTH) {
			return { status: "queued" };
		}
		const context = freezeStaffNotificationTurnContext({
			...input,
			sessionId,
			lifecycleGeneration: session.lifecycleGeneration ?? 0,
		});
		session.staffNotificationTurnContext = context;
		try {
			const result = await this.enqueuePrompt(sessionId, text, { isSteered: true, source: "system" });
			if (result.status !== "dispatched") this.clearStaffNotificationTurnContext(sessionId, context.notificationId);
			return result;
		} catch (error) {
			this.clearStaffNotificationTurnContext(sessionId, context.notificationId);
			throw error;
		}
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
				const persisted = this.getSessionStore(session.projectId).get(session.id);
				if (persisted && this.isCanonicalAdoptedWorkspaceOwner(persisted)) {
					const expected = persisted.containerId?.trim();
					if (!expected || session.containerId !== expected || newContainerId !== expected) {
						this.assertPromotedSessionRecoveryAllowed(session.id, "transfer to a recovered sandbox container");
						throw new Error(`Cannot recover promoted session ${session.id}: sandbox container identity changed`);
					}
				}
				// Verify/repair/recreate worktree if needed. Headquarters never owns
				// sandbox worktrees, even for legacy sessions with /workspace-wt cwd.
				if (projectId !== HEADQUARTERS_PROJECT_ID && !session.borrowsWorktree && session.cwd?.startsWith("/workspace-wt/")) {
					let worktreeOk = false;

					// Check if worktree still exists (volumes may survive rm -f)
					try {
						await this.commandRunner.execFile("docker", [
							"exec", newContainerId, "test", "-d", session.cwd,
						], { timeout: 5_000 });
						worktreeOk = true;
					} catch {
						// A live adopted goal owns the promoted source's exact workspace.
						// Container recovery may inspect it, but cannot repair or replace it.
						this.assertPromotedSessionRecoveryAllowed(session.id, "repair or recreate its sandbox worktree");
						// Try git worktree repair first
						try {
							await this.commandRunner.execFile("docker", [
								"exec", "-w", "/workspace", newContainerId,
								"git", "worktree", "repair",
							], { timeout: 10_000 });
							// Re-check after repair
							await this.commandRunner.execFile("docker", [
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
						if (psForGate && await shouldKeepDespiteOrphan(psForGate)) {
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
		this.clock = options?.clock ?? realClock;
		this.commandRunner = options?.commandRunner ?? realCommandRunner;
		this.skipTitleGeneration = options?.skipTitleGeneration ?? false;
		this.remoteGitPolicy = options?.remoteGitPolicy ?? {};
		this.testPreparingDelayMs = options?.testPreparingDelayMs;
		this.worktreeSetupRuntime = options?.worktreeSetupRuntime ?? {};
		this.stateDir = options?.stateDir ?? bobbitStateDir();
		this._bootRestoreLagSampler = options?.bootRestoreLagSampler;
		this.archiveStat = options?.archiveStat ?? ((filePath) => fsp.stat(filePath));
		this.previewPurgeOperation = options?.previewPurgeOperation ?? (async (_sessionId, operation) => operation());
		this.promotedSessionLifecycleGuard = options?.promotedSessionLifecycleGuard;
		this.hostNotificationPublisher = options?.hostNotificationPublisher;
		sessionManagerModuleClock = this.clock;
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
		if (this.projectContextManager) {
			// All store resolution goes through PCM — no default fields needed.
		} else {
			// Non-PCM path: used by test harnesses that don't set up a full
			// ProjectContextManager. Stores are created from the explicit stateDir.
			const stateDir = bobbitStateDir();
			this._testStore = new SessionStore(stateDir, undefined, this.clock);
			this._testBgProcessStore = new BgProcessStore(stateDir, this.clock);
			this._testCostTracker = new CostTracker(stateDir);
			this._testSearchIndex = new SearchService({ stateDir, projectId: "__test__" });
			const goalStore = new GoalStore(stateDir, undefined, { persistence: "json" });
			let taskStore: TaskStore | undefined;
			try {
				taskStore = new TaskStore(stateDir, undefined, { persistence: "json" });
				this._testGoalStore = goalStore;
				this._testTaskStore = taskStore;
				this._testGoalManager = new GoalManager(goalStore, undefined, undefined, { commandRunner: this.commandRunner, clock: this.clock, remotePolicy: this.remoteGitPolicy, worktreeSetupRuntime: this.worktreeSetupRuntime });
				this._testTaskManager = new TaskManager(taskStore);
			} catch (error) {
				taskStore?.dispose();
				goalStore.dispose();
				throw error;
			}
			// Empty-but-real PR status store for in-process E2E harnesses that
			// construct SessionManager without a full ProjectContextManager but
			// may still hit re-attempt code paths.
			if (!this.prStatusStore) this.prStatusStore = new PrStatusStore(stateDir);
		}

		// Start the status heartbeat. Runs for the lifetime of this manager;
		// `unref()` so unit tests don't hang on process exit.
		this._statusHeartbeatTimer = this.clock.setInterval(
			() => this._emitStatusHeartbeat(),
			SessionManager.STATUS_HEARTBEAT_INTERVAL_MS,
		);
		(this._statusHeartbeatTimer as any).unref?.();
	}

	setPromotedSessionLifecycleGuard(guard: PromotedSessionLifecycleGuard | undefined): void {
		this.promotedSessionLifecycleGuard = guard;
	}

	private assertPromotedSessionLifecycleAllowed(
		sessionId: string,
		action: PromotedSessionLifecycleAction,
	): void {
		const reason = this.promotedSessionLifecycleGuard?.(sessionId, action);
		if (reason) throw new PromotedSessionLifecycleConflictError(sessionId, reason);
	}

	/**
	 * Recovery may inspect a promoted source, but it must not mutate its workspace
	 * or archive its durable record while the adopted goal remains live. The goal
	 * archive flow publishes goal archival first, so the canonical guard permits
	 * its later ordered source teardown without a separate bypass.
	 */
	private assertPromotedSessionRecoveryAllowed(sessionId: string, operation: string): void {
		try {
			this.assertPromotedSessionLifecycleAllowed(sessionId, "archive");
		} catch (error) {
			if (error instanceof PromotedSessionLifecycleConflictError) {
				console.warn(`[session-manager] Preserving promoted source ${sessionId}; recovery cannot ${operation} while its adopted goal is live`);
			}
			throw error;
		}
	}

	/** Keep an unrecoverable promoted source dormant instead of archiving it. */
	private preservePromotedSessionAfterRecoveryFailure(ps: PersistedSession, operation: string): boolean {
		try {
			this.assertPromotedSessionRecoveryAllowed(ps.id, operation);
			return false;
		} catch (error) {
			if (!(error instanceof PromotedSessionLifecycleConflictError)) throw error;
			if (!this.sessions.has(ps.id)) this.addPromotedRecoveryDormant(ps, error.message);
			return true;
		}
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

	/** Resolve goal tools extension path through the session project's cascade. */
	private getGoalToolsExtensionPath(projectId?: string): string {
		const toolManager = this.getToolManagerForProject(projectId);
		if (toolManager) return toolManager.getExtensionPath("tasks", "extension.ts");
		return path.join(bobbitConfigDir(), "tools", "tasks", "extension.ts");
	}

	/** Resolve team lead extension path through the session project's cascade. */
	private getTeamLeadExtensionPath(projectId?: string): string {
		const toolManager = this.getToolManagerForProject(projectId);
		if (toolManager) return toolManager.getExtensionPath("team", "extension.ts");
		return path.join(bobbitConfigDir(), "tools", "team", "extension.ts");
	}

	/** Resolve proposal tools extension path through the session project's cascade. */
	private getProposalToolsExtensionPath(projectId?: string): string {
		const toolManager = this.getToolManagerForProject(projectId);
		if (toolManager) return toolManager.getExtensionPath("proposals", "extension.ts");
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

	/**
	 * Resolve a store already owned by a live ProjectContext for shutdown.
	 * Shutdown must not lazily recreate a context after project removal just to
	 * persist a session that is being discarded with that project.
	 */
	private resolveExistingStoreForShutdown(session: Pick<SessionInfo, "id" | "projectId">): SessionStore | null {
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				if (session.projectId ? ctx.project.id === session.projectId : ctx.sessionStore.get(session.id)) {
					return ctx.sessionStore;
				}
			}
			return null;
		}
		return this._testStore;
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
		if (this.projectContextManager) {
			const manager = this.projectContextManager as ProjectContextManager & {
				getAllSessions?: () => PersistedSession[];
				getAllLiveSessions?: () => PersistedSession[];
			};
			return manager.getAllSessions?.() ?? manager.getAllLiveSessions?.() ?? [];
		}
		// Some focused tests inject a deliberately partial store to exercise archive
		// persistence failures. Real SessionStore instances always expose getAll;
		// only let those partial fixtures opt out of borrower discovery.
		const testStore = this._testStore as (Partial<Pick<SessionStore, "getAll">> | null);
		return typeof testStore?.getAll === "function" ? testStore.getAll() : [];
	}

	/**
	 * Resolve a sandbox worktree's durable, flattened lifecycle owner. Legacy
	 * borrowers are accepted only when exactly one live same-project owner has
	 * an authoritative worktree root containing their cwd.
	 */
	resolveSandboxWorktreeOwnerSessionId(sessionId: string): string | undefined {
		const all = this.getAllPersistedSessionsForWorktreeGuard();
		const byId = new Map(all.map(session => [session.id, session]));
		const source = byId.get(sessionId);
		if (!source || source.archived || !source.sandboxed) return undefined;
		if (!source.borrowsWorktree) return source.id;

		let ownerId = source.borrowedWorktreeOwnerSessionId;
		const visited = new Set([source.id]);
		while (ownerId) {
			if (visited.has(ownerId)) return undefined;
			visited.add(ownerId);
			const owner = byId.get(ownerId);
			if (!owner || owner.archived || !owner.sandboxed || owner.projectId !== source.projectId) {
				return undefined;
			}
			if (owner.borrowsWorktree) {
				ownerId = owner.borrowedWorktreeOwnerSessionId;
				continue;
			}
			const coordinates = sandboxWorktreeOwnerCoordinates(owner);
			const sharesOwnedRoot = coordinates
				? isWorktreePathReferencedByLiveSession(coordinates.root, [source])
				: normalizeWorktreeHostPath(owner.cwd) === normalizeWorktreeHostPath(source.cwd);
			return sharesOwnedRoot ? owner.id : undefined;
		}

		const inferred = all.filter(candidate => {
			if (candidate.archived || candidate.borrowsWorktree || !candidate.sandboxed) return false;
			if (candidate.projectId !== source.projectId) return false;
			const coordinates = sandboxWorktreeOwnerCoordinates(candidate);
			return !!coordinates && isWorktreePathReferencedByLiveSession(coordinates.root, [source]);
		});
		return inferred.length === 1 ? inferred[0].id : undefined;
	}

	/** Resolve a durable flattened worktree owner in either host or sandbox realm. */
	resolveWorktreeOwnerSessionId(sessionId: string): string | undefined {
		const source = this.getPersistedSession(sessionId);
		if (!source || source.archived) return undefined;
		if (source.sandboxed) return this.resolveSandboxWorktreeOwnerSessionId(sessionId);
		if (!source.borrowsWorktree) return source.id;

		const all = this.getAllPersistedSessionsForWorktreeGuard();
		const byId = new Map(all.map(session => [session.id, session]));
		const visited = new Set([source.id]);
		let ownerId = source.borrowedWorktreeOwnerSessionId;
		while (ownerId) {
			if (visited.has(ownerId)) return undefined;
			visited.add(ownerId);
			const owner = byId.get(ownerId);
			if (!owner || owner.archived || owner.projectId !== source.projectId || owner.sandboxed) return undefined;
			if (!owner.borrowsWorktree) return owner.id;
			ownerId = owner.borrowedWorktreeOwnerSessionId;
		}
		return undefined;
	}

	private async runWorktreeOwnerLifecycle<T>(ownerSessionId: string, operation: () => Promise<T>): Promise<T> {
		let queue = this._worktreeOwnerLifecycleQueues.get(ownerSessionId);
		if (!queue) {
			queue = { tail: Promise.resolve(), pending: 0 };
			this._worktreeOwnerLifecycleQueues.set(ownerSessionId, queue);
		}
		const predecessor = queue.tail;
		let release!: () => void;
		queue.tail = new Promise<void>(resolve => { release = resolve; });
		queue.pending++;
		await predecessor;
		try {
			return await operation();
		} finally {
			release();
			queue.pending--;
			if (queue.pending === 0 && this._worktreeOwnerLifecycleQueues.get(ownerSessionId) === queue) {
				this._worktreeOwnerLifecycleQueues.delete(ownerSessionId);
			}
		}
	}

	/** Rejection-safe FIFO for one flattened worktree owner, independent of filesystem realm. */
	async withWorktreeOwnerLifecycle<T>(ownerSessionId: string, operation: () => Promise<T>): Promise<T> {
		return this.runWorktreeOwnerLifecycle(ownerSessionId, operation);
	}

	/** Backward-compatible sandbox entry point backed by the realm-neutral owner FIFO. */
	async withSandboxWorktreeOwnerLifecycle<T>(ownerSessionId: string, operation: () => Promise<T>): Promise<T> {
		return this.runWorktreeOwnerLifecycle(ownerSessionId, operation);
	}

	/** Authoritative preflight for flattened borrowers; legacy path inference remains sandbox-only. */
	assertWorktreeOwnerHasNoLiveBorrowers(ownerSessionId: string): void {
		const owner = this.getPersistedSession(ownerSessionId);
		if (!owner || owner.archived || owner.borrowsWorktree) return;
		const sandboxCoordinates = owner.sandboxed ? sandboxWorktreeOwnerCoordinates(owner) : undefined;
		for (const borrower of this.getAllPersistedSessionsForWorktreeGuard()) {
			if (borrower.archived || !borrower.borrowsWorktree || borrower.projectId !== owner.projectId) continue;
			const explicitlyOwned = borrower.borrowedWorktreeOwnerSessionId === ownerSessionId;
			const legacySandboxReference = owner.sandboxed
				&& !borrower.borrowedWorktreeOwnerSessionId
				&& !!sandboxCoordinates
				&& isWorktreePathReferencedByLiveSession(sandboxCoordinates.root, [borrower]);
			if (explicitlyOwned || legacySandboxReference) {
				throw owner.sandboxed
					? new SharedSandboxWorktreeInUseError(ownerSessionId)
					: new SharedWorktreeInUseError(ownerSessionId);
			}
		}
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

	/**
	 * Fail closed when a durable occurrence is fenced by a goal that is no longer
	 * the canonical, runnable adopted goal for this session. This check is
	 * synchronous so no pause/archive write can interleave between it and the Pi
	 * dispatch transition.
	 */
	private goalDispatchGuardAllows(session: SessionInfo, row: Pick<QueuedMessage, "goalDispatchGuardId">): boolean {
		const goalId = row.goalDispatchGuardId;
		if (!goalId) return true;
		const goal = this.resolveGoal(goalId);
		if (!goal) return false;
		if (goal.projectId && session.projectId !== goal.projectId) return false;
		if (goal.worktreeOwnerSessionId !== session.id) return false;
		return !goal.archived
			&& !goal.paused
			&& goal.state === "in-progress"
			&& (goal.setupStatus === undefined || goal.setupStatus === "ready");
	}

	/** Release queued guarded work after operator resume commits, without awaiting Pi. */
	drainGoalGuardedPrompts(goalId: string): void {
		for (const session of this.sessions.values()) {
			if (session.status !== "idle") continue;
			const hasGuardedRow = session.promptQueue.toArray()
				.some((row) => row.goalDispatchGuardId === goalId);
			if (hasGuardedRow) this.drainQueue(session);
		}
	}

	/** Resolve adoption authority from the session's canonical project store, including archived goals. */
	private resolveSessionGoal(ps: Pick<PersistedSession, "projectId" | "goalId" | "teamGoalId">): PersistedGoal | undefined {
		const goalId = ps.teamGoalId ?? ps.goalId;
		if (!goalId) return undefined;
		if (this.projectContextManager && ps.projectId) {
			return this.projectContextManager.getOrCreate(ps.projectId)?.goalStore.get(goalId);
		}
		return this.resolveGoal(goalId);
	}

	private goalWorkspaceCoordinatesMatchSession(goal: PersistedGoal, ps: PersistedSession): boolean {
		if (goal.projectId !== ps.projectId || goal.branch !== ps.branch) return false;
		if (normalizeWorktreeHostPath(goal.repoPath) !== normalizeWorktreeHostPath(ps.repoPath)) return false;
		if (normalizeWorktreeHostPath(goal.worktreePath) !== normalizeWorktreeHostPath(ps.worktreePath)) return false;
		const goalComponents = goal.repoWorktrees ?? {};
		const sessionComponents = ps.repoWorktrees ?? {};
		const goalRepos = Object.keys(goalComponents).sort();
		const sessionRepos = Object.keys(sessionComponents).sort();
		return goalRepos.length === sessionRepos.length
			&& goalRepos.every((repo, index) => repo === sessionRepos[index]
				&& normalizeWorktreeHostPath(goalComponents[repo]) === normalizeWorktreeHostPath(sessionComponents[repo]));
	}

	private goalExactlyAdoptsSession(goal: PersistedGoal, ps: PersistedSession): boolean {
		if (!ps.goalId || ps.teamGoalId !== ps.goalId) return false;
		return goal.id === ps.goalId
			&& goal.worktreeOwnerSessionId === ps.id
			&& this.goalWorkspaceCoordinatesMatchSession(goal, ps);
	}

	private isCanonicalAdoptedWorkspaceOwner(ps: PersistedSession): boolean {
		const goal = this.resolveSessionGoal(ps);
		return !!goal && this.goalExactlyAdoptsSession(goal, ps);
	}

	/** Ordinary polyrepo leads borrow goal worktrees; exact adopted sources remain their lifecycle owner. */
	private hasGoalOwnedTeamLeadWorktrees(ps: PersistedSession): boolean {
		return isNonSandboxedPolyrepoTeamLead(ps) && !this.isCanonicalAdoptedWorkspaceOwner(ps);
	}

	private adoptedWorkspaceHasLiveReference(ps: PersistedSession): boolean {
		if (!this.isCanonicalAdoptedWorkspaceOwner(ps)) return false;
		const records = this.getAllPersistedSessionsForWorktreeGuard();
		const paths = ps.repoWorktrees && Object.keys(ps.repoWorktrees).length > 0
			? Object.values(ps.repoWorktrees)
			: [ps.worktreePath];
		return paths.some(candidate => isWorktreePathReferencedByLiveSession(candidate, records, { ignoreSessionId: ps.id }));
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

	/** Resolve the ToolManager that owns a session's project-scoped pack cascade. */
	private getToolManagerForProject(projectId?: string): ToolManager | undefined {
		if (!projectId || !this.projectContextManager) return this.toolManager;
		return this.projectContextManager.getOrCreate(projectId)?.toolManager;
	}

	/** Resolve effective group policies through the same project cascade as tools. */
	private getGroupPolicyProviderForProject(projectId?: string): GroupPolicyProvider | undefined {
		// Preserve the established server-scope path for genuinely projectless
		// sessions and the raw-store path used by isolated SessionManager tests.
		if (!projectId || !this.configCascade) {
			if (!projectId || !this.projectContextManager) return this.groupPolicyStore;
			return this.projectContextManager.getOrCreate(projectId)?.toolGroupPolicyStore;
		}
		return this.configCascade.createToolGroupPolicyProvider(projectId, this.groupPolicyStore);
	}

	/** Build a PipelineContext from this manager's fields. Requires projectId when PCM is active. */
	buildPipelineContext(projectId?: string, cwd?: string): PipelineContext {
		const resolvedStore = this.getSessionStore(projectId);
		const resolvedSearchIndex = this.getSearchIndexForProject(projectId);
		let resolvedGoalManager: GoalManager;
		let resolvedTaskManager: TaskManager;
		let resolvedProjectConfigStore = this.projectConfigStore ?? null;
		let resolvedToolManager = this.toolManager ?? null;
		let resolvedGroupPolicyStore: GroupPolicyProvider | null = this.getGroupPolicyProviderForProject(projectId) ?? null;
		let resolvedCostTracker: CostTracker;
		if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (ctx) {
				resolvedGoalManager = ctx.goalManager;
				resolvedTaskManager = new TaskManager(ctx.taskStore);
				resolvedProjectConfigStore = ctx.projectConfigStore;
				resolvedToolManager = ctx.toolManager;
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
			toolManager: resolvedToolManager,
			mcpManager: this.getMcpManagerForContext(projectId, cwd),
			marketplacePiExtensionResolver: this.marketplacePiExtensionResolver,
			packLocalDataBindingsResolver: this.packLocalDataBindingsResolver,
			goalManager: resolvedGoalManager,
			taskManager: resolvedTaskManager,
			projectConfigStore: resolvedProjectConfigStore,
			preferencesStore: this.preferencesStore ?? null,
			sandboxManager: this.sandboxManager,
			sandboxTokenStore: this.sandboxTokenStore,
			sessionSecretStore: this.sessionSecretStore,
			groupPolicyStore: resolvedGroupPolicyStore,
			configCascade: this.configCascade,
			lifecycleHub: this.lifecycleHub,
			hostInterceptors: this.hostInterceptors,
			costTracker: resolvedCostTracker,
			store: resolvedStore,
			searchIndex: resolvedSearchIndex,
			sessions: this.sessions,
			listPersistedSessionsForWorktreeGuard: () => this.getAllPersistedSessionsForWorktreeGuard(),
			commandRunner: this.commandRunner,
			assemblePrompt: (id, parts) => this.assemblePrompt(id, parts, projectId),

			applySandboxWiring: (opts, id, sandboxOpts) => this.applySandboxWiring(opts, id, sandboxOpts),
			finalizeSpawnOptions: (opts, requested) => this.finalizeSpawnOptions(opts, requested),
			prepareVisibleAgentEvent: (session, event) => this.prepareVisibleAgentEvent(session, event),
			bindHostLifecycle: (session) => this.attachHostLifecycleObservers(session),
			handleAgentLifecycle: (session, event) => this.handleAgentLifecycle(session, event),
			trackCostFromEvent: (session, event) => this.trackCostFromEvent(session, event),
			recordPiExtensionDiagnostic: (session, diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension),
			broadcast: (clients, msg) => broadcast(clients, msg),
			tryAutoSelectModel: async (session) => { await this.tryAutoSelectModel(session); },
			tryApplyDefaultThinkingLevel: async (session) => { await this.tryApplyDefaultThinkingLevel(session); },
			buildWorkflowList: (projectId?: string) => this._buildWorkflowList(projectId),
			resolveInitialModel: (role, projectId) => this.resolveInitialModel(role, projectId),
			resolveInitialThinkingLevel: (role, projectId) => this.resolveInitialThinkingLevel(role, projectId),
			persistSessionMetadata: (session) => this.persistSessionMetadata(session),
			prStatusStore: this.prStatusStore!,
			testPreparingDelayMs: this.testPreparingDelayMs,
			worktreeSetupRuntime: this.worktreeSetupRuntime,
			remoteGitPolicy: this.remoteGitPolicy,
			now: () => this.clock.now(),
			// Hierarchical goal-metadata resolver, bound to THIS project's GoalManager.
			// The pipeline (tool activation, prompt order, bridge-install) resolves the
			// effective (inherited) metadata for a session's goal through this single
			// closure — no other site walks the goal ancestry. Absent metadata ⇒ {}.
			resolveGoalMetadata: (goalId: string | undefined) => resolvedGoalManager.getEffectiveGoalMetadata(goalId),
		};
	}

	/** Network name for sandbox containers. */
	private static readonly SANDBOX_NETWORK = "bobbit-sandbox-net";
	private ownsSandboxNetwork = false;

	/**
	 * Ensure the Docker bridge network for sandboxed containers exists.
	 * Idempotent — concurrent creation reports `already exists`.
	 */
	async ensureSandboxNetwork(): Promise<string> {
		const name = SessionManager.SANDBOX_NETWORK;
		try {
			await this.commandRunner.execFile("docker", [
				"network", "create", name,
				"--driver", "bridge",
				"--opt", "com.docker.network.bridge.enable_icc=false",
			], { timeout: 15_000 });
			this.ownsSandboxNetwork = true;
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
	 * Remove this manager's sandbox Docker network. Non-fatal if it doesn't exist
	 * or has connected containers.
	 */
	async cleanupSandboxNetwork(): Promise<void> {
		if (!this.ownsSandboxNetwork) return;
		// Consume ownership before yielding so repeated or concurrent cleanup calls
		// cannot issue more than one removal attempt for the same creation grant.
		this.ownsSandboxNetwork = false;
		try {
			await this.commandRunner.execFile("docker", ["network", "rm", SessionManager.SANDBOX_NETWORK], { timeout: 10_000 });
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
			if (await isGitRepo(cwd, this.commandRunner)) {
				const repoRoot = await getRepoRoot(cwd, this.commandRunner);
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
					if (await isGitRepo(projectRoot, this.commandRunner)) {
						const repoRoot = await getRepoRoot(projectRoot, this.commandRunner);
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

	/**
	 * Set gateway credentials on restore/revive/respawn for NON-sandboxed (direct)
	 * agents. Deliberate interim rollback (pre-HQ-split behaviour): direct agents
	 * receive the gateway ADMIN token rather than a per-project scoped token. A
	 * host-resident direct agent already runs as the host user and can read the
	 * admin token off disk, so this grants no new capability — it only removes the
	 * functional friction where direct agents 403 on gateway-wide routes. The
	 * scoped-token boundary that still matters is preserved for sandboxed agents
	 * (see applySandboxWiring). Pending a policy-driven session-authenticated auth
	 * model, specced separately. sessionId/projectId/goalId are retained to avoid
	 * churning call sites.
	 */
	private applyScopedGatewayCredentials(
		bridgeOptions: RpcBridgeOptions,
		_sessionId: string,
		_projectId: string | undefined,
		_goalId?: string,
	): void {
		const gwUrl = this.readGatewayUrlForAgent();
		if (gwUrl) bridgeOptions.gatewayUrl = gwUrl;
		const adminToken = readToken();
		if (adminToken === null) throw new Error("Cannot read gateway admin token for direct agent");
		bridgeOptions.gatewayToken = adminToken;
	}

	/**
	 * Build the launch env for a NON-sandboxed (direct) agent. Deliberate interim
	 * rollback (pre-HQ-split behaviour): direct agents receive the gateway ADMIN
	 * token rather than a per-project scoped token. A host-resident direct agent
	 * already runs as the host user and can read the admin token off disk, so this
	 * grants no new capability — it only removes the functional friction where
	 * direct agents 403 on gateway-wide routes. The scoped-token boundary that
	 * still matters is preserved for sandboxed agents (see applySandboxWiring).
	 * Pending a policy-driven session-authenticated auth model, specced
	 * separately. sessionId/projectId/goalId are retained to avoid churning call
	 * sites.
	 */
	private scopedGatewayEnvForDirectAgent(_sessionId: string, _projectId: string | undefined, _goalId?: string): Record<string, string> | undefined {
		const env: Record<string, string> = {};
		const gwUrl = this.readGatewayUrlForAgent();
		if (gwUrl) env.BOBBIT_GATEWAY_URL = gwUrl;
		const adminToken = readToken();
		if (adminToken === null) throw new Error("Cannot read gateway admin token for direct agent");
		env.BOBBIT_TOKEN = adminToken;
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
		opts?: StrictSandboxWiringOptions,
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
		const expectedExistingContainerId = opts?.expectedExistingContainerId?.trim();
		if (opts?.expectedExistingContainerId !== undefined && !expectedExistingContainerId) {
			throw new Error(`Cannot reuse sandbox for session ${sessionId}: expected container identity is missing`);
		}
		// Ordinary creation/restore lazily initializes as before. Promotion and
		// promoted-source restore pass an exact identity and must only inspect the
		// already-ready sandbox: never bootstrap, transfer, or repair its realm.
		if (!expectedExistingContainerId) await this.sandboxManager.ensureForProject(projectId);
		const sandbox = this.sandboxManager.get(projectId);
		if (!sandbox) {
			throw new Error(`No sandbox initialized for project ${projectId}`);
		}
		const assertExpectedContainer = () => {
			if (!expectedExistingContainerId) return;
			const status = sandbox.getStatus();
			if (status.status !== "ready" || status.containerId !== expectedExistingContainerId) {
				throw new Error(`Cannot reuse sandbox for session ${sessionId}: expected ready container ${expectedExistingContainerId}`);
			}
		};
		assertExpectedContainer();
		const containerId = await sandbox.getContainerId();
		if (expectedExistingContainerId && containerId !== expectedExistingContainerId) {
			throw new Error(`Cannot reuse sandbox for session ${sessionId}: container identity changed`);
		}
		assertExpectedContainer();

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

		// Re-check after credential wiring as well: a health transition during an
		// await must reject before a candidate bridge can start.
		assertExpectedContainer();
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

		// Host Anthropic OAuth is never a default sandbox credential. An enabled,
		// empty ANTHROPIC_OAUTH_TOKEN entry opts in to one current, non-renewable
		// auth.json entry. Project credentials win and never trigger host refresh.
		const secretsStore = projectContext?.secretsStore ?? null;
		await withSandboxAgentAuthFileLock(projectId, async () => {
			const readSandboxAuthPolicy = () => {
				const entries = projectConfigStore.getSandboxTokens();
				const credentials = resolveSandboxTokens(
					this.preferencesStore,
					projectConfigStore,
					secretsStore,
					this.commandRunner,
					{ allowStoredAnthropicOAuth: false },
				);
				const explicitAnthropicCredential = hasExplicitSandboxAnthropicCredential(entries, secretsStore?.getAll());
				const hasSandboxAnthropicCredential = !!(
					credentials.ANTHROPIC_API_KEY || credentials.ANTHROPIC_OAUTH_TOKEN
				);
				return {
					credentials,
					sandboxAuthPolicy: resolveSandboxAgentAuthPolicy(entries),
					includeAnthropicAuth: !explicitAnthropicCredential
						&& !hasSandboxAnthropicCredential
						&& sandboxTokenPolicyAllowsAnthropicAuth(entries),
				};
			};

			let policy = readSandboxAuthPolicy();
			const anthropicOAuthCurrent = policy.includeAnthropicAuth
				&& await refreshSandboxAnthropicOAuthCredential();

			// Refresh is asynchronous, so the user may have configured an explicit
			// project key while it was in flight. Re-read policy and credentials under
			// this project's write lock before changing its shared auth.json.
			policy = readSandboxAuthPolicy();
			bridgeOptions.sandboxCredentials = policy.credentials;
			ensureSandboxAgentAuthFile({
				prefs: this.preferencesStore,
				includeCodexAuth: policy.sandboxAuthPolicy.includeCodexAuth,
				includeAnthropicAuth: anthropicOAuthCurrent && policy.includeAnthropicAuth,
				includeGoogleAuth: policy.sandboxAuthPolicy.includeGoogleAuth,
				scope: projectId,
			});
		});
		assertExpectedContainer();

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

	private resolveTaskIdForSession(sessionId: string): string | undefined {
		if (!this.projectContextManager) {
			const live = this.sessions.get(sessionId);
			if (live?.taskId) return live.taskId;
			const persisted = this.getPersistedSession(sessionId);
			if (persisted?.taskId) return persisted.taskId;
			const tasks = this._testTaskManager?.getTasksForSession(sessionId) ?? [];
			return tasks.length > 0 ? tasks[0].id : undefined;
		}

		const generation = this.projectContextManager.getTaskGeneration();
		const cached = this._taskIdCache.get(sessionId);
		if (cached && cached.gen === generation) return cached.taskId;

		const live = this.sessions.get(sessionId);
		const persisted = this.getPersistedSession(sessionId);
		const stampedTaskId = live?.taskId ?? persisted?.taskId;
		let taskId: string | undefined;

		// A stamped task id is only a hint: assignments can change without
		// rewriting the session row, so verify it against the current task store.
		if (stampedTaskId) {
			for (const ctx of this.projectContextManager.all()) {
				const task = ctx.taskStore.get(stampedTaskId);
				if (task?.assignedSessionId === sessionId) {
					taskId = task.id;
					break;
				}
			}
		}

		if (!taskId) {
			for (const ctx of this.projectContextManager.all()) {
				const tasks = new TaskManager(ctx.taskStore).getTasksForSession(sessionId);
				if (tasks.length > 0) {
					taskId = tasks[0].id;
					break;
				}
			}
		}

		this._taskIdCache.set(sessionId, { gen: generation, taskId });
		return taskId;
	}

	private mcpScopeKey(scope?: { projectId?: string; cwd?: string; scopeKey?: string }): string {
		if (scope?.scopeKey) return scope.scopeKey;
		if (scope?.projectId) return `project:${scope.projectId}`;
		if (scope?.cwd) return `cwd:${path.resolve(scope.cwd)}`;
		return "default";
	}

	getMcpManager(scope?: { projectId?: string; cwd?: string; scopeKey?: string }): McpManager | null {
		const key = this.mcpScopeKey(scope);
		if (key === "default") return this.mcpManager;
		return this.scopedMcpManagers.get(key) ?? null;
	}

	getActiveMcpManagers(): McpManager[] {
		return [
			...(this.mcpManager ? [this.mcpManager] : []),
			...this.scopedMcpManagers.values(),
		];
	}

	refreshExternalMcpToolRegistrations(): void {
		if (!this.toolManager) return;
		const removePrefixes = new Set<string>(["mcp__"]);
		const toolInfos: ReturnType<McpManager["getToolInfos"]> = [];
		for (const mgr of this.getActiveMcpManagers()) {
			const refresh = mgr.getToolRegistrationRefresh();
			for (const prefix of refresh.removePrefixes) removePrefixes.add(prefix);
			toolInfos.push(...refresh.toolInfos);
		}
		for (const prefix of removePrefixes) this.toolManager.removeExternalTools(prefix);
		this.toolManager.registerExternalTools(toolInfos.map(info => ({
			name: info.name,
			description: info.description,
			summary: info.summary ?? info.description,
			group: info.group,
			docs: info.docs,
			provider: { type: 'mcp' as const, server: info.serverName, mcpTool: info.mcpToolName },
		})));
	}

	private async removeScopedMcpManagerByKey(key: string): Promise<boolean> {
		const mgr = this.scopedMcpManagers.get(key);
		if (!mgr) return false;
		this.scopedMcpManagers.delete(key);
		try {
			await mgr.disconnectAll();
		} finally {
			this.refreshExternalMcpToolRegistrations();
		}
		return true;
	}

	async cleanupScopedMcpManagersForProject(projectId: string, rootPath?: string): Promise<void> {
		const targetRoot = rootPath ? path.resolve(rootPath) : undefined;
		const projectScopeKey = this.mcpScopeKey({ projectId });
		const targetCwdScopeKey = targetRoot ? this.mcpScopeKey({ cwd: targetRoot }) : undefined;
		const keys: string[] = [];
		for (const [key, mgr] of this.scopedMcpManagers) {
			const scope = mgr.getDiscoveryScope();
			if (
				key === projectScopeKey
				|| key === targetCwdScopeKey
				|| scope.projectId === projectId
				|| (targetRoot && path.resolve(scope.cwd) === targetRoot)
			) {
				keys.push(key);
			}
		}
		for (const key of keys) await this.removeScopedMcpManagerByKey(key);
	}

	private async cleanupScopedMcpManagersForSessionScope(scope: { projectId?: string; cwd?: string }): Promise<void> {
		if (!scope.cwd) return;
		const cwdKey = this.mcpScopeKey({ cwd: scope.cwd });
		if (!this.scopedMcpManagers.has(cwdKey)) return;
		const cwd = path.resolve(scope.cwd);
		const stillInUse = [...this.sessions.values()].some((s) => !!s.cwd && path.resolve(s.cwd) === cwd);
		if (!stillInUse) await this.removeScopedMcpManagerByKey(cwdKey);
	}

	private createMcpManager(cwd: string, opts?: { projectId?: string; scopeKey?: string; includeAdditionalProjects?: boolean }): McpManager {
		const projectConfigStore = opts?.projectId && this.projectContextManager
			? (this.projectContextManager.getOrCreate(opts.projectId)?.projectConfigStore ?? this.projectConfigStore)
			: this.projectConfigStore;
		const mgr = new McpManager(cwd, projectConfigStore, bobbitStateDir(), {
			marketplaceResolver: this.marketplaceMcpResolver ?? undefined,
			...(opts?.projectId ? { projectId: opts.projectId } : {}),
			...(opts?.scopeKey ? { scopeKey: opts.scopeKey } : {}),
		});
		if (opts?.includeAdditionalProjects && this.projectContextManager) {
			const additionalProjects = Array.from(this.projectContextManager.all())
				.filter(ctx => ctx.project.rootPath !== cwd)
				.map(ctx => ({ cwd: ctx.project.rootPath, configStore: ctx.projectConfigStore }));
			if (additionalProjects.length > 0) mgr.setAdditionalProjects(additionalProjects);
		}
		return mgr;
	}

	async ensureMcpManager(scope?: { projectId?: string; cwd?: string; scopeKey?: string }): Promise<McpManager | null> {
		const key = this.mcpScopeKey(scope);
		if (key === "default") return this.mcpManager;
		const existing = this.scopedMcpManagers.get(key);
		if (existing) return existing;
		let cwd = scope?.cwd;
		let projectId = scope?.projectId;
		if (projectId && this.projectContextManager) {
			const ctx = this.projectContextManager.getOrCreate(projectId);
			if (!ctx) return null;
			cwd = ctx.project.rootPath;
		}
		if (!cwd) return null;
		const mgr = this.createMcpManager(cwd, { projectId, scopeKey: key });
		this.scopedMcpManagers.set(key, mgr);
		await mgr.connectAll();
		return mgr;
	}

	private getMcpManagerForContext(projectId?: string, cwd?: string): McpManager | null {
		if (projectId) return this.getMcpManager({ projectId, cwd });
		return null;
	}

	private async ensureMcpManagerForContext(projectId?: string, cwd?: string): Promise<McpManager | null> {
		if (projectId) return this.ensureMcpManager({ projectId, cwd });
		return null;
	}

	private getMcpSessionScope(sessionId: string): { projectId?: string; cwd?: string } {
		const live = this.sessions.get(sessionId);
		const persisted = live ? null : this.getPersistedSession(sessionId);
		return { projectId: live?.projectId ?? persisted?.projectId, cwd: live?.cwd ?? persisted?.cwd };
	}

	getMcpManagerForSession(sessionId: string): McpManager | null {
		const { projectId, cwd } = this.getMcpSessionScope(sessionId);
		return this.getMcpManagerForContext(projectId, cwd);
	}

	async ensureMcpManagerForSession(sessionId: string): Promise<McpManager | null> {
		const { projectId, cwd } = this.getMcpSessionScope(sessionId);
		return this.ensureMcpManagerForContext(projectId, cwd);
	}

	async resolveMcpManagerForSession(sessionId: string, scopeKey?: string): Promise<McpManager | null> {
		if (!scopeKey) return this.ensureMcpManagerForSession(sessionId);
		const { projectId } = this.getMcpSessionScope(sessionId);
		const projectScopeKey = projectId ? this.mcpScopeKey({ projectId }) : undefined;
		if (projectId && scopeKey === projectScopeKey) return this.getMcpManager({ scopeKey }) ?? await this.ensureMcpManager({ projectId });
		return null;
	}

	private aggregateMcpReloadResults(results: McpReloadResult[]): McpReloadResult | undefined {
		if (results.length === 0) return undefined;
		const connected = results.flatMap(r => r.connected);
		const disconnected = results.flatMap(r => r.disconnected);
		const unchanged = results.flatMap(r => r.unchanged);
		const skippedErrored = results.flatMap(r => r.skippedErrored);
		const failed = results.flatMap(r => r.failed);
		const statuses = results.flatMap(r => r.statuses);
		let status: McpReloadResult["status"] = "ok";
		if (results.some(r => r.status === "pending")) {
			status = "pending";
		} else if (results.every(r => r.status === "error")) {
			status = "error";
		} else if (results.some(r => r.status === "error" || r.status === "partial")) {
			status = "partial";
		}
		return { status, connected, disconnected, unchanged, skippedErrored, failed, statuses };
	}

	async reloadMcpAfterMarketplaceMutation(scope?: "server" | "global-user" | "project", projectId?: string): Promise<McpReloadResult | undefined> {
		const managers = new Set<McpManager>();
		if (scope === "project") {
			const mgr = await this.ensureMcpManager({ projectId });
			if (mgr) managers.add(mgr);
		} else {
			if (this.mcpManager) managers.add(this.mcpManager);
			for (const mgr of this.scopedMcpManagers.values()) managers.add(mgr);
		}
		const results: McpReloadResult[] = [];
		const pendingRefreshes: Promise<unknown>[] = [];
		for (const mgr of managers) {
			try {
				const result = await mgr.reloadDiscoveredServers({ timeoutMs: 30_000, queueIfInFlight: true });
				results.push(result);
				if (result.status === "pending") {
					const pending = mgr.currentReload();
					if (pending) pendingRefreshes.push(pending.catch(() => undefined));
				}
			} catch (err) {
				const scopeKey = mgr.getScopeKey();
				results.push({
					status: "error",
					connected: [],
					disconnected: [],
					unchanged: [],
					skippedErrored: [],
					failed: [{ name: scopeKey, error: err instanceof Error ? err.message : String(err) }],
					statuses: [],
				});
			}
		}
		if (pendingRefreshes.length > 0) {
			void Promise.allSettled(pendingRefreshes).then(() => this.refreshExternalMcpToolRegistrations());
		}
		return this.aggregateMcpReloadResults(results);
	}

	setMarketplaceMcpResolver(resolver: MarketplaceMcpResolver | null | undefined): void {
		this.marketplaceMcpResolver = resolver ?? null;
		this.mcpManager?.setMarketplaceResolver(this.marketplaceMcpResolver);
		for (const mgr of this.scopedMcpManagers.values()) mgr.setMarketplaceResolver(this.marketplaceMcpResolver);
	}

	setMarketplacePiExtensionResolver(resolver: MarketplacePiExtensionResolver | null | undefined): void {
		this.marketplacePiExtensionResolver = resolver ?? null;
	}

	/** Late-bound by server composition after the winning pack registry exists. */
	setPackLocalDataBindingsResolver(resolver: PackLocalDataBindingsResolver | null | undefined): void {
		this.packLocalDataBindingsResolver = resolver ?? null;
	}

	resolveMarketplacePiExtensionContributions(projectId?: string, cwd?: string, selectedToolManager?: ToolManager): ReturnType<MarketplacePiExtensionResolver> {
		const toolManager = selectedToolManager ?? this.getToolManagerForProject(projectId);
		return this.overlayPiExtensionRuntimeDiagnostics(this.marketplacePiExtensionResolver?.({ projectId, cwd }, toolManager) ?? []);
	}

	private resolveMarketplacePiExtensionArgs(projectId: string | undefined, cwd: string | undefined, toolManager: ToolManager | undefined): MarketplacePiExtensionActivation {
		return resolveMarketplacePiExtensionActivation(
			(scope, selectedToolManager) => this.resolveMarketplacePiExtensionContributions(scope.projectId, scope.cwd, selectedToolManager),
			projectId,
			cwd,
			toolManager,
		);
	}

	/**
	 * Select one scoped tool-policy tuple and discover Pi tools into that exact
	 * manager. Replacement funnels prepare this before allowlists or prompt docs,
	 * then reuse the discovery snapshot when building activation argv.
	 */
	private prepareScopedToolRuntime(projectId: string | undefined, cwd: string | undefined): PreparedScopedToolRuntime {
		const toolManager = this.getToolManagerForProject(projectId);
		const groupPolicyStore = this.getGroupPolicyProviderForProject(projectId);
		const toolScope = scopedToolContext(projectId, cwd);
		const piExtensionActivation = this.resolveMarketplacePiExtensionArgs(projectId, cwd, toolManager);
		return { toolManager, groupPolicyStore, toolScope, piExtensionActivation };
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
	 * waiting for `git worktree add` + `npm ci` (~10-30s).
	 */
	initWorktreePoolForProject(projectId: string, repoPath: string, componentsResolver?: () => import("./project-config-store.js").Component[], targetSize = 2, worktreeRoot?: string, baseRefResolver?: () => string | undefined, setupTimeoutResolver?: () => number | string | undefined, projectRoot?: string): Promise<void> {
		let hiddenProject = false;
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				if (ctx.project.id === projectId) {
					hiddenProject = ctx.project.hidden === true;
					break;
				}
			}
		}
		if (projectId === HEADQUARTERS_PROJECT_ID || hiddenProject) {
			this.worktreePools.delete(projectId);
			return Promise.resolve();
		}
		const pending = this.worktreePoolInitializations.get(projectId);
		if (pending) return pending;
		if (this.worktreePools.has(projectId)) return Promise.resolve();
		// `baseRefResolver` reads the live project `base_ref` setting; the resolver
		// pattern (mirrors `componentsResolver`) lets pool entries auto-adopt the
		// current configured integration target without a server restart. When
		// callers don't supply one, the pool falls back to today's
		// `resolveRemotePrimary` behaviour (see `docs/design/base-ref.md` §7).
		// `setupTimeoutResolver` reads `worktree_setup_timeout_ms` so the project
		// default applies to per-component setup during pool prebuild.
		const pool = new WorktreePool({ repoPath, targetSize, componentsResolver, worktreeRoot, baseRefResolver, setupTimeoutResolver, projectRoot, commandRunner: this.commandRunner, remotePolicy: this.remoteGitPolicy, worktreeSetupRuntime: this.worktreeSetupRuntime });
		this.worktreePools.set(projectId, pool);

		// Collect worktree paths owned by active sessions so the pool doesn't
		// reclaim them as orphaned pool entries on restart.
		const activeWorktreePaths = new Set<string>();
		for (const s of this.sessions.values()) {
			if (s.worktreePath) activeWorktreePaths.add(s.worktreePath);
		}

		let initialization!: Promise<void>;
		initialization = pool.initialize(activeWorktreePaths)
			.catch((error) => {
				if (this.worktreePools.get(projectId) === pool) this.worktreePools.delete(projectId);
				throw error;
			})
			.finally(() => {
				if (this.worktreePoolInitializations.get(projectId) === initialization) {
					this.worktreePoolInitializations.delete(projectId);
				}
			});
		this.worktreePoolInitializations.set(projectId, initialization);
		return initialization;
	}

	/** @deprecated Use initWorktreePoolForProject instead. */
	initWorktreePool(repoPath: string, _setupCommand?: string, targetSize = 2): Promise<void> {
		// Legacy shim — uses empty string as key for backward compat. setupCommand
		// is ignored; canonical path is `components[*].worktreeSetupCommand`.
		return this.initWorktreePoolForProject("", repoPath, undefined, targetSize);
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

	async initMcp(cwd: string): Promise<void> {
		try {
			const mgr = this.createMcpManager(cwd, { includeAdditionalProjects: true });

			await mgr.connectAll();
			this.mcpManager = mgr;

			if (this.projectContextManager) {
				for (const ctx of this.projectContextManager.all()) {
					const key = this.mcpScopeKey({ projectId: ctx.project.id });
					if (this.scopedMcpManagers.has(key)) continue;
					const scoped = this.createMcpManager(ctx.project.rootPath, { projectId: ctx.project.id, scopeKey: key });
					this.scopedMcpManagers.set(key, scoped);
					await scoped.connectAll();
				}
			}

			// Register MCP tools with ToolManager across default and scoped managers.
			this.refreshExternalMcpToolRegistrations();
			console.log(`[mcp] MCP initialization complete`);
		} catch (err) {
			console.error('[mcp] Failed to initialize MCP:', (err as Error).message);
		}
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
		return buildWorkflowListText(workflows);
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
	private resolveEffectiveAllowedTools(
		role: import("./role-store.js").Role | undefined,
		projectId?: string,
		cwd?: string,
		preparedRuntime?: Pick<PreparedScopedToolRuntime, "toolManager" | "groupPolicyStore" | "toolScope">,
	): EffectiveTool[] {
		if (!role) return [];
		const toolManager = preparedRuntime
			? preparedRuntime.toolManager
			: this.getToolManagerForProject(projectId);
		if (toolManager) {
			return computeEffectiveAllowedTools(
				toolManager,
				role,
				preparedRuntime ? preparedRuntime.groupPolicyStore : this.getGroupPolicyProviderForProject(projectId),
				this.getMcpManagerForContext(projectId, cwd) ?? undefined,
				preparedRuntime ? preparedRuntime.toolScope : scopedToolContext(projectId, cwd),
			);
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
		sandboxed = false,
		preparedRuntime?: PreparedScopedToolRuntime,
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
		const runtime = preparedRuntime ?? this.prepareScopedToolRuntime(projectId, cwd);
		const { toolManager, groupPolicyStore, toolScope, piExtensionActivation } = runtime;

		const mcpManager = this.getMcpManagerForContext(projectId, cwd);

		// MCP proxy extensions
		const mcpExtPaths = mcpManager
			? writeMcpProxyExtensions(mcpManager, flatNames, role, toolManager, groupPolicyStore, disabledTools, toolScope)
			: undefined;

		// Builtin + bobbit-extension activation
		const activation = computeToolActivationArgs(filteredAllowed, toolManager, cwd, mcpExtPaths, disabledTools, toolScope);

		const args = prependToolResultErrorBridge([...activation.args, ...piExtensionActivation.args]);

		// Compute session-specific grants (tools in allowedTools but not in the role's base allowedTools)
		// and layer explicit grant records on top. Ask-gated tools are part of the
		// effective role surface so the derived diff alone cannot identify that a
		// session-only approval should pre-populate the guard after restart. One-time
		// approvals are intentionally not threaded into grantedTools; the guard lets
		// only the blocked invocation continue based on the grant response mode.
		const roleBaseTools = role && toolManager
			? computeEffectiveAllowedTools(toolManager, role as import("./role-store.js").Role, groupPolicyStore, mcpManager ?? undefined, toolScope)
			: [];
		const roleAllowed = new Set(roleBaseTools.map(t => t.name.toLowerCase()));
		const derivedSessionGrants = (flatNames ?? []).filter(t => !roleAllowed.has(t.toLowerCase()));
		const sessionGrants = this.mergeToolNames(derivedSessionGrants, grantedTools) ?? [];

		// Tool guard extension for 'ask' policy tools
		const guardPath = toolManager
			? writeToolGuardExtension(sessionId, toolManager, mcpManager ?? undefined, role, groupPolicyStore, sessionGrants, disabledTools, toolScope)
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
		const turnHooksNeeded = this.hostInterceptors?.hasAny?.(
			["beforePrompt", "beforeCompact"], projectId, effectiveGoalId,
		) ?? (!!this.lifecycleHub && hasProviderBridgeHooks(this.lifecycleHub, projectId, effectiveGoalId));
		if (turnHooksNeeded) {
			const bridgePath = writeProviderBridgeExtension(sessionId);
			if (bridgePath) {
				args.push("--extension", bridgePath);
			}
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

		const aigwDnsGuardPath = writeAigwDnsGuardExtension();
		if (aigwDnsGuardPath) {
			args.push("--extension", aigwDnsGuardPath);
		}

		const packLocalDataEnv = resolvePackLocalDataEnvironment(
			this.packLocalDataBindingsResolver,
			projectId,
			sandboxed,
		);
		const beforeToolCallFailClosed = this.hostInterceptors?.requiresFailClosed?.(
			"beforeToolCall", projectId, effectiveGoalId,
		) === true;
		const afterToolResultFailClosed = this.hostInterceptors?.requiresFailClosed?.(
			"afterToolResult", projectId, effectiveGoalId,
		) === true;
		return {
			args,
			env: {
				...activation.env,
				...packLocalDataEnv,
				// The same exact-auth bridge owns canonical tool lifecycle metadata even
				// when no interceptor contributes a decision. Failure policy remains
				// contribution-derived through the two flags below.
				BOBBIT_HOST_HOOKS_ENABLED: "1",
				BOBBIT_HOST_BEFORE_TOOL_CALL_FAIL_CLOSED: beforeToolCallFailClosed ? "1" : "0",
				BOBBIT_HOST_AFTER_TOOL_RESULT_FAIL_CLOSED: afterToolResultFailClosed ? "1" : "0",
			},
			runtimeExtensions: piExtensionActivation.runtimeExtensions,
		};
	}

	private messageAuthorDependencies(
		session?: Pick<SessionInfo, "assistantType" | "projectId">,
	): AgentAuthorDependencies {
		return {
			getStaff: this.staffRecordSource ? (staffId) => this.staffRecordSource!.getStaff(staffId) : undefined,
			getRole: (name) => this.resolveSessionRole(name, session?.assistantType, session?.projectId),
		};
	}

	private resolveSessionRole(roleName?: string, assistantType?: string, projectId?: string): import("./role-store.js").Role | undefined {
		const name = roleName || (assistantType ? assistantRoleForType(assistantType) : "general");
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

	/**
	 * Cascade-aware role source for `{{AVAILABLE_ROLES}}` substitution. The bare
	 * `RoleManager` view only sees stored roles, so a team-lead prompt rebuilt via
	 * `getPromptParts` (freshly-created sessions never cache promptParts because
	 * assemblePrompt runs before the session is registered) would drop market-pack
	 * roles that the real team-manager prompt lists via the config cascade. This
	 * source merges cascade roles (incl. server/project market packs) over the
	 * role-manager view so the reconstructed prompt matches the assembled one.
	 */
	private availableRolesSource(projectId: string | undefined): { getAll: () => import("./role-store.js").Role[] } {
		return {
			getAll: () => {
				const seen = new Set<string>();
				const out: import("./role-store.js").Role[] = [];
				let cascade: import("./role-store.js").Role[] = [];
				if (this.configCascade) {
					try { cascade = this.configCascade.resolveRoles(projectId).map(r => r.item); } catch { cascade = []; }
				}
				const mgr = this.roleManager?.listRoles?.() ?? [];
				for (const r of [...cascade, ...mgr]) {
					if (!seen.has(r.name)) { seen.add(r.name); out.push(r); }
				}
				return out;
			},
		};
	}

	/** Generate tool docs and inject into prompt parts before assembly. */
	private assemblePrompt(sessionId: string, parts: PromptParts, projectId?: string): string | undefined {
		return profile("sessionManager.assemblePrompt", () => this._assemblePrompt(sessionId, parts, projectId));
	}

	private _assemblePrompt(sessionId: string, parts: PromptParts, projectId?: string): string | undefined {
		const effectiveProjectId = projectId ?? this.sessions.get(sessionId)?.projectId;
		const promptToolManager = this.getToolManagerForProject(effectiveProjectId);
		if (promptToolManager && !parts.toolDocs) {
			parts.toolDocs = promptToolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir(), scopedToolContext(effectiveProjectId, parts.cwd));
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
		persistPromptSections(sessionId, parts, this.stateDir);
		return assembleSystemPrompt(sessionId, parts, this.stateDir);
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
		/** Role name for a `team_delegate(role: X)` child — surfaces the role
		 *  promptTemplate in the reconstructed parts (rolePrompt is not persisted). */
		role?: string;
		projectId?: string;
		goalId?: string;
		sessionId?: string;
	}): PromptParts {
		// Role injection (§Gap 2): re-resolve the role prompt cascade-first so a
		// role-carrying delegate's reconstructed parts (inspector / prompt-sections)
		// match the assembled system prompt. Role-less delegates leave it undefined.
		let rolePrompt: string | undefined;
		if (opts.role) {
			const template = this.resolveRolePromptTemplate(opts.role, opts.projectId);
			if (template) {
				const goalBranch = opts.goalId ? this.resolveGoal(opts.goalId)?.branch : undefined;
				rolePrompt = resolveRolePrompt({ promptTemplate: template }, {
					branch: goalBranch,
					agentId: `${opts.role}-${(opts.sessionId ?? "").slice(0, 8)}`,
					roleManager: this.availableRolesSource(opts.projectId) as unknown as RoleManager,
					subGoalsEnabled: this.isSubgoalsEnabled,
				});
			}
		}
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
			rolePrompt,
			roleName: rolePrompt ? opts.role : undefined,
			allowedTools: opts.allowedTools,
			projectConfigStore: this.projectConfigStore,
			sectionOrder: opts.sectionOrder,
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
				role: session.role ?? persisted.role,
				projectId: session.projectId ?? persisted.projectId,
				goalId: effectiveGoalId,
				sessionId: session.id,
			});
			parts.dynamicContext = session.promptParts?.dynamicContext;
			const delegateProjectId = session.projectId ?? persisted.projectId;
			const delegateToolManager = this.getToolManagerForProject(delegateProjectId);
			if (delegateToolManager && !parts.toolDocs) {
				parts.toolDocs = delegateToolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir(), scopedToolContext(delegateProjectId, parts.cwd));
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
			// Mirror the spawn/restore paths: the backing role's template is a
			// dedicated "Role" section (rolePrompt/roleName), NOT folded into Goal,
			// so the reconstructed prompt-sections snapshot matches what was spawned.
			const assistantRoleName = assistantRoleForType(session.assistantType);
			const assistantTemplate = this.resolveRolePromptTemplate(assistantRoleName, session.projectId);
			const assistantRolePrompt = assistantTemplate
				? assistantTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(session.goalId || session.id).slice(0, 8)}`)
				: undefined;
			let assistantGoalSpec = assistantDef.prompt;
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
			if (session.assistantType === "support") {
				assistantGoalSpec = assistantGoalSpec
					.replaceAll("{{BOBBIT_DOCS_DIR}}", resolveBundledDocsDir())
					.replaceAll("{{BOBBIT_SRC_DIR}}", resolveBundledSrcDir());
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
				rolePrompt: assistantRolePrompt,
				roleName: assistantRoleName,
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
				// Cascade-aware so {{AVAILABLE_ROLES}} in a rebuilt team-lead prompt
				// lists market-pack roles (matches the team-manager assembled prompt).
				roleManager: this.availableRolesSource(session.projectId) as unknown as RoleManager,
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
			};
		}

		const promptProjectId = session.projectId ?? persisted?.projectId;
		const sessionToolManager = this.getToolManagerForProject(promptProjectId);
		if (sessionToolManager && !parts.toolDocs) {
			parts.toolDocs = sessionToolManager.getToolDocsForPrompt(parts.allowedTools, bobbitStateDir(), scopedToolContext(promptProjectId, parts.cwd));
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

	private reliableIntentById(session: SessionInfo, intentId: string): ReliableQueuedMessage | ReliableInFlightRecord | undefined {
		const queued = (session.promptQueue.toArray() as ReliableQueuedMessage[]).find((row) => row.id === intentId);
		if (queued) return queued;
		return (session.inFlightSteerTexts as ReliableInFlightRecord[] | undefined)?.find((row) => row.intentId === intentId);
	}

	/** Durable terminal disposition used to dedupe replayed admission frames. */
	intentSettlement(sessionId: string, intentId: string): "surfaced" | "cancelled" | undefined {
		const session = this.sessions.get(sessionId);
		if (session && [...(session.promptAuthorMessageBindings?.values() ?? [])].some((binding) =>
			(binding.intentId === intentId || binding.promptId === intentId) && binding.settled,
		)) return "surfaced";
		if (session?.lastKeylessPromptAuthorEnd?.settled
			&& (session.lastKeylessPromptAuthorEnd.intentId === intentId
				|| session.lastKeylessPromptAuthorEnd.promptId === intentId)) return "surfaced";
		const latest = selectLatestPromptAuthorBinding(
			readAuthorSidecar(sessionId),
			(binding) => binding.intentId === intentId || binding.promptId === intentId,
		);
		return latest?.settlement?.outcome === "echoed"
			? "surfaced"
			: latest?.settlement?.outcome === "cancelled"
				? "cancelled"
				: undefined;
	}

	/** Bounded body-free explicit-dismissal replay for reconnecting tabs. */
	cancelledIntentIds(sessionId: string, limit = 256): string[] {
		const bindings = readAuthorSidecar(sessionId);
		const visibleIds = new Set(this.sessions.get(sessionId)?.promptQueue.toArray().map((row) => row.id) ?? []);
		const intentIds = new Set(bindings.flatMap((binding) => binding.intentId ? [binding.intentId] : []));
		return [...intentIds]
			.filter((intentId) => !visibleIds.has(intentId))
			.filter((intentId) => {
				const latest = selectLatestPromptAuthorBinding(
					bindings,
					(binding) => binding.intentId === intentId,
				);
				return latest?.attemptId?.startsWith("dismiss:") === true
					&& latest.settlement?.outcome === "cancelled";
			})
			.slice(-Math.max(0, limit));
	}

	private reliableIntentWasSettled(session: SessionInfo, intentId: string): boolean {
		return this.intentSettlement(session.id, intentId) !== undefined;
	}

	private persistIntentCancellation(session: SessionInfo, row: ReliableQueuedMessage): boolean {
		const existing = selectLatestPromptAuthorBinding(
			readAuthorSidecar(session.id),
			(binding) => binding.intentId === row.id || binding.promptId === row.id,
		);
		if (existing?.settlement?.outcome === "echoed") return false;
		const recoveredAttempt = row.attemptId !== undefined && row.attemptId === existing?.attemptId;
		if (existing?.settlement?.outcome === "cancelled" && !recoveredAttempt) return true;

		// A recovered queue row legitimately follows a cancelled delivery attempt.
		// Give explicit dismissal a fresh exact attempt so restore can distinguish
		// terminal intent cancellation from the retired attempt marker on the row.
		// Identity and terminal settlement share one fsynced ledger record: after it
		// succeeds, even a crash before queue persistence cannot revive this row.
		const settledAt = this.clock.now();
		const attemptId = promptAttemptId("dismiss");
		const source = row.source ?? "user";
		const author = resolveAcceptedPromptAuthor(source, row.author);
		return appendPromptAuthorDismissalTombstone(session.id, {
			schemaVersion: 2,
			type: "prompt-author-dismissal",
			promptId: row.id,
			intentId: row.id,
			attemptId,
			dispatchEpoch: settledAt,
			dispatchedAt: settledAt,
			settledAt,
			modelText: row.text,
			source,
			author,
		});
	}

	private nextIntentSequence(session: SessionInfo, targetTurn: DeliveryTargetTurn): number {
		const queued = session.promptQueue.toArray() as ReliableQueuedMessage[];
		const ledger = (session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[];
		return Math.max(0, ...queued.filter((row) => row.targetTurn === targetTurn).map((row) => row.sequence ?? 0),
			...ledger.filter((row) => row.targetTurn === targetTurn).map((row) => row.sequence ?? 0)) + 1;
	}

	private nextIntentAcceptedAt(session: SessionInfo): number {
		const acceptedTimes = [
			...(session.promptQueue.toArray() as ReliableQueuedMessage[]).map((row) => row.createdAt ?? 0),
			...((session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[]).map((row) => row.createdAt ?? 0),
		];
		return Math.max(this.clock.now(), Math.max(0, ...acceptedTimes) + 1);
	}

	private enqueueReliableIntent(
		session: SessionInfo,
		row: ReliableQueuedMessage,
		opts?: { front?: boolean },
	): ReliableQueuedMessage {
		const existing = this.reliableIntentById(session, row.id);
		if (existing) return existing as ReliableQueuedMessage;
		if (opts?.front) {
			return session.promptQueue.enqueueExistingAtFront(row) as ReliableQueuedMessage;
		}
		// Admission must create the durable row through the queue's normal enqueue
		// boundary. Besides retaining its stable intent ID, this preserves the legacy
		// acceptance-row ownership relied on by poison repair when a later replacement
		// must recover the exact first accepted occurrence.
		const previousIds = session.promptQueue.toArray().map((item) => item.id);
		const inserted = session.promptQueue.enqueue(row.text, { intentId: row.id }) as ReliableQueuedMessage;
		Object.assign(inserted, row);
		// Legacy PromptQueue eagerly prioritizes isSteered. Reliable lanes own order.
		session.promptQueue.reorderByIds([...previousIds, row.id]);
		return inserted;
	}

	private makeReliableIntentRow(
		session: SessionInfo,
		intentId: string,
		text: string,
		kind: "prompt" | "steer",
		targetTurn: DeliveryTargetTurn,
		opts: {
			images?: Array<{ type: "image"; data: string; mimeType: string }>;
			attachments?: unknown[];
			suppressTitleGen?: boolean;
			streamingBehavior?: PromptStreamingBehavior;
			coldStart?: boolean;
			goalDispatchGuardId?: string;
			source: PromptSource;
			author: MessageAuthor;
		},
	): ReliableQueuedMessage {
		return {
			id: intentId,
			text,
			isSteered: kind === "steer",
			createdAt: this.nextIntentAcceptedAt(session),
			kind,
			targetTurn,
			sequence: this.nextIntentSequence(session, targetTurn),
			deliveryState: "queued",
			...(opts.images?.length ? { images: opts.images } : {}),
			...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
			...(opts.suppressTitleGen ? { suppressTitleGen: true } : {}),
			...(opts.streamingBehavior ? { streamingBehavior: opts.streamingBehavior } : {}),
			...(opts.coldStart ? { coldStart: true } : {}),
			...(opts.goalDispatchGuardId ? { goalDispatchGuardId: opts.goalDispatchGuardId } : {}),
			source: opts.source,
			author: opts.author,
		};
	}

	/** Server-authoritative outbox used by live broadcasts and initial WS attach. */
	projectDeliveryOutbox(sessionId: string): QueuedMessage[] {
		const session = this.sessions.get(sessionId);
		if (!session) return [];
		return projectReliableDeliveryOutbox(
			session.promptQueue.toArray() as ReliableQueuedMessage[],
			(session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[],
		);
	}

	private persistedInFlightSteerTexts(session: SessionInfo): InFlightSteerRecord[] | undefined {
		const ledger = session.inFlightSteerTexts?.filter((record) => record.text.length > 0) ?? [];
		return ledger.length > 0 ? ledger.map((record) => ({ ...record })) : undefined;
	}

	private persistInFlightSteerLedger(session: SessionInfo): void {
		this.resolveStoreForSession(session.id).update(session.id, {
			inFlightSteerTexts: this.persistedInFlightSteerTexts(session),
		});
	}

	/** Apply a synchronously persisted exact echo/cancellation that preceded RPC acknowledgement. */
	private pruneTerminalInFlightAttempt(session: SessionInfo, intentId: string, attemptId: string): boolean {
		const terminal = readAuthorSidecar(session.id).some((binding) =>
			binding.intentId === intentId
			&& binding.attemptId === attemptId
			&& binding.settlement !== undefined);
		if (!terminal) return false;
		const ledger = (session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[];
		const next = ledger.filter((record) => record.intentId !== intentId || record.attemptId !== attemptId);
		if (next.length === ledger.length) return false;
		session.inFlightSteerTexts = next;
		this.broadcastQueue(session);
		return true;
	}

	private broadcastQueue(session: SessionInfo, _opts?: { includeInFlightSteers?: boolean }): void {
		const queue = session.promptQueue.toArray();
		const projection = this.projectDeliveryOutbox(session.id);
		broadcast(session.clients, {
			type: "queue_update",
			sessionId: session.id,
			queue: projection,
		});
		// Queue and attempt evidence are one persistence transaction. A transport/RPC
		// acknowledgement never clears the projection; only correlated Pi receipt does.
		this.resolveStoreForSession(session.id).update(session.id, {
			messageQueue: queue,
			inFlightSteerTexts: this.persistedInFlightSteerTexts(session),
		});
	}

	private _queuePromptBehindReplacement(sessionId: string, text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
		modelText?: string;
		skillExpansions?: SkillExpansion[];
		fileMentions?: FileMention[];
		source?: PromptSource;
		author?: MessageAuthor;
		streamingBehavior?: PromptStreamingBehavior;
		coldStart?: boolean;
		suppressTitleGen?: boolean;
		intentId?: string;
		goalDispatchGuardId?: string;
	}): { status: "queued" | "dispatched" } | undefined {
		const coordinator = this._sessionReplacementCoordinators.get(sessionId);
		if (!coordinator) return undefined;
		// Keep one ordered acceptance ledger for the coordinator's whole lifetime.
		// A replacement can install its fresh SessionInfo before post-install work
		// finishes; switching prompt ownership at that point splits the queue and
		// makes final reconciliation append an earlier prompt after a later one.
		const session = coordinator.promptOwner ?? this.sessions.get(sessionId);
		if (!session) return { status: "queued" };
		coordinator.promptOwner ??= session;
		// Replay must converge on the coordinator's canonical acceptance ledger
		// before author/skill envelopes or queue persistence are mutated. The live
		// sessions map may already point at a staged successor, so deduping there
		// would miss an occurrence still owned by promptOwner.
		const source = opts?.source ?? "user";
		// Server admissions always identify their source. Compaction also requires
		// a durable occurrence for historical no-options callers.
		const reliableIntentId = opts?.intentId ?? (opts?.source !== undefined || session.isCompacting ? randomUUID() : undefined);
		if (reliableIntentId) {
			const existing = this.reliableIntentById(session, reliableIntentId);
			if (existing || this.reliableIntentWasSettled(session, reliableIntentId)) {
				return {
					status: existing && (existing as ReliableQueuedMessage).deliveryState === "queued"
						? "queued"
						: "dispatched",
				};
			}
		}
		const author = resolveAcceptedPromptAuthor(source, opts?.author);
		session.lastPromptSource = source;
		const dispatchText = synthesizeAttachmentText(opts?.modelText ?? text, opts?.images, opts?.attachments);
		const hasSkillExpansions = !!opts?.skillExpansions?.length;
		const hasFileMentions = !!opts?.fileMentions?.length;
		if (hasSkillExpansions || hasFileMentions) {
			const recordId = appendIdentifiedSkillSidecarEntry(sessionId, {
				ts: this.clock.now(),
				modelText: dispatchText,
				originalText: text,
				skillExpansions: opts?.skillExpansions ?? [],
				...(hasFileMentions ? { fileMentions: opts!.fileMentions! } : {}),
			});
			if (!session.pendingSkillExpansions) session.pendingSkillExpansions = [];
			session.pendingSkillExpansions.push({
				modelText: dispatchText,
				originalText: text,
				skillExpansions: opts?.skillExpansions ?? [],
				...(hasFileMentions ? { fileMentions: opts!.fileMentions! } : {}),
				...(recordId ? { recordId } : {}),
			});
		}
		// Server-generated work entered the occurrence lifecycle before any sidecar
		// persistence above; now persist the delivery carrier itself.
		if (reliableIntentId) {
			this.enqueueReliableIntent(session, this.makeReliableIntentRow(
				session,
				reliableIntentId,
				dispatchText,
				opts?.isSteered ? "steer" : "prompt",
				"next-turn",
				{
					images: opts?.images,
					attachments: opts?.attachments,
					suppressTitleGen: opts?.suppressTitleGen,
					streamingBehavior: opts?.streamingBehavior,
					coldStart: opts?.coldStart,
					goalDispatchGuardId: opts?.goalDispatchGuardId,
					source,
					author,
				},
			));
		} else {
			session.promptQueue.enqueue(dispatchText, {
				images: opts?.images,
				attachments: opts?.attachments,
				isSteered: opts?.isSteered,
				suppressTitleGen: opts?.suppressTitleGen,
				source,
				author,
				streamingBehavior: opts?.streamingBehavior,
				coldStart: opts?.coldStart,
			});
		}
		this.broadcastQueue(session);
		return { status: "queued" };
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
	 * Admit a verifier turn as one durable queue row and return a receipt for
	 * that exact row. Unlike `enqueuePrompt`, this never turns an accepted
	 * verifier intent into a separate direct dispatch, so recovery retains the
	 * same ID and cancellation cannot target an equal-text neighbour.
	 */
	enqueueVerifierPrompt(sessionId: string, text: string, opts?: {
		coldStart?: boolean;
		streamingBehavior?: PromptStreamingBehavior;
		suppressTitleGen?: boolean;
	}): VerifierPromptReceipt {
		this._assertModelSelectionReady(sessionId);
		// Replacement owns one durable acceptance queue while the live map may
		// briefly contain a successor or no session at all. Attach this receipt to
		// that owner so reconciliation carries the same row ID forward.
		const session = this._promptQueueOwner(sessionId);
		if (!session) {
			const rowId = randomUUID();
			const receipt = this.createVerifierPromptReceipt(sessionId, rowId, "queued");
			this.settleVerifierPromptReceipt(sessionId, rowId, new Error(`Verifier session ${sessionId} is unavailable`));
			return receipt;
		}
		const direct = session.status === "idle"
			&& session.promptQueue.isEmpty
			&& !session.isCompacting
			&& !this._sessionReplacementCoordinators.has(sessionId);
		// Verification is server-owned work: mint its occurrence before the queue
		// reaches persistence so restart/reconnect cannot turn it into a transcript
		// fallback.
		const row = this.makeReliableIntentRow(session, randomUUID(), text, "prompt", "next-turn", {
			source: "verification",
			author: BOBBIT_SYSTEM_AUTHOR,
			streamingBehavior: opts?.streamingBehavior ?? "followUp",
			coldStart: opts?.coldStart,
			suppressTitleGen: opts?.suppressTitleGen ?? true,
		});
		row.verifierOwned = true;
		this.enqueueReliableIntent(session, row);
		const receipt = this.createVerifierPromptReceipt(sessionId, row.id, direct ? "direct" : "queued");
		this.broadcastQueue(session);

		// A terminal retry cap must not silently consume this step's full active
		// allowance. Busy contention is a narrow transient infrastructure signal;
		// keep the row durable for cancellation/inspection but settle this receipt
		// promptly so verification can apply its bounded retry policy.
		if (session.lastTurnErrored
			&& (session.consecutiveErrorTurns ?? 0) >= MAX_CONSECUTIVE_ERROR_TURNS
			&& isReviewerBusyError(session.lastTurnErrorMessage || "")) {
			this.abandonVerifierPrompt(sessionId, row.id, new Error(`Verifier prompt parked after reviewer contention: ${session.lastTurnErrorMessage}`));
			return receipt;
		}
		if (session.status === "idle" && !session.isCompacting && !this._sessionReplacementCoordinators.has(sessionId)) this.drainQueue(session);
		return receipt;
	}

	/** Cancel one verifier receipt and remove its still-durable row, if any. */
	cancelVerifierPrompt(sessionId: string, rowId: string): boolean {
		const receipts = this._getVerifierPromptReceipts()?.get(sessionId);
		const pending = receipts?.get(rowId);
		if (!pending) return false;
		pending.cancelled = true;
		const removed = this.removeVerifierPromptRow(sessionId, rowId);
		this.settleVerifierPromptReceipt(sessionId, rowId);
		return removed;
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
		/** Trusted server-resolved author. Browser clients cannot set this field. */
		author?: MessageAuthor;
		/** Dispatch against a possibly-cold (freshly-restored) agent: the direct
		 *  dispatch waits for readiness and uses a generous prompt timeout via
		 *  RpcBridge.promptWhenReady, so the boot-resume nudge actually lands
		 *  instead of timing out on the default 30s. */
		coldStart?: boolean;
		/** Pi atomic delivery mode. `followUp` appends to an active SDK turn
		 * rather than rejecting this accepted intent as "already processing". */
		streamingBehavior?: PromptStreamingBehavior;
		/** When true, this prompt must NOT trigger first-message auto-title
		 *  generation. Set for assistant auto-kickoff prompts so naming fires on
		 *  the first GENUINE user message rather than the kickoff text. Does NOT
		 *  mark the session titleGenerated, so the next real prompt still names it. */
		suppressTitleGen?: boolean;
		/** Browser-created stable occurrence identity. Legacy/server callers may omit it. */
		intentId?: string;
		/** Keep this reliable occurrence queued unless the canonical goal is runnable. */
		goalDispatchGuardId?: string;
	}): Promise<{ status: "dispatched" | "queued" }> {
		// This guard is deliberately before replacement queue admission: a conditioned
		// session must not create queue/transcript/sidecar/persistence/RPC state. During
		// recovery the coordinator's promptOwner remains the conditioned capsule until
		// the verified replacement commits and ownership is released.
		this._assertModelSelectionReady(sessionId);

		// Replacement ownership is the first ordinary dispatch fence — before
		// poison/error classification, revive logic, or any RPC. Every prompt accepted
		// while a bridge is staged is persisted exactly once and released only after
		// the final coordinated replacement commits or rolls back.
		const staged = this._queuePromptBehindReplacement(sessionId, text, opts);
		if (staged) return staged;

		// An in-place poison respawn temporarily removes SessionInfo. Join before
		// looking it up so prompts arriving in that window are not silently lost.
		// If the shared replacement fails, this is a distinct accepted follow-up,
		// not a duplicate Retry click: durably park it on the rollback capsule and
		// report that acceptance as queued so the caller does not resubmit it.
		const poisonRecovery = this._poisonedHistoryRecoveries.get(sessionId);
		if (poisonRecovery) {
			try {
				await poisonRecovery;
			} catch (err) {
				const rollback = this.sessions.get(sessionId);
				if (!rollback) throw err;
				// A replay of the browser occurrence must resolve against the rollback
				// capsule before appending its display envelope. Otherwise the rejected
				// shared recovery can create a second sidecar row even when queue admission
				// itself is idempotent.
				if (opts?.intentId) {
					const duplicate = this.reliableIntentById(rollback, opts.intentId);
					if (duplicate || this.reliableIntentWasSettled(rollback, opts.intentId)) {
						return { status: duplicate && (duplicate as ReliableQueuedMessage).deliveryState === "queued" ? "queued" : "dispatched" };
					}
				}
				const source = opts?.source ?? "user";
				const author = resolveAcceptedPromptAuthor(source, opts?.author);
				rollback.lastPromptSource = source;
				const dispatchText = synthesizeAttachmentText(opts?.modelText ?? text, opts?.images, opts?.attachments);
				const hasSkillExpansions = !!opts?.skillExpansions?.length;
				const hasFileMentions = !!opts?.fileMentions?.length;
				if (hasSkillExpansions || hasFileMentions) {
					const recordId = appendIdentifiedSkillSidecarEntry(sessionId, {
						ts: this.clock.now(),
						modelText: dispatchText,
						originalText: text,
						skillExpansions: opts?.skillExpansions ?? [],
						...(hasFileMentions ? { fileMentions: opts!.fileMentions! } : {}),
					});
					if (!rollback.pendingSkillExpansions) rollback.pendingSkillExpansions = [];
					rollback.pendingSkillExpansions.push({
						modelText: dispatchText,
						originalText: text,
						skillExpansions: opts?.skillExpansions ?? [],
						...(hasFileMentions ? { fileMentions: opts!.fileMentions! } : {}),
						...(recordId ? { recordId } : {}),
					});
				}
				if (opts?.intentId) {
					this.enqueueReliableIntent(rollback, this.makeReliableIntentRow(
						rollback,
						opts.intentId,
						dispatchText,
						opts.isSteered ? "steer" : "prompt",
						"next-turn",
						{
							images: opts.images,
							attachments: opts.attachments,
							suppressTitleGen: opts.suppressTitleGen,
							streamingBehavior: opts.streamingBehavior,
							coldStart: opts.coldStart,
							goalDispatchGuardId: opts.goalDispatchGuardId,
							source,
							author,
						},
					));
				} else {
					rollback.promptQueue.enqueue(dispatchText, {
						images: opts?.images,
						attachments: opts?.attachments,
						isSteered: opts?.isSteered,
						suppressTitleGen: opts?.suppressTitleGen,
						source,
						author,
						streamingBehavior: opts?.streamingBehavior,
						coldStart: opts?.coldStart,
					});
				}
				this.broadcastQueue(rollback);
				return { status: "queued" };
			}
			return this.enqueuePrompt(sessionId, text, opts);
		}
		let session = this.sessions.get(sessionId);
		if (!session) return { status: "queued" };
		let recoveredPoisonDuringRevive = false;
		let revivedPoisonQueueIds: string[] | undefined;
		let revivedPoisonOwnedQueueIds: string[] | undefined;
		let revivedPoisonPromptEnvelopes: SessionInfo["pendingSkillExpansions"];
		let revivedSessionOnlyGrantedTools: string[] | undefined;
		let revivedOneTimeGrantedTools: string[] | undefined;

		// REVIVE-WINDOW JOIN (CS-R2 follow-up). A prompt that arrives while the
		// session is dormant/terminated/fenced — or while an `addClient` dormant
		// revive (or any other restore) is already in flight — must NOT be queued on
		// the stale `SessionInfo`. The coalesced restore replaces that object with a
		// fresh one (new PromptQueue(ps.messageQueue), new EventBuffer), so a row
		// queued here would be dropped and never dispatched (doc-04 F2e split-brain /
		// F7 stranded-prompt shape). Instead, JOIN the coalesced restore (it starts
		// one or joins the in-flight one), then re-read the canonical revived session
		// and dispatch against it via the normal path below.
		const restoreCoordinator = this._sessionReplacementCoordinators.get(sessionId);
		const restoreInFlight = !!restoreCoordinator;
		const inReviveWindow = restoreInFlight
			|| session.status === "terminated"
			|| session.dormant === true
			|| session.lifecycleFenced === true;
		if (inReviveWindow) {
			const poisonedDormant = isOrphanToolResultOrderingError(session.lastTurnErrorMessage);
			if (poisonedDormant) {
				revivedPoisonQueueIds = session.recoveredPromptDispatchQueueIds?.slice();
				revivedPoisonOwnedQueueIds = session.poisonRecoveryPromptDispatchQueueIds?.slice();
				revivedPoisonPromptEnvelopes = session.pendingSkillExpansions?.slice();
				revivedSessionOnlyGrantedTools = session.sessionOnlyGrantedTools?.slice();
				revivedOneTimeGrantedTools = session.oneTimeGrantedTools?.slice();
			}
			const ps = this.resolveStoreForId(sessionId)?.get(sessionId);
			if (ps && ps.agentSessionFile) {
				// A failed poison respawn leaves the old object as a rollback capsule;
				// revive it in place to carry clients and process-local intent forward.
				// Other dormant restores retain the existing cold-restore path.
				if (restoreInFlight) {
					await restoreCoordinator?.tail;
				} else if (poisonedDormant) {
					const overrideAllowedTools = this.recomputeAllowedToolsForRestart(session, ps);
					await this._respawnAgentInPlace(session, ps, {
						preserveSandboxRealm: session.sandboxed === true,
						deferQueueDrain: true,
						mutatePs: p => {
							if (overrideAllowedTools !== undefined) (p as any)._overrideAllowedTools = overrideAllowedTools;
							if (revivedSessionOnlyGrantedTools !== undefined) (p as any)._overrideGrantedTools = revivedSessionOnlyGrantedTools;
						},
					});
				} else {
					await this._restoreSessionCoalesced(ps);
				}
				const revived = this.sessions.get(sessionId);
				if (!revived) return { status: "queued" };
				session = revived;
				recoveredPoisonDuringRevive = poisonedDormant;
				if (revivedSessionOnlyGrantedTools !== undefined) {
					session.sessionOnlyGrantedTools = revivedSessionOnlyGrantedTools;
				}
				if (revivedOneTimeGrantedTools !== undefined) {
					session.oneTimeGrantedTools = revivedOneTimeGrantedTools;
				}
				if (revivedPoisonPromptEnvelopes?.length) {
					session.pendingSkillExpansions = [
						...revivedPoisonPromptEnvelopes,
						...(session.pendingSkillExpansions ?? []),
					];
				}
			} else if (restoreInFlight) {
				// No restorable record of our own, but a replacement is already running for
				// this session — join it rather than acting on the stale object.
				await restoreCoordinator?.tail;
				const revived = this.sessions.get(sessionId);
				if (!revived) return { status: "queued" };
				session = revived;
			}
			// Otherwise (terminated/dormant with no restorable transcript): fall
			// through to the existing non-idle path, which queues on the current
			// object — unchanged behavior for genuinely unrevivable sessions.
		}

		const source = opts?.source ?? "user";
		const author = resolveAcceptedPromptAuthor(source, opts?.author);
		session.lastPromptSource = source;

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
		// A caller-provided ID always owns its occurrence. Server-originated calls
		// and compaction admissions mint one; retain only the historical idle
		// no-options local path.
		const reliableIntentId = opts?.intentId ?? (opts?.source !== undefined || session.isCompacting ? randomUUID() : undefined);
		if (reliableIntentId) {
			const duplicate = this.reliableIntentById(session, reliableIntentId);
			if (duplicate || this.reliableIntentWasSettled(session, reliableIntentId)) {
				return { status: duplicate && (duplicate as ReliableQueuedMessage).deliveryState === "queued" ? "queued" : "dispatched" };
			}
		}
		const hasSkillExpansions = !!(opts?.skillExpansions && opts.skillExpansions.length > 0);
		const hasFileMentions = !!(opts?.fileMentions && opts.fileMentions.length > 0);
		if (hasSkillExpansions || hasFileMentions) {
			const recordId = appendIdentifiedSkillSidecarEntry(session.id, {
				ts: this.clock.now(),
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
				...(recordId ? { recordId } : {}),
			});
		}

		// Stable-ID admission has one durable boundary: persist the exact occurrence
		// before any Pi RPC, even when the session currently appears idle.
		if (reliableIntentId) {
			// A failed poison repair leaves its initiating occurrence on the rollback
			// capsule. Reattach that exact ownership before accepting this later
			// follow-up: it must remain a separate durable row, not be replaced by
			// this fresh occurrence or inferred from matching text.
			if (recoveredPoisonDuringRevive) {
				if (revivedPoisonQueueIds?.length) {
					session.recoveredPromptDispatchQueueIds = revivedPoisonQueueIds;
				}
				if (revivedPoisonOwnedQueueIds?.length) {
					session.poisonRecoveryPromptDispatchQueueIds = revivedPoisonOwnedQueueIds;
				}
				if (revivedPoisonQueueIds?.length) this.consumeRecoveredPromptDispatchRows(session);
			}
			const kind = opts?.isSteered ? "steer" : "prompt";
			const targetTurn: DeliveryTargetTurn = kind === "steer"
				&& session.status === "streaming"
				&& (!session.isCompacting || session._reliableCompactionReason !== "manual")
				? "continuation"
				: "next-turn";
			const accepted = this.makeReliableIntentRow(session, reliableIntentId, dispatchText, kind, targetTurn, {
				images: opts?.images,
				attachments: opts?.attachments,
				suppressTitleGen: opts?.suppressTitleGen,
				streamingBehavior: opts?.streamingBehavior,
				coldStart: opts?.coldStart,
				goalDispatchGuardId: opts?.goalDispatchGuardId,
				source,
				author,
			});
			this.enqueueReliableIntent(session, accepted);
			this.broadcastQueue(session);
			if (session.isCompacting || session.status === "aborting" || (this._sessionReplacementCoordinators?.has(session.id) ?? false)) {
				return { status: "queued" };
			}
			if (targetTurn === "continuation" && session.status === "streaming") {
				await this._dispatchSteer(session, [accepted]);
				return { status: "dispatched" };
			}
			if (session.status === "idle" && session.lastTurnErrored) {
				const consecutiveErrors = session.consecutiveErrorTurns ?? 0;
				this.cancelPendingAutoRetry(session, "new-prompt");

				// Orphan tool-result history cannot be repaired by parking another
				// prompt on the poisoned bridge. Browser-created stable-ID intents must
				// take the same sanitizer/respawn path as legacy callers before the
				// generic consecutive-error cap is applied.
				if (isOrphanToolResultOrderingError(session.lastTurnErrorMessage)) {
					this.markPoisonRecoveryPromptDispatchRow(session, accepted.id);
					const recovered = await this._recoverPoisonedHistory(session, "follow-up", async (target) => {
						target.lastTurnErrored = false;
						target.lastTurnErrorMessage = undefined;
						target.turnHadToolCalls = false;
						target.transientRetryAttempts = 0;
						target.lastPromptSource = source;
						if (!opts?.suppressTitleGen) this.tryGenerateTitleFromPrompt(sessionId, text);
						try {
							await this.dispatchDirectPrompt(target, dispatchText, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart, source, author, accepted.id, accepted.id, opts?.streamingBehavior, false, false, opts?.suppressTitleGen);
						} catch (error) {
							target.lastTurnErrored = true;
							target.lastTurnErrorMessage = error instanceof Error ? error.message : String(error);
							throw error;
						}
						this.consumeRecoveredPromptDispatchRows(target);
					});
					if (!recovered && this.sessions.has(session.id)) {
						throw new Error(`Session ${session.id} has poisoned history but no persisted transcript to repair`);
					}
					return { status: "dispatched" };
				}

				if (consecutiveErrors >= MAX_CONSECUTIVE_ERROR_TURNS) return { status: "queued" };

				const errorSnippet = (session.lastTurnErrorMessage || "").slice(0, 200);
				const poisonedByBlankText = isBlankContentBlockError(session.lastTurnErrorMessage);
				this.consumeRecoveredPromptDispatchRows(session);
				session.lastTurnErrored = false;
				session.lastTurnErrorMessage = undefined;
				this.setManualRetryRequired(session, false);
				session.turnHadToolCalls = false;
				session.transientRetryAttempts = 0;
				if (!opts?.suppressTitleGen) this.tryGenerateTitleFromPrompt(sessionId, text);
				if (poisonedByBlankText) {
					const recovered = await this._recoverBlankTextPoison(session);
					if (recovered) {
						const recoverText = dispatchText.trim() === "" ? ATTACHMENT_ONLY_TEXT : dispatchText;
						await this.dispatchDirectPrompt(recovered, recoverText, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart, source, author, accepted.id, accepted.id, opts?.streamingBehavior, false, false, opts?.suppressTitleGen);
						return { status: "dispatched" };
					}
				}
				const prefixedDispatch = buildErrorRecoveryPrefix(errorSnippet, dispatchText);
				const settlementFenced = session._piAgentRunSettled === false;
				await this.dispatchDirectPrompt(session, prefixedDispatch, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart, source, author, accepted.id, accepted.id, opts?.streamingBehavior, false, false, opts?.suppressTitleGen);
				return { status: settlementFenced ? "queued" : "dispatched" };
			}
			if (session.status === "idle") {
				// A later follow-up reviving a failed poison repair has its own accepted
				// occurrence. Dispatch it by ID, leaving the failed repair occurrence
				// durably queued for its later, independent lifecycle. Generic queue
				// draining would choose the older row and silently make this call appear
				// to have replaced it.
				if (recoveredPoisonDuringRevive && session._piAgentRunSettled !== false) {
					if (!opts?.suppressTitleGen) this.tryGenerateTitleFromPrompt(sessionId, text);
					await this.dispatchDirectPrompt(
						session,
						dispatchText,
						opts?.images,
						opts?.attachments,
						!!opts?.isSteered,
						!!opts?.coldStart,
						source,
						author,
						accepted.id,
						accepted.id,
						opts?.streamingBehavior,
						false,
						false,
						opts?.suppressTitleGen,
					);
					return { status: "dispatched" };
				}
				// Preserve the historical direct-call contract when this accepted
				// occurrence is the sole idle item: callers receive a definite
				// pre-admission rejection while the exact reliable row still owns
				// recovery. Otherwise the lane-aware drain retains FIFO ordering.
				if (session._piAgentRunSettled !== false
					&& session.promptQueue.length === 1
					&& session.promptQueue.peek()?.id === accepted.id) {
					if (!opts?.suppressTitleGen) this.tryGenerateTitleFromPrompt(sessionId, text);
					await this.dispatchDirectPrompt(
						session,
						dispatchText,
						opts?.images,
						opts?.attachments,
						!!opts?.isSteered,
						!!opts?.coldStart,
						source,
						author,
						accepted.id,
						accepted.id,
						opts?.streamingBehavior,
						false,
						false,
						opts?.suppressTitleGen,
					);
				} else {
					this.drainQueue(session);
				}
				return { status: "dispatched" };
			}
			return { status: "queued" };
		}

		// A previous poison-repair attempt may have failed after killing the old
		// bridge and left this same session dormant. The revive above already loaded
		// the sanitized history into a fresh process, so dispatch this follow-up
		// ahead of parked rows without respawning a second time. Give the accepted
		// intent the same durable poison ownership as the primary recovery path:
		// a pre-observation RPC rejection must preserve this exact row for eventual
		// drain rather than turn it into an ordinary, supersedable dispatch copy.
		if (recoveredPoisonDuringRevive) {
			if (revivedPoisonQueueIds?.length) {
				session.recoveredPromptDispatchQueueIds = revivedPoisonQueueIds;
				session.poisonRecoveryPromptDispatchQueueIds = revivedPoisonOwnedQueueIds;
				this.consumeRecoveredPromptDispatchRows(session);
			}
			const accepted = session.promptQueue.enqueue(dispatchText, {
				images: opts?.images,
				attachments: opts?.attachments,
				isSteered: opts?.isSteered,
				suppressTitleGen: opts?.suppressTitleGen,
				source,
				author,
				streamingBehavior: opts?.streamingBehavior,
			});
			this.markPoisonRecoveryPromptDispatchRow(session, accepted.id);
			this.broadcastQueue(session);
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.turnHadToolCalls = false;
			session.transientRetryAttempts = 0;
			session.lastPromptSource = opts?.source ?? "user";
			if (!opts?.suppressTitleGen) this.tryGenerateTitleFromPrompt(sessionId, text);
			await this.dispatchDirectPrompt(
				session,
				dispatchText,
				opts?.images,
				opts?.attachments,
				!!opts?.isSteered,
				!!opts?.coldStart,
				source,
				author,
				accepted.id,
				undefined,
				opts?.streamingBehavior,
				undefined,
				false,
				opts?.suppressTitleGen,
			);
			return { status: "dispatched" };
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

			// Anthropic orphan tool-result ordering poison cannot be unstuck by
			// sending another prompt to Pi's current in-memory history. Recover it
			// before the generic error cap so a normal follow-up is itself the
			// user-driven redrive, ahead of already parked queue rows.
			if (isOrphanToolResultOrderingError(session.lastTurnErrorMessage)) {
				const inFlight = this._poisonedHistoryRecoveries.get(session.id);
				if (inFlight) {
					await inFlight;
					return this.enqueuePrompt(sessionId, text, opts);
				}

				// Persist the initiating follow-up before replacement starts. Prompts that
				// arrive behind it use the coordinator's entry fence, preserving acceptance
				// order even if startup fails. On success only this exact row is removed and
				// dispatched ahead of older parked work.
				const accepted = session.promptQueue.enqueue(dispatchText, {
					images: opts?.images,
					attachments: opts?.attachments,
					isSteered: opts?.isSteered,
					suppressTitleGen: opts?.suppressTitleGen,
					source,
					author,
					streamingBehavior: opts?.streamingBehavior,
				});
				this.markPoisonRecoveryPromptDispatchRow(session, accepted.id);
				this.broadcastQueue(session);
				const recovery = (async () => {
					const recovered = await this._recoverPoisonedHistory(session, "follow-up", async (target) => {
						target.lastTurnErrored = false;
						target.lastTurnErrorMessage = undefined;
						target.turnHadToolCalls = false;
						target.transientRetryAttempts = 0;
						target.lastPromptSource = opts?.source ?? "user";
						if (!opts?.suppressTitleGen) this.tryGenerateTitleFromPrompt(sessionId, text);
						try {
							await this.dispatchDirectPrompt(target, dispatchText, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart, source, author, accepted.id, undefined, opts?.streamingBehavior, undefined, false, opts?.suppressTitleGen);
						} catch (err) {
							target.lastTurnErrored = true;
							target.lastTurnErrorMessage = err instanceof Error ? err.message : String(err);
							throw err;
						}
						// A new follow-up supersedes recovered copies of the failed old turn,
						// but only after the new intent was accepted by the canonical bridge.
						this.consumeRecoveredPromptDispatchRows(target);
					});
					if (!recovered && this.sessions.has(session.id)) {
						throw new Error(`Session ${session.id} has poisoned history but no persisted transcript to repair`);
					}
				})();
				this._poisonedHistoryRecoveries.set(session.id, recovery);
				try {
					await recovery;
				} finally {
					if (this._poisonedHistoryRecoveries.get(session.id) === recovery) {
						this._poisonedHistoryRecoveries.delete(session.id);
					}
				}
				return { status: "dispatched" };
			}

			if (consec >= MAX_CONSECUTIVE_ERROR_TURNS) {
				// Cap reached — park. Human must click Retry (or fix upstream) to drain.
				console.log(
					`[session-manager] Session ${session.id} has ${consec} consecutive errored turns; parking incoming prompt. Human action required (click Retry or fix upstream issue).`
				);
				session.promptQueue.enqueue(dispatchText, {
					images: opts?.images,
					attachments: opts?.attachments,
					isSteered: opts?.isSteered,
					suppressTitleGen: opts?.suppressTitleGen,
					source,
					author,
					streamingBehavior: opts?.streamingBehavior,
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

			// A fresh prompt supersedes ordinary recovered dispatch-time copies of
			// the failed prompt. A poison-repair row is different: Bobbit already
			// accepted it as a manual recovery action, so it remains durable until Pi
			// accepts it and drains exactly once after this follow-up succeeds.
			this.consumeRecoveredPromptDispatchRows(session);

			// Clear error state. Do NOT reset consecutiveErrorTurns — that only
			// resets on a SUCCESSFUL message_end or an explicit retryLastPrompt.
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			this.setManualRetryRequired(session, false);
			session.turnHadToolCalls = false;
			session.transientRetryAttempts = 0;

			// Title generation uses the user-visible original text (better UX).
			// Skip for suppressed kickoff prompts so naming fires on the first
			// genuine user message instead.
			if (!opts?.suppressTitleGen) this.tryGenerateTitleFromPrompt(sessionId, text);

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
					await this.dispatchDirectPrompt(recovered, recoverText, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart, source, author, undefined, undefined, opts?.streamingBehavior, undefined, false, opts?.suppressTitleGen);
					return { status: "dispatched" };
				}
			}

			// Dispatch the prefixed new message immediately, ahead of any parked
			// items. After agent_end the normal drainQueue path picks up parked
			// items in FIFO order, unprefixed (since lastTurnErrorMessage is now
			// cleared).
			// Inject the recovery prefix into the model-facing dispatch text.
			const prefixedDispatch = buildErrorRecoveryPrefix(errSnippet, dispatchText);
			const settlementFenced = session._piAgentRunSettled === false;
			await this.dispatchDirectPrompt(session, prefixedDispatch, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart, source, author, undefined, undefined, opts?.streamingBehavior, undefined, false, opts?.suppressTitleGen);
			return { status: settlementFenced ? "queued" : "dispatched" };
		}

		// If agent is idle and queue is empty, dispatch directly. Mark streaming
		// before awaiting rpcClient.prompt(): Pi 0.77 OpenAI/Codex preflight can be
		// slow, and clients/API polling must see the turn as in-flight immediately.
		if (session.status === "idle" && session._piAgentRunSettled !== false && session.promptQueue.isEmpty) {
			if (!opts?.suppressTitleGen) this.tryGenerateTitleFromPrompt(sessionId, text);
			await this.dispatchDirectPrompt(session, dispatchText, opts?.images, opts?.attachments, !!opts?.isSteered, !!opts?.coldStart, source, author, undefined, undefined, opts?.streamingBehavior, undefined, false, opts?.suppressTitleGen);
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
			suppressTitleGen: opts?.suppressTitleGen,
			source,
			author,
			streamingBehavior: opts?.streamingBehavior,
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
	deliverLiveSteer(sessionId: string, message: string, opts?: { source?: PromptSource; author?: MessageAuthor; intentId?: string }): Promise<unknown> {
		try {
			this._assertModelSelectionReady(sessionId);
		} catch (error) {
			return Promise.reject(error);
		}
		// Replacement ownership precedes continuation classification. A clear-time
		// steer is always durable successor work and can never reach the old Pi run.
		const staged = this._queuePromptBehindReplacement(sessionId, message, {
			isSteered: true,
			source: opts?.source,
			author: opts?.author,
			intentId: opts?.intentId,
		});
		if (staged) return Promise.resolve({ queued: true, id: opts?.intentId });
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.reject(new Error(`Session ${sessionId} not found`));
		const source = opts?.source ?? "user";
		const author = resolveAcceptedPromptAuthor(source, opts?.author);
		session.lastPromptSource = source;

		// Every source-identified live steer carries a durable occurrence before
		// its RPC can create an in-flight recovery record. Compaction has the same
		// durable boundary even for historical no-options callers.
		const reliableIntentId = opts?.intentId ?? (opts?.source !== undefined || session.isCompacting ? randomUUID() : undefined);

		// Error recovery owns admission before a reliable row can enter the live
		// steer drain. Route through enqueuePrompt so its cap parking, timer
		// cancellation, prefixing, and direct prompt dispatch keep this exact ID.
		if (session.lastTurnErrored) {
			return this.enqueuePrompt(sessionId, message, {
				isSteered: true,
				source,
				author,
				intentId: reliableIntentId,
			});
		}

		if (reliableIntentId) {
			const duplicate = this.reliableIntentById(session, reliableIntentId);
			if (duplicate || this.reliableIntentWasSettled(session, reliableIntentId)) {
				return Promise.resolve({ queued: !!duplicate, duplicate: true, settled: !duplicate, id: reliableIntentId });
			}
			const targetTurn: DeliveryTargetTurn = session.status === "streaming"
				&& (!session.isCompacting || session._reliableCompactionReason !== "manual")
				? "continuation"
				: "next-turn";
			const queued = this.makeReliableIntentRow(session, reliableIntentId, message, "steer", targetTurn, { source, author });
			this.enqueueReliableIntent(session, queued);
			this.broadcastQueue(session);
			if (session.isCompacting || session.status === "aborting" || (this._sessionReplacementCoordinators?.has(session.id) ?? false)) {
				return Promise.resolve({ queued: true, id: queued.id });
			}
			if (targetTurn === "continuation" && session.status === "streaming") return this._dispatchSteer(session, [queued]);
			if (session.status === "idle") this.drainQueue(session);
			return Promise.resolve({ queued: true, id: queued.id });
		}

		// Happy path: enqueue then dispatch via the single _dispatchSteer site.
		// _dispatchSteer removes the row from promptQueue *before* awaiting the
		// RPC and persists an in-flight ledger for restart durability until echo.
		const queued = session.promptQueue.enqueue(message, { isSteered: true, source, author });
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
		const coordinator = this._sessionReplacementCoordinators.get(sessionId);
		const session = coordinator?.promptOwner ?? this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.steer(messageId);
		if (!ok) return false;

		const promoted = (session.promptQueue.toArray() as ReliableQueuedMessage[]).find((row) => row.id === messageId);
		if (promoted?.kind) {
			promoted.kind = "steer";
			promoted.targetTurn = !coordinator
				&& session.status === "streaming"
				&& (!session.isCompacting || session._reliableCompactionReason !== "manual")
				? "continuation"
				: "next-turn";
		}
		if (coordinator) {
			this.broadcastQueue(session);
			return true;
		}
		if (session.status === "streaming" && !session.isCompacting) {
			const steered = (session.promptQueue.toArray() as ReliableQueuedMessage[])
				.filter((row) => row.isSteered && (row.targetTurn ?? "continuation") === "continuation");
			void this._dispatchSteer(session, steered).catch(() => {});
			return true;
		}

		this.broadcastQueue(session);
		if (session.status === "idle") this.drainQueue(session);
		return true;
	}

	private preparePromptAuthorDispatch(
		session: SessionInfo,
		promptId: string,
		baseModelText: string,
		source: PromptSource,
		author: MessageAuthor,
		intentId?: string,
		attempt?: Pick<ReliableQueuedMessage, "attemptId" | "dispatchEpoch">,
	): PreparedPromptAuthorDispatch {
		return preparePromptAuthorDispatch(
			session,
			promptId,
			baseModelText,
			source,
			author,
			this.clock.now(),
			intentId === undefined ? undefined : {
				intentId,
				...(attempt?.attemptId === undefined ? {} : { attemptId: attempt.attemptId }),
				...(attempt?.dispatchEpoch === undefined ? {} : { dispatchEpoch: attempt.dispatchEpoch }),
			},
		);
	}

	private cancelPromptAuthorDispatch(
		session: SessionInfo,
		prepared: PreparedPromptAuthorDispatch,
	): boolean {
		return cancelPromptAuthorBinding(session, prepared, this.clock.now());
	}

	private cancelRestoredPromptAuthorDispatch(
		session: SessionInfo,
		target: string | Pick<InFlightSteerRecord, "promptId" | "intentId" | "attemptId">,
	): boolean {
		if (cancelPromptAuthorBinding(session, target, this.clock.now())) return true;
		// A hard-abort synthetic agent_end can reconcile the durable steer ledger
		// before replacement hydration has rebuilt pendingPromptAuthors. Settle only
		// the exact modern attempt; legacy prompt ids keep their established fallback.
		const restored = selectLatestPromptAuthorBinding(readAuthorSidecar(session.id), (binding) => {
			if (binding.settlement !== undefined) return false;
			if (typeof target === "string") return binding.promptId === target;
			return binding.promptId === target.promptId
				&& (target.intentId === undefined || binding.intentId === target.intentId)
				&& (target.attemptId === undefined || binding.attemptId === target.attemptId);
		});
		if (!restored) return false;
		retainPromptAuthorAmbiguityFence(session, {
			promptId: restored.promptId,
			attemptId: restored.attemptId ?? restored.promptId,
			modelText: restored.modelText,
			modelTextDigest: restored.modelTextDigest,
			modelPrefix: restored.modelPrefix,
			author: restored.author,
		});
		return appendPromptAuthorSettlement(session.id, {
			schemaVersion: 2,
			type: "prompt-author-settlement",
			promptId: restored.promptId,
			...(restored.intentId === undefined ? {} : { intentId: restored.intentId }),
			...(restored.attemptId === undefined ? {} : { attemptId: restored.attemptId }),
			settledAt: this.clock.now(),
			outcome: "cancelled",
		});
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
	private async _dispatchLegacySteer(session: SessionInfo, rows: QueuedMessage[]): Promise<void> {
		const batchText = rows.map((row) => row.text).join("\n");
		const promptId = batchPromptId("steer", rows);
		const author = authorForSteerRows(rows);
		const source: PromptSource = author === BATCH_SYSTEM_AUTHOR
			? "system"
			: rows.every((row) => (row.source ?? "user") === (rows[0].source ?? "user"))
				? (rows[0].source ?? "user")
				: "system";
		const record: InFlightSteerRecord = { text: batchText, promptId, source, author };
		(session.inFlightSteerTexts ??= []).push(record);
		const prepared = this.preparePromptAuthorDispatch(session, promptId, batchText, source, author);
		for (const row of rows) session.promptQueue.remove(row.id);
		this.broadcastQueue(session);
		const activityBoundary = beginPreparedPromptActivity(session, prepared);
		try {
			const response = await session.rpcClient.steer(prepared.piText);
			if ((response as any)?.success === false) throw new Error((response as any).error || "steer rejected");
			if (acceptPreparedPromptDispatch(session, prepared, activityBoundary)
				&& !session.pendingPromptAuthors?.includes(prepared.pending)) {
				const index = session.inFlightSteerTexts.findIndex((candidate) => candidate === record);
				if (index !== -1) session.inFlightSteerTexts.splice(index, 1);
				this.broadcastQueue(session);
			}
		} catch (error) {
			if (activityBoundary?.state === "committed") return;
			const index = session.inFlightSteerTexts.findIndex((candidate) => candidate === record);
			if (index !== -1 && this.cancelPromptAuthorDispatch(session, prepared)) {
				session.inFlightSteerTexts.splice(index, 1);
				for (const row of [...rows].reverse()) {
					session.promptQueue.enqueueAtFront(row.text, {
						images: row.images,
						attachments: row.attachments,
						isSteered: true,
						source: row.source,
						author: row.author,
					});
				}
				this.broadcastQueue(session);
			}
			throw error;
		}
	}

	private async _dispatchSteer(session: SessionInfo, rows: QueuedMessage[]): Promise<void> {
		if (rows.length === 0) return;
		const exactRows = rows as ReliableQueuedMessage[];
		const retainRows = () => {
			for (const row of exactRows) {
				if (!this.reliableIntentById(session, row.id)) this.enqueueReliableIntent(session, row);
			}
			this.broadcastQueue(session);
		};
		if (session.isCompacting || session.status === "aborting" || (this._sessionReplacementCoordinators?.has(session.id) ?? false)) {
			retainRows();
			return;
		}
		if (rows.every((row) => (row as ReliableQueuedMessage).kind === undefined)) {
			return this._dispatchLegacySteer(session, rows);
		}

		const previous = session._reliableSteerDispatchTail ?? Promise.resolve();
		const work = previous.then(async () => {
			for (const rawRow of exactRows) {
				if (session.isCompacting || session.status === "aborting" || (this._sessionReplacementCoordinators?.has(session.id) ?? false)) {
					retainRows();
					return;
				}
				const row = rawRow as ReliableQueuedMessage;
				if (!this.goalDispatchGuardAllows(session, row)) {
					retainRows();
					return;
				}
				const active = (session.inFlightSteerTexts as ReliableInFlightRecord[] | undefined)
					?.find((record) => record.intentId === row.id);
				if (active) continue;
				const source = row.source ?? "user";
				const author = resolveAcceptedPromptAuthor(source, row.author);
				const prepared = this.preparePromptAuthorDispatch(session, row.id, row.text, source, author, row.id);
				const ledgerRecord: ReliableInFlightRecord = {
					text: row.text,
					promptId: row.id,
					intentId: row.id,
					attemptId: prepared.attemptId,
					dispatchEpoch: prepared.dispatchEpoch,
					state: "dispatching",
					targetTurn: row.targetTurn ?? "continuation",
					sequence: row.sequence,
					kind: "steer",
					createdAt: row.createdAt,
					retryable: false,
					source,
					author,
					images: row.images,
					attachments: row.attachments,
					suppressTitleGen: row.suppressTitleGen,
					goalDispatchGuardId: row.goalDispatchGuardId,
				};
				(session.inFlightSteerTexts ??= []).push(ledgerRecord);
				session.promptQueue.remove(row.id);
				this.broadcastQueue(session);
				const activityBoundary = beginPreparedPromptActivity(session, prepared);
				const bg = (this as any).bgProcessManager;
				if (bg) bg.abortAllWaits(session.id);
				let definiteRejection = false;
				try {
					const response = await session.rpcClient.steer(prepared.piText);
					if ((response as any)?.success === false) {
						definiteRejection = true;
						throw new Error((response as any)?.error || "steer rejected");
					}
					acceptPreparedPromptDispatch(session, prepared, activityBoundary);
					// RPC acknowledgement is deliberately not a settlement boundary. An
					// exact terminal sidecar written by an earlier correlated echo is.
					if (!this.pruneTerminalInFlightAttempt(session, row.id, prepared.attemptId)) {
						this.broadcastQueue(session);
					}
				} catch (error) {
					if (activityBoundary?.state === "committed") return;
					const index = (session.inFlightSteerTexts as ReliableInFlightRecord[]).indexOf(ledgerRecord);
					if (isPiCompactionActiveRejection(error)
						&& index !== -1
						&& ledgerRecord.state !== "received"
						&& this.cancelPromptAuthorDispatch(session, prepared)) {
						session.inFlightSteerTexts!.splice(index, 1);
						this.enqueueReliableIntent(session, {
							...row,
							deliveryState: "queued",
							deliveryReason: "compaction-active",
							deliveryError: undefined,
							retryable: false,
							attemptId: prepared.attemptId,
							dispatchEpoch: prepared.dispatchEpoch,
						}, { front: true });
						this.broadcastQueue(session);
						console.warn(`[session-manager] intent dispatch restored session=${session.id} intent=${row.id} attempt=${prepared.attemptId} outcome=compaction-active`);
						return;
					}
					if (definiteRejection) {
						if (index !== -1) session.inFlightSteerTexts!.splice(index, 1);
						this.cancelPromptAuthorDispatch(session, prepared);
						this.enqueueReliableIntent(session, {
							...row,
							deliveryState: "failed",
							retryable: true,
							deliveryError: "bridge-rejected",
							attemptId: prepared.attemptId,
							dispatchEpoch: prepared.dispatchEpoch,
						}, { front: true });
					} else if (index !== -1) {
						ledgerRecord.state = "uncertain";
						ledgerRecord.retryable = false;
					}
					this.broadcastQueue(session);
					console.error(`[session-manager] intent dispatch failed session=${session.id} intent=${row.id} attempt=${prepared.attemptId} outcome=${definiteRejection ? "failed" : "uncertain"}`);
					throw error;
				}
			}
		});
		session._reliableSteerDispatchTail = work.catch(() => undefined);
		return work;
	}

	/**
	 * Advance one exact attempt through Pi's user-message lifecycle. A modern
	 * message_start is receipt evidence, not terminal durability: keep the ledger
	 * reservation until message_end has an fsynced exact sidecar settlement.
	 */
	private _consumeSteerEcho(session: SessionInfo, event: any): void {
		if (event.type !== "message_start" && event.type !== "message_end") return;
		if (event.message?.role !== "user" && event.message?.role !== "user-with-attachments") return;
		const authorBinding = event[PROMPT_AUTHOR_EVENT_BINDING] as PromptAuthorEventBinding | undefined;
		if (authorBinding?.alreadySettled) return;
		const ledger = (session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[];
		const intentId = event.deliveryIntentId ?? event.message?.deliveryIntentId;
		const attemptId = event.deliveryAttemptId ?? event.message?.deliveryAttemptId ?? authorBinding?.attemptId;
		let idx = typeof intentId === "string" && typeof attemptId === "string"
			? ledger.findIndex((record) => record.intentId === intentId && record.attemptId === attemptId)
			: authorBinding?.attemptId
				? ledger.findIndex((record) => record.attemptId === authorBinding.attemptId)
				: -1;
		// Raw text is retained only for legacy records that predate occurrence IDs.
		// When author correlation identified a different occurrence, constrain the
		// compatibility fallback to that prompt instead of consuming a later
		// identical-text steer.
		if (idx === -1 && event.type === "message_end") {
			const text = extractUserMessageText(event.message);
			idx = ledger.findIndex((record) => !record.intentId
				&& record.text === text
				&& (!authorBinding || record.promptId === authorBinding.promptId));
		}
		if (idx === -1) return;
		const record = ledger[idx];
		if (record.intentId && record.attemptId) {
			if (event.type === "message_start") {
				if (record.state !== "received" || record.retryable !== false) {
					record.state = "received";
					record.retryable = false;
					this.broadcastQueue(session);
				}
				return;
			}
			const terminal = readAuthorSidecar(session.id).some((binding) =>
				binding.intentId === record.intentId
				&& binding.attemptId === record.attemptId
				&& binding.settlement?.outcome === "echoed");
			// Sidecar persistence is the terminal authority. Fail closed on append/read
			// failure by retaining the received carrier and its id reservation.
			if (!terminal) {
				if (record.state !== "received" || record.retryable !== false) {
					record.state = "received";
					record.retryable = false;
					this.broadcastQueue(session);
				}
				return;
			}
			ledger.splice(idx, 1);
			session.promptQueue.remove(record.intentId);
			this.broadcastQueue(session);
			return;
		}

		// Legacy ledgers have no occurrence tuple and retain terminal text fallback.
		if (event.type !== "message_end") return;
		ledger.splice(idx, 1);
		this.persistInFlightSteerLedger(session);
	}

	/**
	 * Reconcile unresolved steer attempts. Modern occurrences redrive only after
	 * authoritative replay proves no start; ambiguous terminals retain the ledger
	 * carrier. Legacy ledgers have no attempt barrier and keep their established
	 * restore/abort behavior.
	 */
	/** Mark only modern exact attempts ambiguous; legacy recovery stays at its established boundary. */
	private _markModernInFlightAttemptsUncertain(session: SessionInfo): boolean {
		let changed = false;
		for (const record of (session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[]) {
			if (record.intentId && (record.state !== "uncertain" || record.retryable !== false)) {
				record.state = "uncertain";
				record.retryable = false;
				changed = true;
			}
		}
		return changed;
	}

	private _reconcileInFlightSteers(
		session: SessionInfo,
		opts?: { outcome?: "ambiguous" | "proven-no-start"; retargetContinuation?: boolean },
	): void {
		const ledger = (session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[];
		if (opts?.outcome !== "proven-no-start") {
			let changed = false;
			for (const record of ledger) {
				if (record.intentId && (record.state !== "uncertain" || record.retryable !== false)) {
					record.state = "uncertain";
					record.retryable = false;
					changed = true;
				}
			}
			const legacy = ledger.filter((record) => !record.intentId);
			// Compatibility: old ledgers have no attempt barrier and retain their
			// established restart behavior. Modern occurrences fail closed uncertain.
			if (legacy.length > 0) {
				for (const record of [...legacy].reverse()) {
					this.cancelRestoredPromptAuthorDispatch(session, record.promptId);
					session.promptQueue.enqueueAtFront(record.text, { isSteered: true, source: record.source, author: record.author });
				}
				session.inFlightSteerTexts = ledger.filter((record) => !!record.intentId);
				changed = true;
			}
			if (changed) this.broadcastQueue(session);
			return;
		}

		// A received attempt has positive Pi-start evidence. Replay can prove that an
		// unreceived handoff never started, but it cannot negate a start Bobbit already
		// persisted merely because Pi crashed before its terminal message append.
		const recoverable = ledger.filter((record) => record.state !== "received");
		if (process.env.BOBBIT_DEBUG && recoverable.length > 0) {
			console.log(`[reliable-turn] reconcile session=${session.id} outcome=proven-no-start attempts=${recoverable.map((record) => record.intentId ?? record.promptId).join(",")}`);
		}
		for (const record of recoverable) this.cancelRestoredPromptAuthorDispatch(session, record);
		session.inFlightSteerTexts = ledger.filter((record) => !recoverable.includes(record));
		const recoveredRows = recoverable.map((record): ReliableQueuedMessage => {
			const intentId = record.intentId ?? record.promptId;
			const kind = record.kind ?? "steer";
			const originalTarget = record.targetTurn
				?? (record.intentId ? (kind === "steer" ? "continuation" : "next-turn") : "next-turn");
			return {
				id: intentId,
				text: record.text,
				isSteered: kind === "steer",
				createdAt: record.createdAt ?? record.dispatchEpoch ?? this.clock.now(),
				kind,
				targetTurn: originalTarget,
				sequence: record.sequence,
				deliveryState: "queued",
				deliveryReason: record.deliveryReason ?? "delivery-recovered",
				attemptId: record.attemptId,
				dispatchEpoch: record.dispatchEpoch,
				source: record.source,
				author: record.author,
				images: record.images,
				attachments: record.attachments,
				suppressTitleGen: record.suppressTitleGen,
				goalDispatchGuardId: record.goalDispatchGuardId,
			};
		});
		if (opts?.retargetContinuation === true) {
			session.promptQueue.retargetContinuationToNextTurn("continuation-aborted", recoveredRows);
		} else {
			for (const row of [...recoveredRows].reverse()) this.enqueueReliableIntent(session, row, { front: true });
		}
		this.broadcastQueue(session);
	}

	private _reconcileAfterAbort(
		session: SessionInfo,
		opts?: {
			outcome?: "ambiguous" | "proven-no-start";
			/** Stop always retargets work that never left the queue; this is independent of in-flight proof. */
			retargetQueuedContinuation?: boolean;
		},
	): void {
		const retargetQueuedContinuation = opts?.retargetQueuedContinuation
			?? (opts?.outcome === "proven-no-start");
		const consolidateProvenRestore = retargetQueuedContinuation
			&& opts?.outcome === "proven-no-start";
		if (retargetQueuedContinuation && !consolidateProvenRestore) {
			session.promptQueue.retargetContinuationToNextTurn("continuation-aborted");
		}
		this._reconcileInFlightSteers(session, {
			outcome: opts?.outcome,
			retargetContinuation: consolidateProvenRestore,
		});
		if (session._reliableCompactionReleaseDeferred && retargetQueuedContinuation) {
			session._reliableCompactionReleaseDeferred = false;
		}
	}

	/** Explicit fail-closed cancellation helper retained for administrative recovery. */
	_cancelAmbiguousInFlightAfterAbort(session: SessionInfo): void {
		const ledger = (session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[];
		const candidates = ledger.filter((record): record is ReliableInFlightRecord & { intentId: string; attemptId: string } =>
			!!record.intentId && !!record.attemptId);
		if (candidates.length === 0) return;
		const queue = session.promptQueue as any;
		for (const record of candidates) {
			const row: ReliableQueuedMessage = {
				id: record.intentId,
				text: record.text,
				isSteered: (record.kind ?? "steer") === "steer",
				createdAt: record.createdAt ?? record.dispatchEpoch ?? this.clock.now(),
				kind: record.kind ?? "steer",
				targetTurn: record.targetTurn ?? "continuation",
				sequence: record.sequence,
				deliveryState: "cancelled",
				deliveryReason: "abort-recovery-failed",
				retryable: false,
				attemptId: record.attemptId,
				dispatchEpoch: record.dispatchEpoch,
				source: record.source,
				author: record.author,
				images: record.images,
				attachments: record.attachments,
				suppressTitleGen: record.suppressTitleGen,
				goalDispatchGuardId: record.goalDispatchGuardId,
			};
			if (typeof queue.enqueueExisting === "function") queue.enqueueExisting(row);
			else {
				const inserted = session.promptQueue.enqueue(row.text, row);
				Object.assign(inserted, row);
			}
		}
		this.broadcastQueue(session);
		const cancelled = candidates.filter((record) => this.cancelRestoredPromptAuthorDispatch(session, record));
		const cancelledSet = new Set<ReliableInFlightRecord>(cancelled);
		for (const record of candidates) {
			if (!cancelledSet.has(record)) session.promptQueue.remove(record.intentId);
		}
		session.inFlightSteerTexts = ledger.filter((record) => !cancelledSet.has(record));
		this.broadcastQueue(session);
		for (const record of cancelled) {
			broadcast(session.clients, {
				type: "intent_update",
				sessionId: session.id,
				intent: {
					id: record.intentId,
					deliveryState: "cancelled",
					deliveryReason: "abort-recovery-failed",
					retryable: false,
				} as unknown as ReliableQueuedMessage,
			});
		}
	}

	private setManualRetryRequired(session: SessionInfo, required: boolean): void {
		if (session.manualRetryRequired === required) return;
		session.manualRetryRequired = required;
		// This is a recovery boundary, not a transient notification. Persist it
		// synchronously with the durable queue so restored authenticated clients
		// can still distinguish parked work from a healthy idle session.
		this.resolveStoreForSession(session.id).update(session.id, { manualRetryRequired: required });
	}

	private surfaceManualRetryRequired(session: SessionInfo): void {
		if (session.manualRetryRequired || session.promptQueue.length === 0) return;
		this.setManualRetryRequired(session, true);
		emitSessionEvent(session, {
			type: "manual_retry_required",
			message: "Queued work is parked because this turn failed. Manual Retry is required.",
			error: session.lastTurnErrorMessage?.slice(0, 200),
		});
	}

	/** Retry one definitely failed occurrence without changing its identity or lane. */
	retryIntent(sessionId: string, intentId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const active = (session.inFlightSteerTexts as ReliableInFlightRecord[] | undefined)
			?.some((record) => record.intentId === intentId);
		if (active) return false;
		const row = (session.promptQueue.toArray() as ReliableQueuedMessage[]).find((candidate) => candidate.id === intentId);
		if (!row || row.deliveryState !== "failed" || row.retryable === false) return false;
		row.deliveryState = "queued";
		row.deliveryReason = "retry-requested";
		row.retryable = false;
		delete row.deliveryError;
		// Keep the retired attempt tuple on the queued row until dispatch replaces
		// it with a newly persisted ledger transition. Compaction/Stop/restart can
		// otherwise mistake a stale terminal sidecar row for the Retry lifecycle.
		this.broadcastQueue(session);
		if (session.isCompacting || session.status === "aborting" || (this._sessionReplacementCoordinators?.has(session.id) ?? false)) return true;
		if (row.kind === "steer" && row.targetTurn === "continuation" && session.status === "streaming") {
			void this._dispatchSteer(session, [row]).catch(() => {});
		} else if (session.status === "idle") {
			this.drainQueue(session);
		}
		return true;
	}

	/** Reorder queued messages and the durable within-lane dispatch sequence. */
	reorderQueue(sessionId: string, messageIds: string[]): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.promptQueue.reorderByIds(messageIds, { resequenceReliableLanes: true });
		this.broadcastQueue(session);
	}

	/** Durably dismiss one queued occurrence, then converge every attached tab. */
	removeQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		let row = (session.promptQueue.toArray() as ReliableQueuedMessage[])
			.find((candidate) => candidate.id === messageId);
		const ledger = (session.inFlightSteerTexts ?? []) as ReliableInFlightRecord[];
		const uncertain = ledger.find((candidate) => candidate.intentId === messageId && candidate.state === "uncertain");
		if (!row && uncertain) {
			row = {
				id: messageId,
				text: uncertain.text,
				isSteered: (uncertain.kind ?? "steer") === "steer",
				createdAt: uncertain.createdAt ?? uncertain.dispatchEpoch ?? this.clock.now(),
				kind: uncertain.kind ?? "steer",
				targetTurn: uncertain.targetTurn ?? "continuation",
				sequence: uncertain.sequence,
				deliveryState: "uncertain",
				attemptId: uncertain.attemptId,
				dispatchEpoch: uncertain.dispatchEpoch,
				source: uncertain.source,
				author: uncertain.author,
			};
		}
		if (!row) return this.intentSettlement(sessionId, messageId) === "cancelled";
		if (!this.persistIntentCancellation(session, row)) return false;
		if (uncertain) {
			session.inFlightSteerTexts = ledger.filter((candidate) => candidate !== uncertain);
		} else if (!session.promptQueue.remove(messageId)) return false;
		this.broadcastQueue(session);
		broadcast(session.clients, {
			type: "intent_update",
			sessionId,
			intent: {
				id: row.id,
				deliveryState: "cancelled",
				deliveryReason: "dismissed",
				retryable: false,
			} as unknown as ReliableQueuedMessage,
			settlement: "cancelled",
		});
		return true;
	}

	private markPromptDispatchStreaming(session: SessionInfo): void {
		session.streamingStartedAt = session.streamingStartedAt ?? this.clock.now();
		this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
		broadcastStatus(session, "streaming", { streamingStartedAt: session.streamingStartedAt });
	}

	/** Roll back an optimistic prompt dispatch after Pi proves that no run opened. */
	private rollbackRejectedPromptDispatch(session: SessionInfo): void {
		// Stop/replacement or a later lifecycle transition owns every non-streaming
		// state. A late rejection may clean up its exact queue/sidecar attempt, but it
		// must not settle abort waiters or overwrite a newer status owner.
		if (session.status !== "streaming") return;
		session.streamingStartedAt = undefined;
		this.resolveStoreForSession(session.id).update(session.id, {
			wasStreaming: false,
			streamingStartedAt: undefined,
		});
		broadcastStatus(session, "idle");
		this.resolveIdleWaiters(session.id);
	}

	private async applyDirectProviderEnv(bridgeOptions: RpcBridgeOptions, sandboxed: boolean | undefined, provider?: string): Promise<void> {
		if (sandboxed) return;
		bridgeOptions.env = mergeHostAgentProviderEnv(bridgeOptions.env, this.preferencesStore, {
			provider,
			model: bridgeOptions.initialModel,
			providers: fallbackProviderAllowlistFromPrefs(this.preferencesStore),
		});
		await recoverAnthropicApiKeyRuntime(bridgeOptions.env, provider === "anthropic");
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
			this.surfaceManualRetryRequired(session);
			console.warn(`[session-manager] ${source} dispatch for ${session.id} exhausted retryable delivery auto-retries; leaving recovered row queued for manual Retry. Error: ${reason.slice(0, 200)}`);
		}
		return true;
	}

	private recoverPromptDispatch(session: SessionInfo, rows: Array<{
		id?: string;
		text: string;
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
		source?: PromptSource;
		verifierOwned?: boolean;
		author?: MessageAuthor;
		streamingBehavior?: PromptStreamingBehavior;
		coldStart?: boolean;
		suppressTitleGen?: boolean;
		goalDispatchGuardId?: string;
	}>, reason: string, source: string, durableQueueRowIds?: Array<string | undefined>, manualRecoveryRequired = false): void {
		if (!this._sessionWriterIsCurrent(session)) return;
		const providerAuthFailure = isProviderAuthFailure(reason);
		const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
		const safeReason = redactDispatchFailureReason(reason, providerAuthFailure, persistedProvider);
		const processExited = /(?:agent process exited|process_exit)/i.test(reason);
		if (session.status === "terminated" || (session.status === "aborting" && processExited)) {
			console.warn(`[session-manager] ${source} dispatch failed for ${session.id} (${safeReason}); not recovering ${rows.length} row(s) because session is ${session.status}`);
			this.abandonVerifierPromptDispatchRows(session, rows, durableQueueRowIds, this.safeDispatchError(session, reason));
			return;
		}

		console.warn(`[session-manager] ${source} dispatch failed for ${session.id} (${safeReason}); preserving ${rows.length} row(s) at front`);
		if (isReviewerBusyError(reason)) {
			for (const row of rows) {
				if (row.id && row.verifierOwned === true) this.markVerifierPromptBusyRecovered(session.id, row.id);
			}
		}
		// A coordinated poison redrive keeps its initiating row durable until the
		// bridge accepts the RPC. On rejection, reuse that exact row instead of
		// enqueueing a duplicate. Other dispatch paths retain the normal front
		// re-enqueue behavior. Reverse iteration because enqueueAtFront unshifts.
		const currentIds = new Set(session.promptQueue.toArray().map(row => row.id));
		const poisonOwnedIds = new Set(session.poisonRecoveryPromptDispatchQueueIds ?? []);
		const recoveredIds: string[] = [];
		for (let index = rows.length - 1; index >= 0; index--) {
			const durableId = durableQueueRowIds?.[index];
			if (durableId && currentIds.has(durableId)) {
				recoveredIds.push(durableId);
				continue;
			}
			const r = rows[index];
			const recovered = r.id
				? session.promptQueue.restoreAtFront({
					id: r.id,
					text: r.text,
					images: r.images,
					attachments: r.attachments,
					isSteered: r.isSteered ?? false,
					createdAt: this.clock.now(),
					source: r.source,
					verifierOwned: r.verifierOwned,
					author: r.author,
					streamingBehavior: r.streamingBehavior,
					coldStart: r.coldStart,
					suppressTitleGen: r.suppressTitleGen,
					goalDispatchGuardId: r.goalDispatchGuardId,
				})
				: session.promptQueue.enqueueAtFront(r.text, {
					images: r.images,
					attachments: r.attachments,
					isSteered: r.isSteered,
					source: r.source,
					verifierOwned: r.verifierOwned,
					author: r.author,
					streamingBehavior: r.streamingBehavior,
					coldStart: r.coldStart,
					suppressTitleGen: r.suppressTitleGen,
					goalDispatchGuardId: r.goalDispatchGuardId,
				});
			recoveredIds.push(recovered.id);
			if (durableId && poisonOwnedIds.has(durableId)) {
				const wasExplicitRetry = session.explicitRetryQueueRowId === durableId;
				this.clearRecoveredPromptDispatchOwnership(session, [durableId]);
				this.markPoisonRecoveryPromptDispatchRow(session, recovered.id);
				if (wasExplicitRetry) session.explicitRetryQueueRowId = recovered.id;
			}
		}
		if (recoveredIds.length > 0) {
			session.recoveredPromptDispatchQueueIds = [
				...new Set([
					...(session.recoveredPromptDispatchQueueIds ?? []),
					...recoveredIds,
				]),
			];
			// A rejected poison follow-up/Retry remains the front-priority human
			// recovery action. Move the exact durable rows by ID; never infer identity
			// from equal text/images or let older parked work overtake them.
			session.promptQueue.reorderByIds([...recoveredIds].reverse());
		}
		if (manualRecoveryRequired) {
			// This direct-dispatch recovery has handed ordinary work to the manual
			// retry path. A verifier receipt cannot share that ownership: reject its
			// exact row now rather than making the harness wait for its timeout.
			this.abandonVerifierPromptDispatchRows(session, rows, durableQueueRowIds, this.safeDispatchError(session, reason));
			session.lastTurnErrored = true;
			session.lastTurnErrorMessage = safeReason;
			session.turnHadToolCalls = false;
			session.recoverDrainAttempts = 0;
			if (providerAuthFailure) this.surfaceProviderAuthFailure(session, reason, source);
			else this.rollbackRejectedPromptDispatch(session);
			this.broadcastQueue(session);
			this.surfaceManualRetryRequired(session);
			return;
		}
		if (providerAuthFailure) {
			// Provider credentials are deterministic, terminal delivery failures.
			// Do not leave verifier work parked behind a 60-second receipt timeout.
			this.abandonVerifierPromptDispatchRows(session, rows, durableQueueRowIds, this.safeDispatchError(session, reason));
			this.surfaceProviderAuthFailure(session, reason, source);
			this.broadcastQueue(session);
			return;
		}
		this.rollbackRejectedPromptDispatch(session);
		this.broadcastQueue(session);
		if (this.maybeAutoRetryPromptDeliveryFailure(session, safeReason, source)) {
			// Bounded retry exhaustion switches regular prompts to manual recovery.
			// It must instead settle the verifier's exact receipt and remove its row.
			if (session.manualRetryRequired) {
				this.abandonVerifierPromptDispatchRows(session, rows, durableQueueRowIds, this.safeDispatchError(session, reason));
			}
			return;
		}
		// Configuration/schema/auth-like failures have no useful tick-0 retry.
		// Let ordinary rows retain their existing queue behavior, but settle a
		// verifier receipt immediately rather than turning it into a timeout.
		if (isNonRetryableAgentError(reason)
			&& this.abandonVerifierPromptDispatchRows(session, rows, durableQueueRowIds, this.safeDispatchError(session, reason))) {
			return;
		}
		// Schedule a follow-up drain on the next tick so the rows we just
		// re-enqueued get another chance once the bridge has finished its
		// abort/finishRun bookkeeping. this.clock.setTimeout(0) lets pending microtasks
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
			if (isReviewerBusyError(reason)) {
				// Keep the contention envelope narrow so verifier-scoped retry policy
				// can distinguish SDK busy from every other terminal dispatch failure.
				this.abandonVerifierPromptDispatchRows(session, rows, durableQueueRowIds, new Error(`Verifier prompt parked after reviewer contention: ${safeReason}`));
			} else {
				this.abandonVerifierPromptDispatchRows(session, rows, durableQueueRowIds, this.safeDispatchError(session, reason));
			}
			return;
		}
		session.recoverDrainAttempts = attempts;
		const generation = session.lifecycleGeneration ?? 0;
		this.clock.setTimeout(() => {
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
		source: PromptSource = "user",
		author: MessageAuthor = LOCAL_USER_AUTHOR,
		durableQueueRowId?: string,
		promptId = promptAttemptId("prompt"),
		streamingBehavior?: PromptStreamingBehavior,
		manualRecoveryRequired = durableQueueRowId !== undefined,
		verifierOwned = false,
		suppressTitleGen = false,
	): Promise<void> {
		const replacementKind = this._sessionReplacementCoordinators?.get(session.id)?.active?.kind;
		// Poison repair deliberately redrives its accepted durable row inside the
		// replacement coordinator. All unrelated dispatch remains fenced until the
		// coordinator releases.
		if (session.isCompacting || session.status === "aborting" || (replacementKind !== undefined && replacementKind !== "poison-redrive")) return;
		const reliableRow = durableQueueRowId
			? (session.promptQueue.toArray() as ReliableQueuedMessage[]).find((row) => row.id === durableQueueRowId && row.kind !== undefined)
			: undefined;
		if (session._piAgentRunSettled === false && replacementKind !== "poison-redrive") {
			// An accepted stable occurrence already owns its durable queue row. Legacy
			// and automatic-retry callers have no such row, so create one before
			// returning; agent_settled will drain the same occurrence exactly once.
			const existing = durableQueueRowId
				? session.promptQueue.toArray().find((row) => row.id === durableQueueRowId)
				: undefined;
			if (existing) {
				// Admission created this occurrence before the error-recovery envelope was
				// known. Preserve its identity/lane/state while durably replacing only the
				// model-facing payload and dispatch metadata that settlement must replay.
				Object.assign(existing, {
					text,
					images,
					attachments,
					isSteered: isSteered ?? false,
					source,
					verifierOwned,
					author,
					streamingBehavior,
					coldStart,
					suppressTitleGen,
					goalDispatchGuardId: reliableRow?.goalDispatchGuardId,
				});
			} else {
				const deferred = {
					id: durableQueueRowId ?? randomUUID(),
					text,
					images,
					attachments,
					isSteered: isSteered ?? false,
					createdAt: this.clock.now(),
					source,
					verifierOwned,
					author,
					streamingBehavior,
					coldStart,
					suppressTitleGen,
					goalDispatchGuardId: reliableRow?.goalDispatchGuardId,
				};
				session.promptQueue.restoreAtFront(deferred);
			}
			session.lastPromptText = text;
			session.lastPromptImages = images;
			session.lastPromptSource = source;
			this.broadcastQueue(session);
			return;
		}
		if (reliableRow) {
			// Re-resolve canonical goal lifecycle at the last synchronous boundary
			// before status, author-sidecar, queue ownership, or Pi can change.
			if (!this.goalDispatchGuardAllows(session, reliableRow)) return;
			session.lastPromptText = text;
			session.lastPromptImages = images;
			session.lastPromptSource = source;
			this.markPromptDispatchStreaming(session);
			const prepared = this.preparePromptAuthorDispatch(
				session,
				reliableRow.id,
				text,
				source,
				author,
				reliableRow.id,
				reliableRow,
			);
			const attempt: ReliableInFlightRecord = {
				text,
				promptId: reliableRow.id,
				intentId: reliableRow.id,
				attemptId: prepared.attemptId,
				dispatchEpoch: prepared.dispatchEpoch,
				state: "dispatching",
				targetTurn: reliableRow.targetTurn ?? "next-turn",
				sequence: reliableRow.sequence,
				kind: reliableRow.kind ?? "prompt",
				createdAt: reliableRow.createdAt,
				retryable: false,
				source,
				author,
				images: reliableRow.images,
				attachments: reliableRow.attachments,
				suppressTitleGen: reliableRow.suppressTitleGen,
				goalDispatchGuardId: reliableRow.goalDispatchGuardId,
			};
			(session.inFlightSteerTexts ??= []).push(attempt);
			session.promptQueue.remove(reliableRow.id);
			this.broadcastQueue(session);
			const activityBoundary = beginPreparedPromptActivity(session, prepared);
			let definiteRejection = false;
			try {
				const response = coldStart
					? streamingBehavior
						? await session.rpcClient.promptWhenReady(prepared.piText, images, { streamingBehavior })
						: await session.rpcClient.promptWhenReady(prepared.piText, images)
					: streamingBehavior
						? await session.rpcClient.prompt(prepared.piText, images, undefined, streamingBehavior)
						: await session.rpcClient.prompt(prepared.piText, images);
				if (response && (response as any).success === false) {
					definiteRejection = true;
					throw new Error((response as any).error || "prompt rejected");
				}
				if (acceptPreparedPromptDispatch(session, prepared, activityBoundary)) {
					this.clearRecoveredPromptDispatchOwnership(session, [reliableRow.id]);
					if (!this.pruneTerminalInFlightAttempt(session, reliableRow.id, prepared.attemptId)) {
						this.broadcastQueue(session);
					}
					// A verifier receipt tracks provider acceptance, not its later Pi echo.
					// The occurrence remains in the reliable in-flight ledger for outbox
					// projection until that echo settles it.
					this.settleVerifierPromptReceipt(session.id, reliableRow.id);
				}
				return;
			} catch (error) {
				if (activityBoundary?.state === "committed") return;
				const index = (session.inFlightSteerTexts as ReliableInFlightRecord[]).indexOf(attempt);
				if (isPiCompactionActiveRejection(error)
					&& index !== -1
					&& attempt.state !== "received") {
					// Compaction is a proven no-start only while this exact author
					// binding remains cancellable. A false result may mean Pi consumed
					// the evidence concurrently, so it must not be redriven.
					if (!this.cancelPromptAuthorDispatch(session, prepared)) return;
					session.inFlightSteerTexts!.splice(index, 1);
					this.enqueueReliableIntent(session, {
						...reliableRow,
						deliveryState: "queued",
						deliveryReason: "compaction-active",
						deliveryError: undefined,
						retryable: false,
						attemptId: prepared.attemptId,
						dispatchEpoch: prepared.dispatchEpoch,
					}, { front: true });
					this.broadcastQueue(session);
					// Pi rejected before opening a turn; undo every optimistic status plane
					// so the matching compaction finisher can own the sole redrain.
					this.rollbackRejectedPromptDispatch(session);
					console.warn(`[session-manager] intent dispatch restored session=${session.id} intent=${reliableRow.id} attempt=${prepared.attemptId} outcome=compaction-active`);
					return;
				}

				if (definiteRejection) {
					// `success:false` is the bridge's authoritative no-start signal. Do
					// not retire the carrier until its author binding is cancelled too:
					// a false result means a concurrent Pi echo already owns it.
					if (!this.cancelPromptAuthorDispatch(session, prepared)) return;
					if (index !== -1) session.inFlightSteerTexts!.splice(index, 1);

					const poisonOwned = session.poisonRecoveryPromptDispatchQueueIds?.includes(reliableRow.id) === true;
					const directRecoveryOwner = poisonOwned
						|| reliableRow.verifierOwned === true
						|| reliableRow.source !== "user";
					if (directRecoveryOwner) {
						// Server-owned rows have an existing bounded recovery lifecycle. A
						// definitive no-start is safe to return to that lifecycle; preserve
						// the exact durable row and all of its envelope metadata.
						this.enqueueReliableIntent(session, {
							...reliableRow,
							deliveryState: "queued",
							deliveryReason: undefined,
							deliveryError: undefined,
							retryable: false,
							attemptId: prepared.attemptId,
							dispatchEpoch: prepared.dispatchEpoch,
						}, { front: true });
						this.recoverPromptDispatch(
							session,
							[{
								id: reliableRow.id,
								text: reliableRow.text,
								images: reliableRow.images,
								attachments: reliableRow.attachments,
								isSteered: reliableRow.isSteered,
								source: reliableRow.source,
								verifierOwned: reliableRow.verifierOwned,
								author: reliableRow.author,
								streamingBehavior: reliableRow.streamingBehavior,
								coldStart: reliableRow.coldStart,
								suppressTitleGen: reliableRow.suppressTitleGen,
								goalDispatchGuardId: reliableRow.goalDispatchGuardId,
							}],
							error instanceof Error ? error.message : String(error),
							reliableRow.verifierOwned === true ? "reliable verifier prompt" : "reliable automatic prompt",
							[reliableRow.id],
							poisonOwned,
						);
						throw error;
					}

					this.enqueueReliableIntent(session, {
						...reliableRow,
						deliveryState: "failed",
						retryable: true,
						deliveryError: "bridge-rejected",
						attemptId: prepared.attemptId,
						dispatchEpoch: prepared.dispatchEpoch,
					}, { front: true });
					this.rollbackRejectedPromptDispatch(session);
					this.broadcastQueue(session);
					return;
				}

				// A thrown RPC error is ambiguous: Pi may have consumed the exact
				// occurrence before transport failed. Keep that exact carrier durable
				// and outbox-owned; never cancel, requeue, recover, or redrain it.
				if (index !== -1) {
					attempt.state = "uncertain";
					attempt.retryable = false;
				}
				this.broadcastQueue(session);
				// Verifier receipt completion is distinct from prompt occurrence
				// settlement. Reject this receipt so the harness may create a fresh
				// lifecycle row, while the old ambiguous carrier remains intact.
				if (reliableRow.verifierOwned === true) {
					this.settleVerifierPromptReceipt(session.id, reliableRow.id, new Error(
						`Verifier prompt ${reliableRow.id} transport outcome is uncertain`,
					));
				}
				console.error(`[session-manager] intent dispatch failed session=${session.id} intent=${reliableRow.id} attempt=${prepared.attemptId} outcome=uncertain`);
				throw error;
			}
		}

		session.lastPromptText = text;
		session.lastPromptImages = images;
		session.lastPromptSource = source;
		this.markPromptDispatchStreaming(session);

		const dispatchedRowsForRecovery = [{ text, images, attachments, isSteered, source, verifierOwned, author, streamingBehavior, coldStart, suppressTitleGen }];
		const prepared = this.preparePromptAuthorDispatch(session, promptId, text, source, author);
		const activityBoundary = beginPreparedPromptActivity(session, prepared);
		const consumeDurableAcceptanceRow = () => {
			if (!durableQueueRowId || !session.promptQueue.remove(durableQueueRowId)) return;
			this.clearRecoveredPromptDispatchOwnership(session, [durableQueueRowId]);
			this.broadcastQueue(session);
			this.settleVerifierPromptReceipt(session.id, durableQueueRowId);
		};
		const acceptedBeforeAckFailure = (reason: string): boolean => {
			if (activityBoundary?.state !== "committed") return false;
			const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
			const safeReason = redactDispatchFailureReason(reason, isProviderAuthFailure(reason), persistedProvider);
			console.warn(`[session-manager] direct prompt dispatch for ${session.id} reported ${safeReason} after its correlated user echo; treating the dispatch as accepted`);
			consumeDurableAcceptanceRow();
			session.recoverDrainAttempts = 0;
			return true;
		};
		let recovered = false;
		let cancelled = false;
		try {
			// Cold (freshly-restored) agent: wait for readiness, then prompt with a
			// generous timeout so a boot-resume nudge lands instead of timing out
			// on the default 30s. Everything else (recovery, rethrow) is identical.
			const resp = coldStart
				? streamingBehavior
					? await session.rpcClient.promptWhenReady(prepared.piText, images, { streamingBehavior })
					: await session.rpcClient.promptWhenReady(prepared.piText, images)
				: streamingBehavior
					? await session.rpcClient.prompt(prepared.piText, images, undefined, streamingBehavior)
					: await session.rpcClient.prompt(prepared.piText, images);
			if (resp && (resp as any).success === false) {
				const reason = (resp as any).error || "unknown";
				if (acceptedBeforeAckFailure(reason)) return;
				if (!this.cancelPromptAuthorDispatch(session, prepared)) return;
				cancelled = true;
				this.recoverPromptDispatch(session, dispatchedRowsForRecovery, reason, "direct prompt", [durableQueueRowId], manualRecoveryRequired);
				recovered = true;
				throw this.safeDispatchError(session, reason);
			}
			// The exact RPC attempt accepted the intent. A stale bridge response cannot
			// consume a row already recovered by replacement reconciliation.
			if (!acceptPreparedPromptDispatch(session, prepared, activityBoundary)) return;
			consumeDurableAcceptanceRow();
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (!recovered && acceptedBeforeAckFailure(reason)) return;
			if (!cancelled && !this.cancelPromptAuthorDispatch(session, prepared)) return;
			if (!recovered) {
				this.recoverPromptDispatch(session, dispatchedRowsForRecovery, reason, "direct prompt", [durableQueueRowId], manualRecoveryRequired);
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
		if (this.getModelSelectionRecoveryAdmission(session.id).condition) return;
		if (!this._sessionWriterIsCurrent(session)) return;
		if (session.isCompacting || session.status === "aborting" || (this._sessionReplacementCoordinators?.has(session.id) ?? false)) return;
		// agent_end is not Pi's prompt-admission boundary: automatic compaction and
		// queued continuation handling still run before agent_settled clears the
		// runtime's active-run guard.
		if (session._piAgentRunSettled === false) return;
		if (session.promptQueue.isEmpty) return;

		const reliableNext = (session.promptQueue.toArray() as ReliableQueuedMessage[])
			.filter((row) => row.kind !== undefined
				&& row.targetTurn !== "continuation"
				&& row.deliveryState === "queued")
			.reduce<ReliableQueuedMessage | undefined>((selected, row) => {
				if (!selected) return row;
				return (row.sequence ?? Number.MAX_SAFE_INTEGER)
					< (selected.sequence ?? Number.MAX_SAFE_INTEGER)
					? row
					: selected;
			}, undefined);
		if (reliableNext) {
			if (!this.goalDispatchGuardAllows(session, reliableNext)) return;
			if (!reliableNext.suppressTitleGen) this.tryGenerateTitleFromPrompt(session.id, reliableNext.text);
			const promptSource = reliableNext.source ?? "user";
			const promptAuthor = resolveAcceptedPromptAuthor(promptSource, reliableNext.author);
			if (session.poisonRecoveryPromptDispatchQueueIds?.includes(reliableNext.id)) {
				// A recovered poison occurrence may be redriven from the reliable lane
				// without a fresh agent_start. Rotate the prior terminal fence before
				// dispatch so its eventual terminal can release the next queued row.
				session.abortShapedTerminal = undefined;
				session.assistantTerminalIdentities = undefined;
				session.lastAssistantTerminalIdentity = undefined;
				session.turnTerminalHandled = false;
			}
			void this.dispatchDirectPrompt(
				session,
				reliableNext.text,
				reliableNext.images,
				reliableNext.attachments,
				reliableNext.kind === "steer",
				reliableNext.coldStart === true,
				promptSource,
				promptAuthor,
				reliableNext.id,
				reliableNext.id,
				reliableNext.streamingBehavior,
				false,
				reliableNext.verifierOwned === true,
				reliableNext.suppressTitleGen === true,
			).catch(() => {});
			return;
		}

		// Batch compatible steered messages at the front into a single prompt.
		// A verifier-owned row has a receipt and cancellation lifecycle that cannot
		// be represented by a mixed batch: on recovery, retryLastPrompt must redrive
		// its exact durable row rather than the batch's lastPromptText. Keep an
		// ownership boundary between verifier and ordinary steers.
		const allSteered = session.promptQueue.dequeueAllSteered();
		const firstSteerVerifierOwned = allSteered[0]?.verifierOwned === true;
		const ownershipBoundary = allSteered.findIndex(row => (row.verifierOwned === true) !== firstSteerVerifierOwned);
		const steered = ownershipBoundary === -1 ? allSteered : allSteered.slice(0, ownershipBoundary);
		if (ownershipBoundary !== -1) {
			// restoreAtFront unshifts, so reverse the suffix to preserve FIFO order.
			for (let index = allSteered.length - 1; index >= ownershipBoundary; index -= 1) {
				session.promptQueue.restoreAtFront(allSteered[index]);
			}
		}
		let next: QueuedMessage | undefined;

		if (steered.length > 0) {
			const batchText = steered.map(m => m.text).join('\n');
			const batchAuthor = authorForSteerRows(steered);
			const batchSource: PromptSource = batchAuthor === BATCH_SYSTEM_AUTHOR
				? "system"
				: steered.every((row) => (row.source ?? "user") === (steered[0].source ?? "user"))
					? (steered[0].source ?? "user")
					: "system";
			next = { ...steered[0], text: batchText, source: batchSource, author: batchAuthor };
		} else {
			// Skip already-dispatched messages (steered mid-turn), then pop the next
			next = session.promptQueue.dequeue();
		}

		this.broadcastQueue(session);
		if (!next) return;

		// Title generation for the first real prompt. Suppressed kickoff prompts
		// (assistant auto-kickoff) never seed the title — naming fires on the
		// first genuine user message.
		if (!next.suppressTitleGen) this.tryGenerateTitleFromPrompt(session.id, next.text);

		// Track for retry and nudge provenance from the row being dispatched.
		const promptSource = next.source ?? "user";
		const promptAuthor = resolveAcceptedPromptAuthor(promptSource, next.author);
		const promptId = steered.length > 0 ? batchPromptId("queue-batch", steered) : next.id;
		session.lastPromptText = next.text;
		session.lastPromptImages = next.images;
		session.lastPromptSource = promptSource;

		// Optimistic status update to prevent double-dispatch race
		this.markPromptDispatchStreaming(session);

		// Snapshot the rows we're about to dispatch so we can re-enqueue them
		// if the agent rejects the prompt (e.g. "Agent is already processing."
		// when drainQueue races the SDK's finishRun() during a graceful abort).
		const dispatchedRowsForRecovery = steered.length > 0
			? steered.map(r => ({ id: r.id, text: r.text, images: r.images, attachments: r.attachments, isSteered: true, source: r.source, verifierOwned: r.verifierOwned, author: r.author, streamingBehavior: r.streamingBehavior, coldStart: r.coldStart, suppressTitleGen: r.suppressTitleGen }))
			: [{ id: next.id, text: next.text, images: next.images, attachments: next.attachments, isSteered: !!next.isSteered, source: promptSource, verifierOwned: next.verifierOwned, author: promptAuthor, streamingBehavior: next.streamingBehavior, coldStart: next.coldStart, suppressTitleGen: next.suppressTitleGen }];
		const dispatchedQueueRowIds = steered.length > 0 ? steered.map(row => row.id) : [next.id];
		const poisonOwnedDispatch = dispatchedQueueRowIds.some(id =>
			session.poisonRecoveryPromptDispatchQueueIds?.includes(id),
		);
		if (poisonOwnedDispatch) {
			// Poison repair may synthesize a turn on a freshly restored bridge before
			// it can emit agent_start. Its accepted redrive is nevertheless a proven
			// new turn, so it must rotate the previous terminal replay guard.
			session.abortShapedTerminal = undefined;
			session.assistantTerminalIdentities = undefined;
			session.lastAssistantTerminalIdentity = undefined;
			session.turnTerminalHandled = false;
		}

		const acceptedBeforeAckFailure = (reason: string): boolean => {
			// Apply this exact-origin fence before cancellation: an echoed attempt is
			// accepted even if its RPC acknowledgement subsequently fails.
			if (activityBoundary?.state !== "committed") return false;
			const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
			const safeReason = redactDispatchFailureReason(reason, isProviderAuthFailure(reason), persistedProvider);
			console.warn(`[session-manager] drainQueue dispatch for ${session.id} reported ${safeReason} after its correlated user echo; not recovering ${dispatchedRowsForRecovery.length} row(s)`);
			this.clearRecoveredPromptDispatchOwnership(session, dispatchedQueueRowIds);
			for (const rowId of dispatchedQueueRowIds) this.settleVerifierPromptReceipt(session.id, rowId);
			return true;
		};

		const recoverDispatchedRows = (reason: string) => {
			this.recoverPromptDispatch(
				session,
				dispatchedRowsForRecovery,
				reason,
				"drainQueue",
				dispatchedQueueRowIds,
				poisonOwnedDispatch,
			);
		};

		const prepared = this.preparePromptAuthorDispatch(session, promptId, next.text, promptSource, promptAuthor);
		const activityBoundary = beginPreparedPromptActivity(session, prepared);
		const dispatchPromise = next.coldStart
			? session.rpcClient.promptWhenReady(prepared.piText, next.images, next.streamingBehavior ? { streamingBehavior: next.streamingBehavior } : undefined)
			: next.streamingBehavior
				? session.rpcClient.prompt(prepared.piText, next.images, undefined, next.streamingBehavior)
				: session.rpcClient.prompt(prepared.piText, next.images);
		dispatchPromise
			.then((resp: any) => {
				// The bridge resolves with `{success:false, error}` when the agent
				// rejects the command (the most common case is the abort/drainQueue
				// race below). Treat that the same as a thrown rejection — recover
				// the dequeued rows so a future drain can redispatch them.
				if (resp && resp.success === false) {
					const reason = resp.error || "unknown";
					if (acceptedBeforeAckFailure(reason)) return;
					if (!this.cancelPromptAuthorDispatch(session, prepared)) return;
					recoverDispatchedRows(reason);
				} else if (acceptPreparedPromptDispatch(session, prepared, activityBoundary)) {
					// Dispatch landed — clear the busy-guard retry budget and any
					// ownership ledger for the dequeued durable row. A cancelled token
					// identifies a stale bridge acknowledgement and owns no state.
					this.clearRecoveredPromptDispatchOwnership(session, dispatchedQueueRowIds);
					session.recoverDrainAttempts = 0;
					for (const rowId of dispatchedQueueRowIds) this.settleVerifierPromptReceipt(session.id, rowId);
				} else {
					// A replacement/cancellation can win after the provider accepts but before
					// this stale bridge acknowledges. The row was dequeued already, so leaving
					// its receipt pending would force the verifier harness to wait 60 seconds.
					for (const rowId of dispatchedQueueRowIds) {
						this.abandonVerifierPrompt(session.id, rowId, new Error(`Verifier prompt ${rowId} dispatch was superseded before acknowledgement`));
					}
				}
			})
			.catch((err: any) => {
				const reason = err?.message || String(err);
				if (acceptedBeforeAckFailure(reason)) return;
				if (!this.cancelPromptAuthorDispatch(session, prepared)) return;
				const persistedProvider = this.resolveStoreForSession(session.id).get(session.id)?.modelProvider;
				const safeReason = redactDispatchFailureReason(reason, isProviderAuthFailure(reason), persistedProvider);
				console.error(`[session-manager] Failed to dispatch queued prompt for ${session.id}: ${safeReason}`);
				recoverDispatchedRows(reason);
			});
	}

	/** Sole idempotent release boundary for every compaction disposition. */
	private finishCompactionAndRelease(
		session: SessionInfo,
		compactionId: string | undefined,
		opts?: { willRetry?: boolean; aborted?: boolean; failed?: boolean; reason?: string },
	): void {
		const id = compactionId ?? session._reliableCompactionId;
		if (!id) return;
		const finished = session._reliableFinishedCompactionIds ??= new Set<string>();
		if (finished.has(id)) return;
		finished.add(id);
		// Keep the duplicate fence bounded without introducing another durable owner.
		if (finished.size > 32) finished.delete(finished.values().next().value!);
		session.isCompacting = false;
		session._reliableCompactionId = undefined;
		session._reliableCompactionReason = undefined;
		if (session.status === "aborting") {
			session._reliableCompactionReleaseDeferred = true;
			return;
		}
		const continuing = opts?.failed !== true && (
			opts?.willRetry === true
			|| ((opts?.reason === "threshold" || opts?.reason === "overflow") && session.status === "streaming" && !opts?.aborted)
		);
		if (continuing) {
			const continuation = (session.promptQueue.toArray() as ReliableQueuedMessage[])
				.filter((row) => row.kind === "steer" && row.targetTurn === "continuation" && row.deliveryState === "queued");
			if (continuation.length > 0) void this._dispatchSteer(session, continuation).catch(() => {});
			return;
		}
		if (session.status === "idle" && !session.lastTurnErrored) this.drainQueue(session);
	}

	/**
	 * Handle agent events that track error state and control queue draining.
	 * Called from every event listener before broadcasting.
	 * - Tracks message_end with stopReason "error" so we can suppress queue draining.
	 * - On agent_end, skips drainQueue if the turn ended with an error.
	 */
	private handleAgentLifecycle(
		session: SessionInfo,
		event: any,
		opts?: {
			replacementOwnedTerminal?: boolean;
			deferQueueDrain?: boolean;
			/** A synthetic hard-kill terminal cannot prove whether Pi appended the user start. */
			abortAttemptOutcome?: "ambiguous" | "proven-no-start";
		},
	): void {
		if (!session.onStatusChanged || !session.onEventAccepted) this.attachHostLifecycleObservers(session);
		// Inbound turn progress is also the acknowledgement fence for prompt RPCs.
		// Record it for the current canonical generation even while a replacement
		// coordinator suppresses ordinary lifecycle effects: poison redrive and boot
		// continuation deliberately dispatch before that coordinator releases.
		const coordinator = this._sessionReplacementCoordinators.get(session.id);
		const writerIsCurrent = this._sessionWriterIsCurrent(session);
		const observesAcceptedTurn =
			event.type === "agent_start" ||
			event.type === "tool_execution_start" ||
			(event.type === "message_end" && (
				event.message?.role === "user" ||
				event.message?.role === "user-with-attachments" ||
				event.message?.role === "assistant"
			));
		if (observesAcceptedTurn && writerIsCurrent) {
			session.agentObservedTurnVersion = (session.agentObservedTurnVersion ?? 0) + 1;
			// Boot continuation may receive agent_start before its prompt RPC ack while
			// coordinator ownership remains installed.
			if (event.type === "agent_start") this._bootRepromptedSessions.delete(session.id);
		}

		// A coordinated replacement may keep a superseded bridge subscribed until its
		// successor is validated. Fence only those stale writers. The final canonical
		// bridge can already be running a poison redrive or boot continuation while its
		// prompt RPC acknowledgement is pending; its terminal lifecycle must still make
		// the session idle, record errors, and complete turn bookkeeping. Queue draining
		// is deferred until coordinator release so the still-durable acceptance row is
		// consumed before anything can be dispatched again.
		if (coordinator && !opts?.replacementOwnedTerminal && !writerIsCurrent) return;
		const deferQueueDrain = opts?.deferQueueDrain === true
			|| (!!coordinator && !opts?.replacementOwnedTerminal);

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

		// Track tool execution during this turn. Provenance is created only from a
		// current Pi writer; the later EventBuffer acceptance attaches its cursor
		// before any waiting HTTP callback can claim it.
		if (event.type === "tool_execution_start") {
			if (writerIsCurrent) this.observeToolCallStart(session, event);
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

		// Every proven user echo settles the durable ledger. Stop only recovers
		// entries still unresolved after this boundary.
		this._consumeSteerEcho(session, event);

		// Tool boundary: defensively flush any steered rows that remain queued
		// (for example, recovered/pre-existing rows). Fresh live steers and
		// steer_queued promotions dispatch immediately through _dispatchSteer.
		if (event.type === "tool_execution_end") {
			this.recordToolCallTerminal(session, event);
			// Compaction and Stop are active turns. Neither tool completion nor a
			// stale boundary may bypass their sole release owner.
			if (session.status === "aborting" || session.isCompacting) return;
			const queued = session.promptQueue.toArray() as ReliableQueuedMessage[];
			const reliable = queued.filter((row) => row.kind === "steer" && row.targetTurn === "continuation" && row.deliveryState === "queued");
			if (reliable.length > 0) void this._dispatchSteer(session, reliable).catch(() => {});
			else {
				const steered = session.promptQueue.dequeueAllSteered();
				if (steered.length > 0) void this._dispatchSteer(session, steered).catch(() => {});
			}
		}

		if (event.type === "message_end" && (event.message?.role === "user" || event.message?.role === "user-with-attachments")) {
			session.latestTurnUserText = extractUserMessageText(event.message);
		}

		if (event.type === "message_end") {
			const postedAskId = successfulPostedAskToolUseId(event.message);
			if (postedAskId) {
				const store = this.resolveStoreForSession(session.id);
				const persisted = store.get(session.id);
				const dismissed = normalizeDismissedAskToolUseIds(persisted?.dismissedAskToolUseIds);
				if (!dismissed.includes(postedAskId) && persisted?.hasUnansweredQuestion !== true) {
					store.update(session.id, { hasUnansweredQuestion: true });
					void store.flushAsync()
						.then(() => this._onSessionQuestionStateChanged?.(session.id, true))
						.catch(error => console.error(`[session ${session.id}] Failed to persist unanswered-question state:`, error));
				}
			}
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			if (event.message.stopReason === "length" && typeof event.message.assistantStreamId === "string") {
				session.pendingRecoverableLengthStreamId = event.message.assistantStreamId;
			} else if (event.message.stopReason !== "length") {
				session.pendingRecoverableLengthStreamId = undefined;
			}
			const terminalIdentity = assistantTerminalIdentity(event.message);
			let terminalIdentities = session.assistantTerminalIdentities ??= new Set();
			// The browser adapter's poison fixture delivers its provider terminal after
			// the preceding mock turn has completed, without a new agent_start. Its
			// exact orphan-ordering signature is a proven synthetic turn boundary, not
			// a late assistant replay; rotate only for that narrow recovery case.
			const syntheticPoisonTerminal = event.message.stopReason === "error"
				&& isOrphanToolResultOrderingError(event.message.errorMessage);
			if (session.turnTerminalHandled && syntheticPoisonTerminal) {
				session.abortShapedTerminal = undefined;
				session.assistantTerminalIdentities = terminalIdentities = new Set();
				session.lastAssistantTerminalIdentity = undefined;
				session.turnTerminalHandled = false;
			}
			// A final boundary is authoritative until a proven next-turn boundary
			// (agent_start, retry, or synthetic recovery) rotates this identity set.
			// In particular, do not let a late distinct terminal fabricate a turn.
			if (session.turnTerminalHandled || terminalIdentities.has(terminalIdentity ?? "")) return;
			terminalIdentities.add(terminalIdentity ?? "");
			session.lastAssistantTerminalIdentity = terminalIdentity;
			session.latestTurnAssistantText = extractUserMessageText(event.message);
			session.abortShapedTerminal = isAbortShapedAssistantTerminal(event.message);
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
			// Established sessions already have setupComplete=true, so their first
			// post-clear assistant flush would otherwise never revisit metadata. Flip
			// the latest false materialization marker through the same atomic path.
			if (writerIsCurrent) {
				try {
					const persisted = this.resolveStoreForSession(session.id).get(session.id);
					if (latestContextClearBoundary(persisted?.contextClearBoundaries)?.activatedTranscriptMaterialized === false
						&& !session.pendingMetadataPersist) {
						const pending = this.persistSessionMetadata(session).catch((error) => {
							console.warn(`[session-manager] Failed to mark cleared transcript materialized for ${session.id}:`, error);
						}).finally(() => {
							if (session.pendingMetadataPersist === pending) session.pendingMetadataPersist = undefined;
						});
						session.pendingMetadataPersist = pending;
					}
				} catch { /* a later lifecycle pass can retry metadata healing */ }
			}
		}

		if (event.type === "agent_start") {
			// Pi's run remains active through agent_end post-processing. A later
			// agent_settled is the sole fresh-prompt admission boundary.
			session._piAgentRunSettled = false;
			// The session has begun its turn — clear the boot re-prompt marker so
			// the set doesn't leak across the process lifetime (restoreSession is
			// also re-invoked on in-place respawn).
			this._bootRepromptedSessions.delete(session.id);
			session.latestTurnUserText = undefined;
			session.latestTurnAssistantText = undefined;
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.abortShapedTerminal = undefined;
			session.assistantTerminalIdentities = undefined;
			session.lastAssistantTerminalIdentity = undefined;
			session.turnTerminalHandled = false;
			session.manualRetryRequired = false;
			session.turnHadToolCalls = false;
			session.streamingStartedAt = this.clock.now();
			this.resolveStoreForSession(session.id).update(session.id, {
				wasStreaming: true,
				streamingStartedAt: session.streamingStartedAt,
				manualRetryRequired: false,
			});
			broadcastStatus(session, "streaming", { streamingStartedAt: session.streamingStartedAt });
			const turnIndex = (session.completedTurnCount ?? 0) + 1;
			if (session.hostTurnStartedIndex !== turnIndex) {
				session.hostTurnStartedIndex = turnIndex;
				this.publishSessionNotification(session, "turnStarted", `${session.id}:${turnIndex}`, turnIndex, {
					turnIndex,
					source: session.lastPromptSource ?? "user",
				});
			}
			// Pi has durably appended the user prompt by agent_start. Refresh the
			// authoritative cursor plane now so prompt actions appear during the turn.
			this.schedulePromptCursorRefresh(session);
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
			// Pi 0.80+ emits agent_end for retryable failed attempts before its
			// internal auto-retry loop settles. Do not mark Bobbit idle, revoke
			// one-time grants, drain queued prompts, or count the turn until the
			// final (willRetry:false) agent_end. Incrementing completedTurnCount on
			// a retryable attempt double-counts a single user-visible turn (the
			// final agent_end increments again) and shifts lifecycle turn indexes.
			if (event.willRetry === true) {
				// Pi may emit a terminal frame for an internal attempt before it retries.
				// It is not the user-visible boundary, so do not let it classify the
				// eventual final attempt or suppress its bookkeeping. A late retryable
				// frame after the final boundary must remain a no-op.
				if (!session.turnTerminalHandled) {
					session.abortShapedTerminal = undefined;
					session.assistantTerminalIdentities = undefined;
					session.lastAssistantTerminalIdentity = undefined;
				}
				return;
			}
			// A synthetic hard-kill terminal has no later Pi settlement event. Synthesize
			// settlement even when the real final agent_end already performed this turn's
			// bookkeeping; graceful replacement replay still waits for agent_settled.
			if (opts?.replacementOwnedTerminal && opts.abortAttemptOutcome !== undefined) {
				session._piAgentRunSettled = true;
			}
			if (session.turnTerminalHandled) return;
			session.turnTerminalHandled = true;

			// Revoke one-time granted tools after the turn completes
			if (session.oneTimeGrantedTools && session.oneTimeGrantedTools.length > 0) {
				const toRevoke = new Set(session.oneTimeGrantedTools.map(t => t.toLowerCase()));
				session.allowedTools = (session.allowedTools || []).filter(
					t => !toRevoke.has(t.toLowerCase())
				);
				session.oneTimeGrantedTools = [];
			}

			const wasAborting = session.status === "aborting";
			const abortShapedTerminal = session.abortShapedTerminal === true;
			const terminalOutcome: "succeeded" | "errored" | "aborted" = wasAborting || abortShapedTerminal
				? "aborted"
				: session.lastTurnErrored || event.error === true || event.success === false
					? "errored"
					: "succeeded";
			const terminalStartedAt = session.streamingStartedAt;
			const terminalHadToolCalls = session.turnHadToolCalls === true;
			// Consume this turn's classification at the sole final boundary. A late
			// duplicate agent_end cannot reinterpret the next turn as cancelled.
			session.abortShapedTerminal = undefined;
			if (wasAborting || abortShapedTerminal) {
				// Stop destroys the current turn, so work that never left Bobbit's queue
				// becomes next-turn work immediately. A graceful terminal does not prove
				// whether an acknowledged Pi steer entered its transcript: its user start
				// may still arrive late. Keep modern dispatched attempts uncertain until
				// an exact late start settles them or replacement transcript replay proves
				// no start. Synthetic hard-kill bookkeeping follows the same ambiguity rule.
				this._reconcileAfterAbort(session, {
					outcome: opts?.abortAttemptOutcome ?? "ambiguous",
					retargetQueuedContinuation: true,
				});
				this.broadcastQueue(session);

				// Cancellation is not a model malfunction. Clear only its error state
				// so the normal drain boundary can deliver the preserved queue.
				session.lastTurnErrored = false;
				session.lastTurnErrorMessage = undefined;
				session.consecutiveErrorTurns = 0;
				session.manualRetryRequired = false;
			} else if (!session.lastTurnErrored) {
				// A final turn boundary cannot accept a live steer. Reliable continuation
				// rows become next-turn work; legacy rows retain their historical flush.
				const reliableSteers = (session.promptQueue.toArray() as ReliableQueuedMessage[])
					.filter((row) => row.kind === "steer" && row.deliveryState === "queued");
				if (reliableSteers.some((row) => row.targetTurn === "continuation")) {
					session.promptQueue.retargetContinuationToNextTurn("continuation-ended");
				}
				if (reliableSteers.length === 0) {
					const steered = session.promptQueue.dequeueAllSteered();
					if (steered.length > 0) void this._dispatchSteer(session, steered).catch(() => {});
				}
			}

			// Any completed cancellation or successful turn supersedes a prior
			// parked-manual-retry marker before the durable idle boundary.
			if (!session.lastTurnErrored) session.manualRetryRequired = false;
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
				}, lifecycleScopeInput(session)).catch((err) => {
					console.warn(`[session-manager] afterTurn dispatch failed for ${session.id}:`, err);
				});
			}
			this.resolveStoreForSession(session.id).update(session.id, {
				wasStreaming: false,
				streamingStartedAt: undefined,
				manualRetryRequired: session.manualRetryRequired === true,
			});
			broadcastStatus(session, "idle");
			const completedTurnIndex = session.completedTurnCount;
			this.publishSessionNotification(session, "turnCompleted", `${session.id}:${completedTurnIndex}`, completedTurnIndex, {
				turnIndex: completedTurnIndex,
				outcome: terminalOutcome,
				durationMs: terminalStartedAt === undefined ? 0 : Math.max(0, this.clock.now() - terminalStartedAt),
				hadToolCalls: terminalHadToolCalls,
			});
			// turnCompleted is the last fact allowed to inherit this root. The
			// dispatcher admits durable subscribers in its already-queued microtask;
			// clear immediately after that admission seam, fenced by notification id.
			const completedNotificationId = session.staffNotificationTurnContext?.notificationId;
			if (completedNotificationId) {
				queueMicrotask(() => this.clearStaffNotificationTurnContext(session.id, completedNotificationId));
			}
			this.clearToolCallProvenance(session);
			this.resolveIdleWaiters(session.id);
			this.schedulePromptCursorRefresh(session, { settleBindings: true });
			// Don't drain the queue if the turn ended with a model error —
			// queued/steered messages should wait for a retry.
			if (!session.lastTurnErrored) {
				session.transientRetryAttempts = 0;
				// Fresh budget for the one-microtask drainQueue→finishRun race on
				// this turn boundary (see MAX_RECOVER_DRAIN_RETRIES).
				session.recoverDrainAttempts = 0;
				// A graceful Stop or canonical coordinated prompt performs terminal
				// bookkeeping while replacement ownership is still held. The coordinator
				// performs the sole drain after prompt acknowledgement settles. For a
				// normal Pi turn, agent_end precedes post-run compaction; drainQueue is
				// fenced until agent_settled clears Pi's active-run guard.
				if (!deferQueueDrain && session._piAgentRunSettled !== false) this.drainQueue(session);
				else if (coordinator && writerIsCurrent && !opts?.replacementOwnedTerminal) {
					coordinator.drainOnRelease = true;
				}
			} else {
				// Auto-retry transient model/streaming glitches (e.g. malformed
				// tool-call JSON from the model's streamed input_json_delta).
				// Replacement coordination still owns queue draining, but it must not
				// hide a parked error merely because its terminal bookkeeping was
				// deferred to that coordinator.
				if (!this.maybeAutoRetryTransient(session)) this.surfaceManualRetryRequired(session);
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
		} else if (event.type === "agent_settled") {
			// Pi settling its run is not an echo. Any handoff without a correlated
			// user start remains an uncertain outbox carrier, never settled/replayed.
			if (this._markModernInFlightAttemptsUncertain(session)) this.broadcastQueue(session);
			// Pi sets its internal active-run flag false immediately before this event,
			// after all retry/compaction/queued-continuation post-processing. New-turn
			// work must enter Pi here, never synchronously from agent_end.
			session._piAgentRunSettled = true;
			if (session.status === "idle"
				&& !session.lastTurnErrored
				&& !session.isCompacting
				&& !deferQueueDrain) {
				session.recoverDrainAttempts = 0;
				this.drainQueue(session);
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
				const startedAtMs = this.clock.now();
				(session as any)._pendingCompactionStart = {
					startedAtMs,
					trigger: reason === "overflow" ? "overflow" as const : "auto" as const,
					compactionId: makeCompactionId(startedAtMs),
					rpcClient: session.rpcClient,
					baselinePromise: this.readCompactionTranscriptEntries(session.rpcClient),
				};
			}
			const pendingId = (session as any)._pendingCompactionStart?.compactionId as string | undefined;
			const compactionId = (event as any).compactionId
				?? session._reliableCompactionId
				?? (session as any)._manualCompactionId
				?? pendingId
				?? makeCompactionId(this.clock.now());
			session._reliableCompactionId = compactionId;
			session._reliableCompactionReason = reason;
			(event as any).compactionId ??= compactionId;
		} else if (event.type === "auto_compaction_end" || event.type === "compaction_end") {
			const activeCompactionId = (event as any).compactionId ?? session._reliableCompactionId;
			const reason = (event as any).reason;
			const aborted = !!(event as any).aborted;
			const explicitCompactionError = [(event as any).errorMessage, (event as any).error]
				.find((value): value is string => typeof value === "string" && value.trim().length > 0);
			const result = (event as any).result as
				| { summary?: string; tokensBefore?: number; firstKeptEntryId?: string }
				| undefined;
			// Pi's automatic-compaction failure shape has changed across releases:
			// it may carry `success:false`, `error`, `errorMessage`, or simply omit the
			// required result. Normalize those signals before the sole release owner
			// decides whether continuation work may re-enter Pi.
			const failed = (event as any).success === false
				|| explicitCompactionError !== undefined
				|| (!aborted && (reason === "threshold" || reason === "overflow") && !result);
			if (reason !== "manual") {
				const pending = (session as any)._pendingCompactionStart as
					| {
						startedAtMs: number;
						trigger: "auto" | "overflow";
						compactionId: string;
						rpcClient: SessionInfo["rpcClient"];
						baselinePromise: Promise<TranscriptEntriesSnapshot | undefined>;
					}
					| undefined;
				(session as any)._pendingCompactionStart = undefined;
				if (pending) {
					const endedAtMs = this.clock.now();
					const success = !!result && !aborted && !failed;
					if (success) (event as any).compactionId = pending.compactionId;
					const entry: CompactionSidecarEntry = {
						schemaVersion: 1,
						id: pending.compactionId,
						trigger: pending.trigger,
						tokensBefore: result?.tokensBefore ?? null,
						tokensAfter: null,
						durationMs: endedAtMs - pending.startedAtMs,
						startedAt: new Date(pending.startedAtMs).toISOString(),
						endedAt: new Date(endedAtMs).toISOString(),
						success,
						error: success ? undefined : (explicitCompactionError || (aborted ? "aborted" : "compaction failed")),
						firstKeptEntryId: result?.firstKeptEntryId ?? null,
					};
					(session as any)._compactionFinalization = this.finalizeCompactionSidecar(
						session,
						pending.rpcClient,
						pending.baselinePromise,
						entry,
						result,
						!aborted,
					);
				}
			} else {
				const manualId = (session as any)._manualCompactionId as string | undefined;
				const baselinePromise = (session as any)._manualCompactionBaselinePromise as
					| Promise<TranscriptEntriesSnapshot | undefined>
					| undefined;
				const manualRpcClient = (session as any)._manualCompactionRpcClient as
					| SessionInfo["rpcClient"]
					| undefined;
				(session as any)._manualCompactionId = undefined;
				(session as any)._manualCompactionRpcClient = undefined;
				(session as any)._manualCompactionBaselinePromise = undefined;
				const success = !!manualId && !!result && !aborted && !failed;
				if (manualId && !aborted) (event as any).compactionId = manualId;
				if (manualId && success) {
					const endedAtMs = this.clock.now();
					const startedAtMs = parseCompactionStartMs(manualId) ?? endedAtMs;
					const entry: CompactionSidecarEntry = {
						schemaVersion: 1,
						id: manualId,
						trigger: "manual",
						tokensBefore: result?.tokensBefore ?? null,
						tokensAfter: null,
						durationMs: Math.max(0, endedAtMs - startedAtMs),
						startedAt: new Date(startedAtMs).toISOString(),
						endedAt: new Date(endedAtMs).toISOString(),
						success: true,
						firstKeptEntryId: result?.firstKeptEntryId ?? null,
					};
					(session as any)._compactionFinalization = this.finalizeCompactionSidecar(
						session,
						manualRpcClient ?? session.rpcClient,
						baselinePromise ?? Promise.resolve(undefined),
						entry,
						result,
						true,
						manualId,
					);
				} else if (!aborted) {
					void this.refreshAfterCompaction(session);
				}
			}
			const invalidatedAssistantStreamId = reason === "overflow"
				&& (event as any).willRetry === true
				? session.pendingRecoverableLengthStreamId
				: undefined;
			if (invalidatedAssistantStreamId) {
				// Pi rewrites the truncated length tail before retrying. Mirror that
				// canonical rewrite before releasing queued continuation work so every
				// client removes the provisional row before retry output can arrive.
				this.emitAgentEvent(session, {
					type: "assistant_stream_invalidated",
					assistantStreamId: invalidatedAssistantStreamId,
					reason: "overflow-retry",
				});
			}
			if (reason === "overflow") session.pendingRecoverableLengthStreamId = undefined;
			this.finishCompactionAndRelease(session, activeCompactionId, {
				willRetry: (event as any).willRetry === true,
				aborted,
				failed,
				reason,
			});
		} else if (event.type === "process_exit") {
			session._piAgentRunSettled = true;
			session.streamingStartedAt = undefined;
			this.resolveStoreForSession(session.id).update(session.id, {
				wasStreaming: false,
				streamingStartedAt: undefined,
			});
			const reason = event.signal ? `signal ${event.signal}` : `code ${event.code}`;
			const processExitError = `Agent process exited with ${reason}`;
			// Process exit settles the verifier's receipt surface immediately, but it
			// cannot prove whether the outstanding RPC write reached Pi. The later RPC
			// rejection therefore still retains its exact in-flight carrier uncertain.
			this.rejectAllVerifierPromptReceipts(session.id, processExitError);
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
					timestamp: this.clock.now(),
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
				for (const block of content) {
					if (block.type === "tool_use" && /^[Bb]ash$/.test(block.name) && block.input?.command) {
						if (PR_CMD_RE.test(block.input.command)) { prDetected = true; break; }
					}
					if (block.type === "tool_result") {
						const text = typeof block.content === "string" ? block.content
							: Array.isArray(block.content) ? block.content.map((c: any) => typeof c === "string" ? c : c.text || "").join("") : "";
						if (containsExactGithubPullRequestUrl(text)) { prDetected = true; break; }
					}
					if (block.type === "text" && typeof block.text === "string" && containsExactGithubPullRequestUrl(block.text)) {
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
		const BOUNDED_MAX_ATTEMPTS = BOUNDED_TRANSIENT_AUTO_RETRY_MAX_ATTEMPTS;
		const PROVIDER_BACKOFF_MAX_MS = 300_000; // 5 minutes
		const GENERIC_RETRY_DELAYS_MS = [1000, 5000, 60_000] as const;
		const errMsg = session.lastTurnErrorMessage || "";
		if (!errMsg) return false;
		// A poisoned transcript requires a user-driven sanitize/respawn. Never
		// arm an automatic timer that could repeatedly redispatch the same 400.
		if (isOrphanToolResultOrderingError(errMsg)) return false;
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
			scheduledAt: this.clock.now(),
			error: errMsg.slice(0, 200),
		};
		// WP4/RC3: route through emitSessionEvent so the frame gets a seq, enters
		// the EventBuffer, and replays on resume — a reconnect during backoff no
		// longer orphans a stale "Retrying…" banner (S5/S21).
		emitSessionEvent(session, pendingEvent);

		if (session.pendingAutoRetryTimer) this.clock.clearTimeout(session.pendingAutoRetryTimer);
		const generation = session.lifecycleGeneration ?? 0;
		session.pendingAutoRetryTimer = this.clock.setTimeout(() => {
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
		if (session.pendingAutoRetryTimer) this.clock.clearTimeout(session.pendingAutoRetryTimer);
		session.pendingAutoRetryTimer = undefined;
		if (!hadTimer && !opts?.emitWithoutTimer) return;
		if (reason !== "shutdown") {
			const cancelledEvent: AutoRetryCancelledEvent = {
				type: "auto_retry_cancelled",
				reason,
				cancelledAt: this.clock.now(),
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
		const restored = await this._respawnAgentInPlace(session, ps, { deferQueueDrain: true });
		return restored ?? this.sessions.get(session.id);
	}

	/**
	 * Repair an Anthropic orphan-tool-result poison, then serialize its redrive
	 * behind every lifecycle request accepted while repair was in flight. This
	 * second coordinated operation is part of the poison single-flight: role or
	 * restart replacement therefore commits first and the intent lands on the
	 * final canonical bridge; Stop/terminate suppress it without deleting intent.
	 */
	private async _recoverPoisonedHistory(
		session: SessionInfo,
		boundary: "retry" | "follow-up",
		redrive?: (target: SessionInfo) => Promise<void>,
	): Promise<SessionInfo | undefined> {
		const repaired = await this._coordinateSessionReplacement(session.id, "poison-recovery", async (token) => {
			const current = this.sessions.get(session.id) ?? session;
			let ps: PersistedSession | undefined;
			try { ps = this.resolveStoreForSession(session.id).get(session.id); }
			catch { ps = undefined; }
			if (!ps?.agentSessionFile) return undefined;

			const pendingPromptEnvelopes = current.pendingSkillExpansions?.slice();
			const recoveredPromptDispatchQueueIds = current.recoveredPromptDispatchQueueIds?.slice();
			const poisonRecoveryPromptDispatchQueueIds = current.poisonRecoveryPromptDispatchQueueIds?.slice();
			const savedSessionOnlyGrantedTools = current.sessionOnlyGrantedTools?.slice();
			const savedOneTimeGrantedTools = current.oneTimeGrantedTools?.slice();
			const overrideAllowedTools = this.recomputeAllowedToolsForRestart(current, ps);
			const fileCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
			const repairedRecords = await sanitizeAgentTranscriptFile(fileCtx, ps.agentSessionFile, this.sandboxManager);
			console.info(
				`[session-manager] Poisoned-history repair session=${session.id} boundary=${boundary} repairedRecords=${repairedRecords} sandboxed=${ps.sandboxed === true} project=${current.projectId ?? ps.projectId ?? "unknown"}`,
			);
			const restored = await this._respawnAgentInPlaceOwned(session.id, current, ps, {
				preserveSandboxRealm: current.sandboxed === true,
				deferQueueDrain: true,
				mutatePs: p => {
					if (overrideAllowedTools !== undefined) (p as any)._overrideAllowedTools = overrideAllowedTools;
					if (savedSessionOnlyGrantedTools !== undefined) (p as any)._overrideGrantedTools = savedSessionOnlyGrantedTools;
				},
			}, token);
			const target = restored ?? this.sessions.get(session.id);
			if (target && target !== current) {
				if (savedSessionOnlyGrantedTools) target.sessionOnlyGrantedTools = savedSessionOnlyGrantedTools;
				if (savedOneTimeGrantedTools) target.oneTimeGrantedTools = savedOneTimeGrantedTools;
				if (pendingPromptEnvelopes?.length) {
					target.pendingSkillExpansions = [
						...pendingPromptEnvelopes,
						...(target.pendingSkillExpansions ?? []),
					];
				}
				if (recoveredPromptDispatchQueueIds?.length) {
					target.recoveredPromptDispatchQueueIds = [
						...new Set([
							...recoveredPromptDispatchQueueIds,
							...(target.recoveredPromptDispatchQueueIds ?? []),
						]),
					];
				}
				if (poisonRecoveryPromptDispatchQueueIds?.length) {
					target.poisonRecoveryPromptDispatchQueueIds = [
						...new Set([
							...poisonRecoveryPromptDispatchQueueIds,
							...(target.poisonRecoveryPromptDispatchQueueIds ?? []),
						]),
					];
				}
			}
			return target;
		}, { coalesceKey: "poison-recovery", drainOnRelease: false, cancelOnTerminal: () => undefined });
		if (!repaired || !redrive) return repaired;

		return this._coordinateSessionReplacement(session.id, "poison-redrive", async (token) => {
			if (token.coordinator.terminalRequest) return undefined;
			const target = this.sessions.get(session.id);
			if (!target || target.status === "terminated" || target.dormant || target.lifecycleFenced) return undefined;
			// Dispatch recovery belongs to this generation. Make the canonical writer
			// current before the RPC so a rejected redrive can restore its durable row
			// and idle/error state instead of being discarded as a stale callback.
			target.lifecycleGeneration = token.generation;
			await redrive(target);
			return target;
		}, { coalesceKey: "poison-redrive", drainOnRelease: false, cancelOnTerminal: () => undefined });
	}

	private markPoisonRecoveryPromptDispatchRow(session: SessionInfo, id: string): void {
		session.poisonRecoveryPromptDispatchQueueIds = [
			...new Set([...(session.poisonRecoveryPromptDispatchQueueIds ?? []), id]),
		];
	}

	private clearRecoveredPromptDispatchOwnership(session: SessionInfo, ids: Iterable<string>): void {
		const cleared = new Set(ids);
		if (cleared.size === 0) return;
		session.recoveredPromptDispatchQueueIds = session.recoveredPromptDispatchQueueIds
			?.filter(id => !cleared.has(id));
		if (session.recoveredPromptDispatchQueueIds?.length === 0) {
			session.recoveredPromptDispatchQueueIds = undefined;
		}
		session.poisonRecoveryPromptDispatchQueueIds = session.poisonRecoveryPromptDispatchQueueIds
			?.filter(id => !cleared.has(id));
		if (session.poisonRecoveryPromptDispatchQueueIds?.length === 0) {
			session.poisonRecoveryPromptDispatchQueueIds = undefined;
		}
		if (session.explicitRetryQueueRowId && cleared.has(session.explicitRetryQueueRowId)) {
			session.explicitRetryQueueRowId = undefined;
		}
	}

	private consumeRecoveredPromptDispatchRows(session: SessionInfo, preserveIds?: ReadonlySet<string>): boolean {
		const ids = session.recoveredPromptDispatchQueueIds;
		if (!ids?.length) return false;
		const poisonOwned = new Set(session.poisonRecoveryPromptDispatchQueueIds ?? []);
		const supersededIds = ids.filter(id => !poisonOwned.has(id) && !preserveIds?.has(id));
		let removedAny = false;
		for (const id of supersededIds) {
			removedAny = session.promptQueue.remove(id) || removedAny;
		}
		this.clearRecoveredPromptDispatchOwnership(session, supersededIds);
		if (removedAny) this.broadcastQueue(session);
		return removedAny;
	}

	private findQueuedRetryRow(
		session: SessionInfo,
		candidateTexts: Array<string | undefined>,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
		excludeIds?: ReadonlySet<string>,
	): QueuedMessage | undefined {
		const textSet = new Set(candidateTexts.filter((text): text is string => typeof text === "string"));
		if (textSet.size === 0) return undefined;
		const imageSignature = JSON.stringify(images ?? []);
		return session.promptQueue.toArray().find((queued) => {
			if (excludeIds?.has(queued.id)) return false;
			if (!textSet.has(queued.text)) return false;
			return JSON.stringify(queued.images ?? []) === imageSignature;
		});
	}

	private consumeQueuedRetryRow(
		session: SessionInfo,
		candidateTexts: Array<string | undefined>,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
		excludeIds?: ReadonlySet<string>,
	): boolean {
		const row = this.findQueuedRetryRow(session, candidateTexts, images, excludeIds);
		if (!row) return false;
		const removed = session.promptQueue.remove(row.id);
		if (removed) this.broadcastQueue(session);
		return removed;
	}

	private enqueueDurableRetryRow(
		session: SessionInfo,
		text: string,
		images?: Array<{ type: "image"; data: string; mimeType: string }>,
	): QueuedMessage {
		const existing = session.explicitRetryQueueRowId
			? session.promptQueue.toArray().find(row => row.id === session.explicitRetryQueueRowId)
			: undefined;
		if (existing) {
			existing.source = "system";
			existing.author = BOBBIT_SYSTEM_AUTHOR;
			session.recoveredPromptDispatchQueueIds = [
				...new Set([...(session.recoveredPromptDispatchQueueIds ?? []), existing.id]),
			];
			session.promptQueue.reorderByIds([existing.id]);
			this.broadcastQueue(session);
			return existing;
		}
		const row = session.promptQueue.enqueueAtFront(text, {
			images,
			source: "system",
			author: BOBBIT_SYSTEM_AUTHOR,
		});
		session.explicitRetryQueueRowId = row.id;
		session.recoveredPromptDispatchQueueIds = [
			...new Set([...(session.recoveredPromptDispatchQueueIds ?? []), row.id]),
		];
		// enqueueAtFront preserves the queue's steer grouping. Explicit Retry is a
		// separate front-priority human action, so pin its unique row first by ID.
		session.promptQueue.reorderByIds([row.id]);
		this.broadcastQueue(session);
		return row;
	}

	private ensureDurableRetryRow(session: SessionInfo, accepted: QueuedMessage): string {
		if (!session.promptQueue.toArray().some(row => row.id === accepted.id)) {
			// Replacement reconciliation normally carries the persisted row. Retain
			// its original ID if a test/failure seam rebuilt SessionInfo without it.
			session.promptQueue = new PromptQueue([accepted, ...session.promptQueue.toArray()]);
		} else {
			session.promptQueue.reorderByIds([accepted.id]);
		}
		session.explicitRetryQueueRowId = accepted.id;
		this.broadcastQueue(session);
		return accepted.id;
	}

	getErroredPromptRecoveryDecision(sessionId: string): ErroredPromptRecoveryDecision {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return { recoverable: false, reason: "not-errored", message: "Session not found." };
		}
		return classifyErroredPromptRecovery(session);
	}

	enqueuePromptForRetryRecovery(sessionId: string, text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
		modelText?: string;
		suppressTitleGen?: boolean;
		source?: PromptSource;
		author?: MessageAuthor;
		intentId?: string;
	}): { status: "queued"; queuedId?: string } {
		const session = this.sessions.get(sessionId);
		if (!session) return { status: "queued" };
		const source = opts?.source ?? "user";
		const author = resolveAcceptedPromptAuthor(source, opts?.author);
		session.lastPromptSource = source;
		const dispatchText = synthesizeAttachmentText(opts?.modelText ?? text, opts?.images, opts?.attachments);
		const intentId = opts?.intentId ?? randomUUID();
		const queued = this.enqueueReliableIntent(session, this.makeReliableIntentRow(
			session,
			intentId,
			dispatchText,
			opts?.isSteered ? "steer" : "prompt",
			"next-turn",
			{
				images: opts?.images,
				attachments: opts?.attachments,
				suppressTitleGen: opts?.suppressTitleGen,
				source,
				author,
			},
		));
		this.broadcastQueue(session);
		return { status: "queued", queuedId: queued.id };
	}

	/**
	 * Retry after a model/API error. Behaviour depends on context:
	 * - Fresh response error (no tool calls): re-sends the original user prompt
	 * - Mid-work error (tool calls already executed): sends a system continuation
	 */
	async retryLastPrompt(sessionId: string, opts?: { auto?: boolean; preserveQueueIds?: string[] }): Promise<void> {
		this._assertModelSelectionReady(sessionId);
		// Join before looking up SessionInfo: a real in-place respawn removes the
		// old entry briefly, and duplicate Retry clicks must not fail or redrive.
		const poisonRecovery = this._poisonedHistoryRecoveries.get(sessionId);
		if (poisonRecovery) return poisonRecovery;
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		const isAuto = opts?.auto === true;
		this.setManualRetryRequired(session, false);
		// Retry is a proven new turn even before Pi's corresponding agent_start.
		// Rotate terminal identities so a synthetic poison-recovery/retry terminal
		// cannot be suppressed by the prior turn's replay guard.
		session.abortShapedTerminal = undefined;
		session.assistantTerminalIdentities = undefined;
		session.lastAssistantTerminalIdentity = undefined;
		session.turnTerminalHandled = false;
		const preserveQueueIds = new Set(opts?.preserveQueueIds ?? []);
		const hadToolCalls = session.turnHadToolCalls;
		// Capture all retry intent before any in-place respawn replaces SessionInfo.
		const poisonedByBlankText = isBlankContentBlockError(session.lastTurnErrorMessage);
		const poisonedByOrphanResult = isOrphanToolResultOrderingError(session.lastTurnErrorMessage);
		const savedPromptText = session.lastPromptText;
		const savedPromptImages = session.lastPromptImages;
		const savedPromptSource = session.lastPromptSource;

		if (poisonedByOrphanResult) {
			if (isAuto) {
				throw new Error("Poisoned session history requires a user Retry or follow-up prompt");
			}
			this.cancelPendingAutoRetry(session, "explicit-retry");
			const retryText = hadToolCalls
				? "[SYSTEM: The model API returned an error while you were mid-turn. " +
					"Your previous work has been preserved. Please continue where you left off. " +
					"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
				: (savedPromptText || savedPromptImages?.length)
					? synthesizeAttachmentText(savedPromptText ?? "", savedPromptImages)
					: "[SYSTEM: The model API returned an error on your last response. " +
						"Please review your conversation history and retry what you were doing.]";
			const retryImages = hadToolCalls ? undefined : savedPromptImages;
			// Explicit Retry owns a newly allocated durable row. Equal text/images in
			// the existing queue are independent accepted intent and must survive.
			const acceptedRetry = this.enqueueDurableRetryRow(session, retryText, retryImages);
			this.markPoisonRecoveryPromptDispatchRow(session, acceptedRetry.id);
			const recovery = (async () => {
				const target = await this._recoverPoisonedHistory(session, "retry", async (canonical) => {
					canonical.lastTurnErrored = false;
					canonical.lastTurnErrorMessage = undefined;
					canonical.turnHadToolCalls = false;
					canonical.consecutiveErrorTurns = 0;
					canonical.transientRetryAttempts = 0;
					canonical.lastPromptSource = savedPromptSource;
					const durableId = this.ensureDurableRetryRow(canonical, acceptedRetry);
					try {
						await this.dispatchDirectPrompt(canonical, retryText, retryImages, undefined, false, false, "system", BOBBIT_SYSTEM_AUTHOR, durableId);
					} catch (err) {
						canonical.lastTurnErrored = true;
						canonical.lastTurnErrorMessage = err instanceof Error ? err.message : String(err);
						throw err;
					}
					this.consumeRecoveredPromptDispatchRows(canonical);
				});
				if (!target && this.sessions.has(session.id)) {
					throw new Error(`Session ${session.id} has poisoned history but no persisted transcript to repair`);
				}
			})();
			this._poisonedHistoryRecoveries.set(sessionId, recovery);
			try {
				await recovery;
			} finally {
				if (this._poisonedHistoryRecoveries.get(sessionId) === recovery) {
					this._poisonedHistoryRecoveries.delete(sessionId);
				}
			}
			return;
		}

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
			// We know this turn was a blank-content poison, so attachment/image
			// content was present. For a legacy non-image attachment-only failure,
			// synthesizeAttachmentText can still return blank; never resend it.
			let retryText = synthesizeAttachmentText(savedPromptText ?? "", savedPromptImages);
			if (retryText.trim() === "") retryText = ATTACHMENT_ONLY_TEXT;
			const acceptedRetry = !isAuto ? this.enqueueDurableRetryRow(session, retryText, savedPromptImages) : undefined;
			const target = await this._recoverBlankTextPoison(session);
			const dispatchTarget = target ?? session;
			dispatchTarget.lastPromptText = retryText;
			dispatchTarget.lastPromptImages = savedPromptImages;
			const durableId = acceptedRetry ? this.ensureDurableRetryRow(dispatchTarget, acceptedRetry) : undefined;
			await this.dispatchDirectPrompt(dispatchTarget, retryText, savedPromptImages, undefined, false, false, "system", BOBBIT_SYSTEM_AUTHOR, durableId);
			return;
		}

		if (hadToolCalls) {
			// Agent was mid-work — send a system continuation prompt.
			const continuation =
				"[SYSTEM: The model API returned an error while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]";
			const acceptedRetry = !isAuto ? this.enqueueDurableRetryRow(session, continuation) : undefined;
			await this.dispatchDirectPrompt(session, continuation, undefined, undefined, false, false, "system", BOBBIT_SYSTEM_AUTHOR, acceptedRetry?.id);
		} else if (session.lastPromptText || session.lastPromptImages?.length) {
			// Fresh response error — re-send the original prompt. Run the text
			// through synthesizeAttachmentText so an already-stuck session whose
			// last prompt was image/attachment-only (lastPromptText blank or
			// whitespace) re-dispatches with a valid non-blank body AND preserves
			// the image, instead of replaying blank text or falling through to the
			// generic fallback branch (which drops the image).
			const retryText = synthesizeAttachmentText(session.lastPromptText ?? "", session.lastPromptImages);
			// Dispatch failures before agent_start re-enqueue the failed row for
			// recovery. Auto retry may use the legacy text fallback; explicit Retry
			// consumes only the ID ledger and allocates its own unique durable row.
			// An auto-retried verifier row remains the same durable acceptance until
			// the provider accepts it or terminal recovery settles its receipt. Other
			// recovered work retains the historical consume-and-redrive behaviour.
			const recoveredVerifierRow = isAuto
				? session.recoveredPromptDispatchQueueIds
					?.map((id) => session.promptQueue.toArray().find((row) => row.id === id))
					.find((row): row is QueuedMessage => row?.verifierOwned === true)
				: undefined;
			const consumedRecovered = this.consumeRecoveredPromptDispatchRows(
				session,
				recoveredVerifierRow ? new Set([recoveredVerifierRow.id]) : undefined,
			);
			if (!recoveredVerifierRow && !consumedRecovered && isAuto) {
				this.consumeQueuedRetryRow(session, [retryText, session.lastPromptText], session.lastPromptImages, preserveQueueIds);
			}
			const acceptedRetry = !isAuto ? this.enqueueDurableRetryRow(session, retryText, session.lastPromptImages) : undefined;
			// Manual recovery belongs only to an explicit Retry's newly accepted
			// durable row. Automatic retries keep their bounded budget, whether
			// they consume ordinary recovered work or redrive a verifier's same row.
			const manualRecoveryRequired = acceptedRetry !== undefined;
			await this.dispatchDirectPrompt(
				session,
				retryText,
				session.lastPromptImages,
				undefined,
				false,
				false,
				recoveredVerifierRow?.source ?? "system",
				recoveredVerifierRow?.author ?? BOBBIT_SYSTEM_AUTHOR,
				acceptedRetry?.id ?? recoveredVerifierRow?.id,
				undefined,
				recoveredVerifierRow?.streamingBehavior,
				manualRecoveryRequired,
				recoveredVerifierRow?.verifierOwned === true,
				recoveredVerifierRow?.suppressTitleGen === true,
			);
		} else {
			// Fallback (e.g. session predates error tracking)
			this.consumeRecoveredPromptDispatchRows(session);
			const fallback =
				"[SYSTEM: The model API returned an error on your last response. " +
				"Please review your conversation history and retry what you were doing.]";
			const acceptedRetry = !isAuto ? this.enqueueDurableRetryRow(session, fallback) : undefined;
			await this.dispatchDirectPrompt(session, fallback, undefined, undefined, false, false, "system", BOBBIT_SYSTEM_AUTHOR, acceptedRetry?.id);
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
	async grantToolPermission(sessionId: string, toolName: string, scope: "tool" | "group", group?: string, mode?: ToolGrantMode, permissionId?: string): Promise<string[]> {
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
			const mcpManager = this.getMcpManagerForContext(session.projectId, session.cwd);
			if (mcpManager) {
				for (const info of mcpManager.getToolInfos()) {
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
			const toolManager = this.getToolManagerForProject(session.projectId);
			if (toolManager) {
				for (const tool of toolManager.getAvailableTools(scopedToolContext(session.projectId, session.cwd))) {
					if (tool.group === group) grantScopeTools.push(tool.name);
				}
			}
		} else {
			grantScopeTools.push(toolName);
		}
		// A group approval is bounded by the group's currently registered members.
		// If marketplace invalidation removed the group between request and approval,
		// never reinterpret the stale request name as an individual grant or restart
		// the runtime merely to install the already-current empty catalogue.
		const approvedGrantTools = scope === "group"
			? this.mergeToolNames(undefined, grantScopeTools) ?? []
			: this.mergeToolNames(undefined, [toolName]) ?? [toolName];

		if (permissionId && !session.pendingGrantRequest) {
			throw new Error(`Ignored stale permission grant for ${toolName}; request is no longer pending.`);
		}

		if (session.pendingGrantRequest) {
			const pending = session.pendingGrantRequest;
			if (permissionId && pending.id !== permissionId) {
				throw new Error(`Ignored stale permission grant for ${toolName}; active request changed.`);
			}
			const requestedToolMatches = pending.toolName.toLowerCase() === toolName.toLowerCase();
			const requestedGroupMatches = !!group && pending.toolGroup.toLowerCase() === group.toLowerCase();
			const approvedToolsCoverPending = approvedGrantTools.some(t => t.toLowerCase() === pending.toolName.toLowerCase());
			const grantCoversPending = scope === "group"
				? requestedGroupMatches && approvedToolsCoverPending
				: requestedToolMatches && approvedToolsCoverPending;
			if (!grantCoversPending) {
				const reason = `Ignored stale permission grant for ${toolName}; active request is for ${pending.toolName}.`;
				if (permissionId) {
					// Id-based UI actions are stale; leave the current request pending.
					throw new Error(reason);
				}
				// Legacy callers have no request id, so fail closed by resolving the
				// active guard immediately rather than letting its long-poll timeout.
				const requests = pending.requests?.length ? pending.requests : [{ resolve: pending.resolve, reject: pending.reject, timer: pending.timer, seq: pending.seq, ts: pending.ts }];
				for (const req of requests) this.clock.clearTimeout(req.timer);
				session.pendingGrantRequest = undefined;
				for (const req of requests) req.resolve({ granted: false, reason });
				broadcast(session.clients, {
					type: "tool_permission_settled",
					toolName: pending.toolName,
					group: pending.toolGroup,
					status: "error",
					reason,
				});
				return session.allowedTools ?? [];
			}
		}

		if (approvedGrantTools.length === 0) return session.allowedTools ?? [];

		let resultTools: string[];

		if (mode === "one-time") {
			// Temporary grant: add to session.allowedTools, but only track newly
			// introduced tools for revocation on agent_end. Group grants may include
			// tools already allowed/session-only; those must survive the one-time turn.
			const previouslyAllowed = new Set((session.allowedTools ?? []).map(t => t.toLowerCase()));
			const newlyAllowed = approvedGrantTools.filter(t => !previouslyAllowed.has(t.toLowerCase()));
			session.allowedTools = this.mergeToolNames(session.allowedTools, approvedGrantTools) ?? [];
			session.oneTimeGrantedTools = this.mergeToolNames(session.oneTimeGrantedTools, newlyAllowed);
			resultTools = session.allowedTools;

		} else if (mode === "session-only") {
			// Session-scoped grant: add to session.allowedTools only, don't write role YAML
			session.allowedTools = this.mergeToolNames(session.allowedTools, approvedGrantTools) ?? [];
			session.sessionOnlyGrantedTools = this.mergeToolNames(session.sessionOnlyGrantedTools, approvedGrantTools);
			resultTools = session.allowedTools;

		} else {
			// Persistent grants must be written at the role winner's mutable config
			// scope. A normal project never mutates the injected server RoleManager:
			// server/builtin/global-user winners are copied into the project's user
			// role pack, while immutable market-pack winners remain session-only.
			const updatedPolicies = { ...role.toolPolicies };
			for (const t of approvedGrantTools) {
				updatedPolicies[t] = 'allow' as GrantPolicy;
			}
			let effectiveRole: Role = { ...role, toolPolicies: updatedPolicies };
			let persistedGrant = false;
			const configProjectId = normalizeConfigProjectId(session.projectId);
			if (configProjectId) {
				const projectRoleStore = this.projectContextManager?.getOrCreate(configProjectId)?.roleStore;
				let resolvedEntry: ReturnType<NonNullable<typeof this.configCascade>["resolveRolesEntries"]>[number] | undefined;
				if (projectRoleStore && this.configCascade) {
					try {
						resolvedEntry = this.configCascade.resolveRolesEntries(configProjectId).find(entry => entry.item.name === role.name);
					} catch { /* fail closed to a session-only grant */ }
				}
				const immutableWinner = resolvedEntry?.origin.kind === "market"
					|| (resolvedEntry?.origin.readOnly === true && resolvedEntry.origin.kind !== "builtin");
				if (projectRoleStore && resolvedEntry && !immutableWinner) {
					projectRoleStore.put({
						...resolvedEntry.item,
						toolPolicies: updatedPolicies,
						updatedAt: Date.now(),
					});
					persistedGrant = true;
					effectiveRole = this.resolveSessionRole(role.name, undefined, session.projectId) ?? effectiveRole;
				}
			} else {
				const writableRole = this.roleManager.getRole(role.name);
				if (writableRole) {
					persistedGrant = this.roleManager.updateRole(role.name, { toolPolicies: updatedPolicies });
					if (persistedGrant) {
						effectiveRole = this.resolveSessionRole(role.name, undefined, session.projectId) ?? effectiveRole;
					}
				}
			}
			if (!persistedGrant) {
				session.sessionOnlyGrantedTools = this.mergeToolNames(session.sessionOnlyGrantedTools, approvedGrantTools);
			}
			const updatedEffective = this.resolveEffectiveAllowedTools(effectiveRole, session.projectId, session.cwd).map(e => e.name);
			session.allowedTools = this.mergeToolNames(updatedEffective, persistedGrant ? undefined : approvedGrantTools) ?? updatedEffective;
			resultTools = session.allowedTools;
		}

		if (session.pendingGrantRequest) {
			// Batched grant resumption: every same-tool guard long-poll receives only
			// the approved grant scope/delta and lets its blocked call continue.
			// Returning the full effective surface here would let unrelated ask-gated
			// tools bypass future prompts in the active process.
			const pending = session.pendingGrantRequest;
			const requests = pending.requests?.length ? pending.requests : [{ resolve: pending.resolve, reject: pending.reject, timer: pending.timer, seq: pending.seq, ts: pending.ts }];
			for (const req of requests) this.clock.clearTimeout(req.timer);
			session.pendingGrantRequest = undefined;
			for (const req of requests) req.resolve({ granted: true, tools: approvedGrantTools, scope, group, mode: mode ?? "persistent" });
			broadcast(session.clients, {
				type: "tool_permission_settled",
				toolName: pending.toolName,
				group: pending.toolGroup,
				status: "granted",
			});
			return resultTools;
		}

		await this._restartSessionWithUpdatedRole(session);
		return resultTools;
	}

	/**
	 * Called by the guard extension's long-poll endpoint. Creates a pending
	 * grant request, broadcasts to UI clients, and returns a promise that
	 * resolves when the user grants/denies or after a 5-minute timeout.
	 */
	async requestToolGrant(sessionId: string, toolName: string, toolGroup: string): Promise<ToolGrantResolution> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		// A later same-tool guard call can arrive after the user already approved
		// a session-scoped grant. Short-circuit only explicit session grants here:
		// one-time grants are intentionally invocation/batch-scoped and are resolved
		// through the pending request list, not treated as broad tool access.
		const toolLower = toolName.toLowerCase();
		const hasTool = (tools?: string[]) => tools?.some((t) => t.toLowerCase() === toolLower) ?? false;
		if (hasTool(session.sessionOnlyGrantedTools)) {
			return { granted: true, tools: [toolName], scope: "tool", group: toolGroup, mode: "session-only" };
		}

		// If a different grant request is still pending, resolve it as denied and
		// tell clients it is no longer actionable before broadcasting the new one.
		// Same-tool parallel calls are batched under one user decision instead.
		const existingPending = session.pendingGrantRequest;
		const samePendingTool = !!existingPending
			&& existingPending.toolName.toLowerCase() === toolName.toLowerCase()
			&& existingPending.toolGroup.toLowerCase() === toolGroup.toLowerCase();
		if (existingPending && !samePendingTool) {
			const pending = existingPending;
			const requests = pending.requests?.length ? pending.requests : [{ resolve: pending.resolve, reject: pending.reject, timer: pending.timer, seq: pending.seq, ts: pending.ts }];
			for (const req of requests) {
				this.clock.clearTimeout(req.timer);
				req.resolve({ granted: false });
			}
			session.pendingGrantRequest = undefined;
			broadcast(session.clients, {
				type: "tool_permission_settled",
				toolName: pending.toolName,
				group: pending.toolGroup,
				status: "superseded",
				reason: "A newer permission request replaced this one.",
			});
		}

		let seq: number;
		let ts: number;
		let requestCount = 1;

		if (samePendingTool && session.pendingGrantRequest) {
			const pending = session.pendingGrantRequest;
			seq = pending.seq;
			ts = pending.ts;
			const promise = new Promise<ToolGrantResolution>((resolve, reject) => {
				let request: NonNullable<typeof pending.requests>[number];
				const timer = this.clock.setTimeout(() => {
					const live = session.pendingGrantRequest;
					if (live?.requests?.length && request) {
						live.requests = live.requests.filter((req) => req !== request);
						if (live.requests.length > 0) {
							resolve({ granted: false, reason: "Permission request expired." });
							return;
						}
					}
					session.pendingGrantRequest = undefined;
					broadcast(session.clients, {
						type: "tool_permission_settled",
						toolName,
						group: toolGroup,
						status: "expired",
						reason: "Permission request expired.",
					});
					resolve({ granted: false, reason: "Permission request expired." });
				}, 5 * 60 * 1000);
				request = { resolve, reject, timer, seq, ts };
				pending.requests = pending.requests?.length
					? [...pending.requests, request]
					: [{ resolve: pending.resolve, reject: pending.reject, timer: pending.timer, seq: pending.seq, ts: pending.ts }, request];
				requestCount = pending.requests.length;
			});
			const roleName = session.role || "general";
			const role = this.roleManager?.getRole(roleName);
			broadcast(session.clients, {
				type: "tool_permission_needed",
				id: pending.id,
				toolName,
				group: toolGroup,
				roleName: role?.name ?? roleName,
				roleLabel: role?.label ?? roleName,
				lastPromptText: session.lastPromptText,
				requestCount,
			});
			return promise;
		}

		// Stamp seq+ts so client reducer can order this frame relative to live
		// `event` frames. See docs/design/unified-message-ordering-reducer.md §3.1.
		// IMPORTANT: this is the ONLY frame-allocation callsite in src/server/.
		const frame = session.eventBuffer.pushFrame();
		seq = frame.seq;
		ts = frame.ts;
		const permissionId = `perm_${seq}_${toolName}`;

		const promise = new Promise<ToolGrantResolution>((resolve, reject) => {
			let request: NonNullable<NonNullable<SessionInfo["pendingGrantRequest"]>["requests"]>[number];
			const timer = this.clock.setTimeout(() => {
				const live = session.pendingGrantRequest;
				if (live?.requests?.length && request) {
					live.requests = live.requests.filter((req) => req !== request);
					if (live.requests.length > 0) {
						resolve({ granted: false, reason: "Permission request expired." });
						return;
					}
				}
				session.pendingGrantRequest = undefined;
				resolve({ granted: false, reason: "Permission request expired." });
				broadcast(session.clients, {
					type: "tool_permission_settled",
					toolName,
					group: toolGroup,
					status: "expired",
					reason: "Permission request expired.",
				});
			}, 5 * 60 * 1000); // 5 minute timeout
			request = { resolve, reject, timer, seq, ts };
			session.pendingGrantRequest = { id: permissionId, resolve, reject, toolName, toolGroup, timer, seq, ts, requests: [request] };
		});

		// Broadcast to UI clients
		const roleName = session.role || "general";
		const role = this.roleManager?.getRole(roleName);
		broadcast(session.clients, {
			type: "tool_permission_needed",
			id: permissionId,
			toolName,
			group: toolGroup,
			roleName: role?.name ?? roleName,
			roleLabel: role?.label ?? roleName,
			lastPromptText: session.lastPromptText,
			requestCount,
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
	denyToolPermission(sessionId: string, _toolName: string, permissionId?: string): void {
		const session = this.sessions.get(sessionId);
		if (!session?.pendingGrantRequest) return;
		const pending = session.pendingGrantRequest;
		if (_toolName && pending.toolName.toLowerCase() !== _toolName.toLowerCase()) return;
		if (permissionId && pending.id !== permissionId) return;
		const requests = pending.requests?.length ? pending.requests : [{ resolve: pending.resolve, reject: pending.reject, timer: pending.timer, seq: pending.seq, ts: pending.ts }];
		for (const req of requests) {
			this.clock.clearTimeout(req.timer);
			req.resolve({ granted: false });
		}
		session.pendingGrantRequest = undefined;
		broadcast(session.clients, {
			type: "tool_permission_settled",
			toolName: pending.toolName,
			group: pending.toolGroup,
			status: "denied",
		});
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
			// mergeToolNames treats two empty inputs as absent. Here the base is an
			// explicit session constraint, so preserve [] when there are no grants.
			return this.mergeToolNames(persistedAllowedTools, sessionGrants) ?? persistedAllowedTools;
		}

		// Normal sessions derive their tool surface from the current role/group/MCP
		// policy cascade. Only one-time/session-only grants are carried across the
		// respawn; the old live session.allowedTools is just a stale cache.
		if (!sessionGrants) return undefined;
		const restoredRole = this.resolveSessionRole(ps.role, ps.assistantType, ps.projectId);
		const recomputedAllowed = this.resolveEffectiveAllowedTools(restoredRole, ps.projectId, ps.cwd).map(t => t.name);
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
		opts?: {
			mutatePs?: (ps: PersistedSession) => void;
			finalStatus?: SessionStatus;
			/** Fail closed rather than moving a sandbox transcript onto a host bridge. */
			preserveSandboxRealm?: boolean;
			/** Poison redrive must dispatch its superseding intent before parked rows. */
			deferQueueDrain?: boolean;
			/** Reject at coordinated admission unless this exact bridge still owns the slot. */
			expectedOwner?: SessionBridgeOwner;
			/** Apply restartAgent's persisted zombie guard only after serialized ownership admission. */
			restartZombieGuard?: boolean;
			/** Restore an immutable caller-owned record rather than re-reading a possibly advanced store object. */
			useRequestedPersistedSnapshot?: boolean;
		},
	): Promise<SessionInfo | undefined> {
		return this._coordinateSessionReplacement(session.id, "respawn", (token) =>
			this._respawnAgentInPlaceOwned(session.id, session, ps, opts, token), {
				// Owner-sensitive recovery must reach its own serialized admission
				// check; joining a generic rehydrate would inherit another operation's
				// replacement without ever proving ownership of its stopped bridge.
				coalesceKey: opts?.expectedOwner ? undefined : "rehydrate",
				drainOnRelease: opts?.deferQueueDrain !== true,
				cancelOnTerminal: () => undefined,
			});
	}

	private async _respawnAgentInPlaceOwned(
		id: string,
		requestedSession: SessionInfo,
		requestedPs: PersistedSession,
		opts: {
			mutatePs?: (ps: PersistedSession) => void;
			finalStatus?: SessionStatus;
			preserveSandboxRealm?: boolean;
			deferQueueDrain?: boolean;
			expectedOwner?: SessionBridgeOwner;
			restartZombieGuard?: boolean;
			useRequestedPersistedSnapshot?: boolean;
		} | undefined,
		token: SessionReplacementToken,
	): Promise<SessionInfo | undefined> {
		// A role/restart queued ahead of us may already have replaced the object.
		// Ownership-sensitive recovery must reject at serialized admission instead
		// of re-resolving and stopping that newer canonical bridge.
		const canonical = this.sessions.get(id);
		if (
			opts?.expectedOwner
			&& (
				canonical !== opts.expectedOwner.session
				|| canonical?.rpcClient !== opts.expectedOwner.rpcClient
			)
		) {
			throw new Error(`Session ${id} respawn expected bridge ownership changed before coordinated admission`);
		}
		const session = canonical ?? requestedSession;
		const ps = opts?.restartZombieGuard
			? this._admitRestartPersistedSession(id)
			: opts?.useRequestedPersistedSnapshot
				? requestedPs
				: this.resolveStoreForId(id)?.get(id) ?? requestedPs;
		const savedClients = new Set(session.clients);
		session.unsubscribe();
		const frameOfRef = this._snapshotStreamingFrameOfReference(session);
		this._fenceReplacedSession(session, token.generation);
		// Verification restart-resume owns the next reviewer turn. Do not carry a
		// pre-restart verifier row into the replacement bridge where it could race
		// that harness-owned continuation; ordinary user/system rows are preserved.
		this.purgeVerifierPromptRows(id, `Verifier session ${id} restarted before dispatch`);
		try { await session.rpcClient.stop(); } catch { /* already dead */ }
		if (!this._replacementTokenIsCurrent(id, token) || this.sessions.get(id) !== session) {
			throw new Error(`Session ${id} respawn replacement was superseded after old bridge stop`);
		}

		this.sessions.delete(id);
		(ps as any)._restartFrameOfReference = frameOfRef;
		if (opts?.preserveSandboxRealm) (ps as any)._preserveSandboxRealm = true;
		opts?.mutatePs?.(ps);
		try {
			await this.restoreSession(ps);
			if (token.coordinator.terminalRequest) {
				const cancelled = this.sessions.get(id);
				if (cancelled && cancelled !== session) {
					try { cancelled.unsubscribe(); } catch { /* best-effort */ }
					await cancelled.rpcClient.stop().catch(() => {});
					this.sessions.delete(id);
				}
				throw new Error(`Session ${id} respawn cancelled by ${token.coordinator.terminalRequest}`);
			}
			if (!this._replacementTokenIsCurrent(id, token)) {
				const stale = this.sessions.get(id);
				if (stale && stale !== session) {
					try { stale.unsubscribe(); } catch { /* best-effort */ }
					await stale.rpcClient.stop().catch(() => {});
				}
				throw new Error(`Session ${id} respawn replacement was superseded during restore`);
			}
		} catch (err) {
			this.sessions.set(id, session);
			session.restoreError = err instanceof Error ? err.message : String(err);
			for (const ws of savedClients) {
				if ((ws as any).readyState === 1) session.clients.add(ws);
			}
			broadcastStatus(session, "terminated");
			this._trackConnectedSession(session);
			throw err;
		} finally {
			delete (ps as any)._restartFrameOfReference;
			delete (ps as any)._overrideAllowedTools;
			delete (ps as any)._overrideGrantedTools;
			delete (ps as any)._preserveSandboxRealm;
		}
		const restored = this.sessions.get(id);
		if (restored) {
			for (const ws of savedClients) {
				if ((ws as any).readyState === 1) restored.clients.add(ws);
			}
			broadcastStatus(restored, opts?.finalStatus ?? "idle");
			this._trackConnectedSession(restored);
		}
		return restored;
	}

	/**
	 * Read and admit restartAgent's canonical durable row while the replacement
	 * coordinator owns the session. Owner-sensitive callers reach this only after
	 * their exact bridge has passed admission, so a stale recovery cannot archive
	 * a row that an earlier replacement has already advanced.
	 */
	private _admitRestartPersistedSession(id: string): PersistedSession {
		const store = this.resolveStoreForId(id);
		if (!store) throw new Error("No persisted session data");
		const ps = store.get(id);
		if (!ps) throw new Error("No persisted session data");
		if (ps.agentSessionFile || ps.role) return ps;

		console.warn(
			`[session-manager] Session ${id} is an unrecoverable zombie ` +
			`(no agentSessionFile, no role) — archiving instead of restarting.`,
		);
		try {
			store.update(id, { archived: true, archivedAt: this.clock.now() });
		} catch (err) {
			console.error(`[session-manager] Failed to archive zombie session ${id}:`, err);
		}
		const zombieErr: Error & { code?: string } = new Error(
			`Session ${id} could not be restarted — neither an agent session file nor ` +
			`a role was persisted. The session has been archived; create a fresh session to continue.`,
		);
		zombieErr.code = "SESSION_UNRECOVERABLE_ARCHIVED";
		throw zombieErr;
	}

	/**
	 * Restart the agent process for a session whose process has died.
	 * Stops any remnant process, then restores from persisted state.
	 * Re-attaches existing WS clients so the user can keep working.
	 */
	async restartAgent(sessionId: string, expectedOwner?: SessionBridgeOwner): Promise<void> {
		this.assertSessionGoalPromotionMutationAllowed(sessionId);
		this._assertModelSelectionReady(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		const ps = this.resolveStoreForSession(session.id).get(session.id);
		if (!ps) throw new Error("No persisted session data");

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
			expectedOwner,
			restartZombieGuard: true,
		});

		if (restored) {
			if (savedSessionOnlyGrantedTools) restored.sessionOnlyGrantedTools = savedSessionOnlyGrantedTools;
			if (savedOneTimeGrantedTools) restored.oneTimeGrantedTools = savedOneTimeGrantedTools;
		} else {
			throw new Error("Failed to restore session after restart");
		}
	}

	/**
	 * Emit a live agent event to clients, suppressing retryable Pi agent_end
	 * events while forwarding completed compaction events independently.
	 * Pinned by tests2/core/pi-rpc-agent-end-retry.test.ts.
	 */
	private prepareVisibleAgentEvent(session: SessionInfo, event: unknown): unknown {
		const prepared = prepareVisibleAgentEvent(session, event, this.messageAuthorDependencies(session));
		if (!prepared || typeof prepared !== "object") return prepared;
		const visible = prepared as Record<string, any>;
		const assistant = visible.message?.role === "assistant";
		if (visible.type === "message_start" && assistant) {
			session.activeAssistantStreamId = `assistant-stream:${randomUUID()}`;
		}
		const assistantStreamId = assistant ? session.activeAssistantStreamId : undefined;
		if (assistantStreamId && (visible.type === "message_start" || visible.type === "message_update" || visible.type === "message_end")) {
			visible.assistantStreamId = assistantStreamId;
			visible.message = { ...visible.message, assistantStreamId };
		}
		if (visible.type === "message_end" && assistant) session.activeAssistantStreamId = undefined;
		if (visible.type === "agent_end" || visible.type === "process_exit") session.activeAssistantStreamId = undefined;
		return visible;
	}

	private emitAgentEvent(session: SessionInfo, event: unknown): void {
		if (isRetryableAgentEnd(event) || !this._sessionWriterIsCurrent(session)) return;
		emitSessionEvent(session, truncateLargeToolContent(event));
	}

	private async readCompactionTranscriptEntries(
		rpcClient: SessionInfo["rpcClient"],
	): Promise<TranscriptEntriesSnapshot | undefined> {
		if (typeof rpcClient.getTranscriptEntries !== "function") return undefined;
		try {
			const response = await rpcClient.getTranscriptEntries();
			return response?.success ? response.data as TranscriptEntriesSnapshot : undefined;
		} catch {
			return undefined;
		}
	}

	private async finalizeCompactionSidecar(
		session: SessionInfo,
		rpcClient: SessionInfo["rpcClient"],
		baselinePromise: Promise<TranscriptEntriesSnapshot | undefined>,
		entry: CompactionSidecarEntry,
		result: { summary?: string; tokensBefore?: number; firstKeptEntryId?: string } | undefined,
		refresh: boolean,
		manualId?: string,
	): Promise<void> {
		const baseline = await baselinePromise.catch(() => undefined);
		const post = await this.readCompactionTranscriptEntries(rpcClient);
		if (this.sessions.get(session.id) !== session || session.rpcClient !== rpcClient) return;
		let transcriptCompactionEntryId: string | undefined;
		if (baseline && post
			&& typeof result?.summary === "string"
			&& typeof result.firstKeptEntryId === "string"
			&& typeof result.tokensBefore === "number"
			&& Number.isFinite(result.tokensBefore)) {
			transcriptCompactionEntryId = resolveCompactionTranscriptEntryId(baseline, post, {
				summary: result.summary,
				firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
			});
		}
		const wrote = appendCompactionSidecarEntry(session.id, {
			...entry,
			...(transcriptCompactionEntryId ? { transcriptCompactionEntryId } : {}),
		});
		if (manualId && wrote) (session as any)._manualSidecarWritten = manualId;
		if (refresh) await this.refreshAfterCompaction(session);
	}

	/**
	 * Pi emits id-less message events before its append step. At agent_start the
	 * prompt is durable, so schedule an authoritative read-only snapshot behind
	 * the current event call stack and enrich the existing row with its cursor.
	 * The final refresh also settles sidecar bindings and remains a fallback for
	 * transient persistence lag at turn start.
	 */
	private schedulePromptCursorRefresh(
		session: SessionInfo,
		options: { settleBindings?: boolean } = {},
	): void {
		if (typeof session.rpcClient.getTranscriptCursorSnapshot !== "function"
			|| (session.clients.size === 0 && !session.pendingSkillTranscriptBindings?.length)) return;
		const rpcClient = session.rpcClient;
		const refreshGeneration = (session.promptCursorRefreshGeneration ?? 0) + 1;
		session.promptCursorRefreshGeneration = refreshGeneration;
		queueMicrotask(() => {
			if (this.sessions.get(session.id) !== session || session.rpcClient !== rpcClient) return;
			// A newer refresh supersedes only the client replacement. A final-turn
			// refresh must still settle its captured sidecar bindings from the exact
			// authoritative snapshot pair, even if the next turn has already started.
			if (!options.settleBindings
				&& session.promptCursorRefreshGeneration !== refreshGeneration) return;
			const pendingBindings = options.settleBindings
				? [...(session.pendingSkillTranscriptBindings ?? [])]
				: [];
			void this.getMessagesSnapshotBase(session).then((response) => {
				if (!response.success || response.data === undefined) return;
				if (this.sessions.get(session.id) !== session || session.rpcClient !== rpcClient) return;
				if (options.settleBindings && pendingBindings.length > 0) {
					session.pendingSkillTranscriptBindings = session.pendingSkillTranscriptBindings
						?.filter((binding) => !pendingBindings.includes(binding));
				}
				const messages = Array.isArray(response.data)
					? response.data
					: response.data && typeof response.data === "object" && Array.isArray((response.data as any).messages)
						? (response.data as any).messages
						: undefined;
				if (messages && response.cursorEntryIds) {
					for (const binding of pendingBindings) {
						const matches: number[] = [];
						for (let index = 0; index < messages.length; index++) {
							const message = messages[index];
							if (!message || typeof message !== "object"
								|| (message.role !== "user" && message.role !== "user-with-attachments")
								|| extractUserMessageText(message) !== binding.modelText) continue;
							if ("id" in binding.messageIdentity) {
								if (message.id === binding.messageIdentity.id) matches.push(index);
							} else if (typeof message.id !== "string"
								&& message.timestamp === binding.messageIdentity.timestamp) {
								matches.push(index);
							}
						}
						if (matches.length !== 1) continue;
						const transcriptEntryId = response.cursorEntryIds[matches[0]];
						if (!isPiTranscriptEntryId(transcriptEntryId)) continue;
						appendSkillSidecarTranscriptBinding(session.id, binding.recordId, transcriptEntryId);
					}
				}
				if (session.promptCursorRefreshGeneration !== refreshGeneration) return;
				if (session.clients.size > 0) {
					const data = this.buildVisibleMessageSnapshot(session.id, response.data);
					broadcast(session.clients, { type: "messages", data: data as unknown[] });
				}
			}).catch((error) => {
				console.warn(`[session-manager] Failed to refresh settled prompt cursors for ${session.id}:`, error);
			});
		});
	}

	/**
	 * Check an event for usage data and record it via the cost tracker.
	 * Broadcasts a cost_update to connected clients if cost data is found.
	 */
	private trackCostFromEvent(session: SessionInfo, event: any, replacementOwned = false): void {
		if (!replacementOwned && !this._sessionWriterIsCurrent(session)) return;
		// Message updates repeat the same usage on every streaming chunk, so only
		// completed assistant messages are accounted. Pi 0.81 additionally reports
		// summarizer usage once on each completed compaction event.
		const assistantMessageEnd = event.type === "message_end" && event.message?.role === "assistant";
		const compactionEnd = event.type === "compaction_end" || event.type === "auto_compaction_end";
		if (!assistantMessageEnd && !compactionEnd) return;
		const usage = assistantMessageEnd
			? (event.message?.usage ?? event.usage)
			: (event.result?.usage ?? event.usage);
		if (!usage) return;

		// Usage cost can be either a number (usage.cost) or an object (usage.cost.total)
		const costValue = typeof usage.cost === "number" ? usage.cost
			: typeof usage.cost?.total === "number" ? usage.cost.total
			: undefined;
		if (costValue === undefined) return;

		const sessionCostTracker = this.resolveCostTracker(session);
		const stampGoalId = session.goalId ?? session.teamGoalId;
		const cumulativeCost = sessionCostTracker.recordUsage(session.id, {
			inputTokens: usage.inputTokens ?? usage.input,
			outputTokens: usage.outputTokens ?? usage.output,
			cacheReadTokens: usage.cacheReadTokens ?? usage.cacheRead,
			cacheWriteTokens: usage.cacheWriteTokens ?? usage.cacheWrite,
			cost: costValue,
		}, stampGoalId);

		broadcast(session.clients, {
			type: "cost_update",
			sessionId: session.id,
			goalId: session.goalId,
			taskId: this.resolveTaskIdForSession(session.id),
			cost: cumulativeCost,
		});
	}

	/**
	 * Restore sessions from disk on startup.
	 * Re-spawns agent processes and uses switch_session to resume each one.
	 */
	async restoreSessions(): Promise<void>;
	async restoreSessions(suppressedSessionIds: ReadonlySet<string>): Promise<void>;
	async restoreSessions(suppressedSessionIds: ReadonlySet<string> = new Set()): Promise<void> {
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

		const livePersisted = this.projectContextManager
			? [...this.projectContextManager.getAllLiveSessions()]
			: (this._testStore?.getLive() ?? []);
		// Defensive terminal-owner fence. Use the same durable-ownership classifier
		// as reconciliation: every exact archived-goal `teamGoalId` match and its
		// canonical descendants are suppressed, while `goalId` alone stays eager.
		const terminalSuppressed = new Set(suppressedSessionIds);
		if (this.projectContextManager) {
			for (const context of this.projectContextManager.all()) {
				// Minimal SessionManager fixtures intentionally provide session state only.
				// Without a goal resolver there is no authoritative archived-owner fact,
				// so preserve the legacy full eager restore instead of guessing from metadata.
				if (!context.goalStore?.get) continue;
				const contextLive = context.sessionStore.getLive();
				const teamEntries = context.teamStore?.getAll?.() ?? [];
				const archivedGoalIds = new Set<string>();
				for (const session of contextLive) {
					if (session.teamGoalId && context.goalStore.get(session.teamGoalId)?.archived) archivedGoalIds.add(session.teamGoalId);
				}
				for (const entry of teamEntries) {
					if (context.goalStore.get(entry.goalId)?.archived) archivedGoalIds.add(entry.goalId);
				}
				for (const goalId of archivedGoalIds) {
					const entry = teamEntries.find((candidate) => candidate.goalId === goalId);
					const references = new Set<string>();
					if (entry?.teamLeadSessionId) references.add(entry.teamLeadSessionId);
					for (const agent of entry?.agents ?? []) references.add(agent.sessionId);
					for (const id of collectTeamOwnedSessionClosure(goalId, contextLive, references)) terminalSuppressed.add(id);
				}
			}
		} else if (this._testGoalManager) {
			const archivedGoalIds = new Set(livePersisted
				.map((session) => session.teamGoalId)
				.filter((goalId): goalId is string => !!goalId && this.resolveGoal(goalId)?.archived === true));
			for (const goalId of archivedGoalIds) {
				for (const id of collectTeamOwnedSessionClosure(goalId, livePersisted)) terminalSuppressed.add(id);
			}
		}
		const persisted = livePersisted.filter((session) => !terminalSuppressed.has(session.id));
		if (terminalSuppressed.size > 0) {
			console.warn(`[session-manager] Suppressed ${terminalSuppressed.size} archived-team session(s) from boot dispatch`);
		}
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
			if (!ps.agentSessionFile) {
				if (this.preservePromotedSessionAfterRecoveryFailure(ps, "archive its missing-transcript record")) continue;
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
				if (this.preservePromotedSessionAfterRecoveryFailure(ps, "archive its orphaned delegate record")) continue;
				try { this.getSessionStore(ps.projectId).archive(ps.id); } catch { /* project gone */ }
				continue;
			}
			delegateSurvivors.push(ps);
		}

		const liveRestore = [...regular, ...delegateSurvivors];
		console.log(`[session-manager] Restoring ${regular.length} session(s) + ${delegateSurvivors.length} delegate(s) live...`);

		// Restore the unchanged eager set in adaptive batches. Lag only changes
		// simultaneous width and the inter-batch yield; every candidate is attempted
		// exactly once, in the existing regular + delegate-survivor order.
		const lagMonitor = this.startBootRestoreLagMonitor();
		try {
			for (let i = 0; i < liveRestore.length;) {
				const lagMs = lagMonitor.sample();
				const CONCURRENCY = this.concurrencyForBootLag(lagMs);
				const batch = liveRestore.slice(i, i + CONCURRENCY);
				await Promise.all(batch.map(ps => this.restoreOneSession(ps)));
				i += batch.length;
				if (i < liveRestore.length) {
					await this.yieldBootRestore(lagMs >= 200 ? 25 : 0);
				}
			}
		} finally {
			lagMonitor.disable();
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
					this.assertPromotedSessionRecoveryAllowed(ps.id, "repair or recreate its host worktree");
					const { recoverWorktree } = await import("../skills/git.js");
					const recovered = await recoverWorktree(ps.repoPath, ps.branch, ps.worktreePath, this.commandRunner, this.remoteGitPolicy);
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
				if (ps.agentSessionFile) {
					const activePath = this._hostTrackedTranscriptPath(ps, ps.agentSessionFile);
					if (activePath) tracked.add(activePath);
				}
				for (const boundary of normalizeContextClearBoundaries(ps.contextClearBoundaries)) {
					if (!boundary.previousTranscriptMaterialized) continue;
					const historicalPath = this._hostTrackedTranscriptPath(ps, boundary.previousAgentSessionFile);
					if (historicalPath) tracked.add(historicalPath);
				}
				if (ps.lastActivity && ps.lastActivity > mostRecent) mostRecent = ps.lastActivity;
			}
			// If the store is empty (fresh install), use a 24h floor so we don't
			// flag every transcript from a previous install.
			const floor = mostRecent > 0 ? mostRecent : (this.clock.now() - 24 * 60 * 60 * 1000);
			const result = await scanOrphanedTranscriptsAsync(agentSessionsRoot, tracked, floor);
			this.orphanedTranscriptsCount = result.count;
			if (result.count > 0) {
				console.warn(`[session-store] WARN: ${result.count} agent transcript(s) on disk are not tracked in sessions.json`);
			}
		} catch (err) {
			console.warn("[session-manager] orphan-transcript scan failed:", err);
		}
	}

	/** Map observed boot event-loop lag to a bounded eager restore width. */
	private concurrencyForBootLag(lagMs: number): number {
		const nominal = 5;
		if (!Number.isFinite(lagMs) || lagMs <= 50) return nominal;
		if (lagMs >= 200) return 1;
		const fraction = (lagMs - 50) / (200 - 50);
		return Math.max(1, Math.min(nominal, Math.round(nominal - fraction * (nominal - 1))));
	}

	/** Enable a restore-scoped lag sampler. Real histograms are always disabled
	 * in the returned cleanup, including when a restore attempt throws. */
	private startBootRestoreLagMonitor(): { sample: () => number; disable: () => void } {
		if (this._bootRestoreLagSampler) {
			return {
				sample: () => {
					try { return this._bootRestoreLagSampler?.() ?? 0; } catch { return 0; }
				},
				disable: () => {},
			};
		}
		const histogram = monitorEventLoopDelay({ resolution: 20 });
		histogram.enable();
		return {
			sample: () => {
				const lagMs = histogram.max / 1e6;
				histogram.reset();
				return Number.isFinite(lagMs) ? lagMs : 0;
			},
			disable: () => histogram.disable(),
		};
	}

	private async yieldBootRestore(delayMs: number): Promise<void> {
		await new Promise<void>((resolve) => globalThis.setTimeout(resolve, Math.max(0, Math.min(25, delayMs))));
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
		if (!ps.projectId && !ps.goalId) {
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
				if (this.preservePromotedSessionAfterRecoveryFailure(ps, "archive its orphaned child record")) return;
				sessionStore.archive(ps.id);
				return;
			}
		}
		if (!ps.agentSessionFile) {
			// No session file path — persistSessionMetadata never completed.
			// Try to recover by scanning the sessions dir for a matching .jsonl.
			const recovered = this.recoverSessionFile(ps);
			if (recovered) {
				console.log(`[session-manager] Recovered session file for ${ps.id}: ${recovered}`);
				sessionStore.update(ps.id, { agentSessionFile: recovered });
				ps = { ...ps, agentSessionFile: recovered };
				// Fall through to normal restore below
			} else {
				if (await shouldKeepDespiteOrphan(ps)) {
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
				if (this.preservePromotedSessionAfterRecoveryFailure(ps, "archive its missing-transcript record")) return;
				sessionStore.archive(ps.id);
				return;
			}
		}
		trustPersistedAgentSessionFile(ps.agentSessionFile);
		const fileCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
		const fileFound = await sessionFileExists(fileCtx, ps.agentSessionFile, this.sandboxManager);
		if (!fileFound) {
			const latestClear = latestContextClearBoundary(ps.contextClearBoundaries);
			const activeMatchesLatestClear = !!latestClear && (() => {
				try { return this._sameAgentSessionPath(ps, ps.agentSessionFile, latestClear.activatedAgentSessionFile); }
				catch { return false; }
			})();
			// An intentionally empty clear generation is recovered only by the shared
			// fresh-runtime branch in restoreSession; never switch to its missing path.
			if (activeMatchesLatestClear && latestClear?.activatedTranscriptMaterialized === false) {
				console.log(`[session-manager] Session ${ps.id} has an unmaterialized cleared generation — recreating an empty runtime`);
				// fall through to restoreSession()
			} else if (activeMatchesLatestClear && latestClear?.activatedTranscriptMaterialized === true) {
				console.warn(`[session-manager] Session ${ps.id} lost its materialized cleared transcript: ${ps.agentSessionFile}`);
				this.addDormantSession(ps, "Materialized cleared transcript is unavailable");
				return;
			} else {
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
			} else if (await shouldKeepDespiteOrphan(ps)) {
				console.warn(`[orphan-cleanup] WARN: would-archive ${ps.id} but worktree+recent-transcript present — leaving live`);
				this.addDormantSession(ps);
				return;
			} else {
				console.log(`[session-manager] Archiving ${ps.id} — agent session file not found: ${ps.agentSessionFile} (metadata preserved)`);
				if (this.preservePromotedSessionAfterRecoveryFailure(ps, "archive its missing-transcript record")) return;
				sessionStore.archive(ps.id);
				return;
			}
			}
		}
		// A completed catalog is authoritative. Discovery failures deliberately fall
		// through to ordinary restore semantics; AIGW's registry layer retains its last
		// published matching-URL catalog during transient outages.
		if (this.preferencesStore && ps.modelProvider && ps.modelId) {
			try {
				const models = await getAvailableModels(this.preferencesStore);
				const normalized = normalizeAigwModelString(`${ps.modelProvider}/${ps.modelId}`);
				const slash = normalized.indexOf("/");
				const selectable = slash > 0 && slash < normalized.length - 1
					? findSessionSelectableModel(models, normalized.slice(0, slash), normalized.slice(slash + 1))
					: undefined;
				if (!selectable) {
					this.addDormantSession(ps, undefined, {
						code: "MODEL_SELECTION_REQUIRED",
						provider: ps.modelProvider,
						modelId: ps.modelId,
					});
					return;
				}
			} catch {
				// Catalog assembly itself was not authoritative; preserve the existing
				// generic restore/failure path rather than misclassifying an outage.
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
			if (err instanceof PromotedSessionLifecycleConflictError) {
				this.addPromotedRecoveryDormant(ps, msg);
			} else {
				this.addDormantSession(ps, msg);
			}
		}
	}

	/** Remove stale harness-owned rows before either live or dormant restoration. */
	private pruneRestoredVerifierPromptRows(ps: PersistedSession): {
		messageQueue: QueuedMessage[];
		changed: boolean;
	} {
		const persistedQueue = ps.messageQueue ?? [];
		const messageQueue = persistedQueue.filter(row => row.verifierOwned !== true);
		const changed = messageQueue.length !== persistedQueue.length;
		if (changed) {
			for (const row of persistedQueue) {
				if (row.verifierOwned === true) {
					this.settleVerifierPromptReceipt(ps.id, row.id, new Error(`Verifier prompt ${row.id} was discarded during session restore`));
				}
			}
		}
		return { messageQueue, changed };
	}

	private preparePersistedIntentRestore(ps: PersistedSession): {
		ps: PersistedSession;
		bindings: PromptAuthorBinding[];
		store: SessionStore;
		changed: boolean;
	} {
		const store = this.getSessionStore(ps.projectId);
		const bindings = readAuthorSidecar(ps.id);
		const pruned = this.pruneRestoredVerifierPromptRows(ps);
		const normalizedLedger = normalizePersistedInFlightSteers(ps.inFlightSteerTexts);
		const reconciled = reconcilePersistedIntentRestore(pruned.messageQueue, normalizedLedger, bindings);
		const changed = pruned.changed || reconciled.changed;
		if (changed) {
			// Publish verifier pruning and terminal sidecar evidence before a queue can
			// be installed or drained. A crash between settlement and the prior queue
			// transaction must not resurrect either lifecycle's retired occurrence.
			store.update(ps.id, {
				messageQueue: reconciled.messageQueue,
				inFlightSteerTexts: reconciled.inFlightSteerTexts,
			});
		}
		return {
			store,
			bindings,
			changed,
			ps: {
				...ps,
				messageQueue: reconciled.messageQueue,
				inFlightSteerTexts: reconciled.inFlightSteerTexts,
			},
		};
	}

	private addPromotedRecoveryDormant(ps: PersistedSession, restoreError: string): void {
		this.addDormantSession(ps, restoreError);
		const dormant = this.sessions.get(ps.id);
		if (!dormant) return;
		// Preserve the canonical adopted workspace projection while recovery is
		// quarantined. The durable record remains untouched and owns these values.
		dormant.repoPath = ps.repoPath;
		dormant.branch = ps.branch;
		dormant.worktreePath = ps.worktreePath;
		dormant.repoWorktrees = ps.repoWorktrees && ps.repoPath
			? Object.entries(ps.repoWorktrees).map(([repo, worktreePath]) => ({
				repo,
				repoPath: repo === "." ? ps.repoPath! : path.join(ps.repoPath!, repo),
				worktreePath,
			}))
			: undefined;
		dormant.sandboxed = ps.sandboxed;
		dormant.containerId = ps.containerId;
	}

	private addDormantSession(
		ps: PersistedSession,
		restoreError?: string,
		condition?: ModelSelectionRequiredCondition,
	): void {
		ps = this.preparePersistedIntentRestore(ps).ps;
		const restoredQueue = ps.messageQueue ?? [];
		this.sessions.set(ps.id, {
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "terminated",
			statusVersion: 0,
			restoreError,
			condition,
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
			assistantType: ps.assistantType,
			delegateOf: ps.delegateOf,
			parentSessionId: ps.parentSessionId,
			childKind: ps.childKind,
			readOnly: ps.readOnly,
			borrowsWorktree: ps.borrowsWorktree,
			borrowedWorktreeOwnerSessionId: ps.borrowedWorktreeOwnerSessionId,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			teamLeadSessionId: ps.teamLeadSessionId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			staffId: ps.staffId,
			accessory: ps.accessory,
			nonInteractive: ps.nonInteractive,
			preview: ps.preview,
			allowedTools: ps.allowedTools,
			projectId: ps.projectId,
			spawnPinnedModel: ps.modelProvider && ps.modelId
				? `${ps.modelProvider}/${ps.modelId}`
				: undefined,
			spawnPinnedThinkingLevel: ps.effectiveThinkingLevel,
			promptQueue: new PromptQueue(restoredQueue),
			inFlightSteerTexts: normalizePersistedInFlightSteers(ps.inFlightSteerTexts),
			manualRetryRequired: ps.manualRetryRequired === true,
		});
	}

	/**
	 * Sanitize and switch a replacement bridge onto durable history before it can
	 * become canonical. Sandbox agents need the same longer switch window used by
	 * initial setup because the first container RPC can include startup overhead.
	 *
	 * Callers own replacement-process cleanup so they can preserve their existing
	 * restore/termination semantics when this throws.
	 */
	private async switchSessionForRehydration(
		rpcClient: RpcBridge,
		ps: PersistedSession,
		agentSessionFile: string,
	): Promise<void> {
		trustPersistedAgentSessionFile(agentSessionFile);
		await sanitizeAgentTranscriptFile(
			sessionFsContextForAgentFile(ps, agentSessionFile),
			agentSessionFile,
			this.sandboxManager,
		);
		const switchResp = await rpcClient.sendCommand(
			{ type: "switch_session", sessionPath: switchSessionPathForAgent(ps) },
			ps.sandboxed ? 60_000 : 15_000,
		);
		if (!switchResp.success) {
			throw new Error(`switch_session failed: ${switchResp.error ?? "unknown error"}`);
		}
	}

	private async _dispatchBootContinuation(session: SessionInfo): Promise<boolean> {
		this._bootRepromptedSessions.add(session.id);
		// The coordinator remains installed while this cold-start RPC is pending.
		// Mark streaming as a second fence for the instant after coordinator release,
		// including the case where agent_start arrived before the RPC acknowledgement.
		this.markPromptDispatchStreaming(session);
		const markAccepted = (): boolean => {
			if (!this._sessionWriterIsCurrent(session)) return false;
			session.restoreStartupWasStreaming = false;
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: false });
			return true;
		};
		try {
			const continuationPrompt =
				"The infrastructure server restarted while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.";
			const response = await dispatchTrackedSystemPrompt(session, continuationPrompt, {
				source: "system",
				whenReady: true,
				streamingBehavior: "followUp",
				// A boot retry must retain the first potentially-written occurrence.
				intentId: `boot-continuation:${session.id}`,
				now: () => this.clock.now(),
			});
			if ((response as any)?.uncertain === true) {
				this._bootRepromptedSessions.delete(session.id);
				if (this._sessionWriterIsCurrent(session) && session.status === "streaming") {
					broadcastStatus(session, "idle");
				}
				return false;
			}
			// Keep the boot marker until agent_start so the team boot-resume pass cannot
			// add a second continuation after restore returns. The pre-fence observer in
			// handleAgentLifecycle clears it even when coordinator ownership suppresses
			// the rest of agent_start bookkeeping.
			// Clear the durable marker only after the final canonical bridge accepts
			// the continuation. A gateway death during provisional restore therefore
			// rehydrates wasStreaming=true and safely tries again on the next boot.
			return markAccepted();
		} catch (err) {
			// dispatchTrackedSystemPrompt already treats an exact correlated user echo
			// as acceptance. Unrelated lifecycle/replay cannot accept this attempt.
			this._bootRepromptedSessions.delete(session.id);
			if (this._sessionWriterIsCurrent(session) && session.status === "streaming") {
				broadcastStatus(session, "idle");
			}
			console.error(`[session-manager] Failed to re-prompt interrupted session ${session.id}:`, err);
			return false;
		} finally {
			// Direct dispatch bypasses PromptQueue, so persist and project its ledger
			// explicitly. This preserves an ambiguous boot write across another crash.
			if (this._sessionWriterIsCurrent(session)) this.broadcastQueue(session);
		}
	}

	private async _prepareUnmaterializedClearRecovery(
		ps: PersistedSession,
		rpcClient: RpcBridge,
		store: SessionStore,
	): Promise<UnmaterializedClearRecovery | undefined> {
		const boundary = latestContextClearBoundary(ps.contextClearBoundaries);
		if (!boundary || boundary.activatedTranscriptMaterialized
			|| !this._sameAgentSessionPath(ps, ps.agentSessionFile, boundary.activatedAgentSessionFile)) return undefined;
		const oldExists = await sessionFileExists(
			sessionFsContextForAgentFile(ps, ps.agentSessionFile),
			ps.agentSessionFile,
			this.sandboxManager,
		);
		if (oldExists) return undefined;
		const persistenceShape = this._captureContextClearPersistenceShape(store, ps.id);
		if (!persistenceShape) throw new Error("Cleared-generation persistence metadata is unavailable");
		const state = this._stateData(await rpcClient.getState(), "get_state for empty clear recovery");
		const newAgentSessionFile = state.sessionFile;
		if (typeof newAgentSessionFile !== "string" || !newAgentSessionFile
			|| this._sameAgentSessionPath(ps, newAgentSessionFile, ps.agentSessionFile)) {
			throw new Error("Empty clear recovery did not create a distinct safe transcript path");
		}
		this._validatedAgentSessionPathIdentity(ps, newAgentSessionFile);
		if (state.messageCount !== 0 || state.pendingMessageCount !== 0
			|| this._messageRowsFromRpc(await rpcClient.getMessages(), "get_messages for empty clear recovery").length !== 0) {
			throw new Error("Empty clear recovery runtime was not empty");
		}
		const entries = this._activeTranscriptEntriesFromRpc(
			await (rpcClient.getTranscriptEntries?.() ?? rpcClient.sendCommand({ type: "get_entries" })),
			"get_entries for empty clear recovery",
		);
		if (entries.some((entry) => entry.type === "message"
			|| entry.type === "compaction"
			|| entry.type === "branch_summary"
			|| entry.type === "custom_message")) {
			throw new Error("Empty clear recovery runtime contained model-facing transcript entries");
		}
		const boundaries = normalizeContextClearBoundaries(ps.contextClearBoundaries);
		const latestIndex = boundaries.findIndex((candidate) => candidate.id === boundary.id);
		if (latestIndex !== boundaries.length - 1) throw new Error("Empty clear recovery boundary is not the latest generation");
		boundaries[latestIndex] = { ...boundary, activatedAgentSessionFile: newAgentSessionFile };
		return { boundary, newAgentSessionFile, boundaries, persistenceShape };
	}

	private async _commitUnmaterializedClearRecovery(
		ps: PersistedSession,
		rpcClient: RpcBridge,
		store: SessionStore,
		recovery: UnmaterializedClearRecovery,
	): Promise<PersistedSession> {
		const thinkingLevel = isKnownThinkingLevel(ps.effectiveThinkingLevel);
		if (!ps.modelProvider || !ps.modelId || !thinkingLevel) {
			throw new Error("Empty clear recovery requires an exact persisted model and thinking tuple");
		}
		await this._applyAndVerifyClearTuple(rpcClient, {
			provider: ps.modelProvider,
			modelId: ps.modelId,
			thinkingLevel,
		}, recovery.newAgentSessionFile, ps);
		try {
			store.update(ps.id, {
				agentSessionFile: recovery.newAgentSessionFile,
				contextClearBoundaries: recovery.boundaries,
			});
			await store.flushAsync();
		} catch (error) {
			this._restoreContextClearPersistenceShape(store, ps.id, recovery.persistenceShape);
			await store.flushAsync().catch(() => {});
			throw error;
		}
		return {
			...ps,
			agentSessionFile: recovery.newAgentSessionFile,
			contextClearBoundaries: recovery.boundaries,
		};
	}

	private async restoreSession(ps: PersistedSession): Promise<void> {
		// Verifier-owned work is re-driven by VerificationHarness. Reliable user
		// occurrences are reconciled against their terminal sidecar before install.
		const preparedRestore = this.preparePersistedIntentRestore(ps);
		ps = preparedRestore.ps;
		const restoreStore = preparedRestore.store;
		const activeReplacementToken = this._sessionReplacementCoordinators.get(ps.id)?.active;
		const restoredAuthorBindings = preparedRestore.bindings;
		const restoredQueue = ps.messageQueue ?? [];
		if (preparedRestore.changed) await restoreStore.flushAsync();
		const bridgeOptions: RpcBridgeOptions = { cwd: ps.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;

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
			// Keep applySandboxWiring as the single restore decision point. Ordinary
			// sessions retain lazy bootstrap. A canonical adopted source instead uses
			// its durable promotion identity and fails closed if that exact container
			// is no longer ready.
			if (ps.cwd?.startsWith("/workspace")) {
				bridgeOptions.cwd = ps.cwd;
			}
			const adoptedSource = this.isCanonicalAdoptedWorkspaceOwner(ps);
			const expectedExistingContainerId = adoptedSource
				? ps.containerId?.trim()
				: undefined;
			if (adoptedSource && !expectedExistingContainerId) {
				this.assertPromotedSessionRecoveryAllowed(ps.id, "restore without its durable sandbox container identity");
				throw new Error(`Cannot restore promoted session ${ps.id}: durable sandbox container identity is missing`);
			}
			try {
				restoredSandboxed = await this.applySandboxWiring(bridgeOptions, ps.id, {
					projectId: ps.projectId,
					goalId: ps.goalId ?? ps.teamGoalId,
					expectedExistingContainerId,
				});
			} catch (error) {
				if (adoptedSource) {
					this.assertPromotedSessionRecoveryAllowed(ps.id, "transfer to a replacement sandbox container");
				}
				throw error;
			}
			if (!restoredSandboxed) {
				if ((ps as any)._preserveSandboxRealm) {
					throw new Error(`Cannot respawn sandboxed session ${ps.id}: sandbox realm is unavailable`);
				}
				// An adopted source's sandbox realm is part of its canonical workspace.
				// A transient restore outage must not silently transfer it to the host.
				this.assertPromotedSessionRecoveryAllowed(ps.id, "downgrade its unavailable sandbox realm");
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
			if (ps.projectId !== HEADQUARTERS_PROJECT_ID && !ps.borrowsWorktree && ps.cwd?.startsWith("/workspace-wt/") && bridgeOptions.containerId) {
				try {
					await this.commandRunner.execFile("docker", [
						"exec", bridgeOptions.containerId, "test", "-d", ps.cwd,
					], { timeout: 5_000 });
					console.log(`[session-manager] Sandbox worktree verified for ${ps.id}: ${ps.cwd}`);
				} catch {
					console.warn(`[session-manager] Sandbox worktree MISSING for ${ps.id}: ${ps.cwd} — attempting recovery`);
					this.assertPromotedSessionRecoveryAllowed(ps.id, "repair or recreate its sandbox worktree");
					let recovered = false;

					// Try git worktree repair first — handles broken .git link files after hard container kill
					try {
						await this.commandRunner.execFile("docker", [
							"exec", "-w", "/workspace", bridgeOptions.containerId!,
							"git", "worktree", "repair",
						], { timeout: 10_000 });
						// Re-check if worktree now exists after repair
						await this.commandRunner.execFile("docker", [
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
						if ((ps as any)._preserveRecoveryCapsule) {
							throw new Error(`Cannot recover session ${ps.id}: sandbox worktree is unavailable`);
						}
						if (await shouldKeepDespiteOrphan(ps)) {
							console.warn(`[orphan-cleanup] WARN: would-archive ${ps.id} but worktree+recent-transcript present — leaving live`);
							this.addDormantSession(ps);
							return;
						}
						console.warn(`[session-manager] Archiving session ${ps.id} — sandbox worktree unrecoverable`);
						if (this.preservePromotedSessionAfterRecoveryFailure(ps, "archive its unrecoverable sandbox record")) return;
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
				bridgeOptions.args = ["--extension", this.getTeamLeadExtensionPath(ps.projectId), "--extension", this.getGoalToolsExtensionPath(ps.projectId)];
			} else {
				bridgeOptions.args = ["--extension", this.getGoalToolsExtensionPath(ps.projectId)];
			}
		}

		// Restore proposal tools extension for assistant sessions
		if (ps.assistantType) {
			bridgeOptions.args = bridgeOptions.args || [];
			const proposalExtPath = this.getProposalToolsExtensionPath(ps.projectId);
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
		// Cold restore must discover project Pi tools before tagging persisted names,
		// computing role policy, or assembling prompt documentation.
		const restoredToolRuntime = this.prepareScopedToolRuntime(ps.projectId, ps.cwd);
		if (restoredToolRuntime.toolManager) bridgeOptions.toolManager = restoredToolRuntime.toolManager;
		const effectiveAllowed: EffectiveTool[] = overrideAllowedTools
			? tagAllowedTools(overrideAllowedTools, restoredToolRuntime.toolManager, restoredToolRuntime.toolScope)
			: persistedAllowedTools
				? tagAllowedTools(persistedAllowedTools, restoredToolRuntime.toolManager, restoredToolRuntime.toolScope)
				: this.resolveEffectiveAllowedTools(restoredRole, ps.projectId, ps.cwd, restoredToolRuntime);
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
		const restoredActivation = this.buildToolActivationArgs(ps.id, restoredAllowedTools, restoredRole, ps.cwd, ps.projectId, ps.goalId ?? ps.teamGoalId, overrideGrantedTools, restoredSandboxed, restoredToolRuntime);
		bridgeOptions.args = [...restoredActivation.args, ...(bridgeOptions.args || [])];
		bridgeOptions.piExtensions = [...(bridgeOptions.piExtensions ?? []), ...restoredActivation.runtimeExtensions];
		bridgeOptions.env = { ...(bridgeOptions.env || {}), ...restoredActivation.env };

		// Re-assemble system prompt (global + AGENTS.md + goal spec)
		const assistantDef = ps.assistantType ? getAssistantDef(ps.assistantType) : undefined;
		if (assistantDef) {
			// Mirror the spawn path (session-setup.ts): the backing role's template
			// is rendered as its OWN dedicated "Role" section via rolePrompt/roleName
			// below — NOT folded into the Goal section — so restored assistant
			// sessions keep the same Role/Goal split as freshly-spawned ones.
			const assistantRoleName = assistantRoleForType(ps.assistantType);
			const assistantTemplate = this.resolveRolePromptTemplate(assistantRoleName, ps.projectId);
			const assistantRolePrompt = assistantTemplate
				? assistantTemplate.replace(/\{\{AGENT_ID\}\}/g, `assistant-${(ps.goalId || ps.id).slice(0, 8)}`)
				: undefined;
			let assistantGoalSpec = assistantDef.prompt;
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
			if (ps.assistantType === "support") {
				assistantGoalSpec = assistantGoalSpec
					.replaceAll("{{BOBBIT_DOCS_DIR}}", resolveBundledDocsDir())
					.replaceAll("{{BOBBIT_SRC_DIR}}", resolveBundledSrcDir());
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
				rolePrompt: assistantRolePrompt,
				roleName: assistantRoleName,
				allowedTools: restoredAllowedNames,
				projectConfigStore: this.projectConfigStore,
				sectionOrder: restoreSectionOrder,
			}, ps.projectId);
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
				// Re-attach a role-carrying delegate's prompt on restart (rolePrompt is
				// not persisted). Role-less delegates leave it undefined — unchanged.
				role: ps.role,
				projectId: ps.projectId,
				goalId: ps.teamGoalId,
				sessionId: ps.id,
			}), ps.projectId);
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
			}, ps.projectId);
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		}

		// Pin model + thinking level at spawn so pi-coding-agent doesn't emit a
		// redundant initial `model_change` event with its hardcoded default. A durable
		// tuple is an exact verified selection: catalog drift must fail before bridge
		// construction rather than silently substituting a different current default.
		const psPersistedModel = ps.modelProvider && ps.modelId ? normalizeAigwModelString(`${ps.modelProvider}/${ps.modelId}`) : undefined;
		// Preserve the pre-validation candidate ordering pinned by the legacy restore
		// canary; the exact validator below is the final spawn authority.
		if (psPersistedModel && isSpawnPinnableModelString(psPersistedModel)) {
			bridgeOptions.initialModel = psPersistedModel;
		}
		const restoreInitialModel = this.resolveInitialModel(ps.role, ps.projectId);
		const restoreDefaultModel = this.resolveInitialModel(undefined, ps.projectId);
		const rawRestoreRoleModel = ps.role
			? this.resolveRoleModelValue(ps.role, ps.projectId)
			: undefined;
		const rawRestoreDefaultModel = this.preferencesStore?.get("default.sessionModel") as string | undefined;
		const exactRestoreModel = psPersistedModel ?? rawRestoreRoleModel ?? rawRestoreDefaultModel;
		bridgeOptions.initialModel = exactRestoreModel
			? await this.requireCurrentCatalogSpawnModel(exactRestoreModel)
			: await this.resolveCurrentCatalogSpawnModel([
				bridgeOptions.initialModel,
				restoreInitialModel,
				restoreDefaultModel,
			]);
		// Normalization is a spawn candidate only until Pi verifies the complete
		// model/thinking tuple below. tryAutoSelectModel owns the single atomic
		// durable commit, so any failed start, switch, or read-back retains the
		// original verified tuple byte-for-byte.
		const restoreHasDurableTuple = !!(
			psPersistedModel
			&& isKnownThinkingLevel(ps.effectiveThinkingLevel)
		);
		const initThinking = restoreHasDurableTuple
			? await this.resolveCurrentCatalogPreferredThinkingLevel(
				bridgeOptions.initialModel,
				ps.role,
				ps.projectId,
				ps.effectiveThinkingLevel,
			)
			: await this.resolveCurrentCatalogThinkingLevel(
				bridgeOptions.initialModel,
				ps.role,
				ps.projectId,
				ps.effectiveThinkingLevel,
			);
		if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;
		const restoreSpawnProvider = bridgeOptions.initialModel?.slice(0, bridgeOptions.initialModel.indexOf("/"));
		await this.applyDirectProviderEnv(bridgeOptions, !!ps.sandboxed, restoreSpawnProvider);
		await this.finalizeSpawnOptions(bridgeOptions, {
			model: exactRestoreModel ?? bridgeOptions.initialModel,
			thinkingLevel: ps.effectiveThinkingLevel ?? bridgeOptions.initialThinkingLevel,
			role: ps.role,
			projectId: ps.projectId,
		});

		const rpcClient = new RpcBridge(bridgeOptions);
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
			runtimePiExtensions: bridgeOptions.piExtensions,
			eventBuffer,
			unsubscribe: () => {},
			isCompacting: false,
			// Assistant sessions: a title still equal to the bare type prefix (e.g.
			// "Support", "New Goal") is not yet generated — stay eligible so the first
			// genuine user message renames it; a renamed title ("<prefix>: …") must NOT
			// regenerate. Non-assistant sessions keep the "New session" rule.
			titleGenerated: assistantDef?.titlePrefix
				? ps.title !== assistantDef.titlePrefix
				: ps.title !== "New session",
			goalId: ps.goalId,
			assistantType: ps.assistantType,
			delegateOf: ps.delegateOf,
			parentSessionId: ps.parentSessionId,
			childKind: ps.childKind,
			readOnly: ps.readOnly,
			borrowsWorktree: ps.borrowsWorktree,
			borrowedWorktreeOwnerSessionId: ps.borrowedWorktreeOwnerSessionId,
			role: ps.role,
			teamGoalId: ps.teamGoalId,
			teamLeadSessionId: ps.teamLeadSessionId,
			worktreePath: ps.worktreePath,
			taskId: ps.taskId,
			staffId: ps.staffId,
			accessory: ps.accessory,
			preview: ps.preview,
			allowedTools: restoredAllowedNames,
			promptQueue: new PromptQueue(restoredQueue),
			streamingStartedAt: ps.streamingStartedAt,
			restoreStartupWasStreaming: ps.wasStreaming === true,
			projectId: ps.projectId,
			inFlightSteerTexts: normalizePersistedInFlightSteers(ps.inFlightSteerTexts),
			manualRetryRequired: ps.manualRetryRequired === true,
			spawnPinnedModel: bridgeOptions.initialModel,
			spawnPinnedThinkingLevel: bridgeOptions.initialThinkingLevel,
			_deferVerifiedTupleCommit: (ps as any)._deferVerifiedTupleCommit === true,
			_disableControlledModelFallback: (ps as any)._disableControlledModelFallback === true,
			// Recovery candidates remain publicly conditioned while restoreSession owns
			// staged startup work. This is ephemeral coordinator input, never persisted.
			condition: (ps as any)._modelSelectionRequiredCondition,
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
		// The sidecar is the durable source for dispatches that crossed a gateway
		// restart before Pi echoed them. Hydrate before subscribing/switch_session
		// so replayed update/end frames retain and settle the original identity.
		const settledSteersPruned = restorePromptAuthorBindings(session, restoredAuthorBindings);

		// Skip cost tracking and lifecycle effects during switch_session replay.
		// Activity attribution has a stronger origin fence: it stays suppressed
		// until Bobbit dispatches a genuine new prompt, so replay frames arriving
		// after the switch response cannot corrupt the persisted timestamp.
		let restoring = true;

		installSessionActivityAttribution(session, restoreStore, {
			now: () => this.clock.now(),
			suppressUntilPrompt: true,
		});
		const unsub = rpcClient.onEvent((event: any) => {
			if (session.lifecycleFenced) return;
			// During restore, switch_session replays every persisted message as an
			// rpc event. Bumping lastActivity here would clobber the pre-restart
			// timestamp with Date.now(). More importantly, replayed lifecycle frames
			// must not drain the durable prompt queue or dispatch prompt() before the
			// switch succeeds and this replacement becomes canonical.
			const preparedEvent = this.prepareVisibleAgentEvent(session, event);
			if (!restoring) {
				recordSessionEventActivity(session, preparedEvent);
				this.handleAgentLifecycle(session, preparedEvent);
			} else {
				// Preserve the narrow replay reconciliation that proves an accepted
				// steer was already echoed, without running lifecycle dispatch hooks.
				this._consumeSteerEcho(session, preparedEvent);
			}

			this.emitAgentEvent(session, preparedEvent);
			if (!restoring) this.trackCostFromEvent(session, preparedEvent);
		});

		bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension);
		session.unsubscribe = unsub;

		try {
			await rpcClient.start();
		} catch (err) {
			// A partially started replacement must never survive a failed restore.
			// The in-place caller will reinstall only its fenced dormant rollback.
			try { await rpcClient.stop(); } catch { /* best-effort cleanup */ }
			throw err;
		}

		// Resume ordinary history, or recreate a deliberately unmaterialized clear
		// generation without ever switching to a historical/missing path.
		let unmaterializedClearRecovery: UnmaterializedClearRecovery | undefined;
		try {
			if (activeReplacementToken && !this._replacementTokenIsCurrent(ps.id, activeReplacementToken)) {
				throw new Error(`Session ${ps.id} restore ownership changed before transcript selection`);
			}
			unmaterializedClearRecovery = await this._prepareUnmaterializedClearRecovery(ps, rpcClient, restoreStore);
			if (!unmaterializedClearRecovery) {
				trustPersistedAgentSessionFile(ps.agentSessionFile);
				const transcriptFileCtx = sessionFsContextForAgentFile(ps, ps.agentSessionFile);
				const switchSessionPath = switchSessionPathForAgent(ps);
				// Un-poison the persisted transcript before the agent rehydrates it
				// (best-effort, non-fatal).
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
				if (!switchResp.success) {
					throw new Error(`switch_session failed: ${switchResp.error}`);
				}
			}
		} catch (err) {
			// A thrown/timed-out switch is just as terminal as an explicit failure
			// response. Detach its listener and fence the replacement before stopping
			// it so replayed/late Pi events cannot mutate queues, status, or persisted
			// intent after the rollback capsule becomes canonical again.
			restoring = false;
			try { unsub(); } catch { /* best-effort listener cleanup */ }
			this._fenceReplacedSession(session, this._currentRespawnGeneration(ps.id) + 1);
			try { await rpcClient.stop(); } catch { /* best-effort process cleanup */ }
			throw err;
		}

		try {
			await this.tryAutoSelectModel(session);
		} catch (err) {
			try { unsub(); } catch { /* best-effort listener cleanup */ }
			await rpcClient.stop();
			throw err;
		}
		try {
			await this.tryApplyDefaultThinkingLevel(session);
		} catch (err) {
			// Rows created before effectiveThinkingLevel was persisted have no exact
			// thinking contract to enforce. Keep them readable and let a later complete
			// state frame migrate them; a verified durable tuple must fail closed.
			if (ps.effectiveThinkingLevel === undefined) {
				console.warn(`[session-manager] Legacy session ${ps.id} could not verify effective thinking during restore:`, err);
			} else {
				try { unsub(); } catch { /* best-effort listener cleanup */ }
				await rpcClient.stop();
				throw err;
			}
		}

		if (unmaterializedClearRecovery) {
			try {
				if (activeReplacementToken && !this._replacementTokenIsCurrent(ps.id, activeReplacementToken)) {
					throw new Error(`Session ${ps.id} empty-generation recovery was superseded before publication`);
				}
				ps = await this._commitUnmaterializedClearRecovery(
					ps,
					rpcClient,
					restoreStore,
					unmaterializedClearRecovery,
				);
			} catch (err) {
				try { unsub(); } catch { /* best-effort listener cleanup */ }
				this._fenceReplacedSession(session, this._currentRespawnGeneration(ps.id) + 1);
				await rpcClient.stop().catch(() => {});
				throw err;
			}
		}

		// applySandboxWiring already established the bridge's exact realm. Reuse
		// that verified identity rather than performing another fallible lookup.
		if (ps.sandboxed && bridgeOptions.containerId) session.containerId = bridgeOptions.containerId;

		// Sessions written before question attention state existed need one durable
		// projection from their restored transcript. Without this migration, an ask
		// that predates the upgrade stays invisible in the sidebar forever.
		if (typeof ps.hasUnansweredQuestion !== "boolean") {
			try {
				const messagesResponse = await rpcClient.getMessages();
				const rawMessages = messagesResponse.data?.messages ?? messagesResponse.data;
				const migratedState = messagesResponse.success
					? backfillUnansweredAskState(ps.hasUnansweredQuestion, rawMessages, ps.dismissedAskToolUseIds)
					: undefined;
				if (migratedState !== undefined) {
					restoreStore.update(ps.id, { hasUnansweredQuestion: migratedState });
					await restoreStore.flushAsync();
					ps.hasUnansweredQuestion = migratedState;
				}
			} catch (error) {
				console.warn(`[session-manager] Failed to backfill unanswered-question state for ${ps.id}:`, error);
			}
		}

		// Install the replacement before enabling lifecycle side effects. A replayed
		// agent_end must never dequeue durable intent against a provisional bridge.
		this.sessions.set(ps.id, session);
		if (settledSteersPruned > 0) this.persistInFlightSteerLedger(session);
		// Replay-only keyless guards must not shadow a genuine future prompt once
		// switch_session has finished emitting the historical transcript.
		session.promptAuthorReplayBindings = undefined;
		session.lastKeylessPromptAuthorEnd = undefined;
		restoring = false;
		broadcastStatus(session, "idle");

		// `switch_session` replays durable user message echoes and `_consumeSteerEcho`
		// Replay completed without a correlated start for anything left in the
		// ledger, which is the proof required before an exact occurrence can retry.
		this._reconcileInFlightSteers(session, { outcome: "proven-no-start" });

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
		// Non-interactive verification owns a separate durable re-drive marker, so
		// this compatibility flag can clear when ownership is handed off.
		if (ps.wasStreaming && ps.nonInteractive) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn but is nonInteractive — leaving re-drive to the verification harness`);
			session.restoreStartupWasStreaming = false;
			restoreStore.update(ps.id, { wasStreaming: false });
		} else if (ps.wasStreaming) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn — re-prompting to continue`);
			// A restore may be only a provisional winner: role/restart/Stop/terminate
			// requests can already be queued behind it. Defer the continuation until
			// the coordinator releases its final canonical bridge. Direct test/legacy
			// callers without a coordinator retain immediate behavior.
			const coordinator = this._sessionReplacementCoordinators.get(ps.id);
			if (coordinator) coordinator.bootContinuationPending = true;
			else this._dispatchBootContinuation(session);
		}
	}

	/**
	 * Activate an exact current model for a processless MODEL_SELECTION_REQUIRED
	 * capsule. The existing replacement coordinator owns serialization, prompt
	 * fencing, canonical publication, and post-release queue behavior.
	 */
	async recoverModelSelectionRequired(
		sessionId: string,
		provider: string,
		modelId: string,
		preferredThinkingLevel?: string,
	): Promise<VerifiedSessionModelTuple> {
		return this._coordinateSessionReplacement(sessionId, "model-recovery", async (token) => {
			const capsule = this.sessions.get(sessionId);
			const condition = capsule?.condition;
			if (!capsule || condition?.code !== "MODEL_SELECTION_REQUIRED") {
				throw new ModelSelectionRecoveryError(provider, modelId, "session does not require model recovery");
			}
			if (!this._replacementTokenIsCurrent(sessionId, token) || token.coordinator.terminalRequest) {
				throw new ModelSelectionRecoveryError(provider, modelId, "recovery was superseded before activation");
			}

			const store = this.resolveStoreForSession(sessionId);
			const persisted = store.get(sessionId);
			if (!persisted?.agentSessionFile) {
				throw new ModelSelectionRecoveryError(provider, modelId, "persisted conversation history is unavailable");
			}

			let selectedProvider = provider;
			let selectedModelId = modelId;
			let selectedThinking: ThinkingLevel;
			try {
				if (!this.preferencesStore) throw new Error("the model catalog is unavailable");
				const models = await getAvailableModels(this.preferencesStore);
				const selected = await this.requireCurrentCatalogSpawnModel(`${provider}/${modelId}`, models);
				const slash = selected.indexOf("/");
				selectedProvider = selected.slice(0, slash);
				selectedModelId = selected.slice(slash + 1);
				const requestedThinking = isKnownThinkingLevel(preferredThinkingLevel)
					?? isKnownThinkingLevel(persisted.effectiveThinkingLevel)
					?? "medium";
				const clamped = await this.resolveCurrentCatalogThinkingLevel(
					selected,
					capsule.role,
					capsule.projectId,
					requestedThinking,
					models,
					false,
					true,
				);
				if (!clamped) throw new Error("replacement thinking level could not be normalized");
				selectedThinking = clamped;
			} catch (err) {
				throw new ModelSelectionRecoveryError(provider, modelId, err);
			}

			const replacementPs = {
				...persisted,
				modelProvider: selectedProvider,
				modelId: selectedModelId,
				effectiveThinkingLevel: selectedThinking,
				_preserveSandboxRealm: true,
				_preserveRecoveryCapsule: true,
				_deferVerifiedTupleCommit: true,
				_disableControlledModelFallback: true,
				_modelSelectionRequiredCondition: { ...condition },
			} as PersistedSession;
			const transcriptFileCtx = sessionFsContextForAgentFile(persisted, persisted.agentSessionFile);
			let transcriptSnapshot: string;
			try {
				trustPersistedAgentSessionFile(persisted.agentSessionFile);
				const content = await sessionFileRead(transcriptFileCtx, persisted.agentSessionFile, this.sandboxManager);
				if (content === null) throw new Error("persisted conversation history is unavailable");
				transcriptSnapshot = content;
			} catch (err) {
				throw new ModelSelectionRecoveryError(provider, modelId, err);
			}

			let candidate: SessionInfo | undefined;
			let durableCommitAttempted = false;
			let candidateRestoreStarted = false;
			try {
				candidateRestoreStarted = true;
				await this.restoreSession(replacementPs);
				candidate = this.sessions.get(sessionId);
				const verifiedModel = `${selectedProvider}/${selectedModelId}`;
				if (
					!candidate
					|| candidate === capsule
					|| candidate.spawnPinnedModel !== verifiedModel
					|| candidate.spawnPinnedThinkingLevel !== selectedThinking
					|| !this._replacementTokenIsCurrent(sessionId, token)
					|| token.coordinator.terminalRequest
				) {
					throw new Error("replacement tuple was not verified under current lifecycle ownership");
				}

				// Verification is complete. Publish the exact durable tuple before exposing
				// the replacement to the capsule's clients or releasing prompt ownership.
				durableCommitAttempted = true;
				this.persistSessionModel(sessionId, selectedProvider, selectedModelId, selectedThinking);
				// The durable tuple is now authoritative. Clear the ephemeral staged condition
				// before publishing the explicit client clear below.
				candidate.condition = undefined;
				this._writeModelNameFile(sessionId, verifiedModel);
				candidate._deferVerifiedTupleCommit = undefined;
				candidate._disableControlledModelFallback = undefined;

				const clients = [...capsule.clients];
				capsule.clients.clear();
				this._untrackConnectedSession(capsule);
				for (const client of clients) {
					if ((client as any).readyState === 1) candidate.clients.add(client);
				}
				this._trackConnectedSession(candidate);
				// restoreSession published the candidate's live status before it owned the
				// capsule's clients. Replay that canonical status through the monotonic
				// lifecycle publisher now that transfer is complete, before the condition
				// clear lets clients derive their recovered interaction state.
				broadcastStatus(candidate, candidate.status);
				broadcast(candidate.clients, {
					type: "state",
					data: {
						...buildModelStateData(selectedProvider, selectedModelId),
						thinkingLevel: selectedThinking,
						// Generic state frames are partial and must not clear recovery state.
						// Publish the explicit clear only here, after the verified durable tuple
						// commits and the recovered candidate becomes canonical.
						condition: null,
					},
				});
				return {
					provider: selectedProvider,
					modelId: selectedModelId,
					thinkingLevel: selectedThinking,
				};
			} catch (err) {
				candidate = this.sessions.get(sessionId);
				if (candidate && candidate !== capsule) {
					candidate.lifecycleFenced = true;
					candidate.dormant = true;
					candidate.status = "terminated";
					try { candidate.unsubscribe(); } catch { /* best-effort cleanup */ }
					try { await candidate.rpcClient.stop(); } catch { /* best-effort cleanup */ }
				}
				// Ordinary restore sanitizes the durable JSONL before model/thinking
				// verification. A provisional candidate must not retain that mutation when
				// activation rolls back. Treat any rejected or thrown restore as a distinct,
				// non-retryable failure rather than claiming that the capsule was preserved.
				let transcriptRollbackVerified = !candidateRestoreStarted;
				if (candidateRestoreStarted) {
					try {
						transcriptRollbackVerified = restoreAgentTranscriptSnapshot(
							transcriptFileCtx,
							persisted.agentSessionFile,
							transcriptSnapshot,
						) === true;
					} catch (rollbackError) {
						transcriptRollbackVerified = false;
						console.error(`[session-manager] Failed to restore transcript after model recovery for ${sessionId}:`, rollbackError);
					}
				}
				this.sessions.set(sessionId, capsule);
				capsule.lifecycleFenced = false;
				capsule.dormant = true;
				capsule.status = "terminated";
				if (durableCommitAttempted) {
					try {
						store.update(sessionId, {
							modelProvider: condition.provider,
							modelId: condition.modelId,
							effectiveThinkingLevel: persisted.effectiveThinkingLevel,
						});
					} catch { /* retain the recovery capsule even if storage itself is unavailable */ }
				}
				if (!transcriptRollbackVerified) {
					console.error(`[session-manager] Transcript rollback could not be verified after model recovery for ${sessionId}; provisional candidate remains fenced`);
					throw new ModelSelectionRecoveryError(
						selectedProvider,
						selectedModelId,
						"conversation transcript rollback could not be verified",
						{ retryable: false },
					);
				}
				throw err instanceof ModelSelectionRecoveryError
					? err
					: new ModelSelectionRecoveryError(selectedProvider, selectedModelId, err);
			}
		}, { drainOnRelease: true, cancelOnTerminal: () => {
			throw new ModelSelectionRecoveryError(provider, modelId, "session termination superseded recovery");
		} });
	}

	async createSession(cwd: string, agentArgs?: string[], goalId?: string, assistantType?: string, opts?: { rolePrompt?: string; roleName?: string; role?: string; teamGoalId?: string; teamLeadSessionId?: string; accessory?: string; nonInteractive?: boolean; env?: Record<string, string>; taskId?: string; staffId?: string; allowedTools?: string[]; workflowContext?: string; worktreeOpts?: { repoPath: string }; worktreePath?: string; borrowsWorktree?: boolean; borrowedWorktreeOwnerSessionId?: string; repoPath?: string; branch?: string; repoWorktrees?: Record<string, string>; reattemptGoalId?: string; sandboxed?: boolean; projectId?: string; sessionId?: string; allowSessionReuse?: boolean; sandboxBranch?: string; sandboxBaseBranch?: string; sandboxCwdOffset?: string; skipAutoModel?: boolean; skipAutoThinking?: boolean; initialModel?: string; initialThinkingLevel?: string; preExistingAgentSessionFile?: string; preExistingAgentSessionOldCwds?: string[]; parentSessionId?: string; childKind?: string; readOnly?: boolean; title?: string; awaitWorktreeSetup?: boolean; bypassWorktreePool?: boolean }): Promise<SessionInfo> {
		const id = opts?.sessionId || randomUUID();
		// Guard against silently clobbering an existing session's transcript. A
		// caller-supplied sessionId that already maps to a LIVE session (or an
		// archived record) means someone is about to build a brand-new agent in
		// place, overwriting the prior session's transcript — this was the
		// smoking-gun defect behind reviewer-transcript "resets" during llm-review
		// retries. The only sanctioned reuse is the restart-resume path, which sets
		// `allowSessionReuse`. Everything else is a bug: log LOUDLY (greppable
		// prefix) and refuse to clobber a live session.
		if (opts?.sessionId && !opts?.allowSessionReuse) {
			const liveClash = this.sessions.has(id);
			const archivedClash = !liveClash && !!this.getArchivedSession(id);
			if (liveClash || archivedClash) {
				const roleLabel = opts.roleName ?? opts.role ?? "unknown";
				console.error(`[session-manager][session-id-clobber] createSession called with an already-${liveClash ? "LIVE" : "archived"} sessionId="${id}" (role=${roleLabel}, goalId=${goalId ?? "?"}). This would overwrite an existing session's transcript. sessionId reuse is only permitted on the sanctioned restart-resume path (opts.allowSessionReuse). Refusing to clobber.`);
				if (liveClash) {
					throw new Error(`[session-manager] Refusing to clobber live session "${id}" — sessionId reuse is only permitted on the restart-resume path (allowSessionReuse). This is a bug in the caller; each from-scratch attempt must use a fresh session id.`);
				}
			}
		}
		// Resolve projectId from opts or from the goal's project.
		// Headquarters is a server/data workspace: ignore every worktree request at
		// the lifecycle boundary so downstream setup never claims a pool, creates a
		// git worktree, or asks sandbox wiring for a branch worktree.
		const projectId = opts?.projectId ?? (goalId ? this.resolveGoal(goalId)?.projectId : undefined);
		const sandboxExemptScope = projectId ? isSandboxExemptProject(projectId) : false;
		const headquartersScope = projectId === HEADQUARTERS_PROJECT_ID;
		const effectiveSandboxed = opts?.sandboxed && !sandboxExemptScope ? true : undefined;
		const worktreeOpts = headquartersScope ? undefined : opts?.worktreeOpts;
		const sandboxBranch = effectiveSandboxed ? opts?.sandboxBranch : undefined;
		const sandboxBaseBranch = effectiveSandboxed ? opts?.sandboxBaseBranch : undefined;
		await this.ensureMcpManagerForContext(projectId, cwd);
		const ctx = this.buildPipelineContext(projectId, cwd);
		const optsAllowedTagged: EffectiveTool[] | undefined = opts?.allowedTools
			? tagAllowedTools(opts.allowedTools, ctx.toolManager ?? undefined, scopedToolContext(projectId, cwd))
			: undefined;
		const sessionScopedAllowedTools = opts?.allowedTools !== undefined
			? [...opts.allowedTools]
			: undefined;

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
		const initialRole = opts?.role ?? opts?.roleName;
		const rawInitialRoleModel = !opts?.skipAutoModel && initialRole
			? this.resolveRoleModelValue(initialRole, projectId)
			: undefined;
		const rawInitialDefaultModel = !opts?.skipAutoModel
			? this.preferencesStore?.get("default.sessionModel") as string | undefined
			: undefined;
		let rawSelectedSpawnModel = opts?.initialModel
			?? rawInitialRoleModel
			?? rawInitialDefaultModel
			?? (!opts?.skipAutoModel ? this.resolveInitialModel(initialRole, projectId) : undefined);
		let currentModels: Awaited<ReturnType<typeof getAvailableModels>> | undefined;
		const requestedSpawnModel = rawSelectedSpawnModel;
		// Every Bobbit spawn starts from an exact catalog row. Raw Pi selection flags
		// are resolved later at the fully assembled boundary; they are not an
		// exemption from catalog validation or an invitation to Pi's fallback model.
		if (!rawSelectedSpawnModel && this.preferencesStore) {
			currentModels = await getAvailableModels(this.preferencesStore);
			rawSelectedSpawnModel = await this.resolveCurrentCatalogSpawnModel([], currentModels);
		}
		let selectedSpawnModel = rawSelectedSpawnModel
			? normalizeAigwModelString(rawSelectedSpawnModel)
			: undefined;
		if (selectedSpawnModel) {
			currentModels ??= this.preferencesStore
				? await getAvailableModels(this.preferencesStore)
				: undefined;
			try {
				await this.requireCurrentCatalogSpawnModel(selectedSpawnModel, currentModels);
			} catch (selectedError) {
				// A fresh role-owned setup is one of the existing controlled-fallback
				// call sites. Resolve its one configured fallback before constructing the
				// bridge so an unavailable role provider cannot prevent verified setup.
				// Explicit initial models, defaults, restores, and inherited tuples remain
				// fail-closed at their own boundaries.
				const roleFallbackEligible = opts?.initialModel === undefined
					&& !opts?.allowSessionReuse
					&& !!rawInitialRoleModel
					&& this.preferencesStore?.get("allowSessionModelFallback") === true;
				if (!roleFallbackEligible) throw selectedError;

				const fallbackModel = rawInitialDefaultModel
					? normalizeAigwModelString(rawInitialDefaultModel)
					: undefined;
				let fallbackError: unknown;
				if (!fallbackModel) {
					fallbackError = new Error("controlled model fallback is enabled but default.sessionModel is unset");
				} else if (fallbackModel === selectedSpawnModel) {
					fallbackError = new Error("controlled model fallback target default.sessionModel is the same as the unavailable role model");
				} else {
					try {
						selectedSpawnModel = await this.requireCurrentCatalogSpawnModel(fallbackModel, currentModels);
						console.warn(`[session-manager] Role model "${sanitizeModelErrorText(rawInitialRoleModel)}" is unavailable for new session ${id}; controlled fallback enabled, binding default.sessionModel="${sanitizeModelErrorText(selectedSpawnModel)}" before spawn`);
					} catch (error) {
						fallbackError = error;
					}
				}
				if (fallbackError) {
					throw new Error(`role model "${sanitizeModelErrorText(rawInitialRoleModel)}" failed preflight and controlled fallback did not bind; original error: ${sanitizeModelErrorText(selectedError)}; fallback error: ${sanitizeModelErrorText(fallbackError)}`);
				}
			}
		}
		const exactInitialThinkingLevel = opts?.skipAutoThinking && !opts?.initialThinkingLevel
			? undefined
			: await this.resolveCurrentCatalogThinkingLevel(
				selectedSpawnModel,
				initialRole,
				projectId,
				opts?.initialThinkingLevel,
				currentModels,
			);

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

			const now = this.clock.now();
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
				borrowsWorktree: opts?.borrowsWorktree,
				borrowedWorktreeOwnerSessionId: opts?.borrowedWorktreeOwnerSessionId,
				allowedTools: opts?.allowedTools,
				// Mirror session-setup's effectiveRoleId fallback: when callers
				// (team-manager, staff-manager) pass only `roleName`, use that as
				// `session.role` so the post-spawn auto-model safety net still
				// keys off the right role id during the worktree-prep window.
				role: opts?.role ?? opts?.roleName,
				accessory: opts?.accessory,
				nonInteractive: opts?.nonInteractive,
				worktreePath,
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
				borrowsWorktree: opts?.borrowsWorktree,
				borrowedWorktreeOwnerSessionId: opts?.borrowedWorktreeOwnerSessionId,
				sessionScopedAllowedTools,
				worktreePath,
				repoPath,
				branch,
				sandboxed: effectiveSandboxed,
				role: opts?.role,
				accessory: opts?.accessory,
				nonInteractive: opts?.nonInteractive,
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
				initialModel: selectedSpawnModel,
				initialThinkingLevel: exactInitialThinkingLevel,
				requestedModel: requestedSpawnModel ?? selectedSpawnModel,
				requestedThinkingLevel: opts?.initialThinkingLevel ?? exactInitialThinkingLevel,
				preExistingAgentSessionFile: opts?.preExistingAgentSessionFile,
				preExistingAgentSessionOldCwds: opts?.preExistingAgentSessionOldCwds,
				bridgeOptions: { cwd },
			};

			// Persist immediately with all known structural fields. Creation listeners
			// remain silent until the final structural generation crosses the store's
			// atomic publication fence.
			persistOnce(session, plan, ctx.store);
			if (session.repoWorktrees && session.repoWorktrees.length > 0) {
				ctx.store.update(session.id, {
					repoWorktrees: Object.fromEntries(session.repoWorktrees.map(w => [w.repo, w.worktreePath])),
				});
			}
			try {
				await this.notifySessionCreated(session, ctx.store);
			} catch (err) {
				const persistenceError = err instanceof Error ? err : new Error(String(err));
				handleSetupFailure(session, plan, persistenceError, ctx);
				throw persistenceError;
			}

			// Finish the pipeline. Most callers keep the historical preparing-session UX
			// and let setup complete in the background. Continue-Archived opts in to
			// awaiting setup so fresh worktree/base-ref failures are returned by the POST
			// instead of surfacing later as an asynchronously archived session.
			const releaseSetupThinkingAuthority = this.retainSetupInitialThinkingAuthority(
				id,
				opts?.initialThinkingLevel,
			);
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
			}).finally(releaseSetupThinkingAuthority);

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
			borrowsWorktree: opts?.borrowsWorktree,
			borrowedWorktreeOwnerSessionId: opts?.borrowedWorktreeOwnerSessionId,
			sessionScopedAllowedTools,
			// Prebuilt host worktrees already have all ordinary-cleanup coordinates.
			// Carry them into persistOnce instead of adding them only after
			// createSession returns.
			worktreePath: opts?.worktreePath,
			repoPath: opts?.repoPath,
			branch: opts?.branch,
			repoWorktrees: opts?.repoWorktrees,
			// Load-bearing wire: same contract as the worktree branch above.
			// Pinned by `tests/staff-session-staffid-persistence.test.ts`.
			staffId: opts?.staffId,
			sandboxed: effectiveSandboxed,
			role: opts?.role,
			accessory: opts?.accessory,
			nonInteractive: opts?.nonInteractive,
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
			initialModel: selectedSpawnModel,
			initialThinkingLevel: exactInitialThinkingLevel,
			requestedModel: requestedSpawnModel ?? selectedSpawnModel,
			requestedThinkingLevel: opts?.initialThinkingLevel ?? exactInitialThinkingLevel,
			preExistingAgentSessionFile: opts?.preExistingAgentSessionFile,
			preExistingAgentSessionOldCwds: opts?.preExistingAgentSessionOldCwds,
			bridgeOptions: { cwd },
		};

		const releaseSetupThinkingAuthority = this.retainSetupInitialThinkingAuthority(
			id,
			opts?.initialThinkingLevel,
		);
		try {
			const session = await executePlan(plan, ctx);
			if (projectId) session.projectId = projectId;
			// Verification/reviewer sessions deliberately skip the ordinary post-spawn
			// selectors because their tuple was pinned in argv. They still need the same
			// exact read-back and one atomic durable tuple commit before create returns.
			if (opts?.skipAutoModel && opts.skipAutoThinking && selectedSpawnModel) {
				await this.tryAutoSelectModel(session);
			}
			try {
				await this.notifySessionCreated(session, ctx.store);
			} catch (err) {
				const persistenceError = err instanceof Error ? err : new Error(String(err));
				handleSetupFailure(session, plan, persistenceError, ctx);
				throw persistenceError;
			}

			// Persist session metadata (fire-and-forget, but tracked for terminate).
			// Rehydrated sessions already have a cloned/adopted transcript path recorded;
			// avoid a redundant get_state that can rewrite runtime-only metadata.
			if (!plan.preExistingAgentSessionFile) {
				session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err) => {
					console.warn(`[session-manager] Early persist failed for ${session.id}:`, err);
				}).finally(() => { session.pendingMetadataPersist = undefined; });
			}

			return session;
		} finally {
			releaseSetupThinkingAuthority();
		}
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
		 * it here. A tuple-less legacy parent uses Bobbit's deterministic catalog
		 * selection; Pi never chooses an implicit provider.
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
		 * Optional role injection (`team_delegate(role: X)`). Threads the role's
		 * promptTemplate + accessory through the SHARED session-setup pipeline (via
		 * plan.role/roleName/rolePrompt), exactly like the full createSession path.
		 * Tools are NOT recomputed from the role — `effectiveAllowedTools` already
		 * carries the spawn-verb/read-only-stripped role tools from the caller
		 * (OrchestrationCore.childAllowedTools). Role injection must never widen
		 * a delegate's tools.
		 */
		role?: string;
		/**
		 * NON-SECRET tool-scoping env vars merged into the child process env
		 * (additive, alongside the gateway-set BOBBIT_SESSION_ID/SECRET). Used by
		 * tool policies that read process env (e.g. the pr-walkthrough reviewer's
		 * launched-PR `gh` scoping via `BOBBIT_WALKTHROUGH_TARGET_*`). Plain metadata
		 * ONLY — it never widens the child's sandbox or project (credential) scope.
		 */
		env?: Record<string, string>;
		/** Initial prompt provenance. Only a valid owner-agent pair is accepted;
		 * omitted or inconsistent metadata falls back to Bobbit system identity. */
		source?: PromptSource;
		author?: MessageAuthor;
	}): Promise<SessionInfo> {
		const id = randomUUID();
		// Resolve projectId from parent session
		const parentStore = this.resolveStoreForId(parentSessionId);
		const parentSession = this.sessions.get(parentSessionId);
		const parentMeta = parentStore?.get(parentSessionId);
		const parentProjectId = parentSession?.projectId ?? parentMeta?.projectId;
		const initialTrustedTeamGoalId = this.getTrustedTeamGoalIdForSession(parentSessionId);
		if (initialTrustedTeamGoalId && this.resolveGoal(initialTrustedTeamGoalId)?.archived) {
			throw new Error("Cannot create a delegate for an archived team goal");
		}

		// ── Sandbox propagation from parent ──
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

		// ── Goal-metadata inheritance (anti-asymmetry invariant) ──
		// A `team_delegate` sub-agent natively carries only `delegateOf`; it has no
		// `goalId`/`teamGoalId`, so every per-session goal-metadata edge (disabled
		// tools, disabled providers, prompt order) would resolve to {} and the child
		// could re-acquire a tool/provider the goal disabled — a treatment leak.
		// Stamp the PARENT's effective goal as the delegate's `teamGoalId` (NOT
		// `goalId`, so it is treated as a member, not a lead) so the resolver walks
		// the same ancestry and the delegate inherits the same metadata. Durable or
		// current TeamStore-derived ownership wins; otherwise preserve the legacy
		// live-then-persisted raw goal fallback used by standalone delegates.
		const parentEffectiveGoalId = initialTrustedTeamGoalId
			?? parentSession?.goalId ?? parentSession?.teamGoalId
			?? parentMeta?.goalId ?? parentMeta?.teamGoalId;
		const sourceAllowedTools = opts.allowedTools ?? parentSession?.allowedTools;
		const parentAllowedTools: EffectiveTool[] | undefined = sourceAllowedTools
			? tagAllowedTools(sourceAllowedTools, ctx.toolManager ?? undefined, scopedToolContext(parentProjectId, opts.cwd))
			: undefined;
		// H2 — PERSIST the (already-stripped) allow-list so restart/revive preserves
		// the recursion guard (spawn verbs removed) AND read-only restrictions
		// (mutating tools removed). persistOnce persists `allowedTools` ONLY from
		// `plan.sessionScopedAllowedTools`; without this the child's persisted
		// allowedTools is undefined and a restored child falls back to role defaults
		// — silently re-enabling team_delegate/team_spawn (grandchildren) and the
		// mutating tools a read-only child must never carry.
		const sessionScopedAllowedTools = sourceAllowedTools !== undefined
			? [...sourceAllowedTools]
			: undefined;
		const directGatewayEnv = !delegateSandboxed
			? this.scopedGatewayEnvForDirectAgent(id, parentProjectId, parentEffectiveGoalId)
			: undefined;
		const parentDurableModel = parentMeta?.modelProvider && parentMeta.modelId
			? normalizeAigwModelString(`${parentMeta.modelProvider}/${parentMeta.modelId}`)
			: undefined;
		const rawDelegateRoleModel = opts.role
			? this.resolveRoleModelValue(opts.role, parentProjectId)
			: undefined;
		const rawDelegateDefaultModel = this.preferencesStore?.get("default.sessionModel") as string | undefined;
		const exactDelegateModel = opts.initialModel
			?? parentDurableModel
			?? rawDelegateRoleModel
			?? rawDelegateDefaultModel;
		// Explicit delegate/role selections and parent durability are mandatory.
		// Only a genuinely tuple-less legacy parent may use deterministic catalog
		// selection, and validation happens before executePlan can persist or spawn.
		const delegateInitialModel = exactDelegateModel
			? await this.requireCurrentCatalogSpawnModel(exactDelegateModel)
			: await this.resolveCurrentCatalogSpawnModel([]);
		const delegateThinkingCandidate = opts.initialThinkingLevel
			?? parentMeta?.effectiveThinkingLevel;
		const delegateInitialThinking = await this.resolveCurrentCatalogThinkingLevel(
			delegateInitialModel,
			opts.role,
			parentProjectId,
			delegateThinkingCandidate,
		);

		// Role injection (§Gap 2): resolve the role prompt cascade-first, mirroring
		// createSession, so a `team_delegate(role: X)` child carries role X's
		// promptTemplate. Tools are left untouched (already stripped by the caller).
		let resolvedRolePrompt: string | undefined;
		if (opts.role) {
			const template = this.resolveRolePromptTemplate(opts.role, parentProjectId);
			if (template) {
				const goalBranch = parentEffectiveGoalId ? this.resolveGoal(parentEffectiveGoalId)?.branch : undefined;
				resolvedRolePrompt = resolveRolePrompt({ promptTemplate: template }, {
					branch: goalBranch,
					agentId: `${opts.role}-${id.slice(0, 8)}`,
					roleManager: this.roleManager ?? undefined,
					subGoalsEnabled: this.isSubgoalsEnabled,
				});
			}
		}

		const plan: SessionSetupPlan = {
			id,
			mode: "delegate",
			// Role injection: role/roleName drive the shared role-accessory application
			// in session-setup; rolePrompt reaches assemblePrompt via _resolvePrompt.
			role: opts.role,
			roleName: opts.role,
			rolePrompt: resolvedRolePrompt,
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
			initialModel: delegateInitialModel,
			initialThinkingLevel: delegateInitialThinking,
			requestedModel: exactDelegateModel ?? delegateInitialModel,
			requestedThinkingLevel: delegateThinkingCandidate ?? delegateInitialThinking,
			// Caller toolEnv is non-secret metadata. directGatewayEnv is minted by the
			// gateway and spread last so user-supplied env cannot widen the inherited
			// project/session scope.
			env: { ...(opts.env ?? {}), ...(directGatewayEnv ?? {}) },
			bridgeOptions: { cwd: opts.cwd },
		};

		const releaseSetupThinkingAuthority = this.retainSetupInitialThinkingAuthority(
			plan.id,
			delegateThinkingCandidate,
		);
		let session: SessionInfo;
		try {
			const setupTrustedTeamGoalId = this.getTrustedTeamGoalIdForSession(parentSessionId);
			if (setupTrustedTeamGoalId && this.resolveGoal(setupTrustedTeamGoalId)?.archived) {
				throw new Error("Cannot create a delegate for an archived team goal");
			}
			session = await executePlan(plan, ctx);
		} finally {
			releaseSetupThinkingAuthority();
		}
		if (parentProjectId) session.projectId = parentProjectId;
		// Re-evaluate the published child, not only its parent: reconciliation may
		// have archived/removed the parent while setup was in flight.
		const postSetupTrustedTeamGoalId = this.getTrustedTeamGoalIdForSession(session.id);
		if (postSetupTrustedTeamGoalId && this.resolveGoal(postSetupTrustedTeamGoalId)?.archived) {
			// The setup crossed terminal intent. Its initial row already carries
			// teamGoalId, so boot can reconstruct cleanup even if this stop fails.
			try {
				const terminated = await this.terminateSession(session.id);
				if (!terminated) await this.storeArchive(session.id);
			} catch { try { await this.storeArchive(session.id); } catch { /* boot repair retries */ } }
			throw new Error("Delegate creation was cancelled because its team goal was archived");
		}
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

		// Preserve an authenticated owner's identity for orchestration-created
		// delegates. Direct/server-created delegates omit provenance and remain
		// system-authored; sendDelegatePrompt validates the pair fail-closed.
		try {
			await sendDelegatePrompt(session, opts.instructions, DELEGATE_SPAWN_TIMEOUT_MS, {
				source: opts.source,
				author: opts.author,
			});
		} finally {
			// Delegate bootstrap bypasses the queue; persist its direct occurrence
			// before setup failure handling or a later restart can retry it.
			this.broadcastQueue(session);
		}

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
					this.clock.clearTimeout(timer);
					unsub();
					waiters.delete(waiter);
					if (waiters.size === 0) this._idleWaiters.delete(sessionId);
				},
			};
			timer = this.clock.setTimeout(() => {
				waiter.cleanup();
				reject(new Error(`Timeout waiting for session ${sessionId} to become idle`));
			}, timeoutMs);

			unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_end" && event.willRetry !== true) {
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
			const timer = this.clock.setTimeout(() => {
				unsub();
				reject(new Error(`Timeout waiting for session ${sessionId} to start streaming`));
			}, timeoutMs);

			const unsub = session.rpcClient.onEvent((event: any) => {
				if (event.type === "agent_start") {
					this.clock.clearTimeout(timer);
					unsub();
					resolve();
				}
				if (event.type === "process_exit") {
					this.clock.clearTimeout(timer);
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

	/** Read and parse the durable JSONL without requiring a live Pi bridge. */
	private async readPersistedTranscriptEntries(sessionId: string): Promise<unknown[] | undefined> {
		const ps = this.resolveStoreForId(sessionId)?.get(sessionId);
		if (!ps?.agentSessionFile) return undefined;
		try {
			const safeFile = safePersistedHostAgentSessionFile(ps.agentSessionFile);
			if (!safeFile) return undefined;
			trustPersistedAgentSessionFile(safeFile);
			const ctx = sessionFsContextForAgentFile(ps, safeFile);
			const content = await sessionFileRead(ctx, safeFile, this.sandboxManager);
			if (content === null || content === undefined) return undefined;
			const entries: unknown[] = [];
			for (const line of content.split(/\r?\n/)) {
				if (!line.trim()) continue;
				try { entries.push(JSON.parse(line)); } catch { /* skip malformed line */ }
			}
			return entries;
		} catch {
			return undefined;
		}
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

	/**
	 * Read a (dormant/non-live) session's final assistant output from its PERSISTED
	 * transcript file. Used as the H1 fallback so a child that completed before a
	 * restart can still be collected via team_wait without a live process.
	 */
	private async getPersistedSessionOutput(sessionId: string): Promise<string> {
		const entries = await this.readPersistedTranscriptEntries(sessionId);
		if (!entries) return "";
		return this.extractAssistantText(prepareArchivedMessageSnapshot(entries));
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

		const msgsResp = await this.getMessagesSnapshotBase(session);
		if (!msgsResp.success) return this.getPersistedSessionOutput(sessionId);

		const snapshot: any = msgsResp.data;
		const messages = snapshot?.messages || snapshot;
		if (!Array.isArray(messages)) return "";

		return this.extractAssistantText(messages);
	}

	/**
	 * Return the normalized agent snapshot base for the session's current event
	 * sequence. The promise is installed before awaiting so concurrent tabs share
	 * one RPC. Failed responses and rejections clear only their owning slot, so a
	 * newer-sequence request cannot be clobbered by an older completion.
	 *
	 * Callers must treat `data` as immutable and freshly apply in-flight overlays,
	 * sidecar merges, truncation, ordering stamps, and serialization.
	 */
	async getMessagesSnapshotBase(session: SessionInfo): Promise<MessageSnapshotBaseResponse> {
		// Lightweight unit seams may instantiate the prototype without field
		// initializers. Real managers always own this map and retain both clear fences.
		if (!this._sessionReplacementCoordinators) {
			return this._getMessagesSnapshotBaseUnfenced(session);
		}
		let candidate = session;
		for (;;) {
			const before = this._sessionReplacementCoordinators.get(candidate.id);
			if (before?.active?.kind === "clear-context") {
				await before.tail;
				const canonical = this.sessions.get(candidate.id);
				if (!canonical) return { success: false, error: "Session is unavailable after context clear" };
				candidate = canonical;
				continue;
			}
			const seq = candidate.eventBuffer.lastSeq;
			const response = await this._getMessagesSnapshotBaseUnfenced(candidate);
			const after = this._sessionReplacementCoordinators.get(candidate.id);
			const canonical = this.sessions.get(candidate.id);
			if (after?.active?.kind === "clear-context"
				|| canonical !== candidate
				|| candidate.eventBuffer.lastSeq !== seq) {
				if (after?.active?.kind === "clear-context") await after.tail;
				const refreshed = this.sessions.get(candidate.id);
				if (!refreshed) return { success: false, error: "Session is unavailable after context replacement" };
				candidate = refreshed;
				continue;
			}
			return response;
		}
	}

	/** Transaction-internal snapshot read. Clear must never wait on its own fence. */
	private async _getMessagesSnapshotBaseUnfenced(session: SessionInfo): Promise<MessageSnapshotBaseResponse> {
		const seq = session.eventBuffer.lastSeq;
		const cached = session.messagesSnapshotCache;
		if (cached?.seq === seq) return cached.promise;

		const promise = (async (): Promise<MessageSnapshotBaseResponse> => {
			if (session.condition?.code === "MODEL_SELECTION_REQUIRED") {
				const entries = await this.readPersistedTranscriptEntries(session.id);
				return entries
					? { success: true, data: prepareArchivedMessageSnapshot(entries) }
					: { success: false, error: "Persisted session transcript is unavailable" };
			}
			const cursorRead = typeof session.rpcClient.getTranscriptCursorSnapshot === "function"
				? session.rpcClient.getTranscriptCursorSnapshot()
				: Promise.resolve(undefined);
			const [response, cursorResponse] = await Promise.all([
				session.rpcClient.getMessages(),
				cursorRead.catch(() => undefined),
			]);
			if (!response?.success) return response;
			const data = normalizeToolResultErrorSnapshot(response.data);
			const messages = Array.isArray(data)
				? data
				: data && typeof data === "object" && Array.isArray((data as any).messages)
					? (data as any).messages
					: undefined;
			const cursorEntryIds = messages && cursorResponse?.success
				? correlateTranscriptPromptEntryIds(
					messages,
					cursorResponse.data as TranscriptCursorSnapshot,
					{ allowUnpersistedTail: session.status === "streaming" },
				)
				: undefined;
			return {
				...response,
				data,
				...(cursorEntryIds ? { cursorEntryIds } : {}),
			};
		})();
		session.messagesSnapshotCache = { seq, promise };
		promise.then(
			(response) => {
				if (!response?.success && session.messagesSnapshotCache?.promise === promise) {
					session.messagesSnapshotCache = undefined;
					session.messagesSnapshotCursorProjection = undefined;
					return;
				}
				if (response.success
					&& response.data !== undefined
					&& response.cursorEntryIds
					&& session.messagesSnapshotCache?.promise === promise) {
					session.messagesSnapshotCursorProjection = {
						seq,
						data: response.data,
						entryIds: response.cursorEntryIds,
					};
				} else if (session.messagesSnapshotCache?.promise === promise) {
					session.messagesSnapshotCursorProjection = undefined;
				}
			},
			() => {
				if (session.messagesSnapshotCache?.promise === promise) {
					session.messagesSnapshotCache = undefined;
					session.messagesSnapshotCursorProjection = undefined;
				}
			},
		);
		return promise;
	}

	/** Query the agent for its session file and save metadata to disk */
	/** After compaction, refresh messages and state for all connected clients. */
	async refreshAfterCompaction(session: SessionInfo): Promise<void> {
		try {
			// Send the authoritative cumulative cost before the compacted messages
			// snapshot so clients never fall back to the reduced visible transcript.
			this.broadcastSessionCost(session);

			// Compaction changes Pi's visible transcript without necessarily advancing
			// Bobbit's event sequence before this async refresh starts. Discard the old
			// base and its identity-bound cursor projection so get_messages and the
			// authoritative cursor plane are read and correlated as one fresh pair.
			session.messagesSnapshotCache = undefined;
			session.messagesSnapshotCursorProjection = undefined;
			const msgs = await this.getMessagesSnapshotBase(session);
			if (msgs.success) {
				const data = this.buildVisibleMessageSnapshot(session.id, msgs.data);
				broadcast(session.clients, { type: "messages", data: data as unknown[] });
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
			// `isSpawnPinnableModelString` additionally screens out Code Assist when
			// no Google credential is present (unauthenticated `google-gemini-cli/*`
			// would fail to resolve as Pi's `--model`).
			if (m && /^[^/]+\/.+$/.test(m)) {
				const normalized = normalizeAigwModelString(m);
				if (isSpawnPinnableModelString(normalized)) return normalized;
			}
		}
		// default.sessionModel preference
		const pref = this.preferencesStore?.get("default.sessionModel") as string | undefined;
		if (pref && /^[^/]+\/.+$/.test(pref)) {
			const normalized = normalizeAigwModelString(pref);
			if (isSpawnPinnableModelString(normalized)) return normalized;
		}
		return undefined;
	}

	/**
	 * Final authority for the tuple that Pi will actually receive. Raw argv is
	 * last-wins, so this runs only after every extension/remap has assembled args.
	 * It validates the effective model against the exact target catalog row,
	 * clamps thinking from that row, then removes raw selection flags and leaves
	 * one canonical initial tuple. Requested identity remains diagnostic-only.
	 */
	private async finalizeSpawnOptions(
		options: RpcBridgeOptions,
		requested: { model?: string; thinkingLevel?: string; role?: string; projectId?: string } = {},
	): Promise<void> {
		options.requestedModel = requested.model ?? options.requestedModel ?? options.initialModel;
		options.requestedThinkingLevel = requested.thinkingLevel
			?? options.requestedThinkingLevel
			?? options.initialThinkingLevel;
		if (options.initialThinkingLevel && !isKnownThinkingLevel(options.initialThinkingLevel)) {
			throw new Error(`Invalid Pi spawn thinking level "${sanitizeModelErrorText(options.initialThinkingLevel)}"`);
		}

		const resolved = resolveEffectivePiSelection(options);
		if (!resolved.effectiveModel) {
			throw new Error(
				`Pi spawn selection is incomplete (requested model: ${sanitizeModelErrorText(resolved.requestedModel ?? "<none>")})`,
			);
		}
		if (!this.preferencesStore) throw new Error("the model catalog is unavailable");
		const models = await getAvailableModels(this.preferencesStore);
		let effectiveModel: string;
		try {
			effectiveModel = await this.requireCurrentCatalogSpawnModel(resolved.effectiveModel, models);
		} catch (error) {
			const requestedModel = resolved.requestedModel;
			if (requestedModel && normalizeAigwModelString(requestedModel) !== resolved.effectiveModel) {
				throw new Error(
					`Effective Pi model ${sanitizeModelErrorText(resolved.effectiveModel)} from requested model ${sanitizeModelErrorText(requestedModel)} is not currently available for session selection; ${sanitizeModelErrorText(error)}`,
				);
			}
			throw error;
		}
		const slash = effectiveModel.indexOf("/");
		const catalogModel = findSessionSelectableModel(
			models,
			effectiveModel.slice(0, slash),
			effectiveModel.slice(slash + 1),
		);
		if (!catalogModel) {
			throw new Error(`Model ${sanitizeModelErrorText(effectiveModel)} is not currently available for session selection`);
		}
		const effectiveThinking = resolved.effectiveThinking
			? clampThinkingLevel(resolved.effectiveThinking, catalogModel)
			: undefined;

		options.args = resolved.sanitizedArgs;
		options.initialModel = effectiveModel;
		if (effectiveThinking) options.initialThinkingLevel = effectiveThinking;
		else delete options.initialThinkingLevel;

		// Raw argv may have crossed providers after earlier env assembly. Refresh
		// direct-host credentials from the validated effective provider; sandbox
		// credentials remain owned by its already-applied realm wiring.
		await this.applyDirectProviderEnv(
			options,
			options.sandboxed === true || !!options.containerId,
			effectiveModel.slice(0, slash),
		);
	}

	/** Require one exact provider/model tuple to remain in Bobbit's current catalog. */
	private async requireCurrentCatalogSpawnModel(
		model: string,
		models?: Awaited<ReturnType<typeof getAvailableModels>>,
	): Promise<string> {
		const normalized = normalizeAigwModelString(model);
		const slash = normalized.indexOf("/");
		const unavailable = (): Error => new Error(
			`Model ${sanitizeModelErrorText(normalized)} is not currently available for session selection`,
		);
		if (
			slash <= 0
			|| slash === normalized.length - 1
			|| !isSpawnPinnableModelString(normalized)
			|| !this.preferencesStore
		) {
			throw unavailable();
		}
		const currentModels = models ?? await getAvailableModels(this.preferencesStore);
		if (!findSessionSelectableModel(currentModels, normalized.slice(0, slash), normalized.slice(slash + 1))) {
			throw unavailable();
		}
		return normalized;
	}

	/**
	 * Resolve the first still-current preferred model, otherwise the authenticated-
	 * first/shared-rank catalog default used only by Bobbit-owned initial setup.
	 */
	private async resolveCurrentCatalogSpawnModel(
		preferredModels: readonly (string | undefined)[],
		models?: Awaited<ReturnType<typeof getAvailableModels>>,
	): Promise<string> {
		if (!this.preferencesStore) {
			throw new Error("No model is currently available for session selection");
		}

		const currentModels = models ?? await getAvailableModels(this.preferencesStore);
		for (const preferred of preferredModels) {
			if (!preferred) continue;
			const normalized = normalizeAigwModelString(preferred);
			const slash = normalized.indexOf("/");
			if (slash <= 0 || slash === normalized.length - 1 || !isSpawnPinnableModelString(normalized)) continue;
			if (findSessionSelectableModel(currentModels, normalized.slice(0, slash), normalized.slice(slash + 1))) {
				return normalized;
			}
		}

		const catalogDefault = currentModels
			.filter((model) => model.sessionSelectable !== false && isSpawnPinnableModelString(`${model.provider}/${model.id}`))
			.sort((a, b) => {
				const authDelta = Number(Boolean(b.authenticated)) - Number(Boolean(a.authenticated));
				if (authDelta !== 0) return authDelta;
				const rankDelta = modelRecencyRank(b.id) - modelRecencyRank(a.id);
				if (rankDelta !== 0) return rankDelta;
				return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
			})[0];
		if (!catalogDefault) {
			throw new Error("No model is currently available for session selection");
		}
		return `${catalogDefault.provider}/${catalogDefault.id}`;
	}

	/** Resolve and clamp a spawn thinking level against the exact chosen model. */
	private resolveThinkingLevelForModel(
		model: string | undefined,
		role: string | undefined,
		projectId: string | undefined,
		preferred?: string,
		catalogModel?: Awaited<ReturnType<typeof getAvailableModels>>[number],
		preferPreferred = false,
	): ThinkingLevel | undefined {
		const preferredCandidate = isKnownThinkingLevel(preferred);
		const roleCandidate = role
			? isKnownThinkingLevel(this.resolveRoleThinkingLevelValue(role, projectId))
			: undefined;
		let candidate = preferPreferred ? preferredCandidate : roleCandidate;
		if (!candidate) candidate = preferPreferred ? roleCandidate : preferredCandidate;
		if (!candidate) {
			candidate = isKnownThinkingLevel(
				this.preferencesStore?.get("default.sessionThinkingLevel") as string | undefined,
			);
		}
		if (!candidate) candidate = "medium";
		if (!model) return candidate;
		if (catalogModel) return clampThinkingLevel(candidate, catalogModel);
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1) return candidate;
		return clampThinkingLevelForModel(
			candidate,
			model.slice(0, slash),
			model.slice(slash + 1),
		);
	}

	/** Final spawn/restore clamp using the exact current session-selectable row. */
	private async resolveCurrentCatalogThinkingLevel(
		model: string | undefined,
		role: string | undefined,
		projectId: string | undefined,
		preferred?: string,
		models?: Awaited<ReturnType<typeof getAvailableModels>>,
		allowUnlistedRawModel = false,
		preferPreferred = false,
	): Promise<ThinkingLevel | undefined> {
		if (!model || !this.preferencesStore) {
			return this.resolveThinkingLevelForModel(model, role, projectId, preferred, undefined, preferPreferred);
		}
		const normalized = normalizeAigwModelString(model);
		const slash = normalized.indexOf("/");
		if (slash <= 0 || slash === normalized.length - 1) {
			return this.resolveThinkingLevelForModel(normalized, role, projectId, preferred, undefined, preferPreferred);
		}
		const currentModels = models ?? await getAvailableModels(this.preferencesStore);
		const catalogModel = findSessionSelectableModel(
			currentModels,
			normalized.slice(0, slash),
			normalized.slice(slash + 1),
		);
		if (!catalogModel) {
			if (allowUnlistedRawModel) {
				return this.resolveThinkingLevelForModel(normalized, role, projectId, preferred, undefined, preferPreferred);
			}
			throw new Error(`Model "${normalized}" is not currently available for session selection`);
		}
		return this.resolveThinkingLevelForModel(normalized, role, projectId, preferred, catalogModel, preferPreferred);
	}

	/** Preserve an already-chosen explicit/durable candidate ahead of role defaults. */
	private resolveCurrentCatalogPreferredThinkingLevel(
		model: string | undefined,
		role: string | undefined,
		projectId: string | undefined,
		preferred: string | undefined,
	): Promise<ThinkingLevel | undefined> {
		return this.resolveCurrentCatalogThinkingLevel(
			model,
			role,
			projectId,
			preferred,
			undefined,
			false,
			true,
		);
	}

	/**
	 * Resolve the thinking level to pin at spawn time for a session.
	 * Mirrors `tryApplyDefaultThinkingLevel`: role override →
	 * `default.sessionThinkingLevel` pref → "medium", clamped against the
	 * exact model selected by the same role/preferences resolution.
	 */
	resolveInitialThinkingLevel(role: string | undefined, projectId: string | undefined): string | undefined {
		return this.resolveThinkingLevelForModel(
			this.resolveInitialModel(role, projectId),
			role,
			projectId,
		);
	}

	/**
	 * Resolve the review/QA model to pin at spawn time. Mirrors the
	 * verification-harness precedence: role override → `default.reviewModel`.
	 */
	resolveInitialReviewModel(role: string | undefined, projectId: string | undefined): string | undefined {
		if (role) {
			const m = this.resolveRoleModelValue(role, projectId);
			if (m && /^[^/]+\/.+$/.test(m)) {
				const normalized = normalizeAigwModelString(m);
				if (isSpawnPinnableModelString(normalized)) return normalized;
			}
		}
		const pref = this.preferencesStore?.get("default.reviewModel") as string | undefined;
		if (pref && /^[^/]+\/.+$/.test(pref)) {
			const normalized = normalizeAigwModelString(pref);
			if (isSpawnPinnableModelString(normalized)) return normalized;
		}
		return undefined;
	}

	private async tryAutoSelectModel(session: SessionInfo): Promise<VerifiedSessionModelTuple | undefined> {
		// If the agent was spawned with `--model <provider>/<modelId>` already,
		// skip the redundant `setModel` RPC — read-back verification still runs
		// and hard-fails on mismatch.
		const spawnPinned = !!session.spawnPinnedModel;
		const allowSessionModelFallback = session._disableControlledModelFallback !== true
			&& this.preferencesStore?.get("allowSessionModelFallback") === true;
		const rawFallbackSessionModel = this.preferencesStore?.get("default.sessionModel") as string | undefined;
		const fallbackSessionModel = rawFallbackSessionModel ? normalizeAigwModelString(rawFallbackSessionModel) : rawFallbackSessionModel;

		// Model verification alone is not a durable commit. A successful model
		// mutation must also apply and read back the effective thinking level before
		// any store, model-name mirror, or client success frame is updated.
		let verifiedSpawnTuple;
		const commitExactSpawnTuple = async (
			modelString: string,
			explicitPreferredThinking?: ThinkingLevel,
		): Promise<void> => {
			const slash = modelString.indexOf("/");
			const provider = modelString.slice(0, slash);
			const modelId = modelString.slice(slash + 1);
			const persisted = this.resolveStoreForSession(session.id).get(session.id);
			const requestedThinking = explicitPreferredThinking
				?? isKnownThinkingLevel(session.spawnPinnedThinkingLevel)
				?? isKnownThinkingLevel(this.resolveRoleThinkingLevel(session))
				?? isKnownThinkingLevel(persisted?.effectiveThinkingLevel)
				?? isKnownThinkingLevel(this.preferencesStore?.get("default.sessionThinkingLevel") as string | undefined)
				?? "medium";
			const effectiveThinking = await this.resolveCurrentCatalogPreferredThinkingLevel(
				modelString,
				session.role,
				session.projectId,
				requestedThinking,
			);
			if (!effectiveThinking) throw new Error(`thinking level "${requestedThinking}" could not be normalized`);

			const beforeResp = await session.rpcClient.getState();
			if (beforeResp?.success === false) throw new Error("get_state failed before thinking selection");
			const before = beforeResp?.data ?? beforeResp;
			if (before?.model?.provider !== provider || before?.model?.id !== modelId) {
				throw new Error(`model read-back changed before thinking selection for ${modelString}`);
			}
			if (isKnownThinkingLevel(before?.thinkingLevel) !== effectiveThinking) {
				const setResp = await session.rpcClient.setThinkingLevel(effectiveThinking);
				if (setResp?.success === false) throw new Error(`thinking level "${effectiveThinking}" was rejected`);
			}

			const verifiedResp = await session.rpcClient.getState();
			if (verifiedResp?.success === false) throw new Error("get_state failed after thinking selection");
			const verified = verifiedResp?.data ?? verifiedResp;
			if (
				verified?.model?.provider !== provider
				|| verified?.model?.id !== modelId
				|| isKnownThinkingLevel(verified?.thinkingLevel) !== effectiveThinking
			) {
				throw new Error(`spawn tuple read-back mismatch for ${modelString}`);
			}

			const tuple = { provider, modelId, thinkingLevel: effectiveThinking };
			// Staged role candidates verify against Pi through the ordinary helper but
			// cannot advance shared authority until their lifecycle commit wins.
			if (session._deferVerifiedTupleCommit !== true) {
				this.persistSessionModel(session.id, provider, modelId, effectiveThinking);
				this._writeModelNameFile(session.id, modelString);
				broadcast(session.clients, {
					type: "state",
					data: { ...buildModelStateData(provider, modelId), thinkingLevel: effectiveThinking },
				});
			}
			session.spawnPinnedModel = modelString;
			session.spawnPinnedThinkingLevel = effectiveThinking;
			verifiedSpawnTuple = tuple;
		};
		// A controlled fallback changes the model against which thinking must be
		// clamped. Choose the raw authority for this setup context before looking at
		// the provisional spawn pin, which was clamped for the model that just failed.
		const resolveControlledFallbackThinking = () => {
			const persisted = this.resolveStoreForSession(session.id).get(session.id);
			const roleThinking = isKnownThinkingLevel(this.resolveRoleThinkingLevel(session));
			const durableThinking = persisted?.modelProvider && persisted?.modelId
				? isKnownThinkingLevel(persisted.effectiveThinkingLevel)
				: undefined;
			const explicitInitialThinking = this._setupInitialThinkingAuthorities.get(
				session.id,
			)?.initialThinkingLevel;
			const defaultThinking = isKnownThinkingLevel(
				this.preferencesStore?.get("default.sessionThinkingLevel") as string | undefined,
			);
			const provisionalThinking = isKnownThinkingLevel(session.spawnPinnedThinkingLevel);
			if (session._deferVerifiedTupleCommit === true) {
				return roleThinking
					?? durableThinking
					?? explicitInitialThinking
					?? defaultThinking
					?? provisionalThinking
					?? "medium";
			}
			return durableThinking
				?? roleThinking
				?? explicitInitialThinking
				?? defaultThinking
				?? provisionalThinking
				?? "medium";
		};

		// Spawn-pinned models are explicit selections too (restore/respawn persisted
		// model, role/default pin from initial setup, or caller-supplied initialModel).
		// Verify the actual bound model before the session becomes idle/live. If the
		// pinned model is stale or unavailable, never fall through to role/default
		// resolution, AIGW discovery, or SDK/provider defaults; with the opt-in policy
		// try only default.sessionModel.
		const pinnedModel = session.spawnPinnedModel ? normalizeAigwModelString(session.spawnPinnedModel) : session.spawnPinnedModel;
		if (pinnedModel) {
			const safePinnedModel = sanitizeModelErrorText(pinnedModel);
			let pinnedModelError;
			if (!isSessionSelectableModelString(pinnedModel)) {
				pinnedModelError = new Error(`spawn-pinned model "${safePinnedModel}" is not session-selectable`);
			} else {
				try {
					await applyModelString(session.rpcClient, pinnedModel, {
						contextLabel: "spawn-pinned model",
						skipSetModel: true,
					});
					await commitExactSpawnTuple(pinnedModel);
					if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Verified spawn-pinned model "${pinnedModel}" for session ${session.id}`);
					return verifiedSpawnTuple;
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
						const currentFallbackSessionModel = await this.requireCurrentCatalogSpawnModel(fallbackSessionModel);
						const pinnedMsg = sanitizeModelErrorText(pinnedModelError);
						const safeFallbackSessionModel = sanitizeModelErrorText(currentFallbackSessionModel);
						console.warn(`[session-manager] Spawn-pinned model "${safePinnedModel}" failed for ${session.id}; controlled fallback enabled, trying default.sessionModel="${safeFallbackSessionModel}": ${pinnedMsg}`);
						await applyModelString(session.rpcClient, currentFallbackSessionModel, {
							contextLabel: "default.sessionModel fallback",
						});
						await commitExactSpawnTuple(
							currentFallbackSessionModel,
							resolveControlledFallbackThinking(),
						);
						console.log(`[session-manager] Controlled fallback selected default.sessionModel "${currentFallbackSessionModel}" for session ${session.id} after spawn-pinned model "${pinnedModel}" failed`);
						return verifiedSpawnTuple;
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
		const rawRoleModel = this.resolveRoleModel(session);
		const roleModel = rawRoleModel ? normalizeAigwModelString(rawRoleModel) : rawRoleModel;
		if (roleModel) {
			const safeRoleModel = sanitizeModelErrorText(roleModel);
			let roleModelError;
			if (!isSessionSelectableModelString(roleModel)) {
				roleModelError = new Error(`role.${session.role}.model "${safeRoleModel}" is not session-selectable`);
			} else {
				try {
					await applyModelString(session.rpcClient, roleModel, {
						contextLabel: `role.${session.role}.model`,
						skipSetModel: spawnPinned && normalizeAigwModelString(session.spawnPinnedModel || "") === roleModel,
					});
					await commitExactSpawnTuple(roleModel);
					console.log(`[session-manager] Set role-override model "${roleModel}" for session ${session.id} (role=${session.role})`);
					return verifiedSpawnTuple;
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
						const currentFallbackSessionModel = await this.requireCurrentCatalogSpawnModel(fallbackSessionModel);
						const roleMsg = sanitizeModelErrorText(roleModelError);
						const safeFallbackSessionModel = sanitizeModelErrorText(currentFallbackSessionModel);
						console.warn(`[session-manager] Role model "${safeRoleModel}" failed for ${session.id}; controlled fallback enabled, trying default.sessionModel="${safeFallbackSessionModel}": ${roleMsg}`);
						await applyModelString(session.rpcClient, currentFallbackSessionModel, {
							contextLabel: "default.sessionModel fallback",
							skipSetModel: spawnPinned && normalizeAigwModelString(session.spawnPinnedModel || "") === currentFallbackSessionModel,
						});
						await commitExactSpawnTuple(
							currentFallbackSessionModel,
							resolveControlledFallbackThinking(),
						);
						console.log(`[session-manager] Controlled fallback selected default.sessionModel "${currentFallbackSessionModel}" for session ${session.id} after role model "${roleModel}" failed`);
						return verifiedSpawnTuple;
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
		const rawSessionModelPref = this.preferencesStore.get("default.sessionModel") as string | undefined;
		const sessionModelPref = rawSessionModelPref ? normalizeAigwModelString(rawSessionModelPref) : rawSessionModelPref;
		if (sessionModelPref) {
			const safeSessionModelPref = sanitizeModelErrorText(sessionModelPref);
			if (!isSessionSelectableModelString(sessionModelPref)) {
				throw new Error(`default.sessionModel "${safeSessionModelPref}" is not session-selectable`);
			}
			const preSpawnPinned = spawnPinned && normalizeAigwModelString(session.spawnPinnedModel || "") === sessionModelPref;
			try {
				// Route through applyModelString to preserve the hard-fail-on-mismatch
				// contract (read-back via getState()) regardless of whether we skipped
				// the redundant setModel RPC because the spawn already pinned the same model.
				await applyModelString(session.rpcClient, sessionModelPref, {
					contextLabel: "default.sessionModel",
					skipSetModel: preSpawnPinned,
				});
				await commitExactSpawnTuple(sessionModelPref);
				if (process.env.BOBBIT_DEBUG) console.log(`[session-manager] Set preferred model "${sessionModelPref}" for session ${session.id}${preSpawnPinned ? " (spawn-pinned)" : ""}`);
				return verifiedSpawnTuple;
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
				this.clock.now() - this._aigwModelCache.ts < SessionManager.AIGW_CACHE_TTL_MS) {
				aigwModels = this._aigwModelCache.models;
			} else {
				aigwModels = await discoverAigwModels(aigwUrl);
				this._aigwModelCache = { url: aigwUrl, models: aigwModels, ts: this.clock.now() };
			}
		} catch (err) {
			console.warn(`[session-manager] Failed to discover aigw models for auto-selection:`, err);
			return;
		}
		if (aigwModels.length === 0) return;

		const modelToUse = [...aigwModels].sort((a, b) => modelRecencyRank(b.id) - modelRecencyRank(a.id))[0];
		const aigwModel = `aigw/${modelToUse.id}`;
		try {
			await applyModelString(session.rpcClient, aigwModel, { contextLabel: "auto-selected aigw model" });
		} catch (err) {
			console.warn(`[session-manager] Failed to auto-select model for ${session.id}:`, err);
			return;
		}
		await commitExactSpawnTuple(aigwModel);
		console.log(`[session-manager] Auto-selected aigw model "${modelToUse.id}" for session ${session.id}`);
		return verifiedSpawnTuple;
	}

	/** Apply, read back, and atomically persist thinking with the exact live model. */
	private async tryApplyDefaultThinkingLevel(session: SessionInfo): Promise<VerifiedSessionModelTuple> {
		const persisted = this.resolveStoreForSession(session.id).get(session.id);
		const spawnPinnedThinking = isKnownThinkingLevel(session.spawnPinnedThinkingLevel);
		const spawnPinnedModel = session.spawnPinnedModel
			? normalizeAigwModelString(session.spawnPinnedModel)
			: undefined;
		const spawnModelSlash = spawnPinnedModel?.indexOf("/") ?? -1;
		// tryAutoSelectModel has already read back and atomically persisted this exact
		// spawn tuple. Return before the first await so the normal setup path cannot
		// leave a detached redundant thinking read that races a newer live selection.
		if (
			spawnPinnedThinking
			&& spawnPinnedModel
			&& spawnModelSlash > 0
			&& persisted?.modelProvider === spawnPinnedModel.slice(0, spawnModelSlash)
			&& persisted?.modelId === spawnPinnedModel.slice(spawnModelSlash + 1)
			&& persisted?.effectiveThinkingLevel === spawnPinnedThinking
		) {
			return {
				provider: spawnPinnedModel.slice(0, spawnModelSlash),
				modelId: spawnPinnedModel.slice(spawnModelSlash + 1),
				thinkingLevel: spawnPinnedThinking,
			};
		}
		const roleThinking = isKnownThinkingLevel(this.resolveRoleThinkingLevel(session));
		const durableThinking = isKnownThinkingLevel(persisted?.effectiveThinkingLevel);
		const preferenceThinking = isKnownThinkingLevel(
			this.preferencesStore?.get("default.sessionThinkingLevel") as string | undefined,
		);
		const requested = spawnPinnedThinking ?? roleThinking ?? durableThinking ?? preferenceThinking ?? "medium";

		const applyAndVerify = async (candidate: ThinkingLevel): Promise<VerifiedSessionModelTuple> => {
			const beforeResp = await session.rpcClient.getState();
			if (beforeResp?.success === false) throw new Error("get_state failed before thinking selection");
			const before = beforeResp?.data ?? beforeResp;
			const provider = typeof before?.model?.provider === "string" ? before.model.provider : undefined;
			const modelId = typeof before?.model?.id === "string" ? before.model.id : undefined;
			if (!provider || !modelId) throw new Error("get_state returned no exact model before thinking selection");
			const effective = await this.resolveCurrentCatalogThinkingLevel(
				`${provider}/${modelId}`,
				session.role,
				session.projectId,
				candidate,
				undefined,
				!session.spawnPinnedModel,
			);
			if (!effective) throw new Error(`thinking level "${candidate}" could not be normalized`);
			if (
				persisted?.modelProvider === provider
				&& persisted?.modelId === modelId
				&& persisted?.effectiveThinkingLevel === effective
				&& isKnownThinkingLevel(before?.thinkingLevel) === effective
			) {
				return { provider, modelId, thinkingLevel: effective };
			}
			if (before?.thinkingLevel !== effective) {
				const setResp = await session.rpcClient.setThinkingLevel(effective);
				if (setResp?.success === false) throw new Error(`thinking level "${effective}" was rejected`);
			}

			const verifiedResp = await session.rpcClient.getState();
			if (verifiedResp?.success === false) throw new Error("get_state failed after thinking selection");
			const verified = verifiedResp?.data ?? verifiedResp;
			const verifiedProvider = verified?.model?.provider;
			const verifiedModelId = verified?.model?.id;
			const verifiedThinking = isKnownThinkingLevel(verified?.thinkingLevel);
			if (verifiedProvider !== provider || verifiedModelId !== modelId || verifiedThinking !== effective) {
				throw new Error(`thinking selection read-back mismatch for ${provider}/${modelId}`);
			}
			if (session._deferVerifiedTupleCommit !== true) {
				this.persistSessionModel(session.id, provider, modelId, effective);
			}
			session.spawnPinnedModel = `${provider}/${modelId}`;
			session.spawnPinnedThinkingLevel = effective;
			return { provider, modelId, thinkingLevel: effective };
		};

		const verifiedTuple = await applyAndVerify(requested);
		if (process.env.BOBBIT_DEBUG) {
			console.log(`[session-manager] Verified effective thinking level "${verifiedTuple.thinkingLevel}" for session ${session.id}`);
		}
		return verifiedTuple;
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
						await new Promise(resolve => this.clock.setTimeout(() => resolve(undefined), delays[attempt]));
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
				const agentSessionFile = stateResp.data.sessionFile;
				const metadataStore = this.resolveStoreForSession(session.id);
				const current = metadataStore.get(session.id);
				if (!current) {
					// Preserve the historical lightweight-store seam used before a full
					// persisted record exists. There is no clear boundary to validate and
					// Pi must remain the sole owner of lazy transcript creation.
					metadataStore.update(session.id, { agentSessionFile });
					return;
				}
				const latestClear = latestContextClearBoundary(current.contextClearBoundaries);
				const transcriptMaterialized = await sessionFileExists(
					sessionFsContextForAgentFile(current, agentSessionFile),
					agentSessionFile,
					this.sandboxManager,
				);
				if (latestClear && !latestClear.activatedTranscriptMaterialized) {
					if (!this._sameAgentSessionPath(current, current.agentSessionFile, latestClear.activatedAgentSessionFile)
						|| !this._sameAgentSessionPath(current, agentSessionFile, latestClear.activatedAgentSessionFile)) {
						throw new Error("Refusing to rotate an unmaterialized cleared generation outside its atomic recovery path");
					}
					if (transcriptMaterialized) {
						const boundaries = normalizeContextClearBoundaries(current.contextClearBoundaries);
						boundaries[boundaries.length - 1] = {
							...latestClear,
							activatedTranscriptMaterialized: true,
						};
						metadataStore.update(session.id, { agentSessionFile, contextClearBoundaries: boundaries });
						await metadataStore.flushAsync();
					} else {
						// NEVER pre-create this file. Pi uses exclusive creation on the first
						// assistant flush; keep the durable false marker for restart recovery.
						metadataStore.update(session.id, { agentSessionFile });
					}
				} else {
					metadataStore.update(session.id, { agentSessionFile });
				}

				// A recovery sidecar is meaningful only once Pi has materialized the
				// transcript. Writing it earlier must not manufacture the JSONL itself.
				if (transcriptMaterialized) {
					try {
						const ps = metadataStore.get(session.id);
						if (ps) {
							const agentSessionId = (stateResp.data?.sessionId as string | undefined)
								|| path.basename(agentSessionFile).replace(/\.jsonl$/, "");
							const sidecar = buildSessionSidecar(ps, agentSessionId, undefined);
							writeSessionSidecar(agentSessionFile, sidecar);
						}
					} catch (err) {
						console.warn(`[session-manager] Failed to write session sidecar for ${session.id}: ${err}`);
					}
				}
				return; // success
			} catch (err) {
				if (attempt < maxRetries) {
					console.warn(`[session-manager] persistSessionMetadata failed for ${session.id} (attempt ${attempt + 1}), retrying: ${err}`);
					await new Promise(resolve => this.clock.setTimeout(() => resolve(undefined), delays[attempt]));
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

	/** Resolve the current accountable identity for an agent prompt producer. */
	resolveSessionAgentAuthor(id: string): MessageAuthor | undefined {
		const session = this.sessions.get(id);
		if (!session) return undefined;
		return agentAuthorForSession(session, this.messageAuthorDependencies(session));
	}

	/** Apply the single Bobbit-visible snapshot pipeline to Pi RPC/transcript data. */
	buildVisibleMessageSnapshot<T>(id: string, snapshot: T): T {
		const live = this.sessions.get(id);
		const persisted = this.resolveStoreForId(id)?.get(id);
		const identity = live ?? persisted;
		const correlatedSnapshot = applyArchivedSnapshotCorrelations(snapshot);
		const cursorProjection = live?.messagesSnapshotCursorProjection;
		const visible = buildVisibleMessageSnapshotData(correlatedSnapshot, {
			sessionId: id,
			session: {
				id,
				title: identity?.title,
				role: identity?.role,
				staffId: identity?.staffId,
			},
			agentDeps: this.messageAuthorDependencies(identity),
			latestMessageUpdate: live?.latestMessageUpdate,
			inFlightSteerTexts: live?.inFlightSteerTexts,
			contextClearBoundaries: persisted?.contextClearBoundaries,
			...(cursorProjection?.data === snapshot
				? { transcriptPromptEntryIds: cursorProjection.entryIds }
				: {}),
		});
		return stripArchivedSnapshotCorrelations(visible);
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
			id: session.pendingGrantRequest.id,
			toolName: session.pendingGrantRequest.toolName,
			group: session.pendingGrantRequest.toolGroup,
			roleName: role?.name ?? roleName,
			roleLabel: role?.label ?? roleName,
			lastPromptText: session.lastPromptText,
			requestCount: session.pendingGrantRequest.requests?.length ?? 1,
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
		const now = this.clock.now();

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
		installSessionActivityAttribution(session, extStore, { now: () => this.clock.now() });
		const unsub = rpcClient.onEvent((event: any) => {
			const preparedEvent = this.prepareVisibleAgentEvent(session, event);
			recordSessionEventActivity(session, preparedEvent);
			this.handleAgentLifecycle(session, preparedEvent);
			this.emitAgentEvent(session, preparedEvent);
			this.trackCostFromEvent(session, preparedEvent);
		});
		session.unsubscribe = unsub;
		this.sessions.set(id, session);

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
			this._taskIdCache.delete(id);
			extStore.remove(id);
			cleanupSessionPrompt(id, this.stateDir);
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

	private sessionListUnreadSources(): SessionListTagSource[] {
		return Array.from(this.sessions.values()).map((session) => {
			let persisted: PersistedSession | undefined;
			try { persisted = this.resolveStoreForSession(session.id).get(session.id); } catch { /* transient store resolution */ }
			return {
				id: session.id,
				status: session.status,
				lastActivity: session.lastActivity,
				lastReadAt: persisted?.lastReadAt,
				isCompacting: session.isCompacting,
				delegateOf: session.delegateOf,
				goalId: session.goalId,
				role: session.role,
				teamGoalId: session.teamGoalId,
				teamLeadSessionId: session.teamLeadSessionId,
				lastTurnErrored: session.lastTurnErrored,
				consecutiveErrorTurns: session.consecutiveErrorTurns,
				archived: false,
				projectId: persisted?.projectId ?? session.projectId,
				user_tags: persisted?.user_tags,
			};
		});
	}

	/** Attach fresh derived server tags and normalized durable user tags to a list row. */
	serializeSessionListTags<T extends SessionListTagSource>(
		session: T,
		overrides?: { archived?: boolean; allSessions?: readonly SessionListTagSource[] },
	): T & { server_tags: string[]; user_tags: string[]; hasUnansweredQuestion: boolean } {
		const effectiveGoalId = session.teamGoalId ?? session.goalId;
		const allSessions = overrides?.allSessions ?? this.sessionListUnreadSources();
		const active = effectiveGoalId
			? (this._verificationHarness?.getActiveVerifications(effectiveGoalId) ?? [])
			: [];
		const gateStatusCache: SessionListTagProjectionContext["gateStatusCache"] = effectiveGoalId
			? new Map([[effectiveGoalId, {
				verifying: active.some(verification => verification.overallStatus === "running"),
				awaitingHumanSignoff: active.some(verification =>
					verification.overallStatus === "running"
					&& verification.steps.some(step => step.awaitingHuman === true)),
			}]])
			: new Map();
		return {
			...projectSessionListTags(session, {
				allSessions,
				goal: effectiveGoalId ? this.resolveGoal(effectiveGoalId) : undefined,
				gateStatusCache,
				archived: overrides?.archived,
				projectId: session.projectId,
				goalId: effectiveGoalId,
			}),
			hasUnansweredQuestion: (session as T & { hasUnansweredQuestion?: unknown }).hasUnansweredQuestion === true,
		};
	}

	listSessions(): Array<{
		id: string;
		title: string;
		cwd: string;
		status: string;
		createdAt: number;
		lastActivity: number;
		lastReadAt?: number;
		hasUnansweredQuestion: boolean;
		lastTurnErrored?: boolean;
		consecutiveErrorTurns?: number;
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
		effectiveThinkingLevel?: ThinkingLevel;
		condition?: ModelSelectionRequiredCondition;
		repoPath?: string;
		branch?: string;
		repoWorktrees?: Record<string, string>;
		server_tags: string[];
		user_tags: string[];
	}> {
		const allSessions = this.sessionListUnreadSources();
		return Array.from(this.sessions.values()).map((s) => {
			let ps: PersistedSession | undefined;
			try {
				ps = this.resolveStoreForSession(s.id).get(s.id);
			} catch {
				// Session can't be resolved (no projectId, not in any store) — use in-memory data only
			}
			return this.serializeSessionListTags({
				id: s.id,
				title: s.title,
				cwd: s.cwd,
				status: s.status,
				createdAt: s.createdAt,
				lastActivity: s.lastActivity,
				lastReadAt: ps?.lastReadAt,
				hasUnansweredQuestion: ps?.hasUnansweredQuestion === true,
				lastTurnErrored: s.lastTurnErrored,
				consecutiveErrorTurns: s.consecutiveErrorTurns,
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
				spawnPinnedModel: s.spawnPinnedModel,
				spawnPinnedThinkingLevel: s.spawnPinnedThinkingLevel,
				effectiveThinkingLevel: ps?.effectiveThinkingLevel,
				condition: s.condition,
				repoPath: ps?.repoPath || s.repoPath,
				branch: ps?.branch || s.branch,
				repoWorktrees: ps?.repoWorktrees || (s.repoWorktrees ? Object.fromEntries(s.repoWorktrees.map(w => [w.repo, w.worktreePath])) : undefined),
				user_tags: ps?.user_tags,
			}, { allSessions });
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

	/**
	 * Record that the user viewed this session. The acknowledgement is a
	 * durability barrier for this mutation only; routine activity remains
	 * debounced and asynchronous.
	 */
	async markSessionRead(id: string): Promise<boolean> {
		const store = this.resolveStoreForId(id);
		if (!store?.get(id)) return false;
		store.update(id, { lastReadAt: this.clock.now() });
		await store.flushAsync();
		return true;
	}

	/** Read the durable, exact ask-card dismissal IDs for a session. */
	getDismissedAskToolUseIds(id: string): string[] | undefined {
		const persisted = this.resolveStoreForId(id)?.get(id);
		return persisted ? normalizeDismissedAskToolUseIds(persisted.dismissedAskToolUseIds) : undefined;
	}

	private async withAskTerminalMutation<T>(id: string, mutation: () => Promise<T>): Promise<T> {
		const predecessor = this._askTerminalMutationQueues.get(id) ?? Promise.resolve();
		const operation = predecessor.catch(() => {}).then(mutation);
		const tail = operation.then(() => {}, () => {});
		this._askTerminalMutationQueues.set(id, tail);
		try {
			return await operation;
		} finally {
			if (this._askTerminalMutationQueues.get(id) === tail) this._askTerminalMutationQueues.delete(id);
		}
	}

	private async currentAskTranscript(id: string): Promise<unknown[]> {
		const session = this.sessions.get(id);
		if (!session) throw new Error(`Session is not active: ${id}`);
		const response = await session.rpcClient.getMessages();
		const raw = response.data?.messages ?? response.data;
		if (!Array.isArray(raw)) throw new Error(`Could not load transcript for session: ${id}`);
		return raw;
	}

	private durableQueuedAskResponseIds(id: string): Set<string> {
		const session = this.sessions.get(id);
		const rows = [
			...(session?.promptQueue.toArray() ?? []),
			...(session?.inFlightSteerTexts ?? []),
		];
		const ids = new Set<string>();
		for (const row of rows) {
			const parsed = parseAskResponseEnvelope(row.text);
			if (parsed) ids.add(parsed.toolUseId);
		}
		return ids;
	}

	/** Durably dismiss one ask card without touching the prompt queue or agent runtime. */
	async dismissAskToolUse(id: string, toolUseId: string): Promise<{ dismissedToolUseIds: string[]; alreadyDismissed: boolean }> {
		return this.withAskTerminalMutation(id, async () => {
			const store = this.resolveStoreForId(id);
			let persisted = store?.get(id);
			if (!store || !persisted) throw new Error(`Unknown session: ${id}`);

			let dismissedToolUseIds = normalizeDismissedAskToolUseIds(persisted.dismissedAskToolUseIds);
			if (dismissedToolUseIds.includes(toolUseId)) {
				return { dismissedToolUseIds, alreadyDismissed: true };
			}

			const messages = await this.currentAskTranscript(id);
			persisted = store.get(id);
			if (!persisted) throw new Error(`Unknown session: ${id}`);
			dismissedToolUseIds = normalizeDismissedAskToolUseIds(persisted.dismissedAskToolUseIds);
			if (dismissedToolUseIds.includes(toolUseId)) {
				return { dismissedToolUseIds, alreadyDismissed: true };
			}

			const fieldWasPresent = Object.prototype.hasOwnProperty.call(persisted, "dismissedAskToolUseIds");
			const previousValue = (persisted as PersistedSession & { dismissedAskToolUseIds?: unknown }).dismissedAskToolUseIds;
			const questionStateWasPresent = Object.prototype.hasOwnProperty.call(persisted, "hasUnansweredQuestion");
			const previousQuestionState = (persisted as PersistedSession & { hasUnansweredQuestion?: unknown }).hasUnansweredQuestion;
			const next = [...dismissedToolUseIds, toolUseId];
			const hasUnansweredQuestion = hasUnansweredAskUserChoices(
				messages,
				new Set(next),
				this.durableQueuedAskResponseIds(id),
			);
			store.update(id, { dismissedAskToolUseIds: next, hasUnansweredQuestion });
			try {
				await store.flushAsync();
			} catch (error) {
				store.restoreDismissedAskToolUseIdsShape(id, fieldWasPresent, previousValue);
				store.restoreHasUnansweredQuestionShape(id, questionStateWasPresent, previousQuestionState);
				try {
					await store.flushAsync();
				} catch (rollbackError) {
					console.error(`[session ${id}] Failed to persist ask-card dismissal rollback:`, rollbackError);
				}
				throw error;
			}
			if (previousQuestionState !== hasUnansweredQuestion) {
				this._onSessionQuestionStateChanged?.(id, hasUnansweredQuestion);
			}
			return { dismissedToolUseIds: next, alreadyDismissed: false };
		});
	}

	/** Recompute unresolved-question state from current durable terminal evidence. */
	async recomputeHasUnansweredQuestion(id: string, resolvedToolUseId?: string): Promise<boolean> {
		return this.withAskTerminalMutation(id, async () => {
			const messages = await this.currentAskTranscript(id);
			const store = this.resolveStoreForId(id);
			const persisted = store?.get(id);
			if (!store || !persisted) throw new Error(`Unknown session: ${id}`);
			const resolvedToolUseIds = this.durableQueuedAskResponseIds(id);
			if (resolvedToolUseId) resolvedToolUseIds.add(resolvedToolUseId);
			const hasUnansweredQuestion = hasUnansweredAskUserChoices(
				messages,
				new Set(normalizeDismissedAskToolUseIds(persisted.dismissedAskToolUseIds)),
				resolvedToolUseIds,
			);
			const changed = persisted.hasUnansweredQuestion !== hasUnansweredQuestion;
			store.update(id, { hasUnansweredQuestion });
			await store.flushAsync();
			if (changed) this._onSessionQuestionStateChanged?.(id, hasUnansweredQuestion);
			return hasUnansweredQuestion;
		});
	}

	/** Durably set the narrow pinned tag for live, dormant, terminated, or archived sessions. */
	async setSessionPinned(id: string, pinned: boolean): Promise<string[]> {
		const predecessor = this._pinMutationQueues.get(id) ?? Promise.resolve([]);
		let operation!: Promise<string[]>;
		operation = predecessor.catch(() => []).then(async () => {
			const store = this.resolveStoreForId(id);
			const persisted = store?.get(id);
			if (!store || !persisted) throw new SessionPinNotFoundError(id);

			// A failed durability fence must not leave its optimistic store mutation
			// available to list callers or a later save. Preserve the raw legacy shape,
			// including field absence, rather than restoring only normalized tags.
			const userTagsWerePresent = Object.prototype.hasOwnProperty.call(persisted, "user_tags");
			const previousUserTags = (persisted as PersistedSession & { user_tags?: unknown }).user_tags;
			const current = normalizeTags(previousUserTags);
			const user_tags = pinned
				? replaceTag(current, "pinned", "true")
				: removeTag(current, "pinned");
			store.update(id, { user_tags });
			try {
				await store.flushAsync();
			} catch (error) {
				store.restoreUserTagsShape(id, userTagsWerePresent, previousUserTags);
				try {
					// Keep the per-ID queue fenced until the compensation has either been
					// published or failed. In both cases memory already holds the baseline.
					await store.flushAsync();
				} catch (rollbackError) {
					console.error(`[session ${id}] Failed to persist pin rollback:`, rollbackError);
				}
				throw error;
			}
			return normalizeTags(store.get(id)?.user_tags);
		});
		this._pinMutationQueues.set(id, operation);
		try {
			return await operation;
		} finally {
			if (this._pinMutationQueues.get(id) === operation) this._pinMutationQueues.delete(id);
		}
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
		const updates = { childTerminal: true, terminalAt: this.clock.now() };
		if (this.sessions.has(childSessionId)) {
			this.updateSessionMeta(childSessionId, updates);
			return;
		}
		// Not live: try the archived path; if it is not archived (dormant store-only),
		// fall back to updateSessionMeta's store-only branch.
		if (!this.updateArchivedMeta(childSessionId, updates)) {
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
				borrowsWorktree: session.borrowsWorktree,
				borrowedWorktreeOwnerSessionId: session.borrowedWorktreeOwnerSessionId,
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
	 * Reserve a regular session before any current-session goal graph mutation.
	 * An exact retained attempt may reclaim its same process-local reservation for
	 * post-commit finalization or pre-commit repair; every competing mutation fails.
	 */
	reserveSessionGoalPromotion(id: string, goalId?: string): SessionGoalPromotionReservation {
		const existing = this._sessionGoalPromotionReservations.get(id);
		if (existing) {
			if (goalId && existing.goalId === goalId) return existing;
			throw new SessionGoalPromotionInProgressError(id);
		}
		const session = this.sessions.get(id);
		if (!session) throw new Error(`Session ${id} not found`);
		if (this._sessionReplacementCoordinators.has(id)) {
			throw new SessionGoalPromotionInProgressError(id);
		}
		const persisted = this.resolveStoreForSession(id).get(id);
		if (!persisted) throw new Error(`Session ${id} has no persisted record`);
		const alreadyPromoted = !!goalId
			&& session.goalId === goalId
			&& session.teamGoalId === goalId
			&& session.role === "team-lead"
			&& persisted.goalId === goalId
			&& persisted.teamGoalId === goalId
			&& persisted.role === "team-lead";
		if (goalId) {
			const goal = this.resolveGoal(goalId);
			if (!goal || goal.worktreeOwnerSessionId !== id || !this.goalWorkspaceCoordinatesMatchSession(goal, persisted)) {
				throw new Error(`Session ${id} cannot resume promotion for unrelated goal ${goalId}`);
			}
		}
		const baselineRole = (role: string | undefined) => role === undefined || role === "general";
		if (!alreadyPromoted && (!baselineRole(session.role) || !baselineRole(persisted.role) || session.role !== persisted.role)) {
			throw new Error(`Session ${id} no longer has its canonical baseline role`);
		}
		const reservation: OwnedSessionGoalPromotionReservation = {
			sessionId: id,
			attemptId: randomUUID(),
			...(goalId ? { goalId } : {}),
		};
		this._sessionGoalPromotionReservations.set(id, reservation);
		return reservation;
	}

	/** Bind the attempt to the exact adopted goal before lead/runtime attachment. */
	bindSessionGoalPromotion(reservation: SessionGoalPromotionReservation, goalId: string): void {
		const owned = this.requireSessionGoalPromotionReservation(reservation.sessionId, reservation);
		if (owned.goalId && owned.goalId !== goalId) {
			throw new Error(`Session ${reservation.sessionId} promotion is already bound to goal ${owned.goalId}`);
		}
		owned.goalId = goalId;
	}

	/** Release only the exact attempt authority currently owned by SessionManager. */
	releaseSessionGoalPromotion(reservation: SessionGoalPromotionReservation): boolean {
		if (this._sessionGoalPromotionReservations.get(reservation.sessionId) !== reservation) return false;
		this._sessionGoalPromotionReservations.delete(reservation.sessionId);
		return true;
	}

	/** Public read seam for goal-level destructive admission before any mutation. */
	isSessionGoalPromotionReserved(id: string): boolean {
		return this._sessionGoalPromotionReservations.has(id);
	}

	/** Public admission seam for server routes that directly mutate relation fields. */
	assertSessionGoalPromotionMutationAllowed(id: string): void {
		if (this.isSessionGoalPromotionReserved(id)) {
			throw new SessionGoalPromotionInProgressError(id);
		}
	}

	private requireSessionGoalPromotionReservation(
		id: string,
		reservation: SessionGoalPromotionReservation,
		goalId?: string,
	): OwnedSessionGoalPromotionReservation {
		const owned = this._sessionGoalPromotionReservations.get(id);
		if (owned !== reservation || reservation.sessionId !== id || (goalId !== undefined && owned.goalId !== goalId)) {
			throw new Error(`Session ${id} promotion reservation is missing or does not match goal ${goalId ?? "<unbound>"}`);
		}
		return owned;
	}

	/**
	 * Assign a role to an existing session. Requests for the same session are
	 * serialized. The first request marks the canonical session as `starting`, so
	 * prompts accepted while any replacement is staged are durably queued instead
	 * of being dispatched to a bridge that is about to stop. The final request
	 * releases the fence and drains that queue against the committed replacement,
	 * or against the original bridge after a clean rollback.
	 */
	async assignRole(id: string, role: { name: string; promptTemplate: string; accessory: string }): Promise<boolean> {
		this.assertSessionGoalPromotionMutationAllowed(id);
		const coordinator = this._sessionReplacementCoordinators.get(id);
		const session = this.sessions.get(id);
		// In-place restore/respawn deliberately removes SessionInfo while its
		// replacement is prepared. A role request accepted in that map gap must join
		// the active coordinator and look up the final canonical session when its turn
		// starts, rather than returning a transient not-found result.
		if (!session && !coordinator) return false;
		if (!coordinator && session?.status === "streaming") {
			throw new Error("Cannot assign role while agent is streaming");
		}
		if (!coordinator && session) broadcastStatus(session, "starting");
		return this._coordinateSessionReplacement(id, "assign-role", (token) =>
			this._assignRoleStaged(id, role, undefined, token), { drainOnRelease: true, cancelOnTerminal: () => false });
	}

	/**
	 * Attach a regular session to an accepted goal and rebuild its runtime as the
	 * goal's lead without changing its identity, transcript, checkout, or sandbox.
	 * Exact repeats are a no-op; conflicting attachments are rejected.
	 */
	async promoteToGoalLead(
		id: string,
		goalId: string,
		reservation: SessionGoalPromotionReservation,
	): Promise<SessionInfo> {
		this.requireSessionGoalPromotionReservation(id, reservation, goalId);
		const coordinator = this._sessionReplacementCoordinators.get(id);
		const session = this.sessions.get(id);
		if (!session && !coordinator) throw new Error(`Session ${id} not found`);
		const goal = this.resolveGoal(goalId);
		if (!goal) throw new Error(`Cannot promote session: goal ${goalId} was not found`);
		if (session?.projectId && goal.projectId && session.projectId !== goal.projectId) {
			throw new Error(`Cannot promote session ${id} across projects`);
		}
		const sourcePersisted = this.resolveStoreForSession(id).get(id);
		if (
			goal.worktreeOwnerSessionId !== id
			|| !sourcePersisted
			|| !this.goalWorkspaceCoordinatesMatchSession(goal, sourcePersisted)
		) {
			throw new Error(`Cannot promote session ${id}: adopted workspace provenance or coordinates do not match`);
		}
		if (session?.goalId === goalId && session.teamGoalId === goalId && session.role === "team-lead") {
			if (session.sandboxed) {
				const persisted = this.resolveStoreForSession(id).get(id);
				const expected = persisted?.containerId?.trim();
				if (!expected || session.containerId !== expected) {
					throw new Error(`Cannot reuse promoted session ${id}: sandbox container identity changed`);
				}
				const options: RpcBridgeOptions = { cwd: session.cwd };
				const applied = await this.applySandboxWiring(options, id, {
					projectId: session.projectId,
					goalId,
					expectedExistingContainerId: expected,
				});
				if (!applied || options.containerId !== expected) {
					throw new Error(`Cannot reuse promoted session ${id}: sandbox realm is unavailable`);
				}
			}
			return session;
		}
		if (!coordinator && session?.status === "streaming") {
			throw new Error("Cannot promote a session while its agent is streaming");
		}
		if (session && (
			session.goalId
			|| session.teamGoalId
			|| (session.role && session.role !== "general")
			|| session.assistantType
			|| session.staffId
			|| session.delegateOf
			|| session.parentSessionId
		)) {
			throw new Error(`Session ${id} already has goal, assigned role, staff, assistant, delegate, or child metadata`);
		}
		const expectedSandboxContainerId = session?.sandboxed ? session.containerId?.trim() : undefined;
		if (session?.sandboxed && !expectedSandboxContainerId) {
			throw new Error(`Cannot promote sandboxed session ${id}: existing container identity is missing`);
		}
		const role = this.resolveSessionRole("team-lead", undefined, session?.projectId);
		if (!role) throw new Error('Cannot promote session: role "team-lead" is unavailable');
		const projection: SessionRoleReplacementProjection = {
			goalId,
			teamGoalId: goalId,
			role: "team-lead",
			accessory: role.accessory ?? "crown",
			preserveModelTuple: true,
			expectedSandboxContainerId,
		};
		if (!coordinator && session) broadcastStatus(session, "starting");
		const promoted = await this._coordinateSessionReplacement(id, "promote-goal-lead", (token) =>
			this._assignRoleStaged(id, role, projection, token), {
				drainOnRelease: true,
				cancelOnTerminal: () => { throw new Error(`Session ${id} promotion was cancelled by termination`); },
			});
		if (!promoted) throw new Error(`Session ${id} disappeared during promotion`);
		const canonical = this.sessions.get(id);
		if (!canonical) throw new Error(`Session ${id} promotion committed without a canonical runtime`);
		return canonical;
	}

	private snapshotPromotionAttachment(source: PersistedSession): PromotionAttachmentSnapshot {
		const own = Object.prototype.hasOwnProperty;
		return {
			goalId: { present: own.call(source, "goalId"), value: source.goalId },
			teamGoalId: { present: own.call(source, "teamGoalId"), value: source.teamGoalId },
			role: { present: own.call(source, "role"), value: source.role },
			accessory: { present: own.call(source, "accessory"), value: source.accessory },
			containerId: {
				present: own.call(source, "containerId"),
				value: source.containerId,
			},
		};
	}

	private async restorePromotionAttachment(
		store: SessionStore,
		id: string,
		snapshot: PromotionAttachmentSnapshot,
	): Promise<void> {
		const values = Object.fromEntries(
			Object.entries(snapshot).map(([key, entry]) => [key, entry.value]),
		) as Partial<PersistedSession>;
		store.update(id, values as Parameters<SessionStore["update"]>[1]);
		const restored = store.get(id) as Record<string, unknown> | undefined;
		if (restored) {
			for (const [key, entry] of Object.entries(snapshot)) {
				if (!entry.present) delete restored[key];
			}
			// Bump the writer generation after deleting absent optional fields. The
			// immediately scheduled structural write cannot serialize until this turn
			// yields, so flushAsync publishes only the exact restored shape.
			store.update(id, { lastActivity: restored.lastActivity as number });
		}
		await store.flushAsync();
	}

	/** Prepare and commit one role replacement while the shared lifecycle coordinator owns the session. */
	private async _assignRoleStaged(
		id: string,
		role: { name: string; promptTemplate: string; accessory: string },
		projection: SessionRoleReplacementProjection | undefined,
		token: SessionReplacementToken,
	): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (projection) {
			const projectionGoal = this.resolveGoal(projection.goalId);
			if (!projectionGoal) throw new Error(`Cannot promote session: goal ${projection.goalId} was not found`);
			if (session.projectId && projectionGoal.projectId && session.projectId !== projectionGoal.projectId) {
				throw new Error(`Cannot promote session ${id} across projects`);
			}
			if (session.goalId === projection.goalId && session.teamGoalId === projection.teamGoalId && session.role === projection.role) {
				return true;
			}
			if (
				session.goalId
				|| session.teamGoalId
				|| (session.role && session.role !== "general")
				|| session.assistantType
				|| session.staffId
				|| session.delegateOf
				|| session.parentSessionId
			) {
				throw new Error(`Session ${id} gained conflicting metadata before promotion staging`);
			}
		}
		if (!this._replacementTokenIsCurrent(id, token) || token.coordinator.terminalRequest) {
			throw new Error(`Session ${id} role replacement was superseded before staging`);
		}
		// A request can join during a session-map gap, but the preceding coordinated
		// operation may have dispatched a continuation/redrive before this queued turn
		// starts. Re-check the final canonical state here so role assignment never stops
		// an active bridge merely because a coordinator existed at API-entry time.
		if (session.status === "streaming") {
			throw new Error(projection
				? "Cannot promote a session while its agent is streaming"
				: "Cannot assign role while agent is streaming");
		}
		const replacementSession: SessionInfo = projection
			? { ...session, ...projection }
			: session;
		// Get the agent session file so we can restore conversation. A structured
		// getState rejection is just as much a fallback case as a thrown RPC error;
		// start from the durable value and replace it only with a non-empty live one.
		const roleStore = this.resolveStoreForSession(id);
		const persistedBeforeRole = roleStore.get(id);
		let agentSessionFile = persistedBeforeRole?.agentSessionFile;
		try {
			const stateResp = await session.rpcClient.getState();
			if (stateResp.success && stateResp.data?.sessionFile) {
				agentSessionFile = stateResp.data.sessionFile;
			}
		} catch { /* retain the durable transcript path */ }

		// Reassemble system prompt with role instructions as separate fields
		const goal = replacementSession.goalId ? this.resolveGoal(replacementSession.goalId) : undefined;
		const goalSpec = goal?.spec;
		// Look up the full role (with toolPolicies) cascade-first so pack-contributed
		// roles keep their policies during role reassignment.
		const fullRole = this.resolveSessionRole(role.name, undefined, replacementSession.projectId) ?? (role as Role);
		// Cold role replacement must discover project Pi tools before policy and
		// prompt docs. The same snapshot is reused when activation argv is built.
		const replacementToolRuntime = this.prepareScopedToolRuntime(replacementSession.projectId, replacementSession.cwd);
		// Filter goal-metadata disabled tools (bobbit.disabledTools) for the
		// session's effective goal so the reassembled prompt, the activation args,
		// and the persisted allowedTools all agree after a role reassignment.
		const respawnEffectiveGoalId = replacementSession.goalId ?? replacementSession.teamGoalId;
		const respawnDisabled = this.disabledToolsForGoal(respawnEffectiveGoalId, replacementSession.projectId);
		const effectiveAllowedRaw = this.resolveEffectiveAllowedTools(fullRole, replacementSession.projectId, replacementSession.cwd, replacementToolRuntime);
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
			agentId: `${role.name}-${(replacementSession.goalId || replacementSession.id).slice(0, 8)}`,
			roleManager: this.roleManager,
		});

		const promptPath = this.assemblePrompt(id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: replacementSession.cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec,
			rolePrompt,
			roleName: role.name,
			allowedTools: effectiveAllowedNames.length > 0 ? effectiveAllowedNames : undefined,
			projectConfigStore: this.projectConfigStore,
		});

		// Respawn with new system prompt
		const bridgeOptions: RpcBridgeOptions = { cwd: replacementSession.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		if (replacementToolRuntime.toolManager) bridgeOptions.toolManager = replacementToolRuntime.toolManager;
		bridgeOptions.env = {
			BOBBIT_SESSION_ID: id,
			BOBBIT_SESSION_SECRET: this.sessionSecretStore.getOrCreateSecret(id),
		};
		if (replacementSession.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = replacementSession.goalId;
			// Re-attach extensions: team leads need both team + goal tools, others just goal tools
			const isTeamLead = replacementSession.role === "team-lead";
			if (isTeamLead) {
				bridgeOptions.args = ["--extension", this.getTeamLeadExtensionPath(replacementSession.projectId), "--extension", this.getGoalToolsExtensionPath(replacementSession.projectId)];
			} else if (!bridgeOptions.args?.includes("--extension")) {
				bridgeOptions.args = ["--extension", this.getGoalToolsExtensionPath(replacementSession.projectId)];
			}
		}

		// Re-attach proposal tools extension for assistant sessions
		if (session.assistantType) {
			bridgeOptions.args = bridgeOptions.args || [];
			const proposalExtPath = this.getProposalToolsExtensionPath(replacementSession.projectId);
			if (!bridgeOptions.args.includes(proposalExtPath)) {
				bridgeOptions.args.push("--extension", proposalExtPath);
			}
		}

		// Apply tool activation args, including Bobbit extension tools and MCP policy filtering.
		// `respawnAllowed` is `[]` (NO tools) when a role allowlist was fully removed by
		// `bobbit.disabledTools`, and `undefined` only for a genuinely unrestricted session.
		await this.ensureMcpManagerForContext(replacementSession.projectId, replacementSession.cwd);
		const respawnActivation = this.buildToolActivationArgs(id, respawnAllowed, fullRole, replacementSession.cwd, replacementSession.projectId, respawnEffectiveGoalId, session.sessionOnlyGrantedTools, replacementSession.sandboxed === true, replacementToolRuntime);
		bridgeOptions.args = [...respawnActivation.args, ...(bridgeOptions.args || [])];
		bridgeOptions.piExtensions = [...(bridgeOptions.piExtensions ?? []), ...respawnActivation.runtimeExtensions];
		bridgeOptions.env = { ...(bridgeOptions.env || {}), ...respawnActivation.env };

		// Pin one exact model/thinking tuple for the replacement. Model selection
		// prefers the assigned role, while thinking independently prefers an explicit
		// role override and otherwise preserves the last verified durable level.
		const respawnPersisted = this.resolveStoreForSession(id).get(id);
		const respawnPersistedModel =
			respawnPersisted?.modelProvider && respawnPersisted?.modelId
				? normalizeAigwModelString(`${respawnPersisted.modelProvider}/${respawnPersisted.modelId}`)
				: undefined;
		const rawRoleModel = projection?.preserveModelTuple
			? undefined
			: this.resolveRoleModelValue(role.name, replacementSession.projectId);
		const roleModel = rawRoleModel
			? normalizeAigwModelString(rawRoleModel)
			: undefined;
		const roleInitialModel = this.resolveInitialModel(role.name, replacementSession.projectId);
		const roleDefaultModel = this.resolveInitialModel(undefined, replacementSession.projectId);
		const rawRoleDefaultModel = this.preferencesStore?.get("default.sessionModel") as string | undefined;
		const livePinnedModel = replacementSession.spawnPinnedModel
			? normalizeAigwModelString(replacementSession.spawnPinnedModel)
			: undefined;
		const exactRoleReplacementModel = projection?.preserveModelTuple
			? respawnPersistedModel ?? livePinnedModel ?? rawRoleDefaultModel
			: roleModel ?? respawnPersistedModel ?? rawRoleDefaultModel;
		bridgeOptions.initialModel = exactRoleReplacementModel
			? await this.requireCurrentCatalogSpawnModel(exactRoleReplacementModel)
			: await this.resolveCurrentCatalogSpawnModel([
				roleInitialModel,
				roleDefaultModel,
			]);
		const roleThinkingOverride = isKnownThinkingLevel(
			projection?.preserveModelTuple
				? undefined
				: this.resolveRoleThinkingLevelValue(role.name, replacementSession.projectId),
		);
		const initThinking = projection?.preserveModelTuple
			? await this.resolveCurrentCatalogPreferredThinkingLevel(
				bridgeOptions.initialModel,
				role.name,
				replacementSession.projectId,
				respawnPersisted?.effectiveThinkingLevel ?? replacementSession.spawnPinnedThinkingLevel,
			)
			: await this.resolveCurrentCatalogThinkingLevel(
				bridgeOptions.initialModel,
				role.name,
				replacementSession.projectId,
				roleThinkingOverride ?? respawnPersisted?.effectiveThinkingLevel,
			);
		if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;

		// Role assignment is an in-place rehydration, so the replacement must stay
		// in the same filesystem realm as the durable transcript. In particular, a
		// sandboxed session needs a container-backed bridge before switch_session is
		// allowed to observe its container path. Fail closed if that realm can no
		// longer be wired; silently launching Pi on the host would strand the
		// container transcript and make an apparently successful role change lose
		// model-visible history.
		if (replacementSession.sandboxed) {
			const adoptedExpectedContainerId = this.isCanonicalAdoptedWorkspaceOwner(respawnPersisted ?? persistedBeforeRole!)
				? respawnPersisted?.containerId?.trim()
				: undefined;
			const strictExpectedContainerId = projection?.expectedSandboxContainerId ?? adoptedExpectedContainerId;
			if (!projection && this.isCanonicalAdoptedWorkspaceOwner(respawnPersisted ?? persistedBeforeRole!) && !strictExpectedContainerId) {
				throw new Error(`Cannot replace promoted session ${id}: durable sandbox container identity is missing`);
			}
			const sandboxApplied = await this.applySandboxWiring(bridgeOptions, id, {
				projectId: replacementSession.projectId,
				goalId: replacementSession.goalId ?? replacementSession.teamGoalId,
				expectedExistingContainerId: strictExpectedContainerId,
			});
			if (!sandboxApplied) {
				throw new Error(`Cannot assign role for sandboxed session ${id}: sandbox realm is unavailable`);
			}
			if (strictExpectedContainerId && bridgeOptions.containerId !== strictExpectedContainerId) {
				throw new Error(`Cannot replace sandboxed session ${id}: container identity changed during staging`);
			}
		} else {
			this.applyScopedGatewayCredentials(bridgeOptions, id, replacementSession.projectId, replacementSession.goalId ?? replacementSession.teamGoalId);
		}
		const spawnProvider = bridgeOptions.initialModel?.slice(0, bridgeOptions.initialModel.indexOf("/"));
		await this.applyDirectProviderEnv(bridgeOptions, !!replacementSession.sandboxed, spawnProvider);
		await this.finalizeSpawnOptions(bridgeOptions, {
			model: exactRoleReplacementModel ?? bridgeOptions.initialModel,
			thinkingLevel: projection?.preserveModelTuple
				? respawnPersisted?.effectiveThinkingLevel ?? replacementSession.spawnPinnedThinkingLevel
				: roleThinkingOverride ?? respawnPersisted?.effectiveThinkingLevel,
			role: role.name,
			projectId: replacementSession.projectId,
		});

		// Build and fully validate the replacement while the original bridge stays
		// subscribed and usable. Role assignment is a two-phase swap: start,
		// rehydrate, and verify model binding first; only then stop the old process
		// and commit the new bridge/metadata. Every preparation failure therefore
		// fails closed without turning a healthy idle session into a dead one.
		const oldRpcClient = session.rpcClient;
		const oldUnsubscribe = session.unsubscribe;
		const promotionAttachmentBefore = projection && persistedBeforeRole
			? this.snapshotPromotionAttachment(persistedBeforeRole)
			: undefined;
		const rpcClient = new RpcBridge(bridgeOptions);
		let replacementCommitted = false;
		let oldBridgeStopped = false;
		let verifiedReplacementTuple: { provider: string; modelId: string; thinkingLevel: ThinkingLevel } | undefined;
		const unsub = rpcClient.onEvent((event: any) => {
			// switch_session replays historical events and the replacement may emit
			// readiness frames before commit. Ignore all of them while staged so a
			// failed assignment is process-locally invisible as well as metadata-safe.
			if (!replacementCommitted) return;
			const preparedEvent = this.prepareVisibleAgentEvent(session, event);
			recordSessionEventActivity(session, preparedEvent);
			this.handleAgentLifecycle(session, preparedEvent);
			this.emitAgentEvent(session, preparedEvent);
			this.trackCostFromEvent(session, preparedEvent);
		});

		bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension);
		const rolePs = { ...respawnPersisted, ...replacementSession, agentSessionFile } as PersistedSession;
		const roleFileCtx = sessionFsContextForAgentFile(rolePs, agentSessionFile);
		const stagedSession = {
			...replacementSession,
			rpcClient,
			runtimePiExtensions: bridgeOptions.piExtensions,
			unsubscribe: unsub,
			spawnPinnedModel: bridgeOptions.initialModel,
			spawnPinnedThinkingLevel: bridgeOptions.initialThinkingLevel,
			role: role.name,
			accessory: role.accessory,
			allowedTools: effectiveAllowedNames,
			// Model verification must not mutate durable/model-name/client authority
			// before this candidate wins the lifecycle commit.
			_deferVerifiedTupleCommit: true,
			clients: new Set<WebSocket>(),
		} as SessionInfo;

		try {
			await rpcClient.start();
			if (agentSessionFile) {
				if (!await sessionFileExists(roleFileCtx, agentSessionFile, this.sandboxManager)) {
					throw new Error(`Cannot assign role for session ${id}: persisted conversation history is unavailable`);
				}
				await this.switchSessionForRehydration(rpcClient, rolePs, agentSessionFile);
			}
			verifiedReplacementTuple = await this.tryAutoSelectModel(stagedSession);
			// tryAutoSelectModel verifies a complete tuple. Only use the standalone
			// thinking helper when model selection produced no tuple; re-reading an
			// already-complete legacy candidate can fail and must not discard it.
			if (!verifiedReplacementTuple) {
				try {
					verifiedReplacementTuple = await this.tryApplyDefaultThinkingLevel(stagedSession);
				} catch (err) {
					if (respawnPersisted?.effectiveThinkingLevel !== undefined) throw err;
					console.warn(`[session-manager] Legacy session ${id} could not verify effective thinking during role replacement:`, err);
				}
			}
			if (respawnPersisted?.effectiveThinkingLevel !== undefined && !verifiedReplacementTuple) {
				throw new Error(`Cannot assign role for session ${id}: replacement model tuple was not verified`);
			}

			// Another lifecycle replacement may have won while this bridge was being
			// prepared. Never stop or overwrite that newer canonical session; the catch
			// path below disposes this staged process and listener.
			if (this.sessions.get(id) !== session || !this._replacementTokenIsCurrent(id, token) || token.coordinator.terminalRequest) {
				throw new Error(`Session ${id} role replacement was superseded before old bridge stop`);
			}

			// Persist the metadata before the irreversible old-process stop. Promotion
			// publishes its complete graph attachment in one structural mutation. If
			// the stop rejects, restore the prior values and their exact optional-field
			// presence while retaining the old bridge and listener.
			try {
				roleStore.update(id, projection
					? {
						goalId: projection.goalId,
						teamGoalId: projection.teamGoalId,
						role: projection.role,
						accessory: projection.accessory,
						...(projection.expectedSandboxContainerId
							? { containerId: projection.expectedSandboxContainerId }
							: {}),
					} as Parameters<SessionStore["update"]>[1]
					: { role: role.name, accessory: role.accessory });
			} catch (err) {
				if (promotionAttachmentBefore) {
					await this.restorePromotionAttachment(roleStore, id, promotionAttachmentBefore);
				}
				throw err;
			}
			// The old SessionInfo remains canonical through the stop await. Cancel its
			// pending activity transactions first so stop-triggered late RPC success
			// cannot write activity or open the replacement's restore quarantine.
			cancelPendingSessionPromptActivity(session);
			try {
				await oldRpcClient.stop();
				oldBridgeStopped = true;
			} catch (err) {
				if (promotionAttachmentBefore) {
					await this.restorePromotionAttachment(roleStore, id, promotionAttachmentBefore);
				} else {
					roleStore.update(id, { role: session.role, accessory: session.accessory });
				}
				throw err;
			}
			// The old stop is the irreversible await in the two-phase swap. Revalidate
			// both identity and ownership afterwards; a stale staged bridge is disposed
			// by the catch path and can never overwrite a newer canonical process.
			if (this.sessions.get(id) !== session || !this._replacementTokenIsCurrent(id, token) || token.coordinator.terminalRequest) {
				if (promotionAttachmentBefore) {
					await this.restorePromotionAttachment(roleStore, id, promotionAttachmentBefore);
				} else {
					roleStore.update(id, { role: session.role, accessory: session.accessory });
				}
				throw new Error(`Session ${id} role replacement was superseded after old bridge stop`);
			}
		} catch (err) {
			unsub();
			await rpcClient.stop().catch(() => {});
			// If terminal cancellation landed during the irreversible old stop, both
			// bridges are now gone. Surface that canonical capsule as terminated;
			// never leave a dead old bridge looking idle after the staged one is disposed.
			if (token.coordinator.terminalRequest && oldBridgeStopped && this.sessions.get(id) === session) {
				broadcastStatus(session, "terminated");
			}
			throw err;
		}

		try { oldUnsubscribe(); } catch { /* stopped old bridge; listener cleanup is best-effort */ }
		session.rpcClient = rpcClient;
		session.runtimePiExtensions = bridgeOptions.piExtensions;
		session.unsubscribe = unsub;
		// Snapshot bases and cursor projections are bridge-specific. Clear both at
		// the commit boundary so no response from the stopped bridge can be reused or
		// projected onto the replacement bridge's messages.
		session.messagesSnapshotCache = undefined;
		session.messagesSnapshotCursorProjection = undefined;
		session.spawnPinnedModel = bridgeOptions.initialModel;
		session.spawnPinnedThinkingLevel = bridgeOptions.initialThinkingLevel;
		if (projection?.expectedSandboxContainerId) session.containerId = projection.expectedSandboxContainerId;
		if (verifiedReplacementTuple) {
			session.spawnPinnedModel = `${verifiedReplacementTuple.provider}/${verifiedReplacementTuple.modelId}`;
			session.spawnPinnedThinkingLevel = verifiedReplacementTuple.thinkingLevel;
		}
		session.goalId = replacementSession.goalId;
		session.teamGoalId = replacementSession.teamGoalId;
		// Ordinary assignment must replace the prior role rather than reading it
		// back from replacementSession (which aliases the original session). Only
		// promotion supplies graph metadata as an explicit prospective projection.
		session.role = projection?.role ?? role.name;
		session.accessory = projection?.accessory ?? role.accessory;
		session.allowedTools = effectiveAllowedNames;
		if (verifiedReplacementTuple) {
			this.persistSessionModel(
				id,
				verifiedReplacementTuple.provider,
				verifiedReplacementTuple.modelId,
				verifiedReplacementTuple.thinkingLevel,
			);
			this._writeModelNameFile(id, `${verifiedReplacementTuple.provider}/${verifiedReplacementTuple.modelId}`);
		}
		// The replacement may still flush replay frames after switch_session's
		// response. Keep them quarantined until the next explicit prompt dispatch.
		suppressSessionActivityUntilPrompt(session);
		replacementCommitted = true;

		// assignRole owns the status fence until every concurrently queued role
		// assignment has settled. The public coordinator releases it once and drains
		// durable prompts only against the final committed bridge.

		// Refresh messages and state for connected clients
		try {
			const msgs = await this.getMessagesSnapshotBase(session);
			if (msgs.success) {
				const data = this.buildVisibleMessageSnapshot(session.id, msgs.data);
				broadcast(session.clients, { type: "messages", data: data as unknown[] });
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
		return { namingModel: namingModel || undefined, fallbackModel: sessionModel || undefined, aigwUrl, thinkingLevel: "off", preferencesStore: this.preferencesStore, skipTitleGeneration: this.skipTitleGeneration };
	}

	private async autoGenerateTitleFromText(session: SessionInfo, userText: string): Promise<void> {
		const messages = [{ role: "user", content: userText }];
		const summary = await generateSessionTitle(messages, this.getTitleGenOptions());
		if (summary) {
			// Assistant sessions keep a type prefix (e.g. "Support: <summary>",
			// "New Goal: <summary>") so the rename stays identifiable; the prefix
			// matches the initial session title. Non-assistant sessions are unchanged.
			const titlePrefix = session.assistantType ? getAssistantDef(session.assistantType)?.titlePrefix : undefined;
			const title = titlePrefix ? composeAssistantTitle(titlePrefix, summary) : summary;
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
			const withInFlight = spliceInFlightMessage(rawMessages, live.latestMessageUpdate);
			const messages = projectPromptAuthorMessagesForTitle(
				id,
				withInFlight,
				live,
				this.messageAuthorDependencies(live),
			);
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
				const entries: unknown[] = [];
				for (const line of content.trim().split("\n")) {
					if (!line.trim()) continue;
					try { entries.push(JSON.parse(line)); } catch { /* skip malformed */ }
				}
				const correlated = applyArchivedSnapshotCorrelations(prepareArchivedMessageSnapshot(entries));
				messages = stripArchivedSnapshotCorrelations(projectPromptAuthorMessagesForTitle(
					id,
					correlated as object[],
					ps,
					this.messageAuthorDependencies(ps),
				));
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
			const withInFlight = spliceInFlightMessage(rawMessages, session.latestMessageUpdate);
			const messages = projectPromptAuthorMessagesForTitle(
				session.id,
				withInFlight,
				session,
				this.messageAuthorDependencies(session),
			);

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
		this._assertModelSelectionReady(sessionId);
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

	/** Persist a verified provider/model/effective-thinking tuple atomically. */
	persistSessionModel(sessionId: string, provider: string, modelId: string, effectiveThinkingLevel?: ThinkingLevel): void {
		// Legacy callers may still expose a model-only persister shape. Model-only
		// writes are deliberately ignored: retaining the previous verified tuple is
		// safer than combining a new model with stale thinking.
		if (effectiveThinkingLevel === undefined) return;
		this.resolveStoreForSession(sessionId).update(sessionId, {
			modelProvider: provider,
			modelId,
			effectiveThinkingLevel,
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

	/** Notify existing termination listeners from the one durable archive boundary. */
	private async notifySessionArchived(
		id: string,
		source: SessionInfo | PersistedSession,
	): Promise<void> {
		const repoWorktrees = Array.isArray(source.repoWorktrees)
			? source.repoWorktrees.map(worktree => ({ worktreePath: worktree.worktreePath }))
			: source.repoWorktrees
				? Object.values(source.repoWorktrees).map(worktreePath => ({ worktreePath }))
				: undefined;
		const info: SessionTerminationInfo = {
			projectId: source.projectId,
			reason: "archived",
			cwd: source.cwd,
			worktreePath: source.worktreePath,
			repoWorktrees,
		};
		for (const listener of this._terminationListeners) {
			try {
				await listener(id, info);
			} catch (err) {
				console.error(`[session ${id}] termination listener failed:`, err);
			}
		}
	}

	/**
	 * Archive one row and notify observers exactly once, after successful atomic
	 * publication. Consumer failure remains observational and cannot roll back the
	 * durable transition.
	 */
	private async archivePersistedSession(
		id: string,
		store: SessionStore,
		source: SessionInfo | PersistedSession,
	): Promise<boolean> {
		const archived = await store.archiveAsync(id);
		if (!archived) return false;
		await this.notifySessionArchived(id, source);
		return true;
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
	private async cascadeReapOwner(id: string, options: { preserveEvidence?: boolean; cascadeSessionIds?: ReadonlySet<string> } = {}): Promise<void> {
		// Cascade: terminate all live child sessions first. Children are linked via
		// `delegateOf` (delegate kind) OR `parentSessionId`+`childKind` (team /
		// pr-walkthrough / host-agents / any future kind) — otherwise a child
		// process leaks when its parent is terminated or archived.
		const children = [...this.sessions.values()].filter(s =>
			(s.delegateOf === id || (!!s.childKind && s.parentSessionId === id))
			&& (!options.cascadeSessionIds || options.cascadeSessionIds.has(s.id)));
		for (const child of children) {
			console.log(`[session ${id}] Cascading terminate to child ${child.id}`);
			await this.terminateSession(child.id, options);
		}
		// Also archive persisted-but-not-in-memory children of any kind.
		const allLiveForTerminate = this.projectContextManager
			? [...this.projectContextManager.getAllLiveSessions()]
			: (this._testStore?.getLive() ?? []);
		for (const ps of allLiveForTerminate) {
			const isChild = ps.delegateOf === id || (!!ps.childKind && ps.parentSessionId === id);
			if (isChild && (!options.cascadeSessionIds || options.cascadeSessionIds.has(ps.id)) && !this.sessions.has(ps.id)) {
				try {
					await this.dispatchSessionShutdownInterceptor(ps, "archived");
					await this.archivePersistedSession(ps.id, this.getSessionStore(ps.projectId), ps);
				} catch { /* project gone or archive publication failed */ }
			}
		}
		// Keep the OrchestrationCore in-memory index consistent.
		if (!options.cascadeSessionIds) {
			try { this.orchestrationCore?.forgetOwner(id); } catch { /* best-effort */ }
		}
	}

	private async dispatchSessionShutdownInterceptor(
		src: Pick<SessionInfo, "id" | "projectId" | "cwd" | "goalId" | "teamGoalId" | "role">,
		reason: "archived" | "quiesced" | "terminated",
	): Promise<void> {
		try {
			if (this.hostInterceptors) {
				const controller = new AbortController();
				await this.hostInterceptors.dispatch("sessionShutdown", {
					sessionId: src.id,
					projectId: src.projectId,
					reason,
				}, {
					projectId: src.projectId,
					sessionId: src.id,
					goalId: src.goalId ?? src.teamGoalId,
					cwd: src.cwd,
					signal: controller.signal,
				});
				return;
			}
			if (this.lifecycleHub) {
				await this.lifecycleHub.dispatch("sessionShutdown", {
					sessionId: src.id,
					projectId: src.projectId,
					scope: src.projectId ? "project" : "global",
					cwd: src.cwd,
					goalId: src.goalId ?? src.teamGoalId,
					roleName: src.role,
				}, lifecycleScopeInput(src));
			}
		} catch {
			console.warn(`[session-manager] sessionShutdown interceptor failed code=dispatch_error session=${src.id}`);
		}
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
	private async archiveWithCascade(id: string, store?: SessionStore, options: { preserveEvidence?: boolean; cascadeSessionIds?: ReadonlySet<string> } = {}): Promise<boolean> {
		// Defense in depth for internal recovery and maintenance callers. Ordered
		// goal archival has already made the canonical guard return undefined here.
		this.assertPromotedSessionRecoveryAllowed(id, "archive its session record");
		const target = store ?? this.resolveStoreForId(id);
		const initial = target?.get(id);
		if (!target || !initial || initial.archived) return false;
		await this.cascadeReapOwner(id, options);
		// A concurrent archive may have completed while the child cascade settled.
		if (target.get(id)?.archived) return false;
		const live = this.sessions.get(id);
		const persisted = live ? undefined : target.get(id);
		const shutdownSource = live ?? persisted;
		if (!shutdownSource) return false;
		await this.dispatchSessionShutdownInterceptor(shutdownSource, "archived");
		try { return await this.archivePersistedSession(id, target, shutdownSource); } catch { return false; }
	}

	/**
	 * Stop and detach a live runtime while deliberately leaving its persisted row
	 * live. Archived-goal reconciliation uses this only when it cannot durably
	 * publish the sticky team ownership marker: the row must remain available for
	 * boot repair, but its process, dispatch authority, timers, and credentials
	 * must not survive in the current process.
	 */
	async quiesceSessionRuntime(id: string): Promise<boolean> {
		const coordinator = this._sessionReplacementCoordinators.get(id);
		if (!this.sessions.has(id) && !coordinator) return true;
		if (coordinator) coordinator.terminalRequest = "terminate";
		const quiesced = this._coordinateSessionReplacement(id, "quiesce", (token) =>
			this._quiesceSessionRuntimeOwned(id, token), { coalesceKey: "quiesce", drainOnRelease: false });
		// _coordinateSessionReplacement installs a coordinator synchronously. Make
		// terminal intent sticky for replacements admitted after this call as well.
		const installed = this._sessionReplacementCoordinators.get(id);
		if (installed) installed.terminalRequest = "terminate";
		return quiesced;
	}

	private async _quiesceSessionRuntimeOwned(id: string, token: SessionReplacementToken): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return true;
		if (!this._replacementTokenIsCurrent(id, token)) {
			throw new Error(`Session ${id} quiesce was superseded before start`);
		}

		// Fence dispatch before the first await, then stop the bridge even when an
		// auxiliary cleanup hook is unhealthy. The durable SessionStore row is never
		// mutated by this seam.
		session.lifecycleFenced = true;
		session.dormant = true;
		session.staffNotificationTurnContext = undefined;
		this.clearToolCallProvenance(session);
		this.cancelPendingAutoRetry(session, "terminated");
		try { this.purgeVerifierPromptRows(id, `Verifier session ${id} was quiesced before dispatch`); } catch { /* best-effort */ }
		if (session.pendingMetadataPersist) {
			try { await session.pendingMetadataPersist; } catch { /* already logged */ }
		}
		try { await session.rpcClient.getState(); } catch { /* process may already be stopped */ }
		try { session.unsubscribe(); } catch { /* bridge stop remains mandatory */ }
		let bridgeStopError: unknown;
		try { await session.rpcClient.stop(); }
		catch (err) { bridgeStopError = err; }
		if (!this._replacementTokenIsCurrent(id, token) || this.sessions.get(id) !== session) {
			throw new Error(`Session ${id} quiesce was superseded after bridge stop`);
		}
		broadcastStatus(session, "terminated");

		try { await this.closeExtensionChannelsForSession(id, "session-quiesced"); } catch { /* runtime is already stopped */ }
		if (session.pendingGrantRequest) {
			const pending = session.pendingGrantRequest;
			const requests = pending.requests?.length
				? pending.requests
				: [{ resolve: pending.resolve, reject: pending.reject, timer: pending.timer, seq: pending.seq, ts: pending.ts }];
			for (const req of requests) {
				this.clock.clearTimeout(req.timer);
				req.resolve({ granted: false });
			}
			session.pendingGrantRequest = undefined;
		}
		if ((this as any).bgProcessManager) {
			try { (this as any).bgProcessManager.abortAllWaits(id); } catch { /* best-effort */ }
			try { (this as any).bgProcessManager.cleanup(id); } catch { /* best-effort */ }
		}
		try {
			if (this.sandboxTokenStore && session.projectId) this.sandboxTokenStore.removeSession(session.projectId, id);
		} catch { /* process is already stopped */ }
		try { this.sessionSecretStore.remove(id); } catch { /* process is already stopped */ }
		const quiesceReason = `Session ${id} was quiesced by archived goal ownership`;
		this.rejectAllVerifierPromptReceipts(id, quiesceReason);
		this.rejectIdleWaiters(id, new Error(quiesceReason));
		for (const client of session.clients) {
			try { client.close(1000, "Session quiesced"); } catch { /* best-effort */ }
		}
		session.clients.clear();
		this._untrackConnectedSession(session);

		const scope = { projectId: session.projectId, cwd: session.cwd };
		this.sessions.delete(id);
		this._taskIdCache.delete(id);
		try { await this.cleanupScopedMcpManagersForSessionScope(scope); } catch { /* runtime authority is already removed */ }
		await this.dispatchSessionShutdownInterceptor(session, "quiesced");
		if (bridgeStopError) {
			throw new Error(`Session ${id} runtime was detached after its bridge stop failed: ${bridgeStopError instanceof Error ? bridgeStopError.message : String(bridgeStopError)}`, { cause: bridgeStopError });
		}
		return true;
	}

	async terminateSession(id: string, options: { preserveEvidence?: boolean; cascadeSessionIds?: ReadonlySet<string>; allowPromotedGoalLifecycle?: boolean; worktreeOwnerLifecycleHeld?: string } = {}): Promise<boolean> {
		this.assertSessionGoalPromotionMutationAllowed(id);
		// Legacy callers may still pass the old option, but canonical goal state —
		// never a caller boolean — is the only authority for promoted teardown.
		this.assertPromotedSessionLifecycleAllowed(id, "archive");
		const persisted = this.getPersistedSession(id);
		const live = this.sessions.get(id);
		const borrowsWorktree = !!(live?.borrowsWorktree || persisted?.borrowsWorktree);
		const hasOwnedLifecycle = !!(
			live?.sandboxed || persisted?.sandboxed
			|| live?.worktreePath || persisted?.worktreePath
			|| live?.repoWorktrees || persisted?.repoWorktrees
			|| live?.staffId || persisted?.staffId
		);
		const lifecycleOwnerId = borrowsWorktree
			? (this.resolveWorktreeOwnerSessionId(id)
				?? live?.borrowedWorktreeOwnerSessionId
				?? persisted?.borrowedWorktreeOwnerSessionId
				?? id)
			: (hasOwnedLifecycle ? id : undefined);

		const terminate = async (): Promise<boolean> => {
			// In-place restore temporarily removes the SessionInfo from the map. A
			// terminate accepted during that gap must serialize behind the replacement,
			// not report "not live" and let a successfully restored ghost survive after
			// the caller archives its persisted record. The shared-worktree guard runs
			// before terminal intent so a 409 leaves the owner byte-for-byte live.
			const coordinator = this._sessionReplacementCoordinators.get(id);
			if (!this.sessions.has(id) && !coordinator) return false;
			const current = this.sessions.get(id);
			const currentPersisted = this.getPersistedSession(id);
			if (
				!options.preserveEvidence
				&& !(current?.borrowsWorktree || currentPersisted?.borrowsWorktree)
			) {
				this.assertWorktreeOwnerHasNoLiveBorrowers(id);
			}
			if (coordinator) coordinator.terminalRequest = "terminate";
			return this._coordinateSessionReplacement(id, "terminate", (token) =>
				this._terminateSessionOwned(id, token, options), { coalesceKey: "terminate", drainOnRelease: false });
		};

		// Evidence-preserving archival never mutates a worktree. Callers that already
		// hold this exact owner key pass it explicitly to avoid recursive FIFO entry.
		if (!lifecycleOwnerId || options.preserveEvidence || options.worktreeOwnerLifecycleHeld === lifecycleOwnerId) {
			return terminate();
		}
		return (live?.sandboxed || persisted?.sandboxed)
			? this.withSandboxWorktreeOwnerLifecycle(lifecycleOwnerId, terminate)
			: this.withWorktreeOwnerLifecycle(lifecycleOwnerId, terminate);
	}

	private async _terminateSessionOwned(id: string, token: SessionReplacementToken, options: { preserveEvidence?: boolean; cascadeSessionIds?: ReadonlySet<string> }): Promise<boolean> {
		const session = this.sessions.get(id);
		if (!session) return false;
		if (!this._replacementTokenIsCurrent(id, token)) {
			throw new Error(`Session ${id} termination was superseded before start`);
		}

		// Cascade-reap this owner's child agents (extracted seam — §6).
		await this.cascadeReapOwner(id, options);

		await this.closeExtensionChannelsForSession(id, "session-terminated");

		// Resolve any pending grant request so the guard's long-poll returns immediately
		if (session.pendingGrantRequest) {
			const pending = session.pendingGrantRequest;
			const requests = pending.requests?.length ? pending.requests : [{ resolve: pending.resolve, reject: pending.reject, timer: pending.timer, seq: pending.seq, ts: pending.ts }];
			for (const req of requests) {
				this.clock.clearTimeout(req.timer);
				req.resolve({ granted: false });
			}
			session.pendingGrantRequest = undefined;
			broadcast(session.clients, {
				type: "tool_permission_settled",
				toolName: pending.toolName,
				group: pending.toolGroup,
				status: "cancelled",
				reason: "Session ended before permission was resolved.",
			});
		}

		// Fence verifier-owned queued prompts before any potentially slow final
		// get_state/stop work. Their harness may be cancelling or re-signalling and
		// must not wait for an unrelated teardown turn to settle.
		this.purgeVerifierPromptRows(id, `Verifier session ${id} was terminated before dispatch`);

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
		if (!this._replacementTokenIsCurrent(id, token) || this.sessions.get(id) !== session) {
			throw new Error(`Session ${id} termination was superseded after bridge stop`);
		}
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
		// Skip sessions that share another owner's worktree: delegates, read-only
		// children, and explicit writable history forks (`borrowsWorktree`). Only the
		// session that provisioned the sandbox worktree may remove it.
		if (!options.preserveEvidence && session.sandboxed && !session.borrowsWorktree && !session.delegateOf && !(session.readOnly && session.parentSessionId) && session.cwd?.startsWith("/workspace-wt/") && this.sandboxManager && session.projectId) {
			const removalAuthority = this.getPersistedSession(id) ?? session;
			const coordinates = sandboxWorktreeOwnerCoordinates(removalAuthority);
			if (!coordinates) {
				console.warn(`[session-manager] Refusing ambiguous sandbox worktree removal for ${id}`);
			} else {
				try {
					const sandbox = this.sandboxManager.get(session.projectId);
					if (sandbox) await sandbox.removeWorktree(coordinates.name);
				} catch (err) {
					console.warn(`[session-manager] Failed to remove sandbox worktree for ${id}:`, err);
				}
			}
		}

		// Clean up model name file
		try {
			const modelNameFile = path.join(bobbitStateDir(), "model-name-" + id + ".txt");
			await fsp.unlink(modelNameFile);
		} catch { /* missing or best-effort cleanup failure */ }

		// NOTE: proposal-drafts cleanup is deferred to purgeOneSession (the
		// 7-day purge mark). Both Path A (in-place resubmit) and Path B
		// (continue assistant) of the reopen-archived-proposals design read
		// these drafts off disk for archived sessions, so they must survive
		// archive. See docs/design/editable-proposals.md §4 + the design doc
		// `reopen-archived-proposals.md`.

		// Broadcast session_archived event before closing clients
		const archivedAt = this.clock.now();
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
		this._taskIdCache.delete(id);
		await this.cleanupScopedMcpManagersForSessionScope(terminatedScope);
		await this.dispatchSessionShutdownInterceptor(session, "terminated");
		// Always archive — even without an agentSessionFile the metadata
		// (title, goal association, timestamps) is valuable and the search
		// index may reference this session. Purge will clean it up later. Existing
		// listeners observe the same post-success boundary as dormant/cascade paths.
		await this.archivePersistedSession(id, terminateStore, session);

		// Bug 2 (docs/design/orphan-remote-branch-cleanup.md): eagerly push-delete
		// the remote branch for non-delegate `session/*` sessions whose branch is
		// fully merged into origin/<primary>. Local worktree cleanup stays in
		// purgeOneSession at the 7-day mark. Fire-and-forget — never blocks.
		// branch/repoPath live on PersistedSession (not SessionInfo), so we read
		// the persisted record we just archived.
		if (!options.preserveEvidence) {
			const persistedForBranchDelete = terminateStore.get(id);
			const sessionBranch = persistedForBranchDelete?.branch;
			const repoPathForBranchDelete = persistedForBranchDelete?.repoPath;
			const skipRemoteBranchDelete = shouldSkipRemotePush(this.remoteGitPolicy) || !repoPathForBranchDelete || await shouldSkipRemoteGitForTests(repoPathForBranchDelete, "origin", this.commandRunner, this.remoteGitPolicy);
			eagerDeleteRemoteSessionBranch({
				branch: sessionBranch,
				repoPath: repoPathForBranchDelete,
				delegateOf: session.delegateOf,
				skipPush: skipRemoteBranchDelete,
				detectPrimary: (cwd) => detectPrimaryBranch(cwd, this.commandRunner, this.remoteGitPolicy),
				runGit: async (args, cwd) => {
					await this.commandRunner.execFile("git", args, { cwd, timeout: 15_000 });
				},
			}).then(result => {
				if (result.deleted) {
					console.log(`[session-manager] Deleted merged remote session branch: ${sessionBranch}`);
				}
			}).catch(err => {
				console.warn(`[session-manager] Eager remote-delete failed for ${id}:`, err);
			});
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
	async storeArchive(id: string, options: { preserveEvidence?: boolean; cascadeSessionIds?: ReadonlySet<string>; allowPromotedGoalLifecycle?: boolean; worktreeOwnerLifecycleHeld?: string } = {}): Promise<boolean> {
		this.assertSessionGoalPromotionMutationAllowed(id);
		// Preserve the legacy call shape without preserving its authority bypass.
		this.assertPromotedSessionLifecycleAllowed(id, "archive");
		const persisted = this.getPersistedSession(id);
		const lifecycleOwnerId = persisted?.borrowsWorktree
			? (this.resolveWorktreeOwnerSessionId(id) ?? persisted.borrowedWorktreeOwnerSessionId ?? id)
			: (persisted && (persisted.sandboxed || persisted.worktreePath || persisted.repoWorktrees || persisted.staffId) ? id : undefined);
		const archive = async () => {
			const current = this.getPersistedSession(id);
			if (!options.preserveEvidence && current && !current.borrowsWorktree) {
				this.assertWorktreeOwnerHasNoLiveBorrowers(id);
			}
			return this.archiveWithCascade(id, undefined, options);
		};
		if (!lifecycleOwnerId || options.preserveEvidence || options.worktreeOwnerLifecycleHeld === lifecycleOwnerId) {
			return archive();
		}
		return persisted?.sandboxed
			? this.withSandboxWorktreeOwnerLifecycle(lifecycleOwnerId, archive)
			: this.withWorktreeOwnerLifecycle(lifecycleOwnerId, archive);
	}

	/** Update metadata on an archived session (stored in the session store). */
	updateArchivedMeta(id: string, updates: { teamLeadSessionId?: string; parentSessionId?: string; childKind?: string; readOnly?: boolean; childTerminal?: boolean; terminalAt?: number }): boolean {
		const store = this.resolveStoreForId(id);
		if (!store) return false;
		const ps = store.get(id);
		if (!ps?.archived) return false;
		store.update(id, updates);
		return true;
	}

	/** Parse the .jsonl file for an archived session and return messages. */
	async getArchivedMessages(id: string): Promise<unknown[]> {
		const ps = this.resolveStoreForId(id)?.get(id);
		if (!ps?.archived || !ps.agentSessionFile) return [];
		try {
			const safeFile = safePersistedHostAgentSessionFile(ps.agentSessionFile);
			if (!safeFile) return [];
			trustPersistedAgentSessionFile(safeFile);
			const ctx = sessionFsContextForAgentFile(ps, safeFile);
			const content = await sessionFileRead(ctx, safeFile, this.sandboxManager);
			if (!content) return [];
			const lines = content.trim().split("\n");
			const entries: unknown[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					entries.push(JSON.parse(line));
				} catch {
					// Skip malformed lines
				}
			}
			return prepareArchivedMessageSnapshot(entries);
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
		lastReadAt?: number;
		hasUnansweredQuestion: boolean;
		clientCount: number;
		isCompacting: boolean;
		goalId?: string;
		assistantType?: string;
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
		preview?: boolean;
		reattemptGoalId?: string;
		sandboxed?: boolean;
		archived: boolean;
		archivedAt?: number;
		projectId?: string;
		server_tags: string[];
		user_tags: string[];
	}> {
		const allArchived = this.projectContextManager
			? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: (this._testStore?.getArchived() ?? []);
		const allSessions: SessionListTagSource[] = [
			...this.sessionListUnreadSources(),
			...allArchived.map(ps => ({ ...ps, status: "archived", isCompacting: false })),
		];
		return allArchived.map((ps) => this.serializeSessionListTags({
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "archived",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			lastReadAt: ps.lastReadAt,
			hasUnansweredQuestion: ps.hasUnansweredQuestion === true,
			clientCount: 0,
			isCompacting: false,
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
			reattemptGoalId: ps.reattemptGoalId,
			sandboxed: ps.sandboxed,
			archived: true,
			archivedAt: ps.archivedAt,
			projectId: ps.projectId,
			user_tags: ps.user_tags,
		}, { archived: true, allSessions }));
	}

	/** Permanently purge a single archived session immediately. */
	async purgeArchivedSession(id: string): Promise<boolean> {
		// Join before consulting the store: the owning purge removes its row before
		// awaited termination listeners run, so an overlapping request in that
		// window must still wait for the same destructive owner.
		const pending = this.sessionPurgesInFlight.get(id);
		if (pending) {
			await pending;
			return true;
		}
		const ps = this.resolveStoreForId(id)?.get(id);
		if (!ps?.archived) return false;
		await this.coalescePurgeOneSession(ps);
		return true;
	}

	/** Purge all archived sessions older than 7 days. Manual and scheduled calls coalesce. */
	purgeExpiredArchives(): Promise<void> {
		if (this.archivePurgeInFlight) return this.archivePurgeInFlight;
		const run = (async () => {
			const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
			const cutoff = this.clock.now() - SEVEN_DAYS_MS;
			const archived = this.projectContextManager
				? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
				: (this._testStore?.getArchived() ?? []);
			for (const ps of archived) {
				if (ps.archivedAt && ps.archivedAt < cutoff) {
					try {
						if (await this.coalescePurgeOneSession(ps)) {
							console.log(`[session-manager] Purged expired archive: "${ps.title}" (${ps.id})`);
						}
					} catch (err) {
						console.error(`[session-manager] Failed to purge archive ${ps.id}:`, err);
					}
				}
			}
		})();
		let tracked!: Promise<void>;
		tracked = run.finally(() => {
			if (this.archivePurgeInFlight === tracked) this.archivePurgeInFlight = null;
		});
		this.archivePurgeInFlight = tracked;
		return tracked;
	}

	async listArchivedSessionWorktrees(includeAlreadyCleaned = false): Promise<ArchivedSessionWorktreeScanResponse> {
		const ctx = this.buildArchivedWorktreeScanContext();
		const sessions: ArchivedSessionWorktreeSession[] = [];
		const allItems: ArchivedSessionWorktreeItem[] = [];
		const counts: ArchivedSessionWorktreeScanResponse["counts"] = {
			archivedSessions: 0,
			sessionsWithWorktrees: 0,
			removableWorktrees: 0,
			skippedWorktrees: 0,
			alreadyCleanedWorktrees: 0,
			totalItems: 0,
			readyToClean: 0,
			defaultSelected: 0,
			alreadyCleaned: 0,
			ineligible: 0,
			needsAttention: 0,
			failed: 0,
			byDisposition: {},
			byReason: {},
			bySelectionCategory: {},
		};

		const archivedRows: Array<{ ps: PersistedSession; projectName?: string }> = [];
		if (this.projectContextManager) {
			for (const projectCtx of ctx.candidateContexts) {
				for (const ps of projectCtx.sessionStore.getArchived()) {
					archivedRows.push({ ps, projectName: projectCtx.project.name });
				}
			}
		} else {
			for (const ps of this._testStore?.getArchived() ?? []) archivedRows.push({ ps });
		}

		counts.archivedSessions = archivedRows.length;
		for (const { ps, projectName } of archivedRows) {
			const worktrees = await this.archivedSessionWorktreeItems(ps, ctx, projectName);
			allItems.push(...worktrees);
			for (const item of worktrees) {
				if (item.status === "removable") counts.removableWorktrees++;
				else if (item.status === "already-cleaned") counts.alreadyCleanedWorktrees++;
				else counts.skippedWorktrees++;
			}
			if (worktrees.some(item => item.status !== "already-cleaned" && item.reason !== "no-worktree-path")) counts.sessionsWithWorktrees++;
			if (!includeAlreadyCleaned && worktrees.every(item => item.status === "already-cleaned")) continue;
			sessions.push({
				id: ps.id,
				title: ps.title,
				archivedAt: ps.archivedAt,
				projectId: ps.projectId,
				projectName,
				goalId: ps.goalId,
				teamGoalId: ps.teamGoalId,
				delegateOf: ps.delegateOf,
				parentSessionId: ps.parentSessionId,
				childKind: ps.childKind,
				sandboxed: ps.sandboxed,
				branch: ps.branch,
				repoPath: ps.repoPath,
				worktreePath: ps.worktreePath,
				worktrees,
			});
		}

		const responseItems = sessions.flatMap(session => session.worktrees);
		this.populateArchivedWorktreeUxCounts(counts, allItems);
		return {
			sessions,
			items: responseItems,
			counts,
			groups: this.buildArchivedWorktreeGroups(allItems),
			selectionPresets: this.buildArchivedWorktreeSelectionPresets(responseItems),
			generatedAt: this.clock.now(),
		};
	}

	async cleanupArchivedSessionWorktrees(request: CleanupArchivedSessionWorktreesRequest): Promise<CleanupArchivedSessionWorktreesResponse> {
		const zeroCounts = (): CleanupArchivedSessionWorktreesResponse["counts"] => ({
			requested: 0,
			cleaned: 0,
			branchDeleted: 0,
			skipped: 0,
			alreadyCleaned: 0,
			failed: 0,
			worktreeRemoved: 0,
			invalidSelection: 0,
			notActionable: 0,
			byStatus: {},
			byReason: {},
		});
		const response: CleanupArchivedSessionWorktreesResponse = { counts: zeroCounts(), results: [], generatedAt: this.clock.now() };
		const scan = await this.listArchivedSessionWorktrees(true);
		const sessionById = new Map(scan.sessions.map(session => [session.id, session]));
		const rows = scan.items.map(item => ({ session: sessionById.get(item.sessionId), item }));

		let selected: Array<{ session?: ArchivedSessionWorktreeSession; item: ArchivedSessionWorktreeItem }> = [];
		const invalidSelections: ArchivedSessionWorktreeCleanupResult[] = [];
		if (request.mode === "all") {
			selected = rows.filter(row => row.item.status === "removable");
		} else if (request.mode === "selected" && request.sessionIds) {
			const ids = new Set(request.sessionIds);
			selected = rows.filter(row => ids.has(row.item.sessionId));
			for (const id of ids) {
				if (!rows.some(row => row.item.sessionId === id)) {
					invalidSelections.push({ key: id, sessionId: id, status: "skipped", reason: "invalid-selection", worktreeRemoved: false, branchDeleted: false });
				}
			}
		} else if (request.mode === "selected" && request.worktrees) {
			for (const selector of request.worktrees) {
				const match = rows.find(row => {
					if (row.item.sessionId !== selector.sessionId) return false;
					if (selector.key) return row.item.key === selector.key;
					if (selector.repo !== undefined && row.item.repo !== selector.repo) return false;
					if (selector.path !== undefined && normalizeWorktreeHostPath(row.item.path) !== normalizeWorktreeHostPath(selector.path)) return false;
					return selector.repo !== undefined || selector.path !== undefined;
				});
				if (match) {
					selected.push(match);
				} else {
					const key = selector.key ?? `${selector.sessionId}:${selector.repo ?? ""}:${selector.path ?? ""}`;
					invalidSelections.push({ key, sessionId: selector.sessionId, repo: selector.repo, path: selector.path, status: "skipped", reason: "invalid-selection", worktreeRemoved: false, branchDeleted: false });
				}
			}
		} else if (request.mode === "selected") {
			selected = [];
		} else if (request.mode === "category") {
			const categories = new Set(request.categories);
			const repoFilter = normalizeWorktreeHostPath(request.repoPath);
			selected = rows.filter(row => {
				if (row.item.status !== "removable") return false;
				if (!row.item.selectionCategories.some(category => categories.has(category))) return false;
				if (request.projectId && row.item.projectId !== request.projectId) return false;
				if (repoFilter && normalizeWorktreeHostPath(row.item.repoPath) !== repoFilter) return false;
				return true;
			});
		} else if (request.mode === "preset") {
			const preset = scan.selectionPresets.find(candidate => candidate.id === request.presetId);
			if (!preset) throw new CleanupArchivedSessionWorktreesRequestError("Invalid cleanup preset");
			const keys = new Set(preset.worktreeKeys);
			selected = rows.filter(row => row.item.status === "removable" && keys.has(row.item.key));
		}

		const seen = new Set<string>();
		selected = selected.filter(row => {
			if (seen.has(row.item.key)) return false;
			seen.add(row.item.key);
			return true;
		});
		response.counts.requested = selected.length + invalidSelections.length;

		const recordResult = (result: ArchivedSessionWorktreeCleanupResult) => {
			response.results.push(result);
			response.counts.byStatus[result.status] = (response.counts.byStatus[result.status] ?? 0) + 1;
			if (result.reason) response.counts.byReason[result.reason] = (response.counts.byReason[result.reason] ?? 0) + 1;
			if (result.worktreeRemoved) response.counts.worktreeRemoved++;
			if (result.reason === "invalid-selection") response.counts.invalidSelection++;
			if (result.status === "skipped" && result.reason !== "invalid-selection") response.counts.notActionable++;
		};

		for (const invalid of invalidSelections) {
			recordResult(invalid);
			response.counts.skipped++;
		}

		for (const { session, item } of selected) {
			const base: Omit<ArchivedSessionWorktreeCleanupResult, "status" | "worktreeRemoved" | "branchDeleted"> = {
				key: item.key,
				sessionId: item.sessionId,
				title: session?.title ?? item.title,
				repo: item.repo,
				repoPath: item.repoPath,
				path: item.path,
				branch: item.branch,
			};
			if (item.status === "already-cleaned") {
				recordResult({ ...base, status: "already-cleaned", reason: "already-cleaned", detail: item.detail, worktreeRemoved: false, branchDeleted: false });
				response.counts.alreadyCleaned++;
				continue;
			}
			if (item.status !== "removable") {
				recordResult({ ...base, status: "skipped", reason: item.reason, detail: item.detail, worktreeRemoved: false, branchDeleted: false });
				response.counts.skipped++;
				continue;
			}

			try {
				const { cleanupWorktree } = await import("../skills/git.js");
				await cleanupWorktree(item.repoPath, item.path, item.branch, false);

				const worktreeRemoved = await this.archivedWorktreeRemoved(item);
				if (!worktreeRemoved) {
					recordResult({ ...base, status: "failed", reason: "scan-error", error: "cleanup did not remove worktree path or git metadata", worktreeRemoved: false, branchDeleted: false });
					response.counts.failed++;
					continue;
				}

				const branchDeleted = await this.deleteArchivedWorktreeBranchIfAllowed(item);
				recordResult({
					...base,
					status: "cleaned",
					reason: branchDeleted ? "worktree-and-branch-cleaned" : "worktree-cleaned",
					worktreeRemoved: true,
					branchDeleted,
				});
				response.counts.cleaned++;
				if (branchDeleted) response.counts.branchDeleted++;
			} catch (err) {
				recordResult({ ...base, status: "failed", reason: "scan-error", error: err instanceof Error ? err.message : String(err), worktreeRemoved: false, branchDeleted: false });
				response.counts.failed++;
			}
		}

		return response;
	}

	private populateArchivedWorktreeUxCounts(counts: ArchivedSessionWorktreeScanResponse["counts"], items: ArchivedSessionWorktreeItem[]): void {
		counts.totalItems = items.length;
		for (const item of items) {
			counts.byDisposition[item.disposition] = (counts.byDisposition[item.disposition] ?? 0) + 1;
			counts.byReason[item.reason] = (counts.byReason[item.reason] ?? 0) + 1;
			for (const category of item.selectionCategories) counts.bySelectionCategory[category] = (counts.bySelectionCategory[category] ?? 0) + 1;
			if (item.disposition === "ready-to-clean") counts.readyToClean++;
			if (item.defaultSelected) counts.defaultSelected++;
			if (item.disposition === "already-cleaned") counts.alreadyCleaned++;
			if (item.disposition === "ineligible") counts.ineligible++;
			if (item.disposition === "failed") counts.failed++;
			if (item.disposition === "needs-attention" || item.disposition === "failed") counts.needsAttention++;
		}
	}

	private buildArchivedWorktreeGroups(items: ArchivedSessionWorktreeItem[]): ArchivedSessionWorktreeGroup[] {
		const groupSpecs: Array<{ key: string; label: string; description: string; disposition: ArchivedWorktreeDisposition; reason?: ArchivedWorktreeReason }> = [
			{ key: "ready-to-clean", label: "Ready to clean", description: "Archived-session worktrees that are safe to remove now.", disposition: "ready-to-clean", reason: "safe-archived-session-worktree" },
			{ key: "already-cleaned", label: "Already cleaned", description: "Archived sessions whose recorded git worktree is already gone.", disposition: "already-cleaned", reason: "already-cleaned" },
			{ key: "reason:no-worktree-path", label: "Missing worktree path", description: "Archived sessions without a recorded host worktree path.", disposition: "ineligible", reason: "no-worktree-path" },
			{ key: "reason:missing-repo-path", label: "Missing repository path", description: "Archived sessions without enough repository metadata to evaluate cleanup.", disposition: "ineligible", reason: "missing-repo-path" },
			{ key: "reason:sandbox-container-path", label: "Sandbox/container path", description: "Recorded paths are container-internal and do not identify a host worktree.", disposition: "ineligible", reason: "sandbox-container-path" },
			{ key: "reason:delegate-shared-worktree", label: "Shared delegate worktree", description: "Archived delegates that appear to share a parent worktree.", disposition: "ineligible", reason: "delegate-shared-worktree" },
			{ key: "reason:stale-worktree-directory", label: "Stale worktree directory", description: "A path remains on disk without matching git worktree metadata; manual inspection may be needed.", disposition: "needs-attention", reason: "stale-worktree-directory" },
			{ key: "reason:referenced-by-live-session", label: "Referenced by live session", description: "A non-archived or runtime session still references the worktree.", disposition: "ineligible", reason: "referenced-by-live-session" },
			{ key: "reason:referenced-by-live-goal", label: "Referenced by live goal", description: "A persisted goal still references the worktree.", disposition: "ineligible", reason: "referenced-by-live-goal" },
			{ key: "reason:referenced-by-live-team", label: "Referenced by live team", description: "A team entry or team agent still references the worktree.", disposition: "ineligible", reason: "referenced-by-live-team" },
			{ key: "reason:referenced-by-staff", label: "Referenced by staff", description: "A staff record still references the worktree.", disposition: "ineligible", reason: "referenced-by-staff" },
			{ key: "reason:scan-error", label: "Scan errors", description: "Worktrees that could not be evaluated safely.", disposition: "failed", reason: "scan-error" },
		];
		return groupSpecs.flatMap(spec => {
			const matches = spec.key === "ready-to-clean"
				? items.filter(item => item.disposition === "ready-to-clean")
				: items.filter(item => item.reason === spec.reason);
			if (matches.length === 0) return [];
			const sampleItems = matches.slice(0, 5);
			return [{
				key: spec.key,
				label: spec.label,
				description: spec.description,
				disposition: spec.disposition,
				reason: spec.reason,
				reasonCategory: spec.reason ? this.archivedWorktreeReasonCategory(spec.reason) : undefined,
				count: matches.length,
				sampleKeys: sampleItems.map(item => item.key),
				sampleItems,
				hasMore: matches.length > 5,
				actionable: spec.disposition === "ready-to-clean",
			}];
		});
	}

	private buildArchivedWorktreeSelectionPresets(items: ArchivedSessionWorktreeItem[]): ArchivedSessionWorktreeSelectionPreset[] {
		const actionable = items.filter(item => item.actionable);
		const makePreset = (id: string, label: string, description: string, matches: ArchivedSessionWorktreeItem[], cleanupRequest: CleanupArchivedSessionWorktreesRequest): ArchivedSessionWorktreeSelectionPreset => ({
			id,
			label,
			description,
			enabled: matches.length > 0,
			count: matches.length,
			worktreeKeys: matches.map(item => item.key),
			cleanupRequest,
		});
		const presets: ArchivedSessionWorktreeSelectionPreset[] = [
			makePreset("all-removable", "Select all removable", "Select every archived-session worktree that is safe to clean.", actionable, { mode: "all" }),
			makePreset("category:archived-session", "Archived sessions only", "Select all actionable archived-session worktrees.", actionable.filter(item => item.selectionCategories.includes("archived-session")), { mode: "category", categories: ["archived-session"] }),
		];
		const categoryLabels: Partial<Record<ArchivedWorktreeSelectionCategory, string>> = {
			"goal-session": "Goal sessions",
			"team-session": "Goal/team worktrees",
			"delegate-session": "Delegate worktrees",
		};
		for (const category of ["goal-session", "team-session", "delegate-session"] as const) {
			const matches = actionable.filter(item => item.selectionCategories.includes(category));
			if (matches.length > 0) presets.push(makePreset(`category:${category}`, categoryLabels[category] ?? category, `Select actionable ${category.replace(/-/g, " ")} worktrees.`, matches, { mode: "category", categories: [category] }));
		}
		const projects = new Map<string, ArchivedSessionWorktreeItem[]>();
		const repos = new Map<string, ArchivedSessionWorktreeItem[]>();
		for (const item of actionable) {
			if (item.projectId) {
				const existing = projects.get(item.projectId) ?? [];
				existing.push(item);
				projects.set(item.projectId, existing);
			}
			const repoKey = normalizeWorktreeHostPath(item.repoPath);
			if (repoKey) {
				const existing = repos.get(repoKey) ?? [];
				existing.push(item);
				repos.set(repoKey, existing);
			}
		}
		for (const [projectId, matches] of projects) {
			const label = matches[0]?.projectName ? `Current project: ${matches[0].projectName}` : "Current project";
			presets.push(makePreset(`project:${projectId}`, label, "Select actionable archived worktrees in this project.", matches, { mode: "category", categories: ["archived-session"], projectId }));
		}
		for (const [repoPath, matches] of repos) {
			const label = matches[0]?.repoDisplayName ? `Repository: ${matches[0].repoDisplayName}` : "Repository";
			presets.push(makePreset(`repo:${repoPath}`, label, "Select actionable archived worktrees in this repository.", matches, { mode: "category", categories: ["archived-session"], repoPath }));
		}
		return presets;
	}

	private archivedWorktreeDisposition(status: ArchivedWorktreeLegacyStatus, reason: ArchivedWorktreeReason): ArchivedWorktreeDisposition {
		if (status === "removable") return "ready-to-clean";
		if (status === "already-cleaned") return "already-cleaned";
		if (reason === "stale-worktree-directory") return "needs-attention";
		if (reason === "scan-error") return "failed";
		return "ineligible";
	}

	private archivedWorktreeReasonCategory(reason: ArchivedWorktreeReason): ArchivedWorktreeReasonCategory {
		switch (reason) {
			case "safe-archived-session-worktree": return "safe";
			case "already-cleaned": return "already-cleaned";
			case "no-worktree-path":
			case "missing-repo-path": return "missing-metadata";
			case "sandbox-container-path": return "container-path";
			case "delegate-shared-worktree": return "shared-delegate";
			case "stale-worktree-directory": return "stale-path";
			case "referenced-by-live-session":
			case "referenced-by-live-goal":
			case "referenced-by-live-team":
			case "referenced-by-staff": return "referenced-record";
			case "scan-error": return "error";
		}
	}

	private archivedWorktreeSelectionCategories(ps: PersistedSession, source: "repoWorktrees" | "sessionWorktree"): ArchivedWorktreeSelectionCategory[] {
		const categories: ArchivedWorktreeSelectionCategory[] = ["archived-session"];
		if (ps.goalId) categories.push("goal-session");
		if (ps.teamGoalId) categories.push("team-session");
		if (ps.delegateOf) categories.push("delegate-session");
		if (ps.parentSessionId || ps.childKind) categories.push("child-session");
		categories.push(source === "repoWorktrees" ? "multi-repo" : "single-repo");
		return categories;
	}

	private buildArchivedWorktreeScanContext(): ArchivedWorktreeScanContext {
		const candidateContexts = this.projectContextManager ? [...this.projectContextManager.visible()] : [];
		const allContexts = this.projectContextManager ? [...this.projectContextManager.all()] : [];
		const sessionPathRecords: WorktreeReferenceRecord[] = [];
		const goalRefs: ArchivedWorktreeGuardRef[] = [];
		const teamRefs: ArchivedWorktreeGuardRef[] = [];
		const staffRefs: ArchivedWorktreeGuardRef[] = [];
		const branchGuardsByRepo = new Map<string, Set<string>>();
		const archivedBranchGuardsByRepo = new Map<string, Map<string, Set<string>>>();
		const addBranchGuard = (repoPath: string | undefined, branch: string | undefined) => {
			const repoKey = normalizeWorktreeHostPath(repoPath);
			if (!repoKey || !branch) return;
			let set = branchGuardsByRepo.get(repoKey);
			if (!set) {
				set = new Set<string>();
				branchGuardsByRepo.set(repoKey, set);
			}
			set.add(branch);
		};
		const addArchivedBranchGuard = (repoPath: string | undefined, branch: string | undefined, itemKey: string) => {
			const repoKey = normalizeWorktreeHostPath(repoPath);
			if (!repoKey || !branch) return;
			let branches = archivedBranchGuardsByRepo.get(repoKey);
			if (!branches) {
				branches = new Map<string, Set<string>>();
				archivedBranchGuardsByRepo.set(repoKey, branches);
			}
			let keys = branches.get(branch);
			if (!keys) {
				keys = new Set<string>();
				branches.set(branch, keys);
			}
			keys.add(itemKey);
		};
		const addRepoBranches = (repoPath: string | undefined, branch: string | undefined, repoWorktrees?: Record<string, string>) => {
			if (repoWorktrees && repoPath) {
				for (const repo of Object.keys(repoWorktrees)) addBranchGuard(repo === "." ? repoPath : path.join(repoPath, repo), branch);
			} else {
				addBranchGuard(repoPath, branch);
			}
		};

		const persistedSessions = this.projectContextManager
			? allContexts.flatMap(ctx => ctx.sessionStore.getLive())
			: (this._testStore?.getLive() ?? []);
		for (const ps of persistedSessions) {
			sessionPathRecords.push(ps);
			addRepoBranches(ps.repoPath, ps.branch, ps.repoWorktrees);
		}
		for (const session of this.sessions.values()) {
			const repoWorktrees = session.repoWorktrees ? Object.fromEntries(session.repoWorktrees.map(w => [w.repo, w.worktreePath])) : undefined;
			sessionPathRecords.push({ id: session.id, worktreePath: session.worktreePath, cwd: session.cwd, repoWorktrees });
			if (session.repoWorktrees && session.repoWorktrees.length > 0) {
				for (const wt of session.repoWorktrees) addBranchGuard(wt.repoPath, session.branch);
			} else {
				addBranchGuard(session.repoPath, session.branch);
			}
		}

		const archivedSessions = this.projectContextManager
			? allContexts.flatMap(ctx => ctx.sessionStore.getArchived())
			: (this._testStore?.getArchived() ?? []);
		for (const ps of archivedSessions) {
			if (ps.repoWorktrees && Object.keys(ps.repoWorktrees).length > 0 && ps.repoPath) {
				for (const [repo, wt] of Object.entries(ps.repoWorktrees)) {
					const repoPath = repo === "." ? ps.repoPath : path.join(ps.repoPath, repo);
					addArchivedBranchGuard(repoPath, ps.branch, this.archivedWorktreeKey(ps.id, repo, wt));
				}
			} else {
				addArchivedBranchGuard(ps.repoPath, ps.branch, this.archivedWorktreeKey(ps.id, ".", ps.worktreePath));
			}
		}

		for (const projectCtx of allContexts) {
			const goalsById = new Map(projectCtx.goalStore.getAll().map(goal => [goal.id, goal]));
			for (const goal of projectCtx.goalStore.getAll()) {
				goalRefs.push({
					id: goal.id,
					repoPath: goal.repoPath,
					worktreePath: goal.worktreePath,
					cwd: goal.cwd,
					branch: goal.branch,
					repoWorktrees: goal.repoWorktrees,
					archived: goal.archived,
					worktreeOwnerSessionId: goal.worktreeOwnerSessionId,
				});
				// An archived, exactly matched adopted goal is provenance, not a live
				// branch owner. Malformed or divergent records fail closed and retain
				// the branch guard.
				const adoptedOwner = goal.worktreeOwnerSessionId
					? projectCtx.sessionStore.get(goal.worktreeOwnerSessionId)
					: undefined;
				const exactArchivedAdoption = !!(goal.archived && adoptedOwner && this.goalExactlyAdoptsSession(goal, adoptedOwner));
				if (!exactArchivedAdoption) addRepoBranches(goal.repoPath, goal.branch, goal.repoWorktrees);
			}
			for (const team of projectCtx.teamStore.getAll()) {
				const ownerGoal = goalsById.get(team.goalId);
				for (const agent of team.agents) {
					const repoPath = ownerGoal?.repoPath ?? projectCtx.project.rootPath;
					teamRefs.push({ id: agent.sessionId, repoPath, worktreePath: agent.worktreePath, branch: agent.branch, repoWorktrees: agent.repoWorktrees });
					addRepoBranches(repoPath, agent.branch, agent.repoWorktrees);
				}
				const lead = team.teamLeadSessionId ? projectCtx.sessionStore.get(team.teamLeadSessionId) : undefined;
				if (lead) {
					teamRefs.push({ id: lead.id, repoPath: lead.repoPath, worktreePath: lead.worktreePath, cwd: lead.cwd, branch: lead.branch, repoWorktrees: lead.repoWorktrees });
					addRepoBranches(lead.repoPath, lead.branch, lead.repoWorktrees);
				}
			}
			for (const staff of projectCtx.staffStore.getAll()) {
				staffRefs.push({ id: staff.id, repoPath: staff.repoPath, worktreePath: staff.worktreePath, cwd: staff.cwd, branch: staff.branch, repoWorktrees: staff.repoWorktrees });
				addRepoBranches(staff.repoPath, staff.branch, staff.repoWorktrees);
			}
		}

		return {
			candidateContexts,
			sessionPathRecords,
			goalRefs,
			teamRefs,
			staffRefs,
			branchGuardsByRepo,
			archivedBranchGuardsByRepo,
			gitRefsCache: new Map(),
			branchExistsCache: new Map(),
		};
	}

	private async archivedSessionWorktreeItems(ps: PersistedSession, ctx: ArchivedWorktreeScanContext, projectName?: string): Promise<ArchivedSessionWorktreeItem[]> {
		// Borrowed goal worktrees remain goal-owned after the lead is archived;
		// exact adopted sources are instead exposed for their final cleanup.
		if (this.hasGoalOwnedTeamLeadWorktrees(ps)) return [];
		const specs: Array<{ repo: string; repoPath?: string; worktreePath?: string; branch?: string; source: "repoWorktrees" | "sessionWorktree" }> = [];
		if (ps.repoWorktrees && Object.keys(ps.repoWorktrees).length > 0) {
			for (const [repo, wt] of Object.entries(ps.repoWorktrees)) {
				specs.push({ repo, repoPath: ps.repoPath ? (repo === "." ? ps.repoPath : path.join(ps.repoPath, repo)) : undefined, worktreePath: wt, branch: ps.branch, source: "repoWorktrees" });
			}
		} else {
			specs.push({ repo: ".", repoPath: ps.repoPath, worktreePath: ps.worktreePath, branch: ps.branch, source: "sessionWorktree" });
		}

		const items: ArchivedSessionWorktreeItem[] = [];
		for (const spec of specs) {
			const item = await this.archivedSessionWorktreeItem(ps, spec, ctx, projectName);
			items.push(item);
		}
		return items;
	}

	private async archivedSessionWorktreeItem(
		ps: PersistedSession,
		spec: { repo: string; repoPath?: string; worktreePath?: string; branch?: string; source: "repoWorktrees" | "sessionWorktree" },
		ctx: ArchivedWorktreeScanContext,
		projectName?: string,
	): Promise<ArchivedSessionWorktreeItem> {
		const key = this.archivedWorktreeKey(ps.id, spec.repo, spec.worktreePath);
		const repoDisplayName = spec.repo === "." ? (projectName ?? (spec.repoPath ? path.basename(spec.repoPath) : ".")) : spec.repo;
		const base = (overrides: Partial<ArchivedSessionWorktreeItem>): ArchivedSessionWorktreeItem => {
			const raw = {
				key,
				sessionId: ps.id,
				title: ps.title,
				archivedAt: ps.archivedAt,
				projectId: ps.projectId,
				projectName,
				goalId: ps.goalId,
				teamGoalId: ps.teamGoalId,
				delegateOf: ps.delegateOf,
				parentSessionId: ps.parentSessionId,
				childKind: ps.childKind,
				sandboxed: ps.sandboxed,
				repo: spec.repo,
				repoPath: spec.repoPath ?? "",
				repoDisplayName,
				path: spec.worktreePath ?? "",
				branch: spec.branch,
				source: spec.source,
				pathExists: false,
				gitWorktreeMetadataExists: false,
				localBranchExists: false,
				status: "skipped" as ArchivedWorktreeLegacyStatus,
				reason: "scan-error" as ArchivedWorktreeReason,
				detail: "Not evaluated.",
				willDeleteBranch: false,
				selectionCategories: this.archivedWorktreeSelectionCategories(ps, spec.source),
				...overrides,
			};
			const status = raw.status ?? "skipped";
			const reason = raw.reason ?? "scan-error";
			const disposition = raw.disposition ?? this.archivedWorktreeDisposition(status, reason);
			const actionable = raw.actionable ?? disposition === "ready-to-clean";
			return {
				...raw,
				status,
				reason,
				disposition,
				reasonCategory: raw.reasonCategory ?? this.archivedWorktreeReasonCategory(reason),
				actionable,
				selectable: raw.selectable ?? actionable,
				defaultSelected: raw.defaultSelected ?? actionable,
			};
		};

		if (!spec.worktreePath) return base({ status: "skipped", reason: "no-worktree-path", detail: "Archived session has no recorded worktree path." });
		if (!spec.repoPath) return base({ status: "skipped", reason: "missing-repo-path", detail: "Archived session has no recorded repository path for this worktree." });
		if (this.isContainerInternalWorktreePath(spec.worktreePath)) return base({ status: "skipped", reason: "sandbox-container-path", detail: "Recorded worktree path is container-internal and has no host worktree to remove." });
		if (ps.delegateOf && !ps.branch && (!ps.repoWorktrees || Object.keys(ps.repoWorktrees).length === 0)) {
			return base({ status: "skipped", reason: "delegate-shared-worktree", detail: "Archived delegate appears to share its parent worktree." });
		}

		let pathExists = false;
		try { pathExists = fs.existsSync(spec.worktreePath); } catch { pathExists = false; }
		const gitRefs = await this.readGitWorktreeRefs(spec.repoPath, ctx);
		const normalizedCandidate = normalizeWorktreeHostPath(spec.worktreePath);
		const gitWorktreeMetadataExists = this.gitWorktreeMetadataMatches(gitRefs, normalizedCandidate, spec.branch);
		const localBranchExists = await this.localBranchExists(spec.repoPath, spec.branch, ctx);
		const sessionReferenced = isWorktreePathReferencedByLiveSession(spec.worktreePath, ctx.sessionPathRecords, { ignoreSessionId: ps.id });
		if (sessionReferenced) {
			return base({ pathExists, gitWorktreeMetadataExists, localBranchExists, status: "skipped", reason: "referenced-by-live-session", detail: "Another non-archived or runtime session still references this worktree." });
		}
		if (this.isWorktreeReferencedByRefs(spec.worktreePath, ctx.goalRefs, {
			ownerSessionId: ps.id,
			goalId: ps.teamGoalId ?? ps.goalId,
		})) {
			return base({ pathExists, gitWorktreeMetadataExists, localBranchExists, status: "skipped", reason: "referenced-by-live-goal", detail: "A persisted goal still references this worktree." });
		}
		if (this.isWorktreeReferencedByRefs(spec.worktreePath, ctx.teamRefs)) {
			return base({ pathExists, gitWorktreeMetadataExists, localBranchExists, status: "skipped", reason: "referenced-by-live-team", detail: "A persisted team entry or team agent still references this worktree." });
		}
		if (this.isWorktreeReferencedByRefs(spec.worktreePath, ctx.staffRefs)) {
			return base({ pathExists, gitWorktreeMetadataExists, localBranchExists, status: "skipped", reason: "referenced-by-staff", detail: "A staff record still references this worktree." });
		}
		if (!gitWorktreeMetadataExists) {
			return base({
				pathExists,
				gitWorktreeMetadataExists,
				localBranchExists,
				status: pathExists ? "skipped" : "already-cleaned",
				reason: pathExists ? "stale-worktree-directory" : "already-cleaned",
				detail: pathExists
					? "Recorded path exists but no matching git worktree metadata remains; archived-session cleanup will not remove stale directories."
					: "No worktree directory or git worktree metadata remains; any branch-only residue is out of scope for archived-session worktree cleanup.",
			});
		}

		const branchDeleteBlockedReason = localBranchExists
			? this.branchDeleteBlockedReason(spec.branch, spec.repoPath, ctx, key)
			: undefined;
		const willDeleteBranch = localBranchExists && !branchDeleteBlockedReason;
		return base({
			pathExists,
			gitWorktreeMetadataExists,
			localBranchExists,
			status: "removable",
			reason: "safe-archived-session-worktree",
			detail: branchDeleteBlockedReason === "branch-referenced-by-archived-record"
				? "Archived session worktree is safe to remove; branch deletion is blocked because another archived record still references the branch."
				: branchDeleteBlockedReason
					? "Archived session worktree is safe to remove; branch deletion is blocked because another live record still references the branch."
					: "Archived session worktree is safe to remove.",
			willDeleteBranch,
			branchDeleteBlockedReason,
		});
	}

	private archivedWorktreeKey(sessionId: string, repo: string, worktreePath: string | undefined): string {
		return `${sessionId}:${repo}:${normalizeWorktreeHostPath(worktreePath) ?? ""}`;
	}

	private isContainerInternalWorktreePath(candidatePath: string): boolean {
		const normalized = candidatePath.replace(/\\/g, "/");
		return normalized === "/workspace" || normalized.startsWith("/workspace/") || normalized === "/workspace-wt" || normalized.startsWith("/workspace-wt/");
	}

	private isWorktreeReferencedByRefs(
		candidatePath: string | undefined,
		refs: ArchivedWorktreeGuardRef[],
		archivedAdoption?: { ownerSessionId: string; goalId?: string },
	): boolean {
		const candidate = normalizeWorktreeHostPath(candidatePath);
		if (!candidate) return false;
		for (const ref of refs) {
			if (
				ref.archived
				&& archivedAdoption?.goalId === ref.id
				&& ref.worktreeOwnerSessionId === archivedAdoption?.ownerSessionId
			) continue;
			if (normalizeWorktreeHostPath(ref.worktreePath) === candidate) return true;
			const cwd = normalizeWorktreeHostPath(ref.cwd);
			if (cwd && (cwd === candidate || cwd.startsWith(`${candidate}/`))) return true;
			if (ref.repoWorktrees) {
				for (const wt of Object.values(ref.repoWorktrees)) {
					if (normalizeWorktreeHostPath(wt) === candidate) return true;
				}
			}
		}
		return false;
	}

	private branchDeleteBlockedReason(branch: string | undefined, repoPath: string, ctx: ArchivedWorktreeScanContext, ownKey?: string): ArchivedSessionWorktreeItem["branchDeleteBlockedReason"] | undefined {
		if (!branch) return "branch-referenced-by-live-record";
		const repoKey = normalizeWorktreeHostPath(repoPath);
		if (!repoKey) return "branch-referenced-by-live-record";
		if (ctx.branchGuardsByRepo.get(repoKey)?.has(branch)) return "branch-referenced-by-live-record";
		const archivedKeys = ctx.archivedBranchGuardsByRepo.get(repoKey)?.get(branch);
		if (archivedKeys && [...archivedKeys].some(key => key !== ownKey)) return "branch-referenced-by-archived-record";
		return undefined;
	}

	private branchDeletionAllowed(branch: string | undefined, repoPath: string, ctx: ArchivedWorktreeScanContext, ownKey?: string): boolean {
		return !this.branchDeleteBlockedReason(branch, repoPath, ctx, ownKey);
	}

	private async archivedWorktreeRemoved(item: ArchivedSessionWorktreeItem): Promise<boolean> {
		let pathExists = false;
		try { pathExists = fs.existsSync(item.path); } catch { pathExists = false; }
		const gitRefs = await this.readGitWorktreeRefsUncached(item.repoPath);
		const normalizedCandidate = normalizeWorktreeHostPath(item.path);
		const gitWorktreeMetadataExists = this.gitWorktreeMetadataMatches(gitRefs, normalizedCandidate, item.branch);
		return !pathExists && !gitWorktreeMetadataExists;
	}

	private async deleteArchivedWorktreeBranchIfAllowed(item: ArchivedSessionWorktreeItem): Promise<boolean> {
		if (!item.willDeleteBranch || !item.branch || !item.localBranchExists) return false;
		const ctx = this.buildArchivedWorktreeScanContext();
		if (!this.branchDeletionAllowed(item.branch, item.repoPath, ctx, item.key)) return false;
		try {
			await this.commandRunner.execFile("git", ["branch", "-D", item.branch], { cwd: item.repoPath });
		} catch {
			// Verify below before reporting success; branch deletion may have raced or been blocked.
		}
		const branchDeleted = !(await this.localBranchExistsUncached(item.repoPath, item.branch));
		if (!branchDeleted) return false;
		if (!(await shouldSkipRemotePushForTests(item.repoPath, "origin", this.commandRunner, this.remoteGitPolicy))) {
			try {
				await this.commandRunner.execFile("git", ["push", "origin", "--delete", item.branch], { cwd: item.repoPath, timeout: 15_000 });
			} catch {
				// Best effort: remote may be missing, unreachable, or already deleted.
			}
		}
		return true;
	}

	private gitWorktreeMetadataMatches(gitRefs: GitWorktreeRefs, normalizedCandidate: string | undefined, branch: string | undefined): boolean {
		if (!normalizedCandidate) return false;
		return gitRefs.entries.some(entry => entry.path === normalizedCandidate && (!branch || entry.branch === branch));
	}

	private readGitWorktreeRefs(repoPath: string, ctx: ArchivedWorktreeScanContext): Promise<GitWorktreeRefs> {
		const repoKey = normalizeWorktreeHostPath(repoPath) ?? repoPath;
		let cached = ctx.gitRefsCache.get(repoKey);
		if (!cached) {
			cached = this.readGitWorktreeRefsUncached(repoPath);
			ctx.gitRefsCache.set(repoKey, cached);
		}
		return cached;
	}

	private async readGitWorktreeRefsUncached(repoPath: string): Promise<GitWorktreeRefs> {
		try {
			const { stdout } = await this.commandRunner.execFile("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
			const entries: GitWorktreeRef[] = [];
			for (const block of stdout.toString().split("\n\n")) {
				const pathMatch = block.match(/^worktree (.+)$/m);
				const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
				const normalizedPath = normalizeWorktreeHostPath(pathMatch?.[1]);
				if (!normalizedPath) continue;
				entries.push({ path: normalizedPath, branch: branchMatch?.[1] });
			}
			return { entries };
		} catch {
			return { entries: [] };
		}
	}

	private localBranchExists(repoPath: string, branch: string | undefined, ctx: ArchivedWorktreeScanContext): Promise<boolean> {
		if (!branch) return Promise.resolve(false);
		const repoKey = normalizeWorktreeHostPath(repoPath) ?? repoPath;
		const key = `${repoKey}:${branch}`;
		let cached = ctx.branchExistsCache.get(key);
		if (!cached) {
			cached = this.localBranchExistsUncached(repoPath, branch);
			ctx.branchExistsCache.set(key, cached);
		}
		return cached;
	}

	private localBranchExistsUncached(repoPath: string, branch: string): Promise<boolean> {
		return this.commandRunner.execFile("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoPath })
			.then(() => true)
			.catch(() => false);
	}

	/**
	 * Coalesce every immediate and scheduled destructive purge for one session.
	 * The owner is installed synchronously before callers can overlap, and is
	 * removed only after cleanup and listeners have settled.
	 */
	private async coalescePurgeOneSession(ps: PersistedSession): Promise<boolean> {
		const existing = this.sessionPurgesInFlight.get(ps.id);
		if (existing) {
			await existing;
			return true;
		}

		// An expiry sweep holds an ordered snapshot. An immediate purge can finish
		// while that sweep is still processing an earlier row, leaving this stale
		// object behind after its per-session owner has settled. Re-resolve before
		// installing a new owner so the old snapshot cannot run cleanup twice.
		const current = this.resolveStoreForId(ps.id)?.get(ps.id);
		if (!current?.archived) return false;

		const run = this.purgeOneSession(current);
		let tracked!: Promise<void>;
		tracked = run.finally(() => {
			if (this.sessionPurgesInFlight.get(ps.id) === tracked) {
				this.sessionPurgesInFlight.delete(ps.id);
			}
		});
		this.sessionPurgesInFlight.set(ps.id, tracked);
		await tracked;
		return true;
	}

	/** Internal purge body — entered only through the per-session owner above. */
	private async purgeOneSession(ps: PersistedSession): Promise<void> {
		this.assertPromotedSessionLifecycleAllowed(ps.id, "purge");
		// SAFETY: refuse to destroy a team-lead session that the team-store
		// still references for a non-archived goal. Symptom this prevents:
		// the user's "Audit subgoals branch" team-lead vanished because some
		// caller (most likely the immediate-purge branch of `DELETE /api/
		// sessions/:id` at server.ts:5816, or the 7-day archive sweep) hit
		// `purgeOneSession` on a session that the team-store still treated
		// as the active team-lead. After purge the team-store referenced a
		// dead session id, the goal got stuck at "Start Team" with a
		// non-functional button, and the .jsonl was permanently destroyed.
		//
		// The right cleanup order is: teardownTeam(goalId) → that removes
		// the team-store entry and terminates the team-lead session →
		// purgeOneSession is then safe. Anything that wants to skip the
		// teardown step is destroying user data.
		//
		// Allow the purge when the owning goal is archived: at that point
		// teardownTeam should already have run (goal-manager.archiveGoal
		// invokes it), and even if it didn't the team is no longer being
		// used by the user, so cleaning up is acceptable.
		if (ps.role === "team-lead" && ps.teamGoalId && ps.projectId && this.projectContextManager) {
			try {
				const ctx = this.projectContextManager.getOrCreate(ps.projectId);
				if (ctx) {
					const verdict = canPurgeTeamLeadSession(
						{ role: ps.role, id: ps.id, teamGoalId: ps.teamGoalId },
						(goalId) => ctx.teamStore.get(goalId)?.teamLeadSessionId ?? undefined,
						(goalId) => !!ctx.goalStore.get(goalId)?.archived,
					);
					if (!verdict.allow) {
						console.warn(`[session-manager] Refusing to purge session ${ps.id}: ${verdict.reason}`);
						return;
					}
				}
			} catch (err) {
				console.error(`[session-manager] Pre-purge safety check failed for ${ps.id}:`, err);
				// Fall through to purge rather than block indefinitely on a
				// check error — best-effort, the rest of the cleanup logs.
			}
		}

		// Adopted multi-repo cleanup is all-or-nothing. If any component is still
		// referenced, retain the archived owner record so a later purge can clean
		// every component and the shared container exactly once.
		if (this.adoptedWorkspaceHasLiveReference(ps)) {
			console.warn(`[session-manager] Refusing to purge adopted workspace owner ${ps.id}: another live session still references a component`);
			return;
		}

		// Cascade-reap any child agents before destroying the parent's data (§6).
		// A parent normally cascades at archive time, but purge is a terminal data
		// destruction — reap here as a final safety net so a child never outlives
		// the purge of its parent.
		try { await this.cascadeReapOwner(ps.id); } catch { /* best-effort */ }

		// Remove from search index
		this.cleanupSearchForSession(ps.id, ps.projectId);

		// Delete the active and every retained pre-clear transcript exactly once.
		// Exact host paths outside purge-safe roots remain read-compatible only.
		const transcriptPaths = [
			ps.agentSessionFile,
			...normalizeContextClearBoundaries(ps.contextClearBoundaries)
				.map((boundary) => boundary.previousAgentSessionFile),
		].filter((filePath): filePath is string => typeof filePath === "string" && filePath.length > 0);
		const deletedIdentities = new Set<string>();
		for (const transcriptPath of transcriptPaths) {
			let identity: string;
			let safeFile: string | null;
			try {
				identity = this._validatedAgentSessionPathIdentity(ps, transcriptPath);
				if (deletedIdentities.has(identity)) continue;
				deletedIdentities.add(identity);
				safeFile = canonicalContainerAgentSessionPath(transcriptPath)
					?? (isHostAbsoluteAgentSessionPath(transcriptPath)
						? resolveSafeSessionsPath(transcriptPath)
						: null);
			} catch {
				continue;
			}
			if (!safeFile) continue;
			const purgeCtx = sessionFsContextForAgentFile(ps, safeFile);
			await sessionFileDelete(purgeCtx, safeFile, this.sandboxManager).catch(err => {
				console.error(`[session-manager] Failed to delete retained .jsonl for ${ps.id}:`, err);
			});
			// Recovery sidecars are host-owned and adjacent only to safe host paths.
			if (!canonicalContainerAgentSessionPath(safeFile)) {
				try { await sessionSidecarDelete(safeFile); }
				catch (err) { console.warn(`[session-manager] Failed to delete sidecar for ${ps.id}:`, err); }
			}
		}

		// Delete per-session proposal-drafts directory. Deferred from archive
		// (terminateSession) so that archived sessions retain their drafts long
		// enough for the reopen-archived-proposals flows (Path A in-place
		// resubmit + Path B continue-assistant). Best-effort — missing dir is
		// harmless. See docs/design/editable-proposals.md §4.
		try {
			await removeTree(path.join(bobbitStateDir(), "proposal-drafts", ps.id));
		} catch (err) {
			console.warn(`[session-manager] proposal-drafts purge failed for ${ps.id}:`, err);
		}

		// Delete the prompt and mount while holding the same per-session preview
		// operation queue used by POST, restore, snapshot, SSE bootstrap, and
		// artifact cleanup. The production queue terminally fences ordinary work
		// before awaiting prior operations, so the mount cannot be recreated after
		// this deletion completes.
		try {
			await this.previewPurgeOperation(ps.id, () => cleanupSessionPromptAsync(ps.id, this.stateDir));
		} catch (err) {
			console.error(`[session-manager] Failed to cleanup prompt for ${ps.id}:`, err);
		}

		// Delete persisted prompt sections JSON.
		try {
			await purgePromptSectionsJsonAsync(ps.id, this.stateDir);
		} catch (err) {
			console.error(`[session-manager] Failed to cleanup prompt sections for ${ps.id}:`, err);
		}

		// Clean up host worktree.  Sandboxed session worktrees also create a host-side
		// worktree for server bookkeeping, so we clean those up too.  Skip paths that
		// are container-internal (start with /workspace) — those have no host counterpart.
		// Skip delegates and ordinary non-sandboxed polyrepo leads — both borrow
		// worktrees owned elsewhere. Canonical adopted sources remain final owners.
		const goalOwnsTeamLeadWorktrees = this.hasGoalOwnedTeamLeadWorktrees(ps);
		if (ps.worktreePath && ps.repoPath && !ps.worktreePath.startsWith("/workspace") && !ps.delegateOf && !goalOwnsTeamLeadWorktrees) {
			try {
				const { cleanupWorktree, removeEmptyWorktreeSetContainer } = await import("../skills/git.js");
				const allPersisted = this.getAllPersistedSessionsForWorktreeGuard();
				// Multi-repo: clean each repo's worktree with the shared background-I/O
				// ceiling + delete the shared branch from each repo's remote (Phase 4a).
				if (ps.repoWorktrees && Object.keys(ps.repoWorktrees).length > 0) {
					await mapWithConcurrency(Object.entries(ps.repoWorktrees), BACKGROUND_IO_CONCURRENCY, async ([repo, wt]) => {
						if (isWorktreePathReferencedByLiveSession(wt, allPersisted, { ignoreSessionId: ps.id })) {
							console.log(`[session-manager] Skipping shared worktree cleanup for purged session ${ps.id}: ${wt}`);
							return;
						}
						const repoPath = repo === "." ? ps.repoPath! : path.join(ps.repoPath!, repo);
						try {
							await cleanupWorktree(repoPath, wt, ps.branch, true, this.commandRunner, this.remoteGitPolicy);
							try {
								await fsp.access(wt);
								console.error(`[session-manager] Component "${repo}" cleanup left worktree for ${ps.id}: ${wt}`);
							} catch { /* removed */ }
						} catch (err) {
							console.error(`[session-manager] Failed to clean up component "${repo}" worktree for ${ps.id}:`, err);
						}
					});
					try {
						await removeEmptyWorktreeSetContainer(ps.worktreePath, Object.values(ps.repoWorktrees));
					} catch (err) {
						console.error(`[session-manager] Failed to remove multi-repo branch container for ${ps.id}: ${ps.worktreePath}`, err);
					}
				} else if (!isWorktreePathReferencedByLiveSession(ps.worktreePath, allPersisted, { ignoreSessionId: ps.id })) {
					await cleanupWorktree(ps.repoPath, ps.worktreePath, ps.branch, true, this.commandRunner, this.remoteGitPolicy);
				} else {
					console.log(`[session-manager] Skipping shared worktree cleanup for purged session ${ps.id}: ${ps.worktreePath}`);
				}
			} catch (err) {
				console.error(`[session-manager] Failed to cleanup worktree for ${ps.id}:`, err);
			}
		} else if (goalOwnsTeamLeadWorktrees) {
			console.log(`[session-manager] Skipping goal-owned component worktree cleanup for purged team lead ${ps.id}.`);
		}

		// Remove color
		try {
			await this.colorStore?.removeAsync(ps.id);
		} catch (err) {
			console.error(`[session-manager] Failed to remove color for ${ps.id}:`, err);
		}

		// Remove from store and durably record its deletion tombstone.
		await this.resolveStoreForId(ps.id)?.purgeAsync(ps.id);

		// Source-fix for the dangling-team-lead bug: if the purged session was
		// the team-lead of a team-mode goal, also drop the corresponding
		// team-store entry. Without this, the team-store keeps a pointer at
		// the now-deleted session id; on the next boot `TeamManager.restoreTeams`
		// surfaces the dangling entry into `this.teams`, and `startTeam(goalId)`
		// then throws "Team already active" forever — the goal becomes stuck
		// at "No agents — Start Team" with a non-functional button. A boot-time
		// sweep in `team-manager.ts::restoreTeams` recovers already-damaged
		// state; this clears the leak at source so the sweep stays a defensive
		// belt rather than the only line of defence.
		if (ps.role === "team-lead" && ps.teamGoalId && ps.projectId && this.projectContextManager) {
			try {
				const ctx = this.projectContextManager.getOrCreate(ps.projectId);
				if (ctx && ctx.teamStore.get(ps.teamGoalId)) {
					await ctx.teamStore.removeAsync(ps.teamGoalId);
					console.log(`[session-manager] Dropped team-store entry for goal ${ps.teamGoalId} on team-lead purge (session ${ps.id}).`);
				}
			} catch (err) {
				console.error(`[session-manager] Failed to clean team-store entry on team-lead purge for ${ps.id}:`, err);
			}
		}

		await this.cleanupScopedMcpManagersForSessionScope({ projectId: ps.projectId, cwd: ps.cwd });

		// Notify termination listeners (sidebar broadcast etc.) so cached UI lists
		// drop the entry without waiting for a polling tick.
		for (const listener of this._terminationListeners) {
			try {
				await listener(ps.id, { projectId: ps.projectId, reason: "purged" });
			} catch (err) {
				console.error(`[session ${ps.id}] purge listener failed:`, err);
			}
		}
	}

	/** Remove search index entries for a session. Used when removing a session from the store. */
	private cleanupSearchForSession(sessionId: string, projectId?: string): void {
		try {
			const searchIndex = projectId
				? this.projectContextManager?.getOrCreate(projectId)?.searchIndex
				: null;
			const idx = searchIndex || this._testSearchIndex;
			if (idx) {
				idx.removeMessagesForSession(sessionId);
				idx.removeSession(sessionId);
			}
		} catch {
			// Non-critical — don't break the removal flow
		}
	}

	/**
	 * Resolve a session's persisted .jsonl path, or recover one when the stored
	 * path is absent or invalid. Stored sandbox paths must use a canonical agent
	 * sessions container path; stored host paths retain the existing read-only
	 * compatibility validation. Recovery scans only trusted sessions roots.
	 *
	 * Public so fork and continue routes can resolve transcript sources without
	 * using a raw persisted path.
	 */
	recoverSessionFile(ps: PersistedSession): string | null {
		try {
			if (ps.agentSessionFile) {
				const containerPath = ps.sandboxed
					? canonicalContainerAgentSessionPath(ps.agentSessionFile)
					: null;
				if (containerPath) return containerPath;

				if (isHostAbsoluteAgentSessionPath(ps.agentSessionFile) && fs.existsSync(ps.agentSessionFile)) {
					const safePath = safePersistedHostAgentSessionFile(ps.agentSessionFile);
					if (safePath) {
						trustPersistedAgentSessionFile(safePath);
						return safePath.replace(/\\/g, "/");
					}
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
	 * Best-effort — logs warnings but never throws.
	 */
	async cleanupOrphanedSessionWorktrees(repoPath: string): Promise<void> {
		try {
			const { stdout } = await this.commandRunner.execFile("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
			const blocks = stdout.toString().split("\n\n");

			// Build a set of branches/paths owned by live (non-archived) persisted sessions.
			// Prior to the fix, pool worktree directories were renamed on claim but
			// `git worktree repair` could fail — git tracked the OLD path while
			// the session stored the NEW path. Matching by branch prevents the
			// cleanup from deleting worktrees that are actually in use.
			const persistedBranches = new Set<string>();
			const allPersisted = this.getAllPersistedSessionsForWorktreeGuard();
			for (const ps of allPersisted) {
				if (!ps.archived && ps.branch) persistedBranches.add(ps.branch);
			}
			const runtimeRecords: WorktreeReferenceRecord[] = [...this.sessions.values()].map(s => ({
				id: s.id,
				worktreePath: s.worktreePath,
				cwd: s.cwd,
				repoWorktrees: s.repoWorktrees
					? Object.fromEntries(s.repoWorktrees.map(w => [w.repo, w.worktreePath]))
					: undefined,
			}));
			const allPathRecords: WorktreeReferenceRecord[] = [...allPersisted, ...runtimeRecords];

			for (const block of blocks) {
				const branchMatch = block.match(/^branch refs\/heads\/(session\/.+)$/m);
				if (!branchMatch) continue;
				const branch = branchMatch[1];
				// Skip worktree pool entries — they're pre-built and waiting to be
				// claimed by new sessions. They won't have a matching active session yet.
				if (branch.startsWith("session/_pool-")) continue;
				const pathMatch = block.match(/^worktree (.+)$/m);
				if (!pathMatch) continue;
				const wtPath = pathMatch[1];
				// Check if any active session uses this worktree (by path or branch)
				const isActive = isWorktreePathReferencedByLiveSession(wtPath, allPathRecords) || persistedBranches.has(branch);
				if (!isActive) {
					console.log(`[session-manager] Cleaning up orphaned session worktree: ${wtPath} (branch: ${branch})`);
					const { cleanupWorktree } = await import("../skills/git.js");
					await cleanupWorktree(repoPath, wtPath, branch, true, this.commandRunner).catch(() => {});
				}
			}
		} catch (err) {
			console.warn("[session-manager] Failed to clean up orphaned session worktrees:", err);
		}
	}

	/**
	 * List orphaned session worktrees without deleting them.
	 * Same detection logic as cleanupOrphanedSessionWorktrees but read-only.
	 */
	async listOrphanedSessionWorktrees(repoPath: string): Promise<Array<{ path: string; branch: string }>> {
		try {
			const { stdout } = await this.commandRunner.execFile("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
			const blocks = stdout.toString().split("\n\n");

			const persistedBranches = new Set<string>();
			const allPersisted = this.getAllPersistedSessionsForWorktreeGuard();
			for (const ps of allPersisted) {
				if (!ps.archived && ps.branch) persistedBranches.add(ps.branch);
			}
			const runtimeRecords: WorktreeReferenceRecord[] = [...this.sessions.values()].map(s => ({
				id: s.id,
				worktreePath: s.worktreePath,
				cwd: s.cwd,
				repoWorktrees: s.repoWorktrees
					? Object.fromEntries(s.repoWorktrees.map(w => [w.repo, w.worktreePath]))
					: undefined,
			}));
			const allPathRecords: WorktreeReferenceRecord[] = [...allPersisted, ...runtimeRecords];

			const orphans: Array<{ path: string; branch: string }> = [];
			for (const block of blocks) {
				const branchMatch = block.match(/^branch refs\/heads\/(session\/.+)$/m);
				if (!branchMatch) continue;
				const branch = branchMatch[1];
				if (branch.startsWith("session/_pool-")) continue;
				const pathMatch = block.match(/^worktree (.+)$/m);
				if (!pathMatch) continue;
				const wtPath = pathMatch[1];
				const isActive = isWorktreePathReferencedByLiveSession(wtPath, allPathRecords) || persistedBranches.has(branch);
				if (!isActive) {
					orphans.push({ path: wtPath, branch });
				}
			}
			return orphans;
		} catch (err) {
			console.warn("[session-manager] Failed to list orphaned session worktrees:", err);
			return [];
		}
	}

	/**
	 * List orphaned non-interactive sessions (e.g. verification reviewers)
	 * that have no tracking in the verification harness. Read-only.
	 */
	async listOrphanedNonInteractiveSessions(): Promise<Array<{ id: string; title: string; createdAt: number }>> {
		const resumingIds = this._verificationHarness?.getResumingSessionIds() ?? new Set<string>();
		const result: Array<{ id: string; title: string; createdAt: number }> = [];
		const allLive = this.projectContextManager
			? [...this.projectContextManager.getAllLiveSessions()]
			: (this._testStore?.getLive() ?? []);
		for (const ps of allLive) {
			if (ps.nonInteractive && !resumingIds.has(ps.id)) {
				result.push({ id: ps.id, title: ps.title, createdAt: ps.createdAt });
			}
		}
		return result;
	}

	/**
	 * Terminate a list of orphaned non-interactive sessions.
	 * Returns the number actually terminated.
	 */
	async terminateOrphanedSessions(sessionIds: string[]): Promise<number> {
		let terminated = 0;
		for (const id of sessionIds) {
			// Gate: refuse to archive if worktree dir + recent JSONL still present.
			// Catches the post-crash bulk-archive bug from goal sessions-p-14dc3ec7.
			const psForGate = this.resolveStoreForId(id)?.get(id);
			if (psForGate && await shouldKeepDespiteOrphan(psForGate)) {
				console.warn(`[orphan-cleanup] WARN: would-archive ${id} but worktree+recent-transcript present — leaving live`);
				continue;
			}
			try {
				const didTerminate = await this.terminateSession(id);
				if (didTerminate) {
					terminated++;
				} else {
					// Session not in memory — try direct archive (cascade-reap children first)
					try {
						const ps = this.resolveStoreForId(id)?.get(id);
						if (ps) {
							await this.archiveWithCascade(id, this.getSessionStore(ps.projectId));
							terminated++;
						}
					} catch { /* project gone */ }
				}
			} catch (err) {
				console.warn(`[session-manager] Failed to terminate orphan ${id}:`, err);
				// Try direct archive as fallback (cascade-reap children first)
				try {
					const ps = this.resolveStoreForId(id)?.get(id);
					if (ps) {
						await this.archiveWithCascade(id, this.getSessionStore(ps.projectId));
						terminated++;
					}
				} catch { /* project gone */ }
			}
		}
		return terminated;
	}

	/**
	 * Get statistics about expired archives (past 7-day retention).
	 */
	async getExpiredArchiveStats(): Promise<{ count: number; totalSizeBytes: number }> {
		const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
		const cutoff = this.clock.now() - SEVEN_DAYS_MS;
		const archived = this.projectContextManager
			? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: (this._testStore?.getArchived() ?? []);
		const expired = archived.filter(ps => ps.archivedAt && ps.archivedAt < cutoff);
		const sizes = await mapWithConcurrency(expired, BACKGROUND_IO_CONCURRENCY, async (ps) => {
			if (!ps.agentSessionFile) return 0;
			try {
				return (await this.archiveStat(ps.agentSessionFile)).size;
			} catch {
				return 0;
			}
		});
		return {
			count: expired.length,
			totalSizeBytes: sizes.reduce((total, size) => total + size, 0),
		};
	}

	/** Start the archive purge schedule — call after restoreSessions(). */
	startPurgeSchedule(): void {
		if (this.purgeInterval !== null) return;
		// No longer purge on startup — use Settings → Maintenance to purge manually.
		// Purge every 24 hours. A stale queued callback observes the handle mismatch
		// after stop and cannot start cleanup during shutdown.
		let timer!: ReturnType<typeof setInterval>;
		timer = this.clock.setInterval(() => {
			if (this.purgeInterval !== timer) return;
			void this.purgeExpiredArchives().catch(err => {
				console.error("[session-manager] Scheduled purge failed:", err);
			});
		}, 24 * 60 * 60 * 1000);
		this.purgeInterval = timer;
		(this.purgeInterval as any).unref?.();
	}

	/** Cancel future archive-purge ticks and join cleanup already in progress. */
	async stopPurgeSchedule(): Promise<void> {
		if (this.purgeInterval !== null) {
			this.clock.clearInterval(this.purgeInterval);
			this.purgeInterval = null;
		}
		const inFlight = this.archivePurgeInFlight;
		if (inFlight) await inFlight;

		// Immediate DELETE purges share the same per-session owners but are not
		// necessarily part of the expiry sweep. Join them as an awaited shutdown
		// barrier without starting more work or changing per-item error ownership.
		while (this.sessionPurgesInFlight.size > 0) {
			const pending = this.sessionPurgesInFlight.values().next().value as Promise<void> | undefined;
			if (!pending) break;
			try { await pending; } catch { /* the initiating request owns the error */ }
		}
	}

	addClient(sessionId: string, ws: WebSocket): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;

		// If session is dormant (failed restore), try to revive it. A poisoned-history
		// rollback is different: its fenced SessionInfo is the only process-local
		// capsule for retry intent, prompt envelopes, grants, clients, and the prior
		// event frame of reference. A reconnect is not user intent to retry, so keep
		// that capsule attached and let the next explicit Retry/follow-up use the
		// poison-aware in-place respawn (including the sandbox fail-closed guard).
		if (session.status === "terminated" && session.condition?.code !== "MODEL_SELECTION_REQUIRED") {
			const poisonedRollback = isOrphanToolResultOrderingError(session.lastTurnErrorMessage);
			if (!poisonedRollback) {
				const ps = this.resolveStoreForId(sessionId)?.get(sessionId);
				if (ps && ps.agentSessionFile) {
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
			} else {
				console.log(`[session-manager] Client reconnected to poisoned-history rollback session=${sessionId}; awaiting Retry/follow-up`);
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
		session.staffNotificationTurnContext = undefined;
		broadcastStatus(session, "aborting");
		try { await session.rpcClient.abort(); } catch { /* best-effort */ }
	}

	async forceAbort(id: string, gracePeriodMs = 3000): Promise<void> {
		this.assertSessionGoalPromotionMutationAllowed(id);
		const coordinator = this._sessionReplacementCoordinators.get(id);
		const session = this.sessions.get(id);
		if (!session && !coordinator) return;

		const eligible = !!coordinator || !!session && (session.status === "streaming" || session.isCompacting);
		// Stop admission is the ambiguity boundary. Persist and project every
		// unresolved modern attempt before replacement ownership or abort RPC can
		// produce a terminal event. Exact late starts settle the same ledger
		// occurrence; only authoritative replacement replay may prove no start.
		if (eligible && session && this._markModernInFlightAttemptsUncertain(session)) {
			this.broadcastQueue(session);
		}

		// A Stop accepted while restore has removed SessionInfo is still a real
		// cancellation. Mark it synchronously so the active host/sandbox restore
		// disposes its staged bridge before commit, then serialize the public call
		// behind that owner. This mirrors terminate's map-gap join without allowing
		// poison redrive or queue drain after Stop.
		// Stop is sticky for the entire coordinator lifetime, regardless of which
		// replacement is currently active. In particular, an assignRole/restart
		// already queued behind recovery must observe this before it starts.
		if (coordinator) coordinator.terminalRequest = "stop";

		// S40: cancel any pending auto-retry timer regardless of streaming state.
		// An abort during the post-error backoff window (status "idle") would
		// otherwise leave the timer to fire a spurious retry on a session someone
		// just stopped (reachable via the team-abort route). No-op when none pending.
		if (session) {
			this.cancelPendingAutoRetry(session, "terminated");
			// An idle Stop cancels the only automatic retry owner. Do not leave
			// durable errored work looking like a healthy idle session.
			if (session.lastTurnErrored && !session.pendingAutoRetryTimer) {
				this.surfaceManualRetryRequired(session);
			}
		}

		// Outside a replacement, an idle abort remains a no-op. During replacement,
		// queue behind the current owner so Stop has deterministic invocation order
		// and can never race a staged bridge commit.
		if (!eligible) return;
		await this._coordinateSessionReplacement(id, "force-abort", (token) =>
			this._forceAbortOwned(id, gracePeriodMs, token), {
				coalesceKey: "force-abort",
				drainOnRelease: true,
			});
	}

	private async _forceAbortOwned(id: string, gracePeriodMs: number, token: SessionReplacementToken): Promise<void> {
		const session = this.sessions.get(id);
		if (!session) return;
		// Stop may cancel a staged role while its untouched canonical bridge is
		// nominally starting or was transiently marked streaming by queued ownership.
		// The active replacement token proves Stop is cancelling staging, not an old
		// bridge turn; restore that canonical bridge to idle without aborting it.
		if (token.coordinator.terminalRequest === "stop"
			&& token.coordinator.promptOwner === session
			&& token.coordinator.active?.kind === "force-abort"
			&& !session.lifecycleFenced
			&& session.rpcClient.running !== false
			&& session.streamingStartedAt === undefined) {
			// The queued Stop joined an assignRole owner that requested a release
			// drain. Cancelling staging must also cancel that sticky drain request or
			// the untouched old bridge immediately starts the queued next turn.
			token.coordinator.drainOnRelease = false;
			broadcastStatus(session, "idle");
			return;
		}
		if (session.status !== "streaming" && !session.isCompacting) return;
		if (!this._replacementTokenIsCurrent(id, token)) {
			throw new Error(`Session ${id} force-abort was superseded before start`);
		}
		// Abort permanently severs any notification-turn causal authority.
		session.staffNotificationTurnContext = undefined;
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
		const deferredTerminalEvents: any[] = [];
		const settledPromise = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
		const settleTimer = this.clock.setTimeout(() => {
			unsubSettle();
			resolveSettled(false);
		}, gracePeriodMs);
		const unsubSettle = session.rpcClient.onEvent((event: any) => {
			// The canonical listener is lifecycle-fenced while Stop owns the shared
			// coordinator. Preserve its terminal sequence and replay bookkeeping once
			// after graceful settlement; this listener never broadcasts the events.
			if (event.type === "message_end"
				|| event.type === "compaction_end"
				|| event.type === "auto_compaction_end") {
				deferredTerminalEvents.push(event);
			}
			// agent_end is only user-visible terminal output. Pi still owns finishRun,
			// automatic compaction, and queued continuation work until agent_settled.
			// Ending the grace race at agent_end recreates the busy prompt race when
			// coordinator release drains against that still-active run.
			if (event.type === "agent_end" && event.willRetry !== true) {
				deferredTerminalEvents.push(event);
			}
			if (event.type === "agent_settled") {
				deferredTerminalEvents.push(event);
				this.clock.clearTimeout(settleTimer);
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

		// Ask for the transcript path opportunistically while the grace timer is
		// already running. A wedged bridge commonly blocks every RPC, not only
		// abort(). Never await this snapshot after the grace boundary: doing so
		// would leave the session visibly "aborting" and postpone stop() until the
		// bridge command timeout. The durable store remains the fallback when this
		// best-effort request does not settle in time.
		let stateBeforeKill: any;
		void (async () => {
			try { stateBeforeKill = await session.rpcClient.getState(); } catch { /* use durable path */ }
		})();

		const settled = await settledPromise;

		if (settled) {
			// The shared replacement fence suppressed the canonical listener. Replay
			// the captured message_end/agent_end sequence through the same lifecycle
			// bookkeeping exactly once. Queue draining is deferred to coordinator
			// release so a graceful Stop cannot double-dispatch.
			for (const event of deferredTerminalEvents) {
				this.handleAgentLifecycle(session, event, {
					replacementOwnedTerminal: true,
					deferQueueDrain: true,
				});
			}
			return;
		}

		// Graceful abort didn't work — force kill and restart the agent
		console.log(`[session-manager] Force-aborting session ${id} — killing agent process`);

		// Prefer an agent-reported transcript path when the best-effort snapshot
		// completed during the grace period. Otherwise retain the durable path and
		// kill immediately; recovery must never wait on the bridge being replaced.
		// Paths remain in the agent's coordinate system — no translation needed.
		const persistedBeforeAbort = this.resolveStoreForSession(id).get(id);
		const adoptedExpectedContainerId = persistedBeforeAbort && this.isCanonicalAdoptedWorkspaceOwner(persistedBeforeAbort)
			? persistedBeforeAbort.containerId?.trim()
			: undefined;
		if (persistedBeforeAbort && this.isCanonicalAdoptedWorkspaceOwner(persistedBeforeAbort) && !adoptedExpectedContainerId) {
			throw new Error(`Cannot force-abort promoted session ${id}: durable sandbox container identity is missing`);
		}
		let agentSessionFile = persistedBeforeAbort?.agentSessionFile;
		if (stateBeforeKill?.success && stateBeforeKill.data?.sessionFile) {
			agentSessionFile = stateBeforeKill.data.sessionFile;
		}

		// Kill the process. Force-abort reuses this SessionInfo for the replacement,
		// so cancel old-bridge activity transactions before stop can resolve a stale
		// prompt acknowledgement against the still-canonical object.
		cancelPendingSessionPromptActivity(session);
		session.unsubscribe();
		await session.rpcClient.stop();

		// Keep the in-flight steer ledger intact until the replacement has replayed
		// durable history. A message_end may have reached the transcript immediately
		// before the hard kill even though the old live listener never observed it.
		// The staged switch listener consumes only proven echoes; anything still
		// unresolved is re-enqueued after replay (or on replacement failure).

		// A hard kill during compaction cannot emit its end event. Finalize that
		// active epoch as aborted before terminal bookkeeping so isCompacting cannot
		// permanently fence the durable queue on coordinator release.
		if (session.isCompacting) {
			const syntheticCompactionEnd = {
				type: "compaction_end",
				reason: session._reliableCompactionReason ?? "threshold",
				compactionId: session._reliableCompactionId,
				aborted: true,
				success: false,
				error: "compaction interrupted by Stop",
			};
			this.handleAgentLifecycle(session, syntheticCompactionEnd, {
				replacementOwnedTerminal: true,
				deferQueueDrain: true,
			});
			emitSessionEvent(session, syntheticCompactionEnd);
		}

		// Hard kill cannot emit Pi's terminal lifecycle event. Run the exact same
		// canonical terminal bookkeeping once before deriving the replacement
		// allowlist: revoke one-turn grants, count/notify the completed turn, settle
		// idle waiters, clear streaming/error state, and persist wasStreaming=false.
		// Queue draining remains owned by the coordinator's final release.
		this.handleAgentLifecycle(session, { type: "agent_end", messages: [] }, {
			replacementOwnedTerminal: true,
			deferQueueDrain: true,
			abortAttemptOutcome: "ambiguous",
		});

		// Emit agent_end so clients know streaming stopped.
		// WP4/RC3: route through emitSessionEvent so a client that resumes after a
		// force-abort replays the agent_end (and clears its stale streaming partial)
		// instead of relying on a later snapshot tick.
		emitSessionEvent(session, { type: "agent_end", messages: [] });

		// Restart the agent process
		try {
			if (!this._replacementTokenIsCurrent(id, token)) {
				throw new Error(`Session ${id} force-abort recovery was superseded before replacement start`);
			}
			const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
			if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
			if (this.systemPromptPath) bridgeOptions.systemPromptPath = this.systemPromptPath;
			// Prepare the cold replacement's scoped catalogue before any later
			// allowlist/tag/guard calculation and reuse one Pi discovery snapshot.
			const forceAbortToolRuntime = this.prepareScopedToolRuntime(session.projectId, session.cwd);
			if (forceAbortToolRuntime.toolManager) bridgeOptions.toolManager = forceAbortToolRuntime.toolManager;
			bridgeOptions.env = {
				BOBBIT_SESSION_ID: id,
				BOBBIT_SESSION_SECRET: this.sessionSecretStore.getOrCreateSecret(id),
			};

			// Force-abort recovery must preserve the original filesystem realm. A
			// sandbox transcript uses container coordinates; downgrading the replacement
			// to a host bridge makes the later existence check miss that transcript and
			// can drain queued intent against empty history. Fail closed instead, leaving
			// the durable sandbox flag/path intact for a later recovery attempt.
			if (session.sandboxed) {
				const sandboxApplied = await this.applySandboxWiring(bridgeOptions, id, {
					projectId: session.projectId,
					goalId: session.goalId ?? session.teamGoalId,
					expectedExistingContainerId: adoptedExpectedContainerId,
				});
				if (!sandboxApplied) {
					throw new Error(`Cannot recover sandboxed session ${id}: sandbox realm is unavailable`);
				}
			} else {
				this.applyScopedGatewayCredentials(bridgeOptions, id, session.projectId, session.goalId ?? session.teamGoalId);
			}

			// Restore goal extension
			if (session.goalId) {
				bridgeOptions.env.BOBBIT_GOAL_ID = session.goalId;
				const isTeamLead = session.role === "team-lead";
				if (isTeamLead) {
					bridgeOptions.args = ["--extension", this.getTeamLeadExtensionPath(session.projectId), "--extension", this.getGoalToolsExtensionPath(session.projectId)];
				} else {
					bridgeOptions.args = ["--extension", this.getGoalToolsExtensionPath(session.projectId)];
				}
			}

			// Restore proposal tools extension for assistant sessions
			if (session.assistantType) {
				bridgeOptions.args = bridgeOptions.args || [];
				const proposalExtPath = this.getProposalToolsExtensionPath(session.projectId);
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
			// Terminal bookkeeping above has just revoked one-turn grants from the
			// canonical live allowlist. Prefer that post-terminal value so a stale
			// persisted snapshot cannot re-grant a spent capability on replacement.
			const forceAbortAllowedNames = session.allowedTools ?? forceAbortPersisted?.allowedTools;
			const effective: EffectiveTool[] = Array.isArray(forceAbortAllowedNames)
				? tagAllowedTools(forceAbortAllowedNames, forceAbortToolRuntime.toolManager, forceAbortToolRuntime.toolScope)
				: this.resolveEffectiveAllowedTools(role, session.projectId, session.cwd, forceAbortToolRuntime);
			// Preserve the unrestricted (`undefined`) vs explicit-empty (`[]`)
			// distinction. A persisted `[]` means NO tools and MUST stay `[]` — never
			// collapse it to `undefined`, which would re-grant every tool. Only a
			// genuinely unrestricted resolution (role-less ⇒ resolves to `[]`)
			// collapses to `undefined` (all tools), preserving today's behaviour.
			const forceAbortAllowed: EffectiveTool[] | undefined = Array.isArray(forceAbortAllowedNames)
				? effective
				: (effective.length > 0 ? effective : undefined);
			await this.ensureMcpManagerForContext(session.projectId, session.cwd);
			const forceActivation = this.buildToolActivationArgs(id, forceAbortAllowed, role, session.cwd, session.projectId, session.goalId ?? session.teamGoalId, session.sessionOnlyGrantedTools, session.sandboxed === true, forceAbortToolRuntime);
			bridgeOptions.args = [...forceActivation.args, ...(bridgeOptions.args || [])];
			bridgeOptions.piExtensions = [...(bridgeOptions.piExtensions ?? []), ...forceActivation.runtimeExtensions];
			bridgeOptions.env = { ...(bridgeOptions.env || {}), ...forceActivation.env };

			// Pin model/thinking-level at spawn for the force-abort respawn.
			const forceRespawnPersisted = this.resolveStoreForSession(id).get(id);
			const forceRespawnPersistedModel =
				forceRespawnPersisted?.modelProvider && forceRespawnPersisted?.modelId
					? normalizeAigwModelString(`${forceRespawnPersisted.modelProvider}/${forceRespawnPersisted.modelId}`)
					: undefined;
			const forceInitialModel = this.resolveInitialModel(session.role, session.projectId);
			const forceDefaultModel = this.resolveInitialModel(undefined, session.projectId);
			const rawForceRoleModel = session.role
				? this.resolveRoleModelValue(session.role, session.projectId)
				: undefined;
			const rawForceDefaultModel = this.preferencesStore?.get("default.sessionModel") as string | undefined;
			const exactForceReplacementModel = forceRespawnPersistedModel
				?? rawForceRoleModel
				?? rawForceDefaultModel;
			bridgeOptions.initialModel = exactForceReplacementModel
				? await this.requireCurrentCatalogSpawnModel(exactForceReplacementModel)
				: await this.resolveCurrentCatalogSpawnModel([
					forceInitialModel,
					forceDefaultModel,
				]);
			const forceRespawnHasDurableTuple = !!(
				forceRespawnPersistedModel
				&& isKnownThinkingLevel(forceRespawnPersisted?.effectiveThinkingLevel)
			);
			const initThinking = forceRespawnHasDurableTuple
				? await this.resolveCurrentCatalogPreferredThinkingLevel(
					bridgeOptions.initialModel,
					session.role,
					session.projectId,
					forceRespawnPersisted?.effectiveThinkingLevel,
				)
				: await this.resolveCurrentCatalogThinkingLevel(
					bridgeOptions.initialModel,
					session.role,
					session.projectId,
					forceRespawnPersisted?.effectiveThinkingLevel,
				);
			if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;
			const forceSpawnProvider = bridgeOptions.initialModel?.slice(0, bridgeOptions.initialModel.indexOf("/"));
			await this.applyDirectProviderEnv(bridgeOptions, !!session.sandboxed, forceSpawnProvider);
			await this.finalizeSpawnOptions(bridgeOptions, {
				model: exactForceReplacementModel ?? bridgeOptions.initialModel,
				thinkingLevel: forceRespawnPersisted?.effectiveThinkingLevel ?? bridgeOptions.initialThinkingLevel,
				role: session.role,
				projectId: session.projectId,
			});

			const rpcClient = new RpcBridge(bridgeOptions);
			let switchingSession = true;
			let replayingSession = false;
			const unsub = rpcClient.onEvent((event: any) => {
				// Keep staged startup/replay invisible. During replay, prepare only for
				// occurrence-aware steer reconciliation; skip all normal event side effects.
				if (switchingSession) {
					if (replayingSession) {
						const preparedEvent = this.prepareVisibleAgentEvent(session, event);
						this._consumeSteerEcho(session, preparedEvent);
					}
					return;
				}
				const preparedEvent = this.prepareVisibleAgentEvent(session, event);
				recordSessionEventActivity(session, preparedEvent);
				this.handleAgentLifecycle(session, preparedEvent);
				this.emitAgentEvent(session, preparedEvent);
				this.trackCostFromEvent(session, preparedEvent);
			});

			bridgeOptions.onPiExtensionDiagnostic = (diagnostic, extension) => this.recordPiExtensionDiagnostic(session, diagnostic, extension);
			try {
				await rpcClient.start();
			} catch (err) {
				unsub();
				await rpcClient.stop().catch(() => {});
				throw err;
			}

			// Resume session if we have the session file. Never install or drain a
			// replacement process unless it accepted the sanitized durable history.
			const abortPs = { ...forceRespawnPersisted, ...session, agentSessionFile } as PersistedSession;
			const abortFileCtx = sessionFsContextForAgentFile(abortPs, agentSessionFile);
			try {
				if (agentSessionFile) {
					if (!await sessionFileExists(abortFileCtx, agentSessionFile, this.sandboxManager)) {
						throw new Error(`Cannot recover force-aborted session ${id}: persisted conversation history is unavailable`);
					}
					// Hydrate immediately before switch_session so settled keyless occurrences
					// guard newer same-text dispatches for exactly the replay window. Startup
					// frames remain staged but cannot consume the steer ledger by text.
					const settledSteersPruned = restorePromptAuthorBindings(session, readAuthorSidecar(id));
					if (settledSteersPruned > 0) this.persistInFlightSteerLedger(session);
					replayingSession = true;
					try {
						await this.switchSessionForRehydration(rpcClient, abortPs, agentSessionFile);
					} finally {
						replayingSession = false;
						// Restore-only keyless guards must not shadow future live prompts.
						session.promptAuthorReplayBindings = undefined;
						session.lastKeylessPromptAuthorEnd = undefined;
					}
				}
			} catch (err) {
				switchingSession = false;
				unsub();
				await rpcClient.stop().catch(() => {});
				throw err;
			}
			// Preserve the pre-abort activity timestamp across any late replay.
			suppressSessionActivityUntilPrompt(session);

			// Replay completed: remaining attempts have proven no correlated start.
			// Coordinator release owns their one exact redispatch.
			this._reconcileAfterAbort(session, { outcome: "proven-no-start" });
			if (!this._replacementTokenIsCurrent(id, token) || this.sessions.get(id) !== session) {
				unsub();
				await rpcClient.stop().catch(() => {});
				throw new Error(`Session ${id} force-abort replacement was superseded after rehydration`);
			}

			// Model verification belongs to the candidate runtime. Keep its bridge and
			// Pi schema snapshot off the canonical SessionInfo until every fallible
			// verification and ownership check succeeds.
			const candidateRuntimePiExtensions = bridgeOptions.piExtensions;
			const stagedSession = {
				...session,
				rpcClient,
				runtimePiExtensions: candidateRuntimePiExtensions,
				unsubscribe: unsub,
				spawnPinnedModel: bridgeOptions.initialModel,
				spawnPinnedThinkingLevel: bridgeOptions.initialThinkingLevel,
				_deferVerifiedTupleCommit: true,
				clients: new Set<WebSocket>(),
			} as SessionInfo;
			let verifiedReplacementTuple: VerifiedSessionModelTuple | undefined;
			try {
				verifiedReplacementTuple = await this.tryAutoSelectModel(stagedSession);
				if (!verifiedReplacementTuple) {
					try {
						verifiedReplacementTuple = await this.tryApplyDefaultThinkingLevel(stagedSession);
					} catch (err) {
						if (forceRespawnPersisted?.effectiveThinkingLevel !== undefined) throw err;
						console.warn(`[session-manager] Legacy session ${id} could not verify effective thinking during force-abort recovery:`, err);
					}
				}
			} catch (err) {
				unsub();
				await rpcClient.stop().catch(() => {});
				throw err;
			}
			if (!this._replacementTokenIsCurrent(id, token) || this.sessions.get(id) !== session) {
				unsub();
				await rpcClient.stop().catch(() => {});
				throw new Error(`Session ${id} force-abort replacement was superseded during model verification`);
			}

			// Publish bridge identity and its schema snapshot together only after the
			// candidate is complete and still owns the replacement token.
			session.rpcClient = rpcClient;
			session.runtimePiExtensions = candidateRuntimePiExtensions;
			session.unsubscribe = unsub;
			session.spawnPinnedModel = verifiedReplacementTuple
				? `${verifiedReplacementTuple.provider}/${verifiedReplacementTuple.modelId}`
				: bridgeOptions.initialModel;
			session.spawnPinnedThinkingLevel = verifiedReplacementTuple?.thinkingLevel
				?? bridgeOptions.initialThinkingLevel;
			if (verifiedReplacementTuple) {
				this.persistSessionModel(
					id,
					verifiedReplacementTuple.provider,
					verifiedReplacementTuple.modelId,
					verifiedReplacementTuple.thinkingLevel,
				);
				this._writeModelNameFile(id, `${verifiedReplacementTuple.provider}/${verifiedReplacementTuple.modelId}`);
			}
			switchingSession = false;

			broadcastStatus(session, "idle");
			console.log(`[session-manager] Session ${id} agent restarted after force abort`);

			// Fresh retry budget — the old process (and its busy guard) is gone.
			// The shared coordinator performs the one queue drain after every queued
			// lifecycle replacement has settled, never against an intermediate bridge.
			session.recoverDrainAttempts = 0;
		} catch (err) {
			// Without a complete closed-generation replay, neither delivery nor
			// non-delivery is proven. Preserve the durable uncertain carrier and forbid
			// automatic replay; explicit dismissal remains available through removeQueued.
			this._markModernInFlightAttemptsUncertain(session);
			this.broadcastQueue(session);
			session.promptAuthorReplayBindings = undefined;
			session.lastKeylessPromptAuthorEnd = undefined;
			console.error(`[session-manager] Failed to restart agent after force abort:`, err);
			broadcastStatus(session, "terminated");
			// The old bridge is dead and no verified replacement exists. Keep the
			// terminated capsule authoritative, but let API/WS/orchestration callers
			// report the actionable recovery failure instead of claiming Stop recovered.
			throw err;
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
		await this.stopPurgeSchedule();
		if (this._statusHeartbeatTimer) {
			this.clock.clearInterval(this._statusHeartbeatTimer);
			this._statusHeartbeatTimer = null;
		}

		// Don't remove from store on shutdown — sessions should survive restart.
		// Persist the active/busy state for each session so interrupted agents
		// can be re-driven on the next startup. The durable field is still named
		// `wasStreaming` for store compatibility, but it means "restart re-drive
		// needed" for every non-idle, non-terminal session status.
		const ids = Array.from(this.sessions.keys());
		for (const id of ids) {
			const session = this.sessions.get(id);
			if (!session) continue;

			this.clearToolCallProvenance(session);
			await this.closeExtensionChannelsForSession(id, "gateway-shutdown");

			// Snapshot the current active state before we kill the process.
			// This is authoritative — the in-memory status is always correct,
			// and we write it here to handle the case where shutdown() races
			// with a pending lifecycle event that hasn't flushed to disk yet.
			const needsRestartRedrive = sessionNeedsRestartRedrive(session);
			const store = this.resolveExistingStoreForShutdown(session);
			if (store) {
				store.update(id, {
					wasStreaming: needsRestartRedrive,
					streamingStartedAt: needsRestartRedrive ? (session.streamingStartedAt ?? this.clock.now()) : undefined,
				});
			}

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
			this._taskIdCache.delete(id);
		}
		this._taskIdCache.clear();

		// Persist the trailing debounced cost window before contexts are closed.
		// `flush()` is idempotent, so ProjectContext.close() may safely repeat it.
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				try {
					ctx.costTracker.flush();
				} catch (err) {
					console.error(`[session-manager] Failed to flush cost tracker for project ${ctx.project.id}:`, err);
				}
			}
		} else {
			try { this._testCostTracker?.flush(); }
			catch (err) { console.error("[session-manager] Failed to flush test cost tracker:", err); }
		}

		// Flush any debounced store writes before exit
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				try { await ctx.sessionStore.flush(); }
				catch (err) { console.error(`[session-manager] Failed to flush session store for project ${ctx.project.id}:`, err); }
			}
		} else if (this._testStore) {
			try { await this._testStore.flush(); }
			catch (err) { console.error("[session-manager] Failed to flush test session store:", err); }
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

		if (!this.projectContextManager) {
			const stores = [this._testGoalStore, this._testTaskStore].filter(
				(store): store is GoalStore | TaskStore => store !== null,
			);
			const results = await Promise.allSettled(stores.map((store) => store.close()));
			for (const result of results) {
				if (result.status === "rejected") {
					console.error("[session-manager] Failed to close test fallback store:", result.reason);
				}
			}
		}
	}
}

// ── Sandbox credential auto-resolution ─────────────────────────────

import { ensureSandboxAgentAuthFile, fallbackProviderAllowlistFromPrefs, hasExplicitSandboxAnthropicCredential, mergeHostAgentProviderEnv, recoverAnthropicApiKeyRuntime, refreshSandboxAnthropicOAuthCredential, resolveHostTokenValue, resolveSandboxAgentAuthPolicy, sandboxTokenPolicyAllowsAnthropicAuth, withSandboxAgentAuthFileLock, type HostTokenResolutionOptions } from "./host-tokens.js";

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
export function resolveSandboxTokens(
	prefs?: import("./preferences-store.js").PreferencesStore | null,
	projectConfig?: import("./project-config-store.js").ProjectConfigStore | null,
	secretsStore?: import("./secrets-store.js").SecretsStore | null,
	commandRunner: CommandRunner = realCommandRunner,
	hostTokenOptions?: HostTokenResolutionOptions,
): Record<string, string> {
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
				const resolved = resolveHostTokenValue(entry.key, prefs, commandRunner, hostTokenOptions);
				if (resolved) {
					result[entry.key] = resolved;
				}
			}
		}
		return result;
	}

	// ── Legacy fallback: sandbox_tokens not set ──
	return resolveLegacySandboxCredentials(prefs, projectConfig, commandRunner, hostTokenOptions);
}

/**
 * Legacy credential resolution from sandbox_credentials + sandbox_host_token_overrides + sandbox_github_token.
 * Used as fallback when sandbox_tokens is not configured.
 */
export function resolveLegacySandboxCredentials(
	prefs?: import("./preferences-store.js").PreferencesStore | null,
	projectConfig?: import("./project-config-store.js").ProjectConfigStore | null,
	commandRunner: CommandRunner = realCommandRunner,
	hostTokenOptions?: HostTokenResolutionOptions,
): Record<string, string> {
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
		const allowStoredAnthropicOAuth = hostTokenOptions?.allowStoredAnthropicOAuth === true;
		const hostEnvVal = provider === "anthropic"
			? process.env["ANTHROPIC_API_KEY"] || (allowStoredAnthropicOAuth ? process.env[envVar] : undefined)
			: process.env[envVar];
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
			const credential = authData[provider];
			if (provider === "anthropic" && credential?.type === "oauth") {
				if (hostTokenOptions?.allowStoredAnthropicOAuth !== true) continue;
				const resolved = resolveHostTokenValue(envVar, prefs, commandRunner, hostTokenOptions);
				if (resolved) result[envVar] = resolved;
				continue;
			}
			const key = extractKey(credential);
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
				if (!commandRunner.execFileSync) throw new Error("CommandRunner does not support execFileSync");
				const token = String(commandRunner.execFileSync("gh", ["auth", "token"], { timeout: 5_000, encoding: "utf-8" })).trim();
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
