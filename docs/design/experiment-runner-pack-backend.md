# Experiment-runner pack — backend / lib design

**Status:** design (implementation pending). Stacked on PR #822
(`goal/hierarchical-g-f6c39aa2`): the per-goal **metadata** layer, the hierarchical
resolver, the effective-goal edges, the `goalProvisioned` lifecycle hook, and the
`goalManager.createGoal({ metadata, inlineRoles, parentGoalId, workflowId, … })`
opts are **assumed present** and reused, not rebuilt. See the goal spec and
[docs/marketplace.md](../marketplace.md) / [docs/extension-host-authoring.md](../extension-host-authoring.md)
for the pack/host surfaces this design composes.

This doc covers **only** the installable market pack `experiment-runner` (its
`pack.yaml`, route module, shared lib, store registry, the two engine modes, the
extension registries) plus the **one** sanctioned core/host change it needs
(`host.agents.spawnGoal`). UI panels/dashboard rendering are a sibling deliverable;
this doc fixes the data contracts they bind to.

---

## 1. The one core/host change — `host.agents.spawnGoal`

### Why it is required

`host.agents` (server-side, `src/server/extension-host/server-host-api.ts`) exposes
six verbs — `spawn / prompt / dismiss / list / read / status` — that mint and drive
**team child *sessions*** owned by the bound session (`childKind: "host-agents"`).
None of them creates a **goal**, and a host-agents child only *inherits* the bound
(experiment) goal's effective metadata via #822's resolver — it cannot carry a
**distinct per-arm treatment**. The experiment runner needs each variant / candidate
to be a **child goal** whose effective metadata = experiment metadata deep-merged
with that arm's treatment, so #822's hierarchy + the `goalProvisioned` hook then
propagate the treatment uniformly across that run's whole sub-tree (the no-asymmetry,
no-contamination guarantee). That capability does not exist today. This is the **only**
expected core/host change; everything else lives in the pack.

### Shape

Add a seventh verb to `ServerHostAgentsApi`, ambient like the rest (no manifest
declaration; feature-detect with `ctx.host.capabilities.has("agents")`, and if a
pack must degrade on an older host, narrow with
`typeof ctx.host.agents.spawnGoal === "function"` — see *Capability flag* below):

```ts
// server-host-api.ts — ServerHostAgentsApi (additive). Canonical opts:
type SpawnGoalOpts = {
  title: string;
  spec: string;
  /** REQUIRED idempotency key under the parent goal. A re-call with the same
   *  runKey returns the existing child id. */
  runKey: string;
  /** Optional caller assertion only; the server derives the real parent from the
   *  bound owner session goal and REJECTS a mismatch. Never authoritative. */
  parentGoalId?: string;
  /** Arm treatment. Deep-merged onto the experiment goal's metadata by #822's
   *  resolver; stored verbatim as the child's OWN metadata. */
  metadata?: Record<string, unknown>;
  /** Per-arm ephemeral roles, merged with the parent's inlineRoles snapshot
   *  (child overrides parent on same name) — same merge nested-goal-routes uses. */
  inlineRoles?: Record<string, Role>;
  /** Workflow id to snapshot onto the child goal (the comparable verification bar). */
  workflowId?: string;
  /** Full inline workflow snapshot (highest precedence over workflowId). */
  workflow?: Workflow;
};
spawnGoal(opts: SpawnGoalOpts): Promise<{ goalId: string }>;
```

The return shape is exactly `Promise<{ goalId: string }>` for v1 — **no**
`branch` / `blocked` / `capacityBlocked` fields, and **no** `dependsOnPlanIds`
opt. Capacity throttling is invisible to the caller (the per-root scheduler parks
the arm); the pack discovers progress by polling the child `goalId` (§5).

### Implementation — a thin wrapper over the existing spawn-child path

`spawnGoal` does **not** re-implement goal creation. It calls the **same** server-side
machinery `nested-goal-routes.ts` already uses for `goal_spawn_child`
(`goalManager.createGoal` → stamp `spawnedFromPlanId`/`spawnedBySessionId` →
`gateStore.initGatesForGoal` → `broadcastToAll({type:"goal_created"})` →
`verificationHarness.requestChildStart`). Concretely:

1. Resolve the parent **server-side** from the bound owner session's effective
   goal (the experiment goal) — reuse the spawn-child ownership/derivation logic.
   `parentGoalId` in the opts is a caller assertion only: if supplied and it does
   not equal the derived parent, reject (`PARENT_MISMATCH`). Honour
   `assertCanSpawn` recursion rules.
2. `createGoal(title, parentCwd, { spec, metadata, inlineRoles: merged, workflowId,
   resolvedWorkflow, projectId: parent.projectId, sandboxed: parent.sandboxed,
   parentGoalId, subgoalsAllowed: inherited, maxNestingDepth: inherited })`.
