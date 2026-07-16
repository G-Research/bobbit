# Critical-lane decomposition and additive feasibility

**Decision date:** 2026-07-15
**Profiling reference only:** the **685.8s** run had three failures and excluded twelve formerly unit-owned integration files; it is not acceptance evidence.
**Constraint:** frozen scheduling/config/timeouts/retries/test tiers and merge-base boundary ownership.

## Stopped run

`bg-7475` was terminated after crossing 300s. Its full process tree was then killed explicitly. Final state: zero matching Vitest/orchestrator processes and ledger `0/24`. The partial run is not performance or correctness evidence.

## Measured critical-lane decomposition

The latest coverage-reduced critical lane was `core-fidelity` at 685.8s. The closest retained file-level decomposition is the preceding 681.1s `core-fidelity` run; neither run is acceptance-valid after restoring the twelve integration files. It used the same one-worker lane and differs by only 4.7s. Because the lane has one worker, its file test durations are sequential and may be grouped additively; Vitest transform/import counters are not added separately.

| Additive component | Measured seconds | Evidence |
|---|---:|---|
| Real Git/worktree/`gh` owners | **225.1s** | Native status 85.6; local push 38.5; shared-worktree guard 34.3; goal push safety 24.8; agent-dir validation 17.8; team manager 10.0; PR export 10.6; smaller Git owners 3.6. |
| Real process/verification/worker owners | **116.4s** | Verification restart 61.6; extension-host isolation 29.9; verification runner contract 13.5; background-process manager 10.4; smaller process owners 1.0. |
| Marketplace/filesystem/package owners | **115.1s** | Marketplace install 110.8 in that run; durable routes, migration, pack store, persistence and provider fixtures 4.3. |
| Other/unlisted test execution | **124.7s** | Residual of Vitest's 582.63s reported test work after the 458.0s enumerated file durations. |
| Non-test lane wall | **98.5s** | 681.1s external lane wall minus 582.63s test work. Includes collection, transform/import scheduling, worker startup and reporting; it is not the sum of Vitest transform/import counters. |
| **Total** | **679.8s** | Rounding and sub-second files account for the 1.3s difference from 681.1s. |

To reach 300s, this lane must lose **at least 385.8s (56.3%)**. Once it does, every other non-DOM lane also has to fall below 300s:

| Lane | Latest completed wall | Required reduction |
|---|---:|---:|
| core-fidelity | 685.8s | **385.8s** |
| integration-1 | 678.9s | **378.9s** |
| integration-3 | 636.0s | **336.0s** |
| core | 635.6s | **335.6s** |
| integration-2 | 597.5s | **297.5s** |

Therefore the suite needs roughly **1,734 lane-seconds** of reductions across five lanes, not one additive 386s saving.

## Ranked evidence-backed deltas

Only deltas measured under representative concurrent pressure are credited. Loaded file times are not summed as wall savings across lanes.

| Rank | Disjoint change set | Before under full load | Representative concurrent after | Creditable delta on its lane | Status |
|---:|---|---:|---:|---:|---|
| 1 | Shared-worktree import hook + goal-push pool fixtures | ≥120.0s (60s hook + two 30s timeouts) | 16.7s + 14.6s | **≤88.7s** | Landed, targeted stress green; not full-run validated. |
| 2 | Native Git status + local push fixtures | 85.6s + 38.5s | 10.0s + 12.3s | **≤101.8s** | Already reflected substantially in the 685.8s baseline; cannot be counted again. |
| 3 | MCP + team-manager fixture wave | 190.9s + 177.9s | 24.2s + 16.0s | **≤328.6s across two different lanes** | Already reflected in the 685.8s baseline; cannot be counted again and never represented 328.6s suite-wall reduction. |
| 4 | Maintenance response/clone lifecycle | 72.3s | 42.7s | **≤29.6s** | Already reflected in the baseline. |
| 5 | Verification sandbox attached-child fixture | 30s timeout | 15.0s | **≤15.0s on core, 0s on current critical lane** | Landed, targeted stress green; `_persistActive` bypass reverted. |

The only not-yet-full-validated critical-lane delta is **88.7s**. Even granting the entire 98.5s non-test wall as removable—an impossible upper bound—produces 187.2s, less than half the required 385.8s.

## Feasibility verdict

There is **no evidence-backed additive plan under the current constraints that plausibly removes 385.8s from the critical lane**, much less the 1,734 lane-seconds required across all five non-DOM lanes.

The following ideas are not yet eligible to appear as savings:

1. Reusing mutable gateway/session/project state across broad integration matrices: prior attempts failed exact-reset review.
2. Removing real Git/process/filesystem effects: prohibited by the merge-base boundary audit.
3. Counting cumulative transform/import counters as wall savings: they overlap and are not additive.
4. Extrapolating one file's loaded-to-focused ratio across other files: the marketplace file varied from 110.8s to 1.1s without a corresponding wall reduction.
5. Further isolated timeout repairs: they improve green probability but do not establish the missing wall delta.

## Ranked measurement plan before any more implementation

These are measurement gates, not claimed savings or authorization to edit fixtures.

| Rank | Representative batch | Required evidence | Minimum useful delta |
|---:|---|---|---:|
| 1 | Integration session/project lifecycle batch: Headquarters guards, cross-project proposals, staff, projectless sessions, tools and queue | Eight-worker concurrent before/after using per-test fresh or proven exact-reset state; real HTTP/WS/persistence retained | **≥150s on both integration-1 and integration-3** |
| 2 | Core-fidelity real-process batch: verification restart, extension isolation, command runner, bg manager | Concurrent before/after with every child/signal/output/worker canary retained | **≥100s on core-fidelity** |
| 3 | Core transform/import batch: extension dispatch plus direct server-graph import owners | External wall comparison using the existing content-addressed prebundle where singleton/env semantics are proven equivalent | **≥100s on core and ≥75s on core-fidelity** |
| 4 | Remaining real-Git batch: agent-dir, PR export/diff, base/ref helpers | Concurrent before/after with real repository graphs and exact cleanup | **≥75s on core-fidelity** |

These gates sum to the scale required, but current measurements do **not** show that the deltas are achievable. No fifth full suite should run until representative batch experiments meet the per-lane thresholds without semantic weakening.

## Verification sandbox persistence decision

The line `(harness as any)._persistActive = () => {}` has been **reverted**. Although this file's named assertions own spawn routing, attached child streams and broadcasts—not restart durability—bypassing a production persistence side effect for speed was unnecessary and unacceptable.

The real attached-child/stream canary remains. With production persistence restored, `verification-sandbox-exec.test.ts` passes 7/7 in 790ms test time (2.96s focused Vitest wall). Separate registered real persistence owners remain `verification-command-restart-lifecycle.test.ts`, `gate-verification-snapshot.test.ts`, and the verification restart/resignal integration coverage, but they are not used to justify a bypass here.
