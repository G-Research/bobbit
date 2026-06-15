# Missing live messages after dormant revive — root cause

HEAD verified: `e7c26fa63094cc8c781a0827d1d82e9d80e0b7c4`.

## Symptom

A dormant/hibernated session can wake, run a user follow-up turn, and persist the assistant reply to the agent `.jsonl`, while an already attached browser tab never receives the live assistant frames. The UI then looks idle/asleep even though the server completed the turn, so reload/live status cannot reliably distinguish "ignored" from "answered but not delivered".

## Confirmed mechanism

The confirmed current-HEAD mechanism is **F2e: dormant-revive split-brain from concurrent `addClient` restores**. `SessionManager.addClient()` sees `status === "terminated"`, calls `this.restoreSession(ps)` without a per-session mutex or generation guard, returns `true`, and only in `.then()` adds the websocket to `this.sessions.get(sessionId)` (`src/server/agent/session-manager.ts:6396-6418`). The dormant entry remains in the map for the whole restore window, so a second attach/revive can start another full restore. `restoreSession()` builds a new `SessionInfo` with a fresh `clients: new Set()` and fresh `EventBuffer()` (`src/server/agent/session-manager.ts:3781-3809`), broadcasts idle before inserting it, then replaces the map entry at the end (`src/server/agent/session-manager.ts:3895-3912`). If restore #1 completes, client A is added to SessionInfo #1; if restore #2 completes next, the map is replaced by SessionInfo #2 and client B is added there. Later `enqueuePrompt()` reads only the map entry (`src/server/agent/session-manager.ts:1910-1911`) and dispatches/broadcasts against SessionInfo #2 (`src/server/agent/session-manager.ts:2026-2029`, `2237-2240`, `2288-2319`). Live agent events use only the running session object's client set (`emitSessionEvent`, `src/server/agent/session-manager.ts:544-559`), so client A on the stale SessionInfo never receives the assistant `message_end`, even though the turn is produced.

The deterministic reproducer is `tests/missing-live-messages-repro.test.ts`. It uses a real `SessionManager.addClient()`/`enqueuePrompt()` with fake websocket clients and a fake restored bridge. On current HEAD it shows two concurrent dormant `addClient()` calls start two restores, attach clients to different `SessionInfo` objects, then a produced assistant frame reaches the current object only; the first attached client misses it.

## Candidate ruling table

| Candidate | Ruling | Current-HEAD evidence |
|---|---:|---|
| 1. Dormant-revive split-brain (F2e) | **Ruled in — primary** | `addClient()` starts unguarded `restoreSession(ps)` for every terminated-session attach and later registers `ws` on whatever `this.sessions.get(sessionId)` returns (`session-manager.ts:6396-6418`). `restoreSession()` creates/replaces a new SessionInfo with empty clients (`:3781-3809`, `:3912`). Reproducer proves an attached client on the loser object misses the assistant frame. |
| 2. statusVersion regression (F2a) | Ruled out for this observed drop, but still adjacent F2 risk | In-place restart carry-over exists at current HEAD: `_snapshotStreamingFrameOfReference()` returns `lastStatusVersion` (`session-manager.ts:3082-3086`), `_respawnAgentInPlace()` threads `_restartFrameOfReference` (`:3107-3128`), and `restoreSession()` seeds `initialStatusVersion` (`:3789-3804`). The dormant `addClient()` path does **not** use `_respawnAgentInPlace()`, so the repro drops because the client is on a stale object, not because its `v <= last` gate rejects a frame. |
| 3. EventBuffer re-seed at seq 1 (F2d) | Ruled out for this observed drop, still adjacent in concurrent respawns | `EventBuffer` defaults `nextSeq = 1` (`src/server/agent/event-buffer.ts:17-28`) and has `seedNextSeq()` for in-place restarts (`:80-91`). Current in-place respawn carry-over seeds from `_restartFrameOfReference` (`session-manager.ts:3789-3794`). The reproducer's missed assistant frame is never sent to client A at any seq; it is not rejected by a seq cursor. Concurrent restore can still create multiple fresh buffers, so CS-R2 should cover it. |
| 4. Never-drained queue (F7) | Ruled out as primary for the captured incident | The bug report confirms full assistant replies persisted. In current code `enqueuePrompt()` dispatches immediately when the map session is `idle` and queue-empty (`session-manager.ts:2023-2029`); `dispatchDirectPrompt()` marks streaming and calls `rpcClient.prompt()` (`:2237-2240`, `:2288-2319`); agent `message_end`/`agent_end` paths drain only at `agent_end` (`:2490-2544`). F7 remains real for prompts accepted during `preparing`/`starting`: `ws/handler.ts:486-510` says they will drain later, but only `agent_end`, enqueue-while-idle, recovery, and force-abort call `drainQueue()`. |
| 5. Concurrent restore / double EventBuffer / leaked child (F2d/e) | Ruled in as the enabling condition | The same unguarded `addClient()` window permits N `restoreSession()` calls. The test logs two dormant revive attempts and demonstrates the loser SessionInfo retaining an attached client while the map/running bridge moves on. This is the F2 concurrent restore cluster; the user-visible lost live message is the F2e split-brain leg. |

