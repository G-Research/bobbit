# Trim source diff before merge — catalogue

**Branch:** `goal/trim-sourc-c761f4df` (child of `goal/audit-subg-225e4d3d`).
**Status:** design-doc only. No source/test edits in this commit.
**Author:** coder-a5ec9647.

This document is the **design-doc** gate output for the "Trim source diff before merge" goal. It catalogues specific, file:line-anchored trim candidates without changing behaviour, then proposes a 4-task parallel decomposition for the implementation gate.

The constraint is hard: **no behaviour change, no test removal, no architecture rewrite**. About 30% of `src/**` insertions on this branch are comments — that is the primary trim target.

---

## 1. Baseline numbers

Run on the live branch tip with `git fetch origin master` first:

```
$ git diff --shortstat origin/master...HEAD -- src
 63 files changed, 9133 insertions(+), 311 deletions(-)
```

(Original goal-spec table reported 9,131 insertions / 311 deletions. The 2-line drift is from the most recent `AGENTS.md`/Lesson-N.M cleanup commit landing on `master`. Numbers below are the live values.)

`name-status` split: **22 added files**, **41 modified files**.

### Top-15 source-churn files

Generated via `git diff --numstat origin/master...HEAD -- src | sort -k1 -nr | head -15`:

| # | File | Added | Deleted | Notes |
|--:|---|--:|--:|---|
| 1 | `src/server/server.ts` | 1253 | 58 | Nested-goal REST (~750 LoC), inline workflows, descendant/tree-cost/plan endpoints |
| 2 | `src/server/agent/verification-harness.ts` | 738 | 46 | `runSubgoalStep` (~600 LoC), tier resolver, semaphore, child-merge |
| 3 | `src/app/goal-dashboard.ts` | 738 | 35 | Plan/Children tabs, tree-cost row, descendant fetch, mutation cards |
| 4 | `src/app/render.ts` | 522 | 70 | Inline-workflow YAML / inline-roles fields, panel tabs, role-picker |
| 5 | `src/app/dialogs.ts` | 487 | 0 | `showArchiveGoalDialog`, `showPauseGoalDialog`, `showResumeGoalDialog` |
| 6 | `src/server/agent/goal-manager.ts` | 391 | 12 | Nesting fields, `_resolveChildBaseBranch`, backfills, multi-repo plumbing |
| 7 | `src/server/agent/plan-mutation.ts` | 325 | 0 | Pure classifier (added file) |
| 8 | `src/server/agent/team-manager.ts` | 315 | 3 | Stuck-team watchdog, child-pass notifications, idle nudge backoff |
| 9 | `src/app/sidebar-nesting.ts` | 252 | 0 | `buildNestedGoalForest` (added file) |
| 10 | `src/app/api.ts` | 241 | 35 | `deleteGoal`/`teardownTeam`/`pauseGoalWithDialog` cascade flow |
| 11 | `src/app/plan-synthesis.ts` | 214 | 0 | `buildPlanSteps` (added file) |
| 12 | `src/server/agent/workflow-store.ts` | 210 | 4 | `stripSubgoalStepsForChildInheritance`, `normalizeWorkflow` |
| 13 | `src/server/agent/cost-tracker.ts` | 184 | 0 | `computeTreeCost` (added file branch logic) |
| 14 | `src/app/render-helpers.ts` | 177 | 10 | Sidebar nested rendering, archived-team-folding |
| 15 | `src/server/agent/plan-mutation-store.ts` | 166 | 0 | Pending-mutation persistence (added file) |

### Comment-share by top file

Counted via `grep -cE "^\+\s*(//|/\*|\*)"` on the diff (hunk header lines excluded):

| File | +lines | comment lines | comment % |
|---|--:|--:|--:|
| `server.ts` | 1208 | 274 | 22% |
| `verification-harness.ts` | 701 | 259 | **36%** |
| `goal-dashboard.ts` | 703 | 132 | 18% |
| `render.ts` | 507 | 94 | 18% |
| `dialogs.ts` | 457 | 58 | 12% |
| `goal-manager.ts` | 370 | 161 | **43%** |
| `plan-mutation.ts` | 301 | 96 | 31% |
| `team-manager.ts` | 291 | 98 | 33% |
| `sidebar-nesting.ts` | 238 | 73 | 30% |
| `api.ts` | 236 | 71 | 30% |

