# Reliable prompt and steer delivery

Bobbit separates **delivery state** from the **conversation transcript**. A prompt or steer may be accepted, queued, sent, or uncertain before Pi has durably written its user row. Keeping that work in the delivery outbox prevents it from being mistaken for a completed chat message and keeps a newly accepted human prompt visible through acknowledgement, reconnect, and hard reload.

This contract covers browser input and server-originated work. It extends the existing `PromptQueue`, dispatch ledger, prompt-author sidecar, snapshot handling, and queue-pill UI; it is not a second mailbox or transcript.

## Ownership boundary

The transcript is ordered exclusively by real, settled Pi transcript rows. Synthetic recovery rows, RPC acknowledgements, WebSocket writes, and lifecycle events do not create or settle transcript bubbles.

The delivery outbox owns every occurrence until exact Pi evidence transfers ownership:

- The queue and in-flight ledger are server-owned durable delivery state.
- Queue pills show pending, dispatched, failed, cancelled, or uncertain work without claiming it is chat history.
- A real correlated Pi user row is the only route into the conversation. Its exact sidecar settlement makes the transfer durable.
- A snapshot may contain a user-shaped recovery projection to preserve delivery information. The client removes every explicitly marked projection from the transcript reducer and places it in the outbox instead. It never settles an occurrence.

This distinction is deliberate. A projection exists because Bobbit knows it handed work toward Pi, not because Pi recorded the work. Rendering it after the canonical transcript can make new user messages appear to disappear above System cards. Keeping it in the outbox preserves transcript order and makes reload reproduce the same truthful state.

## Stable occurrence identity

Each accepted occurrence has a server-owned stable `intentId`. It identifies one submission, rather than its body: identical prompts are independent occurrences and must never be correlated, deduplicated, or settled by text.

Browser submissions create and persist an ID before transport. The gateway supplies an ID when an older browser omits one. All newly created server-generated work also uses the reliable model, including:

- task-complete notifications and other task notifications;
- auto-nudges and inbox wake-ups;
- verification messages and verifier follow-ups;
- kickoff, continuation, recovery, and other system prompts, including batched system prompts; and
- server/API/tool-originated local-user prompts and live steers.

A direct server prompt reserves its occurrence before its Pi RPC. A queued or live steer reserves the same occurrence before leaving `PromptQueue`. Reliable steers are dispatched serially, rather than newline-batched, so equal-text steers retain separate identities. A source or author describes provenance; it is not an identity key.

An occurrence keeps its `intentId` while moving between browser storage, `PromptQueue`, the in-flight ledger, delivery projections, and the user row. Every dispatch creates a distinct `attemptId` and monotonic dispatch epoch. The prompt-author sidecar records the exact occurrence and attempt, model-text digest/prefix evidence, accountable author, and terminal disposition. These sidecar facts—not matching text, display text, or arrival order—are the evidence used to settle or retire an attempt.

## Lifecycle

| State | Meaning | Visible surface |
| --- | --- | --- |
| `local` | Browser storage accepted the occurrence but the gateway has not durably admitted it. | **Waiting for connection**. Reload resends the same ID. |
| `queued` | The gateway durably owns it in a lane. | Queue pill, including next-turn or continuation context. |
| `dispatching` | A durable in-flight attempt exists and Pi RPC has been called. | **Sending…**; an RPC acknowledgement is not settlement. |
| `received` | A correlated Pi user start was observed. | The real Pi row can be surfaced while the durable terminal sidecar is awaited. |
| `uncertain` | Pi may have received the exact attempt but Bobbit cannot prove its terminal result. | **Awaiting delivery confirmation**; no automatic replay or Retry. |
| `failed` | Pi definitively rejected before starting the attempt, with the required cancellation evidence. | **Not delivered**, with Retry only when that occurrence is eligible. |
| `cancelled` | A cancellation disposition is durable. | **Cancelled** / dismissal state, never a transcript message. |
| `surfaced` | The exact Pi user row and echoed sidecar settlement are durable. | The settled Pi transcript row becomes the carrier. |

