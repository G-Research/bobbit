# Bobbit — Debugging Guide

Scannable checklists for common issues. Each entry: symptom → where to look → key detail.

## Streaming performance (UI sluggishness)

- **Architecture**: `StreamingMessageContainer` owns rendering during streaming via `setMessage()` with `requestAnimationFrame` batching. `AgentInterface` must NOT call `this.requestUpdate()` in the `message_update` event handler — only the streaming container updates on each token.
- **If the UI feels sluggish during streaming**: check `AgentInterface.setupSessionSubscription()` — the `message_update` case should only update the streaming container, not trigger a full `AgentInterface` re-render.
- **toolResultsById memoization**: `AgentInterface._getToolResultsById()` caches the tool-results Map to avoid creating a new reference on every render, which would cause `MessageList` to re-render unnecessarily.
- **content-visibility CSS**: `message-list > .flex > *` uses `content-visibility: auto` to skip layout/paint for off-screen messages in long conversations.
- State-transition events (`message_start`, `message_end`, `agent_start`, `agent_end`, `turn_start`, `turn_end`) still call `requestUpdate()` — only `message_update` (the hot path) is excluded.

## Duplicate messages

- Check `flushDeferredMessage()` and `_deferredAssistantMessage` in `remote-agent.ts`
- `MessageList` renders `state.messages` (completed); `StreamingMessageContainer` renders `state.streamMessage` (in-progress) — they must never overlap
- Tool-call messages stay in streaming until the next message starts

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

## Session persistence

- Check `.bobbit/state/sessions.json`
- Initial persist happens via `persistOnce()` in `session-setup.ts` — a single `store.put()` with all structural fields at creation time
- `persistSessionMetadata()` only calls `store.update()` (never `store.put()`) — updates `agentSessionFile` once the agent reports it
- `persistSessionMetadata()` retries 3 times with backoff (500ms, 1s, 2s) on failure
- `sandboxed` is a typed field on `SessionInfo` (no `(session as any)._sandboxed` hack)
- `restoreSessions()` in `session-manager.ts` skips sessions with missing `.jsonl` files
- Failed restores create dormant entries that revive on client connect

## Compaction

- Check `_isCompacting`, `_compactionSyntheticMessages`, `_usageStaleAfterCompaction` in `remote-agent.ts`
- `compacting_placeholder` must be filtered and re-added correctly across server refreshes

## Goal proposal dismissed but reappears

- localStorage key: `bobbit-goal-proposal-dismissed-<sessionId>` stores djb2 hash of `title + "\n" + spec`
- Check: (1) key exists for session, (2) hash matches, (3) session is not goal-assistant type (those use IndexedDB)
- Cleanup: `clearDismissedProposal()` in `terminateSession()`

## Render performance

- `renderApp()` debounced via `requestAnimationFrame` — multiple calls collapse
- For synchronous DOM updates, use `renderAppSync()`

## Gates

- State in `GateStore` (`.bobbit/state/gates.json`)
- Check dependencies via `GET /api/goals/:id/gates`

## Git diff viewer not showing diffs

1. Widget needs `sessionId` or `goalId` + `token`
2. Path sanitization rejects `..` and absolute paths
3. Git command has 5s timeout, 500KB response cap
4. Dropdown renders into portal (`document.body`) — not clipped by overflow
5. `_currentDiffFile` guard prevents stale responses

## Sandbox sessions

- `GET /api/sandbox-status` for Docker availability
- Worktree sessions now correctly call `applySandboxWiring()` via the pipeline (previously `_setupWorktreeAndLaunchAgent()` skipped sandbox wiring)
- `sessions.json` has `sandboxed: boolean`
- Proxy logs: `[sandbox-proxy]` prefix — look for `BLOCKED` / `CONNECT`
- Container can't reach gateway? Check: (1) proxy allowlist has gateway hostname, (2) `BOBBIT_GATEWAY_URL` matches real address, (3) CONNECT forwarding in proxy logs
- Auth failing? Check `BOBBIT_TOKEN` is scoped token from `SandboxTokenStore`
- Sessions not surviving restart? Check `agentSessionFile` is host-native path (not `/home/node/...`)
- Delegates failing? Parent needs `sandboxed: true` + sandbox still configured in `project.yaml`

## Container pool

- `GET /api/sandbox-pool` for stats (`enabled`, `total`, `idle`, `claimed`, `warming`)
- `docker ps --filter label=bobbit-pool` to see containers directly
- Not re-adopted after restart? Verify project hash in label matches
- Falling back to cold `docker run`? Check pool has idle containers (exhaustion logged as warning)

## Search index

- `.bobbit/state/search.db` is a rebuildable cache — delete and restart to rebuild
- Schema version is 2 (includes `staff_fts` table). Version mismatch triggers automatic rebuild on next server start
- Check `better-sqlite3` loaded correctly (native addon)
- FTS5 on 10K docs < 10ms — slow search means network/serialization bottleneck
- Purged sessions still showing? Check `purgeOneSession()` calls index cleanup
- Staff not appearing in search? Verify `StaffManager` has `searchIndex` dependency and calls `indexStaff()` on create/update
- Sidebar filter not working? Check `state.searchContentMode` — `false` = client-side title filter, `true` = FTS API call. Toggle state persisted in `localStorage`
- Full search page (`#/search`) manages its own state — independent from sidebar search

## Paginated archives

- Cursor based on `archivedAt` timestamp
- Missing items? Check `archivedAt` is set (older items may lack it)
- Count mismatch? Verify total from paginated response metadata

## Gate re-signal cancellation

- `cancelStaleVerifications()` in `verification-harness.ts` terminates old reviewer sessions
- Cancelled flag checked after `Promise.all` to suppress stale results
- Check `sessionManager` and `teamManager` passed to `VerificationHarness`
- Inspect: `GET /api/goals/:goalId/verifications/active`
