# Cross-OS unit-gate recovery design

## Scope and evidence

This investigation was run at `8ba0dce9` on macOS with Node `v26.0.0` and Vitest `4.1.10`.

- `node -p "process.version + ' ' + typeof globalThis.localStorage"` prints `v26.0.0 undefined` and Node emits `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided`.
- `os.tmpdir()` is lexical `/var/folders/.../T`, while `fs.realpathSync(os.tmpdir())` is `/private/var/folders/.../T`.
- The reported DOM failures reproduce in isolated v2-dom runs, so they are not worker contention.

The dominant DOM failure is a Node-runtime compatibility regression, not an OS-specific happy-dom timing problem. Node 26 exposes an unavailable process-level `localStorage` global; happy-dom does not replace it when populating its window globals. Code using bare `localStorage` therefore gets `undefined`. macOS made the issue visible because the local machine uses Node 26, but it will affect any supported OS running that Node version.

## 1. v2-dom: unavailable Node `localStorage`

### Evidence

- `tests2/dom/bell-toggle.test.ts` fails both persistence assertions: `gatewayFetch()` never reaches its stubbed `fetch` because `src/app/gateway-fetch.ts:16` evaluates `localStorage.getItem(...)` first.
- `tests2/dom/project-audio-notification-paths.test.ts` fails its initial request waits for the same reason and eventually reports `TypeError: Cannot read properties of undefined (reading 'getItem')` at `gateway-fetch.ts:16`.
- `tests2/dom/api-error-forwarding.test.ts` exhausts its two five-second polling loops on every retry (about 40 seconds total); the asynchronous `showConnectionError()` path rejects in `@mariozechner/mini-lit/dist/i18n.js:getCurrentLanguage` because its storage global is undefined.
- This explains the broad failure shape: tests import app/UI modules with direct `localStorage` use, so request stubs, DOM render paths, and background work all fail before their intended assertions.

### Implementation plan

1. Add `tests2/harness/v2-dom-environment.ts`, configured only for the `v2-dom` project in `vitest.config.ts` after the spawn guard.
2. In a `beforeEach`, install the current happy-dom window's storage object as an own writable/configurable `globalThis.localStorage` property. Do the same for `sessionStorage` if Node exposes an incompatible process global. Do not use a fake map: application and third-party code must use the actual window storage object.
3. In `afterEach`, clear both stores and restore the exact prior descriptors. This preserves `isolate: true` file boundaries and prevents a test's keys from leaking.
4. Add a focused regression test (owned by the test author) that runs under v2-dom, writes through `gatewayFetch`, and asserts the fetch stub receives the request while `globalThis.localStorage` is initially absent/undefined. The test must not depend on Node 26 specifically.
5. Keep application code defensive where it is independently valid for SSR/non-DOM use, but do not change every direct storage consumer to mask an incorrectly configured DOM test environment.

### Risk

The setup must run after happy-dom constructs each file's window; a module-scope storage capture would recreate the same stale-window bug that `tests2/dom/_setup/registry-bridge.ts` avoids for custom elements. The setup must not be added to node projects.

## 2. DOM wall-budget failures are symptom waits, not slow production work

`api-error-forwarding` has two tests with `waitFor(..., 5000)` and retry 3, yielding about 40 seconds when the dialog never renders. `project-audio-notification-paths` has four `waitFor(..., 2000)`-based failures and retry 3, yielding about 32 seconds. Their wall-budget breaches are deterministic consequences of the broken storage environment.

After the shared DOM setup is fixed, replace polling only where necessary with promise/event-based settling or bounded microtask flushing. Do not raise these timeouts. In particular, `bell-toggle` must await the persistence operation (or a fetch-observed deferred) rather than assuming Lit `updateComplete` also waits for a fire-and-forget request.

## 3. TMPDIR lexical/realpath mismatches

### Transcript persisted-file trust

