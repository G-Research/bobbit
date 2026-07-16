# Fast 3-Worker Unit Gate Design

## Status and decision

This design replaces the unit-stage lane runner with one ordinary Vitest invocation. The unit stage has one coordinator, at most three Vitest workers across all projects, no test ledger reservation, no gateway-boot lease, no lane logs, and no cost-based sharding.

The required command is:

```text
npm run test:unit
  -> vitest run --config vitest.config.ts --silent=passed-only
```

The hard outcome is two consecutive green solo runs at or below 300 seconds, followed by three simultaneous green runs on the Windows 12-core acceptance machine. The stretch target is 180 seconds. `retry: 3` remains configured; passing by deleting coverage, weakening assertions, or relocating any file other than the two named below is not allowed.

## Current-state findings

The current unit path is `package.json::test:unit` -> `scripts/testing-v2/run-unit-lanes.mjs`. That runner starts core, fidelity, DOM, and three cost-sharded integration jobs, obtains `reserveVitestLaneBudget()` from `scripts/testing-v2/ledger.mjs`, prepares a server bundle, and writes per-lane logs. `vitest.config.ts::resolveMaxWorkers()` independently calls `reserveWorkerSlots("vitest")`; the configuration then divides the inventory among ten projects. Fidelity membership is partly inferred by reading test source and matching `node:child_process` or `playwright`.

The expensive server graph already has a useful foundation:

- `scripts/testing-v2/server-prebundle.mjs::{computeServerPrebundleKey, validateServerPrebundle, ensureServerTestPrebundle}` creates an atomic, content-addressed bundle.
- `tests2/harness/server-runtime-entry.ts` is the bundle entry and preserves namespace/singleton identity.
- `tests2/harness/server-runtime.ts::{loadServerTestRuntime, serverRuntimeMode}` selects the bundle via `BOBBIT_V2_SERVER_PREBUNDLE`.
- `tests2/harness/gateway.ts::boot` creates one gateway per worker, but currently obtains `acquireGatewayBootLease()` and only integration workers receive the prepared bundle.

The current map-driven E2E path is also reusable. `scripts/testing-v2/run-e2e-v2.mjs::classifyDaily` places entries with `bucket: "daily"` and `method: "vitest-e2e"` in Group D; `runGroupD` selects the conditional `v2-e2e-vitest` project. No such entries exist yet.

## Target architecture

### One process and fixed worker resolution

`package.json` shall contain these direct commands:

```json
{
  "test:v2:core": "vitest run --config vitest.config.ts --silent=passed-only",
  "test:unit": "vitest run --config vitest.config.ts --silent=passed-only"
}
```

`test:v2:core:lanes` is removed. `scripts/testing-v2/run-unit-lanes.mjs` and its lane/cost-map-only tests are removed or converted to worker-resolution tests. `scripts/testing-v2/ledger.mjs` may remain for browser/E2E/full-suite compatibility, but nothing reachable solely from `npm run test:unit` may import or call it.

`vitest.config.ts::resolveMaxWorkers` becomes a pure cap:

```ts
const FIXED_UNIT_WORKERS = 3;
function resolveMaxWorkers(env = process.env): number {
  const requested = Number(env.VITEST_MAX_WORKERS);
  return Number.isFinite(requested) && requested >= 1
    ? Math.min(FIXED_UNIT_WORKERS, Math.floor(requested))
    : FIXED_UNIT_WORKERS;
}
```

The resolved value is applied at top-level `test.maxWorkers`; project configuration must never raise it. `VITEST_MAX_WORKERS=1` and `=2` are supported diagnostic reductions; zero, fractions below one, non-numbers, and values above three resolve to the fixed default/cap as shown. A replacement for `tests2/core/unit-lanes-scheduling.test.ts` pins this function, the absence of ledger imports, and a three-worker default. `retry: 3`, `passWithNoTests`, console behavior, timeouts, and V8 coverage settings remain in the shared configuration.

### Four unit projects

Normal unit collection is exactly four map-built projects:

| Project | Environment/pool | Isolation | Membership |
|---|---|---|---|
| `v2-core` | `node`, `forks` | `isolate:false` | explicitly tagged core tests |
| `v2-dom` | `happy-dom`, `threads` | `isolate:true` | explicitly tagged DOM tests |
| `v2-integration` | `node`, `forks` | `isolate:false` | explicitly tagged gateway/API tests |
| `v2-isolated` | `node`, `forks`, `maxWorkers:1` | `isolate:true` | at most ten documented environment/module-global bleeders |

