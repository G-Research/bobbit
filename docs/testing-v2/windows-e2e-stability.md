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
- Direct `RpcBridge` agents, source gateway/Vite processes, and packaged CLI processes use tracked cross-platform tree ownership. They are not published before ownership is ready, and teardown requires both tree-exit proof and the root process `close` event. Packaged health polling now races ownership readiness against root exit, spawn error, and a referenced deadline; either root failure rejects before any health request. Uncertain ownership retains the session or fixture and fails closed.
- A deliberately unref'ed raw packaged child has no event-loop owner merely because cleanup awaits its `close` promise. Failure-path tests therefore explicitly reclaim that real handle with `ref()`, force termination if needed, and await `close`. This tests the production containment path without letting a clean CI process cancel pending tests when unrelated handles are absent.
- On POSIX, each foreground shell group has a spawn-time sentinel bound to the group identity. Each command finalizes its own group with verified `TERM`/grace/`KILL` handling and awaits sentinel disappearance; session drain is the final safety net. Lost or reused identity rejects the drain instead of signalling a historical process group. Descendant qualification also compares spawn-time identity and executable state: Linux uses the `/proc` start token and Darwin uses process start time plus a fixture nonce. Zombies are terminal and a reused PID is a different identity. Windows continues to use the outer Job owner.

These fences matter because deletion retries cannot fix an owner that is still able to create processes or reopen files.

### Bounded, reparse-safe removal

Removal uses a no-follow `lstat`/`readdir`/`unlink`/`rmdir` traversal rather than recursive `fs.rm`. Symlinks and Windows junctions are removed as links and are never traversed. Stable identity, type, and link-target checks detect path replacement; uncertainty fails closed without a destructive fallback.

The traversal uses bounded concurrency and post-order directory completion. Identity validation is proportional to entries: it verifies the operation root, immediate producer, and current entry rather than rewalking every ancestor for every leaf. This keeps large prepared `node_modules` trees practical without weakening containment.

An absent path is success. Only `EBUSY`, `EPERM`, and `ENOTEMPTY` are retried, with capped exponential backoff under both an attempt limit and an absolute monotonic deadline. The same allowlist applies on every platform; unrelated errors fail immediately.

Successful final-root cleanup runs in a tracked, short-lived subprocess so its larger filesystem queue and isolated libuv thread pool do not affect the test processes. Success requires the result, transport `close`, and complete process-tree exit; timeout or protocol failure terminates and joins the tree before the coordinator settles. This prevents deletion from continuing after the reported run and makes incomplete ownership proof a test failure. Failed tests retain the whole run root, while a failed final cleanup retains whatever remains and reports the subprocess lifecycle.

A terminal `OwnedPathCleanupError` includes:

- the resolved target and owner root;
- coordinator or worker identity;
- elapsed time and complete per-attempt history;
- filesystem code, syscall, path, destination, and message when available;
- the caller's lifecycle snapshot, such as browser, gateway, or process-tree state.

Pass current lifecycle state whenever a fixture calls the remover. Do not add fixture-local retries, suppress the terminal error, follow a reparse point, or delete outside the harness-owned run root.

### Post-Git worktree cleanup

Production worktree removal uses the shared `removeTargetedTree` primitive for residue that can remain after Git has successfully removed or unregistered a worktree. This matters on Windows because Git can finish before the final checkout handle is released; a one-off `EBUSY` at this point must not either fail the purge immediately or justify deleting an unknown replacement tree.

The remover holds one process-wide cleanup slot across the full retry sequence and binds every attempt to the same exact root identity captured before Git acted. A missing target is success. Only `EACCES`, `EBUSY`, `ENOTEMPTY`, and `EPERM` are retried: production allows at most five attempts within a one-second monotonic deadline, with exponential delays starting at 50 milliseconds and capped at 400 milliseconds. The deadline also caps the final sleep, so retries cannot extend the purge indefinitely.

Identity uncertainty remains terminal. An `ESTALE` or other non-transient error is not retried, and neither is a transient error that leaves an unresolved detached quarantine identity. This fail-closed rule prevents a later attempt from accepting a different generation at the original pathname. A terminal `TargetedTreeRemovalError` retains the resolved target, elapsed time and deadline, the error cause, and ordered attempt history with codes, messages, syscall paths, destinations, and quarantine paths when available.

