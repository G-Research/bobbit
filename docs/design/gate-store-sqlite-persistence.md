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

The MVP pins `better-sqlite3` 13.0.3 and opens:

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

The retirement keys are durable intent records, not temporary process state. They bridge the unavoidable boundary between a committed database transaction and filesystem retirement.

Gate records retain SQLite's rowid table. Large payloads append to the table while the uniqueness index contains only identifiers, avoiding repeated large-payload B-tree reshuffling. On every startup, each row is parsed and checked for row/payload identity, valid known gate, signal, verification, step, artifact, and diagnostics shapes, and finite numeric fields. Duplicate source identities are rejected. Unknown historical fields and non-empty historical step-type discriminators are preserved rather than normalized away.

The connection uses `journal_mode=DELETE`, `synchronous=FULL`, and a five-second busy timeout. No extensions are loaded. A single connection is sufficient because Bobbit serves reads from the in-memory map; WAL concurrency would not improve that ownership model.

## Mutation and publication flow

Mutations mark only affected composite keys dirty. A 500 ms drain coalesces bursts, snapshots those keys, and uses one `BEGIN IMMEDIATE` transaction to upsert or delete the complete affected batch.

`close()` first sets a synchronous store-level mutation fence, then enters the persistence close barrier. Every mutation therefore has one unambiguous order:

- a mutation admitted before the fence may update the in-memory map and remains ordered into the final flush, including a strict reset already awaiting publication; or
- a mutation attempted after the fence fails before changing the map, scheduling persistence, or notifying an observer. Synchronous mutators throw, while the asynchronous reset variants return a rejected promise.

This fence applies to both SQLite and the JSON/memfs adapter. It prevents a late mutation from changing the read model after the final persistence snapshot has already been chosen.

`flush()` and strict lifecycle writes are publication barriers. If serialization, a statement, or commit fails:

- SQLite rolls back the complete batch;
- affected barriers reject;
- dirty keys remain queued for retry; and
- a strict reset restores its prior in-memory status, timestamp, and cache-invalidation fields before returning the error.

An orderly close gives a failed final publication one immediate retry. This retry uses the same requeued dirty keys and transaction path, without sleeping or accepting new mutations. A transient failure therefore closes only after the retry commits. If both attempts fail, every concurrent close caller receives the failure and the native handle is still released; shutdown never loops indefinitely or reports false durability.

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
2. Reads and completely validates both legacy sources when present. Both must validate before any import or retirement begins.
3. Merges by `(goalId, gateId)`. `gates.json` wins conflicts; gates found only in `gates.json.pre-migration` are retained.
4. Inserts the complete merged set and verifies its count, composite identities, and exact serialized payloads inside one `BEGIN IMMEDIATE` transaction.
5. Writes `migration_complete`, the recovery-complete marker when a recovery source participated, and applicable retirement intents in that same transaction.
6. Commits before attempting either source retirement.

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
| Migration marker present and a retirement intent remains | Validate SQLite, then retry only retirement. Source edits made after commit are not re-imported. |
| Migration marker present, unmarked `gates.json` appears, and no retirement intent exists | Ignore the stray legacy file; SQLite remains authoritative. |
| Migration marker present and an unrecovered `.pre-migration` source appears | Transactionally add recovery-only identities, then mark and retire the source. |
| Recovery-complete marker present and `.pre-migration` reappears without an intent | Ignore it; replay would resurrect stale state. |
| Unsupported schema, invalid marker/intent, corrupt SQLite payload, or row/payload identity mismatch | Fail startup and close the constructor-owned handle. |

## Non-destructive source retirement

Committed sources are moved to retained names without overwriting any existing entry:

| Source | Preferred retained name |
|---|---|
| `gates.json` | `gates.json.sqlite-retired` |
| `gates.json.pre-migration` | `gates.json.pre-migration-recovered` |

Retirement atomically creates a same-directory hard link at the candidate name. Both Windows and POSIX refuse that no-replace publication with `EEXIST` when another entry already occupies the candidate, including one created concurrently. Only that collision advances to the next numeric suffix, such as `.sqlite-retired.1` or `.pre-migration-recovered.1`; every other link error fails startup without touching the source. After the retained name exists, the source name is unlinked. Thus a failure can leave two names for the same bytes, but cannot leave zero names or overwrite prior evidence.

The database intent is cleared only after the source unlink succeeds. If commit succeeds but link or unlink is interrupted, startup fails with the authoritative database and intent intact; a successful link followed by failed unlink also leaves both names intact. The next startup validates SQLite and retries only retirement, so even a modified or replaced source cannot be imported twice. If retirement completed but intent clearing did not, the next startup sees the source is absent and safely clears the intent.

## Failure guarantees

Migration and recovery deliberately fail closed:

- Every source eligible for import is read and fully validated before its import transaction. A source covered by an already-committed retirement intent is deliberately not reread; after validating authoritative SQLite, startup retries only its no-replace retirement. Unmarked sources that are no longer eligible are ignored.
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

