# Phase 3 Notes — Nested Goals & DAG Subgoals (collated for Phase 8)

This file captures the design notes for Phase 3 of nested goals so Phase 8
docs can fold them into `docs/nested-goals.md`, `AGENTS.md`, and
`docs/goals-workflows-tasks.md`. Source spec: `SUBGOALS-SPEC.md`.

## What Phase 3 ships

| Surface | Module | Notes |
|---|---|---|
| `subgoal` verify-step type | `src/server/agent/workflow-store.ts` | `VerifyStep.type` widened; `VerifyStep.subgoal: { planId, title, spec, workflowId?, suggestedRole? }`. Round-trips through normalize/serialize; older stored data lazy-tolerated. |
| `parent` meta-workflow | `src/server/state-migration/seed-default-workflows.ts` | `buildParentWorkflow()` exported; six gates `charter → plan-review → goal-plan → execution → integration → ready-to-merge`. `goal-plan` is `manual: true`; `execution.verify[]` starts empty. |
| `runSubgoalStep` handler | `src/server/agent/verification-harness.ts` | Single dispatcher branch in `verifyGateSignal`; the entire scheduler is the harness's normal phase-parallel run loop plus this one method. |
| `resolvePlanStepChild` | same file (public method) | Tier-based child resolution (Lesson 4.19). Public so the Plan tab (Phase 5b) can share the tier preference. |
| Concurrency cap | per-rootGoalId `Semaphore` map on the harness | Default 3, hard max 8. Cap resolved via `GoalManager.resolveRootMaxConcurrentChildren`. |
| `goal-plan` gate-signal freeze | `src/server/agent/parent-workflow-freeze.ts` (helper) + `src/server/server.ts` route hook | Sets `executionGate.metadata.frozen = "true"` on the per-goal workflow snapshot. Phase 4 mutation classifier will key off this flag. |
| Boot-time backfill | `src/server/server.ts::start()` | Walks `projectContextManager.all()` and calls `goalManager.backfillCompleteState(gateStore)` per project. Wrapped in try/catch (Lesson 4.11). |

## The 7-step skeleton (SUBGOALS-SPEC §2)

`runSubgoalStep` reads as follows. **Do not collapse the structure** — every
step encodes a Lesson and was a bug we shipped on PR #409.

```
1. Resolve descriptor       (planId / title / spec / workflowId? / suggestedRole?)
2. Tier-based child lookup  (Lesson 4.19) → resolvePlanStepChild
3. Stale archived non-complete invalidation  (Lesson 4.2)
4. Success terminal short-circuit  (archived && state === "complete")
5. Workflow-less complete-child recovery  (Lesson 4.4) — predicate is conjunctive
6. Spawn → IMMEDIATELY stamp spawnedFromPlanId  (Lesson 4.1)
   then fire setupWorktreeAndStartTeam asynchronously
7. Wait for child.ready-to-merge to pass (or external archive, or cancellation)
8. mergeChild → on merged|alreadyMerged: teardownTeam + archiveAfterMerge
   on conflict: passed=false with manual-recovery output (no auto-archive,
   no auto-resolve — anti-pattern §9)
9. Concurrency: per-rootGoalId Semaphore acquired before spawn,
   released in finally
```

## Tier preference (Lesson 4.19)

`resolvePlanStepChild(parentGoalId, planId, opts?)`:

| Tier | Predicate | Source value | Notes |
|---|---|---|---|
| 1   | `parentGoalId && spawnedFromPlanId === planId && !archived && state === "in-progress"` | `live-active` | Most recent createdAt wins |
| 1.5 | `active.steps[stepIndex].subgoal.childGoalId` (cached pointer) | `cached-pointer` | Wiped if stale archived non-complete or vanished (Lesson 4.2) |
| 2   | `parentGoalId && planId match && archived && state === "complete"` | `archived-complete` | Success terminal short-circuit |
| 3   | `parentGoalId && planId match && !archived && state !== "in-progress"` | `live-other` | todo / paused / awaiting setup |
| 4   | `parentGoalId && planId match && archived && state !== "complete"` | `archived-other` | Shelved dupe — caller invalidates and falls through to spawn |
| 5   | `parentGoalId && spawnedFromPlanId === undefined && title === expectedTitle` | `rescue` | Back-fills `spawnedFromPlanId = planId` so future lookups take the cheap tier-1 path |

Tie-break within a tier: most recent `createdAt`.

## Lesson invariants

- **4.1** — Stamp `spawnedFromPlanId` IMMEDIATELY after `createGoal`. Pinned by
  `tests/runSubgoalStep-spawn-stamps-planId.test.ts`. The very next call after
  `createGoal` MUST be `updateGoal({ spawnedFromPlanId })`.
- **4.2** — A cached `childGoalId` pointing at `archived && state !== "complete"`
  is a dead pointer; wipe it (incl. `_persistActive`) and fall through to
  spawn fresh. Pinned by `tests/runSubgoalStep-stale-archived-invalidates.test.ts`.
