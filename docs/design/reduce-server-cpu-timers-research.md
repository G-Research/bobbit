# Reduce Server CPU: background timers, pollers, and watchers research

Date: 2026-05-19
Task: `5a7b9501-a0da-442a-8657-c5f38cfe8fbb`

## Scope and method

Read-only source review of:

- `src/server/agent/project-sandbox.ts`
- `src/server/agent/inbox-nudger.ts`
- `src/server/search/`
- `src/server/preview/`
- `src/server/server.ts` timer call sites
- related `docs/debugging.md` entries

No production code or tests were changed. No runtime benchmark was run for this task; the output below is an inventory and measurement plan for follow-up experiments.

## Summary

Likely recurring idle CPU sources in this scope are limited and measurable:

1. `ProjectSandbox.startHealthMonitor()` — one `docker inspect` poll every 20s per ready sandboxed project.
2. `InboxNudger.start()` — one global 15s staff scan.
3. `TriggerEngine.start()` — started by `server.ts`; one global 60s staff-trigger scan, with synchronous `git log` subprocesses for git triggers. This is outside the named source-file scope except for the `server.ts` start/stop calls, but it is a server-side poller and should be measured.
4. `server.ts` rate-limiter cleanup — one global 60s map sweep.
5. Preview SSE keepalive — one 25s interval per open preview EventSource.
6. `/api/sessions/:id/wait` heartbeat — one 60s interval per active long-poll wait request.

Search timers are mostly one-shot/debounced and should not consume idle CPU after startup/indexing settles. Preview `watchMount()` has an `fs.watch`, but current server code does not call it.

## Timer and watcher inventory

