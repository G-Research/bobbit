# Nested Sub-Goals

Bobbit goals can spawn **child goals**. A goal whose team-lead is allowed to
create sub-goals becomes the root of a tree: each child has its own team,
branch, workflow, and gates, and runs largely autonomously. The team-lead
decomposes a large goal into a dependency graph of smaller goals, lets them run
(bounded by a concurrency cap), and rolls their finished work back up into the
parent branch.

This page is the user/operator + developer guide. For the exhaustive design
contract — every REST error code, the full classifier algorithm, the file-level
port inventory — see **[docs/design/production-subgoals-port.md](design/production-subgoals-port.md)**.

## Why this exists

A single team can only carry so much scope before its context and review
surface get unwieldy. Sub-goals let a team-lead **delegate** coherent chunks of
work to fresh teams with their own focused context, then orchestrate the
integration. The system is deliberately conservative: every spawn, merge, and
plan change is bounded by server-enforced limits (depth caps, concurrency caps,
plan-freeze governance) so an agent cannot fork-bomb the gateway or silently
drift away from the approved acceptance criteria.

## Enabling sub-goals

Sub-goals are gated at two levels. Both must be on for a goal to spawn children.

### 1. System preference (master gate, default OFF)

**Settings → System → General → Subgoals** (`data-testid="general-subgoals-enabled"`).
This is the master switch. When it is OFF, the per-goal controls are hidden and
no goal can spawn children regardless of its own flags — a per-goal flag can
never override a system-level OFF.

The toggle **defaults OFF**. Sub-goals are an experimental, opt-in capability:
on a fresh install with no stored preference, subgoals read as disabled
everywhere and the user must explicitly enable them here. Only an explicit
stored `true` enables subgoals — an unset/missing preference reads as disabled.
This aligns with the reference PR #497's original OFF default; an earlier
production build deviated by shipping this ON, and that deviation has since been
reverted.

The server is the single source of truth for this gate. The toggle state is
mirrored to `document.documentElement.dataset.subgoalsEnabled` (a UX-only flag,
defaulting to `"false"` when the preference is unset) synchronously on change so
the proposal form and other client-side gate sites flip immediately, without
waiting on the `preferences_changed` broadcast.

Beneath it, **Max subgoal depth** (`data-testid="general-max-nesting-depth"`) is
a stepper clamped to `1..10` that sets the **system ceiling** for nesting depth
(default 3).

### 2. Per-goal proposal controls

In the goal proposal modal's toggle row (beside Sandbox / Auto-start team /
Enable QA Testing):

- **Allow subgoals** (`data-testid="goal-form-subgoals-toggle"`) — lets this
  goal's team-lead spawn children.
- **Max depth** (`data-testid="goal-form-max-depth"`) — shown only when
  Allow-subgoals is ON; defaults to the system ceiling and is clamped to
  `[1, systemCeiling]`.

Both render **only while the system Subgoals preference is ON**.

These controls (and the parent-goal picker) live in a dedicated **Sub-goals**
tab (`data-testid="goal-proposal-tab-subgoals"`). The tab's visibility — and the
equivalent non-tabbed parent-picker row — is a **pure function of the system
Subgoals preference**: present when the flag is ON (for both top-level proposals
and child proposals that already carry a `parentGoalId`) and absent when it is
OFF, regardless of `parentGoalId`. Team-lead `propose_goal` calls only auto-fill
`parentGoalId` when the current goal can spawn children under the current system
and per-goal subgoal policy; otherwise an omitted `parentGoalId` stays omitted
and accepting the proposal creates a top-level goal. Earlier the visibility also
keyed off `parentGoalId`; but a child proposal can only exist when the flag is
on (child creation is server-gated), so `parentGoalId` always implied
`subgoalsEnabled` — the extra clause was dead and was removed so tab visibility
tracks the setting, not the proposal's parent/child relationship.

