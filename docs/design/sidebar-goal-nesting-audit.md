# Sidebar & Goal-Nesting Audit — Findings + Ordered Task Backlog

> **Date:** 2026-06-10 · **Baseline:** master @ `6ec8c8f9` · Companion to the comms-stack
> audit ([comms-stack/04-current-state-and-backlog.md](comms-stack/04-current-state-and-backlog.md))
> but a distinct surface: the left navigation pane (projects/goals/sessions) and the
> goal/sub-goal nesting model. All file:line anchors verified against the current tree.
>
> **Scope:** race conditions and redraw correctness in the sidebar's data flow; whether
> goal/subgoal nesting is modelled and rendered optimally; reuse/composability defects.
> Each backlog task (§4) is self-contained for hand-off to an implementer agent.
>
> **Status:** audit complete, backlog (T1–T9) not started. Workstream **SN** in
> [fable-program-execution-plan.md](fable-program-execution-plan.md). ⚠️ Seam overlap with
> the battery plan ([client-performance-battery.md](client-performance-battery.md)):
> **T2/T3 and PB-FX5 both rewrite `api.ts` `refreshSessions`/`startSessionPolling`** — land
> T2 (concurrency hardening) first, then FX5 (poll demotion) on top; **T5/T7 reshape the
> sidebar render paths PB-FX7 throttles** — sequence per the execution plan, not ad hoc.

---

## 1. Executive summary

The sidebar is fed by a **5s REST poll (`refreshSessions`) + ~25 scattered ad-hoc
`refreshSessions()` call sites + WS-pushed point patches**, with **no in-flight coalescing
and no monotonic-generation acceptance guard** — every "X briefly reverts/reappears"
symptom traces to this one hole (D1–D5). The nesting UI maintains **two parallel render
paths** for one parent/child relation: Path A (spawned children rendered inside a
team-lead's expanded block, `render-helpers.ts::renderTeamGroup`) and Path B (the pure
forest, `sidebar-nesting.ts::buildNestedGoalForest`), kept disjoint by a third function
(`computeSpawnedClaim`) whose doc-comment literally promises to "mirror render-helpers
exactly". That mirror discipline has already failed once in the wild (commit `62755c3d`,
"don't render spawned sub-goals at top level") and still contains live disagreement windows
— invisible goals (D10), duplicate rows (D9), three different badge semantics (D6). Mobile
is a third, drifted near-copy with **no forest path at all** (D7). The same goal tree is
independently re-derived in at least **six places** (S2). Test coverage is dominated by
**hand-copied mirror fixtures that have already drifted from source**, and the core forest
builder has **zero direct tests** (S5).

The structural moves that remove these bug classes by construction: (1) a single sync
engine with epoch discipline, (2) a single memoized goal-graph module, (3) one recursive
tree renderer shared by desktop/mobile/archived — deleting the claim/mirror machinery.

What is already sound (verified, no action): the 5cfc0306 "Loading… blanking" fix is a real
root-cause fix; rAF render coalescing is respected by the sidebar; expansion/scroll state
survives re-renders; gate-status/PR caches already implement the correct in-flight/token
patterns (the model for T2); goal-dashboard descendant fetches are guarded; unread/read
mark race is defended; cross-tab project reorder is sound.

---

## 2. Confirmed defects

### D1 — `refreshSessions` has no in-flight dedup and no monotonic-generation guard (root-cause class)
- **Anchors:** `src/app/api.ts:299-498` (no reentry guard; unconditional
  `state.gatewaySessions = newSessions` at `:367`; `state.sessionsGeneration =
  sessionsData.generation` at `:388-390`; goals merge `:397-443`). Contrast with the guards
  the codebase already built elsewhere: `_prRefreshInFlight` (`api.ts:1119-1122`),
  gate-status tokens (`api.ts:1084-1115`).
- **Trigger:** any two overlapping invocations — trivially reachable: the 5s poll
  (`api.ts:273-280`), `visibilitychange` (`main.ts:986-992`), hashchange route handlers
  (`main.ts:293-543`), and the WS `goal_state_changed`/`goal_child_spawned`/`cost_changed`/
  `goal_spec_changed` handlers (`remote-agent.ts:1778-1800`) all call it un-coordinated. A
  `goal_child_spawned` burst during plan execution fires N concurrent fetches.
