# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-07T23:50:53.346Z  |  Run duration: 4.8 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 3 | 3 |
| With targeted catchers | 3 | 3 |
| Caught | 3 | 3 |
| Missed | 0 | 0 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 0 | 0 |
| **Kill rate (of killable)** | **100.0%** | **100.0%** |

**Null-mutant integrity:** — (no null mutant this run)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ✅ PASS
- **V2 ≥ legacy overall (kill count):** ✅ PASS (v2 3 vs legacy 3)
- **Both-missed gaps:** ✅ None
- **All journey kills attributed to a specific test:** ✅ PASS (3/3)

## Per-area Comparison (v2 journeys ≥ legacy is the verdict)

| Area | Mutants | Legacy caught | V2 caught | Real journey miss | Inconclusive | v2 ≥ legacy (runnable) |
|------|---------|---------------|-----------|-------------------|--------------|------------------------|
| goal-editing-archive-readonly-banner | 1 | 1 | 1 | — | — | ✅ |
| goal-editing-form-tooltip-title | 1 | 1 | 1 | — | — | ✅ |
| project-settings-restart-button-hidden | 1 | 1 | 1 | — | — | ✅ |

**Per-area v2 ≥ legacy:** ✅ PASS (no area has a real journey miss; ✅* = has env-inconclusive to re-run)

## Full Mutant Matrix

| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |
|----|------|------|----|--------|-----|---------------------|----------|
| BR60 | goal-editing-archive-readonly-banner | `src/app/goal-dashboard.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Archive Always-On — b` | 78.2s |
| BR61 | goal-editing-form-tooltip-title | `src/app/proposal-panels.ts` | dropped-value | 🔴 caught | 🔴 caught | `tests2\browser\journeys\goal-editing.journey.spec.ts › Journey: Goal Form Tooltips — behav` | 64.7s |
| BR63 | project-settings-restart-button-hidden | `src/app/settings-page.ts` | disabled-guard | 🔴 caught | 🔴 caught | `tests2\browser\journeys\project-settings.journey.spec.ts › Journey: Settings Restart Butto` | 44.8s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*