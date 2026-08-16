# Split archived SessionStore writes

## Decision

`SessionStore` keeps its one eager, in-memory `Map<string, PersistedSession>` and its public read API unchanged. It will split **persistence only** into live and archived JSON tiers so routine live-session activity serializes only live records.

There is no UI, REST, WebSocket, search, pagination, startup, or loading-state change. `getArchived()`, `listArchivedSessionsPaginated()`, search integration, orphan cleanup, and all callers still read the same fully populated map immediately after construction. Lazy archived loading is explicitly rejected: it trades the measured recurring write stall for a first-access delay and a new loading state.

SQLite is also explicitly out of scope. The existing SQLite migration pattern is useful precedent, but replacing the safety-critical JSON writer would widen the blast radius and discard the proven epoch/fingerprint/fence path. Hard-link backup rotation and structural-vs-activity generation splitting are separate follow-up work; neither lands here.

## Files and on-disk contract

Only `src/server/agent/session-store.ts` changes in production. Tests extend the existing session-store suites; no new parallel persistence abstraction is introduced.

```text
<stateDir>/
  sessions.json                              live v3 primary
  sessions.json.bak.1 ... sessions.json.bak.5
  sessions.archived.json                     archived v3 primary
  sessions.archived.json.bak.1 ... .bak.5
  sessions.json.split-transition             short-lived pair-publication intent
  sessions.json.pre-archived-split[.N]       retained exact v1/v2 migration source
```

The archive filename is deliberately `sessions.archived.json`, not a directory or a lazy index. Both primary files retain the compact envelope and five-generation backup chain:

```ts
// sessions.json
{ version: 3, epoch: number, sessions: PersistedSession[] } // every row has archived !== true

// sessions.archived.json
{ version: 3, epoch: number, sessions: PersistedSession[] } // every row has archived === true
```

`epoch` is a tier-local monotonic counter. The numbers in the two files are never compared and must not be derived from one shared counter. A v3 reader accepts the current legacy bare-array (v1) and v2 envelope only from the **live** candidate chain as a migration source. The archived candidate chain accepts v3 only. New writers always emit compact v3 JSON.

`split-transition` is not a third record tier and is normally absent. It is a small atomic intent needed because two independent `rename`s cannot be made cross-file atomic. Its payload contains a version, every membership-changing id in the batch, and the final complete row (or a hard-delete marker) plus final target tier. It is written before either tier is published and deleted only after every intended tier write succeeds. It gives restart a deterministic answer for a duplicate or missing row after a crash between the two renames; it does not supply an epoch or replace either tier as an authority.

## Store state and helpers

`SessionStore` continues to own `sessions`, the debounce timer, global externally visible `generation`, index notifications, deletion tombstones, and the async drain. Replace the single-file persistence fields with a per-tier state object, for example:

```ts
type SessionTier = "live" | "archived";
type TierPersistenceState = {
  file: string;
  loadedEpoch: number;
  writtenEpoch: number;
  diskFingerprint: DiskFingerprint | null;
  staleGuardTripped: boolean;
  dirtyGeneration: number;
  publishedGeneration: number;
};
```

The store owns `liveTier`, `archivedTier`, `archivedDirty` (or equivalent tier dirty generations), pending pair-transition intent, and a global published-barrier watermark. Keep the existing public `getLoadedEpoch()`, `getWrittenEpoch()`, and `isStaleGuardTripped()` as live-tier compatibility accessors; add tier-specific test-visible accessors rather than silently changing their meaning. The existing aggregate `PersistenceMetrics` remains available; add optional live/archive byte fields if needed, while retaining `bytes` as the bytes serialized by the completed drain and `durationMs` as its elapsed wall time.

Implementation helpers should have narrow responsibilities:

- `tierFile(tier)`, `tierBakPath(tier, n)`, `tierTmpPath(tier)`: derive every path from the tier rather than string-splicing at call sites.
- `readTierCandidates(tier)`: read primary then `.bak.1` through `.bak.5`, parse v3, and return rows, loaded epoch, source path, and fingerprint. The live version also recognizes v1/v2 migration input.
- `loadAndMergeTiers()`: eagerly read both files, apply pending transition intent, normalize legacy session fields once, and seed the one map.
- `markTierMutation(previous, next, generation)`: decide which tier payload changed. It is called by every mutator after capturing the row's old membership.
- `saveTierUnlockedAsync(tier, rows, serializedGeneration)`: preserve the existing fingerprint/stale guard, backup rotation, temp write, optional fsync, and rename for exactly that tier.
- `withTierWriteFences(tiers, write)`: acquire `SessionStore.fileWriteTails` for all affected absolute file paths in sorted order, then release in reverse. This prevents deadlock while preserving an independent fence for each file.
- `writeTransitionIntent`, `readTransitionIntent`, and `clearTransitionIntent`: atomically publish/recover/clear only the membership-pair intent.
- `saveDirtyTiersUnlockedAsync()`: snapshot and serialize live rows only when live is dirty and archive rows only when archived is dirty; it coordinates intent only when a row changes tiers.

