# Windows browser and E2E stability

## Purpose

Windows keeps file and process handles open longer than POSIX systems in several teardown paths. Browser profiles, gateway state, npm subprocesses, and file watchers can therefore make an otherwise successful test fail with `EBUSY`, `EPERM`, or `ENOTEMPTY`. Testing-v2 addresses this at the ownership boundary: stop admitting work, prove every resource owner has stopped, then remove only paths inside the current run root.

The same lifecycle, containment, and retry rules apply on Linux and macOS. This keeps one cross-platform cleanup contract rather than hiding lifecycle defects behind Windows-only retries. See [Cross-OS test authoring](cross-os-test-authoring.md) for the broader isolation and qualification rules.

## Cleanup lifecycle

The shared cleanup contract is implemented by `removeOwnedPath` and `shutdownResourcesThenRemove` in the testing-v2 owned-path cleanup module.

### Ownership and ordering

- A worker may remove only a strict child of its coordinator run root. Removing the run root itself requires explicit coordinator ownership.
- Teardown closes browser pages and fixture servers before tracked child processes, sessions, project contexts, MCP owners, and gateway HTTP/WebSocket listeners. Removal runs last.
- Owners in one phase settle together. A failure is collected rather than preventing independent shutdown phases from releasing their resources.
- Any unproved owner shutdown skips deletion and retains the root. A cleanup failure after a green test fails the coordinator; it is not downgraded to a warning.
- Failed runs are retained for diagnosis. Synchronous process-exit cleanup remains best-effort because it cannot provide an awaitable owner barrier.

Gateway and runtime shutdown enforce the same boundary:

- `VerificationHarness` closes its terminal admission latch before taking the owner snapshot. Command preparation, semaphore release, Docker transitions, reviewer/QA sessions, and subgoal creation recheck that fence; a child created in the final spawn race is killed and joined locally.
- `SessionManager` closes startup admission synchronously, dynamically joins work admitted before the latch, and rechecks after asynchronous setup boundaries. Create, delegate, restart, and restore cannot publish a late runtime after shutdown starts.
- Direct `RpcBridge` agents, source gateway/Vite processes, and packaged CLI processes use tracked cross-platform tree ownership. They are not published before ownership is ready, and teardown requires both tree-exit proof and the root process `close` event. Uncertain ownership retains the session or fixture and fails closed.
- On POSIX, each foreground shell group has a spawn-time sentinel bound to the group identity. Each command finalizes its own group with verified `TERM`/grace/`KILL` handling and awaits sentinel disappearance; session drain is the final safety net. Lost or reused identity rejects the drain instead of signalling a historical process group. Windows continues to use the outer Job owner.

These fences matter because deletion retries cannot fix an owner that is still able to create processes or reopen files.

### Bounded, reparse-safe removal

Removal uses a no-follow `lstat`/`readdir`/`unlink`/`rmdir` traversal rather than recursive `fs.rm`. Symlinks and Windows junctions are removed as links and are never traversed. Stable identity, type, and link-target checks detect path replacement; uncertainty fails closed without a destructive fallback.

The traversal uses a bounded eight-operation queue and post-order directory completion. Identity validation is proportional to entries: it verifies the operation root, immediate producer, and current entry rather than rewalking every ancestor for every leaf. This keeps large prepared `node_modules` trees practical without weakening containment.

An absent path is success. Only `EBUSY`, `EPERM`, and `ENOTEMPTY` are retried, with capped exponential backoff under both an attempt limit and an absolute monotonic deadline. The same allowlist applies on every platform; unrelated errors fail immediately.

A terminal `OwnedPathCleanupError` includes:

- the resolved target and owner root;
- coordinator or worker identity;
- elapsed time and complete per-attempt history;
- filesystem code, syscall, path, destination, and message when available;
- the caller's lifecycle snapshot, such as browser, gateway, or process-tree state.

Pass current lifecycle state whenever a fixture calls the remover. Do not add fixture-local retries, suppress the terminal error, follow a reparse point, or delete outside the harness-owned run root.

## Prepared packed consumer

The inline-HTML/theme journey verifies a clean external consumer of the actual `npm pack` artifact, including its dependency graph, packaged CLI, served UI assets, and bundled theme bridge. Expensive preparation belongs to the applicable E2E coordinator rather than each browser test.

### Preparation and reuse

When selection can include the packaged-consumer spec, the coordinator prepares one run-owned fixture before its browser group:

1. Build the distributable and run one real `npm pack` into the run root.
2. Use npm once to generate the consumer manifest and lock while populating a dedicated run-owned cache.
3. Verify that both root and installed-package lock entries are `file:` references resolving to the emitted tarball.
4. Copy the npm-generated manifest and lock into a same-depth immutable template, then run one `npm ci --offline --ignore-scripts --no-audit --no-fund` with the isolated cache and no package operand.
5. Validate the installed dependency tree and atomically publish the descriptor.
6. Copy the template into a unique mutable directory for each consumer. Copies are real directories with independent `node_modules`, workspace, secrets, and agent state; shared or symlinked dependencies are forbidden.

