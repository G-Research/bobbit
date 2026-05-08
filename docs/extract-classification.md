# Generic-fix extraction classification

Branch: `origin/goal/audit-subg-225e4d3d` vs `origin/master` (138 non-merge commits, plus a final 139th HEAD commit on the branch tip — 138 distinct extractable commits).

Goal: identify which commits are subgoals-independent so they can be cherry-picked into a separate, smaller PR. Liberal-toward-generic when ambiguous.

## Counts

- **Total**: 138
- **Generic (G)**: 27
- **Subgoals (S)**: 105
- **Mixed (M)**: 6

## Classification table

| sha (short) | category | rationale |
|-------------|----------|-----------|
| 84bbe4ff | G | Make repo-scan + isSafeRelPath OS-agnostic — pure infra fix to `repo-scan.ts` / `project-config-store.ts`, no subgoals coupling |
| 16a43c73 | S | Phase 1: nested-goal fields on PersistedGoal (rootGoalId/mergeTarget) + lazy migration |
| 9f940f5a | S | Phase 1: auto-derive rootGoalId / mergeTarget + cycle prevention |
| 1c82e34e | G | Restart-interrupt suppression + context-rich reminders — verification-harness reliability, applies to all goals |
| bd142376 | S | Phase 1: wires workflowStore into per-project GoalManager — workflow-store hard requirement was driven by subgoal parent-workflow plumbing; tests are nested-goal-shaped |
| 08f6d1fd | G | Pure helper `parse-acceptance-criteria.ts` + tests — standalone shared module, no subgoals dependency |
| 68e89a15 | G | Auto-revive dead RPC bridges + auto-archive zombie sessions — session-manager resilience, applies to all sessions |
| 939f8969 | S | Phase 1 docs — nested-goal data model |
| 2f924671 | G | Boot-time hardening — crash-loop guard, orphan team-store sweep, zombie sweep, sessionless respawn (team-manager + harness). Applies to any team, not subgoal-specific |
| ee6e7601 | M | Paused-child exclusion is subgoals; `waitForStreaming` helper + reviewer `kind` field are generic team-manager improvements |
| 09cb9898 | S | Phase 7 transient handoff notes (later deleted) — subgoals-internal |
| deef3166 | S | `mergeChildBranchLocal` helper — exists solely to local-merge child branches into parent for subgoals |
| abd70a2f | S | Pure helper `sidebar-nesting.ts` — nested-goal sidebar forest |
| d55b8c2f | S | Pure tab-visibility predicates for goal dashboard (Plan/Children tabs) |
| 6f5e1dcf | S | `plan-synthesis.ts` — synthesises living plan from live children |
| 45cb5414 | S | `plan-node-state.ts` — tier preference for plan nodes |
| 7480bb0d | S | Plan-tab DAG SVG edge-path layout |
| b805d003 | S | Phase 5a transient handoff notes |
| 70297f76 | S | `GoalManager.mergeChild` + `archiveGoalAfterMerge` + child base-branch derivation |
| 72a7d1f4 | S | Subgoal verify-step type + parent meta-workflow seeding |
| 1a0c6cb1 | S | `runSubgoalStep` + `resolvePlanStepChild` + concurrency cap (verification-harness) |
| b2f7127c | S | Refactor goal-plan freeze hook — parent-workflow plumbing |
| f48ad9b9 | S | Tests for runSubgoalStep + parent workflow + concurrency |
| b46d6006 | S | Phase 3 transient handoff notes |
| b9c045e5 | S | Nested-goals system-prompt stanzas (A/B/C) + team-lead pointer |
| fb08867b | M | `notify-team-lead-failure.ts` is generic verification-failure notification (works for any team-led goal); but tests are tied to nested-goal parent-notification scenarios |
| eda21607 | S | Tree-cost rollup over goal subtree + `/api/goals/:id/tree-cost` |
| 76a7b0ec | S | Phase 6 transient handoff notes |
| 3c0d80a0 | S | `classifyMutation` + `PlanMutationStore` — plan-mutation classifier |
| 638c3fd1 | S | Children tool group + per-role policies for child tools |
| 79175767 | S | REST endpoints for nested-goal lifecycle |
| 6e2d147a | S | Sidebar nested-goal rendering via buildNestedGoalForest |
| f6326403 | S | Goal dashboard Plan + Children tabs, breadcrumb, tree cost |
| b54446fc | S | Cascade-confirmation dialogs (archive / pause / resume) |
| 61f5ea30 | S | WS event subscriptions + mutation card + inline workflow YAML |
| 498acbca | S | Phase 5b tests — cascade-dialog, mutation-card, sidebar render-glue |
| d4727577 | S | Phase 5b E2E — sidebar nesting, plan tab, cascade dialogs, breadcrumb, tree cost |
| 1989791b | S | Phase 5b transient handoff notes |
| 2b677365 | M | "Persist projectId on goal record at createGoal" — small generic fix to `goal-manager.ts`, but came up in subgoals work; should pick clean |
| 80d05a57 | S | `docs/nested-goals.md` user-facing reference |
| de029219 | S | Extend verify-step types with subgoal in `goals-workflows-tasks.md` |
| 4a9f6177 | S | Collate nested-goals recipes + Lesson 4.x debugging entries into AGENTS.md |
| 7c6fc080 | S | Delete transient `_phase-*-notes.md` |
| 39d8fed7 | G | Goal creation 400s on projects with no workflows seeded — generic auto-seed bugfix in `server.ts` (touches goal creation, not subgoals) |
| 0f7e6a64 | S | Spawn-child setup + plan-propose gate detection + UI badge — entirely subgoals |
| 121472c4 | S | Preserve goal hierarchy in archived sidebar view |
| bf8ec37b | S | Plan tab: default to expanded sub-plans |
| badb23f4 | S | Update sidebar-nesting test for inline-pill badge format |
| 86ff973b | S | Children-tab status fix |
| ce9d8665 | S | Plan tab: badge count, leaf chevrons, "No sub-plan" noise |
| 7491041c | S | Plan-tab/synthesis fixes + auto-spawn fallback + suggestedRole wiring |
| 2d394f8e | S | Cascade-stop teams: parent's "Stop Team" tears down children's teams |
| 42dbfbf3 | S | Plan tab edge routing through inter-phase gap |
| a70a6bb5 | S | Eagerly mark goals archived in client state — touches archive flow but the cascade/descendant code paths are subgoal-shaped |
| b3755a3d | S | Fix archive 409 when descendants are already archived — descendants = subgoals |
| 12ab04dd | M | Sidebar collapse-hides-children is subgoals; FlexSearch boot self-heal in `flex-store.ts` is generic search-index resilience |
| 9a20ae05 | S | Archived sidebar forest collapse-hides-children |
| 00d6805f | S | Sub-goals nest under spawning team-lead session |
| 9837fb38 | S | Backfill spawnedBySessionId on legacy sub-goals at boot |
| fbf5fdca | S | Sub-goal session-attribution: archived sub-goals + archived team-leads |
| e5d8882b | S | Test + doc coverage backfill for nested-goals work |
| 9e22babd | G | Clarify proposal-tool docs (workflows + custom roles via propose_project / propose_role) — touches mention of `inlineRoles` etc. but is broadly applicable proposal-tool YAML doc clarification |
| 36f527dc | G | Render role/tool/staff proposals in unified panel for non-assistant sessions — broadly applicable proposal-panel UX |
| c98e0a09 | G | Reset `.goal-preview-panel` sizing when nested inside the unified panel — pure CSS fix, follow-up to 36f527dc |
| 0082a824 | G | Notify proposing agent when user accepts a goal/project/role/staff proposal — generic proposal-acceptance notification |
| a44b7229 | S | Ephemeral roles snapshotted onto goals (parallel to inline workflows) — feature is on goal-store, but heavily wired into nested-goals (children inherit inline roles); listed as subgoals to keep PR clean |
| f9329a51 | S | Fix propose_goal silently dropping inlineWorkflow + inlineRoles — same scope as a44b7229 |
| c4d18002 | S | Goal proposal panel UX: inline workflow + roles consistency — same lineage |
| c6525ac7 | S | Goal proposal panel: workflow row + drop role-row preview — same lineage |
| b8d572ea | S | Fix four nested-goal regressions exposed by user testing |
| fe259879 | S | Improve cascade-confirmation dialog readability |
| 8e532d9c | S | Update agent docs for workflow-inheritance + gate-init fix |
| 8c55042e | S | Sidebar nesting cycle guard + dedupe + stable sort for spawnedChildren |
| 2ebcb172 | S | Extract sidebar spawned-children helpers + tests |
| 9969f9bd | S | Sidebar nesting (live + archived): cycle guard / dedupe / sort at shared helper |
| e9f4bdfb | S | Archived sidebar forest: filter goals already shown under team-lead |
| a6070c56 | G | Goal-create: fall back to active session's projectId when previewProjectId is empty — small generic UX fix in render.ts goal-create flow |
| a2b15404 | S | Notify parent's team-lead when child's ready-to-merge gate passes |
| cee886da | S | Audit + close two more parent-notification gaps |
| 907e79c2 | M | Three nudge / archive / worker-visibility fixes — partly subgoals-shaped (cascade nudge), partly generic team-extension fixes |
| 8c5e770a | S | Stamp teamLeadSessionId on reviewer/QA sessions + sidebar fallback — drives sub-goal session attribution |
| b8456623 | S | Fix nested-goal inheritance, plan-tab pollution, and team-lead guidance |
| 135ce996 | S | Add retro-audit design doc for subgoals branch |
| 05b5b28f | G | Subgoals retro-audit: `process.execPath` at all node-spawn sites + comment fix — pure infra hardening (rpc-bridge, harness, server.ts, watchdog), trivially applies to master |
| 8526b52b | S | Add subgoals branch review findings (design doc) |
| a50bcce4 | S | Remediate review findings R-007/R-010/...; touches AGENTS.md but body is subgoals-fix work |
| 935d6be5 | S | Subgoals review: REST + UI remediation R-004..R-042 |
| 06c0eb9a | S | Subgoals review remediation: harness + verification — `spawn-child-workflow.ts` etc. |
| 0ce7f8e2 | G | E2E project registration on symlinked tmpdir (`acceptCanonical: true`) — pure test-infra fix |
| 6a5d57f7 | M | "Fix 9 pre-existing E2E failures inherited from subgoals branch" — `tests/e2e/ui/sidebar-nesting.spec.ts` is subgoals; the other E2E fixes (sidebar-archived-per-project, tail-chat-jump-button-false-positive, `src/app/api.ts`) are generic |
| edd54673 | G | More E2E test fixes — symlink/canonical/test-helper polish across `add-project-flow`, `mock-agent-core`, `transcript-api`, `cascade-archive`, `project-assistant`, `proposal-spec-survives-navigate` |
| f45bbe19 | G | E2E project-canonical and cascade-required regressions — test-only fixes |
| ff690ef2 | G | Last 3 E2E cascade/canonicalize regressions — test-only |
| 6cfaf771 | S | Docs update for subgoals retro-audit remediation |
| 093ced04 | S | Docs reconcile auto-seed contract + REST API for nested-goal endpoints |
| c26d4ab3 | S | Design: subgoals (experimental) toggle |
| e00f6269 | G | Loopback-normalise gateway-url for wildcard binds — pure CLI/networking fix |
| 638b8320 | G | Document gateway-url loopback normalisation — docs follow-up to e00f6269 |
| d2fe06f7 | S | Replace plan-DAG createdAt heuristic with explicit dependsOn — plan-tab/spawn-child feature |
| d9c283b3 | S | Subgoals (experimental) toggle implementation |
| 30483c31 | S | Drop residual createdAt-clustering reference in Plan tab section |
| 86d9de21 | S | Round out subgoals (experimental) toggle docs |
| 9a1f5de6 | S | Backfill dependsOn into reference tables and REST API docs |
| 7c4d4682 | S | Child ready-to-merge gate targets parent branch, skips PR — child-RTM is a subgoals feature |
| c928dc93 | S | Docs: child ready-to-merge auto-rewrite for child goals |
| fedfd92f | S | Dogfood log RTM smoke test entry |
| 624cf9e4 | S | Tree-cost row visibility when children archived |
| 469da694 | S | Docs: tree-cost row visibility data-driven |
| dfdb3f18 | S | Plan-tab DAG includes archived children |
| ffa71c67 | G | Notify team-lead when goal.spec edited mid-flight — generic goal-spec broadcast feature, not subgoals-only |
| 73f18ed8 | G | Tool extension fetch resilience: disk-first creds, retry on transient errors, 401 refresh — broadly applicable extension-shared infra |
| ef841090 | M | Design doc covers BOTH stuck-team watchdog (generic) and child-RTM hook (subgoals); single doc file |
| 4a3b6bff | S | Round out plan-tab archived-children docs |
| d4d09654 | G | Drop hardcoded sleeps in spec-edit-broadcast E2E — pure test cleanup |
| cfd0a9c1 | G | debugging.md update for disk-first creds + retry contract — docs follow-up to 73f18ed8 |
| 5723bf02 | M | Stuck-team watchdog (generic for any team) + child-RTM regression test (subgoals) in one commit |
| 18ec85ee | G | AGENTS.md recipe + debugging entry for goal-spec edit notification — docs follow-up to ffa71c67 |
| 93ffa741 | S | team-prompt accepts direct-child team-leads — subgoals tool-extension change |
| 62db6471 | S | Reliably stamp spawnedBySessionId via four-tier cascade |
| 171536bd | S | E2E header-vs-body precedence test for four-tier cascade |
| a775e088 | S | Docs: team_prompt accepts direct-child team-leads |
| d6b90323 | S | Docs: auto-nudge contract + stuck-team watchdog debugging entry — landed alongside subgoals docs but auto-nudge itself is generic; conservatively S because it's bundled |
| a58c1277 | S | Document spawnedBySessionId four-tier cascade |
| 3baf9584 | S | Trim AGENTS.md and replace Lesson N.M jargon with plain language — touches almost every subgoals-touched file's comments; cherry-picking would conflict heavily |
| 86e8c274 | S | Trim-source-diff catalogue (later deleted in 754d4a8a) — design doc for the trim work |
| d9421db7 | G | Active-before-archived sidebar ordering — generic sidebar-ordering UX (touches `render-helpers.ts` / `sidebar-nesting.ts` / `sidebar-spawned-children.ts`; nesting helpers are subgoals but the ordering policy applies independently) |
| 22df92bb | S | refactor(ui): shorten comments per trim catalogue (Task B) — comment-only, but spans `sidebar-nesting.ts` etc. |
| 83b59360 | S | Reconcile goal state on manual archive (children/extension.ts + mergedManually) |
| 1383a8a3 | S | refactor(server): shorten comments per trim catalogue (Task A) — touches goal-manager / plan-mutation / team-manager / verification-harness / workflow-store / server.ts; cherry-pick will conflict with extracted generic commits |
| b9d6fea2 | S | Fix E2E: spawn-child + toggle-click for nested archived render |
| 77b573da | S | Document mergedManually flag in REST/nested-goals refs |
| 3837c010 | S | refactor(ui): extract plan-tab + children-tab from goal-dashboard.ts |
| 0ab29837 | S | Drop waitForTimeout in sidebar-active-before-archived E2E |
| 2e11b2b2 | S | AGENTS.md recipes entry for sidebar active-before-archived ordering |
| b55876c3 | S | refactor(server): extract nested-goal-routes; gate flag-off polling |
| ec9da88c | S | Docs: file-location pointers + plan-tab/children-tab + flag-off polling recipe |
| 754d4a8a | S | Remove `docs/design/trim-source-diff.md` — paired with 86e8c274 |
| b79d5167 | S | Fix sidebar double-render of spawned children (live + mobile) |
| e6528d1e | S | Layer sidebar dedup docs |

