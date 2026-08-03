# Test suite speed and affected selectivity

Bobbit's full unit, browser, and E2E gates remain deliberately high-fidelity and multi-minute. The affected-test runner improves the developer feedback loop by executing only a conservative unit closure and reusing stable local PASS results. It does not make selective evidence authoritative and does not change the full merge gates.

Detailed selector behavior lives in [`scripts/affected/README.md`](../../scripts/affected/README.md). This page records the current performance evidence and the remaining architectural floor.

## Current full-gate baseline

Measurement snapshot: implementation-passed goal branch on a Windows host, 2026-08-03. Counts come from the authoritative execution map and Vitest output, not a source glob.

| Gate | Result | Runner duration | Workflow-step duration |
|---|---:|---:|---:|
| `npm run test:unit` | 1,026 passed files + 3 skipped = **1,029**; 9,385 passed tests + 19 skipped = **9,404** | **214.20 s** | **224.953 s** |
| `npm run test:browser` | passed | — | **304.293 s** |
| `npm run test:e2e` | passed | — | **342.086 s** |

The unit suite uses one Vitest coordinator and a fixed three-worker cap. Increasing local concurrency is not the affected runner's safety mechanism: selection reduces the set, while the unchanged full gate remains the backstop.

## Measured selection proof

The following command was run against the current **1,029-file** unit inventory:

```bash
npm run test:affected:proof -- 14 --json .profiles/affected-proof.json
```

It evaluated 14 recent `origin/main` commits plus the seven fixed acceptance samples: one `SKIP-ALL`, 12 bounded, and eight `RUN-ALL`. Bounded rows selected an average of **472 files**; skip, run-all, and zero rows were excluded from that average. The mean bounded classification time was **16 ms** after graph construction. There were no suspicious non-documentation zeroes.

### Baseline versus affected plan

| Scenario | Evidence | Mode and cache policy | Selected / 1,029 | Plan time | Why |
|---|---|---|---:|---:|---|
| No selector | current full unit verification | full baseline | 1,029 | 214.20 s Vitest | Previous per-change behavior and current authority. |
| Docs-only | synthetic edit atop `fd25842abf` | `SKIP-ALL`, eligible | **0** | 2 ms | Known unclaimed documentation has no unit consumer. |
| UI-only | `75ffcc7c95` | bounded, eligible | **182** | 1 ms | UI entry/DOM and direct-reader closures. |
| PR #1071 | `7a42e234ca` | **`RUN-ALL`, bypass** | **1,029** | 5 ms | The change includes `vitest.config.ts` and suite-wide run-isolation/setup. Its graph-only diagnostic is also 1,029 and is non-executable. |
| PR #1072 | `3d99218c57` | bounded, eligible | **571** | 52 ms | Server/shared/app/UI changes plus a recognized data-only execution-table edit produce a genuine subset. |
| Dependency bump | `7bf525cb2f` | **`RUN-ALL`, bypass** | **1,029** | 1 ms | Dependency-bearing `package.json` and lockfile changes can alter every test. The 622-file graph-only count is diagnostic only. |
| Role + tool inputs | `f747186a88` | bounded, eligible | **443** | 2 ms | Shipped YAML/prompt owners and loader/policy/budget canaries. |
| Marketplace pack | `4aba79b60f` | bounded, eligible | **418** | 2 ms | Pack owners, loaders, policies, and direct canaries. |

“Plan time” above is the proof row's classification timer. It excludes graph construction, Git history reads, cache work, and Vitest execution. `RUN-ALL` rows report the executable 1,029-file plan; the proof never substitutes a smaller graph-only diagnostic for execution.

