# Test suite speed and affected selectivity

> **Historical layout notice.** This document preserves migration, incident, or measurement
> evidence from before Bobbit adopted the canonical `tests/` hierarchy. Old `tests2/`
> and non-semantic test paths, map/affected-selector references, commands, counts, and
> lane names below describe the recorded revision; they are not current instructions.
> Keep measured citations unchanged. For current placement and discovery, use [Testing
> Strategy](../testing-strategy.md) and [`scripts/testing/layout-policy.mjs`](../../scripts/testing/layout-policy.mjs).

This page records the measured cost and selectivity of the former affected-test runner. That runner, its dependency graph, execution map, correctness harness, and local PASS cache have been removed; Bobbit now runs deterministic complete lanes. The measurements remain useful evidence for why maintaining selective execution was not worth its complexity, but they do not describe an available workflow.

## Measured full-gate baseline

Measurement snapshot: goal revision `e0391f090` on a Windows host, 2026-08-04. Counts come from that revision's authoritative execution map and Vitest output, not a source glob. Later correctness-harness hardening is documented separately below; these timings were not silently relabelled as measurements of a later revision.

| Gate | Result | Runner duration |
|---|---:|---:|
| `npm run test:unit` | 1,035 passed files + 3 skipped = **1,038**; 9,557 passed tests + 20 skipped = **9,577** | **193.37 s** |

Browser and E2E were not remeasured for this unit-selector snapshot. At that revision, the unit suite used one Vitest coordinator and a fixed three-worker cap. Increasing local concurrency was not the affected runner's safety mechanism: selection reduced the set, while the complete gate remained the backstop.

## Measured selection proof

The following command was run at `e0391f090` against that checkout's **1,038-file** unit inventory:

```bash
npm run test:affected:proof -- 14 --json .profiles/affected-proof.json
```

It evaluated 14 recent `origin/main` commits plus the seven fixed acceptance samples: one `SKIP-ALL`, 16 bounded, and four `RUN-ALL`. Bounded rows selected an average of **506 files**; skip, run-all, and zero rows were excluded from that average. The mean bounded classification time was **17 ms** after graph construction. There were no suspicious non-documentation zeroes.

### Baseline versus current-checkout replay

These rows replay historical change records through the graph and inventory at `e0391f090`. They are useful for comparing current selector behavior, but they are not exact-revision correctness plans.

| Scenario | Evidence | Mode and cache policy | Selected / 1,038 | Plan time | Why |
|---|---|---|---:|---:|---|
| No selector | local full run at `e0391f090` | full baseline | **1,038** | 193.37 s Vitest | Previous per-change behavior and current authority. |
| Docs-only | fixed synthetic edit atop `fd25842abf` | `SKIP-ALL`, eligible | **0** | 1 ms | Known unclaimed documentation has no unit consumer. |
| UI-only | fixed historical commit `75ffcc7c95` | bounded, eligible | **183** | 1 ms | UI entry/DOM and direct-reader closures. |
| PR #1071 | fixed historical commit `7a42e234ca` | **`RUN-ALL`, bypass** | **1,038** | 3 ms | The change includes `vitest.config.ts` and suite-wide run-isolation/setup. Its 1,038-file graph-only diagnostic is non-executable. |
| PR #1072 | fixed historical commit `3d99218c57` | bounded, eligible | **568** | 43 ms | Server/shared/app/UI changes plus a recognized data-only execution-table edit produce a genuine subset. |
| Dependency bump | fixed historical commit `7bf525cb2f` | **`RUN-ALL`, bypass** | **1,038** | 3 ms | Dependency-bearing `package.json` and lockfile changes can alter every test. The 626-file graph-only count is diagnostic only. |
| Role + tool inputs | fixed historical commit `f747186a88` | bounded, eligible | **446** | 2 ms | Shipped YAML/prompt owners and loader/policy/budget canaries. |
| Marketplace pack | fixed historical commit `4aba79b60f` | bounded, eligible | **421** | 2 ms | Pack owners, loaders, policies, and direct canaries. |