The browser persists local work before sending. The server persists accepted queue work, or an in-flight reservation, before calling Pi. Admission and replay are idempotent by `(sessionId, intentId)`: a reconnect or another tab returns the same carrier, while equal text under another ID remains separate.

## Receipt, settlement, and snapshots

Pi receipt has two distinct boundaries:

1. A correlated user `message_start` is receipt evidence. It lets the client surface the real Pi user row and transition the delivery carrier without a blank frame.
2. A correlated user `message_end` settles only after the sidecar has durably recorded the matching `intentId` and `attemptId` as echoed. Only then may the dispatch reservation be pruned.

The sidecar matters across restarts and races. It binds the Pi row to the intended occurrence using exact occurrence/attempt evidence and dispatch metadata; it never infers a match from text. A late transcript row can still settle its original attempt after a reconnect or replacement. Conversely, a missing ledger/outbox row is not proof of settlement because the matching Pi event may be arriving on the same connection.

A hard reload reconstructs the same division of ownership: settled Pi rows form the transcript, and queued, dispatching, received, uncertain, failed, or cancelled occurrences form the outbox. Recovery-only rows are excluded from `state.messages` even when their presentation resembles a user or System message. They cannot overtake the transcript tail or become settled merely by being rehydrated.

## Lanes, compaction, and settlement fences

An occurrence has a `kind` (`prompt` or `steer`), a target lane, and FIFO sequence within that lane:

- prompts use `next-turn`;
- a steer uses `continuation` only while a streaming turn can accept it; otherwise it is next-turn work; and
- reordering changes only queued rows in their lane. A dispatched attempt is never reordered.

Compaction is active turn work, not an idle gap. It accepts and shows new work but fences every prompt, steer, retry, queue-drain, and tool-end dispatch path. Continuation steers retain their affinity where Pi can continue the turn; other work waits for the appropriate release owner.

Final `agent_end` finishes user-visible turn bookkeeping but is not a fresh-prompt admission boundary. Pi can still run compaction or continuation work. `agent_settled` is the boundary that proves Pi has cleared its active-run guard and may drain next-turn work. It is **not** a prompt echo: every in-flight attempt without a correlated Pi start remains non-retryable `uncertain` at settlement and is never automatically replayed.

