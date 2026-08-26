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

## Post-migration evidence

> **Current-layout evidence.** The measurements in this section describe canonical implementation revision `2a5a268f527a949e83e7e0aca5577e58e2da7fa0`, captured on the same Windows host and toolchain listed above on 2026-08-26. The pre-migration sections remain immutable historical evidence. Counts below are authoritative only for the named revision; use current convention-based discovery rather than copying the numbers into operating guidance.

### Canonical inventory and disjointness

Every tracked runnable suffix at the measured revision belonged to exactly one convention. `npm run test:layout` passed with zero diagnostics.

| Semantic cell | Files |
|---|---:|
| Core unit | 742 |
| Isolated unit | 15 |
| DOM | 184 |
| Gateway integration | 252 |
| **Unit lane total** | **1,193** |
| Normal-browser fixtures | 73 |
| Normal-browser journeys | 208 |
| **Browser lane total** | **281** |
| Node E2E (Group A) | 14 |
| API/process E2E (Group B) | 45 |
| Browser-fidelity E2E (Group C) | 24 |
| Vitest E2E (Group D) | 9 |
| **E2E lane total** | **92** |
| Manual | **14** |
| **Canonical runnable union** | **1,580** |

The repository had **1,580 tracked runnable-suffix files**, all below the single `tests/` root. The canonical union was also 1,580: **zero duplicate owners and zero orphans**. Normal-browser list discovery reported **1,141 tests in 281 files**. Manual list discovery reported **53 tests in 14 files**. E2E list discovery reported the exact 14/45/24/9 file split above.

Compared with the pre-migration revision, identified lane ownership rose from 1,396 of 1,587 runnable files to 1,580 of 1,580. The seven-file reduction in the filesystem total includes obsolete selector/map contract tests; separately, previously unowned product coverage was reconciled into canonical cells. Unit ownership increased by 16 files, normal-browser ownership by 145, E2E ownership by 22, and manual ownership by one.

Reproduction:

```bash
npm run test:layout
npm run test:browser -- --list
node scripts/testing-v2/run-e2e-v2.mjs --list
npx playwright test --config playwright-manual.config.ts --list
```

The semantic file counts were produced by filtering `git ls-files -z` with the exact directory/suffix pairs exported by `scripts/testing/layout-policy.mjs`. The sum and pairwise-disjointness check used normalized repository-relative paths.

### Earlier retry-free diagnostic attempts

These rows are single local observations with `BOBBIT_V2_RETRY_FREE=1`; no retry occurred. Median and p95 are not reported from a sample of one. The browser and aggregate E2E attempts failed, so they are retained as diagnostic timing—not represented as successful qualification.

| Scope | Result | Runner wall | Outer wall | Notes |
|---|---|---:|---:|---|
| Complete unit lane | 1,190 passed + 3 skipped files; 11,418 passed + 19 skipped tests | **355.18 s** | **376.421 s** | Clean retry-free pass; fixed three-worker cap |
| Complete normal-browser lane | 1,130 passed, 8 skipped, 2 failed, 1 did not run; 1,141 total | **1,072.8 s** | **1,078.070 s** | `bg-process-persistence` and `stories-resilience` failed; zero retries |
| Complete E2E Groups A–D | A pass, B pass, C fail, D pass; 92 files discovered | **587.934 s** | not separately captured | A 28.1 s; B 293.3 s; C 203.9 s; D 62.1 s; Groups overlap by design |

The retry-free E2E report recorded 23.637 CPU-minutes, a peak of 35 processes, and `dockerCapability: "daemon-unavailable"`. Docker-owned behavior therefore remained explicitly capability-gated on this host. The A, B, and D subgroup passes remain first-attempt evidence; Group C's failure makes the aggregate attempt a failure.

