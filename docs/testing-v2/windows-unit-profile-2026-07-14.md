# Windows unit profile — 2026-07-14

> **Historical layout notice.** This document preserves migration, incident, or measurement
> evidence from before Bobbit adopted the canonical `tests/` hierarchy. Old `tests2/`
> and non-semantic test paths, map/affected-selector references, commands, counts, and
> lane names below describe the recorded revision; they are not current instructions.
> Keep measured citations unchanged. For current placement and discovery, use [Testing
> Strategy](../testing-strategy.md) and [`scripts/testing/layout-policy.mjs`](../../scripts/testing/layout-policy.mjs).

## Historical configuration

- Windows x64, Node 24.13.1, Vitest 4.1.10.
- The July 14 measurements used the former three-lane allocation: core=3, integration=4, DOM=1.
- Child processes were measured by `scripts/testing-v2/profile-windows-unit.mjs`; arguments and environment values were not captured.
- References below to lanes, lane allocation, and the concurrency ledger describe the retired profiler architecture used to collect these retained measurements.

## Current profiler usage

The profiler now invokes `node_modules/vitest/vitest.mjs` directly and writes each project's streamed `vitest.log` and process telemetry beneath its profile directory. It has no unit-lane runner, ledger, slot reservation, cost shard, or boot lease.

```bash
# Profile all four tier-1 projects with the fixed three-worker cap.
npm run test:v2:profile-windows

# Profile a narrow core file. --workers may only lower the cap.
npm run test:v2:profile-windows -- --project v2-core --workers 1 tests/unit/core/windows-process-profile.unit.test.ts

# Rebuild reports from an existing profile without rerunning Vitest.
npm run test:v2:profile-windows -- --from-dir .profiles/testing-v2/windows-process-profile/<timestamp>
```

Projects are `v2-core`, `v2-integration`, `v2-dom`, and `v2-isolated`. The repeatable `--lane` option remains only as a backward-compatible alias for `--project`; old short values such as `core` are accepted.

## Historical August 2026 Windows unit I/O reduction

The August work removed process boundaries where the behavior under test was policy rather than process isolation. Affected-runner policy called an in-process planner and executor, Hindsight policy called the provider directly, incidental API fixtures used existing identity seams, and the Vitest coordinator created the shared Git template once before workers adopted it. The affected-runner portions are retained only as measurements because that runner has since been deleted.

### Revisions and method

Three revisions answer different questions and must not be conflated:

- Historical affected split `094d14ae` is the audited comparison point: **29.5 s** and a canonical profile with **185 target launches** (**62 Node + 123 Git**).
- Exact stacked baseline `626f3cf1` measures the pre-change implementation on the same Windows profiler used below.
- After revision `8cc7b01b` measures the integrated optimization. Every reported after slice used three clean retry-free rounds on Windows x64 with Node 24.13.1, npm 11.8.0, Git 2.53.0.windows.1, Vitest 4.1.10, and the fixed three-worker cap.

“Profile wall” is the outer profiler duration, “Vitest” is Vitest's reported duration, and “files” is cumulative per-file duration. File duration can exceed wall time when workers overlap. Process launch totals come from the Windows process profiler; it does not observe `worker_threads`.

### Results

| Slice | Exact `626f3cf1` baseline: profile / Vitest / files | After `8cc7b01b`, three profile rounds | After mean: profile / Vitest / files | Result |
|---|---:|---:|---:|---|
| Affected direct matrices | 12.9 / 9.56 / 17.04 s | 3.808 / 2.477 / 2.470 s | 2.918 / 0.807 / 0.495 s | File time fell **97.1%**; mean profile wall fell **77.4%** from the exact baseline and **90.1%** from the audited 29.5 s split. |
| Hindsight direct provider + worker smoke | 7.2 / 5.63 / 5.02 s for the old worker slice | 5.168 / 5.101 / 5.113 s | 5.127 / 1.851 / 1.468 s | The broader direct-plus-smoke slice is **46.6%** below the 9.603 s historical wall owner. |
| Four incidental-Git files | 5.2 / 3.72 / 6.78 s | 3.449 / 3.443 / 3.504 s | 3.465 / 1.817 / 4.095 s | Reductions from the exact baseline are **33.4% / 51.2% / 39.6%**. |
| Historical three-worker one-init probe (`8cc7b01b`) | Three worker-local initializations and 30 bootstrap Git commands | 1.879 / 1.865 / 1.899 s | 1.881 s profile wall | At the profiled revision, every round used three forks and one coordinator initialization: 10 Git commands total, **66.7% fewer** bootstrap commands. |

