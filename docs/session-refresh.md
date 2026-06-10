# Session & Goal Refresh Architecture

## Overview

The client keeps the sidebar in sync with the server via `refreshSessions()` in `src/app/api.ts`. This function fetches both `/api/sessions` and `/api/goals`, updates local state, and calls `renderApp()`. A generation counter mechanism makes this efficient.

## Generation counter pattern

Both `SessionStore` and `GoalStore` maintain a monotonically increasing `generation` counter (resets to 0 on server restart). Every mutation method (`put`, `remove`, `update`, `archive`, `purge`, `setDraft`, `deleteDraft`) increments the counter.

The client tracks `sessionsGeneration` and `goalsGeneration` in `state.ts` (initialized to -1). On each poll, it sends `?since=N` with its last-seen generation. If the server's generation matches, it returns `{ generation: N, changed: false }` — the client skips JSON processing and `renderApp()`.

```
Server mutation → generation++ → stored in memory

Client poll (every 5s):
  GET /api/sessions?since=42 → { changed: false, generation: 42 } → skip
  GET /api/goals?since=17    → { changed: false, generation: 17 } → skip
  → No renderApp(), no gate/PR refresh

Client poll after server mutation:
  GET /api/sessions?since=42 → { generation: 43, sessions: [...] } → update state
  GET /api/goals?since=17    → { changed: false, generation: 17 } → skip
  → renderApp() once
```

## Initial-load spinner gating

On the *first* fetch the sidebar shows a one-time "Loading…" placeholder; afterwards the list is updated in place and never blanks. `refreshSessions()` decides whether a given call is that initial load via the pure helper `isInitialSessionsLoad` (`src/app/session-load-state.ts`).

The signal is **`sessionsGeneration`, not list length**. `sessionsGeneration` is `-1` until the first successful fetch and `>= 0` thereafter, so the helper returns `sessionsGeneration < 0 && !sessionsError`. List emptiness is the wrong proxy for "never fetched": a user whose live-session list is legitimately empty (projects/goals but no live sessions, or no projects at all) would keep `gatewaySessions.length === 0` forever, which previously re-flagged every 5s poll as an initial load and re-blanked the sidebar.

The `!sessionsError` term keeps the spinner suppressed while an error is on screen, so background poll retries stay silent under the error/Retry UI. `retryLoadSessions()` (`src/app/api.ts`) exists for the explicit Retry button: it clears `sessionsError` before calling `refreshSessions()`, restoring the one-time spinner after an initial-load failure. Pinned by `tests/sidebar-loading-flash.test.ts`.

## Client refresh patterns

### Pattern 1 — Optimistic local mutations (no fetch needed)

Some callbacks already update `state.gatewaySessions` in place and call `renderApp()` directly:

- `updateLocalSessionTitle()` — updates title in local state
- `updateLocalSessionStatus()` — updates status in local state
- `onTitleChange` / `onStatusChange` callbacks in `session-manager.ts`

These do **not** trigger `refreshSessions()`. The next background poll will reconcile if needed.

### Pattern 2 — Generation-gated background sync

The 5s poll and navigation-time calls use `refreshSessions()`, which is now generation-gated. When nothing has changed on the server, the poll is essentially free (minimal JSON response, no state processing, no `renderApp()`).

### Pattern 3 — Mutation-reactive refresh

After server-side mutations (session deletion, role assignment, team teardown), `refreshSessions()` is called to pick up the new state. These calls will always see a generation bump and process the full payload.

## Key files

| File | Role |
|---|---|
| `src/server/agent/session-store.ts` | Server-side generation counter for sessions |
| `src/server/agent/goal-store.ts` | Server-side generation counter for goals |
| `src/server/server.ts` | API endpoints with `?since=` support |
| `src/app/state.ts` | Client-side `sessionsGeneration` and `goalsGeneration` |
| `src/app/api.ts` | `refreshSessions()` with generation-gated logic; `retryLoadSessions()` |
| `src/app/session-load-state.ts` | `isInitialSessionsLoad` — pure initial-load/spinner decision |
| `src/app/session-manager.ts` | Session lifecycle (optimistic local updates) |
