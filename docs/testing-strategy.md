# Testing strategy

Bobbit uses one `tests/` root and convention-owned lanes. A test's directory and semantic suffix must agree, so a reader and every runner can determine ownership without a registry or dependency graph. This keeps discovery deterministic and makes a misplaced test fail before an expensive lane starts.

The automated implementation gates run complete lanes in order:

```text
npm run test:unit → npm run test:browser → npm run test:e2e
```

`npm test` runs the same sequence. `npm run test:manual` is an explicit, gate-exempt real-model/external-service lane and is never included in an automated command.

## Choose the test by semantics

Use the cheapest layer that faithfully exercises the behavior. Directory and suffix are both part of the contract.

| Test semantics | Canonical pattern | Owner |
|---|---|---|
| Pure logic, data transforms, and node-local contracts | `tests/unit/core/**/*.unit.test.ts` | Vitest `test:unit`, shared fixed worker cap |
| Unit behavior that irreducibly needs singleton or environment isolation | `tests/unit/isolated/**/*.isolated.test.ts` | Vitest `test:unit`, one worker |
| DOM behavior that does not need real browser geometry | `tests/dom/**/*.dom.test.ts` | Vitest + happy-dom, `test:unit` |
| In-process gateway or API behavior with external I/O fenced | `tests/integration/gateway/**/*.gateway.test.ts` | Vitest `test:unit` |
| Real Chromium rendering, component state, or geometry using a deterministic fixture | `tests/browser/fixtures/**/*.fixture.spec.ts` | Playwright `test:browser` |
| Visible full-app journey against the normal mock-gateway harness | `tests/browser/journeys/**/*.journey.spec.ts` | Playwright `test:browser` |
| Real Git, worktree, or process fidelity using Node's test runner | `tests/e2e/node/**/*.node-e2e.test.ts` | E2E Group A |
| Isolated Vitest coverage that requires real-fidelity E2E setup | `tests/e2e/vitest/**/*.vitest-e2e.test.ts` | E2E Group D |
| API, MCP, port, restart, or Docker fidelity without a browser | `tests/e2e/api/**/*.api-e2e.spec.ts` | Playwright E2E Group B |
| Real browser plus process, restart, pack, or Docker fidelity | `tests/e2e/browser/**/*.browser-e2e.spec.ts` | Playwright E2E Group C |
| Real model, agent, or external-service behavior | `tests/manual/**/*.manual.spec.ts` | `test:manual` only |
| Shared non-runnable harnesses, helpers, fixtures, data, or templates | `tests/support/{harnesses,helpers,fixtures,data,templates}/<lane>/**` or lane-local `_helpers/**` | Imported by a lane; never discovered directly |

The distinction between `tests/browser/` and `tests/e2e/browser/` is fidelity, not UI visibility. Normal browser fixtures and journeys use deterministic test infrastructure. A browser E2E belongs under `tests/e2e/browser/` only when its defining requirement is real process, restart, Docker, pack, or comparable system fidelity.

Likewise, an API E2E must not request Playwright's `page`, `browser`, or `context` fixtures or import a browser-only boundary. Move such coverage to the browser E2E cell. Manual tests never enter an automated lane.

### Selection rules

Prefer, in order:

1. core unit coverage for pure behavior;
2. happy-dom for DOM contracts without real layout;
3. an in-process gateway integration test for gateway/API contracts;
4. a Chromium fixture for rendering or geometry;
5. a normal browser journey for visible app wiring, navigation, reload, or cross-client state;
6. an E2E cell only for real Git/worktree/process/restart/MCP/Docker fidelity;
7. manual coverage only when a real model, agent, credential, or external service is essential.

A user-facing feature normally needs a browser journey covering navigation, its happy path, reload behavior where state is durable, and cleanup. Do not duplicate exhaustive data matrices in the browser lane when a cheaper layer can own them; keep a representative visible journey and put the matrix below it.

## Ownership and discovery

[`scripts/testing/layout-policy.mjs`](../scripts/testing/layout-policy.mjs) is the single source of test ownership. It contains only the convention table and pure classification/validation functions—never test names, dependency edges, mutable state, or history.

The runners derive discovery directly from those conventions:

- [`vitest.config.ts`](../vitest.config.ts) owns the four unit cells and the E2E Vitest cell.
- [`playwright-v2.config.ts`](../playwright-v2.config.ts) owns normal browser fixtures and journeys.
- [`run-e2e-v2.mjs`](../scripts/testing-v2/run-e2e-v2.mjs) discovers the four real-fidelity E2E cells.
- [`playwright-manual.config.ts`](../playwright-manual.config.ts) owns only manual specs.

There is no hand-maintained test map, registration step, affected-test graph, or generated per-test inventory. CI runs complete deterministic lanes because docs, prompts, packs, workflows, and configuration are executable inputs for which broad path filters would be unsafe.

`npm run test:layout` scans committed, staged, and untracked files. It rejects:

