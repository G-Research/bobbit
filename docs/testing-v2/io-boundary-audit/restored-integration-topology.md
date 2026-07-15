# Restored integration topology and contention evidence

**Date:** 2026-07-15
**Scope:** the twelve restored unit-owned integration files under the real cost-based three-shard, one-fork-per-shard `v2-integration` topology.
**Authority:** profiling and edit-gate evidence only; no run in this document is full-suite acceptance unless explicitly stated.

## Three clean baseline rounds

All three rounds passed all twelve files. Every round began and ended with zero matching processes and ledger `0/24`; the one suite reservation was present during execution. There were zero uncertain cleanup sweeps.

| Round | Wall | Integration 1 (4 files) | Integration 2 (5 files) | Integration 3 (3 files) |
|---:|---:|---:|---:|---:|
| 1 | 111.72s | 103.10s | 109.54s | 63.17s |
| 2 | 114.65s | 100.93s | 112.41s | 63.28s |
| 3 | 108.68s | 103.43s | 106.44s | 60.49s |
| **Mean** | **111.68s** | **102.49s** | **109.46s** | **62.31s** |

Mean shard time attribution:

| Shard | External wall | Sum file time | Sum test time | Import/process/outside-file delay | In-file residual |
|---|---:|---:|---:|---:|---:|
| Integration 1 | 102.485s | 95.065s | 95.061s | 7.420s | 0.005s |
| Integration 2 | 109.460s | 103.092s | 100.828s | 6.368s | 2.264s |
| Integration 3 | 62.313s | 56.152s | 56.151s | 6.161s | 0.001s |

The cleanup hypothesis was rejected. Independent duration exports attributed only about 0.03s to Integration 1, 0.19s to Integration 2, and 0.19s to Integration 3. Sweep counts below were deterministic and all uncertain-sweep counts were zero.

| Shard | File | Mean file/test time | Mean sweeps |
|---|---|---:|---:|
| Integration 1 | `commit-file-diffs-api.test.ts` | 16.222s / 16.222s | 1 |
| Integration 1 | `orchestrate-restart.test.ts` | 40.390s / 40.390s | 3 |
| Integration 1 | `project-isolation.test.ts` | 21.501s / 21.501s | 1 |
| Integration 1 | `team-delegate.test.ts` | 16.952s / 16.948s | 2 |
| Integration 2 | `continue-archived-assistant.test.ts` | 18.792s / 18.791s | 7 |
| Integration 2 | `sidebar-actions-fork-github-link.test.ts` | 33.189s / 30.930s | 4 |
| Integration 2 | `steer-gateway-restart.test.ts` | 7.984s / 7.984s | 1 |
| Integration 2 | `team-dismiss-structured-regression.test.ts` | 17.621s / 17.621s | 1 |
| Integration 2 | `team-wait-semantics.test.ts` | 25.507s / 25.501s | 2 |
| Integration 3 | `continue-archived.test.ts` | 35.857s / 35.856s | 8 |
| Integration 3 | `multi-repo-flow-api.test.ts` | 13.377s / 13.377s | 1 |
| Integration 3 | `team-lead-child-authz.test.ts` | 6.918s / 6.918s | 1 |

Canonical machine-readable evidence is `.profiles/hotspots/restored-unit-topology/summary.json`.

## Shared generated guard-module cost

A representative twenty-file panel (the restored twelve plus eight existing lifecycle owners) showed a shared production path:

| Shard | Sessions | `spawnAgent.rpcStart` before | After immutable guard-module reuse |
|---|---:|---:|---:|
| Integration 1 | 61 | 107.496s | 3.227s |
| Integration 2 | 58 | 96.667s | 4.738s |
| Integration 3 | 37 | 72.679s | 6.865s |

The full 189-file integration topology then measured 158/153/134 starts and 270.168s/289.184s/253.671s of `rpcStart`. Even the slowest post-change per-start rate projected disjoint reductions of 240.9s, 260.8s, and 228.8s, clearing the edit gate on every integration shard.

The accepted change:

- content-addresses generated guards by policy/grants rather than session id;
- captures the gateway-owned `BOBBIT_SESSION_ID` at each activation;
- caches immutable transpiled extension modules in the existing in-process mock bridge;
- invokes the shared module factory separately for every session, preserving separate grant sets;
- mirrors and restores the child-owned gateway URL, token, Bobbit directory, and session id during synchronous activation;
- leaves real HTTP, WebSocket, persistence, Git/worktree, process, loader, restart, and cleanup boundaries intact.

The required runtime canary is `tests2/core/in-process-mock-guard-cache.test.ts`: two concurrent activations assert one cached module load, then later and concurrent callbacks assert distinct `/api/sessions/<id>/tool-grant-request` paths and distinct bearer tokens.

### Restored twelve after change

Three clean rounds passed at 41.35s, 41.14s, and 40.81s wall:

| Shard | Before mean | After mean | Mean reduction | After outside-file delay |
|---|---:|---:|---:|---:|
| Integration 1 | 102.485s | 34.167s | 68.318s | 7.273s |
| Integration 2 | 109.460s | 38.881s | 70.579s | 6.138s |
| Integration 3 | 62.313s | 25.631s | 36.682s | 5.497s |

