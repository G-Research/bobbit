# Reduce Server CPU — Session and WebSocket Research

**Scope:** read-only review of `src/server/agent/session-manager.ts`, `src/server/ws/`, `src/server/server.ts` broadcast helpers, and related docs/tests.

**Evidence status:** static code review only. This report identifies plausible CPU hot paths and the measurements needed before changing behavior.

## Current path map

- Per-session live agent events use `session-manager.ts:369` `broadcast()` via `emitSessionEvent()` at `session-manager.ts:420`. The helper stringifies once per frame, checks `bufferedAmount`, then sends to every client in `session.clients`.
- Status transitions use `broadcastStatus()` in `session-status.ts`; heartbeat re-emits status every 15s from `session-manager.ts:698`, started in the constructor at `session-manager.ts:741`.
- WebSocket auth/attach lives in `ws/handler.ts`. On attach, sessions with a non-empty `EventBuffer` trigger an async `rpcClient.getState()` at `ws/handler.ts:303`; explicit `get_state` and `resume` are handled at `ws/handler.ts:642` and `ws/handler.ts:796`.
- Goal/project/global broadcasts are local helpers in `server.ts`: `broadcastToGoal()` at `server.ts:951`, `broadcastToAll()` at `server.ts:973`, `broadcastToProject()` at `server.ts:987`, and `broadcastToSession()` at `server.ts:1056`.
- Goal verification emits many `gate_verification_*` events through `broadcastToGoal`; verification output events can be high-volume when command steps produce logs.

## Ranked hypotheses

### H1 — Goal broadcasts may fan out to unrelated session sockets

`broadcastToGoal()` iterates every authenticated `wss.clients` entry. If a socket has a `sessionId` but that session has no `teamGoalId`/`goalId`, it falls through to the fallback send intended for dashboard/viewer clients. That means goal events can be sent to regular non-goal session tabs, not only `/ws/viewer` dashboard sockets.

Why this matters:
- Cost is `O(total WS clients × goal event count)` for matching plus sends.
- Verification events can be bursty, especially `gate_verification_step_output`.
- It also creates unnecessary client-side parse/reducer work.

Evidence to collect:
- Per `broadcastToGoal` event type: scanned clients, matched goal recipients, viewer recipients, fallback non-goal-session recipients, skipped recipients, bytes, stringify/send-loop duration.
- Workload: one active goal/team with 3–5 agents, plus several unrelated open session tabs.

Candidate optimization if confirmed:
- Mark `/ws/viewer` sockets explicitly and narrow fallback delivery to viewer/dashboard sockets, not arbitrary session sockets with no goal.
- If dashboards need goal-specific subscription, add an explicit viewer goal/project subscription rather than broad fallback.
- Preserve gate/verification UI behavior with E2E coverage.

### H2 — Status heartbeat scans all sessions every 15s

`_emitStatusHeartbeat()` loops over `this.sessions.values()` every 15s and sends `session_status` to sessions with connected clients. This is correct for self-healing status drift, but idle/no-agent workloads with many restored sessions still pay the scan cost.

Evidence to collect:
- Heartbeat tick duration, total sessions scanned, sessions with clients, frames sent, bytes sent.
- Idle server/no agents and multiple open sessions/tabs workloads.

Candidate optimization if confirmed:
- Maintain a small `Set` of sessions with connected clients in `addClient()`/`removeClient()` and heartbeat only that set.
- Optionally start the timer only while the set is non-empty.
- Do not remove the heartbeat or bump `statusVersion` on heartbeat.

### H3 — High-frequency agent events can dominate stringify/send CPU

Every agent event is truncated, pushed to `EventBuffer`, JSON-stringified, and sent to all attached clients. This is necessary for streaming fidelity, but `message_update`/delta-heavy turns can produce dozens of frames per second.

Evidence to collect:
- Event count by `event.data.type`, serialized byte count, stringify time, send-loop time, client count, `bufferedAmount` histogram.
- Workloads: active chat/session streaming, high tool-output bursts, multiple tabs on same session.

Candidate optimization if confirmed:
- Coalesce only replaceable progress/update frames (for example `message_update`) on a short frame budget such as 16–50ms, while sending `message_end`, tool lifecycle, permission, status, and queue frames immediately.
- Sequence only emitted frames; do not create holes in `EventBuffer` seq.
- Prove live DOM still converges to post-refresh DOM.

### H4 — Attach/reconnect snapshot storms can duplicate RPC work

On every authenticated attach to a live session with buffered events, `ws/handler.ts` fires a `getState()` RPC. The client also has reconnect paths that request messages/state. Multiple tabs reconnecting after a server restart or dev-harness bounce can produce redundant RPCs against the same agent.

Evidence to collect:
- Per session: WS attach count, proactive `getState()` count/duration, explicit `get_state` count/duration, `get_messages` count/duration, concurrent duplicate calls, response bytes.
- Workload: multiple tabs reconnecting to the same session during/after streaming.

Candidate optimization if confirmed:
- Add short-lived per-session single-flight/cache for attach-time state snapshots.
- Consider removing or gating proactive `getState()` if the client reliably requests it, but preserve model/context-bar reconnect behavior.

### H5 — Resume replay can block the event loop on large missed tails