The affected after rounds launched **0 Node + 10 Git** processes. All ten Git launches belong to coordinator template bootstrap, so the affected policy cases themselves launched no Node, Git, or worker process. This is **94.6% fewer target launches** than the exact affected baseline's 185. The direct affected files averaged 0.305 s for the cache/reporting matrix and 0.189 s for the injected-change matrix.

The Hindsight provider's 20 direct cases completed in 24, 25, and 22 ms. The retained installed-provider worker smoke averaged about 1.445 s of semantic test time. The combined slice therefore retains its genuine `ModuleHost` and host-store proxy proof without paying worker startup for provider policy, payload, configuration, queue, and diagnostic cases. No `worker_threads` launch count is claimed because the profiler does not collect it.

The incidental slice occupied three forks in every round and launched no fixture Git beyond the ten coordinator-bootstrap commands. Its four fixtures therefore no longer amplify repository creation. At `8cc7b01b`, the focused one-init probe additionally pinned one shared path and digest, distinct worker identities, private writable copies, an immutable shared source, unchanged ten-command audit before and after adoption, and no worker cleanup authority. In the scheduler-independent design at that revision, certification ran at coordinator shutdown only after the complete Tier-1 inventory had executed; focused subsets intentionally did not certify incomplete evidence.

The affected E2E boundary passed 2/2 tests with `retry=0` in all three rounds. External walls were 2.671, 2.607, and 2.624 s (mean 2.634 s). This small serial owner preserves CLI argv/JSON/exit behavior and real-Git committed, staged, unstaged, untracked, rename, delete, and invalid-base behavior outside Tier 1.

### Reproduction commands and evidence

Set `<r>` to `1`, `2`, or `3`. These commands reproduce the slices measured at after revision `8cc7b01b`; in particular, the three-file one-init command is a historical timing command, not the current certification path:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:v2:profile-windows -- --project v2-core --out-dir .profiles/testing-v2/windows-process-profile/after-8cc7b01b-round<r>-affected tests2/core/affected-runner-cli.test.ts tests2/core/affected-runner-git-cli.test.ts

BOBBIT_V2_RETRY_FREE=1 npm run test:v2:profile-windows -- --project v2-core --project v2-integration --out-dir .profiles/testing-v2/windows-process-profile/after-8cc7b01b-round<r>-hindsight tests2/core/hindsight-provider.test.ts tests2/integration/hindsight-external.test.ts

BOBBIT_V2_RETRY_FREE=1 npm run test:v2:profile-windows -- --project v2-integration --out-dir .profiles/testing-v2/windows-process-profile/after-8cc7b01b-round<r>-incidental tests2/integration/gate-bypass-api.test.ts tests2/integration/quiet-pr-status-api.test.ts tests2/integration/default-standard-session-role-worktree.test.ts tests2/integration/git-status-local-only-policy.test.ts

BOBBIT_V2_RETRY_FREE=1 npm run test:v2:profile-windows -- --project v2-core --out-dir .profiles/testing-v2/windows-process-profile/after-8cc7b01b-round<r>-one-init tests2/core/git-template-handoff-probe-a.test.ts tests2/core/git-template-handoff-probe-b.test.ts tests2/core/git-template-handoff-probe-c.test.ts

BOBBIT_V2_RETRY_FREE=1 BOBBIT_TEST_NO_EXTERNAL=1 BOBBIT_TEST_NO_REMOTE=1 BOBBIT_V2_E2E_VITEST=1 VITEST_MAX_WORKERS=1 node node_modules/vitest/vitest.mjs run --config vitest.config.ts --project v2-e2e-vitest --silent=passed-only --retry=0 tests2/integration/affected-runner-boundary.test.ts
```

The three-file command above reproduces the `8cc7b01b` timing slice only. In the current scheduler-independent design, focused subsets intentionally do not certify incomplete handoff evidence. Current one-init certification runs at coordinator shutdown only when the complete canonical Tier-1 inventory has executed:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:unit
```