| Area | Call site | Cadence | Starts | Cleanup lifecycle | Idle CPU notes |
| --- | --- | ---: | --- | --- | --- |
| Sandbox health | `project-sandbox.ts:426-432` | 20s per sandbox by default | `SandboxManager.initForProject()` starts it after successful `sandbox.init()` | `stopHealthMonitor()` clears; called by `ProjectSandbox.shutdown()`, `destroy()`, and `SandboxManager.shutdownAll()` | Each active tick can spawn `docker inspect --format {{.State.Running}} <container>` via `_isContainerRunning()`. Cost is mostly Docker child/daemon CPU, but process spawning can still wake the gateway. |
| Inbox nudger | `inbox-nudger.ts:53-55` | 15s global interval | `server.ts:751` | `InboxNudger.stop()` clears; called by `server.ts` shutdown | Scans all active staff and calls `InboxStore.listPending()` only after staff is active, has a current idle session, and no nudge is pending. `poke()` gives enqueue-driven microtask latency, so the interval is mostly a fallback for staff becoming idle later. |
| Staff trigger engine | `server.ts:750`; implementation `staff-trigger-engine.ts:114` | immediate tick + 60s global interval | Server boot | `triggerEngine.stop()` from `server.ts` shutdown | Schedule triggers are cheap. Git triggers use synchronous `execFileSync("git", ...)` with 5s timeouts per check and can block the Node event loop under idle load if many staff have enabled git triggers. |
| Auth rate limiter cleanup | `server.ts:773-775` | 60s global interval | Server boot | `clearInterval(cleanupInterval)` in `server.ts` shutdown | Sweeps a map of failed auth attempts. Usually tiny; permanent timer can likely be replaced by opportunistic cleanup or only scheduled while the map is non-empty. |
| Search startup rebuild delay | `search/search-service.ts:552-559` | one-shot, default 5s per project needing rebuild | `SearchService.open()` after meta mismatch/corrupt empty index | Timer is `unref()`'d, stored as `_rebuildTimer`, and cleared by `close()`; the callback also re-checks for the closed state | No steady idle cost. **(Fixed, goal "Stabilize flaky E2E suite".)** The former lifecycle bug — a context closing before the 5s timer fired let the rebuild callback run on a closed store (`FlexSearchStore: already closed`) — is resolved: the timer is cancelled on `close()` and the callback no-ops when state is `"closed"`. See [docs/internals.md — Close & teardown ordering](../internals.md#close--teardown-ordering). |
| Search index progress debounce | `search/indexer.ts:265-269` | one-shot, 500ms | During incremental/rebuild progress | Cleared by `_flushProgress()`; timer is `unref()`'d | Active only during indexing. |
| Search persistence debounce | `search/flex-store.ts:466-472` | one-shot, 500ms | Store mutations | Cleared by `FlexSearchStore.close()` and `unref()`'d | Active only after writes. |
| Search load/rebuild yields | `search/indexer.ts:170`, `search/flex-store.ts:542` | `setImmediate` yield between batches/files | Search rebuild/load | Natural completion | Not idle; spreads CPU-bound FlexSearch work across event-loop turns. |
| Search progress WS debounce | `server.ts:1019-1021` | one-shot, 500ms per project with progress | `index:progress` events | Cleared by `flushProgress()` on timer or `index:complete`; timer is `unref()`'d | Active only during indexing; second debounce after `Indexer`'s own 500ms debounce. |
| Preview SSE keepalive | `server.ts:7836-7841` | 25s per open preview-events request | `GET /api/sessions/:sid/preview-events` | `clearInterval(keepalive)` and unsubscribe on request `close`/`error`; timer is `unref()`'d | Many tabs/sessions mean many intervals, each writing `:keepalive`. Measure with multiple open browser tabs. |
| Preview event emitters | `preview/events.ts:21-52` | no timer | Lazily per session with SSE subscriber | Unsubscribe removes empty emitter | No idle CPU; watch listener count for leaks. `clearPreviewListeners()` exists but is not referenced in current source. |
| Preview mount watcher | `preview/mount.ts:452-494` | `fs.watch` per watched session + 50ms debounce timer on events | Only if `watchMount()` is called | Unsubscribe closes watcher and clears debounce after last subscriber | `git grep` found no current server call to `watchMount()`. If activated later, recursive watchers should be counted explicitly. |
| Session wait heartbeat | `server.ts:5984-5999` | 60s per active `/api/sessions/:id/wait` request | Long-poll wait endpoint | Cleared in `finally` after wait completes/errors | Not idle unless clients/tests hold wait requests open. Consider `unref()` for parity. |
| Shutdown delay | `server.ts:1847` | one-shot 500ms | `/api/shutdown` | Process exits | Not an idle CPU concern. |
| Boot background tasks | `server.ts:1267-1396` | one-shot after listen | Server start | Natural completion | Sweeper and worktree-pool init can consume CPU at boot but are not recurring timers. `BOBBIT_SKIP_WORKTREE_POOL=1` already gates pool fill in CI/E2E. |

Adjacent out-of-scope but relevant handoffs:

- `SessionManager` status heartbeat is a 15s interval that rebroadcasts session status and is mentioned in `docs/debugging.md` around the spurious idle unread symptom. This likely belongs to the session/WebSocket CPU research task.
- `SessionManager.startPurgeSchedule()` is called from `server.ts` and schedules a 24h archive purge in `session-manager.ts`. Its cadence makes it unlikely to affect steady idle CPU, but it should be included in any global active-timer dump.

## Related debugging notes

- `docs/debugging.md:439` documents the sandbox health monitor's 20s `docker inspect` poll and the `_status === "starting"` skip path.
- `docs/debugging.md:468` documents search progress events and the 500ms debounce.
- `docs/debugging.md:397` documents the client-side git status 30s safety poll and server-side 2s git-status coalescing. This is client-driven request load, not a server idle timer.
- `docs/debugging.md:1025-1027` documents sidebar churn caused by the 15s status heartbeat if clients mutate `lastActivity`; this is a useful warning for heartbeat optimization work but is outside this task's named files.

## Recommended instrumentation

Add an env-gated diagnostic module, loaded as early as possible in server startup, for one benchmark/report PR. Keep it disabled by default and avoid permanent user-facing endpoints.

### Global timer and watcher census

`BOBBIT_TIMER_DIAG=1` should wrap:

- `global.setTimeout`, `global.setInterval`, `global.clearTimeout`, `global.clearInterval`
- `fs.watch`

For each timer/watch, record:

- kind: timeout, interval, fs-watch
- delay/cadence
- active/refed state when available
- creation stack collapsed to first in-repo frame
- created, fired, cleared/closed counts
- callback duration sum/max/p95 bucket per call site
- current active count by call site and cadence

Use `process._getActiveHandles()` only as a secondary validation for sockets/servers/FS watchers; do not rely on it for timers. Timer handles are not consistently exposed there across Node versions.

Suggested JSONL snapshot shape:

```json
{
  "ts": 1779140000000,
  "processCpuDeltaMs": { "user": 12.3, "system": 1.1 },
  "eventLoopUtilization": 0.012,
  "eventLoopDelayMs": { "p50": 1.2, "p95": 4.8, "max": 18.4 },
  "activeTimers": [
    { "kind": "interval", "delayMs": 15000, "count": 1, "site": "src/server/agent/inbox-nudger.ts:53" }
  ],
  "activeWatchers": [
    { "path": "...", "recursive": true, "count": 1, "site": "src/server/preview/mount.ts:470" }
  ]
}
```

Use `process.cpuUsage(previous)`, `performance.eventLoopUtilization(previous)`, and `perf_hooks.monitorEventLoopDelay()` for process-level correlation.

### Subsystem counters

Global timer wrapping identifies cadence and active counts, but subsystem counters make optimization attribution easier:

- Sandbox: health ticks, skipped ticks by reason, `docker inspect` duration, recovery attempts/success/failure.
- Inbox nudger: ticks, staff scanned, inactive/no-session/non-idle/nudge-pending skips, `listPending()` calls, pokes, nudges sent, compact duration.
- Trigger engine: ticks, staff scanned, trigger checks by type, git subprocess count/duration, schedule fires, git fires.
- Search: startup rebuild timers scheduled/fired/cancelled, rebuild queue depth, progress emits, WS progress flushes, flex flush count/duration.
- Preview: active SSE connections, keepalives sent, preview emitters, preview listeners, active `watchMount()` watchers if any.
- REST wait: active `/wait` heartbeats and total wait requests.

### Workloads to normalize results

For this timer/poller slice, run at least:

1. Idle server, no agents, no browser tabs, 5 minutes.
2. Idle server with 3 browser tabs open to different sessions, preview panel open in each, 5 minutes.
3. Staff-heavy idle: N active staff with no inbox; then N staff with pending inbox but streaming sessions; then idle sessions.
4. Staff git-trigger workload: several enabled git triggers pointed at local repos.
5. One ready Docker sandbox with no active sandboxed sessions; then one active sandboxed session.
6. Search startup/rebuild workload with `BOBBIT_SEARCH_STARTUP_DELAY_MS=0` and a seeded/corrupt/mismatched index.

For every workload, log process CPU, event-loop utilization/delay, active timer/watch counts, and subsystem counters. Attribute child CPU separately for Docker/git subprocesses.

## Candidate optimizations to test

Do not keep any optimization without before/after data.

### 1. Staff trigger engine: remove synchronous git polling from the event loop

Hypothesis: if users have enabled git triggers, the 60s poll can create idle CPU spikes and block the Node event loop because `execFileSync("git", ...)` runs in the main thread.

Test candidates:

- Replace sync git calls with async `execFile` plus a small concurrency cap.
- Skip starting the 60s interval when no active staff have enabled schedule/git triggers; start/stop on staff trigger mutations.
- For schedule triggers, compute next due minute and use one one-shot timer instead of scanning every active staff every minute.

Functional guardrails:

- Cron triggers must not miss a matching minute.
- Git triggers must still update `lastSeenSha` and fire once per new commit batch.

### 2. Inbox nudger: make fallback scanning conditional

Hypothesis: the 15s global scan is cheap for small staff counts but unnecessary when there are no pending inbox entries.

Test candidates:

- Maintain a `staffIdsWithPendingInbox` set in `InboxManager`/`InboxNudger`; skip or stop the interval when empty.
- Add a session status listener for staff sessions transitioning to `idle`, then call `tickOne(staffId)` immediately instead of waiting for the fallback tick.
- Keep `poke()` microtask behavior for trigger/manual enqueue latency.
- `unref()` the fallback interval.

Functional guardrails:

- Preserve current trigger-to-nudge near-zero latency for already-idle staff.
- Preserve idle-to-nudge latency for staff that become idle after enqueue; target same or better than current <=15s.

### 3. Sandbox health monitor: adaptive cadence or event-driven health

Hypothesis: 20s `docker inspect` per sandbox is useful for active sandboxed sessions but wasteful when a sandbox has no live sessions.

Test candidates:

- Keep 20s while the project has active sandboxed sessions; back off to 60-120s when none are active.
- Add jitter across projects to avoid synchronized Docker CLI bursts.
- Consider Docker events as a future replacement, but only if significantly better and not more complex.
- `unref()` the health interval.

Functional guardrails:

- Do not regress recovery timing for active sandboxed sessions; `docs/debugging.md` currently sets expectation at about 20-40s.
- Failed recovery should still retry automatically.

### 4. Preview SSE keepalives: consolidate under many tabs

Hypothesis: per-connection 25s intervals are negligible for one tab but grow with many tabs/sessions.

Test candidates:

- Count active preview SSE clients first.
- If many intervals show measurable CPU, replace per-connection intervals with a shared keepalive scheduler that writes to all active preview responses every 25s.
- Ensure cleanup is idempotent because both `close` and `error` can fire.

Functional guardrails:

- Keep proxy/browser EventSource connections alive.
- Do not leak emitters/listeners after panel close or session navigation.

### 5. Rate-limiter cleanup: avoid a permanent interval

Hypothesis: the 60s cleanup interval is low-cost but unnecessary when there are no failed auth attempts.

Test candidates:

- Schedule a one-shot cleanup only when `recordFailure()` inserts the first map entry.
- Or rely on opportunistic cleanup in `isRateLimited()`/`recordFailure()` and cap map size defensively.
- `unref()` any retained cleanup timer.

Functional guardrails:

- Failed auth records must expire after `windowMs`.
- Memory must stay bounded under many distinct failed IPs.

### 6. Search timers: tighten lifecycle, not idle CPU

Hypothesis: search timers are not idle CPU hot paths, but lifecycle cleanup can be safer.

Test candidates:

- Store the startup rebuild delay timer and cancel it in `SearchService.close()`.
- Stagger startup rebuilds across projects if many project indexes need rebuild simultaneously.
- Measure whether the double 500ms debounce (`Indexer` progress + `server.ts` WS bridge) delays UX or adds redundant timers during rebuilds; only simplify if measurements show value.

Functional guardrails:

- Search progress, complete, and error events must still reach clients.
- Final flush on close must still persist index state.

### 7. Preview `watchMount()`: confirm unused or instrument before use

Hypothesis: current production preview update path is EventEmitter/SSE and does not use `fs.watch`; therefore `watchMount()` is not an idle CPU source today.

Test candidates:

- If confirmed unused across tests and docs, remove it in a separate cleanup PR.
- If it is intentionally public for future use, add diagnostic active watcher counts before any optimization.

Functional guardrails:

- Do not remove any behavior used by preview hot-reload or external tests without a pinning test proving the supported path.

## Proposed priority order

1. Instrument first: global timer/watcher census plus subsystem counters.
2. Measure idle/no-browser and multi-tab preview to prove baseline active timers.
3. If git-trigger staff exist in real workloads, test async/capped trigger git checks first; this is the only reviewed poller with synchronous child-process work on the Node event loop.
4. Test conditional inbox fallback scanning and sandbox adaptive health polling independently.
5. Treat rate-limiter, search lifecycle, and preview keepalive consolidation as low-risk cleanup only if measurements show non-trivial CPU or handle counts.