3. Stamp `spawnedBySessionId` (the experiment goal's lead), init gates, broadcast.
4. Route the team start through `verificationHarness.requestChildStart` so the **same
   per-root concurrency cap** that bounds nested goals also bounds experiment arms
   (this is how A/B `variant × repeat` fan-out and autoresearch `maxConcurrency` are
   enforced for free — see §6.1, §8).

Because step 2 funnels through `createGoal`, the child goal's **own** `metadata` is
exactly the arm treatment, and #822's `resolveGoalMetadata(lookup, childGoalId)`
yields `deepMerge(experimentMetadata, armMetadata)` for the child and **every**
descendant session it provisions — including the `goalProvisioned` hook firing on
member worktrees, sandbox, and the cold path. The runner asserts this uniformity
(Requirement 7) rather than re-deriving it.

### Capability flag

**No new `ServerHostCapabilities.spawnGoal` flag.** `spawnGoal` rides the existing
`capabilities.agents` umbrella — it is the seventh method on an already-exposed
namespace, so the masked `denyNamespace("agents", …)` stub covers it automatically
(the provider least-privilege host that denies `agents` cannot spawn goals,
unchanged). A pack that must degrade on an older host feature-detects with
`typeof ctx.host.agents.spawnGoal === "function"`; there is no fine-grained
`capabilities.has("spawnGoal")` probe.

### Seams it depends on (inject, don't import)

`createServerHostApi` already receives `orchestrationCore` (typed `unknown`) and
`readChildStatus`. Add two injected seams used **only** by `spawnGoal`, so the host
module keeps zero compile-time cycles:

- `spawnChildGoal?: (parentGoalId, ownerSessionId, opts) => Promise<{goalId, …}>` —
  the gateway binds this to the extracted `goal_spawn_child` core (refactor the body
  of the REST handler into a reusable function; the REST route becomes a thin caller,
  so there is **one** spawn-child implementation, not a fork).
- the existing `sessionId` (bound owner) is the authorization principal (the parent
  goal is derived from it; the opts `parentGoalId` is only an assertion checked
  against it).

> **Single source of truth:** extract the spawn-child body from
> `nested-goal-routes.ts` into `spawnChildGoalCore(...)` and have **both** the REST
> route and `host.agents.spawnGoal` call it. Do not duplicate the createGoal→stamp→
> initGates→broadcast→requestChildStart sequence.

---

## 2. Pack layout

```
market-packs/experiment-runner/
  pack.yaml
  panels/
    experiment-runner-panel.yaml          # id: experiment-runner.panel — ONE four-view state machine
                                          #   (mode-select → define → confirm → dashboard)
  entrypoints/
    experiment-runner-open.yaml           # composer-slash launcher → opens panel (mode-select)
    experiment-runner-palette.yaml        # command-palette launcher → opens panel
    experiment-runner-route.yaml          # kind: route, routeId: experiment-runner (deep-link → dashboard)
  lib/
    routes.mjs                            # pack-level routes (the orchestration brain)
    engine.mjs                            # mode-agnostic: run-config mapping, fan-out, outcome collection
    store-keys.mjs                        # registry key schema (pure; SINGLE source of store keys)
    aggregate.mjs                         # median/spread, same-bar filtering (pure)
    autoresearch.mjs                      # deterministic accept/reject + stop rules (pure)
    metrics.mjs                           # metric-extractor contract + registry + built-ins
    widgets.mjs                           # widget-renderer contract + registry + built-in specs
    experiment-report.mjs                 # SHARED reporting lib (build:packs bundle of
                                          #   src/shared/experiment-report/; single source — see §10)
  src/                                    # TS sources for the panel (built to lib/*.js by build:packs)
    panel.ts
```

> The shared reporting source lives at `src/shared/experiment-report/` and is
> bundled by `build:packs` into `market-packs/experiment-runner/lib/experiment-report.mjs`
> — it is never hand-authored under `lib/`. There is **no** `report.mjs`,
> `report-lib.mjs`, `optimizer.mjs`, or `gateway.mjs` file: outcome reads happen via
> sanctioned goal REST helpers inside `routes.mjs`/`engine.mjs` (§5), and the
> deterministic optimizer logic lives in `autoresearch.mjs`.

`pack.yaml`:

```yaml
name: experiment-runner
description: >-
  Data-driven experimentation + autonomous optimization. A/B comparison (default,
  bounded) and an opt-in, hard-capped autoresearch loop over Bobbit runs, with
  pluggable metrics and a spec-driven dashboard.
version: 1.0.0
schema: 2
contents:
  roles:   []
  tools:   []
  skills:  []
  entrypoints: [experiment-runner-open, experiment-runner-palette, experiment-runner-route]
routes:
  module: lib/routes.mjs
  names: [defineExperiment, projectCost, launch, poll, collect, aggregate,
          iterate, listExperiments, getExperiment, saveMetrics, saveDashboard,
          report, listMetrics, listWidgets, cancel]
```

No `tools/` (a UI + routes pack). All server logic is pack-level routes running in the
confined worker with ambient OS access + the injected `ctx.host` (`store`, `agents`
incl. `spawnGoal`, `session`).

---

## 3. Store registry shape (`host.store.*`, pack-namespaced)

The store is the **results registry** and the single source of truth the dashboard
computes from. `host.store` exposes only `get/put/list` (no delete) — deletes are null
tombstones (`softDelete`), exactly as pr-walkthrough does. **`lib/store-keys.mjs` is
the single source for every key** (use its builders everywhere; never inline a key
string). The canonical key schema:

| Key | Value type | Written by | Notes |
|---|---|---|---|
| `exp/<experimentId>` | `ExperimentDef` | `defineExperiment` | Definition: mode, variants, runnable, caps, objective. |
| `exp/<experimentId>/state` | `ExperimentState` | engine | Lifecycle/progress: mutable status + mode-specific cursor (A/B progress or AR iteration). |
| `exp/<experimentId>/run/<runId>` | `RunRecord` | `launch`/`iterate`/`collect` | One child-goal run; carries `rawOutcome` **and** extracted `metrics`, `completionBar`, `verified`, `cost`, `childGoalId`. |
| `exp/<experimentId>/ledger` | `LedgerEntry[]` | `iterate` | Autoresearch ledger (append-only, fed forward to the proposer). |
| `exp/<experimentId>/dashboard` | `DashboardSpec` | `saveDashboard` | Editable view-spec (§10). |
| `exp/<experimentId>/metrics` | `MetricSelection[]` | `saveMetrics` | Declarative metric selection (§7). |
| `index/experiments` | experiment index | define/cancel | expIds for `listExperiments` (last-write-wins reconcile). |

> **Rejected / replaced keys (do not use):** the bare `index`, and the
> earlier-draft `run/<expId>/...`, `outcome/<expId>/<runId>`, `agg/<expId>`,
> `exp/<id>/runs`, and `exp/<id>/best`. Per-run raw outcome **and** extracted
> metrics now live together inside the `RunRecord` (under
> `exp/<experimentId>/run/<runId>`), so there is no separate `outcome/*` blob.
> Aggregation and best-so-far are **computed on read** from the `RunRecord`s +
> ledger by `aggregate.mjs` — not persisted to an `agg/*` or `best` key (a single
> source of truth; recompute, never cache a divergent copy).

> **Worker statelessness:** `host.callRoute` spins a **fresh worker per call** — module
> singletons do not persist. All cross-call state lives in the store; routes are written
> last-write-wins + reconcile (never assume an in-memory map survives). Concurrency
> uses the per-root scheduler cap (§1.4), not in-worker locks.

### Key data types (`store-keys.mjs` / `engine.mjs` JSDoc; mirrored as TS in panels)

```ts
type Mode = "ab" | "autoresearch";

interface ExperimentDef {
  expId: string;
  title: string;
  mode: Mode;                       // DEFAULT "ab" — set by the define route, not a buried toggle
  createdAt: number;
  parentGoalId: string;            // the experiment goal under which arms are spawned
  workflowId?: string;             // comparable verification bar applied to every arm
  runnable: RunnableSpec;          // what each arm runs (agent spec or generic command — §9)
  // The live editable metric selection + view-spec live at their OWN store keys
  // (exp/<id>/metrics, exp/<id>/dashboard), written by saveMetrics / saveDashboard
  // and seeded from these initial values at define time:
  metrics: MetricSelection[];      // declarative: which metrics to collect (§7)
  dashboard: DashboardSpec;        // declarative view-spec (§10)
  // A/B only:
  variants?: VariantDef[];         // each = an arm treatment bundle
  repeats?: number;                // N repeats per variant (≥1)
  // Autoresearch only (ALL required to start; refuses uncapped):
  objective?: ObjectiveSpec;       // { metricId, direction: "max"|"min" }
  caps?: AutoresearchCaps;         // hard caps — see §8
  stop?: StopSpec;                 // plateau/target — see §8
  maxConcurrency?: number;         // clamped to the per-root cap
}

interface VariantDef {
  variantId: string;
  label: string;
  metadata: Record<string, unknown>;   // arm treatment → child goal metadata
  inlineRoles?: Record<string, Role>;  // per-arm ephemeral roles
}

interface RunnableSpec {
  kind: "agent" | "command";
  spec?: string;                   // agent: the goal spec text for the arm child goal
  command?: string;                // command: shell that emits a metric line (§9)
  metricChannel?: string;          // command: how the metric is reported (stdout JSON | file path)
}

interface RunRecord {
  runId: string; expId: string;
  variantId?: string;              // A/B
  repeatIndex?: number;            // A/B (0..repeats-1)
  iteration?: number;              // autoresearch
  candidate?: Record<string, unknown>;  // autoresearch proposed treatment
  childGoalId: string;             // the spawned child goal (spawnGoal result)
  state: RunState;                 // see §5 state machine
  spawnedAt: number; settledAt?: number; collectedAt?: number;
  error?: string;

  // ── filled at collect time, kept ON the RunRecord (NO separate outcome blob) ──
  completionBar?: "passed" | "failed" | "incomplete";  // from the arm's workflow gates
  verified?: boolean;              // correctness-gate result (AR rejects if false)
  cost?: { costUsd?: number; tokensIn?: number; tokensOut?: number };
  metrics?: Record<string /*metricId*/, number | null>;  // extracted selected metrics
  rawOutcome?: RawOutcome;         // underlying source data, retained for re-extraction
}

type RunState = "pending" | "spawned" | "running" | "settled" | "collected"
              | "failed" | "cancelled";

interface RawOutcome {
  costUsd?: number; tokensIn?: number; tokensOut?: number;
  gateVerdicts?: Record<string, "passed"|"failed"|"pending">;
  taskCounts?: { complete: number; total: number };
  userMetrics?: Record<string, number>;   // §7 user channel
}
```

**`RunRecord` carries `rawOutcome` and `metrics` together.** `collect` extracts the
selected metrics into `RunRecord.metrics` at collect time, but keeps `rawOutcome`
available so that when a user edits the metric selection or dashboard spec the pack
**re-extracts from the stored `rawOutcome` without re-running**. Reporting never
executes extractors — it consumes `RunRecord.metrics` (and `MetricSelection`).

---

## 4. Route catalogue (`lib/routes.mjs`)

Every route is `async (ctx, req) => result`, runs in the confined worker, and reaches
only its own pack store + `ctx.host.agents`. Mutating routes are POST.

| Route | Method | Input | Returns | Purpose / state effect |
|---|---|---|---|---|
| `defineExperiment` | POST | `ExperimentDef` (sans server fields) | `{ expId, projection }` | Validate (mode default `ab`; AR refuses uncapped — §8). Persist `exp/<id>` + `index/experiments`. Returns a **bounded cost projection** (§6.1). No spawns. |
| `projectCost` | POST | `{ expId }` or inline def | `CostProjection` | Pure projection without persisting; drives the pre-launch confirmation. |
| `launch` | POST | `{ expId }` | `{ launched: RunRecord[] }` | **A/B only.** Fan out `variant × repeat` child goals via `spawnGoal` (§6). Writes `exp/<id>/run/*`, sets state `running`. |
| `iterate` | POST | `{ expId }` | `{ iteration, action, candidateRun?, decision?, stopped? }` | **Autoresearch only.** One loop step (§8): seed candidate from ledger → spawn one eval child goal → (on a later call) decide + stop-check. |
| `poll` | POST | `{ expId }` | `{ runs: RunRecord[], allSettled }` | Advance run states from `host.agents.status` / child-goal gate status. Idempotent. |
| `collect` | POST | `{ expId, runId? }` | `{ runs: RunRecord[] }` | For settled runs, read costs/gates/tasks by `childGoalId` (§5.2), run metric extractors, and write `rawOutcome` + extracted `metrics` + `completionBar` + `verified` + `cost` **onto the `RunRecord`**; flip `collected`. |
| `aggregate` | POST | `{ expId }` | `Aggregation` | A/B: median+spread per variant over same-bar runs. AR: best-so-far. **Computed on read** from the `RunRecord`s + ledger — not persisted to an `agg/*` key. |
| `getExperiment` | GET | `{ expId }` | `{ def, state, runs, ledger }` | Dashboard hydration (single fetch); `runs` are the `RunRecord`s (raw outcome + metrics inline). |
| `listExperiments` | GET | — | `ExperimentDef[]` | Index. |
| `saveMetrics` | POST | `{ expId, metrics: MetricSelection[] }` | `{ ok }` | Edit the metric selection; re-extracts from stored `rawOutcome`, **no re-run**. |
| `saveDashboard` | POST | `{ expId, dashboard: DashboardSpec }` | `{ ok }` | Edit the view-spec; re-renders from stored runs, **no re-run**. |
| `report` | POST | `{ expId }` | `{ model, html }` | Generate a report via the **shared reporting lib** (§10). |
| `listMetrics` | GET | — | `MetricDescriptor[]` | Registry introspection for the define form (§7). |
| `listWidgets` | GET | — | `WidgetDescriptor[]` | Registry introspection for the dashboard editor (§10). |
| `cancel` | POST | `{ expId }` | `{ cancelled }` | Dismiss in-flight arm child goals (`host.agents`), flip runs `cancelled`, stop AR loop. |

The launcher entrypoints are **plain panel-opening** launchers (not spawn launchers):
clicking opens `experiment-runner.panel` at its mode-select view; the panel calls
`defineExperiment` then `launch`/`iterate` from explicit user gestures. AR launch
additionally requires the caps-confirmation gesture before the panel will call
`iterate` (§8).

---

## 5. Run lifecycle & outcome collection

### 5.1 Run state machine

```
        spawnGoal ok            host.agents.status / gates           collect
pending ───────────▶ spawned ───────────────────────▶ settled ─────────────▶ collected
   │                   │                                  │
   │ spawnGoal error   │ child terminated w/o pass        │ extractor error
   ▼                   ▼                                  ▼
 failed              failed                             failed
   ▲
   └──────────────── cancel (any non-terminal) ──────▶ cancelled
```

- `pending → spawned`: `spawnGoal` returned a `goalId` (idempotent on `runKey`). The
  return shape is just `{ goalId }` — capacity is invisible to the caller; the
  per-root scheduler parks the arm and `poll` simply observes it not-yet-started
  until a permit frees, so the scheduler cap throttles fan-out transparently.
- `spawned → running → settled`: `poll` reads the arm child goal's status. "Settled"
  means the child goal reached a **terminal** state (its workflow gates resolved, or
  the team completed). The completion **bar** is read from the child goal's gates.
- `settled → collected`: `collect` extracts metrics. Failure to extract ⇒ `failed` with
  `error`, never a silent drop.

### 5.2 Outcome sources (read-only, three channels)

A pack route reads each arm's outcome **only** via **REST/internal goal-id-keyed
reads** — it must **never** parse a sibling goal's `session-costs.json`,
`gates.json`, or `tasks.json` through ambient fs/worktree paths. A server pack route
is trusted with ambient `fetch` + on-disk creds (`.bobbit/state/token`,
`.bobbit/state/gateway-url`, read from disk by a small REST helper inside
`routes.mjs`/`engine.mjs`, never from env). The arm's `childGoalId` is the key, and
the extracted values land on the `RunRecord` (§3):

| Channel | Source | Endpoint (keyed by `childGoalId`) | Extracted into |
|---|---|---|---|
| **Cost** | `session-costs.json` rollup | `GET /api/goals/:id/cost` (`{ totalCostUsd, tokensIn, tokensOut, cacheHitRate }`) | `cost.costUsd`, `cost.tokensIn/out` |
| **Gates** | `gates.json` + verification | `GET /api/goals/:id/gates` | `completionBar`, `verified`, `rawOutcome.gateVerdicts` |
| **Tasks** | `tasks.json` | `GET /api/goals/:id/tasks` (`state`, `resultSummary`) | `rawOutcome.taskCounts` |
| **User metric** | arm-emitted | child goal metadata key `experiment.userMetrics` (read via `GET /api/goals/:id`) or a result artifact | `rawOutcome.userMetrics` (§7) |

> **Why REST/goal-id keyed, never fs:** state files live in the centralized
> `.bobbit/state`, not the arm worktree, so `process.cwd()` (the experiment session
> worktree) is the wrong root, and a sandboxed arm's files may be on a container path
> the pack cannot reach. REST keyed by the child `goalId` is version-stable and
> already authorizes. This adds **no** new core endpoint — all four already exist.

`collect` may call `host.agents.read`/`status` for live arm progress, but the
**outcome of record** comes from the cost/gates/tasks REST reads keyed by the arm
`childGoalId`, so it is correct even after the arm child session is dismissed.

---

## 6. A/B mode (default)

### 6.1 Bounded cost projection (pre-launch)

`projectCost` is pure and runs at define time and again before launch:

```
arms      = variants.length × repeats
estPerArm = runnable.estCostUsd ?? historicalMedian(similar arms) ?? defaultPriorUsd
projected = { arms, estCostUsd: arms × estPerArm, estWallClock, concurrencyCap }
```

The define panel shows `projected` and requires an explicit confirm gesture before
`launch`. A/B has **no feedback loop and no self-modification** — the projection is a
hard, knowable bound (Requirement 3, Acceptance: bounded).

### 6.2 Fan-out

`launch` iterates `variants × repeats`; for each it calls:

```js
const { goalId } = await ctx.host.agents.spawnGoal({
  title: `${exp.title} — ${variant.label} #${repeatIndex}`,
  spec: runnableSpecToGoalSpec(exp.runnable, variant),
  runKey: `${expId}:${variant.variantId}:${repeatIndex}`,  // idempotency key under the parent
  metadata: deepMerge(
    { experiment: { expId, variantId: variant.variantId, repeatIndex } },
    variant.metadata),                  // arm treatment
  inlineRoles: variant.inlineRoles,
  workflowId: exp.workflowId,           // same comparable bar for every arm
  parentGoalId: exp.parentGoalId,       // assertion only; server derives + verifies
});
```

Each arm is a child goal of the experiment goal; #822 propagates
`deepMerge(experimentMetadata, armMetadata)` across that arm's entire sub-tree, so arms
never cross-contaminate (Requirement 7 — the runner **asserts** this in collect by
reading the arm's effective metadata and checking the treatment is present and uniform).
The per-root concurrency cap throttles fan-out transparently (the return is just
`{ goalId }`); `poll` re-invokes `launch` with the same `runKey` for any arm not yet
started — idempotent, so a parked arm is never double-spawned.

### 6.3 Aggregation (`aggregate.mjs`, pure)

- **Same-completion-bar filtering:** only `completionBar === "passed"` runs feed the
  central tendency (failed/incomplete arms are surfaced separately, never averaged in).
- Per `(variantId, metricId)`: **median** + **spread** (IQR or MAD) over repeats, plus
  `n`, `nPassed`, direction-aware best/worst.
- Output `Aggregation.variants[variantId].metrics[metricId] = { median, spread, n, … }`,
  with a cross-variant ranking per metric honouring each metric's `direction`.

---

## 7. Metric extensibility (`metrics.mjs`)

### 7.1 Metric-extractor contract (stable extension point)

```ts
interface MetricExtractor {
  id: string;                          // e.g. "cost.totalUsd", "tasks.completionRate"
  label: string;
  direction: "max" | "min";            // objective sense; default per metric
  unit?: string;
  /** Pure: given a run's collected raw sources, return a number or null (absent). */
  extract(raw: RunRecord["rawOutcome"], ctx: { def: ExperimentDef; run: RunRecord }): number | null;
}
```

Adding a metric is a **registration**, not a refactor: `registerMetric(extractor)`
into a module map; `listMetrics` returns descriptors for the define form. Built-in core
set (deliberately small — the point is the seam):

- `cost.totalUsd` (min), `cost.tokensTotal` (min), `cost.cacheHitRate` (max)
- `gates.passRate` (max), `gates.firstPassClean` (max)
- `tasks.completionRate` (max), `time.wallClockMs` (min)

### 7.2 Declarative selection (agent/user-facing, no code)

`ExperimentDef.metrics: MetricSelection[]` where
`MetricSelection = { metricId, aggregation?: "median"|"mean"|"p90", directionOverride? }`.
Agents/users pick which built-ins to collect and how to aggregate by **editing the def**
— no code, no redeploy. For autoresearch, `objective.metricId` must reference a selected
metric.

### 7.3 Pluggable user-metric channel

For "measure something Bobbit doesn't know about", the **user-metric channel** needs no
new extractor code: the arm reports a number under
`metadata.experiment.userMetrics.<name>` (agent path) or emits it on the command's metric
channel (§9). The built-in extractor `user.<name>` reads `rawOutcome.userMetrics[name]`. This
is the no-code path for novel metrics; a code extractor (§7.1) is only for non-trivial
derivations.

---

## 8. Autoresearch mode (opt-in, off by default, hard-capped)

A separate front door (mode `autoresearch`), never a default. `defineExperiment`
**refuses to persist/launch** an AR experiment that is not fully capped.

### 8.1 Mandatory guardrails (validated at define time)

```ts
interface AutoresearchCaps {       // at least ONE must be finite; all are enforced
  maxIterations?: number;          // hard cap on loop steps
  maxWallClockMs?: number;         // hard cap on elapsed time
  maxCostUsd?: number;             // hard cap on cumulative arm cost
}
interface StopSpec {               // at least ONE stop condition required
  plateauK?: number;               // no objective improvement over K consecutive iterations
  plateauEps?: number;             // improvement smaller than eps counts as no-improvement
  target?: number;                 // stop when objective crosses target (direction-aware)
}
```

Validation: AR requires `objective` **and** at least one finite cap **and** at least one
stop condition, else `defineExperiment` returns `{ error: "AR_UNCAPPED" }` and persists
nothing. A **cost projection per iteration** (`fixedPerIterationBudget`) is shown and an
explicit confirm gesture is required before the panel calls `iterate`.

### 8.2 The loop (deterministic accept/reject; the LLM proposes, the framework decides)

`iterate` is **one step** (the worker can't long-block); the panel calls it repeatedly
(or a poll drives it). Each step:

1. **Stop-check first** (deterministic, from the registry): if any cap is hit or any
   stop condition is met → write `state.stopped = { reason }`, return `{ stopped }`.
2. **Generate:** seed a candidate from the **ledger** (`ledger/<expId>`, append-only,
   fed forward). v1 proposer is **simple** (greedy / best-of-batch around best-so-far —
   no Bayesian/evolutionary). The proposal itself may be produced by an arm agent, but
   the candidate treatment is recorded deterministically.
3. **Evaluate:** spawn one candidate child goal via `spawnGoal` under a **fixed
   per-iteration budget** (`metadata.experiment.budget`), with the same `workflowId`
   correctness bar. Record a `RunRecord` (`iteration`, `candidate`).
4. **Decide (on a later `iterate`/`poll`, once the candidate settles + is collected):**
   compute the candidate's objective from `RunRecord.metrics[objective.metricId]`.
   **Accept iff** it improves on best-so-far (direction-aware, by > `plateauEps`)
   **AND** `completionBar === "passed"` / `verified` (the **correctness gate** — a
   candidate that fails verification is rejected even if the objective "improved").
   Else **reject/discard**. Best-so-far is **recomputed from the `RunRecord`s +
   ledger** (no stored `agg`/`best` key); append a `LedgerEntry`.

```ts
interface LedgerEntry {
  iteration: number; runId: string; candidate: Record<string, unknown>;
  objective: number | null; completionBar: RunRecord["completionBar"];
  decision: "accepted" | "rejected"; bestObjectiveAfter: number | null;
  reason: string;                  // e.g. "improved & passed", "regressed", "failed-correctness-gate"
}
```

### 8.3 Stop conditions (deterministic, computed from the registry)

- **Budget:** cumulative arm cost ≥ `maxCostUsd`, iterations ≥ `maxIterations`, or
  elapsed ≥ `maxWallClockMs`.
- **Plateau:** no accepted improvement > `plateauEps` over the last `plateauK` iterations.
- **Target:** best objective crosses `target` (direction-aware).

All three are pure functions of the ledger + caps (`autoresearch.mjs`), so accept/stop
are **testable on synthetic series** with no real compute.

---

## 9. Generic command runnable path

The runner is agnostic about what an arm *does*. `RunnableSpec.kind === "command"`
makes a non-Bobbit unit work through the same path:

- The arm child goal's spec instructs it to run `runnable.command` (the user's runnable
  unit — a training/eval job, a script). The command emits a metric via
  `runnable.metricChannel`:
  - `stdout-json`: a final line `{"experiment":{"userMetrics":{"<name>":<number>}}}`.
  - `file`: a path the command writes `{ userMetrics: {...} }` to.
- A minimal arm workflow gate runs the command and captures the metric into the arm
  goal's `metadata.experiment.userMetrics` (or a result artifact), so `collect` reads it
  through the user-metric channel (§7.3) exactly like an agent-emitted metric.

This satisfies the acceptance criterion "a non-Bobbit runnable unit (a command emitting a
metric) works through the same path" with **no** runner special-casing beyond the
`RunnableSpec` discriminant. GPU/training infra is the user's concern; the runner only
spawns, bars, and collects.

---

## 10. Reporting / dashboards (spec-driven, one shared lib)

### 10.1 Shared reporting lib (single source of truth)

The canonical report engine is the shared source `src/shared/experiment-report/`,
bundled by `build:packs` to `lib/experiment-report.mjs`. The pack's `report` route
(returning `{ model, html }`) and the panel dashboard both import it — report logic is
never forked. **Note:** `graphify-ab` / `ab-report.mjs` is **absent in this branch**;
there is nothing to port. The shared lib is authored fresh as the engine, and *if*
`graphify-ab` ever lands it must be rewritten as a **thin wrapper** over this lib (no
statistics, no chart HTML of its own). The reporting sub-stream owns the full
contract — see [experiment-runner-reporting.md](experiment-runner-reporting.md).

### 10.2 Widget-renderer registry (`widgets.mjs`, stable extension point)

```ts
interface WidgetRenderer {
  type: string;                    // "bar", "line", "table", "scoreBars", "statusGrid", …
  /** Pure: spec + bound data → a serializable view model (or HTML for the report). */
  render(spec: WidgetSpec, data: WidgetData): WidgetViewModel;
}
interface WidgetSpec {
  type: string;
  title?: string;
  bind: { metricIds?: string[]; groupBy?: "variant" | "iteration"; aggregation?: string };
}
interface DashboardSpec { widgets: WidgetSpec[]; version: number; }
```

Built-in widget types (small core): `bar` (per-variant median+spread), `line`
(best-objective-vs-iteration for AR), `table` (variant × metric), `scoreBars`,
`statusGrid` (completion bars). A pack can `registerWidget(renderer)` to contribute a
custom visualization — a **registration, not a refactor**. `listWidgets` feeds the
dashboard editor.

### 10.3 Editable view-spec, re-render without re-run

The `DashboardSpec` lives at `exp/<id>/dashboard`; `saveDashboard` rewrites it and the
metric selection at `exp/<id>/metrics` is rewritten by `saveMetrics`. The panel
re-renders from the **stored `RunRecord`s** (each carries `rawOutcome` + `metrics`) —
no re-spawn, no redeploy; editing the metric selection re-extracts from the stored
`rawOutcome`. Adding/selecting a metric (§7.2) + binding a widget to it is the no-code
extensibility proof. The dashboard panel and the `report` route both render from the
**same** shared lib + spec, so the live dashboard and the generated report agree.

---

## 11. Extension seams (documented stable contracts)

| Seam | Where | Stability contract |
|---|---|---|
| `host.agents.spawnGoal` | core/host | Rides `capabilities.agents`; feature-detect via `typeof ctx.host.agents.spawnGoal === "function"`; additive opts only. |
| `MetricExtractor` + `registerMetric` | `lib/metrics.mjs` | Pure `extract(rawOutcome, ctx)`; new metric = registration. |
| User-metric channel | `metadata.experiment.userMetrics` / command metric channel | No-code novel metrics. |
| `WidgetRenderer` + `registerWidget` | `lib/experiment-report.mjs` (shared lib) | Pure `render(spec, data)`; new chart = registration. |
| `DashboardSpec` | store `exp/<id>/dashboard` | Declarative, editable, versioned. |
| `RunnableSpec` | store `exp/<id>.runnable` | `agent` | `command` discriminant; generic path. |
| Results registry keys | `lib/store-keys.mjs` | Single source of keys; append/last-write-wins; null-tombstone deletes. |

---

## 12. Tests to add

### Unit (pack lib, `file://` / node — no server)

