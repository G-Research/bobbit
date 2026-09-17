# Windows browser and E2E stability

## Purpose

Windows keeps file and process handles open longer than POSIX systems in several common teardown paths. Browser profiles, gateway state, npm subprocesses, and file watchers can therefore make an otherwise successful test fail with `EBUSY`, `EPERM`, or `ENOTEMPTY`. The testing-v2 harness addresses this at the ownership boundary: resource owners are closed first, then one shared remover deletes only paths inside the current run root.

The same lifecycle and retry rules apply on Linux and macOS. This preserves one cross-platform cleanup contract instead of introducing Windows-only fixture behavior. See [Cross-OS test authoring](cross-os-test-authoring.md) for the broader isolation and qualification rules.

## Cleanup lifecycle

The shared cleanup contract is implemented by `removeOwnedPath` and `shutdownResourcesThenRemove` in the testing-v2 owned-path cleanup module.

### Ownership and ordering

- A worker may remove only a strict child of its coordinator run root. Removing the run root itself requires explicit coordinator ownership.
- Teardown releases browser pages and fixture servers before tracked child processes, session and MCP owners, project contexts, and gateway HTTP/WebSocket listeners. Removal runs last.
- Owners in one phase settle together. A failure is collected rather than preventing later shutdown phases from releasing their resources.
- Any owner-shutdown failure skips deletion and retains the root. A cleanup failure after a green test makes the coordinator fail; it is not downgraded to a warning.
- Failed test runs are retained for diagnosis. Synchronous process-exit cleanup remains best-effort because it cannot provide an awaitable owner barrier.

Gateway shutdown follows the same rule internally. It is idempotent, joins MCP initialization before disconnecting each unique manager, awaits HTTP and WebSocket close callbacks, continues through independent teardown failures, and reports them as one aggregate result. This matters because retrying deletion while an owner is still live only hides the lifecycle defect.

### Bounded removal

Recursive removal treats an absent path as success. Only the transient lock/removal codes `EBUSY`, `EPERM`, and `ENOTEMPTY` are retried, using capped exponential backoff under both an attempt limit and an absolute monotonic deadline. The same bounded allowlist is used on every supported platform; unrelated errors fail immediately.

A terminal `OwnedPathCleanupError` includes:

- the resolved target and owner root;
- coordinator or worker identity;
- elapsed time and complete per-attempt history;
- error code, syscall, path, destination, and message when supplied by the filesystem;
- the caller's lifecycle snapshot, such as browser, gateway, or process-tree state.

Pass current lifecycle state whenever a fixture calls the remover. Do not add a fixture-local retry loop, suppress the terminal error, or delete outside the harness-owned run root.

## Prepared packed consumer

The packaged inline-HTML/theme journey still verifies a clean external consumer of the actual `npm pack` artifact, including its dependency graph, packaged CLI, served UI assets, and bundled theme bridge. Expensive package preparation moved from the test body to the applicable E2E coordinator so those assertions do not require repeated installs.

### Preparation and reuse

When the packaged-consumer spec is selected, the coordinator prepares one run-owned fixture before its browser group starts:

1. Build the distributable and run one real `npm pack` into the run root.
2. Resolve the clean consumer lock and populate a dedicated run-owned npm cache.
3. Install the emitted tarball once into an immutable template with `--offline`, `--ignore-scripts`, `--no-audit`, `--no-fund`, and the isolated cache.
4. Validate the lockfile and installed dependency tree, then atomically publish the descriptor.
5. Copy the template into a unique mutable directory for each consumer. Copies are real directories with independent `node_modules`, workspace, secrets, and agent state; shared or symlinked dependencies are forbidden.

Both the grouped E2E coordinator and the supported direct Playwright wrapper use this preparation path. Unrelated focused runs skip it. The browser test materializes a copy without running `npm pack` or `npm install` again.

### Provenance boundary

The descriptor is coordinator output, not trusted ambient configuration. Its only valid location is the fixed prepared-consumer directory below the authoritative `BOBBIT_V2_RUN_ROOT`. Reads and materialization verify the declared run root, descriptor identity, fixture/template/cache layout, emitted tarball identity, and copy destination before reading, copying, or executing the packaged CLI. An inherited or forged descriptor outside that layout fails closed.

Preparation failure retains the partial fixture and a `preparation-failure.json` record containing command evidence. This keeps the npm state needed for diagnosis instead of erasing it with a second cleanup path.

### Package process bounds

Package commands use tracked process-tree ownership. Timeout, output overflow, or ownership failure requests one tree termination, then waits concurrently for the root process to close and for verified descendant-tree exit under a separate completion deadline. A missing close event, stalled verification, failed kill, or unverified tree remains fatal.

Diagnostics retain the command, working directory, PID, ownership state, kill request, root close result, tree-exit result, and bounded stdout/stderr. The completion bound prevents the old package timeout from being followed by an unbounded wait for descendants.

## Verification commands

Use retry-free mode for stability evidence. The examples below are PowerShell; the cross-OS guide lists equivalent POSIX forms.

```powershell
npm run check
npm run build

npm run test:unit -- tests/unit/core/testing-v2/owned-path-cleanup.unit.test.ts tests/unit/core/testing-v2/prepared-packed-consumer.unit.test.ts tests/unit/core/gateway-shutdown-idempotent.unit.test.ts --project v2-core --retry=0

$env:BOBBIT_V2_RETRY_FREE = '1'
npm run test:browser -- tests/browser/fixtures/request-admission-preview-compatibility.fixture.spec.ts
npm run test:e2e:run -- tests/e2e/browser/packaged-inline-html-theme.browser-e2e.spec.ts --project=browser-canonical --workers=1
npm run test:e2e
```

For a qualification record, capture the run root, retry count, package preparation timings and pack/install counts, cleanup outcome, retained-root path on failure, and absence or presence of the known signatures: `EBUSY`, `EPERM`, `ENOTEMPTY`, `cleanup-deferred`, and `timed out after 600000ms`.

## Reliability and runtime evidence

Before this change, cleanup policy was split across synchronous removal, fixture-local helpers, and warning-only paths. Some gateway close callbacks and subprocess descendants could outlive deletion. The packaged-theme path also performed package preparation before the job and repeated `npm pack` plus a clean offline install in the browser test, exposing a 600-second install timeout.

After the change, focused Windows evidence showed:

- the shared cleanup suite passing transient-success, absolute-deadline, non-transient, containment, diagnostics, and shutdown-order cases across Windows, Linux, and macOS seams;
- the exact preview cleanup fixture passing 2/2 retry-free, file-explorer passing 2/2, source Vite passing 1/1, and the history-fork API integration passing 11/11 retry-free;
- the combined cleanup, prepared-consumer, provenance, and run-isolation set passing 63 tests;
- the packaged theme journey passing 4/4 retry-free with exactly one pack and one offline install, and the native package E2E passing 2/2 retry-free;
- one recorded Windows preparation completing in about 142 seconds without the prior 600-second timeout or transient-cleanup signatures; a separate targeted packaged-browser run completed in about 1.8 minutes.

This is targeted evidence, not a controlled before/after benchmark. Eliminating duplicate package preparation reduces the number of expensive installs from repeated per-test work to one per applicable coordinator, but no general runtime percentage is claimed. Three complete retry-free Windows repetitions were not recorded, so these results must not be represented as full-suite three-run qualification.
