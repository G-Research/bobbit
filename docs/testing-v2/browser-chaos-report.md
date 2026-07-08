# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-08T05:52:48.650Z  |  Run duration: 134.7 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

---

## D8 Unified Burn-Down (authoritative — supersedes the per-cluster reports)

This is the single canonical D8 gate evidence over the **unified 86-entry corpus**
(`tests2/chaos/browser-mutants.json`), folding the two disjoint browser-porting
campaigns (Cluster A UI-surface + Cluster B workflow-surface) into one id space
and running them together for the first time. It is both the authoritative
mutation proof AND the first cross-cluster coexistence check (both clusters'
ported journeys verified jointly, shared-`src/` mutations included).

### Run verdict (empirical, 84 content mutants + 2 null)

| Metric | Value |
|--------|-------|
| Corpus entries | **86** (2 null + 84 content) |
| Legacy-caught | 81 / 84 |
| V2-caught | 83 / 84 |
| **Real journey holes** (legacy-caught, v2-missed) | **0** ✅ |
| **Both-missed** | **1** — `BR26` staff-triggers (known tracked justification) |
| **v2-stronger** (legacy-missed, v2-caught) | **2** — `BR07` notification-policy, `BR70` stories-goal-routing |
| **Null-mutant integrity** | ✅ **PASS** — `BR00-null` + `BR50-null` both missed by both suites |
| Duration | 134.7 min |

**Acceptance — all met:** every legacy-caught mutant is also v2-caught (0 real
holes); v2 kill count ≥ legacy (83 ≥ 81) overall and per area; the ONLY
both-missed is the pre-existing `BR26` staff-triggers gap (tracked in
`consolidation-assertion-parity.md`) — **no NEW both-missed appeared**; null
integrity passed. No port regressed under the unified run.

> **v2-stronger note.** The joint run empirically found **2** v2-stronger mutants:
> `BR70` (multi-project goal-routing picker — Cluster A already flagged this) and
> `BR07` (notification-policy / unseen-activity). `BR07` was *campaign-classified
> as held-by-existing-coverage*; the joint run shows the v2 journey actually
> catches a mutant the legacy suite **misses** — a strengthening, not a
> regression. The reconciled table below keeps the campaign classification and
> footnotes `BR07`.

### Reconciled completeness denominator (journey-tier behaviours)

Both campaigns closed their D8 denominators (Cluster A 44/44, Cluster B 24/24 as
originally reported). Reconciled into one consistent table below: **total N
flagged in-scope journey-tier behaviours → M mutated/resolved (M == N), 0 TODO**,
split into hole-closed / held-by-existing-coverage / both-missed-justified /
v2-stronger, with excluded-tier reported separately (flagged but not mutated,
with reasons).

| Domain (cluster) | in-scope N=M | hole-closed | held | both-missed-just. | v2-stronger | excluded-tier |
|---|--:|--:|--:|--:|--:|--:|
| app-smoke (A) | 8 | 6 | 2 | 0 | 0 | 11 |
| misc (A) | 14 | 12 | 2 | 0 | 0 | 3 |
| sidebar-nav (A) | 8 | 6 | 2 | 0 | 0 | 12 |
| prompt-interaction (A) | 6 | 4 | 2 | 0 | 0 | 5 |
| stories-registry (A) | 8 | 2 | 5 | 0 | 1 | 0 |
| **Cluster A subtotal** | **44** | **30** | **13** | **0** | **1** | **31** |
| goal-team-gates (B) | 1 | 0 | 1 | 0 | 0 | 0 |
| goal-editing (B) | 8 | 5 | 3 | 0 | 0 | 0 |
| project-onboarding (B) | 6 | 5 | 1 | 0 | 0 | 7 |
| project-settings (B) | 9 | 7 | 1 | 1 | 0 | 0 |
| proposals (B) | 10 | 7 | 0 | 3 | 0 | 0 |
| team-operations (B) | 7 | 3 | 4 | 0 | 0 | 1 |
| session-lifecycle (B) | 0 | 0 | 0 | 0 | 0 | 2 |
| **Cluster B subtotal** | **41** | **27** | **10** | **4** | **0** | **10** |
| **UNIFIED TOTAL** | **85** | **57** | **23** | **4** | **1** | **41** |

