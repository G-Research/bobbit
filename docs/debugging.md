# Bobbit — Debugging Guide

Scannable checklists for common issues. Each entry: symptom → where to look → key detail.

## Streaming performance (UI sluggishness)

- **Architecture**: `StreamingMessageContainer` owns rendering during streaming via `setMessage()` with `requestAnimationFrame` batching. `AgentInterface` must NOT call `this.requestUpdate()` in the `message_update` event handler — only the streaming container updates on each token.
- **If the UI feels sluggish during streaming**: check `AgentInterface.setupSessionSubscription()` — the `message_update` case should only update the streaming container, not trigger a full `AgentInterface` re-render.
- **Markdown content throttle**: `AssistantMessage._getThrottledContent()` limits `<markdown-block>` `.content` updates to ~4x/sec (250ms) during streaming. This prevents `MarkdownBlock.render()` — which runs `marked.parse()` on the full text, reconfigures parser extensions, and does regex-heavy HTML escaping — from executing on every rAF frame. Without this throttle, HTML-heavy streaming responses cause main-thread jank because each `marked.parse()` call grows more expensive as content accumulates. The throttle uses the same pattern as `WriteRenderer._getThrottledCode()`: snapshot the content on first call, start a 250ms cooldown timer, and return the snapshot until the timer expires. A 20-character prefix check detects message identity changes (e.g. the element is reused for a different message) and resets the throttle immediately. When `isStreaming` flips to false, the timer is cleared in `render()` so the final content is always rendered accurately.
- **Text appears laggy or stale during streaming?** The 250ms throttle means visible text trails the actual streamed content by up to 250ms — this is intentional and barely perceptible. If text appears significantly more stale than that, check: (1) `_contentThrottleTimer` is being cleared when `isStreaming` becomes false, (2) the prefix-based identity reset in `_getThrottledContent()` is firing correctly when switching between messages, (3) no additional throttle or debounce has been added upstream in `StreamingMessageContainer`.
- **toolResultsById memoization**: `AgentInterface._getToolResultsById()` caches the tool-results Map to avoid creating a new reference on every render, which would cause `MessageList` to re-render unnecessarily.
- **content-visibility CSS**: `message-list > .flex > *` uses `content-visibility: auto` to skip layout/paint for off-screen messages in long conversations.
- State-transition events (`message_start`, `message_end`, `agent_start`, `agent_end`, `turn_start`, `turn_end`) still call `requestUpdate()` — only `message_update` (the hot path) is excluded.

## Large file writes (agent writes >32KB)

