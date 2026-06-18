# Testing metrics guardrails

The split-suite metrics make browser E2E cost visible while preserving coverage in cheaper layers. Use them when moving UI coverage between spawned-gateway browser E2E, file/browser fixtures, API E2E, and node unit tests.

## Commands

| Command | Purpose | Current artifact |
|---|---|---|
| `npm run metrics:smoke` | Self-checks metric comparison with temporary files. | temporary only |
| `npm run metrics:coverage` | Runs coverage and records LCOV totals plus runtime, CPU, and peak RSS. | `.profiles/metrics/coverage.json` |
| `npm run metrics:unit:node` | Measures the node unit sub-suite. | `.profiles/metrics/unit-node.json` |
| `npm run metrics:unit:browser` | Measures the file/browser fixture sub-suite. | `.profiles/metrics/unit-browser.json` |
| `npm run metrics:e2e:api` | Measures the API E2E project. | `.profiles/metrics/e2e-api.json` |
| `npm run metrics:e2e:browser` | Measures the spawned-gateway browser E2E project standalone. | `.profiles/metrics/e2e-browser.json` |
| `npm run metrics:e2e:all` | Runs the full E2E tier once and derives split project metrics from that run. | `.profiles/metrics/e2e-full.json`, `.profiles/metrics/e2e-api.json`, `.profiles/metrics/e2e-api-realpush.json` when present, `.profiles/metrics/e2e-browser.json` |
| `npm run metrics:slice:renderer` | Measures the renderer/panel/status/browser slice. | `.profiles/metrics/slice-renderer.json` |
| `npm run metrics:slice:scroll` | Measures the scroll/geometry browser slice. | `.profiles/metrics/slice-scroll.json` |
| `npm run metrics:slice:sidebar` | Measures the sidebar browser slice. | `.profiles/metrics/slice-sidebar.json` |
| `npm run metrics:baseline` | Captures branch-local baselines and refreshes the coverage map. | `docs/testing-metrics/baseline-*.json` |
| `npm run metrics:check` | Compares committed baselines with current artifacts. | comparison output only |

Committed baselines live in `docs/testing-metrics/baseline-*.json`. Current run artifacts live in `.profiles/metrics/*.json` and are not committed. Threshold defaults live in `docs/testing-metrics/thresholds.json`, including accepted post-migration browser budgets, the retained-smoke file list, and retained-smoke runnable coverage requirements.

## E2E single-run rule

For gate validation, prefer `npm run metrics:e2e:all`. It runs the existing E2E tier once, writes the aggregate full-suite metric, and derives project split metrics from the same Playwright report. Do not run full E2E and standalone browser E2E in the same gate unless you are investigating a discrepancy; the split metrics from one full run are the validation source.

## `metrics:check` examples

```bash
npm run metrics:check
```

Compares every committed baseline under `docs/testing-metrics/` with current artifacts under `.profiles/metrics/`, applies regression thresholds, enforces absolute browser E2E/slice budgets, and verifies retained smoke files listed in `thresholds.json` still exist and have non-skipped tests in the browser metric report.

```bash
node scripts/metrics/check.mjs \
  --baseline docs/testing-metrics/baseline-coverage.json \
  --current .profiles/metrics/coverage.json
```

Checks one coverage metric without requiring all current metric files to exist.

```bash
node scripts/metrics/check.mjs \
  --baseline docs/testing-metrics/baseline-slice-sidebar.json \
  --current .profiles/metrics/slice-sidebar.json \
  --no-coverage \
  --min-runtime-decrease 0.30 \
  --min-cpu-decrease 0.30
```

Checks a focused migration slice against an explicit runtime/CPU decrease target. Use the slice that matches the migrated area: renderer, scroll, or sidebar. Explicit decrease flags remain enforced unless that metric has `useAbsoluteBudgetForExplicitDecrease` with the relevant absolute `maxDurationMs` / `maxEstimatedCpuMs` budget set in `metricBudgets.<metric>` or `browserE2eBudget.metricBudgets.<metric>`; whole-suite/project aggregates use that opt-out only when post-migration budgets are the stronger guardrail than stale percentage drops.

## Interpreting thresholds

- Coverage should stay level or improve. A coverage drop is acceptable only when the replacement coverage is reviewed and the coverage map explains the tradeoff.
- Slice metrics carry the strongest migration signal because they isolate the area being reduced.
- Browser-project metrics show spawned-gateway cost after all browser rows in the project interact with each other.
- Full-suite metrics are intentionally conservative because API and unrelated browser work can mask an area-specific change.
- CPU/runtime improvements should be read with the slice and browser-project metrics first, then full-suite metrics. Re-run in the same branch/environment when a single sample is noisy.
- Browser E2E, slice, and approved aggregate budgets are anchored to accepted post-migration current-state limits (`maxTestCount`, `maxDurationMs`, and `maxEstimatedCpuMs`) rather than stale pre-migration baselines.
- For metrics that set `useAbsoluteBudgetForExplicitDecrease`, explicit `--min-runtime-decrease` / `--min-cpu-decrease` checks use those absolute post-migration budgets instead of legacy percentage drops; keep this scoped to metrics where slice/project metrics carry the migrated-area improvement signal and aggregate wall time includes unrelated work or contention.
- Retained full-stack smoke files are machine-checked via `retainedSmokeFiles` and `retainedSmokeCoverage` in `thresholds.json`; deleting, renaming, or skipping one requires updating the coverage map and thresholds in the same reviewed change.
- Update baselines only after the coverage migration is intentional, replacement coverage exists, retained smokes are documented, and the new metrics are accepted. Never update baselines just to hide a regression.

## Coverage-map update rules

When moving browser E2E rows to cheaper layers:

1. Add or identify fixture/API/unit coverage before deleting or skipping spawned-gateway browser rows.
2. Update `coverage-map.md` in the same change: list the retired browser matrix, the replacement coverage, and the retained full-stack smoke.
3. Keep retained browser E2E to integration journeys: real routing, persistence, WebSocket/server wiring, cross-client behavior, or real browser layout that fixtures cannot represent.
4. Update `retainedSmokeCoverage` in `thresholds.json` with each retained smoke file and its minimum non-skipped browser-report test count.
5. Measure the relevant slice before the full E2E validation step.
6. Use `metrics:e2e:all` for final split-suite validation instead of rerunning full E2E through multiple commands.