- **Symptom:** last-**arriving** (not last-issued) response wins. A stale snapshot can
  (a) regress `sessionsGeneration`, (b) revert a WS-applied status/title for ≤5s
  (flickering sprite/unread pulse, spurious notification beep via `_prevSessionStatus`,
  `api.ts:351-365`), (c) resurrect removed rows. Self-heals on the next poll tick — unless
  the tab is hidden (polling is visibility-gated), in which case stale state persists until
  refocus.
- **Severity:** medium (transient wrong UI, spurious beeps; high reachability).
- **Why tests miss it:** `tests/sidebar-loading-flash.test.ts` pins only the initial-load
  flag; nothing pins ordering across overlapping fetches.
- **Repro:** stub `gatewayFetch` with two controllable promises; call `refreshSessions()`
  twice; resolve the second (newer generation) first, then the first; assert state keeps
  the newer generation. Fails today.
- **Fix:** coalesce (return the in-flight promise) + accept a response only if
  `generation >= state.sessionsGeneration` (sessions and goals independently), mirroring
  the gate-status token pattern. **Non-goal:** moving to WS-pushed lists.

### D2 — WS point-updates race in-flight poll snapshots (ghost session after `session_removed`)
- **Anchors:** `src/app/session-manager.ts:1396-1412` (`onSessionRemoved` filters the list
  immediately), `remote-agent.ts:1951-1960`; resurrect path = D1's `api.ts:367`. Same class
  for `updateLocalSessionStatus`/`updateLocalSessionTitle` (`api.ts:251-271`).
- **Trigger:** poll issued at T0; session archived at T1 (WS removes the row); poll
  response (snapshot from T0) applies at T2 → the row reappears for ≤5s; clicking it
  404s/reconnects to a dead session.
- **Severity:** medium. **Fix:** subsumed by D1's epoch guard (removal bumps the server
  generation, so the stale snapshot is dropped).

