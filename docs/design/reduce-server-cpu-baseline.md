# Reduce Server CPU — baseline benchmark

This is the shared baseline for later CPU-reduction experiments. Compare each experiment against this commit and the same workload commands before deciding whether to keep an optimization.

## Environment

| Field | Value |
|---|---|
| Baseline commit | `3f69494054a1f53d9fafdbc5ed9cad72e3caa831` |
| Generated at | 2026-05-19 |
| OS | Windows_NT 10.0.26200 (`win32`/`x64`) |
| Node | `v24.13.1` |
| CPU cores | 24 |
| Gateway build | `npm run build:server` passed |
| Type check | `npm run check` passed after the benchmark run |
| Diagnostics | `BOBBIT_CPU_DIAG=1`, `BOBBIT_E2E_PROFILE=1`, `BOBBIT_TIMING_LOG=1` via benchmark harness |
| Artifact policy | Raw JSONL artifacts were generated under `artifacts/cpu/` for this run but are not committed. |

Notes:

- `node_modules/` was absent in this worktree, so the first build failed with missing `@types/node`; `npm ci` was run, then `npm run build:server` passed.
- Benchmark commands used `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no` so generated untracked artifact files did not mark the benchmark metadata dirty. The measured source commit is unchanged and all summaries reported `gitDirty: false`.
- All workloads used the harness mock agent where sessions/agents were needed. Metrics below are gateway-process diagnostics from the spawned server, not browser/test-driver CPU.

## Commands

```bash
npm ci
npm run build:server

GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no node scripts/bench-server-cpu.mjs --workload idle --duration 10 --runs 3 --out artifacts/cpu/idle.jsonl
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no node scripts/bench-server-cpu.mjs --workload stream --duration 10 --runs 3 --out artifacts/cpu/stream.jsonl
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no node scripts/bench-server-cpu.mjs --workload multi-tabs --duration 10 --runs 3 --out artifacts/cpu/multi-tabs.jsonl
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no node scripts/bench-server-cpu.mjs --workload goal-team --duration 10 --runs 3 --out artifacts/cpu/goal-team.jsonl
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no node scripts/bench-server-cpu.mjs --workload worktree-pool --duration 10 --runs 3 --out artifacts/cpu/worktree-pool.jsonl

npm run check
```

## Workload definitions

| Workload | Definition |
|---|---|
| `idle` | Spawn gateway, register temp project, keep server idle with health checks for 10s. |
| `stream` | Create 1 session, open one session WebSocket, repeatedly send mock-agent streaming prompts and poll `/api/sessions` for 10s. |
| `multi-tabs` | Create 1 session, open 5 session WebSocket clients plus one viewer socket, send one prompt, poll sessions/goals/projects for 10s. |
| `goal-team` | Create one workflow goal, open viewer and goal observer session sockets, start team, spawn 3 mock agents, signal `design-doc`, and poll goal/team/gate/cost routes for 10s. |
| `worktree-pool` | Use a temporary git project, create 3 goals, poll worktree pool and goal endpoints for 10s. |

## Aggregate baseline results

| Workload | Runs | Successful | Median CPU % | CPU median min/max | p95 event-loop delay ms | REST p95 ms | WS frames/sec | WS bytes/sec |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `idle` | 3 | 3 | 0 | 0 / 1.49 | 32.178 | 16.839 | 0.4 | 0 |
| `stream` | 3 | 3 | 6.21 | 4.655 / 6.925 | 49.742 | 324.367 | 56 | 73446.9 |
| `multi-tabs` | 3 | 3 | 1.585 | 0 / 3.8 | 34.898 | 11.601 | 4.4 | 17105.9 |
| `goal-team` | 3 | 3 | 1.54 | 1.53 / 3.11 | 70.124 | 188.656 | 14.2 | 698.4 |
| `worktree-pool` | 3 | 3 | 3.06 | 1.585 / 3.85 | 32.67 | 127.77 | 1 | 0 |

## Per-run results

### `idle`

| Run | Success | Median CPU % | p95 EL delay ms | REST p95 ms | WS frames/sec | WS bytes/sec | REST requests | WS frames | workloadResult |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | yes | 1.49 | 32.178 | 13.079 | 0.4 | 0 | 3 | 4 | `{ "ok": true, "healthChecks": 1 }` |
| 2 | yes | 0 | 32.08 | 12.041 | 0.4 | 0 | 3 | 4 | `{ "ok": true, "healthChecks": 1 }` |
| 3 | yes | 0 | 32.096 | 16.839 | 0.4 | 0 | 3 | 4 | `{ "ok": true, "healthChecks": 1 }` |

### `stream`

| Run | Success | Median CPU % | p95 EL delay ms | REST p95 ms | WS frames/sec | WS bytes/sec | REST requests | WS frames | workloadResult |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | yes | 6.21 | 32.981 | 324.367 | 55.7 | 72969.1 | 15 | 557 | `{ "ok": true, "sessions": 1, "prompts": 13, "agentEnds": 13, "wsFrames": 336, "wsBytes": 397378 }` |
| 2 | yes | 6.925 | 32.408 | 305.333 | 56 | 73446.9 | 15 | 560 | `{ "ok": true, "sessions": 1, "prompts": 13, "agentEnds": 13, "wsFrames": 335, "wsBytes": 397248 }` |
| 3 | yes | 4.655 | 49.742 | 235.095 | 56.4 | 74140.6 | 15 | 564 | `{ "ok": true, "sessions": 1, "prompts": 13, "agentEnds": 13, "wsFrames": 335, "wsBytes": 397245 }` |

