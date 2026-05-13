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
| `history/<sha>.json` | One JSON file per harness run, keyed by HEAD short SHA, committed to git. Shape: `{ commit, parentCommit, branch, timestamp, spans: { name: { p50, p95, p99, n, mean, max } } }`. The report reads every file in this directory. |
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
| `BOBBIT_PERF_HISTORY_TAG` | unset | Suffix for the history JSON filename, e.g. `flag-off` → `docs/perf/history/<sha>-flag-off.json`. Use this for A/B runs on the same commit. |
| `SCREENSHOTS` | unset | Dump full-page PNGs under `tests/manual-integration/.perf-out/screens/`. |

## Viewing the cross-commit report

Open `docs/perf/sidebar-nav-report.html` directly in a browser. The page
reads every committed `history/<sha>.json` and renders one SVG line chart
per canonical span (p50 solid, p95 dashed) plus a first-vs-latest summary
table. No server, no build step. The report is regenerated automatically at
the end of every harness run; commit the refreshed HTML alongside the new
history entry so the report at HEAD is always accurate.

## Adding a new optimisation

1. Read [`sidebar-nav-baseline.md`](sidebar-nav-baseline.md) — ranked
   hotspots and the decision rule ("≥100ms p50 reduction on a critical-path
   span, or moves a span below the 100ms snappy threshold") live there.
2. Land the change behind a perf flag (see `src/app/perf-flags.ts`).
3. Run the harness twice on the same commit with `BOBBIT_PERF_HISTORY_TAG=flag-off`
   then `=flag-on` plus `BOBBIT_PERF_FLAGS=<yourFlag>`.
4. Compare in the cross-commit report.
5. If it pays off, add a Phase 3 budget E2E under `tests/e2e/ui/` so the win
   doesn't silently regress. The scaffold is
   `tests/e2e/ui/perf-sidebar-nav.spec.ts`.
6. Either way, record the outcome in `sidebar-nav-baseline.md` — wins in §3
   (ranked hotspots) with before/after, no-ops in §6 ("tried, didn't pay
   off") so future agents don't re-litigate.
