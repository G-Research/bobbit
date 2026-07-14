# Workflow-gate unit-test performance plan

**Date:** 2026-07-14  
**Scope:** `npm run test:unit`, with emphasis on workflow, gate, and verification tests

## Decision

Do not tune worker counts first. The remaining workflow-gate cost is primarily test work that crosses real process, timer, filesystem, git, HTTP, and WebSocket boundaries. Move behavioral coverage behind dependency-injected fakes in the unit tier, and keep a small, explicit real-boundary matrix in browser/e2e.

The desired end state is:

- unit tests run with `retry: 0`, fake clocks, in-memory stores, in-process event sinks, fenced fetch, fake git/process runners, and no unplanned child processes;
- browser/e2e retain real local gateway, socket, filesystem, git/worktree, command-process, restart, cancellation, and artifact behavior;
- manual integration remains the only tier allowed to call real LLM/provider services;
- coverage is preserved by behavior-to-tier mapping and contract tests, not by retaining every current route-level scenario.

## Current execution path

The workflow gate runs:

```text
.bobbit/config/project.yaml
  unit: npm run test:unit
    -> npm run test:v2:core:lanes
      -> scripts/testing-v2/run-unit-lanes.mjs
        -> core + integration + DOM Vitest lanes
```

Current inventory is 547 core files, 186 integration files, and 144 DOM files (877 files total, about 7,575 tests). The lane runner normally overlaps three independent lanes with two forks each. Under shared-machine pressure, its ledger reduces the grant and queues lanes.

## Evidence

### Stable historical measurements

The committed profiler reports provide the best comparable evidence available:

| Measurement | Result | Interpretation |
|---|---:|---|
| Latest committed full-suite profile | 606.5 s wall, 859 files, 7,466 tests | Older than the latest relocation and fixture work; use as a reference, not a current baseline. |
| Summed module/file runtime | 40.9 min | Parallel work, so intentionally larger than wall time. |
| Summed hook time | 9.6 min | Repo-heavy setup and cleanup were dominant contributors. |
| Summed collect/import time | 4.4 min | Small tests repeatedly import broad server graphs. |
| Full integration work | about 478 summed test-seconds | About 88% of the measured integration work; transform/collect was about 67 s and gateway runtime boot about 3 s across six forks. |
| Gateway runtime boot | about 470 ms per fork | Already a fork-scoped singleton; not a per-test boot problem. |
| Server transform/collect | about 11 s per cold fork | A fixed process cost, but smaller than the test-work bucket. |

The slow measured workflow-gate cases include two `verification-core` cases at 5.53 s and 5.29 s, and two `gate-inspect-slicing` cases at 4.88 s and 3.34 s. They drive command workflows and then wait on REST/WS-observable state.

### Current structural inventory

A lexical audit of filenames with `gate`, `gates`, `verification`, or `workflow` as a token found 64 files and approximately 573 direct `test()`/`it()` calls:

| Cohort | Files | Approx. tests | `setTimeout` | `waitFor`/`pollUntil` | temp dirs | direct git execs | child-process calls | `node -e` commands |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Core | 45 | 469 | 43 | 0 | 27 | 25 | 5 | 18 |
| Integration | 19 | 104 | 18 | 32 | 5 | 5 | 0 | 19 |
| **Total** | **64** | **573** | **61** | **32** | **32** | **30** | **5** | **37** |

These are source-occurrence counts, not timings, and deliberately exclude broader files whose names do not identify them as workflow-gate tests. They are useful as a migration surface and a regression metric.

The largest residual boundary surfaces are:

1. `verification-command-restart-lifecycle.test.ts` — 19 cases and 16 real timer calls, with real Node child processes.
2. `verification-command-runner-contract.test.ts` — a matrix of real shell/Node launches plus real timeout and cancellation waits.
3. `verification-basebranch-regression.test.ts` and `verification-goal-sync-nondestructive.test.ts` — repeated real repository construction and git subprocesses.
4. `verification-core.test.ts` — broad REST/WS lifecycle coverage with polling and real command behavior.
5. `gate-inspect-slicing.test.ts` — real commands generate large output and artifacts, followed by filesystem search and polling.
6. `verification-harness-timeout.test.ts` and `verification-reminder-race.test.ts` — timer/process/state-machine behavior mixed with real filesystem state.

### Existing seams already worth keeping

The suite is not starting from zero:

- the integration gateway is already one singleton per Vitest fork;
- gateway dependencies already include `Clock`, fenced `CommandRunner`, fenced fetch, an in-process agent bridge, and `VerificationCommandRunner`;
- nine integration files already use `v2-integration-fake` and the non-spawning command-step runner;
- twelve irreducibly real integration specs have already moved from unit to e2e;
- store tests have started moving from temp directories to memfs;
- real external network access is fenced.

The next work should extend these patterns instead of adding a second harness.

### Measurement attempted for this analysis

A fresh subtree measurement was started with:

```bash
node scripts/testing-v2/measure-subtree.mjs unit-baseline .profiles/testing-v2/unit-baseline.json -- npm run test:unit
```

