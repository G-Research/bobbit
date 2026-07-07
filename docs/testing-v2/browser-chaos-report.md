# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-07T17:47:51.300Z  |  Run duration: 29.3 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 16 | 16 |
| With targeted catchers | 16 | 16 |
| Caught | 14 | 14 |
| Missed | 1 | 2 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 1 | 0 |
| **Kill rate (of killable)** | **87.5%** | **87.5%** |

**Null-mutant integrity:** ✅ PASSED (no suite caught a no-op patch)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ❌ FAIL
  - ❌ 1 REAL journey hole(s) — the journey RAN and MISSED. Strengthen the journey's assertions (do NOT delete the mutant), then re-run:
    - **BR13** (draft-persistence): The message composer never restores a persisted prompt draft on session (re)bind. The journey's draft-persistence-across-reload assertion (textarea value contains the drafted text) must fail. — legacy caught via `tests/e2e/ui/draft-loss.spec.ts`; v2 journey `tests2/browser/journeys/app-smoke.journey.spec.ts` = MISSED
- **V2 ≥ legacy overall (kill count):** ✅ PASS (v2 14 vs legacy 14)
- **Both-missed gaps:** ✅ None
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
| sidebar-search | 1 | 0 | 0 | — | — | ✅ |
| session-actions | 1 | 1 | 1 | — | — | ✅ |
| draft-persistence | 1 | 1 | 0 | 1 | — | ❌ |
| add-project | 3 | 3 | 3 | — | — | ✅ |

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
| BR11 | sidebar-search | `src/app/sidebar.ts` | match-all | ⚠️ error | ⚪ missed | — | 17.1s |
| BR12 | session-actions | `src/app/session-actions.ts` | forced-false | 🔴 caught | 🔴 caught | `tests2\browser\journeys\session-lifecycle.journey.spec.ts › Journey: Fork Session › fork a` | 37.6s |
| BR13 | draft-persistence | `src/app/session-manager.ts` | dropped-restore | 🔴 caught | ⚪ missed | — | 62.0s |
| BR14 | add-project | `src/app/dialogs.ts` | renamed-label | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 81.4s |
| BR15 | add-project | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 91.8s |
| BR16 | add-project | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 97.7s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*