- **System unresponsive during large writes?** The truncation system in `truncateLargeToolContent()` should be stripping content >32KB from WebSocket broadcasts and EventBuffer. Check that `subscribeToEvents()` in `session-setup.ts` applies truncation before `broadcast()` and `eventBuffer.push()`.
- **Full content not loading in UI?** The "Load full content" button in `WriteRenderer` fetches via `GET /api/sessions/:id/tool-content/:messageIndex/:blockIndex`. Check: (1) the endpoint is registered in `server.ts`, (2) the session's `.jsonl` file exists and contains the full message, (3) `messageIndex` and `blockIndex` resolve to the correct content block.
- **Truncation happening for small files?** Threshold is `LARGE_CONTENT_THRESHOLD` (32KB) in `truncate-large-content.ts`. Only string content in `toolCall`/`arguments` or `tool_use`/`input` blocks is checked.
- **Search indexing memory spike?** `extractTextFromMessage()` should also handle truncated content gracefully — it receives the original event via `handleAgentLifecycle()`, not the truncated one. If indexing large content causes issues, the search extraction path may need its own truncation.
- See [docs/internals.md — Large content truncation](internals.md#large-content-truncation) for the full architecture.

## Duplicate messages

- All transcript mutations now go through the unified reducer in `src/app/message-reducer.ts`. Streaming-preview duplicate suppression is render-time: `AgentInterface.renderMessages` filters any message whose `id === streamingMessage?.id`.
- `MessageList` renders `state.messages` (completed); `StreamingMessageContainer` renders `state.streamMessage` (in-progress) — they must never overlap.
- Tool-call messages stay in streaming until the next message starts.
- See [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant) for the single-sort-key contract.

## Blob stuck idle while streaming (zzz visible with stop button)

- **Symptom**: chat blob shows the desaturated idle sprite with floating `zzz` while the agent is actively streaming (stop button visible, tool calls running). Stays wrong until the next `isStreaming` transition. Most reproducible by sending a new message immediately after the previous turn ends.
- **Root cause**: orphan `setTimeout` in `src/ui/components/StreamingMessageContainer.ts` exit/compaction paths writing `_blobState = 'idle'` after `isStreaming` flipped back to `true`. The entry path tracked its timer in `_entryTimer` and cleared it; exit/compaction timers were untracked.
- **Invariant**: every timer that writes `_blobState` must be stored in a field, cleared on any transition back to `active`/`entering`, and its callback must re-check `this.isStreaming` and the expected source state before writing.
- **Pinning test**: `tests/streaming-blob-state.spec.ts` — drives `isStreaming` false→true within the exit window and asserts the blob ends up `active`, not `idle`. Must fail on pre-fix master.

## Streaming dedup / reorder

- **Symptoms**: during live streaming (not reload-replay), assistant or toolResult messages appear twice, or parallel tool results appear in the wrong order. Most often observed right after a mid-turn WS reconnect (dev-server restart, tab sleep/resume, flaky network) or during rapid parallel tool-call bursts.
- **Root cause in one line**: transport-level snapshot-vs-live race. See [docs/internals.md — Event stream ordering & dedup](internals.md#event-stream-ordering--dedup) for the architecture and [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md) for the full reasoning.
- **On the wire**: every `{type:"event"}` frame must carry a numeric `seq` and `ts`. Inspect frames in DevTools → Network → WS. If `seq` is missing, the server is pre-fix or the frame didn’t go through `emitSessionEvent()` in `src/server/agent/session-manager.ts` — check for any stray `eventBuffer.push()` + `broadcast()` pair that bypasses the helper.
- **Client state**: `RemoteAgent._highestSeq` should advance monotonically; `_pendingEvents` should stay empty except during a brief out-of-order window. A persistently non-empty `_pendingEvents` means frames are arriving with a gap the server never closes — usually the `resume`/`resume_gap` handshake is broken.
- **Reconnect path**: on WS reopen the client sends `{type:"resume", fromSeq: _highestSeq}` before any other traffic. Server replays via `EventBuffer.since(fromSeq)`. If the seq has been evicted from the 1000-entry ring, server returns `resume_gap` and client falls back to the `get_messages` snapshot path. Check `EventBuffer.size` and `lastSeq` against the client’s `fromSeq` when diagnosing a suspected eviction.
- **Repro test**: `ST-DEDUP-01` in `tests/e2e/ui/stories-streaming.spec.ts`. It drops the WS mid-burst, reconnects, and asserts the final `messages[]` has no duplicates and preserves order. Must fail on pre-fix master; must pass after the fix. `RE-07` in `tests/e2e/ui/stories-resilience.spec.ts` also exercises the same reconnect path and should stay green.
- **Unit coverage**: `tests/event-buffer.test.ts` (seq/eviction/`since`/`canResumeFrom`/`lastSeq`) and `tests/remote-agent-seq-dedup.spec.ts` (dedup, ordering, resume, compat fallback).

## Verification log duplicated Nx

- **Symptoms**: each line in the live verification output (`<verification-output-modal>` and `<gate-verification-live>`) appears multiple times. The multiplier matches the number of session WebSockets the current tab has open for that goal (3× with three sessions, 6× with six), with **+1 extra** when the goal dashboard is mounted, and **+1 more** if a `__viewer__` connection is active. Reopening the output modal mid-stream used to also re-print the bootstrap prefix.
- **Why**: every session in the UI owns its own `RemoteAgent`/WS, and the server's `broadcastToGoal` fan-out delivers each `gate_verification_*` payload to all of them. Pre-fix, each `RemoteAgent` (and the dashboard's viewer WS) called `document.dispatchEvent(new CustomEvent("gate-verification-event", …))` independently, so the document-level listeners in the modal and live renderer each appended one chunk per dispatch.
- **Where the dedupe lives**: `src/app/verification-event-bus.ts` exports `dispatchVerificationEvent(msg)`. All dispatch sites (`src/app/remote-agent.ts`, `src/app/goal-dashboard.ts`) funnel through it. The bus dedupes by composite key `(eventType, signalId, stepIndex, seq)` using a bounded `Set<string>` (~5000 entries with FIFO/LRU eviction so long-running sessions don't grow it unboundedly).
- **Server-stamped seq**: every `gate_verification_*` event now carries a monotonic `seq: number` assigned in `src/server/agent/verification-harness.ts` (added to the additive `seq` field on the message in `src/server/ws/protocol.ts`). When `seq` is missing (older server), the bus falls back to hashing the payload contents (`stream`/`text`/`status`…) which collapses identical fan-out copies but is best-effort.
- **Listener hygiene**: `src/ui/components/VerificationOutputModal.ts` and `src/ui/tools/renderers/GateVerificationLive.ts` register their `document.addEventListener` calls via an `AbortController`; teardown (`disconnectedCallback`, Lit re-render) calls `controller.abort()`, so listeners can't leak across mount cycles and re-fire on stale closures.
- **Bootstrap/live overlap**: when `VerificationOutputModal` opens with non-empty `initialOutput`, it records the highest `seq` already covered by the bootstrap and discards live events with `seq` ≤ that high-water mark. `_fetchBootstrapOutput` is also skipped when `initialOutput` is already populated, eliminating the prior "prefix shown twice" race.
- **Quick checks when triaging**: in DevTools, set a breakpoint inside `dispatchVerificationEvent` and confirm the `seen` set rejects N−1 of every N copies. If the bus is being bypassed, search for direct `document.dispatchEvent(new CustomEvent("gate-verification-event"…))` calls — the bus is the only legitimate dispatcher. If frames have no `seq`, server-side `verification-harness.ts` is on a pre-fix build.
- **Repro test**: `tests/verification-dedup.spec.ts` (with fixtures in `tests/fixtures/verification-dedup-*`) is a Playwright file:// fixture that dispatches the same event 6× and asserts a single rendered occurrence on each component.
- **Architecture deep-dive**: [docs/internals.md — Verification event dedupe](internals.md#verification-event-dedupe). Parallel pattern (different event family) for the live agent stream: [docs/internals.md — Event stream ordering & dedup](internals.md#event-stream-ordering--dedup) and [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md).

## Session connection issues

- Session creation logic lives in `session-setup.ts` (pipeline steps + executors) and `session-manager.ts` (thin wrappers)
- `executePlan()` runs the full pipeline synchronously for normal/delegate sessions
- `executeWorktreeAsync()` runs asynchronously for worktree sessions (fire-and-forget, returns immediately with `status: "preparing"`)
- `handleSetupFailure()` in `session-setup.ts` handles cleanup on pipeline errors
- `subscribeToEvents()` is the shared event subscription function across all session types
- `connectToSession()` in `session-manager.ts` creates ChatPanel before `remote.connect()`
- Model + WebSocket connect run in parallel via `Promise.all`
- `switchGeneration` / `isStale()` invalidates in-flight work on rapid switches
- On connect failure, `state.chatPanel` is cleared (prevents stuck spinner)
- `model` and `thinkingLevel` synced from server's `get_state` response on connect/reconnect

## Session/goal refresh not updating

- Both stores track a `generation` counter; clients pass `?since=N` to skip unchanged data
- Check `sessionsGeneration` and `goalsGeneration` in `state.ts`
- Server returns `{ changed: false }` when generation matches

## Gate status stale

- `state.gateStatusCache` refreshed via: (1) `refreshGateStatusCache()` on initial load, (2) `refreshGateStatusForGoal()` on WS events `gate_status_changed` / `gate_verification_complete`
- Dashboard gate polling also syncs to this cache

## Context bar / model state

After a server restart, the context bar may show wrong info (e.g. 200k instead of 1M) or nothing at all. This happens because the agent process's `getState()` RPC may fail or return incomplete data before the process is fully ready.

- **Server-side fallback**: `sendFallbackModelState()` in `handler.ts` reads persisted `modelProvider`/`modelId` from the session store and calls `inferMeta()` to attach the correct `contextWindow`. This runs when `getState()` fails, is skipped (dormant/preparing sessions), or returns data without model metadata.
- **Client-side retry**: `remote-agent.ts` retries `get_state` after 3s on reconnect if `contextWindow` is still 0.
- **Default contextWindow is 0**: Before the server provides real data, `contextWindow` starts at 0 (not 200k), so the context bar shows nothing rather than a misleading value.
- If context bar still shows wrong info after restart, check that `modelProvider` and `modelId` are persisted in `<project-root>/.bobbit/state/sessions.json` for the affected session.
- `SessionManager.getPersistedSession(id)` exposes persisted session data used by the fallback mechanism.

## Duplicate `model_change` event at session startup

Non-pool sessions should emit a single `model_change` matching the configured model. Two events at startup means the spawn-time pin didn't apply.

- Confirm the spawn site routes through `resolveBridgeOptions` in `src/server/agent/session-setup.ts` (normal create) or the equivalent inline pre-resolve in `session-manager.ts` (role-respawn, force-abort respawn) / `verification-harness.ts` (3 sub-session sites) / `server.ts` (continue-archived). Each call ends with `bridgeOptions.initialModel` set when a model is resolvable.
- Confirm `buildAgentArgs` in `src/server/agent/rpc-bridge.ts` is producing `--model <provider>/<modelId>` — a stray `/` in the value or a missing slash drops the flag silently.
- Confirm post-spawn helpers pass `skipSetModel: true` when `session.spawnPinnedModel` matches: `tryAutoSelectModel`, `tryApplyDefaultThinkingLevel` in `session-manager.ts`, and the three sites in `verification-harness.ts`. The flag still runs the `getState()` read-back, so the hard-fail-on-mismatch contract is preserved — the only thing it elides is the `setModel` RPC and its `model_change` echo.
- **Documented limitation**: the aigw cold-cache fallback emits two events — best-ranked model discovery is async and runs post-spawn, so the agent boots before a model id is known. Pool-claimed sessions are NOT in this bucket: the worktree pool (`src/server/agent/worktree-pool.ts`) pre-creates git worktrees only, not agent processes, so they go through the same `resolveBridgeOptions` → `new RpcBridge` path as a non-pool spawn.

Unit coverage in `tests/rpc-bridge-spawn-args.test.ts` and `tests/review-model-override.test.ts`. See [docs/internals.md — Spawn-time model pinning](internals.md#spawn-time-model-pinning).

## Archived session footer shows placeholder model

Loading an archived session shows `claude-opus-4-6` (the client-side placeholder) instead of the real persisted model.

- The fix is `buildArchivedStateData(archived, sessionManager, sessionId)` in `src/server/ws/handler.ts`, called on the archived auth-ok branch after `session_title`. If the helper isn't being invoked, the client never receives a `state` frame on first connect and the placeholder persists.
- Verify `archived.modelProvider` / `archived.modelId` are present in the session-store row — the helper omits `data.model` when either is missing, leaving the footer empty.
- The same helper backs the legacy `get_state` handler, so the reconnect path is automatically consistent.
- The client placeholder seed in `src/app/remote-agent.ts` is a known leftover and out of scope — the footer is correct as long as the server-side push lands.
- E2E coverage: `tests/e2e/ui/archived-session-model.spec.ts` (uses `window.__bobbitState` and `data-testid="footer-model-id"`).

See [docs/internals.md — Archived-session state push on auth](internals.md#archived-session-state-push-on-auth).

## Session persistence

- Check `<project-root>/.bobbit/state/sessions.json` (per-project, not centralized)
- Initial persist happens via `persistOnce()` in `session-setup.ts` — a single `store.put()` with all structural fields at creation time
- `persistSessionMetadata()` only calls `store.update()` (never `store.put()`) — updates `agentSessionFile` once the agent reports it
- `persistSessionMetadata()` retries 3 times with backoff (500ms, 1s, 2s) on failure
- `sandboxed` is a typed field on `SessionInfo` (no `(session as any)._sandboxed` hack)
- `restoreSessions()` in `session-manager.ts` skips sessions with missing `.jsonl` files
- Failed restores create dormant entries that revive on client connect
- **Server restarts are safe** — restarting the gateway never deletes worktrees, terminates sessions, or purges archives. All agent work survives intact. Orphaned resources can be cleaned up manually via Settings → Maintenance tab or the `/api/maintenance/*` REST endpoints.
- **Session disappears from `sessions.json` but `.jsonl` survives.** Boot recovery first looks for a per-session `<basename>.bobbit.json` sidecar alongside the `.jsonl` (`src/server/agent/session-sidecar.ts`) and reconciles the heuristic record with sidecar fields — sidecar wins (exact bobbit session id, title, role, team links, model). If no sidecar exists, falls back to the heuristic reconstruction in `team-store-consistency.ts` (fresh UUID, fun-name title, role parsed from worktree slug). Backfill on boot writes sidecars for legacy sessions so any future loss event becomes exact-recoverable.

## `system-prompt.md` not customised

- Resolver: `resolveSystemPromptPath()` in `src/server/agent/system-prompt.ts` returns the user override at `<bobbitConfigDir>/system-prompt.md` only if that file exists, otherwise falls back to the shipped `dist/server/defaults/system-prompt.md`.
- The file is **no longer scaffolded on startup**. A fresh install has no `.bobbit/config/system-prompt.md` and runs entirely on the shipped default — expected behaviour.
- To customise: click "Customise system prompt" in Settings → General (or `POST /api/system-prompt/customise`). This copies the current default into `.bobbit/config/system-prompt.md` once; the user is then expected to edit that file.
- After editing the user override, restart the server (path is resolved at startup and passed to agents — see [dev-workflow.md](dev-workflow.md)).
- `isSetupComplete()` (in `src/server/setup-status.ts`) treats the *existence* of `.bobbit/config/system-prompt.md` as the customisation signal — there is no longer a trim-compare against the default template.

## Abort, steer & queue

- **History note**: the steer-subsystem rewrite (commits `f37aadd8`, `3d3d34cd`, `377f4bb7`, `6ed08fc9`) plus follow-ups (#477 abort-race, #478 listener-ordering, #480 `bash_bg wait` end-of-turn hint) were reverted on `master` during a freeze investigation, then restored on `goal/restore-st-ac566fee` once the freeze was isolated to PR #514 (WS `emitSessionEvent` refactor, intentionally still absent). All entries below describe the restored behaviour. See [docs/design/steer-subsystem-rewrite.md](design/steer-subsystem-rewrite.md) for the full design.
- **Session status values**: `idle`, `streaming`, `preparing`, `dormant`, `terminated`, and `aborting`. The `aborting` status is broadcast immediately when the user clicks Stop — it covers the up-to-3s grace period before a force-kill. UI shows an "Aborting..." spinner during this state.
- **Steered message duplicated after Stop?** This was the canonical pre-rewrite bug. After the steer-subsystem rewrite (see [docs/design/steer-subsystem-rewrite.md](design/steer-subsystem-rewrite.md)), `PromptQueue` no longer carries a `dispatched` flag and `SessionManager` no longer has `removeDispatched()` / `resetDispatched()`. Exactly-once at the transcript level is enforced by: (1) `_dispatchSteer()` removes rows from `promptQueue` *before* awaiting `rpcClient.steer()`, so the SDK becomes the sole authority for in-flight text; (2) the per-session shadow ledger `SessionInfo.inFlightSteerTexts` records every dispatched batch and is spliced on the matching `message_end(role:user)` echo (`_consumeSteerEcho`); (3) on abort — both the graceful `agent_end while wasAborting` branch and `forceAbort` *after* `rpcClient.stop()` (the ledger is Bobbit-owned in-process state, so post-kill is fine) — `_reconcileAfterAbort()` drains the ledger and re-enqueues entries at the front of `promptQueue` with `isSteered=true`, so `drainQueue()` redispatches the batch exactly once after the new agent comes up. If a steer is duplicated, look at: ledger entries that weren't spliced on the echo (text-match drift between dispatch and `message_end`), `_reconcileAfterAbort` running twice without clearing the ledger between calls, or a row remaining in `promptQueue` after `_dispatchSteer` already removed it (impossible by construction, but verify `remove(id)` returned true for every ledger push).
- **Steered messages lost after abort?** Look in this order: (1) was the steer dispatched at all — check the `_dispatchSteer` removed the row from `promptQueue` before awaiting RPC, and `inFlightSteerTexts` has the entry; (2) did `_reconcileAfterAbort` run — it's invoked on `agent_end while wasAborting` *and* in `forceAbort` immediately *after* `rpcClient.stop()` (the ledger is in-process Bobbit state, so it survives the kill either way); (3) did the post-respawn `drainQueue()` pick up the re-enqueued steered batch — it should pop them via `dequeueAllSteered()` and dispatch via `prompt` (idle path), not `steer`. The remaining residual at-least-once race is a hard kill that lands between `rpcClient.steer()` resolving and the SDK's synchronous `_steeringMessages.push` — orders of magnitude smaller than the pre-rewrite always-on at-least-once contract.
- **Direct live-steer (WS `{type:"steer"}`) lost when user clicks Stop?** PI-25b path. `SessionManager.deliverLiveSteer()` enqueues the row in `promptQueue` with `isSteered=true` and forwards to the single `_dispatchSteer` site. `_dispatchSteer` removes the row, awaits `rpcClient.steer(batchText)`, and pushes to the shadow ledger on success. Cleanup paths: happy-path — `_consumeSteerEcho` splices the entry on the `message_end(role:user)` echo; abort — `_reconcileAfterAbort` drains the ledger and re-enqueues at front. RPC-layer failure rolls the row back to the front of `promptQueue` via `enqueueAtFront()` so the next turn-boundary or post-restart drain picks it up. See PI-25b / PI-25c (`tests/e2e/abort-status-e2e.spec.ts`) and the new gateway-restart and reconnect tests (`tests/e2e/steer-gateway-restart.spec.ts`, `tests/e2e/steer-reconnect.spec.ts`).
- **Steered message briefly disappears from chat and reappears after the next prompt?** Dispatch→echo continuity race. `_dispatchSteer()` removes the queue row and broadcasts the empty queue before awaiting `rpcClient.steer()`; the SDK only echoes the text back as `message_end(role:user)` after a roundtrip, and the agent only flushes that echo to `.jsonl` then. A snapshot taken in that window (visibility resync, WS reconnect resume-fallback, second tab) sees neither the queue pill nor the user row. Fixed by `spliceInFlightSteers()` (`src/server/agent/splice-inflight-message.ts`), which appends a synthetic user-role row for every `session.inFlightSteerTexts` ledger entry not already present in the snapshot. Wired at `ws/handler.ts::get_messages`, `session-manager.ts::refreshAfterCompaction`, and the post-respawn `broadcast({type:"messages"})` site. Synthetic rows carry id prefix `inflight-steer:` and are reconciled into the real echo via the H3 reducer machinery (multiset dedup + `_order > snapshotMaxOrder` survivor guard + prior-snapshot artifact drop). If the symptom returns, check the splice helper is being called at all three sites and that the ledger isn't being cleared prematurely (the entry should live from `_dispatchSteer` push until `_consumeSteerEcho` or `_reconcileAfterAbort` removes it). See [docs/design/snapshot-live-race-fix.md §9](design/snapshot-live-race-fix.md#9-steer-continuity-splice-companion-fix).
- **Steered messages arriving one-at-a-time instead of batched?** `drainQueue()` batches all consecutive steered messages at the front of the queue via `dequeueAllSteered()`. If they arrive separately, check that the messages are all marked `steered: true` and are contiguous at the front of the queue (non-steered messages in between will break the batch).
- **Draft lost on rapid session switch?** The client awaits any in-flight `_pendingSave` promise before loading the draft for the new session. If drafts are still lost, check that `_flushDraft()` is returning its save promise and that `_setupPromptDraftHandlers()` awaits it.
- **Draft not restoring after session switch?** Draft restore uses a `requestAnimationFrame` retry loop (up to 5 frames) to survive Lit re-renders that reset the editor value. If the draft still doesn't appear, check that the rAF `reapply` callback is firing (add a `console.log` inside it) and that `_draftSessionId` hasn't been nulled by a concurrent session switch.
- **`bash_bg wait` not returning after a steer?** A steer (user-initiated or `team_steer`) should abort any in-flight `bash_bg wait` within ~100ms so the agent isn't stuck inside a tool call. The bg process itself is **not** killed — only the wait call resolves with `{ aborted: true }`, and the shell extension emits `Process <hdr> wait interrupted by steer. Use 'logs' or 'wait' again to continue monitoring.`. If waits are still blocking: (1) verify the live-steer caller routes through `SessionManager.deliverLiveSteer()` — this is what invokes `bgProcessManager.abortAllWaits(sessionId)` before forwarding to `rpcClient.steer()`. Call sites: `ws/handler.ts` `case "steer"`, `team-manager.ts` `injectSteerMessage`/task-completion nudge, and `SessionManager.drainQueue()`'s steered-batch branch. (2) Check the wait registry on `BgProcessManager` — `registerWait(sessionId, controller)` is called by the `/bg-processes/:pid/wait` REST handler and `unregisterWait` in its `finally`; `abortAllWaits(sessionId)` iterates the set. (3) `terminateSession` also calls `abortAllWaits()` before `cleanup()` so a terminating session never leaks a hung wait HTTP handler. Unit tests in `tests/bg-process-manager.test.ts`; E2E round-trip in `tests/e2e/bg-wait-steer-abort.spec.ts`.
- See [prompt-queue.md](prompt-queue.md) for the full queue architecture and [prompt-queue.md — Abort and force-kill recovery](prompt-queue.md#abort-and-force-kill-recovery) for the force-kill flow.

## Session wedged after errored turn

- **Symptom**: a turn ended with `stopReason:"error"` (`session.lastTurnErrored=true`), and the next prompt or steer never seems to dispatch — the agent sits silent and the sender (user or team lead) thinks their message was dropped.
- **Expected behaviour**: a fresh prompt or steer should **implicitly unstick** the session. `SessionManager.enqueuePrompt` and `SessionManager.deliverLiveSteer` (`src/server/agent/session-manager.ts`) check `session.lastTurnErrored`; if set and `session.consecutiveErrorTurns < MAX_CONSECUTIVE_ERROR_TURNS` (= 3), they clear the error flag, cancel any `pendingAutoRetryTimer`, prepend a short `[SYSTEM: previous turn failed with: …. Ignore the incomplete last turn and handle the following.]` stub, and dispatch the new message. The failed turn is **not** retried — the incoming message is the new authoritative intent.
- **Why a cap?** Without one, a persistently broken upstream (quota exhausted, auth revoked, content filter) would be re-triggered on every incoming nudge. `consecutiveErrorTurns` increments on every `message_end` with `stopReason:"error"` and resets to 0 on any successful `message_end`. At the cap (3) messages park in `promptQueue` (today's pre-fix behaviour) and a `[session-manager] Session … has N consecutive errors; parking incoming prompt. Human action required…` line is logged. Parked items drain automatically once the underlying issue is fixed and the user clicks Retry.
- **Explicit UI Retry always works**. `retryLastPrompt` bypasses the cap and resets `consecutiveErrorTurns` to 0 on success — a deliberate human action shouldn't erode the budget.
- **Still seeing messages disappear?** Check:
  1. `[session-manager] Session … implicit unstick from enqueuePrompt (consecutiveErrorTurns=…)` or `… from deliverLiveSteer` log lines — if missing, the call didn't reach the helper. Steers must route through `SessionManager.deliverLiveSteer()` (see the abort/steer section above).
  2. `consecutiveErrorTurns` on the session info — if it's ≥ 3, the cap is parking. Click Retry or fix the upstream.
  3. Team-lead nudges to an errored worker: no longer suppressed in `team-manager.ts` (the old `if (teamLeadSession.lastTurnErrored) return;` guard was removed). SessionManager is now the single source of truth for error-state policy.
- **Related**: previous mitigation was pattern-matching on error text via `TRANSIENT_ERROR_PATTERNS` + bounded auto-retry (`transientRetryAttempts`, `maybeAutoRetryTransient`). That path still exists for quick in-band recovery; the implicit-unstick path is the structural fallback when the whitelist doesn't match.

## "Setting up worktree…" banner missing on a brand-new session / preparing UX absent

- **Symptom**: user creates a new session before the worktree pool has filled (typical on cold boot). The chat panel mounts but no "Setting up worktree…" banner appears, the message editor stays enabled, the user types and clicks send, and the message lands silently in the prompt queue. The system-prompt viewer shows the project root as `cwd`, not a worktree path — confirming the session is still preparing while the UI claims it's ready.
- **Why this happens (two compounding bugs)**:
  1. **Version-gate dropped the first frame.** The server creates new sessions with `statusVersion: 0` and immediately broadcasts `session_status: "preparing"`. The client tracks `_lastStatusVersion` on `RemoteAgent` and ignores any frame whose version is `<= _lastStatusVersion`. Pre-fix `_lastStatusVersion` initialised to `0`, so the very first frame failed the `0 <= 0` gate and `_state.status` was never written. The server-stamped baseline from `case "state"` *did* set the status correctly on attach, but only on the next reload — not on the live new-session path where `state` arrives with the same `statusVersion: 0` it raced.
  2. **`requestUpdate()` was too narrow.** Even when `_state.status` flipped correctly, the UI didn't repaint. `RemoteAgent.onStatusChange` (in `src/app/session-manager.ts`) only called `agentInterface.requestUpdate()` for `"aborting"` and `"idle"`; `"preparing"` and `"starting"` fell through to the global `renderApp()` debounce. Lit's reference-equality short-circuit then refused to re-render the freshly-mounted `<agent-interface>` because `state` was the same object — the status mutation lived inside it. Net effect: even with bug 1 fixed, the banner wouldn't show on the new session.
- **Fix invariants** (do not regress):
  - `_lastStatusVersion` initialises to `-1` (uninitialised sentinel). The version-gate semantics for subsequent frames are unchanged — only the bootstrap is loosened.
  - `RemoteAgent.onStatusChange` calls `agentInterface.requestUpdate()` for `preparing` / `starting` / `aborting` / `idle`. Do not narrow this list back to aborting/idle. The Lit reference-equality issue applies to *every* status change because `_state` is the same object.
  - `case "session_status"` remains the sole client writer of `_state.status` (plus `case "state"` on attach and `reset()` on navigate, per [unify-session-status.md](design/unify-session-status.md)). The fix did not introduce a new writer.
- **How to diagnose if it regresses**:
  1. In DevTools → Network → WS, watch the inbound frames after creating a new session. There should be exactly one `session_status` frame with `status: "preparing"` and `statusVersion: 0`, followed later by another with `idle`.
  2. Add a `console.log` at the top of `case "session_status"` in `src/app/remote-agent.ts`. If the preparing frame arrives but the log fires only once (for `idle`), the version gate is wrong — inspect `_lastStatusVersion` initial value.
  3. If the log fires twice but the banner never paints, the `onStatusChange` re-render branch is the culprit. Confirm `agentInterface` is non-null at the call site (the new chat panel may finish its first paint *after* the frame; the `requestUpdate` call is a no-op then, but the next render pass picks up `state.isPreparing` correctly — no race in practice).
  4. Reload during preparing. The server replays current status on `auth_ok` (`src/server/ws/handler.ts`). If the banner still appears, the live-path bug is the regression; if it doesn't, the replay path also broke — inspect the `auth_ok` write path.
- **Regression test**: `tests/e2e/ui/preparing-ux.spec.ts` (browser E2E). It artificially extends the preparing window so the banner is observable, asserts visibility + editor disabled, then asserts both clear once the session goes idle.

## Compaction

- Check `_isCompacting` and `_usageStaleAfterCompaction` in `remote-agent.ts`. The compaction placeholder is a reducer action (`compaction-placeholder` / `compaction-result`) — see `src/app/message-reducer.ts`.
- `compacting_placeholder` must be filtered and re-added correctly across server refreshes — the reducer drops the synthetic when a snapshot row carries the server-persisted compaction marker (id-match, with `"Context compacted"` text fallback for legacy snapshots).
- **Card disappears after navigate-away or reload** — the server-side sidecar splice did not run. Check that `mergeCompactionSidecarIntoMessages` is wired into both the `get_messages` WS handler and `refreshAfterCompaction`. Sidecar file: `<stateDir>/compaction-sidecar/<sessionId>.jsonl`. See [docs/compaction-history.md](compaction-history.md).

## Goal creation fails with `Workflow not found: general`

**Symptom:** Clicking Accept on a goal proposal (from +New Goal or the goal assistant) returns 400 with `Workflow not found: general`, or — for a project whose store is empty — with the `NO_WORKFLOWS_MSG` body.

- `"general"` is no longer a built-in default. Workflows are project-scoped; a project may have any set of ids, or none at all. If a stale code path is still sending `workflowId="general"`, the pinning test [`tests/no-general-workflow-default.test.ts`](../tests/no-general-workflow-default.test.ts) should have caught it — re-run `npm run test:unit` and look for the failing scan of `src/server/agent/` or `src/app/`.
- **Server-side resolution (POST /api/goals in `src/server/server.ts`)** runs four layers before delegating to `GoalManager.createGoal`: (1) `configCascade.resolveWorkflows(projectId)` lookup by id; (2) **project store fallthrough** — if the cascade misses, try `targetCtx.workflowStore.get(workflowId)` directly (this is what eliminates the historical "refresh fixed it" symptom caused by a stale cascade after archive/create cycles); (3) **auto-seed defaults** if the project's workflow store is entirely empty, then re-resolve (fires for both explicit-id and no-id bodies); (4) if an explicit id is still unknown in a non-empty store, return `400 { code: "WORKFLOW_NOT_FOUND", workflowId, available: [...] }` via `jsonError` instead of a 500 crash. The UI surfaces the `message` field in the standard `showConnectionError("Failed to create goal", …)` toast; `available` is included so callers can render "did you mean…" hints. When `body.workflowId` is absent, the handler now passes `undefined` to the manager (the old `"general"` magic default was removed), and `GoalManager.createGoal`'s own "first workflow in store" fallback handles it.
- The downstream resolution rule (`GoalManager.createGoal` in `src/server/agent/goal-manager.ts`): explicit `workflowId` → first workflow in `workflowStore.getAll()` (insertion order) → `NO_WORKFLOWS_MSG`. The UI mirrors this — `_selectedWorkflowId` / `_proposalWorkflowId` in `src/app/render.ts` are seeded from the first cached workflow once `fetchWorkflows` resolves, never from a literal id.
- Pinning tests: [`tests/api-goals-workflow-not-found.test.ts`](../tests/api-goals-workflow-not-found.test.ts) covers the cascade-miss / store-hit success, the cascade-miss / store-miss 400 with `available`, and the no-`workflowId` first-workflow fallback. [`tests/e2e/goal-creation-auto-seed.spec.ts`](../tests/e2e/goal-creation-auto-seed.spec.ts) covers the empty-store auto-seed path end-to-end.
- If the project genuinely has zero workflows and auto-seed cannot supply one, the user must run the project assistant. The goal preview panel renders an empty-workflows banner in this state (see next entry). If the banner does not render but `createGoal` still fails with `NO_WORKFLOWS_MSG`, the workflow cache for the linked project is stale or the `wfState` derivation is mis-computing — grep `src/app/render.ts` for `_workflowCacheByProject` and the `wfState` switch.
- Full convention: [docs/goals-workflows-tasks.md — Default workflow resolution](goals-workflows-tasks.md#default-workflow-resolution).

## Goal accept dismisses the assistant before showing the error

**Symptom:** Clicking Accept on a goal-assistant proposal that fails server-side (workflow missing, project not registered, etc.) closes the assistant panel, clears the chat, and lands the user on the landing page with only a toast as feedback. The session, draft, and conversation are gone.

- Fix lives in `src/app/render.ts` in **both** accept handlers (the goal-preview panel handler and the `propose_goal` proposal-toast handler). `createGoal()` must be awaited **before** any destructive teardown — disconnecting the remote agent, clearing the active view, deleting the draft, removing `gateway.sessionId`, and navigating away all live in the success branch only.
- On failure the standard `showConnectionError("Failed to create goal", …)` toast surfaces the server's error message; the assistant, chat, `gatewaySessions` entry, and form state remain so the user can retry or ask the assistant to revise. Re-attempt sessions (with `reattemptGoalId`) share the same handler and are covered by the same guarantee.
- Regression test: [`tests/e2e/ui/goal-accept-failure-keeps-assistant.spec.ts`](../tests/e2e/ui/goal-accept-failure-keeps-assistant.spec.ts) — stubs a 400 from `POST /api/goals` and asserts the assistant panel, chat, and `gateway.sessionId` survive.
- Full convention: [docs/goals-workflows-tasks.md — `createGoal` failure preserves the assistant](goals-workflows-tasks.md#creategoal-failure-preserves-the-assistant).

## Goal form has no workflow dropdown / empty-workflows banner missing

**Symptom:** The goal preview panel shows no workflow `<select>` and no empty-workflows banner — either the dropdown is missing on a project that has workflows, or the banner is missing on a project that has none.

- Derivation lives in `src/app/render.ts` — search for `wfState` (computed by the helper near the top of the file) and its `"loading" | "empty" | "ready"` states. While `"loading"`, the panel renders a skeleton to prevent banner flicker; `"empty"` renders the banner + disabled Accept; `"ready"` renders the dropdown.
- If a project with workflows shows the banner: the per-project workflow cache (`_workflowCacheByProject`) was not populated. Confirm `ensureWorkflowsLoaded(projectId)` is being called when the linked project changes and that the fetch resolved (DevTools → Network → `GET /api/workflows?projectId=…`). The cache is keyed by `projectId`, so switching projects without re-resolving the cache is the usual culprit.
- If a project with zero workflows shows neither the banner nor the dropdown: `wfState` is stuck in `"loading"`. Check for a fetch error suppressed without clearing the loading flag.
- The banner's **Open Project Assistant** button calls `createProjectAssistantSession(linked.rootPath, false, { projectId, existingProjectName })` from `src/app/dialogs.ts`. If the button does nothing, verify `linked` resolves to the project record (not just an id).
- Regression test: [`tests/e2e/ui/goal-empty-workflows-banner.spec.ts`](../tests/e2e/ui/goal-empty-workflows-banner.spec.ts).
- Full convention: [docs/goals-workflows-tasks.md — Goal creation in a zero-workflow project](goals-workflows-tasks.md#goal-creation-in-a-zero-workflow-project).

## Goal proposal dismissed but reappears

- Proposals now use `propose_*` tool calls (e.g. `propose_goal`), which persist in message history as tool result blocks. Each completed proposal block includes an "Open proposal" button for re-access — proposals are no longer lost on reconnect or cache eviction.
- localStorage key: `bobbit-goal-proposal-dismissed-<sessionId>` stores djb2 hash of `title + "\n" + spec`
- Check: (1) key exists for session, (2) hash matches, (3) session is not goal-assistant type (those use IndexedDB)
- Cleanup: `clearDismissedProposal()` in `terminateSession()`
- Legacy XML proposal parsing (`proposal-parsers.ts`) still works as a deprecated fallback — check console for `[proposal] Detected legacy XML proposal block` warnings

## Dismissed proposal restored on reload

**Symptom:** User dismisses a goal/role/project proposal panel. Reload the page (or trigger a WS reconnect/rehydrate) without any further agent activity. The panel reappears with the same content. The dismissal fingerprint check (`isProposalDismissedTyped`) works for fresh `proposal_update` events but is bypassed when the slot is rehydrated from the persisted server-side draft.

**Root cause:** The draft `restore` callbacks in `src/app/session-manager.ts` (`goalDraft`, `roleDraft`, `projectDraft`) used to unconditionally write `state.activeProposals.<type> = { fields: draft.active<Type>Proposal, ... }` whenever the draft contained a serialized proposal. The dismissal fingerprint stored in localStorage by `markProposalDismissed` was never consulted at restore time, so the slot was rebuilt and the panel re-opened. Dismiss only deletes the in-memory slot — it intentionally does NOT delete the on-disk draft (see below) — which made the persisted draft a silent re-open path on every reload.

**Fix location:** `src/app/session-manager.ts` — each draft's `restore` callback now calls `isProposalDismissedTyped(sessionId, type, fields)` before populating `state.activeProposals.<type>`. When the fingerprint matches, the slot is left undefined and the proposal-mirror preview fields (`previewTitle`, `previewSpec`, etc.) are zeroed so the form doesn't flash dismissed content. The same gate is applied in three places: `goalDraft.restore`, `roleDraft.restore`, `projectDraft.restore`. First-emit dismissal short-circuits were also added to the legacy `onGoalProposal` / `onRoleProposal` callbacks fired during the post-attach message rescan, so the rescan can't re-fill the form fields after restore correctly zeroed them.

**Why we don't delete the draft on dismiss:** The draft is more than just the proposal — it carries the form-mirror state (edited flags, `previewTitle`, in-progress edits) and is the rehydration source if the agent later calls `edit_proposal` or the user clicks "Open proposal" on a tool card. Deleting on dismiss would lose that work. Gating at the restore path keeps the draft intact while honouring the dismissal until content actually changes (fingerprint mismatch) or the user explicitly re-opens the panel.

**Affected proposal types:** Only `goal`, `role`, and `project` have `createDraftManager` / restore paths. `staff`, `tool`, and `workflow` have no draft persistence — their slots are transient and cleared unconditionally on session attach, so they were never affected.

**Regression test:** `tests/e2e/ui/goal-proposal-dismiss-reload.spec.ts` (browser E2E) — emits a `propose_goal`, dismisses the panel, reloads, asserts panel stays closed, then emits a fresh `propose_goal` with different content and asserts the panel reopens.

## Re-attempt project binding

**Symptom:** In a re-attempt assistant session, clicking "Create Goal" on the assistant's `propose_goal` panel fails with the toast `"No project selected for this goal — The assistant session is not linked to a project. Dismiss this proposal and start a new goal from the + New Goal button."` The proposal panel has no project picker of its own, so the user is stuck. The session itself carries the inherited `projectId` server-side (populated from `reattemptGoalId`), but the UI guard at `goalProposalPanel()` only ever consulted `state.previewProjectId`, which is owned by the **+ New Goal** picker (`goalPreviewPanel`) and is never set in re-attempt flows.

**Fix location:** `src/app/render.ts::goalProposalPanel()` *and* `src/app/render.ts::goalPreviewPanel()`. The same populate-block lives in both: at panel-render time, when `state.previewProjectId` is empty, derive it in this order and write it back into state:

1. **Active session's `projectId`** — the server already populates this on re-attempt sessions from the original goal's project.
2. **Original goal's `projectId` via `reattemptGoalId`** — fallback if the session hasn't picked up its `projectId` yet. Look up the goal in `state.goals` (a flat array containing both live and archived goals — there is no separate `state.archivedGoals` top-level property).
3. **`cwd`-match against registered `project.rootPath`s** — if the proposal frontmatter carries a `cwd` (the assistant's `propose_goal({ cwd })`), match it case-insensitively with normalised slashes against each entry of `state.projects`.

The existing guard remains as a last-line safety net for genuinely unbindable proposals. The same fix is applied to `goalPreviewPanel()` (the + New Goal picker) so direct entry into that panel from re-attempt / assistant context also binds the project — both panels share the resolution chain to keep behaviour symmetric.

**Diagnostic order when this regresses:**

1. Confirm `currentSession.projectId` is set server-side (`GET /api/sessions/:id` or check the WS `state` frame). For re-attempt sessions, this should be inherited from the original goal — if it's missing, the regression is server-side in the re-attempt session-creation path (`buildReattemptContext()`), not in the panel.
2. Confirm the project still exists in `state.projects` (UI-side). If the project was removed after the original goal was archived, no fallback can recover it — the toast is correct.
3. Check the populate-block in `goalProposalPanel()` / `goalPreviewPanel()` actually ran. It short-circuits when `state.previewProjectId` is already set, so a stale value from an earlier + New Goal interaction in the same tab can mask this path. Trigger via session navigation or a page reload.
4. For `cwd`-only resolution, normalise both sides before comparing: lowercase + replace `\\` with `/` + strip trailing slash. Windows worktrees compose paths with backslashes; registered `rootPath` may use either separator. A direct `===` compare will silently miss.

**Server-side note:** `POST /api/goals` already accepts `projectId` *or* resolves a project from `cwd` via `resolveProjectForRequest`. The bug was purely UI-layer — the server was always willing to bind. Don't add server-side fallbacks here.

**Regression test:** `tests/e2e/ui/goal-reattempt-project-binding.spec.ts` (browser E2E) — opens a re-attempt assistant against a project-bound goal, emits `propose_goal`, clicks Create, asserts the new goal is created with the inherited `projectId` and no toast fires.

## Render performance

- `renderApp()` debounced via `requestAnimationFrame` — multiple calls collapse
- For synchronous DOM updates, use `renderAppSync()`

## Scroll snap-back / vibration / tail-chat lost / false-positive Jump button

- **Symptom (master pre-fix)**: in a streaming session, the chat stops following the bottom mid-stream, and/or the Jump-to-bottom pill appears even when scrollTop is already at the bottom. Both regressions also reproduce on iOS PWA.
- **Root cause in one line**: post-PR-#468 the JS pin path (`_stickToBottom` flag + `_programmaticEchoes` ring + `_pinIfSticking`) became the single contract (CSS `overflow-anchor: none` retained), but it lacked resize-vs-scroll disambiguation, a near-bottom relock band, an overscroll clamp, and a paint-vs-RO race defense — all of which Chromium's deleted `overflow-anchor: auto` had been silently masking.
- **Where the fix lives**: `src/ui/components/AgentInterface.ts` — the scroll-lock subsystem is now a vanilla-TS port of [`use-stick-to-bottom`](https://github.com/stackblitz-labs/use-stick-to-bottom). Two-flag intent model (`_isAtBottom` + `_escapedFromLock`); `STICK_TO_BOTTOM_OFFSET_PX = 70` near-bottom band (auto-relock when user scrolls back within 70 px of bottom); `_resizeDifference` records RO delta and the deferred scroll handler (`setTimeout(0)`) bails when non-zero; `_ignoreScrollToTop` single-value latch replaces the echo ring; capture-phase `_imageLoadHandler` covers the paint-vs-RO race for async image/iframe decode; `scrollToBottom({ animate })` provides a Promise-returning spring path used by jump-click. User-intent listeners (wheel/touchstart/keydown) are the only synchronous writers of `_escapedFromLock = true; _isAtBottom = false`. `_stickToBottom` and `_programmaticEchoes` survive as compat shims routing to the new model.
- **Invariant**: see [docs/internals.md — Chat scroll lock invariant](internals.md#chat-scroll-lock-invariant) for the full state inventory and contract. Do NOT re-introduce the deleted defenses listed there — `_wasAtBottomAtLastUserScroll`, the `_settleWindowActive`/`_settleWindowDeadline` settle window, `_suppressJumpUntilTs`, geometry-based intent flips in the scroll handler, the `_programmaticEchoes` ring buffer as primary echo mechanism, the 10 px stickiness tail, or the "single source of truth" `_stickToBottom`-only model. Each was masking a race introduced by an earlier layer; reaching for one means the bug is elsewhere. `_imageLoadHandler` is NOT in the do-NOT-re-add list — it was restored.
- **Repro tests**: 9 tail-chat E2E specs in `tests/e2e/ui/tail-chat-*.spec.ts`. Notably `tail-chat-jump-button-false-positive.spec.ts` is the deterministic reproducer for the false-positive Jump button; `tail-chat-near-bottom-relock.spec.ts` covers the 70 px auto-relock band; `tail-chat-tool-expand-reflow.spec.ts` covers `<details>` toggle reflow; `tail-chat-image-reflow.spec.ts` covers the paint-vs-RO race that motivates `_imageLoadHandler`. All tests are outcome-only (`getBoundingClientRect()` + computed style) — never assert on private fields. The full sensitivity matrix mapping each defense to the test that fails when neutered lives in [docs/design/tail-chat-redesign.md — Outcome of the use-stick-to-bottom port](design/tail-chat-redesign.md#outcome-of-the-use-stick-to-bottom-port).

## Stale messages trailing after newer ones on session navigate

- **Symptom**: switching to a session via the sidebar shows older messages (often a synthetic compaction marker or a stale permission card) appended *after* the latest server-persisted messages. A hard reload fixes it; the bug is client-side merge order.
- **Root cause in one line**: pre-reducer, multiple bucket assignments (`_state.messages = snapshot` followed by unconditional pushes from independent buckets) placed entries after newer snapshot messages.
- **Where the fix lives**: the unified reducer in `src/app/message-reducer.ts`. Snapshot rows are stamped with `_order = SNAPSHOT_ORDER_FLOOR + i` (negative integers — strictly less than any live `seq`); live events get their server-stamped positive `seq`. The reducer sorts the combined array by `(_order, _insertionTick)`. The `snapshot` action is authoritative for any id it contains: client-side rows whose id appears in the snapshot are dropped, and a `"Context compacted"` text-prefix fallback drops the synthetic compaction marker when the server has its own.
- **Invariant**: see [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant). The server snapshot is authoritative for any id it contains; reducer-side optimistic / synthetic / permission rows only fill in gaps.
- **Repro test**: `tests/message-reducer.test.ts` — pure unit tests of the reducer. Scenarios 4, 5, 10, 12 exercise the snapshot-merge invariant directly.

## Plain-text messages duplicated on new-tab open

- **Symptom**: opening Bobbit in a second browser tab in the same browser context causes the **original** tab's currently-viewed live session to render plain-text assistant replies 2-3x. Each subsequent tab open / focus return adds another copy. Refresh fixes it until the next visibility tick. Tool-call / tool-result rows are unaffected — only plain-text rows duplicate.
- **Root cause in one line**: the snapshot survivor filter in `src/app/message-reducer.ts` deduplicated by `id` / `toolCallId` / inner `toolCall.id` only; id-less or id-mismatched live `message_end` plain-text rows passed through alongside the snapshot's regenerated-id copy, and the `visibilitychange` handler in `src/app/remote-agent.ts::_onVisibilityChange` re-ran `requestMessages()` on every tab-focus tick.
- **Where the fix lives**: defence in depth across two files. `src/app/message-reducer.ts` adds a fourth survivor-filter equivalence tier for plain-text rows keyed on `(role, normalisedText)` via the new `isPlainTextRow` and `normaliseText` helpers (skipped for `toolResult` rows — see [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant)). `src/app/remote-agent.ts` adds `_hadDisconnectSinceLastSnapshot` (set true on `ws.onclose`, cleared after every successful snapshot apply); `_onVisibilityChange` now skips `requestMessages()` when the WS stayed connected AND `state.messages.length > 0`. `get_state` still fires on every visibility tick.
- **Diagnostic chain**:
  1. **Which tab shows the dup — original or new?** Original = this bug. New tab = a different bug (the new tab's reducer state is empty when its first snapshot lands, so it cannot produce duplicates this way; investigate elsewhere).
  2. **Does it persist across refresh?** Refresh resets the reducer to `initialState()`, so the first post-refresh snapshot has nothing to merge against and the bug disappears — it only re-appears if a new visibility tick fires (e.g. opening yet another tab). If the dup survives a refresh with no further tab activity, this is **not** the new-tab bug.
  3. **Is the visibility short-circuit firing?** Add a `console.log` at the top of `_onVisibilityChange` after the `needsResync` computation; expected: `needsResync === false` on every tick after the first successful snapshot, until the WS drops. If `_hadDisconnectSinceLastSnapshot` reads `true` on a session that's been idle and connected, look for an unexpected `ws.onclose` — reconnect storms re-arm the flag legitimately.
  4. **Does `extractText(m)` return non-empty for the live row?** The plain-text dedup tier skips rows whose normalised text is empty (so an empty placeholder live row can't collide with a snapshot row's text). If the live row is empty, no dedup happens and the dup is a different bug.
  5. **Is the live row plain text and server-origin?** Confirm `m._origin === "server"` and `isPlainTextRow(m) === true` (no `toolCall` content, role is not `toolResult`). Tool-bearing rows go through tiers 2/3 of the survivor filter, not tier 4.
- **Invariant**: see [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant). The survivor filter has four tiers; do not extend tier 4 (plain-text) to `toolResult` rows — that re-opens the related bash_bg.wait dup bug. Closely-related entry: the [bash_bg.wait toolResult / toolCall-bearing assistant card duplicated after snapshot replay](../AGENTS.md) entry in AGENTS.md (same survivor filter, tiers 2 and 3).
- **Repro test**: `tests/e2e/ui/new-tab-no-duplicate-messages.spec.ts` (canonical regression — opens the same session in multiple browser contexts and asserts message count is identical and stable).

## Out-of-order proposal / `ask_user_choices` widgets

- **Symptom**: a `propose_*` proposal panel or an `ask_user_choices` card renders in the wrong position in the transcript, vanishes after appearing briefly, or only shows up after a manual page refresh. Strongly correlated with rapid bursts of widget-bearing assistant turns and with WS reconnects mid-burst. The classic pre-reducer failure mode ("Mode A"): a widget-bearing assistant message landed in the single mutable `_deferredAssistantMessage` slot waiting for a future event to flush it, and a second deferred message silently overwrote the first.
- **Root cause in one line**: pre-reducer the client had eight overlapping ordering mechanisms with no shared key; widget-bearing turns took the deferred-slot path which had no second-arrival protection. The fix collapses all eight into the pure reducer in `src/app/message-reducer.ts` with a single `(_order, _insertionTick)` sort key; widgets are ordinary `live-event` actions stamped with the server `seq`, no special slot.
- **Where the fix lives**: `src/app/message-reducer.ts` (pure `reduce(state, action)`); `src/app/remote-agent.ts` is a thin dispatcher; server-side `src/server/agent/event-buffer.ts::pushFrame` stamps `seq` on live frames including `tool_permission_needed`, and `src/server/ws/handler.ts` stamps `_order = SNAPSHOT_ORDER_FLOOR + i` on `messages` snapshot rows so every snapshot order is strictly less than every live `seq`.
- **Invariant**: see [docs/internals.md — Reducer ordering invariant](internals.md#reducer-ordering-invariant) and the design record [docs/design/unified-message-ordering-reducer.md](design/unified-message-ordering-reducer.md). The thirteen reducer actions are the only legitimate transcript-mutating paths.
- **Repro test**: `tests/message-reducer.test.ts` — scenario 8 ("proposal-tool burst": two consecutive `propose_*` assistant turns + matching toolResult, both widgets present in correct order, no overwrite) and scenario 9 (`ask_user_choices` envelope routes to the correct toolUseId). Browser-level: `ST-DEDUP-02` / `ST-DEDUP-03` / `ST-DEDUP-04` in `tests/e2e/ui/stories-streaming.spec.ts`.
- **If the symptom is back**: grep `src/app/` for `_deferredAssistantMessage`, `_liveEventMessages`, `_pendingPermissionCards`, `_compactionSyntheticMessages`, `flushDeferredMessage` — anything other than zero hits means a regression has reintroduced one of the deleted mechanisms. Then verify every `state.messages` write in `remote-agent.ts` goes through `apply(action)` — a stray direct `push` / `splice` / `=` will desynchronise the sort key.

## Proposal panel button enabled mid-stream / scroll resets on delta

- **Symptom**: while a `propose_goal` (or any `propose_*`) tool call is being delta-streamed, (a) the Create / Apply / Save button is clickable and submitting yields a goal with truncated content; (b) the spec preview or edit-mode `<textarea>` snaps `scrollTop` back to the top on each delta; (c) the textarea caret/selection resets every time the agent appends a paragraph.
- **Root cause in one line**: the proposal panel re-renders on every streamed delta and Lit's `.value=` rewrite of the textarea + the markdown-block parent `<div>` resets `scrollTop` and selection on each commit; with no streaming flag the submit button has no reason to disable.
- **Where the fix lives**: `src/app/follow-tail.ts` owns the scroll/selection lock (5px tail, programmatic-scroll echo filter, user-intent listeners, WeakMap-keyed state). `src/app/state.ts` owns `proposalStreamingByTag` and `isProposalStreaming(tag)`. `src/app/remote-agent.ts` (`_checkToolProposals`) is the sole writer, with bulk-clear on `agent_end` / `reset()`. `src/app/render.ts` reads the flag, OR-merges it into the submit `disabled`, renders `streamingBadge()` + `STREAMING_BORDER`, and schedules `reconcileFollowTail` via `queueMicrotask` after each panel render.
- **Invariant**: see [docs/internals.md — Proposal panel scroll lock invariant](internals.md#proposal-panel-scroll-lock-invariant) and [docs/internals.md — Proposal streaming flag](internals.md#proposal-streaming-flag). Do not introduce timer-based intent heuristics; do not widen the 5px tail; do not write to a panel's `scrollTop` or `setSelectionRange` outside `reconcileFollowTail`.
- **Repro / debug**: if the badge / disabled state is stuck on after a turn finishes, the `agent_end` bulk-clear in `RemoteAgent` didn't fire — verify the agent emitted `agent_end` (not just an unclean disconnect) and that `reset()` runs on session switch. If scroll snaps back only on first delta after panel mount, the WeakMap entry is being created with `lastScrollHeight = el.scrollHeight` while content is still 0 — confirm the panel function calls `queueMicrotask(() => reconcileFollowTail(ref.value))` and not a synchronous call.

## Background process pills (BgProcessPill / AgentInterface)

- **Dropdown renders via portal**: `BgProcessPill` appends its log dropdown to `document.body` instead of rendering it inline. This is necessary because the "More" overflow popover uses `backdrop-filter: blur()`, which creates a new CSS containing block — `position: fixed` children behave like `position: absolute` and `mask-image` clips them. If the dropdown appears mispositioned or clipped inside a popover, check that the portal is working (the `#bg-process-dropdown` element should be a direct child of `document.body`, not nested inside the pill or popover).
- **Dismiss for popover pills skips animation**: Pills inside the "More" popover lack the animation wrapper that visible pills have. `_handlePillDismiss` in `AgentInterface` detects hidden (popover) pills and calls `onBgProcessDismiss()` directly instead of waiting for a `pill-fade-out` animation. If dismiss stops working for popover pills, check that the hidden-set detection still matches the overflow logic in `_renderPillStrip()`.

## Gates

- State in `GateStore` (`.bobbit/state/gates.json`)
- Check dependencies via `GET /api/goals/:id/gates`
- **Reviewer flags "branch doesn't match design" on a pre-implementation gate?** That is the classic stale-baseline false positive. Pre-implementation gates (`content: true` with no `depends_on` — e.g. design-doc, issue-analysis) are classified by `isPreImplementationGate()` in `src/server/agent/verification-logic.ts` and the harness must strip all `git diff` / `git log` instructions from the review prompt for them. If a reviewer is still citing branch diffs, check that (1) the role YAML's preamble contains the `{{REVIEW_CONTEXT}}` placeholder (reviewer, architect, spec-auditor), (2) `buildReviewPrompt()` in `src/server/agent/verification-harness.ts` is substituting the pre-impl notice, and (3) no user-override role YAML has re-introduced hardcoded diff commands. Implementation-gate reviewers diff against `origin/<primary>...HEAD` — never local `<primary>`, which can be stale. Full convention: [docs/goals-workflows-tasks.md — Gate verification baselines](goals-workflows-tasks.md#gate-verification-baselines).
- **Verification output modal empty?** The modal has two data sources for step output:
  1. **API bootstrap** — on open, the modal (and its parent) reads accumulated output from `GET /api/goals/:id/verifications/active`. The chat widget (`GateVerificationLive`) seeds its `_stepOutputs` Map from the API in `_fetchAndReconcile()`, and falls back to `this.steps[index]?.output` in `_openModal()`. The dashboard reads `step.liveOutput || step.output`. The modal itself calls `_fetchBootstrapOutput()` as a one-time fetch when `initialOutput` is empty.
  2. **Live WS streaming** — the `/ws/viewer` WebSocket delivers `gate_verification_step_output` events in real-time. Events are dispatched as `gate-verification-event` CustomEvents on `document`; the `VerificationOutputModal` subscribes to these and appends chunks.
  
  If the modal shows "Waiting for output…": first check the API endpoint returns step output (`curl /api/goals/:id/verifications/active` — look for non-empty `output` in the steps array). If the API has output but the modal is empty, the parent component may not be passing it through — verify the fallback chain. If neither source has output, the verification command may not have produced any stdout/stderr yet. For live streaming issues, check that the `/ws/viewer` WS connection is active (browser DevTools → Network → WS tab). The connection opens on dashboard mount and closes on navigation away; it auto-reconnects after 3s on unexpected close.
- **Verify-step runs wrong project's commands** (e.g. `npm run check` on a .NET goal, or bobbit's defaults for a ReqLess goal): `{{project.*}}` variables in command-type steps, LLM-review retry prompts, agent-QA retry prompts, and the QA timeout lookup are all substituted from the goal's owning project's `ProjectConfigStore`, resolved via `resolveProjectConfigStore(goalId)` in `src/server/agent/verification-harness.ts`. If a step runs with the wrong project's commands, (1) confirm the harness was constructed with `projectContextManager` (non-test wiring always passes it), (2) look for `[verification] Goal "<id>" not found in any project context` warnings in the server log — that means PCM has no context for the goal and the harness fell back to the server-level singleton. (3) Any new read of `{{project.*}}` inside the harness must go through the helper, not `this.projectConfigStore` directly.
- **Sandboxed verification commands**: For sandboxed goals, `command` verification steps run inside the project's container via `docker exec`. If command steps show unexpected results (e.g. missing files, stale code), check: (1) is the goal sandboxed (`goal.sandboxed`)? (2) is the project container still running (`docker ps --filter label=bobbit-project=<projectId>`)? If the container is unavailable, the harness falls back to host execution — which won't have the team's commits. Look for "no project container found" warnings in the verification output.
- **Session "view" links**: Verification step and delegate session links navigate in-place via `location.hash` (no new tab). If clicking "view" does nothing, check for JavaScript errors in the console — the click handler sets `location.hash = '#/session/<id>'`.

## Git diff viewer not showing diffs

1. Widget needs `sessionId` or `goalId` + `token`
2. Path sanitization rejects `..` and absolute paths
3. Git command has 5s timeout, 500KB response cap
4. Dropdown renders into portal (`document.body`) — not clipped by overflow
5. `_currentDiffFile` guard prevents stale responses

## Git status widget disappears / stays loading

Widget hides **only** when the server explicitly confirms "not a git repository". Every other failure (500, timeout, abort, network error) must leave the widget visible in either a skeleton or last-known-good state. Architecture in [docs/internals.md — Git status cache & client resilience](internals.md#git-status-cache--client-resilience); full design in [docs/design/git-status-widget-reliability.md](design/git-status-widget-reliability.md).

- **Widget gone entirely after a transient fetch failure?** Check `gitRepoKnown` on the `AgentInterface` (session) or the module-level `gitRepoKnown` in `goal-dashboard.ts`. It is `'yes' | 'no' | 'unknown'` and defaults to `'unknown'` on session connect / dashboard load. Only an HTTP 400 with body `{ error: "Not a git repository" }` flips it to `'no'`. The render gate is `gitRepoKnown !== 'no'` — if the widget is missing while `'unknown'` or `'yes'`, the gate has been short-circuited somewhere.
- **Stuck in "Checking git…" skeleton?** The skeleton renders while `loading && !branch`. Retry lives in `refreshGitStatusForSession` (`src/app/session-manager.ts`): 4 attempts at [0, 500, 2000, 5000]ms. `gitStatusLoading` stays `true` across **all** retries and is cleared only in the final `finally`. If loading never clears, something is resolving attempt 4 without hitting that finally (check console for "git-status refresh failed after retries").
- **Retries not firing / only one attempt visible in network tab?** The retry loop aborts if `activeSessionId() !== sessionId`. Rapid session switches tear down the previous controller — this is correct. Also verify the `GitStatusResult` coming out of `fetchGitStatus`: only `kind: 'error'` retries; `kind: 'not-a-repo'` short-circuits to `'no'`.
- **30s safety poll never ticks?** Gated on all of: `document.visibilityState === 'visible'`, `activeSessionId() === sessionId`, `gitRepoKnown !== 'no'`. A 10s coalesce window via `gitStatusLastRefreshAt` skips the tick if an event-driven refresh fired recently — this is intentional. On `visibilitychange → visible` an immediate refresh fires without waiting for the next 30s boundary.
- **Server returning same stale value for rapid-fire requests?** `batchGitStatus` in `src/server/server.ts` is a 2000ms-TTL single-flight cache keyed by `${containerId ?? 'host'}::${cwd}::${summary|untracked}`. Concurrent callers share the same in-flight promise; resolved entries are reused for up to 2000ms. Errors are **not** cached (the entry is deleted on rejection). Bust keys manually via the exported `invalidateGitStatusCache(cwd, containerId?)` — called automatically on `/git-commit`, `/git-pull`, `/git-push`, merge, and `?fetch=true`.
- **Dropdown opens but untracked files never appear?** The default `/git-status` call uses `git status --porcelain=v1 -uno` for speed (summary path). `GitStatusWidget._toggle` fires a `git-status-dropdown-open` CustomEvent (bubbles, composed); `AgentInterface` listens and refetches with `?untracked=1` (full path, `-uall`). Check that the listener is wired (`session-manager.ts` attaches it on connect) and that the response carries `untrackedIncluded: true`. Summary vs untracked are separate cache keys, so both responses coexist.
- **`partial: true` on every response?** Phase A (fast metadata: branch, upstream, master/main verify, porcelain) and Phase B (ahead/behind counts) each have a 3s per-call timeout. If Phase B counts time out the response carries `partial: true`; the client renders a yellow warning dot and the dropdown offers "Re-scan" which triggers `?untracked=1`. Persistent partials usually mean a huge repo or a held git lock.
- **Server-side retries firing repeatedly / `runBatchGitStatusCount` higher than expected?** There are no in-server retries any more. Each `batchGitStatus` call increments `runBatchGitStatusCount` exactly once — a single `execFile` attempt per git invocation, 3s timeout, fast-fail. Resilience lives in the client (`git-status-refresh.ts`, 4 attempts at [0, 500, 2000, 5000]ms). Host path uses parallel `execFile` via `src/server/skills/git-status-native.ts` (no Git Bash); container path uses a single batched `docker exec sh -c`. If you see persistent server failures, look for a genuine git or Docker problem — don't reintroduce server-side retry.
- **Test-only spawn hook**: `__setGitStatusFake(fn)` / `__clearGitStatusFake()` replace `runBatchGitStatus`'s git-spawn path with a deterministic function, and `__getGitStatusInvocationCount()` / `__resetGitStatusInvocationCount()` expose the real-invocation counter used by coalesce tests. These exist because under CI load the real `git status` spawn becomes flaky (EAGAIN / ENFILE / Windows ENOENT races) and makes retry / coalesce assertions non-deterministic. Production code never touches them.

## Sandbox sessions

- `GET /api/sandbox-status` for Docker availability
- Worktree sessions now correctly call `applySandboxWiring()` via the pipeline (previously `_setupWorktreeAndLaunchAgent()` skipped sandbox wiring)
- `sessions.json` has `sandboxed: boolean`
- Container can't reach internet? Check: (1) `docker network inspect bobbit-sandbox-net` shows the network exists, (2) container is attached to it (`docker inspect <container>` → Networks), (3) host firewall isn't blocking Docker bridge traffic
- Container can't reach gateway? Check: (1) `--add-host=host.docker.internal:host-gateway` is in the Docker args, (2) `BOBBIT_GATEWAY_URL` matches real address
- Auth failing? Check `BOBBIT_TOKEN` is scoped token from `SandboxTokenStore`
- Sessions not surviving restart? Session logs are bind-mounted from the host (`.bobbit/state/`), so they survive container death. Check `sessions.json` has the session entry and the `.jsonl` file exists on host disk.
- Delegates failing? Parent needs `sandboxed: true` + sandbox still configured in `project.yaml`

## Project container

- `docker ps --filter label=bobbit-project=<projectId>` to find the project's container
- Container not starting? Check `docker logs <containerId>` for init sequence errors (clone, npm ci, build)
- Container not reconnecting after restart? The gateway finds containers by label on startup — verify the label matches with `docker inspect <containerId>` → Labels
- Named volume lost (Docker Desktop reset)? The container will re-clone from remote and re-run npm ci on next init. Git commits are safe if push-to-remote hooks were active.
- Container worktrees missing after recreation? Verify the `bobbit-worktrees-<projectId>` volume exists (`docker volume ls`). This volume persists `/workspace-wt` across container recreation.

## Container death & recovery

When a sandbox container is killed or removed, sessions auto-recover. Use this checklist when recovery doesn't work as expected.

- **Health monitor not detecting death?** Check `[project-sandbox]` log lines. The monitor polls every 20s via `docker inspect`. If `_status` is `"starting"` (container never initialized), the monitor skips checks — verify `initForProject()` completed successfully.
- **Recovery failing repeatedly?** After a failed `init()`, the health monitor retries on the next poll cycle (every 20s). Check Docker daemon is running and the image exists (`docker images bobbit-agent`). Look for `[project-sandbox] Health check recovery failed` in logs.
- **Sessions stuck in `terminated`?** The `process_exit` → `terminated` transition is immediate, but auto-recovery depends on the health monitor detecting the container death and `SandboxManager` propagating the `container-recovered` event. Check: (1) `subscribeSandboxRecovery()` was called during startup (look for the wiring in `server.ts`), (2) `SandboxManager.onContainerRecovered` has listeners, (3) `recoverSandboxSessions()` is not throwing (check `[session-manager] Sandbox recovery failed` in logs).
- **Sessions archived instead of recovered?** The 3-tier worktree recovery failed: worktree doesn't exist on the volume, `git worktree repair` didn't help, and `createWorktree` from the persisted branch also failed. Check: (1) the session has a persisted `branch` value in `sessions.json`, (2) the branch exists on the remote (`git ls-remote origin <branch>`), (3) the named volume `bobbit-worktrees-<projectId>` survived the container death (`docker volume ls`).
- **WebSocket clients not seeing recovery?** `recoverSandboxSessions()` saves connected WebSocket clients before session deletion and re-attaches them after restore. If clients aren't getting the `session_status: idle` broadcast, check that `ws.readyState === 1` (OPEN) at re-attach time — long-dead containers may have caused the browser to close the connection.
- **Recovery timing**: Expect ~20-40s from container death to session recovery (one health check interval + container recreation + worktree verification + agent process spawn). The `process_exit` → `terminated` UI transition is immediate.
- **Key log prefixes**: `[project-sandbox]` for health monitor and container lifecycle, `[session-manager]` for session recovery and worktree repair, `[sandbox-manager]` for event propagation between subsystems.
- **Testing container recovery**: Kill the container with `docker rm -f <containerId>` and watch server logs. Sessions should transition: `idle` → `terminated` (process_exit) → `idle` (auto-recovery). Run recovery E2E tests: `npx playwright test --config playwright-e2e.config.ts --project=api sandbox-recovery`.

<a id="team-lead-session-disappears"></a>

## Team-lead session disappears / "No agents — Start Team" button throws "Team already active"

Symptom: a team-mode goal that previously had a running team-lead now renders in the sidebar with no agents under it. Clicking *Start Team* fails with `Team already active` (or the equivalent 409 from `POST /api/goals/:id/team/spawn`), so the user is stuck — the UI thinks there is a team but cannot show it.

Cause: the team-store (`team-state.json`) still has an entry for the goal but its `teamLeadSessionId` no longer resolves to any record in `sessions.json`. The DELETE handler footgun or an older crash-window write torn the metadata index without dropping the team entry.

Fix is automatic on next boot. `TeamManager.restoreTeams()` in `src/server/agent/team-manager.ts` runs a four-pass cascade that converges the team-store, the session-store, and the agent CLI's `.jsonl` slug-dirs:

1. Drop team entries for archived/gone goals (pre-existing).
2. Drop dangling team entries whose `teamLeadSessionId` doesn't resolve (commit a4c6e890). Removes the cause of the `Team already active` jam.
3. For team-mode goals lacking both a team entry and a live team-lead, reconstruct a session record from the surviving `*.jsonl` transcript in the agent CLI's slug-dir for the goal's worktree path (commits 050228d3, 237b0d00). The reconstructed record gets a fresh UUID, fun-name title with `(recovered)` suffix, and the goal binding restored — see the third entry below for why the id is fresh.
4. Rename any legacy `Team Lead: <goal-title> (recovered)` titles to the modern fun-name shape (commit 9cd3ffd5).

Diagnostic chain when the fix doesn't appear to work:

- **Restart and read the boot logs.** Pass-2 logs the count of dangling entries dropped; pass-3 logs each reconstructed session id. Absent both lines = `restoreTeams` didn't run or the team-store/session-store paths are wrong.
- **Check the slug-dir.** Pass-3 only fires when at least one `*.jsonl` survives in the agent CLI's slug-dir for the goal's `worktreePath`. The slug is `slugify(cwd)`; cross-check the actual directory name on disk. If no transcript survives, there is nothing to reconstruct — the goal can be archived manually.
- **Check the order invariant.** Pass-2 must run before pass-3 (otherwise pass-3 sees a dangler and skips reconstruction); pass-3 must run after pass-1 cleans up archived goals (otherwise pass-3 would try to reconstruct sessions for goals that should have been culled). The order is fixed in `restoreTeams` but worth verifying if the file has been refactored.

See [docs/design/session-recovery-boot-passes.md](design/session-recovery-boot-passes.md) for the full design (companion to [`session-store-crash-safety.md`](design/session-store-crash-safety.md), which covers the prevention side).

<a id="purgeonesession-refuses-to-destroy"></a>

## `purgeOneSession` refuses to destroy session / DELETE `/api/sessions/:id` returns `alreadyArchived`

Symptom: a script or operator deletes a session via `DELETE /api/sessions/:id` and gets `200 { alreadyArchived: true }` instead of destruction; or the server logs `[session-manager] purgeOneSession refused for session <id>: live team-lead, call teardownTeam() first` and the record stays on disk.

This is the refusal guard working as designed. It exists because the previous behaviour — silently destroying any session on DELETE — was the primary path by which team-lead records got torn out from under live team-store entries, producing the dangling-entry symptom in the entry above. Two layers cooperate:

- **`canPurgeTeamLeadSession` in `src/server/agent/team-store-consistency.ts`.** Refuses purge when **all** of: `session.role === "team-lead"`, `session.teamGoalId` is set, `teamStore.get(teamGoalId).teamLeadSessionId === session.id`, and the owning goal is **not** archived. `SessionManager.purgeOneSession` consults this predicate before any destructive work; on refusal it logs the warning above. The correct unstick is to call `teardownTeam(goalId)` first — that drops the team-store entry, which removes the third condition and lets the purge proceed.
- **DELETE `/api/sessions/:id` idempotency (commit d9a0b7b4).** For an already-archived session, the handler returns `200 { alreadyArchived: true }` rather than re-running purge. This closes the production footgun where re-archiving (easy from the UI, easy from a script) silently wiped the underlying record.

Explicit-opt-in escape hatch: pass `?purge=true` on the DELETE URL to force destruction of an archived record. Live team-leads still hit the `canPurgeTeamLeadSession` refusal even with `?purge=true` — the query parameter only overrides the archived-idempotency check, not the team-lead guard. To force-destroy a live team-lead, tear down the team first.

See [docs/design/session-recovery-boot-passes.md §3](design/session-recovery-boot-passes.md#3-the-refusal-guard--purgeonesession) for the refusal-condition table and rationale.

<a id="recovered-team-lead-has-fresh-uuid"></a>

## Recovered team-lead session has fresh UUID + fun-name title instead of original

Symptom: after a boot recovery, the team-lead under a goal works — transcript is intact, the team-lead can resume — but its session id in the URL and its title are different from before. The title carries a `(recovered)` suffix.

This is expected. Pass-3 of the boot-recovery cascade (`reconstructTeamLeadSessionRecord` in `src/server/agent/team-store-consistency.ts`) synthesises a **fresh** session record from the surviving `*.jsonl`, because the original gateway session UUID is not preserved anywhere on disk:

- The agent CLI's slug-dir is keyed by `slugify(cwd)` (the worktree path), not by session id.
- The `.jsonl` filename embeds a timestamp but not the gateway's UUID.
- `sessions.json` is the only source for the UUID, and by the time pass-3 runs the entry is gone — that's the precondition for reconstruction.

The reconstructed record therefore has: a new UUID, a fun-name title with the `(recovered)` suffix (so users can tell), the same transcript file, the same `teamGoalId` / `projectId` binding, and (for archived goals) `archivedAt` stamped from the transcript's mtime. This is best-effort recovery, not exact recovery.

When this becomes a problem: external bookmarks, hard-coded session-id references in scripts, or anything that joins on the old UUID will not find the recovered record. There is no automatic remapping. The transcript content and goal continuity are preserved; only the id and title differ.

A future **session-sidecar** file — written alongside each `.jsonl`, recording the gateway session UUID, role, goal-id, and fun-name at create-time — would let pass-3 do *exact* recovery: same id, same title, same metadata. Sibling subgoal `a71963d9` is investigating this. Until it lands (and until enough sessions have been created under the sidecar regime that older transcripts have one), pass-3 remains best-effort.

See [docs/design/session-recovery-boot-passes.md §4](design/session-recovery-boot-passes.md#4-why-pass-3-cannot-recover-the-original-session-id).

## Archived goals show `$0.0000` in tree-cost breakdown

Symptom: the tree-cost rollup on a goal dashboard shows real numbers for live descendants but `$0.0000` for every archived descendant, even though those subgoals demonstrably accumulated cost while live. The total at the top is correspondingly understated.

Root cause: pre-fix, `getGoalCost(goalId)` resolved sessionIds by walking `sessionStore` for matching `goalId`. The 7-day archive sweep (and post-merge cleanup paths) purges session records but leaves `<projectStateDir>/session-costs.json` intact — so cost entries are orphaned: still on disk, addressable by sessionId, unreachable by goalId.

Fix: cost entries are now stamped with `goalId` at record time (`SessionCost.goalId`, set write-once in `CostTracker.recordUsage`). `getGoalCost(goalId)` scans entries by stamped goalId instead of consulting `sessionStore`, so cost is decoupled from session lifetime. A boot-time backfill (`CostTracker.backfillGoalIds`, wired in `src/server/server.ts`) stamps `goalId` onto legacy entries from any session still in `sessionStore` — idempotent, second boot stamps zero. Dollars belonging to sessions purged before the fix landed remain unrecoverable; everything from that boot forward survives purge.

If you still see `$0.0000` on a goal whose sessions are live: confirm `session.goalId` (or `teamGoalId`) is set on the `SessionInfo` at the moment `trackCostFromEvent` fires — only that call site stamps the entry. Tree-cost cache invalidation rides on `costTracker.getGeneration()`, which `recordUsage` and `backfillGoalIds` both bump.

Pinned by `tests/cost-tracker-goal-stamp.test.ts`, `tests/cost-tracker-backfill.test.ts`, and `tests/tree-cost-purge-survival.test.ts`. Full design in [docs/nested-goals.md — Cost rollup](nested-goals.md#cost-rollup).

## Search index

FlexSearch-backed lexical search (pure-JS, BM25-style ranking). Index per project at `<project-root>/.bobbit/state/search.flex/` (`index/*.json` + `meta.json`). No native binaries, no model downloads, no runtime network. See [docs/internals.md — Semantic search](internals.md#semantic-search) and [docs/design/portable-search.md](design/portable-search.md) for the full design.

- Force a full rebuild: delete `<project-root>/.bobbit/state/search.flex/` and restart, or `POST /api/search/rebuild?projectId=<id>`. Status dot goes yellow during rebuild.
- Meta mismatch auto-rebuilds: `engine`, `engineVersion`, `schemaVersion`, or `contentPolicyVersion` bumps in `meta.json` → server rebuilds on next open. Log line at info level on startup.
- Legacy `search.lance/` directories from the previous Nomic+LanceDB backend are deleted automatically on first open. The shared model cache at `~/.bobbit/models/` is unused by the current engine — safe to `rm -rf` to reclaim disk. Bobbit does not delete it automatically.
- `ProjectContextManager.searchAll()` aggregates results across all project indexes.
- Purged sessions still showing? `purgeOneSession()` must call `SearchService.removeMessagesForSession` + `removeSession`. Alternatively run the orphaned-index-rows maintenance scan (Settings → Maintenance → Search Index) to clean up rows whose parent entity is gone.
- **Search result click does nothing / ghost results appearing?** `ProjectContextManager.searchAll()` post-filters hits whose project/goal/session/staff no longer exists and fires opportunistic index cleanup; if stale rows persist, check that (1) `projectRegistry`/`sessionManager` were injected into `ProjectContextManager` at boot (see `server.ts`), (2) `matchedOn` is being set by `toSearchResult()` in `flex-store.ts` — `message` rows with `matchedOn === "metadata"` are dropped as phantom matches, (3) client-side stale-click races dispatch the `search-result-stale` window event (from `connectToSession({ onMissing: "toast" })`, `goal-dashboard.ts`, `staff-page.ts`) rather than the blocking `showConnectionError` modal — missing toast means the origin-tag flag wasn't passed. See [docs/internals.md — Orphan filtering & stale-click safety net](internals.md#orphan-filtering--stale-click-safety-net) and [docs/internals.md — Grouped search results & stale-click toast](internals.md#grouped-search-results--stale-click-toast).

### Search unavailable (red dot)

One failure path: the FlexSearch store failed to open (usually because `<project-root>/.bobbit/state/search.flex/` is unwritable or the on-disk index files are corrupt beyond partial-load recovery). Surfaces as the **red status dot** + "Search unavailable"; `/api/search` returns **503** with `{ error: "search-unavailable", reason, state }`. The Settings → Maintenance → Search Index panel exposes **Rebuild Index**, which clears the index and rebuilds from the source stores.

Corrupt per-key files are tolerated on open — the loader logs a warning, skips the bad file, and the meta check triggers a background rebuild. Crash-mid-flush leaves `.tmp` files that are ignored on next open.

### Stats endpoint didn't return

- `GET /api/search/stats?projectId=<id>` returns `{ state, engine, engineVersion, rowCountsBySource, datasetBytes, lastRebuildAt }`. **400** if `projectId` is missing; **503** if the service is disabled (body carries `reason`).
- Stuck in `state: "rebuilding"`? Check WS `index:progress` events are arriving; the service debounces to 500ms. A stalled rebuild usually means the indexer queue is starved — check server logs for `[search]` lines.
- Row counts all zero after a rebuild? The rebuild ran against an empty store set — verify `ProjectContext` has the expected `goalStore`/`sessionStore`/`staffStore` wired and that sessions have their `.jsonl` message files on disk (the message source streams from them).

### Performance

- FlexSearch builds posting lists at upsert time; there is no separate "build ANN index" phase.
- Slow search? Check `GET /api/search/stats` for row counts per source and `datasetBytes`. Expected p95 < 100ms for typical Bobbit corpora (< 100K rows). If the in-memory index has grown very large, trigger a rebuild — orphaned rows accumulated from deletes can inflate posting lists.
- Staff not appearing in search? Staff are indexed via a dedicated hook — `StaffManager` calls `searchIndex.indexStaff(staff)` (on `SearchService`) whenever a staff record is created or updated. `SearchService.indexStaff` builds an `Indexable` via `StaffIndexSource.toIndexable` and hands it to `Indexer.upsertEntries`. Staff are **not** walked by `rebuildFromStores` under normal operation (only on a full rebuild). If a staff entry is missing, check in order: (1) the project's `SearchService.getState()` is `"ready"` (not `"disabled"` / `"rebuilding"`); (2) `indexStaff` was called with the correct staff object (add a log in `StaffManager` or watch `[search]` log lines); (3) the `Indexer` progress emission shows the row was upserted (`index:progress` with a non-zero `completed` for the `incremental` phase).
- Sidebar filter not working? The sidebar uses client-side filtering only (no API calls). It matches goal titles, session titles, session agent roles, and staff names. Check `_applySearchFilter()` in `Sidebar.ts`
- Mobile sidebar showing every archived goal when a query is typed? `renderMobileLanding` in `src/app/render.ts` must route archived goals through `filterArchivedGoalsByQuery` and standalone archived sessions through `filterArchivedSessionsByQuery` (both in `src/app/render-helpers.ts`) — the same helpers desktop's `renderSidebar` uses. If mobile skips the filter, every archived goal leaks through regardless of the query.
- Matched substring not bolded in the sidebar? Goal titles, session titles/roles, and staff names render through `renderHighlightedText(text, state.searchQuery)` in `render-helpers.ts`. Empty/null query → plain text; non-empty query wraps every case-insensitive occurrence in `<strong class="font-semibold">`. Regex special chars in the query are escaped. If highlighting breaks layout, check that the wrapper stays inline and that the span does not introduce whitespace.
- Full search page (`#/search`) is the sole consumer of the FTS API — it manages its own state, independent from sidebar filtering
- Archived section not auto-opening on search match? Check `_archivedBySearch` flag — it distinguishes search-triggered expansion from manual clicks

## Sidebar child loading

Visibility is inherited — if a sidebar entry is visible (live, search match, or loaded via "See archived" + paging), all its children must be loaded. Three parent→child relationships are covered:

1. **Goal → sessions**: `teamGoalId` or `goalId` match
2. **Team lead → team members**: `teamLeadSessionId` match (coders, reviewers, QA agents)
3. **Session → delegates**: `delegateOf` chains (recursive)

Debugging checklist:
- Expanding a live goal shows no children? Check the server BFS enrichment in `GET /api/sessions` — it should seed from live goal IDs and walk `teamGoalId`/`goalId`, not just `delegateOf`
- Archived team members missing? The BFS must also walk `teamLeadSessionId` relationships from live session IDs
- Expanding an archived goal shows nothing? Check `GET /api/goals?archived=true` returns an `archivedSessions` field with affiliated sessions and their delegate chains
- Children appear briefly then vanish? The client must merge (not replace) archived sessions — check `fetchArchivedSessionsPaginated()` uses additive merge on first page, not `state.archivedSessions = []`
- Edge case: goal loaded via "Load more goals" has no children? The on-demand fallback in `renderGoalGroup` should fire a one-shot fetch to `GET /api/goals/:id/team/agents?include=archived`. Check the `_goalChildrenFetched` guard Set isn't stale — it's cleared by `clearGoalChildrenFetchedCache()` when toggling archived off

## Archived team-member sessions appear above the "Archived" divider

Symptom: under a live team-lead's expanded block, terminated or recently-archived team-member sessions (coders, reviewers, QA agents) render above the "Archived" divider with dimmed styling instead of below it.

Root cause: `renderTeamGroup` in `src/app/render-helpers.ts` used to emit all non-lead entries from `goalSessions` as active rows, regardless of status. The `archivedForLiveLead` bucket below the divider only pulled from `state.archivedSessions` — the fully-purged collection. Recently-terminated members still present in `gatewaySessions` (status = `"terminated"`, not yet swept by the 7-day purge) slipped past both filters and rendered in the wrong bucket.

Fix: `bucketTeamChildren` in `src/app/team-archived-bucket.ts` splits `teamChildren` into:
- `liveTeamChildren` — `status !== "terminated" && !archived` — rendered above the divider
- `archivedBelow` — deduped merge of recently-terminated entries from `gatewaySessions` and fully-purged entries from `archivedSessions` — rendered below the divider

`renderTeamGroup` delegates bucketing to this helper; the divider only renders when `archivedBelow` is non-empty and `state.showArchived` is on.

Unit test: `tests/render-helpers-team-archived.test.ts`.

See [docs/internals.md — Team-member row bucketing](internals.md#team-member-row-bucketing).

## Sub-goal renders at parent-forest level instead of nested under its team-lead

Symptom: a sub-goal that was spawned by a team-lead session shows up at the top-level goal forest in the sidebar instead of inside the spawning team-lead's expanded block. Collapsing the team-lead doesn't hide it.

Diagnostic chain:

1. **Check the persisted field on disk.** Inspect the goal's record in `.bobbit/state/<projectId>/goals.json` (or the per-project equivalent). If `spawnedBySessionId` is `undefined`, the boot-time backfill couldn't find a unique team-lead candidate — either the parent has multiple team-lead sessions (ambiguous, intentionally skipped to avoid misattribution), or no team-lead session at all. Multi-team-lead parents render their sub-goals at parent-forest level by design.
2. **Confirm the boot backfill ran.** `[goal-manager] Backfilled spawnedBySessionId=<sid> for legacy sub-goal <gid>` should appear in the gateway boot logs once per stamped sub-goal. If you see `[goal-manager] backfillSpawnedBySessionId failed for project <id>` or no log line at all for a goal you expected to be stamped, the backfill is wired in `src/server/server.ts` after `restoreTeams` — verify both `teamStore` and `sessionStore` are passed (`backfillSpawnedBySessionId(teamStore, sessionStore)`); without the second arg, archived team-leads of an archived parent are unreachable.
3. **For new spawns, confirm the four-tier cascade.** Resolution at `POST /api/goals/:id/spawn-child` runs through `resolveSpawnedBySessionId` (`src/server/agent/spawn-child-spawnedby.ts`): (1) `body.spawnedBySessionId`, (2) `x-bobbit-spawning-session` header from the children-tools extension, (3) `x-bobbit-session-id` header (defence in depth for raw cURL issued from inside an agent), (4) parent's live team-lead via `teamManager.getTeamState(parentGoalId)?.teamLeadSessionId`. If all four miss, the handler logs `[spawn-child] spawnedBySessionId could not be derived for goal=<id> parent=<id>` and the field stays `undefined` — grep for that warn line. If you see it, the spawn was a true orphan (no body field, no headers, parent has no live team-lead). The sidebar's strict-parent fallback still renders it correctly nested under the parent goal.
4. **Render-side**: confirm the rendered row has `data-testid="sidebar-spawned-child-row"` with a `data-spawned-by` attribute matching the team-lead session id. Live team-leads route through `renderTeamGroup`; archived team-leads of a live parent route through `renderLeadWithMembers` (`src/app/render-helpers.ts`). The forest-exclusion set in `src/app/sidebar.ts::forestInput` MUST include the team-lead's session id — the set covers live team-leads and (when `state.showArchived` is on) archived team-leads. If `showArchived` is off and the spawning lead is archived, the sub-goal correctly falls back to parent-forest level — that's the "spawning session is fully gone" branch, not a bug.

See [docs/internals.md — Sub-goal sidebar placement](internals.md#sub-goal-sidebar-placement) and [docs/nested-goals.md — Sub-goal sidebar placement](nested-goals.md#sub-goal-sidebar-placement).

<a id="goal-rendered-twice-in-sidebar-live-mid-flight"></a>

## Goal rendered twice in sidebar (live, mid-flight)

Symptom: a single live goal appears in two sidebar locations simultaneously — once nested under its team-lead's expanded block (correct) and once at the project root or under its parent goal in the forest (wrong). The duplicate appears while the goal is still in-progress (`archived: false`, `state: "in-progress"`) — explicitly NOT an archive-flip race.

### Architecture

Two render paths emit goal rows:

- **Path A — spawned-children block.** `renderGoalGroup` → `renderTeamGroup` (`src/app/render-helpers.ts`) calls `selectSpawnedChildren(goals, parentId, leadId, showArchived, leadId)` (`src/app/sidebar-spawned-children.ts`) for every team-lead it iterates. Lookup is status-agnostic — `goalSessions.find(s => s.role === "team-lead")` accepts any status, and the parent-lead fallback claims goals where `spawnedBySessionId === undefined` for the iterated parent.
- **Path B — forest.** `buildNestedGoalForest` (`src/app/sidebar-nesting.ts`) consumes a forest input and lays out top-level / nested rows. Called from `sidebar.ts::renderProjectContent` (desktop) and `render.ts::renderMobileLanding` (mobile).

### Contract: claim → exclude

`computeSpawnedClaim` (`src/app/sidebar-spawned-children.ts`) computes the deterministic Set of goal ids that Path A will render. Both Path B call sites filter their forest input by `!claimed.has(g.id)`. The helper signature is `(goals, liveSessions, archivedSessions, showArchived) → Set<string>`. It mirrors `renderTeamGroup`'s lookup exactly:

1. For each parent goal P in `goals`, find every team-lead session in `liveSessions` matching `role === "team-lead" && (goalId === P.id || teamGoalId === P.id)` — ANY status, NOT filtered on `terminated`.
2. When `showArchived`, also include every team-lead in `archivedSessions` matching `role === "team-lead" && teamGoalId === P.id`.
3. For each (P, leadId) tuple, run `selectSpawnedChildren(goals, P.id, leadId, showArchived, leadId)` and add every result id to the output Set.

The upper-bound invariant: `selectSpawnedChildren(goals, P.id, lead.id, showArchived, lead.id) ⊆ computeSpawnedClaim(goals, ..., showArchived)` for every (P, lead). Pinned by `tests/sidebar-no-double-render.test.ts`.

### Why the old heuristic failed

The previous `teamLeadIdsAttributable` filter (in `sidebar.ts`) leaked three real cases:

- **Status mismatch.** Path A is status-agnostic; the heuristic excluded `status === "terminated"`. A stale-but-still-listed team-lead (the user's Justin Time repro) claimed its children in Path A but Path B didn't know, leaking them into the forest.
- **Unstamped children.** `selectSpawnedChildren`'s parent-lead fallback claims goals with `spawnedBySessionId === undefined`. The heuristic only checked `g.spawnedBySessionId` — undefined short-circuited to "render in forest", double-rendering.
- **Mobile.** `renderMobileLanding` had no dedup at all. Every spawned child rendered top-level AND under its team-lead.

### Diagnostic chain

1. **Confirm both paths emit the goal.** Inspect the rendered sidebar DOM for two rows with the same `data-goal-id`. One should carry `data-testid="sidebar-spawned-child-row"` (Path A); the duplicate is plain `data-testid="sidebar-goal-row"` or appears at the forest top-level.
2. **Read the helper's return value.** Hot-patch `console.log([...claimed])` inside `renderProjectContent` (or `renderMobileLanding`) and compare against the duplicated id. If the id is in the Set but still rendering twice, the filter wiring is wrong (check `forestInput = ... .filter(g => !claimed.has(g.id))`). If the id is NOT in the Set, the helper missed it — walk the cases above.
3. **Both layouts must call it.** Verify both `sidebar.ts::renderProjectContent` AND `render.ts::renderMobileLanding` invoke `computeSpawnedClaim` with `(goals, state.gatewaySessions, state.archivedSessions, state.showArchived)`. The mobile path was the original miss.
4. **Status-agnostic lookup.** The helper must NOT filter on `status !== "terminated"`. `renderTeamGroup` is status-agnostic; mirror that or the dedup desyncs.

### Files to inspect when this regresses

- `src/app/sidebar-spawned-children.ts` — `computeSpawnedClaim` (helper) and `selectSpawnedChildren` (Path A's actual claim logic). They must agree.
- `src/app/sidebar.ts::renderProjectContent` — desktop wire-up.
- `src/app/render.ts::renderMobileLanding` — mobile wire-up. Easy to forget when refactoring sidebar code.
- `src/app/render-helpers.ts::renderTeamGroup` — Path A's actual render. If its session-lookup shape changes (e.g. new role filter, new status gate), `computeSpawnedClaim` must be updated to mirror it.
- `tests/sidebar-no-double-render.test.ts` — 11 unit tests pinning the contract; covers stamped, unstamped, archived (showArchived on/off), terminated lead, grandchild, no-team-lead parent, and the upper-bound regression.

<a id="sidebar-nests-goal-under-wrong-team-lead-unstamped-child-shows-under-a-sibling"></a>

## Sidebar nests goal under wrong team-lead / unstamped child shows under a sibling

Symptom: a sub-goal that should belong to team-lead A renders inside team-lead B's expanded block (a sibling). Collapsing B hides the orphan; collapsing A doesn't. Trigger: sub-goals spawned via raw `POST /api/goals/:id/spawn-child` with no `spawnedBySessionId` body field and no `x-bobbit-spawning-session` header are misattributed under a sibling team-lead.

Cause: `spawnedBySessionId` was `undefined` on creation (cascade tier 5 hit — see [docs/nested-goals.md — Cascade resolution at spawn time](nested-goals.md#cascade-resolution-at-spawn-time)) AND the render-side fallback wasn't strict about `parentGoalId`. Two layers fix it:

1. **Source fix (primary):** `resolveSpawnedBySessionId` (`src/server/agent/spawn-child-spawnedby.ts`) drives both `POST /spawn-child` and `verification-harness.runSubgoalStep`. Tiers 1–4 cover every realistic spawn path; tier 5 logs `[spawn-child] spawnedBySessionId could not be derived for goal=<id> parent=<id>`. If you see this warning, the spawning context was truly missing — grepping logs is the fastest way to spot regressions in tier 1–4.
2. **Render-side defence in depth:** `selectSpawnedChildren` (`src/app/sidebar-spawned-children.ts`) accepts an optional `parentLeadId`. When a child has `spawnedBySessionId === undefined`, it only attaches to the lead passed as `parentLeadId` — never a sibling's. Call sites in `src/app/render-helpers.ts` (both the live `renderTeamGroup` branch and the archived `renderLeadWithMembers` branch) pass `parentLeadId === leadId` only when the iterated lead actually belongs to the parent goal being rendered, so an unstamped orphan cannot get pulled under an unrelated team-lead.

Fix locations to inspect when this regresses:

- `src/server/agent/spawn-child-spawnedby.ts` — the cascade itself; treat as the single source of truth for resolution order.
- `POST /api/goals/:id/spawn-child` handler in `src/server/agent/nested-goal-routes.ts` (extracted from `server.ts`) — must call `resolveSpawnedBySessionId` and emit the warn log on tier-5 fall-through.
- `verification-harness.runSubgoalStep` — must call the same helper for the in-process path.
- `selectSpawnedChildren` — the optional `parentLeadId` argument is the strict-attribution invariant; if a regression drops it, unstamped orphans float across siblings again.
- `goal-manager.backfillSpawnedBySessionId` — boot-time stamping of legacy records.

For the related-but-distinct symptom "sub-goal renders at parent-forest level instead of nested at all" — the spawning session was archived AND `state.showArchived` is off — see [Sub-goal renders at parent-forest level instead of nested under its team-lead](#sub-goal-renders-at-parent-forest-level-instead-of-nested-under-its-team-lead) above.

## Paginated archives

- Cursor based on `archivedAt` timestamp
- Missing items? Check `archivedAt` is set (older items may lack it)
- Count mismatch? Verify total from paginated response metadata
- Archived delegates disappearing on "Show Archived" toggle? The `?include=archived` path returns `archivedDelegates` via BFS enrichment — if they're missing, check that the server is running the child BFS on the archived response and the client is merging them into `state.archivedSessions`
- Per-project Archived subsections not persisting their collapsed state? Each project's Archived subsection defaults to expanded; collapsed project IDs are persisted in `localStorage["bobbit-archived-collapsed-projects"]` (mirrors `bobbit-collapsed-ungrouped` / `bobbit-collapsed-staff`). The global `bobbit-show-archived` toggle controls all per-project subsections at once
- Per-project Archived subsection empty for a project you expected to have items? Check in order: (1) `state.showArchived` is true (global toggle on) — if false, **every** project's subsection is suppressed; (2) `state.archivedSessions` / `state.archivedGoals` actually contain the items (paginated "Load more" may still be needed); (3) each item's `projectId` resolves to a registered project — items missing `projectId` or pointing at an unregistered project fall back to the **default** project's bucket with a `console.warn("[sidebar] archived goal/session missing projectId, using default", id)`. If a user reports "my archived items moved to the wrong project", that console warning is the signal.
- "Load more archived" button missing or in the wrong place? The pagination buttons are rendered **once** below the project list, not per project. They only appear when `state.showArchived` is on, there is no active search query, and `state.archivedGoalsHasMore` / `state.archivedSessionsHasMore` is true. See `src/app/sidebar.ts` around the `renderProjectArchivedSection` call site.

## Slash skill expansion

- Skills show in autocomplete but don't expand? The autocomplete API (`/api/slash-skills`) must receive the session's `projectId` so it resolves skills from the correct project's `config_directories`. Verify `AgentInterface.projectId` is set from session data in `session-manager.ts`
- Check server logs for `[ws-handler] Slash skill "<name>" not found for session <id> (cwd=<cwd>)` — this warning fires when a `/skill-name` pattern matches but `getSlashSkill()` returns undefined, indicating a project context mismatch or missing skill file
- In multi-project setups, each project's `config_directories` controls which skills are discovered. A skill defined in project B's config directory won't appear for sessions in project A

## Skill references not loading

Symptom: a multi-file skill (with `references/`, `scripts/`, or `assets/`) activates, but the agent never reads the referenced files — or reports "file not found" when it tries.

1. **Was the activation header emitted?** Inspect the model-facing `expanded` content for the skill — for `/name` invocations, look in the sidecar at `<stateDir>/skill-sidecar/<sessionId>.jsonl`; for autonomous activations, hit `POST /api/sessions/:id/activate-skill` and check the response. The first non-blank lines should be:
   ```
   <!-- skill-activation-header -->
   Skill root: <path>
   Available resources: ...
   <!-- /skill-activation-header -->
   ```
   Missing header = `buildActivationHeader()` returned `""`. Check: skill is loaded from a directory (not a legacy `.claude/commands/*.md` single file), `filePath` is not `"(built-in)"`, the file basename is `SKILL.md`, and the skill is not `source: "legacy"`.
2. **Resource manifest empty?** If header shows only `Skill root:` with no `Available resources:` line, the skill has no `references/`, `scripts/`, or `assets/` subdirectory at one level deep — `buildSkillResourceManifest()` returned `null`. Confirm those dirs exist on disk under the skill root.
3. **Path reachable from CWD?** The agent reads files using the relative paths in the manifest, resolved against the skill root in the header. If the agent's working directory differs (e.g. it `cd`'d elsewhere), it must use the absolute `Skill root` path. Check the agent isn't dropping the header from the prompt before reasoning.
4. **Sandbox case — degraded header?** If the header reads `Skill root: (not visible inside sandbox — ...)` with no resource list, this is the sandbox limitation: built-in (`defaults/skills/`) and personal (`~/.claude/skills/`) skill roots are not mounted into the Docker container. Project-local skills under `<project>/.claude/skills/` work. Workaround: copy the skill into the project tree. See [docs/internals.md — Sandbox skill visibility](internals.md#sandbox-skill-visibility).
5. **Truncated manifest?** If the skill has hundreds of files, the manifest is capped at 2 KB and ends with `(N more files)`. The agent only sees the alphabetically-first chunk; it must use absolute `<skill-root>/references/...` paths and discover others via `ls`.

Key files: `src/server/skills/skill-manifest.ts` (`buildSkillResourceManifest`, `buildActivationHeader`, `ACTIVATION_HEADER_STRIP_RE`), `src/server/skills/resolve-skill-expansions.ts` (user invocation injection), `src/server/server.ts` activate-skill handler (autonomous injection), `src/ui/components/SkillChip.ts` (header strip for chip body).

See [docs/internals.md — Skill resource manifest (Level-3 progressive disclosure)](internals.md#skill-resource-manifest-level-3-progressive-disclosure).

## Skill chip not rendering

Symptom: user types `/mockup foo`, but the chat bubble shows the fully expanded skill body instead of the literal text + a chip. Or the chip vanishes after sending and only reappears after a reload.

Walk the data path in order:

1. **Sidecar present?** Check `<stateDir>/skill-sidecar/<sessionId>.jsonl` exists and contains an entry with the expected `modelText` / `originalText` / `skillExpansions`. No file = `appendSkillSidecarEntry()` failed silently (look for `[skill-sidecar]` warnings) or `initSkillSidecarDir()` was never called at server bootstrap. No matching entry = the WS handler called `enqueuePrompt` without first calling `resolveSkillExpansions()`.
2. **Live WS user-message envelope carrying `skillExpansions`?** Open DevTools → Network → WS and inspect the user-message echo frame. It must include the `skillExpansions` array. Bug we hit during the Skill UX goal: `src/server/ws/handler.ts` resolved expansions and persisted the sidecar but stripped `skillExpansions` from the broadcast envelope, so chips only appeared after reload (when sidecar replay rehydrated them). If the live frame is missing the field, fix the handler echo — don't rely on reload as a workaround.
3. **`<skill-chip>` custom element registered?** In DevTools → Console run `customElements.get('skill-chip')`. If `undefined`, the import in `src/ui/index.ts` is missing or the bundle didn't pick up `src/ui/components/SkillChip.ts`. The chip renders as raw text in this case.
4. **Old session?** Sessions started before this feature have no sidecar and no `skillExpansions` on persisted user messages. They render the legacy fully-expanded text as plain markdown by design — not a bug.

See [docs/internals.md — Skill chip rendering & autonomous activation](internals.md#skill-chip-rendering--autonomous-activation) for the full architecture and [docs/design/skill-ux-and-autonomous-activation.md](design/skill-ux-and-autonomous-activation.md) for the design rationale (model-prompt byte-equality, snapshot-at-invocation, backward compat).

## Multi-project / per-project state

- State is per-project: goals, sessions, tasks, teams, gates, search, costs all live in `<project-root>/.bobbit/state/`
- `ProjectContextManager` manages all `ProjectContext` instances and routes store access
- Project registry at `<server-cwd>/.bobbit/state/projects.json` — check file exists and is valid JSON
- **No default user project.** The server never auto-registers a *user* project. A fresh install has an empty `projects.json` (visible projects only) and the UI forces Add Project before any goal/session work in user projects. `POST /api/goals`, `POST /api/sessions`, and `POST /api/staff` require an explicit `projectId` or a `cwd` matching a registered project's `rootPath` and return **400** `"projectId required: ..."` otherwise (see [rest-api.md — Project resolution contract](rest-api.md#project-resolution-contract)).
- **Synthetic `system` project carve-out.** At startup the server registers a hidden synthetic project (id `system`, anchored at `<bobbitStateDir>/system-project/`, `hidden: true`) via `registerSystemProject()`. It does **not** appear in `GET /api/projects` and is invisible to `state.projects`, but it is a valid `projectId` for `POST /api/sessions`. Two kinds of caller land here: (a) the Tools page → New Tool with scope = System, which passes `projectId: "system"` explicitly; and (b) `POST /api/sessions` with `assistantType ∈ {role, tool, staff}` and no `projectId` — the server's `isServerScopeAssistant` branch anchors these at `SYSTEM_PROJECT_ID` without consulting `resolveProjectForRequest`. See [internals.md — Synthetic system project](internals.md#synthetic-system-project) and [rest-api.md — `POST /api/sessions` assistantType carve-outs](rest-api.md#post-apisessions--assistanttype-carve-outs).
- **Diagnosing a user-visible 400 "projectId required":**
  1. Was the request a `POST /api/sessions` with `assistantType ∈ {role, tool, staff}`? It should never 400 on missing project — the server anchors at `system`. A 400 here means the server-scope carve-out regressed; check the `isServerScopeAssistant` branch in `handleApiRoute()`.
  2. Was the request from a system-scope tool assistant relying on `cwd` only? It must carry `projectId: "system"` in the POST body — `cwd`-only resolution will 400 because `findByCwd` skips hidden projects.
  3. Was the request from the splash-screen "New Session" / "Quick Session" button? Those are gated on `state.projects.length` (0 → New Project CTA, 1 → bound session, ≥2 → splash picker via `state.splashProjectPickerOpen`); a 400 here means the gating regressed.
  4. Confirm the system project is registered — `state.projects` will not show it (by design), but its presence is observable via the server log line on startup or by inspecting `<bobbitStateDir>/projects.json` directly. There is no `?includeHidden=1` query flag.
- `GET /api/projects` to list all registered projects
- Sessions/goals not appearing? Check `projectId` field matches the expected project. Verify the correct project's `sessions.json` / `goals.json` contains the record
- Sidebar not grouping? Project folder rows are always shown — check that `state.projects` is populated and `renderProjectHeader()` is being called
- Project registration failing? `rootPath` must be absolute and exist on disk; duplicate paths are rejected
- Search not filtering by project? Verify `?projectId=` query param is passed; each project has its own `search.flex/` index
- Config not cascading? Check all three `.bobbit/config/` directories (global, server, project) and verify `resolveScalarConfig()` / `resolveEntities()` return expected scope
- **State migration**: On first startup after upgrade, central state is distributed to per-project dirs. Check for `.bobbit/state/.migrated-to-per-project` marker. Central files renamed with `.pre-migration` suffix (not deleted). If migration didn't run, check that projects are registered before migration runs
- **Store routing bugs**: All store access must go through `ProjectContextManager` — direct `this.store` calls bypass per-project routing. `SessionManager` uses `resolveStoreForSession()` / `resolveStoreForId()` to find the correct per-project `SessionStore`
- **Known limitations**: `active-verifications.json` stays in the central state dir (transient operational state).

## Project proposal panel doesn't reflect the latest `propose_project` call

- **Symptom**: an agent calls `propose_project` a second time in the same session (e.g. after the user steers component naming), but the right-hand panel still shows the previous components or workflows. Components/Workflows tabs are stale; the Diff tab may show no diff or the wrong diff.
- **Diagnostic order**:
  1. **Bug A — JSON-string coercion**: confirm the `propose_project` tool extension is not stringifying `components` / `workflows` into the legacy flat field map. They must arrive at `onProjectProposal` as structured arrays/objects, not as JSON strings rendered into a legacy `Input` row.
  2. **Bug B — `onFieldInput` clobber**: confirm `onFieldInput` in `src/app/render.ts::projectProposalPanel` early-returns for `key === "components"` and `key === "workflows"`. Without that guard, a stray keystroke on a hidden Input row overwrites the structured side-table with a string.
  3. **Bug C — missing shallow-merge**: confirm `onProjectProposal` in `src/app/session-manager.ts` shallow-merges the new payload over the previous one and re-attaches `components` / `workflows` from the prior proposal when missing in the incoming partial. A wholesale replace drops one of the structured tables on every streaming delta. The shallow-merge also runs **per component**: when both prev and incoming have `components`, entries are matched by `name` and missing `commands` / `config` on the incoming entry are carried over from the prev entry. Without this, a partial re-emit (e.g. agent emits `components: [{name: "web", commands: {...}}]` to update commands only) clobbers the previous `config` map on `web`.
- **Verify**: open the Components tab, trigger a `propose_project` that adds a new component, then watch for the new `component-card-${name}` testid to appear without dismissing/reopening the panel. Same drill on the Workflows tab with `workflow-card-${id}`.
- **Architecture**: see [docs/internals.md — Project-proposal panel structure](internals.md#project-proposal-panel-structure) for the live-update guarantee and the three-view layout (Components / Workflows / Diff + legacy fields block).

## Monorepo subprojects not detected

- **Symptom**: project assistant doesn't suggest per-component workflows for a clearly-monorepo project (pnpm/npm workspaces, Nx, Turbo, Lerna, Cargo, Go workspace, Gradle multi-module), or `POST /api/projects/scan` returns an empty `monorepo` field.
- **Diagnostic order**:
  1. Confirm the workspace manifest is one `monorepo-scan.ts` recognises: `pnpm-workspace.yaml`, `package.json` with a `workspaces` array, `nx.json`, `turbo.json`, `lerna.json`, `Cargo.toml` with `[workspace]`, `go.work`, or Gradle `settings.gradle[.kts]` containing `include(...)`. Anything else falls through to single-repo detection.
  2. Confirm the manifest is at the project's `rootPath`, not nested below it. The scanner is one level deep — it does not recurse into the workspaces themselves.
  3. If a project legitimately has more than 30 workspace packages, output is capped at `MAX_CANDIDATES = 30` (alphabetical truncation marker emitted). The assistant still gets a representative slice; the user can add the rest manually.
- **Architecture**: see `src/server/agent/monorepo-scan.ts` and [docs/internals.md — Project-proposal panel structure](internals.md#project-proposal-panel-structure) (Monorepo subproject scan).

## Add-project: Continue after Archive tries to auto-import / opens stale project instead of assistant

- **Symptom**: user clicks "Archive existing .bobbit/" in the add-project preflight panel, archive succeeds, then clicking Continue auto-imports a (now empty) project instead of opening the project assistant. Same symptom for any "ghost `.bobbit/`" directory (empty, half-extracted archive, crashed install, manually-created stub).
- **Cause**: `POST /api/projects/detect` decides `hasBobbit` from the on-disk marker `<path>/.bobbit/config/project.yaml`, NOT from the mere presence of a `.bobbit/` directory entry. The archive flow re-scaffolds empty `.bobbit/config/` and `.bobbit/state/` after moving content aside (see `src/server/agent/bobbit-archive.ts`), so `.bobbit/` always exists post-archive but `project.yaml` does not — detection must return `hasBobbit: false` and the UI must fall through to the assistant branch in `src/app/dialogs.ts::doContinue`.
- **Diagnostic order**:
  1. `GET /api/projects/detect` for the candidate path — confirm `hasBobbit` matches existence of `<path>/.bobbit/config/project.yaml`. If `hasBobbit: true` with no `project.yaml`, the server check has regressed (see `src/server/server.ts` `/api/projects/detect` handler).
  2. The preflight `bobbit.existing` row is a separate concern ("is there content to archive?") and must keep firing whenever `.bobbit/` has content — do NOT collapse the two checks. See [add-project-preflight.md](add-project-preflight.md).
  3. Browser E2E: `tests/e2e/ui/add-project-post-archive.spec.ts` pins the archive → Continue → assistant flow.
- **Truth table** (`.bobbit/` shape → expected route):
  - absent → assistant
  - empty, or only empty `config/` + `state/` (post-archive shape) → assistant
  - contains `config/project.yaml` → auto-import
- **Architecture**: see [docs/internals.md — Project assistant](internals.md#project-assistant) for the detection marker rationale and the auto-import vs assistant routing.

## Legacy JSON-string project.yaml field rejected

- **Symptom**: `PUT /api/projects/:id/config` (or `/api/project-config`) returns 400 in one of two situations:
  1. Setting `config_directories` or `sandbox_tokens` with a JSON-encoded string instead of a structured array of mappings.
  2. Setting any of the seven legacy top-level QA keys: `qa_start_command`, `qa_build_command`, `qa_health_check`, `qa_browser_entry`, `qa_env`, `qa_max_duration_minutes`, `qa_max_scenarios`.
- **Cause**:
  - `config_directories` / `sandbox_tokens` are native YAML on disk and structured on the wire end-to-end. Sending a JSON-encoded string (e.g. `"[{\"path\":...}]"`) is rejected to prevent regression to the old encoding.
  - The seven `qa_*` keys no longer live at the top level. They have moved onto each component's opaque `config:` map (`components[<name>].config[<key>]`), and `qa_env` has been removed entirely — agents inline env vars directly into `qa_start_command`. The wire-level rejection forwards a migration message pointing at the new location.
- **Fix**:
  - For `config_directories` / `sandbox_tokens`: send structured payloads (arrays of mappings). The settings UI, `propose_project`, and `acceptProjectProposal` already do this; only hand-rolled API callers should hit the 400.
  - For QA keys: PUT a `components` array with the `qa_*` keys nested under the relevant component's `config:` map. Inline env vars (formerly `qa_env`) directly into `qa_start_command` itself, single-quoted with `'\''` escapes for embedded quotes.
- **On-disk legacy form is still tolerated**: `ProjectConfigStore` parses legacy JSON-string and quoted-numeric values for `config_directories` / `sandbox_tokens` transparently via `getConfigDirectories()` / `getSandboxTokens()` and rewrites the file in native form on the next save. The first-boot migration in `state-migration/migrate-project-yaml.ts` moves any top-level `qa_*` keys it finds onto the relevant component's `config:` map (inlining `qa_env` into `qa_start_command`) and deletes the originals. Only the wire format is strict. See [docs/internals.md — Native-YAML project.yaml fields](internals.md#native-yaml-projectyaml-fields) and [Multi-repo & components](internals.md#multi-repo--components).

## Pause cascade returns `paused:N` but sessions keep streaming

- **Symptom**: `POST /api/goals/:id/pause {cascade:true}` returns `{paused:N}` and the goal records show `paused:true`, but `GET /api/sessions` still shows team-leads, coders, reviewers, or `llm-review-*` verifier sessions in the subtree with `status:"streaming"`. Aborting one manually via `POST /api/sessions/:id/abort` triggers a fresh team-lead within seconds (the supervisor-respawn whack-a-mole), and `POST /team/spawn` / `/spawn-child` / `/gates/:id/signal` against the paused goal still succeed.
- **Cause**: pre-fix the `/pause` handler only flipped `paused:true` on each descendant and called `cancelAllVerifications`. It did NOT interrupt streaming sessions, did NOT guard the spawn paths, and `TeamManager._bootRespawnSessionlessGoals` did NOT skip paused goals — so the supervisor immediately recreated team-leads on the paused subtree. Three holes; all three had to close together.
- **Fix**: one shared helper plus narrow guards at every spawn site, and a `forceAbort` sweep in `/pause`. See [docs/design/pause-cascade.md](design/pause-cascade.md) for the design and [docs/nested-goals.md — Pause / resume](nested-goals.md#pause--resume) for the user-facing contract.
  - `src/server/agent/goal-paused-guard.ts` — `GoalPausedError` (`code:"GOAL_PAUSED"`, `status:409`) and `requireGoalNotPaused(goalId, lookup)`. REST handlers catch and re-shape into `{error, code:"GOAL_PAUSED", goalId}` at 409; in-process callers let it propagate.
  - `SessionManager.getAllSessionsRaw()` — `@internal` accessor returning the full `SessionInfo[]`; powers the `/pause` sweep that walks every session and calls `forceAbort(id)` for any whose `goalId` is in the paused subtree. Best-effort — errors logged, do not block the sweep.
  - `TeamManager._bootRespawnSessionlessGoals` — now skips `goal.paused`. This single guard is the highest-impact change; it stops the supervisor whack-a-mole. Pinned by `tests/team-manager-boot-respawn-sessionless.test.ts` (source-grep + `shouldRespawn` mirror).
  - Spawn-path guards: `/team/spawn` and `/gates/:id/signal` in `server.ts`, `/spawn-child` in `nested-goal-routes.ts`, `_startTeamImpl` + `spawnRole` in `team-manager.ts`, `runLlmReviewViaSession` in `verification-harness.ts`. `/team/start` translates the thrown `GoalPausedError` into the canonical 409 shape.
- **Pinning tests**: `tests/e2e/pause-cascade-aborts-sessions.spec.ts` (sessions stop within 5 s; 409 from every guarded endpoint; resume re-enables spawn), `tests/e2e/pause-cancels-verifiers.spec.ts` (in-flight verifier cancelled within 5 s, no replacement), `tests/e2e/pause-blocks-supervisor-respawn.spec.ts` (drives `_bootRespawnSessionlessGoals` while paused, asserts no respawn).
- **If it recurs**: grep server stdout for `[pause] abortSessionTurn failed for session=` (sweep saw the session but `abortSessionTurn` threw — inspect the per-session error). If the sweep didn't see a session at all, check that the session's `goalId` field is populated (orphan sessions with `goalId === undefined` are intentionally skipped). If a team-lead respawned, confirm `_bootRespawnSessionlessGoals` still has the `if (goal.paused) continue;` guard — the pinning test source-greps the predicate.
- **If the goal's own coordinator session seems to die on pause**: the sweep now excludes the caller's session, but only when the request carries an `x-bobbit-session-id` (or `x-bobbit-spawning-session`) header identifying that session. Check that the client/MCP path issuing the pause is forwarding the header — without it the coordinator falls into the sweep and gets soft-aborted alongside its descendants.

## Empty `verification.steps[]` after `gate_signal`

- **Symptom**: `POST /api/goals/:id/gates/:gateId/signal` returns a populated `steps[]` array, but for ~15-30 s afterwards `GET /api/goals/:id/gates/:gateId` (or any other read of the gate-store signal) returns `latestSignal.verification.steps: []`. Dashboard's workflow-progress indicator renders no in-flight chips during that window. Reproducible with any multi-step gate — worst on the `implementation` gate (8+ steps with build / typecheck / unit / e2e / llm-reviews).
- **Cause**: pre-fix the REST handler wrote `signal.verification.steps = []`, called `gateStore.recordSignal(signal)`, then fire-and-forget invoked `verifyGateSignal()` which built the `ActiveVerification` entry several `await`s later (gate-store lookups, workflow resolution, `ProjectConfigStore` reads). Anything reading the gate-store or `/api/goals/:id/verifications/active` between the two writes saw an empty step list.
- **Fix**: step enumeration is now synchronous via `VerificationHarness.beginVerification(signal, gate)`. The REST handler calls it before `recordSignal` and writes the returned `GateSignalStep[]` into `signal.verification.steps` atomically with the gate-store write. `verifyGateSignal` reuses the pre-seeded active entry instead of re-creating one (so `startedAt` isn't re-stamped and `gate_verification_started` isn't re-broadcast). `cancelStaleVerifications` runs **before** `beginVerification` so it doesn't observe and tear down the new entry. See [docs/gate-signal-step-enumeration.md](gate-signal-step-enumeration.md) for the full design.
- **If it recurs**: (1) confirm `beginVerification` is called before `recordSignal` in the `gate_signal` handler in `server.ts` — any future call site that signals a gate must follow `cancelStaleVerifications` → `beginVerification` → `recordSignal` order; (2) confirm `verifyGateSignal` is reading the pre-seeded `activeVerifications` entry rather than constructing a fresh one when called from the REST path (a fresh build re-stamps `startedAt` and re-broadcasts `gate_verification_started`, breaking WS ordering); (3) confirm `GateSignalStep.status` is set on the seeded rows so the dashboard renderer (`goal-dashboard.ts`) renders them as `running`/`waiting` rather than as failed (with `passed: false` and no `status`, the renderer fell back to a failed-X icon).
- **Pinning tests**: `tests/gate-signal-step-enumeration.test.ts` (unit — immediate gate-store read after signal); `tests/e2e/gate-signal-progress.spec.ts` (API E2E — POST response vs summary vs inspect vs active endpoints all match within one scheduler tick); `tests/e2e/ui/verification-progress-indicator.spec.ts` (browser E2E — chips render immediately and survive reload from persisted state alone).

## Gate re-signal cancellation

- `cancelStaleVerifications()` in `verification-harness.ts` terminates old reviewer sessions and persists `status: "failed"` to the gate store
- Cancelled flag checked after `Promise.all` to suppress stale results
- Check `sessionManager` and `teamManager` passed to `VerificationHarness`
- Inspect: `GET /api/goals/:goalId/verifications/active`
- **Stuck verification?** Cancel manually via `POST /api/goals/:goalId/gates/:gateId/cancel-verification` (returns `{ cancelled: true }` or `{ cancelled: false }` if nothing was running). The goal dashboard also shows a Cancel button when a verification is in "running" state.
- **Zombie detection**: On re-signal, the server checks `areVerificationSessionsAlive()` before returning 409. Reviewer/agent steps are alive iff `sessionManager.getSession(step.sessionId)` resolves; command steps are alive iff `step.bootEpoch === harness.bootEpoch && isPidAlive(step.pid)` — a persisted `status: "running"` from a previous gateway lifetime never satisfies this and so cannot lock the gate.

## HTTP 409 `Verification already in progress` after gateway restart

- **Symptom**: after a gateway restart that killed an in-flight command-type verification, `POST /api/goals/:id/gates/:gateId/signal` on the same commit returns `409 { error: "Verification already in progress for this commit", existingSignalId: ... }` even though nothing is actually running. Pre-fix the only unstick was pushing an empty commit to change the SHA.
- **Cause**: `areVerificationSessionsAlive` treated any persisted `status === "running"` command step (no `sessionId`) as proof of liveness. Persisted state survives restart; the spawned `npm run test:e2e` child does not. The in-memory map and the on-disk gate status drifted (gate looked failed, lock looked running).
- **Fix**: command-step liveness now requires `step.bootEpoch === this.bootEpoch && isPidAlive(step.pid)`; `bootEpoch` is a per-`VerificationHarness`-instance UUID, so post-restart it can never match. `resumeInterruptedVerifications()` also synchronously deletes failed-on-resume entries from `activeVerifications` and rewrites `active-verifications.json` in a `finally`, so the duplicate-detection check has nothing to false-positive on. See [docs/verification-restart.md](verification-restart.md) for the full design.
- **If it recurs**: grep server stdout for `[api] Rejecting gate_signal as duplicate` — that log line now dumps `signalId` + per-step `{ name, status, pid, bootEpoch, sessionId }` so you can tell at a glance whether a step is genuinely alive (matching bootEpoch + live pid) or a zombie. A zombie with the current `bootEpoch` means we kept the entry across an explicit `cancelStaleVerifications` — investigate that path. A zombie with a stale `bootEpoch` means the resume cleanup didn't run — check for exceptions during boot in `resumeInterruptedVerifications`.
- **Pinning tests**: `tests/verification-harness-restart.test.ts` (zombie alive-check, pid-reuse safeguard, resume-removes-from-disk-and-memory); `tests/e2e/verification-restart-resignal.spec.ts` (full HTTP round-trip — seed a zombie, resume, re-signal, assert 200).

## Phased verification

- Steps are grouped by `phase` (integer, default 0) and phases execute sequentially
- Within each phase, steps run in parallel
- If any step in a phase fails, remaining phases are skipped (status: `"skipped"`)
- Skipped steps carry `skipped: true` on `GateSignalStep`, persisted in `gates.json` — this lets the UI show the correct dash icon after reload (without it, skipped steps would appear as passed or failed based on the `passed` field alone)
- `gate_verification_phase_started` WebSocket event fires before each phase
- Step events include `phase` field; skipped steps show `"Skipped — earlier phase failed"`
- Check `ActiveVerification.currentPhase` via `GET /api/goals/:goalId/verifications/active`
- If LLM reviews run when they shouldn't: verify `phase: 1` is set on `llm-review` steps in the workflow YAML

## Verification artifacts

- `llm-review` steps store full output as `text/markdown` artifacts on `GateSignalStep.artifact`
- Artifacts are capped at 10 MB; content truncated if exceeded
- Dashboard shows markdown artifacts in collapsible "Full Review" sections; HTML artifacts via "View Report" button
- If artifacts are missing: check that the `llm-review` step completed (not skipped/cancelled)
- Artifact data persists in `gates.json` alongside step results

## QA screenshot token bloat

- Symptom: QA session burns millions of cache-read tokens / dollars of cost, often killed by the context ceiling before it can submit a verdict.
- Root cause (pre-fix): `browser_screenshot(includeBase64: true)` returned the full `data:image/png;base64,...` URI as a text content block. It stayed in the transcript and was re-cached on every subsequent turn.
- Quick check: open the QA session's transcript and inspect a `browser_screenshot` tool result. Post-fix results contain `[screenshot_file]<absolute-path>[/screenshot_file]`. If you still see `[screenshot_base64]data:image/...[/screenshot_base64]`, the browser tool extension is stale — rebuild and restart the server.
- Spilled files live under `<session-cwd>/.bobbit-qa/screenshots/`. The directory is gitignored and deleted on session shutdown. If stale dirs remain after a crash, they are safe to `rm -rf`.
- Reports referencing screenshots via `<img src="file://...">` are inlined to base64 by the server when the agent submits via `report_html_file` (20 MB cumulative cap, session-cwd-scoped). See [qa-testing.md — Screenshots in QA reports](qa-testing.md#screenshots-in-qa-reports).

## Worktree-pool errors at startup on a fresh install / `pool/_pool-*` branches in an unrelated repo

- **Symptom**: brand-new bobbit install with no user projects registered emits `[worktree-pool]` errors at startup, or `pool/_pool-*` branches and worktrees appear inside an unrelated git repo (e.g. a bobbit source clone, or whichever directory you happened to `cd` into before launching bobbit). Reproduces only when the bobbit state dir is itself nested inside some ancestor git work tree.
- **Root cause**: at startup the server registers a hidden synthetic project (id `system`, anchored at `<bobbitStateDir>/system-project/`) as a persistence anchor for system-scope tool-assistant sessions. The boot worktree sweeper and pool-init loops used to iterate **every** `ProjectContext` via `ProjectContextManager.all()`, including the hidden one. The pool's `isGitRepo(repoPath)` gate shells out to `git rev-parse --is-inside-work-tree`, which walks **up** the directory tree — so when `<bobbitStateDir>/system-project/` is nested inside any ancestor `.git`, the gate passes and the pool starts allocating `pool/_pool-*` branches and worktrees in the unrelated host repo.
- **Fix**: `ProjectContextManager.visible()` skips `hidden: true` contexts. Worktree sweeper, pool init, goal-manager pool-resolver wiring, `/api/maintenance/orphaned-worktrees` cleanup, and the `/api/sessions` + `/api/goals` listing aggregations all iterate `visible()` instead of `all()`. Callers that legitimately need the hidden system project (session/goal lookup by id, MCP discovery, system-scope tool authoring resolution) keep using `all()`. Pinned by `tests/system-project-pool-leak.test.ts`.
- **Diagnostic checks**:
  1. `git -C <bobbit-state-dir> rev-parse --show-toplevel` — if it prints any path, the state dir is inside a host git repo and the pre-fix bug would trigger.
  2. `git -C <host-repo> branch --list 'pool/_pool-*'` — leftover branches from before the fix are safe to delete; `git -C <host-repo> worktree list` will also show stray `<host-repo>-wt/pool/_pool-*` entries that can be removed via `git worktree remove`.
  3. New worktree/pool/sweeper iteration must use `visible()`. If you add a new boot-time iteration over `ProjectContextManager` and reach for `all()` reflexively, you will reintroduce this bug — see [internals.md — Iteration contract: `visible()` vs `all()`](internals.md#synthetic-system-project).

## Slow first-session preparing window on cold boot

- **Symptom**: the first session created after `npm run dev:harness` (or any fresh server start) sits in `preparing` for tens of seconds to minutes; subsequent sessions in the same server lifetime are fast. Server stdout shows `[worktree-setup] bobbit: ok` only after a long delay; until that line, every new session falls through to the cold-path `createWorktree` + per-component `runComponentSetups()` (e.g. `npm ci`).
- **Why this happens (pre-fix)**: `runBootBackgroundTasks()` in `src/server/server.ts` awaited the orphan-worktree sweeper across **all** registered projects sequentially before starting **any** pool init. With even a handful of stale session worktrees on disk the sweeper invoked multiple `git worktree list` / `git worktree repair` calls per repo, each with 10–15 s timeouts (especially slow on Windows). Pool init for project N didn't begin until projects 1…N−1 had finished sweeping, so the pool was empty for the entire window — every new session paid the full cold-path cost.
- **What changed**: sweeper and pool init now run concurrently via `Promise.all`. Per-project pool init is also parallelised across projects. Boot timing is logged with the `[boot]` prefix:
  - `[boot] sweeper start`
  - `[boot] sweeper done in Xms`
  - `[boot] pool ready: project=Y in Zms`
  - `[boot] background tasks complete in Wms`
  Reading these lines lets you attribute the wait empirically (sweeper vs per-project pool fill vs `npm ci`).
- **Why parallelising sweeper + pool init is safe**: the two operate on disjoint branch sets. The sweeper explicitly skips pool branches (`isPoolBranch` filter in `src/server/agent/worktree-sweeper.ts`), and `WorktreePool.reclaimOrphaned` only inspects pool branches. The historical comment in `server.ts` claiming a strict ordering invariant between sweeper and pool was over-stated — there is no shared mutation point. If you reintroduce a sequential await for some unrelated reason, verify the disjoint-set invariant still holds first.
- **How to diagnose**:
  1. Read the `[boot]` lines in server stdout (or `.bobbit/state/server.log` if redirected). Sweeper time and per-project pool time are reported separately. If `[boot] sweeper done` is the dominant cost, the sweeper itself needs follow-up work (per-project parallelism inside it; parallel per-repo `git worktree list`). If `[boot] pool ready: project=X in Yms` dominates, the cost is in the pool fill (`createWorktree` + setup hook).
  2. Confirm pool fill actually started before the sweeper finished by comparing timestamps on `[boot] sweeper start` vs the first `[worktree-pool] _fill` log line.
  3. If the dev server is being smoke-tested against a clean checkout and you want to skip the pool entirely (e.g. CI), set `BOBBIT_SKIP_WORKTREE_POOL=1`. Sessions then always take the cold path — useful as a baseline measurement.
- **Mitigations not yet applied (follow-up candidates)**: per-project parallelism *inside* the sweeper itself; parallel per-repo `git worktree list` invocations; pre-warming `node_modules` outside the per-session window so the cold path is cheap.
- **Test-only knob**: a deterministic preparing-window extension hook exists in `src/server/agent/session-setup.ts` for the regression E2E (`tests/e2e/ui/preparing-ux.spec.ts`). It is intentionally undocumented in user-facing material; do not surface it as a tuning option.

## Worktree setup hook not running

Symptoms: a freshly-claimed pool worktree has an empty `node_modules/`; the team lead's first `npm run check` / `npm test` fails with `Cannot find module ...`; staff agents wake without dependencies installed; multi-repo worktrees missing per-component artifacts.

Root cause class: a consumer reads the migrated-away top-level `worktree_setup_command` key from `project.yaml` instead of `components[*].worktreeSetupCommand`. Three call sites historically had this bug (`server.ts`, `staff-manager.ts`, `git.ts::readWorktreeSetupCommand`); they now route through `runComponentSetups()` from `src/server/skills/worktree-setup.ts`.

**Verify the fix is in place:**

1. Tail server logs for a pool fill and confirm the line `[worktree-pool] running setup for components: <names>` appears whenever at least one component declares `worktreeSetupCommand`. Absence of the log on a project that *should* have setup means the components resolver returned an empty list — check `projectConfigStore.getComponents()` is wired in `initWorktreePoolForProject`.
2. Confirm `components[*].worktree_setup_command` is set on the **right component** in `.bobbit/config/project.yaml`. The legacy top-level key is migrated by `state-migration/migrate-project-yaml.ts` and must not appear in current files. If you see both, the migration didn't run — delete the top-level key by hand or trigger the migration.
3. Run the regression-guard tests: `npm run test:unit -- worktree-pool` and `npm run test:unit -- worktree-setup-fallback`. The first greps `src/` for `.get("worktree_setup_command")` and fails if any file outside `migrate-project-yaml.ts` reads the legacy top-level key. The second fails if any caller passes a `setupCommand` argument to `createWorktree` / `createWorktreeSet` or references the deleted `setupWorktreeDeps` helper.
4. For staff: confirm `StaffManager.refreshWorktree()` calls `runComponentSetups()` on wake (non-sandboxed staff only). Sandboxed staff skip host-side refresh — setup runs inside the container via the same helper.
5. For session-setup fallback (pool empty, single-repo): `session-setup.ts::executeWorktreeAsync` calls `createWorktree` and then invokes `runComponentSetups()` against `projectConfigStore.getComponents()`, so each component's hook runs at `<wt>/<repo>/<relativePath>/`. If the wrong component's hook runs first, reorder them in `project.yaml`.
6. For single-repo goal worktrees on the non-pool fallback: `goal-manager.ts::setupWorktree` calls `runComponentSetups()` after `createWorktree` succeeds, mirroring the multi-repo branch. If the hook silently no-ops, confirm the call site has not been refactored back to a no-arg `createWorktree`.

Why this regressed silently before: the pool, staff, and session-setup all called `setupWorktreeDeps(undefined)` (or its equivalent) and that function's no-op-on-empty contract treated "undefined command" as "no setup configured" rather than "misconfigured caller". The legacy `setupCommand` parameter on `createWorktree` / `createWorktreeSet` and the `setupWorktreeDeps` helper have since been removed; `runComponentSetups()` from `src/server/skills/worktree-setup.ts` is now the only path. The loud log line and the two regression-guard unit tests make any recurrence visible. See [internals.md — Per-component `worktree_setup_command`](internals.md#session-worktrees) for the data flow.

## Worktree setup hook ran at wrong cwd

Symptom: `worktree_setup_command` runs but at the wrong directory — typically the worktree root instead of `<wt>/<component.repo>/<component.relativePath>/`. A `pwd > /tmp/setup-cwd` probe in the hook shows the branch container, and dependencies land in the wrong place (e.g. `node_modules/` at the worktree root for a component with `relative_path: app`).

Root cause class: a caller passes the hook through the legacy `setupCommand` parameter of `createWorktree` / `createWorktreeSet` (which used `worktreePath` as cwd and ignored `relativePath`) instead of routing through `runComponentSetups()` (which resolves cwd via `componentRoot()`).

**Verify and fix:**

1. The legacy `setupCommand` parameter and the `setupWorktreeDeps` helper have been removed from `src/server/skills/git.ts`. If a recent change reintroduced either, `tests/worktree-setup-fallback.test.ts` will fail — run `npm run test:unit -- worktree-setup-fallback`.
2. The only correct cwd resolver is `componentRoot()` inside `src/server/skills/worktree-setup.ts::runComponentSetups`. Every worktree-creation site (pool `_fill()`, staff wake refresh, both `goal-manager.ts::setupWorktree` branches, and `session-setup.ts::executeWorktreeAsync`) must call `runComponentSetups()` *after* `createWorktree` / `createWorktreeSet` returns — never as a `createWorktree` argument.
3. The two fallback paths historically affected were `session-setup.ts::executeWorktreeAsync` (single-repo non-pool) and `goal-manager.ts::setupWorktree` (single-repo non-pool); both now match the multi-repo path. If you see the symptom, the most likely cause is a fresh call site that bypassed `runComponentSetups()`.

See [internals.md — Per-component `worktree_setup_command`](internals.md#session-worktrees) for the full call-site table.

## Tool-guard extension ParseError (new sessions crash)

- Symptom: every new session for a role with at least one `never`-policy tool fails to start with a TypeScript `ParseError` from the generated tool-guard extension.
- Root cause: the generator in `src/server/agent/tool-guard-extension.ts` builds its extension source as a template literal. Using `\"` inside the outer backticks silently collapses to an empty string, producing broken output like `"" + toolName + ""`. Use single quotes for string literals emitted into the template; do not try to escape double quotes inside a backtick-wrapped generator.
- Regression guard: `tests/tool-guard-extension.test.ts` transpiles and dynamically imports the generated source across all four policy-input variants (allow-only, ask-only, never-only, mixed). Any parse-level quoting slip fails that spec.

## Leaked remote branches

Symptom: `origin` accumulates `session/*`, `goal/*`, `goal-goal-*-<role>-*`, or `staff-*` branches that should have been cleaned up when their owning session/goal/staff was archived.

**Diagnose:**

```bash
# Count leaked branches by class.
git ls-remote origin | grep -E '^[a-f0-9]+\s+refs/heads/(session|goal|staff)' | wc -l
git ls-remote origin | grep -oE 'refs/heads/(session|goal|staff)[^[:space:]]*' | sort -u
```

**Checklist:**

1. Confirm `BOBBIT_TEST_NO_PUSH` is **unset** in the production env. Every push-delete is gated by `shouldSkipRemotePush()` in `src/server/skills/git.ts`; if the env var leaks into a real server (e.g. inherited from a test runner) all cleanup silently no-ops.
2. For per-role goal branches (`goal-goal-<slug>-<id>-<role>-<short>`): verify the DELETE `/api/goals/:id` handler in `src/server/server.ts` snapshots `agentBranches` into a `string[]` **before** calling `teamManager.teardownTeam(id)`. Teardown's `dismissRole` mutates `entry.agents` in place — reading the entry afterwards sees an empty array.
3. For `session/*` branches: verify `session-manager.ts::terminateSession` invokes `eagerDeleteRemoteSessionBranch` from `src/server/agent/session-eager-branch-delete.ts` for non-delegate sessions. The helper requires the branch to be fully merged into `origin/<primary>` (via `git merge-base --is-ancestor`); unmerged branches defer to the 7-day `purgeOneSession` worktree cleanup.
4. For `staff-*` branches: `cleanupWorktree(..., deleteBranch=true)` in `skills/git.ts` already push-deletes. If a staff branch leaks, check that `staff-manager.ts` is actually calling `cleanupWorktree` with `deleteBranch=true` on dismiss.
5. Pre-existing backlog (predates the fix): drain with a one-shot script. Out of scope for the runtime cleanup contract.

Full design + bug archaeology in [docs/design/orphan-remote-branch-cleanup.md](design/orphan-remote-branch-cleanup.md). Architecture summary: [docs/internals.md — Remote branch cleanup](internals.md#remote-branch-cleanup).

## `models.json` stale / missing `x-opencode-session` header after gateway upgrade

Symptom: a new aigw-side model isn't selectable, or per-session header partitioning isn't happening for users whose `~/.bobbit/agent/models.json` predates the `x-opencode-session` feature.

Resolution: restart the gateway. `startupAigwCheck` in `src/server/agent/aigw-manager.ts` now re-discovers models and rewrites `~/.bobbit/agent/models.json` on every startup when aigw is configured, preserving non-aigw providers and user `modelOverrides`. Look for `[aigw] re-discovered <N> models on startup, refreshed models.json` in the gateway log to confirm. If you instead see `[aigw] gateway unreachable on startup (<msg>), keeping existing models.json`, the gateway HTTP probe failed and the file was deliberately left as-is — fix gateway connectivity and restart again.

`BOBBIT_SKIP_AIGW_DISCOVERY=1` semantics shifted with this change: it now skips only the network call. When aigw is already configured, Bedrock env vars are still applied and the existing `models.json` is kept untouched. Previously this flag short-circuited everything pre-config; the post-config refresh path is the new behaviour.

See [docs/internals.md — Startup refresh of models.json](internals.md#startup-refresh-of-modelsjson).

## Review/naming model mismatch under AI Gateway

Symptom: An AI Gateway is configured with `default.sessionModel` and `default.reviewModel` set to different models, but reviewer/QA sub-sessions run on the session model (or the naming path silently fails to generate a title).

Troubleshooting checklist:

1. Is `default.reviewModel` set in Settings → Models?
2. Does the pref resolve? Open Settings → Models; if the row shows a red "Unavailable" badge, the stored pref does not match any current `/api/models` entry. Click Clear and re-pick.
3. Does the Test button succeed for that row? Failure reveals whether the gateway rejects the model id (drift / wrong provider prefix).
4. If Test passes but reviewers still abort: check the goal dashboard gate verification output — `applyReviewModelOverrides` (`src/server/agent/review-model-override.ts`) logs at `console.error` with the pref, normalized id, and the mismatched model id the agent actually reports.
5. For naming-model issues under an AI Gateway: confirm the gateway exposes at least one Claude model (any tier); otherwise title generation falls back to direct `api.anthropic.com` (see `pickFallbackAigwNamingModel` in `title-generator.ts`).

## Role model override not applied

Symptom: a role has been customized with a `model` (and/or `thinkingLevel`) on the **Model** tab, but sessions running under that role still bind to `default.sessionModel` (or, for verification reviewers, to `default.reviewModel`).

Troubleshooting checklist:

1. **Role YAML actually has the field.** Open the role's YAML on disk (`.bobbit/config/roles/<name>.yaml`, or the project-scoped equivalent under the project's config directory) and confirm a line like `model: "anthropic/claude-opus-4-1"` is present. If the field is absent, the UI Save likely sent an empty string — which is intentionally omitted from YAML — and you'll need to re-pick a model and Save again.
2. **Cascade resolves what you expect.** A project-level role override replaces the *entire* server role record. If you set `model` only at the server level but a project-level YAML for the same role exists without `model`, the project record wins and the model is `undefined`. `GET /api/roles?projectId=<id>` shows the resolved role and its `origin` / `overrides` chain.
3. **`applyModelString` succeeded.** Model failures are loud: look for `[session-manager] Role model "..." failed for <sessionId>` (regular sessions) or `[verification] Role model "..." failed for <sessionId>` (reviewer/QA) in the gateway log. The same red "Unavailable" pill that Settings → Models shows applies here — click the per-row Test button on the role's Model tab to confirm the gateway exposes that model id.
4. **Per-session override didn't win.** If a user picked a model in the composer for that session, or if a programmatic caller passed `skipAutoModel: true` (e.g. delegate sessions with an explicit model arg), the role layer is intentionally bypassed. Check `RemoteAgent.setModel` calls in the session log and the `skipAutoModel` flag on the originating dispatch.
5. **Reviewer/QA steps only:** confirm the verification harness has the `configCascade` wired in. Without it, the harness falls back to `roleStore.get(role.name)` which sees only server-level overrides — a project-level role override would silently be ignored. This is a wiring bug at the `VerificationHarness` constructor site, not a role-config bug.
6. **Thinking level mismatch is non-fatal.** Unlike model failures, an unsupported `thinkingLevel` only logs a `console.warn` and falls through to the global default. If thinking is not being applied, grep the log for `Role thinking level "..." failed`.
7. **Spawned worker / team-lead / staff session ignores the role override entirely** (binds straight to `default.sessionModel`, no "Role model ... failed" log line — the resolver never even sees the role id). `SessionSetupPlan` carries two parallel fields naming the same role: `role` (used historically) and `roleName` (used by `team-manager.spawnRole`, `startTeam` for the team lead, and `staff-manager`). `_resolveBridgeOptions` in `src/server/agent/session-setup.ts` falls back to `plan.role ?? plan.roleName` so callers that set only one of them still get role-keyed pinning; the same fallback mirrors onto `session.role` so the post-spawn `tryAutoSelectModel` safety net keys off the right id. If you see this symptom on a new spawn path, the most likely cause is a caller that sets neither field — add `roleName` at the call site rather than re-introducing the fallback elsewhere. Pinned by `tests/session-setup-role-override.test.ts`.

See [docs/internals.md — Per-role model & thinking-level overrides](internals.md#per-role-model--thinking-level-overrides) and [docs/design/per-role-model-overrides.md](design/per-role-model-overrides.md) for the full mechanics.

## `PUT /api/roles/:name?projectId=X` returns 404 "Role not found" for a builtin role

Symptom: editing a builtin role (`coder`, `architect`, ...) on the Role Manager page for a project returns `404 { error: "Role not found" }` (older builds: `"Role not found in project"`). The role appears fine in `GET /api/roles?projectId=<id>` and the role-manager listing, but the very first save fails.

Root cause: pre-fix, the PUT handler called `ctx.roleStore.get(name)` directly. `ctx.roleStore` is the project-scoped store, which only contains roles explicitly overridden at project level — builtins live in the cascade (`BuiltinConfigProvider`) and are absent until promoted.

Fix (commit `f618ab09`): the handler now resolves through `configCascade.resolveRoles(projectId)` first and falls back to the cascade item when the project store has no entry. The subsequent `ctx.roleStore.put(updated)` promotes the role to project scope on first edit — same "promote-on-first-edit" shape used by `POST /api/roles/:name/customize`. The same handler's adjacent `"Project not found"` response was migrated to `jsonError()` in the same pass.

Pinning test: `tests/api-roles-update.test.ts` covers (1) builtin promoted on first PUT, (2) follow-up PUT on the now project-scoped record, (3) unknown role still 404.

## Reviewer session triggers spurious "Agent finished" team-lead nudge after restart

Symptom: the team lead session receives `team_agent_finished` / "Agent ... has finished" steers naming an `llm-review-*` (or QA) sub-session. Reviewer sessions are owned by the verification harness and must never nudge the team lead — every such steer is a bug. The symptom is **restart-specific**: it does not appear during the normal in-process verification run.

Root cause: `TeamManager.registerReviewerSession()` persists the reviewer into `entry.agents` (in `team-state.json`) so that mid-verification restarts can recover the link between gate step and session. Pre-fix there was no field distinguishing reviewer agents from worker agents on the persisted record. After restart, `resubscribeTeamEvents()` walked `entry.agents` and re-attached the `agent_end → notifyTeamLead()` listener to every entry, including reviewers. The live (pre-restart) code path subscribes only to `tool_execution_end`, so the bug is invisible until the server is bounced mid-verification.

Fix: a `kind: "worker" | "reviewer"` discriminator on `TeamAgent` and `PersistedTeamEntry`.

- `registerReviewerSession()` writes `kind: "reviewer"`; regular `dispatchToRole`/spawn paths write `kind: "worker"`.
- `resubscribeTeamEvents()` skips agents with `kind === "reviewer"` (or, defensively, `role === "reviewer"`).
- `notifyTeamLead()` has the same defensive guard so even a stray subscription cannot fire.
- Older `team-state.json` entries written before the field existed default to `"worker"` on load; the `role === "reviewer"` fallback in both guard sites catches reviewers whose `kind` did not survive the persisted-shape migration.

Diagnose:

1. Confirm the team lead session is the recipient (the steer text is `"Agent <id> has finished"`).
2. Look up the named sub-session — if its id starts with `llm-review-` or it appears under a gate's `sessionId`, it is reviewer-owned and the steer should never have been delivered.
3. Inspect `<stateDir>/team-state.json`: every reviewer entry must have `kind: "reviewer"`. If it shows `kind: "worker"` (or no `kind` at all) for a reviewer, the registration path skipped the discriminator — check `registerReviewerSession()` was the entry point, not a generic `addAgent`.
4. Restart the server and replay: pre-fix the steer fires within milliseconds of the agent's `agent_end`; post-fix it never fires.

Key files: `src/server/agent/team-manager.ts` (`registerReviewerSession`, `resubscribeTeamEvents`, `notifyTeamLead`), `src/server/agent/team-store.ts` (`PersistedTeamEntry.agents[].kind`). Regression test: `tests/team-manager-reviewer-resume.test.ts`. See [docs/internals.md — Reviewer kind & restart resume](internals.md#reviewer-kind--restart-resume).

## Resumed reviewer terminated ~46ms after server restart, before reminder is acted on

Symptom: after a server restart mid-verification, one or more reviewer steps fail with `"Agent did not call verification_result after server restart and reminder."` Inspecting the gate signal shows the reviewer session was archived within tens of milliseconds of `lastActivity`, far too fast for the agent to have read and replied to the reminder prompt.

Root cause: the resume path dispatches a reminder prompt and races the resulting `verification_result` against `SessionManager.waitForIdle(sessionId, ...)`. `waitForIdle` resolves **synchronously** when `session.status === "idle"`. After a restart the resumed session is idle by definition; `rpcClient.prompt()` is fire-and-forget on the RPC channel and does not transition the session to `streaming` synchronously. So the race resolved as `idle` instantly, the harness declared failure, and the `finally` block terminated the session before the agent ever saw the reminder.

The live (non-resume) reviewer path had the same code shape but was not affected in practice because the kickoff prompt had already pushed the session into `streaming` long before the race began.

Fix: a sibling helper `SessionManager.waitForStreaming(sessionId, timeoutMs = 10_000)` mirrors `waitForIdle` but resolves on `agent_start` (or rejects on `process_exit` / timeout). Every reminder site now awaits `waitForStreaming(...).catch(() => {})` between the prompt dispatch and the existing `waitForIdle` race. A 10s window is generous — a healthy agent acknowledges within ~100ms — and on timeout the code falls through to the original `waitForIdle` race, so a genuinely unresponsive agent still fails as before.

The four reminder sites (all in `src/server/agent/verification-harness.ts`):

1. `_tryResumeFromSession` — restart-resume reminder. The original repro.
2. `runLlmReviewViaSession` — live llm-review reminder; symmetric for consistency, even though the bug is not reachable via the kickoff race.
3. QA-tester reminder.
4. Legacy direct-`RpcBridge` reminder (no `SessionManager` available — uses an inline `agent_start` listener with the same 10s timeout shape).

If you add a fifth reminder site, you must apply the same pre-race wait or you will reintroduce the bug.

Diagnose:

1. Compare the reviewer session's `lastActivity` and archive timestamp in the session log. A delta under ~1s for a step that failed with the reminder error string is the fingerprint.
2. Confirm the build includes `waitForStreaming` — grep `src/server/agent/session-manager.ts` for the symbol.
3. Confirm all four reminder sites await it. The regression-guard test (`tests/verification-reminder-race.test.ts`) mocks a session that flips from idle to streaming after 50ms and asserts `_tryResumeFromSession` does not terminate within the first second.

Key files: `src/server/agent/session-manager.ts` (`waitForStreaming`), `src/server/agent/verification-harness.ts` (the four reminder sites). Tests: `tests/verification-reminder-race.test.ts`, API E2E `tests/e2e/gate-verification-resume.spec.ts`. See [docs/internals.md — Reminder race after restart-resume](internals.md#reminder-race-after-restart-resume).

## Verification step fails with `Role "X" not found. Available roles: ...`

The verification harness (or `team_spawn`) couldn't resolve a role name to either a goal-scoped inline role or a project/server/builtin store entry. This is a fail-loud error by design — the agent must see what's available so it can pick a valid name or propose a new one.

Resolution order applied by `resolveRole(goal, name, roleStore)` in `src/server/agent/resolve-role.ts`:
1. `goal.inlineRoles[name]` — ephemeral, snapshotted at goal creation, frozen forever for that goal
2. `roleStore.get(name)` — project → server → builtin cascade

The error message lists everything `listAvailableRoles(goal, roleStore)` can find, inline first then store, deduped by name.

Diagnose:
1. **Misspelt name** — check the spelling in the workflow's `verify[]` step or in the `team_spawn(role=...)` argument against the listed names.
2. **Inline role expected but missing** — read the goal record from `.bobbit/state/goals.json`. If `inlineRoles` is undefined, the `propose_goal` / `goal_spawn_child` call didn't include the role. Re-propose with `inlineRoles: { <name>: { ... } }`.
3. **Inline role NOT inherited from parent** — `goal_spawn_child` merges `parent.inlineRoles` with `body.inlineRoles`, child wins on collision. If the parent's inline roles aren't on the child, check the spawn-child handler in `src/server/agent/nested-goal-routes.ts` (extracted from `server.ts` — look for the merge `{...parentInlineRoles, ...bodyInlineRoles}`).
4. **Custom role missing from project library** — if you intended a permanent role, run `propose_role` and accept the proposal. The role then becomes available across all goals via the cascade.

Tests pinning the precedence rule: `tests/resolve-role.test.ts`. Snapshot + child-merge: `tests/goal-manager-inline-roles.test.ts`. Full HTTP roundtrip: `tests/e2e/api-goals-spawn-child-route.spec.ts`.

Key files: `src/server/agent/resolve-role.ts` (pure helper), `src/server/agent/team-manager.ts::_startTeamImpl` (team-lead spawn) and `team-manager.ts::spawnRole` (worker spawn), three sites in `src/server/agent/verification-harness.ts` (model-resolution, llm-review, agent-qa). All five sites also forward the resolved role's `model` / `thinkingLevel` as `initialModel` / `initialThinkingLevel` — see [docs/internals.md — Spawn-time model pinning](internals.md#spawn-time-model-pinning).

## propose_goal inline fields silently dropped

**Symptom:** an agent calls `propose_goal` with `inlineWorkflow` and/or `inlineRoles` and the tool result returns success (`__proposal_rev_v1__:N`), but the draft on disk at `<stateDir>/proposal-drafts/<sessionId>/goal.md` shows only `title`, `cwd`, `workflow`, `options` in the YAML frontmatter — both inline fields are missing. The proposal panel in the UI consequently renders an empty "Advanced: paste inline workflow YAML" textarea and no inline-roles section.

**Cause:** two compounding bugs.

1. The goal serializer at `src/server/proposals/proposal-types.ts` (the `goalPlugin.serialize` function) used to hardcode the four legacy keys `["title", "cwd", "workflow", "options"]` and silently drop everything else. The fix iterates `GOAL_FRONTMATTER_KEYS` (now includes `inlineWorkflow` and `inlineRoles`) and validates the structure of either field when present via `validateGoalInlineFields`.
2. `defaults/tools/proposals/extension.ts::propose_goal.execute` had a conditional rename `inlineWorkflow → workflow` when `workflow` was empty, which also corrupted the type contract (`workflow` is a string id, `inlineWorkflow` is a full Workflow object). Removed — the two fields are now passed through untouched.

**Diagnose:**

1. Reproduce by calling `propose_goal` with both fields and immediately `view_proposal type:"goal"`. The returned markdown's frontmatter must contain `inlineWorkflow:` and `inlineRoles:` keys.
2. If the keys are missing, grep `src/server/proposals/proposal-types.ts:43` for `GOAL_FRONTMATTER_KEYS` — it must include both names. Without them, the fix has been reverted.
3. If the keys are present in the draft but the goal record on `GET /api/goals/:id` doesn't carry them, check the acceptance path: `src/app/render.ts::handleCreateGoal` reads `state.activeProposals.goal?.fields.inlineWorkflow` and `inlineRoles` BEFORE deleting the slot, then passes them to `createGoal()` in `src/app/api.ts:851`. Both call sites (`goalPreviewPanel`, `goalProposalPanel`) must read from the proposal slot.
4. For the role-acceptance equivalent: `src/app/render.ts::handleCreateRole` snapshots the proposal slot before delete and forwards `toolPolicies` (preferring the explicit Record over the comma-string reconstruction), `model`, `thinkingLevel`, `description` to `createRole()`. The same silent-drop bug class would affect roles when an agent set those fields via `edit_proposal(type="role", ...)`.

Tests pinning the contract:

- `tests/proposal-types-goal-inline.test.ts` — round-trip + structural validators.
- `tests/e2e/api-goals-propose-inline.spec.ts` — seed→read draft preserves both keys; POST /api/goals with both fields snapshots them onto the goal record.

## MCP server unavailable / partial outage

Failed MCP servers stay in `error` state but don't break the agent. Look for the stub meta extension at `<stateDir>/mcp-extensions/[<hash>/]<server>.ts` whose `execute` returns `MCP server '<name>' is unavailable: <reason>`. Per-call timeouts: 10 s on `tools/list`, 30 s on `tools/call` (constants in `src/server/mcp/mcp-manager.ts`). Schema-validation drops malformed ops via `isValidOperationSchema` from `src/server/mcp/mcp-meta.ts` — sibling ops on the same server stay usable.

## MCP per-op `never` policy not enforced

Two-layer enforcement:
- **Layer A (model-facing)**: meta-tool aggregation collapses N×M ops into one `mcp_<server>` tool, so per-op grants flow through `mcpPolicyPrefix` regex which matches BOTH `mcp__pw__snap` and `mcp_pw`.
- **Layer B (server-side)**: `POST /api/internal/mcp-call` calls `resolveGrantPolicy(tool, …)` before `mcpManager.callTool` and returns 403 on `never`.

If a per-op policy isn't taking effect, check both layers.

## MCP server dropdown reads "Allow (default)" but agent is denied

Historical bug, fixed on `master`. `defaults/tool-group-policies.yaml` used to ship `mcp__playwright: never` and `mcp__nano-banana: never` as builtin denials. The Tools page can't render cascade origin, so the dropdown showed "Allow (default)" while the guard actually blocked every call. Removed in commit `5e633d40` ("MCP policy parity: drop builtin denials so default is allow"). MCP groups now default to `allow` like every other tool group — see [internals.md — MCP groups default to `allow`](internals.md#mcp-groups-default-to-allow).

If you still see this on an old build, upgrade — or check `.bobbit/config/tool-group-policies.yaml` for an explicit user override that shadows the (now-empty) builtin layer. Per-role denials (e.g. `qa-tester` blocking `mcp__playwright`) are intentional and live in role YAML, not group policy.

## Tools page "MCP" section missing or empty

`GET /api/mcp-servers` returns the structured list (`{name,status,toolCount,tools[]}`). `src/app/tool-manager-page.ts::renderMcpSection()` filters them out of normal group rendering and shows one row per server in a dedicated MCP section. Empty section means `getMcpManager()` returned no configs — check the `discoverServers()` cascade in `src/server/mcp/mcp-manager.ts`.

## Auto-nudge flooding

Symptom: team-lead receives many `team_agent_finished` steers in quick succession. Cause: missing dedup. The `nudgePending` guard in `TeamManager` coalesces concurrent nudges into one delivery; if a regression removes it, a flood returns. Reviewer / QA sub-sessions are additionally filtered by `kind: "reviewer"` in `resubscribeTeamEvents()` and `notifyTeamLead()` — they must never nudge the team lead.

## Team-lead idle while coder is idle / workflow stalled

Symptom: a team-lead session and one or more of its workers are all idle for many minutes; no auto-nudge fires; the goal silently makes no progress until a human manually `/notify`-pings the lead. Canonical repro: a coder finishes pushing its branch and goes idle, the team-lead is also idle, and a 7+ minute stall persists until a manual ping resolves it.

Three failure modes can produce this stall (ranked by likelihood, per the [auto-nudge design doc](design/auto-nudge-stuck-team-leads.md) Section 1):

1. **Most likely — immediate notification fired but the lead acted on it weakly or not at all.** The `notifyTeamLead` text is informational ("Agent X has finished. Tasks: ..."); a lead can rationalise "task is in-progress, the worker will continue" and do nothing. The manual `/notify` ping resolved the original stall instantly with *no new information*, which is the fingerprint of this mode.
2. **Plausible — the worker's `agent_end` event was dropped.** If the gateway restarted between the worker's `agent_start` and `agent_end`, the RPC event itself is ephemeral and not replayed. `resubscribeTeamEvents()` re-installs the listener for any *future* `agent_end`, but a finish-mid-restart is lost.
3. **Unlikely — the team-lead session was archived or restarted between the worker's start and finish.** Would normally be visible as a respawned team-lead session in the sidebar.

### Diagnose

1. Confirm the symptom: `lead.status === "idle"`, every worker in the team's `entry.agents` has `status === "idle"`, and minutes have passed since either side last did anything.
2. Grep the server log for the three nudge-path markers —
   - `[team-manager] notifyTeamLead deferred ...` — the immediate path was reached but the per-worker 30s `lastNotifyTime` debounce swallowed a duplicate. Healthy.
   - `[team-manager] Sent ...` — the immediate `notifyTeamLead` enqueued a steer. The lead should have acted within seconds.
   - `[team-manager] Stuck-team watchdog fired for goal <id> after Nm idle` — the 60-second sweep recovered the stall. If you see this without a prior `[team-manager] Sent`, mode (2) above is the cause; if you see both, mode (1).
3. Inspect the team store: `entry.teamLeadSessionId` must be set; `getActiveWorkers(goalId)` (the same predicate the watchdog uses) must return a non-empty list. If `leadIdleSinceByGoal[goalId]` is unset, the lead's `agent_end` handler in `subscribeTeamLeadEvents` never fired — likely the lead session is missing or the resubscribe path didn't seed it.
4. Check `shouldSkipNudge(goalId)` doesn't unconditionally short-circuit: the goal is not paused, archived, complete, or shelved; no in-flight verifications; `nudgePending` is false; `anyInFlightChild` returns false (a parent whose subgoals are still progressing intentionally suppresses the nudge — the child-RTM cross-tree path will wake it).

### The three safety-net layers

All three live in `src/server/agent/team-manager.ts` and funnel through the single `shouldSkipNudge(goalId)` gate:

- **Immediate `notifyTeamLead`** — fires within ~5 seconds of a worker's `agent_end`. Per-worker 30s debounce (`lastNotifyTime`); reviewer/QA sub-sessions filtered by `kind: "reviewer"`.
- **60-second stuck-team watchdog (the new layer)** — `startStuckSweep()` registers a single `setInterval` at `STUCK_SWEEP_INTERVAL_MS = 60_000`, unref'd so it never blocks process exit. `_stuckSweepTick(now)` walks every `TeamEntry` and fires `_fireStuckNudge` when **all** of: lead is idle, `getActiveWorkers(goalId).length > 0`, every worker is idle, `now - leadIdleSince >= STUCK_QUIET_THRESHOLD_MS` (5min), `now - lastNudgeAtPerGoal[goalId] >= STUCK_QUIET_THRESHOLD_MS`, and `!shouldSkipNudge(goalId)`. The `lastNudgeAtPerGoal` map enforces a 5-minute floor between consecutive stuck-nudges — one nudge per stuck *episode*, not per sweep tick. `leadIdleSinceByGoal` is the source of truth for "how long has the lead been idle": written from the lead's `agent_end` handler in `subscribeTeamLeadEvents`, cleared on `agent_start`, and seeded on resubscribe when the lead is already idle so a server restart doesn't reset the clock.
- **Long-tail workers idle-nudge** — `IDLE_NUDGE_DELAY_MS = 600_000` (10min) base with exponential backoff up to 12h, gated on at least one worker streaming for longer than `LONG_STREAMING_THRESHOLD_MS = 30 * 60 * 1000` (30min). This is the legitimate-long-running-task safety net; the 60s watchdog covers the gap below it.

### Why "all workers idle" rather than "any worker idle"

The watchdog predicate requires **every** active worker to be idle, not just one. The looser "any worker idle for 5+ minutes" variant would nag whenever one worker has finished and another is legitimately streaming — a common shape in parallel team-lead workflows. The stricter predicate matches the canonical stall mode (lead idle + all workers idle) without producing false positives. Section 6 of the design doc records this as a deferred risk; loosen only if a real stall demonstrates it's needed.

### Tests pinning the contract

- `tests/team-manager-stuck-watchdog.test.ts` — 11 cases covering the 5-minute boundary, all-vs-some workers idle, the `lastNudgeAtPerGoal` floor, paused/archived/in-flight skips, restart resubscribe seeding `leadIdleSinceByGoal`, and the `nudgePending` ack path.
- `tests/team-manager-child-rtm-notifies-parent.test.ts` — 6 cases for the cross-tree child-RTM path through `buildParentReadyNotification` → `notifyTeamLeadFn`.
- `tests/idle-nudge-timer.spec.ts` — the existing 10-minute long-tail timer.
- `tests/notify-team-lead-child-passed.test.ts` — the pure-helper coverage for the cross-tree notification text.

Key symbols: `startStuckSweep`, `_stuckSweepTick`, `_fireStuckNudge`, `STUCK_SWEEP_INTERVAL_MS`, `STUCK_QUIET_THRESHOLD_MS`, `lastNudgeAtPerGoal`, `leadIdleSinceByGoal`, `shouldSkipNudge`, `getActiveWorkers` — all in `src/server/agent/team-manager.ts`. Cross-tree path: `src/server/agent/notify-team-lead-child-passed.ts` (`buildParentReadyNotification`) and `src/server/agent/verification-harness.ts` (`notifyTeamLeadFn`). See [docs/design/auto-nudge-stuck-team-leads.md](design/auto-nudge-stuck-team-leads.md).

## `bash_bg wait` not interrupted by steer

A steer should abort any in-flight `bash_bg wait` within ~100 ms. The bg process itself is **not** killed; only the wait call resolves with `{ aborted: true }`. Diagnose:
1. The live-steer caller routes through `SessionManager.deliverLiveSteer()` — this invokes `bgProcessManager.abortAllWaits(sessionId)` before `rpcClient.steer()`.
2. The wait registry on `BgProcessManager` — `registerWait`/`unregisterWait` from `/bg-processes/:pid/wait`; `abortAllWaits()` iterates the set.
3. `terminateSession` also calls `abortAllWaits()` before `cleanup()` so terminating sessions never leak hung wait handlers.

Tests: `tests/bg-process-manager.test.ts`, `tests/e2e/bg-wait-steer-abort.spec.ts`.

## Streaming dedup / reorder (events carry seq+ts)

Events carry `seq`+`ts`; on reconnect the client sends `{type:"resume", fromSeq}`. See [docs/design/streaming-dedup-reorder.md](design/streaming-dedup-reorder.md) for the protocol and dedup ring.

## WS overflow guard

`decideOverflowAction` in `src/server/ws/ws-overflow-guard.ts` decides drop / coalesce / disconnect when the per-session WS write buffer is over budget. Transient spikes are tolerated via a deferred re-check before disconnecting.

## Continue-Archived button missing

Only renders when (a) the session is archived, (b) it has no `goalId`, (c) it has no `delegateOf`, AND (d) the project is still registered. If the button is absent, check those four predicates against the session record.

## Continued session missing earlier transcript

`POST /api/sessions/:archivedId/continue` clones the source `.jsonl` losslessly. If the new session is missing earlier history, confirm the cloned `.jsonl` actually exists at the new `agentSessionFile` path. Worktree-backed sources are rebased onto the worktree-cwd slug-dir in `executeWorktreeAsync` — a missing rebase is the usual cause.

## Stale draft resurrection

`SessionStore.setDraft()` rejects writes with an older `gen` than the latest persisted draft. If a stale draft seems to revive after a newer save, check the `gen` monotonicity in the store.

## Proposal panel empty after reload

`proposal_update` events that arrive before the proposal panel UI binds its handler are buffered in `_bufferedProposalEvents` inside `src/app/remote-agent.ts` (getter/setter on the handler property). Rehydrate-on-attach can race ahead of UI wiring; the buffer is the entry point for diagnosis.

## Inline-comment annotations on goal/role/staff proposals

Ephemeral in-memory backend `proposalBackend` in `src/ui/components/review/proposal-annotations.ts`, keyed by `(sessionId, "proposal:<type>")`. Cleared by:
- `proposal_update` body-diff hook in `src/app/session-manager.ts` (`extractProposalBody` + `clearProposalAnnotations`).
- Dismiss / `proposal_cleared`.
- Reload (never persisted).

The `commentable: true` flag on `GoalFormConfig` is set ONLY at the goal-proposal-panel call site (`goalPreviewPanel()`), not the goal-dashboard reuse, so dashboard markdown stays read-only.

## "Send feedback" button missing on a proposal panel

Only renders when annotation count > 0 AND the proposal is not streaming (`isProposalStreaming("<tag>_proposal")` false). Badge has the same gating in Preview mode.

## "Open proposal" on old card destroys later edits

Each `propose_*` tool result carries a `__proposal_rev_v1__:<n>` marker. Clicking "Open proposal" on a stale card with a lower revision intentionally falls back to legacy archived-session behaviour rather than overwriting the live draft. If you see destruction of later edits, check the marker is being parsed.

## Proposal panel doesn't update after `edit_proposal`

Check the WS `proposal_update` frame fired by the `edit_proposal` handler and the structured error code (`not_found`, `no_match`, `multiple_matches`, `empty_replacement`). A failed `edit_proposal` does NOT mutate the on-disk draft.

## Image generation failure

`POST /api/image-generation/generate` returns `400` for malformed input and `500 { error }` for provider-side failures. It must never return `502` or `503` — those indicate a regression in the route handler.

## Goal `prUrl` removed

**Symptom:** an agent or external script PUTs `{prUrl: "..."}` to `/api/goals/:id` and the field doesn't appear on the next `GET`.

**Resolution:** that's expected — `Goal.prUrl` was removed; `PrStatusStore` (`src/server/agent/pr-status-store.ts`) is the single source of truth for goal PR URLs. `PUT /api/goals/:id` silently ignores any `prUrl` field. Read the URL via `GET /api/goals/:id/pr-status` (cached entry populated by `getCachedPrStatus()` running `gh pr list --head <branch>`).

**Re-attempt context missing PR URL:** `buildReattemptContext(goal, prStatusStore)` in `src/server/agent/goal-assistant.ts` reads `prStatusStore.get(goal.id)?.url`. If the `**PR URL:**` line is absent from a re-attempt prompt, check that the cache file (`<stateDir>/pr-status-cache.json`) has an entry for the original goal id. The store is sticky — once a PR is found by branch name it persists across restarts, so an archived/merged goal's last-known URL still surfaces.

The team-lead role no longer PUTs `prUrl` after `gh pr create` (the curl-PUT step was removed from `defaults/roles/team-lead.yaml`). All user-visible PR surfaces (sidebar badge, dashboard widget, `GitStatusWidget` link, merge button, session-footer status) already read from `PrStatusStore` / its client mirror, so behaviour is unchanged.

## Header toast vs proposal toast testid collision

The session-header toast (e.g. "Link copied" from the Copy-link button) uses `showHeaderToast()` and `data-testid="header-toast"`. The proposal-panel toast uses `showProposalToast()` and `data-testid="proposal-toast"`. Two separate state slots and two separate `<div class="review-toast">` instances in `src/app/render.ts` — do NOT collapse them onto a shared testid; E2E selectors in `tests/e2e/ui/copy-session-link.spec.ts` and `tests/e2e/ui/proposal-inline-comments.spec.ts` would alias.

## `read_session` returns `permission_denied`

Caller and target session belong to different projects. The tool extension sets the `x-bobbit-session-id` request header automatically; the server compares the two sessions' `projectId` values and rejects cross-project reads. Other structured error codes: `session_not_found`, `transcript_unavailable`, `invalid_regex`, `invalid_params`. Files: `src/server/agent/transcript-reader.ts`, `defaults/tools/agent/read_session.yaml` + `extension.ts`.

## Mobile annotation popover doesn't open after tapping "Add comment"

`_onMobileAddComment` in `src/ui/components/review/ReviewDocument.ts` must set `_popoverReferenceRect` from the current selection range before mounting the bottom-sheet popover; the `updated()` reaction keys off that field. Symptom after the singleton refactor was an empty render because the rect stayed `null`.

## Tier 2.5 report missing / ffmpeg failed

The HTML video-capture report is only emitted when `RECORDSCREEN=1`. If ffmpeg is missing, set `FFMPEG_PATH` or install ffmpeg system-wide. See [docs/testing-tier-2-5.md](testing-tier-2-5.md).

## OAuth callback never completes

If the popup window closes without the UI advancing, poll `GET /api/oauth/flow-status?flowId=&provider=` directly to see whether the server received the callback. Files: `src/server/auth/oauth.ts`; REST: `/api/oauth/*`.

## Agent silently substitutes file tools when prompted for bash / web / MCP

- **Symptom**: the agent is asked to run a `bash` command, a Bobbit extension tool (`web_fetch`, `bash_bg`, `delegate`, …), or an MCP meta-tool (`mcp_describe`, …) and instead reaches for `write` / `read` / `edit` to fake the same visible side-effect. No error surfaces; the UI shows file-tool cards rather than the requested tool. Most often appears immediately after a `@earendil-works/pi-*` upgrade.
- **Root cause in one line**: pi's `--tools <list>` allowlist semantics drifted across an upgrade (0.70+ began treating the list as an allowlist over both builtins **and** extensions), so the allowlist silently stripped every Bobbit extension and MCP-backed tool from the agent's available set. The LLM then substituted whichever still-allowlisted file builtin could approximate the request.
- **Fix already landed**: commit `fdfee7c5` switched the activation contract to `--no-builtin-tools` + `--no-extensions` + an explicit `--extension <…>/defaults/tools/_builtins/extension.ts` re-register shim, with `env.BOBBIT_BUILTIN_TOOLS` carrying the sorted list of pi file-builtins to re-register. `computeToolActivationArgs()` in `src/server/agent/tool-activation.ts` is the single source of truth.
- **Diagnostic order**:
  1. Run `npm run test:unit` and look at `tests/tool-activation-contract.test.ts`. If it fails, the flag contract has regressed at unit speed — fix `computeToolActivationArgs()` before anything else.
  2. If the unit pin is green but real agents still substitute, run `npm run test:manual` against `tests/manual-integration/agent-tool-use.spec.ts`. The seven scenarios cover pi builtins, a Bobbit extension (`web_fetch`), and an MCP meta-tool (`mcp_describe`); a failing scenario tells you exactly which tool category is being stripped.
  3. In the failing scenario, inspect the rendered tool cards: every wrapper carries `data-tool-name="<name>"`. If the named tool's card is missing while a file-tool card with the same sentinel text is present, that is the substitution signature.
- **If the symptom returns after another pi bump**: adapt Bobbit's activation contract to whatever the new pi line expects — do **not** relax either canary. See [testing-coverage.md — Agent tool-use canary](testing-coverage.md#agent-tool-use-canary-two-layers).

## 60+ TSchema errors / typebox flavor mismatch after pi upgrade

- **Symptom**: after bumping `@earendil-works/pi-ai` (or any `@earendil-works/pi-*` package that re-exports schema helpers), `npm run check` floods with structurally-incompatible-type errors against `TSchema`, `TObject`, `TProperties`, `Static<...>`, etc. Errors typically point at a file that mixes `Type.Object(...)` / `Static<typeof X>` with a pi-ai-returning helper like `StringEnum` or a tool whose `parameters` schema is consumed by pi-ai.
- **Root cause**: pi-ai 0.73+ re-exports `Type` and `Static` from typebox **v1**. Bobbit also has a direct dependency on `@sinclair/typebox` v0.34. The two packages publish structurally-different `TSchema` types, so a value built with `@sinclair/typebox`'s `Type.Object(...)` is no longer assignable to a slot that pi-ai expects to be a v1 `TObject`, even though the runtime JSON shape is identical.
- **Rule**: in any file that combines pi-ai schema helpers (or hands a schema to a pi-ai-typed slot) with `Type.Object(...)` / `Static<typeof X>`, import `Type` and `Static` from `@earendil-works/pi-ai` — not from `@sinclair/typebox`. Mixing flavors in the same file is the bug; picking one and using it consistently is the fix.
- **Reference**: `src/ui/tools/artifacts/artifacts.ts` is the canonical example — it imports `StringEnum, Static, ToolCall, Type` together from `@earendil-works/pi-ai`. Files that have no pi-ai schema interop can keep importing from `@sinclair/typebox` as before.
- **Diagnosis tip**: if the error count is large (dozens to hundreds) and all variants of `TSchema is not assignable to TSchema` originate from the same module, you're looking at a flavor mismatch, not a real type bug. Switch the `Type` / `Static` import in that file and re-run `npm run check` before changing any schema definitions.

## Bundle-size assertion fails

`tests/bundle-size.test.ts` reads `dist/ui/.vite/manifest.json` to find the entry chunk and asserts ≤ 600 kB gzipped, plus ≤ 500 kB gzipped for any non-worker chunk. Check `dist/ui/.vite/manifest.j
 manifest.json` exists; ensure `npm run build:ui` ran first; the test reads gzipped sizes directly from `dist/ui/assets/`. The `pdf.worker.min-*.mjs` chunk is whitelisted. See [docs/design/ui-bundle-size-reduction.md](design/ui-bundle-size-reduction.md).

## Markdown not rendering in chat / proposal panel

`<markdown-block>` is lazy-loaded via `ensureMarkdownBlock()` from `src/ui/lazy/markdown-block.ts`. The consumer must call it in its `connectedCallback()` or first `render()`. Symptom of forgetting: markdown shows as raw text until something else triggers the load. Lit upgrades the custom element asynchronously when the chunk lands.

## Page chunk fails to load on first navigation

`lazyPage()` in `src/app/render.ts` returns `loadingPlaceholder()` while the dynamic `import()` resolves, then caches the module and calls `renderApp()`. If the chunk 404s, the placeholder sticks. Check Network panel for the failed `dist/ui/assets/<page>-*.js` and verify the chunk name in the `lazyPage()` call matches a manifest entry.

## Lazy tool renderer placeholder sticks

Symptom: a `preview_open` (or other lazy-loaded tool: `gate_inspect`, `verification_result`, `extract_document`, `javascript_repl`, `read_session`) widget renders as the card-shaped placeholder — header icon + tool name + a disabled "Loading…" button — and never swaps in the real renderer. The Open / Inspect / etc. button never appears even after the lazy chunk should have landed.

Likely causes:

1. A `<tool-message>` or `<tool-group>` instance didn't receive the `bobbit-tool-renderer-loaded` event (`TOOL_RENDERER_LOADED_EVENT` in `src/ui/tools/renderer-registry.ts`). Most often because the listener wasn't attached — the consumer must register it in `connectedCallback()` and remove it in `disconnectedCallback()`. Any new rendering surface that calls `renderTool()` directly needs the same listener wiring.
2. The loader threw and the failure was swallowed. The registry installs a `makeLoadFailureRenderer` fallback that paints an error card ("Renderer failed to load — refresh to retry"), so an indefinite spinner means the failure path itself is broken — most likely `startLoad()` didn't dispatch the event on the rejection branch.

Fix path:

- Confirm `startLoad()` in `src/ui/tools/renderer-registry.ts` dispatches `TOOL_RENDERER_LOADED_EVENT` on **both** success and failure branches with `detail: { toolName }` on `document`.
- Confirm `<tool-message>` (`src/ui/components/Messages.ts`) and `<tool-group>` (`src/ui/components/ToolGroup.ts`) add the listener in `connectedCallback`, filter on `e.detail.toolName` matching this instance's tool, and call `requestUpdate()`.
- Check the browser console for `[tool-registry] failed to lazy-load renderer for "<name>"` — if present, the loader itself rejected and the fallback card should now be visible.

## QA screenshot token bloat

The QA extension must emit `[screenshot_file]<path>[/screenshot_file]` markers, not `[screenshot_base64]…`. Inline base64 blows the model context budget. Check the extension under the QA tool group.

## Stale project-proposal panel after `propose_project`

`onProjectProposal` shallow-merges the incoming proposal into the panel state. If a field disappears or stays stale, verify the merge isn't replacing the whole object and check the `proposal_update` envelope shape.

## `lastActivity` reads "just now" after restart

The `isUserVisibleActivity` filter in `src/server/agent/session-manager.ts` decides which event types bump `lastActivity`. Internal heartbeats / state pushes are excluded. If every restored session reads as "just now", check the filter hasn't been weakened.

## Sidebar shows spurious "now ●" (unread dot) on idle sessions

Symptom: idle sessions in the sidebar repeatedly flip to "now" with an unread dot, roughly every ~15s, even though no agent activity has occurred. The state self-heals within ~5s (next `/api/sessions` poll) but recurs on the next status heartbeat.

Cause: a client-side writer is mutating `lastActivity` in response to `session_status` WS frames. The server is the sole authoritative writer of `lastActivity` - `updateLocalSessionStatus()` in `src/app/api.ts` must update `status` only. See [internals.md - Client must not mutate `lastActivity`](internals.md#client-must-not-mutate-lastactivity). Pinned by `tests/spurious-idle-unread.spec.ts`.

## Symlinked project root rejected with `code: symlink_root`

`POST /api/projects` returns HTTP 400 `{ error, code: "symlink_root", rootPath, canonical }` when the supplied `rootPath` differs from `realpathSync(rootPath)`. The add-project dialog handles this transparently: it catches `SymlinkRootError` from `src/app/api.ts`, shows a confirm modal (`data-testid="symlink-confirm"`), and re-submits with `body.acceptCanonical: true` on accept. CLI/scripted callers must either pre-resolve the path themselves or include `acceptCanonical: true` in the body. The throw originates in `detectSymlinkRoot()` / `SymlinkProjectRootError` in `src/server/agent/project-registry.ts`. `registerProvisional()` and `registerSystemProject()` auto-accept canonical and never surface this error. See [internals.md — Symlinked project rootPath handling](internals.md#symlinked-project-rootpath-handling).

## `findByCwd` returns undefined for a symlinked cwd

Should not happen post-fix. `ProjectRegistry.findByCwd()` canonicalises both the registered `rootPath` and the incoming `cwd` via `realpathSync` (with a try/catch fallback to the textual path on EPERM/ENOENT — Windows raises EPERM on some junctions) before the prefix comparison. If a project is registered at the canonical path and a session whose `cwd` reaches the server through a symlink fails to resolve, verify the canonicalisation block in `src/server/agent/project-registry.ts::findByCwd` is still in place and the fallback isn't swallowing real errors. Note `getByPath()` is intentionally NOT canonicalised — that's the duplicate-path guard at registration, a different concern from runtime cwd resolution.

## Modal shows only "Failed: 400" with no description

Symptom: triggering an action (e.g. create goal) produces a modal whose body is just "Failed: 400" or "Failed to create goal: 400" — no description, no code, no stack.

Diagnosis: a client call site is dropping the structured server error body. Both halves must be applied together — fixing only one half drops the structured info.

Reference pattern, using the shared helpers in `src/app/error-helpers.ts`:

- Throw side: `if (!res.ok) throw await errorFromResponse(res, "Failed to …");` — parses `{ error, code, stack }` off the JSON body and attaches `code`/`stack` to the `Error`. Falls back to `Failed: <status>` on a non-JSON body.
- Catch side: `showConnectionError(title, e.message, errorDetails(e));` — extracts `{ message, code?, stack? }` from any caught value (Error, custom subclass with `.code`, or non-Error) without throwing.

Server side: confirm the handler whose response surfaced is using `jsonError(status, err, extra?)` (in `src/server/server.ts`) for caught exceptions, not literal `json({ error: String(err) }, ...)` or `json({ error: err.message }, ...)`. Validation responses with literal strings (e.g. `"Missing title"`) intentionally stay as `json({ error: "..." }, ...)` — they have no useful stack.

The `<error-details>` component (`src/ui/components/ErrorDetails.ts`) renders message + optional code + collapsible stack disclosure when both halves are wired. Background polling sites (e.g. `refreshSessions()`) are intentionally silent and do NOT surface a modal.

Pinned by `tests/error-modal-call-sites.test.ts` (enumerates every modal call site that must forward `{ code, stack }`) and `tests/error-helpers.test.ts` (helper contract). Add new modal call sites to the former; do not add a new `showConnectionError(...)` without forwarding `errorDetails(err)`.

## Agent `fetch failed` against gateway when started with `--host 0.0.0.0`

- **Symptoms**: under `./run --host 0.0.0.0 --port <port> --no-tls`, the
  console shows `Listening: http://0.0.0.0:<port>` as expected, but every
  same-host tool extension that calls back into the gateway (the `team_*`
  tools, the `Children` tools, image generation, MCP discovery — anything
  routed through `defaults/tools/_shared/gateway.ts::apiCall`) fails with an
  opaque `fetch failed`. Under `npm run dev:harness` (which binds to
  `localhost`) the same code path works.
- **Why**: `0.0.0.0` and `::` are wildcard *listen* addresses. They tell the
  kernel "accept connections on every interface" but they are not valid
  *connect* peers — macOS / BSD reject `connect()` to `0.0.0.0`. If the
  gateway-url file contains `http://0.0.0.0:<port>`, every agent on the same
  host that reads it and tries to fetch the gateway hits the kernel rejection
  before any HTTP frame is sent.
- **Where the fix lives**: `src/server/cli-loopback.ts` exports the pure
  helper `loopbackForBind(host)`. `0.0.0.0` → `127.0.0.1`, `::` / `[::]` →
  `[::1]`, every other host (including `localhost`, LAN IPs, and hostnames)
  is returned unchanged. `src/server/cli.ts` writes a loopback-normalised
  `peerUrl` to `<stateDir>/gateway-url` while the human-readable
  `Listening:` log line and the browser auto-open URL keep using the
  literal `args.host`. The split is intentional: the operator wants to see
  the bind address they passed; the agent needs a real connect peer.
- **Quick checks**: `cat .bobbit/state/gateway-url` should never contain
  `0.0.0.0` or `::`. If it does, the server is on a pre-fix build, or a new
  CLI codepath is writing the file directly without routing through
  `loopbackForBind`. Tests: `tests/cli-loopback-for-bind.test.ts`.
