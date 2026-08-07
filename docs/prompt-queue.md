# Prompt Queue & Message Dispatch

How user messages flow from the browser to the agent subprocess, how they queue when the agent is busy, and how the UI keeps in sync.

## Architecture overview

```
Browser (RemoteAgent)       Server (SessionManager)             Pi subprocess
─────────────────────       ───────────────────────             ─────────────
 prompt() ──WS──► enqueue one durable FIFO row
                  ├─ publish sessions.json acceptance ledger
                  ├─ idle: send framed stable prompt id ──────► reserve id
                  │                                             run one turn
                  │       post-persistence ACK ◄─────────────── commit user row
                  │       settle FIFO ownership
                  └─ busy: expose pending row in queue_update

                  agent_end ◄────────────────────────────────── finish turn
                  └─ positive-delay drain of the same FIFO head

 steer() ──WS──► enqueue durable steered row ──► framed live steer / queued drain
```

The durable queue is both the ordering source and the pre-dispatch acceptance ledger. No Pi RPC runs until the affected session-store snapshot has crossed its atomic publication barrier.

## Three dispatch paths

### 1. Direct dispatch (idle + empty queue)

The fast path still creates one `PromptQueue` row first. Bobbit marks it `dispatching`, persists it through the `SessionStore` publication barrier, and only then sends the prompt to Pi. Production bridges frame the row's stable ID and body digest; the row remains privately owned until Pi durably acknowledges the corresponding transcript entry. Title generation also fires here for the first message.

### 2. Enqueue (busy or queue non-empty)

Agent is streaming or the queue already has items. The message is added to `PromptQueue`, and a `queue_update` is broadcast to all connected clients so the UI can show the pending messages. If the agent happens to be idle (queue was non-empty), `drainQueue()` is called immediately.

### 3. Drain (agent becomes idle)

On `agent_end`, if the queue has work and the turn did not end with a genuine error, Bobbit schedules `drainQueue()` on a positive-delay macrotask. Pi can emit `agent_end` before its internal `finishRun()` clears the busy guard, so draining synchronously can produce a false `Agent is already processing` rejection.

`drainQueue()` peeks at the authoritative FIFO head rather than removing it. Consecutive steered rows are joined with `\n` and share one stable batch ID; otherwise the next row keeps its own ID. The selected rows are marked `dispatching`, durably published, and sent. Status becomes `"streaming"` optimistically so another sender cannot start a concurrent turn.

## Dormant restore windows

Client attachment owns dormant revival through SessionManager's coalesced restore coordinator. Read-only state does not call the stopped placeholder bridge:

- `get_state` uses live RPC only for the current readable lifecycle generation. Dormant, terminated, fenced, stale-generation, failed, or raced live reads return persisted model state. Explicit reads during preparing/starting instead return `{ preparing: true }`; initial attachment may separately seed the persisted model fallback.
- message snapshots use the durable transcript whenever the generation is not safely live, including preparing/starting.
- if lifecycle replacement wins while a live read is awaiting RPC, the result is discarded and the persisted fallback is sent.

Prompts arriving during restore join the replacement coordinator's ordered acceptance ledger rather than the stale `SessionInfo`. Each row is durably published, carried into the final canonical generation, and drained once that bridge is eligible. This is why a normal restore window must not surface `Agent process not running` or lose a prompt accepted by the WebSocket handler.

## Message types

### `prompt` (client → server)

Standard user message. Always routed through `enqueuePrompt()` — never sent directly to the agent.

### `steer` (client → server)

A mid-turn redirect. Behavior depends on agent state:

- **Agent streaming**: Enqueued as a steered row, then dispatched **immediately** through `_dispatchSteer()` for injection between tool calls. Stable delivery marks and publishes the row before `steerWithId()` and keeps it through ACK; a legacy bridge transfers it to `inFlightSteerTexts` before `rpcClient.steer()`. The UI textarea always queues via `prompt` — it never sends `steer` directly.
- **Agent idle**: Enqueued as a steered message. Steered messages sort before normal messages in the queue.

### `steer_queued` (client → server)

Promotes an already-queued message to steered priority. If the agent is **streaming**, `_dispatchSteer()` peeks at the consecutive front steered group, joins it with `\n`, aborts any parked `bash_bg wait`, and sends it through the same stable live-steer path as a fresh steer. Stable rows remain durably owned until ACK; the legacy fallback transfers them to the shadow ledger. If the agent is **idle**, promotion broadcasts and `drainQueue()` drains normally with steered rows first.

