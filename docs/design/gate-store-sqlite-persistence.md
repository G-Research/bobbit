# Gate store SQLite persistence

## Context and scope

`GateStore` persists workflow gate state and signal history for each project. The former JSON backend rewrote the complete `gates.json` array after every mutation, so a large retained verification payload made even a one-gate update expensive.

The production backend now uses SQLite to update only affected gates while preserving the existing `GateStore` contract:

- callers still use the same synchronous read and mutation API;
- the in-memory `Map` remains the read model;
- `(goalId, gateId)` remains the composite identity;
- a gate's complete, extensible JSON payload remains intact;
- multi-gate strict resets publish transactionally; and
- every registered project owns a separate store under its state directory.

SQLite is selected automatically for the real filesystem. There is no migration flag because a flag would create two possible authorities and make startup behavior depend on deployment configuration. Automatic selection gives every normal startup the same one-way migration and prevents a nightly instance from continuing to amplify JSON writes accidentally.

The MVP does not add a rollback command or move persistence to a worker. Retired JSON sources remain available for audit and deliberate offline recovery, but they are not a second live backend.

## Ownership and backend selection

`ProjectContext` owns one `GateStore` and therefore one `gates.sqlite` connection for its project. It constructs the gate store after the other project stores, reducing the chance that a later constructor failure leaves a native handle open. If reset-coordinator construction then fails, the context disposes the gate store immediately.

The default backend depends on the filesystem seam:

| Construction | Backend | Reason |
|---|---|---|
| Real production filesystem | SQLite | Durable, transactional per-gate updates are the production authority. |
| Injected non-real `FsLike`, including memfs | JSON adapter | Native SQLite cannot operate on memfs, and existing unit fixtures need deterministic in-memory files. |
| Explicit `persistence` option | Requested adapter | This is a test/integration seam, not a production migration toggle. |

The JSON adapter preserves the public API and whole-array fixture format. Production callers do not opt into SQLite; `ProjectContext` and a directly constructed real-filesystem `GateStore` select it automatically.

## Layout and schema

The MVP pins `better-sqlite3` 12.11.1 and opens:

```text
<project-root>/.bobbit/state/gates.sqlite
```

Schema version 1 stores one flexible `GateState` JSON payload per composite identity:

```sql
CREATE TABLE gate_records (
  goal_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (goal_id, gate_id)
) STRICT;

CREATE INDEX gate_records_goal_id_idx ON gate_records(goal_id);
```

`gate_store_meta` is a strict key/value table containing:

- `migration_complete`, which makes SQLite authoritative;
- `pre_migration_recovery_complete`, which prevents a recovered source from being replayed;
- `pending_retirement:gates.json`; and
- `pending_retirement:gates.json.pre-migration`.

The retirement keys are durable intent records, not temporary process state. They bridge the unavoidable boundary between a committed database transaction and a filesystem rename.

Gate records retain SQLite's rowid table. Large payloads append to the table while the uniqueness index contains only identifiers, avoiding repeated large-payload B-tree reshuffling. On every startup, each row is parsed and checked for row/payload identity, valid known gate, signal, verification, step, artifact, and diagnostics shapes, and finite numeric fields. Duplicate source identities are rejected. Unknown historical fields and non-empty historical step-type discriminators are preserved rather than normalized away.

The connection uses `journal_mode=DELETE`, `synchronous=FULL`, and a five-second busy timeout. No extensions are loaded. A single connection is sufficient because Bobbit serves reads from the in-memory map; WAL concurrency would not improve that ownership model.

## Mutation and publication flow

Mutations mark only affected composite keys dirty. A 500 ms drain coalesces bursts, snapshots those keys, and uses one `BEGIN IMMEDIATE` transaction to upsert or delete the complete affected batch.

`flush()` and strict lifecycle writes are publication barriers. If serialization, a statement, or commit fails:

- SQLite rolls back the complete batch;
- affected barriers reject;
- dirty keys remain queued for retry; and
- a strict reset restores its prior in-memory status, timestamp, and cache-invalidation fields before returning the error.

This preserves all-record transactional reset behavior while ordinary reads continue to use the map. Persistence metrics expose the serialized payload bytes and transaction duration for the latest batch.

## Startup order and authority

Startup is synchronous and establishes one authority before the context becomes available:

1. Open the native database and reject a schema newer than the supported version.
2. Create schema version 1 when opening a new database.
3. If `migration_complete` is absent, require `gate_records` to be empty and run first migration.
4. Validate every authoritative SQLite row.
5. Complete any previously committed source retirement.
6. If eligible, merge `gates.json.pre-migration` into the authoritative database.
7. Re-read validated rows into the in-memory map.

The generic per-project recovery pass intentionally excludes gate files. `GateStore` is the sole owner of both `gates.json` and `gates.json.pre-migration`; otherwise generic recovery could create a new JSON file that completed SQLite state would ignore.

### First migration

When `migration_complete` is absent, `GateStore`:

1. Requires the SQLite record table to be empty. Unmarked rows are ambiguous and fail startup rather than being guessed authoritative.
2. Reads and completely validates both legacy sources when present. Both must validate before any import or rename begins.
3. Merges by `(goalId, gateId)`. `gates.json` wins conflicts; gates found only in `gates.json.pre-migration` are retained.
4. Inserts the complete merged set and verifies its count, composite identities, and exact serialized payloads inside one `BEGIN IMMEDIATE` transaction.
5. Writes `migration_complete`, the recovery-complete marker when a recovery source participated, and applicable retirement intents in that same transaction.
6. Commits before attempting either source rename.

An empty project follows the same path and receives a marked, empty authoritative database. Automatic initialization therefore does not depend on a legacy file being present.

### Recovery into authoritative SQLite

If SQLite already has `migration_complete`, its rows are validated before any source is touched. When `gates.json.pre-migration` exists and recovery has not already completed, `GateStore` validates the complete source and merges it in one transaction using conflict-ignore inserts:

- existing SQLite rows win identity conflicts;
- recovery-only gates are added;
- count, identity, and exact payload verification occurs before commit; and
- the recovery-complete marker and retirement intent commit with the merge.

This is additive recovery, not a restore of an older snapshot over current state.

### Mixed-state behavior

| Observed state | Startup behavior |
|---|---|
| No migration marker, no SQLite rows, either or both JSON sources present | Validate all present sources, import the merged set, mark SQLite authoritative, then retire sources. |
| No migration marker and no sources | Mark the empty SQLite database authoritative. |
| No migration marker but SQLite rows exist | Fail startup; incomplete unmarked rows are never adopted or overwritten. |
| Migration marker present and a retirement intent remains | Validate SQLite, then retry only the rename. Source edits made after commit are not re-imported. |
| Migration marker present, unmarked `gates.json` appears, and no retirement intent exists | Ignore the stray legacy file; SQLite remains authoritative. |
| Migration marker present and an unrecovered `.pre-migration` source appears | Transactionally add recovery-only identities, then mark and retire the source. |
| Recovery-complete marker present and `.pre-migration` reappears without an intent | Ignore it; replay would resurrect stale state. |
| Unsupported schema, invalid marker/intent, corrupt SQLite payload, or row/payload identity mismatch | Fail startup and close the constructor-owned handle. |

## Non-destructive source retirement

Committed sources are renamed, never deleted or overwritten:

| Source | Preferred retained name |
|---|---|
| `gates.json` | `gates.json.sqlite-retired` |
| `gates.json.pre-migration` | `gates.json.pre-migration-recovered` |

If the preferred target exists, it is preserved and the first free numeric suffix is used, such as `.sqlite-retired.1` or `.pre-migration-recovered.1`.