There are no heavy, source, fidelity, command, fake-command, or sharded unit projects. Their fast behavior moves into shared fixtures and DI. The conditional `v2-e2e-vitest` project is present only when `BOBBIT_V2_E2E_VITEST=1`; it is not a unit project and is selected explicitly by E2E Group D.

The current 15-entry `singleForkFiles` list is not carried forward. After `withEnv`, singleton reset hooks, and worker-resolver cleanup, only demonstrated bleeders may be tagged `v2-isolated`, with a hard map audit enforcing `<= 10`. Initial candidates are the extension-host worker/module-global cases plus the `BOBBIT_DIR`/`BOBBIT_AGENT_DIR` module-top cases. Every isolated tag requires a non-empty reason; removing the underlying bleed requires moving the tag back to core.

### Tests-map is the source of truth

`tests2/tests-map.json` becomes authoritative for execution membership; `vitest.config.ts` must not read test source to infer fidelity. `scripts/testing-v2/gen-inventory.mjs` emits an explicit execution object for every materialized `v2Path` and every `v2Native` record:

```json
"execution": {
  "runner": "vitest",
  "tier": "unit",
  "project": "core"
}
```

Allowed Vitest projects are `core`, `dom`, `integration`, `isolated`, and `e2e`. `isolated` additionally requires `reason`. Browser and non-Vitest records retain their existing runner classification. A shared loader in `scripts/testing-v2/test-map-execution.mjs` normalizes paths to forward slashes, returns disjoint project arrays, and fails on missing files, duplicate ownership, unknown projects, an isolated count above ten, or a unit `.test.ts` with no execution tag. Both `vitest.config.ts` and inventory tooling consume this loader.

Exactly these two existing entries change to E2E:

```text
tests2/core/team-manager.test.ts
tests2/core/marketplace-install.test.ts
```

Each receives `bucket: "daily"`, `method: "vitest-e2e"`, and `execution: { runner:"vitest", tier:"e2e", project:"e2e" }`. No other entry may have that combination. `scripts/testing-v2/lib-census.mjs::METHODS` and `scripts/testing-v2/gen-inventory.mjs` receive exact-path overrides so regeneration preserves the classification.

The original files retain only their real filesystem/process fidelity assertions. Their fast decision assertions are extracted, not copied and abandoned, into unit-tagged files such as:

- `tests2/core/team-manager-decisions.test.ts`: spawn validation, role/authz, unpublished-branch choice using `TeamManagerConfig.commandRunner`, dismiss idempotency, completion, persistence decisions, and manual-clock nudges.
- `tests2/core/marketplace-install-decisions.test.ts`: local-vs-git routing through `gitRunner`, MCP gateway routing through `mcpGatewayFetch`, install/update/uninstall/path validation, and source-store decisions.

Moved declaration names are recorded in `scripts/testing-v2/unit-declaration-semantic-map.json`. This preserves decision coverage in tier 1 while Group D retains the real-fidelity owners at the two mandated paths.

## Workstreams and ownership boundaries

### WS1 — runner, projects, and inventory

Owns `package.json`, `vitest.config.ts`, the removal/conversion of `run-unit-lanes.mjs`, `test-map-execution.mjs`, `gen-inventory.mjs`, `lib-census.mjs`, `unit-inventory-audit.mjs`, map execution tags, and worker-resolution/config guard tests. WS1 must not edit gateway fixtures, prebundle internals, or slow test bodies.

WS1 exposes two merge contracts:

1. `loadVitestExecutionMap()` returns the five disjoint path lists.
2. `resolveMaxWorkers()` returns the fixed three-worker cap without side effects.

### WS2 — prebundle and module tax

Owns `scripts/testing-v2/server-prebundle.mjs`, `tests2/harness/server-runtime-entry.ts`, `tests2/harness/server-runtime.ts`, the prebundle resolver plugin, and prebundle parity/cache tests. WS2 gets one narrow integration point in `vitest.config.ts`, coordinated through WS1. It must not change map membership or test semantics.

### WS3 — subprocess removal and git fixtures

Owns the spawn guard, bounded spawn helper, template-repository fixture, migration of direct child-process calls, production DI use in tests, and the team-manager/marketplace split. WS3 requests the two E2E tags from WS1 rather than editing the map concurrently. It must not change worker/project configuration or timing budgets.

