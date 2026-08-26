# Async background cleanup

**Status:** Implemented

**Scope:** Preview artifacts, post-listen worktree maintenance, plan-mutation pruning, archive purge, and orphan cleanup

**Issue analysis:** [`async-background-cleanup-issue-analysis.md`](async-background-cleanup-issue-analysis.md)

## Purpose and boundary

Gateway maintenance used to run synchronous filesystem calls and one synchronous Git subprocess on the Node.js thread. Moving that work after `listen()` did not make it non-blocking: a large artifact tree, stale worktree root, mutation directory, or archive set could still delay unrelated health checks and session creation.

This design makes the scoped call graphs promise-only, bounded, and awaitably owned. It originally preserved the then-current cleanup policy; the current worktree mutation boundary is defined by [Preserve user worktrees](preserve-user-worktrees.md). It is intentionally a focused slice rather than a claim that all gateway synchronous I/O is gone.

## Scoped before/after inventory

| Area | Before | Current design |
|---|---|---|
| Shared tree work | Recursive synchronous walks, copies, hashes, and removals could monopolize the gateway thread or materialize wide trees. | `src/server/agent/bounded-async-work.ts` provides ordered bounded mapping, a backpressured dynamic queue, streaming traversal, descriptor-based file I/O, and targeted iterative removal. |
| Preview artifacts | `removeArtifacts`, `sweepOrphanArtifacts`, `findPreviewArtifactByHash`, metadata reads, candidate validation, recursive listing, hashing, copy, restore, and mount deletion reached synchronous filesystem APIs. | `src/server/preview/artifacts.ts` and `src/server/preview/mount.ts` use promise-only seams. Candidate discovery and metadata reads are streamed and bounded; hashing and copies are chunked; restore and mount replacement are transactional. Preview API, restore, snapshot, SSE, and purge callers await the new contracts. |
| Worktrees | `sweepOrphanedWorktrees` performed synchronous path checks; `WorktreePool` ran synchronous Git in its constructor and synchronously reclaimed startup entries; inventory and shared cleanup used synchronous discovery/removal checks. | `src/server/agent/worktree-sweeper.ts`, `worktree-pool.ts`, and `worktree-inventory.ts` use async filesystem/Git seams and bounded phases. The boot sweep is diagnostic-only, pool construction is pure, and `initialize()` fills only entries created by the current instance rather than reclaiming discovered leftovers. Exact archived-record cleanup retains targeted async removal. Graceful shutdown stops all live pools before locally draining current-instance ready entries. |
| Plan mutations | `PlanMutationStore.pruneExpired` and its interval reached synchronous directory, read, write, and unlink helpers. Ticks could overlap and stop did not join a run. | `src/server/agent/plan-mutation-store.ts` streams the directory, processes bounded batches, serializes each goal's mutations, coalesces ticks, and exposes an awaited `stopSweep()`. Route CRUD uses the same async serialization. |
| Archive purge | `getExpiredArchiveStats` synchronously statted transcripts. `purgeOneSession` reached synchronous sidecar, prompt, mount, artifact, worktree, color, session, team, and tombstone persistence. The artifact listener had a synchronous contract. | `src/server/agent/session-manager.ts` uses bounded stats, per-session purge ownership, async cleanup/persistence seams, and awaited listeners. Manual and scheduled expiry purges coalesce. Shutdown joins both expiry and immediate purges. |
| Orphan cleanup | A legacy synchronous transcript scanner remained beside the bounded async scanner, and `shouldKeepDespiteOrphan` synchronously checked the worktree and transcript. | `src/server/agent/orphan-cleanup.ts` has one streaming async scanner and one async preservation gate. All restore/archive decisions await the gate; the synchronous twins were removed. |

The scoped TypeScript-AST guard now reports a zero synchronous-I/O baseline for these production graphs.

## Shared execution model

`BACKGROUND_IO_CONCURRENCY` in `src/server/agent/bounded-async-work.ts` is the common ceiling; `RECOVERY_IO_CONCURRENCY` is its compatibility alias. The current ceiling is eight. Subsystems may use a smaller explicit bound, such as `PLAN_MUTATION_PRUNE_CONCURRENCY` for mutation files.