“Plan time” above is the proof row's classification timer. It excludes graph construction, Git history reads, cache work, and Vitest execution. Within this current-checkout replay, `RUN-ALL` rows report the complete 1,038-file executable plan; the proof never substitutes a smaller graph-only diagnostic for execution.

The historical proof is not a correctness run. It demonstrated the selector rules then in effect and caught blind zeroes; the now-removed correctness qualification built each plan from exact revision files and compared it with independent Vitest and full-run evidence.

### Exact-revision plan measurements

Later correctness hardening added revision-local execution-map and graph construction. A plan-only probe measured and pinned the two acceptance commits without reusing the current 1,038-file denominator:

| Scenario | Exact revision inventory | Executable plan | Compatibility detail |
|---|---:|---:|---|
| PR #1071, `7a42e234ca` | **991** | **`RUN-ALL` 991/991**, cache bypass | `vitest.config.ts` remains a justified whole-suite boundary; its 991-file graph-only closure is non-executable. |
| PR #1072, `3d99218c57` | **1,004** | **bounded 565/1,004**, cache eligible | Base closure 556 plus nine quarantined live historical tests; the graph-only diagnostic is 555 and is non-executable. |

These are selector-plan measurements, not Vitest execution timings. Their denominators differ because each comes from its checked-out revision's own `tests2/tests-map.json`. The focused exact-revision regression pins them:

```bash
npm run test:unit -- tests2/core/affected-correctness-harness.test.ts
```

The current-checkout replay above and the exact-revision report answer different questions and must not be averaged together.

## Synthetic non-code and runtime probes

These probes used the current checkout and this command shape:

```bash
node scripts/affected/run.mjs --changed <repo-path> --dry --no-cache --json
```

The JSON `wallMs` includes graph construction and runner planning; `--dry` prevents Vitest execution. These are representative synthetic path probes, not historical diffs.

| Changed input | Family | Mode | Selected / 1,038 | Dry wall |
|---|---|---|---:|---:|
| `defaults/roles/coder.yaml` | built-in role | bounded | **388** | 2.477 s |
| `defaults/tools/filesystem/read.yaml` | built-in tool | bounded | **428** | 2.486 s |
| `market-packs/pr-walkthrough/pack.yaml` | marketplace pack | bounded | **421** | 2.458 s |
| `.claude/skills/qa-test/SKILL.md` | shipped skill | bounded | **376** | 2.449 s |
| `workflows/test-fast.yaml` | workflow template | bounded | **412** | 2.410 s |
| `.bobbit/config/project.yaml` | committed config cascade | bounded | **462** | 2.463 s |
| `AGENTS.md` | prompt/authoring input | bounded | **367** | 2.525 s |
| `src/shared/base-path.ts` | shared server-runtime dependency | bounded | **427** | 2.527 s |

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
| Cold | `BOUNDED` | 3 | 0 | 3 | **9.589 s** |
| Warm | `CACHE-HIT-ALL` | 3 | 3 | 0 | **2.735 s** |

The warm run still pays graph and fingerprint cost. This single small case is about **3.5×** faster by runner wall time; it is not evidence of a general 10× improvement. Test-file cost varies widely, and the historical bounded average still selects 506 of 1,038 files. Claims about end-to-end speed must include Vitest execution on the actual change set rather than extrapolate from selected counts.

## Historical Windows affected-runner execution overhead

Selector breadth and runner overhead were separate costs. The measurements above describe how many tests a change selected; the August 2026 I/O work reduced the cost of deciding, executing, and certifying that plan by moving policy matrices behind an in-process planner/executor seam. One E2E owner retained the CLI and real-Git boundary, so the faster unit matrix did not weaken change-collection evidence.

