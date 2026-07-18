# Session-loading performance

Status: proposed design for the **Speed Up Session Loading** goal.

## 1. Purpose and scope

Session loading currently pays avoidable main-thread and filesystem costs in several independent places: JSONL framing in `RpcBridge`, repeated transcript snapshots, archived-child discovery on `GET /api/sessions`, cost/session persistence, boot-time transcript discovery, boot restoration, and repeated session-to-task lookup. This design ports only the behavior-preserving parts of `bobbit-perf-fixes.patch` and `bobbit-perf-fixes.md` onto current `origin/master`.

The changes are deliberately narrower than the aggregate patch:

- no lazy boot revival, attach-time revival, top-N restoration, recency sorting, or restoration cap;
- no change to which sessions restore, their ordering, status, loading state, controls, or interaction flow;
- no general `DurableStore` migration, persistence-format migration, LRU eviction, search-index work, cookie work, or unrelated reliability changes;
- no API or WebSocket wire-format change;
- no transcript truncation, omission, or compaction-policy change;
- no implicit Git push or fork/air-gapped configuration.

The optimizations are separable and should land in small commits. Their shared rule is: cache or skip work only behind an existing monotonic/fingerprint invariant; otherwise execute the current path.

## 2. Current data flow and bottlenecks

### 2.1 Live transcript snapshot

A live client sends WebSocket `get_messages` to `src/server/ws/handler.ts`. The handler currently calls `session.rpcClient.getMessages()`, normalizes the result, overlays the in-flight assistant message and steers, merges compaction and skill sidecars, truncates oversized tool display content, stamps snapshot order, and sends the existing `messages` frame. A restart refresh repeats a nearly identical pipeline.

Every request therefore repeats the agent RPC and full transcript parse even when `session.eventBuffer.lastSeq` has not changed. Multiple tabs requesting simultaneously duplicate the same work.

### 2.2 Session list

`GET /api/sessions` in `src/server/server.ts` collects live sessions and walks archived descendants reachable through any of:

- `delegateOf`;
- `parentSessionId`;
- `teamLeadSessionId`;
- `teamGoalId`;
- `goalId`.

The local `bfsEnrichArchived()` uses `Array.shift()` and scans the complete archived pool for every dequeued id. Callers also clone and color-enrich every archived row before knowing whether it is reachable. The default sidebar request thus scales with total archive size rather than the usually small reachable subgraph.

### 2.3 Persistence

`CostTracker.recordUsage()` synchronously serializes and writes the entire `session-costs.json` object on each assistant `message_end`.

`SessionStore.saveNow()` preserves important v2 epoch, backup, atomic-temp-write, and stale-snapshot behavior, but currently:

1. reads and parses all of `sessions.json` merely to obtain `epoch` on every save;
2. pretty-prints the complete payload;
3. performs the remaining backup/write/fsync/rename work synchronously.

This goal changes only the first two low-risk costs. Recovery-critical synchronous session writes and the existing stale-snapshot refusal contract remain intact.

### 2.4 Boot restoration

`SessionManager.restoreSessions()` builds the existing live restoration set as `regular + delegateSurvivors`, then restores it in fixed batches of five. Each restore can spawn a process and replay a transcript. Fixed concurrency can compound event-loop lag on a busy or slow host.

After restoration, the same method calls synchronous `scanOrphanedTranscripts()` in `src/server/agent/orphan-cleanup.ts`, recursively running `readdirSync` and `statSync` over the agent sessions tree before boot completes.

### 2.5 Cost-to-task hydration

Both streaming cost updates and reconnect hydration need a task id. `SessionManager.trackCostFromEvent()` and `resolveTaskIdForSession()` can scan every project task store on every assistant message. Current `TaskStore` has no mutation generation, so a cached answer cannot be safely invalidated after assignment, reassignment, deletion, or project-context topology changes.

## 3. Proposed design

## 3.1 Incremental RPC JSONL scanning

**Files/functions**

- `src/server/agent/rpc-bridge.ts`
  - `RpcBridge.handleData()`
  - new private `RpcBridge.processLine()`

`stdoutDecoder` remains the UTF-8 boundary owner. `handleData(data)` will scan only the newly decoded `data` string:

```ts
let start = 0;
while ((newline = data.indexOf("\n", start)) !== -1) {
  const segment = data.slice(start, newline);
  const line = lineBuffer ? lineBuffer + segment : segment;
  lineBuffer = "";
  start = newline + 1;
  processLine(line);
}
if (start < data.length) lineBuffer += data.slice(start);
```

`processLine()` contains the current per-line behavior unchanged: remove one trailing `\r`, trim, ignore empty/non-JSON lines, resolve a matching pending response, otherwise normalize and emit the event to listeners.

### Why this is linear

The current `lineBuffer += data; lineBuffer.split("\n")` scans the complete accumulated fragment for every chunk. A large newline-free line arriving in `K` chunks performs approximately `1 + 2 + … + K` chunk-length scans. The new code searches only the current chunk. `lineBuffer` is concatenated with the completing segment once, when a newline is finally observed, so flattening a large line is paid once.

### Invariants and errors

- Lines, ordering, response-vs-event dispatch, listener order, trimming, and non-JSON skipping remain identical.
- Multiple complete lines in one chunk are processed in order.
- A line split over any number of chunks is processed exactly once after its newline.
- A trailing incomplete fragment is retained and is not processed early.
- Empty chunks and consecutive newlines remain no-ops.
- UTF-8 split handling remains in `StringDecoder`; `handleData` still receives complete decoded characters.
- Exceptions from downstream response/listener behavior retain the existing propagation behavior. JSON parse failure remains silently skipped.
- No maximum-line cap is introduced because it would change valid transcript behavior.

## 3.2 Per-session transcript snapshot memo

**Files/functions**

- `src/server/agent/session-manager.ts`
  - `SessionInfo.messagesSnapshotCache`
  - new `SessionManager.getMessagesSnapshotBase(session)`
- `src/server/ws/handler.ts`
  - live `case "get_messages"`
  - post-`restart_agent` refresh

Each live `SessionInfo` receives an optional transient cache:

```ts
{ seq: number; promise: Promise<RpcSnapshotResponse> }
```

`getMessagesSnapshotBase()` captures `session.eventBuffer.lastSeq`. If a cache entry has the same sequence, it returns the same promise. Otherwise it immediately installs a promise that runs `rpcClient.getMessages()` and `normalizeToolResultErrorSnapshot()`.

Installing the promise before awaiting coalesces concurrent calls at the same sequence. A `{ success: false }` result or a rejected promise clears the cache only if it still owns the cache slot; a newer-sequence request cannot be cleared by an older completion. Failures are therefore retried on the next request at the same sequence.

### Cache boundary

Only the RPC response plus error normalization is memoized. Every response, hit or miss, must freshly execute the current mutable overlay pipeline:

1. `spliceInFlightMessage()`;
2. `spliceInFlightSteers()`;
3. `mergeCompactionSidecarIntoMessages()`;
4. `truncateLargeToolContentInMessages()`;
5. `mergeSkillSidecarIntoMessages()`;
6. `stampSnapshotOrder()`;
7. existing serialization/timing and `messages` send.

The cached base is treated as immutable. If any existing transform mutates its input, the handler must copy the top-level response and message array before that transform. This prevents one caller's live overlay from contaminating the next caller's base.

### Invalidation proof

`emitSessionEvent()` is the single live agent-event path and always increments `eventBuffer.lastSeq`. Agent events that change the runtime transcript therefore invalidate by key mismatch. An event arriving while a sequence-S fetch is pending causes the next request to use sequence S+1 and start a new fetch; the S promise may finish for its original caller but cannot replace the S+1 slot.

A restore/respawn constructs a new `SessionInfo`, so its cache starts empty even if the reseeded `EventBuffer` reuses a numeric high-water mark. Sidecar and in-flight overlay changes do not need to invalidate the base because they are intentionally recomputed on every response. Implementation review must audit transcript-changing paths and route them through `emitSessionEvent`; any exceptional path that changes the agent transcript without an event must explicitly clear `messagesSnapshotCache`.

### Response contract

The `messages` frame, contents, ordering, truncation behavior, sidecar content, server timing fields, and errors remain unchanged. A same-sequence hit must serialize byte-identically to the base produced by the original fetch before freshly computed overlays are applied.

## 3.3 Indexed archived-session BFS

**Files/functions**