### D3 — Goal archived by an agent/another tab vanishes entirely when "See Archived" is on
- **Anchors:** goals merge rule `api.ts:403-421` — the live payload is authoritative; a
  goal newly archived **server-side** is absent from the live payload and not in
  `preservedArchived` (the local copy isn't flagged archived) → dropped from `state.goals`
  outright. The archived list refreshes only on toggle/search/load-more/initial
  (`sidebar.ts:1090-1101`, `api.ts:493-497`); the WS `goal_state_changed` handler only
  calls `refreshSessions()` (`remote-agent.ts:1778-1789`), never the archived page.
- **Trigger:** showArchived ON; a team-lead calls `goal_archive_child` (or a second browser
  archives the goal). Sidebar: the goal disappears from the live section and does **not**
  appear in Archived until the user toggles See-Archived off/on.
- **Severity:** medium-high perceived ("my goal is gone"); no data loss.
- **Fix:** when a previously-live goal id disappears from the live payload while
  `state.showArchived && archivedGoalsLoaded()`, trigger a debounced first-page archived
  re-fetch; or have the server include `archivedSince` deltas. **Non-goal:** keeping
  archived pages fully live.

### D4 — Duplicate concurrent archived-goals fetches; inconsistent loaded-flag discipline
- **Anchors:** `api.ts:871-879` — `_archivedGoalsLoaded = true` is set **after** the await
  (`fetchArchivedSessions` sets its flag **before**, `api.ts:529-537`).
  `_ensureArchivedForSearch` (`sidebar.ts:1090-1101`) checks the flag per keystroke → every
  keystroke during the in-flight window issues another fetch; each first-page response
  **replaces** the archived slice (`api.ts:887-891`), racing a concurrent "Load more"
  append (`api.ts:882-886`).
- **Severity:** low-medium (wasted fetches; pagination cursor/content mismatch under fast
  typing + load-more).
- **Fix:** set the flag pre-await + in-flight promise dedup, same shape as sessions.

### D5 — Optimistic archive can flash back to live
- **Anchors:** `eagerMarkArchived` (`api.ts:1425-1434`) then `await refreshSessions()`
  (`api.ts:1364, :1391`). An unrelated poll issued pre-DELETE that lands after the awaited
  refresh reverts the goal to live for one tick (D1 class).
- **Severity:** low (cosmetic flash). Fixed by D1's epoch guard.

### D6 — Descendant-count badge has three different meanings (and is often missing)
- **Anchors:** Path B badge = transitive descendant count over the **claim-filtered**
  forest input (`sidebar.ts:1377-1384` excludes claimed children before
  `buildNestedGoalForest`; count from `sidebar-nesting.ts:133-159`). Path A badge =
  **direct non-archived children only** (`render-helpers.ts:862`). Mobile = no badge at all
  (`render.ts:549` passes no opts).
- **Symptom:** a parent whose children are all claimed by its team-lead shows **no badge**
  (its forest node has zero children) even though docs/nested-goals.md promises one; a
  spawned child's badge undercounts grandchildren.
- **Severity:** cosmetic-medium, always visible to subgoal users.
- **Fix:** compute the badge from the **full unfiltered goal graph** (one shared
  `descendants(goalId)`), independent of which render path draws the row. (→ T4/T5.)

### D7 — Mobile has no forest path; divergent near-copy of desktop bucketing
- **Anchors:** `render.ts:461-549`: top-level goals render flat via `renderGoalGroup(goal)`
  — no `buildNestedGoalForest`, no indentation, no truncation row, no
  archived-into-live-forest folding, no title-suffix pass. Additionally mobile drops goals
  without `projectId` (`render.ts:485`) while desktop resolves via the parent-chain walk
  (`sidebar.ts:1599-1611`) — a spawned child that inherits its project from its parent
  renders on desktop but is **silently missing on mobile**.
- **Trigger:** a child goal not claimed by Path A (parent's lead terminated/purged, or
  unstamped) renders as an un-indented top-level row on mobile; a child with inherited
  projectId is missing on mobile entirely.
- **Severity:** medium. Commit `62755c3d` fixed only the duplicate-row symptom of this
  divergence, not the divergence. (→ T6.)

### D8 — Role-picker popover renders once per project section
- **Anchors:** `${renderRolePickerDropdown()}` inside the per-project Sessions header loop —
  `sidebar.ts:1433` (desktop) and `render.ts:577` (mobile). With N projects and
  `state.rolePickerOpen`, N identical `position:fixed` popovers stack. The capture-phase
  keyboard handler and `_focusCwdIfNeeded` target
  `document.querySelector(".cwd-combobox input")` — the **first** copy in DOM order
  (`sidebar.ts:637-639, :786-789`), which can sit *under* the painted copy: focus/caret
  land on an occluded element.
- **Severity:** low (state-driven copies stay in sync; caret/focus artifacts + N× DOM and
  listeners). **Fix:** render the popover exactly once at the sidebar root (it is
  `position:fixed`-anchored anyway). (→ T8.)

### D9 — Unstamped children render under multiple leads (duplicate rows)
- **Anchors:** `selectSpawnedChildren`'s unstamped branch matches whenever
  `leadId === parentLeadId` (`sidebar-spawned-children.ts:63-68`), and both call sites pass
  `leadId` as its own `parentLeadId`: the live lead (`render-helpers.ts:1489-1495`) **and
  each archived lead** (`render-helpers.ts:1620-1621`, rendered via `renderLeadWithMembers`
  `:1627-1650` alongside the live branch).
- **Trigger:** showArchived ON; the goal has a live team-lead **and** ≥1 archived team-lead
  (team restarted); a child with `parentGoalId` set but no `spawnedBySessionId` (created
  via `createGoal(..., parentGoalId)` from the proposal modal's subgoal prefill, or legacy
  data). The child renders under the live lead AND under each archived lead.
- **Severity:** medium — the exact bug class the dedupe E2E was written for, but
  `tests/e2e/ui/sidebar-spawned-children-dedupe.spec.ts` only covers stamped same-title
  siblings, and `tests/sidebar-spawned-children.test.ts` tests one call at a time (no
  global at-most-once assertion). The browser fixture
  (`tests/sidebar-spawned-children.html`) is a drifted mirror without the `parentLeadId`
  parameter.
- **Fix (tactical):** unstamped children attach to exactly one lead (live if present, else
  most-recent archived). **Strategic:** T5 removes the per-lead enumeration entirely.

### D10 — Claim/Path-A lead-choice disagreement can hide a goal completely
- **Anchors:** `computeSpawnedClaim` picks `liveLeadCandidates[0]` in **input order**; its
  own comment concedes the order may disagree with Path A's createdAt sort and asserts the
  consequence is harmless (`sidebar-spawned-children.ts:176-188`). It is not: if a stamped
  child's `spawnedBySessionId` is lead₂ but Path A picks lead₁ (`render-helpers.ts:1347`
  sort + `:1446` find), the claim excludes the child from the forest **and** Path A never
  renders it → the goal is invisible in the sidebar.