Both the grouped coordinator and direct Playwright wrapper use this preparation path. A matching title grep prepares exactly once. An ambiguous selector also prepares, because skipping could silently weaken coverage; only a selector proved not to match the packaged test identity skips preparation. The browser test materializes a copy without running `npm pack` or npm installation again.

### Provenance and process bounds

The descriptor is coordinator output, not trusted ambient configuration. Its only valid location is the fixed prepared-consumer directory below the authoritative `BOBBIT_V2_RUN_ROOT`. Reads and materialization verify run-root, descriptor, fixture/template/cache, tarball, and copy-destination identity before copying or executing the packaged CLI. An inherited or forged descriptor outside that layout fails closed.

Package commands use tracked process-tree ownership. Timeout, output overflow, or ownership failure requests one tree termination, then waits concurrently for root close and verified descendant-tree exit under a separate completion deadline. A missing close event, stalled verification, failed kill, or unverified tree remains fatal.

Preparation failure retains the partial fixture and `preparation-failure.json`. Diagnostics include the command, working directory, PID, ownership and kill state, root-close and tree-exit results, and bounded stdout/stderr. This preserves useful npm evidence without allowing an unbounded post-timeout wait.

## Browser runtime measurement and observability

Browser worker tuning is measured retry-free; it is not inferred from a timed-out run. On the recorded 24-core Windows host, the clean two-worker suite completed 955 passes with 5 skips in 654.2 seconds. A quiet three-worker run produced the same result in 484.8 seconds, 169.4 seconds (25.9%) faster, with no cleanup or resource-owner failure. This supports the ledger's three-worker cap but is not a portable performance guarantee.

The Playwright configuration logs the resolved worker count and its source: explicit measurement override, inherited ledger grant, fresh reservation, or fallback. The wrapper also emits bounded top-ten slow file and spec totals, including retries, from the existing JSON report before successful run-root deletion. These diagnostics explain throughput and host-contention failures without changing scheduling, timeouts, assertions, or retry policy. Use `BOBBIT_V2_PLAYWRIGHT_WORKERS` only for controlled measurement.

## Verification commands

Use retry-free mode for stability evidence. The examples below are PowerShell; the cross-OS guide lists equivalent POSIX forms.

```powershell
npm run check
npm run build

npm run test:unit -- tests/unit/core/testing-v2/owned-path-cleanup.unit.test.ts tests/unit/core/testing-v2/prepared-packed-consumer.unit.test.ts tests/unit/core/gateway-shutdown-idempotent.unit.test.ts tests/unit/core/rpc-bridge-lifecycle.unit.test.ts tests/unit/core/spawn-tree-process-cleanup.unit.test.ts --project v2-core --retry=0

$env:BOBBIT_V2_RETRY_FREE = '1'
npm run test:browser -- tests/browser/fixtures/request-admission-preview-compatibility.fixture.spec.ts
npm run test:e2e:run -- tests/e2e/browser/packaged-inline-html-theme.browser-e2e.spec.ts --project=browser-canonical --workers=1
npm run test:e2e
```

For focused Playwright runs, record the exact grep arguments and whether selection required packaged-consumer preparation. For every qualification record, capture the run root, retry count, resolved browser worker source, slow-test summary, package phase timings and pack/lock/ci counts, cleanup outcome, retained-root path on failure, and presence or absence of `EBUSY`, `EPERM`, `ENOTEMPTY`, `cleanup-deferred`, and `timed out after 600000ms`.

## Qualified reliability and runtime evidence

Before these changes, cleanup policy was split across synchronous removal, fixture-local helpers, and warning-only paths. Owners could outlive deletion, while the packaged-theme path solved its 284-package graph twice and the second lock-free offline install could reach the 600-second timeout.

Recorded Windows evidence after the changes includes:

- a real Node 24/npm 11 preparation against the packed artifact and empty isolated cache: 284 tarballs cached, offline `npm ci` completed in 22.4 seconds, and total preparation excluding the build completed in 108.1 seconds;
- the retry-free three-worker browser measurement above, plus focused packaged, preview, file-explorer, source-Vite, history, cleanup, admission-fence, runtime-ownership, and foreground-shell coverage;
- full implementation-gate build, check, unit, browser, and E2E commands passing after the final cleanup optimization;
- one pre-optimization full E2E runner where all groups finished in 688.8 seconds, followed by more than 213 seconds in serial final cleanup. The reparse-safe bounded-concurrent traversal then reduced a synthetic 300-package, 1,801-entry prepared-tree cleanup from 2,489 ms to a 475 ms median (471/475/513 ms), about 5.2× faster;
- five consecutive focused cleanup runs passing 15/15, and the full unit suite passing 12,266 tests across 1,265 files after that optimization.

The 688.8-second result isolates the former tail as cleanup rather than test execution; the synthetic benchmark explains the improvement mechanism. Neither result is a controlled end-to-end before/after benchmark, so no general runtime percentage is claimed. Three complete retry-free Windows repetitions were not recorded, and these results must not be represented as full-suite three-run qualification.