### WS4 — fixture economics and clocks

Owns maintenance fixture sharing/splitting, manual-clock conversion of slow integration tests, and the 15-second file-budget reporter. It may consume the WS3 template-repo API but does not implement another git helper. It must not relocate files or add budget exemptions.

WS1 and WS2 can merge independently. WS3 publishes the template/guard API before WS4 migrates maintenance. The only intentional cross-workstream touch points are the one WS2 config hook, two WS3 map requests, and the WS4 reporter registration.

## Data flows

### Content-addressed server prebundle

The existing single umbrella bundle helps the gateway fixture but does not prevent direct core imports from making each worker transform the server graph. Extend `ensureServerTestPrebundle()` to build an ESM splitting graph with:

- `tests2/harness/server-runtime-entry.ts` as the umbrella entry;
- every `src/server/**/*.ts` module imported by tier-1 tests as an entry (using all server modules is acceptable and simpler);
- `bundle:true`, `splitting:true`, `packages:"external"`, `platform:"node"`, `format:"esm"`, Node 22 target, external source maps with `sourcesContent`, stable `entryNames`, and shared `chunkNames`;
- the existing `import.meta.url` source rewrite, content key, temporary directory, atomic rename, and hash validation.

The manifest schema is bumped and contains the umbrella path, `source module -> emitted entry` map, and SHA-256 for every entry/chunk/map. `validateServerPrebundle()` fails closed on a missing file, stale schema/key, hash mismatch, or missing source map. Concurrent Vitest/config starts race safely: one atomic publisher wins; losers validate and reuse it.

`vitest.config.ts` awaits the cache once while loading configuration, sets `BOBBIT_V2_SERVER_PREBUNDLE` to the umbrella entry, and installs `serverPrebundleResolver()` from `server-prebundle.mjs`. The resolver maps absolute or `.js`-suffixed imports under `src/server` to the emitted entry from the manifest. All workers therefore parse small precompiled entries/shared chunks instead of asking Vite to transform the source graph. `tests2/harness/server-runtime.ts` continues to memoize the umbrella import so stateful namespaces have one identity per worker.

`tests2/core/server-prebundle-cache.test.ts` expands to cover manifest completeness, source-change invalidation, concurrent publication, corrupt chunks/maps, and Windows slash/case normalization. `tests2/integration/server-prebundle-runtime.test.ts` continues to prove real gateway boot and additionally checks direct-import identity against the umbrella namespace. V8 coverage must map back to `src/server`, not `.profiles` output.

Exit measurement uses Vitest's final phase timing plus `scripts/testing-v2/profile-hooks.mjs`: `(transform + import) / worker time < 0.15` on a warm content-addressed cache, recorded in `docs/testing-v2/fast-gate-progress.md`.

### Tier-1 subprocess guard

Add `tests2/harness/tier1-spawn-guard.ts` as a setup file for all four unit projects, never the E2E project. It wraps `spawn`, `exec`, `execFile`, `fork`, `spawnSync`, `execSync`, and `execFileSync` on `node:child_process`, calls `syncBuiltinESMExports()`, and throws an error containing the API, executable basename, and instruction to use a DI seam/template fixture. No arguments, environment values, or secrets are logged.

A static audit in `unit-inventory-audit.mjs` rejects value imports/requires of `node:child_process` from unit-tagged test files. Type-only imports are allowed. The runtime guard catches transitive production calls that a static test scan cannot see. The guard is installed after the one-time fixture bootstrap; tests cannot disable it or maintain an allowlist.

Any unavoidable bootstrap/E2E command goes through `tests2/harness/spawn-with-retry.ts::runFixtureCommand`. That helper uses argv arrays with `shell:false`, `windowsHide:true`, bounded timeout, captured stdout/stderr, and at most three attempts with fixed short backoff. Its final error includes exit code and redacted stderr. It is not a general escape hatch: the static audit permits it only from the template bootstrap and the two E2E-tagged owners.

### Template repository

Add `tests2/harness/git-template.ts` with `prepareGitTemplate`, `copyGitTemplate`, and teardown. Vitest global setup prepares one immutable repository under the short temp root (`C:\bobbit-v2` by default on Windows) with explicit `master`, local user name/email, `core.autocrlf=false`, one README, and one commit. Initialization uses `runFixtureCommand` before the worker spawn guard is installed. Workers receive the absolute template path through an environment value set by global setup.