The exact `626f3cf1` baseline commands were:

```bash
npm run test:v2:profile-windows -- --project v2-core --out-dir .profiles/testing-v2/windows-process-profile/baseline-626f3cf1-affected tests2/core/affected-runner-cli.test.ts tests2/core/affected-runner-git-cli.test.ts

npm run test:v2:profile-windows -- --project v2-integration --out-dir .profiles/testing-v2/windows-process-profile/baseline-626f3cf1-hindsight tests2/integration/hindsight-external.test.ts

npm run test:v2:profile-windows -- --project v2-integration --out-dir .profiles/testing-v2/windows-process-profile/baseline-626f3cf1-incidental tests2/integration/gate-bypass-api.test.ts tests2/integration/quiet-pr-status-api.test.ts tests2/integration/default-standard-session-role-worktree.test.ts tests2/integration/git-status-local-only-policy.test.ts
```

Each profiler directory contains a timestamped evidence directory with `report.md`, `report.json`, project `vitest.log`, and `processes/` telemetry:

```text
.profiles/testing-v2/windows-process-profile/after-8cc7b01b-round<r>-<slice>/<timestamp>/
.profiles/testing-v2/windows-process-profile/after-8cc7b01b-affected-e2e/round<r>.log
.profiles/testing-v2/windows-process-profile/after-8cc7b01b-affected-e2e/round<r>-wall-ms.txt
```

The exact after timestamp roots are `2026-08-04T12-20-40-753Z`, `12-20-57-343Z`, and `12-21-12-495Z` for affected; `12-20-45-131Z`, `12-21-00-390Z`, and `12-21-15-524Z` for Hindsight; `12-20-50-903Z`, `12-21-06-056Z`, and `12-21-21-226Z` for incidental; and `12-20-54-906Z`, `12-21-10-060Z`, and `12-21-25-292Z` for one-init, all beneath their matching round/slice directories.

The exact baseline used the same directory shape beneath `baseline-626f3cf1-{affected,hindsight,incidental}`. Its timestamp roots are `2026-08-04T11-20-20-051Z`, `2026-08-04T11-20-51-296Z`, and `2026-08-04T11-21-06-846Z`, respectively.

### Retained boundary owners

The table names the exact tests that own behavior moved away from repeated Tier-1 process setup. This division matters: direct tests own policy and data transformation, while the smallest suitable boundary test owns process fidelity.

