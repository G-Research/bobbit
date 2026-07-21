import type { InboxEntry } from "../agent/inbox-store.js";
import type { MessageAuthor } from "../../shared/message-author.js";
import type { PromptSource } from "../../shared/prompt-source.js";
import type { VerificationTimeoutInfo } from "../agent/gate-store.js";
import type { GoalState } from "../agent/goal-store.js";
import type { SidePanelWorkspace } from "../../shared/side-panel-workspace.js";

export interface GateResetReopenOutcome {
	reopened: boolean;
	previousState: GoalState;
	state: GoalState;
}

/** Grant policy for tool access (self-contained — not imported from role-store for protocol independence). */
export type GrantPolicy = 'allow' | 'ask' | 'never';

/** Server-scheduled retry timer for a transient or provider-overload failure.
 *  Wrapped as an agent event in `{ type: "event", data: AutoRetryPendingEvent }`. */
export interface AutoRetryPendingEvent {
	type: "auto_retry_pending";
	/** "provider-overload" → 429 / explicit backoff hint; "transient-error" → other retryable. */
	reason: "provider-overload" | "transient-error";
	retryDelayMs: number;
	attempt: number;
	scheduledAt: number;
	error?: string;
}

/** Server cancelled a pending auto-retry timer.
 *  Wrapped as an agent event in `{ type: "event", data: AutoRetryCancelledEvent }`. */
export interface AutoRetryCancelledEvent {
	type: "auto_retry_cancelled";
	reason: "explicit-retry" | "new-prompt" | "terminated" | "shutdown";
	cancelledAt: number;
}

export type ProviderAuthRecoveryActionType = "open_settings" | "retry" | "switch_provider" | "abort_respawn";

export interface ProviderAuthRecoveryAction {
	type: ProviderAuthRecoveryActionType;
	label: string;
}

/** Provider credential failure that needs operator action.
 *  Wrapped as an agent event in `{ type: "event", data: ProviderAuthRequiredEvent }`. */
export interface ProviderAuthRequiredEvent {
	type: "provider_auth_required";
	provider: string;
	source: string;
	reason: "missing-api-key";
	message: string;
	actions: ProviderAuthRecoveryAction[];
	/** Diagnostic reason only. Clients must not render or persist this field. */
	error?: string;
}

export type SessionRecoveryEvent = AutoRetryPendingEvent | AutoRetryCancelledEvent | ProviderAuthRequiredEvent;

export type StaffChangedReason = "created" | "updated" | "reassigned" | "deleted";

/** A message waiting in the server-side prompt queue */
export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	createdAt: number;
	/** Internal prompt provenance; absent on legacy persisted queue rows. */
	source?: PromptSource;
	/** Accountable author resolved by the server; absent on legacy rows. */
	author?: MessageAuthor;
	/**
	 * When true, this prompt must NOT trigger first-message auto-title
	 * generation (used for assistant auto-kickoff prompts so naming fires on
	 * the first genuine user message instead of the kickoff text).
	 */
	suppressTitleGen?: boolean;
}

export interface SessionCostSnapshot {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalCost: number;
	/** Derived on read by current servers; optional for older persisted/WS payloads. */
	cacheHitRate?: number | null;
}

export type HostChannelFrame =
	| { kind: "text"; data: string }
	| { kind: "json"; data: unknown };

export interface HostChannelOpenInit {
	data?: unknown;
	singletonKey?: string;
}

export interface ChannelInfo {
	id: string;
	name: string;
	packId: string;
	sessionId: string;
	state: "opening" | "open" | "closing" | "closed";
	createdAt: number;
	lastActiveAt: number;
	attached: boolean;
	closeReason?: string;
}

