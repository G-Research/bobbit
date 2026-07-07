# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-07T18:32:01.760Z  |  Run duration: 9.7 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 28 | 28 |
| With targeted catchers | 28 | 28 |
| Caught | 26 | 14 |
| Missed | 2 | 14 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 0 | 0 |
| **Kill rate (of killable)** | **92.9%** | **50.0%** |

**Null-mutant integrity:** ✅ PASSED (no suite caught a no-op patch)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ❌ FAIL
  - ❌ 13 REAL journey hole(s) — the journey RAN and MISSED. Strengthen the journey's assertions (do NOT delete the mutant), then re-run:
    - **BR11** (sidebar-search): Every live GOAL matches any search query (includes('') always true), so the sidebar search never hides non-matching goals. Legacy search-e2e SR-01 asserts a non-matching goal title is hidden after search; the v2 sidebar-nav journey only exercises SESSION-title search (never goal-title), so this is expected to expose a real journey gap: goal-title sidebar search is uncovered by the consolidated journey. — legacy caught via `tests/e2e/ui/search-e2e.spec.ts`; v2 journey `tests2/browser/journeys/sidebar-nav.journey.spec.ts` = MISSED
    - **BR13** (draft-persistence): The message composer never restores a persisted prompt draft on session (re)bind. The journey's draft-persistence-across-reload assertion (textarea value contains the drafted text) must fail. — legacy caught via `tests/e2e/ui/draft-loss.spec.ts`; v2 journey `tests2/browser/journeys/app-smoke.journey.spec.ts` = MISSED
    - **BR17** (app-smoke): document.title drops the ' · Bobbit' suffix. Legacy page-title.spec.ts asserts document.title matches /.+ · Bobbit$/; the app-smoke journey only checks the title is non-empty (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/page-title.spec.ts`; v2 journey `tests2/browser/journeys/app-smoke.journey.spec.ts` = MISSED
    - **BR18** (misc-api-error): The API error modal's message element loses its error-details-message testid. Legacy api-error-modal.spec.ts asserts the server error surfaces in error-details-message; the misc journey does not exercise the error modal (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/api-error-modal.spec.ts`; v2 journey `tests2/browser/journeys/misc.journey.spec.ts` = MISSED
    - **BR19** (misc-cost): The cost popover's cache-hit row loses its cost-cache-hit testid. Legacy cost-popover-cache-hit.spec.ts asserts the cache-hit % renders; the misc journey only best-effort checks a cost element (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/cost-popover-cache-hit.spec.ts`; v2 journey `tests2/browser/journeys/misc.journey.spec.ts` = MISSED
    - **BR20** (team-operations): The workflow-checklist gate-signal-badge count is off by one ('2 signals' for 1 signal). Legacy goal-dashboard-fanout.spec.ts asserts the '1 signal' badge after a gate signal; the team-operations journey stops at the 201 and never asserts the badge (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/goal-dashboard-fanout.spec.ts`; v2 journey `tests2/browser/journeys/team-operations.journey.spec.ts` = MISSED
    - **BR21** (team-operations): The goal-status pill always reports data-awaiting-signoffs="true". Legacy goal-status-widget.spec.ts asserts it is 'false' with no pending sign-offs; the team-operations journey only checks the pill is visible (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/goal-status-widget.spec.ts`; v2 journey `tests2/browser/journeys/team-operations.journey.spec.ts` = MISSED
    - **BR22** (proposals): The proposal tool card's Open button loses its proposal-open-button testid. Legacy proposal-tools.spec.ts asserts the Open button on the tool card; the proposals journey does not drive the tool-card Open flow (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/proposal-tools.spec.ts`; v2 journey `tests2/browser/journeys/proposals.journey.spec.ts` = MISSED
    - **BR23** (prompt-interaction): The @-mention autocomplete menu loses its at-menu class. Legacy at-mention.spec.ts asserts the .at-menu opens on '@'; the prompt-interaction journey does not exercise @-mention (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/at-mention.spec.ts`; v2 journey `tests2/browser/journeys/prompt-interaction.journey.spec.ts` = MISSED
    - **BR24** (stories-sessions): The Send button is no longer disabled on an empty composer. Legacy stories-sessions.spec.ts (S-01) asserts Send is disabled when the composer is empty; the stories-registry journey does not assert Send-disabled (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/stories-sessions.spec.ts`; v2 journey `tests2/browser/journeys/stories-registry.journey.spec.ts` = MISSED
    - **BR25** (project-settings): The session-model-fallback settings toggle loses its testid. Legacy settings-model-fallback.spec.ts asserts the toggle default + PUT round-trip; the project-settings journey only shows the models route (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/settings-model-fallback.spec.ts`; v2 journey `tests2/browser/journeys/project-settings.journey.spec.ts` = MISSED
    - **BR27** (project-onboarding): The Add-Project preflight panel always reports data-has-fail="0", so failing checks never block Continue. Legacy add-project-preflight.spec.ts asserts data-has-fail=1 + Continue disabled for a nested-in-project path; the project-onboarding journey never inspects the preflight panel (GAP) — expected real hole. — legacy caught via `tests/e2e/ui/add-project-preflight.spec.ts`; v2 journey `tests2/browser/journeys/project-onboarding.journey.spec.ts` = MISSED
    - **BR28** (marketplace-packs): The marketplace 'Research Preview' banner loses its testid. Legacy marketplace.spec.ts asserts the research-preview banner renders; the marketplace-packs journey only checks route/tabs (GAP/PARTIAL) — expected real hole. — legacy caught via `tests/e2e/ui/marketplace.spec.ts`; v2 journey `tests2/browser/journeys/marketplace-packs.journey.spec.ts` = MISSED
- **V2 ≥ legacy overall (kill count):** ❌ FAIL (v2 14 vs legacy 26)
- **Both-missed (coverage gap — new test or tracked justification needed):** ⚠️ 1:
  - BR26 (staff-debug): A goal-scoped staff trigger no longer labels its wake prompt 'required'. Legacy staff-triggers.spec.ts asserts goal-* triggers flip the label to 'Wake prompt (required)'; the staff-debug journey never opens the trigger editor (GAP) — expected real hole.
- **All journey kills attributed to a specific test:** ✅ PASS (14/14)

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
| sidebar-search | 1 | 1 | 0 | 1 | — | ❌ |
| session-actions | 1 | 1 | 1 | — | — | ✅ |
| draft-persistence | 1 | 1 | 0 | 1 | — | ❌ |
| add-project | 3 | 3 | 3 | — | — | ✅ |
| app-smoke | 1 | 1 | 0 | 1 | — | ❌ |
| misc-api-error | 1 | 1 | 0 | 1 | — | ❌ |
| misc-cost | 1 | 1 | 0 | 1 | — | ❌ |
| team-operations | 2 | 2 | 0 | 2 | — | ❌ |
| proposals | 1 | 1 | 0 | 1 | — | ❌ |
| prompt-interaction | 1 | 1 | 0 | 1 | — | ❌ |
| stories-sessions | 1 | 1 | 0 | 1 | — | ❌ |
| project-settings | 1 | 1 | 0 | 1 | — | ❌ |
| staff-debug | 1 | 0 | 0 | — | — | ✅ |
| project-onboarding | 1 | 1 | 0 | 1 | — | ❌ |
| marketplace-packs | 1 | 1 | 0 | 1 | — | ❌ |

**Per-area v2 ≥ legacy:** ❌ FAIL — an area has a REAL journey miss; strengthen the journey and re-run

## Full Mutant Matrix

| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |
|----|------|------|----|--------|-----|---------------------|----------|
| BR00-null *(null)* | harness-integrity | `src/app/goal-dashboard-plan-tab.ts` | no-op | ⚪ missed | ⚪ missed | — | 45.1s |
| BR01 | plan-tab | `src/app/goal-dashboard-plan-tab.ts` | inverted-boolean | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-team-gates.journey.spec.ts › Journey: Plan-Tab Gate-Status — ` | 73.9s |
| BR02 | plan-tab | `src/app/goal-dashboard-plan-tab.ts` | dropped-attribute | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-team-gates.journey.spec.ts › Journey: Plan-Tab Gate-Status — ` | 68.2s |
| BR03 | goal-proposal | `src/app/proposal-panels.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Empty Workflows Banne` | 72.4s |
| BR04 | goal-proposal | `src/app/proposal-panels.ts` | dropped-render | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — behavioral › goal` | 214.7s |
| BR05 | goal-proposal | `src/app/proposal-panels.ts` | removed-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — behavioral › goal` | 99.9s |
| BR06 | panel-tabs | `src/app/render.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Proposals — behavioral › role` | 68.8s |
| BR07 | notification-policy | `src/app/render-helpers.ts` | forced-false | ⚪ missed | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Notification Policy › fresh sessio` | 78.7s |
| BR08 | goal-dashboard | `src/app/goal-dashboard.ts` | inverted-comparison | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Dashboard Mutation Pend` | 142.4s |
| BR09 | goal-status-widget | `src/ui/components/GoalStatusWidget.ts` | inverted-conditional | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Goal Status Widget — be` | 72.0s |
| BR10 | delegate-renderer | `src/ui/tools/renderers/DelegateRenderer.ts` | off-by-one | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Team Delegate Card — be` | 80.5s |
| BR11 | sidebar-search | `src/app/sidebar.ts` | match-all | 🔴 caught | ⚪ missed | — | 40.2s |
| BR12 | session-actions | `src/app/session-actions.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\session-lifecycle.journey.spec.ts › Journey: Fork Session › fork a` | 37.6s |
| BR13 | draft-persistence | `src/app/session-manager.ts` | dropped-restore | 🔴 caught | ⚪ missed | — | 62.0s |
| BR14 | add-project | `src/app/dialogs.ts` | renamed-label | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 81.4s |
| BR15 | add-project | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 91.8s |
| BR16 | add-project | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 97.7s |
| BR17 | app-smoke | `src/app/render.ts` | dropped-suffix | 🔴 caught | ⚪ missed | — | 30.5s |
| BR18 | misc-api-error | `src/ui/components/ErrorDetails.ts` | dropped-testid | 🔴 caught | ⚪ missed | — | 45.5s |
| BR19 | misc-cost | `src/ui/components/CostPopover.ts` | dropped-testid | 🔴 caught | ⚪ missed | — | 56.3s |
| BR20 | team-operations | `src/app/goal-dashboard.ts` | off-by-one | 🔴 caught | ⚪ missed | — | 45.1s |
| BR21 | team-operations | `src/ui/components/GoalStatusWidget.ts` | forced-attribute | 🔴 caught | ⚪ missed | — | 35.3s |
| BR22 | proposals | `src/ui/tools/renderers/ProposalRenderer.ts` | dropped-testid | 🔴 caught | ⚪ missed | — | 57.3s |
| BR23 | prompt-interaction | `src/ui/components/MessageEditor.ts` | dropped-class | 🔴 caught | ⚪ missed | — | 50.6s |
| BR24 | stories-sessions | `src/ui/components/MessageEditor.ts` | removed-guard | 🔴 caught | ⚪ missed | — | 43.1s |
| BR25 | project-settings | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | ⚪ missed | — | 30.3s |
| BR26 | staff-debug | `src/app/render-triggers.ts` | inverted-label | ⚪ missed | ⚪ missed | — | 21.6s |
| BR27 | project-onboarding | `src/app/dialogs.ts` | forced-attribute | 🔴 caught | ⚪ missed | — | 28.7s |
| BR28 | marketplace-packs | `src/app/marketplace-page.ts` | dropped-testid | 🔴 caught | ⚪ missed | — | 29.8s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*