- **Trigger:** two live `team-lead` sessions for one goal (respawn/recovery) with server
  list order ≠ createdAt order.
- **Severity:** medium impact, low-medium reachability. Fixed by construction under T5.

### D11 — Archived-forest exclusion filter is global, not tree-scoped
- **Anchors:** `render-helpers.ts:887-894` — an archived goal is excluded from the bottom
  Archived forest if its `spawnedBySessionId` matches **any** archived team-lead in
  `state.archivedSessions`. If that lead's parent goal is purged/not rendered in this
  section, the goal renders **nowhere**. Placement is also pagination-dependent: before the
  lead's archived page loads the goal shows in the forest; after "Load more" it silently
  relocates under the lead.
- **Severity:** low-medium (invisible/jumping archived goals).
- **Fix:** exclude only when the spawning lead will actually be rendered in this project's
  archived section. (→ T9, or by construction under T5.)

### D12 — Detached parent-cycles vanish silently
- **Anchors:** `sidebar-nesting.ts:186-195` — root detection is "no parent or parent
  absent"; the `visited` cycle guard (`:135-150`) fires only for cycles reachable from a
  root. A detached A↔B cycle yields no root → neither renders, no warning.
- **Severity:** very-low reachability; silent-data-hiding class. **Fix:** after root
  collection, emit unvisited goals as degraded roots + `console.warn`. (→ T9.)

### D13 — Minor confirmed items
- **Auto-expand misses team goals:** `api.ts:429` checks only `s.goalId === g.id`, not
  `teamGoalId` — newly discovered team goals don't auto-expand; the dedupe E2E's helper
  comment ("expansion timing-sensitive") works around this symptom
  (`sidebar-spawned-children-dedupe.spec.ts:26-31`).
- **Render-time fetch staleness:** the on-demand team-agents fetch inside `renderGoalGroup`
  (`render-helpers.ts:1375-1403`) can push into `state.archivedSessions` *after*
  `clearArchivedSessionsState()` emptied it (toggle-off race) — no staleness token.
- **Unbounded maps:** `_prevSessionStatus` (api.ts), `gateStatusCache`/`prStatusCache`
  never pruned for deleted goals; `expandedGoals` localStorage accretes dead ids (only
  archived ones are pruned, `state.ts:650-655`).
- **Stale comment claiming a nonexistent optimization:** `computeSpawnedClaim` says "Avoid
  an O(parents × sessions) scan: bucket sessions by parent goal id once"
  (`sidebar-spawned-children.ts:160-163`) — the code below does exactly the
  O(parents × sessions) filter-per-parent it claims to avoid, per project per render frame
  (again on mobile).

---

## 3. Structural findings (the defect factories)

### S1 — Two render paths + a hand-maintained mirror "claim" function for one relation
Path A: `renderGoalGroup → renderTeamGroup → selectSpawnedChildren`
(`render-helpers.ts:1450-1545` + archived-leads branch `:1594-1652`). Path B:
`buildNestedGoalForest → renderNestedNode` (`sidebar.ts:1310-1400`). Disjointness is
enforced by `computeSpawnedClaim`, documented as a mirror of render-helpers. This produced
`62755c3d`, D6, D9, D10, D11 — and two different expansion semantics for the same child
(Path A children hide under `isTeamLeadExpanded(lead)`, Path B children under
`expandedGoals.has(parent)`; the same goal switches regimes when its lead's session is
purged).
**Refactor:** one pure, memoized per-project tree build that assigns every goal exactly one
display anchor: `{ parent: goalId | null, slot: "forest" | { teamLeadId } }`. One recursive
renderer consumes it for live, archived, desktop, mobile, collapsed. `computeSpawnedClaim`
is deleted; the double-render and invisible-goal classes become unrepresentable.
**Migration risk:** medium — placement edge cases (unstamped, archived-lead, pagination);
must land after the pinning tests (T1) and behind the existing E2E suite.