/** Client → Server messages over WebSocket */
export type ClientMessage =
	// `clientKind` is routing/product metadata for connection setup. It is not an
	// unspoofable browser authority signal; endpoint auth still comes from the bearer
	// token plus server-side session/surface/capability checks.
	| { type: "auth"; token: string; clientKind?: "app" | "extension-channel" }
	| { type: "prompt"; text: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; attachments?: unknown[]; suppressTitleGen?: boolean }
	| { type: "steer"; text: string }
	| { type: "steer_queued"; messageId: string }
	| { type: "remove_queued"; messageId: string }
	| { type: "abort" }
	| { type: "retry" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "set_image_model"; provider: string; modelId: string }
	| { type: "set_thinking_level"; level: string }
	| { type: "compact" }
	| { type: "get_state" }
	| { type: "get_messages" }
	| { type: "set_title"; title: string }
	| { type: "generate_title" }
	| { type: "ping" }
	| { type: "task_create"; goalId: string; title: string; taskType: string; parentTaskId?: string; spec?: string; dependsOn?: string[] }
	| { type: "task_update"; taskId: string; updates: { title?: string; spec?: string; state?: string; assignedSessionId?: string; dependsOn?: string[] } }
	| { type: "task_delete"; taskId: string }
	| { type: "summarize_goal_title"; goalTitle: string }
	| { type: "grant_tool_permission"; toolName: string; scope: "tool" | "group"; group?: string; mode?: "persistent" | "session-only" | "one-time"; permissionId?: string }
	| { type: "deny_tool_permission"; toolName: string; permissionId?: string }
	| { type: "reorder_queue"; messageIds: string[] }
	| { type: "restart_agent" }
	| { type: "resume"; fromSeq: number }
	| { type: "status_resync" }
	| { type: "ext_surface_token"; requestId: string; surfaceTokenKey?: string; packId: string; contributionKind: "panel" | "entrypoint" | "route"; contributionId: string }
	| { type: "ext_channel_open_grant"; requestId: string; surfaceToken: string; name: string; singletonKey?: string }
	| { type: "ext_channel_open"; requestId: string; surfaceToken: string; name: string; init?: HostChannelOpenInit; openGrant: string }
	| { type: "ext_channel_attach"; requestId: string; surfaceToken: string; channelId: string }
	| { type: "ext_channel_list"; requestId: string; surfaceToken: string; opts?: { name?: string; includeClosed?: boolean } }
	| { type: "ext_channel_send"; requestId: string; channelId: string; frame: HostChannelFrame }
	| { type: "ext_channel_close"; requestId: string; channelId: string; reason?: string }
	| { type: "ext_channel_detach"; requestId: string; channelId: string }
	/**
	 * C2 session-WRITE permit MINT (`host.session.postMessage` step 1) — design
	 * extension-host-phase2.md §8 C2.1. The client requests a server-minted, one-time,
	 * content-bound nonce ONLY after its synchronous transient-activation assertion
	 * passes. `contentHash` is sha256 hex of `role + "\n" + text` (SubtleCrypto). The
	 * server binds the minted permit to {this connection's session, server-derived
	 * packId, tool, contentHash} and replies `ext_session_write_permit_result`. The
	 * `surfaceToken` is the SERVER-MINTED surface binding token (the client never sends
	 * a raw `tool`/`packId`); the server DERIVES {packId, tool} from it (surface-binding.ts).
	 */
	| { type: "ext_session_write_permit"; requestId: string; surfaceToken: string; contentHash: string }
	/**
	 * C2 session WRITE (`host.session.postMessage`) — design extension-host-phase2.md
	 * §8 C2.1. The sanctioned client path uses the session WebSocket (NOT a pack-
	 * callable fetch) so the target session is this connection's OWN authenticated
	 * session (never a frame field). Authorization/provenance comes from server-side
	 * session binding, surface-token identity, the user-gesture-gated client mint path,
	 * and a one-time content-bound permit — not from treating the browser transport as
	 * an unspoofable same-origin security boundary. `requestId` correlates the async
	 * `ext_session_post_result` reply. `nonce` is the SERVER-MINTED, one-time,
	 * content-bound write permit from the preceding mint; replayed or forged frames
	 * fail permit consumption and are rejected with no post. `surfaceToken` is the
	 * SERVER-MINTED surface binding token the server DERIVES {packId, tool} from
	 * (never a caller-supplied `tool`/`packId`; surface-binding.ts).
	 */
	| { type: "ext_session_post"; requestId: string; surfaceToken: string; role: "user" | "system"; text: string; resumeTurn?: boolean; nonce: string };