### `multi-tabs`

| Run | Success | Median CPU % | p95 EL delay ms | REST p95 ms | WS frames/sec | WS bytes/sec | REST requests | WS frames | workloadResult |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | yes | 0 | 32.063 | 11.286 | 4.4 | 17105.9 | 33 | 44 | `{ "ok": true, "tabs": 5, "prompts": 1, "polls": 30, "wsFrames": 176, "wsBytes": 93457 }` |
| 2 | yes | 1.585 | 32.096 | 10.441 | 4.4 | 17105.9 | 33 | 44 | `{ "ok": true, "tabs": 5, "prompts": 1, "polls": 30, "wsFrames": 176, "wsBytes": 93457 }` |
| 3 | yes | 3.8 | 34.898 | 11.601 | 4.4 | 17105.9 | 33 | 44 | `{ "ok": true, "tabs": 5, "prompts": 1, "polls": 30, "wsFrames": 176, "wsBytes": 93457 }` |

### `goal-team`

| Run | Success | Median CPU % | p95 EL delay ms | REST p95 ms | WS frames/sec | WS bytes/sec | REST requests | WS frames | workloadResult |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | yes | 3.11 | 59.408 | 188.656 | 14.2 | 698.4 | 72 | 142 | `{ "ok": true, "spawnedAgents": 3, "gateSignaled": true, "polls": 63, "wsFrames": 63, "wsBytes": 9983 }` |
| 2 | yes | 1.54 | 70.124 | 173.251 | 14.2 | 701.6 | 72 | 142 | `{ "ok": true, "spawnedAgents": 3, "gateSignaled": true, "polls": 63, "wsFrames": 63, "wsBytes": 10015 }` |
| 3 | yes | 1.53 | 65.864 | 167.467 | 14.2 | 698.4 | 72 | 142 | `{ "ok": true, "spawnedAgents": 3, "gateSignaled": true, "polls": 63, "wsFrames": 63, "wsBytes": 9983 }` |

### `worktree-pool`

| Run | Success | Median CPU % | p95 EL delay ms | REST p95 ms | WS frames/sec | WS bytes/sec | REST requests | WS frames | workloadResult |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | yes | 1.585 | 32.08 | 72.132 | 1 | 0 | 52 | 10 | `{ "ok": true, "createdGoals": 3, "createErrors": 0, "polls": 47, "lastPoolStatus": { "enabled": true, "ready": 2, "target": 2, "filling": false } }` |
| 2 | yes | 3.85 | 32.588 | 51.725 | 1 | 0 | 52 | 10 | `{ "ok": true, "createdGoals": 3, "createErrors": 0, "polls": 47, "lastPoolStatus": { "enabled": true, "ready": 2, "target": 2, "filling": false } }` |
| 3 | yes | 3.06 | 32.67 | 127.77 | 1 | 0 | 52 | 10 | `{ "ok": true, "createdGoals": 3, "createErrors": 0, "polls": 47, "lastPoolStatus": { "enabled": true, "ready": 2, "target": 2, "filling": false } }` |

## Failures, retries, and reductions

- No benchmark workload failed; each finished `3/3` successful runs with `diagnosticsParseErrors: 0`.
- No workload duration or run count was reduced from the requested short repeatable settings (`--duration 10 --runs 3`).
- No workload was retried. The only setup retry was rebuilding after installing missing dependencies with `npm ci`.

## Baseline observations

- `stream` is the highest median gateway CPU workload in this short run at 6.21%, with the highest WS traffic at 56 frames/sec and 73.4 KB/sec.
- `worktree-pool` has the second-highest median CPU at 3.06% and elevated REST p95 on run 3, while gateway WS bytes remained 0 in diagnostics.
- `goal-team` has modest median CPU but the highest p95 event-loop delay at 70.124 ms and high REST p95 from setup/spawn/signal paths.
- `idle` is effectively 0% median CPU after startup; its WS frames are project index broadcasts with no recipients/bytes.

## E2E-like workload follow-up

The initial shared baseline predates the mixed `e2e-like` workload. Future experiment baselines should include it with the same normalization rules and gateway JSONL attribution used above:

```bash
npm run build:server
node scripts/bench-server-cpu.mjs --workload e2e-like --tabs 5 --agents 3 --duration 10 --runs 3 --out artifacts/cpu/e2e-like.jsonl
```

Smoke run on this implementation branch after `npm run build:server`:

```bash
node scripts/bench-server-cpu.mjs --workload e2e-like --duration 5 --runs 1 --flush-ms 250 --out artifacts/cpu/e2e-like-smoke.jsonl
```

| Workload | Runs | Successful | Median CPU % | p95 event-loop delay ms | REST p95 ms | WS frames/sec | WS bytes/sec | WS recipients/sec | Functional result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `e2e-like` smoke | 1 | 1 | 14.81 | 66.257 | 169.439 | 46.2 | 94383.4 | 98.4 | `prompts=2`, `agentEnds=2`, `gateSignals=2`, `previewMounts=2`, `previewChangedEvents=2`, `polls=88` |

Notes: the smoke summary reported commit `eb9ecfff3542fd6bec58ee00d2cc9cb235f6fcee` with `gitDirty: true` because it ran before committing this task. Raw `artifacts/cpu/` JSONL files were removed and are not committed.
