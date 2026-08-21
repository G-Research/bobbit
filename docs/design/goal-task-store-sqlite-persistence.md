# Goal and task store SQLite persistence

## Context and scope

`GoalStore` and `TaskStore` persist each project's goal definitions and task state. Their former production adapters rewrote complete JSON arrays after every published mutation. As retained goal and task history grew, a one-record change therefore performed work proportional to the complete store.

Production persistence now uses SQLite so a published batch updates only its dirty records while preserving the existing store contracts:

- the public `GoalStore` and `TaskStore` APIs are unchanged;
- each store's in-memory `Map` remains the synchronous read model;
- the existing `id` remains the row identity;
- each row contains one complete, schema-flexible JSON payload; and
- generation counters, goal observers, deletion behavior, flush barriers, and close semantics remain store-owned.

Every project has separate `goals.sqlite` and `tasks.sqlite` databases. Keeping the databases separate preserves the existing ownership and lifecycle boundaries: a goal write cannot accidentally enlist a task transaction, either store can validate and close independently, and project removal can release each native handle explicitly. This migration does not introduce a shared metadata database, cross-store transaction, repository framework, or second persistence service.

SQLite is selected automatically when a store uses the real filesystem. There is no production feature flag or dual-write mode because either would create two possible authorities and make recovery depend on deployment configuration. Injected filesystems, including memfs unit fixtures, retain the JSON adapter because native SQLite cannot operate on those filesystems and the existing fixture contract is intentionally lightweight.

## Ownership and backend selection

`ProjectContext` owns one instance of each store for its project and therefore owns both native connections. The backend is selected at construction:

| Construction | Backend | Purpose |
|---|---|---|
| Real filesystem, including normal `ProjectContext` startup | SQLite | Production authority with transactional dirty-record publication. |
| Injected non-real `FsLike`, including memfs | JSON | Deterministic unit fixtures using the historical array format. |
| Explicit `persistence` option | Requested adapter | Test and integration seam only; not an operator migration switch. |

The databases live under the same per-project state directory as the stores they replace:

```text
<project-root>/.bobbit/state/
  goals.sqlite
  tasks.sqlite
```

Headquarters uses its registered project's aliased state directory. The hidden system project and every normal project still have independent store instances and files.

## Schema and authority metadata

Both databases use schema version 1 and store a complete JSON payload without normalizing mutable domain fields into relational columns.

`goals.sqlite` contains:

```sql
CREATE TABLE goal_records (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
) STRICT;

CREATE TABLE goal_store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;
```

`tasks.sqlite` has the equivalent `task_records` and `task_store_meta` tables. The primary key supports current identity lookups; no relational foreign key couples tasks to goals.

Each metadata table may contain:

- `migration_complete`, which makes that SQLite database authoritative;
- `pre_migration_recovery_complete`, which prevents replay of a consumed recovery source;
- `pending_retirement:<store>.json`; and
- `pending_retirement:<store>.json.pre-migration`.

Retirement entries are durable intent, not transient process state. They bridge the boundary between the committed import transaction and the later filesystem operation that retains the superseded source.

Connections use SQLite's delete journal, full synchronous durability, and a five-second busy timeout. Reads are served from the in-memory map, so a single connection per store fits the ownership model; WAL would not improve those reads. The pinned `better-sqlite3` native dependency is the only database driver.

## Payload validation and compatibility

### Startup validation

Before publication into the read model, every eligible JSON source and every authoritative SQLite row is parsed and validated. Validation checks:

- the record is an object with a non-empty `id`;
- required known fields and discriminators have supported shapes;
- numeric fields are finite;
- nested workflow, role, dependency, and git-handoff structures have valid known fields;
- duplicate identities do not occur within one source; and
- a SQLite row's `id` exactly matches its payload's `id`.

Unknown extension fields remain in the complete payload. Validation protects known runtime contracts without turning the flexible payload into a closed relational schema.

A goal's `workflowId` and `workflow` may be explicitly `null`. This is compatibility behavior used when a workflow is cleared, not corruption. Other malformed non-null workflow values still fail validation.

### Historical canonicalization

Migration and reload retain the stores' existing field repairs:

- goals translate historical team and gate-skip names, default missing setup status, remove obsolete worktree-setup fields, normalize older workflow dependency shapes, and drop malformed `metadata` or `inlineRoles` containers;
- tasks translate historical artifact linkage and commit fields to the current gate and handoff names.

Canonicalization happens on parsed objects. Eligible legacy sources are preserved byte-for-byte in retired backups, while imported rows contain their validated canonical representation. Unknown fields are preserved.

At the asynchronous publication boundary, each dirty runtime value is serialized and the exact serialized bytes are parsed and validated against the dirty key before the transaction commits. This prevents a custom `toJSON` implementation or a mutated `id` from publishing bytes that would corrupt the next restart. Goal publication also verifies that applying reload canonicalization to those bytes remains valid. Validation uses temporary parsed objects and does not rewrite the live in-memory value.

### JSON and memfs adapter

The JSON adapter keeps the historical whole-array shape, tolerant fixture loading, canonicalization, coalesced writer, and public API. It does not create either SQLite file. General unit suites should continue to inject memfs rather than putting native database setup on their critical path.

## Mutation and publication flow

A mutation updates the in-memory map, marks only affected IDs dirty, and schedules a 500 ms drain. Bursts coalesce into one `BEGIN IMMEDIATE` transaction that upserts or deletes every dirty snapshot in the batch.

If serialization, a statement, or commit fails:

- SQLite rolls back the complete batch;
- an awaiting `flush()` or strict goal publication rejects;
- every affected ID returns to the dirty set for a later retry; and
- authoritative rows remain at the previously committed state.

`GoalStore.updateStrict()` additionally compensates its in-memory change and generation increment when publication fails, and it does not notify the index observer. Ordinary mutations retain their existing synchronous map and observer semantics; a failed later flush reports that durability failure rather than pretending publication succeeded.

`getPersistenceMetrics()` exposes only the most recent batch's serialized payload byte count and duration. The metric is bounded process memory, not a durable history. Delete-only batches report no serialized payload bytes. It measures affected payload bytes rather than total database file churn.

## Deletion tombstones and ordering

Goal hard deletion records an external tombstone under:

```text
<stateDir>/.deletion-tombstones.json
```

The namespace remains `goals.json` for compatibility with the earlier Headquarters and per-project migration machinery. `GoalStore.remove()` updates the map, queues the SQLite row deletion, and records that tombstone synchronously before the debounced database publication normally runs. Tombstone persistence is best-effort and intentionally separate from the SQLite transaction: its purpose is to stop older recovery backups from resurrecting intent that has already been expressed as a hard deletion.

This ordering can temporarily produce a tombstone while the old SQLite row is still authoritative, including after an injected delete-statement failure. That is safe:

- authoritative SQLite rows and live `goals.json` records win over recovery data;
- the dirty SQLite deletion remains queued after rollback; and
- only recovery-only records are filtered by tombstones.

`TaskStore` does not create task tombstones. Tasks are lifecycle-owned by goals, so task recovery consults the `goals.json` tombstone namespace and skips recovery-only tasks whose `goalId` was hard-deleted. A live task source or an existing authoritative task row still wins an identity conflict. This prevents a retired task backup from recreating work for a deleted goal without inventing an independent task-deletion authority.

Do not move tombstones into either SQLite database or reorder startup to open the task database before goal deletion intent is available. The external file is shared migration evidence used before and during store-owned recovery.

## Startup and authority state machine

Each store establishes one authority synchronously before `ProjectContext` becomes available:

1. Open the database and reject a schema newer than the supported version.
2. Create the version 1 schema when the database is new.
3. If `migration_complete` is absent, require the record table to be empty and run first migration.
4. Validate every authoritative SQLite row.
5. Complete any already-committed source retirement.
6. If eligible, recover `<store>.json.pre-migration` into authoritative SQLite.
7. Re-read validated rows into the in-memory map.

The generic `recoverPreMigrationData()` pass excludes goals, tasks, and gates. Each native store is the sole owner of its live JSON and `.pre-migration` sources; otherwise generic recovery could recreate a JSON file that authoritative SQLite intentionally ignores.

### First migration

When the migration marker is absent, the store:

1. Refuses to proceed if the SQLite record table already contains unmarked rows.
2. Reads and fully validates every present live and `.pre-migration` source before starting an import transaction.
3. Merges by `id`: the live JSON record wins a conflict, while eligible recovery-only records are retained.
4. Filters recovery-only goal records by goal tombstone, and recovery-only task records by their goal's tombstone.
5. Inserts the complete merged set and verifies count, identities, and exact canonical payloads inside one transaction.
6. Commits `migration_complete`, an applicable recovery-complete marker, and applicable retirement intents in that transaction.
7. Retires sources only after commit.

A new empty project follows the same path and gets a marked, empty authoritative database. Failed validation leaves every source byte untouched. A failed import rolls back records, markers, and retirement intent; the newly created empty schema file may remain.

### Recovery into authoritative SQLite

If the migration marker already exists, authoritative rows are validated before any source retirement or recovery. An eligible `.pre-migration` source is completely validated and merged in one transaction:

- the existing SQLite row wins an identity conflict;
- eligible recovery-only rows are inserted;
- the resulting count, identities, and payloads are verified before commit; and
- the recovery-complete marker and retirement intent commit with the merge.

Recovery is additive. It never overwrites a current row with an older snapshot. Once `pre_migration_recovery_complete` is present, a newly reappearing `.pre-migration` file is ignored rather than replayed.

### Mixed-state behavior

| Observed state | Startup behavior |
|---|---|
| No migration marker, no rows, one or both JSON sources present | Validate all present sources, import the merged set, mark SQLite authoritative, then retire the sources. |
| No migration marker and no sources | Mark an empty SQLite database authoritative. |
| No migration marker but SQLite rows exist | Fail startup; ambiguous unmarked rows are never adopted or overwritten. |
| Migration marker present and retirement intent remains | Validate SQLite, then retry retirement only; changed source bytes are not re-imported. |
| Migration marker present and an unmarked live JSON file appears without retirement intent | Ignore it; SQLite remains authoritative. |
| Migration marker present and an unrecovered `.pre-migration` source appears | Validate it, transactionally add eligible recovery-only identities, mark recovery complete, then retire it. |
| Recovery marker present and `.pre-migration` reappears without retirement intent | Ignore it to prevent stale replay. |
| Unsupported schema, invalid marker or intent, corrupt payload, or row/payload identity mismatch | Fail construction and release the constructor-owned native handle. |

## Non-destructive source retirement

Committed sources move to retained, collision-safe names:

| Source | Preferred retained name |
|---|---|
| `goals.json` | `goals.json.sqlite-retired` |
| `tasks.json` | `tasks.json.sqlite-retired` |
| `goals.json.pre-migration` | `goals.json.pre-migration-recovered` |
| `tasks.json.pre-migration` | `tasks.json.pre-migration-recovered` |

Retirement creates a same-directory hard link at the candidate name and then unlinks the source name. An `EEXIST` collision advances to a numeric suffix such as `.sqlite-retired.1`; prior and concurrently created backups are never overwritten. Any other link failure stops startup without unlinking the source.

The metadata intent is cleared only after the source name is absent. If commit succeeds but link or unlink is interrupted, the authoritative rows and intent remain. On the next startup, the store validates SQLite and retries only retirement. Even if the source path was changed or replaced after the commit, those bytes are not imported again. A completed retirement whose intent was not yet cleared is also safe: startup sees the source is absent and clears the stale intent.

A retired backup is evidence, not a live rollback file. Restoring its legacy filename after migration does not make it authoritative.

## Lifecycle and Windows handle ownership

`GoalStore.close()` and `TaskStore.close()` are idempotent barriers. The first call synchronously fences new mutations, drains accepted work, and releases the connection. Concurrent callers receive the same promise. A final publication gets at most one immediate retry; if both attempts fail, every close caller receives the error and the native handle is still closed.

`ProjectContext` constructs non-native dependencies first, then opens `GoalStore`, `TaskStore`, and `GateStore` in a guarded tail. If a later constructor fails, it disposes every already-opened native store in reverse order. This prevents a partially built context from retaining database handles.

Normal `ProjectContext.close()` stops mutation sources, waits for gate reset recovery, and attempts to close all three native stores plus the session store even if a sibling close fails. Remaining durable resources are then drained or closed. Multiple errors are aggregated only after every cleanup attempt. `ProjectContextManager.closeAll()` and project removal likewise await close, remove the context from topology, and report failure afterward.