## Mixed-commit split notes

- **`ee6e7601`** (Phase 7 paused-child + waitForStreaming + reviewer-kind):
  - Generic hunks: `team-manager-helpers.ts` `waitForStreaming` helper + `tests/wait-for-streaming.test.ts` + reviewer `kind` field (`team-agent-kind-field.test.ts`).
  - Subgoals hunks: `goal-store.ts` paused-child predicate + `any-in-flight-child-excludes-paused.test.ts`.
  - Strategy: `git cherry-pick -n ee6e7601 && git restore --staged --worktree -- src/server/agent/goal-store.ts tests/any-in-flight-child-excludes-paused.test.ts && git commit`.
- **`fb08867b`** (Phase 6 actionable verification-failure notifications):
  - Generic hunks: `notify-team-lead-failure.ts` core message-builder is goal-agnostic; the `verification-harness.ts` integration applies to any goal's verification path.
  - Subgoals hunks: parent-notification context inside the same file; tests assert nested-goal scenarios.
  - Strategy: cherry-pick whole, then on conflict re-apply only the generic helper + harness wiring; or skip entirely (it co-evolves with `notify-team-lead-child-passed.ts` in a2b15404 which is purely subgoals).
- **`2b677365`** (Persist projectId on goal record at createGoal):
  - Single 9-line addition to `goal-manager.ts::createGoal`. Reads as a generic durability fix but the field is heavily consumed by nested-goal lookup paths. Cherry-pick clean.
