# Missions

Operational and developer reference for **mission orchestration** — Bobbit's multi-goal coordination layer.

This document covers the lifecycle, data model, branching strategy, scheduler, REST/WS surface, and recovery scenarios. For the architectural design rationale (why the entity exists, alternatives considered, phased delivery), see [docs/design/mission-orchestration.md](design/mission-orchestration.md). For the underlying goal/workflow/gate machinery that missions reuse, see [docs/goals-workflows-tasks.md](goals-workflows-tasks.md).

## Concept overview

A **mission** is a top-level entity that sits between a project and its goals. It owns:

- a markdown **spec** describing the user's high-level request,
- a DAG-shaped **plan** of child goals with explicit dependencies,
- a single **integration branch** (`mission/<slug>-<id>`) into which child goals merge,
- a long-lived **Commander** agent session that plans, schedules, and integrates.

### When to use a mission vs a single goal

| Situation | Use |
|---|---|
| One coherent change, single PR, < ~1 day of agent work | **Goal** |
| Multi-feature spec, 5–20 interconnected workstreams, parallelism opportunities | **Mission** |
| You want one PR but the work fans out across multiple roles/branches | **Mission** |
| You want agents working in parallel on independent chunks of a spec | **Mission** |

A mission is overkill when the work fits one goal. Standalone goals are unchanged by this feature — they continue to work exactly as before.

### The Commander agent

Every mission has a **Commander** (role: `commander`). Unlike a team-lead, the Commander outlives any individual goal:

- Phase 1 (planning): converts the spec into a charter, then a DAG plan.
- Phase 2 (execution): monitors child goals, merges completed children into the integration branch.
- Phase 3 (integration): runs cross-goal verification, raises the mission PR.