`src/server/agent/transcript-sanitizer.ts` currently trusts only the canonical value returned by `realpathRegularJsonlFile()` in `trustPersistedAgentSessionFile()`. Later calls can supply the persisted lexical `/var/...` spelling. `isTrustedExactSessionFile()` compares that lexical spelling against the canonical `/private/var/...` set entry and rejects it.

Evidence:

- `tests2/core/transcript-sanitizer.test.ts` and `transcript-sanitizer-agent-dir.test.ts` fail trusted-read assertions.
- `session-recovery-agent-dir.test.ts` returns canonical `/private/var/...` where its test expects the original persisted `/var/...` spelling.

Apply the already prepared `3505711e` production fix in `src/server/agent/transcript-sanitizer.ts`: record both the persisted lexical spelling and the canonical readable spelling. This preserves security because each spelling is admitted only after the regular-file, non-symlink, recognizable-transcript validation. The caller-facing recovery contract should preserve its persisted lexical path where that is the contract; tests should compare canonical forms only when canonical output is explicitly intended.

Add a portable regression fixture that creates a symlinked temp-root alias when permissions permit, writes via one spelling, and reads/trusts via the other. On platforms where directory symlink creation is unavailable, test the canonicalization helper through an injected `realpathSync` seam rather than skipping the invariant.

### Extension-host confinement

The extension-host source already has the correct canonical comparison pattern in `src/server/extension-host/path-guard.ts`: `realpathSync` is applied to both root and candidate before `path.relative`. The reported `extension-host-channel-registry` filename is not in the current `tests2/tests-map.json` v2-core inventory, so it could not be rerun at this checkout. When restoring/adding it, ensure its worker bootstrap passes a canonical pack root to the confinement loader or uses `isPackPathWithinRoot()` rather than independently comparing a real candidate against lexical `packRoot`.

Audit targets with lexical containment calls include:

- `src/server/preview/path-guard.ts` — missing-file fallback compares lexical candidate to canonical `baseReal`; canonicalize/fall back consistently.
- `src/server/agent/resolve-project.ts:106`, `project-registry.ts:503-520`, `worktree-inventory.ts`, and `yaml-store.ts` — replace string-prefix containment with `path.relative` using consistently canonical operands where paths may exist through a symlink.
- `src/server/agent-dir-config.ts` and `gate-artifacts.ts` already use a lexical pass followed by paired realpaths in their security-sensitive paths; retain this two-phase model.

Do not blindly canonicalize a user-supplied nonexistent path: canonicalize the longest existing prefix or retain a lexical containment pass first, then canonicalize both existing operands before an access operation.

## 4. Host configuration leakage

`src/server/mcp/mcp-manager.ts:477-484` deliberately loads `os.homedir()` configuration (`~/.claude.json`, `~/.claude/.mcp.json`, and `~/.bobbit/.mcp.json`). `tests2/core/mcp-manager-marketplace-discovery.test.ts` creates managers without first isolating HOME and `BOBBIT_DIR`, so a developer's real MCP server configuration changes its discovery result.

Apply the fixture portion of commit `3505711e`: before importing/constructing managers, create a per-file temp root and set `HOME`, `USERPROFILE`, and `BOBBIT_DIR` to empty fixture subdirectories; clean it in `afterAll`. Its existing `guardProcessEnv()` restores process globals for shared fork neighbors. This is a test-fixture fix because production discovery is intentionally user-config aware.

Audit all tests that construct production discovery/config services directly. Prefer an explicit injectable `globalUserBase`/home argument where available (`config-cascade`, pack/skill discovery), otherwise set isolated environment roots before the module/service initializes. Gateway integration tests should use `tests2/harness/gateway.ts`, which already establishes `BOBBIT_DIR`, agent, and secrets roots, but it should also explicitly isolate HOME/USERPROFILE if any boot path consults `os.homedir()`.

## 5. Remaining integration failures

### `base-ref-api.test.ts`

