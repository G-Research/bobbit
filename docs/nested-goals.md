# Nested goals — user reference

A **nested goal** is a goal whose branch lives under another goal's branch
and merges back into it locally instead of raising a PR to `master`.
Multiple subgoals at the same depth can run in parallel. Subgoals can
themselves be parent goals — the tree is recursive.

This page is the user-facing reference. For internals (data-flow,
classifier algorithm, harness wiring), see
[`docs/design/nested-goals.md`](design/nested-goals.md).

> **TL;DR.** Pick the `parent` workflow when creating a goal. Let the
> team-lead draft a plan in the **Plan** tab. Approve the plan to freeze
> it. Children spawn in parallel up to a per-tree concurrency cap, each
> in its own worktree. When a child's `ready-to-merge` passes, its branch
> is merged locally into the parent. Only the **root** goal raises a PR
> to `master`.

---

## 1. Why nested goals exist

Some specs are too big for a single goal:

- A spec with multiple shippable versions (v0.1 → v0.2 → v1.0).
- A spec where independent slices can land on the same trunk in any
  order before the rest finish.
- A spec where one slice is large enough to deserve its own design-doc
  → implementation → review cycle.

Before nested goals, you had two choices: cram everything into one goal
(huge PR, blurry review), or open multiple peer goals on `master` and
coordinate by hand.

Nested goals give you a third option: a **coordination layer** that owns
acceptance criteria, hosts a planning gate, and integrates each child's
merge commit into one branch that ultimately becomes one PR. Reviewers
read the parent goal as the contract; each child is its own
independently-reviewable change set.

---

## 2. Data model — what's stored on a goal

Every goal record gains a small set of optional fields. Existing
single-goal users are unaffected — every field defaults sensibly.

| Field | Type | Meaning |
|---|---|---|
| `parentGoalId` | string? | Parent in the tree. Undefined for top-level goals. |
| `rootGoalId` | string? | Top-of-tree goal id. Always populated; equals `id` for top-level. |
| `mergeTarget` | `"master" \| "parent"` | Where this goal's branch merges back to. Auto-derived from `parentGoalId` (top-level → `master`, child → `parent`). |
| `divergencePolicy` | `"strict" \| "balanced" \| "autonomous"` | Controls auto-approval of post-freeze plan mutations. Inherited from parent if unset. Default at the root: `strict`. |
| `maxConcurrentChildren` | number | Cap on how many children of *the root* run in parallel. Default 3, hard max 8. **In v1, only the root's value is consulted** — sub-goal values are stored for forward-compat but inert. |
| `inlineWorkflow` | `Workflow?` | Workflow YAML pasted in the New Goal dialog and snapshotted onto the goal. Resolves before the project/server/builtin cascade. |
| `inlineRoles` | `Record<string, Role>?` | Inline role definitions, scoped to this goal-tree. |
| `acceptanceCriteria` | `string[]?` | Parsed from the spec's `## Acceptance criteria` section at goal creation. Used by the mutation classifier to detect dropped criteria. |
| `replanCount` | number | Counts post-freeze mutations. Goal auto-pauses at `> 5`. |
| `paused` | boolean | When true, the verification harness skips ticks for this goal. Required by `strict` policy before applying restructure mutations. |
| `spawnedFromPlanId` | string? | When this goal was spawned by a parent's subgoal verify step, the `planId` of that step. Used for two distinct mechanisms (see the JSDoc on `src/server/agent/goal-store.ts::PersistedGoal`): (1) `GET /api/goals/:id/plan` resolves planSteps' `child` field via `resolvePlanStepChild` walking by this field, including archived children where `archived: true && state === "complete"` represents the success terminal state; (2) verification-harness `runSubgoalStep` idempotency — re-binds to an existing child by `(parentGoalId, spawnedFromPlanId)` instead of spawning a duplicate. The tier-based preference order at `78e58586` (live in-progress → archived+complete → live other state → archived non-complete) prevents zombie siblings from shadowing the merged child. |

All fields are optional. A goal without any of them behaves exactly as
goals did before nested goals existed.

> See `docs/design/nested-goals.md` §1 for the full schema, the
> acceptance-criteria parser, and migration semantics.

---

## 3. Branching topology

A nested-goal tree pushes exactly **one** PR to `master` — from the root.
Every other branch merges locally into its parent.

```
master ─────────●─────────────────────────────────●─────►
                 \                                /
                  ●─ goal/root ────●─────●───────●─ (PR: root → master)
                                    \    \     /
                                     \    \   / local merge into goal/root
                                      \    \ /
                                       ●────●─ goal/v0-1 (child of root)
                                        \
                                         \ local merge into goal/v0-1
                                          \
                                           ●─ goal/sim-1 (grandchild)
```

Reading the diagram:

- `master` carries one merge commit when the root's PR lands.
- `goal/root` is the root goal's branch. It branches off `master` and is
  the only branch that ever raises a PR back to `master`.