| Layer | Exact owner | Boundary retained |
|---|---|---|
| Tier-1 direct | `affected-runner-cli.test.ts` — `runs all for unexplained executable deletes and bypasses prior cache hits`; `bypasses a warmed cache when root package.json is renamed out`; `retains only explicit fresh PASS verdicts across RUN-ALL, failures, and missing reports`; `fails closed for incomplete, malformed, duplicate, and contradictory batch verdicts`; `fails a multi-batch run without certifying any file from a partial batch`; `bypasses warm cache for every transitive Vitest configuration input, including tombstones`; `does not certify code, non-code, or runner inputs mutated during execution`; `invalidates dependency hashes and fingerprints every execution boundary`; `batches long Windows command lines without subprocesses` | Cache, selection fallback, reporting, mutation fence, fingerprint, tombstone, and Windows batching policy without a subprocess. |
| Tier-1 direct | `affected-runner-git-cli.test.ts` — `uses rich before/after bytes for semantic selection without collecting Git changes`; `passes direct changed/base options only to the injected collector and normalizes paths`; `preserves rename and delete old-side attribution through tombstones`; `keeps graph-owned Markdown deletes and rename-outs out of SKIP-ALL` | Change-record, rename, delete, and old-side attribution through an injected collector rather than Git. |
| Tier-1 static guard | `affected-runner-no-escape.test.ts` — `contains no subprocess, worker, dynamic-import, or embedded-script escape` | Prevents the direct matrix and its owned runtime dependencies from silently restoring process or worker escapes. |
| Vitest E2E | `affected-runner-boundary.test.ts` — `accepts CLI arguments and emits machine-readable JSON with a successful exit`; `collects committed, staged, unstaged, untracked, rename, and delete records and fails closed for an invalid base` | One real CLI process and one run-owned real-Git collection journey. |
| Complete Tier-1 run + direct policy | Guarded setup registers each fork; `GitTemplateHandoffReporter` certifies the complete canonical inventory at coordinator shutdown; `unit-lanes-scheduling.test.ts` — `certifies Git handoff only for the complete inventory with the resolved worker count` pins full-versus-focused behavior. The three probe files are canonical inventory markers, not focused certifiers. | Coordinator-only ten-command bootstrap; common path/digest; distinct process/pool/worker identities for the resolved worker count; immutable source; private writable copies; worker cleanup denial. |
| Tier-1 direct | `hindsight-provider.test.ts` — `dormant: no externalUrl ⇒ every hook is a no-op and no client is constructed`; `autoRecall and autoRetain disable their respective client-backed hooks`; `recall block shape: memories ⇒ one memory block; empty ⇒ no block`; `recall failure records a diagnostic and a later healthy call recovers`; `recallScope: 'project' sends a project tag filter; 'all' sends none`; `afterTurn retains a compact summary with the full auto-tag taxonomy`; `beforeCompact retains synchronously with kind:compaction` | Provider activation, recall/retain/compact policy, payloads, scope, and diagnostics without worker startup. |
| Tier-1 direct | `hindsight-provider.test.ts` — `UH-2: remote retain and queue persistence failure rejects with a sanitized diagnostic`; `retry queue: queue read failure rejects without replacing an unknown snapshot`; `unknown queue blocks both drains and status never reports it as empty`; `status preserves a valid stored empty queue`; `unreadable config is visible, sanitized, and cannot be overwritten`; `retry queue: successful durable enqueue remains non-fatal`; `retry queue: failed error-record write does not negate a durable enqueue`; `retry queue: drain head keeps the durable queue unchanged when save fails`; `retry queue: shutdown drain keeps all durable entries when save fails`; `retry queue: failure enqueues, cap drops oldest, drain head, status sharing, shutdown drain` | Queue durability, failure visibility, safe recovery, bounded retention, and sanitized diagnostics without worker startup. |
| Tier-1 direct | `hindsight-provider.test.ts` — `routes: dormant store ⇒ clean configured:false signals, no client constructed`; `routes recall: project scope uses the REAL ctx.projectId; absent ⇒ no project filter`; `routes config SET validates, persists, and redacts the secret` | Route configuration, project scope, persistence, and redaction without worker startup. |
| Tier-1 integration | `hindsight-external.test.ts` — `configured pack recalls and retains through ModuleHost and the host-store proxy` | One installed-provider worker wiring smoke. |
| Tier-1 provider bridge | `provider-bridge-extension.test.ts` — `forwards event.prompt read-only and returns a hidden custom dynamic-context message`; `forwards the compacted span to before-compact (not an empty body)`; `omits dynamic-context custom messages from beforeCompact spans` | `beforePrompt`/`beforeCompact` bridge routing and span construction. |
| Tier-1 integration | `provider-before-compact-api.test.ts` — `forwards a string span to the lifecycle hook and rejects non-string spans` | Real gateway before-compact API validation and lifecycle dispatch with session/project identity. |
| Tier-1 isolated lifecycle | `lifecycle-hub.test.ts` — `times out one provider without preventing later providers`; `reports thrown provider errors and continues` | Worker-backed provider timeout/error isolation and continuation. |
| Tier-1 client boundary | `hindsight-client.test.ts` — `throws HindsightError{kind:http,status} on non-2xx`; `throws HindsightError{kind:timeout} within budget on a slow server`; `throws HindsightError{kind:network} when the connection is refused`; `health() returns ok:false instead of throwing on a refused connection` | Real HTTP status, timeout, network-error, and health degradation behavior. |
| Tier-1 generic extension host | `extension-host-module-isolation.test.ts` — `a module whose TOP-LEVEL code spins forever (while(1)) is TERMINATED on timeout → 504`; `a while(1) CPU spin is TERMINATED on timeout → 504 (true cancellation, not a hung permit)`; `a thrown handler becomes a 500 (message preserved) and the host survives for the NEXT invoke`; `a synchronous process-level crash (e.g. a top-level throw on import) is isolated → ActionError`; `store.read preserves absent, present-empty, and error diagnostics across the MessagePort` | Worker timeout termination, crash survival, and structured-clone/store-proxy isolation. |
| Tier-1 generic extension host | `extension-host-isolation-config-invariant.test.ts` — `a dispatcher constructed WITHOUT an injected ModuleHost still isolates (no in-process path)`; `NO env var disables isolation — a pack-root ../ escape import stays rejected with every bypass knob set`; `a runaway while(1) is terminated regardless of env (the seam always runs in the worker)` | Isolation cannot be disabled or bypassed. |
| Tier-1 generic extension host | `extension-host-module-memory-isolation.test.ts` — `a handler that exceeds the heap cap crashes the worker → ActionError, not an unbounded parent alloc` | Worker OOM containment. |
| Tier-1 identity | `remote-state-identity.test.ts` — `collapses sibling worktrees by common dir and keeps execution namespaces apart`; `runs sandbox identity probes through the execution-aware Git adapter`; `marks repositories without origin local so callers can remain fetch-free`; `falls back to the compatible common-dir command when path-format is unavailable`; `remote-state-routes.test.ts` — `keeps genuine root and nested repositories bound to their exact PR targets` | Canonical repository/worktree identity, local-only classification, and the real route-level identity consumer. |
| Tier-1 native Git classification | `git-status-native-classification.test.ts` — `classifies only the known host outside-repository diagnostic as definitive`; `marks a host result partial and untracked-incomplete when porcelain fails`; `emits and parses a distinct container not-repository sentinel`; `keeps container mandatory-probe diagnostics retryable`; `marks successful container results partial when optional probes fail` | Native Git status classification semantics without making unrelated API fixtures own repositories. |
| Real-Git Tier-1 owner | `git-lifecycle-no-publication-real-git.test.ts` — `keeps configured-base creation, reuse, and recovery local-only`; `keeps two-repository configured-base creation and reuse local-only`; `pool claim does not recreate a previously deleted target remote`; `GoalManager merges a local child without recreating a deleted parent remote` | Real branch, remote, worktree, recovery, and local-only publication lifecycle. |
| Legacy Playwright E2E | `worktree-root-override.spec.ts` — `single-repo createWorktree honors worktreeRoot override on disk`; `multi-repo createWorktreeSet honors worktreeRoot override (claim + cleanup)` | Real on-disk worktree-root override for single- and multi-repository projects. |
| Legacy Playwright E2E | `unborn-worktree-session.spec.ts` — `regular session creation in an unborn repo settles without raw HEAD worktree failure` | Real unborn-repository worktree/session fallback. |