The test mutates `runtime.gatewayDeps.realCommandRunner` after the gateway fixture has been booted. The fixture's fenced runner captures its delegate at gateway creation, so its Git calls do not see the test's later mutation. Consequently every fake repo lacks the intended `origin/develop` result. Move the canned Git seam into gateway creation (an explicit fixture option/dependency) or make the fence delegate dynamically at invocation time. This is test-harness injection ordering, not an OS failure.

The same test also asserts lexical temp paths in warning text while production canonicalizes the project root, producing `/private/var/...` on macOS. Compare canonical paths or construct the expected path from `fs.realpathSync`.

### `project-ui-api.test.ts`

The project registry normalizes existing root paths with `realpathSync` (`src/server/agent/project-registry.ts`), while the test compares `p.rootPath` to lexical `mkdtempSync()` output. Change the fixture assertion to compare canonical paths; retain production canonicalization for deduplication/security.

### `tools-cascade.test.ts`

The targeted isolated run passes all 10 tests. The reported full-gate failure therefore needs rerun after the HOME/BOBBIT_DIR and integration-fixture fixes. Its serial suite mutates the shared server `config/tools` directory; if it still fails, give the suite a unique config root or cleanup baseline rather than weakening its required-field assertion.

## 6. Parallel workflow-run isolation

All workflow suites must be safe when separate worktrees run simultaneously. This is distinct from worker isolation inside one Vitest/Playwright coordinator.

### Audit findings

- **Gateway ports:** `tests2/harness/gateway.ts` creates gateways with `port: 0`; inspected integration/core mock servers also use `listen(0, "127.0.0.1", ...)`. The literal `localhost:3001`, `127.0.0.1:1`, `:9`, and `:19999` values found in tests are persisted-value or refused-connection fixtures, not listeners. Preserve that distinction; prohibit literal listener ports unless a test proves collision handling.
- **Unit gateway state:** `tests2/harness/gateway.ts` creates each fork state under `TMP_ROOT/fork-<pid>-<mkdtemp suffix>` and sets `BOBBIT_DIR`, agent, and secrets variables. This is process-unique, but its Windows default root `C:\\bobbit-v2` is shared as a parent. Keep all mutations below `mkdtemp`; never clean the parent or sibling forks.
- **Shared HOME:** the gateway fixture does not redirect `HOME`/`USERPROFILE`; MCP and other user-discovery paths can therefore see the developer account. The MCP fix described above must become a suite-level fixture policy for every gateway/process that can load global-user configuration.
- **Unit transformed cache:** `vitest.config.ts` namespaces writable module cache state by coordinator PID (`.profiles/testing-v2/vitest-module-cache/process-<pid>`), which is safe. Its coverage directory is not per run and multiple coordinators can overwrite `coverage-summary` output. Give coverage reports a PID/run namespace or make the ordinary unit gate disable coverage output when coverage is not requested.
- **Server prebundle:** `scripts/testing-v2/server-prebundle.mjs` uses a content-hash cache, atomic temp publish, and a per-key lock. This is intentionally cross-process shared and is safe only if stale-lock reclamation never removes a live owner. Retain its PID/liveness checks and add a concurrent prebundle publication test.
- **Ledger:** `scripts/testing-v2/ledger.mjs` intentionally shares `os.tmpdir()/bobbit-test-v2-ledger` across worktrees to cap machine-wide workers/boot/browser work. Its atomic lock is appropriate shared state; do not put it under a worktree. Exercise stale PID reclamation and simultaneous reservation in the parallel proof.
- **Browser cache/profile:** `playwright-v2.config.ts` assigns `PWTEST_CACHE_DIR` per run ID/PID under a shared cache parent and seeds from an immutable/latest snapshot. This isolates writes. The JSON report and `outputDir: "test-results-v2"` are worktree-relative, so distinct worktrees do not conflict; simultaneous invocations in one worktree still do. Include PID/run IDs in reporter output and outputDir, or serialize same-worktree invocation explicitly.
- **E2E fixed temporary roots:** several legacy/E2E harnesses use `join(tmpdir(), "bobbit-e2e")` (for example `tests/e2e/in-process-harness.ts`, `gateway-harness.ts`, and teardown helpers) without a run owner. These are cross-process collision risks: one run can reuse or delete another run's headquarters, state, socket, or worktree fixtures. Replace the root with a canonical `mkdtempSync(join(realpathSync(tmpdir()), "bobbit-e2e-"))` run root, export it through one harness environment variable inherited by workers, and remove only that owned root.
- **Timestamp-only fixture names:** `tests2/integration/skill-surface-consistency.test.ts`, several browser journey fixtures, and legacy E2E pool/session fixtures form mutable paths from `Date.now()` alone. Two processes in the same millisecond can collide. Use `mkdtempSync`, `randomUUID`, or `<pid>-<uuid>`; timestamps may be diagnostic suffixes only.
- **Repository-local fixture output:** legacy UI fixture tests write fixed `.bobbit/tmp/ui-fixtures` paths. Those cannot be shared by concurrent commands in the same worktree; migrate generated fixture bundles to a per-run temp directory and pass its location into the bundler/test.

