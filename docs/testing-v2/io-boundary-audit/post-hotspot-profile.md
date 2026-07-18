# Post-hotspot full-run profile

**Date:** 2026-07-15
**Evidence:** the latest split-lane full-run logs in `.profiles/unit-lanes/{core-fidelity,core,dom,integration-1,integration-2,integration-3}.log`, after the hotspot fixture wave. The older combined `integration.log` and older `complete-natural-run.md` are not used as this run's result.

## Result and lane walls

The then-configured orchestration wall was **681.2s**, down **128.6s (15.9%)** from the prior **809.8s** wall. It excluded twelve formerly unit-owned integration files and is retained only as contention profiling, not acceptance evidence. The critical lane moved from `integration-1` to `core-fidelity`.

| Lane | External wall | Distance from critical lane |
|---|---:|---:|
| core-fidelity | **681.1s** | — |
| integration-1 | 656.5s | 24.6s |
| integration-3 | 633.8s | 47.3s |
| core | 612.3s | 68.8s |
| integration-2 | 593.8s | 87.3s |
| DOM | 156.2s | 524.9s |

This is a valid completed profile, not a green acceptance run. `git-status-native.test.ts` timed out while building its real-Git fixtures in `beforeAll`, and `stories-sessions-api.test.ts` timed out waiting for a real-worktree session to become idle. Those failures remain part of the profile rather than being discarded.

Vitest's lane totals also show substantial cumulative transform/import work: `core` reports **299.94s transform / 387.95s import**, while the other non-DOM lanes report **71.33–112.06s transform / 37.32–89.60s import**. These are cumulative worker measurements, not lane-wall components that can be added or subtracted from wall time.

## Top 15 loaded file times

“Loaded file time” below is the per-file duration printed by Vitest in the six current lane logs. It is useful for ranking contention and fixture amplification, but it is not a focused benchmark.

| Rank | Loaded time | Lane | File | Classification | Audit-preserving interpretation |
|---:|---:|---|---|---|---|
| 1 | **110.823s** | core-fidelity | `tests2/core/marketplace-install.test.ts` | **real-boundary fixture reuse eligible** | Reuse an immutable marketplace source tree and copy only per-case mutation targets. Keep real copy, metadata/order writes, update/uninstall, traversal, and byte-fidelity assertions. |
| 2 | **85.600s** | core-fidelity | `tests2/core/git-status-native.test.ts` | **blocked by merge-base audit** | `C-14`/`GIT-005` is an MB gap and the file asserts real repository graphs/native Git output. The immediate defect is the 60s real-fixture `beforeAll` timeout; repair with a reusable real repository template, never mocked status output. |
| 3 | **81.728s** | integration-3 | `tests2/integration/cross-project-proposals.test.ts` | **real-boundary fixture reuse eligible** | Keep loopback HTTP, target-project workflow validation, and persisted proposal fields. Reuse/reset seeded project/session/draft fixtures instead of repeatedly provisioning equivalent session state. |
| 4 | **64.722s** | integration-3 | `tests2/integration/headquarters-server-scope-guards.test.ts` | **real-boundary fixture reuse eligible** | Exercise the four cwd permutations against one safely reset custom gateway; retain a separately isolated gateway for the symlink/archive canary and its real filesystem effect. |
| 5 | **64.017s** | integration-1 | `tests2/integration/staff.test.ts` | **real-boundary fixture reuse eligible** | Continue shared staff/session use, cache stable default-project data, and reset exact staff/session/WS state. Preserve real HTTP, WebSocket broadcasts, persistence, reassignment, and archive outcomes. |
| 6 | **61.584s** | core-fidelity | `tests2/core/verification-command-restart-lifecycle.test.ts` | **blocked by merge-base audit** | `C-25` is MB-partial: process identity, liveness, exit, signal, durable status, and output recovery must remain real. Only authored state templates and command-fixture construction may be reused. |
| 7 | **51.865s** | integration-1 | `tests2/integration/sessions-projectless.test.ts` | **already deterministic** | Three cases already use the fork-scoped gateway and in-process agent. The loaded inflation is not evidence for replacing HTTP/session lifecycle; retain this small contract matrix and remeasure under focused contention before changing it. |
| 8 | **49.857s** | integration-2 | `tests2/integration/tools-e2e.test.ts` | **real-boundary fixture reuse eligible** | Reuse/reset session and goal fixtures across route-only cases while retaining real loopback HTTP, WebSocket authentication/framing, and the few lifecycle-specific sessions. |
| 9 | **48.834s** | integration-1 | `tests2/integration/queue-e2e.test.ts` | **already deterministic** | It already uses a deterministic in-process agent and signal-driven WebSocket predicates. Its ordered busy/queue/abort transitions are the contract; do not infer a mock-removal opportunity from loaded wall alone. |
| 10 | **48.612s** | integration-2 | `tests2/integration/staff-patch-reassign.test.ts` | **real-boundary fixture reuse eligible** | Reuse immutable real-Git/plain project templates and reset registered records. Preserve actual worktree/branch provisioning and persisted reassignment metadata required by `C-17`/`GIT-008`. |
| 11 | **46.328s** | integration-3 | `tests2/integration/maintenance-api.test.ts` | **already deterministic** | The hotspot wave already introduced shared real clone fixtures and exact resets; all 24 assertions pass. Keep the protected real HTTP/Git inventory, removal, preservation, selector, and branch outcomes rather than chasing one loaded sample. |
| 12 | **43.333s** | integration-2 | `tests2/integration/headquarters-api.test.ts` | **real-boundary fixture reuse eligible** | Consolidate non-restart cases onto a reset same-root gateway fixture; keep the explicit restart/persistence case and real state separation/writes. |
| 13 | **42.539s** | core | `tests2/core/extension-host-action-dispatcher.test.ts` | **transform/import amplification** | The file repeatedly starts workers and evaluates fresh file-URL modules, including invalidation and hung-evaluation canaries. Reuse a hot worker/module only for policy and mapping cases; preserve representative real load, fresh import, timeout, crash, and invalidation assertions under `C-41`. |
| 14 | **40.831s** | integration-3 | `tests2/integration/base-ref-api.test.ts` | **blocked by merge-base audit** | `C-14`/`GIT-002` is an MB gap for the real ref matrix. The shared real repository template is the correct seam; tags, local/remote refs, multi-repo misses, and native Git validation may not become supplied results. |
| 15 | **38.525s** | core-fidelity | `tests2/core/local-sub-agent-push-policy.test.ts` | **blocked by merge-base audit** | `C-15`/`GIT-006` is only MB-partial. Recorded-runner policy cases are already deterministic, but upstreams, refs, registration, and push effects must retain real Git; reuse real templates only. |