- new `src/server/agent/archived-session-bfs.ts`
  - `ArchivedBfsSession`
  - `bfsEnrichArchivedIndexed()`
  - reference `bfsEnrichArchivedNaive()` exported only for equivalence tests
- `src/server/server.ts`
  - remove local `bfsEnrichArchived()`
  - update all `GET /api/sessions` archived-descendant call sites

The helper makes one pass over archived rows in their existing context/store iteration order and builds `Map<parentKey, session[]>`. A row is indexed under each distinct, non-empty relationship value. Per-row key deduplication prevents a row with two equal relationship values from appearing twice in one bucket.

Traversal uses the existing seed order and a queue with a numeric head cursor rather than `shift()`:

```ts
const queue = [...seedIds];
for (let head = 0; head < queue.length; head++) {
  for (const child of byParent.get(queue[head]) ?? []) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    result.push(clone(child));
    queue.push(child.id);
  }
}
```

The route supplies raw archived records, not pre-cloned records, and a clone callback that adds the current `colorIndex`, `archived`, or `status` enrichment only when a row becomes reachable. Routes that explicitly return the full archive (`include=archived`) still clone the rows they return; only the descendant enrichment stops cloning unreachable rows.

### Equivalence invariants

- Seed order is unchanged: live session ids followed by live goal ids, as today.
- Archived source iteration order is unchanged: visible contexts in existing order, then each store's `getArchived()` order.
- Each id appears at most once; the first reachable record in legacy order wins for duplicate/corrupt ids.
- Children discovered for a parent retain archived source order.
- Cycles terminate through `seen`.
- A session linked through multiple parent fields is emitted at the same earliest BFS point as the naive OR predicate.
- Returned set and stable order match the current implementation.
- Default and `include=archived` response envelopes, `generation`, `changed`, filters, `total`, `limit`, `offset`, `hasMore`, `nextOffset`, `nextCursor`, `sessions`, and `archivedDelegates` remain unchanged.

Complexity becomes O(N + R + E) for N archived rows, R reachable rows, and indexed relationship edges, rather than O(R×N) plus O(R²) queue shifting. Cloning/color lookup becomes O(R) for descendant enrichment.

## 3.4 Persistence changes

### 3.4.1 CostTracker debounce and shutdown flush

**Files/functions**

- `src/server/agent/cost-tracker.ts`
  - split current `save()` into `saveNow()` and `scheduleSave()`
  - add `SAVE_DEBOUNCE_MS` (1,000 ms), timer/dirty state, and public `flush()`
  - `recordUsage()`, `removeSession()`, `backfillGoalIds()`
- `src/server/agent/session-manager.ts`
  - `shutdown()` flushes every context cost tracker and the non-PCM test tracker
- `src/server/agent/project-context.ts`
  - `close()` also calls `costTracker.flush()` as the direct context-lifecycle backstop

`recordUsage()` continues to mutate totals and return the cumulative derived snapshot synchronously, but schedules one trailing save instead of writing immediately. Repeated records inside the window coalesce.

Rare structural/migration operations (`removeSession`, successful `backfillGoalIds`) cancel the timer and write the current complete map immediately, so a pending older snapshot cannot run afterward. `flush()` cancels any timer and writes dirty state immediately; it is idempotent. The real timer should be `unref()`'d so it cannot keep the gateway alive.

The on-disk cost shape and field coercion remain unchanged. Save errors remain logged and non-throwing. Dirty state is retained after failure so a later mutation or graceful `flush()` retries; a stale timer must never clear a newer dirty generation.

**Crash-window honesty:** an ungraceful kill/OOM can lose at most the final debounce window of cost telemetry. This is an explicit trade-off for removing per-message full-store writes. Graceful SIGINT/SIGTERM follows `gateway.shutdown()`, and both `SessionManager.shutdown()` and `ProjectContext.close()` force the tail to disk before contexts disappear.

### 3.4.2 Compact session-store JSON

**File/function**

- `src/server/agent/session-store.ts` — `SessionStore.saveNow()`

Serialize the existing v2 object with `JSON.stringify(payload)`, not `JSON.stringify(payload, null, 2)`. This changes whitespace only. `version`, `epoch`, session array order, fields, load compatibility, backup fallback, recovery-critical flushes, temp-file fsync, rename, and generation behavior are unchanged. Old pretty files continue to parse and become compact on the next save.

### 3.4.3 Avoid safe redundant session-store read/parse

