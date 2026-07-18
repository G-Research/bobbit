# Session-loading performance

Session loading crosses the agent RPC transport, transcript assembly, session-list aggregation, per-project stores, and boot restoration. These paths were optimized together because a fast UI request still feels slow if the gateway is blocked framing output, scanning archives, writing state, or restoring processes.

This document describes the implemented runtime contract. See the [implementation design](design/session-loading-performance.md) for the original change plan and the [benchmark report](design/session-loading-performance-benchmarks.md) for measurement details.

## Behavior-preserving contract

The optimizations remove repeated work; they do not reduce the work required for correctness.

- The UI, REST and WebSocket schemas, session status and ordering, loading states, controls, and interaction flows are unchanged.
- Transcript content and history are not omitted, truncated, paginated, streamed, or compacted by this work.
- Boot still eagerly restores the same ordered set: regular sessions followed by surviving delegates. Every candidate is attempted before boot completes.
- There is no top-N or recency-based restore limit, dormant-session deferral, lazy boot revival, or attach-time revival.
- Default and archived session-list filters, offset/cursor pagination, totals, generations, and response envelopes are unchanged.
- Existing persistence formats and stale-state protections remain authoritative. The changes do not introduce a general store migration or a concurrent-writer merge protocol.
- No optimization adds implicit Git publication or changes worktree lifecycle.

The common design rule is conservative reuse: skip work only when a monotonic sequence, mutation generation, or verified disk fingerprint proves that the relevant input is unchanged. Otherwise, run the existing path.

## Runtime architecture

| Area | Runtime owner | Optimization |
|---|---|---|
| Agent JSONL transport | `RpcBridge` in the agent RPC module | Scan only newly decoded chunks for line boundaries. |
| Live transcript snapshots | `SessionManager` and the WebSocket handler | Memoize only the sequence-stable RPC snapshot base. |
| Session-list archive expansion | Archived-session BFS helper and the sessions REST route | Index relationships once, then walk reachable rows in stable BFS order. |
| Cost and session metadata | `CostTracker`, `SessionStore`, and project-context shutdown | Coalesce cost writes, compact session JSON, and avoid proven-redundant epoch reads. |
| Boot discovery and restoration | Orphan-cleanup and session-manager restore paths | Bound asynchronous filesystem work and adapt restore concurrency to event-loop lag. |
| Cost/task hydration | `TaskStore`, `ProjectContextManager`, and `SessionManager` | Cache session-to-task lookup behind a topology-aware generation token. |

These are internal optimizations. They add no operator-facing tuning settings and no new client contract.

## Incremental RPC JSONL framing

Agent stdout remains decoded by a persistent `StringDecoder`, which owns UTF-8 boundaries. `RpcBridge.handleData()` then searches only the newly decoded chunk for `\n` rather than appending the chunk and splitting the complete accumulated buffer each time.

A newline-free line arriving in many chunks previously caused the growing prefix to be searched repeatedly. The incremental scanner retains that prefix without rescanning it, joins it to the completing segment once, and processes complete lines in arrival order. This makes boundary scanning linear in received input size while preserving the following behavior:

- a partial line is retained until a newline arrives;
- packed lines and lines split at any chunk or multibyte boundary remain lossless and ordered;
- one trailing `\r` is removed before the existing trim and JSON parse;
- blank and non-JSON lines remain ignored;
- matching response frames resolve pending requests; other frames are normalized and delivered to event listeners in their existing order;
- no valid-line size cap is introduced; and
- listener/response exceptions propagate as before. Buffer state is advanced before dispatch so a thrown listener does not cause already-consumed complete lines to be replayed.

This optimization affects framing complexity, not transcript size or JSON parse cost.

## Transcript snapshot memoization

`SessionInfo` holds a transient snapshot slot containing `{ seq, promise }`. `SessionManager.getMessagesSnapshotBase()` keys the slot by the session event buffer's monotonic `lastSeq`.

### Shared work and invalidation

- The promise is installed before it is awaited, so concurrent requests at the same sequence share one agent `getMessages()` RPC and normalization pass.
- An unchanged sequence reuses the normalized base.
- Any later agent event advances the event sequence and causes the next request to install a new-sequence promise. This is conservative: events may cause a miss even when transcript bytes did not change, but they cannot leave a transcript-changing event behind a stale key.
- A respawn or replacement creates a new `SessionInfo`, so it starts with no cached base.
- A rejected RPC or `{ success: false }` response clears its slot and is retried by the next request. An older completion clears only the promise it owns, so it cannot remove a newer-sequence slot.

### Deliberate cache boundary

Only the agent RPC result plus legacy tool-result error normalization is memoized. Callers treat that base as immutable and make fresh copies before applying mutable response work. Each memo-consuming `get_messages` response and post-`restart_agent` refresh still recomputes:

1. the in-flight assistant-message overlay;
2. in-flight steer overlays;
3. compaction sidecar merges;
4. large tool-content display truncation;
5. skill and file-mention sidecar merges;
6. snapshot ordering stamps; and
7. response timing and serialization.

Sidecar or overlay changes therefore appear on a cache hit without changing the base sequence. Keeping this boundary narrow is why repeated snapshots improve without freezing transient UI state or contaminating later callers with a previous transform.

## Indexed archived-session traversal

The default sessions response includes archived descendants reachable from live session and live goal seeds. A row may be related through `delegateOf`, `parentSessionId`, `teamLeadSessionId`, `teamGoalId`, or `goalId`.

The indexed traversal makes one ordered pass over raw archived rows and places each row in a bucket for every distinct, non-empty relationship value. It then performs BFS with an array and numeric cursor. This avoids a complete archive scan for every reachable node and avoids repeated `shift()` costs. Clone/color/status enrichment occurs only when a row is reachable; explicit full-archive responses still clone the rows they return.

Ordering and corruption-tolerance contracts remain:

- seed order is unchanged;
- archived source order is preserved within each relationship bucket;
- children are emitted in stable BFS order;
- each session id is emitted once, cycles terminate, and duplicate seeds or equal relationship fields do not duplicate output;
- the first reachable legacy row wins when corrupt data repeats an id; and
- unreachable archived rows are neither returned as descendants nor cloned for descendant enrichment.

The sessions route still owns filtering, default versus `include=archived` behavior, stable archived ordering, generation/change responses, totals, limits, offsets, cursors, and all existing envelope fields.

## Persistence behavior and trade-offs

### Cost telemetry

`CostTracker.recordUsage()` updates and returns cumulative in-memory totals synchronously, but schedules persistence with a one-second trailing debounce. A later usage update restarts the deadline, allowing a burst to become one full `session-costs.json` write. Removal and successful legacy goal-id backfill are structural changes: they cancel a pending timer and save the complete current map immediately.

`flush()` is idempotent, cancels the timer, and writes dirty state immediately. Both session-manager shutdown and project-context close call it, so the normal graceful gateway shutdown path persists the pending tail before contexts disappear. The timer is unreferenced and cannot keep the process alive. A failed save remains dirty, allowing a later mutation or flush to retry.

**Crash trade-off:** a forced process kill, OOM, power loss, or other exit that bypasses graceful shutdown can lose the pending cost burst since the last successful save. Because this is a trailing debounce and each usage update restarts it, a continuously active burst can span longer than one second. Cost data is telemetry; session transcripts and metadata do not use this debounce.

See [Session cost display](session-cost.md) for the cost data model.

### Session metadata store

`SessionStore` writes the existing version-2 payload as compact JSON. This changes whitespace only: old pretty-printed files still load, and session field shape, array order, epochs, backups, critical synchronous flushes, temp-file fsync/rename, and corrupt-primary recovery are unchanged.

A disk fingerprint reduces redundant reads after a successful write by this process:

1. the first write after load always reads and parses the on-disk epoch;
2. after this process successfully renames a new primary file, it records size, modification time, and creation/change time when available;
3. if those values are unchanged on a later save, the store reuses its known epoch rather than reading the same primary again; and
4. a missing, changed, invalid, or unreadable fingerprint falls back to the full epoch read and existing stale-snapshot logic.

The fingerprint is refreshed only after a successful atomic replacement. It is an optimization hint, not a durability authority. In particular, the first-write newer-epoch guard still latches and refuses to overwrite a snapshot newer than the one loaded by this store.

This does **not** add locking or record merging between gateways. Operate one gateway against a given state directory. Atomic replacement protects a single writer from torn primary files; it does not make simultaneous gateways a supported multi-writer topology. Before this process's first write, a newer external epoch triggers the latched stale-snapshot refusal. After this process has already written, a detected external rewrite forces epoch revalidation and advances from the observed epoch, but the existing contract does not merge the external records; the current in-memory session array can replace them.

## Boot-time discovery and eager restoration

### Bounded asynchronous orphan scan

After restoration and existing recovery work, the gateway still scans the agent sessions tree for untracked `*.jsonl` transcripts so it can report metadata/transcript divergence. The scanner now uses asynchronous directory reads and file stats through one bounded worker pool, with a numeric work-queue cursor.

The scan remains observational: it does not import, delete, archive, or mutate sessions. It preserves tracked-path exclusion, the last-activity threshold, the total qualifying count, the path sample cap, the warning cap, missing-root behavior, and per-entry I/O error tolerance. Its default concurrency is eight. The capped sample and warning order may differ because asynchronous completion and filesystem enumeration order are not API contracts.

Boot still awaits the complete scan. The change prevents a large synchronous walk from monopolizing the event loop; it does not defer the scan until after startup.