`resume` replays every retained event with one `send()` per entry. A reconnect that missed hundreds of events can synchronously serialize/send a large tail.

Evidence to collect:
- `resume` count, `fromSeq`, replayed frame count, bytes, duration, max `bufferedAmount` before/after.

Candidate optimization if confirmed:
- Chunk/yield replay after N frames or M bytes.
- Reuse the pacing/backpressure pattern from `replay-pacing.ts` if live replay shows stalls.

### H6 — Global/project broadcast helpers lack shared backpressure instrumentation

`server.ts` broadcast helpers and `ws/handler.ts` local `broadcast()`/`send()` check `readyState` but do not use the overflow guard used by `session-manager.ts` live event broadcast. Most frames are low-frequency, but proposal/state/message snapshots can be large.

Evidence to collect:
- Bytes and send-loop durations for `broadcastToAll`, `broadcastToProject`, `broadcastToSession`, and `ws/handler` local broadcasts.
- Slow-client `bufferedAmount` before send.

Candidate optimization if confirmed:
- Factor a shared env-instrumented send helper first.
- Only add overflow handling to these paths if measurements show real buffered send pressure.

## Lower-priority observations

- `perMessageDeflate` is already disabled in `server.ts`, avoiding zlib CPU for bursty local JSON frames.
- Per-session `broadcast()` already stringifies once per frame, not once per client.
- Search index progress is already debounced to 500ms per project before `broadcastToProject()`.
- `EventBuffer` is bounded at 1000 entries and has unit coverage for seq/window behavior.
- `trackCostFromEvent()` only runs on assistant `message_end`, so it is unlikely to be a streaming-frequency hot path unless task/project scans become expensive in large installs.

## Instrumentation proposal

Keep diagnostics env-gated and near-zero overhead when disabled. Suggested counters/timers:

| Label | Fields |
|---|---|
| `ws.broadcast.session` | `sessionId`, `type`, `clients`, `bytes`, `stringifyMs`, `sendMs`, `bufferedWarns`, `overflowDefers` |
| `ws.broadcast.goal` | `goalId`, `type`, `clientsScanned`, `sentGoal`, `sentViewer`, `sentFallbackNoGoal`, `skipped`, `bytes`, `durationMs` |
| `ws.broadcast.all/project/session` | `type`, recipient/scanned counts, bytes, durationMs |
| `ws.statusHeartbeat` | sessions scanned, sessions with clients, frames, bytes, durationMs |
| `ws.attachSnapshot` | sessionId, attach count, proactive getState duration/bytes, duplicate in-flight state calls |
| `ws.resume` | sessionId, fromSeq, replayed, bytes, durationMs |
| `agent.eventIngress` | sessionId, event type, serialized bytes, clients, eventBuffer size |

Normalize results by workload duration and connected-client count. The most useful derived metrics are frames/sec, bytes/sec, recipient-sends/sec, and total broadcast CPU time per minute.

## Invariants and tests to preserve

- Status correctness: `session_status` carries monotonic `statusVersion`; heartbeat reuses the same version. Covered by `tests/session-manager-status.test.ts` and `docs/design/unify-session-status.md`.
- Streaming resume/dedup: `event` frames keep monotonic per-session `seq`; replay never creates holes or goes backward. Covered by `tests/event-buffer.test.ts`, `tests/restart-preserves-streaming-frame.test.ts`, `tests/sandbox-recovery-respawn-helper.test.ts`, and `tests/manual-integration/sandbox-recovery-frame-continuity.spec.ts`.
- Pending tool permission seq reuse: late joiners must replay the original `seq`/`ts`, not allocate a new frame. Covered by `tests/perm-frame-late-joiner-seq-gap.test.ts` and `tests/remote-agent-sequence-hole.spec.ts`.
- Abort/queue/status UX: aborting/idle/streaming transitions and queue broadcasts must remain immediate. Covered by `tests/e2e/abort-status-e2e.spec.ts` and `tests/e2e/queue-e2e.spec.ts`.
- Goal/gate WS behavior: `gate_signal_received`, verification progress, and `gate_status_changed` ordering/fanout must remain intact. Covered by `tests/e2e/gate-status-cache-ws.spec.ts`, `tests/e2e/verification-core.spec.ts`, and `tests/e2e/gate-verification-resume.spec.ts`.
- Reconnect/model snapshots: archived and reconnect state frames must still include model/status data. Covered by `tests/e2e/archived-footer-model.spec.ts` and `tests/e2e/context-bar-reconnect.spec.ts`.
- Backpressure behavior: overflow decisions and replay pacing should remain non-flaky. Covered by `tests/ws-overflow-guard.test.ts` and `tests/replay-pacing.test.ts`.

## Recommended experiment order

1. Add env-gated broadcast/session heartbeat instrumentation only.
2. Run baseline workloads: idle/no agents, one active streaming session, same session in multiple tabs, goal/team verification activity, and an E2E-like burst.
3. If H1 is confirmed, narrow `broadcastToGoal` fallback first; it has the best chance of reducing both server and client work without touching streaming semantics.
4. If idle CPU remains high, optimize heartbeat scanning via a connected-session set.
5. Only consider event coalescing after measuring event-type counts and proving it targets replaceable update frames.