`M == N == 85` in-scope journey-tier behaviours, 0 TODO. In-scope split sums to
N: `57 + 23 + 4 + 1 = 85`. Excluded-tier (41) is flagged-but-not-mutated with
per-behaviour reasons in the archived cluster tallies
(`browser-chaos-porting-tally-cluster{A,B}.md`). Total flagged = `85 + 41 = 126`.

> ¹ `hole-closed` counts behaviours where a real hole (legacy-caught,
> journey-missed) was closed by porting an assertion into the owning journey and
> re-verifying v2-caught. It includes the 9 canonical-corpus mutants ported
> pre-cluster in Cluster-B domains (`BR20/21/22/25/27/36/39/41/43`), attributed
> to their home domains and counted **once**.
> ² `v2-stronger` here is the campaign count (1 = `BR70`); the empirical joint
> run reveals 2 (adds `BR07`, campaign-classified held) — see the note above.

### Cluster B arithmetic fix

The Cluster B fragment originally reported `N = 24` with the breakdown
`18 hole-closed + ~9 held + 4 both-missed = 31`, which is internally
inconsistent (31 ≠ 24). Two double-counts / omissions were corrected:

1. **The "~9 held" were actually 9 canonical-corpus `closed-earlier` mutants**
   (`BR20, BR21, BR22, BR25, BR27, BR36, BR39, BR41, BR43`) — those are
   **hole-closed** (a ported/covering assertion exists), not "held", and they
   belong to Cluster-B domains. They are folded into **hole-closed (→ 27)** and
   counted exactly once (not credited to both the canonical corpus and Cluster B).
2. **The 10 genuine held-by-existing-coverage behaviours were omitted** from the
   headline breakdown.

Corrected Cluster B in-scope: **N = M = 41 = hole-closed 27 + held 10 +
both-missed-justified 4** (consistent). The 4 both-missed
(`goal-proposal-invalid-workflow`, `goal-proposal-dismiss-reload`,
`proposal-spec-survives-navigate`, `goal-reattempt-project-binding`) had their
mutants **reverted** (each is guarded by multiple redundant client paths, so no
single-line mutant is detectable by *either* suite) with the journey ports kept
as added coverage — they are **not** corpus mutants, so they do not appear in the
run above. This is distinct from `BR26`, which **is** a retained corpus mutant
and the single both-missed of the run.

---

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 84 | 84 |
| With targeted catchers | 84 | 84 |
| Caught | 81 | 83 |
| Missed | 3 | 1 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 0 | 0 |
| **Kill rate (of killable)** | **96.4%** | **98.8%** |

**Null-mutant integrity:** ✅ PASSED (no suite caught a no-op patch)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ✅ PASS
- **V2 ≥ legacy overall (kill count):** ✅ PASS (v2 83 vs legacy 81)
- **Both-missed (coverage gap — new test or tracked justification needed):** ⚠️ 1:
  - BR26 (staff-debug): A goal-scoped staff trigger no longer labels its wake prompt 'required'. Campaign result: BOTH-MISSED — the legacy staff-triggers.spec.ts does NOT assert this label either (it covers the trigger dropdown + PUT/GET round-trip), so this is a pre-existing browser-e2e gap, not a consolidation regression (tracked in consolidation-assertion-parity.md). Add a staff-trigger-editor assertion when that editor flow is journey-covered.
- **All journey kills attributed to a specific test:** ✅ PASS (83/83)

## Per-area Comparison (v2 journeys ≥ legacy is the verdict)

