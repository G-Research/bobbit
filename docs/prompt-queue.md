# Reliable prompt and steer delivery

Bobbit treats each identified browser/WebSocket prompt or steer as a durable occurrence. The delivery outbox bridges the browser, gateway, and Pi transcript so a message remains visible until its correlated user row reaches chat. A WebSocket write or Pi RPC acknowledgement is transport progress, not delivery.

This lifecycle extends the existing `PromptQueue`, in-flight ledger, prompt-author sidecar, snapshot splice, and queue-pill UI. It does not introduce a second mailbox or event log.

## Occurrence identity and admission

The browser assigns every composer submission a random `intentId`. This identifies one occurrence, not its text: two identical messages have different IDs and settle independently.

Before sending, the browser:

1. adds a `local` row to the visible outbox;
2. persists the exact frame and row in the IndexedDB `delivery-intents` store; and
3. sends the frame when the session WebSocket is authenticated.

`WebSocket.send()` records only that an attempt was made on the current connection. It never settles or hides the row.

The local spool fails visibly instead of evicting accepted work. Its bounds are 50 occurrences per session, 40 MiB per occurrence, and 128 MiB total. A storage or size failure produces a non-retryable **Not delivered** row.

The authenticated server accepts `intentId` values that are non-empty strings of at most 256 characters. Legacy clients may omit the field; the WebSocket boundary supplies an ID. Browser-originated frames cannot choose their author: the server assigns the local-user author and provenance.

Server admission is idempotent for `(sessionId, intentId)`:

- the exact queue occurrence is persisted before any Pi call;
- replay returns the existing queue or in-flight projection;
- replay of an already surfaced or dismissed occurrence returns its body-free terminal disposition; and
- the same text under another ID remains a separate occurrence.

Prompt preprocessing for skills and file mentions happens before server admission. If Stop cancels that preparation, the correlated local row becomes actionable with `INTENT_PREPARATION_CANCELLED`; an error without a valid `intentId` cannot settle an unrelated row.

## Lifecycle

| State | Owner and evidence | Visible behavior |
| --- | --- | --- |
| `local` | Browser IndexedDB; server has not acknowledged durable admission. | **Waiting for connection**. Reload and reconnect restore the row and resend the same ID. |
| `queued` | Persisted `PromptQueue`; eligible lane and sequence are known. | **Queued for next turn** or **Steer queued for current turn**. During compaction the label explains that delivery is fenced. |
| `dispatching` | Persisted in-flight ledger with `intentId`, a new `attemptId`, and `dispatchEpoch`; Pi RPC has been invoked. | **Sending…**. RPC acknowledgement does not remove it. |
| `received` | A correlated Pi user `message_start` has been observed. | The real user row is inserted and the outbox carrier transitions without a blank frame; a server projection may briefly read **Adding to chat…**. |
| `uncertain` | Dispatch may have crossed the Pi boundary, but no exact terminal proof is available. | **Awaiting delivery confirmation**. Automatic replay and Retry are disabled; Dismiss is available. |
| `failed` | Pi gave a definite negative acknowledgement, or local admission failed before server ownership. | **Not delivered** with Retry when the exact occurrence is retryable, plus Edit and Dismiss. |
| `cancelled` | A body-free dismissal or fail-closed cancellation disposition is durable. | **Cancelled** until the terminal update removes it or the retained fail-closed row is dismissed. |
| surfaced | The correlated user row is in the transcript; the exact prompt-author settlement is fsynced. | The transcript is the carrier. Late queue/outbox projections cannot resurrect the occurrence. |

The wire-level `DeliveryState` omits `local` because that state is browser-owned. `intent_update.settlement` uses `surfaced`, `failed`, or `cancelled` for occurrence dispositions.

## Durable handoff and settlement

Dispatch moves one reliable occurrence from `PromptQueue` to the persisted in-flight ledger in the same server-owned update before invoking Pi. The attempt records the stable `intentId`, one-call `attemptId`, monotonic `dispatchEpoch`, lane, sequence, author, and attachment metadata.

Reliable steers are serialized and dispatched one occurrence at a time. They are not newline-batched, so repeated identical text retains independent identity and acknowledgement. Internal/REST/tool callers that omit occurrence IDs still use the legacy metadata-free path, where batching and older recovery semantics remain for compatibility; tool result statuses such as `dispatched` describe routing, not transcript settlement.

Pi receipt has two boundaries:

1. A correlated user `message_start` changes the attempt to `received`. The browser first reduces the real user row into chat, then removes the matching outbox carrier by `intentId`.
2. A correlated user `message_end` settles the attempt only after the prompt-author sidecar contains the fsynced exact `echoed` record. The server can then remove the in-flight reservation.

The sidecar is the durable restart boundary; the browser's visible transfer happens at `message_start` to match Pi's pending-message behavior. Snapshot and live reducers replace/deduplicate user rows by `deliveryIntentId`, never by raw text. Text fallback exists only for legacy records without occurrence identity.

