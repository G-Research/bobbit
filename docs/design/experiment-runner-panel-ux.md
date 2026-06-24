# Experiment Runner — panel UX design

**Status:** design — implementation-ready (UX spec for the pack's panel surfaces)
**Scope:** the *front-door* UX of the experiment-runner market pack — the two entry modes
(A/B comparison, the safe default; Autoresearch, explicit opt-in), the experiment-definition
forms, validation, cost projection + confirmation, caps/stop-rule gating, the launch flow, the
results dashboard, the editable metrics + dashboard spec, persistence/reload behaviour, and the
browser-E2E scenarios that pin all of it.

**Builds on (given by the goal spec, not re-designed here):**
- PR #822 goal-metadata layer — `PersistedGoal.metadata`, `resolveGoalMetadata` /
  `goalManager.getEffectiveGoalMetadata` (deep-merge ancestors→self), the `goalProvisioned`
  lifecycle hook, and `goalManager.createGoal({ spec, metadata, inlineRoles, parentGoalId,
  workflowId, … })`.
- The one new core/host capability this goal adds — **`host.agents.spawnGoal({ title, spec,
  runKey, parentGoalId?, metadata, inlineRoles, workflowId?, workflow? }) → { goalId }`**
  (`runKey` is the required idempotency key; `parentGoalId` is an optional caller assertion only
  — the server derives the real parent and rejects a mismatch). The panel UX treats it as a
  black box: "launch one arm/candidate as a child goal of the experiment goal, carrying its arm
  treatment". *Designing that capability is a different task; this doc only consumes it through a
  pack route — the panel never calls `spawnGoal` directly.*

**Pack-surface foundation (verified against the codebase):**
- Pack schema V1 — [`docs/extension-host-authoring.md`](../extension-host-authoring.md),
  [`docs/design/pack-schema-v1-rationalisation.md`](pack-schema-v1-rationalisation.md).
- Reference packs: `market-packs/artifacts/` (renderer + panel + deep-link), and especially
  `market-packs/pr-walkthrough/` (spawn-launcher → child session → panel, routes, store,
  `host.agents`). This design reuses the pr-walkthrough mechanics almost verbatim.
- Host contract level **v3** (`PanelTarget.instanceKey` for durable parameterized side-panel
  tabs); `host.ui.openPanel` / `host.ui.navigate`; `host.callRoute`; `host.store.*`;
  `host.agents.*`.

---

## 1. Design goals & the UX contract

The goal spec gives the product decisions as **requirements, not options**. This doc designs the
*how*. The non-negotiable UX invariants:

1. **Two front doors, never a buried toggle.** A/B and Autoresearch are two distinct, clearly
   labelled mode cards on the panel's first screen. A/B is pre-selected. Autoresearch is a
   deliberate second click with its own danger styling and its own required fields.
2. **A/B is safe + bounded.** Run-count and projected cost are computed and shown *before*
   launch. There is no feedback loop and no self-modification — the form simply fans out a fixed
   matrix.
3. **Autoresearch refuses to start uncapped.** The Launch button is disabled until at least one
   hard cap (max-iterations / wall-clock / cost) **and** at least one stop condition
   (plateau-over-K / target) are set, and the user has ticked an explicit "I understand this runs
   autonomously and may cost up to $X" confirmation. The correctness gate (a candidate failing
   verification is rejected even if the objective improved) is stated in the confirm dialog so the
   user knows discards are expected.
4. **The dashboard is first-class and spec-driven.** What is measured (`metrics`) and how it is
   shown (`dashboard` view-spec) are editable *without re-running and without code*. The dashboard
   re-renders from stored raw outcomes.
5. **Everything survives reload.** Definition drafts, in-flight run state, and dashboard specs all
   persist in the pack store and rehydrate on a cold load / deep-link.

Design-language alignment with Bobbit: theme tokens only (`var(--background)`,
`var(--foreground)`, `var(--card)`, `var(--muted-foreground)`, `var(--border)`, `var(--primary)`;
the categorical `--chart-1..6` palette for variant/candidate series; `--positive` / `--negative`
/ `--warning` for accept/reject/cap signals). No hardcoded colours, no `:root` palette, no
`prefers-color-scheme`. Match the pr-walkthrough panel's header / rail / card grammar so the two
first-party panels feel like one product.

---

## 2. Information architecture — one panel, four views

The pack ships **one** side panel (`experiment-runner.panel`) that is a small state machine over
four views. Keeping it one panel (rather than four) means one tab, one deep-link route, one store
namespace, and a single instance per experiment — mirroring how the pr-walkthrough panel is one
surface with internal phases.

```
                       ┌──────────────────────────────────────────────┐
                       │  experiment-runner.panel  (instanceKey =      │
                       │  experimentId; default = "new")               │
                       └──────────────────────────────────────────────┘
   ┌───────────────┐    ┌────────────────────┐    ┌───────────────┐    ┌──────────────────┐
   │ 1. MODE       │ →  │ 2. DEFINE          │ →  │ 3. CONFIRM    │ →  │ 4. DASHBOARD     │
   │   SELECT      │    │   (A/B | Auto form)│    │   (cost gate) │    │   (live + post)  │
   └───────────────┘    └────────────────────┘    └───────────────┘    └──────────────────┘
        ↑ pick A/B (default) or Autoresearch         ↑ launch          ↑ re-open / deep-link
                                                                          lands here when an
                                                                          experiment exists
```