| Area | Mutants | Legacy caught | V2 caught | Real journey miss | Inconclusive | v2 ≥ legacy (runnable) |
|------|---------|---------------|-----------|-------------------|--------------|------------------------|
| plan-tab | 2 | 2 | 2 | — | — | ✅ |
| goal-proposal | 3 | 3 | 3 | — | — | ✅ |
| panel-tabs | 1 | 1 | 1 | — | — | ✅ |
| notification-policy | 1 | 0 | 1 | — | — | ✅ |
| goal-dashboard | 1 | 1 | 1 | — | — | ✅ |
| goal-status-widget | 1 | 1 | 1 | — | — | ✅ |
| delegate-renderer | 1 | 1 | 1 | — | — | ✅ |
| sidebar-search | 1 | 1 | 1 | — | — | ✅ |
| session-actions | 1 | 1 | 1 | — | — | ✅ |
| draft-persistence | 1 | 1 | 1 | — | — | ✅ |
| add-project | 3 | 3 | 3 | — | — | ✅ |
| app-smoke | 1 | 1 | 1 | — | — | ✅ |
| misc-api-error | 1 | 1 | 1 | — | — | ✅ |
| misc-cost | 1 | 1 | 1 | — | — | ✅ |
| team-operations | 2 | 2 | 2 | — | — | ✅ |
| proposals | 1 | 1 | 1 | — | — | ✅ |
| prompt-interaction | 1 | 1 | 1 | — | — | ✅ |
| stories-sessions | 1 | 1 | 1 | — | — | ✅ |
| project-settings | 1 | 1 | 1 | — | — | ✅ |
| staff-debug | 2 | 1 | 1 | — | — | ✅ |
| project-onboarding | 1 | 1 | 1 | — | — | ✅ |
| marketplace-packs | 2 | 2 | 2 | — | — | ✅ |
| misc-auto-retry | 1 | 1 | 1 | — | — | ✅ |
| app-smoke-github-hosts | 1 | 1 | 1 | — | — | ✅ |
| misc-image-model | 1 | 1 | 1 | — | — | ✅ |
| stories-headquarters | 1 | 1 | 1 | — | — | ✅ |
| sidebar-archived | 1 | 1 | 1 | — | — | ✅ |
| project-settings-roles | 1 | 1 | 1 | — | — | ✅ |
| app-smoke-replace-bobbit | 1 | 1 | 1 | — | — | ✅ |
| team-operations-gate-bypass | 1 | 1 | 1 | — | — | ✅ |
| project-settings-sysprompt | 1 | 1 | 1 | — | — | ✅ |
| staff-debug-role | 1 | 1 | 1 | — | — | ✅ |
| goal-editing-parent-picker | 1 | 1 | 1 | — | — | ✅ |
| goal-editing-subgoals-toggle | 1 | 1 | 1 | — | — | ✅ |
| proposals-workflow-error | 1 | 1 | 1 | — | — | ✅ |
| goal-editing-nesting | 1 | 1 | 1 | — | — | ✅ |
| proposals-subgoal-prefill | 1 | 1 | 1 | — | — | ✅ |
| misc-workflow-editor | 1 | 1 | 1 | — | — | ✅ |
| project-settings-maintenance | 1 | 1 | 1 | — | — | ✅ |
| misc-role-tabs | 1 | 1 | 1 | — | — | ✅ |
| project-onboarding-typeahead | 1 | 1 | 1 | — | — | ✅ |
| misc-prompt-stats | 1 | 1 | 1 | — | — | ✅ |
| misc-preview-newtab | 1 | 1 | 1 | — | — | ✅ |
| misc-compaction-card | 1 | 1 | 1 | — | — | ✅ |
| sidebar-full-search-nav | 1 | 1 | 1 | — | — | ✅ |
| app-smoke-open-new-window | 1 | 1 | 1 | — | — | ✅ |
| prompt-at-mention-chip | 1 | 1 | 1 | — | — | ✅ |
| app-smoke-goal-metadata | 1 | 1 | 1 | — | — | ✅ |
| sidebar-show-read-filter | 1 | 1 | 1 | — | — | ✅ |
| misc-review-approve | 1 | 1 | 1 | — | — | ✅ |
| misc-image-attach | 1 | 1 | 1 | — | — | ✅ |
| misc-workflow-page-scope | 1 | 1 | 1 | — | — | ✅ |
| prompt-ask-user-choices | 1 | 1 | 1 | — | — | ✅ |
| sidebar-new-goal | 1 | 1 | 1 | — | — | ✅ |
| sidebar-new-session | 1 | 1 | 1 | — | — | ✅ |
| prompt-queue-ui | 1 | 1 | 1 | — | — | ✅ |
| prompt-escape-abort | 1 | 1 | 1 | — | — | ✅ |
| prompt-tool-ask-policy | 1 | 1 | 1 | — | — | ✅ |
| sidebar-search-result-nav | 1 | 1 | 1 | — | — | ✅ |
| app-smoke-keyboard-nav | 1 | 1 | 1 | — | — | ✅ |
| stories-goal-routing | 1 | 0 | 1 | — | — | ✅ |
| goal-editing-existing-subgoal-settings | 1 | 1 | 1 | — | — | ✅ |
| project-settings-agent-dir | 1 | 1 | 1 | — | — | ✅ |
| proposals-editable-accept | 1 | 1 | 1 | — | — | ✅ |
| project-onboarding-select-all | 1 | 1 | 1 | — | — | ✅ |
| project-onboarding-post-archive | 1 | 1 | 1 | — | — | ✅ |
| team-operations-archive-child-cascade | 1 | 1 | 1 | — | — | ✅ |
| goal-editing-archive-readonly-banner | 1 | 1 | 1 | — | — | ✅ |
| goal-editing-form-tooltip-title | 1 | 1 | 1 | — | — | ✅ |
| project-settings-restart-button-hidden | 1 | 1 | 1 | — | — | ✅ |
| proposals-revision-autoupdate | 1 | 1 | 1 | — | — | ✅ |
| proposals-workflow-tab-customise | 1 | 1 | 1 | — | — | ✅ |
| goal-editing-creation-optional-steps | 1 | 1 | 1 | — | — | ✅ |
| project-settings-project-assistant-provisional | 1 | 1 | 1 | — | — | ✅ |
| project-onboarding-multi-repo-subset | 1 | 1 | 1 | — | — | ✅ |
| proposals-project-workflow-views | 1 | 1 | 1 | — | — | ✅ |