/**
 * Optional per-phase timing for a `get_messages` snapshot, attached only under
 * the dev harness (`BOBBIT_DEV_HARNESS=1`). Lets the client's boot-timing
 * sample attribute the reload's snapshot cost to agent-side assembly (`rpcMs`)
 * vs. server-side transform (`pipelineMs`/`stampMs`) vs. serialize
 * (`stringifyMs`). `bytes` is the serialized snapshot size.
 */
export interface SnapshotServerTiming {
	rpcMs: number;
	pipelineMs: number;
	stampMs: number;
	stringifyMs: number;
	bytes: number;
	msgCount: number;
}

/** Server → Client messages over WebSocket */
export type ServerMessage =
	| { type: "auth_ok"; surfaceTokenKey?: string }
	| { type: "ext_surface_token_result"; requestId: string; ok: boolean; token?: string; error?: string }
	| { type: "ext_channel_open_grant_result"; requestId: string; ok: boolean; openGrant?: string; error?: string }
	| { type: "ext_channel_result"; requestId: string; ok: boolean; channel?: ChannelInfo; channels?: ChannelInfo[]; error?: string; message?: string; status?: number }
	| { type: "ext_channel_frame"; channelId: string; frame: HostChannelFrame }
	| { type: "ext_channel_close"; channelId: string; reason?: string; error?: string }
	/** Async reply to an `ext_session_write_permit` mint (C2 session write, step 1).
	 *  On success carries the opaque one-time `nonce` to attach to `ext_session_post`;
	 *  on failure carries the server-side reason. */
	| { type: "ext_session_write_permit_result"; requestId: string; ok: boolean; nonce?: string; error?: string }
	/** Async ack for an `ext_session_post` (C2 session write). `ok:false` carries the
	 *  server-side authorization/validation error to surface to the pack. */
	| { type: "ext_session_post_result"; requestId: string; ok: boolean; error?: string }
	| { type: "auth_failed" }
	| { type: "state"; data: unknown }
	| { type: "messages"; data: unknown[]; serverTiming?: SnapshotServerTiming }
	| { type: "event"; data: unknown; seq?: number; ts?: number }
	| { type: "resume_gap"; lastSeq: number }
	| { type: "client_joined"; clientId: string }
	| { type: "client_left"; clientId: string }
	| { type: "error"; message: string; code: string }
	| {
		type: "session_status";
		status: "idle" | "streaming" | "aborting" | "preparing" | "archived" | "starting" | "terminated";
		/** Monotonic version of `session.status`. Bumped on every transition.
		 *  Heartbeat frames re-broadcast the current value WITHOUT bumping so the
		 *  client can treat them as idempotent (`<= lastStatusVersion` ⇒ ignore).
		 *  See docs/design/unify-session-status.md. */
		statusVersion: number;
		streamingStartedAt?: number;
		archivedAt?: number;
	}
	| { type: "session_archived"; sessionId: string; archivedAt: number }
	/** Sent to ALL authenticated clients (not just the session's own clients)
	 * when a session is terminated/archived/purged. Lets sidebars and dashboards
	 * react instantly instead of waiting for the 5s polling tick. The receiving
	 * client should remove the session from local lists and, if the user is
	 * currently viewing it, redirect to landing with a friendly toast. */
	| { type: "session_removed"; sessionId: string; projectId?: string; reason: "terminated" | "archived" | "purged" }
	/** Sent to ALL authenticated clients when a visible session is created so
	 * session navigation can refresh immediately instead of waiting for polling. */
	| { type: "session_created"; sessionId: string; projectId?: string }
	/** Broad invalidation fallback for session-list changes. */
	| { type: "sessions_changed"; projectId?: string }
	/** Sent to ALL authenticated clients when staff records change so staff and session sidebars can invalidate together. */
	| { type: "staff_changed"; reason: StaffChangedReason; staffId: string; projectId: string; previousProjectId?: string; sessionId?: string }
	| { type: "session_title"; sessionId: string; title: string }
	| { type: "pong" }
	| { type: "cost_update"; sessionId: string; goalId?: string; taskId?: string; cost: SessionCostSnapshot }
	| { type: "queue_update"; sessionId: string; queue: QueuedMessage[] }
	| { type: "side_panel_workspace"; sessionId: string; workspace: SidePanelWorkspace }
	| { type: "task_changed"; task: unknown }
	| { type: "tasks_list"; tasks: unknown[] }
	| { type: "bg_process_created"; process: { id: string; name: string; command: string; pid: number; status: "running" | "exited" | "unrecoverable"; exitCode: number | null; terminalReason: "normal" | "killed" | "unrecoverable" | null; startTime: number; endTime: number | null } }
	| { type: "bg_process_output"; processId: string; stream: "stdout" | "stderr"; text: string; ts: number }
	| { type: "bg_process_exited"; processId: string; exitCode: number | null; endTime: number | null; terminalReason: "normal" | "killed" | "unrecoverable" }
	| { type: "bg_process_dismissed"; processId: string }
	| { type: "gate_signal_received"; goalId: string; gateId: string; signalId: string }
	| { type: "gate_verification_started"; goalId: string; gateId: string; signalId: string; startedAt?: number; steps?: Array<{ name: string; type: string; phase?: number }>; seq?: number }
	| { type: "gate_verification_phase_started"; goalId: string; gateId: string; signalId: string; phase: number; stepIndices: number[]; seq?: number }
	| { type: "gate_verification_step_started"; goalId: string; gateId: string; signalId: string; stepIndex: number; stepName: string; startedAt?: number; sessionId?: string; timeoutSec?: number; phase?: number; seq?: number }
	| { type: "gate_verification_step_output"; goalId: string; gateId: string; signalId: string; stepIndex: number; stream: "stdout" | "stderr"; text: string; ts: number; seq?: number }
	| { type: "gate_verification_step_complete"; goalId: string; gateId: string; signalId: string; stepIndex: number; stepName: string; status: "passed" | "failed" | "timeout" | "skipped"; durationMs: number; output: string; sessionId?: string; timeout?: VerificationTimeoutInfo; phase?: number; seq?: number }
	| { type: "gate_verification_complete"; goalId: string; gateId: string; signalId: string; status: string; seq?: number }
	| { type: "gate_status_changed"; goalId: string; gateId: string; status: string }
	| { type: "gate_reset"; goalId: string; gateId: string; affectedGateIds: string[]; changedGateIds: string[]; unchangedGateIds: string[]; reopen: GateResetReopenOutcome }
	| { type: "goal_setup_complete"; goalId: string }
	| { type: "goal_setup_error"; goalId: string; error: string }
	| { type: "team_agent_spawned"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "team_agent_dismissed"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "team_agent_finished"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "inbox.entry.added"; staffId: string; entry: InboxEntry }
	| { type: "inbox.entry.updated"; staffId: string; entry: InboxEntry }
	| { type: "inbox.entry.removed"; staffId: string; entryId: string }
	| { type: "pr_status_changed"; goalId: string }
	| { type: "tool_permission_needed"; id?: string; toolName: string; group: string; roleName: string; roleLabel: string; lastPromptText?: string; requestCount?: number; seq?: number; ts?: number }
	| { type: "tool_permission_settled"; toolName: string; group?: string; status: "granted" | "denied" | "expired" | "superseded" | "cancelled" | "error"; reason?: string }
	| { type: "index:progress"; projectId: string; phase: "rebuild" | "incremental"; total: number; completed: number; backlog: number }
	| { type: "index:complete"; projectId: string; phase: "rebuild" | "incremental"; durationMs: number; rowsWritten: number }
	| { type: "index:error"; projectId: string; message: string; recoverable: boolean }
	| { type: "goal_spec_changed"; goalId: string; prevSpecHash: string; newSpecHash: string; prevLen: number; newLen: number; ts: number }
	| { type: "proposal_update"; sessionId: string; proposalType: "goal" | "project" | "role" | "tool" | "staff"; fields: Record<string, unknown>; rev: number; streaming: false; source: "edit" | "seed" | "rehydrate" | "restore" }
	| { type: "proposal_cleared"; sessionId: string; proposalType: "goal" | "project" | "role" | "tool" | "staff" }
	| {
		type: "skill_expansions";
		data: {
			originalText: string;
			modelText: string;
			ts: number;
			skillExpansions: Array<{
				name: string;
				args: string;
				source: string;
				filePath: string;
				range: [number, number];
				expanded: string;
			}>;
		};
	};
