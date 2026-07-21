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

These controls live in a dedicated **Sub-goals** tab
(`data-testid="goal-proposal-tab-subgoals"`), split into two clearly separated
sections so the operator never confuses "where does this goal live" with "can
this goal have children of its own":

**Section 1 — Attach to an existing goal** (`data-testid="goal-form-attach-section"`).
The **Parent Goal** picker (`data-testid="goal-form-parent-picker"`) chooses
where the *new* goal lives: nested beneath an existing goal, or left as `None`
for a top-level goal. This is the surface the human operator uses to manually
attach a child — it does **not** change the parent's own settings. The picker
also surfaces **host-eligibility before submit** (see below) so a dead-end
parent is visible up front rather than only as a server reject.

**Section 2 — Allow this new goal to host sub-goals**
(`data-testid="goal-form-host-section"`). These govern the goal *being created*,
not the parent selected above:

- **Allow subgoals** (`data-testid="goal-form-subgoals-toggle"`) — lets this
  new goal's team-lead spawn children later. An inline help line
  (`data-testid="goal-form-subgoals-toggle-help"`) reminds the operator this is
  about the new goal, and that an *existing* parent is enabled from its
  dashboard → Children tab instead.
- **Max nesting depth** (`data-testid="goal-form-max-depth"`) — shown only when
  Allow-subgoals is ON. See [Max-depth semantics](#max-depth-semantics) — it is
  the absolute deepest level allowed in the tree, defaulting to the inherited
  ceiling.

Both sections render **only while the system Subgoals preference is ON**.

The tab's visibility — and the equivalent non-tabbed parent-picker row — is a
**pure function of the system Subgoals preference**: present when the flag is ON
(for both top-level proposals and child proposals that already carry a
`parentGoalId`) and absent when it is OFF, regardless of `parentGoalId`.
Team-lead `propose_goal` calls only auto-fill
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

### Parent-picker host-eligibility

A goal can be created with **Allow subgoals OFF** (the default per PR #497). Such
a goal can never host children — so picking it as a Parent Goal would fail at
submit with a confusing error. To make the dead-end visible *before* submit, the
parent picker pre-computes each candidate's host-eligibility client-side
(`src/app/subgoal-eligibility.ts`, a mirror of the server's
`subgoal-nesting-limit.ts`) and:

- **Suffixes ineligible options** in the dropdown — `(sub-goals off)` for a goal
  with `subgoalsAllowed: false`, or `(at nesting cap)` for one with no room left
  below it.
- **Shows an inline warning** (`data-testid="goal-form-parent-ineligible-warning"`)
  when an ineligible parent is selected, naming the remediation (open the
  parent's dashboard → Children tab and turn on "Allow sub-goals", or pick a
  shallower parent).

This is **UX pre-communication only** — it mirrors but never relaxes the
server gate. The server still authoritatively re-checks on submit.

### Enabling sub-goals on an existing goal

A goal created with Allow-subgoals OFF is **not** permanently barred from
hosting children. The goal dashboard's **Children** tab renders a **Sub-goal
settings** card (`data-testid="goal-subgoal-settings"`, only when the system
Subgoals flag is ON) that lets a human:

- **Toggle "Allow sub-goals"** (`data-testid="goal-subgoal-settings-allow-toggle"`)
  to turn child-hosting on (or off) after creation. This is the fix for the
  "Parent goal doesn't allow sub-goals" dead-end: flip it on here, then the goal
  becomes a valid Parent Goal.
- **Adjust Max nesting depth** (`data-testid="goal-subgoal-settings-depth"`,
  with `-`/`+` steppers) within the same inherited band the proposal form
  enforces.

If the goal already sits at the inherited nesting cap, the card shows an
at-cap notice (`data-testid="goal-subgoal-settings-at-cap"`) instead — there is
no room below it for children regardless of the toggle.

These persist via `PATCH /api/goals/:id/policy` (the goal feed echoes the new
values so they survive a reload).

**Enabling sub-goals co-persists a valid depth.** Turning the toggle ON does
not always PATCH `{ subgoalsAllowed: true }` alone: if the goal's stored
`maxNestingDepth` is missing, stale, or outside the currently valid
`[minDepth, maxDepth]` band, the toggle also sends the clamped `depthValue`
(`{ subgoalsAllowed: true, maxNestingDepth: depthValue }`). Without this the
goal could be flagged sub-goals-allowed while keeping a too-low cap that still
refuses children — the toggle would appear to work but the dead-end would
persist, and the UI's clamped display would silently disagree with the stored
value. When the stored depth is already valid the toggle leaves it untouched. The two sub-goal fields
(`subgoalsAllowed` / `maxNestingDepth`) are **operator-class** authz — a
verified human cookie is accepted — so the human-driven UI can flip them, while
the orchestration fields on the same endpoint stay team-lead-only (see
[Security model](#security-model)).

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
| `goal_merge_child` | Merge a ready child's branch into the parent; `force: true` bypasses the RTM gate check |
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
`subgoal-nesting-limit.ts`) used by both spawn paths. Refusals carry one of
three distinct codes (`403` on the spawn routes, `422` on `POST /api/goals`):

- **`SUBGOALS_DISABLED`** — the **system** preference is OFF. This is the
  master gate and always wins, even when the parent also disallows sub-goals.
- **`PARENT_SUBGOALS_DISABLED`** — the system pref is ON but **this specific
  parent** carries `subgoalsAllowed: false`. The message names the parent
  (`Parent goal "<title>" doesn't allow sub-goals`) so the UI can offer to flip
  its policy. Kept distinct from `SUBGOALS_DISABLED` precisely because reusing
  the system-off string made a per-goal opt-out look like a broken system
  setting. The wording is aligned across all three blocking sites
  (`server.ts`, `nested-goal-routes.ts`, `verification-harness.ts`).
- **`NESTING_DEPTH_EXCEEDED {currentDepth, maxDepth}`** — depth cap reached.

UI controls are UX only; the server is the authority.

### Max-depth semantics

"Max nesting depth" (both the proposal control and the existing-goal settings
card) is the **absolute deepest nesting level allowed in this tree** — it equals
the server's stored `maxNestingDepth`, *not* a count of levels relative to the
goal. The relationship the help text spells out:

```
levels of sub-goals allowed below this goal = maxNestingDepth − (this goal's depth)
```

- A **top-level goal** (depth 1) defaults to the full **system cap** (e.g. 3),
  so it can host up to 2 levels below it.
- The control's range is `[thisDepth + 1, inheritedCap]` — it must leave at
  least one level for children, and can never exceed the inherited cap.
- The **inherited cap** is the system ceiling for a root goal, but for a child
  it is the **parent's effective cap** (`system ∩ parent.own ∩ … up the tree`).
  A descendant can only **tighten**, never widen past an ancestor — so a parent
  capped at 2 will never let a child be configured at 3.
- When only one value fits (`thisDepth + 1 == inheritedCap`), the stepper is
  **locked** and the help text explains why ("only one value fits, so it's
  fixed"). Whenever a valid range exists, the `-`/`+` buttons step through it.
- **The displayed value is the value submitted.** Both controls derive their
  number from `resolveDepthControl` (`src/app/subgoal-eligibility.ts`), whose
  `depthValue` is the configured override **clamped into `[minDepth, maxDepth]`**
  (or the full cap when untouched). The stepper renders this same `depthValue`
  and every change PATCHes it, so what the user sees can never diverge from what
  is persisted — even when the stored override is stale or out of range, the
  control shows the clamped value and submits *that*. The server re-clamps on
  write regardless (see below), so the UI is a faithful mirror, never the
  authority.

Because the effective cap is recomputed dynamically against the live ancestor
chain, **tightening an ancestor's cap retroactively bites already-created
descendants**: a child whose stored `maxNestingDepth` is stale (e.g. 3) is still
re-clamped against the now-lowered ancestor (e.g. 2) at spawn time. The proposal
form, the settings card, and the server clamp all share this rule via the
`effectiveMaxNestingDepth` helpers (server) / `effectiveMaxNestingDepthOf`
(client).

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
  (`mergeChildBranchLocal`). The merge may fetch the child ref best-effort, but
  it never pushes the child or parent branch.
- **Only the root goal raises a GitHub PR.** Children never raise their own.
- On **merge conflict**: `git merge --abort`, the subgoal step fails with a
  manual-recovery directive, and **the child is preserved** (not auto-archived)
  so a human or the team-lead can resolve it.

A remote parent branch that was deleted before integration stays deleted after
the merge. Publication, when desired, remains a later explicit push or root
Ready-to-Merge/PR operation.

A child must be **ready-to-merge** (`child-ready-to-merge.ts`) before
integration; `team_complete` on the parent blocks while children are unresolved.

### Parent notification on child completion

When a child goal's team calls `team_complete`, the server notifies the parent
team lead automatically — regardless of whether the child's workflow has a
`ready-to-merge` gate. This fires from `completeTeam()` in `team-manager.ts`
via `buildParentCompletionNotification()` (`notify-team-lead-child-passed.ts`).

The notification tells the parent the child's branch is ready and instructs it
to call `goal_merge_child` or `goal_archive_child`. If the parent team lead is
currently streaming, the message is delivered as a live steer; otherwise it is
enqueued as a prompted message.

The existing `ready-to-merge` gate notifications (`buildParentReadyNotification`)
are **complementary, not replaced**. They still fire when a child's `ready-to-merge`
gate passes or fails, giving the parent an early warning before the child has
fully called `team_complete`. A child with a bespoke workflow that has no
`ready-to-merge` gate relies solely on the completion notification.

### `goal_merge_child` — `force` parameter

`goal_merge_child` accepts an optional `force: boolean` parameter (maps to
`body.force` on `POST /api/goals/:id/integrate-child/:childId`). By default,
the server refuses to merge a child whose `ready-to-merge` gate has not passed
(`409 RTM_NOT_PASSED`). Setting `force: true` bypasses this check.

Use `force: true` when:
- The child's workflow has no `ready-to-merge` gate (for example, a child
  running a bespoke workflow).
- The merge has been manually reviewed and approved as safe to proceed.

### `goal_merge_child` — 409 body normalization and renderer states

`goal_merge_child` uses `apiCallDetailed` so structured 409 response bodies
are preserved regardless of HTTP status. The renderer (`GoalMergeChildRenderer`)
can then display all outcome states:

| Outcome | Renderer pill |
|---|---|
| Clean merge | `merged ✓` (green) |
| Conflict | `conflict ⚠` (amber) — expandable conflict output |
| RTM gate not passed | `RTM not passed ✗` (red) — `rtmFailed: true` in body |
| Already merged | `already merged` (muted) |
| Other error | Plain error message |

A 409 with `{ conflict: true, output, repos? }` passes through as-is so the
renderer can show the expandable conflict block. A 409 with
`{ code: "RTM_NOT_PASSED" }` is normalized to `{ ...body, rtmFailed: true }` so
the renderer pill fires correctly. A 409 with `code: "GOAL_GIT_UNAVAILABLE"`
surfaces as a plain error message, since no structured pill is defined for that
case. Successful and conflict responses intentionally contain no `pushed`
field: the operation makes no remote-publication claim.

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
(`422 CASCADE_REQUIRED` if absent). Both endpoints work regardless of the
`subgoalsEnabled` system preference — pause and resume are operator lifecycle
verbs with no dependency on the subgoal feature. Pause:

- soft-aborts the subtree's sessions and cancels in-flight verifications,
- makes every spawn path return `409 GOAL_PAUSED`,
- rejects prompts to sessions on the paused goal (see below), and
- keeps the pause durable across gateway restart.

Restart restores persisted active teams and re-subscribes their existing leads.
Boot-resume/nudge skip predicates apply only to those restored leads, so a
paused restored lead is not nudged. Restart does not create a new Team Lead for
an existing goal that is teamless.

Resume re-enables spawns and prompt delivery but does not auto-restart sessions.
Pause/resume is an **operator** action and is distinct from the scheduler's
dependency `blocked` state.

**Prompt rejection.** While a goal is paused, `POST /api/goals/:id/team/prompt`
and `POST /api/sessions/:id/prompt` return `409 GOAL_PAUSED` before any team
membership or authorization checks. Sessions with no associated goal are
unaffected. This ensures agents targeting a paused goal receive a clear,
actionable error rather than an opaque auth failure.

**In-chat banner.** A warning banner with an inline Resume button appears inside
the session panel when the active session's goal is paused. It is visible in all
layout modes and disappears when the goal is resumed.

See [docs/design/pause-cascade.md](design/pause-cascade.md) for full details,
including the error shape, key files, and test coverage.

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

- **`orchestration`** — `spawn-child`, plan `PATCH`, `integrate-child`, and
  `policy` bodies carrying `divergencePolicy` / `maxConcurrentChildren`. The
  autonomous team-lead verbs; the web UI never issues them. These are
  **team-lead-only** and the human cookie does **not** bypass.
- **`operator`** — `pause`, `resume`, mutation `decision`, `archive-child`, and
  `policy` bodies carrying **exclusively** the per-goal sub-goal opt-in fields
  (`subgoalsAllowed` / `maxNestingDepth` — the goal dashboard's Sub-goal
  settings card). The human-in-the-loop verbs the UI drives. A verified
  `bobbit_session` cookie is accepted (human/UI), otherwise the same team-lead
  match applies.

`PATCH /api/goals/:id/policy` is classified **per request body**: a body that
mixes in *any* orchestration field is treated as orchestration (the stricter
class wins), so the cookie path can never piggyback an orchestration change
behind a sub-goal toggle. A body with no recognized field is rejected
`400 NO_POLICY_FIELDS`.

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

The **operator** endpoints still indirectly trust the **shared admin Bearer
token**: any holder can deliberately make an eligible browser-shaped API
request, obtain a signed `bobbit_session` cookie, and then drive the operator
verbs. Plain Bearer, session-bound, sandbox, and internal callback traffic does
not automatically mint that cookie, but the browser headers are spoofable
routing metadata rather than proof of a human. This is an **inherent property
of Bobbit's single shared-credential model** — agents and the human share one
gateway token, so the cookie path cannot cryptographically distinguish a human
operator from a token-holding agent. Full separation requires a dedicated
human-only operator credential that agents never possess; that is out of scope
for this work and tracked as future work. The orchestration/operator split plus
the per-session secret remove the cookie bypass from the high-impact
orchestration surface without claiming to fully isolate the operator surface.

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
| Parent notifications (pure helpers) | `src/server/agent/notify-team-lead-child-passed.ts` — `buildParentReadyNotification` (RTM gate pass/fail) and `buildParentCompletionNotification` (`team_complete`) |
| Local branch merge helper | `src/server/agent/skills/git.ts` (`mergeChildBranchLocal`) |
| dependsOn validation | `src/server/agent/depends-on-validation.ts` |
| Persisted goal fields | `src/server/agent/goal-store.ts` |
| Children tool definitions | `defaults/tools/children/*`, policy in `defaults/tool-group-policies.yaml` |
| Proposal subgoal controls + Workflow/Roles tabs | `src/app/proposal-panels.ts` |
| Client-side parent host-eligibility mirror | `src/app/subgoal-eligibility.ts` |
| Existing-goal Sub-goal settings card + policy PATCH helper | `src/app/goal-dashboard-children-tab.ts`, `api.ts` (`patchGoalSubgoalPolicy`) |
| System pref toggle + max-depth stepper | `src/app/settings-page.ts`, gate helper `subgoals-flag.ts` |
| Sidebar nesting + descendant badge | `src/app/sidebar-nesting.ts`, `sidebar-spawned-children.ts`, `render-helpers.ts` |
| Plan tab (DAG, per-node state) | `src/app/goal-dashboard-plan-tab.ts`, `plan-synthesis.ts`, `plan-node-state.ts` |
| Children tab + cost roll-up | `src/app/goal-dashboard-children-tab.ts` |
| Children tool renderers + approval card | `src/ui/tools/renderers/Goal*Renderer.ts`, `src/ui/lazy/children-mutation-approval.ts` |

For the full file inventory, REST error-code catalogue, and the exact classifier
algorithm, see **[docs/design/production-subgoals-port.md](design/production-subgoals-port.md)**.