`copyGitTemplate(destination)` removes a pre-created empty destination and uses `cpSync(..., { recursive:true, verbatimSymlinks:true })`. It never invokes Git. Test-specific remote/ref/worktree behavior is expressed through `CommandRunner` canned outputs; a test requiring real command behavior belongs only in one of the two approved E2E files. Migrate all current fixture-local `execFileSync("git", ...)` calls to this API or to an existing command seam. Pure command-policy tests use fake outputs and assert argv/cwd, not the host Git executable.

The template and prebundle are immutable and content-addressed/run-scoped respectively, so three simultaneous suites never share writable `.git`, cache temporary directories, or cleanup roots.

### Manual clock

`tests2/harness/clock.ts::createManualClock` remains the single virtual-time implementation. Slow gateway tests obtain `gateway.clock` and advance it rather than calling real sleeps or waiting through production backoff/TTL intervals. Extend the in-process mock bridge (`tests/e2e/in-process-mock-bridge.mjs` and `tests/e2e/mock-agent-core.mjs`) with an injected sleep callback so `STAY_BUSY` can be driven by the fixture clock in Vitest while browser/E2E defaults remain real time.

Specific first conversions:

- `tests2/integration/steer-reconnect.test.ts`: replace the five-second `STAY_BUSY` wall interval and best-effort 30-second idle wait with deterministic bridge/clock advancement, retaining the durable-transcript exactly-once assertion.
- `tests2/integration/activate-skill-rest.test.ts`: retain the shared session/project fixture and drive any skill-cache expiry/invalidation through the injected clock; no TTL sleep or polling is permitted.
- Search remaining integration code for real `setTimeout`, sleep helpers, and polling whose condition is clock-owned. Event-driven socket waits remain bounded safety timeouts, not deliberate delays.

### Maintenance fixture economics

The two validation-rejection cases in `tests2/integration/maintenance-api.test.ts` currently build equivalent orphan worktree fixtures separately. Extract a shared serial fixture in `beforeAll`: one copied template repo, one orphan branch/worktree record, and one registered project. Snapshot its path/ref/branch and API inventory before the rejection matrix; every malformed-body/itemIds case asserts 400 plus unchanged filesystem/ref/API inventory. Cleanup occurs once in `afterAll`.

If the combined file cannot meet 15 seconds, split by endpoint domain (for example `maintenance-api-validation.test.ts`, scan, cleanup, and session groups) while keeping every split unit-tagged. Shared helpers are non-test modules under `tests2/integration/helpers/`. The maintenance cluster target is at most 60 seconds total, and every physical test file must independently meet the 15-second budget.

## Inventory and performance enforcement

`scripts/testing-v2/unit-inventory-audit.mjs` is extended to enforce all of these in one report:

1. Every current/base core, DOM, and integration declaration has a current semantic owner.
2. The scheduled unit set plus scheduled Vitest-E2E set equals the complete Vitest inventory.
3. `currentE2eVitestFiles` equals exactly the two sorted approved paths; symmetric difference is fatal.
4. Every non-approved file remains unit-tagged; physical presence alone is not treated as scheduling.
5. Every file is assigned once, isolated count is at most ten, and isolated reasons are present.
6. Unit-tagged tests have no value import/require of child process.
7. Split/renamed declaration ownership is justified in `unit-declaration-semantic-map.json`.

Add `tests2/harness/unit-file-budget-reporter.ts`. It records `performance.now()` in Vitest 4's `onTestModuleStart`, records completion in `onTestModuleEnd`, and throws one aggregated error from `onTestRunEnd` when any unit module exceeds 15,000 ms. It reports path/project/duration, includes hooks and retries, and has no exemptions. It ignores `v2-e2e-vitest`. Synthetic reporter tests pin parallel starts, aggregation, threshold equality, retry accounting, and Windows path rendering.

The standard reporter remains enabled. A retry that makes a file exceed budget still fails the budget, exposing rather than hiding a flake.

## Compatibility constraints

