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
declaration; feature-detect with `ctx.host.capabilities.has("agents")` plus a
narrower `ctx.host.capabilities.has("spawnGoal")` — see *Capability flag* below):

```ts
// server-host-api.ts — ServerHostAgentsApi (additive)
spawnGoal(opts: {
  title: string;
  spec: string;
  /** Arm treatment. Deep-merged onto the experiment goal's metadata by #822's
   *  resolver once parentGoalId is set; stored verbatim as the child's OWN metadata. */
  metadata?: Record<string, unknown>;
  /** Per-arm ephemeral roles, merged with the parent's inlineRoles snapshot
   *  (child overrides parent on same name) — same merge nested-goal-routes uses. */
  inlineRoles?: Record<string, Role>;
  /** Workflow id to snapshot onto the child goal (the comparable verification bar). */
  workflowId?: string;
  /** REQUIRED: the experiment goal id. Must be the bound session's own goal (or a
   *  goal the bound session owns) — server-verified, never trusted from the arg. */
  parentGoalId: string;
  /** Optional dependency scheduling parity with goal_spawn_child. */
  dependsOnPlanIds?: string[];
}): Promise<{ goalId: string; branch?: string; blocked?: boolean; capacityBlocked?: boolean }>;
```

### Implementation — a thin wrapper over the existing spawn-child path

`spawnGoal` does **not** re-implement goal creation. It calls the **same** server-side
machinery `nested-goal-routes.ts` already uses for `goal_spawn_child`
(`goalManager.createGoal` → stamp `spawnedFromPlanId`/`spawnedBySessionId` →
`gateStore.initGatesForGoal` → `broadcastToAll({type:"goal_created"})` →
`verificationHarness.requestChildStart`). Concretely:

1. Resolve + **authorize** `parentGoalId`: it must be the bound session's goal (the
   experiment goal) — reuse the spawn-child ownership/derivation logic. Reject
   otherwise (`SPAWNGOAL_NOT_OWNER`). Honour `assertCanSpawn` recursion rules.
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

Add `spawnGoal: boolean` to `ServerHostCapabilities` (default `false`, flipped `true`
when the verb is wired and an `OrchestrationCore`/goal-manager seam is injected).
Keep `agents` as the umbrella flag; `spawnGoal` is the fine-grained probe so a pack
degrades cleanly on an older host. The verb is denied (throwing stub) when the host is
built with a capability mask that excludes it (mirrors `denyNamespace`).

### Seams it depends on (inject, don't import)

`createServerHostApi` already receives `orchestrationCore` (typed `unknown`) and
`readChildStatus`. Add two injected seams used **only** by `spawnGoal`, so the host
module keeps zero compile-time cycles:

- `spawnChildGoal?: (parentGoalId, ownerSessionId, opts) => Promise<{goalId, …}>` —
  the gateway binds this to the extracted `goal_spawn_child` core (refactor the body
  of the REST handler into a reusable function; the REST route becomes a thin caller,
  so there is **one** spawn-child implementation, not a fork).
- the existing `sessionId` (bound owner) is the authorization principal.

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
    experiment-runner-dashboard.yaml     # id: experiment-runner.dashboard
    experiment-runner-define.yaml         # id: experiment-runner.define  (mode select + definition form)
  entrypoints/
    experiment-runner-open.yaml           # composer-slash launcher → define panel
    experiment-runner-route.yaml          # kind: route, routeId: experiment-runner (deep-link → dashboard)
  lib/
    routes.mjs                            # pack-level routes (the orchestration brain)
    engine.mjs                            # mode-agnostic: run-config mapping, fan-out, outcome collection
    aggregate.mjs                         # median/spread, same-bar filtering (pure)
    autoresearch.mjs                      # deterministic accept/reject + stop rules (pure)
    metrics.mjs                           # metric-extractor contract + registry + built-ins
    widgets.mjs                           # widget-renderer contract + registry + built-in specs
    report.mjs                            # SHARED reporting lib (single source of truth; see §10)
    store-keys.mjs                        # registry key schema (pure)
    gateway.mjs                           # ambient gateway REST client (token+url from disk) for outcome reads
  src/                                    # TS sources for the panels (built to lib/*.js by build:packs)
    dashboard-panel.ts
    define-panel.ts
