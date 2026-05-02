# Phase 1 hand-off notes — for the coordinator / Phase 8 to collate into AGENTS.md

This is a short bullet list of what Phase 1 added, intended for the Phase 8 documentation pass to merge into `AGENTS.md` Recipes / Debugging keyword index. Phase 1 deliberately does NOT edit `AGENTS.md` — multiple parallel phases are touching it and the coordinator owns conflict resolution.

## Files added / changed in Phase 1

- `src/server/agent/goal-store.ts` — added 9 optional fields on `PersistedGoal` (parentGoalId, rootGoalId, mergeTarget, divergencePolicy, maxConcurrentChildren, acceptanceCriteria, spawnedFromPlanId, paused, replanCount). Lazy migration: legacy goals.json loads unchanged, missing fields read as undefined.
- `src/server/agent/goal-manager.ts` — `createGoal` accepts optional `parentGoalId`; auto-derives `rootGoalId` (`id` for root, `parent.rootGoalId ?? parent.id` for child) and `mergeTarget` (`"master"` for root, `"parent"` for child); cycle-prevention walk capped at 64 deep. Lesson 4.3 fail-loud branch: `workflowId` given but neither `resolvedWorkflow` nor `workflowStore` present → throw. New exported helper `deriveNestingFields` (pure) + constant `NESTING_WALK_DEPTH_CAP`.
- `src/server/agent/project-context.ts` — construction order swapped so `WorkflowStore` is built before `GoalManager`; `new GoalManager(this.goalStore, this.workflowStore)` wires the store in (Lesson 4.3).
- `src/shared/parse-acceptance-criteria.ts` — new pure helper. No DOM, no node-only APIs.
- `docs/goals-workflows-tasks.md` — new "Nested goals (Phase 1 data model)" subsection right after the existing Goals concept block, with a field table + derivation rules + criteria-coverage explanation.
- Tests added (4 new test files, ~49 new passing tests):
  - `tests/goal-store-nesting.test.ts` (10 tests) — round-trip persistence + lazy migration.
  - `tests/goal-manager-nesting.test.ts` (13 tests) — auto-derivation, three-generation tree, cycle prevention, depth cap, no-inherit policy fields.
  - `tests/goal-manager-workflow-store-required.test.ts` (7 tests) — Lesson 4.3 fail-loud + legacy-path preservation.
  - `tests/parse-acceptance-criteria.test.ts` (19 tests) — heading variants, bullet styles, code fences, multi-paragraph, edges.

## AGENTS.md "Recipes" entries to add

- **Add a nested-goal field** → extend `PersistedGoal` in `src/server/agent/goal-store.ts`; the lazy-migration in `load()` handles missing fields automatically (just don't backfill defaults at the data layer — compute at use sites). Update `tests/goal-store-nesting.test.ts` round-trip cases and the field table in `docs/goals-workflows-tasks.md` "Nested goals (Phase 1 data model)".
- **Create a child goal** → call `goalManager.createGoal(title, cwd, { parentGoalId, workflowId, ... })`. Top-level goals omit `parentGoalId`; the manager auto-derives `rootGoalId` and `mergeTarget` and walks the parent chain for cycle prevention (capped at `NESTING_WALK_DEPTH_CAP = 64`). The cycle-prevention branch is unit-testable via the exported pure helper `deriveNestingFields(newId, parentGoalId, lookup)`.
- **Parse `## Acceptance criteria` from spec markdown** → `parseAcceptanceCriteria(md)` in `src/shared/parse-acceptance-criteria.ts`. Pure, no DOM, importable from server and app. Used by `GoalManager.createGoal` (Phase 1) and the plan-mutation classifier criteria-coverage check (Phase 4).

## AGENTS.md "Debugging" keyword index entries to add

- **Lesson 4.3 — child goal created with `workflow: undefined` / gates never appear / `ready-to-merge` polls forever** — `GoalManager` constructed without a `WorkflowStore`. `createGoal({workflowId: ...})` now throws with message containing "Lesson 4.3" and pointing at `docs/_phase-1-notes.md`. Fix: `project-context.ts` must construct `new GoalManager(goalStore, workflowStore)` (workflowStore wired in Phase 1). Legacy paths preserved: `createGoal({})` (no workflowId, no workflowStore) and `createGoal({workflowId, resolvedWorkflow})` both still succeed.
- **Cycle / infinite loop in createGoal parent walk** — depth cap is `NESTING_WALK_DEPTH_CAP = 64` in `src/server/agent/goal-manager.ts`. A self-referential `parentGoalId === id` row in goals.json (corrupt store state) terminates the walk via the cap, not via cycle detection — so the child creates successfully against the corrupt parent. The cycle-detection THROW only fires when the new goal's id matches an ancestor in the chain.
- **`rootGoalId` shows up as the parent's id (not the root's id) for a child of a legacy parent** — by design. Legacy parents predate Phase 1 and have `rootGoalId === undefined`. The fallback rule is `parent.rootGoalId ?? parent.id`, so a child of a legacy parent gets `rootGoalId === parent.id`. Re-running `createGoal` against the now-Phase-1-migrated parent will produce the correct chain.

## One-line summary of each new field

- `parentGoalId` — parent goal (undefined for root). Set only at creation.
- `rootGoalId` — root of the tree. Auto-derived; equals id for root, parent's chain otherwise.
- `mergeTarget` — `"master"` (root → PR) or `"parent"` (child → local merge). Auto-derived.
- `divergencePolicy` — `strict` / `balanced` / `autonomous`. Root-only, default `balanced`.
- `maxConcurrentChildren` — semaphore size keyed by rootGoalId. Root-only, default 3, hard max 8.
- `acceptanceCriteria` — list of strings parsed from spec's `## Acceptance criteria`. Used by the Phase 4 criteria-coverage check.
- `spawnedFromPlanId` — subgoal idempotency key. Stamped immediately after createGoal by the harness (Lesson 4.1).
- `paused` — user pauses a goal mid-flight. A paused child does NOT suppress the parent's idle nudge (Lesson 4.13).
- `replanCount` — successful post-freeze mutations. `> 5` triggers auto-pause.