**View 1 — Mode select.** Two large cards (A/B left, Autoresearch right). A/B card has a subtle
"Recommended · bounded cost" eyebrow and is keyboard-focused by default. The Autoresearch card
carries a `--warning`-toned "Autonomous · opt-in · hard caps required" eyebrow. Selecting a card
advances to View 2 with that mode's form. The user can also land here by clicking "New
experiment" from the dashboard view.

**View 2 — Define.** The mode-specific form (§4 for A/B, §5 for Autoresearch). Both share the
top "Experiment basics" block, the **Metrics** editor (§6), and a live **projection strip** in a
sticky footer.

**View 3 — Confirm.** A modal-style confirmation rendered inline over View 2 (not a separate tab)
showing the resolved fan-out / loop plan and the bounded cost projection. A/B's confirm is a
single "Launch N runs (~$X)" button. Autoresearch's confirm additionally forces the danger
checkbox and the caps summary.

**View 4 — Dashboard.** The results surface — header (experiment name, mode badge, status, total
spend so far), the variant/candidate comparison (A/B) or the best-objective-vs-iteration curve
(Autoresearch), the per-run/iteration table, and the **Edit dashboard** affordance (§7).

A single internal `view` field on the panel entry (`mode-select | define | confirm | dashboard`)
plus the `experimentId` (instance key) drives which view renders. Live experiments always default
to `dashboard`; a fresh launch from a launcher opens `mode-select`.

---

## 3. Launch model — reuse the pr-walkthrough spawn-launcher mechanics

The experiment-runner is **not** a per-PR isolated-reviewer surface, but its launch + persistence
plumbing maps cleanly onto the proven pr-walkthrough pattern:

| pr-walkthrough mechanic | experiment-runner adaptation |
|---|---|
| Spawn launcher `{action:"spawn", route, panelId}` opens a child reviewer session | **No.** Experiment launchers are **panel launchers** — clicking opens the experiment panel **in the current session** at View 1. The child-goal spawning happens later, server-side, when the user hits Launch (the `launch` route calls `host.agents.spawnGoal` per arm). The experiment panel is the *owner-session control surface*, unlike the pr-walkthrough panel which lives only in the child. |
| `host.callRoute("bundle"/"publish"/"status")` for all dynamic data | `host.callRoute("projectCost"/"launch"/"poll"/"report"/"saveDashboard")` — the pack's own routes (§9). Never a raw fetch. |
| Pack store holds `binding/<child>` + `submitted/<jobId>` | Pack store holds the **results registry**: `exp/<id>` (definition), `exp/<id>/run/<runId>` (`RunRecord` — per-run config + raw outcome + extracted metrics), `exp/<id>/ledger` (autoresearch ledger), `exp/<id>/dashboard`, `exp/<id>/metrics`. §8. |
| `kind:"route"` deep-link `routeId:"pr-walkthrough"` restores the child pane on reload | `kind:"route"` deep-link `routeId:"experiment-runner"`, `paramKeys:[experimentId, view]` restores the dashboard (or define draft) on reload. |
| Child pane auto-polls its own job (read-only carve-out) | The **owner** experiment panel polls `poll` for live status. This is **not** the auto-invoke carve-out (that is child-session-only) — the owner panel polls only **after a user gesture** (Launch, or opening a still-running experiment whose `status==="running"` the user themselves started). Polling a known-running experiment the user navigated to is a read; it never spawns. |

Why launch goes through a server route, not a launcher `action:"spawn"`: the spawn launcher
opens **one** child session and switches to it. An A/B experiment fans out `variant × repeat`
**child goals** (not sessions to switch to) and the user must stay on the dashboard to watch the
matrix. So the launcher just opens the panel; the `launch` route does the fan-out via
`host.agents.spawnGoal` (one call per arm, each with its own `runKey`) and returns
`{ experimentId, spawned: [...goalIds] }`; the panel flips to the dashboard and begins polling.

---

## 4. A/B mode — the default form (View 2)

### 4.1 Fields

**Experiment basics** (shared block):

| Field | Control | Validation |
|---|---|---|
| Experiment name | text input | required, 1–80 chars, trimmed; used as the child-goal title prefix |
| Runnable unit | radio: `Goal spec` · `Command` | required. "Command" = the generic non-Bobbit unit (a shell command emitting a metric); "Goal spec" = a Bobbit goal spec template |
| Spec / command body | textarea (monospace) | required, non-empty. For `Command`, a hint shows the metric-emission contract (stdout JSON line / a named file the extractor reads) |
| Workflow (optional) | select from `/api/workflows` | optional; defaults to none |

**Variants** (the A/B-specific block) — a repeatable list, minimum 2:

Each variant row carries:
- **Variant label** (text, required, unique within the experiment) — e.g. `baseline`, `hi-temp`.
- **Metadata treatment** (key/value editor) — the per-arm `metadata` deep-merged onto the
  experiment goal's metadata. Rendered as an add-row table (`key` → `value`), values typed as
  string/number/bool/json. This is the arm's distinguishing treatment.
- **Inline roles** (collapsible advanced) — optional `inlineRoles` JSON for the arm (e.g. a
  different model/thinkingLevel per role). Hidden behind an "Advanced: per-arm roles" disclosure
  so the common case (metadata-only) stays simple.

A "Duplicate variant" affordance clones a row's metadata so the user tweaks one key. A "Remove"
control on each row; removing below 2 is blocked (the remove buttons disable at 2 variants with a
tooltip "A/B needs at least two variants").

