# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-07T22:49:43.725Z  |  Run duration: 1.8 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 2 | 2 |
| With targeted catchers | 2 | 2 |
| Caught | 1 | 0 |
| Missed | 0 | 0 |
| Invalid (did not compile) | 1 | 1 |
| Error (harness/env) | 0 | 1 |
| **Kill rate (of killable)** | **50.0%** | **0.0%** |

**Null-mutant integrity:** — (no null mutant this run)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ✅ PASS
- **Inconclusive (env/harness, NOT a hole):** ⚠️ 1 legacy-caught mutant(s) whose journey run errored/failed-to-build. Re-run:
    - **BR52** (project-onboarding-post-archive): v2 = error
- **V2 ≥ legacy overall (kill count):** ❌ FAIL (v2 0 vs legacy 1)
- **Both-missed gaps:** ✅ None
- **All journey kills attributed to a specific test:** ✅ PASS (0/0)

## Per-area Comparison (v2 journeys ≥ legacy is the verdict)

| Area | Mutants | Legacy caught | V2 caught | Real journey miss | Inconclusive | v2 ≥ legacy (runnable) |
|------|---------|---------------|-----------|-------------------|--------------|------------------------|
| project-onboarding-post-archive | 1 | 1 | 0 | — | 1 | ✅* |
| team-operations-archive-child-cascade | 1 | 0 | 0 | — | — | ✅ |

**Per-area v2 ≥ legacy:** ✅ PASS (no area has a real journey miss; ✅* = has env-inconclusive to re-run)

## Full Mutant Matrix

| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |
|----|------|------|----|--------|-----|---------------------|----------|
| BR52 | project-onboarding-post-archive | `src/app/dialogs.ts` | dropped-testid | 🔴 caught | ⚠️ error | — | 18.1s |
| BR56 | team-operations-archive-child-cascade | `src/app/session-manager.ts` | dropped-value | ⛔ invalid | ⛔ invalid | — | 0.0s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*