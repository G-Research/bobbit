# Silent merge-loss audit — 2026-05-15

Branch under audit: `goal/audit-subg-225e4d3d` (and its sub-branches that have already merged in).
Audit run from: `goal-goal-toggle-ui--5ff55658-coder-c6d2a9fa` worktree.
Time-boxed: one working day (per goal spec). Anything not investigated to a verdict is listed under "follow-ups", not left implicit.

## Why this audit exists

Five separate silent regressions of the same bug-class landed on this branch
before they were spotted:

| Restoration commit | What was silently dropped | Time broken |
|---|---|---|
| `ea921d7b` | `tryHandleNestedGoalRoute` dispatch in `server.ts` | days |
| `43811c86` | `/api/lsp/:method` route block in `server.ts` | days |
| `415acda6` | `groupPolicyStore.setSubgoalsEnabledGetter` boot wiring | hours, multiple agents |
| `2c08b07e` | `/api/goals/:id/descendants` + `/api/goals/:id/tree-cost` routes | a full UI session |
| `a35d7f34` | Per-goal `Allow subgoals` + `Max depth` controls in proposal form | days |

In every case a merge-conflict resolution took one side wholesale and the
load-bearing wiring/UI inside the dropped hunk went unnoticed because CI
stayed green — no test referenced the dropped symbol. The fixes were
reactive; this audit is the one forward-looking sweep before we close the
loop with the regression-net (`tests/source-pin-merge-invariants.test.ts`)
and the role-guidance update in Part 3.

## Audit method

Per goal spec:

1. `git log --merges origin/master..HEAD --oneline` → 145 merge commits on
   the branch since divergence (most are tester/coder/test-engineer
   sub-branch fan-in; the load-bearing ones are the `Merge child goal
   branch …` entries).
2. For each known-good symbol/route/testid, confirm it exists on `HEAD`
   with `grep` / `lsp_workspace_symbol`.
3. For "suggested probes" from the goal spec, `git log -S` to look for
   added-then-deleted symbols with no replacement.
4. Anything dropped: restore from source commit, pin with a test, log
   below with verdict.

## Candidate matrix

Verdicts: `present` (exists on HEAD and pinned), `silently dropped` (was
restored as part of this audit), `not applicable` (probe returned nothing
suspect).

### Server route handlers — `src/server/server.ts`

| Symbol / route | Verdict | Evidence |
|---|---|---|
| `tryHandleNestedGoalRoute(` call site in `handleApiRoute` | present | confirmed by grep in `src/server/server.ts`; pinned by `source-pin-merge-invariants` |
| `/^\/api\/lsp\/([a-z_]+)$/` dispatch | present | confirmed by grep in `src/server/server.ts`; pinned |
| `/api/lsp/_internal/hint-emitted` POST handler | present | confirmed by grep in `src/server/server.ts`; covered by LSP loopback self-check |
| `/api/lsp/state` GET handler | present | confirmed by grep in `src/server/server.ts` |
| `/api/lsp/stats` GET handler | present | confirmed by grep in `src/server/server.ts` |
| `/^\/api\/goals\/([^/]+)\/descendants$/` GET | present | confirmed by grep in `src/server/server.ts`; pinned |
| `/^\/api\/goals\/([^/]+)\/tree-cost$/` GET | present | confirmed by grep in `src/server/server.ts`; pinned |
| `groupPolicyStore.setSubgoalsEnabledGetter(` boot call | present | confirmed by grep in `src/server/server.ts`; pinned (and also pinned by the older `tests/server-subgoals-getter-wired.test.ts`) |

### Proposal modal UI — `src/app/render.ts`

| Symbol | Verdict | Evidence |
|---|---|---|
| `data-testid="goal-form-subgoals-toggle"` | present | confirmed by grep in `src/app/render.ts`; pinned |
| `data-testid="goal-form-max-depth"` | present | confirmed by grep in `src/app/render.ts`; pinned |
| `_proposalSubgoalsAllowed` state | present | confirmed by grep in `src/app/render.ts` |
| `_proposalMaxNestingDepth` state | present | confirmed by grep in `src/app/render.ts` |
| `_goalSubgoalsAllowed` / `_goalMaxNestingDepth` chat-assistant state | present | shares `renderGoalForm` via `_proposalSubgoalsAllowed` / `_proposalMaxNestingDepth`; no separate state to lose |

