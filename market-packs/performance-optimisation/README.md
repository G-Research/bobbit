# Performance Optimisation

Opt-in first-party Extension Host pack for autonomous performance discovery and optimisation.

## Surfaces

- `/performance` and the session menu open the singleton control pane.
- `performance-optimisation` is the reload-safe structured route; the panel uses `host.ui.navigate`, never hashes or raw URLs.
- Tabs are **Flow map**, **Scan coverage**, and **Hypothesis registry**.
- The panel reads bounded live staff, session, goal, gate, task, and cached PR summaries through panel-only `host.project.snapshot()`.
- It merges that core state with performance-owned coverage, hypotheses, activity, and linked-goal ids from `control-pane.snapshot` in the implicit pack-scoped `host.store`; only the selected tab is written at `control-pane.ui`.
- Session links use `host.ui.openPanel({ panelId, sessionId })` when the live project or stored snapshot supplies a real session id.
- The Scanner avatar is built from Bobbit's canonical `BODY_GRID` and `EYE_POSITIONS` data.

The normal panel starts honestly empty. For layout development only, open the contributed route with structured params `{ tab: "flow", demo: "true" }`; the panel labels this state **Development fixture · not live project data**.

## Snapshot contract

A mediated producer will write this versioned record to `control-pane.snapshot`:

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

Marketplace staff templates are not yet supported. Create the two persistent staff records against these role ids after enabling the pack. This is deliberately not emulated with temporary `host.agents` children.

## Development loop

Run the normal harness, then in another terminal:

```bash
npm run dev:pack -- performance-optimisation
```

The watcher rebuilds `src/performance-panel.ts`, mirrors the bundle into the gateway's existing built-in serving copy, and emits a Vite custom HMR event. The client reuses the real marketplace reconciliation path to invalidate and remount the open panel without a gateway restart or full browser reload.

For a copy-installed pack, pass its serving root:

```bash
npm run dev:pack -- performance-optimisation --target <scope>/.bobbit/config/market-packs/performance-optimisation
```

## Platform gaps before autonomous operation

- `host.project.snapshot()` is a bounded one-shot panel read. A revisioned project event subscription is still needed for push updates; the MVP uses the panel Refresh control.
- The Host API cannot structurally navigate to core goal dashboards or PR review surfaces. Pack-owned tabs and real session switching work today.
- Agent-side pack tools cannot yet write the pack-scoped Extension Host store, so the Scanner cannot safely publish coverage/hypotheses without a mediated producer contract.
- Persistent staff provisioning is not pack-expressible yet.

These gaps must be implemented as typed, server-scoped contracts rather than raw `/api` calls, global app-state reads, or hand-built hash routes.