Commander runs against the **integration worktree** — a real Bobbit-managed worktree (see the canonical path in [Storage paths](#storage-paths) below). It inherits the project's `worktree_setup_command`, sandbox config, and the standard 7-day purge path.

The Commander has bounded autonomy. It cannot push to master, cannot raise PRs to master from child branches, and cannot mutate the plan after the human has approved it (without an explicit pause + replan reason). The server enforces these constraints at the tool/REST layer; the system prompt is informational only.

## Lifecycle

A mission progresses through six gates in a strict DAG:

```
charter ──► plan-review ──► goal-plan ──► execution ──► integration ──► mission-pr
   ↑              ↑              ↑             │              │              │
 LLM           LLM          human          aggregate      type-check     PR raised
 review        review       approval       child state    + tests        + pushed
                            (signals      (all merged)    + cross-goal   + master
                             freeze)                       review         merged in
```

| Gate | Purpose | What signals it | What verifies it |
|---|---|---|---|
| `charter` | Bound the mission scope | Commander, after reading spec | LLM `spec-auditor` review (scope, success criteria, out-of-scope) |
| `plan-review` | Validate the proposed DAG | Commander, after `mission_plan_propose` | LLM `architect` review (DAG correctness, parallelism, completeness) |
| `goal-plan` | Human approves the frozen plan | The user, via the dashboard plan-review tab | None — propose-and-wait. On pass, the harness calls `MissionManager.freezePlan` so the plan version is locked. |
| `execution` | All child goals complete and merged | Auto — scheduler nudges Commander when ready | `defaults/helpers/check-mission-execution.mjs` exits 0 iff every plan node has `goalId` set, each child's `ready-to-merge` gate is `passed`, and `mergedAt` is set. |
| `integration` | Cross-goal correctness on the integration branch | Commander, after `execution` passes | Type-check + unit + e2e on integration branch (phase 0/1) plus a cross-goal LLM `code-reviewer` (phase 2). |
| `mission-pr` | Mission delivered as a single PR | Commander | `git merge-base --is-ancestor origin/<master>`, push integration branch, `gh pr create`/`gh pr list` non-empty. |

Mission gates use the same `gate-store` and verification harness as goal gates — only the owner kind differs (see [Gate-store generalisation](#gate-store-generalisation) below).

### Pre-implementation gates

`charter`, `plan-review`, and `goal-plan` are **pre-implementation** gates: they run before any code is committed and skip the `git diff` baseline that implementation-tier gates use. This is the same convention as the design-doc gate in goal workflows — see [docs/goals-workflows-tasks.md — Gate verification baselines](goals-workflows-tasks.md#gate-verification-baselines).

### Mission states

| State | Meaning |
|---|---|
| `planning` | Pre-`goal-plan`. Commander iterates on charter / plan with the user. |
| `in-progress` | `goal-plan` passed; scheduler is spawning and merging children. |
| `paused` | User paused, or autonomy escalation auto-paused. No new spawns. |
| `complete` | `mission-pr` passed and PR merged (or marked done). |
| `shelved` | User-archived without completing. |
| `failed` | Unrecoverable setup error (e.g. integration worktree creation failed). |

## Data model

### `PersistedMission`

Stored in `<project>/.bobbit/state/missions.json`. See `src/server/agent/mission-store.ts` for the authoritative type. Key fields:

| Field | Notes |
|---|---|
| `id`, `projectId` | UUID + project scope. `projects: string[]` is `[projectId]` in v1; reserved for future cross-project missions. |
| `title`, `spec` | Source of truth for the mission. `spec` is the markdown the user pasted/uploaded. |
| `state` | One of the states above. |
| `plan?: MissionPlan` | The DAG. Absent until Commander proposes one. |
| `planFrozenAt?: number` | Set when `goal-plan` passes. Subsequent `mission_plan_propose` calls are rejected unless the mission is paused with a `replanReason` (see [Divergence policy](#divergence-policy)). |
| `commanderSessionId?` | The long-lived Commander session. |
| `workflowId`, `workflow?` | Always `"mission"` in v1; the workflow is snapshotted at creation, identical to goals. |
| `integrationBranch?`, `integrationWorktree?`, `baseRef?` | Set after `MissionGit.createIntegrationBranch` runs. `baseRef` is the `origin/<master>` SHA at creation. |
| `divergencePolicy` | `"strict"` (default), `"balanced"`, or `"autonomous"`. |
| `maxConcurrentGoals` | 1–8, default 3. |
| `replanCount?` | Number of times `proposePlan` was called after freeze. Capped at `MAX_REPLANS = 3` — past that, the mission auto-pauses for human review. |
| `pausedAt?`, `pausedReason?` | Set when paused. |

### `MissionPlan` and `PlannedGoal`

```ts
interface MissionPlan {
  goals: PlannedGoal[];          // nodes
  dependencies: PlanEdge[];      // edges (from -> to)
  rationale: string;             // Commander prose
  estimatedConcurrency: number;
  version: number;               // monotonically increasing
}

interface PlannedGoal {
  planId: string;                // ULID — stable across re-plans
  title: string;
  spec: string;
  workflowId: string;            // bobbit workflow id, default "feature"
  suggestedRole?: string;
  enabledOptionalSteps?: string[];
  // Filled in once spawned:
  goalId?: string;               // PersistedGoal.id of the spawned child
  state?: GoalState;             // mirrored for fast UI
  spawnedAt?, completedAt?, mergedAt?: number;
  failedAttempts?: number;       // scheduler bookkeeping
}
```

`planId` is a ULID rather than UUID so plan nodes sort lexicographically and the UI renders deterministically across re-plans.

### Goal linkage

Goals carry two new optional fields (`src/server/agent/goal-store.ts`):

```ts
interface PersistedGoal {
  // ... existing fields ...
  missionId?: string;          // null/undefined for standalone goals
  missionPlanId?: string;      // PlannedGoal.planId in the owning mission's plan
}
```

Both are additive — existing goals load with both undefined and render in the standalone Goals subgroup.

### Storage paths

| Artifact | Path |
|---|---|
| Mission records | `<project>/.bobbit/state/missions.json` |
| Goals | `<project>/.bobbit/state/goals.json` (unchanged) |
| Gates (both kinds) | `<project>/.bobbit/state/gates.json` (extended; see below) |
| Integration worktree | `<repo>-wt/mission-<slug>-<id8>/` (managed worktree) |

### Gate-store generalisation

`gate-store.ts` is keyed by `(ownerKind, ownerId)` rather than just `goalId`. `GateState` and `GateSignal` gain `ownerKind: "goal" | "mission"` and `ownerId: string`. The `goalId` field is retained as a backward-compat alias for `ownerKind="goal"` records.

**Lazy migration:** records on disk without `ownerKind` are normalised to `("goal", goalId)` on read; writes upgrade to the new shape. No file rewrite is forced.

**Verification harness:** `verifyForOwner(kind, id, ...)` resolves `cwd`, `branch`, `spec`, and `workflow` from the owner. For missions, `cwd` is the integration worktree, `branch` is the integration branch, `spec` is the mission spec. New template variables: `{{mission_id}}`, `{{integration_branch}}` (alias `{{mission_branch}}`); `{{branch}}` resolves to the integration branch when the owner is a mission, so existing `git diff origin/{{master}}...{{branch}}` substitutions in shared review prompts continue working.

## Branching & integration

A mission has exactly one branch that exists for the user to review: the **integration branch**. Child goals branch off it, merge back into it, and the mission PR raises *that* branch against `master`. No child goal raises its own PR to master.

```
origin/master ──┐
                ▼
   mission/build-unified-memory-3f8a2c91   (integration branch)
        │   │   │
        │   │   └── goal/build-storage-layer-6e2d (merged via --no-ff)
        │   └────── goal/build-api-surface-4c1b   (merged via --no-ff)
        └────────── goal/wire-search-index-8f9a   (merged via --no-ff)
```

### Integration branch creation

On `POST /api/missions`, `MissionGit.createIntegrationBranch` runs:

```bash
slug=$(slugify "$TITLE" | cut -c1-30)
branch="mission/${slug}-${MISSION_ID:0:8}"
git fetch origin master
git worktree add -b "$branch" "<repo>-wt/mission-${slug}-${id8}" "origin/master"
# worktree_setup_command runs with SOURCE_REPO env (existing helper).
```

The integration worktree is a normal Bobbit-managed worktree. It inherits `worktree_setup_command`, sandbox config, and 7-day purge — the same plumbing your goal worktrees use.

**The integration branch is not pushed until the `mission-pr` gate.** Planning iterations stay local.

### Child branching — pinned to integration HEAD

When a child goal spawns, `MissionManager.spawnChild` resolves `MissionGit.childStartPoint(integrationWorktree)` — the **HEAD SHA of the integration branch right now** — and passes it as `baseBranch` to `GoalManager.createGoal`. The child worktree is created via `createWorktree(repoPath, branch, { startPoint: <SHA> })`.

Pinning to a SHA, not a branch name, prevents a race: if two parallel children are spawned in close succession, both observe the same parent commit. If we passed the branch name, the second spawn might see a different HEAD than the first if the integration branch advanced between them.

### Merging children back

When a child's `ready-to-merge` gate passes, the scheduler triggers `MissionGit.mergeChild` in the integration worktree:

```bash
git fetch origin "$childBranch"
git merge --no-ff -m "Mission: $title — merge goal: $planTitle" "origin/$childBranch"
```

`--no-ff` keeps each child as a discrete merge commit so the integration history is auditable. Outcomes:

- **Merged**: `mergeSha` recorded on the plan node; `mission_child_merged` broadcast; scheduler may now spawn dependents.
- **Conflict**: `git diff --name-only --diff-filter=U` collected, then `git merge --abort` (clean state). `mission_child_merge_conflict` broadcast; Commander is woken to handle. **No auto-resolution** — see [Recovery scenarios](#recovery-scenarios).
- **Already-merged**: detected via `git merge-base --is-ancestor`. Idempotent no-op.

### Forward-merging master

`MissionGit.forwardMergeMaster` pulls `origin/master` into the integration branch:

```bash
git -C "$INTEGRATION_WORKTREE" fetch origin master
git -C "$INTEGRATION_WORKTREE" merge --no-ff "origin/master"
```

Invoked:

- Periodically by `MissionScheduler.tickMission` while the mission is in-progress (best-effort; soft-fails on conflict and continues).
- Unconditionally before the `mission-pr` gate's verify steps run.

### Mission PR

`mission-pr` verification commands:

1. `git fetch origin master && git merge-base --is-ancestor origin/master <integration_branch>` — guarantees master is fully merged in.
2. `git push origin <integration_branch>` (gated by `shouldSkipRemotePush()` so test mode never touches the remote).
3. `gh pr create --base master --head <integration_branch>` (or verify a PR already exists via `gh pr list`).

Only this PR exists for the mission. Child goals never PR to master.

## Scheduler

`MissionScheduler` (`src/server/agent/mission-scheduler.ts`) is the event loop that drives parallel execution. It is **idempotent** — every action checks current state and is safe to re-run.

### Triggers

`tickMission(missionId)` fires on:

1. Gate-status changes — wired via `gateStore.onStatusChange(ownerKind, ownerId, gateId)` in `project-context.ts`. Both goal-side gates (a child's `ready-to-merge` passing) and mission-side gates (`goal-plan` passing) wake the scheduler.
2. Goal state changes — `goalStore.onIndexUpdate` mirrors child `state` into the plan node.
3. Mission resume / plan freeze events.
4. **Periodic safety-net poll** via `tickAll()` — catches any event the listeners miss. Interval is the current default `tickIntervalMs` on `MissionScheduler` (60_000 ms unless overridden); the value is wired in `project-context.ts` and may be reconfigured per-deployment.

### Per-mission lock

```
inflight: Map<missionId, Promise<void>>
async tickMission(id) {
  const prev = inflight.get(id);
  const next = (async () => { await prev; await doTick(id); })();
  inflight.set(id, next);
  ...
}
```

Concurrent ticks for the same mission serialise; ticks for different missions run in parallel.

### Tick algorithm

For each in-progress mission:

1. **Mirror state** — copy each spawned child's `state` into the plan node.
2. **Auto-merge** ready children — for any node where the child's `ready-to-merge` gate is `passed` but `mergedAt` is unset, call `MissionGit.mergeChild`. On conflict, broadcast and stop (Commander handles).
3. **Spawn ready nodes** — compute the ready set (deps all merged), and spawn up to `maxConcurrentGoals - inFlight` of them. Spawn is idempotent on `(missionId, planId)`.
4. **Forward-merge master** (best-effort) on each tick if wired.
5. **Wake Commander** when `execution` is unsigned but every plan node is merged.
6. **Auto-retry / pause** on child failure (see [Bounded autonomy](#bounded-autonomy)).

### Idempotency

- Spawn endpoint: keyed on `(missionId, planId)` — returns `{ alreadySpawned: true }` if a goal already exists.
- Merge endpoint: detects `already-merged` via `git merge-base --is-ancestor`.
- Plan-node state mirroring: only writes on diff.

### Concurrency cap

`inFlight` counts plan nodes with `goalId && !mergedAt && !failedTerminally` — children stay "in-flight" from spawn through merge. Default cap is 3, hard ceiling 8 (mission record validates).

## Divergence policy

Plan structure changes after `goal-plan` is the single biggest risk in mission orchestration: the user approved a specific DAG; silent edits violate that contract. The `divergencePolicy` field controls how strictly the server polices Commander:

| Policy | Behaviour |
|---|---|
| `strict` (default) | Any plan mutation after freeze requires `mission.state === "paused"` AND a `replanReason`. The server cascade-resets `charter` and `plan-review` so the user re-approves. |
| `balanced` | (v1: identical to strict; reserved for future tuning of moderate cases.) |
| `autonomous` | (v1: identical to strict; reserved.) |

**The server enforces this at the `mission_plan_propose` tool / `PATCH /api/missions/:id/plan` route**, not in the system prompt. Trying to propose a new plan against a frozen mission that isn't paused returns 409 with `"Plan is frozen — pause mission and provide replan_reason"`.

### Replan counter cap

`mission.replanCount` increments on every successful post-freeze re-plan. At `MAX_REPLANS = 3` (constant in `mission-store.ts`), the mission auto-pauses and further re-plans are rejected. This prevents infinite "Commander keeps proposing minor variations" loops — at the cap, a human takes over.

### Manual freeze override (test mode only)

`PATCH /api/missions/:id/plan?force=1` bypasses the freeze check, but only when `BOBBIT_E2E=1`. Production servers reject `?force=1` outright. This exists for E2E tests that need to fast-forward past gate flow without driving the full review loop.

## Bounded autonomy

The Commander has three escalation tiers, enforced by the scheduler and the tool layer:

| Tier | Trigger | Action |
|---|---|---|
| **Minor** | A child fails once on a transient error (review-fail loop, command failure). | Scheduler clears the goal slot (`goalId = undefined` etc.) so the next tick re-spawns afresh. `failedAttempts` increments. |
| **Moderate** | A child reaches `failedAttempts >= 2` (constant `maxFailedAttempts` in `MissionScheduler`). | Scheduler auto-pauses the mission and broadcasts `mission_paused`. Commander surfaces an `ask_user_choices` (continue / spawn fix-goal / stay paused). |
| **Major** | Any structural plan change — adding/removing nodes, edge edits, swapping a node's workflow. | Server rejects the tool call unless the mission is paused AND `replanReason` is provided. Commander must `mission_pause` first, then re-propose. |

Merge conflicts are treated as **moderate** by default (escalate immediately) rather than auto-spawning a fix-goal — auto-spawning would require structural plan change, which honours the major rule.

## Comparison with standalone goals

Missions reuse goal/team/gate machinery wherever possible. The differences:

| Aspect | Standalone goal | Mission |
|---|---|---|
| Top-level entity | `PersistedGoal` | `PersistedMission` (with `PersistedGoal` children) |
| Workflow | Any (`general`, `feature`, `bug-fix`, …) | Always `mission` v1 |
| Branch off | `origin/<master>` | The mission's integration branch (HEAD SHA pinned at spawn) |
| PR target | `master` | Child goals **never PR**; mission integration branch PRs to `master` once |
| Coordinator | Team-lead session (per goal) | Long-lived Commander session (per mission) + per-child team-leads |
| Gate scope | `ownerKind: "goal"` | `ownerKind: "mission"` (extends same store) |
| Sidebar | "Goals" subgroup | "Missions" subgroup (sits above Goals when present) |
| Dashboard route | `#/goal/:id` | `#/mission/:id` |
| Concurrency | One team per goal | `maxConcurrentGoals` children at once (default 3) |

**What's identical:** child goals run their own workflows unchanged. Each child has its own team-lead, role agents, gate verification, ready-to-merge flow, retry-setup, archive path. The only thing a child knows about its mission is (a) `missionId` is set, (b) its team-lead system prompt has a stanza saying "do NOT raise a PR to master — push and signal `ready-to-merge`; the Commander will merge into the integration branch."

## REST API

All routes follow the standard project-resolution contract — `400 "projectId required: ..."` if no `projectId` and no `cwd` resolves to a registered project. See [docs/rest-api.md — Project resolution contract](rest-api.md#project-resolution-contract).

### CRUD

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/missions` | Create mission + spawn Commander session. Body: `{ projectId, title, spec, divergencePolicy?, maxConcurrentGoals?, sandboxed?, enabledOptionalSteps? }`. Returns 201 with full `PersistedMission`. |
| `GET` | `/api/missions` | List missions. Query: `?projectId=`. Returns `{ generation, missions }`. |
| `GET` | `/api/missions/:id` | Mission detail — `{ mission, plan, children: [{ planId, goalId, title, state, ..., goal }], integrationBranch, commanderSessionId, gates }`. |
| `PUT` | `/api/missions/:id` | Update mutable fields (`title`, `divergencePolicy`, `maxConcurrentGoals`, `archived`, `spec`). |
| `DELETE` | `/api/missions/:id` | Archive mission (soft-delete). Children stay; their `missionId` is retained for history. |

### Plan management

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/missions/:id/plan` | Latest plan, or 404 when absent. |
| `PATCH` | `/api/missions/:id/plan` | Replace plan. Body: `MissionPlan` (or `{ plan, replan_reason? }`). Validates DAG (acyclic, refs in-plan, version bump). 409 if frozen and not paused with reason. `?force=1` under `BOBBIT_E2E=1` only. |
| `POST` | `/api/missions/:id/plan/freeze` | Freeze the plan. 409 unless `goal-plan` gate is passed (or `?force=1` under `BOBBIT_E2E=1`). Normally invoked via the `goal-plan` gate verifier post-pass hook. |

### Child lifecycle

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/missions/:id/spawn-child/:planId` | Idempotent. 409 if `goal-plan` not passed, deps not merged, or already spawned (returns `{ alreadySpawned: true }`). Returns `{ goalId, branch, alreadySpawned }`. |
| `POST` | `/api/missions/:id/integrate-child/:planId` | Merge child into integration branch. Returns `{ ok, status: "merged"\|"already-merged", mergeSha? }` or 409 with `conflictFiles`. |

### Mission control

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/missions/:id/pause` | Body: `{ reason?: string }`. 409 if not in a pausable state. |
| `POST` | `/api/missions/:id/resume` | 409 if not paused. |

### Mission gates

Reuse the same handlers as goal gates after resolving `ownerKind = "mission"`:

| Method | Path |
|---|---|
| `GET` | `/api/missions/:id/gates` |
| `GET` | `/api/missions/:id/gates/:gateId` |
| `POST` | `/api/missions/:id/gates/:gateId/signal` |
| `GET` | `/api/missions/:id/gates/:gateId/signals` |
| `GET` | `/api/missions/:id/gates/:gateId/inspect` |
| `GET` | `/api/missions/:id/gates/:gateId/content` |
| `POST` | `/api/missions/:id/gates/:gateId/cancel-verification` |

## WebSocket events

All additive — existing event names unchanged.

| Event | Payload |
|---|---|
| `mission_created` | `{ mission: PersistedMission }` |
| `mission_updated` | `{ missionId, patch: Partial<PersistedMission> }` |
| `mission_deleted` | `{ missionId }` |
| `mission_plan_proposed` | `{ missionId, planVersion: number }` |
| `mission_plan_frozen` | `{ missionId, planVersion: number, frozenAt: number }` |
| `mission_child_spawned` | `{ missionId, planId, goalId }` |
| `mission_child_state_changed` | `{ missionId, planId, goalId, state }` |
| `mission_child_merged` | `{ missionId, planId, status, mergeSha }` |
| `mission_child_merge_conflict` | `{ missionId, planId, goalId, conflictFiles: string[] }` |
| `mission_paused` | `{ missionId, reason }` |
| `mission_resumed` | `{ missionId }` |
| `mission_setup_complete` | `{ missionId, integrationBranch, integrationWorktree }` |
| `mission_setup_error` | `{ missionId, error }` |

`gate_*` events fire as today; their payloads carry `ownerKind` + `ownerId` so dashboards can route them.

## Recovery scenarios

### Stuck Commander

Symptom: a mission is `in-progress`, child goals are merged, but no further progress. Commander session is idle.

1. Check the scheduler's listener wiring — `gateStore.onStatusChange` must fire `tickMission` for `(ownerKind, ownerId, gateId)` triples that belong to this mission's children. The hook lives in `project-context.ts`.
2. Confirm the safety-net poll is running — look for `[scheduler] tickAll` in logs (default cadence `tickIntervalMs` on `MissionScheduler`, currently 60_000 ms) or call `tickMission(missionId)` manually via tests.
3. Inspect `replanCount` — at `MAX_REPLANS = 3` the mission auto-pauses and Commander stays idle until the user resumes.
4. Inspect `failedAttempts` on plan nodes — at `>= 2` the mission auto-pauses (constant `maxFailedAttempts` in `MissionScheduler`).

### Child goal merge conflict

Symptom: scheduler broadcasts `mission_child_merge_conflict`. Commander is woken.

The scheduler does **not** auto-resolve. Commander surfaces an `ask_user_choices`:

- **Manual resolve** — user merges by hand in the integration worktree.
- **Spawn fix-goal** — Commander pauses the mission, proposes a new plan with a `bug-fix` leaf node depending on the failing planId, version-bumps via `mission_plan_propose` with `replan_reason="merge-conflict-fix"`. The user re-approves the amended plan, then resumes.
- **Stay paused** — the user investigates.

This honours the strict-default policy: auto-spawning a fix-goal would be a structural plan change (major divergence), which requires user approval.

### Replan loop / mission auto-paused with `pausedReason: "replan cap reached"`

The Commander tried to mutate the plan more than `MAX_REPLANS` times after the user approved it. The mission is now paused and `mission_plan_propose` rejects further calls.

Resolution: the user either resumes (accepting the current plan) or archives and creates a fresh mission with a tightened spec.

### Paused mission won't resume

`POST /api/missions/:id/resume` returns 409 if the mission is not actually paused. Verify with `GET /api/missions/:id` and check `state === "paused"`. If the mission is `failed`, resume is not the right path — diagnose `setupError` and consider a fresh mission.

### Manual freeze override

`PATCH /api/missions/:id/plan?force=1` is gated to `BOBBIT_E2E=1`. In production this returns the same 403/409 a normal request would. Don't try to use it as a workaround for a stuck plan-review — fix the underlying gate failure or pause + re-plan via the normal route.

### Integration branch falls behind master

`MissionGit.forwardMergeMaster` is invoked from the `mission-pr` gate's first verify step (`git merge-base --is-ancestor origin/master <integration_branch>`) and periodically from `MissionScheduler.tickMission` while the mission is in-progress. If the periodic merge hits a conflict, the scheduler logs and continues — the next attempt may succeed once a child merge updates state. If `mission-pr` verification keeps failing on the ancestor check, run the forward-merge manually in the integration worktree:

```bash
cd <integration_worktree>
git fetch origin master
git merge origin/master   # resolve conflicts, commit
```

Then re-signal `mission-pr`.

### Child goal branched off master instead of integration branch

Symptom: a child's branch history doesn't include the integration branch tip — `git log <child-branch> --oneline | grep <integration-branch-tip>` returns nothing.

Diagnose:

1. `MissionManager.spawnChild` must call `MissionGit.childStartPoint(integrationWorktree)` to get the SHA, then pass it as `baseBranch` to `GoalManager.createGoal`. If the SHA resolution fails, the manager logs `[mission-manager] childStartPoint failed; falling back to integration branch name` — this fallback is fine *if* the integration branch is checked out, but if `origin` doesn't have the branch yet (it's not pushed before `mission-pr`), the fallback may resolve incorrectly.
2. `GoalManager.createGoal` must thread `baseBranch` through `_doSetupWorktree` to `createWorktree(repoPath, branch, { startPoint: baseBranch })`. Verify the call site receives the option.

The fix is always to spawn a fresh child after correcting the wiring; the misbranched child can be archived.

### Plan won't freeze after `goal-plan` passes

Symptom: user approves the plan, `goal-plan` gate transitions to `passed`, but `mission.planFrozenAt` is still undefined and the next `mission_goal_spawn` returns 409 `"Plan not approved"`.

Diagnose: the verification harness's mission-gate post-pass hook must call `MissionManager.freezePlan(missionId)` when `gateId === "goal-plan"`. Without it, the freeze flag never sets. Manual recovery:

```bash
TOKEN=$(cat .bobbit/state/token); GW=$(cat .bobbit/state/gateway-url)
curl -sk -X POST "$GW/api/missions/<id>/plan/freeze" -H "Authorization: Bearer $TOKEN"
```

(This requires the `goal-plan` gate to actually be `passed` — the endpoint refuses otherwise unless `?force=1` and `BOBBIT_E2E=1`.)

## Key source files

| File | Purpose |
|---|---|
| `src/server/agent/mission-store.ts` | JSON persistence, plan validation, `MAX_REPLANS` constant, `ulid()` |
| `src/server/agent/mission-manager.ts` | Lifecycle (create/pause/resume/archive), plan freeze, `spawnChild`, `integrateChild`, `forwardMergeMaster` |
| `src/server/agent/mission-scheduler.ts` | Event-driven tick loop, ready-set computation, concurrency cap, auto-retry/auto-pause |
| `src/server/agent/mission-git.ts` | `createIntegrationBranch`, `childStartPoint`, `mergeChild`, `forwardMergeMaster`, `pushIntegration` |
| `src/server/agent/gate-store.ts` | Owner-kind generalised gate store (used by both goal and mission gates) |
| `src/server/agent/verification-harness.ts` | Owner-aware verify dispatch (`verifyForOwner`); mission template variables |
| `src/server/server.ts` | `/api/missions/*` routes |
| `src/server/agent/project-context.ts` | Wires `MissionStore`, `MissionManager`, `MissionGit`, `MissionScheduler` per project |
| `defaults/workflows/mission.yaml` | Workflow definition (charter → plan-review → goal-plan → execution → integration → mission-pr) |
| `defaults/roles/commander.yaml` | Commander role definition + system prompt template |
| `defaults/tools/mission/` | Mission-specific tools (`mission_plan_propose`, `mission_goal_spawn`, `mission_merge_child`, `mission_goal_status`, `mission_status`, `mission_signal`) |
| `defaults/helpers/check-mission-execution.mjs` | `execution` gate verifier — exit 0 iff every plan node merged |
| `defaults/helpers/forward-merge-master.mjs` | Helper for periodic forward-merges |
| `src/app/mission-dashboard.ts` | `#/mission/:id` route handler — header, DAG SVG, gates panel, child grid, embedded Commander chat |

## See also

- [docs/design/mission-orchestration.md](design/mission-orchestration.md) — full design rationale, alternatives, phased delivery plan
- [docs/goals-workflows-tasks.md](goals-workflows-tasks.md) — underlying goal/workflow/gate machinery
- [docs/internals.md — Mission orchestration](internals.md#mission-orchestration) — architectural summary
- [docs/debugging.md — Mission orchestration](debugging.md#mission-orchestration) — diagnostic checklists
