# Sidebar nav perf instrumentation

This directory holds the perf-trace primitive, harness, and reports that
underpin the "make sidebar navigation feel snappy" goal. The instrumentation
exists because the only honest way to make a UI faster is to measure it first
— ad-hoc `performance.now()` sprinkles and gut-feel optimisations don't move
the needle and often add complexity that doesn't earn its keep. The pieces
below are designed to make the click → first-paint critical path observable
end-to-end (browser + REST + WS + render) so optimisations can be A/B-tested
against real numbers, and so regressions show up in a cross-commit chart
instead of a user bug report.

## What lives here

| File | Purpose |
|---|---|
| [`sidebar-nav-baseline.md`](sidebar-nav-baseline.md) | **Source of truth for the numbers.** Phase 1 baseline, Phase 2A realistic-fixture re-baseline, Phase 2B `lazyToolContent` A/B notes, ranked hotspots, "tried, didn't pay off" appendix. |
| [`real-session-profile.md`](real-session-profile.md) | Read-only profile of the host's real session JSONL corpus — file-size distribution, message-shape histograms, tool-block size tails. Calibrates the harness fixture against reality. |
| [`sidebar-nav-report.html`](sidebar-nav-report.html) | Cross-commit chart, regenerated at the end of every harness run by `scripts/perf-report.mjs`. Open it in a browser; inline SVG, no build step. |
| `history/<sha>.json` | One JSON file per harness replicate, keyed by HEAD short SHA, committed to git. The report reads every file in this directory. Schema described below in **History JSON schema**. |
| `mockups/` | Designer iterations on the cross-commit report HTML. Not consumed by code. |

The rationale for instrumenting these specific spans, and the design
constraints around "cheap when disabled", live in the goal spec and in
`sidebar-nav-baseline.md §7`.

## Opting in

The trace primitive is **off by default** so production users pay no cost.
Two opt-in switches:

- **Persistent:** `localStorage.setItem('bobbitPerf', '1')` then reload.
- **One-shot:** load any URL with `?perf=1`.

When enabled, traces accumulate in a ring buffer reachable as
`window.__bobbitPerf` in DevTools (`.entries()`, `.summary()`, `.clear()`).
Trace lines also flow into the standard log pipeline so they survive into
screenshots and bug-report exports.

The Phase 2B lazy-tool-content experiment is gated by a separate flag:

- `localStorage.setItem('bobbitPerfFlags', 'lazyToolContent')` — client adds
  `?stripToolContent=1` to `GET /api/sessions/:id` and hydrates large tool
  blocks on demand via the existing `/tool-content/:mi/:bi` endpoint.

## Running the harness

The harness is a Playwright spec under `tests/manual-integration/` — **not in
CI**, run on demand to refresh the baseline or A/B test a hypothesis:

```bash
BOBBIT_TIMING_LOG=1 npx playwright test \
  --config playwright-manual.config.ts \
  --grep "perf-sidebar-nav"
```

It boots an isolated gateway, seeds 10 sessions (with optional realistic
JSONL transcripts), drives cold + warm + goal passes through a headless
browser, dumps the perf ring buffer plus the server's `[timing]` log tail,
and finally calls `scripts/perf-report.mjs` to refresh
`sidebar-nav-report.html`.

### Environment variables

| Var | Default | Effect |
|---|---|---|
| `BOBBIT_TIMING_LOG` | unset | Server emits `[timing] METHOD path Xms bytes=B io=N` for the five hot endpoints. The harness sets this. |
| `BOBBIT_TIMING_LOG_MIN_MS` | `0` (set by harness) | Suppress server timing lines under N ms. |
| `BOBBIT_PERF_FIXTURE_SIZE` | `medium` | `small` / `medium` / `large` — controls the seeded transcript size (10 / 50 / 200 messages per session). See `sidebar-nav-baseline.md §5`. |
| `BOBBIT_PERF_FLAGS` | unset | Comma-separated perf flags injected via `addInitScript`. Currently only `lazyToolContent`. |
| `BOBBIT_PERF_HISTORY_TAG` | unset | Suffix for the history JSON filename, e.g. `flag-off` → `docs/perf/history/<sha>-flag-off.json`. Use this for A/B runs on the same commit. The bench wrapper appends `-<replicateIdx>` automatically. |
| `BOBBIT_PERF_HISTORY_KIND` | inferred | `baseline` (fixture/harness change) or `experiment` (code-change A/B). Default: `experiment` if `BOBBIT_PERF_FLAGS` is set, otherwise `baseline`. Stamped into the JSON; the report uses this to gate the Δ column. |
| `SCREENSHOTS` | unset | Dump full-page PNGs under `tests/manual-integration/.perf-out/screens/`. |

