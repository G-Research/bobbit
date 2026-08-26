# Unit gate operating model

`npm run test:unit` is Bobbit's complete tier-1 lane. It discovers tests from canonical paths and suffixes, runs all four Vitest projects, and never depends on a per-test registry or affected-test graph. Complete-lane execution is deliberate: prompts, packs, workflows, configuration, and other indirect inputs make a source-to-test dependency graph harder to audit than the work it saves.

See the [testing strategy](../testing-strategy.md) for the repository-wide lane decision table, [Cross-OS test authoring](cross-os-test-authoring.md) before adding fixtures, and [Cross-suite test runtime design](cross-os-unit-gate-design.md) for the isolation wiring.

## Projects and discovery

[`vitest.config.ts`](../../vitest.config.ts) discovers exactly four unit cells:

| Project | Canonical pattern | Runtime and isolation |
|---|---|---|
| `v2-core` | `tests/unit/core/**/*.unit.test.ts` | Node forks; shared worker modules |
| `v2-dom` | `tests/dom/**/*.dom.test.ts` | happy-dom threads; isolated per file |
| `v2-integration` | `tests/integration/gateway/**/*.gateway.test.ts` | Node forks; shared worker modules |
| `v2-isolated` | `tests/unit/isolated/**/*.isolated.test.ts` | Node forks; isolated per file and one worker |

The core, DOM, and gateway-integration projects share a fixed cap of three workers. `VITEST_MAX_WORKERS=1` or `2` may lower that cap for diagnosis or a constrained runner; it cannot raise it. The isolated cell always has one worker because it exists only for behavior that irreducibly needs singleton or environment isolation.

`tests/e2e/vitest/**/*.vitest-e2e.test.ts` is not part of the unit lane. The E2E coordinator enables its separate `v2-e2e-vitest` project explicitly and owns its one-worker execution.

## Commands and qualification

Run the complete lane through the public command:

```bash
npm run test:unit
```

A file argument is useful during development but is not gate evidence:

```bash
npm run test:unit -- tests/unit/core/example.unit.test.ts
```

Ordinary runs retain up to three retries to protect developer and workflow productivity after an isolated transient. Qualification proves first-attempt stability by setting the repository-wide retry-free control:

```bash
BOBBIT_V2_RETRY_FREE=1 npm run test:unit
```

In PowerShell:

```powershell
$env:BOBBIT_V2_RETRY_FREE = '1'
npm run test:unit
```

The exact environment control resolves every unit project to zero retries. Direct Vitest retry flags may help diagnosis, but they are not qualification authority; qualification evidence must report zero observed retries.

Each tier-1 file has a 25-second wall budget measured from module start through hooks and retries. `BOBBIT_UNIT_CONCURRENT_PROOF=1` makes only wall-budget overruns report-only for simultaneous-load measurement; failed suites, tests, and setup remain fatal, and proof-mode output is not solo qualification evidence.

## Run and fixture isolation

Before prebundling, collection, or worker creation, the Vitest coordinator allocates one canonical run root. Mutable temporary files, HOME, Bobbit/config/agent/secrets state, transform and V8 caches, coverage, reports, output, sockets, databases, and artifacts live beneath that root. Workers inherit it but cannot remove it. Only the allocating coordinator removes a successful root after reporters and children settle; failed roots remain for diagnosis.

The environment sanitizer removes credentials and ambient Bobbit discovery/runtime inputs before imports and child creation. Tests must provide needed values through fixture-local configuration, restore process-local overrides, and create writable trees beneath the active run root. Never depend on developer HOME, checkout `.bobbit/` state, global Git configuration, remote services, host commands, or a shared `node_modules` link.

Core and gateway-integration projects reset leaking directory singletons at file boundaries. All four projects install the tier-1 spawn guard, which rejects direct `child_process` use; use an injected command seam or copied repository template instead. DOM files use happy-dom's owning window for browser storage and clear it between tests so behavior does not depend on Node's ambient globals.

Synchronize on the observable lifecycle event that proves readiness or completion. Do not hide ownership or teardown defects with sleeps, polling, retries, skips, force-exit, timeout increases, blind reloads, or weaker assertions.

## Placement and scaffolding

[`scripts/testing/layout-policy.mjs`](../../scripts/testing/layout-policy.mjs) is the source of ownership conventions. `npm run test:layout` scans committed, staged, and untracked files and reports the canonical destination when directory, suffix, or runner import disagrees. The layout guard runs from `npm run check`, every public lane command, and CI.

Create a correctly named file without a registration step:

```bash
npm run test:new -- unit-core agent/status-policy
npm run test:new -- unit-isolated runtime/singleton-state
npm run test:new -- dom settings/model-picker
npm run test:new -- gateway-integration sessions/recovery
```

The scaffold creates the canonical path exclusively and leaves a failing placeholder until implemented. Shared support code belongs under `tests/support/{harnesses,helpers,fixtures,data,templates}/<lane>/` or a lane-local `_helpers/` directory and must not use a runnable test suffix.

## CI ownership

The build/unit workflow runs layout validation, build, type-check, and the complete unit lane on Linux, Windows, and macOS for pull requests; the same unit matrix also runs on pushes to the primary branch. Browser and E2E remain separate complete-lane jobs. Project workflow gates use the same public commands, so local, Bobbit, and CI ownership agree.

Historical affected-selection and test-map measurements remain in the [test-layout baseline](../testing-layout/baseline.md) as migration evidence, not current operating guidance.
