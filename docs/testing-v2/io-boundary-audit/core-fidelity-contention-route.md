# Core-fidelity route below 300 seconds

> **Historical profiling route.** The named lane and worker topology were retired by the direct three-worker unit gate. Current commands and projects are documented in [`../unit-gate.md`](../unit-gate.md).

**Profiling reference only:** completed six-job run at **679.2s**, 7,575 passed / 1 failed. It excluded twelve formerly unit-owned integration files and is therefore not acceptance evidence.
**Reference gap:** **379.2s**, before restoring those files.
**Decision:** no further full suite until cross-lane pressure reductions meet the measurement gates below.

## Delegated edit accounting

The delegated files were benchmarked from the exact checked-in pre-edit versions and the then-current versions. Clean results are three isolated one-worker runs. Concurrent results are paired three-round batches with the same eight one-worker files: the two target files plus `team-manager`, `maintenance-api`, `rpc-bridge-lifecycle`, `mcp-meta-call`, `git-status-native`, and `stories-sessions-api`.

| File | Clean before | Clean after | Clean delta | 8-way before | 8-way after | Concurrent delta | Predicted 679.2s lane effect |
|---|---:|---:|---:|---:|---:|---:|---:|
| `local-sub-agent-push-policy.test.ts` | 7.437s | 5.750s | **1.687s** | 13.356s | 11.053s | **2.303s** | At most 2.3s; **676.9s**, still 376.9s over target. |
| `verification-command-restart-lifecycle.test.ts` | 12.453s | 12.510s | **−0.057s** | 31.508s | 29.624s | **1.884s** | At most 1.9s; **677.3s**, still 377.3s over target. |
| **Combined** | **19.890s** | **18.260s** | **1.630s** | **44.864s** | **40.677s** | **4.187s** | Optimistic additive ceiling: **675.0s**. The subsequent ~679.4s run showed no material wall change. |

The paired eight-file batch wall moved only **44.125s → 43.008s (1.117s)** because `maintenance-api` remained the batch critical path. The edits are correctness/flake repairs, not a sub-300 performance route.

### Retained real-boundary canaries

`local-sub-agent-push-policy.test.ts` retains:

- real local repositories, bare remotes, clones, worktrees and refs;
- an actual default publication with explicit destination refspec;
- remote branch creation, unchanged `origin/master`, and real upstream registration;
- real pool claim/freshen with no push and no inherited remote upstream;
- real `createWorktreeSet` local-only behavior and exact fixture cleanup.

`verification-command-restart-lifecycle.test.ts` retains:

- a fresh real OS child for each process-owning assertion;
- PID/start-token/nonce/heartbeat identity checks and real liveness;
- real signal, kill, exit, delayed close and surviving-child behavior;
- real durable active state, pid/heartbeat/exit/output files and fresh-harness resume;
- restart cancellation, timeout finalization, bounded retained-log reads, and gate-signal continuation.

No timeout, retry, worker, scheduling, project, or test-tier setting changed.

## Direct critical-lane ceiling

A clean, complete then-current `v2-core-fidelity` lane was measured after the delegated edits:

- **53/53 files passed**
- **794 passed, 7 skipped**
- **177.03s external Vitest wall**
- **155.15s tests**, 3.73s transform, 13.62s import

The same lane was **679.2s** in the coverage-reduced six-job suite. This remains contention evidence only. Therefore:

- clean intrinsic lane work: **177.03s**;
- full-suite contention amplification: **502.17s**;
- loaded/clean multiplier: **3.837×**;
- maximum allowable contention at 300s: **122.97s**;
- required contention reduction: **379.20s**, or **75.5% of current contention overhead**;
- required loaded/clean multiplier: **≤1.694×**.

This proves that additional core-fidelity fixture edits cannot close the gap: eliminating the lane's entire **155.15s** of test execution would still not constitute 379.2s of direct, additive work. The performance problem is sustained cross-lane amplification.

## Ranked clean core-fidelity work

These are the current clean file totals, not claimed savings. Removing every item is prohibited and still cannot supply the missing 379.2s.