- **`12ab04dd`** (Sidebar collapse-hides-children + FlexSearch boot self-heal):
  - Generic hunk: `src/server/search/flex-store.ts` (+36 lines) — boot self-heal for FlexSearch.
  - Subgoals hunk: `src/app/sidebar.ts` collapse-hides-children behavior (+17 lines) on nested children.
  - Strategy: `git cherry-pick -n 12ab04dd && git restore --staged --worktree -- src/app/sidebar.ts && git commit`.
- **`907e79c2`** (Three nudge / archive / worker-visibility fixes):
  - Mixed across `defaults/tools/team/extension.ts` and `src/server/server.ts`. Worker-visibility is generic; cascade nudge is subgoals.
  - Strategy: skip — too small and tangled to be worth splitting; leave with subgoals PR.
- **`6a5d57f7`** (Fix 9 pre-existing E2E failures inherited from subgoals branch):
  - Generic hunks: `src/app/api.ts`, `tests/e2e/e2e-setup.ts`, `tests/e2e/ui/sidebar-archived-per-project.spec.ts`, `tests/e2e/ui/sidebar-mobile-archived-per-project.spec.ts`, `tests/e2e/ui/tail-chat-jump-button-false-positive.spec.ts`.
  - Subgoals hunk: `tests/e2e/ui/sidebar-nesting.spec.ts` (+27 lines).
  - Strategy: `git cherry-pick -n 6a5d57f7 && git restore --staged --worktree -- tests/e2e/ui/sidebar-nesting.spec.ts && git commit`.