These guarantees matter on Windows, where an open native handle prevents state-directory rename or deletion. Operators and tests must await context or gateway shutdown before moving project state.

## Operational inspection and recovery precautions

Treat `goals.sqlite` or `tasks.sqlite` as authoritative whenever its metadata table contains `migration_complete=1`.

Before inspection or recovery:

1. Stop the gateway gracefully and wait for shutdown. This publishes accepted dirty records and releases native handles.
2. Copy the complete project state directory to an operator-owned location. Keep the SQLite files, tombstone file, live or recovery sources, and retired backups together.
3. Record file sizes and hashes before experimenting.
4. Inspect only the copy, opening SQLite read-only. Check `PRAGMA user_version`, `PRAGMA quick_check`, the metadata table, record count, and that every parsed payload `id` matches its row `id`.
5. Exercise startup, close, and reopen against another disposable copy before changing operational state.

Do not inspect a database by copying only its main file while the gateway is running. Do not edit rows, clear metadata, delete the database, rename a retired source back into place, or copy JSON over an authoritative database. There is no supported automatic rollback command.

For common failures:

- **Pending retirement failed:** preserve the source, any retained hard link, and metadata. Remove the external lock or permission problem, then restart so the store retries retirement without re-importing.
- **Eligible JSON validation failed:** preserve the rejected bytes. Correct or replace them only while stopped, and rehearse against a copy; no import transaction committed.
- **SQLite validation or schema failed:** preserve the complete state directory and escalate to deliberate offline recovery. Do not guess which backup should replace current state.

Actionable errors use `[goal-store]` or `[task-store]` prefixes and identify malformed source positions, duplicate IDs, schema or marker problems, payload identities, or publication failures.

## Test ownership

The test split keeps native setup focused:

- existing store and manager unit suites inject memfs and continue to assert the JSON fixture contract;
- focused real-filesystem tests for each store cover initialization, migration, canonical payload and identity preservation, dirty-only writes, transactional rollback and retry, tombstones, recovery, collision and interruption handling, corrupt authoritative rows, concurrent close, and handle release;
- lifecycle tests cover constructor cleanup and `ProjectContext`/`ProjectContextManager` close behavior; and
- the daily E2E upgrade journey boots a real gateway from legacy per-project JSON, verifies collision-safe retirement, mutates and deletes through supported APIs, gracefully restarts, and directly inspects authoritative rows after shutdown.

Packed-consumer qualification retains the existing npm rebuild invocation, but with `better-sqlite3` 13.0.3 packaging (`gypfile: false`, no install lifecycle, and bundled prebuilds) that step is effectively a harmless no-op. The meaningful check loads the bundled native binding and performs an in-memory create/write/read/close smoke. That check belongs in bundle qualification rather than the general unit lane.

## Benchmark and qualification evidence

### Representative copied-state benchmark

The benchmark ran on Windows 10.0.26200 x64 with Node 24.13.1, 24 logical CPUs, and local C: NTFS storage. It used owned temporary copies only: no store was opened against live state, source hashes and file metadata were unchanged before and after the benchmark, and the temporary directory was removed.

Each store used three migration samples, three reload samples, and 33 public `put()` plus `flush()` mutation samples after one warmup. Times below are medians; parenthesized migration and reload values are the complete three-sample sets.

| Store | Records | Source JSON | SQLite database | Migration | Reload | Mutation wall time | Store metric | Target payload |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Goals | 862 | 11,491,291 B | 12,226,560 B | 417.50 ms (417.50, 372.14, 437.78) | 126.31 ms (122.92, 126.31, 196.57) | 5.53 ms | 5.37 ms; 13,619 B median (13,618–13,619 B) | 13,599 B |
| Tasks | 6,049 | 15,329,158 B | 20,058,112 B | 898.07 ms (913.93, 894.23, 898.07) | 359.76 ms (385.17, 359.76, 321.90) | 4.37 ms | 4.27 ms; 1,959 B median (1,958–1,959 B) | 1,939 B |

For every sample, source count, sorted identities, direct SQLite count and identities, and post-reload state matched. This fixture required zero historical field transforms. The retired backups were byte-exact copies of their sources.

