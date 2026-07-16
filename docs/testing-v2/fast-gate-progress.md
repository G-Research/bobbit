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
