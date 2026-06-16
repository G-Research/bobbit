# Steer subsystem rewrite — single source of truth, exactly-once, durable

Status: implemented (commits `f37aadd8`, `3d3d34cd`, `377f4bb7`, `6ed08fc9`). Reverted on `master` between `v0.8.0` and the freeze investigation, then restored on `goal/restore-st-ac566fee` once the actual freeze culprit was isolated to PR #514 (the WebSocket `emitSessionEvent` refactor — out of scope for this design and intentionally absent from `master`). The four implementation commits plus the three follow-ups (#477 abort-race, #478 listener-ordering, #480 `bash_bg wait` end-of-turn hint) are all back in place.

## 1. Problem

The steer/queue path has **three independent caches** of "what's pending":

1. **Bobbit `promptQueue`** — `src/server/agent/prompt-queue.ts`. Rows carry `isSteered` and `dispatched` flags.
2. **pi-coding-agent SDK `_steeringMessages`** — text-only mirror. Removed by exact-text match in `_processAgentEvent` on `message_start(role:user)` (see `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` ~line 273).
3. **pi-agent-core `Agent.steeringQueue`** — a `PendingMessageQueue` polled at turn boundaries (`agent.js` line 51, `getSteeringMessages` callback at line 295).

When these three diverge, the user pays.

### 1.1 Bug: duplicate steer on Stop

`session-manager.ts:1605` (`removeDispatched()` on `message_end(user)`) wipes **all** dispatched rows on any user-message echo, regardless of which row's text actually landed. `resetDispatched()` at line 1647 then re-arms every surviving dispatched row on `agent_end` while `wasAborting`. The race window is:

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

1. **Single source of truth.** Bobbit `promptQueue` owns rows from `enqueuePrompt` until `rpcClient.steer()` is called. Once dispatched the SDK's `_steeringMessages` mirror is the authority. Bobbit's `dispatched` flag and the `removeDispatched()` / `resetDispatched()` / `markDispatched()` triplet are **deleted**.
2. **Reconciliation on abort.** On `agent_end` while `wasAborting` (and inside `forceAbort` after respawn), Bobbit calls a new `RpcBridge.drainSteeringQueue()` that proxies the SDK's existing `clearQueue()` — destructively pulls back undelivered text — and re-enqueues each entry at the front of `promptQueue` with `isSteered=true`.
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
│ Authoritative for in-flight steers from dispatch        │   in _processAgentEvent
│ until echoed back into the transcript.                  │
└─────────────────────────────────────────────────────────┘
                          ▲
                          │ rpcClient.steer(text) (single call site)
┌─────────────────────────────────────────────────────────┐
│ Bobbit promptQueue                                      │
│  - row added on enqueuePrompt                           │
│  - row removed when rpcClient.steer() resolves          │
│    (or when drainQueue dispatches as prompt)            │
│  - on abort: SDK clearQueue() → re-enqueue at front     │
│    with isSteered=true                                  │
└─────────────────────────────────────────────────────────┘
                          ▲
                          │ {type:"steer"} / {type:"steer_queued"} WS frames
                       (clients)
