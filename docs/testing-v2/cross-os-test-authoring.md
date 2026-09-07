# Cross-OS test authoring

## Purpose

Unit, DOM, integration, browser, and E2E tests may run at the same time on one machine and checkout. The test runtime gives each coordinator a canonical run root so one run cannot discover, overwrite, or clean up another run's state. This makes cross-platform failures reproducible instead of dependent on a developer's shell, home directory, or timing.

See the [test placement table](../testing-strategy.md#test-placement-and-automatic-discovery) before creating a file, the [cross-suite runtime design](../design/isolate-unit-runtime.md) for runtime wiring, and the [Unit gate operating model](unit-gate.md) for tier-1 commands. Paths and suffixes determine ownership automatically, so moving or renaming a test can change its runner and isolation contract.

## Ownership contract

A coordinator creates one canonical temporary root before importing Bobbit discovery/server modules or spawning an owned child. Its children contain all mutable state: temporary files, HOME and Bobbit/config/agent/secrets roots, browser profiles and transform caches, reports, test output, sockets, databases, artifacts, and Node/V8 caches. A worker may create and remove only a child it owns; only the coordinator that created the root may remove the root after reporters and children settle. Failed roots are retained for diagnostics.

The **machine-global concurrency ledger** is the only mutable exception. It is captured before temporary directories are redirected so simultaneous coordinators participate in the same capacity budget. It is not a general shared test directory. Browser binaries are also resolved before HOME is redirected, but the installed browser registry is a read-only runtime dependency, not a shared mutable test resource.

Use the run-isolation helpers for writable fixture paths and child environments. Do not use checkout-local `latest` paths, a shared temp parent, a developer HOME, or a bare `os.tmpdir()` path as mutable test state.

## Environment policy

Build every test environment from the shared sanitizer before imports and before each child spawn:

1. Remove credentials and ambient Bobbit runtime/discovery inputs, including pack discovery, gateway URL/token, session identifiers/secrets, command adapters, CLI/command overrides, and GitHub command selection.
2. Preserve deliberate `BOBBIT_TEST_*` and `BOBBIT_V2_*` suite controls, unless the name is an ambient runtime/discovery input or a root owned by the harness.
3. Canonically replace every owned root and ledger key after sanitization. Environment-key replacement is case-insensitive on Windows, so alternate spellings cannot survive alongside the canonical value.
4. Apply a fixture-local override only explicitly and only after sanitization; harness-owned roots always win. Restore any process-local fixture override when the fixture ends.

A test must not rely on credentials, packs, configuration, agent state, commands, or sessions inherited from the developer shell. Regressions that cover this boundary should seed conflicting host values and prove that only their explicit fixture-local input is observed.

## Portable fixtures

Create fixture trees beneath the active run root, or pass an explicit test-local path. Use an empty fixture HOME and explicit Git identity/config with system configuration disabled; make line endings explicit with fixture attributes and LF/CRLF assertions. Use local `file://` pack/skill trees, injected command seams, in-process or loopback gateway/MCP stubs, and scoped credential/config helpers. Do not use global Git configuration, a host executable, a remote network service, or checkout state as fixture input.

For DOM tests, the Node 26 happy-dom setup must source storage from happy-dom's owning `BrowserWindow`, expose that file's local/session storage for the test, clear it between tests, and restore previous global descriptors. Do not assume Node globals, `window`, or `document.defaultView` own usable browser storage.

## Browser and E2E coordinators

Use the browser and E2E coordinator wrappers rather than invoking Playwright against a shared runtime. Each coordinator allocates its canonical root, compatibility child, Playwright profiles, transform/V8 caches, reports, and output paths. In a full E2E run, A and D use the coordinator environment directly; B then C run serially in the coordinator-owned root through the serial-cache bootstrap. B processes write separate PID-scoped transform slots. Only after B exits does the coordinator union completed slots into a contained snapshot, and each C process seeds a fresh PID-scoped slot from it. Writable slots are never shared. The runner removes the B-only dist-prebundle setting before the snapshot handoff and C start.

Focused B/C runs have no full-run prebundle or B→C handoff. They clear inherited cache settings and use the legacy wrapper, which allocates a nested root. The outer coordinator removes a successful full-run root after all children and reporting settle and retains failures. The nested wrapper may clean only its own successful root, retains failures, and honors `BOBBIT_KEEP_PWTEST_CACHE=1` only for its successful legacy-wrapper root. Browser/E2E consumers use `ensureDistBuild()` so same-worktree readers and builders serialize around a validated, atomically published `dist` manifest. See the [safe-gains E2E close-out](../e2e-performance/speed-up-e2e-332a47cc/close-out.md) for measured results; these ownership rules do not imply qualification.

The harness generates `BOBBIT_E2E_RUN_ID`; callers must not supply it or any run-root, temp-root, report, or cache-root variable. Those values are coordinator outputs, not configuration. Legacy worktree and Docker resources carry the generated ID in their paths, names, and labels. Docker teardown discovers resources by `bobbit-e2e-run=<run-id>` and removes only matching, namespace-validated containers and volumes. Never sweep a temp parent, checkout path, unlabelled resource, or another run's worktree/container/volume.

## Lifecycle observation and qualification

Synchronize on the event that proves the behavior: a health/readiness response, route or hydration completion, mutation registered before the action, correlated stream marker, settled output condition, focus boundary, media completion, or process/terminal close. Cleanup must wait for the resource it owns to settle.

Qualification is retry-free. The default `retry: 3` / `retries: 3` settings protect ordinary developer and workflow runs; they are not qualification evidence. The exact `BOBBIT_V2_RETRY_FREE=1` control makes the unit configuration and retry-capable browser/E2E groups use zero retries. E2E Group A is already retryless because its `tsx --test` invocation has no retry control.

Run qualification only through these repository wrappers:

| Shell | Unit | Browser | E2E |
| --- | --- | --- | --- |
| POSIX | `BOBBIT_V2_RETRY_FREE=1 npm run test:unit` | `BOBBIT_V2_RETRY_FREE=1 npm run test:browser` | `BOBBIT_V2_RETRY_FREE=1 npm run test:e2e` |
| PowerShell | `$env:BOBBIT_V2_RETRY_FREE = '1'; npm run test:unit` | `$env:BOBBIT_V2_RETRY_FREE = '1'; npm run test:browser` | `$env:BOBBIT_V2_RETRY_FREE = '1'; npm run test:e2e` |

A qualification record must show zero observed retries. Direct runner flags may aid diagnosis, but they are not qualification authority.

### Prohibited flake masking

Do not add sleeps, polling loops, retries, skips, `force-exit`, timeout increases, blind reloads, incidental fetch interception, or weaker assertions to make a test pass. Fix the owned fixture, resource lifecycle, or exact observable precondition instead.
