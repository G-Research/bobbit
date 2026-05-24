# Reduce Server CPU — stream `message_update` coalescing experiment

## Decision

Rejected. Production code was reverted; this branch keeps only this experiment report.

The candidate was a small per-session 25 ms coalescer for replaceable `message_update` events in `src/server/agent/session-manager.ts`. It queued only the latest pending update, flushed before any non-`message_update` event and cleanup path, and allocated `EventBuffer` seqs only when frames were actually emitted.

## Shared baseline

Baseline source: `docs/design/reduce-server-cpu-baseline.md`.

| Field | Value |
|---|---|
| Baseline commit | `3f69494054a1f53d9fafdbc5ed9cad72e3caa831` |
| Experiment base commit | `3acb128c61a184bd9e0d7764c6ef3b1357a85b32` |
| OS | Windows_NT 10.0.26200, x64 |
| Node | v24.13.1 |
| CPU cores | 24 |
| Diagnostics | `BOBBIT_CPU_DIAG=1`, `BOBBIT_E2E_PROFILE=1`, `BOBBIT_TIMING_LOG=1` via harness |

Raw benchmark JSONL was generated under `artifacts/cpu/` and is not committed, matching the baseline artifact policy. Harness metadata reported `gitDirty: true` because the candidate diff was benchmarked before the final experiment commit.

## Hypothesis

High-frequency streaming `message_update` frames can spend gateway CPU on repeated serialization, buffering, and WebSocket fanout even though only the latest in-flight assistant row is replaceable. Coalescing only `message_update` frames on a short 25 ms budget might reduce CPU during stream-heavy workloads without changing terminal/tool/status/permission/queue event ordering.

## Benchmark commands

```bash
npm run build:server
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no node scripts/bench-server-cpu.mjs --workload stream --duration 10 --runs 3 --out artifacts/cpu/stream-coalesce.jsonl
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=status.showUntrackedFiles GIT_CONFIG_VALUE_0=no node scripts/bench-server-cpu.mjs --workload multi-tabs --duration 10 --runs 3 --out artifacts/cpu/multi-tabs-coalesce.jsonl
```

## Aggregate before/after

| Workload | Metric | Baseline | Candidate | Change |
|---|---:|---:|---:|---:|
| `stream` | Median CPU % | 6.21 | 5.435 | -12.5% |
| `stream` | p95 event-loop delay ms | 49.742 | 37.65 | -24.3% |
| `stream` | REST p95 ms | 324.367 | 264.54 | -18.4% |
| `stream` | WS frames/sec | 56.0 | 56.0 | 0% |
| `stream` | WS bytes/sec | 73,446.9 | 73,446.5 | 0% |
| `multi-tabs` | Median CPU % | 1.585 | 0.745 | -53.0% |
| `multi-tabs` | p95 event-loop delay ms | 34.898 | 32.981 | -5.5% |
| `multi-tabs` | REST p95 ms | 11.601 | 11.832 | +2.0% |
| `multi-tabs` | WS frames/sec | 4.4 | 4.4 | 0% |
| `multi-tabs` | WS bytes/sec | 17,105.9 | 17,105.9 | 0% |

## Candidate per-run results

| Workload | Run | Success | Median CPU % | p95 EL delay ms | REST p95 ms | WS frames/sec | WS bytes/sec | REST req | WS frames |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|
| `stream` | 1 | yes | 10.825 | 37.65 | 264.54 | 55.6 | 72,956.1 | 15 | 556 |
| `stream` | 2 | yes | 4.625 | 34.308 | 215.343 | 56.4 | 74,140.5 | 15 | 564 |
| `stream` | 3 | yes | 5.435 | 32.227 | 202.542 | 56.0 | 73,446.5 | 15 | 560 |
| `multi-tabs` | 1 | yes | 1.49 | 32.932 | 11.832 | 4.4 | 17,105.9 | 33 | 44 |
| `multi-tabs` | 2 | yes | 0.745 | 32.26 | 10.366 | 4.4 | 17,105.9 | 33 | 44 |
| `multi-tabs` | 3 | yes | 0 | 32.981 | 10.917 | 4.4 | 17,105.9 | 33 | 44 |

## Rejection rationale

1. Behavior regressed under browser E2E. `npm run test:e2e` failed `tests/e2e/ui/transcript-fidelity.spec.ts` on all retries for `STREAM_BURST:3 — live DOM equals post-refresh DOM`:

   ```text
   Transcript order mismatch at index 2.
   live:    assistant-message|Proposing stream goal 1 of 3… Goal Proposal Stream Goal 1 Open proposal|71
   refresh: assistant-message|Proposing stream goal 1 of 3… Goal Proposal Stream Goal 1 proposal #1 in stream burst Open proposal|99
   ```

   This indicates the live transcript did not converge with the snapshot after coalescing proposal/tool-call streaming updates. Preserving transcript fidelity is higher priority than CPU reduction.

2. The benchmark CPU result was not attributable enough to keep after the regression. Aggregate WS frames/sec and bytes/sec were unchanged because the harness proposal stream emits deltas around every 60 ms, above the 25 ms coalescing window. That means the measured median CPU movement could be run variance rather than proven reduction from fewer emitted frames.

3. Narrowing coalescing to text-only updates would likely avoid the proposal regression, but the required representative benchmarks use proposal/tool-call updates, so that variant would not have evidence for this PR.

## Verification performed

- `npm run check` — passed while the candidate was present and again after reverting production code.
- `npx tsx --import ./tests/helpers/css-stub-loader.mjs --test --test-force-exit tests/session-manager-message-coalescing.test.ts` — passed while the candidate was present; the test file was removed with the rejected production code.
- `npm run test:unit` — passed while the candidate was present.
- `npm run test:e2e` — failed; see rejection rationale. One additional browser failure (`dynamic-chat-tabs`) also appeared, but the transcript-fidelity failure is directly related to stream coalescing and is sufficient to reject.