**Repeats**:
- **Repeats per variant** (number stepper, default 3) — `N` runs per variant for
  median + spread. Range 1–20; values >10 surface a `--warning` "high run count" hint.
- **Same-completion-bar filtering** (checkbox, default on) — "Only aggregate runs that reached
  the same completion bar (passed verification / same gate)". Explained in a tooltip; this is the
  fairness guard the goal spec calls out.
- **Concurrency cap** (number, default = project default, max 8) — how many child goals run at
  once. Bounds wall-clock and load.

### 4.2 Live projection strip (sticky footer)

As fields change, a footer strip computes and shows:

```
2 variants × 3 repeats = 6 runs   ·   est. ≤ $4.80   ·   ~3 concurrent   ·   [ Review & launch → ]
```

- **Run count** = `variants.length × repeats`. Updates live.
- **Cost estimate** = `runCount × perRunBudget`, where `perRunBudget` is the *fixed comparable
  budget per run* (a required field in an "Advanced: budget" disclosure, default a project-level
  value). Shown as `≤ $X` because the budget is a cap, not a point estimate. If `perRunBudget` is
  unset, the strip shows `est. — set a per-run budget` and the launch button is disabled.
- The `Review & launch →` button advances to View 3 (Confirm). Disabled while any validation
  error is present; an inline error summary lists what's missing.

### 4.3 Validation rules (A/B)

- Name required; ≥2 variants; each variant label non-empty + unique.
- Each variant must differ from every other in *at least one* metadata key or inline-role value —
  identical arms are a hard error ("Variant `hi-temp` is identical to `baseline`"). This protects
  against an accidentally-meaningless A/B.
- Repeats ≥1; per-run budget > 0; concurrency 1–8.
- At least one metric selected (§6) with a defined direction if any metric is the comparison
  primary.

---

## 5. Autoresearch mode — the opt-in form (View 2)

Selected only from the Autoresearch mode card. The whole form carries a subtle `--warning`-toned
top banner: **"Autonomous optimization — runs unattended until a cap or stop condition is hit."**

### 5.1 Fields

**Experiment basics** — same shared block as A/B (name, runnable unit, spec/command, workflow).

**Objective** (the optimization target):

| Field | Control | Validation |
|---|---|---|
| Objective metric | select from the metric registry (§6) | required |
| Direction | radio: `maximize` · `minimize` | required |
| Correctness gate | read-only note + (optional) workflow gate select | states "candidates failing verification are rejected even if the objective improves"; if a workflow is chosen its `review-findings`/verification gate is the correctness bar |

