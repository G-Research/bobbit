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

Each shared-file group below is tagged with the **specific subgoals concern**
it carries, so the porting coder takes only the subgoal-relevant delta and not
incidental #497 drift. For broad shared files (`project-context.ts`,
`project-registry.ts`, `search/flex-store.ts`, `preview/path-guard.ts`,
`rpc-bridge.ts`, manager-page UIs), **diff against master first and port only
hunks that reference subgoal/nested/children/plan/pause/cost symbols** — if a
hunk is unrelated to sub-goals, leave it out.

### Backend — `src/server/**`, `defaults/**` (Coder A)
Rationale tags: goal-store/goal-manager = **new goal fields + store
migration**; nested-goal-routes/spawn-child-*/server.ts = **REST surface +
route wiring**; verification-harness/-logic/-reviewer-meta = **subgoal verify
step (`runSubgoalStep`) + recovery**; skills/git = **local child merge
helpers**; plan-mutation*/parent-workflow-freeze = **governance**;
goal-paused-guard/session-manager/team-manager = **pause cascade + session
soft-abort**; cost-tracker/cost-backfill = **subtree cost rollup +
goalId stamp**; config-cascade/project-context = **subgoal prefs**;
tool-activation/tool-group-policy-store/resolve-role/role-prompt/system-prompt =
**Children tool gating + prompt injection**; workflow-store/
seed-default-workflows = **parent/subgoal workflow + execution gate**;
ws/protocol = **goal_state_changed / mutation_pending broadcasts**.
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
Rationale tags: proposal-panels = **subgoal toggle + max-depth + Workflow/Roles
tabs**; subgoals-flag/settings-page/main/remote-agent = **system pref +
dataset mirror**; sidebar-* /render-helpers = **nesting hierarchy + badges**;
goal-dashboard*/plan-* = **DAG plan/children tabs**; Goal*Renderer/children-* =
**Children tool cards**; api/state/message-reducer/custom-messages = **REST
client + WS state**. The detailed UX requirements these must satisfy:

- **Plan tab inline nested disclosure:** a chevron on a child node expands that
  child's plan recursively (depth cap 3); overflow collapses to a
  "Show N more…" affordance. `plan-live-only-toggle` (`data-testid`) defaults
  to inclusive (shows archived, dimmed/dashed with `plan-node-archived-pill`).
  Per-node gate status pending/running/passed/failed/bypassed; merge/conflict state per
  child. Source DAG from `GET /descendants` (live + archived), not the
  archived-filtered sidebar list.
- **Sidebar:** children nest under their spawning team-lead
  (`spawnedBySessionId`, resolved at spawn + render-side fallback); parent rows
  show a `sidebar-descendant-badge` descendant count; **same-titled siblings
  get a disambiguation suffix**; depth-5 sidebar cap; live/archived/blocked
  children visually distinguished.
- **Approval surfaces (both):** the in-chat `<children-mutation-approval>`
  custom message **and** a dashboard **mutation-pending card** (driven by the
  `mutation_pending` broadcast), both POSTing
  `/mutation/:requestId/decision`.
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
  flags. Team-lead at `depth == maxDepth` cannot spawn any child. The per-goal
  `subgoalsAllowed` / `maxNestingDepth` overrides are **editable after creation**
  via `PATCH /policy` (operator-class), re-clamped to the inherited ceiling on
  every write; `effectiveMaxNestingDepth` recomputes against the live ancestor
  chain so a retroactively tightened ancestor binds existing descendants.
- Server-side enforcement on both spawn paths: `403 SUBGOALS_DISABLED`
  (system pref OFF — master gate, always wins) / `403 PARENT_SUBGOALS_DISABLED`
  (system ON but the specific parent has `subgoalsAllowed: false`; message names
  the parent) / `403 NESTING_DEPTH_EXCEEDED`. The parent-disallowed case is a
  **distinct code** from the system-off case so the UI doesn't mislabel a
  per-goal opt-out as a broken system setting; wording is aligned across
  `server.ts`, `nested-goal-routes.ts`, and `verification-harness.ts`.
