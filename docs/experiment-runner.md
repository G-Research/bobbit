# Experiment Runner Extension Guide

The **Experiment Runner** is a first-party, decoupled Bobbit extension packaged as a **market pack** (`market-packs/experiment-runner/`). It turns core primitives (nested runs, the hierarchical goal metadata layer, inline roles, gates, and verification) into a data-driven experimentation and autonomous-optimization system.

This guide details the architecture, execution modes, stable contracts, results registry database schema, and extension points of the Experiment Runner for future engineers and pack authors.

---

## 1. High-Level Architecture & Flow

The Experiment Runner consists of a **frontend UI panel**, a **confined worker route module**, a **results registry (store)**, and **one core/host extension API**: `host.agents.spawnGoal`.

```
  [ UI Panel ] ────────────────────────────────────┐
       │ (gestures: define / launch / iterate)     │
       ▼                                           ▼
  [ Confined Worker (Routes) ] ──────────► [ results registry (store) ]
       │                                           ▲
       ├─► spawnGoal(...)                          │ (collected run records)
       │     │                                     │
       │     ▼ (server-side)                       │
       │   [ Child Goal ]                          │
       │     │ (workflow terminal)                 │
       │     ▼                                     │
       └──► outcome collector ─────────────────────┘
```

### High-Level Flow:
1. **Define**: An agent or user configures an experiment via the panel or routes (`defineExperiment`). The setup is validated, a cost projection is calculated, and the definition is persisted.
2. **Launch / Iterate**:
   - In **A/B mode**, variants are fanned out concurrently as child goals of the experiment goal.
   - In **Autoresearch mode**, a candidate is generated based on the ledger, and evaluated in a single step-by-step iteration.
3. **Poll**: The engine monitors active child goals until they reach a terminal state.
4. **Collect**: Once settled, the engine retrieves the run's outcomes (cost, gates, tasks, user metrics) via REST API, extracts the configured metrics, and populates the `RunRecord` in the store.
5. **Aggregate / Report**: The reporting library projections read the store, calculate medians/spreads (A/B) or objective curves (Autoresearch), and render a spec-driven dashboard.

---

## 2. The Core / Host Seam: `host.agents.spawnGoal`

Because standard `host.agents` child sessions are locked into the parent goal's worktree and metadata, a dedicated capability is required to launch distinct, isolated goal runs carrying customized Treatments.

The `host.agents.spawnGoal` seam is defined in `src/server/agent/experiment-spawn-goal.ts` and exposed to the extension host.

### 2.1 API Specification
```typescript
spawnGoal(opts: {
  title: string;
  spec: string;
  runKey: string;
  parentGoalId?: string;
  metadata?: Record<string, unknown>;
  inlineRoles?: Record<string, Role>;
  workflowId?: string;
  workflow?: Workflow;
}): Promise<{ goalId: string }>;
```

#### Option Mappings and Internal Lifecycles:
*   **`parentGoalId` (Assertion Only)**: Derived automatically from the owner session's effective goal (`goalId ?? teamGoalId`). If a caller-supplied `parentGoalId` is provided, it is verified, and any mismatch throws a `PARENT_MISMATCH` error. This guarantees a pack cannot spawn a goal outside of its lineage.
*   **Project & Sandbox Inheritance**: The child goal inherits `projectId` and `sandboxed` directly from its derived parent goal. It is strictly bound to the same workspace scope.
*   **Idempotency & Concurrent Reservation**:
    To prevent duplicate spawns under concurrent calls (TOCTOU race conditions), the host maintains a module-level `inFlightSpawns` map. A reservation key (`parentGoalId\0runKey`) collapses concurrent requests onto a single creation promise. Sequential re-calls check sibling goals for an existing `spawnedFromPlanId === runKey` and return it.
*   **Capacity-Blocked Queueing**:
    When a child is spawned, the start request flows through `verificationHarness.requestChildStart`. If the root's `maxConcurrentChildren` limit is reached, the scheduler parks the child goal, marking it `state: "blocked"`, and queues its worktree setup and team execution until a permit is freed.
*   **Uniform Metadata & Roles Propagation**:
    The customized `metadata` and `inlineRoles` are persisted on the child goal. Thanks to PR #822's hierarchical resolver (`resolveGoalMetadata`), this treatment merges uniformly and propagates to every descendant session, delegate, subgoal, and workspace sandbox in the child's subtree—eliminating execution asymmetries.

---

## 3. Two Engine Modes & Safety Contract

The Experiment Runner operates with a **strict separation of concerns** between its safe/bounded default mode and its opt-in/constrained optimizer mode.