Do not fork a second `Map`, do not cache archives outside the map, and do not change array iteration order within a tier.

## Independent safety semantics

Each tier independently retains all current persistence protections:

1. **Epoch and stale latch.** Before that tier's first process write, or whenever its fingerprint differs/is unavailable, re-read that tier's on-disk epoch. If it is newer than that tier's `loadedEpoch` before this process has written the tier, latch and refuse only that tier. A rolled-back or newer archived file cannot trip, clear, or bypass the live latch, and vice versa.
2. **Fingerprint.** Keep the current `(size, mtimeMs, ctimeMs)` equality rule per tier. Missing `ctimeMs`, a stat error, a changed file, or a missing file disables only that tier's fast path and forces an epoch read. Never treat `size + mtime` alone as identity.
3. **Fence.** `SessionStore.fileWriteTails` remains static, but keys are resolved file paths. A live write fences `sessions.json`; an archive write fences `sessions.archived.json`; pair writes fence both. Temporary names are tier-specific.
4. **Backup and atomic publication.** Each `saveTierUnlockedAsync` rotates only that tier's own backups oldest-first, writes `<tier>.tmp`, attempts fsync when the richer injected filesystem supports it, and atomically renames. The archive tier is never copied or rewritten during a live-only save.

A stale failure on a live-only update leaves the archived tier untouched. A stale failure on an archive/unarchive pair rejects that durability barrier and leaves the transition intent in place for deterministic restart recovery; it must not falsely mark either file's generation published.

## Load, merge, and recovery

At boot the store loads both tiers synchronously before any caller can observe it:

1. Read live candidates in `sessions.json`, `.bak.1` … `.bak.5` order. The first parseable v3 envelope wins; a v1/v2 candidate is retained as the legacy migration source instead.
2. Read archive candidates in `sessions.archived.json`, `.bak.1` … `.bak.5` order. The first parseable v3 envelope wins. A missing archive file is empty only for a new empty store or legacy migration; a corrupt primary still tries its archive backups exactly like the live chain.
3. Read a pending transition intent, if any. It wins for its listed ids: its final row is inserted in the indicated tier or its delete marker removes the id. The next successful drain repairs both tier files and clears the intent.
4. Merge loaded rows into the existing single map, then perform the established legacy field/ledger/verifier normalization across that complete map.

Outside a pending transition, the duplicate-id policy is explicit: the live candidate wins, a diagnostic names the id and both source paths, and the next dirty publication canonicalizes the record into the tier selected by its `archived` flag. This conservative policy prevents an older archive backup from overriding the current live source. Rows placed in the wrong v3 file are accepted for recovery, normalized by their own `archived` boolean, logged, and repaired on the next write. A pending transition overrides this default because it records the intended final membership and is the only way to disambiguate a crash during archive vs unarchive.

The recovery order remains primary then newest-to-oldest backups **independently for each file**. Mixing two independently recovered tier snapshots is preferable to silently dropping a parseable tier; it does not compare epochs across tiers. The retained `.pre-archived-split` snapshot is migration evidence, not a normal v3 fallback after a completed split.

## Mutations, dirtiness, and durability barriers

Every mutation still increments the existing global `generation` exactly once. This goal does not split API polling generations into structural and activity generations.

Before mutating a record, capture `previousArchived`; after mutation inspect `nextArchived`. Mark tiers as follows:

| Operation | Live dirty | Archive dirty | Pair intent |
|---|---:|---:|---:|
| `put` new live / overwrite live | yes | no | no |
| `put` new archived / overwrite archived | no | yes | no |
| `put` changes existing membership | yes | yes | yes |
| live `update`, draft, tag restore, or activity update | yes | no | no |
| archived `update`, draft, or tag restore | no | yes | no |
| `update({ archived: true })` / `archive` / `archiveAsync` | yes | yes | yes |
| `update({ archived: false })` (unarchive) | yes | yes | yes |
| `remove` / `purge` of live row | yes | no | delete only in live tier |
| `remove` / `purge` of archived row | no | yes | delete only in archive tier |

`update({ archived: false })` is an unarchive even if legacy `archivedAt` remains present; membership is determined solely by `archived === true`, matching current reads. `put` must compare an existing row's membership rather than trusting only the incoming payload. Missing-id update/archive/purge remains a no-op and marks nothing dirty. `remove` and `purge` retain their existing `sessions.json` deletion-tombstone namespace; `purgeAsync` writes its tombstone only after the affected tier deletion has crossed its durability barrier.

A membership batch first atomically writes the transition intent, then publishes both affected tier snapshots under both fences, then clears the intent. The row's final archive state is present in the archive file before its live copy is removed, and the reverse movement is likewise protected by the intent; a crash cannot turn a two-file partial result into an ambiguous user-visible choice on restart.

