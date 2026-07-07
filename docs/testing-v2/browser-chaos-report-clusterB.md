# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-07T23:27:42.540Z  |  Run duration: 13.9 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 10 | 10 |
| With targeted catchers | 10 | 10 |
| Caught | 10 | 10 |
| Missed | 0 | 0 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 0 | 0 |
| **Kill rate (of killable)** | **100.0%** | **100.0%** |

**Null-mutant integrity:** ✅ PASSED (no suite caught a no-op patch)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ✅ PASS
- **V2 ≥ legacy overall (kill count):** ✅ PASS (v2 10 vs legacy 10)
- **Both-missed gaps:** ✅ None
- **All journey kills attributed to a specific test:** ✅ PASS (10/10)

## Per-area Comparison (v2 journeys ≥ legacy is the verdict)

| Area | Mutants | Legacy caught | V2 caught | Real journey miss | Inconclusive | v2 ≥ legacy (runnable) |
|------|---------|---------------|-----------|-------------------|--------------|------------------------|
| proposals-subgoal-prefill | 1 | 1 | 1 | — | — | ✅ |
| project-settings-maintenance | 1 | 1 | 1 | — | — | ✅ |
| project-onboarding-typeahead | 1 | 1 | 1 | — | — | ✅ |
| goal-editing-existing-subgoal-settings | 1 | 1 | 1 | — | — | ✅ |
| project-settings-agent-dir | 1 | 1 | 1 | — | — | ✅ |
| proposals-editable-accept | 1 | 1 | 1 | — | — | ✅ |
| project-onboarding-select-all | 1 | 1 | 1 | — | — | ✅ |
| project-onboarding-post-archive | 1 | 1 | 1 | — | — | ✅ |
| team-operations-archive-child-cascade | 1 | 1 | 1 | — | — | ✅ |
| proposals-project-workflow-views | 1 | 1 | 1 | — | — | ✅ |

**Per-area v2 ≥ legacy:** ✅ PASS (no area has a real journey miss; ✅* = has env-inconclusive to re-run)

## Full Mutant Matrix

| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |
|----|------|------|----|--------|-----|---------------------|----------|
| BR00-null *(null)* | harness-integrity | `src/app/goal-dashboard-plan-tab.ts` | no-op | ⚪ missed | ⚪ missed | — | 29.6s |
| BR45 | proposals-subgoal-prefill | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Goal Proposal — Sub-goals pre` | 70.9s |
| BR47 | project-settings-maintenance | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Settings Maintenance —` | 100.8s |
| BR49 | project-onboarding-typeahead | `src/ui/components/DirectoryPicker.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 86.7s |
| BR50 | goal-editing-existing-subgoal-settings | `src/app/goal-dashboard-children-tab.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Subgoal Existing Goal Sett` | 72.8s |
| BR53 | project-settings-agent-dir | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Settings Maintenance —` | 55.6s |
| BR54 | proposals-editable-accept | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Editable Project Proposal › e` | 85.3s |
| BR55 | project-onboarding-select-all | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 53.7s |
| BR52 | project-onboarding-post-archive | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 47.7s |
| BR56 | team-operations-archive-child-cascade | `src/app/session-manager.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Archive Child Cascade —` | 57.3s |
| BR57 | proposals-project-workflow-views | `src/app/project-proposal-views.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Editable Project Proposal › m` | 95.4s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*