The gateway projects the persisted queue and ledger as one ordered delivery outbox. On attach it sends both `queue_update` and `delivery_outbox`; current clients accept either projection. Missing from a later projection is not settlement, because the correlated transcript event may follow immediately on the same socket.

## Lanes and ordering

Each accepted row has:

- `kind`: `prompt` or `steer`;
- `targetTurn`: `continuation` or `next-turn`; and
- `sequence`: FIFO position within that lane.

A steer targets `continuation` only while a turn is streaming, including threshold or overflow compaction that will continue that turn. A steer accepted while idle or during manual compaction targets `next-turn`. Prompts target `next-turn`.

Release rules are lane-aware:

- live continuation steers dispatch serially while the current turn can accept them;
- next-turn work waits for the final non-retry `agent_end` and drains by lane sequence;
- `agent_end(willRetry: true)` is not a turn boundary;
- final turn completion retargets undispatched continuation rows once with `continuation-ended`;
- Stop retargets queued continuation rows with `continuation-aborted`; and
- a proven-no-start in-flight occurrence may be restored once, retaining its ID and relative priority.

Drag reorder updates the queued order and resequences only the affected queued rows within their existing lane. It does not reorder an already-dispatched attempt.

Promoting a queued prompt to a steer changes its kind and assigns a continuation sequence when the active turn can accept it. During manual compaction it remains next-turn work.

## Compaction

Compaction is active turn work, not an idle gap. Admission remains open and visible, but all prompt, steer, retry, queue-drain, and tool-end dispatch paths check `session.isCompacting` before calling Pi.