```

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
  entrypoints: [experiment-runner-open, experiment-runner-route]
routes:
  module: lib/routes.mjs
  names: [defineExperiment, projectCost, launch, poll, collect, aggregate,
          iterate, listExperiments, getExperiment, setDashboard, report,
          listMetrics, listWidgets, cancel]
```

No `tools/` (a UI + routes pack). All server logic is pack-level routes running in the
confined worker with ambient OS access + the injected `ctx.host` (`store`, `agents`
incl. `spawnGoal`, `session`).

---

## 3. Store registry shape (`host.store.*`, pack-namespaced)

The store is the **results registry** and the single source of truth the dashboard
computes from. `host.store` exposes only `get/put/list` (no delete) — deletes are null
tombstones (`softDelete`), exactly as pr-walkthrough does. Keys (see `store-keys.mjs`):

| Key | Value type | Written by | Notes |
|---|---|---|---|
| `exp/<expId>` | `ExperimentDef` | `defineExperiment` | Definition: mode, variants, metrics, dashboard, caps, objective. |
| `exp/<expId>/state` | `ExperimentState` | engine | Mutable status + mode-specific cursor (A/B progress or AR iteration). |
| `run/<expId>/<runId>` | `RunRecord` | `launch`/`iterate` | One child-goal run (variant×repeat arm, or one AR candidate). |
| `outcome/<expId>/<runId>` | `RunOutcome` | `collect` | Extracted metrics + completion bar + raw source refs. |
| `agg/<expId>` | `Aggregation` | `aggregate` | A/B: per-variant aggregated metrics. AR: best-so-far snapshot. |
| `ledger/<expId>` | `LedgerEntry[]` | `iterate` | Autoresearch ledger (append-only, fed forward to the proposer). |
| `index/experiments` | `string[]` | define/cancel | expIds for `listExperiments` (last-write-wins reconcile). |

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
  goalId: string;                  // the spawned child goal
  branch?: string;
  state: RunState;                 // see §5 state machine
  spawnedAt: number; settledAt?: number;
  error?: string;
}

type RunState = "pending" | "spawned" | "running" | "settled" | "collected"
              | "failed" | "cancelled";