### S2 — Six independent goal-tree derivations
`buildNestedGoalForest` (sidebar-nesting.ts); `selectSpawnedChildren`/`computeSpawnedClaim`
(sidebar-spawned-children.ts); `countDescendants` (goal-descendants-count.ts) +
`collectGoalIdsFor` (`api.ts:1399-1417`); the `projectIdForGoal` chain-walk
(`sidebar.ts:1599-1611`); `buildChildSummaries` (`goal-dashboard-children-tab.ts:35-57`);
the plan-tab direct-children filter (`goal-dashboard-plan-tab.ts:98-113`). Each
re-implements parent indexing, archived rules, and cycle guards with subtle differences.
**Refactor:** `src/app/goal-graph.ts` — one memoized index (`byId`, `childrenByParent`,
`descendants()`, `directChildren()`, `depthOf()`, `projectOf()` with chain fallback,
cycle-safe), invalidated on `goalsGeneration` change. Removes D7's mobile projectId drop
and the badge inconsistency by construction.

### S3 — Data-flow: ad-hoc pull, no epoch discipline
`refreshSessions` is the de-facto store update but is called from ~25 sites with no
coordination (D1–D5). Gate-status and PR caches already demonstrate the correct patterns in
this codebase — sessions/goals, the most important lists, are the only ones without them.
**Refactor:** a `requestSync()` façade: coalesce concurrent callers onto one in-flight
promise, debounce WS-event bursts (~100ms), apply responses only when the generation is
monotonic. All call sites switch mechanically.

