# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-07T23:49:49.330Z  |  Run duration: 15.9 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 8 | 8 |
| With targeted catchers | 8 | 8 |
| Caught | 8 | 8 |
| Missed | 0 | 0 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 0 | 0 |
| **Kill rate (of killable)** | **100.0%** | **100.0%** |

**Null-mutant integrity:** ✅ PASSED (no suite caught a no-op patch)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ✅ PASS
- **V2 ≥ legacy overall (kill count):** ✅ PASS (v2 8 vs legacy 8)
- **Both-missed gaps:** ✅ None
- **All journey kills attributed to a specific test:** ✅ PASS (8/8)

## Per-area Comparison (v2 journeys ≥ legacy is the verdict)

| Area | Mutants | Legacy caught | V2 caught | Real journey miss | Inconclusive | v2 ≥ legacy (runnable) |
|------|---------|---------------|-----------|-------------------|--------------|------------------------|
| misc-workflow-editor | 1 | 1 | 1 | — | — | ✅ |
| misc-role-tabs | 1 | 1 | 1 | — | — | ✅ |
| misc-prompt-stats | 1 | 1 | 1 | — | — | ✅ |
| misc-preview-newtab | 1 | 1 | 1 | — | — | ✅ |
| misc-compaction-card | 1 | 1 | 1 | — | — | ✅ |
| sidebar-full-search-nav | 1 | 1 | 1 | — | — | ✅ |
| app-smoke-open-new-window | 1 | 1 | 1 | — | — | ✅ |
| prompt-at-mention-chip | 1 | 1 | 1 | — | — | ✅ |

**Per-area v2 ≥ legacy:** ✅ PASS (no area has a real journey miss; ✅* = has env-inconclusive to re-run)

## Full Mutant Matrix

| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |
|----|------|------|----|--------|-----|---------------------|----------|
| BR50-null-A *(null)* | harness-integrity | `src/app/workflow-page.ts` | no-op | ⚪ missed | ⚪ missed | — | 51.3s |
| BR46 | misc-workflow-editor | `src/app/workflow-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Workflow Editor › workflow editor ` | 234.1s |
| BR48 | misc-role-tabs | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Goal Proposal Roles Tab › Roles ta` | 90.0s |
| BR51 | misc-prompt-stats | `src/ui/components/AgentInterface.ts` | attribute-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Prompt Stats › stats bar shows mod` | 112.1s |
| BR52 | misc-preview-newtab | `src/app/render.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Preview Artifacts › preview mount ` | 52.1s |
| BR53 | misc-compaction-card | `src/ui/tools/renderers/CompactionSummaryRenderer.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Compaction › seeded compaction sid` | 101.3s |
| BR54 | sidebar-full-search-nav | `src/app/sidebar.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › Full S` | 50.6s |
| BR55 | app-smoke-open-new-window | `src/app/session-actions.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Open in New Window › session ` | 61.8s |
| BR56 | prompt-at-mention-chip | `src/ui/components/FileMentionChip.ts` | class-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 110.3s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*