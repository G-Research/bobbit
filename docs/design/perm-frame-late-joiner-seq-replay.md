# Perm-Frame Late-Joiner Seq Replay

Companion to [`unified-message-ordering-reducer.md`](./unified-message-ordering-reducer.md)
(reducer `_order` invariant), [`streaming-dedup-reorder.md`](./streaming-dedup-reorder.md)
(seq/ts envelope), and [`snapshot-live-race-fix.md`](./snapshot-live-race-fix.md)
(snapshot ↔ live merge). Same bug-class as #527, #529, and the sandbox-recovery
helper-callsite pin in [`sandbox-recovery-frame-of-reference.md`](./sandbox-recovery-frame-of-reference.md).

---

## 1. User-visible bug

While a tool-permission card is pending, an existing tab's chat stream silently
freezes after the next event from the agent. The stream eventually heals — but
only via the 500-event overflow that forces a `get_messages` snapshot, or via a
`resume_gap` after a WS drop.

Triggered by any second client (or any reconnect) attaching mid-permission:

1. Two tabs attached to the same session.
2. Agent calls a gated tool → server broadcasts `tool_permission_needed` at
   `seq=N` to both tabs.
3. Tab 2 disconnects briefly and reattaches → on-attach branch in
   `ws/handler.ts` re-sends the perm card to the late-joiner.
4. User grants → next live `event` arrives at `seq=N+2`.
5. Tab 1 expected `seq=N+1` next; gets `seq=N+2`; the gap-buffer in
   `_drainOrderedEvents` parks it indefinitely waiting for the missing seq.

## 2. Root cause

The on-attach replay path allocated a **fresh** sequence number from the
shared `EventBuffer` and unicast the perm frame only to the joining socket:

```ts
// pre-fix, src/server/ws/handler.ts
const pendingPerm = sessionManager.getPendingToolPermission(sessionId);
if (pendingPerm) {
    const { seq, ts } = session.eventBuffer.pushFrame();   // burns a global seq
    send(ws, { type: "tool_permission_needed", ...pendingPerm, seq, ts });
}
```

`pushFrame()` increments the *shared* `nextSeq`, but the resulting frame is
sent only to the late-joiner. Every other already-attached client's
`_highestSeq` stayed at the original broadcast's `N`, so the next live event
arrived with a one-step hole. The reducer's gap-buffer cannot tell whether
the missing `seq=N+1` is in flight or lost forever — it just waits.

## 3. Why a fresh seq is structurally wrong

Server-stamped `seq` is a property of the *session-wide* frame stream, not of
any single socket. The invariant the reducer relies on
([`unified-message-ordering-reducer.md`](./unified-message-ordering-reducer.md)):

> Every client attached to a session receives a contiguous prefix of the same
> `seq` stream. A `seq` is never allocated unless it will be broadcast to
> every attached client.

Unicast replays must reuse the original broadcast's `seq` — not allocate a
new one — because the late-joiner is recovering a frame the rest of the room
already saw, not introducing a new one.

Rationale for not dropping `seq` from the unicast path entirely (the rejected
alternative): the `_advanceTopLevelSeq` consumer in `remote-agent.ts` (added
in #527) uses the perm-frame `seq` to order the card relative to live events.
Dropping it would split the contract — sometimes seq, sometimes not — and
re-introduce the kind of "dance unwritten across N callsites" pattern PR #532
just eliminated for sandbox respawn.

## 4. Fix

Stash the original broadcast's `{seq, ts}` on `SessionInfo.pendingGrantRequest`
when `requestToolGrant()` allocates them, expose them via
`getPendingToolPermission()`, and have the on-attach replay path reuse those
values verbatim instead of calling `pushFrame()` again.

Net effect: `EventBuffer.pushFrame()` is now invoked from **exactly one** site
in `src/server/` — the body of `requestToolGrant` in `session-manager.ts`.
Every client (existing + late-joining) sees the same `seq` for the same perm
frame; no gap is introduced into the global sequence space. The client
reducer's existing dedupe logic treats the replay as idempotent — no
double-prompting.

### 4.1 Single-allocation-site invariant

Pinned by `tests/perm-frame-late-joiner-seq-gap.test.ts`:

1. **Structural** — grep-asserts that `EventBuffer.pushFrame()` is called
   from exactly one location in `src/server/` (excluding the definition in
   `event-buffer.ts`). Any future regression that re-introduces a unicast
   `pushFrame()` in `ws/handler.ts` (or anywhere else) fails CI immediately.
   Same shape as `tests/sandbox-recovery-respawn-helper.test.ts`'s
   "all four callsites route through the helper" assertion.
2. **API-shape** — `getPendingToolPermission()`'s return type exposes
   `seq` and `ts`; the on-attach replay path reads them from this method
   rather than allocating fresh.
3. **Behavioural** — simulates two attached clients + one late-joiner
   driving a fake client sequencer that mirrors `_advanceTopLevelSeq` /
   `_drainOrderedEvents` from `remote-agent.ts`; asserts the original
   clients see no gap. Includes a negative-control case that runs the
   pre-fix model and confirms the gap reproduces.

## 5. Why this lives next to the sandbox-recovery and snapshot-race fixes

All three are instances of the same anti-pattern: a small, easy-to-miss
sequence-space accounting mistake at one callsite that breaks an invariant
the rest of the system implicitly relies on. The fix shape is identical:
make the bug class impossible by funnelling all allocation through a
single, named site, and pin that with a structural test. No callsite should
need to "know" the rule — the rule lives in the type system and in the test.

## 6. Affected files

- `src/server/agent/session-manager.ts` — `SessionInfo.pendingGrantRequest`
  carries `seq` + `ts`; `requestToolGrant` is the lone `pushFrame()` caller;
  `PendingToolPermissionSnapshot` is the public return type of
  `getPendingToolPermission()`.
- `src/server/ws/handler.ts` — on-attach replay reuses
  `getPendingToolPermission()`'s `seq`/`ts`; never calls `pushFrame()`.
- `tests/perm-frame-late-joiner-seq-gap.test.ts` — five-pin regression suite.