The important bound is operation-level, not recursive:

- `mapWithConcurrency` creates at most the configured number of long-lived workers and returns results in input order.
- `processDynamicQueue` bounds active work and pending work. A worker that cannot enqueue retains an iterative local stack instead of starting another limiter.
- `walkTree` streams directory entries, retains traversal frames proportional to depth, and periodically yields a macrotask turn during long in-memory loops.
- File bodies are never accumulated for hashing or copying. Descriptor reads use a fixed-size buffer; preview hashing currently uses 64 KiB chunks.
- `removeTree` walks one detached tree iteratively. `removePreviewTrees` and other multi-root owners bound only the independent roots, so nested concurrency cannot multiply.

Missing entries are handled at the operation that owns them. `ENOENT` remains success for idempotent cleanup; other errors remain visible to the subsystem's existing logger or result slot. Wide operations isolate items and assemble public results only after workers settle.

## Preview artifacts

### Preview scan and delete bounds

| Operation | Bound and memory behavior |
|---|---|
| Candidate lookup | `findPreviewArtifactByHash` streams `opendir()` results in batches no larger than `BACKGROUND_IO_CONCURRENCY`. Only one batch is read ahead. |
| Tree listing and copy | One backpressured operation queue bounds active and pending work. Traversal state is proportional to depth; only the metadata-required path list is retained. |
| Hashing | Files are processed in sorted order through one fixed 64 KiB buffer. File bodies are not retained. |
| One-root deletion | `removeTree` is an iterative streaming lane over an identity-detached root, not a recursive promise tree. |
| Multi-root deletion | `removePreviewTrees` and `sweepOrphanArtifacts` run no more than the shared number of independent root lanes. Preview backup/quarantine cleanup also uses a single global ownership lane. |

Here, filesystem enumeration order means the `Dirent` sequence emitted by this lookup's own `opendir()`/`Dir.read()` stream. A separate `readdir()` call—or even a separate stream—is not an ordering oracle: no cross-call, cross-API, or lexical equivalence is promised. Metadata reads may settle concurrently within one candidate batch, but the bounded mapper retains each stream index. Exact mount validation then consumes those indexed results sequentially, without prefetching the next batch, so reuse remains the first valid matching candidate from the lookup's own stream.

A candidate is reusable only when:

1. `artifact.json` is a regular no-follow file with valid session and artifact identity;
2. its entry exists in the mount;
3. its sorted file set exactly matches the record; and
4. a fresh content hash equals the record.

Corrupt, missing, mismatched, or hash-invalid candidates are skipped in place. Lookup never turns corruption into a new deletion policy.

File lists use sorted POSIX relative paths. The stable digest remains:

```text
SHA-256(path UTF-8, NUL, raw file bytes, NUL, ...)
```

Records are processed in JavaScript default sort order. Hashing reads each file through a validated descriptor in fixed-size chunks, so hashes remain byte-identical without retaining file bodies.

### Catalog bounds and version fencing

The in-memory catalog is an index, not an integrity authority. `PREVIEW_ARTIFACT_CATALOG_SESSION_LIMIT` bounds the LRU session set (currently 64), and `PREVIEW_ARTIFACT_CATALOG_CANDIDATE_LIMIT` bounds retained candidates per session (currently 256). A larger session still uses the canonical streaming batch scan; it is deliberately not cached. Catalog entries retain artifact IDs, content hashes, and exact metadata stamps, never mount bytes.

Every catalog use revalidates the session-root stamp and all retained `artifact.json` stamps—device, inode, type, modification/change times, size, and link count—under the shared ceiling. A positive hit also reopens metadata through the no-follow descriptor path and fully validates the artifact tree. Descendant changes, root changes, corrupt positives, and mount-only repairs therefore fall back to one canonical ordered scan.

Publication is fenced by both a monotonic catalog generation and the exact filesystem seam captured when an operation starts. Persist invalidates before making a new artifact directory visible; remove, sweep, failed persist, test seam changes, and cache clearing also advance the fence. A stale cached lookup or cold scan cannot publish or touch catalog state after a newer namespace mutation, even if portable timestamps or root stamps appear unchanged. Owned-install refresh is accepted only when the prior entries still validate and the current enumeration proves the exact single addition; otherwise the catalog stays cold. This retains candidate order across refreshes and LRU eviction.