At exact stacked baseline `626f3cf1`, the two affected-runner files took 12.9 s of profiler wall, 9.56 s of Vitest duration, and 17.04 s of cumulative file time. The historical split at `094d14ae` remains the audited 29.5 s comparison point. Three clean retry-free Windows rounds after `8cc7b01b` measured:

| Round | Profile wall | Vitest | Cumulative files |
|---:|---:|---:|---:|
| 1 | 3.808 s | 0.781 s | 0.456 s |
| 2 | 2.477 s | 0.827 s | 0.539 s |
| 3 | 2.470 s | 0.814 s | 0.489 s |
| **Mean** | **2.918 s** | **0.807 s** | **0.495 s** |

The after rounds launched no Node process and only the shared coordinator's ten Git bootstrap commands. The affected policy cases therefore launched zero subprocesses or workers: **10 total target launches versus 185 (62 Node + 123 Git), a 94.6% reduction**. Mean cumulative file time fell 97.1% from the exact baseline, and mean wall was 90.1% below the audited 29.5 s split. The separate affected E2E owner passed 2/2 with zero retries in three rounds at a 2.634 s mean external wall.

See [the Windows unit profile](windows-unit-profile-2026-07-14.md#august-2026-windows-unit-io-reduction) for commands, raw evidence paths, Hindsight and incidental-Git results, one-init proof, caveats, and the exact retained-boundary table.

## Why bounded sets remained large

The selector removed the previous blind spots without pretending that Bobbit had fine-grained domain boundaries:

- Gateway tests depend on the transitive server runtime entry, including imported shared modules. This is sounder and narrower than treating all `src/server/**` as equivalent, but a widely imported runtime file still reaches many boot tests.
- Happy-DOM tests depend on the UI entry boundary. The app shell and global state keep many UI files connected.
- Shipped role/tool/skill/pack/workflow/config inputs are intentionally connected to production loaders and direct policy, prompt, and budget canaries.
- Vitest configuration, lockfiles, TypeScript configuration, dependency topology, selector/runtime code, unknown infrastructure, and unresolved executable old edges deliberately invalidate the entire unit suite. Git records are collected before graph construction, so tombstones retain declared non-code ownership for deletes and rename old sides; they do not claim to reconstruct a deleted source file's former static imports.

Over-selection cost time; under-selection created false confidence. The former gate chose the former whenever it lacked a maintainable proof.

## Historical correctness model

At this snapshot, the affected runner was the default local feedback path while the complete unit suite remained authoritative. Its checkout-local `.profiles/test-cache/` state was never portable evidence or shared through CI. Both the selective runner and this cache contract have since been removed.

The expensive correctness harness materialized each fixed historical sample in an invocation-owned worktree and built its plan from exact revision files, a revision-local execution-map loader, and the historical inventory. It audited selector declarations against that tree: absent future declarations were ignored, live unresolved or dynamic unit consumers were quarantined into non-documentation bounded plans, and other graph or ownership incompatibility escalated to `RUN-ALL`. These details explain the measured maintenance cost; they are not current runner behavior.

The harness ran Vitest's independent `--changed` mode and a full retry-free unit suite, attributed changed-run failures against a clean baseline when needed, and failed on any required file absent from the affected plan. Missing, partial, crashed, or contradictory evidence failed before comparison. This machinery was deleted when convention-based complete lanes replaced affected selection.

## Improvement path considered at the snapshot

Phase 2 production-domain extraction was proposed as separate work. Smaller reliable selections would have required fewer tests to boot the whole gateway or import the whole UI:

1. Extract pure workflow, gate, config-cascade, proposal, scheduling, session, and reducer decisions behind explicit module boundaries.
2. Move decision coverage to fast direct tests while retaining a small set of gateway/UI wiring contracts.
3. Split broad runtime boundaries only when a new dependency contract and regression evidence make that narrower attribution sound.
4. Re-measure selected counts and actual wall time after each extraction; do not weaken the fail-closed rules to manufacture a faster headline.

The recorded result was trustworthy selective feedback, not a claim that the coupled suite had become a true test pyramid.
