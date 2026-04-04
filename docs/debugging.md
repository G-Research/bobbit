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

## Context bar / model state

After a server restart, the context bar may show wrong info (e.g. 200k instead of 1M) or nothing at all. This happens because the agent process's `getState()` RPC may fail or return incomplete data before the process is fully ready.

- **Server-side fallback**: `sendFallbackModelState()` in `handler.ts` reads persisted `modelProvider`/`modelId` from the session store and calls `inferMeta()` to attach the correct `contextWindow`. This runs when `getState()` fails, is skipped (dormant/preparing sessions), or returns data without model metadata.
- **Client-side retry**: `remote-agent.ts` retries `get_state` after 3s on reconnect if `contextWindow` is still 0.
- **Default contextWindow is 0**: Before the server provides real data, `contextWindow` starts at 0 (not 200k), so the context bar shows nothing rather than a misleading value.
- If context bar still shows wrong info after restart, check that `modelProvider` and `modelId` are persisted in `<project-root>/.bobbit/state/sessions.json` for the affected session.
- `SessionManager.getPersistedSession(id)` exposes persisted session data used by the fallback mechanism.

## Session persistence

- Check `<project-root>/.bobbit/state/sessions.json` (per-project, not centralized)
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
- **Verification output modal empty?** The modal has two data sources for step output:
  1. **API bootstrap** — on open, the modal (and its parent) reads accumulated output from `GET /api/goals/:id/verifications/active`. The chat widget (`GateVerificationLive`) seeds its `_stepOutputs` Map from the API in `_fetchAndReconcile()`, and falls back to `this.steps[index]?.output` in `_openModal()`. The dashboard reads `step.liveOutput || step.output`. The modal itself calls `_fetchBootstrapOutput()` as a one-time fetch when `initialOutput` is empty.
  2. **Live WS streaming** — the `/ws/viewer` WebSocket delivers `gate_verification_step_output` events in real-time. Events are dispatched as `gate-verification-event` CustomEvents on `document`; the `VerificationOutputModal` subscribes to these and appends chunks.
  
  If the modal shows "Waiting for output…": first check the API endpoint returns step output (`curl /api/goals/:id/verifications/active` — look for non-empty `output` in the steps array). If the API has output but the modal is empty, the parent component may not be passing it through — verify the fallback chain. If neither source has output, the verification command may not have produced any stdout/stderr yet. For live streaming issues, check that the `/ws/viewer` WS connection is active (browser DevTools → Network → WS tab). The connection opens on dashboard mount and closes on navigation away; it auto-reconnects after 3s on unexpected close.
- **Sandboxed verification commands**: For sandboxed goals, `command` verification steps run inside the team lead's container via `docker exec`. If command steps show unexpected results (e.g. missing files, stale code), check: (1) is the goal sandboxed (`goal.sandboxed`)? (2) is the team lead's container still running (`docker ps`)? If the container is gone, the harness falls back to host execution — which won't have the team's commits. Look for "no team lead container found" warnings in the verification output.
- **Session "view" links**: Verification step and delegate session links navigate in-place via `location.hash` (no new tab). If clicking "view" does nothing, check for JavaScript errors in the console — the click handler sets `location.hash = '#/session/<id>'`.

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
- Container can't reach internet? Check: (1) `docker network inspect bobbit-sandbox-net` shows the network exists, (2) container is attached to it (`docker inspect <container>` → Networks), (3) host firewall isn't blocking Docker bridge traffic
- Container can't reach gateway? Check: (1) `--add-host=host.docker.internal:host-gateway` is in the Docker args, (2) `BOBBIT_GATEWAY_URL` matches real address
- Auth failing? Check `BOBBIT_TOKEN` is scoped token from `SandboxTokenStore`
- Sessions not surviving restart? Check `agentSessionFile` is host-native path (not `/home/node/...`)
- Delegates failing? Parent needs `sandboxed: true` + sandbox still configured in `project.yaml`

## Container pool

- `GET /api/sandbox-pool` for stats (`enabled`, `total`, `idle`, `claimed`, `warming`)
- `docker ps --filter label=bobbit-pool` to see containers directly
- Not re-adopted after restart? Verify project hash in label matches
- Falling back to cold `docker run`? Check pool has idle containers (exhaustion logged as warning)

## Search index

- Each project has its own `<project-root>/.bobbit/state/search.db` — delete and restart to rebuild
- `ProjectContextManager.searchAll()` aggregates results across all project indexes
- Schema version is 3 (added `project_id` column for multi-project filtering). Version mismatch triggers automatic rebuild on next server start
- Check `better-sqlite3` loaded correctly (native addon)
- FTS5 on 10K docs < 10ms — slow search means network/serialization bottleneck
- Purged sessions still showing? Check `purgeOneSession()` calls index cleanup
- Staff not appearing in search? `StaffManager` uses per-project `searchIndex` from `ProjectContextManager` — verify the correct project context's search index is being used. `rebuildFromStores()` passes `staff.projectId` for correct project filtering
- Sidebar filter not working? Check `state.searchContentMode` — `false` = client-side title filter, `true` = FTS API call. Toggle state persisted in `localStorage`
- Full search page (`#/search`) manages its own state — independent from sidebar search

## Paginated archives

- Cursor based on `archivedAt` timestamp
- Missing items? Check `archivedAt` is set (older items may lack it)
- Count mismatch? Verify total from paginated response metadata

## Multi-project / per-project state

- State is per-project: goals, sessions, tasks, teams, gates, search, costs all live in `<project-root>/.bobbit/state/`
- `ProjectContextManager` manages all `ProjectContext` instances and routes store access
- Project registry at `<server-cwd>/.bobbit/state/projects.json` — check file exists and is valid JSON
- Server CWD auto-registered as default project via `ensureDefaultProject()` on startup
- `GET /api/projects` to list all registered projects
- Sessions/goals not appearing? Check `projectId` field matches the expected project. Verify the correct project's `sessions.json` / `goals.json` contains the record
- Sidebar not grouping? Project folder rows are always shown — check that `state.projects` is populated and `renderProjectHeader()` is being called
- Project registration failing? `rootPath` must be absolute and exist on disk; duplicate paths are rejected
- Search not filtering by project? Verify `?projectId=` query param is passed; each project has its own `search.db`
- Config not cascading? Check all three `.bobbit/config/` directories (global, server, project) and verify `resolveScalarConfig()` / `resolveEntities()` return expected scope
- **State migration**: On first startup after upgrade, central state is distributed to per-project dirs. Check for `.bobbit/state/.migrated-to-per-project` marker. Central files renamed with `.pre-migration` suffix (not deleted). If migration didn't run, check that projects are registered before migration runs
- **Store routing bugs**: All store access must go through `ProjectContextManager` — direct `this.store` calls bypass per-project routing. `SessionManager` uses `resolveStoreForSession()` / `resolveStoreForId()` to find the correct per-project `SessionStore`
- **Known limitations**: Cost tracking uses the default project's `CostTracker`. `active-verifications.json` stays in central state dir

## Gate re-signal cancellation

- `cancelStaleVerifications()` in `verification-harness.ts` terminates old reviewer sessions
- Cancelled flag checked after `Promise.all` to suppress stale results
- Check `sessionManager` and `teamManager` passed to `VerificationHarness`
- Inspect: `GET /api/goals/:goalId/verifications/active`

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
