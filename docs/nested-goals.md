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
the same preference. Divergence between any two means a tier-resolver
copy crept back in. Pinned by `tests/api-goals-plan-tier-parity.test.ts`.

## Mutation classifier

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

**Goal creation panel** (below the Sandbox / Auto-start toggles):

- An **Allow subgoals** toggle. Default inherits from
  `isSubgoalsEnabled()`. When the system pref is OFF the toggle is OFF
  and greyed out — a per-goal flag cannot override a system-level OFF.
  Flipping it OFF disables subgoals for this specific goal tree.
- A **Max nesting depth** stepper (testid
  `goal-form-max-nesting-depth`), visible only when Allow subgoals is
  ON. Default inherits from `getSystemMaxNestingDepth()`. The tooltip
  surfaces the current system ceiling. The submit path only sends the
  override when it differs from the inherited default; otherwise the
  field is omitted and the server resolves at request time from prefs.

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
| POST | `/api/goals/:id/spawn-child` | `{ planId, title, spec, workflowId?, suggestedRole?, dependsOn?: string[] }` | Idempotent on `planId`. 201 (new), 200 (`alreadyExists: true`), 400 `SELF_DEPENDENCY` / 400 `UNKNOWN_PLAN_ID {missing}` / 400 `DEPENDS_ON_CYCLE {path}` (depends-on validation, see [Declaring dependencies](#declaring-dependencies)), 400 (parent-cycle / missing field), 403 `SUBGOALS_DISABLED` / 403 `NESTING_DEPTH_EXCEEDED {currentDepth, maxDepth}` (see [Nesting depth limit & per-goal toggle](#nesting-depth-limit--per-goal-toggle)), 404 (parent missing). Stamps `spawnedFromPlanId` AND `dependsOnPlanIds` immediately after createGoal; new children inherit the parent's effective `subgoalsAllowed` / `maxNestingDepth`. |
| PATCH | `/api/goals/:id/plan` | `{ proposedSteps: ClassifierPlanStep[] }` | Mutation classifier; 200 `applied`, 200 `requiresApproval`, 400 `INVALID_PLAN_STEP {index}` (per-step shape validation), 400 `SELF_DEPENDENCY` / 400 `UNKNOWN_PLAN_ID {missing}` / 400 `DEPENDS_ON_CYCLE {path}` (per-step `dependsOn` validation), 409 `CRITERIA_DROP` / `RESTRUCTURE_REQUIRES_PAUSE`. |
| GET | `/api/goals/:id/plan?gateId=execution` | (query) | Returns `{steps, gateState, frozen, replanCount}` with the same tier preference the harness uses. |
| POST | `/api/goals/:id/integrate-child/:childId` | `{ force?: boolean }` | Wraps `mergeChild`. 200 `merged`, 409 `conflict`, 409 `RTM_NOT_PASSED` (unless `body.force === true`), 400 `PARENT_MISMATCH`. |
| POST | `/api/goals/:id/pause` | `{ cascade: boolean }` | 422 `CASCADE_REQUIRED` when omitted. Cancels in-flight verifications; does NOT halt streaming team-lead/worker sessions today (`showPauseGoalDialog` text surfaces this partial-pause limitation). |
| POST | `/api/goals/:id/resume` | `{ cascade: boolean }` | Same 422 contract as pause. |
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
| `goal_spawn_child` (`GoalSpawnChildRenderer.ts`) | Mini goal-proposal card: title, workflow id (or "default"), `planId` chip, collapsible spec excerpt, live `<children-goal-state-pill>` keyed by the new child goal id. |
| `goal_plan_propose` (`GoalPlanProposeRenderer.ts`) | **Mirrors `ProposalRenderer.ts`** — header with rev number, steps table (phase / title / collapsible spec), classification badge, criteria-drop red banner, in-chat Approve / Reject buttons (`<children-mutation-approval>`) when `requiresApproval` is set, "Applied ✓" pill when `applied`. Falls back to a spawned-list when the server response carries `fallback: "spawn-children-direct"`. |
| `goal_plan_status` (`GoalPlanStatusRenderer.ts`) | Compact steps grid; each row carries a live `<children-goal-state-pill>` for the corresponding child goal. |
| `goal_merge_child` (`GoalMergeChildRenderer.ts`) | Outcome pill: `merged ✓` / `already merged` / `conflict ⚠` / `RTM not passed ✗`. On conflict, an `<expandable-section>` reveals the conflict output. |
| `goal_pause` / `goal_resume` (`GoalPauseResumeRenderer.ts`) | Single-line card: verb + cascade-affected count from the response. |
| `goal_archive_child` (`GoalArchiveChildRenderer.ts`) | Single-line: child title + `goalIdChip` + `mergedManually ✓` flag when present. |
| `goal_decide_mutation` (`GoalDecideMutationRenderer.ts`) | Green "Approved" or red "Rejected" pill + truncated `requestId`. The response carries `{ applied }` only today; an `applied steps diff` block is rendered conditionally if a future server response surfaces one. |
| `goal_set_policy` (`GoalSetPolicyRenderer.ts`) | Key/value rows: divergence policy (with one-line `policyDescription()`) + `maxConcurrentChildren` rendered as a `concurrencyBar()` (1–8 small blocks). |

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