### Implementation and verification plan

1. Introduce a `tests2/harness/run-isolation.ts` owner that creates one canonical run root with `mkdtempSync`, records it in environment variables, redirects HOME/USERPROFILE/BOBBIT_DIR for test processes, and exposes run-scoped artifact/cache paths. Setup must run before any server/discovery import.
2. Make gateway, browser, and E2E harnesses consume that owner root instead of independently choosing fixed `bobbit-v2`/`bobbit-e2e` roots. Child workers inherit the same run root but allocate their own `mkdtemp` child.
3. Add an audit test that rejects fixed listener ports, timestamp-only mutable roots, and non-owned recursive cleanup in unit-owned tests/harnesses. Allow explicit fixture URLs only when they are not listened on.
4. Run two then three `npm run test:unit` processes from separate worktrees at the same commit, with independent `BOBBIT_V2_RUN_ID` values. Assert all pass with retries disabled for diagnosis, all created paths have distinct owner roots, no process binds a fixed port, and ledger reservations never exceed capacity. Repeat equivalent concurrent `test:browser` and `test:e2e` smoke subsets after their harness migration.

## Durable test-authoring rules

Add `docs/testing-v2/cross-os-test-authoring.md` and a one-line AGENTS.md pointer. The guide must require:

1. Use `path.resolve` plus paired `realpath`/longest-existing-prefix canonicalization for containment and temp fixture comparisons; test symlink aliases, separator normalization, and case behavior.
2. Never read a developer's real home, `.bobbit`, credentials, or MCP configuration. Every production discovery root must be injected or redirected to a unique temp fixture before initialization.
3. DOM tests must use the registered v2-dom environment setup and clear web storage; do not assume Node globals are browser globals.
4. Stub `fetch` deterministically before invoking the code under test, record requests through explicit deferreds/promises, and await observable completion. Never use `updateComplete` or wall-clock polling as evidence that unrelated fire-and-forget I/O completed.
5. Use manual clocks, deferreds, events, or promise joins for asynchronous behavior. A timeout is a diagnostic safety net, not synchronization or a primary fix.
6. New platform-specific regressions must simulate the constraint where feasible (symlinked temp root, Windows separators, unavailable storage) so Linux/macOS/Windows CI all exercise the invariant.

## Verification sequence

1. Run the three representative DOM files above under v2-dom with retry disabled for diagnosis, then the complete DOM project.
2. Run transcript trust/recovery and MCP discovery files with a symlink alias fixture and isolated HOME.
3. Run base-ref, project UI, and tools cascade integration files alone and together.
4. Run `npm run check`, then five consecutive `npm run test:unit` executions on each available OS. Record Node versions and whether symlink privileges were native or seam-simulated.
