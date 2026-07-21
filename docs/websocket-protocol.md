# WebSocket Protocol

Bobbit exposes two WebSocket entrypoints. Both require the first frame to be `auth` and close unauthenticated sockets.

## Endpoints

### Session sockets: `/ws/<session-id>`

Connect to `wss://<host>:<port>/ws/<session-id>`. First message must be `{ "type": "auth", "token": "<token>" }`. After `auth_ok`, the client can send session commands and receives streaming session events.

### Viewer sockets: `/ws/viewer`

The goal dashboard uses `wss://<host>:<port>/ws/viewer` when no agent session is active. First message is `{ "type": "auth", "token": "<token>", "goalId": "<optional-goal-id>" }`; the optional `goalId` seeds the viewer's goal-subscription set before `auth_ok`.

After `auth_ok`, a viewer socket is authenticated but not associated with a session and is not added to `SessionManager` clients. It accepts only viewer subscription messages and `ping`; messages outside that set have no effect.

Goal-scoped broadcasts (`gate_*`, `team_*`, `goal_*`) reach viewer sockets only when they are subscribed to the matching `goalId`. Session sockets for agents that belong to that goal still receive those same events. Search/index broadcasts (`index:*`) are project broadcasts rather than goal broadcasts, so they still reach authenticated viewer sockets regardless of goal subscription.

Session-list invalidations (`session_created`, `sessions_changed`, and `session_removed`) are global. The browser keeps a lightweight `/ws/viewer` connection open even when no session `RemoteAgent` is active, so desktop sidebars, mobile landing pages, and dashboards can refresh `GET /api/sessions` promptly instead of waiting for the periodic poll. Session sockets also handle the same invalidations for already-open chats. Treat these messages as refresh triggers only; the session list REST response remains the source of truth.

## Frame size routing and limits

Bobbit has separate limits for the socket transport, the chat composer, and Extension Host channel envelopes. They are intentionally layered so normal chat prompts can carry large legitimate payloads while channel traffic stays bounded.

| Limit | Source of truth | Scope | Current default | Why it exists |
|---|---|---|---|---|
| WebSocket transport payload | `WS_MAX_PAYLOAD_BYTES` in `src/server/server.ts` | All inbound frames accepted by the gateway WebSocket server | 256 MiB | Keeps the `ws` transport bounded, but high enough that the composer can reject oversized prompt sends with a clear UI error before the socket is torn down. |
| Composer serialized-send guard | `MessageEditor.MAX_SERIALIZED_SEND_BYTES` in `src/ui/components/MessageEditor.ts` | User prompt sends assembled by the message editor, especially attachment/image sends whose serialized prompt frame can include multiple base64 copies | 200 MiB | Gives users an actionable inline error and preserves the draft/attachments instead of relying on transport-level close behavior. |
| Extension-channel envelope cap | `MAX_EXTENSION_CHANNEL_WS_ENVELOPE_BYTES` in `src/server/ws/handler.ts` | Authenticated client messages whose `type` is `ext_channel_*` | 1 MiB | Keeps generic Extension Host channel operation envelopes cheap to parse and route; channel handlers still enforce their own contribution quotas. |

Routing rules:

