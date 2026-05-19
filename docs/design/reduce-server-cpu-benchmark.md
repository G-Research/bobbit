# Reduce Server CPU — benchmark harness

`scripts/bench-server-cpu.mjs` launches the built gateway in a separate Node process and drives repeatable workloads from a driver process. The gateway receives `BOBBIT_CPU_DIAG=1`, `BOBBIT_CPU_DIAG_JSONL=<run artifact>`, `BOBBIT_E2E_PROFILE=1`, and `BOBBIT_TIMING_LOG=1`, so gateway CPU diagnostics stay isolated from the benchmark driver.

## Commands

```bash
npm run build:server
node scripts/bench-server-cpu.mjs --workload idle --duration 60 --runs 3 --out artifacts/cpu/idle.jsonl
node scripts/bench-server-cpu.mjs --workload stream --sessions 1 --duration 60 --runs 3 --out artifacts/cpu/stream.jsonl
node scripts/bench-server-cpu.mjs --workload multi-tabs --tabs 5 --duration 60 --runs 3 --out artifacts/cpu/multi-tabs.jsonl
node scripts/bench-server-cpu.mjs --workload goal-team --agents 3 --duration 60 --runs 3 --out artifacts/cpu/goal-team.jsonl
node scripts/bench-server-cpu.mjs --workload goal-fanout --tabs 5 --agents 3 --duration 60 --runs 3 --out artifacts/cpu/goal-fanout.jsonl
node scripts/bench-server-cpu.mjs --workload worktree-pool --goals 3 --duration 60 --runs 3 --out artifacts/cpu/worktree-pool.jsonl
```

CI smoke check:

```bash
npm run build:server
node scripts/bench-server-cpu.mjs --smoke --out artifacts/cpu/smoke.jsonl
```

## Artifacts

For `--out artifacts/cpu/idle.jsonl`, the harness writes:

- `artifacts/cpu/idle.jsonl` — benchmark start, per-run summaries, and aggregate summary JSONL.
- `artifacts/cpu/idle.summary.json` — aggregate JSON summary.
- `artifacts/cpu/idle.run-N.gateway.jsonl` — raw gateway diagnostics from `BOBBIT_CPU_DIAG_JSONL`.

Summaries include commit SHA, dirty flag, Node/OS/core metadata, workload options, median CPU%, p95 event-loop delay, REST p95, WS frames/sec, WS recipient-sends/sec, and WS bytes/sec when the CPU diagnostics module emits those fields.

`goal-fanout` creates a workflow goal, one `/ws/viewer` dashboard socket, one matching goal-session socket, and `--tabs` unrelated regular session sockets. It starts/spawns a small team, repeatedly signals `design-doc`, polls goal/team/gate endpoints, and reports viewer, goal-session, and unrelated-session goal-event counts.
