# Cross-OS qualification record

## Scope and authority

- **Executable/test/configuration SHA:** `0ffb3e41de62a6de4bb95285b8ed83946c84291a`
- **Reconciled production base:** `origin/main` `5c7c2e4997ba78cb7c9268443a52a6427a97ca17`
- **Local host:** macOS. Windows and Ubuntu native coverage is supplied by the linked GitHub Actions run.

This is the qualification record for the immutable executable/test/configuration SHA above. Documentation written after that SHA is evidence reporting only; it was **not** part of the tested tree. Times below are UTC on 2026-08-03. Repository coordinator wrappers—not direct Playwright commands—were used throughout.

`BOBBIT_V2_RETRY_FREE=1` produced zero runner retries. Fixture-level application retry messages, where emitted, are application behavior and are not runner retries.

## Preparation and serial qualification

| SHA | Command | Suite / attempt | UTC | Duration | Exit | Totals | Runner retries | Artifacts and cleanup |
|---|---|---|---|---:|---:|---|---:|---|
| `0ffb3e41` | `npm ci` | local setup | 11:25:13–11:25:20 | 7s | 0 | install complete | — | setup only |
| `0ffb3e41` | `npm run build` | local setup | 11:25:27–11:25:34 | 7s | 0 | build complete | — | setup only |
| `0ffb3e41` | `npm run check` | type-check | 11:26:00–11:26:17 | 17,037ms | 0 | complete | 0 | no run-owned artifacts retained |
| `0ffb3e41` | `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` | serial unit | 11:26:24–11:27:45 | 80,189ms | 0 | 1,020 files; 9,182 passed; 3/11 skipped | 0 | owned coordinator root removed |
| `0ffb3e41` | `BOBBIT_V2_RETRY_FREE=1 npm run test:browser` | serial browser | 11:27:55–11:30:58 | 183,180ms | 0 | 695 passed; 9 skipped | 0 | owned coordinator root removed |
| `0ffb3e41` | `BOBBIT_V2_RETRY_FREE=1 npm run test:unit -- --project v2-integration` | serial integration | 11:31:08–11:31:35 | 26,834ms | 0 | 213 files; 1,088 tests; 1/2 skipped | 0 | owned coordinator root removed |
| `0ffb3e41` | `BOBBIT_V2_RETRY_FREE=1 npm run test:e2e` | serial E2E | 11:31:45–11:33:38 | 113,644ms | 0 | groups A/B/C/D PASS | 0 | owned coordinator root removed |

## Consecutive retry-free unit gates

Command for every attempt: `BOBBIT_V2_RETRY_FREE=1 npm run test:unit`.

| SHA | Attempt | UTC | Duration | Exit | Totals | Runner retries | Cleanup |
|---|---:|---|---:|---:|---|---:|---|
| `0ffb3e41` | 1 | 11:33:55–11:35:16 | 81,366ms | 0 | 1,020 files; 9,182 passed; 3/11 skipped | 0 | owned root removed |
| `0ffb3e41` | 2 | 11:35:16–11:36:37 | 80,607ms | 0 | 1,020 files; 9,182 passed; 3/11 skipped | 0 | owned root removed |
| `0ffb3e41` | 3 | 11:36:37–11:37:59 | 81,880ms | 0 | 1,020 files; 9,182 passed; 3/11 skipped | 0 | owned root removed |
| `0ffb3e41` | 4 | 11:37:59–11:39:20 | 81,192ms | 0 | 1,020 files; 9,182 passed; 3/11 skipped | 0 | owned root removed |
| `0ffb3e41` | 5 | 11:39:20–11:40:41 | 81,213ms | 0 | 1,020 files; 9,182 passed; 3/11 skipped | 0 | owned root removed |

## Concurrent coordinator qualification

### Clean-worktree unit triplet

Each clean same-SHA worktree ran its own prior `npm ci`, then ran `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` concurrently. The three commands overlapped for 198,203ms.

| SHA | Coordinator / worktree | UTC | Duration | Exit | Totals | Runner retries | Owned state and cleanup |
|---|---|---|---:|---:|---|---:|---|
| `0ffb3e41` | unit-1 / clean worktree 1 | 11:48:50–11:52:11 | 200,798ms | 0 | 1,020 files; 9,182 passed; 3/11 skipped | 0 | distinct HOME, TMP, XDG, npm, and run roots; worktree/temp removed |
| `0ffb3e41` | unit-2 / clean worktree 2 | 11:48:50–11:52:10 | 200,497ms | 0 | 1,020 files; 9,182 passed; 3/11 skipped | 0 | distinct HOME, TMP, XDG, npm, and run roots; worktree/temp removed |
| `0ffb3e41` | unit-3 / clean worktree 3 | 11:48:50–11:52:08 | 198,203ms | 0 | 1,020 files; 9,182 passed; 3/11 skipped | 0 | distinct HOME, TMP, XDG, npm, and run roots; worktree/temp removed |

No coordinator observed foreign roots. Two setup-only attempts were excluded: one exposed the committed `.npmrc` package-lock setting unless explicitly overridden; the other used the wrong script working directory. Neither ran tests and neither is qualification evidence.

### Same-worktree browser pair

Both coordinators ran `BOBBIT_V2_RETRY_FREE=1 npm run test:browser` from the same worktree against the same 704-test plan and overlapped completely.

