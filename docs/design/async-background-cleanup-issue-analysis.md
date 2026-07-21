# Async background cleanup: issue analysis

Status: issue-analysis artifact

Scope: the focused background-sweeper, purge, orphan-cleanup, and preview-artifact slice described by goal **Async Background Cleanup**

## 1. Finding and target state

The affected entry points are nominally asynchronous or run after `listen()`, but they still execute synchronous filesystem calls, one synchronous Git child process, synchronous recursive copies/removals, and synchronous store rewrites on the gateway thread. Moving work after `listen()` therefore moved the stall; it did not remove it. A large preview tree, stale worktree root, mutation directory, or archive set can still delay unrelated `GET /api/health` and `POST /api/sessions` requests.

The target state is:

- every filesystem and subprocess operation in the scoped production call graphs is promise-based;
- wide work is bounded by one small shared ceiling (use the existing `RECOVERY_IO_CONCURRENCY = 8` convention in `src/server/agent/bounded-async-work.ts`, renamed or aliased for the broader background-I/O role);
- recursive work uses a dynamic bounded queue rather than nested `Promise.all`, recursive synchronous calls, or an unbounded queue of tree nodes;
- periodic jobs are single-flight and their stop/shutdown path can await the active run;
- existing selection order, counts, error isolation, path/ownership guards, retention policy, API shapes, and preview hashes remain unchanged.

This document inventories current production and existing-test edges. Function names, rather than line numbers, are the durable anchors.

## 2. Shared mechanics

### 2.1 Bounded I/O primitive

Extend `src/server/agent/bounded-async-work.ts` rather than introducing subsystem-specific limiters.

Required primitives:

1. Keep `mapWithConcurrency(items, limit, worker)`, which retains input result order.
2. Extract a dynamic queue worker used by `scanOrphanedTranscriptsAsync` into the same module. Directory jobs may enqueue child directory/file jobs, but the number of active filesystem promises never exceeds eight.
3. Add a symlink-safe bounded tree helper for copy/remove operations. It must use `lstat`/`Dirent` and never follow a directory symlink. A symlink is copied as a link only where current copy semantics require it, or removed as the link itself; it is never traversed.
4. Do not use nested limiters. Discovery, validation/hash, copy, and delete are separate phases sharing one operation-level queue. A bounded outer map must not call a second eight-worker inner map.
5. Do not use recursive `fs.promises.rm(..., { recursive: true })` or `fs.promises.cp(..., { recursive: true })` for the large scoped trees: those APIs are asynchronous but do not expose an application-verifiable concurrency ceiling. Use the bounded tree helper.
6. Use `opendir`/iterative frames where practical so traversal does not retain every tree node. Preview metadata inherently stores the complete sorted relative file-name list; retaining those path strings is required by the format, but file bodies and a second full tree representation must not be retained. Hash files by fixed-size `FileHandle.read` chunks.

A ceiling of eight preserves the already-tested orphan-scanner convention. Tests must inject a lower limit, normally two or three, and observe the maximum active operations.

### 2.2 Error and `ENOENT` rule

Avoid `exists` followed by an operation. Attempt `readFile`, `stat`, `unlink`, `rmdir`, or `rm` and interpret `ENOENT` at the operation that owns the result. Retain a pre-check only where its result is part of the policy decision, such as distinguishing an existing live preview mount from no mount before restore rollback.

Best-effort collection remains per item: one unreadable artifact, repo, mutation file, transcript, or archive must not stop its siblings. Errors that are currently surfaced as typed preview errors remain typed. Errors currently logged continue to be logged at the same ownership layer.

### 2.3 Timer single-flight pattern

Each interval owner keeps both a timer handle and an in-flight promise:

```ts
private timer?: TimerHandle;
private runInFlight: Promise<void> | null = null;
```

A tick returns immediately when `runInFlight` is non-null. Otherwise it installs the promise before doing work, owns/logs rejection, and clears it in `finally`. Stop first clears the interval, then awaits the captured in-flight promise. Starting twice is idempotent and cannot leak the older timer.

## 3. Preview artifacts and preview-mount cleanup

### 3.1 Production call graph

#### Persist and reuse

```text
POST /api/preview/mount
  src/server/server.ts::handleApiRoute (preview POST block)
  -> previewMount.writeInline | previewMount.mountFile
  -> previewArtifacts.persistPreviewArtifact
       src/server/preview/artifacts.ts
       -> previewMount.mountDir
       -> safeStat / hashDirectory / listFiles
       -> findPreviewArtifactByHash
          -> readPreviewArtifact
          -> validateArtifactMount
             -> listFiles / hashDirectory
       -> copyDirectory
       -> hashDirectory / listFiles
       -> writeJsonAtomic
       -> rename temporary artifact directory
  -> openPreviewMountWorkspaceTab
  -> broadcastPreviewChanged
  -> JSON response
```

`persistPreviewArtifact` is synchronous today. The route does not broadcast or return success when artifact persistence fails, although the live mount has already been written. Reuse is per session and returns the first valid matching candidate in filesystem enumeration order.

#### Restore