It was stopped because it was not a valid isolated baseline: the ledger granted only four workers while total reservations were already 22/24, only core and integration could start, DOM was queued, and integration had completed zero files after 120 seconds. This confirms that shared-host wall time is not comparable without recording ledger/load state; it does not replace the committed measurements above.

## Where time and CPU are spent

### 1. Real verification command execution

Several unit-gate tests use shell commands merely as deterministic pass/fail/output fixtures. Each command creates a shell or Node process, crosses pipe/event boundaries, and may wait for OS scheduling and kill escalation. This is the highest-value workflow-specific target because it consumes CPU and increases flake probability under concurrent goals.

The fake command runner exists, but only a narrow file allowlist uses it. Meanwhile `verification-core`, `gate-inspect-slicing`, restart/durability tests, and the real/fake contract matrix keep substantial real-process work in unit.

### 2. Wall-clock waits and polling

Real timers are used to create observable running windows, cancellation windows, retries, reminders, and timeouts. REST/WS tests then poll every 50–100 ms or wait with 30–90 s ceilings. Under CPU starvation, assertions remain correct but delivery misses the wall deadline; `retry: 3` currently masks some of these failures.

A manual clock is present at gateway level, but production code still has direct `Date.now()`, filesystem mtime reads, and timer-based process identity/cleanup paths. Tests also use real timers directly instead of advancing an injected scheduler.

### 3. Filesystem and git fixtures

Persistence, diagnostics, artifact, restart, and base-branch scenarios create temp trees and repositories. Real git is appropriate for a contract/e2e sample, not for every state-machine branch. Most behavior needs only scripted command results, an in-memory state store, and deterministic file metadata.

### 4. HTTP/WS breadth

The shared in-process gateway avoids per-test boot, but many semantic cases still traverse loopback HTTP and WebSocket delivery, create goals/workflows, wait for broadcasts, and perform scoped cleanup. This is useful for route/event contracts; it is expensive duplication for phase ordering, gate transitions, retry policy, and result aggregation that can be tested directly through services and an event recorder.

### 5. Transform/collection

Every integration fork pays about 11 seconds to transform and collect the broad server graph. Deferring imports and narrowing module boundaries help. A server prebundle could reduce this fixed cost, but an earlier prototype found unsafe `import.meta.url` path-resolution differences. It should follow removal of real test work, not precede it.

### 6. Scheduling and retries

Lane overlap is already near the safe Vitest 3/Windows limit. More shards caused diminishing or negative returns. `retry: 3` converts starvation into extra CPU and hides the determinism signal. Worker/ledger tuning cannot make I/O-heavy tests deterministic; it should be revisited only after the unit workload is made fake-first.

## Migration plan

### Phase 0 — establish an uncontended, attributable baseline

1. Wait for `node scripts/testing-v2/ledger.mjs --status` to show no unrelated reservations, or run on an isolated worker.
2. Run three repetitions, with `retry: 0`, of:

   ```bash
   node scripts/testing-v2/measure-subtree.mjs unit-rN .profiles/testing-v2/unit-rN.json -- npm run test:unit
   npm run test:v2:profile-hooks -- --top 50
   ```

3. Profile the workflow-gate cohort separately by project so fake and real projects are not conflated.
4. Record median wall, subtree CPU, peak process count, lane wall, summed test time, transform/collect, residual, cleanup counters, spawned-command count, and retry count.
5. Produce a ranked table by file with boundary tags: process, timer/poll, filesystem, git, socket, broad import.

Raw profiles remain under `.profiles/`; only the distilled comparison is committed.

### Phase 1 — make command and time behavior fake-first

1. Replace the file allowlist with explicit per-test fixture selection: `realCommandSteps()` only for real-boundary tests; fake is the unit default.
2. Replace shell-string interpretation as the primary fake API with a scripted runner queue keyed by invocation. Each script returns stdout chunks, stderr chunks, exit code, delay, timeout, cancellation, and error. Keep the current fail-closed behavior for unexpected invocations.
3. Convert `verification-core` semantic cases to the scripted runner. Preserve event order, frame caps, status transitions, error-pattern logic, and active-verification cleanup assertions.
4. Convert `gate-inspect-slicing` semantic output/log cases to injected streams and an in-memory artifact store. Keep one real artifact-producing command in e2e.
5. Replace scheduling tests' real sleeps with deferred promises/latches. Replace timeout/reminder/retry windows with the injected clock and explicit `advanceBy()`/`runUntilIdle()`.
6. Move the real command-runner matrix, PID/tree-kill, detached restart recovery, and OS cancellation cases to e2e. Keep a small default-real wiring guard in core.

**Phase acceptance:** no real verification shell/Node process is spawned by unit workflow-gate tests; unexpected runner use fails immediately; all migrated assertions remain mapped to either a unit case or a real e2e contract.

### Phase 2 — inject persistence, process identity, and git