Note: Part 1 of this goal restyles these controls to match the peer
toggle row. The data-testid strings are preserved by Part 1, so the
source pins above keep working through that change.

### Server event broadcasts

`broadcastToGoal` usage in `src/server/` (probe from goal spec):

| Call site | Verdict |
|---|---|
| Verification event broadcasts in `team-manager.ts` | present |
| `broadcastToGoal` definition + `teamManager.setBroadcastToGoal(broadcastToGoal)` wiring in `server.ts` | present |
| `verificationHarness` constructor injection in `server.ts` | present |

No silently-dropped broadcast types found — every `broadcastToGoal?.(`
call site has a corresponding definition and the wiring chain is intact.

### Sandbox / token wiring

`sandboxScope` references across `src/server/` (probe from goal spec):
20 hits, all wired through `handleApiRoute` and the LSP cwd-authorisation
guard (`src/server/lsp/authorize-cwd.ts`). The sandbox-guard module
references the field for image generation session-scope ownership. No
silent drops found.

### Tool YAML — `defaults/tools/`

Children-group tools that subgoals work depends on:

| Path | Verdict |
|---|---|
| `defaults/tools/children/goal_spawn_child.yaml` | present |
| `defaults/tools/children/goal_plan_propose.yaml` | present |
| `defaults/tools/children/goal_decide_mutation.yaml` | present |
| `defaults/tools/children/extension.ts` | present |
| `defaults/tools/proposals/propose_goal.yaml` | present (carries subgoals + max-depth fields) |

These were exercised end-to-end by the team-lead's own usage during the
parent audit branch — not a silent-drop candidate.

### Role YAML — `defaults/roles/`

All expected role files exist (`architect.yaml`, `code-reviewer.yaml`,
`coder.yaml`, `docs-writer.yaml`, `general.yaml`, `qa-tester.yaml`,
`reviewer.yaml`, `security-reviewer.yaml`, `spec-auditor.yaml`,
`team-lead.yaml`, `test-engineer.yaml`, `ux-designer.yaml`). The
"consistency" guidance already grep-positive in five of them, which is
exactly the surface Part 3 of this goal strengthens — not a regression.

### Subgoal-nesting limit / per-goal cap plumbing

Symbols still present on HEAD:

- `src/server/agent/subgoal-nesting-limit.ts::nestingDepth`
- `subgoal-nesting-limit.ts::maxNestingDepth` (system pref) and per-goal
  override
- `verification-harness.ts` consumer
- `nested-goal-routes.ts` consumer

No silent drops found in the nesting-limit path.

## New silent-merge-loss found during this audit

None. The five known regressions are all present on HEAD, the suggested
probes from the goal spec did not surface fresh drops, and spot-checking
of the high-traffic merge surfaces (broadcasts, sandbox scope, tool YAML,
role YAML) found everything intact.

If a future merge silently drops one of the pinned symbols, the
`tests/source-pin-merge-invariants.test.ts` suite will fail in CI with a
message naming the exact restoration commit to look at.

## Follow-ups (not blockers)

These are areas the audit touched but did not exhaustively walk. None
showed evidence of a current regression; logging them so the next audit
has a starting point.

- **WebSocket event-type catalogue.** `src/server/ws/` was not enumerated
  event-by-event. If a specific event type ever needs pinning, add it
  to the merge-invariants test alongside the existing pins.
- **Per-role tool surface.** Role YAML carries `tools:` and `tooling:`
  sections that have been touched by many merges. A diff against
  `origin/master` per-role would be the right next probe.
- **Verification harness contract.** `verification-harness.ts` is
  injected into many code paths; if a specific contract method ever
  silently disappears, pinning the exported method names would be the
  natural extension.

## Companion changes

- `tests/source-pin-merge-invariants.test.ts` — adds seven blunt
  source-pin tests, one for each previously-known silent regression
  (5 backend pins on `server.ts`, 2 UI pins on `render.ts`). Failure
  messages name the original-add / restoration commit and instruct
  future agents to restore the dropped block rather than delete the
  test.
