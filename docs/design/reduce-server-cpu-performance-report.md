# Reduce Server CPU — performance report

This report consolidates the CPU-reduction implementation and evidence for PR review. It preserves the detailed research and experiment notes in the sibling `reduce-server-cpu-*.md` documents and summarizes only the decisions needed to review the final branch.

## Summary

Final implementation reviewed at `db490517` keeps:

- env-gated gateway CPU diagnostics and a reproducible benchmark harness;
- status heartbeat scanning proportional to connected sessions instead of all restored sessions;
- scoped goal WebSocket fanout to matching goal sessions and explicitly subscribed dashboard viewer sockets;
- REST response-byte attribution and broader subsystem timers/child-process attribution for future CPU work.

Rejected experiments remain documented and are not in production behavior:

- streaming `message_update` coalescing;
- dashboard/API polling changes.

Raw benchmark JSONL files were generated under `artifacts/cpu/` during the investigation and were intentionally not committed.

## Related detailed docs

- [Baseline benchmark](reduce-server-cpu-baseline.md)
- [Benchmark harness](reduce-server-cpu-benchmark.md)
- [Goal WebSocket fanout experiment](reduce-server-cpu-experiment-goal-fanout.md)
- [Status heartbeat experiment](reduce-server-cpu-experiment-status-heartbeat.md)
- [Rejected stream coalescing experiment](reduce-server-cpu-experiment-stream-coalescing.md)
- [Rejected dashboard polling experiment](reduce-server-cpu-experiment-dashboard-polling.md)
- [Diagnostics research](reduce-server-cpu-diagnostics-research.md)
- [API polling research](reduce-server-cpu-api-polling-research.md)
- [Timer/poller research](reduce-server-cpu-timers-research.md)
- [WebSocket research](reduce-server-cpu-ws-research.md)

## Measurement model

The benchmark harness launches the built gateway in a separate Node process, then drives workloads from a driver process. Gateway metrics come from the gateway process only; browser/test-driver CPU is not mixed into `process.cpuUsage()`.

Enabled diagnostics:

- `BOBBIT_CPU_DIAG=1`
- `BOBBIT_CPU_DIAG_JSONL=<artifact>`
- `BOBBIT_E2E_PROFILE=1`
- `BOBBIT_TIMING_LOG=1`

Primary metrics:

- median gateway CPU percentage, normalized to one core;
- p95 event-loop delay;
- REST p95 duration;
- WS frames/sec, recipient-sends/sec, and bytes/sec;
- workload functional result counters.

Child agent, git, Docker, and benchmark-driver work is either excluded from gateway CPU or attributed separately through child-process/subsystem diagnostics.

## Workload definitions

| Workload | Purpose | Definition |
|---|---|---|
| `idle` | Idle server/no agents | Start the gateway, register a temporary project, and keep it idle with health checks. |
| `stream` | Active chat/session streaming | Create one session, attach a session WebSocket, send repeated mock-agent streaming prompts, and poll sessions. |
| `multi-tabs` | Multiple open sessions/browser tabs | Attach five session WebSockets plus one viewer socket, send one prompt, and poll sessions/goals/projects. |
| `goal-team` | Goal/team workflow activity | Create a workflow goal, start a team, spawn three mock agents, signal `design-doc`, and poll goal/team/gate/cost routes. |
| `goal-fanout` | Targeted goal WS fanout | Open one dashboard viewer socket, one matching goal-session socket, and unrelated session sockets, then drive team/gate events. |
| `worktree-pool` | Worktree pool pressure | Use a temporary git project, create goals, and poll worktree-pool/goal endpoints. |
| `e2e-like` | Manual/E2E-like mixed load | Combine session streaming, multiple session tabs, a viewer socket, preview SSE and mounts, workflow goal/team/gate activity, and dashboard-style REST polling. |

## Shared baseline

Baseline commit: `3f69494054a1f53d9fafdbc5ed9cad72e3caa831`.

Environment: Windows_NT 10.0.26200, Node `v24.13.1`, 24 CPU cores. Each shared baseline workload ran for 10 seconds, three runs, with gateway JSONL diagnostics.

| Workload | Runs | Median CPU % | p95 event-loop delay ms | REST p95 ms | WS frames/sec | WS bytes/sec |
|---|---:|---:|---:|---:|---:|---:|
| `idle` | 3 | 0 | 32.178 | 16.839 | 0.4 | 0 |
| `stream` | 3 | 6.21 | 49.742 | 324.367 | 56.0 | 73,446.9 |
| `multi-tabs` | 3 | 1.585 | 34.898 | 11.601 | 4.4 | 17,105.9 |
| `goal-team` | 3 | 1.540 | 70.124 | 188.656 | 14.2 | 698.4 |
| `worktree-pool` | 3 | 3.060 | 32.670 | 127.770 | 1.0 | 0 |

The shared baseline predates the `goal-fanout` and `e2e-like` workloads. Those were normalized with the same gateway-only diagnostics, run shape, and artifact policy once the harness gained those workloads.