### Transactional preview integrity

The gateway serializes mount mutation, artifact persistence/restore, API snapshots, SSE bootstrap, and purge per session through `src/server/server.ts::createPreviewSessionOperationQueue`.

- A mount POST does not broadcast success until the live mount and immutable artifact have both settled.
- GET snapshots run in the same queue, so entry, timestamp, hash, and artifact ID describe one mount version.
- SSE subscribes and writes its bootstrap while holding the queue. A later mutation cannot broadcast before the bootstrap, and no event can be missed between snapshot and subscription.
- Purge installs a permanent session fence before waiting for earlier work. Queued or later ordinary operations recheck the fence and cannot recreate a deleted mount.

Artifact persistence verifies the live hash, copies into a private temporary directory, rehashes and lists the copy, writes metadata by temporary-file rename, then renames the complete artifact directory into view. Artifact restore validates the immutable source before staging a copy.

`src/server/preview/mount.ts::installPreviewDirectoryTransaction` owns the live swap. It binds and hashes the exact staging identity before inspecting live state, blocks serving and waits for existing read leases, moves an existing live root intact to a same-parent backup, installs the staging root, and verifies entry, root identity, and hash before republishing. Failure detaches an invalid install and restores only the exact backup identity; a verified rollback hash republishes the old mount. An uncertain or failed rollback remains blocked and its concrete backup/quarantine path is logged rather than guessed at or deleted.

### Identity and no-follow traversal

Preview and shared tree helpers treat a pathname as a claim that must remain current, not as authority by itself:

- Directory roots must be non-symlink directories with stable device/inode identity. Canonical targets must identify the same object and remain inside the trusted store.
- Parent, operation-root, and current-entry claims are revalidated around directory opens and visitor pathname operations. Guard composition is flattened over the raw filesystem so nested wrappers do not multiply I/O or concurrency.
- `walkTree` classifies with `lstat`; directory symlinks are never opened. A replaced parent invalidates queued and local-depth-first children before visitor side effects.
- `openRegularFileNoFollow` uses `O_NOFOLLOW` where supported, then compares descriptor, pathname, expected, and canonical identities before the first read. The portable fallback fails closed when it cannot prove identity. Copies also use exclusive destination descriptors and revalidate destination root containment before bytes are written.

These rules apply to metadata, file lists, hashes, copies, restores, and targeted cleanup. They prevent a symlink or renamed replacement from turning an authorized preview path into traversal of an external tree.

### Quarantine restoration and the portable ABA boundary

`src/server/agent/bounded-async-work.ts::removeTree` never recursively deletes the caller-visible pathname. It first renames a root, or each child of a preserved root, to an unguessable same-parent `.bobbit-remove-*` path. The moved object must retain the exact device/inode/type identity before traversal, unlink, or `rmdir`.

If cleanup fails, remaining detached children and parents are restored deepest-first when the original path is absent, the original parent claim is still current, and the exact identity can be proved. A collision is never overwritten. If safe restoration is impossible, the original error owns an exact `quarantinePath` and the path is logged and preserved for retry or inspection. A mismatched replacement is never deleted.

Preview transactions use the same ownership principle with explicit preview quarantine and backup paths. Owned preview backup cleanup is serialized so independent transactions cannot multiply traversal work.

There is a known portable boundary: Node exposes pathname-based `rename`, `unlink`, and `rmdir`, not identity-bound `openat` operations or portable `renameat2(RENAME_NOREPLACE)`. Random owner-only quarantine names plus exact pre/post identity checks bound the race, but cannot exclude a malicious within-syscall ABA rename. The design therefore fails closed or preserves a named quarantine when identity is uncertain; it does not claim a stronger guarantee than the platform provides.

## Worktree maintenance

### Boot and pool lifecycle

`src/server/server.ts::runBootBackgroundTasks` starts only after the listener is available. `coordinateBootWorktreeLifecycle` awaits the diagnostic sweep before pool initialization. Pool initialization then proceeds project by project so candidate-level limits are not multiplied across projects. The gateway retains this boot promise and awaits it during shutdown.

