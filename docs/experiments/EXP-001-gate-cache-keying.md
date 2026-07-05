# EXP-001: Gate Cache Keying A/B

Status: measured; pre-registration was committed before data collection.
Registered: 2026-07-06.
Decision lane: evidence only; no product-default flips.

## Question

Should Bobbit keep gate verification step-cache reuse keyed only by exact commit
SHA, or should the opt-in `BOBBIT_GATE_CACHE=content` strategy be considered
safe and useful enough for a later operational rollout decision?

## Hypothesis

For command verification steps with sound `cacheInputGlobs`, content-keyed reuse
will improve cache hit rate and estimated gate verification wall-clock time
without introducing any unsafe content hit in the corpus. Steps without
`cacheInputGlobs` must remain SHA-exact in both arms.

## Arms

- `sha`: current default behavior. A prior passed step is reusable only when the
  prior signal's `commitSha` exactly matches the current signal's `commitSha`.
- `content`: opt-in behavior selected by `BOBBIT_GATE_CACHE=content`. Exact-SHA
  hits still use the existing SHA cache. Remaining steps may reuse a prior
  passed result across different SHAs only when the step declares
  `cacheInputGlobs`, those globs match at least one tracked file, and `git diff`
  shows no changes under those globs.

The candidate arms already exist in `src/server/agent/verification-logic.ts` as
`buildStepCache` and `buildContentStepCache`. This experiment will not change
the product default.

## Assignment

Unit of analysis: one synthetic gate re-verification scenario.

Assignment rule: deterministic paired replay. Each scenario in the fixed corpus
is evaluated once under `sha` and once under `content`; the pair id is the
scenario id. Scenario execution order is sorted by scenario id, then arm id
(`content`, `sha`) only for deterministic reporting. Primary analysis is paired
by scenario id, not pooled by arm.

The corpus is synthetic by design. Real gate inputs in `.bobbit/state` are not
stable enough for a first proof because they depend on local developer traffic,
branch timing, and private state. The synthetic corpus uses real temporary git
repositories and the same cache decision rules as production, while fixing the
commit graph, touched files, step globs, and step durations in source control.

## Metrics

- Cache hit rate: `cacheHits / cacheableSteps` per arm, plus hit counts split by
  key kind (`sha`, `content`).
- False-hit risk proxy: count of cache hits where the replay metadata says the
  step's declared input surface changed between the prior and current commits.
  This must be zero. This is a proxy, not proof of semantic correctness outside
  the declared globs.
- Estimated wall-clock per verification: sum of declared step runtime for steps
  that miss the cache in that scenario. Hits contribute zero execution time,
  matching the verification harness' step-skip behavior.
- Decision engine wall-clock: elapsed milliseconds spent computing cache
  decisions for each arm, reported separately as implementation overhead and not
  used as the success metric.

## Sample Size Target

Minimum fixed corpus: at least 8 paired scenarios and at least 24 cacheable step
decisions per arm.

The initial corpus must cover:

- exact-SHA re-signal,
- docs-only or unrelated change,
- source change that invalidates Build/Type check/Unit tests,
- test-only change that invalidates Unit tests but not Type check,
- dependency/config change,
- step with no `cacheInputGlobs`,
- glob that matches no tracked paths,
- multiple prior signals where the earliest prior passed result is selected.

## Success Criteria

Call the result `recommend-content-for-next-lane` only if all conditions hold:

- false-hit risk proxy is `0` in both arms,
- `content` cache hit rate exceeds `sha` cache hit rate by at least 20
  percentage points,
- median paired estimated wall-clock is at least 20% lower for `content`,
- decision engine overhead for `content` is less than 5% of its estimated
  wall-clock savings.

Call the result `keep-sha` if the false-hit risk proxy is non-zero, or if
`content` is slower on median estimated wall-clock.

Otherwise call the result `inconclusive`.

## Analysis Plan

Run `node scripts/exp-gate-cache-report.mjs`. The script must emit:

- machine-readable JSON metrics,
- a markdown summary,
- the fixed corpus definition used for the run.

The measured results and recommendation section must be appended to this
document only after this pre-registration has been committed.

## Results

Collected by running `node scripts/exp-gate-cache-report.mjs` after the
pre-registration commit (`85b6470a`). Machine-readable output:
`docs/experiments/EXP-001-gate-cache-keying-results.json`; markdown summary:
`docs/experiments/EXP-001-gate-cache-keying-summary.md`.

Generated: 2026-07-05T23:12:10.878Z (UTC).

| Metric | `sha` | `content` |
|---|---:|---:|
| Paired scenarios | 9 | 9 |
| Cacheable step decisions | 27 | 27 |
| Cache hits | 4 | 11 |
| Cache hit rate | 14.8% | 40.7% |
| SHA-key hits | 4 | 4 |
| Content-key hits | 0 | 7 |
| False-hit risk proxy | 0 | 0 |
| Estimated wall-clock total | 1,845,000 ms | 1,410,000 ms |
| Estimated wall-clock median | 315,000 ms | 180,000 ms |
| Decision engine wall-clock | 0 ms | 347 ms |

Effect summary:

- Cache hit-rate delta: +25.9 percentage points for `content`.
- Total estimated wall-clock savings: 435,000 ms.
- Median estimated wall-clock reduction: 42.9%.
- Median paired reduction: 0.0%, because more than half of the fixed scenarios
  are deliberately conservative no-benefit cases.
- Content decision overhead share of savings: 0.1%.

## Recommendation

Result: `recommend-content-for-next-lane`.

The preregistered success thresholds passed: false-hit risk proxy was zero,
`content` improved cache hit rate by more than 20 percentage points, median
estimated wall-clock was more than 20% lower, and decision overhead was below
5% of estimated savings.

This does not flip a product default. It supports a follow-up lane that measures
`BOBBIT_GATE_CACHE=content` on real gate traffic, or implements concurrent
assignment logging from the A/B framework design before any default-change
decision.
