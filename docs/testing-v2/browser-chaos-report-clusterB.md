# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-08T02:17:03.804Z  |  Run duration: 26.4 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 18 | 18 |
| With targeted catchers | 18 | 18 |
| Caught | 18 | 18 |
| Missed | 0 | 0 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 0 | 0 |
| **Kill rate (of killable)** | **100.0%** | **100.0%** |

**Null-mutant integrity:** ✅ PASSED (no suite caught a no-op patch)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ✅ PASS
- **V2 ≥ legacy overall (kill count):** ✅ PASS (v2 18 vs legacy 18)
- **Both-missed gaps:** ✅ None
- **All journey kills attributed to a specific test:** ✅ PASS (18/18)

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
| BR00-null *(null)* | harness-integrity | `src/app/goal-dashboard-plan-tab.ts` | no-op | ⚪ missed | ⚪ missed | — | 31.9s |
| BR45 | proposals-subgoal-prefill | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Goal Proposal — Sub-goals pre` | 84.9s |
| BR47 | project-settings-maintenance | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Settings Maintenance —` | 101.7s |
| BR49 | project-onboarding-typeahead | `src/ui/components/DirectoryPicker.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 96.2s |
| BR50 | goal-editing-existing-subgoal-settings | `src/app/goal-dashboard-children-tab.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Subgoal Existing Goal Sett` | 70.4s |
| BR53 | project-settings-agent-dir | `src/app/settings-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Settings Maintenance —` | 57.6s |
| BR54 | proposals-editable-accept | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Editable Project Proposal › e` | 97.4s |
| BR55 | project-onboarding-select-all | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 68.8s |
| BR52 | project-onboarding-post-archive | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 60.5s |
| BR56 | team-operations-archive-child-cascade | `src/app/session-manager.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\team-operations.journey.spec.ts › Journey: Archive Child Cascade —` | 61.2s |
| BR60 | goal-editing-archive-readonly-banner | `src/app/goal-dashboard.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Archive Always-On — b` | 78.8s |
| BR61 | goal-editing-form-tooltip-title | `src/app/proposal-panels.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Form Tooltips — behav` | 70.3s |
| BR63 | project-settings-restart-button-hidden | `src/app/settings-page.ts` | disabled-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Settings Restart Butto` | 50.1s |
| BR69 | proposals-revision-autoupdate | `src/app/session-manager.ts` | disabled-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Goal Proposal — spec survives` | 171.1s |
| BR67 | proposals-workflow-tab-customise | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Goal Proposal — Workflow tab ` | 99.5s |
| BR68 | goal-editing-creation-optional-steps | `src/app/proposal-panels.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Creation — behavioral` | 52.8s |
| BR65 | project-settings-project-assistant-provisional | `src/app/sidebar.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Project Assistant › Ad` | 104.8s |
| BR64 | project-onboarding-multi-repo-subset | `src/app/dialogs.ts` | dropped-filter | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-onboarding.journey.spec.ts › Journey: Project Onboarding ›` | 42.6s |
| BR57 | proposals-project-workflow-views | `src/app/project-proposal-views.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\proposals.journey.spec.ts › Journey: Editable Project Proposal › m` | 111.3s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*