## Accepted optimizations

### Status heartbeat scan

Hypothesis: the session heartbeat scanned every restored session every 15 seconds, even though only sessions with connected WebSocket clients can receive heartbeat frames. Maintaining a connected-session set should make work proportional to active viewers.

Decision: kept.

| Metric | Before | After | Impact |
|---|---:|---:|---:|
| Sessions in benchmark | 50,000 | 50,000 | same workload |
| Connected clients | 1 | 1 | same workload |
| Heartbeat ticks | 51 | 51 | same semantics |
| Sessions scanned | 2,550,000 | 51 | ~99.998% fewer candidates |
| Frames sent | 51 | 51 | unchanged |
| Total heartbeat timer ms | 133.424 | 7.538 | ~94.4% lower |
| p50 tick ms | 1.856 | 0.013 | ~99.3% lower |
| p95 tick ms | 6.601 | 0.065 | ~99.0% lower |
| Manual-loop CPU ms | 187 user / 0 system | 0 user / 0 system | eliminated in this targeted loop |

Functional impact: connected clients still receive unchanged `session_status` heartbeat frames, heartbeats do not bump `statusVersion`, terminated/removed sessions are pruned, and reconnects re-add the session.

Coverage: `tests/session-manager-heartbeat.test.ts`, existing session status tests, type check, unit tests, and targeted session status recovery browser E2E.

### Goal WebSocket fanout

Hypothesis: goal/team/gate events were waking unrelated session sockets because `broadcastToGoal()` treated unscoped sockets as fallback recipients. This made work scale with total authenticated sockets instead of matching goal viewers.

Decision: kept.

| Workload | Variant | Runs | Median CPU % | p95 event-loop delay ms | REST p95 ms | WS recipient-sends/sec | WS bytes/sec | Functional signal |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `goal-fanout` | before | 3 | 9.30 | 68.420 | 217.271 | 38.0 | 6,426.2 | unrelated session goal events present |
| `goal-fanout` | after | 3 | 7.79 | 113.902 | 351.359 | 15.8 | 2,498.8 | unrelated session goal events = 0 |
| `goal-fanout` | after rerun | 3 | 12.23 | 213.778 | 619.180 | 13.9 | 2,189.7 | recipient/byte reduction reproduced |
| `multi-tabs` | shared baseline | 3 | 1.585 | 34.898 | 11.601 | n/a | 17,105.9 | regression context |
| `multi-tabs` | after | 3 | 1.540 | 58.393 | 14.459 | 4.4 | 16,888.5 | no CPU regression |

Primary attributed effect, after vs before:

- WS recipient-sends/sec: 38.0 → 15.8 (`-58.4%`).
- WS bytes/sec: 6,426.2 → 2,498.8 (`-61.1%`).
- `broadcastToGoal` send-loop time in representative same-shape runs: about 15 ms → about 8 ms.
- Unrelated session goal events: 225/run → 0/run.

Process-level CPU and latency were noisy in the short goal/team workload because setup, spawn, and gate REST work share the interval. The keep decision is based on stable targeted counters that directly measure the changed fanout path, plus functional tests that pin the new recipient contract.

Functional impact: matching goal sessions and subscribed dashboard viewers still receive gate/team/goal events; unrelated regular session sockets no longer receive those events.

Coverage: API/WebSocket E2E for goal fanout, browser E2E for the goal dashboard live gate update journey, existing gate status/cache tests, and dynamic chat tab regression coverage.

## Scoped viewer fanout and REST byte attribution

The final branch tightens the retained goal-fanout optimization:

- `/ws/viewer` connections remain authenticated but are explicitly tagged as viewer sockets.
- Viewer sockets subscribe with `subscribe_goal`, can unsubscribe, and can clear subscriptions.
- `broadcastToGoal()` sends only to matching goal-session sockets and viewer sockets subscribed to that goal.
- Viewer sockets still receive project/index broadcasts where needed for search/status views.
- Sandbox-scoped tokens do not gain viewer access because `__viewer__` is outside sandbox session scope.

REST byte attribution was added to the env-gated diagnostics layer:

- API routes are labeled with normalized method/path labels.
- Response `write()`/`end()` are counted to record actual response bytes.
- Diagnostics store byte counts with route timing and status buckets.
- No response bodies or secrets are captured.

Why this matters: the rejected dashboard polling work showed that request count alone is not enough to attribute CPU. Byte counts let future experiments distinguish fewer requests from smaller payloads and less JSON serialization.

## E2E-like benchmark workload

`e2e-like` was added after the initial shared baseline so reviewers can reproduce mixed manual/E2E-style gateway load without attributing browser/test-driver CPU to the gateway.

Command shape:

```bash
npm run build:server
node scripts/bench-server-cpu.mjs --workload e2e-like --tabs 5 --agents 3 --duration 10 --runs 3 --out artifacts/cpu/e2e-like.jsonl
```

