# Nested Goals & DAG Subgoals

User-facing reference for the nested-goal feature. For internal data-model
details see [goals-workflows-tasks.md](goals-workflows-tasks.md); for
restart-resilience invariants see the relevant entries in
[debugging.md](debugging.md). Implementation specs that drove the feature
live in `SUBGOALS-SPEC.md` (root of the repo).

> **Status: experimental.** The nested-goals feature is gated behind a
> system-scope toggle ("Subgoals" in **Settings → System → General**),
> default OFF. With the toggle off the entire feature surface — the
> `parent` workflow, the nine `Children`-group tools, the Plan / Children
> tabs on the goal dashboard, sidebar nesting, mutation-pending cards,
> and the nested-goal REST routes — is hidden or returns
> `403 SUBGOALS_DISABLED`. The toggle will be retired and the feature
> promoted out of experimental status once the parent goal's audit
> completes. See `docs/design/subgoals-experimental-toggle.md` for the
> gating implementation.

## What & why

A **nested goal IS a goal** — same record shape, same store, same gates,
same workflow snapshot, same team-lead session, same dashboard, same
sidebar row (just indented). The only structural addition is one new
verify-step type (`subgoal`) plus a small set of optional fields on
`PersistedGoal` that establish the parent/child relationship. The
verification harness IS the scheduler: a `subgoal` step spawns or
resolves a child, waits for the child's `ready-to-merge` to pass, merges
the child branch into the parent locally, then archives the child.

Nested goals are useful when a single root goal can be decomposed into
spec-driven phases that are independently verifiable. Children execute
in parallel up to `maxConcurrentChildren` (default 3, hard max 8); each
runs in its own worktree; merges chain locally up the tree; only the
root raises a PR to `master`. The result: clean isolation per child,
parallel throughput, and a single PR for review at the top.

## Quick start

1. **Create a goal with the `parent` workflow** — the parent meta-workflow
   has six gates: `charter → plan-review → goal-plan → execution →
   integration → ready-to-merge`. The `goal-plan` gate is `manual: true`;
   signaling it freezes the plan.
2. **Team-lead writes a charter, signals the charter gate** (LLM-reviewed),
   then proposes subgoals via `goal_plan_propose`. Once `plan-review`
   passes, signaling `goal-plan` **freezes** `execution.verify[]` —
   further mutations route through the classifier (see [Mutation
   classifier](#mutation-classifier)).
3. **Children spawn in parallel** as the harness processes the `execution`
   gate, up to `maxConcurrentChildren`. Each child runs its own
   workflow, merges locally into the parent's branch on
   `ready-to-merge`, and is archived on success. The root goal raises
   exactly one PR to `master`.

## Architecture

```
                  ┌────────────────────────────────────┐
                  │   PersistedGoal (existing)         │
                  │   + parentGoalId?: string          │
                  │   + rootGoalId?: string            │
                  │   + mergeTarget?: "master"|"parent"│
                  │   + divergencePolicy?: "strict"|...│
                  │   + maxConcurrentChildren?: number │
                  │   + acceptanceCriteria?: string[]  │
                  │   + spawnedFromPlanId?: string     │
                  │   + dependsOnPlanIds?: string[]    │
                  │   + suggestedRole?: string         │
                  │   + spawnedBySessionId?: string    │
                  │   + paused?: boolean               │
                  │   + replanCount?: number           │
                  │   + inlineRoles?: Record<          │
                  │       name, Role>  (snapshot)      │
                  └────────────────────────────────────┘

                  ┌────────────────────────────────────┐
                  │   Workflow (existing) → VerifyStep │
                  │   type: "command"|"llm-review"|... │
                  │      |"subgoal"                    │
                  │   subgoal?: {                      │
                  │     planId: string                 │
                  │     title: string                  │
                  │     spec: string                   │
                  │     workflowId?: string            │
                  │     suggestedRole?: string         │
                  │     dependsOn?: string[]           │
                  │   }                                │
                  └────────────────────────────────────┘

  Verification harness runs verify steps in phase order, in parallel,
  with idempotency. ONE handler in the dispatcher for type === "subgoal":
    1. Lookup existing child by (parentGoalId, planId)         ← idempotent
    2. If not found, GoalManager.createGoal(parentGoalId, ...) ← reuse
    3. Stamp spawnedFromPlanId IMMEDIATELY after createGoal    ← critical (no awaits between)
    4. Wait for child.ready-to-merge to pass                   ← reuse harness poll
    5. mergeChildBranchLocal(parent.branch, child.branch)      ← new tiny helper
    6. archiveGoalAfterMerge(child.id)                         ← reuse archive flow
    7. Return passed=true                                      ← step done
```

## Branching topology

```
master ─────●──────────────────────────────●──────►
             \                              /
              ●─ goal/root ──●──●──●───────●  (PR: root → master)
                              \  \  /
                               ●──●  goal/child  (local merge into root, NO PR)
                                  \
                                   ●  goal/grandchild  (local merge into child)
```

Invariants:

- A child's branch is created off **the current parent branch HEAD** at
  spawn time (not off `origin/master`, not off the root). Subsequent
  siblings spawned later see their predecessors' commits.
- A child's `ready-to-merge` triggers a **local** merge into the parent
  via `mergeChildBranchLocal` (`git merge --no-ff`). No remote PR is
  raised.
- After a clean local merge, the parent branch is pushed to origin
  (gated by `shouldSkipRemotePush()`). This is **not** a PR-raising
  push — it just makes the post-merge tip available to CI and to
  siblings spawned later.
- Only the **root** goal (`parentGoalId == null`) raises a PR to
  `master`. Every team-lead's system-prompt stanza enforces this — child
  team-leads NEVER call `gh pr create`.

**Worktrees.** Every goal gets its own git worktree. The worktree pool is
**bypassed for child goals** because pool entries are pre-built off the
project's primary branch; a child must start from the parent's branch
HEAD. Top-level (root) goals continue to use the pool unchanged.

**Sandbox compatibility.** Sandboxed projects work identically. The
sandbox manager's `createWorktree(name, branch, baseBranch?)` accepts the
parent's branch as `baseBranch`, and sandboxed worktrees share
`/workspace/.git` so the parent goal's branch ref is visible inside the
container. The post-commit hook in `ProjectSandbox._installPostCommitHook`
pushes parent commits to origin so siblings spawned in different
container sessions see the latest tip via `origin/<parent-branch>`.

**Child `ready-to-merge` auto-targets the parent.** The shipped
`feature` / `general` / `bug-fix` workflows hard-code their
`ready-to-merge` gate at "Master merged into branch" + "PR raised".
Those checks are correct for a root goal but wrong for a child —
children merge LOCALLY into the parent's branch (no `origin/master`
merge) and only the root raises a PR. The pure helper
`adaptReadyToMergeForChild` in `src/server/agent/child-ready-to-merge.ts`
rewrites those two verify steps with `echo` no-ops when
`goal.mergeTarget === "parent"` and the parent's branch is resolvable;
"Branch pushed to remote" is left intact, and step count is preserved
so the harness's cached step indexing stays aligned. The rewrite is
applied at **two layers**: spawn-time inside `runSubgoalStep` (so the
workflow snapshot persisted on the child's goal record is already
child-aware) AND as a runtime safety net inside `verifyGateSignal` (so
in-flight children whose snapshots predate the fix don't need
migration). The helper is idempotent — verify steps already starting
with the echo marker are left alone.

## The `subgoal` verify-step type

Add a `type: "subgoal"` entry to a workflow gate's `verify[]`:

```yaml
verify:
  - name: "Implement v0.1"
    type: subgoal
    subgoal:
      planId: "v0.1"               # Stable idempotency key (string)
      title: "v0.1 — basic CLI"    # Becomes the child goal's title
      spec: |                      # Becomes the child goal's spec markdown
        ## Overview
        ...
        ## Covers
        - "Basic CLI works end-to-end"   # Quote root acceptance criteria verbatim
      workflowId: "feature"        # Optional — child's workflow id
      suggestedRole: "team-lead"   # Optional — hint for child's lead
      dependsOn: ["v0.0"]          # Optional — sibling planIds this step depends on (Phase 5)
```

### Declaring dependencies

The optional `dependsOn: string[]` field on a subgoal verify-step (and on
`goal_spawn_child` / `goal_plan_propose` calls) names sibling `planId`s
this step waits on. Empty / omitted = parallel sibling — the Plan-tab DAG
renders the node at column 0 with no incoming edge.

```yaml
verify:
  - name: "Build foundation"
    type: subgoal
    subgoal:
      planId: "foundation"
      title: "Foundation"
      spec: "..."
  - name: "Build feature on top"
    type: subgoal
    subgoal:
      planId: "feature"
      title: "Feature"
      spec: "..."
      dependsOn: ["foundation"]   # only spawned/edged after foundation
```

Validation (server-side, `src/server/agent/depends-on-validation.ts`):

- **`SELF_DEPENDENCY`** — a step's `dependsOn` includes its own `planId`. 400.
- **`UNKNOWN_PLAN_ID`** — `dependsOn` references a `planId` that doesn't exist among siblings (for `goal_spawn_child`) or among the proposed plan (for `goal_plan_propose`). 400 with `missing: string[]`.
- **`DEPENDS_ON_CYCLE`** — the implied DAG would cycle. Detected via Kahn's algorithm. 400 with `path: string[]`.

The Plan-tab DAG layout is purely topological: column = `max(deps.column) + 1`.
Edges are drawn ONLY where `dependsOn` is explicit — there is no
`createdAt` clustering or bipartite phase auto-connect. Two children
spawned without declared deps render as parallel siblings, no edge
between them. (Earlier versions inferred dependencies from spawn timing;
that heuristic is gone because it routinely chained unrelated children.)

**Mutation classifier interaction**: changing `dependsOn` on an existing
step in a frozen plan is classified as `restructure` by the mutation
classifier (overrides any `fix-up` it would otherwise be), so the
divergence-policy decision matrix requires the goal to be paused first.

**Topological ordering guarantee**: `goal_plan_propose` always spawns
steps in dependency order — dependencies before dependants. This means a
valid DAG submitted in any order (e.g. step B listed before step A even
though B `dependsOn` A) will still spawn correctly; the server sees each
child's deps already present when it validates the `dependsOn` field.

### dependsOn scheduling

`dependsOn` enforces scheduling on the **direct-spawn path** (`POST
/api/goals/:id/spawn-child` and the `goal_plan_propose` fallback
`spawn-children-direct`). The Plan-tab DAG edges and the scheduler agree
— declared deps gate execution, they are not visualisation-only.

Contract:

- A child spawned with `dependsOn: [planId, ...]` is **created with
  `state: "blocked"`** if ANY referenced sibling is not yet
  `state: "complete"`. The response is `201 { id, suggestedRole,
  spawnedBySessionId, blocked: true, pendingDeps: [...] }`.
  `setupWorktreeAndStartTeam` is NOT invoked — the child sits with
  `setupStatus: "preparing"` and `state: "blocked"` until unblocked.
- A child whose deps are all `state: "complete"` at spawn time starts
  normally (response lacks the `blocked` field).
- On `POST /api/goals/:id/integrate-child/:childId` (clean merge +
  auto-archive), the route scans the parent's other live children for
  any whose `dependsOnPlanIds` are now ALL satisfied. For each such
  sibling that is currently `state: "blocked"`, it clears the blocked
  state and triggers worktree setup + team start. Multi-dep children
  only unblock when the LAST dep merges.
- The auto-unblock scan is **best-effort** — any throw inside the scan
  is caught and logged; the merge itself never fails on unblock errors.

`state: "blocked"` is a distinct goal state (separate from
user-initiated `paused: true`), so the UI can distinguish a dep-blocked
child from a user-paused one. See
[docs/design/pause-cascade.md](design/pause-cascade.md) for the full
implementation description.

The frozen-plan execution-gate path (`runSubgoalStep` in
`verification-harness.ts`) sequences its own subgoal steps via the
harness's `phase` ordering and is unaffected by this enforcement — the
scheduling fix targets the direct-spawn fallback only.

`runSubgoalStep` reads as follows. Each step encodes a hard-won lesson
from PR #409 (see
[debugging.md](debugging.md) for diagnostic checklists):