- Part 3 of this goal (separate commit, separate sub-branch) updates
  the `ux-designer`, `reviewer`, and `code-reviewer` role prompts with
  explicit consistency checklists. Those changes are made because the
  Part 1 trigger — a UI control landing visually inconsistent with its
  peer toggles — showed the existing "Consistency is kindness" guidance
  was not sticking through review.

---

## Addendum — 2026-05-15: focused re-audit of merge `46e21256`

### Why this addendum exists

The original audit above (Part 2 of `goal/audit-subg-225e4d3d`) seeded
its probe list from the five then-known regressions and did **not**
enumerate the proposal-modal customisation surface. That methodology
gap let a sixth silent loss survive — confirmed below — and triggered
the `goal/proposal-modal-tabs` follow-up subgoal. This addendum
documents the focused re-audit of merge `46e21256` as specified by the
follow-up subgoal's design doc.

### Method

Spec called for two diffs:

1. `git diff 46e21256^1..d4be2150 -- src/app/ src/server/` (what the
   child branch intended to land).
2. `git diff 46e21256^1..46e21256 -- src/app/ src/server/` (what
   actually landed in the merge result).

Anything present in (1) but missing from (2) is a silent-loss
candidate.

**Limitation: `d4be2150` is not resolvable from this worktree.**

- `git cat-file -t d4be2150` → `fatal: Not a valid object name`.
- `git fetch --all` did not surface it. The original child branch
  `goal/plan-propo-d4be2150` appears to have been pruned after the
  merge; the object is presumably unreferenced.
- `46e21256`'s commit subject names `d4be2150` as the child tip, but
  `git show 46e21256 --format='%P'` reports parents
  `0ae9c6dc … 23b9c38b …`. Reading `c1d7a9e1 "Merge
  origin/goal/audit-subg-225e4d3d into goal/plan-propo-d4be2150"` and
  the commit-graph topology, the child-branch lineage is the **first**
  parent (`0ae9c6dc`), not the second. Parent ordering is inverted
  from the usual "merge X into HEAD" convention.

