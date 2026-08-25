# Pre-migration test-layout baseline

> Historical evidence captured before the canonical test-layout migration. Keep this file after the registry and affected-test implementation are removed. The commands below describe revision `db2d9bb5d7fc249834e16a7a07a04e3e9fd4e1d2`; they are evidence, not current runner guidance.

Captured on 2026-08-25. Unless a row says otherwise, commands ran from a clean worktree at the revision above.

## Host and toolchain

| Item | Value |
|---|---|
| OS | Windows NT 10.0.26200, x64 |
| CPU | AMD Ryzen AI 9 HX 370 with Radeon 890M, 24 logical CPUs |
| Memory | 63 GiB |
| Node | v24.13.1 |
| npm | 11.8.0 |
| Docker | Client 29.3.1; daemon unavailable because the Docker Desktop Linux named pipe did not exist |
| Git revision | `db2d9bb5d7fc249834e16a7a07a04e3e9fd4e1d2` |

The worktree initially had no `node_modules`. `npm ci --ignore-scripts` installed 667 packages in 58 seconds. No shared or linked `node_modules` tree was used. Docker-unavailable behavior was retained as an explicit result rather than silently dropping Docker-owned coverage.

Environment commands:

```bash
git rev-parse HEAD
node --version
npm --version
node -e "const os=require('os'); console.log(os.type(), os.release(), os.arch()); console.log(os.cpus()[0]?.model); console.log(os.cpus().length, 'logical CPUs'); console.log(Math.round(os.totalmem()/1024/1024/1024)+' GiB RAM')"
docker version --format "client={{.Client.Version}} server={{.Server.Version}}"
```

## Filesystem and runner inventory

A runnable-suffix file here means a tracked path below `tests/` or `tests2/` ending in `.test.ts` or `.spec.ts`. There were no other runnable extensions in those roots.

| Inventory | Count | Evidence owner |
|---|---:|---|
| Tracked runnable-suffix files | **1,587** | `git ls-files tests tests2`, suffix-filtered |
| Under `tests/` | **242** | 26 top-level/other, 203 under `tests/e2e/`, 13 under `tests/manual-integration/` |
| Under `tests2/` | **1,345** | 758 core, 182 DOM, 246 integration, 159 browser |
| Unit lane | **1,177** | execution-map projects: 741 core, 182 DOM, 240 integration, 14 isolated |
| Normal browser lane | **136 files / 782 tests** | Playwright `browser-v2 --list`; excludes 23 `tests2/browser/e2e/` files |
| Real-fidelity E2E lane | **70 files** | Group A 14, B 24, C 23, D 9 |
| Manual files physically present | **13** | 12 Playwright-discovered files plus one Node `.test.ts` file |
| Unique files with an identified lane owner | **1,396** | unit 1,177 + browser 136 + E2E 70 + manual 13; the semantic sets are disjoint at this revision |
| Runnable files outside identified lane owners | **191** | filesystem 1,587 minus owned union 1,396 |

The 13 physically present manual files are not the same as the public manual Playwright inventory: `npm run test:manual -- --list` found 51 tests in 12 files because `tests/manual-integration/hindsight-external.test.ts` is a Node test with a separate documented direct command. The old map reports 15 manual records, including two paths no longer present (`compaction-pressure.spec.ts` and `compaction.spec.ts`). This mismatch is migration reconciliation evidence, not deletion permission.

### Old registry state

| Registry measure | Count |
|---|---:|
| Legacy `entries` | **1,143** |
| Entries with `v2Path` | **900** |
| Entries without `v2Path` | **243** |
| `v2Native` entries | **425** |
| Unique materialized paths represented | **1,325** |
| Materialized Vitest unit owners | **1,177** |
| Materialized Vitest E2E owners | **9** |
| Materialized Playwright browser records | **139** |

The 139 Playwright records include normal-browser and browser-fidelity E2E records; the runner split, rather than that aggregate map number, is authoritative for lane execution.

Reproduction commands:

```bash
node --input-type=module -e "import {loadVitestExecutionMap} from './scripts/testing-v2/test-map-execution.mjs'; const x=loadVitestExecutionMap(); console.log(Object.fromEntries(['core','dom','integration','isolated','e2e','unit','all'].map(k=>[k,x[k].length])))"
node scripts/testing-v2/run-e2e-v2.mjs --list
node node_modules/playwright/cli.js test --config playwright-v2.config.ts --project browser-v2 --list
node node_modules/playwright/cli.js test --config playwright-manual.config.ts --list
```

## Current-head affected-selection proof

Command:

```bash
npm run test:affected:proof -- 14 --json "$TEMP/bobbit-unify-layout-affected-proof.json"
```

