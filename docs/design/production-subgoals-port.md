# Production Sub-Goals — Porting Design (from PR #497)

## Summary

Port the complete nested sub-goals system from PR #497
(`origin/goal/audit-subg-225e4d3d`) onto the goal branch, **excluding LSP**
(~57 files) and without re-introducing marketplace (already on master).

#497's merge-base is `21e80e3d`, which is essentially current `master` minus
one perf commit — so shared files have **not** diverged. This makes a
*verbatim file-level port* (`git checkout origin/goal/audit-subg-225e4d3d --
<file>`) the correct, low-risk strategy. Only shared files that also carry LSP
wiring need a surgical edit to strip the LSP lines.

## Scope decisions

- **In scope:** everything in #497 *except* LSP. This includes nesting-limit
  governance, spawn/merge backend, plan-mutation + divergence policy,
  pause/resume cascade, cost roll-up, proposal-modal subgoal controls +
  Workflow/Roles tabs, sidebar nesting, Plan/Children dashboard tabs, the nine
  `Children` tools + renderers, and all associated tests.
- **Out of scope (do NOT port):** every `src/server/lsp/**`,
  `defaults/tools/lsp/**`, `*lsp*` renderer, `*lsp*` doc, and `*lsp*` test.
  Also strip LSP wiring (imports, tool-group entries, system-prompt hints,
  role-yaml `Lsp` policies, renderer-registry LSP entries) from otherwise
  in-scope shared files.
- **Marketplace:** already merged to master; **not** part of #497's diff. Do
  not touch.

## LSP exclusion list (files to skip entirely)

```
src/server/lsp/**                       (authorize-cwd, cleanup-hook, client,
                                         clients/*, error, language-detect,
                                         sandbox-bridge, server-process,
                                         supervisor, types)
src/server/agent/lsp-hint.ts
defaults/tools/lsp/**
defaults/tools/_shared/lsp-telemetry.ts
defaults/tools/_builtins/grep-lsp-hint.ts
defaults/tools/shell/bash-lsp-hint.ts
src/ui/tools/renderers/Lsp*.ts            (Definition, Diagnostics,
                                           DocumentSymbols, Hover, References,
                                           Rename, WorkspaceSymbol, LspShared)
docs/lsp.md, docs/design/lsp-code-intelligence.md
tests/**lsp** , tests/lsp/** , tests/fixtures/lsp-ts/**
```

Shared files that must have LSP wiring stripped after checkout:
`defaults/tools/_builtins/extension.ts`, `defaults/tools/shell/extension.ts`,
`defaults/system-prompt.md`, `defaults/roles/{code-reviewer,reviewer,
security-reviewer}.yaml`, `src/server/agent/system-prompt.ts`,
`src/server/agent/session-setup.ts`, `src/ui/tools/index.ts`,
`src/ui/tools/renderer-registry.ts`, `src/app/main.ts`, `src/app/api.ts`,
`src/server/server.ts`, `src/server/agent/session-manager.ts`.

## Authoritative file inventory (port verbatim)

### Backend — `src/server/**`, `defaults/**` (Coder A)
New standalone modules (checkout as-is):
`subgoal-nesting-limit.ts`, `goal-subtree.ts`, `goal-descendants.ts`,
`child-ready-to-merge.ts`, `spawn-child-spawnedby.ts`,
`spawn-child-spec-validation.ts`, `spawn-child-workflow.ts`,
`nested-goal-routes.ts`, `plan-mutation.ts`, `plan-mutation-store.ts`,
`parent-workflow-freeze.ts`, `goal-paused-guard.ts`, `cost-tracker.ts`,
`cost-backfill.ts`, `depends-on-validation.ts`,
`notify-team-lead-child-passed.ts`, `notify-team-lead-failure.ts`.

