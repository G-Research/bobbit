# Subgoals branch — retro-audit design doc

**Status:** retro-audit. The implementation already exists as a single squashed commit (`d0000efe`) on the `goal/audit-subg-225e4d3d` branch, sourced from `origin/subgoals` (94 commits, 165 files changed, +21,503 / −335). This doc reverse-engineers the diff into a design treatise, maps it section-by-section against `~/Documents/dev/SUBGOALS-SPEC.md` (~748 lines), and explicitly calls out every observed deviation.

**Audience:** the reviewer / QA / spec-auditor agents that follow this gate. Use this doc as their entry point into the diff.

**Scope:** read-only commentary. No production code is touched.

---

## 1. Overview

`origin/subgoals` adds **nested goals** (a.k.a. DAG subgoals) to Bobbit. The shape follows SUBGOALS-SPEC §2 closely:

- **`PersistedGoal` gains optional parent/child fields** (`parentGoalId`, `rootGoalId`, `mergeTarget`, `divergencePolicy`, `maxConcurrentChildren`, `acceptanceCriteria`, `spawnedFromPlanId`, `paused`, `replanCount`, plus `spawnedBySessionId` for sidebar attribution). Goal records remain a single store; no new entity is introduced (Spec §0 Rule 1).
- **One new verify-step type, `subgoal`.** `runSubgoalStep()` in `verification-harness.ts` is the scheduler: spawn or resolve child by `(parentGoalId, planId)`, wait for child's `ready-to-merge`, merge child branch locally into parent, archive child. Concurrency-capped per `rootGoalId` via a single `Semaphore`.
- **A new `parent` meta-workflow** seeded by `seed-default-workflows.ts`: `charter → plan-review → goal-plan → execution → integration → ready-to-merge`. The `goal-plan` gate is the **freeze point** — once signaled, `execution.verify[]` is locked and further plan changes go through the mutation classifier.
- **Plan-mutation classifier** (`src/server/agent/plan-mutation.ts`) returns `noop | fix-up | expansion | restructure | criteria-drop` with the decision matrix from Spec §3.6 (criteria-drop always 409; fix-up auto-applies under `balanced`/`autonomous`; restructure requires `paused`; expansion always queued).
- **Nine `Children` tools** in `defaults/tools/children/` (spawn-child, plan-propose, plan-status, merge-child, pause, resume, archive-child, decide-mutation, set-policy) — team-lead-only via `toolPolicies` declared in every contributor role YAML (Lesson 4.17).
- **REST surface** added to `src/server/server.ts`: `POST /spawn-child`, `PATCH /plan`, `GET /plan`, `POST /integrate-child/:childId`, `POST /pause`, `POST /resume`, `POST /mutation/:requestId/decision`, `DELETE /goals/:id` cascade, plus `POST /team/teardown?cascade=…` and `GET /tree-cost`.
- **System-prompt nesting stanzas** in `system-prompt.ts::buildNestingContextSection` (Stanza A root / Stanza B child / Stanza C decision rule).
- **UI**: sidebar nesting (depth-5 cap, count-badge, dedupe + cycle-guard), Plan-tab DAG SVG (right-to-left edge routing through inter-phase X-band), Children tab, parent breadcrumb, cascade dialogs (archive / pause / resume / stop-team), mutation-approval card, tree-cost rollup row.
- **Restart-resilience hardening** consolidating Lessons 4.5–4.16 (orphan team-store drop, crash-loop guard, paused-child exclusion from in-flight check, `waitForStreaming` race fix, `kind:"reviewer"` resubscribe skip, dead-bridge auto-revive, zombie auto-archive, context-rich reminder, restart-interrupt → `pending` not `failed`).
- **Documentation**: `docs/nested-goals.md` (~640 lines), AGENTS.md recipes + debugging keyword index entries, extensions to `docs/goals-workflows-tasks.md` and `docs/internals.md`.

Net new test count is **>50 new test files** under `tests/`, including 8 dedicated `runSubgoalStep-*.test.ts` cases and 8 browser/API E2E suites.

---

## 2. Diff inventory by area

### 2.1 Data model & persistence

| File | Notes |
|---|---|
| `src/server/agent/goal-store.ts` | Adds 9 optional `PersistedGoal` fields (+`spawnedBySessionId`). Lazy-migrates on `load()`; `save()` round-trips via `serializeGoals`. |
| `src/server/agent/goal-manager.ts` | `createGoal` accepts `parentGoalId`, derives `rootGoalId` (= `id` for root, `parent.rootGoalId ?? parent.id` for child) and `mergeTarget`; cycle-prevention walk capped at `NESTING_WALK_DEPTH_CAP = 64`. New methods `mergeChild`, `archiveGoalAfterMerge`, `resolveRootMaxConcurrentChildren`, `backfillSpawnedBySessionId`. |
| `src/server/agent/parent-workflow-freeze.ts` | Pure helper `computePlanFreezeUpdate(goal, gateId)` — returns `{freeze:true}` when `goal.workflowId === "parent"` and the signaled gate is `goal-plan`. |
| `src/server/agent/plan-mutation.ts` | Pure classifier `classifyMutation({prevSteps, proposedSteps, rootSpec, criteria})`. |
| `src/server/agent/plan-mutation-store.ts` | Persists pending mutation requests to `<stateDir>/plan-mutations/<goalId>.json` with 24 h TTL. |
| `src/server/state-migration/seed-default-workflows.ts` | Seeds the `parent` meta-workflow alongside `general` / `feature` / `bug-fix`. |
| `src/shared/parse-acceptance-criteria.ts` | Pure markdown parser for `## Acceptance criteria`. |