- `aggregate.mjs`: median/spread, same-completion-bar filtering, direction-aware
  ranking; degenerate cases (all-failed, n=1).
- `autoresearch.mjs`: accept/reject on **synthetic series** (improving, regressing,
  noisy-within-eps, correctness-gate-fail-but-objective-improved → rejected); stop rules
  (plateau over K, target crossed, each cap) on synthetic ledgers.
- `metrics.mjs`: built-in extractors over synthetic `raw`; **custom metric**
  registration is listed + selectable + extracted; user-metric channel.
- `widgets.mjs` + `experiment-report.mjs`: built-in widget render from a spec + data;
  **newly-registered widget type is used** by a dashboard spec; report HTML golden.
- `engine.mjs`: run-config mapping (variant×repeat → spawnGoal args incl. `runKey`;
  candidate → spawnGoal args); outcome parsing from mocked REST payloads.
- **Guardrail enforcement:** `defineExperiment` validation refuses AR uncapped /
  no-objective / no-stop; A/B requires repeats ≥ 1.

### API E2E (`tests/e2e/`, in-process harness — drive `routes.mjs` via `ModuleHost.invoke`)

Mirror `tests/e2e/host-agents.spec.ts` (build a live `ServerHostApi` with the
`spawnChildGoal` seam + a mock/canned arm goal):

