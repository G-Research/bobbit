# Reduce Server CPU — status heartbeat experiment

Date: 2026-05-19
Task: `30bb4f6a-ba42-4951-82d2-b60550c7a720`
Branch: `goal-goal-reduce-ser-ee4ca59c-coder-3d0fef46`
Base SHA before this experiment: `f9078889f0d0b8055a7d30ed917a9f1498792caf`

## Hypothesis

`SessionManager._emitStatusHeartbeat()` scanned every in-memory session every 15s, even though it only sends to sessions with connected WebSocket clients. For many restored/idle sessions and few open tabs, maintaining a connected-session set should make heartbeat work proportional to active viewers instead of total sessions.

## Workload

Ad hoc targeted benchmark, separate from the full harness, using the real `SessionManager` heartbeat path:

- 50,000 in-memory restored/idle session objects.
- 1 attached WebSocket-shaped client via `SessionManager.addClient("s0", client)`.
- `BOBBIT_CPU_DIAG=1` with 1s flushes.
- Waited 15.5s so one real heartbeat interval fired.
- Then invoked `_emitStatusHeartbeat()` 50 additional times to reduce timer-duration noise.
- Gateway/test process only; no agent, browser, Docker, or git child work.

Environment: Windows_NT 10.0.26200 x64, Node `v24.13.1`, 24 CPU cores.

Command shape used before and after the change:

```bash
BOBBIT_DIR=<tmp> BOBBIT_CPU_DIAG=1 BOBBIT_CPU_DIAG_JSONL=<tmp>/diag.jsonl BOBBIT_CPU_DIAG_FLUSH_MS=1000 \
  npx tsx .bobbit/tmp-heartbeat-bench.ts
```

The temporary script created 50,000 sessions, attached one client with `addClient`, waited one heartbeat interval, ran 50 manual heartbeat ticks, flushed diagnostics, then deleted the temp file/artifacts.

## Results

| Variant | Sessions | Connected clients | Heartbeat ticks | Sessions scanned | Frames sent | Total heartbeat timer ms | p50 tick ms | p95 tick ms | Manual-loop CPU ms | Functional result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Before | 50,000 | 1 | 51 | 2,550,000 | 51 | 133.424 | 1.856 | 6.601 | 187 user / 0 system | 51 unchanged `session_status` frames |
| After | 50,000 | 1 | 51 | 51 | 51 | 7.538 | 0.013 | 0.065 | 0 user / 0 system | 51 unchanged `session_status` frames |

Normalized improvement:

- Scan work: 2,550,000 → 51 candidates (`~99.998%` fewer scanned sessions).
- p50 tick duration: 1.856ms → 0.013ms (`~99.3%` lower).
- p95 tick duration: 6.601ms → 0.065ms (`~99.0%` lower).
- Manual-loop elapsed wall time: 132.329ms → 1.631ms (`~98.8%` lower).

## Implementation kept

Kept the optimization because the targeted workload shows a large, attributable heartbeat reduction with unchanged frame semantics.

Changes:

- Added `sessionsWithConnectedClients: Set<SessionInfo>` in `src/server/agent/session-manager.ts`.
- `addClient()` adds a non-terminated session to the set.
- `removeClient()` removes/prunes when the last client disconnects.
- `_emitStatusHeartbeat()` iterates only the connected-session set and prunes stale, terminated, removed, or no-client entries.
- Respawn/restore, external unregister, terminate, and shutdown paths untrack replaced/removed sessions.

Semantics preserved:

- Connected clients still receive `session_status` heartbeat frames.
- Heartbeats still do not bump `statusVersion`.
- Terminated sessions are skipped.
- Disconnect removes the session from heartbeat consideration.
- Reconnect re-adds the session.

## Tests

Added focused unit coverage in `tests/session-manager-heartbeat.test.ts` for:

- connected-session tracking and unchanged heartbeat `statusVersion`,
- disconnect removal,
- terminated-session pruning,
- reconnect re-add.

Verification run:

- `npx tsx --test --test-force-exit tests/session-manager-heartbeat.test.ts tests/session-manager-status.test.ts` — passed.
- `npm run check` — passed.
- `npm run test:unit` — passed.
- `npm run build --silent 2>/dev/null && npx playwright test --config playwright-e2e.config.ts tests/e2e/ui/session-status-recovery.spec.ts` — passed.
- `npm run test:e2e` — attempted; suite had one unrelated remaining failure in `tests/e2e/ui/dynamic-chat-tabs.spec.ts:705` after retries, with status/session-recovery coverage passing separately.