Add a private disk fingerprint (`size`, `mtimeMs`, and `ctimeMs` where available) captured after load and every successful rename. Before `saveNow()`:

- the first write after load still performs the existing full `peekDiskEpoch()` read/parse;
- after this process has successfully written, if the current fingerprint exactly equals the last observed fingerprint, use the in-memory `max(loadedEpoch, writtenEpoch)` instead of re-reading/parsing the same file;
- if the fingerprint is absent or differs, run the existing `peekDiskEpoch()` and stale-snapshot logic unchanged;
- refresh the fingerprint only after a successful rename; never advance it on write/refusal failure.

This is a fast path, not a new authority. Any sign of another writer, cloud-sync replacement, manual restore, corruption, missing file, or stat error falls back to the current full validation. The stale-snapshot latch remains process-lifetime and still refuses the first load-then-clobber attempt when disk epoch exceeds `loadedEpoch`. The fingerprint must not bypass the first-write guard, and no lock, merge policy, tombstone policy, backup cadence, or epoch semantics are changed in this goal.

### Multi-writer/stale-snapshot safety tests

Tests must use two store instances or an injected filesystem rewrite to prove:

1. unchanged post-write fingerprint skips the redundant full file read;
2. an external rewrite changes the fingerprint and forces a full parse;
3. a higher epoch appearing before this instance's first write still trips the existing guard and is not overwritten;
4. parse/stat failure takes the conservative path and never authorizes a blind overwrite;
5. compact output reloads with identical sessions/epoch and atomic backup fallback still works;
6. recovery-critical fields remain immediate while non-critical debounce behavior remains unchanged.

## 3.5 Async bounded orphan-transcript scan

**Files/functions**

- `src/server/agent/orphan-cleanup.ts`
  - new `scanOrphanedTranscriptsAsync()`
  - retain the synchronous reference helper for direct parity tests if useful
- `src/server/agent/session-manager.ts`
  - `restoreSessions()` awaits the async helper at the existing post-restore call site

The async scanner uses `fs.promises.readdir(..., { withFileTypes: true })` and `fs.promises.stat()` with a bounded worker pool (default eight). Directory work and file-stat batches are bounded; no recursive synchronous call can monopolize the event loop. A numeric queue cursor should be preferred over `shift()` for wide trees.

Behavior stays the same:

- missing/non-directory root returns `{ count: 0, paths: [] }`;
- recursively inspect only regular `*.jsonl` files;
- exclude exact tracked paths;
- require `mtimeMs >= mostRecentLastActivity` as today;
- count every qualifying orphan;
- retain path cap 50 and warning cap 20 by default;
- swallow per-directory/per-file I/O failures and return the successfully collected result;
- do not import, delete, archive, or mutate sessions.

Because async completion order can differ and filesystem directory order is already platform-dependent, the capped path sample/log order is not an API contract. The qualifying set, total count, thresholds, caps, health field, and banner behavior are equivalent.

## 3.6 Event-loop-lag-aware eager restoration

**File/functions**

- `src/server/agent/session-manager.ts`
  - optional injected `bootRestoreLagSampler` test seam in `SessionManagerOptions`
  - private lag monitor/sampler helpers
  - private `concurrencyForBootLag()`
  - `restoreSessions()` batch loop

Use `node:perf_hooks.monitorEventLoopDelay()` during the restoration loop (or an injected sampler in tests). Preserve nominal concurrency five and floor one. Suggested initial watermarks are 50 ms (healthy) and 200 ms (high lag):

- lag <= 50 ms: batch size 5;
- lag >= 200 ms: batch size 1 and a short timer yield before the next batch;
- between them: clamp a linear interpolation to integers 1–5.

Use an explicit `cursor` advanced by `batch.length`, not a loop increment tied to a mutable concurrency variable. Yield at least a zero-delay turn between completed batches; under high lag use a small bounded backoff (for example 25 ms) so HTTP/WS/timer work can drain. Enable/reset the histogram immediately before the loop and disable it in `finally`.

### Non-negotiable eager-set invariant

The input remains exactly today's `liveRestore = [...regular, ...delegateSurvivors]`, in exactly that order. Every element is passed to `restoreOneSession()` exactly once before `restoreSessions()` resolves, regardless of sampled lag. Lag changes only simultaneous batch width and inter-batch yield.

