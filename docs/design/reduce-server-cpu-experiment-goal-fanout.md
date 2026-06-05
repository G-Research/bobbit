# Reduce Server CPU — goal WebSocket fanout experiment

## Decision

Kept. The change narrows `broadcastToGoal()` to matching goal-session sockets plus explicit `/ws/viewer` dashboard sockets. Regular unrelated session sockets no longer receive gate/team/goal broadcasts.

Process-level CPU was noisy, but the representative fanout run showed a meaningful reduction in gateway work on the targeted path: recipient sends dropped 58%, WS bytes dropped 61%, and `broadcastToGoal` send-loop time dropped about 43%. A dedicated E2E test now pins the recipient contract.

## Shared baseline and experiment commits

| Field | Value |
|---|---|
| Shared baseline document | `docs/design/reduce-server-cpu-baseline.md` |
| Shared baseline commit | `3f69494054a1f53d9fafdbc5ed9cad72e3caa831` |
| Goal-fanout workload/base commit | `7da138f0e5f2ef57feb2d317a6c946277d867c72` |
| Candidate production commit | `dd4c6308388f67dd260244b3d5c30c1eeaf8f147` |
| OS | Windows_NT 10.0.26200, x64 |
| Node | v24.13.1 |
| CPU cores | 24 |
| Diagnostics | `BOBBIT_CPU_DIAG=1`, `BOBBIT_E2E_PROFILE=1`, `BOBBIT_TIMING_LOG=1` via harness |

Raw JSONL artifacts were generated under `artifacts/cpu/` and are not committed.

## Hypothesis

`broadcastToGoal()` was intended to send goal events to matching goal sessions and dashboard viewers. In practice, active session WebSockets were not tagged with `sessionId`, and `/ws/viewer` sockets were not explicitly tagged. The fallback therefore sent gate/team events to every authenticated socket without a known goal, including unrelated regular session tabs.

## Implementation

- `src/server/ws/handler.ts`
  - Tags `/ws/viewer` sockets with `isViewer`.
  - Tags active session sockets with `sessionId` during auth.
- `src/server/server.ts`
  - Sends goal broadcasts only to sessions whose `goalId` or `teamGoalId` matches, plus `isViewer` sockets.
  - Skips regular non-goal sessions and records diagnostic counters for matched goal, viewer, fallback, and skipped non-goal session counts.
- `scripts/bench-server-cpu.mjs`
  - Adds `goal-fanout`: one viewer socket, one matching goal-session socket, five unrelated session sockets, team spawn events, repeated gate signals, and goal polling.

## Benchmark commands

```bash
npm run build:server

GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no \
  node scripts/bench-server-cpu.mjs --workload goal-fanout --tabs 5 --agents 3 --duration 10 --runs 3 --out artifacts/cpu/goal-fanout-before.jsonl

GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no \
  node scripts/bench-server-cpu.mjs --workload goal-fanout --tabs 5 --agents 3 --duration 10 --runs 3 --out artifacts/cpu/goal-fanout-after.jsonl

GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no \
  node scripts/bench-server-cpu.mjs --workload goal-fanout --tabs 5 --agents 3 --duration 10 --runs 3 --out artifacts/cpu/goal-fanout-after-rerun.jsonl
```

Regression context:

```bash
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no \
  node scripts/bench-server-cpu.mjs --workload multi-tabs --duration 10 --runs 3 --out artifacts/cpu/fanout-multi-tabs-after.jsonl
```

## Aggregate results

| Workload | Source | Runs | Median CPU % | p95 EL delay ms | REST p95 ms | WS frames/sec | WS recipient-sends/sec | WS bytes/sec | Decision |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `goal-fanout` | before | 3 | 9.30 | 68.420 | 217.271 | 23.8 | 38.0 | 6,426.2 | Baseline |
| `goal-fanout` | after | 3 | 7.79 | 113.902 | 351.359 | 23.8 | 15.8 | 2,498.8 | Keep for targeted WS reduction; process latency noisy |
| `goal-fanout` | after rerun | 3 | 12.23 | 213.778 | 619.180 | 21.8 | 13.9 | 2,189.7 | Confirms recipient/bytes reduction; CPU noisy |
| `multi-tabs` | shared baseline | 3 | 1.585 | 34.898 | 11.601 | 4.4 | n/a | 17,105.9 | Context |
| `multi-tabs` | after | 3 | 1.54 | 58.393 | 14.459 | 4.4 | 4.4 | 16,888.5 | No CPU regression; latency noisy |

Primary `goal-fanout` deltas, after vs before:

- Median CPU: 9.30% → 7.79% (`-16.2%`).
- WS recipient-sends/sec: 38.0 → 15.8 (`-58.4%`).
- WS bytes/sec: 6,426.2 → 2,498.8 (`-61.1%`).
- Unrelated session goal events: 225/run → 0/run.

## Targeted broadcast counters

Representative same-shape runs with 42 `broadcastToGoal` frames:

| Run | Goal broadcast recipients | Matched goal | Viewer | Fallback | Skipped non-goal sessions | Goal WS bytes | Send-loop ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Before run 2 | 294 | 0 | 0 | 294 | 0 | 53,312 | 15.83 |
| Before run 3 | 294 | 0 | 0 | 294 | 0 | 53,382 | 14.88 |
| After run 2 | 84 | 42 | 42 | 0 | 210 | 15,208 | 8.23 |
| After run 3 | 84 | 42 | 42 | 0 | 210 | 15,228 | 8.84 |

This shows the intended classification: each goal event reaches exactly the matching goal-session socket and the viewer socket, while five unrelated session sockets are skipped.

## Functional verification

- `npm run check` — passed.
- `npm run test:unit` — passed.
- `npx tsx --test --test-force-exit tests/bench-server-cpu.test.ts` — passed.
- `npx playwright test --config playwright-e2e.config.ts tests/e2e/goal-fanout-ws.spec.ts tests/e2e/gate-status-cache-ws.spec.ts tests/e2e/gate-resign-cancel.spec.ts` — passed.
- `npm run build:server` — passed before benchmark runs.

The new E2E test proves a viewer socket and matching goal session receive `gate_signal_received`/`gate_status_changed`, while an unrelated regular session receives no goal broadcast. Existing gate WS tests were updated to attach matching goal-session sockets instead of relying on the removed fallback.

Full E2E notes: `npm run test:e2e` failed twice before test execution with a Windows file-access error from the script's redirected build command. Running `npx playwright test --config playwright-e2e.config.ts` directly completed but, before updating the legacy gate specs, reported the expected old-fallback failures plus unrelated failures in `verification-timeout.spec.ts` and `dynamic-chat-tabs.spec.ts`. The affected gate specs passed after the update using the targeted command above.

## Notes and follow-up

- The process-level CPU samples were noisy because this short workload includes setup, team spawn, and gate signal REST work. The targeted WS counters were stable across runs and directly attributable to the fanout change.
- The after rerun confirmed recipient and byte reductions but not process-level CPU reduction. Final PR reporting should treat gateway CPU as noisy for this experiment and rely on targeted send-loop counters for attribution.
- No session-manager code was touched.