Commands:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:unit
BOBBIT_V2_RETRY_FREE=1 npm run test:browser
BOBBIT_V2_RETRY_FREE=1 npm run test:e2e
```

### Final integrated passing workflow

Signal 36 ran every implementation command at the same integrated revision, `2a5a268f527a949e83e7e0aca5577e58e2da7fa0`, and passed. This workflow used the ordinary configured retry policy; it is aggregate gate evidence, not a claim of first-attempt stability.

| Command/lane | Result | Duration | Qualification note |
|---|---|---:|---|
| Check | Passed | **37.018 s** | Layout and type-check command passed |
| Unit | 1,190 files passed + 3 skipped; 11,419 tests passed + 18 skipped | **266.616 s** | Complete lane passed under ordinary settings |
| Browser | 1,128 passed + 11 skipped + 2 flaky = 1,141 total | **776.056 s** | Complete lane passed; the two formerly failing cases used retry margin |
| E2E Groups A–D | Aggregate passed | **631.571 s** | Complete four-group command passed; no aggregate test count is inferred |

The browser budget artifact recorded **770.1 s** across **281 specs**, with zero 60-second per-spec violations. The two flaky cases were `bg-process-persistence` and `stories-resilience`; because they passed only within the configured retry margin, this browser result must not be called retry-free.

Retained E2E output reports **160 API tests passed + 3 skipped** in 5.0 minutes and **106 browser-fidelity tests passed + 12 skipped** in 3.7 minutes. Those subgroup counts are not summed into an E2E aggregate because the retained evidence does not provide comparable counts for every runner group. The aggregate fact supported by Signal 36 is only that Groups A–D passed in 631.571 seconds.

The ordinary-policy workflow followed the earlier retry-free diagnostics: it establishes the final integrated pass, while the clean retry-free unit run and successful retry-free A/B/D cohorts remain the bounded first-attempt evidence. No later passing workflow is outstanding in this record.

The pre-migration capture did not contain complete browser or E2E execution, so there is no honest like-for-like runtime delta for those lanes. The unit lane grew from 1,177 to 1,193 files; different revisions, inventories, and retry modes make the observed timings capacity evidence rather than a controlled performance regression comparison.

### Removed maintenance footprint

The final removal manifest is deliberately narrower than every file moved during the migration. It counts only retired ownership/selection machinery and its exclusive tests/fixtures; canonical product tests that were renamed or ported are excluded.

| Removed scope | Files | Lines | Bytes |
|---|---:|---:|---:|
| Original bounded registry/affected/inventory core reported above | 20 | 28,019 | 1,081,282 |
| Additional legacy lane runners, parity/chaos/coverage audits, migration reports/data, and old Playwright config | 11 | 5,121 | 259,314 |
| Selector/map/audit-only tests and fixtures | 16 | 4,247 | 176,945 |
| **Total deleted maintenance artifacts** | **47** | **37,387** | **1,517,541** |

The total is this exact baseline-to-measured-HEAD path set; it is not the count of every migration deletion or rename:

<details>
<summary>Exact 47-path removal manifest</summary>

```text
scripts/affected/README.md
scripts/affected/cache.mjs
scripts/affected/classification.mjs
scripts/affected/correctness-sample.json
scripts/affected/correctness-vs-main.mjs
scripts/affected/graph.mjs
scripts/affected/impact-rules.mjs
scripts/affected/proof-vs-main.mjs
scripts/affected/run.mjs
scripts/affected/runner.mjs
scripts/testing-v2/check-inventory.mjs
scripts/testing-v2/codemod.mjs
scripts/testing-v2/gen-inventory.mjs
scripts/testing-v2/lib-census.mjs
scripts/testing-v2/parity.mjs
scripts/testing-v2/test-map-execution.mjs
scripts/testing-v2/unit-declaration-semantic-map.json
scripts/testing-v2/unit-inventory-audit.mjs
scripts/testing-v2/unit-inventory-git.mjs
tests2/tests-map.json
scripts/lib/unit-heartbeat.mjs
scripts/run-unit.mjs
scripts/test-phase-config.mjs
tests/playwright.config.ts
scripts/testing-v2/browser-chaos.mjs
scripts/testing-v2/chaos.mjs
scripts/testing-v2/coverage-delta.mjs
scripts/testing-v2/spec-check-helper.ts
tests2/chaos/browser-mutants.json
tests2/chaos/mutants.json
tests2/codemod-report.json
tests2/core/affected-correctness-harness.test.ts
tests2/core/affected-doc-classification.test.ts
tests2/core/affected-reader-inventory.test.ts
tests2/core/affected-runner-cli.test.ts
tests2/core/affected-runner-git-cli.test.ts
tests2/core/affected-runner-no-escape.test.ts
tests2/core/affected-test-classification.test.ts
tests2/core/affected-test-runner.test.ts
tests2/core/test-map-execution.test.ts
tests2/core/unit-inventory-git.test.ts
tests2/core/browser-chaos-worktree-safety.test.ts
tests2/core/chaos-worktree-safety.test.ts
tests2/core/helpers/affected-graph-fixture.ts
tests2/core/helpers/affected-runner-fixture.ts
tests2/integration/_affected-runner-boundary-fixture.ts
tests2/integration/affected-runner-boundary.test.ts
```

</details>

Every path existed at baseline `db2d9bb5d7fc249834e16a7a07a04e3e9fd4e1d2`, was absent at measured revision `2a5a268f527a949e83e7e0aca5577e58e2da7fa0`, and appeared as a deletion under `git diff --no-renames --diff-filter=D`. Counts read each baseline blob with `git show <baseline>:<path>`, then summed byte length and logical newline count. This makes the total reproducible without treating canonical test renames as machinery removal.

The manifest includes all of `scripts/affected/`; the old map; inventory, census, parity, codemod, declaration-map, and map-execution scripts; affected correctness/proof/cache/impact code; retired chaos/coverage audit scripts and data; the old split unit/browser runner seams; and tests/fixtures whose only subject was that machinery.

Four package-script entries were also removed: `test:unit:inventory`, `test:affected`, `test:affected:proof`, and `test:affected:correctness`. They are wiring deletions inside a retained file and therefore are not added to the 47-file byte/line total. The replacement is the convention guard plus complete public lanes, not another per-test registry, cache, graph, or generated inventory.
