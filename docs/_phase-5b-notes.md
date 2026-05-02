# Phase 5b — UI integration for Nested Goals

This file is the working scratchpad for Phase 5b: surfacing pure helpers from
Phase 5a, REST endpoints from Phase 4, and system-prompt stanzas from Phase 6
to the user.

## Status: complete

- 1826 Node unit tests pass (was 1798 + 28 new)
- 1008 Playwright unit tests pass (was 1008)
- 14 new browser E2E tests under `tests/e2e/ui/` (sidebar nesting, plan
  tab, cascade dialogs, breadcrumb, tree cost) — all green
- `npm run check` clean

## Key implementation choices

- **Sidebar projectId fallback** — child goals spawned via the Phase 4
  `goal_spawn_child` REST endpoint do not carry a `projectId` of their own
  (the server-side `goalManager.createGoal` accepts the option but the
  goal record never persists it; only the POST `/api/goals` handler stamps
  `projectId` post hoc). Rather than touch server code (out of scope for
  Phase 5b), the sidebar bucket loop now walks the `parentGoalId` chain to
  inherit projectId. Phase 8 should consider plumbing this through
  `createGoal` proper.
- **Cascade UX** — three new dialogs (`showArchiveGoalDialog`,
  `showPauseGoalDialog`, `showResumeGoalDialog`) in `dialogs.ts`. UI is
  the policy authority: server returns 422 if cascade param missing.
- **Mutation-approval card** — new reducer actions
  (`mutation-pending`, `mutation-update`) keep mutation cards atomic with
  the rest of the transcript. Dedupe by `requestId`. Card flips to a
  decided-disabled state on `mutation_decided`.

## What's wired

- Goal interface in `src/app/state.ts` extended with the nested-goals fields
  (`parentGoalId`, `rootGoalId`, `paused`, `spawnedFromPlanId`,
  `divergencePolicy`, `maxConcurrentChildren`, `acceptanceCriteria`,
  `mergeTarget`, `replanCount`).
- `src/app/sidebar.ts` consumes `buildNestedGoalForest` to render rows with
  per-depth indent (16px/level), descendant count badge, and a
  "Show N more child goals…" expansion row when the depth cap is hit.
- `src/app/goal-dashboard.ts` adds a `Plan` and `Children` tab, gated by
  `shouldShowPlanTab` / `shouldShowChildrenTab`. The Plan tab renders a phase-
  laned DAG SVG via `buildPlanSteps` + `resolvePlanNodeChild` +
  `computeEdgePaths`, with chevron disclosure for inline grandchildren (cap
  depth 3). The Children tab renders a card grid (live + archived).
- Parent breadcrumb (`← root.title / parent.title`) appears in the dashboard
  navbar when the goal has a parent.
- Tree cost rollup (`Tree cost: $X.XX`) appears above per-goal cost; click
  expands a per-child breakdown table sourced from `GET /api/goals/:id/tree-cost`.
- `dialogs.ts` gains `showArchiveGoalDialog`, `showPauseGoalDialog`,
  `showResumeGoalDialog` for cascade confirmation. Wired into `deleteGoal`,
  the dashboard archive/pause/resume buttons.
- New-goal dialog gains "Advanced: paste inline workflow YAML" textarea
  whose contents are sent on creation as `workflow` (parsed YAML).
- WS event subscriptions on `goal_state_changed`, `goal_child_spawned`,
  `mutation_pending`, `mutation_decided`, `cost_changed` from
  `remote-agent.ts` flow into `state.goals` plus throttled re-renders for
  the Plan tab (250ms).
- `mutation_pending` events render an inline chat card with Approve/Reject
  buttons that POST to `/api/goals/:id/mutation/:requestId/decision`.

## Decisions

- Sidebar nesting cap is depth 5 (matches helper default). Deeper is opt-in.
- Plan tab DAG depth cap is 3, matching Lesson 4.22.
- Re-render throttling at 250ms uses a single trailing-edge timer per
  dashboard mount; cleared on tab switch / navigation.
- Cascade confirmations live in `dialogs.ts` (alongside the existing
  `confirmAction`/`showRenameDialog` patterns) rather than a new file —
  three dialogs reuse the same DialogContent layout.
- Archive cascade dialog: when descendants exist, we always send
  `cascade=true`. The "Archive descendants too" checkbox stays checked and
  read-only; tooltip explains why. Sessions teardown is intrinsic to archive
  and cannot be unchecked. This matches the spec text but simplifies the UI
  (one effective state).
- Pause/Resume dialogs offer a true toggleable cascade checkbox because the
  server semantics support both modes.
- We keep the existing `confirmAction("Archive Goal", …)` flow as the
  fall-through for goals with zero descendants — no UX regression for
  single-goal users.

## For Phase 8 docs

- New AGENTS.md "Recipes" entries:
  - "Render nested goal trees / plan DAG" (sidebar-nesting,
    plan-synthesis, plan-node-state, plan-edge-paths, tab-visibility).
  - "Cascade confirmation dialogs" (showArchive/Pause/ResumeGoalDialog
    pattern).
  - "Mutation-approval chat card" (`mutation_pending` → card → POST decision).
- Debugging keyword index entries:
  - "Sidebar nesting depth cap" — `buildNestedGoalForest` `maxDepth: 5`
    default; deeper trees show "Show N more child goals…" inline.
  - "Plan tab missing on goals with ad-hoc subgoals" — see Lesson 4.20.
  - "Tree cost looks stale" — see Lesson 4.21 + the `cost_changed` event.
  - "Mutation card never appears" — confirm `mutation_pending` WS event
    is being broadcast.

## Open questions

- The `cost_changed` WS event is not yet emitted by the server in this
  worktree. We subscribe defensively — the rollup re-fetches on
  `goal_state_changed` AND on a 30-second poll fallback so staleness is
  bounded even if the event never lands.
