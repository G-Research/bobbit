# Steer subsystem rewrite — single source of truth, exactly-once, durable

Status: implemented (commits `f37aadd8`, `3d3d34cd`, `377f4bb7`, `6ed08fc9`). Reverted on `master` between `v0.8.0` and the freeze investigation, then restored on `goal/restore-st-ac566fee` once the actual freeze culprit was isolated to PR #514 (the WebSocket `emitSessionEvent` refactor — out of scope for this design and intentionally absent from `master`). The four implementation commits plus the three follow-ups (#477 abort-race, #478 listener-ordering, #480 `bash_bg wait` end-of-turn hint) are all back in place.

## 1. Problem

The steer/queue path has **three independent caches** of "what's pending":

1. **Bobbit `promptQueue`** — `src/server/agent/prompt-queue.ts`. Rows carry `isSteered` and `dispatched` flags.
2. **pi-coding-agent SDK `_steeringMessages`** — text-only mirror. Removed by exact-text match in `_processAgentEvent` on `message_start(role:user)` (see `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` ~line 273).
3. **pi-agent-core `Agent.steeringQueue`** — a `PendingMessageQueue` polled at turn boundaries (`agent.js` line 51, `getSteeringMessages` callback at line 295).

When these three diverge, the user pays.

### 1.1 Bug: duplicate steer on Stop

`removeDispatched()` on `message_end(user)` wiped **all** dispatched rows on any user-message echo, regardless of which row's text actually landed. `resetDispatched()` then re-armed every surviving dispatched row on `agent_end` while `wasAborting`. The race window is:

```
T0  user clicks Steer  → row enqueued, markDispatched, rpcClient.steer(text)
T0  SDK._steeringMessages.push(text), agent.steer(content)
T1  user clicks Stop   → forceAbort begins; status="aborting"
T2  agent emits message_start(user) for the steered text  (it DID land in transcript)
T3  agent emits message_end(user) → removeDispatched() wipes the row
T4  agent_end fires while wasAborting — but the row is already gone, OK
```

The actual buggy sequence is when the lifecycle hook fires *before* the SDK's text-match got to the user-message echo, or the row's `dispatched` flag was set but the SDK never delivered the text:

```
T0  Steer → enqueue+markDispatched, rpcClient.steer(text)
T1  Stop  → forceAbort
T2  agent_end (aborting=true) → resetDispatched() re-arms ALL dispatched rows
T3  drainQueue picks the steered row up → second dispatch
T4  user sees the steered text twice in chat
```

The current source comment (line 1644) explicitly admits at-least-once: *"we may redeliver once — at-least-once is preferred over lost user text"*. That is the wrong contract — the user wants exactly-once at the transcript level.

### 1.2 Architectural duplication

- `_dispatchSteeredMessages` (boundary batch) and `drainQueue` (post-restart batch) re-implement the same join logic twice.
- `bg.abortAllWaits` is called from three sites: `deliverLiveSteer`, `steerQueued`, `_dispatchSteeredMessages`.
- `deliverLiveSteer` and `steerQueued` are two near-identical RPC entry points with diverging persistence semantics.
- `PromptQueue` carries a `dispatched` flag whose entire purpose is to track "the SDK has it, don't re-dispatch" — duplicating SDK state.

### 1.3 Coverage gaps

Per `.bobbit/notes/steer-test-audit.md` (referenced in goal spec) — five P0 scenarios have **no test coverage** today:

- Steer + WS reconnect mid-flight (no de-dup test).
- Steer + gateway harness restart (only an in-memory round-trip).
- Multi-tab divergence under concurrent edits.
- Sent-indicator removal on user-message echo.
- Steer + Stop exactly-once after respawn.

## 2. Goal

Single atomic change. End state:

1. **Single source of truth.** Bobbit `promptQueue` owns queued rows until `_dispatchSteer()` starts the handoff. `_dispatchSteer()` records the joined batch in `SessionInfo.inFlightSteerTexts`, removes the queue rows, persists the queue and ledger together, then calls `rpcClient.steer()`. Bobbit's persisted shadow ledger remains authoritative for restart/abort recovery until the matching user echo or reconciliation clears it. Bobbit's `dispatched` flag and the `removeDispatched()` / `resetDispatched()` / `markDispatched()` triplet are **deleted**.
2. **Reconciliation on abort/restore.** `_reconcileAfterAbort()` and restore reconciliation drain un-echoed `inFlightSteerTexts` entries back to the front of `promptQueue` with `isSteered=true`. There is no SDK queue-drain proxy in Bobbit's recovery path.
3. **Exactly-once at the transcript level.** A user-typed steer appears as exactly one `<user-message>` in chat. Internal re-dispatches across abort/restart are invisible.
4. **Five P0 tests in place** before the production change goes live.

## 3. Architecture after rewrite

### 3.1 Layer ownership

```
┌─────────────────────────────────────────────────────────┐
│ Agent.steeringQueue (pi-agent-core)                     │ ← drained at turn boundaries
└─────────────────────────────────────────────────────────┘
                          ▲
                          │ this.agent.steer(message) inside SDK
┌─────────────────────────────────────────────────────────┐
│ AgentSession._steeringMessages (pi-coding-agent)        │ ← removed by text match on message_start(user)
│ SDK in-process mirror used during normal delivery;      │   in _processAgentEvent
│ not durable across gateway restart or force-kill.       │
└─────────────────────────────────────────────────────────┘
                          ▲
                          │ rpcClient.steer(text) (single call site)
┌─────────────────────────────────────────────────────────┐
│ Bobbit persisted steer ledger + promptQueue             │
│  - row added on enqueuePrompt                           │
│  - _dispatchSteer records inFlightSteerTexts, removes   │
│    rows, then persists queue+ledger together            │
│  - echo/reconcile clears the ledger; abort/restore      │
│    re-enqueues ledger entries at front as steered rows   │
└─────────────────────────────────────────────────────────┘
                          ▲
                          │ {type:"steer"} / {type:"steer_queued"} WS frames
                       (clients)
```

### 3.2 `PromptQueue` simplification

**Delete** (single commit):

| Symbol | File | Reason |
|---|---|---|
| `QueuedMessage.dispatched` | `ws/protocol.ts` + every consumer | Bobbit's persisted steer ledger owns recovery |
| `markDispatched(messageId)` | `prompt-queue.ts` | no longer meaningful |
| `removeDispatched()` | `prompt-queue.ts` | replaced by `_consumeSteerEcho()` ledger consumption |
| `resetDispatched()` | `prompt-queue.ts` | replaced by `_reconcileAfterAbort()` / restore ledger reconciliation |
| `dequeueAllSteered()` "+!dispatched" filter | `prompt-queue.ts:71` | dispatched no longer exists |
| `dequeueUndispatched()` | `prompt-queue.ts` | rename to plain `dequeue()` |

**Add**:

| Symbol | Behaviour |
|---|---|
| `enqueueAtFront(text, opts)` | Insert at index 0, then `reorder()` so steered group stays first. Used by reconciliation. |

**Keep**: `enqueue`, `dequeue` (the existing one — front pop), `dequeueAllSteered`, `steer(messageId)`, `remove`, `reorderByIds`, `peek`, `toArray`, `length`, `isEmpty`.

A row's lifetime is now exactly: **queued → dispatched (= removed)**.

### 3.3 Persisted shadow-ledger reconciliation

`SessionInfo.inFlightSteerTexts: string[]` is Bobbit's durable handoff ledger for steers that have left `promptQueue` but have not yet echoed back as user messages. It exists because the SDK's in-process steering mirror is not durable across gateway restart, bridge loss, or force-kill.

Lifecycle:

1. `_dispatchSteer()` joins the rows into `batchText`, appends that text to `inFlightSteerTexts`, removes the queue rows, then persists `messageQueue` and `inFlightSteerTexts` in the same store update via `broadcastQueue(..., { includeInFlightSteers: true })`.
2. `rpcClient.steer(batchText)` hands the batch to the SDK for normal delivery.
3. `_consumeSteerEcho()` removes the matching ledger entry when the SDK emits the user `message_end` for that text.
4. `_reconcileAfterAbort()` and restore reconciliation move any remaining ledger entries back to the front of `promptQueue` with `isSteered=true`, then clear and persist the ledger.

This makes Bobbit's persisted ledger the authority for restart/abort recovery. The SDK mirror is still part of the live delivery path, but Bobbit does not depend on draining SDK process memory to recover accepted-but-unechoed steers.

### 3.4 `SessionManager` consolidation

Replace `deliverLiveSteer`, `steerQueued`'s dispatch path, and `_dispatchSteeredMessages` with a **single internal method**:

```ts
private async _dispatchSteer(session: SessionInfo, rows: QueuedMessage[]): Promise<void> {
  if (rows.length === 0) return;
  this.bgProcessManager?.abortAllWaits(session.id);

  const batchText = rows.map(r => r.text).join("\n");
  if (!session.inFlightSteerTexts) session.inFlightSteerTexts = [];
  session.inFlightSteerTexts.push(batchText);

  for (const r of rows) session.promptQueue.remove(r.id);
  this.broadcastQueue(session, { includeInFlightSteers: true });

  try {
    await session.rpcClient.steer(batchText);
  } catch (err) {
    const lidx = session.inFlightSteerTexts.lastIndexOf(batchText);
    if (lidx !== -1) {
      session.inFlightSteerTexts.splice(lidx, 1);
      for (const r of [...rows].reverse()) {
        session.promptQueue.enqueueAtFront(r.text, { isSteered: true });
      }
      this.broadcastQueue(session, { includeInFlightSteers: true });
    } else {
      this.persistInFlightSteerLedger(session);
      // Abort/restore reconciliation already recovered this ledger entry.
      // Do not enqueue a duplicate after a late RPC rejection.
    }
    throw err;
  }
}
```

Three thin wrappers / call sites use it:

| Site | When | What it dispatches |
|---|---|---|
| `deliverLiveSteer(sid, text)` | WS `{type:"steer"}` while streaming | enqueue row `isSteered=true` then `_dispatchSteer([row])` |
| Tool-boundary in `handleAgentLifecycle` | `tool_execution_end` and (safety) `agent_end` non-aborting | Defensive flush of any steered rows that remain queued (for example recovered/pre-existing rows) via `_dispatchSteer(promptQueue.dequeueAllSteered())` |
| `steerQueued` | WS `{type:"steer_queued"}` while streaming | mark `isSteered=true`, dequeue the steered front group, and immediately call `_dispatchSteer(...)` |

`steerQueued` now dispatches immediately while streaming, matching a fresh live steer instead of waiting for a later tool boundary. Idle promotions still drain normally through `drainQueue()` with steered rows first. Wait interruption, row removal, shadow-ledger handoff, and RPC-failure recovery stay centralized in `_dispatchSteer()`.

Net call-site map for steer-related `bg.abortAllWaits(sessionId)` after the change:

1. Inside `_dispatchSteer` (always — every steer dispatch).

Queued promotions and fresh live steers therefore share the same wait-abort/recovery behavior; termination cleanup remains separate.

### 3.5 Reconciliation on abort

`_reconcileAfterAbort()` is a thin wrapper around the Bobbit-owned ledger drain:

```ts
private _reconcileInFlightSteers(session: SessionInfo): void {
  const ledger = session.inFlightSteerTexts;
  if (!ledger || ledger.length === 0) return;
  for (const text of [...ledger].reverse()) {
    session.promptQueue.enqueueAtFront(text, { isSteered: true });
  }
  session.inFlightSteerTexts = [];
  this.broadcastQueue(session, { includeInFlightSteers: true });
}

private _reconcileAfterAbort(session: SessionInfo): void {
  this._reconcileInFlightSteers(session);
}
```