### 2.2 Verification harness & subgoal step type

| File | Notes |
|---|---|
| `src/server/agent/verification-harness.ts` | +716 lines net. New: `runSubgoalStep`, `resolvePlanStepChild` (5-tier resolver), `_acquireRootSubgoalSemaphore`, `_waitForChildReadyToMerge`, `buildContextRichReminder`, restart-interrupt suppression in `_resumeOneVerification`, `RESTART_INTERRUPT_MARKERS`. |
| `src/server/agent/verification-logic.ts` | `TRANSIENT_ERROR_PATTERNS` extended for restart-resume context-loss; `{{rootGoalBranch}}` template var. |
| `src/server/agent/verification-reviewer-meta.ts` | `buildVerificationReviewerMeta()` — single source for the reviewer/QA `updateSessionMeta` payload (omits `teamLeadSessionId` when unavailable). |
| `src/server/agent/notify-team-lead-failure.ts` | Failure-detail nudge: failed step names, truncated output, merge-gap diagnostic. |
| `src/server/agent/notify-team-lead-child-passed.ts` | Notifies parent's team-lead when a child's `ready-to-merge` passes. |
| `src/server/agent/workflow-store.ts` | `VerifyStep` extended with `type:"subgoal"` + `subgoal: {planId,title,spec,workflowId?,suggestedRole?}`. `stripSubgoalStepsForChildInheritance` for child workflow inheritance. `normalizeWorkflow` lazy-migration. |

### 2.3 The 9 `Children` tools + REST surface

`defaults/tools/children/` — one YAML per tool plus `extension.ts` (317 LoC) that proxies to REST:

`goal_spawn_child`, `goal_plan_propose`, `goal_plan_status`, `goal_merge_child`, `goal_pause`, `goal_resume`, `goal_archive_child`, `goal_decide_mutation`, `goal_set_policy`.

REST handlers in `src/server/server.ts` (`+1040` lines net):
- `POST /api/goals/:id/spawn-child` (idempotent on `planId`)
- `PATCH /api/goals/:id/plan` — classifier-driven; returns 400 `NO_EXECUTION_GATE`, 409 `CRITERIA_DROP`, 409 `RESTRUCTURE_REQUIRES_PAUSE`, or `{kind, applied|queued, requestId?}`
- `GET /api/goals/:id/plan` — narrow projection for plan tab
- `POST /api/goals/:id/integrate-child/:childId` — local merge + auto-archive
- `POST /api/goals/:id/pause` / `/resume` — cascade required (422 `CASCADE_REQUIRED` when omitted)
- `POST /api/goals/:id/mutation/:requestId/decision`
- `DELETE /api/goals/:id` cascade
- `POST /api/goals/:id/team/teardown?cascade=true|false` (409 `HAS_DESCENDANT_TEAMS` without cascade)
- `GET /api/goals/:goalId/tree-cost` — BFS rollup

### 2.4 Roles & system-prompt nesting stanzas

| File | Notes |
|---|---|
| `defaults/tool-group-policies.yaml` | Adds team-lead-only allowance for the `Children` group. |
| `defaults/roles/*.yaml` (10 files) | Every contributor declares `gate_signal: never` + `goal_*: never` for the nine Children tools. `team-lead.yaml` is the only `always-allow` for that set, and gains the "Goal nesting awareness" backstop paragraph. |
| `src/server/agent/system-prompt.ts` | `buildNestingContextSection({team, goalBranch, parent?, root?})` emits Stanza A (TOP-LEVEL ROOT — "raise the PR"), Stanza B (CHILD GOAL — "your branch merges INTO parent's branch LOCALLY. **DO NOT raise a PR.**"), Stanza C (decision rule: `task_create` vs `team_spawn` vs `subgoal`). |
| `src/server/agent/resolve-role.ts` | Pure `resolveRole(goal, name, roleStore)` cascading inline → project/server/builtin; `listAvailableRoles()` for fail-loud errors. |

### 2.5 UI: plan-tab DAG, sidebar nesting, dialogs

| File | Notes |
|---|---|
| `src/app/sidebar-nesting.ts` | `buildNestedGoalForest` — depth-5 cap, descendant aggregation, "Show N more child goals…" overflow, cycle-guard, dedupe, stable sort, title-collision suffix. |
| `src/app/sidebar-spawned-children.ts` | Live-render of children grouped under their spawning team-lead session. |
| `src/app/sidebar.ts` | Wires forest + spawned-children renderers; archived forest filters live-attached goals; collapse hides nested children. |
| `src/app/plan-synthesis.ts` | `buildPlanSteps` — formal-plan + ad-hoc orphan append OR `createdAt`-clustered living plan. |
| `src/app/plan-node-state.ts` | `resolvePlanNodeChild` — tier-based; **must agree with server's `resolvePlanStepChild`**. |
| `src/app/plan-edge-paths.ts` | 3-segment right→left edge routing through inter-phase X-band. |
| `src/app/goal-dashboard-tab-visibility.ts` | `shouldShowPlanTab` / `shouldShowChildrenTab` / `shouldShowTasksTab`. |
| `src/app/goal-dashboard.ts` | Plan tab DAG, Children tab cards, parent breadcrumb, tree-cost row, mutation-approval card. +642 LoC net. |
| `src/app/dialogs.ts` | `showArchiveGoalDialog`, `showPauseGoalDialog`, `showResumeGoalDialog`, `showStopTeamDialog`. +471 LoC. |
| `src/app/render.ts` | Wiring: splash project gating, goal-proposal panel inline workflow + roles consistency, archived footer model state. +589 LoC. |
| `src/app/render-helpers.ts` | `renderTeamGroup` archived-fallback fold for unmapped legacy reviewer/QA sessions. |
| `src/app/state.ts`, `src/app/api.ts`, `src/app/custom-messages.ts`, `src/app/message-reducer.ts` | Reducer actions `mutation-pending` / `mutation-update`; client-side `teardownTeamWithDialog` cascade-dialog wrapper; `goal_state_changed` / `goal_child_spawned` event handlers. |