- **(a) A/B:** a 2-variant × 2-repeat experiment fans out via `spawnGoal`, each arm's
  child goal carries **distinct arm metadata verified to reach the arm's sub-tree**
  (`resolveGoalMetadata` on a descendant returns the merged treatment); `collect`
  writes `rawOutcome` + `metrics` onto each `RunRecord` (mocked REST), `aggregate`
  recomputes from the registry.
- **(b) Autoresearch on a stub objective** (deterministic metric generator, **no real
  compute**): `iterate` keeps best, appends ledger, stops on plateau/cap; ledger grows;
  best-objective-vs-iteration is monotone non-decreasing for accepts.
- `spawnGoal` authorization: an **asserted `parentGoalId` mismatch** is rejected; a
  child session cannot `spawnGoal` (no grandchildren) — reuse `assertCanSpawn`.

### Browser E2E (`tests/e2e/ui/experiment-runner.spec.ts`)

- Panel **defaults to A/B**; switching to autoresearch **requires caps + confirmation**
  before launch is enabled.
- Define both modes, see runs spawn, dashboard renders from outcomes.
- **Edit the dashboard spec (`saveDashboard`) / metric selection (`saveMetrics`) →
  re-renders** without re-run; **persists across reload** (rehydrate from
  `getExperiment`/store).
- Deep-link route reopens the dashboard rehydrated from the store.

### Gates

`npm run check`, `npm run test:unit`, `npm run test:e2e`. Because the change touches
spawn/host (`spawnGoal`), also `npm run test:manual`.

---

## 13. Open questions / risks

- **`spawnGoal` start semantics:** confirm that `requestChildStart` provisions a
  team-lead that drives the arm child goal to a terminal/verified state without manual
  intervention (the runner relies on arms self-completing). If a workflow requires a
  human gate, AR/A/B must treat it as `incomplete`, not block the loop.
- **Cost attribution latency:** `GET /api/goals/:id/cost` may lag the arm's final turn;
  `collect` should only finalize an outcome once the arm goal is terminal (gates
  resolved), not merely idle.
- **Concurrency vs. comparability:** running arms concurrently under the per-root cap is
  fine for cost/gates metrics but may bias `time.wallClockMs` (contention). Note this in
  the metric descriptor; prefer per-arm CPU/turn metrics for fair timing.
- **Proposer determinism:** the LLM proposes candidates; the *decision* is deterministic.
  Pin the proposer's inputs (ledger snapshot) so a replay is reproducible for tests.
