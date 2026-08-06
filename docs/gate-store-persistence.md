# Gate store persistence

Gate state is project-scoped workflow truth. It must preserve approval status, verification cache semantics, signal ordering, and bypass auditability without making every gate update serialize all historical verification output on the gateway event loop.

`GateStore` therefore separates small mutable records from large immutable bodies. Normal mutations update only the affected goal and gate partitions; worker boundaries handle legacy migration, body externalization, and JSON serialization.

## On-disk layout

The canonical store lives under the owning project's state directory:

```text
<stateDir>/gate-records/v2/
  manifest.json
  goals/<goal-hash>.json
  history/<goal-hash>/<gate-hash>.json
  legacy/<goal-hash>.json
  audit/<goal-hash>/<gate-hash>/<ordinal>-<signal-hash>.json
  payloads/<hash-prefix>/<sha256>.payload
  reclaim/<sha256>.payload
```

IDs are hashed for filenames; the records retain and validate the original goal and gate IDs.

- **Goal shards** contain current gate truth and no signal bodies. Status, current content and metadata, cache invalidation state, and reset results remain directly readable. In-flight reset transaction intent is owned separately by `gate-reset-intents.json`.
- **History shards** contain bounded post-migration signal history for one gate. Updating one gate does not rewrite other gates' histories.
- **Legacy shards** are sealed migration archives. They preserve pre-v2 signal order and verdict/audit metadata without remaining on the mutation path.
- **Audit records** are immutable post-v2 human-bypass rows. They are published only after current bypass truth is durable.
- **Payload files** are content-addressed bodies referenced by hash, byte count, and a path derived from the owning v2 root.
- **Reclaim files** are payloads staged for crash-safe deletion. Startup retries bounded cleanup.

The manifest records the schema version, migration source hash and size, gate/signal inventory, externalized bytes, payload bytes, and migration/validation timestamps.

## Body externalization

Before a history shard is published, the payload worker replaces large inline bodies with `ManagedGatePayloadRef` values. This covers:

- verification step output;
- primary verification artifacts such as review Markdown or HTML reports;
- retained diagnostic artifact bodies;
- human-bypass content;
- human-bypass metadata values above the audit preview threshold.

Payloads are keyed by SHA-256, so identical content is stored once. Compact JSON retains the metadata required to identify and validate the body. Long bypass metadata also retains a bounded inline preview for ordinary audit views.

Existing retained-diagnostics files are not deleted or trusted merely because a persisted path names them. Explicit inspection first uses root-bounded retained stdout/stderr when available, then uses the managed payload copy as a durable fallback. This keeps routine reads body-free while preserving access after restart or diagnostics-file loss.

Managed references are bound to one gate-store root. Inspection derives the expected payload path from that root and verifies the declared hash and byte count while streaming the file. A path copied from another project is rejected.

## Retention policy

Retention applies to each gate's post-v2 history. The source-of-truth limits are exported by the v2 persistence module and are also reported as `cutoffs` by the maintenance probe.

- Completed ordinary signals retain at most 256 rows and 8 MiB of compact metadata.
- Running signals are retained until they become terminal.
- Up to 32 recent distinct-commit passed signals may be protected as verification-cache projections, but the row and byte ceilings remain absolute. If necessary, the oldest projection is evicted and that commit is reverified on a future signal.
- Human-bypass signals do not count as ordinary history. They move to immutable audit records so ordinary compaction cannot erase authorization history.
- Migrated v1 signals remain in sealed legacy shards. They preserve the upgrade-time history rather than being silently compacted during migration.

Every signal receives a stable persistence ordinal. When ordinary rows are pruned, the gate records `earliestRetainedOrdinal` and a bounded `prunedSignalRanges` list. Each range has inclusive `from` and `to` ordinals; a retained compaction tombstone also carries `reason` (`count`, `bytes`, or `count-and-bytes`) and epoch-millisecond `compactedAt`. Inspection may synthesize a known gap from the watermark or retained ordinal span when no tombstone covers it, in which case `reason` and `compactedAt` are omitted. This makes compaction visible without retaining removed bodies or inventing audit details.