### 2.6 Restart resilience plumbing

| File | Notes |
|---|---|
| `src/server/harness.ts` | Crash-loop guard (`HEALTHY_UPTIME_MS=10_000`, `CRASH_LOOP_THRESHOLD=5`). |
| `src/server/agent/team-manager.ts` (+ `team-store.ts`) | `kind:"worker"|"reviewer"` field; `restoreTeams` orphan drop; zombie-sweep error guard; boot-respawn for sessionless in-progress goals; `notifyTeamLead` reviewer fallback. |
| `src/server/agent/team-manager-helpers.ts` | `anyInFlightChild` excludes `paused === true`. |
| `src/server/agent/session-manager.ts` | `waitForStreaming(sessionId, timeoutMs)`; `restartAgent` zombie auto-archive; dead-bridge revive on prompt dispatch. |

### 2.7 Tests

Spread across `tests/`. By group (selecting):

- **Goal-store / nesting fields**: `goal-store-nesting`, `goal-manager-nesting`, `goal-manager-create-child-uses-parent-branch`, `goal-manager-archive-after-merge`, `goal-manager-merge-child`, `goal-manager-backfill-*`, `inline-workflow-normalization`, `child-workflow-inheritance`, `parent-workflow-shape`.
- **Subgoal verify-step**: `runSubgoalStep-{cancellation, concurrency-semaphore, degenerate-workflow-less-recovery, inline-roles-inheritance, merge-then-archive, paused-child-keeps-waiting, spawn-stamps-planId, stale-archived-invalidates, tier-resolution}` (9 files).
- **Plan mutation**: `plan-mutation`, `plan-mutation-store`, `mutation-approval-card`.
- **REST surface**: `api-goals-{cascade-archive, integrate-child, pause-resume, plan-mutation, spawn-child, tree-cost}`, `api-team-teardown-cascade`, `api-teardown-team-with-dialog`, `e2e/api-goals-spawn-child-route`, `e2e/api-goals-propose-inline`, `e2e/goal-creation-auto-seed`.
- **UI helpers / rendering**: `plan-edge-paths`, `plan-node-state`, `plan-synthesis`, `sidebar-nesting`, `sidebar-spawned-children`, `cascade-dialog`, `goal-dashboard-tab-visibility`.
- **Restart resilience** (Lessons 4.5–4.16): `harness-crash-loop-guard`, `team-manager-{boot-respawn-sessionless, orphan-team-store, zombie-sweep-error-guard}`, `restart-{agent-archives-zombies, interrupt-suppression}`, `dispatch-prompt-revive-dead-bridge`, `wait-for-streaming`, `transient-error-restart-context-loss`, `gate-signal-freezes-execution-verify`, `notify-team-lead-{child-passed, failure-detail}`, `verification-reviewer-meta`, `team-agent-kind-field`, `build-context-rich-reminder`, `any-in-flight-child-excludes-paused`.
- **E2E browser**: `e2e/ui/{cascade-archive, cascade-pause, parent-breadcrumb, plan-tab, sidebar-nesting, tree-cost-rollup}.spec.ts`.
- **Misc**: `parse-acceptance-criteria`, `resolve-role`, `resolve-root-max-concurrent-children`, `role-children-tools-policy`, `tree-cost-rollup`, `system-prompt-nesting-stanzas`, `git-merge-child-branch-local`, `proposal-types-goal-inline`, `sandbox-create-child-worktree`.

### 2.8 Documentation

| File | Notes |
|---|---|
| `docs/nested-goals.md` (NEW, +643) | User-facing reference (mirrors Spec §2 + §3). |
| `AGENTS.md` (+16) | Recipe entries + Lesson 4.x debugging index entries. |
| `docs/goals-workflows-tasks.md` (+74) | Adds `subgoal` step type, nested-goals data-model section. |
| `docs/internals.md` (+14) | Cross-references for nesting + cost rollup. |
| `docs/debugging.md` (+54) | Per-lesson keyword entries. |
| `docs/rest-api.md` (+2) | Pointer to nested endpoints. |

---

## 3. Mapping to `SUBGOALS-SPEC.md`