The database intent is cleared only after the rename succeeds. If commit succeeds but rename is interrupted, startup fails with the authoritative database, source, and intent intact. The next startup validates SQLite and retries only retirement, so even a modified source cannot be imported twice. If the rename completed but intent clearing did not, the next startup sees the source is absent and safely clears the intent.

## Failure guarantees

Migration and recovery deliberately fail closed:

- Every source eligible for import is read and fully validated before its import transaction. A source covered by an already-committed retirement intent is deliberately not reread; after validating authoritative SQLite, startup retries only its rename. Unmarked sources that are no longer eligible are ignored.
- Failed validation of an eligible source leaves it byte-for-byte untouched.
- Failed inserts or verification roll back all imported rows, markers, and intents.
- A failed first migration may leave the newly created empty SQLite schema file, but it does not commit gate rows or migration metadata.
- Failed recovery into authoritative SQLite leaves its prior rows unchanged and the recovery source untouched.
- Retirement never starts until imported state and its durable intent have committed.
- Existing authoritative rows are validated before pending retirement or new recovery.
- Constructor and load failures close the native handle, allowing the file to be moved or removed on Windows after failure.

These guarantees prevent silent partial imports. They do not make a live database and its retained backups interchangeable: only the metadata state machine determines whether a source is eligible for import.

## Operational inspection and recovery precautions

Treat `gates.sqlite` as authoritative whenever `migration_complete=1` in `gate_store_meta`.

Before inspection or recovery:

1. Stop the gateway gracefully and await project-context shutdown. This flushes queued gate mutations and releases the native handle; it is mandatory before moving state on Windows.
2. Copy the entire project state directory to an operator-owned location. Do not work on live state, and do not copy only `gates.sqlite` while a process may be writing it.
3. Record source sizes and hashes before experimenting. For a migration comparison, record the gate count, sorted `(goalId, gateId)` identities, and a hash of each exact JSON payload.
4. Inspect the copy read-only. Check `PRAGMA user_version`, `PRAGMA quick_check`, `gate_store_meta`, the `gate_records` count, and that each payload's IDs match its row IDs.
5. Exercise startup, close, and reopen against another disposable copy before changing any operational state.

For common failures:

- **Pending retirement rename failed:** leave the source and metadata untouched, remove the external file lock or permission problem, and restart. The retry retires the committed source without re-importing it.
- **Legacy or recovery validation failed before commit:** preserve the rejected bytes, correct or replace the source only while the gateway is stopped, and retry on a copy first. The authoritative database, if one existed, has not incorporated that source.
- **SQLite validation, schema, or marker validation failed:** preserve the complete state directory and escalate to deliberate offline recovery. Do not delete the database, clear metadata rows, or rename a retired JSON backup into place on the live project.

A retired backup is evidence, not an automatic rollback image. Once migration or recovery is marked complete, simply restoring `gates.json` or `.pre-migration` is intentionally ignored. This MVP has no supported rollback command; a manual restore must build and validate one consistent state offline before replacement during a stopped maintenance window.

## Lifecycle and Windows cleanup

`GateStore.close()` is an idempotent barrier: concurrent calls share the same close promise, pending mutations flush, and then the SQLite connection closes. `ProjectContext.close()` first stops mutation sources and waits for reset recovery, then closes `GateStore` alongside the other durable stores before directory cleanup. Callers must await context close rather than deleting or renaming a project directory directly.

If project construction fails after opening the database, disposal closes the handle without waiting for normal ownership transfer. Startup validation failures do the same. Real-filesystem tests verify the database can be renamed after malformed-source and corrupt-row failures, pinning the Windows handle-release requirement.

## Test coverage

The memfs unit adapter continues to cover the public `GateStore` logic and JSON persistence semantics. Dedicated real-filesystem coverage pins production behavior, including:

- automatic `ProjectContext` migration;
- mutation, close, restart, and exact restoration;
- live/recovery precedence and recovery-only gate preservation;
- collision-safe, non-destructive backup naming;
- `.pre-migration` merge into already-authoritative SQLite;
- full validation and transactional import rollback with original bytes preserved;
- retry after a committed migration whose rename was interrupted;
- strict multi-gate rollback;
- gate count, composite identity, historical fields, and payload preservation; and
- concurrent close plus handle release after startup failure.

The packed-consumer test also rebuilds the installed native dependency with lifecycle scripts enabled only for `better-sqlite3`, then loads the binding and executes an in-memory create/insert/select/close smoke.

## MVP landing qualification

The final ordered qualification ran on the unchanged implementation baseline `0eec79609f8d3ddfa2f9bd9d25da1cadc02c7e1c` on Windows with Node 24.13.1 and npm 11.8.0:

| Check | Result |
|---|---|
| `npm run check` | Passed |
| `npm run build` | Passed |
| `npm run test:unit` | Passed |
| `npm run test:browser` | Passed |
| `npm run test:e2e` | Passed |
| `npm run test:bundle` | Passed |
| Packed-consumer native `better-sqlite3` rebuild and write/read smoke | Passed |

A read-only snapshot of representative production gate state was copied into an owned temporary directory, migrated, closed, reopened, queried directly, and removed. Source, post-migration, reopened, and SQLite counts were all 16. Sorted composite identities and every per-gate payload hash matched, and the retired JSON backup was byte-exact. The sorted-identity SHA-256 was `0f06c43d044c35b6d40d2fb5f8aeab2efd7c5540a77d7d907b6e1a65d745eb5e`; the identity-plus-payload-hash manifest SHA-256 was `d3a5b491925f4f7941756e226edf4fabff3a283facc670cf361b8dad9e27d3e1`. The live source's SHA-256, size, and modification time were unchanged before and after the exercise.

The same packed-consumer command was **not audit-clean**: after the native smoke passed, its separate mutable-registry audit reported two moderate and two high vulnerable-package findings, all through upstream `@earendil-works/pi-coding-agent`. The advisory set at qualification time was:

- `brace-expansion`: `GHSA-mh99-v99m-4gvg`, `GHSA-rgw5-rvv9-x895`;
- `undici`: `GHSA-8xcm-r25x-g524`, `GHSA-4cwx-7wf7-3272`, `GHSA-m8rv-5g2x-5cg5`, `GHSA-jr45-8vmc-qm54`, `GHSA-v3r7-h72x-cjcm`.

Those registry findings are reported separately from the passing SQLite native runtime qualification. They are upstream dependency advisories, not caused by this persistence change, and this MVP did not broaden into a Pi dependency upgrade. Registry results can change independently of source; see [Optional manual packed-consumer audit](../releasing.md#optional-manual-packed-consumer-audit) for policy.

## Performance benchmark

A copied 285.3 MiB production `gates.json` containing 3,563 gates was benchmarked three times on a Windows/Defender-backed worktree:

- median transactional first migration: **7.86 s**;
- median subsequent startup loading rows into the map: **1.75 s**;
- median-gate mutation: **14.6 KiB written in 7.1 ms**; and
- resulting SQLite database: **288.3 MiB**.

The benchmark confirms the intended write-amplification improvement: ordinary mutations write a gate-sized payload rather than the whole store. Migration and startup remain synchronous costs.

## Deferred production work

- **Worker-backed access:** `better-sqlite3` currently runs synchronously on the gateway thread. If migration or transactions materially delay responsiveness, move the same persistence contract behind a dedicated worker without changing the public `GateStore` API.
- **Exhaustive fault and platform qualification:** the packed native smoke and current suites do not replace broad Windows, macOS, Linux glibc/musl, filesystem, network-share, antivirus, disk-full, abrupt-power-loss, and long-duration contention testing.
- **Rollback tooling:** no rollback command is included. Any future tool must preserve the single-authority and payload-verification guarantees rather than making retained JSON live again by filename alone.
