# EXP-002: Unit Compile Cache A/B

Status: pre-registered; data not yet collected.
Registered: 2026-07-06.
Decision lane: evidence only; no default flips.

## Question

Should Bobbit enable the opt-in Node compile cache for the unit phase by
default, or should `BOBBIT_TEST_COMPILE_CACHE=1` remain opt-in?

## Hypothesis

For repeated full `npm run test:unit` invocations on the same tree, enabling the
unit-phase compile cache will reduce total unit-phase wall-clock time without
introducing correctness risk. The likely benefit, if any, should be strongest in
the node-logic sub-phase because `scripts/run-unit.mjs` applies
`NODE_COMPILE_CACHE` to that runner and its descendants. The browser fixture
phase is not expected to benefit directly.

## Arms

- `off`: current default behavior. The unit runner does not set
  `NODE_COMPILE_CACHE`; the experiment command also unsets any inherited
  `NODE_COMPILE_CACHE`, `BOBBIT_TEST_COMPILE_CACHE`, and
  `BOBBIT_TEST_COMPILE_CACHE_DIR`.
- `on`: opt-in behavior selected by `BOBBIT_TEST_COMPILE_CACHE=1`. The
  experiment command unsets any inherited `NODE_COMPILE_CACHE` and sets
  `BOBBIT_TEST_COMPILE_CACHE_DIR` to a fixed directory under this worktree so
  repeated `on` runs can reuse the cache as shipped.

The lever already exists in `scripts/run-unit.mjs`; this experiment does not
change the product default.

## Assignment

Unit of analysis: one full `npm run test:unit` run on this worktree's tree,
based on `origin/aj-current` at the start of the experiment.

Assignment rule: deterministic paired interleaving. Pair ids are fixed before
measurement: `pair-1` through `pair-5`. Each pair runs the same tree once under
`off` and once under `on`, in the fixed order `off`, `on`. The full collection
order is therefore:

`pair-1/off`, `pair-1/on`, `pair-2/off`, `pair-2/on`, `pair-3/off`,
`pair-3/on`, `pair-4/off`, `pair-4/on`, `pair-5/off`, `pair-5/on`.

Interleaving controls for thermal and host-load drift better than collecting
all runs for one arm first. The host is busy, so the analysis is paired by
pair id and records load average immediately before each run.

## Commands

`off`:

```bash
env -u NODE_COMPILE_CACHE -u BOBBIT_TEST_COMPILE_CACHE -u BOBBIT_TEST_COMPILE_CACHE_DIR npm run test:unit
```

`on`:

```bash
env -u NODE_COMPILE_CACHE BOBBIT_TEST_COMPILE_CACHE=1 BOBBIT_TEST_COMPILE_CACHE_DIR="$PWD/.cache/exp-unit-compile-cache" npm run test:unit
```

Use the runner's own `[run-unit] total wall time ...s` line as the wall-clock
source. Use `/usr/bin/time -p` only if that line is absent.

## Metrics

- Primary: total unit-phase wall-clock seconds from `[run-unit] total wall time`.
- Secondary: node-logic and browser-fixtures wall-clock seconds from
  `[run-unit] <label> finished in ...s`, because the compile cache should affect
  node-logic first.
- Per-file compile time: not measurable with the shipped runner. Do not add
  instrumentation for this experiment unless the existing runner already emits
  it; instead report this metric as unavailable.
- Correctness risk proxy: exit code `0`, `[unit-summary] node=pass
  browser=pass`, and no masked-failure guard warning for every included run.
- Machine context: load average immediately before each run, recorded from the
  runner's startup line and/or `uptime`.

## Sample Size Target

Minimum sample: at least 5 paired runs per arm on the same tree, 10 full
`npm run test:unit` runs total.

Do not change source files, rebuild outputs, test selection, worker overrides,
or the compile-cache directory during collection. The only intentional
difference between paired arms is the compile-cache environment.

## Success Criteria

Call the result `recommend-default-on-follow-up` only if all conditions hold:

- all 10 included runs pass the correctness risk proxy,
- median paired total wall-clock is at least 10% lower for `on`,
- median paired node-logic wall-clock is at least 10% lower for `on`,
- `on` is not slower than `off` in more than one of the five paired total
  wall-clock comparisons.

Call the result `keep-opt-in` if any included `on` run fails the correctness
risk proxy, or if median paired total wall-clock is slower for `on`.

Otherwise call the result `inconclusive`.

## Analysis Plan

This experiment uses a markdown results table rather than a new
`scripts/exp-unit-compile-cache-report.mjs`. EXP-001's report script shape
replays a fixed synthetic corpus inside one Node process and emits derived JSON;
EXP-002 measures real shell-level `npm run test:unit` invocations whose evidence
is the runner's own output plus pre-run load averages. A script would not reuse
EXP-001 cleanly without becoming a bespoke command orchestrator, so the doc
table is the smaller and more faithful artifact.

After committing this pre-registration, run the fixed interleaved sequence,
append the measured results and recommendation below, and do not flip any
default.

## Results

Data not yet collected.