- The first unauthenticated frame is only expected to authenticate. Oversized unauthenticated frames are rejected before command routing to avoid parsing arbitrary large unauthenticated input.
- After authentication, non-extension session commands such as `prompt`, `steer`, `follow_up`, queue edits, `ext_session_write_permit`, and `ext_session_post` are governed by the WebSocket transport limit plus their feature-specific validation. They are **not** rejected solely because the serialized frame is larger than the 1 MiB extension-channel envelope cap.
- Prompt frames sent from the browser composer should stay below `MessageEditor.MAX_SERIALIZED_SEND_BYTES`, which is deliberately lower than `WS_MAX_PAYLOAD_BYTES`. This ordering makes the composer error the common failure mode for oversized attachment sends, not a socket close.
- Extension-channel operations (`ext_channel_open_grant`, `ext_channel_open`, `ext_channel_attach`, `ext_channel_list`, `ext_channel_send`, `ext_channel_close`, `ext_channel_detach`) remain capped by `MAX_EXTENSION_CHANNEL_WS_ENVELOPE_BYTES`. If one is too large, the server returns a structured size error and leaves the socket usable. With a `requestId`, callers receive an `ext_channel_result` or `ext_channel_open_grant_result` failure; without one, the fallback is a normal `error` frame with code `FRAME_TOO_LARGE`.
- The 1 MiB cap is only an envelope guard. It does not replace per-channel quotas such as declared frame and inbound-byte limits, pack identity checks, open grants, attachment checks, or session-write permits.

## Outbound payload bounding and backpressure

Bobbit keeps normal streaming responsive by bounding payloads before they enter the session EventBuffer or high-fanout goal broadcasts. The goal is not to hide diagnostic data; it is to keep the live socket path small and make large data available through explicit inspection endpoints.

- **Session events and history** — agent `message_update` / `message_end` events pass through large-content truncation before `emitSessionEvent()` pushes them into the EventBuffer and broadcasts them. The same truncation is applied to `get_messages` snapshots. Large tool text, preview snapshots, and `verification_result.summary` / `verification_result.report_html` are replaced with preview descriptors while the full transcript remains in the agent history or artifact store.
- **Gate verification output** — `gate_verification_step_output.text` is capped to a live preview, and `gate_verification_step_complete.output` is capped separately. Truncated events carry `textTruncated` / `outputTruncated` plus original and preview byte counts. Use `gate_inspect(section="verification", mode=...)` or retained diagnostics for full logs.
- **Goal broadcasts** — gate/team/goal events fan out to every matching goal session socket plus subscribed `/ws/viewer` sockets. This path uses the same overflow guard as per-session broadcasts and logs whether the backed-up recipient was a `goal-session` or `goal-viewer`.
- **Overflow guard** — when `bufferedAmount` exceeds the warning threshold, the server logs payload diagnostics. When it exceeds the overflow threshold, the server sends the current frame, waits for a short drain window, and terminates only if the socket remains backed up. The reconnect/resume path then recovers with either a bounded replay or `resume_gap`.

Overflow diagnostics include `outerType`, `innerType` for `{ type: "event" }` frames, serialized `bytes`, recipient kind, and context such as `goalId`. These fields are the first place to look when a reconnect storm follows verification or reviewer activity.

## Client → Server