- **`ef841090`** (Design doc auto-nudge stuck team-leads watchdog + child-RTM hook):
  - Single design doc covers both. Generic content (stuck-team watchdog) and subgoals content (child-RTM hook) interleaved. Easier to leave with subgoals PR, or to copy out only the watchdog section as a separate doc when extracting `5723bf02`.
- **`5723bf02`** (Stuck-team watchdog + child-RTM regression test):
  - Generic hunks: stuck-team watchdog in `team-manager.ts` + `team-manager-stuck-watchdog.test.ts`.
  - Subgoals hunk: `team-manager-child-rtm-notifies-parent.test.ts` (+115 lines).
  - Strategy: `git cherry-pick -n 5723bf02 && git restore --staged --worktree -- tests/team-manager-child-rtm-notifies-parent.test.ts && git commit`.

## Generic, cherry-pick clean

Reverse-log (chronological / oldest-first) order — pick in this order to minimise conflicts:

- `84bbe4ff` — Make repo-scan + isSafeRelPath OS-agnostic
- `1c82e34e` — Phase 7: restart-interrupt suppression + context-rich reminders
- `08f6d1fd` — Phase 1: Add src/shared/parse-acceptance-criteria.ts pure helper
- `68e89a15` — Phase 7: auto-revive dead RPC bridges + auto-archive zombie sessions
- `2f924671` — Phase 7: boot-time hardening — crash-loop, orphan store, zombie sweep, respawn
- `39d8fed7` — Fix: goal creation 400s on projects with no workflows seeded
- `9e22babd` — Clarify proposal-tool docs: workflows + custom roles via propose_project / propose_role
- `36f527dc` — Render role/tool/staff proposals in unified panel for non-assistant sessions
- `c98e0a09` — Reset .goal-preview-panel sizing when nested inside the unified panel
- `0082a824` — Notify proposing agent when user accepts a goal/project/role/staff proposal
- `a6070c56` — Goal-create: fall back to active session's projectId when previewProjectId is empty
- `05b5b28f` — Subgoals retro-audit: process.execPath at all node-spawn sites + comment fix
- `0ce7f8e2` — Fix E2E project registration on symlinked tmpdir (acceptCanonical:true)
- `edd54673` — Fix more E2E failures inherited / introduced by recent changes
- `f45bbe19` — Fix E2E project-canonical and cascade-required regressions
- `ff690ef2` — Fix last 3 E2E cascade/canonicalize regressions
- `e00f6269` — fix: loopback-normalise gateway-url for wildcard binds
- `638b8320` — docs: document gateway-url loopback normalisation for wildcard binds
- `ffa71c67` — feat: notify team-lead when goal.spec edited mid-flight
- `73f18ed8` — Tool extension fetch resilience: disk-first creds, retry on transient errors, 401 refresh
- `d4d09654` — test: drop hardcoded sleeps in spec-edit-broadcast E2E
- `cfd0a9c1` — docs: update debugging.md shared-helpers section for disk-first creds + retry contract
- `18ec85ee` — docs: AGENTS.md recipe + debugging entry for goal-spec edit notification
- `d9421db7` — Active-before-archived sidebar ordering

