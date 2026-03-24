# Code Coverage

Server-side code coverage for `src/server/` using [c8](https://github.com/bcoe/c8) and V8's built-in coverage engine.

## Quick Start

```bash
# Combined report — E2E + unit tests (most complete)
npm run test:coverage

# Unit tests only (fast, no server needed)
npm run test:unit-coverage
```

Reports are written to `coverage/` (gitignored).

## Available Scripts

| Script | What it runs | Output |
|--------|-------------|--------|
| `npm run test:coverage` | E2E tests + unit tests, merged | `coverage/` — HTML, lcov, text |
| `npm run test:unit-coverage` | Unit tests only | `coverage/unit/` — text summary |

## Where to Find Reports

After running `test:coverage`:

- **HTML report**: Open `coverage/index.html` in a browser for an interactive, file-by-file view
- **lcov report**: `coverage/lcov.info` — for CI tools and IDE integrations
- **Text summary**: Printed to stdout at the end of the run

## How It Works

### E2E Coverage

The `playwright-e2e-coverage.config.ts` config sets the `NODE_V8_COVERAGE` environment variable on the gateway server process. V8 natively writes coverage data to JSON files in `coverage/tmp/` when the process exits.

A graceful shutdown teardown (`tests/e2e/e2e-coverage-teardown.ts`) sends `POST /api/shutdown` to the gateway before Playwright kills it, ensuring V8 flushes all coverage data.

### Unit Test Coverage

c8 wraps the `tsx --test` runner and collects V8 coverage from the test process. When run as part of `test:coverage`, it writes to the same `coverage/tmp/` directory as the E2E data.

### Merged Report

The `test:coverage` script:

1. Builds the server (`npm run build:server`)
2. Cleans `coverage/` directory
3. Runs E2E tests via Playwright — V8 writes coverage to `coverage/tmp/`
4. Runs unit tests via c8 — writes additional coverage to `coverage/tmp/`
5. Runs `c8 report` — merges all data in `coverage/tmp/` into HTML + lcov + text reports

Both E2E and unit coverage end up in the same temp directory, so `c8 report` automatically merges them into a single unified report.

### Source Maps

The server TypeScript build (`tsconfig.server.json`) has `"sourceMap": true`. c8 uses V8's native source map support to map coverage data back to the original `.ts` files, so the report shows TypeScript source lines — not compiled JavaScript.

## Adding New Test Files

When you add a new `tests/*.test.ts` file:

1. Add it to the `test:node` script in `package.json` (the file list after `--test-force-exit`)
2. Add it to the `test:coverage` script (same file list in the c8-wrapped command)
3. Add it to the `test:unit-coverage` script (same file list)

All three scripts share the same explicit file list to keep test execution deterministic.

## Coverage Baseline

As of initial setup:

- **E2E only**: ~65% statement coverage across `src/server/`
- **E2E + unit tests combined**: higher — unit tests fill gaps in pure-logic modules like `cost-tracker.ts`, `event-buffer.ts`, `staff-trigger-engine.ts`, `system-prompt.ts`, and `session-store.ts`

## Constraints

- Coverage is **opt-in only** — `npm run test:e2e` does not collect coverage
- The `coverage/` directory is gitignored
- Coverage collection adds minimal overhead (~10-20%) to test runs
