# Phase 5a — Pure Helpers for Nested Goals UI

Five pure-TypeScript helpers (~250 LoC implementation, ~430 LoC tests) that
Phase 5b consumes from `goal-dashboard.ts`, `sidebar.ts`, and `render.ts`.
None of these touch the DOM, import `lit`, or reach into `src/server/`.

## Helper summary (one-liners)

| File | Summary |
|---|---|
| `src/app/sidebar-nesting.ts` | Build a `NestedGoalNode` forest from flat goals via `parentGoalId`; depth cap, orphan promotion, descendantCount aggregation. |
| `src/app/goal-dashboard-tab-visibility.ts` | Predicates for Plan / Tasks / Children tab visibility on the goal dashboard. Plan tab obeys Lesson 4.20 (formal gate OR live children). |
| `src/app/plan-synthesis.ts` | Build `PlanStep[]` for the Plan tab. Two modes: formal-plan-verbatim + orphan ad-hoc append, OR living plan from createdAt-clustered children (Lesson 4.20). |
| `src/app/plan-node-state.ts` | Resolve a Plan-tab node's displayed `state` from the children that share its `planId`, using Lesson 4.19 tier preference (live in-progress > archived complete > live other > archived non-complete). |
| `src/app/plan-edge-paths.ts` | Compute SVG `d` strings for DAG edges as 3-segment shared-mid-line connectors (`M x1 y1 L x1 ymid L x2 ymid L x2 y2`). |

## Notes for the Phase 5b consumer

- **`buildPlanSteps` recomputes on every render.** Keep the call cheap on
  the hot path (the algorithm is O(n log n)). Throttle re-renders at 250ms
  (per spec §Lesson 4.22) on `goal_state_changed` / `goal_child_spawned`
  WS events to avoid layout thrash.
- **`buildNestedGoalForest` does NOT sort the top-level forest.** It only
  sorts children within each parent (by `createdAt` ASC). The caller decides
  how to order roots — `goal-dashboard.ts` typically already sorts the
  top-level list separately.
- **`shouldShowChildrenTab` takes a precomputed boolean.** This avoids
  threading the entire `goals` list through the predicate when the caller
  already knows the answer (e.g. a precomputed `Map<goalId, count>`).
- **`shouldShowPlanTab` accepts the *full* goals list.** The caller is
  expected to pass non-archived goals when it wants the "living plan" branch
  to fire — archived filtering is the caller's concern so this helper stays
  composable with the same `state.goals` reference used elsewhere.
- **`resolvePlanNodeChild` is the client-side mirror of the server's
  `resolvePlanStepChild`** (which lands in Phase 3). The two MUST agree on
  display state for a given input. Tests in `tests/plan-node-state.test.ts`
  cover all four tiers and tie-break edge cases; if Phase 3 changes the
  server algorithm, update both in lockstep.
- **`computeEdgePaths` returns deterministic strings.** `fmt()` trims
  trailing zeros so integer and float coordinates produce stable output for
  test snapshots (e.g. `M 50 40` not `M 50.0 40.0`).
- **`midLineY` callback is supplied per-render.** A consumer that wants
  per-phase horizontal aisles passes a constant; one wanting per-edge
  midpoints passes `(y1, y2) => (y1 + y2) / 2`. `goal-dashboard.ts` is the
  natural home for the layout policy.

## Lesson refs

- **Lesson 4.19** — Plan-node tier preference. Live in-progress wins over
  archived+complete (in-flight overrides past success). Archived+complete
  wins over live todo (success terminal). See `plan-node-state.ts`.
- **Lesson 4.20** — Living plan synthesis from live children. Plan tab is
  visible on goals with NO formal `goal-plan` gate as long as they have
  ad-hoc child goals — the synthesis clusters by `createdAt` gap (default
  60s) into phases. See `plan-synthesis.ts` and the `shouldShowPlanTab`
  predicate.
- **Lesson 4.21** — Cost rollup. Not in scope for Phase 5a (pure helpers
  only); it lives in Phase 5b's `goal-dashboard.ts` walking the descendant
  tree returned by `buildNestedSubtree`. The pure helper makes the walk
  trivial: `subtree.descendantCount` is already pre-computed.
- **Lesson 4.22** — Plan-tab nested rendering. The DAG SVG renders nested
  sub-trees inline with a render-depth cap (3 in the SVG, 5 in the sidebar).
  `buildNestedGoalForest`'s `maxDepth` honours this; deeper levels surface
  via `truncatedChildrenCount` so the consumer can render "Show N more…".

## Suggested AGENTS.md additions (for Phase 5b / 8)

When Phase 5b lands, add an AGENTS.md recipe entry:

```markdown
- **Render nested goal trees / plan DAG** → pure helpers in
  `src/app/sidebar-nesting.ts`, `src/app/plan-synthesis.ts`,
  `src/app/plan-node-state.ts`, `src/app/plan-edge-paths.ts`,
  `src/app/goal-dashboard-tab-visibility.ts`. Lit components consume the
  returned structures; never re-implement the tree walk or tier preference
  in the UI layer. See [docs/design/nested-goals.md].
```

And under "Debugging" once the bug surface is known:

```markdown
- **Plan tab shows wrong child / dupe shadow** → check
  `resolvePlanNodeChild` tier order. Lesson 4.19 says archived+complete
  beats live+todo (success terminal); live+in-progress beats archived+
  complete (in-flight overrides past success). Server-side mirror is
  `resolvePlanStepChild` — they MUST agree.
- **Plan tab missing on goals with ad-hoc subgoals** → check
  `shouldShowPlanTab` is being called with the full live-goals list, not
  just the formal-gate check. Lesson 4.20.
```
