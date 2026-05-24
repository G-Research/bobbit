# Reduce Server CPU — rejected dashboard polling experiment

This report records the rejected dashboard/API polling experiment for H5 from the CPU reduction design. No dashboard polling optimization was kept because the attempted candidate did not contain a production diff, making the benchmark movement unattributable, and the goal/team workload regressed.

## Hypothesis

Dashboard and global API polling might be wasting gateway CPU through high-frequency REST work and repeated full payloads, especially:

- unconditional `GET /api/projects` in global refresh polling;
- full `GET /api/goals/:id/gates` payloads for dashboard/sidebar freshness;
- dashboard team/task/gate/cost pollers continuing at fixed cadence.

The candidate ideas were projects-generation support, gate-summary polling, visibility-gated dashboard pollers, or slower fallback polling when WebSocket events are healthy. The attempted investigation branch did not implement any of these production changes.

## Commands

The experiment used the shared benchmark harness and compared against the baseline in [reduce-server-cpu-baseline.md](reduce-server-cpu-baseline.md). The representative commands were:

```bash
npm run build:server

GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no \
  node scripts/bench-server-cpu.mjs --workload multi-tabs --duration 10 --runs 3 --out artifacts/cpu/dashboard-polling-multi-tabs.jsonl

GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no \
  node scripts/bench-server-cpu.mjs --workload goal-team --duration 10 --runs 3 --out artifacts/cpu/dashboard-polling-goal-team.jsonl

GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no \
  node scripts/bench-server-cpu.mjs --workload goal-team --duration 10 --runs 3 --out artifacts/cpu/dashboard-polling-goal-team-rerun.jsonl
```

The same workload definitions, mock-agent approach, and gateway-process diagnostics rules as the shared baseline apply.

## Results

| Workload | Baseline median CPU % | Candidate median CPU % | CPU delta | Baseline REST p95 ms | Candidate REST p95 ms | REST p95 delta | Decision |
|---|---:|---:|---:|---:|---:|---:|---|
| `multi-tabs` | 1.585 | 0.745 | -53.0% | 11.601 | 15.319 | +32.0% | Reject: CPU movement is unattributable because no production code changed; REST p95 worsened. |
| `goal-team` | 1.540 | 4.640 | +201.3% | 188.656 | 193.566 | +2.6% | Reject: gateway CPU regressed. |
| `goal-team` rerun | 1.540 | 3.925 | +154.9% | 188.656 | 227.849 | +20.8% | Reject: regression reproduced and REST p95 worsened. |

## Rationale

The apparent `multi-tabs` CPU improvement cannot be credited to an optimization because the attempted branch had no production diff. With no code change, the lower CPU result is benchmark noise or environmental variance, not evidence for keeping a change. The same run also increased REST p95, so it does not satisfy the acceptance rule that CPU improvements must not worsen important latency metrics beyond tolerance.

The `goal-team` workload moved in the opposite direction. Median gateway CPU increased from 1.54% to 4.64%, and a rerun still measured 3.925%. REST p95 also worsened on the rerun. Because this workload includes goal dashboard, team, gate, and verification traffic, the regression is directly relevant to the polling hypothesis.

## Rejected-hypothesis notes

- No dashboard/API polling optimization is kept in this PR.
- The experiment does not prove that dashboard polling is cheap; it only proves this attempted investigation produced no attributable improvement.
- Do not use the `multi-tabs` CPU drop as evidence for a polling change unless a future branch contains an actual implementation and repeats the benchmark against the same baseline.
- Revisit H5 only with a concrete, isolated implementation such as `GET /api/projects?since=<generation>` or dashboard gate-summary polling via `GET /api/goals/:id/gates?view=summary`.
- A future retry should include production diffs, route-level request/response-size counters, and before/after results for both `multi-tabs` and `goal-team`.