```
1. Resolve descriptor       (planId / title / spec / workflowId? / suggestedRole?)
2. Tier-based child lookup  → resolvePlanStepChild  (tier preference, see below)
3. Stale archived non-complete invalidation         (cached pointer is dead)
4. Success terminal short-circuit                   (archived && state === "complete")
5. Workflow-less complete-child recovery            (legacy records pre-dating WorkflowStore-required)
6. Spawn → IMMEDIATELY stamp spawnedFromPlanId      (no awaits between createGoal and stamp)
   then fire setupWorktreeAndStartTeam asynchronously
7. Wait for child.ready-to-merge to pass (or external archive, or cancellation)
8. mergeChild → on merged|alreadyMerged: teardownTeam + archiveAfterMerge
   on conflict: passed=false with manual-recovery output (no auto-archive,
   no auto-resolve)
9. Concurrency: per-rootGoalId Semaphore acquired before spawn,
   released in finally
```

**Tier preference** — when multiple children share a `planId`
(zombie sibling + the actual merged-and-archived original), the tiers
break the tie:

| Tier | Predicate | Notes |
|---|---|---|
| 1   | live in-progress, `spawnedFromPlanId === planId` | most recent createdAt wins |
| 1.5 | cached `active.steps[i].subgoal.childGoalId` | wiped if stale (archived non-complete) |
| 2   | archived + `state === "complete"` | success terminal short-circuit |
| 3   | live other (todo / paused / awaiting setup) | |
| 4   | archived + `state !== "complete"` | shelved dupe — invalidate, fall through to spawn |
| 5   | rescue: `spawnedFromPlanId === undefined` matched by `(parentGoalId, title)` | back-fills `spawnedFromPlanId` |

Three-way agreement is mandatory: server-harness
(`resolvePlanStepChild` in `src/server/agent/verification-harness.ts`),
server-REST (`GET /api/goals/:id/plan` delegates to the harness's
method — single source of truth, no inline copy), and client
(`resolvePlanNodeChild` in `src/app/plan-node-state.ts`) all implement
the same preference. Plan-tab synthesis
(`src/app/plan-synthesis.ts::buildPlanSteps`) does NOT carry its own
tier logic — both the formal-plan and living-plan paths delegate to
`resolvePlanNodeChild` to pick the per-planId winner. Divergence
between any two means a tier-resolver copy crept back in. Pinned by
`tests/api-goals-plan-tier-parity.test.ts`.

## `goal_plan_propose` execution paths

`goal_plan_propose` (tool) / `PATCH /api/goals/:id/plan` (REST) takes one
of two paths depending on whether the goal's workflow has an `execution`
gate.

### Path 1 — parent workflow (execution gate present)

The full classifier + freeze flow runs:

- Server validates `dependsOn` (self-dep, unknown planId, cycle) before
  classifying.
- Returns `applied`, `requiresApproval`, or an error (e.g.
  `CRITERIA_DROP`, `RESTRUCTURE_REQUIRES_PAUSE`).
