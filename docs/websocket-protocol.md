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
| `abort` | — | Abort the current agent turn |
| `retry` | — | Retry the last failed turn |
| `set_model` | `provider`, `modelId` | Switch the AI model |
| `compact` | — | Trigger context compaction |
| `get_state` | — | Request current agent state |
| `get_messages` | — | Request full message history |
| `set_title` | `title` | Set session title |
| `generate_title` | — | Auto-generate title from conversation |
| `ping` | — | Keepalive ping |
| `invoke_skill` | `skillId`, `context?` | Invoke an isolated skill sub-agent |
| `task_create` | `goalId`, `title`, `taskType`, `parentTaskId?`, `spec?`, `dependsOn?` | Create a task |
| `task_update` | `taskId`, `updates` | Update a task (title, spec, state, assignment, deps) |
| `task_delete` | `taskId` | Delete a task |

## Server → Client

| Type | Key Fields | Description |
|---|---|---|
| `auth_ok` | — | Authentication succeeded |
| `auth_failed` | — | Authentication failed |
| `state` | `data` | Current agent state snapshot |
| `messages` | `data` | Full message history array |
| `event` | `data` | Streaming agent event (message_start, content_delta, tool calls, etc.) |
| `session_status` | `status` | Session status change (idle, streaming, etc.) |
| `session_title` | `sessionId`, `title` | Title changed |
| `client_joined` | `clientId` | Another client connected |
| `client_left` | `clientId` | A client disconnected |
| `error` | `message`, `code` | Error message |
| `pong` | — | Keepalive response |
| `skill_started` | `skillId` | Skill execution began |
| `skill_completed` | `skillId`, `result` | Skill produced output |
| `skill_failed` | `skillId`, `error` | Skill execution failed |
| `cost_update` | `sessionId`, `goalId?`, `taskId?`, `cost` | Token usage and cost update |
| `queue_update` | `sessionId`, `queue` | Prompt queue changed |
| `task_changed` | `task` | A task was created, updated, or deleted |
| `tasks_list` | `tasks` | Full task list for a goal |
| `preferences_changed` | `preferences` | Server preferences were updated |
| `gate_verification_started` | `goalId`, `gateId`, `signalId` | Gate verification began |
| `gate_verification_step_started` | `goalId`, `gateId`, `stepIndex`, `stepName` | A verification step began |
| `gate_verification_step_output` | `goalId`, `gateId`, `stepIndex`, `stream`, `text` | Live output from a verification step |
| `gate_verification_step_complete` | `goalId`, `gateId`, `stepIndex`, `status` | A verification step finished (passed/failed) |
| `gate_verification_complete` | `goalId`, `gateId`, `signalId`, `status` | All verification steps finished |
