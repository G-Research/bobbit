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