### Event-loop-lag-aware restore batches

The restore loop samples a restore-scoped `monitorEventLoopDelay()` histogram. Healthy conditions use the existing nominal concurrency of five. As lag rises, batch width falls toward one; high lag also adds a bounded yield so HTTP, WebSocket, and timer work can run. The monitor is reset between samples and disabled when restoration exits, including on failure.

Lag changes only concurrency and the inter-batch yield. The candidate list remains exactly `regular + delegateSurvivors` in its existing order. The cursor advances by the actual batch length, every candidate is attempted once, per-session failures remain isolated, and `restoreSessions()` does not resolve until all eager attempts and the existing post-restore work complete. There is no deferred attach path to finish restoration later.

## Generation-safe session-to-task lookup

Reconnect cost hydration and streaming cost updates need the task currently assigned to a session. Repeatedly scanning every project task store is avoidable only if assignment and project-topology changes invalidate cached answers.

- Each `TaskStore` increments its local mutation generation after `put`, `remove`, and non-empty `removeMany` paths. Loading persisted rows starts at generation zero.
- `ProjectContextManager` observes the aggregate task generations plus a separate context-topology version. It translates changes into a monotonic process-local token, so removing or re-adding a context cannot collide with an older raw generation sum.
- `SessionManager` caches `{ generationToken, taskId | undefined }` per session. Cached absence is intentional and invalidates by the same token as cached presence.
- A task id stamped on session metadata is only a hint. It is accepted only if the current task store still reports that task assigned to the session; otherwise current stores are scanned in their existing order.
- Session replacement, termination, unregister, and shutdown remove cache entries.

Assignment, reassignment, deletion, context addition, context removal, and same-id context replacement are therefore visible on the next lookup without serving stale task attribution.

## Verification and I/O boundary ownership

The tests follow the [canonical unit I/O boundary audit](testing-v2/io-boundary-audit/index.md): deterministic policy belongs behind injected seams, while operating-system and restart facts retain real owners.

- **Core tests** own framing equivalence and linear search complexity, snapshot promise/invalidation semantics, BFS ordering and clone counts, debounce/failure policy, compact serialization and stale-epoch decisions, bounded scan scheduling, lag-to-batch mapping, and task-generation invalidation. Filesystem-dependent policy uses the injected `FsLike`/memfs boundary; lag, clocks, and snapshot collaborators are injected rather than using real waits or global state.
- **Integration tests** retain route-envelope coverage and real filesystem canaries. Real-FS owners prove session and cost bytes are visible to a fresh reader, successful temp-file replacement leaves no temporary file, backup recovery works after corrupting the primary, external metadata changes force epoch revalidation, and recursive transcript traversal observes real directories and mtimes.
- **API E2E** uses the real gateway with the mock agent to prove concurrent snapshots, transcript invalidation, archived offset/cursor contracts, task reassignment, graceful cost-tail persistence, unchanged history after restart, and eager restoration of regular plus delegate-survivor sessions before the first post-boot request.

Do not move real rename, backup, fresh-reader, recursive-stat/mtime, gateway-restart, or process-lifecycle claims into memfs-only tests. Conversely, core policy tests should not create real temporary trees, sleep through debounce windows, or spawn an agent merely to exercise deterministic decisions.

## Benchmark results

The reproducible dimensions, raw samples, identity hashes, revisions, and caveats are recorded in [Session-loading performance benchmarks](design/session-loading-performance-benchmarks.md). On the measured Windows/Node environment, the isolated median results were:

| Hot path | Baseline | Candidate | Median improvement |
|---|---:|---:|---:|
| Archived preparation and BFS over 10,000 rows | 25.204 ms | 1.500 ms | 16.80× |
| 20 same-sequence snapshots over 100,000 messages | 52.537 ms | 2.548 ms | 20.62× |
| One 16 MiB JSONL line in 64 KiB chunks | 455.628 ms | 17.964 ms | 25.36× |

The candidate produced the same hashed ordered descendants, normalized snapshot, and parsed RPC event as the baseline. The snapshot case reduced 20 RPC calls to one, and the RPC instrumentation measured 127.50× fewer searched characters.

These are source-equivalent microbenchmarks, not end-to-end UI latency. They exclude transport, browser rendering, process startup, and most filesystem work. Treat the results as algorithmic evidence, not a production latency guarantee.

## Known limitation: very large first-open transcripts

Legacy transcripts around 20–24 MB can still be slow on first open. The gateway must assemble and normalize the full history, transfer it, and the client must parse and render it before any same-sequence cache exists.

This work intentionally does not stream, paginate, omit, auto-compact, truncate, or lazily render that history. It improves incremental RPC framing and unchanged-sequence repeat loads, but the first full load remains an explicit limitation rather than a changed UX contract.