The proof wrote its JSON, then correctly exited 1 because it found a non-documentation blind zero. Outer wall time was **86 seconds**. The per-row `selectionMs` timer excludes graph construction, Git/history reads, cache work, and test execution; across all 21 rows it had a 3 ms median and 50 ms p95. The large difference between those timers and 86 seconds is affected-planning/audit overhead that must not be presented as test execution time.

Summary:

| Sample | Modes | Mean selected | Selection-timer median / p95 |
|---|---|---:|---:|
| All 21 rows | 1 skip-all, 10 bounded, **10 run-all** | **771.7 / 1,177 (65.6%)** | 3 / 50 ms |
| 14 recent `origin/main` commits | 0 skip-all, 6 bounded, **8 run-all** | **857.2 / 1,177 (72.8%)** | 3 / 50 ms |
| Seven fixed acceptance samples | 1 skip-all, 4 bounded, 2 run-all | **600.6 / 1,177 (51.0%)** | 3 / 62 ms |
| Nine nonzero bounded rows | — | **492.8 / 1,177 (41.9%)** | 35 / 62 ms |

`RUN-ALL` is counted as 1,177/1,177 (100%), because that is the executable plan. It is not replaced with the smaller, non-executable graph diagnostic. Ten of 21 proof rows (47.6%) and eight of the 14 recent commits (57.1%) selected the complete unit lane. The recent-commit mean selected nearly three quarters of the suite.

Exact proof rows:

| Commit/sample | Mode | Selected | Selection timer | Subject |
|---|---|---:|---:|---|
| `db2d9bb5d7` | bounded | 216 / 1,177 (18.4%) | 40 ms | Add transcript history navigation (#1248) |
| `c2d7dbb0fc` | bounded | 490 / 1,177 (41.6%) | 35 ms | Strip archived sessions from goal tool output (#1247) |
| `fa92aa5abe` | **run-all** | 1,177 / 1,177 (100%) | 3 ms | Add Bobbit journey benchmarks (#1246) |
| `dd8b2ac20d` | **run-all** | 1,177 / 1,177 (100%) | 3 ms | Fix project tool routing (#1244) |
| `bd5568b915` | bounded | 1,010 / 1,177 (85.8%) | 50 ms | Trust credentialed PR hosts (#1245) |
| `0dd0075609` | **run-all** | 1,177 / 1,177 (100%) | 2 ms | Release v0.18.0 (#1242) |
| `67dbcb09f1` | bounded | **0 / 1,177 (0%)** | 0 ms | Synchronize new-worktree team readiness (#1240) |
| `668f63341d` | bounded | 209 / 1,177 (17.8%) | 2 ms | Rename context target to soft limit (#1239) |
| `bf3b9fb84b` | **run-all** | 1,177 / 1,177 (100%) | 2 ms | Kick Off Promoted Leads (#1237) |
| `bd75e122c1` | **run-all** | 1,177 / 1,177 (100%) | 3 ms | Create independent staff forks (#1238) |
| `29987c346b` | bounded | 660 / 1,177 (56.1%) | 45 ms | Clarify context capacity (#1236) |
| `fd34f119da` | **run-all** | 1,177 / 1,177 (100%) | 23 ms | Add Host Bobbit sprite API (#1235) |
| `f64c96dbe2` | **run-all** | 1,177 / 1,177 (100%) | 1 ms | Add staff Clear context policy (#1234) |
| `e39bace2ad` | **run-all** | 1,177 / 1,177 (100%) | 6 ms | Add `/clear` session context command (#1233) |
| `docs-only` | skip-all | 0 / 1,177 (0%) | 1 ms | Fixed documentation-only sample |
| `ui-only` | bounded | 209 / 1,177 (17.8%) | 1 ms | Fixed UI-only sample |
| `pr-1071` | **run-all** | 1,177 / 1,177 (100%) | 6 ms | Stabilize test runtime (#1071) |
| `pr-1072` | bounded | 654 / 1,177 (55.6%) | 62 ms | Support runtime subpath mounting (#1072) |
| `dependency-bump` | **run-all** | 1,177 / 1,177 (100%) | 3 ms | Upgrade Pi to 0.82.1 with Opus 5 (#1057) |
| `role-and-tool-inputs` | bounded | 499 / 1,177 (42.4%) | 3 ms | Fixed role/tool-input sample |
| `market-pack` | bounded | 488 / 1,177 (41.5%) | 3 ms | Fixed marketplace-pack sample |

The violation was:

```text
67dbcb09f1 is a non-documentation blind zero
```

This proof replays historical change records through the current checkout's graph and inventory. It measures current selector behavior but is not the expensive exact-revision correctness qualification.

## Execution timing evidence

All executed qualification commands set `BOBBIT_V2_RETRY_FREE=1`. No retry occurred. Times are single observations, so median and p95 are not reported for execution; inventing distribution statistics from one run would be misleading.

| Scope | Result | Runner wall | Outer wall | Notes |
|---|---|---:|---:|---|
| Complete unit lane | 1,174 passed + 3 skipped files; 11,447 passed + 18 skipped tests | **298.13 s** | **305 s** | Fixed three-worker cap; clean pass |
| Cold affected execution | 3/1,177 files selected; 27 tests passed | Vitest 1.66 s; affected runner **22.474 s** | **26 s** | Cache removed first; most wall time was outside Vitest |
| Warm affected replay | same 3 selected; 3 cache hits; 0 executed | affected runner **8.572 s** | **10 s** | Cache-hit-all; still pays graph/fingerprint cost |
| Focused normal-browser cold run | 2 tests passed in one file | **48.1 s** | **50 s** | One worker; included cold `dist` build; no retries |
| E2E Group D | 9 files passed; 193 tests passed + 1 skipped | Vitest **53.00 s**; group **54.0 s** | **56 s** | One-worker real-fidelity Vitest cell; no retries |

Affected cold-to-warm outer wall improved from 26 to 10 seconds (2.6 times), but this three-file case is not representative of the proof's average 493-file bounded selection and must not be extrapolated to ordinary changes.

Commands:

```bash
rm -rf .profiles/test-cache
BOBBIT_V2_RETRY_FREE=1 npm run test:affected -- --changed tests2/core/affected-doc-classification.test.ts --json
BOBBIT_V2_RETRY_FREE=1 npm run test:affected -- --changed tests2/core/affected-doc-classification.test.ts --json
BOBBIT_V2_RETRY_FREE=1 npm run test:unit
BOBBIT_V2_RETRY_FREE=1 node node_modules/playwright/cli.js test tests2/browser/fixtures/archived-blob.spec.ts --config playwright-v2.config.ts --project=browser-v2 --workers=1
BOBBIT_V2_RETRY_FREE=1 node scripts/testing-v2/run-e2e-v2.mjs --group D --json "$TEMP/bobbit-e2e-group-d.json"
```

The public browser wrapper could not run a positional focused file in this form:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:browser -- tests2/browser/fixtures/archived-blob.spec.ts --workers=1
```

It treated the file path as an additional project name and failed in 8 seconds before running tests. The direct Playwright command above was therefore used for bounded cold-browser evidence.

### Deliberate measurement limits

A complete retry-free normal-browser execution and E2E Groups A/B/C were not run in this capture. Browser discovery was exact (`782 tests in 136 files`), and the E2E coordinator inventory was exact (70 files), but list-only evidence is not execution timing. The bounded capture already spent about five minutes on the complete unit lane, and Docker was unavailable; rather than block the migration baseline indefinitely or report incomparable partial-Docker timing as a complete E2E lane, this report retains the successful focused browser run, complete E2E Group D run, exact lane inventories, and explicit omission. Full complete-lane timing remains required in post-migration qualification and cross-platform CI.

The manual lane was discovery-only because it intentionally invokes real agents/models/external services. Its list was 51 Playwright tests in 12 files, with the thirteenth physical manual Node test called out above.

## Machinery footprint before deletion

The narrow registry/affected/classification core measured here consists of:

- all 10 tracked files under `scripts/affected/`;
- `tests2/tests-map.json`;
- `check-inventory.mjs`, `codemod.mjs`, `gen-inventory.mjs`, `lib-census.mjs`, `parity.mjs`, `test-map-execution.mjs`, `unit-declaration-semantic-map.json`, `unit-inventory-audit.mjs`, and `unit-inventory-git.mjs` under `scripts/testing-v2/`.

That bounded 20-file scope is **28,019 lines and 1,081,282 bytes**. `scripts/affected/` alone is 10 files, 6,758 lines, and 268,766 bytes; the hand-maintained map alone is 18,944 lines and 702,875 bytes. Selector-only tests, fixtures, documentation, package scripts, and CI wiring are deliberately excluded, so the final removed file/line total should be larger.

Measurement used byte length and newline count from the checked-out files; it did not use platform-dependent `du` allocation units.

## Earlier historical comparison

The older snapshot in `docs/testing-v2/suite-speed-analysis.md` recorded 1,038 unit files, a 193.37-second unit run, four run-all rows out of 21, and a 506-file (48.7%) nonzero-bounded average. It is retained as earlier historical evidence only. The present checkout has a 1,177-file inventory and a different recent-commit window, so the two snapshots must not be treated as a controlled performance regression comparison.

## Post-migration evidence to append

After the canonical hierarchy and convention-owned runners land, append:

1. the final revision and exact unit/browser/E2E/manual discovered-file union, including duplicate and orphan count;
2. like-for-like complete retry-free unit, browser, and E2E timings on available CI hosts;
3. manual list-only discovery;
4. final deleted file, line, and byte totals for the map, affected graph/runner, inventories, audits, fixtures, tests, scripts, and stale wiring;
5. any CI runtime trade-off against this baseline, with retries, skips, Docker availability, and single-run versus repeated statistics labelled explicitly.
