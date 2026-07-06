# EXP-003: Warm Pool Spawn Latency A/B

Status: measured; pre-registration was committed before data collection.
Registered: 2026-07-06.
Decision lane: evidence only; no product-default flips in this experiment.

## Question

Should the dark-shipped pi warm process pool (`BOBBIT_WARM_POOL=1`) be
considered for default-on rollout based on session spawn latency, or should it
remain opt-in until further product instrumentation or operational evidence
exists?

## Hypothesis

For eligible normal sessions, enabling the pi warm process pool will reduce the
time from `createSession` call start to the first agent-ready signal after the
session is created. The expected mechanism is that a miss on one session warms a
pool entry for the same project/cwd/resolved-args key, and the paired follow-up
session can claim that already-started process instead of paying cold bridge
startup and extension loading on the critical path.

The pool may add idle-process memory overhead and may not help if the target
session shape is ineligible, if the mock harness bypasses the expensive work, or
if the second session cannot reuse the same warm key.

## Arms

- `off`: current default behavior. `BOBBIT_WARM_POOL` is unset or set to `0`;
  `SessionManager` does not pass a `PiProcessPool` into session setup.
- `on`: opt-in behavior selected by `BOBBIT_WARM_POOL=1`; the existing
  `PiProcessPool` is active and eligible session setup may claim an idle
  bridge. Pool misses must fall back to the same cold path.

The experiment does not change the product default.

## Assignment

Unit of analysis: one eligible normal session spawn.

Assignment rule: deterministic paired, interleaved replay. Each pair uses the
same isolated in-process gateway harness, same registered project, same cwd, and
same session options as closely as the public test helpers allow. Pair `i` is
run in fixed order `off[i]`, `on[i]` to give the `on` arm a prior same-key miss
and background fill before its measured claim attempt. The `on` arm may include
a warm-up miss that is not counted as the measured spawn when needed to create a
ready pool entry for the measured same-key session.

Isolation: use only the repo's E2E in-process gateway harness and isolated dirs
following `tests/e2e/e2e-setup.ts`; do not touch the dev server or real
`.bobbit/` state.

## Metrics

- Primary latency: milliseconds from immediately before the `createSession`
  call to the first agent-ready signal for that session. The preferred ready
  signal is an existing WebSocket/session-status event that proves the agent is
  ready for user work. If the existing harness cannot observe this cleanly, add
  only a default-silent, observe-only timing hook behind an experiment env flag
  and record that limitation in Results.
- Pool hit rate when `on`: measured from `PiProcessPool.getMetrics()` as
  `hits / (hits + misses)` for measured `on` spawns, with warm-up misses
  reported separately.
- Idle memory overhead when measurable: resident set size delta attributable to
  idle warm pool processes after the pool reaches ready state, measured from
  child process RSS if the harness exposes PIDs, otherwise process-level RSS
  before/after with that limitation stated. If neither is reliable, report
  `not measurable in harness`.
- Operational notes: count spawn failures and unexpected ineligible/miss cases
  from pool metrics and session setup outcomes.

## Sample Size Target

Minimum: at least 10 paired measured spawns per arm, interleaved, for at least
20 measured session spawns total. The `on` arm must attempt to measure at least
10 warm-claim spawns after same-key warm-up. Warm-up misses used only to
populate the pool are not counted toward the measured sample size.

## Success Criteria

Call the result `recommend-default-on-follow-up` only if all conditions hold:

- at least 10 valid paired measured spawns per arm,
- `on` pool hit rate for measured spawns is at least 80%,
- median paired primary latency is at least 20% lower for `on`,
- p90 primary latency is not worse for `on` by more than 10%,
- measured idle memory overhead is less than 200 MiB per ready pool process, or
  memory overhead is not measurable but no process leak/spawn-failure signal is
  observed.

Call the result `keep-dark` if the valid sample size is reached and either
latency is slower on median, measured-spawn hit rate is below 50%, or idle
memory overhead exceeds 300 MiB per ready pool process.

Otherwise call the result `inconclusive`.

## Analysis Plan

Run a dedicated E2E/unit-harness measurement that emits:

- machine-readable JSON rows for every pair/arm spawn,
- a markdown summary table,
- the exact command, commit, environment flags, and harness limitations.

The measured results and recommendation section must be appended to this
document only after this pre-registration has been committed.

## Results

Collected by running `node scripts/exp-warm-pool-report.mjs` after the
pre-registration commit (`a6948372`). Machine-readable output:
`docs/experiments/EXP-003-warm-pool-spawn-latency-results.json`; markdown
summary:
`docs/experiments/EXP-003-warm-pool-spawn-latency-summary.md`.

Generated: 2026-07-06T00:51:44.161Z (UTC).

Harness notes:

- The measurement used an isolated in-process gateway and the repo
  `tests/e2e/mock-agent.mjs` as a real `RpcBridge` child process, not the
  `InProcessMockBridge` shortcut.
- The primary ready signal was `SessionManager.createSession` returning a
  session whose normal setup path had set `status` to `idle`.
- Child-process RSS was measured from the warmed idle pool entry via `ps`;
  the first sandboxed pass could not read RSS, so the final recorded pass was
  rerun with approval for the same script command.

| Metric | `off` | `on` |
|---|---:|---:|
| Measured spawns | 10 | 10 |
| Median latency | 126.2 ms | 28.5 ms |
| Mean latency | 142.9 ms | 28.5 ms |
| p90 latency | 127.7 ms | 29.6 ms |
| Min latency | 124.0 ms | 26.6 ms |
| Max latency | 295.2 ms | 29.8 ms |

| Pool metric | Value |
|---|---:|
| Measured `on` hits | 10 |
| Measured `on` misses | 0 |
| Measured `on` hit rate | 100.0% |
| Warm-up misses | 10 |

| Paired effect | Value |
|---|---:|
| Median paired reduction | 77.8% |
| Median paired reduction | 97.2 ms |
| p90 regression vs `off` | -76.8% |

| Memory | Value |
|---|---:|
| Measurable | yes |
| Median idle RSS per ready process | 57.8 MiB |
| p90 idle RSS per ready process | 58.0 MiB |
| Max idle RSS per ready process | 58.1 MiB |

## Recommendation

Result: `recommend-default-on-follow-up`.

The preregistered success thresholds passed in this isolated harness: 10 valid
paired measured spawns per arm, 100% measured `on` hit rate, 77.8% median
paired latency reduction, no p90 regression, and max measured idle RSS below
200 MiB per ready pool process.

This is evidence for considering default-on in a follow-up lane, not a default
flip by itself. The harness uses the repo mock agent, so it proves the
session-setup and pool-claim mechanism under real child-process transport but
does not measure production model/provider startup variance.