## Mixed, needs splitting

- `ee6e7601` — Phase 7: paused-child exclusion + waitForStreaming + reviewer kind tests
  - Strategy: `cherry-pick -n` then `git restore` the goal-store.ts paused-child hunk + `any-in-flight-child-excludes-paused.test.ts`.
- `fb08867b` — Phase 6: actionable verification-failure notifications
  - Strategy: easiest to leave with subgoals — the message helper co-evolves with parent-notification call sites in `a2b15404`/`cee886da` which are pure subgoals.
- `2b677365` — Persist projectId on goal record at createGoal
  - Strategy: cherry-pick clean as a one-line generic durability fix (functionally generic even though motivated by subgoals).
- `12ab04dd` — Sidebar: collapse hides nested children + FlexSearch boot self-heal
  - Strategy: `cherry-pick -n` then restore `src/app/sidebar.ts` to keep only `flex-store.ts`.
- `6a5d57f7` — Fix 9 pre-existing E2E failures inherited from subgoals branch
  - Strategy: `cherry-pick -n` then restore `tests/e2e/ui/sidebar-nesting.spec.ts`.
- `5723bf02` — feat(team-manager): stuck-team watchdog + child-RTM regression test
  - Strategy: `cherry-pick -n` then restore `tests/team-manager-child-rtm-notifies-parent.test.ts`.