`WorktreePool` construction performs no Git or filesystem I/O. Coalesced `initialize()` asynchronously resolves the Git top-level, derives the worktree root, and starts ordinary current-instance fill. It does not scan for or adopt a pool-shaped worktree left by an earlier process. Once initialization starts, claims use the cold-create fallback throughout pending and failed-attempt windows until an explicit retry succeeds. Failed repository-path resolution remains uncached, with matching-promise fencing so an earlier rejection cannot clear a newer retry. `stop()` prevents new work and repeatedly joins every tracked fill, freshen, claim, and late claim-failure cleanup operation.

On graceful gateway shutdown, the retained boot promise settles before the pool snapshot. The gateway starts a bounded `stop()` for every live pool before the first cleanup, then runs a separately bounded `drain()` for each pool whose stop succeeded. A failure or timeout is isolated to that pool. `drain()` snapshots only ready entries still held by that live instance; claimed session and goal worktrees have already left the pool. Drain and tracked claim-failure cleanup force `skipRemotePush: true`, so pool cleanup is local-only. Project removal continues to use the same awaited stop/drain barrier.

A crash, forced termination, or failed bounded drain may leak an entry. A later boot reports it diagnostically and neither repairs, removes, nor adopts it by branch/path/root shape. See [Preserve user worktrees](preserve-user-worktrees.md) for the authoritative ownership and failure contract.

### Worktree mutation authority

The boot sweeper uses durable-owner snapshots only to classify and report candidates. It never repairs, removes, or deletes branches for worktrees discovered from Git metadata, branch naming, root placement, or a branch-only record match.

`WorktreeInventoryService.cleanup` performs a fresh scan and serializes mutations per repository. An unverified Git worktree is non-actionable in canonical and legacy cleanup modes. Ordinary Maintenance cleanup remains available only when an archived session record exactly matches the current repository, worktree path, and non-empty branch; a final serial scan must reproduce the originally selected triple before `cleanupWorktree` starts. Branch deletion then rebuilds live and archived guards under the repository mutation queue.

The current safety boundary is:

- skip primary, detached, live-owned, shared/delegate, team/staff, Headquarters/system, and container-internal worktrees;
- treat current and legacy pool-shaped leftovers from prior processes as diagnostic-only;
- preserve branches still referenced by live or archived records;
- classify unverified Git worktrees and filesystem-only directories for attention rather than automatically deleting them;
- keep normal exact-owned lifecycle cleanup and exact archived-record Maintenance cleanup targeted—never run blanket `git worktree prune`; and
- keep per-repository Git mutations sequential while bounding independent repositories and preserving result order.

## Plan-mutation pruning and decisions

`PlanMutationStore` uses one promise tail per goal. `put`, `remove`, reads, pruning, and `decide` join that lane, so asynchronous read-modify-write operations retain the serialization previously supplied accidentally by synchronous execution. Separate goals can progress concurrently.

`decide` is the atomic decision boundary used by the nested-goal route: it reads and exclusively claims the pending request, runs approval or rejection logic while holding the goal lane, and removes the request only after the callback resolves. A competing decision cannot apply the same request, and a rejected callback leaves it pending for retry.

`pruneExpired` streams the mutation directory and stops read-ahead while each fixed-size batch is pending. It snapshots `now`, preserves entry order, removes only `expiresAt <= now`, returns the exact removed count, and isolates failures by goal.

The timer has no startup prune. Its interval callback is fenced by the timer handle and a generation so a callback already queued when stopping cannot start afterward. `runScheduledSweep` is single-flight. `stopSweep()` marks the owner stopped, advances the generation, clears the interval, then awaits the active run; repeated stops are idempotent. `ProjectContext.close`, context removal, and global context shutdown await that barrier before state directories can disappear.

## Archive purge

Archive expiry remains strict: a record is eligible only when it has an `archivedAt` older than the seven-day cutoff; equality is retained. `getExpiredArchiveStats` stats eligible transcripts through the shared ceiling. Every eligible record contributes to `count`; a missing or unreadable transcript contributes zero bytes rather than failing the endpoint.