Manual-compaction input is next-turn work. Threshold and overflow compaction preserve continuation affinity for steers; next-turn prompts remain parked. The sole release behavior and overflow retry contract are documented in [Context compaction](compaction.md#reliable-turn-fence-and-release).

Pi's canonical “compaction active” rejection proves that no turn began. Bobbit restores that exact occurrence to the queue front with `deliveryReason: "compaction-active"`; the compaction finisher remains the only redrain owner.

## Stop, failure, and recovery

### Stop and abort

Stop never silently deletes accepted work.

- Work still in `PromptQueue` remains visible. Continuation rows become next-turn work.
- A dispatched attempt whose Pi start cannot be proved either way becomes non-retryable `uncertain`; it is not automatically replayed.
- If canonical recovery proves the attempt did not start, Bobbit restores it once. If a late exact user start arrives, it settles the original attempt instead.
- If administrative abort recovery cannot preserve or prove an attempt, Bobbit retains a non-retryable `cancelled` row with `abort-recovery-failed`; it does not claim the model did not see it.
- Explicit Dismiss writes a cancellation tombstone before removing a queued or uncertain carrier. A stale second tab cannot delete a newer Retry because IndexedDB mutations use revision checks.

The `aborting` session status is broadcast immediately while graceful Stop or force replacement owns the lifecycle. Queue and compaction callbacks do not drain around that owner.

### Definite rejection versus ambiguity

A `{ success: false }` Pi response is a definite pre-receipt rejection. Bobbit restores the exact row at the queue front as retryable `failed`. **Retry** keeps the same `intentId` and creates a new attempt only when dispatch resumes.

A thrown call or transport loss is ambiguous: Pi may have received it even though Bobbit missed the acknowledgement. Bobbit keeps the ledger row as `uncertain`, disables Retry, and waits for exact transcript evidence or explicit Dismiss. This fail-closed rule prefers visible uncertainty over duplicate model input.

### Gateway restart and bridge replacement

Queue rows, modern in-flight attempts, and prompt-author settlements survive gateway restart. Restore folds terminal sidecar evidence before exposing state:

- an echoed or dismissed exact attempt cannot reappear;
- a nonterminal modern attempt restores as visible uncertainty, not permission to replay;
- old lifecycle generations are fenced so late callbacks cannot mutate the replacement; and
- legacy records without occurrence identity retain their compatibility recovery path.

Reload, reconnect, and a second tab combine the IndexedDB local spool with the server outbox. Server projections replace local ownership by ID, terminal IDs dominate stale projections, and revision-checked local Retry/Dismiss operations prevent an older tab from overwriting newer intent.

### Errored turns

A genuine model/provider error parks accepted work while Bobbit applies its bounded auto-retry and manual-retry policies. A new prompt can implicitly unstick ordinary errors below the consecutive-error cap; at the cap the visible queue remains parked until explicit Retry. See [Auto-Retry](auto-retry.md) and [Session wedged after errored turn](debugging.md#session-wedged-after-errored-turn).

## `bash_bg wait` interaction

Dispatching an identified reliable continuation steer interrupts any current `bash_bg wait` so Pi can observe the steer at a tool boundary. Only the wait HTTP request is aborted; the background process keeps running. A steer merely queued behind compaction, Stop, or a replacement does not interrupt the wait until the dispatch boundary is reached.

Legacy internal/REST/tool steers that omit occurrence identity currently use `_dispatchLegacySteer()` and do not share this wait-interruption call. This compatibility limitation is observable even if a tool result says the steer was dispatched.

Wait interruption is distinct from intent delivery: an interrupted wait proves neither Pi receipt nor transcript settlement. See [Background process persistence](bg-process-persistence.md#wait-interruption-versus-intent-delivery).

## UI actions

Actions depend on state:

- queued next-turn prompts can be reordered, edited, promoted to steer, or dismissed;
- failed retryable rows offer Retry, Edit, and Dismiss;
- uncertain rows offer Dismiss but not Retry;
- in-flight rows remain visible and are not editable; and
- cancellation and transcript surfacing converge all attached tabs through exact ID updates.

Draft persistence is separate. Composer text and attachments survive navigation, but once Send or Steer creates an occurrence, the delivery outbox—not the draft—is responsible for it.

## Scope boundaries

This delivery reuses the existing session store, prompt-author sidecar fsync points, and lifecycle-generation fencing. It does not introduce a new hard-kill fsync/generation protocol beyond those owners. Likewise, the IndexedDB spool limits protect browser-local admission, but this change does not add an aggregate authenticated server-side durable-steer budget. Do not infer either guarantee from the occurrence lifecycle above.

## Diagnostics

The reliable-turn lifecycle diagnostics below are body-free. Useful server lines include:

```text
[session-manager] intent dispatch restored session=<id> intent=<intentId> attempt=<attemptId> outcome=compaction-active
[session-manager] intent dispatch failed session=<id> intent=<intentId> attempt=<attemptId> outcome=<failed|uncertain>
[ws-handler] intent delivery did not settle session=<id> intent=<intentId> outcome=<state>
```

With `BOBBIT_DEBUG=1`, replacement and proven-no-start reconciliation add bounded lifecycle details. These reliable-turn lines include session, intent, attempt, generation/epoch, state, reason, and outcome. The broader debug mode also contains a pre-existing truncated prompt-receipt preview, so enable it only in a trusted environment and do not attach those general logs to a report. Reliable-turn diagnostics must not add message bodies, attachment data, provider request bodies, credentials, or raw transcripts.

See [Debugging reliable delivery](debugging.md#reliable-prompt-and-steer-delivery) for operator checks.

## Protocol summary

| Direction | Type | Purpose |
| --- | --- | --- |
| Client → server | `prompt`, `steer` | Submit one occurrence with optional `intentId`. |
| Client → server | `retry_intent` | Retry one definitely failed occurrence by stable ID. |
| Client → server | `steer_queued` | Promote an accepted queued prompt to steer intent. |
| Client → server | `remove_queued` | Durably dismiss one queued or uncertain occurrence. |
| Client → server | `reorder_queue` | Reorder queued IDs and persist lane order. |
| Client → server | `abort` | Stop the active turn without deleting accepted work. |
| Server → client | `intent_update` | Exact occurrence projection or terminal disposition. |
| Server → client | `queue_update`, `delivery_outbox` | Full server-authoritative visible outbox projection. |
| Server → client | correlated user event | Pi receipt/transcript row carrying `deliveryIntentId` and attempt metadata. |

## Verification map

- `tests2/core/reliable-intent-queue.test.ts` — identity, idempotent admission, lane order, identical occurrences, and retargeting.
- `tests2/core/reliable-intent-attempt.test.ts` — delayed acknowledgement/echo, failure ambiguity, Stop timing, and persisted recovery.
- `tests2/core/reliable-compaction-release.test.ts` — admission fencing and one release across compaction outcomes.
- `tests2/integration/reliable-intent-recovery.test.ts` and `steer-gateway-restart.test.ts` — barrier-driven reconnect, restart, failure, and exactly-once recovery.
- `tests2/browser/journeys/reliable-agent-turns.journey.spec.ts` — visible carrier continuity through composer, Stop, compaction, reload, reconnect, second tab, and failure.
- `tests/manual-integration/reliable-agent-context-pressure.spec.ts` — opt-in real-model pressure smoke; see [Pi runtime compatibility](pi-runtime-compatibility.md#real-model-context-pressure-smoke).

## Key modules

| Module | Responsibility |
| --- | --- |
| `src/ui/storage/app-storage.ts` | IndexedDB pre-admission occurrence spool and revision-checked mutation. |
| `src/app/remote-agent.ts` | ID creation, local/server outbox merge, monotonic projection, transcript transfer, Retry/Dismiss. |
| `src/app/message-reducer.ts` | `deliveryIntentId` transcript replacement and snapshot deduplication. |
| `src/server/agent/prompt-queue.ts` | Persisted accepted rows, lane sequencing, reorder, and retarget. |
| `src/server/agent/session-manager.ts` | Admission, dispatch ledger, compaction/Stop fences, settlement, and recovery. |
| `src/server/agent/author-sidecar.ts` | Exact author/intent/attempt correlation plus echoed/cancelled settlements. |
| `src/server/agent/splice-inflight-message.ts` | Snapshot continuity for unresolved attempts. |
| `src/server/ws/handler.ts` and `protocol.ts` | Validation, idempotent receipts, attach projections, and commands. |