`cleanupWorktree` verifies that both the captured checkout and Git administration entry are absent after targeted removal. Local and optional remote branch deletion run only after those postconditions pass, so a cleanup failure cannot be hidden by deleting the branch first.

## Prepared packed consumer

The inline-HTML/theme journey verifies a clean external consumer of the actual `npm pack` artifact, including its dependency graph, packaged CLI, served UI assets, and bundled theme bridge. Expensive preparation belongs to the applicable E2E coordinator rather than each browser test.

### Preparation and reuse

The full coordinator follows this order:

```text
packed-cache seed → A → prebundle → (B ∥ packed finalization) → C → D
```

Cache seeding starts before test load. Group A and prebundle then run while the seed's original deadline continues to elapse. Group B overlaps only packed finalization, and dependent Group C starts only if both succeed. Independent Group D remains strictly last and still runs when an earlier phase fails. Seed and finalization share one immutable 300-second preparation deadline, while the complete suite keeps its fixed 900-second budget. This placement avoids asking a loaded Windows host to begin cache seeding late without increasing either deadline.

The hosted scheduler settles every phase instead of letting an exception escape the coordinator. A nonzero or throwing Group B, or a packed-finalization failure, blocks Group C without masking the failure. Seed, Group A, and prebundle failures likewise block phases whose inputs are unavailable. Group D still settles, after which the sampler stops, the report records failures and blocked work, and final owned-root cleanup or diagnostic retention runs. This makes the full schedule failure-safe without retrying product assertions.

Preparation builds one run-owned fixture:

1. Select the runtime-compatible, non-development registry identities from the committed production lock.
2. Resolve each SRI digest's canonical final path in the run-owned cacache and seed exact ambient hits through cache protocol v4.
3. Fetch only unresolved exact URLs into that isolated cache, then verify every required digest.
4. Build the distributable, run one real `npm pack`, and generate the external consumer lock offline against that tarball.
5. Confirm the consumer lock is a subset of the verified production-lock seed, then verify its required digests again.
6. Run one `npm ci --offline --ignore-scripts --no-audit --no-fund` against the run-owned cache, validate the installed template, and atomically publish the descriptor.
7. Materialize a unique mutable consumer for each test without rerunning `npm pack` or npm installation.

Both the grouped coordinator and direct Playwright wrapper use this preparation path. A matching title grep prepares exactly once. An ambiguous selector also prepares, because skipping could silently weaken coverage; only a selector proved not to match the packaged test identity skips preparation.

With ordinary `repeatEach=1`, the retry-zero packaged browser consumer claims the template once with an atomic rename. With `repeatEach>1`, every possibly overlapping iteration receives an independent physical directory copy whose name includes the repeat index. Consumers never share or symlink `node_modules`; each has independent mutable workspace, secrets, and agent state. The source and destinations stay at equal depth so relative `file:` lock references still resolve to the same packed artifact. Failed tests retain their materialized consumer, and a second one-shot claim fails rather than silently rebuilding or sharing it.

### Exact CAS seeding

The run-owned npm cache keeps its own namespace. The ambient npm cache is a read-only source of exact content-addressed blobs: its path is passed only to the tracked publication helper, never to npm or a persisted descriptor. All npm fallback, lock, and install commands receive only the run-owned cache.

Protocol v4 directly publishes canonical final cache paths. It groups deterministic same-digest URL aliases and orders digests and URLs by locale-independent JavaScript code-unit comparison. It uses public cacache operations for exact URL lookup, canonical destination resolution, and buffered `cacache.get.byDigest` verification. Work is limited to three workers. The first fatal error stops new admission, while `Promise.allSettled` joins already-admitted work and preserves deterministic accounting.

The explicit hardlink authorization is limited to exact, immutable, SRI-addressed blobs in the ambient npm CAS. For such a hit on the same device, the helper creates a no-overwrite hardlink directly at cacache's canonical final content path and verifies it by digest before use. If hardlinks are unsupported or the caches are on different volumes, the helper uses an exclusive physical copy. Permission or I/O errors, collisions, reparse or authority violations, and unresolved integrity failures fail closed. A missing or rejected cache hit can proceed only through the normal exact-URL npm fallback followed by digest verification.