The implementation must not copy the aggregate patch's `_shouldDeferToDormantOnBoot`, recent-window sorting, eager cap, attach revival, or any environment knob that changes membership. Worktree recovery, OrchestrationCore rebuilding/reminders, orphan transcript scanning, and boot completion still wait for all current-master live sessions to finish their eager restoration attempts.

## 3.7 Generation-invalidated session-to-task cache

**Files/functions**

- `src/server/agent/task-store.ts`
  - mutation `generation`
  - `getGeneration()`
- `src/server/agent/project-context-manager.ts`
  - context topology version
  - monotonic `getTaskGeneration()` token
- `src/server/agent/session-manager.ts`
  - `taskIdCache`
  - `resolveTaskIdForSession()`
  - `trackCostFromEvent()` uses the shared resolver
  - lifecycle cleanup of cache entries

`TaskStore` increments generation on every successful mutation path: `put`, `remove`, and `removeMany`. Assignment/reassignment flows route through these mutations. Load does not increment.

`ProjectContextManager.getTaskGeneration()` cannot safely return only the sum of task generations: removing/re-adding contexts can revisit a sum, and a new context can load persisted tasks at generation zero. Maintain:

- `contextTopologyVersion`, incremented whenever a context is created or removed;
- last observed task-generation sum and topology version;
- a monotonic process-local token incremented whenever either observed value changes.

`SessionManager` caches `{ gen, taskId | undefined }` per session. On a matching token it returns the cached answer, including cached absence. On mismatch:

1. obtain the live/persisted stamped task id, if any;
2. verify through task-store lookup that the task still has `assignedSessionId === sessionId`;
3. if not verified, scan current task stores for the first task assigned to the session using the current ordering;
4. cache the result under the new token.

A stamped id is an optimization hint, never an unconditional return: otherwise reassignment would serve stale attribution. Task mutations and project topology changes invalidate before the next cost/reconnect hydration. Cache entries are removed when a session is unregistered, terminated, replaced during respawn, or discarded during shutdown, bounding memory and avoiding cross-generation objects. The non-PCM test fallback preserves current behavior.

## 4. File/change matrix

| File | Intended change |
|---|---|
| `src/server/agent/rpc-bridge.ts` | Incremental current-chunk newline scan; extracted unchanged line processing. |
| `src/server/agent/session-manager.ts` | Snapshot base memo, shared task resolver/cache, adaptive eager restore batches, async orphan scan call, shutdown cost flush. |
| `src/server/ws/handler.ts` | Use memoized snapshot base in live and restart-refresh pipelines; always rerun overlays. |
| `src/server/agent/archived-session-bfs.ts` | Pure indexed BFS plus test reference implementation. |
| `src/server/server.ts` | Route archived descendant enrichment through raw indexed BFS; preserve envelopes/pagination. |
| `src/server/agent/cost-tracker.ts` | Debounced usage persistence, immediate structural writes, failure-safe dirty state, flush. |
| `src/server/agent/project-context.ts` | Cost flush in graceful context close. |
| `src/server/agent/session-store.ts` | Compact v2 serialization and conservative post-write fingerprint fast path. |
| `src/server/agent/orphan-cleanup.ts` | Bounded async traversal with existing scanner semantics. |
| `src/server/agent/task-store.ts` | Mutation generation. |
| `src/server/agent/project-context-manager.ts` | Topology-aware monotonic aggregate task token. |

No UI file is changed.

## 5. Focused verification plan

All new tests belong in `tests2/` and are registered in `tests2/tests-map.json`.

### 5.1 RPC framing

`tests2/core/rpc-bridge-line-buffer-correctness.test.ts`:

- one/many JSON lines in one chunk;
- a JSON line split at every representative boundary, including before/after `\r` and multibyte text;
- partial fragment retained until newline;
- empty lines and non-JSON lines skipped;
- response resolution and event listener order unchanged;
- final chunk ending exactly in newline leaves no phantom fragment.

`tests2/core/rpc-bridge-line-buffer-perf.test.ts` uses a synthetic multi-megabyte JSON line in fixed 64 KiB chunks. Instrument searched bytes or `indexOf` input lengths to assert O(total input) scanning rather than relying only on noisy wall time; retain a practical timing report for 1/4/16 MiB.

### 5.2 Snapshot memo

