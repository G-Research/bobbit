# Measurement gates 1–4

> **Historical evidence.** These gates measured the retired lane/shard topology. The current unit runner has four direct projects and is documented in [`../unit-gate.md`](../unit-gate.md).

**Date:** 2026-07-15
**Rule:** no full-suite run and no fixture optimization unless the representative, disjoint projection clears its gate.

## Coverage ownership correction

The twelve integration files formerly excluded from `v2-integration` have been restored to the unit gate.

- `v2-integration` no longer excludes the historical `integrationE2eFiles` set.
- The `v2-integration-e2e` project, E2E Group I, `test:e2e:integration`, and the then-current exclusion-list module were removed.
- At measurement time, `run-unit-lanes.mjs` sharded every `tests2/integration/*.test.ts` path; the restored files collected in those unit shards.
- Direct collection proof found all **12/12** restored files under `[v2-integration]`.
- The measured inventory required all **880** merge-base core/DOM/integration files: **880/880 present**, plus three additions and zero E2E exclusions at that point.
- `npm run check`, E2E list without Group I, and `git diff --check` pass.

All earlier 679–685s runs omitted these twelve files. They remain useful contention profiles but are not acceptance evidence.

## Gate 1 — integration session/project lifecycle

### Batch

Eight independent one-worker `v2-integration` processes ran simultaneously for three rounds:

| Assigned lane | File |
|---|---|
| integration-3 | `headquarters-server-scope-guards.test.ts` |
| integration-3 | `cross-project-proposals.test.ts` |
| integration-1 | `staff.test.ts` |
| integration-1 | `sessions-projectless.test.ts` |
| integration-1 | `queue-e2e.test.ts` |
| integration-2 | `tools-e2e.test.ts` |
| integration-2 | `staff-patch-reassign.test.ts` |
| integration-2 | `headquarters-api.test.ts` |

Round walls were **80.53s, 82.37s, and 83.50s**. Every test passed. Every round began and ended with zero matching Vitest/orchestrator processes and ledger `0/24`; cleanup reports had zero uncertain sweeps.

### Per-file timing

“Startup/import” is external process wall minus Vitest file wall. “Hook residual” is file wall minus summed test durations. Gateway creation performed inside a test remains test time rather than residual.

| File | Mean external | Mean file | Mean tests | Startup/import | Hook residual |
|---|---:|---:|---:|---:|---:|
| Headquarters scope guards | 53.822s | 52.304s | 52.303s | 1.518s | 0.001s |
| Cross-project proposals | 64.494s | 32.386s | 29.717s | 32.108s | 2.669s |
| Staff | 65.356s | 33.823s | 33.823s | 31.532s | 0.001s |
| Projectless sessions | 23.479s | 11.489s | 11.489s | 11.991s | 0.000s |
| Queue | 54.569s | 43.870s | 43.869s | 10.699s | 0.001s |
| Tools | 71.805s | 28.671s | 28.621s | 43.134s | 0.049s |
| Staff reassignment | 66.322s | 23.064s | 23.063s | 43.258s | 0.000s |
| Headquarters API | 48.200s | 44.251s | 44.247s | 3.949s | 0.004s |

### Shared-cost hypothesis and rejection

The shared candidate was real session/project lifecycle construction and exact cleanup on the fork-scoped gateway: authenticated HTTP session/staff/project mutations, WS state, persistence writes, snapshot/sweep cleanup, and project registry reset.

It would preserve boundaries only by continuing to issue real loopback HTTP/WS requests and real persistence operations, then restoring managers/stores to an exact baseline. Mutable session pooling or replacing persistence was not proposed.

Measured cleanup activity confirms this work is already exact-reset oriented:

- integration-1 representatives: 74 snapshots, 23 sweeps, 21 deleted sessions per round;
- integration-3 in-process representative: 30 snapshots, 3 sweeps, 2 deleted projects per round;
- the Headquarters custom-gateway cases perform explicit real shutdown and filesystem removal.

The projection cannot meet the gate:

| Affected lane | Sum of external file-process walls | Actual file/test work |
|---|---:|---:|
| integration-1 | **143.404s** | **89.182s** |
| integration-3 | **118.316s** | **84.690s** |

Even the impossible removal of every measured operation is below **150s on both lanes**. External startup/import is also not disjoint file work in the real lane because the fork-scoped gateway/module graph is already shared. **Gate 1 rejected; no fixture edit made.**

## Gate 2 — core process fidelity

A valid three-round eight-worker batch covered verification restart, native Git status, verification command runner, background-process manager, verification sandbox, real RPC bridge, local push policy, and browser screenshot process behavior.

Round walls: **30.06s, 30.98s, 30.87s**; all tests passed; zero process/ledger leaks.

| Component | Mean per round |
|---|---:|
| Sum external walls | 123.651s |
| Sum file/test work | 44.679s |
| Process startup/import across eight separate Vitest processes | 78.972s |

The proposed shared cost would be authored child-script/process setup while preserving every real spawn, signal, output, exit, browser, RPC, and Git canary. But the entire measured production test work is only **44.679s**, below the required **100s core-fidelity delta**. The 78.972s process startup/import amount is paid by two real `v2-core-fidelity` workers, not eight independent file processes, so it cannot be added as disjoint fixture savings. **Gate 2 rejected; no fixture edit made.**

One initial Gate-2 attempt selected an isolated-project extension file through `v2-core`, collected zero tests, and was discarded before the valid three rounds.

## Gate 3 — direct `server.ts` import graph

Eight small core files that directly import `src/server/server.ts` ran concurrently for three rounds. Round walls: **10.94s, 11.24s, 10.96s**; all tests passed.

| Component | Mean per round |
|---|---:|
| Sum external walls | 69.940s |
| Sum file/test work | 0.221s |
| Startup/import | 69.719s |

Narrow production-module extraction or prebundle imports could preserve these policy/parser assertions, while separate source-load/singleton/worker canaries retain real loader behavior. However, even eliminating all eight process walls is **<100s**, the Gate-3 core threshold. **Gate 3 rejected; no production/import edit made.**

## Gate 4 — real Git fixture matrix

Eight real-Git owners ran concurrently for three rounds: verification non-destructive sync, agent-directory validation, goal push safety, local push policy, native status, base-ref parsing, PR diff parsing, and clean-build warning behavior.

Round walls: **38.97s, 39.66s, 39.31s**; all tests passed; zero process/ledger leaks.

| Component | Mean per round |
|---|---:|
| Sum external walls | 201.783s |
| Sum file/test work | 121.574s |
| Startup/import | 80.209s |

An immutable real repository template shared read-only across workers could preserve real clones, refs, worktrees, fetch/reset/push, symlink/path, status, warning, and cleanup canaries. The edit requires a measured fixture-construction contribution of at least **75s**.

A non-semantic child-process profiler run measured **196 Git children / 35.009s cumulative Git runtime** in the two production paths it could observe. That is a lower bound, not a projected saving; real assertion Git commands cannot be removed. The profiler was corrected to preserve `promisify(execFile)`'s `{ stdout, stderr }` contract after an initial diagnostic altered that return shape; the invalid diagnostic was deleted and the corrected profile passed all tests.

No measured removable construction subset reaches 75s. **Gate 4 rejected; no Git fixture edit made.**

## Current decision

Gates 1–4 provide no threshold-clearing, retained-boundary edit. No full suite is authorized. The next useful work must identify a shared cost across the newly restored twelve integration files and the existing integration lanes, because the acceptance scope is now larger than every prior full-run profile.
