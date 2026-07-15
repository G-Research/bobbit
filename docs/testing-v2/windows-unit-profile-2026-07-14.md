# Windows unit profile — 2026-07-14

## Configuration

- Windows x64, Node 24.13.1, Vitest 4.1.10.
- Production three-suite lane allocation: core=3, integration=4, DOM=1.
- Child processes measured by `scripts/testing-v2/profile-windows-unit.mjs`; arguments and environment values were not captured.
- The profiler refuses a non-empty concurrency ledger by default. `--allow-loaded` is required to record an explicitly loaded run.

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

## Step 2 changes included here

- Moved real-Git/worktree-heavy maintenance, multi-repository goal, staff patch/reassign, verification restart, and retained-artifact command tests to the real-fidelity e2e project.
- Replaced unnecessary repository fixtures with ordinary project directories in three API-state suites.
- Moved real `npm pack --dry-run` execution behind `BOBBIT_ASSERT_BUNDLE=1` and into the bundle check while retaining manifest assertions in unit tests.
- Kept the existing non-spawning verification runner for API/state-oriented command-step suites.

These changes preserve real-fidelity owners rather than deleting coverage. The profile shows that broad negative Git probing remains the next high-impact Step 2 cluster.

## Step 3 result

The integration lane now builds one content-addressed server runtime with esbuild and shares it across workers. Publication is atomic and fail-closed; the manifest hashes both bundle and source map, `import.meta.url` is rewritten per source module without modifying generated child-module strings, and namespace/boot parity is validated before publication. Identity-sensitive integration tests use the shared runtime, while source-only store tests continue to import source modules directly so they cannot initialize the bundled gateway before the fork fixture configures its environment.

A 14-file runtime smoke passed 50/50 tests in 25.42 seconds. A focused identity regression passed 47/47 assertions; disabling Vitest console interception then removed the two `onUserConsoleLog` teardown RPC errors in a 9/9 regression run.

## Status

Steps 1–3 are implemented and the profiler now exposes the remaining bottleneck. Final three-suite acceptance is not yet met: the clean DOM lane is under 180 seconds, but integration still performs hundreds of avoidable Git probes and no uncontaminated core/integration acceptance profile was available during this session because other eight-worker suites repeatedly occupied the shared ledger.
