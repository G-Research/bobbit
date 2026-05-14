# How to repeat the sidebar-nav perf analysis

Step-by-step recipe for adding a new optimisation hypothesis to the sidebar-nav
perf workflow. For background and the numbers, start at
[`sidebar-nav-baseline.md`](sidebar-nav-baseline.md); for the harness mechanics
and env-var reference, see [`README.md`](README.md).

This file exists because Phase 2 ran nine experiments and shipped one. The
delta between "ran" and "shipped" is mostly process — discipline around
replicates, fixture choice, and architectural sanity-checks. The steps below
encode that discipline so the next agent doesn't repeat avoidable mistakes.

## 1. Run the canonical baseline harness

```bash
BOBBIT_PERF_FIXTURE_SIZE=large \
BOBBIT_PERF_HISTORY_TAG=baseline \
BOBBIT_PERF_HISTORY_KIND=baseline \
  npx playwright test --config playwright-manual.config.ts \
  --grep "perf-sidebar-nav"
```

Writes `docs/perf/history/<sha>-baseline.json` and refreshes
`docs/perf/sidebar-nav-report.html`. The harness is NOT in CI — run on demand
when the fixture, harness, or baseline numbers need a refresh.

## 2. Add a new optimisation hypothesis

1. Register the flag in `src/app/perf-flags.ts` — append to `KNOWN_PERF_FLAGS`.
2. Gate the optimisation behind `isPerfFlagEnabled('myFlag')`.
3. Add unit coverage under `tests/` and (if user-visible) an E2E under
   `tests/e2e/ui/`.

Keep the change small and reversible. If the hypothesis doesn't pay off, you
will be reverting the code (see step 7).

## 3. Run an A/B with n=5 replicates

```bash
node scripts/perf-bench.mjs --tag opt-x-off --kind experiment --n 5 --fixture-size large
node scripts/perf-bench.mjs --tag opt-x-on  --kind experiment --n 5 --fixture-size large --flags myFlag
```

Lands 10 history JSONs under `docs/perf/history/` keyed by
`<sha>-opt-x-{off,on}-{1..5}.json`. The report groups them into one A/B pair
and shows median p50 / p95 with min/max error bars across replicates.

## 4. Regenerate the report

```bash
node scripts/perf-report.mjs
```

Open `docs/perf/sidebar-nav-report.html` directly in a browser (inline SVG, no
build step). Inspect the **A/B comparisons** panel.

## 5. Decision rule

A win must pass ALL of:

- **≥100 ms p50 reduction** on a critical span, OR moves a critical span from
  >100 ms to <100 ms.
- **Median delta exceeds the min/max range of either condition.** If the gain
  is smaller than the run-to-run noise floor, it is sampling luck, not a win.
  The report marks each pair-row "exceeds noise" or "within noise".
- **No critical span regresses by >50 ms median.**

Critical spans: `nav.session.ready`, `nav.session.cold`, `nav.goal.ready`,
`nav.goal.cold`, `paint.first`, `rapidnav.keystroke.{cached,uncached}`.

## 6. If it's a win

- Add the flag to `DEFAULT_ON_FLAGS` in `src/app/perf-flags.ts`.
- Document in `docs/perf/sidebar-nav-baseline.md §7` (Shipped wins) with the
  before/after numbers from your A/B.
- Pin the new p95 budget in `tests/e2e/ui/perf-sidebar-nav.spec.ts` so the win
  cannot silently regress.

## 7. If it's not a win

- **Revert all code changes.** Don't leave the flag in tree "just in case" —
  every dead flag is a future maintenance tax and a footgun for the next
  optimiser who assumes the plumbing is still wired correctly.
- Keep ONLY the postmortem in `docs/perf/sidebar-nav-baseline.md §6` ("Tried,
  didn't pay off"). One paragraph covering the hypothesis, the numbers, and
  why it didn't work. End with a `**Code reverted at <sha>** — postmortem
  retained` footer so future agents see at a glance that the code is gone.
- Optionally delete the experiment's `history/<sha>-opt-x-*.json` files if
  they no longer reflect any in-tree code — the postmortem in §6 is the
  durable record.

## 8. Common pitfalls (from this goal's actual learnings)

- **Single-sample noise.** n=1 will mislead you. The initial Opt-D
  "−422 ms win" turned out to be a single cold-cache OFF replicate against a
  warm-cache ON; once both arms ran n=5 from a warm cache, the delta
  collapsed into the ±50 ms jitter floor. **Always use n=5.** The
  `perf-bench` wrapper makes this one flag.
- **Cold vs warm cache.** The first harness run after a fresh checkout sees
  cold OS / Docker / disk-cache effects that don't recur. Discard the first
  run of a fresh checkout, or run a throwaway warm-up before the real
  replicates. Interleaving off/on/off/on/... across replicates also spreads
  any residual drift across both arms.
- **Fixture distribution.** Synthetic empty fixtures produce zero useful
  signal — `reducer.rehydrate` was 0.07 ms with empty transcripts but is
  still 0.3 ms with realistic 200-msg transcripts, and `paint.first` p95
  more-than-tripled. Tune fixtures to the shape in
  `docs/perf/real-session-profile.md §5` (tool-mix weights, body-size
  buckets, lifecycle records). The default `large` fixture already matches.
- **Architectural mismatches.** Verify the hypothesis is consistent with how
  the system actually works before measuring. Opt-B assumed REST shipped the
  session transcript; in reality REST returns metadata-only and the
  transcript arrives over WebSocket. Opting into `?stripToolContent=1`
  *added* a stripped transcript to REST without removing the WS one — the
  experiment was guaranteed to regress before the first measurement. Read
  the route handler, not just the URL.

## See also

- [`README.md`](README.md) — harness env vars, history JSON schema, opt-in.
- [`sidebar-nav-baseline.md`](sidebar-nav-baseline.md) — baseline numbers,
  ranked hotspots, shipped wins (§7), and the "tried, didn't pay off"
  postmortem appendix (§6).
- [`real-session-profile.md`](real-session-profile.md) — message-shape and
  tool-block size distribution the fixture is calibrated against.