## Subgoals — leave behind

Total: **105**. Representative SHAs:

- `16a43c73` — Phase 1: Add nested-goal fields to PersistedGoal with lazy migration
- `9f940f5a` — Phase 1: Auto-derive rootGoalId / mergeTarget + cycle prevention
- `bd142376` — Phase 1: Lesson 4.3 — fail-loud + wire workflowStore into per-project GoalManager
- `939f8969` — Phase 1: Document nested-goal data model
- `deef3166` — Phase 2: mergeChildBranchLocal helper in skills/git.ts
- `70297f76` — Phase 2: GoalManager.mergeChild + archiveGoalAfterMerge + child base-branch
- `72a7d1f4` — Phase 3: subgoal verify-step type + parent meta-workflow
- `1a0c6cb1` — Phase 3: runSubgoalStep + resolvePlanStepChild + concurrency cap
- `b2f7127c` — Phase 3: refactor goal-plan freeze hook into pure helper
- `f48ad9b9` — Phase 3: tests for runSubgoalStep + parent workflow + concurrency
- `3c0d80a0` — Phase 4: classifyMutation + PlanMutationStore
- `638c3fd1` — Phase 4: Children tool group + per-role policies
- `79175767` — Phase 4: REST endpoints for nested-goal lifecycle
- `abd70a2f`, `d55b8c2f`, `6f5e1dcf`, `45cb5414`, `7480bb0d` — Phase 5a pure helpers
- `6e2d147a`, `f6326403`, `b54446fc`, `61f5ea30`, `498acbca`, `d4727577` — Phase 5b
- `b9c045e5`, `fb08867b`, `eda21607` — Phase 6
- All Phase 8 docs (`80d05a57`, `de029219`, `4a9f6177`, `7c6fc080`)
- All "_phase-N-notes.md" transient docs (`09cb9898`, `b805d003`, `b46d6006`, `76a7b0ec`, `1989791b`)
- `00d6805f`, `9837fb38`, `fbf5fdca` — sub-goal session attribution
- `8c55042e`, `2ebcb172`, `9969f9bd`, `e9f4bdfb`, `b79d5167`, `e6528d1e` — sidebar nesting hardening
- `c4d18002`, `c6525ac7`, `a44b7229`, `f9329a51` — inline-roles + goal proposal panel
- `a2b15404`, `cee886da` — parent-notification on child gates
- `7c4d4682`, `c928dc93`, `fedfd92f` — child ready-to-merge auto-rewrite
- `d2fe06f7`, `9a1f5de6` — explicit dependsOn
- `c26d4ab3`, `d9c283b3`, `30483c31`, `86d9de21` — subgoals experimental toggle
- `135ce996`, `8526b52b`, `a50bcce4`, `935d6be5`, `06c0eb9a`, `6cfaf771`, `093ced04` — retro-audit + review remediation
- `624cf9e4`, `469da694`, `dfdb3f18`, `4a3b6bff` — tree-cost / plan-tab archived children
- `93ffa741`, `62db6471`, `171536bd`, `a775e088`, `d6b90323`, `a58c1277` — team_prompt + spawnedBySessionId
- `83b59360`, `77b573da` — mergedManually
- `3baf9584`, `86e8c274`, `22df92bb`, `1383a8a3`, `754d4a8a` — comment-trim refactor (deeply intertwined with subgoals files)
- `3837c010`, `b55876c3` — module extractions of plan-tab/children-tab and nested-goal-routes
- `b9d6fea2`, `0ab29837`, `2e11b2b2`, `ec9da88c` — sidebar-active-before-archived test polish
- `bf8ec37b`, `badb23f4`, `86ff973b`, `ce9d8665`, `7491041c`, `2d394f8e`, `42dbfbf3`, `a70a6bb5`, `b3755a3d`, `9a20ae05`, `8c5e770a`, `b8456623`, `8e532d9c`, `b8d572ea`, `fe259879`, `121472c4`, `0f7e6a64`, `e5d8882b`, `907e79c2`, `ef841090`