See [Context compaction](compaction.md#reliable-turn-fence-and-release) for release ownership, overflow handling, and Stop during compaction.

## Failure, Stop, and recovery

The central safety rule is that a post-write handoff is ambiguous until exact evidence says otherwise. A timeout, thrown RPC, bridge loss, restart, abort, or replacement after the write may mean Pi received the message. Bobbit retains that exact intent/attempt as non-retryable `uncertain`; it does not invent a new occurrence, replay it automatically, or turn it into a transcript row.

A `{ success: false }` response is authoritative no-start evidence only when the matching prompt-author dispatch can also be durably cancelled. This second condition prevents a racing Pi echo from being retired and replayed. Once both facts hold, Bobbit may retire that attempt and perform its bounded recovery for the same durable occurrence:

- ordinary user-owned work can become an actionable, retryable failed row; and
- server-owned automatic or verifier work returns only to its existing bounded recovery policy, retaining the same occurrence and envelope.

A received attempt, a failed sidecar cancellation, or any ambiguous outcome cannot use this recovery path. Explicit Dismiss writes a cancellation tombstone before removing an actionable carrier; it does not assert that Pi never saw the message.

Stop follows the same rule. Queued work remains visible and continuation rows retarget to next-turn. Graceful replacement waits through `agent_settled`; hard replacement synthesizes the missing lifecycle boundary, reconciles exact evidence, then releases eligible work once. Old callbacks are generation-fenced. No Stop/restart path may blindly replay a dispatched occurrence.

### Restart and legacy records

Queue rows, modern in-flight attempts, and prompt-author settlements survive restart. Restore folds terminal sidecar evidence before a queue becomes live, preventing an echoed or dismissed occurrence from returning as pending work. A modern unsettled handoff restores as uncertain.

Older persisted ledgers may contain bare text strings or structured rows without a complete occurrence tuple. On load and at the trusted restore boundary, Bobbit converts each position into a deterministic, non-retryable uncertain carrier with server-owned compatibility identity. It does not compare legacy text against the transcript—equal strings are especially unsafe. A pre-identity structured record can be retired only by its own durable sidecar evidence; a bare record without that proof fails closed as uncertain. This migration avoids silent loss, duplicate delivery, accidental settlement, and false transcript cards while allowing users/operators to dismiss unresolved historical work.

## Errored turns

A genuine model/provider error parks accepted work while normal retry policy runs. A new prompt or steer below the consecutive-error cap can implicitly unstick an ordinary errored turn. Bobbit prepends a short recovery prefix to the **model-facing dispatch payload**, without changing the occurrence identity, original user text, lane, or FIFO position.

At the error cap, incoming work stays visibly parked until a human uses Retry or resolves the upstream problem. This prevents a broken provider from consuming unlimited automatic redrives while ensuring accepted work is not lost. A prompt arriving between final `agent_end` and `agent_settled` is retained as its one deferred occurrence and dispatched once at settlement, ahead of later eligible work.

## `bash_bg wait` interaction

Dispatching a reliable automatic continuation steer interrupts a registered active `bash_bg wait` request so Pi can observe the steer at a tool boundary. The background process is not killed; only the wait request is aborted. Work still fenced behind compaction, Stop, replacement, or the settlement boundary does not interrupt a wait until it actually dispatches.

Wait interruption is transport/liveness behavior, not delivery evidence. It neither proves Pi receipt nor settles the occurrence; the exact Pi row and sidecar are still required.

## UI actions and operational invariants

- Queue rows can be reordered, edited, promoted, retried, or dismissed only when their state permits it. Uncertain work is dismiss-only.
- Browser drafts are separate from delivery. Once Send or Steer creates an occurrence, the outbox owns it.
- Multi-tab and reconnect projection merges use occurrence IDs and revision-checked local mutations. A stale tab cannot replace a newer Retry or Dismiss.
- Delivery state is body-free in diagnostics. Operators should use session, intent, attempt, epoch, state, reason, and outcome—not prompt bodies—to investigate recovery.

The result is intentionally conservative: an acknowledged prompt remains discoverable immediately, and a recovery record remains visible without ever rewriting conversation history. Visible uncertainty is preferable to duplicate model side effects or a misleading transcript.

## Protocol summary

| Direction | Type | Purpose |
| --- | --- | --- |
| Client → server | `prompt`, `steer` | Submit one occurrence with an optional `intentId`. |
| Client → server | `retry_intent` | Retry one definitely failed eligible occurrence by stable ID. |
| Client → server | `steer_queued` | Promote an accepted queued occurrence to a steer. |
| Client → server | `remove_queued` | Durably dismiss one queued or uncertain occurrence. |
| Client → server | `reorder_queue` | Reorder queued IDs within their lanes. |
| Client → server | `abort` | Stop the active turn without deleting accepted work. |
| Server → client | `intent_update` | Exact occurrence projection or terminal disposition. |
| Server → client | `queue_update`, `delivery_outbox` | Server-authoritative visible outbox projection. |
| Server → client | correlated Pi user event | Receipt/transcript evidence carrying delivery identity. |

## Related documentation

- [Context compaction](compaction.md#reliable-turn-fence-and-release)
- [Auto-retry](auto-retry.md)
- [Background process persistence](bg-process-persistence.md#wait-interruption-versus-intent-delivery)
- [Debugging reliable delivery](debugging.md#reliable-prompt-and-steer-delivery)
- [WebSocket protocol](websocket-protocol.md)
