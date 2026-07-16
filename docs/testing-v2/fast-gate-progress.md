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
