# Search worker and persistence

## Purpose

Search used to serialize a complete FlexSearch export after message mutations. That work could monopolize the gateway event loop and delay WebSocket authentication long enough for a session connection to time out. Search is now isolated so a slow index, file system, or rebuild cannot delay session handling.

This document is authoritative for runtime search ownership, persistence, recovery, and operations. The [Semantic search](internals.md#semantic-search) reference is authoritative for the current architecture, schema, ranking, and content policy; [Portable Search](design/portable-search.md) is historical rationale only.

## Architecture

Each project owns a `SearchService`, a lightweight asynchronous facade. It starts no worker at project startup. The first search operation or indexing mutation starts a dedicated Node worker thread. The gateway only forwards structured payloads and receives results, progress events, and persistence metrics; it never holds a FlexSearch store or prepares message search documents.

The worker owns all search work:

- message content-policy extraction, chunking, hashing, and document preparation;
- FlexSearch construction, mutation, and queries;
- mirror recovery, journal/snapshot persistence, cache migration, and index build; and
- stale-row inspection and cleanup.

A project without search traffic therefore pays no worker-start or index-build cost. The first query builds the derived index from the durable mirror. The build yields periodically within the worker, and queries are serialized behind it, so the first search may take longer but can never return a partial corpus.

### Lifecycle and recovery

`SearchService` reports `initializing`, `ready`, `disabled`, or `closed`. The service becomes ready without starting a worker. A search request starts the worker and waits for its ordered request queue; an unavailable or degraded worker yields the existing `search-unavailable` 503 response instead of incomplete results.

The worker is disposable derived-state machinery:

1. It opens the mirror and removes legacy cache files.
2. It compares metadata with the current engine and content-policy versions. A mismatch schedules a source rebuild from the authoritative goal, session, staff, and transcript sources.
3. On worker error or exit, outstanding RPCs fail, restart attempts use bounded exponential backoff, and mutations that may not have reached durable storage mark the service degraded.
4. A degraded service rejects search explicitly and schedules an authoritative rebuild. It returns to normal only after a rebuild succeeds without another dirty generation.

Search mutations are fire-and-forget from request, message, and WebSocket paths. Per-session message chains preserve operation order, while shutdown is the one lifecycle boundary that waits for queued mutations before asking the worker to flush and terminate.

### Backpressure

Both sides bound the worker queue to 1,024 RPCs or 16 MiB of estimated payloads. The gateway uses allocation-free structural accounting rather than serializing an arbitrary message just to measure it. A saturated mutation queue marks search degraded and schedules recovery; it never blocks a message handler. A saturated query/RPC queue returns an explicit unavailable result.

These bounds intentionally prefer a recoverable rebuild to an unbounded in-memory backlog. Search is derived; session messages and their durable transcripts are not.

## Mirror-only persistence

`search.flex/index/` contains the durable search mirror:

- `__docs__.json` is an atomic compact snapshot of prepared documents.
- `__docs__.journal` is an append-only newline-delimited mutation journal.
- `meta.json` describes engine and content-policy compatibility.

A mutation appends a small journal record after a trailing debounce. When the journal reaches its size threshold, an explicit compact is requested, or graceful close needs it, the worker writes a fresh snapshot through a sibling `.tmp` file and atomic rename, then clears the journal through the same serialization lane. If an append fails, its records are restored to the in-memory journal before retry; they are not silently dropped. In-memory `parent_id` maps track chunk hashes and child IDs, so deduplication and parent cleanup do not scan the full mirror on every entry.

The FlexSearch posting-list export is not persisted. It is cache data rebuilt lazily from the compact mirror, so a frequent write no longer serializes or hashes the entire search corpus. The mirror is compact enough to make a cold rebuild practical; rebuilding directly from all session JSONL transcripts is intentionally not the normal query-time recovery path.

### Migration and crash recovery

Existing FlexSearch export bundles, per-key export files, and interrupted export temporary files are disposable. When the worker next opens a project, it keeps the snapshot and journal, removes legacy cache artifacts, and rebuilds the in-memory index when needed. It also removes obsolete `search.lance` and native database artifacts in the worker rather than on the gateway event loop.

Do not manually delete `__docs__.json` or `__docs__.journal` to reclaim space. If the mirror is missing or corrupt, use **Settings → Maintenance → Search Index → Rebuild Index**; the rebuild reads authoritative project stores and session transcripts. A corrupt journal record is ignored individually so valid preceding and following records remain recoverable. A corrupt/missing snapshot takes the same explicit rebuild path.

## Index tuning and quality trade-off

The current index keeps prefix matching for titles but uses strict tokenization at low resolution for message/body text and disables FlexSearch's duplicate document store. `identifier_text` remains strict so exact symbols and decomposed camelCase, snake_case, kebab-case, dotted-path, and file-path terms continue to work.

The change trades broad body-prefix matching for lower memory and build cost. A query for an incomplete body-word prefix is less likely to match; complete keywords, title prefixes, and identifier searches retain their intended behavior. Evaluate a tuning change against representative natural-language, title-prefix, and symbol/path queries before changing tokenization or resolution, and bump the compatibility metadata when persisted ranking/display semantics change.

Measured against a 6,009-document real mirror during the incident investigation:

| Measurement | Previous export-oriented settings | Tuned mirror-only baseline |
|---|---:|---:|
| Full in-memory rebuild | 1,914 ms | 798 ms |
| Export + JSON serialization | 430 ms + 508 ms | 148 ms + 80 ms |
| Serialized export | 151 MB (about 25.1 KB/doc) | 68 MB (about 11.3 KB/doc) |

The current design removes that export from routine persistence altogether. These figures are a workload snapshot, not a capacity guarantee; use the diagnostics below when assessing a different corpus.

## JSON state-store persistence

Goal, gate, and task stores share `CoalescedJsonWriter`. Rapid mutations coalesce into one asynchronous compact JSON snapshot written through `.tmp` then rename. `flush()` is a durability barrier for shutdown/tests; strict lifecycle changes use `publishStrict()` on the same queue, so an older async rename cannot overtake a required publication. A failed barrier rejects rather than claiming success.

`SessionStore` has the same non-blocking/coalesced behavior while retaining stronger guarantees: its per-file write fence serializes competing store instances, verifies the epoch/fingerprint stale-snapshot guard, rotates backups oldest-first, fsyncs the temporary file when available, and atomically publishes the new epoch. Recovery-critical session fields enter this async writer immediately; high-frequency activity fields remain debounced. The write paths preserve ordering and failure semantics without re-parsing the entire session file on every save.

`ProjectContext.close()` drains these barriers before closing search or allowing a state directory to be removed.

## Diagnostics and session admission

The always-on event-loop-lag monitor samples `monitorEventLoopDelay` and attributes known synchronous operations recorded through `recordEventLoopOperation()`. It warns for material blocks with an operation label; persistence diagnostics additionally record serialization/write durations and bytes. Set `BOBBIT_CPU_DIAG=1` and optionally `BOBBIT_CPU_DIAG_JSONL=<path>` for detailed diagnostics. Search persistence metrics arriving from the worker are reported as `search:<label>:<phase>` and do not imply work on the gateway loop.

During boot, HTTP requests receive `503 Gateway starting` with `Retry-After: 1`. Valid session and viewer WebSocket upgrades receive a credential-free error frame before authentication:

```json
{ "type": "error", "code": "SERVER_STARTING", "message": "Gateway is starting. Retrying automatically…", "retryAfterMs": 1000 }
```

The protocol reserves `SERVER_SATURATED` for the same retry contract when admission can explicitly report temporary load; the client already treats both codes as retryable, shows a starting status, and uses bounded exponential retry with the server's retry hint. A real transport/auth failure still reports normally; increasing the generic 15-second connect timeout is not the fix for event-loop starvation.

## Troubleshooting

| Symptom | Check | Action |
|---|---|---|
| Search returns 503 with `backpressure`, `degraded`, or `worker-backoff` | Gateway logs for `[search]`, worker errors, and event-loop warnings | Let automatic recovery run; if it persists, inspect state-dir permissions and run Rebuild Index. Do not retry mutations synchronously. |
| First search after restart is slow | Search worker is building the derived index from the mirror | Wait for the request/progress to settle. It must not return partial results. |
| Search results appear stale after a crash | Inspect `search.flex/index/__docs__.json` and journal; check rebuild logs | Use Rebuild Index. Preserve the mirror until the rebuild completes. |
| Search files are unexpectedly large | Compare snapshot/journal size, not a legacy FlexSearch export | Stop the gateway cleanly, retain the mirror, and let migration delete cache exports. Investigate unbounded journal compaction failures. |
| Session opens show “Gateway is starting/busy” | Confirm the WebSocket error code and `[event-loop-lag]` records | The client retries automatically. Persistent saturation needs the labeled operation fixed; do not only raise the connect timeout. |
| Session opens still time out without readiness frames | Check process CPU, event-loop-lag warnings, and proxy/WebSocket routing | A timeout after the server-side fix is a separate transport or gateway-blocking problem; capture diagnostics and inspect the responsible label. |

See [WebSocket protocol](websocket-protocol.md#gateway-readiness-and-retry) and [Session connection issues](debugging.md#session-connection-issues) for the client-facing failure path.

## Verification coverage

The main-thread ownership regression test asserts that the `SearchService` dependency graph is an RPC client and cannot reach FlexSearch, document preparation, or sources; the worker must own that graph. Search administration coverage asserts the explicit busy-worker 503 response. Store coverage exercises mirror restart recovery and the `parent_id` hash lookup. Keep equivalent coverage when changing worker ownership, persistence, or admission behavior; a machine-dependent timeout alone is not a reliable regression test.