```text
POST /api/preview/mount { artifactId }
POST /api/preview/artifacts/:artifactId/restore
  src/server/server.ts::handleApiRoute
  -> previewArtifacts.restorePreviewArtifact
       -> readPreviewArtifact
       -> validateArtifactMount
       -> copyDirectory(artifact, staged restore)
       -> hashDirectory(staged restore)
       -> optional copyDirectory(live mount, rollback backup)
       -> wipeContents(live mount)
       -> moveContents(staged restore, live mount)
       -> on failure: wipe live mount and restore backup
       -> delete staged/backup trees
       -> stat restored entry
  -> broadcastPreviewChanged
  -> JSON response
```

Validation and staging deliberately occur before the live mount is touched. Missing, wrong-session, and corrupt artifacts must continue to leave the current mount unchanged. Once the swap begins, rollback remains best-effort and rollback failure remains logged.

#### Lookup and SSE bootstrap

```text
GET /api/preview/mount
  -> previewMount.mountDir
  -> content-route.ts::pickEntry
  -> fs.statSync(entry)
  -> previewMount.contentHashForMount
     -> hashMountDirectory / listMountFiles
  -> previewArtifacts.findPreviewArtifactByHash

GET /api/sessions/:sid/preview-events
  -> subscribePreviewChanged
  -> same pick/stat/hash/find bootstrap
  -> keepalive interval
```

The SSE route subscribes before its current synchronous bootstrap, which prevents a write between bootstrap and subscription. Introducing awaits must not reintroduce a stale-bootstrap-after-live-event race.

#### Cleanup and purge

```text
SessionManager.purgeOneSession
  -> cleanupSessionPrompt
     src/server/agent/system-prompt.ts
     -> synchronous prompt unlink
     -> previewMount.removeMount
        -> synchronous recursive rm
  -> awaited purge work and store removal
  -> synchronous termination listeners
     server.ts purge listener
     -> previewArtifacts.removeArtifacts
        -> synchronous recursive rm
```

`removeArtifacts` has one production caller, the purge listener in `src/server/server.ts`. `sweepOrphanArtifacts` currently has no production caller; it is a public maintenance/test helper and remains a static-guard root.

Direct immutable artifact serving in `src/server/preview/content-route.ts::handlePreviewRequest` uses only the validated `artifactMountDir` path; it does not read metadata or validate/hash candidates.

### 3.2 Synchronous I/O inventory

| File and function | Current blocking operation | Semantic constraint |
|---|---|---|
| `src/server/preview/artifacts.ts::persistPreviewArtifact` | `existsSync`, `statSync`, `mkdirSync`, `renameSync`, recursive copy/remove, sync JSON write | Validate live entry and live hash first; reuse before allocating; five collision attempts; atomic temporary directory promotion |
| `readPreviewArtifact` | `existsSync`, `readFileSync` | Missing metadata is 404; unreadable/invalid/mismatched metadata is 500 |
| `restorePreviewArtifact` | sync copy/list/hash/stat/rename/remove | Stage and validate before wipe; backup only when live mount existed; rollback on swap failure |
| `removeArtifacts` | `rmSync({ recursive: true })` | Invalid session ID is a no-op; missing tree is success; idempotent |
| `sweepOrphanArtifacts` | `existsSync`, `readdirSync`, per-directory `rmSync` | Keep valid known session IDs case-insensitively; delete every other directory, including non-session directory names; ignore non-directories; sorted `removed`/`kept` results; per-item failure isolation |
| `findPreviewArtifactByHash` | `existsSync`, `readdirSync`, then sync read/list/hash per candidate | Preserve `readdir` candidate order and first valid reuse; corrupt/mismatched candidates are skipped, not deleted |
| `validateArtifactMount` | sync stat/list/hash | Entry present, exact file-set equality, then content hash equality |
| `copyDirectory`, `writeJsonAtomic`, `hashDirectory`, `listFiles`, `safeStat`, `wipeContents`, `moveContents` | all filesystem work is synchronous; recursive listing can overflow/defer for a deep/wide tree | Preserve sorted POSIX relative paths and fallback copy-on-rename-failure behavior |
| `src/server/preview/mount.ts::mountDir` as called above | injected `mountFs.mkdirSync` | Do not create a mount merely to test whether it existed during restore |
| `contentHashForMount`, `hashMountDirectory`, `listMountFiles` | injected sync read/readdir | Hash must remain byte-identical to artifact hashing |
| `removeMount` | injected `rmSync({ recursive: true })` | Invalid ID and missing tree are no-ops |
| `src/server/preview/content-route.ts::pickEntry` as used by API/SSE bootstrap | `readdirSync` | `index.html`, then `inline.html`, then alphabetically first HTML |
| `src/server/server.ts` preview GET/SSE blocks | `existsSync`, `statSync` | 404/best-effort bootstrap behavior and response shape |
| `src/server/agent/system-prompt.ts::cleanupSessionPrompt` and `purgePromptSectionsJson` | `existsSync` + `unlinkSync`; mount delete transitively | Prompt errors remain cleanup-local; purge does not fail wholesale |

The stable preview hash algorithm is exactly:

1. sort POSIX relative file paths using the existing JavaScript default `.sort()` order;
2. for each path update SHA-256 with UTF-8 path bytes, `NUL`, raw file bytes, `NUL`;
3. lowercase hexadecimal digest.

