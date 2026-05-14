import { execFile as execFileCb, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import type { ServerMessage, QueuedMessage } from "../ws/protocol.js";
import { EventBuffer } from "./event-buffer.js";
import { GoalManager } from "./goal-manager.js";
import { TaskManager } from "./task-manager.js";
import { PromptQueue } from "./prompt-queue.js";
import { SearchService } from "../search/search-service.js";
import { RpcBridge, type RpcBridgeOptions } from "./rpc-bridge.js";
import { sessionFileExists, sessionFileRead, sessionFileDelete, type SessionFsContext } from "./session-fs.js";
import type { SkillExpansion } from "../skills/resolve-skill-expansions.js";
import { appendSkillSidecarEntry } from "../skills/skill-sidecar.js";
import {
	appendCompactionSidecarEntry,
	makeCompactionId,
	mergeCompactionSidecarIntoMessages,
} from "./compaction-sidecar.js";
import { SessionStore, type PersistedSession } from "./session-store.js";
import { shouldKeepDespiteOrphan, scanOrphanedTranscripts } from "./orphan-cleanup.js";
import { getAssistantDef } from "./assistant-registry.js";
import { buildReattemptContext } from "./goal-assistant.js";
import { assembleSystemPrompt, cleanupSessionPrompt, persistPromptSections, purgePromptSectionsJson, type PromptParts } from "./system-prompt.js";
import { profile } from "./profiling.js";
import { generateSessionTitle, generateGoalSummaryTitle } from "./title-generator.js";
import { CostTracker } from "./cost-tracker.js";
import type { ColorStore } from "./color-store.js";
import type { RoleManager } from "./role-manager.js";
import type { ToolManager } from "./tool-manager.js";
import { computeToolActivationArgs, writeMcpProxyExtensions, writeToolGuardExtension, computeEffectiveAllowedTools, tagAllowedTool, type EffectiveTool } from "./tool-activation.js";
import { discoverSlashSkills } from "../skills/slash-skills.js";
import { shouldSkipRemotePush, detectPrimaryBranch } from "../skills/git.js";
import { eagerDeleteRemoteSessionBranch } from "./session-eager-branch-delete.js";
import type { GrantPolicy } from "./role-store.js";
import { applyModelString } from "./review-model-override.js";
import type { ToolGroupPolicyStore } from "./tool-group-policy-store.js";
import { decideOverflowAction } from "../ws-overflow-guard.js";

import { McpManager } from "../mcp/mcp-manager.js";
import { isTransientReviewError } from "./verification-logic.js";
import { truncateLargeToolContent, truncateLargeToolContentInMessages } from "./truncate-large-content.js";
import { getAigwUrl, discoverAigwModels, deriveName, inferMeta } from "./aigw-manager.js";
import { defaultImageModelPref, getAvailableImageModels, parseImageModelPref } from "./image-generation.js";
import { modelRecencyRank } from "./model-registry.js";
import { clampThinkingLevel, isKnownThinkingLevel } from "../../shared/thinking-levels.js";
import { buildAvailableRolesList } from "./team-manager.js";
// createWorktree is used in session-setup.ts pipeline
import { ProjectContextManager } from "./project-context-manager.js";
import { GoalStore, type PersistedGoal } from "./goal-store.js";
import { PrStatusStore } from "./pr-status-store.js";
import { TaskStore } from "./task-store.js";
import type { GateStore } from "./gate-store.js";
import { bobbitStateDir, bobbitConfigDir, globalAgentDir, globalAuthPath } from "../bobbit-dir.js";

import type { SandboxManager } from "./sandbox-manager.js";
import { WorktreePool } from "./worktree-pool.js";
import {
	type SessionSetupPlan,
	type PipelineContext,
	executePlan,
	executeWorktreeAsync,
	persistOnce,
	handleSetupFailure,
	sendDelegatePrompt,
	DELEGATE_SPAWN_TIMEOUT_MS,
} from "./session-setup.js";

const execFileAsync = promisify(execFileCb);



export type SessionStatus = "starting" | "preparing" | "idle" | "streaming" | "aborting" | "terminated";

/**
 * Max consecutive errored agent turns before an incoming prompt/steer is
 * parked instead of implicitly unsticking the session. Counter increments on
 * every `message_end` with `stopReason:"error"` and resets on any successful
 * terminal assistant message OR on an explicit `retryLastPrompt` call.
 */
const MAX_CONSECUTIVE_ERROR_TURNS = 3;

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
 * implicitly unsticks a wedged session — orients the model to ignore the
 * incomplete last turn.
 */
function buildErrorRecoveryPrefix(errMsg: string, userText: string): string {
	const snippet = (errMsg || "unknown error").slice(0, 200);
	return `[SYSTEM: previous turn failed with: ${snippet}. Ignore the incomplete last turn and handle the following.]\n\n${userText}`;
}

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
	/** Error message captured when restoreSession() failed; cleared on successful revive. */
	restoreError?: string;
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
	/** True if the last agent turn ended due to a model/API error */
	lastTurnErrored?: boolean;
	/** Error message from the last errored turn (e.g. streaming JSON parse failure) */
	lastTurnErrorMessage?: string;
	/** Number of consecutive auto-retries attempted for transient errors on this turn */
	transientRetryAttempts?: number;
	/** Count of consecutive agent turns that ended with stopReason:"error". Resets on any non-error message_end or explicit retry. */
	consecutiveErrorTurns?: number;
	/** Pending auto-retry timer, so we can cancel it if the session terminates */
	pendingAutoRetryTimer?: ReturnType<typeof setTimeout>;
	/** Whether tool calls were executed during the current/last turn */
	turnHadToolCalls?: boolean;
	/** Timestamp when the current streaming turn started */
	streamingStartedAt?: number;
	/** Number of agent turns that have completed (agent_end fired). Used by
	 * tests to detect that a prompt has actually been processed end-to-end
	 * — polling for `status==idle` alone races with the pre-prompt idle
	 * state, so observability of “a turn finished” needs its own counter. */
	completedTurnCount?: number;
	/** Last user prompt text, for retry on fresh-response errors */
	lastPromptText?: string;
	/** Last user prompt images, for retry on fresh-response errors */
	lastPromptImages?: Array<{ type: "image"; data: string; mimeType: string }>;
	/** Pending grant request from the guard extension's long-poll */
	pendingGrantRequest?: {
		resolve: (result: { granted: boolean; tools?: string[] }) => void;
		reject: (err: Error) => void;
		toolName: string;
		toolGroup: string;
		timer: ReturnType<typeof setTimeout>;
		/** seq/ts of the original `tool_permission_needed` broadcast — replayed
		 * verbatim to late-joining clients so we never burn a fresh global seq
		 * on a unicast frame. See tests/perm-frame-late-joiner-seq-gap.test.ts. */
		seq: number;
		ts: number;
	};
	/** Tools granted via "one-time" mode — revoked on agent_end */
	oneTimeGrantedTools?: string[];
	/** Whether post-start setup (model, thinking, metadata) has completed */
	setupComplete?: boolean;
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
	}>;
	/** Repo path (cached from worktree provisioning). */
	repoPath?: string;
	/** Active branch name. Mirrors the persisted store; stable for the session's lifetime. */
	branch?: string;
	/** Multi-repo: per-repo worktree paths from the pool claim. Stable for the session's lifetime. */
	repoWorktrees?: Array<{ repo: string; repoPath: string; worktreePath: string }>;
	/**
	 * Shadow ledger of steer texts that have been dispatched to the SDK
	 * (`rpcClient.steer()` resolved) but have not yet echoed back as a
	 * user-role `message_end`. This is design §6.1 mitigation B: because
	 * Bobbit cannot extend the upstream pi-coding-agent RPC bridge to
	 * proxy `AgentSession.clearQueue()`, we mirror the SDK's text-match
	 * splice logic at our layer for the abort-reconciliation case only.
	 *
	 * Lifecycle:
	 *   - push: after `await rpcClient.steer(text)` resolves in `_dispatchSteer`.
	 *   - splice: on `message_end(role:user)` whose body matches the front entry,
	 *     mirroring `_processAgentEvent`'s `_steeringMessages.indexOf` removal.
	 *   - drain: in `_reconcileAfterAbort` — re-enqueue at front so the next
	 *     turn redispatches them as a steered batch.
	 *
	 * Bounded growth: every entry has a paired SDK echo or an abort-drain;
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
}

// `spliceInFlightMessage` lives in its own module so unit tests can import
// it without dragging in the full session-manager module graph (which
// transitively pulls flexsearch, pi-coding-agent, etc.). Re-exported here
// for backwards compat with existing call sites.
export { spliceInFlightMessage } from "./splice-inflight-message.js";
import { spliceInFlightMessage } from "./splice-inflight-message.js";

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

function broadcast(clients: Set<WebSocket>, msg: ServerMessage): void {
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
}

// `broadcastStatus()` lives in `./session-status.ts` so unit tests can import
// the pure helper without dragging in the full SessionManager dependency
// graph. Re-exported here for backward compat with existing call sites.
export { broadcastStatus } from "./session-status.js";
import { broadcastStatus } from "./session-status.js";

/** Push a raw event into the session's EventBuffer (assigning seq/ts) and
 *  broadcast the `{type:"event"}` frame to all clients with seq/ts attached.
 *  This is the single emit path for live agent events — every call site that
 *  used to do `eventBuffer.push(ev); broadcast(clients, {type:"event", data:ev})`
 *  must route through here so envelope fields stay consistent.
 *  See docs/design/streaming-dedup-reorder.md §4.2. */
export function emitSessionEvent(session: { clients: Set<WebSocket>; eventBuffer: EventBuffer; pendingSkillExpansions?: Array<{ modelText: string; originalText: string; skillExpansions: SkillExpansion[] }> }, truncated: unknown): void {
	const spliced = spliceSkillExpansionsIntoEvent(session, truncated);
	const entry = session.eventBuffer.push(spliced);
	broadcast(session.clients, { type: "event", data: spliced, seq: entry.seq, ts: entry.ts });
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
	session: { pendingSkillExpansions?: Array<{ modelText: string; originalText: string; skillExpansions: SkillExpansion[] }> },
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
}

export class SessionManager {
	private sessions = new Map<string, SessionInfo>();
	private agentCliPath?: string;
	private systemPromptPath?: string;
	/** @internal Test-only session store (used when no PCM is available). */
	private _testStore: SessionStore | null = null;
	/** @internal Test-only cost tracker (used when no PCM is available). */
	private _testCostTracker: CostTracker | null = null;
	/** @internal Test-only search index (used when no PCM is available). */
	private _testSearchIndex: SearchService | null = null;
	private colorStore?: ColorStore;
	private roleManager?: RoleManager;
	private toolManager?: ToolManager;
	private groupPolicyStore?: ToolGroupPolicyStore;
	private preferencesStore?: import("./preferences-store.js").PreferencesStore;
	private projectConfigStore?: import("./project-config-store.js").ProjectConfigStore;
	private projectContextManager: ProjectContextManager | null = null;
	private prStatusStore: PrStatusStore | null = null;
	private mcpManager: McpManager | null = null;
	private worktreePools: Map<string, WorktreePool> = new Map();
	sandboxManager: SandboxManager | null = null;
	sandboxTokenStore: import("../auth/sandbox-token.js").SandboxTokenStore | null = null;
	configCascade: import("./config-cascade.js").ConfigCascade | null = null;
	lspSupervisor: import("../lsp/supervisor.js").LspSupervisor | null = null;
	private _onPrCreationDetected?: (session: SessionInfo) => void;
	private _verificationHarness?: import("./verification-harness.js").VerificationHarness;
	private _terminationListeners: Array<(sessionId: string, info: { projectId?: string; reason: "terminated" | "archived" | "purged"; cwd?: string; worktreePath?: string; repoWorktrees?: Array<{ worktreePath: string }> }) => void> = [];
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
	/** Cached aigw model discovery result (url → { models, timestamp }) */
	private _aigwModelCache: { url: string; models: Awaited<ReturnType<typeof discoverAigwModels>>; ts: number } | null = null;
	private static AIGW_CACHE_TTL_MS = 60_000; // 1 minute

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