- `goal/v0-1` (a child) branches off `goal/root` at the moment it spawns
  and merges locally into `goal/root` when its own `ready-to-merge` gate
  passes.
- `goal/sim-1` (a grandchild) branches off `goal/v0-1` and merges back
  into it. The child later merges its (now-advanced) tip into the root.
- After any sibling merges into a parent, subsequently-spawned siblings
  branch off the **post-merge tip** — they observe each other's commits.

The invariants enforced by the implementation:

1. Each subgoal gets its own git worktree (sandboxed and host-side
   alike). No shared-worktree mode.
2. A subgoal's branch is created off its **parent's branch HEAD** at
   spawn time — not off `origin/master`, not off the root.
3. A subgoal's `ready-to-merge` triggers a **local** merge into the
   parent. No remote PR is raised for children, and no child pushes to
   `master`.
4. The recursion is unbounded in principle. The UI sidebar caps render
   depth at 5 — deeper trees collapse into a "Show N more" button.
5. After a clean local merge, the parent branch is pushed to `origin`
   (gated by `shouldSkipRemotePush()`). This is **not** a PR-raising
   push — it just makes the post-merge tip available to CI and to
   sibling subgoals that spawn later.

> See `docs/design/nested-goals.md` §3.0 for the complete invariant
> list, §3.1 for `baseBranch` plumbing, §3.3 for merge semantics, and
> §3.4 for how children short-circuit their `ready-to-merge` gate.

---

## 4. Subgoal verify steps — workflow-as-DAG

Bobbit workflows are already DAGs (gates depend on other gates, verify
steps run in `phase`-parallel). Nested goals add **one new primitive**: a
verify step whose `type` is `"subgoal"`.

A subgoal verify step:

1. Spawns a child goal whose branch starts at the current goal's
   `branch` HEAD.
2. Waits for the child's `ready-to-merge` gate to pass.
3. Locally merges the child's branch into the current goal's branch.
4. The verify step passes when the merge succeeds.
5. After a clean merge, **auto-archives the child goal and tears down
   its team** (`c95f8f60`). Once the child's branch is integrated and
   the parent has accepted, the child's worktree + team-lead session
   have served their purpose; leaving them live clutters the dashboard
   and pins disk + memory. The same auto-archive pattern fires from
   four merge sites symmetrically:
   - `runSubgoalStep` post-merge (this path — harness poll loop)
   - eager-merge IIFE in `notifyTeamLead` on a child's ready-to-merge
     bubble (`e39a5b53` — fires when the harness poll loop has already
     terminated)
   - `integrate-child` REST route when team-leads call `goal_merge_child`
     directly via the MCP tool (`658f2da7`)
   - `execution`-gate-signal reconciliation that detects manual
     `git merge` from the terminal via `git merge-base --is-ancestor`
     (`6aaee3aa`)

   Merge conflicts do NOT archive the child — the work-in-progress
   stays live so the team-lead can fix and retry. Archived children
   render in the Children tab with an "Archived" / "Merged" badge
   (§8 "Recovery scenarios" + §11 "UI cheatsheet").

Any gate, in any workflow, can host subgoal verify steps. The canonical
home is the `execution` gate of the built-in `parent` workflow, but
nothing prevents a `feature` goal from hosting a subgoal step on its
`implementation` gate if a slice deserves its own design-doc cycle.

### Step shape

```yaml
- name: v0.1 — schema + persistence
  type: subgoal
  phase: 1
  subgoal:
    title: "v0.1 — schema + persistence"
    spec: |
      ## Covers
      - JSON Schema validation runs at write time
      - Memories persist to disk across restart
      ...
    workflowId: feature
    suggestedRole: coder
    planId: 01HZ8K7QF8JJVR2Q1J7EXAMPLE
```

### Idempotency via `planId`

`planId` is a stable ULID generated by the planner. The harness records
the spawned `childGoalId` against this `planId` on the gate's verification
record. If the harness is re-entered (e.g. after a server restart), it
**re-binds** to the existing child instead of spawning a new one.

If you re-plan and the same logical step appears again, **keep the same
`planId`** — the existing in-flight child stays attached. Generate a new
`planId` only when you genuinely want a fresh child.

### Concurrency cap

Subgoal steps with the same `phase` run in parallel, bounded by the
**root goal's** `maxConcurrentChildren` (default 3, max 8). The cap is a
single semaphore keyed by `rootGoalId` — every child of every depth in
the tree shares it. In v1, sub-goals' own `maxConcurrentChildren` values
are silently ignored; only the root counts.

> See `docs/design/nested-goals.md` §2 for the schema, §2.4 for the
> semaphore wiring, and §2.5 for the idempotency record.

---

## 5. The `parent` workflow

Pick `Parent Goal` from the workflow picker in the New Goal dialog when
the work decomposes into independently shippable units.

Gates:

```
charter ──► plan-review ──► goal-plan ──► execution ──► integration ──► ready-to-merge
```