### `remove_queued` (client → server)

Removes only an ordinary client-owned row. Unknown IDs and protocol-owned rows are no-ops; the authoritative queue projection is still rebroadcast so stale tabs converge.

### `reorder_queue` (client → server)

Reorders only client-owned rows. Unknown or duplicate IDs, or an attempt to move an explicitly listed protocol-owned row, fail closed. Hidden owned rows stay pinned at their absolute FIFO positions, and the authoritative projection is rebroadcast. Used by the drag-to-reorder UI on queue pills.

### `queue_update` (server → client)

Sent whenever visible queue state changes. It contains the replace-all client projection; `dispatching` and `awaiting-ack` rows plus all delivery bookkeeping remain private.

## PromptQueue internals

`src/server/agent/prompt-queue.ts` — a per-session ordered queue with priority sorting.

**Ordering**: Steered messages always sort before non-steered. Within each group, insertion order is preserved (stable sort). The client can explicitly reorder via `reorder(messageIds)` — the queue adopts the given ID order, with unlisted items appended at the end.

**Lifetime is pending → delivery-owned → settled.** A row starts as ordinary queued intent. Dispatch marks the same row `dispatching`, then `awaiting-ack` after Pi accepts the RPC; a rejected attempt marks it `retrying` without changing its ID or FIFO position. Dispatching and awaiting-ACK rows are hidden. Retrying rows are visible without delivery metadata, but generic controls cannot remove or reorder them. Rows leave the durable queue only after validated downstream settlement.

The queue does not use the old boolean `dispatched` flag. `deliveryState`, `deliveryAttempt`, and `deliveryPromptId` describe protocol ownership, not a second pending-work cache. On restore, a persisted `dispatching` or `awaiting-ack` row normalizes to `retrying` so the new bridge generation may redrive the same stable ID.