The historical proof is not a correctness run. It demonstrates classification and catches blind zeroes, but only the [correctness qualification](../../scripts/affected/README.md#proof-and-correctness-qualification) compares selection with independent Vitest and full-run evidence.

## Synthetic non-code and runtime probes

These probes used the current checkout and this command shape:

```bash
node scripts/affected/run.mjs --changed <repo-path> --dry --no-cache --json
```

The JSON `wallMs` includes graph construction and runner planning; `--dry` prevents Vitest execution. These are representative synthetic path probes, not historical diffs.

| Changed input | Family | Mode | Selected / 1,029 | Dry wall |
|---|---|---|---:|---:|
| `defaults/roles/coder.yaml` | built-in role | bounded | **385** | 3.584 s |
| `defaults/tools/filesystem/read.yaml` | built-in tool | bounded | **425** | 3.361 s |
| `market-packs/pr-walkthrough/pack.yaml` | marketplace pack | bounded | **418** | 3.456 s |
| `.claude/skills/qa-test/SKILL.md` | shipped skill | bounded | **373** | 2.916 s |
| `workflows/test-fast.yaml` | workflow template | bounded | **409** | 3.232 s |
| `.bobbit/config/project.yaml` | committed config cascade | bounded | **458** | 3.182 s |
| `AGENTS.md` | prompt/authoring input | bounded | **364** | 2.872 s |
| `src/shared/base-path.ts` | shared server-runtime dependency | bounded | **423** | 4.610 s |

All representative non-code families select a nonzero strict subset. The shared source row confirms that gateway attribution follows the real runtime-entry closure outside `src/server/**`.

## Cold and warm local cache measurement

The cache measurement used one explicit changed unit test after removing this checkout's ignored cache:

```bash
npx shx rm -rf .profiles/test-cache
npm run test:affected -- --changed tests2/core/affected-doc-classification.test.ts --json
npm run test:affected -- --changed tests2/core/affected-doc-classification.test.ts --json
```

| Run | Summary | Selected | Hits | Executed | Runner wall |
|---|---|---:|---:|---:|---:|
| Cold | `BOUNDED` | 3 | 0 | 3 | **10.388 s** |
| Warm | `CACHE-HIT-ALL` | 3 | 3 | 0 | **4.459 s** |

The warm run still pays graph and fingerprint cost. This single small case is about **2.3×** faster by runner wall time; it is not evidence of a general 10× improvement. Test-file cost varies widely, and the historical bounded average still selects 472 of 1,029 files. Claims about end-to-end speed must include Vitest execution on the actual change set rather than extrapolate from selected counts.

## Why bounded sets remain large

The selector has removed the previous blind spots without pretending that Bobbit has fine-grained domain boundaries:

- Gateway tests depend on the transitive server runtime entry, including imported shared modules. This is sounder and narrower than treating all `src/server/**` as equivalent, but a widely imported runtime file still reaches many boot tests.
- Happy-DOM tests depend on the UI entry boundary. The app shell and global state keep many UI files connected.
- Shipped role/tool/skill/pack/workflow/config inputs are intentionally connected to production loaders and direct policy, prompt, and budget canaries.
- Vitest configuration, lockfiles, TypeScript configuration, dependency topology, selector/runtime code, unknown infrastructure, and unresolved old edges deliberately invalidate the entire unit suite.

Over-selection costs time; under-selection creates false confidence. The current gate chooses the former whenever it lacks a maintainable proof.

## Correctness and authority

The affected runner is the default local and PR feedback path. The full unit suite remains authoritative on pull requests and pushes to the primary branch, and browser/E2E workflow gates are unchanged. A periodic or nightly qualification must run the complete gates; `.profiles/test-cache/` is never portable evidence and is not shared through CI.

The expensive correctness harness materializes each fixed historical sample in an invocation-owned worktree, runs Vitest's independent `--changed` mode and a full retry-free unit suite, attributes changed-run failures against a clean baseline when needed, and fails on any required file absent from the affected plan. Its isolation and comparison primitives are pinned in the fast unit suite; the multi-install/full-run sample belongs in manual or periodic qualification.

## Remaining improvement path

Phase 2 production-domain extraction remains separate work. Smaller reliable selections require fewer tests to boot the whole gateway or import the whole UI:

1. Extract pure workflow, gate, config-cascade, proposal, scheduling, session, and reducer decisions behind explicit module boundaries.
2. Move decision coverage to fast direct tests while retaining a small set of gateway/UI wiring contracts.
3. Split broad runtime boundaries only when a new dependency contract and regression evidence make that narrower attribution sound.
4. Re-measure selected counts and actual wall time after each extraction; do not weaken the fail-closed rules to manufacture a faster headline.

The current result is trustworthy selective feedback, not a claim that the coupled suite has become a true test pyramid.