**Where it's called:**

- `handleAgentLifecycle` `agent_end` branch where `wasAborting` is true — before the post-abort queue drain runs.
- `forceAbort` after the stop/teardown path has made it clear the accepted steer may never echo.
- Restore reconciliation after durable session state is rebuilt; echoed steers are consumed first, then any remaining ledger entries are re-enqueued once.

The key invariant is that recovery reads Bobbit's persisted `inFlightSteerTexts`, not SDK process memory. If a pending `rpcClient.steer()` later rejects after reconciliation already drained the ledger, `_dispatchSteer()` detects that the batch text is no longer present and skips rollback re-enqueue to avoid a duplicate.

### 3.6 WS reconnect

No change to the wire protocol. `queue_update` already carries `seq`, `{type:"resume", fromSeq}` already replays missed events. The new architecture's invariant is:

- On every reconnect, the server's first `queue_update` after auth reflects current canonical `promptQueue`.
- The client never holds optimistic state that survives reconnect without reconciling against the snapshot.

Because Bobbit persists `inFlightSteerTexts` before removing queue rows, a reconnect during the `await rpcClient.steer()` window observes:

- `promptQueue` empty (row already removed).
- `inFlightSteerTexts` holds the text for durable recovery and optional snapshot splicing.
- On user-message echo, `_consumeSteerEcho()` clears the ledger.
- Net: exactly one transcript entry, regardless of when the WS dropped.

### 3.7 Multi-tab convergence

`broadcastQueue` already broadcasts to every client. The convergence story works because:

- B's `_serverQueue` is replaced by every `queue_update` (server is authoritative).
- B's optimistic action (e.g. `steer_queued` on a row A just removed) → `promptQueue.steer(id)` returns `false` (unknown id) → server no-ops → next `queue_update` corrects B.

After the rewrite the only client-visible state difference is the `dispatched` flag is gone. Clients that rendered a "sent-indicator" pill keyed on `dispatched=true` need to render based on something else. **Server-side mechanism**: a dispatched steer is not represented by a queue row — `_dispatchSteer()` records it in the shadow ledger, removes the row, and broadcasts the queue update. The browser test (audit §6.4) is rephrased: it asserts the queue-row count drops to zero AND the `<user-message>` element appears in chat within 2 s — no per-row "sent" pill needed.

Current implementation uses `SessionInfo.inFlightSteerTexts: string[]` as a persisted shadow ledger, not as a lingering Sent-pill queue. `_dispatchSteer()` records the batch before removing queue rows and persists the ledger with the queue update; `_consumeSteerEcho()` clears it on the matching user echo; abort/restore reconciliation drains any un-echoed entries back to the front of `PromptQueue`. The UI still relies on row removal plus transcript echo rather than a persistent in-flight pill.

## 4. File-by-file changes