- System `subgoalsEnabled` is the master gate; **defaults OFF**, aligned with
  #497 (an earlier production deviation that flipped it ON has been reverted —
  unset/missing reads as disabled, only an explicit `true` enables it).
- Children merge locally into parent branch (`git merge --no-ff`); only root
  raises a PR; conflicts `git merge --abort` + preserve child.
- Per-root concurrency semaphore (default 5, floor 1, max 8) is the scheduler.
  The shared `ChildTeamScheduler` (`child-team-scheduler.ts`, owned by the
  harness, reached by the REST routes via `verificationHarness.requestChildStart`
  / `notifyChildTerminal`) is the SINGLE authority for ALL child-team starts —
  harness `runSubgoalStep`, REST `spawn-child`, `POST /api/goals` child
  creation, and `integrate-child` dependency auto-unblock. At cap a child is
  created/parked `state='blocked'` (capacity-blocked) and enqueued FIFO; a
  terminal event (merge/archive/completion) releases the permit and starts the
  next eligible child (no poll loop). `POST /api/goals` with `parentGoalId` is
  refused with `409 GOAL_PAUSED` when the parent or any paused ancestor is
  paused (`requireAncestorsNotPaused`). Harness Tier-3 existing-child handling
  is state-aware: `blocked`→release/wait/reacquire, `todo`/awaiting→start under
  the permit, `in-progress`→wait.
- Plan mutation classifier (`noop`/`fix-up`/`expansion`/`restructure`/
  `criteria-drop`); criteria-drop always rejected; divergence policy matrix
  (`strict`/`balanced`/`autonomous`); `replanCount > 5` auto-pauses.
- Pause/resume cascade requires `{cascade}` (`422 CASCADE_REQUIRED`); every
  spawn path returns `409 GOAL_PAUSED`; restart boot-resume nudges skip paused
  restored teams.

## Production deviation from #497 (reverted)

An earlier production build deviated from #497 by flipping the
`subgoalsEnabled` default from `false` to `true` in `readSubgoalNestingPrefs` /
the system prefs default. **That deviation has been reverted**: the default is
now `false` (OFF), matching #497. Every `subgoalsEnabled !== false` (unset →
enabled) read was inverted to `subgoalsEnabled === true` (unset → disabled), and
the UI dataset mirror (`document.documentElement.dataset.subgoalsEnabled`)
defaults to `"false"` when the preference is unset. Sub-goals are now an
experimental, opt-in feature; the user enables them via
Settings → System → General → Subgoals. There are no remaining intentional
behavioural deviations from #497.

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
  `400 SPEC_TOO_SHORT`, `403 SUBGOALS_DISABLED` (system pref OFF),
  `403 PARENT_SUBGOALS_DISABLED` (this parent has `subgoalsAllowed: false`),
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
- `PATCH /api/goals/:id/policy` — body
  `{ divergencePolicy?, maxConcurrentChildren?, subgoalsAllowed?, maxNestingDepth? }`.
  The route accepts **any goal id** and persists the fields on that goal record.
  A body with no recognized field is rejected `400 NO_POLICY_FIELDS`.
  - `divergencePolicy` (`strict`/`balanced`/`autonomous`) is a **per-goal**
    setting consulted by that goal's own plan-mutation handler.
  - `maxConcurrentChildren` (validated `[1,8]`, floored to int) is stored
    per-goal but **enforced at the root** — the spawn scheduler resolves the
    *root's* value via `resolve-root-max-concurrent-children` for the per-root
    semaphore, so in practice operators set concurrency on the root
    (`goal_set_policy` is documented root-oriented for that field).
  - `subgoalsAllowed` (boolean) and `maxNestingDepth` (clamped via the SSOT
    `clampMaxDepth`, then capped to the **inherited** ceiling —
    `effectiveMaxNestingDepth(parent)` for a child, the system cap for a root)
    are the **per-goal sub-goal opt-in** fields driven by the goal dashboard's
    Sub-goal settings card. They let a human enable sub-goals on a goal created
    with the toggle off (the fix for the `PARENT_SUBGOALS_DISABLED` dead-end).
    The system pref remains the master gate — flipping `subgoalsAllowed: true`
    only has effect when `subgoalsEnabled` is also ON.

  **Per-body authz classification (S1).** The handler classifies the request by
  its fields: a body carrying any orchestration field
  (`divergencePolicy` / `maxConcurrentChildren`) is **orchestration-class**
  (team-lead-only, cookie does NOT bypass); a body carrying *exclusively* the
  opt-in fields (`subgoalsAllowed` / `maxNestingDepth`) is **operator-class**
  (verified human cookie accepted, else team-lead match). The stricter class
  wins so the cookie can never piggyback an orchestration change behind a
  sub-goal toggle. On success broadcasts `goal_state_changed` with the new
  values (including `subgoalsAllowed` / `maxNestingDepth` when set).
