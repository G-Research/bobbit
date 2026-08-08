# Gate store SQLite persistence prototype

## Goal

Remove the write amplification caused by serializing and atomically replacing the complete `gates.json` array after any gate mutation, without changing `GateStore`'s in-memory `Map`, public API, or callers.

## Layout and schema

The production filesystem backend uses `better-sqlite3` 13.x (Node-API with bundled platform prebuilds) and opens one database per project:

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

A small `gate_store_meta` table contains the completed legacy-migration marker. Gate records intentionally retain SQLite's rowid table: multi-megabyte JSON payloads append to the table while the composite uniqueness index contains only identifiers, avoiding large-payload B-tree reshuffling during migration. Payload identity and JSON validity are checked when records load.

The database uses `journal_mode=DELETE`, `synchronous=FULL`, a five-second busy timeout, and no extension loading. Bobbit serves reads from the existing in-memory map, so WAL's read/write concurrency is unnecessary for this single-connection store.

## Mutation flow

Mutations mark only their affected composite gate keys dirty. A shared 500 ms drain coalesces bursts and snapshots the dirty gates. One `BEGIN IMMEDIATE` transaction upserts or deletes every affected row and commits the entire batch atomically.

`flush()` and strict lifecycle writes remain publication barriers. A failed statement or commit rolls back the transaction, rejects affected barriers, and retains the dirty keys for retry. Multi-gate reset and workflow-reconciliation batches therefore regain all-record atomicity that the per-file sharding experiment could not provide.

Persistence metrics report the serialized gate-payload bytes and transaction duration for the latest batch.

## Legacy migration

On first open:

1. Create the versioned schema.
2. Parse and validate legacy `gates.json`, including duplicate identities.
3. Insert every gate and the `migration_complete` marker in one transaction.
4. Commit the database.
5. Rename the legacy file to `gates.json.sqlite-retired`.

A crash before commit leaves `gates.json` authoritative and retryable. A crash after commit leaves SQLite authoritative even if retirement did not run. Once the marker exists, a stray or restored `gates.json` is ignored.

Malformed legacy JSON, incomplete unmarked database rows, unsupported schema versions, corrupt payload JSON, and row/payload identity mismatches fail startup rather than silently producing an empty store.

## Lifecycle and testing

`GateStore.close()` flushes pending mutations and explicitly closes the SQLite handle. `ProjectContext.close()` uses it before a project state directory can be removed, which is required on Windows.

The existing `FsLike` in-memory fixtures retain the JSON writer as a test-only adapter because native SQLite cannot run on memfs. Dedicated real-filesystem tests cover the production SQLite path: migration, authoritative reload, transactional rollback, strict multi-gate atomicity, pending-write close, concurrent close, corrupt-row handle release, and close/reopen on Windows. The packed-consumer audit also loads the installed `better-sqlite3` binding and executes an in-memory write/read smoke before querying advisories.

## Prototype benchmark

Using a copied 285.3 MiB production `gates.json` with 3,563 gates on the current Windows/Defender-backed worktree, three repeated `better-sqlite3` runs measured:

- Median transactional first migration: **7.86 s**
- Median subsequent startup loading all rows into the existing map: **1.75 s**
- Median-gate mutation: **14.6 KiB written in 7.1 ms**
- Resulting SQLite database: **288.3 MiB**

For comparison, the earlier built-in `node:sqlite` run over the nearly identical dataset measured 4.73 s migration, 1.35 s reload, and 5.8 ms mutation. `better-sqlite3` is slower in this workload, but ordinary writes remain tiny and fast while avoiding the experimental API warning on supported Node 22 installations.

This validates the write-amplification improvement without the thousands-of-files startup penalty. Migration and startup remain synchronous prototype costs; moving initialization to a worker or changing the map-loading contract is a separate optimization.

## Prototype risks

- `better-sqlite3` adds a native dependency of roughly 27 MiB unpacked. Its N-API prebuilds cover Bobbit's current Windows, macOS, Linux glibc, and Linux musl targets. The packed-consumer runtime smoke is pinned; cross-platform binary-release checks are still required.
- The synchronous driver executes on the gateway thread. The measured 7.1 ms ordinary transaction is small, but the 7.86 s one-time migration must occur behind startup readiness or move to a worker before production rollout.
- The older `.pre-migration` recovery pass still writes `gates.json`. Before rollout it must either run before the first SQLite import in every case or merge recovered gates into an existing database; SQLite intentionally ignores a stray monolith after its completion marker exists.
- If synchronous transaction latency grows materially, the same schema should move behind a dedicated worker rather than changing the `GateStore` API.