### Constraints and qualification

- The fixed three-worker cap, timeout budgets, and behavioral assertions were retained. Speed did not come from added retries, relaxed assertions, or higher concurrency.
- All focused rounds were first-attempt green. Qualification commands set `BOBBIT_V2_RETRY_FREE=1`; the affected E2E explicitly used `--retry=0`.
- A Tier-1 profile always includes the ten coordinator Git bootstrap commands. “Zero fixture Git” and “zero policy subprocesses” mean no launches beyond that shared bootstrap.
- The first affected round includes normal cold esbuild startup; rounds two and three had no incomplete children. Reporting all three avoids presenting the warm minimum as the result.
- The old three-worker/30-command topology is established by the exact baseline's worker lifecycle and ten-command bootstrap contract; the old aggregate profiler did not separately attribute those pre-guard command arguments.
- These are native Windows slice measurements, not macOS/Linux performance claims. Cross-platform behavior is protected by the same registered tests and the full gates rather than inferred from Windows timings.
- After inventory and scheduling fixes, the full implementation gate passed build, check, unit, browser, E2E, conformance, code, and security verification. The focused profiles supplement that behavioral proof; they do not replace it.

## Retained measurements

### Quiet DOM lane

The clean DOM profile passed all 1,267 tests in 103.0 seconds with one worker.

