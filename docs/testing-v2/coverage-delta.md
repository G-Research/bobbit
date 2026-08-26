# Per-file Coverage Delta — Test Suite v2

> **Historical layout notice.** This document preserves migration, incident, or measurement
> evidence from before Bobbit adopted the canonical `tests/` hierarchy. Old `tests2/`
> and non-semantic test paths, map/affected-selector references, commands, counts, and
> lane names below describe the recorded revision; they are not current instructions.
> Keep measured citations unchanged. For current placement and discovery, use [Testing
> Strategy](../testing-strategy.md) and [`scripts/testing/layout-policy.mjs`](../../scripts/testing/layout-policy.mjs).

Generated: 2026-07-07T18:06:41.714Z
Mode: **baseline**  |  Threshold: 0.01%  |  Baseline: `tests2/v2-baseline-coverage-per-file.json`  |  Current: `.profiles/testing-v2/coverage/coverage-summary.json`

> First run — per-file baseline created. Commit it to lock per-file thresholds.

## Summary

| Metric | Count |
|--------|-------|
| Files compared | 570 |
| Files with a DROP (line or branch) | 0 |
| Files removed from coverage entirely | 0 |
| Files improved | 0 |
| Files newly covered (info) | 0 |

## ✅ No per-file coverage drops beyond threshold

## Methodology

- Coverage is V8 (`@vitest/coverage-v8`) per-file `coverage-summary.json` from the tier-1 vitest run.
- `pp` = percentage-points (absolute pct difference), not a relative change.
- A file present in the baseline but absent from current coverage is a **full loss** (its only exercising test may have been retired in the browser consolidation).
- Baseline mode compares against the committed `tests2/v2-baseline-coverage-per-file.json`; a git-history honesty check refuses a silently bar-lowered baseline.
- A/B mode (`--baseline A --current B`) compares two `coverage-summary.json` files directly (e.g. legacy suite vs v2).
