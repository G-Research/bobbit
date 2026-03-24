# Prompt Queue & Message Dispatch

How user messages flow from the browser to the agent subprocess, how they queue when the agent is busy, and how the UI keeps in sync.

## Architecture overview

```
Browser (RemoteAgent)          Server (SessionManager)         Agent subprocess
─────────────────────          ───────────────────────         ─────────────────
  prompt() ──WS──►  enqueuePrompt()
                     ├─ idle + empty queue ──► rpcClient.prompt() ──► process
                     └─ busy or queue has items
                        ├─ PromptQueue.enqueue()
                        └─ broadcastQueue() ──WS──► queue_update
                                                     │
                     agent_end event ◄────────────────┘
                     ├─ drainQueue()
                     │  └─ dequeue next ──► rpcClient.prompt()
                     └─ broadcastQueue() ──WS──► queue_update
```

## Three dispatch paths

### 1. Direct dispatch (idle + empty queue)

The fast path. Agent is idle and nothing is queued — the prompt goes straight to the agent subprocess via `rpcClient.prompt()`. Title generation also fires here for the first message.

### 2. Enqueue (busy or queue non-empty)

Agent is streaming or the queue already has items. The message is added to `PromptQueue`, and a `queue_update` is broadcast to all connected clients so the UI can show the pending messages. If the agent happens to be idle (queue was non-empty), `drainQueue()` is called immediately.

### 3. Drain (agent becomes idle)

On `agent_end`, if the queue has items and the turn didn't end with an error, `drainQueue()` pops the next undispatched message and sends it via `rpcClient.prompt()`. Status is set to `"streaming"` optimistically to prevent a race where another `enqueuePrompt()` call sees idle+empty and dispatches a second concurrent prompt.

## Message types

### `prompt` (client → server)

Standard user message. Always routed through `enqueuePrompt()` — never sent directly to the agent.

### `steer` (client → server)

A mid-turn interrupt. Behavior depends on agent state:

- **Agent streaming**: Sent directly via `rpcClient.steer()` as a real-time interrupt between tool calls. Bypasses the queue entirely.
- **Agent idle**: Enqueued as a steered message (`isSteered: true`). Steered messages sort before normal messages in the queue.

### `follow_up` (client → server)

Similar to `prompt` but dispatched via `rpcClient.followUp()` instead of `rpcClient.prompt()`. Used when continuing a conversation after the agent finished (different RPC semantics in the agent subprocess). Routed through `enqueuePrompt()` like normal prompts.

### `steer_queued` (client → server)

Promotes an already-queued message to steered priority. If the agent is currently streaming, the steered message is immediately dispatched via `rpcClient.steer()` and marked as `dispatched` (kept in the queue for UI display until the user message appears in chat via `message_end`).

### `remove_queued` (client → server)

Removes a message from the queue. Broadcasts an updated queue.

### `queue_update` (server → client)

Sent whenever the queue changes — enqueue, dequeue, steer, remove. Contains the full queue array so clients can replace their local state.

## PromptQueue internals

`src/server/agent/prompt-queue.ts` — a per-session ordered queue with priority sorting.

**Ordering**: Steered messages always sort before non-steered. Within each group, insertion order is preserved (stable sort).

**Dispatched tracking**: When a steered message is sent mid-turn via `steer` RPC, it's marked `dispatched: true` but stays in the queue for UI display. On `message_end` for a user message, dispatched entries are cleaned up. On drain, `dequeueUndispatched()` skips already-dispatched messages.

**Persistence**: The queue is persisted to `.bobbit/state/sessions.json` (via `SessionStore.update`) on every mutation, and restored on server restart via `new PromptQueue(ps.messageQueue)`.

## Client-side rendering

`src/app/remote-agent.ts` handles the UI side:

### Optimistic user messages

When the user sends a prompt and the agent is **idle** (`!isStreaming`), `RemoteAgent.prompt()` adds the message to `state.messages` immediately with an `optimistic_*` id prefix. This ensures the message appears in chat without waiting for the server echo.

When the agent is **streaming** (prompt will be queued), no optimistic message is added. The server will echo it in the correct interleaved position when the queue drains and the agent processes it.

### Deduplication

When the server echoes a user message via `message_end`, `RemoteAgent` checks if an optimistic message with matching text already exists. If so, it replaces the optimistic message in-place (preserving position) rather than appending a duplicate.

### Live event tracking

`_liveEventMessages` tracks user messages received via live `message_end` events. This protects against a race where `get_messages` (reconnect, compaction) returns a stale snapshot that doesn't include a recently-sent user message. After the `messages` response replaces `state.messages`, any tracked messages missing from the response are re-appended.

### Queue display

The client receives `queue_update` events and stores them in `_serverQueue`. The UI can call `getQueue()` to show pending messages and offer steer/remove actions.

## Error handling

### Turn errors suppress queue draining

If a turn ends with `stopReason: "error"` (tracked via `lastTurnErrored`), `drainQueue()` is skipped on `agent_end`. Queued messages wait for the user to retry rather than being fed into a broken agent.

### Retry

`retryLastPrompt()` handles two cases:
- **Fresh error** (no tool calls executed): Re-sends `lastPromptText` via `rpcClient.prompt()`.
- **Mid-work error** (tool calls already ran): Sends a system continuation message so the agent picks up where it left off rather than re-executing tools.

### Dispatch failure

If `rpcClient.prompt()` fails during `drainQueue()`, the optimistic `"streaming"` status is reverted to `"idle"` and broadcast to clients.

## WS protocol summary

| Direction | Type | Purpose |
|-----------|------|---------|
| Client → Server | `prompt` | Send a user message (queued if busy) |
| Client → Server | `steer` | Mid-turn interrupt or queued-as-steered |
| Client → Server | `follow_up` | Continue after agent idle (different RPC) |
| Client → Server | `steer_queued` | Promote queued message to steered priority |
| Client → Server | `remove_queued` | Remove a message from the queue |
| Client → Server | `abort` | Cancel current turn (force-kills if needed) |
| Client → Server | `retry` | Retry after model/API error |
| Server → Client | `queue_update` | Full queue state after any mutation |
| Server → Client | `session_status` | `"streaming"` or `"idle"` status changes |

## Key files

| File | Role |
|------|------|
| `src/server/agent/prompt-queue.ts` | Queue data structure with priority sorting |
| `src/server/agent/session-manager.ts` | `enqueuePrompt()`, `drainQueue()`, `steerQueued()`, lifecycle |
| `src/server/ws/handler.ts` | WS command routing (`prompt`, `steer`, `follow_up`, etc.) |
| `src/server/ws/protocol.ts` | `QueuedMessage` type, client/server message unions |
| `src/app/remote-agent.ts` | Client-side optimistic rendering, dedup, queue state |
