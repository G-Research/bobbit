# Snapshot ↔ Live-Event Race Fix (H3)

Status: implemented on `goal/fix-snapsh-af9b8672`, two passes (`c2eeeb73`,
`d62fc795`). Companion to [`unified-message-ordering-reducer.md`](./unified-message-ordering-reducer.md)
(which gives the reducer its `_order` invariant), [`streaming-dedup-reorder.md`](./streaming-dedup-reorder.md)
(transport-level seq/ts envelope), and [`perm-frame-late-joiner-seq-replay.md`](./perm-frame-late-joiner-seq-replay.md)
(single-allocation invariant for the `tool_permission_needed` frame's `seq`/`ts`).

---

## 1. User-visible bug

Messages disappear from the chat transcript and only reappear after sending a
follow-up prompt. Intermittent. Most reliably triggered by:

- WebSocket drop and reconnect mid-stream.
- Two-tab visibility resync during a stream — both tabs converge on the same
  missing rows (which is the giveaway: it's not a per-client display glitch,
  the snapshot itself is missing data).

The "fixes itself on send" behaviour is the diagnostic clue: a fresh prompt
triggers a fresh `getMessages` snapshot, by which time the agent's `.jsonl` has
caught up — so the next snapshot does represent the row, and the survivor
filter no longer needs to defend it.

## 2. Big-picture context

Two clocks are involved in producing the transcript a user sees:

1. **Live events** — the agent process streams `message_update` /
   `message_end` / `tool_*` frames over WebSocket as they happen. Each carries
   a monotonically-increasing server `seq`, stamped onto the reducer's
   `_order` field.
2. **Snapshots** — periodically (on reconnect, role switch, compaction, new
   tab, etc.) the client calls `getMessages`. The gateway reads the agent's
   persisted `.jsonl` and returns the canonical transcript. Snapshot rows are
   stamped with negative `_order` (the snapshot floor sentinel).

The agent flushes to `.jsonl` only on `message_end`. So a snapshot taken
mid-turn does NOT contain rows that are still mid-`message_update`. The
client's reducer then has to merge the snapshot (point-in-time, may be stale)
with whatever live rows it already holds (correct, but not yet in the
snapshot's source of truth).

The H3 race lives entirely in this merge.

## 3. Root cause

Two independent failure modes both routed through the snapshot survivor filter
in `src/app/message-reducer.ts` (`case "snapshot"`):

### 3.1 Stale `.jsonl`-backed snapshot drops in-flight rows

The survivor filter's job is "any client row the snapshot doesn't represent
must survive." It compared rows by id-equality first, with fallbacks for
toolCallId equivalence and plain-text equality. None of these defend a row
that the snapshot legitimately doesn't know about — because a real in-flight
`message_update` has a server-assigned id the snapshot can't possibly
represent yet, the survivor logic could classify the live row as "snapshot
authoritative says this id is gone" and strip it.

Worst case: WS drop → reconnect → reducer applies queued `message_end`
(positive `_order`, post-snapshot) → reducer applies snapshot (negative
`_order`, doesn't contain that row because `.jsonl` lags) → row stripped.

### 3.2 Multiset collapse of identical-text rows

Across iterations of a stress test (and in legitimate user transcripts —
think "ok" / "yes" / repeated short replies) multiple distinct assistant
messages can carry identical plain text. The original Set-based plain-text
fallback collapsed N identical-text live rows onto a single snapshot key,
dropping all but one.

### 3.3 Abandoned-partial artifacts

A subtler case discovered in pass 2. When a real LLM streams partial text
and then pivots to a `tool_use` without emitting `message_end` for the text
(the abandoned-partial), or when a mock agent's `omitFinalEnd:true` simulates
the same, the splice fix from pass 1 (see §4.1) injects the partial into
snapshot N. After the server clears `latestMessageUpdate`, snapshot N+1 no
longer contains that partial. The previously-spliced row is now a stale
prior-snapshot artifact (server-origin, negative `_order`), but the survivor
filter's `_order > snapshotMaxOrder` guard scoped to `_order > 0` doesn't
fire for it — so it persists in `state.messages` indefinitely. Two-tab
divergence: the tab that captured the partial keeps it; the other tab
never sees it.

## 4. The fix — four parts

The fix is structural, not mitigative. No new timers, no new actors, no new
state on `OrderedMessage` / `ReducerState` / `SessionInfo` beyond a single
`latestMessageUpdate` slot on `SessionInfo`.

### 4.1 Server-side: splice in-flight `message_update` into snapshots

`SessionInfo.latestMessageUpdate` is set on every `message_update` frame in
`handleAgentLifecycle` (`src/server/agent/session-manager.ts`) and cleared on
`message_end` / `agent_end` / `process_exit`. Pure helper
`spliceInFlightMessage()` (`src/server/agent/splice-inflight-message.ts`) is
called at every snapshot-return site:

- WS `get_messages`
- `refreshAfterCompaction`
- role-switch refresh
- `generateTitleForAnySession`
- `autoGenerateTitle`

The helper either replaces a matching-id row in place or appends. Empty-content
updates are a no-op. The helper has zero session-manager dependencies so unit
tests can import it directly.

This eliminates the convergent-loss case: the gateway already holds the
in-flight payload in memory; splicing it onto the snapshot response means
the snapshot reflects what the user is actually seeing on a healthy tab.

### 4.2 Client reducer: multiset plain-text dedup

`Map<key, count>` instead of `Set<key>`. The snapshot tells the survivor
filter exactly how many rows it represents for each `(role|text)` key; the
filter consumes that count once per matched live row. Surplus rows (count
exhausted) fall through to part 4.3.

### 4.3 Client reducer: `_order > snapshotMaxOrder` survivor guard

The structural invariant. Anything stamped with a positive `_order` that
exceeds the max `_order` in the snapshot is by construction newer than the
snapshot — the `EventBuffer` assigns `seq` monotonically — and must survive
regardless of id state. This is the part that defends WS-drop-and-reconnect
and mid-stream resync.

Scoped to `_order > 0` so the guard does NOT promote prior-snapshot rows
(which carry negative `_order`).

### 4.4 Client reducer: drop prior-snapshot artifacts

A row with `_origin: "server"` and `_order <= 0` that fails every dedup check
in the new snapshot is by definition a stale carry-over from a previous
snapshot. The new snapshot is the authoritative point-in-time read; if it
doesn't represent the row, the row is no longer real. Drop it.

This is the abandoned-partial fix from §3.3 and is the difference between
pass 1 (fixed A and B variations of the repro) and pass 2 (fixed C and D).

## 5. Why this is robust, not racy

- **Reducer is still pure.** No `Date.now()`, no DOM, no `this`. All four
  changes operate on the inputs the reducer already had.
- **Single source of truth preserved.** `state.messages` is still only
  written by `reduce()`. `session.status` is still only written by
  `broadcastStatus()`. The new `latestMessageUpdate` slot is server-side
  bookkeeping for the splice helper, not a parallel transcript.
- **The survivor invariant is structural, not heuristic.** "Anything stamped
  after the snapshot is newer than the snapshot" follows from the seq
  numbering contract. The reducer just respects it.
- **Server splice is purely additive.** The streaming-message slot is data
  the gateway already mirrors (it's what the client's `_state.streamingMessage`
  reflects). Adding it to `getMessages` introduces no new bookkeeping path
  beyond the lifecycle clear.
- **Backwards compatible.** Old clients see the spliced row as a normal
  message. The `_order`-based survivor guard is internal to the client
  reducer.

## 6. What's explicitly out of scope

These are real architectural smells uncovered during the H3 investigation,
but each affects different bugs and is queued as its own focused goal:

- **Heartbeat reconciliation for stuck `session.status`.** When a session
  wedges with a stale cached status, the existing 15s heartbeat re-emits the
  current `session_status` frame but does not reconcile against any
  per-session truth that might disagree. Separate goal.
- **`emitSessionEvent` bypass-site cleanup.** Three call sites in
  `session-manager.ts` and `ws/handler.ts` write events without going
  through the canonical emit path. Not a snapshot/live concern; separate
  cleanup goal.
- **Watchdog / transport timeouts / model HTTP idle timeouts.** Earlier
  drafts of this fix considered them. Rejected — they don't address the
  actual race surface.
- **Reducer fuzz / property-based race testing.** Worth doing later. The H3
  repro spec (see §7) is a sufficient regression test for the specific bug.

## 7. Tests

- **E2E regression**: [`tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts`](../../tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts).
  Four variations × 5 iterations each. Variations:
  - **A** — mid-stream `requestMessages()` during a single-tab stream burst.
  - **B** — control / no resync (always passed).
  - **C** — WS drop + reconnect mid-stream.
  - **D** — two-tab visibility resync during a stream.
  Failed deterministically on master before the fix; passes on the fix
  branch. Variation (C) and (D) wait predicates were tightened in pass 2 to
  count cumulative `STREAM_BURST_DONE` markers rather than regex-test (the
  marker text is identical across iterations, so the prior predicate would
  fire instantly on a stale row).
- **Unit (reducer)**: `tests/message-reducer.test.ts` — H3 `_order`-survivor
  cases, multiset dedup cases, prior-snapshot-artifact-drop case.
- **Unit (server splice)**: `tests/session-manager-getmessages-splice.test.ts`
  — id-match-replace, append, empty-content no-op.

## 8. Touched files

Production:

- `src/app/message-reducer.ts` — multiset dedup, `_order > snapshotMaxOrder`
  survivor guard, `_order <= 0` artifact drop.
- `src/server/agent/session-manager.ts` — `SessionInfo.latestMessageUpdate`
  slot, lifecycle set/clear, splice at every snapshot-return site.
- `src/server/agent/splice-inflight-message.ts` — new pure helper.
- `src/server/ws/handler.ts` — `get_messages` splice site.

Tests:

- `tests/message-reducer.test.ts`
- `tests/session-manager-getmessages-splice.test.ts`
- `tests/e2e/ui/repro-h3-snapshot-live-interleave.spec.ts`

---

## 9. Steer continuity splice (companion fix)

The H3 splice (§4.1) covers in-flight **assistant** `message_update` rows.
A symmetric race exists on the **user** side for steers, and is fixed by an
analogous helper `spliceInFlightSteers()` in the same module.

### 9.1 The race window

`SessionManager._dispatchSteer()` (`src/server/agent/session-manager.ts`) is
ordered as:

1. Push the batch text onto `session.inFlightSteerTexts` (the shadow
   ledger — see [`steer-subsystem-rewrite.md`](./steer-subsystem-rewrite.md)).
2. `session.promptQueue.remove(r.id)` — pending row removed.
3. `broadcastQueue(session, { includeInFlightSteers: true })` — clients are
   told the queue is empty (the pill disappears from the UI), and the store
   persists the queue removal plus ledger entry together.
4. `await session.rpcClient.steer(batchText)` — the SDK echoes the text
   back later as `message_end(role:user)`; the agent only flushes that
   echo to `.jsonl` at that point.

Between step 3 and the echo landing in `.jsonl`, a client snapshot
(`get_messages` from visibility resync, WS reconnect resume-fallback, or a
second tab attaching) reads from `rpcClient.getMessages()` and sees no
queue pill (step 3 cleared it) and no durable user-message row (echo not
yet flushed). The ledger has the text, so the splice helper can keep it
visible until the echo lands.

This is the user-side mirror of §3.1: the `.jsonl` lags real in-process
state, and the snapshot is authoritative about a row the gateway already
knows is coming.

### 9.2 The fix shape

A pure helper alongside `spliceInFlightMessage`:

```
spliceInFlightSteers(messages, session.inFlightSteerTexts) → messages
```

For every ledger entry whose plain text is not already present as a
user-role row in the snapshot, append a synthetic user row with:

- `id: "inflight-steer:<idx>:<text-prefix>"` — stable, content-derived
  so repeated `get_messages` during the same dispatch→echo window
  produce the same synthetic id. Agent-assigned echo ids (uuid-shaped)
  cannot collide with this prefix.
- `role: "user"`, `content: [{ type: "text", text }]`.
- `_inFlightSteer: true` — diagnostic marker, not load-bearing.

The defensive plain-text dedup (snapshot already contains a matching user
row) covers the brief window where the echo has flushed but the ledger
entry hasn't been consumed by `_consumeSteerEcho` yet — no double row.

Wired at every WS-facing snapshot-return site:

- `src/server/ws/handler.ts::case "get_messages"` — the primary path
  (visibility resync, reconnect resume-fallback, multi-tab).
- `src/server/agent/session-manager.ts::refreshAfterCompaction` — so a
  post-compaction broadcast doesn't drop in-flight steers.
- `src/server/agent/session-manager.ts` post-respawn
  `broadcast({type:"messages"})` — same reason, on the respawn path.

Title-generation snapshot reads (`generateTitleForAnySession`,
`autoGenerateTitle`) are deliberately **not** spliced. Title content has
no continuity invariant and we want minimum blast radius.

### 9.3 Interaction with the client reducer

The synthetic row's full lifecycle is handled by the existing reducer
machinery from §4 — no reducer changes are required. Sequence for a
client that polls during the gap and again after the echo:

1. **Snapshot N** during the gap → splice appends a synthetic
   `inflight-steer:*` row. Stamped server-origin with negative `_order`
   like every other snapshot row.
2. **Live `message_end(role:user)` echo** arrives → server-origin row
   with positive `_order` (post-snapshot). Survives via the
   `_order > snapshotMaxOrder` guard from §4.3.
3. **Snapshot N+1** (post-echo, real user row now in `.jsonl`) → the
   multiset plain-text dedup from §4.2 consumes the synthetic row's
   text budget against the real echo row, and the
   `_origin: "server" && _order <= 0` prior-snapshot artifact drop from
   §4.4 sweeps the leftover synthetic.

Net: exactly one user row remains, with the real agent-assigned id.
No reducer code knows or cares that the row was ever synthetic.

### 9.4 Bounded ledger guarantee

`session.inFlightSteerTexts` cannot grow without bound. Every push is
paired with exactly one of:

- **Happy path**: `_consumeSteerEcho()` splices the entry on the
  matching `message_end(role:user)` echo.
- **Abort path**: `_reconcileAfterAbort()` drains the ledger and
  re-enqueues entries at the front of `promptQueue` with
  `isSteered=true` (graceful `agent_end while wasAborting`, or
  `forceAbort` after `rpcClient.stop()`).
- **RPC failure**: `_dispatchSteer` rolls the entry back to the front of
  `promptQueue` and removes the ledger push.

See [`steer-subsystem-rewrite.md`](./steer-subsystem-rewrite.md) for the
full ledger lifecycle. The splice helper consults the ledger; it does
not own it.

### 9.5 Tests

- **Unit (`tests/session-manager-getmessages-splice.test.ts`)** — 8 new
  cases in a `spliceInFlightSteers` describe block: empty/undefined
  ledger no-op; appends synthetic rows with stable position-encoded ids;
  defensive dedup vs already-present user text (array content, string
  content, and `user-with-attachments` role); mixed dedup-and-append
  for partial overlap; non-array messages defensive path.
- **E2E (`tests/e2e/steer-snapshot-continuity.spec.ts`)** — 3 cases:
  (1) `steer_queued`: text always visible in queue OR snapshot across
  dispatch→echo, with a sanity counter that the test polls landed in
  the gap so it can't vacuously pass; (2) direct `{type:"steer"}`: at
  least one snapshot in the gap carries the text; (3) WS reconnect
  mid-gap: reconnected client requesting `get_messages` sees the steer
  text via the splice, and the echo arrives exactly once.
- **Mock instrumentation (`tests/e2e/mock-agent-core.mjs`)** — new
  `MOCK_STEER_ECHO_DELAY_MS` env var parks the mock's steered
  `handlePrompt` for N ms after the steer RPC resolves, widening the
  race window to be reliably observable. Follows the existing
  `MOCK_STEER_QUEUE_DROP` / `MOCK_ABORT_BUSY` instrumentation pattern.

### 9.6 Files touched (steer continuity pass)

Production:

- `src/server/agent/splice-inflight-message.ts` — new `spliceInFlightSteers`
  helper plus `extractUserText` utility.
- `src/server/agent/session-manager.ts` — re-export + 3 splice call sites
  (`refreshAfterCompaction` array/object branches, post-respawn
  `broadcast({type:"messages"})` array/object branches).
- `src/server/ws/handler.ts` — `get_messages` splice site (both array
  and `{messages:[]}` branches).

Tests:

- `tests/session-manager-getmessages-splice.test.ts` (+8 cases).
- `tests/e2e/steer-snapshot-continuity.spec.ts` (new spec, 3 cases).
- `tests/e2e/mock-agent-core.mjs` (instrumentation knob).