```

### 3.2 `PromptQueue` simplification

**Delete** (single commit):

| Symbol | File | Reason |
|---|---|---|
| `QueuedMessage.dispatched` | `ws/protocol.ts` + every consumer | SDK mirror is authoritative |
| `markDispatched(messageId)` | `prompt-queue.ts` | no longer meaningful |
| `removeDispatched()` | `prompt-queue.ts` | replaced by SDK echo |
| `resetDispatched()` | `prompt-queue.ts` | replaced by SDK reconciliation |
| `dequeueAllSteered()` "+!dispatched" filter | `prompt-queue.ts:71` | dispatched no longer exists |
| `dequeueUndispatched()` | `prompt-queue.ts` | rename to plain `dequeue()` |

**Add**:

| Symbol | Behaviour |
|---|---|
| `enqueueAtFront(text, opts)` | Insert at index 0, then `reorder()` so steered group stays first. Used by reconciliation. |

**Keep**: `enqueue`, `dequeue` (the existing one — front pop), `dequeueAllSteered`, `steer(messageId)`, `remove`, `reorderByIds`, `peek`, `toArray`, `length`, `isEmpty`.

A row's lifetime is now exactly: **queued → dispatched (= removed)**.

### 3.3 SDK reconciliation primitive

The SDK already exposes the destructive drain we need:

```js
// node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js  (~L1015)
clearQueue() {
    const steering = [...this._steeringMessages];
    const followUp = [...this._followUpMessages];
    this._steeringMessages = [];
    this._followUpMessages = [];
    this.agent.clearAllQueues();          // also drains pi-agent-core PendingMessageQueue
    this._emitQueueUpdate();
    return { steering, followUp };
}
```

This is exactly what we need — atomic, destructive, clears both the SDK mirror **and** the agent-core queue, and emits a `queue_update` so any downstream observers see the empty state. **No upstream PR required.** We expose it through the bridge:

```ts
// src/server/agent/rpc-bridge.ts
clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
  return this.sendCommand({ type: "clear_queue" });
}
```

The bridge protocol already forwards arbitrary commands to the SDK loop; we add a new command name `clear_queue` whose handler in the SDK side is a one-liner returning `agentSession.clearQueue()`. (The SDK already routes RPC commands to `agentSession.*` methods — see existing `steer`, `prompt`, `switch_session` patterns.)

If — at implementation time — the bridge's RPC surface turns out NOT to expose `clearQueue` already and adding a passthrough is non-trivial, we have a Bobbit-side fallback: **shadow ledger** scoped to the in-flight window only (described in §6 Risk Control). The default path uses the SDK primitive.

### 3.4 `SessionManager` consolidation

Replace `deliverLiveSteer`, `steerQueued`'s dispatch path, and `_dispatchSteeredMessages` with a **single internal method**:

```ts
private async _dispatchSteer(session: SessionInfo, rows: QueuedMessage[]): Promise<void> {
  if (rows.length === 0) return;
  // 1. Force tool boundary if a bg wait is parked (single call site).
  this.bgProcessManager?.abortAllWaits(session.id);
  // 2. Build batch text and remove rows from promptQueue *before* RPC.
  //    SDK becomes authoritative the moment rpcClient.steer resolves.
  const batchText = rows.map(r => r.text).join("\n");
  for (const r of rows) session.promptQueue.remove(r.id);
  this.broadcastQueue(session);
  // 3. Hand off to SDK.
  try {
    await session.rpcClient.steer(batchText);
  } catch (err) {
    // RPC-layer failure (process gone, etc.). Re-insert at front so the
    // post-restart drain or next turn-boundary picks it up.
    for (const r of rows.reverse()) {
      session.promptQueue.enqueueAtFront(r.text, { isSteered: true });
    }
    this.broadcastQueue(session);
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

Replace lines 1645–1649 (`if (wasAborting) session.promptQueue.resetDispatched();`) and the equivalent in `forceAbort` (line 4723) with the **same** call:

```ts
private async _reconcileAfterAbort(session: SessionInfo): Promise<void> {
  let undelivered: { steering: string[]; followUp: string[] };
  try {
    undelivered = await session.rpcClient.clearQueue();
  } catch (err) {
    console.error(`[session-manager] clearQueue failed for ${session.id}:`, err);
    return;
  }
  // Re-enqueue at the FRONT in original order. Steered group sorts first
  // automatically via PromptQueue.reorder(), so insert in reverse so first
  // element ends up at index 0.
  for (const text of [...undelivered.steering].reverse()) {
    session.promptQueue.enqueueAtFront(text, { isSteered: true });
  }
  // followUp messages were never user-typed steers — discard. (If we ever
  // expose followUp at the Bobbit layer this becomes the place to handle it.)
  if (undelivered.steering.length > 0) this.broadcastQueue(session);
}
```

**Where it's called:**

- `handleAgentLifecycle` `agent_end` branch where `wasAborting` is true — *before* setting `status="idle"` and the `drainQueue` call. Awaiting blocks the idle transition by a few ms; that is acceptable and keeps the invariant clean.
- `forceAbort` *before* `restartAgent`. The SDK's in-process state is about to be torn down. Pulling `clearQueue()` first is what makes this safe.

**`forceAbort` cold-start case.** When the agent process is hard-killed and a fresh one is spawned:

- The SDK rehydrates `_steeringMessages` from … nowhere. It is in-process state only. After respawn the SDK's mirror is empty.
- That is **fine**. Before the respawn we already pulled `clearQueue()` off the **dying** agent. Anything still in our `promptQueue` after that is genuinely undelivered, with `isSteered=true`, and the existing `drainQueue` post-respawn picks them up — except now `drainQueue` dispatches via `prompt` (idle path), not `steer`, which is exactly what we want for a freshly-spawned agent.

The fix here is to **call `clearQueue()` BEFORE we start the kill** — i.e. in the early phase of `forceAbort`, while the bridge is still healthy:

```ts
async forceAbort(id: string, gracePeriodMs = 3000): Promise<void> {
  const session = this.sessions.get(id);
  if (!session) return;
  // BEFORE tearing down, pull undelivered steers back into our queue.
  await this._reconcileAfterAbort(session).catch(() => {});
  // ... existing teardown and respawn
}
```

If the bridge is already dead by the time `forceAbort` is invoked (race), `_reconcileAfterAbort` swallows the RPC error and we lose anything the SDK had buffered post-`steer()`-call but pre-`message_start(user)`. That window is the residual at-least-once risk; in §6 we judge it negligible (orders of magnitude smaller than the current always-on at-least-once).

### 3.6 WS reconnect

No change to the wire protocol. `queue_update` already carries `seq`, `{type:"resume", fromSeq}` already replays missed events. The new architecture's invariant is:

- On every reconnect, the server's first `queue_update` after auth reflects current canonical `promptQueue`.
- The client never holds optimistic state that survives reconnect without reconciling against the snapshot.

Because the SDK's mirror is authoritative for in-flight, and because `_dispatchSteer` removes the row from `promptQueue` synchronously *before* awaiting the RPC, a reconnect during the `await rpcClient.steer()` window observes:

- `promptQueue` empty (row already removed).
- SDK mirror still holds the text.
- On `message_start(user)` echo, SDK clears its mirror.
- Net: exactly one transcript entry, regardless of when the WS dropped.

### 3.7 Multi-tab convergence

`broadcastQueue` already broadcasts to every client. The convergence story works because:

- B's `_serverQueue` is replaced by every `queue_update` (server is authoritative).
- B's optimistic action (e.g. `steer_queued` on a row A just removed) → `promptQueue.steer(id)` returns `false` (unknown id) → server no-ops → next `queue_update` corrects B.

After the rewrite the only client-visible state difference is the `dispatched` flag is gone. Clients that rendered a "sent-indicator" pill keyed on `dispatched=true` need to render based on something else. **Server-side mechanism**: when `_dispatchSteer` resolves we don't need a pill at all — the row was removed from the queue, broadcast already happened, the SDK mirror handles "in flight" semantics invisibly. The current sent-indicator can be retired. The browser test (audit §6.4) is rephrased: it asserts the queue-row count drops to zero AND the `<user-message>` element appears in chat within 2 s — no per-row "sent" pill needed.

If we want to keep the pill for UX (a transient "delivering…" hint between dispatch and echo), we add a server-side ephemeral set `inFlightSteerTexts: Set<string>` on the session, populated immediately before `rpcClient.steer()` resolves and cleared on the corresponding `message_start(user)` echo. This is a pure UI affordance, NOT a queue. Default for this rewrite: **drop the pill**, rely on row-removal + transcript echo.

## 4. File-by-file changes

| File | Change |
|---|---|
| `src/server/agent/prompt-queue.ts` | Delete `markDispatched`/`removeDispatched`/`resetDispatched`. Drop `dispatched`-aware filter from `dequeueAllSteered`. Rename `dequeueUndispatched` → `dequeue` (or merge into existing `dequeue`). Add `enqueueAtFront(text, opts)`. |
| `src/server/ws/protocol.ts` | Remove `dispatched?: boolean` from `QueuedMessage`. |
| `src/server/agent/session-manager.ts` | Replace `deliverLiveSteer` body, `steerQueued` body (streaming promotions dequeue the steered front group and immediately call `_dispatchSteer`; idle promotions drain normally), `_dispatchSteeredMessages` (delete), `handleAgentLifecycle` `message_end(user)` hook (delete `removeDispatched`), `agent_end` `wasAborting` block (replace `resetDispatched` with `_reconcileAfterAbort`), `forceAbort` reconciliation, and add `_dispatchSteer` / `_reconcileAfterAbort`. |
| `src/server/agent/rpc-bridge.ts` | Add `clearQueue()` method that sends `{type:"clear_queue"}`. Add type for `clear_queue` in the bridge command union. |
| `src/server/agent/rpc-bridge-server.ts` *(or wherever the SDK side dispatches RPC commands; verify at impl time)* | Add `clear_queue` handler returning `agentSession.clearQueue()`. |
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

### 6.1 The SDK passthrough may not exist yet

Risk: the bridge's RPC surface routes named commands to the SDK; if `clear_queue` is not already a recognised command, adding it requires touching both Bobbit's bridge layer and the agent-side dispatch table. If the agent-side dispatch table lives inside the SDK package (read-only `node_modules`), we cannot add `clear_queue` directly.

**Mitigation A (preferred):** confirm at implementation time that the bridge's command-handler shim (the per-agent script Bobbit launches) is project-owned (it is — `dist/agent/...` is built from `src/agent/` in this repo). Add the `clear_queue` handler there, calling the SDK's existing `agentSession.clearQueue()` (which IS public on the SDK class).

**Mitigation B (fallback):** Bobbit-side **shadow ledger** — a `Map<sessionId, string[]>` populated in `_dispatchSteer` immediately *before* `rpcClient.steer()` resolves, drained in `_reconcileAfterAbort`, and consumed (entry removed) on `message_start(user)` echo by exact-text match. Lifetime is strictly between dispatch and echo — orders of magnitude smaller than today's full parallel queue. The text-match logic mirrors what the SDK already does internally (line 273 of `agent-session.js`).

We pick A unless the impl-time investigation surfaces a blocker.

### 6.2 The `clearQueue()` race window

Even with Mitigation A, there is a small window: between Bobbit calling `rpcClient.steer()` and the SDK pushing onto `_steeringMessages` (synchronous in the SDK), a hard process kill could lose the in-flight call. Two reasons this is acceptable:

- The SDK push is synchronous (`agent-session.js` line 891: `this._steeringMessages.push(text)` runs before `await this.agent.steer(...)`). The window is "RPC frame in transit, SDK hasn't received yet."
- Today's bug is far worse: re-arming on `wasAborting` even when the message DID land. The new model loses messages only when the bridge socket is severed mid-RPC, which already manifests as a separate failure (RPC error → caller sees rejection → existing error-handling re-enqueues at front per `_dispatchSteer`'s catch block).

### 6.3 Order of work

The goal spec mandates atomic landing, but the *test ordering* matters:

1. Land the 5 P0 tests (§6.1–6.5) against current `master`. Expect §6.5 (exactly-once) and §6.1 (reconnect) to fail; §6.2/§6.3/§6.4 may pass coincidentally. Documented baseline.
2. Rewrite `mock-agent-core.mjs` to emit production-shape `message_start/end(user)` for steered text instead of `[STEER_RECEIVED]`. Update consuming tests to match. CI green.
3. Atomic commit: `PromptQueue` simplification + `SessionManager` consolidation + bridge `clearQueue` passthrough + reconciliation calls. P0 tests now all pass.

## 7. Out of scope

- Switching SDK steering mode from `one-at-a-time` → `all` (UX preference, unrelated).
- Live-steer image attachments (audit §6.6, P1, separate goal).
- Skill expansion in steered messages (audit §6.7, P1).
- Sandboxed-agent steer flow (audit §6.14, P2 — needs Docker integration tests).

## 8. Open questions for reviewer

1. **Sent-indicator UX**: should we drop the pill entirely (preferred — simpler, no extra state) or keep an ephemeral `inFlightSteerTexts` set for visual feedback during the dispatch→echo window? The audit §6.4 P0 test currently asserts on the pill disappearing; if we drop the pill, we rephrase to "row count → 0".
2. **Image attachments on live-steer**: out of scope per goal spec, but `_dispatchSteer` currently joins by text only. Confirm no regression for non-image steers. (Audit §6.6 covers the missing image path.)
3. **Bridge command name**: `clear_queue` vs `drain_steering_queue`. The SDK method is `clearQueue` and clears both queues — `clear_queue` is the honest name. Bobbit only re-enqueues `steering[]`, but draining `followUp[]` too is harmless (we don't expose followUp at our layer).

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
- **`SessionManager`** (`src/server/agent/session-manager.ts`): single dispatch site `_dispatchSteer()` removes rows from `promptQueue` *before* awaiting `rpcClient.steer()`. `deliverLiveSteer`, streaming `steerQueued` promotions, and defensive `tool_execution_end` / `agent_end` boundary flushes all funnel through it. While streaming, `steerQueued` dequeues the steered front group and immediately calls `_dispatchSteer()`; idle promotions drain normally. `bgProcessManager.abortAllWaits()` for steer delivery is owned by `_dispatchSteer()`, so wait abort/recovery is shared by fresh live steers and queued promotions.
- **Shadow ledger** (`SessionInfo.inFlightSteerTexts: string[]`): mitigation B from §6.1 — chosen because pi-coding-agent's RPC bridge surface does not expose `agentSession.clearQueue()` and the agent-side dispatch table lives inside `node_modules/@earendil-works/pi-coding-agent`. Push on `_dispatchSteer` post-RPC; splice on `message_end(role:user)` matching by text in `_consumeSteerEcho`; drain in `_reconcileAfterAbort` (re-enqueue at front of `promptQueue` via `enqueueAtFront`).
- **Reconciliation on abort**: `_reconcileAfterAbort()` runs in two places — `handleAgentLifecycle`'s `agent_end while wasAborting` branch (graceful) and `forceAbort` *before* `rpcClient.stop()` (force-kill). Either way the SDK's pending steers are pulled back into Bobbit's queue and redispatched exactly once after the agent is ready.
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

- **Mitigation B was used, not A.** §6.1 expected we could add a `clear_queue` passthrough to the bridge command-handler shim. At implementation time the shim turned out to live inside the SDK package (read-only `node_modules`), so the destructive drain was implemented Bobbit-side via the shadow ledger — mirroring the SDK's text-match removal logic at our layer. Lifetime is strictly between dispatch and echo, exactly as designed in mitigation B.
- **Sent-indicator pill** was kept (not dropped per §3.7's preferred option). Audit §6.4's P0 test asserts on its disappearance within 2 s; the simplest path was to keep the existing UI and let row-removal drive it.
- **`forceAbort` reconciliation order**: design §3.5 calls `_reconcileAfterAbort` before kill in the early phase. Implementation calls it after `session.unsubscribe()` + `await session.rpcClient.stop()`, between bridge teardown and respawn — the SDK mirror is in-process state and is gone with the bridge, so the ledger (Bobbit-owned) is what we drain regardless. The race window described in §6.2 is unchanged.

### Where to look next

- Steer architecture, shadow-ledger lifecycle, and force-kill recovery: [docs/prompt-queue.md — Abort and force-kill recovery](../prompt-queue.md#abort-and-force-kill-recovery).
- Live-steer call-site map and the `_dispatchSteer()`-owned wait abort path: [docs/internals.md — Steer-interruptible bash_bg wait](../internals.md#steer-interruptible-bash_bg-wait).
- Debugging duplicate-on-Stop, lost-after-abort, and reconnect mid-steer scenarios: [docs/debugging.md — Abort, steer & queue](../debugging.md#abort-steer--queue).
