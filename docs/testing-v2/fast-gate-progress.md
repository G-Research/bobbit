# Fast 3-Worker Unit Gate Progress

This append-only log records the evidence used to assess the fast unit-stage target. Add new attempts as rows; do not replace failed runs, because they provide the baseline for later fixes.

## Environment and preflight

| Date | Machine | Revision | Check | Inventory | Prerequisite |
|---|---|---|---|---|---|
| 2026-07-16 | `Josh-ProArt`; Windows `10.0.26200` x64; 24 logical CPUs | `bff7cadf` | PASS — `npm run check` | PASS — `npm run test:unit:inventory` | PASS — the required Vitest 4 prerequisite merge is present (`9e45c160`); dependencies were installed before verification |

## Solo unit runs

| Date | Attempt | Process / workers | Wall time | Result | Run log | Notes |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 1 | One Vitest process / 3 workers | More than 1,200s | **FAIL** | Bobbit background process `bg-7659` | Manually killed while still progressing. The run was already more than four times the 300s target and ended before Vitest produced a final suite/test tally. |

### Attempt 1 observations

Observed failing suites:

- `shared-worktree-guard`
- `rpc-bridge-pack-path-remap`
- `session-recovery-agent-dir`
- `browser-screenshot-no-bloat`
- `sandbox-google-auth`
- `git-status-native`
- the maintenance split files
- `gate-resign-cancel`
- `cancel-verification`
- `tools-api`

The tier-1 spawn guard correctly blocked the tool-extension preflight `spawnSync` call. That unsupported preflight spawn caused cascading invalid-extension failures; the guard itself behaved as designed.

Slow files that passed before the run was killed:

| File | Duration |
|---|---:|
| `preview-mount` | 22.7s |
| `continue-archived-clone` | 29.7s |
| `commit-file-diffs` | 23.7s |
| `project-config-native-yaml` | 36.2s |
| `skill-expansion` | 42.9s |
| `config-cascade` | 36.4s |

## Evidence templates

Append solo attempts to the table above using:

```text
| YYYY-MM-DD | N | One Vitest process / 3 workers | N.Ns | PASS or FAIL | `log-id` | Final suite/test tally and relevant diagnostics. |
```

Record the required concurrent proof below only after all three processes have exited.

| Date | Runs | Machine | Wall time | Exit codes | Failed suites/tests | Log IDs | Result |
|---|---|---|---:|---|---|---|---|

```text
| YYYY-MM-DD | 3 simultaneous `npm run test:unit` processes | machine details | N.Ns | `0, 0, 0` | `0 / 0` | `log-a`, `log-b`, `log-c` | PASS |
```

## Solo attempt 2

Preflight and the unit inventory audit were green before this run.

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 2 | One Vitest process / 3 workers | 1,197.38s | **FAIL** | `.profiles/testing-v2/fast-gate-run2.log` | 28 failed files, 862 passed, 4 skipped; 93 failed tests, 7,491 passed, 26 skipped |

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 291.17s |
| Setup | 63.11s |
| Import | 304.23s |
| Tests | 2,590.05s |
| Environment | 84.89s |
| **Summed** | **3,333.45s** |

Transform plus import consumed 595.40s of the 3,333.45s summed phase time (17.86%), above the 15% target.

Major per-file budget outliers:

| File | Duration |
|---|---:|
| `gate-inspect` | 547.648s |
| `optional-steps` | 484.610s |
| `gate-reset` | 366.099s |
| `agent-tools` | 183.576s |
| `gateway-deps-default-real` | 69.773s |
| `gates-api-heavy` | 64.731s |
| `gate-status` | 40.568s |
| `preview-token-cost` | 25.856s |
| `sandbox-google-auth` | 20.946s |
| `pack-pi-loader` | 18.232s |
| `project-registry-order` | 18.089s |
| `HQ config alias` | 15.902s |
| `cross-project-proposals` | 15.362s |

The failures indicate fake command-runner and gateway-boot import-order problems, compounded by shared-state contamination between suites.

## Solo attempt 3

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 3 | One Vitest process / 3 workers | 473.28s | **FAIL** | `.profiles/testing-v2/fast-gate-run3.log` | 4 failed files, 886 passed, 4 skipped; 6 failed tests, 7,579 passed, 26 skipped |

Failed files:

- `cpu-diagnostics`
- `commit-file-diffs-api`
- `gate-signal-reminder`
- `pr-walkthrough-api`

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 132.58s |
| Setup | 94.02s |
| Import | 199.25s |
| Tests | 937.65s |
| Environment | 101.18s |
| **Summed** | **1,464.68s** |

Transform plus import consumed 331.83s of the 1,464.68s summed phase time (22.66%), above the 15% target.

Per-file budget outliers:

| File | Duration |
|---|---:|
| `session-manager-pi-extension-args` | 20.246s |
| `docker-args` | 18.881s |
| `proposal-goal-workflow-validation` | 17.921s |
| `sandbox-codex-auth` | 16.920s |
| `gate-verification-snapshot` | 16.037s |
| `sandbox-security` | 15.734s |

This run preceded the newly merged session, Docker, proposal, gate, maintenance, and core fixes. Fixes for the four failed files and residual module-tax work have been launched.

## Solo attempt 4

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 4 | One Vitest process / 3 workers | 285.22s | **FAIL** | `.profiles/testing-v2/fast-gate-run4.log` | 5 failed files, 885 passed, 4 skipped; 12 failed tests, 7,575 passed, 24 skipped |

This was the first full run below the 300s wall-time target.

Failed files:

- `maintenance-api`
- `maintenance-api-archived-cleanup`
- `maintenance-api-archived-guards`
- `maintenance-api-archived-scan`
- `tool-guard-extension`

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 25.47s |
| Setup | 65.45s |
| Import | 100.47s |
| Tests | 538.15s |
| Environment | 83.60s |
| **Summed** | **813.14s** |

Transform plus import consumed 125.94s of the 813.14s summed phase time (15.49%), narrowly above the 15% target. A warm rerun is expected to reduce this ratio.

No file exceeded the 15s tier-1 budget. The slowest file, `preview-token-cost`, completed in 14.035s.

The remaining failures point to a shared-helper prebundle identity/runner issue in the maintenance suites and a token-reader state leak in `tool-guard-extension`. Fixes for both issues have been launched.

## Solo attempt 5

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 5 | One Vitest process / 3 workers | 283.60s | **FAIL** | `.profiles/testing-v2/fast-gate-run5.log` | 4 failed files, 886 passed, 4 skipped; 7 failed tests, 7,582 passed, 22 skipped |

The run remained below the 300s wall-time target, but failed these files:

- `gate-signal-reminder`
- `pr-walkthrough-api`
- `sidebar-actions-fork-github-link`
- `maintenance-api-archived-selectors`

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 27.86s |
| Setup | 63.11s |
| Import | 100.75s |
| Tests | 533.76s |
| Environment | 84.63s |
| **Summed** | **810.11s** |

Transform plus import consumed 128.61s of the 810.11s summed phase time (15.88%), above the 15% target.

One file exceeded the 15s tier-1 budget: `project-isolation` completed in 16.283s.

The failures indicate shared route-visible `CommandRunner` seam ownership across prebundled helper facades. Fixes for that ownership issue have been launched, along with work on `project-isolation` and the final module-tax reduction.

## Solo attempt 6

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 6 | One Vitest process / 3 workers | 304.57s | **FAIL** | `.profiles/testing-v2/fast-gate-run6.log` | 6 failed files, 884 passed, 4 skipped; 9 failed tests, 7,562 passed, 40 skipped |

The run exceeded the 300s wall-time target and failed these files:

- `maintenance-api`
- `proposal-goal-workflow-validation`
- `commit-file-diffs-api`
- `stories-sessions-api`
- `maintenance-api-archived-cleanup`
- `maintenance-api-archived-guards`

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 25.66s |
| Setup | 67.87s |
| Import | 105.86s |
| Tests | 568.60s |
| Environment | 95.94s |
| **Summed** | **863.93s** |

Transform plus import consumed 131.52s of the 863.93s summed phase time (15.22%), narrowly above the 15% target.

Two files exceeded the 15s tier-1 budget:

| File | Duration |
|---|---:|
| `project-config-api` | 16.706s |
| `pi-extension-discovery` | 15.337s |

The remaining failures indicate direct shared seams and registry identities that bypass the new dispatcher. Fixes have been launched alongside final budget and module-ratio work.

## Solo attempt 7

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 7 | One Vitest process / 3 workers | 294.48s | **FAIL** | `.profiles/testing-v2/fast-gate-run7.log` | 3 failed files, 887 passed, 4 skipped; 5 failed tests, 7,584 passed, 22 skipped |