	setSandboxManager(manager: SandboxManager | null): void {
		this.sandboxManager = manager;
	}

	setLspSupervisor(supervisor: import("../lsp/supervisor.js").LspSupervisor): void {
		this.lspSupervisor = supervisor;
	}

	getLspSupervisor(): import("../lsp/supervisor.js").LspSupervisor | null {
		return this.lspSupervisor;
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
				// Verify/repair/recreate worktree if needed
				if (session.cwd?.startsWith("/workspace-wt/")) {
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
							try { this.getSessionStore(session.projectId).archive(session.id); } catch { /* best-effort */ }
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

	/**
	 * Re-broadcast the current `session_status` for every session that has
	 * connected clients, WITHOUT bumping `statusVersion`. Heartbeat. Idempotent
	 * on the client (they ignore frames whose version <= lastStatusVersion).
	 */
	private _emitStatusHeartbeat(): void {
		for (const session of this.sessions.values()) {
			if (session.clients.size === 0) continue;
			if (session.status === "terminated") continue;
			broadcast(session.clients, {
				type: "session_status",
				status: session.status,
				statusVersion: session.statusVersion ?? 0,
				...(session.streamingStartedAt ? { streamingStartedAt: session.streamingStartedAt } : {}),
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
		if (this.projectContextManager) {
			// All store resolution goes through PCM — no default fields needed.
		} else {
			// Non-PCM path: used by test harnesses that don't set up a full
			// ProjectContextManager. Stores are created from the explicit stateDir.
			const stateDir = bobbitStateDir();
			this._testStore = new SessionStore(stateDir);
			this._testCostTracker = new CostTracker(stateDir);
			this._testSearchIndex = new SearchService({ stateDir, projectId: "__test__" });
			this._testGoalManager = new GoalManager(new GoalStore(stateDir));
			this._testTaskManager = new TaskManager(new TaskStore(stateDir));
			// Empty-but-real PR status store for in-process E2E harnesses that
			// construct SessionManager without a full ProjectContextManager but
			// may still hit re-attempt code paths.
			if (!this.prStatusStore) this.prStatusStore = new PrStatusStore(stateDir);
		}

		// Start the status heartbeat. Runs for the lifetime of this manager;
		// `unref()` so unit tests don't hang on process exit.
		this._statusHeartbeatTimer = setInterval(
			() => this._emitStatusHeartbeat(),
			SessionManager.STATUS_HEARTBEAT_INTERVAL_MS,
		);
		(this._statusHeartbeatTimer as any).unref?.();
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

	/** Get the sandbox manager (used by team-manager and verification-harness). */
	getSandboxManager(): SandboxManager | null {
		return this.sandboxManager;
	}

	/** Build a PipelineContext from this manager's fields. Requires projectId when PCM is active. */
	buildPipelineContext(projectId?: string): PipelineContext {
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
		return {
			agentCliPath: this.agentCliPath,
			systemPromptPath: this.systemPromptPath,
			roleManager: this.roleManager ?? null,
			toolManager: this.toolManager ?? null,
			mcpManager: this.mcpManager,
			goalManager: resolvedGoalManager,
			taskManager: resolvedTaskManager,
			projectConfigStore: resolvedProjectConfigStore,
			sandboxManager: this.sandboxManager,
			sandboxTokenStore: this.sandboxTokenStore,
			lspSupervisor: this.lspSupervisor,
			groupPolicyStore: this.groupPolicyStore ?? null,
			configCascade: this.configCascade,
			costTracker: resolvedCostTracker,
			store: resolvedStore,
			searchIndex: resolvedSearchIndex,
			sessions: this.sessions,
			assemblePrompt: (id, parts) => this.assemblePrompt(id, parts),

			applySandboxWiring: (opts, id, sandboxOpts) => this.applySandboxWiring(opts, id, sandboxOpts),
			handleAgentLifecycle: (session, event) => this.handleAgentLifecycle(session, event),
			trackCostFromEvent: (session, event) => this.trackCostFromEvent(session, event),
			broadcast: (clients, msg) => broadcast(clients, msg),
			tryAutoSelectModel: (session) => this.tryAutoSelectModel(session),
			tryApplyDefaultThinkingLevel: (session) => this.tryApplyDefaultThinkingLevel(session),
			buildWorkflowList: (projectId?: string) => this._buildWorkflowList(projectId),
			resolveInitialModel: (role, projectId) => this.resolveInitialModel(role, projectId),
			resolveInitialThinkingLevel: (role, projectId) => this.resolveInitialThinkingLevel(role, projectId),
			persistSessionMetadata: (session) => this.persistSessionMetadata(session),
			prStatusStore: this.prStatusStore!,
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
			await execFileAsync("docker", [
				"network", "create", name,
				"--driver", "bridge",
				"--opt", "com.docker.network.bridge.enable_icc=false",
			], { timeout: 15_000 });
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
		opts?: { projectId?: string; goalId?: string; sandboxBranch?: string; sandboxBaseBranch?: string }
	): Promise<boolean> {
		if (!this.projectConfigStore) return false;
		const sandboxConfig = this.projectConfigStore.get("sandbox") || "none";
		if (sandboxConfig !== "docker") return false;

		// Resolve project ID
		const projectId = opts?.projectId;
		if (!projectId) {
			throw new Error("Sandbox mode requires a projectId");
		}

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

		// Read gateway URL and generate scoped token for the container
		try {
			const gwUrl = fs.readFileSync(path.join(bobbitStateDir(), "gateway-url"), "utf-8").trim();
			bridgeOptions.gatewayUrl = gwUrl;

			// Generate/reuse a scoped sandbox token for the project (not per-session)
			if (this.sandboxTokenStore) {
				const scopedToken = this.sandboxTokenStore.register(projectId);
				this.sandboxTokenStore.addSession(projectId, sessionId);
				if (opts?.goalId) {
					this.sandboxTokenStore.addGoal(projectId, opts.goalId);
				} else if (bridgeOptions.env?.BOBBIT_GOAL_ID) {
					this.sandboxTokenStore.addGoal(projectId, bridgeOptions.env.BOBBIT_GOAL_ID);
				}
				bridgeOptions.gatewayToken = scopedToken;
			} else {
				const adminToken = fs.readFileSync(path.join(bobbitStateDir(), "token"), "utf-8").trim();
				bridgeOptions.gatewayToken = adminToken;
			}
		} catch (err) {
			throw new Error(`Cannot read gateway credentials for sandbox: ${err}`);
		}

		bridgeOptions.sandboxed = true;
		bridgeOptions.containerId = containerId;

		// Create a worktree inside the container when a branch is specified.
		// This is the primary code path for goal agents (team lead + members).
		if (opts?.sandboxBranch) {
			const worktreePath = await sandbox.createWorktree(
				opts.sandboxBranch,
				opts.sandboxBranch,
				opts.sandboxBaseBranch,
			);
			bridgeOptions.cwd = worktreePath;
		} else if (!bridgeOptions.cwd || !bridgeOptions.cwd.startsWith("/")) {
			// Regular (non-goal) sessions default to /workspace
			bridgeOptions.cwd = "/workspace";
		}

		// Resolve sandbox tokens from unified config (with legacy fallback)
		// Get secretsStore from project context if available
		const secretsStore = (opts?.projectId && this.projectContextManager)
			? this.projectContextManager.getOrCreate(opts.projectId)?.secretsStore ?? null
			: null;
		bridgeOptions.sandboxCredentials = resolveSandboxTokens(this.preferencesStore, this.projectConfigStore, secretsStore);

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



	getMcpManager(): McpManager | null {
		return this.mcpManager;
	}

	/**
	 * Initialize the worktree pool for a repo. Pre-creates worktrees in the
	 * background so new sessions can claim one instantly (~0ms) instead of
	 * waiting for `git worktree add` + `npm ci` + `git push` (~10-30s).
	 */
	initWorktreePoolForProject(projectId: string, repoPath: string, componentsResolver?: () => import("./project-config-store.js").Component[], targetSize = 2, worktreeRoot?: string): void {
		if (this.worktreePools.has(projectId)) return;
		const pool = new WorktreePool({ repoPath, targetSize, componentsResolver, worktreeRoot });
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
		const pool = this.worktreePools.get(projectId);
		if (pool) {
			await pool.drain();
			this.worktreePools.delete(projectId);
		}
	}

	async initMcp(cwd: string): Promise<void> {
		try {
			const mgr = new McpManager(cwd, this.projectConfigStore, bobbitStateDir());

			// Register additional projects for multi-project MCP discovery
			if (this.projectContextManager) {
				const additionalProjects = Array.from(this.projectContextManager.all())
					.filter(ctx => ctx.project.rootPath !== cwd)
					.map(ctx => ({ cwd: ctx.project.rootPath, configStore: ctx.projectConfigStore }));
				if (additionalProjects.length > 0) {
					mgr.setAdditionalProjects(additionalProjects);
				}
			}

			await mgr.connectAll();
			this.mcpManager = mgr;

			// Register MCP tools with ToolManager
			if (this.toolManager) {
				const infos = mgr.getToolInfos();
				this.toolManager.registerExternalTools(infos.map(info => ({
					name: info.name,
					description: info.description,
					summary: info.summary ?? info.description,
					group: info.group,
					docs: info.docs,
					provider: { type: 'mcp' as const, server: info.serverName, mcpTool: info.mcpToolName },
				})));
			}
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

	private buildToolActivationArgs(
		sessionId: string,
		allowedTools: EffectiveTool[] | undefined,
		role: { toolPolicies?: Record<string, GrantPolicy> } | undefined,
		cwd: string,
	): { args: string[]; env: Record<string, string> } {
		const flatNames = allowedTools?.map(e => e.name);

		// MCP proxy extensions
		const mcpExtPaths = this.mcpManager
			? writeMcpProxyExtensions(this.mcpManager, flatNames, role, this.toolManager, this.groupPolicyStore)
			: undefined;

		// Builtin + bobbit-extension activation
		const activation = computeToolActivationArgs(allowedTools, this.toolManager, cwd, mcpExtPaths);

		const args = [...activation.args];

		// Compute session-specific grants (tools in allowedTools but not in the role's base allowedTools)
		const roleBaseTools = role && this.toolManager
			? computeEffectiveAllowedTools(this.toolManager, role as import("./role-store.js").Role, this.groupPolicyStore, this.mcpManager ?? undefined)
			: [];
		const roleAllowed = new Set(roleBaseTools.map(t => t.name.toLowerCase()));
		const sessionGrants = (flatNames ?? []).filter(t => !roleAllowed.has(t.toLowerCase()));

		// Tool guard extension for 'ask' policy tools
		const guardPath = this.toolManager
			? writeToolGuardExtension(sessionId, this.toolManager, this.mcpManager ?? undefined, role, this.groupPolicyStore, sessionGrants)
			: undefined;
		if (guardPath) {
			args.push("--extension", guardPath);
		}

		return { args, env: activation.env };
	}

	private resolveSessionRole(roleName?: string, assistantType?: string): import("./role-store.js").Role | undefined {
		if (!this.roleManager) return undefined;
		return this.roleManager.getRole(roleName || (assistantType ? "assistant" : "general"));
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
			parts.skillsCatalog = this.computeSkillsCatalog(parts.allowedTools, parts.projectRoot || parts.cwd, parts.projectConfigStore);
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
	): import("../skills/slash-skills.js").SlashSkill[] | undefined {
		// allowedTools=undefined or empty => no restrictions; include catalog.
		// allowedTools restricted => require activate_skill in the list.
		if (allowedTools && allowedTools.length > 0) {
			const hasActivate = allowedTools.some(t => t.toLowerCase() === "activate_skill");
			if (!hasActivate) return undefined;
		}
		try {
			const all = discoverSlashSkills(discoveryRoot, projectConfigStore);
			// Filter: omit disable-model-invocation and skills with empty descriptions.
			// userInvocable=false skills are already filtered by discoverSlashSkills.
			return all.filter(s => s.disableModelInvocation !== true && (s.description?.trim() || "").length > 0);
		} catch (err) {
			console.warn(`[session-manager] Failed to discover skills for catalog (root=${discoveryRoot}):`, err);
			return undefined;
		}
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
			parts = {
				baseSystemPromptPath: undefined,
				cwd: session.cwd,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: session.allowedTools,
				projectConfigStore: this.projectConfigStore,
			};
		} else {
			const goal = session.goalId ? this.resolveGoal(session.goalId) : undefined;

			let rolePrompt: string | undefined;
			let roleName: string | undefined;
			if (session.role && this.roleManager) {
				const role = this.roleManager.getRole(session.role);
				if (role?.promptTemplate) {
					rolePrompt = role.promptTemplate;
					if (goal?.branch) rolePrompt = rolePrompt.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch);
					rolePrompt = rolePrompt.replace(/\{\{AGENT_ID\}\}/g, `${session.role}-${(session.goalId || session.id).slice(0, 8)}`);
					rolePrompt = rolePrompt.replace(/\{\{AVAILABLE_ROLES\}\}/g, buildAvailableRolesList(this.roleManager));
					roleName = session.role;
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
				allowedTools: session.allowedTools,
				projectConfigStore: this.projectConfigStore,
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
		this.resolveStoreForSession(session.id).update(session.id, { messageQueue: session.promptQueue.toArray() });
	}

	/**
	 * Enqueue a prompt. If the agent is idle and queue was empty,
	 * dispatch immediately. Otherwise add to queue and broadcast.
	 * If the agent is idle but queue has items, enqueue and drain.
	 */
	async enqueuePrompt(sessionId: string, text: string, opts?: {
		images?: Array<{ type: "image"; data: string; mimeType: string }>;
		attachments?: unknown[];
		isSteered?: boolean;
		/** Original text was already expanded into this when sent to the model. */
		modelText?: string;
		/** Resolved slash-skill expansions, in original-text order. UI-only metadata. */
		skillExpansions?: SkillExpansion[];
	}): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		// modelText is what the model sees; text is the user's verbatim input.
		// When no expansions, both are equal and dispatch is byte-equal to today.
		const dispatchText = opts?.modelText ?? text;
		const hasExpansions = !!(opts?.skillExpansions && opts.skillExpansions.length > 0);
		if (hasExpansions) {
			appendSkillSidecarEntry(session.id, {
				ts: Date.now(),
				modelText: dispatchText,
				originalText: text,
				skillExpansions: opts!.skillExpansions!,
			});
			// Stash the envelope so when the agent echoes the user message
			// back via `message_end`, we can splice the original text +
			// chip metadata onto the broadcast event before clients see it.
			if (!session.pendingSkillExpansions) session.pendingSkillExpansions = [];
			session.pendingSkillExpansions.push({
				modelText: dispatchText,
				originalText: text,
				skillExpansions: opts!.skillExpansions!,
			});
		}

		// ERROR STATE GATING: if last turn errored, either implicitly unstick
		// (up to MAX_CONSECUTIVE_ERROR_TURNS) or park the message in the queue.
		if (session.lastTurnErrored) {
			const consec = session.consecutiveErrorTurns ?? 0;
			if (consec >= MAX_CONSECUTIVE_ERROR_TURNS) {
				// Cap reached — park. Human must click Retry (or fix upstream) to drain.
				console.log(
					`[session-manager] Session ${session.id} has ${consec} consecutive errored turns; parking incoming prompt. Human action required (click Retry or fix upstream issue).`
				);
				session.promptQueue.enqueue(dispatchText, {
					images: opts?.images,
					attachments: opts?.attachments,
					isSteered: opts?.isSteered,
				});
				this.broadcastQueue(session);
				return;
			}

			// Implicit unstick — new intent supersedes the failed turn.
			const errSnippet = (session.lastTurnErrorMessage || "").slice(0, 200);
			console.log(
				`[session-manager] Session ${session.id} implicit unstick from enqueuePrompt (consecutiveErrorTurns=${consec}). Error: ${errSnippet}`
			);

			// Cancel any pending auto-retry timer so it doesn't fire a second dispatch.
			if (session.pendingAutoRetryTimer) {
				clearTimeout(session.pendingAutoRetryTimer);
				session.pendingAutoRetryTimer = undefined;
			}

			// Clear error state. Do NOT reset consecutiveErrorTurns — that only
			// resets on a SUCCESSFUL message_end or an explicit retryLastPrompt.
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.turnHadToolCalls = false;
			session.transientRetryAttempts = 0;

			// Dispatch the prefixed new message immediately, ahead of any parked
			// items. After agent_end the normal drainQueue path picks up parked
			// items in FIFO order, unprefixed (since lastTurnErrorMessage is now
			// cleared).
			// Title generation uses the user-visible original text (better UX).
			this.tryGenerateTitleFromPrompt(sessionId, text);
			// Inject the recovery prefix into the model-facing dispatch text.
			const prefixedDispatch = buildErrorRecoveryPrefix(errSnippet, dispatchText);
			session.lastPromptText = prefixedDispatch;
			session.lastPromptImages = opts?.images;
			session.streamingStartedAt = Date.now();
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
			broadcastStatus(session, "streaming", { streamingStartedAt: session.streamingStartedAt });
			await session.rpcClient.prompt(prefixedDispatch, opts?.images);
			return;
		}

		// If agent is idle and queue is empty, dispatch directly
		if (session.status === "idle" && session.promptQueue.isEmpty) {
			this.tryGenerateTitleFromPrompt(sessionId, text);
			session.lastPromptText = dispatchText;
			session.lastPromptImages = opts?.images;
			await session.rpcClient.prompt(dispatchText, opts?.images);
			return;
		}

		// Agent is busy or queue has items — enqueue. Persisted queue holds
		// the dispatch (model-facing) text so drainQueue passes the same
		// expanded text to the agent later. The chip metadata is already
		// in the sidecar/broadcast; the queued row is purely for delivery.
		session.promptQueue.enqueue(dispatchText, {
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
	deliverLiveSteer(sessionId: string, message: string): Promise<unknown> {
		const session = this.sessions.get(sessionId);
		if (!session) return Promise.reject(new Error(`Session ${sessionId} not found`));

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
			return this.enqueuePrompt(sessionId, message, { isSteered: true });
		}

		// Happy path: enqueue then dispatch via the single _dispatchSteer site.
		// _dispatchSteer removes the row from promptQueue *before* awaiting the
		// RPC, so the SDK becomes the sole authority for in-flight steer text.
		const queued = session.promptQueue.enqueue(message, { isSteered: true });
		this.broadcastQueue(session);
		return this._dispatchSteer(session, [queued]);
	}

	/**
	 * Promote a queued message to steered and reorder.
	 * If the agent is streaming, all steered+undispatched messages are
	 * batched and dispatched immediately via rpcClient.steer() so they
	 * are injected at the next tool boundary (PI-10).
	 */
	steerQueued(sessionId: string, messageId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		const ok = session.promptQueue.steer(messageId);
		if (!ok) return false;

		// Steered messages are NOT dispatched immediately on promotion.
		// They accumulate in the queue and are dispatched as a batch at the
		// next tool boundary (PI-10b). This ensures that multiple steers sent
		// during a long tool call are all delivered together, even if they
		// arrive seconds apart. The dispatch is triggered by the tool_result
		// event handler in _handleAgentEvent().
		// If the agent is idle, they'll drain normally via drainQueue.
		//
		// SPECIAL CASE: bash_bg.wait. A wait long-poll has no natural tool
		// boundary — it sits indefinitely until the bg process exits or the
		// wait is aborted. Without intervention, a steer-on-queue while the
		// agent is parked in wait would be deferred for the entire wait
		// duration. Mirror deliverLiveSteer's behaviour: when the session is
		// streaming and there is at least one active wait, abort all waits so
		// the agent unblocks at once. The underlying bg process keeps
		// running; only the wait long-poll is cancelled, which is exactly
		// what the user expects from the Steer button.
		const bg = (this as any).bgProcessManager;
		if (bg && session.status === "streaming") bg.abortAllWaits(session.id);

		this.broadcastQueue(session);
		return true;
	}

	/**
	 * Single dispatch site for steered prompts. Removes rows from promptQueue
	 * *before* awaiting rpcClient.steer() so the SDK becomes the sole
	 * authority for in-flight steer text. On RPC failure, rows are
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
		for (const r of rows) session.promptQueue.remove(r.id);
		this.broadcastQueue(session);

		// Record on the shadow ledger BEFORE the RPC resolves so that an
		// agent_end firing during the await window (e.g. user aborts mid-steer)
		// still sees the in-flight entry and can re-enqueue it via
		// _reconcileAfterAbort. Otherwise the steer text is delivered to the
		// SDK's _steeringMessages but the aborted agent loop never consumes it,
		// and the bobbit server has no record of it to redispatch.
		//
		// On RPC failure we splice this exact entry back out and re-enqueue
		// the rows at front of promptQueue, so the next drain redispatches.
		if (!session.inFlightSteerTexts) session.inFlightSteerTexts = [];
		session.inFlightSteerTexts.push(batchText);
		try {
			const steerResp = await session.rpcClient.steer(batchText);
			if ((steerResp as any)?.success === false) {
				throw new Error((steerResp as any)?.error || "steer rejected");
			}
		} catch (err) {
			// Splice this entry from the ledger — it never reached the SDK so
			// it shouldn't show up as "in-flight" for reconcile.
			const lidx = session.inFlightSteerTexts.lastIndexOf(batchText);
			if (lidx !== -1) session.inFlightSteerTexts.splice(lidx, 1);
			for (const r of [...rows].reverse()) {
				session.promptQueue.enqueueAtFront(r.text, { isSteered: true });
			}
			this.broadcastQueue(session);
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
		if (idx !== -1) ledger.splice(idx, 1);
	}

	/**
	 * Drain the shadow ledger and re-enqueue any unresolved steers at the
	 * front of promptQueue as steered rows. Called from agent_end while
	 * `wasAborting`, and from `forceAbort` after killing the bridge — both
	 * cases where a steer the SDK accepted may never echo because the turn
	 * was torn down. The next drainQueue picks the rows up as a steered
	 * batch via `_dispatchSteer`, redispatching exactly once.
	 */
	private _reconcileAfterAbort(session: SessionInfo): void {
		const ledger = session.inFlightSteerTexts;
		if (!ledger || ledger.length === 0) return;
		for (const text of [...ledger].reverse()) {
			session.promptQueue.enqueueAtFront(text, { isSteered: true });
		}
		ledger.length = 0;
		this.broadcastQueue(session);
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
		session.streamingStartedAt = session.streamingStartedAt ?? Date.now();
		this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
		broadcastStatus(session, "streaming", { streamingStartedAt: session.streamingStartedAt });

		// Snapshot the rows we're about to dispatch so we can re-enqueue them
		// if the agent rejects the prompt (e.g. "Agent is already processing."
		// when drainQueue races the SDK's finishRun() during a graceful abort).
		const dispatchedRowsForRecovery = steered.length > 0
			? steered.map(r => ({ text: r.text, images: r.images, attachments: r.attachments, isSteered: true }))
			: [{ text: next.text, images: next.images, attachments: next.attachments, isSteered: !!next.isSteered }];

		const recoverDispatchedRows = (reason: string) => {
			console.warn(`[session-manager] drainQueue dispatch failed for ${session.id} (${reason}); re-enqueueing ${dispatchedRowsForRecovery.length} row(s) at front`);
			// Re-enqueue at front in original order so the next drain re-dispatches
			// the same batch. Reverse iteration because enqueueAtFront unshifts.
			for (const r of [...dispatchedRowsForRecovery].reverse()) {
				session.promptQueue.enqueueAtFront(r.text, {
					images: r.images,
					attachments: r.attachments,
					isSteered: r.isSteered,
				});
			}
			broadcastStatus(session, "idle");
			this.broadcastQueue(session);
			// Schedule a follow-up drain on the next tick so the rows we just
			// re-enqueued get another chance once the bridge has finished its
			// abort/finishRun bookkeeping. setTimeout(0) lets pending microtasks
			// (including the SDK's finally{finishRun()}) run first.
			setTimeout(() => { this.drainQueue(session); }, 0);
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
				}
			})
			.catch((err: any) => {
				console.error(`[session-manager] Failed to dispatch queued prompt for ${session.id}:`, err);
				recoverDispatchedRows(err?.message || String(err));
			});
	}

	/**
	 * Handle agent events that track error state and control queue draining.
	 * Called from every event listener before broadcasting.
	 * - Tracks message_end with stopReason "error" so we can suppress queue draining.
	 * - On agent_end, skips drainQueue if the turn ended with an error.
	 */
	private handleAgentLifecycle(session: SessionInfo, event: any): void {
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

		// Splice this echoed user message off the shadow ledger if it was a
		// dispatched steer. Mirrors the SDK's _steeringMessages text-match
		// removal (agent-session.js:265–280); harmless no-op for non-steer
		// user messages (regular prompts, follow-ups, ask responses).
		this._consumeSteerEcho(session, event);

		// Tool boundary: dispatch accumulated steered messages as a batch
		// (PI-10b). Steers sent during a long tool call are collected in the
		// queue and delivered together when the tool finishes, before the
		// agent starts its next step.
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

		if (event.type === "message_end" && event.message?.role === "assistant") {
			const errored = event.message.stopReason === "error";
			session.lastTurnErrored = errored;
			session.lastTurnErrorMessage = errored ? (event.message.errorMessage || "") : undefined;
			if (errored) {
				session.consecutiveErrorTurns = (session.consecutiveErrorTurns ?? 0) + 1;
			} else {
				// Any non-error terminal assistant message resets the cap budget.
				// Only stopReason:"error" advances the counter.
				session.consecutiveErrorTurns = 0;
			}
		}

		if (event.type === "agent_start") {
			session.lastTurnErrored = false;
			session.lastTurnErrorMessage = undefined;
			session.turnHadToolCalls = false;
			session.streamingStartedAt = Date.now();
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: true, streamingStartedAt: session.streamingStartedAt });
			broadcastStatus(session, "streaming", { streamingStartedAt: session.streamingStartedAt });
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
			this.resolveStoreForSession(session.id).update(session.id, { wasStreaming: false, streamingStartedAt: undefined });
			broadcastStatus(session, "idle");
			// Don't drain the queue if the turn ended with a model error —
			// queued/steered messages should wait for a retry.
			if (!session.lastTurnErrored) {
				session.transientRetryAttempts = 0;
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
				(session as any)._pendingCompactionStart = {
					startedAtMs: Date.now(),
					trigger: reason === "overflow" ? "overflow" as const : "auto" as const,
				};
			}
		} else if (event.type === "auto_compaction_end" || event.type === "compaction_end") {
			session.isCompacting = false;
			const pending = (session as any)._pendingCompactionStart as
				| { startedAtMs: number; trigger: "auto" | "overflow" }
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
					appendCompactionSidecarEntry(session.id, {
						schemaVersion: 1,
						id: makeCompactionId(pending.startedAtMs),
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
			}
			(session as any)._pendingCompactionStart = undefined;
			if (!(event as any).aborted) this.refreshAfterCompaction(session);
		} else if (event.type === "process_exit") {
			session.streamingStartedAt = undefined;
			this.resolveStoreForSession(session.id).update(session.id, {
				wasStreaming: false,
				streamingStartedAt: undefined,
			});
			broadcastStatus(session, "terminated");
		}

		// Index completed messages for search (user + assistant). The
		// content policy inside SearchService runs extractForIndexing and
		// emits one row per text / tool_use / tool_result block.
		if (event.type === "message_end" && event.message) {
			try {
				this.resolveSearchIndex(session).indexMessage({
					sessionId: session.id,
					sessionTitle: session.title,
					message: event.message,
					timestamp: Date.now(),
					projectId: session.projectId || undefined,
					goalId: session.goalId,
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
	 * Auto-retry a turn that ended with a transient model/streaming error
	 * (e.g. malformed tool-call JSON from input_json_delta accumulation, or a
	 * transport blip matching TRANSIENT_ERROR_PATTERNS). Bounded retries with
	 * exponential backoff; after the cap, the error surfaces to the user as
	 * before and they can manually retry.
	 */
	private maybeAutoRetryTransient(session: SessionInfo): void {
		const MAX_ATTEMPTS = 3;
		const errMsg = session.lastTurnErrorMessage || "";
		if (!errMsg) return;
		if (!isTransientReviewError(errMsg)) return;

		const attempt = (session.transientRetryAttempts ?? 0) + 1;
		if (attempt > MAX_ATTEMPTS) {
			console.warn(
				`[session-manager] Session ${session.id} exhausted ${MAX_ATTEMPTS} transient auto-retries; surfacing error to user. Last error: ${errMsg.slice(0, 200)}`
			);
			session.transientRetryAttempts = 0;
			return;
		}
		session.transientRetryAttempts = attempt;

		const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
		console.log(
			`[session-manager] Session ${session.id} turn failed transiently (attempt ${attempt}/${MAX_ATTEMPTS}), auto-retrying in ${delayMs / 1000}s. Error: ${errMsg.slice(0, 200)}`
		);

		if (session.pendingAutoRetryTimer) clearTimeout(session.pendingAutoRetryTimer);
		session.pendingAutoRetryTimer = setTimeout(() => {
			session.pendingAutoRetryTimer = undefined;
			// Session may have been terminated in the meantime
			if (!this.sessions.has(session.id)) return;
			if (session.status !== "idle") return; // user sent something, or already retrying
			this.retryLastPrompt(session.id).catch((err) => {
				console.error(`[session-manager] Auto-retry failed for session ${session.id}:`, err);
			});
		}, delayMs);
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
		// Explicit retry resets the cap — human intervention gets a fresh budget.
		session.consecutiveErrorTurns = 0;
		if (session.pendingAutoRetryTimer) {
			clearTimeout(session.pendingAutoRetryTimer);
			session.pendingAutoRetryTimer = undefined;
		}

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
			// Fallback (e.g. session predates error tracking)
			await session.rpcClient.prompt(
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
	 *   - "session-only": adds to session.allowedTools in memory only (survives until session ends/restarts)
	 *   - "one-time": adds to session.allowedTools + tracks for revocation on agent_end
	 */
	async grantToolPermission(sessionId: string, toolName: string, scope: "tool" | "group", group?: string, mode?: "persistent" | "session-only" | "one-time"): Promise<string[]> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");
		if (!this.roleManager) throw new Error("No role manager available");

		// Use explicit role, or fall back to "general" role (implicit default for all sessions)
		const roleName = session.role || "general";
		const role = this.roleManager.getRole(roleName);
		if (!role) throw new Error(`Role "${roleName}" not found`);

		const effectiveAllowed = this.resolveEffectiveAllowedTools(role).map(e => e.name);
		const effectiveSet = new Set(effectiveAllowed.map(t => t.toLowerCase()));

		const newTools: string[] = [];
		if (scope === "group" && group) {
			// Add all tools from the group (MCP + non-MCP)
			if (this.mcpManager) {
				const infos = this.mcpManager.getToolInfos();
				for (const info of infos) {
					if (info.group === group && !effectiveSet.has(info.name.toLowerCase())) {
						newTools.push(info.name);
					}
				}
			}
			if (this.toolManager) {
				const allTools = this.toolManager.getAvailableTools();
				for (const tool of allTools) {
					if (tool.group === group && !effectiveSet.has(tool.name.toLowerCase()) && !newTools.includes(tool.name)) {
						newTools.push(tool.name);
					}
				}
			}
		} else {
			// Add just the single tool
			if (!effectiveSet.has(toolName.toLowerCase())) {
				newTools.push(toolName);
			}
		}

		if (newTools.length === 0) {
			// Tool is already effectively allowed — still resolve any pending guard request
			if (session.pendingGrantRequest) {
				clearTimeout(session.pendingGrantRequest.timer);
				const pending = session.pendingGrantRequest;
				session.pendingGrantRequest = undefined;
				pending.resolve({ granted: true, tools: effectiveAllowed });
			}
			return effectiveAllowed;
		}

		let resultTools: string[];

		if (mode === "one-time") {
			// Temporary grant: add to session.allowedTools, track for revocation on agent_end
			session.allowedTools = [...(session.allowedTools || []), ...newTools];
			session.oneTimeGrantedTools = [...(session.oneTimeGrantedTools || []), ...newTools];
			await this._restartSessionWithUpdatedRole(session);
			resultTools = session.allowedTools;

		} else if (mode === "session-only") {
			// Session-scoped grant: add to session.allowedTools only, don't write role YAML
			session.allowedTools = [...(session.allowedTools || []), ...newTools];
			await this._restartSessionWithUpdatedRole(session);
			resultTools = session.allowedTools;

		} else {
			// Persistent grant (default): update toolPolicies on role YAML (allowedTools is derived automatically)
			const updatedPolicies = { ...role.toolPolicies };
			for (const t of newTools) {
				updatedPolicies[t] = 'allow' as GrantPolicy;
			}
			this.roleManager.updateRole(role.name, { toolPolicies: updatedPolicies });
			// Re-read role and recompute effective allowed tools
			const updatedRole = this.roleManager.getRole(role.name);
			const updatedEffective = this.resolveEffectiveAllowedTools(updatedRole ?? role).map(e => e.name);
			session.allowedTools = updatedEffective;
			await this._restartSessionWithUpdatedRole(session);

			resultTools = updatedEffective;
		}

		// Resolve pending grant request from guard extension
		if (session.pendingGrantRequest) {
			clearTimeout(session.pendingGrantRequest.timer);
			const pending = session.pendingGrantRequest;
			session.pendingGrantRequest = undefined;
			pending.resolve({ granted: true, tools: session.allowedTools });
		}

		return resultTools;
	}

	/**
	 * Called by the guard extension's long-poll endpoint. Creates a pending
	 * grant request, broadcasts to UI clients, and returns a promise that
	 * resolves when the user grants/denies or after a 5-minute timeout.
	 */
	async requestToolGrant(sessionId: string, toolName: string, toolGroup: string): Promise<{ granted: boolean; tools?: string[] }> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error("Session not found");

		// If a previous grant request is still pending, resolve it as denied
		if (session.pendingGrantRequest) {
			clearTimeout(session.pendingGrantRequest.timer);
			session.pendingGrantRequest.resolve({ granted: false });
			session.pendingGrantRequest = undefined;
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
		const promise = new Promise<{ granted: boolean; tools?: string[] }>((resolve, reject) => {
			const timer = setTimeout(() => {
				session.pendingGrantRequest = undefined;
				resolve({ granted: false });
			}, 5 * 60 * 1000); // 5 minute timeout

			session.pendingGrantRequest = { resolve, reject, toolName, toolGroup, timer, seq, ts };
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
		const savedAllowedTools = session.allowedTools ? [...session.allowedTools] : undefined;
		const savedOneTimeGrantedTools = session.oneTimeGrantedTools ? [...session.oneTimeGrantedTools] : undefined;

		const restored = await this._respawnAgentInPlace(session, ps, {
			mutatePs: p => {
				// restoreSession normally derives allowedTools from role YAML; session-only
				// and one-time grants need the augmented list to round-trip.
				(p as any)._overrideAllowedTools = savedAllowedTools;
			},
		});

		if (restored) {
			if (savedAllowedTools) restored.allowedTools = savedAllowedTools;
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
		const savedClients = new Set(session.clients);
		// Snapshot AFTER unsubscribe so no in-flight event races past lastSeq.
		session.unsubscribe();
		const frameOfRef = this._snapshotStreamingFrameOfReference(session);
		try { await session.rpcClient.stop(); } catch { /* already dead */ }

		this.sessions.delete(session.id);
		(ps as any)._restartFrameOfReference = frameOfRef;
		opts?.mutatePs?.(ps);
		try {
			await this.restoreSession(ps);
		} finally {
			delete (ps as any)._restartFrameOfReference;
			delete (ps as any)._overrideAllowedTools;
		}
		const restored = this.sessions.get(session.id);
		if (restored) {
			for (const ws of savedClients) {
				if ((ws as any).readyState === 1) restored.clients.add(ws);
			}
			broadcastStatus(restored, opts?.finalStatus ?? "idle");
		}
		return restored;
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

		const savedAllowedTools = session.allowedTools ? [...session.allowedTools] : undefined;
		const savedOneTimeGrantedTools = session.oneTimeGrantedTools ? [...session.oneTimeGrantedTools] : undefined;

		const restored = await this._respawnAgentInPlace(session, ps, {
			mutatePs: p => { (p as any)._overrideAllowedTools = savedAllowedTools; },
		});

		if (restored) {
			if (savedAllowedTools) restored.allowedTools = savedAllowedTools;
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
		const cumulativeCost = sessionCostTracker.recordUsage(session.id, {
			inputTokens: usage.inputTokens ?? usage.input,
			outputTokens: usage.outputTokens ?? usage.output,
			cacheReadTokens: usage.cacheReadTokens ?? usage.cacheRead,
			cacheWriteTokens: usage.cacheWriteTokens ?? usage.cacheWrite,
			cost: costValue,
		});

		// Look up taskId from assigned tasks for this session
		let taskId: string | undefined;
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) {
				const tm = new TaskManager(ctx.taskStore);
				const tasks = tm.getTasksForSession(session.id);
				if (tasks.length > 0) { taskId = tasks[0].id; break; }
			}
		} else {
			const tasks = this._testTaskManager?.getTasksForSession(session.id) ?? [];
			taskId = tasks.length > 0 ? tasks[0].id : undefined;
		}

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
		// Initialize search service (skip when ProjectContextManager is active —
		// ProjectContext.open() already opens the service and wires callbacks)
		if (!this.projectContextManager && this._testSearchIndex && this._testStore && this._testGoalManager) {
			try {
				const goalStore = this._testGoalManager.getGoalStore();
				const testSearchIndex = this._testSearchIndex;
				testSearchIndex.open({ goalStore, sessionStore: this._testStore });
				// Wire index update callbacks
				goalStore.onIndexUpdate = (goal) => {
					try { testSearchIndex.indexGoal(goal, goal.projectId || ""); } catch (err) { console.error("[search] Failed to index goal:", err); }
				};
				this._testStore.onIndexUpdate = (session) => {
					try {
						const goalTitle = session.goalId ? this.resolveGoal(session.goalId)?.title : undefined;
						testSearchIndex.indexSession(session, goalTitle, session.projectId || "");
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

		console.log(`[session-manager] Restoring ${regular.length} session(s), deferring ${delegates.length} delegate(s)...`);

		// Restore regular sessions in parallel (batched concurrency)
		const CONCURRENCY = 5;
		for (let i = 0; i < regular.length; i += CONCURRENCY) {
			const batch = regular.slice(i, i + CONCURRENCY);
			await Promise.all(batch.map(ps => this.restoreOneSession(ps)));
		}

		// Delegate sessions: dormant entries only — restored on-demand via addClient()
		for (const ps of delegates) {
			if (!ps.agentSessionFile) {
				try { this.getSessionStore(ps.projectId).archive(ps.id); } catch { /* project gone */ }
				continue;
			}
			// Existence check deferred to addClient() revive — add as dormant unconditionally
			// (the file is in the agent's coordinate system; checking it here would require
			// async docker exec for sandbox sessions, and the file may not be needed until
			// the user opens the session)
			this.addDormantSession(ps);
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
			const agentSessionsRoot = path.join(globalAgentDir(), "sessions");
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
		if (!ps.projectId && !ps.goalId) {
			console.warn(`[session-manager] Session ${ps.id} has no projectId and predates multi-project — skipping restore`);
			return;
		}
		let sessionStore: SessionStore;
		try {
			sessionStore = this.getSessionStore(ps.projectId);
		} catch {
			console.warn(`[session-manager] Skipping session ${ps.id} — project "${ps.projectId}" no longer registered`);
			return;
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
		const fileCtx: SessionFsContext = { sandboxed: ps.sandboxed, projectId: ps.projectId };
		const fileFound = await sessionFileExists(fileCtx, ps.agentSessionFile, this.sandboxManager);
		if (!fileFound) {
			if (shouldKeepDespiteOrphan(ps)) {
				console.warn(`[orphan-cleanup] WARN: would-archive ${ps.id} but worktree+recent-transcript present — leaving live`);
				this.addDormantSession(ps);
				return;
			}
			console.log(`[session-manager] Archiving ${ps.id} — agent session file not found: ${ps.agentSessionFile} (metadata preserved)`);
			sessionStore.archive(ps.id);
			return;
		}
		try {
			await this.restoreSession(ps);
			console.log(`[session-manager] Restored: "${ps.title}" (${ps.id})`);
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
			projectId: ps.projectId,
			promptQueue: new PromptQueue(ps.messageQueue),
		});
	}

	private async restoreSession(ps: PersistedSession): Promise<void> {
		const bridgeOptions: RpcBridgeOptions = { cwd: ps.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (this.toolManager) bridgeOptions.toolManager = this.toolManager;

		// Restore env vars needed by extensions
		bridgeOptions.env = { BOBBIT_SESSION_ID: ps.id };
		if (ps.goalId) {
			bridgeOptions.env.BOBBIT_GOAL_ID = ps.goalId;
		}
		if (ps.staffId) {
			bridgeOptions.env.BOBBIT_STAFF_ID = ps.staffId;
		}

		// ── Restore Docker sandbox wiring ──
		if (ps.sandboxed) {
			// On restore, the worktree already exists inside the container —
			// pass the container-internal cwd directly (no branch = no worktree creation).
			if (ps.cwd?.startsWith("/workspace")) {
				bridgeOptions.cwd = ps.cwd;
			}
			await this.applySandboxWiring(bridgeOptions, ps.id, {
				projectId: ps.projectId,
				goalId: ps.goalId,
			});
			// Verify the sandbox worktree still exists inside the container
			if (ps.cwd?.startsWith("/workspace-wt/") && bridgeOptions.containerId) {
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
								// Derive worktree name from the persisted cwd, not the branch name
								// e.g. /workspace-wt/session/s-9241bb92 → session/s-9241bb92
								const worktreeName = ps.cwd!.replace(/^\/workspace-wt\//, "");
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
		const restoredRole = this.resolveSessionRole(ps.role, ps.assistantType);
		const effectiveAllowed: EffectiveTool[] = overrideAllowedTools
			? overrideAllowedTools.map(n => tagAllowedTool(n, this.toolManager))
			: this.resolveEffectiveAllowedTools(restoredRole);
		const restoredAllowedTools = effectiveAllowed.length > 0 ? effectiveAllowed : undefined;
		const restoredAllowedNames = restoredAllowedTools?.map(e => e.name);
		const restoredActivation = this.buildToolActivationArgs(ps.id, restoredAllowedTools, restoredRole, ps.cwd);
		bridgeOptions.args = [...restoredActivation.args, ...(bridgeOptions.args || [])];
		bridgeOptions.env = { ...(bridgeOptions.env || {}), ...restoredActivation.env };

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

			const promptPath = this.assemblePrompt(ps.id, {
				baseSystemPromptPath: undefined,
				cwd: ps.cwd,
				goalSpec: assistantGoalSpec,
				goalTitle: assistantDef.promptTitle,
				goalState: "active",
				allowedTools: restoredAllowedNames,
				projectConfigStore: this.projectConfigStore,
			});
			if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		} else {
			const goal = ps.goalId ? this.resolveGoal(ps.goalId) : undefined;

			// Re-attach role prompt for team agents (lost on restart since rolePrompt isn't persisted)
			const goalSpec = goal?.spec;
			let rolePrompt: string | undefined;
			let roleName: string | undefined;
			if (ps.role && this.roleManager) {
				const role = this.roleManager.getRole(ps.role);
				if (role?.promptTemplate) {
					rolePrompt = role.promptTemplate;
					if (goal?.branch) rolePrompt = rolePrompt.replace(/\{\{GOAL_BRANCH\}\}/g, goal.branch);
					rolePrompt = rolePrompt.replace(/\{\{AGENT_ID\}\}/g, `${ps.role}-${(ps.goalId || ps.id).slice(0, 8)}`);
					rolePrompt = rolePrompt.replace(/\{\{AVAILABLE_ROLES\}\}/g, buildAvailableRolesList(this.roleManager));
					roleName = ps.role;
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
				allowedTools: restoredAllowedNames,
				projectConfigStore: this.projectConfigStore,
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
			allowedTools: restoredAllowedNames,
			promptQueue: new PromptQueue(ps.messageQueue),
			streamingStartedAt: ps.streamingStartedAt,
			projectId: ps.projectId,
			repoPath: ps.repoPath,
			branch: ps.branch,
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

		session.unsubscribe = unsub;

		await rpcClient.start();

		// Resume the agent's previous session file
		// Session files are now stored on the host via bind-mounted state dir.
		// No path translation needed — the agent session file is always a host path.
		const switchSessionPath = ps.agentSessionFile;
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

		// If the agent was mid-turn when the server died, re-prompt it to continue
		if (ps.wasStreaming) {
			console.log(`[session-manager] Session "${ps.title}" (${ps.id}) was interrupted mid-turn — re-prompting to continue`);
			restoreStore.update(ps.id, { wasStreaming: false });
			rpcClient.prompt(
				"[SYSTEM: The infrastructure server restarted while you were mid-turn. " +
				"Your previous work has been preserved. Please continue where you left off. " +
				"Do NOT start over — review your recent messages and resume from the exact point of interruption.]"
			).catch((err: any) => {
				console.error(`[session-manager] Failed to re-prompt interrupted session ${ps.id}:`, err);
			});
		}
	}

	async createSession(cwd: string, agentArgs?: string[], goalId?: string, assistantType?: string, opts?: { rolePrompt?: string; roleName?: string; role?: string; accessory?: string; env?: Record<string, string>; taskId?: string; allowedTools?: string[]; workflowContext?: string; worktreeOpts?: { repoPath: string }; reattemptGoalId?: string; sandboxed?: boolean; projectId?: string; sessionId?: string; sandboxBranch?: string; sandboxBaseBranch?: string; skipAutoModel?: boolean; skipAutoThinking?: boolean; initialModel?: string; initialThinkingLevel?: string; preExistingAgentSessionFile?: string }): Promise<SessionInfo> {
		const id = opts?.sessionId || randomUUID();
		const optsAllowedTagged: EffectiveTool[] | undefined = opts?.allowedTools
			? opts.allowedTools.map(n => tagAllowedTool(n, this.toolManager))
			: undefined;
		// Resolve projectId from opts or from the goal's project
		const projectId = opts?.projectId ?? (goalId ? this.resolveGoal(goalId)?.projectId : undefined);
		const ctx = this.buildPipelineContext(projectId);

		// ── Worktree: return a "preparing" session immediately, launch agent async ──
		if (opts?.worktreeOpts) {
			const repoPath = opts.worktreeOpts.repoPath;
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
			const poolForCreate = (!opts?.sandboxed && projectId) ? this.worktreePools.get(projectId) : undefined;
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
				assistantType: undefined,
				taskId: opts?.taskId,
				allowedTools: opts?.allowedTools,
				// Mirror session-setup's effectiveRoleId fallback: when callers
				// (team-manager, staff-manager) pass only `roleName`, use that as
				// `session.role` so the post-spawn auto-model safety net still
				// keys off the right role id during the worktree-prep window.
				role: opts?.role ?? opts?.roleName,
				accessory: opts?.accessory,
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
				title: "New session",
				cwd,
				goalId,
				taskId: opts?.taskId,
				worktreePath,
				repoPath,
				branch,
				sandboxed: opts?.sandboxed,
				role: opts?.role,
				accessory: opts?.accessory,
				agentArgs,
				env: opts?.env,
				rolePrompt: opts?.rolePrompt,
				roleName: opts?.roleName,
				workflowContext: opts?.workflowContext,
				effectiveAllowedTools: optsAllowedTagged,
				projectId,
				sandboxBranch: opts?.sandboxBranch,
				sandboxBaseBranch: opts?.sandboxBaseBranch,
				skipAutoModel: opts?.skipAutoModel,
				skipAutoThinking: opts?.skipAutoThinking,
				initialModel: opts?.initialModel,
				initialThinkingLevel: opts?.initialThinkingLevel,
				preExistingAgentSessionFile: opts?.preExistingAgentSessionFile,
				bridgeOptions: { cwd },
			};

			// Persist immediately with all known structural fields
			persistOnce(session, plan, ctx.store);
			if (session.repoWorktrees && session.repoWorktrees.length > 0) {
				ctx.store.update(session.id, {
					repoWorktrees: Object.fromEntries(session.repoWorktrees.map(w => [w.repo, w.worktreePath])),
				});
			}

			// Fire-and-forget: finish pipeline. If we got a pool worktree above,
			// pass its path so executeWorktreeAsync skips createWorktree.
			executeWorktreeAsync(plan, session, ctx, claimed?.worktreePath).then(() => {
				// agentSessionFile is now persisted synchronously by spawnAgent before
				// status flips to idle (see session-setup.ts). The post-resolve persist
				// here is redundant but kept as a safety net for re-attempts where the
				// agent may rotate its session file mid-run.
				session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err) => {
					console.warn(`[session-manager] Early persist failed for worktree session ${session.id}:`, err);
				}).finally(() => { session.pendingMetadataPersist = undefined; });
			}).catch((err) => {
				handleSetupFailure(session, plan, err, ctx);
			});

			return session;
		}

		// ── Normal session: build plan and execute full pipeline ──
		const plan: SessionSetupPlan = {
			id,
			mode: "normal",
			title: "New session",
			cwd,
			goalId,
			assistantType,
			taskId: opts?.taskId,
			sandboxed: opts?.sandboxed,
			role: opts?.role,
			accessory: opts?.accessory,
			agentArgs,
			env: opts?.env,
			rolePrompt: opts?.rolePrompt,
			roleName: opts?.roleName,
			workflowContext: opts?.workflowContext,
			reattemptGoalId: opts?.reattemptGoalId,
			effectiveAllowedTools: optsAllowedTagged,
			projectId,
			sandboxBranch: opts?.sandboxBranch,
			sandboxBaseBranch: opts?.sandboxBaseBranch,
			skipAutoModel: opts?.skipAutoModel,
			skipAutoThinking: opts?.skipAutoThinking,
			initialModel: opts?.initialModel,
			initialThinkingLevel: opts?.initialThinkingLevel,
			preExistingAgentSessionFile: opts?.preExistingAgentSessionFile,
			bridgeOptions: { cwd },
		};

		const session = await executePlan(plan, ctx);
		if (projectId) session.projectId = projectId;

		// Persist session metadata (fire-and-forget, but tracked for terminate)
		session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err) => {
			console.warn(`[session-manager] Early persist failed for ${session.id}:`, err);
		}).finally(() => { session.pendingMetadataPersist = undefined; });

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
	}): Promise<SessionInfo> {
		const id = randomUUID();
		// Resolve projectId from parent session
		const parentProjectId = this.sessions.get(parentSessionId)?.projectId
			?? this.resolveStoreForId(parentSessionId)?.get(parentSessionId)?.projectId;
		const ctx = this.buildPipelineContext(parentProjectId);

		// ── Sandbox propagation from parent ──
		const parentMeta = this.getSessionStore(parentProjectId).get(parentSessionId);
		let delegateSandboxed = false;
		if (parentMeta?.sandboxed) {
			// Always use the parent's validated host-side cwd — never trust the
			// cwd from the container.  The agent sends process.cwd() which is a
			// container-internal path (typically /workspace or a subdir).  Using
			// it directly would either fail (path doesn't exist on host) or, worse,
			// allow a malicious agent to mount an arbitrary host path into the
			// delegate container.
			opts.cwd = parentMeta.cwd;
			delegateSandboxed = true;
		}

		const titleSummary = opts.title || opts.instructions.split("\n")[0].slice(0, 60) || "Delegate";

		// Inherit tool access from parent session
		const parentSession = this.sessions.get(parentSessionId);
		const parentAllowedTools: EffectiveTool[] | undefined = parentSession?.allowedTools
			? parentSession.allowedTools.map(n => tagAllowedTool(n, this.toolManager))
			: undefined;

		const plan: SessionSetupPlan = {
			id,
			mode: "delegate",
			title: titleSummary,
			cwd: opts.cwd,
			delegateOf: parentSessionId,
			sandboxed: delegateSandboxed || undefined,
			instructions: opts.instructions,
			context: opts.context,
			effectiveAllowedTools: parentAllowedTools,
			projectId: parentProjectId,
			bridgeOptions: { cwd: opts.cwd },
		};

		const session = await executePlan(plan, ctx);
		if (parentProjectId) session.projectId = parentProjectId;

		// Persist with all structural fields (delegateOf is in the initial put, tracked for terminate)
		session.pendingMetadataPersist = this.persistSessionMetadata(session).catch((err) => {
			console.error(`[session-manager] Failed to persist delegate session ${id}:`, err);
		}).finally(() => { session.pendingMetadataPersist = undefined; });

		// Send delegate prompt with 30s timeout
		await sendDelegatePrompt(session, opts.instructions, DELEGATE_SPAWN_TIMEOUT_MS);

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
				const raw: any = msgs.data;
				let data: any = raw;
				if (Array.isArray(raw)) {
					const spliced = spliceInFlightMessage(raw, session.latestMessageUpdate);
					const withCompaction = mergeCompactionSidecarIntoMessages(session.id, spliced);
					data = truncateLargeToolContentInMessages(withCompaction);
				} else if (raw && Array.isArray(raw.messages)) {
					const spliced = spliceInFlightMessage(raw.messages, session.latestMessageUpdate);
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
				broadcast(session.clients, { type: "state", data: st.data });
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
	/** Resolve a role-level model override for the session, if any. */
	private resolveRoleModel(session: SessionInfo): string | undefined {
		if (!session.role || !this.configCascade) return undefined;
		try {
			const resolved = this.configCascade.resolveRoles(session.projectId);
			return resolved.find(r => r.item.name === session.role)?.item.model;
		} catch {
			return undefined;
		}
	}

	/** Resolve a role-level thinkingLevel override for the session, if any. */
	private resolveRoleThinkingLevel(session: SessionInfo): string | undefined {
		if (!session.role || !this.configCascade) return undefined;
		try {
			const resolved = this.configCascade.resolveRoles(session.projectId);
			return resolved.find(r => r.item.name === session.role)?.item.thinkingLevel;
		} catch {
			return undefined;
		}
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
		if (role && this.configCascade) {
			try {
				const resolved = this.configCascade.resolveRoles(projectId);
				const m = resolved.find(r => r.item.name === role)?.item.model;
				if (m && /^[^/]+\/.+$/.test(m)) return m;
			} catch { /* fall through */ }
		}
		// default.sessionModel preference
		const pref = this.preferencesStore?.get("default.sessionModel") as string | undefined;
		if (pref && /^[^/]+\/.+$/.test(pref)) return pref;
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
		if (role && this.configCascade) {
			try {
				const resolved = this.configCascade.resolveRoles(projectId);
				const t = resolved.find(r => r.item.name === role)?.item.thinkingLevel;
				const known = isKnownThinkingLevel(t);
				if (known) candidate = known;
			} catch { /* fall through */ }
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
				const meta = inferMeta(modelId);
				return clampThinkingLevel(candidate, { id: modelId, provider, reasoning: meta.reasoning });
			}
		}
		return candidate;
	}

	/**
	 * Resolve the review/QA model to pin at spawn time. Mirrors the
	 * verification-harness precedence: role override → `default.reviewModel`.
	 */
	resolveInitialReviewModel(role: string | undefined, projectId: string | undefined): string | undefined {
		if (role && this.configCascade) {
			try {
				const resolved = this.configCascade.resolveRoles(projectId);
				const m = resolved.find(r => r.item.name === role)?.item.model;
				if (m && /^[^/]+\/.+$/.test(m)) return m;
			} catch { /* fall through */ }
		}
		const pref = this.preferencesStore?.get("default.reviewModel") as string | undefined;
		if (pref && /^[^/]+\/.+$/.test(pref)) return pref;
		return undefined;
	}

	private async tryAutoSelectModel(session: SessionInfo): Promise<void> {
		// If the agent was spawned with `--model <provider>/<modelId>` already,
		// skip the redundant `setModel` RPC — read-back verification still runs
		// and hard-fails on mismatch.
		const spawnPinned = !!session.spawnPinnedModel;

		// 0. Role override (highest non-explicit precedence). Hard-fail on mismatch,
		// matching the contract used for review/QA sessions: if a user explicitly
		// pinned a model on a role and it cannot be bound, surface the failure.
		const roleModel = this.resolveRoleModel(session);
		if (roleModel) {
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
				broadcast(session.clients, {
					type: "state",
					data: { model: { provider, id: modelId, reasoning: inferMeta(modelId).reasoning } },
				});
				console.log(`[session-manager] Set role-override model "${roleModel}" for session ${session.id} (role=${session.role})`);
				return;
			} catch (err) {
				console.error(`[session-manager] Role model "${roleModel}" failed for ${session.id}:`, err);
				throw err;
			}
		}

		if (!this.preferencesStore) return;

		// Check explicit preference first (works for both aigw and public providers)
		const sessionModelPref = this.preferencesStore.get("default.sessionModel") as string | undefined;
		if (sessionModelPref) {
			const slash = sessionModelPref.indexOf("/");
			if (slash > 0 && slash < sessionModelPref.length - 1) {
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
					console.log(`[session-manager] Set preferred model "${sessionModelPref}" for session ${session.id}${preSpawnPinned ? " (spawn-pinned)" : ""}`);
					broadcast(session.clients, {
						type: "state",
						data: { model: { provider, id: modelId, reasoning: inferMeta(modelId).reasoning } },
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
			const modelToUse = [...aigwModels].sort((a, b) => modelRecencyRank(b.id) - modelRecencyRank(a.id))[0];

			await session.rpcClient.setModel("aigw", modelToUse.id);
			this._writeModelNameFile(session.id, modelToUse.id);
			this.resolveStoreForSession(session.id).update(session.id, { modelProvider: "aigw", modelId: modelToUse.id });
			console.log(`[session-manager] Auto-selected aigw model "${modelToUse.id}" for session ${session.id}`);

			broadcast(session.clients, {
				type: "state",
				data: { model: { provider: "aigw", id: modelToUse.id, reasoning: inferMeta(modelToUse.id).reasoning } },
			});
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
				console.log(`[session-manager] Role thinking level "${roleThinking}" already pinned at spawn for ${session.id}`);
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
				const meta = inferMeta(persisted.modelId);
				const clamped = clampThinkingLevel(level, {
					id: persisted.modelId,
					provider: persisted.modelProvider,
					reasoning: meta.reasoning,
				});
				if (clamped) level = clamped;
			}
		} catch { /* best-effort */ }
		if (spawnPinnedThinking === level) {
			console.log(`[session-manager] Default thinking level "${level}" already pinned at spawn for ${session.id}`);
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

				// Proactively ensure the session file exists on disk so the session
				// survives a crash even if the agent hasn't written to it yet.
				// The agent will append conversation data later; an empty file is
				// enough for restoreOneSession() to pass the existence check and
				// issue switch_session (which handles empty files gracefully).
				if (!session.sandboxed && agentSessionFile) {
					try {
						const dir = path.dirname(agentSessionFile);
						if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
						if (!fs.existsSync(agentSessionFile)) fs.writeFileSync(agentSessionFile, "");
					} catch (err) {
						console.warn(`[session-manager] Could not proactively create session file for ${session.id}: ${err}`);
					}
				}

				this.resolveStoreForSession(session.id).update(session.id, { agentSessionFile });
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
			this.sessions.delete(id);
			extStore.remove(id);
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
		lastReadAt?: number;
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
		reattemptGoalId?: string;
		sandboxed?: boolean;
		projectId?: string;
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

	/** Update session metadata fields (role, teamGoalId, worktreePath, accessory, teamLeadSessionId) and persist. */
	updateSessionMeta(id: string, updates: { role?: string; teamGoalId?: string; worktreePath?: string; accessory?: string; nonInteractive?: boolean; teamLeadSessionId?: string; delegateOf?: string }): boolean {
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
		if (updates.accessory !== undefined) session.accessory = updates.accessory;
		if (updates.nonInteractive !== undefined) session.nonInteractive = updates.nonInteractive;
		if (updates.teamLeadSessionId !== undefined) session.teamLeadSessionId = updates.teamLeadSessionId;
		if (updates.delegateOf !== undefined) session.delegateOf = updates.delegateOf;
		this.resolveStoreForSession(id).update(id, updates);
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
		// Look up the full role (with toolPolicies) from roleManager if available
		const fullRole = this.roleManager?.getRole(role.name);
		const effectiveAllowed = this.resolveEffectiveAllowedTools(fullRole);
		const effectiveAllowedNames = effectiveAllowed.map(e => e.name);

		const promptPath = this.assemblePrompt(id, {
			baseSystemPromptPath: this.systemPromptPath,
			cwd: session.cwd,
			goalTitle: goal?.title,
			goalState: goal?.state,
			goalSpec,
			rolePrompt: role.promptTemplate,
			roleName: role.name,
			allowedTools: effectiveAllowedNames.length > 0 ? effectiveAllowedNames : undefined,
			projectConfigStore: this.projectConfigStore,
		});

		// Respawn with new system prompt
		const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
		if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
		if (promptPath) bridgeOptions.systemPromptPath = promptPath;
		if (this.toolManager) bridgeOptions.toolManager = this.toolManager;
		bridgeOptions.env = { BOBBIT_SESSION_ID: id };
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
		const respawnActivation = this.buildToolActivationArgs(id, effectiveAllowed.length > 0 ? effectiveAllowed : undefined, fullRole, session.cwd);
		bridgeOptions.args = [...respawnActivation.args, ...(bridgeOptions.args || [])];
		bridgeOptions.env = { ...(bridgeOptions.env || {}), ...respawnActivation.env };

		// Pin model/thinking-level at spawn for the respawn (after role assignment).
		const respawnPersisted = this.resolveStoreForSession(id).get(id);
		if (respawnPersisted?.modelProvider && respawnPersisted?.modelId) {
			bridgeOptions.initialModel = `${respawnPersisted.modelProvider}/${respawnPersisted.modelId}`;
		} else {
			const initModel = this.resolveInitialModel(role.name, session.projectId);
			if (initModel) bridgeOptions.initialModel = initModel;
		}
		const initThinking = this.resolveInitialThinkingLevel(role.name, session.projectId);
		if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;

		const rpcClient = new RpcBridge(bridgeOptions);
		session.spawnPinnedModel = bridgeOptions.initialModel;
		session.spawnPinnedThinkingLevel = bridgeOptions.initialThinkingLevel;
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

		await rpcClient.start();

		// Restore conversation from session file — path is already in agent coordinate system.
		const roleFileCtx: SessionFsContext = { sandboxed: session.sandboxed, projectId: session.projectId };
		if (agentSessionFile && await sessionFileExists(roleFileCtx, agentSessionFile, this.sandboxManager)) {
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
		session.role = role.name;
		session.accessory = role.accessory;
		session.allowedTools = effectiveAllowedNames;

		roleStore.update(id, { role: role.name, accessory: role.accessory });

		broadcastStatus(session, "idle");

		// Refresh messages and state for connected clients
		try {
			const msgs = await rpcClient.getMessages();
			if (msgs.success) {
				const raw: any = msgs.data;
				let data: any = raw;
				if (Array.isArray(raw)) {
					data = spliceInFlightMessage(raw, session.latestMessageUpdate);
				} else if (raw && Array.isArray(raw.messages)) {
					const spliced = spliceInFlightMessage(raw.messages, session.latestMessageUpdate);
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
		const aigwUrl = this.preferencesStore ? getAigwUrl(this.preferencesStore) : undefined;
		const namingThinking = this.preferencesStore?.get("default.namingThinkingLevel") as string | undefined;
		return { namingModel: namingModel || undefined, aigwUrl, thinkingLevel: namingThinking || undefined };
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
			const ctx: SessionFsContext = { sandboxed: ps.sandboxed, projectId: ps.projectId };
			const content = await sessionFileRead(ctx, ps.agentSessionFile, this.sandboxManager);
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
			await this.restoreSession(persisted);
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
		this.resolveStoreForSession(sessionId).update(sessionId, { modelProvider: provider, modelId });
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

	/** Latest user turn text for request-scoped policy checks such as model override gating. */
	getLastPromptText(sessionId: string): string | undefined {
		return this.sessions.get(sessionId)?.lastPromptText;
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
		const allLiveForTerminate = this.projectContextManager
			? [...this.projectContextManager.getAllLiveSessions()]
			: (this._testStore?.getLive() ?? []);
		for (const ps of allLiveForTerminate) {
			if (ps.delegateOf === id && !this.sessions.has(ps.id)) {
				try { this.getSessionStore(ps.projectId).archive(ps.id); } catch { /* project gone */ }
			}
		}

		// Resolve any pending grant request so the guard's long-poll returns immediately
		if (session.pendingGrantRequest) {
			clearTimeout(session.pendingGrantRequest.timer);
			session.pendingGrantRequest.resolve({ granted: false });
			session.pendingGrantRequest = undefined;
		}

		// Cancel any pending transient auto-retry so it doesn't fire after terminate
		if (session.pendingAutoRetryTimer) {
			clearTimeout(session.pendingAutoRetryTimer);
			session.pendingAutoRetryTimer = undefined;
		}

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

		// Clean up sandbox worktree inside the container.
		// Skip for delegate sessions — they share the parent's worktree and must
		// never remove it.  Only the owning (non-delegate) session should clean up.
		if (session.sandboxed && !session.delegateOf && session.cwd?.startsWith("/workspace-wt/") && this.sandboxManager && session.projectId) {
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

		// Clean up per-session proposal-drafts directory (fire-and-forget).
		// Same pattern as eagerDeleteRemoteSessionBranch — never blocks; missing
		// dir is harmless. See docs/design/editable-proposals.md §4.
		fsp.rm(path.join(bobbitStateDir(), "proposal-drafts", id), { recursive: true, force: true })
			.catch(err => console.warn(`[session-manager] proposal-drafts cleanup failed for ${id}:`, err));

		// Broadcast session_archived event before closing clients
		const archivedAt = Date.now();
		broadcast(session.clients, { type: "session_archived", sessionId: id, archivedAt });

		for (const client of session.clients) {
			client.close(1000, "Session terminated");
		}
		session.clients.clear();

		// Resolve the store BEFORE removing from in-memory map, so
		// resolveStoreForSession can look up the session's projectId.
		const terminateStore = this.resolveStoreForSession(id);
		this.sessions.delete(id);
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
		eagerDeleteRemoteSessionBranch({
			branch: sessionBranch,
			repoPath: persistedForBranchDelete?.repoPath,
			delegateOf: session.delegateOf,
			skipPush: shouldSkipRemotePush(),
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
		// Pass cwd/worktreePath/repoWorktrees in the info so listeners (e.g. LSP
		// supervisor release) can't be defeated by the `sessions.delete(id)` above —
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

	/** Archive a session directly in the store (for dormant/store-only sessions). */
	storeArchive(id: string): boolean {
		const store = this.resolveStoreForId(id);
		if (!store) return false;
		return store.archive(id);
	}

	/** Update metadata on an archived session (stored in the session store). */
	updateArchivedMeta(id: string, updates: { teamLeadSessionId?: string }): boolean {
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
			const ctx: SessionFsContext = { sandboxed: ps.sandboxed, projectId: ps.projectId };
			const content = await sessionFileRead(ctx, ps.agentSessionFile, this.sandboxManager);
			if (!content) return [];
			const lines = content.trim().split("\n");
			const messages: unknown[] = [];
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message" && entry.message) {
						messages.push(entry.message);
					}
				} catch {
					// Skip malformed lines
				}
			}
			return truncateLargeToolContentInMessages(messages) as unknown[];
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
		reattemptGoalId?: string;
		sandboxed?: boolean;
		archived: boolean;
		archivedAt?: number;
	}> {
		const allArchived = this.projectContextManager
			? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: (this._testStore?.getArchived() ?? []);
		return allArchived.map((ps) => ({
			id: ps.id,
			title: ps.title,
			cwd: ps.cwd,
			status: "archived",
			createdAt: ps.createdAt,
			lastActivity: ps.lastActivity,
			lastReadAt: ps.lastReadAt,
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
			reattemptGoalId: ps.reattemptGoalId,
			sandboxed: ps.sandboxed,
			archived: true,
			archivedAt: ps.archivedAt,
		}));
	}

	/** Permanently purge a single archived session immediately. */
	async purgeArchivedSession(id: string): Promise<boolean> {
		const ps = this.resolveStoreForId(id)?.get(id);
		if (!ps?.archived) return false;
		await this.purgeOneSession(ps);
		return true;
	}

	/** Purge all archived sessions older than 7 days. */
	async purgeExpiredArchives(): Promise<void> {
		const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
		const cutoff = Date.now() - SEVEN_DAYS_MS;
		const archived = this.projectContextManager
			? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: (this._testStore?.getArchived() ?? []);
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
		// Remove from search index
		this.cleanupSearchForSession(ps.id, ps.projectId);

		// Delete .jsonl file
		if (ps.agentSessionFile) {
			const purgeCtx: SessionFsContext = { sandboxed: ps.sandboxed, projectId: ps.projectId };
			await sessionFileDelete(purgeCtx, ps.agentSessionFile, this.sandboxManager).catch(err => {
				console.error(`[session-manager] Failed to delete .jsonl for ${ps.id}:`, err);
			});
		}

		// Delete session prompt file
		try {
			cleanupSessionPrompt(ps.id);
		} catch (err) {
			console.error(`[session-manager] Failed to cleanup prompt for ${ps.id}:`, err);
		}

		// Delete persisted prompt sections JSON
		purgePromptSectionsJson(ps.id);

		// Clean up host worktree.  Sandboxed session worktrees also create a host-side
		// worktree for server bookkeeping, so we clean those up too.  Skip paths that
		// are container-internal (start with /workspace) — those have no host counterpart.
		// Skip delegates — they share the parent's worktree and must never remove it.
		if (ps.worktreePath && ps.repoPath && !ps.worktreePath.startsWith("/workspace") && !ps.delegateOf) {
			try {
				const { cleanupWorktree } = await import("../skills/git.js");
				// Multi-repo: clean each repo's worktree in parallel + delete the
				// shared branch from each repo's remote (Phase 4a).
				if (ps.repoWorktrees && Object.keys(ps.repoWorktrees).length > 0) {
					await Promise.allSettled(Object.entries(ps.repoWorktrees).map(([repo, wt]) => {
						const repoPath = repo === "." ? ps.repoPath! : path.join(ps.repoPath!, repo);
						return cleanupWorktree(repoPath, wt, ps.branch, true);
					}));
				} else {
					await cleanupWorktree(ps.repoPath, ps.worktreePath, ps.branch, true);
				}
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
		this.resolveStoreForId(ps.id)?.purge(ps.id);

		// Notify termination listeners (sidebar broadcast etc.) so cached UI lists
		// drop the entry without waiting for a polling tick.
		for (const listener of this._terminationListeners) {
			try { listener(ps.id, { projectId: ps.projectId, reason: "purged" }); } catch (err) {
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
			const sessionsDir = path.join(globalAgentDir(), "sessions");
			// The agent CLI slugifies the CWD: replace non-alphanumeric chars with '-', wrap in '--'
			// For sandboxed sessions, the CWD stored in ps.cwd is the host path (set during setup).
			const cwdSlug = "--" + ps.cwd.replace(/[^a-zA-Z0-9]/g, "-") + "--";
			const cwdDir = path.join(sessionsDir, cwdSlug);
			if (!fs.existsSync(cwdDir)) return null;

			const files = fs.readdirSync(cwdDir).filter(f => f.endsWith(".jsonl"));
			if (files.length === 0) return null;

			// Parse timestamp from filename: 2026-04-03T15-15-12-009Z_<uuid>.jsonl
			// Find the file whose timestamp is closest to (and within 60s of) ps.createdAt
			const TOLERANCE_MS = 60_000;
			let bestFile: string | null = null;
			let bestDelta = Infinity;

			for (const file of files) {
				const tsMatch = file.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
				if (!tsMatch) continue;
				// Convert filename timestamp back to ISO: replace hyphens in time part with colons
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
				return path.join(cwdDir, bestFile).replace(/\\/g, "/");
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
			const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
			const blocks = stdout.split("\n\n");

			// Build a set of branches owned by live (non-archived) persisted sessions.
			// Prior to the fix, pool worktree directories were renamed on claim but
			// `git worktree repair` could fail — git tracked the OLD path while
			// the session stored the NEW path. Matching by branch prevents the
			// cleanup from deleting worktrees that are actually in use.
			const persistedBranches = new Set<string>();
			const allPersisted = this.projectContextManager
				? [...this.projectContextManager.getAllLiveSessions()]
				: (this._testStore?.getLive() ?? []);
			for (const ps of allPersisted) {
				if (ps.branch) persistedBranches.add(ps.branch);
			}

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
				// Normalize paths for comparison — git uses forward slashes on Windows,
				// but session store uses OS-native backslashes. Without normalization,
				// every session worktree is considered "orphaned" and deleted on restart.
				const normalize = (p: string | undefined) => p?.replace(/\\/g, "/").toLowerCase();
				const normalizedWtPath = normalize(wtPath);
				// Check if any active session uses this worktree (by path or branch)
				const isActive = [...this.sessions.values()].some(
					s => normalize(s.worktreePath) === normalizedWtPath || normalize(s.cwd) === normalizedWtPath
				) || persistedBranches.has(branch);
				if (!isActive) {
					console.log(`[session-manager] Cleaning up orphaned session worktree: ${wtPath} (branch: ${branch})`);
					const { cleanupWorktree } = await import("../skills/git.js");
					await cleanupWorktree(repoPath, wtPath, branch, true).catch(() => {});
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
			const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repoPath });
			const blocks = stdout.split("\n\n");

			const persistedBranches = new Set<string>();
			const allPersisted = this.projectContextManager
				? [...this.projectContextManager.getAllLiveSessions()]
				: (this._testStore?.getLive() ?? []);
			for (const ps of allPersisted) {
				if (ps.branch) persistedBranches.add(ps.branch);
			}

			const orphans: Array<{ path: string; branch: string }> = [];
			for (const block of blocks) {
				const branchMatch = block.match(/^branch refs\/heads\/(session\/.+)$/m);
				if (!branchMatch) continue;
				const branch = branchMatch[1];
				if (branch.startsWith("session/_pool-")) continue;
				const pathMatch = block.match(/^worktree (.+)$/m);
				if (!pathMatch) continue;
				const wtPath = pathMatch[1];
				const normalize = (p: string | undefined) => p?.replace(/\\/g, "/").toLowerCase();
				const normalizedWtPath = normalize(wtPath);
				const isActive = [...this.sessions.values()].some(
					s => normalize(s.worktreePath) === normalizedWtPath || normalize(s.cwd) === normalizedWtPath
				) || persistedBranches.has(branch);
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
			if (psForGate && shouldKeepDespiteOrphan(psForGate)) {
				console.warn(`[orphan-cleanup] WARN: would-archive ${id} but worktree+recent-transcript present — leaving live`);
				continue;
			}
			try {
				const didTerminate = await this.terminateSession(id);
				if (didTerminate) {
					terminated++;
				} else {
					// Session not in memory — try direct archive
					try {
						const ps = this.resolveStoreForId(id)?.get(id);
						if (ps) {
							this.getSessionStore(ps.projectId).archive(id);
							terminated++;
						}
					} catch { /* project gone */ }
				}
			} catch (err) {
				console.warn(`[session-manager] Failed to terminate orphan ${id}:`, err);
				// Try direct archive as fallback
				try {
					const ps = this.resolveStoreForId(id)?.get(id);
					if (ps) {
						this.getSessionStore(ps.projectId).archive(id);
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
		const cutoff = Date.now() - SEVEN_DAYS_MS;
		let count = 0;
		let totalSizeBytes = 0;

		const archived = this.projectContextManager
			? [...this.projectContextManager.all()].flatMap(ctx => ctx.sessionStore.getArchived())
			: (this._testStore?.getArchived() ?? []);

		for (const ps of archived) {
			if (ps.archivedAt && ps.archivedAt < cutoff) {
				count++;
				if (ps.agentSessionFile) {
					try {
						const stat = fs.statSync(ps.agentSessionFile);
						totalSizeBytes += stat.size;
					} catch { /* file may not exist */ }
				}
			}
		}
		return { count, totalSizeBytes };
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
			if (ps && ps.agentSessionFile) {
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

		// Try graceful abort first
		try {
			await session.rpcClient.abort();
		} catch {
			// Abort RPC itself may fail/timeout — proceed to force kill
		}

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
		// in the shadow ledger was accepted by the SDK but never echoed (the
		// process is dead before its message_end could arrive). Re-enqueue
		// at front so the post-respawn drainQueue redispatches them once.
		this._reconcileAfterAbort(session);

		// Emit agent_end so clients know streaming stopped
		broadcast(session.clients, { type: "event", data: { type: "agent_end", messages: [] } });
		broadcastStatus(session, "idle");

		// Restart the agent process
		try {
			const bridgeOptions: RpcBridgeOptions = { cwd: session.cwd };
			if (this.agentCliPath) bridgeOptions.cliPath = this.agentCliPath;
			if (this.systemPromptPath) bridgeOptions.systemPromptPath = this.systemPromptPath;
			if (this.toolManager) bridgeOptions.toolManager = this.toolManager;
			bridgeOptions.env = { BOBBIT_SESSION_ID: id };

			// Apply sandbox wiring for sandboxed sessions (container spawn, token, etc.)
			if (session.sandboxed) {
				await this.applySandboxWiring(bridgeOptions, id, {
					projectId: session.projectId,
					goalId: session.goalId,
				});
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
			const role = this.resolveSessionRole(session.role, session.assistantType);
			const effective = this.resolveEffectiveAllowedTools(role);
			const forceActivation = this.buildToolActivationArgs(id, effective.length > 0 ? effective : undefined, role, session.cwd);
			bridgeOptions.args = [...forceActivation.args, ...(bridgeOptions.args || [])];
			bridgeOptions.env = { ...(bridgeOptions.env || {}), ...forceActivation.env };

			// Pin model/thinking-level at spawn for the force-abort respawn.
			const forceRespawnPersisted = this.resolveStoreForSession(id).get(id);
			if (forceRespawnPersisted?.modelProvider && forceRespawnPersisted?.modelId) {
				bridgeOptions.initialModel = `${forceRespawnPersisted.modelProvider}/${forceRespawnPersisted.modelId}`;
			} else {
				const initModel = this.resolveInitialModel(session.role, session.projectId);
				if (initModel) bridgeOptions.initialModel = initModel;
			}
			const initThinking = this.resolveInitialThinkingLevel(session.role, session.projectId);
			if (initThinking) bridgeOptions.initialThinkingLevel = initThinking;

			const rpcClient = new RpcBridge(bridgeOptions);
			session.spawnPinnedModel = bridgeOptions.initialModel;
			session.spawnPinnedThinkingLevel = bridgeOptions.initialThinkingLevel;
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

			await rpcClient.start();

			// Resume session if we have the session file — path in agent coordinate system
			const abortFileCtx: SessionFsContext = { sandboxed: session.sandboxed, projectId: session.projectId };
			if (agentSessionFile && await sessionFileExists(abortFileCtx, agentSessionFile, this.sandboxManager)) {
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

			broadcastStatus(session, "idle");
			console.log(`[session-manager] Session ${id} agent restarted after force abort`);

			// Drain any queued messages (steered first, then normal)
			this.drainQueue(session);
		} catch (err) {
			console.error(`[session-manager] Failed to restart agent after force abort:`, err);
			broadcastStatus(session, "terminated");
		}
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
			this.resolveStoreForSession(id).update(id, { wasStreaming: session.status === "streaming", streamingStartedAt: session.streamingStartedAt });

			session.unsubscribe();
			await session.rpcClient.stop();
			// shutdown(): clients are being closed; broadcast is harmless but unnecessary.
			// Status mutation here is the documented exception to the broadcastStatus rule.
			session.status = "terminated";

			for (const client of session.clients) {
				client.close(1000, "Server shutting down");
			}
			session.clients.clear();
			this.sessions.delete(id);
		}

		// Flush any debounced store writes before exit
		if (this.projectContextManager) {
			for (const ctx of this.projectContextManager.all()) ctx.sessionStore.flush();
		} else if (this._testStore) {
			this._testStore.flush();
		}

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
	}
}

// ── Sandbox credential auto-resolution ─────────────────────────────

import { resolveHostTokenValue } from "./host-tokens.js";

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
function resolveSandboxTokens(prefs?: import("./preferences-store.js").PreferencesStore | null, projectConfig?: import("./project-config-store.js").ProjectConfigStore | null, secretsStore?: import("./secrets-store.js").SecretsStore | null): Record<string, string> {
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
function resolveLegacySandboxCredentials(prefs?: import("./preferences-store.js").PreferencesStore | null, projectConfig?: import("./project-config-store.js").ProjectConfigStore | null): Record<string, string> {
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
