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

## Three dispatch paths

### 1. Direct dispatch (idle + empty queue)

The fast path. Agent is idle and nothing is queued — the prompt goes straight to the agent subprocess via `rpcClient.prompt()`. Title generation also fires here for the first message.

### 2. Enqueue (busy or queue non-empty)

Agent is streaming or the queue already has items. The message is added to `PromptQueue`, and a `queue_update` is broadcast to all connected clients so the UI can show the pending messages. If the agent happens to be idle (queue was non-empty), `drainQueue()` is called immediately.

### 3. Drain (agent becomes idle)

On `agent_end`, if the queue has items and the turn didn't end with an error, `drainQueue()` dispatches the next work. If steered messages are at the front of the queue, they are all popped as a batch via `dequeueAllSteered()` and concatenated (`\n`-joined) into a single prompt — this ensures multiple steered messages arrive as one coherent block rather than triggering separate agent turns. Otherwise, the next undispatched message is popped and sent via `rpcClient.prompt()`. Status is set to `"streaming"` optimistically to prevent a race where another `enqueuePrompt()` call sees idle+empty and dispatches a second concurrent prompt.

## Message types

### `prompt` (client → server)

Standard user message. Always routed through `enqueuePrompt()` — never sent directly to the agent.

### `steer` (client → server)

A mid-turn redirect. Behavior depends on agent state:

- **Agent streaming**: Dispatched **immediately** via `rpcClient.steer()` — injected between tool calls in real-time. The message is NOT queued. The UI textarea always queues via `prompt` — it never sends `steer` directly.
- **Agent idle**: Enqueued as a steered message. Steered messages sort before normal messages in the queue.

### `follow_up` (client → server)

Similar to `prompt` but dispatched via `rpcClient.followUp()` instead of `rpcClient.prompt()`. Used when continuing a conversation after the agent finished (different RPC semantics in the agent subprocess). Routed through `enqueuePrompt()` like normal prompts. The `isFollowUp` flag is preserved on the `QueuedMessage` so that queued follow-ups dispatch via the correct RPC method on drain.

### `steer_queued` (client → server)

Promotes an already-queued message to steered priority. The steered message is reordered to the front and shows a "Sent" badge in the UI. Steered messages are **not** dispatched immediately — they stay in the queue and are delivered as a batch when the agent next becomes available (via `drainQueue()` after `agent_end` or after abort+restart). This deferred approach ensures steered messages survive force-kills: if the agent process is killed during abort, no steers are lost because they haven't been dispatched yet. On drain, all consecutive steered messages at the front of the queue are popped via `dequeueAllSteered()` and concatenated into a single prompt.

### `remove_queued` (client → server)

Removes a message from the queue. Broadcasts an updated queue.

### `reorder_queue` (client → server)

Reorders the queue to match a given array of message IDs. Unknown IDs are ignored; messages not listed are appended at the end. Broadcasts updated queue. Used by the drag-to-reorder UI on queue pills.

### `queue_update` (server → client)

Sent whenever the queue changes — enqueue, dequeue, steer, remove, reorder. Contains the full queue array so clients can replace their local state.

## PromptQueue internals

`src/server/agent/prompt-queue.ts` — a per-session ordered queue with priority sorting.

**Ordering**: Steered messages always sort before non-steered. Within each group, insertion order is preserved (stable sort). The client can explicitly reorder via `reorder(messageIds)` — the queue adopts the given ID order, with unlisted items appended at the end.

**Dispatched tracking**: Messages are marked `dispatched: true` when sent to the agent, but stay in the queue for UI display until cleaned up on `message_end`. On drain, `dequeueUndispatched()` skips already-dispatched messages, and `dequeueAllSteered()` pops all consecutive steered messages from the front for batch dispatch. After a force-kill restart, `resetDispatched()` clears the dispatched flag on all items so that messages which were marked dispatched but never actually processed (because the agent was killed) can be retried.

**follow_up preservation**: `QueuedMessage` carries an optional `isFollowUp` flag. When set, `drainQueue()` dispatches via `rpcClient.followUp()` instead of `rpcClient.prompt()`, preserving the correct RPC semantics through the queue.

