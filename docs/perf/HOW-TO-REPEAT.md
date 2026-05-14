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

## 9. Adding a new progression step

The `docs/perf/sidebar-nav-report.html` top panel — **"Shipped Progression"** —
shows the cumulative latency descent as merged wins land. Every change we
intend to ship to master earns a new point on this chart, measured on the
canonical realistic-large fixture with n=5 replicates and ALL default-ON
flags active up to that step.

The wrapper `scripts/perf-progression.mjs` orchestrates one step. It calls
`perf-bench.mjs` 5 times with the right flags, then stamps the resulting
history JSONs with `kind: "progression"` + step metadata so the report
picks them up.

### Recipe — after shipping a new win

1. Land the optimisation and add its flag to `DEFAULT_ON_FLAGS` in
   `src/app/perf-flags.ts` (so it is on by default).
2. Look at the existing top progression step in the report. Whatever its
   `--step N` is, your new point is `N+1`.
3. Append the new ship-tag to the comma-separated `--shipped` value (every
   previously-shipped tag stays in the list — the point measures the
   *cumulative* effect, not the marginal one).
4. Run with the new step number, label, and updated `--shipped` set:

   ```bash
   node scripts/perf-progression.mjs \
     --step <N+1> \
     --label "+OptX" \
     --flags "" \
     --shipped "opt-a,opt-x" \
     --n 5 --fixture-size large
   ```

   `--flags ""` runs with the default flag set (every default-ON win
   active). Use `--flags "-someFlag"` only when you need to explicitly
   disable a default-ON win at a step (e.g. the step-0 baseline disables
   Opt-A to anchor the chart at the pre-Opt-A latency).
5. The wrapper writes five `<sha>-progression-step{N+1}-{label-slug}-{i}.json`
   files into `docs/perf/history/`, regenerates the report, and adds the
   new point to the progression line + summary table.
6. Commit the 5 new history JSONs + the regenerated report HTML.

### Recipe — seeding the panel from scratch

```bash
# step 0 — baseline (Opt-A explicitly disabled)
node scripts/perf-progression.mjs \
  --step 0 --label baseline \
  --flags "-deferOffscreenRender" --shipped "" \
  --n 5 --fixture-size large

# step 1 — +Opt-A landed (default flags = Opt-A default-ON)
node scripts/perf-progression.mjs \
  --step 1 --label "+Opt-A" \
  --flags "" --shipped "opt-a" \
  --n 5 --fixture-size large
```

### Read the chart, not the prose

`docs/perf/sidebar-nav-baseline.md` carries a one-paragraph pointer in
§7.0 explaining what the panel is; the **numbers live in the report
itself** so they can't go stale relative to the history JSONs. If you
find yourself tempted to paste the latest p50s into the markdown, don't
— regenerate the report and link to it.

## See also

- [`README.md`](README.md) — harness env vars, history JSON schema, opt-in.
- [`sidebar-nav-baseline.md`](sidebar-nav-baseline.md) — baseline numbers,
  ranked hotspots, shipped wins (§7), and the "tried, didn't pay off"
  postmortem appendix (§6).
- [`real-session-profile.md`](real-session-profile.md) — message-shape and
  tool-block size distribution the fixture is calibrated against.