**Per-area v2 ≥ legacy:** ✅ PASS (no area has a real journey miss; ✅* = has env-inconclusive to re-run)

## Full Mutant Matrix

| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |
|----|------|------|----|--------|-----|---------------------|----------|
| BR00-null *(null)* | harness-integrity | `src/app/goal-dashboard-plan-tab.ts` | no-op | ⚪ missed | ⚪ missed | — | 31.0s |
| BR01 | plan-tab | `src/app/goal-dashboard-plan-tab.ts` | inverted-boolean | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-team-gates.journey.spec.ts › Journey: Plan-Tab Gate-Status — ` | 68.1s |
| BR02 | plan-tab | `src/app/goal-dashboard-plan-tab.ts` | dropped-attribute | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-team-gates.journey.spec.ts › Journey: Plan-Tab Gate-Status — ` | 64.8s |
| BR03 | goal-proposal | `src/app/proposal-panels.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Empty Workflows Banne` | 74.8s |
| BR04 | goal-proposal | `src/app/proposal-panels.ts` | dropped-render | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — behavioral › goal` | 229.3s |
| BR05 | goal-proposal | `src/app/proposal-panels.ts` | removed-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — behavioral › goal` | 116.4s |
| BR06 | panel-tabs | `src/app/render.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — behavioral › role` | 87.2s |
| BR07 | notification-policy | `src/app/render-helpers.ts` | forced-false | ⚪ missed | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Notification Policy › fresh sessio` | 88.0s |
| BR08 | goal-dashboard | `src/app/goal-dashboard.ts` | inverted-comparison | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Dashboard Mutation Pend` | 144.2s |
| BR09 | goal-status-widget | `src/ui/components/GoalStatusWidget.ts` | inverted-conditional | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Goal Status Widget — be` | 90.7s |
| BR10 | delegate-renderer | `src/ui/tools/renderers/DelegateRenderer.ts` | off-by-one | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Team Delegate Card — be` | 88.7s |
| BR11 | sidebar-search | `src/app/sidebar.ts` | match-all | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › sideba` | 67.1s |
| BR12 | session-actions | `src/app/session-actions.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\session-lifecycle.journey.spec.ts › Journey: Fork Session › fork a` | 34.2s |
| BR13 | draft-persistence | `src/app/session-manager.ts` | dropped-restore | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Draft Persistence › draft res` | 93.2s |
| BR14 | add-project | `src/app/dialogs.ts` | renamed-label | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 95.7s |
| BR15 | add-project | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 112.3s |
| BR16 | add-project | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 119.4s |
| BR17 | app-smoke | `src/app/render.ts` | dropped-suffix | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: App Smoke › document title ca` | 60.9s |
| BR18 | misc-api-error | `src/ui/components/ErrorDetails.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: API Error Modal › createGoal 400 s` | 79.1s |
| BR19 | misc-cost | `src/ui/components/CostPopover.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Cost Cache-Hit › goal-dashboard co` | 90.0s |
| BR20 | team-operations | `src/app/goal-dashboard.ts` | off-by-one | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Dashboard Fanout — beha` | 116.3s |
| BR21 | team-operations | `src/ui/components/GoalStatusWidget.ts` | forced-attribute | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Goal Status Widget — be` | 61.3s |
| BR22 | proposals | `src/ui/tools/renderers/ProposalRenderer.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — API error handlin` | 101.9s |
| BR23 | prompt-interaction | `src/ui/components/MessageEditor.ts` | dropped-class | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 82.8s |
| BR24 | stories-sessions | `src/ui/components/MessageEditor.ts` | removed-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\stories-registry.journey.spec.ts › Story Contract Coverage (CT-02 ` | 63.7s |
| BR25 | project-settings | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Project Assistant › mo` | 57.8s |
| BR26 | staff-debug | `src/app/render-triggers.ts` | inverted-label | ⚪ missed | ⚪ missed | — | 23.0s |
| BR27 | project-onboarding | `src/app/dialogs.ts` | forced-attribute | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 69.6s |
| BR28 | marketplace-packs | `src/app/marketplace-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\marketplace-packs.journey.spec.ts › Journey: Marketplace Packs › m` | 58.3s |
| BR29 | misc-auto-retry | `src/ui/components/AgentInterface.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Auto-Retry Banner › auto_retry_pen` | 88.4s |
| BR30 | app-smoke-github-hosts | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: GitHub Trusted Hosts › adding` | 166.5s |
| BR31 | staff-debug | `src/app/sidebar.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\staff-debug.journey.spec.ts › Journey: Staff Sidebar Header › crea` | 68.6s |
| BR32 | misc-image-model | `src/ui/components/AgentInterface.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Footer Image Model › footer shows ` | 69.8s |
| BR33 | marketplace-packs | `src/app/marketplace-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\marketplace-packs.journey.spec.ts › Journey: Marketplace Installed` | 53.7s |
| BR34 | stories-headquarters | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\stories-registry.journey.spec.ts › Journey: Headquarters Visibilit` | 91.8s |
| BR35 | sidebar-archived | `src/app/render-helpers.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › Show A` | 56.8s |
| BR36 | project-settings-roles | `src/app/role-manager-page.ts` | renamed-label | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Project Assistant › ro` | 57.9s |
| BR37 | app-smoke-replace-bobbit | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Replace Bobbit Text › setting` | 60.7s |
| BR38 | team-operations-gate-bypass | `src/ui/components/GoalStatusWidget.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Gate Bypass › failed ga` | 49.2s |
| BR39 | project-settings-sysprompt | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Customise System Promp` | 52.3s |
| BR40 | staff-debug-role | `src/app/staff-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\staff-debug.journey.spec.ts › Journey: Staff Role Select › staff e` | 50.8s |
| BR41 | goal-editing-parent-picker | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Subgoal Parent Picker › Su` | 100.8s |
| BR42 | goal-editing-subgoals-toggle | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Subgoals Experimental Togg` | 188.6s |
| BR43 | proposals-workflow-error | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Failed Goal Proposal › MISSIN` | 96.4s |
| BR44 | goal-editing-nesting | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Subgoal Nesting Limit — be` | 117.0s |
| BR45 | proposals-subgoal-prefill | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Goal Proposal — Sub-goals pre` | 98.8s |
| BR46 | misc-workflow-editor | `src/app/workflow-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Workflow Editor › workflow editor ` | 237.1s |
| BR47 | project-settings-maintenance | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Settings Maintenance —` | 101.3s |
| BR48 | misc-role-tabs | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Goal Proposal Roles Tab › Roles ta` | 92.1s |
| BR49 | project-onboarding-typeahead | `src/ui/components/DirectoryPicker.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 88.6s |
| BR50-null *(null)* | harness-integrity | `src/app/workflow-page.ts` | no-op | ⚪ missed | ⚪ missed | — | 50.3s |
| BR51 | misc-prompt-stats | `src/ui/components/AgentInterface.ts` | attribute-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Prompt Stats › stats bar shows mod` | 113.1s |
| BR52 | misc-preview-newtab | `src/app/render.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Preview Artifacts › preview mount ` | 51.3s |
| BR53 | misc-compaction-card | `src/ui/tools/renderers/CompactionSummaryRenderer.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Compaction › seeded compaction sid` | 101.4s |
| BR54 | sidebar-full-search-nav | `src/app/sidebar.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › Full S` | 51.6s |
| BR55 | app-smoke-open-new-window | `src/app/session-actions.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Open in New Window › session ` | 63.6s |
| BR56 | prompt-at-mention-chip | `src/ui/components/FileMentionChip.ts` | class-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 122.6s |
| BR57 | app-smoke-goal-metadata | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Goal Proposal Metadata Tab › ` | 537.0s |
| BR58 | sidebar-show-read-filter | `src/ui/components/sidebar-filters.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › Filter` | 78.1s |
| BR59 | misc-review-approve | `src/ui/components/review/ReviewPane.ts` | label-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Review Commenting › Approve in the` | 175.7s |
| BR60 | misc-image-attach | `src/ui/components/Messages.ts` | tag-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Image Attachment › attached image ` | 80.8s |
| BR61 | misc-workflow-page-scope | `src/app/routing.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Workflow Editor › legacy #/workflo` | 71.4s |
| BR62 | prompt-ask-user-choices | `src/ui/components/AskUserChoicesWidget.ts` | class-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 197.4s |
| BR63 | sidebar-new-goal | `src/app/sidebar.ts` | label-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › New Go` | 67.0s |
| BR64 | sidebar-new-session | `src/app/sidebar.ts` | label-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › New Se` | 87.6s |
| BR65 | prompt-queue-ui | `src/ui/components/MessageEditor.ts` | class-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 76.4s |
| BR66 | prompt-escape-abort | `src/ui/components/MessageEditor.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 55.8s |
| BR67 | prompt-tool-ask-policy | `src/ui/components/ToolPermissionCard.ts` | label-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 197.8s |
| BR68 | sidebar-search-result-nav | `src/app/search-page.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › full-s` | 60.5s |
| BR69 | app-smoke-keyboard-nav | `src/app/main.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Sidebar Keyboard Nav › Ctrl+A` | 54.8s |
| BR70 | stories-goal-routing | `src/ui/components/ProjectPickerPopover.ts` | dropped-attr | ⚪ missed | 🔴 caught | `tests2\browser\journeys\stories-registry.journey.spec.ts › Journey: Goal Routing (multi-pr` | 53.7s |
| BR71 | goal-editing-existing-subgoal-settings | `src/app/goal-dashboard-children-tab.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Subgoal Existing Goal Sett` | 73.3s |
| BR72 | project-settings-agent-dir | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Settings Maintenance —` | 58.5s |
| BR73 | proposals-editable-accept | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Editable Project Proposal › e` | 98.9s |
| BR74 | project-onboarding-select-all | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 71.6s |
| BR75 | project-onboarding-post-archive | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 61.8s |
| BR76 | team-operations-archive-child-cascade | `src/app/session-manager.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Archive Child Cascade —` | 61.9s |
| BR77 | goal-editing-archive-readonly-banner | `src/app/goal-dashboard.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Archive Always-On — b` | 75.9s |
| BR78 | goal-editing-form-tooltip-title | `src/app/proposal-panels.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Form Tooltips — behav` | 68.6s |
| BR79 | project-settings-restart-button-hidden | `src/app/settings-page.ts` | disabled-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Settings Restart Butto` | 50.1s |
| BR80 | proposals-revision-autoupdate | `src/app/session-manager.ts` | disabled-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Goal Proposal — spec survives` | 173.6s |
| BR81 | proposals-workflow-tab-customise | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Goal Proposal — Workflow tab ` | 100.7s |
| BR82 | goal-editing-creation-optional-steps | `src/app/proposal-panels.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Creation — behavioral` | 54.8s |
| BR83 | project-settings-project-assistant-provisional | `src/app/sidebar.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Project Assistant › Ad` | 101.8s |
| BR84 | project-onboarding-multi-repo-subset | `src/app/dialogs.ts` | dropped-filter | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 43.0s |
| BR85 | proposals-project-workflow-views | `src/app/project-proposal-views.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Editable Project Proposal › m` | 111.4s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*