Directories and non-files are not hashed. Directory-read failure currently contributes no descendants; file-read failure fails the hash/validation. The async implementation must preserve this distinction and must stream bytes in sorted file order.

### 3.3 Async signature and ordering plan

1. Make `persistPreviewArtifact`, `readPreviewArtifact`, `restorePreviewArtifact`, `removeArtifacts`, `sweepOrphanArtifacts`, `findPreviewArtifactByHash`, `validateArtifactMount`, and all filesystem helpers return promises.
2. Add a promise-only injectable artifact filesystem. Do not expose sync methods on the new seam.
3. Export one async mount-tree hash helper and use it from artifact persistence/validation and `contentHashForMount`; add an async `pickEntry` for API/SSE bootstrap without forcing the unrelated content-serving path into this goal.
4. Await persist/restore in both preview POST routes, await hash/find/stat in preview GET and SSE bootstrap, and await mount/artifact removal in purge.
5. Serialize preview mutation/persist/restore by session ID. Synchronous code currently gives these operations an implicit critical section; converting them independently would allow a second mount write to change the live tree while the first request is hashing or copying it. The lock must cover mount mutation through artifact persistence and cover the whole restore swap/rollback.
6. GET mount snapshot takes the same session lock so entry, mtime, content hash, and artifact ID describe one tree version.
7. For SSE, wait for the session lock, subscribe while holding it, take/write the bootstrap snapshot, then release. Events that occurred before the lock are represented by the snapshot; mutations cannot broadcast a newer event until bootstrap is written. This preserves bootstrap-before-live ordering without a missed-event window.
8. Candidate validation in `findPreviewArtifactByHash` remains sequential in the `readdir` result order. Internal traversal/hash work is bounded, but candidates must not race for “first valid match.”
9. `sweepOrphanArtifacts` may delete independent session directories through the bounded mapper. Collect outcomes in enumeration order and sort both public arrays at the end exactly as today.
10. Bounded removal must propagate non-`ENOENT` errors to the owning purge listener. `force`/missing remains idempotent. This makes the existing listener error log meaningful instead of hiding every removal failure inside `removeArtifacts`.

The purge listener contract should become `void | Promise<void>` (or use a dedicated async purge-listener channel) and `SessionManager` should await listeners in registration order with per-listener `try/catch`. Do not write `void removeArtifacts(...).catch(...)` behind the current synchronous contract: purge completion must mean preview cleanup settled, and errors must have one owner.

## 4. Worktree sweep, pool, inventory, and cleanup

### 4.1 Post-listen production call graph

```text
Gateway start, src/server/server.ts::runBootBackgroundTasks
  -> sweeperTask
     -> isGitRepo / getRepoRoot for single-repo projects (already async)
     -> snapshot goal/session/team/staff ownership
     -> sweepOrphanedWorktrees
        src/server/agent/worktree-sweeper.ts
        -> resolveSingleRepoRoot (sync upward .git walk)
        -> sync project/repo/.git existence checks
        -> async git worktree list --porcelain
        -> parseGitWorktreeList
        -> pool classifier OR owner/path/branch guard
        -> async git worktree repair on drift
        -> cleanupWorktree for unowned attached worktrees
  -> poolInitTask (concurrent with sweeper by design)
     -> async isGitRepo / getRepoRoot
     -> SessionManager.initWorktreePoolForProject
        -> new WorktreePool
           -> resolveRepoToplevel
              -> execGitSync(git rev-parse --show-toplevel)
        -> WorktreePool.startFilling
           -> reclaimOrphaned
              -> sync root enumeration/path checks
              -> inspectMultiRepoPoolCandidate (sync access checks + async Git)
           -> replenish -> _fill
              -> createWorktree | createWorktreeSet
              -> runComponentSetups
```

`runBootBackgroundTasks()` is launched with `void` after `listen()`. Its rejection is internally caught per task, but the aggregate promise is not retained for shutdown.

Sweeper and pool initialization intentionally overlap because their branch sets are disjoint: the sweeper never deletes a Bobbit pool branch, while pool reclaim only adopts a valid pool branch.

### 4.2 Pool and shared-helper synchronous inventory

| File and function | Current blocking operation | Required treatment |
|---|---|---|
| `src/server/agent/worktree-pool.ts::execGitSync` / `resolveRepoToplevel` / constructor | injected `CommandRunner.execFileSync` for `git rev-parse --show-toplevel` | Remove sync wrapper; constructor becomes pure; resolve in awaited initialization |
| `inspectMultiRepoPoolCandidate` | `fs.accessSync` on component repos/worktrees and `.git` | async access/stat, preserving “all declared distinct repos complete and on same branch” rule |
| `reclaimOrphaned` | `existsSync`, `readdirSync`, per-entry `existsSync` | bounded async root scan; target-size early stop; per-candidate skip on error |
| `WorktreePool.drain` | unbounded `Promise.allSettled` over entries | bounded ordered cleanup; retain stop-before-delete barrier and all-settled behavior |
| `src/server/skills/git.ts::createWorktree` reached from pool fill | `existsSync`; partial-worktree/admin `rmSync` checks | async path operations and bounded targeted removal; preserve actionable Windows/file-lock error |
| `createWorktreeSet` reached from pool fill | `existsSync`, `mkdirSync` | async mkdir/access; preserve declared repo order and no-container-on-empty behavior |
| `src/server/skills/worktree-setup.ts::runComponentSetups` test audit hook | `mkdirSync`, `appendFileSync` when `recordSetupPath` is injected | async audit write because it is transitively reachable from pool fill |
| `src/server/skills/git.ts::cleanupWorktree` | `existsSync(repoPath)` and targeted admin `existsSync`/`rmSync` | async operation-first handling; retain exact admin entry removal and never blanket `git worktree prune` |