- `GET /api/goals/:id/descendants` — live + archived descendants for the Plan
  tab (independent of the sidebar's archived filter).
- `GET /api/goals/:id/tree-cost` — cost/token rollup rooted at the requested
  goal across its subtree (live + archived), surviving purge via `goalId`
  stamping on cost records.

### Children-mutation authorization (S1 — two classes)

The mutating Children REST endpoints are reachable by anything holding gateway
credentials, so they are guarded server-side by `authorizeChildrenMutation`
(`src/server/auth/children-mutation-authz.ts`). Because agents read the
**shared admin Bearer token** off disk and any holder can deliberately make an
eligible browser-shaped API request to obtain the signed `bobbit_session`
cookie, the cookie is only a **weak human signal**. The issuance classifier
prevents accidental minting by plain Bearer, session-bound, sandbox, and
internal callback traffic, but its browser headers are not proof of a human. To
shrink the blast radius the mutations are split into two classes:

- **`orchestration`** — `spawn-child`, plan `PATCH`, `integrate-child`, and
  `policy` bodies carrying `divergencePolicy` / `maxConcurrentChildren`. The
  autonomous team-lead verbs (spawn child teams, rewrite the plan, merge child
  branches, resize concurrency). The web UI never issues these. They are
  **team-lead-only**: require an `X-Bobbit-Spawning-Session` header matching the
  goal's authoritative team-lead, and the cookie does **NOT** bypass. Refused on
  absent header / teamless goal / mismatch (`403 NOT_TEAM_LEAD`).
- **`operator`** — `pause`, `resume`, mutation `decision`, `archive-child`, and
  `policy` bodies carrying **exclusively** the per-goal sub-goal opt-in fields
  (`subgoalsAllowed` / `maxNestingDepth`). The human-in-the-loop verbs the web
  UI actually drives. A verified `bobbit_session` cookie is accepted (human/UI),
  else the same team-lead match applies. A `policy` body that mixes in any
  orchestration field is classified as orchestration (the stricter class wins).

The header is never trusted as a bare claim — only compared for equality
against `TeamManager.getTeamState(goalId)?.teamLeadSessionId`.

**Residual risk (accepted; future work).** The `operator` endpoints still
indirectly trust the shared admin Bearer token: any token holder can synthesize
an eligible browser-shaped request, obtain the `bobbit_session` cookie, and
drive the operator verbs. This is an **inherent property of Bobbit's single
shared-credential model** — agents and the human share one gateway token, so
the cookie path cannot cryptographically distinguish a human operator from a
token-holding agent. **Full separation requires a dedicated operator
credential** (a distinct human-only secret that agents never possess), which is
out of scope for this port and tracked as future work. The
orchestration/operator split removes the cookie bypass from the high-impact
orchestration surface without claiming to fully isolate the operator surface.

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

## Governance: mutation classifier & divergence matrix (exact, from `plan-mutation.ts`)

`classifyMutation()` is a **pure** module (no I/O). It diffs the frozen
`execution.verify[]` subgoal steps (`current`) against `proposed`, keying by
`planId`. Field precedence: top-level `title`/`spec`/`dependsOn` win over
nested `subgoal.*` (one-shot `console.warn` on conflict). It computes
`{added, removed, modified, phaseChanges}` where a step is `modified` if any of
title/spec/workflowId/suggestedRole/phase/dependsOn changed.

**Structural severity** (`noop < fix-up < expansion < restructure`):
1. no add/remove/modify → `noop`.
2. any `removed` → `restructure`.
3. else any existing step's phase **decreased** → `restructure`.
4. else a new step at phase `> max(current.phase)` **or** an existing step's
   phase **increased** → `expansion`.
5. else (only adds/modifies at non-increasing phase) → `fix-up`.
6. **dependsOn override:** a changed dep set on an *existing* step bumps a
   `noop`/`fix-up` up to `restructure`.

**Criteria-coverage override (always wins):** build a haystack =
`normalise(rootSpec)` ∪ `normalise(proposed[i].spec)` joined by newline, where
`normalise = collapse-whitespace → trim → toLocaleLowerCase("en")`. For each
root acceptance criterion, if its normalised form is **not** a substring of the
haystack it is uncovered. Any uncovered criterion forces `kind =
"criteria-drop"` and populates `uncoveredCriteria[]`. This is why specs must
quote criteria **verbatim under a `## Covers` heading** — the match is a
whitespace-normalised, locale-pinned-`en`, case-insensitive substring test
(not a hash), so paraphrasing capitalisation/whitespace is tolerated but
dropping the text is not. Locale is pinned to `en` so a Turkish-locale `İ`
does not spuriously fail.

**Binding decision matrix** (applied in the `PATCH /plan` handler, per-goal
`divergencePolicy`, default `balanced`):

| kind | strict | balanced | autonomous |
|---|---|---|---|
| `criteria-drop` | `409 CRITERIA_DROP` | `409 CRITERIA_DROP` | `409 CRITERIA_DROP` |
| `restructure` (goal not paused) | `409 RESTRUCTURE_REQUIRES_PAUSE` | `409 RESTRUCTURE_REQUIRES_PAUSE` | `409 RESTRUCTURE_REQUIRES_PAUSE` |
| `restructure` (paused) | approval | approval | approval |
| `expansion` | approval | approval | approval |
| `fix-up` | approval | apply directly | apply directly |
| `noop` | apply (no-op) | apply (no-op) | apply (no-op) |

"approval" = persist a `PendingMutation` (`requestId`, 24h `DEFAULT_MUTATION_TTL_MS`,
restart-safe via `plan-mutation-store`), broadcast `mutation_pending`, respond
`{requiresApproval:true, requestId}`; resolved via
`POST /mutation/:requestId/decision`. Each applied mutation increments
`replanCount`; `replanCount > 5` auto-pauses the goal.

## Spawn idempotency & partial-failure boundary
`spawn-child` is idempotent on `planId`: before creating, the handler checks
for an existing child whose `spawnedFromPlanId === planId` and returns it
instead of creating a duplicate. `spawnedFromPlanId` is stamped **synchronously
immediately after `createGoal` with no intervening awaits**, so the
duplicate-prevention key is durable before any async work. If a crash occurs
between `createGoal` and stamping (the only unstamped window), the boot
`backfillCompleteState`/recovery pass reconciles; a retried spawn with the same
`planId` is matched by the idempotency check once stamped, preventing duplicate
children.

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
| "An operator can pause/resume a goal's entire subtree, and pause remains durable across gateway restart." | goal-paused-guard, TeamManager restored-lead boot-resume skip predicates | GoalPauseResumeRenderer | any-in-flight-child-excludes-paused, runSubgoalStep-paused-child-keeps-waiting |

## Edge cases and recovery

| Condition | Detection point | Response | Tests |
|---|---|---|---|
| Sibling dependency cycle / self-dep / unknown id | `depends-on-validation.ts` at spawn + plan PATCH | `400 DEPENDS_ON_CYCLE` / `SELF_DEPENDENCY {planId}` / `UNKNOWN_PLAN_ID {missing}` | goal-spawn-child-dependsOn, depends-on-validation |
| Child with unmet deps | spawn / integrate-child | created in the `blocked` scheduler state (deliberate #497-aligned state — distinct from operator `paused`; an operator resume must NOT clear dep-blocking), auto-resumes (`blocked`→`todo`) when its last dependency merges; spawn/plan responses surface `blocked: true` + `pendingDeps` | goal-spawn-child-dependsOn-blocking, runSubgoalStep-dependsOn-stamping |
| Merge conflict | `runSubgoalStep` merge | `git merge --abort`, step fails with manual-recovery directive, child preserved (not archived) | runSubgoalStep-merge-then-archive |
| Workflow-less `complete` child | `runSubgoalStep` recovery | degenerate-workflow recovery treats as ready-to-merge | runSubgoalStep-degenerate-workflow-less-recovery |
| Stale archived/child pointer | `runSubgoalStep` | stale-pointer invalidation, re-resolves | runSubgoalStep-stale-archived-invalidates |
| Retroactive system depth reduction | `effectiveMaxNestingDepth` (system is ceiling) | live trees retroactively capped; deeper spawns refused | subgoal-nesting-limit |
| `replanCount > 5` | plan PATCH | auto-pause the goal | plan-mutation, api-goals-plan-mutation |
| Pending mutation TTL / restart | `plan-mutation-store` | 24h TTL, restart-safe persistence | plan-mutation-store |
| Archived descendants in DAG vs live-only sidebar | `GET /descendants` (inclusive) vs `plan-live-only-toggle` | DAG includes archived (dimmed); sidebar filters | plan-archived-children |
| Restart with paused restored team | `TeamManager` restore/resubscribe | restores persisted active teams; boot-resume nudges skip paused restored leads; teamless existing goals are not started; `backfillCompleteState` | any-in-flight-child-excludes-paused, cost-backfill-on-boot |

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
- Browser E2E coverage for **every** user-facing surface via the ported
  suites, one per capability:
  - Proposal Allow-subgoals toggle + Max-depth control + Workflow/Roles tabs →
    `e2e/ui/subgoals-experimental-toggle`, `goal-proposal-form`.
  - Settings Subgoals toggle + `general-max-nesting-depth` stepper persistence
    across reload → `subgoals-experimental-toggle`.
  - Sidebar nesting, descendant badge, sibling disambiguation, dedupe →
    `e2e/ui/sidebar-spawned-children-dedupe`.
  - Plan tab DAG, archived distinction, live-only toggle, inline disclosure →
    `e2e/ui/plan-tab-archived-children`, `plan-archived-children`.
  - Children tab + tree-cost rollup → `e2e/ui/tree-cost-rollup`,
    `cost-backfill-on-boot`.
  - Children tool renderers + mutation-approval card →
    `e2e/ui/children-tool-renderers`.
  - Spawn refusal / nesting limit (API + UI) →
    `e2e/api-goals-spawn-child-route`, `api-subgoals-disabled`,
    `e2e/ui/subgoal-nesting-limit`.
  - Pause/resume cascade persistence → `e2e` pause-cascade suites.
  Any ported capability lacking a browser E2E in #497 gets a new one before the
  documentation gate (per AGENTS.md: nav, happy path, persistence across
  reload, cleanup).