| Gate | Owner | What it does |
|---|---|---|
| `charter` | team-lead | Drafts outcome + acceptance criteria + decomposition sketch. LLM-reviewed for completeness. |
| `plan-review` | team-lead | Plan proposed via `goal_plan_propose`. Two LLM reviewers check DAG correctness and acceptance-criteria coverage. |
| `goal-plan` | **human** | Manual gate. Signalling it **freezes** the `execution` gate's `verify[]` — further plan changes go through the mutation classifier. |
| `execution` | harness | The plan. Each `verify[]` entry is a `subgoal` step. Children spawn in `phase` order, parallel within a phase up to the cap. |
| `integration` | harness | Build / typecheck / unit / E2E / code-review on the parent's post-merge tip. |
| `ready-to-merge` | harness | Pushes the root's branch and raises the PR to `master`. |

The `goal-plan` gate is `manual: true` — it has no `verify[]`. A human
clicks "Approve plan" in the dashboard's Plan tab, which signals the
gate and snapshots the `execution.verify[]` as the frozen plan.

Other workflows can embed subgoal steps too — the `parent` workflow is
just the convenient template.

---

## 6. Mutation classification & divergence policy

Once `goal-plan` is signalled, the plan is **frozen**. Further changes —
new `goal_plan_propose` calls, new `goal_spawn_child` invocations,
dashboard edits via `PATCH /api/goals/:id/plan` — go through the
**mutation classifier**.

### 6.1 The four classes

The classifier diffs the proposed `verify[]` against the frozen one and
returns one of:

