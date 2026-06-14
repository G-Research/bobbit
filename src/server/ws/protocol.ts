import type { InboxEntry } from "../agent/inbox-store.js";
import type { SidePanelWorkspace } from "../../shared/side-panel-workspace.js";

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

/** A message waiting in the server-side prompt queue */
export interface QueuedMessage {
	id: string;
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
	attachments?: unknown[];
	isSteered: boolean;
	createdAt: number;
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

/** Client → Server messages over WebSocket */
export type ClientMessage =
	| { type: "auth"; token: string }
	| { type: "prompt"; text: string; images?: Array<{ type: "image"; data: string; mimeType: string }>; attachments?: unknown[] }
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
	| { type: "grant_tool_permission"; toolName: string; scope: "tool" | "group"; group?: string; mode?: "persistent" | "session-only" | "one-time" }
	| { type: "deny_tool_permission"; toolName: string }
	| { type: "reorder_queue"; messageIds: string[] }
	| { type: "restart_agent" }
	| { type: "resume"; fromSeq: number }
	| { type: "status_resync" }
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
	 * §8 C2.1. Routed over the TRUSTED WebSocket (NOT a fetch) so no capturable
	 * session secret ever rides a `fetch` pack code can monkey-patch, and pack code
	 * — which has no handle to the WS — cannot send it. The TARGET session is ALWAYS
	 * this connection's OWN authenticated session (never a frame field), so
	 * cross-session posting is structurally impossible. `requestId` correlates the
	 * async `ext_session_post_result` reply. `nonce` is the SERVER-MINTED, one-time,
	 * content-bound write permit from the preceding mint — REQUIRED: a replayed or
	 * forged frame fails permit consumption and is rejected with no post. `surfaceToken`
	 * is the SERVER-MINTED surface binding token the server DERIVES {packId, tool} from
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
	| { type: "auth_ok" }
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
	| { type: "gate_verification_step_started"; goalId: string; gateId: string; signalId: string; stepIndex: number; stepName: string; startedAt?: number; sessionId?: string; phase?: number; seq?: number }
	| { type: "gate_verification_step_output"; goalId: string; gateId: string; signalId: string; stepIndex: number; stream: "stdout" | "stderr"; text: string; ts: number; seq?: number }
	| { type: "gate_verification_step_complete"; goalId: string; gateId: string; signalId: string; stepIndex: number; stepName: string; status: "passed" | "failed" | "skipped"; durationMs: number; output: string; sessionId?: string; phase?: number; seq?: number }
	| { type: "gate_verification_complete"; goalId: string; gateId: string; signalId: string; status: string; seq?: number }
	| { type: "gate_status_changed"; goalId: string; gateId: string; status: string }
	| { type: "gate_reset"; goalId: string; gateId: string; affectedGateIds: string[]; changedGateIds: string[]; unchangedGateIds: string[] }
	| { type: "goal_setup_complete"; goalId: string }
	| { type: "goal_setup_error"; goalId: string; error: string }
	| { type: "team_agent_spawned"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "team_agent_dismissed"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "team_agent_finished"; goalId: string; sessionId: string; role: string; name: string }
	| { type: "inbox.entry.added"; staffId: string; entry: InboxEntry }
	| { type: "inbox.entry.updated"; staffId: string; entry: InboxEntry }
	| { type: "inbox.entry.removed"; staffId: string; entryId: string }
	| { type: "pr_status_changed"; goalId: string }
	| { type: "tool_permission_needed"; toolName: string; group: string; roleName: string; roleLabel: string; lastPromptText?: string; seq?: number; ts?: number }
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