**Search seed** — the starting candidate:
- **Seed metadata** (key/value editor, same control as a variant's treatment) — the iteration-0
  candidate. The loop proposes mutations of this.
- **Seed inline roles** (advanced disclosure) — optional.

**Caps (hard limits — at least one required):**

| Cap | Control | Note |
|---|---|---|
| Max iterations | number, optional | e.g. 20 |
| Wall-clock cap | duration (hh:mm), optional | e.g. 8h overnight |
| Cost cap | currency, optional | e.g. $50 |
| Per-iteration budget | currency, **required** | the fixed comparable budget every candidate gets |

**Stop conditions (at least one required):**

| Stop | Control | Note |
|---|---|---|
| Plateau over K | number K, optional | stop when best objective hasn't improved for K consecutive iterations |
| Target value | number, optional | stop when objective reaches/exceeds (or ≤ for minimize) this value |

**Search strategy** (advanced disclosure): `greedy` (default) · `best-of-batch` with a batch-size
field bounded by the concurrency cap. v1 is intentionally simple (no Bayesian/evolutionary).

### 5.2 Validation + gating (Autoresearch)

The Launch path is **hard-gated**. `Review & launch →` stays disabled until ALL of:
1. Name, runnable unit, spec/command present.
2. Objective metric + direction selected.
3. Per-iteration budget > 0.
4. **≥1 cap** set (max-iter OR wall-clock OR cost).
5. **≥1 stop condition** set (plateau-K OR target).

Each missing requirement renders as a checklist in the footer (`✗ Set at least one hard cap`,
`✗ Set at least one stop condition`) so the user sees exactly why launch is blocked. This is the
"refuses to start uncapped" requirement made visible, not just enforced.

### 5.3 Live projection strip (Autoresearch)

Because the loop is open-ended, the strip shows the **worst-case bounded** cost from the caps:

```
≤ 20 iterations · ≤ $50 · ≤ 8h · per-iter ≤ $2.50 · stop: plateau(3) or target≥0.95 · [ Review & launch → ]
```

The worst-case cost = `min(maxIterations × perIterBudget, costCap)` — whichever cap binds first.
If only a wall-clock cap is set (no iteration/cost cap) the strip shows `≤ 8h (cost unbounded by
iterations)` in `--warning` and still requires the danger confirm to state an *estimated* spend
range.

---

## 6. Metrics editor — declarative, no-code (shared, both modes)

Per the goal's extensibility requirement, *what* is measured is editable per-experiment without
code. The Metrics block is a table bound to the **metric-extractor registry** exposed by the
`listMetrics` route (`host.callRoute("listMetrics")` → `{ builtins: [...], custom: [...] }`);
edits are persisted via the `saveMetrics` route.

Each selectable metric row:

| Column | Control |
|---|---|
| ✓ Collect | checkbox — include this metric in the registry for every run |
| Metric | name + source badge (`built-in` / `custom` / `user-channel`) |
| Aggregation | select: `median` (default) · `mean` · `p90` · `min` · `max` · `count` |
| Direction | select: `higher-better` · `lower-better` · `neutral` (drives colour + sort) |
| Primary | radio (A/B: the comparison key; Autoresearch: pre-fills the objective) |

Built-in core set (ships with the pack — small on purpose; the point is the seam; the
**canonical metric ids** are owned by [experiment-runner-pack-backend.md](experiment-runner-pack-backend.md)
§7.1): `cost.totalUsd`, `cost.tokensTotal`, `cost.cacheHitRate`, `gates.passRate`,
`gates.firstPassClean`, `tasks.completionRate`, `time.wallClockMs`, `objective.value`,
`command.metric`. (Earlier-draft ids `cost.usd`, `wall.seconds`, `tokens.total`,
`verification.passed`, `tasks.completed`, `gate.<id>.passed` are **rejected aliases**,
not used by v1.) The **pluggable user-metric channel** lets a runnable unit
emit `{ "metric": "<name>", "value": <n> }` on stdout (or a declared file); those names appear in
the table flagged `user-channel` once a first run reports them, so an agent/user can collect a
novel metric with no code.

A code-contributed extractor registers through the documented **metric-extractor contract**
(`registerMetric(...)` in `lib/metrics.mjs`) and then appears in this table flagged `custom` —
proving "code-contributed extractor registers through the documented contract" without a UI
change.

Editing the metrics of an **already-run** experiment is allowed (via `saveMetrics`) and re-renders
the dashboard from stored raw outcomes (no re-run) — the metric values are re-extracted from each
`RunRecord`'s persisted `rawOutcome`.

---

## 7. Dashboard (View 4) — spec-driven, editable

### 7.1 Layout

**Header** — experiment name, a mode badge (`A/B` neutral · `AUTORESEARCH` `--warning`-toned),
live status (`running 4/6` · `complete` · `stopped: plateau` · `stopped: cost cap`), total spend
so far vs. the cap, and a kebab menu (Edit definition · Duplicate · Export report · Delete).

**Body — A/B:**
- A **comparison widget**: grouped bars per variant for the primary metric, median with a
  spread whisker (IQR), variant series coloured `--chart-1..6`. The winning variant by
  direction gets a `--positive` ✓ chip; ties show "no significant difference".
- A **secondary-metrics** row of `score-bars` (one mini-bar per collected metric).
- A **runs table**: variant · repeat · status · each metric · cost · link to the child goal.
  Runs filtered out by the same-completion-bar guard are shown greyed with a "excluded:
  didn't reach completion bar" tag (transparency over hiding).

**Body — Autoresearch:**
- A **best-objective-vs-iteration line chart** (`--chart-1` for the running best, `--chart-3`
  dots for each candidate's evaluated objective; rejected candidates shown hollow). A horizontal
  `--positive` target line if a target stop was set.
- A **ledger panel**: chronological iterations — proposed candidate (metadata diff vs. previous
  best), evaluated objective, verdict (`KEPT` `--positive` / `DISCARDED: worse` `--muted` /
  `DISCARDED: failed verification` `--negative`), running best. This is the fed-forward ledger.
- A **stop banner** when the loop ends, stating which condition fired.

**Empty / loading / error states** (design-for-the-edges):
- *Empty* (no experiments yet): the dashboard view isn't reachable; the panel lands on
  mode-select. From the dashboard kebab "New experiment" returns to mode-select.
- *Loading*: skeleton bars/lines with the header populated from the cached definition.
- *Running*: live-updating with a subtle pulse on the in-flight rows; a "Stop experiment" button
  (A/B: cancels pending child goals; Autoresearch: requests loop halt after the current
  iteration).
- *Error* (a run/child goal failed to spawn or verify): the row shows `--negative` with the
  error; the experiment continues (one bad arm doesn't sink the matrix).

### 7.2 Editable dashboard spec

The dashboard is rendered from a stored **view-spec** (`exp/<id>/dashboard`): an ordered list of
widget descriptors, each `{ type, title, metric(s), options }`, bound to collected metrics.
Widget types come from the **widget-renderer registry** (`host.callRoute("listWidgets")` →
built-in types + pack-contributed types; the registry lives only in the shared reporting
lib, [experiment-runner-reporting.md](experiment-runner-reporting.md) §6, and
`listWidgets` surfaces it). The **canonical built-in widget `type` ids** are
`comparison-table`, `score-bars`, `objective-curve`, `ledger-table`, `summary-cards`,
`raw-drilldown`. (Earlier-draft ids `bar-compare`, `line-progress`, `small-multiples`,
`runs-table`, `ledger`, `stat` are **rejected/legacy aliases**, not used by v1 defaults.)

"**Edit dashboard**" opens an inline editor over View 4:
- Re-order widgets (drag handles, keyboard-accessible move up/down).
- Add a widget (pick a type from the registry + bind it to one/more collected metrics).
- Remove a widget.
- Edit a widget title + options (e.g. bar vs. boxplot for a metric).

Saving calls `host.callRoute("saveDashboard", { experimentId, dashboard })`, persists to the
store, and re-renders **from the same stored raw outcomes** — no re-run, no redeploy. A
newly-registered
widget type (built-in OR pack-contributed) appears in the "Add widget" type list immediately
(proving "newly-registered widget type is used"). Because the renderer is spec-driven, adding a
metric or chart is a *registration, not a refactor*.

---

## 8. Persistence & reload behaviour

All durable state lives in the pack store (`host.store.*`, pack-namespaced) plus a thin
localStorage mirror for instant cold paint, mirroring the pr-walkthrough panel's
`writeLocalPersistedState` / `writeHostPersistedState` pair.

| Key | Holds | Written by |
|---|---|---|
| `exp/<id>` | definition (basics, variants/seed, caps/stops, mode) | `defineExperiment` route on save + launch |
| `exp/<id>/run/<runId>` | `RunRecord` — per-run config (arm metadata + inlineRoles) + raw outcome + extracted metrics | `launch`/`poll`/`collect` route as child goals complete |
| `exp/<id>/ledger` | autoresearch ledger (best-so-far is recomputed from runs + ledger, not stored separately) | `iterate` route after each accept/reject |
| `exp/<id>/dashboard` | editable dashboard view-spec | `saveDashboard` route |
| `exp/<id>/metrics` | editable metric selection | `saveMetrics` route |
| `drafts/<instanceKey>` | unsaved define-form draft (so an in-progress definition survives reload before first launch) | panel on every field edit (debounced), localStorage + store |
| `index/experiments` | experiment index (ids + name + mode + status) | `launch` / `defineExperiment` |

**Reload / deep-link behaviour:**
- The `kind:"route"` deep-link `#/ext/experiment-runner?experimentId=<id>&view=dashboard`
  re-opens the panel, `host.store.get("exp/<id>")` rehydrates the definition, and the dashboard
  re-renders from `exp/<id>/run/*`. A running experiment resumes polling on rehydrate.
- An unsaved draft (no `experimentId` yet) rehydrates from `drafts/<instanceKey>` so a reload
  mid-definition loses nothing.
- The panel is **parameterized** on `experimentId` (`instanceMode: parameterized`,
  `instanceParam: experimentId`) so two experiments can be open in two side-panel tabs at once,
  each with durable tab identity (contract-v3 `instanceKey`).

---

## 9. Exact pack files

```
experiment-runner/
  pack.yaml
  panels/
    experiment-runner-panel.yaml
  entrypoints/
    experiment-runner-open.yaml          # composer-slash launcher → opens panel (mode-select)
    experiment-runner-palette.yaml       # command-palette launcher → opens panel
    experiment-runner-route.yaml         # kind:"route", routeId:"experiment-runner" (deep-link/reload)
  lib/
    panel.js                             # BUILT panel bundle (from src/panel.js)
    routes.mjs                           # pack routes (the canonical 15 — see 9.1 / 9.4)
    engine.mjs                           # mode-agnostic run-config mapping, fan-out, outcome collection (REST goal-id reads)
    store-keys.mjs                       # registry key schema (pure; SINGLE source of store keys)
    aggregate.mjs                        # median/spread + same-completion-bar filtering (node-safe, unit-tested)
    autoresearch.mjs                     # deterministic accept/reject + plateau/budget/target stop (node-safe)
    metrics.mjs                          # metric-extractor contract + registry + built-ins + user-channel
    widgets.mjs                          # widget-renderer contract + registry (spec-driven)
    experiment-report.mjs                # SHARED reporting lib (build:packs bundle of src/shared/experiment-report/)
  src/
    panel.js                             # SOURCE (esbuild → lib/panel.js); never bare-imports lit
    forms/                               # mode-select, ab-form, autoresearch-form, metrics-editor, confirm
    dashboard/                           # dashboard view + dashboard-spec editor
```

> There is **no** `optimizer.mjs` (the deterministic loop lives in `autoresearch.mjs`), no
> `outcome.mjs` and no ambient fs parsing (outcome reads are REST/goal-id-keyed helpers inside
> `engine.mjs`/`routes.mjs`), and no `report-lib.mjs`/`lib/report.mjs` (the shared reporting lib
> is the build:packs bundle `experiment-report.mjs`, sourced from `src/shared/experiment-report/`).
> The widget/metric registries are single `widgets.mjs` / `metrics.mjs` files, not directories.

### 9.1 `pack.yaml`

```yaml
name: experiment-runner
description: >-
  Data-driven experimentation + autonomous optimization. A/B comparison (safe,
  bounded, default) and opt-in guard-railed Autoresearch, over goal metadata +
  inlineRoles, with an editable metrics + dashboard spec.
version: 1.0.0
contents:
  roles: []          # arms get inlineRoles per the definition; no shipped role needed
  tools: []          # UI-only pack — no agent tools
  skills: []
  entrypoints:
    - experiment-runner-open
    - experiment-runner-palette
    - experiment-runner-route
routes:
  module: lib/routes.mjs
  names: [defineExperiment, projectCost, launch, poll, collect, aggregate,
          iterate, listExperiments, getExperiment, saveMetrics, saveDashboard,
          report, listMetrics, listWidgets, cancel]
```

### 9.2 `panels/experiment-runner-panel.yaml`

```yaml
id: experiment-runner.panel
title: Experiments
entry: ../lib/panel.js
instanceMode: parameterized
instanceParam: experimentId      # default instanceKey "new" for an unsaved draft
```

### 9.3 Entrypoints

```yaml
# entrypoints/experiment-runner-open.yaml — composer-slash launcher (panel target, NOT spawn)
id: experiment-runner.open
kind: composer-slash
label: Experiments
target:
  panelId: experiment-runner.panel    # opens in the CURRENT session at mode-select
```

```yaml
# entrypoints/experiment-runner-palette.yaml — command-palette launcher
id: experiment-runner.palette
kind: command-palette
label: New experiment
target:
  panelId: experiment-runner.panel
```

```yaml
# entrypoints/experiment-runner-route.yaml — deep-link / reload restore
id: experiment-runner.route
kind: route
routeId: experiment-runner
target:
  panelId: experiment-runner.panel
paramKeys: [experimentId, view]
```

> Note: experiment launchers are **panel** launchers, not `action:"spawn"` launchers — the
> fan-out happens in the `launch` route (§3), not by switching to a single child session.

### 9.4 Routes (`lib/routes.mjs`) — the panel's data contract

This panel consumes a subset of the canonical 15 routes (full catalogue + contracts in
[experiment-runner-pack-backend.md](experiment-runner-pack-backend.md) §4):

| Route | Method | Request → Response | Used by |
|---|---|---|---|
| `projectCost` | POST | `{ experimentId }` or inline def → `CostProjection` | define form projection strip + confirm |
| `listMetrics` | GET | `{}` → `{ builtins, custom, userChannel }` | metrics editor |
| `listWidgets` | GET | `{}` → `{ types: [{id,label,bindsMetrics}] }` | dashboard-spec editor |
| `defineExperiment` | POST | `{ definition }` → `{ experimentId, projection }` | save definition + draft autosave |
| `saveMetrics` | POST | `{ experimentId, metrics }` → `{ ok }` | metrics edits (re-extract, no re-run) |
| `saveDashboard` | POST | `{ experimentId, dashboard }` → `{ ok }` | dashboard-spec edits (re-render, no re-run) |
| `launch` | POST | `{ experimentId }` → `{ experimentId, spawned: [goalId...] }` | View 3 confirm → fan-out via `spawnGoal` |
| `iterate` | POST | `{ experimentId }` → `{ iteration, decision?, stopped? }` | autoresearch loop step |
| `poll` | POST | `{ experimentId }` → `{ runs: RunRecord[], allSettled }` | dashboard live updates |
| `collect` | POST | `{ experimentId, runId? }` → `{ runs: RunRecord[] }` | finalize settled runs |
| `getExperiment` | GET | `{ experimentId }` → `{ def, state, runs, ledger }` | dashboard hydration |
| `report` | POST | `{ experimentId }` → `{ model, html }` (via `experiment-report.mjs`) | dashboard render + Export |
| `cancel` | POST | `{ experimentId }` → `{ cancelled }` | Stop experiment |

`launch` is where the **server-side** fan-out lives: for each `variant × repeat` (A/B), it
deep-merges the experiment goal's effective metadata with the arm's treatment and calls
`host.agents.spawnGoal({ title, spec, runKey, metadata, inlineRoles, workflowId, parentGoalId })`
(one per arm, `runKey` for idempotency; `parentGoalId` is an assertion only). For Autoresearch,
the loop (propose → spawn → eval → deterministic accept/reject → deterministic stop) is driven
across successive `iterate`/`poll` calls. The accept/reject + stop maths is the bundled shared
`series.ts` (called through the thin `lib/autoresearch.mjs` adapter — not a pack-local
implementation); routes run in a fresh worker per call, so all loop state is in the store — the
`RunRecord`s + `exp/<id>/ledger`, with best-so-far **recomputed** on read — never a module
singleton; this is the documented route-worker caveat.

The deterministic **accept/reject + stop** decisions and the **aggregation** (median/spread,
same-completion-bar filtering on the canonical `completionBar === 'passed'` enum) are the bundled
shared `src/shared/experiment-report/{series,aggregate}.ts` — the single source of truth
(`experiment-report.mjs`). The pack's `lib/autoresearch.mjs` and `lib/aggregate.mjs` are **thin
adapters** that call the shared functions and add store plumbing (no pack-local median/percentile
or accept-stop maths; the no-fork test pins this). The framework decides keep/stop; the LLM only
proposes. **Note:** `graphify-ab` / `ab-report.mjs` is **absent in this branch**; the shared lib
is authored fresh as the canonical engine, and any future `graphify-ab` must become a thin
wrapper over it.

---

## 10. UI state & data dependencies

Panel entry state (module-level `Map` keyed by `instanceKey === experimentId`, mirroring the
pr-walkthrough `byJob` pattern — survives panel re-creation within a page session):

```ts
interface ExperimentPanelEntry {
  view: "mode-select" | "define" | "confirm" | "dashboard";
  mode: "ab" | "autoresearch" | null;
  experimentId?: string;        // undefined until first defineExperiment/launch

  // ── definition draft (View 2) ──
  basics: { name; runnableUnit: "goal" | "command"; body; workflowId? };
  ab?: { variants: Variant[]; repeats; sameCompletionBar; concurrency };
  auto?: { objectiveMetric; direction; correctnessGateId?; seed: Treatment;
           caps: { maxIterations?; wallClockMs?; costUsd?; perIterBudget };
           stops: { plateauK?; target? }; strategy; batchSize? };
  metrics: MetricSelection[];   // collect/agg/direction/primary
  perRunBudget?: number;

  // ── derived (computed, not stored) ──
  projection: { runCount?; estCostMax?; valid; errors: string[] };

  // ── confirm (View 3) ──
  confirmAck?: boolean;         // autoresearch danger checkbox

  // ── dashboard (View 4) ──
  status?: "running" | "complete" | "stopped";
  runs?: RunRecord[]; best?; ledger?;   // best-so-far recomputed from runs + ledger
  dashboard?: WidgetSpec[];     // editable view-spec
  dashboardEditing?: boolean;
  polling?: boolean;            // set only after Launch or opening a known-running exp
}
```

**Host-API dependencies (all via the bound `host`, never raw fetch):**
- `host.callRoute(...)` — every route in §9.4.
- `host.store.get/put/list(...)` — the keys in §8 (best-effort, wrapped in try/catch like
  pr-walkthrough).
- `host.requestRender()` — repaint after any state patch (the `patchEntry` pattern).
- `host.ui.navigate({ route: "experiment-runner", params: { experimentId, view } })` — to write
  the deep-link hash on launch + view changes (never build a hash string).
- `host.contractVersion >= 3` feature-detect for `PanelTarget.instanceKey` (graceful fallback to
  host-derived identity from `experimentId`).
- No `host.invokeAction` (no tool), no `host.session.postMessage` (the panel never drives the
  user's agent — the `launch` route spawns child goals server-side).

**External data the routes read (server-side):** per child goal — cost, gates +
verification records, and tasks — via **REST endpoints keyed by the child `goalId`**
(`GET /api/goals/:id/cost|gates|tasks`), never by parsing sibling-goal `session-costs.json` /
`gates.json` / `tasks.json` through ambient fs paths. The reads land on each `RunRecord`
(`rawOutcome` + extracted `metrics`) that the store persists and the dashboard renders from. See
[experiment-runner-pack-backend.md](experiment-runner-pack-backend.md) §5.2 for the exact
mechanism.

**No new client UI state outside the pack.** The pack reconciles into the existing pack-panel /
pack-entrypoint registries (`reconcilePackPanelsForProject`,
`registerPackEntrypoints`) exactly like artifacts/pr-walkthrough — no core UI change beyond the
host `spawnGoal` capability the goal already scopes.

---

## 11. Consistency rationale (design checklist)

Verified against the existing first-party panel surfaces so this panel feels native:

1. **Primitives reused:** header grammar (pr-pill + title-stack + meta + progress + primary
   button), the labelled/collapsed **rail** for the dashboard widget list, `card` containers,
   `secondary`/`primary` button classes, the `data-testid` naming convention
   (`experiment-runner-*`), and the `patchEntry` + module-level `Map` state pattern — all lifted
   from `market-packs/pr-walkthrough/src/panel.js`.
2. **Form controls** match Bobbit's goal-form inputs (`input[placeholder=…]`, selects, number
   steppers) so validation + focus states are identical to the goal-creation/goal-edit modals.
3. **Mode cards** sit in one row (not invented stacked panels) and reuse the card hover/focus
   states; the Autoresearch danger styling uses the existing `--warning` token rather than a new
   colour.
4. **Affordances:** every disabled launch button carries a tooltip naming the missing requirement
   (parity with the goal-form "Add a project first" disabled-title pattern); the metrics + caps
   checklists are visible, not silent.
5. **New patterns introduced (justified):** the *spec-driven dashboard editor* is genuinely new —
   no existing surface edits a view-spec. It is justified by the extensibility requirement and is
   built from existing rail + card + drag primitives (the project-drag-reorder pattern) rather
   than a bespoke widget toolkit.
6. **Accessibility:** colour is never the only signal — accept/reject use ✓/✗ glyphs + text
   labels alongside `--positive`/`--negative`; the objective chart has an accessible table
   fallback (the runs/ledger table is the data); rail + steppers are keyboard-navigable; focus
   states visible; `role="progressbar"` on the live `running N/M`.

---

## 12. Browser E2E scenarios (the pinning tests)

Pattern: `tests/e2e/ui/experiment-runner-pack.spec.ts`, mirroring
`tests/e2e/ui/pr-walkthrough-pack.spec.ts` (built-in band, no install) and the reconcile specs.
All selectors are `data-testid`s.

**E2E-1 — Mode select defaults to A/B.**
Open the panel via the composer-slash launcher → View 1 renders two mode cards →
`experiment-runner-mode-ab` is focused/selected by default and labelled "Recommended" →
`experiment-runner-mode-autoresearch` carries the "opt-in" warning eyebrow. Clicking A/B advances
to the A/B form.

**E2E-2 — A/B happy path: define → projection → launch → dashboard.**
Fill name, runnable unit = Command, body, two variants with distinct metadata, repeats = 2 →
the projection strip shows `2 variants × 2 repeats = 4 runs` and a `≤ $…` estimate →
`Review & launch` enabled → confirm → the dashboard appears, `poll` is called, runs spawn (assert
the `launch` route was hit and the mocked `host.agents.spawnGoal` was called 4× with **distinct
per-arm metadata** and distinct `runKey`s), and the comparison widget renders with both variant
series.

**E2E-3 — A/B validation blocks bad definitions.**
With only one variant, `Review & launch` is disabled with a tooltip; adding an identical second
variant surfaces the "identical variant" error; making them distinct + setting a per-run budget
clears it. Zero per-run budget shows `est. — set a per-run budget` and keeps launch disabled.

**E2E-4 — Autoresearch refuses to start uncapped.**
Switch to Autoresearch → the danger banner shows → fill basics + objective + per-iter budget but
NO cap → footer checklist shows `✗ Set at least one hard cap` and launch is disabled → add a
max-iterations cap → checklist now shows `✗ Set at least one stop condition`, still disabled →
add a plateau-K stop → launch still disabled until the danger checkbox is ticked → tick it →
launch enabled → confirm dialog states the worst-case cost and the correctness-gate rule.

**E2E-5 — Autoresearch run shows keep-best + stop + ledger growth.**
Drive a short run against a **stub objective** (deterministic metric generator, no real compute,
mocked `poll`): the best-objective-vs-iteration chart advances, the ledger grows row by row with
`KEPT`/`DISCARDED` verdicts, a candidate that fails the correctness gate shows
`DISCARDED: failed verification` even though its objective is higher, and the loop ends with a
`stopped: plateau` banner after K non-improving iterations.

**E2E-6 — Edit dashboard spec re-renders without re-run.**
On a completed experiment's dashboard, open "Edit dashboard" → add a `score-bars` widget
bound to a secondary metric, re-order it above the table, save → the new widget renders from the
already-stored outcomes (no `launch`/`poll` re-fired) → a `custom`/newly-registered widget type
appears in the "Add widget" type list and can be added.

**E2E-7 — Edit metrics selection re-renders without re-run.**
Toggle a previously-uncollected metric on → it appears in the comparison/table extracted from the
stored raw outcomes, no re-run.

**E2E-8 — Persistence across reload (draft + live + dashboard).**
(a) Mid-definition (no launch yet), reload → the draft form rehydrates from `drafts/<key>`.
(b) After launch, reload via the `#/ext/experiment-runner?experimentId=…&view=dashboard`
deep-link → the dashboard rehydrates from the store and resumes polling if still running.
(c) Two experiments open in two side-panel tabs (parameterized `instanceKey`) survive reload
independently.

**E2E-9 — Stop / cleanup.**
A running A/B experiment's "Stop experiment" cancels pending child goals and the dashboard shows
`stopped`; deleting an experiment from the kebab removes it from the store and the deep-link then
no-ops (uninstall-style drop), pinning clean teardown.

**E2E-10 — Clean install / uninstall of the market pack** (Requirement 1 / acceptance
"installable pack"). Install the `experiment-runner` pack and assert the installed pack exposes
its **panel** (opens at mode-select), **routes** (a `listMetrics`/`projectCost` call responds),
and **entrypoints** (composer-slash + command-palette + deep-link route register). Then
**uninstall** and assert the panel, entrypoints, and routes are **removed**, the pack store is
left **ignored/tombstoned**, and a stale `#/ext/experiment-runner?…` deep-link **no-ops** with no
broken pane or dangling registry rows. (Paired with the API-side install/uninstall assertion in
[experiment-runner-pack-backend.md](experiment-runner-pack-backend.md) §12.)

Companion **unit** specs: the median/spread + same-completion-bar filtering and the accept/reject
+ plateau/budget/target stop maths live in the **shared lib** and are pinned by the reporting
suite ([experiment-runner-reporting.md](experiment-runner-reporting.md) §9.1/§9.2). Pack-side
node specs (`lib/`) then cover: `lib/aggregate.mjs` / `lib/autoresearch.mjs` are thin
adapter pass-throughs (no local maths — the no-fork guard, reporting §9.4); `engine.mjs` outcome
parsing from mocked REST payloads + per-run budget enforcement; guardrail enforcement (a
definition with no cap is rejected by `defineExperiment`); and the extensibility seams (a custom
metric extractor + a custom widget spec render).

---

## 13. Open questions for the implementing engineer

1. **`spawnGoal` return shape — RESOLVED.** It is exactly `{ goalId }` per arm (no
   `branch`/`blocked`/`capacity` fields). Outcome reads are **REST/goal-id-keyed**
   (`GET /api/goals/:id/cost|gates|tasks`) from the pack route — the route never parses a sibling
   goal's worktree `session-costs.json` / `gates.json` / `tasks.json` via ambient `fs`. See
   [experiment-runner-pack-backend.md](experiment-runner-pack-backend.md) §5.2.
2. **Live poll cadence** — the dashboard polls `poll`; align the interval with the
   reduce-server-cpu work (see `docs/design/reduce-server-cpu-experiment-dashboard-polling.md`)
   so a long overnight Autoresearch run doesn't hammer the gateway. Suggest a backoff (1.5s while
   actively spawning → 10s steady-state).
3. **Per-run / per-iteration budget — RESOLVED.** `spawnGoal` does **not** gain a per-goal
   cost-cap opt (it stays the only core change). `perRunBudget` is enforced in **framework
   space**: the route monitors goal-id-keyed cost during `poll`/`collect` and marks a child that
   exceeds the budget `failed`/`over_budget`, excluding its metrics from winning/acceptance
   (autoresearch discards it even if the objective improved); `cancel` makes a best-effort stop if
   a cancellation helper exists, else the run is just marked invalid. The overall `maxCostUsd`
   stays a hard launch/iteration cap (the loop refuses to spawn the next candidate past it).
   Per-run cost may overshoot by one poll interval, so comparisons use the same fixed budget
   threshold and mark overshoots invalid. See
   [experiment-runner-pack-backend.md](experiment-runner-pack-backend.md) §8.1a.
4. **Autoresearch candidate proposal** — the loop proposes a mutated candidate. Is the proposer
   an LLM call inside the `poll` route, or a separate spawned "proposer" child goal? This doc
   stays agnostic (the framework decides keep/stop deterministically regardless), but it affects
   the ledger's "proposed by" provenance.
```
