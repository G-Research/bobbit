# Testing metrics diagnostics

Testing metrics measure complete canonical lanes or convention-derived slices. They are diagnostic data, not a source of test ownership: files are discovered by the runner configurations and the semantic path rules in [`docs/testing-strategy.md`](../testing-strategy.md). Adding, moving, or renaming a test never requires a metrics entry or title registration.

## Commands

| Command | Measurement | Current artifact |
|---|---|---|
| `npm run metrics:smoke` | Self-checks metric comparison and retired-registry rejection with temporary files. | temporary only |
| `npm run metrics:coverage` | Coverage totals plus runtime, CPU, and peak RSS. | `.profiles/metrics/coverage.json` |
| `npm run metrics:unit:node` | Complete canonical Vitest lane; the metric name is retained for compatibility. | `.profiles/metrics/unit-node.json` |
| `npm run metrics:unit:browser` | Complete normal-browser Playwright lane (fixtures and journeys). | `.profiles/metrics/unit-browser.json` |
| `npm run metrics:e2e:api` | Canonical Playwright API/process E2E project (Group B). | `.profiles/metrics/e2e-api.json` |
| `npm run metrics:e2e:browser` | Canonical Playwright real-browser E2E project (Group C). | `.profiles/metrics/e2e-browser.json` |
| `npm run metrics:e2e:all` | Runs Playwright Groups B and C once and derives both project aggregates. | `.profiles/metrics/e2e-full.json`, `.profiles/metrics/e2e-api.json`, `.profiles/metrics/e2e-browser.json` |
| `npm run metrics:slice:renderer` | Convention-discovered browser E2E renderer/panel slice. | `.profiles/metrics/slice-renderer.json` |
| `npm run metrics:slice:scroll` | Convention-discovered browser E2E scroll/geometry slice. | `.profiles/metrics/slice-scroll.json` |
| `npm run metrics:slice:sidebar` | Convention-discovered browser E2E sidebar slice. | `.profiles/metrics/slice-sidebar.json` |
| `npm run metrics:baseline` | Captures branch-local aggregate baselines and refreshes the baseline-file section. | `docs/testing-metrics/baseline-*.json` |
| `npm run metrics:check` | Compares aggregate baselines with current artifacts. | comparison output only |

`metrics:e2e:all` is intentionally a Playwright B/C metrics coordinator. It is **not** the complete public E2E lane. `npm run test:e2e` owns all four canonical groups: Node/worktree (A), Playwright API/process (B), Playwright browser (C), and isolated Vitest E2E (D).

Generated Playwright metrics retain aggregate totals by project and canonical file for diagnostics. They do not persist test-title inventories. `docs/testing-metrics/thresholds.json` contains only aggregate coverage, runtime, CPU, memory, and optional metric-budget settings. The retired `retainedSmokeFiles`, `retainedSmokeCoverage`, and title-regex keys are rejected with an actionable error rather than being silently ignored.

## Comparing metrics

Committed baselines under `docs/testing-metrics/` are immutable historical measurements; current artifacts under `.profiles/metrics/` are not committed. Some retained aggregate baselines predate the canonical layout. In particular, `baseline-e2e-full.json` records the former three-project Playwright topology, including the removed `api-realpush` project. Only its aggregate historical measurement remains useful; the obsolete standalone real-push baseline and active project handling are removed.

For a complete aggregate comparison:

```bash
npm run metrics:check
```

For one metric without requiring every current artifact:

```bash
node scripts/metrics/check.mjs \
  --baseline docs/testing-metrics/baseline-coverage.json \
  --current .profiles/metrics/coverage.json
```

For an explicit slice improvement target:

```bash
node scripts/metrics/check.mjs \
  --baseline docs/testing-metrics/baseline-slice-sidebar.json \
  --current .profiles/metrics/slice-sidebar.json \
  --no-coverage \
  --min-runtime-decrease 0.30 \
  --min-cpu-decrease 0.30
```

Coverage should stay level or improve. Runtime and CPU comparisons are meaningful only for repeated runs in the same environment. Absolute budgets (`maxTestCount`, `maxDurationMs`, `maxEstimatedCpuMs`, and `maxPeakRssBytes`) remain optional for dedicated test-suite work; routine feature work does not update a per-test list.

Refresh baselines only after the measurement change is intentional and reviewed. Never update a baseline merely to hide a regression. See [`coverage-map.md`](coverage-map.md) for semantic ownership and [`../testing-layout/baseline.md`](../testing-layout/baseline.md) for the canonical-layout migration evidence.
