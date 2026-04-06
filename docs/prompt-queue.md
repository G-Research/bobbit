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

  steer()  ──WS──►  (streaming?) ──► rpcClient.steer() ──► injected mid-turn
```

## Four dispatch paths

### 1. Direct dispatch (idle + empty queue)

The fast path. Agent is idle and nothing is queued — the prompt goes straight to the agent subprocess via `rpcClient.prompt()`. Title generation also fires here for the first message.

### 2. Enqueue (busy or queue non-empty)

Agent is streaming or the queue already has items. The message is added to `PromptQueue`, and a `queue_update` is broadcast to all connected clients so the UI can show the pending messages. If the agent happens to be idle (queue was non-empty), `drainQueue()` is called immediately.

Note: when the agent is streaming and the user sends a text-only message via the UI, `sendMessage()` uses the steer path (path 4) instead of enqueuing. Messages only reach this enqueue path during streaming if they have attachments (the steer protocol is text-only) or are sent programmatically via `{ type: "prompt" }`.

### 3. Drain (agent becomes idle)

On `agent_end`, if the queue has items and the turn didn't end with an error, `drainQueue()` pops the next undispatched message and sends it via `rpcClient.prompt()`. Status is set to `"streaming"` optimistically to prevent a race where another `enqueuePrompt()` call sees idle+empty and dispatches a second concurrent prompt.

### 4. Direct steer (streaming, text-only)

When the user sends a text-only message while the agent is streaming, `AgentInterface.sendMessage()` calls `session.steer()` instead of `session.prompt()`. This sends `{ type: "steer" }` over WebSocket, and the server dispatches it immediately via `rpcClient.steer()` — injected between tool calls without waiting for the turn to end. The message bypasses the queue entirely. An optimistic user message is rendered in chat so the user sees it immediately.

This path is only used when: (a) the agent is streaming, and (b) the message has no attachments (the steer WS protocol is text-only). Messages with attachments fall back to `session.prompt()` and are enqueued via path 2.

## Message types

### `prompt` (client → server)

Standard user message. Always routed through `enqueuePrompt()` — never sent directly to the agent.

### `steer` (client → server)

A mid-turn redirect. Behavior depends on agent state:

- **Agent streaming**: Dispatched **immediately** via `rpcClient.steer()` — injected between tool calls in real-time. The message is NOT queued. The UI sends `steer` (instead of `prompt`) when `isStreaming` is true and there are no attachments. Optimistic rendering adds the user message to chat immediately.
- **Agent idle**: Enqueued as a steered message. Steered messages sort before normal messages in the queue.

### `follow_up` (client → server)

Similar to `prompt` but dispatched via `rpcClient.followUp()` instead of `rpcClient.prompt()`. Used when continuing a conversation after the agent finished (different RPC semantics in the agent subprocess). Routed through `enqueuePrompt()` like normal prompts. The `isFollowUp` flag is preserved on the `QueuedMessage` so that queued follow-ups dispatch via the correct RPC method on drain.

### `steer_queued` (client → server)

Promotes an already-queued message to steered priority. The steered message is reordered to the top and shows a "Sent" badge in the UI. Unlike direct `steer` (which is dispatched immediately during streaming), promoted steers are held until the user triggers an abort — on `forceAbort()`, all steered+undispatched messages are concatenated and sent as a single `rpcClient.steer()` call. This batching ensures multiple promoted messages arrive as one coherent block rather than racing individually.

### `remove_queued` (client → server)

Removes a message from the queue. Broadcasts an updated queue.

### `reorder_queue` (client → server)

Reorders the queue to match a given array of message IDs. Unknown IDs are ignored; messages not listed are appended at the end. Broadcasts updated queue. Used by the drag-to-reorder UI on queue pills.

### `queue_update` (server → client)

Sent whenever the queue changes — enqueue, dequeue, steer, remove, reorder. Contains the full queue array so clients can replace their local state.

## PromptQueue internals

`src/server/agent/prompt-queue.ts` — a per-session ordered queue with priority sorting.

**Ordering**: Steered messages always sort before non-steered. Within each group, insertion order is preserved (stable sort). The client can explicitly reorder via `reorder(messageIds)` — the queue adopts the given ID order, with unlisted items appended at the end.

**Dispatched tracking**: When steered messages are sent on abort via `rpcClient.steer()`, they're marked `dispatched: true` but stay in the queue for UI display. On `message_end` for a user message, dispatched entries are cleaned up. On drain, `dequeueUndispatched()` skips already-dispatched messages.

**follow_up preservation**: `QueuedMessage` carries an optional `isFollowUp` flag. When set, `drainQueue()` dispatches via `rpcClient.followUp()` instead of `rpcClient.prompt()`, preserving the correct RPC semantics through the queue.

**Persistence**: The queue is persisted to `.bobbit/state/sessions.json` (via `SessionStore.update`) on every mutation, and restored on server restart via `new PromptQueue(ps.messageQueue)`.

## Client-side rendering

`src/app/remote-agent.ts` handles the UI side:

### Optimistic user messages

When the user sends a prompt and the agent is **idle** (`!isStreaming`), `RemoteAgent.prompt()` adds the message to `state.messages` immediately with an `optimistic_*` id prefix. This ensures the message appears in chat without waiting for the server echo.

When the agent is **streaming** and the message is sent as a **direct steer** (no attachments), `RemoteAgent.steer()` also adds an optimistic message so the user sees it in chat immediately — matching the idle-prompt pattern.

When the agent is **streaming** and the message is sent as a **queued prompt** (has attachments, or sent via the queue), no optimistic message is added. The server will echo it in the correct interleaved position when the queue drains and the agent processes it.

### Deduplication

When the server echoes a user message via `message_end`, `RemoteAgent` checks if an optimistic message with matching text already exists. If so, it replaces the optimistic message in-place (preserving position) rather than appending a duplicate.

### Live event tracking

`_liveEventMessages` tracks user messages received via live `message_end` events. This protects against a race where `get_messages` (reconnect, compaction) returns a stale snapshot that doesn't include a recently-sent user message. After the `messages` response replaces `state.messages`, any tracked messages missing from the response are re-appended.

### Queue display

The client receives `queue_update` events and stores them in `_serverQueue`. The UI renders each queued message as a "pill" above the textarea:

- **Non-steered pills** show four controls: drag handle (for reordering), edit button (pencil — removes pill and populates textarea for editing), steer button, and remove button (X).
- **Steered pills** show a "Sent" badge and no interactive controls — the message is committed for delivery on abort.
- **Edit flow**: Clicking the pencil icon fires `onEditQueued`, which removes the pill from the queue and places its text back in the textarea. On re-send, the message is added to the end of the queue (or dispatched directly if the agent is idle).
- **Drag reorder**: Dragging a pill's handle fires `onReorder`, which sends a `reorder_queue` WS message. The server reorders and broadcasts the updated queue to all clients.

## Error handling

### Turn errors suppress queue draining

If a turn ends with `stopReason: "error"` (tracked via `lastTurnErrored`), `drainQueue()` is skipped on `agent_end`. Queued messages wait for the user to retry rather than being fed into a broken agent.

**Error-state queue gating**: While `lastTurnErrored` is true, `enqueuePrompt()` always adds to the queue — it never dispatches directly, even if the queue is empty and the agent appears idle. This prevents new messages from bypassing a failed state. The queue only resumes draining after a successful retry clears the error flag.

### Retry

`retryLastPrompt()` handles two cases:
- **Fresh error** (no tool calls executed): Re-sends `lastPromptText` via `rpcClient.prompt()`.
- **Mid-work error** (tool calls already ran): Sends a system continuation message so the agent picks up where it left off rather than re-executing tools.

On successful retry (turn completes without error), `lastTurnErrored` is cleared and `drainQueue()` resumes normal operation.

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
| Client → Server | `reorder_queue` | Reorder queue to match given ID array |
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