| Spec section | Implementation |
|---|---|
| §0 Rule 1 (no new entity) | Honored. No `Mission`/`Plan`/`Phase` store; only `PersistedGoal` extensions in `goal-store.ts`. |
| §0 Rule 2 (harness IS the scheduler) | Honored. `runSubgoalStep` in `verification-harness.ts`; no `mission-scheduler.ts` or background poller. |
| §0 Rule 3 (one workflow snapshot, frozen) | Mostly honored. Snapshot lives on `goal.workflow`; freeze flag on `gate.metadata.frozen` via `computePlanFreezeUpdate` (parent-workflow-freeze.ts). See deviation §4.1. |
| §1 Reference docs | Reflected in `docs/nested-goals.md` cross-references. |
| §2 Architectural primitives — `PersistedGoal` extensions | All 9 fields present in `goal-store.ts` (62-99). Plus `spawnedBySessionId` (additive). |
| §2 Architectural primitives — `subgoal` verify-step type | `workflow-store.ts` `VerifyStep` union extended; `runSubgoalStep` is the dispatcher handler. |
| §3.1 Single-project per goal-tree | `goal_spawn_child` REST handler enforces `child.projectId = parent.projectId`. `goal-manager.createGoal` accepts `projectId`. |
| §3.2 Branching topology — child off parent HEAD | `goal-manager.createGoal` defaults `baseBranch = parent.branch` for child goals (test: `goal-manager-create-child-uses-parent-branch`). |
| §3.2 — local merge into parent, no PR from child | `git.ts::mergeChildBranchLocal`; system-prompt Stanza B forbids PR; `ready-to-merge` of root only opens PR. |
| §3.3 Worktrees per child | Spawn flow routes through pool (`setupWorktreeAndStartTeam`). Confirmed in `sandbox-create-child-worktree.test.ts`. |
| §3.4 Sandbox (reject for v1) | **Deviation §4.5** — does NOT reject; child inherits `parent.sandboxed`. |
| §3.5 Concurrency cap | `_acquireRootSubgoalSemaphore` keyed by `rootGoalId`; default 3, hard max 8 per `goalManager.resolveRootMaxConcurrentChildren`. |
| §3.6 Mutation classification + decision matrix | `plan-mutation.ts::classifyMutation` returns the four kinds; `criteria-drop` overrides everything; classification matrix enforced in `PATCH /api/goals/:id/plan` handler. `replanCount > 5 ⇒ auto-pause`. |
| §4 Lessons (4.1 – 4.22) | See coverage table below. |
| §6 Reuse table | All rows honored. No new top-level store/manager/route/scheduler/sidebar-section. |
| §8 Acceptance criteria 1–17 | See coverage in §5 (risk areas) for incomplete items. |

### Lesson coverage map

| Lesson | Implementation site | Test |
|---|---|---|
| 4.1 stamp `spawnedFromPlanId` immediately | `verification-harness.ts:3097`; `server.ts` spawn-child handler | `runSubgoalStep-spawn-stamps-planId.test.ts` |
| 4.2 invalidate stale archived `childGoalId` | `resolvePlanStepChild` tier predicate | `runSubgoalStep-stale-archived-invalidates.test.ts` |
| 4.3 `WorkflowStore` wired into `GoalManager` | `project-context.ts`; `goal-manager.ts::createGoal` fail-loud branch | `goal-manager-workflow-store-required.test.ts` |
| 4.4 degenerate workflow-less complete recovery | `runSubgoalStep` recovery branch | `runSubgoalStep-degenerate-workflow-less-recovery.test.ts` |
| 4.5 `process.execPath` not bare `"node"` | **Deviation §4.2** — NOT applied. | n/a |
| 4.6 restart-interrupt → gate `pending` | `_resumeOneVerification` predicate + `RESTART_INTERRUPT_MARKERS` | `restart-interrupt-suppression.test.ts` |
| 4.7 transient reviewer-rerun pattern | `verification-logic.ts::TRANSIENT_ERROR_PATTERNS` | `transient-error-restart-context-loss.test.ts` |
| 4.8 context-rich reminder | `buildContextRichReminder` | `build-context-rich-reminder.test.ts` |
| 4.9 dead-bridge revive on dispatch | `session-manager.ts::_dispatchPromptWithReviveOnDeadBridge` | `dispatch-prompt-revive-dead-bridge.test.ts` |
| 4.10 `restartAgent` zombie auto-archive | `session-manager.ts::restartAgent` | `restart-agent-archives-zombies.test.ts` |
| 4.11 boot crash-loop + orphan + zombie-guard | `harness.ts`, `team-manager.ts::restoreTeams`, `resubscribeTeamEvents` | `harness-crash-loop-guard`, `team-manager-orphan-team-store`, `team-manager-zombie-sweep-error-guard` |
| 4.12 boot-respawn sessionless goals | `team-manager.ts::resubscribeTeamEvents` tail | `team-manager-boot-respawn-sessionless.test.ts` |
| 4.13 paused-child excluded from in-flight | `team-manager-helpers.ts::anyInFlightChild` | `any-in-flight-child-excludes-paused.test.ts` |
| 4.14 idle ≠ stuck | AGENTS.md prose only (no code site). |
| 4.15 `waitForStreaming` race fix | `session-manager.ts::waitForStreaming` (lines 818, 2047, 2365 in harness) | `wait-for-streaming.test.ts` |
| 4.16 `kind:"reviewer"` resubscribe skip | `team-manager.ts:74,337,1114,1351` | `team-agent-kind-field.test.ts` |
| 4.17 `gate_signal` team-lead-only | role YAMLs + `defaults/tool-group-policies.yaml` | `role-children-tools-policy.test.ts` |
| 4.18 actionable failure notifications | `notify-team-lead-failure.ts` | `notify-team-lead-failure-detail.test.ts` |
| 4.19 tier-based plan-step preference | `verification-harness.ts::resolvePlanStepChild`; mirror in `plan-node-state.ts` | `runSubgoalStep-tier-resolution.test.ts`, `plan-node-state.test.ts` |
| 4.20 living plan synthesis | `plan-synthesis.ts::buildPlanSteps` | `plan-synthesis.test.ts` |
| 4.21 cost rollup | `cost-tracker.ts::computeTreeCost`; `GET /api/goals/:goalId/tree-cost` | `tree-cost-rollup.test.ts`, `api-goals-tree-cost.test.ts` |
| 4.22 plan-tab nested rendering | `goal-dashboard.ts` + `plan-edge-paths.ts` | `plan-edge-paths.test.ts`, `e2e/ui/plan-tab.spec.ts` |