| Executable | Spawned | Cumulative wall | Maximum |
|---|---:|---:|---:|
| Vitest `forks.js` worker | 144 | 105.9 s | 3.8 s |
| `node.exe` lane process | 1 | 103.0 s | 103.0 s |
| `cmd.exe` | 1 | 0.1 s | 0.1 s |

Transform was 9.55 seconds, import 28.97 seconds, tests 22.37 seconds, and environment work 33.58 seconds. Per-file DOM isolation is behaviorally required, and the profile shows that a one-worker `forks` pool launches one short-lived process per file. A `vmForks` experiment removed those launches but failed because a simulated `localStorage` security error leaked between files, so it was reverted rather than weakening isolation.

Raw report: `.profiles/testing-v2/windows-process-profile/2026-07-14T20-32-35-109Z/report.{json,md}`.

### Loaded integration lane

A deliberately loaded four-worker profile (eight ledger workers were already reserved by another suite) completed in 491.8 seconds and failed 19 tests. It is retained as hotspot evidence, not acceptance evidence.

| Executable | Spawned | Successful | Failed/error | Cumulative wall | Maximum |
|---|---:|---:|---:|---:|---:|
| `git` | 970 | 84 | 886 | 68.6 s | 4.5 s |
| `bash.exe` | 8 | 3 | 5 | 16.2 s | 2.5 s |
| `powershell.exe` | 7 | 7 | 0 | 15.3 s | 4.3 s |
| `taskkill` | 7 | 1 | 6 | 7.5 s | 1.5 s |
| `cmd.exe` | 7 | 7 | 0 | 0.4 s | 0.1 s |

The 970 direct Git invocations are the dominant measured process-amplification target. Most failures are expected negative probes against non-repositories, so Step 2 must remove or memoize those probes rather than merely making Git faster. Transform was 126.21 seconds, import 43.72 seconds, and test work 1,682.92 cumulative worker-seconds.

Raw report: `.profiles/testing-v2/windows-process-profile/2026-07-14T19-56-11-552Z/report.{json,md}`.

## Historical Step 2 experiment

The broad relocations below describe the July 14 profiling experiment. They were later restored to tier 1. The shipped execution map keeps `team-manager.test.ts`, `marketplace-install.test.ts`, and the native real-filesystem `orphan-tool-result-rehydration-boundaries.test.ts` in Vitest E2E; their seam-based decision suites remain in tier 1.

- Moved real-Git/worktree-heavy maintenance, multi-repository goal, staff patch/reassign, verification restart, and retained-artifact command tests to the real-fidelity e2e project.
- Replaced unnecessary repository fixtures with ordinary project directories in three API-state suites.
- Moved real `npm pack --dry-run` execution behind `BOBBIT_ASSERT_BUNDLE=1` and into the bundle check while retaining manifest assertions in unit tests.
- Kept the existing non-spawning verification runner for API/state-oriented command-step suites.

These changes preserve real-fidelity owners rather than deleting coverage. The profile shows that broad negative Git probing remains the next high-impact Step 2 cluster.

## Historical Step 3 result

The integration lane then built one content-addressed server runtime with esbuild and shared it across workers. Publication is atomic and fail-closed; the manifest hashes both bundle and source map, `import.meta.url` is rewritten per source module without modifying generated child-module strings, and namespace/boot parity is validated before publication. Identity-sensitive integration tests use the shared runtime, while source-only store tests continue to import source modules directly so they cannot initialize the bundled gateway before the fork fixture configures its environment.

A 14-file runtime smoke passed 50/50 tests in 25.42 seconds. A focused identity regression passed 47/47 assertions; disabling Vitest console interception then removed the two `onUserConsoleLog` teardown RPC errors in a 9/9 regression run.

## Historical status

At the end of the July 14 profiling session, the clean DOM lane was under 180 seconds, while integration still performed hundreds of avoidable Git probes. This is retained as historical evidence only; current unit-stage qualification is recorded in `fast-gate-progress.md` and uses direct Vitest projects with no ledger.