### S4 — Desktop/mobile/collapsed are three drifting copies
Project bucketing + section rendering exists 3×: `renderSidebar`/`renderProjectContent`
(`sidebar.ts:1458-1724`), `renderMobileLanding` (`render.ts:461-622`),
`renderCollapsedSidebar` (`sidebar.ts:1730-1887`). Mobile has drifted twice already
(`62755c3d`; D7). Shared pieces (`renderGoalGroup`, `renderProjectArchivedSection`,
`renderStaffSidebarSection`) prove the parameterized pattern works.
**Refactor:** extract `bucketSidebarDataByProject()` (pure, using S2's `projectOf`) + a
variant-parameterized project-section renderer (`"desktop" | "mobile"`). Collapsed stays
bespoke but consumes the same buckets.

### S5 — Test fidelity: mirrors with confirmed drift; the core builder untested
`tests/sidebar-spawned-children.html` reimplements `selectSpawnedChildren` **without** the
`parentLeadId` fallback and the archived-first sort — it pins a stale version.
`tests/sidebar-hierarchy.html` and `tests/sidebar-goal-rendering.html` self-describe as
mirrors. `buildNestedGoalForest` has **no direct tests at all**. The real renderer is
exercised only by spawned-gateway E2Es.
**Refactor:** the pure modules are already DOM-free with test overrides
(`_setSubgoalsEnabledForTesting`) — pin them with node:test against the **real source**;
retire mirror fixtures or rebuild them on bundled real modules.

### S6 — Unkeyed list rendering
No `repeat()` anywhere in the sidebar (only MessageList/tab code uses it). All rows are
`.map()` → positional DOM reuse: when a row is inserted/re-sorted (new session, archived
bucket boundary moves), DOM nodes rebind to different entities — keyboard focus and running
CSS animations (`bobbit-unread-pulse`, spinners) silently transfer to a different
session/goal. Expansion state is module-state (survives correctly), so this is the
remaining redraw-correctness gap.
**Refactor:** `repeat(items, x => x.id, render)` for project sections, goal nodes, session
rows. Low risk, mechanical.

---

## 4. Ordered task backlog (hand-off ready)

Conventions: master stays green (`npm run check`, `npm run test:unit`, `npm run test:e2e`);
test-first (red on master where expressible); no flaky tests; anchors verified at
`6ec8c8f9` — re-verify before editing.

### T1 — Pin the pure tree builders with real-source tests *(no deps; prerequisite for T5/T6)*
- **Files:** NEW `tests/sidebar-nesting.test.ts`; extend
  `tests/sidebar-spawned-children.test.ts`; delete-or-rebuild
  `tests/sidebar-spawned-children.html` (drifted mirror: missing `parentLeadId` + the
  archived-first sort).
- **Diagnosis:** `buildNestedGoalForest` (the core tree builder) has zero direct tests; the
  existing browser fixture pins a stale mirror (S5); nothing asserts global at-most-once
  emission of a child across the live-lead + archived-lead branches (D9's gap).
- **Fix:** node:test suites importing the real TS (`_setSubgoalsEnabledForTesting(true)`),
  covering: orphan promotion, depth cap + `truncatedChildrenCount`, archived-first sort,
  title suffixes (root + nested), cycle stubs, flag-off flattening; plus a cross-branch
  test asserting **global at-most-once emission** of an unstamped child across live-lead +
  archived-lead `selectSpawnedChildren` calls — this test documents D9 red.
- **Acceptance:** tests run in the unit phase; the D9 case is either fixed inline (tactical
  single-anchor rule) or committed as a tracked known-failure pin for T5.

### T2 — `refreshSessions` concurrency hardening *(no deps)*
- **Files:** `src/app/api.ts:299-498`; NEW `tests/refresh-sessions-race.test.ts` (extract
  the apply/merge step into a pure helper, the `session-load-state.ts` pattern).
- **Diagnosis:** D1/D2/D5 — no in-flight coalescing, no monotonic-generation acceptance;
  last-arriving stale snapshot clobbers WS-fresh state (ghost rows, status flicker,
  spurious beeps).
- **Fix:** module-level in-flight promise returned to concurrent callers; drop session/goal
  payloads whose `generation` is below current (independently for sessions and goals); keep
  the archived-preserve merge rule.
- **Acceptance:** interleaved-resolution unit test (old response after new → state keeps
  new) red→green; `tests/sidebar-loading-flash.test.ts` stays green; no E2E regressions.

### T3 — Archived freshness + fetch dedup *(after T2)*
- **Files:** `src/app/api.ts:403-421, :871-912`; `src/app/sidebar.ts:1090-1101`.
- **Diagnosis:** D3 (goal archived elsewhere vanishes while showArchived is on), D4
  (loaded-flag set post-await; replace-vs-append race under typing + load-more).
- **Fix:** set `_archivedGoalsLoaded` pre-await + in-flight promise; in the goals merge,
  detect ids that disappeared from the live payload while
  `showArchived && archivedGoalsLoaded()` and debounce a first-page archived re-fetch.
- **Acceptance:** unit test for the disappearance→refetch trigger; rapid-typing search
  issues exactly one archived-goals fetch; NEW E2E: archive a goal via API while
  showArchived is on → it appears in the Archived section without toggling.

### T4 — Single `goal-graph.ts` module *(no hard deps; before T5)*
- **Files:** NEW `src/app/goal-graph.ts`; migrate `goal-descendants-count.ts`,
  `api.ts::collectGoalIdsFor`, `sidebar.ts::projectIdForGoal`,
  `goal-dashboard-children-tab.ts::buildChildSummaries` candidates,
  `goal-dashboard-plan-tab.ts` candidate filter.
- **Diagnosis:** S2 — six divergent derivations of one tree.
- **Fix:** memoized id/parent indices + `descendants()`, `directChildren()`, `projectOf()`
  (chain walk), `depthOf()`, all cycle-guarded; invalidate on `state.goalsGeneration`.
- **Acceptance:** behaviour-preserving (existing tests green); new unit tests for the
  `projectOf` chain fallback and walk-through-archived descendant counting.

### T5 — Unify nesting into one render path *(after T1, T4; the big one)*
- **Files:** `src/app/sidebar-nesting.ts` (extend the node model with team-lead display
  slots); `src/app/render-helpers.ts` (delete `renderTeamGroup`'s spawned-children +
  archived-lead `spawnedSubGoalsOf` blocks; `renderGoalGroup` becomes pure row+sessions);
  `src/app/sidebar.ts:1346-1456`; delete `computeSpawnedClaim` from
  `src/app/sidebar-spawned-children.ts`; update `src/app/render.ts` mobile exclusion.
- **Diagnosis:** S1/D6/D9/D10/D11 — dual paths + the mirror claim function.
- **Fix:** the forest assigns each goal exactly one display anchor (under the parent's
  team-lead slot when a stamped/attributable lead exists, else a plain forest child); the
  badge always = transitive descendants from the full graph (T4); one expansion semantic
  (child visibility = parent goal expanded AND, when slotted, lead expanded — pick one rule
  and pin it).
- **Acceptance:** T1's placement table-tests green (incl. unstamped-child at-most-once);
  `tests/e2e/ui/sidebar-spawned-children-dedupe.spec.ts`, `sidebar-child-loading.spec.ts`,
  archived-layout specs green; NEW E2E asserting the descendant badge on a parent whose
  children are claimed.
- **Dependencies:** T1, T4. Risk: medium (placement edges); rollback = revert to the dual
  path (keep the new tests as documentation of intent).

### T6 — Mobile/desktop reuse *(after T5)*
- **Files:** `src/app/render.ts:461-622`, `src/app/sidebar.ts`, NEW shared
  `bucketSidebarDataByProject` helper.
- **Diagnosis:** D7 — mobile flat-renders unclaimed children, silently drops
  inherited-project goals, no badges/truncation.
- **Fix:** mobile consumes the same forest renderer with `variant: "mobile"` (the
  `renderProjectArchivedSection` pattern).
- **Acceptance:** mobile E2E (pattern: `sidebar-mobile-archived-per-project.spec.ts`)
  showing a nested child indented under its parent on mobile AND a child with inherited
  projectId visible.

### T7 — Keyed sidebar lists *(after T5, to avoid churn)*
- **Files:** `src/app/sidebar.ts`, `src/app/render-helpers.ts`, `src/app/render.ts`.
- **Diagnosis:** S6 — positional DOM reuse transfers focus/animations between entities on
  insertions/re-sorts.
- **Fix:** `repeat()` keyed by entity id for project sections, goal nodes, session rows.
- **Acceptance:** type-check + existing browser E2Es; a focused row's action button still
  targets the same session after a new session is inserted above it (new E2E or fixture).

### T8 — Single-instance role-picker popover *(independent)*
- **Files:** `src/app/sidebar.ts:1433, :485-615`; `src/app/render.ts:577`.
- **Diagnosis:** D8 — N popovers for N projects; keyboard/focus targets the first DOM copy,
  which can be occluded.
- **Fix:** render `renderRolePickerDropdown()` once at the sidebar root; keep per-project
  anchor-rect state.
- **Acceptance:** with ≥2 projects and the picker open, exactly one `.cwd-combobox` exists;
  keyboard nav focuses the visible input.

### T9 — Cleanups bundle *(independent, low risk)*
- **Files/items:** `src/app/api.ts:429` (add `teamGoalId` to auto-expand — also lets the
  dedupe E2E drop its timing workaround); prune `_prevSessionStatus` + gate/PR caches on
  goal/session removal; `src/app/sidebar-nesting.ts` (emit detached-cycle nodes as degraded
  roots + warn, D12); `src/app/render-helpers.ts:887-894` (tree-scope the archived-forest
  exclusion, D11 — skip if T5 already subsumed it); staleness token for the on-demand
  team-agents fetch (`render-helpers.ts:1375-1403`); delete the false "bucket once" comment
  in `sidebar-spawned-children.ts:160-163` (moot after T5).
- **Acceptance:** unit tests per item; an archived goal with a purged parent + archived
  lead renders in the Archived section.

**Suggested order:** T1 ‖ T2 → T3 → T4 → T5 → T6 ‖ T7 → T8 ‖ T9. T2/T3 (data-flow) and
T1/T4/T5 (tree model) are independent tracks until T5; everything visual lands after T5 to
avoid double churn.

---

## 5. Checked and sound (no action)

- **The 5cfc0306 "Loading… blanking" fix is a real root-cause fix**: initial-load keyed off
  `sessionsGeneration` in a pure, real-source-tested helper (`session-load-state.ts`,
  `tests/sidebar-loading-flash.test.ts`).
- **rAF coalescing** (`state.ts:687-712`) is respected by the sidebar; drag suppression
  buffers exactly one render; the streaming bypass (PATH B) is confined to `AgentInterface`
  as documented.
- **Expansion/scroll state survives re-renders** (module/state-backed with localStorage) —
  poll ticks do not collapse accordions.
- **Gate-status and PR caches** have correct last-writer-wins tokens / in-flight guards
  (`api.ts:1084-1161`) — the model T2 copies.
- **Goal-dashboard descendant fetches** are guarded (in-flight flags +
  `currentGoalId === goalId` staleness checks, `goal-dashboard.ts:306-327`); no N+1 per
  nesting level (single `/descendants` call).
- **Unread/read-state:** `markSessionVisited`'s `_readMirror` max() defends against the
  poll racing the mark-read POST (`render-helpers.ts:226-275`); `updateLocalSessionStatus`
  deliberately never touches `lastActivity` (pinned by `tests/spurious-idle-unread.spec.ts`).
- **`buildNestedGoalForest` internals** are well-built (Map dedupe, deterministic sort,
  per-root cycle guard, orphan promotion, depth-cap truncation) — it lacks tests and a
  second-consumer discipline, not quality.
- **Cross-tab project reorder** is sound (optimistic apply + echo + `projects_changed`
  broadcast + equality gate).