Merged-branch smoke result from the implementation gate:

| Workload | Runs | Successful | Median CPU % | p95 event-loop delay ms | REST p95 ms | WS frames/sec | Functional result |
|---|---:|---:|---:|---:|---:|---:|---|
| `e2e-like` smoke | 1 | 1 | 12.345 | 86.639 | 186.103 | 47.2 | `prompts=2`, `agentEnds=2`, gate signals, preview mounts/events, dashboard polling |

The earlier implementation-branch smoke also passed with median CPU 14.81%, p95 event-loop delay 66.257 ms, REST p95 169.439 ms, and WS 46.2 frames/sec. These smoke runs prove the workload is executable and functionally complete; they are not used as a before/after optimization claim because the workload did not exist in the original shared baseline.

## Subsystem diagnostics

The diagnostics module is disabled by default. When disabled, exported recorders are no-op functions and do not allocate per event.

When enabled, each JSONL snapshot includes:

- `process.cpuUsage()` deltas and one-core-normalized CPU percentage;
- event-loop utilization and event-loop delay percentiles;
- memory and best-effort active handle counts;
- REST counts, status buckets, duration percentiles, and response bytes by normalized route;
- WebSocket broadcast counters by helper/event type: frames, scanned clients, recipients, skipped clients, bytes, stringify time, and send time;
- subsystem/timer buckets with duration percentiles and counters;
- child-process buckets for git, Docker, and safe exec paths with metadata.

Instrumented subsystem coverage includes:

- session status heartbeat;
- server WebSocket broadcast helpers and WS attach/get-state/get-messages paths;
- long-poll wait heartbeat;
- search progress flush from server to WS;
- git/native git status, safe exec, worktree setup, worktree pool, and worktree sweeper paths;
- Docker/project sandbox operations and health checks;
- inbox nudger scans and staff trigger scans;
- worktree pool fill/claim/freshen/reclaim/drain activity.

Known remaining attribution gaps from implementation review:

- preview SSE connections and keepalives are exercised by the `e2e-like` workload but are not split into a dedicated preview diagnostics bucket;
- search rebuild/indexer work is only partially attributed through the server progress flush, not through every indexer/rebuild path.

These gaps are measurement follow-ups, not retained CPU optimizations.

## Rejected experiments

| Experiment | Result | Rationale |
|---|---|---|
| Stream `message_update` coalescing | Rejected and reverted | The candidate appeared to reduce `stream` median CPU 6.21% → 5.435%, but WS frames/bytes did not change and browser E2E failed transcript fidelity. Preserving live transcript correctness is mandatory. |
| Dashboard/API polling reduction | Rejected; no production diff kept | The attempted branch had no attributable production change. `multi-tabs` CPU movement was noise, while `goal-team` regressed from 1.54% to 4.64% and reproduced at 3.925% on rerun. |

Future dashboard polling work should start with a concrete isolated implementation, such as projects generation support or gate summary polling, and compare against the same harness with route byte attribution.

## Parallel experiment normalization

The goal split independent hypotheses across agents/branches after the shared baseline and harness were defined:

- diagnostics and benchmark harness implementation;
- baseline capture;
- stream coalescing;
- dashboard polling;
- goal fanout;
- status heartbeat;
- subsystem attribution and `e2e-like` workload follow-ups.

Normalization rules:

- compare against the shared baseline commit and machine metadata when a workload existed in the baseline;
- use the same gateway-only JSONL diagnostics and artifact policy;
- report medians across three 10-second runs for regular workloads;
- keep targeted microbenchmarks only when the hypothesis is narrower than the general harness can isolate, as with heartbeat scanning;
- do not combine experimental changes until each branch has its own measurements and decision;
- treat process-level CPU as supporting evidence when setup/REST work makes it noisy, and require targeted counters for attributed fanout or timer changes.

## Verification

Implementation-gate verification on the merged goal branch:

- `npm run check` — passed.
- `npm run test:unit` — passed.
- `npm run build:server` — passed.
- `npm run build:ui` — passed.
- `npx tsx --test --test-force-exit tests/bench-server-cpu.test.ts tests/subsystem-cpu-attribution.test.ts` — passed.
- `npx playwright test --config playwright-e2e.config.ts tests/e2e/goal-fanout-ws.spec.ts tests/e2e/gate-signal-progress.spec.ts tests/e2e/gate-status-cache-ws.spec.ts tests/e2e/ui/goal-dashboard-fanout.spec.ts tests/e2e/ui/dynamic-chat-tabs.spec.ts --workers=1` — passed, 15 tests.
- `node scripts/bench-server-cpu.mjs --workload e2e-like --duration 5 --runs 1 --flush-ms 250 --out artifacts/cpu/e2e-like-merged-smoke.jsonl` — passed; raw artifact removed before push.

Docs-only verification for this report:

- `npm ci` — passed to install missing local dependencies in this worktree.
- `npm run check` — passed.