These durations overlap across workers and lanes. Their cumulative total is **not** a wall-saving estimate, and the **128.6s** full-wall improvement is not attributed by summing file-time changes.

## Prior hotspot status

All four previously stopped hotspots pass in the current full run:

| Hotspot | Current loaded result | Protected boundary retained |
|---|---:|---|
| `mcp-meta-call.test.ts` | **15/15**, 13.175s | Gateway HTTP/auth/project policy and manager/session ownership |
| `team-manager.test.ts` | **52/52**, 9.973s | Real Git worktrees, inherited bytes, HEAD/`baseSha`, registration and lifecycle |
| `maintenance-api.test.ts` | **24/24**, 46.328s | Real HTTP, Git inventory/removal/preservation and branch outcomes |
| `rpc-bridge-lifecycle.test.ts` | **1/1**, 0.849s | Real child spawn/write/crash stderr/exit `17`, exactly-once rejection/event |

The current loaded numbers confirm that the former failure paths completed; they do not isolate causal savings. In particular, the earlier run had no retained loaded time for `rpc-bridge-lifecycle`, so no before/after loaded-time claim is made for it.

## Next critical-path work

Work in critical-path order, without changing scheduling or E2E ownership:

1. **Repair the `core-fidelity` real-Git fixture failure first.** Build one immutable `git-status-native` template graph, create cheap per-case real copies/clones, and retain every native status assertion. Require a contention proof with the current lanes and no timeout increase.
2. **Reduce `marketplace-install` fixture construction.** Reuse an immutable source pack tree and minimal mutation copies. Keep representative real copy/install/update/uninstall and persistence canaries. This is the largest passing file on the critical lane.
3. **Deduplicate verification lifecycle setup, not lifecycle behavior.** Reuse authored persisted-state and command-script fixtures while continuing to spawn real children for identity, signal, exit, output, and restart-recovery cases.
4. **Prepare for the next lane handoff.** Once `core-fidelity` drops by roughly 25s, `integration-1` becomes critical. Apply exact-reset fixture reuse to `staff.test.ts`; leave `sessions-projectless` and queue ordering alone until focused concurrent evidence distinguishes fixture cost from load amplification.
5. **Then address `integration-3`.** Consolidate cross-project proposal and Headquarters cwd cases around reset gateway/project fixtures, while keeping the archive/symlink and restart owners isolated and real.
6. **Treat core import work separately.** Profile the Extension Host worker bootstrap/module graph, reuse hot workers only for boundary-independent mapping cases, and retain real import/invalidation/timeout/crash canaries.

Out of scope for this work: lane allocation, worker counts, concurrency policy, test-file movement, timeout increases, retries, new or relocated E2E coverage, and replacement of the merge-base-protected real boundaries.
