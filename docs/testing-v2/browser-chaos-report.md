# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-07T19:54:23.020Z  |  Run duration: 38.5 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 28 | 28 |
| With targeted catchers | 28 | 28 |
| Caught | 26 | 27 |
| Missed | 2 | 1 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 0 | 0 |
| **Kill rate (of killable)** | **92.9%** | **96.4%** |

**Null-mutant integrity:** ✅ PASSED (no suite caught a no-op patch)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ✅ PASS
- **V2 ≥ legacy overall (kill count):** ✅ PASS (v2 27 vs legacy 26)
- **Both-missed (coverage gap — new test or tracked justification needed):** ⚠️ 1:
  - BR26 (staff-debug): A goal-scoped staff trigger no longer labels its wake prompt 'required'. Legacy staff-triggers.spec.ts asserts goal-* triggers flip the label to 'Wake prompt (required)'; the staff-debug journey never opens the trigger editor (GAP) — expected real hole.
- **All journey kills attributed to a specific test:** ✅ PASS (27/27)

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
| staff-debug | 1 | 0 | 0 | — | — | ✅ |
| project-onboarding | 1 | 1 | 1 | — | — | ✅ |
| marketplace-packs | 1 | 1 | 1 | — | — | ✅ |

**Per-area v2 ≥ legacy:** ✅ PASS (no area has a real journey miss; ✅* = has env-inconclusive to re-run)

## Full Mutant Matrix

| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |
|----|------|------|----|--------|-----|---------------------|----------|
| BR00-null *(null)* | harness-integrity | `src/app/goal-dashboard-plan-tab.ts` | no-op | ⚪ missed | ⚪ missed | — | 37.6s |
| BR01 | plan-tab | `src/app/goal-dashboard-plan-tab.ts` | inverted-boolean | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-team-gates.journey.spec.ts › Journey: Plan-Tab Gate-Status — ` | 69.2s |
| BR02 | plan-tab | `src/app/goal-dashboard-plan-tab.ts` | dropped-attribute | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-team-gates.journey.spec.ts › Journey: Plan-Tab Gate-Status — ` | 56.7s |
| BR03 | goal-proposal | `src/app/proposal-panels.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Empty Workflows Banne` | 71.1s |
| BR04 | goal-proposal | `src/app/proposal-panels.ts` | dropped-render | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — behavioral › goal` | 193.6s |
| BR05 | goal-proposal | `src/app/proposal-panels.ts` | removed-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — behavioral › goal` | 94.9s |
| BR06 | panel-tabs | `src/app/render.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — behavioral › role` | 68.8s |
| BR07 | notification-policy | `src/app/render-helpers.ts` | forced-false | ⚪ missed | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Notification Policy › fresh sessio` | 74.3s |
| BR08 | goal-dashboard | `src/app/goal-dashboard.ts` | inverted-comparison | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Dashboard Mutation Pend` | 142.3s |
| BR09 | goal-status-widget | `src/ui/components/GoalStatusWidget.ts` | inverted-conditional | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Goal Status Widget — be` | 74.8s |
| BR10 | delegate-renderer | `src/ui/tools/renderers/DelegateRenderer.ts` | off-by-one | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Team Delegate Card — be` | 85.3s |
| BR11 | sidebar-search | `src/app/sidebar.ts` | match-all | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › sideba` | 58.6s |
| BR12 | session-actions | `src/app/session-actions.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\session-lifecycle.journey.spec.ts › Journey: Fork Session › fork a` | 32.1s |
| BR13 | draft-persistence | `src/app/session-manager.ts` | dropped-restore | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Draft Persistence › draft res` | 83.2s |
| BR14 | add-project | `src/app/dialogs.ts` | renamed-label | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 78.4s |
| BR15 | add-project | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 89.8s |
| BR16 | add-project | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 103.5s |
| BR17 | app-smoke | `src/app/render.ts` | dropped-suffix | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: App Smoke › document title ca` | 57.3s |
| BR18 | misc-api-error | `src/ui/components/ErrorDetails.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: API Error Modal › createGoal 400 s` | 69.4s |
| BR19 | misc-cost | `src/ui/components/CostPopover.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Cost Cache-Hit › goal-dashboard co` | 83.8s |
| BR20 | team-operations | `src/app/goal-dashboard.ts` | off-by-one | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Dashboard Fanout — beha` | 117.6s |
| BR21 | team-operations | `src/ui/components/GoalStatusWidget.ts` | forced-attribute | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Goal Status Widget — be` | 62.3s |
| BR22 | proposals | `src/ui/tools/renderers/ProposalRenderer.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — API error handlin` | 78.7s |
| BR23 | prompt-interaction | `src/ui/components/MessageEditor.ts` | dropped-class | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 72.7s |
| BR24 | stories-sessions | `src/ui/components/MessageEditor.ts` | removed-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\stories-registry.journey.spec.ts › Story Contract Coverage (CT-02 ` | 64.1s |
| BR25 | project-settings | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Project Assistant › mo` | 51.9s |
| BR26 | staff-debug | `src/app/render-triggers.ts` | inverted-label | ⚪ missed | ⚪ missed | — | 29.7s |
| BR27 | project-onboarding | `src/app/dialogs.ts` | forced-attribute | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 59.0s |
| BR28 | marketplace-packs | `src/app/marketplace-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\marketplace-packs.journey.spec.ts › Journey: Marketplace Packs › m` | 59.8s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*