Legacy bridges retain the shadow-ledger flow described under [The shadow ledger](#the-shadow-ledger): a dispatched steer moves from the queue to `inFlightSteerTexts` until its correlated echo settles or reconciliation returns it to the queue. This fallback must not be confused with the production stable-ID path, where the original rows stay durable through ACK.

**Persistence and acceptance**: Queue state lives in the owning project's `.bobbit/state/sessions.json`. Every direct, queued, restore-window, and live-steer send first publishes its exact row through `SessionStore.flushAsync()`. A queued return is reported as accepted only after that atomic barrier succeeds. `acceptedPromptDispatches` is a compact legacy-bridge tombstone for RPC acceptance before author-sidecar echo; production stable delivery keeps the FIFO row until Pi's ACK.

## Client-side rendering

`src/app/remote-agent.ts` handles the UI side:

### Optimistic user messages

When the user sends a prompt and the agent is **idle** (`!isStreaming`), `RemoteAgent.prompt()` adds the message to `state.messages` immediately with an `optimistic_*` id prefix. This ensures the message appears in chat without waiting for the server echo.

When the agent is **streaming**, the message is queued — no optimistic message is added. The server will echo it in the correct interleaved position when the queue drains and the agent processes it. The message appears as a queue pill above the textarea so the user knows it's pending.

### Deduplication

When the server echoes a user message via `message_end`, `RemoteAgent` checks if an optimistic message with matching text already exists. If so, it replaces the optimistic message in-place (preserving position) rather than appending a duplicate.

### Live event tracking

Live user messages are tracked through the unified message reducer (`src/app/message-reducer.ts`). The legacy `_liveEventMessages` bucket has been removed: `live-event` actions stamp the server `seq` as `_order`, and the `snapshot` action is authoritative for any id it contains. Surviving optimistic and live-only rows that the snapshot doesn't supersede are merged in by id and kept in their original order via `(_order, _insertionTick)` sorting. See [internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant).

### Queue display

The client receives `queue_update` events and stores them in `_serverQueue`. The UI renders each queued message as a "pill" above the textarea:

- **Non-steered pills** show four controls: drag handle (for reordering), edit button (pencil — removes pill and populates textarea for editing), steer button, and remove button (X).
- **Steered pills** show a "Sent" badge and no interactive controls. Stable rows disappear from the client projection while `dispatching` or `awaiting-ack`; a rejected `retrying` row becomes visible again with private bookkeeping stripped but remains delivery-owned server-side. The legacy shadow-ledger path transfers a dispatched steer out of the queue.
- **Edit flow**: Clicking the pencil icon fires `onEditQueued`, which removes the pill from the queue and places its text back in the textarea. On re-send, the message is added to the end of the queue (or dispatched directly if the agent is idle).
- **Drag reorder**: Dragging a pill's handle fires `onReorder`, which sends a `reorder_queue` WS message. The server reorders and broadcasts the updated queue to all clients.

### Draft persistence

The message editor saves drafts so unsent composer state (both text and attached files) survives page reloads, session switches, and WebSocket reconnects.

- **Prompt Text**: Saved to the server session via debounced `_flushDraft()` calls on input events, and loaded via `loadDraftFromServer()` when switching sessions. A synchronous mirror in `sessionStorage` avoids cursor and text clobbering during Lit component re-renders.
- **Attachments (Images/Files)**: Stored client-side in IndexedDB via `PromptDraftAttachmentsStore` to avoid bloating the server-side `sessions.json` with large base64 blobs. State is lifted into `AgentInterface` and bound into `<message-editor>`, surviving slow-path cache-evicted session switching and page reloads.
- **Text Generation-Counter Staleness Guard**: The **prompt text** draft employs a persistent monotonic generation (`gen`) counter, stored on the server draft, to reject out-of-order writes (e.g., late debounced autosaves landing after a message send). The client synchronously seeds `_draftGen` from `sessionStorage` or the server draft on load to prevent post-round-trip edits from being rejected as stale.
- **Attachment In-Flight Guard**: Attachment drafts carry **no persistent gen** — IndexedDB records have no generation field. A stale async load resurrecting cleared/sent attachments is prevented by an in-memory in-flight async-load generation token (`_attachmentDraftGen`) in `AgentInterface`, bumped on every load/set/clear so an in-flight read that is no longer current is discarded on resolve.

For a comprehensive explanation of the persistence model, safety caps/evictions, state lifting, and synchronization guards, see [docs/design/composer-draft-persistence.md](design/composer-draft-persistence.md).

**Race protection on session switch**: `_flushDraft()` returns a promise and stores it in `_pendingSave`. When switching sessions, `_setupPromptDraftHandlers()` awaits `_pendingSave` before loading the new session's draft. This prevents a stale save from the old session from clobbering the newly loaded draft. The teardown path (`_teardownDraftHandlers`) does not abort in-flight saves — it lets them complete so no data is lost.

**Restore resilience against Lit re-renders**: After loading a draft from the server, the value is set on the editor element. However, Lit component re-renders (triggered by connection status changes, message loading, etc.) can reset the editor's value. To handle this, draft restore uses a `requestAnimationFrame` retry loop that re-applies the draft value for up to 5 frames, ensuring the draft survives any re-renders that occur during the initial render cycle.

## Error handling

### Turn errors suppress queue draining

If a genuine error ends a turn (tracked via `lastTurnErrored`), `drainQueue()` is skipped on `agent_end`. Queued messages wait for recovery rather than being fed into a broken agent. An error-shaped terminal is provisional until the final boundary: the narrow cancellation reconciliation below clears its error state and drains instead.

**Error-state queue gating (implicit unstick)**: When a genuine error survives the final boundary, `session.lastTurnErrored = true` and `session.consecutiveErrorTurns` is incremented. An incoming prompt or steer then takes one of two paths:

- **Below the cap** (`consecutiveErrorTurns < MAX_CONSECUTIVE_ERROR_TURNS`, currently `3`): `enqueuePrompt()` / `deliverLiveSteer()` implicitly unstick the session. They clear `lastTurnErrored` / `lastTurnErrorMessage` / `turnHadToolCalls`, cancel any `pendingAutoRetryTimer`, reset `transientRetryAttempts`, prepend a short `[SYSTEM: previous turn failed with: …. Your previous turn was interrupted. Pick up where you left off — re-check state first and avoid redoing completed work.]` prefix to the new text, and dispatch it. The previous failed turn is **not** retried — the incoming message is treated as fresh intent. Any messages parked in the queue while the session was wedged then drain normally (without the prefix, since the error is already cleared).
- **At or above the cap** (`consecutiveErrorTurns ≥ 3`): the incoming message is parked in `promptQueue` (the pre-change behaviour) and a warning is logged. This is the brake for persistently broken upstreams (quota exhausted, auth revoked, content filter) so we don't re-trigger the failing model on every nudge. Parked messages drain once a human clicks Retry and the underlying issue is fixed.

The counter resets to `0` on cancellation reconciliation, any successful `message_end` (non-error, non-aborted), and a successful explicit `retryLastPrompt`. Steers must still route through `deliverLiveSteer()` so they persist to `promptQueue` first (`persisted: true`), preserving the Stop/retry invariant (PI-25b/PI-25c).

**Explicit UI Retry bypasses the cap.** `retryLastPrompt()` always runs regardless of `consecutiveErrorTurns` — the cap only gates the implicit path.

**TeamManager no longer second-guesses.** The previous suppression that dropped team-lead nudges when `teamLeadSession.lastTurnErrored` was true has been removed. SessionManager is the single source of truth: the nudge either unsticks the lead (≤ cap) or parks (≥ cap). If the lead is persistently broken, parked nudges drain automatically once a human fixes the upstream issue — strictly better than the old "drop on the floor" behaviour.

See also [docs/debugging.md — Session wedged after errored turn](debugging.md#session-wedged-after-errored-turn) and the AGENTS.md debug-keyword entry of the same name.

### Retry

`retryLastPrompt()` handles two cases:
- **Fresh error** (no tool calls executed): Re-sends `lastPromptText` via `rpcClient.prompt()`.
- **Mid-work error** (tool calls already ran): Sends a system continuation message so the agent picks up where it left off rather than re-executing tools.

On successful retry (turn completes without error), `lastTurnErrored` is cleared and `drainQueue()` resumes normal operation.

### Parked work is never silently idle

For a non-cancellation error, Bobbit must not drain queued prompts or steers into a possibly broken provider. `maybeAutoRetryTransient()` first applies the established provider-overload, transport, and generic-runtime retry policies. A scheduled retry leaves the rows queued and emits the visible retry countdown; deterministic provider/auth/validation failures remain parked.

If no retry timer is armed and durable queued work remains, Bobbit retains the errored state and emits `manual_retry_required`: **"Queued work is parked because this turn failed. Manual Retry is required."** This idempotent backstop makes unclassified failures actionable instead of presenting healthy-looking idle. The condition is replayed to a newly authenticated live attachment together with the queue, so a reload or reconnect does not hide the required manual recovery. Starting a new turn or invoking Retry clears the notice.

See [Auto-Retry](auto-retry.md) for classifier and scheduling policy.

### Dispatch failure

The durable row remains the recovery source. A rejection marks that exact row `retrying` at the front; older legacy seams that transferred ownership recreate the rows in original order. An inbound turn event advancing `agentObservedTurnVersion` wins over a late negative RPC result because it proves Pi already observed the turn.

`Agent is already processing` is an expected finish-run race, not a terminal command failure. Bobbit returns queued/retrying state, restores idle, and redrains after bounded positive delays. After the short retry budget, the row waits for the next real idle/readiness boundary. There is no tick-zero retry loop and no user-facing `COMMAND_ERROR` for a prompt already preserved for retry.

Protocol capability/envelope failures also retain the durable row rather than falling back to an unframed send. Provider-auth failures persist the row, clear the optimistic streaming state, and emit `provider_auth_required` for explicit recovery. Other exhausted retryable failures emit `manual_retry_required` instead of presenting healthy idle.

The exception is a child-exit path where the session is already `terminated` or aborting after process exit. Bobbit does not write recovery state into a dead bridge; replacement, sandbox recovery, force-abort recovery, or explicit Retry owns the next process.

## Abort and force-kill recovery

When the user clicks Stop (or presses Escape), the server attempts a graceful abort via `rpcClient.abort()`. If the agent doesn't become idle within 3 seconds (e.g. it's blocked in a synchronous tool like `bash sleep 60`), the process is force-killed and a fresh agent is spawned.

**Aborting status**: On abort, the server immediately broadcasts `session_status: "aborting"` so the UI can show feedback (an "Aborting..." spinner in `AgentInterface`). This covers the up-to-3-second window where the graceful abort is pending and the user would otherwise see no response. The status transitions: `streaming` → `aborting` → `idle` (graceful) or `streaming` → `aborting` → force-kill → respawn → `idle`.

### Cancellation-shaped terminal recovery

A runtime cancellation can arrive while the session is still `streaming`, rather than through the user-Stop `"aborting"` state. At the final `agent_end` boundary, Bobbit treats either source as cancellation when the latest assistant terminal is one of these narrow Pi/runtime forms:

- `stopReason: "aborted"`; or
- `stopReason: "error"` with a normalized whole-message cancellation form such as `aborted`, `request aborted`, `operation aborted`, or `AbortError` / standard operation-aborted wording.

This is intentionally not a substring match. Provider, authentication, validation, HTTP/server, timeout, connection, rate-limit, and content-policy diagnostics that merely mention "aborted" remain genuine errors and keep their existing park/retry policy.

Cancellation reconciliation preserves durable intent before returning to idle:

1. Requeue only steer ledger entries that have not reached a proven user-role echo. Echoed steers are already settled and must not be replayed.
2. Broadcast the reconciled queue, clear cancellation-only error state and counters, then use the normal `drainQueue()` boundary. A replacement coordinator may defer that drain until it releases; reconciliation never dispatches work directly.
3. Preserve queue priority and FIFO ordering: recovered steers return to the front in dispatch order, then the normal drain batches consecutive steers.

The same boundary serves user Stop and external cancellation so force-abort behavior remains unchanged. It also retains dangling tool-call and dispatch-rejection recovery in their existing owners.

### Stable prompt-delivery protocol

Production `RpcBridge` generations fail startup closed unless the built-in delivery extension completes its exact v1 handshake. The capability decision is immutable for that child generation; Bobbit never frames with one mode and settles with another.

For each ordinary prompt, queued drain, and stable live steer:

1. Bobbit publishes the exact FIFO row, stable prompt ID, author-sidecar body recipe, and `dispatching` ownership before sending.
2. `RpcBridge` adds a private envelope containing protocol version, prompt ID, and SHA-256 body digest. Pi's input extension validates and strips the envelope before model or transcript exposure.
3. The extension appends a durable reservation before transforming the input. The same ID/digest cannot create a second turn while pending, and the same ID with a different digest fails closed.
4. After Pi commits the corresponding user transcript entry, the extension appends a durable ACK. Bobbit validates the ACK digest against the exact retained body recipe before removing FIFO ownership.
5. If the gateway crashes after transcript append but before ACK handling, redrive uses the same ID. The extension finds the committed reservation/user pair, appends ACK, and handles the resend without starting another turn.

A local failure while publishing settlement is not a delivery failure: Bobbit retries only the queue/tombstone snapshot and never resends an already accepted prompt. Settlement retries use bounded positive delays; restart transcript/ACK reconciliation is the final recovery boundary.

### Terminal ownership and exactly-once delivery

Exactly-once here means one durable Pi user-turn entry per accepted stable prompt ID. It does not promise that arbitrary tool side effects inside a restarted turn are idempotent.

Only the latest distinct assistant terminal seen before the final boundary classifies the turn. After a final `agent_end` is handled, its terminal identities and cancellation classification are consumed; a late `message_end` or duplicate `agent_end` cannot reclassify a later turn, repeat reconciliation, enqueue a second steer, or drain another queue row. A new `agent_start`, Retry, or accepted redrive establishes the next turn's terminal scope.

**Legacy force-kill recovery flow** (exactly-once at the transcript level):

1. User clicks Stop. `SessionManager.forceAbort()` enters abort handling. The shadow ledger (`session.inFlightSteerTexts`) holds every dispatched steer that has not reached a proven user-role `message_end` echo.
2. If the graceful abort does not settle, the agent process is stopped and `_reconcileAfterAbort()` re-enqueues only the unresolved ledger entries at the front of `promptQueue` with `isSteered: true` (via `enqueueAtFront()`), then clears the ledger. Reverse traversal preserves their original dispatch order and keeps recovered steers ahead of ordinary queued work.
3. A synthetic `agent_end` is emitted and a fresh subprocess is spawned.
4. `drainQueue()` runs. The re-enqueued steered front group is joined into a single prompt and dispatched once.

The same reconciliation runs on the graceful path: when `handleAgentLifecycle` sees `agent_end` while `wasAborting`, it calls `_reconcileAfterAbort()` before transitioning to `idle`. Either way the result is the same — every steer the user typed appears as exactly one `<user-message>` in the rendered chat, even if the abort race tore down the agent between dispatch and echo.

### The shadow ledger

`SessionInfo.inFlightSteerTexts` is the compatibility ledger for a bridge generation without stable downstream delivery. Production v1 bridges retain queue rows through ACK instead. A legacy record's lifecycle is bounded between **dispatch start** (recorded by `_dispatchSteer()` before the row-removal store update) and a proven user-role echo. The record carries a stable author-correlation ID as well as the original text so settlement can distinguish repeated identical steers.

- **Record + persist**: `_dispatchSteer()` appends the batch record before removing queue rows, then persists `messageQueue` and `inFlightSteerTexts` in the same store update. A gateway restart after row removal but before transcript echo can therefore recover the text exactly once.
- **Settle**: `_consumeSteerEcho()` accepts only a user or user-with-attachments `message_end`. When a prompt-author binding is available, it matches by prompt ID; only legacy/unbound echoes fall back to the first matching text. A replayed terminal frame that is already settled is ignored, so it cannot consume a later same-text steer.
- **Drain**: `_reconcileAfterAbort()` and `restoreSession()` run after durable echoes have been replayed. They re-enqueue only records that remain unresolved, in dispatch order, with `isSteered: true`, then clear the ledger.

The ledger exists because the SDK's in-process steering mirror is not a durable restart/abort recovery surface. The proven user-role echo is Bobbit's durable settlement boundary: it shows the steer reached Pi, so it must never be replayed after Stop or a restart. Entries without that proof are recovered exactly once from the ledger. Bounded growth is enforced by construction: every push has a paired settlement or recovery drain; neither path is silently dropped.

Late RPC rejection is also guarded: `_dispatchSteer()` only rolls a failed steer back into the queue if its ledger entry is still present. If abort/restart reconciliation already drained that entry, the catch path persists the cleared ledger and does **not** enqueue a duplicate.

**Why `steer_queued` dispatches through `_dispatchSteer()`**: while streaming, `steerQueued()` only does the queue promotion/dequeue work and then immediately calls the same `_dispatchSteer()` path used by fresh live steers. That keeps wait abort, row removal, batching, shadow-ledger handoff, and RPC-failure recovery in one place. When idle, promotion falls back to normal `drainQueue()` semantics with steered rows first.

## WS protocol summary

| Direction | Type | Purpose |
|-----------|------|---------|
| Client → Server | `prompt` | Send a user message (queued if busy) |
| Client → Server | `steer` | Mid-turn interrupt or queued-as-steered |
| Client → Server | `steer_queued` | Promote queued message to steered priority |
| Client → Server | `remove_queued` | Remove a message from the queue |
| Client → Server | `reorder_queue` | Reorder queue to match given ID array |
| Client → Server | `abort` | Cancel current turn (force-kills if needed) |
| Client → Server | `retry` | Retry after model/API error |
| Server → Client | `queue_update` | Full queue state after any mutation |
| Server → Client | `session_status` | `"streaming"`, `"aborting"`, or `"idle"` status changes |
| Server → Client | `manual_retry_required` | Durable queued work is parked after a non-retryable or unclassified turn failure; use manual Retry after addressing the cause |
| Server → Client | `provider_auth_required` | Provider credential failure; client renders Settings, Retry, Switch provider, and Abort/respawn recovery actions |

## Key files

| File | Role |
|------|------|
| `src/server/agent/prompt-queue.ts` | Durable FIFO and delivery ownership (`dispatching`, `awaiting-ack`, `retrying`) with stable priority ordering. |
| `src/server/agent/session-manager.ts` | Queue publication, dispatch/recovery, downstream ACK settlement, restore fencing, legacy steer reconciliation, and lifecycle. |
| `src/server/agent/rpc-bridge.ts` | Versioned delivery handshake and framed prompt/steer transport. |
| `defaults/tools/_prompt-delivery/extension.ts` | Pi input reservation, duplicate suppression, envelope stripping, and durable ACK publication. |
| `src/server/ws/handler.ts` | WS command routing plus dormant-state fallback. |
| `src/server/ws/protocol.ts` | `QueuedMessage`, `ManualRetryRequiredEvent`, `ProviderAuthRequiredEvent`, and client/server message unions |
| `src/app/remote-agent.ts` | Client-side optimistic rendering, dedup, queue state |

## Related

- [Composer caret-row invariant](internals.md#composer-caret-row-invariant) — how the composer decides between caret movement and command-history browsing for ArrowUp/ArrowDown, and why the decision requires layout measurement.
- [session-prompt-tools.md](session-prompt-tools.md) — agent-facing `session_prompt` / `team_prompt` delivery modes that route into `enqueuePrompt()` and `deliverLiveSteer()`.
- [image-attachment-only-prompts.md](image-attachment-only-prompts.md) — `enqueuePrompt` synthesizes a non-blank text body for attachment-only prompts before they reach the queue, so queued/drained rows never carry a blank `ContentBlock`.