The async drain may serialize one or both tiers. A live activity burst snapshots only `getLive()` rows and avoids both archived `JSON.stringify` and archive backup rotation. An archived mutation serializes only `getArchived()` rows unless it crosses membership. Snapshot generation accounting remains a barrier: a generation is considered published only when every tier dirtied by mutations through that generation has completed its atomic rename. A mutation folded into a snapshot already containing it advances the appropriate tier watermark without causing a duplicate write; a mutation arriving after serialization schedules a trailing drain. `flushAsync`, `archiveAsync`, and `purgeAsync` retain their current failure-sequence behavior and reject if their required tier generation did not publish.

Metrics describe the actual drain, not full historical state: a live-only save reports live serialized bytes and zero archive bytes; an archive-only save reports the converse; a pair sums both. This makes the expected roughly 40x hot-path reduction observable without changing the public session response generation.

## v2 migration and crash behavior

A loaded v2 envelope is the authoritative complete snapshot for migration. The migration runs before normal writes and is idempotent:

1. Parse and normalize every legacy row in memory, partitioning by `archived === true` without dropping records.
2. Before replacing `sessions.json`, retain the exact original bytes at `sessions.json.pre-archived-split`. Create it without overwriting an existing retained source; an `EEXIST` collision uses `.1`, `.2`, and so on. This is evidence and recovery input, not a destructive rename.
3. Atomically write an empty-or-populated v3 `sessions.archived.json` first, with its own epoch starting from zero/its loaded archive epoch and its own backup chain.
4. Atomically write v3 `sessions.json` containing only live rows, with its own epoch derived from the v2 source's live-tier loaded epoch. Its regular backup rotation retains the former v2 primary before replacement.
5. Only after both v3 primaries are durable is migration complete. Leave the retained `.pre-archived-split` snapshot in place; it is the explicitly recoverable original, never silently deleted.

If the process dies or an archive write fails before step 4, the v2 live primary remains parseable and a restart repeats the partition safely. If archive succeeds but live fails, the v2 source still wins as the migration input; the archive output is overwritten idempotently from that same complete v2 source. If live succeeds, archive must already have succeeded, so a v3 live primary never represents a completed split without an archive-tier publication. If an existing retained snapshot collides, it is preserved; migration never overwrites forensic evidence.

Legacy bare arrays follow the same retention-and-split path. A second construction after a completed v3 split reads the two v3 tiers, does not create another retained source, and does not duplicate rows.

## Test plan

Extend, do not replace, these suites:

- `tests2/core/session-store.test.ts`
- `tests2/core/session-store-atomic-write.test.ts`
- `tests2/core/session-store-stale-load-guard.test.ts`
- `tests2/core/session-store-orphan-cleanup.test.ts`
- `tests2/integration/session-store-real-fs.test.ts`

Add the following coverage, using injected memfs for deterministic writer/fingerprint instrumentation and real FS where atomic rename/mtime fidelity matters:

1. **Live-size isolation.** Seed N live records plus M archived records, flush, and assert v3 `sessions.json` contains exactly N and its serialized byte size is unchanged when M grows. Assert `sessions.archived.json` contains M.
2. **Live mutation isolation.** After both tiers are durable, mutate a live record and flush. Assert archive mtime/write counter and archive epoch are unchanged; assert only the live epoch advances.
3. **Membership moves.** Archive a live record and assert both tier files publish the move; unarchive through `update({ archived: false })` and assert it returns to live after reload. Include `put` replacement across tiers, archived `put` overwrite, hard `remove`/`purge`, missing-id no-ops, and the existing tombstone guarantees.
4. **Eager read parity.** Build equivalent pre-split/v2 data, split/reload it, and compare `getArchived()` plus every `listArchivedSessionsPaginated(limit, after)` result, totals, cursors, ordering, and live reads. This proves archive data remains eager and behaviorally identical.
5. **Migration.** Write a 1,234-record v2 `sessions.json` with live and archived rows. Construct/flush, assert every id and payload survives, v3 tiers partition exactly, the exact v2 original is retained under `.pre-archived-split`, and a second construction is idempotent. Inject failures after retained-source creation and after archive publication to prove the original v2 path remains loadable and no records are lost.
6. **Independent guard and recovery.** Independently externally roll back/advance/corrupt each tier and prove its own backup order, fingerprint revalidation, stale latch, and fence behavior. A newer or rolled-back archive file must not trip/bypass live protection, and the converse must hold. Add a crash-between-pair-renames case showing `split-transition` resolves duplicate/missing ids to the intended archive/unarchive state before repair.

All existing regression suites remain green with their current behavioral coverage; legacy v1/v2 fixtures remain loadable, while the new split-specific assertions own v3 envelope inspection. Run `npm run check`, `npm run test:unit`, and `npm run test:e2e` after implementation.

## Explicit non-goals

- No lazy archive load, archive spinner, first-access fetch, or changed UX.
- No SQLite conversion or new database dependency.
- No hard-link replacement for `copyFile` backup rotation.
- No structural/activity generation split for `/api/sessions?since=`.
- No archive search, pagination, orphan-cleanup, or API behavior rewrite.