---

## 4. Deviations from spec

This is the most important section. Each item identifies a place where the implementation diverges from `SUBGOALS-SPEC.md`. Spec is reference-only; code-as-built may override when better, but every divergence is logged.

### 4.1 — `goal.workflow` is mutated post-creation by the freeze flag

**Verdict:** `Justified` (with caveat).

**Spec §0 Rule 3:** *"Resist any urge to mutate `goal.workflow` after creation. The snapshot is the contract; everything else is a tool that reads it."*

**What the code does:** `parent-workflow-freeze.ts::computePlanFreezeUpdate` returns a `{freeze:true}` directive when the `goal-plan` gate is signaled on a `parent`-workflow goal. The server then mutates the goal's snapshot — specifically `goal.workflow.gates[execution].metadata.frozen = true` (the spec itself anticipates this via the phrasing *"set `gate.metadata.frozen = true` on the per-goal workflow snapshot"* in §3 Phase 3). The plan replacement on subsequent successful classifier runs (`server.ts:3377` "Apply a (validated) plan replacement to a parent-workflow goal") also rewrites `execution.verify[]`.

**Caveat:** the spec is internally inconsistent — Rule 3 prohibits post-creation mutation, but §3.6 / Phase 3 explicitly require freeze and mutation-classified rewrites. The implementation follows the §3.6 contract, which is the operationally correct one. Keep, but `Needs review` for whether the spec text in §0 should be softened to "*do not mutate `goal.workflow` outside the freeze + classifier paths*".

### 4.2 — `spawn(process.execPath)` is NOT used (Lesson 4.5 unfixed)

**Verdict:** `Needs review` (likely `Bug` for sandboxed dev runs under sanitised PATH).

**Spec §Lesson 4.5:** *"Every site in `src/server/` that spawns node uses `process.execPath` (absolute path to the running node binary), not bare `"node"`. Three sites today: `rpc-bridge.ts::_spawnProcess`, `harness.ts::launchServer`, `watchdog.ts::launchHarness`. Add a unit-test guard: `rg 'spawn\("node"' src/server/` must return zero hits."*

**What the code does:** All three sites still use bare `"node"`:

```text
src/server/agent/rpc-bridge.ts:262:    this.process = spawn("node", [cliPath, ...args], { ... });
src/server/harness.ts:112:              child = spawn("node", [CLI_PATH, ...forwardedArgs], { ... });
src/server/watchdog.ts:174:             harnessChild = spawn("node", [HARNESS_PATH, ...forwardedArgs], { ... });
```

No unit-test guard exists (`tests/spawn-node-execpath-invariant.test.ts` not present).

**Justification:** none. The spec calls this out as a Lesson because production deployments under `npm run dev:harness` have sanitised PATH. The risk is *"every gateway restart triggers a flood of `spawn node ENOENT` errors"* — exactly the symptom the spec called out. **Recommended remediation:** three one-line edits + a guard test. Low risk, high value.

### 4.3 — Idle-vs-stuck encoding (Lesson 4.14) lives only in `AGENTS.md` prose

**Verdict:** `Justified` (operational lesson, not a code path).

**Spec §Lesson 4.14:** asks for the anti-pattern to be encoded "in AGENTS.md".

**What the code does:** AGENTS.md "Reference docs" / "Run tests before committing." region carries the Lesson 4.x debugging keyword index, including the idle≠stuck guidance via cross-reference to `docs/debugging.md`. No production code site is needed. Keep.

### 4.4 — `divergencePolicy` storage but no dispatch path in `PATCH /plan`

**Verdict:** `Needs review`.

**Spec §3.6 decision matrix** — `strict | balanced | autonomous` policy must drive `fix-up` (auto-approve under balanced/autonomous; prompt under strict) and `restructure` (paused-required under strict; prompt under balanced/autonomous).

**What the code does:** `PersistedGoal.divergencePolicy` exists as an optional field (`goal-store.ts:68`). `plan-mutation.ts` is purely structural — it returns the kind, but the policy lookup happens server-side in `PATCH /api/goals/:id/plan`. Spot-check shows the handler resolves the policy and applies the matrix correctly, but `divergencePolicy` is never settable via UI (`goal_set_policy` tool exists but no dashboard surface) and there's no test asserting the matrix end-to-end at the REST layer (`api-goals-plan-mutation.test.ts` covers the kinds but not the per-policy routing).

**Justification:** code matches spec for storage + classification + autonomous default. The gap is **policy authoring UX**, which the spec doesn't strictly require. Remediation suggestion: add an end-to-end test with `divergencePolicy:"strict"` exercising fix-up→queued vs balanced→applied.

### 4.5 — Sandbox rejection for nested goals (Spec §3.4) is NOT enforced

**Verdict:** `Needs review` / arguably `Bug`.

**Spec §3.4:** *"Reject child creation under sandbox with `400 { error: 'sandboxed nested goals require sandbox bump', message: 'see docs/nested-goals.md §sandbox' }` until the sandbox manager supports parent-branch worktrees."*

**What the code does:** Children inherit `sandboxed: parent.sandboxed` (e.g. `verification-harness.ts:3092`). No 400 rejection in either `goal_spawn_child` REST handler or `runSubgoalStep`. The test `sandbox-create-child-worktree.test.ts` exists but exercises the worktree path rather than asserting rejection.

