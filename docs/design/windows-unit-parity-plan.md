# Windows Unit-Suite Parity Plan

> [!CAUTION]
> **Superseded historical plan.** This document is preserved as planning evidence and does not describe the shipped unit gate. The current architecture runs one direct Vitest process with a fixed three-worker cap per suite and no unit ledger, lane orchestration, cost sharding, or gateway-boot lease. See the [unit gate operating model](../testing-v2/unit-gate.md) for the current contract and the [fast-gate progress log](../testing-v2/fast-gate-progress.md) for qualification evidence. All eight-worker, `3/4/1` lane allocation, ledger peak of 24 or lower, weighted scheduler, and acceptance statements below are historical and must not guide new work.

## Historical Goal

Bring a Windows `npm run test:unit` run to the Linux-class target of under three minutes while preserving three-way concurrency on a 24-core host:

- three suites start without suite-level or lane-level queueing;
- each suite receives eight ledger-governed workers;
- zero Vitest worker-RPC errors;
- zero hidden retries or tolerated infrastructure failures;
- no timeout increases used as a performance fix;
- Windows-only process and filesystem fidelity remains covered by a small canonical e2e surface.

## Current evidence

- An unmitigated Vitest 3 run on Windows failed after 1097.6 seconds with 509 `onTaskUpdate` RPC timeouts.
- Vitest 4.1.10 removes that transport failure; loaded runs produced zero worker-RPC timeouts.
- The isolated Vitest 4 DOM lane passes 1,267 tests in 58.8 seconds on Windows, proving the test framework itself can meet the target.
- Slow/failing loaded tests cluster around real `git.exe`, `cmd.exe`/Git Bash, short-lived Node probes, and integration teardown. These subprocesses are not represented by the ledger's worker count.
- Existing profiling found gateway runtime boot is approximately 470 ms. Source transform/import and real subprocess work dominate.

## Implementation status (2026-07-14)

Steps 1–3 are implemented. The retained profile and current limitations are in [`docs/testing-v2/windows-unit-profile-2026-07-14.md`](../testing-v2/windows-unit-profile-2026-07-14.md). The clean DOM lane passes under the 180-second target; integration profiling identified 970 direct Git invocations as the next dominant Step 2 cluster. The final three-suite acceptance matrix remains pending.

## Step 1 — Measure the Windows delta

Add a committed child-process profiler that can run each unit lane independently and record, per executable:

- spawn count;
- successful, failed, and timed-out exits;
- cumulative and maximum wall time;
- peak concurrent children;
- lane transform/import/test wall time from Vitest output.

The profiler must:

- instrument descendants through a Node preload rather than editing production code;
- write per-process JSONL files to avoid concurrent append corruption;
- preserve exit codes and arguments exactly;
- redact arguments and environment values from the report;
- work on non-Windows hosts even though Windows is the target.

Run and retain reports for `core`, `integration`, and `dom`. Use the reports—not assumptions—to choose Step 2 targets.

## Step 2 — Remove shell/process amplification from unit tests

Prioritize measured hotspots:

1. Route verification tests that assert state/events/persistence through the existing injected non-spawning command-step runner.
2. Keep real command lifecycle/cancellation/process-tree fidelity in a small canonical project or the e2e tier.
3. Split real-Git tests into pure argv/refspec/state decisions plus one canonical real-Git test per contract.
4. Replace `.cmd` wrappers with injected command/spawn recorders where the assertion concerns invocation rather than Windows shell fidelity.
5. Move `npm pack` execution to the bundle check; unit tests should validate the package manifest/selection logic without launching `npm.cmd`.
6. Keep process-per-probe only where Pi-extension security or timeout isolation genuinely requires it.

Every relocation or fake must retain a canonical real-fidelity owner in `tests2/tests-map.json`. No assertion may be weakened merely to improve wall time.

## Step 3 — Prebundle the server test graph once

Create a deterministic esbuild prebundle for the integration harness:

- build once per suite/configuration, not once per Vitest worker;
- externalize packages while bundling Bobbit server source;
- preserve source maps and Node ESM behavior;
- provide explicit shims for `import.meta.url`/path-sensitive runtime code;
- key the artifact by source/config content so stale bundles cannot be reused;
- make integration workers import the bundle while core source tests continue to exercise source modules;
- add parity tests comparing source and bundled exports/boot behavior;
- fail closed to source imports during local diagnosis, but never silently run a stale or partial bundle.

Target: reduce integration transform/import startup from the previously measured ~11 seconds per worker toward the ~0.4-second bundled-import prototype.

## Scheduling after Steps 1–3

Keep the Vitest 4 weighted no-queue scheduler. Rebalance `core/integration/DOM` only from measured Windows lane costs. The starting allocation for an eight-worker suite is `3/4/1`.

Do not use broader global leases as the primary speed fix: leases turn contention into queues. Eliminate unnecessary work first.

## Historical Acceptance

From three independent worktrees, run three concurrent suites for three repetitions:

- 9/9 green;
- every suite ≤180 seconds;
- all lanes start immediately;
- ledger peak ≤24 workers and three suites receive 8 workers each;
- zero worker-RPC errors;
- zero retries in the acceptance run;
- no timeout changes;
- child-process count and cumulative child-process wall time materially reduced from Step 1 baseline;
- Windows command/Git/process fidelity remains represented in the e2e tier.

## Execution order

1. Land profiler and baseline reports.
2. Remove the largest measured shell/Git amplification, reprofile after each cluster.
3. Land the integration prebundle with parity pins.
4. Rebalance lane weights from the new profiles.
5. Run the three-way acceptance matrix.