- Plan is frozen on `goal-plan` gate signal; subsequent calls run through
  the mutation classifier (see [Mutation classifier](#mutation-classifier)).

### Path 2 — non-parent workflow (`spawn-children-direct` fallback)

When the goal's workflow has no `execution` gate, `PATCH
/api/goals/:id/plan` returns `400 NO_EXECUTION_GATE`. The response body
includes:

```json
{
  "code": "NO_EXECUTION_GATE",
  "error": "Goal's workflow (...) has no 'execution' gate...",
  "warning": "degraded-execution: workflow has no execution gate. dependsOn is enforced via auto-pause on spawn — children with unmet deps will be created paused. Consider using the 'parent' workflow for full classifier/freeze flow."
}
```

The `warning` field is always present on `NO_EXECUTION_GATE` responses to
aid caller diagnostics, regardless of whether `dependsOn` was used.

The `goal_plan_propose` tool wraps this by offering a
`fallback: "spawn-children-direct"` parameter. When passed, the tool opts
into the fallback path instead of surfacing the 400 error:

1. **Pre-spawn DAG validation** — the full dependency graph is validated
   atomically before any spawn:
   - Duplicate `planId` values in the steps array → rejected.
   - Self-dependency (`dependsOn` contains own `planId`) → rejected.
   - Unknown `planId` in `dependsOn` (not in proposed steps) → rejected.
   - Cycles (detected via Kahn's algorithm) → rejected.

   If any check fails, **no children are spawned**. This is an
   all-or-nothing guard to prevent partial plan state.

2. **Topological sort** — steps are reordered by dependency order before
   spawning, so each `POST /spawn-child` call finds its `dependsOn`
   siblings already present. This prevents `UNKNOWN_PLAN_ID` on valid
   DAGs submitted in non-topological order.

3. **Spawn loop** — each step is spawned via `POST /api/goals/:id/spawn-child`
   (idempotent on `planId`). Children with unmet deps are created paused
   (`blocked: true`, `pendingDeps: [...]` in the spawn response) and
   auto-resume when their last dep merges.

#### Fallback response shape

The tool result always includes:

| Field | Type | Description |
|---|---|---|
| `fallback` | `"spawn-children-direct"` | Identifies the path taken. |
| `note` | string | Human-readable explanation of degraded mode. |
| `spawned` | array | Per-step result. Each entry: `planId`, `childGoalId`, `alreadyExists?`, `suggestedRole?`, `blocked?`, `pendingDeps?`, `error?`. |
| `spawnedCount` | number | Steps spawned successfully. |
| `failedCount` | number | Steps that errored. |

When **any step has `dependsOn`**, these additional fields appear:

| Field | Type | Description |
|---|---|---|
| `warning` | string | `"degraded-execution: workflow has no execution gate. dependsOn is enforced via auto-pause on spawn..."` |
| `blockedCount` | number | Number of children created paused due to unmet deps at spawn time. |
| `blockedPlanIds` | string[] | `planId` of each blocked child. |

The `warning` field is the signal to the team-lead that dependency
enforcement is active but the full classifier flow is not. The team-lead
should not manually re-spawn blocked children — they auto-unblock when
their dependencies merge (via `integrate-child` → `dependsOnPlanIds`
resolution).

#### Choosing a path

| Need | Recommended approach |
|---|---|
| Full plan/freeze/approve/mutation-classify flow | Create goal with `parent` workflow |
| Simple parallel or sequential child spawning without plan-lock semantics | `goal_plan_propose` with `fallback: "spawn-children-direct"` |
| Single one-off child | `goal_spawn_child` directly |

## Mutation classifier

> **Workflow-type requirement.** The full classifier + freeze + approve flow described below requires the `parent` workflow (or any workflow with an `execution` gate). Without an `execution` gate, `goal_plan_propose` falls back to `spawn-children-direct` and the classifier is unavailable. `dependsOn` auto-pause/resume still works on every workflow type — children with unmet deps are created paused and auto-resume when their last dependency merges — but fix-up/expansion/restructure classification and plan mutation approval are not. To use the full flow, create the goal with the `parent` workflow.

Once `goal-plan` is signalled, `execution.verify[]` is **frozen** by
`computePlanFreezeUpdate()` in
`src/server/agent/parent-workflow-freeze.ts` — a pure helper called
directly from the `gate_signal` route handler when the goal's workflow
is a parent meta-workflow and an `execution` gate exists. The frozen
snapshot is what subsequent reads (`GET /api/goals/:id/plan`) and the
harness scheduler use as the canonical plan. Tests:
`tests/parent-workflow-freeze.test.ts`. After freeze, further
mutations go through the classifier in
`src/server/agent/plan-mutation.ts`:

- **noop** — no effective change.
- **fix-up** — leaf added at an existing phase, no dep changes.
- **expansion** — new phase, or new dependencies.
- **restructure** — removing nodes, or changing existing deps.
- **criteria-drop** — would leave a root acceptance criterion uncovered
  (always rejected).

Decision matrix (binding):

| Output | strict | balanced | autonomous |
|---|---|---|---|
| `noop` | applied | applied | applied |
| `fix-up` | requires approval | **applied** | **applied** |
| `expansion` | requires approval | requires approval | requires approval |
| `restructure` (paused goal) | requires approval | requires approval | requires approval |
| `restructure` (non-paused) | 409 `RESTRUCTURE_REQUIRES_PAUSE` | 409 | 409 |
| `criteria-drop` | 409 `CRITERIA_DROP` | 409 | 409 |

**Severity order** is `noop < fix-up < expansion < restructure`; the
classifier reports the most severe structural kind. After the structural
pass, the criteria-coverage check OVERRIDES the kind to `criteria-drop`
if any root acceptance criterion is uncovered.

**Criteria-coverage check** is **whitespace-normalised, locale-pinned
(`toLocaleLowerCase("en")`) substring match** over the union of
`{rootSpec, every remaining subgoal step's spec}`. Hashes don't work —
they fail the moment the team-lead paraphrases. Therefore team-leads
MUST quote acceptance criteria **verbatim** in subgoal specs. The
convention is a `## Covers` heading listing the criteria the subgoal
addresses. The locale is pinned to `"en"` so Turkish and Lithuanian
locales running Bobbit don't see false `criteria-drop` errors on
dotless-i criteria (R-023 remediation).

**Step-shape validation**: `PATCH /api/goals/:id/plan` validates each
`proposedSteps[]` entry before classifying — missing `planId` or `title`,
or missing both `spec` and `subgoal.spec`, returns 400
`INVALID_PLAN_STEP {index}` instead of silently classifying the
malformed step as a `restructure`.

`replanCount` ticks up on every successful post-freeze mutation. At
`> 5`, the goal is auto-paused so a human can review the plan churn
before more replans land. Resume via
`POST /api/goals/:id/resume {cascade}`.

Pending mutation requests live in
`<stateDir>/plan-mutations/<goalId>.json` with a 24-hour TTL and survive
restart. Clients re-emit `mutation_pending` events on WS attach. A
daily `unref()`'d sweep calls `pruneExpired` so completed/abandoned
requests don't accumulate indefinitely (R-035 remediation).

## Nesting depth limit & per-goal toggle

Nested subgoals are recursive — a child can spawn grandchildren which
can spawn great-grandchildren. Without a ceiling, a runaway team-lead
(or a rogue mutation that re-proposes its own plan as a subgoal) can
fork-bomb the system: every spawn forks a worktree, a sandbox, and a
team of agents. The nesting-limit feature is the structural backstop
that prevents that, independently of the experimental Subgoals toggle.

Two layers control whether (and how deeply) a parent may spawn:

1. **System-scope ceiling** — two prefs in
   `<stateDir>/preferences.json`:
   - `subgoalsEnabled` (boolean, default `false`) — the existing
     experimental toggle.
   - `maxNestingDepth` (integer, default **3**, clamped to **1..10**)
     — the new depth ceiling.
2. **Per-goal override** — two optional fields on `PersistedGoal`:
   - `subgoalsAllowed?: boolean` — can tighten (force OFF for this
     tree) but cannot loosen a system-level OFF.
   - `maxNestingDepth?: number` — can tighten below the system ceiling
     but **never exceed it**. The server clamps the submitted value to
     `min(systemMax, clamp(value, 1, 10))` at goal-creation time.

The **system setting is the ceiling**, not just a default. Per-goal
values can only tighten. This makes the system pref a real safety lever
— flipping `maxNestingDepth: 2` system-wide retroactively caps every
live goal tree, regardless of what each goal stored.

### Depth counting convention

Depth is **parent hops from the root, plus one** — root = depth 1.

- Root goal `A` → depth 1; may spawn child `B` ✓
- Child `B` → depth 2; may spawn grandchild `C` ✓
- Grandchild `C` → depth 3; blocked from spawning `D` ✗ (would be depth 4)

The walk up the `parentGoalId` chain is bounded (cap 64 hops, cycle
guard) so a corrupt parent-pointer can never loop infinitely.

### Enforcement

The pre-spawn gate has a single source of truth — the pure helpers in
`src/server/agent/subgoal-nesting-limit.ts`:

| Function | Purpose |
|---|---|
| `readSubgoalNestingPrefs(prefsGet)` | Read system prefs with defaults + clamping. |
| `nestingDepth(goal, lookup)` | Bounded walk up `parentGoalId` chain. |
| `effectiveSubgoalsAllowed(goal, prefs)` | System OFF wins; per-goal OFF wins. |
| `effectiveMaxNestingDepth(goal, prefs)` | `min(system, goal.own)`. |
| `checkCanSpawnChild(parent, prefs, lookup)` | Structured outcome: `ok` / `SUBGOALS_DISABLED` / `NESTING_DEPTH_EXCEEDED`. |
| `inheritedChildOverrides(parent, prefs)` | Effective values to stamp on a new child. |

Both spawn paths consume `checkCanSpawnChild` and react identically:

- **`POST /api/goals/:id/spawn-child`** (in
  `src/server/agent/nested-goal-routes.ts`) — idempotency check runs
  FIRST (re-calls with the same `planId` on an already-spawned child
  still succeed even when the limit would now reject a fresh spawn).
  Then `checkCanSpawnChild` runs against the parent and returns one of:
  - `403 { error, code: "SUBGOALS_DISABLED" }` — subgoals disabled for
    this goal tree (system OFF, or parent's `subgoalsAllowed === false`).
  - `403 { error, code: "NESTING_DEPTH_EXCEEDED", currentDepth, maxDepth }`
    — spawning would push the child past the effective ceiling.
- **`runSubgoalStep`** in the verification harness
  (`src/server/agent/verification-harness.ts`) — runs the SAME check
  before spawning. On block, the verify-step fails with
  `passed: false` and a readable `output` (`"Subgoal spawn blocked:
  nesting depth limit reached (3/3)."` or `"...subgoals are disabled for
  this goal tree."`). The gate fails cleanly with the explanation in the
  verification report — no crash, no infinite-retry. The check runs only
  on the spawn path: if the child is already resolved via tier-1/3/5 or
  the cached pointer, idempotent re-runs skip the check and continue.

### Inheritance — descendants can't loosen ancestors

When either spawn path creates a child, it stamps the parent's
**effective** values onto the child via `inheritedChildOverrides`:

```ts
child.subgoalsAllowed = effectiveSubgoalsAllowed(parent, prefs);
child.maxNestingDepth = effectiveMaxNestingDepth(parent, prefs);
```

This means: even if the system pref later widens (e.g.
`maxNestingDepth: 3` → `5`), every existing descendant of a goal that
was created under the tighter ceiling stays bounded by its parent's
stamped value. Loosening at the system level cannot retroactively
extend an in-flight tree past where its ancestors already capped it.
A child's own `maxNestingDepth` is always clamped to `min(system,
parent.effectiveMax)` on creation.

`POST /api/goals` (top-level goal creation) accepts the same fields in
the body and applies the same clamp: an attempt to set
`maxNestingDepth: 9` while the system pref is `3` lands as `3` on the
persisted goal.

### UI surfaces

Both controls render **only when the system Subgoals toggle is ON** —
they share the same experimental gate.

**Settings → System → General** (below the Subgoals toggle):

- A **Max subgoal depth** stepper with `↓`/`↑` buttons and a reset
  link (testid `general-max-nesting-depth`). Click `↓` to decrement,
  `↑` to increment, clamped to `1..10`. Persisted via
  `PUT /api/preferences { maxNestingDepth: N }`; the server clamps and
  broadcasts `preferences_changed`. Greyed out when Subgoals is OFF.
- The client mirrors the value to
  `document.documentElement.dataset.maxNestingDepth` so the goal
  creation panel can read it synchronously without an await — same
  pattern as `subgoalsEnabled` (see
  [design/subgoals-experimental-toggle.md](design/subgoals-experimental-toggle.md)).

**Goal creation form** — rendered in two surfaces:

- **Goal-proposal modal** (in the team-lead / assistant chat, when
  `propose_goal` is called or the assistant prompts the user).

The standalone goal creation panel uses the same `renderGoalForm`
component, but does not currently wire these proposal-only override
callbacks. In the proposal modal, the per-goal controls appear below the
parent/depth section:

- An **Allow subgoals** checkbox (testid `goal-form-subgoals-toggle`).
  Default inherits from `isSubgoalsEnabled()`. When the system pref is
  OFF the checkbox is unchecked and greyed out — a per-goal flag cannot
  override a system-level OFF. Unchecking it disables subgoals for this
  specific goal tree.
- A **Max depth** number input (testid `goal-form-max-depth`), visible
  only when Allow subgoals is ON. Default inherits from
  `getSystemMaxNestingDepth()`. Clamped to `[1, systemCap]` — the
  per-goal value can only tighten, never exceed the system ceiling. The
  submit path only sends the override when the user has touched it;
  otherwise the field is omitted and the server resolves from prefs.

The enforcement is **purely server-side**. The UI controls are UX —
if a rogue agent bypasses the panel and POSTs a higher `maxNestingDepth`
directly, the server still clamps to the system ceiling and the
spawn-time `checkCanSpawnChild` gate still applies. The Subgoals tool
description (`defaults/tools/children/goal_spawn_child.yaml`) calls out
the two 403 codes so agents understand why a spawn might be rejected.

### Tests

- `tests/subgoal-nesting-limit.test.ts` — pure helper coverage:
  clamping, depth walk (including cycle-guard), effective-values, gate
  outcomes, child inheritance.
- `tests/e2e/api-goals-spawn-child-nesting.spec.ts` — REST roundtrip:
  `SUBGOALS_DISABLED` when subgoals are off; `NESTING_DEPTH_EXCEEDED`
  at depth+1 > max; idempotent re-call accepted past the limit.
- `tests/e2e/ui/subgoal-nesting-limit.spec.ts` — settings stepper +
  goal-creation panel controls + persistence across reload.
- `tests/e2e/ui/goal-proposal-form.spec.ts` — proposal modal: toggle
  visibility, max-depth hide/show, created goal has correct
  `subgoalsAllowed` / `maxNestingDepth` fields via `GET /api/goals/:id`.
- `tests/proposal-form-controls-source-pinned.test.ts` — source-pin:
  asserts `render.ts` contains `goal-form-subgoals-toggle` and
  `goal-form-max-depth` test ids (catches silent merge-loss regressions).

## Concurrency

A single `Map<rootGoalId, Semaphore>` lives on the harness instance.
Capacity is resolved once on first use via
`GoalManager.resolveRootMaxConcurrentChildren(rootGoalId)`:

| Setting | Value |
|---|---|
| default permits | 3 |
| hard max | 8 (defensive cap on user input) |
| floor | 1 (never zero — would deadlock the harness) |
| unknown root fallback | 3 |

The semaphore IS the scheduler. There is no background poll loop; each
`runSubgoalStep` invocation acquires a permit before spawn and holds it
until the child's `ready-to-merge` resolves (or until the 24h
`MAX_WAIT_MS` ceiling fires — see Recovery patterns). `maxConcurrentChildren`
is configured on the **root goal only** via `goal_set_policy` /
`PATCH /api/goals/:id/policy`; sub-goal values are stored for
forward-compat but inert.

## Divergence policy

`divergencePolicy` controls how the mutation classifier handles plan
changes after `goal-plan` is signalled. Values: `"strict"`,
`"balanced"` (default), `"autonomous"` — see the
[Mutation classifier](#mutation-classifier) decision matrix for what
each implies. The field is **root-goal-only** and is consulted by the
harness at runtime. Sub-goal values can be persisted but are inert.

**No dashboard UI yet.** The policy is settable via the team-lead-only
`goal_set_policy` tool and the underlying
`PATCH /api/goals/:id/policy` REST endpoint (which broadcasts the new
values inline on `goal_state_changed`). Until a dashboard surface
lands, the user-visible signal of policy state is the auto-pause that
kicks in past `replanCount > 5`.

## Restart resilience

Restart is a fact of life — every test cycle and every deploy hits it.
The feature ships with the following invariants (see
[debugging.md](debugging.md) for the full diagnostic checklists):

- **Restart-interrupted verifications mark the gate `pending`, not
  `failed`**. The conjunctive predicate
  `shouldSuppressRestartInterrupt` in
  `src/server/agent/verification-logic.ts` requires every failed step to
  match a `RESTART_INTERRUPT_MARKERS` entry; real failures still fail
  the gate.
- **Boot respawns sessionless in-progress goals.**
  `TeamManager._bootRespawnSessionlessGoals` runs at the end of
  `resubscribeTeamEvents` and walks every non-archived
  `state: in-progress, setupStatus: ready, team: true` goal with no
  team entry, calling `startTeam` to spin up a fresh team-lead.
- **Crash-loop guard** caps automatic restarts at 5 quick crashes within
  10s of launch. After the threshold the harness logs
  `Run "npm run restart-server" to resume after fixing the root cause`
  and stops auto-restarting. A manual restart trigger clears the
  counter.
- **Auto-revive dead RPC bridges.** Two new-prompt sites in
  `enqueuePrompt` route through
  `SessionManager._dispatchPromptWithReviveOnDeadBridge`, which checks
  `rpcClient.running`, calls `restartAgent` if dead, and re-resolves
  the SessionInfo before dispatching.
- **Auto-archive zombie sessions.** A row with neither an
  `agentSessionFile` nor a `role` is unrecoverable; `restartAgent`
  archives it and throws `code: "SESSION_UNRECOVERABLE_ARCHIVED"`.
- **Resumed reviewers wait for `agent_start` before racing waitForIdle**
  (`waitForStreaming` semantics). All four reminder sites in `verification-harness.ts`
  await `SessionManager.waitForStreaming(sessionId, 10_000)` before the
  existing `waitForIdle` race.
- **Reviewer kind persisted.** `TeamAgent` and
  `PersistedTeamEntry.agents[].kind: "worker" | "reviewer"`;
  `resubscribeTeamEvents` skips reviewers on restart and `notifyTeamLead`
  has the same defensive guard.

## Cascade UX

Pause / resume / archive / team-teardown on a parent goal with
descendants requires an explicit `cascade: boolean` parameter (or
`?cascade=` query) on the REST call — server returns
**422 `{code: "CASCADE_REQUIRED"}`** when omitted, uniformly across
every cascade-affecting route. The UI is the cascade-policy authority:

- `showArchiveGoalDialog` — when descendants exist, sends `cascade=true`
  unconditionally; the "Archive descendants too" checkbox stays checked
  read-only because session teardown is intrinsic to archive and cannot
  be unchecked.
- `showPauseGoalDialog` / `showResumeGoalDialog` — toggleable cascade
  checkbox because pause/resume semantics support both modes.
- Goals with zero descendants fall through to the existing
  `confirmAction("Archive Goal", …)` flow — no UX regression for
  single-goal users.

`DELETE /api/goals/:id?cascade=true|false` returns
**409 `{code: "HAS_DESCENDANTS", count}`** when `cascade=false` and
descendants exist, so the UI can prompt for confirmation.

`POST /api/goals/:id/team/teardown?cascade=true|false` mirrors the same
contract for stopping a parent's team. With `cascade=false` (the
default), the server pre-flights the descendant tree (BFS via
`parentGoalId`, skips archived) and returns
**409 `{code: "HAS_DESCENDANT_TEAMS", count, descendants:[{id,title}]}`**
if any descendant goal still has a live team. With `cascade=true`, walks
descendants depth-first, tears down each team, then the parent;
returns `{ok: true, toreDown: N, errors: []}`. Each teardown is
best-effort (`getTeamState` guard + try/catch) so one missing/error team
doesn't stop the rest. The client wrapper `teardownTeamWithDialog(goalId)`
in `src/app/api.ts` pre-flights `cascade=false` and on 409 opens
`showStopTeamDialog` (the same pattern as showArchive/Pause/Resume) for
explicit confirmation. Wired into the dashboard's `handleEndTeam`.

## Pause / resume

`POST /api/goals/:id/pause {cascade:true}` must actually stop the work,
not just flip a flag. Before this fix the handler set `paused:true` on
every descendant and returned `{paused:N}` while team-leads, coders,
reviewers and `llm-review-*` verifier sessions kept streaming — and the
boot-respawn supervisor immediately re-created any team-lead an operator
manually aborted. Operators chasing a runaway subtree played whack-a-mole.

The fix shuts three holes with one helper plus narrow guards at every
spawn site. See [docs/design/pause-cascade.md](design/pause-cascade.md)
for the full design.

### What `pause {cascade:true}` does

See [docs/design/pause-cascade.md](design/pause-cascade.md) for the full
implementation description. In brief:

1. Walks the descendant set (BFS via `parentGoalId`), sets `paused:true`
   on each, and cancels in-flight gate verifications via
   `cancelAllVerifications(goalId)` (this also terminates the
   `llm-review-*` reviewer sessions tracked in `activeVerifications`).
2. Sweeps every session in `SessionManager.getAllSessionsRaw()` whose
   `goalId` is in the paused subtree and calls `abortSessionTurn(id)` —
   a **soft interrupt** (sessions stay registered, ready to be resumed)
   rather than the old `forceAbort`. Best-effort: errors are logged and
   do not block the rest of the sweep. The caller's own session is
   **excluded** from the sweep (via `x-bobbit-spawning-session` /
   `x-bobbit-session-id` headers) so a coordinator pausing its own
   subtree does not abort itself mid-turn.
3. Returns `{paused: N}` where `N` is the number of goals newly flipped
   (re-pausing an already-paused goal is a no-op and is not counted).

### Spawn-path guards (409 `GOAL_PAUSED`)

While a goal is paused, every code path that would create a session on
it refuses with

```json
{ "error": "Goal <id> is paused", "code": "GOAL_PAUSED", "goalId": "<id>" }
```

at HTTP status `409`. The shape mirrors the existing
`GateDependencyError` convention. Guarded sites:

| Site | Where the guard lives |
|---|---|
| `POST /api/goals/:id/team/spawn` | Inline check before `teamManager.spawnRole(...)`. |
| `POST /api/goals/:id/team/start` | Catches `GoalPausedError` thrown by `TeamManager._startTeamImpl` and translates to 409 (the in-process throw lets team-lead extension callers that bypass REST also fail safely). |
| `POST /api/goals/:id/spawn-child` | Inline check on the parent goal, BEFORE the `planId` idempotency check — a re-spawn of the same `planId` on a paused parent is still a spawn intent the operator wants blocked. |
| `POST /api/goals/:id/gates/:gateId/signal` | Inline check at the most upstream point — rejects both the gate-signal accept and the verifier spawn it would otherwise trigger. |
| `TeamManager.spawnRole`, `TeamManager._startTeamImpl` | Throw `GoalPausedError` (defence-in-depth for in-process callers — the children-tools extension calling `team_spawn` MCP bypasses REST). |
| `VerificationHarness.runLlmReviewViaSession` | Throws before `createSession`, closing the race window between gate-signal accept and the deeper-descendant pause flag being set. |

The single shared primitive lives in
`src/server/agent/goal-paused-guard.ts`: `GoalPausedError` (with
`code: "GOAL_PAUSED"`, `status: 409`) and `requireGoalNotPaused(goalId,
lookup)`. REST handlers catch and re-shape; in-process callers let it
propagate.

### Supervisor respawn skip (the whack-a-mole fix)

`TeamManager._bootRespawnSessionlessGoals` runs on boot and on
`resubscribeTeamEvents` to re-create a team-lead for every
`state:"in-progress"` goal that no longer has a live session. Before the
fix, manually aborting a team-lead on a paused goal triggered this loop
and a fresh team-lead appeared within seconds. The loop now skips any
goal with `paused:true`, so a paused subtree stays paused even when an
operator force-kills sessions externally. This single guard is the
highest-impact change in the fix — it is what makes pause actually
stick.

Pinned by `tests/team-manager-boot-respawn-sessionless.test.ts` (source
grep + `shouldRespawn` mirror, so the predicate can't drift without a
test failure).

### Resume semantics

`POST /api/goals/:id/resume {cascade:true}` walks the same descendant
set and clears `paused:false`. It does **NOT** auto-restart team-leads,
coders, or reviewers — the operator restarts work manually via
`POST /team/start` or the UI button. Auto-restart on resume was
explicitly rejected: resume's contract is "allow new spawns again",
not "replay the subtree".

The `dependsOn`-on-completion auto-unpause interaction (where a child
becomes runnable after its dependency completes) is owned by a separate
fix and is intentionally out of scope here.

### Integration tests

Three e2e tests under `tests/e2e/` pin the contract:

- `pause-cascade-aborts-sessions.spec.ts` — subtree sessions stop within
  5 s; 409 `GOAL_PAUSED` from `team/spawn`, `spawn-child`, gate signal;
  resume re-enables spawn.
- `pause-cancels-verifiers.spec.ts` — pause cancels an in-flight slow
  command verification within 5 s; no replacement reviewer appears.
- `pause-blocks-supervisor-respawn.spec.ts` — drives
  `_bootRespawnSessionlessGoals` directly while the goal is paused and
  asserts no team-lead respawn.

## Sub-goal sidebar placement

### Cascade resolution at spawn time

`spawnedBySessionId` is the field the sidebar uses to nest a sub-goal
under its spawning team-lead. If it's missing, the sidebar would
historically misattribute the orphan child under whichever sibling
team-lead happened to look closest — visually wrong and confusing
when collapsed. The fix is to populate the field reliably at the
source (every spawn path) AND to fall back strictly on the
render side as defence in depth.

Resolution at `POST /api/goals/:id/spawn-child` and inside
`verification-harness.runSubgoalStep` runs through the single pure
helper `resolveSpawnedBySessionId` (`src/server/agent/spawn-child-spawnedby.ts`)
so a future tweak lands in one place. Tier order, highest precedence first:

1. `body.spawnedBySessionId` — explicit caller claim.
2. `x-bobbit-spawning-session` header — set by the children-tools
   extension (`defaults/tools/children/extension.ts`).
3. `x-bobbit-session-id` header — defence in depth for raw cURL or
   scripted callers issued from inside an agent (every other tool
   extension already sends this header).
4. Parent goal's live team-lead via
   `teamManager.getTeamState(parentGoalId)?.teamLeadSessionId` —
   matches what `runSubgoalStep` derives natively. "This child was
   spawned in the parent's team-lead context."
5. Fallback: leave `spawnedBySessionId` undefined, log a single
   `console.warn` at the spawn-child handler so it's diagnosable, and
   trust the sidebar's strict-parent attribution to render correctly.

The helper is silent — it only returns `{ value, tier }`. The caller
decides whether to log. Empty-after-trim values at any tier fall
through to the next tier; array-valued headers coerce to the first
element. See the AGENTS.md recipe entry
*`spawnedBySessionId` cascade at `POST /spawn-child`* for the
one-line summary.

The render-side companion lives in `selectSpawnedChildren`
(`src/app/sidebar-spawned-children.ts`): when a sub-goal has
`spawnedBySessionId === undefined`, it only attaches to its parent's
OWN team-lead (the optional `parentLeadId` argument) — never a
sibling's. Render call sites in `src/app/render-helpers.ts` pass
`parentLeadId` only when the iterated lead actually belongs to the
parent goal, so an unstamped orphan can never get pulled under an
unrelated sibling team-lead. Both the live `renderTeamGroup` branch
and the archived `renderLeadWithMembers` branch follow the same rule.

### `spawnedBySessionId` semantics (R-045)

`spawnedBySessionId` captures the session id of the team-lead **at the
moment `goal_spawn_child` was called** — it is the SPAWNING session
at creation time, not necessarily the team-lead session that is live
right now. The two diverge when:

- The original team-lead was torn down and a new team-lead was spawned
  for the same parent goal (re-attempt, transient-error restart). The
  child still points at the old, now-archived team-lead via
  `spawnedBySessionId`. This is intentional — the field records
  attribution ("this team-lead instance owned this delegation") rather
  than a live pointer.
- A legacy sub-goal pre-dates the field and `backfillSpawnedBySessionId`
  fills it in. The backfill helper uses the parent's *currently
  persisted* `teamLeadSessionId`, not a historical one — so for legacy
  records the field is approximated by "team-lead session id of the
  parent goal at backfill time". This is the slight-but-acceptable
  divergence under multi-team-lead history; treat backfilled values as
  best-effort attribution, not provenance.

Render code never assumes the spawning session is live. The archived
render path folds sub-goals whose spawning session is gone back to the
parent-goal level via the deterministic `computeSpawnedClaim` set in
`src/app/sidebar-spawned-children.ts` (Path A claims, Path B excludes —
used by both desktop `renderProjectContent` and mobile
`renderMobileLanding`).

Sub-goals stamped with `spawnedBySessionId` render INSIDE the spawning
team-lead's expanded block in the sidebar — collapsing that team-lead
hides both its workers AND the sub-goals it spawned, as one unit. The
test-id is `sidebar-spawned-child-row` and each row carries a
`data-spawned-by` attribute pointing back at the spawning session.

Render sites (in `src/app/render-helpers.ts`):

- `renderTeamGroup` — for **live** team-leads: any goal where
  `parentGoalId === goal.id && spawnedBySessionId === teamLead.id` is
  rendered inside the `tlExpanded` block alongside delegate workers and
  archived members. Reuses `renderGoalGroup` recursively so the sub-goal
  has its own chevron, descendant-count badge, and team rendering.
- `renderLeadWithMembers` — for **archived** team-leads of a still-live
  parent goal: the archived lead's expanded block renders its stamped
  archived sub-goals via `renderSpawnedChildGoalRow`. The chevron shows
  whenever there's any content (members OR sub-goals).

The parent-level forest in `src/app/sidebar.ts::renderProjectContent`
(and the mirror filter in `src/app/render.ts::renderMobileLanding`)
excludes goals already rendered under a team-lead via the deterministic
`computeSpawnedClaim` helper in `src/app/sidebar-spawned-children.ts`.
The helper covers ANY-status live team-leads plus archived team-leads
when `state.showArchived` is on, and unions the result of
`selectSpawnedChildren` for every (parent, lead) tuple — so stamped,
unstamped (parent-lead fallback), and grandchild cases all line up.
Sub-goals fall back to parent-forest level only when no team-lead
session exists at all for the parent — never unreachable. See AGENTS.md
"Goal rendered twice in sidebar (live, mid-flight)" and
`tests/sidebar-no-double-render.test.ts`.

**Boot-time backfill** for legacy records:
`GoalManager.backfillSpawnedBySessionId(teamStore, sessionStore?)` walks
every sub-goal (live or archived) missing the field and stamps it from
the parent's persisted team-lead session id. Lookup precedence: (1) the
parent's `TeamStore` entry's `teamLeadSessionId`; (2) `SessionStore`
fallback — sessions with `role === "team-lead"` and
`teamGoalId === parentGoalId` (or `goalId === parentGoalId`); a single
match wins, multiple matches are ambiguous and skipped. Idempotent
(only writes when the field is absent), per-goal try/catch (endless-restart guard
endless-restart guard). Wired in `src/server/server.ts` immediately
after `restoreTeams`, alongside `backfillCompleteState`. The spawn-child
route itself was extracted from `server.ts` into
`src/server/agent/nested-goal-routes.ts` (alongside the other
nested-goal REST handlers); the backfill call site is unchanged. Logs
`[goal-manager] Backfilled spawnedBySessionId=<sid> for legacy sub-goal
<gid>` per stamped goal.

## Ephemeral roles & workflows (goal-scoped)

By default, roles and workflows live in the project's permanent library
and are reusable across goals. For one-off cases — an audit-specific
synthesis-reviewer that doesn't belong in the project's role manager;
a bespoke gate sequence for a single bug-fix — both can be **snapshotted
onto the goal record** and resolved BEFORE the project cascade.

**Inline workflows** (existing, Phase 5b): pass `body.workflow` (a full
Workflow object) on `POST /api/goals` or `goal_spawn_child`. The server
deep-clones it to `goal.workflow`. The runtime uses the snapshot, not a
re-lookup against the workflow store, so subsequent edits to the
project's stored workflows don't affect this goal.

**Inline roles**: pass `body.inlineRoles: Record<roleName, Role>` on the
same endpoints. Snapshotted to `goal.inlineRoles`. Resolution happens via
the pure helper `resolveRole(goal, name, roleStore)` in
`src/server/agent/resolve-role.ts`:

1. `goal.inlineRoles[name]` — wins if present
2. `roleStore.get(name)` — project → server → builtin cascade

`listAvailableRoles(goal, roleStore)` unions both sources for fail-loud
"Role X not found" error messages. Three call sites use this:
`team-manager.ts::spawnRole` and three sites in
`verification-harness.ts` (model-resolution for sub-sessions, `llm-review`
reviewer pickup, `agent-qa` qa-tester pickup). Any new role-lookup site
MUST go through `resolveRole`.

**Inheritance** — when `goal_spawn_child` spawns a child OR a `subgoal`
verify-step runs through `runSubgoalStep`, both the roles AND the
workflow are inherited from the parent (the harness path was previously
an asymmetric special-case; R-001/R-002/R-003 remediation aligns it
with the REST path):

- `inlineRoles`: server merges `parent.inlineRoles` with
  `body.inlineRoles` (`{...parent, ...body}`). Child entries with the
  same name override the parent's; new names extend the set. A parent
  goal can define audit-wide roles once (e.g. `synthesis-reviewer`) and
  every spawned subgoal inherits them automatically. The subgoal
  verify-step path (`runSubgoalStep` in `verification-harness.ts`) now
  also propagates `parent.inlineRoles` to the child it spawns, matching
  the `goal_spawn_child` merge contract.
- `goal.workflow`: precedence is `body.workflow` (inline override) →
  `parent.workflow` routed through `stripSubgoalStepsForChildInheritance`
  (see below) → `body.workflowId` lookup against the project workflow
  store. So a parent that proposed an `inlineWorkflow` propagates its
  structural scaffold (gates, dependencies, ready-to-merge) to every
  child unless the agent explicitly overrides. To use a different
  STORED workflow on the child, pass `workflowId`; to use a different
  one-off workflow, pass `inlineWorkflow`.

**`stripSubgoalStepsForChildInheritance`** (in `src/server/agent/workflow-store.ts`)
runs on every inherited meta-workflow snapshot (`isParentMetaWorkflow`
= id === "parent" OR execution gate contains subgoal verify-steps).
The four-tier child-workflow cascade (highest precedence first) is
encoded in the pure helper `resolveChildWorkflow` in
`src/server/agent/spawn-child-workflow.ts`:

1. `body.workflow` — explicit inline workflow object on the spawn call.
2. `body.workflowId` / `sg.workflowId` — registered workflow looked up
   in the project's `workflowStore`.
3. `parent.workflow` — deep-cloned via `structuredClone` and routed
   through `stripSubgoalStepsForChildInheritance` (this section).
4. `"feature"` from the workflow store, falling back to the first
   non-hidden workflow if `"feature"` is missing.

Used today by `runSubgoalStep`; the REST `POST /spawn-child` handler
still has its own inline cascade (a TODO in the helper notes the
follow-up to consolidate). Tests:
`tests/spawn-child-workflow-resolution.test.ts` (12 cases).

The strip itself does the following:

1. Strips `type: "subgoal"` entries from `execution.verify[]` — the
   parent's plan items don't belong on the child.
2. Drops any gate strictly between `execution` and `ready-to-merge` in
   the DAG. Those gates (e.g. `integration` in the builtin `parent`
   workflow, `synthesis` in custom research-style parent workflows)
   aggregate across children — "all 5 sibling artefacts exist",
   "cross-component integration review". A child goal can never
   satisfy them; inheriting would deadlock the child on
   `ready-to-merge`.
3. Rewires `ready-to-merge.dependsOn` to depend directly on
   `execution`, since the intermediate aggregation gates are gone.

Upstream gates (charter, plan-review, goal-plan) are preserved — they
make sense at both levels. For non-meta workflows (the `feature`,
`bug-fix`, `general` shapes), this helper is a pure deep-clone —
nothing is altered. Tests: `tests/child-workflow-inheritance.test.ts`
pins the strip contract; `tests/runSubgoalStep-inline-roles-inheritance.test.ts`
pins the role propagation through the subgoal-verify-step path.

**Critical companion** for the inheritance to actually work: spawn-child
calls `gateStore.initGatesForGoal(child.id, child.workflow.gates.map(g
=> g.id))` after `createGoal`. Without this, the child has
`goal.workflow` populated but the gate store has no entries, so
`gate_list` / `gate_signal` / `gate_status` / `gate_inspect` and the
verification harness all see `[]` despite a populated workflow.

**When to use what**:

| Need | Tool | Lifetime |
|---|---|---|
| Role useful across many goals | `propose_role` | permanent (project library) |
| Role only useful for ONE goal (and its subgoals) | `inlineRoles` on `propose_goal` / `goal_spawn_child` | snapshotted; lives with the goal |
| Workflow useful across many goals | `propose_project` with `workflows: { ... }` | permanent (project library) |
| Workflow only for ONE goal | `inlineWorkflow` on `propose_goal` / `goal_spawn_child` (`body.workflow` on REST) | snapshotted; lives with the goal |

The `propose_role.yaml` and `propose_goal.yaml` tool descriptions surface
this trade-off so agents pick the right tool. Decision rule: "will any
goal OTHER than this one need this role/workflow?". If yes → permanent.
If no → ephemeral. When in doubt, prefer ephemeral — easier to undo.

Tests pinning the contract: `tests/resolve-role.test.ts` (pure helper
precedence), `tests/goal-manager-inline-roles.test.ts` (snapshot +
parent-child merge), `tests/e2e/api-goals-spawn-child-route.spec.ts`
(full HTTP roundtrip including parent-inheritance).

## Cost rollup

Parent-goal dashboards walk the descendant tree (via the `rootGoalId`
chain, BFS, depth capped at 32) and sum each goal's accumulated cost.

```
GET /api/goals/:id/tree-cost
→ {
    rootGoalId,
    totalCostUsd,
    totalTokensIn,
    totalTokensOut,
    breakdown: [{ goalId, depth, title, costUsd, tokensIn, tokensOut }, …]
  }
```

The handler resolves the rollup root as `goal.rootGoalId ?? goal.id`, so
a request against a child goal still returns the WHOLE-TREE rollup. The
breakdown is sorted `depth ASC, createdAt ASC` (root first, deepest
descendants last). Archived descendants are still counted — cost
survives archival. Goals belonging to a different tree are excluded by
the filter `g.id === rootGoalId || g.rootGoalId === rootGoalId`.

The cache lives on the existing `CostTracker` (per-tracker WeakMap keyed
by `rootGoalId`). `costTracker.getGeneration()` ticks monotonically on
every cost mutation, so cache invalidation is free. The dashboard
renders `Tree cost: $X.XX` above the per-goal cost; click expands a
per-child breakdown table.

### Purge-survival: goalId stamping

The natural way to roll up cost per goal is to look up each goal's
sessions in `sessionStore`, then sum `costTracker.costs[sessionId]` for
those ids. That mapping breaks the moment a session is purged: the
7-day archive sweep (and the post-merge cleanup paths) deletes the
session record from `sessionStore`, but cost entries on disk persist.
The dollars are still there, just unreachable by goal lookup —
archived goals end up showing `$0.0000` in the tree-cost breakdown
even though they accumulated real cost.

Fix: stamp `goalId` directly onto each cost entry at record time, so
cost is addressable by goalId without ever consulting `sessionStore`.

- `SessionCost.goalId?: string` (in `src/server/agent/cost-tracker.ts`)
  — optional, additive, forward-compatible on disk.
- `recordUsage(sessionId, usage, goalId?)` is the only writer. `goalId`
  is **write-once**: stamped on the first call that supplies one, never
  overwritten by subsequent calls (guards against pathological
  re-association across goals). Non-goal sessions (assistants, staff)
  omit it and keep aggregating via `getSessionCost`.
- The single call site is `SessionManager.trackCostFromEvent` (in
  `src/server/agent/session-manager.ts`), which already has the live
  `SessionInfo` and passes `session.goalId ?? session.teamGoalId`.
- `getGoalCost(goalId)` (one-arg) scans `costTracker.costs` by stamped
  `goalId`. Primary path — does not touch `sessionStore`. The legacy
  two-arg form `getGoalCost(goalId, sessionIds)` is retained as an
  explicit-scope overload for tests and any caller that wants to scope
  by a specific session set.
- `computeTreeCost` uses the one-arg form for every member of the tree.
  Its `sessionIdsForGoal` resolver is now an **optional fallback** —
  consulted only when the stamped-by-goalId aggregate for a given goal
  is empty, so legacy data that predates the stamp (and any test
  scaffolding that records cost without a goalId) still rolls up.

Backed by `tests/cost-tracker-goal-stamp.test.ts` (write-once,
one-arg/two-arg overloads), `tests/cost-tracker-backfill.test.ts`
(boot-time backfill), and `tests/tree-cost-purge-survival.test.ts`
(end-to-end: cost survives session purge).

### Boot-time backfill

Cost entries recorded before goalId stamping existed have
`goalId === undefined`. Even after the forward fix landed, entries from
sessions that were **purged before the fix** remain unstamped: the live
`sessionStore` no longer has a record, so the simple
`sessionStore`-only resolver can't recover the mapping.

The boot-time backfill is implemented in
`src/server/agent/cost-backfill.ts` (`backfillLegacyCostGoalIds`). It
runs once after all session state is restored and tries two paths in
order for each unstamped entry:

1. **Live persisted session record** — `sessionManager.getPersistedSession(sessionId)`, preferring `teamGoalId` then `goalId`. If the record exists but has neither field, the sidecar next to its `.jsonl` file is read as a sub-step.
2. **Sidecar index scan** — if the session record is gone entirely, `buildSidecarGoalIdIndex` walks the agent sessions root two levels deep (`<slug>/<id>.bobbit.json`), parses every sidecar, and builds a `bobbitSessionId → teamGoalId` map. This path recovers goals for sessions purged after the session-sidecar feature landed (`a71963d9`).

Entries that survive both passes (no live record, no sidecar, or sidecar predates the sidecar feature) are left unstamped. The backfill is
idempotent — already-stamped entries are skipped — and bumps the
generation tick only when at least one entry is actually updated.
Boot log:

```
[cost-backfill] stamped goalId on N entries; M still unattributable
```

Pinned by `tests/cost-backfill.test.ts` and `tests/e2e/cost-backfill-on-boot.spec.ts`.

### Unattributable legacy bucket

Entries that remain unstamped after the backfill are **not silently
absorbed into the parent goal's total**. Instead they are accumulated
into a separate bucket via `CostTracker.getUnattributableLegacyCost()`
(all entries where `goalId` is unset) and stored under the sentinel
`UNATTRIBUTABLE_LEGACY_GOAL_ID = "__unattributable__"`.

The `/tree-cost` endpoint appends an optional `unattributableLegacy`
field to the response when the bucket is non-empty:

```json
{
  "rootGoalId": "...",
  "totalCostUsd": 1.234,
  "...": "...",
  "unattributableLegacy": {
    "goalId": "__unattributable__",
    "title": "Unattributable (legacy)",
    "costUsd": 0.0056,
    "tokensIn": 1200,
    "tokensOut": 300
  }
}
```

This bucket is **not** included in `totalCostUsd` — it is informational
only. The tree-cost panel renders it as a muted italic row at the
bottom of the breakdown table when non-empty (testid
`tree-cost-row-unattributable-legacy`), labelled _Unattributable
(legacy)_.

### On-disk schema

`<projectStateDir>/session-costs.json` is a flat object keyed by
sessionId. Each value is a `SessionCost` record; `goalId` is omitted
when unset:

```json
{
  "sid-abc": {
    "inputTokens": 1234,
    "outputTokens": 567,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0,
    "totalCost": 0.0123,
    "goalId": "goal-xyz"
  }
}
```

The field is purely additive — older servers reading a stamped file
ignore the key, and newer servers reading an un-stamped file leave
`goalId` undefined (and the backfill picks it up if the session is
still in `sessionStore`).

Row visibility is data-driven — gated on `treeCost.breakdown.length > 1`
or `currentGoal.parentGoalId`, not on the client's `state.goals` list.
This matters because `state.goals` excludes archived goals when "See
Archived" is off; using it as the gate would hide the row after every
child was archived (e.g. after `goal_merge_child` auto-archives them),
even though the rollup still reflects real cost. The server-side
breakdown already counts archived descendants, so it's the canonical
signal.

## Plan tab

The Plan tab is visible if **either**:

1. The goal's workflow has a `goal-plan` gate (formal plan), OR
2. The goal has any children — live OR archived — (living plan —
   synthesise from the full child history, layered topologically by
   explicit `dependsOnPlanIds`). Children with no declared deps render
   as parallel siblings at column 0 with no edges; see [Declaring
   dependencies](#declaring-dependencies).

Synthesis (`src/app/plan-synthesis.ts::buildPlanSteps`) recomputes from
the full goal tree (including archived descendants) on every render, so
the Plan tab is a living document of the goal's complete child history.
Goals with formal plans + ad-hoc children get the formal plan plus
orphans appended past the formal max phase.

### Data source: `dashboardGoalPool()` and `/descendants`

The Plan tab reads from a **dashboard-local goal pool**, not from the
sidebar's live `state.goals` list. `state.goals` excludes archived goals
when the sidebar's "See Archived" toggle is off, which used to silently
drop archived siblings from the Plan-tab DAG. The fix:

- `GET /api/goals/:id/descendants` returns full `PersistedGoal` records
  for every descendant of the goal (live + archived), via the pure
  `collectDescendants(rootId, allGoals)` BFS helper in
  `src/server/agent/goal-descendants.ts` (depth cap 32). The route is
  intentionally NOT gated by `requireSubgoalsEnabled()` — Plan tab is
  core dashboard functionality, not subgoals-experimental.
- `dashboardGoalPool()` in `src/app/goal-dashboard.ts` merges
  `state.goals` (live, freshest) with the locally cached
  `dashboardDescendants` slice and dedupes by id.
- `shouldShowPlanTab`, `computePlanStepsForGoal`, and `renderPlanTab` all
  read from this merged pool. The Plan tab is therefore decoupled from
  the sidebar's archived-visibility filter — toggling "See Archived"
  does NOT change Plan-tab content.
- The descendants slice is refetched on dashboard load and on
  `schedulePlanRerender` (5s debounce, mirroring tree-cost), and reset
  on goal-change.

### Visual distinction for archived nodes

Archived plan-DAG nodes are marked `data-archived="true"` on the SVG
`<g data-testid="plan-node">`, rendered with `opacity:0.55`, a dashed
stroke, and a small inline "archived" pill (testid
`plan-node-archived-pill`) so users can tell archived from live at a
glance without hovering. Live and archived children are visually
distinguishable in the same DAG.

E2E coverage: `tests/e2e/ui/plan-tab-archived-children.spec.ts` archives
a child via REST, reloads the parent dashboard, opens the Plan tab, and
asserts the archived child renders with `data-archived="true"`.

The Plan tab DAG SVG renders nested sub-trees inline. Each
plan node card has a chevron disclosure; clicking expands and renders
the child's plan inline (recursive). Render depth is capped at 3 in the
SVG (deeper trees collapse with "Show N more…" — sidebar's depth-5 cap
is a separate constant).

Live updates subscribe to `goal_state_changed` and `goal_child_spawned`
WS events on every visible goal in the tree; the synthesis recomputes on
each event with a 250ms trailing-edge throttle to avoid layout thrash.

### Living-plan dedupe by `planId`

The living-plan path (no formal `execution` gate — e.g. workflows like
`phase-implementation`) emits **one PlanStep per unique
`spawnedFromPlanId`**, not one per child. Without this, archiving a
child and then re-spawning (or unarchiving) a sibling for the same
planId rendered two DAG nodes for the same logical step: a faded
`archived non-complete` ghost plus the live row.

Rule:

- Children are bucketed by `spawnedFromPlanId`. Each bucket is fed to
  `resolvePlanNodeChild` (see [Tier preference](#tier-preference)) and
  collapses to a single winner — same resolver the formal-plan path
  and the server use, so the displayed state agrees everywhere.
- True orphans (children with no `spawnedFromPlanId`) get a
  `synth:<childGoalId>` fallback planId. These are unique by
  construction and are **not** grouped — every orphan still renders as
  its own node.

The living-plan path used to map child-goals → PlanSteps 1:1 with no
grouping, which was the bug. The fix kept the renderer untouched —
`plan-synthesis.ts` is the only file that changed — because
`plan-node-state.ts` already had the canonical resolver; living-plan
synthesis just wasn't using it.

## Recovery patterns

- **Merge conflict on `mergeChild`.** `mergeChildBranchLocal` runs
  `git merge --abort` on conflict so the parent worktree returns to a
  known-clean state. The subgoal step fails (`passed: false`) with a
  manual-recovery directive in the output; the team-lead must resolve
  the conflict by hand. The child is **NOT auto-archived** — its work
  is preserved for a retry once the conflict is resolved.
- **Workflow-less complete child.** Pre-fix children
  created without a workflow get stuck at `state=complete, archived=null,
  workflow=null`. `runSubgoalStep` includes a recovery branch with the
  conjunctive predicate `state === "complete" && !archived && !workflow`:
  it tries `mergeChild` directly, on success runs `teardownTeam +
  archiveGoalAfterMerge`, on conflict fails the step.
- **Stale archived non-complete pointer.** A cached
  `active.steps[i].subgoal.childGoalId` pointing at an
  `archived && state !== "complete"` record is invalidated; the cached
  pointer is wiped on both `active` and the persisted gate step's
  subgoal so future entries don't re-pick the dud, and the harness falls
  through to tier-3 (resolvePlanStepChild walking by
  `spawnedFromPlanId`).
- **Goal-tree migration backfill** — `GoalManager.backfillCompleteState`
  is invoked once per project on boot; it walks every archived goal
  whose `ready-to-merge` is `passed` and stamps `state: "complete"` if
  missing. Per-goal try/catch ensures one corrupt record can't crash
  boot.

## REST API summary

| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/api/goals/:id/spawn-child` | `{ planId, title, spec, workflowId?, suggestedRole?, dependsOn?: string[] }` | Idempotent on `planId`. 201 (new), 200 (`alreadyExists: true`), 400 `SPEC_TOO_SHORT {actualLength, minLength}` / 400 `SPEC_PLACEHOLDER` (see [Spawn-time spec validation](#spawn-time-spec-validation)), 400 `SELF_DEPENDENCY` / 400 `UNKNOWN_PLAN_ID {missing}` / 400 `DEPENDS_ON_CYCLE {path}` (depends-on validation, see [Declaring dependencies](#declaring-dependencies)), 400 (parent-cycle / missing field), 403 `SUBGOALS_DISABLED` / 403 `NESTING_DEPTH_EXCEEDED {currentDepth, maxDepth}` (see [Nesting depth limit & per-goal toggle](#nesting-depth-limit--per-goal-toggle)), 404 (parent missing). Stamps `spawnedFromPlanId` AND `dependsOnPlanIds` immediately after createGoal; new children inherit the parent's effective `subgoalsAllowed` / `maxNestingDepth`. |
| PATCH | `/api/goals/:id/plan` | `{ proposedSteps: ClassifierPlanStep[] }` | Mutation classifier; 200 `applied`, 200 `requiresApproval`, 400 `INVALID_PLAN_STEP {index}` (per-step shape validation), 400 `SELF_DEPENDENCY` / 400 `UNKNOWN_PLAN_ID {missing}` / 400 `DEPENDS_ON_CYCLE {path}` (per-step `dependsOn` validation), 409 `CRITERIA_DROP` / `RESTRUCTURE_REQUIRES_PAUSE`, 400 `NO_EXECUTION_GATE { code, error, warning }` when the workflow has no execution gate (the `warning` field is always present and describes degraded-execution semantics — see [`goal_plan_propose` execution paths](#goal_plan_propose-execution-paths)). |
| GET | `/api/goals/:id/plan?gateId=execution` | (query) | Returns `{steps, gateState, frozen, replanCount}` with the same tier preference the harness uses. |
| POST | `/api/goals/:id/integrate-child/:childId` | `{ force?: boolean }` | Wraps `mergeChild`. 200 `merged`, 409 `conflict`, 409 `RTM_NOT_PASSED` (unless `body.force === true`), 400 `PARENT_MISMATCH`. |
| POST | `/api/goals/:id/pause` | `{ cascade: boolean }` | 422 `CASCADE_REQUIRED` when omitted. Flips `paused:true` on every (cascaded) descendant, cancels in-flight gate verifications, and `forceAbort`s every streaming session whose `goalId` is in the paused subtree (team-leads, coders, reviewers, `llm-review-*` verifiers). While paused, every spawn path returns 409 `{code:"GOAL_PAUSED", goalId}` and `_bootRespawnSessionlessGoals` skips the goal. See [Pause / resume](#pause--resume). |
| POST | `/api/goals/:id/resume` | `{ cascade: boolean }` | Same 422 contract as pause. Clears `paused:false` on the subtree; does NOT auto-restart sessions — operator restarts manually via `/team/start`. |
| POST | `/api/goals/:id/mutation/:requestId/decision` | `{ decision: "approve" \| "reject" }` | 404 `REQUEST_NOT_FOUND`. Bumps `replanCount`; auto-pauses past 5. |
| PATCH | `/api/goals/:id/policy` | `{ divergencePolicy?, maxConcurrentChildren? }` | Root-only fields. The `goal_state_changed` broadcast carries the new values inline so clients don't need to re-fetch. |
| DELETE | `/api/goals/:id?cascade=true\|false[&mergedManually=true]` | (query) | 422 `CASCADE_REQUIRED`, 409 `HAS_DESCENDANTS` when `cascade=false`. Optional `mergedManually=true` stamps the target's `state` to `"complete"` before archiving (target-only) so the Plan-tab DAG renders it green; for use after a manual `git merge` of a child whose `ready-to-merge` failed. |
| POST | `/api/goals/:id/team/teardown?cascade=true\|false` | (query) | 409 `HAS_DESCENDANT_TEAMS` when `cascade=false` and descendants have live teams; `cascade=true` walks descendants depth-first and tears down each team. Best-effort per-goal: returns `{ok, toreDown, errors[]}`. |
| GET | `/api/goals/:id/tree-cost` | — | BFS rollup; cache keyed by `(rootGoalId, costGeneration)`. |

WS broadcasts: `goal_created` (carries `parentGoalId`), `goal_state_changed`,
`mutation_pending`, `mutation_decided`, `cost_changed`, plus the existing
`gate_verification_*` family.

The same nine `goal_*` tools (group `Children`) wrap these endpoints for
team-lead use. `defaults/tool-group-policies.yaml` declares the group
default `ask`; `team-lead.yaml` declares `always-allow` for all nine;
every contributor role declares `never`. The invariant is enforced by
`tests/role-children-tools-policy.test.ts` and the tool-guard extension
hard-blocks the call at runtime.

## Tool renderers

Each of the nine `Children` tools has a custom in-chat renderer in
`src/ui/tools/renderers/Goal*Renderer.ts`, registered eagerly in
`src/ui/tools/index.ts`. Without these the transcript would dump raw JSON
responses carrying internal IDs (`planId`, `requestId`, child goal UUIDs)
that the user has no reason to parse — the team-lead drives the nested-goal
lifecycle and the user needs scannable cards, not protocol payloads.

**Feature-flag gating.** Every renderer's `render()` first checks
`isSubgoalsEnabled()` (`src/app/subgoals-flag.js`); when subgoals are off,
it falls through to `DefaultRenderer` so the JSON payload is still visible
for debugging. This keeps the renderers invisible to projects that haven't
opted in and avoids registering an UI surface for a half-shipped feature.

**Shared helpers.** `src/ui/tools/renderers/children-renderer-helpers.ts`
holds the small primitives every renderer reuses: `stateBadge()`,
`classificationBadge()`, `goalIdChip()` (truncated 8-char mono chip),
`policyDescription()`, `concurrencyBar()`, `resolveGoalId()`, plus the
`getResult()` / `parseParams()` JSON shims. Duplication with
`TaskToolRenderers` / `TeamToolRenderers` is intentional — those copies are
not exported and a refactor would entangle three unrelated tool groups.

### Per-tool shapes

| Tool | Visual shape |
|---|---|
| `goal_spawn_child` (`GoalSpawnChildRenderer.ts`) | Mini goal-proposal card: title, workflow id (or "default"), `planId` chip, collapsible spec excerpt, live `<children-goal-state-pill>` keyed by the new child goal id, and an **Open goal →** button (see below). |
| `goal_plan_propose` (`GoalPlanProposeRenderer.ts`) | **Mirrors `ProposalRenderer.ts`** — header with rev number, steps table (phase / title / collapsible spec), classification badge, criteria-drop red banner, in-chat Approve / Reject buttons (`<children-mutation-approval>`) when `requiresApproval` is set, "Applied ✓" pill when `applied`. Falls back to a spawned-list when the server response carries `fallback: "spawn-children-direct"`. |
| `goal_plan_status` (`GoalPlanStatusRenderer.ts`) | Compact steps grid; each row carries a live `<children-goal-state-pill>` for the corresponding child goal. |
| `goal_merge_child` (`GoalMergeChildRenderer.ts`) | Outcome pill: `merged ✓` / `already merged` / `conflict ⚠` / `RTM not passed ✗`. On conflict, an `<expandable-section>` reveals the conflict output. |
| `goal_pause` / `goal_resume` (`GoalPauseResumeRenderer.ts`) | Single-line card: verb + cascade-affected count from the response. |
| `goal_archive_child` (`GoalArchiveChildRenderer.ts`) | Single-line: child title + `goalIdChip` + `mergedManually ✓` flag when present. |
| `goal_decide_mutation` (`GoalDecideMutationRenderer.ts`) | Green "Approved" or red "Rejected" pill + truncated `requestId`. The response carries `{ applied }` only today; an `applied steps diff` block is rendered conditionally if a future server response surfaces one. |
| `goal_set_policy` (`GoalSetPolicyRenderer.ts`) | Key/value rows: divergence policy (with one-line `policyDescription()`) + `maxConcurrentChildren` rendered as a `concurrencyBar()` (1–8 small blocks). |

### `goal_spawn_child` — Open goal navigation

The **Open goal →** button on a `GoalSpawnChildRenderer` card navigates to the
child's goal dashboard using the canonical `setHashRoute("goal-dashboard",
childGoalId)` helper (`src/app/routing.ts`), which writes `#/goal/<id>` — the
pattern that `getRouteFromHash()` matches to `view: "goal-dashboard"`.

**Why `setHashRoute`, not a raw hash write.** A direct `window.location.hash =
"#goal-dashboard/<id>"` write produces a hash the router doesn't recognise,
causing it to fall through to the empty landing page. All navigation in the
app goes through `setHashRoute` — this is the single source of truth for the
`#/goal/<id>` format.

**Cross-project switching.** A child goal can belong to a different project
than the one the user is currently viewing. When `handleHashChange()` in
`src/app/main.ts` resolves the goal and finds its `projectId`, it calls
`applyProjectPalette(gdGoal.projectId)`, which also updates
`state.activeProjectId`. This keeps the sidebar filtered to the child's project
and the breadcrumb correct, even when navigating from a different project's
context.

**Goal resolution before navigation.** Before mounting the dashboard,
`handleHashChange()` runs two resolution tiers:

1. **In-state lookup** — `state.goals.find(g => g.id === route.goalId)`. Covers
   the common case where the child is already in the client's goal list.
2. **Per-id API fetch** — `GET /api/goals/:id`. Covers goals in other projects,
   freshly spawned children not yet in the local list, and archived goals.

The fetched goal is merged into `state.goals` so the sidebar can reflect the
correct project before the first render.

**Archived and blocked children.** Navigation succeeds for goals in any state.
The dashboard already renders archived goals with a grey `Archived` badge and
blocked goals with a `Blocked` badge — no special casing is needed in the
renderer. The router does not gate on goal state.

**Missing or purged goals.** If the goal cannot be resolved via either tier
(e.g. it was purged, or its project was deleted), `handleHashChange()` shows a
header toast — `Goal no longer exists (id=<first 8 chars>)` — via
`showHeaderToast()`, restores the previous hash, and leaves the current view
unchanged. The user is never dumped onto the empty landing page.

**Invariant.** `goal_spawn_child` always returns a real goal id, never a
proposal id. The **Open goal →** button is only rendered when `childGoalId` is
present; the `!childGoalId` short-circuit in `GoalSpawnChildRenderer` ensures
the button cannot appear for a tool call that returned no id.

Pinned by: `tests/e2e/ui/spawned-child-open-goal.spec.ts` — covers active
children, cross-project `activeProjectId` switching, archived children,
blocked children (no-crash), and the missing-goal toast.

Why `goal_plan_propose` mirrors `ProposalRenderer.ts`: a plan-propose call
IS a goal proposal — it's the parent goal proposing a set of child goals.
Reusing the proposal shape (header + rev marker + steps table + approval
buttons + applied-pill) keeps the team-lead's mental model consistent
between "propose this top-level goal" (user-facing) and "propose this plan
of child goals" (team-lead-facing). The two flows share the
`__proposal_rev_v1__` tool-result marker via `proposal-rev-marker.ts`.

### In-chat approval (`<children-mutation-approval>`)

When `goal_plan_propose` returns `requiresApproval: true` under `strict` /
`balanced` policy (see [Mutation classifier](#mutation-classifier)), the
renderer mounts `<children-mutation-approval>` (`src/ui/lazy/
children-mutation-approval.ts`). Approve / Reject buttons POST to
`/api/goals/:goalId/mutation/:requestId/decision` via `gatewayFetch` — the
same endpoint the dashboard's mutation-pending card uses (see
`src/app/custom-messages.ts`). The two surfaces coexist by design: the
in-chat card is where the team-lead conversation is happening, while the
dashboard card is the goal-level view; either action satisfies the
request. A module-level `decisionMemory: Map<requestId, decision>` survives
the re-mount caused by the outer transcript re-rendering when the WS
`mutation_decided` broadcast arrives, so the card doesn't snap back to the
idle state.

The element resolves `goalId` two ways: it accepts a `goal-id` attribute
(set by the renderer from `ToolRenderContext.goalId`, see
[Threading `goalId` through `ToolRenderContext`](internals.md#threading-goalid-through-toolrendercontext)),
and the renderer falls back to `document.documentElement.dataset.currentGoalId`
via `resolveGoalId()` for archived-session transcripts where the session
record has been GC'd.

### Live state pill (`<children-goal-state-pill>`)

`<children-goal-state-pill>` (`src/ui/lazy/children-goal-state-pill.ts`) is
a Lit element that shows a coloured `pending` / `in-progress` / `complete`
/ `archived` / `failed` pill for a child goal and re-fetches when the goal
changes. Used by `GoalSpawnChildRenderer` and `GoalPlanStatusRenderer`
because those cards stay in the transcript indefinitely — the user
scrolling back through history wants to see the *current* state of each
child, not a snapshot from when the tool fired.

Updates ride on a small subscription bridge in `src/app/remote-agent.ts`:

```ts
export function subscribeGoalStateChanges(
  cb: (evt: { goalId?: string; type?: string }) => void,
): () => void;
```

The WS handler in `remote-agent.ts` fans `goal_state_changed` /
`goal_child_spawned` broadcasts out to every registered subscriber. The
pill subscribes on `connectedCallback`, filters on `goalId`, and calls
`gatewayFetch('/api/goals/:id')` to refresh — never touching the
dashboard's reactive store. The reason for a dedicated bridge rather than
a DOM `CustomEvent` is decoupling: many transcript cards may want live
goal state without participating in the dashboard's render cycle, and a
DOM event would require every host (the transcript host, the goal
dashboard, archived-session viewers) to wire identical listeners.
Unsubscribe runs in `disconnectedCallback` so removed cards don't leak.

Lazy-mounting (`import("../../lazy/children-goal-state-pill.js")` on first
call) keeps the main bundle small — `children-mutation-approval.ts` and
`children-goal-state-pill.ts` only ship to clients that actually use
subgoals.

### Tests

- `tests/children-tool-renderers.spec.ts` — unit (file:// fixtures): each
  renderer's call-only / streaming / result / error / fallback states; the
  feature-flag fall-through to `DefaultRenderer` when subgoals are off.
- `tests/e2e/ui/children-tool-renderers.spec.ts` — browser E2E: title +
  `planId` rendering for `goal_spawn_child`, step rows for
  `goal_plan_propose`, approval buttons under `requiresApproval`, and the
  Approve-click POST to the mutation-decision endpoint.

## Acceptance criteria (verification checklist)

A user must be able to:

1. **Create a top-level goal** with the `parent` workflow and a
   multi-version spec (e.g. v0.1 → v0.2 → v1.0).
2. **Watch the team-lead pass `charter`** (LLM-reviewed) and **propose a
   plan** of 3+ subgoal steps via `goal_plan_propose`.
3. **See the plan render in the Plan tab** as a DAG SVG, with nodes laid
   out by phase and edge connectors showing dependencies.
4. **Inspect each plan node** — title, spec, workflow, suggested role,
   current state — and approve the plan via the dashboard's "Approve
   plan" button. Verify that the `execution.verify[]` is now frozen.
5. **Watch up to N (default 3) children spawn in parallel** as the
   harness processes the `execution` gate, each in its own worktree
   branched off the parent's branch HEAD.
6. **Drill into any child goal** — same dashboard as a standalone goal,
   with a "← back to parent" breadcrumb.
7. **Children can themselves use the `parent` workflow and recurse** —
   sidebar shows nested children with deeper indentation; merges chain
   (grandchild → child → root → master).
8. **Children's `ready-to-merge` gates merge their work into the
   parent's branch** (no remote PR from children); the local merge
   auto-archives the child + tears down its team.
9. **The top-level goal's `ready-to-merge` gate raises exactly one PR**
   from its branch to `master`.
10. **Existing standalone goals (no `parentGoalId`) work identically** —
    no regressions.
11. **Mutation classification works as documented** —
    `criteria-drop` always rejected; `fix-up` auto-approves under
    `balanced`/`autonomous`; `restructure` requires `paused`;
    `expansion` always prompts.
12. **Inline workflow YAML pasted in the New Goal dialog** snapshots
    onto the goal and resolves before the project/server/builtin
    cascade.
13. **Cost rollup**: a parent goal's dashboard shows the sum of all
    descendants' costs (tree-cost rollup).
14. **Plan tab shows nested sub-trees inline** — grandchildren visible
    without clicking into a child (Plan-tab nested rendering).
15. **The system survives a gateway restart mid-verification** —
    subgoal steps that were running are recovered (no false-negative
    gate failures). Sessionless in-progress goals get fresh team-leads
    on boot. Crash-loops are bounded at 5 quick crashes.
16. **Unit tests pass** (`npm run test:unit`), zero flakes. Tests cover
    every nested-goals invariant.
17. **`npm run test:e2e` passes** — at least 4 browser E2E tests cover
    sidebar nesting, plan tab, child spawn, recursive merge.

## Spawn-time spec validation

The server rejects placeholder specs on `POST /api/goals/:id/spawn-child` and in the harness `runSubgoalStep` path. This is a load-bearing guard: the child team-lead's **first user message is built from the spec at spawn time** (see [Team-lead kickoff](goals-workflows-tasks.md#concepts)). A placeholder spec leaves the child with no task context in that message.

### What is checked

Validation runs in `src/server/agent/spawn-child-spec-validation.ts` and applies two checks in order:

1. **Placeholder keyword match** — if the trimmed spec matches `placeholder`, `tbd`, `todo`, `wip`, `test`, or `temp` (case-insensitive, as the whole value), the request is rejected with `SPEC_PLACEHOLDER`.
2. **Minimum length** — if the trimmed spec is shorter than 50 characters (and not a keyword match), the request is rejected with `SPEC_TOO_SHORT`.

Checks are applied to the trimmed spec only. A real spec that happens to *contain* the word "placeholder" inside a longer description passes fine — only exact (whole-value) matches are rejected.

### Error shapes

**`SPEC_PLACEHOLDER`** (400)
```json
{ "code": "SPEC_PLACEHOLDER", "error": "Goal spec looks like a placeholder..." }
```

**`SPEC_TOO_SHORT`** (400)
```json
{ "code": "SPEC_TOO_SHORT", "error": "Goal spec must be at least 50 characters...", "actualLength": 12, "minLength": 50 }
```

### Harness path

When `runSubgoalStep` in `verification-harness.ts` encounters a placeholder spec, it returns `{ passed: false }` rather than an HTTP error — the harness communicates back to the orchestration loop rather than surfacing a raw 400.

### PUT warning

If a goal's spec is edited via `PUT /api/goals/:id` after the team-lead has already started, and the previous spec looked like a placeholder, the server logs a console warning:

```
[server] WARN: goal <id> had a placeholder spec edited shortly after spawn. The team-lead's first-message context was the placeholder, not this new content. If you intended to fix a spawn-time miss, archive and respawn.
```

This does not reject the edit — legitimate mid-flight spec clarifications are allowed — but it surfaces the anti-pattern when it happens.

### The anti-pattern being prevented

Some agent code developed a habit of:
1. Spawning a child with `spec: "placeholder"` to get a `goalId` quickly.
2. Then building the real spec and `PUT`-ing it via a separate REST call.

This pattern was originally a workaround for an assumed JSON payload size limit on `goal_spawn_child`. **That limit does not exist.** The endpoint accepts arbitrarily long spec strings — multi-KB markdown is fine.

The pattern is harmful because the team-lead kickoff message is constructed at spawn time from the spec in the store. By the time the parent agent PUTs the real spec, the child team-lead may have already started with the placeholder in its context. The `goal_spec_changed` WS notification and `view_goal_spec` tool exist for legitimate mid-flight edits, not to paper over spawn-time omissions.

### Migration

Pass the complete spec at spawn time:

```ts
// ✅ Correct — full spec at spawn
goal_spawn_child({
  planId: "impl-auth",
  title: "Implement OAuth flow",
  spec: "## Task\nImplement the OAuth 2.0 authorisation code flow...\n\n## Acceptance criteria\n- Token refresh works\n- ..."
})

// ❌ Wrong — placeholder-then-PUT is rejected
goal_spawn_child({ planId: "impl-auth", title: "Implement OAuth flow", spec: "placeholder" })
// ... then later PUT /api/goals/:id { spec: "real spec" }  <-- server warns, child already started wrong
```

Long specs (multi-KB markdown) are fine inline — there is no payload limit on `goal_spawn_child`.

## Anti-patterns

These are the foot-guns that PR #409 hit. Don't reinvent them:

1. **Don't introduce a `Mission` type** or any peer entity. A nested
   goal IS a goal.
2. **Don't build a custom scheduler.** The verification harness IS the
   scheduler.
3. **Don't mutate `goal.workflow` after creation.** The snapshot is
   frozen at goal creation.
4. **Don't skip the spawn-time `spawnedFromPlanId` stamp.** Every
   dupe-spawn bug starts here (stamp-immediately invariant).
5. **Don't trust `status: idle` to mean stuck.** Read the JSONL.
6. **Don't write `spawn("node", ...)`.** Always `process.execPath`
   (`process.execPath` invariant for server-side node spawns).
7. **Don't auto-resolve merge conflicts.** Escalate to user.
8. **Don't auto-archive on conflict.** Preserve work for retry.
9. **Don't add `gate_signal` to contributor role policies.** Team-lead
   only (every contributor declares them as `never`).
10. **Don't paraphrase acceptance criteria in subgoal specs.** Quote
    them verbatim under `## Covers`.
11. **Don't push to `master` from a child goal.** Only the root goal's
    `ready-to-merge` raises a PR.
12. **Don't spawn with `spec: "placeholder"` and PUT the real spec later.** The child team-lead's first message is built from the spec at spawn time. Pass the complete spec to `goal_spawn_child` — long markdown is fine, there is no payload limit. The server rejects placeholder specs at spawn with `400 SPEC_PLACEHOLDER` / `SPEC_TOO_SHORT`.