## Goal completion / team disband path

Goal completion does not introduce a special live-delivery path. `TeamManager.completeTeam()` dismisses role agents but explicitly keeps the team lead session alive (`src/server/agent/team-manager.ts:2220-2280`). If that lead later becomes dormant/terminated and a user attaches/sends follow-up chat, it uses the same generic `SessionManager.addClient()` dormant revive path above. Therefore the fix must be general session lifecycle fencing, not goal-completion-specific behavior.

## Mapping to doc-04 findings and required cards

Confirmed finding: **F2**, specifically **F2e (`addClient` dormant revive split-brain)** plus the broader concurrent-restore F2d hazard. Implement **CS-R2** for this failure.

Doc-04 CS-R2 fix-direction lines to follow:

> a per-session **respawn generation + in-flight restore promise**: every entry point (`addClient` revive, `restartAgent`, `_restartSessionWithUpdatedRole`, forceAbort respawn, `recoverSandboxSessions`, `ensureSessionAlive`) joins the in-flight promise instead of starting a second restore. A **neutralization epilogue** on the old object at the top of `_respawnAgentInPlace`: mark it terminated/fenced, clear `clients`, `cancelPendingAutoRetry(session)`, and stamp a generation that `recoverPromptDispatch`, `drainQueue`, and the retry-timer closure check before acting (stale generation → no-op).

Also implement the CS-R2 acceptance item for `(d/e)`: a real-`SessionManager` red→green test proving concurrent dormant `addClient()` revives join one restore and all attached clients receive post-revive frames.

**CS-R7 is not required to fix this captured failure**, because the reply was produced and persisted. It remains an adjacent symptom-C backlog item. If the fix touches prompt acceptance during restore, follow doc-04 CS-R7's restore-window line:

> make the respawn-window `enqueuePrompt` either await the in-flight restore (CS-R2's promise) or return an explicit error.

Do not implement CS-R7's drain-on-idle hook as part of the minimal missing-live-messages fix unless a separate reproducer implicates a queued-but-never-produced turn.

## Minimal root-cause fix sketch

1. Add a per-session restore/respawn coordinator in `SessionManager` (for example a `Map<sessionId, { generation, promise }>`). All restore-like entry points join the existing promise instead of calling `restoreSession()` or `_respawnAgentInPlace()` independently.
2. Change `addClient()`'s terminated-session branch to join that coordinator. After the joined restore resolves, attach the websocket to the single canonical SessionInfo in `this.sessions`; do not start another restore while one is in flight.
3. Route terminated in-memory restores that have attached clients through the same coordinator/`_respawnAgentInPlace()` shape where possible, so frame-of-reference and clients are preserved consistently. A cold no-client restore can still create a fresh SessionInfo, but it must still be mutexed.
4. Add stale-generation checks to old-object writers named in CS-R2 (`recoverPromptDispatch`, `drainQueue`, auto-retry timer closures), and neutralize old objects during in-place respawn so stale broadcasts cannot consume status versions or mutate queues after the snapshot.
5. Extend the new reproducer to assert the fixed invariant: concurrent dormant attaches cause one restore, every attached client is on the canonical SessionInfo, and a post-wake assistant frame is delivered to each attached client with monotonic seq/status frame-of-reference.
