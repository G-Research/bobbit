# Convention-derived testing metrics

This document maps diagnostic measurements to the canonical semantic cells. It is not a test inventory. Canonical paths and suffixes own discovery; no test file or title is registered here or in `thresholds.json`.

## Measurement ownership

| Diagnostic metric | Convention-derived input | What it means |
|---|---|---|
| `coverage` | Complete coverage command over canonical source/test configuration | Aggregate line, function, and branch coverage |
| `unit-node` | `tests/unit/core/**/*.unit.test.ts`, `tests/unit/isolated/**/*.isolated.test.ts`, `tests/dom/**/*.dom.test.ts`, and `tests/integration/gateway/**/*.gateway.test.ts` through `vitest.config.ts` | Complete canonical Vitest lane; name retained for baseline compatibility |
| `unit-browser` | `tests/browser/fixtures/**/*.fixture.spec.ts` and `tests/browser/journeys/**/*.journey.spec.ts` through `playwright-v2.config.ts` | Complete normal-browser lane |
| `e2e-api` | `tests/e2e/api/**/*.api-e2e.spec.ts` through the `api` Playwright project | Group B API/process aggregate |
| `e2e-browser` | `tests/e2e/browser/**/*.browser-e2e.spec.ts` through the `browser` Playwright project | Group C real-browser aggregate |
| `e2e-full` | One Playwright run containing only Groups B and C | Compatibility-named B/C aggregate; not the public four-group E2E lane |
| `slice-renderer`, `slice-scroll`, `slice-sidebar` | Filename-keyword slices derived at runtime from canonical `tests/e2e/browser/**/*.browser-e2e.spec.ts` files | Focused diagnostics, never ownership or required coverage lists |

The complete public `npm run test:e2e` lane additionally owns Group A under `tests/e2e/node/` and Group D under `tests/e2e/vitest/`. The metrics B/C coordinator does not replace that qualification command.

## Rules

1. Choose a test cell by semantics using [`docs/testing-strategy.md`](../testing-strategy.md), not by a metric or historical baseline.
2. Add, move, and discover tests exclusively through canonical paths and suffixes. Do not add a metrics threshold entry for a test file or title.
3. Use aggregate metrics to diagnose coverage, runtime, CPU, memory, and lane size changes after canonical discovery succeeds.
4. Use `metrics:e2e:all` when one B/C Playwright run should produce both project aggregates; use `npm run test:e2e` to qualify all A-D groups.
5. Treat committed baseline JSON as historical measurement evidence. A baseline may describe an older runner topology and must not become current ownership guidance.

## Historical baseline metric files

<!-- baseline-metric-files:start -->
- `baseline-coverage.json`
- `baseline-e2e-api.json`
- `baseline-e2e-browser.json`
- `baseline-e2e-full.json`
- `baseline-slice-renderer.json`
- `baseline-slice-scroll.json`
- `baseline-slice-sidebar.json`
- `baseline-unit-browser.json`
- `baseline-unit-node.json`

Aggregate thresholds: `thresholds.json`.
<!-- baseline-metric-files:end -->