A non-negative inspection selector is a stable ordinal. A known compacted or missing ordinal returns 410 `GATE_SIGNAL_HISTORY_PRUNED` with the gate id, requested ordinal, watermark, and inclusive gap range; inspection never substitutes another retained row. A selector outside known history returns 404. Negative selectors address positions in the retained tail. Browsing `section="signals"` ignores the selector and reports both the watermark and bounded ranges. Sealed migrated-v1 archive rows remain preserved history and are not labeled pruned merely because they predate post-v2 retention metadata.

Reset and cache invalidation remain current gate truth. Compaction does not convert a failed or pending gate to passed, bypass cache invalidation, or make human sign-off cacheable.

## Publication and crash consistency

A hot mutation schedules two bounded publications:

1. publish the affected gate's history partition, including externalized payload references and retention metadata;
2. publish the affected goal's small truth shard only after its dirty history partitions are durable.

`CoalescedJsonWriter` serializes snapshots in a worker thread, writes a same-directory temporary file, and atomically renames it into place. Mutations arriving during a write coalesce into the next snapshot rather than starting concurrent writes. Strict lifecycle operations use the same ordered publication queue, so an older asynchronous rename cannot overtake a reset or close barrier.

Human bypass uses an additional ordered transaction: history recovery copy, current truth, immutable audit row, then cleanup of the embedded copy. Startup repair can finish any interrupted stage without inventing bypass truth or losing its provenance.

Payload deletion occurs only after replacement owners are published and the root coordinator proves no current, legacy, audit, or pending partition still references the hash. A failed deletion leaves a source or reclaim file for a later bounded startup retry.

`ProjectContext.close()` flushes dirty history before truth shards and fences new mutations before releasing the root. A failed close remains retryable rather than discarding the latest snapshot.

## Migration from `gates.json`

`GateStore.prepare(stateDir)` is the production first-open boundary. Concurrent opens of the same physical state root coalesce behind one migration/preload worker, and project context publication waits for that worker result. Large source parsing, externalization, validation, and preload construction therefore stay off the gateway event loop.

Migration is restart-safe:

1. Read and hash the authoritative `gates.json`.
2. Build a fresh `gate-records/v2.staging` tree with current truth shards, sealed legacy history, managed payloads, and a complete manifest.
3. Validate source identity, goal/gate inventory, signal ordering, verdicts, bypass rows, diagnostics metadata, and every managed payload's size/hash contract.
4. Atomically rename staging into the v2 location. If an older v2 root exists, hold it as `v2.pre-migration` until the new root passes the canonical loader.
5. Revalidate the published root, then rename `gates.json` to `gates.json.v1-retired`. The source is retired only if its bytes still match the validated contract.

On interruption, startup restores a displaced prior root when necessary, removes incomplete staging, and retries from the still-authoritative legacy source. If v2 is incomplete and no legacy source exists, startup fails loudly instead of constructing empty state. Re-running against a complete v2 manifest is idempotent: startup validates the source contract if `gates.json` still exists, finishes retirement, and loads v2.

Migration preserves current status/content/metadata, signal ordering, verification results, cache invalidation state, bypass history, and diagnostics references. Inline bodies are externalized; authoritative retained-diagnostics files remain untouched.

## Inspection

Compact surfaces never hydrate managed bodies into canonical gate records. `gate_status`, summary endpoints, and an implicit `gate_inspect(section="verification")` stay bounded.

Use explicit inspection when full evidence is needed:

```text
gate_inspect(gate_id="implementation", section="verification", step="E2E", mode="grep", pattern="error|failed", context=3)
gate_inspect(gate_id="implementation", section="artifact", step="Review", artifact="primary", mode="tail", lines=200)
```