Evidence digests:

| Evidence | Goals | Tasks |
|---|---|---|
| Source JSON SHA-256 | `09e73ea6aa92a305aa4d3cbb6da3104e3ffcaa27892f64879dc7efbb207188df` | `b63c279b035dd7b98b7545966d690c595e89508c0a8c45fed039deb8e983cc6a` |
| Sorted-identity SHA-256 | `681fc5322f5ac3df92b5785c556e69c882dc94cff5a046fee326c05db1a0ba87` | `a4f186ee9603d6d71c0ce30cac34ef8c20e7940030ac6b7dbafde2f0f4e75bc9` |
| Per-ID payload-manifest SHA-256 | `f4f44038512d8d259cfaea321eb055c7666159c66919ee1966f53ca7dcb0a097` | `c2bf24d304981376a2c48b0a78ca05845517d715bf87c87e7dc7736063a2824a` |

The per-ID manifests exactly matched parsed source payloads to database payloads. These measurements demonstrate dirty-record publication for these copies; they do not predict other hardware, payload distributions, or filesystem conditions.

An independently running gateway appended one task to live state later during qualification. That occurred after the benchmark and was not a benchmark write; the benchmark's before/after source hash and metadata checks had already proved that its live inputs were unchanged.

### Ordered landing qualification

The required sequence passed on baseline `de0fde14221bdb4ef0074aec89710258085fe5f7` in the same Windows environment:

| Check | Result |
|---|---|
| `npm run check` | Passed in 68 s |
| `npm run build` | Passed in 24 s |
| `npm run test:unit` | Passed in 251 s; 1,073 files passed, 3 skipped; 9,918 tests passed, 20 skipped |
| `npm run test:browser` | Passed in 476 s; 718 passed, 8 skipped, 1 flaky retry; browser budget passed |
| `npm run test:e2e` | Passed in 427 s; groups A, B, C, and D passed; browser phases passed 52 + 90 with 12 skipped; fidelity Vitest passed 181 with 1 skipped |
| `npm run test:bundle` | Passed in 7 s; 2 files and 4 tests passed |
| Packed-consumer native smoke | Passed during a 98 s packed-consumer run: native rebuild and binding load, GoalStore/TaskStore durable write/read, and handle cleanup |

The check-through-bundle sequence took 1,253 seconds (20m53s). The gate-store qualification document records a historical single run of 1,027 seconds (17m07s: 40/18/202/381/379/7 seconds by phase). That older run is an uncontrolled historical observation, not a causal baseline: suite contents, machine load, caches, and other conditions were not controlled between runs.

After the packed-consumer native smoke passed, its separate mutable-registry audit exited 1 with two moderate and two high findings through upstream `@earendil-works/pi-coding-agent`:

- `brace-expansion`: `GHSA-mh99-v99m-4gvg`, `GHSA-rgw5-rvv9-x895`;
- `undici`: `GHSA-8xcm-r25x-g524`, `GHSA-4cwx-7wf7-3272`, `GHSA-m8rv-5g2x-5cg5`, `GHSA-jr45-8vmc-qm54`, `GHSA-v3r7-h72x-cjcm`.

Those registry findings are reported separately from the passing native SQLite smoke. They are upstream dependency advisories, can change with the registry independently of this source, and are outside this persistence migration's scope.

## Limitations and non-goals

- `better-sqlite3` remains synchronous on the gateway thread. Migration and reload are synchronous startup costs.
- No cross-store transaction makes a goal and its tasks atomic as one unit; existing managers retain orchestration responsibility.
- No rollback command, dual-write period, production backend switch, worker, compression, retention policy, payload normalization, or shared metadata service is included.
- Sessions, teams, staff, inbox, costs, colours, preferences, PR state, transcripts, prompts, verification output, artifacts, search indexes, and caches retain their current stores.
- Retired JSON is audit and offline-recovery evidence, not an automatically selected fallback.
- Focused native tests and a packed smoke do not replace broad operating-system, filesystem, disk-full, abrupt-power-loss, antivirus, and long-duration contention qualification.

See [Gate store SQLite persistence](gate-store-sqlite-persistence.md) for the established adjacent pattern. The stores remain separate authorities; similarity in their migration state machines is not a cross-store ownership contract.