```
                  ┌────────────────────────────────────────┐
                  │          EXPERIMENT RUNNER             │
                  └───────────────────┬────────────────────┘
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼ (Default)                                         ▼ (Opt-In)
    ┌───────────────┐                                   ┌───────────────────────┐
    │   A/B MODE    │                                   │  AUTORESEARCH MODE    │
    └───────┬───────┘                                   └───────────┬───────────┘
            │                                                       │
            ├─► Bounded Cost Projection                             ├─► Guardrails Required
            ├─► Parallel Variant Fan-out                            ├─► Fixed Per-Run Budget
            └─► Same-Completion-Bar Filtering                       └─► Deterministic Loop Decisions
```

### 3.1 A/B Comparison (Default)
Designed as a safe, bounded, multi-arm comparison.
*   **Cost Projections**: Calculated pre-launch via `projectCost` based on `variants.length * repeats * runnable.estCostUsd`. There is no self-modification or feedback loop; costs are bounded and projectable from the start.
*   **Concurrency Throttling**: Concurrency limits (`def.maxConcurrency`) are enforced by the orchestration layer in framework space. Runs beyond the cap remain `pending` and are top-up fanned out as earlier runs settle.
*   **Same-Completion-Bar Filtering**: To keep statistical evaluations fair, runs are filtered by their workflow gate completion status (`completionBar === 'passed'` by default). Incomplete or failed runs are excluded from aggregate averages and presented separately.

### 3.2 Autoresearch / Optimization Loop (Opt-In)
An autonomous optimization loop that proposes, evaluates, and adopts configurations based on empirical objectives.
*   **Mandatory Guardrails**:
    To prevent run-away costs, an autoresearch experiment **will refuse to define or run** unless:
    1.  At least one hard cap is finite: `maxIterations`, `maxWallClockMs`, or `maxCostUsd`.
    2.  At least one stop condition is defined: `plateauK` (iterations without improvement) or `target` (absolute objective value reached).
*   **Per-Run Budget (`perRunBudget`) Enforcement**:
    Rather than adding invasive core-level limits, the per-run budget is enforced by the pack in framework space. Active costs are monitored during polling. If an arm exceeds `perRunBudget`, it is marked as `failed` / `over_budget`. It is immediately discarded and excluded from the optimization selection.
*   **Deterministic Loop Decision (Correctness Gate)**:
    The loop's accept/reject logic is deterministic. The LLM only proposes candidates; the framework decides adoption. A candidate is accepted **iff**:
    1.  Its objective value strictly improves on the best-so-far (direction-aware, by more than `plateauEps`).
    2.  It passes the **correctness gate** (`verified === true` and `completionBar === 'passed'`). If a candidate violates verification, it is rejected even if its objective score improved.
*   **Ledger Persistence**: All iterations, treatments, objective values, decisions, and outcomes are appended to a persistent ledger (`exp/<id>/ledger`), which is fed forward to seed the next iteration.

---

## 4. Results Registry Schema (`store-keys.mjs`)

All experiment records reside in the pack-scoped `host.store` and follow a strict, unified naming convention:

| Store Key | Value Type | Purpose |
|---|---|---|
| `exp/<experimentId>` | `ExperimentDef` | Static experiment configuration, mode, runnable spec, and parameters. |
| `exp/<experimentId>/state` | `ExperimentState` | Live status (e.g., `running`, `done`), iteration index, and stop annotations. |
| `exp/<experimentId>/run/<runId>` | `RunRecord` | Combines raw outcome source data, extracted metrics, completion bars, cost, and timestamps. |
| `exp/<experimentId>/ledger` | `LedgerEntry[]` | Append-only record of candidates, decisions, objective metrics, and transition reasons. |
| `exp/<experimentId>/metrics` | `MetricSelection[]` | User-defined metric choices, aggregation modes, and direction overrides. |
| `exp/<experimentId>/dashboard` | `DashboardSpec` | User-defined widget configurations and bindings. |
| `index/experiments` | `string[]` | Index of registered experiment IDs. |

### Architectural Decision: Consolidated `RunRecord`
Raw outcome sources (`session-costs.json`, `gates.json`, `tasks.json`) are retrieved from the completed child goal via REST API endpoints keyed by `childGoalId`. They are saved on the `RunRecord.rawOutcome` alongside the already-extracted metrics (`RunRecord.metrics`).
*   **Single Source of Truth**: Aggregations, best-so-far series, and comparative metrics are **computed dynamically on read** from these records. There are no redundant `outcome/*` or `agg/*` store keys, avoiding caching discrepancies.
*   **Zero-Re-Run Recalculations**: Storing the raw outcome allows users to edit metrics (`saveMetrics`) or update dashboard widgets (`saveDashboard`) to trigger a re-extraction and re-render of all past runs **without needing to re-execute any goal runs**.

---

## 5. Stable Extension Contracts (The Seams)

The Experiment Runner provides decoupled, registration-based extension points. Adding a visual element or a performance metric is a registration, never a refactor.

### 5.1 Metric-Extractor Registry (`lib/metrics.mjs`)
Defines how numeric values are parsed from raw child goal outcomes.