`purgeExpiredArchives` processes its ordered archive snapshot sequentially for deterministic store transitions and logs, isolating each session failure. Manual and scheduled callers share one `archivePurgeInFlight`. Immediate and expiry purges also share a per-session owner, and stale expiry snapshots re-resolve the archived row before installing a new owner.

The purge body preserves the existing order and protections:

1. refuse a team lead still referenced by a non-archived goal, then reap children and schedule search cleanup;
2. delete only trusted transcript paths and their sidecars, then proposal drafts;
3. terminally serialize prompt, preview-mount, prompt-section, and later artifact cleanup;
4. clean only non-container, non-delegate, non-shared host worktrees, bounding multi-repo components;
5. await color, session-row, deletion-tombstone, and allowed team-row persistence, then scoped MCP cleanup; and
6. await termination listeners in registration order.

`SessionStore.purgeAsync` durably saves the row removal before recording its tombstone. Its async writer retains backup rotation, epoch/fingerprint stale-snapshot checks, `fsync`, and atomic rename. Synchronous store changes that arrive during a purge writer request another serialized pass rather than racing an older snapshot. Color, team, and tombstone stores use the same fold-into-the-active-writer rule.

### Purge completion ownership

`SessionTerminationListener` accepts promises, and `SessionManager` awaits listeners sequentially with per-listener isolation. The server listener broadcasts removal, then awaits `previewArtifacts.removeArtifacts` through the terminal preview queue. That listener owns and logs artifact-deletion failures, so `SessionManager` does not duplicate the log; the purge response still waits until the listener has handled success or failure. There is no unhandled fire-and-forget cleanup promise.

The archive schedule starts after session restoration, is idempotent, and does not purge at startup. Each daily tick joins the active purge. `stopPurgeSchedule()` clears the timer first, awaits the expiry owner, then joins every immediate per-session purge; `SessionManager.shutdown()` begins with this barrier.

## Timer lifecycle

| Owner | Start and single-flight rule | Awaited stop barrier |
|---|---|---|
| `PlanMutationStore` | Construction installs a daily interval and calls `unref()`, but performs no startup prune. Handle and generation checks fence stale queued callbacks; `runScheduledSweep` coalesces overlapping ticks. | `stopSweep()` marks stopped, advances the generation, clears the interval, then joins the active prune. Project-context removal and shutdown await it. |
| `SessionManager` archive purge | `startPurgeSchedule()` is called after restore, is idempotent, and performs no startup purge. Scheduled and manual expiry requests share one owner; immediate requests also share per-session owners. | `stopPurgeSchedule()` clears the interval, joins the expiry owner, then joins every immediate purge. `shutdown()` awaits it before other teardown. |
| Post-listen boot work and pools | This is one retained promise rather than an interval. The diagnostic sweep precedes pool initialization, and pool projects initialize sequentially without adopting discovered leftovers. | Gateway shutdown awaits the retained boot promise, starts bounded `stop()` on every live pool before any drain, then locally drains only current-instance ready entries with per-pool failure isolation. |

The rule is consistent: stop future scheduling first, fence callbacks already queued, then await work already owned.

## Orphan cleanup

`scanOrphanedTranscriptsAsync` is the single scanner. It streams `opendir().read()`, retains directory frames proportional to depth, backpressures candidate stats at the shared ceiling, and never follows symlinks. The full count remains exact while returned path and warning samples remain bounded, sorted, and deterministic. Missing or unreadable entries are isolated.

`shouldKeepDespiteOrphan` preserves the exact conservative gate at every restore/archive call site:

```text
worktree access succeeds
AND transcript stat succeeds
AND transcript age is strictly less than 24 hours
```

A missing worktree short-circuits the transcript stat; missing paths and I/O errors return false. This protects sessions whose durable metadata rolled back while their worktree and recent transcript still prove activity. Container-internal paths naturally fail the host worktree check and continue through sandbox-specific recovery policy.

## Determinism and compatibility

Asynchrony does not change public selection or response semantics:

- bounded maps retain input result order; inventories apply their existing final sort;
- artifact metadata may finish out of order, but reuse remains first-valid order from that lookup's own `Dir.read()` stream;
- hashes and metadata file lists remain stable and sorted;
- orphan cleanup returns an exact count and deterministic bounded samples;
- mutation prune and archive stats retain exact count rules;
- archive purge remains ordered, strict at the retention boundary, idempotent, and failure-isolated; and
- worktree sweep, maintenance, and legacy adapter response shapes remain unchanged.