**Justification:** the spec frames this as "do not block v1 ship on the sandbox bump" — implying rejection was a temporary guard. Code-as-built has elected to **try** rather than reject. This is `Needs review` because:
- If the project is not sandboxed (`sandboxed === false`), this is a no-op — no risk.
- If the project IS sandboxed, child worktrees may be created off the project's primary branch (losing parent commits, per §3.4). User-visible symptom: child branch missing parent's pre-spawn work.
- There's no v1-style 400 to surface the limitation to a user who tries this combination.

Remediation suggestion: emit a structured error or a goal-state warning when `parent.sandboxed === true` and `parentGoalId` is set, until the sandbox bump arrives.

### 4.6 — Workflow inheritance fallback chain expanded beyond spec

**Verdict:** `Justified` (defensive; documented in Lesson 4.20-adjacent logic).

**Spec §3 Phase 3** describes child workflow resolution as `sg.workflowId → "feature"`.

**What the code does:** The harness's `runSubgoalStep` (verification-harness.ts:3038–3083) cascades through **four** tiers:

1. `sg.workflowId` if registered in store
2. parent's snapshot (stripped of subgoal verify-steps via `stripSubgoalStepsForChildInheritance`)
3. `"feature"` from store
4. first non-hidden workflow in store

Tier 2 is the implementation's most material deviation: a `parent`-workflow root spawning a child without an explicit `workflowId` will inherit the **stripped parent meta-workflow**, not `feature`. `child-workflow-inheritance.test.ts` covers this.

**Justification:** Tier 2 is an operational improvement — parent goals defining a custom inline workflow expect children to inherit it. Without this, every plan step would have to specify `workflowId`. Tier 4 is a hard fallback to keep the harness from creating workflow-less goals (Lesson 4.3 proper). Keep.

### 4.7 — Tier 1.5 (cached `childGoalId`) added to `resolvePlanStepChild`

**Verdict:** `Justified`.

**Spec §Lesson 4.19** describes a 4-tier success-aware preference (live in-progress → archived complete → live other → archived non-complete). The implementation in `verification-harness.ts:2820–2906` adds a **Tier 1.5** (cached `subgoal.childGoalId` lookup, with sanity-check) AND a **Tier 5** (rescue by `parentGoalId+title` for goals with `spawnedFromPlanId === undefined`, lazily backfilling on hit).

**Justification:** Tier 1.5 is a fast-path consistency win. Tier 5 is the explicit "defensive layer" the Lesson 4.1 prose itself prescribes. Both are additive, neither alters the published tier semantics. Keep.

### 4.8 — `goal_set_policy` tool exists but no dashboard UI

**Verdict:** `Needs review` (gap, not bug).

**Spec §3.6** anticipates `divergencePolicy` configuration at goal level. The tool YAML `defaults/tools/children/goal_set_policy.yaml` lets the team-lead programmatically set it. No UI surface in `goal-dashboard.ts` exposes a slider or radio for the policy.

**Justification:** spec doesn't strictly require a UI. Tool-level access is sufficient for v1. Document the tool flow in `docs/nested-goals.md` if not already.

### 4.9 — `spawnedBySessionId` field is additive (not in spec)

**Verdict:** `Justified` (additive).

**What the spec said:** the spec's `PersistedGoal` extension list (§2) does not include `spawnedBySessionId`.

**What the code does:** `goal-store.ts:99` stores the session ID of the team-lead that triggered `goal_spawn_child` for sidebar attribution. Backfill via `goal-manager-backfill-spawned-by-session.test.ts`.

**Justification:** orthogonal to scheduling; pure UI-attribution feature ("Sub-goals nest under their spawning team-lead session" — commit `00d6805f`). Keep, but ensure documented in `docs/goals-workflows-tasks.md` data-model section.

### 4.10 — `notify-team-lead-child-passed` is additive (not in spec)

**Verdict:** `Justified` (additive; closes Lesson 4.18-class gap).

**Spec:** Lesson 4.18 mandates failure notifications. Says nothing about success notifications.

**What the code does:** `notify-team-lead-child-passed.ts` posts a structured nudge to the parent's team-lead when a child's `ready-to-merge` passes. Sibling to the failure-detail nudge. Tests: `notify-team-lead-child-passed.test.ts`, plus the "child rtm-failed, child auto-paused" pair (commit `cee886da`).

**Justification:** symmetry with failure notification; addresses the live-test pain point that team-leads went idle without knowing children had completed. Keep.

### 4.11 — Plan-tab edge routing uses **right→left** not the bipartite shared-mid-line in §Phase 5

**Verdict:** `Justified` (UX refinement after Lesson 4.22 + plan-edge-paths visual debug).

**Spec §Phase 5** asks for "bipartite source×destination edge connectors with shared mid-line". Implementation in `plan-edge-paths.ts::computeEdgePaths` uses **3-segment right→left routing through the inter-phase X-band** (commit `42dbfbf3`). The change was driven by node-crossing artefacts in the original layout.

**Justification:** functionally equivalent (still bipartite per phase column), with better visual clarity. AGENTS.md recipe entry already documents the new contract. Keep.

### 4.12 — Mutation-classifier criteria-coverage is *substring* not *substring of step.spec OR rootSpec*

**Verdict:** `Justified` (matches spec).

**Spec §3.6:** *"the criteria-coverage check is whitespace-normalised, case-insensitive substring match … walks the union of {root spec, remaining subgoal step specs}"*.

**What the code does:** `plan-mutation.ts::classifyMutation` matches against `{rootSpec, ...proposedSteps.map(s => s.spec)}`. Whitespace-normalised, case-insensitive. Confirmed in `plan-mutation.test.ts`.

Keep — exact spec match.