| File | Change |
|---|---|
| `src/server/agent/prompt-queue.ts` | Delete `markDispatched`/`removeDispatched`/`resetDispatched`. Drop `dispatched`-aware filter from `dequeueAllSteered`. Rename `dequeueUndispatched` → `dequeue` (or merge into existing `dequeue`). Add `enqueueAtFront(text, opts)`. |
| `src/server/ws/protocol.ts` | Remove `dispatched?: boolean` from `QueuedMessage`. |
| `src/server/agent/session-manager.ts` | Replace `deliverLiveSteer` body, `steerQueued` body (streaming promotions dequeue the steered front group and immediately call `_dispatchSteer`; idle promotions drain normally), `_dispatchSteeredMessages` (delete), `handleAgentLifecycle` `message_end(user)` hook (delete `removeDispatched`), `agent_end` `wasAborting` block (replace `resetDispatched` with `_reconcileAfterAbort`), `forceAbort` reconciliation, and add `_dispatchSteer` / `_reconcileAfterAbort`. |
| `src/ui/...` | If sent-indicator was keyed on `dispatched`, remove that DOM. (Audit at impl time — likely `QueuedMessageList.ts` or `Composer.ts`.) |
| `tests/e2e/mock-agent-core.mjs` | Remove the `[STEER_RECEIVED] <text>` ACK string. Steer handler delivers text into transcript via `message_start(user)` + `message_end(user)` events with the steer text — same shape as production. |
| `tests/e2e/queue-e2e.spec.ts` | Update assertions that read `.dispatched`. |
| `tests/queue-dispatch.spec.ts` | Rewrite to assert on row-removal + SDK reconciliation, not on `dispatched` flag transitions. |
| `tests/prompt-queue.spec.ts` | Drop `markDispatched`/`removeDispatched`/`resetDispatched` cases. Add `enqueueAtFront` cases. |
| `tests/e2e/ui/bg-wait-steer-flow.spec.ts` | Assert on rendered `<user-message>` element, not on `[STEER_RECEIVED]`. |
| `tests/e2e/ui/bg-wait-steer-stop-flow.spec.ts` | Replace with §6.5 exactly-once test. |
| `tests/e2e/ui/queue-ui.spec.ts` (PI-10, PI-10b) | Assert on `<user-message>` (and §6.4 sent-indicator-or-row-removed within 2 s). |
| `tests/e2e/steer-midturn.spec.ts` | Assert on transcript, not ACK string. |
| `tests/e2e/abort-status-e2e.spec.ts` (PI-25b) | Same. |
| `tests/e2e/steer-reconnect.spec.ts` *(new)* | Audit §6.1 — STAY_BUSY, `steer_queued`, close, reopen, drive idle, count `<user-message>` === 1. |
| `tests/e2e/steer-gateway-restart.spec.ts` *(new, may end up in `tests/manual-integration/` if harness restart isn't supported in-process)* | Audit §6.2. |
| `tests/e2e/steer-multitab.spec.ts` *(new)* | Audit §6.3. |

## 5. Acceptance test mapping

| AC | Test file | Tier |
|---|---|---|
| §1 exactly-once UX | rewritten `bg-wait-steer-stop-flow.spec.ts` | Browser (Tier 2.5) |
| §2 WS reconnect | new `steer-reconnect.spec.ts` | API E2E |
| §3 gateway restart | new `steer-gateway-restart.spec.ts` (or manual-integration) | API E2E or Manual |
| §4 multi-tab | new `steer-multitab.spec.ts` | API E2E |
| §5 sent-indicator removal | augment `queue-ui.spec.ts PI-10` | Browser E2E |
| §6 mock cleanup | grep `STEER_RECEIVED` returns 0 | All tiers |
| §7 architecture | `prompt-queue.spec.ts` updated; manual code-review of touched files | Unit + review |
| §8 existing tests pass | full `npm test` run | Regression |

## 6. Risk control

### 6.1 Shadow-ledger durability

Risk: a steer can leave the visible queue before the SDK echoes it. If the gateway restarts or the agent process is force-killed during that window, an in-memory-only handoff would lose the steer or re-send it twice.

Mitigation: `_dispatchSteer()` appends the joined `batchText` to `SessionInfo.inFlightSteerTexts` before queue-row removal and persists both the queue and ledger in the same store update. Recovery paths use only that persisted ledger: echoed entries are removed by `_consumeSteerEcho()`, while un-echoed entries are re-enqueued at the front of `PromptQueue` for exactly-once redispatch.

### 6.2 Late RPC rejection after reconciliation

Risk: abort/restore reconciliation can drain a ledger entry while the original `rpcClient.steer()` call is still pending. If that call later rejects and the catch path blindly re-enqueues the same rows, the user sees a duplicate.

Mitigation: the catch path rolls back only when `batchText` is still present in `inFlightSteerTexts`. If reconciliation already removed it, the catch path persists the current ledger and skips re-enqueue.

### 6.3 Order of work

The goal spec mandates atomic landing, but the *test ordering* matters:

1. Land the 5 P0 tests (§6.1–6.5) against current `master`. Expect §6.5 (exactly-once) and §6.1 (reconnect) to fail; §6.2/§6.3/§6.4 may pass coincidentally. Documented baseline.
2. Rewrite `mock-agent-core.mjs` to emit production-shape `message_start/end(user)` for steered text instead of `[STEER_RECEIVED]`. Update consuming tests to match. CI green.
3. Atomic commit: `PromptQueue` simplification + `SessionManager` consolidation + persisted shadow-ledger reconciliation. P0 tests now all pass.

## 7. Out of scope

- Switching SDK steering mode from `one-at-a-time` → `all` (UX preference, unrelated).
- Live-steer image attachments (audit §6.6, P1, separate goal).
- Skill expansion in steered messages (audit §6.7, P1).
- Sandboxed-agent steer flow (audit §6.14, P2 — needs Docker integration tests).

## 8. Open questions for reviewer

1. **Sent-indicator UX**: should we drop the pill entirely (preferred — simpler, no extra state) or keep an ephemeral `inFlightSteerTexts` set for visual feedback during the dispatch→echo window? The audit §6.4 P0 test currently asserts on the pill disappearing; if we drop the pill, we rephrase to "row count → 0".
2. **Image attachments on live-steer**: out of scope per goal spec, but `_dispatchSteer` currently joins by text only. Confirm no regression for non-image steers. (Audit §6.6 covers the missing image path.)
3. **Ledger text shape**: `_dispatchSteer()` batches steered rows with newlines, so echo consumption and rollback must use that same joined `batchText` instead of per-row text.

## 9. Implementation outcome

Landed as the four-commit stack on `goal/steer-subs-bd19361f`:

| Commit | Subject | Role |
|---|---|---|
| `f37aadd8` | refactor(steer): remove dispatched flag, single dispatch site | `PromptQueue` simplification + `_dispatchSteer` consolidation |
| `3d3d34cd` | test(steer): drop STEER_RECEIVED mock ACK; assert on transcript/DOM | Acceptance §6 — mock cleanup + browser/API tests rewritten to scrape `<user-message>` |
| `377f4bb7` | test(steer): P0 reconnect/multitab/stop-exactly-once + queue unit tests | Acceptance §1/§2/§4/§5 — the five P0 tests |
| `6ed08fc9` | fix(steer): shadow-ledger reconciliation on abort + AC §3 restart test | Acceptance §3 (gateway restart) + final shadow-ledger lifecycle |

### What landed

- **`PromptQueue`** (`src/server/agent/prompt-queue.ts`): no `dispatched` field, no `markDispatched` / `removeDispatched` / `resetDispatched`. Adds `enqueueAtFront(text, opts)` for reconciliation paths. Row lifetime is exactly `queued → dispatched (= removed)`.
- **`SessionManager`** (`src/server/agent/session-manager.ts`): single dispatch site `_dispatchSteer()` records the joined batch in `inFlightSteerTexts`, removes rows from `promptQueue`, persists queue+ledger together, then awaits `rpcClient.steer()`. `deliverLiveSteer`, streaming `steerQueued` promotions, and defensive `tool_execution_end` / `agent_end` boundary flushes all funnel through it. While streaming, `steerQueued` dequeues the steered front group and immediately calls `_dispatchSteer()`; idle promotions drain normally. `bgProcessManager.abortAllWaits()` for steer delivery is owned by `_dispatchSteer()`, so wait abort/recovery is shared by fresh live steers and queued promotions.
- **Shadow ledger** (`SessionInfo.inFlightSteerTexts: string[]`): chosen because the SDK queue-drain surface is not available through Bobbit's RPC bridge and the agent-side dispatch table lives inside `node_modules/@earendil-works/pi-coding-agent`. `_dispatchSteer()` records the batch before row removal and persists `inFlightSteerTexts` with the queue update; `_consumeSteerEcho()` splices on matching `message_end(role:user)`; `_reconcileAfterAbort()` and restore drain un-echoed entries back to the front of `promptQueue` via `enqueueAtFront`. If a late steer RPC rejection arrives after reconciliation already drained the ledger entry, the catch path does not enqueue a duplicate.
- **Reconciliation on abort**: `_reconcileAfterAbort()` runs in two places — `handleAgentLifecycle`'s `agent_end while wasAborting` branch (graceful) and `forceAbort` after `rpcClient.stop()` (force-kill). Either way Bobbit-owned un-echoed ledger entries are pulled back into the queue and redispatched exactly once after the agent is ready.
- **Tests**: five P0 specs in place — `tests/e2e/ui/bg-wait-steer-stop-flow.spec.ts` (§1 exactly-once), `tests/e2e/steer-reconnect.spec.ts` (§2 WS reconnect), `tests/e2e/steer-gateway-restart.spec.ts` (§3 gateway restart), `tests/e2e/steer-multitab.spec.ts` (§4 multi-tab convergence), `tests/e2e/ui/queue-ui.spec.ts` PI-10 (§5 sent-indicator removal). Plus `tests/queue-dispatch.spec.ts` and `tests/prompt-queue.spec.ts` rewritten to assert on row-removal + `enqueueAtFront` rather than on the deleted `dispatched` flag.
- **Mock cleanup**: `tests/e2e/mock-agent-core.mjs` no longer emits `[STEER_RECEIVED] <text>`. Browser tests scrape `<user-message>` elements; API tests read `agent_session.messages`. `grep -r STEER_RECEIVED tests/` returns 0 matches.

### Verification greps

Four invariants the implementation enforces. Each grep should return zero matches against the production tree on `master`:

```bash
# 1. No legacy ACK string in any test (mock-agent and consumers).
grep -r "STEER_RECEIVED" tests/

# 2. PromptQueue has no dispatched field or reset/mark/remove triplet.
grep -E "markDispatched|removeDispatched|resetDispatched" src/

# 3. No dispatched flag on QueuedMessage rows.
grep -E "\.dispatched|dispatched\?" src/server/agent/prompt-queue.ts

# 4. Single dispatch site — _dispatchSteer/_reconcileAfterAbort/inFlightSteerTexts present.
grep -c "_dispatchSteer\|_reconcileAfterAbort\|inFlightSteerTexts" src/server/agent/session-manager.ts
# (this one should be > 0; the others should be 0)
```

### Deviations from the original design

- **Bobbit-owned ledger recovery was used.** The original design expected an SDK queue-drain passthrough, but implementation-time investigation showed the relevant dispatch table lives inside the SDK package. Recovery therefore uses Bobbit's persisted shadow ledger, mirroring the SDK's text-match removal logic at our layer. Lifetime is strictly between dispatch and echo.
- **Sent-indicator pill** was kept (not dropped per §3.7's preferred option). Audit §6.4's P0 test asserts on its disappearance within 2 s; the simplest path was to keep the existing UI and let row-removal drive it.
- **`forceAbort` reconciliation order**: design §3.5 calls `_reconcileAfterAbort` before kill in the early phase. Implementation calls it after `session.unsubscribe()` + `await session.rpcClient.stop()`, between bridge teardown and respawn — the SDK mirror is in-process state and is gone with the bridge, so the ledger (Bobbit-owned) is what we drain regardless. The late-rejection guard described in §6.2 prevents duplicate rollback after that ledger drain.

### Where to look next

- Steer architecture, shadow-ledger lifecycle, and force-kill recovery: [docs/prompt-queue.md — Abort and force-kill recovery](../prompt-queue.md#abort-and-force-kill-recovery).
- Live-steer call-site map and the `_dispatchSteer()`-owned wait abort path: [docs/internals.md — Steer-interruptible bash_bg wait](../internals.md#steer-interruptible-bash_bg-wait).
- Debugging duplicate-on-Stop, lost-after-abort, and reconnect mid-steer scenarios: [docs/debugging.md — Abort, steer & queue](../debugging.md#abort-steer--queue).