- `npm run test:v2:changed` remains a direct `vitest --config vitest.config.ts --changed`; map-built includes must still intersect correctly with Vitest's changed-file selection. No wrapper or ledger is introduced.
- `scripts/testing-v2/parity.mjs` continues to run all unit projects with V8 coverage. Prebundle source maps must preserve `src/server` paths and coverage totals.
- `scripts/testing-v2/coverage-delta.mjs` changes its default project list from `v2-core,v2-core-isolated,v2-dom` to `v2-core,v2-isolated,v2-dom`; baselines may not be lowered to make the change pass.
- `tests2/core/guard-v2.test.ts`, `scripts/testing-v2/check-inventory.mjs`, and parity consume/validate the new explicit execution metadata without weakening orphan/dangling checks.
- `npm run test:browser` and its Playwright config/ledger behavior are unchanged.
- `npm run test:e2e` remains `test:e2e:v2`. `run-e2e-v2.mjs::classifyDaily` mechanically discovers exactly the two Group D files, and `runGroupD` still uses one worker plus `BOBBIT_V2_E2E_VITEST=1`.
- `npm run test:v2`, bundle checks, browser chaos, and full-suite scripts may retain their own orchestration. The prohibition is specifically the `test:unit` path.
- External-service fencing remains active. Neither unit nor E2E relocation may contact GitHub, a non-loopback HTTP endpoint, or a real LLM.
- `retry: 3` remains in `vitest.config.ts`; no project overrides it downward.

## Windows behavior

Windows is the reference implementation:

- Resolve executables with argv arrays and `shell:false`; use `npm.cmd` only in scripts that actually launch npm. The unit command itself is an npm script and needs no shell wrapper.
- Normalize map/cache keys to forward slashes; use case-insensitive comparison only for Windows path identity, never lowercase file content or manifest keys on other platforms.
- Use the short `C:\bobbit-v2` temp root (overridable by `BOBBIT_V2_TMP_ROOT`) to reduce path length and Defender-heavy worktree IO.
- Give every run/fork a PID/random suffix. Three suites must never share writable templates, gateway dirs, prebundle temp dirs, logs, or progress artifacts.
- Cleanup uses `rmSync` retries for transient sharing violations. Command retries are bounded and include captured stderr; hook failures are not expected to be rescued by Vitest retry.
- Atomic cache publication uses same-volume rename. A losing concurrent builder validates the winner before discarding its own temporary directory.

## Verification and iteration plan

Implementation proceeds in short measured steps. After every significant merged change, run `npm run test:unit` twice and append, without rewriting history, to `docs/testing-v2/fast-gate-progress.md`:

- commit SHA and Windows machine/core count;
- cold/warm cache state;
- wall time, file/test totals, retries, and pass/fail for both runs;
- slowest files and any 15-second violation;
- Vitest transform/import/test phase totals and transform+import percentage;
- spawn-guard count (must be zero).

Before signaling the unit-stage target, run in this order:

```text
npm run check
npm run test:unit:inventory
npm run test:v2:changed -- --run
npm run test:unit
npm run test:unit
npm run test:browser
npm run test:e2e
```

The two solo unit runs must be consecutive, green, and each at or below 300 seconds. Do not signal on one fast run followed by a failure or on a run with a budget/spawn violation.

Then start three independent `npm run test:unit` processes simultaneously from PowerShell using `Start-Process npm.cmd -ArgumentList 'run','test:unit' -PassThru`, with distinct redirected stdout/stderr files under `.profiles/testing-v2/fast-gate-concurrency/<timestamp>/`. Wait for all three and record each PID, exit code, Vitest duration, file count, test count, failed-suite count, failed-test count, and retry count. Acceptance is three exit codes of zero and zero failed suites/tests. Record the command, log paths, start/end timestamps, and summarized evidence in the progress document.

Finally verify `node scripts/testing-v2/run-e2e-v2.mjs --list` reports Group D as exactly `team-manager.test.ts` and `marketplace-install.test.ts`, and verify the inventory report shows no third E2E exclusion. The team lead signals `unit-stage-target` only after the two solo and one 3x-concurrent evidence blocks are committed.

## Completion criteria

The design is implemented only when all of the following are true:

- `test:unit` launches one Vitest run with a fixed three-worker cap and no unit ledger/lane/gateway-lease path.
- Normal collection is the four explicit unit projects and isolated membership is at most ten.
- Transform plus import is below 15 percent of worker time.
- Unit tests cannot spawn child processes; fixture setup and command decisions use the template/DI flows above.
- Every unit file is at or below 15 seconds, with the maintenance cluster at or below 60 seconds.
- Only the two approved files run in Vitest E2E Group D, and tier-1 seam coverage remains.
- Inventory, changed mode, coverage/parity, browser, and E2E remain green.
- Two solo runs meet 300 seconds and a three-suite concurrent run has zero failures.