The sync Git Bash discovery at module initialization in `src/server/agent/shell-util.ts` is not executed by a sweep tick or pool operation; it is explicitly outside this call-graph slice. The new guard should follow callable declarations from scoped roots, not treat every imported module’s top-level initialization as a callee.

### 4.3 WorktreePool initialization and lifecycle

`WorktreePool` must not run Git in its constructor. Use an awaited `initialize(activeWorktreePaths)` or async factory:

- constructor stores options only;
- initialization asynchronously resolves the enclosing Git top-level, derives the correct resolved worktree root, scans/reclaims orphan pool entries, and only then exposes the pool to claims;
- `SessionManager.initWorktreePoolForProject` becomes async and coalesces concurrent initialization per project;
- both callers in `src/server/server.ts` await it: post-listen startup pool initialization and new-project creation;
- until initialization completes, new sessions take the existing cold-create fallback rather than claim an unresolved pool;
- initialization failure remains per-project best-effort and does not prevent the gateway from serving;
- `startFilling`/initialization is single-flight; `stop` prevents a late initialization/fill/freshen from scheduling more work;
- `drain` continues to await `stop` before deleting entries; normal gateway shutdown still leaves ready pool entries on disk for next-boot reclaim, while explicit project deletion/maintenance drains them.

The gateway should retain the one-shot `runBootBackgroundTasks` promise and await it, or an abort-aware settled barrier, before destroying SessionManager/project-context resources. This prevents a late pool initialization or sweep from touching a removed project during shutdown. It is not a new automatic cleanup policy.

### 4.4 Sweeper safety and result semantics

The async sweeper must preserve all current guards:

- skip Headquarters/hidden contexts before Git discovery;
- require the configured repo directory itself to have `.git`; never let Git walk upward from a non-repo fixture and enumerate a parent checkout;
- skip each configured repo’s primary worktree;
- skip `/workspace` and `/workspace-wt` container-internal paths;
- treat live goal/session/team/staff branches, `worktreePath`, `cwd`, and every `repoWorktrees` value as owners;
- protect multi-repo component worktrees underneath a durable team branch container;
- treat archived branches as durable branch references: their worktree may be removed, but `deleteBranch` is false;
- skip detached worktrees;
- leave every current/legacy pool branch to `WorktreePool.reclaimOrphaned`; preserve the current `reclaimed` counting rule;
- repair only a branch-owned/path-drifted worktree, and leave it untouched if repair fails;
- isolate repo-list, repair, and cleanup failures; preserve `{ reclaimed, cleaned, repaired }` and current logs.

Thread the injected `commandRunner` through the server call, the repair call (currently omitted there), and `cleanupWorktree`. Thread the existing remote policy as well; do not accidentally contact a non-local remote in tests or change deletion policy.

### 4.5 WorktreeInventoryService call graph and sync inventory

Production routes in `src/server/server.ts` create a fresh `WorktreeInventoryService` for:

- `GET /api/maintenance/worktrees` -> `scan`;
- `GET /api/maintenance/orphaned-worktrees` -> `legacyOrphanedWorktrees` -> `scan`;
- `GET /api/maintenance/archived-session-worktrees` -> `legacyArchivedSessionWorktrees` -> `scan`;
- both cleanup POST routes -> fresh `scan` -> selection -> `cleanupWorktree` -> verify path/Git metadata -> optional branch delete.

Current blocking edges in `src/server/agent/worktree-inventory.ts` are:

- injected `fs` only exposes `existsSync`, `readdirSync`, `statSync`;
- `discoverRepos`, `contextRepoPaths`, and `resolveSingleRepoRoot` synchronously walk ancestors for `.git`;
- candidate creation calls synchronous `exists` repeatedly;
- `addFilesystemCandidates` synchronously enumerates each configured worktree root;
- archived candidate construction/reclassification calls synchronous `exists`;
- `scan` classifies every candidate with an unbounded `Promise.all`;
- `worktreeRemoved` synchronously checks the path before its async Git verification.

Change the injected dependency to promise-only filesystem methods. Make repo discovery/root resolution, filesystem candidates, archived candidates, and verification async. Run each phase with the shared ceiling and do not nest phases. Use ordered bounded mapping for classification so final sorting/counting and response shape remain deterministic.

Cleanup must still rescan immediately before selection and preserve:

- primary, live-owner, live-branch, staff/team/delegate, container-internal, and pool protection;
- archived shared-delegate protection;
- only Bobbit-owned Git worktrees are automatically actionable;
- filesystem-only directories remain “needs attention,” not deleted;
- pool entries remain diagnostic/reclaim-only;
- invalid or stale selections are skipped;
- branch deletion is rechecked after worktree removal against live and other archived references;
- remote branch deletion remains best-effort and policy-gated;
- response arrays/count maps and legacy `{ cleaned }` adapter shape remain unchanged.

Independent selected items may be processed through ordered bounded mapping. Accumulate public results/counts in original selected order after workers settle so scheduling cannot change response order.

## 5. PlanMutationStore pruning and timer

### 5.1 Current call graph and blocking operations

Every `ProjectContext` constructs `PlanMutationStore` in `src/server/agent/project-context.ts`. Unless tests pass `{ startSweep: false }`, the constructor starts a 24-hour interval:

```text
PlanMutationStore constructor interval callback
  -> pruneExpired
     -> existsSync(plan-mutations dir)
     -> readdirSync
     -> readFile(goalId)
        -> existsSync + readFileSync + JSON.parse
     -> writeFile(goalId, kept)
        -> ensureDir: existsSync + mkdirSync
        -> empty: existsSync + unlinkSync
        -> non-empty: writeFileSync
```

The timer callback is not single-flight. `stopSweep` only clears future ticks and does not wait for a pending prune. It is never called from `ProjectContext.close`, so context removal/shutdown can leave the timer alive. `ProjectContextManager.remove` also fires `ctx.close()` without awaiting it.

The same read/write helpers serve route-driven `put`, `get`, `remove`, and `listForGoal` calls in `src/server/agent/nested-goal-routes.ts`.

### 5.2 Async design

Convert the store’s file helpers and public CRUD/prune methods to promises, then await the four nested-goal route call sites. This is a small, self-contained store conversion and avoids maintaining sync and async versions of the same mutation-file parser/writer.

Because sync execution currently serializes all read-modify-write operations implicitly, add a per-goal async mutation queue. `put`, `remove`, and one goal’s prune operation must not lose updates to each other. Reads wait for the goal’s preceding queued write. Prune may process different goal files with the shared ceiling; each goal still uses its own queue. Preserve direct JSON shape, replacement/append order, empty-file deletion, read-error-as-empty behavior, logs, and the returned number of expired entries.

Timer changes:

- coalesce overlapping scheduled ticks;
- make `stopSweep(): Promise<void>` clear then await active prune;
- call/await it at the beginning of `ProjectContext.close`;
- make `ProjectContextManager.remove` async and await `ctx.close`, and await that route call in `server.ts`;
- retain no-startup-prune behavior and the 24-hour TTL/cadence.

## 6. Archive stats, purge, and listener cleanup

### 6.1 Entry points and schedule

```text
GET /api/maintenance/expired-archives
  -> SessionManager.getExpiredArchiveStats

POST /api/maintenance/purge-archives
  -> SessionManager.purgeExpiredArchives
  -> getExpiredArchiveStats

DELETE /api/sessions/:id (already archived, or ?purge=true)
  -> SessionManager.purgeArchivedSession
  -> purgeOneSession

24-hour interval started by SessionManager.startPurgeSchedule
  -> purgeExpiredArchives
```

`startPurgeSchedule` is called after session restore. There is no startup purge. `purgeExpiredArchives` snapshots archived sessions, checks `archivedAt < now - seven days`, and processes them sequentially with per-session `try/catch`. Exact seven-day age is not expired. `archivedAt` must be present/truthy. These rules must not change.

The interval can overlap a preceding scheduled run or a manual purge. `shutdown` clears the timer but does not await an active run.

### 6.2 `getExpiredArchiveStats`

`src/server/agent/session-manager.ts::getExpiredArchiveStats` is declared async but uses `fs.statSync` per expired transcript. It increments `count` even when the file is missing/unreadable, and only successful stats contribute bytes.

Use bounded async stats, preserve archive snapshot order and integer sum, and preserve the existing `{ count, totalSizeBytes }` response. Do not turn an unreadable transcript into an endpoint failure.

### 6.3 `purgeOneSession` complete cleanup graph

The operation, in current order, is:

1. team-lead safety gate via `canPurgeTeamLeadSession`; refuse a lead still referenced by a non-archived goal;
2. `cascadeReapOwner` for live and dormant children;
3. schedule search-index removal;
4. delete a trusted transcript via `sessionFileDelete`, then delete its Bobbit sidecar;
5. delete proposal drafts;
6. `cleanupSessionPrompt`, which also deletes the preview mount;
7. delete persisted prompt-section JSON;
8. remove non-container, non-delegate, non-shared worktrees (all per-repo worktrees for multi-repo);
9. remove the color mapping;
10. purge the session-store row and record the deletion tombstone;
11. remove a dangling team-store row for an allowed team-lead purge;
12. clean scoped MCP managers;
13. invoke termination listeners; the server listener broadcasts removal and deletes preview artifacts.

Current synchronous operations reachable on that graph are:

| File/helper | Blocking work |
|---|---|
| `src/server/agent/session-fs.ts::sessionFileDelete` | host/fallback `unlinkSync` |
| `session-manager.ts::purgeOneSession` sidecar block | `existsSync` + `unlinkSync` |
| `system-prompt.ts::cleanupSessionPrompt` / `purgePromptSectionsJson` | sync prompt JSON/Markdown unlinks; sync preview mount removal |
| `git.ts::cleanupWorktree` | sync repo/admin existence and recursive admin removal |
| multi-repo worktree block | unbounded `Promise.allSettled` |
| `color-store.ts::ColorStore.remove -> save` | sync exists/mkdir/write of `session-colors.json` |
| `session-store.ts::SessionStore.purge -> saveNow` | sync stat/read epoch, backup rotate/copy, open/write/fsync/close/rename, temp cleanup |
| `deletion-tombstones.ts::recordDeletionTombstone` | sync mkdir/read/write |
| `team-store.ts::TeamStore.remove -> save` | sync exists/mkdir/write |
| `server.ts` purge termination listener | sync recursive artifact deletion |
| child cascade when children remain | child model-name unlink and the same synchronous store archive persistence |

Proposal-draft deletion is already promise-based but uses an unbounded native recursive removal; route it through the bounded tree remover for this large-tree cleanup slice.

Exact persisted paths outside trusted agent-session roots remain read-compatible but must never be deleted, including sidecars. Container-internal `/workspace` worktrees and delegate/shared worktrees remain protected. Multi-repo cleanup continues to isolate each component result and must not fail the purge wholesale.

### 6.4 Async purge design

- Make host transcript and sidecar deletion direct async unlink operations with `ENOENT` success.
- Use async prompt/preview cleanup methods. Do not hide non-`ENOENT` errors in a synchronous helper; log at the existing purge ownership layer and continue.
- Process multi-repo worktrees through ordered bounded all-settled mapping.
- Add purge-specific async persistence methods to `ColorStore`, `SessionStore`, deletion tombstones, and `TeamStore`. They must share each store’s write serialization so a normal mutation arriving while purge awaits I/O cannot be overwritten by an older purge snapshot. It is not safe to add a free-running async write beside existing synchronous writers.
- The smallest compatible store seam is a per-store queued async snapshot writer plus `removeAsync`/`purgeAsync`; ordinary APIs may remain unchanged outside this goal, but when an async purge write is active their persistence must join/fold into that queue. `purgeOneSession` awaits the durable session row and tombstone writes before notifying listeners.
- Preserve the existing store backup/epoch stale-snapshot guard and tombstone idempotency when translating those operations to promises. Do not weaken crash-recovery protections to gain responsiveness.
- Await purge listeners sequentially with per-listener logging. Broadcast remains before artifact deletion because the server listener currently performs those actions in that order.

Make `purgeExpiredArchives` itself single-flight so manual and scheduled callers join the active run. Keep per-session processing sequential for deterministic logs/store transitions. `shutdown` clears the interval and awaits the active purge before closing contexts. Starting the schedule twice must not create two timers.

`purgeArchivedSession` retains its boolean/API behavior and has no seven-day gate. The team-lead refusal remains a no-delete success at the current API boundary unless a separate API change is designed later.

## 7. Orphan transcript scan and preservation gate

### 7.1 Scanner call graph

Production startup already uses the bounded async scanner:

```text
SessionManager.restoreSessions
  -> scanOrphanedTranscriptsAsync
     src/server/agent/orphan-cleanup.ts
```

It shares one dynamic queue across directory reads and candidate stats, defaults to concurrency eight, counts all qualifying files, caps returned paths at 50 and warning lines at 20, skips tracked/old/non-JSONL files, and isolates directory/file errors.

Two synchronous legacy twins are production-unreferenced:

- `src/server/agent/orphan-cleanup.ts::scanOrphanedTranscripts` (called only by `tests2/core/session-manager-orphan-keep.test.ts`);
- `src/server/agent/session-store.ts::SessionStore.scanOrphanedTranscripts` (called only by tests, including a sync/async parity assertion in `tests2/integration/session-store-real-fs.test.ts`).

Delete the `orphan-cleanup.ts` synchronous scanner required by the goal. The clean zero-twin end state is also to remove the production-unreferenced `SessionStore` scanner and port its semantic tests to `scanOrphanedTranscriptsAsync`; this is orphan-cleanup scope, not a general SessionStore migration.

### 7.2 Preservation gate call graph

The production gate is `src/server/agent/orphan-cleanup.ts::shouldKeepDespiteOrphan`, using `existsSync(worktreePath)` and `statSync(agentSessionFile)`. It is called at five archive decisions, all already inside async methods:

1. `SessionManager.recoverSandboxSessions` after sandbox worktree recovery fails;
2. `SessionManager.restoreOneSession` when no transcript path can be recovered;
3. `restoreOneSession` when a sandbox transcript path is missing;
4. `SessionManager.restoreSession` when a sandbox worktree cannot be recovered;
5. `SessionManager.terminateOrphanedSessions` before maintenance archives an orphan.

Convert it to an async promise-only gate and await it at every site. Preserve the exact AND decision: worktree path exists **and** transcript stat succeeds **and** `Date.now() - mtimeMs < 24h`. Missing paths and all I/O errors return false. Keep the short circuit so a missing worktree does not stat a transcript. Container-internal sandbox paths continue to fail the host existence check naturally.

