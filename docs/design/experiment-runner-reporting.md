# Experiment Runner — Reporting Consolidation Design

**Status:** draft (design-doc gate input for the *Experiment runner extension* goal).
**Scope owner:** reporting/dashboards sub-stream.
**Branch:** `goal/bf9e404c/coder-3a0d` (stacked off `goal/hierarchical-g-f6c39aa2` / PR #822).

This document specifies the **shared reporting library** that is the *single
source of truth* for every experiment report and dashboard the experiment-runner
pack produces. It covers data input (registry + raw outcomes), aggregation reuse,
widget rendering reuse, the report route output, the panel dashboard output, the
consolidation path for `graphify-ab` (and an explicit note that it is **absent**
in this branch), and the **pinning tests** that prevent report logic from forking.

It does **not** specify the A/B / autoresearch orchestration, the `spawnGoal` host
capability, or the metric-extractor contract beyond the seams reporting consumes.
Those live in their own sub-stream design docs; this one defines the *reporting*
contract those streams render through.

---

## 1. Problem statement & the forking risk

Research is open-ended: what gets measured and how it is shown changes constantly.
Two front doors (A/B comparison and autoresearch) and three output surfaces
(report route, live panel dashboard, and the soon-to-be-consolidated `graphify-ab`
report) all want to turn the same raw outcome data into the same numbers and the
same charts.

If each surface computes its own medians, spreads, or accept/stop curves, the
numbers drift: the panel says one thing, the generated report another, and the CLI
report a third. **The whole point of this sub-stream is that there is exactly one
module that turns raw outcomes into rendered output, and every surface imports it.**

The PR-walkthrough pack already proved this pattern: synthesis was extracted to a
pure shared module (`src/shared/pr-walkthrough/yaml-to-cards.ts`), bundled into the
pack via `build:packs`, and both the agent side and the pack route consume the one
module (see `docs/design/built-in-first-party-packs.md` §8.4). We reuse that exact
mechanism for reporting.

---

## 2. Survey of what exists in this branch

Tight searches were run under `.claude/`, `defaults/`, `market-packs/`, `docs/`,
`scripts/`, and `tests/`:

- `**/*ab-report*` → **no files.**
- `**/graphify-ab/**` → **no files.**
- `rg "ab-report|graphify-ab"` (whole repo) → **no matches.**
- `rg "graphify" .claude/` → **no matches.**

**Conclusion: `graphify-ab` / `ab-report.mjs` do NOT exist in this branch.** The
goal spec's instruction to "port `.claude/skills/graphify-ab/scripts/ab-report.mjs`
into a shared reporting lib … consolidate that skill onto it" refers to an artefact
that is not present here. This design therefore:

1. Designs the shared reporting lib as the *sole* report engine from day one (no
   pre-existing logic to port), and
2. Defines the **consolidation seam** (§8) so that *if/when* `graphify-ab` (or any
   external `ab-report.mjs`) lands, it is rewritten as a thin wrapper over the lib
   rather than a fork — and a pinning test (§9) makes a fork fail CI.

### 2.1 Patterns we reuse (present in this branch)

- **Pack route module** — `market-packs/pr-walkthrough/lib/routes.mjs`: ESM
  `export const routes = { … }`, executed in the confined worker, reaches only
  `ctx.host.store.*` (pack-scoped) and ambient `node:` modules. This is the model
  for the experiment-runner `report` route.
- **Pack panel** — `market-packs/pr-walkthrough/panels/*.yaml` → `entry:
  ../lib/panel.js`; the panel loads data only via `host.callRoute` and reads
  pack-scoped state via `host.store.*`. This is the model for the dashboard panel.
- **Bundled shared module** — `build:packs` produces a committed, self-contained
  `lib/yaml-to-cards.mjs` from a single `src/shared/...` source. This is the model
  for shipping the reporting lib into the pack served tree without duplication.
- **Cost data shapes** — `src/server/agent/cost-tracker.ts`:
  `RawSessionCost { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  totalCost, goalId?, firstSeenAt? }`, `SessionCost` (adds derived
  `cacheHitRate`), and `TreeCostBreakdown` / `TreeCostEntry` (per-goal rollup over
  a goal subtree). The reporting lib's cost extractor consumes these shapes; it
  does **not** re-derive cache-hit or tree rollups — those are already
  single-sourced in `cost-tracker.ts`.

---

## 3. Architecture overview

```
                         ┌──────────────────────────────────────────────┐
                         │  src/shared/experiment-report/   (ONE SOURCE) │
                         │  ────────────────────────────────────────────│
   raw outcomes  ──────► │  aggregate.ts   (median / spread / filters)   │
   (registry +           │  series.ts      (accept-reject / stop curves) │
    session-costs,       │  view-model.ts  (registry+raw → ReportModel)  │
    gates, tasks)        │  widgets/       (spec-driven renderer registry)│
                         │  index.ts       (buildReportModel, renderHtml) │
                         └───────────────┬───────────────┬───────────────┘
                                         │ bundled by     │ imported by
                                         │ build:packs    │ server/tests directly
                                         ▼                ▼
        market-packs/experiment-runner/lib/experiment-report.mjs   tests/*.test.ts
                    ▲                         ▲                         ▲
                    │ report route            │ dashboard panel         │ pinning tests
        lib/routes.mjs (report)      lib/panel.js (renderReportModel)   (§9)
```

**One source, two consumption modes** (the PR-walkthrough precedent):

- **Pack surfaces** (report route + panel) import the **bundled** copy
  `lib/experiment-report.mjs`, produced by a new `build:packs` entry from the
  `src/shared/experiment-report/` source. Committed, self-contained, no `node:`
  deps in the pure parts.
- **Server / Node tests / a future CLI** import the **source** directly from
  `src/shared/experiment-report/`.

Both are byte-identical logic because the bundle is generated from the source.

---

## 4. Data input — registry + raw outcomes

### 4.1 The results registry (pack store)

Orchestration (A/B fan-out and autoresearch loop) writes a **results registry**
into the pack-scoped `host.store`. Reporting only ever **reads** it. Proposed key
layout (mirrors PR-walkthrough's `job/…`, `binding/…` namespacing):

```
exp/<experimentId>                 → ExperimentDef
exp/<experimentId>/run/<runId>     → RunRecord       (one per variant×repeat or per iteration)
exp/<experimentId>/ledger          → LedgerEntry[]   (autoresearch only; best-so-far feed-forward)
exp/<experimentId>/dashboard       → DashboardSpec   (editable view-spec; §7)
```

`ExperimentDef` (the parts reporting reads):

```ts
interface ExperimentDef {
  id: string;
  mode: "ab" | "autoresearch";
  variants?: VariantDef[];          // A/B: arms; each = { id, label, metadata, inlineRoles?, workflow? }
  repeats?: number;                 // A/B: N per arm
  metrics: MetricSelection[];       // which metrics, aggregation, direction (§5)
  objective?: { metricId: string; direction: "max" | "min" };  // autoresearch
  dashboard?: DashboardSpec;        // optional override of the default view (§7)
}
```

`RunRecord` (the unit reporting aggregates) — written by orchestration after each
child goal completes and verifies:

```ts
interface RunRecord {
  runId: string;
  experimentId: string;
  armId?: string;          // A/B: which variant; autoresearch: candidate id
  repeatIndex?: number;    // A/B: 0..repeats-1
  iteration?: number;      // autoresearch: 0..n
  childGoalId: string;     // the spawned child goal (spawnGoal result)
  status: "pending" | "complete" | "failed";
  verified: boolean;       // correctness gate result (autoresearch reject if false)
  completionBar: string;   // a tag for same-completion-bar filtering (e.g. "all-gates-passed")
  metrics: Record<string, number | null>;   // extracted metric values, keyed by metricId
  raw?: RawOutcomeRefs;    // pointers/snapshots of underlying outcome data (§4.2)
  startedAt?: number;
  completedAt?: number;
}
```

**Key invariant:** `RunRecord.metrics` is the *already-extracted* numeric outcome.
Metric extraction (running the metric-extractor contract over outcome data) happens
in the **orchestration / extractor** sub-stream, not in reporting. Reporting
consumes `RunRecord.metrics` and aggregates. This keeps the reporting lib pure and
deterministic (no I/O, no extractor execution) — essential for the pinning tests.

### 4.2 Raw outcome data

The underlying outcome data the extractors run over (and that reporting may surface
in a "raw" drill-down widget) comes from the standard goal-tree artefacts:

- **`session-costs.json`** — `RawSessionCost[]` keyed per session; rolled up per
  child goal via the existing `cost-tracker.ts` `computeTreeCost` over the child
  goal's subtree (`TreeCostBreakdown`). Reporting's cost extractor reuses this — it
  never re-implements the BFS rollup or the cache-hit formula.
- **`gates.json` + verification records** — pass/fail per gate; the source of
  `RunRecord.verified` and of a "verification outcome" built-in metric.
- **`tasks.json`** — task counts / states; source of throughput-style metrics.

Reporting treats these as **inputs already reduced into `RunRecord.metrics`** by
the extractor stream. The `raw` refs on a `RunRecord` are optional and used only by
drill-down widgets that want to show the underlying numbers; the report model never
recomputes a metric from raw data (that would be a second source of truth).

### 4.3 The pure entry point

```ts
// src/shared/experiment-report/index.ts
buildReportModel(input: {
  def: ExperimentDef;
  runs: RunRecord[];
  ledger?: LedgerEntry[];
  dashboard?: DashboardSpec;   // resolved spec (def.dashboard ?? store ?? default)
}): ReportModel;
```

`buildReportModel` is **pure**: registry objects in, `ReportModel` out. No store
access, no clock, no randomness. The route and the panel both pass the same inputs
and get the same model.

---

## 5. Aggregation reuse

All aggregation lives in `src/shared/experiment-report/aggregate.ts` and is the
only place medians/spreads/filters are computed.

- **A/B aggregation** — for each `(armId, metricId)`, collect the metric value
  across that arm's repeats, apply **same-completion-bar filtering** (drop repeats
  whose `completionBar` differs from the arm's modal bar, so a half-finished run
  doesn't skew the arm), then reduce per the metric's declared `aggregation`
  (`median` default, plus `mean`, `min`, `max`, `p90`, `count`). Spread is reported
  as median + IQR (or min..max) so the comparison shows variance, not just a point.
  Output: `ArmAggregate[]` (one per arm × metric) with `{ armId, metricId, value,
  spread, n, droppedN }`.
- **Direction-aware comparison** — using the metric's `direction` (`max`/`min`),
  the lib marks the winning arm per metric and computes a delta vs a chosen
  baseline arm. The framework decides the winner deterministically; the LLM never
  does.
- **Autoresearch series** — in `series.ts`, the **best-objective-vs-iteration**
  curve is computed deterministically from the ledger/runs: walk iterations in
  order, keep the running best of `objective.metricId` **among verified runs only**
  (correctness gate), and emit `{ iteration, candidate, objective, accepted,
  bestSoFar }[]`. This is the single source for both the accept/reject decision the
  loop reads and the curve the dashboard renders — so the chart can never disagree
  with what the loop actually did.
- **Stop-condition evaluation** — `series.ts` also exposes pure predicates
  (`isPlateau(series, K)`, `hitTarget(series, target)`, budget checks) used both by
  the orchestration loop to *decide* and by reporting to *annotate* the curve
  ("stopped: plateau over K=5"). Same function, both consumers — they cannot drift.

All of these are pure functions over plain arrays. That makes them trivially
unit-testable on synthetic series, which is what the pinning tests exercise (§9).

---

## 6. Widget rendering reuse (spec-driven registry)

Rendering lives in `src/shared/experiment-report/widgets/`. The renderer is
**spec-driven**: a `DashboardSpec` is a list of widget specs, each naming a
registered widget type plus its metric bindings. Adding a chart type is a
**registration, not a refactor**.

### 6.1 Widget contract

```ts
interface WidgetSpec {
  id: string;
  type: string;                 // registered renderer id, e.g. "comparison-table"
  title?: string;
  bind: {                       // declarative binding to the ReportModel
    metricIds?: string[];
    armIds?: string[];
    objective?: boolean;        // autoresearch curve widgets
  };
  options?: Record<string, unknown>;
}

interface WidgetRenderer {
  type: string;
  // Pure: model slice + spec → HTML string (theme-token CSS only; see §6.3).
  render(ctx: { model: ReportModel; spec: WidgetSpec }): string;
}

// The registry — built-ins registered at module load; packs add more.
registerWidget(renderer: WidgetRenderer): void;
getWidget(type: string): WidgetRenderer | undefined;
```

### 6.2 Built-in core set (the seams, not a catalog)

Per the goal's "ship a useful core set; the point is the seams":

- `comparison-table` — arms × metrics grid with winner highlight + deltas (A/B).
- `score-bars` — per-metric horizontal bars across arms (A/B).
- `objective-curve` — best-objective-vs-iteration line with accept markers and the
  annotated stop point (autoresearch).
- `ledger-table` — iteration / candidate / objective / accepted (autoresearch).
- `summary-cards` — headline numbers (best arm, total runs, projected vs actual
  cost) for either mode.
- `raw-drilldown` — optional table of a run's underlying `raw` outcome refs.

A pack (or a quant team) contributes a custom visualization by shipping a module
that calls `registerWidget(...)`; the spec references it by `type`. The renderer
resolves the type through the registry, so a newly-registered type is used with no
change to the report engine — this is the **extensibility proof** the goal
requires.

### 6.3 Rendering rules (theme + safety)

- Widget HTML uses **only Bobbit theme tokens** (`var(--background)`,
  `var(--foreground)`, `var(--card)`, `var(--muted-foreground)`, `var(--border)`,
  `var(--chart-1..6)` for categorical arms/series, `--positive`/`--negative` for
  win/lose deltas). No hardcoded colours, no `:root` palette, no
  `prefers-color-scheme` (matches the HTML-rendering house rules so the panel
  iframe and the standalone report both theme correctly).
- All text/values are escaped; widgets emit a string, never touch the DOM
  directly, and never read the network. Purity is what lets the *same* renderer run
  server-side (report route HTML) and client-side (panel).

---

## 7. Report route output & panel dashboard output

Both surfaces render the **same `ReportModel`** through the **same widget
registry**. The only difference is delivery.

### 7.1 Report route (`routes: report`)

`market-packs/experiment-runner/lib/routes.mjs` adds a `report` route (confined
worker, pack-scoped store):

```js
report: async (ctx, req) => {
  const experimentId = req.query?.experimentId;
  const def       = await ctx.host.store.get(`exp/${experimentId}`);
  const runIds    = await ctx.host.store.list(`exp/${experimentId}/run/`);
  const runs      = await Promise.all(runIds.map(k => ctx.host.store.get(k)));
  const ledger    = await ctx.host.store.get(`exp/${experimentId}/ledger`);
  const dashboard = await ctx.host.store.get(`exp/${experimentId}/dashboard`);
  const model = buildReportModel({ def, runs, ledger, dashboard });   // shared lib
  return { model, html: renderReportHtml(model) };                    // shared lib
}
```

- `renderReportHtml(model)` (shared lib) assembles the full self-contained HTML
  document: it iterates the resolved `DashboardSpec`, renders each `WidgetSpec`
  through the registry, and wraps them in a theme-token shell. This is the artefact
  a user can open standalone or that a future CLI emits to a file.
- The route is the **read-only** projection of the registry; it computes the model
  from stored raw outcomes on every call, so editing the dashboard spec or adding
  runs re-renders with **no re-run** (the goal's "re-render from stored raw
  outcomes — no re-run, no redeploy").

### 7.2 Panel dashboard (`panels/experiment-dashboard.yaml`)

The panel (`lib/panel.js`) calls `host.callRoute("report", { experimentId })`,
receives `{ model }`, and renders it client-side **through the same widget
registry** (the bundled `experiment-report.mjs`). Rendering the `model` (not the
server `html`) on the client lets the panel stay interactive (widget hover, edit
mode) while still using the identical render functions.

Dashboard editing: the panel's edit mode mutates the `DashboardSpec` and persists
it via `host.callRoute("saveDashboard", { experimentId, dashboard })` →
`host.store.put(exp/<id>/dashboard, …)`. The next `report` call (or live re-render)
picks it up. Because the spec is data and the renderer is registry-driven, editing
which metric a widget binds to, or swapping a widget type, re-renders from the
already-stored outcomes — exactly the declarative, no-code extensibility the goal
demands.

### 7.3 Default dashboard resolution

`resolveDashboard(def, stored)` (shared lib) is the single rule:
`def.dashboard ?? stored ?? defaultDashboardFor(def.mode)`. `defaultDashboardFor`
returns a sensible core layout per mode (A/B → summary-cards + comparison-table +
score-bars; autoresearch → summary-cards + objective-curve + ledger-table). One
function, used by route and panel, so both agree on what "no custom dashboard"
shows.

---

## 8. Consolidation path for `graphify-ab`

`graphify-ab` / `ab-report.mjs` is **absent in this branch** (§2). The design keeps
a clean consolidation seam so it can never become a fork:

1. **Lib is authored as the engine, not a port.** `aggregate.ts` / `series.ts` /
   `widgets/` are written fresh as the canonical implementation. There is no
   forked copy to keep in sync because the engine *is* the lib.
2. **If `graphify-ab` lands later** (e.g. the skill is migrated into the repo), it
   is consolidated, not duplicated, following the PR-walkthrough §8.4 precedent:
   - Move any genuinely novel extraction/aggregation logic *into*
     `src/shared/experiment-report/` (extending, not re-implementing).
   - Rewrite `ab-report.mjs` as a **thin wrapper**: parse its CLI/skill inputs into
     `{ def, runs }`, call `buildReportModel` + `renderReportHtml`, write the
     output. No statistics, no chart HTML in the wrapper.
   - Or **retire** the skill entirely if the route/panel already cover its use,
     leaving only the lib.
3. **A pinning test guards the seam** (§9): if a consolidated `ab-report` (or any
   sibling report producer) reimplements aggregation/rendering instead of calling
   the lib, the test fails. This makes "never fork the report logic" an enforced
   invariant rather than prose.

**Explicit note for implementers:** do not block on `graphify-ab`. Build the lib +
route + panel now. Add the wrapper/retirement step only if and when the skill
actually appears in-repo; the consolidation test (§9.4) is added now and simply has
nothing extra to assert until a second report producer exists.

---

## 9. Pinning tests (prevent report logic forking)

These tests are the enforcement mechanism — the invariant is the test, not this
prose. All are pure-`node:test` unit tests over the shared lib (no server needed),
plus one structural guard.

### 9.1 Aggregation correctness (`experiment-report-aggregate.test.ts`)
- Synthetic `RunRecord[]` with known values → assert median, IQR/spread, `n`,
  `droppedN` after same-completion-bar filtering, and direction-aware winner/delta.
- Edge cases: all-null metric (→ `null`, not 0), single repeat, mixed completion
  bars, ties.

### 9.2 Series / accept-stop rules (`experiment-report-series.test.ts`)
- Synthetic objective series → assert the best-so-far curve keeps only **verified**
  improving candidates (a higher-objective but `verified:false` run is rejected and
  the curve does not rise — the correctness gate).
- `isPlateau` / `hitTarget` / budget predicates on crafted series → assert exact
  stop iteration. Because the loop and the chart share these functions, this test
  pins both behaviours at once.

### 9.3 Spec-driven rendering + extensibility (`experiment-report-widgets.test.ts`)
- Render each built-in widget from a `WidgetSpec` over a fixed `ReportModel`;
  assert the output contains the bound metric values and **uses theme tokens
  only** (regex: no `#rrggbb`, no `rgb(`, no `:root`).
- **Custom metric**: feed a `RunRecord.metrics` entry for a metric id not in the
  built-in set, bind a widget to it → assert it renders (proves the lib is
  metric-agnostic).
- **Custom widget**: `registerWidget` a new `type`, reference it in a
  `DashboardSpec`, render → assert the newly-registered renderer's output appears
  (proves "registration, not refactor").

### 9.4 No-fork / single-source guard (`experiment-report-single-source.test.ts`)
- **Bundle parity**: assert the committed `market-packs/experiment-runner/lib/
  experiment-report.mjs` is regenerable from `src/shared/experiment-report/` (same
  approach the PR-walkthrough bundle uses) so the pack copy can't silently diverge.
- **Structural fork guard**: `rg` across `market-packs/experiment-runner/` and any
  `*ab-report*` / report-producing skill script for tell-tale local
  reimplementations (a local `median(`/`percentile(` definition, or inline chart
  HTML assembly) **outside** the shared lib. Any hit fails the test with a message
  pointing back to this section. When `graphify-ab` is consolidated, this is what
  forces it to be a wrapper.

### 9.5 Route/panel parity (E2E, in the orchestration stream's suites)
- The API E2E that runs a 2×2 A/B (goal spec Testing item (a)) asserts the
  `report` route returns a model whose comparison matches the lib's direct output
  for the same registry — i.e. the route adds no second computation path.
- The browser E2E (goal spec Testing) asserts editing the dashboard spec
  re-renders from stored outcomes and persists across reload — proving the panel
  renders through the shared registry, not a bespoke client computation.

---

## 10. File layout (proposed)

```
src/shared/experiment-report/
  index.ts            # buildReportModel, renderReportHtml, resolveDashboard
  types.ts            # ExperimentDef, RunRecord, ReportModel, DashboardSpec, WidgetSpec, …
  aggregate.ts        # median/spread/filtering, ArmAggregate, direction-aware compare
  series.ts           # best-so-far curve, isPlateau/hitTarget/budget predicates
  widgets/
    registry.ts       # registerWidget / getWidget
    builtins.ts       # comparison-table, score-bars, objective-curve, ledger-table,
                      #   summary-cards, raw-drilldown
    theme.ts          # theme-token helpers (shared by all widgets)

market-packs/experiment-runner/
  lib/experiment-report.mjs   # build:packs bundle of src/shared/experiment-report (committed)
  lib/routes.mjs              # adds: report, saveDashboard (+ orchestration routes elsewhere)
  panels/experiment-dashboard.yaml → ../lib/panel.js

tests/
  experiment-report-aggregate.test.ts
  experiment-report-series.test.ts
  experiment-report-widgets.test.ts
  experiment-report-single-source.test.ts
```

`build:packs` gains one entry: bundle `src/shared/experiment-report/index.ts` →
`market-packs/experiment-runner/lib/experiment-report.mjs` (self-contained,
committed, no `node:` deps in the pure parts), exactly as it bundles
`yaml-to-cards.mjs` today.

---

## 11. Contracts this sub-stream owns (stable extension points)

Documented here as stable so other streams and external packs can depend on them:

- **`ReportModel`** — the pure projection of registry + raw outcomes; the one type
  both route and panel render.
- **`WidgetRenderer` / `registerWidget`** — the widget-renderer registry; the
  documented seam for code-contributed visualizations.
- **`DashboardSpec` / `WidgetSpec`** — the declarative, editable view-spec; the
  documented seam for no-code metric/chart changes.
- **`buildReportModel` / `renderReportHtml` / `resolveDashboard`** — the only
  sanctioned entry points; every report surface goes through these.

Metric extraction (the `MetricExtractor` contract and registry) is owned by the
extractor sub-stream; reporting consumes its output (`RunRecord.metrics` +
`MetricSelection`) and must not execute extractors itself.