## Risks & dependencies

- **`73f18ed8`** (tool-extension fetch resilience) rewrites `defaults/tools/_shared/gateway.ts`. Other generic commits don't touch this file, but several subgoals commits import from it transitively. Cherry-pick should be clean against master.
- **`ffa71c67`** + **`d4d09654`** + **`18ec85ee`** form a tight cluster (feature + test cleanup + docs). Pick in that order; `d4d09654` rewrites the same E2E `ffa71c67` introduced.
- **`9e22babd`** + **`36f527dc`** + **`c98e0a09`** + **`0082a824`** form a proposal-panel cluster. Some text in the `propose_*.yaml` docs mentions `inlineRoles` (a subgoals concept) — extracting these may need light copy-edits to drop forward references to subgoals features that aren't yet in the generic PR. **Recommend either (a) take the docs as-is and accept slightly forward-looking copy, or (b) hand-edit each `propose_*.yaml` to strip `inlineRoles` references.**
- **`a6070c56`** (goal-create projectId fallback) touches `src/app/render.ts` near goal-create UI. Conflict risk with subgoals' `c4d18002` (Goal proposal panel UX) is moderate but `c4d18002` is downstream — picking `a6070c56` first will be clean against master.
- **`05b5b28f`** (process.execPath at all node-spawn sites) touches `src/server/agent/rpc-bridge.ts`, `harness.ts`, `server.ts`, `watchdog.ts`, `state-migration/seed-default-workflows.ts`. Subgoals' `1383a8a3` (server-comment trim) touches `server.ts` heavily — picking `05b5b28f` first against master is clean; the subgoals branch's later trim commits are not part of this extracted PR.
- **E2E fix cluster** (`0ce7f8e2`, `edd54673`, `f45bbe19`, `ff690ef2`, `6a5d57f7`-mixed): all touch `tests/e2e/e2e-setup.ts`. Pick in chronological order (matches list above) to avoid serial-conflict cascade. `6a5d57f7` mixes a subgoals-only spec — split it before applying.
- **`d9421db7`** (active-before-archived sidebar ordering) touches `src/app/render-helpers.ts` / `src/app/sidebar-nesting.ts` / `src/app/sidebar-spawned-children.ts`. The latter two **don't exist on master** — they were introduced by subgoals commits `abd70a2f` (sidebar-nesting.ts) and `2ebcb172` (sidebar-spawned-children.ts). To extract cleanly: `git cherry-pick -n d9421db7` then drop hunks for the two missing-on-master files; only the `render-helpers.ts` + `sidebar.ts` portions are actually generic. **Or: defer to subgoals PR — the file dependencies make extraction noisy.**
- **`d4d09654`** depends on `ffa71c67` having been cherry-picked first (it modifies the test that `ffa71c67` introduced). Pick in order.
- No generic commits depend on subgoals commits being present (verified by file-list inspection — generic commits all touch infra paths that exist on master).