| Class | What it means |
|---|---|
| `noop` | No effective change. |
| `fix-up` | Adds a leaf subgoal at an existing phase, no dep changes. The cheap, common case — "the team-lead noticed one more small slice while building". |
| `expansion` | Adds a new top-level branch (a phase that didn't exist), or introduces new dependencies. Larger structural change. |
| `restructure` | Removes nodes, or changes existing dependencies. Most disruptive — invalidates in-flight work. |
| `criteria-drop` | Would leave one of the **root** goal's acceptance criteria uncovered after the change. Unconditional reject. |

### 6.2 Decision matrix (binding)

This table is the binding policy. **Expansion always prompts the user
under every policy** (including `autonomous`). The only class that ever
auto-approves is `fix-up`. `criteria-drop` is unconditionally rejected.

| classifier output | `divergencePolicy: strict` | `balanced` | `autonomous` |
|---|---|---|---|
| `noop` | allow | allow | allow |
| `fix-up` | prompt user | **auto-approve** | **auto-approve** |
| `expansion` | prompt user | prompt user | prompt user (with WS notification) |
| `restructure` | reject 409 unless `goal.paused`, then prompt user | prompt user | prompt user |
| `criteria-drop` | reject 409 (no policy override) | reject 409 (no policy override) | reject 409 (no policy override) |

Cell-by-cell notes:

- **`fix-up` under `balanced`/`autonomous`** — applies immediately. The
  team-lead never blocks waiting on the user for small additions.
- **`expansion` under `autonomous`** — still prompts the user, but the
  prompt is accompanied by a WebSocket notification so an
  autonomous-mode operator sees it without having to sit on the
  dashboard tab. Do not assume autonomous lets you skip user approval.
- **`restructure` under `strict`** — rejected with `409 {error:
  "restructure-requires-pause"}` until you pause the goal. Once paused,
  the next attempt prompts the user.
- **`criteria-drop`** — no escalation flow can unblock this. The
  team-lead must restructure the proposal so coverage is preserved or
  surface the conflict to you so the root spec can be amended.

### 6.3 The replan cap

`replanCount` ticks up every successful post-freeze mutation. At
`> 5`, the goal **auto-pauses** for human review. Resume the goal
manually if more replans are warranted.

### 6.4 The "criteria-drop" gotcha — quote criteria verbatim

The criteria-coverage check uses **whitespace-normalised, case-insensitive
substring matching** against the union of the root spec and the remaining
subgoal step specs. Hashing wouldn't help — it would fail the moment the
team-lead paraphrases.

When you (or the team-lead) draft a subgoal spec, **copy the exact wording**
of every acceptance criterion that subgoal is responsible for, at least
once, somewhere in the spec body. A `## Covers` heading is a cheap
convention:

```markdown
## Covers
- JSON Schema validation runs at write time
- Memories persist to disk across restart
```

A paraphrase that drops a key noun phrase can register as `criteria-drop`
even when the work plainly covers the criterion.

> See `docs/design/nested-goals.md` §4 for the classifier algorithm,
> §4.2 for the substring-match implementation, §4.3 for the binding
> matrix, and §10.5 for the dashboard banner UX.

---

## 7. Custom workflows + roles

Workflows and roles use the same resolution cascade. From most-specific
to most-general:

1. **The goal's own `inlineWorkflow` / `inlineRoles[name]`** — pasted in
   the New Goal dialog and snapshotted onto the goal at creation.
2. **Ancestor walk** — each ancestor's inline definitions, root → leaf.
3. **Project config** — `.bobbit/config/workflows/*.yaml` and
   `.bobbit/config/roles/*.yaml`.
4. **Server config** — `.bobbit/state/workflows/` and `.bobbit/state/roles/`.
5. **Built-in defaults**.

Once a goal is created, its snapshotted workflow is the **source of
truth** for its own runtime verification. The resolver only fires for:

- Newly-created **child** goals (when the user doesn't paste an inline
  override, the resolver walks the ancestor chain so children inherit
  the parent's customisation by default).
- Spawned reviewer / QA sub-sessions that need a Role definition.

### Pasting custom YAML in the New Goal dialog

The New Goal dialog has an **Advanced** disclosure (collapsed by
default) with two textareas:

- **Inline workflow YAML** — full workflow definition. Validated server-side
  against `workflow-validator.ts`; a 400 with diagnostics is returned on
  bad input.
- **Inline roles YAML** — a map of `name → roleYaml`. Same validation pattern.

The Advanced disclosure also exposes:

- **Divergence policy** (radio: strict / balanced / autonomous).
- **Max concurrent children** (slider 1–8, default 3).

> See `docs/design/nested-goals.md` §7 for the resolver shape and §10.4
> for the dialog wiring.

---

## 8. Recovery scenarios

### 8.1 Pausing a goal

`POST /api/goals/:id/pause` sets `goal.paused = true`. While paused:

- The verification harness skips ticks for any signal under that goal.
- `goal_spawn_child` and `goal_plan_propose` may apply `restructure`
  mutations under `strict` policy (the reject-409 is gated on
  `paused === false`).
- All in-flight child verifications continue running — pause halts
  *new* harness work, not work already in progress.

`POST /api/goals/:id/resume` flips it back. The team-lead receives a
`goal_resumed` WS event and picks up where it left off.

Pausing the **root** of a tree pauses the whole tree. Pausing a mid-tree
goal pauses only that subtree — siblings and the root keep running.

### 8.2 Replan-cap auto-pause

If `replanCount > 5`, the server unconditionally returns
`409 {error: "replan-cap", replanCount: <n>}` for any further mutation.
The dashboard surfaces a "Pause goal" button that flips `paused = true`
and allows **one** further mutation, after which the cap blocks again.

This is the system telling you "the plan is churning — stop and
re-approve". Common causes:

- The root spec is ambiguous and the team-lead is iterating on
  interpretation.
- A criterion is poorly worded and keeps tripping `criteria-drop`.
- An external dependency surfaced a new requirement.

### 8.3 Merge conflicts

If `goal_merge_child` hits a conflict, the harness:

1. Aborts the merge (`git merge --abort`) so the parent worktree stays
   clean.
2. Marks the child goal `state = "complete"` but the merge as failed.
3. Broadcasts `goal_merge_conflict { parentGoalId, childGoalId, output }`.
4. Notifies the team-lead.

The team-lead is **never** allowed to auto-resolve conflicts. Default
recovery is to escalate to the user (via `ask_user_choices`). The user
can either resolve the conflict by hand in the parent worktree and
manually re-attempt the integrate step, or open a `bug-fix` subgoal
that produces a reconciliation commit.

### 8.4 Sandbox limitation (v1)

Sandboxed projects (`sandbox: docker` in `project.yaml`) currently
support **non-nested** goals only — the project sandbox creates
worktrees inside the container off the project's primary branch, which
loses the parent's commits.

Behaviour for sandboxed parent goals attempting to spawn sandboxed
children:

- **Supported path** (after the sandbox bump tracked as Phase 2 work):
  the container-internal worktree branches off `parent.branch` and
  merges cleanly.
- **Hard-error path** (until that lands): child creation fails with
  `400 { error: "sandboxed nested goals require sandbox bump" }`.

If you hit the hard-error path, drop the child to host-side execution
(toggle the **Sandboxed** checkbox in the New Goal dialog) until the
fix lands.

> See `docs/design/nested-goals.md` §13.2 for the full set of known
> risks and gaps.

---

## 9. Worked example — agent-memory v0.1 → v1.0

The canonical end-to-end walkthrough. Concrete enough to follow without
opening internals docs.

### 9.1 Goal creation

You paste the contents of `agent-memory/SPEC.md` into the New Goal
dialog. The spec is ~12,000 chars, mentions v0.1, v0.2, and v1.0, and
lists 11 acceptance criteria.

The goal-assistant detects multi-phase shape (the heuristic looks for
versioned headings, "phases", "milestones") and suggests the **Parent
Goal** workflow with a one-line rationale. You accept.

The dialog opens with:

- Workflow: `Parent Goal`
- Divergence policy: `balanced` (you bump it from the default `strict`
  so the team-lead can land fix-ups without prompting you for each one).
- Max concurrent children: `3`.

The goal is created with branch `goal/agent-memo-XXXXX` off
`origin/master`.

### 9.2 Charter

The team-lead reads the spec, drafts a charter:

```markdown
# Charter

## Outcome
Ship agent-memory from v0.1 schema-only through v1.0 production hardening.

## Acceptance criteria
- JSON Schema validation runs at write time
- Memories persist to disk across restart
- Recall API returns top-K by recency
- Semantic similarity scoring uses embeddings
- ... (8 more)

## Decomposition sketch
Four child goals, one per version: v0.1 (schema + persistence),
v0.2 (recall API), v0.3 (semantic similarity), v1.0 (production hardening).
v0.2 and v0.3 are independent and can land in either order.
```

The team-lead signals `charter`. The LLM reviewer passes.

### 9.3 Plan proposal

The team-lead calls `goal_plan_propose` with a four-node plan:

```json
[
  { "planId": "01HZ001", "phase": 1, "subgoal": {
      "title": "v0.1 — schema + persistence",
      "workflowId": "feature",
      "spec": "## Covers\n- JSON Schema validation runs at write time\n- Memories persist to disk across restart\n..."
    }
  },
  { "planId": "01HZ002", "phase": 2, "subgoal": {
      "title": "v0.2 — recall API",
      "workflowId": "feature",
      "spec": "## Covers\n- Recall API returns top-K by recency\n..."
    }
  },
  { "planId": "01HZ003", "phase": 2, "subgoal": {
      "title": "v0.3 — semantic similarity",
      "workflowId": "feature",
      "spec": "## Covers\n- Semantic similarity scoring uses embeddings\n..."
    }
  },
  { "planId": "01HZ004", "phase": 3, "subgoal": {
      "title": "v1.0 — production hardening",
      "workflowId": "feature",
      "spec": "## Covers\n- ...\n"
    }
  }
]
```

The team-lead signals `plan-review`. Both LLM reviewers (DAG correctness
and spec completeness) pass.

### 9.4 Plan approval

You open the goal dashboard's **Plan** tab. It renders three columns
(phase 1 / phase 2 / phase 3), one card per planned subgoal. The phase-2
column has two cards stacked vertically.

You expand the v0.3 card, tweak its spec slightly to clarify the
embedding model, and click **Approve plan**. This signals `goal-plan`,
which freezes `execution.verify[]`. The dashboard banner reads:

> Plan frozen. Mutations now classified by divergence policy: balanced.

### 9.5 Phase 1 execution — v0.1

The harness starts processing the `execution` gate's `verify[]` in
phase order.

- **Phase 1** has one node — concurrency cap of 3 isn't binding.
- The harness calls `GoalManager.createGoal({ parentGoalId, baseBranch:
  parent.branch, ... })`. Branch `goal/v0-1-XXXXX` is created off the
  current tip of `goal/agent-memo-XXXXX`.
- The child team-lead receives the **child stanza** in its system
  prompt: "you are part of `agent-memory`; merges into parent, no PR
  to master".
- v0.1 runs the standard `feature` workflow (charter → design-doc →
  implementation → review → ready-to-merge).
- When v0.1's `ready-to-merge` would normally raise a PR, the harness
  detects `mergeTarget === "parent"` and **short-circuits**: the gate
  passes with a single synthetic step "Child goal — merge handled by
  parent." No remote PR is raised.
- The parent's harness loop then runs `mergeChildBranchLocal` to merge
  `goal/v0-1-XXXXX` into `goal/agent-memo-XXXXX`. The merge succeeds.
  The parent branch is pushed to origin (gated by
  `shouldSkipRemotePush()`).

The Plan tab's v0.1 card flips green.

### 9.6 Phase 2 execution — v0.2 and v0.3 in parallel

Phase 2 has two nodes. Both within the cap of 3 → both spawn
concurrently. Critically, **both branch off the post-merge parent tip**
— their worktrees see v0.1's commits.

- v0.2 runs the `feature` workflow on `goal/v0-2-XXXXX`.
- v0.3 runs the `feature` workflow on `goal/v0-3-XXXXX`.

Halfway through, v0.3's team-lead notices semantic similarity has four
sub-deliverables: tokeniser, embedding store, similarity scorer, recall
ranking integration. It calls `goal_spawn_child` four times. Now we have
a 3-level tree:

```
agent-memory (root)
├── v0.1 (merged)
├── v0.2 (in progress)
└── v0.3 (in progress)
    ├── tokeniser (in progress)
    ├── embedding-store (in progress)
    ├── similarity-scorer (queued — semaphore busy)
    └── recall-ranking (queued — semaphore busy)
```

The semaphore is keyed by **the root** (`agent-memory`) — so the four
grandchildren of v0.3 share a slot pool with v0.2. With the cap at 3 and
v0.2 + 2 grandchildren running, the third and fourth grandchildren
queue.

### 9.7 Merges

Grandchildren merge into v0.3 as they complete. v0.2 finishes and
merges into the root. v0.3 finishes (after its grandchildren) and merges
into the root.

The merge sequence:

```
t=0   v0.1 merges into root.    parent tip advances.
t=1   v0.2 + v0.3 spawn off advanced tip.
t=2   v0.3.tokeniser merges into v0.3.
t=3   v0.3.embedding-store merges into v0.3.
t=4   v0.3.similarity-scorer merges into v0.3.
t=5   v0.3.recall-ranking merges into v0.3.
t=6   v0.2 merges into root.    parent tip advances.
t=7   v0.3 merges into root.    parent tip advances.
```

Each merge fires `goal_merge_complete` over the WebSocket; the dashboard
animates the corresponding plan-tab card.

### 9.8 Phase 3 — v1.0

v1.0 spawns off the now-fully-integrated root tip. It sees v0.1, v0.2,
v0.3, and all of v0.3's grandchildren in its base branch — production
hardening operates on the integrated codebase. It runs `feature`,
finishes, merges into the root.

### 9.9 Integration

The root's `integration` gate runs build / typecheck / unit / E2E /
code-quality on the post-all-merges root branch. It catches one
cross-version bug — a missing migration step that v1.0's hardening
exposed.

The team-lead opens a **fix-up** child via `goal_spawn_child`. Under
`balanced` policy, fix-up auto-approves (no user prompt). The fix-up
child runs `feature`, merges into root.

The team-lead re-signals `integration`. It passes.

### 9.10 Ready-to-merge

The root's `ready-to-merge` gate raises **one** PR from
`goal/agent-memo-XXXXX` → `master`. The PR description summarises the
five children and the fix-up. Reviewers see the integrated diff.

When the PR lands, the dev server sees `master` advance after the next
`git pull origin master`. The whole tree archives together.

---

## 10. When to use a subgoal vs `team_spawn` vs `task_create`

Three decomposition primitives. Pick the right one.

### Decision rule

> **Use a `subgoal` verify step (or `goal_spawn_child`) when ALL of the
> following hold:**
>
> 1. The work has its own design intent (a meaningful unit a reviewer
>    would want to see in isolation).
> 2. It is independently reviewable (its own design-doc / implementation
>    / review cycle makes sense).
> 3. It merges meaningfully on its own (the parent branch is sensible
>    with this subgoal merged but its siblings still pending).
>
> **Use `team_spawn`** when the work is within one cohesive review
> cycle (e.g. a coder + a tester collaborating on the same change set).
>
> **Use `task_create`** when the work is a single tracked deliverable
> that doesn't need its own agent.
>
> **Default:** keep the decomposition you would have used before nested
> goals existed. Only reach for subgoals when the parent goal is
> genuinely a coordination layer over independently shippable units.
> Trust judgment — don't push toward subgoals in close-call situations.

This rule lives in code at the team-lead's mid-goal system-prompt
stanza, so every team-lead sees it on every spawn.

### One worked example per primitive

#### Example A — `task_create`: a single tracked TODO

The team-lead is mid-implementation. While reading the schema migration,
it notices the README still references the old field names. README
updates aren't blocking the implementation, don't need an agent of their
own, and aren't worth a subgoal — they're a single tracked deliverable
someone will pick up.

```ts
task_create({
  title: "Update README field-name references",
  type: "implementation",
  spec: "Replace `oldField` with `newField` in README.md sections 3, 5, 8.",
});
```

The task lives on the goal. A coder picks it up later. No new branch,
no new review cycle.

#### Example B — `team_spawn`: in-flight reviewer collaboration

The team-lead has just landed the implementation for the `recall API`
subgoal. The next step is a tester building a Playwright suite for the
new endpoint, plus a reviewer eyeballing the test design. Both work
within the **same** review cycle (the `feature` workflow's `review`
gate) and produce commits on the **same** branch as the
implementation.

```ts
team_spawn({
  role: "tester",
  task: "Write Playwright E2E tests for the new /recall endpoint covering top-K, recency tie-break, and empty-store cases.",
  workflowGateId: "review",
});
```

No new goal, no new worktree. The tester branches off the team-lead's
review-cycle branch and pushes back when done. The reviewer reads the
combined diff.

#### Example C — `subgoal`: an independently shippable v0.1

The team-lead of `agent-memory` decides v0.1 (schema + persistence)
deserves its own design-doc → implementation → review cycle. v0.1 must
land on the `agent-memory` parent branch as one merge commit, with its
own reviewer trail. Sibling slices (v0.2, v0.3) can land before v1.0
even if v0.1's debugging takes a few days.

```yaml
- name: v0.1 — schema + persistence
  type: subgoal
  phase: 1
  subgoal:
    title: "v0.1 — schema + persistence"
    workflowId: feature
    spec: |
      ## Covers
      - JSON Schema validation runs at write time
      - Memories persist to disk across restart
      ...
    planId: 01HZ001
```

Spawning happens automatically when the harness reaches phase 1 of the
parent's `execution` gate. The child has its own worktree, its own
design-doc gate, its own reviewer, its own `ready-to-merge`. Its merge
into the parent is one tidy commit on the parent branch.

### Quick comparison

| | `task_create` | `team_spawn` | `subgoal` |
|---|---|---|---|
| New branch? | No | No (reuses spawning agent's branch) | Yes |
| New worktree? | No | No | Yes |
| New review cycle? | No | No (joins current goal's review) | Yes |
| Default goal-overhead | None | One agent session | Full goal: charter, design-doc, impl, review, ready-to-merge |
| Best for | Tracked TODOs | Multi-role collaboration on one diff | Independently-shippable slices |

---

## 11. UI cheatsheet

### Sidebar

Goal rows nest team agents underneath. Child goals render as goal rows
indented under the parent goal row, recursively. Goals with children
get a count badge (`3/4` = 3 of 4 children complete).

Render depth is capped at 5; deeper trees collapse with a "Show N more
child goals…" button that opens the goal dashboard.

### Goal dashboard tabs

Standard tabs (`spec`, `agents`, `commits`, `gates`) plus, conditionally:

- **Plan** — DAG SVG laid out left-to-right by phase. Each card shows
  title, truncated spec, workflow, suggested role, and current child
  state (pending / running / passed / failed / needs-input). Edit mode
  is enabled before `goal-plan` is signalled, or any time the goal is
  paused.

  **Visibility**: the Plan tab renders if EITHER condition holds (per
  `shouldShowPlanTab(goal, goals?)` at `04977a18`):
  1. **Formal plan path**: the goal's workflow includes a `goal-plan`
     gate (e.g. the built-in `parent` workflow). The Plan tab shows
     the snapshotted `execution.verify[]` subgoal steps.
  2. **Living plan path** (added at `a993f838`): the goal has any
     non-archived children, regardless of workflow. The plan is
     synthesised from live children by `plan-synthesis.ts::buildPlanSteps`,
     clustering them into phases by `createdAt` timestamp gap (default
     60s window). Children spawned in the same turn cluster into one
     phase; sequentially-spawned children land in successive phases.

  Living-plan goals show "Living plan — reflects current children" in
  the status row (vs "Frozen" for approved formal plans). The synthesis
  recomputes from the live goals tree on every render, so the Plan tab
  is a living document — plan-evolution is automatic when children
  spawn / archive / state-change. Goals with a formal plan that ALSO
  spawn ad-hoc children via `goal_spawn_child` get the formal plan +
  orphan children appended to phases past the formal max phase.

- **Tasks** — standard task list (added at `04977a18`'s
  `shouldShowTasksTab` predicate). HIDDEN when the goal is plan- or
  children-driven AND has zero tasks (avoids redundant "Tasks (0)" next
  to a populated Plan tab); kept visible whenever taskCount > 0 even on
  parent goals (defensive against partial migration).
- **Children** — card list of children (live + archived together,
  matching the Agents tab's live + dismissed pattern at `04977a18`).
  Each card shows last verification verdict, live agent count, and an
  archived-status badge ("Merged" green for `archived && state ===
  complete` / "Archived" muted for non-complete). Click a card to
  navigate to that child's dashboard.

Child goal dashboards render a **← back to parent** breadcrumb showing
the chain of ancestors.

### Pending-mutation banner

When the classifier returns a prompt-required outcome (`expansion`
under any policy, `restructure`, `fix-up` under `strict`), the dashboard
shows a banner:

```
Plan mutation pending: <summary>
[Approve] [Reject]
[Details ▾]
  Classification: expansion
  Added: similarity-fallback-cache
  Removed: (none)
  Dropped criteria: (none)
```

Approve/Reject post to `POST /api/goals/:id/mutation/:requestId/decision`
with `{ decision: "approve" | "reject" }`. The server applies the
buffered mutation and broadcasts `goal_mutation_resolved`, unblocking
the team-lead.

The banner is **not** an `ask_user_choices` widget. `ask_user_choices`
is an agent-→user prompt that ends a calling agent's turn; plan
mutations are server-classified events fanned out via WebSocket to
every dashboard viewer with the **user** as the actor. The UX is
equivalent (structured choice → REST decision endpoint), but the wiring
matches the actual data flow.

> See `docs/design/nested-goals.md` §10 for the full UI design.

---

## 12. REST cheatsheet

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/goals` | Create a goal. Body accepts `parentGoalId`, `inlineWorkflow`, `inlineRoles`, `divergencePolicy`, `maxConcurrentChildren`. |
| `GET` | `/api/goals/:id?include=tree` | Goal + recursive descendants + per-goal gate states. |
| `GET` | `/api/goals/:id/plan?gateId=execution` | Narrow projection: the named gate's plan plus per-node child state. |
| `PATCH` | `/api/goals/:id/plan` | Replace named gate's `verify[]`. Body: `{ planSteps, gateId?, replanReason?, expectedReplanCount? }`. 409 on classifier reject, stale-plan, or replan-cap. |
| `POST` | `/api/goals/:id/spawn-child` | Idempotent on `planId`. Server-side classifier + policy. |
| `POST` | `/api/goals/:id/integrate-child/:childGoalId` | Local merge. 409 with `{conflict: true, output}` on merge conflict. |
| `POST` | `/api/goals/:id/mutation/:requestId/decision` | Resolve a pending mutation. Body: `{ decision: "approve" \| "reject" }`. |
| `POST` | `/api/goals/:id/pause` / `/resume` | Suspend / resume harness ticks. |
| `DELETE` | `/api/goals/:id?recursive=1` | Recursive archive. |

Standard 409 body shapes:

```ts
// Mutation rejection
{ error: "mutation-rejected", classification: "criteria-drop" | "restructure-requires-pause" | ..., droppedCriteria?: string[], addedNodes?: string[], removedNodes?: string[] }

// Stale plan (PATCH /plan with expectedReplanCount that no longer matches)
{ error: "stale-plan", currentReplanCount: number }

// Replan cap exceeded
{ error: "replan-cap", replanCount: number }
```

> See `docs/design/nested-goals.md` §8 for the full REST surface and
> §9 for WebSocket event payloads.

---

## 13. Tools the team-lead uses

The `Children` tool group ships with the following tools. By default,
`team-lead` is the only role with `allow` policy on the group;
`architect` and `spec-auditor` get per-tool `allow` overrides for the
three read-only tools (`goal_plan_status`, `goal_list_children`,
`goal_inspect_child`).

| Tool | Purpose |
|---|---|
| `goal_spawn_child` | Spawn a child goal under the current goal. Subject to the divergence policy when the plan is frozen. |
| `goal_plan_propose` | Replace the verify[] of a named gate (default `execution`) with a proposed list of subgoal steps. |
| `goal_plan_status` | Return the current plan plus live child-goal states. Cheap; call before proposing mutations. **Read-only.** |
| `goal_list_children` | Slim projection of immediate non-archived children (state, branch, gate status). Complements `goal_plan_status` when you don't need the full plan. **Read-only.** |
| `goal_inspect_child` | Inspect a child goal's gates from the parent session (BUG-13 fix at `27c0d08d`). Three modes: list all gates, gate detail, gate content / signal history. **Read-only.** Cross-goal reach: `gate_inspect` is scoped to the caller's own goal, this is the cross-goal version. |
| `goal_merge_child` | Locally merge a completed child's branch into the current goal's branch. Usually fired automatically (eager-merge IIFE on ready-to-merge bubble at `e39a5b53`); team-leads may call directly to retry after manual conflict resolution. Fails on conflict; the route auto-archives the child after a clean merge (`658f2da7`). |
| `goal_pause` | Suspend verification-harness ticks for this goal-tree. Required by `strict` before applying restructure mutations. |
| `goal_resume` | Resume verification-harness ticks. |
| `goal_set_policy` | Mutate `divergencePolicy` / `maxConcurrentChildren` on the current goal mid-flight (added at `9719b5c4`). Avoids the legacy "archive + recreate" workaround when the user wants to relax a policy on a running goal-tree. |
| `goal_decide_mutation` | Approve or reject a buffered plan mutation by `requestId` (added at `9719b5c4`). Server-side companion to the pending-mutation banner; resolves the buffered entry and broadcasts `goal_mutation_resolved` so the dashboard banner clears. |
| `goal_archive_child` | Archive a child (or descendant) goal record manually (added at `2f5f0f7d`). Use for zombie cleanup when interrupted spawns leave childless workflow shells, or when a manual `git merge` from the terminal pre-empted the four auto-archive paths. The single-repo branch ref is preserved (deferred to the 7-day session purge); multi-repo archives eagerly delete per-repo branches. |

> See `docs/design/nested-goals.md` §5 for the tool YAML and policy
> defaults, and §14 for the system-prompt stanzas that teach team-leads
> when to use each. The historical design doc lists the original six;
> the additional five were added during the PR #409 live-test cycle as
> documented in the AGENTS.md "Spawn a child goal" recipe and the
> debugging keyword index.

---

## 14. Further reading

- [`docs/design/nested-goals.md`](design/nested-goals.md) — full
  internals: data model, classifier algorithm, harness wiring, REST
  schemas, system-prompt stanzas, phase task breakdown, risks.
- [`docs/goals-workflows-tasks.md`](goals-workflows-tasks.md) — the
  underlying goal / workflow / gate model.
- [`docs/blocking-tools.md`](blocking-tools.md) — how
  `verification_result` fits into gate verification.
- [`docs/non-blocking-ask.md`](non-blocking-ask.md) — the
  `ask_user_choices` flow used for child merge-conflict escalation.
