# Performance Optimisation

Opt-in first-party Extension Host pack for autonomous performance discovery and optimisation.

## Surfaces

- `/performance` and the session menu open the singleton control pane.
- `performance-optimisation` is the reload-safe structured route; the panel uses `host.ui.navigate`, never hashes or raw URLs.
- Tabs are **Flow map**, **Scan coverage**, **Hypothesis registry**, and **Benchmark store**.
- The panel first loads performance-owned coverage, hypotheses, activity, measurements, outcomes, staff IDs, and goal links from the pack's `performance-snapshot` route.
- It then uses `host.project.readStaff/readSessions/readGoals/readGoalTasks/readGoalGates/readGoalPullRequest` to fetch only correlated Host records. Exact-ID lookups are preferred; bounded pagination is used only for staff-role discovery, related delegate sessions, and children of a known goal. Only the selected tab remains in the implicit `host.store` as a UI preference.
- Session links use `host.ui.openPanel({ panelId, sessionId })` when the live project or stored snapshot supplies a real session id.
- The Scanner avatar is built from Bobbit's canonical `BODY_GRID` and `EYE_POSITIONS` data.

The normal panel starts honestly empty. For layout development only, open the contributed route with structured params `{ tab: "flow", demo: "true" }`; the panel labels this state **Development fixture · not live project data**.

## Persistence and pack projection contract

The pack owns `<canonical-project-root>/.performance-optimisation/performance.sqlite` through Pack Local Data. Model-facing tools and the server route use Bobbit's shared `better-sqlite3` runtime dependency. Adjacent `pack.build.json` metadata materializes the eight supported macOS, Linux/glibc, Linux/musl, and Windows x64/arm64 bindings into the pack. Node bundles inline `bobbit:pack-native-assets`, deterministically select the current runtime target from the generated manifest, and never fall back to an ancestor package path. Browser code reads this versioned projection through `host.callRoute("performance-snapshot")`:

```ts
type PerformanceSnapshot = {
  version: 1;
  updatedAt?: string;
  scanner?: {
    state?: "active" | "idle" | "paused";
    activeScans?: number;
    completedLast24h?: number;
    activity?: string;
    lastActivity?: string;
    sessionId?: string;
  };
  registry: Array<{
    id: string;
    title: string;
    status?: string;
    confidence?: number;
    workload?: string;
    summary?: string;
    evidence?: string;
    lastEvidence?: string;
    sessionId?: string;
  }>;
  director?: {
    state?: "active" | "idle" | "paused";
    activeAgents?: number;
    detail?: string;
    sessions: Array<{ id: string; label: string; detail?: string; sessionId?: string }>;
  };
  goals: Array<{ id: string; label: string; detail?: string; sessionId?: string }>;
  pullRequests: Array<{ id: string; label: string; detail?: string; sessionId?: string }>;
  activity: Array<{
    id: string;
    at?: string;
    kind?: "info" | "success" | "warning" | "error";
    actor: string;
    message: string;
    tab?: "flow" | "coverage" | "registry";
    sessionId?: string;
  }>;
  coverage: CoverageNode[];
};

type CoverageNode = {
  id: string;
  label: string;
  kind?: string;
  state?: "scanned" | "stale" | "awaiting";
  covered?: number;
  total?: number;
  lastScan?: string;
  detail?: string;
  children: CoverageNode[];
};
```

The activity UI sorts newest first and retains at most 50 rows.

## Roles and staff

The pack ships two real marketplace roles:

- `performance-scanner` — read-only evidence discovery.
- `optimisation-director` — evidence-led planning and coordination.

The pack also ships the ephemeral read-only `performance-ideator` role. After enabling the pack, run `/install-performance-optimisation`; the skill resolves its gateway-issued session to the authoritative project, asks for schedules and concurrency, initializes coverage, discovers existing project benchmark commands with documented measurement contracts, idempotently syncs their references, then adopts or creates the two persistent staff through `bobbit_read` and `bobbit_orchestrate(create_staff)`. Ambiguous benchmark candidates are reported and skipped rather than guessed or executed. Rerun the skill after project benchmarks change. Ideators remain temporary. The persistent Director itself claims hypotheses and creates their goals through `bobbit_orchestrate(create_goal)`; it never delegates goal creation or emits proposal drafts.

## Development loop

Run the normal harness, then in another terminal:

```bash
npm run dev:pack -- performance-optimisation
```

The watcher rebuilds the declared panel and Node entries, rematerializes `pack.build.json` native families, mirrors all declared outputs into the gateway's existing built-in serving copy, and emits a Vite custom HMR event. The client reuses the real marketplace reconciliation path to invalidate and remount the open panel without a gateway restart or full browser reload.

For a copy-installed pack, pass its serving root:

```bash
npm run dev:pack -- performance-optimisation --target <scope>/.bobbit/config/market-packs/performance-optimisation
```

## Current boundaries

- Project notifications trigger coalesced route-first rereads. Lookup outcomes and per-goal detail failures preserve valid pack data rather than manufacturing empty results.
- Goal correlation uses existing namespaced metadata and an SQLite `hypothesisId → goalId` link; browser metadata projection is unnecessary.
- Explore Hypothesis is passed as a frozen `workflow` snapshot in the direct `create_goal` body because marketplace workflow declarations are catalogue-only today.
- Direct goal creation is transactionally claimed in the registry and correlated by namespaced metadata before retry, preventing duplicate goals after interrupted Director turns.
- Benchmarks and behavioural tests remain existing project-owned commands.
- Goal teams start automatically, while PR merging remains outside Director authority.