`tests2/core/session-manager-snapshot-memo.test.ts`:

- same-sequence result is byte-identical and invokes the RPC once;
- unchanged sequence remains cached across repeated calls;
- `eventBuffer.lastSeq` bump forces a fresh RPC;
- concurrent same-sequence callers share one pending promise;
- `{ success:false }` and rejection both retry on the next same-sequence call;
- an old failed promise cannot clear a newer-sequence slot;
- in-flight message/steer and sidecar changes appear freshly on cache hits;
- cached base is not mutated by response transforms;
- respawn/new `SessionInfo` starts uncached.

### 5.3 Archived BFS

`tests2/core/archived-session-bfs.test.ts` compares indexed output to the retained naive reference for:

- every relationship field;
- multiple seeds and multiple levels;
- cycles, duplicate seeds, duplicate relationship values, and duplicate ids;
- stable source/BFS ordering;
- unreachable archive rows;
- wide fan-out (proving cursor traversal and clone count equals reachable count only);
- randomized graphs for set/order equivalence.

A route-level test pins default, archived, project/query filter, offset, and cursor response envelopes.

### 5.4 Persistence

`tests2/core/cost-tracker.test.ts` or a focused companion:

- N `recordUsage` calls in one window cause one write and preserve exact totals;
- no write before deadline, one at deadline;
- `flush()` writes immediately and cancels the timer;
- structural removal/backfill supersedes the timer and cannot be undone by it;
- failed save remains dirty/retryable;
- graceful shutdown within the window persists the final totals.

Session-store focused tests:

- output is compact but v2-equivalent and reloadable;
- first save still reads the disk epoch;
- unchanged own fingerprint avoids later full read/parse;
- changed/missing/error fingerprint takes full validation;
- external higher epoch still refuses without overwrite;
- stale/multi-writer injection and backup fallback preserve current safety;
- recovery-critical update still flushes immediately.

### 5.5 Boot scan and restore

`tests2/core/orphan-cleanup-async-walk.test.ts` compares async and sync reference results for tracked/untracked, old/new, nested, missing root, I/O errors, caps, and concurrency 1/wide trees.

`tests2/core/session-manager-boot-restore-lag.test.ts` injects lag samples and a restore spy:

- low lag uses batches of five;
- high lag shrinks to one and yields;
- middle lag maps within bounds;
- changing lag changes only batch boundaries;
- every current-master restoration candidate is attempted exactly once, in input order;
- regular and surviving delegate sets are unchanged;
- failures remain isolated through current `restoreOneSession()` behavior;
- no dormant/attach revival path is introduced.

### 5.6 Task cache

`tests2/core/session-manager-taskid-cache.test.ts`:

- repeated message/reconnect hydration scans once at a stable generation;
- cached `undefined` invalidates when a task is assigned;
- stamped id is accepted only while assigned to that session;
- reassignment removes the stale id and finds the new assignment;
- task removal invalidates;
- adding/removing/re-adding a project context invalidates even when task-store generation is zero or sums collide;
- session lifecycle cleanup removes its cache entry.

Run focused files first, then:

```bash
npm run check
npm run test:unit
```

No timeout, retry, worker, or test-budget increase is permitted to obtain a pass.

## 6. API-only E2E journey

These are server-internal changes with no new visual behavior, so the end-to-end journey belongs in registered API E2E coverage rather than a browser UI journey.

1. **Seed and boot.** Start the real gateway harness with a temporary project, mock agent, several live sessions (including a delegate survivor), a large archived pool containing reachable chains/cycles and unreachable fan-out, task assignments, and cost data. Record the pre-restart live session ids and order.
2. **Session-list contracts.** Call `GET /api/sessions`, `GET /api/sessions?limit=…&offset=…`, and `GET /api/sessions?include=archived&limit=…&after=…` with project/query variants. Assert exact response keys, live order, archive page order, totals/cursors, reachable `archivedDelegates`, deduplication, and absence of unreachable descendants from enrichment.
3. **Snapshot/reconnect.** Open two authenticated session WebSockets and concurrently send `get_messages`. Assert identical complete history and existing message order. Send a prompt that produces a transcript event, request again, and assert the new turn is present exactly once. Exercise `restart_agent` and assert the refreshed complete history/sidecars are unchanged.
4. **Large RPC line.** Configure the mock agent to emit one large JSONL response/event line in many chunks. Assert the WebSocket receives the exact payload and the session remains responsive; this verifies framing through the real bridge path without changing the wire.
5. **Task/cost mutation.** Observe reconnect `cost_update`, reassign the task through the existing API/tool route, produce another assistant usage event, and assert the next cost update carries the current task id rather than the stamped old id.
6. **Graceful tail and eager restart.** Produce cost usage and request graceful gateway shutdown before the one-second debounce elapses. Restart on the same state. Assert the final cost persisted and every pre-restart current-master live session is present/restored without first attaching a client or sending a prompt. No session may appear only after attach.
7. **Post-restart parity.** Repeat session-list pagination and one full snapshot, asserting the same API/wire contracts and full history.