| Type | Fields | Description |
|---|---|---|
| `auth` | `token`, `goalId?` | Authenticate the connection. `goalId` is only used by `/ws/viewer` to subscribe immediately after auth. |
| `subscribe_goal` | `goalId` | `/ws/viewer` only: add a goal subscription for goal-scoped broadcasts. |
| `unsubscribe_goal` | `goalId` | `/ws/viewer` only: remove one goal subscription. |
| `clear_goal_subscriptions` | — | `/ws/viewer` only: remove all goal subscriptions. |
| `prompt` | `text`, `images?`, `attachments?` | Send a user prompt |
| `steer` | `text` | Interrupt the agent mid-turn with guidance |
| `follow_up` | `text` | Send a follow-up message |
| `steer_queued` | `messageId` | Promote a queued message to steered (priority) |
| `remove_queued` | `messageId` | Remove a message from the queue |
| `reorder_queue` | `messageIds` | Reorder the prompt queue to match the given ID order |
| `abort` | — | Abort the current agent turn |
| `retry` | — | Retry the last failed turn |
| `restart_agent` | — | Restart the agent process for this socket's session. This is the active-session path; the sidebar `Refresh agent` action uses `POST /api/sessions/:id/restart` to target any live row by id. Both paths call the same session-manager restart implementation. |
| `grant_tool_permission` | `toolName`, `scope`, `group?`, `mode?` | Grant the active `ask`-gated tool request for one tool or a tool group. `mode` is `persistent`, `session-only`, or `one-time`; see [Permission Card UX](permission-card-ux.md). |
| `deny_tool_permission` | `toolName` | Deny the active `ask`-gated tool request so the guard long-poll returns immediately. |
| `set_model` | `provider`, `modelId` | Switch the AI model |
| `set_image_model` | `provider`, `modelId` | Switch the per-session image generation model. Server validates `(provider, modelId)` against `getAvailableImageModels()`; on unknown the server replies with `{ type: "error", message: "unknown image model", code: "UNKNOWN_IMAGE_MODEL" }` and does **not** mutate session state. On valid, persists `imageModelProvider`/`imageModelId` to the session row and broadcasts the updated state to all attached clients. |
| `compact` | — | Trigger context compaction |
| `get_state` | — | Request current agent state |
| `get_messages` | — | Request full message history |
| `set_title` | `title` | Set session title |
| `generate_title` | — | Auto-generate title from conversation |
| `resume` | `fromSeq` | Resume streaming after a reconnect — server replays only events with `seq > fromSeq` (see [Streaming resume](#streaming-resume)) |
| `ping` | — | Keepalive ping |
| `task_create` | `goalId`, `title`, `taskType`, `parentTaskId?`, `spec?`, `dependsOn?` | Create a task |
| `task_update` | `taskId`, `updates` | Update a task (title, spec, state, assignment, deps) |
| `task_delete` | `taskId` | Delete a task |
| `summarize_goal_title` | `goalTitle` | Auto-generate a shorter goal title |

## Server → Client

| Type | Key Fields | Description |
|---|---|---|
| `auth_ok` | — | Authentication succeeded |
| `auth_failed` | — | Authentication failed |
| `state` | `data` | Current agent state snapshot |
| `messages` | `data` | Full message history array |
| `event` | `data`, `seq?`, `ts?` | Streaming agent event (message_start, content_delta, tool calls, etc.). `seq` is a monotonic per-session counter starting at 1; `ts` is wall-clock ms at broadcast time. Both are optional for backward compatibility — old clients that ignore them still function correctly. |
| `resume_gap` | `lastSeq` | Server's reply when `resume` cannot safely replay the missed tail. This can mean the requested `fromSeq` is outside the retained EventBuffer window, the replay would exceed the resume byte budget, or the socket is already backed up. Client must fall back to `get_messages` for a fresh snapshot and reset its seq counter to `lastSeq`. |
| `session_status` | `status` | Session status change (`idle`, `streaming`, `aborting`, etc.) |
| `session_title` | `sessionId`, `title` | Title changed |
| `session_created` | `sessionId`, `projectId?` | A visible session was created through REST, UI, or `host.agents`; clients should refresh the session list immediately. |
| `sessions_changed` | `projectId?` | Broad session-list invalidation fallback; clients should refresh the session list. |
| `session_removed` | `sessionId`, `projectId?`, `reason` | A session was terminated, archived, or purged; clients should remove or refresh the matching row promptly. |
| `staff_changed` | `reason`, `staffId`, `projectId`, `previousProjectId?`, `sessionId?` | A staff record was created, updated, reassigned, or deleted through REST/tool paths. Clients should reload staff and orphaned-staff state before refreshing sessions so permanent staff-agent sessions are classified under Staff instead of regular Sessions. |
| `client_joined` | `clientId` | Another client connected |
| `client_left` | `clientId` | A client disconnected |
| `error` | `message`, `code` | Error message |
| `pong` | — | Keepalive response |
| `cost_update` | `sessionId`, `goalId?`, `taskId?`, `cost` | Cumulative persisted session cost snapshot. Sent after live completed assistant usage and during hydration paths when persisted cost exists. Current servers include `cost.cacheHitRate`; see [Cost update shape](#cost-update-shape). |
| `queue_update` | `sessionId`, `queue` | Prompt queue changed |
| `side_panel_workspace` | `sessionId`, `workspace` | The server-authoritative side-panel workspace for the session changed. Clients replace their local mirror only when `workspace.revision` is newer; see [side-panel-workspace.md](side-panel-workspace.md). |
| `task_changed` | `task` | A task was created, updated, or deleted |
| `tasks_list` | `tasks` | Full task list for a goal |
| `session_archived` | `sessionId`, `archivedAt` | Session was archived |
| `preferences_changed` | `preferences` | Server preferences were updated |
| `bg_process_created` | `process` (`BgProcessInfo`) | Background process started; `process.endTime` is `null` |
| `bg_process_output` | `processId`, `stream`, `text` | Output from a background process |
| `bg_process_exited` | `processId`, `exitCode`, `endTime`, `terminalReason` | Background process terminated; `endTime` is the fixed exit timestamp. `exitCode` is `number \| null` (null when no real code was captured). `terminalReason` is `"normal" \| "killed" \| "unrecoverable"` |
| `bg_process_dismissed` | `processId` | A background process record was dismissed (removed) and its persisted log/status files purged |
| `gate_signal_received` | `goalId`, `gateId`, `signalId` | Gate signal received |
| `gate_verification_started` | `goalId`, `gateId`, `signalId` | Gate verification began |
| `gate_verification_step_started` | `goalId`, `gateId`, `stepIndex`, `stepName` | A verification step began |
| `gate_verification_step_output` | `goalId`, `gateId`, `stepIndex`, `stream`, `text`, `textTruncated?`, `originalTextBytes?`, `previewTextBytes?` | Live output from a verification step. Large chunks are truncated to a bounded WS preview; full output remains available through gate inspection/retained diagnostics. |
| `gate_verification_step_complete` | `goalId`, `gateId`, `stepIndex`, `status`, `outputTruncated?`, `originalOutputBytes?`, `previewOutputBytes?` | A verification step finished (passed/failed). Large completion output is truncated to a bounded WS preview; full output remains available through gate inspection/retained diagnostics. |
| `gate_verification_awaiting_human` | `goalId`, `gateId`, `signalId`, `stepIndex`, `stepName`, `label`, `prompt` | A `human-signoff` step parked waiting on a human decision. Resolution emits `gate_verification_step_complete` (no separate event). See [goals-workflows-tasks.md — Human sign-off steps](goals-workflows-tasks.md#human-sign-off-steps). |
| `gate_verification_complete` | `goalId`, `gateId`, `signalId`, `status` | All verification steps finished |
| `gate_status_changed` | `goalId`, `gateId`, `status` | Gate status changed |
| `gate_reset` | `goalId`, `gateId`, `affectedGateIds`, `changedGateIds`, `unchangedGateIds`, `reopen` | A gate reset invalidated the requested gate and downstream dependents. `reopen` is the lifecycle outcome described below. Clients should refresh gate summaries for all affected ids. |
| `goal_state_changed` | `goalId` | Goal persistence changed. Treat as an invalidation and refresh goal-list state; reset-driven reopening emits this globally only when it performs `complete` → `in-progress`. |
| `goal_setup_complete` | `goalId` | Goal worktree/team setup finished |
| `goal_setup_error` | `goalId`, `error` | Goal setup failed |
| `team_agent_spawned` | `goalId`, `sessionId`, `role`, `name` | Team agent was spawned |
| `team_agent_dismissed` | `goalId`, `sessionId`, `role`, `name` | Team agent was dismissed |
| `team_agent_finished` | `goalId`, `sessionId`, `role`, `name` | Team agent finished its turn |
| `pr_status_changed` | `goalId?`, `sessionId?`, `status` | PR status changed for a goal or session |
| `tool_permission_needed` | `toolName`, `group`, `roleName`, `roleLabel`, `lastPromptText?`, `seq?`, `ts?` | A guarded tool call is blocked pending user approval. The frame is ordered with the transcript so the client can render the blocked tool call and permission row coherently. |
| `tool_permission_settled` | `toolName`, `group?`, `status`, `reason?` | The active permission request settled as `granted`, `denied`, `expired`, `superseded`, `cancelled`, or `error`. Clients keep inline history and remove non-actionable rows from pinned controls. |
| `index:progress` | `projectId`, `phase`, `total`, `completed`, `backlog` | Search index progress. `phase` is `"rebuild"` or `"incremental"`. Debounced to 500ms per project. |
| `index:complete` | `projectId`, `phase`, `durationMs`, `rowsWritten` | Search index run finished (full rebuild or incremental drain) |
| `index:error` | `projectId`, `message`, `recoverable` | Search index error. `recoverable: true` for model/download failures; `false` for native-binary failures. |
| `inbox.entry.added` | `staffId`, `entry` | A new inbox entry was enqueued for a staff agent (trigger fire, `POST /api/staff/:id/inbox`, or UI "+ Add to inbox"). See [staff-inbox.md](staff-inbox.md). |
| `inbox.entry.updated` | `staffId`, `entry` | A staff agent transitioned an inbox entry via `inbox_complete` / `inbox_dismiss`. |
| `inbox.entry.removed` | `staffId`, `entryId` | An inbox entry was pruned (`DELETE /api/staff/:id/inbox/:entryId`). Entry body not echoed — clients reconcile by id. |

### Gate reset lifecycle payload

Every `gate_reset` event includes this additive object, matching the REST reset response exactly:

```json
{
  "reopen": {
    "reopened": true,
    "previousState": "complete",
    "state": "in-progress"
  }
}
```

- `reopened: boolean` — `true` only when this request changed an active completed goal to `in-progress`.
- `previousState` — the goal state observed for this reset.
- `state` — the resulting goal state. Both state fields use `todo | in-progress | complete | shelved | blocked`.

A new successful reset emits `gate_reset`, including a no-op retry after a previously finalized reset. For an already reopened goal, that retry carries `{ "reopened": false, "previousState": "in-progress", "state": "in-progress" }`. It does not emit a second `goal_state_changed` or duplicate the team runtime rearm/lead notice when no gates changed.

A retry that resumes a retained write-ahead intent is different: its job is to finish runtime rearm or intent cleanup after the goal and gates already committed. It returns the original affected scope and reopen outcome through REST, but suppresses duplicate `gate_status_changed`, `gate_reset`, `goal_state_changed`, and lead notification. This makes transport effects idempotent as well as persistence.

On an actual reopen, `goal_state_changed { goalId }` is broadcast globally so sidebar, dashboard, status widget, and other browser contexts refresh their goal-list cache immediately. Goal-scoped `gate_status_changed` and `gate_reset` events update gate views. The widget's own viewer subscription refreshes goals, gates, and active verifications on `goal_state_changed`, so an external reopen reconciles even without an active chat socket.

The widget does not treat completion as a permanent local latch. While its popover is open it mirrors the authoritative app goal cache, so an external `team_complete` observed by the normal goal refresh/poll switches it to completed; the same mirror can later switch back on reopen. For an initiating reset it applies the REST `reopen.state` and affected pending gates immediately, then performs authoritative goal/gate/verification reads. The response is therefore a latency optimization, not a second source of lifecycle truth.

Dormant archived, shelved, or paused goals return REST `409`; they produce no `gate_reset` or reopen-driven `goal_state_changed` event. See [REST API — Durable reset transaction](rest-api.md#durable-reset-transaction) and [Goals, Workflows & Tasks — Reset-driven goal reopening](goals-workflows-tasks.md#reset-driven-goal-reopening).

### Background process events

`BgProcessInfo` snapshots carry `{ id, name, command, pid, status, exitCode, terminalReason, startTime, endTime }`, where timestamps are epoch milliseconds. `status` is `"running" | "exited" | "unrecoverable"`. `exitCode` is `number | null`. `terminalReason` is `"normal" | "killed" | "unrecoverable" | null` (null while running). Running processes have `endTime: null`; exited processes set `endTime` once at child exit.

`bg_process_created` sends the full running snapshot. `bg_process_exited` sends `{ processId, exitCode, endTime, terminalReason }` so clients can update an existing pill without waiting for REST hydration: `terminalReason` distinguishes a clean exit (`"normal"`), a user-requested kill (`"killed"`), and a process whose real exit code could not be recovered after a gateway restart (`"unrecoverable"`); in the latter two cases `exitCode` is `null` and clients must not fabricate one. Missing legacy `endTime` values mean the final runtime is unknown; clients should keep the display non-growing rather than deriving elapsed time from `Date.now()`.

`bg_process_dismissed` (`{ processId }`) fires when a record is removed — either via explicit dismiss or as part of the legacy kill-then-dismiss path — and signals that the pill should disappear and its persisted log/status files have been purged. Dismiss is rejected (REST 409) while a process is still running; clients kill it first, then dismiss the resulting exited record.

### Session cost hydration

`cost_update.cost` has the same shape as `state.serverCost`: cumulative input/output/cache token totals plus `totalCost`, with `cacheHitRate` included by current servers. The payload is read from persisted `CostTracker` data and is not a delta; clients should replace their cached cost snapshot, not add it locally.

When persisted cost exists, the server hydrates it on active attach/reconnect, `get_state`, `get_messages`, resume/replay fallback, archived attach/state/messages, and `refreshAfterCompaction()`. `refreshAfterCompaction()` sends `cost_update` before the compacted `messages` snapshot so the UI keeps showing cumulative spend instead of recalculating from the reduced visible transcript.

See [session-cost.md](session-cost.md) for the source-of-truth and no-double-counting rules.

### Cost update shape

The `cost` field of a `cost_update` message:

```json
{
  "inputTokens": 12500,
  "outputTokens": 340,
  "cacheReadTokens": 87000,
  "cacheWriteTokens": 3200,
  "totalCost": 0.004712,
  "cacheHitRate": 0.874
}
```

- `cacheHitRate?: number | null` — derived ratio `cacheReadTokens / (cacheReadTokens + inputTokens)`. `null` when the denominator is 0 (cold session, or provider that does not report cache counters). Optional for mixed-version compatibility with older payloads.
- Older clients that do not recognise `cacheHitRate` silently ignore it.

See [docs/cache-hit-rate.md](cache-hit-rate.md) for formula details and null semantics.

### Streaming resume

Every `event` broadcast carries a server-assigned monotonic `seq` (per session, starting at 1) and wall-clock `ts`. The client tracks the highest `seq` it has seen and, on WebSocket reopen, sends `{ type: "resume", fromSeq: <highest> }` so the server replays only the tail it missed.

Resume replay is bounded twice: the EventBuffer retains only the recent ring of session events, and the serialized replay tail must fit within the resume byte budget. Before replaying, the server also waits briefly for an already-backed-up socket to drain, then paces individual event sends. If the window is missed, the replay would be too large, or the socket remains backed up, the server replies `{ type: "resume_gap", lastSeq }`. The client then fetches a full snapshot via `get_messages` and resets its counter to `lastSeq`.

The fallback preserves ordering without rebuilding the same multi-megabyte send queue that caused the reconnect. Full snapshots are also payload-bounded before delivery, so large tool output or verification reports do not re-enter the socket as one unbounded history frame. See [docs/internals.md — Event stream ordering & dedup](internals.md#event-stream-ordering--dedup) and [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md).

### Search index events

The `index:*` events drive the search status dot and the Settings → Maintenance → Search Index panel. They are never surfaced as foreground toasts or banners — users who want detail open the Maintenance panel. See [docs/internals.md — Semantic search](internals.md#semantic-search) for the full re-indexing model.
