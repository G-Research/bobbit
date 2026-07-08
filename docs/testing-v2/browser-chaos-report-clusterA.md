# Browser-dimension Chaos Comparison — Test Suite v2

Generated: 2026-07-08T03:18:14.706Z  |  Run duration: 46.0 min

Adversarial proof that the consolidated v2 **journeys** catch every browser-only
mutant the retired 184-spec **legacy** suite catches. Both tiers run the targeted
spec at `retries: 0` against a freshly rebuilt `dist`; attribution names the failing test.

## Summary

| Metric | Legacy suite | V2 journeys |
|--------|-------------|-------------|
| Content mutants | 22 | 22 |
| With targeted catchers | 22 | 22 |
| Caught | 21 | 22 |
| Missed | 1 | 0 |
| Invalid (did not compile) | 0 | 0 |
| Error (harness/env) | 0 | 0 |
| **Kill rate (of killable)** | **95.5%** | **100.0%** |

**Null-mutant integrity:** ✅ PASSED (no suite caught a no-op patch)

## Acceptance Criteria

- **Every legacy-caught mutant is also journey-caught (no REAL hole):** ✅ PASS
- **V2 ≥ legacy overall (kill count):** ✅ PASS (v2 22 vs legacy 21)
- **Both-missed gaps:** ✅ None
- **All journey kills attributed to a specific test:** ✅ PASS (22/22)

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

**Per-area v2 ≥ legacy:** ✅ PASS (no area has a real journey miss; ✅* = has env-inconclusive to re-run)

## Full Mutant Matrix

| ID | Area | File | Op | Legacy | V2 | Killed by (v2 test) | Duration |
|----|------|------|----|--------|-----|---------------------|----------|
| BR50-null-A *(null)* | harness-integrity | `src/app/workflow-page.ts` | no-op | ⚪ missed | ⚪ missed | — | 52.5s |
| BR46 | misc-workflow-editor | `src/app/workflow-page.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Workflow Editor › workflow editor ` | 239.6s |
| BR48 | misc-role-tabs | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Goal Proposal Roles Tab › Roles ta` | 90.3s |
| BR51 | misc-prompt-stats | `src/ui/components/AgentInterface.ts` | attribute-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Prompt Stats › stats bar shows mod` | 114.0s |
| BR52 | misc-preview-newtab | `src/app/render.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Preview Artifacts › preview mount ` | 53.0s |
| BR53 | misc-compaction-card | `src/ui/tools/renderers/CompactionSummaryRenderer.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Compaction › seeded compaction sid` | 102.7s |
| BR54 | sidebar-full-search-nav | `src/app/sidebar.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › Full S` | 52.1s |
| BR55 | app-smoke-open-new-window | `src/app/session-actions.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Open in New Window › session ` | 63.7s |
| BR56 | prompt-at-mention-chip | `src/ui/components/FileMentionChip.ts` | class-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 123.0s |
| BR57 | app-smoke-goal-metadata | `src/app/proposal-panels.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Goal Proposal Metadata Tab › ` | 537.6s |
| BR58 | sidebar-show-read-filter | `src/ui/components/sidebar-filters.ts` | dropped-testid | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › Filter` | 78.4s |
| BR59 | misc-review-approve | `src/ui/components/review/ReviewPane.ts` | label-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Review Commenting › Approve in the` | 174.3s |
| BR60 | misc-image-attach | `src/ui/components/Messages.ts` | tag-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Image Attachment › attached image ` | 80.4s |
| BR61 | misc-workflow-page-scope | `src/app/routing.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\misc.journey.spec.ts › Journey: Workflow Editor › legacy #/workflo` | 71.2s |
| BR62 | prompt-ask-user-choices | `src/ui/components/AskUserChoicesWidget.ts` | class-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 203.4s |
| BR63 | sidebar-new-goal | `src/app/sidebar.ts` | label-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › New Go` | 69.8s |
| BR64 | sidebar-new-session | `src/app/sidebar.ts` | label-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › New Se` | 87.5s |
| BR65 | prompt-queue-ui | `src/ui/components/MessageEditor.ts` | class-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 76.6s |
| BR66 | prompt-escape-abort | `src/ui/components/MessageEditor.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 55.6s |
| BR67 | prompt-tool-ask-policy | `src/ui/components/ToolPermissionCard.ts` | label-rename | 🔴 caught | 🔴 caught | `tests2\browser\journeys\prompt-interaction.journey.spec.ts › Journey: Prompt Interaction ›` | 198.0s |
| BR68 | sidebar-search-result-nav | `src/app/search-page.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\sidebar-nav.journey.spec.ts › Journey: Sidebar Navigation › full-s` | 60.9s |
| BR69 | app-smoke-keyboard-nav | `src/app/main.ts` | behavioural | 🔴 caught | 🔴 caught | `tests2\browser\journeys\app-smoke.journey.spec.ts › Journey: Sidebar Keyboard Nav › Ctrl+A` | 52.5s |
| BR70 | stories-goal-routing | `src/ui/components/ProjectPickerPopover.ts` | dropped-attr | ⚪ missed | 🔴 caught | `tests2\browser\journeys\stories-registry.journey.spec.ts › Journey: Goal Routing (multi-pr` | 56.6s |

**Icons:** 🔴 caught | ⚪ missed | — skipped | ⚠️ error (harness/env) | ⛔ invalid (did not compile)

## Methodology

- Each mutant is a single search/replace in a browser-only `src/` file (see `tests2/chaos/browser-mutants.json`).
- Applied in ONE ephemeral `git worktree add --detach` shared across the campaign; the node_modules junction is unlinked before any recursive delete (junction-safe teardown).
- Browser tests run against BUILT `dist`, so each mutant rebuilds only its dist target(s) (`build:ui` / `build:server`); a previously-mutated target is rebuilt from clean source before the next mutant.
- A mutation that does not compile is `invalid` (never a kill); a run that crashes before tests is `error` (never a kill).
- `caught` requires a NAMED failing test in the Playwright JSON report — a bare non-zero exit is an error, not a kill.
- After each mutant the source file is reverted and a clean-tree assertion confirms no mutant leaks into the branch.

*Corpus: tests2/chaos/browser-mutants.json  |  Runner: scripts/testing-v2/browser-chaos.mjs*