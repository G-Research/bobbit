# Nested Goals & DAG Subgoals

User-facing reference for the nested-goal feature. For internal data-model
details see [goals-workflows-tasks.md](goals-workflows-tasks.md); for
restart-resilience invariants see the relevant entries in
[debugging.md](debugging.md). Implementation specs that drove the feature
live in `SUBGOALS-SPEC.md` (root of the repo).

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
                  │   + suggestedRole?: string         │
                  │   + spawnedBySessionId?: string    │
                  │   + paused?: boolean               │
                  │   + replanCount?: number           │
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
                  │   }                                │
                  └────────────────────────────────────┘

  Verification harness runs verify steps in phase order, in parallel,
  with idempotency. ONE handler in the dispatcher for type === "subgoal":
    1. Lookup existing child by (parentGoalId, planId)         ← idempotent
    2. If not found, GoalManager.createGoal(parentGoalId, ...) ← reuse
    3. Stamp spawnedFromPlanId IMMEDIATELY after createGoal    ← critical (Lesson 4.1)
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
```

`runSubgoalStep` reads as follows. Each step encodes a hard-won lesson
from PR #409 (see Lesson references in
[debugging.md](debugging.md#lesson-41--spawn-then-stamp-planid-race) and
adjacent entries):

```
1. Resolve descriptor       (planId / title / spec / workflowId? / suggestedRole?)
2. Tier-based child lookup  → resolvePlanStepChild  (Lesson 4.19)
3. Stale archived non-complete invalidation         (Lesson 4.2)
4. Success terminal short-circuit                   (archived && state === "complete")
5. Workflow-less complete-child recovery            (Lesson 4.4)
6. Spawn → IMMEDIATELY stamp spawnedFromPlanId      (Lesson 4.1)
   then fire setupWorktreeAndStartTeam asynchronously
7. Wait for child.ready-to-merge to pass (or external archive, or cancellation)
8. mergeChild → on merged|alreadyMerged: teardownTeam + archiveAfterMerge
   on conflict: passed=false with manual-recovery output (no auto-archive,
   no auto-resolve)
9. Concurrency: per-rootGoalId Semaphore acquired before spawn,
   released in finally