Every post-change round again ended with zero leaks, zero uncertain sweeps, and ledger `0/24`. Evidence: `.profiles/hotspots/restored-unit-topology-after-guard-cache/summary.json`.

### Invalid full-integration timings

The 232.62s full-integration run is invalid for acceptance and projection. Its logs show generated guards failed activation when `BOBBIT_DIR`/gateway token state was absent, so the security boundary was not running. The later 254.77s integration-only run has the same credential-file activation errors and is likewise diagnostic-only. Neither timing is credited or compared with the 655.34s clean baseline.

The guard now captures session-specific env values at activation but reads fallback credential files only when an `ask` callback actually needs them. This keeps `never` policies active in credential-less fixtures and makes missing credentials fail `ask` closed. The runtime canary proves both that behavior and two-session identity/token isolation.

## Corrected cross-lane contention

The contention panel combines the real 189-file integration topology with all 53 `v2-core-fidelity` files under one suite reservation. Scheduling, workers, projects, timeouts, retries, and tier ownership remain unchanged.

The 399.19s run also contains generated guard-load failures. It is invalid even as a comparison/reference: no savings, projection, or edit authorization is derived from it.

The only valid absolute broad evidence is the first panel with zero guard-load errors:

| Panel | Wall | Integration 1 | Integration 2 | Integration 3 | Core fidelity | Guard-load errors |
|---|---:|---:|---:|---:|---:|---:|
| Fully guarded current panel | **358.32s** | **346.60s** | **259.90s** | **278.95s** | **356.01s** | **0** |

Its Integration 1 production attribution is absolute, not a before/after claim:

| Production cost | Calls | Cumulative time | Disjoint interpretation |
|---|---:|---:|---|
| `loadToolDefinitions` | 2,431 | 166.272s | Dominant repeated catalogue scan; nested in config resolution. |
| `executePlan.resolveConfig` | 158 | 139.681s | Outermost disjoint session-config cost. |
| `flexStore._doFlush` | 155 | 148.255s | Separate persistence work; not additive with route/session totals. |
| `POST /api/sessions` | 130 | 139.168s | Route total overlapping config/spawn work. |

Acceptance remains implausible: core fidelity is 56.01s over target and Integration 1 is 46.60s over.

### Catalogue caller and producer attribution

Behavior-neutral caller labels and per-cleanup-export deltas were collected under the same fully guarded topology. Integration 1's 2,431 calls/163.429s were dominated by `getToolProvider` at 1,739 calls/108.947s. Five files owned 101.92s of that caller cost: `project-isolation` (30.29s), `mcp-meta-call` (23.45s), `team-steer-prompt` (18.81s), `goal-creation-flow` (16.70s), and `sessions-projectless` (12.67s). Machine-readable evidence is `.profiles/hotspots/tool-definition-attribution/per-file-summary.json`.

`computeEffectiveAllowedTools` was re-reading the provider catalogue once per already-enumerated tool. The retained fix classifies from the `providerType` on the same `getAvailableTools()` snapshot. This preserves YAML/Pi precedence and removes no I/O boundary. In two fully guarded, same-instrumentation panels it produced:

| Measure | Before | After | Delta |
|---|---:|---:|---:|
| Integration 1 wall | 349.34s | 270.48s | -78.86s |
| `loadToolDefinitions` calls | 2,431 | 692 | -1,739 |
| `loadToolDefinitions` time | 163.429s | 52.685s | -110.744s |
| `executePlan.resolveConfig` | 141.416s | 58.550s | -82.866s |
| `resolveTools` | 84.028s | 13.856s | -70.172s |

All 242 files passed and both panels had zero guard-load errors. Core fidelity changed only from 358.86s to 352.16s, so the overall target remained unmet.

The 460.39s, 399.19s, 336.91s, 343.29s, 232.62s, and 254.77s runs are not credited for acceptance, comparison, projection, or authorization because they either failed tests or contain guard-activation failures. The async session-snapshot experiment remains rejected and reverted.

The aborted `bg-7504` synthetic multiplication is discarded completely: it launched three copies of the integration topology, stripped hygiene assertions, and was killed with all descendants. It supplies no timing, acceptance, or scheduling evidence. Final process state was empty and ledger state was `0/24`.

## Next quantified hypothesis

In the fully guarded panel, core-fidelity file-time amplification is 140.35s versus its clean reference. The largest retained real-boundary contributors are:

| File | Clean | Loaded | Amplification |
|---|---:|---:|---:|
| `verification-goal-sync-nondestructive.test.ts` | 9.205s | 50.564s | 41.359s |
| `verification-command-restart-lifecycle.test.ts` | 10.265s | 32.543s | 22.278s |
| `preview-mount.test.ts` | 13.938s | 24.921s | 10.983s |
| `agent-dir-migration.test.ts` | 5.080s | 12.570s | 7.490s |
| `extension-host-module-isolation.test.ts` | 3.610s | 10.801s | 7.191s |