- **Pending retirement failed:** leave the source, any already-published retained link, and metadata untouched; remove the external file lock or permission problem, then restart. The retry selects a collision-safe name and retires the committed source without re-importing it.
- **Legacy or recovery validation failed before commit:** preserve the rejected bytes, correct or replace the source only while the gateway is stopped, and retry on a copy first. The authoritative database, if one existed, has not incorporated that source.
- **SQLite validation, schema, or marker validation failed:** preserve the complete state directory and escalate to deliberate offline recovery. Do not delete the database, clear metadata rows, or rename a retired JSON backup into place on the live project.

A retired backup is evidence, not an automatic rollback image. Once migration or recovery is marked complete, simply restoring `gates.json` or `.pre-migration` is intentionally ignored. This MVP has no supported rollback command; a manual restore must build and validate one consistent state offline before replacement during a stopped maintenance window.

## Lifecycle and Windows cleanup

`GateStore.close()` is an idempotent barrier: its first call synchronously stops admission of new mutations before requesting the final persistence flush, and concurrent calls share the same close promise. Work accepted before that fence remains in the persistence queue. Post-fence mutation and reset calls fail before any map or observer effect. A strict reset accepted before close retains its normal contract across the barrier: successful publication reaches the final durable snapshot, while failed publication compensates the in-memory reset and does not notify observers.

Pending SQLite mutations flush with at most one immediate retry, and then the connection closes. A persistent final-publication failure rejects the shared close promise but still closes the connection, so the failure is visible without retaining a Windows file handle. `ProjectContext.close()` first stops mutation sources and waits for reset recovery, then closes `GateStore` alongside the other durable stores before directory cleanup. Callers must await context close rather than deleting or renaming a project directory directly.

If project construction fails after opening the database, disposal closes the handle without waiting for normal ownership transfer. Startup validation failures do the same. Real-filesystem tests verify the database can be renamed after malformed-source and corrupt-row failures, pinning the Windows handle-release requirement.

## Test coverage

The memfs unit adapter continues to cover the public `GateStore` logic and JSON persistence semantics. Dedicated real-filesystem coverage pins production behavior, including:

- automatic `ProjectContext` migration;
- mutation, close, restart, and exact restoration;
- live/recovery precedence and recovery-only gate preservation;
- atomic no-replace, collision-safe backup naming under deterministic races;
- `.pre-migration` merge into already-authoritative SQLite;
- full validation and transactional import rollback with original bytes preserved;
- retry after a committed migration whose link or source unlink was interrupted;
- strict multi-gate rollback;
- gate count, composite identity, historical fields, and payload preservation;
- transient and persistent final-flush failures, shared concurrent-close outcomes, and handle release after persistent close and startup failures; and
- the close mutation fence across every public mutator and reset variant, including durable pre-fence work, post-fence map/observer isolation, and strict-reset compensation.

Packed-consumer qualification deliberately does not run `npm rebuild`. Although `better-sqlite3` 13.0.3 declares `gypfile: false`, has no install lifecycle, and ships bundled prebuilds, npm omits `gypfile: false` from lockfile and hidden-lockfile package metadata. A targeted rebuild can therefore synthesize a `node-gyp rebuild` lifecycle and attempt an unintended local source build. Qualification instead loads the installed bundled prebuild directly, performs an in-memory native create/write/read/close smoke, and exercises the installed goal and task stores through a durable write/read/reopen/close round trip. This tests the artifact consumers receive without replacing its native binding with a locally compiled binary.

## MVP landing qualification

The final ordered qualification ran without source edits on the exact close-fence baseline `72763194d87190036b60fb02635e5c063fa86267` on Windows with Node 24.13.1 and npm 11.8.0. Environment setup ran separately: `npm ci` passed in 35 seconds, then a probe identified missing generated server imports and `npm run build:server` restored them in 13 seconds. The authoritative matrix restarted from the beginning in the required order:

| Check | Result |
|---|---|
| `npm run check` | Passed (40 s) |
| `npm run build` | Passed (18 s) |
| `npm run test:unit` | Passed (202 s; 1,064 files passed, 3 skipped; 9,837 tests passed, 20 skipped) |
| `npm run test:browser` | Passed (381 s; 717 passed, 9 skipped; browser budget passed) |
| `npm run test:e2e` | Passed (379 s; groups A, B, C, and D passed) |
| `npm run test:bundle` | Passed (7 s; 2 files, 4 tests) |
| Historical packed-consumer native `better-sqlite3` rebuild and write/read smoke (pre-v13 rebuild-era baseline) | Passed before the separate registry audit |

A read-only snapshot of representative production gate state was copied into an owned temporary directory, migrated, closed, reopened, queried directly, and removed. Source, post-migration, reopened, and SQLite counts were all 16. Sorted composite identities and every per-gate payload hash matched, and the retired JSON backup was byte-exact. The sorted-identity SHA-256 was `0f06c43d044c35b6d40d2fb5f8aeab2efd7c5540a77d7d907b6e1a65d745eb5e`; the identity-plus-payload-hash manifest SHA-256 was `d3a5b491925f4f7941756e226edf4fabff3a283facc670cf361b8dad9e27d3e1`. Before and after the exercise, the live source remained byte-for-byte unchanged at SHA-256 `c1a015d2f28cebe27ceff104f230f133a213fd6644e7b8607fe2638ab5504240`, 44,685 bytes, with modification time `2026-08-07T07:55:00.694Z`.

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