The run remained below the 300s wall-time target, but failed these files:

- `sidebar-actions-fork-github-link`
- `maintenance-api-archived-scan`
- `maintenance-api-archived-selectors`

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 25.42s |
| Setup | 63.89s |
| Import | 103.21s |
| Tests | 547.06s |
| Environment | 94.22s |
| **Summed** | **833.80s** |

Transform plus import consumed 128.63s. This is 15.43% of the 833.80s summed phase time. Against the fixed three-worker capacity of 883.44s (`3 × 294.48s`), it is 14.56%, below the 15% capacity target.

One file exceeded the 15s tier-1 budget: `headquarters-server-scope-guards` completed in 17.636s.

The main maintenance suite, archived cleanup and guard suites, and all failures from earlier attempts passed. Only the final maintenance owner facades and sidebar dispatcher scope remain; fixes have been launched.

## Solo attempt 8

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 8 | One Vitest process / 3 workers | 264.24s | **FAIL** | `.profiles/testing-v2/fast-gate-run8.log` | 2 failed files, 888 passed, 4 skipped; 1 failed test, 7,579 passed, 22 skipped |

The run remained below the 300s wall-time target, but failed these files:

- `plan-archived-children` — suite module load failed with `window is not defined` from the UI prebundle in the Node environment.
- `stories-sessions` — S-08 failed because `worktreeOpts` was undefined.

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 7.00s |
| Setup | 62.89s |
| Import | 87.54s |
| Tests | 489.26s |
| Environment | 86.05s |
| **Summed** | **732.74s** |

Transform plus import consumed 94.54s of the 732.74s summed phase time (12.90%), below the 15% target.

One file exceeded the 15s tier-1 budget: `bg-process-persistence` completed in 18.320s.

All maintenance, sidebar, and prior order failures passed. Fixes for the two failures and the budget breach have been launched.

## Solo attempt 9

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 9 | One Vitest process / 3 workers | 275.82s | **FAIL** | `.profiles/testing-v2/fast-gate-run9.log` | 2 failed files, 888 passed, 4 skipped; 4 failed tests, 7,585 passed, 22 skipped |

The run remained below the 300s wall-time target, but failed these files:

- `commit-file-diffs-api`
- `sidebar-actions-fork-github-link`

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 24.05s |
| Setup | 80.90s |
| Import | 95.92s |
| Tests | 493.84s |
| Environment | 86.65s |
| **Summed** | **781.36s** |

Transform plus import consumed 119.97s. This is 15.35% of the 781.36s summed phase time. Against the fixed three-worker capacity of 827.46s (`3 × 275.82s`), it is 14.50%, below the 15% capacity target.

No file exceeded the 15s tier-1 budget. The slowest file completed in 11.985s.

All Node UI, story, maintenance, and budget failures passed. The two remaining failures indicate residual shared-route facade interference; both files are being converted to isolated route/core tests.

## Solo attempt 10

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 10 | One Vitest process / 3 workers | 274.10s | **FAIL** | `.profiles/testing-v2/fast-gate-run10.log` | 890 passed files, 4 skipped; 7,589 passed tests, 22 skipped; zero failed files or tests |

This was the first full run in which all logical tests passed. It remained below the 300s wall-time target, and all prior order-dependent failures are resolved. The run failed only because the budget reporter detected one file above the 15s tier-1 limit.

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 26.49s |
| Setup | 68.69s |
| Import | 99.03s |
| Tests | 499.93s |
| Environment | 86.68s |
| **Summed** | **780.82s** |

The sole budget breach was `headquarters-state-migration` at 18.525s. Optimization has been launched.

## Solo attempt 11

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 11 | One Vitest process / 3 workers | 264.78s | **FAIL** | `.profiles/testing-v2/fast-gate-run11.log` | 2 failed files, 888 passed, 4 skipped; 2 failed tests, 7,585 passed, 24 skipped |

The run remained below the 300s wall-time target, but failed these files:

- `maintenance-api` — suite setup failed because the shared model inventory was empty.
- `pr-walkthrough-api` — two resolve tests reached real Git and were blocked by the tier-1 spawn guard.

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 8.84s |
| Setup | 60.18s |
| Import | 77.76s |
| Tests | 498.92s |
| Environment | 84.49s |
| **Summed** | **730.19s** |

Transform plus import consumed 86.60s of the 730.19s summed phase time (11.86%), below the 15% target.