interface RunOutcome {
  runId: string; expId: string;
  completionBar: "passed" | "failed" | "incomplete";  // from the arm's workflow gates
  metrics: Record<string /*metricId*/, number | null>;
  raw: { costUsd?: number; tokensIn?: number; tokensOut?: number;
         gateVerdicts?: Record<string, "passed"|"failed"|"pending">;
         taskCounts?: { complete: number; total: number };
         userMetrics?: Record<string, number> };  // §7 user channel
  collectedAt: number;
}
```

---

## 4. Route catalogue (`lib/routes.mjs`)

Every route is `async (ctx, req) => result`, runs in the confined worker, and reaches
only its own pack store + `ctx.host.agents`. Mutating routes are POST.

| Route | Method | Input | Returns | Purpose / state effect |
|---|---|---|---|---|
| `defineExperiment` | POST | `ExperimentDef` (sans server fields) | `{ expId, projection }` | Validate (mode default `ab`; AR refuses uncapped — §8). Persist `exp/<id>` + `index`. Returns a **bounded cost projection** (§6.1). No spawns. |
| `projectCost` | POST | `{ expId }` or inline def | `CostProjection` | Pure projection without persisting; drives the pre-launch confirmation. |
| `launch` | POST | `{ expId }` | `{ launched: RunRecord[] }` | **A/B only.** Fan out `variant × repeat` child goals via `spawnGoal` (§6). Writes `run/*`, sets state `running`. |
| `iterate` | POST | `{ expId }` | `{ iteration, action, candidateRun?, decision?, stopped? }` | **Autoresearch only.** One loop step (§8): seed candidate from ledger → spawn one eval child goal → (on a later call) decide + stop-check. |
| `poll` | POST | `{ expId }` | `{ runs: RunRecord[], allSettled }` | Advance run states from `host.agents.status` / child-goal gate status. Idempotent. |
| `collect` | POST | `{ expId, runId? }` | `{ outcomes: RunOutcome[] }` | For settled runs, run metric extractors against costs/gates/tasks (§5.2). Writes `outcome/*`, flips `collected`. |
| `aggregate` | POST | `{ expId }` | `Aggregation` | A/B: median+spread per variant over same-bar runs. AR: recompute best-so-far. Writes `agg/<id>`. |
| `getExperiment` | GET | `{ expId }` | `{ def, state, runs, outcomes, agg, ledger }` | Dashboard hydration (single fetch). |
| `listExperiments` | GET | — | `ExperimentDef[]` | Index. |
| `setDashboard` | POST | `{ expId, dashboard: DashboardSpec }` | `{ ok }` | Edit the view-spec; re-renders from stored outcomes, **no re-run**. |
| `report` | POST | `{ expId, format? }` | `{ html }` | Generate a report via the **shared reporting lib** (§10). |
| `listMetrics` | GET | — | `MetricDescriptor[]` | Registry introspection for the define form (§7). |
| `listWidgets` | GET | — | `WidgetDescriptor[]` | Registry introspection for the dashboard editor (§10). |
| `cancel` | POST | `{ expId }` | `{ cancelled }` | Dismiss in-flight arm child goals (`host.agents`), flip runs `cancelled`, stop AR loop. |

The launcher entrypoint is a **plain panel-opening** launcher (not a spawn launcher):
clicking opens `experiment-runner.define`; the panel calls `defineExperiment` then
`launch`/`iterate` from explicit user gestures. AR launch additionally requires the
caps-confirmation gesture before the panel will call `iterate` (§8).

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

- `pending → spawned`: `spawnGoal` returned a `goalId` (or `blocked`/`capacityBlocked`
  — stays `pending`, retried by the next `launch`/`poll`; the scheduler cap throttles).
- `spawned → running → settled`: `poll` reads the arm child goal's status. "Settled"
  means the child goal reached a **terminal** state (its workflow gates resolved, or
  the team completed). The completion **bar** is read from the child goal's gates.
- `settled → collected`: `collect` extracts metrics. Failure to extract ⇒ `failed` with
  `error`, never a silent drop.

### 5.2 Outcome sources (read-only, three channels)

A pack route cannot read another goal's cost/gates/tasks through `host.store`
(pack-namespaced) or `host.session` (own-session). It uses the **sanctioned gateway
REST** path — server pack modules are trusted with ambient `fetch` + on-disk creds
(`.bobbit/state/token`, `.bobbit/state/gateway-url`; `gateway.mjs` reads them, never
env). The arm goalId is the key:

| Channel | Source | Endpoint | Extracted into |
|---|---|---|---|
| **Cost** | `session-costs.json` rollup | `GET /api/goals/:id/cost` (`{ totalCostUsd, tokensIn, tokensOut, cacheHitRate }`) | `raw.costUsd`, `raw.tokensIn/out` |
| **Gates** | `gates.json` + verification | `GET /api/goals/:id/gates` | `completionBar`, `raw.gateVerdicts` |
| **Tasks** | `tasks.json` | `GET /api/goals/:id/tasks` (`state`, `resultSummary`) | `raw.taskCounts` |
| **User metric** | arm-emitted | child goal metadata key `experiment.userMetrics` (read via `GET /api/goals/:id`) or a result artifact | `raw.userMetrics` (§7) |

> **Why REST not fs:** state files live in the centralized `.bobbit/state`, not the arm
> worktree, so `process.cwd()` (the experiment session worktree) is the wrong root. REST
> is version-stable and already authorizes. This adds **no** new core endpoint — all
> four already exist.

`collect` calls `host.agents.read`/`status` for live arm progress, but the **outcome of
record** comes from the cost/gates/tasks REST reads keyed by the arm `goalId`, so it is
correct even after the arm child session is dismissed.

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
const { goalId, branch, blocked } = await ctx.host.agents.spawnGoal({
  title: `${exp.title} — ${variant.label} #${repeatIndex}`,
  spec: runnableSpecToGoalSpec(exp.runnable, variant),
  metadata: deepMerge(
    { experiment: { expId, variantId: variant.variantId, repeatIndex } },
    variant.metadata),                  // arm treatment
  inlineRoles: variant.inlineRoles,
  workflowId: exp.workflowId,           // same comparable bar for every arm
  parentGoalId: exp.parentGoalId,
});
```

Each arm is a child goal of the experiment goal; #822 propagates
`deepMerge(experimentMetadata, armMetadata)` across that arm's entire sub-tree, so arms
never cross-contaminate (Requirement 7 — the runner **asserts** this in collect by
reading the arm's effective metadata and checking the treatment is present and uniform).
The per-root concurrency cap throttles fan-out; `poll` re-launches `blocked` arms.

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
  extract(raw: RunOutcome["raw"], ctx: { def: ExperimentDef; run: RunRecord }): number | null;
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
channel (§9). The built-in extractor `user.<name>` reads `raw.userMetrics[name]`. This
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
   compute the candidate's objective from `outcome.metrics[objective.metricId]`.
   **Accept iff** it improves on best-so-far (direction-aware, by > `plateauEps`)
   **AND** `completionBar === "passed"` (the **correctness gate** — a candidate that
   fails verification is rejected even if the objective "improved"). Else **reject/discard**.
   Update `agg/<expId>` best-so-far and append a `LedgerEntry`.

```ts
interface LedgerEntry {
  iteration: number; runId: string; candidate: Record<string, unknown>;
  objective: number | null; completionBar: RunOutcome["completionBar"];
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

Port `.claude/skills/graphify-ab/scripts/ab-report.mjs` into `lib/report.mjs` as the
**single** report implementation. The pack's `report` route calls it; the `graphify-ab`
skill is **consolidated onto it** (thin wrapper that imports the same module, or
retired). Report logic is never forked. `report.mjs` is node-safe (pure data → HTML
string) so it is unit-testable and reused by both the route and the skill.

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

`ExperimentDef.dashboard` is a `DashboardSpec`. `setDashboard` rewrites it; the panel
re-renders from **stored outcomes** (`outcome/*`, `agg/*`) — no re-spawn, no redeploy.
Adding/selecting a metric (§7.2) + binding a widget to it is the no-code extensibility
proof. The dashboard panel and the `report` route both render from the **same** widget
registry + spec, so the live dashboard and the generated report agree.

---

## 11. Extension seams (documented stable contracts)

| Seam | Where | Stability contract |
|---|---|---|
| `host.agents.spawnGoal` | core/host | Versioned via `capabilities.has("spawnGoal")`; additive opts only. |
| `MetricExtractor` + `registerMetric` | `lib/metrics.mjs` | Pure `extract(raw, ctx)`; new metric = registration. |
| User-metric channel | `metadata.experiment.userMetrics` / command metric channel | No-code novel metrics. |
| `WidgetRenderer` + `registerWidget` | `lib/widgets.mjs` | Pure `render(spec, data)`; new chart = registration. |
| `DashboardSpec` | store `exp/<id>.dashboard` | Declarative, editable, versioned. |
| `RunnableSpec` | store `exp/<id>.runnable` | `agent` | `command` discriminant; generic path. |
| Results registry keys | `lib/store-keys.mjs` | Append/last-write-wins; null-tombstone deletes. |

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
- `widgets.mjs` + `report.mjs`: built-in widget render from a spec + data;
  **newly-registered widget type is used** by a dashboard spec; report HTML golden.
- `engine.mjs`: run-config mapping (variant×repeat → spawnGoal args; candidate →
  spawnGoal args); outcome parsing from mocked REST payloads.
- **Guardrail enforcement:** `defineExperiment` validation refuses AR uncapped /
  no-objective / no-stop; A/B requires repeats ≥ 1.

### API E2E (`tests/e2e/`, in-process harness — drive `routes.mjs` via `ModuleHost.invoke`)

Mirror `tests/e2e/host-agents.spec.ts` (build a live `ServerHostApi` with the
`spawnChildGoal` seam + a mock/canned arm goal):

- **(a) A/B:** a 2-variant × 2-repeat experiment fans out via `spawnGoal`, each arm's
  child goal carries **distinct arm metadata verified to reach the arm's sub-tree**
  (`resolveGoalMetadata` on a descendant returns the merged treatment); `collect` reads
  costs/gates/tasks (mocked REST), `aggregate` writes the registry.
- **(b) Autoresearch on a stub objective** (deterministic metric generator, **no real
  compute**): `iterate` keeps best, appends ledger, stops on plateau/cap; ledger grows;
  best-objective-vs-iteration is monotone non-decreasing for accepts.
- `spawnGoal` authorization: a non-owner `parentGoalId` is rejected; a child session
  cannot `spawnGoal` (no grandchildren) — reuse `assertCanSpawn`.

### Browser E2E (`tests/e2e/ui/experiment-runner.spec.ts`)

- Panel **defaults to A/B**; switching to autoresearch **requires caps + confirmation**
  before launch is enabled.
- Define both modes, see runs spawn, dashboard renders from outcomes.
- **Edit the dashboard spec → re-renders** without re-run; **persists across reload**
  (rehydrate from `getExperiment`/store).
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
