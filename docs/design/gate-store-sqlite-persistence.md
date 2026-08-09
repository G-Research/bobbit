# Gate store SQLite persistence

## Goal

Remove the write amplification caused by serializing and atomically replacing the complete `gates.json` array after any gate mutation, without changing `GateStore`'s in-memory `Map`, public API, or callers.

## Layout and schema

The production filesystem backend uses `better-sqlite3` 12.11.x with platform prebuilds and opens one database per project. Version 13 is intentionally not used because its implicit `node-gyp` install currently requires a local compiler even when a bundled Windows binary is present:

```text
.bobbit/state/gates.sqlite
```

SQLite schema version 1 stores one complete, flexible `GateState` JSON payload per row:

```sql
CREATE TABLE gate_records (
  goal_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (goal_id, gate_id)
) STRICT;
```

A small `gate_store_meta` table contains the completed legacy-migration marker, the completed `.pre-migration` recovery marker, and durable pending-retirement intents. Gate records intentionally retain SQLite's rowid table: multi-megabyte JSON payloads append to the table while the composite uniqueness index contains only identifiers, avoiding large-payload B-tree reshuffling during migration. Every loaded payload is checked for JSON validity, row identity, supported gate/signal/step shapes, finite timestamps and durations, and duplicate composite identities. Unknown historical fields are retained.

The database uses `journal_mode=DELETE`, `synchronous=FULL`, a five-second busy timeout, and no extension loading. Bobbit serves reads from the existing in-memory map, so WAL's read/write concurrency is unnecessary for this single-connection store.

## Mutation flow

Mutations mark only their affected composite gate keys dirty. A shared 500 ms drain coalesces bursts and snapshots the dirty gates. One `BEGIN IMMEDIATE` transaction upserts or deletes every affected row and commits the entire batch atomically.

`flush()` and strict lifecycle writes remain publication barriers. A failed statement or commit rolls back the transaction, rejects affected barriers, and retains the dirty keys for retry. Multi-gate reset and workflow-reconciliation batches therefore regain all-record atomicity that the per-file sharding experiment could not provide.

Persistence metrics report the serialized gate-payload bytes and transaction duration for the latest batch.

## Startup migration and recovery

Production real-filesystem stores select SQLite automatically; there is no migration flag. On the first open:

1. Create the versioned schema.
2. Read and completely validate both `gates.json` and `gates.json.pre-migration`, when present. No source is renamed while either payload is invalid.
3. Merge by `(goalId, gateId)`, with `gates.json` winning conflicts and backup-only gates retained.
4. Insert the full merged set, verify its count, identities, and serialized payloads, then write `migration_complete` and durable retirement intents in the same `BEGIN IMMEDIATE` transaction.
5. Commit before renaming either source.

When a completed SQLite database already exists, its rows are validated first. A not-yet-recovered `gates.json.pre-migration` is then validated and merged in one transaction with `ON CONFLICT DO NOTHING`, so SQLite wins conflicts. Verification, the recovery-complete marker, and its retirement intent commit atomically. `state-migration.ts` deliberately does not recover gate JSON; `GateStore` is the sole owner, preventing a recovery pass from creating `gates.json` that authoritative SQLite would ignore.

## Non-destructive retirement

Committed sources are renamed, never deleted or overwritten. Preferred names are `gates.json.sqlite-retired` and `gates.json.pre-migration-recovered`; an occupied name is preserved and the first free numeric suffix is used. The durable intent is cleared only after the rename. If commit succeeds but rename is interrupted, startup fails with the source and intent intact; the next startup completes only the rename and cannot re-import stale edits. If the rename succeeded but intent clearing was interrupted, the absent source lets the next startup clear the intent safely.

Once `migration_complete` exists, an unmarked stray or restored `gates.json` is ignored. Once recovery is recorded, a restored `.pre-migration` source is likewise ignored. Malformed sources, failed imports, incomplete unmarked database rows, unsupported schema versions, corrupt payload JSON, and row/payload identity mismatches fail startup without retiring their source. Constructor failures close the database handle.

## Lifecycle and testing

`GateStore.close()` flushes pending mutations and explicitly closes the SQLite handle. `ProjectContext.close()` uses it before a project state directory can be removed, which is required on Windows.

The existing `FsLike` in-memory fixtures retain the JSON writer as a test adapter because native SQLite cannot run on memfs; passing a non-real filesystem keeps that behavior automatically. Dedicated real-filesystem tests cover automatic `ProjectContext` startup migration, exact restart restoration, dual-source precedence, collision-safe backups, authoritative `.pre-migration` recovery, validation/import rollback, interrupted retirement retry, strict multi-gate atomicity, concurrent close, and corrupt-row handle release. The packed-consumer audit also loads the installed `better-sqlite3` binding and executes an in-memory write/read smoke before querying advisories.

## Qualification benchmark

Using a copied 285.3 MiB production `gates.json` with 3,563 gates on the current Windows/Defender-backed worktree, three repeated `better-sqlite3` runs measured:

- Median transactional first migration: **7.86 s**
- Median subsequent startup loading all rows into the existing map: **1.75 s**
- Median-gate mutation: **14.6 KiB written in 7.1 ms**
- Resulting SQLite database: **288.3 MiB**

For comparison, the earlier built-in `node:sqlite` run over the nearly identical dataset measured 4.73 s migration, 1.35 s reload, and 5.8 ms mutation. `better-sqlite3` is slower in this workload, but ordinary writes remain tiny and fast while avoiding the experimental API warning on supported Node 22 installations.

This validates the write-amplification improvement without the thousands-of-files startup penalty. Migration and startup remain synchronous costs.

## Follow-up production qualification

- `better-sqlite3` adds a native dependency. Its published prebuilds cover Bobbit's supported Node versions and current Windows, macOS, Linux glibc, and Linux musl targets. The packed-consumer runtime smoke is pinned; exhaustive platform, filesystem, antivirus, disk-full, and power-loss qualification remains follow-up work.
- The synchronous driver executes on the gateway thread. Ordinary transactions are small, but the measured one-time migration can delay readiness. If this becomes material, move the same persistence contract behind a dedicated worker rather than changing the `GateStore` API.
- A rollback command is intentionally not part of this MVP. Retired source files are retained under collision-safe backup names for manual recovery and audit.