1. Introduce narrow interfaces rather than a general mock bag:
   - `VerificationStateStore` for active-verification load/save;
   - `VerificationArtifactStore` for logs, retained diagnostics, files, stat/mtime, and cleanup;
   - `ProcessInspector`/`ProcessTerminator` for PID identity, liveness, and tree kill;
   - continue using `CommandRunner` for git, but supply a strict scripted implementation in unit.
2. Use memfs or purpose-built in-memory stores for state/restart/diagnostic tests.
3. Convert base-ref, sync decision, branch safety, and prompt-building branches to scripted git results.
4. Retain e2e contracts for a local bare remote, ahead/behind/diverged repositories, safe fast-forward, protected-push refusal, persistence across real restart, and artifact retention on disk.

**Phase acceptance:** the workflow-gate unit cohort has no direct `mkdtemp`, real git subprocess, or production-path filesystem access except dedicated adapter contract tests that run in e2e.

### Phase 3 — reduce route/socket duplication

1. Extract or expose a service-level gate-signalling API that returns events/results without opening sockets.
2. Test phase ordering, dependency enforcement, optional steps, cancellation state, retry policy, and aggregation through the service plus an in-memory event recorder.
3. Keep a compact integration matrix for REST status/error shape and WS event ordering.
4. Keep browser journeys for signal → progress → pass/fail UI, cancel/reset, reload/reconnect, archived/history rendering, and artifact inspection.

**Phase acceptance:** each REST/WS test proves a transport contract or cross-component interaction; no route-level scenario exists only to retest pure verification logic.

### Phase 4 — optimize fixed process cost and scheduling

Only after Phases 1–3:

1. Re-profile transform/collect. If it is then a material share, evaluate a safe server prebundle with parity guards for defaults discovery, pack paths, generated AIGW metadata, verification exports, and coverage mapping.
2. Restore `retry: 0` in committed config.
3. Recalculate lane weights from the new profile, then evaluate integration sharding or worker changes. Do not exceed the Windows-safe per-process fork cap without upgrading Vitest and proving the RPC issue is gone.
4. Run one, two, and three concurrent full gates to verify both determinism and ledger accounting.

## Fidelity matrix

| Behavior | Unit tier | Browser/e2e tier |
|---|---|---|
| Gate dependency and phase logic | Pure services/stores, fake clock | One representative full workflow |
| Command pass/fail/output/timeout/cancel semantics | Scripted `VerificationCommandRunner` | Real shell/Node, stream, timeout, tree kill |
| Persistence/restart decisions | In-memory state/artifact stores | Real disk + gateway restart |
| Git branch/sync/push policy | Strict scripted `CommandRunner` | Local repositories and bare remote |
| REST status/error schema | Small in-process route contract | Representative full gateway request |
| WS event ordering | Event recorder plus compact socket contract | Browser/live reconnect path |
| Artifact slicing/retention | Injected byte streams and memfs | Real files, Playwright-style artifacts |
| LLM/reviewer outcomes | Mock agent/bridge | Mocked in e2e; real provider only manual |
| Docker/sandbox execution | Mock executor | Real local Docker in e2e when available |

## Coverage-preservation rules

- Create a behavior ledger before moving any test: source case, invariant, new unit case, real-boundary case.
- A fake must be fail-closed and have a focused parity contract against the real adapter.
- Do not replace observable-state waits with larger timeouts or retries.
- Do not count unchanged test totals as proof; use assertions, route/event contracts, and mutation/regression cases.
- Each real boundary needs at least success, failure, and cleanup/cancellation coverage where applicable.
- Browser/e2e stays external-service-free: only local git, processes, sockets, filesystem, Docker, and MCP subprocesses are real.

## Success criteria

Measure against the Phase 0 median on the same machine and worker grant:

1. Three consecutive `npm run test:unit` runs pass with `retry: 0` and no worker-RPC downgrade.
2. Workflow-gate cohort summed runtime and subtree CPU fall by at least 50%.
3. Full unit-gate median wall and CPU both improve; no lane regresses by more than 10% without an explained coverage increase.
4. Unit workflow-gate tests spawn zero real command-step processes and perform zero real git/network/filesystem I/O outside explicitly classified adapter contracts.
5. E2e retains green real-boundary scenarios for command lifecycle, restart persistence, git sync, artifacts, REST/WS, and browser gate progress.
6. Two concurrent goal gates complete without test retries or starvation timeouts while ledger reservations remain within the core budget.

## Recommended implementation order

1. Scripted command runner + fake-clock conversion for `verification-core` and command scheduling.
2. Split `gate-inspect-slicing` into semantic unit coverage and one real artifact e2e path.
3. Move real process lifecycle/runner contract tests to e2e.
4. Add verification state/artifact/process adapters and migrate restart/timeout tests.
5. Convert real-git workflow tests to scripted unit decisions plus local-git e2e contracts.
6. Collapse duplicated REST/WS semantic scenarios.
7. Restore `retry: 0`, re-profile, then tune lanes or consider prebundling.

This order attacks the measured workflow-specific CPU and flake sources before the lower-value fixed transform cost, while preserving real integration evidence at the boundaries where mocks cannot prove correctness.