### 4.13 — `replanCount > 5 ⇒ auto-pause` threshold

**Verdict:** `Justified` (matches spec).

**Spec §3.6:** *"At `> 5`, auto-pause for human review."*

Implementation: AGENTS.md recipe entry confirms `> 5 ⇒ auto-pause`; `plan-mutation.test.ts` covers the threshold. Keep.

### 4.14 — Inline-roles + inline-workflow inheritance to children (additive but spec-aligned)

**Verdict:** `Justified` (additive).

**Spec §6 reuse table:** parent's `inlineRoles` should be deep-cloned onto subgoals. The implementation goes one step further: `goal_spawn_child` AND `runSubgoalStep` *both* deep-clone `parent.inlineRoles` AND inherit `parent.workflow` snapshot. AGENTS.md recipe entry documents this in detail.

Keep — strengthens spec invariant.

### 4.15 — Subgoal-step verify-step does not appear in `seed-default-workflows.ts` user docs/comment

**Verdict:** `Needs review` (cosmetic).

`seed-default-workflows.ts` defines `SeededVerifyStep.type` as `"command" | "llm-review" | "agent-qa" | "subgoal"` (line 19) — the spec asked for this. However the comment block above the `parent` workflow (line 209) says "the team-lead populates it via `propose_*`" but doesn't mention the `subgoal` step type explicitly. Cosmetic. Keep but consider amending the comment in a follow-up.

### 4.16 — Cascade-required contract (422 `CASCADE_REQUIRED`) is additive

**Verdict:** `Justified` (additive UX guarantee).

**Spec:** says nothing about cascade as an explicit contract — pause/resume/archive simply "cascade".

**What the code does:** every cascade-affecting REST call (`pause`, `resume`, `archive`, `team/teardown`) requires explicit `cascade: boolean`; server returns 422 `CASCADE_REQUIRED` when omitted. UI is the cascade-policy authority, with confirmation dialogs.

**Justification:** safer than implicit cascade. Encoded in AGENTS.md recipes + tests. Keep.

### 4.17 — `acceptanceCriteria` is *parsed and stored* but spec-coverage uses raw `goal.spec`, not the parsed array

**Verdict:** `Needs review`.

**Spec §3.6:** criteria-coverage walks "the union of {root spec, remaining subgoal step specs}" — implies the **rootSpec string**, not the parsed array.

**What the code does:** `goal-store.ts:72` exposes `acceptanceCriteria?: string[]`. `plan-mutation.ts::classifyMutation` accepts `criteria: string[]` (the parsed list). The PATCH-plan handler passes `goal.acceptanceCriteria ?? parseAcceptanceCriteria(goal.spec)`.

**Justification:** Parsed list is correct: the substring-match runs each criterion (one element of the array) against the union of step specs. Matches the spec semantics. Keep, but documentation should make clear that `goal.acceptanceCriteria` is the source of truth post-parse, and that paraphrased criteria in subgoal specs WILL fail (Spec §3.6 admonition).

### 4.18 — Sidebar depth cap is **5**; plan-tab cap is **3**

**Verdict:** `Justified` (matches spec).

Spec §Lesson 4.22 mandates depth-3 for plan tab, depth-5 for sidebar. Both honored (`sidebar-nesting.ts`, `goal-dashboard.ts`). Keep.

---

## 5. Risk areas for review/QA

The 8–10 highest-risk surfaces in this diff. Reviewers and QA should focus here first.

### 5.1 `runSubgoalStep` resolution + idempotency under restart

The 5-tier resolver + Tier 5 rescue + Tier 1.5 cached pointer + sanity-check is the heart of the feature. Any subtle ordering change here re-introduces Lesson 4.1 / 4.2 dupes. Specifically:

- The `await goalManager.updateGoal(child.id, { spawnedFromPlanId: planId })` MUST be the very next line after `createGoal` (verification-harness.ts:3097). Any code drift between them re-opens 4.1.
- The "archived but not complete" invalidation predicate (4.2) MUST clear `active.steps[stepIndex].subgoal.childGoalId` — otherwise stale pointers loop forever.

QA: kill the gateway 5× during a `parent`-workflow execution gate run with 2+ children spawning. Verify zero dupes in `goals.json`. Verify archived dupes do not re-resolve.

### 5.2 Plan-mutation classifier + criteria-coverage substring matching

`classifyMutation` is the gate that protects acceptance criteria. The spec is explicit: paraphrased criteria fail, hashes fail. This is **load-bearing for spec compliance** — if a team-lead can drop a criterion under the classifier's nose, the whole guarantee evaporates.

QA: PATCH `/plan` with proposedSteps that paraphrase a root acceptance criterion; expect 409 `CRITERIA_DROP`. Repeat with the criterion verbatim in a step's spec; expect `applied`/`queued`. Probe edge cases: leading/trailing whitespace, unicode normalisation, capitalisation.

### 5.3 Sandbox / parent-branch interaction (Spec §3.4 deviation)

Per §4.5 above, sandbox rejection is not implemented. **If the project is sandboxed**, exercise child spawning end-to-end and verify whether the child's worktree actually picks up parent commits. If not, surface the limitation (or implement the rejection).

QA priority: HIGH for any sandboxed test environment.

### 5.4 Bare `spawn("node")` (Spec §Lesson 4.5 deviation)

Per §4.2 above. Any deploy under sanitised PATH (`npm run dev:harness`) will fail to restart agents. Reviewers: pull this into a 1-LoC fix-up commit.

### 5.5 Cascade-archive race conditions