The proposal modal also exposes **Workflow** and **Roles** tabs
(`goal-proposal-tab-workflow` / `goal-proposal-tab-roles`) for authoring a
goal-scoped inline workflow snapshot and per-goal role overrides (see
[Custom workflows & roles](#custom-per-goal-workflows--roles)).

### Children tools granted to the team-lead

When a goal permits subgoals, its team-lead is granted the nine **Children**
tools. The tool-group policy grants them `always-allow` for the team-lead role
and `never` for every contributor role, so only the orchestrating team-lead can
call them:

| Tool | Purpose |
|---|---|
| `goal_spawn_child` | Create a child goal (own team, branch, workflow) |
| `goal_plan_propose` | Propose/mutate the execution plan (DAG of sub-goals) |
| `goal_plan_status` | Read the current plan and per-step state |
| `goal_merge_child` | Merge a ready child's branch into the parent |
| `goal_archive_child` | Archive a child goal |
| `goal_pause` | Pause a goal and its subtree |
| `goal_resume` | Resume a paused subtree |
| `goal_decide_mutation` | Approve/reject a pending plan mutation |
| `goal_set_policy` | Set divergence policy / concurrency cap |

These are thin wrappers over the REST endpoints in `nested-goal-routes.ts`.

## Nesting depth limit

Depth is a **fork-bomb backstop**, enforced authoritatively server-side on every
spawn path.

- **Depth** = number of `parentGoalId` hops from the root **+ 1** (root = depth
  1), computed by a cycle-guarded bounded walk up the parent chain.
- The **system ceiling** (`maxNestingDepth`, default 3, clamp `1..10`) is a
  **hard cap, not just a default**. Lowering it retroactively caps live trees —
  spawns deeper than the new ceiling are refused even on existing goals.
- A **per-goal override can only tighten**: it can force `subgoalsAllowed` off
  or clamp `maxNestingDepth` to `min(system, value)`, never loosen an ancestor's
  cap. New children **inherit the parent's effective** flags, so descendants can
  never loosen an ancestor's limit.
- A team-lead at `depth == maxDepth` **cannot create any child** — so it can
  never create a subgoals-allowed child that would itself violate the limit.

Enforcement funnels through one pure helper (`checkCanSpawnChild` in
`subgoal-nesting-limit.ts`) used by both spawn paths. Refusals are
`403 SUBGOALS_DISABLED` or `403 NESTING_DEPTH_EXCEEDED {currentDepth, maxDepth}`.
UI controls are UX only; the server is the authority.

## Sidebar hierarchy

Children nest under their **spawning team-lead** in the sidebar, resolved via
`spawnedBySessionId` (stamped at every spawn path, with a render-side fallback).

- Parent rows show a **descendant-count badge**
  (`data-testid="sidebar-descendant-badge"`).
- Same-titled siblings get a **disambiguation suffix** so they're tellable
  apart.
- Live, archived, and blocked children are visually distinguished.
- A depth-5 sidebar render cap keeps deep trees readable (the depth *limit* is
  separate and server-enforced; this is just a rendering bound).

## Goal dashboard

### Plan tab — the descendant DAG

The Plan tab renders a live **DAG** of the goal plus **all descendants (live and
archived)**, layered by their `dependsOnPlanIds` dependency edges. It is sourced
from `GET /api/goals/:id/descendants` — deliberately **independent of the
sidebar's archived filter**, so archived nodes still appear in the graph.

- **Per-node gate status**: pending / running / passed / failed / bypassed (a
  human-overseer override; see [Human gate bypass](goals-workflows-tasks.md#human-gate-bypass)).
- **Archived distinction**: archived nodes are dimmed/dashed and carry a
  `data-testid="plan-node-archived-pill"` badge.
- **Merge / conflict state** per child.
- **Inline nested disclosure**: a chevron on a child node expands that child's
  own plan recursively (depth cap 3); overflow collapses to a "Show N more…"
  affordance.
- **Live-only toggle** (`data-testid="plan-live-only-toggle"`), defaulting to
  **inclusive** (archived shown, dimmed).

### Children tab + cost roll-up

A sibling **Children** tab lists the subtree and shows a **cost / token
roll-up** across the whole subtree, **including archived children**, via
`GET /api/goals/:id/tree-cost`. Cost records are stamped with `goalId` so the
roll-up survives session purge — a child whose session has been cleaned up still
contributes its historical cost to the parent's total.

## Custom per-goal workflows & roles

A goal can run its own workflow and role overrides — it does **not** have to use
the project defaults, and **a child may run a different workflow than its
parent**.

Two authoring paths:

1. **Proposal modal** Workflow/Roles tabs — `inlineWorkflow` / `inlineRoles`
   passed to `createGoal`, captured as a frozen goal-scoped snapshot.
2. **Team-lead tools** — `goal_plan_propose` / `goal_spawn_child` accept a
   `workflowId` (and inline workflow/roles) so the team-lead can attach a
   workflow per child.

The `subgoal` verify-step type **is the scheduler hook**: a `parent`
meta-workflow (carrying an `execution` gate) unlocks the full plan-mutation
flow described under [Governance](#governance).

### dependsOn DAG between siblings

Sibling sub-goals can declare `dependsOn` edges, forming a DAG. A child with
unmet dependencies is created in the scheduler's **`blocked`** state and
**auto-resumes** (`blocked → todo`) when its **last dependency merges**.

> **`blocked` (dependency wait) is distinct from operator `paused`.** `blocked`
> is a scheduler-managed state cleared automatically when dependencies resolve;
> an operator **resume must not** clear dependency-blocking. Pause is a
> human/operator action (see [Pause/resume cascade](#pauseresume-cascade)).
> Spawn/plan responses surface `blocked: true` plus the `pendingDeps` list.

Dependency declarations are validated at spawn and on plan mutation:
self-dependency → `400 SELF_DEPENDENCY`, unknown plan id → `400 UNKNOWN_PLAN_ID`,
cycle → `400 DEPENDS_ON_CYCLE`.

## Branch roll-up

Children integrate **locally**, not via per-child PRs — this keeps the GitHub PR
surface to exactly one PR per goal tree:

- Each child merges into the **parent's branch** with `git merge --no-ff`
  (`mergeChildBranchLocal`), behind a gated push (`shouldSkipRemotePush`).
- **Only the root goal raises a GitHub PR.** Children never raise their own.
- On **merge conflict**: `git merge --abort`, the subgoal step fails with a
  manual-recovery directive, and **the child is preserved** (not auto-archived)
  so a human or the team-lead can resolve it.

A child must be **ready-to-merge** (`child-ready-to-merge.ts`) before
integration; `team_complete` on the parent blocks while children are unresolved.

## Governance

Once a plan is committed, changes to it are policed so an agent can't quietly
drop acceptance criteria or thrash the plan.

### Plan freeze

`execution.verify[]` (the subgoal steps) is **frozen** the moment the `goal-plan`
gate is signalled (`parent-workflow-freeze.ts`, reflected as
`gate.metadata.frozen === "true"`). Before the freeze, plan edits apply
directly; after it, every edit goes through the classifier below.

### Mutation classifier

`classifyMutation()` (`plan-mutation.ts`, pure/no-I/O) diffs the frozen plan
against the proposed plan and assigns one of five verdicts:

| Verdict | Meaning |
|---|---|
| `noop` | No structural change |
| `fix-up` | Adds/modifies at non-increasing phase |
| `expansion` | New work at a later phase, or a step's phase increased |
| `restructure` | A step removed, a phase decreased, or a dependency set changed on an existing step |
| `criteria-drop` | A root acceptance criterion is no longer covered (always rejected) |

Criteria coverage is a **whitespace-normalised, locale-pinned-`en`,
case-insensitive substring** match of each root acceptance criterion against the
root spec ∪ remaining subgoal specs. This is why specs must quote criteria
**verbatim under a `## Covers` heading** — paraphrasing capitalisation or
whitespace is tolerated, but dropping the text triggers `criteria-drop`.

### Divergence policy + decision matrix

Each goal carries a per-goal `divergencePolicy` (`strict` / `balanced`
(default) / `autonomous`), set via `goal_set_policy` / `PATCH /policy`. The
`PATCH /plan` handler binds verdict × policy to an action:

| Verdict | strict | balanced | autonomous |
|---|---|---|---|
| `criteria-drop` | `409 CRITERIA_DROP` | `409 CRITERIA_DROP` | `409 CRITERIA_DROP` |
| `restructure` (not paused) | `409 RESTRUCTURE_REQUIRES_PAUSE` | `409 RESTRUCTURE_REQUIRES_PAUSE` | `409 RESTRUCTURE_REQUIRES_PAUSE` |
| `restructure` (paused) | approval | approval | approval |
| `expansion` | approval | approval | approval |
| `fix-up` | approval | apply directly | apply directly |
| `noop` | apply (no-op) | apply (no-op) | apply (no-op) |

"approval" persists a `PendingMutation` (`requestId`, 24h TTL, restart-safe via
`plan-mutation-store.ts`), broadcasts `mutation_pending`, and responds
`{requiresApproval: true, requestId}`.

### Approval surfaces

A pending mutation surfaces in **two** places, both POSTing to
`/api/goals/:id/mutation/:requestId/decision`:

1. In-chat — the `<children-mutation-approval>` custom message.
2. Dashboard — a **mutation-pending card** driven by the `mutation_pending`
   broadcast.

Pending requests survive restart (rehydrated from the store), so an approval
isn't lost across a gateway bounce.

### Auto-pause on churn

Each applied mutation increments `replanCount`; when `replanCount > 5` the goal
**auto-pauses** — a backstop against runaway replanning.

## Orchestration controls

### Concurrency cap — the unified scheduler

`ChildTeamScheduler` (`child-team-scheduler.ts`) is the **single authority** for
how many child teams run concurrently under one root. Every path that starts a
child team routes through it: harness `runSubgoalStep`, REST `spawn-child`,
`POST /api/goals` child creation, and `integrate-child` dependency auto-unblock.
Before this unification each path started teams independently, so the cap could
be bypassed.

The per-root semaphore **is** the scheduler — there is no poll loop. Cap default
3, floor 1, hard max 8. At cap, a child is parked `blocked` (capacity) and
enqueued FIFO; a terminal child event (merge / archive / completion) releases a
permit and **synchronously starts the next eligible queued child**. The cap is
set with `goal_set_policy` / `PATCH /policy`'s `maxConcurrentChildren` (validated
`[1,8]`); it is stored per-goal but **resolved at the root** for the semaphore,
so operators effectively set concurrency on the root. Live cap resizes apply in
place.

### Pause/resume cascade

`POST /api/goals/:id/pause` and `/resume` require a `{cascade: boolean}` body
(`422 CASCADE_REQUIRED` if absent). Pause:

- soft-aborts the subtree's sessions and cancels in-flight verifications,
- makes every spawn path return `409 GOAL_PAUSED`,
- and — critically — the **boot-respawn supervisor skips paused goals**, so a
  paused goal stays paused across a gateway restart instead of being
  resurrected (the "whack-a-mole" fix).

Resume re-enables spawns but does not auto-restart sessions. Pause/resume is an
**operator** action and is distinct from the scheduler's dependency `blocked`
state.

### Auto-retry / rescue

Several recovery paths keep a tree healthy without manual intervention:
merge-conflict preservation (above), workflow-less `complete`-child recovery,
stale child/archived-pointer invalidation, and a boot `backfillCompleteState`
pass that reconciles state after a crash. Spawning is **idempotent on `planId`**
— a retried spawn returns the existing child rather than duplicating it.

## Security model

The mutating Children endpoints are guarded server-side by
`authorizeChildrenMutation` (`children-mutation-authz.ts`), split into two
authorization classes to shrink the blast radius:

- **`orchestration`** — `spawn-child`, plan `PATCH`, `integrate-child`,
  `policy`. The autonomous team-lead verbs; the web UI never issues them. These
  are **team-lead-only** and the human cookie does **not** bypass.
- **`operator`** — `pause`, `resume`, mutation `decision`, `archive-child`. The
  human-in-the-loop verbs the UI drives. A verified `bobbit_session` cookie is
  accepted (human/UI), otherwise the same team-lead match applies.

### Per-session capability secret

The authentic caller is **not** taken from the public, forgeable
`X-Bobbit-Spawning-Session` header (which survives only for `spawnedBySessionId`
bookkeeping). Instead each session process is injected with a crypto-random
`BOBBIT_SESSION_SECRET` (alongside `BOBBIT_SESSION_ID`, via the bridge env for
local sessions and `docker exec -e` for sandboxed ones — never on the pool
container's PID 1). The `children` extension sends it as `X-Bobbit-Session-Secret`;
the server resolves it via `SessionSecretStore.resolveSessionIdBySecret()`
(`session-secret.ts`, in-memory only, never written to disk) to the authentic
session id, then compares **that** for equality against the goal's authoritative
team-lead (`TeamManager.getTeamState(goalId)?.teamLeadSessionId`). A caller that
forges the public header but lacks the secret resolves to `undefined` → deny.
The store is restart-safe: secrets rotate on respawn (they're capabilities, not
identities — only the live mapping matters).

### Residual risk (known, tracked)

The **operator** endpoints still trust the **shared admin Bearer token**: any
holder of that token can mint a `bobbit_session` cookie and drive the operator
verbs. This is an **inherent property of Bobbit's single shared-credential
model** — agents and the human share one gateway token, so the cookie path
cannot cryptographically distinguish a human operator from a token-holding
agent. Full separation requires a dedicated human-only operator credential that
agents never possess; that is out of scope for this work and tracked as future
work. The orchestration/operator split plus the per-session secret remove the
cookie bypass from the high-impact orchestration surface without claiming to
fully isolate the operator surface.

A second, accepted residual: a co-resident session in the same pre-warmed pool
container, running as the same uid, could read another exec'd process's
`/proc/<pid>/environ` and thus its secret. This matches the existing threat
model for the per-project sandbox token; full isolation would require
per-session containers.

## Where the code lives (developer pointers)

| Concern | Module |
|---|---|
| Nesting limit (pure helpers) | `src/server/agent/subgoal-nesting-limit.ts` |
| REST routes (spawn / plan / pause / policy / descendants / tree-cost) | `src/server/agent/nested-goal-routes.ts` |
| Children-mutation authorization | `src/server/auth/children-mutation-authz.ts` |
| Per-session capability secret store | `src/server/auth/session-secret.ts` |
| Subgoal verify step + recovery branches | `src/server/agent/verification-harness.ts` (`runSubgoalStep`) |
| Unified concurrency scheduler | `src/server/agent/child-team-scheduler.ts` |
| Plan mutation classifier (pure) | `src/server/agent/plan-mutation.ts` |
| Pending-mutation persistence (24h TTL, restart-safe) | `src/server/agent/plan-mutation-store.ts` |
| Plan freeze on goal-plan signal | `src/server/agent/parent-workflow-freeze.ts` |
| Pause guard | `src/server/agent/goal-paused-guard.ts` |
| Subtree cost / token roll-up (`goalId`-stamped) | `src/server/agent/cost-tracker.ts`, `cost-backfill.ts` |
| Subtree / descendant queries | `src/server/agent/goal-subtree.ts`, `goal-descendants.ts` |
| Ready-to-merge check | `src/server/agent/child-ready-to-merge.ts` |
| Local branch merge helpers | `src/server/agent/skills/git.ts` (`mergeChildBranchLocal`, `shouldSkipRemotePush`) |
| dependsOn validation | `src/server/agent/depends-on-validation.ts` |
| Persisted goal fields | `src/server/agent/goal-store.ts` |
| Children tool definitions | `defaults/tools/children/*`, policy in `defaults/tool-group-policies.yaml` |
| Proposal subgoal controls + Workflow/Roles tabs | `src/app/proposal-panels.ts` |
| System pref toggle + max-depth stepper | `src/app/settings-page.ts`, gate helper `subgoals-flag.ts` |
| Sidebar nesting + descendant badge | `src/app/sidebar-nesting.ts`, `sidebar-spawned-children.ts`, `render-helpers.ts` |
| Plan tab (DAG, per-node state) | `src/app/goal-dashboard-plan-tab.ts`, `plan-synthesis.ts`, `plan-node-state.ts` |
| Children tab + cost roll-up | `src/app/goal-dashboard-children-tab.ts` |
| Children tool renderers + approval card | `src/ui/tools/renderers/Goal*Renderer.ts`, `src/ui/lazy/children-mutation-approval.ts` |

For the full file inventory, REST error-code catalogue, and the exact classifier
algorithm, see **[docs/design/production-subgoals-port.md](design/production-subgoals-port.md)**.