Explicit `grep`, `head`, `tail`, `slice`, and `full` modes stream only the selected text under aggregate byte, line, deadline, and regex-worker budgets. `full` is still bounded. Prefer a targeted `grep` or `slice` when the response reports truncation.

Explicit verification inspection exposes retained stdout/stderr byte and line counts plus cap/truncation state, but never the backing log paths. The server uses those private paths only to perform a root-bounded read. This lets operators judge diagnostic completeness without turning an API response into filesystem authority.

Primary step artifacts can be selected with `artifact="primary"`; pass `step` when more than one verification step has a retained primary body. Retained diagnostic artifacts use the IDs or exact `relativePath` values returned by the verification artifact index, with `retry` reserved for collapsed Playwright diagnostics IDs. An artifact `relativePath` is a supported opaque selector inside that index, not a private diagnostics backing path or managed-payload path. Indices and artifact responses expose compact metadata only—never backing paths, managed references, checksums, payload locations, or inline bodies. Artifact bodies are served only through bounded `section="artifact"` inspection after root ownership, declared size, and hash validate; direct backing-file reads are not part of the contract.

See [Retained gate diagnostics](gate-diagnostics.md) for command-log and Playwright artifact inspection.

## Maintenance and metrics

Use the project-scoped read-only probe:

```text
bobbit_read(operation="maintenance_inspect", probe="gate_store", projectId="<project-id>")
```

The equivalent REST endpoint is `GET /api/maintenance/gate-store?projectId=<project-id>`. Missing project scope returns 400; an unknown project returns 404.

The report includes:

- `migration`: source, externalized, and payload bytes plus migration/validation timestamps;
- `totals`: bytes and record counts by goal, history, legacy, audit, payload, orphan payload, and reclaim categories;
- `cutoffs`: the active retention policy;
- `metrics`: bytes written, serialization/write time, shard count, compactions, pruned rows/bytes, payload reclaim results, migration duration, and bypass audit publication;
- `largest`: a bounded list of the largest metadata records and payloads, with `exceedsLimit` for bounded JSON/audit categories;
- `staleStaging` and `scan`: migration debris and freshness/coalescing metadata.

Directory walking and file stats run in a worker. Concurrent requests for one root coalesce, successful results are cached briefly, and a bounded stale result may be returned if a refresh fails. Without usable stale data the endpoint returns 503 with `retryable: true` and `retryAfterMs`; it never falls back to a synchronous gateway-thread scan.

`orphanPayloadBytes` reports bodies not referenced by canonical metadata. `reclaimBytes` reports deletion staging left for retry. A large payload is not by itself a retention violation because payload bodies are content-addressed and outside hot JSON; investigate large or over-limit goal/history/audit records first.

Shard serialization/write and compaction timing feeds CPU diagnostics under the `gate-store` and `gate-store-history` operation families. Worker migration duration, externalized bytes, and payload bytes are exposed through the manifest-backed maintenance metrics instead. Use both views when investigating lag: maintenance explains durable size, migration, and reclaim state, while CPU/event-loop diagnostics show whether a hot publication delayed the gateway.

## Failure triage

- **`gates.json` remains after upgrade:** inspect the v2 manifest and migration report. A matching source may be awaiting safe retirement; do not delete it manually.
- **`v2.staging` or `v2.pre-migration` remains:** restart and let preparation recover. If startup fails, preserve both directories and the retired/legacy source for diagnosis.
- **Inspection says a payload is missing or tampered:** verify the reference belongs to the same project root and compare maintenance orphan/reclaim totals. Do not copy a ref or payload path between projects.
- **History grows past cutoffs:** check `largest`, `metrics.compactions`, and immutable audit/legacy totals. Ordinary history is capped; audit and sealed migration history are intentionally separate.
- **One gate update rewrites broad state:** this is a regression. The write set should be the affected gate history shard, its small goal truth shard, and any new payload/audit files—not unrelated goal or gate histories.