Cleanup terminates sessions and removes the temporary project/state. The journey must not inspect UI state or rely on a visual loading change.

## 7. Benchmark methodology

Record raw results and a short before/after table in the implementation gate notes. Use the same machine, Node version, dataset, build mode, mock-agent configuration, and commit-clean state for baseline (`origin/master`) and candidate. Record commit SHA, OS, CPU count, Node version, archive/session counts, transcript bytes/messages, and command line. Run at least five measured repetitions after one warm-up and report median plus p95/min/max; do not report only the best run.

### 7.1 `GET /api/sessions`

Seed a deterministic archive (for example 10,000 rows) with a small reachable chain and a wide reachable fan-out. Benchmark separately:

- default request;
- offset-paginated live request;
- `include=archived` cursor page.

Use one keep-alive client, verify a stable response hash/ordered id list on every run, and measure end-to-end latency plus gateway event-loop delay/CPU where available. Also instrument BFS clone count to demonstrate that default descendant enrichment clones R reachable rows, not N archived rows.

### 7.2 Repeated snapshot loading

Use a moderate synthetic transcript large enough to expose assembly cost without invoking the legacy limitation below. Measure:

- first cold `get_messages`;
- 20 sequential unchanged-sequence requests;
- five concurrent same-sequence clients;
- first request after one transcript-changing event.

Record RPC invocation count, RPC/pipeline/stringify timing from existing dev-harness `serverTiming`, response bytes, message count, and a content hash. The candidate must show one base RPC per sequence while response hashes and contents remain equivalent.

### 7.3 Large synthetic RPC line

Feed valid JSON lines of 1, 4, and 16 MiB through the bridge in fixed-size chunks (64 KiB and one smaller chunk size). Record total elapsed time and searched-byte count. The primary proof is linear searched bytes; timing should scale approximately with payload size rather than quadratically. Verify the parsed payload hash and listener count after each run.

### 7.4 Boot and persistence observations

With a fixed live set, record total restore duration, p95/max event-loop delay, maximum observed concurrent restores, and attempted session-id sequence under low and injected/high lag. The before/after attempted id list must be identical. Separately count cost-store writes during a burst and session-store primary reads/bytes written before and after compact serialization/fingerprint reuse.

Benchmarks are diagnostic, not permission to weaken behavior or timing budgets.

## 8. Rollout and review order

1. Pure RPC scanner and BFS helper with equivalence tests.
2. Snapshot memo and WS integration.
3. Cost debounce/flush and narrow session-store changes.
4. Async orphan scan and lag-aware eager batching.
5. Task generation/cache.
6. API E2E, benchmarks, `npm run check`, focused tests, then `npm run test:unit`.

Review each step against current master rather than applying the aggregate patch wholesale. In particular, reject any diff that introduces lazy revival, archive/session ordering changes, cost-entry eviction, a new persistence shape, or unrelated configuration/reliability work.

## 9. Known remaining limitation (explicitly out of scope)

A small number of legacy sessions have **20–24 MB first-open transcripts** that were never compacted. Opening one still requires the agent/runtime to assemble and transfer the complete legacy history, and the client must parse and render it. The memo improves repeated opens at an unchanged sequence and the incremental RPC scanner removes quadratic framing, but the first full snapshot can remain slow and memory-heavy.

This goal will not stream, paginate, truncate, auto-compact, omit, or lazily render that history because those approaches change transcript/UX semantics. The limitation must remain documented in completion notes and should be handled by a separate explicitly designed goal if product requirements later permit a visible loading or transcript-delivery change.