```typescript
interface MetricExtractor {
  id: string;
  label: string;
  direction: "max" | "min";
  unit?: string;
  extract(raw: RawOutcome, ctx: { def: ExperimentDef; run: RunRecord }): number | null;
}
```

#### Canonical Built-In Metrics:
1.  `cost.totalUsd` (min): Sum of session-costs.
2.  `cost.tokensTotal` (min): Total prompt and completion tokens.
3.  `cost.cacheHitRate` (max): Token cache hit rate.
4.  `gates.passRate` (max): Percentage of workflow gates passed.
5.  `gates.firstPassClean` (max): Binary score (1 if all gates passed on the first run).
6.  `tasks.completionRate` (max): Completed vs total tasks.
7.  `time.wallClockMs` (min): Execution duration.
8.  `objective.value` (max): Passthrough for the autoresearch objective value.
9.  `command.metric` (max): Standard metric extracted from shell execution.

#### Pluggable User-Metric Channel:
For ad-hoc metrics that do not require code, arms can save numeric values under `metadata.experiment.userMetrics.<name>`. The registry dynamically resolves `user.<name>` queries by pointing to this sub-key.

---

### 5.2 Widget-Renderer Registry + View-Spec (`src/shared/experiment-report/widgets`)
Controls how data models are turned into HTML visuals in the dashboard and reports.

```typescript
interface WidgetSpec {
  id: string;
  type: string; // Registered widget id
  title?: string;
  bind: {
    metricIds?: string[];
    armIds?: string[];
    objective?: boolean;
  };
  options?: Record<string, unknown>;
}

interface WidgetRenderer {
  type: string;
  render(ctx: { model: ReportModel; spec: WidgetSpec }): string;
}
```

#### Canonical Built-In Widgets:
*   `comparison-table`: Grid comparing arms across all metrics, showing winner highlights and deltas.
*   `score-bars`: Horizontal bar comparisons of relative performance.
*   `objective-curve`: Iteration vs objective plot with accept markers and stop points.
*   `ledger-table`: Tabular history of candidates, metrics, decisions, and reasons.
*   `summary-cards`: Headline KPIs (headline cost, runs, best performing arm/value).
*   `raw-drilldown`: Interactive inspect panel detailing raw JSON results.

#### Theming and CSS Constraints:
To ensure visual consistency between the client panel, the worker reports, and dark/light modes, all widget HTML must use **only Bobbit theme CSS custom properties**. Hardcoded color values are strictly prohibited.
*   **Surfaces/Text**: `var(--background)`, `var(--foreground)`, `var(--card)`, `var(--muted-foreground)`, `var(--border)`.
*   **Visual Series**: `var(--chart-1)` through `var(--chart-6)`.
*   **Semantic Indicators**: `--positive`, `--negative`, `--warning`, `--info`.

---

## 6. Developer Guides: How to Extend

### 6.1 Registering a Custom Metric
Create a file or add a module block inside the pack that invokes `registerMetric`:

```javascript
import { registerMetric } from "./metrics.mjs";

registerMetric({
  id: "quality.testAccuracy",
  label: "Test Suite Accuracy",
  direction: "max",
  unit: "%",
  extract: (raw) => {
    const metrics = raw.userMetrics;
    if (!metrics || typeof metrics.accuracy !== "number") return null;
    return metrics.accuracy;
  }
});
```

### 6.2 Registering a Custom Widget
Register custom visualizers through the shared reporting module:

```javascript
import { registerWidget, card, escapeHtml } from "./experiment-report.mjs";

registerWidget({
  type: "status-grid",
  render({ model, spec }) {
    const list = model.runs.map(r => 
      `<span class="badge" style="border:1px solid var(--border); padding:4px;">` +
      `${escapeHtml(r.runId)}: ${escapeHtml(r.status)}` +
      `</span>`
    ).join(" ");
    return card(spec.title || "Status Grid", `<div style="display:flex; gap:8px;">${list}</div>`);
  }
});
```

### 6.3 Plugging a Non-Bobbit Runnable Command
The Experiment Runner can drive and evaluate raw shell commands alongside standard agents. Set `runnable.kind = "command"` and specify the output parsing:

1.  **Define Runnable**:
    ```json
    {
      "runnable": {
        "kind": "command",
        "command": "python train.py --lr {{lr}}",
        "metricChannel": "loss"
      }
    }
    ```
2.  **Emit Metric**:
    The command execution script must output its metric to stdout as a JSON string matching the experiment schema:
    ```json
    {"experiment": {"userMetrics": {"loss": 0.24}}}
    ```
    Alternatively, save `{ "userMetrics": { "loss": 0.24 } }` to a JSON artifact file.
3.  **Evaluate**:
    The built-in `command.metric` extractor reads the `def.runnable.metricChannel` key (`loss`) and maps it directly onto the `RunRecord.metrics` without requiring a custom parser script.