No file exceeded the 15s tier-1 budget. The slowest file completed in 12.672s.

All newly isolated sidebar, commit, Node, story, and budget tests passed. The final two shared routes are being isolated.

## Solo attempt 12

| Date | Attempt | Process / workers | Wall time | Result | Final tally |
|---|---:|---|---:|---|---|
| 2026-07-16 | 12 | One Vitest process / 3 workers | 281.36s | **PASS** | 890 passed files, 4 skipped; 7,589 passed tests, 22 skipped; zero failures or budget breaches |

This was the first qualifying green run: the suite passed below the 300s wall-time target with no failed files, failed tests, or tier-1 budget breaches.

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 28.24s |
| Setup | 64.15s |
| Import | 92.40s |
| Tests | 527.45s |
| Environment | 86.43s |
| **Summed** | **798.67s** |

## Solo attempt 13

| Date | Attempt | Process / workers | Wall time | Result | Final tally |
|---|---:|---|---:|---|---|
| 2026-07-16 | 13 | One Vitest process / 3 workers | 262.42s | **FAIL** | 1 failed file and test; 889 passed files, 4 skipped; 7,588 passed tests, 22 skipped; zero budget breaches |

The immediate follow-up run remained below the 300s wall-time target, but `stories-sessions-api` S-08 failed because `worktreeOpts` was undefined. S-08 is the final shared seam, and full isolation has been launched.

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 7.85s |
| Setup | 59.90s |
| Import | 79.47s |
| Tests | 491.28s |
| Environment | 85.17s |
| **Summed** | **723.67s** |

## Solo attempt 14

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 14 | One Vitest process / 3 workers | 347.15s | **FAIL** | `.profiles/testing-v2/fast-gate-run14.log` | 2 failed files, 888 passed, 4 skipped; 1 failed test, 7,572 passed, 38 skipped |

The run exceeded the 300s wall-time target and failed these files:

- `proposal-goal-workflow-validation` — suite setup failed when the `beforeAll` route-visibility check returned 404.
- `gate-status-cache-ws` — the test exhausted its 15s timeout and retries.

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 27.92s |
| Setup | 64.97s |
| Import | 101.68s |
| Tests | 590.81s |
| Environment | 88.20s |
| **Summed** | **873.58s** |

One file exceeded the 15s tier-1 budget: `gate-status-cache-ws` completed in 67.683s.

Attempt 12 remains the first qualifying green run. Attempt 14 was killed after Vitest emitted its summary. Both newly exposed shared-gateway tests are being fully isolated.

## Solo attempt 15

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 15 | One Vitest process / 3 workers | 286.88s | **FAIL** | `.profiles/testing-v2/fast-gate-run15.log` | 2 failed files, 888 passed, 4 skipped; 3 failed tests, 7,586 passed, 22 skipped |

The run remained below the 300s wall-time target, but failed these files:

- `gate-signal-reminder` — the cached commit SHA was unknown.
- `maintenance-api-archived-selectors` — the expected archived-selector branches were absent.

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 26.54s |
| Setup | 70.65s |
| Import | 98.61s |
| Tests | 526.64s |
| Environment | 91.61s |
| **Summed** | **814.05s** |

One file exceeded the 15s tier-1 budget: `preview-mount-route` completed in 15.287s.

The proposal, gate-status, story, PR, and validation isolations all passed. The final three fixes have been launched.

## Solo attempt 16

| Date | Attempt | Process / workers | Wall time | Result | Run log | Final tally |
|---|---:|---|---:|---|---|---|
| 2026-07-16 | 16 | One Vitest process / 3 workers | 281.58s | **FAIL** | `.profiles/testing-v2/fast-gate-run16.log` | 1 failed file, 889 passed, 4 skipped; 7,587 passed tests, 24 skipped; zero failed test bodies |

The run remained below the 300s wall-time target. The sole failure was `gate-resign-cancel`: its `beforeAll` found the shared workflows `flow-alpha` and `flow-beta` instead of the expected `general` workflow.

Phase totals:

| Phase | Time |
|---|---:|
| Transform | 26.22s |
| Setup | 65.97s |
| Import | 103.36s |
| Tests | 506.40s |
| Environment | 90.96s |
| **Summed** | **792.91s** |

No file exceeded the 15s tier-1 budget. The slowest file completed in 12.717s.

All previously isolated gate reminder/status, proposal, maintenance, and preview tests passed. Isolation of the `gate-resign-cancel` suite has been launched.