## Viewing the cross-commit report

Open `docs/perf/sidebar-nav-report.html` directly in a browser. The page
reads every committed `history/<sha>.json` and renders one SVG line chart
per canonical span (p50 solid, p95 dashed) plus a first-vs-latest summary
table. No server, no build step. The report is regenerated automatically at
the end of every harness run; commit the refreshed HTML alongside the new
history entry so the report at HEAD is always accurate.

## History JSON schema (v2)

The cross-commit report distinguishes two kinds of run so that fixture
growth doesn't masquerade as a code regression, and groups replicates so a
single lucky sample doesn't masquerade as a win. Schema:

```jsonc
{
  "commit": "<full sha>",
  "parentCommit": "<sha>",
  "branch": "<name>",
  "timestamp": "ISO-8601",
  "seededSessions": 32,
  "fixtureSize": "medium|large|small",
  "msgsPerSession": 50,
  "perfFlags": "lazyToolContent" | null,
  "tag": "opt-b-on-3" | null,                  // includes replicate suffix
  "kind": "baseline" | "experiment",            // default "baseline"
  "experimentTag": "opt-b",                     // optional; required to pair A/B
  "experimentCondition": "off" | "on" | ...,   // optional; the leg of the pair
  "spans": { "<span>": { "p50": ..., "p95": ..., "p99": ..., "n": ..., "mean": ..., "max": ... } }
}
```

- **`kind: "baseline"`** — a fixture or harness change. NOT comparable
  across commits as a code-perf signal. The report renders these as **open
  dots** in the timeline and omits the Δ column when computing against
  another commit.
- **`kind: "experiment"`** — a code-change A/B run. Two experiment groups
  at the same commit with matching `experimentTag` and differing
  `experimentCondition` form an A/B pair; the report computes Δ between
  them and surfaces it on the headlines + pair tables.
- **Replicates** are detected by filename: `<sha>-<tag-base>-<N>.json`.
  Files sharing a `(commit, tag-base)` are grouped, and the report shows
  median p50 / p95 with **min/max error bars** across replicates.
  Singletons render with a `(n=1)` halo so the reader can see the
  confidence level at a glance.

## Decision rule

A "win" must pass **both** of these — single-sample improvements are not
enough, and single-span regressions caused by fixture growth don't count
as regressions:

1. **≥100 ms p50 reduction on the target span** (or move the span below
   the 100 ms "snappy" threshold).
2. **The median-of-medians delta must exceed the min/max range of either
   condition.** If the gain is smaller than the noise floor measured
   across 5 replicates, it isn't a gain — it's sampling luck. The report
   marks each pair-row "exceeds noise" or "within noise".

## Adding a new optimisation

1. Read [`sidebar-nav-baseline.md`](sidebar-nav-baseline.md) — ranked
   hotspots and the wins/no-ops appendix live there.
2. Land the change behind a perf flag (see `src/app/perf-flags.ts`).
3. Run **5 replicates per condition** with the bench wrapper on the same
   commit, e.g.
   ```bash
   node scripts/perf-bench.mjs --tag opt-x-off --kind experiment --n 5 --fixture-size large
   node scripts/perf-bench.mjs --tag opt-x-on  --kind experiment --n 5 --fixture-size large --flags myFlag
   ```
   This lands 10 JSONs in `docs/perf/history/` that the report groups into
   one A/B pair with min/max bands.
4. Open `docs/perf/sidebar-nav-report.html` and check the **A/B comparisons**
   section. The pair-row must show a Δ that **exceeds** both conditions'
   min↔max ranges ("exceeds noise" badge).
5. If both decision-rule clauses pass, add a Phase 3 budget E2E under
   `tests/e2e/ui/perf-sidebar-nav.spec.ts` so the win doesn't silently
   regress.
6. Either way, record the outcome in `sidebar-nav-baseline.md`: wins in §3
   with before/after, no-ops in §6 ("tried, didn't pay off") so future
   agents don't re-litigate.

### Re-baselining (fixture or harness change)

If you change the fixture or the harness itself, run **once** with
`BOBBIT_PERF_HISTORY_KIND=baseline` (the default when no flags are set)
and a descriptive `BOBBIT_PERF_HISTORY_TAG` like `realistic-large` or
`rapid-cadence`. Baselines are NOT compared across commits — they exist
only to anchor subsequent A/B pairs.
