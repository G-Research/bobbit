# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-07T23:24:09.044Z  |  Run duration: 12.8 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 6 | 6 |
| With targeted catchers | 6 | 6 |
| Caught | 6 | 6 |
| Missed | 0 | 0 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 0 | 0 |
| **Kill rate (of killable)** | **100.0%** | **100.0%** |

**Null-mutant integrity:** ✅ PASSED (no suite caught a no-op patch)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ✅ PASS
- **V2 ≥ legacy overall (kill count):** ✅ PASS (v2 6 vs legacy 6)
- **Both-missed gaps:** ✅ None
- **All journey kills attributed to a specific test:** ✅ PASS (6/6)

## Per-area Comparison (v2 journeys ≥ legacy is the verdict)

| Area | Mutants | Legacy caught | V2 caught | Real journey miss | Inconclusive | v2 ≥ legacy (runnable) |
|------|---------|---------------|-----------|-------------------|--------------|------------------------|
| misc-workflow-editor | 1 | 1 | 1 | — | — | ✅ |
| misc-role-tabs | 1 | 1 | 1 | — | — | ✅ |
| misc-prompt-stats | 1 | 1 | 1 | — | — | ✅ |
| misc-preview-newtab | 1 | 1 | 1 | — | — | ✅ |
| misc-compaction-card | 1 | 1 | 1 | — | — | ✅ |
| sidebar-full-search-nav | 1 | 1 | 1 | — | — | ✅ |

**Per-area v2 ≥ legacy:** ✅ PASS (no area has a real journey miss; ✅* = has env-inconclusive to re-run)

## Full Mutant Matrix

| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |
|----|------|------|----|--------|-----|---------------------|----------|
| BR50-null-A *(null)* | harness-integrity | `src/app/workflow-page.ts` | no-op | ⚪ missed | ⚪ missed | — | 52.4s |
| BR46 | misc-workflow-editor | `src/app/workflow-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Workflow Editor › workflow editor ` | 232.3s |
| BR48 | misc-role-tabs | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Goal Proposal Roles Tab › Roles ta` | 86.6s |
| BR51 | misc-prompt-stats | `src/ui/components/AgentInterface.ts` | attribute-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Prompt Stats › stats bar shows mod` | 113.3s |
| BR52 | misc-preview-newtab | `src/app/render.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Preview Artifacts › preview mount ` | 52.4s |
| BR53 | misc-compaction-card | `src/ui/tools/renderers/CompactionSummaryRenderer.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Compaction › seeded compaction sid` | 97.5s |
| BR54 | sidebar-full-search-nav | `src/app/sidebar.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › Full S` | 51.7s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*