`DELETE /api/goals/:id?recursive=1` walks descendants; `team/teardown?cascade=true` does similarly. Concurrent merges in flight (e.g. child `ready-to-merge` passing while parent archive is in progress) could leave inconsistent state. Tests `api-goals-cascade-archive.test.ts` + `api-team-teardown-cascade.test.ts` cover the happy path; QA should check:

- Cascade-archive while a child's `runSubgoalStep` is mid-merge.
- Cascade-pause while a grandchild is just spawning (Tier 1.5 cache write race).

### 5.6 Plan-tab DAG live updates + tier resolver agreement

`plan-node-state.ts` (client) MUST agree with `verification-harness.ts::resolvePlanStepChild` (server). Any tier-ordering drift causes the Plan tab to show a different child than the harness is actually waiting on. Symptom: Plan tab green, harness red, or vice versa.

QA: spawn a parent goal, archive a child mid-flight, verify Plan tab and dashboard show consistent state.

### 5.7 Restart resilience cluster (Lessons 4.6–4.16)

Even with the test coverage, the restart paths interact in subtle ways:

- `_resumeOneVerification` deciding `pending` vs `failed` (4.6)
- `restoreTeams` orphan drop (4.11)
- boot-respawn for sessionless in-progress goals (4.12)
- `kind:"reviewer"` skip on resubscribe (4.16)

QA: kill gateway during a 4-leaf parent execution. Verify after restart: gates not falsely failed, sessionless leaves get fresh team-leads, no spurious "Agent finished" nudges from reviewers.

### 5.8 Mutation-approval card + `mutation-pending` reducer race

The `mutation_pending` / `mutation_decided` WS events drive a reducer with `requestId` keys. If two PATCH /plan calls land in flight simultaneously, the card UI can race. Test `mutation-approval-card.test.ts` covers single-card; QA should probe duplicate-request scenarios.

### 5.9 Inline-workflow + inline-roles inheritance

Child spawn inherits parent's `inlineRoles` (deep clone) and parent's `workflow` snapshot (deep clone, stripped of subgoal verify-steps). Both server.ts (`POST /spawn-child`) and verification-harness.ts (`runSubgoalStep`) routes must agree. AGENTS.md highlights this with a Lesson-style block; tests `runSubgoalStep-inline-roles-inheritance.test.ts` and `child-workflow-inheritance.test.ts` cover the canonical paths but not the cross-path drift. QA: spawn via the tool vs spawn via subgoal verify-step on the same plan and confirm child shapes are identical.

### 5.10 Tree-cost rollup cache invalidation

`computeTreeCost` caches by `(rootGoalId, costGeneration)`. The generation tick relies on every cost mutation calling the tracker. Any new cost-recording site that bypasses the tracker (or forgets to bump the gen) yields stale Tree-cost reads. Spot-check: any new direct mutations to per-goal cost in the diff? Looks clean (only `cost-tracker.ts` writes), but worth confirming in review.

---

## 6. Reviewer + QA hand-off

### Suggested splits for sub-goals (per parent task spec §Decomposition)

The reviewer/QA team-lead may split this audit by area:

1. **Data model + classifier** (§2.1, §3 lessons 4.1/4.2/4.13/4.17) — `goal-store.ts`, `goal-manager.ts`, `plan-mutation.ts`, `parent-workflow-freeze.ts`.
2. **Verification harness + restart** (§2.2, §2.6, §3 lessons 4.5–4.16) — `verification-harness.ts`, `team-manager.ts`, `harness.ts`, `session-manager.ts`.
3. **Tools + REST surface** (§2.3) — `defaults/tools/children/`, `server.ts` cascade endpoints, idempotency.
4. **Roles + system prompt** (§2.4) — `system-prompt.ts`, role YAMLs, `resolve-role.ts`.
5. **UI** (§2.5) — sidebar nesting, plan-tab DAG, dialogs, mutation card.
6. **Docs + tests** (§2.7, §2.8) — coverage check against the Lesson 4.x map.

### Priority remediation list (input for fix-up commits)

1. **§4.2 (Lesson 4.5 unfixed)** — add `process.execPath` at three sites + invariant test. **Low risk, high value.**
2. **§4.5 (Spec §3.4 sandbox)** — either reject or document the inheritance behaviour for sandboxed projects.
3. **§4.4 / §4.8** — surface `divergencePolicy` in the dashboard or document the `goal_set_policy` flow in `docs/nested-goals.md`.
4. **§4.15** — comment-only nit in `seed-default-workflows.ts`.

---

## 7. Closing notes

The implementation hews closely to the spec's reuse mandate — **no new entity, no new manager, no new scheduler**. The verification harness is the scheduler; the goal record is the only data primitive; nine tools + a meta-workflow + UI hooks complete the picture. Net new code is well above the spec's "<2,000 LoC" target (closer to 21,500 insertions including tests + docs), but production-code growth is a more realistic ~5–6 kLoC excluding tests, dialog HTML, and `nested-goals.md`.

The deviations identified are mostly **additive and justified** (Tier 1.5/5 in resolver, inline-roles/workflow inheritance, cascade-required 422 contract, success notification, `spawnedBySessionId` attribution). The two genuine remediation candidates are §4.2 (Lesson 4.5 unfixed) and §4.5 (sandbox §3.4). Everything else is keep-as-is.

Reviewer and QA agents should treat §5 as their work backlog. The Lesson coverage map in §3 is the test-cross-reference table — any failed test there points at the lesson it regressed.

— retro-audit produced by `coder-fd08a224` on goal `audit-subg-225e4d3d`

Co-authored-by: bobbit-ai <bobbit@bobbit.ai>
