import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { PROPOSAL_PARSERS } from "./proposal-parsers.js";
import { bootMark, bootTimingMeta, bootTimingReport } from "./boot-timing.js";
import { loadSavedBindings } from "./shortcut-registry.js";
import { gatewayWsUrl } from "./gateway-fetch.js";
import { gatewayRoute } from "../shared/base-path.js";

/**
 * Placeholder model used as the initial value of `_state.model` before the
 * real model arrives via WS hydration (`set_model` event). Hard-coded to
 * avoid statically importing `getModel` from `@earendil-works/pi-ai`, which
 * would pull the 553 kB generated model catalog into the entry chunk.
 *
 * Mirrors `getModel("anthropic", "claude-opus-4-6")` with `contextWindow: 0`
 * (the previous initial state). The hydrated model from the server replaces
 * this within a few ms of WS connect — only `contextWindow` and `provider`
 * are read from the placeholder, both defensively.
 *
 * See `docs/design/shrink-initial-bundle.md` (Task A) and `pi-ai-lazy.ts`.
 */
const PLACEHOLDER_DEFAULT_MODEL: Model<"anthropic-messages"> = {
	id: "claude-opus-4-6",
	name: "Claude Opus 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	thinkingLevelMap: { xhigh: "max" },
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 0,
	maxTokens: 128000,
};

import { isProposalType, type GoalWorkflowValidationError, type ProposalType } from "./proposal-registry.js";
import { workflowValidationErrorFromProposalResult } from "../ui/tools/renderers/proposal-rev-marker.js";

export type ProposalSource = "tool" | "legacy" | "edit" | "seed" | "rehydrate" | "restore";
const SERVER_PROPOSAL_SOURCES = new Set<ProposalSource>(["edit", "seed", "rehydrate", "restore"]);

function normalizeServerProposalSource(source: unknown): ProposalSource {
	return typeof source === "string" && SERVER_PROPOSAL_SOURCES.has(source as ProposalSource)
		? source as ProposalSource
		: "edit";
}
import { applyGatewaySessionIdentity, state, renderApp, setProjectsIfChanged } from "./state.js";
import type { SessionRuntime } from "../server/agent/session-runtime.js";
import { loadReviewSources } from "./review-sources-lazy.js";
import { hydrateArtifactReviewsForWorkspace, openReviewReceipt, parseReviewOpenReceipt, registerReviewOpenReceipt } from "./review-open-controller.js";
import { showFaviconBadge } from "./favicon-badge.js";
import { isEffectivePlayFinishSoundEnabled, type FinishSoundSource } from "./play-finish-sound.js";
import { needsHumanAttentionOnIdleTransition, needsImmediateHumanAttention } from "./notification-policy.js";
import { scheduleGateStatusRefreshForGoal, refreshSessions, scheduleSessionListRefreshFromPush, scheduleStaffListRefreshFromPush } from "./remote-agent-refresh.js";
import { applySidePanelWorkspaceFromServer, hydrateSidePanelWorkspace } from "./side-panel-workspace.js";
import { shouldRefreshGateStatusForEvent } from "./gate-status-events.js";
import { publishClientMessage, publishClientStatus } from "./session-event-bus.js";
import { registerSessionPoster, unregisterSessionPoster, type SessionPostRequest } from "./session-write-bridge.js";
import { registerSurfaceTokenMinter, unregisterSurfaceTokenMinter, type PackSurfaceRef } from "./surface-token-minter-registry.js";
import { handleMutationPendingEvent, handleMutationDecidedEvent } from "./mutation-approval-events.js";
import { dispatchVerificationEvent } from "./verification-event-bus.js";
import { initAnnotationStore } from "../ui/components/review/AnnotationStore.js";
import { applyEntryAdded as applyInboxEntryAdded, applyEntryUpdated as applyInboxEntryUpdated, applyEntryRemoved as applyInboxEntryRemoved } from "./inbox-panel.js";
import { findAskResponseAnswers as _findAskResponseAnswers, type AskResponseAnswer } from "../shared/ask-envelope.js";
import { reduce, initialState, type ReducerState, type Action, type OrderedMessage } from "./message-reducer.js";
import {
	applyClaudeSdkSubagentWorkFrame,
	isClaudeSdkSubagentFrame,
	projectClaudeSdkSubagentSnapshot,
	type ClaudeSdkEmbeddedWork,
} from "./claude-sdk-subagent-work.js";
import { computeStreamingMessageId } from "./streaming-message-id.js";
import {
	buildCompactionSummaryMessages,
	buildInProgressCompactionPayload,
	isContextOverflowError,
	parseOverflowTokenCount,
	type CompactionSummaryPayload,
	type CompactionTrigger,
} from "./compaction-types.js";
import type { AutoRetryPendingEvent, ManualRetryRequiredEvent, ProviderAuthRequiredEvent, ProviderAuthRecoveryAction, RemoteStateSnapshotMessage } from "../server/ws/protocol.js";
import { LOCAL_USER_AUTHOR, type BobbitMessage, type MessageAuthor } from "../shared/message-author.js";
import type { PromptSource } from "../shared/prompt-source.js";
import { reconstructAssistantStreamDelta } from "../shared/assistant-stream-delta.js";
import { storage } from "./storage.js";
import type { PersistedDeliveryIntent } from "../ui/storage/app-storage.js";

const CLIENT_SYSTEM_AUTHOR: MessageAuthor = {
	kind: "system",
	id: "system:bobbit",
	label: "Bobbit",
};

function withClientSystemAuthor<T extends object>(message: T): BobbitMessage<T> {
	return { ...message, author: CLIENT_SYSTEM_AUTHOR };
}

/** Accept only the server's explicit runtime discriminator; never infer it from a model/provider. */
function sessionRuntimeFromWire(value: unknown): SessionRuntime | undefined {
	return value === "pi" || value === "claude-agent-sdk" ? value : undefined;
}

function modelAvailabilityFromWire(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function createSystemNotification(
	message: string,
	category: "system" | "task" | "team" | "error" = "system",
	variant: "default" | "destructive" = "default",
) {
	return {
		role: "system-notification",
		message,
		variant,
		category,
		timestamp: new Date().toISOString(),
		author: CLIENT_SYSTEM_AUTHOR,
	};
}

export interface ProviderAuthRequiredState {
	provider: string;
	source: string;
	reason: "missing-api-key";
	message: string;
	actions: ProviderAuthRecoveryAction[];
	receivedAt: number;
}

export interface ModelSelectionRequiredCondition {
	code: "MODEL_SELECTION_REQUIRED";
	provider: string;
	modelId: string;
}

function modelSelectionRequiredCondition(value: unknown): ModelSelectionRequiredCondition | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<ModelSelectionRequiredCondition>;
	return candidate.code === "MODEL_SELECTION_REQUIRED"
		&& typeof candidate.provider === "string"
		&& candidate.provider.length > 0
		&& typeof candidate.modelId === "string"
		&& candidate.modelId.length > 0
		? {
			code: "MODEL_SELECTION_REQUIRED",
			provider: candidate.provider,
			modelId: candidate.modelId,
		}
		: null;
}

// ───────────────────────────────────────────────────────────
// Goal-state subscription fanout — additive bridge so renderer-level
// custom elements (e.g. <children-goal-state-pill>) can subscribe to
// `goal_state_changed` / `goal_child_spawned` events without coupling to
// the dashboard or adding a DOM event type. See subgoals design doc.
// ───────────────────────────────────────────────────────────

export interface GoalStateChangeEvent {
	goalId?: string;
	type?: string;
}

const _goalStateSubscribers = new Set<(evt: GoalStateChangeEvent) => void>();

/** Subscribe to goal_state_changed / goal_child_spawned WS broadcasts.
 *  Returns an unsubscribe function. Safe to call any number of times. */
export function subscribeGoalStateChanges(cb: (evt: GoalStateChangeEvent) => void): () => void {
	_goalStateSubscribers.add(cb);
	return () => { _goalStateSubscribers.delete(cb); };
}

function notifyGoalStateSubscribers(evt: GoalStateChangeEvent): void {
	for (const cb of _goalStateSubscribers) {
		try { cb(evt); } catch { /* swallow — one bad subscriber must not break the rest */ }
	}
}

function isKnownOwnSessionCreatedEvent(msg: any, sessionId: string): boolean {
	if (!sessionId || msg?.type !== "session_created") return false;
	const createdId = typeof msg.sessionId === "string"
		? msg.sessionId
		: typeof msg.id === "string"
			? msg.id
			: typeof msg.session?.id === "string"
				? msg.session.id
				: "";
	return createdId === sessionId && state.gatewaySessions.some((session: any) => session?.id === sessionId);
}

/** Maps propose_* tool suffix → callback name on RemoteAgent (legacy path).
 *  Slice E will replace this lookup with a flat ProposalType allow-list and
 *  a single `this.onProposal?.(type, input, streaming)` dispatch. Until then,
 *  both the legacy per-type callbacks AND the new unified `onProposal`
 *  callback are fired so Slice E can migrate consumers atomically. */
const PROPOSAL_TOOL_MAP: Record<string, string> = {
	goal: "onGoalProposal",
	role: "onRoleProposal",
	tool: "onToolProposal",
	staff: "onStaffProposal",
	project: "onProjectProposal",
};

/** Maps legacy XML proposal tag → ProposalType (replaces the per-parser
 *  `callbackName` field which was dropped in Slice D). */
const PROPOSAL_TAG_TO_TYPE: Record<string, ProposalType> = {
	goal_proposal: "goal",
	role_proposal: "role",
	tool_proposal: "tool",
	staff_proposal: "staff",
	project_proposal: "project",
};

/** Maps ProposalType → legacy per-type callback name on RemoteAgent. */
const TYPE_TO_LEGACY_CALLBACK: Record<ProposalType, string> = {
	goal: "onGoalProposal",
	role: "onRoleProposal",
	tool: "onToolProposal",
	staff: "onStaffProposal",
	project: "onProjectProposal",
};

function parseToolPayload(value: unknown): Record<string, unknown> | null {
	if (!value) return null;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? parsed as Record<string, unknown>
				: null;
		} catch {
			return null;
		}
	}
	return null;
}

function mergeToolPayloads(...payloads: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> | null {
	let merged: Record<string, unknown> | null = null;
	for (const payload of payloads) {
		if (!payload) continue;
		if (!merged) {
			merged = { ...payload };
			continue;
		}
		for (const [key, value] of Object.entries(payload)) {
			const current = merged[key];
			if ((current === undefined || current === null || current === "") && value !== undefined && value !== null && value !== "") {
				merged[key] = value;
			} else if (value !== undefined && value !== null && value !== "") {
				merged[key] = value;
			}
		}
	}
	return merged;
}

function normalizeProposalToolCallInputs(message: any, inputByToolId?: (id: string) => unknown): any {
	if (!message || !Array.isArray(message.content)) return message;
	let changed = false;
	const content = message.content.map((block: any) => {
		if (block?.type !== "toolCall" && block?.type !== "tool_use") return block;
		const toolName = block.name || block.toolName;
		if (typeof toolName !== "string" || !toolName.startsWith("propose_")) return block;
		const blockId = typeof block.id === "string" ? block.id : (typeof block.toolCallId === "string" ? block.toolCallId : "");
		const merged = mergeToolPayloads(
			blockId ? parseToolPayload(inputByToolId?.(blockId)) : null,
			parseToolPayload(block.input),
			parseToolPayload(block.arguments),
		);
		if (!merged) return block;
		changed = true;
		return {
			...block,
			input: merged,
			arguments: merged,
		};
	});
	return changed ? { ...message, content } : message;
}

function toolEventId(event: any): string | undefined {
	const id = event?.toolCallId ?? event?.toolId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

type ReviewToolName = "review_open" | "review_close";
type PendingReviewToolCall = { toolName: ReviewToolName; recordedAt: number };
type CorrelatedReviewResult = { toolCallId: string; payloads: Record<string, unknown>[] };

const REVIEW_TOOL_CALL_TTL_MS = 15 * 60_000;
const REVIEW_TOOL_CALL_MAX_PENDING = 128;

function reviewToolName(value: unknown): ReviewToolName | null {
	return value === "review_open" || value === "review_close" ? value : null;
}

function reviewResultCorrelationId(value: Record<string, unknown>): string {
	const id = value.toolCallId ?? value.tool_use_id;
	return typeof id === "string" && id.length > 0 ? id : "";
}

function isTypedToolResult(value: Record<string, unknown>): boolean {
	return value.role === "toolResult"
		|| value.role === "tool_result"
		|| value.type === "toolResult"
		|| value.type === "tool_result";
}

/**
 * Extract review payloads only from protocol-typed tool-result envelopes.
 * A message-level result owns its content; otherwise direct nested
 * `tool_result` blocks own theirs. We deliberately do not recursively search
 * arbitrary objects, because unrelated tool output may itself contain data
 * that resembles a result block.
 */
function correlatedReviewResults(message: unknown): CorrelatedReviewResult[] {
	if (!message || typeof message !== "object" || Array.isArray(message)) return [];
	const msg = message as Record<string, unknown>;
	const envelopes: Record<string, unknown>[] = [];
	if (isTypedToolResult(msg)) {
		envelopes.push(msg);
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block && typeof block === "object" && !Array.isArray(block) && isTypedToolResult(block as Record<string, unknown>)) {
				envelopes.push(block as Record<string, unknown>);
			}
		}
	}

	return envelopes.flatMap((envelope) => {
		const toolCallId = reviewResultCorrelationId(envelope);
		if (!toolCallId) return [];
		const payloads: Record<string, unknown>[] = [];
		const collectPayloads = (value: unknown): void => {
			if (typeof value === "string") {
				try {
					const parsed = JSON.parse(value.trim());
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && reviewToolName((parsed as any).action)) {
						payloads.push(parsed as Record<string, unknown>);
					}
				} catch { /* ordinary result text is not a review control payload */ }
				return;
			}
			if (Array.isArray(value)) {
				for (const item of value) collectPayloads(item);
				return;
			}
			if (!value || typeof value !== "object") return;
			const block = value as Record<string, unknown>;
			if (reviewToolName(block.action)) {
				payloads.push(block);
			} else if (block.type === "text") {
				collectPayloads(block.text);
			}
		};
		collectPayloads(envelope.content);
		collectPayloads(envelope.output);
		collectPayloads(envelope.result);
		return [{ toolCallId, payloads }];
	});
}

function sameProposalFields(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
	if (!a || !b) return false;
	try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function parseGoalWorkflowValidationError(result: any, input?: Record<string, unknown>): GoalWorkflowValidationError | null {
	return workflowValidationErrorFromProposalResult(result, input) ?? null;
}

/**
 * A remote agent adapter that connects to the Bobbit Gateway via WebSocket.
 * Duck-types the Agent interface from pi-agent-core so it can be used
 * with ChatPanel / AgentInterface without changes.
 */
export type ConnectionStatus = "connected" | "reconnecting" | "starting" | "disconnected";

class GatewayRetryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GatewayRetryError";
	}
}

/** Canonical client-side session status. Mirrors the server's `SessionStatus`
 *  union (`src/server/agent/session-manager.ts`). The legacy boolean readers
 *  `isStreaming` / `isArchived` / `isPreparing` are now getters derived from
 *  this single field. See docs/design/unify-session-status.md. */
export type ClientSessionStatus = "idle" | "streaming" | "aborting" | "preparing" | "archived" | "starting" | "terminated";

/** A message waiting in the server-side prompt queue (mirrors server QueuedMessage) */
export type DeliveryState = "local" | "queued" | "dispatching" | "received" | "uncertain" | "failed" | "cancelled";
export type DeliveryTargetTurn = "continuation" | "next-turn";

const DELIVERY_STATE_RANK: Record<DeliveryState, number> = {
	local: 0,
	queued: 1,
	dispatching: 2,
	uncertain: 3,
	failed: 3,
	received: 4,
	cancelled: 5,
};

export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	kind?: "prompt" | "steer";
	targetTurn?: DeliveryTargetTurn;
	sequence?: number;
	deliveryState?: DeliveryState;
	deliveryReason?: string;
	deliveryError?: string;
	retryable?: boolean;
	/** Legacy optional flag from the pre-ledger queue model; current server rows omit it. */
	dispatched?: boolean;
	source?: PromptSource;
	author?: MessageAuthor;
	/** True only while this occurrence has no observable server projection. */
	unsent?: boolean;
	createdAt: number;
}

interface PendingOutboxEntry {
	frame: any;
	row?: QueuedMessage;
	persisted?: boolean;
	/** Exact durable revision from which this tab rendered the local row. */
	localRevision?: number;
	lastSentEpoch?: number;
	/** A correlated pre-admission rejection requires an explicit user Retry.
	 * It must not be flushed automatically on this or a later connection. */
	retryRequired?: boolean;
	mutationPending?: boolean;
}