`src/server/agent/session-store.ts` also exports a second sync predicate of the same name, but no production code calls it; only `tests2/core/session-store-orphan-cleanup.test.ts` does. Remove/consolidate this test-only duplicate so one async predicate owns the safety policy and accepts an injected promise filesystem/clock for deterministic boundary tests.

## 8. Existing coverage and gaps

### 8.1 Preview

Existing coverage:

- `tests2/core/preview-artifacts.test.ts`: exact bytes/metadata, same-hash dedupe, source-independent restore, missing/wrong-session/corrupt restore non-mutation, idempotent removal, basic orphan sweep.
- `tests2/integration/preview-mount-route.test.ts`: HTML/file/manifest mounting, artifact ID round-trip and restore, current mount hash, path/auth/content behavior.
- `tests2/core/preview-mount.test.ts`: mount validation, asset/glob/symlink behavior, swap safety, and idempotent mount removal.
- `tests2/browser/journeys/misc.journey.spec.ts` and existing preview browser fixtures cover artifact UI entry and restore/reload behavior.

Missing acceptance coverage:

- wide/deep artifact stores and traversal ceiling;
- event-loop progress while lookup/hash/copy/delete is deferred;
- several candidates in a controlled enumeration order;
- invalid session/artifact metadata, wrong hash, extra/missing files and missing entry as independent skip cases;
- exact first valid reuse selection when multiple candidates match;
- stable hash parity for nested/binary/empty files and sorted record file names;
- per-artifact sweep failure isolation and failed-delete exclusion from `removed`;
- SSE bootstrap/live ordering after awaits;
- awaited purge-listener completion and listener error logging.

### 8.2 Worktrees

Existing coverage:

- `tests/worktree-sweeper.test.ts`: pool/active/orphan/repair classification, primary skip, current/legacy branch shapes, archived branch preservation, cwd/team/container ownership, real cleanup, no upward parent-repo sweep.
- `tests2/core/worktree-inventory.test.ts`: live/archived/pool/container/delegate/multi-repo guards, nested repo root, configured worktree root, legacy adapters.
- `tests2/integration/maintenance-api.test.ts` and `tests2/integration/helpers/maintenance-api-archived-*.test.ts`: route shapes, validation, selectors, safe/all cleanup and shared-live guards.
- `tests/worktree-pool.test.ts` and related pool suites: reclaim, incomplete/mixed multi-repo rejection, duplicate prevention, abandoned-pool reuse, fill/setup, claim behavior, and drain quiescence.
- `tests2/core/shared-worktree-guard-repro.test.ts`, `tests2/core/headquarters-no-worktree-runtime.test.ts`, `tests/system-project-pool-leak.test.ts`, and existing pool E2E specs pin shared ownership, Headquarters/system exclusion, restart reclaim, and pool behavior.

Missing acceptance coverage:

- deferred filesystem proof that sweep, pool reclaim/init, inventory scan, and cleanup yield the event loop;
- maximum active filesystem/delete operations;
- async constructor/initialization proof that no `execFileSync` is requested;
- boot-background shutdown barrier;
- injected runner propagation through repair and cleanup;
- deterministic inventory/result ordering under out-of-order completions.

### 8.3 Plan mutations, purge, and orphan cleanup

Existing coverage:

- `tests2/core/plan-mutation-store.test.ts`: CRUD, replacement/order isolation, expiry, idempotency, persistence. Timers are disabled in these tests.
- `tests2/integration/maintenance-api.test.ts`: expired-archive endpoint shapes and newly archived/not-yet-expired behavior.
- `tests2/core/shared-worktree-guard-repro.test.ts` and `session-recovery-agent-dir.test.ts`: purge shared-worktree protection and no deletion outside trusted transcript roots.
- prompt-section integration/browser coverage pins survival through archive.
- `tests2/core/orphan-cleanup-async-walk.test.ts`: nested semantics, missing root, caps, per-item failure isolation, global scan concurrency, wide-tree single-worker behavior.
- `tests2/core/session-manager-orphan-keep.test.ts` and `session-store-orphan-cleanup.test.ts`: current sync gate decision matrix and legacy scanner semantics.

Missing acceptance coverage:

- deferred prune event-loop progress, timer single-flight, stop barrier, and per-goal write serialization;
- deferred archive stats/purge progress, purge single-flight and shutdown barrier;
- seven-day boundary and missing-stat byte/count behavior in direct deterministic unit tests;
- store/tombstone durability after async purge;
- listener completion/error ownership;
- async gate behavior and wiring at every archive decision.

## 9. New test and static-guard plan

All new tests belong in `tests2/` and must be registered in `tests2/tests-map.json`.

### 9.1 TypeScript-AST static guard

Add `tests2/core/async-background-cleanup-static.test.ts` as a v2-native unit entry. Build a TypeScript `Program`/`TypeChecker`, seed the production roots below, and follow resolved local/imported function and method declarations. Report the root-to-violation trace with `file:line`.

Roots:

