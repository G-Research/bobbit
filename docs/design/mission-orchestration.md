# Mission Orchestration — Design Document

> Companion to the goal spec (the "Mission orchestration" feature). The spec's
> "Decisions" section is treated as **input** — this document does not relitigate
> them. References below are to spec section names ("Architecture", "Phased
> delivery", "Open questions").

## 1. Overview

A **Mission** is a new top-level entity that sits between a project and its
goals. It holds: (a) a markdown spec of the user's high-level request, (b) a
DAG-shaped plan of child goals, and (c) an integration git branch that
accumulates child goals' merges before a single mission-level PR is raised
against `master`.

A **Commander** agent owns each mission for its full lifecycle: it converts the
spec into a charter, proposes a DAG, schedules child goals in parallel up to a
concurrency cap, merges completed children into the integration branch, and
finally raises the mission PR. Each child goal is a real `PersistedGoal` running
its own workflow and team — the existing goal/team-lead/role machinery is
reused unchanged.

The feature ships in 8 phases (see §14). Each phase is independently usable;
there is no global feature flag.

Spec sections this doc operationalises:

- "Architecture / Data model" → §2 (data model) and §5 (gate-store).
- "Architecture / Commander role" → §9 (role yaml) and §10 (mission tools).
- "Architecture / Mission workflow" → §8 (workflow yaml).
- "Architecture / REST API" → §6.
- "Architecture / WebSocket events" → §7.
- "Architecture / Server modules to add / change" → §3 (new) and §4 (modified).
- "Phased delivery" → §14.
- "Open questions for the implementing team" → §16.

---

## 2. Data model

### 2.1 New types — `src/server/agent/mission-store.ts`

```ts
export type MissionState =
  | "planning"      // pre-goal-plan: charter / plan-review iteration
  | "in-progress"   // goal-plan passed; children spawning/running
  | "paused"        // user paused or autonomy escalation
  | "complete"      // mission-pr passed and PR merged (or marked done)
  | "shelved"       // user-archived without completing
  | "failed";       // unrecoverable; surfaced to user

export type DivergencePolicy = "strict" | "balanced" | "autonomous";

export interface PersistedMission {
  id: string;                          // UUID
  projectId: string;                   // required, single-project v1
  projects: string[];                  // [projectId] — reserved for future cross-project
  title: string;
  spec: string;                        // markdown body — the source request
  state: MissionState;
  createdAt: number;
  updatedAt: number;

  // ── Plan / DAG ──
  plan?: MissionPlan;
  planFrozenAt?: number;               // set once goal-plan gate passes

  // ── Commander session ──
  commanderSessionId?: string;         // long-lived assistant-style session

  // ── Workflow ──
  workflowId: string;                  // always "mission" v1
  workflow?: Workflow;                 // frozen snapshot at creation

  // ── Git ──
  integrationBranch?: string;          // mission/<slug>-<id-prefix>
  integrationWorktree?: string;        // host path; Commander operates here
  baseRef?: string;                    // origin/<master> SHA at creation
  prUrl?: string;

  // ── Policy ──
  divergencePolicy: DivergencePolicy;  // default "strict"
  maxConcurrentGoals: number;          // 1..8, default 3
  sandboxed?: boolean;                 // inherited by children when true
  enabledOptionalSteps?: string[];     // mission-level workflow optional steps

  // ── Lifecycle ──
  archived?: boolean;
  archivedAt?: number;
  pausedAt?: number;
  pausedReason?: string;
}

export interface MissionPlan {
  goals: PlannedGoal[];
  dependencies: PlanEdge[];
  rationale: string;                   // Commander prose
  estimatedConcurrency: number;        // computed peak parallel width
  version: number;                     // bumped on every edit
}

export interface PlannedGoal {
  planId: string;                      // ULID, stable across re-plans
  title: string;
  spec: string;                        // markdown
  workflowId: string;                  // bobbit workflow id, default "feature"
  suggestedRole?: string;
  enabledOptionalSteps?: string[];

  // Filled in once goal is spawned:
  goalId?: string;                     // PersistedGoal.id
  state?: GoalState;                   // mirrored for fast UI
  spawnedAt?: number;
  completedAt?: number;
  mergedAt?: number;                   // set when child branch merged into integration
  failedAttempts?: number;             // for transient-retry bookkeeping
}

export interface PlanEdge {
  from: string;                        // upstream planId
  to: string;                          // dependent planId
}
```

**ULIDs vs UUIDs.** `planId` uses ULID (lexicographically sortable, stable across
plan edits) so the UI can render plans deterministically. The codebase already
has `randomUUID`; ship a tiny ULID helper alongside `mission-store.ts` rather
than adding a dependency. Goals and missions keep UUIDs (existing pattern).

### 2.2 `PersistedGoal` extensions — `goal-store.ts`

```ts
interface PersistedGoal {
  // ... existing fields ...
  missionId?: string;          // null/undefined for standalone goals
  missionPlanId?: string;      // PlannedGoal.planId in the owning mission's plan
}
```

Both fields are optional and additive. Existing goals load with both undefined.

### 2.3 Storage paths

| Artifact            | Path                                                |
|---------------------|-----------------------------------------------------|
| Mission records     | `<project>/.bobbit/state/missions.json`             |
| Goals               | `<project>/.bobbit/state/goals.json` (unchanged)    |
| Gates (both kinds)  | `<project>/.bobbit/state/gates.json` (extended; see §5) |
| Integration worktree| `<repo>-wt/mission-<slug>-<id8>/` (managed worktree)|

Mission records are bounded — typical size is a few KB; even a 20-goal plan with
1 KB specs each fits well under 100 KB.

### 2.4 Migration plan

- **Goals**: zero-break — `missionId`/`missionPlanId` are additive optionals.
  Lazy migration: goals without these fields render as standalone (existing
  behaviour).
- **Gates**: see §5.
- **Missions file**: created on first mission creation; absence is normal.
- **No bulk-import** of existing goals into missions in v1 (explicit non-goal).

---

## 3. New modules — module map

For each new file: path, public API, responsibilities, and dependencies.

### 3.1 `src/server/agent/mission-store.ts`

JSON persistence, mirror of `goal-store.ts`.

```ts
export class MissionStore {
  constructor(stateDir: string);
  put(m: PersistedMission): void;
  get(id: string): PersistedMission | undefined;
  remove(id: string): void;
  getAll(): PersistedMission[];
  getLive(): PersistedMission[];
  getArchived(): PersistedMission[];
  archive(id: string): boolean;
  update(id: string, updates: Partial<Omit<PersistedMission, "id" | "createdAt">>): boolean;
  getGeneration(): number;
  bumpGeneration(): void;

  // Plan-specific helpers (atomic writes):
  setPlan(id: string, plan: MissionPlan): boolean;
  freezePlan(id: string): boolean;     // sets planFrozenAt = Date.now()
  attachGoalToPlanNode(missionId: string, planId: string, goalId: string): boolean;
  updatePlanNodeState(missionId: string, planId: string, patch: Partial<PlannedGoal>): boolean;

  onIndexUpdate?: (m: PersistedMission) => void;
}
```

**Responsibilities:** disk I/O, generation counter, archive flag.
**Depends on:** `node:fs`, `node:path`, type `Workflow` from `workflow-store.ts`.

### 3.2 `src/server/agent/mission-manager.ts`

Lifecycle CRUD analogue of `goal-manager.ts`.

```ts
export class MissionManager {
  constructor(
    store: MissionStore,
    workflowStore: WorkflowStore,
    deps: {
      goalManager: GoalManager;          // for spawning children
      gateStore: GateStore;              // generalised — see §5
      missionGit: MissionGit;            // §3.4
      sandboxManager?: SandboxManager;
      configCascade: ConfigCascade;
      projectId: string;
      projectRootPath: string;
    },
  );

  createMission(input: {
    title: string;
    projectId: string;
    spec: string;
    divergencePolicy?: DivergencePolicy;
    maxConcurrentGoals?: number;
    sandboxed?: boolean;
    enabledOptionalSteps?: string[];
  }): Promise<PersistedMission>;

  archiveMission(id: string): Promise<boolean>;
  pauseMission(id: string, reason: string): Promise<boolean>;
  resumeMission(id: string): Promise<boolean>;

  proposePlan(id: string, plan: MissionPlan, opts?: { replanReason?: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  freezePlan(id: string): Promise<boolean>;     // called by goal-plan gate verifier on pass

  spawnChild(missionId: string, planId: string): Promise<PersistedGoal>;   // idempotent
  integrateChild(missionId: string, planId: string): Promise<{ status: "merged" | "conflict"; conflictFiles?: string[] }>;

  listMissions(projectId: string): PersistedMission[];
  getMission(id: string): PersistedMission | undefined;
  getMissionForGoal(goalId: string): PersistedMission | undefined;
}
```

**Responsibilities:**
- Mission lifecycle (create, pause, resume, archive).
- Plan validation (DAG acyclic, every node reachable, deps within plan).
- Authorisation gates: `proposePlan` rejects when `planFrozenAt` is set unless
  the mission is `paused` AND `replanReason` is provided.
- Spawning a child: builds `PersistedGoal` with `missionId`, `missionPlanId`,
  and `baseBranch=mission.integrationBranch` (passed through to `goal-manager`).
- Integration: orchestrates `MissionGit.mergeChild`, updates plan node state.

**Depends on:** `MissionStore`, `GoalManager`, `MissionGit`, `WorkflowStore`,
`ConfigCascade`, `GateStore` (for init).

### 3.3 `src/server/agent/mission-scheduler.ts`

Event-driven scheduler. See §11 for algorithm.

```ts
export class MissionScheduler {
  constructor(deps: {
    missionStore: MissionStore;
    missionManager: MissionManager;
    goalStore: GoalStore;
    gateStore: GateStore;
    workflowStore: WorkflowStore;
    broadcast: (msg: WsMessage) => void;
    log: Logger;
  });

  /** Wire up event sources. Idempotent. */
  start(): void;
  stop(): void;

  /** Tick a single mission — public for tests. Idempotent under concurrent calls. */
  tickMission(missionId: string): Promise<void>;

  /** Periodic safety-net tick across all live missions (default 60s). */
  tickAll(): Promise<void>;
}
```

**Responsibilities:**
- Subscribe to: gate-status changes, goal state changes, mission state changes,
  mission resume.
- Compute ready set per mission and spawn up to
  `maxConcurrentGoals - inFlight`.
- Drive `mergeChild` when a child's `ready-to-merge` gate passes.
- Drive mission gate signals (`execution`, `integration`, `mission-pr`) when
  preconditions are met.
- Per-mission async lock (`Map<missionId, Promise<void>>`) prevents concurrent
  ticks for the same mission.

**Depends on:** `MissionStore`, `MissionManager`, `GoalStore`, `GateStore`,
broadcast helper.

### 3.4 `src/server/agent/mission-git.ts`

All git operations specific to missions.

```ts
export class MissionGit {
  constructor(deps: { repoPath: string });

  /** Create integration worktree branched off origin/<master>. Returns absolute path + SHA. */
  createIntegrationBranch(missionId: string, slug: string): Promise<{
    branch: string;
    worktreePath: string;
    baseSha: string;
  }>;

  /** Resolve the start-point for a child goal (HEAD of integration branch right now). */
  childStartPoint(integrationBranch: string): Promise<string>;

  /**
   * Merge a child goal's branch into the integration branch.
   * Runs in the integration worktree. Non-fast-forward (--no-ff) so each goal
   * is a discrete merge commit.
   */
  mergeChild(integrationBranch: string, childBranch: string, missionTitle: string, planTitle: string): Promise<
    | { status: "merged"; mergeSha: string }
    | { status: "conflict"; conflictFiles: string[] }
    | { status: "already-merged" }
  >;

  /** Abort an in-progress merge with conflicts, returning the worktree to clean state. */
  abortMerge(integrationBranch: string): Promise<void>;

  /** Pull origin/<master> into the integration branch. Conflicts return non-zero result. */
  forwardMergeMaster(integrationBranch: string, masterRef: string): Promise<{ status: "merged" | "conflict" | "up-to-date" }>;

  /** Push integration branch to origin (gated by shouldSkipRemotePush()). */
  pushIntegration(integrationBranch: string): Promise<void>;
}
```

**Depends on:** `src/server/skills/git.ts` helpers (`createWorktree` already
accepts `startPoint`; `shouldSkipRemotePush`; `detectPrimaryBranch`).

### 3.5 Mission tools — `defaults/tools/mission/`

Files: `extension.ts`, plus one YAML per tool. See §10 for details.

- `mission_plan_propose.yaml`
- `mission_goal_spawn.yaml`
- `mission_merge_child.yaml`
- `mission_goal_status.yaml`
- `mission_status.yaml`
- `mission_signal.yaml` (thin alias for gate_signal scoped to mission gates)
- `extension.ts` — tool registration mirroring `defaults/tools/team/extension.ts`
  (gateway URL + token discovery, REST helpers).

### 3.6 Commander role — `defaults/roles/commander.yaml`

See §9 for the full skeleton.

### 3.7 Mission workflow — `defaults/workflows/mission.yaml`

See §8 for the full content.

### 3.8 UI modules

- `src/app/mission-dashboard.ts` — analogue of `goal-dashboard.ts`. Public:
  ```ts
  export async function loadMissionDashboard(missionId: string): Promise<void>;
  export function clearMissionDashboardState(): void;
  export async function refreshMissionDashboard(): Promise<void>;
  ```
- `src/app/components/MissionDagSvg.ts` — pure render component, no state.
- `src/app/dialogs.ts` — add `showMissionDialog()` (extends existing dialog).

---

## 4. Modified modules

For each, the change set, API impact, and migration concerns.

### 4.1 `src/server/agent/goal-store.ts`

- **Change:** add `missionId?: string` and `missionPlanId?: string` to
  `PersistedGoal`.
- **API impact:** additive. No callers break.
- **Migration:** zero-touch — fields are optional.

### 4.2 `src/server/agent/goal-manager.ts`

- **Change:** `createGoal` accepts new `opts.missionId`, `opts.missionPlanId`,
  and `opts.baseBranch` (default `origin/<master>`; missions pass their
  integration branch). Pipe these through to the worktree creation
  (`createWorktree(repoPath, branch, { startPoint: baseBranch })`).
- **API impact:** additive — all existing callers unchanged.
- **Migration:** none.

### 4.3 `src/server/agent/gate-store.ts`

See §5.

### 4.4 `src/server/agent/verification-harness.ts`

- **Change:** every method that takes `goalId` gains an `ownerKind: "goal" |
  "mission"` parameter (default `"goal"`). Internal lookups switch from
  `goalStore.get(goalId)` to a resolver:
  ```ts
  type Owner =
    | { kind: "goal"; goal: PersistedGoal }
    | { kind: "mission"; mission: PersistedMission };
  ```
  When the owner is a mission, `cwd` is the integration worktree, `branch` is
  the integration branch, `spec` is the mission spec, `workflow` is the mission
  workflow.
- **API impact:** additive parameter with default — backward-compatible. All
  existing call sites that pass `goalId` continue working.
- **Migration:** none.

### 4.5 `src/server/agent/verification-logic.ts`

- **Change:** add new template substitutions in `substituteVars`:
  - `{{mission_id}}` → owner mission's id
  - `{{integration_branch}}` → mission's integration branch
  - `{{mission_branch}}` → alias for integration_branch (less-typo-prone)
  - When owner is a mission: `{{branch}}` resolves to the integration branch
    (so existing `git diff origin/{{master}}...{{branch}}` substitutions in
    review prompts work without change).
- **API impact:** additive.
- **Migration:** none.

### 4.6 `src/server/server.ts`

- **Change:** mount mission REST routes (§6); broadcast new WS events (§7);
  `getGoalManagerForGoal` gains a sibling `getMissionManagerForMission`. New
  helper `resolveOwner(req)` so existing gate routes can receive
  `?ownerKind=mission&ownerId=<missionId>` query params.
- **API impact:** existing `/api/goals/...` routes unchanged (default
  `ownerKind=goal`). New routes are additive.
- **Migration:** none.

### 4.7 `src/server/agent/project-context.ts`

- **Change:** instantiate `MissionStore`, `MissionManager`, `MissionGit`,
  `MissionScheduler` alongside existing stores. Wire `missionStore.onIndexUpdate`
  into `searchIndex.indexMission(...)` (a new IndexSource — phase 8 stretch).
- **API impact:** additive.
- **Migration:** none.

### 4.8 `src/server/agent/project-context-manager.ts`

- **Change:** mission lookups across all projects (`getMissionById(id)`),
  surface missions in sidebar payload, orphan-filter archived missions in
  `searchAll()`.
- **API impact:** additive.

### 4.9 `src/app/routing.ts`

- **Change:** add `mission-dashboard` route view; regex
  `/^#\/mission\/([a-f0-9-]+)$/i`. Add `view: "mission-dashboard"` and
  `missionId?: string` to the `RouteView` union and `getRouteFromHash` return
  type. Extend `setHashRoute` with the same.
- **API impact:** additive. Existing routes unchanged.

### 4.10 `src/app/main.ts`

- **Change:** route handler dispatches `mission-dashboard` view to
  `loadMissionDashboard(missionId)`.
- **API impact:** none.

### 4.11 `src/app/sidebar.ts`, `src/app/render-helpers.ts`

- **Change:** in each project section render a `Missions` subgroup directly
  above the existing `Goals` subgroup when the project has any live mission.
  Reuse `renderGoalGroup` logic but with mission-row chrome (flag icon,
  state pill, deeper indent for child goals).
- **API impact:** additive helper `renderMissionGroup(mission)` exported from
  `render-helpers.ts`.

### 4.12 `src/app/goal-dashboard.ts`

- **Change:** when a goal has `missionId`, render a "← back to mission"
  breadcrumb in the nav bar; surface mission gates (read-only) in a collapsible
  panel.
- **API impact:** none (UI-only).

### 4.13 `src/app/state.ts`

- **Change:** add `missions: PersistedMission[]` to client state, plus
  `missionGenerations: Map<string, number>` for change detection. Refresh
  wiring follows the existing goals pattern.

### 4.14 `src/server/agent/system-prompt.ts`

- **Change:**
  1. Add a Commander preamble template (loaded when role is `commander`) —
     phase-aware (planning vs execution vs integration), bounded-autonomy
     rules, mission gate flow.
  2. When a goal has `missionId`, prepend a stanza to its team-lead prompt:
     "This goal is part of mission `<title>` (`<id>`). The mission integration
     branch is `<branch>`. **Do NOT raise a PR to master.** Push your goal
     branch to origin and signal `ready-to-merge` — the Commander will merge
     your branch into the integration branch. Only the mission PR goes to
     master."
- **API impact:** additive context only.

---

## 5. Gate-store generalisation

### 5.1 Goal — single store, two owner kinds

Today: `GateState.goalId: string` and a composite key `${goalId}::${gateId}`.
Tomorrow: `ownerKind: "goal" | "mission"` and key
`${ownerKind}:${ownerId}::${gateId}`.

### 5.2 Type changes

```ts
export type GateOwnerKind = "goal" | "mission";

export interface GateState {
  gateId: string;
  ownerKind: GateOwnerKind;
  ownerId: string;
  /** @deprecated kept for backward-compat reads only; equals ownerId when ownerKind === "goal" */
  goalId: string;
  status: GateStatus;
  // ... existing fields unchanged ...
}

export interface GateSignal {
  id: string;
  gateId: string;
  ownerKind: GateOwnerKind;
  ownerId: string;
  goalId: string;            // deprecated alias, populated when kind=goal
  // ... rest unchanged ...
}
```

### 5.3 Function signatures

All current `goalId`-keyed methods gain an overload accepting `(ownerKind,
ownerId)`. Existing single-arg `goalId` overloads keep working and forward to
`("goal", goalId)`:

```ts
class GateStore {
  // Existing — unchanged signatures still work:
  initGatesForGoal(goalId: string, gateIds: string[]): void;
  getGate(goalId: string, gateId: string): GateState | undefined;
  getGatesForGoal(goalId: string): GateState[];
  removeGoalGates(goalId: string): void;

  // New parallel API:
  initGatesFor(kind: GateOwnerKind, ownerId: string, gateIds: string[]): void;
  getGateFor(kind: GateOwnerKind, ownerId: string, gateId: string): GateState | undefined;
  getGatesFor(kind: GateOwnerKind, ownerId: string): GateState[];
  updateGateStatusFor(kind: GateOwnerKind, ownerId: string, gateId: string, status: GateStatus): void;
  // ... etc.

  // Internal: composite key now includes kind.
}
```

The "old" methods are thin wrappers that delegate to the new ones with
`kind="goal"`.

### 5.4 Disk layout & lazy migration

`gates.json` is a flat array. Migration:

1. **On load**, every record without `ownerKind` is assigned
   `ownerKind="goal"`, `ownerId = record.goalId`.
2. **On save**, the new fields are written. Old code paths reading the file
   with the legacy schema still see `goalId` populated (the `goalId` field is
   retained as an alias for `ownerKind="goal"` records). Mission records are
   written with `ownerKind="mission"`, `goalId` set to the same value as
   `ownerId` for forward compatibility (cheap, harmless duplication).
3. **No file rewrite** is forced; entries upgrade lazily on next mutation.

### 5.5 Verification harness

`verification-harness.ts` resolves owner once at signal time:

```ts
function resolveOwner(kind: GateOwnerKind, id: string): {
  cwd: string;
  branch: string;
  spec: string;
  workflow: Workflow;
  projectId: string;
} { ... }
```

Built-in vars (`{{branch}}`, `{{master}}`, `{{goal_spec}}`,
`{{integration_branch}}`, `{{mission_id}}`) all derive from this resolver. The
existing per-goal pre-implementation-gate semantics (no diff) extend naturally
to mission gates: pre-`execution` gates (charter, plan-review, goal-plan)
don't diff; `execution` and downstream gates diff against `origin/<master>...
<integration_branch>`.

---

## 6. REST API

All routes return JSON. Auth via the existing bearer-token middleware. All
routes that mutate or read mission state require a valid `projectId` resolution
(same contract as `/api/goals`). Routes:

### 6.1 Mission CRUD

| Method | Path                         | Description                                           |
|--------|------------------------------|-------------------------------------------------------|
| POST   | `/api/missions`              | Create mission + spawn Commander session.             |
| GET    | `/api/missions`              | List missions (filter `?projectId=`).                 |
| GET    | `/api/missions/:id`          | Mission detail (mission + plan + child goals + gates).|
| PUT    | `/api/missions/:id`          | Update mutable fields.                                |
| DELETE | `/api/missions/:id`          | Archive mission. Children stay (orphaned standalone). |

**POST /api/missions — request:**
```json
{
  "projectId": "<uuid>",
  "title": "Build unified-memory system",
  "spec": "<markdown>",
  "divergencePolicy": "strict",        // optional, default "strict"
  "maxConcurrentGoals": 3,             // optional, default 3, max 8
  "sandboxed": false,                  // optional
  "enabledOptionalSteps": ["..."]      // optional
}
```

**POST /api/missions — response (201):** full `PersistedMission` with
`commanderSessionId` populated. Side-effects: integration branch + worktree
created, Commander session spawned (assistant-style, no team), gate states
initialised, `mission_created` WS broadcast.

**Errors:**
- 400 `{error: "Missing title"}` / `"Missing projectId"`.
- 400 if project not registered.
- 500 if integration worktree creation fails (mission still persisted in
  `failed` state with `setupError`).

**GET /api/missions/:id — response:**
```json
{
  "mission": <PersistedMission>,
  "plan": <MissionPlan | null>,
  "children": [
    { "planId": "...", "goal": <PersistedGoal | null>, "state": "...", "lastGate": "..." }
  ],
  "gates": [<GateStateSummary>],
  "integrationBranch": "mission/...",
  "commanderSessionId": "..."
}
```

### 6.2 Plan management

| Method | Path                                     | Description                                      |
|--------|------------------------------------------|--------------------------------------------------|
| GET    | `/api/missions/:id/plan`                 | Latest plan or 404.                              |
| PATCH  | `/api/missions/:id/plan`                 | Replace plan. 403 if `planFrozenAt` set unless `?force=1` AND `state=planning`. |
| POST   | `/api/missions/:id/plan/freeze`          | Internal — invoked by goal-plan gate verifier.   |

PATCH validates: DAG acyclic (Tarjan), every dependency `from`/`to` references
a `planId` in `goals`, `version` strictly greater than the previous version.

### 6.3 Child goal lifecycle

| Method | Path                                              | Description                                      |
|--------|---------------------------------------------------|--------------------------------------------------|
| POST   | `/api/missions/:id/spawn-child/:planId`           | Idempotent. 409 if `goal-plan` not passed, or deps not complete, or already spawned. |
| POST   | `/api/missions/:id/integrate-child/:planId`       | Merge child branch into integration. Returns merge sha or conflict info. |

**POST /api/missions/:id/spawn-child/:planId — response:**
```json
{ "goalId": "...", "branch": "goal/...-<id8>", "alreadySpawned": false }
```

**Idempotency key:** `(missionId, planId)`. If the plan node already has a
`goalId`, the endpoint returns the existing record with `alreadySpawned: true`
(no new goal created).

### 6.4 Mission control

| Method | Path                                  | Description                              |
|--------|---------------------------------------|------------------------------------------|
| POST   | `/api/missions/:id/pause`             | Body: `{ reason?: string }`. Suspends new spawns. |
| POST   | `/api/missions/:id/resume`            | Resume scheduling. 409 if not paused.    |
| GET    | `/api/missions/:id/git-status`        | Integration branch status (cached).      |
| GET    | `/api/missions/:id/commits`           | Commit history of integration branch.    |

### 6.5 Mission gates

Reuses existing gate machinery via `?ownerKind=mission&ownerId=<id>`:

| Method | Path                                                         |
|--------|--------------------------------------------------------------|
| GET    | `/api/missions/:id/gates`                                    |
| GET    | `/api/missions/:id/gates/:gateId`                            |
| GET    | `/api/missions/:id/gates/:gateId/inspect`                    |
| POST   | `/api/missions/:id/gates/:gateId/signal`                     |
| GET    | `/api/missions/:id/gates/:gateId/signals`                    |
| POST   | `/api/missions/:id/gates/:gateId/cancel-verification`        |
| GET    | `/api/missions/:id/gates/:gateId/content`                    |
| GET    | `/api/missions/:id/workflow-context/:gateId`                 |

These dispatch to the same handlers as `/api/goals/.../gates/...` after
resolving the owner.

### 6.6 Project resolution

`POST /api/missions` follows the existing project-resolution contract — 400 if
no `projectId` (and no `cwd` resolves to a registered project).

---

## 7. WebSocket events

Additive — existing event names are unchanged.

| Event                           | Payload                                                                         |
|---------------------------------|---------------------------------------------------------------------------------|
| `mission_created`               | `{ mission: PersistedMission }`                                                 |
| `mission_updated`               | `{ missionId, patch: Partial<PersistedMission> }`                               |
| `mission_deleted`               | `{ missionId }`                                                                 |
| `mission_plan_proposed`         | `{ missionId, planVersion: number }`                                            |
| `mission_plan_frozen`           | `{ missionId, planVersion: number, frozenAt: number }`                          |
| `mission_child_spawned`         | `{ missionId, planId, goalId }`                                                 |
| `mission_child_state_changed`   | `{ missionId, planId, goalId, state: GoalState }`                               |
| `mission_child_merged`          | `{ missionId, planId, goalId, mergeSha }`                                       |
| `mission_child_merge_conflict`  | `{ missionId, planId, goalId, conflictFiles: string[] }`                        |
| `mission_paused`                | `{ missionId, reason: string }`                                                 |
| `mission_resumed`               | `{ missionId }`                                                                 |
| `mission_setup_complete`        | `{ missionId, integrationBranch, integrationWorktree }`                         |
| `mission_setup_error`           | `{ missionId, error: string }`                                                  |

Existing `gate_*` events fire as today. Their payloads gain `ownerKind` and
`ownerId` fields (additive, defaults to `goal`/`<goalId>` for goal gates) so
clients can route them to mission-dashboard subscribers.

---

## 8. Mission workflow YAML

Path: `defaults/workflows/mission.yaml`.

```yaml
id: mission
name: Mission
description: Multi-goal mission with planning, parallel execution, and integration.

gates:
  - id: charter
    name: Mission Charter
    content: true
    inject_downstream: true
    verify:
      - name: "Charter sanity"
        type: llm-review
        role: spec-auditor
        prompt: |
          Review the mission charter. Verify:
          1. Mission scope is bounded and achievable.
          2. Success criteria are concrete and testable.
          3. Out-of-scope items are explicitly listed.
          4. The source spec (if attached) is summarised faithfully.
          5. The charter does not propose any implementation strategy yet —
             that is the plan-review gate's job.

  - id: plan-review
    name: Plan Review
    depends_on: [charter]
    content: true
    inject_downstream: true
    verify:
      - name: "DAG correctness"
        type: llm-review
        role: architect
        prompt: |
          Review the proposed mission plan (DAG of goals).
          Read the charter via gate_inspect for context.

          1. Every success criterion in the charter is covered by exactly one
             plan node.
          2. Dependencies are necessary (no spurious edges) and sufficient
             (no missing prerequisites).
          3. The DAG is acyclic.
          4. Parallelism opportunities are exploited (no false serialisations).
          5. Each goal's spec is self-contained and implementable.
          6. Suggested workflow per goal is appropriate.
      - name: "Plan completeness"
        type: llm-review
        role: spec-auditor
        prompt: |
          Compare the source mission spec to the plan.
          Identify requirements in the spec not addressed by any plan node.

  - id: goal-plan
    name: Goal Plan Approval
    depends_on: [plan-review]
    content: true
    inject_downstream: true
    # Propose-and-wait: no verify steps. The user must accept in the UI,
    # which signals this gate with the frozen plan as content. The handler
    # also calls MissionStore.freezePlan().

  - id: execution
    name: Execution
    depends_on: [goal-plan]
    verify:
      - name: "All child goals complete and merged"
        type: command
        run: "node {{bobbit_helpers}}/check-mission-execution.mjs {{mission_id}}"

  - id: integration
    name: Integration
    depends_on: [execution]
    verify:
      - name: "Type check on integration branch"
        type: command
        run: "{{project.typecheck_command}}"
      - name: "Unit tests on integration branch"
        type: command
        phase: 1
        run: "{{project.test_unit_command}}"
      - name: "E2E tests on integration branch"
        type: command
        phase: 1
        timeout: 1800
        run: "{{project.test_e2e_command}}"
      - name: "Cross-goal integration review"
        type: llm-review
        role: code-reviewer
        phase: 2
        prompt: |
          The mission integration branch contains the union of all child
          goals' work. Each child goal was reviewed in isolation. Review the
          cross-cutting concerns:
          1. APIs introduced by goal A and consumed by goal B match expectations.
          2. No duplicated implementations across goals.
          3. Shared types/contracts are consistent.
          4. No accidental coupling between independent goals.

          Run `git log --oneline origin/{{master}}..{{integration_branch}}` to
          see the merge history.

  - id: mission-pr
    name: Mission PR
    depends_on: [integration]
    verify:
      - name: "Master merged into integration branch"
        type: command
        run: "git fetch origin {{master}} && git merge-base --is-ancestor origin/{{master}} {{integration_branch}}"
      - name: "Integration branch pushed"
        type: command
        run: "git push origin {{integration_branch}} && git ls-remote --heads origin {{integration_branch}} | grep -q ."
      - name: "PR raised"
        type: command
        run: "gh pr list --head {{integration_branch}} --base {{master}} --state open --json url -q \".[0].url\" | grep -q ."
```

**Helper script — `defaults/helpers/check-mission-execution.mjs`** (new file)
exits 0 iff every plan node has `goalId` set AND each goal's `ready-to-merge`
gate is `passed` AND `mergedAt` is set on the plan node. The helper reads
`<project>/.bobbit/state/missions.json` and `goals.json` directly. The
`{{bobbit_helpers}}` template variable resolves to `defaults/helpers/`.

---

## 9. Commander role

Path: `defaults/roles/commander.yaml`.

```yaml
name: commander
label: Commander
accessory: flag
toolPolicies:
  edit: always-allow
  find: always-allow
  grep: always-allow
  ls: always-allow
  read: always-allow
  write: always-allow
  gate_list: always-allow
  gate_signal: always-allow
  gate_status: always-allow
  gate_inspect: always-allow
  mission_plan_propose: always-allow
  mission_goal_spawn: always-allow
  mission_merge_child: always-allow
  mission_goal_status: always-allow
  mission_status: always-allow
  mission_signal: always-allow
  ask_user_choices: always-allow
promptTemplate: |
  You are the **Commander** (id: {{AGENT_ID}}) running mission "{{MISSION_TITLE}}".

  ## Phase awareness
  Missions move through phases. Read `mission_status` at every wake.
  - `planning` → produce charter, then plan; signal `charter` and `plan-review`.
  - `in-progress` → schedule child goals, monitor, merge completed children.
  - `paused` → wait for user input; do NOT spawn anything.
  - `complete` / `failed` → report and go idle.

  ## Bounded autonomy
  - **Minor**: a child goal failed once on a transient error → retry once.
  - **Moderate**: child failed twice OR repeated review-fail loops → call
    `ask_user_choices` (continue / spawn fix-goal / pause mission).
  - **Major**: any structural plan change (add/remove/split/merge nodes,
    edit deps, change workflow per goal) → pause mission and propose a new
    plan via `mission_plan_propose` with `replan_reason`. Re-signal
    `charter` and `plan-review`. **No exceptions.**

  ## Critical constraints
  - **Never push to master**, **never merge to master**, **never force-push**.
  - Only the mission integration branch (`{{INTEGRATION_BRANCH}}`) raises a PR.
  - Child goals' team-leads will NOT raise their own PRs — you merge their
    branches into the integration branch via `mission_merge_child`.
  - Spawn at most `{{MAX_CONCURRENT_GOALS}}` child goals concurrently.
  - Only spawn nodes whose dependencies have completed.

  ## Workflow
  1. On first turn (state=planning, no plan): read the mission spec, draft a
     charter, signal `charter`. Wait for verification.
  2. After charter passes: produce a plan (DAG of goals), call
     `mission_plan_propose`, then signal `plan-review`. Iterate on review
     feedback.
  3. After plan-review passes: present the plan to the user via the dashboard
     review tab (the UI signals `goal-plan` on user accept). DO NOT
     auto-signal goal-plan — wait for the user.
  4. After goal-plan passes: scheduler auto-spawns ready children. Your
     job becomes monitoring and merging. The system notifies you when a
     child goal's `ready-to-merge` gate passes — call `mission_merge_child`.
     If merge succeeds, the scheduler marks the plan node merged and may
     spawn dependents.
  5. When all children are merged: signal `execution` (verifier confirms),
     then `integration` (full test suite + cross-goal review on the
     integration branch), then `mission-pr` (raise the PR).

  ## Tools (mission-specific)
  - `mission_status()` — full mission summary.
  - `mission_goal_status(planId?)` — child goal states.
  - `mission_plan_propose(plan, replan_reason?)` — write/update plan.
  - `mission_goal_spawn(planId)` — request child spawn (server enforces deps).
  - `mission_merge_child(planId)` — merge child into integration branch.
  - `mission_signal(gate_id, content?, metadata?)` — signal mission gate.

  ## Notification system — DO NOT POLL
  The scheduler wakes you on every relevant event (gate verification result,
  child goal state change, merge result). End your turn after acting.

  {{REVIEW_CONTEXT}}
```

`{{MISSION_TITLE}}`, `{{INTEGRATION_BRANCH}}`, `{{MAX_CONCURRENT_GOALS}}` are
new template variables resolved by `system-prompt.ts` when assembling a
Commander session.

---

## 10. Mission tools

All tools are registered via `defaults/tools/mission/extension.ts` (mirror of
`defaults/tools/team/extension.ts`). Each tool issues a REST call against the
gateway. Tools are gated to Commander role only (via toolPolicies).

### `mission_plan_propose`

Params: `{ plan: MissionPlan, replan_reason?: string }`.
Backend: `PATCH /api/missions/:id/plan`.
Server enforcement:
- Validates DAG.
- If `mission.planFrozenAt` is set: requires `mission.state === "paused"` AND
  `replan_reason` non-empty; cascade-resets `charter` and `plan-review` gates
  via `gate-store.cascadeReset`.
- Bumps `plan.version`.

Errors:
- 400 `Invalid plan: cycle detected at node X`.
- 403 `Plan is frozen — pause mission and provide replan_reason`.

### `mission_goal_spawn`

Params: `{ planId: string }`.
Backend: `POST /api/missions/:id/spawn-child/:planId`.
Server enforcement:
- `goal-plan` gate must be `passed`.
- Plan node's deps (per `MissionPlan.dependencies`) must all have
  `plannedGoal.mergedAt` set.
- Idempotent on `(missionId, planId)`.

Returns: `{ goalId, branch, alreadySpawned }`.

Errors:
- 409 `Plan not approved` / `Dependencies not complete` /
  `Concurrency cap reached (n=3)` (last is informational — Commander should
  back off and rely on scheduler).

### `mission_merge_child`

Params: `{ planId: string }`.
Backend: `POST /api/missions/:id/integrate-child/:planId`.
Server enforcement:
- Child goal's `ready-to-merge` gate must be `passed`.
- Returns merge result (merged / conflict / already-merged).

On `conflict`: returns conflict file list. Commander's runbook:
- moderate-autonomy path → `ask_user_choices` (auto-resolve via bug-fix goal /
  manual / pause).
- If user picks "auto-resolve via bug-fix goal", Commander spawns a `bug-fix`
  child goal *not in the plan* — this is the **only** plan-divergence case
  permitted under moderate autonomy. The bug-fix goal is appended as a leaf
  to the plan with deps={the failing planId}, version-bumped via
  `mission_plan_propose` (with implicit replan_reason="merge-conflict-fix"),
  and the mission auto-pauses for user approval before the bug-fix spawns.
  This keeps the major-rule honest.

### `mission_goal_status`

Params: `{ planId?: string }`.
Backend: `GET /api/missions/:id` (filters server-side).
Returns: array of `{ planId, title, state, gateSummary, lastActivity }`.

### `mission_status`

No params. Backend: `GET /api/missions/:id`.
Returns the full detail object from §6.1.

### `mission_signal`

Thin wrapper over `gate_signal` that hard-codes
`ownerKind=mission&ownerId=<this mission>`. Commander uses this instead of
`gate_signal` to avoid mixing up goal and mission gate ids.

---

## 11. Scheduler algorithm

### 11.1 Triggers

`MissionScheduler.tickMission(missionId)` is called on:

1. WS `gate_passed` / `gate_failed` events from any gate whose owner is this
   mission, OR whose goalId belongs to a child of this mission.
2. WS `goal_state_changed` for child goals (mirroring into plan node state).
3. `mission_resumed`, `mission_plan_frozen` events.
4. Periodic safety net: `setInterval(tickAll, 60_000)`.

### 11.2 Per-mission lock

```
inflight: Map<missionId, Promise<void>> = new Map();
async tickMission(id) {
  const prev = inflight.get(id);
  const next = (async () => { await prev; await doTick(id); })();
  inflight.set(id, next);
  try { await next; } finally {
    if (inflight.get(id) === next) inflight.delete(id);
  }
}
```

### 11.3 Ready-set computation

```
function readySet(mission, plan, goalStore): PlannedGoal[] {
  const result: PlannedGoal[] = [];
  for (const node of plan.goals) {
    if (node.goalId) continue;                    // already spawned
    const deps = plan.dependencies
      .filter(e => e.to === node.planId)
      .map(e => e.from);
    const allDepsMerged = deps.every(d => {
      const dep = plan.goals.find(g => g.planId === d);
      return dep && dep.mergedAt;
    });
    if (allDepsMerged) result.push(node);
  }
  return result;
}
```

### 11.4 Tick body (pseudo-code)

```
async function doTick(missionId) {
  const m = missionStore.get(missionId);
  if (!m || m.archived) return;
  if (m.state === "paused" || m.state === "complete" || m.state === "failed") return;
  if (!m.plan || !m.planFrozenAt) return;        // not yet approved

  // 1. Mirror child goal states into plan nodes.
  for (const node of m.plan.goals) {
    if (!node.goalId) continue;
    const g = goalStore.get(node.goalId);
    if (!g) continue;
    if (g.state !== node.state) {
      missionStore.updatePlanNodeState(missionId, node.planId, { state: g.state });
    }
  }

  // 2. Auto-merge children whose ready-to-merge passed.
  for (const node of m.plan.goals) {
    if (!node.goalId || node.mergedAt) continue;
    const rtm = gateStore.getGateFor("goal", node.goalId, "ready-to-merge");
    if (rtm?.status === "passed") {
      const result = await missionGit.mergeChild(m.integrationBranch!, goalStore.get(node.goalId)!.branch!, m.title, node.title);
      if (result.status === "merged") {
        missionStore.updatePlanNodeState(missionId, node.planId, { mergedAt: Date.now() });
        broadcast({ type: "mission_child_merged", missionId, planId: node.planId, goalId: node.goalId, mergeSha: result.mergeSha });
      } else if (result.status === "conflict") {
        broadcast({ type: "mission_child_merge_conflict", missionId, planId: node.planId, goalId: node.goalId, conflictFiles: result.conflictFiles });
        // Commander will be woken to handle; we do NOT auto-spawn fix goal.
      }
    }
  }

  // 3. Spawn ready nodes up to concurrency cap.
  const inFlight = m.plan.goals.filter(n => n.goalId && !n.mergedAt).length;
  const slots = Math.max(0, m.maxConcurrentGoals - inFlight);
  if (slots > 0) {
    for (const node of readySet(m, m.plan, goalStore).slice(0, slots)) {
      try {
        await missionManager.spawnChild(missionId, node.planId);   // idempotent
      } catch (err) {
        log.warn("[scheduler] spawn failed", { missionId, planId: node.planId, err });
      }
    }
  }

  // 4. Auto-signal mission gates when preconditions met.
  const allMerged = m.plan.goals.every(n => n.mergedAt);
  if (allMerged) {
    const exec = gateStore.getGateFor("mission", missionId, "execution");
    if (exec?.status === "pending") {
      // Commander still owns the actual signaling; we just wake it.
      teamPrompt(m.commanderSessionId, "All children merged. Signal `execution` gate.");
    }
  }
}
```

### 11.5 Idempotency

- Spawn endpoint keyed on `(missionId, planId)` — re-call is a no-op.
- Merge endpoint detects `already-merged` (`git merge-base --is-ancestor`).
- Plan-node state mirroring is set-equal (writes only on diff).

### 11.6 Concurrency bookkeeping

`inFlight = count of nodes with goalId && !mergedAt && !failedTerminally`.
A child counts as in-flight from spawn through merge — i.e. while team agents
are running OR the child is awaiting Commander's merge step.

---

## 12. Branching & merges

### 12.1 Integration branch creation

Run by `MissionGit.createIntegrationBranch` during `POST /api/missions`:

```bash
# In the project's primary repo:
slug=$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//' | cut -c1-30)
branch="mission/${slug}-${MISSION_ID:0:8}"
worktree="${REPO_PATH}-wt/mission-${slug}-${MISSION_ID:0:8}"

git fetch origin master
git worktree add -b "$branch" "$worktree" "origin/master"
# Run worktree_setup_command with SOURCE_REPO env (existing helper).
```

Reuses `createWorktree(repoPath, branch, { startPoint: "origin/master" })` from
`src/server/skills/git.ts`. Push of the integration branch is **deferred until
mission-pr gate** to keep planning private.

### 12.2 Child goal branching

`GoalManager.createGoal` is extended to accept `baseBranch`. For mission
children:

```bash
# Resolve start-point at spawn time (HEAD of integration, at this moment):
startSha=$(git -C "$INTEGRATION_WORKTREE" rev-parse HEAD)
git worktree add -b "$childBranch" "$childWorktree" "$startSha"
```

Pinning to the SHA (not the branch name) prevents a race where the
integration branch advances between `git worktree add` operations for two
parallel children — both children must observe the same parent commit.

### 12.3 Child merge into integration branch

In the integration worktree:

```bash
git fetch origin "$childBranch"      # child team-lead pushed this branch
git merge --no-ff -m "Mission: $missionTitle — merge goal: $planTitle" "origin/$childBranch"
```

Result handling:
- Exit 0 → record `mergeSha` from `git rev-parse HEAD`.
- Conflict → `git diff --name-only --diff-filter=U` collected, then
  `git merge --abort` (so the worktree returns to a clean state). Conflict
  payload is broadcast and Commander is notified. **No auto-resolution.**

### 12.4 Forward-merging master into integration

Periodically (every ~10 min, idempotent) and unconditionally before
`mission-pr` verification:

```bash
git -C "$INTEGRATION_WORKTREE" fetch origin master
git -C "$INTEGRATION_WORKTREE" merge --no-ff -m "Mission: forward-merge master" "origin/master"
```

### 12.5 Mission PR

Final step (mission-pr gate verification or Commander's `gh pr create`):

```bash
git push origin "$integrationBranch"
gh pr create --base master --head "$integrationBranch" --title "Mission: $title" --body "$summary"
```

### 12.6 Open question 1 — managed worktree vs scratch dir

**Decision:** managed worktree. The integration worktree is a real Bobbit
worktree (under `<repo>-wt/mission-...`) so it inherits `worktree_setup_command`
(installs deps for verification scripts), the sandbox config (children's
sandboxed flag matches), and the existing 7-day purge path. Scratch dirs would
require duplicating sandbox bind mounts, dep setup, and cleanup logic.

### 12.7 Open question 2 — conflict resolution path

**Decision:** escalate immediately on first conflict. Auto-spawning a
`bug-fix` mini-goal would require spawning under moderate autonomy AND
modifying the plan (to insert a node), which is structurally a major change.
Commander surfaces the conflict via `ask_user_choices` ("Fix manually / Spawn
bug-fix goal — pauses mission for plan amendment / Pause mission") and waits.
This honours the strict-default policy.

---

## 13. UI architecture

### 13.1 Sidebar

`render-helpers.ts`: new `renderMissionGroup(mission, projectAccent)` —
collapsible row with flag icon, state pill, expand chevron. Expanded body
indents one level and renders the mission's child goals using the existing
`renderGoalGroup`.

`sidebar.ts` per-project section becomes:

```
Project header
  ├── Missions      ← new subgroup, only when project has live missions
  │     └── Mission row (expanded)
  │           ├── Child goal row
  │           └── Child goal row → [expand → sessions]
  ├── Goals         ← existing subgroup; standalone goals only
  │     └── Goal row (sessions inside)
  └── Sessions      ← existing
```

Standalone goals are filtered to `!g.missionId` so they don't render twice.

### 13.2 Route

New: `#/mission/:id` → `view: "mission-dashboard"` in `routing.ts`.

### 13.3 Dashboard layout (`src/app/mission-dashboard.ts`)

Top to bottom:

1. **Header** — title, state pill, divergence policy, max concurrency,
   integration branch, PR link button (when set).
2. **DAG visualisation** — SVG (see §13.5).
3. **Mission gates panel** — shared `GatesPanel` component (factor out from
   `goal-dashboard.ts` in phase 3).
4. **Child goals grid** — cards: title, current gate, last verdict, agent count,
   last activity. Click → goal-dashboard.
5. **Commander chat embed** — same component used for goal-dashboard's team-lead
   embed.
6. **Plan review tab** — shown when `plan-review` is `passed` and `goal-plan`
   is `pending`. Top-level DAG SVG + per-goal expandable cards (title, spec
   markdown, workflow, suggested role, deps). Edit-in-place fields persist
   via `PATCH /api/missions/:id/plan` (force=1, state=planning). "Approve
   plan" button signals `goal-plan` with the current plan as content.

Each section is a separate render function. Polling/event subscription
mirrors `goal-dashboard.ts` (gate polling, agent polling, git status polling).

### 13.4 Plan review tab

Edit semantics:
- Each PlannedGoal card edits inline: title, spec (markdown editor), workflow
  (dropdown), suggestedRole (dropdown), deps (multiselect).
- Add/remove plan nodes via "+ Add Goal" / × buttons.
- Edges are edited as a deps multiselect on each card (not a graph editor — too
  fragile in v1).
- "Approve plan" calls `gate_signal(goal-plan, content=<plan-as-markdown>)`.

### 13.5 Open question 3 — DAG SVG approach

**Decision:** start hand-rolled, fall back to `dagre` (not elkjs) if the graph
exceeds 30 nodes. Rationale:
- Typical missions are 5–15 nodes — hand-rolled layered layout (longest-path
  layering + barycenter ordering) is ~150 LoC and zero deps.
- Elkjs is 800+ KB; dagre is 50 KB. We have a hard cap on bundle size.
- The hand-rolled layout returns absolute (x,y) coordinates, so the same
  rendering component works for either layout backend — we can swap engines
  without touching the SVG code. Phase 3 ships hand-rolled; phase 6 evaluates.

Module: `src/app/components/MissionDagSvg.ts`. Pure: takes
`{ nodes, edges, nodeStates }` and returns a `TemplateResult` (Lit). Layout
is a pure function `layoutDag(plan): { positions: Map<planId, {x,y}>; size: {w,h} }`
in a sibling file `mission-dag-layout.ts` for unit testability.

---

## 14. Phased delivery plan

The spec proposes 8 phases. We **confirm** phases 1–8 with the refinements
below. Each phase ships independently and leaves the system fully usable.

### Phase 1 — Data model + Commander role + REST CRUD

**Files touched:**
- New: `mission-store.ts`, `mission-manager.ts` (skeleton, no scheduler),
  `defaults/roles/commander.yaml`, `defaults/tools/mission/{extension.ts,
  mission_plan_propose.yaml, mission_goal_spawn.yaml, mission_goal_status.yaml,
  mission_status.yaml}`.
- Modified: `goal-store.ts` (+missionId fields), `goal-manager.ts` (+baseBranch
  pass-through, no behaviour change), `project-context.ts` (instantiate
  MissionStore + MissionManager), `server.ts` (add `/api/missions` CRUD only).

**Gates produced:** none new (no mission workflow yet).
**Definition of done:** create/list/get/update/archive missions via REST; tools
register for Commander; Commander can spawn a child goal via REST; goals carry
`missionId`. No scheduler, no integration branch yet (children branch off
`origin/master`).
**Tests:** unit (store, manager validations), API E2E (CRUD round-trip,
spawn-child idempotency).

### Phase 2 — Mission workflow + gate-store generalisation

**Files touched:**
- New: `defaults/workflows/mission.yaml`,
  `defaults/helpers/check-mission-execution.mjs`.
- Modified: `gate-store.ts` (ownerKind), `verification-harness.ts` (resolveOwner),
  `verification-logic.ts` (new template vars), `server.ts` (mission gate routes
  via `?ownerKind=mission`), `system-prompt.ts` (Commander preamble).

**Gates produced:** mission workflow gates exist and can be signalled.
**Definition of done:** Commander can signal `charter`, `plan-review`,
`goal-plan`; verification runs against mission context. Plan persistence
(`mission_plan_propose`) works.
**Tests:** unit (gate-store ownerKind round-trip on legacy data), API E2E
(charter→plan-review→goal-plan happy path with mock LLM verifier).

### Phase 3 — Sidebar + dashboard skeleton

**Files touched:**
- New: `src/app/mission-dashboard.ts`, `src/app/components/MissionDagSvg.ts`,
  `src/app/components/mission-dag-layout.ts`.
- Modified: `src/app/sidebar.ts`, `src/app/render-helpers.ts`,
  `src/app/routing.ts`, `src/app/main.ts`, `src/app/state.ts`,
  `src/app/dialogs.ts` (`showMissionDialog`).

**Gates produced:** none new.
**Definition of done:** create mission via dialog, navigate to
`#/mission/:id`, see header + gates panel + Commander chat embed + DAG
read-only.
**Tests:** browser E2E (create mission, dashboard navigation, persistence
across reload), unit (mission-dag-layout pure function).

### Phase 4 — Integration branch + child branching + local merges

**Files touched:**
- New: `mission-git.ts`.
- Modified: `mission-manager.ts` (createMission now creates integration branch
  + worktree; spawnChild passes integrationBranch as baseBranch),
  `goal-manager.ts` (already accepting baseBranch from phase 1; now used),
  `system-prompt.ts` (team-lead mission stanza), `server.ts`
  (integrate-child route).

**Gates produced:** `mission-pr` verification commands work end-to-end.
**Definition of done:** end-to-end manual: create mission, approve a 2-goal
plan, both goals run on branches off integration, Commander merges both into
integration, integration → master PR raised.
**Tests:** unit for `mission-git.ts` (mock spawn), manual integration test
(real git worktrees, dummy children with synthetic commits).

### Phase 5 — Scheduler + parallel auto-spawn + bounded autonomy

**Files touched:**
- New: `mission-scheduler.ts`.
- Modified: `mission-manager.ts` (pause/resume), `server.ts` (pause/resume
  routes), `team-manager.ts` (notification routing — wake Commander on
  child gate events).

**Definition of done:** scheduler auto-spawns up to `maxConcurrentGoals`,
auto-merges on `ready-to-merge` pass, auto-wakes Commander on conflict;
divergence policy enforced server-side.
**Tests:** unit (scheduler tick with mock stores covering: ready set, cap,
merge auto-trigger, conflict broadcast), API E2E (3-goal diamond DAG,
parallel spawn observed).

### Phase 6 — Plan review UX + DAG editor

**Files touched:**
- Modified: `mission-dashboard.ts` (plan review tab, edit-in-place),
  `MissionDagSvg.ts` (interactivity: hover tooltip, click → expand).

**Definition of done:** user can edit a plan in the review tab and signal
`goal-plan` from the UI.
**Tests:** browser E2E (full create-plan-approve-execute happy path on a
3-goal plan with one parallel level).

### Phase 7 — Integration verification + cross-goal review

**Files touched:**
- Modified: `defaults/workflows/mission.yaml` (already includes integration
  gate from phase 2; this phase wires the LLM cross-goal review),
  `verification-harness.ts` (mission integration verification runs in
  integration worktree).

**Definition of done:** full mission lifecycle from spec to merged PR works
on a real test repo.
**Tests:** manual integration covering an end-to-end 3-goal mission.

### Phase 8 — Polish + docs

**Files touched:**
- New: `docs/missions.md`.
- Modified: `AGENTS.md` (recipes + debugging entries), `docs/internals.md`
  (extension), `docs/goals-workflows-tasks.md` (mission section).
- Optional: `searchIndex.indexMission()` IndexSource implementation.

**Definition of done:** documentation lands; AGENTS.md recipes for "Add a
mission feature", "Debug stuck mission scheduler", "Mission integration
branch hygiene"; debugging keyword index entries for stuck integration
branch, conflict surface, plan freeze.
**Tests:** docs-quality LLM review only.

---

## 15. Test strategy

| Phase | Unit | API E2E | Browser E2E | Manual integration |
|-------|------|---------|-------------|--------------------|
| 1 | mission-store CRUD; plan-node attach; spawn-child idempotency | mission CRUD round-trip; spawn-child 409 cases | — | — |
| 2 | gate-store ownerKind dual-key; lazy migration of legacy entries; new template-var substitution | charter→plan-review→goal-plan with mocked LLM | — | — |
| 3 | DAG layout pure function (cycle detection, longest-path layering); plan validation | — | create mission → dashboard render → reload persistence | — |
| 4 | mission-git mergeChild conflict detection; childStartPoint pinning | spawn-child branches off integration | — | real git: 2-goal mission, merge into integration, PR raised against test fork |
| 5 | scheduler tick: ready set, concurrency cap, auto-merge, conflict broadcast; per-mission lock | 3-goal diamond DAG parallel spawn | scheduler-driven UI updates (mission row state changes) | 5-goal mission with one transient retry |
| 6 | plan editor diff → PATCH plan validations | plan PATCH with version conflict | full happy path: create→plan→approve→complete | — |
| 7 | integration-gate runner | — | integration verification triggers from dashboard | end-to-end 3-goal mission on a real test repo |
| 8 | doc-quality LLM | — | — | — |

Test infrastructure conventions (per AGENTS.md):
- Unit tests use `tests/*.test.ts` with mocked stores in temp dirs.
- API E2E uses `tests/e2e/missions-api.spec.ts` with the in-process harness.
- Browser E2E uses `tests/e2e/ui/missions.spec.ts` with the gateway harness;
  follows the canonical pattern (navigate / happy path / persistence / cleanup).
- Manual integration uses `tests/manual-integration/missions/` with real
  Docker + git.
- `BOBBIT_TEST_NO_PUSH=1` covers all push paths.

---

## 16. Open-question resolutions

(Reproducing the spec's questions verbatim and answering each.)

1. **Should the integration branch's worktree be a real Bobbit-managed
   worktree or a server-managed scratch directory?**
   → Managed worktree. See §12.6 — reuses `worktree_setup_command`, sandbox
   config, and 7-day purge.

2. **When Commander runs `mission_merge_child`, should conflict resolution
   try a `bug-fix` mini-goal first or escalate immediately?**
   → Escalate immediately. See §12.7 — auto-fix would require structural
   plan change (= major divergence), which strict policy forbids without
   user approval. Commander surfaces a 3-option `ask_user_choices`.

3. **DAG SVG: hand-rolled or use a library (dagre, elkjs)?**
   → Hand-rolled layered layout in v1; dagre fallback if graphs exceed 30
   nodes. Elkjs is too heavy for the bundle. See §13.5.

4. **Should mission gates be visible in the existing goal-dashboard sidebar
   entry for child goals?**
   → Yes, read-only. The goal dashboard renders a collapsible "Mission
   gates" panel under the existing gates panel when `goal.missionId` is set,
   linking back to `#/mission/:id`. Implementation lands in phase 3 alongside
   the breadcrumb (§4.12).

---

## Appendix A — Risk register (delta from spec)

The spec already enumerates risks in "Risks and mitigations". This design
doc adds:

| Risk | Mitigation in this design |
|------|---------------------------|
| `gate-store.ts` lazy migration leaves legacy reads inconsistent | New methods always go through internal resolver; legacy methods are wrappers; load step normalises records in memory on first read | 
| Plan-node ordering drift across re-plans (UI jumps) | ULID `planId` lexicographic sort + UI sorts by `(layoutLayer, planId)` | 
| Integration worktree disk bloat | Reuses 7-day purge; mission archive triggers `cleanupWorktree` for the integration path |
| Commander session context bloat across long missions | Commander uses existing context-compaction; `mission_status` returns summarised plan-node state (not full specs) so periodic compaction stays effective |
| Two parallel children both branching off integration race | `childStartPoint` returns a SHA, not a branch name; both children pin to the same SHA (§12.2) |

---

## Appendix B — Acceptance criteria mapping

Each acceptance criterion (1–10 in the spec) maps to phases:

| AC | Phases |
|----|--------|
| 1. New Mission dialog | 3 |
| 2. Navigate to dashboard with Commander embedded | 3 |
| 3. Charter → plan-review → plan in review tab | 2 (signals), 6 (review tab UI) |
| 4. Inspect/edit plan, click "Approve plan" | 6 |
| 5. Up to 3 children spawn in parallel off integration branch | 4 (branching) + 5 (scheduler) |
| 6. Children merge into integration branch | 4 (mission-git) + 5 (scheduler auto-merge) |
| 7. `integration` gate runs on integration branch | 7 |
| 8. `mission-pr` raises one PR | 4 (commands work) + 7 (verified) |
| 9. Standalone goals unchanged | All — additive only |
| 10. Persistent failure pauses + notifies, never silently re-plans | 5 (autonomy enforcement) |