```

**Tier preference** (Lesson 4.19) — when multiple children share a `planId`
(zombie sibling + the actual merged-and-archived original), the tiers
break the tie:

| Tier | Predicate | Notes |
|---|---|---|
| 1   | live in-progress, `spawnedFromPlanId === planId` | most recent createdAt wins |
| 1.5 | cached `active.steps[i].subgoal.childGoalId` | wiped if stale (Lesson 4.2) |
| 2   | archived + `state === "complete"` | success terminal short-circuit |
| 3   | live other (todo / paused / awaiting setup) | |
| 4   | archived + `state !== "complete"` | shelved dupe — invalidate, fall through to spawn |
| 5   | rescue: `spawnedFromPlanId === undefined` matched by `(parentGoalId, title)` | back-fills `spawnedFromPlanId` |

Both server-side (`resolvePlanStepChild` in
`src/server/agent/verification-harness.ts`) and client-side
(`resolvePlanNodeChild` in `src/app/plan-node-state.ts`) implement the
same tier preference; they MUST agree on the displayed state for a given
input.

## Mutation classifier

Once `goal-plan` is signalled, `execution.verify[]` is **frozen**. Further
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

**Criteria-coverage check** is **whitespace-normalised, case-insensitive
substring match** over the union of `{rootSpec, every remaining subgoal
step's spec}`. Hashes don't work — they fail the moment the team-lead
paraphrases. Therefore team-leads MUST quote acceptance criteria
**verbatim** in subgoal specs. The convention is a `## Covers` heading
listing the criteria the subgoal addresses.

`replanCount` ticks up on every successful post-freeze mutation. At
`> 5`, the goal is auto-paused so a human can review the plan churn
before more replans land. Resume via
`POST /api/goals/:id/resume {cascade}`.

Pending mutation requests live in
`<stateDir>/plan-mutations/<goalId>.json` with a 24-hour TTL and survive
restart. Clients re-emit `mutation_pending` events on WS attach.

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
until the child's `ready-to-merge` resolves. `maxConcurrentChildren` is
configured on the **root goal only** via `goal_set_policy` /
`PATCH /api/goals/:id/policy`; sub-goal values are stored for
forward-compat but inert.

## Restart resilience

Restart is a fact of life — every test cycle and every deploy hits it.
The feature ships with the following invariants (see
[debugging.md](debugging.md) for the full diagnostic checklists):

- **Restart-interrupted verifications mark the gate `pending`, not
  `failed`** (Lesson 4.6). The conjunctive predicate
  `shouldSuppressRestartInterrupt` in
  `src/server/agent/verification-logic.ts` requires every failed step to
  match a `RESTART_INTERRUPT_MARKERS` entry; real failures still fail
  the gate.
- **Boot respawns sessionless in-progress goals** (Lesson 4.12).
  `TeamManager._bootRespawnSessionlessGoals` runs at the end of
  `resubscribeTeamEvents` and walks every non-archived
  `state: in-progress, setupStatus: ready, team: true` goal with no
  team entry, calling `startTeam` to spin up a fresh team-lead.
- **Crash-loop guard** caps automatic restarts at 5 quick crashes within
  10s of launch (Lesson 4.11). After the threshold the harness logs
  `Run "npm run restart-server" to resume after fixing the root cause`
  and stops auto-restarting. A manual restart trigger clears the
  counter.
- **Auto-revive dead RPC bridges** (Lesson 4.9). Two new-prompt sites in
  `enqueuePrompt` route through
  `SessionManager._dispatchPromptWithReviveOnDeadBridge`, which checks
  `rpcClient.running`, calls `restartAgent` if dead, and re-resolves
  the SessionInfo before dispatching.
- **Auto-archive zombie sessions** (Lesson 4.10). A row with neither an
  `agentSessionFile` nor a `role` is unrecoverable; `restartAgent`
  archives it and throws `code: "SESSION_UNRECOVERABLE_ARCHIVED"`.
- **Resumed reviewers wait for `agent_start` before racing waitForIdle**
  (Lesson 4.15). All four reminder sites in `verification-harness.ts`
  await `SessionManager.waitForStreaming(sessionId, 10_000)` before the
  existing `waitForIdle` race.
- **Reviewer kind persisted** (Lesson 4.16). `TeamAgent` and
  `PersistedTeamEntry.agents[].kind: "worker" | "reviewer"`;
  `resubscribeTeamEvents` skips reviewers on restart and `notifyTeamLead`
  has the same defensive guard.

## Cascade UX

Pause / resume / archive on a parent goal with descendants requires an
explicit `cascade: boolean` parameter on the REST call — server returns
**422 `{code: "CASCADE_REQUIRED"}`** when omitted. The UI is the
cascade-policy authority:

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

The parent-level forest in `src/app/sidebar.ts` excludes goals that are
already being rendered under an attributable team-lead session — its
`teamLeadIdsAttributable` set covers BOTH live team-leads and archived
team-leads (the latter only when `state.showArchived` is on). Sub-goals
fall back to parent-forest level only when the spawning session is fully
gone (terminated AND not in archived view) — never unreachable.

**Boot-time backfill** for legacy records:
`GoalManager.backfillSpawnedBySessionId(teamStore, sessionStore?)` walks
every sub-goal (live or archived) missing the field and stamps it from
the parent's persisted team-lead session id. Lookup precedence: (1) the
parent's `TeamStore` entry's `teamLeadSessionId`; (2) `SessionStore`
fallback — sessions with `role === "team-lead"` and
`teamGoalId === parentGoalId` (or `goalId === parentGoalId`); a single
match wins, multiple matches are ambiguous and skipped. Idempotent
(only writes when the field is absent), per-goal try/catch (Lesson 4.11
endless-restart guard). Wired in `src/server/server.ts` immediately
after `restoreTeams`, alongside `backfillCompleteState`. Logs
`[goal-manager] Backfilled spawnedBySessionId=<sid> for legacy sub-goal
<gid>` per stamped goal.

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

## Plan tab

The Plan tab is visible if **either**:

1. The goal's workflow has a `goal-plan` gate (formal plan), OR
2. The goal has any non-archived children (living plan — synthesise from
   live children, clustering by `createdAt` timestamp gap).

Synthesis (`src/app/plan-synthesis.ts::buildPlanSteps`) recomputes from
the live goal tree on every render, so the Plan tab is a living
document. Goals with formal plans + ad-hoc children get the formal plan
plus orphans appended past the formal max phase.

The Plan tab DAG SVG renders nested sub-trees inline (Lesson 4.22). Each
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
- **Workflow-less complete child** (Lesson 4.4). Pre-fix children
  created without a workflow get stuck at `state=complete, archived=null,
  workflow=null`. `runSubgoalStep` includes a recovery branch with the
  conjunctive predicate `state === "complete" && !archived && !workflow`:
  it tries `mergeChild` directly, on success runs `teardownTeam +
  archiveGoalAfterMerge`, on conflict fails the step.
- **Stale archived non-complete pointer** (Lesson 4.2). A cached
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
| POST | `/api/goals/:id/spawn-child` | `{ planId, title, spec, workflowId?, suggestedRole? }` | Idempotent on `planId`. 201 (new), 200 (`alreadyExists: true`), 400 (cycle / missing field), 404 (parent missing). Stamps `spawnedFromPlanId` immediately after createGoal. |
| PATCH | `/api/goals/:id/plan` | `{ proposedSteps: ClassifierPlanStep[] }` | Mutation classifier; 200 `applied`, 200 `requiresApproval`, 409 `CRITERIA_DROP` / `RESTRUCTURE_REQUIRES_PAUSE`. |
| GET | `/api/goals/:id/plan?gateId=execution` | (query) | Returns `{steps, gateState, frozen, replanCount}` with the same tier preference the harness uses. |
| POST | `/api/goals/:id/integrate-child/:childId` | `{}` | Wraps `mergeChild`. 200 `merged`, 409 `conflict`, 400 `PARENT_MISMATCH`. |
| POST | `/api/goals/:id/pause` | `{ cascade: boolean }` | 422 `CASCADE_REQUIRED` when omitted. |
| POST | `/api/goals/:id/resume` | `{ cascade: boolean }` | Same 422 contract as pause. |
| POST | `/api/goals/:id/mutation/:requestId/decision` | `{ decision: "approve" \| "reject" }` | 404 `REQUEST_NOT_FOUND`. Bumps `replanCount`; auto-pauses past 5. |
| PATCH | `/api/goals/:id/policy` | `{ divergencePolicy?, maxConcurrentChildren? }` | Root-only fields. |
| DELETE | `/api/goals/:id?cascade=true\|false` | (query) | 422 `CASCADE_REQUIRED`, 409 `HAS_DESCENDANTS` when `cascade=false`. |
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
    descendants' costs (Lesson 4.21).
14. **Plan tab shows nested sub-trees inline** — grandchildren visible
    without clicking into a child (Lesson 4.22).
15. **The system survives a gateway restart mid-verification** —
    subgoal steps that were running are recovered (no false-negative
    gate failures). Sessionless in-progress goals get fresh team-leads
    on boot. Crash-loops are bounded at 5 quick crashes.
16. **Unit tests pass** (`npm run test:unit`), zero flakes. Tests cover
    every Lesson 4.x.
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
   dupe-spawn bug starts here (Lesson 4.1).
5. **Don't trust `status: idle` to mean stuck.** Read the JSONL.
6. **Don't write `spawn("node", ...)`.** Always `process.execPath`
   (Lesson 4.5).
7. **Don't auto-resolve merge conflicts.** Escalate to user.
8. **Don't auto-archive on conflict.** Preserve work for retry.
9. **Don't add `gate_signal` to contributor role policies.** Team-lead
   only (Lesson 4.17).
10. **Don't paraphrase acceptance criteria in subgoal specs.** Quote
    them verbatim under `## Covers`.
11. **Don't push to `master` from a child goal.** Only the root goal's
    `ready-to-merge` raises a PR.