Shared modules (checkout, then strip LSP if present):
`goal-store.ts`, `goal-manager.ts`, `server.ts`, `verification-harness.ts`,
`verification-logic.ts`, `verification-reviewer-meta.ts`,
`session-manager.ts`, `session-setup.ts`, `team-manager.ts`,
`team-manager-helpers.ts`, `team-store-consistency.ts`, `task-manager.ts`,
`gate-store.ts`, `workflow-store.ts`, `config-cascade.ts`,
`project-context.ts`, `project-registry.ts`, `resolve-role.ts`,
`role-prompt.ts`, `system-prompt.ts`, `tool-activation.ts`,
`tool-group-policy-store.ts`, `rpc-bridge.ts`, `session-sidecar.ts`,
`team-names.ts`, `harness.ts`, `skills/git.ts`,
`state-migration/seed-default-workflows.ts`, `ws/protocol.ts`,
`proposals/proposal-types.ts`, `search/flex-store.ts`,
`preview/path-guard.ts`.

Config/tools/roles:
`defaults/tools/children/*`, `defaults/tool-group-policies.yaml` (Children
group), `defaults/roles/*.yaml` + `.bobbit/config/roles/*.yaml` (Children
policy: `always-allow` team-lead, `never` contributors),
`defaults/tools/team/*`, `defaults/tools/proposals/*`, `defaults/system-prompt.md`.

### Frontend — `src/app/**`, `src/ui/**`, `src/shared/**` (Coder B)
`subgoals-flag.ts`, `proposal-panels.ts` (subgoal toggle, max-depth control,
Workflow/Roles tabs), `settings-page.ts` (Subgoals toggle +
`general-max-nesting-depth` stepper), `main.ts` + `remote-agent.ts` (dataset
mirroring), `sidebar-nesting.ts`, `sidebar-spawned-children.ts`, `sidebar.ts`,
`sidebar-nav.ts`, `render-helpers.ts`, `render.ts`, `state.ts`, `api.ts`,
`custom-messages.ts`, `message-reducer.ts`, `routing.ts`,
`session-manager.ts`, `dialogs.ts`, `team-archived-bucket.ts`,
`goal-dashboard.ts`, `goal-dashboard-plan-tab.ts`,
`goal-dashboard-children-tab.ts`, `goal-dashboard-tab-visibility.ts`,
`plan-synthesis.ts`, `plan-node-state.ts`, `plan-edge-paths.ts`,
`tree-cost-legacy.ts`, `role-manager-page.ts`, `tool-manager-page.ts`,
`workflow-page.ts`, `app.css`, `workflow-page.css`.
UI tool renderers: the nine `Goal*Renderer.ts`
(`GoalSpawnChildRenderer`, `GoalMergeChildRenderer`,
`GoalArchiveChildRenderer`, `GoalDecideMutationRenderer`,
`GoalPauseResumeRenderer`, `GoalPlanProposeRenderer`,
`GoalPlanStatusRenderer`, `GoalSetPolicyRenderer`), plus
`children-renderer-helpers.ts`, `src/ui/lazy/children-mutation-approval.ts`,
`src/ui/lazy/children-goal-state-pill.ts`, `renderer-registry.ts`,
`tools/index.ts`, `tools/types.ts`, `components/Messages.ts`,
`components/sidebar-filters.ts`. `src/shared/parse-acceptance-criteria.ts`.

### Tests (Coder C)
Port all `tests/**` named in #497 except `*lsp*`/`tests/lsp/**`/
`tests/fixtures/lsp-ts/**`: the unit suites (`subgoal-nesting-limit`,
`plan-mutation*`, `tree-cost*`, `cost-backfill*`, `goal-subtree`,
`goal-descendants`, `child-ready-to-merge-helper`, `runSubgoalStep-*`,
`children-tool-renderers`, `sidebar-spawned-children`, `subgoals-flag`,
`role-children-tools-policy`, source-pins) and the E2E suites
(`api-goals-spawn-child-route`, `api-subgoals-disabled`,
`subgoal-nesting-limit`, `subgoals-experimental-toggle`,
`plan-tab-archived-children`, `plan-archived-children`,
`sidebar-spawned-children-dedupe`, `tree-cost-rollup`, `cost-backfill-on-boot`,
`children-tool-renderers`), plus test harness/helper deltas
(`e2e-setup.ts`, `gateway-harness.ts`, `in-process-harness*.ts`,
`mock-agent-core.mjs`, `spec-framework.ts`, `dom-stub.ts`,
`helpers/run-subgoal-step-fixture.ts`).