Combined the top-10 files account for ≈ 5,012 added lines and ≈ 1,316 of those are comment lines (≈ **26% comment share** in the high-churn slice — close to the spec's 30% project-wide estimate). `verification-harness.ts` and `goal-manager.ts` are the comment-density outliers and the highest-value comment-shortening targets.

---

## 2. Per-file trim catalogue

Categories used:
- **comment-shorten** — block exists for documentation-of-record reasons but duplicates published `docs/`. Replace with a 1–3 line invariant + doc pointer.
- **extract-module** — block is mechanically separable, public API is small, no risky closures over module-locals.
- **remove-dead** — code never executed (e.g. behaviour-flag-off but still computed) or stale TODO.
- **dogfood-only** — added solely to support the dogfood/audit run, not part of the merged feature.
- **leave-as-is** — block is load-bearing and would be unsafe to touch under the no-behaviour-change rule.

Line numbers refer to the **current branch HEAD** of each file (not diff-line offsets).

### 2.1 `src/server/server.ts` (+1253 / −58)

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 1262–1289 (boot-time backfill block) | comment-shorten | ~12 | The 11-line preamble re-explains `backfillCompleteState` and `backfillSpawnedBySessionId` — both already documented in `docs/nested-goals.md` and `goal-manager.ts` JSDoc. Shrink to "Boot-time backfills — see goal-manager.ts. try/catch is non-fatal." plus the existing two `console.log` lines. |
| 1517–1525 (`requireSubgoalsEnabled` doc) | comment-shorten | ~4 | 6-line doc duplicates `docs/design/subgoals-experimental-toggle.md`. Replace with one-line invariant. |
| 3340–3346 (Phase-4 banner) | comment-shorten | ~5 | "Phase 4 / SUBGOALS-SPEC §5" prose — branch-internal phase number is no longer load-bearing post-merge. Drop the phase banner; keep "Cascade-affecting routes require an explicit `cascade` param (422 otherwise). UI is the cascade-policy authority." |
| 3349–3355 (`listDescendants` jsdoc) | leave-as-is | 0 | Documents the BFS/order/include-archived contract — caller-relevant, keep as-is. |
| 3196–3243 (workflow-resolution comment) | comment-shorten | ~12 | The 4-bullet "Resolve workflow:" block plus the 6-line "Auto-seed defaults" rationale duplicates the `[api] Auto-seeded N default workflows for project ...` recipe entry in `AGENTS.md`. Shorten to "Cascade: body.workflow → workflowId lookup → auto-seed → first match. See AGENTS.md \"Add a project — Auto-seed fallback\"." |
| 3244–3253 (inline-roles snapshot comment) | comment-shorten | ~5 | Doc duplicates `resolveRole.ts` and the `propose_goal` tool docs. One-line pointer suffices. |
| 4138–4140 (END Phase 4 banner) | comment-shorten | ~2 | Drop the banner; the section is already structured. |
| 5699–5703 (Phase-3 freeze comment) | comment-shorten | ~3 | "See SUBGOALS-SPEC §3.6 / docs/_phase-3-notes.md" — the spec doc isn't shipped; replace with `docs/nested-goals.md#mutation-classifier`. |
| ~750–810 nested-goal route handlers | extract-module | (extraction, not net comment trim) | See §3.1. |
| 3719–3768 (`GET /plan` handler) | leave-as-is | 0 | Already delegates to `verificationHarness.resolvePlanStepChild` (R-004 fix). Keep the 8-line block comment that reminds future maintainers of the parity contract — `tests/api-goals-plan-tier-parity.test.ts` is the live regression guard. |

**File-level estimate:** ≈ 40–55 lines via comment-shorten, plus 600–900 lines if `extract-module` lands (§3.1 net diff is roughly even — still recommended for review burden, not raw size).

### 2.2 `src/server/agent/verification-harness.ts` (+738 / −46)

This is the comment-density outlier (36%). Most of the prose is high-value (`runSubgoalStep` block-level invariants), so the trim target is narrower than raw comment count suggests.

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 44–54 (`componentRoot` jsdoc) | comment-shorten | ~6 | "Phase 2 only exercises ... Phase 4 lands" is branch-chronology. Replace with "Resolve a component's cwd within `branchContainer`. Multi-repo: `<branchContainer>/<repo>/<relativePath>`. Single-repo collapses to `branchContainer`." |
| 61–76 (`resolveStep` jsdoc) | leave-as-is | 0 | Documents the three command shapes and the `WorkflowResolveError` contract — caller-relevant. |
| 2799–2825 (Phase-3 banner + concurrency) | comment-shorten | ~12 | The 22-line banner re-explains the file's role; replace with a one-paragraph summary plus pointers to `docs/nested-goals.md` (semaphore §3.5, tier resolver §4.19). |
| 2946–2960 (`runSubgoalStep` 9-block summary) | leave-as-is | 0 | Each numbered block IS the design doc for the method; trimming the summary would orphan the block-level comments below. KEEP. |
| 2963–2965 ("complexity here is irreducible — every numbered block is a real bug we already shipped once on PR #409") | comment-shorten | ~3 | "PR #409" is branch-internal. Replace with "Each numbered block encodes a previously-shipped regression. Do not collapse." |
| 522–550 (~29-line block in diff around tier resolver) | leave-as-is | 0 | Tier resolver semantics — load-bearing. Keep. |
| 643–660, 763–778 (~16–18-line diff blocks) | comment-shorten | ~10 | Spot-check: most of these blocks reference Phase-N labels and SUBGOALS-SPEC sections. Keep the invariant sentences; drop the spec/phase pointers. |
| 1626 (Phase-3 inline `// Phase 3 nested goals — see SUBGOALS-SPEC §2 / §5`) | comment-shorten | ~1 | Drop the spec pointer; the surrounding code self-documents. |

**File-level estimate:** ≈ 25–40 lines via comment-shorten. **Do not extract** sub-methods of `runSubgoalStep`: the retro-audit explicitly warns this is irreducible (and the implementation review's R-finding agreed only "worth deferring").

### 2.3 `src/app/goal-dashboard.ts` (+738 / −35)

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 164–195 (descendant/tree-cost state preamble) | comment-shorten | ~10 | Replace the 30-line "lazy-fetch contract" prose with a 5-line summary + pointer to `docs/nested-goals.md#cost-rollup` and `docs/nested-goals.md#plan-tab`. |
| 277–290 (`dashboardGoalPool` jsdoc) | leave-as-is | 0 | Documents the dedup precedence — short and load-bearing. Keep. |
| 477–489 (fetch trio comments) | comment-shorten | ~6 | "(tree-cost rollup)" repeated noise; the call site is self-evident. Trim to 2 lines. |
| 1531–1585 (`renderTreeCostRow`) | extract-module | (extraction) | See §3.3 — `goal-dashboard-tree-cost.ts`. |
| 2122–2200 (`renderChildrenTab`) | extract-module | (extraction) | See §3.4 — `goal-dashboard-children-tab.ts`. |
| 2200–2240 (resolvePlanNodeChild parity comment) | leave-as-is | 0 | Three-way agreement reminder — load-bearing safety net (server↔client↔tests). |
| 2403–2880 (`renderPlanTab`) | extract-module | (extraction) | See §3.2 — `goal-dashboard-plan-tab.ts`. The Plan tab is the largest single render block on the dashboard. |
| Misc Phase-N labels in inline comments | comment-shorten | ~4 | Sweep `// Phase 5b:` / `// Phase 5a:` markers — branch-internal. |

**File-level estimate:** ≈ 20 lines via comment-shorten **before** extractions. Three plausible extractions can move ~700–900 lines into focused modules, dropping the file from ~2900 LoC to ~1200 LoC and making review tractable.

### 2.4 `src/app/render.ts` (+522 / −70)

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 759–767 (`inlineWorkflowYaml` / `inlineRolesYaml` field doc) | comment-shorten | ~4 | The "(parallel to body.workflow)" prose is duplicated from `propose_goal` tool docs; one-line invariant suffices. |
| 832–850 (inline-active gating) | leave-as-is | 0 | Behaviour-critical: gates the workflow `<select>` on inline-YAML presence. Comment is short and load-bearing. |
| 1000–1030 (Advanced details collapse) | leave-as-is | 0 | UX-critical block. |
| 2391–2475 (`_validateInlineWorkflowYaml`, `_validateInlineRolesYaml`) | leave-as-is | 0 | Pure helpers (~80 LoC). Already extracted from inline use. KEEP. |
| 1280–1300 (validate-and-attach call sites) | leave-as-is | 0 | Tight + behaviour-critical. |

**File-level estimate:** ≈ 4–10 lines via comment-shorten. Most of the +522 is mandatory new UI surface for inline workflow / inline roles flows. **Do not extract** — the panel-tab UI is already split across many small functions.

### 2.5 `src/app/dialogs.ts` (+487 / −0)

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 1700–1720 (`showArchiveGoalDialog` jsdoc) | comment-shorten | ~4 | The 3-step "Archive flow" enumeration is documented in `docs/nested-goals.md` and `AGENTS.md` "Cascade confirmation dialogs". Shrink to one-line invariant. |
| 1721–1735 (R-027 refactor reminder) | leave-as-is | 0 | Cross-call-site invariant ("only invoked from `deleteGoal()` after descendantCount > 0") is bug-prevention; keep. |
| 2055–2065 (`showResumeGoalDialog` "checkbox defaults OFF" comment) | comment-shorten | ~3 | UX rule already in `AGENTS.md`. One-line pointer. |
| 2178–2184 (recursive `countDescendants` helper) | leave-as-is | 0 | Tight pure helper, no risk. |

**File-level estimate:** ≈ 8–12 lines via comment-shorten. Comment share is only 12% — already the leanest of the high-churn files. **Do not extract** the three dialogs into their own file: the existing `dialogs.ts` is the standing module for all confirm/picker dialogs and breaking that pattern would create a "where do I look for the dialog?" smell.

### 2.6 `src/server/agent/goal-manager.ts` (+391 / −12)

Comment density 43%, the worst on the branch. Many of the comments are spec-fragment commentary that has been published in `docs/nested-goals.md`.

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 44–60 (Pool-resolver / multi-repo preamble) | comment-shorten | ~6 | "Phase 3" / "Phase 4b" labels + multi-doc pointer noise. Keep the invariant sentence ("worktree-pool resolver matches sessions; components-resolver enables multi-repo"). |
| 103–135 (resolver-setter jsdocs) | comment-shorten | ~10 | Five 4–6-line jsdoc blocks; the setter signatures are self-documenting. Keep one-line invariants. |
| 159–180 (constructor + `_recoverStuckSetups` comment) | leave-as-is | 0 | Recovery semantics — keep. |
| 230–245 ("Persist the project association") | comment-shorten | ~6 | 8-line "previously stamped post-hoc by POST /api/goals" rationale is branch chronology. Keep one-line invariant: "Stamp `projectId` here so subgoals don't need a parentGoalId-chain walk for project bucketing." |
| 272–290 (workflowId resolution) | comment-shorten | ~9 | 18-line block restating the `normalizeWorkflow` rationale (already covered by the `gateDef.dependsOn is not iterable` debugging entry in `AGENTS.md`). Trim to 3 lines. |
| 342–360, 380–400 (component-set worktree setup) | comment-shorten | ~10 | "Phase 2" / "Phase 4" callouts; runComponentSetups already has its own jsdoc. Drop phase markers. |
| 410–440, 467–490 (multi-repo + offsetCwd comments) | comment-shorten | ~12 | Most prose duplicates `docs/internals.md — Multi-repo & components`. Trim to invariant references. |
| `_resolveChildBaseBranch` (~340 region) | leave-as-is | 0 | Bug-prevention warn + child-vs-orphan invariant — keep. |

**File-level estimate:** ≈ 50–60 lines via comment-shorten — the biggest single comment-trim opportunity on the branch.

### 2.7 `src/server/agent/plan-mutation.ts` (+325 / −0, added file)

Pure classifier. Comments are dense (31%) but mostly contractual (severity order, normalisation pinning, conflict-warn behaviour).

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 1–22 (file-header docstring) | comment-shorten | ~6 | The 22-line preamble re-states `docs/nested-goals.md#mutation-classifier`. Trim to 8-line summary + doc pointer. |
| 32–62 (`ClassifierPlanStep` jsdoc) | leave-as-is | 0 | Field-precedence contract is the contract — keep. |
| 92–110 (`normalise` doc — locale-pinning rationale) | leave-as-is | 0 | Turkish/Azerbaijani dotless-i pin is a real bug story; keep verbatim — the AGENTS.md recipe entry references it. |
| 112–125 (`_warnedConflict` one-shot guard) | leave-as-is | 0 | Tight + correct. |

**File-level estimate:** ≈ 8 lines. Don't over-trim a pure classifier — the doc IS the test contract.

### 2.8 `src/server/agent/team-manager.ts` (+315 / −3)

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 88–100 (`TeamAgentInfo` / `TeamState` interface decoration) | comment-shorten | ~3 | Interface fields are self-documenting; one-line summaries are enough. |
| 159–185 (idle/stuck/nudge constants) | comment-shorten | ~10 | Each `private static readonly` carries a 3-line doc comment. The constant names already encode the meaning; collapse to one-line jsdoc per constant. |
| 208–220, 257–275 (`shouldSkipNudge` + `_stuckSweepTick` block headers) | comment-shorten | ~6 | Three-layer architecture is in `docs/design/auto-nudge-stuck-team-leads.md`; collapse the inline restatement. |
| Stuck-team watchdog implementation | leave-as-is | 0 | Behaviour-critical — keep. |
| 380+ (idle backoff rationale) | comment-shorten | ~3 | Doc-already-published prose. |

**File-level estimate:** ≈ 18–25 lines.

### 2.9 `src/app/sidebar-nesting.ts` (+252 / −0, added file)

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 1–32 (file header) | comment-shorten | ~8 | 32-line preamble; keep an 8–10 line summary + doc pointer (`docs/nested-goals.md` for the rules). |
| 200–215 (feature-flag-off branch) | leave-as-is | 0 | Critical: the flat-list collapse is the whole point of the feature gate. Keep both the comment and the doc pointer. |
| `buildNestedGoalForest` body | leave-as-is | 0 | Tight helper. |

**File-level estimate:** ≈ 6–10 lines.

### 2.10 `src/app/api.ts` (+241 / −35)

| Range | Category | Saved | Justification |
|---|---|--:|---|
| 920–965 (`deleteGoal` cascade flow) | comment-shorten | ~10 | The 30-line preamble re-explains the cascade-confirm dialog flow that `dialogs.ts` already documents. Keep one-line invariant + pointer. |
| 1027–1043 (`pauseGoalWithDialog` / `resumeGoalWithDialog` jsdoc) | comment-shorten | ~4 | "(Phase 5b)" labels + cascade re-explainer. |
| 1109–1135 (`teardownTeam` cascade-required reminder) | leave-as-is | 0 | The "Server requires explicit `cascade`" comment + the pointer to AGENTS.md is the bug-prevention layer for the 422 contract. Keep. |

**File-level estimate:** ≈ 14–18 lines.

---

## 3. Module-extraction proposals

For each candidate, I check three things:
1. **Closures over module-locals** — do moved functions read shared state?
2. **Public API shape** — is the boundary small enough that the new module name is obvious?
3. **Test imports** — do existing tests import the moved symbol directly?

### 3.1 `src/server/agent/nested-goal-routes.ts` — server.ts route extraction

- **Lines moved:** server.ts ~3340–4138 (the explicit "Phase 4: Nested-goal endpoints" section).
- **Public API shape:**
  ```ts
  export interface NestedGoalRouteDeps {
    projectContextManager: ProjectContextManager;
    verificationHarness: VerificationHarness;
    teamManager: TeamManager;
    workflowStore: WorkflowStore;            // (used implicitly via ctx)
    preferencesStore: PreferencesStore;
    requireSubgoalsEnabled(): boolean;
    json(body: unknown, status?: number): void;
    broadcast(event: WsServerEvent): void;
  }
  export function tryHandleNestedGoalRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    deps: NestedGoalRouteDeps,
  ): Promise<boolean>;  // returns true if the route was handled
  ```
- **Risk:**
  - The handlers reference `json()` and `broadcast()` closures — both are top-level functions in `server.ts`, so they have to flow through `deps` rather than be imported. Manageable.
  - `applyPlanSteps` and `cancelAllVerifications` live alongside the routes — extract them too.
  - `listDescendants` is also called from the legacy `DELETE /api/goals/:id` handler outside the Phase-4 block — must be re-exported from the new module or hoisted into a separate `goal-tree-ops.ts`. (Suggest hoisting it: `goal-descendants.ts` already exists and `collectDescendants` is the natural sibling — verify whether `listDescendants` adds anything that helper doesn't.)
  - Some route bodies reference `workerPool`-style local helpers that may carry closures. Spot-check during extraction.
- **Verdict:** **recommend** with caveats. The extraction reduces `server.ts` review burden materially (~10% of the diff) and the new module is independently unit-testable via the existing fixture (`tests/run-subgoal-step-fixture.ts` style). Caveat: do this AFTER the comment sweep so the moved code has fewer lines to relocate.

### 3.2 `src/app/goal-dashboard-plan-tab.ts` — Plan-tab extraction

- **Lines moved:** `goal-dashboard.ts` ~2403–2880 (`renderPlanTab` + its private helpers — `layoutPlanLevel`, depth-limited recursion helpers).
- **Public API shape:**
  ```ts
  export function renderPlanTab(args: {
    currentGoal: Goal;
    allGoals: Goal[];                      // dashboardGoalPool() output
    activeChildId: string | undefined;     // fold/unfold state
    expandedNodes: Set<string>;
    onToggle(planId: string): void;
  }): TemplateResult;
  ```
- **Risk:**
  - The Plan tab reads several module-local variables (`currentGoal`, `dashboardDescendants`, `expandedPlanNodes`, throttle timers). All would have to become explicit args or move to a small `plan-tab-state.ts` module.
  - SVG-edge layout helpers (`computeEdgePaths` consumers) already live in `plan-edge-paths.ts` — the extraction would NOT pull those across.
  - No tests currently import `renderPlanTab` directly (E2E exercises it through the dashboard render); test imports are not a blocker.
- **Verdict:** **recommend**. ~480 LoC moved, new module is independently testable with `file://` fixtures, residual `goal-dashboard.ts` becomes much easier to scan.

### 3.3 `src/app/goal-dashboard-tree-cost.ts` — tree-cost row extraction

- **Lines moved:** `goal-dashboard.ts` ~1531–1585 (`renderTreeCostRow`) plus the ~30 lines of `treeCost`/`fetchTreeCost`/`treeCostInFlight` state at the top of the file.
- **Public API shape:**
  ```ts
  export interface TreeCostState {
    treeCost: TreeCost | undefined;
    expanded: boolean;
  }
  export function renderTreeCostRow(state: TreeCostState, onToggle: () => void): TemplateResult | typeof nothing;
  export function startTreeCostPolling(goalId: string): { stop(): void };
  ```
- **Risk:**
  - The fetch+timer trio (`fetchTreeCost`, `treeCostLastFetchAt`, `treeCostInFlight`) couples the row to the dashboard's polling loop. Extracting the renderer alone (without the polling) is messy because they share the in-flight guard.
  - Tests currently don't import `renderTreeCostRow`.
- **Verdict:** **defer**. The win is small (~80 LoC) and the polling-coupling makes the boundary fragile. Re-evaluate after the Plan-tab extraction (which removes the bigger noise source).

### 3.4 `src/app/goal-dashboard-children-tab.ts` — Children-tab extraction

- **Lines moved:** `goal-dashboard.ts` ~2122–2200 (`renderChildrenTab`, `buildChildSummaries`).
- **Public API shape:**
  ```ts
  export function renderChildrenTab(args: {
    parentGoal: Goal;
    allGoals: Goal[];
  }): TemplateResult;
  ```
- **Risk:**
  - Lower coupling than the Plan tab (no SVG, no DAG layout).
  - `buildChildSummaries` is a pure function that probably should live in the new module (or be hoisted to `sidebar-spawned-children.ts` if the algorithm overlaps).
- **Verdict:** **recommend** if §3.2 lands; it's cheap to do at the same time.

### 3.5 Cascade dialogs into their own file

- **Lines moved:** `dialogs.ts` ~1721–2065 (three dialogs).
- **Verdict:** **reject**. The existing `dialogs.ts` is the canonical home for confirm/picker dialogs across the app. Splitting one feature out would create a "where do I look?" smell and would not reduce review burden — the dialogs are already structured one-per-export.

---

## 4. Lesson-N.M / branch-internal wording sweep

Run: `rg -n "Lesson [0-9]|retro|audit-only|dogfood" src defaults docs tests`.

### Source / tests / defaults

- **`src/**`:** **0 hits** for `Lesson [0-9]`. The prior cleanup pass was thorough in source. ✅
- **`tests/proposal-types-goal-inline.test.ts:43`** — `description: "ephemeral audit-only workflow"` — **leave-as-is**. This is fixture data describing the test scenario, not a Lesson reference. The phrase "audit-only" describes ephemeral inline workflows accurately and survives without the audit context.
- **`tests/e2e/api-goals-spawn-child-route.spec.ts:572`**, **`tests/e2e/api-goals-propose-inline.spec.ts:41`** — same pattern, same verdict: **leave-as-is**.
- **`tests/spawn-node-execpath-invariant.test.ts:12`** — references `docs/design/subgoals-retro-audit.md §4.2` in a comment. **comment-shorten**: replace with "Pin: every node spawn site uses `process.execPath`." The retro-audit doc reference will stale once that doc is deleted/relocated post-merge.
- **`tests/e2e/projects-no-default-workflows.spec.ts:139`** — "Out-of-scope for the subgoals retro-audit — file as a separate goal." **comment-shorten**: drop "for the subgoals retro-audit"; keep "Out-of-scope here — file as a separate goal."
- **`tests/e2e/ui/proposal-spec-survives-navigate.spec.ts:108`** — "the subgoals retro-audit; tracked separately." **comment-shorten**: drop "subgoals retro-audit"; replace with the actual GitHub issue / TODO text or just "tracked separately."

### `defaults/`

- **0 hits.** ✅

### `docs/`

- **`docs/design/subgoals-retro-audit.md`** — entire file (~470 lines). **dogfood-only / candidate for archive**. This was the audit deliverable for the parent goal `audit-subg-225e4d3d`. Once this trim goal merges, the audit is no longer the source of truth — `docs/nested-goals.md` is. **Recommendation:** rename to `docs/archive/subgoals-retro-audit.md` and add a one-line front-matter note "Historical audit; for current invariants see `docs/nested-goals.md`." Decision: **defer to team-lead** — moving / deleting this doc is potentially out of scope for "trim source diff" since the goal is `src/**`-focused. Flag as a follow-up.
- **`docs/design/subgoals-review-findings.md`** — same status. Same recommendation.
- **`docs/debugging.md:393`** — "Originally observed during dogfooding ..." — **leave-as-is**. The debugging entry is itself the historical record; the "dogfooding" word is incidental and accurate.
- **`docs/design/portable-search.md:312`** — "Bobbit-as-a-dogfood corpus". **leave-as-is** — this design doc predates the subgoals branch.
- **`docs/design/auto-nudge-stuck-team-leads.md:8`** — "During dogfooding of `audit-subg-225e4d3d`, subgoal `df3d8b33`...". **comment-shorten** — replace with "Observed when a subgoal idled with active workers." The specific goal-id reference will be a stale artefact post-merge.

### Net wording sweep

≈ 4–6 line trims in tests/docs. The aggregate impact on `src/**` is **zero** — the spec's prior pass was clean. The remaining residue is in tests and historical design docs, and most of it falls under the "out of scope for src/**" filter. **Verdict:** flag the `subgoals-retro-audit.md` / `subgoals-review-findings.md` archive question for the team-lead but do not block the trim work on it.

---

## 5. Feature-flag-off audit

Subgoals (Experimental) toggle flow:

- **Server source of truth:** `preferencesStore.get("subgoalsEnabled") === true`.
- **Server gate:** `requireSubgoalsEnabled()` in `server.ts:1517` → 403 SUBGOALS_DISABLED.
- **Client source of truth:** `isSubgoalsEnabled()` in `src/app/subgoals-flag.ts` → reads `document.documentElement.dataset.subgoalsEnabled`.

### 5.1 Server route guards
Verified via `rg -n "requireSubgoalsEnabled\(\)" src/server/server.ts`. Every nested-goal route (spawn-child, plan-propose, plan-status, merge-child, pause, resume, archive-child, decide-mutation, set-policy) calls `requireSubgoalsEnabled()` BEFORE any descendant traversal. ✅

### 5.2 Tool activation
`Children` tool group is gated via `groupPolicyStore.setSubgoalsEnabledGetter(...)` (server.ts:610) — the policy cascade resolves every tool in the group to `never` when off. ✅

### 5.3 Dashboard tab visibility
`shouldShowPlanTab` / `shouldShowChildrenTab` in `src/app/goal-dashboard-tab-visibility.ts` short-circuit on `!isSubgoalsEnabled()` BEFORE walking goals. ✅

### 5.4 Sidebar nesting
`buildNestedGoalForest` (`src/app/sidebar-nesting.ts:200`) returns the flat list immediately when the flag is off (no `parentGoalId` walk). ✅

### 5.5 Mutation cards
Mutation-card render path is reached only when the dashboard's mutation slot is populated, which only happens after `mutation_pending` events arrive — which only fire from a parent-workflow goal — which only exists when subgoals are enabled. ✅ (chain is structural, not policed by an explicit early-return).

### 5.6 REST polling — **finding**

`src/app/goal-dashboard.ts:479` `void fetchTreeCost(goalId)` and `:489` `void fetchDashboardDescendants(goalId)` are unconditionally fired in `loadDashboardData()` for every goal. There is **no** `if (!isSubgoalsEnabled()) return` guard before either fetch.

- The endpoints themselves don't care about the flag (they aren't on the gated list — `tree-cost` and `descendants` are read-only and predate the experimental gate), so the fetches succeed and burn ≈ 1 round-trip per goal load.
- `tree-cost` for a non-nested goal returns a 1-row breakdown (just the goal itself); `descendants` returns `{goals: []}`. Both are cheap, but they are still wire-cost on every dashboard load.

**Verdict:** minor finding. **comment-shorten + early-return**: add an `if (!isSubgoalsEnabled()) return` guard at the top of both `fetchTreeCost` and `fetchDashboardDescendants` (or in their callers in `loadDashboardData`). Saves zero lines of source diff but eliminates two pointless network calls when the flag is off.

This is in scope for Task D below.

---

## 6. Duplicate resolution-logic audit

Three sites resolve "given a planId, find the matching child goal":

1. **`src/server/agent/verification-harness.ts:2865` — `resolvePlanStepChild`** — server canonical, 5-tier (live in-progress → archived complete → live other → archived non-complete + Tier 1.5 cached pointer + Tier 5 rescue back-fill).
2. **`src/app/plan-node-state.ts:63` — `resolvePlanNodeChild`** — client mirror. 4-tier preference (matches the canonical tier order). No Tier 1.5 / Tier 5 (intentional — the client doesn't own the cache).
3. **`src/server/server.ts:3877` — `GET /api/goals/:id/plan` handler** — **delegates to `verificationHarness.resolvePlanStepChild`**. The R-004 fix already removed the third copy.

### Coverage

`tests/api-goals-plan-tier-parity.test.ts` (the file is real — confirmed by `head -30`) pins server-route ↔ harness parity across all five tier scenarios. ✅

`tests/plan-node-state.test.ts` covers the client-side mirror. ✅

### Drift risk

- Client-server divergence is structural: client sees `state.goals` (live) plus `dashboardDescendants` (archived) — same dataset the harness resolves over. The client deliberately omits Tier 1.5 / Tier 5 because:
  - Tier 1.5 (cached `subgoal.childGoalId`) — the client doesn't have access to the persisted gate `verifyState.steps[]`, so the cache lookup is not available.
  - Tier 5 (back-fill `spawnedFromPlanId` for legacy rows) — back-fill is a write, which only the server may do.
  
  Both omissions are safe: the client falls through to the same Tier-1..4 result the server returns, and the agreement is exercised by `plan-tab-archived-children.spec.ts` E2E.

### Shared pure helper?

**Reject.** A shared helper would have to live in `src/shared/` (the only module both server and client may import). The Tier 1.5 / Tier 5 logic depends on store handles (write back-fill) — those can't move into `shared/`. The cleanest cut would be:

- `src/shared/plan-tier-resolve.ts` carrying just the Tier 1..4 ordering helpers.
- `verification-harness.ts` and `plan-node-state.ts` both compose those helpers and add their tier-extras.

Worth ~50 LoC of dedup at the cost of a new shared module + boundary discipline. Given the parity test exists and the divergence is intentional, **the cost-benefit doesn't justify the move** for this trim goal. **Verdict:** keep the parity test as the contract; do not extract.

---

## 7. Decomposition recommendation for the implementation gate

Four parallel tasks, non-overlapping file sets:

### Task A — Comment-shortening sweep (server-side files)

**Owns (touches only):**
- `src/server/server.ts`
- `src/server/agent/verification-harness.ts`
- `src/server/agent/goal-manager.ts`
- `src/server/agent/team-manager.ts`
- `src/server/agent/plan-mutation.ts`
- `src/server/agent/workflow-store.ts`

**Must NOT touch:** any `src/app/`, `src/shared/`, `defaults/`, `tests/`.

**Scope:** apply §2.1, §2.2, §2.6, §2.7, §2.8 catalogue items; sweep `Phase [0-9]+` / `SUBGOALS-SPEC §` / `docs/_phase-N-notes.md` markers.

**Estimated lines saved:** ~140–180.

### Task B — Comment-shortening sweep (client-side files)

**Owns:**
- `src/app/goal-dashboard.ts` (comments only — no extractions yet)
- `src/app/render.ts`
- `src/app/dialogs.ts`
- `src/app/api.ts`
- `src/app/sidebar-nesting.ts`

**Must NOT touch:** any `src/server/`, `src/shared/`, `defaults/`, `tests/`. Must NOT extract sub-modules from `goal-dashboard.ts` (Task C does that).

**Scope:** §2.3 (comments only), §2.4, §2.5, §2.9, §2.10.

**Estimated lines saved:** ~50–80.

### Task C — Extract `goal-dashboard-plan-tab.ts` and `goal-dashboard-children-tab.ts`

**Owns:**
- `src/app/goal-dashboard.ts` (extract + remove moved blocks)
- New file: `src/app/goal-dashboard-plan-tab.ts`
- New file: `src/app/goal-dashboard-children-tab.ts`

**Must NOT touch:** `server.ts`, anything Task A or B own.

**Scope:** §3.2 + §3.4. Run after Task B has merged so the extracted bodies are already comment-trimmed.

**Estimated lines moved:** ~700 (net diff stays roughly even; review burden drops materially).

### Task D — Feature-flag-off + extract `nested-goal-routes.ts`

**Owns:**
- `src/server/server.ts` (extraction surgery — coordinate ordering with Task A)
- New file: `src/server/agent/nested-goal-routes.ts`
- `src/app/goal-dashboard.ts` add early-return guards in `fetchTreeCost` / `fetchDashboardDescendants` (§5.6 finding)

**Must NOT touch:** anything outside the listed files.

**Scope:** §3.1 + §5.6.

**Risk note:** Tasks A and D both edit `src/server/server.ts`. Order them: **A first**, then D. The team-lead must serialise these on the same agent, OR Task D must rebase on Task A's HEAD.

**Estimated lines:** ~600–900 moved (server.ts), 0 net (extraction); 4–6 lines added for flag-off guards.

### Cross-task invariants

- Every task runs `npm run check` and `npm run test:unit` before commit.
- Every task pushes its branch and updates its task spec with `head_sha`.
- The team-lead merges A → B → C → D into the goal branch (in that order; A and B can land in parallel since their file sets are disjoint).

---

## 8. Estimated diff impact

### Conservative best-case after all four tasks land

| Bucket | Pre | Post | Change |
|---|--:|--:|--:|
| `src/**` insertions | 9133 | ~8800 | −330–380 |
| `src/**` deletions | 311 | ~340 | +30 (extractions add small wiring) |
| `server.ts` LoC | 9577 | ~8700–8900 | −650–870 (after Task D extracts) |
| `goal-dashboard.ts` LoC | 2904 | ~2100–2200 | −700 (after Task C) |
| `verification-harness.ts` comment lines | 259 | ~225–230 | −30–35 |
| `goal-manager.ts` comment lines | 161 | ~105–115 | −50–55 |

### Hits the spec's 20–40% comment-reduction target?

**Top-10 file comment lines:** ~1316 → estimate ~1080 = **~18% reduction**.
**`server.ts` + harness + goal-manager + team-manager subset:** ~792 → ~620 = **~22% reduction**.

So the **server-side comment cluster** plausibly hits the lower bound (20%) of the 20–40% target. The branch-wide aggregate falls slightly short.

### Why the aggregate doesn't hit 30–40%

- Many `goal-dashboard.ts` and `dialogs.ts` "comments" are short two-line UI explanations interleaved with template literals — hard to trim individually and not where the token-cost sits.
- The biggest single comment block on the branch (`runSubgoalStep`'s 9-block summary) is **load-bearing** and explicitly excluded from trimming under the no-behaviour-change rule.
- `plan-mutation.ts`'s docstrings encode the contract (locale-pinned normalisation, severity order, override rule) — also excluded.

### Adjustment proposal

If the team-lead wants to push closer to 30%, the next pass would have to:
1. Move `runSubgoalStep`'s 9-block summary into `docs/nested-goals.md` and replace each block with a 2-line invariant pointer. (~80 LoC.) **Risk:** breaks the "every block is a previously-shipped regression" reminder. Not recommended for this goal.
2. Aggressively prune `plan-mutation.ts`'s docstring-as-test-contract. (~40 LoC.) **Risk:** the docstring IS the contract; the locale-pinning bug story would be lost. Not recommended.

The honest answer is: **18–22% reduction is the right target for a no-behaviour-change pass**. Pushing to 30% would require either deleting load-bearing invariants or relocating them to `docs/` (a doc-side commit), which is out of scope for this goal.

### What the extractions buy

The Plan-tab and `nested-goal-routes.ts` extractions don't reduce raw `src/**` insertions — they merely shuffle lines. Their value is in **review-burden reduction**:

- `server.ts` becomes a 900-line-shorter file to scan.
- `goal-dashboard.ts` becomes ~2100 LoC instead of 2900.
- Extracted modules are independently unit-testable.

For the merge-review reviewer, **review-burden reduction is a more valuable outcome than raw LoC**, and the extraction proposals deliver that even if the spec's 30% comment-target is missed by a few points.

---

## Open questions for the team-lead

1. **Archive `docs/design/subgoals-retro-audit.md` and `subgoals-review-findings.md`?** Out of scope here; flag as follow-up goal.
2. **Order Tasks A and D on the same agent (serial) or rebase Task D on Task A?** Both legal; serialising is simpler.
3. **Should Task C extract `goal-dashboard-tree-cost.ts` too?** §3.3 says **defer** — re-evaluate after Plan-tab lands.
4. **Push the comment-trim closer to 30%?** §8 argues no without behaviour-relevant deletions.

---

*Design-doc produced by `coder-a5ec9647` on goal `trim-sourc-c761f4df` (child of `audit-subg-225e4d3d`).*