Given the missing object, this addendum substitutes `46e21256^1`
(== `0ae9c6dc`, the child-branch tip at merge time, which transitively
contains the `d4be2150` work via the c1d7a9e1 "merge audit-subg into
child" commit) for the spec's `d4be2150`. Diff (1) therefore collapses
to **the changes the child branch contributed that did not reach the
merge result**, computed as the set difference between (a) symbols
present at `46e21256^1` and (b) symbols present at `46e21256`. This is
strictly stronger than the literal spec because it also catches losses
from commits that landed on the child branch after `d4be2150` but
before the merge.

### Quantitative finding — `src/app/render.ts`

| Symbol | At `46e21256^1` (child tip) | At `46e21256` (merge result) | At `HEAD` |
|---|---:|---:|---:|
| `inlineWorkflowYaml` | **13** | 0 | 0 |
| `inlineRolesYaml` | **11** | 0 | 0 |
| `inlineWorkflow` (bare) | 27 | 0 | 0 |
| `inlineRoles` (bare) | 33 | 0 | 0 |
| `_proposalInlineWorkflow` | 21 | 0 | 0 |
| `_proposalInlineRoles` | 20 | 0 | 0 |

`git diff --stat 46e21256^1 46e21256 -- src/app/` reports `render.ts`
at **697 lines changed, -617 net** — the merge resolved the conflict
by taking the trunk side of `render.ts` wholesale. Every UI surface
tying the goal-proposal modal to inline workflow/role customisation
was dropped in a single hunk, and CI stayed green because no test
referenced any of the dropped symbols.

### Restoration choice

The follow-up subgoal explicitly chooses **not** to re-introduce the
old `<details>` + raw-YAML `<textarea>` UX, even though that is what
was literally dropped. User feedback on the regression rejected the
old UX as inconsistent with the rest of the app. The replacement is
the tabbed `Goal / Workflow / Roles` modal that reuses the main
Workflows and Roles page renderers. The behavioural contract is
preserved (operators can still inspect and customise workflow + roles
at proposal time); the surface is upgraded.

This is documented here so a future audit does not flag
"inlineWorkflowYaml still missing at HEAD" as a fresh regression — it
is intentionally not restored, superseded by the tabbed UX.

### Other candidates examined in the same merge

| File / symbol | Verdict | Evidence |
|---|---|---|
| `src/server/server.ts` `const inlineWorkflow = body?.workflow` block in `POST /api/goals` | present at HEAD | `git grep -n inlineWorkflow HEAD -- src/server/server.ts` shows lines 3987–3990; restored by `686ed9fd "Fix propose_goal silently dropping inlineWorkflow + inlineRoles"` after this same `46e21256` loss |
| `src/server/proposals/proposal-types.ts` carries `inlineWorkflow` / `inlineRoles` on the proposal payload type | present at HEAD | grep-confirmed |
| `src/server/agent/nested-goal-routes.ts` accepts `inlineWorkflow` / `inlineRoles` | present at HEAD | grep-confirmed |
| `src/server/agent/spawn-child-workflow.ts` consumes `inlineWorkflow` | present at HEAD | grep-confirmed |
| `src/server/agent/system-prompt.ts` / `team-manager.ts` / `verification-harness.ts` / `goal-manager.ts` / `goal-store.ts` / `resolve-role.ts` consume `inlineRoles` | present at HEAD | grep-confirmed |
| `src/app/settings-page.ts` (+63 lines in merge) | present at HEAD | unrelated to proposal-modal regression; functional |
| `src/app/api.ts` `createGoal` opts `workflow?: unknown` + `inlineRoles?: Record<string, unknown>` | present at HEAD | line 892, confirmed; **pinned** by this fix's new source-pins |
| `src/server/agent/project-assistant.ts` dynamic-import surface (called out in design doc) | present at HEAD | grep-confirmed; no further loss |
| `src/server/state-migration/seed-default-workflows.ts` (touched in merge) | present at HEAD | functional change, not a loss |

The **only** silently-dropped surface from `46e21256` still missing
from HEAD is the `src/app/render.ts` proposal-modal customisation UI
documented above. Every server-side counterpart was already restored
by `686ed9fd` (which the original audit missed because it was
grep-positive at HEAD — the original audit confirmed the server side
intact without realising the client side that *fed* those endpoints
was gone).

### New source-pins added

`tests/source-pin-merge-invariants.test.ts` now also pins:

1. `src/app/render.ts` contains `inlineWorkflow` (draft-scoped state).
2. `src/app/render.ts` contains `inlineRoles` (draft-scoped state).
3. `src/app/render.ts` contains `data-testid="goal-proposal-tab-workflow"`.
4. `src/app/render.ts` contains `data-testid="goal-proposal-tab-roles"`.
5. `src/app/api.ts::createGoal` opts declare `workflow?: …`.
6. `src/app/api.ts::createGoal` opts declare `inlineRoles?: …`.

Each failure message names regression commit `46e21256` and "this
proposal-modal-tabs fix" (the final commit hash will be filled in by
the team lead once the goal lands).

Pins (1)–(4) deliberately fail until the modal-integration agent
restores the proposal modal's Workflow/Roles tabs in `render.ts`. That
is the intended pre-implementation state: the pins are reporting the
regression they will defend against. Pins (5)–(6) already pass — the
wire surface in `api.ts` survived `46e21256` intact.

### Methodology fix for future audits

The original audit's probe list was seeded from known-restored
regressions. That class of probe will never surface a *new* silent
loss whose symbol is unique to the dropped hunk. Future audits must
additionally:

1. For every merge with a large net-deletion on a UI module (here:
   `render.ts` lost 617 net lines in a single merge), enumerate the
   distinct symbols present on each parent and diff the sets, not just
   the line counts.
2. For every server-side wire field (`inlineWorkflow`, `inlineRoles`,
   any new `propose_*` payload field), require a paired UI consumer
   pin. A wire field with no UI consumer is itself a silent-loss
   signal.

These rules are noted here for the next audit owner; they are not yet
codified as tooling.