Long traversal loops also yield cooperatively, so a fast in-memory or cached filesystem cannot replace synchronous I/O with a long uninterrupted JavaScript loop.

## Verification

`tests/unit/core/async-background-cleanup-static.unit.test.ts`, discovered from its canonical unit path and suffix, builds a TypeScript `Program` and `TypeChecker` over production source. It roots the named preview artifact/mount operations, scoped preview route and purge-listener regions, worktree sweeper/pool/inventory/cleanup, the entire plan-mutation persistence surface, archive purge/stats/timer/listener cleanup, and orphan scan/gate. It follows resolved local functions, methods, constructors, wrappers, and callback arguments and emits root-to-violation traces.

The guard rejects direct, aliased, destructured, bound, injected, or wrapped synchronous filesystem APIs; synchronous child-process APIs including `CommandRunner.execFileSync`; and `Atomics.wait`. Missing roots fail rather than silently reducing coverage. It also forbids reintroduction of the removed synchronous orphan scanner/predicate twins. Unrelated `server.ts` handling is not rooted wholesale, keeping the enforced baseline scoped and zero.

Behavioral coverage is split by invariant:

- Preview unit suites cover wide/deep traversal, ordered batched candidates, corruption and missing entries, exact hash/file-list parity, catalog bounds and generation races, descriptor/root/parent identity substitution, transactional install/rollback, quarantine restoration, cleanup idempotency, and per-item failure isolation.
- Worktree suites cover deferred event-loop progress, shared ceilings, pure pool construction, same-instance fill/claim, stop/drain barriers, diagnostic boot sweep-before-pool ordering, stale pool non-adoption, exact archived-record revalidation, shared/container protections, local-only graceful drain, and targeted symlink-safe deletion.
- Plan-mutation, archive-purge, and orphan suites use deferred fake I/O to pin event-loop progress, bounded read-ahead, goal serialization, atomic decisions, timer single-flight, stale callback fencing, awaited stop/shutdown, retention boundaries, listener ownership, scanner sampling, and every orphan-preservation decision.
- `tests/integration/gateway/search-preview-api.gateway.test.ts` holds artifact validation and purge deletion while `GET /api/health` and `POST /api/sessions` complete, then proves the preview operation itself still waits and selects the first valid artifact from a controlled `Dir.read()` stream. It also pins SSE bootstrap-before-live ordering.
- `tests/integration/gateway/preview-purge-listener-error.gateway.test.ts` proves the awaited listener owns an artifact deletion failure without making the gateway unhealthy. Existing preview route and browser journeys preserve POST, restore, reload, and historical artifact behavior.

The tests use deferred ordering and observed concurrency, not machine-speed thresholds. Readiness comes from an explicit signal at the operation boundary under test; a finite number of event-loop turns cannot prove that earlier asynchronous filesystem work has reached that boundary under contention. Test-owned deferreds that can hold a stop or listener barrier are released in failure-safe cleanup before awaiting the barrier. Otherwise an earlier assertion failure can skip the normal release and make correct production teardown wait indefinitely for the test's hold.

## Deferred synchronous-I/O areas

The following areas remain outside this focused call-graph slice:

- general gateway, configuration, and store construction/loading;
- ordinary request-path persistence outside the purge-specific async seams;
- preview content serving and general manifest/source validation outside the shared mount snapshot, hash, transaction, and serving-lease seams;
- session restore/recovery filesystem work not reached by the orphan preservation gate;
- general Git status, merge, recovery, shell discovery, and lifecycle work outside pool, sweep, inventory, and targeted cleanup;
- harness/watchdog, authentication discovery, extension-host, and Docker setup; and
- already-async cost recovery and gate-diagnostics cleanup.

These are deferred because each has a wider lifecycle, durability, or request-contract migration than this maintenance slice. Minimal shared seams were adapted where a scoped caller required them, but no excluded synchronous call is declared safe. They remain candidates for later audits; expanding this change would weaken the static guard's precise ownership and increase regression risk without improving the scoped maintenance guarantees.