| SHA | Coordinator | UTC | Duration | Exit | Totals | Runner retries | Owned state and cleanup |
|---|---|---|---:|---:|---|---:|---|
| `0ffb3e41` | browser-A | 11:56:43.615–12:00:32.369 | 228,754ms | 0 | 697 passed; 7 skipped | 0 | distinct roots, reports, output, cache, and profiles; removed |
| `0ffb3e41` | browser-B | 11:56:43.685–12:00:32.374 | 228,689ms | 0 | 698 passed; 6 skipped | 0 | distinct roots, reports, output, cache, and profiles; removed |

The one-count skip difference is the pre-existing adaptive-layout skip at `bg-process-pills.spec.ts:212`; it is not cross-talk and was not rerun. Both Anthropic journeys ran, with 293 clear fixed-port samples and no `53692` or `EADDRINUSE` occurrence.

### Same-worktree E2E pair

Both coordinators ran `BOBBIT_V2_RETRY_FREE=1 BOBBIT_DEBUG_PWTEST_CACHE=1 npm run test:e2e` from the same worktree with full overlap.

| SHA | Coordinator | UTC | Duration | Exit | Totals | Runner retries | Owned state and cleanup |
|---|---|---|---:|---:|---|---:|---|
| `0ffb3e41` | e2e-A | 12:10:56–12:13:46 | 170,088ms | 0 | A/B/C/D: 14/21/18/7 PASS; C: 101 total, 89 passed, 12 skipped; D: 72 passed | 0 (`--retries=0`) | outer `72PeRF`, nested `pZ1qhp`; distinct ports, Docker, locks, reports, Playwright output, and packed-consumer artifacts; removed |
| `0ffb3e41` | e2e-B | 12:10:56–12:13:46 | 170,099ms | 0 | A/B/C/D: 14/21/18/7 PASS; C: 101 total, 89 passed, 12 skipped; D: 72 passed | 0 (`--retries=0`) | outer `Rgz9O4`, nested `65PQel`; distinct ports, Docker, locks, reports, Playwright output, and packed-consumer artifacts; removed |

`test-results/.last-run.json` was absent before, during, and after the pair. All ten serial coordinator roots were removed; tracked profile result files were preserved; every task cleaned its owned state.

## Native CI

### Build & Unit Gate

Workflow dispatch: [run 30809374026](https://github.com/G-Research/bobbit/actions/runs/30809374026), `headSha` `0ffb3e41de62a6de4bb95285b8ed83946c84291a`. All native jobs concluded `success`.

| Native platform | Job | UTC | Conclusion | URL |
|---|---:|---|---|---|
| Ubuntu Node 22 | 91672208071 | 11:24:03–11:28:02 | success | [job](https://github.com/G-Research/bobbit/actions/runs/30809374026/job/91672208071) |
| Ubuntu Node 26 | 91672208138 | 11:24:10–11:27:38 | success | [job](https://github.com/G-Research/bobbit/actions/runs/30809374026/job/91672208138) |
| Windows Node 22 | 91672208205 | 11:24:04–11:31:51 | success | [job](https://github.com/G-Research/bobbit/actions/runs/30809374026/job/91672208205) |
| macOS Node 22 | 91672208236 | 11:24:04–11:28:19 | success | [job](https://github.com/G-Research/bobbit/actions/runs/30809374026/job/91672208236) |

### CodeQL — sole qualification exception

Exact-head dispatch [run 30809375871](https://github.com/G-Research/bobbit/actions/runs/30809375871) completed its Actions analysis, but its JavaScript/TypeScript analysis remained in hosted `Perform CodeQL analysis` for more than one hour without failure or live logs and was cancelled as a hosted-infrastructure hang. One unchanged replacement exact-head dispatch, [run 30813759276](https://github.com/G-Research/bobbit/actions/runs/30813759276), had the same outcome: its Actions job [91686412658](https://github.com/G-Research/bobbit/actions/runs/30813759276/job/91686412658) succeeded, while its JavaScript/TypeScript job [91686412619](https://github.com/G-Research/bobbit/actions/runs/30813759276/job/91686412619) again remained stuck in that hosted step for more than one hour without failure or live logs and was cancelled.

Accordingly, there is **no green exact-dispatch JavaScript/TypeScript CodeQL claim** for `0ffb3e41de62a6de4bb95285b8ed83946c84291a`. This is the sole qualification exception.

| Evidence | Commit metadata | Native result | URL | Qualification interpretation |
|---|---|---|---|---|
| PR CodeQL fallback | synthetic merge `4dd8dda182a2961f9125f9429bc45345b99c8af3` (**not** the qualified commit) | Actions [91673407024](https://github.com/G-Research/bobbit/actions/runs/30809744161/job/91673407024) success; JavaScript/TypeScript [91673407159](https://github.com/G-Research/bobbit/actions/runs/30809744161/job/91673407159) success | [run 30809744161](https://github.com/G-Research/bobbit/actions/runs/30809744161) | tree-identical native CodeQL fallback, not exact-commit workflow-dispatch proof |

The qualified commit and the synthetic merge have identical Git tree `cb174b67cf89fd3f6979c923103d016847490ca6`: the fetched merge ref was confirmed and `git diff --quiet` exited 0 because `main` `5c7c2e49` was already merged. The successful PR run is therefore native CodeQL proof for the same tree, while the two exact-head workflow-dispatch JavaScript/TypeScript proofs remain unavailable because of the documented hosted hangs.

## Integrity statement

No assertion or test was removed or weakened for this qualification. No new skip, sleep, polling loop, blind retry/reload, timeout increase, force-exit, or global serialization was used as a stability measure. Raw logs are intentionally not committed; the tables retain the command, immutable SHA, coordinator identity, timing, exit status, totals, retries, ownership, cleanup, and native CI evidence needed to audit the result.