- every exported operation in `src/server/preview/artifacts.ts`, especially `persistPreviewArtifact`, `restorePreviewArtifact`, `removeArtifacts`, `sweepOrphanArtifacts`, and `findPreviewArtifactByHash`;
- async preview mount hash/remove/snapshot helpers and extracted server route/bootstrap/purge-listener helpers;
- `sweepOrphanedWorktrees`;
- `WorktreePool` async initialize, orphan reclaim, fill, stop/drain paths;
- `WorktreeInventoryService.scan` and `cleanup` plus legacy adapters;
- `cleanupWorktree` and pool-reached `createWorktree`/`createWorktreeSet` seams;
- `PlanMutationStore.pruneExpired` and its timer callback/read/write helpers;
- `SessionManager.getExpiredArchiveStats`, `purgeArchivedSession`, `purgeExpiredArchives`, `purgeOneSession`, schedule/stop/shutdown barrier, and extracted async termination notification;
- async orphan preservation gate and async transcript scanner.

Reject reachable calls to:

- every synchronous `node:fs` API, whether default, namespace, named, aliased, or destructured;
- sync methods called through injected filesystems (`this.fs`, `mountFs`, `fsa`, `fsImpl`, or another interface), not merely direct `node:fs` imports;
- `execSync`, `execFileSync`, `spawnSync`, `CommandRunner.execFileSync`, or an alias/wrapper resolving to them;
- `Atomics.wait`;
- a local wrapper whose body reaches any rejected call.

Do not scan all of `server.ts::handleApiRoute` as one root, which would pull unrelated request handling into this goal. Extract/name the scoped route blocks or seed exact AST callbacks. The baseline for the rooted call graph is zero; unrelated server findings are intentionally not grandfathered into this test.

### 9.2 Deterministic unit tests

Use deferred promise filesystem/command-runner fakes. Start an operation, queue an unrelated microtask/`setImmediate`, assert it runs while I/O is held, then release the I/O and assert the result. Do not use wall-clock performance thresholds.

Add focused tests for:

- preview lookup, hash, copy, remove, sweep, corruption skipping, order, ceiling, and hash parity;
- worktree sweeper, pool initialization/reclaim, inventory, and bounded cleanup;
- PlanMutationStore two-tick coalescing and awaited stop;
- archive stats/purge two-tick/manual coalescing and awaited shutdown;
- purge listener resolving/rejecting only after deferred artifact deletion;
- async orphan gate truth table and all call-site awaits.

### 9.3 Integration/E2E ordering

Add an in-process integration test with injectable/deferred preview I/O:

1. create a valid session/mount and a large multi-candidate artifact tree;
2. start a preview bootstrap/reuse scan and hold a deep metadata/hash read;
3. concurrently issue `GET /api/health` and `POST /api/sessions`;
4. assert both requests complete before releasing the artifact traversal;
5. release and assert exact artifact selection.

Repeat the ordering assertion for purge-triggered mount/artifact deletion: hold deletion, prove health/session creation complete, then release and assert the purge response waits for cleanup. Use existing browser preview journeys to verify POST, SSE, historical artifact switching, reload restoration, and cleanup still work; add a browser-v2 journey only if those existing journeys cannot exercise the new awaited route seams.

## 10. Explicitly out of scope

The following synchronous-I/O areas remain for later audit unless a shared helper signature needs a minimal adaptation:

- general gateway/store/config construction and loading;
- unrelated `SessionStore`, `GoalStore`, `ColorStore`, and other request-path persistence outside the purge-specific async seams;
- preview content serving (`handlePreviewRequest`, `resolveAssetPath`, HTML rewrite/read) and ordinary manifest/source validation except the async snapshot/hash helpers shared with artifact scanning;
- general session restore/recovery filesystem work not reached by the orphan gate or purge;
- harness/watchdog, auth discovery, extension-host, Git Bash discovery, and Docker argument setup;
- general Git lifecycle, merge, status, and recovery operations outside worktree pool/sweeper/inventory/cleanup;
- already-async cost recovery and gate-diagnostics cleanup;
- new cleanup policies, blanket Git pruning, or automatic deletion of maintenance-only candidates.

No excluded finding is declared safe; it is simply not part of this focused first slice.

## 11. Preserved invariants checklist

Implementation and review should explicitly confirm:

- preview hashes and sorted file lists are byte-for-byte stable;
- first valid artifact candidate selection is unchanged;
- corrupt artifacts are skipped, never reused or auto-deleted by lookup;
- restore validation precedes mutation and rollback remains available;
- all cleanup APIs remain idempotent and response shapes/counts remain unchanged;
- SSE bootstrap cannot overwrite a newer live event;
- no symlink traversal is introduced;
- pool and sweeper branch sets remain disjoint;
- primary, owned/shared, delegate, team/staff, Headquarters/system, and container-internal worktrees remain protected;
- archived branch preservation and branch-delete rechecks remain intact;
- cleanup stays targeted; there is no blanket `git worktree prune`;
- plan prune and archive purge are single-flight and stopped runs are awaitable;
- seven-day retention and team-lead purge refusal are unchanged;
- exact persisted transcript paths outside trusted roots remain undeleted;
- purge completion owns preview cleanup completion/errors;
- one item’s failure does not abort its siblings;
- no long traversal loop runs without an async filesystem/chunk-read yield.