- a semantic suffix in the wrong directory or a wrong suffix in a semantic directory;
- runnable tests outside a canonical cell;
- runnable suffixes in `tests/support/` or `_helpers/`;
- runner-import disagreement;
- browser fixture use from an API E2E;
- duplicate paths, case-fold collisions, traversal, and unsafe paths.

Each diagnostic names the expected canonical pattern. `npm run check`, every public lane command, and CI run this guard.

## Create a test

Use the scaffold so the path and suffix are correct without a second registration step:

```bash
npm run test:new -- <semantic> <name>
```

For example:

```bash
npm run test:new -- unit-core agent/status-policy
npm run test:new -- browser-journey settings/model-selection
npm run test:new -- api-e2e restart/session-recovery
```

Valid semantics are `unit-core`, `unit-isolated`, `dom`, `gateway-integration`, `browser-fixture`, `browser-journey`, `node-e2e`, `vitest-e2e`, `api-e2e`, `browser-e2e`, and `manual`. The scaffold creates a file exclusively and deliberately leaves a failing placeholder until the test is implemented.

Support code has no runnable suffix. Put broadly shared support under the matching `tests/support/` category and lane subdirectory. Put support that belongs to one local cohort in its lane's `_helpers/` directory.

## Commands and qualification

| Command | Purpose |
|---|---|
| `npm run test:layout` | Validate path, suffix, runner, and discovery ownership |
| `npm run check` | Layout validation plus server, web, and test type-checks |
| `npm run test:unit` | Complete core, isolated, DOM, and gateway-integration lane |
| `npm run test:browser` | Complete normal Chromium fixture and journey lane |
| `npm run test:e2e` | Complete real-fidelity Groups A–D |
| `npm run test:manual` | Opt-in real-model/agent/external-service lane |
| `npm test` | Complete unit, browser, then E2E lanes |

Focused runner arguments are useful while developing, but a focused run is not gate evidence:

```bash
npm run test:unit -- tests/unit/core/example.unit.test.ts
npm run test:browser -- tests/browser/fixtures/example.fixture.spec.ts
node scripts/testing-v2/run-e2e-v2.mjs --group B
```

Ordinary developer runs retain the configured retry margin. Qualification must prove first-attempt stability through the repository wrappers:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:unit
BOBBIT_V2_RETRY_FREE=1 npm run test:browser
BOBBIT_V2_RETRY_FREE=1 npm run test:e2e
```

In PowerShell, set `$env:BOBBIT_V2_RETRY_FREE = '1'` before invoking the commands. A qualification record must report zero observed retries.

The unit coordinator has a fixed cap of three workers; `VITEST_MAX_WORKERS` may lower but never raise it. The isolated unit cell and E2E Vitest cell run with one worker. The E2E coordinator serializes the gateway/worktree/browser-heavy A → B → C chain while Group D runs independently. Docker-dependent cases report local capability instead of silently disappearing.

## Isolation and cross-platform behavior

Every automated coordinator owns one canonical run root before importing Bobbit discovery/server code or spawning children. Mutable temp, HOME, Bobbit/config/credential, profile, cache, report, output, socket, database, and artifact paths live below that root. Only the allocating coordinator removes a successful root; failed roots are retained for diagnostics.

Tests must not:

- read or write the checkout's `.bobbit/` state;
- inherit developer credentials, config, packs, sessions, or command overrides;
- share checkout-local mutable caches or output paths across coordinators;
- junction or symlink a worktree's `node_modules` into another worktree or the primary checkout;
- mask lifecycle defects with sleeps, blind reloads, retry increases, broad skips, timeout increases, or weaker assertions.

Synchronize on the observable condition that proves readiness or completion, and scope cleanup to resources created by the test. See [Cross-OS test authoring](testing-v2/cross-os-test-authoring.md) for the environment, run-root, Git, Docker, and teardown contracts, and [Node modules corruption RCA](testing-v2/node-modules-corruption-rca.md) for the dependency-tree ring fence.

## CI ownership

The build/unit workflow runs layout validation, build, type-check, and the complete unit lane across Linux, Windows, and macOS. Pull requests also run complete browser and E2E jobs across those operating systems; Linux builds the Docker image for Docker-owned coverage. Project workflow gates use the same public commands.

No CI dependency graph or affected-test selector narrows these lanes. Running a complete semantic lane is easier to audit than maintaining an imprecise source-to-test graph, and test-path conventions already provide exact lane assignment and duplicate prevention.

## Historical evidence

The [test-layout baseline](testing-layout/baseline.md) records the pre-migration registry and affected-selector inventory, selection rates, runtime evidence, final canonical inventory, and removal totals. Its old paths and commands are intentionally historical and must not be used as current guidance.

Documents under `docs/testing-v2/` that describe migrations, measurements, or retired selection machinery are also historical unless they explicitly say they are a current operating reference. This page and the layout policy are authoritative for placement and lane ownership.