Windows may expose an ordinary directory through its 8.3 short spelling, such as `RUNNER~1`, while `realpath` returns the long spelling. A changed spelling is not a general alias exemption: the helper first validates the full lexical ancestry as directories of the expected type with no symlink or reparse entry. It accepts each short-to-long expansion only when `lstat` also reports the same `dev` and `ino` identity for both spellings. Cache source ancestry is checked component by component under the canonical ambient-cache authority. A junction, mismatched identity, or unavailable identity therefore fails closed.

Direct hardlinks were selected as the minimal solution:

- Making physical copies the primary path rewrites every cached tarball, consuming most of the preparation budget and adding files that cleanup must traverse. Physical copy remains only the portability fallback.
- Reflinks are not consistently available across supported filesystems and platforms, and their copy-on-write semantics add another capability-dependent path without improving the immutable-CAS contract.
- Publishing into a staging tree and then moving or linking into cacache's final tree duplicates namespace work and cleanup surface. Protocol v4 resolves the public cacache final path first and publishes there exactly once.

The helper treats stdin, stdout, the root process `close` event, transport settlement, and verified process-tree exit as one lifecycle. Digest verification is tracked and buffered rather than left in a stream that can outlive command settlement. Each directly published blob is verified before it is accepted instead of sent to fallback. After fallback, every required seed digest is verified before seed publication; the consumer subset is verified again before installation and final descriptor publication.

### Provenance and process bounds

The descriptor is coordinator output, not trusted ambient configuration. Its only valid location is the fixed prepared-consumer directory below the authoritative `BOBBIT_V2_RUN_ROOT`. Reads and materialization verify run-root, descriptor, fixture/template/cache, tarball, and copy-destination identity before copying or executing the packaged CLI. An inherited or forged descriptor outside that layout fails closed.

Package and helper commands use tracked process-tree ownership. Timeout, output overflow, transport failure, or ownership failure requests one tree termination, then waits concurrently for actual root close and verified descendant-tree exit under a separate completion deadline. A missing close event, stalled verification, failed kill, or unverified tree remains fatal.

The Windows Job ownership-readiness cap is 90 seconds to accommodate cold hosted PowerShell startup, but it is strictly subordinate to the unchanged immutable 300-second preparation deadline. The readiness timer is armed only when it expires strictly before the remaining absolute budget. If the absolute deadline is earlier or equal, it remains the sole timer and authority; no duplicate readiness timer can race it, change the reported failure class, or issue a competing kill request. Ownership waiting still consumes the original preparation budget rather than starting a new one.

Preparation failure retains the partial fixture and `preparation-failure.json`. Diagnostics include the command, working directory, PID, ownership and kill state, root-close and tree-exit results, and bounded stdout/stderr. This preserves useful npm evidence without allowing an unbounded post-timeout wait.

## Security boundary

The remover is designed for harness-owned paths after every harness-owned writer has been fenced and joined. No-follow traversal and repeated identity checks prevent accidental reparse traversal and detect many pathname replacements, but they do not claim containment against active, malicious code running as the same OS user and racing namespace entries between checks. Strict protection from that attacker requires a native handle-relative deletion backend; the current pathname-based implementation deliberately fails closed when it detects uncertainty but does not present that stronger guarantee.

## Browser runtime measurement and observability

Browser worker tuning is measured retry-free; it is not inferred from a timed-out run. On the recorded 24-core Windows host, the clean two-worker suite completed 955 passes with 5 skips in 654.2 seconds. A quiet three-worker run produced the same result in 484.8 seconds, 169.4 seconds (25.9%) faster, with no cleanup or resource-owner failure. This supports the ledger's three-worker cap but is not a portable performance guarantee.

The Playwright configuration loads the native-ESM worker ledger with an ESM import. `createRequire` cannot load `ledger.mjs`; using it made every direct browser run silently fall back to two workers, which was slow enough for otherwise green 953–954/960 runs to miss the 900-second verification deadline. Real ledger reservations retain parent-grant reuse and release on process exit. A genuine load or reservation failure still uses the bounded two-worker fallback, but logs only a sanitized failure stage and code rather than an exception message that could expose machine paths.

