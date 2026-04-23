# WebSocket Protocol

Connect to `wss://<host>:<port>/ws/<session-id>`. First message must be `{ "type": "auth", "token": "<token>" }`. After `auth_ok`, the client can send commands and receives streaming events.

## Client → Server

| Type | Fields | Description |
|---|---|---|
| `auth` | `token` | Authenticate the connection |
| `prompt` | `text`, `images?`, `attachments?` | Send a user prompt |
| `steer` | `text` | Interrupt the agent mid-turn with guidance |
| `follow_up` | `text` | Send a follow-up message |
| `steer_queued` | `messageId` | Promote a queued message to steered (priority) |
| `remove_queued` | `messageId` | Remove a message from the queue |
| `reorder_queue` | `messageIds` | Reorder the prompt queue to match the given ID order |
| `abort` | — | Abort the current agent turn |
| `retry` | — | Retry the last failed turn |
| `set_model` | `provider`, `modelId` | Switch the AI model |
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
| `resume_gap` | `lastSeq` | Server's reply to a `resume` whose `fromSeq` is older than the retained EventBuffer window. Client must fall back to `get_messages` for a fresh snapshot and reset its seq counter to `lastSeq`. |
| `session_status` | `status` | Session status change (`idle`, `streaming`, `aborting`, etc.) |
| `session_title` | `sessionId`, `title` | Title changed |
| `client_joined` | `clientId` | Another client connected |
| `client_left` | `clientId` | A client disconnected |
| `error` | `message`, `code` | Error message |
| `pong` | — | Keepalive response |
| `cost_update` | `sessionId`, `goalId?`, `taskId?`, `cost` | Token usage and cost update |
| `queue_update` | `sessionId`, `queue` | Prompt queue changed |
| `task_changed` | `task` | A task was created, updated, or deleted |
| `tasks_list` | `tasks` | Full task list for a goal |
| `session_archived` | `sessionId`, `archivedAt` | Session was archived |
| `preferences_changed` | `preferences` | Server preferences were updated |
| `bg_process_created` | `process` | Background process started |
| `bg_process_output` | `processId`, `stream`, `text` | Output from a background process |
| `bg_process_exited` | `processId`, `exitCode` | Background process terminated |
| `gate_signal_received` | `goalId`, `gateId`, `signalId` | Gate signal received |
| `gate_verification_started` | `goalId`, `gateId`, `signalId` | Gate verification began |
| `gate_verification_step_started` | `goalId`, `gateId`, `stepIndex`, `stepName` | A verification step began |
| `gate_verification_step_output` | `goalId`, `gateId`, `stepIndex`, `stream`, `text` | Live output from a verification step |
| `gate_verification_step_complete` | `goalId`, `gateId`, `stepIndex`, `status` | A verification step finished (passed/failed) |
| `gate_verification_complete` | `goalId`, `gateId`, `signalId`, `status` | All verification steps finished |
| `gate_status_changed` | `goalId`, `gateId`, `status` | Gate status changed |
| `goal_setup_complete` | `goalId` | Goal worktree/team setup finished |
| `goal_setup_error` | `goalId`, `error` | Goal setup failed |
| `team_agent_spawned` | `goalId`, `sessionId`, `role`, `name` | Team agent was spawned |
| `team_agent_dismissed` | `goalId`, `sessionId`, `role`, `name` | Team agent was dismissed |
| `team_agent_finished` | `goalId`, `sessionId`, `role`, `name` | Team agent finished its turn |
| `pr_status_changed` | `goalId?`, `sessionId?`, `status` | PR status changed for a goal or session |
| `index:progress` | `projectId`, `phase`, `total`, `completed`, `backlog` | Search index progress. `phase` is `"rebuild"` or `"incremental"`. Debounced to 500ms per project. |
| `index:complete` | `projectId`, `phase`, `durationMs`, `rowsWritten` | Search index run finished (full rebuild or incremental drain) |
| `index:error` | `projectId`, `message`, `recoverable` | Search index error. `recoverable: true` for model/download failures; `false` for native-binary failures. |

### Streaming resume

Every `event` broadcast carries a server-assigned monotonic `seq` (per session, starting at 1) and wall-clock `ts`. The client tracks the highest `seq` it has seen and, on WebSocket reopen, sends `{ type: "resume", fromSeq: <highest> }` so the server replays only the tail it missed. If `fromSeq` is older than the oldest entry retained in the session's EventBuffer ring, the server replies `{ type: "resume_gap", lastSeq }` — the client then fetches a full snapshot via `get_messages` and resets its counter to `lastSeq`. This eliminates the duplicate/out-of-order frames that could appear during mid-stream reconnects. See [docs/internals.md — Event stream ordering & dedup](internals.md#event-stream-ordering--dedup) and [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md).

### Search index events

The `index:*` events drive the search status dot and the Settings → Maintenance → Search Index panel. They are never surfaced as foreground toasts or banners — users who want detail open the Maintenance panel. See [docs/internals.md — Semantic search](internals.md#semantic-search) for the full re-indexing model.