function createIntentId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return `intent_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function deliveryIntentId(value: any): string | undefined {
	const id = value?.deliveryIntentId ?? value?.intentId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * A user-shaped in-flight steer spliced into a server snapshot is continuity
 * evidence, never Pi's correlated user-message echo. Both markers are
 * explicit server-owned recovery metadata: modern rows carry an intent while
 * older persisted rows may carry only a prompt id or synthetic snapshot id.
 */
function isDeliveryRecoveryProjection(value: any): boolean {
	return value?._deliveryRecoveryProjection === true || value?._inFlightSteer === true;
}

/**
 * Recovery rows must retain an occurrence key without correlating by text.
 * Prefer the durable intent (so a real Pi echo settles the existing carrier),
 * then the pre-intent prompt id. Snapshot/attempt ids are server-issued
 * compatibility fallbacks for legacy records that have neither.
 */
function deliveryRecoveryOccurrenceId(value: any): string | undefined {
	const candidates = [
		deliveryIntentId(value),
		value?.promptId,
		value?.id,
		value?.deliveryAttemptId ?? value?.attemptId,
	];
	return candidates.find((candidate): candidate is string =>
		typeof candidate === "string" && candidate.length > 0,
	);
}

function deliveryRecoveryOutboxRow(message: any): QueuedMessage | undefined {
	const id = deliveryRecoveryOccurrenceId(message);
	if (!id) return undefined;
	const sequence = Number.isSafeInteger(message?.sequence) && message.sequence >= 0
		? message.sequence
		: undefined;
	const rawState = message?.deliveryState ?? message?.state;
	const deliveryState = rawState === "local" || rawState === "queued" || rawState === "dispatching"
		|| rawState === "received" || rawState === "uncertain" || rawState === "failed" || rawState === "cancelled"
		? rawState as DeliveryState
		// A recovery-only record proves neither Pi admission nor settlement. Keep
		// it visible as an uncertain delivery carrier rather than a transcript row.
		: "uncertain" as const;
	return {
		...message,
		id,
		text: extractText(message),
		isSteered: message?.isSteered === true || message?.kind === "steer",
		createdAt: typeof message?.createdAt === "number" && Number.isFinite(message.createdAt)
			? message.createdAt
			: sequence ?? 0,
		kind: message?.kind === "prompt" || message?.kind === "steer" ? message.kind : "steer",
		deliveryState,
		...(message?.targetTurn === "continuation" || message?.targetTurn === "next-turn"
			? { targetTurn: message.targetTurn }
			: {}),
		...(sequence === undefined ? {} : { sequence }),
		...(message?.deliveryReason ? { deliveryReason: message.deliveryReason } : {}),
		...(message?.deliveryError ? { deliveryError: message.deliveryError } : {}),
		...(typeof message?.retryable === "boolean" ? { retryable: message.retryable } : {}),
		...(message?.source ? { source: message.source } : {}),
		...(message?.author ? { author: message.author } : {}),
	};
}

function persistedOutboxRow(row: QueuedMessage): Record<string, unknown> {
	const copy: Record<string, unknown> = { ...row };
	// The resend frame already owns payload bodies. Keeping a second copy in the
	// display row would double/triple large attachment storage for no recovery gain.
	delete copy.images;
	delete copy.attachments;
	return copy;
}

export class RemoteAgent {
	private ws: WebSocket | null = null;
	// In-flight C2 session-WRITE (`host.session.postMessage`) requests, keyed by the
	// correlation id sent on the `ext_session_post` frame and settled by the matching
	// `ext_session_post_result`. See `_postExtSession` / session-write-bridge.ts.
	private _pendingExtPosts = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
	// In-flight C2 write-permit MINT requests, keyed by the correlation id on the
	// `ext_session_write_permit` frame, settled by `ext_session_write_permit_result`.
	private _pendingExtPermits = new Map<string, { resolve: (nonce: string) => void; reject: (e: Error) => void }>();
	// In-flight pack-bound surface-token MINT requests, settled by
	// `ext_surface_token_result`.
	private _pendingExtSurfaceTokens = new Map<string, { resolve: (token: string) => void; reject: (e: Error) => void }>();
	private _sessionPoster: ((req: SessionPostRequest) => Promise<void>) | undefined;
	private _surfaceTokenMinter: ((surface: PackSurfaceRef) => Promise<string>) | undefined;
	private _surfaceTokenAuthorityKey: string | undefined;
	private _assistantStreamDeltaEnabled = false;
	private _previousRawAssistantStreamMessage: any;
	private subscribers: Array<(event: any) => void> = [];
	private _state: any;
	private _conditionSnapshotReceived = false;
	private _gatewayUrl = "";
	private _authToken = "";
	private _sessionId = "";
	private _toolCallInputsById = new Map<string, unknown>();
	private _proposalToolCallsById = new Map<string, { type: ProposalType; input: Record<string, unknown> }>();
	/** Single-use provenance for live review controls. Kept past
	 * `tool_execution_end` because the persisted result message may follow it. */
	private _pendingReviewToolCalls = new Map<string, PendingReviewToolCall>();
	// Server-authoritative prompt queue
	private _serverQueue: QueuedMessage[] = [];
	// The IndexedDB-backed portion owns an occurrence only until a matching
	// server projection is observed. `_deliveryProjection` then owns the visible
	// carrier until the correlated real user message enters the reducer.
	private _pendingOutbox: PendingOutboxEntry[] = [];
	private _deliveryProjection = new Map<string, QueuedMessage>();
	/** Bounded terminal occurrence fence; prevents late queue frames from resurrecting surfaced intent. */
	private _settledDeliveryIntentIds = new Set<string>();
	private _connectionEpoch = 0;
	private static readonly OUTBOX_MAX = 50;
	// Reducer-owned message state. The reducer is the single source of truth
	// for transcript order; `_state.messages` is mirrored from `reducerState.messages`
	// after every dispatch so existing UI bindings keep working.
	private reducerState: ReducerState = initialState();
	/** Nested SDK child work keyed only by the root Agent tool-use id. This is
	 * intentionally outside reducerState: child rows must never affect root
	 * transcript order, streaming prose, proposals, or host transcript events. */
	subagentWorkByParent = new Map<string, ClaudeSdkEmbeddedWork>();
	// Streaming preview message id — render filters this from messages so
	// the same row doesn't appear twice (in message list and streaming container).
	// Public for the AgentInterface render filter; not part of the RPC surface.
	streamingMessageId: string | undefined;
	// Attachments from the most recent prompt, used to enrich the echoed
	// user message so thumbnails render in the message list.
	private _pendingAttachments: any[] | null = null;

	// Skill expansions from the most recent prompt. The server is the
	// authoritative resolver of `/<name>` invocations, but scripted callers may
	// already carry expansions. Preserve them only as a fallback enrichment for
	// the correlated real user echo; no optimistic transcript row is created.
	private _pendingSkillExpansions: any[] | null = null;

	// Compaction tracking — persists across message refreshes.
	// Exposed on state so the UI can queue messages during compact.
	private _isCompacting = false;
	/** True from `compaction_end` (success path) until the next clean
	 *  assistant turn lands carrying fresh `usage`. Read by the context-bar
	 *  renderer in `AgentInterface` to show a shimmer-placeholder bar
	 *  (the snapshot's last-assistant-usage post-compaction is still
	 *  pre-compaction, so any number we'd show would be wrong;
	 *  pi-coding-agent doesn't emit a fresh per-message usage row for the
	 *  synthetic summary entry).
	 *  Public so the renderer can read it via `session._usageStaleAfterCompaction`. */
	_usageStaleAfterCompaction = false;
	/** Pre-compaction context-fill percentage captured at `compaction_start`,
	 *  so the placeholder bar can animate from the OLD fill down to the
	 *  shimmer's resting width (~25%) during compaction. Null when no
	 *  compaction is in flight or the source value couldn't be sampled.
	 *  Range 0-100. Read by the renderer. */
	_compactionStartPct: number | null = null;
	/** Best-effort cache of the most recently seen context-token count; used
	 *  as the final fallback when resolving `tokensBefore` for a compaction
	 *  end event. See `docs/design/compaction-e2e-rich-summary.md` §7.3. */
	private _lastKnownContextTokens: number | null = null;
	private _isAborting = false;

	/** Overflow-recovery tracking. When the upstream agent hits a context-limit
	 *  error mid-turn it emits `auto_compaction_start { reason: "overflow" }`,
	 *  compacts, and retries the prompt. If the retry ALSO fails (compaction
	 *  didn't reclaim enough), the retry surfaces as an assistant `message_end`
	 *  with `stopReason: "error"` and an Anthropic-style overflow `errorMessage`.
	 *  Showing that as a standalone red banner is jarring — the user already
	 *  has a compaction card describing what happened. Instead we attach the
	 *  real error to the compaction card and suppress the trailing red block.
	 *  Window opens on `auto_compaction_start { reason: "overflow" }` and stays
	 *  open until either the next assistant `message_end` lands or 60 s passes. */
	private _overflowRecoveryDeadline: number | null = null;

	/** Payload of the most recent compaction whose `tokensAfter` we haven't
	 *  amended yet. The server emits `compaction_end` BEFORE the post-compaction
	 *  state refresh lands, so reading `_state.contextTokens` (or scanning back
	 *  for the latest assistant usage row) at that instant returns a stale
	 *  value from an earlier turn — NOT the real post-compaction size. Instead
	 *  we leave `tokensAfter`/`reductionPct` null on the initial card and amend
	 *  it when the next successful assistant `message_end` lands carrying
	 *  authoritative `usage`. Cleared either on amend or on a subsequent failed
	 *  retry (the overflow-recovery fold path takes precedence). */
	private _pendingCompactionAmend: import("./compaction-types.js").CompactionSummaryPayload | null = null;

	/** Wall-clock start of the active compaction. Captured on
	 *  `compaction_start` / `auto_compaction_start` so the terminal payload
	 *  can carry an authoritative `durationMs` (renderer displays it on the
	 *  complete/error card; in-progress card uses the same start to power
	 *  the live <live-timer> ticker). */
	private _compactionStartedAt: number | null = null;

	// Proposal deferral — when set, incoming messages are stored but
	// _checkProposals is skipped until runDeferredProposalCheck() is called.
	// This lets us fire requestMessages() early for fast loading while
	// draft restores finish without being overwritten by proposal detection.
	private _deferProposalCheck = false;
	private _hasDeferredProposals = false;
	// Tracks message IDs where a tool-based proposal was already detected,
	// so the legacy XML path can be skipped for those messages.
	private _toolProposalMessageIds = new Set<string>();

	// Tracks tool_use block IDs that have already been processed as proposals,
	// preventing re-fires on message re-scan (reconnect, refresh).
	private _processedProposalIds = new Set<string>();

	// Tracks the tool_use block ID of the proposal currently STREAMING for each
	// tag (e.g. "goal_proposal"). Set on every streaming delta; cleared when the
	// stream finalizes (message_end) or the turn ends. Used by
	// dismissStreamingProposal() so a mid-stream Dismiss can suppress the rest of
	// the in-flight tool block — without it, the next (content-grown) delta would
	// fail the content-fingerprint dismissal check and re-populate the panel.
	private _streamingProposalBlockIdByTag: Record<string, string> = {};

	// Task timing — track when the agent started working so we can
	// notify the user if a long task finishes while the tab is hidden.
	private _taskStartTime: number | null = null;

	// Streaming dedup/reorder (per-session monotonic seq assigned by server).
	// See docs/design/streaming-dedup-reorder.md.
	private _highestSeq = 0;
	/** True once we've seen any seq-bearing frame. Before this flips, the first
	 *  seq'd frame initializes `_highestSeq = seq - 1` so we don't stall on the
	 *  initial-connect gap (the server doesn't replay the pre-connect buffer as
	 *  event frames — it sends a state snapshot instead). */
	private _seqInitialized = false;
	private _pendingEvents: Array<{ seq: number; ts?: number; data: any }> = [];
	/** Defensive cap — if we ever buffer more than this while waiting for a
	 *  gap to fill, fall back to a snapshot refresh instead of growing forever. */
	private readonly _pendingEventsMax = 500;
	/** True while we've asked for a snapshot refresh due to a seq gap / fallback. */
	private _inResumeFallback = false;

	/** Monotonic statusVersion of the last applied `session_status` frame.
	 *  Used to drop heartbeats / duplicates (`<=` lastApplied), apply normal
	 *  increments (`==` last+1), and request a `status_resync` on gaps (`>` last+1).
	 *  Initialised to -1 (and reset to -1 on `reset()`) so the FIRST frame on a
	 *  fresh connection is always applied — the server creates worktree-backed
	 *  sessions with `statusVersion: 0`, and treating `0 <= 0` as a duplicate
	 *  would leave `_state.status` stuck at the constructor default "idle",
	 *  preventing the preparing-UX banner from ever rendering.
	 *  See docs/design/unify-session-status.md §4.2. */
	private _lastStatusVersion = -1;

	// Auto-reconnect state
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _reconnectAttempt = 0;
	private _intentionalDisconnect = false;
	private _connectionStatus: ConnectionStatus = "disconnected";
	private _pendingReconnectNotif = false;
	private _visibilityHandlerBound = false;
	/** Throttle visibility-driven resyncs: Android can fire visibilitychange
	 *  several times during screen unlock; we only want one resync per wake. */
	private _lastVisibilityResync = 0;
	/** True if the WS has dropped since the last successful snapshot apply.
	 *  Visibility-driven resyncs are skipped while this is false and we already
	 *  have messages in state — the cached state is correct, and a redundant
	 *  `requestMessages()` on every tab-focus tick is what triggers the
	 *  new-tab duplicate-messages bug. Set true on WS close, cleared after
	 *  any successful snapshot apply. */
	_hadDisconnectSinceLastSnapshot = true;
	private _onVisibilityChange = (): void => {
		if (document.visibilityState !== "visible") return;
		if (this._intentionalDisconnect) return;
		// Only the active session's agent performs a visibility-driven resync.
		// Cached (background) session agents stay connected but do not fetch
		// history on tab wake — otherwise a single wake on mobile fires up to
		// SESSION_CACHE_MAX concurrent get_messages requests, each of which
		// can return tens of KB of history. That’s a major source of mobile
		// sluggishness after returning from background.
		if (state.selectedSessionId !== this._sessionId) return;
		if (this.ws?.readyState !== WebSocket.OPEN) {
			// Socket isn't OPEN — kick an immediate reconnect instead of
			// waiting for the (possibly long) backoff timer that may have been
			// queued while the tab was suspended.
			if (this._reconnectTimer) {
				clearTimeout(this._reconnectTimer);
				this._reconnectTimer = null;
			}
			this._reconnectAttempt = 0;
			this._setConnectionStatus("reconnecting");
			this._connectWs(false).catch(() => { /* onclose will schedule retry */ });
		} else {
			// Socket reports OPEN but the connection may actually be dead
			// (mobile OS can freeze the TCP socket without notifying the JS
			// layer). Resync messages once — throttled to at most every 2s
			// so rapid visibilitychange storms during screen unlock don't
			// pile up concurrent get_messages requests (which can race with
			// streaming echoes and produce duplicate user messages).
			const now = Date.now();
			if (now - this._lastVisibilityResync < 2000) return;
			this._lastVisibilityResync = now;
			// (Removed the skip-while-streaming branch — the server-side status
			//  heartbeat is now responsible for keeping `status` honest after a
			//  visibility-driven wake. Skipping here was the bug magnet that left
			//  Stop stuck on tab-suspend miss.
			//  See docs/design/unify-session-status.md §4.8.)
			// Skip the message resync when the WS has stayed connected since
			// the last snapshot AND we already have messages: the cached state
			// is correct and re-snapshotting on every visibilitychange tick is
			// what causes the new-tab duplicate-messages bug (each tick re-runs
			// the snapshot survivor merge against the current `state.messages`,
			// and any id-less live rows accumulate duplicates). `get_state`
			// still fires — only the message refetch is skipped.
			const needsResync =
				this._hadDisconnectSinceLastSnapshot || this._state.messages.length === 0;
			if (needsResync) this.requestMessages();
			this.send({ type: "get_state" });
			// Nudge subscribers — after a tab wake, Lit property bindings
			// driven by this agent may not have been reactive while suspended.
			// A synthetic state_update forces AgentInterface to re-read state
			// and re-bind isStreaming / messages to child components, so the
			// streaming container's blob animation re-attaches correctly when
			// the next turn starts.
			this.emit({ type: "state_update", data: { woke: true } });
		}
	};
	/** Timestamp of last streamingMessage update when content contains truncated blocks. */
	private _lastTruncatedStreamUpdate = 0;
	/**
	 * Retry timer values are deliberately client-owned. Gateway availability
	 * frames arrive before authentication, so their advisory metadata must never
	 * influence a timer duration.
	 */
	private static readonly RECONNECT_DELAYS = [250, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

	private _nextReconnectDelay(): number {
		return RemoteAgent.RECONNECT_DELAYS[Math.min(
			this._reconnectAttempt + 1,
			RemoteAgent.RECONNECT_DELAYS.length - 1,
		)];
	}

	// Agent interface properties (used by AgentInterface / ChatPanel)
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	streamFn: any;

	/** Callback fired when the session title changes (e.g. AI-generated summary). */
	onTitleChange?: (title: string) => void;
	onStatusChange?: (status: string) => void;
	/** Callback fired when connection status changes (connected/reconnecting/disconnected). */
	onConnectionStatusChange?: (status: ConnectionStatus) => void;
	/** Callback fired when a goal proposal is detected in an assistant message.
	 *  `streaming === true` means input is still arriving; consumers must keep
	 *  their `*Edited` gating intact and must not commit destructive actions on
	 *  streaming-mode fires. */
	onGoalProposal?: (proposal: { title: string; spec: string; cwd?: string; workflow?: string; metadata?: Record<string, unknown> }, streaming: boolean) => void;
	/** Callback fired when a role proposal is detected in an assistant message. */
	onRoleProposal?: (proposal: { name: string; label: string; prompt: string; tools: string; accessory: string }, streaming: boolean) => void;
	/** Callback fired when a tool proposal is detected in an assistant message. */
	onToolProposal?: (proposal: { tool: string; action: string; content: string }, streaming: boolean) => void;
	/** Callback fired when a staff proposal is detected in an assistant message. */
	onStaffProposal?: (proposal: { name: string; description: string; prompt: string; triggers: string; cwd: string }, streaming: boolean) => void;
	/** Callback fired when a project proposal is detected in an assistant message. */
	onProjectProposal?: (fields: Record<string, unknown>, streaming: boolean) => void;
	/**
	 * Slice D: unified proposal callback. Slice E will collapse all six
	 * `onXProposal` callbacks above into this one. For now both fire — see
	 * `_checkToolProposals` and the `proposal_update` / `proposal_cleared`
	 * WS handlers below.
	 *
	 * `fields === null` signals a `proposal_cleared` event from the server
	 * (e.g. after accept/dismiss/file-delete).
	 *
	 * Buffered: events received before the consumer assigns `onProposal`
	 * (e.g. server-pushed `proposal_update` from rehydrate-on-attach arriving
	 * during the post-connect await chain in session-manager.ts) are queued
	 * and replayed synchronously on first assignment. Without this buffer
	 * the WS message dispatch races the consumer's callback wiring and
	 * proposals can be silently dropped — which is the exact regression that
	 * Task C's lazy artifact loading exposed in the parity-restart-survival
	 * E2E tests.
	 */
	private _onProposal?: (
		type: ProposalType,
		fields: Record<string, unknown> | null,
		streaming: boolean,
		rev?: number,
		source?: ProposalSource,
	) => void;
	private _bufferedProposalEvents: Array<{
		type: ProposalType;
		fields: Record<string, unknown> | null;
		streaming: boolean;
		rev?: number;
		source?: ProposalSource;
	}> = [];
	get onProposal(): typeof this._onProposal {
		return this._onProposal;
	}
	set onProposal(fn: typeof this._onProposal) {
		this._onProposal = fn;
		if (fn && this._bufferedProposalEvents.length > 0) {
			const pending = this._bufferedProposalEvents;
			this._bufferedProposalEvents = [];
			for (const ev of pending) {
				try { fn(ev.type, ev.fields, ev.streaming, ev.rev, ev.source); }
				catch (err) { console.warn("[remote-agent] buffered onProposal replay threw:", err); }
			}
		}
	}
	/** Callback fired when tool execution updates (for real-time progress). */
	onWorkflowUpdate?: () => void;
	/** Callback fired when the server-side prompt queue changes. */
	onQueueUpdate?: (queue: QueuedMessage[]) => void;
	/** Callback fired when background process state changes. */
	/** Callback fired when the shared goal worktree setup lifecycle changes. */
	onGoalSetupEvent?: (goalId?: string) => void;
	/** Callback fired when compaction state changes (start/end). */
	onCompactionChange?: (isCompacting: boolean) => void;
	onBgProcessEvent?: (msg: { type: string; processId?: string; stream?: string; text?: string; ts?: number; exitCode?: number | null; terminalReason?: "normal" | "killed" | "unrecoverable" | "spawn-failed" | null; spawnFailure?: { kind: "spawn"; code: "ENOENT" | "EACCES" | "EPERM" | "UNKNOWN"; message: string } | null; endTime?: number | null; process?: any }) => void;
	/** Callback fired when preview panel flag changes for a session. */
	onPreviewChanged?: (sessionId: string, preview: boolean) => void;
	/** Safe, entity-addressed Git or PR snapshot completed by the server coordinator. */
	onRemoteStateSnapshot?: (message: RemoteStateSnapshotMessage) => void;
	/** Callback fired when server detects PR creation and busts the cache. */
	onPrStatusChanged?: (goalId: string) => void;
	/** Called when ANY session anywhere is terminated/archived/purged —
	 * server pushes a `session_removed` broadcast and we forward it here so
	 * sidebars and dashboards can update without waiting for a polling tick. */
	onSessionRemoved?: (sessionId: string, reason: string) => void;
	/** Called after a NON-INITIAL WS reconnect's auth_ok. Use this to re-fire
	 * session-scoped hydration that runs once on initial connect (annotations,
	 * git status, bg processes, etc). Without it, a client whose WS dropped
	 * during a streaming turn keeps its stale local copy of these caches —
	 * the dominant 'badge stuck after Reconnecting' E2E flake. */
	onReconnect?: () => void;
	private _title = "New session";

	constructor() {
		this._state = {
			systemPrompt: "",
			model: { ...PLACEHOLDER_DEFAULT_MODEL, contextWindow: 0 },
			thinkingLevel: "medium",
			imageGenerationModel: null as any,
			tools: [],
			messages: [] as OrderedMessage[],
			status: "idle" as ClientSessionStatus,
			runtime: undefined as SessionRuntime | undefined,
			modelAvailable: undefined as boolean | undefined,
			isCompacting: false,
			archivedAt: null as number | null,
			// Provider estimates remain separate from actual billed cost. Subscription
			// sessions deliberately report `totalCost: null` alongside their notional
			// API-equivalent amount; consumers must never add the latter to billed totals.
			serverCost: null as {
				inputTokens: number;
				outputTokens: number;
				cacheReadTokens: number;
				cacheWriteTokens: number;
				totalCost: number | null;
				notionalCostUsd?: number | null;
				costBasis?: "api-billed" | "api-notional" | "subscription-notional" | "unknown";
				cacheHitRate?: number | null;
			} | null,
			streamingMessage: null as BobbitMessage<AgentMessage> | null,
			subagentWorkByParent: this.subagentWorkByParent,
			pendingToolCalls: new Set<string>(),
			error: undefined as string | undefined,
			turnStartTime: null as number | null,
			// Populated when the server schedules an auto-retry timer for a
			// transient / provider-overload error. Cleared on agent_start (next
			// turn dispatched) or auto_retry_cancelled (user click / new prompt /
			// session terminated).
			autoRetryPending: null as {
				reason: "provider-overload" | "transient-error";
				retryDelayMs: number;
				attempt: number;
				scheduledAt: number;
				error?: string;
			} | null,
			providerAuthRequired: null as ProviderAuthRequiredState | null,
			manualRetryRequired: null as { message: string; error?: string } | null,
			condition: null as ModelSelectionRequiredCondition | null,
			modelSelectionPending: null as { provider: string; modelId: string } | null,
			modelSelectionError: null as string | null,
		};
		// Single source of truth: status drives every legacy boolean. Defining
		// these as getters on the underlying object means every existing reader
		// (state.isStreaming, state.isArchived, state.isPreparing, agent.isStreaming)
		// continues to compile unchanged — they're just derived now.
		// See docs/design/unify-session-status.md §4.1.
		Object.defineProperty(this._state, "isStreaming", {
			get: () => this._state.status === "streaming",
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(this._state, "isArchived", {
			get: () => this._state.status === "archived",
			enumerable: true,
			configurable: true,
		});
		Object.defineProperty(this._state, "isPreparing", {
			get: () => this._state.status === "preparing",
			enumerable: true,
			configurable: true,
		});
	}

	get state() {
		return this._state;
	}
	get conditionSnapshotReceived(): boolean {
		return this._conditionSnapshotReceived;
	}
	get sessionId() {
		return this._sessionId || undefined;
	}
	get thinkingBudgets() {
		return { minimal: 1024, low: 4096, medium: 10240, high: 32768 };
	}
	get transport() {
		return undefined;
	}
	get maxRetryDelayMs() {
		return undefined;
	}
	get connected() {
		return this.ws?.readyState === WebSocket.OPEN;
	}
	registerHostApiTransports(): void {
		if (!this._sessionId) return;
		this._sessionPoster = (req) => this._postExtSession(req);
		this._surfaceTokenMinter = (surface) => this._mintPackSurfaceToken(surface);
		registerSessionPoster(this._sessionId, this._sessionPoster);
		registerSurfaceTokenMinter(this._sessionId, this._surfaceTokenMinter);
	}
	private _unregisterHostApiTransports(reason: string): void {
		unregisterSessionPoster(this._sessionId, this._sessionPoster);
		unregisterSurfaceTokenMinter(this._sessionId, this._surfaceTokenMinter);
		this._sessionPoster = undefined;
		this._surfaceTokenMinter = undefined;
		this._surfaceTokenAuthorityKey = undefined;
		this._rejectPendingExtPosts(reason);
	}
	get connectionStatus(): ConnectionStatus {
		return this._connectionStatus;
	}
	get gatewaySessionId() {
		return this._sessionId;
	}

	/** Update runtime identity only from explicit server frames, independently of status-version dedupe. */
	private _applySessionIdentity(runtime?: SessionRuntime, modelAvailable?: boolean): void {
		if (runtime !== undefined) this._state.runtime = runtime;
		if (modelAvailable !== undefined) this._state.modelAvailable = modelAvailable;
		if (this._sessionId && (runtime !== undefined || modelAvailable !== undefined)) {
			applyGatewaySessionIdentity(this._sessionId, { runtime, modelAvailable });
		}
	}
	/**
	 * Reconcile review content after the owner session's annotation/tombstone
	 * cache and workspace have hydrated. Tombstones suppress passive recreation
	 * only when the authoritative primary is absent; an existing exact primary
	 * proves an explicit open committed and must survive reload/reconnect.
	 */
	async reconcileSubmittedReviewWorkspace(options: {
		annotationStoreHydrated?: boolean;
		reviewSources?: any;
	} = {}): Promise<void> {
		const sessionId = this._sessionId;
		if (!sessionId) return;
		if (!options.annotationStoreHydrated) await initAnnotationStore(sessionId);
		await hydrateArtifactReviewsForWorkspace(sessionId);
	}
	private _isActiveSession(): boolean {
		return this._sessionId !== "" && state.selectedSessionId === this._sessionId;
	}
	get title() {
		return this._title;
	}

	/** Play a short two-tone beep using the Web Audio API (no file needed). */
	static async playNotificationBeep(source?: FinishSoundSource): Promise<void> {
		if (!(await isEffectivePlayFinishSoundEnabled(source))) return;
		try {
			const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
			const now = ctx.currentTime;

			// Two short tones: 880 Hz then 1046 Hz
			for (const [freq, start] of [[880, 0], [1046, 0.15]] as const) {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = "sine";
				osc.frequency.value = freq;
				gain.gain.setValueAtTime(0.15, now + start);
				gain.gain.exponentialRampToValueAtTime(0.001, now + start + 0.12);
				osc.connect(gain).connect(ctx.destination);
				osc.start(now + start);
				osc.stop(now + start + 0.12);
			}

			// Close the context after the beep finishes
			setTimeout(() => ctx.close().catch(() => {}), 500);
		} catch {
			// Web Audio not available — silently skip
		}
	}

	// ── Connection ────────────────────────────────────────────────────

	private static readonly CONNECT_TIMEOUT_MS = 15_000;

	async connect(gatewayUrl: string, token: string, sessionId: string): Promise<void> {
		this._gatewayUrl = gatewayUrl;
		this._authToken = token;
		this._sessionId = sessionId;
		this._intentionalDisconnect = false;
		this._reconnectAttempt = 0;
		await this._restoreDeliveryOutbox();

		// On mobile, the OS suspends the tab when backgrounded. When the user
		// returns, the WebSocket is often already dead but the reconnect timer
		// was paused — we'd otherwise wait out the full backoff before even
		// trying. Force an immediate reconnect attempt on visibility so resume
		// is as close to instant as the network allows.
		if (!this._visibilityHandlerBound) {
			document.addEventListener("visibilitychange", this._onVisibilityChange);
			this._visibilityHandlerBound = true;
		}

		// Restore processed proposal IDs from sessionStorage
		try {
			const stored = sessionStorage.getItem(`processed-proposals-${sessionId}`);
			if (stored) {
				this._processedProposalIds = new Set(JSON.parse(stored));
			}
		} catch { /* ignore */ }

		// An explicit SERVER_STARTING/SERVER_SATURATED frame is actionable: keep
		// trying with bounded backoff instead of presenting the misleading generic
		// 15-second timeout. Transport and auth failures retain the old behavior.
		for (;;) {
			try {
				await this._connectInitialAttempt();
				break;
			} catch (err) {
				if (!(err instanceof GatewayRetryError) || this._intentionalDisconnect) {
					// If timed out, clean up the pending WebSocket.
					this._intentionalDisconnect = true;
					this.ws?.close();
					this.ws = null;
					throw err;
				}
				this._setConnectionStatus("starting");
				const delay = this._nextReconnectDelay();
				this._reconnectAttempt++;
				await new Promise<void>((resolve) => setTimeout(resolve, delay));
				if (this._intentionalDisconnect) throw new Error("Connection cancelled");
			}
		}
	}


	private _connectInitialAttempt(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Connection timed out")), RemoteAgent.CONNECT_TIMEOUT_MS);
			this._connectWs(true).then(
				() => { clearTimeout(timeout); resolve(); },
				(error) => { clearTimeout(timeout); reject(error); },
			);
		});
	}

	/**
	 * Internal WebSocket connect. When `initial` is true the returned promise
	 * resolves/rejects for the caller of `connect()`. On reconnect attempts
	 * (`initial` false) failures schedule the next retry silently.
	 */
	private _connectWs(initial: boolean): Promise<void> {
		// An unset per-agent base means "use the active gateway", not an explicit
		// empty operator URL. Non-empty bases remain authoritative on reconnect.
		const wsUrl = gatewayWsUrl(
			gatewayRoute(`/ws/${encodeURIComponent(this._sessionId)}`),
			this._gatewayUrl || undefined,
		);

		return new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(wsUrl);
			this.ws = ws;
			let settled = false;
			let suppressCloseReconnect = false;

			ws.onopen = () => {
				bootMark("ws-open");
				ws.send(JSON.stringify({
					type: "auth",
					token: this._authToken,
					clientKind: "app",
					capabilities: { assistantStreamDelta: 1 },
				}));
			};

			ws.onmessage = (evt) => {
				let msg: any;
				try {
					msg = JSON.parse(evt.data);
				} catch {
					return;
				}

				// Boot-timing: record the raw snapshot frame size so we can tell
				// whether the get_state cost is payload transfer vs. server-side
				// assembly. Cheap: a type check + a (no-copy) string length read.
				if (msg.type === "messages" && typeof evt.data === "string") {
					bootTimingMeta({ snapshotChars: evt.data.length, serverTiming: msg.serverTiming });
				}

				if (!settled) {
					if (msg.type === "auth_ok") {
						settled = true;
						this._surfaceTokenAuthorityKey = typeof msg.surfaceTokenKey === "string" ? msg.surfaceTokenKey : undefined;
						this._assistantStreamDeltaEnabled = msg.capabilities?.assistantStreamDelta === 1;
						// Register the sanctioned WS transports for pack-bound surface-token minting
						// and `host.session.postMessage` (C2 session WRITE, extension-host-phase2.md
						// §8 C2.1). Server-side session binding, surface-token resolution, and
						// one-time content-bound permits carry the authorization/provenance checks;
						// the app transport is not an unspoofable same-origin security boundary.
						this.registerHostApiTransports();
						// Splits the ws-open→snapshot window into handshake vs. the
						// server-side snapshot wait that follows.
						bootMark("auth-ok");
						this._reconnectAttempt = 0;
						this._connectionEpoch++;
						this._setConnectionStatus("connected");
						resolve();
						// Initial hydration is owned by connectToSession after ChatPanel
						// binding. Reconnects still refresh the server workspace here and
						// then hydrate review content against authoritative tabs.
						if (!initial) {
							void hydrateSidePanelWorkspace(this._sessionId)
								.then(() => this.reconcileSubmittedReviewWorkspace());
						}
						// S2: deliver any prompts/steers/retries the user issued while
						// the socket was reconnecting, before resume/snapshot traffic.
						this._flushOutbox();
						// On reconnect, try a seq-based resume before falling back
						// to a full snapshot. If the server still holds our last seen
						// seq in its EventBuffer, it will replay only missed events
						// (each carrying their original seq so we dedupe naturally).
						// Otherwise it replies with resume_gap and we fall back below.
						if (!initial) {
							this._pendingReconnectNotif = true;
							if (this._highestSeq > 0) {
								this.send({ type: "resume", fromSeq: this._highestSeq });
							} else {
								this.requestMessages();
							}
							this.send({ type: "get_state" });
							// Re-fire session-scoped REST hydration that the initial
							// connect ran. The `resume` path replays only buffered
							// events and skips the snapshot-driven hydration in the
							// 'messages' handler — so without this, caches like
							// annotations, git status, and bg-processes go stale
							// after a transient WS drop.
							try { this.onReconnect?.(); } catch (err) {
								console.warn("[RemoteAgent] onReconnect handler threw:", err);
							}
							// (Removed the 3s _stateRetryTimer fallback — the server-side
							//  session_status heartbeat plus snapshot splice now keeps both
							//  status and model honest after reconnect.
							//  See docs/design/unify-session-status.md §4.9.)
						}
					} else if (msg.type === "auth_failed") {
						settled = true;
						if (initial) {
							reject(new Error("Authentication failed"));
						}
						return;
					} else if (msg.type === "error") {
						settled = true;
						if (msg.code === "SERVER_STARTING" || msg.code === "SERVER_SATURATED") {
							suppressCloseReconnect = true;
							const retry = new GatewayRetryError(
								typeof msg.message === "string" ? msg.message : "Gateway is temporarily unavailable. Retrying automatically…",
							);
							ws.close(1013, msg.code);
							if (initial) reject(retry);
							else {
								this._setConnectionStatus("starting");
								this._scheduleReconnect();
								resolve();
							}
							return;
						}
						if (initial) {
							reject(new Error(msg.message || "Connection error"));
						}
						return;
					}
				}

				this.handleServerMessage(msg).catch(() => {});
			};

			ws.onerror = () => {
				if (!settled) {
					settled = true;
					if (initial) {
						reject(new Error("WebSocket connection failed"));
					}
				}
			};

			ws.onclose = () => {
				// Mark that the WS dropped — the next visibility-driven resync
				// must run a fresh `requestMessages()` to pick up anything we
				// missed while disconnected.
				this._hadDisconnectSinceLastSnapshot = true;
				if (!settled) {
					settled = true;
					if (initial) {
						reject(new Error("Connection closed before auth"));
						return;
					}
				}
				// If this is still the current socket, drop registered Host API transports so
				// stale minters/posters cannot mask the background fallback during reconnect.
				if (this.ws === ws) {
					this.ws = null;
					this._unregisterHostApiTransports("session WebSocket closed");
				}
				// An explicit gateway retry schedules its own delay above; every other
				// unexpected close follows the normal reconnect path.
				if (!this._intentionalDisconnect && !suppressCloseReconnect) {
					this._setConnectionStatus("reconnecting");
					this._scheduleReconnect();
				}
			};
		});
	}

	private _setConnectionStatus(status: ConnectionStatus): void {
		if (this._connectionStatus === status) return;
		this._connectionStatus = status;
		this.onConnectionStatusChange?.(status);
	}

	private _prunePendingReviewToolCalls(now = Date.now()): void {
		for (const [id, pending] of this._pendingReviewToolCalls) {
			if (now - pending.recordedAt > REVIEW_TOOL_CALL_TTL_MS) this._pendingReviewToolCalls.delete(id);
		}
		while (this._pendingReviewToolCalls.size > REVIEW_TOOL_CALL_MAX_PENDING) {
			const oldestId = this._pendingReviewToolCalls.keys().next().value as string | undefined;
			if (!oldestId) break;
			this._pendingReviewToolCalls.delete(oldestId);
		}
	}

	private _rememberReviewToolCall(id: string, toolName: ReviewToolName): void {
		this._prunePendingReviewToolCalls();
		// Refresh insertion order if a provider reuses an ID for a new start.
		this._pendingReviewToolCalls.delete(id);
		this._pendingReviewToolCalls.set(id, { toolName, recordedAt: Date.now() });
		this._prunePendingReviewToolCalls();
	}

	private _scheduleReconnect(): void {
		if (this._intentionalDisconnect || this._reconnectTimer) return;

		const delay = this._nextReconnectDelay();
		this._reconnectAttempt++;

		this._reconnectTimer = setTimeout(async () => {
			this._reconnectTimer = null;
			if (this._intentionalDisconnect) return;
			try {
				await this._connectWs(false);
			} catch {
				// _connectWs failure on reconnect — onclose will fire and
				// schedule the next attempt automatically.
			}
		}, delay);
	}

	disconnect(): void {
		this._intentionalDisconnect = true;
		this._pendingReviewToolCalls.clear();
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		if (this._visibilityHandlerBound) {
			document.removeEventListener("visibilitychange", this._onVisibilityChange);
			this._visibilityHandlerBound = false;
		}
		this.ws?.close();
		this.ws = null;
		// Drop the registered WS transports + reject in-flight extension requests so a
		// torn-down session leaves no stale transport (re-registered on the next auth_ok).
		this._unregisterHostApiTransports("session disconnected");
		this._setConnectionStatus("disconnected");
	}

	// ── Event subscription (Agent interface) ─────────────────────────

	subscribe(fn: (event: any) => void): () => void {
		this.subscribers.push(fn);
		return () => {
			const idx = this.subscribers.indexOf(fn);
			if (idx >= 0) this.subscribers.splice(idx, 1);
		};
	}

	private emit(event: any) {
		for (const fn of this.subscribers) {
			fn(event);
		}
	}

	/** Dispatch an action to the message reducer and mirror the result. */
	private apply(action: Action): void {
		this.reducerState = reduce(this.reducerState, action);
		this._state.messages = this.reducerState.messages;
	}

	// ── Agent commands (proxied to gateway) ──────────────────────────

	async prompt(input: string | any | any[], _images?: any[], promptOpts?: { suppressTitleGen?: boolean }): Promise<void> {
		this._clearProviderAuthRequired();
		this.emit({ type: "render" });
		let text: string;
		let attachments: any[] | undefined;
		let imageData: any[] | undefined;

		if (typeof input === "string") {
			text = input;
		} else if (Array.isArray(input)) {
			text = input.map((m) => extractText(m)).join("\n");
		} else {
			text = extractText(input);
			// Preserve attachments from user-with-attachments messages
			if (input.role === "user-with-attachments" && input.attachments?.length) {
				attachments = input.attachments;
				// Extract image attachments as ImageContent objects for the LLM
				imageData = attachments
					?.filter((a: any) => a.type === "image" && a.content)
					.map((a: any) => ({ type: "image", data: a.content, mimeType: a.mimeType }));
			}
		}

		// Stash attachments so we can enrich the echoed user message
		this._pendingAttachments = attachments || null;
		// Skill expansions are server-resolved — only forward if the caller
		// attached them explicitly to the input message (e.g. tests / scripted
		// stories). Reset otherwise so a stale value doesn’t leak across turns.
		this._pendingSkillExpansions =
			typeof input === "object" && input && Array.isArray((input as any).skillExpansions)
				? (input as any).skillExpansions
				: null;

		const intentId = createIntentId();
		const createdAt = Date.now();
		const frame = {
			type: "prompt",
			intentId,
			text,
			...(imageData?.length ? { images: imageData } : {}),
			...(attachments?.length ? { attachments } : {}),
			// Assistant auto-kickoff prompts must not seed the session title —
			// naming fires on the first genuine user message instead.
			...(promptOpts?.suppressTitleGen ? { suppressTitleGen: true } : {}),
		};
		const row: QueuedMessage = {
			id: intentId,
			text,
			images: imageData,
			attachments,
			isSteered: false,
			kind: "prompt",
			targetTurn: "next-turn",
			deliveryState: "local",
			unsent: true,
			source: "user",
			author: LOCAL_USER_AUTHOR,
			createdAt,
		};
		await this._admitDeliveryIntent(frame, row);
	}

	steer(message: any): void {
		const text = typeof message === "string" ? message : extractText(message);
		const intentId = createIntentId();
		const row: QueuedMessage = {
			id: intentId,
			text,
			isSteered: true,
			kind: "steer",
			targetTurn: this._state.isStreaming ? "continuation" : "next-turn",
			deliveryState: "local",
			unsent: true,
			source: "user",
			author: LOCAL_USER_AUTHOR,
			createdAt: Date.now(),
		};
		// `steer` is a synchronous Agent API, but dispatch is deliberately held
		// behind the durable write. The row is visible synchronously; failure
		// becomes an actionable outbox state rather than a missing transcript row.
		void this._admitDeliveryIntent({ type: "steer", intentId, text }, row);
	}

	get isAborting(): boolean { return this._isAborting; }

	abort(): void {
		this._isAborting = true;
		this.send({ type: "abort" });
	}

	/** Retry after a model/API error. */
	retry(): void {
		this._clearProviderAuthRequired();
		this.send({ type: "retry" });
		this.emit({ type: "render" });
	}

	/** Retry one failed occurrence without changing its stable identity. */
	retryIntent(intentId: string): void {
		const projected = this._deliveryProjection.get(intentId)
			?? this._serverQueue.find((row) => row.id === intentId);
		// Abort-recovery cancellation is a durable fail-closed carrier, not a safe
		// resend affordance. Ignore stale-tab Retry clicks unless the authoritative
		// server projection explicitly marks this exact occurrence retryable.
		if (projected && (projected.deliveryState === "cancelled" || projected.retryable === false)) return;
		const local = this._pendingOutbox.find((entry) => entry.row?.id === intentId);
		if (local?.row && !projected && (local.row.retryable === false || local.mutationPending)) return;
		if (local?.row && !projected && (local.row.deliveryState === "failed" || !local.persisted)) {
			const retriedRow: QueuedMessage = {
				...local.row,
				deliveryState: "local",
				unsent: true,
			};
			delete retriedRow.deliveryReason;
			delete retriedRow.deliveryError;
			delete retriedRow.retryable;
			local.mutationPending = true;

			const persistRetry = local.persisted && this._sessionId && local.localRevision !== undefined
				? storage.deliveryIntents.replaceIfRevision(
					this._sessionId,
					intentId,
					local.localRevision,
					local.frame,
					persistedOutboxRow(retriedRow),
				)
				: storage.deliveryIntents.put(this._sessionId, intentId, local.frame, persistedOutboxRow(retriedRow))
					.then((result) => ({
						ok: result.ok,
						applied: result.ok,
						...(result.ok ? {
							current: {
								key: `${this._sessionId}:${intentId}`,
								sessionId: this._sessionId,
								intentId,
								frame: local.frame,
								row: persistedOutboxRow(retriedRow),
								revision: result.revision ?? 0,
								createdAt: retriedRow.createdAt,
								updatedAt: Date.now(),
							},
						} : {}),
					}));

			void persistRetry.then((result) => {
				local.mutationPending = false;
				if (!this._pendingOutbox.includes(local)) return;
				if (result.ok && result.applied && result.current) {
					this._applyPersistedLocalRecord(local, result.current);
					local.lastSentEpoch = undefined;
					this._sendOutboxEntry(local);
					this.onQueueUpdate?.(this.getQueue());
					return;
				}
				if (result.ok && !result.applied) {
					this._reconcileConditionalMutation(local, result.current);
					return;
				}
				local.retryRequired = true;
				local.row!.deliveryState = "failed";
				local.row!.unsent = false;
				local.row!.retryable = false;
				local.row!.deliveryError = "This message could not be saved for reliable delivery.";
				this.onQueueUpdate?.(this.getQueue());
			});
			return;
		}
		this.send({ type: "retry_intent", intentId });
	}

	compact(): void {
		this.send({ type: "compact" });
	}

	/**
	 * Best-effort sample of current context-token usage. Walks the transcript
	 * backwards for the latest assistant message carrying `usage`, mirroring
	 * the calculation in `AgentInterface.ts::contextHtml`. Returns null when
	 * no usage row is available.
	 */
	private _readContextTokens(): number | null {
		try {
			const msgs = this._state?.messages;
			if (!Array.isArray(msgs)) return null;
			for (let i = msgs.length - 1; i >= 0; i--) {
				const m = msgs[i] as any;
				if (
					m?.role === "assistant"
					&& m.usage
					&& m.stopReason !== "aborted"
					&& m.stopReason !== "error"
				) {
					const u = m.usage;
					const total = u.totalTokens
						|| ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
					if (typeof total === "number" && Number.isFinite(total) && total > 0) {
						this._lastKnownContextTokens = total;
						return total;
					}
					return null;
				}
			}
		} catch {
			/* swallow — best effort */
		}
		return null;
	}

	/**
	 * Inject a RICH in-progress compaction synthetic into the message list.
	 * Replaces the legacy plaintext "Compacting context…" row — the renderer
	 * now drives the in-progress state itself. Used by both the live
	 * `compaction_start` path and the reconnect-path (~line 1109) when the
	 * server tells us compaction is still in progress on resume.
	 */
	private _addCompactingPlaceholder(trigger: CompactionTrigger = "manual"): void {
		const tokensBefore = this._readContextTokens() ?? this._lastKnownContextTokens;
		if (tokensBefore != null) this._lastKnownContextTokens = tokensBefore;
		const payload = buildInProgressCompactionPayload(trigger, tokensBefore);
		const { message } = buildCompactionSummaryMessages(payload);
		this.apply({ type: "compaction-placeholder", message: withClientSystemAuthor(message) });
	}

	/**
	 * Try to amend the most recent compaction card with an authoritative
	 * `tokensAfter` read from the latest clean assistant `usage` in the
	 * transcript. Fires from both the live `message_end` path and after a
	 * `messages` snapshot apply (the post-compaction state refresh from the
	 * server reaches us as a snapshot, not as live events). No-op when no
	 * amend is pending. Clears the pending state on success so we don't
	 * thrash.
	 */
	private _tryAmendPendingCompaction(): void {
		const prev = this._pendingCompactionAmend;
		if (!prev) return;
		const totalAfter = this._readContextTokens();
		if (totalAfter == null || !Number.isFinite(totalAfter) || totalAfter <= 0) return;
		const tb = prev.tokensBefore;
		const reductionPct =
			tb && tb > 0 ? Math.round(((tb - totalAfter) / tb) * 1000) / 10 : null;
		const amended: CompactionSummaryPayload = {
			...prev,
			tokensAfter: totalAfter,
			reductionPct,
		};
		const { message: am, toolResult: atr } = buildCompactionSummaryMessages(amended);
		this.apply({
			type: "compaction-result",
			message: withClientSystemAuthor(am),
			success: amended.success,
			toolResult: withClientSystemAuthor(atr),
		});
		this._lastKnownContextTokens = totalAfter;
		this._pendingCompactionAmend = null;
	}

	/** Map upstream event `reason` (or legacy event-type) to a trigger. */
	private _triggerFromEvent(event: any): CompactionTrigger {
		const reason = event?.reason;
		if (reason === "overflow") return "overflow";
		if (reason === "threshold") return "auto";
		if (reason === "manual") return "manual";
		if (event?.type === "auto_compaction_start" || event?.type === "auto_compaction_end")
			return "auto";
		return "manual";
	}

	requestMessages(): void {
		bootMark("get-messages-sent");
		this.send({ type: "get_messages" });
	}

	/** Defer proposal checking on incoming messages until unlocked. */
	deferProposalCheck(): void {
		this._deferProposalCheck = true;
		this._hasDeferredProposals = false;
	}

	/** Run deferred proposal checks now (after draft restores are complete). */
	runDeferredProposalCheck(): void {
		this._deferProposalCheck = false;
		if (this._hasDeferredProposals) {
			this._hasDeferredProposals = false;
			this._scanLoadedProposalMessages();
		}
	}

	private _scanLoadedProposalMessages(): void {
		for (const m of this._state.messages) {
			if (m.role === "assistant") {
				const normalizedMessage = normalizeProposalToolCallInputs(m, (id) => this._toolCallInputsById.get(id));
				this._checkToolProposals(normalizedMessage);
				this._checkProposals(normalizedMessage);
			} else {
				this._checkProposalToolResult(m);
			}
		}
	}

	async continue(): Promise<void> {}

	async waitForIdle(): Promise<void> {
		if (this._state.status !== "streaming") return;
		return new Promise<void>((resolve) => {
			const unsub = this.subscribe((ev) => {
				if (ev.type === "agent_end") {
					unsub();
					resolve();
				}
			});
		});
	}

	reset(): void {
		this.reducerState = initialState();
		this._state.messages = this.reducerState.messages;
		this.subagentWorkByParent = new Map();
		this._state.subagentWorkByParent = this.subagentWorkByParent;
		this._state.streamingMessage = null;
		this.streamingMessageId = undefined;
		this._state.status = "idle";
		this._state.runtime = undefined;
		this._state.modelAvailable = undefined;
		this._lastStatusVersion = -1;
		this._isAborting = false;
		this._state.pendingToolCalls = new Set();
		this._pendingReviewToolCalls.clear();
		this._state.error = undefined;
		this._state.turnStartTime = null;
		this._state.providerAuthRequired = null;
		this._state.condition = null;
		this._state.modelSelectionPending = null;
		this._state.modelSelectionError = null;
		this._conditionSnapshotReceived = false;
		this._pendingAttachments = null;
		this._pendingSkillExpansions = null;
		this._assistantStreamDeltaEnabled = false;
		this._previousRawAssistantStreamMessage = undefined;
		this._highestSeq = 0;
		this._seqInitialized = false;
		this._pendingEvents = [];
		this._inResumeFallback = false;
		// Cross-session isolation: clear per-tag streaming flags so navigating
		// to another session always starts with all flags false.
		for (const k of Object.keys(state.proposalStreamingByTag)) {
			state.proposalStreamingByTag[k] = false;
		}
		this._streamingProposalBlockIdByTag = {};
	}

	/** Drain any pending out-of-order events whose predecessor has now arrived. */
	private _drainOrderedEvents(): void {
		while (this._pendingEvents.length > 0 && this._pendingEvents[0].seq === this._highestSeq + 1) {
			const next = this._pendingEvents.shift()!;
			this._highestSeq = next.seq;
			this.handleAgentEvent(next.data);
		}
		// Drop any stale entries already at/below highestSeq (safety).
		while (this._pendingEvents.length > 0 && this._pendingEvents[0].seq <= this._highestSeq) {
			this._pendingEvents.shift();
		}
	}

	/**
	 * Advance the global server sequence for top-level frames that consume an
	 * EventBuffer seq but are not wrapped as `{ type: "event" }`.
	 *
	 * `tool_permission_needed` is the important case: the server uses
	 * `eventBuffer.pushFrame()` so later normal agent events have higher seqs.
	 * If the client renders the permission card without advancing `_highestSeq`,
	 * the next event is buffered forever as a gap and streaming appears to stop.
	 */
	private _advanceTopLevelSeq(seq: number, frameType: string): boolean {
		if (!this._seqInitialized) {
			// Same first-frame baseline as the event path: anything before this frame
			// is represented by the initial snapshot / resume fallback.
			this._highestSeq = seq - 1;
			this._seqInitialized = true;
		}
		if (seq <= this._highestSeq) {
			// Duplicate top-level frame; do not apply side effects twice.
			return false;
		}
		if (seq !== this._highestSeq + 1) {
			// We cannot buffer this top-level side-effect frame behind missing event
			// frames, so accept it, force a snapshot for the missing range, and let
			// future events continue from this seq. This mirrors the overflow/gap
			// fallback strategy in the event path.
			console.warn(`[RemoteAgent] ${frameType} seq gap (${this._highestSeq} → ${seq}); forcing snapshot refresh`);
			this._pendingEvents = [];
			this._inResumeFallback = true;
			this._highestSeq = seq;
			this.requestMessages();
			return true;
		}
		this._highestSeq = seq;
		return true;
	}

	// ── Setters (Agent interface) ────────────────────────────────────

	setModel(model: any, thinkingLevel?: string): void {
		if (this._state.modelSelectionPending) return;
		const effectiveThinking = thinkingLevel ?? this._state.thinkingLevel;
		const recoveryCondition = modelSelectionRequiredCondition(this._state.condition);
		if (recoveryCondition) {
			// Recovery is verified server-side. Keep the retired tuple visible until an
			// explicit state publication clears the condition and publishes the replacement.
			this._state.modelSelectionPending = { provider: model.provider, modelId: model.id };
			this._state.modelSelectionError = null;
		} else {
			this._state.model = model;
			this._state.thinkingLevel = effectiveThinking as any;
		}
		this._clearProviderAuthRequired();
		this.send({
			type: "set_model",
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: effectiveThinking,
		});
		state.chatPanel?.agentInterface?.requestUpdate();
		this.emit({ type: "render" });
	}

	setThinkingLevel(level: any): void {
		if (modelSelectionRequiredCondition(this._state.condition)) return;
		this._state.thinkingLevel = level;
		this.send({ type: "set_thinking_level", level });
		state.chatPanel?.agentInterface?.requestUpdate();
	}

	setImageGenerationModel(model: any): void {
		this._state.imageGenerationModel = model;
		this.send({ type: "set_image_model", provider: model.provider, modelId: model.id });
		state.chatPanel?.agentInterface?.requestUpdate();
	}

	setTools(_tools: any[]): void {
		// no-op: tools are server-side for the coding agent
	}

	grantToolPermission(toolName: string, scope: "tool" | "group", group?: string, lastPromptText?: string, mode?: "persistent" | "session-only" | "one-time", permissionId?: string): void {
		// The guard long-poll/server grant path owns resuming the blocked tool call.
		// Re-sending lastPromptText here would create a fresh user turn and can
		// duplicate side-effecting tools such as session_prompt.
		void lastPromptText;
		this.apply({ type: "permission-status", toolName, status: "granting", actionable: true });
		this.send({ type: "grant_tool_permission", toolName, scope, group, mode, permissionId });
		this.emit({ type: "render" });
	}

	denyToolPermission(messageId: string, toolName?: string): void {
		// Notify the server so the guard extension's long-poll resolves immediately
		if (toolName) {
			this.send({ type: "deny_tool_permission", toolName, permissionId: messageId });
		}
		this.apply({ type: "deny-permission-filter", messageId });
		this.emit({ type: "render" });
	}

	setSystemPrompt(prompt: string): void {
		this._state.systemPrompt = prompt;
	}

	replaceMessages(msgs: any[]): void {
		this.apply({ type: "replace-messages", messages: msgs });
	}

	/**
	 * Lookup answers for a posted ask_user_choices tool_use by scanning the
	 * transcript for a matching `[ask_user_choices_response ...]` envelope user
	 * message. Returns the parsed answers array, or null if not yet submitted.
	 */
	findAskResponseAnswers(toolUseId: string): AskResponseAnswer[] | null {
		return _findAskResponseAnswers(this._state.messages, toolUseId);
	}

	appendMessage(msg: any): void {
		// This path currently appends local user commands such as `/compact`.
		// Preserve an explicit server author, otherwise use the local-human fallback.
		this.apply({
			type: "system-notification",
			message: { author: LOCAL_USER_AUTHOR, ...msg },
		});
	}

	setTitle(title: string): void {
		this._title = title;
		this.send({ type: "set_title", title });
		this.onTitleChange?.(title);
	}

	generateTitle(): void {
		this.send({ type: "generate_title" });
	}

	summarizeGoalTitle(goalTitle: string): void {
		this.send({ type: "summarize_goal_title", goalTitle });
	}

	clearSteeringQueue(): void {}
	clearFollowUpQueue(): void {}
	clearAllQueues(): void {}
	hasQueuedMessages(): boolean {
		return this.getQueue().length > 0;
	}

	/** One ID-keyed projection across server queue/ledger state and the durable
	 * pre-acceptance spool. Server rows win without changing occurrence order. */
	getQueue(): QueuedMessage[] {
		const rows: QueuedMessage[] = [];
		const seen = new Set<string>();
		for (const row of [...this._serverQueue, ...this._deliveryProjection.values()]) {
			if (!row?.id || seen.has(row.id)) continue;
			seen.add(row.id);
			rows.push(row);
		}
		for (const entry of this._pendingOutbox) {
			const row = entry.row;
			if (!row?.id || seen.has(row.id)) continue;
			seen.add(row.id);
			rows.push(row);
		}
		return rows;
	}

	/** Ask the server to promote a queued message to a steer. */
	steerQueued(messageId: string): void {
		this.send({ type: "steer_queued", messageId });
	}

	/** Remove a never-sent or definitively pre-admission-rejected local occurrence.
	 * Once a frame may have reached server admission, retain its carrier until a
	 * durable cancellation receipt. */
	removeQueued(messageId: string): void {
		const idx = this._pendingOutbox.findIndex((e) => e.row?.id === messageId);
		const hasServerProjection = this._deliveryProjection.has(messageId)
			|| this._serverQueue.some((row) => row.id === messageId);
		const local = idx === -1 ? undefined : this._pendingOutbox[idx];
		if (local && !hasServerProjection && (local.lastSentEpoch === undefined || local.retryRequired === true)) {
			if (local.mutationPending) return;
			if (local.persisted && this._sessionId && local.localRevision !== undefined) {
				const renderedRevision = local.localRevision;
				local.mutationPending = true;
				void storage.deliveryIntents.deleteIfRevision(this._sessionId, messageId, renderedRevision)
					.then((result) => {
						local.mutationPending = false;
						if (!this._pendingOutbox.includes(local)) return;
						if (result.ok && result.applied && local.localRevision === renderedRevision) {
							this._pendingOutbox = this._pendingOutbox.filter((entry) => entry !== local);
							this.onQueueUpdate?.(this.getQueue());
							return;
						}
						if (result.ok && !result.applied) this._reconcileConditionalMutation(local, result.current);
					});
				return;
			}
			this._pendingOutbox.splice(idx, 1);
			this.onQueueUpdate?.(this.getQueue());
			return;
		}
		this.send({ type: "remove_queued", messageId });
	}

	/** Ask the server to reorder the queue. */
	reorderQueue(messageIds: string[]): void {
		this.send({ type: "reorder_queue", messageIds });
	}

	/** Ask the server to restart the agent process for this session. */
	restartAgent(): void {
		this.send({ type: "restart_agent" });
	}

	// ── Internal ─────────────────────────────────────────────────────

	/**
	 * Drive the C2 session WRITE (`host.session.postMessage`) over this agent's
	 * authenticated WebSocket (registered with session-write-bridge.ts on auth_ok).
	 * The server ignores `req.sessionId` as a target and posts into its own
	 * authenticated session.
	 *
	 * TWO permit-bound round-trips (design §8 C2.1): first MINT a server-minted,
	 * one-time, content-bound write permit (bound to `req.contentHash`), then send the
	 * post carrying the returned nonce. A captured/replayed post frame is rejected
	 * (permit already consumed); a forged post without a mint has no valid nonce.
	 */
	private async _postExtSession(req: SessionPostRequest): Promise<void> {
		const nonce = await this._mintExtWritePermit(req);
		return this._sendExtSessionPost(req, nonce);
	}

	/** Mint a pack-bound surface token over the session WS. The frame carries no
	 *  session id; the server binds the token to this authenticated connection. */
	private _mintPackSurfaceToken(surface: PackSurfaceRef): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			if (this.ws?.readyState !== WebSocket.OPEN) {
				reject(new Error("pack surface-token mint: WebSocket not connected"));
				return;
			}
			if (!this._surfaceTokenAuthorityKey) {
				reject(new Error("pack surface-token mint: app surface-token key unavailable"));
				return;
			}
			const requestId = `extsurface_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const timer = setTimeout(() => {
				if (this._pendingExtSurfaceTokens.delete(requestId)) {
					reject(new Error("pack surface-token mint: timed out awaiting token"));
				}
			}, 30_000);
			this._pendingExtSurfaceTokens.set(requestId, {
				resolve: (token: string) => { clearTimeout(timer); resolve(token); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			try {
				this.ws.send(JSON.stringify({
					type: "ext_surface_token",
					requestId,
					surfaceTokenKey: this._surfaceTokenAuthorityKey,
					packId: surface.packId,
					contributionKind: surface.contributionKind,
					contributionId: surface.contributionId,
				}));
			} catch (e) {
				this._pendingExtSurfaceTokens.delete(requestId);
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/** Step 1: mint a content-bound write permit over the session WS. Resolves with
	 *  the opaque nonce; rejects on server error / timeout / not-connected. */
	private _mintExtWritePermit(req: SessionPostRequest): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			if (this.ws?.readyState !== WebSocket.OPEN) {
				reject(new Error("host.session.postMessage: WebSocket not connected"));
				return;
			}
			const requestId = `extperm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const timer = setTimeout(() => {
				if (this._pendingExtPermits.delete(requestId)) {
					reject(new Error("host.session.postMessage: timed out awaiting write permit"));
				}
			}, 30_000);
			this._pendingExtPermits.set(requestId, {
				resolve: (nonce: string) => { clearTimeout(timer); resolve(nonce); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			try {
				this.ws.send(JSON.stringify({
					type: "ext_session_write_permit",
					requestId,
					surfaceToken: req.surfaceToken,
					contentHash: req.contentHash,
				}));
			} catch (e) {
				this._pendingExtPermits.delete(requestId);
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/** Step 2: send the post carrying the minted nonce. Correlates the async
	 *  `ext_session_post_result` ack by a generated `requestId`. */
	private _sendExtSessionPost(req: SessionPostRequest, nonce: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (this.ws?.readyState !== WebSocket.OPEN) {
				reject(new Error("host.session.postMessage: WebSocket not connected"));
				return;
			}
			const requestId = `extpost_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const timer = setTimeout(() => {
				if (this._pendingExtPosts.delete(requestId)) {
					reject(new Error("host.session.postMessage: timed out awaiting server ack"));
				}
			}, 30_000);
			this._pendingExtPosts.set(requestId, {
				resolve: () => { clearTimeout(timer); resolve(); },
				reject: (e) => { clearTimeout(timer); reject(e); },
			});
			try {
				this.ws.send(JSON.stringify({
					type: "ext_session_post",
					requestId,
					surfaceToken: req.surfaceToken,
					role: req.role,
					text: req.text,
					resumeTurn: req.resumeTurn,
					nonce,
				}));
			} catch (e) {
				this._pendingExtPosts.delete(requestId);
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		});
	}

	/** Reject and clear every in-flight session post + permit mint (call on
	 *  disconnect/teardown). */
	private _rejectPendingExtPosts(reason: string): void {
		const pendingPosts = [...this._pendingExtPosts.values(), ...this._pendingExtPermits.values()];
		const pendingSurfaceTokens = [...this._pendingExtSurfaceTokens.values()];
		this._pendingExtPosts.clear();
		this._pendingExtPermits.clear();
		this._pendingExtSurfaceTokens.clear();
		for (const p of pendingPosts) p.reject(new Error(`host.session.postMessage: ${reason}`));
		for (const p of pendingSurfaceTokens) p.reject(new Error(`pack surface-token mint: ${reason}`));
	}

	private _applyPersistedLocalRecord(entry: PendingOutboxEntry, record: PersistedDeliveryIntent): boolean {
		if (
			!record?.frame
			|| !record?.row
			|| record.intentId !== (record.row as any).id
			|| deliveryIntentId(record.frame) !== record.intentId
		) return false;
		const restoredState = (record.row as any).deliveryState;
		const retryRequired = restoredState === "failed";
		entry.frame = record.frame;
		entry.row = {
			...(record.row as any),
			deliveryState: retryRequired ? "failed" : "local",
			unsent: !retryRequired,
		};
		entry.persisted = true;
		entry.localRevision = Number.isSafeInteger(record.revision) && record.revision >= 0 ? record.revision : 0;
		entry.retryRequired = retryRequired;
		return true;
	}

	/** A losing CAS adopts the newer shared carrier instead of deleting it. An
	 * absent record is not proof of transcript surfacing: a different tab may
	 * already have transferred ownership to the server, so this tab retains its
	 * visible row until its own authoritative projection arrives. */
	private _reconcileConditionalMutation(
		entry: PendingOutboxEntry,
		current?: PersistedDeliveryIntent,
	): void {
		const renderedRevision = entry.localRevision ?? -1;
		if (current && this._applyPersistedLocalRecord(entry, current)) {
			const adoptedNewerLocal = (entry.localRevision ?? 0) > renderedRevision && !entry.retryRequired;
			if (adoptedNewerLocal) {
				// The writer can close after committing this revision but before sending.
				// Any connected tab that adopts the local carrier may take over immediately;
				// duplicate frames are safe because server admission is occurrence-idempotent.
				entry.lastSentEpoch = undefined;
				this._sendOutboxEntry(entry);
			}
		}
		this.onQueueUpdate?.(this.getQueue());
	}

	private async _restoreDeliveryOutbox(): Promise<void> {
		const restored = await storage.deliveryIntents.list(this._sessionId);
		for (const record of restored) {
			if (
				!record?.frame
				|| !record?.row
				|| record.intentId !== (record.row as any).id
				|| deliveryIntentId(record.frame) !== record.intentId
			) continue;
			if (this._pendingOutbox.some((entry) => entry.row?.id === record.intentId)) continue;
			const entry: PendingOutboxEntry = { frame: record.frame };
			if (this._applyPersistedLocalRecord(entry, record)) this._pendingOutbox.push(entry);
		}
	}

	private async _admitDeliveryIntent(frame: any, row: QueuedMessage): Promise<void> {
		const entry: PendingOutboxEntry = { frame, row };
		this._pendingOutbox.push(entry);
		this.onQueueUpdate?.(this.getQueue());

		const result = this._pendingOutbox.filter((candidate) => !!candidate.row).length > RemoteAgent.OUTBOX_MAX
			? { ok: false as const, reason: "session-full" as const }
			: !this._sessionId
				// Unit harnesses may exercise an unbound agent; production agents are
				// always session-bound before composer admission.
				? { ok: true as const }
				: await storage.deliveryIntents.put(this._sessionId, row.id, frame, persistedOutboxRow(row));
		if (!this._pendingOutbox.includes(entry)) {
			if (result.ok) void storage.deliveryIntents.delete(this._sessionId, row.id);
			return;
		}
		if (!result.ok) {
			row.deliveryState = "failed";
			row.unsent = false;
			row.retryable = false;
			row.deliveryError = result.reason === "entry-too-large"
				? "Message is too large to save for reliable delivery."
				: result.reason === "session-full" || result.reason === "storage-full"
					? "Reliable delivery storage is full. Remove another pending message and try again."
					: "This message could not be saved for reliable delivery.";
			this.onQueueUpdate?.(this.getQueue());
			return;
		}
		entry.persisted = true;
		entry.localRevision = result.revision ?? 0;
		this._sendOutboxEntry(entry);
	}

	private _sendOutboxEntry(entry: PendingOutboxEntry): boolean {
		if (!entry.persisted || entry.retryRequired || entry.lastSentEpoch === this._connectionEpoch) return false;
		if (this._sessionId && this._connectionStatus !== "connected") return false;
		if (this.ws?.readyState !== WebSocket.OPEN) return false;
		try {
			this.ws.send(JSON.stringify(entry.frame));
			entry.lastSentEpoch = this._connectionEpoch;
			if (entry.row) entry.row.unsent = false;
			return true;
		} catch {
			return false;
		}
	}

	/** Move only an exclusively local occurrence into an actionable failed state.
	 * A server projection means ownership has already transferred and a late error
	 * from another socket generation must not regress it. */
	private async _markLocalIntentRejected(msg: any): Promise<boolean> {
		const intentId = deliveryIntentId(msg);
		if (!intentId || this._deliveryProjection.has(intentId)
			|| this._serverQueue.some((row) => row.id === intentId)) return false;
		const entry = this._pendingOutbox.find((candidate) => candidate.row?.id === intentId);
		if (!entry?.row) return false;

		entry.row.deliveryState = "failed";
		entry.row.unsent = false;
		entry.row.retryable = msg.retryable !== false;
		entry.row.deliveryReason = typeof msg.code === "string" ? msg.code.slice(0, 128) : "PRE_ADMISSION_REJECTED";
		entry.row.deliveryError = typeof msg.message === "string" && msg.message
			? msg.message.slice(0, 1_000)
			: "This message was not accepted by the server.";
		entry.lastSentEpoch = undefined;
		entry.retryRequired = true;
		this.onQueueUpdate?.(this.getQueue());

		if (entry.persisted && this._sessionId && entry.localRevision !== undefined) {
			const result = await storage.deliveryIntents.replaceIfRevision(
				this._sessionId,
				intentId,
				entry.localRevision,
				entry.frame,
				persistedOutboxRow(entry.row),
			);
			if (result.ok && result.applied && result.current) {
				this._applyPersistedLocalRecord(entry, result.current);
			} else if (result.ok && !result.applied) {
				this._reconcileConditionalMutation(entry, result.current);
			} else {
				entry.row.retryable = false;
				entry.row.deliveryError = "The server rejected this message, but its failed state could not be saved. Dismiss it or copy the text before reloading.";
				this.onQueueUpdate?.(this.getQueue());
			}
		}
		return true;
	}

	private _rememberSettledIntent(intentId: string): void {
		this._settledDeliveryIntentIds.add(intentId);
		if (this._settledDeliveryIntentIds.size > 2_048) {
			this._settledDeliveryIntentIds.delete(this._settledDeliveryIntentIds.values().next().value!);
		}
	}

	private _mergeDeliveryProjection(row: QueuedMessage): void {
		if (this._settledDeliveryIntentIds.has(row.id)) return;
		const previous = this._deliveryProjection.get(row.id);
		if (previous) {
			const priorRank = DELIVERY_STATE_RANK[previous.deliveryState ?? "queued"];
			const nextRank = DELIVERY_STATE_RANK[row.deliveryState ?? "queued"];
			const provenRedrive = row.deliveryState === "queued"
				&& (row.deliveryReason === "retry-requested"
					|| row.deliveryReason === "continuation-aborted"
					|| row.deliveryReason === "proven-no-start");
			if (nextRank < priorRank && !provenRedrive) return;
		}
		this._deliveryProjection.set(row.id, row);
	}

	private _acceptProjectedRows(rows: any[]): QueuedMessage[] {
		const acceptedIds = new Set<string>();
		const normalized: QueuedMessage[] = [];
		for (const raw of rows) {
			const id = typeof raw?.id === "string" ? raw.id : deliveryIntentId(raw);
			if (!id || this._settledDeliveryIntentIds.has(id)) continue;
			acceptedIds.add(id);
			const state = raw?.deliveryState ?? raw?.state;
			const deliveryState = state === "local" || state === "queued" || state === "dispatching"
				|| state === "received" || state === "uncertain" || state === "failed" || state === "cancelled"
				? state as DeliveryState
				: undefined;
			normalized.push({
				...raw,
				id,
				...(deliveryState ? { deliveryState } : {}),
				unsent: false,
			} as QueuedMessage);
		}
		if (acceptedIds.size > 0) {
			this._pendingOutbox = this._pendingOutbox.filter((entry) => {
				const id = entry.row?.id;
				if (!id || !acceptedIds.has(id)) return true;
				void storage.deliveryIntents.delete(this._sessionId, id);
				return false;
			});
		}
		return normalized;
	}

	private _replaceDeliveryProjection(rows: any[]): void {
		const normalized = this._acceptProjectedRows(rows);
		// Absence is not settlement: the server may publish the post-receipt empty
		// projection immediately before the correlated user event on the same
		// socket. Retain old carriers until `_settleSurfacedIntent` runs, avoiding
		// a one-frame gap. Explicit failed/cancelled updates remain renderable too.
		for (const row of normalized) this._mergeDeliveryProjection(row);
		this.onQueueUpdate?.(this.getQueue());
	}

	private _updateDeliveryProjection(raw: any): void {
		const id = typeof raw?.id === "string" ? raw.id : deliveryIntentId(raw);
		if (!id) return;
		const local = this._pendingOutbox.find((entry) => entry.row?.id === id)?.row;
		const previous = this._deliveryProjection.get(id) ?? local;
		if (!previous && typeof raw?.text !== "string") return;
		const [normalized] = this._acceptProjectedRows([{ ...previous, ...raw, id }]);
		if (normalized) this._mergeDeliveryProjection(normalized);
		this.onQueueUpdate?.(this.getQueue());
	}

	private _settleSurfacedIntent(intentId: string): void {
		this._rememberSettledIntent(intentId);
		let changed = this._deliveryProjection.delete(intentId);
		const beforeServer = this._serverQueue.length;
		this._serverQueue = this._serverQueue.filter((row) => row.id !== intentId);
		changed = changed || beforeServer !== this._serverQueue.length;
		const beforeLocal = this._pendingOutbox.length;
		this._pendingOutbox = this._pendingOutbox.filter((entry) => entry.row?.id !== intentId);
		changed = changed || beforeLocal !== this._pendingOutbox.length;
		void storage.deliveryIntents.delete(this._sessionId, intentId);
		if (changed) this.onQueueUpdate?.(this.getQueue());
	}

	private send(msg: any): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
			return;
		}
		// Prompt and steer admission use `_admitDeliveryIntent`; retry remains a
		// body-free transient control which can safely wait for reconnect.
		if (msg?.type === "retry") {
			const controls = this._pendingOutbox.filter((entry) => !entry.row);
			if (controls.length < RemoteAgent.OUTBOX_MAX) this._pendingOutbox.push({ frame: msg, persisted: true });
			return;
		}
		console.warn("[RemoteAgent] Message dropped (WS not open):", msg.type, "readyState:", this.ws?.readyState);
	}

	/** Resend every still-preacceptance occurrence once per authenticated socket.
	 * Entries remain durable and visible after `WebSocket.send()`; only a matching
	 * server projection may move ownership out of this spool. */
	private _flushOutbox(): void {
		if (this._pendingOutbox.length === 0) return;
		for (const entry of [...this._pendingOutbox]) {
			if (entry.row) {
				this._sendOutboxEntry(entry);
				continue;
			}
			if (this.ws?.readyState !== WebSocket.OPEN) break;
			try {
				this.ws.send(JSON.stringify(entry.frame));
				const idx = this._pendingOutbox.indexOf(entry);
				if (idx >= 0) this._pendingOutbox.splice(idx, 1);
			} catch {
				break;
			}
		}
		this.onQueueUpdate?.(this.getQueue());
	}

	private async handleServerMessage(msg: any) {
		if (shouldRefreshGateStatusForEvent(msg)) {
			scheduleGateStatusRefreshForGoal((msg as any).goalId);
		}
		switch (msg.type) {
			case "ext_surface_token_result": {
				const pending = this._pendingExtSurfaceTokens.get(msg.requestId);
				if (pending) {
					this._pendingExtSurfaceTokens.delete(msg.requestId);
					if (msg.ok && typeof msg.token === "string" && msg.token) pending.resolve(msg.token);
					else pending.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "pack surface-token mint denied"));
				}
				break;
			}
			case "ext_session_write_permit_result": {
				// Async reply to a C2 write-permit MINT (step 1). Settle the correlated
				// promise with the opaque nonce (resolve) or the server-side error (reject).
				const pendingPermit = this._pendingExtPermits.get(msg.requestId);
				if (pendingPermit) {
					this._pendingExtPermits.delete(msg.requestId);
					if (msg.ok && typeof msg.nonce === "string" && msg.nonce) pendingPermit.resolve(msg.nonce);
					else pendingPermit.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "host.session.postMessage: write permit denied"));
				}
				break;
			}
			case "ext_session_post_result": {
				// Async ack for a C2 session WRITE (`host.session.postMessage`). Settle the
				// correlated promise (resolve on ok, reject with the server-side error).
				const pending = this._pendingExtPosts.get(msg.requestId);
				if (pending) {
					this._pendingExtPosts.delete(msg.requestId);
					if (msg.ok) pending.resolve();
					else pending.reject(new Error(typeof msg.error === "string" && msg.error ? msg.error : "host.session.postMessage failed"));
				}
				break;
			}
			case "state": {
				const runtime = sessionRuntimeFromWire(msg.data?.runtime);
				const modelAvailable = modelAvailabilityFromWire(msg.data?.modelAvailable);
				this._applySessionIdentity(runtime, modelAvailable);
				// Canonical-status path (new server). When the server splices
				// `status` + `statusVersion` into the snapshot, prime our tracker
				// so subsequent live frames are version-checked correctly.
				if (typeof msg.data?.status === "string") {
					this._state.status = msg.data.status;
					if (typeof msg.data.statusVersion === "number") {
						this._lastStatusVersion = msg.data.statusVersion;
					}
				} else if (msg.data?.isStreaming !== undefined) {
					// Back-compat: older server still emits `isStreaming` only.
					// Map onto canonical status; live `session_status` frames
					// (sent right after auth_ok) carry the version we'll then track.
					this._state.status = msg.data.isStreaming ? "streaming" : "idle";
				}
				if (msg.data?.archived) {
					this._state.archivedAt = msg.data.archivedAt;
					// Status will already be "archived" via the branch above; if not
					// (legacy server payload), force it so the derived getter agrees.
					if (this._state.status !== "archived") this._state.status = "archived";
				}
				// Condition changes are authoritative only when explicitly present. Partial
				// state_update events must not accidentally unblock the composer.
				if (msg.data && Object.prototype.hasOwnProperty.call(msg.data, "condition")) {
					this._conditionSnapshotReceived = true;
					this._state.condition = modelSelectionRequiredCondition(msg.data.condition);
					this._state.modelSelectionPending = null;
					if (!this._state.condition) this._state.modelSelectionError = null;
				}
				// Always update model from server state (keeps context window accurate after compaction)
				if (msg.data?.model) {
					this._state.model = msg.data.model;
				}
				if (msg.data?.thinkingLevel) {
					this._state.thinkingLevel = msg.data.thinkingLevel;
				}
				if (msg.data?.imageGenerationModel) {
					this._state.imageGenerationModel = msg.data.imageGenerationModel;
				}
				if (msg.data && Object.prototype.hasOwnProperty.call(msg.data, "serverCost")) {
					this._state.serverCost = msg.data.serverCost ?? null;
					if (this._state.serverCost) {
						this.emit({ type: "cost_update" as any, cost: this._state.serverCost });
					}
				}
				this.emit({ type: "state_update", data: msg.data });
				break;
			}

			case "messages": {
				const msgs = Array.isArray(msg.data) ? msg.data : msg.data?.messages;
				if (Array.isArray(msgs)) {
					// The server snapshot is an envelope for SDK sessions. Partition child
					// rows before the root reducer sees them; old servers can still send
					// parentToolUseId rows in `messages`, which are handled identically.
					const projection = projectClaudeSdkSubagentSnapshot(
						msgs,
						Array.isArray(msg.data) ? undefined : msg.data?.subagentWork,
						this.subagentWorkByParent,
					);
					this.subagentWorkByParent = projection.subagentWorkByParent;
					this._state.subagentWorkByParent = this.subagentWorkByParent;
					const rootMessages = projection.rootMessages;
					// Boot-timing: bracket the get_state snapshot replay — the cost
					// that scales with transcript length. Opt-in; no-op when disarmed.
					bootTimingMeta({ sessionId: this._sessionId, transcriptMessages: rootMessages.length });
					bootMark(`snapshot-received(${rootMessages.length} msgs)`);

					// In-flight rows are server recovery projections, never correlated Pi
					// user-message surfacing. Keep child rows partitioned before the outbox
					// projection, so they cannot be rendered or settled as root work.
					const recoveryRows: QueuedMessage[] = [];
					const transcriptRows: any[] = [];
					for (const message of rootMessages) {
						if (isDeliveryRecoveryProjection(message)) {
							const row = deliveryRecoveryOutboxRow(message);
							if (row) {
								recoveryRows.push(row);
								continue;
							}
						}
						transcriptRows.push(message);
					}
					const recovered = this._acceptProjectedRows(recoveryRows.map((row) => {
						const previous = this._deliveryProjection.get(row.id)
							?? this._serverQueue.find((candidate) => candidate.id === row.id)
							?? this._pendingOutbox.find((entry) => entry.row?.id === row.id)?.row;
						if (!previous) return row;
						return {
							...row,
							...previous,
							...(row.targetTurn ? { targetTurn: row.targetTurn } : {}),
							...(row.sequence === undefined ? {} : { sequence: row.sequence }),
							...(row.deliveryState ? { deliveryState: row.deliveryState } : {}),
							...(row.retryable === undefined ? {} : { retryable: row.retryable }),
						};
					}));
					for (const row of recovered) this._mergeDeliveryProjection(row);

					// Server snapshot is authoritative for any id it contains. The
					// reducer merges in survivors (optimistic, synthetic, permission)
					// and sorts the result by (_order, _insertionTick).
					this.apply({ type: "snapshot", messages: transcriptRows });
					// Only a real snapshot transcript row may settle the outbox. The
					// recovery rows above deliberately remain pending until a correlated
					// Pi user start (or a later real transcript snapshot) is surfaced.
					for (const message of transcriptRows) {
						const intentId = deliveryIntentId(message);
						if (intentId && (message?.role === "user" || message?.role === "user-with-attachments")) {
							this._settleSurfacedIntent(intentId);
						}
					}
					if (recovered.length > 0) this.onQueueUpdate?.(this.getQueue());
					bootMark("snapshot-applied");
					// The reducer triggers a re-render via rAF; mark + flush after it
					// paints so the table captures the full reload incl. MessageList.
					requestAnimationFrame(() => requestAnimationFrame(() => {
						bootMark("post-snapshot-paint");
						bootTimingReport("post-snapshot-paint");
					}));
					// Post-compaction refreshAfterCompaction lands here. Amend the
					// in-flight compaction card with authoritative tokensAfter if
					// the new transcript carries usable usage.
					this._tryAmendPendingCompaction();
					// Successful snapshot apply — cached state is now in sync with
					// the server, so future visibility ticks can short-circuit
					// `requestMessages()` until the WS drops again.
					this._hadDisconnectSinceLastSnapshot = false;
					this._previousRawAssistantStreamMessage = undefined;
					// Streaming preview: if the snapshot contains the streaming
					// message id, it's no longer in-flight on this client.
					this.streamingMessageId = undefined;
					// Also clear any stale `streamingMessage` left over from a
					// pre-disconnect `message_update`. The snapshot is the
					// authoritative point-in-time state — the completed assistant
					// row (if the turn finished) is already in `messages`, and any
					// still-in-flight turn will repopulate via the next live
					// `message_update`. Without this clear, the StreamingMessage-
					// Container keeps rendering the stale partial (e.g. a lone
					// thinking chunk) alongside the completed message in the
					// message list, leaving the chat in an incoherent duplicate
					// state that only a hard reload clears. The snapshot path
					// below emits synthetic `message_end` frames; AgentInterface's
					// handler reads `streamingMessage` and only clears the
					// container when it's null — so we must clear here first.
					this._state.streamingMessage = null;

					// Preserve the historical per-message replay contract for subscribers,
					// then emit one bulk boundary after the entire reducer replacement. The
					// boundary lets AgentInterface wait for MessageList/child commits before
					// its final tail pin; metadata enrichment can otherwise grow historic
					// user rows after the per-message updateComplete callbacks have run.
					for (const m of this._state.messages) {
						this.emit({ type: "message_end", message: m });
					}
					this.emit({ type: "messages_snapshot" } as any);
					// Scan loaded messages for goal proposals (e.g. reconnecting to an existing session).
					// If proposal checking is deferred (draft restores in progress),
					// just flag that we have proposals to check later.
					if (this._deferProposalCheck) {
						this._hasDeferredProposals = true;
					} else {
						this._scanLoadedProposalMessages();
					}
					// Review content is durable per session. Transcript replay is deliberately
					// content-only: an old review_open/review_close result must never recreate
					// a primary tab whose authoritative workspace entry is absent.
					const reviewSessionId = this._sessionId;
					await initAnnotationStore(reviewSessionId);
					if (this._isActiveSession()) {
						state.reviewGroups = new Map();
						state.reviewActiveReviewId = "";
						state.reviewDocuments = new Map();
						state.reviewActiveTab = "";
						state.reviewPanelOpen = false;
						const reviewSources = await loadReviewSources();
						if (this._isActiveSession()) {
							await this.reconcileSubmittedReviewWorkspace({ annotationStoreHydrated: true, reviewSources });
							if (this._isActiveSession()) reviewSources.restorePersistedReviewDocuments(reviewSessionId, { select: true });
						}
					}
					// Re-add compacting placeholder if compaction is still in progress
					if (this._isCompacting) {
						this._addCompactingPlaceholder();
					}
					// Append reconnect notification after messages are refreshed
					if (this._pendingReconnectNotif) {
						this._pendingReconnectNotif = false;
						this._appendNotification("Reconnected to server", "system");
					}
					if (this._inResumeFallback) {
						// Snapshot applied — exit fallback so subsequent live events
						// (which carry seq) go through the normal dedup path.
						this._inResumeFallback = false;
					}
					// Note: we intentionally do NOT try to reconstruct streamingMessage
					// for late-joining clients. The message-list will show all messages
					// including pending tool calls. The streaming container will pick up
					// new events as they arrive.
				}
				break;
			}

			case "event": {
				const seq = typeof msg.seq === "number" ? msg.seq : undefined;
				if (seq === undefined) {
					// Old server or non-seq frame — dispatch directly (compat fallback).
					if (msg.data?.type === "agent_start" || msg.data?.type === "agent_end") {
						console.log(`[RemoteAgent] event: ${msg.data.type}, isStreaming: ${this._state.isStreaming}`);
					}
					this.handleAgentEvent(msg.data);
					break;
				}
				if (!this._seqInitialized) {
					// First seq'd frame after connect (or reset). Adopt (seq - 1) as
					// our baseline so we don't stall waiting for pre-connect events
					// the server never replayed. This is safe: the server's initial
					// catch-up path sent a state snapshot, not individual event frames.
					this._highestSeq = seq - 1;
					this._seqInitialized = true;
				}
				if (seq <= this._highestSeq) {
					// Duplicate — silently drop. This is the core dedup path that
					// fixes ST-DEDUP-01.
					break;
				}
				if (seq !== this._highestSeq + 1) {
					// Out-of-order — buffer until predecessor arrives.
					this._pendingEvents.push({ seq, ts: msg.ts, data: msg.data });
					this._pendingEvents.sort((a, b) => a.seq - b.seq);
					if (this._pendingEvents.length > this._pendingEventsMax) {
						// Gap too large — abandon ordering and force a snapshot refresh.
						console.warn(`[RemoteAgent] pending-events overflow (${this._pendingEvents.length}); forcing snapshot refresh`);
						this._pendingEvents = [];
						this._inResumeFallback = true;
						this._highestSeq = 0;
						// S9: also clear _seqInitialized so the NEXT live frame
						// re-baselines _highestSeq (via the !_seqInitialized branch
						// above). Without this, _highestSeq stays 0 while
						// _seqInitialized remains true, so every subsequent large-seq
						// frame re-buffers as a gap → the buffer refills to the cap →
						// overflow fires forever and live streaming stalls until reload.
						// Mirrors the resume_gap / _advanceTopLevelSeq recovery paths.
						this._seqInitialized = false;
						this.requestMessages();
					}
					this._drainOrderedEvents();
					break;
				}
				this._highestSeq = seq;
				if (msg.data?.type === "agent_start" || msg.data?.type === "agent_end") {
					console.log(`[RemoteAgent] event: ${msg.data.type}, isStreaming: ${this._state.isStreaming}`);
				}
				this.handleAgentEvent(msg.data);
				this._drainOrderedEvents();
				break;
			}

			case "resume_gap": {
				// Server couldn't replay from our seq — reset to its lastSeq and
				// fall back to today's get_messages snapshot path.
				const lastSeq = typeof (msg as any).lastSeq === "number" ? (msg as any).lastSeq : 0;
				console.log(`[RemoteAgent] resume_gap — falling back to snapshot. lastSeq=${lastSeq}`);
				this._highestSeq = lastSeq;
				this._pendingEvents = [];
				this._inResumeFallback = true;
				this.requestMessages();
				break;
			}

			case "session_status": {
				// Runtime identity is immutable for a live session and may arrive on a
				// heartbeat/resync frame, so it is intentionally independent of the
				// status-version gate below.
				this._applySessionIdentity(sessionRuntimeFromWire(msg.runtime));
				// Single-writer rule: this is the SOLE writer of `_state.status`.
				// for live transitions. `agent_start` / `agent_end` / `error` no
				// longer mutate status — they only fire side effects.
				// See docs/design/unify-session-status.md §4.3.
				const v = typeof (msg as any).statusVersion === "number" ? (msg as any).statusVersion : undefined;

				// Idempotent: heartbeat or duplicate. onStatusChange still fires so
				// consumers don't miss a refresh, but we drop the actual status mutation.
				if (v !== undefined && v <= this._lastStatusVersion) {
					this.onStatusChange?.(msg.status);
					break;
				}

				// Gap: apply this frame, then ask the server for a fresh baseline.
				// Heartbeat will close any further drift within ~15s anyway.
				if (v !== undefined && v > this._lastStatusVersion + 1) {
					console.warn(`[RemoteAgent] session_status gap (${this._lastStatusVersion} → ${v}); requesting resync`);
					this.send({ type: "status_resync" });
					// fall through and apply this frame
				}

				if (v !== undefined) this._lastStatusVersion = v;

				// Sole writer of _state.status.
				this._state.status = msg.status as ClientSessionStatus;

				if (msg.status === "streaming") {
					this._clearProviderAuthRequired();
				}

				if (msg.status === "archived" && (msg as any).archivedAt) {
					this._state.archivedAt = (msg as any).archivedAt;
				}
				this._state.turnStartTime =
					msg.status === "streaming"
						? ((msg as any).streamingStartedAt ?? this._state.turnStartTime ?? Date.now())
						: null;

				// `_isAborting` mirror is kept for the existing `get isAborting()`
				// reader; it's now derived from canonical status.
				this._isAborting = msg.status === "aborting";

				// Slice C2: bridge the canonical status transition onto the typed Host
				// session event bus for `host.session.subscribe` (scoped to this session).
				if (this._sessionId) {
					try { publishClientStatus(this._sessionId, msg.status); } catch { /* non-fatal */ }
				}

				this.onStatusChange?.(msg.status);
				break;
			}

			case "session_title":
				this._title = msg.title;
				this.onTitleChange?.(msg.title);
				break;

			case "queue_update": {
				const rows = this._acceptProjectedRows(Array.isArray(msg.queue) ? msg.queue : []);
				// Modern queue rows are also delivery projections. Keep them through
				// dispatch even if a later legacy queue-only frame omits the row. Read
				// back the monotonic projection so `_serverQueue` cannot shadow a newer
				// uncertain/terminal state with a stale queued carrier.
				for (const row of rows) this._mergeDeliveryProjection(row);
				this._serverQueue = rows.map((row) => this._deliveryProjection.get(row.id) ?? row);
				this.onQueueUpdate?.(this.getQueue());
				break;
			}

			case "delivery_outbox":
				this._replaceDeliveryProjection(
					Array.isArray(msg.outbox) ? msg.outbox
						: Array.isArray(msg.intents) ? msg.intents
							: Array.isArray(msg.rows) ? msg.rows
								: Array.isArray(msg.data) ? msg.data : [],
				);
				break;

			case "intent_update": {
				const intent = msg.intent ?? msg.row ?? msg.data ?? msg;
				const intentId = typeof intent?.id === "string" ? intent.id : deliveryIntentId(intent);
				if (intentId && (msg.settlement === "surfaced" || msg.settlement === "cancelled")) {
					this._settleSurfacedIntent(intentId);
					break;
				}
				this._updateDeliveryProjection(intent);
				break;
			}

			case "intent_accepted": {
				// Receipt alone is not ownership transfer. It intentionally does not
				// clear IndexedDB; a receipt carrying its matching projection can.
				if (msg.intent || msg.row || msg.data?.text) {
					this._updateDeliveryProjection(msg.intent ?? msg.row ?? msg.data);
					break;
				}
				const id = deliveryIntentId(msg);
				const local = id ? this._pendingOutbox.find((entry) => entry.row?.id === id)?.row : undefined;
				if (local) {
					local.unsent = false;
					this.onQueueUpdate?.(this.getQueue());
				}
				break;
			}

			case "side_panel_workspace":
				if ((msg as any).workspace) applySidePanelWorkspaceFromServer((msg as any).workspace, { source: "ws" });
				break;

			case "goal_setup_started":
			case "goal_setup_preparing":
			case "goal_setup_retrying":
			case "goal_setup_complete":
			case "goal_setup_error":
				this.onGoalSetupEvent?.(typeof (msg as any).goalId === "string" ? (msg as any).goalId : undefined);
				break;

			case "goal_state_changed":
			case "goal_child_spawned":
			case "cost_changed": {
				// Phase 5b: bump dashboard plan-tab re-render and re-fetch the
				// goal list so the sidebar nesting + tree-cost reflect the change.
				// Throttling lives inside the dashboard (`schedulePlanRerender`).
				import("./goal-dashboard.js").then(m => m.notifyGoalEventForDashboard?.()).catch(() => {});
				refreshSessions();
				// Fan out to any renderer-level subscribers (e.g. <children-goal-state-pill>).
				notifyGoalStateSubscribers({ goalId: (msg as any).goalId, type: msg.type });
				break;
			}

			case "goal_spec_changed": {
				const payload = msg as { goalId: string; ts: number };
				import("./goal-dashboard.js")
					.then(m => m.notifyGoalSpecEditedForDashboard?.(payload.goalId, payload.ts))
					.catch(() => {});
				// Also bump the regular goal-event path so the goal list re-fetches
				// (spec is part of the goal record).
				refreshSessions();
				break;
			}

			case "mutation_pending": {
				// Phase 5b: synthesise a chat-bubble card asking the user to
				// approve / reject the pending plan mutation. The UI surfaces it
				// via a dedicated proposal-style entry in state.activeProposals.
				try { handleMutationPendingEvent(msg as any); } catch { /* ignore */ }
				break;
			}

			case "mutation_decided": {
				// Cleanup: drop any pending mutation card for this requestId.
				try { handleMutationDecidedEvent(msg as any); } catch { /* ignore */ }
				break;
			}

			case "task_changed": {
				const task = msg.task as any;
				if (task && !task._deleted) {
					if (task.state === "complete") {
						this._appendNotification(`Task "${task.title}" completed`, "task");
					} else if (task.state === "blocked") {
						this._appendNotification(`Task "${task.title}" blocked`, "task");
					} else if (task.state === "in-progress" && task.assignedSessionId) {
						this._appendNotification(`Task "${task.title}" assigned`, "task");
					}
				}
				break;
			}

			case "gate_signal_received":
				break;

			case "gate_status_changed": {
				const gateCat = (msg as any).status === "failed" ? "error" as const : "task" as const;
				this._appendNotification(`Gate "${(msg as any).gateId}" \u2192 ${(msg as any).status}`, gateCat);
				break;
			}

			case "gate_verification_started":
				dispatchVerificationEvent(msg);
				break;
			case "gate_verification_phase_started":
			case "gate_verification_step_complete":
			case "gate_verification_step_started":
			case "gate_verification_step_output":
				dispatchVerificationEvent(msg);
				break;

			case "gate_verification_awaiting_human":
				dispatchVerificationEvent(msg);
				break;

			case "gate_verification_complete": {
				const gateVerifCat = (msg as any).status === "failed" ? "error" as const : "task" as const;
				this._appendNotification(`Gate "${(msg as any).gateId}" verification ${(msg as any).status}`, gateVerifCat);
				dispatchVerificationEvent(msg);
				break;
			}

			case "team_agent_spawned":
				this._appendNotification(`Agent ${(msg as any).name} (${(msg as any).role}) started`, "team");
				break;

			case "team_agent_dismissed":
				this._appendNotification(`Agent ${(msg as any).name} (${(msg as any).role}) dismissed`, "team");
				break;

			case "team_agent_finished":
				this._appendNotification(`Agent ${(msg as any).name} (${(msg as any).role}) finished`, "team");
				break;

			case "inbox.entry.added": {
				const sid = (msg as any).staffId as string;
				const entry = (msg as any).entry;
				if (sid && entry) applyInboxEntryAdded(sid, entry);
				break;
			}

			case "inbox.entry.updated": {
				const sid = (msg as any).staffId as string;
				const entry = (msg as any).entry;
				if (sid && entry) applyInboxEntryUpdated(sid, entry);
				break;
			}

			case "inbox.entry.removed": {
				const sid = (msg as any).staffId as string;
				const entryId = (msg as any).entryId as string;
				if (sid && entryId) applyInboxEntryRemoved(sid, entryId);
				break;
			}

			case "preferences_changed":
				this._applyPreferences(msg.preferences);
				break;

			case "projects_changed": {
				const projects = Array.isArray((msg as any).projects) ? (msg as any).projects : null;
				if (projects && setProjectsIfChanged(projects)) renderApp();
				break;
			}

			case "preview_changed":
				this.onPreviewChanged?.(msg.sessionId, msg.preview);
				break;

			case "proposal_update": {
				// Slice D: server-pushed proposal projection (post-edit / post-seed /
				// rehydrate-on-attach / restore). Always non-streaming — streaming partials
				// flow through the inline tool_use scan in `_checkToolProposals`.
				const pType = (msg as any).proposalType;
				const fields = (msg as any).fields;
				const rev = typeof (msg as any).rev === "number" ? (msg as any).rev as number : undefined;
				const source = normalizeServerProposalSource((msg as any).source);
				if (isProposalType(pType) && fields && typeof fields === "object") {
					if (this._onProposal) {
						this._onProposal(pType, fields as Record<string, unknown>, false, rev, source);
					} else {
						this._bufferedProposalEvents.push({ type: pType, fields: fields as Record<string, unknown>, streaming: false, rev, source });
					}
				}
				break;
			}

			case "proposal_cleared": {
				const pType = (msg as any).proposalType;
				if (isProposalType(pType)) {
					if (this._onProposal) {
						this._onProposal(pType, null, false);
					} else {
						this._bufferedProposalEvents.push({ type: pType, fields: null, streaming: false });
					}
				}
				break;
			}

			case "bg_process_created":
			case "bg_process_output":
			case "bg_process_exited":
			case "bg_process_dismissed":
				this.onBgProcessEvent?.(msg as any);
				break;

			case "cost_update":
				this._state.serverCost = msg.cost;
				this.emit({ type: "cost_update" as any, cost: msg.cost });
				break;

			case "remote_state_snapshot": {
				const snapshot = (msg as Partial<RemoteStateSnapshotMessage>).snapshot;
				// Ignore malformed frames rather than allowing a broad `unknown` payload
				// to enter session state. The server has already redacted this projection.
				if (
					snapshot
					&& (snapshot.source === "repository" || snapshot.source === "pr")
					&& typeof snapshot.observedAt === "number"
					&& typeof snapshot.stale === "boolean"
					&& typeof snapshot.ageMs === "number"
				) {
					this.onRemoteStateSnapshot?.(msg as RemoteStateSnapshotMessage);
				}
				break;
			}

			case "pr_status_changed":
				if ((msg as any).goalId) this.onPrStatusChanged?.((msg as any).goalId);
				break;

			case "session_created":
			case "sessions_changed": {
				// Shared with the global viewer socket so active session sockets and
				// non-session surfaces coalesce into one refresh burst.
				if (isKnownOwnSessionCreatedEvent(msg, this._sessionId)) break;
				scheduleSessionListRefreshFromPush();
				break;
			}

			case "staff_changed": {
				scheduleStaffListRefreshFromPush();
				break;
			}

			case "session_removed": {
				// Server-pushed event: a session somewhere was terminated/archived/purged.
				// Update local lists immediately so the sidebar / dashboard reflect it
				// without waiting for the 5s refreshSessions polling tick.
				const removedId = (msg as any).sessionId as string | undefined;
				const reason = (msg as any).reason as string | undefined;
				if (!removedId) break;
				if (removedId === this._sessionId) this._pendingReviewToolCalls.clear();
				this.onSessionRemoved?.(removedId, reason ?? "archived");
				break;
			}

			case "tool_permission_needed": {
				const perm = msg as any;
				const seq = typeof perm.seq === "number" ? perm.seq : undefined;
				const ts = typeof perm.ts === "number" ? perm.ts : undefined;
				if (seq !== undefined && !this._advanceTopLevelSeq(seq, "tool_permission_needed")) {
					break;
				}
				// Preserve the tool-use card that triggered the permission gate before
				// clearing the live preview. Otherwise the permission card appears but
				// the blocked tool call vanishes until a later snapshot/reconnect.
				const streaming = this._state.streamingMessage;
				if (streaming?.role === "assistant" && Array.isArray(streaming.content)) {
					const hasBlockedTool = streaming.content.some((c: any) => c?.type === "toolCall" && c?.name === perm.toolName);
					if (hasBlockedTool) {
						this.apply({ type: "blocked-tool-call-placeholder", message: streaming, seq });
					}
				}
				// The server has aborted the agent turn. Clean up the streaming preview;
				// the frozen placeholder above keeps the blocked tool context visible.
				this._state.streamingMessage = undefined;
				this.streamingMessageId = undefined;
				const permCard = {
					role: "tool_permission_needed" as any,
					toolName: perm.toolName,
					group: perm.group,
					roleName: perm.roleName,
					roleLabel: perm.roleLabel,
					lastPromptText: perm.lastPromptText,
					requestCount: typeof perm.requestCount === "number" && perm.requestCount > 1 ? perm.requestCount : undefined,
					timestamp: Date.now(),
					id: typeof perm.id === "string" ? perm.id : `perm_${seq ?? Date.now()}_${perm.toolName}`,
					status: "active",
					actionable: true,
					author: CLIENT_SYSTEM_AUTHOR,
				};
				this.apply({ type: "permission-needed", card: permCard, seq, ts });
				this.emit({ type: "render" });
				if (seq !== undefined) this._drainOrderedEvents();
				break;
			}

			case "tool_permission_settled": {
				const settled = msg as any;
				this.apply({
					type: "permission-status",
					toolName: settled.toolName,
					status: settled.status || "cancelled",
					actionable: false,
					error: settled.reason,
				});
				this.emit({ type: "render" });
				break;
			}

			case "error":
				console.error(`[RemoteAgent] Server error: ${msg.message} (${msg.code})`);
				await this._markLocalIntentRejected(msg);
				if (this._state.modelSelectionPending) {
					this._state.modelSelectionPending = null;
					this._state.modelSelectionError = typeof msg.message === "string" && msg.message
						? msg.message
						: "Couldn’t activate that model. Choose another available model and try again.";
				}
				if ((msg as any).code === "SET_MODEL_FAILED" || (msg as any).code === "SET_THINKING_LEVEL_FAILED") {
					this.send({ type: "get_state" });
				}
				if ((msg as any).code === "GRANT_ERROR") {
					// The error frame does not carry a permission request id, so do not
					// settle/disable all active cards client-side. Refresh from the server
					// instead; stale grants are ignored by the server handler, and real
					// failures should not hide a still-pending current request. Reset any
					// local granting spinner back to an actionable error state.
					this.apply({ type: "permission-status", status: "active", error: msg.message || "Permission grant failed.", actionable: true, fromStatus: "granting" });
					this.requestMessages();
					this.emit({ type: "render" });
					break;
				}
				// Status mutation is the server's job — it broadcasts a matching
				// `session_status` frame in the same termination path. We only
				// clear local-only fields here.
				this._state.turnStartTime = null;
				this._state.error = msg.message || "Unknown server error";
				this._pendingAttachments = null;
				this._pendingSkillExpansions = null;
				// Legacy compatibility: settle a pre-upgrade optimistic row if one
				// survived into this session. Durable intents stay in the outbox.
				this.apply({ type: "settle-optimistic" });
				this.apply({
					type: "error",
					message: {
						role: "error",
						content: msg.message || "Unknown server error",
						code: msg.code,
						timestamp: Date.now(),
						id: `err_${Date.now()}_${Math.random().toString(36).slice(2)}`,
						author: CLIENT_SYSTEM_AUTHOR,
					},
				});
				this._appendNotification(msg.message || "Unknown server error", "error");
				this.emit({ type: "error", error: msg.message });
				break;
		}
	}

	/**
	 * Move any deferred assistant message into the stable messages array
	 * and clear streamingMessage. Called at points where the streaming container
	 * is simultaneously updated (message_update replaces its content,
	 * message_end of non-assistant clears it, agent_end clears it) so the
	 * tool call never appears in both message-list and streaming-container.
	 */
	private _checkProposalToolResult(message: any): void {
		if (message?.role !== "toolResult" && message?.role !== "tool_result" && message?.type !== "tool_result") return;
		const toolCallId = typeof message.toolCallId === "string"
			? message.toolCallId
			: typeof message.tool_use_id === "string"
				? message.tool_use_id
				: "";
		const remembered = toolCallId ? this._proposalToolCallsById.get(toolCallId) : undefined;
		const toolName = typeof message.toolName === "string" ? message.toolName : "";
		const typeFromName = toolName.startsWith("propose_") ? toolName.replace("propose_", "") : "";
		const proposalType = remembered?.type ?? (isProposalType(typeFromName) ? typeFromName : undefined);
		if (proposalType !== "goal") return;
		const input = remembered?.input ?? (toolCallId ? parseToolPayload(this._toolCallInputsById.get(toolCallId)) ?? undefined : undefined);
		if (!input) return;
		const validation = parseGoalWorkflowValidationError(message, input);
		if (!validation) return;
		const current = state.activeProposals.goal;
		if (current?.sessionId === this._sessionId && (current.rev ?? 0) > 0) {
			// Historical replay may encounter an older failed no-rev tool result after a
			// later successful retry has already rehydrated a rev-backed draft. Keep the
			// failed metadata tied to its own tool card/open event instead of poisoning
			// the current successful proposal slot.
			return;
		}
		if (!current || current.sessionId !== this._sessionId) {
			if (input && this.onProposal) this.onProposal("goal", input, false, undefined, "tool");
		}
		const slot = state.activeProposals.goal;
		if (!slot || slot.sessionId !== this._sessionId) return;
		if (input && (slot.rev ?? 0) === 0 && !sameProposalFields(slot.fields, input)) {
			(state.activeProposals.goal as any) = { ...slot, fields: { ...input } };
		}
		const target = state.activeProposals.goal;
		if (!target || target.sessionId !== this._sessionId) return;
		(state.activeProposals.goal as any) = { ...target, workflowValidationError: validation };
		if (validation.workflowId !== undefined) {
			(state.activeProposals.goal as any).fields = { ...target.fields, workflow: validation.workflowId };
		}
		renderApp();
	}

	/**
	 * Check an assistant message for propose_* tool calls and fire the matching callback.
	 * @param streaming — true during message_update (live streaming). In streaming mode,
	 *   the callback fires on every update for live preview sync, but the block is NOT
	 *   marked as processed. Only non-streaming calls (message_end, full re-scan) mark
	 *   blocks as processed and persist the dedup state.
	 */
	private _checkToolProposals(message: any, streaming = false): void {
		if (!Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (block.type !== "tool_use" && block.type !== "toolCall") continue;
			const toolName = block.name || block.toolName;
			if (!toolName?.startsWith("propose_")) continue;
			const proposalType = toolName.replace("propose_", "");
			const callbackName = PROPOSAL_TOOL_MAP[proposalType];
			if (!callbackName) continue;
			const callback = (this as any)[callbackName];
			// Slice D: dispatch to unified onProposal alongside legacy callback.
			// Either may be unset — we keep going as long as one is wired.
			if (!callback && !this.onProposal) continue;

			const blockId = block.id || block.toolCallId || "";

			// Extract input — tool_use blocks use `input`, toolCall blocks may use `arguments`
			let input = block.input;
			if (!input && typeof block.arguments === "string") {
				try { input = JSON.parse(block.arguments); } catch { continue; }
			}
			if (!input && typeof block.arguments === "object" && block.arguments !== null) {
				input = block.arguments;
			}
			if (!input || typeof input !== "object") continue;
			// During streaming, tool arguments arrive incrementally (e.g. "{}" → {"title":""} → full).
			// Skip empty objects to avoid firing with no meaningful data.
			if (Object.keys(input).length === 0) continue;

			if (blockId && isProposalType(proposalType)) {
				this._proposalToolCallsById.set(blockId, { type: proposalType, input: { ...input } });
			}

			// Track that this message had a tool-based proposal before the dedupe
			// return, so historical scans do not also parse any legacy XML fallback.
			const msgId = message.id || "";
			if (msgId) this._toolProposalMessageIds.add(msgId);

			// Deduplicate callbacks — but only after remembering the input above, so a
			// later historical toolResult row can still reconstruct failed workflow
			// metadata from a processed propose_goal call.
			if (blockId && this._processedProposalIds.has(blockId)) continue;

			const tagKey = `${proposalType}_proposal`;
			if (streaming) {
				if (this._isActiveSession()) state.proposalStreamingByTag[tagKey] = true;
				// Record the in-flight block so a mid-stream Dismiss can suppress
				// the rest of THIS tool block (see dismissStreamingProposal).
				if (blockId) this._streamingProposalBlockIdByTag[tagKey] = blockId;
			}
			// Slice E gap-closure: run the unified onProposal BEFORE the legacy
			// per-type callback so plugin.mergeFields sees the un-mutated prev
			// slot. Several legacy callbacks (goal/role/staff) overwrite
			// state.activeProposals[type].fields with the incoming partial verbatim,
			// which would leave nothing for mergeFields to preserve if onProposal
			// ran second.
			if (this.onProposal && isProposalType(proposalType)) {
				this.onProposal(proposalType, input, streaming, undefined, "tool");
			}
			if (callback) callback(input, streaming);

			// Only mark as processed on non-streaming calls (message_end, full re-scan).
			// During streaming we fire the callback repeatedly for live preview sync
			// without marking processed — so the final complete arguments always fire too.
			if (!streaming && blockId) {
				this._processedProposalIds.add(blockId);
				if (this._isActiveSession()) state.proposalStreamingByTag[tagKey] = false;
				delete this._streamingProposalBlockIdByTag[tagKey];
				// Persist to sessionStorage so it survives page refresh
				if (this._sessionId) {
					try {
						sessionStorage.setItem(
							`processed-proposals-${this._sessionId}`,
							JSON.stringify([...this._processedProposalIds]),
						);
					} catch { /* ignore quota errors */ }
				}
			}
			// Message id was recorded before callback dedupe.
		}
	}

	/**
	 * Dismiss the proposal currently STREAMING for `tagKey` (e.g. "goal_proposal").
	 *
	 * The persistent dismissal in `markProposalDismissed` is a content-fingerprint
	 * match. During streaming the proposal body grows on every delta, so a
	 * fingerprint captured at click time no longer matches the next delta and the
	 * panel re-populates. To make a mid-stream Dismiss stick we add the active
	 * streaming tool-block id to the processed set: every subsequent streaming
	 * delta AND the final message_end fire for that block are then skipped by the
	 * dedup guard in `_checkToolProposals`. No-op when nothing is streaming for the
	 * tag (callers gate on `isProposalStreaming`).
	 */
	dismissStreamingProposal(tagKey: string): void {
		const blockId = this._streamingProposalBlockIdByTag[tagKey];
		if (blockId) this._processedProposalIds.add(blockId);
		delete this._streamingProposalBlockIdByTag[tagKey];
		state.proposalStreamingByTag[tagKey] = false;
	}

	/** Check an assistant message for legacy XML proposal blocks and fire the matching callback.
	 *  Kept as backward-compatibility fallback — tool-based proposals are preferred. */
	private _checkProposals(message: any): void {
		// Skip XML parsing if a tool-based proposal was already detected for this message
		const msgId = message.id || "";
		if (msgId && this._toolProposalMessageIds.has(msgId)) return;

		let text = "";
		if (typeof message.content === "string") text = message.content;
		else if (Array.isArray(message.content)) {
			text = message.content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("");
		}
		if (!text) return;

		for (const parser of PROPOSAL_PARSERS) {
			const proposalType = PROPOSAL_TAG_TO_TYPE[parser.tag];
			const callbackName = proposalType ? TYPE_TO_LEGACY_CALLBACK[proposalType] : undefined;
			const callback = callbackName ? (this as any)[callbackName] : undefined;
			if (!callback && !this.onProposal) continue;

			// Match all occurrences (a proposal block may appear multiple times)
			const regex = new RegExp(`<${parser.tag}>([\\s\\S]*?)<\\/${parser.tag}>`, "g");
			let match: RegExpExecArray | null;
			while ((match = regex.exec(text)) !== null) {
				const block = match[1];
				const result: Record<string, string> = {};
				// Extract fields in two passes to avoid false positives from field tags
				// appearing inside large content fields (e.g. <cwd> in backtick-quoted
				// code inside <spec> text). First pass: extract large content fields and
				// strip them from the block. Second pass: extract remaining fields from
				// the cleaned block.
				const LARGE_CONTENT_FIELDS = new Set(["spec", "prompt", "content", "description", "gates", "triggers"]);
				let remainingBlock = block;
				for (const field of parser.fields) {
					if (!LARGE_CONTENT_FIELDS.has(field)) continue;
					const m = remainingBlock.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
					result[field] = m ? m[1].trim() : "";
					if (m) {
						remainingBlock = remainingBlock.replace(m[0], "");
					}
				}
				for (const field of parser.fields) {
					if (LARGE_CONTENT_FIELDS.has(field)) continue;
					const m = remainingBlock.match(new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`));
					result[field] = m ? m[1].trim() : "";
				}

				// Normalize hyphenated keys to camelCase
				const normalized: Record<string, string> = {};
				for (const [k, v] of Object.entries(result)) {
					normalized[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
				}

				const missing = parser.requiredFields.some(f => {
					const key = f.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
					return !normalized[key];
				});
				if (missing) continue;

				console.warn(`[proposal] Detected legacy XML <${parser.tag}> block — this format is deprecated, use propose_* tools instead`);
				if (this.onProposal && proposalType) {
					this.onProposal(proposalType, normalized, false, undefined, "legacy");
				}
				if (callback) callback(normalized);
			}
		}
	}

	/**
	 * Route live review tool results to the emitting session. Persisted review
	 * groups and the server workspace are session-keyed, while visible review
	 * state remains selected-session-only. Historical results are ignored: the
	 * authoritative workspace plus durable group store perform hydration without
	 * resurrecting a closed or submitted review.
	 */
	private async _checkReviewToolResult(msg: any, isLive = false): Promise<void> {
		const sessionId = this._sessionId;
		if (!sessionId || !isLive) return;

		this._prunePendingReviewToolCalls();
		for (const result of correlatedReviewResults(msg)) {
			const pending = this._pendingReviewToolCalls.get(result.toolCallId);
			if (!pending) continue;
			// A review tool emits one control envelope. Multiple review actions are
			// ambiguous and fail closed rather than selecting a convenient match.
			if (result.payloads.length !== 1) continue;
			const data = result.payloads[0];
			if (data.action !== pending.toolName) continue;

			if (pending.toolName === "review_open") {
				const receipt = parseReviewOpenReceipt(data, result.toolCallId);
				if (receipt) {
					// Consume before the first await so concurrent/replayed delivery cannot
					// authorize the same receipt twice. The coordinator retains its outcome
					// under the exact session/tool-use/payload identity for the originating
					// renderer and deduplicates an explicit retry while this open is pending.
					this._pendingReviewToolCalls.delete(result.toolCallId);
					registerReviewOpenReceipt(sessionId, result.toolCallId, receipt);
					await openReviewReceipt({
						sessionId,
						toolUseId: result.toolCallId,
						receipt,
						intent: "automatic",
					});
					continue;
				}
				if (data.version === 2) {
					// A malformed v2 receipt must not downgrade into the inline legacy
					// path, even if it happens to carry Markdown-shaped fields.
					this._pendingReviewToolCalls.delete(result.toolCallId);
					continue;
				}

				// Read-only compatibility for trusted live v1 controls. Historical
				// transcript rendering never reaches this method, so inline Markdown
				// cannot passively recreate an authoritatively absent review.
				const files = Array.isArray(data.files)
					? data.files.filter((file: unknown) => !!file && typeof file === "object" && typeof (file as any).markdown === "string")
					: typeof data.markdown === "string"
						? [{
							fileId: typeof data.fileId === "string" ? data.fileId : typeof data.documentId === "string" ? data.documentId : undefined,
							title: typeof data.title === "string" && data.title.trim() ? data.title : "Review",
							markdown: data.markdown,
						}]
						: [];
				if (files.length === 0) continue;
				this._pendingReviewToolCalls.delete(result.toolCallId);
				const reviewSources = await loadReviewSources();
				reviewSources.openMarkdownReviewGroup({
					title: typeof data.title === "string" && data.title.trim() ? data.title : "Review",
					reviewId: typeof data.reviewId === "string" ? data.reviewId : typeof data.documentId === "string" ? data.documentId : undefined,
					files,
					activeFileId: typeof data.activeFileId === "string" ? data.activeFileId : undefined,
					replace: data.replace !== false,
					live: true,
					sessionId,
				});
			} else {
				this._pendingReviewToolCalls.delete(result.toolCallId);
				const reviewSources = await loadReviewSources();
				const knownGroups = state.reviewGroupsBySession[sessionId]
					|| reviewSources.readPersistedReviewGroups(sessionId);
				const reviewId = typeof data.reviewId === "string" ? data.reviewId : "";
				const title = typeof data.title === "string" ? data.title : "";
				const targets = reviewId
					? knownGroups.filter((group) => group.reviewId === reviewId)
					: title ? knownGroups.filter((group) => group.title === title) : knownGroups;
				for (const group of targets) await reviewSources.cleanupReviewGroup(sessionId, group.reviewId);
			}
		}
	}

	private _applyPreferences(prefs: Record<string, unknown>): void {
		if (!prefs || typeof prefs !== "object") return;

		// Apply palette
		if ("palette" in prefs) {
			const palette = prefs.palette as string;
			if (!palette || palette === "forest") {
				delete document.documentElement.dataset.palette;
				localStorage.removeItem('palette');
			} else {
				document.documentElement.dataset.palette = palette;
				localStorage.setItem('palette', palette);
			}
		}

		// Apply showTimestamps — default ON when unset; only an explicit `false` opts out.
		if ("showTimestamps" in prefs) {
			document.documentElement.dataset.showTimestamps = prefs.showTimestamps === false ? "" : "true";
		}

		// Apply playAgentFinishSound — default ON when unset.
		if ("playAgentFinishSound" in prefs) {
			document.documentElement.dataset.playAgentFinishSound =
				prefs.playAgentFinishSound === false ? "false" : "true";
			// Notify the header <bell-toggle> (and Settings checkbox) so they reflect
			// a change pushed from another tab/client.
			if (typeof window !== "undefined") {
				window.dispatchEvent(new CustomEvent("bobbit-play-finish-sound-changed", {
					detail: { enabled: prefs.playAgentFinishSound !== false },
				}));
			}
		}

		// Apply replaceBobbitWithText — default OFF (only explicit true opts in).
		if ("replaceBobbitWithText" in prefs) {
			document.documentElement.dataset.replaceBobbitWithText =
				prefs.replaceBobbitWithText === true ? "true" : "false";
		}

		// Apply subgoalsEnabled — default OFF. See subgoals-flag.ts. Mirror
		// unconditionally: the broadcast sends the full prefs object, so an
		// unset pref is absent and must normalize to "false" (not retain stale).
		document.documentElement.dataset.subgoalsEnabled =
			prefs.subgoalsEnabled === true ? "true" : "false";
		// Apply maxNestingDepth — default 3 when unset/invalid.
		if ("maxNestingDepth" in prefs) {
			document.documentElement.dataset.maxNestingDepth =
				(typeof prefs.maxNestingDepth === "number" && Number.isFinite(prefs.maxNestingDepth))
					? String(prefs.maxNestingDepth)
					: "3";
		}

		// Apply showHeadquartersInProjectLists — default ON. The broadcast sends
		// the full safe prefs object, so absence means the default visible state.
		const showHeadquartersInProjectLists = prefs.showHeadquartersInProjectLists !== false;
		if (state.showHeadquartersInProjectLists !== showHeadquartersInProjectLists) {
			state.showHeadquartersInProjectLists = showHeadquartersInProjectLists;
			renderApp();
		}

		// Apply shortcuts
		if ("shortcuts" in prefs) {
			void loadSavedBindings();
		}

	}

	private _appendNotification(message: string, category: "system" | "task" | "team" | "error"): void {
		const notif: any = createSystemNotification(message, category);
		// Stamp a stable id so the reducer's id-keyed render works.
		if (!notif.id) {
			notif.id = `notif_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		}
		this.apply({ type: "system-notification", message: notif });
		this.emit({ type: "message_end", message: notif });
	}

	/** Phase 5b: append a `mutation-pending` chat card. Dedupe by `requestId`. */
	public appendMutationPendingCard(opts: { goalId: string; requestId: string; kind: "fix-up" | "expansion" | "restructure" | "criteria-drop"; summary: string }): void {
		const card: any = {
			role: "mutation-pending",
			goalId: opts.goalId,
			requestId: opts.requestId,
			kind: opts.kind,
			summary: opts.summary,
			timestamp: new Date().toISOString(),
			id: `mut_${opts.requestId}`,
			author: CLIENT_SYSTEM_AUTHOR,
		};
		this.apply({ type: "mutation-pending", message: card });
		this.emit({ type: "message_end", message: card });
	}

	/** Phase 5b: update a `mutation-pending` card to its decided state. */
	public markMutationDecided(requestId: string, decision: "approve" | "reject"): void {
		const id = `mut_${requestId}`;
		this.apply({ type: "mutation-update", messageId: id, patch: { decided: decision === "approve" ? "approved" : "rejected" } });
	}

	private _clearProviderAuthRequired(): void {
		this._state.providerAuthRequired = null;
	}

	private _normalizeAssistantStreamUpdate(event: any): any | null {
		if (!event || event.type !== "message_update") return event;
		const expectsCompact = this._assistantStreamDeltaEnabled && event.assistantStreamDelta === 1;
		const reconstructed: any = event.assistantStreamDelta === 1
			? reconstructAssistantStreamDelta(event, this._previousRawAssistantStreamMessage)
			: event;
		if (event.assistantStreamDelta === 1 && (!reconstructed || reconstructed === event || !reconstructed.message)) {
			console.warn(`[RemoteAgent] assistantStreamDelta reconstruction failed${expectsCompact ? "" : " (unexpected compact frame)"}; reconnecting for a fresh delta baseline`);
			this._previousRawAssistantStreamMessage = undefined;
			// A snapshot alone cannot reset the server's per-socket delta baseline.
			// Reconnect so auth negotiation marks the replacement socket as needing a
			// self-contained first update; cumulative replay remains authoritative.
			try { this.ws?.close(4009, "assistant stream resync"); } catch { this.requestMessages(); }
			return null;
		}
		if (reconstructed?.message?.role === "assistant") {
			this._previousRawAssistantStreamMessage = reconstructed.message;
		}
		return reconstructed;
	}

	private handleAgentEvent(event: any) {
		event = this._normalizeAssistantStreamUpdate(event);
		if (!event) return;
		const correlatedIntentId = deliveryIntentId(event) ?? deliveryIntentId(event.message);
		if (correlatedIntentId && event.message && !deliveryIntentId(event.message)) {
			event = {
				...event,
				message: { ...event.message, deliveryIntentId: correlatedIntentId },
			};
		}
		// Track current event seq so live-event reducer dispatches use it.
		const eventSeq = this._highestSeq;
		// Child frames are a nested projection, never root agent events. Handle the
		// semantic frame and defensive pre-G10b parentToolUseId frames before every
		// root streaming/proposal/host/transcript side effect.
		if (isClaudeSdkSubagentFrame(event)) {
			this.subagentWorkByParent = applyClaudeSdkSubagentWorkFrame(this.subagentWorkByParent, event);
			this._state.subagentWorkByParent = this.subagentWorkByParent;
			this.emit({ type: "render" });
			return;
		}
		// Update local state BEFORE emitting (UI reads state in event handlers)
		switch (event.type) {
			case "agent_start":
				// Status is owned by `session_status` (server). agent_start is a
				// signal: clear local error + capture timing.
				this._state.error = undefined;
				// New turn starting (either a fresh user prompt, an explicit retry,
				// or a fired auto-retry timer) — recovery banners are done.
				this._state.autoRetryPending = null;
				this._state.manualRetryRequired = null;
				this._clearProviderAuthRequired();
				this._taskStartTime = Date.now();
				this._state.turnStartTime = this._taskStartTime;
				break;

			case "auto_retry_pending": {
				// Server scheduled a transient/overload auto-retry timer. Surface
				// a visible "Retrying in Xs…" banner so the session doesn't look
				// silently frozen between agent_end and the retry's agent_start.
				// Shape pinned by `AutoRetryPendingEvent` in src/server/ws/protocol.ts
				// — the producer in session-manager.ts emits exactly these fields.
				const e = event as AutoRetryPendingEvent;
				this._state.autoRetryPending = {
					reason: e.reason,
					retryDelayMs: e.retryDelayMs,
					attempt: e.attempt,
					scheduledAt: e.scheduledAt,
					error: e.error,
				};
				break;
			}

			case "auto_retry_cancelled":
				// Server cancelled the pending timer (explicit user retry, new
				// prompt enqueued, or session termination). Clear the banner.
				// Wire shape pinned by `AutoRetryCancelledEvent` in src/server/ws/protocol.ts;
				// no field is read today (banner just clears) so no narrowing needed.
				this._state.autoRetryPending = null;
				break;

			case "manual_retry_required": {
				const e = event as ManualRetryRequiredEvent;
				this._state.autoRetryPending = null;
				this._state.manualRetryRequired = {
					message: typeof e.message === "string" && e.message
						? e.message
						: "Queued work is parked because this turn failed. Manual Retry is required.",
					error: typeof e.error === "string" ? e.error : undefined,
				};
				break;
			}

			case "provider_auth_required": {
				// Missing provider credentials are terminal until an operator fixes
				// Settings or switches models. Store a redacted, renderable subset only.
				const e = event as ProviderAuthRequiredEvent;
				this._state.autoRetryPending = null;
				this._state.providerAuthRequired = {
					provider: typeof e.provider === "string" ? e.provider : "unknown",
					source: typeof e.source === "string" ? e.source : "agent",
					reason: "missing-api-key",
					message: typeof e.message === "string" && e.message
						? e.message
						: "Provider API key is missing. Add or fix the key in Settings, switch provider, then retry.",
					actions: Array.isArray(e.actions)
						? e.actions.filter((a): a is ProviderAuthRecoveryAction => !!a && typeof a.type === "string" && typeof a.label === "string")
						: [],
					receivedAt: Date.now(),
				};
				break;
			}

			case "process_exit":
				// The server clears its delta-chain base on process death. Mirror that
				// boundary so a replacement agent's self-contained first update is not
				// incorrectly applied to stale pre-crash content.
				this._previousRawAssistantStreamMessage = undefined;
				this._pendingReviewToolCalls.clear();
				break;

			case "agent_end": {
				this._previousRawAssistantStreamMessage = undefined;
				this.streamingMessageId = undefined;
				this._pendingReviewToolCalls.clear();
				// Status is owned by `session_status` (server). agent_end is a
				// signal: streaming-message cleanup + per-tag flag clear + beep + badge.
				this._state.streamingMessage = null;
				this._state.pendingToolCalls = new Set();
				// Bulk-clear any stuck per-tag streaming flags (safety net for
				// turns that error out or are aborted before message_end). The map is
				// global, so a cached background agent must not clear foreground flags.
				if (this._isActiveSession()) {
					for (const k of Object.keys(state.proposalStreamingByTag)) {
						state.proposalStreamingByTag[k] = false;
					}
				}
				this._streamingProposalBlockIdByTag = {};

				// Notify: beep + favicon badge — only when the human is actually needed.
				// Team members/delegates escalate to their parent silently; team leads
				// only ping when the goal is complete or they're stuck (no live downstream).
				{
					const sess = state.gatewaySessions.find(gs => gs.id === this._sessionId);
					if (sess) {
						const goalId = sess.teamGoalId || sess.goalId;
						const goal = goalId ? state.goals.find(g => g.id === goalId) : undefined;
						if (needsHumanAttentionOnIdleTransition(sess, goal, state.gatewaySessions, state.gateStatusCache)
							|| needsImmediateHumanAttention(sess, state.gateStatusCache)) {
							void RemoteAgent.playNotificationBeep(sess);
							showFaviconBadge();
						}
					} else {
						// Session not in the cache yet — fall back to today's behaviour
						// (notify) so we never *silently swallow* a standalone session's
						// finish cue during the brief window before the poll lands.
						void RemoteAgent.playNotificationBeep(undefined);
						showFaviconBadge();
					}
				}

				this._taskStartTime = null;
				this._state.turnStartTime = null;
				// Legacy compatibility only. New submissions never create optimistic
				// transcript rows; their durable outbox carrier survives turn end.
				this.apply({ type: "settle-optimistic" });
				break;
			}

			case "assistant_stream_invalidated": {
				const assistantStreamId = typeof event.assistantStreamId === "string"
					? event.assistantStreamId
					: undefined;
				if (!assistantStreamId) break;
				if (this._state.streamingMessage?.assistantStreamId === assistantStreamId) {
					this._state.streamingMessage = null;
					this.streamingMessageId = undefined;
				}
				this._previousRawAssistantStreamMessage = undefined;
				this.apply({ type: "assistant-stream-invalidated", assistantStreamId });
				break;
			}

			case "message_start": {
				// A correlated Pi user start is the acknowledgement boundary: put the
				// real row in the transcript reducer first, then synchronously remove
				// its outbox carrier. Uncorrelated/assistant starts still wait for end.
				const message = event.message;
				const intentId = deliveryIntentId(message) ?? correlatedIntentId;
				if (
					intentId
					&& message
					&& (message.role === "user" || message.role === "user-with-attachments")
				) {
					const correlated = deliveryIntentId(message)
						? message
						: { ...message, deliveryIntentId: intentId };
					this.apply({ type: "live-event", frame: { type: "message_start", message: correlated }, seq: eventSeq, ts: 0 });
					this._settleSurfacedIntent(intentId);
					event = { ...event, message: correlated };
				}
				break;
			}

			case "message_update":
				if (event.message) {
					const normalizedMessage = normalizeProposalToolCallInputs(event.message, (id) => this._toolCallInputsById.get(id));
					event = { ...event, message: normalizedMessage };
					// Throttle stream updates when content has truncated blocks
					// to reduce Lit re-render pressure (2x/sec instead of every token).
					const hasTruncated = Array.isArray(normalizedMessage.content) &&
						normalizedMessage.content.some((c: any) =>
							c.type === "toolCall" &&
							typeof c.arguments?.content === "object" &&
							c.arguments?.content?._truncated === true,
						);
					if (hasTruncated) {
						const now = Date.now();
						if (now - this._lastTruncatedStreamUpdate < 500) {
							break; // Skip this update — throttled
						}
						this._lastTruncatedStreamUpdate = now;
					}

					this._state.streamingMessage = normalizedMessage;
					// Check for proposals during streaming so preview syncs live.
					// Pass streaming=true so blocks are NOT marked as processed —
					// the final fire on message_end marks them.
					this._checkToolProposals(normalizedMessage, /* streaming */ true);
					this._checkProposals(normalizedMessage);
				}
				break;

			case "message_end":
				this._previousRawAssistantStreamMessage = undefined;
				if (event.message) {
					let msg = normalizeProposalToolCallInputs(event.message, (id) => this._toolCallInputsById.get(id));
					if (msg.role === "assistant") {
						// Overflow-recovery suppression: when pi-coding-agent auto-compacts
						// on overflow, it sometimes fires a retry from the still-in-flight
						// pre-compaction transcript right as the compaction is committed.
						// That retry gets rejected by the API (`prompt is too long`,
						// `usage.totalTokens === 0`, content is empty) before the agent
						// then runs the next turn cleanly against the compacted state.
						// Hide the spurious red banner — the compaction card itself is
						// already rendered as "complete" (forced for overflow trigger),
						// so showing a standalone overflow error after it is doubly
						// misleading.
						let suppressedOverflowRetry = false;
						if (
							this._overflowRecoveryDeadline !== null
							&& Date.now() <= this._overflowRecoveryDeadline
							&& msg.stopReason === "error"
							&& isContextOverflowError(msg.errorMessage)
						) {
							msg = { ...msg, _suppressedByOverflowRecovery: true };
							suppressedOverflowRetry = true;
							// Failed retry — the next clean turn will provide fresh usage.
						}
						this._overflowRecoveryDeadline = null;

						// Tokens-after amendment: the first clean assistant turn after
						// compaction has authoritative `usage` reflecting the real
						// post-compaction context size. Skip when this very turn IS the
						// suppressed spurious retry — the next turn will carry real usage.
						if (!suppressedOverflowRetry) {
							this._tryAmendPendingCompaction();
						}

						// Fresh assistant turn with usable usage → clear the
						// post-compaction stale flag so the context bar resumes showing
						// real percentages. Guard on usage-presence and non-error
						// stopReason — a failed retry shouldn't be treated as a fresh
						// usage signal.
						if (
							this._usageStaleAfterCompaction
							&& msg.usage
							&& msg.stopReason !== "aborted"
							&& msg.stopReason !== "error"
						) {
							this._usageStaleAfterCompaction = false;
							this._compactionStartPct = null;
						}

						// Check for proposals in assistant message
						this._checkToolProposals(msg);
						this._checkProposals(msg);

						const hasToolCalls = Array.isArray(msg.content) &&
							msg.content.some((c: any) => c.type === "toolCall");

						// Mark this id as the streaming-preview message so the render
						// layer can hide it from message-list while the streaming
						// container owns it. Some tool-only turns (notably parked
						// `bash_bg wait`) arrive as `message_end` without a prior
						// `message_update`; in that case this final message is the first
						// thing the streaming container can render. When there are no
						// tool calls the streaming container will be cleared by
						// AgentInterface.
						if (hasToolCalls) {
							const sid = computeStreamingMessageId(msg);
							this.streamingMessageId = sid;
							// Stamp the synthetic id onto the reducer entry too, so the
							// visible-messages filter's id-equality check can hide the
							// in-flight row even when the upstream `msg.id` is missing
							// (undefined / null / numeric). Single source of truth via
							// `computeStreamingMessageId` so the two cannot diverge.
							if (sid && (typeof msg.id !== "string" || msg.id.length === 0)) {
								msg = { ...msg, id: sid };
							}
							this._state.streamingMessage = msg;
						} else {
							this._state.streamingMessage = null;
							this.streamingMessageId = undefined;
						}
						this.apply({ type: "live-event", frame: { type: "message_end", message: msg }, seq: eventSeq, ts: 0 });
					} else {
						// Non-assistant: streaming container clears.
						this._state.streamingMessage = null;
						this.streamingMessageId = undefined;

						// Enrich echoed user messages with stashed attachments / skill expansions.
						// The attachment slot is now a FALLBACK only (WP1 / RC2): when the
						// echo already carries image content blocks, the reducer's
						// enrichUserMessage derives the tiles from server-authoritative
						// content — applying the slot too would double-attach. Use the slot
						// only when the echo has no image block; clear it unconditionally
						// (one-shot) so a later text-only prompt can't inherit stale images.
						if (msg.role === "user" && this._pendingAttachments) {
							const echoHasImage = Array.isArray(msg.content)
								&& msg.content.some((c: any) => c?.type === "image" && c?.data);
							if (!echoHasImage) {
								msg = {
									...msg,
									role: "user-with-attachments",
									attachments: this._pendingAttachments,
								};
							}
							this._pendingAttachments = null;
						}
						if (
							(msg.role === "user" || msg.role === "user-with-attachments") &&
							this._pendingSkillExpansions &&
							!(msg as any).skillExpansions
						) {
							msg = { ...msg, skillExpansions: this._pendingSkillExpansions };
							this._pendingSkillExpansions = null;
						}

						this.apply({ type: "live-event", frame: { type: "message_end", message: msg }, seq: eventSeq, ts: 0 });
						const surfacedIntentId = deliveryIntentId(msg) ?? correlatedIntentId;
						if (
							surfacedIntentId
							&& (msg.role === "user" || msg.role === "user-with-attachments")
						) this._settleSurfacedIntent(surfacedIntentId);
						this._checkProposalToolResult(msg);

						// Slice C2: bridge the live message onto the typed Host session
						// event bus for `host.session.subscribe` (contract shapes, scoped
						// to this session). Best-effort — never blocks the live path.
						if (this._sessionId) {
							try { publishClientMessage(this._sessionId, msg); } catch { /* non-fatal */ }
						}

						// Check for review tool results (review_open/review_close JSON).
						// `isLive: true` distinguishes a fresh agent emission from a snapshot
						// replay so the submitted-flag handling can differentiate. RP-09.
						void this._checkReviewToolResult(msg, /* isLive */ true);

						// Notify ask_user_choices cards on user-message echoes.
						if (msg.role === "user" || msg.role === "user-with-attachments") {
							if (typeof document !== "undefined") {
								document.dispatchEvent(new CustomEvent("bobbit-transcript-message"));
							}
						}
					}
					// Replace the original event reference for downstream subscribers
					event = { ...event, message: msg };
				}
				break;

			case "tool_execution_start": {
				const id = toolEventId(event);
				if (id) {
					this._state.pendingToolCalls = new Set(this._state.pendingToolCalls);
					this._state.pendingToolCalls.add(id);
					const input = parseToolPayload(event.input) ?? parseToolPayload(event.arguments);
					if (input) this._toolCallInputsById.set(id, input);
					const toolName = typeof event.toolName === "string" ? event.toolName : "";
					const exactReviewToolName = reviewToolName(toolName);
					if (exactReviewToolName) this._rememberReviewToolCall(id, exactReviewToolName);
					const proposalType = toolName.startsWith("propose_") ? toolName.replace("propose_", "") : "";
					if (input && isProposalType(proposalType)) this._proposalToolCallsById.set(id, { type: proposalType, input: { ...input } });
				}
				break;
			}

			case "tool_execution_update": {
				const id = toolEventId(event);
				if (id) {
					const input = parseToolPayload(event.input) ?? parseToolPayload(event.arguments);
					if (input) this._toolCallInputsById.set(id, input);
					const existing = this._proposalToolCallsById.get(id);
					if (input && existing) this._proposalToolCallsById.set(id, { ...existing, input: { ...existing.input, ...input } });
				}
				// Store partial results from long-running tools (e.g., skill invocations)
				// so the UI can show real-time progress.
				if (event.toolCallId && event.partialResult) {
					if (!this._state.toolPartialResults) {
						this._state.toolPartialResults = {};
					}
					this._state.toolPartialResults = {
						...this._state.toolPartialResults,
						[event.toolCallId]: event.partialResult,
					};
					// Notify UI to re-render with partial results
					this.onWorkflowUpdate?.();
					this.emit(event);
					return; // skip default emit at end
				}
				break;
			}

			case "tool_execution_end":
				if (event.toolCallId) {
					this._state.pendingToolCalls = new Set(this._state.pendingToolCalls);
					this._state.pendingToolCalls.delete(event.toolCallId);
					// Clean up partial result now that the tool is done
					if (this._state.toolPartialResults?.[event.toolCallId]) {
						const { [event.toolCallId]: _, ...rest } = this._state.toolPartialResults;
						this._state.toolPartialResults = Object.keys(rest).length > 0 ? rest : undefined;
					}
				}
				break;

			case "compaction_start":
			case "auto_compaction_start":
				// Don't set isStreaming — compaction uses its own blob animation
				this._isCompacting = true;
				this.onCompactionChange?.(true);
				this._compactionStartedAt = Date.now();
				// Mark context-bar usage stale until the next clean assistant
				// turn arrives — the snapshot's last-assistant-usage post-compaction
				// is still the pre-compaction value, so we'd otherwise show a wrong
				// percentage on the bar until the next turn happens.
				this._usageStaleAfterCompaction = true;
				// Sample current context-fill percentage so the placeholder bar
				// can deflate from here to the shimmer resting width. Reads the
				// transcript's last-assistant usage (still pre-compaction at
				// `compaction_start` — the snapshot refresh hasn't landed yet).
				try {
					const tokens = this._readContextTokens();
					const win = (this._state.model as any)?.contextWindow;
					if (typeof tokens === "number" && tokens > 0 && typeof win === "number" && win > 0) {
						this._compactionStartPct = Math.min(100, Math.round((tokens / win) * 100));
					} else {
						this._compactionStartPct = null;
					}
				} catch {
					this._compactionStartPct = null;
				}
				// Open the overflow-recovery window so a trailing "prompt is too long"
				// retry error gets folded into the compaction card instead of
				// surfacing as a standalone red banner.
				if (this._triggerFromEvent(event) === "overflow") {
					this._overflowRecoveryDeadline = Date.now() + 60_000;
					this.apply({ type: "suppress-latest-context-overflow-error" });
				}
				// Add a rich in-progress synthetic so compaction is visible in chat history
				this._addCompactingPlaceholder(this._triggerFromEvent(event));
				// Normalize to compaction_start for UI subscribers
				if (event.type === "auto_compaction_start") {
					this.emit({ type: "compaction_start" } as any);
					return; // skip the default emit at the end
				}
				break;

			// The agent subprocess may send error responses with id:undefined
			// (upstream bug). These arrive as events rather than RPC responses.
			// Treat compact-related errors as compaction_end so the UI recovers —
			// but ONLY while a compaction is actually in flight. Without this guard
			// a stray failed `response` arriving AFTER a successful compaction
			// (e.g. an unrelated tool error or the well-known upstream id:undefined
			// frame) would synthesize a bogus `compaction_end { success: false }`
			// and overwrite the already-completed card (same stable `compact_active`
			// id) with a failure state.
			case "response":
				if (!event.success && event.error && this._isCompacting) {
					// Synthesize a compaction_end event so the blob animation ends
					this.emit({ type: "compaction_end", success: false, error: event.error });
				}
				break;

			case "compaction_end":
			case "auto_compaction_end": {
				this._isCompacting = false;
				this.onCompactionChange?.(false);
				// Minimum elapsed time the in-progress card must remain visible.
				// pi-coding-agent's compaction — especially auto/threshold paths —
				// can complete in well under a second. The bobbit-blob sprite
				// enforces its own min-duration via `StreamingMessageContainer.
				// COMPACT_MIN_DURATION` so the squash animation is actually seen.
				// Without a matching card-side floor the user sees "Context
				// compacted" appear while the sprite is still shaking. Use a
				// slightly shorter floor than the sprite (2.5 s vs 3.5 s) so the
				// card lands first and the sprite's pop-back animation lands a
				// beat later — reading as "done, settling" rather than
				// "done, still working". */
				const COMPACT_CARD_MIN_DURATION = 2500;
				// Success resolution: pi-coding-agent 0.74.0+ emits
				// `compaction_end { aborted, result, ... }` for the manual path
				// instead of the older `{ success: true|false }` shape that the
				// Bobbit ws-handler wrapper used to inject. Accept both: prefer
				// the explicit boolean, fall back to `!aborted`.
				const success = typeof event.success === "boolean"
					? event.success
					: !event.aborted;
				const trigger = this._triggerFromEvent(event);
				const errMsg: string | undefined =
					(event as any).errorMessage || (event as any).error;
				// tokensBefore resolution chain (see design doc §2.4):
				//   1. event.result.tokensBefore  — agent-emitted auto/overflow end
				//   2. event.tokensBefore         — server-emitted manual path
				//   3. parseOverflowTokenCount(errMsg) when overflow error path
				//   4. this._lastKnownContextTokens
				let tokensBefore: number | null =
					(event as any).result?.tokensBefore
					?? (event as any).tokensBefore
					?? null;
				if (tokensBefore == null && errMsg) {
					tokensBefore = parseOverflowTokenCount(errMsg);
				}
				if (tokensBefore == null) {
					tokensBefore = this._lastKnownContextTokens;
				}
				// tokensAfter is INTENTIONALLY null here. The server emits
				// `compaction_end` BEFORE broadcasting the post-compaction state
				// refresh, so reading context tokens now returns a stale value
				// from an earlier turn (manifests as a misleading "30% reduction"
				// when real reduction is 90%+). Instead we set null and amend
				// from the next successful assistant message_end's `usage`.
				// Overflow-trigger compactions ALWAYS get rendered as complete.
				// By the time upstream sends `auto_compaction_end { reason: "overflow" }`
				// the compaction operation itself has already run — even if the
				// subsequent retry fails. Whether the user's request ultimately
				// succeeds is a separate concern (surfaced via the normal assistant
				// `message_end` error path if the retry fails). Conflating the two
				// led to a card that looked like compaction had failed when it
				// hadn't.
				const displaySuccess = trigger === "overflow" ? true : success;
				const nowMs = Date.now();
				const startedAtMs = this._compactionStartedAt;
				// The server stamps a `compactionId` on the (successful) end event,
				// shared with the sidecar entry it just wrote. Carrying it on the
				// live `compact_active` card lets MessageList mount the
				// <bobbit-pre-compaction-history> affordance in-session — no reload
				// needed. The reducer dedups the server's spliced sidecar synthetic
				// against this card by matching compactionId (live card wins).
				const compactionId: string | undefined =
					typeof (event as any).compactionId === "string" && (event as any).compactionId.length > 0
						? (event as any).compactionId
						: undefined;
				const payload: CompactionSummaryPayload = {
					schemaVersion: 1,
					trigger,
					state: displaySuccess ? "complete" : "error",
					success: displaySuccess,
					timestamp: new Date(nowMs).toISOString(),
					startedAt: startedAtMs != null ? new Date(startedAtMs).toISOString() : undefined,
					durationMs: startedAtMs != null ? Math.max(0, nowMs - startedAtMs) : undefined,
					tokensBefore,
					tokensAfter: null,
					reductionPct: null,
					error: displaySuccess ? undefined : (errMsg || undefined),
					compactionId,
				};
				this._compactionStartedAt = null;
				// On hard compaction failure clear the stale flag immediately — no
				// post-compaction state is coming, the bar should resume normal
				// display from the existing transcript usage.
				if (!displaySuccess) {
					this._usageStaleAfterCompaction = false;
					this._compactionStartPct = null;
				}
				const { message, toolResult } = buildCompactionSummaryMessages(payload);
				const elapsedSinceStart = startedAtMs != null ? nowMs - startedAtMs : COMPACT_CARD_MIN_DURATION;
				const transitionCard = () => {
					this.apply({
						type: "compaction-result",
						message: withClientSystemAuthor(message),
						success: displaySuccess,
						toolResult: withClientSystemAuthor(toolResult),
					});
					// Queue this card for tokens-after amendment on the next clean
					// assistant `message_end` carrying usage.
					this._pendingCompactionAmend = payload;
					// When the min-visible-duration floor defers this transition into a
					// setTimeout, no agent event follows to drive a re-render (the
					// `compaction_end` emit below already fired synchronously, before
					// this runs). Emit a generic `render` so AgentInterface repaints the
					// card from in-progress → complete and reconciles the deduped
					// single-card state. Without this the in-flight card stays visible
					// alongside the persisted snapshot card.
					this.emit({ type: "render" } as any);
				};
				if (elapsedSinceStart < COMPACT_CARD_MIN_DURATION) {
					setTimeout(transitionCard, COMPACT_CARD_MIN_DURATION - elapsedSinceStart);
				} else {
					transitionCard();
				}
				// Normalize to compaction_end for UI subscribers
				if (event.type === "auto_compaction_end") {
					this.emit({ type: "compaction_end", success } as any);
					return; // skip the default emit at the end
				}
				// State and messages refresh will arrive from the server
				break;
			}
		}

		// Forward event to UI subscribers
		this.emit(event);
	}
}

function extractText(message: any): string {
	if (!message) return "";
	if (typeof message === "string") return message;
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text || "")
			.join("\n");
	}
	return "";
}