The configuration logs the resolved worker count and its source: explicit measurement override, inherited ledger grant, fresh reservation, or fallback. The wrapper also emits bounded top-ten slow file and spec totals, including retries, from the existing JSON report before successful run-root deletion. These diagnostics explain throughput and host-contention failures without changing scheduling, timeouts, assertions, or retry policy. Use `BOBBIT_V2_PLAYWRIGHT_WORKERS` only for controlled measurement.

Operationally, Browser uses three Playwright project lanes in one invocation: real-MCP specs and special isolated-fixture specs each have a one-worker project, while ordinary canonical journeys use the shared browser worker grant. This lets narrow identities start without allowing real-MCP cases to overlap. In the full E2E coordinator, Group A uses two Node files, Playwright Groups B and C default to two workers, and Group D uses at most two Vitest forks. The packed-cache seed completes before Group A; only packed finalization overlaps Group B. Group C waits for both successful owners, while independent Group D remains last even if C is blocked, preserving bounded host load and the shared run-local transform cache.

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

Before these changes, cleanup policy was split across synchronous removal, fixture-local helpers, and warning-only paths. Owners could outlive deletion, producing transient `EBUSY`, `EPERM`, and `ENOTEMPTY` failures. The packaged-theme path also repeated dependency preparation, with an offline npm install reaching the 600-second timeout signature.

One later pre-fix full E2E run passed all assertions in 874.5 seconds but was killed near 903.6 seconds while deleting duplicated packed-consumer trees. A representative installed tree contained 35,479 files and 5,131 directories and occupied 620,922,686 bytes. Secure cleanup of that tree took 16.807 seconds; larger thread-pool or traversal-concurrency variants improved this by at most 0.773%, so final-root cleanup retains traversal concurrency 128 with a 32-thread isolated pool. One-shot consumption removes an entire duplicate tree and its recursive-copy cost instead of relying on marginal deletion tuning.

At cache-protocol qualification commit `a60becc6e`, a focused production-lock seed passed in 24.071 seconds:

- 287 selected identities;
- 282 exact CAS hardlinks;
- no physical copies, misses, or corrupt digests;
- five identities populated through exact-URL fallback;
- final tracked verification completed in 4.1 seconds.

One independent full Windows E2E repetition at the same commit passed with `BOBBIT_V2_RETRY_FREE=1` and retry count zero. The fixed 900-second suite completed in 888.7 seconds: Group A took 70.5 seconds, B 337.2 seconds, C 336.4 seconds, and D 93.4 seconds. Packed seed plus finalization consumed 180.638 seconds of active preparation time, and successful shared root cleanup took 23.132 seconds. The log contained no `EBUSY`, `EPERM`, `ENOTEMPTY`, `cleanup-deferred`, or `timed out after 600000ms` npm signature.

This is **one** independent retry-free repetition, not three. Earlier full or qualifying runs that were not retry-free, and failed runs affected by host starvation, remain useful historical evidence only; they do not satisfy or combine into three retry-free repetitions. The final result demonstrates removal of the known signatures in the recorded run, not universal flake elimination or a portable performance guarantee.

### Hosted PR-check repair qualification

At repair head `523cfed7b`, focused local verification passed:

- E2E scheduling plus prepared-consumer unit coverage: 91 of 91 tests;
- offline/deadline plus prepared-consumer unit coverage: 82 of 82 tests;
- browser-harness Group C ordering coverage: 12 of 12 tests;
- real packed-cache helper shutdown coverage: 4 of 4 tests.

These tests pin failure-safe phase settlement, Group C blocking with Group D continuation, sampler/report/final-cleanup reachability, 8.3 alias identity and reparse rejection, the 90-second readiness cap's subordination to the 300-second deadline, and full helper-tree joining. The workflow implementation gate also passed at that repair head.

This repair qualification is local workflow evidence. Hosted PR checks were not refreshed for this round, and the round did not add another complete retry-free full E2E repetition; the retry-free evidence therefore remains the single run recorded above.