- **4.4** — Workflow-less complete-child recovery. Predicate is **conjunctive**
  AND **narrow**: `state === "complete" && !archived && !workflow`. Pinned by
  `tests/runSubgoalStep-degenerate-workflow-less-recovery.test.ts`.
- **4.13** — Paused children continue waiting (paused != failed). The wait
  loop only exits on `cancelled`, external archive, or `ready-to-merge`
  passed. Pinned by `tests/runSubgoalStep-paused-child-keeps-waiting.test.ts`.
- **4.19** — Tier preference (success-aware). Pinned by
  `tests/runSubgoalStep-tier-resolution.test.ts`.

## `parent` workflow gate sequence

```
charter [content, llm-review architect]
  └─ plan-review [content, llm-review architect + spec-auditor]
        └─ goal-plan [manual] ← signaling FREEZES execution.verify[]
              └─ execution [Ralph loop; verify[] starts empty, populated
                           by team-lead via propose+edit; subgoal steps]
                    └─ integration [llm-review architect — cross-component]
                          └─ ready-to-merge [reused readyToMergeGate()]
```

`goal-plan` is signaled by the team-lead (not auto-passed) — that's the
single moment when the plan is frozen and the execution gate's `verify[]`
becomes immutable except via the (Phase 4) mutation classifier.

## Concurrency semaphore design

Single `Map<rootGoalId, Semaphore>` on the harness instance. Lazily created
on first `runSubgoalStep` invocation under a given root; capacity resolved
once at creation via `goalManager.resolveRootMaxConcurrentChildren(rootGoalId)`.

```
default permits   3
hard max          8   (defensive cap on user input — UI should slider-limit too)
floor             1   (never zero — would deadlock the harness)
unknown root      3   (defensive fallback for orphaned semaphores)
```

The semaphore IS the scheduler. There is no background poll loop; the wait
inside `runSubgoalStep` (await on the child's `ready-to-merge`) holds the
slot for the duration of the child's lifetime.

## Public surface for downstream phases

### Phase 4 — REST/tools

- `goal_spawn_child` REST + tool: must mirror `runSubgoalStep`'s Lesson 4.1
  invariant (createGoal → IMMEDIATELY updateGoal({ spawnedFromPlanId })). Any
  spawn site outside the harness has the same liability.
- `goal_plan_propose` writes to `goal.workflow.gates.find(execution).verify[]`
  via the mutation classifier when `executionGate.metadata.frozen === "true"`.
- `goal_merge_child` POST should call `goalManager.mergeChild` then on success
  `teardownTeam + archiveGoalAfterMerge`, mirroring the harness flow.
- `gate_signal goal-plan` already triggers the freeze (server.ts hook); the
  REST handler logs `[gate-signal] Plan frozen for goal <id> (...)`.

### Phase 5b — Plan tab

- `harness.resolvePlanStepChild(parentGoalId, planId, { expectedTitle, active?, stepIndex? })`
  is exposed publicly. Client and server should converge on this tier preference
  to avoid drift (Lesson 4.19 — "Plan tab rendered as failed when the actual
  success child was tier-2 and a zombie sibling was tier-1").
- The cached pointer slot lives at `active.steps[stepIndex].subgoal.childGoalId`
  / `.planId`. The client doesn't have access to `ActiveVerification`; it would
  receive the `child` field of `resolvePlanStepChild`'s return value via REST
  (Phase 4's `GET /api/goals/:id/plan`).

## Suggested AGENTS.md additions (Phase 8 to collate)

Add under "Recipes":

> - **Add a subgoal verify-step** → set `type: "subgoal"` on a workflow gate's
>   verify[] entry with a `subgoal: { planId, title, spec, workflowId?, suggestedRole? }`
>   payload. The harness's `runSubgoalStep` spawns / resolves a child goal and
>   waits for the child's `ready-to-merge` gate to pass before merging the
>   child branch into the parent. See SUBGOALS-SPEC §2, docs/_phase-3-notes.md.

Add under "Debugging":

> - **Duplicate child spawned on every restart** — Lesson 4.1 violation: the
>   harness's createGoal call is followed by something other than
>   `updateGoal({ spawnedFromPlanId })`. Pinned by
>   `tests/runSubgoalStep-spawn-stamps-planId.test.ts`. NEVER add an await
>   between createGoal and the planId stamp — every interruption produces a
>   stranded child whose tier-1 lookup misses on the next signal.
> - **Subgoal step waits forever on a child that's been archived** — Lesson 4.2:
>   the cached `active.steps[i].subgoal.childGoalId` points at an archived
>   non-complete row. Confirm wipe via `_persistActive` and fall-through to
>   spawn. See `tests/runSubgoalStep-stale-archived-invalidates.test.ts`.
> - **Plan tab shows a child as "failed" when there's a successful merged
>   sibling** — Lesson 4.19: tier preference must apply both server-side
>   (`resolvePlanStepChild`) AND client-side (`plan-node-state.ts`).