**Persistence**: The queue is persisted to `.bobbit/state/sessions.json` (via `SessionStore.update`) on every mutation, and restored on server restart via `new PromptQueue(ps.messageQueue)`.

## Client-side rendering

`src/app/remote-agent.ts` handles the UI side:

### Optimistic user messages

When the user sends a prompt and the agent is **idle** (`!isStreaming`), `RemoteAgent.prompt()` adds the message to `state.messages` immediately with an `optimistic_*` id prefix. This ensures the message appears in chat without waiting for the server echo.

When the agent is **streaming**, the message is queued — no optimistic message is added. The server will echo it in the correct interleaved position when the queue drains and the agent processes it. The message appears as a queue pill above the textarea so the user knows it's pending.

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

### Draft persistence

The message editor saves drafts to the server so unsent text survives page reloads and session switches. Drafts are saved via debounced `_flushDraft()` calls on input events, and loaded via `loadDraftFromServer()` when switching to a session.

**Race protection on session switch**: `_flushDraft()` returns a promise and stores it in `_pendingSave`. When switching sessions, `_setupPromptDraftHandlers()` awaits `_pendingSave` before loading the new session's draft. This prevents a stale save from the old session from clobbering the newly loaded draft. The teardown path (`_teardownDraftHandlers`) does not abort in-flight saves — it lets them complete so no data is lost.

**Restore resilience against Lit re-renders**: After loading a draft from the server, the value is set on the editor element. However, Lit component re-renders (triggered by connection status changes, message loading, etc.) can reset the editor's value. To handle this, draft restore uses a `requestAnimationFrame` retry loop that re-applies the draft value for up to 5 frames, ensuring the draft survives any re-renders that occur during the initial render cycle.

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

## Abort and force-kill recovery

When the user clicks Stop (or presses Escape), the server attempts a graceful abort via `rpcClient.abort()`. If the agent doesn't become idle within 3 seconds (e.g. it's blocked in a synchronous tool like `bash sleep 60`), the process is force-killed and a fresh agent is spawned.

**Aborting status**: On abort, the server immediately broadcasts `session_status: "aborting"` so the UI can show feedback (an "Aborting..." spinner in `AgentInterface`). This covers the up-to-3-second window where the graceful abort is pending and the user would otherwise see no response. The status transitions: `streaming` → `aborting` → `idle` (graceful) or `streaming` → `aborting` → force-kill → respawn → `idle`.

**Force-kill recovery flow**: After a force-kill, steered messages that were in the queue may have been marked `dispatched` (from a previous drain attempt or the old `forceAbort` code path). Since the agent process was killed, those messages were never actually processed. The recovery sequence is:

1. Process is killed, synthetic `agent_end` emitted
2. Fresh agent subprocess spawned
3. `resetDispatched()` clears the `dispatched` flag on all queue items
4. `drainQueue()` runs — picks up steered messages (now undispatched) and dispatches them as a batch

This ensures no queued or steered messages are lost across a force-kill restart.

**Why steered messages aren't dispatched eagerly**: Earlier versions dispatched steered messages immediately on promotion (via `_dispatchSteeredMessages()`). This was fragile — if the agent was force-killed moments later, the steered messages were already marked dispatched and wouldn't be retried. The current design defers all steered dispatch to `drainQueue()`, which only runs when the agent is ready to receive input.

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
| Server → Client | `session_status` | `"streaming"`, `"aborting"`, or `"idle"` status changes |

## Key files

| File | Role |
|------|------|
| `src/server/agent/prompt-queue.ts` | Queue data structure with priority sorting, `resetDispatched()`, `dequeueAllSteered()` |
| `src/server/agent/session-manager.ts` | `enqueuePrompt()`, `drainQueue()`, `steerQueued()`, `forceAbort()`, lifecycle |
| `src/server/ws/handler.ts` | WS command routing (`prompt`, `steer`, `follow_up`, etc.) |
| `src/server/ws/protocol.ts` | `QueuedMessage` type, client/server message unions |
| `src/app/remote-agent.ts` | Client-side optimistic rendering, dedup, queue state |