| Rank | File | Clean test time | Protected interaction |
|---:|---|---:|---|
| 1 | `preview-mount.test.ts` | 13.938s | real staging/copy/swap/hash/watch filesystem behavior |
| 2 | `project-preflight.test.ts` | 13.282s | real path, symlink, worktree and state inspection |
| 3 | `verification-command-restart-lifecycle.test.ts` | 10.265s | real child/durable restart lifecycle |
| 4 | `verification-goal-sync-nondestructive.test.ts` | 9.205s | real Git equal/ahead/behind/diverged graphs |
| 5 | `agent-dir-validation.test.ts` | 8.278s | real path/symlink/read-write validation |
| 6 | `continue-archived-clone.test.ts` | 7.604s | byte-identical real copy/history cleanup |
| 7 | `bg-process-manager.test.ts` | 6.698s | process wait/abort/exit lifecycle |
| 8 | `local-sub-agent-push-policy.test.ts` | 5.300s | real Git publication/pool behavior |
| 9 | `goal-push-safety-regression.test.ts` | 5.217s | real Git pool/ref/push safety |
| 10 | `agent-dir-migration.test.ts` | 5.080s | real allowlisted copy/symlink containment |

## Measured contention response

The current delegated pair was also run with four concurrent real workloads instead of eight:

| Pressure | Local push | Verification lifecycle | Combined |
|---|---:|---:|---:|
| Clean, one at a time | 5.750s | 12.510s | **18.260s** |
| Four concurrent real files | 7.313s | 25.273s | **32.586s** |
| Eight concurrent real files | 11.053s | 29.624s | **40.677s** |

Moving from eight-way to four-way-equivalent pressure removed **8.091s (36.1%)** of this pair's contention overhead, but still left a **1.784×** clean multiplier. Applied only as a diagnostic ratio, `177.03 × 1.784 = 315.8s`; pressure must fall slightly below the measured four-way equivalent to reach 300s.

Scheduling remains frozen. The actionable route is therefore to reduce the work performed by the concurrently running lanes until their shared CPU/process/filesystem pressure is **less than roughly four current representative workers**, while all eight workers still start immediately.

## Ranked route and proof gates

The route is plausible only if these independent, representative measurements are met. None is credited before its before/after batch passes with real canaries retained.

1. **Core direct-source transform/import pressure**
   - Prior loaded core reported 299.94s transform and 387.95s import cumulatively. These counters overlap and are not wall savings, but they identify the largest CPU/source-graph demand.
   - Route: use the existing content-addressed server prebundle only for boundary-independent imports; retain focused source-load, singleton, invalidation, worker timeout/crash and fresh-module canaries.
   - Gate: reduce externally measured core CPU/source-read demand by **≥50%** and reduce representative eight-way core-fidelity amplification by **≥100s** without changing Vitest configuration.

2. **Integration negative Git discovery/process pressure**
   - The process profile observed **970 Git children, 883 failed**, with 68.6s cumulative child runtime. That profile was contaminated and cannot be credited as a saving, but the 91% failure ratio is the next measurement target.
   - Route: production-adapter negative discovery reuse keyed by canonical cwd plus explicit invalidation; every first probe, repository transition and real Git canary remains real.
   - Gate: a clean concurrent profile must eliminate **≥800 redundant failed Git spawns** and reduce core-fidelity representative amplification by **≥75s**.

3. **Integration immutable project/session fixture construction**
   - Target only already-audited fixture construction in Headquarters scope guards, cross-project proposals, staff, projectless sessions, tools and staff reassignment. Do not pool mutable sessions/gateways unless exact reset is proven.
   - Preserve HTTP, WebSocket, persistence, archive/symlink, restart and real-worktree owners.
   - Gate: paired eight-worker batches must reduce **integration-1 and integration-3 by ≥150s each** and reduce the simultaneously running core-fidelity probe by **≥100s**.

4. **Extension/verification worker and authored-script construction**
   - Retain real child spawn, module load, timeout, crash, invalidation, signals and output.
   - Gate: reduce representative core/core-fidelity process demand by **≥50s** and core-fidelity amplification by **≥50s**.

The core-fidelity amplification gates total **325s**, still 54.2s short of the required 379.2s. The remaining gate is a whole representative contention panel showing an additional **≥55s** reduction and a projected core-fidelity multiplier **≤1.694×**. Only then is another full suite justified.

## Verdict

The delegated edits do not materially affect the critical path. The clean lane is already below 300s; the loaded suite is not. A below-300 route requires a measured **≥379.2s cross-lane contention reduction**, not another isolated timeout repair. Until the ranked gates above are demonstrated, there is no evidence-qualified forecast and no reason to run another full suite.