These costs span real Git/worktree, process, filesystem, loader, and lifecycle assertions. They are not additive authorization for mocking.

Retained-boundary follow-up work:

- `verification-goal-sync-nondestructive` now clones independent real bare remotes from one immutable real-Git template. Focused time fell from 9.685s to 7.151s while all ahead/behind/diverged/hook/unchanged assertions remained real.
- All 25 merge-base real Pi discovery declarations were restored unchanged. The newer 13 injected-backend assertions remain additive in `pi-extension-discovery-backend.test.ts`. Suite-root cleanup reduced the real 25-test file from 45.81s to 24.25s focused without reusing a probe process or weakening loader/filesystem/network confinement.
- FlexSearch now flushes only dirty stores. Persistent failure is bounded: it returns once with the dirty obligation retained, and a later explicit retry persists. A separate deterministic test pins mutation-during-flush to exactly one follow-up write.

`bg-7514` exited 1 solely because its diagnostic runner still expected 53 core-fidelity files after restoration made `pi-extension-discovery.test.ts` the 54th process-fidelity file. Vitest reported zero failed tests; process leaks were empty and ledger began/ended `0/24`. The runner recorded `error: "collected 54/53 shard files"`, so its 399.29s timing is discarded.

The corrected fully guarded 54-file panel passed naturally at 362.13s wall (core fidelity 359.85s; integrations 267.98s/257.08s/291.65s). An unprofiled repeat also passed at 363.37s (core fidelity 361.10s; integrations 302.63s/281.89s/307.56s).

### FlexSearch atomic export bundle

Behavior-neutral persistence attribution under the actual guarded topology confirmed many-file amplification. Across three integration shards, the legacy format performed 2,796 writes and 2,795 atomic renames for 430 flushes (2,397 FlexSearch export keys); writes and renames consumed 113.192s and 74.348s cumulatively. Stale sweeps examined 2,801 entries but deleted only 15, so stale deletion was not the source.

The retained format keeps the independently atomic `__docs__.json` recovery mirror and replaces per-key index files with one versioned, atomic `__index__.json` bundle. A SHA-256 mirror hash detects interrupted two-file generations. Reads remain backward-compatible with legacy per-key exports; corrupt, partial, unsupported, or mirror-mismatched bundles rebuild from the real docs mirror and are repaired on close. Dirty-failure bounded return/later retry and concurrent-mutation follow-up semantics remain covered deterministically.

The same guarded representative topology passed all 243 files after the change:

| Measure | Legacy format | Versioned bundle |
|---|---:|---:|
| Panel wall | 362.03s | 350.12s |
| Core fidelity | 359.87s | 347.81s |
| Writes | 2,796 / 430 flushes | 950 / 483 flushes |
| Atomic renames | 2,795 / 430 flushes | 950 / 483 flushes |
| Mean writes per flush | 6.50 | 1.97 |
| Cumulative `_doFlush` | 216.063s | 117.188s |

The format cut average write/rename fan-out by 69.7% and average profiled flush cost by 51.7%. The representative panel remains evidence rather than full-suite acceptance; final sequential validation is required.

## Declaration semantics

The earlier 7,478/7,485 count is resolved semantically rather than waived:

- all 25 merge-base declarations in `pi-extension-discovery.test.ts`, including real child-process, TypeScript loader, containment, filesystem, network, timeout, and cache-bound assertions, are restored by exact name and pass 25/25;
- the 13 deterministic injected-backend assertions remain additive in a new v2-native file;
- the seven remaining renamed/consolidated ledger and lane-scheduling declarations have explicit current owners and rationales in `scripts/testing-v2/unit-declaration-semantic-map.json`;
- the inventory audit validates every mapped target exists, rejects stale/duplicate/empty mappings, and now reports zero unmapped declarations and `declarationSemanticsPreserved: true`.

Current base files contain 7,494 static declarations versus 7,485 at merge base; the higher count is additive, not a deficit.

## Restored-scope full-run diagnostic

A natural `npm run test:unit` run exited at **508.4s** and failed both time and correctness. Because it preceded the lazy credential fix and contains the same guard-activation failures, it is a scope/failure diagnostic only—not acceptance or projection evidence:

| Lane | Result | Wall | Detail |
|---|---|---:|---|
| Core fidelity | Fail | 508.4s | Four 30s load-only timeouts in `verification-goal-sync-nondestructive.test.ts`; 53 files collected. |
| Integration 1 | Pass | 489.7s | 63 files, zero failed tests. |
| Core | Fail | 418.6s | One `guard-v2` bookkeeping failure because the new guard canary was not yet listed in `v2Native`; 500 files collected. |
| Integration 3 | Pass | 402.8s | 63 files, zero failed tests. |
| Integration 2 | Pass | 363.6s | 63 files, zero failed tests. |
| DOM | Pass | 178.5s | 144 files, zero failed tests. |

The run reported 7,630 passed and five failed tests. The `v2Native` omission was corrected immediately. This does not repair or replace the invalid run. Inventory still preserves every one of the 880 merge-base files with zero E2E exclusions. Final process state was empty and ledger state was `0/24`.
