# Per-file Coverage Delta — Test Suite v2

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