## Key behavioural invariants (from spec, pinned by ported tests)

- Depth = parent hops + 1 (root = 1), cycle-guarded bounded walk.
- System ceiling `maxNestingDepth` (default 3, clamp 1..10) is a hard cap;
  per-goal override can only **tighten**; children inherit parent's effective
  flags. Team-lead at `depth == maxDepth` cannot spawn any child.
- Server-side enforcement on both spawn paths: `403 SUBGOALS_DISABLED` /
  `403 NESTING_DEPTH_EXCEEDED`.
- System `subgoalsEnabled` is the master gate; **default flipped ON** in
  production (the one deliberate deviation from #497, which defaults OFF).
- Children merge locally into parent branch (`git merge --no-ff`); only root
  raises a PR; conflicts `git merge --abort` + preserve child.
- Per-root concurrency semaphore (default 3, floor 1, max 8) is the scheduler.
- Plan mutation classifier (`noop`/`fix-up`/`expansion`/`restructure`/
  `criteria-drop`); criteria-drop always rejected; divergence policy matrix
  (`strict`/`balanced`/`autonomous`); `replanCount > 5` auto-pauses.
- Pause/resume cascade requires `{cascade}` (`422 CASCADE_REQUIRED`); every
  spawn path returns `409 GOAL_PAUSED`; boot respawn supervisor skips paused
  goals.

## Production deviation from #497

In `readSubgoalNestingPrefs` / the system prefs default, flip
`subgoalsEnabled` default from `false` to `true`. Update the corresponding
unit/E2E expectation accordingly. This is the only intentional behavioural
change; everything else is verbatim.

## Architecture / API contracts (self-contained)

All nested-goal routes live in `nested-goal-routes.ts`, dispatched from
`server.ts::handleApiRoute()`. Enforcement is funnelled through single-source
helpers so REST and the verification harness share one code path:
`subgoal-nesting-limit.ts` (`checkCanSpawnChild`), `goal-paused-guard.ts`
(pause gate), `child-ready-to-merge.ts` (RTM), `plan-mutation.ts`
(classifier), `parent-workflow-freeze.ts` (freeze).

### REST endpoints
- `POST /api/goals/:id/spawn-child` — body `{ planId, title, spec,
  dependsOn?: string[], workflowId?, suggestedRole?, inlineWorkflow?,
  inlineRoles? }`. Idempotent on `planId`. Errors: `409 GOAL_PAUSED`,
  `400 SPEC_TOO_SHORT`, `403 SUBGOALS_DISABLED`,
  `403 NESTING_DEPTH_EXCEEDED {currentDepth,maxDepth}`,
  `400 SELF_DEPENDENCY|UNKNOWN_PLAN_ID|DEPENDS_ON_CYCLE`. Children inherit the
  root repo path (cwd derived via `path.relative` offset) and the parent's
  effective `subgoalsAllowed`/`maxNestingDepth`. Stamps `spawnedFromPlanId`,
  `dependsOnPlanIds`, `spawnedBySessionId`, `parentGoalId` immediately.
- `GET /api/goals/:id/plan` — returns the execution-gate subgoal steps + their
  state; `frozen` reflects `gate.metadata.frozen === "true"`.
- `PATCH /api/goals/:id/plan` — body `{ proposedSteps[] }`; requires an
  `execution` gate (`409 NO_EXECUTION_GATE`); validates each step
  (`400 INVALID_PLAN_STEP`); runs depends-on validation then the mutation
  classifier. Verdicts: `criteria-drop`→`409 CRITERIA_DROP`;
  `restructure` on non-paused goal→`409 RESTRUCTURE_REQUIRES_PAUSE`; `noop`
  no-op; `fix-up` auto-applies under `balanced`/`autonomous`; otherwise an
  approval request is persisted (24h TTL) for `POST /mutation/:requestId/decision`.
- `POST /api/goals/:id/integrate-child/:childId` — requires child RTM
  (`409 RTM_NOT_PASSED`) and matching parent (`400 PARENT_MISMATCH`); merges
  the child branch locally into the parent.
- `POST /api/goals/:id/pause` and `/resume` — body `{ cascade: boolean }`
  required (`422 CASCADE_REQUIRED`); optional `childGoalId` must be a direct
  child (`403 NOT_DIRECT_CHILD`). Pause soft-aborts subtree sessions and
  cancels in-flight verifications; resume re-enables spawns.
- `POST /api/goals/:id/mutation/:requestId/decision` — body `{ approve }`;
  applies or rejects a pending plan mutation.
- `PATCH /api/goals/:id/policy` — root-only; sets `divergencePolicy`
  (`strict`/`balanced`/`autonomous`) and `maxConcurrentChildren`
  (floor 1, hard max 8).
- `GET /api/goals/:id/descendants` — live + archived descendants for the Plan
  tab (independent of the sidebar's archived filter).
- `GET /api/goals/:id/tree-cost` — cost/token rollup rooted at the requested
  goal across its subtree (live + archived), surviving purge via `goalId`
  stamping on cost records.

### Persisted `PersistedGoal` fields (owned by `goal-store.ts`)
`parentGoalId?`, `subgoalsAllowed?`, `maxNestingDepth?`,
`divergencePolicy?`, `maxConcurrentChildren?`, `spawnedFromPlanId?`
(idempotency key, stamped synchronously after `createGoal`),
`dependsOnPlanIds?`, `spawnedBySessionId?`, `paused?`, `replanCount?`.

### Children tools (team-lead only; `always-allow` team-lead / `never`
contributors via `tool-group-policies.yaml` Children group)
`goal_spawn_child`, `goal_plan_propose`, `goal_plan_status`,
`goal_merge_child`, `goal_pause`, `goal_resume`, `goal_archive_child`,
`goal_decide_mutation`, `goal_set_policy` — thin wrappers over the REST
contracts above.

## Acceptance matrix (criteria quoted verbatim → surfaces)

| Acceptance criterion | Backend | Frontend | Tests |
|---|---|---|---|
| "A goal proposal exposes an Allow-subgoals toggle and Max-depth control, gated by the system Subgoals preference." | subgoal-nesting-limit, prefs (config-cascade) | proposal-panels, subgoals-flag, settings-page | subgoals-flag, e2e/subgoals-experimental-toggle, e2e/goal-proposal-form |
| "A team-lead can spawn a sub-goal via a tool call only when its goal permits subgoals." | nested-goal-routes, defaults/tools/children/goal_spawn_child | GoalSpawnChildRenderer | api-goals-spawn-child, role-children-tools-policy |
| "Spawning is refused server-side past the nesting ceiling, and a team-lead at the depth cap cannot create a subgoals-allowed child." | subgoal-nesting-limit (`checkCanSpawnChild`), nested-goal-routes | — | subgoal-nesting-limit, e2e/subgoal-nesting-limit, e2e/api-subgoals-disabled |
| "Nested sub-goals render under their spawning team-lead in the sidebar with a descendant-count badge." | spawn-child-spawnedby | sidebar-nesting, sidebar-spawned-children, render-helpers | sidebar-spawned-children, e2e/sidebar-spawned-children-dedupe |
| "The goal dashboard shows a DAG … per-node status, archived distinction, and merge/conflict state." | goal-descendants (`GET /descendants`) | plan-synthesis, plan-node-state, goal-dashboard-plan-tab | plan-archived-children, e2e/plan-tab-archived-children |
| "Subtree cost and tokens roll up across live and archived descendants." | cost-tracker, cost-backfill (`GET /tree-cost`, `goalId` stamp) | goal-dashboard-children-tab, tree-cost-legacy | tree-cost-rollup, tree-cost-purge-survival, cost-backfill, e2e/cost-backfill-on-boot |
| "An agent can attach a custom workflow … and a child may override its parent's workflow." | spawn-child-workflow, workflow-store, nested-goal-routes | proposal-panels (Workflow/Roles tabs) | spawn-child-workflow-resolution, runSubgoalStep-inline-roles-inheritance |
| "Completed child work merges locally into the parent branch with no per-child PR; only the root goal raises a PR; merge conflicts preserve the child." | skills/git (`mergeChildBranchLocal`, `shouldSkipRemotePush`), verification-harness (`runSubgoalStep`), child-ready-to-merge | GoalMergeChildRenderer | child-ready-to-merge-helper, runSubgoalStep-merge-then-archive |
| "Plan changes after freeze are classified and gated by the divergence policy; criteria-drops are always rejected; excessive replans auto-pause the goal." | plan-mutation, plan-mutation-store, parent-workflow-freeze | GoalPlanProposeRenderer, GoalDecideMutationRenderer, children-mutation-approval | plan-mutation, plan-mutation-store, api-goals-plan-mutation |
| "An operator can pause/resume a goal's entire subtree, and pause actually stops the work and survives supervisor respawn." | goal-paused-guard, goal-manager (`_bootRespawnSessionlessGoals` skip) | GoalPauseResumeRenderer | any-in-flight-child-excludes-paused, runSubgoalStep-paused-child-keeps-waiting |

## Edge cases and recovery

| Condition | Detection point | Response | Tests |
|---|---|---|---|
| Sibling dependency cycle / self-dep / unknown id | `depends-on-validation.ts` at spawn + plan PATCH | `400 DEPENDS_ON_CYCLE` / `SELF_DEPENDENCY {planId}` / `UNKNOWN_PLAN_ID {missing}` | goal-spawn-child-dependsOn, depends-on-validation |
| Child with unmet deps | spawn / integrate-child | created paused, auto-resumes when last dep merges | goal-spawn-child-dependsOn-blocking, runSubgoalStep-dependsOn-stamping |
| Merge conflict | `runSubgoalStep` merge | `git merge --abort`, step fails with manual-recovery directive, child preserved (not archived) | runSubgoalStep-merge-then-archive |
| Workflow-less `complete` child | `runSubgoalStep` recovery | degenerate-workflow recovery treats as ready-to-merge | runSubgoalStep-degenerate-workflow-less-recovery |
| Stale archived/child pointer | `runSubgoalStep` | stale-pointer invalidation, re-resolves | runSubgoalStep-stale-archived-invalidates |
| Retroactive system depth reduction | `effectiveMaxNestingDepth` (system is ceiling) | live trees retroactively capped; deeper spawns refused | subgoal-nesting-limit |
| `replanCount > 5` | plan PATCH | auto-pause the goal | plan-mutation, api-goals-plan-mutation |
| Pending mutation TTL / restart | `plan-mutation-store` | 24h TTL, restart-safe persistence | plan-mutation-store |
| Archived descendants in DAG vs live-only sidebar | `GET /descendants` (inclusive) vs `plan-live-only-toggle` | DAG includes archived (dimmed); sidebar filters | plan-archived-children |
| Boot respawn over paused goal | `goal-manager` supervisor | skips paused goals (whack-a-mole fix); `backfillCompleteState` | any-in-flight-child-excludes-paused, cost-backfill-on-boot |

## Execution plan (parallel, file-disjoint)

1. **Coder A — backend** (`src/server/**`, `defaults/**`): checkout listed
   files from the ref, strip LSP wiring, flip the prefs default, get the
   server half of `npm run check` green.
2. **Coder B — frontend** (`src/app/**`, `src/ui/**`, `src/shared/**`):
   checkout listed files, strip LSP renderers/wiring, get the web half of
   `npm run check` green. Backend & frontend share **no files**; type
   contracts come from the same source so they stay consistent.
3. **Coder C — tests** (after A+B merge): port test suites + harness deltas,
   get `npm run test:unit` and `npm run test:e2e` green.

Coders A and B run in parallel (disjoint paths). Coder C depends on both.

## Verification

- `npm run check` (server + web) clean.
- `npm run test:unit`, `npm run test:e2e` green.
- Clean diff: `git diff --name-only master | grep -i lsp` returns nothing;
  no marketplace modules touched.
- Browser E2E coverage for every user-facing surface (proposal toggle,
  sidebar nesting, plan tab, pause cascade) via the ported suites.
